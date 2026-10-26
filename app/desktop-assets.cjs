/* 桌面画布可用的正式角色表现数据。只读取已导出并通过播放测试的素材；
   未接入或未验证角色返回明确 pending，不借用其他角色图片。 */
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const CHARACTER_ROOT = path.resolve(__dirname, "..", "assets", "characters");
const BODY_TARGET_PT = 128;

function loadAnimation(characterId, name) {
  const directory = path.join(CHARACTER_ROOT, characterId, "animations", name);
  const manifestPath = path.join(directory, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const frames = manifest.frames.map((frame) => {
    const filePath = path.join(directory, frame.file);
    if (!fs.existsSync(filePath)) {
      throw new Error(`${characterId}/${name} 缺少帧文件：${frame.file}`);
    }
    return pathToFileURL(filePath).href;
  });

  const boxes = manifest.frames.map((frame) => ({
    x: frame.paste.x,
    y: frame.paste.y,
    right: frame.paste.x + frame.scaled_size.width,
    bottom: frame.paste.y + frame.scaled_size.height,
  }));
  const footAnchors = manifest.frames.map((frame) => frame.output_foot_anchor);

  return {
    public: {
      frames,
      durations: manifest.frame_durations_ms,
      frameSize: manifest.atlas.frame_size,
      loop: manifest.loop === true,
    },
    box: {
      x: Math.min(...boxes.map((box) => box.x)),
      y: Math.min(...boxes.map((box) => box.y)),
      right: Math.max(...boxes.map((box) => box.right)),
      bottom: Math.max(...boxes.map((box) => box.bottom)),
    },
    footAnchor: footAnchors[0],
  };
}

/* 同角色所有已接入动作共用同一个可见包围和旋转原点；窗口按该范围裁切，
   图片按同一线性尺度渲染，不用逐动作 fit 或运行时读取 PNG。 */
function buildDisplayPlan(animations, frameSize) {
  const boxes = animations.map((animation) => animation.box);
  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  const maxX = Math.max(...boxes.map((box) => box.right));
  const maxY = Math.max(...boxes.map((box) => box.bottom));
  const width = maxX - minX;
  const height = maxY - minY;
  const scale = BODY_TARGET_PT / Math.max(width, height);
  const footAnchor = animations[0].footAnchor;
  const footStable = animations.every(
    (animation) =>
      animation.footAnchor.x === footAnchor.x && animation.footAnchor.y === footAnchor.y,
  );
  if (!footStable) {
    throw new Error("已接入动作的落脚点不一致");
  }

  return {
    scale,
    targetPt: BODY_TARGET_PT,
    windowWidth: Math.ceil(width * scale - 1e-6),
    windowHeight: Math.ceil(height * scale - 1e-6),
    canvasWidth: frameSize.width * scale,
    canvasHeight: frameSize.height * scale,
    offsetX: minX * scale,
    offsetY: minY * scale,
    visibleBox: { x: minX, y: minY, width, height },
    footAnchor: {
      x: footAnchor.x * scale - minX * scale,
      y: footAnchor.y * scale - minY * scale,
    },
  };
}

/* 同角色三项基础动作使用同一 320×384 画布和脚锚；凛保持已验收的
   256×384 版本。candidate 只表示待 Codex 视觉验收，不是正式发布。 */
const ANIMATION_SETS = Object.freeze({
  rin: {
    idle: "idle-pixel-v2",
    wave: "wave-pixel-v1",
    stretch: "stretch-pixel-v2-canvas256",
    candidate: false,
  },
  hu: {
    idle: "idle-pixel-v2-canvas320",
    wave: "wave-pixel-v3",
    stretch: "stretch-pixel-v2-canvas320",
    candidate: true,
  },
  cheng: {
    idle: "idle-pixel-v2-canvas320",
    wave: "wave-pixel-v1-canvas320",
    stretch: "stretch-pixel-v2-canvas320",
    candidate: true,
  },
});

function publicAnimation(animation, candidate) {
  return { ...animation.public, candidate };
}

const animationCache = new Map();

function getAnimations(characterId) {
  if (!animationCache.has(characterId)) {
    const names = ANIMATION_SETS[characterId];
    if (!names) {
      return null;
    }
    const idle = loadAnimation(characterId, names.idle);
    const wave = loadAnimation(characterId, names.wave);
    const stretch = loadAnimation(characterId, names.stretch);
    animationCache.set(characterId, {
      idle: publicAnimation(idle, names.candidate),
      wave: publicAnimation(wave, names.candidate),
      stretch: publicAnimation(stretch, names.candidate),
      display: buildDisplayPlan([idle, wave, stretch], idle.public.frameSize),
    });
  }
  return animationCache.get(characterId);
}

function getRinAnimations() {
  return getAnimations("rin");
}

function getHuAnimations() {
  return getAnimations("hu");
}

function getChengAnimations() {
  return getAnimations("cheng");
}

/* 主进程只把角色 ID、显示名和已验证动画路径发给子进程。 */
function buildDesktopPresentation(characterId, displayName) {
  if (!characterId) {
    return {
      character: null,
      animations: null,
      assetState: "none",
      assetNote: "暂无同屏角色",
      assetLabel: "未启动",
    };
  }

  try {
    const animations = getAnimations(characterId);
    if (!animations) {
      return {
        character: { id: characterId, displayName },
        animations: null,
        assetState: "pending",
        assetNote: "该角色的正式桌面素材尚未接入或验证",
        assetLabel: "素材未接入",
      };
    }
    return {
      character: { id: characterId, displayName },
      animations,
      assetState: "ready",
      assetNote:
        characterId === "rin"
          ? "凛 idle-pixel-v2；wave-pixel-v1 与 stretch-pixel-v2-canvas256 已通过播放验收"
          : `${displayName} idle/wave/stretch 基础动作候选已接入，尚未完成视觉发布`,
      assetLabel:
        characterId === "rin"
          ? "idle-pixel-v2"
          : "idle/wave/stretch 候选",
    };
  } catch (error) {
    return {
      character: { id: characterId, displayName },
      animations: null,
      assetState: "error",
      assetNote: "角色桌面素材加载失败",
      assetLabel: "加载失败",
      error: error.message,
    };
  }
}

/* 已发布活动动作的能力边界。Hu/Cheng 只接入三项基础候选，待 Codex
   视觉验收；不得据此推导完整动作库或正式内容发布。 */
const DAILY_ACTIONS = Object.freeze({
  rin: {
    candidate: "stretch-pixel-v2-canvas256",
    note: "凛 stretch-pixel-v2-canvas256 正式日常伸展已通过播放验收。",
  },
  hu: {
    candidate: "stretch-pixel-v2-canvas320",
    note: "琥珀伸展基础动作候选已接入，仍待跨动作视觉验收；不代表动作库完成。",
  },
  cheng: {
    candidate: "stretch-pixel-v2-canvas320",
    note: "澄伸展基础动作候选已接入，仍待跨动作视觉验收；不代表动作库完成。",
  },
});

const ACTIVITY_SUPPORT = Object.freeze({
  exploration: {
    available: true,
    degraded: true,
    reason: "DEPARTURE_ANIMATION_MISSING",
    note: "探索出发/返回动作素材未发布，当前直接切换同屏并保留进度。",
  },
});

function getActivitySupport(characterId, kind) {
  if (kind === "daily") {
    const action = DAILY_ACTIONS[characterId];
    if (!action) {
      return {
        available: false,
        reason: "ACTIVITY_ACTION_UNAVAILABLE",
        note: "该角色没有已接入的正式日常动作；不借用其他角色的素材。",
      };
    }
    return {
      available: true,
      candidate: action.candidate,
      note: action.note,
    };
  }
  const support = ACTIVITY_SUPPORT[kind];
  if (!support) {
    return { available: false, reason: "INVALID_ACTIVITY_KIND", note: "未知活动类型。" };
  }
  return { ...support };
}

module.exports = {
  buildDesktopPresentation,
  getActivitySupport,
  getRinAnimations,
  getHuAnimations,
  getChengAnimations,
  BODY_TARGET_PT,
};
