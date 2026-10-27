/* S03m 2a 内核验：只读捕获独立候选，并对目标与候选做一次有界关系判定。
   不写入记忆/聊天，不读取凭据，不把候选正文放进角色回复或角色聊天上下文。
   区分为真实 identity 的独立候选；同一 identity 由阶段 1 本地纠正覆盖。 */
const {
  buildRelationMessages,
  parseRelationResponse,
} = require("./memory-relation-protocol.cjs");
const crypto = require("node:crypto");

const hashSourceId = (sourceId) =>
  crypto.createHash("sha256").update(sourceId, "utf8").digest("hex");

const PER_HOLDER_LIMIT = 3;
const MAX_CANDIDATES = 8;
const MAX_VERIFICATION_PAIRS = 8;
const VERIFICATION_TIMEOUT_MS = 15000;
const MAX_VERIFICATION_TOKENS = 4000;
const MAX_QUERY_CHARS = 200;

function sameFactMetadata(left, right) {
  return (
    left.kind === right.kind &&
    left.trust === right.trust &&
    (left.sourceKind ?? "user") === (right.sourceKind ?? "user") &&
    (left.expiresAt ?? null) === (right.expiresAt ?? null)
  );
}

function createChatMemoryVerification({
  memory,
  memorySourceContext,
  requestChatCompletion,
  now = () => Date.now(),
} = {}) {
  const clock = typeof now === "function" ? now : () => now;

  /* 阶段 0 只读捕获目标旧事实证据；旧 snapshot 在阶段 1 之后不再 isCurrent，
     阶段 2 用 isEvidenceCurrent 窄复核。失败返回 null，由调用方降级本地完成。 */
  function captureTargetEvidence({ characterId, targetEntry, nowMs = clock() }) {
    if (!targetEntry) {
      return null;
    }
    try {
      const snapshot = memorySourceContext.resolve({
        characterId,
        entryId: targetEntry.id,
        expectedVersion: targetEntry.version,
        nowMs,
      });
      if (snapshot.status !== "ok" || snapshot.direct === false) {
        return null;
      }
      const identityEntries = targetEntry.factIdentityId
        ? memory.listIdentityEntries(targetEntry.factIdentityId)
        : [];
      const incrementsByHolder = {};
      for (const entry of identityEntries) {
        if (!incrementsByHolder[entry.characterId]) {
          incrementsByHolder[entry.characterId] = [];
        }
        incrementsByHolder[entry.characterId].push(hashSourceId(entry.sourceId));
      }
      return {
        snapshot,
        excludedSourceHashes: memory.listExcludedSources(characterId),
        allowedSourceHashes: incrementsByHolder[characterId] ?? [],
        sourceIncrementsByHolder: incrementsByHolder,
      };
    } catch {
      return null;
    }
  }

  /* 临时当日理解：阶段 0 的 left 必须是 own L 长期锚的旧事实，不能是今日 body。
     无有效长期锚的 relay 条目不进入两阶段。 */
  function captureTemporaryTargetEvidence({ characterId, targetEntry, nowMs = clock() }) {
    if (!targetEntry) {
      return null;
    }
    try {
      let anchor = targetEntry;
      let temporaryInfo = null;
      if (typeof memory.getTemporaryTarget === "function") {
        const info = memory.getTemporaryTarget({
          characterId,
          entryId: targetEntry.id,
          nowMs,
        });
        if (info) {
          if (!info.anchorEntryId || !info.anchorIdentityId || !info.anchorVersion) {
            return null;
          }
          temporaryInfo = info;
          anchor = memory.getHeldEntry({
            characterId,
            entryId: info.anchorEntryId,
          });
        }
      }
      if (!anchor || anchor.characterId !== characterId ||
        anchor.expiresAt !== null ||
        anchor.trust !== "stated" ||
        (anchor.sourceKind ?? "user") !== "user") {
        return null;
      }
      const snapshot = memorySourceContext.resolve({
        characterId,
        entryId: anchor.id,
        expectedVersion: anchor.version,
        nowMs,
      });
      if (snapshot.status !== "ok") {
        return null;
      }
      /* temporary 阶段 1 不改长期条目，因此不预置长期来源增量；只允许阶段 1
         实际写入的 sourceControls（由 chat 在阶段 1 后回填）。 */
      return {
        snapshot,
        anchorEntry: anchor,
        anchorEntryId: anchor.id,
        anchorVersion: anchor.version,
        anchorSourceId: anchor.sourceId,
        anchorBody: anchor.body,
        temporary: temporaryInfo,
        excludedSourceHashes: memory.listExcludedSources(characterId),
        allowedSourceHashes: [],
        sourceIncrementsByHolder: {},
      };
    } catch {
      return null;
    }
  }

  function captureForgetTargetEvidence({ characterId, targetEntry, nowMs = clock() }) {
    if (!targetEntry || !targetEntry.factIdentityId) {
      return null;
    }
    try {
      const snapshot = memorySourceContext.resolve({
        characterId,
        entryId: targetEntry.id,
        expectedVersion: targetEntry.version,
        nowMs,
      });
      if (snapshot.status !== "ok" || !snapshot.sourceMessage) {
        return null;
      }
      return {
        snapshot,
        identityId: targetEntry.factIdentityId,
        excludedSourceHashes: memory.listExcludedSources(characterId),
        allowedSourceHashes: [],
      };
    } catch {
      return null;
    }
  }

  function captureCandidates({
    characterId,
    holderCharacterIds,
    targetEntry,
    sourceIncrementsByHolder = {},
    forgetMode = false,
    allowProvenDerivedMembers = false,
    nowMs = clock(),
  }) {
    const incrementsFor = (holderId) =>
      Array.isArray(sourceIncrementsByHolder?.[holderId])
        ? sourceIncrementsByHolder[holderId]
        : [];
    if (!targetEntry || !targetEntry.factIdentityId ||
      targetEntry.trust !== "stated" ||
      (targetEntry.sourceKind ?? "user") !== "user" ||
      (targetEntry.expiresAt !== null && targetEntry.expiresAt !== undefined)) {
      return { candidates: [], truncated: false };
    }
    const query = String(targetEntry.body ?? "").slice(-MAX_QUERY_CHARS);
    if (!query) {
      return { candidates: [], truncated: false };
    }
    const seenIdentity = new Set([targetEntry.factIdentityId]);
    const seenEntry = new Set([targetEntry.id]);
    const candidates = [];
    let truncated = false;
    const holders = [...new Set(holderCharacterIds)].filter(
      (holderId) => typeof holderId === "string" && holderId !== "",
    );
    for (const holderId of holders) {
      const hits = memory.searchMemories({
        characterId: holderId,
        query,
        strategy: "broad",
        nowMs,
        limit: PER_HOLDER_LIMIT,
      });
      if (hits.length >= PER_HOLDER_LIMIT) {
        truncated = true;
      }
      for (const entry of hits) {
        if (candidates.length >= MAX_CANDIDATES) {
          truncated = true;
          break;
        }
        if (
          seenEntry.has(entry.id) ||
          !entry.factIdentityId ||
          seenIdentity.has(entry.factIdentityId) ||
          entry.derived ||
          entry.expiresAt !== null ||
          entry.trust !== "stated" ||
          (entry.sourceKind ?? "user") !== "user" ||
          !sameFactMetadata(targetEntry, entry)
        ) {
          continue;
        }
        const snapshot = memorySourceContext.resolve({
          characterId: holderId,
          entryId: entry.id,
          expectedVersion: entry.version,
          nowMs,
        });
        if (snapshot.status !== "ok" || snapshot.direct === false) {
          continue;
        }
        const members = memory.listIdentityEntries(entry.factIdentityId)
          .filter((member) =>
            typeof memory.isKnownCharacter !== "function" ||
            memory.isKnownCharacter(member.characterId));
        if (members.length === 0) {
          continue;
        }
        const memberEvidence = members.map((member) => {
          let memberSnapshot = null;
          try {
            memberSnapshot = memorySourceContext.resolve({
              characterId: member.characterId,
              entryId: member.id,
              expectedVersion: member.version,
              nowMs,
            });
          } catch {
            memberSnapshot = null;
          }
          return {
            characterId: member.characterId,
            entryId: member.id,
            version: member.version,
            sourceId: member.sourceId,
            factIdentityId: member.factIdentityId,
            derived: member.derived,
            derivedFromEntryId: member.derivedFromEntryId,
            narratorCharacterId: member.narratorCharacterId,
            derivationSourceId: member.derivationSourceId,
            derivationSourceVersion: member.derivationSourceVersion,
            snapshot: memberSnapshot?.status === "ok" ? memberSnapshot : null,
            excludedSourceHashes: memory.listExcludedSources(member.characterId),
            sourceIncrements: incrementsFor(member.characterId),
          };
        });
        if (!forgetMode) {
          const missingSnapshot = memberEvidence.some((member) => !member.snapshot);
          if (missingSnapshot &&
            !(allowProvenDerivedMembers &&
              provenDerivedMembers(memberEvidence, entry.id))) {
            continue;
          }
        }
        seenIdentity.add(entry.factIdentityId);
        seenEntry.add(entry.id);
        candidates.push({
          characterId: holderId,
          entryId: entry.id,
          version: entry.version,
          factKey: entry.factKey,
          sourceId: entry.sourceId,
          kind: entry.kind,
          trust: entry.trust,
          sourceKind: entry.sourceKind ?? "user",
          expiresAt: entry.expiresAt ?? null,
          identityId: entry.factIdentityId,
          snapshot,
          excludedSourceHashes: memory.listExcludedSources(holderId),
          sourceIncrements: incrementsFor(holderId),
          members: memberEvidence,
        });
      }
      if (candidates.length >= MAX_CANDIDATES) {
        break;
      }
    }
    return { candidates, truncated };
  }

  /* 一次系统级关系请求；pair 顺序与 candidates 一致，返回值按 pair 映射。
     Expected 不进入请求；错误/超时/结构失败由调用方回滚阶段 2。 */
  async function verify({ targetSnapshot, candidates, credentials, signal }) {
    if (!Array.isArray(candidates) || candidates.length === 0 ||
      candidates.length > MAX_VERIFICATION_PAIRS) {
      return { results: [] };
    }
    const pairs = candidates.map((candidate, index) => ({
      id: `p${index + 1}`,
      left: {
        text: targetSnapshot.excerpt,
        kind: candidate.kind,
        sourceKind: candidate.sourceKind,
        trust: candidate.trust,
        holder: targetSnapshot.holderCharacterId,
        participants: null,
        sourceContext: targetSnapshot,
      },
      right: {
        text: candidate.snapshot.excerpt,
        kind: candidate.kind,
        sourceKind: candidate.sourceKind,
        trust: candidate.trust,
        holder: candidate.characterId,
        participants: null,
        sourceContext: candidate.snapshot,
      },
    }));
    const completion = await requestChatCompletion(
      {
        ...credentials,
        messages: buildRelationMessages(pairs),
        timeoutMs: VERIFICATION_TIMEOUT_MS,
        maxTokens: MAX_VERIFICATION_TOKENS,
        signal,
      },
      undefined,
    );
    const parsed = parseRelationResponse(completion.content, pairs);
    const candidateByPair = new Map(
      pairs.map((pair, index) => [pair.id, candidates[index]]),
    );
    return {
      results: parsed.results.map((result) => ({
        candidate: candidateByPair.get(result.pair),
        effectiveRelation: result.effectiveRelation,
        relation: result.relation,
        reasons: result.reasons,
      })),
    };
  }

  return {
    captureTargetEvidence,
    captureTemporaryTargetEvidence,
    captureForgetTargetEvidence,
    captureCandidates,
    verify,
  };
}

