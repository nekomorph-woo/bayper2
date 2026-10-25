/* S04a 外部会话来源的发现与授权基础。
   只负责候选目录可用性、授权持久化、全局开关和读取许可校验；
   不解析会话、不读取正文、不扫描目录、不联网、不发起模型请求。
   工厂显式接收现有 SQLite 连接，正式 main/store 接线由后续步骤完成。
   目录发现结果仅为候选提示，目录存在不等于获得分析授权。 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { AppError } = require("./errors.cjs");

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS external_source_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  /* 授权绑定规范化后的真实目录；展示路径只用于界面与重新定位。
     root_identity 记录 dev:inode，避免目录删除后在原路径重建时被当成原授权。
     revision 在重新授权时递增，使旧许可无法复活。 */
  CREATE TABLE IF NOT EXISTS external_source_grants (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    display_path TEXT NOT NULL,
    canonical_path TEXT NOT NULL,
    root_identity TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (provider, canonical_path)
  );
`;

const LIMITS = Object.freeze({ provider: 100, path: 4096, id: 200 });

function cleanText(value, field, max) {
  if (typeof value !== "string") {
    throw new AppError("INVALID_INPUT", `${field} 必须是字符串。`);
  }
  const text = value.trim();
  if (text.length === 0) {
    throw new AppError("INVALID_INPUT", `${field} 不能为空。`);
  }
  if (text.length > max) {
    throw new AppError("INVALID_INPUT", `${field} 超过长度上限。`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(text)) {
    throw new AppError("INVALID_INPUT", `${field} 不能包含控制字符。`);
  }
  return text;
}

function isWithin(base, target) {
  return target === base || target.startsWith(base + path.sep);
}

function createExternalSources({ db, candidates = [], now = () => Date.now() } = {}) {
  if (!db || typeof db.prepare !== "function") {
    throw new AppError("DATABASE_REQUIRED", "外部来源服务需要显式传入 SQLite 连接。");
  }
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);

  const clock = typeof now === "function" ? now : () => now;
  function currentTime() {
    const value = clock();
    return value instanceof Date ? value.getTime() : Math.trunc(Number(value));
  }

  const statements = {
    getState: db.prepare("SELECT value FROM external_source_state WHERE key = ?"),
    setState: db.prepare(`
      INSERT INTO external_source_state (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `),
    findGrant: db.prepare(
      "SELECT * FROM external_source_grants WHERE provider = ? AND canonical_path = ?",
    ),
    getGrant: db.prepare("SELECT * FROM external_source_grants WHERE id = ?"),
    insertGrant: db.prepare(`
      INSERT INTO external_source_grants
        (id, provider, display_path, canonical_path, root_identity, revision, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateGrant: db.prepare(`
      UPDATE external_source_grants
      SET display_path = ?, revision = ?, status = ?, root_identity = ?, updated_at = ?
      WHERE id = ?
    `),
    revokeByDisplay: db.prepare(`
      UPDATE external_source_grants
      SET status = 'revoked', updated_at = ?
      WHERE provider = ? AND display_path = ? AND status = 'active'
    `),
    listGrants: db.prepare("SELECT * FROM external_source_grants ORDER BY created_at, id"),
  };

  function readState(key, fallback) {
    const row = statements.getState.get(key);
    return row ? row.value : fallback;
  }

  function isEnabled() {
    return readState("analysis_enabled", "0") === "1";
  }

  function permissionRevision() {
    return Number(readState("permission_revision", "0"));
  }

  function bumpPermissionRevision() {
    statements.setState.run("permission_revision", String(permissionRevision() + 1));
  }

  /* 状态变更与修订号在同一事务中落库，提交后才向调用方返回成功。 */
  function transact(work) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // 回滚失败不掩盖原始业务错误。
      }
      throw error;
    }
  }

  function setEnabled(enabled) {
    if (typeof enabled !== "boolean") {
      throw new AppError("INVALID_INPUT", "分析开关必须是布尔值。");
    }
    if (isEnabled() === enabled) {
      return { enabled };
    }
    const result = transact(() => {
      statements.setState.run("analysis_enabled", enabled ? "1" : "0");
      bumpPermissionRevision();
      return { enabled };
    });
    // 仅在事务提交成功后清理；失败事务中的许可保持有效。
    clearStalePermits();
    return result;
  }

  function displayPathOf(value) {
    return path.resolve(cleanText(value, "目录", LIMITS.path));
  }

  /* 解析真实目录。目录消失、不可访问或不是目录都给出明确业务错误，
     不把异常静默当成空日志。身份用于识别原路径上的目录是否已被替换。 */
  function realDirectory(displayPath) {
    try {
      const realPath = fs.realpathSync(displayPath);
      const stat = fs.statSync(realPath, { bigint: true });
      if (!stat.isDirectory()) {
        throw new AppError("NOT_A_DIRECTORY", "授权目标不是目录。");
      }
      return { realPath, identity: `${stat.dev}:${stat.ino}` };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      const denied = error.code === "EACCES" || error.code === "EPERM";
      throw new AppError(
        denied ? "PATH_INACCESSIBLE" : "PATH_UNAVAILABLE",
        denied ? "目录当前不可访问。" : "目录不存在或无法解析。",
      );
    }
  }

  function mapGrant(row) {
    return {
      id: row.id,
      provider: row.provider,
      displayPath: row.display_path,
      canonicalPath: row.canonical_path,
      revision: row.revision,
      active: row.status === "active",
    };
  }

  /* 只检查显式候选路径本身是否为可用目录，不列目录内容、不读取会话文件。
     候选配置来自后续主进程，本轮不内置真实 HOME 或 Agent 路径。 */
  function discoverCandidates() {
    return candidates.map((candidate) => {
      const provider = cleanText(candidate?.provider, "来源", LIMITS.provider);
      const displayPath = displayPathOf(candidate?.path);
      try {
        realDirectory(displayPath);
        return { provider, displayPath, available: true };
      } catch (error) {
        const reason = {
          PATH_INACCESSIBLE: "INACCESSIBLE",
          NOT_A_DIRECTORY: "NOT_DIRECTORY",
        }[error.code] ?? "NOT_FOUND";
        return { provider, displayPath, available: false, reason };
      }
    });
  }

  function grantDirectory(providerValue, pathValue) {
    const provider = cleanText(providerValue, "来源", LIMITS.provider);
    const displayPath = displayPathOf(pathValue);
    const root = realDirectory(displayPath);
    const existing = statements.findGrant.get(provider, root.realPath);

    // 同一来源、同一真实目录、同一展示路径且目录身份未变的重复授权保持幂等。
    if (
      existing &&
      existing.status === "active" &&
      existing.display_path === displayPath &&
      existing.root_identity === root.identity
    ) {
      return mapGrant(existing);
    }

    const result = transact(() => {
      const updatedAt = currentTime();
      let row;
      if (existing) {
        // 重授权增加修订号；旧许可即使来源与目录相同也不再有效。
        statements.updateGrant.run(
          displayPath, existing.revision + 1, "active", root.identity, updatedAt, existing.id,
        );
        row = statements.getGrant.get(existing.id);
      } else {
        // 同一展示路径改指向其他真实目录时，旧授权立即失效，不能按字符串续用。
        statements.revokeByDisplay.run(updatedAt, provider, displayPath);
        const id = crypto.randomUUID();
        statements.insertGrant.run(
          id, provider, displayPath, root.realPath, root.identity, 1, "active", updatedAt, updatedAt,
        );
        row = statements.getGrant.get(id);
      }
      bumpPermissionRevision();
      return mapGrant(row);
    });
    clearStalePermits();
    return result;
  }

  function revokeDirectory(directoryId) {
    const id = cleanText(directoryId, "授权ID", LIMITS.id);
    const row = statements.getGrant.get(id);
    if (!row) {
      throw new AppError("GRANT_NOT_FOUND", "授权不存在。");
    }
    if (row.status !== "active") {
      return mapGrant(row);
    }
    const result = transact(() => {
      statements.updateGrant.run(
        row.display_path, row.revision, "revoked", row.root_identity, currentTime(), id,
      );
      bumpPermissionRevision();
      return mapGrant(statements.getGrant.get(id));
    });
    clearStalePermits();
    return result;
  }

  function listGrants() {
    return statements.listGrants.all().map(mapGrant);
  }

  /* 授权目录当前仍须指向授权时的真实目录。目录消失属于明确失败，
     不能当作空日志继续分析。 */
  function verifyGrantRoot(row) {
    let current;
    try {
      current = realDirectory(row.display_path);
    } catch (error) {
      if (error.code === "NOT_A_DIRECTORY") {
        throw new AppError("GRANT_PATH_CHANGED", "授权目录已被替换，需要重新授权。");
      }
      throw error;
    }
    if (current.realPath !== row.canonical_path || current.identity !== row.root_identity) {
      throw new AppError("GRANT_PATH_CHANGED", "授权目录已指向其他位置，需要重新授权。");
    }
    return current.realPath;
  }

  function activeGrant(directoryId) {
    const id = cleanText(directoryId, "授权ID", LIMITS.id);
    const row = statements.getGrant.get(id);
    if (!row) {
      throw new AppError("GRANT_NOT_FOUND", "授权不存在。");
    }
    if (row.status !== "active") {
      throw new AppError("GRANT_NOT_ACTIVE", "授权已撤销，不能签发读取许可。");
    }
    return row;
  }

  /* 许可令牌只交给主进程使用；对应快照留在内存中，renderer 无法伪造。
     快照包含签发时的授权修订与全局权限修订。读取/分析结束后由调用方
     通过 releaseReadPermit 释放，建议放在 finally 中。 */
  const permits = new Map();

  /* 全局权限修订递增会让所有旧许可失效；事务提交成功后清理这些条目，
     避免长期运行累积已不可能使用的令牌。 */
  function clearStalePermits() {
    const current = permissionRevision();
    for (const [token, snapshot] of permits) {
      if (snapshot.permissionRevision !== current) {
        permits.delete(token);
      }
    }
  }

  function releaseReadPermit(token) {
    return typeof token === "string" && permits.delete(token);
  }

  function issueReadPermit(directoryId) {
    if (!isEnabled()) {
      throw new AppError("ANALYSIS_DISABLED", "外部来源分析当前已关闭。");
    }
    const row = activeGrant(directoryId);
    verifyGrantRoot(row);
    const token = crypto.randomUUID();
    permits.set(token, {
      grantId: row.id,
      grantRevision: row.revision,
      permissionRevision: permissionRevision(),
      canonicalPath: row.canonical_path,
    });
    return token;
  }

  /* 开始读取/分析前以及发布结果前都要调用。关→开、撤→重授权都会改变
     修订号并清理旧条目，因此旧令牌不会因重新开启而复活。 */
  function validateReadPermit(token) {
    if (!isEnabled()) {
      throw new AppError("ANALYSIS_DISABLED", "外部来源分析当前已关闭。");
    }
    const snapshot = typeof token === "string" ? permits.get(token) : null;
    if (!snapshot) {
      throw new AppError("PERMIT_INVALID", "读取许可无效或已释放。");
    }
    const row = statements.getGrant.get(snapshot.grantId);
    if (!row || row.status !== "active") {
      throw new AppError("PERMIT_REVOKED", "读取许可对应的授权已撤销。");
    }
    if (
      row.revision !== snapshot.grantRevision ||
      permissionRevision() !== snapshot.permissionRevision ||
      row.canonical_path !== snapshot.canonicalPath
    ) {
      throw new AppError("PERMIT_STALE", "读取许可已过期，需要重新获取。");
    }
    verifyGrantRoot(row);
    return {
      directoryId: row.id,
      provider: row.provider,
      canonicalPath: row.canonical_path,
      revision: row.revision,
    };
  }

  /* 只解析并验证相对文件路径，不读取内容。绝对路径、.. 逃逸、软链指向
     授权根外均拒绝；目录消失或权限异常给出明确业务错误。
     本函数不消除后续 open 时的 TOCTOU 窗口，读取层仍需自行核验。 */
  function resolveAuthorizedFile(token, relativePathValue) {
    const permit = validateReadPermit(token);
    const relativePath = cleanText(relativePathValue, "相对路径", LIMITS.path);
    if (path.isAbsolute(relativePath)) {
      throw new AppError("PATH_ESCAPE", "只接受授权目录内的相对路径。");
    }
    const base = permit.canonicalPath;
    const candidate = path.resolve(base, relativePath);
    if (!isWithin(base, candidate)) {
      throw new AppError("PATH_ESCAPE", "路径超出授权目录。");
    }

    let real;
    try {
      real = fs.realpathSync(candidate);
    } catch (error) {
      const denied = error.code === "EACCES" || error.code === "EPERM";
      throw new AppError(
        denied ? "FILE_INACCESSIBLE" : "FILE_NOT_FOUND",
        denied ? "目标文件当前不可访问。" : "目标文件不存在或无法解析。",
      );
    }
    if (!isWithin(base, real)) {
      throw new AppError("SYMLINK_ESCAPE", "软链指向授权目录之外。");
    }
    let stat;
    try {
      stat = fs.statSync(real);
    } catch {
      throw new AppError("FILE_INACCESSIBLE", "目标文件当前不可访问。");
    }
    if (!stat.isFile()) {
      throw new AppError("NOT_A_FILE", "目标路径不是普通文件。");
    }
    return real;
  }

  return {
    isEnabled,
    setEnabled,
    discoverCandidates,
    grantDirectory,
    revokeDirectory,
    listGrants,
    issueReadPermit,
    releaseReadPermit,
    validateReadPermit,
    resolveAuthorizedFile,
  };
}

module.exports = { createExternalSources };
