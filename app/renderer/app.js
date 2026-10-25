/* 管理窗渲染：首次相遇、小窝、角色与设置。全部数据来自 preload 快照；
   不访问文件、数据库或网络，也不使用 localStorage。聊天与记忆面板由独立模块接入。 */
const api = window.bayper;
const chatApi = window.bayperChat;
const memoryApi = window.bayperMemory;
const byId = (id) => document.getElementById(id);

const state = {
  snapshot: null,
  candidates: [],
  candidateIndex: 0,
  fixedSelection: null,
  selectedCharacterId: null,
  characterTab: "overview",
};

const navigation = window.createWindowNavigation({
  onNavigate: (page) => renderPage(page),
});

function showAlert(element, error) {
  if (!error) {
    element.hidden = true;
    element.textContent = "";
    delete element.dataset.code;
    return;
  }
  element.hidden = false;
  element.textContent = error.message || "操作没有完成，请重试。";
  element.dataset.code = error.code || "UNKNOWN";
}

async function callApi(method, ...args) {
  try {
    return await api[method](...args);
  } catch {
    return { ok: false, error: { code: "IPC_ERROR", message: "应用通信失败，请重试。" } };
  }
}

async function callChatApi(method, ...args) {
  try {
    return await chatApi[method](...args);
  } catch {
    return { ok: false, error: { code: "IPC_ERROR", message: "聊天通信失败，请重试。" } };
  }
}

async function callMemoryApi(method, ...args) {
  try {
    return await memoryApi[method](...args);
  } catch {
    return { ok: false, error: { code: "IPC_ERROR", message: "记忆通信失败，请重试。" } };
  }
}

const chatPanel = window.createChatPanel({
  api: chatApi,
  callApi: callChatApi,
  showAlert,
  getSnapshot: () => state.snapshot,
});

const memoryPanel = window.createMemoryPanel({
  callApi: callMemoryApi,
  showAlert,
  getSnapshot: () => state.snapshot,
});

if (memoryApi && typeof memoryApi.onMemoryChanged === "function") {
  memoryApi.onMemoryChanged((payload) => {
    memoryPanel.handleMemoryChanged(payload);
    chatPanel.handleMemoryChanged(payload);
  });
}

/* ---------- 模型配置与首次相遇 ---------- */

function showOnboarding(step) {
  navigation.showOnboarding(step, step === "wish" ? "选择陪伴" : "连接模型");
}

async function submitConfig(event) {
  event.preventDefault();
  const submit = byId("config-submit");
  const status = byId("config-status");
  showAlert(byId("config-alert"), null);

  submit.disabled = true;
  status.textContent = "正在发送一次连通检查…";

  const result = await callApi("validateAndSaveModel", {
    baseUrl: byId("base-url").value,
    modelName: byId("model-name").value,
    apiKey: byId("api-key").value,
  });

  if (!result.ok) {
    showAlert(byId("config-alert"), result.error);
    submit.disabled = false;
    status.textContent = "";
    return;
  }

  // 配置成功后不再在 DOM 中保留 Key。
  byId("api-key").value = "";
  state.snapshot = result.snapshot;
  status.textContent = "";
  showOnboarding("wish");
  byId("wish-input").focus();
}

async function submitWish(event) {
  event.preventDefault();
  const submit = byId("wish-submit");
  showAlert(byId("wish-alert"), null);
  submit.disabled = true;

  const result = await callApi("recommendCharacters", byId("wish-input").value);
  submit.disabled = false;

  if (!result.ok) {
    showAlert(byId("wish-alert"), result.error);
    return;
  }
  if (!Array.isArray(result.candidates) || result.candidates.length === 0) {
    showAlert(byId("wish-alert"), {
      code: "NO_CANDIDATE",
      message: "当前版本还没有可用角色，无法继续首次相遇。",
    });
    return;
  }

  state.candidates = result.candidates;
  state.candidateIndex = 0;
  renderCandidate();
}

