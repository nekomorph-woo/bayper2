/* S03m 纠正来源上下文：在既有直接聊天来源之外，支持聊天纠正、已证明传播副本
   与当日临时理解。只读既有表，返回内存证据；不保存正文副本，不判定语义正确。
   旧 chat:<messageId> 直接来源形状与摘要保持逐字兼容。 */
const crypto = require("node:crypto");
const { AppError } = require("./errors.cjs");
const {
  locateCorrectionSegments,
} = require("./memory-correction-evidence.cjs");

const LIMITS = {
  characterId: 200, entryId: 200, utterance: 3000, contextMessages: 2,
  contextChars: 6000, scanMessages: 8, segments: 8,
};
const CHAT_SOURCE = /^chat:([^:\s]+)$/u;
const CORRECTED_SOURCE = /^chat-correct:([^:\s]+):([1-9]\d*):(chat:[^:\s]+)$/u;
const CURRENT_SOURCE = /^chat-current:([^:\s]+):(\d+):(chat:[^:\s]+)$/u;
const PROPAGATED_SOURCE = /^corrected:([^:\s]+):([1-9]\d*)$/u;
const CORRECTED_VIA = new Set(["corrected_chat", "identity_correction", "current_temporary"]);

const sha256 = (value) => crypto.createHash("sha256").update(value, "utf8").digest("hex");
const unavailable = (reason) => ({ status: "unavailable", reason });
const messageView = (row) => ({
  id: row.id, conversationId: row.conversation_id, seq: row.seq,
  createdAt: row.created_at, content: row.content,
});

/* 旧直接来源不增加字段，摘要数组保持原顺序，避免改变既有快照与证据。 */
function digestOf(snapshot) {
  const base = [
    snapshot.status, snapshot.characterId, snapshot.holderCharacterId,
    snapshot.speaker, snapshot.entryId, snapshot.entryVersion,
    snapshot.sourceId, snapshot.sourceVersion, snapshot.contextVersion,
    snapshot.sourceCreatedAt, snapshot.excerpt, snapshot.contextIncomplete,
    snapshot.sourceMessage, snapshot.messages,
  ];
  if (snapshot.format === "corrected_v2") {
    base.push(
      snapshot.format, snapshot.sourceAnchorEntryId, snapshot.sourceAnchorVersion,
      snapshot.sourceAnchorIdentityId, snapshot.sourceCharacterId,
      snapshot.direct, snapshot.via, snapshot.expiresAt, snapshot.segments,
    );
  }
  return sha256(JSON.stringify(base));
}

