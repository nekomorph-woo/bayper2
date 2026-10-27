/* S03k 聊天里的全局自动分享设置。
   只从本轮真实用户原话识别完整的全局指令；不把历史、记忆正文或模型输出当成授权。
   明确的关闭/恢复指令由聊天服务在本地事务中执行，不组装模型上下文、不发网络请求。
   无法构成授权的设置讨论只返回本地“未更改/需澄清”，避免模型虚构已执行。
   “这件事不要分享”等单事实限制不在这里处理，继续走既有聊天记忆操作。 */

const REPLIES = Object.freeze({
  disabled:
    "好，已经关闭角色之间的自动分享。已经分享过的内容不会删除；你明确让当前角色转告时，仍会按原规则处理。",
  enabled:
    "好，已经恢复角色之间的自动分享，只限原有的窄范围主题见闻；私聊内容仍不会自动分享，之前的逐条限制和明确转告规则也继续有效。",
  notChanged:
    "我这次没有更改自动分享设置。需要的话，请直接说“关闭自动分享”或“恢复自动分享”。",
  conflict:
    "这句话同时表达了开启和关闭自动分享，我这次没有更改设置；请只保留一个方向。",
  mixed:
    "这句话还包含其他内容，我这次没有更改自动分享设置；如果只想调整设置，请单独发一条明确指令。",
});

/* 只接受完整的命令分句：可选礼貌/“以后”前缀 + 方向动词 + 明确带“自动”的
   全局分享对象。“角色之间的分享/转告”可能指用户明确转告，不能静默当成
   自动分享设置；含引号的句子也不删引号后再拼接，避免把引用改造成授权。 */
const PREFIX =
  /^(?:(?:麻烦你|麻烦|帮我|帮忙|拜托|请|从今以后|从现在起|从今往后|以后|之后|今后|往后|接下来)\s*[，,]?\s*)+/u;
const DISABLE_WORDS = [
  "不要再",
  "不要",
  "别再",
  "不用再",
  "不再",
  "停止",
  "关闭",
  "关掉",
  "关上",
  "停用",
  "取消",
  "禁止",
  "不用",
  "别",
];
const ENABLE_WORDS = [
  "重新开启",
  "重新打开",
  "恢复开启",
  "开启",
  "打开",
  "恢复",
  "允许",
  "启用",
];
const VERB_WORDS = [...DISABLE_WORDS, ...ENABLE_WORDS].sort(
  (left, right) => right.length - left.length,
);
const ENABLE_SET = new Set(ENABLE_WORDS);
const LEADING_VERB = new RegExp(`^(?:${VERB_WORDS.join("|")})\\s*`, "u");
const END_VERB = new RegExp(`(?:${VERB_WORDS.join("|")})$`, "u");
const TAIL = /(?:[吧啊呀哦哈啦])?(?:谢谢(?:你|啦)?|拜托了?|麻烦(?:你|了)?)?$/u;

const SHARE_VERB = "(?:分享|转告|告诉|讲|说)";
const MINE = "(?:我的事|我的事情|关于我的事|我的信息|关于我的信息)";
const OTHER = "(?:彼此|对方|别人|其他人|其他角色)";
/* “告诉我的事”既可能指“告诉给我”，也可能指“把我的事告诉别人”，
   所以裸露的“自动告诉”不接受“我的事”，只接受明确对象或单独使用。 */
const SUBJECT_SOURCE = [
  `(?:角色之间|角色间|你们之间|彼此之间|互相之间)(?:的)?自动(?:地)?(?:互相|相互)?${SHARE_VERB}${MINE}?`,
  `自动(?:地)?(?:互相|相互)${SHARE_VERB}${MINE}?`,
  `(?:互相|相互)自动${SHARE_VERB}${MINE}?`,
  `自动(?:地)?(?:分享|转告|讲)${MINE}?`,
  `自动(?:地)?说${MINE}`,
  `自动(?:地)?告诉${OTHER}${MINE}?`,
  `自动(?:地)?告诉`,
].join("|");
const SUBJECT = new RegExp(`^(?:${SUBJECT_SOURCE})$`, "u");

const CLAUSE_SPLIT = /[。！？!?；;，,\n]+/u;
const QUESTION_MARK = /[？?]/u;
/* 设置话题必须有分享语义：自动更新/自动保存等其他自动设置不属于这里。
   “角色之间”还要求附近出现分享动词，避免把角色之间的其他功能当成转告。 */
