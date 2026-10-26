/* 正式画布播放器：只播放父进程提供的已导出帧。
   idle-v3 循环并在每圈结束发送 natural-node；wave-v2 仅作明确招呼候选。 */
const desktopApi = window.desktop;
const stage = document.getElementById("stage");
const sprite = document.getElementById("sprite");
const statusCard = document.getElementById("status");
const statusName = document.getElementById("status-name");
const statusNote = document.getElementById("status-note");

let currentKey = "";
let loadingKey = "";
let failedKey = "";
let displayKey = "";
let displayGeneration = 0;
let idle = null;
let wave = null;
let stretch = null;
let animationTimer = null;
let frameIndex = 0;
let playingWave = false;
let playingDaily = false;
let dailyActivityKey = "";
let dailyCharacterId = "";
let dailyProgress = 0;
let dailyActionReported = false;
let dailyConfirmed = false;
let activeDailyRun = null;
let assetReady = false;
let loadToken = 0;
let drag = null;
let canvasEpoch = 0;
let reportedHitFrame = null;

function stopAnimation() {
  if (animationTimer) {
    clearTimeout(animationTimer);
    animationTimer = null;
  }
  playingWave = false;
  playingDaily = false;
  activeDailyRun = null;
}

function showStatus(name, note) {
  statusName.textContent = name || "角色";
  statusNote.textContent = note || "";
  statusCard.hidden = false;
  sprite.hidden = true;
  clearHitFrame();
  if (desktopApi) {
    desktopApi.displayState("status", displayKey, displayGeneration, "");
  }
}

/* 只把当前实际显示的帧告诉主进程；status/加载中先报空帧恢复穿透。 */
function reportHitFrame(frame) {
  if (!desktopApi || sprite.hidden) return;
  const next = typeof frame === "string" ? frame : "";
  if (!next || next === reportedHitFrame) return;
  reportedHitFrame = next;
  desktopApi.hitFrame(next, displayKey, displayGeneration, canvasEpoch);
}

function clearHitFrame() {
  reportedHitFrame = null;
  if (desktopApi) {
    desktopApi.hitFrame("", displayKey, displayGeneration, canvasEpoch);
  }
}

function applyDisplayPlan(display) {
  if (!display) {
    sprite.style.width = "100%";
    sprite.style.height = "100%";
    sprite.style.left = "0px";
    sprite.style.top = "0px";
    return;
  }
  sprite.style.width = `${display.canvasWidth}px`;
  sprite.style.height = `${display.canvasHeight}px`;
  sprite.style.left = `${-display.offsetX}px`;
  sprite.style.top = `${-display.offsetY}px`;
}

function preloadFrames(frames) {
  return Promise.all(
    frames.map(
      (src) =>
        new Promise((resolve) => {
          const image = new Image();
          image.onload = () => resolve(true);
          image.onerror = () => resolve(false);
          image.src = src;
        }),
    ),
  ).then((results) => results.every(Boolean));
}

function sendNode(node, generation) {
  if (generation !== displayGeneration) {
    return;
  }
  if (!desktopApi) {
    return;
  }
  // 全部帧已完成但完成事实未确认（例如一次写库失败）时，随待机节点有界重报；
  // 仍以持久进度为据，不重新播放，也不把待机徽标当作完成。
  if (
    node === "idle-loop" &&
    dailyActivityKey &&
    dailyCharacterId &&
    !dailyConfirmed &&
    stretch &&
    dailyProgress >= stretch.frames.length
  ) {
    desktopApi.nodeComplete(
      "daily-action-complete",
      displayKey,
      generation,
      dailyActivityKey,
      dailyCharacterId,
    );
  }
  desktopApi.nodeComplete(node, displayKey, generation, "", "");
}

/* 一轮日常播放的身份在开始时固定；回调只使用该闭包身份，不读会被后续状态
   改写的全局活动 ID。活动换代时旧计时器已被停止，仍迟到的回调也核对失败。 */
function isCurrentDailyRun(run) {
  return Boolean(
    run
    && activeDailyRun === run
    && run.generation === displayGeneration
    && dailyActivityKey === run.activityId,
  );
}

