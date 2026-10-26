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

/* 活动回报必须同时匹配当前展示角色、当前显示代次和明确活动 ID；
   不靠主进程“现在的”活动补身份。 */
function validActivitySource(message, presentation, displayedGeneration) {
  return Boolean(
    presentation?.character?.id
    && typeof message?.activityId === "string"
    && message.activityId.length > 0
    && message.characterId === presentation.character.id
    && message.displayKey === presentationAssetKey(presentation)
    && Number.isInteger(message.generation)
    && message.generation === displayedGeneration,
  );
}

/* 本次坐下完成必须带当前休息代次 token、当前展示末帧和代次；同角色
   上一轮的 rest-settled 即使 displayKey/generation 相同也不能放行。 */
function validRestSettled(
  message,
  presentation,
  displayedGeneration,
  displayedKey,
  displayedFrame,
) {
  const sitFrames = presentation?.animations?.sit?.frames;
  const lastSitFrame = Array.isArray(sitFrames) ? sitFrames[sitFrames.length - 1] : "";
  return Boolean(
    Number.isInteger(presentation?.restToken)
    && presentation.restToken > 0
    && Number.isInteger(message?.restToken)
    && message.restToken === presentation.restToken
    && nodeMatchesPresentation(message.displayKey, presentation)
    && Number.isInteger(message.generation)
    && message.generation === displayedGeneration
    && displayedKey === presentationAssetKey(presentation)
    && lastSitFrame
    && displayedFrame === lastSitFrame,
  );
}

/* 起身逆序是短自然节点，不证明休息坐下完成；只校验当前展示身份与代次。 */
function validRestStand(message, presentation, displayedGeneration) {
  return Boolean(
    nodeMatchesPresentation(message?.displayKey, presentation)
    && Number.isInteger(message?.generation)
    && message.generation === displayedGeneration,
  );
}

function notificationPresentation(view, presentationId) {
  return view?.presentations.find((item) => item.presentationId === presentationId) ?? null;
}

/* 旧子进程、旧视图 token 或不属于该呈现的事件都不能触发 presented。 */
function validateNotificationAck(view, message) {
  if (!view || message?.token !== view.token || message?.generation !== view.generation) {
    return false;
  }
  const presentation = notificationPresentation(view, message.presentationId);
  const ids = message.eventIds;
  if (!presentation || !Array.isArray(ids) || ids.length === 0) return false;
  if (new Set(ids).size !== ids.length) return false;
  const allowed = new Set(presentation.items.map((item) => item.eventId));
  return ids.every((id) => Number.isInteger(id) && allowed.has(id));
}

function validateNotificationClose(view, message) {
  return Boolean(
    view
    && message?.token === view.token
    && message?.generation === view.generation
    && notificationPresentation(view, message.presentationId),
  );
}

