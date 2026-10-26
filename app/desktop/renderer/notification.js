/* 通知气泡渲染：按呈现分组展示来源短标识、Agent 与真实状态含义。
   加急明细按窗口与列表实际可完整容纳的行数分页；一页全部显示且 6 秒
   阅读结束后自动推进下一页，不依赖用户手动展开。只有条目完整位于窗口
   和列表可视区域、且持续可见后才回执“已显示”；旧 token 或暂时写入失败
   由有界重试处理。 */
const api = window.notifications;
const stack = document.getElementById("stack");

const READY_MS = 350;
/* 探针上限：每页最多试三行，能完整容纳几行由真实换行后的高度决定。 */
const MAX_PAGE_SIZE = 3;
const MAX_ACK_RETRY_DELAY_MS = 2000;
const CLOSE_GRACE_MS = 3000;

let view = { token: null, generation: null, presentations: [], heightBudget: 0 };
const cards = new Map();
const visibleSince = new Map();
const sentIds = new Set();
const ackRetries = new Map();
const ackRetryAt = new Map();
const lastVisibleSignature = new Map();
let lastRequestedHeight = 0;

function keyOf(presentationId, eventId) {
  return `${presentationId}:${eventId}`;
}

function createItem(presentationId, item) {
  const row = document.createElement("li");
  row.className = "item";
  row.dataset.eventId = String(item.eventId);
  const text = document.createElement("span");
  text.className = "item-text";
  const source = document.createElement("span");
  source.className = "item-source";
  const meaning = document.createElement("span");
  meaning.className = "item-meaning";
  text.append(source, meaning);
  const state = document.createElement("span");
  state.className = "item-state";
  row.append(text, state);
  row.presentationId = presentationId;
  return row;
}

function updateItem(row, item) {
  const source = `${item.source ? `来源 ${item.source}` : "来源"}${
    item.agent ? ` · ${item.agent}` : ""
  }${item.historical ? " · 历史" : ""}`;
  row.querySelector(".item-source").textContent = source;
  row.querySelector(".item-meaning").textContent = item.phrase || "状态未知";
  const acknowledged = item.acknowledgedAt !== null && item.acknowledgedAt !== undefined;
  row.dataset.ack = acknowledged ? "1" : "0";
  row.classList.toggle("acked", acknowledged);
  const state = row.querySelector(".item-state");
  // 只陈述“已真实显示”，不冒充用户已阅读。
  state.textContent = acknowledged ? "已显示" : "";
  state.hidden = !acknowledged;
}

function badgeText(channel, items) {
  if (channel !== "urgent") return "状态变化";
  const current = items.some(
    (item) => !item.historical && item.currentState === "needs_attention",
  );
  if (current) return "需要确认";
  const unknown = items.some(
    (item) => item.state === "needs_attention" && item.currentState === "unknown",
  );
  if (unknown) return "状态未知";
  const recovered = items.some(
    (item) => item.state === "needs_attention"
      && item.currentState
      && !["needs_attention", "unknown"].includes(item.currentState),
  );
  return recovered ? "状态回顾" : "状态变化";
}

function createCard(presentationId) {
  const root = document.createElement("section");
  root.className = "card";
  root.dataset.presentationId = presentationId;
  root.setAttribute("role", "listitem");

  const head = document.createElement("header");
  head.className = "card-head";
  const badge = document.createElement("span");
  badge.className = "badge";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "close";
  close.textContent = "收起";
  close.title = "收起这条通知；未显示的内容不会标记为已显示";
  head.append(badge, close);

  const list = document.createElement("ul");
  list.className = "items";
  const more = document.createElement("button");
  more.type = "button";
  more.className = "more";

  // “查看全部”放在卡片头，避免在 420pt 等有限空间里独占一行、压掉正文高度。
  head.append(badge, more, close);
  root.append(head, list);

  const card = {
    root,
    badge,
    list,
    more,
    close,
    items: new Map(),
    offset: 0,
    capacity: MAX_PAGE_SIZE,
    measuredOffset: -1,
    expandedAll: false,
    closed: false,
    closedAt: 0,
    presentation: null,
    token: null,
  };

  close.addEventListener("click", () => {
    if (!card.presentation || card.closed) return;
    card.closed = true;
    card.closedAt = Date.now();
    root.classList.add("closing");
    for (const eventId of card.items.keys()) {
      visibleSince.delete(keyOf(presentationId, eventId));
    }
    api.close(card.presentation.presentationId, card.token);
  });

  more.addEventListener("click", () => {
    card.expandedAll = true;
    if (card.presentation) syncCard(card, card.presentation, card.token);
    requestResize();
    tick();
  });

  return card;
}

