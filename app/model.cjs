/* 模型接入的最小实现：校验用户输入，并向 OpenAI 兼容的
   chat/completions 发送一次固定连通检查。这里不记录、不回显 API Key。 */
const { AppError } = require("./errors.cjs");

const REQUEST_TIMEOUT_MS = 8000;
const DEEPSEEK_REQUEST_TIMEOUT_MS = 30000;
const CHECK_MAX_TOKENS = 64;
const CHAT_MAX_TOKENS = 512;
const CHAT_TEMPERATURE = 0.7;
const MAX_CHAT_MESSAGES = 40;
const MAX_MODEL_NAME_LENGTH = 120;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const DEEPSEEK_HOSTS = new Set(["api.deepseek.com"]);
const CHECK_MESSAGE = "这是一次连通检查。请不要处理任何个人数据，只回复一句简短问候。";

function validateModelInput(input) {
  if (!input || typeof input !== "object") {
    throw new AppError("INVALID_INPUT", "配置内容不完整，请检查后重试。");
  }
  const baseUrl = parseBaseUrl(input.baseUrl);
  const modelName = parseModelName(input.modelName);
  const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  if (!apiKey) {
    throw new AppError("MISSING_KEY", "请填写 API Key。");
  }
  return { baseUrl, modelName, apiKey };
}

function parseBaseUrl(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) {
    throw new AppError("INVALID_URL", "请填写 Base URL，例如 https://api.example.com/v1。");
  }

  let url;
  try {
    url = new URL(text);
  } catch {
    throw new AppError("INVALID_URL", "Base URL 格式无效，请检查后重试。");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AppError("INVALID_URL", "Base URL 必须使用 HTTPS；本机服务可使用 HTTP。");
  }
  if (url.username || url.password) {
    throw new AppError("INVALID_URL", "Base URL 不能包含用户名或密码。");
  }
  if (url.search || url.hash) {
    throw new AppError("INVALID_URL", "Base URL 不能包含查询参数或片段。");
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new AppError("INSECURE_URL", "只有本机 loopback 服务可以使用 HTTP，其他地址必须使用 HTTPS。");
  }

  return url.toString().replace(/\/+$/, "");
}

function parseModelName(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) {
    throw new AppError("INVALID_MODEL", "请填写模型名。");
  }
  if (text.length > MAX_MODEL_NAME_LENGTH || /[\s\u0000-\u001f\u007f]/.test(text)) {
    throw new AppError("INVALID_MODEL", "模型名不能包含空格、控制字符，且不能超过 120 个字符。");
  }
  return text;
}

function buildEndpoint(baseUrl) {
  return `${baseUrl}/chat/completions`;
}

