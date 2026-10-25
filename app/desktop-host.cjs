/* 角色画布子进程的父侧宿主。只维护一个自建 Electron 子进程，
   通过 stdin/stdout JSON 行收发有限显示状态与节点信号，不传数据库或 Key。 */
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");

const DESKTOP_DIR = path.join(__dirname, "desktop");
const READY_TIMEOUT_MS = 10000;
const STOP_TIMEOUT_MS = 1500;
const RESTART_WINDOW_MS = 60000;
const MAX_RESTARTS = 2;

function presentationAssetKey(presentation) {
  if (!presentation) {
    return "";
  }
  return `${presentation.character?.id ?? ""}:${presentation.assetState}:${presentation.animations?.idle?.frames?.[0] ?? ""}`;
}

function nodeMatchesPresentation(displayKey, presentation) {
  return Boolean(displayKey) && displayKey === presentationAssetKey(presentation);
}

function createDesktopHost({
  dataDir,
  electronPath = process.execPath,
  onNodeComplete = () => {},
  onAssetError = () => {},
  onPositionChange = () => {},
  onStatusChange = () => {},
}) {
  const profileDir = path.join(dataDir, "desktop-profile");
  fs.mkdirSync(profileDir, { recursive: true });

  let child = null;
  let desired = false;
  let ready = false;
  let lastPresentation = null;
  let restartTimes = [];
  let readyTimer = null;
  let restartTimer = null;
  let stderrTail = "";
  let rendererAssetError = false;
  let assetErrorMessage = null;
  let lastAssetKey = "";
  const boundaryWaiters = new Set();

  let status = {
    state: "stopped",
    pid: null,
    ready: false,
    bounds: null,
    windowType: null,
    focusable: null,
    transparent: null,
    activationPolicy: null,
    assetState: "none",
    assetLabel: "未启动",
    characterId: null,
    restarts: 0,
    error: null,
    lastNode: null,
    lastNodeAt: null,
    displayedKind: null,
    displayedKey: null,
    displayedFrame: null,
    displayedAt: null,
  };

  function notify() {
    onStatusChange({ ...status });
  }

  function setStatus(patch) {
    const next = { ...status, ...patch };
    if (JSON.stringify(next) === JSON.stringify(status)) {
      return;
    }
    status = next;
    notify();
  }


  function rememberPresentation(presentation) {
    const key = presentationAssetKey(presentation);
    if (key !== lastAssetKey) {
      lastAssetKey = key;
      rendererAssetError = false;
      assetErrorMessage = null;
      status = {
        ...status,
        lastNode: null,
        lastNodeAt: null,
        displayedKind: null,
        displayedKey: null,
        displayedFrame: null,
        displayedAt: null,
      };
    }
    lastPresentation = presentation;
  }

  function spawnChild() {
    restartTimer = null;
    if (child || !desired) {
      return;
    }
    setStatus({ state: "starting", pid: null, ready: false, error: null });
    ready = false;

    const env = {
      PATH: process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: process.env.HOME || "",
      TMPDIR: process.env.TMPDIR || "",
      LANG: process.env.LANG || "zh_CN.UTF-8",
      BAYPER_DESKTOP_PROFILE: profileDir,
      BAYPER_DESKTOP_CHILD: "1",
    };

    const spawned = spawn(electronPath, [DESKTOP_DIR], {
      cwd: DESKTOP_DIR,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child = spawned;
    stderrTail = "";

    const lines = readline.createInterface({ input: spawned.stdout });
    lines.on("line", (line) => handleLine(line));
    spawned.stderr.on("data", (chunk) => {
      stderrTail = `${stderrTail}${chunk.toString()}`.slice(-800);
    });
    spawned.on("error", (error) => {
      if (child === spawned) {
        child = null;
      }
      clearReadyTimer();
      setStatus({
        state: "failed",
        ready: false,
        pid: null,
        error: `角色画布启动失败：${error.message}`,
      });
      resolveBoundaries({ ok: false, reason: "spawn-error" });
    });
    spawned.on("exit", (code, signal) => handleExit(spawned, code, signal));

    readyTimer = setTimeout(() => {
      if (child === spawned && !ready) {
        setStatus({ state: "failed", error: "角色画布启动超时" });
        spawned.kill("SIGTERM");
      }
    }, READY_TIMEOUT_MS);
  }

  function handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || typeof message.type !== "string") {
      return;
    }

    if (message.type === "ready") {
      clearReadyTimer();
      ready = true;
      rendererAssetError = false;
      assetErrorMessage = null;
      setStatus({
        state: "running",
        ready: true,
        pid: message.pid ?? null,
        bounds: message.bounds ?? null,
        windowType: message.windowType ?? null,
        focusable: message.focusable ?? null,
        transparent: message.transparent ?? null,
        activationPolicy: message.activationPolicy ?? null,
        restarts: restartTimes.length,
        error: null,
        lastNode: null,
        lastNodeAt: null,
        displayedKind: null,
        displayedKey: null,
        displayedFrame: null,
        displayedAt: null,
      });
      sendState();
      return;
    }

    if (message.type === "node-complete") {
      const node = typeof message.node === "string" ? message.node : "unknown";
      if (!nodeMatchesPresentation(message.displayKey, lastPresentation)) {
        // 旧展示的迟到节点不能完成新身份的自然节点。
        return;
      }
      status = { ...status, lastNode: node, lastNodeAt: Date.now() };
      onNodeComplete(node);
      resolveBoundaries({ ok: true, node });
      return;
    }

    if (message.type === "display-state") {
      status = {
        ...status,
        displayedKind: message.kind === "character" ? "character" : "status",
        displayedKey: typeof message.displayKey === "string" ? message.displayKey : "",
        displayedFrame: typeof message.frame === "string" ? message.frame : "",
        displayedAt: Date.now(),
      };
      return;
    }

    if (message.type === "asset-error") {
      rendererAssetError = true;
      assetErrorMessage = message.message || "角色素材加载失败";
      setStatus({ assetState: "error", error: assetErrorMessage });
      resolveBoundaries({ ok: false, reason: "asset-error" });
      onAssetError(assetErrorMessage);
      return;
    }

    if (message.type === "position-changed") {
      if (Number.isFinite(message.x) && Number.isFinite(message.y)) {
        onPositionChange(Math.round(message.x), Math.round(message.y));
      }
    }
  }

  function handleExit(processHandle, code, signal) {
    if (child !== processHandle) {
      return;
    }
    const wasDesired = desired;
    child = null;
    ready = false;
    clearReadyTimer();
    resolveBoundaries({ ok: false, reason: "child-exit" });

    if (!wasDesired) {
      setStatus({ state: "stopped", ready: false, pid: null });
      return;
    }

    const now = Date.now();
    restartTimes = restartTimes.filter((time) => now - time < RESTART_WINDOW_MS);
    restartTimes.push(now);
    const tail = stderrTail.trim().split("\n").slice(-2).join(" ").slice(0, 300);
    const reason = `角色画布意外退出（code=${code}, signal=${signal}）${tail ? `：${tail}` : ""}`;

    if (restartTimes.length <= MAX_RESTARTS) {
      setStatus({
        state: "restarting",
        ready: false,
        pid: null,
        restarts: restartTimes.length,
        error: `${reason}；正在恢复 ${restartTimes.length}/${MAX_RESTARTS}`,
      });
      restartTimer = setTimeout(spawnChild, 800);
    } else {
      setStatus({
        state: "failed",
        ready: false,
        pid: null,
        restarts: restartTimes.length,
        error: `${reason}；连续退出，已停止自动恢复`,
      });
    }
  }

  function send(message) {
    if (!child || !child.stdin.writable) {
      return false;
    }
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  function sendState() {
    if (!lastPresentation) {
      return;
    }
    setStatus({
      assetState: rendererAssetError ? "error" : lastPresentation.assetState,
      assetLabel: rendererAssetError ? "加载失败" : lastPresentation.assetLabel,
      characterId: lastPresentation.character?.id ?? null,
      error: rendererAssetError
        ? assetErrorMessage
        : lastPresentation.assetState === "error"
          ? "角色素材不可用"
          : null,
    });
    send({
      type: "state",
      ...lastPresentation,
      displayKey: presentationAssetKey(lastPresentation),
    });
  }

  function start(presentation) {
    desired = true;
    rememberPresentation(presentation);
    setStatus({
      assetState: rendererAssetError ? "error" : presentation.assetState,
      assetLabel: rendererAssetError ? "加载失败" : presentation.assetLabel,
      characterId: presentation.character?.id ?? null,
    });
    if (!child && status.state === "failed") {
      // 连续失败后等待托盘显式重启，心跳不会绕过有界恢复。
      return;
    }
    if (child) {
      if (ready) {
        sendState();
      }
      return;
    }
    spawnChild();
  }

  function update(presentation) {
    rememberPresentation(presentation);
    setStatus({
      assetState: rendererAssetError ? "error" : presentation.assetState,
      assetLabel: rendererAssetError ? "加载失败" : presentation.assetLabel,
      characterId: presentation.character?.id ?? null,
    });
    if (ready) {
      sendState();
    }
  }

  function waitForNodeBoundary(timeoutMs = 3000) {
    if (
      rendererAssetError ||
      status.assetState === "error" ||
      lastPresentation?.assetState === "error"
    ) {
      return Promise.resolve({ ok: false, reason: "asset-error" });
    }
    if (
      !ready ||
      !lastPresentation ||
      lastPresentation.assetState !== "ready" ||
      status.assetState !== "ready"
    ) {
      return Promise.resolve({ ok: true, reason: "no-canvas-node" });
    }
    return new Promise((resolve) => {
      const waiter = { resolve, timer: null };
      waiter.timer = setTimeout(() => {
        boundaryWaiters.delete(waiter);
        resolve({ ok: false, reason: "timeout" });
      }, timeoutMs);
      boundaryWaiters.add(waiter);
    });
  }

  function resolveBoundaries(result) {
    for (const waiter of boundaryWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(result);
    }
    boundaryWaiters.clear();
  }

  function clearReadyTimer() {
    if (readyTimer) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }
  }

  async function stop() {
    desired = false;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    resolveBoundaries({ ok: false, reason: "stopping" });
    const running = child;
    if (!running) {
      setStatus({ state: "stopped", ready: false, pid: null });
      return;
    }
    send({ type: "quit" });
    await waitForExit(running, STOP_TIMEOUT_MS);
    if (child === running) {
      running.kill("SIGTERM");
      await waitForExit(running, 500);
    }
    if (child === running) {
      running.kill("SIGKILL");
      child = null;
    }
    ready = false;
    clearReadyTimer();
    setStatus({ state: "stopped", ready: false, pid: null });
  }

  function waitForExit(processHandle, timeoutMs) {
    return new Promise((resolve) => {
      if (processHandle.exitCode !== null || child !== processHandle) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, timeoutMs);
      processHandle.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async function restart(presentation) {
    desired = false;
    await stop();
    restartTimes = [];
    start(presentation ?? lastPresentation);
  }

  function getStatus() {
    return {
      ...status,
      assetState: rendererAssetError
        ? "error"
        : lastPresentation?.assetState ?? status.assetState ?? "none",
      assetLabel: rendererAssetError
        ? "加载失败"
        : lastPresentation?.assetLabel ?? status.assetLabel,
      characterId: lastPresentation?.character?.id ?? null,
    };
  }

  function hasBoundaryWaiters() {
    return boundaryWaiters.size > 0;
  }

  return {
    start,
    update,
    stop,
    restart,
    getStatus,
    waitForNodeBoundary,
    hasBoundaryWaiters,
  };
}

module.exports = {
  createDesktopHost,
  presentationAssetKey,
  nodeMatchesPresentation,
};
