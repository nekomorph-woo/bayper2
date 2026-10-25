/* S05e 单个 Herdr 登记端点的逐 Agent 适配器。
   一个已校验的 instance/run/socket 对应一个 adapter；transport 与 ledger 都由
   调用者显式传入。这里只把真实读协议转换为账本事实：snapshot 维护权威当前，
   状态事件形成带本地观测身份的 observation，不读会话正文、不控制终端。 */
const crypto = require("node:crypto");
const { AppError } = require("./errors.cjs");
const { createHerdrTransport } = require("./herdr-transport.cjs");

const STATUS_TYPE = "pane.agent_status_changed";
const TOPOLOGY_TYPES = [
  "pane.created", "pane.closed", "pane.moved", "pane.exited", "pane.agent_detected",
];
const STATE_MAP = {
  idle: "idle", working: "working", blocked: "needs_attention", done: "finished", unknown: "unknown",
};
const RETRY_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];
const DISCONNECT_WINDOW_MS = 3000;
/* 拓扑与伴随的状态事件常在同一批到达；短暂 debounce 让旧订阅先收完事件再换订阅。 */
const TOPOLOGY_REFRESH_DELAY_MS = 500;

const invalid = (message) => new AppError("INVALID_INPUT", message);

function optionalText(value, field) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw invalid(`${field} 必须是字符串或空值。`);
  const text = value.trim();
  if (text.length > 300) throw invalid(`${field} 长度无效。`);
  return text || null;
}

function requiredText(value, field) {
  const text = optionalText(value, field);
  if (!text) throw invalid(`${field} 不能为空。`);
  return text;
}

function mapState(raw) {
  return STATE_MAP[raw] ?? "unknown";
}

/* 快照是 terminal 归属的唯一来源；Agent 显示名只取元数据，不读 terminal_title。 */
function normalizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new AppError("HERDR_PROTOCOL", "Herdr 快照不是对象。");
  }
  const workspaces = new Map();
  for (const item of Array.isArray(snapshot.workspaces) ? snapshot.workspaces : []) {
    if (item && typeof item.workspace_id === "string") {
      workspaces.set(item.workspace_id, optionalText(item.label, "workspace label"));
    }
  }
  const tabs = new Map();
  for (const item of Array.isArray(snapshot.tabs) ? snapshot.tabs : []) {
    if (item && typeof item.tab_id === "string") {
      tabs.set(item.tab_id, optionalText(item.label, "tab label"));
    }
  }
  const panes = [];
  for (const item of Array.isArray(snapshot.panes) ? snapshot.panes : []) {
    if (!item || typeof item.pane_id !== "string" || !item.pane_id) continue;
    panes.push({
      paneId: item.pane_id,
      terminalId: optionalText(item.terminal_id, "pane terminal_id"),
      workspaceId: optionalText(item.workspace_id, "pane workspace_id"),
      tabId: optionalText(item.tab_id, "pane tab_id"),
      label: optionalText(item.label, "pane label") ?? optionalText(item.title, "pane title"),
    });
  }
  const paneById = new Map(panes.map((pane) => [pane.paneId, pane]));
  const agents = [];
  const seen = new Set();
  for (const item of Array.isArray(snapshot.agents) ? snapshot.agents : []) {
    if (!item || typeof item.terminal_id !== "string" || !item.terminal_id) continue;
    if (seen.has(item.terminal_id)) continue;
    seen.add(item.terminal_id);
    const pane = paneById.get(item.pane_id);
    const workspaceId = optionalText(item.workspace_id, "agent workspace_id") ?? pane?.workspaceId;
    const tabId = optionalText(item.tab_id, "agent tab_id") ?? pane?.tabId;
    const fallback = [workspaces.get(workspaceId), tabs.get(tabId), pane?.label]
      .filter(Boolean).join(" / ");
    agents.push({
      agentId: item.terminal_id,
      state: mapState(item.agent_status),
      rawState: typeof item.agent_status === "string" ? item.agent_status : null,
      sequence: Number.isInteger(item.state_change_seq) && item.state_change_seq >= 0
        ? item.state_change_seq : 0,
      label: optionalText(item.name, "agent name")
        ?? optionalText(item.display_agent, "agent display_agent")
        ?? (fallback || null),
    });
  }
  return { panes, agents };
}

