/* S04b 两种已核实会话 JSONL 的字段适配。
   只识别 Claude Code 的 message.content 与 Codex rollout 的
   response_item/message；未知结构返回诊断标记，不猜测嵌套对象，
   也不执行记录中的任何文本。 */
const CLAUDE_FILE = /\.jsonl$/i;
const CODEX_FILE = /^\d{4}\/\d{2}\/\d{2}\/rollout-[^/]*\.jsonl$/i;

const CLAUDE_TEXT_TYPES = new Set(["text"]);
const CODEX_TEXT_TYPES = new Set(["input_text", "output_text", "text"]);

// 已确认无需读取的顶层记录，不计为未知 schema。
const CLAUDE_IGNORED_TYPES = new Set([
  "system",
  "summary",
  "file-history-snapshot",
  "progress",
  "queue-operation",
  "result",
]);
const CODEX_IGNORED_TYPES = new Set([
  "session_meta",
  "event_msg",
  "turn_context",
  "compacted",
  "world_state",
]);

function timestampOf(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function explicitIdOf(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

/* 只拼接明确列入白名单的文本块；字符串形态直接接受。
   返回 null 表示内容结构无法识别，空字符串表示没有可保留文本。 */
function textOf(content, allowedTypes) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const texts = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || typeof block.type !== "string") {
      return null;
    }
    if (!allowedTypes.has(block.type)) {
      continue;
    }
    if (typeof block.text !== "string") {
      return null;
    }
    if (block.text.length > 0) {
      texts.push(block.text);
    }
  }
  return texts.join("\n");
}

function extractClaude(record) {
  if (record.type !== "user" && record.type !== "assistant") {
    return CLAUDE_IGNORED_TYPES.has(record.type) ? null : { ignored: "UNKNOWN_RECORD" };
  }
  const message = record.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return { unsupported: "MESSAGE_SHAPE" };
  }
  if (message.role !== "user" && message.role !== "assistant") {
    return null;
  }
  const text = textOf(message.content, CLAUDE_TEXT_TYPES);
  if (text === null) {
    return { unsupported: "CONTENT_SHAPE" };
  }
  if (text.trim() === "") {
    return null;
  }
  return {
    role: message.role,
    text,
    timestamp: timestampOf(record.timestamp, message.timestamp),
    id: explicitIdOf(record.uuid, message.id),
  };
}

function extractCodex(record) {
  if (record.type !== "response_item") {
    return CODEX_IGNORED_TYPES.has(record.type) ? null : { ignored: "UNKNOWN_RECORD" };
  }
  const item = record.payload;
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return { unsupported: "PAYLOAD_SHAPE" };
  }
  if (item.type !== "message") {
    // function_call、reasoning、工具结果等不进入文本，只计忽略诊断。
    return { ignored: "NON_MESSAGE_ITEM" };
  }
  if (item.role !== "user" && item.role !== "assistant") {
    return null;
  }
  const text = textOf(item.content, CODEX_TEXT_TYPES);
  if (text === null) {
    return { unsupported: "CONTENT_SHAPE" };
  }
  if (text.trim() === "") {
    return null;
  }
  return {
    role: item.role,
    text,
    timestamp: timestampOf(record.timestamp, item.timestamp),
    id: explicitIdOf(item.id, record.id),
  };
}

const ADAPTERS = {
  "claude-code": {
    matchesFile: (relativePath) => CLAUDE_FILE.test(relativePath),
    extract: extractClaude,
  },
  codex: {
    matchesFile: (relativePath) => CODEX_FILE.test(relativePath),
    extract: extractCodex,
  },
};

function getAdapter(provider) {
  return Object.hasOwn(ADAPTERS, provider) ? ADAPTERS[provider] : null;
}

module.exports = { getAdapter };
