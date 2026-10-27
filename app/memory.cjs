/* S03a 本地独属记忆业务入口。
   职责：有来源写入、角色范围读取/检索、已定位纠正/删除、指定分享、上下文版本。
   S03d 增加用户明确转告与按事实的持久禁分享控制；两者都必须由主进程在可信
   用户操作后调用，正文或模型回复不能自行取得权限。这里不做自然语言语义定位：
   纠正和删除必须由调用方给出明确的 factKey；正文中的任何指令都只是记忆内容，
   不执行删除、分享或扩大权限。API 字段本身不是安全认证，IPC 授权不在本切片。
   characterId 由主进程按当前会话选择；本服务只验证角色关系存在，不把 renderer
   自报的角色当作授权依据。工厂显式接收现有 SQLite 连接，正式 createStore 接入
   由后续步骤完成。 */
const crypto = require("node:crypto");
const { createMemoryStore } = require("./memory-store.cjs");
const {
  factKeyHash,
  identityFingerprint,
  normalizeFactBody,
  strictFactFingerprint,
} = require("./memory-fact-identity.cjs");
const {
  RETRIEVAL_CONFIG,
  RETRIEVAL_STRATEGIES,
  buildSearchQuery,
  shouldBroadenQuery,
  tokenizeForIndex,
} = require("./memory-retrieval.cjs");
const { createMemoryTemporary } = require("./memory-temporary.cjs");
const {
  copiedTemporarySource,
  editedTemporarySource,
  parseTemporarySource,
} = require("./memory-temporary-source.cjs");

const LIMITS = Object.freeze({
  characterId: 200,
  factKey: 200,
  body: 2000,
  sourceId: 200,
  query: RETRIEVAL_CONFIG.maxQueryChars,
  shareEntries: 20,
  extractionFacts: 20,
  list: 200,
  memoryPage: 30,
  contextEntries: 500,
  contextMaxChars: 600,
  contextCore: 5,
  contextPreferences: 8,
  contextExperiences: 5,
  contextQueryResults: 20,
  rebuildBatch: 500,
});

const DEFAULT_IMPORTANCE = Object.freeze({
  identity: 90,
  preference: 60,
  experience: 50,
  detail: 20,
});

/* S03i：全局开关只控制自动/派生的 share 入口；用户明确 relay 不受影响。
   默认开启表示允许窄范围自动分享，不代表已经有后台分享行为。 */
const AUTO_SHARE_STATE_KEY = "memory_auto_share_enabled";

class MemoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MemoryError";
    this.code = code;
  }
}