function createDesktopHost({
  dataDir,
  electronPath = process.execPath,
  onNodeComplete = () => {},
  onActivityProgress = () => {},
  onAssetError = () => {},
  onPositionChange = () => {},
  onStatusChange = () => {},
  onNotificationAck = () => {},
  onNotificationClose = () => {},
  onNotificationVisibilityChange = () => {},
}) {
  const profileDir = path.join(dataDir, "desktop-profile");
  fs.mkdirSync(profileDir, { recursive: true });

  let child = null;
  let desired = false;
  let ready = false;
  let lastPresentation = null;
  let restartTimes = [];
  let readyTimer = null;
  let readyTimerToken = 0;
  let restartTimer = null;
  let restartTimerToken = 0;
  let stderrTail = "";
  let rendererAssetError = false;
  let assetErrorMessage = null;
  let lastAssetKey = "";
  let lastDisplayGeneration = null;
  const boundaryWaiters = new Set();
  // 只记录当前展示身份与休息代次下真实完成的坐下；换 token/身份/子进程即清空。
  let restSettled = { token: 0, displayKey: "", generation: null, at: null };

  /* 通知只走同一条子进程通道。父进程保存最近一次视图与 token；
     renderer 的回执必须同时匹配 token、generation 和当前呈现内容。 */
  let channelReady = false;
  let notificationView = null;
  let notificationToken = 0;
  let notificationSignature = "";
  let notificationPanels = new Map();
  let notificationWindowFact = {};
  const notificationAckStats = { accepted: 0, rejected: 0 };

  function setNotificationWindowFact(next) {
    const wasVisible = notificationWindowFact.visible === true;
    notificationWindowFact = next;
    if (next.visible !== wasVisible) {
      try {
        onNotificationVisibilityChange(next.visible === true);
      } catch {
        // 可见性回调不参与通知事实，不影响子进程通道。
      }
    }
  }

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
    mode: null,
    activity: null,
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

  function hasVisibleNotifications() {
    return Boolean(
      notificationView
      && notificationView.visible
      && notificationView.presentations.length > 0,
    );
  }

  function wanted() {
    return desired || hasVisibleNotifications();
  }

  function sendNotifications() {
    if (!notificationView || !channelReady) return;
    send({
      type: "notifications",
      token: notificationView.token,
      generation: notificationView.generation,
      visible: notificationView.visible,
      presentations: notificationView.presentations,
    });
  }

  function panelFact(presentationId) {
    if (!notificationPanels.has(presentationId)) {
      notificationPanels.set(presentationId, {});
    }
    return notificationPanels.get(presentationId);
  }

  /* tick 只在视图内容或可见性变化时下发；相同视图不重复覆盖子进程 DOM。 */
  function updateNotifications(view, visible = true) {
    if (!view || !Array.isArray(view.presentations)) return;
    const signature = JSON.stringify({
      generation: view.generation,
      visible,
      presentations: view.presentations,
    });
    if (signature === notificationSignature) return;
    notificationSignature = signature;
    notificationToken += 1;
    notificationView = {
      token: notificationToken,
      generation: view.generation,
      visible,
      presentations: view.presentations,
    };
    const active = new Set(view.presentations.map((item) => item.presentationId));
    for (const presentationId of [...notificationPanels.keys()]) {
      if (!active.has(presentationId)) notificationPanels.delete(presentationId);
    }
    if (!child) {
      spawnChild();
      return;
    }
    sendNotifications();
  }

  function setNotificationsVisible(visible) {
    if (!notificationView) return;
    const signature = JSON.stringify({
      generation: notificationView.generation,
      visible,
      presentations: notificationView.presentations,
    });
    if (signature === notificationSignature) return;
    notificationSignature = signature;
    notificationToken += 1;
    notificationView = { ...notificationView, token: notificationToken, visible };
    sendNotifications();
  }

  function notificationStatus() {
    return {
      generation: notificationView?.generation ?? null,
      visible: Boolean(notificationView?.visible && hasVisibleNotifications()),
      token: notificationView?.token ?? null,
      ackStats: { ...notificationAckStats },
      window: notificationWindowFact,
      panels: notificationView
        ? notificationView.presentations.map((presentation) => ({
          presentationId: presentation.presentationId,
          channel: presentation.channel,
          slot: presentation.slot,
          itemCount: presentation.items.length,
          eventIds: presentation.items.map((item) => item.eventId),
          ...panelFact(presentation.presentationId),
        }))
        : [],
    };
  }

  function rememberPresentation(presentation) {
    const previous = lastPresentation;
    const key = presentationAssetKey(presentation);
    if (key !== lastAssetKey) {
      lastAssetKey = key;
      lastDisplayGeneration = null;
      rendererAssetError = false;
      assetErrorMessage = null;
      restSettled = { token: 0, displayKey: "", generation: null, at: null };
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
    if (previous?.restToken !== presentation.restToken) {
      restSettled = { token: 0, displayKey: "", generation: null, at: null };
    }
  }

  function spawnChild() {
    // 恢复等待由 handleExit 的单个 timer 负责；心跳/重复 start 不得抢跑。
    if (child || !wanted() || restartTimer || status.state === "failed") {
      return;
    }
    clearReadyTimer();
    setStatus({ state: "starting", pid: null, ready: false, error: null });
    ready = false;
    channelReady = false;
    lastDisplayGeneration = null;
    restSettled = { token: 0, displayKey: "", generation: null, at: null };

    const env = {
      PATH: process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: process.env.HOME || "",
      TMPDIR: process.env.TMPDIR || "",
      LANG: process.env.LANG || "zh_CN.UTF-8",
      BAYPER_DESKTOP_PROFILE: profileDir,
      BAYPER_DESKTOP_CHILD: "1",
      // 仅在验收进程显式开启时暴露调试端口；不影响正式启动。
      ...(process.env.BAYPER_DESKTOP_DEBUG_PORT
        ? { BAYPER_DESKTOP_DEBUG_PORT: process.env.BAYPER_DESKTOP_DEBUG_PORT }
        : {}),
      ...(process.env.BAYPER_NOTIFICATION_ACK_DELAY_MS
        ? { BAYPER_NOTIFICATION_ACK_DELAY_MS: process.env.BAYPER_NOTIFICATION_ACK_DELAY_MS }
        : {}),
      ...(process.env.BAYPER_NOTIFICATION_SHOWN_DELAY_MS
        ? { BAYPER_NOTIFICATION_SHOWN_DELAY_MS: process.env.BAYPER_NOTIFICATION_SHOWN_DELAY_MS }
        : {}),
      ...(process.env.BAYPER_NOTIFICATION_MAX_HEIGHT
        ? { BAYPER_NOTIFICATION_MAX_HEIGHT: process.env.BAYPER_NOTIFICATION_MAX_HEIGHT }
        : {}),
    };

    const spawned = spawn(electronPath, [DESKTOP_DIR], {
      cwd: DESKTOP_DIR,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child = spawned;
    stderrTail = "";

    const lines = readline.createInterface({ input: spawned.stdout });
    lines.on("line", (line) => handleLine(spawned, line));
    spawned.stderr.on("data", (chunk) => {
      if (child === spawned) {
        stderrTail = `${stderrTail}${chunk.toString()}`.slice(-800);
      }
    });
    spawned.on("error", (error) => {
      if (child !== spawned) {
        return;
      }
      child = null;
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

    armReadyTimer(spawned);
  }

  function handleLine(processHandle, line) {
    // 旧子进程的延迟 ready/display 等消息不能跨代次更新当前状态。
    if (child !== processHandle || status.state === "failed") {
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || typeof message.type !== "string") {
      return;
    }

    if (message.type === "channel-ready") {
      // 无角色时通知仍需可用；通道就绪不等于角色画布 ready。
      channelReady = true;
      if (lastPresentation) sendState();
      sendNotifications();
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
      const activityId = typeof message.activityId === "string" ? message.activityId : "";
      const characterId = typeof message.characterId === "string" ? message.characterId : "";
      const restToken = Number.isInteger(message.restToken) ? message.restToken : 0;
      if (node === "daily-action-complete") {
        // 动作完成必须来自当前展示角色、同一显示代次和明确活动 ID。
        if (!validActivitySource(message, lastPresentation, lastDisplayGeneration)) {
          return;
        }
      } else if (node === "rest-settled") {
        if (!validRestSettled(
          message,
          lastPresentation,
          lastDisplayGeneration,
          status.displayedKey,
          status.displayedFrame,
        )) {
          return;
        }
        restSettled = {
          token: restToken,
          displayKey: message.displayKey,
          generation: message.generation,
          at: Date.now(),
        };
      } else if (node === "rest-stand" && !validRestStand(
        message,
        lastPresentation,
        lastDisplayGeneration,
      )) {
        return;
      }
      status = { ...status, lastNode: node, lastNodeAt: Date.now() };
      onNodeComplete(node, {
        activityId,
        characterId,
        generation: message.generation,
        restToken,
      });
      resolveBoundaries({ ok: true, node, restToken }, message);
      return;
    }

    if (message.type === "activity-progress") {
      const progress = Number(message.progress);
      if (
        !validActivitySource(message, lastPresentation, lastDisplayGeneration)
        || !Number.isInteger(progress)
        || progress < 0
        || progress > 64
      ) {
        return;
      }
      onActivityProgress({
        activityId: message.activityId,
        characterId: message.characterId,
        progress,
      });
      return;
    }

    if (message.type === "bounds") {
      if (message.bounds) {
        // 几何更新只改变窗口边界，不清除加载错误、最后节点或展示身份。
        setStatus({ bounds: message.bounds });
      }
      return;
    }

    if (message.type === "display-state") {
      const displayKey = typeof message.displayKey === "string" ? message.displayKey : "";
      if (displayKey && displayKey === presentationAssetKey(lastPresentation)) {
        lastDisplayGeneration = Number.isInteger(message.generation)
          ? message.generation
          : null;
      }
      status = {
        ...status,
        displayedKind: message.kind === "character" ? "character" : "status",
        displayedKey: displayKey,
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
      return;
    }

    if (message.type === "notification-shown") {
      // 已要求隐藏时，迟到的 shown(true) 不能把隐藏意图或实际状态改回可见。
      const intendedVisible = notificationView?.visible !== false;
      setNotificationWindowFact({
        visible: message.visible === true && intendedVisible,
        shownAt: Number.isFinite(message.shownAt) ? message.shownAt : null,
        bounds: message.bounds ?? null,
        windowId: Number.isInteger(message.windowId) ? message.windowId : null,
        focusable: message.focusable === true,
        captureId: typeof message.captureId === "string" ? message.captureId : null,
      });
      return;
    }

    if (message.type === "notification-visible") {
      const fact = panelFact(message.presentationId);
      fact.renderedEventIds = Array.isArray(message.eventIds) ? message.eventIds : [];
      fact.renderedAt = Date.now();
      fact.renderedComplete = message.complete === true;
      return;
    }

    if (message.type === "notification-ack") {
      /* 明确回执结果：旧 token 或暂时写入失败由 renderer 有界重试，
         不放宽 token 校验，也不假定发送一次即成功。 */
      let accepted = false;
      if (validateNotificationAck(notificationView, message)) {
        accepted = onNotificationAck({
          presentationId: message.presentationId,
          eventIds: message.eventIds,
          generation: message.generation,
          token: message.token,
        }) === true;
      }
      notificationAckStats[accepted ? "accepted" : "rejected"] += 1;
      if (accepted) {
        const fact = panelFact(message.presentationId);
        fact.ackedEventIds = [...new Set([
          ...(fact.ackedEventIds ?? []),
          ...message.eventIds,
        ])];
        fact.ackAt = Date.now();
      }
      send({
        type: "notification-ack-result",
        token: notificationView?.token ?? null,
        presentationId: message.presentationId,
        eventIds: message.eventIds,
        accepted,
      });
      return;
    }

    if (message.type === "notification-close") {
      if (!validateNotificationClose(notificationView, message)) {
        return;
      }
      const fact = panelFact(message.presentationId);
      fact.closedAt = Date.now();
      onNotificationClose({
        presentationId: message.presentationId,
        generation: message.generation,
        token: message.token,
      });
    }
  }

  function handleExit(processHandle, code, signal) {
    if (child !== processHandle) {
      return;
    }
    const wasWanted = wanted();
    child = null;
    ready = false;
    channelReady = false;
    lastDisplayGeneration = null;
    restSettled = { token: 0, displayKey: "", generation: null, at: null };
    notificationPanels.clear();
    setNotificationWindowFact({});
    clearReadyTimer();
    clearRestartTimer();
    resolveBoundaries({ ok: false, reason: "child-exit" });

    if (!wasWanted) {
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
      scheduleRestart();
    } else {
      clearRestartTimer();
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
      mode: lastPresentation.mode ?? null,
      activity: lastPresentation.activity ?? null,
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
    if (restartTimer) {
      // 有界恢复等待期间的重复 start/心跳不得抢跑；由 timer 统一拉起。
      return;
    }
    if (!child && status.state === "failed") {
      // 连续失败后等待托盘显式重启，心跳不会绕过有界恢复。
      return;
    }
    if (child) {
      if (ready) {
        sendState();
      } else if (!readyTimer) {
        // 通知-only 启动不设角色 ready 超时；角色出现后才开始计时。
        armReadyTimer(child);
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

  function waitForNodeBoundary(timeoutMs = 3000, options = {}) {
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
    // 休息坐下只接受本次 token 的 rest-settled；其他节点不得提前解除等待。
    const expectedNode = typeof options.node === "string" ? options.node : "";
    const expectedRestToken = Number.isInteger(options.restToken) ? options.restToken : 0;
    const accepts = expectedNode === "rest-settled" && expectedRestToken > 0
      ? (result) => !result?.ok
        || (result.node === "rest-settled" && result.restToken === expectedRestToken)
      : null;
    return new Promise((resolve) => {
      const waiter = { resolve, timer: null, accepts };
      waiter.timer = setTimeout(() => {
        boundaryWaiters.delete(waiter);
        resolve({ ok: false, reason: "timeout" });
      }, timeoutMs);
      boundaryWaiters.add(waiter);
    });
  }

  function resolveBoundaries(result) {
    for (const waiter of boundaryWaiters) {
      if (waiter.accepts && !waiter.accepts(result)) {
        continue;
      }
      clearTimeout(waiter.timer);
      boundaryWaiters.delete(waiter);
      waiter.resolve(result);
    }
  }

  function clearReadyTimer() {
    readyTimerToken += 1;
    if (readyTimer) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }
  }

  function armReadyTimer(spawned) {
    clearReadyTimer();
    const token = ++readyTimerToken;
    readyTimer = setTimeout(() => {
      if (token !== readyTimerToken) {
        return;
      }
      readyTimer = null;
      if (child === spawned && !ready && desired) {
        setStatus({ state: "failed", error: "角色画布启动超时" });
        spawned.kill("SIGTERM");
      }
    }, READY_TIMEOUT_MS);
  }

  function clearRestartTimer() {
    restartTimerToken += 1;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
  }

  function scheduleRestart() {
    clearRestartTimer();
    const token = ++restartTimerToken;
    restartTimer = setTimeout(() => {
      if (token !== restartTimerToken) {
        return;
      }
      restartTimer = null;
      spawnChild();
    }, 800);
  }

  async function stop() {
    desired = false;
    clearRestartTimer();
    clearReadyTimer();
    resolveBoundaries({ ok: false, reason: "stopping" });
    notificationView = null;
    notificationSignature = "";
    notificationPanels.clear();
    setNotificationWindowFact({});
    const running = child;
    if (!running) {
      channelReady = false;
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
    channelReady = false;
    clearReadyTimer();
    setStatus({ state: "stopped", ready: false, pid: null });
  }

  /* 角色消失不等于退出：通知仍可能待呈现，子进程继续承载通知窗口。 */
  function stopRole() {
    if (!desired && !lastPresentation) return;
    desired = false;
    lastPresentation = null;
    clearReadyTimer();
    if (child) send({ type: "role-hidden" });
    if (!hasVisibleNotifications()) {
      stop().catch(() => {});
    }
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
      restToken: lastPresentation?.restToken ?? 0,
      restSettledToken: restSettled.token,
      restSettledAt: restSettled.at,
      notifications: notificationStatus(),
    };
  }

  function hasBoundaryWaiters() {
    return boundaryWaiters.size > 0;
  }

  return {
    start,
    update,
    stop,
    stopRole,
    restart,
    getStatus,
    updateNotifications,
    setNotificationsVisible,
    waitForNodeBoundary,
    hasBoundaryWaiters,
  };
}

module.exports = {
  createDesktopHost,
  presentationAssetKey,
  nodeMatchesPresentation,
  validActivitySource,
  validRestSettled,
  validRestStand,
  validateNotificationAck,
  validateNotificationClose,
};
