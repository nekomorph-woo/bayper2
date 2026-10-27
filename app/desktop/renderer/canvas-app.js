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
let sit = null;
let drowsy = null;
let sleep = null;
let animationTimer = null;
let frameIndex = 0;
let playingWave = false;
let playingDaily = false;
let playingDrowsy = false;
let playingSleep = false;
let restActive = false;
let restSitting = false;
let restPhase = "seated";
let restExiting = false;
let restExitPending = false;
let sleepEligible = false;
let restSuspended = false;
let activeRestToken = 0;
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
  playingDrowsy = false;
  playingSleep = false;
  restSitting = false;
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

function currentBoundaryKind(node) {
  if (node !== "rest-sleep-boundary") {
    return "";
  }
  if (restPhase === "drowsy") return "drowsy-end";
  if (restPhase === "sleep") return "sleep-end";
  if (restPhase === "waking") return "wake-end";
  return "";
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
  // 休息节点带本次 token；起身/睡眠有限边界沿用旧 token，只用于短节点收束证明。
  const restToken =
    node === "rest-settled" || node === "rest-stand" || node === "rest-sleep-boundary"
      ? activeRestToken
      : 0;
  desktopApi.nodeComplete(
    node,
    displayKey,
    generation,
    "",
    "",
    restToken,
    currentBoundaryKind(node),
  );
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
  if (!assetReady || !wave || playingWave || playingDaily || restActive) {
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

/* 休息只播放一次坐下并保留末帧；没有坐姿素材的角色不借用其他角色图片。
   逐帧上报真实帧文件，供主进程与验收读取实际播放序列。 */
function startRest(generation, token) {
  if (generation !== displayGeneration) {
    return;
  }
  restActive = true;
  activeRestToken = Number.isInteger(token) ? token : 0;
  restPhase = "seated";
  restSitting = false;
  restExiting = false;
  restExitPending = false;
  playingDrowsy = false;
  playingSleep = false;
  if (!sit) {
    startIdle(generation);
    return;
  }
  stopAnimation();
  assetReady = true;
  sprite.hidden = false;
  statusCard.hidden = true;
  frameIndex = 0;
  restSitting = true;
  playFrames(sit, false, "rest-settled", () => {
    if (generation !== displayGeneration) {
      return;
    }
    restSitting = false;
    // 真实坐下完成；若主进程已给出睡眠资格，再进入困倦。
    applyRestSleepState(generation);
  }, generation, null, true);
}

/* 起身复用已验收坐下帧的逆序，不是新绘制素材；播放完这个短节点后回待机。 */
function startStandUp(generation) {
  restPhase = "seated";
  restSitting = false;
  playingDrowsy = false;
  playingSleep = false;
  if (!sit || sprite.src !== sit.frames[sit.frames.length - 1]) {
    // 未真实停在末帧（例如播放器恢复路径）时直接回待机，避免逆序跳帧。
    restActive = false;
    restExiting = false;
    restExitPending = false;
    activeRestToken = 0;
    startIdle(generation);
    return;
  }
  const reverse = {
    frames: [...sit.frames].reverse(),
    durations: [...sit.durations].reverse(),
  };
  frameIndex = 0;
  playFrames(reverse, false, "rest-stand", () => {
    activeRestToken = 0;
    restActive = false;
    restExiting = false;
    restExitPending = false;
    startIdle(generation);
  }, generation, null, true);
}

/* 睡眠只在真实坐定后开始；主进程给出单一 sleepEligible，renderer 只负责
   播放真实帧与有限边界，不自行重复计时。 */
function settleSitFrame(generation) {
  if (!sit || generation !== displayGeneration) {
    return;
  }
  frameIndex = sit.frames.length - 1;
  sprite.src = sit.frames[frameIndex];
  reportHitFrame(sprite.src);
  if (desktopApi) {
    desktopApi.displayState("character", displayKey, generation, sprite.src);
  }
}

function suspendRest(generation) {
  if (!restActive) {
    return;
  }
  // 坐下过渡本身很短且必须真实完成 rest-settled；锁屏/隐藏时让它自然收束，
  // 完成后再停帧。困倦/睡眠/唤醒阶段则立即停止。
  if (restSitting) {
    return;
  }
  if (
    restPhase === "seated"
    && !playingDrowsy
    && !playingSleep
    && !animationTimer
    && (!sit || sprite.src === sit.frames[sit.frames.length - 1])
  ) {
    return;
  }
  stopAnimation();
  restPhase = "seated";
  restSitting = false;
  if (sit) {
    settleSitFrame(generation);
  } else {
    startIdle(generation);
  }
}

function startDrowsy(generation) {
  if (!drowsy || !restActive || restSitting || generation !== displayGeneration) {
    return;
  }
  stopAnimation();
  restPhase = "drowsy";
  playingDrowsy = true;
  frameIndex = 0;
  playFrames(drowsy, false, "rest-sleep-boundary", () => {
    if (generation !== displayGeneration || !restActive) {
      return;
    }
    playingDrowsy = false;
    if (restExitPending) {
      // 继续陪伴：先完成当前困倦短段，再 7/6/0 回 sit 末帧，最后走既有逆坐起身。
      startWake(generation, () => startStandUp(generation));
      return;
    }
    // 聊天在困倦中途开始时，先让当前短段自然完成，再唤醒，不直接跳到帧 7。
    if (sleepEligible && !restSuspended) {
      startSleepLoop(generation);
    } else {
      startWake(generation);
    }
  }, generation, null, true);
}

function startSleepLoop(generation) {
  if (!sleep || !restActive || generation !== displayGeneration) {
    return;
  }
  stopAnimation();
  restPhase = "sleep";
  playingSleep = true;
  frameIndex = 0;
  playFrames(sleep, true, "rest-sleep-boundary", () => {}, generation, null, true);
}

/* 唤醒只复用 drowsy 7/6/0 静姿，不倒放哈欠手势；从 sleep 或已完成困倦段
   进入，结束后停在真实 sit 末帧。时长是候选节奏，须实际播放审查。 */
function startWake(generation, afterWake = null) {
  if (!drowsy || !restActive || generation !== displayGeneration) {
    return;
  }
  stopAnimation();
  const current = sprite.src;
  let indices = [7, 6, 0];
  if (sleep && sleep.frames.includes(current)) {
    indices = [7, 6, 0];
  } else {
    const index = drowsy.frames.indexOf(current);
    if (index === 7) indices = [6, 0];
    else if (index === 6) indices = [0];
    else if (index === 0) indices = [];
  }
  if (indices.length === 0) {
    restPhase = "seated";
    settleSitFrame(generation);
    if (afterWake) {
      afterWake();
    }
    return;
  }
  restPhase = "waking";
  const wakeDurations = [220, 240, 300].slice(0, indices.length);
  frameIndex = 0;
  playFrames({
    frames: indices.map((index) => drowsy.frames[index]),
    durations: wakeDurations,
  }, false, "rest-sleep-boundary", () => {
    if (generation !== displayGeneration || !restActive) {
      return;
    }
    restPhase = "seated";
    settleSitFrame(generation);
    if (afterWake) {
      afterWake();
      return;
    }
    if (sleepEligible && !restSuspended) {
      startDrowsy(generation);
    }
  }, generation, null, true);
}

function applyRestSleepState(generation) {
  if (!assetReady || !restActive || generation !== displayGeneration) {
    return;
  }
  if (restSuspended) {
    suspendRest(generation);
    return;
  }
  if (sleepEligible) {
    if (!restSitting && restPhase === "seated") {
      startDrowsy(generation);
    }
    return;
  }
  // 困倦中不打断当前短段；其 onEnd 会按最新 sleepEligible 唤醒。
  if (restPhase === "drowsy") {
    return;
  }
  if (restPhase === "sleep") {
    startWake(generation);
  }
}

/* 用主进程的休息意图而不是瞬时 mode：聊天期间保持坐姿清醒，手动换人或唤醒后
   才回待机，避免退出互动时循环重新坐下。 */
function syncRest(state) {
  if (!assetReady) {
    return;
  }
  const generation = displayGeneration;
  sleepEligible = state?.sleepEligible === true;
  restSuspended = state?.restSuspended === true;
  if (state?.resting === true) {
    const token = Number.isInteger(state.restToken) ? state.restToken : 0;
    if (!restActive || (token > 0 && token !== activeRestToken)) {
      startRest(generation, token);
    }
    applyRestSleepState(generation);
    return;
  }
  sleepEligible = false;
  restSuspended = false;
  if (!restActive || restExiting) {
    return;
  }
  // 继续陪伴/同角色离休：睡眠中先走 7/6/0 回 sit 末帧，再复用现有逆坐起身；
  // 不在睡眠帧上直接跳 idle。切换其他角色时本 renderer 会被新代次作废。
  if (playingDaily) {
    restActive = false;
    restPhase = "seated";
    restSitting = false;
    return;
  }
  restExitPending = true;
  if (restPhase === "drowsy") {
    restExiting = true;
    return;
  }
  restExiting = true;
  if (restPhase === "sleep" || restPhase === "waking") {
    startWake(generation, () => startStandUp(generation));
    return;
  }
  restExitPending = false;
  stopAnimation();
  startStandUp(generation);
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
    // 系统锁屏/休眠不截断已经开始的真实日常动作；完成事实仍需记录。
    // 隐藏/画布不可用仍按原逻辑停住画面。
    if (playingDaily && state?.systemPaused === true) {
      return;
    }
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

function playFrames(animation, loop, nodeName, onEnd, generation, dailyRun = null, trace = false) {
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
  // 日常动作和休息逐帧上报实际文件与闭包身份；待机仍按圈上报。
  if (desktopApi && (dailyRun || trace)) {
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
      if (nodeName) {
        sendNode(nodeName, generation);
      }
      if (loop) {
        frameIndex = 0;
        playFrames(animation, true, nodeName, onEnd, generation);
      } else {
        onEnd();
      }
      return;
    }
    playFrames(animation, loop, nodeName, onEnd, generation, dailyRun, trace);
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
  restActive = false;
  activeRestToken = 0;
  restPhase = "seated";
  restSitting = false;
  restExiting = false;
  restExitPending = false;
  sleepEligible = false;
  restSuspended = false;
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

  const key = `${state.character.id}:${state.animations.idle.frames.join("|")}:${state.animations.wave?.frames.join("|") ?? ""}:${state.animations.stretch?.frames.join("|") ?? ""}:${state.animations.sit?.frames.join("|") ?? ""}:${state.animations.drowsy?.frames.join("|") ?? ""}:${state.animations.sleep?.frames.join("|") ?? ""}`;
  if (key === currentKey) {
    const nextDisplayKey = state.displayKey || displayKey;
    if (assetReady && !sprite.hidden && nextDisplayKey === displayKey) {
      displayKey = nextDisplayKey;
      applyDisplayPlan(state.animations.display);
      syncActivity(state);
      syncRest(state);
      return;
    }
    // 缓存身份仍是 A，但 A 的画面已被后续加载隐藏：重新激活 A 并作废该加载。
    const generation = invalidateDisplay(nextDisplayKey);
    currentKey = key;
    idle = state.animations.idle;
    wave = state.animations.wave ?? null;
    stretch = state.animations.stretch ?? null;
    sit = state.animations.sit ?? null;
    drowsy = state.animations.drowsy ?? null;
    sleep = state.animations.sleep ?? null;
    applyDisplayPlan(state.animations.display);
    sprite.alt = `${characterName}（桌面角色）`;
    startIdle(generation);
    syncActivity(state);
    syncRest(state);
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
    ...(state.animations.sit?.frames ?? []),
    ...(state.animations.drowsy?.frames ?? []),
    ...(state.animations.sleep?.frames ?? []),
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
  sit = state.animations.sit ?? null;
  drowsy = state.animations.drowsy ?? null;
  sleep = state.animations.sleep ?? null;
  applyDisplayPlan(state.animations.display);
  sprite.alt = `${characterName}（桌面角色）`;
  startIdle(generation);
  syncActivity(state);
  syncRest(state);
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