function createHerdrAdapter({
  registration, ledger,
  requestTimeoutMs = 3000, setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  if (!registration || typeof registration !== "object") throw invalid("需要已校验的登记对象。");
  const instanceId = requiredText(registration.instanceId, "instanceId");
  const runId = requiredText(registration.runId, "runId");
  const socketPath = requiredText(registration.socketPath, "socketPath");
  const label = optionalText(registration.label, "label");
  if (!ledger || typeof ledger.registerInstance !== "function"
    || typeof ledger.recordObservation !== "function" || typeof ledger.tick !== "function") {
    throw invalid("需要正式 connector ledger。");
  }
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    throw invalid("requestTimeoutMs 必须是正整数。");
  }
  if (typeof setTimer !== "function" || typeof clearTimer !== "function") {
    throw invalid("需要显式定时器。");
  }
  const io = createHerdrTransport({ socketPath, requestTimeoutMs });
  const appRunId = requiredText(ledger.appRunId, "ledger.appRunId");

  let disposed = false;
  let started = false;
  let online = false;
  let disconnected = false;
  let subscription = null;
  let panes = [];
  let paneKey = "";
  let snapshotPromise = null;
  let snapshotDirty = false;
  let snapshotController = null;
  let refreshTimer = null;
  let refreshScheduled = false;
  let refreshing = false;
  let refreshPending = false;
  let refreshPromise = null;
  let connecting = false;
  let retryTimer = null;
  let retryIndex = 0;
  let tickTimer = null;
  let disconnectSince = null;
  let disconnectNotified = false;

  function startTimer(fn, ms) {
    const timer = setTimer(fn, ms);
    timer?.unref?.();
    return timer;
  }

  function clear(timer) {
    if (timer !== null && timer !== undefined) clearTimer(timer);
    return null;
  }

  function clearRefresh() {
    clear(refreshTimer);
    refreshTimer = null;
    refreshScheduled = false;
  }

  function clearTick() {
    clear(tickTimer);
    tickTimer = null;
  }

  function clearRetry() {
    clear(retryTimer);
    retryTimer = null;
  }

  function closeSubscription() {
    const current = subscription;
    subscription = null;
    if (!current) return;
    current.active = false;
    current.handle.close();
  }

  function scheduleRefresh() {
    if (disposed || refreshScheduled) return;
    refreshScheduled = true;
    refreshTimer = startTimer(() => {
      refreshTimer = null;
      refreshScheduled = false;
      startRefresh(true).catch(() => {});
    }, TOPOLOGY_REFRESH_DELAY_MS);
  }

  function observe({
    meta, event, agentId, state, rawState, sourcePaneId,
    sourceTerminalId = null, sourceWorkspaceId = null, sourceTabId = null,
  }) {
    if (disposed) return null;
    const observationId = `${appRunId}:${meta.subscriptionUuid}:${event.localIndex}`;
    return ledger.recordObservation({
      instanceId, runId, agentId, state, rawState, observationId,
      subscriptionId: event.subscriptionId,
      subscriptionUuid: meta.subscriptionUuid,
      localIndex: event.localIndex,
      sourcePaneId, sourceTerminalId, sourceWorkspaceId, sourceTabId,
    });
  }

  /* 无法确认 terminal 时只留 pane 事实，不能把旧 pane 事件归给后来者。 */
  function observeUnattributed(meta, event, paneId) {
    if (!paneId) return;
    observe({
      meta, event, agentId: null, state: mapState(event.data?.agent_status), rawState:
        typeof event.data?.agent_status === "string" ? event.data.agent_status : null,
      sourcePaneId: paneId,
      sourceWorkspaceId: optionalText(event.data?.workspace_id, "event workspace_id"),
    });
  }

  function handleStatus(meta, event) {
    const data = event.data ?? {};
    const pane = meta.pane;
    if (data.pane_id !== pane.paneId || !pane.terminalId) {
      observeUnattributed(meta, event, data.pane_id ?? pane.paneId);
      return;
    }
    observe({
      meta, event, agentId: pane.terminalId, state: mapState(data.agent_status),
      rawState: typeof data.agent_status === "string" ? data.agent_status : null,
      sourcePaneId: pane.paneId, sourceTerminalId: pane.terminalId,
      sourceWorkspaceId: pane.workspaceId ?? optionalText(data.workspace_id, "event workspace_id"),
      sourceTabId: pane.tabId,
    });
  }

  function handleTopology(meta, event, record) {
    const data = event.data ?? {};
    const paneId = typeof data.pane_id === "string" ? data.pane_id
      : typeof data.pane?.pane_id === "string" ? data.pane.pane_id : null;
    const pane = paneId ? record.panes.find((item) => item.paneId === paneId) : null;
    if (meta.type === "pane.exited") {
      if (pane?.terminalId) {
        observe({
          meta, event, agentId: pane.terminalId, state: "stopped", rawState: "pane_exited",
          sourcePaneId: pane.paneId, sourceTerminalId: pane.terminalId,
          sourceWorkspaceId: pane.workspaceId, sourceTabId: pane.tabId,
        });
      } else {
        observeUnattributed(meta, event, paneId);
      }
    }
    /* 拓扑变化后由 snapshot 恢复真实归属；同一批事件合并为一次 refresh。 */
    scheduleRefresh();
  }

  function dispatch(event, record) {
    if (disposed) return;
    if (snapshotPromise) snapshotDirty = true;
    if (!event || event.unknown) return;
    const meta = record.map.get(event.subscriptionId);
    if (!meta) return;
    if (meta.kind === "status") handleStatus(meta, event);
    else handleTopology(meta, event, record);
  }

  async function openSubscription() {
    const subscriptionPanes = panes.slice();
    const subscriptions = [];
    const meta = [];
    for (const pane of subscriptionPanes) {
      subscriptions.push({ type: STATUS_TYPE, pane_id: pane.paneId });
      meta.push({ kind: "status", pane, subscriptionUuid: crypto.randomUUID() });
    }
    for (const type of TOPOLOGY_TYPES) {
      subscriptions.push({ type });
      meta.push({ kind: "topology", type, subscriptionUuid: crypto.randomUUID() });
    }
    let handle = null;
    const queued = [];
    const record = {
      handle: null, map: new Map(), active: false, panes: subscriptionPanes,
    };
    const onEvent = (event) => {
      if (disposed) return;
      if (!record.active) {
        if (!handle) queued.push(event);
        return;
      }
      dispatch(event, record);
    };
    const onClose = () => {
      if (disposed || !record.active) return;
      record.active = false;
      if (subscription === record) subscription = null;
      noteDisconnected();
    };
    handle = await io.subscribe({
      subscriptions, onEvent, onClose, timeoutMs: requestTimeoutMs,
    });
    if (disposed) {
      handle.close();
      return false;
    }
    record.handle = handle;
    record.map = new Map(handle.subscriptions.map((item, index) => [
      item.subscriptionId, meta[index],
    ]));
    record.active = true;
    /* 拓扑刷新先让新订阅 ack，再关闭旧订阅，避免把紧随拓扑的状态事件丢在缝隙里。 */
    const previous = subscription;
    subscription = record;
    if (previous) {
      previous.active = false;
      previous.handle.close();
    }
    for (const event of queued.splice(0)) dispatch(event, record);
    return true;
  }

  async function fetchSnapshot() {
    snapshotController = new AbortController();
    try {
      const response = await io.request("session.snapshot", {}, {
        timeoutMs: requestTimeoutMs, signal: snapshotController.signal,
      });
      if (disposed) return null;
      return normalizeSnapshot(response.snapshot);
    } finally {
      snapshotController = null;
    }
  }

  function applyNormalized(normalized, gapped) {
    const nextKey = normalized.panes
      .map((pane) => `${pane.paneId}\u0000${pane.terminalId ?? ""}`).sort().join("\u0001");
    const result = ledger.applySnapshot({
      instanceId, runId, complete: true, gapped, agents: normalized.agents,
    });
    const panesChanged = nextKey !== paneKey;
    panes = normalized.panes;
    paneKey = nextKey;
    if (result.accepted && panesChanged && subscription && !refreshing) scheduleRefresh();
    return result;
  }

  /* snapshot 串行化：在途期间的新事件只置 dirty，旧响应不能覆盖最新事实。 */
  function runSnapshot(gapped) {
    if (snapshotPromise) {
      snapshotDirty = true;
      return snapshotPromise;
    }
    snapshotPromise = (async () => {
      while (!disposed) {
        snapshotDirty = false;
        const normalized = await fetchSnapshot();
        if (!normalized) return null;
        if (snapshotDirty) continue;
        return applyNormalized(normalized, gapped);
      }
      return null;
    })().finally(() => {
      snapshotPromise = null;
      snapshotController = null;
    });
    return snapshotPromise;
  }

  function noteDisconnected() {
    if (disposed) return;
    online = false;
    if (!disconnected) {
      disconnected = true;
      const marked = ledger.markDisconnected({ instanceId, runId });
      if (marked.accepted === false) {
        clearRetry();
        clearTick();
        return;
      }
      disconnectSince = marked.disconnectedAt ?? null;
      disconnectNotified = marked.notified === true;
      clearTick();
      tickTimer = startTimer(() => {
        tickTimer = null;
        if (disposed) return;
        const result = ledger.tick();
        if (result.notified?.some(
          (item) => item.instanceId === instanceId && item.runId === runId,
        )) disconnectNotified = true;
      }, DISCONNECT_WINDOW_MS);
    } else if (disconnectSince !== null) {
      /* 这里可能是一次已登记但未完成的退避尝试；恢复首次断联时间与提示状态。 */
      const restored = ledger.markDisconnected({
        instanceId, runId, disconnectedAt: disconnectSince, notified: disconnectNotified,
      });
      if (restored.accepted === false) {
        clearRetry();
        clearTick();
        return;
      }
      disconnectNotified = restored.notified === true;
    }
    scheduleRetry();
  }

  function scheduleRetry({ allowMissing = false } = {}) {
    if (disposed || online || retryTimer !== null) return;
    let current;
    try {
      current = ledger.getInstance({ instanceId });
    } catch {
      return;
    }
    if (current) {
      if (current.disabled || current.state === "offline" || current.runId !== runId) return;
    } else if (!allowMissing) {
      return;
    }
    const delay = RETRY_DELAYS_MS[Math.min(retryIndex, RETRY_DELAYS_MS.length - 1)];
    retryIndex += 1;
    retryTimer = startTimer(() => {
      retryTimer = null;
      if (disposed || online) return;
      let latest;
      try {
        latest = ledger.getInstance({ instanceId });
      } catch {
        return;
      }
      if (latest) {
        if (latest.disabled || latest.state === "offline" || latest.runId !== runId) return;
      } else if (!allowMissing) {
        return;
      }
      if (refreshing) return;
      const reconnecting = latest?.state === "reconnecting";
      connect(reconnecting).catch(() => handleConnectFailure());
    }, delay);
  }

  /* 首次 ping 失败时账本还没有 instance/run：只挂退避 timer，不写 online/offline。 */
  function handleConnectFailure() {
    if (disposed) return;
    online = false;
    let current;
    try {
      current = ledger.getInstance({ instanceId });
    } catch {
      return;
    }
    if (!current) {
      scheduleRetry({ allowMissing: true });
      return;
    }
    if (current.disabled || current.state === "offline" || current.runId !== runId) {
      clearRetry();
      clearTick();
      return;
    }
    noteDisconnected();
  }

  async function connect(reconnecting) {
    if (disposed) return { started: false, reason: "DISPOSED" };
    if (connecting) return { started: false, reason: "BUSY" };
    connecting = true;
    try {
      clearRefresh();
      /* 先确认可达再重新登记：失败的退避尝试不能重置首次断联的 3 秒通知窗口。 */
      const known = ledger.getInstance({ instanceId });
      if (known?.disabled) {
        closeSubscription();
        online = false;
        clearRetry();
        clearTick();
        return { started: false, reason: "DISABLED" };
      }
      if (known?.stoppedAt && known.runId === runId) {
        closeSubscription();
        online = false;
        clearRetry();
        clearTick();
        return { started: false, reason: "STOPPED_RUN" };
      }
      try {
        await io.request("ping", {}, { timeoutMs: requestTimeoutMs });
        if (disposed) return { started: false, reason: "DISPOSED" };
        /* 断联重连先取一次无订阅窗口的初始快照，失败时不登记，避免退避尝试
           提前写入在线/恢复通知；在线刷新仍需旧订阅覆盖快照窗口。 */
        const usePreflight = !online && subscription === null;
        const preflight = usePreflight ? await fetchSnapshot() : null;
        if (usePreflight && !preflight) {
          return { started: false, reason: disposed ? "DISPOSED" : "NO_SNAPSHOT" };
        }
        const registered = ledger.registerInstance({ instanceId, runId, label });
        if (!registered.online) {
          closeSubscription();
          online = false;
          clearRetry();
          clearTick();
          return { started: false, reason: registered.reason };
        }
        const initial = preflight
          ? applyNormalized(preflight, reconnecting)
          : await runSnapshot(reconnecting);
        if (!initial || disposed) return { started: false, reason: disposed ? "DISPOSED" : "NO_SNAPSHOT" };
        if (!initial.accepted) {
          closeSubscription();
          online = false;
          return { started: false, reason: initial.reason };
        }
        const subscribed = await openSubscription();
        if (!subscribed || disposed) return { started: false, reason: "DISPOSED" };
        const final = await runSnapshot(false);
        if (!final || disposed) return { started: false, reason: disposed ? "DISPOSED" : "NO_SNAPSHOT" };
        if (!final.accepted) {
          closeSubscription();
          online = false;
          return { started: false, reason: final.reason };
        }
        if (!subscription?.active) {
          return { started: false, reason: "SUBSCRIPTION_LOST" };
        }
        online = true;
        disconnected = false;
        disconnectSince = null;
        disconnectNotified = false;
        retryIndex = 0;
        clearRetry();
        clearTick();
        return { started: true, instanceId, runId, snapshot: final };
      } catch (error) {
        closeSubscription();
        throw error;
      }
    } finally {
      connecting = false;
    }
  }

  async function start() {
    if (disposed) throw new AppError("HERDR_DISPOSED", "adapter 已释放。");
    if (started) return { started: true, duplicate: true, instanceId, runId };
    try {
      const result = await connect(false);
      started = result.started;
      return result;
    } catch (error) {
      handleConnectFailure();
      throw error;
    }
  }

  /* 公共 refresh 与在途刷新合并；拓扑触发的刷新可在完成后追加一次。 */
  function startRefresh(queueIfBusy) {
    if (disposed) return Promise.resolve({ started: false, reason: "DISPOSED" });
    if (refreshing) {
      if (queueIfBusy) refreshPending = true;
      return refreshPromise ?? Promise.resolve({ started: false, reason: "PENDING" });
    }
    refreshing = true;
    refreshPromise = (async () => {
      try {
        let result;
        do {
          refreshPending = false;
          try {
            result = await connect(true);
          } catch (error) {
            handleConnectFailure();
            throw error;
          }
        } while (refreshPending && !disposed && result?.started);
        if (result?.started) started = true;
        return result;
      } finally {
        refreshing = false;
        refreshPromise = null;
      }
    })();
    return refreshPromise;
  }

  function refresh() {
    return startRefresh(false);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    online = false;
    disconnected = true;
    clearRefresh();
    clearRetry();
    clearTick();
    if (snapshotController) snapshotController.abort();
    closeSubscription();
    io.dispose();
  }

  return {
    instanceId, runId, socketPath, start, refresh, dispose,
    get state() {
      return disposed ? "disposed" : online ? "online" : disconnected ? "reconnecting" : "idle";
    },
  };
}

module.exports = { createHerdrAdapter };
