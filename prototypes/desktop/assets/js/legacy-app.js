/* 首轮方向页（home-a / home-b）专用脚本：侧面板、聊天、Escape 与 URL 状态。
   第二轮的正式原型使用 app.js，这里保持独立，避免旧页面失去交互。 */

const OPEN_GREETING = "你回来啦。毛线放在窗台，我替你收好了。";

const REPLIES = [
  "嗯，我在。你先坐会儿，毛线还有一小截。",
  "今天的光不错。你那边呢，忙完了吗？",
  "我听见了。不用急着把话说完整，我在这儿。",
];

const sheet = document.querySelector(".sheet");
const sheetKicker = document.querySelector("#sheetKicker");
const sheetTitle = document.querySelector("#sheetTitle");
const sheetBodies = document.querySelectorAll("[data-view-body]");
const chatLog = document.querySelector("#chatLog");
const chatStatus = document.querySelector("#chatStatus");
const composer = document.querySelector("#composer");
const chatInput = document.querySelector("#chatInput");
const toast = document.querySelector("#toast");

let lastFocus = null;
let replyIndex = 0;
let replyTimer = null;
let toastTimer = null;
let greeted = false;

function setView(view) {
  sheet.dataset.view = view;
  sheetKicker.textContent = view === "chat" ? "与凛" : "凛";
  sheetTitle.textContent = view === "chat" ? "聊一会儿" : "角色资料";
  sheetBodies.forEach((el) => {
    el.hidden = el.dataset.viewBody !== view;
  });
}

function openSheet(view, trigger) {
  if (sheet.dataset.open !== "true") {
    lastFocus = trigger || document.activeElement;
  }
  setView(view);
  sheet.dataset.open = "true";
  sheet.setAttribute("aria-hidden", "false");

  if (view === "chat") {
    if (!greeted) {
      addMessage(OPEN_GREETING, "rin");
      greeted = true;
    }
    requestAnimationFrame(() => chatInput.focus());
  } else {
    requestAnimationFrame(() => sheet.querySelector("[data-close]").focus());
  }
}

function closeSheet() {
  if (sheet.dataset.open !== "true") return;

  // 先把焦点还回去，再隐藏面板，避免焦点停在隐藏容器里。
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  lastFocus = null;
  sheet.dataset.open = "false";
  sheet.setAttribute("aria-hidden", "true");
}

function addMessage(text, from) {
  const item = document.createElement("li");
  item.className = `bubble bubble--${from}`;
  item.textContent = text;
  chatLog.append(item);
  const scroller = chatLog.closest(".sheet__body");
  scroller.scrollTop = scroller.scrollHeight;
}

function showToast(message) {
  toast.textContent = message;
  toast.dataset.show = "true";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.dataset.show = "false";
  }, 2400);
}

document.querySelectorAll("[data-open-chat]").forEach((btn) => {
  btn.addEventListener("click", () => openSheet("chat", btn));
});

document.querySelectorAll("[data-open-profile]").forEach((btn) => {
  btn.addEventListener("click", () => openSheet("profile", btn));
});

document.querySelectorAll("[data-close]").forEach((btn) => {
  btn.addEventListener("click", () => closeSheet());
});

document.querySelectorAll("[data-nav-hint]").forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    showToast("首轮原型只做了小窝首页，这一页之后深化。");
  });
});

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;

  addMessage(text, "me");
  chatInput.value = "";
  chatInput.style.height = "";
  chatStatus.hidden = false;
  clearTimeout(replyTimer);

  // 本地预置回应，仅用于演示节奏。
  replyTimer = setTimeout(() => {
    chatStatus.hidden = true;
    addMessage(REPLIES[replyIndex % REPLIES.length], "rin");
    replyIndex += 1;
  }, 620);
});

chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

chatInput.addEventListener("input", () => {
  chatInput.style.height = "auto";
  chatInput.style.height = `${chatInput.scrollHeight}px`;
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeSheet();
});

// 便于截图和走查：?panel=chat 或 ?panel=profile 直接打开对应状态。
const requestedPanel = new URLSearchParams(window.location.search).get("panel");
if (requestedPanel === "chat" || requestedPanel === "profile") {
  openSheet(requestedPanel, null);
}
