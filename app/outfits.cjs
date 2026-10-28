/* S06l 衣装穿用领域。
   只保存“已穿/待穿”意图并校验归属、角色与发布资格；不碰桌面素材、聊天、
   名单或数值。待穿由主进程在自然节点安全提交，领域不自行等待或重试。
   已穿与待穿按稳定角色写入 app_state，不新增 schema；基础衣装固定为 base。 */
const crypto = require("node:crypto");
const { AppError } = require("./errors.cjs");

const BASE_OUTFIT_ID = "base";
const WORN_PREFIX = "outfit_worn:";
const PENDING_PREFIX = "outfit_pending:";
const BASE_TARGET = Object.freeze({ outfitId: BASE_OUTFIT_ID, storyId: null });
const BASE_ENTRY = Object.freeze({
  outfitId: BASE_OUTFIT_ID,
  storyId: null,
  owned: true,
  storyAvailable: true,
  assetAvailable: true,
  available: true,
  reason: null,
});

function text(value, field) {
  if (typeof value !== "string") {
    throw new AppError("INVALID_INPUT", `${field} 必须是字符串。`);
  }
  const result = value.trim();
  if (!result || result.length > 200 || /[\u0000-\u001f\u007f]/u.test(result)) {
    throw new AppError("INVALID_INPUT", `${field} 无效。`);
  }
  return result;
}

function integer(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new AppError("INVALID_INPUT", `${field} 必须是非负整数。`);
  }
  return value;
}

function outfitError(code) {
  const message = {
    OUTFIT_NOT_FOUND: "衣装不存在。",
    OUTFIT_NOT_OWNED: "这套衣装尚未属于该角色。",
    OUTFIT_OWNER_MISMATCH: "这套衣装不属于该角色。",
    OUTFIT_UNAVAILABLE: "这套衣装当前不可用。",
    OUTFIT_ASSET_UNAVAILABLE: "这套衣装的素材当前不可用。",
  }[code] ?? "这套衣装当前不可用。";
  return new AppError(code, message);
}

