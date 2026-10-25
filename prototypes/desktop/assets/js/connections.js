/* 连接：两个 Herdr 来源、独立 Agent 状态、可过滤可展开的通知。
   重连只改变来源状态，不补写上线历史，也不把断连中的任务当成已结束。 */

(function () {
  const A = window.App;
  const DATA = A.data;
  const state = A.state;

  // 重连之后才拿得到的 Agent 状态；断开期间一律显示“未知”。
  const STUDIO_ONLINE_AGENTS = [
    { name: "素材归档", state: "waiting", note: "需要你选择归档目录" },
    { name: "图片导出", state: "working", note: "恢复后继续导出，从中断处开始" },
  ];

  const FILTERS = [
    { id: "all", label: "全部", kinds: null },
    { id: "attention", label: "需要你处理", kinds: ["attention"] },
    { id: "done", label: "进展与结束", kinds: ["done", "update"] },
    { id: "alert", label: "连接", kinds: ["alert"] },
  ];

  const KIND_LABEL = {
    attention: "需要你处理",
    update: "进展",
    done: "已结束",
    alert: "连接中断",
  };

  let filter = "all";
  const expanded = new Set();

  const sourcesEl = document.getElementById("sources");
  const notifsEl = document.getElementById("notifs");
  const connSub = document.getElementById("connSub");
  const filtersEl = document.getElementById("filters");

  function isOnline(source) {
    return source.id === "studio" ? Boolean(state.connections.studioOnline) : source.online;
  }

  function agentsOf(source) {
    if (source.id === "studio" && isOnline(source)) return STUDIO_ONLINE_AGENTS;
    return source.agents;
  }

  function renderSources() {
    sourcesEl.innerHTML = DATA.sources
      .map((source) => {
        const online = isOnline(source);
        const agents = agentsOf(source);
        const reconnecting = source.id === "studio" && Boolean(state.connections.reconnecting);

        const rows = agents
          .map(
            (agent) => `<div class="agent">
              <div>
                <p class="agent__name">${A.escapeHtml(agent.name)}</p>
                <p class="agent__note">${A.escapeHtml(agent.note)}</p>
              </div>
              <span class="state-chip" data-state="${agent.state}">${DATA.agentState[agent.state]}</span>
            </div>`
          )
          .join("");

        const status = reconnecting
          ? `<span class="status" data-kind="exploring"><i class="status__dot"></i>重连中</span>`
          : `<span class="status" data-kind="${online ? "desktop" : "unknown"}">
               <i class="status__dot"></i>${online ? "在线" : "已断开"}</span>`;

        const foot = online
          ? `<p class="source__hint">${
              source.id === "studio" && state.connections.studioOnline
                ? "刚刚重新连接。断开期间的状态没有补记。"
                : "连接正常。"
            }</p>`
          : `<p class="source__hint">断开之后，Agent 状态停在最后一次同步，不能当作已经结束。</p>
             <button class="btn btn--ghost btn--sm" type="button" data-reconnect
               ${reconnecting ? "disabled" : ""}>${reconnecting ? "重连中…" : "重新连接"}</button>`;

        return `<article class="source" data-online="${online}" data-od-id="source-${source.id}">
            <div class="source__head">
              <div>
                <p class="source__name">${A.escapeHtml(source.name)}</p>
                <p class="source__place">${A.escapeHtml(source.place)}</p>
              </div>
              <span class="source__status">${status}</span>
            </div>
            <div class="agents">${rows}</div>
            <div class="source__foot">${foot}</div>
          </article>`;
      })
      .join("");

    const reconnect = sourcesEl.querySelector("[data-reconnect]");
    if (reconnect) reconnect.addEventListener("click", startReconnect);
  }

  function startReconnect() {
    if (state.connections.studioOnline || state.connections.reconnecting) return;
    state.connections.reconnecting = true;
    renderSources();

    setTimeout(() => {
      state.connections.reconnecting = false;
      state.connections.studioOnline = true;
      if (!A.save()) A.toast("没有保存成功，重连状态只在当前窗口生效。");
      renderSources();
      A.toast("已经重新连接。断开期间的记录没有补发。");
    }, 1200);
  }

  function renderFilters() {
    filtersEl.innerHTML = FILTERS.map(
      (item) => `<button class="filter" type="button" data-filter="${item.id}"
        aria-pressed="${item.id === filter}">${item.label}</button>`
    ).join("");

    filtersEl.querySelectorAll("[data-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        filter = btn.dataset.filter;
        render();
      });
    });
  }

  function renderNotifs() {
    const active = FILTERS.find((f) => f.id === filter);
    const list = DATA.notifications.filter(
      (n) => !active || !active.kinds || active.kinds.includes(n.kind)
    );

    if (!list.length) {
      notifsEl.innerHTML = `<div class="empty" style="margin-top:16px">这一类现在没有记录。</div>`;
      return;
    }

    notifsEl.innerHTML = list
      .map((note) => {
        const source = DATA.sources.find((s) => s.id === note.source);
        const open = expanded.has(note.id);
        return `<article class="notif" data-od-id="notif-${note.id}">
            <button class="notif__button" type="button" data-toggle="${note.id}"
              aria-expanded="${open}">
              <span class="notif__time">${note.time}</span>
              <span>
                <span class="notif__title">${A.escapeHtml(note.title)}</span>
                <span class="notif__from">${A.escapeHtml(source ? source.name : "未知来源")} · ${A.escapeHtml(
          note.agent
        )}</span>
              </span>
              <span class="notif__kind" data-kind="${note.kind}">${KIND_LABEL[note.kind]}</span>
            </button>
            ${
              open
                ? `<div class="notif__detail"><p>${A.escapeHtml(note.detail)}</p></div>`
                : ""
            }
          </article>`;
      })
      .join("");

    notifsEl.querySelectorAll("[data-toggle]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.toggle;
        if (expanded.has(id)) expanded.delete(id);
        else expanded.add(id);
        renderNotifs();
        const next = notifsEl.querySelector(`[data-toggle="${id}"]`);
        if (next) next.focus();
      });
    });
  }

  function render() {
    renderSources();
    renderFilters();
    renderNotifs();
    connSub.textContent = `${DATA.sources.length} 个来源 · ${DATA.notifications.length} 条通知`;
  }

  render();
})();
