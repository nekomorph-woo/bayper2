/* S03c 本地记忆窗口验收：真实 Electron/SQLite，模型只使用本机受控 fixture。
   分页大数据仅用于验证可达性；服务与 UI 的真实生成仍由各自测试覆盖。 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { _electron: electron } = require("playwright");
const electronPath = require("electron");
const { createStore } = require("../../app/store.cjs");

const repoRoot = path.resolve(__dirname, "..", "..");
const DB_FILE = "bayper.sqlite3";
const EVIDENCE_DIR = path.join(
  repoRoot,
  ".hapilon",
  "polaris",
  "Bayper完整交付",
  "evidence",
  "s03c-memory-ui",
);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 15000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("等待测试条件超时。");
    }
    await delay(10);
  }
}

function sendStructured(response, payload, status = 200) {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  response.writeHead(status, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content: JSON.stringify(payload) } }],
    }),
  );
}

function sendText(response, text, status = 200) {
  sendStructured(response, { reply: text, memoryCandidates: [] }, status);
}

async function startChatServer() {
  const requests = [];
  const responders = [];
  let closed = false;
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
      requests.push(body);
      const responder = responders.shift();
      Promise.resolve(
        responder ? responder({ body, response }) : sendText(response, "连接正常。"),
      ).catch(() => {
        if (!response.destroyed && !response.writableEnded) {
          response.destroy();
        }
      });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    enqueue(responder) {
      responders.push(responder);
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function makeDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bayper-memory-ui-"));
}

async function launchApp(dataDir) {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [repoRoot, `--data-dir=${dataDir}`],
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page };
}

async function closeApp(app) {
  if (!app) {
    return;
  }
  try {
    await app.close();
  } catch {
    // 清理继续。
  }
}

async function completeOnboarding(page, baseUrl) {
  await page.locator("#base-url").fill(baseUrl);
  await page.locator("#model-name").fill("fixture-chat");
  await page.locator("#api-key").fill("sk-fixture-chat");
  await page.locator("#config-submit").click();
  await page.locator('[data-step="wish"]').waitFor({ state: "visible", timeout: 20000 });
  await page.locator("#wish-submit").click();
  await page.locator("#candidate-card").waitFor({ state: "visible" });
  await page.locator("#accept-button").click();
  await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
}

async function setWindowSize(app, width, height) {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed());
      win?.setSize(size.width, size.height);
    },
    { width, height },
  );
  await delay(120);
}

function openDb(dataDir, readOnly = false) {
  return new DatabaseSync(path.join(dataDir, DB_FILE), { readOnly });
}

function readMemoryRows(dataDir, characterId) {
  const db = openDb(dataDir, true);
  try {
    return db
      .prepare(
        `SELECT e.id, e.character_id, e.fact_key, e.body, e.version,
                e.origin_character_id, e.trust,
                CASE WHEN e.origin_character_id <> e.character_id
                  OR EXISTS (SELECT 1 FROM memory_derivations d WHERE d.entry_id = e.id)
                  THEN 1 ELSE 0 END AS derived
         FROM memory_entries e
         WHERE e.character_id = ?
           AND (e.expires_at IS NULL OR e.expires_at > ?)
         ORDER BY e.importance DESC, e.updated_at DESC, e.id ASC`,
      )
      .all(characterId, Date.now());
  } finally {
    db.close();
  }
}

function readStats(dataDir) {
  const db = openDb(dataDir, true);
  try {
    return db
      .prepare("SELECT character_id, intimacy, energy, mood FROM character_stats ORDER BY character_id")
      .all();
  } finally {
    db.close();
  }
}

function readChatMessages(dataDir) {
  const db = openDb(dataDir, true);
  try {
    return db
      .prepare("SELECT role, content, character_id, conversation_id FROM chat_messages ORDER BY seq")
      .all();
  } finally {
    db.close();
  }
}

function seedCompanion(dataDir, characterId) {
  const db = openDb(dataDir);
  try {
    db.prepare(
      "INSERT OR IGNORE INTO relationships (character_id, accepted_at) VALUES (?, ?)",
    ).run(characterId, new Date().toISOString());
    db.prepare(`
      INSERT OR IGNORE INTO character_stats (character_id, intimacy, energy, mood)
      VALUES (?, 10, 100, 0)
    `).run(characterId);
  } finally {
    db.close();
  }
}

function withStore(dataDir, fn) {
  const store = createStore(dataDir);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

async function readSnapshot(page) {
  const result = await page.evaluate(() => window.bayper.getSnapshot());
  assert.equal(result.ok, true);
  return result.snapshot;
}

async function waitMemoryLoaded(page) {
  await page.waitForFunction(() => {
    const notice = document.querySelector("#memory-notice");
    return Boolean(notice) && notice.dataset.state !== "loading";
  });
}

async function openMemory(page, { waitForLoad = true } = {}) {
  await page.locator("#memory-open").click();
  await page.locator("#memory-overlay").waitFor({ state: "visible" });
  if (waitForLoad) {
    await waitMemoryLoaded(page);
  }
}

async function selectMemoryCharacter(page, characterId) {
  await page.locator("#memory-character").selectOption(characterId);
  await page.waitForFunction(
    (id) => {
      const select = document.querySelector("#memory-character");
      const notice = document.querySelector("#memory-notice");
      return select?.value === id && notice?.dataset.state !== "loading";
    },
    characterId,
  );
}

async function selectMemoryByBody(page, body) {
  await page.locator(".memory-entry").filter({ hasText: body }).first().click();
  await page.waitForFunction(
    (expected) => document.querySelector("#memory-body")?.value === expected,
    body,
  );
}

async function memoryCards(page) {
  return page.locator(".memory-entry").evaluateAll((nodes) =>
    nodes.map((node) => ({
      body: node.querySelector(".memory-entry-body")?.textContent ?? "",
      meta: node.querySelector(".memory-entry-meta")?.textContent ?? "",
    })),
  );
}

async function collectAllMemoryBodies(page) {
  const bodies = [];
  for (;;) {
    bodies.push(...(await page.locator(".memory-entry-body").allTextContents()));
    const next = page.locator("#memory-next");
    if (await next.isDisabled()) {
      return bodies;
    }
    const label = await page.locator("#memory-page-label").textContent();
    await next.click();
    await page.waitForFunction(
      (previous) => document.querySelector("#memory-page-label")?.textContent !== previous,
      label,
    );
  }
}

async function capture(page, name) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await page.screenshot({ path: path.join(EVIDENCE_DIR, name) });
}

/* Electron 45 的私有 handler 入口只在测试进程内延迟真实 IPC；
   历史读取在真实 DB 结果前暂停，记忆提交在真实事务完成后暂停回包。
   内部结构变化时直接失败，不向生产代码加入测试开关。 */