function createOutfits({
  db,
  storyProgress,
  discoveryOutcomes,
  isAssetAvailable,
  now = () => new Date(),
} = {}) {
  if (typeof db?.prepare !== "function") {
    throw new AppError("DATABASE_REQUIRED", "衣装服务需要 SQLite 连接。");
  }
  if (typeof storyProgress?.listProgress !== "function") {
    throw new AppError("STORY_PROGRESS_REQUIRED", "衣装服务需要故事进度入口。");
  }
  if (typeof discoveryOutcomes?.getOutfitOwnership !== "function") {
    throw new AppError("DISCOVERY_REQUIRED", "衣装服务需要所有权入口。");
  }
  if (typeof isAssetAvailable !== "function") {
    throw new AppError("ASSET_CHECK_REQUIRED", "衣装服务需要素材可用性入口。");
  }
  if (typeof now !== "function") {
    throw new AppError("CLOCK_REQUIRED", "衣装服务需要时钟。");
  }
  db.exec("PRAGMA foreign_keys = ON");
  const statements = {
    getState: db.prepare("SELECT value FROM app_state WHERE key = ?"),
    setState: db.prepare(`
      INSERT INTO app_state (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `),
    clearState: db.prepare("DELETE FROM app_state WHERE key = ?"),
    relationship: db.prepare(
      "SELECT 1 AS present FROM relationships WHERE character_id = ?",
    ),
  };

  function nowMs() {
    const value = now();
    const at = value instanceof Date ? value.getTime() : Number(value);
    if (!Number.isFinite(at)) {
      throw new AppError("CLOCK_INVALID", "衣装时钟无效。");
    }
    return at;
  }

  function ensureCharacter(characterId) {
    if (!statements.relationship.get(characterId)) {
      throw new AppError("INVALID_CHARACTER", "这个角色不在已结识名单中。");
    }
  }

  function readRecord(characterId, prefix) {
    const raw = statements.getState.get(`${prefix}${characterId}`)?.value ?? null;
    if (raw === null) {
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new AppError("OUTFIT_STATE_INVALID", "衣装持久状态无法解析。");
    }
    if (!parsed || typeof parsed.outfitId !== "string" || !parsed.outfitId) {
      throw new AppError("OUTFIT_STATE_INVALID", "衣装持久状态不完整。");
    }
    return parsed;
  }

  function readWorn(characterId) {
    const stored = readRecord(characterId, WORN_PREFIX);
    return {
      outfitId: stored?.outfitId ?? BASE_OUTFIT_ID, storyId: stored?.storyId ?? null,
      version: Number.isInteger(stored?.version) ? stored.version : 0,
      committedAt: Number.isFinite(stored?.committedAt) ? stored.committedAt : null,
    };
  }

  function readPending(characterId) {
    const stored = readRecord(characterId, PENDING_PREFIX);
    if (!stored) {
      return null;
    }
    return {
      outfitId: stored.outfitId, storyId: stored.storyId ?? null,
      token: typeof stored.token === "string" ? stored.token : "",
      version: Number.isInteger(stored.version) ? stored.version : -1,
      requestedAt: Number.isFinite(stored.requestedAt) ? stored.requestedAt : null,
    };
  }

  // 只有明确 true 才视为素材可用；undefined、异常与缺省都不放行。
  function assetAvailable(characterId, outfitId) {
    try {
      return isAssetAvailable(characterId, outfitId) === true;
    } catch {
      return false;
    }
  }

  /* 成熟进度与归属必须同时成立；列表与请求共用同一资格构造，避免两套判断。
     entry 只在该角色确实拥有衣装时产生，code 表示不能请求的原因。 */
  function qualify(progress, characterId) {
    if (progress.progressStatus !== "mature") {
      return { code: "OUTFIT_NOT_OWNED", entry: null };
    }
    const ownership = discoveryOutcomes.getOutfitOwnership({
      storyId: progress.storyId,
    });
    if (!ownership || ownership.outfitId !== progress.targetId) {
      return { code: "OUTFIT_NOT_OWNED", entry: null };
    }
    if (
      progress.ownerCharacterId !== characterId
      || ownership.ownerCharacterId !== characterId
    ) {
      return { code: "OUTFIT_OWNER_MISMATCH", entry: null };
    }
    const storyAvailable = progress.available === true;
    const assetOk = assetAvailable(characterId, progress.targetId);
    return {
      code: storyAvailable ? (assetOk ? null : "OUTFIT_ASSET_UNAVAILABLE")
        : "OUTFIT_UNAVAILABLE",
      entry: {
        outfitId: progress.targetId, storyId: progress.storyId, owned: true,
        storyAvailable, assetAvailable: assetOk,
        available: storyAvailable && assetOk,
        reason: !storyAvailable ? "STORY_UNAVAILABLE"
          : !assetOk ? "ASSET_UNAVAILABLE" : null,
        unlockedAt: ownership.unlockedAt,
      },
    };
  }

  function ownedEntries(characterId) {
    return storyProgress
      .listProgress()
      .filter((progress) =>
        progress.type === "outfit"
        && progress.progressStatus === "mature"
        && progress.ownerCharacterId === characterId)
      .map((progress) => qualify(progress, characterId).entry)
      .filter(Boolean)
      .sort((left, right) => left.outfitId.localeCompare(right.outfitId));
  }

  function resolveTarget(characterId, outfitId) {
    const progresses = storyProgress
      .listProgress()
      .filter((progress) =>
        progress.type === "outfit" && progress.targetId === outfitId);
    if (progresses.length === 0) {
      throw outfitError("OUTFIT_NOT_FOUND");
    }
    let ownerMismatch = false;
    let notOwned = false;
    for (const progress of progresses) {
      const result = qualify(progress, characterId);
      if (result.code === null) {
        return { outfitId, storyId: result.entry.storyId };
      }
      if (result.code === "OUTFIT_OWNER_MISMATCH") ownerMismatch = true;
      else if (result.code === "OUTFIT_NOT_OWNED") notOwned = true;
      // 角色与归属已匹配，但发布或素材不可用；保留旧穿着并拒绝本次请求。
      else throw outfitError(result.code);
    }
    if (ownerMismatch) throw outfitError("OUTFIT_OWNER_MISMATCH");
    if (notOwned) throw outfitError("OUTFIT_NOT_OWNED");
    throw outfitError("OUTFIT_NOT_FOUND");
  }

  function refView(ref, entries, pending) {
    if (!ref) {
      return null;
    }
    const base = ref.outfitId === BASE_OUTFIT_ID;
    const entry = entries.find((item) => item.outfitId === ref.outfitId);
    return {
      outfitId: ref.outfitId,
      storyId: ref.storyId,
      version: ref.version,
      ...(pending
        ? { token: ref.token, requestedAt: ref.requestedAt }
        : { committedAt: ref.committedAt }),
      available: base ? true : entry?.available === true,
      reason: !base && !entry ? "OUTFIT_UNAVAILABLE" : entry?.reason ?? null,
    };
  }

  function state(value) {
    const characterId = text(
      typeof value === "string" ? value : value?.characterId,
      "characterId",
    );
    ensureCharacter(characterId);
    const worn = readWorn(characterId);
    const pending = readPending(characterId);
    const entries = [{ ...BASE_ENTRY }, ...ownedEntries(characterId)];
    // 已穿/待穿引用的衣装即使已消失，也保留身份并明确不可用。
    for (const ref of [worn, pending]) {
      if (!ref || ref.outfitId === BASE_OUTFIT_ID) continue;
      if (entries.some((item) => item.outfitId === ref.outfitId)) continue;
      entries.push({
        outfitId: ref.outfitId, storyId: ref.storyId ?? null, owned: false,
        storyAvailable: false, assetAvailable: false, available: false,
        reason: "OUTFIT_UNAVAILABLE",
      });
    }
    return {
      characterId,
      worn: refView(worn, entries, false),
      pending: refView(pending, entries, true),
      outfits: entries,
    };
  }

  function transaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function queue(key, target, worn, pending) {
    const version = Math.max(worn.version, pending?.version ?? 0) + 1;
    statements.setState.run(`${PENDING_PREFIX}${key}`, JSON.stringify({
      outfitId: target.outfitId, storyId: target.storyId,
      token: crypto.randomUUID(), version, requestedAt: nowMs(),
    }));
  }

  function request({ characterId, outfitId } = {}) {
    const key = text(characterId, "characterId");
    const targetId = text(outfitId, "outfitId");
    ensureCharacter(key);
    const outcome = transaction(() => {
      const worn = readWorn(key);
      const pending = readPending(key);
      const target = targetId === BASE_OUTFIT_ID
        ? BASE_TARGET
        : resolveTarget(key, targetId);

      if (worn.outfitId === target.outfitId) {
        if (pending) {
          statements.clearState.run(`${PENDING_PREFIX}${key}`);
        }
        return { requested: false, duplicate: true, cancelled: Boolean(pending) };
      }
      if (
        pending
        && pending.outfitId === target.outfitId
        && pending.storyId === target.storyId
      ) {
        return { requested: true, duplicate: true, cancelled: false };
      }
      queue(key, target, worn, pending);
      return { requested: true, duplicate: false, cancelled: false };
    });
    return { ...state(key), ...outcome };
  }

  /* 只提交与当前 token/版本完全匹配的待穿；校验与写入同一事务。
     接纳资格在待穿后消失时直接拒绝，不覆盖旧穿着或丢弃待穿意图。 */
  function commitPending({ characterId, token, version } = {}) {
    const key = text(characterId, "characterId");
    const tokenValue = text(token, "token");
    const versionValue = integer(version, "version");
    ensureCharacter(key);
    const outcome = transaction(() => {
      const pending = readPending(key);
      if (!pending) {
        throw new AppError("OUTFIT_PENDING_MISSING", "没有待穿的衣装意图。");
      }
      if (pending.token !== tokenValue || pending.version !== versionValue) {
        throw new AppError("OUTFIT_PENDING_STALE", "待穿意图已被新的选择替换。");
      }
      const target = pending.outfitId === BASE_OUTFIT_ID
        ? BASE_TARGET
        : resolveTarget(key, pending.outfitId);
      statements.setState.run(`${WORN_PREFIX}${key}`, JSON.stringify({
        outfitId: target.outfitId, storyId: target.storyId,
        version: pending.version, committedAt: nowMs(),
      }));
      statements.clearState.run(`${PENDING_PREFIX}${key}`);
      return { committed: true };
    });
    return { ...state(key), ...outcome };
  }

  return { list: state, getState: state, request, commitPending };
}

module.exports = { createOutfits, BASE_OUTFIT_ID };
