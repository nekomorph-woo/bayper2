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

function publicAnimation(animation) {
  return animation.public;
}

const animationCache = new Map();

function getAnimations(characterId) {
  if (!animationCache.has(characterId)) {
    if (characterId === "rin") {
      const idle = loadAnimation("rin", "idle-pixel-v2");
      const wave = loadAnimation("rin", "wave-pixel-v1");
      animationCache.set(characterId, {
        idle: publicAnimation(idle),
        wave: { ...publicAnimation(wave), candidate: true },
        display: buildDisplayPlan([idle, wave], idle.public.frameSize),
      });
    } else if (characterId === "hu") {
      const idle = loadAnimation("hu", "idle-v1");
      animationCache.set(characterId, {
        idle: publicAnimation(idle),
        display: buildDisplayPlan([idle], idle.public.frameSize),
      });
    } else {
      return null;
    }
  }
  return animationCache.get(characterId);
}

function getRinAnimations() {
  return getAnimations("rin");
}

function getHuAnimations() {
  return getAnimations("hu");
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
          ? "凛 idle-pixel-v2；wave-pixel-v1 为明确招呼候选"
          : "琥珀旧版 idle-v1 待机（新画风未完成）",
      assetLabel: characterId === "rin" ? "idle-pixel-v2" : "idle-v1",
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

module.exports = {
  buildDesktopPresentation,
  getRinAnimations,
  getHuAnimations,
  BODY_TARGET_PT,
};