/* 一页全部自然显示满 6 秒后自动推进；用户点“查看全部”时改为一次渲染并滚动。 */
function advanceOffset(card, items, now) {
  for (;;) {
    const page = items.slice(card.offset, card.offset + card.capacity);
    if (page.length === 0 || card.offset + page.length >= items.length) break;
    const finished = page.every(
      (item) => item.acknowledgedAt && Number.isFinite(item.holdUntil)
        && item.holdUntil <= now,
    );
    if (!finished) break;
    card.offset += page.length;
  }
}

/* 来源是否换行决定这一页是否按单条保守展示；短来源才可能三条一页。 */
function sourceWraps(row) {
  const source = row.querySelector(".item-source");
  if (!source) return true;
  const lineHeight = parseFloat(getComputedStyle(source).lineHeight);
  return !(lineHeight > 0) || source.scrollHeight > lineHeight * 1.5;
}

/* 普通位单卡保守高度：取实际出现过的最大卡片高度并保持，普通位暂时
   退场时也不改用更小的估算，避免容量随普通位进出变化。 */
let ordinarySlot = 0;
function ordinarySlotHeight() {
  for (const card of cards.values()) {
    if (card.root.isConnected && card.presentation?.channel === "ordinary") {
      ordinarySlot = Math.max(ordinarySlot, card.root.getBoundingClientRect().height);
    }
  }
  return ordinarySlot || 96;
}

/* 按实际显示上限为三个普通位预留空间后的加急列表可用高度。 */
function pageListBudget(card) {
  const stackStyle = getComputedStyle(stack);
  const gap = parseFloat(stackStyle.rowGap) || 0;
  const padding = (parseFloat(stackStyle.paddingTop) || 0)
    + (parseFloat(stackStyle.paddingBottom) || 0);
  const cardStyle = getComputedStyle(card.root);
  const head = card.root.querySelector(".card-head");
  const chrome = 2
    + (parseFloat(cardStyle.paddingTop) || 0)
    + (parseFloat(cardStyle.paddingBottom) || 0)
    + (head?.getBoundingClientRect().height || 0)
    + 4;
  const reserve = 3 * ordinarySlotHeight() + 3 * gap;
  const limit = view.heightBudget > 0 ? view.heightBudget : window.innerHeight;
  return Math.max(0, Math.min(150, limit - padding - reserve - chrome));
}

/* 每页起点测量一次容量并锁定整个阅读期。长来源换行直接单条；短来源按
   三普通位保留后的真实高度预算估算最多三条，条目少于三行时按当前行高
   预估后续行，避免首条单独到达就把容量锁成一条。 */
function measurePageCapacity(card, items, presentationId) {
  const probe = items.slice(card.offset, card.offset + MAX_PAGE_SIZE);
  syncItems(card, probe, presentationId);
  card.list.scrollTop = 0;
  if ([...card.list.children].some(sourceWraps)) return 1;
  const available = pageListBudget(card);
  const heights = [...card.list.children].map(
    (row) => row.getBoundingClientRect().height,
  );
  const tallest = Math.max(0, ...heights);
  if (tallest <= 0) return 1;
  let used = 0;
  let fit = 0;
  while (fit < MAX_PAGE_SIZE) {
    const height = heights[fit] ?? tallest;
    if (fit > 0 && used + height > available + 0.5) break;
    used += height;
    fit += 1;
  }
  return Math.max(1, Math.min(MAX_PAGE_SIZE, fit));
}

