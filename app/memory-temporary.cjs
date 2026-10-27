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
    // listEntriesByIdentity 已按 created_at/id 排序；同 holder+L 多锚取最早一条。
    return store.listEntriesByIdentity(longIdentityId).find((entry) =>
      entry.characterId === holderCharacterId &&
      !isTemporaryEntry(entry) &&
      (entry.expiresAt === null || entry.expiresAt > nowMs)) ?? null;
  }

  /* 旧 2c-1 只有 T→单 L 控制关系；只有整 T 唯一 L、该 holder 恰一行且到期
     一致时才允许回退/回填。读取永不补齐，写入端在合法操作内同事务补齐。 */
  function legacyEntryLink(entry) {
    if (!entry?.factIdentityId || !store) {
      return null;
    }
    const links = store.listTemporaryLinksByIdentity(entry.factIdentityId);
    const identityIds = new Set(links.map((link) => link.longIdentityId));
    if (identityIds.size !== 1 ||
      links.some((link) => link.expiresAt !== entry.expiresAt)) {
      return null;
    }
    const holderLinks = links.filter((link) =>
      link.holderCharacterId === entry.characterId &&
      link.expiresAt === entry.expiresAt);
    if (holderLinks.length !== 1) {
      return null;
    }
    return {
      ownLongIdentityId: holderLinks[0].longIdentityId,
      rootIdentityId: holderLinks[0].longIdentityId,
    };
  }

  /* 每条临时条目恰一条 entry 关联：own L 不可变，root L 随本轮 direct origin
     轮换。旧行没有 entry 关联时只在写入路径按可证明条件补齐。 */
  function linkOfEntry(entry, { write = false } = {}) {
    if (!entry || !entry.factIdentityId) {
      return null;
    }
    const row = store.getTemporaryEntryLink(entry.id);
    if (row) {
      if (row.tempIdentityId !== entry.factIdentityId ||
        row.holderCharacterId !== entry.characterId ||
        row.expiresAt !== entry.expiresAt ||
        !row.longIdentityId || !row.rootIdentityId) {
        return null;
      }
      // entry 关联不能单独作证：own L 必须同时存在于旧控制关系。
      if (!store.listTemporaryLinksByIdentity(entry.factIdentityId).some((link) =>
        link.holderCharacterId === entry.characterId &&
        link.expiresAt === entry.expiresAt &&
        link.longIdentityId === row.longIdentityId)) {
        return null;
      }
      return {
        ownLongIdentityId: row.longIdentityId,
        rootIdentityId: row.rootIdentityId,
      };
    }
    const legacy = legacyEntryLink(entry);
    if (!legacy) {
      return null;
    }
    if (write) {
      store.insertTemporaryEntryLink({
        entryId: entry.id,
        tempIdentityId: entry.factIdentityId,
        holderCharacterId: entry.characterId,
        expiresAt: entry.expiresAt,
        longIdentityId: legacy.ownLongIdentityId,
        rootIdentityId: legacy.rootIdentityId,
      });
    }
    return legacy;
  }

  function activeMembers(temporaryIdentityId, nowMs) {
    return store.listEntriesByIdentity(temporaryIdentityId).filter((entry) =>
      entry.expiresAt !== null &&
      entry.expiresAt > nowMs &&
      isTemporaryEntry(entry));
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
    const timeSourceId = input.timeSourceId === undefined || input.timeSourceId === null
      ? null
      : String(input.timeSourceId).trim();
    if (timeSourceId !== null &&
      (!/^chat:[^:\s]+$/u.test(timeSourceId) || timeSourceId.length > limits.sourceId)) {
      throw new MemoryError("INVALID_INPUT", "今日时间授权来源无效。");
    }
    return {
      characterId, entryId, expectedVersion, body, trust, expiresAt, nowMs, sourceId, timeSourceId,
    };
  }

  function applyUnderstanding(rawInput = {}) {
    const input = parseInput(rawInput);
    const {
      characterId, entryId, expectedVersion, body, trust, expiresAt, nowMs, sourceId,
      timeSourceId,
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
      let temporaryIdentityId = null;
      let oldIdentityIds = [];
      let ownIdentityId = null;
      let longAnchor = null;
      let originCurrent = null;
      let members = [];
      if (selectedTemporary) {
        /* 选中的临时条目也必须先过同一权威校验器；失效 current 不能凭 T
           直接绕过，也不能把来源里的锚当作可用证据。 */
        const validated = validTemporaryEntry(selected, nowMs);
        if (!validated || !selected.factIdentityId) {
          throw new MemoryError("TEMPORARY_SOURCE_UNAVAILABLE", "这条临时理解已失效。");
        }
        const link = linkOfEntry(selected, { write: true });
        if (!link) {
          throw new MemoryError("TEMPORARY_SOURCE_UNAVAILABLE", "临时条目的关联证据不足。");
        }
        temporaryIdentityId = selected.factIdentityId;
        oldIdentityIds = [temporaryIdentityId];
        ownIdentityId = link.ownLongIdentityId;
        longAnchor = holderLong(characterId, ownIdentityId, nowMs);
        originCurrent = selected;
        members = activeMembers(temporaryIdentityId, nowMs);
      } else {
        const longIdentityId = identityOf(selected, nowMs);
        const found = findIdentity({ characterId, longIdentityId, expiresAt, nowMs });
        temporaryIdentityId = found.temporaryIdentityId;
        oldIdentityIds = found.oldIdentityIds;
        ownIdentityId = longIdentityId;
        longAnchor = selected;
        members = activeMembers(temporaryIdentityId, nowMs);
        originCurrent = members.find((entry) =>
          entry.characterId === characterId &&
          linkOfEntry(entry, { write: true })?.ownLongIdentityId === longIdentityId) ?? null;
      }
      if (!longAnchor) {
        throw new MemoryError("TEMPORARY_ANCHOR_REQUIRED", "当前角色没有长期记忆。");
      }
      const rootIdentityId = identityOf(longAnchor, nowMs);
      if (rootIdentityId !== ownIdentityId) {
        throw new MemoryError("TEMPORARY_SOURCE_UNAVAILABLE", "临时条目的 own L 与长期锚不一致。");
      }
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
        timeSourceId,
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
      store.insertTemporaryEntryLink({
        entryId: originCurrent.id,
        tempIdentityId: temporaryIdentityId,
        holderCharacterId: characterId,
        expiresAt,
        longIdentityId: ownIdentityId,
        rootIdentityId,
      });
      store.insertTemporaryLink({
        tempIdentityId: temporaryIdentityId,
        longIdentityId: ownIdentityId,
        holderCharacterId: characterId,
        expiresAt,
      });
      affected.add(characterId);

      /* 多 L：已有成员各自保留 holder+L 与 holderLong 锚，正文/到期同步，
         来源 origin current 统一到本轮根 direct；own L 永不改写。 */
      for (const member of members) {
        if (member.id === originCurrent.id) {
          continue;
        }
        const link = linkOfEntry(member, { write: true });
        if (!link) {
          throw new MemoryError("TEMPORARY_SOURCE_UNAVAILABLE", "临时成员缺少 entry 关联。");
        }
        if (blocked(member.characterId)) {
          continue;
        }
        const anchor = holderLong(member.characterId, link.ownLongIdentityId, nowMs);
        const holderSource = copiedTemporarySource({
          originLongEntryId: longAnchor.id,
          originLongVersion: longAnchor.version,
          originCurrentEntryId: originCurrent.id,
          originCurrentVersion: originCurrent.version,
          holderLongEntryId: anchor?.id ?? null,
          holderLongVersion: anchor?.version ?? 0,
          messageSourceId: sourceId,
          timeSourceId,
        });
        if (holderSource.length > limits.sourceId ||
          store.hasSourceControl(member.characterId, hashSource(holderSource))) {
          continue;
        }
        if (member.sourceId !== holderSource) {
          recordSource(member.characterId, member.sourceId);
        }
        const next = {
          ...member,
          ...base,
          characterId: member.characterId,
          factKey: member.factKey,
          originCharacterId: characterId,
          derivedFromEntryId: originCurrent.id,
          narratorCharacterId: characterId,
          sourceKind: "user",
          importance: member.importance ?? anchor?.importance ?? longAnchor.importance,
          sourceId: holderSource,
          sourceVersion: 1,
          version: member.version + 1,
        };
        store.updateEntry(next, tokenize(body));
        store.setDerivation(next);
        // 身份同步会替换旧 immediate parent；持久归属与旧关系边必须一起更新，
        // 不能让显式 relay 的旧边与新 derivation 矛盾。
        store.updateTemporaryOrigin(member.id, characterId, originCurrent.id);
        store.removeRelationEdgesToEntry(member.id);
        store.insertTemporaryEntryLink({
          entryId: member.id,
          tempIdentityId: temporaryIdentityId,
          holderCharacterId: member.characterId,
          expiresAt,
          longIdentityId: link.ownLongIdentityId,
          rootIdentityId,
        });
        store.insertTemporaryLink({
          tempIdentityId: temporaryIdentityId,
          longIdentityId: link.ownLongIdentityId,
          holderCharacterId: member.characterId,
          expiresAt,
        });
        affected.add(member.characterId);
      }

      /* 再为所选 L 的已有长期 holder 补 copy；已存在的 holder+L 不重复。 */
      const knownHolders = new Set(
        store.listEntriesByIdentity(rootIdentityId)
          .filter((entry) =>
            !isTemporaryEntry(entry) &&
            (entry.expiresAt === null || entry.expiresAt > nowMs))
          .map((entry) => entry.characterId),
      );
      knownHolders.delete(characterId);
      for (const holder of knownHolders) {
        if (blocked(holder)) {
          continue;
        }
        const existing = members.some((member) =>
          member.characterId === holder &&
          linkOfEntry(member)?.ownLongIdentityId === rootIdentityId);
        if (existing || shareControlled) {
          continue;
        }
        const anchor = holderLong(holder, rootIdentityId, nowMs);
        if (!anchor) {
          continue;
        }
        const holderSource = copiedTemporarySource({
          originLongEntryId: longAnchor.id,
          originLongVersion: longAnchor.version,
          originCurrentEntryId: originCurrent.id,
          originCurrentVersion: originCurrent.version,
          holderLongEntryId: anchor.id,
          holderLongVersion: anchor.version,
          messageSourceId: sourceId,
          timeSourceId,
        });
        if (holderSource.length > limits.sourceId ||
          store.hasSourceControl(holder, hashSource(holderSource))) {
          continue;
        }
        const next = {
          id: newId(),
          characterId: holder,
          factKey: uniqueFactKey(
            holder,
            temporaryFactKey(anchor.factKey, anchor.id),
            temporaryIdentityId,
          ),
          factIdentityId: temporaryIdentityId,
          originCharacterId: characterId,
          derivedFromEntryId: originCurrent.id,
          narratorCharacterId: characterId,
          kind: longAnchor.kind,
          body,
          trust,
          sourceKind: "user",
          importance: anchor.importance ?? longAnchor.importance,
          expiresAt,
          sourceId: holderSource,
          sourceVersion: 1,
          version: 1,
          createdAt: nowMs,
          updatedAt: nowMs,
        };
        store.insertEntry(next, tokenize(body));
        store.insertTemporaryEntryLink({
          entryId: next.id,
          tempIdentityId: temporaryIdentityId,
          holderCharacterId: holder,
          expiresAt,
          longIdentityId: rootIdentityId,
          rootIdentityId,
        });
        store.insertTemporaryLink({
          tempIdentityId: temporaryIdentityId,
          longIdentityId: rootIdentityId,
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
      const memberEvidence = store.listEntriesByIdentity(temporaryIdentityId)
        .filter((entry) =>
          isTemporaryEntry(entry) &&
          entry.expiresAt === expiresAt)
        .map((entry) => {
          const link = linkOfEntry(entry);
          return {
            entryId: entry.id,
            holder: entry.characterId,
            longIdentityId: link?.ownLongIdentityId ?? null,
            version: entry.version,
            sourceIdHash: hashSource(entry.sourceId),
          };
        })
        .sort((left, right) => left.entryId.localeCompare(right.entryId));
      return {
        mode: "temporary",
        temporaryIdentityId,
        expiresAt,
        originEntryId: originCurrent.id,
        originVersion: originCurrent.version,
        rootIdentityId,
        initiatorCharacterId: characterId,
        entries: memberEvidence,
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
      if (!validated || !selected.factIdentityId) {
        throw new MemoryError("TEMPORARY_SOURCE_UNAVAILABLE", "这条临时理解已失效。");
      }
      const selectedLink = linkOfEntry(selected, { write: true });
      const parsed = parseTemporarySource(selected.sourceId);
      if (!selectedLink || !parsed) {
        throw new MemoryError("TEMPORARY_SOURCE_UNAVAILABLE", "临时理解的来源不完整。");
      }
      const temporaryIdentityId = selected.factIdentityId;
      const rootIdentityId = selectedLink.rootIdentityId;
      const members = activeMembers(temporaryIdentityId, nowMs)
        .filter((entry) => entry.expiresAt === selected.expiresAt);
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
        const link = linkOfEntry(member, { write: true });
        if (!link) {
          throw new MemoryError("TEMPORARY_SOURCE_UNAVAILABLE", "临时成员缺少 entry 关联。");
        }
        if (link.rootIdentityId !== rootIdentityId) {
          throw new MemoryError("TEMPORARY_SOURCE_UNAVAILABLE", "同一 T 的 root L 不一致。");
        }
        const anchor = holderLong(member.characterId, link.ownLongIdentityId, nowMs);
        const sourceId = editedTemporarySource({
          originLongEntryId: parsed.originLongEntryId,
          originLongVersion,
          originCurrentEntryId: originEntryId,
          originCurrentVersion,
          holderLongEntryId: anchor?.id ?? null,
          holderLongVersion: anchor?.version ?? 0,
          messageSourceId: parsed.messageSourceId,
          timeSourceId: parsed.timeSourceId,
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
        store.insertTemporaryEntryLink({
          entryId: member.id,
          tempIdentityId: temporaryIdentityId,
          holderCharacterId: member.characterId,
          expiresAt: member.expiresAt,
          longIdentityId: link.ownLongIdentityId,
          rootIdentityId: link.rootIdentityId,
        });
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

  /* 阶段 2：只为已核验 identity 的现有 holder 建/更新“holder+该 L”一条 current。
     不合并长期、不新建 T、不改写 own L；跳过 T forget/删除指纹与受控新 holder。 */
  function applyApprovedCorrectionToHolders({
    temporaryIdentityId,
    expiresAt,
    originEntryId,
    originVersion,
    initiatorCharacterId,
    approved,
    nowMs,
  }) {
    const root = store.getEntryById(originEntryId);
    if (!root ||
      root.factIdentityId !== temporaryIdentityId ||
      root.expiresAt !== expiresAt ||
      root.version !== originVersion ||
      root.originCharacterId !== initiatorCharacterId) {
      throw new MemoryError("MEMORY_CHANGED", "临时理解的根 current 已变化。");
    }
    const rootLink = linkOfEntry(root, { write: true });
    const parsed = parseTemporarySource(root.sourceId);
    if (!rootLink || !parsed || parsed.kind !== "direct" ||
      rootLink.ownLongIdentityId !== rootLink.rootIdentityId) {
      throw new MemoryError("TEMPORARY_SOURCE_UNAVAILABLE", "临时根 current 来源不完整。");
    }
    if (!Array.isArray(approved) || approved.length === 0) {
      throw new MemoryError("INVALID_INPUT", "已核验 identity 列表无效。");
    }
    const rootIdentityId = rootLink.rootIdentityId;
    const rootLong = store.getEntryById(parsed.originLongEntryId);
    const originLongVersion = rootLong?.version ?? 0;
    const rootBody = root.body;
    const deletedFingerprint = fingerprintOf({
      kind: root.kind,
      trust: root.trust,
      sourceKind: "user",
      expiresAt,
      body: rootBody,
    });
    const shareControlled = store.hasShareIdentityControl(temporaryIdentityId);
    const identityIds = [...new Set(approved.map((candidate) =>
      candidate?.identityId).filter((value) => typeof value === "string" && value))];
    if (identityIds.length === 0) {
      throw new MemoryError("INVALID_INPUT", "已核验 identity 列表无效。");
    }
    const affected = new Set();
    const tMembers = activeMembers(temporaryIdentityId, nowMs);
    const holdersInT = new Set(tMembers.map((entry) => entry.characterId));
    let updatedEntries = 0;
    let skipped = 0;
    for (const identityId of identityIds) {
      const holders = [...new Set(
        store.listEntriesByIdentity(identityId)
          .filter((entry) => !isTemporaryEntry(entry) &&
            (entry.expiresAt === null || entry.expiresAt > nowMs) &&
            store.isKnownCharacter(entry.characterId))
          .map((entry) => entry.characterId),
      )];
      for (const holder of holders) {
        if (store.hasForgetIdentityControl(holder, temporaryIdentityId) ||
          (deletedFingerprint &&
            store.hasDeletedFactFingerprint(holder, deletedFingerprint))) {
          skipped += 1;
          continue;
        }
        const anchor = holderLong(holder, identityId, nowMs);
        if (!anchor) {
          skipped += 1;
          continue;
        }
        const existing = tMembers.find((entry) =>
          entry.characterId === holder &&
          linkOfEntry(entry)?.ownLongIdentityId === identityId) ?? null;
        if (!existing && shareControlled && !holdersInT.has(holder)) {
          skipped += 1;
          continue;
        }
        const sourceId = copiedTemporarySource({
          originLongEntryId: parsed.originLongEntryId,
          originLongVersion,
          originCurrentEntryId: originEntryId,
          originCurrentVersion: originVersion,
          holderLongEntryId: anchor.id,
          holderLongVersion: anchor.version,
          messageSourceId: parsed.messageSourceId,
          timeSourceId: parsed.timeSourceId,
        });
        if (sourceId.length > limits.sourceId ||
          store.hasSourceControl(holder, hashSource(sourceId))) {
          skipped += 1;
          continue;
        }
        if (existing) {
          if (existing.sourceId !== sourceId) {
            store.addSourceControl(holder, hashSource(existing.sourceId), nowMs);
          }
          const next = {
            ...existing,
            body: rootBody,
            kind: root.kind,
            trust: root.trust,
            sourceKind: "user",
            importance: anchor.importance ?? root.importance,
            expiresAt,
            sourceId,
            sourceVersion: 1,
            version: existing.version + 1,
            updatedAt: nowMs,
          };
          store.updateEntry(next, tokenize(rootBody));
          store.setDerivation({
            ...next,
            derivedFromEntryId: originEntryId,
            narratorCharacterId: initiatorCharacterId,
            originCharacterId: initiatorCharacterId,
          });
          store.updateTemporaryOrigin(existing.id, initiatorCharacterId, originEntryId);
          store.removeRelationEdgesToEntry(existing.id);
          store.insertTemporaryEntryLink({
            entryId: existing.id,
            tempIdentityId: temporaryIdentityId,
            holderCharacterId: holder,
            expiresAt,
            longIdentityId: identityId,
            rootIdentityId,
          });
        } else {
          const entry = {
            id: newId(),
            characterId: holder,
            factKey: uniqueFactKey(
              holder,
              temporaryFactKey(anchor.factKey, anchor.id),
              temporaryIdentityId,
            ),
            factIdentityId: temporaryIdentityId,
            originCharacterId: initiatorCharacterId,
            derivedFromEntryId: originEntryId,
            narratorCharacterId: initiatorCharacterId,
            kind: root.kind,
            body: rootBody,
            trust: root.trust,
            sourceKind: "user",
            importance: anchor.importance ?? root.importance,
            expiresAt,
            sourceId,
            sourceVersion: 1,
            version: 1,
            createdAt: nowMs,
            updatedAt: nowMs,
          };
          store.insertEntry(entry, tokenize(rootBody));
          store.insertTemporaryEntryLink({
            entryId: entry.id,
            tempIdentityId: temporaryIdentityId,
            holderCharacterId: holder,
            expiresAt,
            longIdentityId: identityId,
            rootIdentityId,
          });
        }
        store.insertTemporaryLink({
          tempIdentityId: temporaryIdentityId,
          longIdentityId: identityId,
          holderCharacterId: holder,
          expiresAt,
        });
        updatedEntries += 1;
        affected.add(holder);
      }
    }
    const contextVersions = {};
    for (const holder of [...affected].sort()) {
      contextVersions[holder] = store.bumpContextVersion(holder, nowMs);
    }
    return {
      updated: updatedEntries,
      updatedEntries,
      updatedHolders: affected.size,
      skipped,
      affectedCharacters: [...affected].sort(),
      contextVersions,
    };
  }

  /* 显式转告/分享临时条目时复用权威校验结果；只有明确同一长期事实关联且
     当前有效的 holder long 才写入来源，收件人有任意别的长期记忆也不挂靠。 */
  function propagationSource({ entry, holderCharacterId, nowMs }) {
    if (!isTemporaryEntry(entry)) {
      return null;
    }
    const info = temporaryInfo(entry, nowMs);
    const parsed = parseTemporarySource(entry.sourceId);
    const link = linkOfEntry(entry, { write: true });
    if (!info || !parsed || !link || !entry.factIdentityId || entry.expiresAt === null) {
      throw new MemoryError("SHARE_NOT_ALLOWED", "这条临时理解已失效或关联不足。");
    }
    const ownIdentityId = link.ownLongIdentityId;
    const rootIdentityId = link.rootIdentityId;
    const anchor = holderLong(holderCharacterId, ownIdentityId, nowMs);
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
      timeSourceId: parsed.timeSourceId,
    });
    if (sourceId.length > limits.sourceId) {
      throw new MemoryError("INVALID_INPUT", "临时来源ID过长。");
    }
    return {
      sourceId,
      // 收件人无该 L 的明确长期锚时，own L 与 root L 相同；不凭空挂靠。
      longIdentityId: anchor ? ownIdentityId : rootIdentityId,
      rootIdentityId,
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
      // own L 用于抑制与查找；root L 只作来源链证明，不冒充本条长期锚。
      longIdentityId: result.holderLongIdentityId ?? result.sourceAnchorIdentityId,
      rootIdentityId: result.sourceAnchorIdentityId,
      originCharacterId: result.sourceCharacterId ?? entry.originCharacterId,
      relayFrom: result.relayFrom ?? null,
      edited: result.edited === true,
      timeAuthorizedToday: result.timeAuthorization === "today",
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

  /* buildContext 才体现“今日优先”：有效 current 抑制其明确关联的 own L；
     同 T+holder+正文+到期只注入一次，不同 T 即使同文也不合并。 */
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
        const key = [
          entry.characterId,
          entry.factIdentityId,
          entry.body,
          entry.expiresAt,
        ].join("\u0000");
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
    linkOfEntry,
    applyApprovedCorrectionToHolders,
    filterSearch,
    annotateContext,
  };
}

module.exports = { createMemoryTemporary };
