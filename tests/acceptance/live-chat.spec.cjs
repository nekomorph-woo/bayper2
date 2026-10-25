/* POL-CHAT-008 真实 DeepSeek 服务级验收（不经过 GUI）。
   只在显式执行 `node --test tests/acceptance/live-chat.spec.cjs` 时运行，
   不加入默认 npm test，也不随 test:live 自动执行。
   运行时读取仓库根 .env 的 OPEN_AI_BASE_URL / OPEN_AI_API_KEY；
   本文件不输出 Key、Authorization、.env 内容、reasoning_content 或原始响应。
   真实 chat 最多 4 次，无自动重试；GET /models 单独计数。 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { parseEnv } = require("node:util");
const { createStore } = require("../../app/store.cjs");
const { parseBaseUrl } = require("../../app/model.cjs");

const repoRoot = path.resolve(__dirname, "..", "..");
const evidenceDir = path.join(repoRoot, ".hapilon", "polaris", "Bayper完整交付", "evidence");
const evidenceFile = path.join(evidenceDir, "s03b-pol-chat-008-live.json");
const CHARACTER_ID = "rin";
const LIVE_MODEL = "deepseek-flash";
const CHAT_BUDGET = 4;
const REQUEST_TIMEOUT_MS = 45000;
const LEARN_TEXT = "请记住，我喜欢温茶。";
const ASK_TEXT = "我喜欢喝什么？";
const CORRECTED_BODY = "我现在更喜欢热可可。";

const evidence = {
  case: "POL-CHAT-008",
  executedAt: new Date().toISOString(),
  characterId: CHARACTER_ID,
  model: { requested: LIVE_MODEL, presentInModels: false },
  calls: { models: 0, chat: 0, chatBudget: CHAT_BUDGET, automaticRetry: false },
  dbReopenedBeforeSecondQuestion: false,
  turns: [],
  memory: { afterLearn: [], afterCorrect: [], afterForget: [] },
  machineChecks: [],
  machineVerdict: "FAIL",
  semanticReviewStatus: "PENDING_CODEX",
  semanticItems: [
    "首次回复是否自然承接记忆请求，且未虚构共同经历",
    "纠正后回复是否只把温茶作为过去/纠正语境，而非当前喜好",
    "删除后回复是否自然表示不知道，而非回避或编造",
  ],
};

test("POL-CHAT-008 真实 DeepSeek：学习、重开检索、纠正与删除", { timeout: 240000 }, async () => {
  const { baseUrl, apiKey } = loadCredentials();
  const safeBaseUrl = parseBaseUrl(baseUrl);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-live-chat-"));
  const fetchImpl = (url, init) => {
    evidence.calls.chat += 1;
    return fetch(url, init);
  };
  const openStore = () =>
    createStore(dataDir, {
      chat: {
        getCredentials: async () => ({ baseUrl: safeBaseUrl, modelName: LIVE_MODEL, apiKey }),
        fetchImpl,
        timeoutMs: REQUEST_TIMEOUT_MS,
      },
    });
  let store = null;
  try {
    const modelIds = await listModels(safeBaseUrl, apiKey);
    evidence.model.presentInModels = modelIds.includes(LIVE_MODEL);
    assert.equal(
      evidence.model.presentInModels,
      true,
      `GET /models 未返回 ${LIVE_MODEL}，真实服务不可用，未虚构模型名`,
    );
    evidence.machineChecks.push(`GET /models 实际返回 ${LIVE_MODEL}`);

    store = openStore();
    store.acceptCharacter({
      characterId: CHARACTER_ID,
      day: new Date().toISOString().slice(0, 10),
      acceptedAt: new Date().toISOString(),
    });
    assert.equal(store.getRelationship()?.characterId, CHARACTER_ID, "rin 关系构造失败");
    evidence.machineChecks.push("独立临时 SQLite 中显式构造 rin 已结识关系");

    await runTurn(store, "learn", LEARN_TEXT);
    const learnMemories = store.memory.listMemories(CHARACTER_ID);
    evidence.memory.afterLearn = snapshot(learnMemories);
    const teaEntry = learnMemories.find((entry) => entry.body.includes("温茶"));
    assert.ok(teaEntry, "首次对话后没有包含温茶的实际落库记忆；不使用 seed 伪装成功");
    evidence.machineChecks.push("首次对话后实际落库可用记忆包含温茶，未使用 seed");

    // 关闭并重开同一 SQLite；第二次提问使用全新对话，避免最近聊天冒充记忆。
    await store.chat.dispose();
    store.close();
    store = openStore();
    evidence.dbReopenedBeforeSecondQuestion = true;
    assert.equal(store.getRelationship()?.characterId, CHARACTER_ID, "重开后关系丢失");
    assert.equal(
      store.memory.listMemories(CHARACTER_ID).some((entry) => entry.body.includes("温茶")),
      true,
      "重开后落库记忆不可检索",
    );
    evidence.machineChecks.push("关闭重开 SQLite 后记忆仍可检索");

    const reply2 = await runTurn(store, "ask-after-reopen", ASK_TEXT);
    assert.equal(reply2.includes("温茶"), true, "重开后的新对话未使用落库记忆回答");
    evidence.machineChecks.push("重开 DB 后新对话（发送前 0 条消息）回复包含温茶");

    // 本地明确选中已落库记忆执行纠正；不依赖模型语义定位。
    const selected = store.memory
      .listMemories(CHARACTER_ID)
      .find((entry) => entry.factKey === teaEntry.factKey);
    assert.ok(selected && selected.body.includes("温茶"), "纠正前应能本地选中旧记忆");
    const corrected = store.memory.correct({
      characterId: CHARACTER_ID,
      factKey: selected.factKey,
      body: CORRECTED_BODY,
      nowMs: Date.now(),
    });
    assert.ok(corrected.updated >= 1, "本地纠正未更新记忆");
    const correctedMemories = store.memory.listMemories(CHARACTER_ID);
    evidence.memory.afterCorrect = snapshot(correctedMemories);
    const correctedEntry = correctedMemories.find((entry) => entry.factKey === teaEntry.factKey);
    assert.ok(correctedEntry?.body.includes("热可可"), "纠正后所选记忆不是热可可");
    assert.equal(
      correctedMemories.some((entry) => entry.body.includes("温茶")),
      false,
      "纠正后仍有活动记忆包含旧偏好",
    );
    evidence.machineChecks.push("本地明确选中记忆纠正为热可可，旧正文不再活动");

    const reply3 = await runTurn(store, "ask-after-correct", ASK_TEXT);
    assert.equal(reply3.includes("热可可"), true, "纠正后新对话未把热可可作为当前喜好");
    evidence.machineChecks.push("纠正后新对话回复包含热可可");
    if (reply3.includes("温茶")) {
      evidence.semanticItems.push("纠正后回复提及温茶；需 Codex 判断是否仅作为过去/纠正语境");
    }

    // 必要第 4 次：删除后新对话不应再表现出知道原偏好。
    const forgotten = store.memory.forget({ characterId: CHARACTER_ID, factKey: teaEntry.factKey });
    assert.ok(forgotten.deleted >= 1, "删除未生效");
    const forgottenMemories = store.memory.listMemories(CHARACTER_ID);
    evidence.memory.afterForget = snapshot(forgottenMemories);
    assert.equal(
      forgottenMemories.some((entry) => entry.body.includes("温茶") || entry.body.includes("热可可")),
      false,
      "删除后仍有活动偏好记忆",
    );
    const reply4 = await runTurn(store, "ask-after-forget", ASK_TEXT);
    assert.equal(reply4.includes("温茶"), false, "删除后新对话仍把旧偏好当作已知");
    assert.equal(reply4.includes("热可可"), false, "删除后新对话仍把纠正偏好当作已知");
    evidence.machineChecks.push("删除后新对话不再把旧/新偏好当作已知");

    assert.equal(evidence.calls.models, 1, "GET /models 应只调用一次");
    assert.ok(evidence.calls.chat <= CHAT_BUDGET, "chat 调用超出预算");
    evidence.machineChecks.push(
      `实际 chat 调用 ${evidence.calls.chat} 次，未超过 ${CHAT_BUDGET} 次且无自动重试`,
    );
    evidence.machineVerdict = "MACHINE_PASS";
  } finally {
    writeEvidence();
    if (store) {
      try {
        await store.chat.dispose();
      } catch {
        // 清理继续；不输出连接或配置细节。
      }
      try {
        store.close();
      } catch {
        // 数据库可能已在重开前关闭。
      }
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

/* 一次用户回合：新开对话、发送一次、关闭对话。发送前消息数用于证明
   第二至第四次提问没有把前序聊天当作最近上下文。 */
