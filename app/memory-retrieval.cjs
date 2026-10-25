/* S03a 本地记忆检索策略。这里只决定“如何召回”，不判断偏好真假、否定、删除或分享权限。
   可对照策略：
   - char：中文单字 + 英文/数字词的字符基线；
   - segment：Intl.Segmenter 中文分词，并保留单字索引以支持 1~2 字查询；
   - expanded：segment 查询再加入一小组可解释概念词，只扩大召回；
   - broad：对自然提问做候选宽召回，再按命中概念组与 BM25 排序；
   - hybrid：先用严格 segment；严格无结果且查询是自然提问时，才回退 broad。
   生产默认 hybrid；字符基线和严格分词保留给 tools/memory-tuning 对照。 */
const RETRIEVAL_CONFIG = Object.freeze({
  defaultStrategy: "hybrid",
  defaultLimit: 5,
  maxLimit: 50,
  maxQueryChars: 200,
  maxQueryTokens: 24,
  broadCandidateMultiplier: 8,
  broadMinCandidates: 40,
  broadMaxCandidates: 100,
});

const RETRIEVAL_STRATEGIES = Object.freeze([
  "char",
  "segment",
  "expanded",
  "broad",
  "hybrid",
]);

/* 只过滤不承载主题的虚词、泛称和自然提问套话；不包含否定词
   （不、没、没有、无、别、未、非、勿），因此检索不会通过“去掉否定词”
   来决定偏好真假。 */
const STOPWORDS = new Set([
  "的",
  "了",
  "在",
  "是",
  "和",
  "与",
  "也",
  "就",
  "都",
  "吗",
  "呢",
  "吧",
  "啊",
  "呀",
  "哦",
  "着",
  "过",
  "地",
  "得",
  "我",
  "你",
  "他",
  "她",
  "它",
  "你们",
  "他们",
  "她们",
  "它们",
  "用户",
  "还",
  "记得",
  "什么",
  "哪",
  "哪里",
  "哪个",
  "怎么",
  "为什么",
  "多少",
  "请问",
  "告诉",
  "一下",
  "通常",
  "上次",
  "想",
  "去",
  "来",
]);

/* 自然提问的通用标记。只有这类查询在严格检索无结果时才允许宽召回，
   避免短关键词查询被宽召回带回部分匹配的相反理解。 */
const QUESTION_MARKERS = /(吗|呢|什么|哪|怎么|为什么|多少|是不是|是否|对不对|有没有|还记得|记得|请问|告诉|通常|上次|我们|你们)/u;

/* 一小组人工可读的中文概念词。它们只作为召回候选，不参与真假、纠正或权限判断。
   单字概念只在查询分词边界完全对齐时生效，避免“熊猫”被“猫”意外扩成“猫咪”。 */
const CONCEPTS = Object.freeze([
  Object.freeze(["摄影", "拍照", "相机", "拍摄"]),
  Object.freeze(["自行车", "单车", "骑车"]),
  Object.freeze(["我们", "一起", "共同"]),
  Object.freeze(["放松", "散心"]),
  Object.freeze(["下雨", "雨天", "下雨天"]),
  Object.freeze(["计算机", "电脑"]),
  Object.freeze(["番茄", "西红柿"]),
  Object.freeze(["猫", "猫咪"]),
  Object.freeze(["狗", "狗狗"]),
  Object.freeze(["咖啡", "拿铁"]),
  Object.freeze(["跑步", "晨跑"]),
  Object.freeze(["生日", "庆生"]),
]);

const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });

function normalize(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .toLowerCase();
}

function isHan(char) {
  return /\p{Script=Han}/u.test(char);
}

