/* S03b 聊天面板：管理窗内的紧凑聊天 UI。
   只通过 preload 暴露的具名方法访问主进程；不接触文件、数据库、Key 或模型地址。 */
(function () {
  "use strict";

  function createChatPanel({ api, callApi, showAlert, getSnapshot }) {
    const byId = (id) => document.getElementById(id);
    const PANEL_HTML = `
      <aside id="chat-panel" class="chat-panel" hidden aria-labelledby="chat-title">
        <header class="chat-head">
          <div>
            <p class="eyebrow">私聊</p>
            <h2 id="chat-title">聊天</h2>
            <p id="chat-subtitle" class="status-text"></p>
          </div>
          <button id="chat-close" class="btn btn-ghost btn-small" type="button" aria-label="关闭聊天">
            关闭
          </button>
        </header>

        <div class="chat-target-bar">
          <label for="chat-target-select">聊天对象</label>
          <select id="chat-target-select" aria-label="切换聊天角色"></select>
        </div>

        <div id="chat-history-bar" class="chat-history-bar" hidden>
          <label for="chat-history-select">最近对话</label>
          <select id="chat-history-select"></select>
          <button id="chat-continue" class="btn btn-primary btn-small" type="button">
            继续对话
          </button>
        </div>

        <p id="chat-memory-status" class="chat-memory-status" role="status" aria-live="polite" hidden></p>
        <div id="chat-history" class="chat-history" role="log" aria-live="polite"></div>
        <p id="chat-empty" class="chat-empty" hidden>还没有对话。说第一句话吧。</p>

        <form id="chat-form" class="chat-compose" novalidate>
          <textarea
            id="chat-input"
            rows="2"
            maxlength="2000"
            placeholder="说点什么…"
            aria-label="聊天输入"
          ></textarea>
          <div class="chat-compose-row">
            <span id="chat-status" class="status-text" role="status" aria-live="polite"></span>
            <button id="chat-cancel" class="btn btn-ghost btn-small" type="button" hidden>
              取消
            </button>
            <button id="chat-retry" class="btn btn-ghost btn-small" type="button" hidden>
              重试
            </button>
            <button id="chat-send" class="btn btn-primary" type="submit">发送</button>
          </div>
          <div id="chat-error" class="alert" role="alert" hidden></div>
        </form>
      </aside>
    `;
    let panelBound = false;
    const viewGate = window.createChatViewGate();
    const chat = {
      open: false,
      characterId: null,
      displayName: null,
      conversationId: null,
      requestId: null,
      mode: "closed",
      conversations: [],
      closing: false,
      trigger: null,
    };

    function newRequestId() {
      if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
        return globalThis.crypto.randomUUID();
      }
      return `chat-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    function formatStamp(ms) {
      if (!Number.isFinite(ms)) {
        return "";
      }
      return new Date(ms).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
    }

    function truncate(text, max) {
      const value = String(text ?? "");
      return value.length > max ? `${value.slice(0, max)}…` : value;
    }

    function setSubtitle(text) {
      byId("chat-subtitle").textContent = text;
    }

    function setStatus(text, stateName = "") {
      const status = byId("chat-status");
      status.textContent = text;
      status.dataset.state = stateName;
    }

    function setMemoryStatus(count) {
      const status = byId("chat-memory-status");
      if (!status) {
        return;
      }
      if (!Number.isInteger(count) || count <= 0) {
        status.hidden = true;
        status.textContent = "";
        return;
      }
      status.hidden = false;
      status.textContent = `已保存${count}条记忆`;
    }

    function showChatError(error) {
      showAlert(byId("chat-error"), error ?? null);
      if (error) {
        setSubtitle(error.message || "聊天操作没有完成。");
      }
    }

    function setLaunchStatus(text, stateName = "") {
      const status = byId("chat-launch-status");
      status.textContent = text;
      status.dataset.state = stateName;
    }

    function applyMode() {
      const mode = chat.mode;
      const closing = chat.closing;
      const hasMessages = byId("chat-history").childElementCount > 0;
      byId("chat-form").hidden = mode === "readonly" || mode === "loading" || mode === "closed";
      byId("chat-input").disabled = closing || mode !== "open";
      byId("chat-send").disabled = closing || mode !== "open";
      byId("chat-cancel").hidden = mode !== "waiting";
      byId("chat-cancel").disabled = closing;
      byId("chat-retry").hidden = mode !== "failed";
      byId("chat-retry").disabled = closing;
      byId("chat-close").disabled = closing;
      byId("chat-history-select").disabled = closing;
      byId("chat-continue").disabled = closing;
      byId("chat-history-bar").hidden =
        mode !== "readonly" || chat.conversations.length === 0;
      byId("chat-empty").hidden = mode === "readonly" || hasMessages;
    }

    function renderHeader() {
      byId("chat-title").textContent = chat.displayName
        ? `和${chat.displayName}聊天`
        : "聊天";
      if (chat.mode === "readonly") {
        setSubtitle("已结束 · 只读显示");
      } else if (chat.mode === "open") {
        setSubtitle(`这段对话只属于${chat.displayName || "当前角色"}`);
      }
      renderTargets();
    }

    function renderTargets() {
      const characters = getSnapshot()?.companionship?.characters ?? [];
      const select = byId("chat-target-select");
      select.replaceChildren(
        ...characters.map((character) => {
          const option = document.createElement("option");
          option.value = character.characterId;
          option.textContent = character.displayName;
          return option;
        }),
      );
      if (chat.characterId) {
        select.value = chat.characterId;
      }
      select.disabled = chat.closing || chat.mode === "loading";
    }

    function renderMessages(messages) {
      const history = byId("chat-history");
      history.replaceChildren(
        ...messages.map((message) => {
          const bubble = document.createElement("div");
          bubble.className = `chat-bubble chat-bubble-${message.role}`;
          const role = document.createElement("span");
          role.className = "chat-role";
          role.textContent = message.role === "user" ? "你" : chat.displayName || "角色";
          const text = document.createElement("span");
          text.textContent = message.content;
          bubble.append(role, text);
          return bubble;
        }),
      );
      byId("chat-empty").hidden = messages.length > 0 || chat.mode === "readonly";
      history.scrollTop = history.scrollHeight;
    }

    function renderHistoryOptions(conversations) {
      byId("chat-history-select").replaceChildren(
        ...conversations.map((conversation) => {
          const option = document.createElement("option");
          option.value = conversation.id;
          const stamp = formatStamp(conversation.updatedAt || conversation.createdAt);
          option.textContent = `${stamp} · ${
            conversation.lastMessage ? truncate(conversation.lastMessage, 22) : "空对话"
          }`;
          return option;
        }),
      );
    }

    async function loadArchivedConversation(conversationId, token) {
      const result = await callApi("getChatConversation", chat.characterId, conversationId);
      if (!viewGate.current(token) || chat.closing) {
        return;
      }
      if (!result.ok) {
        showChatError(result.error);
        return;
      }
      chat.conversationId = result.conversation.id;
      chat.requestId = null;
      chat.mode = "readonly";
      setMemoryStatus(0);
      byId("chat-history-select").value = conversationId;
      renderMessages(result.messages);
      setStatus("");
      renderHeader();
      applyMode();
    }

    async function openChatFor(characterId, trigger, { keepTrigger = false } = {}) {
      if (!characterId || chat.closing) {
        return;
      }
      ensurePanel();
      const character = (getSnapshot()?.companionship?.characters ?? []).find(
        (item) => item.characterId === characterId,
      );
      if (!keepTrigger) {
        chat.trigger = trigger || document.activeElement;
      }
      if (chat.open) {
        const closed = await requestMainClose("正在关闭原对话…");
        if (!closed.ok) {
          if (!closed.superseded) {
            renderTargets();
          }
          return;
        }
      }
      const token = viewGate.beginOpen();
      chat.open = true;
      chat.characterId = characterId;
      chat.displayName = character?.displayName ?? characterId;
      chat.conversationId = null;
      chat.requestId = null;
      chat.mode = "loading";
      chat.conversations = [];
      setMemoryStatus(0);
      byId("chat-panel").hidden = false;
      byId("chat-history").replaceChildren();
      byId("chat-input").value = "";
      showChatError(null);
      setStatus("");
      setSubtitle("正在打开…");
      renderHeader();
      applyMode();
      setLaunchStatus("");

      const result = await callApi("openChat", characterId);
      if (!viewGate.current(token) || chat.closing) {
        return;
      }
      if (!result.ok) {
        chat.open = false;
        chat.mode = "closed";
        byId("chat-panel").hidden = true;
        setLaunchStatus(result.error.message, "error");
        if (chat.trigger?.isConnected) {
          chat.trigger.focus();
        }
        return;
      }

      chat.displayName = result.displayName || chat.displayName;
      chat.conversations = Array.isArray(result.history) ? result.history : [];
      renderHeader();
      if (chat.conversations.length > 0) {
        renderHistoryOptions(chat.conversations);
        const latest = chat.conversations[0];
        byId("chat-history-select").value = latest.id;
        await loadArchivedConversation(latest.id, token);
        if (!viewGate.current(token) || chat.closing || chat.mode !== "readonly") {
          return;
        }
        byId("chat-continue").focus();
        return;
      }

      chat.mode = "open";
      renderMessages([]);
      setSubtitle(`新对话 · ${chat.displayName}`);
      renderTargets();
      applyMode();
      if (viewGate.current(token) && !chat.closing) {
        byId("chat-input").focus();
      }
    }

    function continueChat() {
      if (chat.mode !== "readonly" || chat.closing) {
        return;
      }
      viewGate.invalidateView();
      chat.mode = "open";
      chat.conversationId = null;
      chat.requestId = null;
      chat.conversations = [];
      setMemoryStatus(0);
      byId("chat-history-select").replaceChildren();
      byId("chat-history").replaceChildren();
      byId("chat-input").value = "";
      showChatError(null);
      setStatus("");
      setSubtitle(`新对话 · ${chat.displayName}`);
      renderHeader();
      applyMode();
      byId("chat-input").focus();
    }

    async function refreshConversation(token) {
      if (!chat.conversationId || !viewGate.current(token) || chat.closing) {
        return;
      }
      const conversationId = chat.conversationId;
      const result = await callApi("getChatConversation", chat.characterId, conversationId);
      if (!viewGate.current(token) || chat.closing || chat.conversationId !== conversationId) {
        return;
      }
      if (!result.ok) {
        showChatError(result.error);
        return;
      }
      renderMessages(result.messages);
      applyMode();
    }

    async function handleResult(result, token, sentText, requestId) {
      if (!viewGate.current(token) || chat.closing) {
        return;
      }
      if (!result) {
        chat.mode = "open";
        chat.requestId = null;
        setMemoryStatus(0);
        showChatError({ code: "EMPTY_RESULT", message: "聊天服务没有返回结果。" });
        applyMode();
        return;
      }
      if (result.conversationId) {
        chat.conversationId = result.conversationId;
      }
      if (result.status === "completed") {
        chat.mode = "open";
        chat.requestId = null;
        byId("chat-input").value = "";
        setStatus("");
        setSubtitle(`对话中 · ${chat.displayName}`);
        setMemoryStatus(result.memoryApplied);
        applyMode();
        await refreshConversation(token);
        if (!viewGate.current(token) || chat.closing) {
          return;
        }
        byId("chat-input").focus();
        return;
      }
      if (result.status === "failed") {
        chat.mode = "failed";
        chat.requestId = requestId;
        byId("chat-input").value = sentText;
        setMemoryStatus(0);
        setStatus("发送失败，输入已保留", "error");
        setSubtitle("发送失败 · 可显式重试");
        applyMode();
        await refreshConversation(token);
        return;
      }
      if (result.status === "cancelled" || result.status === "stale") {
        chat.mode = "open";
        chat.requestId = null;
        byId("chat-input").value = sentText;
        setMemoryStatus(0);
        if (result.status === "cancelled") {
          setStatus("已取消");
          setSubtitle(`已取消 · ${chat.displayName}`);
        } else {
          setStatus("记忆已更新，旧回复没有显示", "error");
          setSubtitle("旧回复已失效");
        }
        applyMode();
        await refreshConversation(token);
        return;
      }
      chat.mode = "open";
      chat.requestId = null;
      setMemoryStatus(0);
      setStatus("请求仍在处理中，请稍候");
      applyMode();
    }

    async function sendMessage() {
      if (chat.mode !== "open" || chat.closing) {
        return;
      }
      const text = byId("chat-input").value.trim();
      if (!text) {
        byId("chat-input").focus();
        return;
      }
      const requestId = newRequestId();
      const token = viewGate.snapshot();
      chat.mode = "waiting";
      chat.requestId = requestId;
      showChatError(null);
      setMemoryStatus(0);
      setStatus("等待回复…");
      setSubtitle(`等待${chat.displayName}回复…`);
      applyMode();
      const result = await callApi("sendChatMessage", {
        characterId: chat.characterId,
        text,
        requestId,
      });
      if (!viewGate.current(token) || chat.closing) {
        return;
      }
      if (!result.ok) {
        chat.mode = "open";
        chat.requestId = null;
        showChatError(result.error);
        setStatus("");
        applyMode();
        return;
      }
      await handleResult(result.result, token, text, requestId);
    }

    async function retryMessage() {
      if (chat.mode !== "failed" || !chat.requestId || chat.closing) {
        return;
      }
      const requestId = chat.requestId;
      const text = byId("chat-input").value;
      const token = viewGate.snapshot();
      chat.mode = "waiting";
      showChatError(null);
      setMemoryStatus(0);
      setStatus("正在重试…");
      setSubtitle(`等待${chat.displayName}回复…`);
      applyMode();
      const result = await callApi("retryChatMessage", {
        characterId: chat.characterId,
        requestId,
      });
      if (!viewGate.current(token) || chat.closing) {
        return;
      }
      if (!result.ok) {
        chat.mode = "failed";
        chat.requestId = requestId;
        showChatError(result.error);
        setStatus("重试失败，输入已保留", "error");
        applyMode();
        return;
      }
      await handleResult(result.result, token, text, requestId);
    }

    async function cancelMessage() {
      if (chat.mode !== "waiting" || !chat.requestId || chat.closing) {
        return;
      }
      const token = viewGate.snapshot();
      byId("chat-cancel").disabled = true;
      setStatus("正在取消…");
      const result = await callApi("cancelChatMessage", {
        characterId: chat.characterId,
        requestId: chat.requestId,
      });
      if (!viewGate.current(token) || chat.closing) {
        return;
      }
      byId("chat-cancel").disabled = false;
      if (!result.ok) {
        showChatError(result.error);
      }
    }

    function resetState() {
      viewGate.reset();
      chat.open = false;
      chat.characterId = null;
      chat.displayName = null;
      chat.conversationId = null;
      chat.requestId = null;
      chat.mode = "closed";
      chat.conversations = [];
      chat.closing = false;
      chat.trigger = null;
      const panel = byId("chat-panel");
      if (!panel) {
        return;
      }
      panel.hidden = true;
      setMemoryStatus(0);
      byId("chat-history").replaceChildren();
      byId("chat-history-select").replaceChildren();
      byId("chat-input").value = "";
      byId("chat-input").disabled = false;
      byId("chat-close").disabled = false;
      byId("chat-error").hidden = true;
      byId("chat-error").textContent = "";
      byId("chat-retry").hidden = true;
      byId("chat-cancel").hidden = true;
      byId("chat-cancel").disabled = false;
      applyMode();
    }

    function focusTrigger(trigger, characterId) {
      if (trigger?.isConnected) {
        trigger.focus();
        return;
      }
      const match = Array.from(
        document.querySelectorAll('button[data-action="chat"]'),
      ).find((button) => button.dataset.characterId === characterId);
      if (match) {
        match.focus();
        return;
      }
      const current = byId("chat-current");
      if (!current.disabled) {
        current.focus();
        return;
      }
      byId("chat-start").focus();
    }

    async function requestMainClose(progressText = "正在关闭…") {
      if (!chat.open || chat.closing) {
        return { ok: false, superseded: true };
      }
      const token = viewGate.snapshot();
      chat.closing = true;
      setStatus(progressText);
      applyMode();
      const result = await callApi("closeChat");
      if (!viewGate.current(token) || !chat.open) {
        chat.closing = false;
        return { ok: false, superseded: true };
      }
      chat.closing = false;
      if (!result.ok) {
        showChatError(result.error);
        setStatus("关闭失败，请重试", "error");
        applyMode();
        return { ok: false, superseded: false };
      }
      return { ok: true };
    }

    async function closePanel({ notifyMain = true, restoreFocus = true } = {}) {
      if (!chat.open || chat.closing) {
        return;
      }
      const trigger = chat.trigger;
      const characterId = chat.characterId;
      if (!notifyMain) {
        resetState();
        if (restoreFocus) {
          focusTrigger(trigger, characterId);
        }
        return;
      }
      const closed = await requestMainClose();
      if (!closed.ok) {
        return;
      }
      resetState();
      if (restoreFocus) {
        focusTrigger(trigger, characterId);
      }
    }

    function handleExternalClosed() {
      resetState();
      setLaunchStatus("");
    }

    function renderLaunch(companion) {
      const characters = companion?.characters ?? [];
      const select = byId("chat-character");
      const previous = select.value;
      select.replaceChildren(
        ...characters.map((character) => {
          const option = document.createElement("option");
          option.value = character.characterId;
          option.textContent = character.displayName;
          return option;
        }),
      );
      const selectedId =
        previous ||
        companion?.current?.characterId ||
        characters[0]?.characterId ||
        "";
      if (characters.some((character) => character.characterId === selectedId)) {
        select.value = selectedId;
      }
      byId("chat-start").disabled = characters.length === 0;
      const current = companion?.current;
      byId("chat-current").disabled = !current;
      byId("chat-current").textContent = current
        ? `和${current.displayName}聊一会儿`
        : "和当前角色聊一会儿";
      byId("chat-current-label").textContent = current
        ? `当前：${current.displayName}`
        : "当前没有同屏角色";
      if (chat.open) {
        renderTargets();
      }
    }

    function openFor(characterId, trigger, options) {
      return openChatFor(characterId, trigger, options);
    }

    function bindPanelEvents() {
      byId("chat-close").addEventListener("click", () => closePanel());
      byId("chat-continue").addEventListener("click", continueChat);
      byId("chat-target-select").addEventListener("change", () => {
        const nextId = byId("chat-target-select").value;
        if (nextId && nextId !== chat.characterId) {
          openChatFor(nextId, null, { keepTrigger: true });
        }
      });
      byId("chat-history-select").addEventListener("change", () => {
        if (chat.mode === "readonly" && !chat.closing) {
          const token = viewGate.beginHistory();
          loadArchivedConversation(byId("chat-history-select").value, token);
        }
      });
      byId("chat-form").addEventListener("submit", (event) => {
        event.preventDefault();
        sendMessage();
      });
      byId("chat-cancel").addEventListener("click", cancelMessage);
      byId("chat-retry").addEventListener("click", retryMessage);
    }

    function ensurePanel() {
      if (panelBound) {
        return;
      }
      const holder = document.createElement("div");
      holder.innerHTML = PANEL_HTML;
      document.body.append(holder.firstElementChild);
      bindPanelEvents();
      panelBound = true;
    }

    byId("chat-current").addEventListener("click", () => {
      const current = getSnapshot()?.companionship?.current;
      if (current) {
        openChatFor(current.characterId, byId("chat-current"));
      }
    });
    byId("chat-start").addEventListener("click", () => {
      openChatFor(byId("chat-character").value, byId("chat-start"));
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && chat.open) {
        event.preventDefault();
        closePanel();
      }
    });
    if (api && typeof api.onChatClosed === "function") {
      api.onChatClosed(() => handleExternalClosed());
    }

    return { renderLaunch, openFor };
  }

  window.createChatPanel = createChatPanel;
})();
