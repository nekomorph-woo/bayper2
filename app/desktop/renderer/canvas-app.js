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
let animationTimer = null;
let frameIndex = 0;
let playingWave = false;
let assetReady = false;
let loadToken = 0;
let announcedGeneration = -1;
let drag = null;

function stopAnimation() {
  if (animationTimer) {
    clearTimeout(animationTimer);
    animationTimer = null;
  }
  playingWave = false;
}

function showStatus(name, note) {
  statusName.textContent = name || "角色";
  statusNote.textContent = note || "";
  statusCard.hidden = false;
  sprite.hidden = true;
  announcedGeneration = -1;
  if (desktopApi) {
    desktopApi.displayState("status", displayKey, displayGeneration, "");
  }
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
  if (desktopApi) {
    desktopApi.nodeComplete(node, displayKey, generation);
  }
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
  if (announcedGeneration !== generation && desktopApi) {
    desktopApi.displayState("character", displayKey, generation, sprite.src);
    announcedGeneration = generation;
  }
}

function startWave() {
  if (!assetReady || !wave || playingWave) {
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

function playFrames(animation, loop, nodeName, onEnd, generation) {
  if (generation !== displayGeneration) {
    return;
  }
  const frames = animation.frames;
  const durations = animation.durations;
  if (!frames.length) {
    return;
  }

  sprite.src = frames[frameIndex];
  animationTimer = setTimeout(() => {
    if (generation !== displayGeneration) {
      return;
    }
    frameIndex += 1;
    if (frameIndex >= frames.length) {
      sendNode(nodeName, generation);
      if (loop) {
        frameIndex = 0;
        playFrames(animation, true, nodeName, onEnd, generation);
      } else {
        onEnd();
      }
      return;
    }
    playFrames(animation, loop, nodeName, onEnd, generation);
  }, Math.max(16, durations[frameIndex] ?? 180));
}

function invalidateDisplay(nextKey) {
  displayGeneration += 1;
  displayKey = nextKey || "";
  loadToken += 1;
  loadingKey = "";
  stopAnimation();
  assetReady = false;
  sprite.hidden = true;
  return displayGeneration;
}

async function applyState(state) {
  if (!state || !state.character) {
    invalidateDisplay("");
    currentKey = "";
    failedKey = "";
    showStatus("暂无同屏角色", "小窝会继续保留当前数据。");
    return;
  }

  const characterName = state.character.displayName || "角色";
  if (state.assetState !== "ready" || !state.animations) {
    invalidateDisplay(state.displayKey || `${state.character.id}:${state.assetState}`);
    currentKey = "";
    failedKey = "";
    showStatus(characterName, state.assetNote || "该角色的正式桌面素材尚未完成");
    return;
  }

  const key = `${state.character.id}:${state.animations.idle.frames.join("|")}:${state.animations.wave?.frames.join("|") ?? ""}`;
  if (key === currentKey) {
    const nextDisplayKey = state.displayKey || displayKey;
    if (assetReady && !sprite.hidden && nextDisplayKey === displayKey) {
      displayKey = nextDisplayKey;
      return;
    }
    // 缓存身份仍是 A，但 A 的画面已被后续加载隐藏：重新激活 A 并作废该加载。
    const generation = invalidateDisplay(nextDisplayKey);
    currentKey = key;
    idle = state.animations.idle;
    wave = state.animations.wave ?? null;
    sprite.alt = `${characterName}（桌面角色）`;
    startIdle(generation);
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
  sprite.alt = `${characterName}（桌面角色）`;
  startIdle(generation);
}

function beginDrag(event) {
  if (!event.isPrimary || event.button !== 0) {
    return;
  }
  drag = {
    pointerId: event.pointerId,
    startX: event.screenX,
    startY: event.screenY,
    moved: false,
  };
  stage.classList.add("dragging");
  if (desktopApi) {
    desktopApi.dragStart(event.screenX, event.screenY);
  }
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
    desktopApi.dragMove(event.screenX, event.screenY);
  }
}

function endDrag(event) {
  if (!drag || event.pointerId !== drag.pointerId) {
    return;
  }
  const wasClick = !drag.moved;
  drag = null;
  stage.classList.remove("dragging");
  if (desktopApi) {
    desktopApi.dragEnd();
  }
  if (stage.hasPointerCapture(event.pointerId)) {
    stage.releasePointerCapture(event.pointerId);
  }
  if (wasClick) {
    startWave();
  }
}

stage.addEventListener("pointerdown", beginDrag);
stage.addEventListener("pointermove", moveDrag);
stage.addEventListener("pointerup", endDrag);
stage.addEventListener("pointercancel", endDrag);
stage.addEventListener("contextmenu", (event) => event.preventDefault());

if (desktopApi) {
  desktopApi.onState(applyState);
}