function reportDailyProgress(run, frame) {
  if (!isCurrentDailyRun(run)) {
    return;
  }
  run.progress = Math.max(run.progress, frame);
  dailyProgress = Math.max(dailyProgress, run.progress);
  if (desktopApi) {
    desktopApi.activityProgress(
      run.activityId,
      run.characterId,
      run.progress,
      displayKey,
      run.generation,
    );
  }
}

function sendDailyComplete(run) {
  if (!isCurrentDailyRun(run) || dailyConfirmed || !desktopApi) {
    return false;
  }
  desktopApi.nodeComplete(
    "daily-action-complete",
    displayKey,
    run.generation,
    run.activityId,
    run.characterId,
  );
  return true;
}

function startIdle(generation) {
  if (generation !== displayGeneration) {
    return;
  }
  stopAnimation();
  if (!idle) {
    return;
  }
  assetReady = true;
  sprite.hidden = false;
  statusCard.hidden = true;
  frameIndex = 0;
  playFrames(idle, true, "idle-loop", () => startIdle(generation), generation);
  // 动作结束回到待机时也要上报，避免主进程保留上一动作的最后一帧。
  if (desktopApi) {
    desktopApi.displayState("character", displayKey, generation, sprite.src);
  }
}

function startWave() {
  if (!assetReady || !wave || playingWave || playingDaily) {
    return;
  }
  const generation = displayGeneration;
  stopAnimation();
  playingWave = true;
  frameIndex = 0;
  playFrames(wave, false, "wave", () => {
    playingWave = false;
    startIdle(generation);
  }, generation);
}

/* 日常伸展按已持久化的已完成帧数衔接；同 ID 反复暂停不会每次从第 0 帧重播。
   全部帧已完成但完成回报丢失时，按真实进度补发一次完成，不重新播放。 */
function startDailyStretch(progress) {
  if (!assetReady || !stretch || !dailyActivityKey) {
    return;
  }
  // 新一代开始前彻底停掉上一轮计时器，旧回调不能再写任何进度或完成。
  stopAnimation();
  const generation = displayGeneration;
  const total = stretch.frames.length;
  const start = Math.min(Math.max(0, Math.floor(progress) || 0), total);
  const run = {
    activityId: dailyActivityKey,
    characterId: dailyCharacterId,
    generation,
    progress: start,
  };
  activeDailyRun = run;
  dailyProgress = Math.max(dailyProgress, start);
  dailyActionReported = false;
  if (start >= total) {
    dailyActionReported = true;
    sendDailyComplete(run);
    startIdle(generation);
    return;
  }
  playingDaily = true;
  sprite.hidden = false;
  statusCard.hidden = true;
  frameIndex = start;
  playFrames(stretch, false, "daily-action-complete", () => {
    if (!isCurrentDailyRun(run)) {
      return;
    }
    dailyActionReported = true;
    startIdle(generation);
  }, generation, run);
}

function clearDailyAction({ restartIdle = false } = {}) {
  dailyActivityKey = "";
  dailyCharacterId = "";
  dailyProgress = 0;
  dailyActionReported = false;
  dailyConfirmed = false;
  activeDailyRun = null;
  if (restartIdle && playingDaily) {
    const generation = displayGeneration;
    stopAnimation();
    startIdle(generation);
  }
}

function syncActivity(state) {
  if (!assetReady) {
    return;
  }
  const activity = state?.activity;
  const valid =
    activity?.kind === "daily" &&
    ["running", "paused"].includes(activity.status) &&
    Boolean(stretch);
  if (!valid) {
    if (dailyActivityKey) {
      clearDailyAction({ restartIdle: true });
    }
    return;
  }
  if (dailyActivityKey !== activity.activityId) {
    // 同角色换活动：先停掉上一轮计时器，再绑定新身份。
    if (playingDaily || activeDailyRun) {
      stopAnimation();
    }
    dailyActivityKey = activity.activityId;
    dailyCharacterId = activity.characterId ?? state.character?.id ?? "";
    dailyProgress = 0;
    dailyActionReported = false;
    dailyConfirmed = false;
  }
  dailyProgress = Math.max(
    dailyProgress,
    Number.isInteger(activity.actionProgress) ? activity.actionProgress : 0,
  );
  dailyConfirmed = activity.actionComplete === true;
  if (activity.actionComplete) {
    // 已完成动作只保持事实：切换/重启都不再重播。
    dailyActionReported = true;
    if (playingDaily) {
      clearDailyAction({ restartIdle: true });
    }
    return;
  }
  if (activity.status === "paused") {
    // 停住画面但保留同 ID 进度；恢复时从已完成帧续播，不清空活动身份。
    if (playingDaily) {
      const generation = displayGeneration;
      stopAnimation();
      startIdle(generation);
    }
    return;
  }
  if (!dailyActionReported && !playingDaily) {
    startDailyStretch(dailyProgress);
  }
}

