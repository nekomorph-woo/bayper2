/* S03c 本地记忆面板：按已结识角色查看有效记忆，显式纠正或删除。
   只通过 preload 的具名接口读写；不接触文件、数据库、通用 SQL 或来源控制。 */
(function () {
  "use strict";

  function createMemoryPanel({ callApi, showAlert, getSnapshot }) {
    const byId = (id) => document.getElementById(id);
    const PANEL_HTML = `
      <div id="memory-overlay" class="memory-overlay" hidden>
        <section class="memory-dialog" role="dialog" aria-modal="true" aria-labelledby="memory-title">
          <header class="memory-head">
            <div>
              <p class="eyebrow">本地记忆</p>
              <h2 id="memory-title">记忆</h2>
              <p id="memory-subtitle" class="status-text">只显示当前有效的记忆，可纠正或删除。</p>
            </div>
            <button id="memory-close" class="btn btn-ghost btn-small" type="button" aria-label="关闭记忆">
              关闭
            </button>
          </header>
          <div class="memory-target">
            <label for="memory-character">角色</label>
            <select id="memory-character" aria-label="选择记忆所属角色"></select>
          </div>
          <p id="memory-notice" class="status-text" role="status" aria-live="polite"></p>
          <div id="memory-list" class="memory-list" role="list" aria-label="有效记忆"></div>
          <p id="memory-empty" class="memory-empty" hidden>这位角色目前没有可查看的有效记忆。</p>
          <div class="memory-pager">
            <button id="memory-prev" class="btn btn-ghost btn-small" type="button">上一页</button>
            <span id="memory-page-label" class="status-text"></span>
            <button id="memory-next" class="btn btn-ghost btn-small" type="button">下一页</button>
          </div>
          <section id="memory-editor" class="memory-editor" hidden>
            <div class="memory-editor-head">
              <h3 id="memory-editor-title">编辑这条记忆</h3>
              <p id="memory-editor-meta" class="status-text"></p>
            </div>
            <textarea id="memory-body" rows="3" maxlength="2000" aria-label="记忆正文"></textarea>
            <p class="memory-scope-note">
              保存会更新所有知道这条记忆的角色；删除默认会移除所有知道这条记忆的角色及派生记录。
            </p>
            <div class="memory-scope" role="radiogroup" aria-label="删除范围">
              <label><input type="radio" name="memory-scope" value="all" checked /> 所有知道的角色</label>
              <label><input type="radio" name="memory-scope" value="self" /> 仅这位</label>
            </div>
            <div class="memory-actions">
              <button id="memory-save" class="btn btn-primary btn-small" type="button">保存修改</button>
              <button id="memory-delete" class="btn btn-ghost btn-small" type="button">删除记忆</button>
            </div>
            <div id="memory-error" class="alert" role="alert" hidden></div>
          </section>
        </section>
      </div>
    `;
    const KIND_LABELS = { identity: "身份", preference: "偏好", experience: "经历", detail: "细节" };
    let panelBound = false;
    const state = {
      open: false,
      trigger: null,
      characterId: null,
      page: 0,
      hasMore: false,
      entries: [],
      selected: null,
      stale: false,
      busy: false,
      loading: false,
      loadSeq: 0,
      openEpoch: 0,
    };

    function characters() {
      return getSnapshot()?.companionship?.characters ?? [];
    }

    function characterName(characterId) {
      return (
        characters().find((character) => character.characterId === characterId)?.displayName ??
        "另一位角色"
      );
    }

    function sourceLabel(entry) {
      if (entry.derived || entry.originCharacterId !== state.characterId) {
        return `听${characterName(entry.originCharacterId)}说过`;
      }
      return entry.trust === "inferred" ? "初步了解" : "本人直接告知";
    }

    function setNotice(text, stateName = "") {
      const notice = byId("memory-notice");
      notice.textContent = text;
      notice.dataset.state = stateName;
    }

    function clearActionError() {
      showAlert(byId("memory-error"), null);
    }

    function updateControls() {
      const blocked = state.busy || state.loading;
      byId("memory-character").disabled = blocked || characters().length === 0;
      byId("memory-prev").disabled = blocked || state.page <= 0;
      byId("memory-next").disabled = blocked || !state.hasMore;
      byId("memory-save").disabled = blocked || !state.selected || state.stale;
      byId("memory-delete").disabled = blocked || !state.selected || state.stale;
      byId("memory-body").disabled = blocked || !state.selected || state.stale;
    }

    function renderCharacters() {
      const list = characters();
      const select = byId("memory-character");
      select.replaceChildren(
        ...list.map((character) => {
          const option = document.createElement("option");
          option.value = character.characterId;
          option.textContent = character.displayName;
          return option;
        }),
      );
      if (!list.some((character) => character.characterId === state.characterId)) {
        state.characterId =
          getSnapshot()?.companionship?.current?.characterId ?? list[0]?.characterId ?? null;
      }
      select.value = state.characterId ?? "";
      if (list.length === 0) {
        byId("memory-subtitle").textContent = "还没有可查看的已结识角色。";
      }
    }

    function renderList() {
      const list = byId("memory-list");
      list.replaceChildren(
        ...state.entries.map((entry) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "memory-entry";
          button.dataset.id = entry.id;
          if (state.selected?.id === entry.id) {
            button.classList.add("is-selected");
          }
          button.disabled = state.busy || state.loading;
          const body = document.createElement("span");
          body.className = "memory-entry-body";
          body.textContent = entry.body;
          const meta = document.createElement("span");
          meta.className = "memory-entry-meta";
          meta.textContent = `${KIND_LABELS[entry.kind] ?? entry.kind} · ${sourceLabel(entry)}`;
          button.append(body, meta);
          button.addEventListener("click", () => selectEntry(entry.id));
          return button;
        }),
      );
      byId("memory-empty").textContent =
        characters().length === 0
          ? "还没有可查看的已结识角色。"
          : "这位角色目前没有可查看的有效记忆。";
      byId("memory-empty").hidden = state.entries.length > 0;
      byId("memory-list").hidden = state.entries.length === 0;
      byId("memory-page-label").textContent = `第 ${state.page + 1} 页`;
    }

    function renderEditor() {
      const visible = Boolean(state.selected || state.stale);
      byId("memory-editor").hidden = !visible;
      updateControls();
      if (!visible) {
        return;
      }
      if (state.stale) {
        byId("memory-editor-title").textContent = "记忆已变化";
        byId("memory-editor-meta").textContent = "请从上方重新选择条目后再编辑。";
      } else {
        byId("memory-editor-title").textContent = "编辑这条记忆";
        byId("memory-editor-meta").textContent = `${KIND_LABELS[state.selected.kind] ?? state.selected.kind} · ${sourceLabel(state.selected)}`;
      }
    }

    function selectEntry(entryId) {
      const entry = state.entries.find((item) => item.id === entryId);
      if (!entry || state.busy || state.loading) {
        return;
      }
      state.selected = entry;
      state.stale = false;
      byId("memory-body").value = entry.body;
      clearActionError();
      setNotice("");
      renderList();
      renderEditor();
      byId("memory-body").focus();
    }

    async function loadPage(page, { keepEditor = false } = {}) {
      if (!state.characterId) {
        return;
      }
      const seq = ++state.loadSeq;
      state.loading = true;
      setNotice("正在读取…", "loading");
      updateControls();
      const result = await callApi("listMemories", {
        characterId: state.characterId,
        page,
      });
      if (seq !== state.loadSeq || !state.open) {
        return;
      }
      state.loading = false;
      if (!result.ok) {
        setNotice(result.error.message || "读取记忆失败。", "error");
        updateControls();
        return;
      }
      state.page = result.page;
      state.hasMore = result.hasMore;
      state.entries = result.entries;
      state.selected = null;
      if (!keepEditor) {
        state.stale = false;
        byId("memory-body").value = "";
      }
      clearActionError();
      setNotice("");
      renderList();
      renderEditor();
    }

    function changeCharacter() {
      state.characterId = byId("memory-character").value;
      state.page = 0;
      state.hasMore = false;
      state.entries = [];
      state.selected = null;
      state.stale = false;
      state.busy = false;
      byId("memory-body").value = "";
      clearActionError();
      renderList();
      renderEditor();
      loadPage(0);
    }

    function changePage(delta) {
      if (state.busy || state.loading) {
        return;
      }
      const next = state.page + delta;
      if (next < 0 || (delta > 0 && !state.hasMore)) {
        return;
      }
      loadPage(next);
    }

    async function applyChange(label, request, successText) {
      const openEpoch = state.openEpoch;
      const characterId = state.characterId;
      const samePanel = () =>
        state.open && openEpoch === state.openEpoch && state.characterId === characterId;
      state.busy = true;
      clearActionError();
      setNotice(`正在${label}…`);
      updateControls();
      const result = await request();
      if (!samePanel()) {
        return;
      }
      state.busy = false;
      if (!result.ok) {
        if (result.error?.code === "MEMORY_CHANGED" || result.error?.code === "ENTRY_NOT_FOUND") {
          state.stale = true;
          await loadPage(0, { keepEditor: true });
          if (!samePanel()) {
            return;
          }
          state.stale = true;
          renderEditor();
          showAlert(byId("memory-error"), result.error);
          setNotice("记忆已变化，请重新选择条目后提交。", "error");
        } else {
          showAlert(byId("memory-error"), result.error);
          setNotice(`${label}失败，输入已保留。`, "error");
          updateControls();
        }
        return;
      }
      await loadPage(0);
      if (!samePanel()) {
        return;
      }
      setNotice(successText);
    }

    async function submitCorrect() {
      if (!state.selected || state.busy || state.stale) {
        return;
      }
      const entry = state.selected;
      const body = byId("memory-body").value.trim();
      if (!body) {
        showAlert(byId("memory-error"), {
          code: "INVALID_INPUT",
          message: "记忆正文不能为空。",
        });
        return;
      }
      await applyChange(
        "保存",
        () =>
          callApi("correctMemory", {
            characterId: state.characterId,
            entryId: entry.id,
            expectedVersion: entry.version,
            body,
          }),
        "已保存修改。",
      );
    }

    async function submitDelete() {
      if (!state.selected || state.busy || state.stale) {
        return;
      }
      const entry = state.selected;
      const scope =
        document.querySelector('input[name="memory-scope"]:checked')?.value ?? "all";
      await applyChange(
        "删除",
        () =>
          callApi("forgetMemory", {
            characterId: state.characterId,
            entryId: entry.id,
            expectedVersion: entry.version,
            scope,
          }),
        "已删除。",
      );
    }

    function handleMemoryChanged(payload) {
      if (
        !state.open ||
        state.busy ||
        state.loading ||
        !Array.isArray(payload?.affectedCharacters) ||
        !payload.affectedCharacters.includes(state.characterId)
      ) {
        return;
      }
      loadPage(0);
    }

    function open(trigger) {
      ensurePanel();
      if (state.open) {
        return;
      }
      state.open = true;
      state.openEpoch += 1;
      state.trigger = trigger || document.activeElement;
      state.page = 0;
      state.hasMore = false;
      state.entries = [];
      state.selected = null;
      state.stale = false;
      state.busy = false;
      state.loading = false;
      byId("memory-body").value = "";
      clearActionError();
      setNotice("");
      renderCharacters();
      renderList();
      renderEditor();
      byId("memory-overlay").hidden = false;
      byId("memory-close").focus();
      loadPage(0);
    }

    function close() {
      if (!state.open) {
        return;
      }
      state.open = false;
      state.loadSeq += 1;
      state.loading = false;
      state.busy = false;
      byId("memory-overlay").hidden = true;
      state.selected = null;
      state.stale = false;
      byId("memory-body").value = "";
      const trigger = state.trigger;
      state.trigger = null;
      if (trigger?.isConnected) {
        trigger.focus();
      } else {
        byId("memory-open")?.focus();
      }
    }

    function bindPanelEvents() {
      byId("memory-close").addEventListener("click", close);
      byId("memory-character").addEventListener("change", changeCharacter);
      byId("memory-prev").addEventListener("click", () => changePage(-1));
      byId("memory-next").addEventListener("click", () => changePage(1));
      byId("memory-save").addEventListener("click", submitCorrect);
      byId("memory-delete").addEventListener("click", submitDelete);
      byId("memory-overlay").addEventListener("click", (event) => {
        if (event.target === byId("memory-overlay")) {
          close();
        }
      });
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

    byId("memory-open")?.addEventListener("click", () => open(byId("memory-open")));
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape" || !state.open) {
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
      },
      true,
    );

    return { open, close, handleMemoryChanged };
  }

  window.createMemoryPanel = createMemoryPanel;
})();