function sanitizeToken(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function charTokens(text) {
  const normalized = normalize(text);
  const tokens = [];
  for (const char of normalized) {
    if (isHan(char)) {
      tokens.push(char);
    }
  }
  for (const word of normalized.replace(/[\p{Script=Han}]/gu, " ").match(/[\p{L}\p{N}]+/gu) ?? []) {
    tokens.push(word);
  }
  return tokens;
}

function segmentQueryTokens(text) {
  const normalized = normalize(text).slice(0, RETRIEVAL_CONFIG.maxQueryChars);
  const tokens = [];
  for (const part of segmenter.segment(normalized)) {
    if (!part.isWordLike) {
      continue;
    }
    const textToken = sanitizeToken(part.segment);
    if (!textToken || STOPWORDS.has(textToken)) {
      continue;
    }
    tokens.push({
      text: textToken,
      start: part.index,
      end: part.index + part.segment.length,
    });
    if (tokens.length >= RETRIEVAL_CONFIG.maxQueryTokens) {
      break;
    }
  }
  return tokens;
}

function segmentIndexText(text) {
  const normalized = normalize(text);
  const words = [];
  for (const part of segmenter.segment(normalized)) {
    if (!part.isWordLike) {
      continue;
    }
    const token = sanitizeToken(part.segment);
    if (token) {
      words.push(token);
    }
  }
  const hanChars = [];
  for (const char of normalized) {
    if (isHan(char)) {
      hanChars.push(char);
    }
  }
  return [...words, ...hanChars].join(" ");
}

function tokenizeForIndex(text) {
  return {
    charTokens: charTokens(text).join(" "),
    segmentTokens: segmentIndexText(text),
  };
}

function tokenizeConceptTerm(term) {
  const normalized = normalize(term);
  const tokens = [];
  for (const part of segmenter.segment(normalized)) {
    if (!part.isWordLike) {
      continue;
    }
    const token = sanitizeToken(part.segment);
    if (token) {
      tokens.push(token);
    }
  }
  return tokens;
}

function quoteToken(token) {
  return `"${token.replace(/"/gu, "")}"`;
}

function phraseFor(tokens) {
  return tokens.length === 1 ? quoteToken(tokens[0]) : `"${tokens.join(" ")}"`;
}

function groupFor(alternatives) {
  const phrases = [...new Set(alternatives.map(phraseFor))];
  return phrases.length === 1 ? phrases[0] : `(${phrases.join(" OR ")})`;
}

/* 把查询中落在同一概念词上的 token 合并为一个 OR 组，同时保留原 token，
   因此同义扩展只会增加候选，不会因为扩展而丢掉原查询或否定词。 */
function expandConceptGroups(tokens, normalizedQuery) {
  const items = tokens.map((token) => ({
    start: token.start,
    end: token.end,
    alternatives: [[token.text]],
    locked: false,
  }));
  const usedConcepts = [];

  const conceptsByLength = CONCEPTS.flatMap((terms) =>
    terms.map((term) => ({ term, terms })),
  ).sort((left, right) => right.term.length - left.term.length);

  for (const concept of conceptsByLength) {
    let searchFrom = 0;
    let position = -1;
    while ((position = normalizedQuery.indexOf(concept.term, searchFrom)) !== -1) {
      const range = { start: position, end: position + concept.term.length };
      searchFrom = position + concept.term.length;
      const inside = items
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => item.start >= range.start && item.end <= range.end);
      if (inside.length === 0) {
        continue;
      }
      const startsAligned = inside[0].item.start === range.start;
      const endsAligned = inside[inside.length - 1].item.end === range.end;
      if (!startsAligned || !endsAligned || inside.some(({ item }) => item.locked)) {
        continue;
      }

      const originalTokens = inside.flatMap(({ item }) => item.alternatives[0]);
      const alternatives = [originalTokens];
      for (const term of concept.terms) {
        const termTokens = tokenizeConceptTerm(term);
        if (termTokens.length > 0) {
          alternatives.push(termTokens);
        }
      }
      const [first, ...rest] = inside;
      first.item.alternatives = alternatives;
      first.item.start = range.start;
      first.item.end = range.end;
      first.item.locked = true;
      for (const { item } of rest) {
        item.locked = true;
        item.merged = true;
      }
      usedConcepts.push(concept.terms.join("/"));
    }
  }

  return {
    groups: items
      .filter((item) => !item.merged)
      .map((item) => item.alternatives)
      .filter((alternatives) => alternatives.length > 0),
    concepts: [...new Set(usedConcepts)],
  };
}

function shouldBroadenQuery(query) {
  return typeof query === "string" && QUESTION_MARKERS.test(normalize(query));
}

function buildSearchQuery(query, strategy = "segment") {
  if (!RETRIEVAL_STRATEGIES.includes(strategy)) {
    throw new Error(`未知检索策略：${strategy}`);
  }
  if (strategy === "hybrid") {
    throw new Error("hybrid 由业务入口组合严格检索与宽召回。");
  }
  if (typeof query !== "string" || query.trim() === "") {
    return null;
  }

  if (strategy === "char") {
    const tokens = charTokens(query).slice(0, RETRIEVAL_CONFIG.maxQueryTokens);
    if (tokens.length === 0) {
      return null;
    }
    const groups = tokens.map((token) => [[token]]);
    return {
      column: "char_tokens",
      ftsQuery: `char_tokens : (${groups.map(groupFor).join(" AND ")})`,
      explanation: {
        strategy,
        groups,
        concepts: [],
        broad: false,
      },
    };
  }

  const normalizedQuery = normalize(query).slice(0, RETRIEVAL_CONFIG.maxQueryChars);
  const tokens = segmentQueryTokens(query);
  if (tokens.length === 0) {
    return null;
  }
  const broad = strategy === "broad";
  const expanded =
    strategy === "expanded" || broad
      ? expandConceptGroups(tokens, normalizedQuery)
      : { groups: tokens.map((token) => [[token.text]]), concepts: [] };
  return {
    column: "segment_tokens",
    ftsQuery: `segment_tokens : (${expanded.groups.map(groupFor).join(broad ? " OR " : " AND ")})`,
    explanation: {
      strategy,
      groups: expanded.groups,
      concepts: expanded.concepts,
      broad,
    },
  };
}

module.exports = {
  RETRIEVAL_CONFIG,
  RETRIEVAL_STRATEGIES,
  STOPWORDS,
  CONCEPTS,
  buildSearchQuery,
  shouldBroadenQuery,
  tokenizeForIndex,
  charTokens,
  segmentQueryTokens,
  sanitizeToken,
};
