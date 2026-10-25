/* 故事：左侧篇目、右侧正文。接纳与婉拒只写入角色册，不改变当前陪伴。 */

(function () {
  const A = window.App;
  const DATA = A.data;
  const state = A.state;

  const listEl = document.getElementById("storyList");
  const readerEl = document.getElementById("storyView");
  const subEl = document.getElementById("storySub");

  let current = A.params.get("story");
  if (!DATA.stories.some((s) => s.id === current)) current = DATA.stories[0].id;

  function whoName(id) {
    return A.whoName(id);
  }

  // 桌面上的人和固定位是两件事，措辞不要混用。
  function arrangementText() {
    const desk = A.displayName(state.desktopId);
    const fixed = A.displayName(state.fixedId);
    return desk === fixed
      ? `当前陪伴是${desk}，接纳新角色不会换人。`
      : `桌面上是${desk}，固定位是${fixed}；接纳新角色两边都不会变。`;
  }

  function inviteStatus(story) {
    if (!story.invite) return false;
    if (state.acceptedIds.includes("aya")) return "accepted";
    if (state.declined.includes("aya")) return "declined";
    return "pending";
  }

  /* ---------- 列表 ---------- */

  function renderList() {
    listEl.innerHTML = DATA.stories
      .map((story) => {
        const flag =
          inviteStatus(story) === "pending"
            ? `<span class="story-row__flag">有一封邀请</span>`
            : inviteStatus(story) === "accepted"
            ? `<span class="story-row__flag">绫已经在小窝</span>`
            : "";
        return `<button class="story-row" type="button" data-story="${story.id}"
            aria-current="${story.id === current}">
            <span class="story-row__title">${A.escapeHtml(story.title)}</span>
            <span class="story-row__meta">${story.date} · ${A.escapeHtml(
          whoName(story.who)
        )}</span>
            ${flag}
          </button>`;
      })
      .join("");

    listEl.querySelectorAll("[data-story]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.story === current) return;
        current = btn.dataset.story;
        history.replaceState(null, "", `stories.html?story=${current}`);
        render();
        readerEl.scrollTop = 0;
        readerEl.focus();
      });
    });
  }

  /* ---------- 正文 ---------- */

  function renderReader() {
    const story = DATA.stories.find((s) => s.id === current);
    const status = inviteStatus(story);
    let invite = "";

    if (story.invite) {
      if (status === "pending") {
        invite = `<div class="invite" data-od-id="invite-aya">
            <p class="invite__title">绫想过来坐一个下午</p>
            <p class="invite__text">接纳只会把她加进角色册和小窝，不会换掉现在的固定位，也不会改变桌面上的角色。</p>
            <div class="invite__actions">
              <button class="btn btn--primary btn--sm" type="button" data-accept>接纳她</button>
              <button class="btn btn--ghost btn--sm" type="button" data-later>稍后再说</button>
              <button class="btn btn--quiet btn--sm" type="button" data-decline>不接纳</button>
            </div>
          </div>`;
      } else if (status === "accepted") {
        invite = `<div class="invite" data-od-id="invite-aya">
            <p class="invite__state">绫已经在小窝了。她还没有画像，先在角色册里待着，
              <a href="characters.html?id=aya">去角色册看看</a>。</p>
            <p class="invite__text">${A.escapeHtml(arrangementText())}</p>
          </div>`;
      } else {
        invite = `<div class="invite" data-od-id="invite-aya">
            <p class="invite__state">你婉拒了这次邀请。故事还留在这里，她也可以再写信来。</p>
            <div class="invite__actions">
              <button class="btn btn--ghost btn--sm" type="button" data-reconsider>重新考虑</button>
            </div>
          </div>`;
      }
    }

    readerEl.innerHTML = `
      <p class="reader__meta">${story.date} · ${A.escapeHtml(whoName(story.who))} · ${A.escapeHtml(
      story.place
    )}</p>
      <h1 class="reader__title">${A.escapeHtml(story.title)}</h1>
      <div class="reader__body">
        ${story.body.map((p) => `<p>${A.escapeHtml(p)}</p>`).join("")}
      </div>
      ${invite}`;

    readerEl.setAttribute("tabindex", "-1");

    const accept = readerEl.querySelector("[data-accept]");
    if (accept) accept.addEventListener("click", () => acceptAya(accept));
    const later = readerEl.querySelector("[data-later]");
    if (later) later.addEventListener("click", () => A.toast("先放着，什么时候回来读都行。"));
    const decline = readerEl.querySelector("[data-decline]");
    if (decline) decline.addEventListener("click", () => declineAya(decline));
    const reconsider = readerEl.querySelector("[data-reconsider]");
    if (reconsider) {
      reconsider.addEventListener("click", () => {
        state.declined = state.declined.filter((id) => id !== "aya");
        if (!A.save()) A.toast("没有保存成功，这次改动只在当前窗口生效。");
        render();
      });
    }
  }

  function acceptAya(trigger) {
    if (state.acceptedIds.includes("aya")) {
      A.toast("绫已经在角色册里了。");
      return;
    }
    A.dialog({
      title: "接纳绫？",
      body: `<p>她会进入角色册，也会回到小窝，状态是「在小窝休息」。今日名单不会因此变化。</p>
             <p>${A.escapeHtml(arrangementText())}</p>`,
      confirmText: "接纳她",
      cancelText: "再想想",
      onConfirm() {
        if (state.acceptedIds.includes("aya")) return false;
        state.acceptedIds.push("aya");
        state.status.aya = "home";
        const saved = A.save();
        render();
        A.toast(saved ? "绫已经记进角色册了。" : "没有保存成功，这次接纳只在当前窗口生效。");
        if (trigger && document.contains(trigger)) trigger.blur();
      },
    });
  }

  function declineAya(trigger) {
    A.dialog({
      title: "婉拒这次邀请？",
      body: `<p>信会留在故事里，你可以随时回来重新考虑。</p>`,
      confirmText: "婉拒",
      danger: true,
      onConfirm() {
        if (!state.declined.includes("aya")) state.declined.push("aya");
        const saved = A.save();
        render();
        A.toast(saved ? "已经婉拒了这次邀请。" : "没有保存成功，这次改动只在当前窗口生效。");
        if (trigger && document.contains(trigger)) trigger.blur();
      },
    });
  }

  function render() {
    renderList();
    renderReader();
    const pending = DATA.stories.filter((s) => inviteStatus(s) === "pending").length;
    subEl.textContent = `${DATA.stories.length} 篇${pending ? " · 有一封邀请等你决定" : ""}`;
  }

  render();
})();
