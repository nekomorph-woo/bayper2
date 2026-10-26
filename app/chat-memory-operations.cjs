/* S03f 聊天中的明确记忆操作。
   模型只在同一次既有聊天响应里提出一个结构化建议；本模块用“分句 + 请求框架”
   核验用户原话，再按本地候选、目标版本和事务结果执行。不执行目录授权、全库清空、
   角色或业务进度修改，也不处理不同 factKey 的同义事实整合。 */
const { segmentQueryTokens } = require("./memory-retrieval.cjs");

const MAX_OPERATION_TEXT = 2000;
const MAX_FACT_KEY = 200; // 与 memory.cjs 的 factKey 上限一致
const ACTIONS = Object.freeze(["correct", "forget", "restrictSharing"]);
const GENERIC_TOKENS = new Set([
  "喜欢", "讨厌", "想要", "记得", "忘记", "事情", "东西",
  "偏好", "经历", "分享", "告诉", "用户", "角色", "记忆",
]);
/* 二元片段若含代词/虚词，容易把“帮我忘记”里的“我忘”误当成话题依据。 */
const NON_TOPIC_CHARS = new Set([
  "我", "你", "他", "她", "它", "们", "这", "那",
  "的", "了", "着", "过", "吗", "呢", "吧",
]);
/* 时间词只描述期限，不能单独证明用户指的是哪条事实。 */
const TIME_TOKENS = new Set([
  "今天", "今日", "今晚", "今夜", "明天", "明日", "昨天", "前天",
  "最近", "近来", "这几天", "这阵子", "暂时", "临时", "目前", "现在",
  "以前", "之前", "以后", "将来", "当时", "那时",
]);
const UNCERTAINTY = /(?:可能|大概|也许|或许|好像|似乎|说不定)/gu;
const TODAY = /(?:今天|今日|今晚|今夜)/u;
const EARLY_DAY = /(?:早上|上午|中午|下午|傍晚)/u;
const VAGUE = /(?:最近|近来|这几天|这阵子|暂时|临时|目前|现在)/u;
/* 没有实现真实期限的过去/未来/时段表达不能当成永久改写；一律先澄清。 */
const OTHER_TEMPORAL =
  /(?:昨天|前天|上周|上个月|去年|以前|之前|那时|当时|明天|明日|后天|大后天|本周|这周|下周|周末|月底|下个月|以后|将来|过几天|过阵子|早上|上午|中午|下午|傍晚|晚上|夜里|深夜|凌晨|白天|周一|周二|周三|周四|周五|周六|周日|周天|下个星期|这个星期|上个星期|待会儿|一会儿|过会儿)/u;
const REQUEST_FRAME =
  /(?:请|帮我|帮忙|麻烦|拜托|能不能|能否|可不可以|让你|愿意)/u;
const LEADING_CONNECTOR = /^(?:也|再|然后|并且|而且|同时|还有|另外|所以)/u;
const SELF_PREFIX =
  /^(?:只你|只有你|就你|仅你|你自己|只让|仅让|只在你|仅在你)/u;
const REPORTED_SPEECH =
  /(?:记忆|正文|提示|系统消息|助手)(?:里|中)?(?:说|写着|提到|要求)|(?:你|他|她|它)(?:之前|刚才|曾经|上次)?说(?!得|的)|(?:你|他|她|它)要求|(?:他|她|它)让你/u;
const HYPOTHETICAL = /(?:如果|假如|假设|要是|万一|若是|倘若)/u;
const NEGATED_BEFORE = /(?:不|别|没|未|勿|无需|不必|不用|不是|没有).{0,4}$/u;
const NEGATED_COMMAND_BEFORE = /(?:不是|没有|没)让你.{0,2}$/u;
const CLAUSE_SPLIT = /[。！？!?；;，,\n]+/u;
const EXPLICIT_CORRECTION = /不是[^。！？!?；;\n]{1,30}?(?:而是|是)/u;

const REPLIES = Object.freeze({
  notProcessed: "我这次没有改动任何记忆。",
  ambiguous: "我还不确定你指的是哪一件事，能具体说是哪条记忆吗？",
  multipleActions:
    "这句话里包含不止一个操作，我这次先不改动记忆；你想先纠正、忘记，还是禁止分享哪一件事？",
  temporalClarification:
    "你说的这个时间范围我还不确定，先不改动长期记忆；能说清楚是今天，还是到什么时候吗？",
  uncertaintyClarification:
    "这句话里有不确定的表达，我先不把它记成确定事实；你能确认一下具体意思吗？",
});

