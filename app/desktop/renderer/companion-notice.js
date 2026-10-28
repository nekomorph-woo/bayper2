/* S06m 自动告知卡：只渲染主进程下发的只读展示副本。
   完整可见满 350ms 后才上报并回执；点击与收起必须沿用同一 noticeToken。
   本脚本不读写业务状态，也不决定内容是否应出现。 */
(function () {
  "use strict";

  const api = window.notifications;
  const stack = document.getElementById("stack");
  const READY_MS = 350;
  const MAX_RETRY_MS = 2000;

  let notice = null;
  let card = null;
  let transportToken = null;
  let generation = null;
  let visibleSince = null;
  let reported = false;
  let ackSent = false;
  let acked = false;
  let retryAt = 0;
  let retryCount = 0;
  let navigating = false;

  function noticeKey(value) {
    return value ? `${value.noticeId}:${value.noticeToken}` : null;
  }

  function clearCard() {
    card?.root?.remove();
    card = null;
    visibleSince = null;
    reported = false;
    ackSent = false;
    acked = false;
    retryAt = 0;
    retryCount = 0;
    navigating = false;
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function buildCard() {
    const root = element("section", "card companion-card");
    root.setAttribute("role", "listitem");
    root.dataset.noticeId = notice.noticeId;
    root.dataset.noticeToken = notice.noticeToken;
    root.dataset.kind = notice.kind;
    root.dataset.storyId = notice.storyId;
    root.dataset.actionType = notice.actionType;

    const head = element("header", "card-head");
    head.append(
      element("span", "badge companion-badge", "陪伴提示"),
      element("span", "companion-kind", notice.kind === "outfit" ? "衣装" : "相遇"),
    );
    const close = element("button", "close companion-close", "收起");
    close.type = "button";
    head.append(close);

    const title = element("h3", "companion-title", notice.title);
    const body = element("p", "companion-body", notice.body);
    const source = element("p", "companion-source", notice.source);
    const action = element("button", "companion-action", notice.actionLabel);
    action.type = "button";
    action.disabled = true;

    close.addEventListener("click", () => {
      if (!card || !notice) return;
      api.companionClose(notice.noticeId, notice.noticeToken);
      clearCard();
    });
    action.addEventListener("click", () => {
      if (!card || !notice || navigating) return;
      if (!reported || Date.now() - (visibleSince ?? Date.now()) < READY_MS) {
        return;
      }
      navigating = true;
      api.companionAction(notice.noticeId, notice.noticeToken, "open");
    });

    root.append(head, title, body, source, action);
    stack.append(root);
    card = { root, action, title, body, source };
  }

  function render() {
    if (!notice) {
      clearCard();
      return;
    }
    if (!card || card.root.dataset.noticeToken !== notice.noticeToken) {
      clearCard();
      buildCard();
    }
    card.title.textContent = notice.title;
    card.body.textContent = notice.body;
    card.source.textContent = notice.source;
    card.action.textContent = notice.actionLabel;
    card.root.dataset.transportToken = String(transportToken ?? "");
    card.root.dataset.generation = generation ?? "";
  }

  function fullyVisible() {
    if (!card?.root.isConnected || document.visibilityState !== "visible") return false;
    const rect = card.root.getBoundingClientRect();
    const style = window.getComputedStyle(card.root);
    return style.display !== "none"
      && style.visibility !== "hidden"
      && rect.width > 0
      && rect.height > 0
      && rect.top >= -0.5
      && rect.bottom <= window.innerHeight + 0.5
      && rect.left >= -0.5
      && rect.right <= window.innerWidth + 0.5;
  }

  function report(complete, visibleMs) {
    if (!notice) return;
    api.companionVisible(notice.noticeId, notice.noticeToken, visibleMs, complete);
  }

  function tick() {
    if (!notice || !card || navigating) return;
    if (!fullyVisible()) {
      visibleSince = null;
      if (reported) {
        reported = false;
        report(false, 0);
      }
      return;
    }
    if (visibleSince === null) visibleSince = Date.now();
    const elapsed = Date.now() - visibleSince;
    if (elapsed < READY_MS) return;
    if (!reported) {
      reported = true;
      card.action.disabled = false;
      report(true, elapsed);
    }
    if (!acked && !ackSent && Date.now() >= retryAt) {
      ackSent = true;
      api.companionAck(notice.noticeId, notice.noticeToken);
    }
  }

  api.onUpdate((view) => {
    transportToken = Number.isInteger(view?.token) ? view.token : null;
    generation = typeof view?.generation === "string" ? view.generation : null;
    notice = view?.companionNotice ?? null;
    render();
    tick();
  });

  api.onCompanionResult((result) => {
    if (!notice || !result) return;
    // 必须匹配原请求的 notice/token/generation；同 noticeId 的新展示不能
    // 接纳上一张卡的迟到结果。
    if (result.noticeId !== notice.noticeId
      || result.noticeToken !== notice.noticeToken
      || result.token !== transportToken
      || result.generation !== generation) {
      return;
    }
    if (result.accepted === true) {
      if (result.navigated === true || result.acknowledged === true) {
        clearCard();
        return;
      }
      acked = true;
      ackSent = true;
      return;
    }
    navigating = false;
    // STALE_NOTICE 也解除发送标记并有界重试，避免永久停在 ackSent=true；
    // 实际展示上限仍由主进程 10 秒/6 秒计时决定。
    ackSent = false;
    retryCount += 1;
    retryAt = Date.now() + Math.min(MAX_RETRY_MS, 250 * (2 ** (retryCount - 1)));
  });

  setInterval(tick, 100);
})();