function currentCandidate() {
  return state.candidates[state.candidateIndex] ?? null;
}

function renderCandidate() {
  const candidate = currentCandidate();
  const card = byId("candidate-card");
  if (!candidate) {
    card.hidden = true;
    return;
  }

  const image = byId("candidate-image");
  image.src = candidate.image;
  image.alt = `${candidate.name}（开发候选角色图）`;
  byId("candidate-name").textContent = candidate.name;
  byId("candidate-tagline").textContent = candidate.tagline;
  byId("candidate-intro").textContent = candidate.intro;
  byId("candidate-reason").textContent = `推荐原因：${candidate.reason}`;

  const traits = byId("candidate-traits");
  traits.replaceChildren(
    ...candidate.traits.map((trait) => {
      const item = document.createElement("li");
      item.textContent = trait;
      return item;
    }),
  );

  const position = state.candidateIndex + 1;
  const total = state.candidates.length;
  byId("candidate-position").textContent =
    position === 1 ? `第 ${position} / ${total} 位 · 推荐` : `第 ${position} / ${total} 位`;
  byId("next-candidate").disabled = total <= 1;
  byId("accept-button").disabled = false;
  card.hidden = false;
}

function nextCandidate() {
  if (state.candidates.length <= 1) {
    return;
  }
  state.candidateIndex = (state.candidateIndex + 1) % state.candidates.length;
  renderCandidate();
}

async function acceptCandidate() {
  const candidate = currentCandidate();
  if (!candidate) {
    return;
  }

  const accept = byId("accept-button");
  const next = byId("next-candidate");
  showAlert(byId("wish-alert"), null);
  accept.disabled = true;
  next.disabled = true;
  accept.textContent = "正在接纳…";

  const result = await callApi("acceptCharacter", candidate.id);

  accept.textContent = "确认接纳";
  if (!result.ok) {
    showAlert(byId("wish-alert"), result.error);
    accept.disabled = false;
    next.disabled = state.candidates.length <= 1;
    return;
  }

  state.snapshot = result.snapshot;
  state.selectedCharacterId = result.snapshot?.companionship?.current?.characterId ?? null;
  renderAll();
  navigation.showPage("home", { focus: true });
}

/* ---------- 小窝 ---------- */

const SLOT_LABELS = {
  fixed: "固定位",
  random_1: "随机位",
  random_2: "随机位",
  random_3: "随机位",
  random_4: "随机位",
};

function presenceText(companion) {
  const current = companion?.current;
  if (!current) {
    return "暂无同屏角色";
  }
  if (companion.interaction?.temporary) {
    return `${current.displayName} · 临时互动中`;
  }
  if (companion.interaction) {
    return `${current.displayName} · 互动中`;
  }
  if (current.source === "resting") {
    return `${current.displayName} · 安静休息中`;
  }
  return `${current.displayName} · 安静陪伴`;
}

function characterStateText(character) {
  if (character.isCurrent && character.isFixed) {
    return "在场 · 固定位";
  }
  if (character.isCurrent) {
    return "在场";
  }
  if (character.isFixed) {
    return "固定位";
  }
  return character.inRoster ? "今日名单" : "名单外";
}

function renderRoster(companion) {
  const list = byId("roster-list");
  const roster = companion?.roster ?? [];
  if (roster.length === 0) {
    const empty = document.createElement("li");
    empty.className = "status-text";
    empty.textContent = "今天还没有可显示的名单。";
    list.replaceChildren(empty);
    return;
  }

  list.replaceChildren(
    ...roster.map((entry) => {
      const row = document.createElement("li");
      row.className = `roster-row${entry.isCurrent ? " is-current" : ""}`;
      row.dataset.characterId = entry.characterId;

      const slot = document.createElement("span");
      slot.className = "roster-slot";
      slot.textContent = SLOT_LABELS[entry.slot] ?? entry.slot;

      const name = document.createElement("span");
      name.className = "roster-name";
      name.textContent = entry.displayName;

      const actions = document.createElement("span");
      actions.className = "roster-actions";
      const chatButton = document.createElement("button");
      chatButton.type = "button";
      chatButton.className = "btn btn-ghost btn-small";
      chatButton.dataset.action = "chat";
      chatButton.dataset.characterId = entry.characterId;
      chatButton.textContent = "聊天";
      actions.append(chatButton);
      if (entry.isCurrent) {
        const current = document.createElement("span");
        current.className = "status-text";
        current.textContent = "当前";
        actions.append(current);
      } else {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn btn-ghost btn-small";
        button.dataset.action = "switch";
        button.dataset.characterId = entry.characterId;
        button.textContent = "请她陪我";
        actions.append(button);
      }
      row.append(slot, name, actions);
      return row;
    }),
  );
}

