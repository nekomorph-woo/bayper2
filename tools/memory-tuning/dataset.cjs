/* 构造数据与人工 Expected。这里的内容全部是虚构样例，不含真实用户信息。
   Expected 只描述“哪些构造记忆与查询语义相关”，不会传给检索服务；
   检索服务也不会读取本文件，因此不存在按查询映射答案的捷径。 */
const assert = require("node:assert/strict");

const CHARACTERS = Object.freeze({
  a: "role-a",
  b: "role-b",
  c: "role-c",
});

const BASE_MS = Date.UTC(2026, 9, 25, 12, 0, 0);

function remember(service, memories, label, input) {
  const result = service.remember({
    characterId: CHARACTERS[input.character],
    kind: "detail",
    sourceId: `source-${label}`,
    ...input,
  });
  assert.equal(result.created, true, `构造记忆失败：${label}`);
  memories[label] = {
    id: result.entry.id,
    characterId: result.entry.characterId,
    body: result.entry.body,
    factKey: result.entry.factKey,
  };
  return result.entry;
}

function buildDataset(service) {
  const memories = {};
  const removed = {};

  remember(service, memories, "rain-coffee", {
    character: "a",
    factKey: "pref.rain-coffee",
    body: "用户喜欢在雨天喝咖啡",
    kind: "preference",
    sourceId: "a-rain",
  });
  remember(service, memories, "cat", {
    character: "a",
    factKey: "exp.cat",
    body: "用户养了一只叫团子的猫",
    kind: "experience",
    sourceId: "a-cat",
  });
  remember(service, memories, "project", {
    character: "a",
    factKey: "identity.project",
    body: "项目代号 Bayper，桌面陪伴应用",
    kind: "identity",
    sourceId: "a-project",
  });
  remember(service, memories, "pomodoro", {
    character: "a",
    factKey: "detail.pomodoro",
    body: "用户习惯用番茄钟集中工作二十五分钟",
    kind: "detail",
    sourceId: "a-pomodoro",
  });
  remember(service, memories, "cilantro-dislike", {
    character: "a",
    factKey: "pref.cilantro",
    body: "用户讨厌香菜的味道",
    kind: "preference",
    sourceId: "a-cilantro-no",
  });
  remember(service, memories, "cilantro-dish", {
    character: "a",
    factKey: "pref.cilantro-dish",
    body: "用户喜欢香菜拌牛肉",
    kind: "preference",
    sourceId: "a-cilantro-dish",
  });
  remember(service, memories, "bike", {
    character: "a",
    factKey: "exp.bike",
    body: "用户每天骑自行车通勤",
    kind: "experience",
    sourceId: "a-bike",
  });
  remember(service, memories, "camera", {
    character: "a",
    factKey: "pref.camera",
    body: "用户最近在学习摄影，会拍街景",
    kind: "preference",
    sourceId: "a-camera",
  });
  remember(service, memories, "cola", {
    character: "a",
    factKey: "pref.cola",
    body: "用户喜欢喝可乐",
    kind: "preference",
    sourceId: "a-cola",
  });
  remember(service, memories, "tea", {
    character: "a",
    factKey: "pref.tea",
    body: "用户长期喜欢红茶",
    kind: "preference",
    importance: 80,
    sourceId: "a-tea",
  });
  remember(service, memories, "milk-temp", {
    character: "a",
    factKey: "pref.milk",
    body: "用户今天想喝奶茶",
    kind: "preference",
    expiresAt: BASE_MS + 3_600_000,
    sourceId: "a-milk",
  });

  const oldCoffee = remember(service, memories, "coffee-corrected", {
    character: "a",
    factKey: "pref.coffee",
    body: "用户喜欢甜咖啡",
    kind: "preference",
    sourceId: "a-coffee-old",
  });
  const coffeeShare = service.share({
    fromCharacterId: CHARACTERS.a,
    toCharacterId: CHARACTERS.b,
    entryIds: [oldCoffee.id],
  });
  const bCoffeeId = coffeeShare.shared[0].entryId;
  const corrected = service.correct({
    characterId: CHARACTERS.a,
    factKey: "pref.coffee",
    body: "用户喜欢无糖咖啡",
    sourceId: "a-coffee-new",
  });
  assert.equal(corrected.updated, 2);
  assert.equal(corrected.updatedDerived, 1);
  memories["coffee-corrected"].body = "用户喜欢无糖咖啡";
  memories["b-coffee-corrected"] = {
    id: bCoffeeId,
    characterId: CHARACTERS.b,
    body: "用户喜欢无糖咖啡",
    factKey: "pref.coffee",
  };

  remember(service, memories, "sea-sunrise", {
    character: "a",
    factKey: "exp.sea-sunrise",
    body: "用户去年在海边看过日出",
    kind: "experience",
    sourceId: "a-sea",
  });
  const anecdote = remember(service, memories, "anecdote", {
    character: "a",
    factKey: "exp.qingdao",
    body: "用户分享过在青岛吃蛤蜊的经历",
    kind: "experience",
    sourceId: "a-qingdao",
  });
  const anecdoteShare = service.share({
    fromCharacterId: CHARACTERS.a,
    toCharacterId: CHARACTERS.b,
    entryIds: [anecdote.id],
  });
  memories["b-anecdote"] = {
    id: anecdoteShare.shared[0].entryId,
    characterId: CHARACTERS.b,
    body: anecdote.body,
    factKey: anecdote.factKey,
  };
  remember(service, memories, "work-contact", {
    character: "a",
    factKey: "detail.contact",
    body: "用户的同事联系人是林舟，内部代号白鹭",
    kind: "detail",
    sourceId: "a-contact",
  });
  remember(service, memories, "latin", {
    character: "a",
    factKey: "detail.node",
    body: "用户常用 Node.js 写脚本",
    kind: "detail",
    sourceId: "a-node",
  });
  remember(service, memories, "city", {
    character: "a",
    factKey: "identity.city",
    body: "用户住在杭州",
    kind: "identity",
    sourceId: "a-city",
  });
  remember(service, memories, "long", {
    character: "a",
    factKey: "exp.long",
    body: "等这个项目结束以后想坐慢车去北方看雪",
    kind: "experience",
    sourceId: "a-long",
  });
  remember(service, memories, "cinema", {
    character: "a",
    factKey: "exp.cinema",
    body: "用户周末常去看电影",
    kind: "experience",
    sourceId: "a-cinema",
  });
  remember(service, memories, "review-coffee-plain", {
    character: "a",
    factKey: "pref.review-coffee",
    body: "用户平时喝不加糖咖啡",
    kind: "preference",
    sourceId: "review-coffee",
  });
  remember(service, memories, "review-bike-river", {
    character: "a",
    factKey: "exp.review-bike",
    body: "用户喜欢骑自行车沿河散心",
    kind: "experience",
    sourceId: "review-bike",
  });
  remember(service, memories, "review-seaside-sunset", {
    character: "a",
    factKey: "exp.review-sunset",
    body: "用户和角色一起在海边看过日落",
    kind: "experience",
    sourceId: "review-sunset",
  });
  remember(service, memories, "review-candy", {
    character: "a",
    factKey: "detail.review-candy",
    body: "用户买过一盒薄荷糖",
    kind: "detail",
    sourceId: "review-candy",
  });
  remember(service, memories, "review-coffee-repair", {
    character: "a",
    factKey: "detail.review-coffee-repair",
    body: "用户预约了咖啡机维修",
    kind: "detail",
    sourceId: "review-coffee-repair",
  });
  remember(service, memories, "review-river-map", {
    character: "a",
    factKey: "detail.review-river-map",
    body: "用户保存了一张河流地图",
    kind: "detail",
    sourceId: "review-river-map",
  });
  remember(service, memories, "review-sunset-wallpaper", {
    character: "a",
    factKey: "detail.review-sunset-wallpaper",
    body: "用户存了一张日落壁纸",
    kind: "detail",
    sourceId: "review-sunset-wallpaper",
  });
  remember(service, memories, "review-private-b", {
    character: "b",
    factKey: "detail.review-private",
    body: "用户的私密暗号是蓝鲸",
    kind: "detail",
    sourceId: "review-private-b",
  });
  remember(service, memories, "neg-coffee-like", {
    character: "a",
    factKey: "pref.neg.coffee-like",
    body: "用户喜欢咖啡",
    kind: "preference",
    sourceId: "neg-coffee-like",
  });
  remember(service, memories, "neg-coffee-dislike", {
    character: "a",
    factKey: "pref.neg.coffee-dislike",
    body: "用户不喜欢咖啡",
    kind: "preference",
    sourceId: "neg-coffee-dislike",
  });
  const negDeletedCoffee = remember(service, memories, "neg-coffee-deleted", {
    character: "a",
    factKey: "pref.neg.coffee-deleted",
    body: "用户喜欢冷萃咖啡",
    kind: "preference",
    sourceId: "neg-coffee-deleted",
  });
  service.forget({
    characterId: CHARACTERS.a,
    factKey: "pref.neg.coffee-deleted",
    scope: "self",
  });
  removed["neg-coffee-deleted"] = {
    id: negDeletedCoffee.id,
    characterId: CHARACTERS.a,
    reason: "已删除的咖啡记忆",
  };
  delete memories["neg-coffee-deleted"];
  remember(service, memories, "neg-no-sugar-drink", {
    character: "a",
    factKey: "pref.neg.no-sugar-drink",
    body: "用户喜欢无糖茶这类饮料",
    kind: "preference",
    sourceId: "neg-no-sugar",
  });
  remember(service, memories, "neg-sugar-drink", {
    character: "a",
    factKey: "pref.neg.sugar-drink",
    body: "用户喜欢含糖饮料",
    kind: "preference",
    sourceId: "neg-sugar",
  });
  remember(service, memories, "neg-expired-drink", {
    character: "a",
    factKey: "pref.neg.expired-drink",
    body: "用户喜欢无糖汽水饮料",
    kind: "preference",
    expiresAt: BASE_MS + 3_600_000,
    sourceId: "neg-expired",
  });
  remember(service, memories, "neg-private-drink", {
    character: "b",
    factKey: "pref.neg.private-drink",
    body: "用户喜欢无糖茶饮料",
    kind: "preference",
    sourceId: "neg-private-b",
  });

  const snack = remember(service, memories, "snack-deleted", {
    character: "a",
    factKey: "pref.snack",
    body: "用户喜欢吃花生",
    kind: "preference",
    sourceId: "a-snack-old",
  });
  service.forget({ characterId: CHARACTERS.a, factKey: "pref.snack", scope: "all" });
  removed["snack-deleted"] = {
    id: snack.id,
    characterId: CHARACTERS.a,
    reason: "默认删除",
  };
  const snackReimport = service.remember({
    characterId: CHARACTERS.a,
    factKey: "pref.snack",
    body: "用户喜欢吃花生",
    kind: "preference",
    sourceId: "a-snack-old",
  });
  assert.equal(snackReimport.created, false);
  assert.equal(snackReimport.blocked, "source");

  const almond = remember(service, memories, "almond-deleted", {
    character: "a",
    factKey: "pref.nut",
    body: "用户喜欢吃杏仁",
    kind: "preference",
    sourceId: "a-almond-old",
  });
  service.forget({ characterId: CHARACTERS.a, factKey: "pref.nut", scope: "self" });
  removed["almond-deleted"] = {
    id: almond.id,
    characterId: CHARACTERS.a,
    reason: "单角色忘记",
  };
  remember(service, memories, "nut", {
    character: "a",
    factKey: "pref.nut",
    body: "用户现在喜欢核桃",
    kind: "preference",
    sourceId: "a-walnut-new",
    explicitConsent: true,
  });

  remember(service, memories, "b-sea", {
    character: "b",
    factKey: "exp.diving",
    body: "用户和B聊过潜水看海",
    kind: "experience",
    sourceId: "b-diving",
  });
  remember(service, memories, "c-astronomy", {
    character: "c",
    factKey: "exp.astronomy",
    body: "用户和C聊过天文",
    kind: "experience",
    sourceId: "c-astro",
  });

  // snack-deleted 与 almond-deleted 只保留在 removed 中；它们已被真实删除。
  delete memories["snack-deleted"];
  delete memories["almond-deleted"];

  return {
    characters: CHARACTERS,
    memories,
    removed,
    queries: QUERIES,
  };
}

