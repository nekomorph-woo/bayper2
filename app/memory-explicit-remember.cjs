/* S03r 用户明确要求记住的本地授权定位。
   只读取本轮用户原话：把“记住”命令定位到紧邻的事实段，供聊天保存候选时
   由本地决定是否提升优先级；模型候选、回复和记忆正文都不能授予该权限。
   同时识别“不要记住/不要保存”的否定命令，只把所指事实段排除在本轮保存外，
   不删除既有条目，也不牵连同一轮的其他独立事实。
   跨键改述或“刚才那件事”等指代不在这里猜，宁可不写或澄清。
   分句、引号掩码和请求框架沿用聊天既有做法；本模块不执行读写。 */

const { normalizeGrounding } = require("./chat-memory-operations.cjs");

const SENTENCE_SPLIT = /[。！？!?；;\n]+/gu;
const CLAUSE_SPLIT = /[，,]+/gu;
const HYPOTHETICAL = /(?:如果|假如|假设|要是|万一|若是|倘若)/u;
const QUESTION_END =
  /(?:[？?]|(?:吗|呢)[。！!]?)\s*$/u;
const LEADING_CONNECTOR =
  /^(?:也|再|然后|并且|而且|同时|还有|所以|另外|顺便)/u;
/* 只认句首命令或请求框架，且命令必须紧贴分句开头；不认“我记得”“你记得吗”
   这类陈述/询问，也不认“我让你记住”这类带主语的说法。 */
const REMEMBER_COMMAND =
  /^(?:(?:请(?:你)?|帮我|帮忙|麻烦(?:你)?|拜托(?:你)?|让你)(?:帮我|帮忙)?)?(?:记住|记一下|记下来|记着|别忘了|别忘记|不要忘记)/u;
/* 明确不要保存：允许既有请求前缀（请不要记住/请别保存/麻烦你不要保存）；
   只排除所指事实段，不执行删除或 forget。 */
const NEGATED_REMEMBER_COMMAND =
  /^(?:(?:请(?:你)?|帮我|帮忙|麻烦(?:你)?|拜托(?:你)?|让你)(?:帮我|帮忙)?)?(?:不要|别|不用|无需|不必)(?:再)?(?:记住|记一下|记下来|记着|保存)/u;
const TOPIC_SWITCH =
  /^(?:另外|顺便|还有|同时|而且|并且|至于|对了|不过|但是|可是|然后)/u;
/* 去掉命令和引号后仍只剩指代/时间，不算可定位的事实。 */
const REFERENCE_ONLY =
  /^(?:(?:我)?(?:刚才|刚刚|之前|上次)?(?:说|提|讲)?(?:的)?(?:这|那)(?:个|件|些)?(?:事情?|东西|内容|话|记忆)?|(?:我)?(?:刚才|刚刚|之前|上次)(?:说|提|讲)(?:的)?(?:事情?|东西|内容|话|记忆)?|(?:刚才|刚刚|之前|上次))$/u;

const REPLIES = Object.freeze({
  // 不声称整轮零改动：同一轮其他独立事实仍可能已按普通规则保存。
  ambiguous: "我还不能确定你要我记住的是哪件事，这条内容没有保存成长期记忆。能再具体说一下吗？",
  // 有独立事实已保存/提升时，先如实说明能确认的部分，再澄清其余内容。
  ambiguousPartial: "能确认的那部分已经按原话记下了；你让我记住的内容我还不能确定，能再具体说一下吗？",
  notSaved: "这条内容我这次没有保存成长期记忆。",
  partial: "能确认的那部分我已经按原话记下了；还有内容这次没有保存成长期记忆。",
  operationSuffix: "\n\n这次我优先按你的操作处理，没有另外保存“记住”的内容。",
});

/* 引号里的命令不能授权；用等长空格替换，保持原文偏移可用于内容切片。 */
function maskQuoted(text) {
  let masked = text;
  for (const pattern of [
    /“[^”]*”/gu,
    /"[^"]*"/gu,
    /「[^」]*」/gu,
    /『[^』]*』/gu,
    /‘[^’]*’/gu,
  ]) {
    masked = masked.replace(pattern, (match) => " ".repeat(match.length));
  }
  return masked;
}

/* 返回文本区间，保留 start/end 以便在未掩码原文上取内容；
   separator 用于判断句末问号，因为分隔符本身不在 text 里。 */
function splitSpans(text, pattern) {
  const spans = [];
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    spans.push({ start, end: match.index, separator: match[0] });
    start = match.index + match[0].length;
  }
  spans.push({ start, end: text.length, separator: "" });
  return spans
    .map((span) => ({ ...span, text: text.slice(span.start, span.end) }))
    .filter((span) => span.text.trim() !== "");
}