function replaceOptions(select, characters, selectedId) {
  if (!select) {
    return;
  }
  select.replaceChildren(
    ...characters.map((character) => {
      const option = document.createElement("option");
      option.value = character.characterId;
      option.textContent = character.displayName;
      return option;
    }),
  );
  if (selectedId && characters.some((character) => character.characterId === selectedId)) {
    select.value = selectedId;
  }
}

function renderCompanionControls(companion) {
  const characters = companion?.characters ?? [];
  const fixedSelect = byId("fixed-select");
  const nicknameSelect = byId("nickname-character");
  const nicknameInput = byId("nickname-input");

  const previousNicknameId =
    nicknameSelect?.value || companion?.current?.characterId || characters[0]?.characterId || "";
  const fixedSelection =
    state.fixedSelection && characters.some((character) => character.characterId === state.fixedSelection)
      ? state.fixedSelection
      : companion?.fixedCharacterId ?? "";
  replaceOptions(fixedSelect, characters, fixedSelection);
  replaceOptions(nicknameSelect, characters, previousNicknameId);

  const selected = characters.find((character) => character.characterId === nicknameSelect?.value);
  if (nicknameInput && document.activeElement !== nicknameInput) {
    nicknameInput.value = selected?.nickname ?? "";
  }

  const restButton = byId("rest-companion");
  if (companion?.current?.mode === "resting") {
    restButton.textContent = "继续陪伴";
    restButton.dataset.action = "wake";
    restButton.disabled = false;
  } else {
    restButton.textContent = "安静休息";
    restButton.dataset.action = "rest";
    restButton.disabled = !companion?.current;
  }
}

function desktopStatusText(desktop) {
  if (!desktop || desktop.state === "stopped") {
    return "桌面角色：未启动";
  }
  if (desktop.state === "starting" || desktop.state === "restarting") {
    return desktop.state === "restarting" ? "桌面角色：正在恢复" : "桌面角色：正在启动";
  }
  if (desktop.state === "failed") {
    return "桌面角色：暂不可用（可从托盘重启）";
  }
  if (desktop.state !== "running") {
    return "桌面角色：状态未知";
  }
  if (desktop.assetState === "pending") {
    return "桌面角色：当前角色素材制作中";
  }
  if (desktop.assetState === "error" || desktop.assetState === "none") {
    return "桌面角色：素材加载失败";
  }
  return `桌面角色：运行中（${desktop.assetLabel || "素材已接入"}）`;
}

function renderHome() {
  const snapshot = state.snapshot;
  const companion = snapshot?.companionship;
  const relationship = snapshot?.relationship;
  const current = companion?.current ?? null;
  const character = current ?? snapshot?.currentCharacter;
  if (!relationship || !character) {
    showAlert(byId("home-alert"), {
      code: "CONTENT_MISSING",
      message: "已保存的关系找不到对应角色资料，请重启应用后重试。",
    });
    showOnboarding("config");
    return;
  }

  const displayName = current?.displayName ?? character.name;
  byId("home-name").textContent = displayName;
  byId("home-tagline").textContent = character.tagline;
  byId("home-image").src = character.image;
  byId("home-image").alt = `${displayName}（开发候选角色图）`;

  const characters = companion?.characters ?? [];
  const fixed = characters.find((item) => item.characterId === companion?.fixedCharacterId);
  byId("home-current").textContent = presenceText(companion);
  byId("home-fixed").textContent = `固定陪伴：${fixed?.displayName ?? "未设置"}`;

  const stats = current?.stats ?? relationship.stats;
  byId("stat-intimacy").textContent = String(Math.round(stats.intimacy));
  byId("stat-energy").textContent = String(Math.round(stats.energy));
  byId("stat-mood").textContent = String(Math.round(stats.mood));

  renderRoster(companion);
  renderCompanionControls(companion);
  chatPanel.renderLaunch(companion);
}