const FORGET_PATTERNS = Object.freeze([
  { pattern: /(?:忘记|忘掉|忘了|忘却)/gu, negation: "before" },
  { pattern: /(?:删除|删掉|删去|清除)/gu, negation: "before" },
  { pattern: /(?:不要|别|不用)(?:再)?(?:记得|记着|记)(?!住)/gu, negation: "command" },
]);
const CORRECT_PATTERNS = Object.freeze([
  { pattern: /(?:纠正|更正|改正)(?:一下|这条|这个)?/gu, negation: "before" },
  { pattern: /(?:我|用户)?(?:记错|说错)了?/gu, negation: "before" },
  { pattern: /(?:改成|改为|改过来|应该是)/gu, negation: "before" },
]);
const RESTRICT_PATTERNS = Object.freeze([
  { pattern: /(?:不要|别|不用)(?:再)?(?:分享|转告|传播|外传)/gu, negation: "command" },
  { pattern: /(?:不要|别|不用)(?:再)?(?:告诉(?!我)|跟(?!我|我们).{0,8}说)/gu, negation: "command" },
  { pattern: /(?:保密|不外传|不要说出去|别说出去)/gu, negation: "command" },
]);
const RULES = Object.freeze({
  forget: FORGET_PATTERNS,
  correct: CORRECT_PATTERNS,
  restrictSharing: RESTRICT_PATTERNS,
});

