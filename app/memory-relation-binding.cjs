/* S03n 主体绑定门的纯文本扫描：只识别代词与分句位置，
   不访问数据库、模型或网络，也不判定语义真值。 */
const PLURAL_PRONOUN = /她们|他们/u;

function pronounAt(text, index) {
  const char = text[index];
  if (char === "她") {
    return text[index + 1] === "们" ? null : char;
  }
  if (char !== "他") {
    return null;
  }
  if (["其", "吉", "利"].includes(text[index - 1]) ||
    ["人", "乡", "日", "们"].includes(text[index + 1])) {
    return null;
  }
  return char;
}

function pronounPositions(text) {
  const positions = [];
  for (let index = 0; index < text.length; index += 1) {
    const pronoun = pronounAt(text, index);
    if (pronoun) {
      positions.push({ index, pronoun });
    }
  }
  return positions;
}

function hasUnsupportedPlural(text) {
  return PLURAL_PRONOUN.test(text);
}

function clauseRanges(text) {
  const ranges = [];
  for (const match of text.matchAll(/[^。！？!?；;，,\n]+/gu)) {
    const raw = match[0];
    const value = raw.trim();
    if (!value) continue;
    const start = match.index + raw.indexOf(value);
    const end = start + value.length;
    const trailing = (text.slice(end).match(/^[。！？!?；;，,\n]+/u) ?? [""])[0];
    ranges.push({ start, end, trailing, text: value });
  }
  return ranges;
}

module.exports = {
  hasUnsupportedPlural,
  pronounPositions,
  clauseRanges,
};