/* ---------- 角色 ---------- */

function characters() {
  return state.snapshot?.companionship?.characters ?? [];
}

function ensureSelectedCharacter() {
  const list = characters();
  if (!list.some((character) => character.characterId === state.selectedCharacterId)) {
    state.selectedCharacterId =
      state.snapshot?.companionship?.current?.characterId ?? list[0]?.characterId ?? null;
  }
  return list.find((character) => character.characterId === state.selectedCharacterId) ?? null;
}

function renderCharacterList() {
  const listEl = byId("character-list");
  const list = characters();
  if (list.length === 0) {
    const empty = document.createElement("li");
    empty.className = "status-text";
    empty.textContent = "还没有已结识的角色。";
    listEl.replaceChildren(empty);
    return;
  }

  listEl.replaceChildren(
    ...list.map((character) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "character-item";
      button.dataset.characterId = character.characterId;
      if (character.characterId === state.selectedCharacterId) {
        button.setAttribute("aria-current", "true");
      }

      const image = document.createElement("img");
      image.src = character.image ?? "";
      image.alt = "";
      const who = document.createElement("span");
      who.className = "character-item-who";
      const name = document.createElement("span");
      name.className = "character-item-name";
      name.textContent = character.displayName;
      const status = document.createElement("span");
      status.className = "character-item-state";
      status.textContent = characterStateText(character);
      who.append(name, status);
      button.append(image, who);
      button.addEventListener("click", () => selectCharacter(character.characterId));
      item.append(button);
      return item;
    }),
  );
}

function renderCharacterTabs() {
  for (const button of document.querySelectorAll("[data-character-tab]")) {
    button.setAttribute(
      "aria-selected",
      button.dataset.characterTab === state.characterTab ? "true" : "false",
    );
  }
  for (const panel of document.querySelectorAll("[data-character-panel]")) {
    panel.hidden = panel.dataset.characterPanel !== state.characterTab;
  }
}

function renderCharacterDetail(character) {
  const hasCharacter = Boolean(character);
  byId("character-name").textContent = hasCharacter ? character.displayName : "还没有可查看的角色";
  byId("character-tagline").textContent = character?.tagline ?? "";
  byId("character-chat").disabled = !hasCharacter;
  byId("character-memory").disabled = !hasCharacter;

  const image = byId("character-image");
  image.src = character?.image ?? "";
  image.alt = character ? `${character.displayName}（开发候选角色图）` : "";
  byId("character-intro").textContent =
    character?.intro || "完成首次接纳后，这里会显示角色介绍。";

  const traits = byId("character-traits");
  traits.replaceChildren(
    ...(character?.traits ?? []).map((trait) => {
      const item = document.createElement("li");
      item.textContent = trait;
      return item;
    }),
  );

  const stats = character?.stats;
  byId("character-stat-intimacy").textContent = stats ? String(Math.round(stats.intimacy)) : "—";
  byId("character-stat-energy").textContent = stats ? String(Math.round(stats.energy)) : "—";
  byId("character-stat-mood").textContent = stats ? String(Math.round(stats.mood)) : "—";

  if (!character) {
    byId("character-roster-state").textContent = "";
  } else if (character.inRoster) {
    byId("character-roster-state").textContent = character.isCurrent
      ? "现在在场。浏览其他角色不会切换或改动今日名单。"
      : "在今日名单中。浏览不会切换当前在场角色。";
  } else {
    byId("character-roster-state").textContent =
      "不在今日名单；可以临时聊天，聊天结束会回到原来的陪伴安排。";
  }

  for (const button of document.querySelectorAll("[data-character-tab]")) {
    button.disabled = !hasCharacter;
  }
  renderCharacterTabs();
}

