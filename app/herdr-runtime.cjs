/* S05g Herdr 登记发现与多实例运行管理。
   只消费显式 registryDir 的正式登记，把每个 instance/run 对应到一个正式
   adapter 和同一 connector ledger。扫描只代表登记存在；online 仍由 adapter
   的真实 ping/snapshot 确认。不读会话正文、不控制终端、不新建 SQLite。 */
const fs = require("node:fs");
const path = require("node:path");
const { AppError } = require("./errors.cjs");
const { readHerdrRegistry } = require("./herdr-registry.cjs");
const { createHerdrAdapter } = require("./herdr-adapter.cjs");

const DEFAULT_SCAN_INTERVAL_MS = 5000;
const MAX_RUNTIME_DIAGNOSTICS = 50;

function defaultProcessProbe(pid) {
  try {
    process.kill(pid, 0);
    return { code: null };
  } catch (error) {
    return { code: error.code || null };
  }
}

function invalid(message) {
  return new AppError("INVALID_INPUT", message);
}

function socketMatches(socket) {
  try {
    const stat = fs.statSync(socket.path, { bigint: true });
    return stat.isSocket()
      && stat.dev.toString() === socket.dev
      && stat.ino.toString() === socket.ino
      && stat.birthtimeMs.toString() === socket.birthtimeMs;
  } catch {
    return false;
  }
}

