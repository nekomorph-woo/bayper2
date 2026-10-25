/* 应用外壳：状态存取、侧栏、聊天侧栏、弹层、提示。
   各页面只负责自己的内容与操作，不再各自实现一套外壳。 */

(function () {
  const DATA = window.BAYPER;
  const KEY = "bayper.prototype.v3";

  const params = new URLSearchParams(location.search);
  const PAGES = {
    home: "index.html",
    characters: "characters.html",
    stories: "stories.html",
    connections: "connections.html",
    settings: "settings.html",
  };

  /* ---------- 状态 ---------- */

  function defaults() {
    return {
      nicknames: {},
      // 已接纳、当日名单、固定位、桌面同屏是四件不同的事，不要互相顶替。
      acceptedIds: ["rin", "hu", "cheng"],
      dailyIds: ["rin", "hu", "cheng"],
      fixedId: "rin",
      desktopId: "rin",
      prevDesktopId: null,
      status: { rin: "desktop", hu: "exploring", cheng: "home" },
      declined: [],
      chats: {},
      memoryEdits: {},
      memoryHidden: [],
      memoryHiddenKeys: [],
      pausedExploration: null,
      dirs: {},
      connections: { studioOnline: false, reconnecting: false },
      settings: JSON.parse(JSON.stringify(DATA.settings)),
      analysisCleared: false,
    };
  }

  function mergeDeep(base, saved) {
    if (!saved || typeof saved !== "object") return base;
    Object.keys(saved).forEach((key) => {
      const value = saved[key];
      base[key] =
        value && typeof value === "object" && !Array.isArray(value) && base[key]
          ? mergeDeep(base[key], value)
          : value;
    });
    return base;
  }

  function readState() {
    const state = defaults();
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) mergeDeep(state, JSON.parse(raw));
    } catch (error) {
      // 读不到就先用默认值；写失败会在保存时单独提示。
    }
    return state;
  }

  const state = readState();
  const forceSaveError = params.get("state") === "save-error";

  function save() {
    if (forceSaveError) return false;
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      return true;
    } catch (error) {
      return false;
    }
  }

  /* ---------- 通用 ---------- */

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[c]);
  }

  function character(id) {
    return DATA.characters[id] || null;
  }

  function displayName(id) {
    const base = character(id);
    if (!base) return "";
    return state.nicknames[id] || base.name;
  }

  function statusOf(id) {
    return state.status[id] || "home";
  }

  function whoName(id) {
    return character(id) ? displayName(id) : "小窝";
  }

  function statusLabel(id) {
    return DATA.statusText[statusOf(id)] || DATA.statusText.home;
  }

  function acceptedIds() {
    return state.acceptedIds.filter((id) => character(id));
  }

  function avatar(id, small) {
    const base = character(id);
    if (!base) return "";
    if (!base.img) {
      return `<span class="avatar avatar--letter${small ? " avatar--sm" : ""}">${escapeHtml(
        base.name.slice(0, 1)
      )}</span>`;
    }
    return `<span class="avatar avatar--${id}${small ? " avatar--sm" : ""}"><img src="${
      base.img
    }" alt="" loading="lazy"></span>`;
  }

  /* ---------- 侧栏 ---------- */

  const ICONS = {
    home: '<path d="M3.5 9.5 10 3.8l6.5 5.7v6a1 1 0 0 1-1 1h-3.7v-4.7H8.2v4.7H4.5a1 1 0 0 1-1-1z"/>',
    characters:
      '<path d="M4.6 8.4 5.4 4.2l3.4 1.9"/><path d="M15.4 8.4 14.6 4.2l-3.4 1.9"/><path d="M4.4 9.6a5.6 5.6 0 0 1 11.2 0v1.7a5.6 5.6 0 0 1-11.2 0z"/><path d="M8.4 11.2h.01M11.6 11.2h.01" stroke-width="1.9"/>',
    stories:
      '<path d="M4.5 5.2A1.4 1.4 0 0 1 5.9 3.8H16v10.6H5.9a1.4 1.4 0 0 0-1.4 1.4z"/><path d="M4.5 15.8v-1.2"/><path d="M7 7h5.5"/>',
    connections:
      '<circle cx="6.2" cy="6.2" r="2.2"/><circle cx="13.8" cy="13.8" r="2.2"/><path d="m7.8 7.8 4.4 4.4"/>',
    settings:
      '<path d="M3.2 6.4h13.6M3.2 13.6h13.6"/><circle cx="8" cy="6.4" r="2.1"/><circle cx="12.6" cy="13.6" r="2.1"/>',
  };

  function navLink(page, label) {
    return `<a href="${PAGES[page]}"${
      page === document.body.dataset.page ? ' aria-current="page"' : ""
    }>
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[page]}</svg>
      ${label}</a>`;
  }

  function mountSidebar() {
    const sidebar = document.querySelector(".sidebar");
    if (!sidebar) return;
    sidebar.innerHTML = `
      <div class="traffic" aria-hidden="true"><i></i><i></i><i></i></div>
      <p class="brand">Bayper</p>
      <nav class="nav" aria-label="主导航">
        ${navLink("home", "小窝")}
        ${navLink("characters", "角色")}
        ${navLink("stories", "故事")}
        ${navLink("connections", "连接")}
      </nav>
      <div class="sidebar__foot">
        <nav class="nav" aria-label="设置">${navLink("settings", "设置")}</nav>
      </div>`;
  }

  /* ---------- 提示 ---------- */

  let toastTimer = null;

  function toast(message) {
    let el = document.querySelector(".toast");
    if (!el) {
      el = document.createElement("p");
      el.className = "toast";
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
      document.body.append(el);
    }
    el.textContent = message;
    el.dataset.show = "true";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.dataset.show = "false";
    }, 2600);
  }

  /* ---------- 弹层 ---------- */

  let dialogNode = null;
  let dialogRestore = null;
  let dialogCleanup = null;

  function ensureDialog() {
    if (dialogNode) return dialogNode;
    dialogNode = document.createElement("div");
    dialogNode.className = "modal";
    dialogNode.hidden = true;
    dialogNode.innerHTML = `
      <div class="modal__scrim" data-cancel></div>
      <div class="modal__panel" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
        <h2 id="modalTitle"></h2>
        <div class="modal__body"></div>
        <div class="modal__foot"></div>
      </div>`;
    document.body.append(dialogNode);
    return dialogNode;
  }

  function trapTab(event) {
    if (event.key !== "Tab" || !dialogNode) return;
    const focusable = dialogNode.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function closeDialog() {
    if (!dialogNode || dialogNode.hidden) return;
    dialogNode.hidden = true;
    document.removeEventListener("keydown", onDialogKey);
    if (dialogRestore && document.contains(dialogRestore)) dialogRestore.focus();
    if (dialogCleanup) dialogCleanup();
    dialogCleanup = null;
    dialogRestore = null;
  }

  function onDialogKey(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDialog();
    }
    trapTab(event);
  }

  function dialog(options) {
    const node = ensureDialog();
    const panel = node.querySelector(".modal__panel");
    const title = node.querySelector("#modalTitle");
    const body = node.querySelector(".modal__body");
    const foot = node.querySelector(".modal__foot");

    dialogRestore = document.activeElement;
    title.textContent = options.title || "";
    body.innerHTML = options.body || "";
    foot.innerHTML = "";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn btn--ghost";
    cancelBtn.textContent = options.cancelText || "取消";
    cancelBtn.addEventListener("click", closeDialog);
    if (options.cancel !== false) foot.append(cancelBtn);

    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = `btn ${options.danger ? "btn--danger" : "btn--primary"}`;
    confirmBtn.textContent = options.confirmText || "确定";
    confirmBtn.addEventListener("click", () => {
      if (options.onConfirm && options.onConfirm(panel) === false) return;
      closeDialog();
    });
    foot.append(confirmBtn);

    node.querySelector("[data-cancel]").onclick = closeDialog;
    node.hidden = false;
    document.addEventListener("keydown", onDialogKey);

    if (options.onOpen) dialogCleanup = options.onOpen(panel) || null;
    confirmBtn.focus();
  }

  /* ---------- 聊天侧栏 ---------- */

  let chatNode = null;
  let chatId = null;
  let chatTrigger = null;
  let replyTimer = null;

  function replyCount(id) {
    return (state.chats[id] || []).filter((m) => m.from === "me").length;
  }

  function paintChat() {
    const base = character(chatId);
    if (!base) return;
    const log = chatNode.querySelector(".chat__log");
    const messages = state.chats[chatId] || [];
    log.innerHTML =
      `<p class="chat__day">今天</p>` +
      messages
        .map(
          (m) =>
            `<div class="msg msg--${m.from === "me" ? "me" : "them"}"><p class="msg__bubble">${escapeHtml(
              m.text
            )}</p></div>`
        )
        .join("");
    log.scrollTop = log.scrollHeight;

    chatNode.querySelector(".chat__name").textContent = displayName(chatId);
    chatNode.querySelector(".chat__meta").textContent = statusLabel(chatId);
    chatNode.querySelector(".chat__avatar").innerHTML = avatar(chatId, true);
  }

  function buildChat() {
    chatNode = document.createElement("aside");
    chatNode.className = "chat";
    chatNode.id = "chat";
    chatNode.dataset.open = "false";
    chatNode.setAttribute("aria-hidden", "true");
    chatNode.setAttribute("aria-label", "与角色的对话");
    chatNode.innerHTML = `
      <header class="chat__head">
        <span class="chat__avatar"></span>
        <div class="chat__who">
          <p class="chat__name"></p>
          <p class="chat__meta"></p>
        </div>
        <button class="icon-btn" type="button" data-chat-close aria-label="关闭对话" style="margin-left:auto">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"
            stroke-linecap="round" aria-hidden="true"><path d="m5.5 5.5 9 9M14.5 5.5l-9 9"/></svg>
        </button>
      </header>
      <div class="chat__log" role="log" aria-live="polite"></div>
      <form class="chat__form">
        <textarea rows="1" aria-label="输入消息" placeholder="说点什么…"></textarea>
        <button class="chat__send" type="submit" aria-label="发送">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M4 10h11M11.4 6.2 15.2 10l-3.8 3.8"/></svg>
        </button>
      </form>`;
    document.body.append(chatNode);

    chatNode.querySelector("[data-chat-close]").addEventListener("click", closeChat);

    const form = chatNode.querySelector(".chat__form");
    const input = form.querySelector("textarea");
    const send = form.querySelector(".chat__send");

    const syncSend = () => {
      send.disabled = input.value.trim() === "";
    };
    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = `${input.scrollHeight}px`;
      syncSend();
    });

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (input.value.trim()) form.requestSubmit();
      }
    });

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text || !chatId) return;
      pushMessage("me", text);
      input.value = "";
      input.style.height = "auto";
      syncSend();

      const presets = DATA.chatPresets[chatId] || [];
      if (!presets.length) return;
      const index = Math.max(0, replyCount(chatId) - 1) % presets.length;
      clearTimeout(replyTimer);
      replyTimer = setTimeout(() => {
        pushMessage("them", presets[index]);
      }, 620);
    });

    syncSend();
  }

  function pushMessage(from, text) {
    if (!state.chats[chatId]) state.chats[chatId] = [];
    state.chats[chatId].push({ from, text });
    if (!save()) toast("没有保存成功，这段对话只留在当前窗口。");
    paintChat();
  }

  function openChat(id, trigger) {
    if (!chatNode) buildChat();
    chatId = id;
    chatTrigger = trigger || document.activeElement;

    if (!state.chats[id] || state.chats[id].length === 0) {
      state.chats[id] = [{ from: "them", text: DATA.chatOpenings[id] || "我在。" }];
      save();
    }

    paintChat();
    chatNode.dataset.open = "true";
    chatNode.setAttribute("aria-hidden", "false");
    chatNode.querySelector(".chat__form textarea").focus();
  }

  function closeChat() {
    if (!chatNode || chatNode.dataset.open !== "true") return;
    chatNode.dataset.open = "false";
    chatNode.setAttribute("aria-hidden", "true");
    if (chatTrigger && document.contains(chatTrigger)) chatTrigger.focus();
    chatTrigger = null;
  }

  function onChatKey(event) {
    if (event.key !== "Escape") return;
    // 弹层打开时先让弹层处理 Escape，避免一次按键关掉两层。
    if (document.querySelector(".modal:not([hidden])")) return;
    closeChat();
  }

  document.addEventListener("keydown", onChatKey);

  /* ---------- ?page= 兼容入口 ---------- */

  const pageParam = params.get("page");
  const here = document.body.dataset.page;
  if (pageParam && PAGES[pageParam] && pageParam !== here) {
    params.delete("page");
    const rest = params.toString();
    location.replace(PAGES[pageParam] + (rest ? `?${rest}` : ""));
  }

  document.addEventListener("DOMContentLoaded", () => {
    mountSidebar();
  });

  /* ---------- 桌面同屏与固定位 ---------- */

  function askCompanion(id, onDone) {
    const base = character(id);
    if (!base || !base.img || id === state.desktopId) return;

    const current = state.desktopId;
    const exploring = state.status[id] === "exploring";
    const inDaily = state.dailyIds.includes(id);
    const name = displayName(id);
    const currentName = displayName(current);

    dialog({
      title: exploring ? `叫${name}回来陪你？` : `请${name}陪你？`,
      body: exploring
        ? `<p><strong>${escapeHtml(name)}</strong> 还在外面探索。叫她回来会先暂停这次探索，走过的地方留在她自己的记录里，不会丢。</p>
           <p>${escapeHtml(currentName)} 会回到小窝。桌面上始终只有一位角色。</p>`
        : `<p><strong>${escapeHtml(name)}</strong> 来到桌面，${escapeHtml(currentName)} 回到小窝。</p>
           ${
             inDaily
               ? ""
               : `<p>这是临时陪伴，不会改动今日名单，也不会让她因此获得自动活动的资格。</p>`
           }`,
      confirmText: exploring ? "叫她回来" : "请她过来",
      cancelText: "再想想",
      onConfirm() {
        if (current && current !== id) state.status[current] = "home";
        state.status[id] = "desktop";
        state.prevDesktopId = current;
        state.desktopId = id;
        state.pausedExploration = exploring ? { id, at: "今天 16:40" } : null;
        const saved = save();
        if (onDone) onDone();
        toast(saved ? `${name}来到桌面了。` : "没有保存成功，这次换人只在当前窗口生效。");
      },
    });
  }

  function setFixed(id, onDone) {
    if (id === state.fixedId || !character(id)) return;
    // 固定位属于当日名单：不在名单里就先补进名单，最多 5 位。
    if (!state.dailyIds.includes(id)) {
      state.dailyIds = [...state.dailyIds, id].slice(0, 5);
    }
    state.fixedId = id;
    const saved = save();
    if (onDone) onDone();
    toast(
      saved
        ? `${displayName(id)}现在是固定位；桌面上的还是${displayName(state.desktopId)}。`
        : "没有保存成功，这次改动只在当前窗口生效。"
    );
  }

  function nextDesktopCandidate() {
    const order = [state.prevDesktopId, state.fixedId, ...state.dailyIds];
    return (
      order.find(
        (id) =>
          id &&
          id !== state.desktopId &&
          character(id) &&
          character(id).img &&
          state.status[id] !== "exploring"
      ) || null
    );
  }

  function endTemporary(onDone) {
    const back = nextDesktopCandidate();
    if (!back) {
      toast("名单里这会儿没有能接替的人，先留着现在的陪伴。");
      return;
    }
    state.status[state.desktopId] = "home";
    state.status[back] = "desktop";
    state.desktopId = back;
    state.prevDesktopId = null;
    const saved = save();
    if (onDone) onDone();
    toast(saved ? `回到${displayName(back)}这边了。` : "没有保存成功，这次改动只在当前窗口生效。");
  }

  window.App = {
    data: DATA,
    state,
    save,
    character,
    displayName,
    statusOf,
    statusLabel,
    whoName,
    acceptedIds,
    avatar,
    escapeHtml,
    toast,
    dialog,
    closeDialog,
    openChat,
    closeChat,
    askCompanion,
    setFixed,
    endTemporary,
    resetState() {
      const fresh = defaults();
      Object.keys(state).forEach((key) => {
        delete state[key];
      });
      Object.assign(state, fresh);
      save();
    },
    params,
  };
})();