function commandInClause(clause) {
  let offset = 0;
  let rest = clause.text.trimStart();
  offset += clause.text.length - rest.length;
  const connector = rest.match(LEADING_CONNECTOR);
  if (connector) {
    offset += connector[0].length;
    rest = rest.slice(connector[0].length);
  }
  const negated = rest.match(NEGATED_REMEMBER_COMMAND);
  if (negated) {
    return { end: offset + negated[0].length, negative: true };
  }
  const command = rest.match(REMEMBER_COMMAND);
  return command ? { end: offset + command[0].length, negative: false } : null;
}

function sentenceIsQuestion(sentence) {
  const text = `${sentence.text}${sentence.separator}`;
  return /[？?]\s*$/u.test(text) || /(?:吗|呢)\s*[。！!]?\s*$/u.test(text);
}

/* 返回命令、否定排除段和无法定位的段。commands 才参与提升；blocked 与
   ambiguous 都只用于把对应候选排除在本轮保存外，不删除已有条目。 */
function analyzeExplicitRemember(userText) {
  if (typeof userText !== "string" || userText.trim() === "") {
    return { kind: "none", commands: [], blocked: [], ambiguous: [] };
  }
  const masked = maskQuoted(userText);
  const commands = [];
  const blocked = [];
  const ambiguous = [];
  for (const sentence of splitSpans(masked, SENTENCE_SPLIT)) {
    if (sentenceIsQuestion(sentence) || HYPOTHETICAL.test(sentence.text)) {
      continue;
    }
    const clauses = splitSpans(sentence.text, CLAUSE_SPLIT).map((span) => ({
      start: sentence.start + span.start,
      end: sentence.start + span.end,
      text: span.text,
    }));
    for (let index = 0; index < clauses.length; index += 1) {
      const clause = clauses[index];
      const command = commandInClause(clause);
      if (!command) {
        continue;
      }
      let content = userText.slice(clause.start + command.end, clause.end).trim();
      if (!content) {
        const next = clauses[index + 1];
        if (next && !TOPIC_SWITCH.test(next.text.trim()) && !commandInClause(next)) {
          content = userText.slice(next.start, next.end).trim();
        }
      }
      if (!content) {
        /* 常见尾随请求“我喜欢无糖咖啡，请记住”：命令本身为空时，取紧邻的
           前一分句；不跨主题词向前扩，也不把整轮都当作内容。 */
        const previous = clauses[index - 1];
        if (previous && !commandInClause(previous)) {
          content = userText.slice(previous.start, previous.end).trim();
        }
      }
      const normalized = normalizeGrounding(content);
      const locatable = Boolean(content) && normalized.length >= 2 &&
        !REFERENCE_ONLY.test(normalized);
      if (command.negative) {
        /* 否定命令即使只指向“那件事”，也可用于排除同名候选；不要求能提升。 */
        if (content && normalized.length >= 2) {
          blocked.push({ content, normalized });
        }
        continue;
      }
      if (locatable) {
        commands.push({ content, normalized });
      } else if (content || normalized) {
        // 指代或空内容：只排除能匹配上的候选，其他独立事实仍可保存。
        ambiguous.push({ content, normalized });
      } else {
        ambiguous.push({ content: "", normalized: "" });
      }
    }
  }
  if (commands.length === 0 && blocked.length === 0 && ambiguous.length === 0) {
    return { kind: "none", commands: [], blocked: [], ambiguous: [] };
  }
  const kind = commands.length > 0
    ? (blocked.length === 0 && ambiguous.length === 0 ? "authorized" : "mixed")
    : (ambiguous.length > 0 ? "ambiguous" : "blocked");
  return { kind, commands, blocked, ambiguous };
}

const TRAILING_REMEMBER_COMMAND =
  /(?:请(?:你)?|帮我|帮忙|麻烦(?:你)?|拜托(?:你)?|让你)(?:帮我|帮忙)?(?:记住|记一下|记下来|记着|别忘了|别忘记|不要忘记)$/u;

/* 去掉候选正文可能带的命令前缀/尾随命令与“我/用户”主语，再做方向明确的比较。 */
function normalizedCandidateBody(body) {
  let normalized = normalizeGrounding(body).replace(/^(?:用户|我们|我|角色)/u, "");
  const leading = normalized.match(REMEMBER_COMMAND);
  if (leading) {
    normalized = normalized.slice(leading[0].length);
  }
  return normalized.replace(TRAILING_REMEMBER_COMMAND, "");
}

/* 正向授权只允许候选完整落在授权事实段内：候选是事实段的一部分可以，
   反向包含则说明把“另外”等未授权内容也带进来了，必须按含混处理。 */
