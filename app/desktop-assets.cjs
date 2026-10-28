/* 桌面画布可用的正式角色表现数据。只读取已导出并通过播放测试的素材；
   未接入或未验证角色返回明确 pending，不借用其他角色图片。
   S06l 增加显式衣装映射：基础与衣装共用同一加载/拼接/显示计划，
   按角色+衣装缓存；同 root 缓存命中后仍核验真实帧文件存在。 */
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL, fileURLToPath } = require("node:url");

const CHARACTER_ROOT = path.resolve(__dirname, "..", "assets", "characters");
const BODY_TARGET_PT = 128;
const BASE_OUTFIT_ID = "base";

/* 衣装目录只能由主进程按稳定 ID 选择；renderer 不传文件路径。
   温茶只有候选三动作；其余动作尚未制作，不能拿基础衣装补缺。 */
const OUTFIT_SETS = Object.freeze({
  "rin.warm-tea": Object.freeze({
    characterId: "rin",
    folder: "warm-tea",
    label: "rin.warm-tea 候选",
    note:
      "凛温茶围裙候选：仅接入 idle/wave/stretch 三动作；sit/drowsy/sleep/happy 尚未制作，"
      + "不借用基础衣装，也未发布为正式衣装。",
    animations: Object.freeze({
      idle: "idle-pixel-v2",
      wave: "wave-pixel-v1",
      stretch: "stretch-pixel-v2-canvas320",
    }),
  }),
});

function animationDirectory(characterId, name, root, outfit) {
  if (outfit) {
    return path.join(
      root,
      outfit.characterId,
      "outfits",
      outfit.folder,
      "animations",
      name,
    );
  }
  return path.join(root, characterId, "animations", name);
}

