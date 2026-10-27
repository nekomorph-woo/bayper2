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
        const members = memory.listIdentityEntries(entry.factIdentityId);
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
            snapshot: memberSnapshot?.status === "ok" ? memberSnapshot : null,
            excludedSourceHashes: memory.listExcludedSources(member.characterId),
            sourceIncrements: incrementsFor(member.characterId),
          };
        });
        if (!forgetMode && memberEvidence.some((member) => !member.snapshot)) {
          continue;
        }
        seenIdentity.add(entry.factIdentityId);
        seenEntry.add(entry.id);
        candidates.push({
          characterId: holderId,
          entryId: entry.id,
          version: entry.version,
          factKey: entry.factKey,
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

  return { captureTargetEvidence, captureForgetTargetEvidence, captureCandidates, verify };
}

module.exports = { createChatMemoryVerification };