function syncItems(card, items, presentationId) {
  const keep = new Set();
  for (const item of items) {
    keep.add(item.eventId);
    let row = card.items.get(item.eventId);
    if (!row) {
      row = createItem(presentationId, item);
      card.items.set(item.eventId, row);
    }
    updateItem(row, item);
    card.list.appendChild(row);
  }
  for (const [eventId, row] of [...card.items]) {
    if (!keep.has(eventId)) {
      row.remove();
      card.items.delete(eventId);
      visibleSince.delete(keyOf(presentationId, eventId));
      sentIds.delete(keyOf(presentationId, eventId));
    }
  }
}

function syncCard(card, presentation, token, now = Date.now()) {
  if (card.closed && now - card.closedAt > CLOSE_GRACE_MS) {
    card.closed = false;
    card.root.classList.remove("closing");
  }
  card.presentation = presentation;
  card.token = token;
  const channel = presentation.channel === "urgent" ? "urgent" : "ordinary";
  card.root.dataset.channel = channel;
  card.root.classList.toggle("urgent", channel === "urgent");
  const items = Array.isArray(presentation.items) ? presentation.items : [];
  card.badge.textContent = badgeText(channel, items);
  card.root.dataset.expanded = card.expandedAll ? "1" : "0";

  let visible;
  if (channel === "urgent" && !card.expandedAll) {
    advanceOffset(card, items, now);
    const ackedOnPage = items
      .slice(card.offset, card.offset + card.capacity)
      .filter((item) => item.acknowledgedAt).length;
    const hasMore = items.length > card.offset + card.capacity;
    // 新条目尚可扩展当前页；若更长而放不下，只把未回执尾部移到下一页。
    if (card.root.isConnected
      && (card.measuredOffset !== card.offset || hasMore)) {
      const measured = measurePageCapacity(card, items, presentation.presentationId);
      card.capacity = Math.max(measured, ackedOnPage);
      card.measuredOffset = items.length > 0 ? card.offset : -1;
    }
    visible = items.slice(card.offset, card.offset + card.capacity);
    syncItems(card, visible, presentation.presentationId);
    card.list.scrollTop = 0;
  } else {
    visible = items;
    const listScrollTop = card.list.scrollTop;
    syncItems(card, visible, presentation.presentationId);
    // 已显示状态更新会重新挂载节点，不能把用户正在查看的位置弹回顶部。
    card.list.scrollTop = listScrollTop;
  }

  const shownThrough = card.expandedAll ? items.length : card.offset + visible.length;
  const remaining = items.length - shownThrough;
  card.more.hidden = remaining <= 0 || card.expandedAll;
  if (!card.more.hidden) {
    card.more.textContent = `查看全部明细 · 后续 ${remaining} 条将自动显示`;
    card.more.title = "无需操作也会自动分页显示后续条目";
  }
}

function advancePages(now) {
  let changed = false;
  for (const card of cards.values()) {
    if (card.closed || card.expandedAll || card.presentation?.channel !== "urgent") continue;
    const before = card.offset;
    advanceOffset(card, card.presentation.items, now);
    if (card.offset !== before) {
      syncCard(card, card.presentation, card.token, now);
      changed = true;
    }
  }
  if (changed) requestResize();
}

