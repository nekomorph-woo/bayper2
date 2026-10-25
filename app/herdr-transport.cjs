/* S05b-1 Herdr 只读 Socket 传输。
   只允许 ping、session.snapshot、plugin.list 三个读请求和 events.subscribe 固定
   订阅入口；不执行命令、不读取 pane 内容或 private 会话全文。请求走独立短连接，
   订阅走单条长连接。localSubscriptionId/localIndex 只是本传输的观测身份，不是
   Herdr sequence，也不等于服务端重放 ID。 */
const net = require("node:net");
const { AppError } = require("./errors.cjs");

const READ_METHODS = new Set(["ping", "session.snapshot", "plugin.list"]);
const RESULT_TYPES = {
  ping: "pong",
  "session.snapshot": "session_snapshot",
  "plugin.list": "plugin_list",
};
const STATUS_SUBSCRIPTION = "pane.agent_status_changed";
const AGENT_STATUSES = new Set(["idle", "working", "blocked", "done", "unknown"]);
const EVENT_TYPE_PAIRS = [
  [STATUS_SUBSCRIPTION, "pane_agent_status_changed"],
  ["pane.created", "pane_created"],
  ["pane.closed", "pane_closed"],
  ["pane.moved", "pane_moved"],
  ["pane.exited", "pane_exited"],
  ["pane.agent_detected", "pane_agent_detected"],
];
const SUBSCRIPTION_TYPES = new Set(EVENT_TYPE_PAIRS.map(([dot]) => dot));
const CANONICAL_EVENT = new Map(
  EVENT_TYPE_PAIRS.flatMap(([dot, underscore]) => [[dot, dot], [underscore, dot]]),
);
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_PRE_ACK_EVENTS = 256;
const DEFAULT_MAX_PRE_ACK_BYTES = 1024 * 1024;
let transportSerial = 0;

const fail = (code, message) => new AppError(code, message);
const protocolError = () => fail("HERDR_PROTOCOL", "Herdr 返回了无效协议数据。");
const eofError = () => fail("HERDR_EOF", "Herdr 连接已断开。");
const socketError = () => fail("HERDR_SOCKET_ERROR", "Herdr 套接字连接失败。");
const timeoutError = () => fail("HERDR_TIMEOUT", "Herdr 请求超时。");
const abortedError = () => fail("HERDR_ABORTED", "Herdr 请求已取消。");
const disposedError = () => fail("HERDR_DISPOSED", "Herdr 传输实例已释放。");

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInt(value, field, fallback) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw fail("HERDR_INVALID_OPTIONS", `${field} 必须是正整数。`);
  }
  return value;
}

function validateSubscriptions(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw fail("HERDR_INVALID_SUBSCRIPTIONS", "subscriptions 必须是非空数组。");
  }
  const seen = new Set();
  return value.map((item) => {
    if (!isObject(item) || typeof item.type !== "string" || !SUBSCRIPTION_TYPES.has(item.type)) {
      throw fail("HERDR_INVALID_SUBSCRIPTIONS", "订阅类型不在允许范围内。");
    }
    let subscription;
    let key;
    if (item.type === STATUS_SUBSCRIPTION) {
      if (typeof item.pane_id !== "string" || item.pane_id.length === 0) {
        throw fail("HERDR_INVALID_SUBSCRIPTIONS", "状态订阅必须提供 pane_id。");
      }
      if (
        item.agent_status !== undefined
        && item.agent_status !== null
        && !AGENT_STATUSES.has(item.agent_status)
      ) {
        throw fail("HERDR_INVALID_SUBSCRIPTIONS", "agent_status 不是合法状态。");
      }
      subscription = {
        type: item.type,
        pane_id: item.pane_id,
        ...(item.agent_status !== undefined ? { agent_status: item.agent_status } : {}),
      };
      key = `${item.type}|${item.pane_id}|${item.agent_status ?? null}`;
    } else {
      subscription = { type: item.type };
      key = item.type;
    }
    if (seen.has(key)) {
      throw fail("HERDR_INVALID_SUBSCRIPTIONS", "相同订阅不能重复。");
    }
    seen.add(key);
    return subscription;
  });
}