async function runTurn(store, step, text) {
  assert.ok(evidence.calls.chat < CHAT_BUDGET, `chat 调用预算 ${CHAT_BUDGET} 已用完`);
  const { conversation } = store.chat.openConversation({ characterId: CHARACTER_ID });
  const before = store.chat.getConversation({
    characterId: CHARACTER_ID,
    conversationId: conversation.id,
  });
  assert.equal(before.messages.length, 0, `步骤 ${step} 未使用全新对话`);
  const result = await store.chat.sendMessage({
    characterId: CHARACTER_ID,
    conversationId: conversation.id,
    text,
  });
  await store.chat.closeConversation({ characterId: CHARACTER_ID, conversationId: conversation.id });
  evidence.turns.push({
    step,
    user: text,
    status: result.status,
    errorCode: result.errorCode ?? null,
    reply: result.reply,
    memoryApplied: result.memoryApplied,
    newConversation: true,
    messagesBeforeSend: before.messages.length,
  });
  assert.equal(result.status, "completed", `步骤 ${step} 请求失败：${result.errorCode ?? "UNKNOWN"}`);
  return result.reply;
}

function snapshot(entries) {
  return entries.map(({ factKey, body, kind, trust }) => ({ factKey, body, kind, trust }));
}

function loadCredentials() {
  let values;
  try {
    values = parseEnv(fs.readFileSync(path.join(repoRoot, ".env"), "utf8"));
  } catch {
    throw new Error("无法读取根 .env；本测试需要 Codex 授权并配置 OPEN_AI_BASE_URL / OPEN_AI_API_KEY。");
  }
  const baseUrl = values.OPEN_AI_BASE_URL;
  const apiKey = values.OPEN_AI_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error("根 .env 缺少 OPEN_AI_BASE_URL 或 OPEN_AI_API_KEY。");
  }
  return { baseUrl, apiKey };
}

async function listModels(baseUrl, apiKey) {
  evidence.calls.models += 1;
  let response;
  try {
    response = await fetch(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      redirect: "manual",
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    assert.fail("GET /models 网络请求失败");
  }
  assert.equal(response.status, 200, `GET /models 返回 HTTP ${response.status}`);
  let data;
  try {
    data = await response.json();
  } catch {
    assert.fail("GET /models 未返回有效 JSON");
  }
  return Array.isArray(data?.data)
    ? data.data.map((item) => item?.id).filter((id) => typeof id === "string")
    : [];
}

function writeEvidence() {
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}