function loadAnimation(characterId, name, root = CHARACTER_ROOT, outfit = null) {
  const directory = animationDirectory(characterId, name, root, outfit);
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
  // 旧动作导出 output_foot_anchor；坐姿按显式区域导出 output_ground_anchor。
  // 两者都表示同一地面锚，读取真实定义而不是假定字段名。
  const footAnchors = manifest.frames.map(
    (frame) => frame.output_foot_anchor ?? frame.output_ground_anchor,
  );

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

/* 同角色/同衣装所有已接入动作共用同一个可见包围和旋转原点；窗口按该范围裁切，
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
   256×384 版本，并接入统一画布的坐姿休息。candidate 只表示待 Codex
   视觉验收，不是正式发布。 */
const ANIMATION_SETS = Object.freeze({
  rin: {
    idle: "idle-pixel-v2",
    wave: "wave-pixel-v1",
    stretch: "stretch-pixel-v2-canvas256",
    sit: "sit-pixel-v2-canvas256",
    drowsy: "drowsy-pixel-v2-canvas256",
    sleep: "sleep-pixel-v2-canvas256",
    // 工作结束短反应候选；只属于凛，不借给其他角色。
    happy: "happy-pixel-v4",
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

/* 基础衣装与衣装共用同一加载、动作拼接和显示计划。drowsy/sleep/happy
   从未视觉发布，始终保持 candidate=true；其余动作沿用各自集合语义。 */
function loadAnimationParts(characterId, names, root, outfit) {
  const read = (name) => (name ? loadAnimation(characterId, name, root, outfit) : null);
  const idle = read(names.idle);
  const wave = read(names.wave);
  const stretch = read(names.stretch);
  if (!idle || !wave || !stretch) {
    throw new Error(`${characterId} 缺少基础三动作`);
  }
  const sit = read(names.sit);
  const drowsy = read(names.drowsy);
  const sleep = read(names.sleep);
  const happy = read(names.happy);
  const candidate = outfit ? true : names.candidate;
  const loaded = [idle, wave, stretch, sit, drowsy, sleep, happy].filter(Boolean);
  const animations = {
    idle: publicAnimation(idle, candidate),
    wave: publicAnimation(wave, candidate),
    stretch: publicAnimation(stretch, candidate),
    sit: sit ? publicAnimation(sit, candidate) : null,
    drowsy: drowsy ? publicAnimation(drowsy, true) : null,
    sleep: sleep ? publicAnimation(sleep, true) : null,
    happy: happy ? publicAnimation(happy, true) : null,
  };
  animations.display = buildDisplayPlan(loaded, idle.public.frameSize);
  return animations;
}

const animationCache = new Map();

/* 缓存只省去 manifest/帧解析，不省真实性：同 root 命中后逐帧核验文件仍在。
   缺失时删除该缓存并抛错，让上层显示不可用；文件恢复后下次重新加载。 */
function cachedAnimations(cacheKey, build) {
  const cached = animationCache.get(cacheKey);
  if (cached) {
    for (const animation of Object.values(cached)) {
      if (!animation || typeof animation !== "object" || !Array.isArray(animation.frames)) {
        continue;
      }
      for (const frame of animation.frames) {
        const filePath = fileURLToPath(frame);
        if (!fs.existsSync(filePath)) {
          animationCache.delete(cacheKey);
          throw new Error(`素材帧文件缺失：${filePath}`);
        }
      }
    }
    return cached;
  }
  const built = build();
  animationCache.set(cacheKey, built);
  return built;
}

function getAnimations(characterId, root = CHARACTER_ROOT) {
  const names = ANIMATION_SETS[characterId];
  if (!names) {
    return null;
  }
  const cacheKey = `${root}\u0000${characterId}\u0000${BASE_OUTFIT_ID}`;
  return cachedAnimations(
    cacheKey,
    () => loadAnimationParts(characterId, names, root, null),
  );
}

function getOutfitAnimations(characterId, outfitId, options = {}) {
  const spec = OUTFIT_SETS[outfitId];
  if (!spec || spec.characterId !== characterId) {
    return null;
  }
  const root = options.assetsRoot ?? CHARACTER_ROOT;
  const cacheKey = `${root}\u0000${characterId}\u0000${outfitId}`;
  return cachedAnimations(cacheKey, () => ({
    outfitId,
    candidate: true,
    ...loadAnimationParts(characterId, spec.animations, root, spec),
  }));
}

function getRinAnimations(options = {}) {
  return getAnimations("rin", options.assetsRoot ?? CHARACTER_ROOT);
}

function getHuAnimations(options = {}) {
  return getAnimations("hu", options.assetsRoot ?? CHARACTER_ROOT);
}

function getChengAnimations(options = {}) {
  return getAnimations("cheng", options.assetsRoot ?? CHARACTER_ROOT);
}

function isOutfitAssetAvailable(characterId, outfitId, options = {}) {
  if (!outfitId || outfitId === BASE_OUTFIT_ID) {
    return true;
  }
  try {
    return Boolean(getOutfitAnimations(characterId, outfitId, options));
  } catch {
    return false;
  }
}

/* 主进程只把角色 ID、显示名和已验证动画路径发给子进程。 */
function buildDesktopPresentation(
  characterId,
  displayName,
  outfitId = BASE_OUTFIT_ID,
  options = {},
) {
  if (!characterId) {
    return {
      character: null,
      animations: null,
      assetState: "none",
      assetNote: "暂无同屏角色",
      assetLabel: "未启动",
    };
  }

  const selected = outfitId || BASE_OUTFIT_ID;
  const root = options.assetsRoot ?? CHARACTER_ROOT;
  try {
    let animations;
    let assetNote;
    let assetLabel;
    if (selected === BASE_OUTFIT_ID) {
      animations = getAnimations(characterId, root);
      if (!animations) {
        return {
          character: { id: characterId, displayName },
          animations: null,
          assetState: "pending",
          assetNote: "该角色的正式桌面素材尚未接入或验证",
          assetLabel: "素材未接入",
          outfitId: selected,
        };
      }
      assetNote =
        characterId === "rin"
          ? "凛 idle-pixel-v2；wave/stretch/sit 已通过播放验收；drowsy/sleep 睡眠运行候选待视觉验收；happy 工作结束反应候选待业务验收"
          : `${displayName} idle/wave/stretch 基础动作候选已接入，尚未完成视觉发布`;
      assetLabel = characterId === "rin" ? "idle-pixel-v2" : "idle/wave/stretch 候选";
      return {
        character: { id: characterId, displayName },
        animations,
        assetState: "ready",
        assetNote,
        assetLabel,
        outfitId: selected,
      };
    }

    const spec = OUTFIT_SETS[selected];
    if (!spec || spec.characterId !== characterId) {
      return {
        character: { id: characterId, displayName },
        animations: null,
        assetState: "pending",
        assetNote: "这套衣装不属于该角色或尚未接入",
        assetLabel: "衣装不可用",
        reason: "OUTFIT_UNAVAILABLE",
        outfitId: selected,
      };
    }
    animations = getOutfitAnimations(characterId, selected, { assetsRoot: root });
    return {
      character: { id: characterId, displayName },
      animations,
      assetState: "ready",
      assetNote: spec.note,
      assetLabel: spec.label,
      outfitId: selected,
      outfitCandidate: true,
    };
  } catch (error) {
    return {
      character: { id: characterId, displayName },
      animations: null,
      assetState: "error",
      assetNote: "角色桌面素材加载失败",
      assetLabel: "加载失败",
      error: error.message,
      outfitId: selected,
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

function getActivitySupport(
  characterId,
  kind,
  outfitId = BASE_OUTFIT_ID,
  options = {},
) {
  const selected = outfitId || BASE_OUTFIT_ID;
  if (selected !== BASE_OUTFIT_ID) {
    const spec = OUTFIT_SETS[selected];
    if (!spec || spec.characterId !== characterId) {
      return {
        available: false,
        reason: "OUTFIT_UNAVAILABLE",
        note: "这套衣装不属于该角色或尚未接入。",
      };
    }
    if (kind === "daily") {
      let animations;
      try {
        animations = getOutfitAnimations(characterId, selected, options);
      } catch {
        return {
          available: false,
          reason: "OUTFIT_ASSET_UNAVAILABLE",
          note: "这套衣装的素材当前不可用。",
        };
      }
      if (!animations?.stretch) {
        return {
          available: false,
          reason: "ACTIVITY_ACTION_UNAVAILABLE",
          note: "这套衣装没有已接入的日常动作，不借用基础衣装。",
        };
      }
      return {
        available: true,
        candidate: spec.animations.stretch,
        note: `${spec.note} 当前日常只使用该衣装的伸展动作。`,
      };
    }
  } else if (kind === "daily") {
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
  getOutfitAnimations,
  isOutfitAssetAvailable,
  OUTFIT_SETS,
  BASE_OUTFIT_ID,
  BODY_TARGET_PT,
};
