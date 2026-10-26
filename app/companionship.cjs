/* S02a 陪伴业务入口：每日名单、固定位、昵称、显式同屏、互动生命周期、
   低精力交接与本地时间结算。S06c 的日常/探索生命周期复用这里的名单、
   模式与精力结算；聊天模型和原生 panel 仍不在本切片。 */
const { AppError } = require("./errors.cjs");

const SLOT_ORDER = ["fixed", "random_1", "random_2", "random_3", "random_4"];
const MAX_RANDOM_SLOTS = 4;
const LOW_ENERGY = 30;
const READY_ENERGY = 60;
const AUTO_EXIT_COOLDOWN_MS = 30 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAILY_WINDOW_MS = HOUR_MS;
const EXPLORATION_4H_MS = 4 * HOUR_MS;
const EXPLORATION_24H_MS = 24 * HOUR_MS;

/* 每小时的精力变化。interacting 在 S02a 中不结算：真实有效互动事件在 S03 接入，
   这里既不伪造互动收益，也不把等待模型的时间算成陪伴消耗。 */
const ENERGY_RATE_PER_HOUR = Object.freeze({
  companion: -6,
  waiting: 10,
  resting: 20,
  offline: 10,
  interacting: 0,
  daily: 0,
  exploring: 0,
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

  function settleAllWork(nowMs) {
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
  }

  function settleAll(nowMs) {
    // 精力与结算锚点必须一起提交，避免存储失败后重复结算。
    store.runInTransaction(() => settleAllWork(nowMs));
  }

  function applyOfflineRecovery(nowMs) {
    const lastActive = Number(getState("last_active_at") ?? 0);
    if (!(lastActive > 0 && nowMs > lastActive)) {
      return false;
    }
    const hours = (nowMs - lastActive) / HOUR_MS;
    store.runInTransaction(() => {
      for (const companion of store.listCompanions()) {
        const energy = clampEnergy(companion.stats.energy + 10 * hours);
        store.applySettlement(companion.characterId, { energy, lastSettledAt: nowMs });
      }
      touchActive(nowMs);
    });
    return true;
  }

  /* 应用关闭后按离线规则补算，再重置各角色模式并更新锚点。
     时钟回拨时不补算，也不把持久化时间改回过去。 */
  function start() {
    const nowDate = now();
    const nowMs = nowDate.getTime();

    if (!started) {
      // 进程重建后未完成活动只能保持暂停，离线时间不推进活动。
      store.activities.pauseAllRunning(nowMs);
      applyOfflineRecovery(nowMs);

      initState(nowMs);
      store.settleMoods(nowMs);
      if (store.listCompanions().length > 0) {
        ensureDailyRoster(nowDate);
        applyStoredModes(nowMs);
      }
      touchActive(nowMs);
      started = true;
      return;
    }

    // 反复 start 时先推进活动并结算旧模式，再按当前活动/名单派生模式。
    initState(nowMs);
    advanceActivityLifecycle(nowMs);
    settleAll(nowMs);
    store.settleMoods(nowMs);
    if (store.listCompanions().length > 0) {
      const roster = ensureDailyRoster(nowDate);
      pauseActivitiesOutsideRoster(roster, nowMs);
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
        const activity = store.activities.getOpenForCharacter(companion.characterId);
        let mode = "waiting";
        if (activity?.status === "running") {
          mode = activityMode(activity.kind);
        } else if (interaction && companion.characterId === interaction.characterId) {
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

  /* 锁屏/休眠恢复：只补离线区间，随后恢复当前模式，不推进离线活动。 */
  function resumeAfterPause() {
    if (!started) {
      start();
      return;
    }
    const nowDate = now();
    const nowMs = nowDate.getTime();
    // 锁屏/休眠恢复不推进离线活动；活动保持暂停，由显式恢复入口继续。
    store.activities.pauseAllRunning(nowMs);
    applyOfflineRecovery(nowMs);
    initState(nowMs);
    settleAll(nowMs);
    store.settleMoods(nowMs);
    if (store.listCompanions().length > 0) {
      ensureDailyRoster(nowDate);
      applyStoredModes(nowMs);
    }
    touchActive(nowMs);
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

  function activityText(value, field) {
    if (typeof value !== "string") {
      throw new AppError("INVALID_INPUT", `${field} 必须是字符串。`);
    }
    const text = value.trim();
    if (text.length === 0 || text.length > 200 || /[\u0000-\u001f\u007f]/u.test(text)) {
      throw new AppError("INVALID_INPUT", `${field} 无效。`);
    }
    return text;
  }

  function activityMode(kind) {
    return kind === "daily" ? "daily" : "exploring";
  }

  function realModeFor(characterId) {
    const interaction = store.getInteraction();
    if (interaction && interaction.characterId === characterId) {
      return "interacting";
    }
    return getState("current_character_id") === characterId ? currentMode() : "waiting";
  }

  function isOnScreen(characterId) {
    return (
      getState("current_character_id") === characterId &&
      currentMode() === "companion" &&
      !store.getInteraction()
    );
  }

  function activityPublic(activity) {
    if (!activity) {
      return null;
    }
    return {
      activityId: activity.activityId,
      characterId: activity.characterId,
      kind: activity.kind,
      status: activity.status,
      durationMs: activity.durationMs,
      activeElapsedMs: activity.activeElapsedMs,
      actionComplete: activity.actionCompletedAt !== null,
      actionProgress: activity.actionFrame,
    };
  }

  function activityEligibility(characterId, kind, roster) {
    const companion = store.getCompanion(characterId);
    if (!companion) {
      return "CHARACTER_UNKNOWN";
    }
    if (!roster.some((entry) => entry.characterId === characterId)) {
      return "NOT_IN_ROSTER";
    }
    if (store.getInteraction()) {
      return "INTERACTION";
    }
    if (pendingReason()) {
      return "PENDING_ROTATION";
    }
    if (companion.runtime.exploring) {
      return "EXPLORING";
    }
    if (["daily", "exploring"].includes(companion.runtime.mode)) {
      return "BUSY";
    }
    if (kind === "daily") {
      if (!isOnScreen(characterId)) {
        return "DAILY_CURRENT_ONLY";
      }
      if (companion.stats.energy <= LOW_ENERGY) {
        return "LOW_ENERGY";
      }
    } else if (kind === "exploration") {
      if (companion.stats.energy < READY_ENERGY) {
        return "LOW_ENERGY";
      }
      if (
        getState("current_character_id") === characterId &&
        !isOnScreen(characterId)
      ) {
        return "NOT_ON_SCREEN";
      }
    } else {
      return "INVALID_KIND";
    }
    return null;
  }

  function activityResumeEligibility(activity, roster) {
    const companion = store.getCompanion(activity.characterId);
    if (!companion) {
      return "CHARACTER_UNKNOWN";
    }
    if (!roster.some((entry) => entry.characterId === activity.characterId)) {
      return "NOT_IN_ROSTER";
    }
    if (store.getInteraction()) {
      return "INTERACTION";
    }
    if (pendingReason()) {
      return "PENDING_ROTATION";
    }
    const currentId = getState("current_character_id");
    if (activity.kind === "daily") {
      if (
        currentId !== activity.characterId ||
        currentMode() !== "companion" ||
        companion.runtime.mode === "daily"
      ) {
        return "DAILY_CURRENT_ONLY";
      }
      return companion.stats.energy > LOW_ENERGY ? null : "LOW_ENERGY";
    }
    if (currentId === activity.characterId) {
      return "ON_SCREEN";
    }
    if (companion.stats.energy < READY_ENERGY) {
      return "LOW_ENERGY";
    }
    const otherExploration = store.activities
      .listOpen()
      .some(
        (item) =>
          item.kind === "exploration" && item.activityId !== activity.activityId,
      );
    return otherExploration ? "EXPLORATION_ACTIVE" : null;
  }

  function activityQuotaBlock(kind, nowMs, ignoreActivityId = null) {
    if (kind === "daily") {
      return store.activities.countStarted("daily", nowMs - DAILY_WINDOW_MS) >= 1
        ? "DAILY_LIMIT"
        : null;
    }
    if (kind !== "exploration") {
      return "INVALID_KIND";
    }
    const otherOpen = store.activities
      .listOpen()
      .some(
        (activity) =>
          activity.kind === "exploration" && activity.activityId !== ignoreActivityId,
      );
    if (otherOpen) {
      return "EXPLORATION_ACTIVE";
    }
    if (store.activities.countStarted("exploration", nowMs - EXPLORATION_4H_MS) >= 1) {
      return "EXPLORATION_4H_LIMIT";
    }
    if (store.activities.countStarted("exploration", nowMs - EXPLORATION_24H_MS) >= 2) {
      return "EXPLORATION_24H_LIMIT";
    }
    return null;
  }

  function selectSuccessor(characterId, roster, nowMs) {
    return (
      roster
        .filter((entry) => entry.characterId !== characterId)
        .map((entry) => store.getCompanion(entry.characterId))
        .find((companion) => companion && isReadyForPresence(companion, nowMs)) ?? null
    );
  }

  function cancelScheduledActivity(activity, nowMs, reason) {
    return store.runInTransaction(() => {
      const cancelled = store.activities.cancel(activity.activityId, nowMs);
      touchActive(nowMs);
      return { started: false, reason, activity: activityPublic(cancelled) };
    });
  }

  /* 运行中的活动按真实时间推进；daily 到达有效时长后仍须真实动作完成，
     不能在计时器上直接宣称完成。探索保持原有时长完成规则。 */
  function advanceActivityLifecycle(nowMs) {
    const running = store.activities.listRunning();
    const completions = [];
    for (const activity of running) {
      const last = activity.lastProgressAt ?? activity.startedAt ?? nowMs;
      if (nowMs <= last) {
        continue;
      }
      const remaining = activity.durationMs - activity.activeElapsedMs;
      const elapsed = nowMs - last;
      if (elapsed < remaining) {
        store.activities.advance(activity.activityId, elapsed, nowMs);
        continue;
      }
      if (activity.kind === "daily") {
        // 有效时长封顶，等待真实动作完成和自然节点；不追加运行时间。
        store.activities.advance(activity.activityId, Math.max(0, remaining), nowMs);
        continue;
      }
      completions.push({ activity, completionAt: last + Math.max(0, remaining) });
    }

    completions.sort((left, right) => left.completionAt - right.completionAt);
    for (const { activity, completionAt } of completions) {
      store.runInTransaction(() => {
        settleAllWork(completionAt);
        store.activities.complete(activity.activityId, completionAt);
        store.setMode(activity.characterId, realModeFor(activity.characterId));
        store.setLastSettled(activity.characterId, completionAt);
        if (activity.kind === "exploration") {
          store.setExploring(activity.characterId, false);
        }
        touchActive(completionAt);
      });
    }
  }

  /* 真实伸展播放完成后调用；完成后是否收束仍取决于有效时长与自然节点。
     回报必须带活动 ID；旧/取消/已完成活动或角色不符时只返回未接受，不串写。 */
  function completeDailyAction(activityId, { characterId: expectedCharacterId } = {}) {
    ensureStarted();
    const id = activityText(activityId, "活动 ID");
    const nowDate = now();
    const nowMs = nowDate.getTime();
    prepare(nowDate);
    const activity = store.activities.get(id);
    if (!activity) {
      return { completed: false, reason: "ACTIVITY_NOT_FOUND", activity: null };
    }
    if (
      activity.kind !== "daily" ||
      !["running", "paused"].includes(activity.status) ||
      (expectedCharacterId && activity.characterId !== expectedCharacterId)
    ) {
      return {
        completed: false,
        reason: "STALE_ACTIVITY",
        activity: activityPublic(activity),
      };
    }
    if (activity.actionCompletedAt === null) {
      store.activities.markActionComplete(id, nowMs);
    }
    return { completed: true, activity: activityPublic(store.activities.get(id)) };
  }

  /* 只持久化真实已播放帧数；不推进活动时间，也不因恢复而从 0 重来。 */
  function recordDailyActionProgress(activityId, frame, { characterId: expectedCharacterId } = {}) {
    ensureStarted();
    const id = activityText(activityId, "活动 ID");
    if (!Number.isInteger(frame) || frame < 0 || frame > 1000) {
      throw new AppError("INVALID_INPUT", "动作进度必须是非负整数。");
    }
    const activity = store.activities.get(id);
    if (
      !activity ||
      activity.kind !== "daily" ||
      !["running", "paused"].includes(activity.status) ||
      activity.actionCompletedAt !== null ||
      (expectedCharacterId && activity.characterId !== expectedCharacterId)
    ) {
      return { recorded: false, reason: "STALE_ACTIVITY", activity: activityPublic(activity) };
    }
    const nowMs = now().getTime();
    return {
      recorded: true,
      activity: activityPublic(store.activities.recordActionProgress(id, frame, nowMs)),
    };
  }

  /* 仅当真实动作与有效时长都满足时在自然节点收束。 */
  function completeReadyDaily(nowMs) {
    const ready = store.activities
      .listRunning()
      .filter(
        (activity) =>
          activity.kind === "daily" &&
          activity.actionCompletedAt !== null &&
          activity.activeElapsedMs >= activity.durationMs,
      );
    for (const activity of ready) {
      store.runInTransaction(() => {
        settleAllWork(nowMs);
        store.activities.complete(activity.activityId, nowMs);
        store.setMode(activity.characterId, realModeFor(activity.characterId));
        store.setLastSettled(activity.characterId, nowMs);
        touchActive(nowMs);
      });
    }
    return ready.length;
  }

  function pauseActivitiesOutsideRoster(roster, nowMs) {
    const ids = new Set(roster.map((entry) => entry.characterId));
    const running = store.activities
      .listOpen()
      .filter((activity) => activity.status === "running" && !ids.has(activity.characterId));
    if (running.length === 0) {
      return;
    }
    store.runInTransaction(() => {
      for (const activity of running) {
        store.activities.pause(activity.activityId, nowMs);
        store.setMode(activity.characterId, "waiting");
        if (activity.kind === "exploration") {
          store.setExploring(activity.characterId, true);
        }
      }
      touchActive(nowMs);
    });
  }

  /* 调用方已在同一事务内结算到 now，这里只停住活动并保留有效进度。 */
  function pauseRunningActivity(characterId, nowMs) {
    const activity = store.activities.getOpenForCharacter(characterId);
    if (activity?.status !== "running") {
      return false;
    }
    store.activities.pause(activity.activityId, nowMs);
    if (activity.kind === "exploration") {
      store.setExploring(characterId, true);
    }
    return true;
  }

  function startScheduledActivity(activity, nowMs, roster) {
    const blocked =
      activityEligibility(activity.characterId, activity.kind, roster) ??
      activityQuotaBlock(activity.kind, nowMs, activity.activityId);
    if (blocked) {
      return cancelScheduledActivity(activity, nowMs, blocked);
    }

    const currentId = getState("current_character_id");
    let successor = null;
    if (
      activity.kind === "exploration" &&
      currentId === activity.characterId
    ) {
      successor = selectSuccessor(activity.characterId, roster, nowMs);
      if (!successor) {
        return cancelScheduledActivity(activity, nowMs, "NO_SUCCESSOR");
      }
    }

    return store.runInTransaction(() => {
      settleAllWork(nowMs);
      const companion = store.getCompanion(activity.characterId);
      const change = activity.kind === "daily" ? -2 : -8;
      const energy = clampEnergy(companion.stats.energy + change);
      store.applySettlement(activity.characterId, { energy, lastSettledAt: nowMs });
      store.setMode(activity.characterId, activityMode(activity.kind));
      if (activity.kind === "exploration") {
        store.setExploring(activity.characterId, true);
        if (successor) {
          store.setMode(successor.characterId, "companion");
          setState("current_character_id", successor.characterId);
          setState("current_mode", "companion");
          setState("pending_rotation", "0");
        }
      } else {
        store.setExploring(activity.characterId, false);
      }
      store.activities.start(activity.activityId, nowMs);
      touchActive(nowMs);
      return {
        started: true,
        activity: activityPublic(store.activities.get(activity.activityId)),
        fromCharacterId: successor ? activity.characterId : null,
        toCharacterId: successor ? successor.characterId : null,
      };
    });
  }

  function prepare(nowDate) {
    const nowMs = nowDate.getTime();
    initState(nowMs);
    advanceActivityLifecycle(nowMs);
    settleAll(nowMs);
    store.settleMoods(nowMs);
    const roster = ensureDailyRoster(nowDate);
    pauseActivitiesOutsideRoster(roster, nowMs);
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
    const baseMode = interaction ? "interacting" : currentMode();
    const idsInRoster = rosterIds(roster);
    const display = companions.find((companion) => companion.characterId === displayId) ?? null;
    const activityByCharacter = new Map(
      store.activities.listOpen().map((activity) => [activity.characterId, activity]),
    );
    const mode = ["daily", "exploring"].includes(display?.runtime.mode)
      ? display.runtime.mode
      : baseMode;

    const rosterPublic = roster.map((entry) => {
      const companion = companions.find((item) => item.characterId === entry.characterId);
      return {
        slot: entry.slot,
        characterId: entry.characterId,
        displayName: companion ? displayNameOf(companion) : entry.characterId,
        nickname: companion?.nickname ?? null,
        energy: companion?.stats.energy ?? null,
        exploring: companion?.runtime.exploring ?? false,
        activity: activityPublic(activityByCharacter.get(entry.characterId)),
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
      activity: activityPublic(activityByCharacter.get(companion.characterId)),
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
        activity: activityPublic(activityByCharacter.get(display.characterId)),
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
    const target = store.getCompanion(characterId);
    if (target.runtime.exploring) {
      throw new AppError("CHARACTER_EXPLORING", "探索中的角色不能直接切换同屏，请先发起聊天。");
    }
    const interaction = store.getInteraction();
    const previousId = getState("current_character_id");

    store.runInTransaction(() => {
      // 新同屏者不能带着运行中的真实短活动进入同屏。
      pauseRunningActivity(characterId, nowMs);
      if (interaction) {
        store.setMode(interaction.characterId, "waiting");
        store.clearInteraction();
      }
      if (previousId) {
        pauseRunningActivity(previousId, nowMs);
        if (previousId !== characterId) {
          store.setMode(previousId, "waiting");
        }
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
        pauseRunningActivity(currentId, nowMs);
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
      pauseRunningActivity(characterId, nowMs);
      if (stableId && stableId !== characterId) {
        // 聊天会暂时让出同屏位置，原同屏者的真实短活动必须同时暂停。
        pauseRunningActivity(stableId, nowMs);
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
    const runningActivity = store.activities.getOpenForCharacter(currentId);
    store.runInTransaction(() => {
      setState("pending_rotation", "low_energy");
      touchActive(nowMs);
    });
    return {
      requested: true,
      pending: true,
      pendingReason: "low_energy",
      deferred:
        Boolean(store.getInteraction()) || runningActivity?.status === "running",
    };
  }

  function completeNaturalNode() {
    ensureStarted();
    const nowDate = now();
    const { nowMs, roster } = prepare(nowDate);
    // daily 的真实动作与有效时长都满足后，只在这里（自然节点）收束。
    const completedDaily = completeReadyDaily(nowMs);
    const pending = pendingReason();
    if (pending) {
      if (store.getInteraction()) {
        return {
          switched: false,
          pending: true,
          deferred: true,
          pendingReason: pending,
          completedDaily,
        };
      }
      const rotation = attemptHandoff(nowDate, nowMs, roster);
      touchActive(nowMs);
      return { ...rotation, completedDaily };
    }

    const scheduled = store.activities.getScheduled();
    if (!scheduled) {
      return { switched: false, pending: false, reason: "no-pending", completedDaily };
    }
    if (store.getInteraction()) {
      return {
        started: false,
        pending: false,
        deferred: true,
        reason: "INTERACTION",
        activity: activityPublic(scheduled),
        completedDaily,
      };
    }
    return { ...startScheduledActivity(scheduled, nowMs, roster), completedDaily };
  }

  function requestActivity({ activityId, characterId, kind } = {}) {
    ensureStarted();
    const id = activityText(activityId, "活动 ID");
    const target = activityText(characterId, "角色 ID");
    if (!["daily", "exploration"].includes(kind)) {
      throw new AppError("INVALID_INPUT", "活动类型必须是 daily 或 exploration。");
    }

    const nowDate = now();
    const { nowMs, roster } = prepare(nowDate);
    const existing = store.activities.get(id);
    if (existing) {
      if (existing.characterId !== target || existing.kind !== kind) {
        throw new AppError("ACTIVITY_CONFLICT", "同一活动 ID 不能更换角色或类型。");
      }
      return { requested: true, duplicate: true, activity: activityPublic(existing) };
    }

    const scheduled = store.activities.getScheduled();
    if (scheduled) {
      return {
        requested: false,
        reason: "BUSY",
        activity: activityPublic(scheduled),
      };
    }
    const open = store.activities.getOpenForCharacter(target);
    if (open) {
      return {
        requested: false,
        reason: "ACTIVITY_ACTIVE",
        activity: activityPublic(open),
      };
    }
    const blocked =
      activityEligibility(target, kind, roster) ??
      activityQuotaBlock(kind, nowMs);
    if (blocked) {
      return { requested: false, reason: blocked, activity: null };
    }

    const activity = store.activities.insertScheduled({
      activityId: id,
      characterId: target,
      kind,
      at: nowMs,
      durationMs: store.activities.DURATIONS[kind],
    });
    return { requested: true, duplicate: false, activity: activityPublic(activity) };
  }

  function advanceActivities() {
    ensureStarted();
    const nowDate = now();
    const { nowMs } = prepare(nowDate);
    return {
      settledAt: nowMs,
      activities: store.activities.listOpen().map(activityPublic),
    };
  }

  /* 主进程自然节点只需便宜地判断是否有待开始活动，避免每个待机节点都结算快照。 */
  function hasScheduledActivity() {
    ensureStarted();
    return store.activities.getScheduled() !== null;
  }

  /* 日常运行中的自然节点还需核对真实动作完成；这里只做便宜的存在性判断。 */
  function hasRunningDaily() {
    ensureStarted();
    return store.activities.listRunning().some((activity) => activity.kind === "daily");
  }

  function getActivity(activityId) {
    ensureStarted();
    const id = activityText(activityId, "活动 ID");
    prepare(now());
    return store.activities.get(id);
  }

  function pauseActivity(activityId) {
    ensureStarted();
    const id = activityText(activityId, "活动 ID");
    const nowDate = now();
    const { nowMs } = prepare(nowDate);
    const activity = store.activities.get(id);
    if (!activity) {
      throw new AppError("ACTIVITY_NOT_FOUND", "活动不存在。");
    }
    if (activity.status === "paused") {
      return { paused: true, duplicate: true, activity: activityPublic(activity) };
    }
    if (activity.status !== "running") {
      return { paused: false, reason: "NOT_RUNNING", activity: activityPublic(activity) };
    }

    return store.runInTransaction(() => {
      settleAllWork(nowMs);
      store.activities.pause(id, nowMs);
      store.setMode(activity.characterId, realModeFor(activity.characterId));
      if (activity.kind === "exploration") {
        store.setExploring(activity.characterId, true);
      }
      touchActive(nowMs);
      return { paused: true, duplicate: false, activity: activityPublic(store.activities.get(id)) };
    });
  }

  function resumeActivity(activityId) {
    ensureStarted();
    const id = activityText(activityId, "活动 ID");
    const nowDate = now();
    const { nowMs, roster } = prepare(nowDate);
    const activity = store.activities.get(id);
    if (!activity) {
      throw new AppError("ACTIVITY_NOT_FOUND", "活动不存在。");
    }
    if (activity.status === "running") {
      return { resumed: true, duplicate: true, activity: activityPublic(activity) };
    }
    if (activity.status !== "paused") {
      return { resumed: false, reason: "NOT_PAUSED", activity: activityPublic(activity) };
    }
    const blocked = activityResumeEligibility(activity, roster);
    if (blocked) {
      return { resumed: false, reason: blocked, activity: activityPublic(activity) };
    }

    return store.runInTransaction(() => {
      settleAllWork(nowMs);
      store.activities.resume(id, nowMs);
      store.setMode(activity.characterId, activityMode(activity.kind));
      if (activity.kind === "exploration") {
        store.setExploring(activity.characterId, true);
      }
      touchActive(nowMs);
      return { resumed: true, duplicate: false, activity: activityPublic(store.activities.get(id)) };
    });
  }

  function cancelActivity(activityId) {
    ensureStarted();
    const id = activityText(activityId, "活动 ID");
    const nowDate = now();
    const { nowMs } = prepare(nowDate);
    const activity = store.activities.get(id);
    if (!activity) {
      throw new AppError("ACTIVITY_NOT_FOUND", "活动不存在。");
    }
    if (["completed", "cancelled"].includes(activity.status)) {
      return { cancelled: false, reason: "ALREADY_CLOSED", activity: activityPublic(activity) };
    }

    return store.runInTransaction(() => {
      settleAllWork(nowMs);
      store.activities.cancel(id, nowMs);
      store.setMode(activity.characterId, realModeFor(activity.characterId));
      store.setExploring(activity.characterId, false);
      touchActive(nowMs);
      return { cancelled: true, activity: activityPublic(store.activities.get(id)) };
    });
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

    const runningActivity = store.activities.getOpenForCharacter(currentId);
    if (runningActivity?.status === "running") {
      // 自然节点回调不能替代真实短活动；等 prepare 推进到真实完成点再交接。
      return {
        switched: false,
        pending: true,
        deferred: true,
        pendingReason: pending,
      };
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
    advanceActivityLifecycle(nowMs);
    settleAll(nowMs);
    store.runInTransaction(() => {
      store.activities.pauseAllRunning(nowMs);
      for (const activity of store.activities.listOpen()) {
        if (activity.status === "paused") {
          store.setMode(activity.characterId, realModeFor(activity.characterId));
        }
      }
    });
    store.settleMoods(nowMs);
    touchActive(nowMs);
  }

  return {
    start,
    resumeAfterPause,
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
    completeDailyAction,
    recordDailyActionProgress,
    hasScheduledActivity,
    hasRunningDaily,
    requestActivity,
    advanceActivities,
    getActivity,
    pauseActivity,
    resumeActivity,
    cancelActivity,
  };
}

module.exports = { createCompanionshipService, localDay };