async function controlIpc(app, action, payload = {}) {
  return app.evaluate(
    async ({ ipcMain }, cmd) => {
      const state = (globalThis.__s03cIpcTest ??= { gates: new Map(), wrapped: new Set() });
      const deferred = () => {
        let resolve;
        const promise = new Promise((done) => {
          resolve = done;
        });
        return { promise, resolve };
      };
      if (cmd.action === "install") {
        const handlers = ipcMain._invokeHandlers;
        if (!(handlers instanceof Map)) {
          throw new Error("Electron 内部 IPC handler 入口不可用。");
        }
        for (const channel of cmd.channels) {
          if (state.wrapped.has(channel)) {
            continue;
          }
          const original = handlers.get(channel);
          if (typeof original !== "function") {
            throw new Error(`找不到 IPC handler：${channel}`);
          }
          ipcMain.removeHandler(channel);
          ipcMain.handle(channel, async (event, ...args) => {
            const afterOriginal = channel === "bayper:memory:correct";
            const key =
              channel === "bayper:chat:conversation"
                ? args[1]
                : channel === "bayper:memory:list"
                  ? args[0]?.characterId
                  : args[0]?.entryId;
            const gateKey = `${channel}:${key}`;
            const candidate = state.gates.get(gateKey);
            const gate = candidate && !candidate.claimed ? candidate : null;
            if (gate) {
              gate.claimed = true;
            }
            if (gate && !afterOriginal) {
              gate.entered.resolve();
              await gate.release.promise;
            }
            const result = original(event, ...args);
            if (gate && afterOriginal) {
              await event.sender.executeJavaScript(
                "window.__s03cIpcEventFlushed=(window.__s03cIpcEventFlushed??0)+1;",
              );
              gate.entered.resolve();
              await gate.release.promise;
            }
            if (gate) {
              state.gates.delete(gateKey);
              setImmediate(() => {
                event.sender
                  .executeJavaScript(`window.__s03cIpcLast=${JSON.stringify(gateKey)};`)
                  .catch(() => {});
              });
            }
            return result;
          });
          state.wrapped.add(channel);
        }
        return true;
      }
      if (cmd.action === "hold") {
        state.gates.set(`${cmd.channel}:${cmd.key}`, {
          entered: deferred(),
          release: deferred(),
        });
        return true;
      }
      const gate = state.gates.get(`${cmd.channel}:${cmd.key}`);
      if (!gate) {
        throw new Error("没有等待中的 IPC 测试门。");
      }
      if (cmd.action === "entered") {
        await gate.entered.promise;
        return true;
      }
      if (cmd.action === "release") {
        gate.release.resolve();
        return true;
      }
      throw new Error(`未知的 IPC 测试操作：${cmd.action}`);
    },
    { action, ...payload },
  );
}

async function memoryPanelState(page) {
  const selected = await page
    .locator(".memory-entry.is-selected .memory-entry-body")
    .allTextContents();
  return {
    character: await page.locator("#memory-character").inputValue(),
    input: await page.locator("#memory-body").inputValue(),
    notice: await page.locator("#memory-notice").textContent(),
    errorHidden: await page.locator("#memory-error").isHidden(),
    editorTitle: await page.locator("#memory-editor-title").textContent(),
    bodyDisabled: await page.locator("#memory-body").isDisabled(),
    selected: selected[0] ?? null,
  };
}

