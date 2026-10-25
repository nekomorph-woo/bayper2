/* S02a renderer：界面状态切换、首次相遇与本地陪伴安排；聊天面板由独立 chat-panel 模块接入。
   不访问文件、数据库或网络，也不使用 localStorage。 */
const api = window.bayper;
const chatApi = window.bayperChat;
const byId = (id) => document.getElementById(id);

const state = {
  snapshot: null,
  candidates: [],
  candidateIndex: 0,
  fixedSelection: null,
};

const sections = Array.from(document.querySelectorAll("[data-step]"));

function showStep(name) {
  for (const section of sections) {
    section.hidden = section.dataset.step !== name;
  }
  window.scrollTo(0, 0);
}

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

const chatPanel = window.createChatPanel({
  api: chatApi,
  callApi: callChatApi,
  showAlert,
  getSnapshot: () => state.snapshot,
});

/* ---------- 模型配置 ---------- */

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
  showStep("wish");
}

/* ---------- 愿望与候选 ---------- */

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
  renderHome();
  showStep("home");
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

      row.append(slot, name);
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
      row.append(actions);
      return row;
    }),
  );
}

function replaceOptions(select, characters, selectedId) {
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
    nicknameSelect.value || companion?.current?.characterId || characters[0]?.characterId || "";
  const fixedSelection =
    state.fixedSelection && characters.some((character) => character.characterId === state.fixedSelection)
      ? state.fixedSelection
      : companion?.fixedCharacterId ?? "";
  replaceOptions(fixedSelect, characters, fixedSelection);
  replaceOptions(nicknameSelect, characters, previousNicknameId);

  const selected = characters.find((character) => character.characterId === nicknameSelect.value);
  if (document.activeElement !== nicknameInput) {
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
    showAlert(byId("config-alert"), {
      code: "CONTENT_MISSING",
      message: "已保存的关系找不到对应角色资料，请重启应用后重试。",
    });
    showStep("config");
    return;
  }

  const displayName = current?.displayName ?? character.name;
  byId("home-name").textContent = displayName;
  byId("home-tagline").textContent = character.tagline;
  byId("home-intro").textContent = character.intro;
  byId("home-image").src = character.image;
  byId("home-image").alt = `${displayName}（开发候选角色图）`;

  const traits = byId("home-traits");
  traits.replaceChildren(
    ...character.traits.map((trait) => {
      const item = document.createElement("li");
      item.textContent = trait;
      return item;
    }),
  );

  const characters = companion?.characters ?? [];
  const fixed = characters.find((item) => item.characterId === companion?.fixedCharacterId);
  byId("home-current").textContent = presenceText(companion);
  byId("home-fixed").textContent = `固定陪伴：${fixed?.displayName ?? "未设置"}`;
  const roster = companion?.roster ?? [];
  byId("home-roster").textContent =
    roster.length > 0
      ? `今日名单：${roster.map((entry) => `${entry.displayName}（${SLOT_LABELS[entry.slot] ?? entry.slot}）`).join("、")}`
      : "今日名单：暂无";

  const stats = current?.stats ?? relationship.stats;
  byId("stat-intimacy").textContent = String(Math.round(stats.intimacy));
  byId("stat-energy").textContent = String(Math.round(stats.energy));
  byId("stat-mood").textContent = String(Math.round(stats.mood));
  byId("home-model").textContent = snapshot.model.configured
    ? `模型：${snapshot.model.modelName} · Key 仅保存在系统安全存储`
    : "模型尚未配置";
  byId("desktop-status").textContent = desktopStatusText(snapshot.desktop);

  renderRoster(companion);
  renderCompanionControls(companion);
  chatPanel.renderLaunch(companion);
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
  renderHome();
  const status = byId(statusId);
  status.dataset.state = "ok";
  status.textContent = successText;
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

/* ---------- 启动 ---------- */

function applySnapshot(snapshot) {
  state.snapshot = snapshot;
  if (snapshot.state === "accepted") {
    renderHome();
    showStep("home");
    return;
  }
  if (snapshot.state === "configured") {
    showStep("wish");
    return;
  }
  showStep("config");
}

async function init() {
  if (!api || typeof api.getSnapshot !== "function") {
    showAlert(byId("config-alert"), {
      code: "NO_BRIDGE",
      message: "应用接口没有加载，无法继续。请重新启动 Bayper。",
    });
    byId("config-submit").disabled = true;
    showStep("config");
    return;
  }

  const result = await callApi("getSnapshot");
  if (!result.ok) {
    showAlert(byId("config-alert"), result.error);
    byId("config-submit").disabled = true;
    showStep("config");
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
  const characters = state.snapshot?.companionship?.characters ?? [];
  const selected = characters.find((item) => item.characterId === byId("nickname-character").value);
  byId("nickname-input").value = selected?.nickname ?? "";
});

if (api && typeof api.onSnapshotUpdated === "function") {
  api.onSnapshotUpdated((snapshot) => {
    if (!snapshot || snapshot.state !== "accepted") {
      return;
    }
    state.snapshot = snapshot;
    renderHome();
    if (byId("rest-companion").closest('[data-step="home"]').hidden) {
      showStep("home");
    }
  });
}
init();
