/* S03m 纠正来源上下文：在既有直接聊天来源之外，支持聊天纠正、已证明传播副本
   与当日临时理解。只读既有表，返回内存证据；不保存正文副本，不判定语义正确。
   旧 chat:<messageId> 直接来源形状与摘要保持逐字兼容。 */
const crypto = require("node:crypto");
const { AppError } = require("./errors.cjs");
const {
  locateCorrectionSegments,
} = require("./memory-correction-evidence.cjs");
const { parseTemporarySource } = require("./memory-temporary-source.cjs");

const LIMITS = {
  characterId: 200, entryId: 200, utterance: 3000, contextMessages: 2,
  contextChars: 6000, scanMessages: 8, segments: 8,
};
const CHAT_SOURCE = /^chat:([^:\s]+)$/u;
const CORRECTED_SOURCE = /^chat-correct:([^:\s]+):([1-9]\d*):(chat:[^:\s]+)$/u;
const CURRENT_SOURCE = /^chat-current:([^:\s]+):(\d+):(chat:[^:\s]+)$/u;
const PROPAGATED_SOURCE = /^corrected:([^:\s]+):([1-9]\d*)$/u;
const CORRECTED_VIA = new Set([
  "corrected_chat",
  "identity_correction",
  "current_temporary",
  "temporary_propagation",
  "temporary_relay",
  "temporary_edit",
]);

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
  if (snapshot.temporaryKind) {
    base.push(
      snapshot.temporaryKind, snapshot.temporaryIdentityId,
      snapshot.temporarySourceEntryId, snapshot.temporarySourceVersion,
      snapshot.temporarySourceStatus, snapshot.sourceAnchorStatus,
      snapshot.holderAnchorEntryId, snapshot.holderAnchorVersion,
      snapshot.holderAnchorIdentityId, snapshot.holderAnchorStatus,
      snapshot.edited, snapshot.relayFrom,
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
      AS has_derivation,
    (SELECT d.narrator_character_id FROM memory_derivations d WHERE d.entry_id = e.id)
      AS temporary_narrator_id,
    (SELECT d.parent_entry_id FROM memory_derivations d WHERE d.entry_id = e.id)
      AS temporary_parent_entry_id,
    (SELECT d.origin_character_id FROM memory_derivations d WHERE d.entry_id = e.id)
      AS temporary_derivation_origin,
    (SELECT d.source_id FROM memory_derivations d WHERE d.entry_id = e.id)
      AS temporary_derivation_source_id,
    (SELECT d.source_version FROM memory_derivations d WHERE d.entry_id = e.id)
      AS temporary_derivation_source_version
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
    listTemporaryLinks: db.prepare(`
      SELECT temp_identity_id, long_identity_id, holder_character_id, expires_at
      FROM memory_temporary_links
      WHERE temp_identity_id = ?
      ORDER BY holder_character_id ASC, long_identity_id ASC, expires_at ASC
    `),
    /* 显式 share/relay 会留下无正文关系边；身份同步 copy 没有边。用边区分
       propagation 与 temporary_relay，避免把同一来源格式当成同一种讲述方式。 */
    getRelationEdgeToEntry: db.prepare(`
      SELECT from_entry_id, kind FROM memory_fact_relation_edges
      WHERE to_entry_id = ?
      ORDER BY kind ASC
      LIMIT 1
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
      if (!match) {
        return unavailable("source_mismatch");
      }
      const anchor = statements.getEntry.get(match[1]);
      const revision = revisionOf(match[2]);
      if (!anchor || anchor.character_id !== characterId) {
        return unavailable("source_mismatch");
      }
      if (revision === null || revision > anchor.version) {
        return unavailable("source_revision_invalid");
      }
      /* 旧版同角色 identity 成员可能共享发起条目的 chat-correct 来源；本条自身
         不是锚，必须核旧锚存在、stated/user、未过期、实际来源一致、同身份同正文。
         新版 correct 已改为非锚成员使用 corrected:，这里只兼容旧数据。 */
      const peer = anchor.id !== entry.id;
      if (peer && (
        anchor.source_id !== entry.source_id ||
        anchor.trust !== "stated" ||
        (anchor.source_kind ?? "user") !== "user" ||
        (anchor.expires_at !== null && anchor.expires_at <= nowMs) ||
        !anchor.fact_identity_id ||
        anchor.fact_identity_id !== entry.fact_identity_id ||
        anchor.body !== entry.body
      )) {
        return unavailable("source_mismatch");
      }
      const embeddedSourceId = match[3];
      const message = statements.getMessage.get(embeddedSourceId.slice("chat:".length));
      if (!messageBelongsTo(message, characterId, embeddedSourceId)) {
        return unavailable("source_mismatch");
      }
      return correctedSnapshot({
        entry, characterId, nowMs, anchor, message, embeddedSourceId,
        sourceCharacterId: characterId,
        direct: !peer,
        via: peer ? "identity_correction" : "corrected_chat",
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
      const expectedFactKey = anchor ? `${anchor.fact_key}.current.${anchor.id}` : null;
      const link = temporaryLinkInfo(entry);
      if (
        !anchor ||
        anchor.character_id !== characterId ||
        !anchor.fact_identity_id ||
        entry.expires_at === null ||
        !expectedFactKey ||
        (entry.fact_key !== expectedFactKey &&
          !entry.fact_key.startsWith(`${expectedFactKey}.`)) ||
        (anchor.expires_at !== null && anchor.expires_at <= nowMs) ||
        !messageBelongsTo(message, characterId, embeddedSourceId)
      ) {
        return unavailable("source_mismatch");
      }
      if (link.reason) {
        return unavailable(link.reason);
      }
      if (link.longIdentityId !== anchor.fact_identity_id) {
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

  /* 临时条目必须与自身 T 的无正文 link 一致：同一长期 identity、同一到期，
     且当前 holder 恰有一行。缺失/冲突一律保守不可用，不猜第一条，也不拿
     来源里的锚替代 link 证据。 */
  function temporaryLinkInfo(entry) {
    const rows = statements.listTemporaryLinks.all(entry.fact_identity_id);
    if (rows.length === 0) {
      return { reason: "link_missing" };
    }
    const longIdentityIds = new Set(rows.map((row) => row.long_identity_id));
    if (longIdentityIds.size !== 1 ||
      rows.some((row) => row.expires_at !== entry.expires_at)) {
      return { reason: "link_conflict" };
    }
    const holderRows = rows.filter((row) => row.holder_character_id === entry.character_id);
    if (holderRows.length !== 1) {
      return { reason: holderRows.length === 0 ? "link_missing" : "link_conflict" };
    }
    return { longIdentityId: rows[0].long_identity_id };
  }

  /* copy/edit 共用的关系核验：显式 share/relay 的关系边只对当前 immediate
     parent 有效；身份同步必须指向 origin current。derived_from 必须与持久
     derivation 一致：父行存活时不能缺失，父行删除后应为 NULL。 */
  function temporaryRelationInfo(entry, sourceCharacterId, characterId, expectedParentId) {
    if (!entry.has_derivation) {
      return { reason: "derivation_missing" };
    }
    if (entry.temporary_derivation_origin !== sourceCharacterId ||
      entry.temporary_derivation_source_id !== entry.source_id ||
      entry.temporary_derivation_source_version !== 1) {
      return { reason: "derivation_mismatch" };
    }
    const parentId = entry.temporary_parent_entry_id;
    const narrator = entry.temporary_narrator_id;
    if (!parentId || narrator === null) {
      return { reason: "derivation_mismatch" };
    }
    const parent = statements.getEntry.get(parentId);
    if (entry.derived_from_entry_id !== (parent ? parentId : null)) {
      return { reason: "derivation_mismatch" };
    }
    const relationEdge = statements.getRelationEdgeToEntry.get(entry.id);
    if (relationEdge) {
      if (parentId !== relationEdge.from_entry_id || narrator === characterId) {
        return { reason: "derivation_mismatch" };
      }
      if (parent && (
        parent.fact_identity_id !== entry.fact_identity_id ||
        parent.expires_at !== entry.expires_at ||
        parent.character_id !== narrator
      )) {
        return { reason: "derivation_mismatch" };
      }
      return { relayed: true, narrator };
    }
    if (narrator !== sourceCharacterId || parentId !== expectedParentId) {
      return { reason: "derivation_mismatch" };
    }
    if (parent && (
      parent.fact_identity_id !== entry.fact_identity_id ||
      parent.expires_at !== entry.expires_at ||
      parent.character_id !== sourceCharacterId
    )) {
      return { reason: "derivation_mismatch" };
    }
    return { relayed: false, narrator };
  }

  /* 同步副本：来源只嵌入 origin 锚与 holder long，不保存正文副本。
     derivation、link、origin current、holder long 与消息归属都必须一致；
     link 缺失或冲突时不得猜第一条，也不能拿临时 T 冒充长期 L。origin
     current 被删除后，B 仍可按持久 derivation/link 与 origin 消息验证。 */
  function resolveTemporaryCopy(entry, characterId, nowMs) {
    if (entry.source_version !== 1) {
      return unavailable("source_version_mismatch");
    }
    const parsed = parseTemporarySource(entry.source_id);
    if (!parsed || parsed.kind !== "copy") {
      return unavailable("unsupported_source");
    }
    const sourceCharacterId = entry.origin_character_id;
    const relation = temporaryRelationInfo(
      entry,
      sourceCharacterId,
      characterId,
      parsed.originCurrentEntryId,
    );
    if (relation.reason) {
      return unavailable(relation.reason);
    }
    const relayed = relation.relayed;
    const narratorCharacterId = relation.narrator;
    /* 来源控制按 holder 作用域：A 的 self 控制不阻断 B，但 B 自己的副本来源
       与其嵌入的 origin 消息来源都必须未被 B 排除。 */
    if (sourceExcluded(characterId, entry.source_id) ||
      sourceExcluded(characterId, parsed.messageSourceId)) {
      return unavailable("source_excluded");
    }
    const message = statements.getMessage.get(parsed.messageSourceId.slice("chat:".length));
    if (!messageBelongsTo(message, sourceCharacterId, parsed.messageSourceId)) {
      return unavailable("source_mismatch");
    }
    if (message.content.length > LIMITS.utterance) {
      return unavailable("source_too_long");
    }
    const segments = locateCorrectionSegments(message.content, entry.body);
    if (!segments || segments.length === 0 || segments.length > LIMITS.segments) {
      return unavailable("segments_unavailable");
    }

    const link = temporaryLinkInfo(entry);
    if (link.reason) {
      return unavailable(link.reason);
    }
    const longIdentityId = link.longIdentityId;

    let holderAnchor = null;
    if (parsed.holderLongEntryId) {
      holderAnchor = statements.getEntry.get(parsed.holderLongEntryId);
      if (!holderAnchor ||
        holderAnchor.character_id !== characterId ||
        holderAnchor.version !== parsed.holderLongVersion ||
        holderAnchor.fact_identity_id !== longIdentityId ||
        (holderAnchor.expires_at !== null && holderAnchor.expires_at <= nowMs)) {
        return unavailable("holder_anchor_changed");
      }
    }

    const originCurrent = statements.getEntry.get(parsed.originCurrentEntryId);
    if (originCurrent) {
      const originParsed = parseTemporarySource(originCurrent.source_id);
      if (originCurrent.character_id !== sourceCharacterId ||
        originCurrent.fact_identity_id !== entry.fact_identity_id ||
        originCurrent.version !== parsed.originCurrentVersion ||
        originCurrent.body !== entry.body ||
        originCurrent.trust !== entry.trust ||
        (originCurrent.expires_at ?? null) !== entry.expires_at ||
        !originParsed || originParsed.kind !== "direct" ||
        originParsed.originLongEntryId !== parsed.originLongEntryId ||
        originParsed.messageSourceId !== parsed.messageSourceId) {
        return unavailable("temporary_source_changed");
      }
    }
    const originLong = statements.getEntry.get(parsed.originLongEntryId);
    const { messages, contextIncomplete } = priorMessages({ message, sourceCharacterId });
    const snapshot = {
      status: "ok",
      format: "corrected_v2",
      speaker: "user",
      sourceCharacterId,
      holderCharacterId: characterId,
      sourceAnchorEntryId: parsed.originLongEntryId,
      sourceAnchorVersion: parsed.originLongVersion,
      sourceAnchorIdentityId: longIdentityId,
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
      direct: false,
      via: relayed ? "temporary_relay" : "temporary_propagation",
      temporaryKind: "copy",
      temporaryIdentityId: entry.fact_identity_id,
      temporarySourceEntryId: parsed.originCurrentEntryId,
      temporarySourceVersion: originCurrent?.version ?? parsed.originCurrentVersion,
      temporarySourceStatus: originCurrent ? "live" : "removed",
      sourceAnchorStatus: originLong ? "live" : "removed",
      holderAnchorEntryId: holderAnchor?.id ?? null,
      holderAnchorVersion: holderAnchor?.version ?? 0,
      holderAnchorIdentityId: holderAnchor?.fact_identity_id ?? null,
      holderAnchorStatus: holderAnchor ? "live" : "absent",
      edited: false,
      relayFrom: relayed ? narratorCharacterId : null,
      segments: segments.map((segment) => ({ messageId: message.id, ...segment })),
    };
    return { ...snapshot, digest: digestOf(snapshot) };
  }

  /* 面板编辑来源：origin 消息只作溯源，正文不要求与消息片段一致。仍核
     T/link/holder/expiry、holder long、origin current（存在时）与 derivation
     的真实 immediate parent/narrator；origin current 删除后按持久证据验证。 */
  function resolveEdit(entry, characterId, nowMs) {
    if (entry.source_version !== 1) {
      return unavailable("source_version_mismatch");
    }
    const parsed = parseTemporarySource(entry.source_id);
    if (!parsed || parsed.kind !== "edit") {
      return unavailable("unsupported_source");
    }
    const sourceCharacterId = entry.origin_character_id;
    if (sourceExcluded(characterId, entry.source_id) ||
      sourceExcluded(characterId, parsed.messageSourceId)) {
      return unavailable("source_excluded");
    }
    const message = statements.getMessage.get(parsed.messageSourceId.slice("chat:".length));
    if (!messageBelongsTo(message, sourceCharacterId, parsed.messageSourceId)) {
      return unavailable("source_mismatch");
    }
    if (message.content.length > LIMITS.utterance) {
      return unavailable("source_too_long");
    }
    const link = temporaryLinkInfo(entry);
    if (link.reason) {
      return unavailable(link.reason);
    }
    const longIdentityId = link.longIdentityId;

    let holderAnchor = null;
    if (parsed.holderLongEntryId) {
      holderAnchor = statements.getEntry.get(parsed.holderLongEntryId);
      if (!holderAnchor ||
        holderAnchor.character_id !== characterId ||
        holderAnchor.version !== parsed.holderLongVersion ||
        holderAnchor.fact_identity_id !== longIdentityId ||
        (holderAnchor.expires_at !== null && holderAnchor.expires_at <= nowMs)) {
        return unavailable("holder_anchor_changed");
      }
    }

    const originCurrent = statements.getEntry.get(parsed.originCurrentEntryId);
    if (originCurrent) {
      const originParsed = parseTemporarySource(originCurrent.source_id);
      if (originCurrent.character_id !== sourceCharacterId ||
        originCurrent.fact_identity_id !== entry.fact_identity_id ||
        originCurrent.version !== parsed.originCurrentVersion ||
        originCurrent.body !== entry.body ||
        originCurrent.trust !== entry.trust ||
        (originCurrent.expires_at ?? null) !== entry.expires_at ||
        !originParsed ||
        (originParsed.kind !== "direct" && originParsed.kind !== "edit") ||
        originParsed.originLongEntryId !== parsed.originLongEntryId ||
        originParsed.messageSourceId !== parsed.messageSourceId) {
        return unavailable("temporary_source_changed");
      }
    }

    const isOrigin = entry.character_id === sourceCharacterId &&
      entry.id === parsed.originCurrentEntryId;
    let relayedNarrator = null;
    if (!isOrigin) {
      const relation = temporaryRelationInfo(
        entry,
        sourceCharacterId,
        characterId,
        parsed.originCurrentEntryId,
      );
      if (relation.reason) {
        return unavailable(relation.reason);
      }
      relayedNarrator = relation.relayed ? relation.narrator : null;
    }

    const originLong = statements.getEntry.get(parsed.originLongEntryId);
    const { messages, contextIncomplete } = priorMessages({ message, sourceCharacterId });
    const snapshot = {
      status: "ok",
      format: "corrected_v2",
      speaker: "user",
      sourceCharacterId,
      holderCharacterId: characterId,
      sourceAnchorEntryId: parsed.originLongEntryId,
      sourceAnchorVersion: parsed.originLongVersion,
      sourceAnchorIdentityId: longIdentityId,
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
      direct: false,
      via: "temporary_edit",
      temporaryKind: "edit",
      temporaryIdentityId: entry.fact_identity_id,
      temporarySourceEntryId: parsed.originCurrentEntryId,
      temporarySourceVersion: originCurrent?.version ?? parsed.originCurrentVersion,
      temporarySourceStatus: originCurrent ? "live" : "removed",
      sourceAnchorStatus: originLong ? "live" : "removed",
      holderAnchorEntryId: holderAnchor?.id ?? null,
      holderAnchorVersion: holderAnchor?.version ?? 0,
      holderAnchorIdentityId: holderAnchor?.fact_identity_id ?? null,
      holderAnchorStatus: holderAnchor ? "live" : "absent",
      edited: true,
      relayFrom: relayedNarrator,
      segments: [],
    };
    return { ...snapshot, digest: digestOf(snapshot) };
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
    if (entry.source_id.startsWith("temporary-edit:")) {
      return resolveEdit(entry, characterId, nowMs);
    }
    if (entry.source_id.startsWith("chat-current-copy:")) {
      return resolveTemporaryCopy(entry, characterId, nowMs);
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
        current.digest === snapshot.digest &&
        (!snapshot.temporaryKind || (
          current.temporaryKind === snapshot.temporaryKind &&
          current.temporaryIdentityId === snapshot.temporaryIdentityId &&
          current.temporarySourceEntryId === snapshot.temporarySourceEntryId &&
          current.temporarySourceVersion === snapshot.temporarySourceVersion &&
          current.temporarySourceStatus === snapshot.temporarySourceStatus &&
          current.sourceAnchorStatus === snapshot.sourceAnchorStatus &&
          current.holderAnchorEntryId === snapshot.holderAnchorEntryId &&
          current.holderAnchorVersion === snapshot.holderAnchorVersion &&
          current.holderAnchorIdentityId === snapshot.holderAnchorIdentityId &&
          current.holderAnchorStatus === snapshot.holderAnchorStatus &&
          current.edited === snapshot.edited &&
          current.relayFrom === snapshot.relayFrom
        ))
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

  /* S03m 阶段 2 窄证据复核：阶段 0 捕获的旧事实在本地正确后，entry version/source
     必然变化，因此不能直接 isCurrent。这里只核对不应由本操作改变的证据：原 chat
     消息与有限前文未改未删、segments 仍逐字可重算、来源控制集合只允许本操作新增
     的旧 source 哈希。不是通用忽略权限开关。 */
  function isEvidenceCurrent(snapshot, {
    holderCharacterId,
    expectedExcludedHashes = [],
    allowedSourceHashes = [],
  } = {}) {
    if (!snapshot || snapshot.status !== "ok" ||
      snapshot.holderCharacterId !== holderCharacterId ||
      typeof snapshot.digest !== "string" || snapshot.digest !== digestOf(snapshot) ||
      !snapshot.sourceMessage) {
      return false;
    }
    const message = statements.getMessage.get(snapshot.sourceMessage.id);
    if (!message ||
      message.content !== snapshot.sourceMessage.content ||
      message.created_at !== snapshot.sourceMessage.createdAt ||
      message.seq !== snapshot.sourceMessage.seq ||
      message.conversation_id !== snapshot.sourceMessage.conversationId ||
      message.source_id !== `chat:${message.id}` ||
      message.role !== "user" ||
      message.character_id !== holderCharacterId ||
      message.conversation_character_id !== holderCharacterId) {
      return false;
    }
    for (const prior of snapshot.messages ?? []) {
      const row = statements.getMessage.get(prior.id);
      if (!row ||
        row.content !== prior.content ||
        row.created_at !== prior.createdAt ||
        row.seq !== prior.seq ||
        row.conversation_id !== prior.conversationId ||
        row.source_id !== `chat:${row.id}` ||
        row.role !== "user" ||
        row.character_id !== holderCharacterId ||
        row.conversation_character_id !== holderCharacterId) {
        return false;
      }
    }
    if (snapshot.format === "corrected_v2") {
      const segments = locateCorrectionSegments(message.content, snapshot.excerpt);
      if (!segments || segments.length !== snapshot.segments.length) {
        return false;
      }
      for (let index = 0; index < segments.length; index += 1) {
        const expected = snapshot.segments[index];
        const actual = segments[index];
        if (!expected || actual.start !== expected.start ||
          actual.end !== expected.end || actual.text !== expected.text) {
          return false;
        }
      }
    } else if (!message.content.includes(snapshot.excerpt)) {
      return false;
    }
    const expected = new Set([...expectedExcludedHashes, ...allowedSourceHashes]);
    const current = memory.listExcludedSources(holderCharacterId);
    if (current.length !== expected.size || current.some((hash) => !expected.has(hash))) {
      return false;
    }
    return true;
  }

  return { resolve, isCurrent, isEvidenceCurrent };
}

module.exports = { createMemorySourceContext };