async function waitIpcReply(page, channel, key) {
  const expected = `${channel}:${key}`;
  await page.waitForFunction((value) => window.__s03cIpcLast === value, expected);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

test("POL-MEMUI-001 GUI 角色归属、200+分页与两尺寸操作", { timeout: 60000 }, async () => {
  const dataDir = makeDataDir();
  const server = await startChatServer();
  let app = null;
  try {
    const launched = await launchApp(dataDir);
    app = launched.app;
    await completeOnboarding(launched.page, server.baseUrl);
    await closeApp(app);
    app = null;
    seedCompanion(dataDir, "hu");
    withStore(dataDir, (store) => {
      store.memory.remember({
        characterId: "rin",
        factKey: "pref.white-tea",
        body: "用户喜欢白茶",
        kind: "preference",
        sourceId: "seed:white-tea",
      });
      const heard = store.memory.remember({
        characterId: "hu",
        factKey: "pref.heard-old",
        body: "用户喜欢旧茶",
        kind: "preference",
        sourceId: "seed:heard-old",
      });
      store.memory.share({
        fromCharacterId: "hu",
        toCharacterId: "rin",
        entryIds: [heard.entry.id],
      });
      store.memory.forget({
        characterId: "hu",
        factKey: "pref.heard-old",
        scope: "self",
      });
      for (let index = 0; index < 205; index += 1) {
        store.memory.remember({
          characterId: "rin",
          factKey: `seed.page.${index}`,
          body: `分页构造记忆 ${String(index).padStart(3, "0")}`,
          kind: "detail",
          sourceId: `seed:page:${index}`,
        });
      }
    });

    const relaunched = await launchApp(dataDir);
    app = relaunched.app;
    const page = relaunched.page;
    await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
    const surface = await page.evaluate(() => ({
      keys: Object.keys(window.bayperMemory).sort(),
      hasIpcRenderer: "ipcRenderer" in window,
    }));
    assert.deepEqual(surface.keys, [
      "correctMemory",
      "forgetMemory",
      "listMemories",
      "onMemoryChanged",
    ]);
    assert.equal(surface.hasIpcRenderer, false);
    const before = await readSnapshot(page);
    await openMemory(page);
    await page.waitForFunction(() => document.querySelectorAll(".memory-entry").length > 0);
    const listView = await page.evaluate(() =>
      window.bayperMemory.listMemories({ characterId: "rin", page: 0 }),
    );
    assert.equal(listView.ok, true);
    assert.deepEqual(Object.keys(listView.entries[0]).sort(), [
      "body",
      "derived",
      "id",
      "kind",
      "originCharacterId",
      "trust",
      "version",
    ]);
    const firstCards = await memoryCards(page);
    assert.equal(firstCards.length, 30);
    assert.ok(firstCards.some((card) => card.body === "用户喜欢白茶" && card.meta.includes("本人直接告知")));
    assert.ok(firstCards.some((card) => card.body === "用户喜欢旧茶" && card.meta.includes("听琥珀说过")));

    await selectMemoryByBody(page, "用户喜欢白茶");
    await setWindowSize(app, 1200, 800);
    assert.equal(await page.locator(".memory-dialog").isVisible(), true);
    assert.equal(await page.locator("#memory-save").isVisible(), true);
    assert.equal(
      await page.locator("#memory-list").evaluate((element) => element.scrollHeight > element.clientHeight),
      true,
    );
    await capture(page, "memory-panel-1200x800.png");
    await setWindowSize(app, 960, 680);
    assert.equal(await page.locator(".memory-dialog").isVisible(), true);
    assert.equal(await page.locator("#memory-save").isVisible(), true);
    await capture(page, "memory-panel-960x680.png");

    const shownBodies = await collectAllMemoryBodies(page);
    const expected = readMemoryRows(dataDir, "rin").map((row) => row.body).sort();
    assert.ok(expected.length > 200);
    assert.deepEqual(shownBodies.slice().sort(), expected);

    await selectMemoryCharacter(page, "hu");
    assert.equal(await page.locator("#memory-empty").isVisible(), true);
    assert.equal(await page.locator("#memory-empty").textContent(), "这位角色目前没有可查看的有效记忆。");
    await selectMemoryCharacter(page, "rin");
    await page.waitForFunction(() => document.querySelectorAll(".memory-entry").length > 0);
    const after = await readSnapshot(page);
    assert.equal(after.companionship.current.characterId, before.companionship.current.characterId);
    assert.deepEqual(
      after.companionship.roster.map((entry) => [entry.slot, entry.characterId]),
      before.companionship.roster.map((entry) => [entry.slot, entry.characterId]),
    );
  } finally {
    await closeApp(app);
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("POL-MEMUI-002 GUI 离线纠正、默认删除与重启一致性", { timeout: 60000 }, async () => {
  const dataDir = makeDataDir();
  const server = await startChatServer();
  let app = null;
  try {
    const launched = await launchApp(dataDir);
    app = launched.app;
    await completeOnboarding(launched.page, server.baseUrl);
    await closeApp(app);
    app = null;
    seedCompanion(dataDir, "hu");
    const relaunched = await launchApp(dataDir);
    app = relaunched.app;
    const page = relaunched.page;
    await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
    await page.locator("#chat-current").click();
    await page.waitForFunction(() => document.querySelector("#chat-panel")?.hidden === false);
    server.enqueue(({ response }) =>
      sendStructured(response, {
        reply: "记住了。",
        memoryCandidates: [
          {
            factKey: "pref.white-tea",
            body: "用户喜欢白茶",
            kind: "preference",
            trust: "stated",
            evidence: "我喜欢白茶",
          },
          {
            factKey: "pref.old-book",
            body: "用户喜欢旧书",
            kind: "preference",
            trust: "stated",
            evidence: "我喜欢旧书",
          },
          {
            factKey: "pref.green-tea",
            body: "用户喜欢绿茶",
            kind: "preference",
            trust: "stated",
            evidence: "我喜欢绿茶",
          },
        ],
      }),
    );
    await page.locator("#chat-input").fill("我喜欢白茶。我喜欢旧书。我喜欢绿茶。");
    await page.locator("#chat-send").click();
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll(".chat-bubble-assistant")).some((element) =>
        element.textContent.includes("记住了。"),
      ),
    );
    const requestsAfterChat = server.requests.length;
    await page.locator("#chat-close").click();
    await page.locator("#chat-panel").waitFor({ state: "hidden" });
    await closeApp(app);
    app = null;

    withStore(dataDir, (store) => {
      const entries = store.memory.listMemories("rin");
      assert.equal(entries.length, 3);
      store.memory.share({
        fromCharacterId: "rin",
        toCharacterId: "hu",
        entryIds: entries.map((entry) => entry.id),
      });
    });
    await server.close();
    const reopened = await launchApp(dataDir);
    app = reopened.app;
    const page2 = reopened.page;
    await page2.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
    const statsBefore = readStats(dataDir);
    const chatBefore = readChatMessages(dataDir);

    await openMemory(page2);
    await selectMemoryByBody(page2, "我喜欢白茶");
    await page2.locator("#memory-body").fill("用户喜欢新白茶");
    await page2.locator("#memory-save").click();
    await page2.waitForFunction(() =>
      Array.from(document.querySelectorAll(".memory-entry-body")).some(
        (element) => element.textContent === "用户喜欢新白茶",
      ),
    );
    let rinRows = readMemoryRows(dataDir, "rin");
    let huRows = readMemoryRows(dataDir, "hu");
    assert.deepEqual(rinRows.map((row) => row.body).sort(), [
      "我喜欢旧书",
      "我喜欢绿茶",
      "用户喜欢新白茶",
    ]);
    assert.deepEqual(huRows.map((row) => row.body).sort(), [
      "我喜欢旧书",
      "我喜欢绿茶",
      "用户喜欢新白茶",
    ]);
    assert.equal(readMemoryRows(dataDir, "cheng").length, 0);

    assert.equal(
      await page2.locator('input[name="memory-scope"][value="all"]').isChecked(),
      true,
    );
    await selectMemoryByBody(page2, "我喜欢旧书");
    await page2.locator("#memory-delete").click();
    await page2.waitForFunction(
      () =>
        !Array.from(document.querySelectorAll(".memory-entry-body")).some(
          (element) => element.textContent === "我喜欢旧书",
        ),
    );
    await selectMemoryByBody(page2, "我喜欢绿茶");
    await page2.locator('input[name="memory-scope"][value="self"]').check();
    await page2.locator("#memory-delete").click();
    await page2.waitForFunction(
      () =>
        !Array.from(document.querySelectorAll(".memory-entry-body")).some(
          (element) => element.textContent === "我喜欢绿茶",
        ),
    );
    rinRows = readMemoryRows(dataDir, "rin");
    huRows = readMemoryRows(dataDir, "hu");
    assert.deepEqual(rinRows.map((row) => row.body), ["用户喜欢新白茶"]);
    assert.deepEqual(huRows.map((row) => row.body).sort(), ["我喜欢绿茶", "用户喜欢新白茶"]);
    assert.equal(readMemoryRows(dataDir, "cheng").length, 0);
    assert.equal(server.requests.length, requestsAfterChat);
    const statsAfter = readStats(dataDir);
    for (const beforeRow of statsBefore) {
      const afterRow = statsAfter.find((row) => row.character_id === beforeRow.character_id);
      assert.equal(afterRow.intimacy, beforeRow.intimacy);
      assert.equal(afterRow.mood, beforeRow.mood);
      assert.ok(afterRow.energy >= beforeRow.energy - 0.01);
    }
    assert.deepEqual(readChatMessages(dataDir), chatBefore);

    await closeApp(app);
    app = null;
    const persisted = withStore(dataDir, (store) => ({
      rin: store.memory.listMemories("rin").map((entry) => entry.body),
      hu: store.memory.listMemories("hu").map((entry) => entry.body),
      newHits: store.memory.searchMemories({ characterId: "rin", query: "新白茶" }).length,
      oldHits: store.memory.searchMemories({ characterId: "rin", query: "旧书" }).length,
      greenRin: store.memory.searchMemories({ characterId: "rin", query: "绿茶" }).length,
      greenHu: store.memory.searchMemories({ characterId: "hu", query: "绿茶" }).length,
    }));
    assert.deepEqual(persisted.rin, ["用户喜欢新白茶"]);
    assert.deepEqual(persisted.hu.sort(), ["我喜欢绿茶", "用户喜欢新白茶"]);
    assert.equal(persisted.newHits, 1);
    assert.equal(persisted.oldHits, 0);
    assert.equal(persisted.greenRin, 0);
    assert.equal(persisted.greenHu, 1);

    const restarted = await launchApp(dataDir);
    app = restarted.app;
    await restarted.page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
    await openMemory(restarted.page);
    const bodies = await restarted.page.locator(".memory-entry-body").allTextContents();
    assert.deepEqual(bodies, ["用户喜欢新白茶"]);
  } finally {
    await closeApp(app);
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("POL-MEMUI-003 GUI 在途回复在纠正后失效且下一轮使用新事实", { timeout: 60000 }, async () => {
  const dataDir = makeDataDir();
  const server = await startChatServer();
  let app = null;
  let release;
  try {
    const launched = await launchApp(dataDir);
    app = launched.app;
    const page = launched.page;
    await completeOnboarding(page, server.baseUrl);
    await page.locator("#chat-current").click();
    await page.waitForFunction(() => document.querySelector("#chat-panel")?.hidden === false);
    server.enqueue(({ response }) =>
      sendStructured(response, {
        reply: "记住了旧茶。",
        memoryCandidates: [
          {
            factKey: "pref.tea",
            body: "用户喜欢旧茶",
            kind: "preference",
            trust: "stated",
            evidence: "我喜欢旧茶",
          },
        ],
      }),
    );
    await page.locator("#chat-input").fill("我喜欢旧茶。");
    await page.locator("#chat-send").click();
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll(".chat-bubble-assistant")).some((element) =>
        element.textContent.includes("记住了旧茶。"),
      ),
    );
    await page.waitForFunction(() =>
      document.querySelector("#chat-memory-status")?.textContent?.includes("已保存1条记忆"),
    );

    await openMemory(page);
    await selectMemoryByBody(page, "我喜欢旧茶");
    await page.locator("#memory-body").fill("用户喜欢新茶");
    await page.locator("#memory-save").click();
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll(".memory-entry-body")).some(
        (element) => element.textContent === "用户喜欢新茶",
      ),
    );
    assert.equal(await page.locator("#chat-memory-status").isHidden(), true);
    assert.equal(await page.locator(".chat-bubble").count(), 0);
    assert.ok(
      readChatMessages(dataDir).some(
        (message) => message.role === "assistant" && message.content === "记住了旧茶。",
      ),
    );
    await page.locator("#memory-close").click();
    await page.locator("#memory-overlay").waitFor({ state: "hidden" });

    const delayedBaseline = server.requests.length;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    server.enqueue(async ({ response }) => {
      await gate;
      sendStructured(response, {
        reply: "旧茶回复",
        memoryCandidates: [
          {
            factKey: "stale.candidate",
            body: "用户喝什么茶",
            kind: "detail",
            trust: "stated",
            evidence: "我喝什么茶",
          },
        ],
      });
    });
    await page.locator("#chat-input").fill("我喝什么茶？");
    await page.locator("#chat-send").click();
    await waitFor(() => server.requests.length >= delayedBaseline + 1);
    await page.locator("#chat-cancel").waitFor({ state: "visible" });

    await openMemory(page);
    await selectMemoryByBody(page, "用户喜欢新茶");
    await page.locator("#memory-body").fill("用户现在喜欢乌龙茶");
    await page.locator("#memory-save").click();
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll(".memory-entry-body")).some(
        (element) => element.textContent === "用户现在喜欢乌龙茶",
      ),
    );
    await page.waitForFunction(() =>
      document.querySelector("#chat-status")?.textContent?.includes("记忆已更新"),
    );
    await page.locator("#memory-close").click();
    await page.locator("#memory-overlay").waitFor({ state: "hidden" });

    release();
    await page.waitForFunction(() =>
      document.querySelector("#chat-status")?.textContent?.includes("旧回复没有显示"),
    );
    assert.equal(
      await page.locator(".chat-bubble-assistant").filter({ hasText: "旧茶回复" }).count(),
      0,
    );
    assert.equal(await page.locator(".chat-bubble-assistant").count(), 0);
    const rows = readMemoryRows(dataDir, "rin");
    assert.equal(rows.some((row) => row.fact_key === "stale.candidate"), false);

    server.enqueue(({ response }) => sendText(response, "乌龙茶回复"));
    await page.locator("#chat-input").fill("现在呢？");
    await page.locator("#chat-send").click();
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll(".chat-bubble-assistant")).some((element) =>
        element.textContent.includes("乌龙茶回复"),
      ),
    );
    const shownHistory = await page.locator("#chat-history").textContent();
    assert.equal(shownHistory.includes("记住了旧茶。"), false);
    assert.equal(shownHistory.includes("我喜欢旧茶。"), false);
    const lastRequest = server.requests.at(-1);
    const memoryPrompt = lastRequest.messages.find(
      (message) => message.role === "system" && message.content.includes("本轮可用的记忆"),
    )?.content;
    assert.ok(memoryPrompt?.includes("用户现在喜欢乌龙茶"));
    assert.equal(memoryPrompt?.includes("用户喜欢旧茶"), false);
    assert.equal(JSON.stringify(lastRequest.messages).includes("我喜欢旧茶"), false);
    const requests = readDbRequests(dataDir);
    assert.deepEqual(
      requests.map((request) => request.status),
      ["completed", "stale", "completed"],
    );
  } finally {
    release?.();
    await closeApp(app);
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("POL-MEMUI-004 GUI 旧版本与 SQLite 故障不假报成功", { timeout: 60000 }, async () => {
  const dataDir = makeDataDir();
  const server = await startChatServer();
  let app = null;
  try {
    const launched = await launchApp(dataDir);
    app = launched.app;
    await completeOnboarding(launched.page, server.baseUrl);
    await closeApp(app);
    app = null;
    seedCompanion(dataDir, "hu");
    withStore(dataDir, (store) => {
      store.memory.remember({
        characterId: "rin",
        factKey: "pref.book",
        body: "用户喜欢旧书",
        kind: "preference",
        sourceId: "seed:book",
      });
      store.memory.remember({
        characterId: "hu",
        factKey: "pref.hu-book",
        body: "用户喜欢画册",
        kind: "preference",
        sourceId: "seed:hu-book",
      });
    });
    const reopened = await launchApp(dataDir);
    app = reopened.app;
    const page = reopened.page;
    await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
    await openMemory(page);
    await selectMemoryByBody(page, "用户喜欢旧书");
    const entry = readMemoryRows(dataDir, "rin").find((row) => row.body === "用户喜欢旧书");
    let db = openDb(dataDir);
    db.prepare(
      "UPDATE memory_entries SET body = ?, version = version + 1, updated_at = updated_at + 1 WHERE id = ?",
    ).run("外部新理解", entry.id);
    db.close();

    await page.locator("#memory-body").fill("用户想覆盖旧版本");
    await page.locator("#memory-save").click();
    await page.locator("#memory-error").waitFor({ state: "visible" });
    assert.match(await page.locator("#memory-error").textContent(), /记忆已更新/);
    assert.equal(await page.locator("#memory-body").inputValue(), "用户想覆盖旧版本");
    assert.equal(
      readMemoryRows(dataDir, "rin").find((row) => row.id === entry.id).body,
      "外部新理解",
    );

    await selectMemoryByBody(page, "外部新理解");
    await page.locator("#memory-body").fill("用户最终喜欢新书");
    await page.locator("#memory-save").click();
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll(".memory-entry-body")).some(
        (element) => element.textContent === "用户最终喜欢新书",
      ),
    );
    assert.equal(
      readMemoryRows(dataDir, "rin").find((row) => row.id === entry.id).body,
      "用户最终喜欢新书",
    );

    const huBefore = readMemoryRows(dataDir, "hu");
    await selectMemoryByBody(page, "用户最终喜欢新书");
    await page.locator("#memory-body").fill("触发失败后保留输入");
    db = openDb(dataDir);
    db.exec(`
      CREATE TRIGGER fail_memory_update
      BEFORE UPDATE ON memory_entries
      BEGIN
        SELECT RAISE(ABORT, 'injected memory failure');
      END;
    `);
    db.close();
    await page.locator("#memory-save").click();
    await page.locator("#memory-error").waitFor({ state: "visible" });
    assert.equal(await page.locator("#memory-body").inputValue(), "触发失败后保留输入");
    assert.equal(
      readMemoryRows(dataDir, "rin").find((row) => row.id === entry.id).body,
      "用户最终喜欢新书",
    );
    assert.deepEqual(readMemoryRows(dataDir, "hu"), huBefore);

    db = openDb(dataDir);
    db.exec("DROP TRIGGER fail_memory_update;");
    db.close();
    await page.locator("#memory-save").click();
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll(".memory-entry-body")).some(
        (element) => element.textContent === "触发失败后保留输入",
      ),
    );
    assert.equal(
      readMemoryRows(dataDir, "rin").find((row) => row.id === entry.id).body,
      "触发失败后保留输入",
    );
    assert.deepEqual(readMemoryRows(dataDir, "hu"), huBefore);

    await selectMemoryByBody(page, "触发失败后保留输入");
    db = openDb(dataDir);
    db.exec(`
      CREATE TRIGGER fail_memory_delete
      BEFORE DELETE ON memory_entries
      BEGIN
        SELECT RAISE(ABORT, 'injected memory delete failure');
      END;
    `);
    db.close();
    await page.locator("#memory-delete").click();
    await page.locator("#memory-error").waitFor({ state: "visible" });
    assert.equal(await page.locator("#memory-body").inputValue(), "触发失败后保留输入");
    assert.equal(
      readMemoryRows(dataDir, "rin").find((row) => row.id === entry.id).body,
      "触发失败后保留输入",
    );
    db = openDb(dataDir);
    db.exec("DROP TRIGGER fail_memory_delete;");
    db.close();
  } finally {
    await closeApp(app);
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("POL-MEMUI-005 GUI 记忆变更清理当前聊天显示与历史回包", { timeout: 60000 }, async () => {
  const dataDir = makeDataDir();
  const server = await startChatServer();
  let app = null;
  try {
    const launched = await launchApp(dataDir);
    app = launched.app;
    await completeOnboarding(launched.page, server.baseUrl);
    await closeApp(app);
    app = null;
    seedCompanion(dataDir, "hu");
    withStore(dataDir, (store) => {
      store.memory.remember({
        characterId: "rin",
        factKey: "pref.old-tea",
        body: "用户喜欢旧茶",
        kind: "preference",
        sourceId: "seed:old-tea",
      });
      store.memory.remember({
        characterId: "rin",
        factKey: "detail.tea-set",
        body: "用户收藏旧茶具",
        kind: "detail",
        sourceId: "seed:tea-set",
      });
      store.memory.remember({
        characterId: "hu",
        factKey: "pref.hu-book",
        body: "用户喜欢画册",
        kind: "preference",
        sourceId: "seed:hu-book",
      });
    });
    const reopened = await launchApp(dataDir);
    app = reopened.app;
    const page = reopened.page;
    await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });

    await page.locator("#chat-current").click();
    await page.waitForFunction(() => document.querySelector("#chat-panel")?.hidden === false);
    server.enqueue(({ response }) => sendText(response, "第一段回复。"));
    await page.locator("#chat-input").fill("第一段聊天");
    await page.locator("#chat-send").click();
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll(".chat-bubble-assistant")).some((element) =>
        element.textContent.includes("第一段回复。"),
      ),
    );
    await page.locator("#chat-close").click();
    await page.locator("#chat-panel").waitFor({ state: "hidden" });

    await page.locator("#chat-current").click();
    await page.locator("#chat-history-bar").waitFor({ state: "visible" });
    await page.locator("#chat-continue").click();
    server.enqueue(({ response }) => sendText(response, "第二段回复。"));
    await page.locator("#chat-input").fill("第二段聊天");
    await page.locator("#chat-send").click();
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll(".chat-bubble-assistant")).some((element) =>
        element.textContent.includes("第二段回复。"),
      ),
    );
    await page.locator("#chat-input").fill("还没发送的草稿");
    const chatBefore = readChatMessages(dataDir);

    await openMemory(page);
    await selectMemoryCharacter(page, "hu");
    await selectMemoryByBody(page, "用户喜欢画册");
    await page.locator("#memory-body").fill("用户现在喜欢画册");
    await page.locator("#memory-save").click();
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll(".memory-entry-body")).some(
        (element) => element.textContent === "用户现在喜欢画册",
      ),
    );
    assert.ok((await page.locator(".chat-bubble").count()) > 0);
    assert.equal(await page.locator("#chat-input").inputValue(), "还没发送的草稿");

    await selectMemoryCharacter(page, "rin");
    await selectMemoryByBody(page, "用户喜欢旧茶");
    await page.locator("#memory-body").fill("用户喜欢新茶");
    await page.locator("#memory-save").click();
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll(".memory-entry-body")).some(
        (element) => element.textContent === "用户喜欢新茶",
      ),
    );
    await page.locator("#memory-close").click();
    await page.locator("#memory-overlay").waitFor({ state: "hidden" });

    assert.equal(await page.locator(".chat-bubble").count(), 0);
    assert.equal(await page.locator("#chat-input").inputValue(), "还没发送的草稿");
    assert.equal(await page.locator("#chat-form").isVisible(), true);
    assert.equal(await page.locator("#chat-history-origin").isVisible(), true);
    assert.match(await page.locator("#chat-history-origin").textContent(), /收起/);
    assert.deepEqual(readChatMessages(dataDir), chatBefore);
    await capture(page, "chat-memory-cleared-1200x800.png");

    await page.locator("#chat-close").click();
    await page.locator("#chat-panel").waitFor({ state: "hidden" });
    await page.locator("#chat-current").click();
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll(".chat-bubble-assistant")).some((element) =>
        element.textContent.includes("第二段回复。"),
      ),
    );
    assert.equal(await page.locator("#chat-history-origin").isVisible(), true);
    assert.match(await page.locator("#chat-history-origin").textContent(), /历史原文/);
    assert.equal(await page.locator(".chat-bubble").count(), 2);
    await capture(page, "chat-history-original-1200x800.png");

    const messages = readChatMessages(dataDir);
    const firstConversation = messages.find((message) => message.content === "第一段聊天")
      ?.conversation_id;
    const secondConversation = messages.find((message) => message.content === "第二段聊天")
      ?.conversation_id;
    assert.ok(firstConversation && secondConversation);
    await controlIpc(app, "install", {
      channels: ["bayper:chat:conversation", "bayper:memory:correct"],
    });
    await page.evaluate(() => {
      window.__s03cIpcLast = null;
    });
    await controlIpc(app, "hold", {
      channel: "bayper:chat:conversation",
      key: firstConversation,
    });
    await page.locator("#chat-history-select").selectOption(firstConversation);
    await controlIpc(app, "entered", {
      channel: "bayper:chat:conversation",
      key: firstConversation,
    });

    await openMemory(page);
    await selectMemoryByBody(page, "用户收藏旧茶具");
    await page.locator("#memory-delete").click();
    await page.waitForFunction(
      () =>
        !Array.from(document.querySelectorAll(".memory-entry-body")).some(
          (element) => element.textContent === "用户收藏旧茶具",
        ),
    );
    await page.locator("#memory-close").click();
    await page.locator("#memory-overlay").waitFor({ state: "hidden" });
    assert.equal(await page.locator(".chat-bubble").count(), 0);
    assert.match(await page.locator("#chat-history-origin").textContent(), /收起/);

    await controlIpc(app, "release", {
      channel: "bayper:chat:conversation",
      key: firstConversation,
    });
    await waitIpcReply(page, "bayper:chat:conversation", firstConversation);
    assert.equal(await page.locator(".chat-bubble").count(), 0);
    assert.equal(await page.locator("#chat-history-select").inputValue(), "");
    const historyText = await page.locator("#chat-history").textContent();
    assert.equal(historyText.includes("第一段回复。"), false);

    await page.locator("#chat-history-select").selectOption(firstConversation);
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll(".chat-bubble-assistant")).some((element) =>
        element.textContent.includes("第一段回复。"),
      ),
    );
    assert.match(await page.locator("#chat-history-origin").textContent(), /历史原文/);
    assert.equal(await page.locator(".chat-bubble").count(), 2);
    assert.deepEqual(readChatMessages(dataDir), chatBefore);
  } finally {
    await closeApp(app);
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("POL-MEMUI-006 GUI 旧提交回包不能覆盖关闭重开后的新面板", { timeout: 60000 }, async () => {
  const dataDir = makeDataDir();
  const server = await startChatServer();
  let app = null;
  try {
    const launched = await launchApp(dataDir);
    app = launched.app;
    await completeOnboarding(launched.page, server.baseUrl);
    await closeApp(app);
    app = null;
    seedCompanion(dataDir, "hu");
    withStore(dataDir, (store) => {
      store.memory.remember({
        characterId: "rin",
        factKey: "pref.old-tea",
        body: "用户喜欢旧茶",
        kind: "preference",
        sourceId: "seed:old-tea",
      });
      store.memory.remember({
        characterId: "hu",
        factKey: "pref.hu-book",
        body: "用户喜欢画册",
        kind: "preference",
        sourceId: "seed:hu-book",
      });
    });
    const reopened = await launchApp(dataDir);
    app = reopened.app;
    const page = reopened.page;
    await page.locator('[data-step="home"]').waitFor({ state: "visible", timeout: 20000 });
    const oldEntry = readMemoryRows(dataDir, "rin").find(
      (entry) => entry.body === "用户喜欢旧茶",
    );
    const newEntry = readMemoryRows(dataDir, "hu").find(
      (entry) => entry.body === "用户喜欢画册",
    );
    await openMemory(page);
    await selectMemoryByBody(page, "用户喜欢旧茶");
    await page.locator("#memory-body").fill("旧提交正文");
    await controlIpc(app, "install", { channels: ["bayper:memory:correct"] });
    await page.evaluate(() => {
      window.__s03cIpcLast = null;
    });
    await controlIpc(app, "hold", {
      channel: "bayper:memory:correct",
      key: oldEntry.id,
    });
    await page.locator("#memory-save").click();
    await controlIpc(app, "entered", {
      channel: "bayper:memory:correct",
      key: oldEntry.id,
    });
    await page.locator("#memory-close").click();
    await page.locator("#memory-overlay").waitFor({ state: "hidden" });

    await openMemory(page);
    await selectMemoryCharacter(page, "hu");
    await selectMemoryByBody(page, "用户喜欢画册");
    await page.locator("#memory-body").fill("新面板草稿");
    await controlIpc(app, "release", {
      channel: "bayper:memory:correct",
      key: oldEntry.id,
    });
    await waitIpcReply(page, "bayper:memory:correct", oldEntry.id);

    assert.equal(await page.locator("#memory-character").inputValue(), "hu");
    assert.equal(await page.locator("#memory-body").inputValue(), "新面板草稿");
    assert.equal(
      await page.locator(".memory-entry.is-selected .memory-entry-body").textContent(),
      "用户喜欢画册",
    );
    assert.equal((await page.locator("#memory-notice").textContent()).includes("已保存修改。"), false);
    assert.equal(readMemoryRows(dataDir, "rin").find((entry) => entry.id === oldEntry.id).body, "旧提交正文");
    assert.equal(
      readMemoryRows(dataDir, "hu").find((entry) => entry.id === newEntry.id).body,
      "用户喜欢画册",
    );

    await page.locator("#memory-body").fill("成功list提交");
    await controlIpc(app, "install", { channels: ["bayper:memory:list"] });
    await page.evaluate(() => {
      window.__s03cIpcLast = null;
    });
    await controlIpc(app, "hold", { channel: "bayper:memory:list", key: "hu" });
    await page.locator("#memory-save").click();
    await controlIpc(app, "entered", { channel: "bayper:memory:list", key: "hu" });
    await page.locator("#memory-close").click();
    await page.locator("#memory-overlay").waitFor({ state: "hidden" });
    await openMemory(page);
    await selectMemoryCharacter(page, "rin");
    await selectMemoryByBody(page, "旧提交正文");
    await page.locator("#memory-body").fill("成功list新草稿");
    await controlIpc(app, "release", { channel: "bayper:memory:list", key: "hu" });
    await waitIpcReply(page, "bayper:memory:list", "hu");
    const successView = await memoryPanelState(page);

    await page.locator("#memory-close").click();
    await page.locator("#memory-overlay").waitFor({ state: "hidden" });
    await openMemory(page);
    await selectMemoryCharacter(page, "rin");
    await selectMemoryByBody(page, "旧提交正文");
    const conflicted = readMemoryRows(dataDir, "rin").find(
      (entry) => entry.body === "旧提交正文",
    );
    let db = openDb(dataDir);
    db.prepare(
      "UPDATE memory_entries SET body = ?, version = version + 1, updated_at = updated_at + 1 WHERE id = ?",
    ).run("外部列表冲突", conflicted.id);
    db.close();
    await page.locator("#memory-body").fill("冲突list提交");
    await page.evaluate(() => {
      window.__s03cIpcLast = null;
    });
    await controlIpc(app, "hold", { channel: "bayper:memory:list", key: "rin" });
    await page.locator("#memory-save").click();
    await controlIpc(app, "entered", { channel: "bayper:memory:list", key: "rin" });
    await page.locator("#memory-close").click();
    await page.locator("#memory-overlay").waitFor({ state: "hidden" });
    await openMemory(page);
    await selectMemoryCharacter(page, "hu");
    await selectMemoryByBody(page, "成功list提交");
    await page.locator("#memory-body").fill("冲突list新草稿");
    await controlIpc(app, "release", { channel: "bayper:memory:list", key: "rin" });
    await waitIpcReply(page, "bayper:memory:list", "rin");
    const conflictView = await memoryPanelState(page);

    assert.deepEqual(
      { success: successView, conflict: conflictView },
      {
        success: {
          character: "rin",
          input: "成功list新草稿",
          notice: "",
          errorHidden: true,
          editorTitle: "编辑这条记忆",
          bodyDisabled: false,
          selected: "旧提交正文",
        },
        conflict: {
          character: "hu",
          input: "冲突list新草稿",
          notice: "",
          errorHidden: true,
          editorTitle: "编辑这条记忆",
          bodyDisabled: false,
          selected: "成功list提交",
        },
      },
    );
    assert.equal(
      readMemoryRows(dataDir, "rin").find((entry) => entry.id === conflicted.id).body,
      "外部列表冲突",
    );
    assert.equal(
      readMemoryRows(dataDir, "hu").find((entry) => entry.id === newEntry.id).body,
      "成功list提交",
    );
  } finally {
    await closeApp(app);
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

function readDbRequests(dataDir) {
  const db = openDb(dataDir, true);
  try {
    return db.prepare("SELECT id, status FROM chat_requests ORDER BY created_at, id").all();
  } finally {
    db.close();
  }
}
