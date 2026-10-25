/* S04c 来源防回流的 SQLite 保护映射。
   只保存归一化 sourceId、文件 key 与有界读取区段元数据，不保存正文。
   映射供 source-analysis 在删除/纠正后核验历史区段；不进入记忆或模型检索。 */
const crypto = require("node:crypto");
const { AppError } = require("./errors.cjs");

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS source_analysis_checkpoints (
    character_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    source_id_hash TEXT NOT NULL,
    file_key TEXT NOT NULL,
    body_start INTEGER NOT NULL,
    byte_length INTEGER NOT NULL,
    region_sha256 TEXT NOT NULL,
    dev TEXT NOT NULL,
    ino TEXT NOT NULL,
    snapshot_bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (character_id, source_id)
  );

  CREATE INDEX IF NOT EXISTS source_analysis_checkpoint_file
    ON source_analysis_checkpoints (character_id, file_key, source_id_hash);
`;

const HASH_BATCH = 200;

function hashSource(sourceId) {
  return crypto.createHash("sha256").update(sourceId, "utf8").digest("hex");
}

function validCheckpoint(checkpoint) {
  return (
    checkpoint &&
    typeof checkpoint.fileKey === "string" &&
    checkpoint.fileKey.length > 0 &&
    Number.isSafeInteger(checkpoint.bodyStart) &&
    checkpoint.bodyStart >= 0 &&
    Number.isSafeInteger(checkpoint.byteLength) &&
    checkpoint.byteLength >= 0 &&
    Number.isSafeInteger(checkpoint.bodyStart + checkpoint.byteLength) &&
    Number.isSafeInteger(checkpoint.snapshotBytes) &&
    checkpoint.snapshotBytes >= checkpoint.bodyStart + checkpoint.byteLength &&
    typeof checkpoint.regionSha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(checkpoint.regionSha256) &&
    typeof checkpoint.dev === "string" &&
    checkpoint.dev.length > 0 &&
    typeof checkpoint.ino === "string" &&
    checkpoint.ino.length > 0
  );
}

function createSourceProvenance(db) {
  if (!db || typeof db.prepare !== "function") {
    throw new AppError("DATABASE_REQUIRED", "来源保护映射需要 SQLite 连接。");
  }
  db.exec(SCHEMA);

  const statements = {
    insert: db.prepare(`
      INSERT OR IGNORE INTO source_analysis_checkpoints
        (character_id, source_id, source_id_hash, file_key, body_start, byte_length,
         region_sha256, dev, ino, snapshot_bytes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
  };

  function mapRow(row) {
    return {
      sourceId: row.source_id,
      fileKey: row.file_key,
      bodyStart: Number(row.body_start),
      byteLength: Number(row.byte_length),
      regionSha256: row.region_sha256,
      dev: row.dev,
      ino: row.ino,
      snapshotBytes: Number(row.snapshot_bytes),
    };
  }

  function* rowsForHashes(characterId, fileKey, hashes) {
    const placeholders = hashes.map(() => "?").join(", ");
    const statement = db.prepare(`
      SELECT source_id, file_key, body_start, byte_length, region_sha256, dev, ino, snapshot_bytes
      FROM source_analysis_checkpoints
      WHERE character_id = ? AND file_key = ? AND source_id_hash IN (${placeholders})
    `);
    for (const row of statement.iterate(characterId, fileKey, ...hashes)) {
      yield mapRow(row);
    }
  }

  /* 按 source_id_hash 索引直接查询被排除来源，惰性逐批产出；调用方在
     第 9 个不同区段停止时不会继续读取或装载其余文件历史。 */
  function* listProtected(characterId, fileKey, excludedHashes) {
    if (!excludedHashes || excludedHashes.size === 0) {
      return;
    }
    let batch = [];
    for (const hash of excludedHashes) {
      batch.push(hash);
      if (batch.length === HASH_BATCH) {
        yield* rowsForHashes(characterId, fileKey, batch);
        batch = [];
      }
    }
    if (batch.length > 0) {
      yield* rowsForHashes(characterId, fileKey, batch);
    }
  }

  /* 必须由调用方放在与记忆/已处理标识相同的发布事务内。 */
  function save(characterId, sourceIds, checkpoint, createdAt) {
    if (!validCheckpoint(checkpoint)) {
      throw new AppError("CHECKPOINT_INVALID", "来源读取区段无效。");
    }
    for (const sourceId of sourceIds) {
      statements.insert.run(
        characterId,
        sourceId,
        hashSource(sourceId),
        checkpoint.fileKey,
        checkpoint.bodyStart,
        checkpoint.byteLength,
        checkpoint.regionSha256,
        checkpoint.dev,
        checkpoint.ino,
        checkpoint.snapshotBytes,
        createdAt,
      );
    }
  }

  return { listProtected, save };
}

module.exports = { createSourceProvenance };
