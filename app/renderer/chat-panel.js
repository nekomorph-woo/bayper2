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

        <p id="chat-history-origin" class="chat-history-origin" role="status" aria-live="polite" hidden></p>
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
      displaySeq: 0,
      displayCutoffSeq: 0,
      lastMessageSeq: 0,
      verificationSettledRequestId: null,
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

    function showHistoryNote(text) {
      const note = byId("chat-history-origin");
      note.textContent = text;
      note.hidden = false;
    }

    function hideHistoryNote() {
      const note = byId("chat-history-origin");
      if (note) {
        note.hidden = true;
        note.textContent = "";
      }
    }

    /* 记忆变更后收起当前旧显示，但保留历史选择能力；必须重新选一次才算显式重看。 */
    function prepareHistoryReView() {
      const select = byId("chat-history-select");
      if (select.options[0]?.value !== "") {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "选择一条历史重新查看（原文）";
        select.prepend(option);
      }
      select.value = "";
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
      byId("chat-empty").hidden =
        mode === "readonly" || hasMessages || chat.displayCutoffSeq > 0;
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

    function maxMessageSeq(messages) {
      return messages.reduce(
        (max, message) => (Number.isFinite(message.seq) ? Math.max(max, message.seq) : max),
        0,
      );
    }

    function visibleMessages(messages) {
      return chat.displayCutoffSeq > 0
        ? messages.filter((message) => (message.seq ?? 0) > chat.displayCutoffSeq)
        : messages;
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
      byId("chat-empty").hidden =
        messages.length > 0 || chat.mode === "readonly" || chat.displayCutoffSeq > 0;
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
      const displaySeq = chat.displaySeq;
      const result = await callApi("getChatConversation", chat.characterId, conversationId);
      if (!viewGate.current(token) || chat.closing || displaySeq !== chat.displaySeq) {
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
      chat.lastMessageSeq = maxMessageSeq(result.messages);
      chat.displayCutoffSeq = 0;
      byId("chat-history-select").value = conversationId;
      showHistoryNote("历史原文 · 仅作记录，不代表当前有效记忆。");
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
      const displaySeq = chat.displaySeq;
      chat.open = true;
      chat.characterId = characterId;
      chat.displayName = character?.displayName ?? characterId;
      chat.conversationId = null;
      chat.requestId = null;
      chat.mode = "loading";
      chat.conversations = [];
      chat.displayCutoffSeq = 0;
      chat.lastMessageSeq = 0;
      setMemoryStatus(0);
      hideHistoryNote();
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
        focusTrigger(chat.trigger, characterId);
        return;
      }

      chat.displayName = result.displayName || chat.displayName;
      chat.conversations = Array.isArray(result.history) ? result.history : [];
      renderHeader();
      if (displaySeq !== chat.displaySeq) {
        chat.mode = chat.conversations.length > 0 ? "readonly" : "open";
        if (chat.mode === "readonly") {
          renderHistoryOptions(chat.conversations);
          prepareHistoryReView();
          showHistoryNote("记忆已更新，当前旧对话显示已收起；请选择一条历史重新查看原文。");
        } else {
          renderMessages([]);
          setSubtitle(`新对话 · ${chat.displayName}`);
          showHistoryNote("记忆已更新，旧对话显示已收起。");
        }
        byId("chat-history").replaceChildren();
        byId("chat-empty").hidden = true;
        renderHeader();
        if (chat.mode === "open") {
          setSubtitle(`新对话 · ${chat.displayName}`);
        }
        applyMode();
        return;
      }
      if (chat.conversations.length > 0) {
        renderHistoryOptions(chat.conversations);
        const latest = chat.conversations[0];
        byId("chat-history-select").value = latest.id;
        await loadArchivedConversation(latest.id, token);
        if (!viewGate.current(token) || chat.closing) {
          return;
        }
        if (displaySeq !== chat.displaySeq) {
          chat.mode = "readonly";
          prepareHistoryReView();
          showHistoryNote("记忆已更新，当前旧对话显示已收起；请选择一条历史重新查看原文。");
          byId("chat-history").replaceChildren();
          byId("chat-empty").hidden = true;
          renderHeader();
          applyMode();
          return;
        }
        if (chat.mode !== "readonly") {
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
      chat.displayCutoffSeq = 0;
      chat.lastMessageSeq = 0;
      setMemoryStatus(0);
      hideHistoryNote();
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
      const displaySeq = chat.displaySeq;
      const result = await callApi("getChatConversation", chat.characterId, conversationId);
      if (
        !viewGate.current(token) ||
        chat.closing ||
        displaySeq !== chat.displaySeq ||
        chat.conversationId !== conversationId
      ) {
        return;
      }
      if (!result.ok) {
        showChatError(result.error);
        return;
      }
      chat.lastMessageSeq = maxMessageSeq(result.messages);
      renderMessages(visibleMessages(result.messages));
      applyMode();
    }

    async function handleResult(result, token, sentText, requestId, displaySeq) {
      if (!viewGate.current(token) || chat.closing) {
        return;
      }
      const memoryChanged = displaySeq !== chat.displaySeq;
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
        if (
          result.verificationStatus === "pending" &&
          chat.verificationSettledRequestId !== requestId
        ) {
          chat.mode = "waiting";
          chat.requestId = requestId;
          byId("chat-input").value = "";
          setMemoryStatus(result.memoryApplied);
          setStatus("已处理当前范围，正在核对其他相近内容…");
          setSubtitle(`核对中 · ${chat.displayName}`);
          applyMode();
          await refreshConversation(token);
          return;
        }
        chat.mode = "open";
        chat.requestId = null;
        if (memoryChanged) {
          byId("chat-input").value = sentText;
          setMemoryStatus(0);
          setStatus("记忆已更新，旧回复没有显示", "error");
          setSubtitle("旧回复已失效");
          applyMode();
          return;
        }
        byId("chat-input").value = "";
        setStatus("");
        setSubtitle(`对话中 · ${chat.displayName}`);
        setMemoryStatus(result.memoryApplied);
        applyMode();
        await refreshConversation(token);
        if (
          !viewGate.current(token) ||
          chat.closing ||
          displaySeq !== chat.displaySeq
        ) {
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
        if (!memoryChanged) {
          await refreshConversation(token);
        }
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
        if (!memoryChanged) {
          await refreshConversation(token);
        }
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
      const displaySeq = chat.displaySeq;
      chat.mode = "waiting";
      chat.requestId = requestId;
      chat.verificationSettledRequestId = null;
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
      await handleResult(result.result, token, text, requestId, displaySeq);
    }

    async function retryMessage() {
      if (chat.mode !== "failed" || !chat.requestId || chat.closing) {
        return;
      }
      const requestId = chat.requestId;
      const text = byId("chat-input").value;
      const token = viewGate.snapshot();
      const displaySeq = chat.displaySeq;
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
      await handleResult(result.result, token, text, requestId, displaySeq);
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
      chat.displaySeq += 1;
      chat.open = false;
      chat.characterId = null;
      chat.displayName = null;
      chat.conversationId = null;
      chat.requestId = null;
      chat.verificationSettledRequestId = null;
      chat.mode = "closed";
      chat.conversations = [];
      chat.closing = false;
      chat.displayCutoffSeq = 0;
      chat.lastMessageSeq = 0;
      chat.trigger = null;
      const panel = byId("chat-panel");
      if (!panel) {
        return;
      }
      panel.hidden = true;
      setMemoryStatus(0);
      hideHistoryNote();
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

    function isVisible(element) {
      return Boolean(
        element &&
          element.isConnected &&
          !element.closest("[hidden]") &&
          element.getClientRects().length > 0,
      );
    }

    /* 关闭聊天后回到真实发起按钮；发起页已隐藏时落到当前导航入口，不聚焦隐藏元素。 */
    function focusTrigger(trigger, characterId) {
      if (isVisible(trigger)) {
        trigger.focus();
        return;
      }
      const match = Array.from(
        document.querySelectorAll('button[data-action="chat"]'),
      ).find((button) => isVisible(button) && button.dataset.characterId === characterId);
      if (match) {
        match.focus();
        return;
      }
      const current = byId("chat-current");
      if (isVisible(current) && !current.disabled) {
        current.focus();
        return;
      }
      const start = byId("chat-start");
      if (isVisible(start)) {
        start.focus();
        return;
      }
      const navCurrent = document.querySelector('#primary-nav [aria-current="page"]');
      if (isVisible(navCurrent)) {
        navCurrent.focus();
        return;
      }
      document.body.focus();
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
      if (select) {
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
      }
      const start = byId("chat-start");
      if (start) {
        start.disabled = characters.length === 0;
      }
      const current = companion?.current;
      byId("chat-current").disabled = !current;
      byId("chat-current").textContent = current
        ? `和${current.displayName}聊一会儿`
        : "和当前角色聊一会儿";
      const label = byId("chat-current-label");
      if (label) {
        label.textContent = current ? `当前：${current.displayName}` : "当前没有同屏角色";
      }
      if (chat.open) {
        renderTargets();
      }
    }

    function openFor(characterId, trigger, options) {
      return openChatFor(characterId, trigger, options);
    }

    /* 记忆只清理当前受影响的屏上旧显示；数据库原文与未发送草稿都不动。 */
    async function handleChatUpdated(payload) {
      if (!chat.open || chat.closing ||
        payload?.characterId !== chat.characterId ||
        payload?.conversationId !== chat.conversationId ||
        payload.requestId !== chat.requestId) {
        return;
      }
      chat.verificationSettledRequestId = payload.requestId;
      chat.mode = "open";
      chat.requestId = null;
      setMemoryStatus(0);
      if (payload.status === "completed") {
        setStatus("");
      } else {
        setStatus("本地更正已完成；其他相近内容未继续核对");
      }
      setSubtitle(`对话中 · ${chat.displayName}`);
      applyMode();
      const token = viewGate.snapshot();
      await refreshConversation(token);
      if (!viewGate.current(token) || chat.closing) {
        return;
      }
      byId("chat-input").focus();
    }

    function handleMemoryChanged(payload) {
      if (payload?.kind === "chat-updated") {
        void handleChatUpdated(payload).catch(() => {});
        return;
      }
      const affected = payload?.affectedCharacters;
      if (!chat.open || !Array.isArray(affected) || !affected.includes(chat.characterId)) {
        return;
      }
      chat.displaySeq += 1;
      chat.displayCutoffSeq = Math.max(chat.displayCutoffSeq, chat.lastMessageSeq);
      setMemoryStatus(0);
      byId("chat-history").replaceChildren();
      byId("chat-empty").hidden = true;
      if (chat.mode === "readonly" && chat.conversations.length > 0) {
        prepareHistoryReView();
        showHistoryNote("记忆已更新，当前旧对话显示已收起；历史原文仍保留，重新选择时会标明原文。");
      } else {
        showHistoryNote("记忆已更新，当前旧对话显示已收起；历史原文仍保留。");
      }
      if (chat.mode === "waiting") {
        setStatus("记忆已更新，等待的回复会按新理解核验", "error");
      }
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
        const conversationId = byId("chat-history-select").value;
        if (conversationId && chat.mode === "readonly" && !chat.closing) {
          const token = viewGate.beginHistory();
          loadArchivedConversation(conversationId, token);
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
    byId("chat-start")?.addEventListener("click", () => {
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

    return { renderLaunch, openFor, handleMemoryChanged };
  }

  window.createChatPanel = createChatPanel;
})();
