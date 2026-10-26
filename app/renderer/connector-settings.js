/* S05i 设置页的连接器状态面板。
   只读取 preload 暴露的展示状态与显式停用/恢复接口；不扫描来源、不读取正文，
   也不因浏览、重连或应用重启自动恢复已停用的实例。 */
(function () {
  "use strict";

  const STATUS_TEXT = { online: "在线", reconnecting: "重连中", offline: "已下线", disabled: "已停用" };
  const STATUS_HINT = {
    online: "连接与 Agent 状态来自当前 Herdr 快照。",
    reconnecting: "连接暂不可确认；登记恢复或来源重连后会更新，不会把未知当作完成。",
    offline: "来源已下线；同一实例重新登记后会自动连接。",
    disabled: "已停用；只有明确恢复后才会重新连接。",
  };
  const AGENT_TEXT = {
    needs_attention: "需要关注", finished: "已结束", failed: "失败", stopped: "已停止",
    idle: "空闲", working: "工作中", unknown: "未知",
  };
  const byId = (id) => document.getElementById(id);
  const api = window.bayperConnectors;
  const appApi = window.bayper;
  const state = { active: false, busy: false, epoch: 0, current: null };

  function setStatus(text) {
    byId("connector-status").textContent = text;
  }

  function setError(error) {
    const element = byId("connector-error");
    element.hidden = !error;
    element.textContent = error?.message ?? "";
    if (error) element.dataset.code = error.code || "UNKNOWN";
    else delete element.dataset.code;
  }

  async function call(method, ...args) {
    if (!api || typeof api[method] !== "function") {
      return {
        ok: false,
        error: { code: "NO_BRIDGE", message: "连接器接口没有加载，请重新启动应用。" },
      };
    }
    try {
      return await api[method](...args);
    } catch {
      return { ok: false, error: { code: "IPC_ERROR", message: "连接器通信失败，请重试。" } };
    }
  }

  function element(tag, className, text = "") {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  }

  function actionButton(instance) {
    const disabled = instance.status === "disabled";
    const button = element("button", `btn btn-small ${disabled ? "btn-primary" : "btn-ghost"}`);
    button.type = "button";
    button.dataset.connectorAction = disabled ? "enable" : "disable";
    button.dataset.connectorInstance = instance.instanceId;
    button.textContent = disabled ? "恢复连接" : "停用";
    button.disabled = state.busy;
    return button;
  }

  function renderInstance(instance) {
    const item = element("li", "connector-row source-row");
    item.dataset.instanceId = instance.instanceId;
    item.dataset.status = instance.status;

    const badge = element(
      "span", "connector-state source-state", STATUS_TEXT[instance.status] || "未知",
    );
    badge.dataset.state = instance.status;
    const head = element("div", "connector-head source-head");
    head.append(
      element("span", "connector-name source-name", `${instance.source || "Herdr"} · ${instance.shortId}`),
      badge,
    );

    const agents = element("ul", "connector-agents");
    agents.setAttribute("aria-label", `${instance.shortId} 的 Agent 状态`);
    if (instance.agents.length === 0) {
      agents.append(element("li", "connector-agent-empty", "尚未发现 Agent 状态"));
    } else {
      for (const agent of instance.agents) {
        const row = element("li", "connector-agent");
        row.dataset.state = agent.state;
        row.append(
          element("span", "connector-agent-name", agent.label || agent.agentId),
          element("span", "connector-agent-state", AGENT_TEXT[agent.state] || "未知"),
        );
        agents.append(row);
      }
    }

    const main = element("div", "connector-main source-main");
    main.append(
      head,
      element(
        "p", "connector-hint source-hint",
        STATUS_HINT[instance.status] || "状态暂不明确；不会把未知当作完成。",
      ),
      agents,
    );
    const actions = element("div", "connector-actions");
    actions.append(actionButton(instance));
    item.append(main, actions);
    return item;
  }

  function render() {
    const current = state.current;
    const summary = byId("connector-summary");
    if (!current) {
      summary.textContent = "正在读取连接状态…";
      summary.dataset.state = "";
      byId("connector-empty").hidden = true;
      byId("connector-list").replaceChildren();
      byId("connector-diagnostic-note").hidden = true;
      byId("connector-copy-path").disabled = true;
      return;
    }
    const instances = current.instances ?? [];
    const onlineCount = instances.filter((item) => item.status === "online").length;
    summary.textContent = instances.length
      ? `已关联 ${instances.length} · 在线 ${onlineCount}`
      : "尚未关联";
    summary.dataset.state = onlineCount > 0 ? "ok" : "";
    byId("connector-registry-path").textContent = current.registryPath || "—";
    byId("connector-copy-path").disabled = !current.registryPath;
    byId("connector-empty").hidden = instances.length > 0;
    byId("connector-list").replaceChildren(...instances.map(renderInstance));
    const note = byId("connector-diagnostic-note");
    note.hidden = !current.diagnosticCount;
    note.textContent = current.diagnosticCount
      ? "登记目录中有条目暂时无法读取；不影响其他已识别实例。"
      : "";
  }

  async function load() {
    if (!state.active) return;
    const epoch = ++state.epoch;
    state.busy = false;
    setError(null);
    setStatus("正在读取连接状态…");
    render();
    let result;
    try {
      result = await appApi.getSnapshot();
    } catch {
      result = { ok: false, error: { code: "IPC_ERROR", message: "连接器通信失败，请重试。" } };
    }
    if (epoch !== state.epoch || !state.active) return;
    setStatus("");
    if (!result.ok || !result.snapshot?.connectors) {
      setError(result.error ?? { code: "UNKNOWN", message: "连接器状态不可用，请重试。" });
      return;
    }
    state.current = result.snapshot.connectors;
    render();
  }

  async function runAction(instanceId, enabled) {
    if (state.busy || !state.active) return;
    const epoch = ++state.epoch;
    state.busy = true;
    setError(null);
    setStatus(enabled ? "正在恢复连接…" : "正在停用实例…");
    render();
    const result = await call("setEnabled", instanceId, enabled);
    if (epoch !== state.epoch || !state.active) return;
    state.busy = false;
    if (!result.ok) {
      setError(result.error);
      setStatus("");
      render();
      return;
    }
    state.current = result.state;
    setStatus(enabled ? "已恢复连接。" : "已停用此实例。");
    render();
  }

  function showConnectorPanel() {
    for (const button of document.querySelectorAll("[data-settings-tab]")) {
      button.setAttribute(
        "aria-selected",
        button.dataset.settingsTab === "connectors" ? "true" : "false",
      );
    }
    for (const panel of document.querySelectorAll("[data-settings-panel]")) {
      panel.hidden = panel.dataset.settingsPanel !== "connectors";
    }
    state.active = true;
    setError(null);
    setStatus("");
    if (!api || !appApi) {
      setError({ code: "NO_BRIDGE", message: "连接器接口没有加载，请重新启动应用。" });
      return;
    }
    load();
  }

  function deactivate() {
    state.active = false;
    state.busy = false;
    state.epoch += 1;
  }

  for (const button of document.querySelectorAll("[data-settings-tab]")) {
    button.addEventListener("click", () => {
      if (button.dataset.settingsTab === "connectors") showConnectorPanel();
      else deactivate();
    });
  }
  for (const button of document.querySelectorAll("[data-nav]")) {
    button.addEventListener("click", deactivate);
  }
  byId("connector-list").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-connector-action]");
    if (!button || state.busy) return;
    runAction(button.dataset.connectorInstance, button.dataset.connectorAction === "enable");
  });
  byId("connector-copy-path").addEventListener("click", async () => {
    setError(null);
    const result = await call("copyRegistryPath");
    if (!result.ok) {
      setError(result.error);
      setStatus("");
      return;
    }
    setStatus("登记路径已复制。");
  });
  if (appApi && typeof appApi.onSnapshotUpdated === "function") {
    appApi.onSnapshotUpdated((snapshot) => {
      if (!snapshot?.connectors) return;
      state.current = snapshot.connectors;
      if (state.active && !state.busy) render();
    });
  }
})();