function selectCharacter(characterId) {
  const character = characters().find((item) => item.characterId === characterId);
  if (!character) {
    return;
  }
  state.selectedCharacterId = characterId;
  const nicknameSelect = byId("nickname-character");
  if (
    nicknameSelect &&
    Array.from(nicknameSelect.options).some((option) => option.value === characterId)
  ) {
    nicknameSelect.value = characterId;
    byId("nickname-input").value = character.nickname ?? "";
  }
  renderCharacters();
}

function renderCharacters() {
  const selected = ensureSelectedCharacter();
  renderCharacterList();
  renderCharacterDetail(selected);
  renderCompanionControls(state.snapshot?.companionship);
}

/* ---------- 设置 ---------- */

function renderSettings() {
  const model = state.snapshot?.model ?? { configured: false };
  byId("settings-model-state").textContent = model.configured ? "已配置" : "尚未配置";
  byId("settings-model-name").textContent = model.configured ? model.modelName : "—";
  byId("settings-base-url").textContent = model.configured ? model.baseUrl : "—";
  byId("check-model").disabled = !model.configured;
  byId("desktop-status").textContent = desktopStatusText(state.snapshot?.desktop);
}

async function checkStoredModelConnection() {
  const button = byId("check-model");
  const status = byId("check-model-status");
  button.disabled = true;
  status.dataset.state = "";
  status.textContent = "正在检查…";

  const result = await callApi("checkStoredModel");
  button.disabled = false;

  if (!result.ok) {
    status.dataset.state = "error";
    status.textContent = result.error.message;
    return;
  }
  status.dataset.state = "ok";
  status.textContent = "模型连接正常";
}

/* ---------- 页面切换与陪伴动作 ---------- */

function updateSubtitle() {
  const page = navigation.currentPage();
  if (page === "home") {
    const companion = state.snapshot?.companionship;
    navigation.setSubtitle(`${presenceText(companion)} · 今日 ${companion?.roster?.length ?? 0} 位`);
  } else if (page === "characters") {
    navigation.setSubtitle(
      state.snapshot?.relationship
        ? `已结识 ${characters().length} 位 · 浏览不会改变小窝安排`
        : "已结识的角色",
    );
  } else if (page === "settings") {
    navigation.setSubtitle("模型连接与本机配置");
  }
}

function renderPage(page) {
  if (state.snapshot?.state !== "accepted") {
    return;
  }
  if (page === "home") {
    renderHome();
  } else if (page === "characters") {
    renderCharacters();
  } else if (page === "settings") {
    renderSettings();
  }
  updateSubtitle();
}

function renderAll() {
  renderHome();
  renderCharacters();
  renderSettings();
  updateSubtitle();
}

async function runCompanionAction(button, call, successText, statusId) {
  showAlert(byId("home-alert"), null);
  const wasDisabled = button?.disabled ?? false;
  if (button) {
    button.disabled = true;
  }
  const result = await call();
  if (button) {
    button.disabled = wasDisabled;
  }
  if (!result.ok) {
    showAlert(byId("home-alert"), result.error);
    return;
  }
  state.snapshot = result.snapshot;
  renderAll();
  const status = byId(statusId);
  if (status) {
    status.dataset.state = "ok";
    status.textContent = successText;
  }
}

async function switchCompanion(characterId, button, successText = "已切换到这位 Bayper。") {
  await runCompanionAction(
    button,
    () => callApi("switchCompanion", characterId),
    successText,
    "presence-status",
  );
}

async function restCompanion() {
  await runCompanionAction(
    byId("rest-companion"),
    () => callApi("restCompanion"),
    "已进入安静休息。",
    "presence-status",
  );
}

