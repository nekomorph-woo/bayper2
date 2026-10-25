/* 小窝：桌面同屏（desktopId）与今日名单（dailyIds）分开渲染。
   固定位只改安排，不把人推上桌面；请她陪我才会换桌面。 */

(function () {
  const A = window.App;
  const state = A.state;

  const stageEl = document.getElementById("stage");
  const rosterEl = document.getElementById("roster");
  const newsEl = document.getElementById("news");
  const subEl = document.getElementById("homeSub");
  const hintEl = document.getElementById("rosterHint");

  function stageMarkup() {
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
      <div class="stage__canvas" data-shape="${base.shape}">
        <img src="${base.img}" alt="${A.escapeHtml(A.displayName(id))}，${
      base.shape === "full" ? "全身像" : "半身像"
    }" />
      </div>
      <div class="stage__info">
        <p class="stage__label">现在陪着你</p>
        <div class="stage__name-row">
          <h2 class="stage__name">${A.escapeHtml(A.displayName(id))}</h2>
          <div class="stage__actions">
            <button class="btn btn--primary btn--sm" type="button" data-chat data-od-id="cta-chat">
              聊一会儿
            </button>
            <a class="btn btn--ghost btn--sm" href="characters.html?id=${id}"
              data-od-id="cta-open-character">角色详情</a>
          </div>
        </div>
        <p class="stage__line">${A.escapeHtml(base.today)}</p>
        <p class="stage__meta">
          ${meta}
          ${
            inDaily
              ? ""
              : `<button class="stage__back" type="button" data-end-temp>回到名单里的陪伴</button>`
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

        const act = [
          !isDesktop && base.img
            ? `<button type="button" data-come="${id}">陪我</button>`
            : "",
          isFixed ? "" : `<button type="button" data-fix="${id}">设为固定位</button>`,
        ].join("");

        return `
          <div class="member" data-od-id="person-${id}">
            <a class="member__id" href="characters.html?id=${id}">
              ${A.avatar(id, true)}
              <span class="member__text">
                <span class="member__name">${A.escapeHtml(A.displayName(id))}</span>
                <span class="member__state">
                  <i class="status__dot" data-kind="${A.statusOf(id)}"></i>${A.statusLabel(id)}${
          isFixed ? " · 固定位" : ""
        }
                </span>
              </span>
            </a>
            <span class="member__act">${act}</span>
          </div>`;
      })
      .join("");
  }

  function newsMarkup() {
    const stories = A.data.stories;
    const first = stories[0];
    // 第二条尽量换一位讲述者，避免首页只看到同一个角色。
    const second = stories.find((s) => s.who !== first.who) || stories[1];
    return [first, second]
      .filter(Boolean)
      .map(
        (story) => `
        <a class="news-row" href="stories.html?story=${story.id}">
          <span class="news-row__title">${A.escapeHtml(story.title)}</span>
          <span class="news-row__meta">${story.date} · ${A.escapeHtml(A.whoName(story.who))}</span>
        </a>`
      )
      .join("");
  }

  function renderSub() {
    // 只放日期这类页面上下文；名单与在场状态已经在下面两处呈现。
    subEl.textContent = "10月25日 · 周日";
  }

  function render() {
    stageEl.innerHTML = stageMarkup();
    rosterEl.innerHTML = rosterMarkup();
    newsEl.innerHTML = newsMarkup();
    renderSub();

    hintEl.textContent = `${state.dailyIds.length} 位 · 1 个固定位`;

    const chatBtn = stageEl.querySelector("[data-chat]");
    if (chatBtn) {
      chatBtn.addEventListener("click", (event) => A.openChat(state.desktopId, event.currentTarget));
    }

    rosterEl.querySelectorAll("[data-come]").forEach((btn) => {
      btn.addEventListener("click", () => A.askCompanion(btn.dataset.come, render));
    });
    rosterEl.querySelectorAll("[data-fix]").forEach((btn) => {
      btn.addEventListener("click", () => A.setFixed(btn.dataset.fix, render));
    });
    const back = stageEl.querySelector("[data-end-temp]");
    if (back) back.addEventListener("click", () => A.endTemporary(render));
  }

  render();

  // 走查用：?chat=1 直接展开桌面角色的聊天，方便截图复验。
  if (A.params.get("chat") === "1") {
    requestAnimationFrame(() => {
      const trigger = stageEl.querySelector("[data-chat]");
      A.openChat(state.desktopId, trigger || document.body);
    });
  }
})();
