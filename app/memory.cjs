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
  RETRIEVAL_CONFIG,
  RETRIEVAL_STRATEGIES,
  buildSearchQuery,
  shouldBroadenQuery,
  tokenizeForIndex,
} = require("./memory-retrieval.cjs");

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
      return { factKey: cleanText(input.factKey, "事实键", LIMITS.factKey), entryId: null };
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
    return { factKey: selected.factKey, entryId };
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

  function factKeyHash(factKey) {
    return crypto.createHash("sha256").update(factKey, "utf8").digest("hex");
  }

  function sourceIdHash(sourceId) {
    return crypto.createHash("sha256").update(sourceId, "utf8").digest("hex");
  }

  function newEntryId() {
    return crypto.randomUUID();
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

  /* 在已有事务内写入一条事实；调用方负责提交/回滚与上下文版本递增。 */
  function insertFactIfAllowed(fact) {
    // 旧来源重扫永远不是新许可；即使显式同意也不能用被控制过的旧来源回填。
    if (store.hasSourceControl(fact.characterId, sourceIdHash(fact.sourceId))) {
      return { created: false, blocked: "source", entry: null };
    }
    if (!fact.explicitConsent && store.hasForgetControl(fact.characterId, factKeyHash(fact.factKey))) {
      return { created: false, blocked: "forget", entry: null };
    }
    const existing = store.getEntryByFact(fact.characterId, fact.factKey);
    if (existing) {
      return { created: false, blocked: null, entry: existing };
    }

    const entry = {
      id: newEntryId(),
      characterId: fact.characterId,
      factKey: fact.factKey,
      originCharacterId: fact.originCharacterId,
      derivedFromEntryId: null,
      kind: fact.kind,
      body: fact.body,
      trust: fact.trust,
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
        sharingRestricted: store.hasShareControl(factKeyHash(entry.factKey)),
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

    if (strategy === "hybrid") {
      // 先保留严格分词基线；无结果时尝试有限概念扩展，最后才对自然提问宽召回。
      const strict = executeSearch(characterId, input.query, "segment", nowMs, limit, strategy);
      if (strict.length > 0) {
        return strict;
      }
      const expanded = executeSearch(characterId, input.query, "expanded", nowMs, limit, strategy);
      if (expanded.length > 0 || !shouldBroadenQuery(input.query)) {
        return expanded;
      }
      return executeSearch(characterId, input.query, "broad", nowMs, limit, strategy);
    }
    return executeSearch(characterId, input.query, strategy, nowMs, limit, strategy);
  }

  /* 只按显式 factKey 定位纠正；调用方没有事实键时不会凭相似度猜测。
     r2：任何当前已知持有者（含共享派生持有者）都可以发起纠正；同步更新同事实
     的原始与派生持有者，不给未知角色新增。派生身份用于来源可追溯，不限制管理。 */
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
      const { factKey } = factForSelectedChange(input, characterId);
      const held = store.getEntryByFact(characterId, factKey);
      if (!held) {
        throw new MemoryError("FACT_NOT_HELD", "当前角色没有该事实，不能发起纠正。");
      }
      const entries = store.listEntriesByFact(factKey);
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
        // 发起者使用本次明确用户来源；其他已知持有者使用传播来源，避免冒充用户亲口告诉。
        const nextSourceId =
          entry.characterId === characterId
            ? (sourceId ?? `correct:${entry.id}:${entry.version + 1}`)
            : `corrected:${entry.id}:${entry.version + 1}`;
        if (entry.sourceId !== nextSourceId) {
          store.addSourceControl(entry.characterId, sourceIdHash(entry.sourceId), nowMs);
        }
        const next = {
          ...entry,
          body,
          trust: trustProvided ? trust : entry.trust,
          importance: importanceProvided ? importance : entry.importance,
          expiresAt: expiresProvided ? expiresAt : entry.expiresAt,
          sourceId: nextSourceId,
          sourceVersion:
            entry.characterId === characterId && sourceVersion !== null
              ? sourceVersion
              : 1,
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

  /* scope='self' 只让当前角色忘记；默认 'all' 清除该事实键的已知持有者。
     任何当前已知持有者（含共享派生持有者）都可发起默认删除；未知角色不新增。
     控制表只保存事实键摘要与来源引用哈希，不保存被删正文。
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
      const { factKey } = factForSelectedChange(input, characterId);
      const hash = factKeyHash(factKey);
      const held = store.getEntryByFact(characterId, factKey);
      if (!held) {
        throw new MemoryError("FACT_NOT_HELD", "当前角色没有该事实，不能执行删除。");
      }

      const entries = store.listEntriesByFact(factKey);
      const targets = scope === "all" ? entries : entries.filter((entry) => entry.characterId === characterId);
      const affected = new Set();
      for (const entry of targets) {
        store.deleteEntry(entry.id);
        store.addSourceControl(entry.characterId, sourceIdHash(entry.sourceId), nowMs);
        store.addForgetControl(entry.characterId, hash, nowMs);
        affected.add(entry.characterId);
      }
      for (const sourceId of excludedSources) {
        store.addSourceControl(characterId, sourceIdHash(sourceId), nowMs);
      }

      const contextVersions = {};
      for (const holder of affected) {
        contextVersions[holder] = store.bumpContextVersion(holder, nowMs);
      }
      return {
        deleted: targets.length,
        affectedCharacters: [...affected].sort(),
        contextVersions,
      };
    };
    return input.inTransaction === true ? applyForget() : store.transaction(applyForget);
  }

  /* 用户明确“这件事只让你记得”：保留选中角色当前持有内容，清除其他持有者
     同一事实键的正文与索引，并以无正文控制阻止旧来源重学、历史转告与再次分享。
     保留者只递增版本使在途操作失效，不改动来源与讲述链；因此原本只是听说的
     记忆在原始持有者被清除后，仍能说明最初来源和直接讲述者。 */
  function keepExclusive(input = {}) {
    const characterId = characterIdOf(input.characterId);
    const nowMs = resolveNow(input.nowMs);
    const applyKeepExclusive = () => {
      if (input.entryId === undefined) {
        throw new MemoryError("INVALID_INPUT", "必须指定选中的记忆。");
      }
      const { factKey } = factForSelectedChange(input, characterId);
      const held = store.getEntryByFact(characterId, factKey);
      if (!held) {
        throw new MemoryError("FACT_NOT_HELD", "当前角色没有该事实。");
      }
      const hash = factKeyHash(factKey);
      const others = store
        .listEntriesByFact(factKey)
        .filter((entry) => entry.characterId !== characterId);

      // 已只剩保留者且禁分享已生效：重复确认幂等，不制造新版本或新控制。
      if (others.length === 0 && store.hasShareControl(hash)) {
        return {
          factKeyHash: hash,
          retainedEntryId: held.id,
          retainedCharacterId: characterId,
          version: held.version,
          cleared: 0,
          clearedCharacters: [],
          alreadyExclusive: true,
          blockedSharing: true,
          contextVersions: {},
        };
      }

      for (const entry of others) {
        store.deleteEntry(entry.id);
        store.addSourceControl(entry.characterId, sourceIdHash(entry.sourceId), nowMs);
        store.addForgetControl(entry.characterId, hash, nowMs);
      }
      const retained = { ...held, version: held.version + 1, updatedAt: nowMs };
      store.updateEntry(retained, tokenizeForIndex(retained.body));
      store.addShareControl(hash, nowMs);

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
    return store.transaction(applyKeepExclusive);
  }

  /* 指定分享只复制明确列出的条目，保留原讲述者与派生链；
     B 再转发 A 的派生内容会被 origin/derived 检查拒绝。用户明确转告属于 S03b
     的独立业务入口，不与这里的自动/派生分享权限混用。
     未显式传 sourceId 时，来源ID由这次明确的分享操作和条目ID组合生成，不从正文推断。 */
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

    return store.transaction(() => {
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
        const hash = factKeyHash(entry.factKey);
        if (store.hasShareControl(hash)) {
          throw new MemoryError("SHARE_BLOCKED", "用户已禁止分享该事实。");
        }
        if (store.hasForgetControl(toCharacterId, hash)) {
          throw new MemoryError("SHARE_BLOCKED", "接收者已明确忘记该事实。");
        }
        return entry;
      });

      const shared = [];
      let created = 0;
      for (const original of originals) {
        const existing = store.getEntryByFact(toCharacterId, original.factKey);
        if (existing) {
          shared.push({ sourceEntryId: original.id, entryId: existing.id, alreadyHeld: true });
          continue;
        }
        const entry = {
          id: newEntryId(),
          characterId: toCharacterId,
          factKey: original.factKey,
          originCharacterId: original.originCharacterId,
          derivedFromEntryId: original.id,
          narratorCharacterId: fromCharacterId,
          kind: original.kind,
          body: original.body,
          trust: original.trust,
          importance: original.importance,
          expiresAt: original.expiresAt,
          sourceId: sourceId ?? `share:${original.id}:${toCharacterId}`,
          sourceVersion: 1,
          version: 1,
          createdAt: nowMs,
          updatedAt: nowMs,
        };
        store.insertEntry(entry, tokenizeForIndex(entry.body));
        shared.push({ sourceEntryId: original.id, entryId: entry.id, alreadyHeld: false });
        created += 1;
      }

      const contextVersion = created > 0 ? store.bumpContextVersion(toCharacterId, nowMs) : null;
      return { toCharacterId, shared, contextVersion };
    });
  }

  function currentHolders(factKey) {
    return [...new Set(store.listEntriesByFact(factKey).map((entry) => entry.characterId))].sort();
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
        const hash = factKeyHash(entry.factKey);
        if (store.hasShareControl(hash)) {
          throw new MemoryError("SHARE_BLOCKED", "用户已禁止分享该事实。");
        }
        if (store.hasForgetControl(toCharacterId, hash)) {
          throw new MemoryError("SHARE_BLOCKED", "接收者已明确忘记该事实。");
        }
        return entry;
      });

      const shared = [];
      let created = 0;
      for (const original of originals) {
        const existing = store.getEntryByFact(toCharacterId, original.factKey);
        if (existing) {
          const expired = existing.expiresAt !== null && existing.expiresAt <= nowMs;
          if (expired) {
            throw new MemoryError("SHARE_CONFLICT", "接收者已有同事实的失效记忆，未覆盖。");
          }
          if (existing.body !== original.body) {
            throw new MemoryError("SHARE_CONFLICT", "接收者已有不同的同事实内容，未覆盖。");
          }
          shared.push({ sourceEntryId: original.id, entryId: existing.id, alreadyHeld: true });
          continue;
        }
        const entry = {
          id: newEntryId(),
          characterId: toCharacterId,
          factKey: original.factKey,
          originCharacterId: original.originCharacterId,
          derivedFromEntryId: original.id,
          narratorCharacterId: fromCharacterId,
          kind: original.kind,
          body: original.body,
          trust: original.trust,
          importance: original.importance,
          expiresAt: original.expiresAt,
          sourceId: `relay:${original.id}:${toCharacterId}`,
          sourceVersion: 1,
          version: 1,
          createdAt: nowMs,
          updatedAt: nowMs,
        };
        store.insertEntry(entry, tokenizeForIndex(entry.body));
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
     限制按事实键摘要跨持有者生效，结果只返回已有持有者，不透露正文。 */
  function selectedHeldFact(input, characterId) {
    if (input.entryId === undefined) {
      throw new MemoryError("INVALID_INPUT", "必须指定选中的记忆。");
    }
    const { factKey } = factForSelectedChange(input, characterId);
    if (!store.getEntryByFact(characterId, factKey)) {
      throw new MemoryError("FACT_NOT_HELD", "当前角色没有该事实。");
    }
    return factKey;
  }

  function restrictSharing(input = {}) {
    const characterId = characterIdOf(input.characterId);
    const nowMs = resolveNow(input.nowMs);
    const applyRestriction = () => {
      const factKey = selectedHeldFact(input, characterId);
      const hash = factKeyHash(factKey);
      const alreadyRestricted = store.hasShareControl(hash);
      store.addShareControl(hash, nowMs);
      return { factKeyHash: hash, alreadyRestricted, holders: currentHolders(factKey) };
    };
    return input.inTransaction === true
      ? applyRestriction()
      : store.transaction(applyRestriction);
  }

  function allowSharing(input = {}) {
    const characterId = characterIdOf(input.characterId);
    return store.transaction(() => {
      const factKey = selectedHeldFact(input, characterId);
      const hash = factKeyHash(factKey);
      const lifted = store.removeShareControl(hash);
      return { factKeyHash: hash, lifted, holders: currentHolders(factKey) };
    });
  }

  /* 供 S03b 组装上下文：核心设定、重要偏好与经历分段并有字符预算，
     不是把所有历史塞进提示词。最近聊天分段不在本切片。 */
  function buildContext(input = {}) {
    const characterId = characterIdOf(input.characterId);
    const nowMs = resolveNow(input.nowMs);
    const maxChars = limitOf(input.maxChars, LIMITS.contextMaxChars, LIMITS.contextMaxChars);
    const contextVersion = store.getContextVersion(characterId);
    const active = store.listActiveEntries(characterId, nowMs, LIMITS.contextEntries);

    const core = active.filter((entry) => entry.kind === "identity").slice(0, LIMITS.contextCore);
    const preferences = active
      .filter((entry) => entry.kind === "preference")
      .slice(0, LIMITS.contextPreferences);

    let experiences;
    if (typeof input.query === "string" && input.query.trim() !== "") {
      experiences = searchMemories({
        characterId,
        nowMs,
        query: input.query,
        limit: Math.min(LIMITS.contextQueryResults, RETRIEVAL_CONFIG.maxLimit),
      })
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
    listMemories,
    listMemoriesPage,
    searchMemories,
    correct,
    forget,
    keepExclusive,
    share,
    relay,
    restrictSharing,
    allowSharing,
    buildContext,
    getContextVersion,
    isContextCurrent,
    listExcludedSources,
    rebuildSearchIndex,
  };
}

module.exports = { createMemoryService, MemoryError, LIMITS };
