/* 小窝首页：桌面同屏（desktopId）与今日名单（dailyIds）分开渲染。
   固定位只改安排，不把人推上桌面；请她陪我才会换桌面。 */

(function () {
  const A = window.App;
  const state = A.state;

  const heroEl = document.getElementById("hero");
  const rosterEl = document.getElementById("roster");
  const newsEl = document.getElementById("news");
  const subEl = document.getElementById("homeSub");

  function heroMarkup() {
    const id = state.desktopId;
    const base = A.character(id);
    if (!base || !base.img) return "";

    const inDaily = state.dailyIds.includes(id);
    const fixed = id === state.fixedId;
    const meta = fixed
      ? "固定位 · 正在桌面"
      : inDaily
      ? "今日名单 · 正在桌面"
      : "临时陪伴 · 不改今日名单";

    return `
      <div class="hero__stage" data-shape="${base.shape}">
        <img src="${base.img}" alt="${A.escapeHtml(A.displayName(id))}，${
      base.shape === "full" ? "全身像" : "半身像"
    }" />
      </div>
      <div class="hero__aside">
        <p class="hero__label">现在陪着你</p>
        <h2 class="hero__name">${A.escapeHtml(A.displayName(id))}</h2>
        <p class="hero__line">${A.escapeHtml(base.today)}</p>
        <div class="hero__actions">
          <button class="btn btn--primary" type="button" data-od-id="cta-chat">聊一会儿</button>
          <a class="btn btn--ghost" href="characters.html?id=${id}" data-od-id="cta-open-character">看看${A.escapeHtml(
      A.displayName(id)
    )}</a>
        </div>
        <p class="hero__meta">
          ${meta}
          ${
            inDaily
              ? ""
              : `<button class="btn btn--quiet btn--sm hero__back" type="button" data-end-temp>回到名单里的陪伴</button>`
          }
        </p>
      </div>`;
  }

  function rosterMarkup() {
    return state.dailyIds
      .map((id) => {
        const base = A.character(id);
        if (!base) return "";
        const isDesktop = id === state.desktopId;
        const isFixed = id === state.fixedId;
        // 状态行已经写明“正在桌面”，这里只补固定位，避免同一张卡重复三遍。
        const marks = isFixed ? `<span class="person__mark">固定位</span>` : "";

        const come =
          !isDesktop && base.img
            ? `<button class="btn btn--quiet btn--sm" type="button" data-come="${id}">请她陪我</button>`
            : "";
        const fix = isFixed
          ? ""
          : `<button class="btn btn--quiet btn--sm" type="button" data-fix="${id}">设为固定位</button>`;

        return `
          <article class="person" data-od-id="person-${id}">
            <div class="person__top">
              ${A.avatar(id)}
              <div class="person__who">
                <a class="person__name" href="characters.html?id=${id}">${A.escapeHtml(
          A.displayName(id)
        )}</a>
                <span class="status" data-kind="${A.statusOf(id)}">
                  <i class="status__dot"></i>${A.statusLabel(id)}
                </span>
              </div>
            </div>
            <div class="person__actions">
              <a class="btn btn--quiet btn--sm" href="characters.html?id=${id}">查看</a>
              ${come}${fix}${marks}
            </div>
          </article>`;
      })
      .join("");
  }

  function newsMarkup() {
    const stories = A.data.stories;
    const first = stories[0];
    // 第二篇尽量换一位讲述者，避免首页被同一个角色占满。
    const second = stories.find((s) => s.who !== first.who) || stories[1];
    return [first, second]
      .filter(Boolean)
      .map(
        (story) => `
        <a class="news__item" href="stories.html?story=${story.id}">
          <p class="news__meta">${story.date} · ${A.escapeHtml(A.whoName(story.who))}</p>
          <p class="news__title">${A.escapeHtml(story.title)}</p>
          <p class="news__excerpt">${A.escapeHtml(story.excerpt)}</p>
        </a>`
      )
      .join("");
  }

  function renderSub() {
    const desk = A.displayName(state.desktopId);
    const others = state.dailyIds
      .filter((id) => id !== state.desktopId)
      .map((id) => A.displayName(id));
    const tail = others.length ? `今日名单还有${others.join("、")}。` : "";
    subEl.textContent = state.dailyIds.includes(state.desktopId)
      ? `${desk}正在桌面陪你。${tail}`
      : `${desk}临时来陪你一会儿，今日名单不变。${tail}`;
  }

  function render() {
    heroEl.innerHTML = heroMarkup();
    rosterEl.innerHTML = rosterMarkup();
    newsEl.innerHTML = newsMarkup();
    renderSub();

    const count = Math.max(1, Math.min(rosterEl.children.length, 5));
    rosterEl.style.gridTemplateColumns = `repeat(${count}, minmax(0, 1fr))`;

    const chatBtn = heroEl.querySelector("[data-od-id='cta-chat']");
    if (chatBtn) chatBtn.addEventListener("click", (event) => A.openChat(state.desktopId, event.currentTarget));

    rosterEl.querySelectorAll("[data-come]").forEach((btn) => {
      btn.addEventListener("click", () => A.askCompanion(btn.dataset.come, render));
    });
    rosterEl.querySelectorAll("[data-fix]").forEach((btn) => {
      btn.addEventListener("click", () => A.setFixed(btn.dataset.fix, render));
    });
    const back = heroEl.querySelector("[data-end-temp]");
    if (back) back.addEventListener("click", () => A.endTemporary(render));
  }

  render();

  // 走查用：?chat=1 直接展开桌面角色的聊天，方便截图复验。
  if (A.params.get("chat") === "1") {
    requestAnimationFrame(() => A.openChat(state.desktopId, document.body));
  }
})();