function createMemoryService({ db, now = () => Date.now() } = {}) {
  if (!db || typeof db.prepare !== "function") {
    throw new MemoryError("DATABASE_REQUIRED", "记忆服务需要显式传入 SQLite 连接。");
  }
  const store = createMemoryStore(db);
  const clock = typeof now === "function" ? now : () => now;

  function resolveNow(value) {
    const current = value ?? clock();
    if (!Number.isFinite(current)) {
      throw new MemoryError("INVALID_TIME", "时间必须是有效数字。");
    }
    return Math.trunc(current);
  }

  function characterIdOf(value) {
    const text = cleanText(value, "角色ID", LIMITS.characterId);
    if (!store.isKnownCharacter(text)) {
      throw new MemoryError("CHARACTER_UNKNOWN", "角色不存在。");
    }
    return text;
  }

  function cleanText(value, field, max) {
    if (typeof value !== "string") {
      throw new MemoryError("INVALID_INPUT", `${field} 必须是字符串。`);
    }
    const text = value.trim();
    if (text.length === 0) {
      throw new MemoryError("INVALID_INPUT", `${field} 不能为空。`);
    }
    if (text.length > max) {
      throw new MemoryError("INVALID_INPUT", `${field} 超过长度上限。`);
    }
    if (/[\u0000-\u001f\u007f]/u.test(text)) {
      throw new MemoryError("INVALID_INPUT", `${field} 不能包含控制字符。`);
    }
    return text;
  }

  function bodyOf(value) {
    if (typeof value !== "string") {
      throw new MemoryError("INVALID_INPUT", "正文必须是字符串。");
    }
    const text = value.trim();
    if (text.length === 0) {
      throw new MemoryError("INVALID_INPUT", "正文不能为空。");
    }
    if (text.length > LIMITS.body) {
      throw new MemoryError("INVALID_INPUT", "正文超过长度上限。");
    }
    if (text.includes("\u0000")) {
      throw new MemoryError("INVALID_INPUT", "正文不能包含 NUL 字符。");
    }
    return text;
  }

  function kindOf(value) {
    const kind = value ?? "detail";
    if (!Object.hasOwn(DEFAULT_IMPORTANCE, kind)) {
      throw new MemoryError("INVALID_INPUT", "记忆类别无效。");
    }
    return kind;
  }

  function trustOf(value) {
    const trust = value ?? "stated";
    if (trust !== "stated" && trust !== "inferred") {
      throw new MemoryError("INVALID_INPUT", "可信性质无效。");
    }
    return trust;
  }

  /* 来源种类只允许 user/theme；用户直接入口默认 user，主题分享是唯一生产写入方。
     模型候选批次在 applyExtractionBatch 中强制 user，不能凭正文自我声明为主题。 */
  function sourceKindOf(value) {
    const kind = value ?? "user";
    if (kind !== "user" && kind !== "theme") {
      throw new MemoryError("INVALID_INPUT", "来源种类无效。");
    }
    return kind;
  }

  function importanceOf(value, kind) {
    if (value === undefined) {
      return DEFAULT_IMPORTANCE[kind];
    }
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      throw new MemoryError("INVALID_INPUT", "重要性必须是 0 到 100 的整数。");
    }
    return value;
  }

  function optionalTime(value, field) {
    if (value === undefined) {
      return undefined;
    }
    if (value === null) {
      return null;
    }
    if (!Number.isSafeInteger(value)) {
      throw new MemoryError("INVALID_INPUT", `${field} 必须是整数或 null。`);
    }
    return value;
  }

  function sourceVersionOf(value) {
    if (value === undefined) {
      return 1;
    }
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new MemoryError("INVALID_INPUT", "来源版本必须是正整数。");
    }
    return value;
  }

  function expectedVersionOf(value) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new MemoryError("INVALID_INPUT", "记忆版本无效。");
    }
    return value;
  }

  /* 管理端用稳定条目 ID 定位本次选中项；旧服务调用仍可直接传 factKey。
     版本核验放在事务内，避免列表与提交之间被新理解覆盖。 */
  function factForSelectedChange(input, characterId) {
    if (input.entryId === undefined) {
      const factKey = cleanText(input.factKey, "事实键", LIMITS.factKey);
      return {
        factKey,
        entryId: null,
        entry: store.getEntryByFact(characterId, factKey),
      };
    }
    const entryId = cleanText(input.entryId, "记忆ID", 200);
    const selected = store.getEntryById(entryId);
    if (!selected || selected.characterId !== characterId) {
      throw new MemoryError("ENTRY_NOT_FOUND", "这条记忆不存在，请重新查看。");
    }
    if (input.expectedVersion !== undefined) {
      const expectedVersion = expectedVersionOf(input.expectedVersion);
      if (selected.version !== expectedVersion) {
        throw new MemoryError("MEMORY_CHANGED", "记忆已更新，请重新查看。");
      }
    } else {
      throw new MemoryError("INVALID_INPUT", "记忆版本不能为空。");
    }
    return { factKey: selected.factKey, entryId, entry: selected };
  }

  function limitOf(value, fallback, max) {
    if (value === undefined) {
      return fallback;
    }
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new MemoryError("INVALID_INPUT", "条数上限必须是正整数。");
    }
    return Math.min(value, max);
  }

  function sourceIdHash(sourceId) {
    return crypto.createHash("sha256").update(sourceId, "utf8").digest("hex");
  }

  function newEntryId() {
    return crypto.randomUUID();
  }

  /* 事实身份：factKey 只定位当前角色条目，传播范围由不透明身份决定。
     独立来源即使正文相同也各自新建身份；正文指纹只登记为别名，用于删除/
     禁分享等控制覆盖，不能当作同一事实的证明。分享/转告等真实派生才继承
     来源身份。旧条目若无身份，先在本次事务内补建独立身份再按身份展开。 */
  function createIdentity(fact, fingerprint) {
    const identityId = newEntryId();
    store.insertFactIdentity(identityId, fact.createdAt);
    if (fingerprint) {
      store.registerAlias(fingerprint, identityId, fact.createdAt);
    }
    return identityId;
  }

  function identityOfEntry(entry, at) {
    if (entry.factIdentityId) {
      return entry.factIdentityId;
    }
    const identityId = createIdentity(
      { ...entry, createdAt: at },
      identityFingerprint(entry),
    );
    store.setEntryIdentity(entry.id, identityId);
    entry.factIdentityId = identityId;
    return identityId;
  }

  /* 临时理解领域模块只拿显式依赖：既有身份/哈希/索引/事务仍由本服务提供，
     不复制 forget/restrict/exclusive 的控制流程。来源有效性由 store 组装后
     注入的权威校验器（memorySourceContext.resolve）统一判定。 */
  let temporaryValidator = null;
  const temporary = createMemoryTemporary({
    store,
    newId: newEntryId,
    hashSource: sourceIdHash,
    identityOf: identityOfEntry,
    fingerprintOf: strictFactFingerprint,
    validateTemporary: (input) =>
      temporaryValidator ? temporaryValidator(input) : null,
    tokenize: tokenizeForIndex,
    MemoryError,
    limits: LIMITS,
  });

  function setTemporaryValidator(validator) {
    if (typeof validator !== "function") {
      throw new MemoryError("INVALID_INPUT", "临时来源校验器必须是函数。");
    }
    temporaryValidator = validator;
  }

  /* 与当前正文指纹相关的全部身份。歧义指纹不挑首项，控制检查覆盖整组，
     避免靠新分配身份绕过 forget/share 限制。 */
  function relatedIdentityIds(entry) {
    const identityIds = new Set();
    if (entry.factIdentityId) {
      identityIds.add(entry.factIdentityId);
    }
    const fingerprint = identityFingerprint(entry);
    if (fingerprint) {
      for (const identityId of store.listAliasIdentityIds(fingerprint)) {
        identityIds.add(identityId);
      }
    }
    return [...identityIds].sort();
  }

  /* 禁分享按身份判范围；拆分身份只看自身控制，非拆分保持同指纹整组保守
     检查；无法定位身份的孤儿旧键仍按既有兼容边界阻断。 */
  function isShareRestricted(entry) {
    const ownIdentity = entry.factIdentityId ?? null;
    const identityIds = ownIdentity && store.isSplitIdentity(ownIdentity)
      ? [ownIdentity]
      : relatedIdentityIds(entry);
    if (
      identityIds.some((identityId) =>
        store.hasShareIdentityControl(identityId),
      )
    ) {
      return true;
    }
    const legacy = store.getShareControl(factKeyHash(entry.factKey));
    return Boolean(legacy && legacy.identity_id === null);
  }

  /* 写入时的忘记保护：身份组内任一控制、本角色已删除原文的严格指纹，
     或无法定位身份的孤儿旧控制，都阻止无明确许可的重学。显式新许可仍按
     既有规则，且来源控制始终优先。 */
  function insertForgetBlocked(characterId, relatedIds, deletedFingerprint, factKey) {
    if (
      relatedIds.some((identityId) =>
        store.hasForgetIdentityControl(characterId, identityId),
      )
    ) {
      return true;
    }
    if (
      deletedFingerprint &&
      store.hasDeletedFactFingerprint(characterId, deletedFingerprint)
    ) {
      return true;
    }
    // 无现存条目可恢复身份的旧控制，只能按旧键保留兼容保护。
    const legacy = store.getForgetControl(characterId, factKeyHash(factKey));
    return Boolean(legacy && legacy.identity_id === null);
  }

  function deletedFingerprintOf(entry) {
    return strictFactFingerprint(entry);
  }

  function sameFactMetadata(left, right) {
    return (
      left.kind === right.kind &&
      left.trust === right.trust &&
      (left.sourceKind ?? "user") === (right.sourceKind ?? "user") &&
      (left.expiresAt ?? null) === (right.expiresAt ?? null)
    );
  }

  /* 关联执行器只接受上层已确认的等价决定；这里不判断正文语义，只复用既有
     事实校验与来源控制。整组都必须有效：任何成员过期、来源被排除、主题见闻、
     推断事实或 metadata 不一致都拒绝，避免只校验选中的两条。 */
  function assertAssociableEntries(entries, nowMs) {
    for (const entry of entries) {
      if (entry.expiresAt !== null && entry.expiresAt <= nowMs) {
        throw new MemoryError("ASSOCIATION_REJECTED", "已到期的记忆不能关联。");
      }
      if (store.hasSourceControl(entry.characterId, sourceIdHash(entry.sourceId))) {
        throw new MemoryError("ASSOCIATION_REJECTED", "来源已被排除，不能关联。");
      }
      if ((entry.sourceKind ?? "user") === "theme") {
        throw new MemoryError("ASSOCIATION_REJECTED", "主题见闻不能关联。");
      }
      if (entry.trust === "inferred") {
        throw new MemoryError("ASSOCIATION_REJECTED", "推断事实不能关联。");
      }
    }
    const reference = entries[0];
    if (!entries.every((entry) => sameFactMetadata(reference, entry))) {
      throw new MemoryError(
        "ASSOCIATION_REJECTED",
        "身份组内存在类别、性质、来源种类或有效期限不同的记忆。",
      );
    }
  }

  function associationSelection(value, side) {
    if (!value || typeof value !== "object") {
      throw new MemoryError("INVALID_INPUT", `${side} 必须包含记忆ID与版本。`);
    }
    return {
      entryId: cleanText(value.entryId, "记忆ID", 200),
      expectedVersion: expectedVersionOf(value.expectedVersion),
    };
  }

  /* 分享/转告接收者：逐身份检查相关控制，并核对接收者已删除原文的
     本角色指纹；孤儿旧行按旧键兼容。删除指纹只阻止该角色学回同文，
     不合并双方身份。 */
  function recipientForgetBlocked(
    characterId,
    relatedIds,
    deletedFingerprint,
    factKey,
  ) {
    if (
      relatedIds.some((identityId) =>
        store.hasForgetIdentityControl(characterId, identityId),
      )
    ) {
      return true;
    }
    if (
      deletedFingerprint &&
      store.hasDeletedFactFingerprint(characterId, deletedFingerprint)
    ) {
      return true;
    }
    const legacy = store.getForgetControl(characterId, factKeyHash(factKey));
    return Boolean(legacy && legacy.identity_id === null);
  }

  function holdersOfIdentity(identityId) {
    return [
      ...new Set(store.listEntriesByIdentity(identityId).map((entry) => entry.characterId)),
    ].sort();
  }

  function sameBody(left, right) {
    return normalizeFactBody(left) === normalizeFactBody(right);
  }

  /* 同一来源可以产生多个 factKey。单条 remember 以 (角色, factKey) 幂等；
     对同一来源重扫请使用 applyExtractionBatch，以 (角色, 来源哈希, 来源版本)
     的批次标记保证整次提炼只应用一次。新来源版本视为新提炼，已有 factKey
     不会被静默覆盖，需要显式 correct。 */
  function normalizeFact(input, overrides = {}) {
    const characterId = overrides.characterId ?? characterIdOf(input.characterId);
    const factKey = cleanText(input.factKey, "事实键", LIMITS.factKey);
    const kind = kindOf(input.kind);
    return {
      characterId,
      factKey,
      body: bodyOf(input.body),
      kind,
      trust: trustOf(input.trust),
      sourceKind: overrides.sourceKind ?? sourceKindOf(input.sourceKind),
      importance: importanceOf(input.importance, kind),
      sourceId: overrides.sourceId ?? cleanText(input.sourceId, "来源ID", LIMITS.sourceId),
      sourceVersion: overrides.sourceVersion ?? sourceVersionOf(input.sourceVersion),
      originCharacterId: characterIdOf(
        input.originCharacterId ?? overrides.originCharacterId ?? characterId,
      ),
      createdAt: resolveNow(input.createdAt ?? overrides.createdAt),
      expiresAt: optionalTime(input.expiresAt, "到期时间") ?? null,
      explicitConsent:
        input.explicitConsent === true || overrides.explicitConsent === true,
    };
  }

  /* 在已有事务内写入一条事实；调用方负责提交/回滚与上下文版本递增。
     同角色同键但正文不同不再静默当作已持有：保留旧条目并返回明确冲突，
     不覆盖。每条新事实都建立独立身份，正文相同也不跨键复用；正文指纹只
     用于登记别名和删除/禁分享控制，避免同一句话被当成同一主体。 */
  function insertFactIfAllowed(fact) {
    // 旧来源重扫永远不是新许可；即使显式同意也不能用被控制过的旧来源回填。
    if (store.hasSourceControl(fact.characterId, sourceIdHash(fact.sourceId))) {
      return { created: false, blocked: "source", entry: null };
    }
    const existing = store.getEntryByFact(fact.characterId, fact.factKey);
    if (existing) {
      if (!sameBody(existing.body, fact.body)) {
        return {
          created: false,
          blocked: null,
          conflict: "fact_key_body",
          entry: existing,
        };
      }
      if (!sameFactMetadata(existing, fact)) {
        return {
          created: false,
          blocked: null,
          conflict: "fact_key_metadata",
          entry: existing,
        };
      }
      return { created: false, blocked: null, entry: existing };
    }

    const fingerprint = identityFingerprint(fact);
    const deletedFingerprint = deletedFingerprintOf(fact);
    if (!fact.explicitConsent && insertForgetBlocked(
      fact.characterId,
      fingerprint ? store.listAliasIdentityIds(fingerprint) : [],
      deletedFingerprint,
      fact.factKey,
    )) {
      return { created: false, blocked: "forget", entry: null };
    }
    const identityId = createIdentity(fact, fingerprint);

    const entry = {
      id: newEntryId(),
      characterId: fact.characterId,
      factKey: fact.factKey,
      factIdentityId: identityId,
      originCharacterId: fact.originCharacterId,
      derivedFromEntryId: null,
      kind: fact.kind,
      body: fact.body,
      trust: fact.trust,
      sourceKind: fact.sourceKind,
      importance: fact.importance,
      expiresAt: fact.expiresAt,
      sourceId: fact.sourceId,
      sourceVersion: fact.sourceVersion,
      version: 1,
      createdAt: fact.createdAt,
      updatedAt: fact.createdAt,
    };
    store.insertEntry(entry, tokenizeForIndex(entry.body));
    return { created: true, blocked: null, entry };
  }

  function remember(input = {}) {
    const fact = normalizeFact(input);
    const applyRemember = () => {
      const result = insertFactIfAllowed(fact);
      if (!result.created) {
        return result;
      }
      const contextVersion = store.bumpContextVersion(fact.characterId, fact.createdAt);
      return { ...result, contextVersion };
    };
    // 聊天临时理解需要与回复、请求状态共用同一事务。
    return input.inTransaction === true ? applyRemember() : store.transaction(applyRemember);
  }

  /* 聊天“今天…”的阶段 1 入口；长期条目不动，T/控制/同步由领域模块负责。 */
  function applyTemporaryUnderstanding(input = {}) {
    return temporary.applyUnderstanding(input);
  }

  /* S03b 的提炼入口基础：一次明确提交同一个来源的多个事实。
     本切片不调用模型；S03b 必须把已验证的提炼结果组装成 facts 后调用这里。
     同一 sourceVersion 重复应用是幂等的；新 sourceVersion 视为新提炼，
     已存在的 factKey 不会被静默覆盖。来源正文与事实清单不写入批次表。
     被忘记控制拦下的事实不会因同版本重扫恢复；重新学习需要新的明确来源/版本。 */
  function applyExtractionBatch(input = {}) {
    const characterId = characterIdOf(input.characterId);
    const sourceId = cleanText(input.sourceId, "来源ID", LIMITS.sourceId);
    const sourceVersion = sourceVersionOf(input.sourceVersion);
    const appliedAt = resolveNow(input.appliedAt);
    const createdAt = resolveNow(input.createdAt ?? appliedAt);
    const originCharacterId = input.originCharacterId ?? characterId;
    const explicitConsent = input.explicitConsent === true;
    if (!Array.isArray(input.facts)) {
      throw new MemoryError("INVALID_INPUT", "facts 必须是数组。");
    }
    if (input.facts.length > LIMITS.extractionFacts) {
      throw new MemoryError("INVALID_INPUT", "一次提炼的事实数量过多。");
    }
    const factKeys = new Set();
    const facts = input.facts.map((raw) => {
      const fact = normalizeFact(raw, {
        characterId,
        sourceId,
        sourceVersion,
        originCharacterId,
        createdAt,
        explicitConsent,
        // 模型候选属于用户本轮明确说出的内容；不允许自带 theme 来源种类。
        sourceKind: "user",
      });
      if (factKeys.has(fact.factKey)) {
        throw new MemoryError("INVALID_INPUT", "同一批次不能包含重复事实键。");
      }
      factKeys.add(fact.factKey);
      return fact;
    });
    const sourceHash = sourceIdHash(sourceId);

    /* 窄事务兼容入口：聊天服务需要在同一 SQLite 事务内原子提交记忆、助手消息和请求状态。
       传入 inTransaction 时不再自行 BEGIN；调用方必须已开启事务并负责提交/回滚。 */
    const applyBatch = () => {
      if (store.hasSourceControl(characterId, sourceHash)) {
        return { applied: false, reason: "blocked_source", facts: [] };
      }
      if (store.hasExtractionBatch(characterId, sourceHash, sourceVersion)) {
        return { applied: false, reason: "duplicate_batch", facts: [] };
      }

      const results = facts.map((fact) => ({
        factKey: fact.factKey,
        ...insertFactIfAllowed(fact),
      }));
      store.addExtractionBatch(characterId, sourceHash, sourceVersion, appliedAt);
      const created = results.filter((result) => result.created).length;
      const contextVersion =
        created > 0 ? store.bumpContextVersion(characterId, appliedAt) : null;
      return { applied: true, reason: null, facts: results, contextVersion };
    };
    return input.inTransaction === true ? applyBatch() : store.transaction(applyBatch);
  }

  function listMemories(characterIdInput, options = {}) {
    const characterId = characterIdOf(characterIdInput);
    const nowMs = resolveNow(options.nowMs);
    const limit = limitOf(options.limit, LIMITS.list, LIMITS.list);
    return store.listActiveEntries(characterId, nowMs, limit);
  }

  /* 管理界面使用有界页大小；稳定性由 SQL 的 importance/updated_at/id 排序保证。
     pageSize + 1 只用于判断 hasMore，不改变现有 listMemories 的 200 条兼容行为。
     分享限制是事实级状态，由服务随条目投影给管理界面，主进程不另拼记忆 SQL。 */
  function listMemoriesPage(characterIdInput, options = {}) {
    const characterId = characterIdOf(characterIdInput);
    const nowMs = resolveNow(options.nowMs);
    const page = options.page ?? 0;
    if (!Number.isSafeInteger(page) || page < 0) {
      throw new MemoryError("INVALID_INPUT", "页码必须是非负整数。");
    }
    const pageSize = LIMITS.memoryPage;
    const rows = store.listActiveEntriesPage(
      characterId,
      nowMs,
      pageSize + 1,
      page * pageSize,
    );
    return {
      entries: rows.slice(0, pageSize).map((entry) => ({
        ...entry,
        sharingRestricted: isShareRestricted(entry),
      })),
      page,
      pageSize,
      hasMore: rows.length > pageSize,
    };
  }

  function indexTokenSet(body) {
    const tokens = tokenizeForIndex(body);
    return new Set(`${tokens.segmentTokens} ${tokens.charTokens}`.split(/\s+/).filter(Boolean));
  }

  function groupMatches(tokenSet, group) {
    return group.some((tokens) => tokens.every((token) => tokenSet.has(token)));
  }

  /* 宽召回只影响候选与排序，不判断事实真假。查询里的“不/没/无”等否定词
     保留在正文和候选中，由后续事实理解处理；不把字面否定当成硬过滤。
     角色隔离、时效和已删除内容仍由 SQL 与删除控制硬过滤。 */
  function rankBroadCandidates(rows, groups, limit, requestedStrategy) {
    return rows
      .map(({ entry, score }) => {
        const tokenSet = indexTokenSet(entry.body);
        const matchedGroups = groups.filter((group) => groupMatches(tokenSet, group)).length;
        return { entry, score, matchedGroups };
      })
      .filter((row) => row.matchedGroups > 0)
      .sort(
        (left, right) =>
          right.matchedGroups - left.matchedGroups ||
          left.score - right.score ||
          right.entry.importance - left.entry.importance ||
          left.entry.id.localeCompare(right.entry.id),
      )
      .slice(0, limit)
      .map((row) => ({
        ...row.entry,
        score: row.score,
        matchReason: {
          strategy: "broad",
          requestedStrategy,
          terms: groups.map((group) => group.map((tokens) => tokens.join(""))),
          concepts: [],
          matchedGroups: row.matchedGroups,
        },
      }));
  }

  function executeSearch(characterId, query, strategy, nowMs, limit, requestedStrategy) {
    const prepared = buildSearchQuery(query, strategy);
    if (!prepared) {
      return [];
    }
    const groups = prepared.explanation.groups;
    if (prepared.explanation.broad) {
      const candidateLimit = Math.min(
        RETRIEVAL_CONFIG.broadMaxCandidates,
        Math.max(
          RETRIEVAL_CONFIG.broadMinCandidates,
          limit * RETRIEVAL_CONFIG.broadCandidateMultiplier,
        ),
      );
      const rows = store.search(prepared.column, prepared.ftsQuery, characterId, nowMs, candidateLimit);
      return rankBroadCandidates(rows, groups, limit, requestedStrategy).map((entry) => ({
        ...entry,
        matchReason: {
          ...entry.matchReason,
          concepts: prepared.explanation.concepts,
        },
      }));
    }
    return store
      .search(prepared.column, prepared.ftsQuery, characterId, nowMs, limit)
      .map(({ entry, score }) => ({
        ...entry,
        score,
        matchReason: {
          strategy: prepared.explanation.strategy,
          requestedStrategy,
          terms: groups.map((group) => group.map((tokens) => tokens.join(""))),
          concepts: prepared.explanation.concepts,
        },
      }));
  }

  function searchMemories(input = {}) {
    const characterId = characterIdOf(input.characterId);
    const nowMs = resolveNow(input.nowMs);
    const limit = limitOf(input.limit, RETRIEVAL_CONFIG.defaultLimit, RETRIEVAL_CONFIG.maxLimit);
    const strategy = input.strategy ?? RETRIEVAL_CONFIG.defaultStrategy;
    if (!RETRIEVAL_STRATEGIES.includes(strategy)) {
      throw new MemoryError("INVALID_INPUT", "检索策略无效。");
    }
    if (typeof input.query !== "string" || input.query.trim() === "") {
      return [];
    }
    if (input.query.length > LIMITS.query) {
      throw new MemoryError("INVALID_INPUT", "查询超过长度上限。");
    }

    const validHits = (strategyName) => temporary.filterSearch(
      executeSearch(characterId, input.query, strategyName, nowMs, limit, strategy),
      nowMs,
    );
    if (strategy === "hybrid") {
      // 只有“过滤失效临时项后仍有结果”才算命中；否则继续既有 expanded/broad 回退。
      const strict = validHits("segment");
      if (strict.length > 0) {
        return strict.slice(0, limit);
      }
      const expanded = validHits("expanded");
      if (expanded.length > 0 || !shouldBroadenQuery(input.query)) {
        return expanded.slice(0, limit);
      }
      return validHits("broad").slice(0, limit);
    }
    // 管理定位仍允许长期条目；只剔除权威来源核验失败的临时项。
    return validHits(strategy).slice(0, limit);
  }

  /* 只按显式 factKey 或稳定条目定位纠正；调用方没有事实键时不会凭相似度猜测。
     任何当前已知持有者（含派生持有者）都可发起纠正；传播范围是条目的实际
     事实身份，而不是模型 factKey。身份在纠正后不变，新正文指纹也登记到同一
     身份，供之后的控制与重学判断使用。 */
  function correct(input = {}) {
    const characterId = characterIdOf(input.characterId);
    const body = bodyOf(input.body);
    const nowMs = resolveNow(input.nowMs);
    const trustProvided = input.trust !== undefined;
    const importanceProvided = input.importance !== undefined;
    const expiresProvided = Object.hasOwn(input, "expiresAt");
    const trust = trustProvided ? trustOf(input.trust) : null;
    const importance = importanceProvided ? importanceOf(input.importance, "detail") : null;
    const expiresAt = expiresProvided ? (optionalTime(input.expiresAt, "到期时间") ?? null) : undefined;
    const sourceId = input.sourceId === undefined ? null : cleanText(input.sourceId, "来源ID", LIMITS.sourceId);
    const sourceVersion = input.sourceVersion === undefined ? null : sourceVersionOf(input.sourceVersion);

    const applyCorrection = () => {
      const { entry: held } = factForSelectedChange(input, characterId);
      if (!held) {
        throw new MemoryError("FACT_NOT_HELD", "当前角色没有该事实，不能发起纠正。");
      }
      /* 面板保存临时理解时走窄路径：同步同一 T 的全部成员，保留 T/到期/
         长期锚，来源标记为 temporary-edit；不把面板编辑写成聊天原话。 */
      if (temporary.isTemporaryEntry(held)) {
        return temporary.editUnderstanding({
          characterId,
          entryId: held.id,
          expectedVersion: held.version,
          body,
          nowMs,
          inTransaction: true,
        });
      }
      const identityId = identityOfEntry(held, nowMs);
      const entries = store.listEntriesByIdentity(identityId);
      if (sourceId !== null) {
        for (const entry of entries) {
          if (entry.sourceId === sourceId) {
            throw new MemoryError("INVALID_INPUT", "纠正来源必须是新的来源ID。");
          }
          if (store.hasSourceControl(entry.characterId, sourceIdHash(sourceId))) {
            throw new MemoryError("INVALID_INPUT", "纠正来源已被排除，不能作为新理解来源。");
          }
        }
      }

      const affected = new Set();
      let updated = 0;
      let updatedDerived = 0;
      for (const entry of entries) {
        const derived = store.isDerivedEntry(entry.id);
        // 只有本次选中的 held 条目是直接来源；同角色 identity 其他成员与其他角色
        // 一样使用传播来源，避免把 identity 更新冒充成用户直接告诉该条目。
        const direct = entry.id === held.id && entry.characterId === characterId;
        const nextSourceId = direct
          ? (sourceId ?? `correct:${entry.id}:${entry.version + 1}`)
          : `corrected:${entry.id}:${entry.version + 1}`;
        if (entry.sourceId !== nextSourceId) {
          store.addSourceControl(entry.characterId, sourceIdHash(entry.sourceId), nowMs);
        }
        const next = {
          ...entry,
          body,
          trust: trustProvided ? trust : entry.trust,
          // 用户明确纠正后的正文归用户来源；旧主题见闻不再冒充作者原文。
          sourceKind: "user",
          importance: importanceProvided ? importance : entry.importance,
          expiresAt: expiresProvided ? expiresAt : entry.expiresAt,
          sourceId: nextSourceId,
          sourceVersion: direct && sourceVersion !== null ? sourceVersion : 1,
          version: entry.version + 1,
          updatedAt: nowMs,
        };
        store.updateEntry(next, tokenizeForIndex(body));
        affected.add(entry.characterId);
        updated += 1;
        if (derived) {
          updatedDerived += 1;
        }
      }

      // 新正文指纹仍指向同一身份；旧指纹不删除，旧正文重学也只能回到这里。
      const correctedFingerprint = identityFingerprint({
        kind: held.kind,
        trust: trustProvided ? trust : held.trust,
        sourceKind: "user",
        expiresAt: expiresProvided ? expiresAt : held.expiresAt,
        body,
      });
      if (correctedFingerprint) {
        store.registerAlias(correctedFingerprint, identityId, nowMs);
      }

      const contextVersions = {};
      for (const holder of affected) {
        contextVersions[holder] = store.bumpContextVersion(holder, nowMs);
      }
      return {
        updated,
        updatedDerived,
        affectedCharacters: [...affected].sort(),
        contextVersions,
      };
    };
    /* 聊天操作需要把记忆变更、回复与请求状态放进同一事务；
       inTransaction 时不再自行 BEGIN，由调用方负责提交/回滚。 */
    return input.inTransaction === true
      ? applyCorrection()
      : store.transaction(applyCorrection);
  }

  /* scope='self' 只让当前角色忘记；默认 'all' 清除该事实身份的全部已知持有者。
     任何当前已知持有者（含共享派生持有者）都可发起默认删除；未知角色不新增。
     控制表只保存身份标识、事实键摘要与来源引用哈希，不保存被删正文。
     sourceIdsToExclude 用于聊天删除命令：保留聊天原文，但该来源不再进入
     后续记忆上下文或旧提炼重试。 */
  function forget(input = {}) {
    const characterId = characterIdOf(input.characterId);
    const nowMs = resolveNow(input.nowMs);
    const scope = input.scope ?? "all";
    if (scope !== "all" && scope !== "self") {
      throw new MemoryError("INVALID_INPUT", "删除范围无效。");
    }
    const rawExcluded = input.sourceIdsToExclude ?? [];
    if (!Array.isArray(rawExcluded) || rawExcluded.length > 5) {
      throw new MemoryError("INVALID_INPUT", "排除来源列表无效。");
    }
    const excludedSources = rawExcluded.map((sourceId) =>
      cleanText(sourceId, "来源ID", LIMITS.sourceId),
    );

    const applyForget = () => {
      const { entry: held } = factForSelectedChange(input, characterId);
      if (!held) {
        throw new MemoryError("FACT_NOT_HELD", "当前角色没有该事实，不能执行删除。");
      }
      const identityId = identityOfEntry(held, nowMs);

      const entries = store.listEntriesByIdentity(identityId);
      const targets = scope === "all" ? entries : entries.filter((entry) => entry.characterId === characterId);
      const targetIds = new Set(targets.map((entry) => entry.id));
      const sourceControls = {};
      const identityControls = {};
      const deletedFingerprints = {};
      const addControl = (holder, value) => {
        if (!sourceControls[holder]) {
          sourceControls[holder] = [];
        }
        if (!sourceControls[holder].includes(value)) {
          sourceControls[holder].push(value);
        }
      };
      const addFingerprint = (holder, value) => {
        if (!value) {
          return;
        }
        if (!deletedFingerprints[holder]) {
          deletedFingerprints[holder] = [];
        }
        if (!deletedFingerprints[holder].includes(value)) {
          deletedFingerprints[holder].push(value);
        }
      };
      const affected = new Set();
      for (const entry of targets) {
        addControl(entry.characterId, sourceIdHash(entry.sourceId));
        identityControls[entry.characterId] = identityId;
        addFingerprint(entry.characterId, deletedFingerprintOf(entry));
        store.deleteEntry(entry.id);
        store.addSourceControl(entry.characterId, sourceIdHash(entry.sourceId), nowMs);
        store.addForgetIdentityControl(entry.characterId, identityId, nowMs);
        store.addDeletedFactFingerprint(
          entry.characterId,
          deletedFingerprintOf(entry),
          nowMs,
        );
        affected.add(entry.characterId);
      }
      for (const sourceId of excludedSources) {
        addControl(characterId, sourceIdHash(sourceId));
        store.addSourceControl(characterId, sourceIdHash(sourceId), nowMs);
      }

      const contextVersions = {};
      for (const holder of affected) {
        contextVersions[holder] = store.bumpContextVersion(holder, nowMs);
      }
      for (const holder of Object.keys(sourceControls)) {
        sourceControls[holder].sort();
      }
      for (const holder of Object.keys(deletedFingerprints)) {
        deletedFingerprints[holder].sort();
      }
      return {
        deleted: targets.length,
        affectedCharacters: [...affected].sort(),
        contextVersions,
        // 无正文删除证明：只含 id、版本、来源哈希、身份标识与删除指纹。
        controlProof: {
          identityId,
          scope,
          deletedEntryIds: targets.map((entry) => entry.id).sort(),
          retainedEntries: entries
            .filter((entry) => !targetIds.has(entry.id))
            .map((entry) => ({
              entryId: entry.id,
              characterId: entry.characterId,
              version: entry.version,
              sourceIdHash: sourceIdHash(entry.sourceId),
            }))
            .sort((left, right) => left.entryId.localeCompare(right.entryId)),
          deletedCount: targets.length,
          sourceControls,
          identityControls,
          deletedFingerprints,
        },
      };
    };
    return input.inTransaction === true ? applyForget() : store.transaction(applyForget);
  }

  /* 用户明确“这件事只让你记得”：保留选中角色当前持有内容，清除其他持有者
     同一事实身份的正文与索引，并以无正文控制阻止旧来源重学、历史转告与再次分享。
     保留者只递增版本使在途操作失效，不改动来源与讲述链；因此原本只是听说的
     记忆在原始持有者被清除后，仍能说明最初来源和直接讲述者。 */
  function keepExclusive(input = {}) {
    const characterId = characterIdOf(input.characterId);
    const nowMs = resolveNow(input.nowMs);
    const applyKeepExclusive = () => {
      if (input.entryId === undefined) {
        throw new MemoryError("INVALID_INPUT", "必须指定选中的记忆。");
      }
      const { entry: held } = factForSelectedChange(input, characterId);
      if (!held) {
        throw new MemoryError("FACT_NOT_HELD", "当前角色没有该事实。");
      }
      const identityId = identityOfEntry(held, nowMs);
      const hash = factKeyHash(held.factKey);
      const identityEntries = store.listEntriesByIdentity(identityId);
      const others = identityEntries.filter((entry) => entry.characterId !== characterId);
      const retainedEntries = identityEntries.filter(
        (entry) => entry.characterId === characterId,
      );

      // 已只剩保留者且禁分享已生效：重复确认幂等，不制造新版本或新控制。
      if (others.length === 0 && isShareRestricted(held)) {
        return {
          factKeyHash: hash,
          retainedEntryId: held.id,
          retainedEntryIds: retainedEntries.map((entry) => entry.id).sort(),
          retainedCharacterId: characterId,
          version: held.version,
          cleared: 0,
          clearedCharacters: [],
          alreadyExclusive: true,
          blockedSharing: true,
          contextVersions: {},
        };
      }

      /* 临时理解按 T 覆盖本人全部 L：逐条递增版本；若 root current 也递增，
         同事务重写引用它的 originCurrentVersion，避免保留后自身 copy 失效。
         其他 holder 的条目全删，root current 被删时保留者的 derived_from 清空，
         持久 derivation/parent 仍作为根证明。 */
      if (temporary.isTemporaryEntry(held)) {
        const deletedIds = new Set(others.map((entry) => entry.id));
        const root = retainedEntries.find((entry) => entry.derivedFromEntryId === null) ?? null;
        const rootVersion = root ? root.version + 1 : null;
        const updated = new Map();
        for (const entry of retainedEntries) {
          const parsed = parseTemporarySource(entry.sourceId);
          const next = { ...entry, version: entry.version + 1, updatedAt: nowMs };
          if (parsed && parsed.kind !== "direct" &&
            parsed.originCurrentEntryId === root?.id) {
            const build = parsed.kind === "edit"
              ? editedTemporarySource
              : copiedTemporarySource;
            next.sourceId = build({
              originLongEntryId: parsed.originLongEntryId,
              originLongVersion: parsed.originLongVersion,
              originCurrentEntryId: parsed.originCurrentEntryId,
              originCurrentVersion: rootVersion,
              holderLongEntryId: parsed.holderLongEntryId,
              holderLongVersion: parsed.holderLongVersion,
              messageSourceId: parsed.messageSourceId,
            });
          }
          if (entry.derivedFromEntryId !== null && deletedIds.has(entry.derivedFromEntryId)) {
            store.updateTemporaryOrigin(entry.id, entry.originCharacterId, null);
            next.derivedFromEntryId = null;
          }
          store.updateEntry(next, tokenizeForIndex(next.body));
          if (entry.derivationSourceId !== null) {
            // derived_from 列可因父删除清空，但持久 derivation parent 仍用于根证明。
            store.setDerivation({
              ...next,
              derivedFromEntryId: entry.derivedFromEntryId,
              narratorCharacterId: entry.narratorCharacterId,
              originCharacterId: entry.originCharacterId,
            });
          }
          updated.set(entry.id, next);
        }
        for (const entry of others) {
          store.deleteEntry(entry.id);
          store.addSourceControl(entry.characterId, sourceIdHash(entry.sourceId), nowMs);
          store.addForgetIdentityControl(entry.characterId, identityId, nowMs);
          store.addDeletedFactFingerprint(
            entry.characterId,
            deletedFingerprintOf(entry),
            nowMs,
          );
        }
        store.addShareIdentityControl(identityId, nowMs);
        const kept = updated.get(held.id) ?? held;
        const affected = new Set([characterId, ...others.map((entry) => entry.characterId)]);
        const contextVersions = {};
        for (const holder of [...affected].sort()) {
          contextVersions[holder] = store.bumpContextVersion(holder, nowMs);
        }
        return {
          factKeyHash: hash,
          retainedEntryId: kept.id,
          retainedEntryIds: [...updated.keys()].sort(),
          retainedCharacterId: characterId,
          version: kept.version,
          cleared: others.length,
          clearedCharacters: [...new Set(others.map((entry) => entry.characterId))].sort(),
          alreadyExclusive: false,
          blockedSharing: true,
          contextVersions,
        };
      }

      for (const entry of others) {
        store.deleteEntry(entry.id);
        store.addSourceControl(entry.characterId, sourceIdHash(entry.sourceId), nowMs);
        store.addForgetIdentityControl(entry.characterId, identityId, nowMs);
        store.addDeletedFactFingerprint(
          entry.characterId,
          deletedFingerprintOf(entry),
          nowMs,
        );
      }
      const retained = { ...held, version: held.version + 1, updatedAt: nowMs };
      store.updateEntry(retained, tokenizeForIndex(retained.body));
      store.addShareIdentityControl(identityId, nowMs);

      const affected = new Set([characterId, ...others.map((entry) => entry.characterId)]);
      const contextVersions = {};
      for (const holder of [...affected].sort()) {
        contextVersions[holder] = store.bumpContextVersion(holder, nowMs);
      }
      return {
        factKeyHash: hash,
        retainedEntryId: retained.id,
        retainedCharacterId: characterId,
        version: retained.version,
        cleared: others.length,
        clearedCharacters: [...new Set(others.map((entry) => entry.characterId))].sort(),
        alreadyExclusive: false,
        blockedSharing: true,
        contextVersions,
      };
    };
    // 聊天保留独属要与回复、请求完成共用同一事务；调用方负责提交/回滚。
    return input.inTransaction === true
      ? applyKeepExclusive()
      : store.transaction(applyKeepExclusive);
  }

  /* 全局开关只保存一个布尔值，缺省视为开启；读取不触发任何分享或模型调用。 */
  function isAutoShareEnabled() {
    return store.getState(AUTO_SHARE_STATE_KEY) !== "false";
  }

  function setAutoShareEnabled(input = {}) {
    if (!input || typeof input.enabled !== "boolean") {
      throw new MemoryError("INVALID_INPUT", "自动分享开关必须是布尔值。");
    }
    store.setState(AUTO_SHARE_STATE_KEY, input.enabled ? "true" : "false");
    return { enabled: input.enabled };
  }

  /* 分享/转告共用条目构造：长期副本保持既有来源；临时理解复用 T、到期与
     真实 origin，并写 derivation/link，收件人只有明确同锚长期时才挂 holder
     long。父条目删除后，临时副本仍可凭 derivation 与 origin 消息验证。 */
  function insertPropagatedEntry({
    original, toCharacterId, fromCharacterId, identityId, relation, nowMs, shareSourceId = null,
  }) {
    const temporaryCopy = temporary.propagationSource({
      entry: original,
      holderCharacterId: toCharacterId,
      nowMs,
    });
    const entry = {
      id: newEntryId(),
      characterId: toCharacterId,
      factKey: original.factKey,
      factIdentityId: identityId,
      originCharacterId: original.originCharacterId,
      derivedFromEntryId: original.id,
      narratorCharacterId: fromCharacterId,
      kind: original.kind,
      body: original.body,
      trust: original.trust,
      sourceKind: original.sourceKind,
      importance: original.importance,
      expiresAt: temporaryCopy?.expiresAt ?? original.expiresAt,
      sourceId: temporaryCopy?.sourceId ?? shareSourceId ?? `${relation}:${original.id}:${toCharacterId}`,
      sourceVersion: 1,
      version: 1,
      createdAt: nowMs,
      updatedAt: nowMs,
    };
    store.insertEntry(entry, tokenizeForIndex(entry.body));
    if (temporaryCopy) {
      store.setDerivation(entry);
      store.insertTemporaryLink({
        tempIdentityId: temporaryCopy.temporaryIdentityId,
        longIdentityId: temporaryCopy.longIdentityId,
        holderCharacterId: toCharacterId,
        expiresAt: temporaryCopy.expiresAt,
      });
      store.insertTemporaryEntryLink({
        entryId: entry.id,
        tempIdentityId: temporaryCopy.temporaryIdentityId,
        holderCharacterId: toCharacterId,
        expiresAt: temporaryCopy.expiresAt,
        longIdentityId: temporaryCopy.longIdentityId,
        rootIdentityId: temporaryCopy.rootIdentityId,
      });
    }
    store.insertRelationEdge(original.id, entry.id, relation, nowMs);
    return entry;
  }

  /* 指定分享只复制明确列出的条目，保留原讲述者与派生链；
     B 再转发 A 的派生内容会被 origin/derived 检查拒绝。用户明确转告属于 S03b
     的独立业务入口，不与这里的自动/派生分享权限混用。
     未显式传 sourceId 时，来源ID由这次明确的分享操作和条目ID组合生成，不从正文推断。
     S03i 起该入口代表自动/派生分享，必须先通过全局开关；relay 不受此开关影响。 */
  function share(input = {}) {
    const fromCharacterId = characterIdOf(input.fromCharacterId);
    const toCharacterId = characterIdOf(input.toCharacterId);
    const nowMs = resolveNow(input.nowMs);
    const sourceId = input.sourceId === undefined ? null : cleanText(input.sourceId, "来源ID", LIMITS.sourceId);
    if (!Array.isArray(input.entryIds) || input.entryIds.length === 0) {
      throw new MemoryError("INVALID_INPUT", "必须指定要分享的记忆。");
    }
    if (input.entryIds.length > LIMITS.shareEntries) {
      throw new MemoryError("INVALID_INPUT", "一次分享的条目过多。");
    }
    const entryIds = input.entryIds.map((id) => cleanText(id, "记忆ID", 200));
    if (new Set(entryIds).size !== entryIds.length) {
      throw new MemoryError("INVALID_INPUT", "分享条目不能重复。");
    }
    /* 全局开关必须和实际写入在同一事务内判定，避免读取与提交之间的状态窗口。
       默认仍由这里开启事务；聊天/主题活动等已有事务可传 inTransaction 复用。 */
    const applyShare = () => {
      if (!isAutoShareEnabled()) {
        throw new MemoryError("AUTO_SHARE_DISABLED", "角色之间的自动分享已关闭。");
      }
      // 接收者已排除的显式来源不能靠换 factKey 重新投递；普通 relay 仍按独立授权规则。
      if (sourceId !== null && store.hasSourceControl(toCharacterId, sourceIdHash(sourceId))) {
        throw new MemoryError("SHARE_BLOCKED", "接收者已排除该来源。");
      }
      const originals = entryIds.map((id) => {
        const entry = store.getEntryById(id);
        if (!entry || entry.characterId !== fromCharacterId) {
          throw new MemoryError("SHARE_NOT_ALLOWED", "只能分享自己持有的记忆。");
        }
        if (entry.originCharacterId !== fromCharacterId || store.isDerivedEntry(entry.id)) {
          throw new MemoryError("SHARE_NOT_ALLOWED", "派生记忆不能再次分享。");
        }
        if (entry.expiresAt !== null && entry.expiresAt <= nowMs) {
          throw new MemoryError("SHARE_NOT_ALLOWED", "已到期的记忆不能分享。");
        }
        const identityId = identityOfEntry(entry, nowMs);
        if (isShareRestricted(entry)) {
          throw new MemoryError("SHARE_BLOCKED", "用户已禁止分享该事实。");
        }
        if (
          recipientForgetBlocked(
            toCharacterId,
            relatedIdentityIds(entry),
            deletedFingerprintOf(entry),
            entry.factKey,
          )
        ) {
          throw new MemoryError("SHARE_BLOCKED", "接收者已明确忘记该事实。");
        }
        return { entry, identityId };
      });

      const shared = [];
      let created = 0;
      for (const { entry: original, identityId } of originals) {
        const held = recipientHeldEntry(toCharacterId, original.factKey, identityId);
        if (held) {
          // 同键不同身份不能冒充已持有；同身份但内容不一致也不静默覆盖。
          if (
            !held.sameIdentity ||
            (held.entry.expiresAt !== null && held.entry.expiresAt <= nowMs) ||
            !sameBody(held.entry.body, original.body)
          ) {
            throw new MemoryError("SHARE_CONFLICT", "接收者已有同一事实的不同内容，未覆盖。");
          }
          shared.push({ sourceEntryId: original.id, entryId: held.entry.id, alreadyHeld: true });
          continue;
        }
        const entry = insertPropagatedEntry({
          original,
          toCharacterId,
          fromCharacterId,
          identityId,
          relation: "share",
          nowMs,
          shareSourceId: sourceId,
        });
        shared.push({ sourceEntryId: original.id, entryId: entry.id, alreadyHeld: false });
        created += 1;
      }

      const contextVersion = created > 0 ? store.bumpContextVersion(toCharacterId, nowMs) : null;
      return { toCharacterId, shared, contextVersion };
    };
    return input.inTransaction === true ? applyShare() : store.transaction(applyShare);
  }

  /* 接收者是否已持有该事实身份：同键优先用于识别冲突，再看跨键的同一
     身份副本，避免重复写入。 */
  function recipientHeldEntry(toCharacterId, factKey, identityId) {
    const sameKey = store.getEntryByFact(toCharacterId, factKey);
    if (sameKey) {
      return {
        entry: sameKey,
        sameIdentity: sameKey.factIdentityId === identityId,
      };
    }
    const sameIdentity = store.getEntryByCharacterIdentity(toCharacterId, identityId);
    return sameIdentity ? { entry: sameIdentity, sameIdentity: true } : null;
  }

  /* 用户明确转告：调用方逐条给出当前持有条目、版本和单一已结识接收者。
     与 share 的区别是允许把听来的事实继续明确转告，但仍保留最初来源、
     直接讲述者与直接父条目；不把听说写成亲历。接收者已有同一有效内容时
     幂等，内容不同时如实报告冲突而不是用旧转述覆盖。普通转告不能解除事实禁分享。 */
  function relay(input = {}) {
    const fromCharacterId = characterIdOf(input.fromCharacterId);
    const toCharacterId = characterIdOf(input.toCharacterId);
    const nowMs = resolveNow(input.nowMs);
    if (fromCharacterId === toCharacterId) {
      throw new MemoryError("INVALID_INPUT", "不能转告给自己。");
    }
    if (!Array.isArray(input.entries) || input.entries.length === 0) {
      throw new MemoryError("INVALID_INPUT", "必须指定要转告的记忆。");
    }
    if (input.entries.length > LIMITS.shareEntries) {
      throw new MemoryError("INVALID_INPUT", "一次转告的条目过多。");
    }
    const selections = input.entries.map((item) => {
      if (!item || typeof item !== "object") {
        throw new MemoryError("INVALID_INPUT", "转告条目必须包含记忆ID与版本。");
      }
      return {
        entryId: cleanText(item.entryId, "记忆ID", 200),
        expectedVersion: expectedVersionOf(item.expectedVersion),
      };
    });
    if (new Set(selections.map((item) => item.entryId)).size !== selections.length) {
      throw new MemoryError("INVALID_INPUT", "转告条目不能重复。");
    }

    const applyRelay = () => {
      const originals = selections.map(({ entryId, expectedVersion }) => {
        const entry = store.getEntryById(entryId);
        if (!entry || entry.characterId !== fromCharacterId) {
          throw new MemoryError("SHARE_NOT_ALLOWED", "只能转告自己持有的记忆。");
        }
        if (entry.version !== expectedVersion) {
          throw new MemoryError("MEMORY_CHANGED", "记忆已更新，请重新选择。");
        }
        if (entry.expiresAt !== null && entry.expiresAt <= nowMs) {
          throw new MemoryError("SHARE_NOT_ALLOWED", "已到期的记忆不能转告。");
        }
        const identityId = identityOfEntry(entry, nowMs);
        if (isShareRestricted(entry)) {
          throw new MemoryError("SHARE_BLOCKED", "用户已禁止分享该事实。");
        }
        if (
          recipientForgetBlocked(
            toCharacterId,
            relatedIdentityIds(entry),
            deletedFingerprintOf(entry),
            entry.factKey,
          )
        ) {
          throw new MemoryError("SHARE_BLOCKED", "接收者已明确忘记该事实。");
        }
        return { entry, identityId };
      });

      const shared = [];
      let created = 0;
      for (const { entry: original, identityId } of originals) {
        const held = recipientHeldEntry(toCharacterId, original.factKey, identityId);
        if (held) {
          if (!held.sameIdentity) {
            throw new MemoryError("SHARE_CONFLICT", "接收者已有同事实的不同内容，未覆盖。");
          }
          const expired = held.entry.expiresAt !== null && held.entry.expiresAt <= nowMs;
          if (expired) {
            throw new MemoryError("SHARE_CONFLICT", "接收者已有同事实的失效记忆，未覆盖。");
          }
          if (!sameBody(held.entry.body, original.body)) {
            throw new MemoryError("SHARE_CONFLICT", "接收者已有不同的同事实内容，未覆盖。");
          }
          shared.push({ sourceEntryId: original.id, entryId: held.entry.id, alreadyHeld: true });
          continue;
        }
        const entry = insertPropagatedEntry({
          original,
          toCharacterId,
          fromCharacterId,
          identityId,
          relation: "relay",
          nowMs,
        });
        shared.push({ sourceEntryId: original.id, entryId: entry.id, alreadyHeld: false });
        created += 1;
      }

      const contextVersion = created > 0 ? store.bumpContextVersion(toCharacterId, nowMs) : null;
      return { toCharacterId, shared, contextVersion };
    };
    // 聊天转告与回复、请求完成共用外部事务；调用方负责提交/回滚。
    return input.inTransaction === true ? applyRelay() : store.transaction(applyRelay);
  }

  /* 新增或解除事实禁分享都要求明确选中当前持有条目并核对版本；只有独立调用
     allowSharing 才能解除，纠正、删除和普通转告都不会顺手清除限制。
     限制按事实身份跨持有者生效；旧 factKey 摘要行只用于兼容与定位，
     结果只返回已有持有者，不透露正文。 */
  function selectedHeldEntry(input, characterId) {
    if (input.entryId === undefined) {
      throw new MemoryError("INVALID_INPUT", "必须指定选中的记忆。");
    }
    const { entry } = factForSelectedChange(input, characterId);
    if (!entry) {
      throw new MemoryError("FACT_NOT_HELD", "当前角色没有该事实。");
    }
    return entry;
  }

  function restrictSharing(input = {}) {
    const characterId = characterIdOf(input.characterId);
    const nowMs = resolveNow(input.nowMs);
    const applyRestriction = () => {
      const held = selectedHeldEntry(input, characterId);
      const identityId = identityOfEntry(held, nowMs);
      const hash = factKeyHash(held.factKey);
      const alreadyRestricted = isShareRestricted(held);
      store.addShareIdentityControl(identityId, nowMs);
      return { factKeyHash: hash, alreadyRestricted, holders: holdersOfIdentity(identityId) };
    };
    return input.inTransaction === true
      ? applyRestriction()
      : store.transaction(applyRestriction);
  }

  function allowSharing(input = {}) {
    const characterId = characterIdOf(input.characterId);
    const nowMs = resolveNow(input.nowMs);
    return store.transaction(() => {
      const held = selectedHeldEntry(input, characterId);
      const identityId = identityOfEntry(held, nowMs);
      const hash = factKeyHash(held.factKey);
      // 迁移拆分出的身份只解除自己的 share 控制；不删除其他组件控制。
      if (store.isSplitIdentity(identityId)) {
        const lifted = store.removeShareIdentityControl(identityId);
        return { factKeyHash: hash, lifted, holders: holdersOfIdentity(identityId) };
      }
      // 歧义指纹关联多个受限身份时不能挑一个解除；保守保持原限制。
      const relatedRestricted = relatedIdentityIds(held).filter((id) =>
        store.hasShareIdentityControl(id),
      );
      if (relatedRestricted.length > 1) {
        return { factKeyHash: hash, lifted: false, holders: holdersOfIdentity(identityId) };
      }
      const lifted = store.removeShareIdentityControl(identityId);
      return {
        factKeyHash: hash,
        lifted,
        holders: holdersOfIdentity(identityId),
      };
    });
  }

  /* S03l-b 事实等价决定的内部执行器：只供可信应用内核验层在确认等价后调用，
     不绑定 IPC/HTTP/模型输出，也不负责判断正文是否等价。关联不新增持有者、
     不覆盖正文/factKey/来源/派生记录，只把两组既有身份并入确定的 canonical
     身份。两个身份 id 的排序在选择前固定，重复执行得到同一结果。 */
  function associateFacts(input = {}) {
    const leftSelection = associationSelection(input.left, "left");
    const rightSelection = associationSelection(input.right, "right");
    const nowMs = resolveNow(input.nowMs);
    if (leftSelection.entryId === rightSelection.entryId) {
      throw new MemoryError("INVALID_INPUT", "不能把一条记忆与自身关联。");
    }

    const applyAssociation = () => {
      const left = store.getEntryById(leftSelection.entryId);
      if (!left) {
        throw new MemoryError("ENTRY_NOT_FOUND", "左侧记忆不存在。");
      }
      const right = store.getEntryById(rightSelection.entryId);
      if (!right) {
        throw new MemoryError("ENTRY_NOT_FOUND", "右侧记忆不存在。");
      }
      if (
        left.version !== leftSelection.expectedVersion ||
        right.version !== rightSelection.expectedVersion
      ) {
        throw new MemoryError("MEMORY_CHANGED", "记忆已更新，请重新确认。");
      }

      const leftIdentityId = identityOfEntry(left, nowMs);
      const rightIdentityId = identityOfEntry(right, nowMs);
      const [edgeFrom, edgeTo] = left.id < right.id ? [left.id, right.id] : [right.id, left.id];
      // 已同一身份仍需通过整组核验资格；不合格条目不能成为新的核实证据。
      if (leftIdentityId === rightIdentityId) {
        const entries = store.listEntriesByIdentity(leftIdentityId);
        assertAssociableEntries(entries, nowMs);
        if (store.hasForgetIdentityReference(leftIdentityId)) {
          throw new MemoryError(
            "ASSOCIATION_FORGET_RESTRICTED",
            "待关联记忆上存在删除限制，不能关联。",
          );
        }
        store.insertRelationEdge(edgeFrom, edgeTo, "explicit", nowMs);
        return {
          associated: false,
          alreadyAssociated: true,
          identityId: leftIdentityId,
          mergedIdentityId: null,
          affectedEntries: 0,
          affectedCharacters: [],
          contextVersions: {},
        };
      }

      const entries = [
        ...store.listEntriesByIdentity(leftIdentityId),
        ...store.listEntriesByIdentity(rightIdentityId),
      ];
      // 整组有效性必须在任何关联写入前核对；第三持有者的来源限制同样生效。
      assertAssociableEntries(entries, nowMs);
      // 身份级删除限制可能由已不持有条目的角色留下，保守拒绝整体关联。
      if (
        store.hasForgetIdentityReference(leftIdentityId) ||
        store.hasForgetIdentityReference(rightIdentityId)
      ) {
        throw new MemoryError(
          "ASSOCIATION_FORGET_RESTRICTED",
          "待关联记忆上存在删除限制，不能关联。",
        );
      }

      const canonicalIdentityId =
        leftIdentityId < rightIdentityId ? leftIdentityId : rightIdentityId;
      const mergedIdentityId =
        canonicalIdentityId === leftIdentityId ? rightIdentityId : leftIdentityId;
      for (const entry of entries) {
        store.reassignEntryIdentity(entry.id, canonicalIdentityId, nowMs);
      }
      store.mergeFactIdentities(mergedIdentityId, canonicalIdentityId);
      store.insertRelationEdge(edgeFrom, edgeTo, "explicit", nowMs);

      const affectedCharacters = [
        ...new Set(entries.map((entry) => entry.characterId)),
      ].sort();
      const contextVersions = {};
      for (const characterId of affectedCharacters) {
        contextVersions[characterId] = store.bumpContextVersion(characterId, nowMs);
      }
      return {
        associated: true,
        alreadyAssociated: false,
        identityId: canonicalIdentityId,
        mergedIdentityId,
        affectedEntries: entries.length,
        affectedCharacters,
        contextVersions,
      };
    };
    // 身份、别名、禁分享限制与版本递增必须同一事务；任何失败整体回滚。
    return input.inTransaction === true ? applyAssociation() : store.transaction(applyAssociation);
  }

  /* 阶段 2 只读窄接口：以持有角色定位条目，供核验层重读版本与来源。 */
  function getHeldEntry({ characterId: rawCharacterId, entryId: rawEntryId } = {}) {
    const characterId = characterIdOf(rawCharacterId);
    const entryId = cleanText(rawEntryId, "记忆ID", 200);
    const entry = store.getEntryById(entryId);
    return entry && entry.characterId === characterId ? entry : null;
  }

  /* 窄只读：阶段 2 只为已结识角色写 current；未知残留行不进入候选相关集合。 */
  function isKnownCharacter(characterIdInput) {
    const characterId = cleanText(characterIdInput, "角色ID", 200);
    return store.isKnownCharacter(characterId);
  }

  /* 只读身份成员，供候选去重与阶段 2 成员集合重核；不暴露给 renderer。 */
  function listIdentityEntries(identityIdValue) {
    const identityId = cleanText(identityIdValue, "身份ID", 200);
    return store.listEntriesByIdentity(identityId);
  }

  /* 2c-2b 阶段 0 窄接口：临时 current 的 own L 有效长期锚；无锚 relay 返回 null。 */
  function getTemporaryTarget({ characterId: rawCharacterId, entryId: rawEntryId, nowMs } = {}) {
    const characterId = characterIdOf(rawCharacterId);
    const entryId = cleanText(rawEntryId, "记忆ID", 200);
    const at = resolveNow(nowMs);
    const entry = store.getEntryById(entryId);
    if (!entry || entry.characterId !== characterId || !temporary.isTemporaryEntry(entry)) {
      return null;
    }
    const link = temporary.linkOfEntry(entry);
    if (!link) {
      return null;
    }
    const anchor = temporary.holderLong(characterId, link.ownLongIdentityId, at);
    return {
      temporaryIdentityId: entry.factIdentityId,
      expiresAt: entry.expiresAt,
      ownLongIdentityId: link.ownLongIdentityId,
      rootIdentityId: link.rootIdentityId,
      anchorEntryId: anchor?.id ?? null,
      anchorIdentityId: anchor?.factIdentityId ?? null,
      anchorVersion: anchor?.version ?? null,
    };
  }

  /* 2c-2b 阶段 2 窄接口：只按 approved identity 写 T 内 current，不合并长期。 */
  function applyConfirmedTemporaryCorrectionToHolders(input = {}) {
    const temporaryIdentityId = cleanText(input.temporaryIdentityId, "临时身份ID", 200);
    const originEntryId = cleanText(input.originEntryId, "根条目ID", 200);
    const originVersion = input.originVersion;
    const expiresAt = input.expiresAt;
    const initiatorCharacterId = characterIdOf(input.initiatorCharacterId);
    if (!Number.isSafeInteger(originVersion) || originVersion < 1 ||
      !Number.isSafeInteger(expiresAt) ||
      !Array.isArray(input.approved)) {
      throw new MemoryError("INVALID_INPUT", "阶段 2 参数无效。");
    }
    const nowMs = resolveNow(input.nowMs);
    const approved = input.approved.map((candidate) => ({
      identityId: cleanText(candidate?.identityId, "身份ID", 200),
    }));
    const apply = () => temporary.applyApprovedCorrectionToHolders({
      temporaryIdentityId,
      expiresAt,
      originEntryId,
      originVersion,
      initiatorCharacterId,
      approved,
      nowMs,
    });
    return input.inTransaction === true ? apply() : store.transaction(apply);
  }

  /* S03m 2b 只读 proof 核对：只读控制与身份/版本，不读正文。forget 证明已删
     条目不在、目标 identity 现存成员等于应保留集合、控制键仍在，且发起角色
     contextVersion 未变；任何新身份重学或后续记忆变动都会使旧 proof 失效。 */
  function verifyTemporaryProof(input) {
    const proof = input.controlProof;
    if (!proof || proof.version !== 3 || proof.mode !== "temporary") {
      return false;
    }
    const temporaryIdentityId = cleanText(proof.temporaryIdentityId, "临时身份ID", 200);
    const initiatorCharacterId = cleanText(proof.initiatorCharacterId, "角色ID", 200);
    const nowMs = Number.isSafeInteger(input.nowMs) ? input.nowMs : Date.now();
    if (!Number.isSafeInteger(proof.expiresAt) ||
      proof.expiresAt <= nowMs ||
      !Number.isSafeInteger(proof.originVersion) || proof.originVersion < 1) {
      return false;
    }
    if (!Array.isArray(proof.candidates)) {
      return false;
    }
    const relatedHolders = new Set();
    for (const expected of proof.entries ?? []) {
      if (typeof expected?.holder === "string") {
        relatedHolders.add(expected.holder);
      }
    }
    for (const candidate of proof.candidates) {
      if (!candidate || typeof candidate.characterId !== "string" ||
        !candidate.identityId || !candidate.entryId ||
        !Number.isInteger(candidate.version) ||
        typeof candidate.sourceIdHash !== "string" ||
        !Array.isArray(candidate.members) ||
        candidate.members.some((member) =>
          !member || typeof member.holder !== "string" ||
          !member.entryId || !Number.isInteger(member.version) ||
          typeof member.sourceIdHash !== "string")) {
        return false;
      }
      relatedHolders.add(candidate.characterId);
      for (const member of candidate.members) {
        relatedHolders.add(member.holder);
      }
    }
    const contextKeys = Object.keys(proof.contextVersions ?? {}).sort();
    const controlKeys = Object.keys(proof.sourceControls ?? {}).sort();
    const expectedHolders = [...relatedHolders].sort();
    if (JSON.stringify(contextKeys) !== JSON.stringify(expectedHolders) ||
      JSON.stringify(controlKeys) !== JSON.stringify(expectedHolders)) {
      return false;
    }
    for (const [holder, version] of Object.entries(proof.contextVersions ?? {})) {
      const characterId = cleanText(holder, "角色ID", 200);
      if (!Number.isInteger(version) || store.getContextVersion(characterId) !== version) {
        return false;
      }
    }
    for (const [holder, hashes] of Object.entries(proof.sourceControls ?? {})) {
      const characterId = cleanText(holder, "角色ID", 200);
      if (!Array.isArray(hashes)) {
        return false;
      }
      const current = store.listSourceControls(characterId);
      const expected = new Set(hashes);
      if (current.length !== expected.size || current.some((hash) => !expected.has(hash))) {
        return false;
      }
    }
    const root = store.getEntryById(cleanText(proof.originEntryId, "根条目ID", 200));
    if (!root ||
      root.factIdentityId !== temporaryIdentityId ||
      root.expiresAt !== proof.expiresAt ||
      root.version !== proof.originVersion ||
      root.originCharacterId !== initiatorCharacterId) {
      return false;
    }
    const rootLink = store.getTemporaryEntryLink(root.id);
    if (!rootLink ||
      rootLink.tempIdentityId !== temporaryIdentityId ||
      rootLink.holderCharacterId !== initiatorCharacterId ||
      rootLink.expiresAt !== proof.expiresAt ||
      rootLink.longIdentityId !== proof.rootIdentityId ||
      rootLink.rootIdentityId !== proof.rootIdentityId) {
      return false;
    }
    if (!Array.isArray(proof.entries)) {
      return false;
    }
    const currentEntries = store.listEntriesByIdentity(temporaryIdentityId)
      .filter((entry) =>
        temporary.isTemporaryEntry(entry) &&
        entry.expiresAt === proof.expiresAt);
    if (currentEntries.length !== proof.entries.length) {
      return false;
    }
    const byId = new Map(currentEntries.map((entry) => [entry.id, entry]));
    const seen = new Set();
    for (const expected of proof.entries) {
      const entry = byId.get(cleanText(expected.entryId, "记忆ID", 200));
      const link = entry ? store.getTemporaryEntryLink(entry.id) : null;
      if (!entry || seen.has(entry.id) ||
        entry.characterId !== expected.holder ||
        entry.version !== expected.version ||
        sourceIdHash(entry.sourceId) !== expected.sourceIdHash ||
        !link ||
        link.tempIdentityId !== temporaryIdentityId ||
        link.holderCharacterId !== expected.holder ||
        link.expiresAt !== proof.expiresAt ||
        link.longIdentityId !== expected.longIdentityId ||
        link.rootIdentityId !== proof.rootIdentityId ||
        !temporary.temporaryInfo(entry, nowMs)) {
        return false;
      }
      seen.add(entry.id);
    }
    return true;
  }

  function verifyOperationProof(input = {}) {
    try {
      if (input.action === "temporary") {
        return verifyTemporaryProof(input);
      }
      if (input.action !== "forget") {
        return false;
      }
      const identityId = cleanText(input.identityId, "身份ID", 200);
      const initiatorCharacterId = cleanText(input.initiatorCharacterId, "角色ID", 200);
      const proof = input.controlProof;
      if (!proof || typeof proof !== "object" ||
        !Number.isInteger(input.expectedContextVersion)) {
        return false;
      }
      if (store.getContextVersion(initiatorCharacterId) !== input.expectedContextVersion) {
        return false;
      }
      if (!Array.isArray(proof.deletedEntryIds) || !Array.isArray(proof.retainedEntries)) {
        return false;
      }
      for (const entryId of proof.deletedEntryIds) {
        if (store.getEntryById(cleanText(entryId, "记忆ID", 200))) {
          return false;
        }
      }
      const current = store.listEntriesByIdentity(identityId);
      const retainedIds = proof.retainedEntries.map((entry) => entry.entryId);
      if (current.length !== retainedIds.length ||
        new Set(retainedIds).size !== retainedIds.length) {
        return false;
      }
      const currentById = new Map(current.map((entry) => [entry.id, entry]));
      for (const expected of proof.retainedEntries) {
        const entry = currentById.get(expected.entryId);
        if (!entry ||
          entry.characterId !== expected.characterId ||
          entry.version !== expected.version ||
          sourceIdHash(entry.sourceId) !== expected.sourceIdHash) {
          return false;
        }
      }
      for (const [holder, value] of Object.entries(proof.identityControls ?? {})) {
        if (value !== identityId || !store.hasForgetIdentityControl(holder, identityId)) {
          return false;
        }
      }
      for (const [holder, hashes] of Object.entries(proof.sourceControls ?? {})) {
        if (!Array.isArray(hashes)) {
          return false;
        }
        for (const hash of hashes) {
          if (!store.hasSourceControl(holder, hash)) {
            return false;
          }
        }
      }
      for (const [holder, fingerprints] of Object.entries(proof.deletedFingerprints ?? {})) {
        if (!Array.isArray(fingerprints)) {
          return false;
        }
        for (const fingerprint of fingerprints) {
          if (!store.hasDeletedFactFingerprint(holder, fingerprint)) {
            return false;
          }
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  /* S03m 阶段 2 窄接口：只更新已核验候选 identity 的成员，不再次 correct
     锚、不接收调用者正文/来源。事务内重读锚与成员，使用当前版本。 */
  function applyConfirmedCorrectionToIdentityMembers(input = {}) {
    const anchorEntryId = cleanText(input.anchorEntryId, "记忆ID", 200);
    if (!Array.isArray(input.memberEntryIds) || input.memberEntryIds.length === 0 ||
      input.memberEntryIds.length > 32) {
      throw new MemoryError("INVALID_INPUT", "候选成员列表无效。");
    }
    const memberEntryIds = [...new Set(input.memberEntryIds.map((value) =>
      cleanText(value, "记忆ID", 200)))].sort();
    const nowMs = resolveNow(input.nowMs);

    const applyCorrection = () => {
      const anchor = store.getEntryById(anchorEntryId);
      if (!anchor) {
        throw new MemoryError("ENTRY_NOT_FOUND", "纠正锚不存在。");
      }
      const identityId = identityOfEntry(anchor, nowMs);
      const members = memberEntryIds.map((entryId) => store.getEntryById(entryId));
      if (members.some((entry) => !entry)) {
        throw new MemoryError("ENTRY_NOT_FOUND", "候选成员不存在。");
      }
      if (members.some((entry) =>
        entry.id === anchor.id ||
        entry.factIdentityId !== identityId ||
        (entry.expiresAt !== null && entry.expiresAt <= nowMs) ||
        (entry.sourceKind ?? "user") !== "user" ||
        entry.trust !== "stated")) {
        throw new MemoryError("MEMORY_CHANGED", "候选成员已变化，不能继续更新。");
      }

      const affected = new Set();
      const finalVersions = {};
      for (const entry of members) {
        const nextSourceId = `corrected:${entry.id}:${entry.version + 1}`;
        store.addSourceControl(entry.characterId, sourceIdHash(entry.sourceId), nowMs);
        const next = {
          ...entry,
          body: anchor.body,
          trust: anchor.trust,
          sourceKind: "user",
          expiresAt: anchor.expiresAt,
          sourceId: nextSourceId,
          sourceVersion: 1,
          version: entry.version + 1,
          updatedAt: nowMs,
        };
        store.updateEntry(next, tokenizeForIndex(anchor.body));
        affected.add(entry.characterId);
        finalVersions[entry.id] = next.version;
      }

      const correctedFingerprint = identityFingerprint({
        kind: anchor.kind,
        trust: anchor.trust,
        sourceKind: "user",
        expiresAt: anchor.expiresAt,
        body: anchor.body,
      });
      if (correctedFingerprint) {
        store.registerAlias(correctedFingerprint, identityId, nowMs);
      }
      const contextVersions = {};
      for (const characterId of affected) {
        contextVersions[characterId] = store.bumpContextVersion(characterId, nowMs);
      }
      return {
        updated: members.length,
        affectedCharacters: [...affected].sort(),
        contextVersions,
        finalVersions,
      };
    };
    return input.inTransaction === true
      ? applyCorrection()
      : store.transaction(applyCorrection);
  }

  /* 供 S03b 组装上下文：核心设定、重要偏好与经历分段并有字符预算，
     不是把所有历史塞进提示词。最近聊天分段不在本切片。 */
  function buildContext(input = {}) {
    const characterId = characterIdOf(input.characterId);
    const nowMs = resolveNow(input.nowMs);
    const maxChars = limitOf(input.maxChars, LIMITS.contextMaxChars, LIMITS.contextMaxChars);
    const contextVersion = store.getContextVersion(characterId);
    const active = temporary.annotateContext(
      store.listActiveEntries(characterId, nowMs, LIMITS.contextEntries),
      nowMs,
    );

    const core = active.filter((entry) => entry.kind === "identity").slice(0, LIMITS.contextCore);
    const preferences = active
      .filter((entry) => entry.kind === "preference")
      .slice(0, LIMITS.contextPreferences);

    let experiences;
    if (typeof input.query === "string" && input.query.trim() !== "") {
      experiences = temporary.annotateContext(
        searchMemories({
          characterId,
          nowMs,
          query: input.query,
          limit: Math.min(LIMITS.contextQueryResults, RETRIEVAL_CONFIG.maxLimit),
        }),
        nowMs,
      )
        .filter((entry) => entry.kind === "experience")
        .slice(0, LIMITS.contextExperiences);
    } else {
      experiences = active
        .filter((entry) => entry.kind === "experience")
        .slice(0, LIMITS.contextExperiences);
    }

    const sections = { core: [], preferences: [], experiences: [] };
    let charCount = 0;
    let truncated = false;
    for (const [name, entries] of Object.entries({
      core,
      preferences,
      experiences,
    })) {
      for (const entry of entries) {
        if (charCount + entry.body.length > maxChars) {
          truncated = true;
          continue;
        }
        sections[name].push(entry);
        charCount += entry.body.length;
      }
    }
    return { characterId, contextVersion, sections, charCount, truncated };
  }

  function getContextVersion(characterIdInput) {
    const characterId = characterIdOf(characterIdInput);
    return store.getContextVersion(characterId);
  }

  function isContextCurrent(characterIdInput, version) {
    const characterId = characterIdOf(characterIdInput);
    if (!Number.isSafeInteger(version) || version < 0) {
      throw new MemoryError("INVALID_INPUT", "上下文版本无效。");
    }
    return store.getContextVersion(characterId) === version;
  }

  /* 返回被删除/纠正来源的 SHA-256 引用哈希，供 S03b 排除旧聊天片段；
     不返回来源正文，也不返回明文来源ID。调用方以同样方式哈希候选来源后比对。 */
  function listExcludedSources(characterIdInput) {
    const characterId = characterIdOf(characterIdInput);
    return store.listSourceControls(characterId);
  }

  function rebuildSearchIndex() {
    return store.transaction(() => {
      store.clearIndex();
      // 按稳定游标分批遍历全部条目；限制的是每批大小，不是总记录数。
      let indexed = 0;
      let cursor = null;
      for (;;) {
        const page = store.listEntriesPage(cursor, LIMITS.rebuildBatch);
        if (page.length === 0) {
          break;
        }
        for (const entry of page) {
          store.insertIndex(entry.id, tokenizeForIndex(entry.body));
        }
        indexed += page.length;
        if (page.length < LIMITS.rebuildBatch) {
          break;
        }
        cursor = page[page.length - 1];
      }
      return { indexed };
    });
  }

  return {
    remember,
    applyExtractionBatch,
    applyTemporaryUnderstanding,
    setTemporaryValidator,
    listMemories,
    listMemoriesPage,
    searchMemories,
    correct,
    forget,
    keepExclusive,
    share,
    relay,
    isAutoShareEnabled,
    setAutoShareEnabled,
    restrictSharing,
    allowSharing,
    associateFacts,
    getHeldEntry,
    isKnownCharacter,
    listIdentityEntries,
    getTemporaryTarget,
    applyConfirmedTemporaryCorrectionToHolders,
    verifyOperationProof,
    applyConfirmedCorrectionToIdentityMembers,
    buildContext,
    getContextVersion,
    isContextCurrent,
    listExcludedSources,
    rebuildSearchIndex,
  };
}

module.exports = { createMemoryService, MemoryError, LIMITS };
