/* S03l-b 有界聊天来源上下文：只给内部中立核验层返回调用角色自持的用户原话与
   有限前文；不追溯其他角色私聊、不打开外部来源，也不保存正文副本或新表。 */
const crypto = require("node:crypto");
const { AppError } = require("./errors.cjs");
const LIMITS = {
  characterId: 200, entryId: 200, utterance: 3000, contextMessages: 2,
  contextChars: 6000, scanMessages: 8,
};
const sha256 = (value) => crypto.createHash("sha256").update(value, "utf8").digest("hex");
const unavailable = (reason) => ({ status: "unavailable", reason });
const messageView = (row) => ({
  id: row.id, conversationId: row.conversation_id, seq: row.seq,
  createdAt: row.created_at, content: row.content,
});
function digestOf(snapshot) {
  return sha256(JSON.stringify([
    snapshot.status, snapshot.characterId, snapshot.holderCharacterId,
    snapshot.speaker, snapshot.entryId, snapshot.entryVersion,
    snapshot.sourceId, snapshot.sourceVersion, snapshot.contextVersion,
    snapshot.sourceCreatedAt, snapshot.excerpt, snapshot.contextIncomplete,
    snapshot.sourceMessage, snapshot.messages,
  ]));
}
function createMemorySourceContext({ db, memory, now = () => Date.now() } = {}) {
  if (!db || typeof db.prepare !== "function") {
    throw new AppError("DATABASE_REQUIRED", "来源上下文需要显式 SQLite 连接。");
  }
  if (!memory || typeof memory.getContextVersion !== "function") {
    throw new AppError("MEMORY_REQUIRED", "来源上下文需要记忆服务。");
  }
  const clock = typeof now === "function" ? now : () => now;
  const statements = {
    isKnownCharacter: db.prepare("SELECT 1 AS found FROM relationships WHERE character_id = ?"),
    getEntry: db.prepare(`
      SELECT e.id, e.character_id, e.body, e.trust, e.source_kind, e.source_id,
             e.source_version, e.version, e.expires_at, e.origin_character_id,
             e.derived_from_entry_id,
             EXISTS (SELECT 1 FROM memory_derivations d WHERE d.entry_id = e.id)
               AS has_derivation
      FROM memory_entries e WHERE e.id = ?
    `),
    getMessage: db.prepare(`
      SELECT m.id, m.conversation_id, m.character_id, m.role, m.content,
             m.source_id, m.created_at, m.seq,
             c.character_id AS conversation_character_id
      FROM chat_messages m JOIN chat_conversations c ON c.id = m.conversation_id
      WHERE m.id = ?
    `),
    listPriorUserMessages: db.prepare(`
      SELECT id, conversation_id, character_id, role, content, source_id,
             created_at, seq
      FROM chat_messages
      WHERE conversation_id = ? AND character_id = ? AND role = 'user' AND seq < ?
      ORDER BY seq DESC, id DESC LIMIT ?
    `),
    hasSourceControl: db.prepare(`
      SELECT 1 AS found FROM memory_source_controls WHERE character_id = ? AND source_id_hash = ?
    `),
  };
  function resolveNow(value) {
    const current = value === undefined ? clock() : value;
    const ms = current instanceof Date ? current.getTime() : current;
    if (!Number.isFinite(ms)) {
      throw new AppError("INVALID_TIME", "时间无效。");
    }
    return Math.trunc(ms);
  }
  function textOf(value, field, max) {
    if (typeof value !== "string") {
      throw new AppError("INVALID_INPUT", `${field}必须是字符串。`);
    }
    const text = value.trim();
    if (!text || text.length > max || /[\u0000-\u001f\u007f]/u.test(text)) {
      throw new AppError("INVALID_INPUT", `${field}为空、超长或包含控制字符。`);
    }
    return text;
  }
  function versionOf(value) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new AppError("INVALID_INPUT", "记忆版本无效。");
    }
    return value;
  }
  const sourceExcluded = (characterId, sourceId) =>
    Boolean(statements.hasSourceControl.get(characterId, sha256(sourceId)));
  /* 只接受 entry.sourceId 精确为 chat:<messageId> 的直接来源。派生/转告/分享、
     主题/外部/面板合成以及纠正产生的合成来源都不伪装成用户原话。 */
  function resolve(input) {
    if (!input || typeof input !== "object") {
      throw new AppError("INVALID_INPUT", "来源解析参数无效。");
    }
    const characterId = textOf(input.characterId, "角色ID", LIMITS.characterId);
    if (!statements.isKnownCharacter.get(characterId)) {
      throw new AppError("CHARACTER_UNKNOWN", "角色不存在或尚未结识。");
    }
    const entryId = textOf(input.entryId, "记忆ID", LIMITS.entryId);
    const expectedVersion = versionOf(input.expectedVersion);
    const nowMs = resolveNow(input.nowMs);
    const entry = statements.getEntry.get(entryId);
    if (!entry || entry.character_id !== characterId) {
      return unavailable("entry_unavailable");
    }
    if (entry.version !== expectedVersion) {
      return unavailable("version_mismatch");
    }
    if (entry.expires_at !== null && entry.expires_at <= nowMs) {
      return unavailable("expired");
    }
    if (entry.trust !== "stated") {
      return unavailable("not_stated");
    }
    if ((entry.source_kind ?? "user") !== "user") {
      return unavailable("unsupported_source");
    }
    const derived =
      entry.has_derivation === 1 ||
      entry.derived_from_entry_id !== null ||
      entry.origin_character_id !== characterId;
    if (derived) {
      return unavailable(
        entry.source_id.startsWith("relay:") ? "relay_source"
          : entry.source_id.startsWith("share:") ? "share_source"
            : "derived_source",
      );
    }
    const chatSource = /^chat:([^:\s]+)$/u.exec(entry.source_id);
    if (!chatSource) {
      return unavailable("unsupported_source");
    }
    if (entry.source_version !== 1) {
      return unavailable("source_version_mismatch");
    }
    if (sourceExcluded(characterId, entry.source_id)) {
      return unavailable("source_excluded");
    }
    const message = statements.getMessage.get(chatSource[1]);
    if (!message) {
      return unavailable("source_missing");
    }
    if (
      message.source_id !== entry.source_id ||
      message.role !== "user" ||
      message.character_id !== characterId ||
      message.conversation_character_id !== characterId ||
      !Number.isSafeInteger(message.seq)
    ) {
      return unavailable("source_mismatch");
    }
    if (message.content.length > LIMITS.utterance) {
      return unavailable("source_too_long");
    }
    if (!message.content.includes(entry.body)) {
      return unavailable("body_not_in_source");
    }

    /* 前文只读同会话、同角色、seq 在当前之前的 user 消息；固定扫描上限，
       不补读助手、其他角色、其他会话或之后消息。超限/受限/超预算均标不完整。 */
    const scanned = statements.listPriorUserMessages.all(
      message.conversation_id, characterId, message.seq, LIMITS.scanMessages + 1,
    );
    let contextIncomplete = scanned.length > LIMITS.scanMessages;
    const messages = [];
    let totalChars = message.content.length;
    for (const prior of scanned.slice(0, LIMITS.scanMessages)) {
      if (
        messages.length >= LIMITS.contextMessages ||
        sourceExcluded(characterId, prior.source_id) ||
        prior.content.length > LIMITS.utterance ||
        totalChars + prior.content.length > LIMITS.contextChars
      ) {
        contextIncomplete = true;
        continue;
      }
      messages.push(messageView(prior));
      totalChars += prior.content.length;
    }
    messages.reverse(); // 扫描按 seq 倒序，输出恢复为实际顺序。
    const snapshot = {
      status: "ok",
      characterId,
      holderCharacterId: characterId,
      speaker: "user",
      entryId: entry.id,
      entryVersion: entry.version,
      sourceId: entry.source_id,
      sourceVersion: entry.source_version,
      contextVersion: memory.getContextVersion(characterId),
      sourceCreatedAt: message.created_at,
      excerpt: entry.body,
      sourceMessage: messageView(message),
      messages,
      contextIncomplete,
    };
    return { ...snapshot, digest: digestOf(snapshot) };
  }

  /* 重新解析核对版本、上下文与所返回内容；不返回新正文，只给布尔判断。
     先核对传入快照自身内容仍能生成同一摘要，避免保留旧 digest 的修改内容
     借旧摘要通过；再重新解析比对当前库。这不是签名或权限隔离。 */
  function isCurrent(snapshot) {
    if (!snapshot || typeof snapshot !== "object" || snapshot.status !== "ok") {
      throw new AppError("INVALID_INPUT", "来源快照无效。");
    }
    const characterId = textOf(snapshot.characterId, "角色ID", LIMITS.characterId);
    const entryId = textOf(snapshot.entryId, "记忆ID", LIMITS.entryId);
    const entryVersion = versionOf(snapshot.entryVersion);
    if (typeof snapshot.digest !== "string" || snapshot.digest !== digestOf(snapshot)) {
      return false;
    }
    const current = resolve({ characterId, entryId, expectedVersion: entryVersion });
    if (current.status !== "ok") {
      return false;
    }
    return (
      current.status === snapshot.status &&
      current.characterId === snapshot.characterId &&
      current.holderCharacterId === snapshot.holderCharacterId &&
      current.speaker === snapshot.speaker &&
      current.contextVersion === snapshot.contextVersion &&
      current.entryVersion === entryVersion &&
      current.sourceId === snapshot.sourceId &&
      current.sourceVersion === snapshot.sourceVersion &&
      current.sourceCreatedAt === snapshot.sourceCreatedAt &&
      current.sourceMessage.id === snapshot.sourceMessage?.id &&
      current.digest === snapshot.digest
    );
  }

  return { resolve, isCurrent };
}

module.exports = { createMemorySourceContext };