function playFrames(animation, loop, nodeName, onEnd, generation, dailyRun = null) {
  if (generation !== displayGeneration) {
    return;
  }
  const frames = animation.frames;
  const durations = animation.durations;
  if (!frames.length) {
    return;
  }

  sprite.src = frames[frameIndex];
  // 主进程按这帧的实际 alpha 决定接收还是穿透，换帧后指针静止也要重判。
  reportHitFrame(sprite.src);
  // 日常动作逐帧上报实际文件与闭包身份；待机仍按圈上报。
  if (desktopApi && dailyRun) {
    desktopApi.displayState("character", displayKey, generation, sprite.src);
  }
  animationTimer = setTimeout(() => {
    if (generation !== displayGeneration) {
      return;
    }
    frameIndex += 1;
    if (dailyRun) {
      reportDailyProgress(dailyRun, frameIndex);
    }
    if (frameIndex >= frames.length) {
      if (dailyRun) {
        if (!isCurrentDailyRun(dailyRun)) {
          return;
        }
        dailyActionReported = true;
        sendDailyComplete(dailyRun);
        onEnd();
        return;
      }
      sendNode(nodeName, generation);
      if (loop) {
        frameIndex = 0;
        playFrames(animation, true, nodeName, onEnd, generation);
      } else {
        onEnd();
      }
      return;
    }
    playFrames(animation, loop, nodeName, onEnd, generation, dailyRun);
  }, Math.max(16, durations[frameIndex] ?? 180));
}

function invalidateDisplay(nextKey) {
  cancelDrag();
  displayGeneration += 1;
  displayKey = nextKey || "";
  loadToken += 1;
  loadingKey = "";
  clearDailyAction();
  stopAnimation();
  assetReady = false;
  reportedHitFrame = null;
  sprite.hidden = true;
  return displayGeneration;
}

async function applyState(state) {
  if (state && Number.isInteger(state.epoch)) {
    canvasEpoch = state.epoch;
  }
  if (state?.visible === false) {
    cancelDrag();
  }
  if (!state || !state.character) {
    invalidateDisplay("");
    currentKey = "";
    failedKey = "";
    applyDisplayPlan(null);
    showStatus("暂无同屏角色", "小窝会继续保留当前数据。");
    return;
  }

  const characterName = state.character.displayName || "角色";
  if (state.assetState !== "ready" || !state.animations) {
    invalidateDisplay(state.displayKey || `${state.character.id}:${state.assetState}`);
    currentKey = "";
    failedKey = "";
    applyDisplayPlan(null);
    showStatus(characterName, state.assetNote || "该角色的正式桌面素材尚未完成");
    return;
  }

  const key = `${state.character.id}:${state.animations.idle.frames.join("|")}:${state.animations.wave?.frames.join("|") ?? ""}:${state.animations.stretch?.frames.join("|") ?? ""}`;
  if (key === currentKey) {
    const nextDisplayKey = state.displayKey || displayKey;
    if (assetReady && !sprite.hidden && nextDisplayKey === displayKey) {
      displayKey = nextDisplayKey;
      applyDisplayPlan(state.animations.display);
      syncActivity(state);
      return;
    }
    // 缓存身份仍是 A，但 A 的画面已被后续加载隐藏：重新激活 A 并作废该加载。
    const generation = invalidateDisplay(nextDisplayKey);
    currentKey = key;
    idle = state.animations.idle;
    wave = state.animations.wave ?? null;
    stretch = state.animations.stretch ?? null;
    applyDisplayPlan(state.animations.display);
    sprite.alt = `${characterName}（桌面角色）`;
    startIdle(generation);
    syncActivity(state);
    return;
  }
  if (key === loadingKey) {
    displayKey = state.displayKey || displayKey;
    return;
  }
  if (key === failedKey) {
    return;
  }

  const generation = invalidateDisplay(state.displayKey || key);
  loadingKey = key;
  const token = loadToken;
  showStatus(characterName, "正在加载桌面素材…");

  const allFrames = [
    ...state.animations.idle.frames,
    ...(state.animations.wave?.frames ?? []),
    ...(state.animations.stretch?.frames ?? []),
  ];
  const loaded = await preloadFrames(allFrames);
  if (token !== loadToken || generation !== displayGeneration) {
    return;
  }
  if (!loaded) {
    loadingKey = "";
    failedKey = key;
    showStatus(characterName, "角色素材加载失败，画布将等待恢复。");
    assetReady = false;
    if (desktopApi) {
      desktopApi.assetError("角色帧加载失败");
    }
    return;
  }

  loadingKey = "";
  currentKey = key;
  idle = state.animations.idle;
  wave = state.animations.wave ?? null;
  stretch = state.animations.stretch ?? null;
  applyDisplayPlan(state.animations.display);
  sprite.alt = `${characterName}（桌面角色）`;
  startIdle(generation);
  syncActivity(state);
}

