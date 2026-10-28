/* S06l 角色概览衣装选择。只通过 preload 具名接口读取/保存意图；
   点击不会宣称换装完成，待穿由主进程在安全节点提交后经快照刷新。 */
(function () {
  "use strict";

  const OUTFIT_NAMES = Object.freeze({
    base: "原本的衣装",
    "rin.warm-tea": "温茶围裙",
  });

  // 角色页只读固定白名单预览；不把任意文件路径交给 renderer 选择。
  const OUTFIT_PREVIEWS = Object.freeze({
    "rin.warm-tea":
      "../../assets/characters/rin/outfits/warm-tea/animations/idle-pixel-v2/frame-00.png",
  });

  function createOutfitPanel({ api, getSnapshot, isActive = () => true }) {
    const byId = (id) => document.getElementById(id);
    const state = {
      characterId: null,
      data: null,
      revision: -1,
      seq: 0,
      busy: false,
      notice: "",
      error: null,
    };

    function nameOf(outfitId) {
      return OUTFIT_NAMES[outfitId] ?? "这套衣装";
    }

    /* 大图只跟随“已穿”而非待穿；衣装不可用时明确隐藏，不冒充基础图。 */
    function applyPreview() {
      const image = byId("character-image");
      const note = byId("character-preview-unavailable");
      if (!image || !note) return;
      if (!state.characterId) {
        note.hidden = true;
        image.hidden = false;
        return;
      }
      const character = getSnapshot()?.companionship?.characters?.find(
        (item) => item.characterId === state.characterId,
      );
      const worn = state.data?.worn;
      if (!worn || worn.outfitId === "base") {
        note.hidden = true;
        image.hidden = false;
        if (character?.image) image.src = character.image;
        image.alt = character ? `${character.displayName}（开发候选角色图）` : "";
        return;
      }
      if (worn.available !== true) {
        image.hidden = true;
        image.removeAttribute("src");
        note.hidden = false;
        note.textContent = "这套衣装当前不可用";
        return;
      }
      const preview = OUTFIT_PREVIEWS[worn.outfitId];
      if (!preview) {
        image.hidden = true;
        image.removeAttribute("src");
        note.hidden = false;
        note.textContent = "这套衣装的预览暂时不可用";
        return;
      }
      note.hidden = true;
      image.hidden = false;
      image.src = preview;
      image.alt = `${character?.displayName ?? "角色"}（${nameOf(worn.outfitId)}）`;
    }

    async function call(method, ...args) {
      if (!api || typeof api[method] !== "function") {
        return {
          ok: false,
          error: { code: "IPC_ERROR", message: "衣装选择暂时不可用。" },
        };
      }
      try {
        return await api[method](...args);
      } catch {
        return {
          ok: false,
          error: { code: "IPC_ERROR", message: "衣装通信失败，请重试。" },
        };
      }
    }

    function runtimeFor(snapshot) {
      const runtime = snapshot?.outfit?.runtime;
      return runtime?.characterId === state.characterId ? runtime : null;
    }

    function active() {
      try {
        return isActive() !== false;
      } catch {
        return false;
      }
    }

    function statusText(snapshot) {
      if (state.error) return state.error.message;
      const runtime = runtimeFor(snapshot);
      if (runtime?.message) return runtime.message;
      return state.notice;
    }

    function render(snapshot = getSnapshot()) {
      const block = byId("outfit-block");
      if (!block) return;
      block.hidden = !state.characterId;
      applyPreview();
      const current = byId("outfit-current");
      const options = byId("outfit-options");
      const status = byId("outfit-status");
      if (!state.characterId) {
        current.textContent = "";
        options.replaceChildren();
        status.textContent = "";
        return;
      }
      const data = state.data;
      if (!data) {
        current.textContent = state.error ? "衣装暂时不可用" : "正在读取衣装…";
        options.replaceChildren();
        status.textContent = statusText(snapshot);
        return;
      }
      current.textContent = data.worn.available === false
        ? `已穿：${nameOf(data.worn.outfitId)}（不可用）`
        : `已穿：${nameOf(data.worn.outfitId)}`;

      const entries = data.outfits.filter(
        (item) =>
          item.outfitId === "base"
          || item.owned === true
          || item.outfitId === data.worn.outfitId
          || item.outfitId === data.pending?.outfitId,
      );
      options.replaceChildren(
        ...entries.map((item) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "outfit-option";
          button.dataset.outfitId = item.outfitId;
          const worn = item.outfitId === data.worn.outfitId;
          const pending = item.outfitId === data.pending?.outfitId;
          if (worn) button.classList.add("is-worn");
          if (pending) button.classList.add("is-pending");
          button.disabled = state.busy || item.available !== true;
          button.textContent = nameOf(item.outfitId);
          const suffix = document.createElement("span");
          suffix.className = "outfit-option-state";
          suffix.textContent = worn
            ? "已穿"
            : pending
              ? "待穿"
              : item.available !== true
                ? "不可用"
                : "";
          button.append(suffix);
          button.addEventListener("click", () => choose(item.outfitId));
          return button;
        }),
      );

      const pendingText = data.pending
        ? data.pending.available !== true
          ? `待穿：${nameOf(data.pending.outfitId)}（当前不可用）`
          : `待穿：${nameOf(data.pending.outfitId)}；会在安全节点换上。`
        : "";
      status.textContent = [statusText(snapshot), pendingText]
        .filter(Boolean)
        .join(" ");
    }

    async function load(characterId = state.characterId) {
      if (!characterId) return;
      const seq = ++state.seq;
      state.error = null;
      state.revision = getSnapshot()?.outfit?.revision ?? state.revision;
      render();
      const result = await call("list", characterId);
      if (seq !== state.seq || characterId !== state.characterId) return;
      if (!result.ok) {
        state.error = result.error;
        render();
        return;
      }
      state.data = result.state;
      state.revision = getSnapshot()?.outfit?.revision ?? state.revision;
      state.notice = "";
      render();
    }

    async function choose(outfitId) {
      if (state.busy || !state.characterId) return;
      const characterId = state.characterId;
      const seq = state.seq;
      state.busy = true;
      state.error = null;
      state.notice = `正在保存${nameOf(outfitId)}的选择…`;
      render();
      const result = await call("request", characterId, outfitId);
      state.busy = false;
      if (seq !== state.seq || characterId !== state.characterId) return;
      if (!result.ok) {
        state.error = result.error;
        state.notice = "";
        render(result.snapshot);
        return;
      }
      state.data = result.state;
      state.revision = result.snapshot?.outfit?.revision ?? state.revision;
      state.notice = state.data.pending
        ? `已保存待穿：${nameOf(outfitId)}。会在安全节点换上。`
        : `当前穿着${nameOf(state.data.worn.outfitId)}。`;
      render(result.snapshot);
    }

    function setCharacter(characterId) {
      if (!characterId) {
        deactivate();
        return;
      }
      if (!active()) {
        if (characterId !== state.characterId) {
          state.characterId = characterId;
          state.data = null;
          state.revision = -1;
          state.seq += 1;
        }
        return;
      }
      if (characterId !== state.characterId) {
        state.characterId = characterId;
        state.data = null;
        state.notice = "";
        state.error = null;
        state.busy = false;
        state.seq += 1;
        state.revision = -1;
        render();
        load(characterId);
        return;
      }
      const revision = getSnapshot()?.outfit?.revision ?? -1;
      if (state.revision !== revision) {
        load(characterId);
      } else {
        render();
      }
    }

    function handleSnapshot(snapshot) {
      if (!state.characterId || !snapshot || !active()) return;
      const revision = snapshot?.outfit?.revision ?? -1;
      if (revision !== state.revision) {
        load(state.characterId);
      }
    }

    function deactivate() {
      state.seq += 1;
      state.characterId = null;
      state.data = null;
      state.revision = -1;
      state.busy = false;
      state.notice = "";
      state.error = null;
      render();
    }

    return { setCharacter, handleSnapshot, deactivate };
  }

  window.createOutfitPanel = createOutfitPanel;
})();