function rpcFailure(body) {
  if (!isObject(body) || typeof body.code !== "string") return protocolError();
  const failure = fail("HERDR_RPC_ERROR", "Herdr 返回业务错误。");
  failure.rpcCode = body.code;
  return failure;
}

function eventsLostError() {
  const failure = fail("HERDR_EVENTS_LOST", "Herdr 订阅发生事件丢失。");
  failure.rpcCode = "events_lost";
  failure.gap = true;
  return failure;
}

function createHerdrTransport({
  socketPath,
  requestTimeoutMs = DEFAULT_TIMEOUT_MS,
  maxLineBytes = DEFAULT_MAX_LINE_BYTES,
  maxPreAckEvents = DEFAULT_MAX_PRE_ACK_EVENTS,
  maxPreAckBytes = DEFAULT_MAX_PRE_ACK_BYTES,
} = {}) {
  if (typeof socketPath !== "string" || socketPath.trim().length === 0) {
    throw fail("HERDR_INVALID_SOCKET_PATH", "需要显式传入 Herdr socket 路径。");
  }
  const path = socketPath;
  const defaultTimeout = positiveInt(requestTimeoutMs, "requestTimeoutMs", DEFAULT_TIMEOUT_MS);
  const lineLimit = positiveInt(maxLineBytes, "maxLineBytes", DEFAULT_MAX_LINE_BYTES);
  const preAckEventLimit = positiveInt(
    maxPreAckEvents, "maxPreAckEvents", DEFAULT_MAX_PRE_ACK_EVENTS,
  );
  const preAckByteLimit = positiveInt(maxPreAckBytes, "maxPreAckBytes", DEFAULT_MAX_PRE_ACK_BYTES);
  const transportTag = `herdr-t${++transportSerial}`;
  let disposed = false;
  let nextId = 0;
  const active = new Set();

  const nextRequestId = () => `${transportTag}-r${++nextId}`;

  /* 按字节找换行，再整行 UTF-8 解码；这样 chunk 跨 UTF-8/JSON 边界不会乱码。 */
  function readLines(socket, onLine, onFailure) {
    let buffer = Buffer.alloc(0);
    let stopped = false;
    socket.on("data", (chunk) => {
      if (stopped) return;
      buffer = Buffer.concat([buffer, chunk]);
      let newline;
      while ((newline = buffer.indexOf(10)) !== -1) {
        const line = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        if (line.length > lineLimit) {
          stopped = true;
          onFailure(fail("HERDR_LINE_TOO_LARGE", "Herdr 响应行超过大小上限。"));
          return;
        }
        onLine(line.toString("utf8"));
        if (stopped) return;
      }
      if (buffer.length > lineLimit) {
        stopped = true;
        onFailure(fail("HERDR_LINE_TOO_LARGE", "Herdr 响应行超过大小上限。"));
      }
    });
    return () => {
      stopped = true;
    };
  }

  function request(method, params = {}, options = {}) {
    if (disposed) return Promise.reject(disposedError());
    if (!READ_METHODS.has(method)) {
      return Promise.reject(fail("HERDR_METHOD_NOT_ALLOWED", "方法不在只读白名单内。"));
    }
    if (!isObject(params)) {
      return Promise.reject(fail("HERDR_INVALID_PARAMS", "params 必须是对象。"));
    }
    let timeoutMs;
    try {
      timeoutMs = positiveInt(options.timeoutMs, "timeoutMs", defaultTimeout);
    } catch (failure) {
      return Promise.reject(failure);
    }
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(abortedError());

    const id = nextRequestId();
    let line;
    try {
      line = `${JSON.stringify({ id, method, params })}\n`;
    } catch {
      return Promise.reject(fail("HERDR_INVALID_PARAMS", "params 不能序列化。"));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      let stop;
      let socket;
      const finish = (failure, result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        active.delete(end);
        stop?.();
        socket?.destroy();
        if (failure) reject(failure);
        else resolve(result);
      };
      const end = (failure) => finish(failure);
      const onAbort = () => end(abortedError());

      socket = net.createConnection({ path });
      stop = readLines(socket, (text) => {
        let message;
        try {
          message = JSON.parse(text);
        } catch {
          end(protocolError());
          return;
        }
        if (!isObject(message) || typeof message.id !== "string") {
          end(protocolError());
          return;
        }
        /* 非本次请求 id 的响应直接忽略，不当作事件，也不完成本请求。 */
        if (message.id !== id) return;
        if (message.error !== undefined) {
          end(rpcFailure(message.error));
          return;
        }
        if (!isObject(message.result) || message.result.type !== RESULT_TYPES[method]) {
          end(protocolError());
          return;
        }
        finish(null, message.result);
      }, end);
      active.add(end);
      timer = setTimeout(() => end(timeoutError()), timeoutMs);
      timer.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
      socket.on("connect", () => {
        if (!socket.destroyed) socket.write(line);
      });
      socket.on("error", () => end(socketError()));
      socket.on("close", () => end(eofError()));
    });
  }

  function subscribe({
    subscriptions: rawSubscriptions,
    onEvent = () => {},
    onClose = () => {},
    signal,
    timeoutMs,
  } = {}) {
    if (disposed) return Promise.reject(disposedError());
    let subscriptions;
    let limit;
    try {
      subscriptions = validateSubscriptions(rawSubscriptions);
      limit = positiveInt(timeoutMs, "timeoutMs", defaultTimeout);
    } catch (failure) {
      return Promise.reject(failure);
    }
    if (typeof onEvent !== "function" || typeof onClose !== "function") {
      return Promise.reject(fail("HERDR_INVALID_SUBSCRIPTIONS", "事件回调必须是函数。"));
    }
    if (signal?.aborted) {
      const failure = abortedError();
      try {
        onClose(failure);
      } catch {
        // 回调自身错误不再传播。
      }
      return Promise.reject(failure);
    }

    const id = nextRequestId();
    let line;
    try {
      line = `${JSON.stringify({
        id,
        method: "events.subscribe",
        params: { subscriptions },
      })}\n`;
    } catch {
      return Promise.reject(fail("HERDR_INVALID_SUBSCRIPTIONS", "订阅参数不能序列化。"));
    }

    let ended = false;
    let readySettled = false;
    let acked = false;
    let timer;
    let stop;
    let socket;
    let readyResolve;
    let readyReject;
    const buffered = [];
    let bufferedBytes = 0;
    const counters = subscriptions.map(() => 0);
    const ready = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    /* 订阅者可能只用回调而不 await ready；避免内部异步失败成为未处理拒绝。 */
    ready.catch(() => {});

    const handle = {
      id,
      subscriptions: subscriptions.map((item, index) => ({
        subscriptionId: `${id}-s${index}`,
        type: item.type,
        ...(item.pane_id !== undefined ? { paneId: item.pane_id } : {}),
        ...(item.agent_status !== undefined ? { agentStatus: item.agent_status } : {}),
      })),
      close: () => end(fail("HERDR_CLOSED", "Herdr 订阅已关闭。")),
    };

    function rejectReady(failure) {
      if (readySettled) return;
      readySettled = true;
      readyReject(failure);
    }

    function end(failure) {
      if (ended) return;
      ended = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      active.delete(end);
      stop?.();
      socket?.destroy();
      buffered.length = 0;
      bufferedBytes = 0;
      rejectReady(failure);
      try {
        onClose(failure);
      } catch {
        // 回调自身错误不再传播。
      }
    }

    function deliver(item) {
      try {
        onEvent(item);
      } catch {
        end(fail("HERDR_CALLBACK_ERROR", "事件回调失败。"));
      }
    }

    function handleEvent(message, bytes) {
      const event = message.event;
      const data = message.data;
      if (typeof event !== "string" || !isObject(data)) {
        end(protocolError());
        return;
      }
      const canonical = CANONICAL_EVENT.get(event);
      if (canonical === STATUS_SUBSCRIPTION) {
        /* subscription_event 的真实状态 payload 没有 data.type；必需字段按该 schema 校验。 */
        if (
          typeof data.pane_id !== "string"
          || data.pane_id.length === 0
          || typeof data.workspace_id !== "string"
          || data.workspace_id.length === 0
          || !AGENT_STATUSES.has(data.agent_status)
        ) {
          end(protocolError());
          return;
        }
        if (
          data.type !== undefined
          && (typeof data.type !== "string" || CANONICAL_EVENT.get(data.type) !== canonical)
        ) {
          end(protocolError());
          return;
        }
      } else if (canonical) {
        /* 普通 event payload 保留 data.type 形态。 */
        if (typeof data.type !== "string" || CANONICAL_EVENT.get(data.type) !== canonical) {
          end(protocolError());
          return;
        }
      }
      const index = canonical
        ? subscriptions.findIndex((subscription) => {
            if (subscription.type !== canonical) return false;
            if (canonical === STATUS_SUBSCRIPTION) {
              if (subscription.pane_id !== data.pane_id) return false;
              if (subscription.agent_status != null && subscription.agent_status !== data.agent_status) {
                return false;
              }
            }
            return true;
          })
        : -1;
      const item = index === -1
        ? { subscriptionId: null, localIndex: null, event, data, unknown: true }
        : {
            subscriptionId: `${id}-s${index}`,
            localIndex: ++counters[index],
            event,
            data,
            unknown: false,
          };
      if (!acked) {
        if (buffered.length + 1 > preAckEventLimit || bufferedBytes + bytes > preAckByteLimit) {
          const failure = fail("HERDR_PRE_ACK_LIMIT", "Herdr 订阅确认前缓存超过上限。");
          failure.gap = true;
          end(failure);
          return;
        }
        buffered.push(item);
        bufferedBytes += bytes;
        return;
      }
      deliver(item);
    }

    function onLine(text) {
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        end(protocolError());
        return;
      }
      if (!isObject(message)) {
        end(protocolError());
        return;
      }
      if (message.error !== undefined) {
        if ("id" in message && typeof message.id !== "string") {
          end(protocolError());
          return;
        }
        /* 别的请求 id 的错误（包括 events_lost）不得串线终止本订阅。 */
        if (typeof message.id === "string" && message.id !== id) return;
        if (isObject(message.error) && message.error.code === "events_lost") {
          end(eventsLostError());
          return;
        }
        end(rpcFailure(message.error));
        return;
      }
      if ("id" in message) {
        if (typeof message.id !== "string") {
          end(protocolError());
          return;
        }
        if (message.id !== id || acked) return;
        if (!isObject(message.result) || message.result.type !== "subscription_started") {
          end(protocolError());
          return;
        }
        acked = true;
        if (timer) clearTimeout(timer);
        readySettled = true;
        readyResolve(handle);
        const pending = buffered.splice(0);
        bufferedBytes = 0;
        for (const item of pending) {
          deliver(item);
          if (ended) return;
        }
        return;
      }
      if (typeof message.event === "string" && message.data !== undefined) {
        handleEvent(message, Buffer.byteLength(text, "utf8"));
        return;
      }
      end(protocolError());
    }

    const onAbort = () => end(abortedError());
    socket = net.createConnection({ path });
    stop = readLines(socket, onLine, end);
    active.add(end);
    timer = setTimeout(() => end(timeoutError()), limit);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.on("connect", () => {
      if (!socket.destroyed) socket.write(line);
    });
    socket.on("error", () => end(socketError()));
    socket.on("close", () => end(eofError()));
    return ready;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const end of [...active]) end(disposedError());
  }

  return { request, subscribe, dispose };
}

module.exports = { createHerdrTransport };