function candidateRelation(body, content) {
  const normalized = normalizedCandidateBody(body);
  if (normalized.length < 2) {
    return "none";
  }
  if (content.includes(normalized)) {
    return "authorized";
  }
  return normalized.includes(content) ? "mixed" : "none";
}

/* 否定/歧义排除的方向不同：候选包含被拒绝事实时整条宽候选都不能落库，
   不能因为正文更长就漏过。 */
function rejectedOverlap(body, content) {
  const normalized = normalizedCandidateBody(body);
  return normalized.length >= 2 &&
    (content.includes(normalized) || normalized.includes(content));
}

function matchesSpans(spans, candidates) {
  return candidates.filter((item) =>
    spans.some((span) =>
      span.normalized && rejectedOverlap(item.body, span.normalized)));
}

function resolveExplicitRemember(plan, candidates) {
  if (!plan || plan.kind === "none") {
    return {
      status: "none",
      matches: [],
      boosted: new Set(),
      blockedKeys: new Set(),
      clarify: false,
      blockedMatched: false,
      blockedRequested: false,
    };
  }
  /* 否定段和无法定位段只排除能匹配上的候选；其他候选继续按原规则处理。 */
  const excluded = [
    ...matchesSpans(plan.blocked ?? [], candidates),
    ...matchesSpans(plan.ambiguous ?? [], candidates),
  ];
  const blockedKeys = new Set(excluded.map((item) => item.factKey));
  const available = candidates.filter((item) => !blockedKeys.has(item.factKey));
  /* 逐候选判断与授权事实段的方向：完整落在段内才授权；只包含整个段却
     多出“另外”内容则视为混合，既不提升也不默认保存。 */
  const relationByKey = new Map();
  for (const item of available) {
    let relation = "none";
    for (const command of plan.commands ?? []) {
      const next = candidateRelation(item.body, command.normalized);
      if (next === "authorized") {
        relation = "authorized";
        break;
      }
      if (next === "mixed") {
        relation = "mixed";
      }
    }
    relationByKey.set(item.factKey, relation);
  }
  const mixedKeys = new Set(
    [...relationByKey]
      .filter(([, relation]) => relation === "mixed")
      .map(([key]) => key),
  );
  for (const key of mixedKeys) {
    blockedKeys.add(key);
  }
  const matches = (plan.commands ?? []).map((command) => ({
    command,
    matchedFactKeys: available
      .filter((item) =>
        relationByKey.get(item.factKey) === "authorized" &&
        candidateRelation(item.body, command.normalized) === "authorized")
      .map((item) => item.factKey),
  }));
  const boosted = new Set(matches.flatMap((match) => match.matchedFactKeys));
  const clarify = (plan.ambiguous ?? []).length > 0 || mixedKeys.size > 0 ||
    matches.some((match) => match.matchedFactKeys.length === 0);
  const status = clarify ? "ambiguous" : boosted.size > 0 ? "resolved" : "blocked";
  return {
    status,
    matches,
    boosted,
    blockedKeys,
    clarify,
    blockedMatched: blockedKeys.size > 0,
    blockedRequested: (plan.blocked ?? []).length > 0,
  };
}

/* 先把否定/歧义段候选排除，再给真正被授权的事实附加本地标记。
   模型无法通过候选字段自行取得 explicitRemember。 */
function markExplicitRememberCandidates(candidates, resolution) {
  const blocked = resolution?.blockedKeys ?? new Set();
  const boosted = resolution?.boosted ?? new Set();
  return candidates
    .filter((item) => !blocked.has(item.factKey))
    .map((item) =>
      boosted.has(item.factKey) ? { ...item, explicitRemember: true } : item);
}

/* 按命令逐条核对真实写入结果：新建、提升或原本已达标才算完成；
   冲突、门禁拦截或失效都不得被模型 reply 冒充成功。 */
function summarizeExplicitRememberResult(resolution, facts = []) {
  if (!resolution || resolution.status !== "resolved" ||
    !Array.isArray(resolution.matches) || resolution.matches.length === 0) {
    return "none";
  }
  const byKey = new Map((Array.isArray(facts) ? facts : []).map((fact) => [fact.factKey, fact]));
  let fulfilled = 0;
  for (const match of resolution.matches) {
    const complete = match.matchedFactKeys.every((key) => {
      const fact = byKey.get(key);
      return Boolean(fact &&
        (fact.created === true || fact.promoted === true || fact.fulfilled === true));
    });
    if (complete) {
      fulfilled += 1;
    }
  }
  if (fulfilled === resolution.matches.length) {
    return "fulfilled";
  }
  return fulfilled > 0 ? "partial" : "failed";
}

module.exports = {
  REPLIES,
  analyzeExplicitRemember,
  resolveExplicitRemember,
  markExplicitRememberCandidates,
  summarizeExplicitRememberResult,
};
