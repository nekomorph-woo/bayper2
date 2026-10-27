/* S03m 纠正来源证据：把既有聊天纠正的分句结果重算为原话中的有限片段。
   只复用生产分句规则；不保存正文，不改变 memory 正文，也不判定语义。
   片段必须是有序、不重叠的实际 slice；正文只允许由这些片段按生产 join("，")
   重建，不能归一化掉 C++/C、C#/C、小数、负号等词内符号。 */
const { detectOperationIntent } = require("./chat-memory-operations.cjs");

const MAX_SEGMENTS = 8;
const MAX_SEGMENT_TEXT = 3000;
const MAX_TOTAL_TEXT = 6000;
const BODY_JOIN = "，";

function locateCorrectionSegments(userText, body) {
  if (typeof userText !== "string" || typeof body !== "string") {
    return null;
  }
  if (!body || body.length > MAX_SEGMENT_TEXT || userText.length > MAX_SEGMENT_TEXT) {
    return null;
  }
  const clauses = detectOperationIntent(userText).clauses;
  if (!Array.isArray(clauses) || clauses.length === 0 || clauses.length > MAX_SEGMENTS * 2) {
    return null;
  }

  /* 按生产正文顺序定位每个分句；同一句话重复出现时使用上一次之后的最近位置，
     找不到实际原文就放弃，不用相似文本补造 offset。 */
  const located = [];
  let cursor = 0;
  for (const clause of clauses) {
    if (typeof clause !== "string" || !clause || clause.length > MAX_SEGMENT_TEXT) {
      return null;
    }
    const start = userText.indexOf(clause, cursor);
    if (start < 0) {
      return null;
    }
    located.push({ start, end: start + clause.length, text: clause });
    cursor = start + clause.length;
  }

  /* 只接受与生产 correctionBody 完全一致的 join 结果；多个位置都能重建同一
     body 时视为歧义，不取第一个匹配。 */
  const matches = [];
  for (let start = 0; start < located.length; start += 1) {
    let joined = "";
    for (let end = start; end < located.length; end += 1) {
      joined = end === start ? located[end].text : `${joined}${BODY_JOIN}${located[end].text}`;
      if (joined.length > body.length) {
        break;
      }
      if (joined === body) {
        const segments = located.slice(start, end + 1);
        if (segments.length > MAX_SEGMENTS ||
          segments.some((segment) => userText.slice(segment.start, segment.end) !== segment.text)) {
          return null;
        }
        matches.push(segments);
        break;
      }
      if (!body.startsWith(joined)) {
        break;
      }
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

/* 独立校验片段结构，不调用 locate，也不共享归一化；正文必须由片段按生产
   join("，") 逐字重建。返回具体问题字符串或 null。 */
function segmentProblem(segments, content, body) {
  if (!Array.isArray(segments) || segments.length === 0 || segments.length > MAX_SEGMENTS) {
    return "segments 数量无效。";
  }
  if (typeof content !== "string" || typeof body !== "string" || !body) {
    return "segments 缺少正文。";
  }
  let lastEnd = 0;
  let total = 0;
  for (const segment of segments) {
    if (!segment || typeof segment !== "object" || Array.isArray(segment)) {
      return "segment 结构无效。";
    }
    const { start, end, text } = segment;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start < lastEnd || end <= start || end > content.length) {
      return "segment 顺序或范围无效。";
    }
    if (typeof text !== "string" || !text || text.length > MAX_SEGMENT_TEXT ||
      text !== content.slice(start, end)) {
      return "segment 不是原话的实际片段。";
    }
    lastEnd = end;
    total += text.length;
    if (total > MAX_TOTAL_TEXT) {
      return "segments 总长度超限。";
    }
  }
  return segments.map((segment) => segment.text).join(BODY_JOIN) === body
    ? null
    : "segments 与正文逐字重建不符。";
}

module.exports = {
  BODY_JOIN,
  MAX_SEGMENTS,
  locateCorrectionSegments,
  segmentProblem,
};
