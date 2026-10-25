/* S01 业务入口：模型配置、愿望推荐、角色接纳与无密钥快照。
   角色推荐只做本地排序，不调用模型，也不把愿望写成长期偏好。 */
const { AppError } = require("./errors.cjs");
const { validateModelInput, checkModelConnection } = require("./model.cjs");

const MAX_WISH_LENGTH = 200;

function todayString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function publicCharacter(character) {
  return {
    id: character.id,
    name: character.name,
    tagline: character.tagline,
    intro: character.intro,
    traits: character.traits,
    image: character.image,
    imageState: character.imageState,
    recipeRef: character.recipeRef,
  };
}

/* 排序规则：愿望中命中的角色特征词越多越靠前；同分保持内容目录顺序。
   空愿望或没有命中时使用默认顺序。 */
function recommendCharacters(wish, candidates) {
  const text = typeof wish === "string" ? wish.trim().slice(0, MAX_WISH_LENGTH) : "";
  const ranked = candidates.map((character, index) => {
    const matched = text
      ? (character.matchKeywords ?? []).filter((keyword) => text.includes(keyword))
      : [];
    return { character, index, score: matched.length, matched };
  });

  ranked.sort((a, b) => b.score - a.score || a.index - b.index);

  const result = ranked.map(({ character, matched }, position) => ({
    ...publicCharacter(character),
    reason: buildReason(character, matched, text, position),
  }));

  return {
    recommendedId: result[0]?.id ?? null,
    candidates: result,
  };
}

function buildReason(character, matched, wishText, position) {
  if (matched.length > 0) {
    return `你提到「${matched[0]}」，${character.matchReason}`;
  }
  if (!wishText) {
    return position === 0
      ? `你还没有特别想法，先从默认顺序的第一位看起。${character.matchReason}`
      : character.matchReason;
  }
  if (position === 0) {
    return `愿望里没有和现有角色特征直接对应的词，先按默认顺序推荐。${character.matchReason}`;
  }
  return character.matchReason;
}

function buildSnapshot(store, candidates) {
  const model = store.getModelConfig();
  const relationship = store.getRelationship();
  const byId = new Map(candidates.map((character) => [character.id, character]));

  const snapshot = {
    state: !model ? "unconfigured" : relationship ? "accepted" : "configured",
    model: model
      ? { configured: true, baseUrl: model.baseUrl, modelName: model.modelName }
      : { configured: false },
    relationship: null,
    currentCharacter: null,
  };

  if (!relationship) {
    return snapshot;
  }

  const fallbackId = relationship.characterId;
  const currentId = store.getAppState("current_character_id") ?? fallbackId;
  const fixedId = store.getAppState("fixed_character_id") ?? fallbackId;
  const roster = store.getTodayRoster(todayString());
  const currentCharacter = byId.get(currentId) ?? byId.get(fallbackId) ?? null;

  snapshot.relationship = {
    characterId: relationship.characterId,
    acceptedAt: relationship.acceptedAt,
    stats: relationship.stats,
    currentCharacterId: currentId,
    fixedCharacterId: fixedId,
    todayRoster: roster.length > 0 ? roster : [{ slot: "fixed", characterId: fixedId }],
  };
  snapshot.currentCharacter = currentCharacter ? publicCharacter(currentCharacter) : null;

  return snapshot;
}

function createOnboardingService({ store, safeStorage, candidates }) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("角色内容为空，无法启动首次相遇。");
  }

  function getSnapshot() {
    return buildSnapshot(store, candidates);
  }

  async function validateAndSaveModel(input) {
    const { baseUrl, modelName, apiKey } = validateModelInput(input);

    // 先在发送 Key 之前确认能安全保存；不可用时明确报错，不静默降级为明文。
    let storageAvailable = false;
    try {
      storageAvailable = await safeStorage.isAsyncEncryptionAvailable();
    } catch {
      storageAvailable = false;
    }
    if (!storageAvailable) {
      throw new AppError(
        "SAFE_STORAGE_UNAVAILABLE",
        "系统安全存储不可用，无法保存 API Key，本次未完成配置。",
      );
    }

    await checkModelConnection({ baseUrl, modelName, apiKey });

    let keyCipher;
    try {
      keyCipher = await safeStorage.encryptStringAsync(apiKey);
    } catch {
      throw new AppError(
        "SAFE_STORAGE_UNAVAILABLE",
        "系统安全存储不可用，无法保存 API Key，本次未完成配置。",
      );
    }

    store.saveModelConfig({
      baseUrl,
      modelName,
      keyCipher,
      updatedAt: new Date().toISOString(),
    });

    return getSnapshot();
  }

  function recommend(wish) {
    return recommendCharacters(wish, candidates);
  }

  /* 从系统安全存储解密已保存的 Key，再次执行同一条固定连通检查。
     返回值与快照都不包含 Key；解密失败时要求重新配置。 */
  async function checkStoredModel() {
    const model = store.getModelConfig();
    if (!model) {
      throw new AppError("NOT_CONFIGURED", "请先完成模型配置。");
    }

    let apiKey;
    try {
      const cipher = Buffer.isBuffer(model.keyCipher)
        ? model.keyCipher
        : Buffer.from(model.keyCipher);
      const decrypted = await safeStorage.decryptStringAsync(cipher);
      apiKey = typeof decrypted === "string" ? decrypted : decrypted?.result;
    } catch {
      apiKey = null;
    }
    if (typeof apiKey !== "string" || !apiKey) {
      throw new AppError(
        "SAFE_STORAGE_UNAVAILABLE",
        "无法从系统安全存储读取 API Key，请重新配置模型。",
      );
    }

    await checkModelConnection({
      baseUrl: model.baseUrl,
      modelName: model.modelName,
      apiKey,
    });
    return { checkedAt: new Date().toISOString() };
  }

  function accept(characterId) {
    if (typeof characterId !== "string") {
      throw new AppError("INVALID_CHARACTER", "没有找到要接纳的角色，请重新选择。");
    }
    const character = candidates.find((item) => item.id === characterId);
    if (!character) {
      throw new AppError("INVALID_CHARACTER", "这个角色不在当前版本中，请重新选择。");
    }
    if (!store.getModelConfig()) {
      throw new AppError("NOT_CONFIGURED", "请先完成模型配置，再接纳角色。");
    }

    const now = new Date();
    const result = store.acceptCharacter({
      characterId: character.id,
      day: todayString(now),
      acceptedAt: now.toISOString(),
    });

    return {
      alreadyAccepted: !result.created,
      acceptedCharacterId: result.characterId,
      snapshot: getSnapshot(),
    };
  }

  return { getSnapshot, validateAndSaveModel, recommend, accept, checkStoredModel };
}

module.exports = {
  MAX_WISH_LENGTH,
  todayString,
  publicCharacter,
  recommendCharacters,
  buildSnapshot,
  createOnboardingService,
};