function beginDrag(event) {
  if (!event.isPrimary || event.button !== 0 || !desktopApi) {
    return;
  }
  // 主进程以当前显示帧 alpha 同步判定；透明像素不启动拖拽或招呼。
  const token = desktopApi.dragStart(
    event.screenX,
    event.screenY,
    event.clientX,
    event.clientY,
    displayKey,
    displayGeneration,
    canvasEpoch,
  );
  if (!Number.isInteger(token) || token <= 0) {
    reportPointerMove();
    return;
  }
  drag = {
    pointerId: event.pointerId,
    startX: event.screenX,
    startY: event.screenY,
    moved: false,
    token,
  };
  stage.classList.add("dragging");
  stage.setPointerCapture(event.pointerId);
  event.preventDefault();
}

function moveDrag(event) {
  if (!drag || event.pointerId !== drag.pointerId) {
    return;
  }
  if (
    Math.abs(event.screenX - drag.startX) > 3 ||
    Math.abs(event.screenY - drag.startY) > 3
  ) {
    drag.moved = true;
  }
  if (desktopApi && drag.moved) {
    desktopApi.dragMove(event.screenX, event.screenY, drag.token);
  }
}

function endDrag(event, cancelled = false) {
  if (!drag || event.pointerId !== drag.pointerId) {
    return;
  }
  const wasClick = !drag.moved && !cancelled;
  const token = drag.token;
  drag = null;
  stage.classList.remove("dragging");
  if (desktopApi) {
    desktopApi.dragEnd(token);
  }
  if (stage.hasPointerCapture(event.pointerId)) {
    stage.releasePointerCapture(event.pointerId);
  }
  if (wasClick) {
    startWave();
  }
}

/* 状态失效/隐藏时取消本地捕获，不把取消当点击；主进程已清理时不再回发。 */
function cancelDrag(notifyMain = true) {
  if (!drag) return;
  const { pointerId, token } = drag;
  drag = null;
  stage.classList.remove("dragging");
  if (stage.hasPointerCapture(pointerId)) {
    stage.releasePointerCapture(pointerId);
  }
  if (notifyMain && desktopApi) {
    desktopApi.dragEnd(token);
  }
}

/* 穿透时 Electron 会继续转发 mousemove；合并到每帧最多一次，让主进程按
   系统指针重新判定，不把坐标当作命中依据。 */
let pointerReportQueued = false;
function reportPointerMove() {
  if (!desktopApi || pointerReportQueued) return;
  pointerReportQueued = true;
  requestAnimationFrame(() => {
    pointerReportQueued = false;
    desktopApi.pointerMove(displayKey, displayGeneration, canvasEpoch);
  });
}

stage.addEventListener("pointerdown", beginDrag);
stage.addEventListener("pointermove", moveDrag);
stage.addEventListener("pointerup", (event) => endDrag(event));
stage.addEventListener("pointercancel", (event) => endDrag(event, true));
stage.addEventListener("contextmenu", (event) => event.preventDefault());
window.addEventListener("mousemove", reportPointerMove, { passive: true });

if (desktopApi) {
  desktopApi.onState(applyState);
  desktopApi.onCancelDrag(() => cancelDrag(false));
}
