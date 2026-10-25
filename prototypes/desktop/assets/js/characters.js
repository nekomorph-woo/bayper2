/* 角色页：身份索引、概览、衣橱、记忆。
   记忆的纠正与删除都写入同一个状态，切换角色或刷新后读回一致结果。 */

(function () {
  const A = window.App;
  const DATA = A.data;
  const state = A.state;

  const TABS = [
    { id: "overview", label: "概览" },
    { id: "wardrobe", label: "衣橱" },
    { id: "memories", label: "记忆" },
  ];

  // 衣橱内容随角色走。素材只有一套，因此未解锁的服装用线稿封面，不伪造第二张立绘。
  const OUTFITS = {
    rin: [
      {
        id: "rin-daily",
        name: "日常女仆服",
        note: "她现在穿着的这一套。",
        worn: true,
      },
      {
        id: "rin-apron",
        name: "旧围裙",
        note: "挂在储物柜最里面，她说等秋天再穿。",
        locked: true,
        story: "linen-apron",
      },
    ],
  };

  let currentId = A.params.get("id");
  let tab = A.params.get("tab");
  let nickEditing = false;
  let nickMsg = "";
  let editingMemory = null;
  let editDraft = "";
  let memoryQuery = "";
  let memoryMsg = "";
  let focusAfter = "";

  if (!currentId || !A.character(currentId) || !state.acceptedIds.includes(currentId)) {
    currentId = state.fixedId;
  }
  if (!TABS.some((t) => t.id === tab)) tab = "overview";

  const charlistEl = document.getElementById("charlist");
  const detailEl = document.getElementById("detail");

  /* ---------- 数据 ---------- */

  function memoriesOf(id) {
    return (DATA.memories[id] || [])
      .filter((m) => !state.memoryHidden.includes(m.id))
      .filter((m) => !state.memoryHiddenKeys.includes(m.key))
      .map((m) => ({
        ...m,
        text: state.memoryEdits[m.key] || m.text,
        edited: Boolean(state.memoryEdits[m.key]),
      }));
  }

  // 同一 key 表示同一条理解。纠正只影响已经持有它的角色，不广播给不知道的人。
  function holdersOfKey(key) {
    return Object.keys(DATA.memories).filter((id) =>
      (DATA.memories[id] || []).some((m) => m.key === key)
    );
  }

  function outfitsOf(id) {
    if (OUTFITS[id]) return OUTFITS[id];
    return [
      {
        id: `${id}-daily`,
        name: "日常穿的那一套",
        note: "还没有更多服装。",
        worn: true,
      },
    ];
  }

  /* ---------- 渲染 ---------- */

  function renderList() {
    const items = A.acceptedIds()
      .map((id) => {
        const base = A.character(id);
        return `<a class="charlist__item" href="characters.html?id=${id}&tab=${tab}"
            aria-current="${id === currentId}" data-pick="${id}">
            ${A.avatar(id)}
            <span class="charlist__who">
              <span class="charlist__name">${A.escapeHtml(A.displayName(id))}</span>
              <span class="charlist__state">${A.statusLabel(id)}</span>
            </span>
          </a>`;
      })
      .join("");

    const pending = !state.acceptedIds.includes("aya")
      ? `<div class="charlist__pending">绫还没有来过小窝。
          <a href="stories.html?story=aya-letter">读她的邀请</a>
        </div>`
      : "";

    charlistEl.innerHTML = items + pending;
  }

  function renderOverview(id) {
    const base = A.character(id);
    const name = A.displayName(id);
    const paused =
      state.pausedExploration &&
      state.pausedExploration.id === id &&
      id !== state.desktopId
        ? `<p class="paused">探索已暂停（${state.pausedExploration.at}）。叫她回来之后，原来那条路线还留着。</p>`
        : "";

    const stage = base.img
      ? `<div class="overview__stage" data-shape="${base.shape}">
           <img src="${base.img}" alt="${A.escapeHtml(A.displayName(id))}，${
          base.shape === "full" ? "全身像" : "半身像"
        }">
         </div>`
      : `<div class="overview__stage overview__stage--none">原型暂未提供角色图</div>`;

    const nickBlock = nickEditing
      ? `<form class="nick__form" data-nick-form>
           <input class="input" name="nick" maxlength="12" value="${A.escapeHtml(
             state.nicknames[id] || ""
           )}" placeholder="${A.escapeHtml(base.name)}" aria-label="对${A.escapeHtml(name)}的称呼">
           <button class="btn btn--primary btn--sm" type="submit">保存</button>
           <button class="btn btn--ghost btn--sm" type="button" data-nick-cancel>取消</button>
         </form>
         <p class="field__hint">留空就恢复原名。称呼只保存在这台设备的原型数据里。</p>`
      : `<div class="nick">
           <span class="nick__value">${A.escapeHtml(name)}</span>
           <button class="btn btn--quiet btn--sm" type="button" data-nick-edit>改称呼</button>
         </div>`;

    return `
      <div class="overview">
        ${stage}
        <div>
          <p class="overview__intro">${A.escapeHtml(base.intro)}</p>
          ${paused}

          <div class="block">
            <p class="block__title">你怎么称呼她</p>
            <div class="block__body">${nickBlock}</div>
            ${nickMsg ? `<p class="nick__msg">${A.escapeHtml(nickMsg)}</p>` : ""}
          </div>

          <div class="block">
            <p class="block__title">关系状态</p>
            ${
              base.stats
                ? `<div class="stats block__body">
                     ${[
                       ["亲密", base.stats.intimacy.label, base.stats.intimacy.value],
                       ["精力", base.stats.energy.label, base.stats.energy.value],
                       ["心情", base.stats.mood.label, base.stats.mood.value > 0 ? `+${base.stats.mood.value}` : base.stats.mood.value],
                     ]
                       .map(
                         ([label, text, value]) => `<div class="stat">
                           <span class="stat__label">${label}</span>
                           <strong class="stat__text">${text}</strong>
                           <span class="stat__value">${value}</span>
                         </div>`
                       )
                       .join("")}
                   </div>`
                : `<p class="habit block__body">还没有一起待过，说不上关系状态。</p>`
            }
          </div>

          <div class="block">
            <p class="block__title">性格底色</p>
            <ul class="traits block__body">
              ${base.traits.map((t) => `<li>${A.escapeHtml(t)}</li>`).join("")}
            </ul>
          </div>

          <div class="block">
            <p class="block__title">习惯</p>
            <p class="habit block__body">${A.escapeHtml(base.habit || "还没有记下来。")}</p>
          </div>

          ${
            base.img && id !== state.desktopId
              ? `<div class="detail__actions">
                   <button class="btn btn--ghost" type="button" data-come>请她陪我</button>
                 </div>`
              : ""
          }
          ${
            base.img
              ? ""
              : `<p class="overview__note">原型暂未提供角色图，她暂时到不了桌面。</p>`
          }
        </div>
      </div>`;
  }

  function renderWardrobe(id) {
    const base = A.character(id);
    const cards = outfitsOf(id)
      .map((outfit) => {
        const art = outfit.locked
          ? `<div class="outfit__art outfit__art--line" aria-hidden="true">
               <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1.4"
                 stroke-linecap="round" stroke-linejoin="round">
                 <path d="M24 11c0 3.2 3.6 5.4 8 5.4s8-2.2 8-5.4"/>
                 <path d="M24 11 20 23h24l-4-12"/>
                 <path d="M20 23c0 12-1.8 20-1.8 29h27.6C45.8 43 44 35 44 23"/>
                 <path d="M27 30v22M37 30v22"/>
                 <path d="M18 28h-4M46 28h4"/>
               </svg>
             </div>`
          : base.img
          ? `<div class="outfit__art" data-shape="${base.shape}"><img src="${
              base.img
            }" alt="${A.escapeHtml(base.name)}穿着${A.escapeHtml(
              outfit.name
            )}" loading="lazy"></div>`
          : `<div class="outfit__art outfit__art--none">这套衣服还没有画出来。</div>`;

        const meta = outfit.locked
          ? `<p class="outfit__meta">未解锁 · 来自故事《旧围裙》</p>`
          : `<p class="outfit__meta">${A.escapeHtml(outfit.note)}</p>`;

        const actions = outfit.locked
          ? `<button class="btn btn--quiet btn--sm" type="button" data-preview="${outfit.id}">预览</button>
             <a class="btn btn--quiet btn--sm" href="stories.html?story=${outfit.story}">去读故事</a>`
          : `<button class="btn btn--quiet btn--sm" type="button" data-preview="${outfit.id}">预览</button>`;

        return `<article class="outfit" data-od-id="outfit-${outfit.id}">
            ${art}
            <div class="outfit__body">
              <div class="outfit__row">
                <p class="outfit__name">${A.escapeHtml(outfit.name)}</p>
                <span class="status" data-kind="${outfit.locked ? "unknown" : "desktop"}">
                  <i class="status__dot"></i>${outfit.locked ? "未解锁" : "当前穿着"}
                </span>
              </div>
              ${meta}
              <div class="outfit__actions">${actions}</div>
            </div>
          </article>`;
      })
      .join("");

    return `<div class="wardrobe">${cards}</div>
      <p class="memories__hint" style="margin-top:14px">
        预览只是看一眼，不会换下她现在穿的衣服。
      </p>`;
  }

  function renderMemories(id) {
    const all = memoriesOf(id);
    const query = memoryQuery.trim();
    const list = query ? all.filter((m) => m.text.includes(query) || m.source.includes(query)) : all;

    const rows = list
      .map((memory) => {
        const editing = editingMemory === memory.id;
        const text = editing
          ? `<div class="memory__edit">
               <textarea class="input" data-edit-input="${memory.id}"
                 aria-label="纠正这条偏好">${A.escapeHtml(editDraft)}</textarea>
               <div class="memory__edit-actions">
                 <button class="btn btn--primary btn--sm" type="button" data-edit-save="${memory.id}">保存</button>
                 <button class="btn btn--ghost btn--sm" type="button" data-edit-cancel="${memory.id}">取消</button>
               </div>
             </div>`
          : `<p class="memory__text">${A.escapeHtml(memory.text)}</p>
             <p class="memory__meta">${A.escapeHtml(memory.source)} · ${memory.date}${
               memory.edited ? " · 已纠正" : ""
             }</p>
             <div class="memory__actions">
               ${
                 memory.kind === "preference"
                   ? `<button class="btn btn--quiet btn--sm" type="button" data-edit="${memory.id}">纠正</button>`
                   : ""
               }
               <button class="btn btn--quiet btn--sm" type="button" data-remove="${memory.id}">删除</button>
             </div>`;

        return `<article class="memory" data-od-id="memory-${memory.id}">
            <div class="memory__top">
              <span class="memory__kind">${DATA.memoryKind[memory.kind]}</span>
            </div>
            ${text}
          </article>`;
      })
      .join("");

    const body = list.length
      ? `<div class="memories">${rows}</div>`
      : `<div class="empty" style="margin-top:12px">
           ${
             query
               ? "没有找到相关的记忆。换个说法试试，或者清空搜索。"
               : "这里还没有记下什么。"
           }
           ${
             query
               ? `<div style="margin-top:10px"><button class="btn btn--ghost btn--sm" type="button" data-clear-search>清空搜索</button></div>`
               : ""
           }
         </div>`;

    return `
      <div class="memories__bar">
        <input class="input" type="search" id="memorySearch" value="${A.escapeHtml(
          memoryQuery
        )}" placeholder="搜索${A.escapeHtml(A.displayName(id))}的记忆" aria-label="搜索记忆">
        <p class="memories__hint">${all.length} 条 · 来自她的讲述、共同经历和别人的转述</p>
      </div>
      ${memoryMsg ? `<p class="memory__msg">${A.escapeHtml(memoryMsg)}</p>` : ""}
      ${body}`;
  }

  function render() {
    const base = A.character(currentId);
    renderList();

    detailEl.innerHTML = `
      <div class="detail__head">
        <div>
          <h2 class="detail__name">${A.escapeHtml(A.displayName(currentId))}${
            currentId === state.fixedId ? `<span class="detail__fixed">固定位</span>` : ""
          }</h2>
          <p class="detail__tagline">${A.escapeHtml(base.tagline)}</p>
        </div>
        <div class="detail__head-actions">
          <span class="status" data-kind="${A.statusOf(currentId)}">
            <i class="status__dot"></i>${A.statusLabel(currentId)}
          </span>
          <button class="btn btn--primary btn--sm" type="button" data-chat>聊一会儿</button>
        </div>
      </div>
      <div class="tabs" role="tablist" aria-label="角色信息">
        ${TABS.map(
          (t) =>
            `<button type="button" role="tab" data-tab="${t.id}"
              aria-selected="${t.id === tab}">${t.label}</button>`
        ).join("")}
      </div>
      <div class="detail__panel" role="tabpanel">
        ${
          tab === "overview"
            ? renderOverview(currentId)
            : tab === "wardrobe"
            ? renderWardrobe(currentId)
            : renderMemories(currentId)
        }
      </div>`;

    bind();
    history.replaceState(null, "", `characters.html?id=${currentId}&tab=${tab}`);

    if (focusAfter) {
      const target = detailEl.querySelector(focusAfter);
      if (target) target.focus();
      focusAfter = "";
    }
  }

  /* ---------- 交互 ---------- */

  function bind() {
    detailEl.querySelectorAll("[data-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (tab === btn.dataset.tab) return;
        tab = btn.dataset.tab;
        nickEditing = false;
        nickMsg = "";
        memoryMsg = "";
        editingMemory = null;
        focusAfter = `[data-tab="${tab}"]`;
        render();
      });
    });

    charlistEl.querySelectorAll("[data-pick]").forEach((link) => {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        if (link.dataset.pick === currentId) return;
        currentId = link.dataset.pick;
        nickEditing = false;
        nickMsg = "";
        memoryMsg = "";
        editingMemory = null;
        memoryQuery = "";
        render();
        detailEl.querySelector(".detail__name").setAttribute("tabindex", "-1");
        detailEl.querySelector(".detail__name").focus();
      });
    });

    const chatBtn = detailEl.querySelector("[data-chat]");
    if (chatBtn) {
      chatBtn.addEventListener("click", () => A.openChat(currentId, chatBtn));
    }

    const comeBtn = detailEl.querySelector("[data-come]");
    if (comeBtn) {
      comeBtn.addEventListener("click", () => A.askCompanion(currentId, render));
    }

    const editNick = detailEl.querySelector("[data-nick-edit]");
    if (editNick) {
      editNick.addEventListener("click", () => {
        nickEditing = true;
        nickMsg = "";
        focusAfter = ".nick__form .input";
        render();
      });
    }

    const nickForm = detailEl.querySelector("[data-nick-form]");
    if (nickForm) {
      nickForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const input = nickForm.querySelector("input");
        const value = input.value.trim();
        if (value.length > 12) {
          nickMsg = "称呼最多 12 个字。";
          focusAfter = ".nick__form .input";
          render();
          return;
        }
        if (value) {
          state.nicknames[currentId] = value;
        } else {
          delete state.nicknames[currentId];
        }
        const saved = A.save();
        nickEditing = false;
        nickMsg = saved
          ? "已保存。刷新之后还是这个称呼。"
          : "没能保存，刷新后会恢复原来的称呼。";
        focusAfter = ".nick__value";
        render();
      });

      const cancel = nickForm.querySelector("[data-nick-cancel]");
      cancel.addEventListener("click", () => {
        nickEditing = false;
        nickMsg = "";
        focusAfter = "[data-nick-edit]";
        render();
      });
    }

    detailEl.querySelectorAll("[data-preview]").forEach((btn) => {
      btn.addEventListener("click", () => previewOutfit(btn.dataset.preview, btn));
    });

    detailEl.querySelectorAll("[data-edit]").forEach((btn) => {
      btn.addEventListener("click", () => {
        editingMemory = btn.dataset.edit;
        editDraft = memoriesOf(currentId).find((m) => m.id === editingMemory).text;
        memoryMsg = "";
        focusAfter = `[data-edit-input="${editingMemory}"]`;
        render();
      });
    });

    const editArea = detailEl.querySelector("[data-edit-input]");
    if (editArea) {
      editArea.addEventListener("input", () => {
        editDraft = editArea.value;
      });
    }

    detailEl.querySelectorAll("[data-edit-cancel]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.editCancel;
        editingMemory = null;
        memoryMsg = "";
        focusAfter = `[data-edit="${id}"]`;
        render();
      });
    });

    detailEl.querySelectorAll("[data-edit-save]").forEach((btn) => {
      btn.addEventListener("click", () => saveMemoryEdit(btn.dataset.editSave));
    });

    detailEl.querySelectorAll("[data-remove]").forEach((btn) => {
      btn.addEventListener("click", () => askRemoveMemory(btn.dataset.remove));
    });

    const search = document.getElementById("memorySearch");
    if (search) {
      search.addEventListener("input", () => {
        memoryQuery = search.value;
        const caret = search.selectionStart;
        render();
        const next = document.getElementById("memorySearch");
        if (next) {
          next.focus();
          next.setSelectionRange(caret, caret);
        }
      });
      search.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && memoryQuery) {
          event.stopPropagation();
          memoryQuery = "";
          render();
        }
      });
    }

    const clearSearch = detailEl.querySelector("[data-clear-search]");
    if (clearSearch) {
      clearSearch.addEventListener("click", () => {
        memoryQuery = "";
        focusAfter = "#memorySearch";
        render();
      });
    }
  }

  function saveMemoryEdit(memoryId) {
    const input = detailEl.querySelector(`[data-edit-input="${memoryId}"]`);
    const text = input.value.trim();
    if (!text) {
      editDraft = input.value;
      memoryMsg = "纠正后的内容不能为空。";
      focusAfter = `[data-edit-input="${memoryId}"]`;
      render();
      return;
    }

    const memory = memoriesOf(currentId).find((m) => m.id === memoryId);
    const holders = memory ? holdersOfKey(memory.key) : [currentId];
    state.memoryEdits[memory.key] = text;
    const saved = A.save();
    editingMemory = null;
    const who =
      holders.length > 1
        ? `${holders.map((id) => A.displayName(id)).join("和")}都持有这条，会一起改过来。`
        : "已经改过来了，刷新后仍然是新的说法。";
    memoryMsg = saved ? who : "没能保存，这条改动只在当前窗口生效。";
    focusAfter = `[data-edit="${memoryId}"]`;
    render();
  }

  function askRemoveMemory(memoryId) {
    const memory = memoriesOf(currentId).find((m) => m.id === memoryId);
    if (!memory) return;
    const holders = holdersOfKey(memory.key);
    const shared = holders.length > 1;
    const names = holders.map((id) => A.escapeHtml(A.displayName(id)));
    const name = A.displayName(currentId);

    const scope = shared
      ? `<label class="choice"><input type="radio" name="scope" value="all" checked>
           <span>所有持有者都移除（${names.join("、")}）</span></label>
         <p class="field__hint">默认会一起清掉，因为她们记的是同一件事。</p>
         <label class="choice"><input type="radio" name="scope" value="one">
           <span>只从 <strong>${A.escapeHtml(name)}</strong> 这里移除，其他人保留</span></label>`
      : `<p>这条只有 <strong>${A.escapeHtml(name)}</strong> 持有，移除之后她不会再提起。</p>`;

    A.dialog({
      title: "删除这条记忆？",
      body: `<p>「${A.escapeHtml(memory.text)}」</p>
             <div class="block" style="margin-top:14px">${scope}</div>`,
      confirmText: "删除",
      danger: true,
      onConfirm(panel) {
        const picked = panel.querySelector('input[name="scope"]:checked');
        const all = !shared || (picked && picked.value === "all");
        if (all) {
          if (!state.memoryHiddenKeys.includes(memory.key)) {
            state.memoryHiddenKeys.push(memory.key);
          }
        } else if (!state.memoryHidden.includes(memory.id)) {
          state.memoryHidden.push(memory.id);
        }
        const saved = A.save();
        memoryMsg = saved
          ? all && shared
            ? "所有持有者那里都移除了这条记录。"
            : `已经从${name}这里移除。`
          : "没能保存，这次删除只在当前窗口生效。";
        render();
      },
    });
  }

  function previewOutfit(outfitId, trigger) {
    const outfit = outfitsOf(currentId).find((o) => o.id === outfitId);
    if (!outfit) return;
    const base = A.character(currentId);

    if (outfit.locked) {
      A.dialog({
        title: outfit.name,
        body: `<p>${A.escapeHtml(outfit.note)}</p>
               <p>这套衣服目前只有实物，没有可以直接换上的版本。故事讲的是它的来历，读完不会解锁穿戴。</p>`,
        confirmText: "去读故事",
        cancelText: "留在衣橱",
        onConfirm() {
          location.href = `stories.html?story=${outfit.story}`;
        },
      });
      return;
    }

    const figure = base.img
      ? `<div class="preview-figure"><img src="${base.img}" alt="${A.escapeHtml(
          base.name
        )}穿着${A.escapeHtml(outfit.name)}"></div>`
      : "";

    A.dialog({
      title: `${outfit.name} · 预览`,
      body: `${figure}<p>这是${A.escapeHtml(
        base.name
      )}现在穿着的这一套，预览不会改变她的样子。</p>`,
      confirmText: "知道了",
      cancelText: "关闭",
    });
  }

  render();
  detailEl.querySelector(".detail__name").setAttribute("tabindex", "-1");
})();