function createMemorySourceContext({ db, memory, now = () => Date.now() } = {}) {
  if (!db || typeof db.prepare !== "function") {
    throw new AppError("DATABASE_REQUIRED", "来源上下文需要显式 SQLite 连接。");
  }
  if (!memory || typeof memory.getContextVersion !== "function") {
    throw new AppError("MEMORY_REQUIRED", "来源上下文需要记忆服务。");
  }
  const clock = typeof now === "function" ? now : () => now;
  const entryColumns = `
    e.id, e.character_id, e.fact_key, e.body, e.trust, e.source_kind, e.source_id,
    e.source_version, e.version, e.expires_at, e.origin_character_id,
    e.fact_identity_id, e.derived_from_entry_id,
    EXISTS (SELECT 1 FROM memory_derivations d WHERE d.entry_id = e.id)
      AS has_derivation
  `;
  const statements = {
    isKnownCharacter: db.prepare("SELECT 1 AS found FROM relationships WHERE character_id = ?"),
    getEntry: db.prepare(`SELECT ${entryColumns} FROM memory_entries e WHERE e.id = ?`),
    listIdentityEntries: db.prepare(`
      SELECT ${entryColumns} FROM memory_entries e
      WHERE e.fact_identity_id = ?
      ORDER BY e.created_at ASC, e.id ASC
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
  /* source id 内嵌 revision 是生成时的历史版本；必须可安全解析且不能超过
     条目当前版本。association 递增版本后，较早的 revision 仍有效。 */
  function revisionOf(value) {
    const revision = typeof value === "string" ? Number(value) : value;
    return Number.isSafeInteger(revision) && revision >= 1 ? revision : null;
  }
  const sourceExcluded = (characterId, sourceId) =>
    Boolean(statements.hasSourceControl.get(characterId, sha256(sourceId)));

  function messageBelongsTo(message, characterId, embeddedSourceId) {
    return Boolean(
      message &&
      message.source_id === embeddedSourceId &&
      message.role === "user" &&
      message.character_id === characterId &&
      message.conversation_character_id === characterId &&
      Number.isSafeInteger(message.seq),
    );
  }

  /* 传播副本的锚只来自同一已证明 identity 的当前 chat-correct 条目；
     正文必须一致，多个锚视为歧义，不用同文或前缀猜测。 */
  function findCorrectionAnchor(entry, nowMs) {
    if (!entry.fact_identity_id) {
      return { status: "unavailable", reason: "anchor_unavailable" };
    }
    const candidates = statements.listIdentityEntries.all(entry.fact_identity_id)
      .filter((row) =>
        row.id !== entry.id &&
        row.body === entry.body &&
        row.source_id.startsWith("chat-correct:") &&
        row.source_version === 1 &&
        row.trust === "stated" &&
        (row.source_kind ?? "user") === "user" &&
        (row.expires_at === null || row.expires_at > nowMs),
      );
    if (candidates.length === 0) {
      return { status: "unavailable", reason: "anchor_unavailable" };
    }
    if (candidates.length > 1) {
      return { status: "unavailable", reason: "anchor_ambiguous" };
    }
    return { status: "ok", anchor: candidates[0] };
  }

  function priorMessages({ message, sourceCharacterId }) {
    const scanned = statements.listPriorUserMessages.all(
      message.conversation_id, sourceCharacterId, message.seq, LIMITS.scanMessages + 1,
    );
    let contextIncomplete = scanned.length > LIMITS.scanMessages;
    const messages = [];
    let totalChars = message.content.length;
    for (const prior of scanned.slice(0, LIMITS.scanMessages)) {
      if (
        messages.length >= LIMITS.contextMessages ||
        sourceExcluded(sourceCharacterId, prior.source_id) ||
        prior.content.length > LIMITS.utterance ||
        totalChars + prior.content.length > LIMITS.contextChars
      ) {
        contextIncomplete = true;
        continue;
      }
      messages.push(messageView(prior));
      totalChars += prior.content.length;
    }
    messages.reverse();
    return { messages, contextIncomplete };
  }

  function correctedSnapshot({
    entry, characterId, nowMs, anchor, message, embeddedSourceId, sourceCharacterId,
    direct, via,
  }) {
    if (sourceExcluded(characterId, entry.source_id)) {
      return unavailable("source_excluded");
    }
    if (sourceExcluded(characterId, embeddedSourceId) ||
      sourceExcluded(sourceCharacterId, embeddedSourceId)) {
      return unavailable("source_excluded");
    }
    if (sourceExcluded(sourceCharacterId, anchor.source_id)) {
      return unavailable("source_excluded");
    }
    if (message.content.length > LIMITS.utterance) {
      return unavailable("source_too_long");
    }
    const segments = locateCorrectionSegments(message.content, entry.body);
    if (!segments || segments.length === 0 || segments.length > LIMITS.segments) {
      return unavailable("segments_unavailable");
    }
    const { messages, contextIncomplete } = priorMessages({ message, sourceCharacterId });
    const snapshot = {
      status: "ok",
      format: "corrected_v2",
      speaker: "user",
      sourceCharacterId,
      holderCharacterId: characterId,
      sourceAnchorEntryId: anchor.id,
      sourceAnchorVersion: anchor.version,
      sourceAnchorIdentityId: anchor.fact_identity_id,
      entryId: entry.id,
      entryVersion: entry.version,
      sourceId: entry.source_id,
      sourceVersion: entry.source_version,
      contextVersion: memory.getContextVersion(characterId),
      sourceCreatedAt: message.created_at,
      expiresAt: entry.expires_at,
      excerpt: entry.body,
      sourceMessage: messageView(message),
      messages,
      contextIncomplete,
      direct,
      via,
      segments: segments.map((segment) => ({ messageId: message.id, ...segment })),
    };
    return { ...snapshot, digest: digestOf(snapshot) };
  }

  function resolveCorrected(entry, characterId, nowMs) {
    if (entry.source_version !== 1) {
      return unavailable("source_version_mismatch");
    }
    if (entry.source_id.startsWith("chat-correct:")) {
      const match = CORRECTED_SOURCE.exec(entry.source_id);
      const revision = match ? revisionOf(match[2]) : null;
      if (!match || match[1] !== entry.id || revision === null || revision > entry.version) {
        return unavailable(revision === null || revision > entry.version
          ? "source_revision_invalid"
          : "source_mismatch");
      }
      const embeddedSourceId = match[3];
      const message = statements.getMessage.get(embeddedSourceId.slice("chat:".length));
      if (!messageBelongsTo(message, characterId, embeddedSourceId)) {
        return unavailable("source_mismatch");
      }
      return correctedSnapshot({
        entry, characterId, nowMs, anchor: entry, message, embeddedSourceId,
        sourceCharacterId: characterId, direct: true, via: "corrected_chat",
      });
    }

    if (entry.source_id.startsWith("chat-current:")) {
      const match = CURRENT_SOURCE.exec(entry.source_id);
      if (!match) {
        return unavailable("source_mismatch");
      }
      const anchor = statements.getEntry.get(match[1]);
      const embeddedSourceId = match[3];
      const message = statements.getMessage.get(embeddedSourceId.slice("chat:".length));
      if (
        !anchor ||
        anchor.character_id !== characterId ||
        !anchor.fact_identity_id ||
        entry.expires_at === null ||
        entry.fact_key !== `${anchor.fact_key}.current.${anchor.id}` ||
        (anchor.expires_at !== null && anchor.expires_at <= nowMs) ||
        !messageBelongsTo(message, characterId, embeddedSourceId)
      ) {
        return unavailable("source_mismatch");
      }
      return correctedSnapshot({
        entry, characterId, nowMs, anchor, message, embeddedSourceId,
        sourceCharacterId: characterId, direct: true, via: "current_temporary",
      });
    }

    if (!entry.source_id.startsWith("corrected:")) {
      return unavailable("unsupported_source");
    }
    const propagated = PROPAGATED_SOURCE.exec(entry.source_id);
    const propagatedRevision = propagated ? revisionOf(propagated[2]) : null;
    if (!propagated || propagated[1] !== entry.id || propagatedRevision === null ||
      propagatedRevision > entry.version) {
      return unavailable(propagatedRevision === null || propagatedRevision > entry.version
        ? "source_revision_invalid"
        : "source_mismatch");
    }
    const found = findCorrectionAnchor(entry, nowMs);
    if (found.status !== "ok") {
      return found;
    }
    const anchor = found.anchor;
    const anchorSource = CORRECTED_SOURCE.exec(anchor.source_id);
    const anchorRevision = anchorSource ? revisionOf(anchorSource[2]) : null;
    if (!anchorSource || anchorSource[1] !== anchor.id || anchorRevision === null ||
      anchorRevision > anchor.version) {
      return unavailable("anchor_unavailable");
    }
    const embeddedSourceId = anchorSource[3];
    const message = statements.getMessage.get(embeddedSourceId.slice("chat:".length));
    if (!messageBelongsTo(message, anchor.character_id, embeddedSourceId)) {
      return unavailable("anchor_unavailable");
    }
    return correctedSnapshot({
      entry, characterId, nowMs, anchor, message, embeddedSourceId,
      sourceCharacterId: anchor.character_id, direct: false, via: "identity_correction",
    });
  }

  function resolveDirect(entry, characterId, nowMs) {
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
    const chatSource = CHAT_SOURCE.exec(entry.source_id);
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
    if (!messageBelongsTo(message, characterId, entry.source_id)) {
      return unavailable("source_mismatch");
    }
    if (message.content.length > LIMITS.utterance) {
      return unavailable("source_too_long");
    }
    if (!message.content.includes(entry.body)) {
      return unavailable("body_not_in_source");
    }
    const { messages, contextIncomplete } = priorMessages({
      message, sourceCharacterId: characterId,
    });
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
    const corrected = entry.source_id.startsWith("chat-correct:") ||
      entry.source_id.startsWith("corrected:") ||
      entry.source_id.startsWith("chat-current:");
    return corrected
      ? resolveCorrected(entry, characterId, nowMs)
      : resolveDirect(entry, characterId, nowMs);
  }

  /* 先核对快照自身摘要，再以 holder + entryId 重解析；传播副本不能用来源角色
     去读持有者条目。旧直接来源保持原比较字段。 */
  function isCurrent(snapshot) {
    if (!snapshot || typeof snapshot !== "object" || snapshot.status !== "ok") {
      throw new AppError("INVALID_INPUT", "来源快照无效。");
    }
    const corrected = snapshot.format === "corrected_v2";
    if (corrected && !CORRECTED_VIA.has(snapshot.via)) {
      throw new AppError("INVALID_INPUT", "来源快照 via 无效。");
    }
    const holderCharacterId = textOf(
      corrected ? snapshot.holderCharacterId : snapshot.characterId,
      "角色ID",
      LIMITS.characterId,
    );
    const entryId = textOf(snapshot.entryId, "记忆ID", LIMITS.entryId);
    const entryVersion = versionOf(snapshot.entryVersion);
    if (typeof snapshot.digest !== "string" || snapshot.digest !== digestOf(snapshot)) {
      return false;
    }
    const current = resolve({ characterId: holderCharacterId, entryId, expectedVersion: entryVersion });
    if (current.status !== "ok") {
      return false;
    }
    if (corrected) {
      return (
        current.format === "corrected_v2" &&
        current.sourceCharacterId === snapshot.sourceCharacterId &&
        current.holderCharacterId === snapshot.holderCharacterId &&
        current.sourceAnchorEntryId === snapshot.sourceAnchorEntryId &&
        current.sourceAnchorVersion === snapshot.sourceAnchorVersion &&
        current.sourceAnchorIdentityId === snapshot.sourceAnchorIdentityId &&
        current.direct === snapshot.direct &&
        current.via === snapshot.via &&
        current.expiresAt === snapshot.expiresAt &&
        current.contextVersion === snapshot.contextVersion &&
        current.entryVersion === entryVersion &&
        current.sourceId === snapshot.sourceId &&
        current.sourceVersion === snapshot.sourceVersion &&
        current.sourceCreatedAt === snapshot.sourceCreatedAt &&
        current.sourceMessage.id === snapshot.sourceMessage?.id &&
        JSON.stringify(current.segments) === JSON.stringify(snapshot.segments) &&
        current.digest === snapshot.digest
      );
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
