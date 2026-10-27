/* S03m 2c-1a 临时理解领域模块。
   职责：随机 T 的查找/歧义、阶段 1 发起人与已证明同一长期 identity 持有者的
   同步写入、临时条目的结构判定与上下文优先。控制/删除/限制/独占仍由既有
   memory.cjs 入口按 T 执行；本模块不复制 forget proof，也不保存正文副本。 */
const {
  copiedTemporarySource,
  directTemporarySource,
  editedTemporarySource,
  isTemporarySource,
  parseTemporarySource,
  temporaryFactKey,
} = require("./memory-temporary-source.cjs");

function createMemoryTemporary({
  store,
  newId,
  hashSource,
  identityOf,
  fingerprintOf,
  validateTemporary,
  tokenize,
  MemoryError,
  limits,
}) {
  function isTemporaryEntry(entry) {
    if (!entry || entry.expiresAt === null || entry.expiresAt === undefined) {
      return false;
    }
    if (isTemporarySource(entry.sourceId)) {
      return true;
    }
    return Boolean(entry.factIdentityId) && store
      .listTemporaryLinksByIdentity(entry.factIdentityId)
      .some((link) =>
        link.holderCharacterId === entry.characterId &&
        link.expiresAt === entry.expiresAt,
      );
  }

  /* 临时来源有效性只认注入的权威校验器；缺失或任何异常都保守视为不可用。 */
  function validTemporaryEntry(entry, nowMs) {
    if (!isTemporaryEntry(entry) || typeof validateTemporary !== "function") {
      return null;
    }
    try {
      const result = validateTemporary({
        characterId: entry.characterId,
        entryId: entry.id,
        expectedVersion: entry.version,
        nowMs,
      });
      return result?.status === "ok" ? result : null;
    } catch {
      return null;
    }
  }

  function holderLong(holderCharacterId, longIdentityId, nowMs) {
    if (!longIdentityId) {
      return null;
    }
    return store.listEntriesByIdentity(longIdentityId).find((entry) =>
      entry.characterId === holderCharacterId &&
      !isTemporaryEntry(entry) &&
      (entry.expiresAt === null || entry.expiresAt > nowMs)) ?? null;
  }

  /* 长期目标优先发起人自己的唯一有效 current；否则接受同一长期 identity 下
     唯一有效的 T。失效行不参与活跃判断、歧义或复用；出现多个有效 T 时抛
     TEMPORARY_AMBIGUOUS，调用方零写入。没有有效 T 时新建随机 T，并把同一
     有效时段的旧 T 只用于继承控制。 */
  function findIdentity({ characterId, longIdentityId, expiresAt, nowMs }) {
    const links = store.listTemporaryLinksByLongIdentity(longIdentityId);
    const active = new Set();
    for (const link of links) {
      if (link.expiresAt <= nowMs) {
        continue;
      }
      if (store.listEntriesByIdentity(link.tempIdentityId)
        .some((entry) => validTemporaryEntry(entry, nowMs))) {
        active.add(link.tempIdentityId);
      }
    }
    const own = new Set(
      [...active].filter((identityId) =>
        store.listEntriesByIdentity(identityId).some((entry) =>
          entry.characterId === characterId &&
          validTemporaryEntry(entry, nowMs))),
    );
    if (own.size === 1) {
      const identityId = [...own][0];
      return { temporaryIdentityId: identityId, oldIdentityIds: [identityId], reused: true };
    }
    if (own.size > 1) {
      throw new MemoryError("TEMPORARY_AMBIGUOUS", "同一长期事实存在多条今日记录。");
    }
    if (active.size === 1) {
      const identityId = [...active][0];
      return { temporaryIdentityId: identityId, oldIdentityIds: [identityId], reused: true };
    }
    if (active.size > 1) {
      throw new MemoryError("TEMPORARY_AMBIGUOUS", "同一长期事实存在多条今日记录。");
    }
    const period = [
      ...new Set(
        links
          .filter((link) => link.expiresAt === expiresAt)
          .map((link) => link.tempIdentityId),
      ),
    ];
    return { temporaryIdentityId: newId(), oldIdentityIds: period, reused: false };
  }

  /* 新 T 沿用同一有效时段旧 T 的无正文控制：旧 share/exclusive 不自动解除，
     旧 forget 按 holder 保持，不因换 source、换措辞或换 T 绕过。 */
  function inheritControls({ temporaryIdentityId, oldIdentityIds, nowMs }) {
    for (const oldIdentityId of oldIdentityIds) {
      if (store.hasShareIdentityControl(oldIdentityId)) {
        store.addShareIdentityControl(temporaryIdentityId, nowMs);
      }
      for (const link of store.listTemporaryLinksByIdentity(oldIdentityId)) {
        if (store.hasForgetIdentityControl(link.holderCharacterId, oldIdentityId)) {
          store.addForgetIdentityControl(
            link.holderCharacterId,
            temporaryIdentityId,
            nowMs,
          );
        }
      }
    }
  }

  /* 同一角色同一 factKey 有唯一约束；旧日已到期但保留的临时条目仍占用规范键，
     新 T 需要可区分的键，才能保留历史而不复活旧条目。 */
  function uniqueFactKey(holder, baseKey, temporaryIdentityId) {
    const existing = store.getEntryByFact(holder, baseKey);
    if (!existing || existing.factIdentityId === temporaryIdentityId) {
      return baseKey;
    }
    const key = `${baseKey}.${temporaryIdentityId}`;
    if (key.length > limits.factKey) {
      throw new MemoryError("INVALID_INPUT", "临时事实键过长。");
    }
    return key;
  }

  /* 新建与编辑共用同一角色/条目/版本/正文校验，避免两套入口规则漂移。 */
  function parseSelectedText(input, message = "临时理解参数无效。") {
    if (!input || typeof input !== "object") {
      throw new MemoryError("INVALID_INPUT", message);
    }
    const characterId = input.characterId;
    if (typeof characterId !== "string" || !store.isKnownCharacter(characterId)) {
      throw new MemoryError("CHARACTER_UNKNOWN", "角色不存在。");
    }
    const entryId = typeof input.entryId === "string" ? input.entryId.trim() : "";
    const expectedVersion = input.expectedVersion;
    if (!entryId || entryId.length > 200 ||
      !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new MemoryError("INVALID_INPUT", "记忆定位无效。");
    }
    const body = typeof input.body === "string" ? input.body.trim() : "";
    if (!body || body.length > limits.body || body.includes("\u0000")) {
      throw new MemoryError("INVALID_INPUT", "正文无效。");
    }
    return { characterId, entryId, expectedVersion, body };
  }

  function parseInput(input) {
    const { characterId, entryId, expectedVersion, body } = parseSelectedText(input);
    const trust = input.trust ?? "stated";
    if (trust !== "stated" && trust !== "inferred") {
      throw new MemoryError("INVALID_INPUT", "可信性质无效。");
    }
    const expiresAt = input.expiresAt;
    const nowMs = input.nowMs ?? Date.now();
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= nowMs) {
      throw new MemoryError("INVALID_INPUT", "临时理解必须有晚于当前的到期时间。");
    }
    const sourceId = typeof input.sourceId === "string" ? input.sourceId.trim() : "";
    if (!/^chat:[^:\s]+$/u.test(sourceId) || sourceId.length > limits.sourceId) {
      throw new MemoryError("INVALID_INPUT", "临时理解必须来自本轮聊天消息。");
    }
    return { characterId, entryId, expectedVersion, body, trust, expiresAt, nowMs, sourceId };
  }

  function applyUnderstanding(rawInput = {}) {
    const input = parseInput(rawInput);
    const {
      characterId, entryId, expectedVersion, body, trust, expiresAt, nowMs, sourceId,
    } = input;
    const apply = () => {
      const selected = store.getEntryById(entryId);
      if (!selected || selected.characterId !== characterId) {
        throw new MemoryError("ENTRY_NOT_FOUND", "这条记忆不存在。");
      }
      if (selected.version !== expectedVersion) {
        throw new MemoryError("MEMORY_CHANGED", "记忆已更新。");
      }
      if (selected.expiresAt !== null && selected.expiresAt <= nowMs) {
        throw new MemoryError("ENTRY_NOT_FOUND", "这条临时理解已到期。");
      }

      const selectedTemporary = isTemporaryEntry(selected);
      let longAnchor = selectedTemporary ? null : selected;
      let temporaryIdentityId = null;
      let oldIdentityIds = [];
      if (selectedTemporary) {
        /* 选中的临时条目也必须先过同一权威校验器；失效 current 不能凭 T
           直接绕过，也不能把来源里的锚当作可用证据。 */
        const validated = validTemporaryEntry(selected, nowMs);
        if (!validated || !selected.factIdentityId || !validated.sourceAnchorIdentityId) {
          throw new MemoryError("TEMPORARY_SOURCE_UNAVAILABLE", "这条临时理解已失效。");
        }
        temporaryIdentityId = selected.factIdentityId;
        oldIdentityIds = [temporaryIdentityId];
        longAnchor = holderLong(
          characterId,
          validated.sourceAnchorIdentityId,
          nowMs,
        );
      } else {
        const longIdentityId = identityOf(selected, nowMs);
        const found = findIdentity({ characterId, longIdentityId, expiresAt, nowMs });
        temporaryIdentityId = found.temporaryIdentityId;
        oldIdentityIds = found.oldIdentityIds;
      }
      if (!longAnchor) {
        throw new MemoryError("TEMPORARY_ANCHOR_REQUIRED", "当前角色没有长期记忆。");
      }
      const longIdentityId = identityOf(longAnchor, nowMs);
      if (!store.listTemporaryLinksByIdentity(temporaryIdentityId).length &&
        !store.listEntriesByIdentity(temporaryIdentityId).length) {
        store.insertFactIdentity(temporaryIdentityId, nowMs);
      }
      inheritControls({ temporaryIdentityId, oldIdentityIds, nowMs });
      const controlIdentityIds = [...new Set([temporaryIdentityId, ...oldIdentityIds])];
      const shareControlled = controlIdentityIds.some((identityId) =>
        store.hasShareIdentityControl(identityId));
      const deletedFingerprint = input.trust === "inferred"
        ? null
        : fingerprintOf({
          kind: longAnchor.kind,
          trust,
          sourceKind: "user",
          expiresAt,
          body,
        });

      const existingMembers = store.listEntriesByIdentity(temporaryIdentityId);
      const blocked = (holder) => {
        if (holder === characterId) {
          return false;
        }
        if (controlIdentityIds.some((identityId) =>
          store.hasForgetIdentityControl(holder, identityId))) {
          return true;
        }
        return Boolean(deletedFingerprint &&
          store.hasDeletedFactFingerprint(holder, deletedFingerprint));
      };
      const affected = new Set();
      const sourceControls = {};
      const recordSource = (holder, oldSourceId) => {
        const hash = hashSource(oldSourceId);
        if (!sourceControls[holder]) {
          sourceControls[holder] = [];
        }
        if (!sourceControls[holder].includes(hash)) {
          sourceControls[holder].push(hash);
        }
        store.addSourceControl(holder, hash, nowMs);
      };

      let originCurrent = selectedTemporary && selected.characterId === characterId
        ? selected
        : existingMembers.find((entry) => entry.characterId === characterId) ?? null;
      if (originCurrent && originCurrent.characterId !== characterId) {
        originCurrent = null;
      }
      const canonicalKey = temporaryFactKey(longAnchor.factKey, longAnchor.id);
      const nextFactKey = uniqueFactKey(characterId, canonicalKey, temporaryIdentityId);
      if (originCurrent && originCurrent.factKey !== nextFactKey) {
        store.setEntryFactKey(originCurrent.id, nextFactKey);
        originCurrent.factKey = nextFactKey;
      }
      const directSourceId = directTemporarySource({
        originLongEntryId: longAnchor.id,
        createdAt: nowMs,
        messageSourceId: sourceId,
      });
      const base = {
        characterId,
        factKey: nextFactKey,
        factIdentityId: temporaryIdentityId,
        kind: longAnchor.kind,
        body,
        trust,
        importance: longAnchor.importance,
        expiresAt,
        updatedAt: nowMs,
      };
      if (originCurrent) {
        if (originCurrent.sourceId !== directSourceId) {
          recordSource(characterId, originCurrent.sourceId);
        }
        originCurrent = {
          ...originCurrent,
          ...base,
          factKey: originCurrent.factKey === nextFactKey ? nextFactKey : originCurrent.factKey,
          originCharacterId: characterId,
          derivedFromEntryId: null,
          narratorCharacterId: null,
          sourceKind: "user",
          sourceId: directSourceId,
          sourceVersion: 1,
          version: originCurrent.version + 1,
        };
        store.updateEntry(originCurrent, tokenize(body));
        store.removeDerivation(originCurrent.id);
        // 发起人可能从 relay/copy 转为 direct：清掉旧父条目与已失效的关系边。
        store.updateTemporaryOrigin(originCurrent.id, characterId, null);
        store.removeRelationEdgesToEntry(originCurrent.id);
      } else {
        originCurrent = {
          ...base,
          id: newId(),
          originCharacterId: characterId,
          derivedFromEntryId: null,
          narratorCharacterId: null,
          sourceKind: "user",
          sourceId: directSourceId,
          sourceVersion: 1,
          version: 1,
          createdAt: nowMs,
        };
        store.insertEntry(originCurrent, tokenize(body));
      }
      store.insertTemporaryLink({
        tempIdentityId: temporaryIdentityId,
        longIdentityId,
        holderCharacterId: characterId,
        expiresAt,
      });
      affected.add(characterId);

      const holders = new Set(existingMembers.map((entry) => entry.characterId));
      for (const entry of store.listEntriesByIdentity(longIdentityId)) {
        if (!isTemporaryEntry(entry) && (entry.expiresAt === null || entry.expiresAt > nowMs)) {
          holders.add(entry.characterId);
        }
      }
      holders.delete(characterId);
      for (const holder of holders) {
        const existing = existingMembers.find((entry) => entry.characterId === holder) ?? null;
        if (blocked(holder)) {
          continue;
        }
        if (!existing && shareControlled) {
          continue;
        }
        const anchor = holderLong(holder, longIdentityId, nowMs);
        if (!existing && !anchor) {
          continue;
        }
        const holderSource = copiedTemporarySource({
          originLongEntryId: longAnchor.id,
          originLongVersion: longAnchor.version,
          originCurrentEntryId: originCurrent.id,
          originCurrentVersion: originCurrent.version,
          holderLongEntryId: anchor?.id ?? null,
          holderLongVersion: anchor?.version ?? 0,
          messageSourceId: sourceId,
        });
        if (holderSource.length > limits.sourceId ||
          store.hasSourceControl(holder, hashSource(holderSource))) {
          continue;
        }
        if (existing && existing.sourceId !== holderSource) {
          recordSource(holder, existing.sourceId);
        }
        const next = {
          ...(existing ?? {
            id: newId(),
            factKey: uniqueFactKey(
              holder,
              temporaryFactKey(anchor.factKey, anchor.id),
              temporaryIdentityId,
            ),
            originCharacterId: characterId,
            sourceVersion: 1,
            version: 1,
            createdAt: nowMs,
          }),
          ...base,
          characterId: holder,
          factKey: existing?.factKey ?? uniqueFactKey(
            holder,
            temporaryFactKey(anchor.factKey, anchor.id),
            temporaryIdentityId,
          ),
          originCharacterId: characterId,
          derivedFromEntryId: originCurrent.id,
          narratorCharacterId: characterId,
          sourceKind: "user",
          importance: existing?.importance ?? anchor?.importance ?? longAnchor.importance,
          sourceId: holderSource,
          sourceVersion: 1,
          version: existing ? existing.version + 1 : 1,
        };
        if (existing) {
          store.updateEntry(next, tokenize(body));
          store.setDerivation(next);
          // 身份同步会替换旧 immediate parent；持久归属与旧关系边必须一起更新，
          // 不能让显式 relay 的旧边与新 derivation 矛盾。
          store.updateTemporaryOrigin(existing.id, characterId, originCurrent.id);
          store.removeRelationEdgesToEntry(existing.id);
        } else {
          store.insertEntry(next, tokenize(body));
        }
        store.insertTemporaryLink({
          tempIdentityId: temporaryIdentityId,
          longIdentityId,
          holderCharacterId: holder,
          expiresAt,
        });
        affected.add(holder);
      }

      const contextVersions = {};
      for (const holder of [...affected].sort()) {
        contextVersions[holder] = store.bumpContextVersion(holder, nowMs);
      }
      for (const holder of Object.keys(sourceControls)) {
        sourceControls[holder].sort();
      }
      return {
        mode: "temporary",
        temporaryIdentityId,
        expiresAt,
        longTermFactKey: longAnchor.factKey,
        updated: affected.size,
        sourceControls,
        affectedCharacters: [...affected].sort(),
        contextVersions,
      };
    };
    return rawInput.inTransaction === true ? apply() : store.transaction(apply);
  }

  function parseEditInput(input) {
    const base = parseSelectedText(input, "临时理解编辑参数无效。");
    return { ...base, nowMs: input.nowMs ?? Date.now() };
  }

  /* 面板编辑任一临时副本：更新同一 T 内全部仍有效的成员正文与版本，
     保留 T、到期、长期锚和 holder 锚；来源改为 temporary-edit，表示面板
     修改而不是聊天原话。长期 entry 不参与。 */
  function editUnderstanding(rawInput = {}) {
    const input = parseEditInput(rawInput);
    const { characterId, entryId, expectedVersion, body, nowMs } = input;
    const apply = () => {
      const selected = store.getEntryById(entryId);
      if (!selected || selected.characterId !== characterId) {
        throw new MemoryError("ENTRY_NOT_FOUND", "这条记忆不存在。");
      }
      if (selected.version !== expectedVersion) {
        throw new MemoryError("MEMORY_CHANGED", "记忆已更新。");
      }
      if (selected.expiresAt === null || selected.expiresAt <= nowMs) {
        throw new MemoryError("ENTRY_NOT_FOUND", "这条临时理解已到期。");
      }
      if (!isTemporaryEntry(selected)) {
        throw new MemoryError("INVALID_INPUT", "这条记忆不是临时理解。");
      }
      const validated = validTemporaryEntry(selected, nowMs);
      if (!validated || !validated.sourceAnchorIdentityId || !selected.factIdentityId) {
        throw new MemoryError("TEMPORARY_SOURCE_UNAVAILABLE", "这条临时理解已失效。");
      }
      const parsed = parseTemporarySource(selected.sourceId);
      if (!parsed) {
        throw new MemoryError("TEMPORARY_SOURCE_UNAVAILABLE", "临时理解的来源不完整。");
      }
      const temporaryIdentityId = selected.factIdentityId;
      const longIdentityId = validated.sourceAnchorIdentityId;
      const members = store.listEntriesByIdentity(temporaryIdentityId)
        .filter((entry) =>
          isTemporaryEntry(entry) && entry.expiresAt === selected.expiresAt);
      /* 同步编辑必须建立在这一 T 当前仍完整有效的证据上；任一成员失效时
         保守拒绝，避免把失效正文修成看似有效的面板编辑。 */
      if (members.length === 0 ||
        members.some((entry) => !validTemporaryEntry(entry, nowMs))) {
        throw new MemoryError("TEMPORARY_SOURCE_UNAVAILABLE", "这条临时理解已失效。");
      }

      const originEntryId = parsed.kind === "direct"
        ? selected.id
        : parsed.originCurrentEntryId;
      const originMember = members.find((entry) => entry.id === originEntryId) ?? null;
      const originLongVersion = parsed.kind === "direct"
        ? (store.getEntryById(parsed.originLongEntryId)?.version ?? 0)
        : parsed.originLongVersion;
      const originCurrentVersion = originMember
        ? originMember.version + 1
        : parsed.originCurrentVersion;
      if (!originEntryId ||
        !Number.isSafeInteger(originCurrentVersion) || originCurrentVersion < 1) {
        throw new MemoryError("TEMPORARY_SOURCE_UNAVAILABLE", "临时理解的来源不完整。");
      }

      const sourceControls = {};
      const affected = new Set();
      let updatedDerived = 0;
      for (const member of members) {
        const anchor = holderLong(member.characterId, longIdentityId, nowMs);
        const sourceId = editedTemporarySource({
          originLongEntryId: parsed.originLongEntryId,
          originLongVersion,
          originCurrentEntryId: originEntryId,
          originCurrentVersion,
          holderLongEntryId: anchor?.id ?? null,
          holderLongVersion: anchor?.version ?? 0,
          messageSourceId: parsed.messageSourceId,
        });
        if (sourceId.length > limits.sourceId) {
          throw new MemoryError("INVALID_INPUT", "临时来源ID过长。");
        }
        if (member.sourceId !== sourceId) {
          const hash = hashSource(member.sourceId);
          if (!sourceControls[member.characterId]) {
            sourceControls[member.characterId] = [];
          }
          if (!sourceControls[member.characterId].includes(hash)) {
            sourceControls[member.characterId].push(hash);
          }
          store.addSourceControl(member.characterId, hash, nowMs);
        }
        const next = {
          ...member,
          body,
          sourceKind: "user",
          expiresAt: member.expiresAt,
          sourceId,
          sourceVersion: 1,
          version: member.version + 1,
          updatedAt: nowMs,
        };
        store.updateEntry(next, tokenize(body));
        if (member.derivationSourceId !== null) {
          store.setDerivation({
            ...next,
            derivedFromEntryId: member.derivedFromEntryId,
            narratorCharacterId: member.narratorCharacterId,
            originCharacterId: member.originCharacterId,
          });
          updatedDerived += 1;
        }
        affected.add(member.characterId);
      }

      const contextVersions = {};
      for (const holder of [...affected].sort()) {
        contextVersions[holder] = store.bumpContextVersion(holder, nowMs);
      }
      for (const holder of Object.keys(sourceControls)) {
        sourceControls[holder].sort();
      }
      return {
        updated: members.length,
        updatedDerived,
        affectedCharacters: [...affected].sort(),
        contextVersions,
      };
    };
    return rawInput.inTransaction === true ? apply() : store.transaction(apply);
  }

  /* 显式转告/分享临时条目时复用权威校验结果；只有明确同一长期事实关联且
     当前有效的 holder long 才写入来源，收件人有任意别的长期记忆也不挂靠。 */
  function propagationSource({ entry, holderCharacterId, nowMs }) {
    if (!isTemporaryEntry(entry)) {
      return null;
    }
    const info = temporaryInfo(entry, nowMs);
    if (!info) {
      throw new MemoryError("SHARE_NOT_ALLOWED", "这条临时理解已失效。");
    }
    const parsed = parseTemporarySource(entry.sourceId);
    if (!parsed || !entry.factIdentityId || entry.expiresAt === null) {
      throw new MemoryError("SHARE_NOT_ALLOWED", "临时理解的来源不完整。");
    }
    const anchor = holderLong(holderCharacterId, info.longIdentityId, nowMs);
    const originCurrentEntryId = parsed.kind === "direct" ? entry.id : parsed.originCurrentEntryId;
    const originCurrentVersion = parsed.kind === "direct"
      ? entry.version
      : parsed.originCurrentVersion;
    const originLongVersion = parsed.kind === "direct"
      ? (store.getEntryById(parsed.originLongEntryId)?.version ?? 0)
      : parsed.originLongVersion;
    const sourceId = (parsed.kind === "edit" ? editedTemporarySource : copiedTemporarySource)({
      originLongEntryId: parsed.originLongEntryId,
      originLongVersion,
      originCurrentEntryId,
      originCurrentVersion,
      holderLongEntryId: anchor?.id ?? null,
      holderLongVersion: anchor?.version ?? 0,
      messageSourceId: parsed.messageSourceId,
    });
    if (sourceId.length > limits.sourceId) {
      throw new MemoryError("INVALID_INPUT", "临时来源ID过长。");
    }
    return {
      sourceId,
      longIdentityId: info.longIdentityId,
      temporaryIdentityId: entry.factIdentityId,
      expiresAt: entry.expiresAt,
      holderLongEntryId: anchor?.id ?? null,
      holderLongVersion: anchor?.version ?? 0,
    };
  }

  /* 临时正文能否进入检索/上下文，只由注入的权威来源核验决定；核验器缺失时
     保守剔除，不退回本模块的弱结构判断。resolve 本身只读，不改变记忆状态。 */
  function temporaryInfo(entry, nowMs) {
    if (!isTemporaryEntry(entry) || typeof validateTemporary !== "function") {
      return null;
    }
    let result;
    try {
      result = validateTemporary({
        characterId: entry.characterId,
        entryId: entry.id,
        expectedVersion: entry.version,
        nowMs,
      });
    } catch {
      return null;
    }
    if (!result || result.status !== "ok" || !result.sourceAnchorIdentityId) {
      return null;
    }
    return {
      kind: result.temporaryKind === "copy"
        ? "copy"
        : result.temporaryKind === "edit" ? "edit" : "direct",
      longIdentityId: result.sourceAnchorIdentityId,
      originCharacterId: result.sourceCharacterId ?? entry.originCharacterId,
      relayFrom: result.relayFrom ?? null,
      edited: result.edited === true,
    };
  }

  /* searchMemories 仍是管理与定位入口：保留合法长期条目，只剔除结构失效的临时项。 */
  function filterSearch(entries, nowMs) {
    return entries.flatMap((entry) => {
      if (!isTemporaryEntry(entry)) {
        return [entry];
      }
      const info = temporaryInfo(entry, nowMs);
      return info ? [{ ...entry, temporarySource: info }] : [];
    });
  }

  /* buildContext 才体现“今日优先”：有效 current 抑制同一长期 identity 的长期锚；
     失效/到期后不设墓碑，长期按原样恢复。 */
  function annotateContext(entries, nowMs) {
    const infoById = new Map();
    const suppressed = new Set();
    for (const entry of entries) {
      if (!isTemporaryEntry(entry)) {
        continue;
      }
      const info = temporaryInfo(entry, nowMs);
      if (!info) {
        continue;
      }
      infoById.set(entry.id, info);
      suppressed.add(info.longIdentityId);
    }
    const result = [];
    const seen = new Set();
    for (const entry of entries) {
      if (isTemporaryEntry(entry)) {
        const info = infoById.get(entry.id);
        if (!info) {
          continue;
        }
        const key = `${entry.body}\u0000${entry.expiresAt}\u0000${info.longIdentityId}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        result.push({ ...entry, temporarySource: info });
      } else if (!suppressed.has(entry.factIdentityId)) {
        result.push(entry);
      }
    }
    return result;
  }

  return {
    isTemporaryEntry,
    applyUnderstanding,
    editUnderstanding,
    propagationSource,
    temporaryInfo,
    holderLong,
    filterSearch,
    annotateContext,
  };
}

module.exports = { createMemoryTemporary };
