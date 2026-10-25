/* 故事：列表与阅读。相遇邀请的接纳只写入角色册和小窝，不改变当前陪伴。 */

(function () {
  const A = window.App;
  const DATA = A.data;
  const state = A.state;

  const viewEl = document.getElementById("storyView");
  const headEl = document.getElementById("pageHead");
  const pageScroll = document.getElementById("pageScroll");

  let current = A.params.get("story");
  if (current && !DATA.stories.some((s) => s.id === current)) current = null;

  function whoName(id) {
    return A.whoName(id);
  }

  function storyStatus(story) {
    if (!story.invite) return false;
    if (state.acceptedIds.includes("aya")) return "accepted";
    if (state.declined.includes("aya")) return "declined";
    return "pending";
  }

  /* ---------- 列表 ---------- */

  function renderList() {
    headEl.innerHTML = `
      <div>
        <p class="eyebrow">已经发生的事</p>
        <h1>故事</h1>
        <p class="sub">凛、琥珀和澄最近发生的事，还有一封从河对岸寄来的信。</p>
      </div>`;

    viewEl.innerHTML = `<div class="storylist">${DATA.stories
      .map((story) => {
        const status = storyStatus(story);
        const flag =
          status === "pending"
            ? `<p class="storyrow__flag">有一封邀请等你决定</p>`
            : status === "accepted"
            ? `<p class="storyrow__flag" style="color:var(--accent)">绫已经在小窝</p>`
            : "";
        return `<article class="storyrow">
            <p class="storyrow__date">${story.date}</p>
            <div>
              <a class="storyrow__title" href="stories.html?story=${story.id}" data-open="${story.id}">
                ${A.escapeHtml(story.title)}
                <span class="storyrow__who">${A.escapeHtml(whoName(story.who))}</span>
              </a>
              <p class="storyrow__excerpt">${A.escapeHtml(story.excerpt)}</p>
              ${flag}
            </div>
          </article>`;
      })
      .join("")}</div>`;

    viewEl.querySelectorAll("[data-open]").forEach((link) => {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        current = link.dataset.open;
        history.replaceState(null, "", `stories.html?story=${current}`);
        render();
        pageScroll.scrollTop = 0;
      });
    });
  }

  /* ---------- 阅读 ---------- */

  function renderReader(story) {
    const status = storyStatus(story);

    headEl.innerHTML = `
      <div>
        <a class="backlink" href="stories.html" data-back>
          <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor"
            stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M15 10H4M8.5 6.2 4.5 10l4 3.8"/></svg>
          全部故事
        </a>
      </div>`;

    let invite = "";
    if (story.invite) {
      if (status === "pending") {
        invite = `<div class="invite" data-od-id="invite-aya">
            <p class="invite__title">绫想过来坐一个下午</p>
            <p class="invite__text">接纳只会把她加进角色册和小窝，不会换掉现在的固定位，也不会改变桌面上的角色。</p>
            <div class="invite__actions">
              <button class="btn btn--primary" type="button" data-accept>接纳她</button>
              <button class="btn btn--ghost" type="button" data-later>稍后再说</button>
              <button class="btn btn--quiet" type="button" data-decline>不接纳</button>
            </div>
          </div>`;
      } else if (status === "accepted") {
        invite = `<div class="invite" data-od-id="invite-aya">
            <p class="invite__state">绫已经在小窝了。她还没有画面，先在名单里待着，<a href="characters.html?id=aya">去角色册看看</a>。</p>
            <p class="invite__text">当前陪伴仍然是${A.escapeHtml(A.displayName(state.fixedId))}，接纳新角色不会替换固定位。</p>
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

    viewEl.innerHTML = `
      <article class="reader">
        <p class="reader__meta">${story.date} · ${A.escapeHtml(whoName(story.who))} · ${A.escapeHtml(
      story.place
    )}</p>
        <h1>${A.escapeHtml(story.title)}</h1>
        <div class="reader__body">
          ${story.body.map((p) => `<p>${A.escapeHtml(p)}</p>`).join("")}
        </div>
        ${invite}
      </article>`;

    headEl.querySelector("[data-back]").addEventListener("click", (event) => {
      event.preventDefault();
      current = null;
      history.replaceState(null, "", "stories.html");
      render();
      pageScroll.scrollTop = 0;
    });

    const accept = viewEl.querySelector("[data-accept]");
    if (accept) {
      accept.addEventListener("click", () => acceptAya(accept));
    }
    const later = viewEl.querySelector("[data-later]");
    if (later) {
      later.addEventListener("click", () => A.toast("先放着，什么时候回来读都行。"));
    }
    const decline = viewEl.querySelector("[data-decline]");
    if (decline) {
      decline.addEventListener("click", () => declineAya(decline));
    }
    const reconsider = viewEl.querySelector("[data-reconsider]");
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
      body: `<p>她会出现在角色册和小窝的名单里，状态是「在小窝休息」。</p>
             <p>当前陪伴<strong>${A.escapeHtml(
               A.displayName(state.fixedId)
             )}</strong>不会因此改变，桌面上的角色也不会换人。</p>`,
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
    const story = current ? DATA.stories.find((s) => s.id === current) : null;
    if (story) renderReader(story);
    else renderList();
  }

  render();
})();