function render() {
  ackRetries.clear();
  ackRetryAt.clear();
  // 视图 token 会随已显示状态更新；未确认的条目允许用新 token 重试回执。
  for (const presentation of view.presentations) {
    for (const item of presentation.items ?? []) {
      if (item.acknowledgedAt === null || item.acknowledgedAt === undefined) {
        sentIds.delete(keyOf(presentation.presentationId, item.eventId));
      }
    }
  }
  const stackScrollTop = stack.scrollTop;
  const presentations = [...view.presentations].sort((left, right) => {
    const rank = (item) => (item.channel === "urgent" ? 0 : 1);
    return rank(left) - rank(right) || (left.slot ?? 0) - (right.slot ?? 0);
  });
  const seen = new Set();
  const ordered = [];
  for (const presentation of presentations) {
    seen.add(presentation.presentationId);
    let card = cards.get(presentation.presentationId);
    if (!card) {
      card = createCard(presentation.presentationId);
      cards.set(presentation.presentationId, card);
    }
    syncCard(card, presentation, view.token);
    ordered.push(card.root);
  }
  // 顺序稳定时不重新挂载节点，避免把用户正在查看的列表滚动位置清零。
  ordered.forEach((node, index) => {
    if (stack.children[index] !== node) {
      stack.insertBefore(node, stack.children[index] ?? null);
    }
  });
  for (const [presentationId, card] of [...cards]) {
    if (seen.has(presentationId)) continue;
    card.root.remove();
    cards.delete(presentationId);
    lastVisibleSignature.delete(presentationId);
    for (const eventId of card.items.keys()) {
      visibleSince.delete(keyOf(presentationId, eventId));
      sentIds.delete(keyOf(presentationId, eventId));
    }
  }
  stack.scrollTop = stackScrollTop;
  // 新卡片挂载后按真实几何校正一次分页容量。
  reflow();
  requestResize();
  tick();
}

function clipFor(row) {
  const listRect = row.closest(".items").getBoundingClientRect();
  return {
    top: Math.max(0, listRect.top),
    bottom: Math.min(window.innerHeight, listRect.bottom),
  };
}

/* 完整可见包含纵向未被列表或窗口裁切、换行后的全部文字都在窗口内。 */
function fullyVisible(row) {
  // 以实际正文/来源文字为准；行底部内边距被滚动容器裁掉不算内容丢失。
  const content = row.querySelector(".item-text") ?? row;
  const rect = content.getBoundingClientRect();
  if (rect.height <= 0 || rect.width <= 0) return false;
  const clip = clipFor(row);
  return rect.top >= clip.top - 0.5
    && rect.bottom <= clip.bottom + 0.5
    && rect.left >= -0.5
    && rect.right <= window.innerWidth + 0.5;
}

function reportVisible() {
  const groups = new Map();
  for (const [presentationId, card] of cards) {
    if (card.closed) continue;
    for (const [eventId, row] of card.items) {
      if (row.dataset.ack === "1" || !fullyVisible(row)) continue;
      if (!groups.has(presentationId)) groups.set(presentationId, []);
      groups.get(presentationId).push(eventId);
    }
  }
  for (const [presentationId, eventIds] of groups) {
    const signature = eventIds.join(",");
    if (lastVisibleSignature.get(presentationId) === signature) continue;
    lastVisibleSignature.set(presentationId, signature);
    api.visible(presentationId, eventIds, true);
  }
}

function tick() {
  if (document.visibilityState !== "visible") {
    visibleSince.clear();
    return;
  }
  const now = Date.now();
  advancePages(now);
  const ready = new Map();
  for (const [presentationId, card] of cards) {
    if (card.closed) continue;
    for (const [eventId, row] of card.items) {
      const key = keyOf(presentationId, eventId);
      if (row.dataset.ack === "1") {
        visibleSince.delete(key);
        sentIds.delete(key);
        continue;
      }
      if (!fullyVisible(row)) {
        visibleSince.delete(key);
        continue;
      }
      if (!visibleSince.has(key)) visibleSince.set(key, now);
      if (now - visibleSince.get(key) < READY_MS) continue;
      if (sentIds.has(key)) continue;
      // 暂时失败按有上限的间隔持续恢复；不依赖新的业务事件或 token 变化。
      if (Date.now() < (ackRetryAt.get(key) ?? 0)) continue;
      if (!ready.has(presentationId)) ready.set(presentationId, []);
      ready.get(presentationId).push(eventId);
    }
  }
  reportVisible();
  for (const [presentationId, eventIds] of ready) {
    const card = cards.get(presentationId);
    if (!card?.presentation || eventIds.length === 0) continue;
    for (const eventId of eventIds) sentIds.add(keyOf(presentationId, eventId));
    api.ack(presentationId, card.token, eventIds);
  }
}