function provenDerivedMember(member, byId, representativeId) {
  const seen = new Set();
  let current = member;
  while (current) {
    const entryId = current.entryId ?? current.id;
    if (entryId === representativeId || current.snapshot) {
      return true;
    }
    if (seen.has(entryId)) {
      return false;
    }
    seen.add(entryId);
    if (!current.derived || !current.derivedFromEntryId ||
      !current.narratorCharacterId ||
      current.derivationSourceId !== current.sourceId ||
      current.derivationSourceVersion !== 1) {
      return false;
    }
    const parent = byId.get(current.derivedFromEntryId);
    if (!parent ||
      (parent.factIdentityId ?? null) !== (current.factIdentityId ?? null) ||
      (parent.characterId ?? parent.holder) !== current.narratorCharacterId) {
      return false;
    }
    current = parent;
  }
  return false;
}

/* 缺来源快照的长期成员只能经持久派生链到达本候选已验证代表；每个父子角色、
   同一 identity、source/derivation 与版本都核，环/断链一律拒绝。 */
function provenDerivedMembers(members, representativeId) {
  const byId = new Map(members.map((member) => [member.entryId ?? member.id, member]));
  return members.every((member) => {
    const entryId = member.entryId ?? member.id;
    if (entryId === representativeId || member.snapshot) {
      return true;
    }
    return provenDerivedMember(member, byId, representativeId);
  });
}

module.exports = {
  createChatMemoryVerification,
  provenDerivedMembers,
};