function isOfficialDeepSeekHost(baseUrl) {
  try {
    return DEEPSEEK_HOSTS.has(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

function timeoutFor(baseUrl) {
  return isOfficialDeepSeekHost(baseUrl) ? DEEPSEEK_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
}

/* DeepSeek 官方默认开启 thinking，短连通检查需要显式关闭；
   其他兼容服务不发送这类供应商私有字段。 */
function buildCheckRequest({ baseUrl, modelName }) {
  const body = {
    model: modelName,
    messages: [{ role: "user", content: CHECK_MESSAGE }],
    max_tokens: CHECK_MAX_TOKENS,
    temperature: 0,
    stream: false,
  };
  if (isOfficialDeepSeekHost(baseUrl)) {
    body.thinking = { type: "disabled" };
  }
  return body;
}

async function checkModelConnection({ baseUrl, modelName, apiKey }, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutFor(baseUrl));

  try {
    const response = await fetchImpl(buildEndpoint(baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(buildCheckRequest({ baseUrl, modelName })),
      redirect: "manual",
      signal: controller.signal,
    });

    // 不跟随重定向，避免跳出用户明确配置的服务或绕过 HTTPS 约束。
    if (response.status >= 300 && response.status < 400) {
      throw new AppError(
        "REDIRECT_BLOCKED",
        "模型服务返回了重定向，连接检查已停止；请直接填写最终服务地址。",
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new AppError("AUTH_FAILED", "服务拒绝了 API Key，请检查后重试。");
    }
    if (!response.ok) {
      throw new AppError("SERVER_ERROR", `模型服务返回错误（HTTP ${response.status}）。`);
    }

    let data;
    try {
      data = await response.json();
    } catch {
      throw new AppError("INVALID_RESPONSE", "服务没有返回有效的助手文本，本次未完成配置。");
    }

    const message = data?.choices?.[0]?.message;
    if (message?.role !== "assistant" || typeof message.content !== "string" || !message.content.trim()) {
      throw new AppError("INVALID_RESPONSE", "服务没有返回有效的助手文本，本次未完成配置。");
    }

    // 只用于确认连通；返回内容不写入数据库，也不进入日志或渲染进程。
    return { replyLength: message.content.trim().length };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    if (error?.name === "AbortError") {
      throw new AppError("TIMEOUT", "连接检查超时，请确认服务可访问后重试。");
    }
    throw new AppError("NETWORK_ERROR", "无法连接模型服务，请检查地址后重试。");
  } finally {
    clearTimeout(timer);
  }
}

function buildChatRequest({ baseUrl, modelName, messages, maxTokens, temperature }) {
  const body = {
    model: modelName,
    messages,
    max_tokens: maxTokens ?? CHAT_MAX_TOKENS,
    temperature: temperature ?? CHAT_TEMPERATURE,
    stream: false,
  };
  if (isOfficialDeepSeekHost(baseUrl)) {
    body.thinking = { type: "disabled" };
  }
  return body;
}

function validateChatMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_CHAT_MESSAGES) {
    throw new AppError("INVALID_INPUT", "聊天消息数量无效。");
  }
  for (const message of messages) {
    if (
      !message ||
      !["system", "user", "assistant"].includes(message.role) ||
      typeof message.content !== "string" ||
      message.content.trim() === ""
    ) {
      throw new AppError("INVALID_INPUT", "聊天消息结构无效。");
    }
  }
  return messages.map((message) => ({
    role: message.role,
    content: message.content.trim(),
  }));
}

/* 聊天补全只发一次请求，不自动重试；调用方负责在发布前重新核验上下文版本。 */
async function requestChatCompletion(
  { baseUrl, modelName, apiKey, messages, maxTokens, temperature, timeoutMs, signal },
  fetchImpl = fetch,
) {
  const safeBaseUrl = parseBaseUrl(baseUrl);
  const safeModelName = parseModelName(modelName);
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!key) {
    throw new AppError("MISSING_KEY", "缺少 API Key。");
  }
  const safeMessages = validateChatMessages(messages);
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : timeoutFor(safeBaseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let onAbort = null;
  if (signal) {
    onAbort = () => controller.abort();
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  try {
    const response = await fetchImpl(buildEndpoint(safeBaseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(
        buildChatRequest({
          baseUrl: safeBaseUrl,
          modelName: safeModelName,
          messages: safeMessages,
          maxTokens,
          temperature,
        }),
      ),
      redirect: "manual",
      signal: controller.signal,
    });

    if (response.status >= 300 && response.status < 400) {
      throw new AppError("REDIRECT_BLOCKED", "模型服务返回了重定向，请求已停止。");
    }
    if (response.status === 401 || response.status === 403) {
      throw new AppError("AUTH_FAILED", "服务拒绝了 API Key，请检查后重试。");
    }
    if (!response.ok) {
      throw new AppError("SERVER_ERROR", `模型服务返回错误（HTTP ${response.status}）。`);
    }

    let data;
    try {
      data = await response.json();
    } catch {
      throw new AppError("INVALID_RESPONSE", "服务没有返回有效的助手文本。");
    }
    const message = data?.choices?.[0]?.message;
    if (
      message?.role !== "assistant" ||
      typeof message.content !== "string" ||
      !message.content.trim()
    ) {
      throw new AppError("INVALID_RESPONSE", "服务没有返回有效的助手文本。");
    }
    return { content: message.content.trim() };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    if (error?.name === "AbortError") {
      throw new AppError("TIMEOUT", "模型请求超时。");
    }
    throw new AppError("NETWORK_ERROR", "无法连接模型服务。");
  } finally {
    clearTimeout(timer);
    if (signal && onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

module.exports = {
  CHECK_MESSAGE,
  CHECK_MAX_TOKENS,
  CHAT_MAX_TOKENS,
  CHAT_TEMPERATURE,
  REQUEST_TIMEOUT_MS,
  DEEPSEEK_REQUEST_TIMEOUT_MS,
  validateModelInput,
  parseBaseUrl,
  parseModelName,
  buildEndpoint,
  isOfficialDeepSeekHost,
  timeoutFor,
  buildCheckRequest,
  buildChatRequest,
  checkModelConnection,
  requestChatCompletion,
};
