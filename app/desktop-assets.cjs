/* 桌面画布可用的正式角色表现数据。只读取已导出并通过播放测试的素材；
   未接入或未验证角色返回明确 pending，不借用其他角色图片。 */
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const CHARACTER_ROOT = path.resolve(__dirname, "..", "assets", "characters");

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
  return {
    frames,
    durations: manifest.frame_durations_ms,
    frameSize: manifest.atlas.frame_size,
    loop: manifest.loop === true,
  };
}

const animationCache = new Map();

function getAnimations(characterId) {
  if (!animationCache.has(characterId)) {
    if (characterId === "rin") {
      animationCache.set(characterId, {
        idle: loadAnimation("rin", "idle-v3"),
        wave: { ...loadAnimation("rin", "wave-v2"), candidate: true },
      });
    } else if (characterId === "hu") {
      animationCache.set(characterId, {
        idle: loadAnimation("hu", "idle-v1"),
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
          ? "凛 idle-v3；wave-v2 为明确招呼候选"
          : "琥珀 idle-v1 待机",
      assetLabel: characterId === "rin" ? "idle-v3" : "idle-v1",
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

module.exports = { buildDesktopPresentation, getRinAnimations, getHuAnimations };