function createHerdrRuntime({
  registryDir, ledger, now = () => Date.now(),
  scanIntervalMs = DEFAULT_SCAN_INTERVAL_MS,
  setIntervalFn = setInterval, clearIntervalFn = clearInterval,
  processProbe = defaultProcessProbe, onStateChange = null,
} = {}) {
  if (typeof registryDir !== "string" || !path.isAbsolute(registryDir)) {
    throw invalid("registryDir 必须是绝对路径。");
  }
  if (!ledger || typeof ledger.getInstance !== "function"
    || typeof ledger.disableInstance !== "function"
    || typeof ledger.enableInstance !== "function"
    || typeof ledger.listAgents !== "function"
    || typeof ledger.markDisconnected !== "function") {
    throw invalid("需要正式 connector ledger。");
  }
  if (!Number.isInteger(scanIntervalMs) || scanIntervalMs < 1) {
    throw invalid("scanIntervalMs 必须是正整数。");
  }
  if (typeof setIntervalFn !== "function" || typeof clearIntervalFn !== "function"
    || typeof now !== "function") {
    throw invalid("需要有效的调度与时钟。");
  }
  if (typeof processProbe !== "function") throw invalid("processProbe 必须是函数。");
  if (onStateChange !== null && typeof onStateChange !== "function") {
    throw invalid("onStateChange 必须是函数或空值。");
  }

  const entries = new Map();
  const runtimeDiagnostics = [];
  let lastRegistry = {
    found: false, truncated: false, diagnostics: [], registrations: [],
  };
  let started = false;
  let disposed = false;
  let scanning = false;
  let scanPromise = null;
  let intervalTimer = null;
  let lastScanAt = null;

  function addDiagnostic(code, extra = {}) {
    runtimeDiagnostics.push({ at: now(), code, ...extra });
    if (runtimeDiagnostics.length > MAX_RUNTIME_DIAGNOSTICS) {
      runtimeDiagnostics.splice(0, runtimeDiagnostics.length - MAX_RUNTIME_DIAGNOSTICS);
    }
  }

  /* 只通知既有扫描/显式动作后的新鲜状态，供主进程复用应用快照节奏；
     不在这里追加定时器或读取账本之外的业务数据。 */
  function notifyStateChange() {
    if (disposed || !onStateChange) return;
    try {
      onStateChange();
    } catch {
      addDiagnostic("STATE_CHANGE_CALLBACK_FAILED");
    }
  }

  function disposeEntry(entry) {
    const adapter = entry.adapter;
    entry.adapter = null;
    if (adapter) adapter.dispose();
  }

  function adapterFor(record, onConnected) {
    return createHerdrAdapter({
      registration: {
        instanceId: record.instanceId,
        runId: record.runId,
        socketPath: record.socket.path,
        label: record.instanceId,
      },
      ledger,
      verifyEndpoint: () => socketMatches(record.socket),
      onConnected,
    });
  }

  function socketEnoent(socketPath) {
    try {
      fs.statSync(socketPath);
      return false;
    } catch (error) {
      return error.code === "ENOENT";
    }
  }

  function processGone(pid) {
    let result;
    try {
      result = processProbe(pid);
    } catch (error) {
      return error.code === "ESRCH";
    }
    return Boolean(result && result.code === "ESRCH");
  }

  function startEntry(entry) {
    const adapter = adapterFor(entry.registration, () => {
      if (!disposed && entry.adapter === adapter) entry.connected = true;
    });
    entry.adapter = adapter;
    return adapter.start().then(
      (result) => {
        if (disposed || entry.adapter !== adapter) {
          if (disposed) adapter.dispose();
          return result;
        }
        if (result.started) {
          entry.connected = true;
          entry.lastError = null;
        } else {
          entry.lastError = { reason: result.reason };
        }
        return result;
      },
      (error) => {
        if (disposed || entry.adapter !== adapter) {
          if (disposed) adapter.dispose();
          return { started: false };
        }
        entry.lastError = { code: error.code || null };
        addDiagnostic("ADAPTER_START_FAILED", {
          instanceId: entry.registration.instanceId,
          runId: entry.registration.runId,
          code: error.code || null,
        });
        return { started: false };
      },
    );
  }

  function reconcile(registry) {
    if (disposed) return;
    const incoming = new Map();
    for (const record of registry.registrations) {
      if (!incoming.has(record.instanceId)) incoming.set(record.instanceId, record);
    }

    for (const [instanceId, entry] of [...entries]) {
      const current = incoming.get(instanceId);
      if (!current) {
        entry.current = false;
        continue;
      }
      entry.current = true;
      const previous = entry.registration;
      if (current.runId === previous.runId) {
        entry.registration = current;
        entry.endpoint = current.endpoint;
        if (current.endpoint === "replaced") {
          if (entry.adapter) disposeEntry(entry);
          if (!entry.staleReported) {
            entry.staleReported = true;
            try {
              ledger.markDisconnected({ instanceId, runId: current.runId });
            } catch {
              // 断连事实已由 adapter 或此前状态记录；不伪造 offline。
            }
            addDiagnostic("ENDPOINT_REPLACED", { instanceId, runId: current.runId });
          }
        } else if (current.endpoint === "matches") {
          entry.staleReported = false;
        }
        continue;
      }
      if (entry.adapter) disposeEntry(entry);
      entry.registration = current;
      entry.endpoint = current.endpoint;
      entry.staleReported = false;
      entry.lastError = null;
      entry.connected = false;
      entry.stopped = false;
      addDiagnostic("RUN_REPLACED", {
        instanceId, oldRunId: previous.runId, runId: current.runId,
      });
    }

    for (const [instanceId, record] of incoming) {
      if (!entries.has(instanceId)) {
        entries.set(instanceId, {
          registration: record, endpoint: record.endpoint, current: true,
          adapter: null, lastError: null, staleReported: false,
          connected: false, stopped: false,
        });
      }
    }

    for (const [instanceId, entry] of entries) {
      let instance = null;
      try {
        instance = ledger.getInstance({ instanceId });
      } catch {
        instance = null;
      }
      if (instance?.disabled || entry.stopped
        || (instance !== null && instance.stoppedAt !== null
          && instance.runId === entry.registration.runId)) {
        if (entry.adapter) disposeEntry(entry);
        continue;
      }
      if (!entry.current || entry.adapter
        || entry.registration.endpoint !== "matches") continue;
      try {
        /* adapter.start 在后台完成；扫描本身只负责发现和身份门，不被挂起连接阻塞。 */
        startEntry(entry);
      } catch (error) {
        entry.lastError = { code: error.code || null };
        addDiagnostic("ADAPTER_CREATE_FAILED", {
          instanceId, runId: entry.registration.runId, code: error.code || null,
        });
      }
    }
  }

  /* 下线必须同时具备：本次真实连接过、同 run 当前账本、连接已失去、
     登记 socket 精确 ENOENT、登记 PID 只读 kill(0) 精确 ESRCH。 */
  function confirmStoppedRuns() {
    if (disposed) return;
    for (const [instanceId, entry] of entries) {
      if (entry.stopped || !entry.current || !entry.connected || !entry.adapter) continue;
      if (entry.adapter.state === "online") continue;
      let instance = null;
      try {
        instance = ledger.getInstance({ instanceId });
      } catch {
        instance = null;
      }
      if (!instance || instance.disabled || instance.stoppedAt !== null
        || instance.runId !== entry.registration.runId || instance.online) continue;
      if (!socketEnoent(entry.registration.socket.path)) continue;
      if (!processGone(entry.registration.observedServerPid)) continue;
      const stopped = ledger.confirmStopped({
        instanceId, runId: entry.registration.runId,
      });
      if (!stopped.stopped) continue;
      entry.connected = false;
      entry.stopped = true;
      addDiagnostic("OFFLINE_CONFIRMED", {
        instanceId, runId: entry.registration.runId,
      });
      disposeEntry(entry);
    }
  }

  async function scan() {
    if (disposed) return getState();
    if (scanPromise) return scanPromise;
    scanning = true;
    const scanned = (async () => {
      const registry = readHerdrRegistry({ registryDir });
      lastRegistry = {
        found: registry.found,
        truncated: registry.truncated === true,
        diagnostics: registry.diagnostics,
        registrations: registry.registrations,
      };
      lastScanAt = now();
      reconcile(registry);
      confirmStoppedRuns();
      return getState();
    })().finally(() => {
      scanning = false;
      scanPromise = null;
    });
    scanPromise = scanned.then((state) => {
      notifyStateChange();
      return state;
    });
    return scanPromise;
  }

  function getState() {
    const instances = [...entries.values()].map((entry) => {
      let instance = null;
      try {
        instance = ledger.getInstance({ instanceId: entry.registration.instanceId });
      } catch {
        instance = null;
      }
      let agents = [];
      if (instance) {
        try {
          agents = ledger.listAgents({
            instanceId: entry.registration.instanceId,
            runId: entry.registration.runId,
          });
        } catch {
          agents = [];
        }
      }
      return {
        instanceId: entry.registration.instanceId,
        runId: entry.registration.runId,
        endpoint: entry.endpoint,
        registered: entry.current === true,
        stopped: entry.stopped === true
          || (instance !== null && instance.stoppedAt !== null
            && instance.runId === entry.registration.runId),
        connected: entry.connected === true,
        disabled: instance?.disabled === true,
        online: instance?.online === true && entry.adapter?.state === "online",
        adapterState: entry.adapter?.state ?? null,
        lastError: entry.lastError,
        agents: agents.map((agent) => ({
          agentId: agent.agentId,
          label: agent.label,
          effectiveState: agent.effectiveState,
          lastKnownState: agent.lastKnownState,
          inSnapshot: agent.inSnapshot,
        })),
      };
    }).sort((left, right) => left.instanceId.localeCompare(right.instanceId));

    return {
      started, disposed, scanning, registryDir,
      lastScanAt,
      registry: {
        found: lastRegistry.found,
        truncated: lastRegistry.truncated,
        registrationCount: lastRegistry.registrations.length,
      },
      instances,
      diagnostics: [
        ...lastRegistry.diagnostics.map((item) => ({
          source: "registry", file: item.file, code: item.code,
        })),
        ...runtimeDiagnostics.map((item) => ({ source: "runtime", ...item })),
      ],
    };
  }

  async function start() {
    if (disposed) throw new AppError("HERDR_RUNTIME_DISPOSED", "运行管理已释放。");
    if (started) return getState();
    started = true;
    intervalTimer = setIntervalFn(() => {
      scan().catch(() => {});
    }, scanIntervalMs);
    intervalTimer?.unref?.();
    return scan();
  }

  function disable(instanceId) {
    if (disposed) throw new AppError("HERDR_RUNTIME_DISPOSED", "运行管理已释放。");
    const entry = entries.get(instanceId);
    const instance = entry
      ? (() => {
        try {
          return ledger.getInstance({ instanceId });
        } catch {
          return null;
        }
      })()
      : null;
    if (!entry || !instance) {
      throw new AppError("HERDR_RUNTIME_UNKNOWN_INSTANCE", "连接来源未登记。");
    }
    /* 先持久禁用再停止 adapter，迟到回调不能再以 online 运行。 */
    ledger.disableInstance({ instanceId });
    disposeEntry(entry);
    const state = getState();
    notifyStateChange();
    return state;
  }

  async function enable(instanceId) {
    if (disposed) throw new AppError("HERDR_RUNTIME_DISPOSED", "运行管理已释放。");
    let entry = entries.get(instanceId);
    if (!entry || !entry.current) {
      await scan();
      entry = entries.get(instanceId);
    }
    if (!entry || !entry.current || entry.registration.endpoint !== "matches") {
      throw new AppError("HERDR_RUNTIME_NOT_REGISTERED", "连接来源没有可连接的正式登记。");
    }
    const instance = (() => {
      try {
        return ledger.getInstance({ instanceId });
      } catch {
        return null;
      }
    })();
    if (!instance) {
      throw new AppError("HERDR_RUNTIME_UNKNOWN_INSTANCE", "连接来源未登记。");
    }
    /* disabled 只由明确用户动作恢复；扫描本身不会走到这里。 */
    ledger.enableInstance({ instanceId });
    await scan();
    return getState();
  }

  function dispose() {
    if (disposed) return getState();
    disposed = true;
    if (intervalTimer !== null) {
      clearIntervalFn(intervalTimer);
      intervalTimer = null;
    }
    for (const entry of entries.values()) {
      disposeEntry(entry);
    }
    return getState();
  }

  return {
    start, scan, getState, disable, enable, dispose,
  };
}

module.exports = { createHerdrRuntime };
