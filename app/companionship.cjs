/* S02a 陪伴业务入口：每日名单、固定位、昵称、显式同屏、互动生命周期、
   低精力交接与本地时间结算。聊天模型、自动探索和原生 panel 不在本切片。 */
const { AppError } = require("./errors.cjs");

const SLOT_ORDER = ["fixed", "random_1", "random_2", "random_3", "random_4"];
const MAX_RANDOM_SLOTS = 4;
const LOW_ENERGY = 30;
const READY_ENERGY = 60;
const AUTO_EXIT_COOLDOWN_MS = 30 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/* 每小时的精力变化。interacting 在 S02a 中不结算：真实有效互动事件在 S03 接入，
   这里既不伪造互动收益，也不把等待模型的时间算成陪伴消耗。 */
const ENERGY_RATE_PER_HOUR = Object.freeze({
  companion: -6,
  waiting: 10,
  resting: 20,
  offline: 10,
  interacting: 0,
});

function localDay(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function clampEnergy(value) {
  // 保留三位小数：既保留连续变化的精度，也避免毫秒级操作产生无意义的浮点噪声。
  const clamped = Math.min(100, Math.max(0, value));
  return Math.round(clamped * 1000) / 1000;
}

function createCompanionshipService({
  store,
  candidates,
  now = () => new Date(),
  random = Math.random,
}) {
  const contentById = new Map(candidates.map((character) => [character.id, character]));
  let started = false;

  function contentFor(characterId) {
    const content = contentById.get(characterId);
    return {
      characterId,
      name: content?.name ?? characterId,
      tagline: content?.tagline ?? "开发候选角色",
      intro: content?.intro ?? "",
      traits: content?.traits ?? [],
      image: content?.image ?? null,
      imageState: content?.imageState ?? "development-candidate",
      recipeRef: content?.recipeRef ?? null,
    };
  }

  function displayNameOf(companion) {
    return companion.nickname?.trim() || contentFor(companion.characterId).name;
  }

  function setState(key, value) {
    store.setAppState(key, String(value));
  }

  function getState(key) {
    return store.getAppState(key);
  }

  function currentMode() {
    return getState("current_mode") === "resting" ? "resting" : "companion";
  }

  function pendingReason() {
    const raw = getState("pending_rotation");
    if (raw === null || raw === "0") {
      return null;
    }
    return raw === "roster_exit" ? "roster_exit" : "low_energy";
  }

  function clearPending(nowMs) {
    store.runInTransaction(() => {
      setState("pending_rotation", "0");
      touchActive(nowMs);
    });
  }

  /* 候场与返回同屏都使用同一状态门槛：未探索、精力足够、且不处于刚退场冷却。 */
  function isReadyForPresence(companion, nowMs) {
    if (!companion || companion.runtime.exploring) {
      return false;
    }
    if (companion.stats.energy < READY_ENERGY) {
      return false;
    }
    if (companion.runtime.lastAutoExitAt === null) {
      return true;
    }
    return nowMs - companion.runtime.lastAutoExitAt >= AUTO_EXIT_COOLDOWN_MS;
  }

  function touchActive(nowMs) {
    const previous = Number(getState("last_active_at") ?? 0);
    if (nowMs > previous) {
      setState("last_active_at", nowMs);
    }
  }

  function ensureRuntimeRows(nowMs) {
    for (const companion of store.listCompanions()) {
      store.ensureRuntime(companion.characterId, nowMs);
    }
  }

  function initState(nowMs) {
    const companions = store.listCompanions();
    if (companions.length === 0) {
      return;
    }
    const ids = new Set(companions.map((companion) => companion.characterId));

    store.runInTransaction(() => {
      let fixedId = getState("fixed_character_id");
      if (!ids.has(fixedId)) {
        fixedId = companions[0].characterId;
        setState("fixed_character_id", fixedId);
      }

      let currentId = getState("current_character_id");
      if (!ids.has(currentId)) {
        currentId = fixedId;
        setState("current_character_id", currentId);
      }

      if (!["companion", "resting"].includes(getState("current_mode"))) {
        setState("current_mode", "companion");
      }
      if (getState("pending_rotation") === null) {
        setState("pending_rotation", "0");
      }
      ensureRuntimeRows(nowMs);
    });
  }

  function settleAll(nowMs) {
    // 精力与结算锚点必须一起提交，避免存储失败后重复结算。
    store.runInTransaction(() => {
      for (const companion of store.listCompanions()) {
        const runtime = store.getRuntime(companion.characterId);
        if (!runtime || runtime.lastSettledAt === null) {
          store.setLastSettled(companion.characterId, nowMs);
          continue;
        }
        if (nowMs <= runtime.lastSettledAt) {
          continue;
        }
        const hours = (nowMs - runtime.lastSettledAt) / HOUR_MS;
        const rate = ENERGY_RATE_PER_HOUR[runtime.mode] ?? 0;
        const energy = clampEnergy(companion.stats.energy + rate * hours);
        store.applySettlement(companion.characterId, { energy, lastSettledAt: nowMs });
      }
      // 结算锚点与最后活跃时间一起提交，避免失败后按旧心跳重复补算。
      touchActive(nowMs);
    });
  }

  /* 应用关闭后按离线规则补算，再重置各角色模式并更新锚点。
     时钟回拨时不补算，也不把持久化时间改回过去。 */
  function start() {
    const nowDate = now();
    const nowMs = nowDate.getTime();

    if (!started) {
      const lastActive = Number(getState("last_active_at") ?? 0);
      if (lastActive > 0 && nowMs > lastActive) {
        const hours = (nowMs - lastActive) / HOUR_MS;
        store.runInTransaction(() => {
          for (const companion of store.listCompanions()) {
            const energy = clampEnergy(companion.stats.energy + 10 * hours);
            store.applySettlement(companion.characterId, { energy, lastSettledAt: nowMs });
          }
          touchActive(nowMs);
        });
      }

      initState(nowMs);
      if (store.listCompanions().length > 0) {
        ensureDailyRoster(nowDate);
        applyStoredModes(nowMs);
      }
      touchActive(nowMs);
      started = true;
      return;
    }

    // 反复 start 时先把旧模式下的区间结算掉，再切换模式和推进锚点。
    initState(nowMs);
    settleAll(nowMs);
    if (store.listCompanions().length > 0) {
      ensureDailyRoster(nowDate);
      applyStoredModes(nowMs);
    }
    touchActive(nowMs);
  }

  function applyStoredModes(nowMs) {
    const interaction = store.getInteraction();
    const stableId = getState("current_character_id");
    const baseMode = currentMode();

    store.runInTransaction(() => {
      for (const companion of store.listCompanions()) {
        let mode = "waiting";
        if (interaction && companion.characterId === interaction.characterId) {
          mode = "interacting";
        } else if (companion.characterId === stableId) {
          if (interaction) {
            mode = baseMode === "resting" ? "resting" : "waiting";
          } else {
            mode = baseMode;
          }
        }
        store.setMode(companion.characterId, mode);
        const runtime = store.getRuntime(companion.characterId);
        if (runtime?.lastSettledAt === null || nowMs > (runtime?.lastSettledAt ?? 0)) {
          store.setLastSettled(companion.characterId, nowMs);
        }
      }
    });
  }

  function ensureDailyRoster(nowDate) {
    const day = localDay(nowDate);
    const existing = store.getRoster(day);
    if (existing.length > 0) {
      return existing;
    }

    const companions = store.listCompanions();
    if (companions.length === 0) {
      return [];
    }

    const previousRoster = store.getPreviousRoster(day);
    const fixedId = getState("fixed_character_id") ?? companions[0].characterId;
    const entries = [{ slot: "fixed", characterId: fixedId }];
    const remaining = companions.filter((companion) => companion.characterId !== fixedId);

    for (let index = 1; index <= MAX_RANDOM_SLOTS && remaining.length > 0; index += 1) {
      const oldest = Math.min(
        ...remaining.map((companion) => companion.runtime.lastParticipatedAt ?? -Infinity),
      );
      const group = remaining
        .filter((companion) => (companion.runtime.lastParticipatedAt ?? -Infinity) === oldest)
        .sort((a, b) => a.characterId.localeCompare(b.characterId));
      const pickIndex =
        group.length === 1 ? 0 : Math.min(group.length - 1, Math.floor(random() * group.length));
      const picked = group[pickIndex];
      entries.push({ slot: `random_${index}`, characterId: picked.characterId });
      remaining.splice(remaining.indexOf(picked), 1);
    }

    const stableId = getState("current_character_id");
    const oldCurrentWasOnRoster = previousRoster.some(
      (entry) => entry.characterId === stableId,
    );
    const oldCurrentStillOnRoster = entries.some((entry) => entry.characterId === stableId);
    const markRosterExit = oldCurrentWasOnRoster && !oldCurrentStillOnRoster;

    const nowMs = nowDate.getTime();
    store.runInTransaction(() => {
      store.replaceRoster(day, entries);
      for (const entry of entries) {
        store.setLastParticipated(entry.characterId, nowMs);
      }
      if (markRosterExit) {
        // 旧同屏角色被跨日名单换出时，即使精力充足也要在自然节点后交接。
        setState("pending_rotation", "roster_exit");
      }
    });
    return store.getRoster(day);
  }

  function prepare(nowDate) {
    const nowMs = nowDate.getTime();
    initState(nowMs);
    settleAll(nowMs);
    const roster = ensureDailyRoster(nowDate);
    touchActive(nowMs);
    return { day: localDay(nowDate), nowMs, roster };
  }

  function rosterIds(roster) {
    return new Set(roster.map((entry) => entry.characterId));
  }

  function snapshotFrom(day, roster, nowMs) {
    const companions = store.listCompanions();
    const interaction = store.getInteraction();
    const stableId = getState("current_character_id");
    const displayId = interaction ? interaction.characterId : stableId;
    const mode = interaction ? "interacting" : currentMode();
    const idsInRoster = rosterIds(roster);
    const display = companions.find((companion) => companion.characterId === displayId) ?? null;

    const rosterPublic = roster.map((entry) => {
      const companion = companions.find((item) => item.characterId === entry.characterId);
      return {
        slot: entry.slot,
        characterId: entry.characterId,
        displayName: companion ? displayNameOf(companion) : entry.characterId,
        nickname: companion?.nickname ?? null,
        energy: companion?.stats.energy ?? null,
        exploring: companion?.runtime.exploring ?? false,
        isCurrent: entry.characterId === displayId,
        isFixed: entry.slot === "fixed",
      };
    });

    const characters = companions.map((companion) => ({
      ...contentFor(companion.characterId),
      nickname: companion.nickname,
      displayName: displayNameOf(companion),
      stats: { ...companion.stats },
      mode: companion.runtime.mode,
      exploring: companion.runtime.exploring,
      inRoster: idsInRoster.has(companion.characterId),
      isCurrent: companion.characterId === displayId,
      isFixed: companion.characterId === getState("fixed_character_id"),
    }));

    let current = null;
    if (display) {
      const source = interaction
        ? interaction.temporary
          ? "temporary-interaction"
          : "interaction"
        : mode === "resting"
          ? "resting"
          : idsInRoster.has(display.characterId)
            ? "roster"
            : "visiting";
      current = {
        ...contentFor(display.characterId),
        nickname: display.nickname,
        displayName: displayNameOf(display),
        stats: { ...display.stats },
        mode,
        source,
        inRoster: idsInRoster.has(display.characterId),
        temporary: Boolean(interaction?.temporary),
        exploring: display.runtime.exploring,
      };
    }

    return {
      day,
      fixedCharacterId: getState("fixed_character_id"),
      current,
      interaction: interaction
        ? {
            characterId: interaction.characterId,
            returnCharacterId: interaction.returnCharacterId,
            temporary: interaction.temporary,
            startedAt: interaction.startedAt,
          }
        : null,
      roster: rosterPublic,
      characters,
      pendingRotation: pendingReason() !== null,
      pendingRotationReason: pendingReason(),
      settledAt: nowMs,
    };
  }

  function getSnapshot() {
    ensureStarted();
    const nowDate = now();
    const { day, roster, nowMs } = prepare(nowDate);
    return snapshotFrom(day, roster, nowMs);
  }

  function ensureStarted() {
    if (!started) {
      start();
    }
  }

  function setNickname(characterId, nickname) {
    ensureStarted();
    if (typeof characterId !== "string" || !store.getCompanion(characterId)) {
      throw new AppError("INVALID_CHARACTER", "这个角色不在已结识名单中。");
    }
    const text = typeof nickname === "string" ? nickname.trim() : "";
    if (text.length > 20 || /[\u0000-\u001f\u007f]/.test(text)) {
      throw new AppError("INVALID_NICKNAME", "昵称不能超过 20 个字符，且不能包含换行或控制字符。");
    }
    const nowMs = now().getTime();
    initState(nowMs);
    settleAll(nowMs);
    store.runInTransaction(() => {
      store.setNickname(characterId, text || null);
      touchActive(nowMs);
    });
    const companion = store.getCompanion(characterId);
    return { characterId, nickname: companion.nickname, displayName: displayNameOf(companion) };
  }

  function setFixed(characterId) {
    ensureStarted();
    if (typeof characterId !== "string" || !store.getCompanion(characterId)) {
      throw new AppError("INVALID_CHARACTER", "这个角色不在已结识名单中。");
    }
    const nowDate = now();
    const { day, roster } = prepare(nowDate);
    const oldFixedId = getState("fixed_character_id");
    if (oldFixedId === characterId) {
      return { fixedCharacterId: characterId, changed: false, roster };
    }

    const entries = roster.map((entry) => ({ ...entry }));
    const fixedEntry = entries.find((entry) => entry.slot === "fixed");
    const newEntry = entries.find((entry) => entry.characterId === characterId);
    const oldFixedIdInRoster = fixedEntry?.characterId ?? oldFixedId;

    if (newEntry) {
      if (oldFixedIdInRoster) {
        newEntry.characterId = oldFixedIdInRoster;
      } else {
        entries.splice(entries.indexOf(newEntry), 1);
      }
      if (fixedEntry) {
        fixedEntry.characterId = characterId;
      } else {
        entries.unshift({ slot: "fixed", characterId });
      }
    } else {
      if (fixedEntry) {
        fixedEntry.characterId = characterId;
      } else {
        entries.unshift({ slot: "fixed", characterId });
      }
      if (oldFixedIdInRoster) {
        const usedSlots = new Set(entries.map((entry) => entry.slot));
        const emptySlot = SLOT_ORDER.slice(1).find((slot) => !usedSlots.has(slot));
        if (emptySlot) {
          entries.push({ slot: emptySlot, characterId: oldFixedIdInRoster });
        }
      }
    }

    entries.sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot));
    store.runInTransaction(() => {
      store.replaceRoster(day, entries);
      setState("fixed_character_id", characterId);
    });
    return { fixedCharacterId: characterId, changed: true, roster: store.getRoster(day) };
  }

  function switchTo(characterId) {
    ensureStarted();
    if (typeof characterId !== "string" || !store.getCompanion(characterId)) {
      throw new AppError("INVALID_CHARACTER", "这个角色不在已结识名单中。");
    }
    const nowDate = now();
    const { day, nowMs } = prepare(nowDate);
    const interaction = store.getInteraction();
    const previousId = getState("current_character_id");

    store.runInTransaction(() => {
      if (interaction) {
        store.setMode(interaction.characterId, "waiting");
        store.clearInteraction();
      }
      if (previousId && previousId !== characterId) {
        store.setMode(previousId, "waiting");
      }
      store.setMode(characterId, "companion");
      setState("current_character_id", characterId);
      setState("current_mode", "companion");
      setState("pending_rotation", "0");
      touchActive(nowMs);
    });
    return {
      currentCharacterId: characterId,
      roster: store.getRoster(day),
      pendingRotation: false,
    };
  }

  function rest() {
    ensureStarted();
    const nowDate = now();
    const { day, nowMs } = prepare(nowDate);
    const interaction = store.getInteraction();
    const currentId = getState("current_character_id");
    store.runInTransaction(() => {
      if (interaction) {
        store.setMode(interaction.characterId, "waiting");
        store.clearInteraction();
      }
      if (currentId) {
        store.setMode(currentId, "resting");
      }
      setState("current_mode", "resting");
      setState("pending_rotation", "0");
      touchActive(nowMs);
    });
    return { currentCharacterId: currentId, mode: "resting", roster: store.getRoster(day) };
  }

  function startInteraction(characterId) {
    ensureStarted();
    if (typeof characterId !== "string" || !store.getCompanion(characterId)) {
      throw new AppError("INVALID_CHARACTER", "这个角色不在已结识名单中。");
    }
    if (store.getInteraction()) {
      throw new AppError("INTERACTION_ACTIVE", "已有一段互动正在进行。");
    }
    const nowDate = now();
    const { nowMs, roster } = prepare(nowDate);
    const stableId = getState("current_character_id");
    const temporary = !roster.some((entry) => entry.characterId === characterId);

    store.runInTransaction(() => {
      if (stableId && stableId !== characterId) {
        store.setMode(stableId, currentMode() === "resting" ? "resting" : "waiting");
      }
      store.setMode(characterId, "interacting");
      store.saveInteraction({
        characterId,
        returnCharacterId: stableId,
        temporary,
        startedAt: nowMs,
      });
      touchActive(nowMs);
    });
    return { characterId, returnCharacterId: stableId, temporary };
  }

  function chooseReturnCharacter(roster, nowMs, interaction) {
    const stableId = getState("current_character_id");
    if (!stableId) {
      return { characterId: null, resting: false };
    }
    const stable = store.getCompanion(stableId);
    if (!stable) {
      return { characterId: null, resting: false };
    }
    const inRoster = roster.some((entry) => entry.characterId === stableId);

    // 与当前同屏者本身聊天不是“暂离后返回”：只要仍在名单且未探索，
    // 结束就继续原陪伴；低精力待办仍由 <=30 的交接规则处理。
    if (interaction.characterId === stableId && inRoster && !stable.runtime.exploring) {
      return { characterId: stableId, resting: currentMode() === "resting" };
    }

    if (inRoster && isReadyForPresence(stable, nowMs)) {
      return { characterId: stableId, resting: currentMode() === "resting" };
    }
    const eligible = roster.find((entry) => {
      const companion = store.getCompanion(entry.characterId);
      return isReadyForPresence(companion, nowMs);
    });
    if (eligible) {
      return { characterId: eligible.characterId, resting: false };
    }
    return { characterId: stableId, resting: true };
  }

  function endInteractionInternal(nowDate, nowMs) {
    const interaction = store.getInteraction();
    if (!interaction) {
      return { ended: false, returnedCharacterId: null, rotation: null };
    }

    const roster = ensureDailyRoster(nowDate);
    const returned = chooseReturnCharacter(roster, nowMs, interaction);
    store.runInTransaction(() => {
      store.clearInteraction();
      store.setMode(interaction.characterId, "waiting");
      if (returned.characterId) {
        setState("current_character_id", returned.characterId);
        const mode = returned.resting ? "resting" : "companion";
        setState("current_mode", mode);
        store.setMode(returned.characterId, mode);
      }
      touchActive(nowMs);
    });

    const rotation = attemptHandoff(nowDate, nowMs, roster);
    return {
      ended: true,
      returnedCharacterId: returned.characterId,
      resting: returned.resting,
      rotation,
    };
  }

  function endInteraction() {
    ensureStarted();
    const nowDate = now();
    const { nowMs } = prepare(nowDate);
    return endInteractionInternal(nowDate, nowMs);
  }

  function requestAutoRotation() {
    ensureStarted();
    const nowDate = now();
    const { nowMs } = prepare(nowDate);
    const currentId = getState("current_character_id");
    const current = currentId ? store.getCompanion(currentId) : null;
    if (!current) {
      return { requested: false, pending: false, reason: "no-character" };
    }
    const pending = pendingReason();
    if (pending) {
      return { requested: false, pending: true, reason: "pending", pendingReason: pending };
    }
    if (current.stats.energy > LOW_ENERGY) {
      return { requested: false, pending: false, reason: "energy" };
    }
    store.runInTransaction(() => {
      setState("pending_rotation", "low_energy");
      touchActive(nowMs);
    });
    return {
      requested: true,
      pending: true,
      pendingReason: "low_energy",
      deferred: Boolean(store.getInteraction()),
    };
  }

  function completeNaturalNode() {
    ensureStarted();
    const nowDate = now();
    const { nowMs, roster } = prepare(nowDate);
    const pending = pendingReason();
    if (!pending) {
      return { switched: false, pending: false, reason: "no-pending" };
    }
    if (store.getInteraction()) {
      return { switched: false, pending: true, deferred: true, pendingReason: pending };
    }
    const rotation = attemptHandoff(nowDate, nowMs, roster);
    touchActive(nowMs);
    return rotation;
  }

  function attemptHandoff(nowDate, nowMs, existingRoster) {
    const pending = pendingReason();
    if (!pending) {
      return { switched: false, pending: false, reason: "no-pending" };
    }

    const roster = existingRoster ?? ensureDailyRoster(nowDate);
    const currentId = getState("current_character_id");
    const current = currentId ? store.getCompanion(currentId) : null;
    if (!current) {
      clearPending(nowMs);
      return { switched: false, pending: false, reason: "no-character" };
    }

    const stillOnRoster = roster.some((entry) => entry.characterId === currentId);
    if (pending === "roster_exit" && stillOnRoster) {
      clearPending(nowMs);
      return { switched: false, pending: false, reason: "resolved" };
    }
    if (pending === "low_energy" && current.stats.energy > LOW_ENERGY) {
      clearPending(nowMs);
      return { switched: false, pending: false, reason: "recovered" };
    }

    const candidate = roster
      .filter((entry) => entry.characterId !== currentId)
      .map((entry) => store.getCompanion(entry.characterId))
      .find((companion) => isReadyForPresence(companion, nowMs));

    if (candidate) {
      store.runInTransaction(() => {
        store.setMode(currentId, "waiting");
        store.setLastAutoExit(currentId, nowMs);
        store.setMode(candidate.characterId, "companion");
        setState("current_character_id", candidate.characterId);
        setState("current_mode", "companion");
        setState("pending_rotation", "0");
        touchActive(nowMs);
      });
      return {
        switched: true,
        pending: false,
        reason: pending,
        fromCharacterId: currentId,
        toCharacterId: candidate.characterId,
        resting: false,
      };
    }

    store.runInTransaction(() => {
      store.setMode(currentId, "resting");
      setState("current_mode", "resting");
      setState("pending_rotation", "0");
      touchActive(nowMs);
    });
    return {
      switched: false,
      pending: false,
      reason: pending,
      characterId: currentId,
      resting: true,
    };
  }

  function markClosed() {
    if (!started) {
      return;
    }
    const nowDate = now();
    const nowMs = nowDate.getTime();
    initState(nowMs);
    settleAll(nowMs);
    touchActive(nowMs);
  }

  return {
    start,
    markClosed,
    getSnapshot,
    setNickname,
    setFixed,
    switchTo,
    rest,
    startInteraction,
    endInteraction,
    requestAutoRotation,
    completeNaturalNode,
  };
}

module.exports = { createCompanionshipService, localDay };