/* 不动布局地按内容计算期望高度：普通卡片用自然滚动高度，加急列表
   最多占 150px；短来源页在容量锁定前按探针高度申请空间。 */
function naturalHeight() {
  const style = getComputedStyle(stack);
  const gap = parseFloat(style.rowGap) || 0;
  const padding = (parseFloat(style.paddingTop) || 0)
    + (parseFloat(style.paddingBottom) || 0);
  let total = padding;
  [...stack.children].forEach((card, index) => {
    if (index > 0) total += gap;
    if (card.classList.contains("urgent")) {
      const head = card.querySelector(".card-head");
      const list = card.querySelector(".items");
      const cardStyle = getComputedStyle(card);
      total += 2
        + (parseFloat(cardStyle.paddingTop) || 0)
        + (parseFloat(cardStyle.paddingBottom) || 0)
        + (head?.getBoundingClientRect().height || 0)
        + Math.min(list?.scrollHeight || 0, 150);
    } else {
      total += card.scrollHeight + 2;
    }
  });
  return total;
}

function requestResize() {
  const height = Math.ceil(naturalHeight());
  if (!Number.isFinite(height) || height < 20) return;
  if (Math.abs(height - lastRequestedHeight) < 2) return;
  lastRequestedHeight = height;
  api.resize(height);
}

api.onUpdate((next) => {
  view = {
    token: next?.token ?? null,
    generation: next?.generation ?? null,
    presentations: Array.isArray(next?.presentations) ? next.presentations : [],
    heightBudget: Number(next?.heightBudget) || 0,
  };
  render();
});

api.onAckResult((result) => {
  if (!result) return;
  if (Number.isInteger(result.token)) view.token = result.token;
  for (const eventId of result.eventIds ?? []) {
    const key = keyOf(result.presentationId, eventId);
    const card = cards.get(result.presentationId);
    if (card && Number.isInteger(result.token)) card.token = result.token;
    if (result.accepted === true) {
      ackRetries.delete(key);
      ackRetryAt.delete(key);
      continue;
    }
    // 有界退避：暂时 token/写入失败后继续重试，但不会每个 tick 都轰炸。
    sentIds.delete(key);
    const count = (ackRetries.get(key) ?? 0) + 1;
    ackRetries.set(key, count);
    ackRetryAt.set(key, Date.now() + Math.min(
      MAX_ACK_RETRY_DELAY_MS, 250 * (2 ** (count - 1)),
    ));
  }
  tick();
});

/* 窗口高度变化后重新按真实可用高度分页；否则一次低高度测量会把
   容量错误地锁小，或把加急正文继续裁在滚动区里。 */
function reflow() {
  if (document.visibilityState !== "visible") return;
  const now = Date.now();
  for (const card of cards.values()) {
    if (card.presentation) syncCard(card, card.presentation, card.token, now);
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    lastVisibleSignature.clear();
    return;
  }
  visibleSince.clear();
  ackRetryAt.clear();
  for (const [presentationId, card] of cards) {
    for (const [eventId, row] of card.items) {
      if (row.dataset.ack !== "1") sentIds.delete(keyOf(presentationId, eventId));
    }
  }
});

for (const type of ["scroll", "resize"]) {
  window.addEventListener(type, requestResize, { passive: true });
  stack.addEventListener(type, () => {
    requestResize();
    tick();
  }, { passive: true, capture: false });
}

new ResizeObserver(() => {
  reflow();
  requestResize();
}).observe(stack);
setInterval(tick, 150);