function normalizeGrounding(value) {
  return String(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

function hasMatch(pattern, text) {
  pattern.lastIndex = 0;
  const matched = pattern.test(text);
  pattern.lastIndex = 0;
  return matched;
}

function stripQuoted(text) {
  return text
    .replace(/“[^”]*”/gu, " ")
    .replace(/"[^"]*"/gu, " ")
    .replace(/「[^」]*」/gu, " ")
    .replace(/『[^』]*』/gu, " ")
    .replace(/‘[^’]*’/gu, " ");
}

function isBareCommand(action, clause, match) {
  const trimmed = clause.trim();
  if (action === "forget" && (SELF_PREFIX.test(trimmed) || /^把/u.test(trimmed))) {
    return true;
  }
  if (action === "restrictSharing" && match.index > 0) {
    const prefix = trimmed.slice(0, match.index);
    // 主题前缀后的句尾禁令（“我喜欢热茶这件事不要再告诉…”）是明确命令；
    // 以第三/第一人称主语开头的普通陈述仍不当作命令。
    if (/(?:这件事|这个事情|这点|这个)/u.test(prefix)) return true;
    if (!/^(?:我|你|他|她|它|我们|你们|他们|她们)/u.test(prefix)) return true;
  }
  const connector = trimmed.match(LEADING_CONNECTOR);
  return match.index === (connector ? connector[0].length : 0);
}

function findCommand(action, clause) {
  for (const rule of RULES[action]) {
    rule.pattern.lastIndex = 0;
    const match = rule.pattern.exec(clause);
    rule.pattern.lastIndex = 0;
    if (!match) {
      continue;
    }
    const before = clause.slice(0, match.index);
    if (rule.negation === "before" && NEGATED_BEFORE.test(before)) {
      continue;
    }
    if (rule.negation === "command" && NEGATED_COMMAND_BEFORE.test(before)) {
      continue;
    }
    if (REQUEST_FRAME.test(before.slice(-16)) || isBareCommand(action, clause, match)) {
      return match;
    }
  }
  return null;
}

/* 显式纠正允许“不是A，是B”这种跨逗号的声明式说法；问句和假设不算。 */
function explicitCorrectionOf(text) {
  for (const sentence of text.match(/[^。！？!?；;\n]+[。！？!?；;]?/gu) ?? []) {
    if (
      /[？?]$/u.test(sentence) ||
      HYPOTHETICAL.test(sentence) ||
      REPORTED_SPEECH.test(sentence)
    ) {
      continue;
    }
    const match = sentence.match(EXPLICIT_CORRECTION);
    if (match) {
      return sentence.trim();
    }
  }
  return null;
}

/* 返回本轮原话中实际成立的命令；普通叙述“我忘了带钥匙”没有请求框架，
   也不是赤裸命令，因此不会触发操作或候选构建。 */
function detectOperationIntent(userText) {
  const raw = typeof userText === "string" ? userText : "";
  const safeText = stripQuoted(raw);
  const clauses = [];
  for (const clause of safeText.split(CLAUSE_SPLIT).map((item) => item.trim())) {
    if (!clause || HYPOTHETICAL.test(clause) || REPORTED_SPEECH.test(clause)) {
      continue;
    }
    clauses.push(clause);
  }
  const authorized = [];
  for (const clause of clauses) {
    const actions = ACTIONS.filter((action) => findCommand(action, clause));
    if (actions.length > 0) {
      authorized.push({ clause, actions });
    }
  }
  const explicit = explicitCorrectionOf(safeText);
  if (explicit) {
    const existing = authorized.find((item) => item.actions.includes("correct"));
    if (existing) {
      existing.clause = `${existing.clause} ${explicit}`;
    } else {
      authorized.push({ clause: explicit, actions: ["correct"] });
    }
  }
  const actions = new Set(authorized.flatMap((item) => item.actions));
  const authorizedText = authorized.map((item) => item.clause).join(" ");
  if (actions.size > 1) {
    return { action: null, reason: "multiple_actions", scope: "all", authorizedText: "", clauses };
  }
  if (actions.size === 0) {
    return { action: null, reason: "none", scope: "all", authorizedText: "", clauses };
  }
  const [action] = actions;
  const temporalVague =
    action === "correct" &&
    clauses.some(
      (clause) =>
        hasMatch(VAGUE, clause) ||
        (hasMatch(TODAY, clause) && hasMatch(EARLY_DAY, clause)) ||
        (!hasMatch(TODAY, clause) && hasMatch(OTHER_TEMPORAL, clause)),
    );
  return {
    action,
    reason: null,
    scope: action === "forget" && SELF_PREFIX.test(authorizedText) ? "self" : "all",
    temporalHint: temporalVague ? "vague" : null,
    authorizedText,
    clauses,
  };
}

function buildOperationCandidates(entries) {
  return entries.map((entry, index) => ({ target: `M${index + 1}`, entry }));
}

function contentTokensOf(text) {
  const tokens = new Set();
  for (const token of segmentQueryTokens(text)) {
    if (
      token.text.length >= 2 &&
      !GENERIC_TOKENS.has(token.text) &&
      !TIME_TOKENS.has(token.text)
    ) {
      tokens.add(token.text);
    }
  }
  const han = [...normalizeGrounding(text)].filter((char) => /\p{Script=Han}/u.test(char));
  for (let index = 0; index + 1 < han.length; index += 1) {
    const bigram = `${han[index]}${han[index + 1]}`;
    if (
      !GENERIC_TOKENS.has(bigram) &&
      !TIME_TOKENS.has(bigram) &&
      ![...bigram].some((char) => NON_TOPIC_CHARS.has(char))
    ) {
      tokens.add(bigram);
    }
  }
  return [...tokens];
}

/* 否定句里的旧对象是纠正目标，不是“仍然相信旧事实”的证据。
   objectOf 只提取常见谓词后的对象，避免用单个“茶”字判定整条事实。 */
function objectOf(body) {
  const core = normalizeGrounding(body).replace(/^(?:用户|我们|我|角色)/u, "");
  for (const predicate of ["喜欢", "讨厌", "想要", "记得", "忘记", "住在", "工作在", "分享过", "有"]) {
    const index = core.lastIndexOf(predicate);
    if (index !== -1 && index + predicate.length < core.length) {
      return core.slice(index + predicate.length);
    }
  }
  return core.slice(-2);
}

function negatedObjectMatch(body, context) {
  const object = objectOf(body);
  if (!object) {
    return false;
  }
  let index = context.indexOf(object);
  while (index !== -1) {
    const before = context.slice(Math.max(0, index - 8), index);
    if (/(?:不是|不|没|非|未|无|别)(?:再)?(?:喜欢|想要|讨厌|记得|忘记|喝|吃|要|是)?$/u.test(before)) {
      return true;
    }
    index = context.indexOf(object, index + 1);
  }
  return false;
}

function candidateScore(candidate, normalizedContext) {
  if (!normalizedContext) {
    return 0;
  }
  const { body } = candidate.entry;
  const core = normalizeGrounding(body).replace(/^(?:用户|我们|我|角色)/u, "");
  let score = core.length >= 2 && normalizedContext.includes(core) ? 20 : 0;
  if (negatedObjectMatch(body, normalizedContext)) {
    score += 20;
  }
  for (const token of contentTokensOf(body)) {
    if (normalizedContext.includes(token)) {
      score += token.length;
    }
  }
  return score;
}

function matchingCandidates(candidates, context) {
  const normalized = normalizeGrounding(context);
  return candidates.filter((candidate) => candidateScore(candidate, normalized) > 0);
}

/* 当前话题或近期对话必须留下实际依据；唯一条目本身不算指代证据。
   纠正只移除新内容 token，保留用户原话里的否定对象（如“不是茶”）。 */
function resolveTarget({ action, candidates, userText, recentText, excerpt = "", target = null }) {
  let currentText = userText;
  if (action === "correct") {
    /* 只移除相对旧事实新增的对象词；纯否定翻转（喜欢茶→不喜欢茶）
       的对象词就是唯一话题依据，不能一并删掉。 */
    const oldTokens = new Set(contentTokensOf(target?.entry?.body ?? ""));
    currentText = normalizeGrounding(userText);
    for (const token of positiveTokensOf(excerpt)) {
      if (!oldTokens.has(token)) {
        currentText = currentText.split(token).join(" ");
      }
    }
  }
  const current = matchingCandidates(candidates, currentText);
  if (current.length === 1) {
    return current[0];
  }
  if (current.length > 1) {
    return null;
  }
  const recent = matchingCandidates(candidates, recentText);
  return recent.length === 1 ? recent[0] : null;
}

function validEvidence(action, evidence, userText, authorizedText) {
  if (
    typeof evidence !== "string" ||
    evidence.length === 0 ||
    evidence.length > MAX_OPERATION_TEXT
  ) {
    return false;
  }
  const normalized = normalizeGrounding(evidence);
  return (
    normalized.length >= 2 &&
    normalizeGrounding(userText).includes(normalized) &&
    normalizeGrounding(authorizedText).includes(normalized) &&
    detectOperationIntent(evidence).action === action
  );
}

/* 纠正正文必须是一个完整的安全分句，而不是模型改写的摘要。
   这样主体、否定、不确定词和时效词都来自用户原话。 */
function temporalOf(text) {
  return hasMatch(VAGUE, text)
    ? "vague"
    : hasMatch(TODAY, text) && !hasMatch(EARLY_DAY, text)
      ? "today"
      : hasMatch(TODAY, text) || hasMatch(OTHER_TEMPORAL, text)
        ? "vague"
        : "none";
}

/* excerpt 只是模型指到新内容的位置；本地用包含它的完整内容分句
   和相邻的否定/对比分句组成正文，避免保存“而是喜欢咖啡”这类半截句。 */
function correctionAnchor(excerpt, intent) {
  if (typeof excerpt !== "string" || excerpt.length === 0 || excerpt.length > MAX_OPERATION_TEXT) {
    return null;
  }
  const normalized = normalizeGrounding(excerpt);
  if (normalized.length < 1) {
    return null;
  }
  const single = intent.clauses
    .map((clause, index) => ({ clause, index }))
    .filter(({ clause }) => normalizeGrounding(clause).includes(normalized));
  if (single.length === 1) {
    if (isCommandClause(single[0].clause)) {
      return null;
    }
    return { start: single[0].index, end: single[0].index, text: excerpt };
  }
  if (single.length > 1) {
    return null;
  }
  for (let start = 0; start < intent.clauses.length; start += 1) {
    let joined = "";
    for (let end = start; end < intent.clauses.length; end += 1) {
      joined += normalizeGrounding(intent.clauses[end]);
      if (joined === normalized) {
        const range = intent.clauses.slice(start, end + 1);
        return range.some(isCommandClause)
          ? null
          : { start, end, text: range.join("，") };
      }
      if (!normalized.startsWith(joined)) {
        break;
      }
    }
  }
  return null;
}

function isCommandClause(clause) {
  return ACTIONS.some((action) => findCommand(action, clause));
}

function positiveTokensOf(text) {
  return contentTokensOf(text).filter((token) => !/[不没无别未非勿是]/u.test(token));
}

function substantiveTokensOf(text) {
  return positiveTokensOf(text).filter(
    (token) => !TIME_TOKENS.has(token) && !hasMatch(UNCERTAINTY, token),
  );
}

function correctionBody({ anchor, clauses }) {
  if (substantiveTokensOf(anchor.text).length === 0) {
    return clauses.some((clause) => hasMatch(UNCERTAINTY, clause))
      ? { needsClarification: true }
      : null;
  }
  let start = anchor.start;
  let end = anchor.end;
  if (anchor.start === anchor.end) {
    const includeNegation = (clause) => !isCommandClause(clause) && /(?:不是|不|没|未|非|无|别)/u.test(clause);
    if (start > 0 && includeNegation(clauses[start - 1])) {
      start -= 1;
    } else if (end + 1 < clauses.length && includeNegation(clauses[end + 1])) {
      end += 1;
    }
  }
  const body = clauses.slice(start, end + 1).join("，");
  if (body.length > MAX_OPERATION_TEXT) {
    return null;
  }
  if (!hasMatch(UNCERTAINTY, body) && clauses.some((clause) => hasMatch(UNCERTAINTY, clause))) {
    return { needsClarification: true };
  }
  return {
    body,
    trust: hasMatch(UNCERTAINTY, body) ? "inferred" : "stated",
    temporal: temporalOf(body),
  };
}

function planOperation({
  operationPresent,
  operation,
  intent,
  candidates,
  userText,
  recentText,
}) {
  if (!operationPresent) {
    if (intent.reason === "multiple_actions") {
      return { kind: "respond", reply: REPLIES.multipleActions };
    }
    if (intent.action === "correct" && intent.temporalHint === "vague") {
      return { kind: "respond", reply: REPLIES.temporalClarification };
    }
    return intent.action
      ? { kind: "respond", reply: REPLIES.notProcessed }
      : { kind: "none" };
  }
  if (intent.reason === "multiple_actions") {
    return { kind: "respond", reply: REPLIES.multipleActions };
  }
  if (!intent.action) {
    return { kind: "respond", reply: REPLIES.notProcessed };
  }
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    return { kind: "respond", reply: REPLIES.notProcessed };
  }
  const action = operation.action;
  if (typeof action !== "string" || !RULES[action] || action !== intent.action) {
    return { kind: "respond", reply: REPLIES.notProcessed };
  }
  if (typeof operation.target !== "string") {
    return { kind: "respond", reply: REPLIES.notProcessed };
  }
  const target = candidates.find((candidate) => candidate.target === operation.target);
  if (!target) {
    return { kind: "respond", reply: REPLIES.notProcessed };
  }
  const evidence = typeof operation.evidence === "string" ? operation.evidence.trim() : "";
  if (!validEvidence(action, evidence, userText, intent.authorizedText)) {
    return { kind: "respond", reply: REPLIES.notProcessed };
  }

  if (action === "correct") {
    const excerpt = typeof operation.excerpt === "string" ? operation.excerpt.trim() : "";
    const anchor = correctionAnchor(excerpt, intent);
    if (!anchor) {
      return { kind: "respond", reply: REPLIES.notProcessed };
    }
    const resolved = resolveTarget({ action, candidates, userText, recentText, excerpt, target });
    if (!resolved) {
      return { kind: "respond", reply: REPLIES.ambiguous };
    }
    if (resolved.target !== target.target) {
      return { kind: "respond", reply: REPLIES.notProcessed };
    }
    const info = correctionBody({ anchor, clauses: intent.clauses });
    if (!info) {
      return { kind: "respond", reply: REPLIES.notProcessed };
    }
    if (info.needsClarification) {
      return { kind: "respond", reply: REPLIES.uncertaintyClarification };
    }
    if (info.temporal === "vague") {
      return { kind: "respond", reply: REPLIES.temporalClarification };
    }
    const mode =
      info.temporal === "today" && target.entry.expiresAt === null
        ? "temporary"
        : "replace";
    if (
      mode === "temporary" &&
      `${target.entry.factKey}.current.${target.entry.id}`.length > MAX_FACT_KEY
    ) {
      return { kind: "respond", reply: REPLIES.notProcessed };
    }
    return {
      kind: "execute",
      operation: {
        action,
        target,
        excerpt,
        body: info.body,
        evidence,
        trust: info.trust,
        mode,
        expiresToday: info.temporal === "today",
      },
    };
  }

  const resolved = resolveTarget({ action, candidates, userText, recentText });
  if (!resolved) {
    return { kind: "respond", reply: REPLIES.ambiguous };
  }
  if (resolved.target !== target.target) {
    return { kind: "respond", reply: REPLIES.notProcessed };
  }
  // 持有范围只由用户本轮原话决定；模型返回的 scope 不作为授权。
  return {
    kind: "execute",
    operation:
      action === "forget"
        ? { action, target, scope: intent.scope, evidence }
        : { action, target, evidence },
  };
}

function endOfLocalDay(nowMs) {
  const date = new Date(nowMs);
  date.setHours(23, 59, 59, 999);
  return date.getTime();
}

/* 长期事实不覆盖；今天的当前理解写入独立的 .current 事实并在当天结束失效。
   若已有同一条临时理解，复用其 factKey 并以 factKey 路径更新。 */
function applyTemporaryCorrection({ memory, characterId, entry, operation, nowMs, userSourceId }) {
  const factKey = `${entry.factKey}.current.${entry.id}`;
  const expiresAt = endOfLocalDay(nowMs);
  const sourceId = `chat-current:${entry.id}:${nowMs}:${userSourceId}`;
  let result;
  try {
    result = memory.correct({
      characterId,
      factKey,
      body: operation.body,
      trust: operation.trust,
      expiresAt,
      sourceId,
      nowMs,
      inTransaction: true,
    });
  } catch (error) {
    if (error?.code !== "FACT_NOT_HELD") {
      throw error;
    }
    result = memory.remember({
      characterId,
      factKey,
      body: operation.body,
      kind: entry.kind,
      trust: operation.trust,
      importance: entry.importance,
      expiresAt,
      sourceId,
      createdAt: nowMs,
      // 当前聊天分句是用户新的明确陈述；允许重新建立被忘记的临时理解。
      explicitConsent: true,
      inTransaction: true,
    });
    if (!result.created) {
      const error = new Error("临时理解未能写入。");
      error.code = "TEMP_NOT_WRITTEN";
      throw error;
    }
  }
  return { ...result, mode: "temporary", expiresAt, longTermFactKey: entry.factKey };
}

function applyChatOperation({ memory, characterId, operation, nowMs, userSourceId }) {
  const entry = operation.target.entry;
  const selection = {
    characterId,
    entryId: entry.id,
    expectedVersion: entry.version,
    nowMs,
    inTransaction: true,
  };
  if (operation.action === "correct") {
    if (operation.mode === "temporary") {
      return applyTemporaryCorrection({
        memory,
        characterId,
        entry,
        operation,
        nowMs,
        userSourceId,
      });
    }
    return {
      ...memory.correct({
        ...selection,
        body: operation.body,
        trust: operation.trust,
        sourceId: `chat-correct:${entry.id}:${entry.version + 1}:${userSourceId}`,
        ...(operation.expiresToday ? { expiresAt: endOfLocalDay(nowMs) } : {}),
      }),
      mode: "replace",
    };
  }
  if (operation.action === "forget") {
    return memory.forget({
      ...selection,
      scope: operation.scope,
      sourceIdsToExclude: [userSourceId],
    });
  }
  return memory.restrictSharing(selection);
}

function operationReply(operation, result) {
  if (operation.action === "correct") {
    if (result?.mode === "temporary") {
      return operation.trust === "inferred"
        ? "好，我按你不确定的说法记下了你今天的情况；它只到今天结束有效，原来的长期内容仍然保留。"
        : "好，我记下了你今天的这条情况；它只到今天结束有效，原来的长期内容仍然保留。";
    }
    if (operation.expiresToday) {
      return operation.trust === "inferred"
        ? "好，我按你不确定的说法记下了你今天的这条情况；它只在今天有效。"
        : "好，我记下了你今天的这条情况；它只在今天有效。";
    }
    return operation.trust === "inferred"
      ? `好，我按你不确定的说法把这条记为“${operation.body}”；原来源不会自动恢复。`
      : `好，这条记忆已按你给的原话更新为“${operation.body}”；原来源不会自动恢复。`;
  }
  if (operation.action === "forget") {
    return operation.scope === "self"
      ? "好，这件事我只在自己这里忘记；其他角色已知的内容不会因此改变。"
      : "好，我已删除这件事的已有记录；旧来源不会自动恢复，如果以后你重新告诉我，我会按新的内容重新理解。";
  }
  return result?.alreadyRestricted
    ? "这件事之前就已经限制分享，我会继续保持；已经知道的内容不会因此撤回。"
    : "好，之后我不会再把这件事分享或转告给其他角色；已经知道的内容不会因此撤回。";
}

module.exports = {
  REPLIES,
  buildOperationCandidates,
  detectOperationIntent,
  planOperation,
  applyChatOperation,
  operationReply,
};