const SHARE_TOPIC = [
  "自动(?:地)?(?:互相|相互)(?:分享|转告|告诉|讲|说)",
  "自动(?:地)?(?:分享|转告|告诉)",
  "自动(?:地)?讲(?:我的事|我的事情|我的信息)",
  "自动(?:地)?说(?:我的事|我的事情|我的信息)",
  "(?:角色之间|角色间|你们之间|彼此之间|互相之间)[^。！？!?；;，,\\n]{0,10}(?:分享|转告|告诉|讲)",
  "(?:角色之间|角色间|你们之间|彼此之间|互相之间)[^。！？!?；;，,\\n]{0,10}说(?:我的事|我的事情|我的信息)",
].join("|");
/* 设置话题词要贴近方向动词才会触发本地方案；避免普通闲聊里远处出现
   “别”“关闭”等字就被接管。 */
const SETTING_MENTION = new RegExp(
  [
    `(?:关闭|关掉|关上|停用|停止|取消|禁止|不要(?:再)?|不用(?:再)?|不再|别(?:再)?|开启|打开|恢复|允许|启用)[^。！？!?；;，,\\n]{0,6}(?:${SHARE_TOPIC})`,
    `(?:${SHARE_TOPIC})[^。！？!?；;，,\\n]{0,10}(?:关闭|关掉|关上|关了|停用|停止|取消|禁止|开启|打开|开了|恢复|允许|启用)`,
  ].join("|"),
  "u",
);
/* 只作为命令之外的填充，不构成第二个任务。 */
const FILLER =
  /^(?:好的?|好|嗯|哦|噢|行|可以|是的|对|没错|谢谢(?:你|啦)?|多谢|麻烦(?:你|了)?|拜托了?|啦|呀|吧|哈)+$/u;

function parseCommand(clause) {
  let text = clause.trim().replace(TAIL, "").trim();
  if (!text) {
    return null;
  }
  text = text.replace(PREFIX, "").trim();
  if (!text) {
    return null;
  }

  if (text.startsWith("把")) {
    const rest = text.slice(1).trim();
    const verb = rest.match(END_VERB);
    if (!verb) {
      return null;
    }
    const subject = rest.slice(0, verb.index).trim();
    return SUBJECT.test(subject) ? { enabled: ENABLE_SET.has(verb[0]) } : null;
  }

  const verb = text.match(LEADING_VERB);
  if (!verb) {
    return null;
  }
  const subject = text.slice(verb[0].length).trim();
  return SUBJECT.test(subject)
    ? { enabled: ENABLE_SET.has(verb[0].trim()) }
    : null;
}

/* 返回 { kind: "execute", enabled, reply } / { kind: "clarify", reply } / { kind: "none" }。
   "none" 表示这不是自动分享设置话题，聊天继续走原有模型路径。 */
function detectSharingSetting(userText) {
  const raw = typeof userText === "string" ? userText.trim() : "";
  if (!raw) {
    return { kind: "none" };
  }
  // 设置话题至少要同时出现全局分享对象和设置方向词，普通闲聊不因此被接管。
  if (!SETTING_MENTION.test(raw)) {
    return { kind: "none" };
  }
  if (QUESTION_MARK.test(raw)) {
    return { kind: "clarify", reply: REPLIES.notChanged };
  }

  /* 直接在原句上分句，不删除引号或重组剩余文字；任何含引号的设置分句
     都无法匹配完整命令语法，只会得到本地“未更改”。 */
  const clauses = raw
    .split(CLAUSE_SPLIT)
    .map((clause) => clause.trim())
    .filter(Boolean);
  const commands = [];
  let otherTask = false;
  for (const clause of clauses) {
    const command = parseCommand(clause);
    if (command) {
      commands.push(command);
    } else if (!FILLER.test(clause)) {
      otherTask = true;
    }
  }

  if (commands.length === 0) {
    return { kind: "clarify", reply: REPLIES.notChanged };
  }
  if (otherTask) {
    return { kind: "clarify", reply: REPLIES.mixed };
  }
  const enabled = commands[0].enabled;
  if (commands.some((command) => command.enabled !== enabled)) {
    return { kind: "clarify", reply: REPLIES.conflict };
  }
  return {
    kind: "execute",
    enabled,
    reply: enabled ? REPLIES.enabled : REPLIES.disabled,
  };
}

module.exports = { REPLIES, detectSharingSetting };