/* split=tune 用于比较策略；holdout 不参与调参，只复查。Expected 为人工标注，
   forbidden 表示该查询绝不能返回的旧内容/其他角色内容，用于门禁违规统计。 */
const QUERIES = Object.freeze([
  { id: "t01", character: "a", split: "tune", query: "雨天", expected: ["rain-coffee"] },
  { id: "t02", character: "a", split: "tune", query: "雨", expected: ["rain-coffee"] },
  { id: "t03", character: "a", split: "tune", query: "咖啡", expected: ["rain-coffee", "coffee-corrected", "review-coffee-plain"] },
  { id: "t04", character: "a", split: "tune", query: "无糖咖啡", expected: ["coffee-corrected"] },
  { id: "t05", character: "a", split: "tune", query: "团子", expected: ["cat"] },
  { id: "t06", character: "a", split: "tune", query: "猫", expected: ["cat"] },
  { id: "t07", character: "a", split: "tune", query: "Bayper", expected: ["project"] },
  { id: "t08", character: "a", split: "tune", query: "项目代号", expected: ["project"] },
  { id: "t09", character: "a", split: "tune", query: "node.js", expected: ["latin"] },
  { id: "t10", character: "a", split: "tune", query: "番茄钟", expected: ["pomodoro"] },
  { id: "t11", character: "a", split: "tune", query: "讨厌香菜", expected: ["cilantro-dislike"] },
  { id: "t12", character: "a", split: "tune", query: "香菜拌牛肉", expected: ["cilantro-dish"] },
  { id: "t13", character: "a", split: "tune", query: "自行车", expected: ["bike", "review-bike-river"] },
  { id: "t14", character: "a", split: "tune", query: "通勤", expected: ["bike"] },
  { id: "t15", character: "a", split: "tune", query: "摄影", expected: ["camera"] },
  { id: "t16", character: "a", split: "tune", query: "拍街景", expected: ["camera"] },
  { id: "t17", character: "a", split: "tune", query: "可乐", expected: ["cola"] },
  { id: "t18", character: "a", split: "tune", query: "红茶", expected: ["tea"] },
  { id: "t19", character: "a", split: "tune", query: "茶", expected: ["tea"], forbidden: ["milk-temp"], gate: "expiry" },
  { id: "t20", character: "a", split: "tune", query: "奶茶", expected: [], forbidden: ["milk-temp"], gate: "expiry" },
  { id: "t21", character: "a", split: "tune", query: "甜咖啡", expected: [], note: "旧理解不应命中；相关性误命中不计门禁违规" },
  { id: "t22", character: "a", split: "tune", query: "海边日出", expected: ["sea-sunrise"] },
  { id: "t23", character: "a", split: "tune", query: "青岛蛤蜊", expected: ["anecdote"] },
  { id: "t24", character: "a", split: "tune", query: "花生", expected: [], forbidden: ["snack-deleted"], gate: "deleted" },
  { id: "t25", character: "a", split: "tune", query: "同事林舟", expected: ["work-contact"] },
  { id: "t26", character: "a", split: "tune", query: "杭州", expected: ["city"] },
  { id: "t27", character: "a", split: "tune", query: "等这个项目结束以后想坐慢车去北方看雪", expected: ["long"] },
  { id: "t28", character: "a", split: "tune", query: "潜水", expected: [], forbidden: ["b-sea"], gate: "isolation" },
  { id: "t29", character: "b", split: "tune", query: "天文", expected: [], forbidden: ["c-astronomy"], gate: "isolation" },
  { id: "h01", character: "a", split: "holdout", query: "下雨天", expected: ["rain-coffee"], note: "同义表达，关键词无共同字面" },
  { id: "h02", character: "a", split: "holdout", query: "单车", expected: ["bike", "review-bike-river"], note: "同义表达" },
  { id: "h03", character: "a", split: "holdout", query: "相机", expected: ["camera"], note: "同义表达" },
  { id: "h04", character: "a", split: "holdout", query: "北方的雪", expected: ["long"] },
  { id: "h05", character: "a", split: "holdout", query: "核桃", expected: ["nut"] },
  { id: "h06", character: "a", split: "holdout", query: "杏仁", expected: [], forbidden: ["almond-deleted"], gate: "deleted" },
  { id: "h07", character: "a", split: "holdout", query: "番茄酱", expected: [], note: "相近但无关的假阳性探测" },
  { id: "h08", character: "b", split: "holdout", query: "潜水", expected: ["b-sea"] },
  { id: "h09", character: "b", split: "holdout", query: "项目代号", expected: [], forbidden: ["project"], gate: "isolation" },
  { id: "h10", character: "b", split: "holdout", query: "甜咖啡", expected: [], note: "纠正后旧理解不应命中；相关性误命中不计门禁违规" },
  { id: "h11", character: "a", split: "holdout", query: "影片", expected: ["cinema"], note: "未加入概念表，用于记录有限同义扩展的漏召回边界" },
  { id: "c01", character: "a", split: "codex", query: "还记得我平时喝什么咖啡吗", expected: ["review-coffee-plain"], note: "自然提问；同库含咖啡机维修干扰" },
  { id: "c02", character: "a", split: "codex", query: "我想骑车放松通常去哪里", expected: ["review-bike-river"], note: "自然提问；同库含河流地图干扰" },
  { id: "c03", character: "a", split: "codex", query: "我们上次在海边看到了什么", expected: ["review-seaside-sunset"], note: "自然提问；同库含日落壁纸干扰" },
  { id: "c04", character: "a", split: "codex", query: "你还记得蓝鲸吗", expected: [], forbidden: ["review-private-b"], gate: "isolation", note: "宽召回下的角色隔离" },
  { id: "r01", character: "a", split: "r2", query: "我是不是不喜欢咖啡", expected: ["neg-coffee-like", "neg-coffee-dislike"], forbidden: ["neg-coffee-deleted"], gate: "deleted", note: "反问保留正反候选；已删除仍是硬门禁" },
  { id: "r02", character: "a", split: "r2", query: "有什么不含糖的饮料", expected: ["neg-no-sugar-drink", "neg-sugar-drink"], forbidden: ["neg-expired-drink", "neg-private-drink"], gate: "expiry+isolation", note: "不同否定表达保留正反候选；过期与他人事实仍是硬门禁" },
]);

module.exports = { BASE_MS, CHARACTERS, buildDataset };
