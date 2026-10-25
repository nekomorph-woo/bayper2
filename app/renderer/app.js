/* S01 renderer：只做界面状态切换与四类业务调用。
   不访问文件、数据库或网络，也不使用 localStorage。 */
const api = window.bayper;
const byId = (id) => document.getElementById(id);

const state = {
  snapshot: null,
  candidates: [],
  candidateIndex: 0,
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

function renderHome() {
  const snapshot = state.snapshot;
  const relationship = snapshot?.relationship;
  const character = snapshot?.currentCharacter;
  if (!relationship || !character) {
    showAlert(byId("config-alert"), {
      code: "CONTENT_MISSING",
      message: "已保存的关系找不到对应角色资料，请重启应用后重试。",
    });
    showStep("config");
    return;
  }

  byId("home-name").textContent = character.name;
  byId("home-tagline").textContent = character.tagline;
  byId("home-intro").textContent = character.intro;
  byId("home-image").src = character.image;
  byId("home-image").alt = `${character.name}（开发候选角色图）`;

  const traits = byId("home-traits");
  traits.replaceChildren(
    ...character.traits.map((trait) => {
      const item = document.createElement("li");
      item.textContent = trait;
      return item;
    }),
  );

  const fixedName =
    relationship.fixedCharacterId === character.id ? character.name : relationship.fixedCharacterId;
  byId("home-fixed").textContent = `固定陪伴：${fixedName}`;
  byId("home-roster").textContent = `今日名单：${relationship.todayRoster
    .map((entry) =>
      entry.characterId === character.id ? `${character.name}（固定位）` : `${entry.characterId}（固定位）`,
    )
    .join("、")}`;

  byId("stat-intimacy").textContent = String(relationship.stats.intimacy);
  byId("stat-energy").textContent = String(relationship.stats.energy);
  byId("stat-mood").textContent = String(relationship.stats.mood);
  byId("home-model").textContent = snapshot.model.configured
    ? `模型：${snapshot.model.modelName} · Key 仅保存在系统安全存储`
    : "模型尚未配置";
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
init();