async function saveFixed() {
  await runCompanionAction(
    byId("fixed-save"),
    () => callApi("setFixedCompanion", byId("fixed-select").value),
    "固定陪伴已更新。",
    "arrange-status",
  );
}

async function saveNickname() {
  await runCompanionAction(
    byId("nickname-save"),
    () => callApi("setNickname", byId("nickname-character").value, byId("nickname-input").value),
    "昵称已保存。",
    "arrange-status",
  );
}

/* ---------- 启动 ---------- */

function applySnapshot(snapshot) {
  state.snapshot = snapshot;
  if (snapshot.state === "accepted") {
    renderAll();
    navigation.showPage("home", { focus: true });
    return;
  }
  if (snapshot.state === "configured") {
    showOnboarding("wish");
    return;
  }
  showOnboarding("config");
}

async function init() {
  if (!api || typeof api.getSnapshot !== "function") {
    showAlert(byId("config-alert"), {
      code: "NO_BRIDGE",
      message: "应用接口没有加载，无法继续。请重新启动 Bayper。",
    });
    byId("config-submit").disabled = true;
    showOnboarding("config");
    return;
  }

  const result = await callApi("getSnapshot");
  if (!result.ok) {
    showAlert(byId("config-alert"), result.error);
    byId("config-submit").disabled = true;
    showOnboarding("config");
    return;
  }
  applySnapshot(result.snapshot);
}

byId("config-form").addEventListener("submit", submitConfig);
byId("wish-form").addEventListener("submit", submitWish);
byId("next-candidate").addEventListener("click", nextCandidate);
byId("accept-button").addEventListener("click", acceptCandidate);
byId("check-model").addEventListener("click", checkStoredModelConnection);
byId("rest-companion").addEventListener("click", () => {
  const button = byId("rest-companion");
  const current = state.snapshot?.companionship?.current;
  if (button.dataset.action === "wake" && current) {
    switchCompanion(current.characterId, button, "已继续陪伴。");
    return;
  }
  restCompanion();
});
byId("fixed-save").addEventListener("click", saveFixed);
byId("fixed-select").addEventListener("change", () => {
  state.fixedSelection = byId("fixed-select").value;
});
byId("nickname-save").addEventListener("click", saveNickname);
byId("roster-list").addEventListener("click", (event) => {
  const chatButton = event.target.closest('button[data-action="chat"]');
  if (chatButton) {
    chatPanel.openFor(chatButton.dataset.characterId, chatButton);
    return;
  }
  const button = event.target.closest('button[data-action="switch"]');
  if (!button) {
    return;
  }
  switchCompanion(button.dataset.characterId, button);
});
byId("nickname-character").addEventListener("change", () => {
  const list = state.snapshot?.companionship?.characters ?? [];
  const selected = list.find((item) => item.characterId === byId("nickname-character").value);
  byId("nickname-input").value = selected?.nickname ?? "";
});
document.querySelectorAll("[data-character-tab]").forEach((button) => {
  button.addEventListener("click", () => {
    if (state.characterTab === button.dataset.characterTab) {
      return;
    }
    state.characterTab = button.dataset.characterTab;
    renderCharacterTabs();
    button.focus();
  });
});
byId("character-chat").addEventListener("click", () => {
  if (state.selectedCharacterId) {
    chatPanel.openFor(state.selectedCharacterId, byId("character-chat"));
  }
});
byId("character-memory").addEventListener("click", () => {
  if (state.selectedCharacterId) {
    memoryPanel.openFor(state.selectedCharacterId, byId("character-memory"));
  }
});

if (api && typeof api.onSnapshotUpdated === "function") {
  api.onSnapshotUpdated((snapshot) => {
    if (!snapshot || snapshot.state !== "accepted") {
      return;
    }
    state.snapshot = snapshot;
    renderAll();
    if (!navigation.isNavVisible()) {
      navigation.showPage("home");
    }
  });
}
init();
