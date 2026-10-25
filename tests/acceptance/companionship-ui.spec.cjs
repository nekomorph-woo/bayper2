const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { _electron: electron } = require("playwright");
const { startModelServer } = require("./fixture-server.cjs");
const {
  dbPath,
  localDay,
  createLegacyDatabase,
  readRelationships,
} = require("./s02-fixtures.cjs");

const electronPath = require("electron");
const repoRoot = path.resolve(__dirname, "..", "..");
const DB_FILE = "bayper.sqlite3";

async function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-s02-ui-"));
  const server = await startModelServer();
  return { dataDir, server };
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

async function waitForStep(page, name) {
  await page.locator(`[data-step="${name}"]`).waitFor({ state: "visible", timeout: 20000 });
}

async function openPage(page, name) {
  await page.locator(`[data-nav="${name}"]`).click();
  await page.locator(`[data-page="${name}"]`).waitFor({ state: "visible", timeout: 10000 });
}

async function openArrange(page) {
  await openPage(page, "characters");
  await page.locator('[data-character-tab="arrange"]').click();
  await page.locator("#fixed-select").waitFor({ state: "visible", timeout: 10000 });
}

async function completeOnboarding(page, baseUrl) {
  await page.locator("#base-url").fill(baseUrl);
  await page.locator("#model-name").fill("fixture-model");
  await page.locator("#api-key").fill("sk-fixture-ok");
  await page.locator("#config-submit").click();
  await waitForStep(page, "wish");
  await page.locator("#wish-submit").click();
  await page.locator("#candidate-card").waitFor({ state: "visible" });
  await page.locator("#accept-button").click();
  await waitForStep(page, "home");
}

async function getSnapshot(page) {
  const result = await page.evaluate(() => window.bayper.getSnapshot());
  assert.equal(result.ok, true);
  return result.snapshot;
}

async function closeApp(app) {
  if (app) {
    try {
      await app.close();
    } catch {
      // 清理继续。
    }
  }
}

function addCompanions(dataDir) {
  const db = new DatabaseSync(dbPath(dataDir));
  try {
    const acceptedAt = new Date().toISOString();
    for (const id of ["hu", "cheng"]) {
      db.prepare("INSERT INTO relationships (character_id, accepted_at) VALUES (?, ?)").run(
        id,
        acceptedAt,
      );
      db.prepare(`
        INSERT INTO character_stats (character_id, intimacy, energy, mood)
        VALUES (?, 10, 100, 0)
      `).run(id);
    }
    db.prepare("DELETE FROM roster WHERE day = ?").run(localDay(new Date()));
  } finally {
    db.close();
  }
}

function waitForText(page, selector, text) {
  return page.waitForFunction(
    ({ target, expected }) => document.querySelector(target)?.textContent === expected,
    { target: selector, expected: text },
    { timeout: 10000 },
  );
}

test("POL-COMPANION-002 UI：真实窗口查看名单、修改固定位与昵称", async () => {
  const ctx = await setup();
  let app = null;
  try {
    const first = await launchApp(ctx.dataDir);
    app = first.app;
    const page = first.page;
    await waitForStep(page, "config");
    await completeOnboarding(page, ctx.server.baseUrl);
    assert.match(await page.locator("#home-current").textContent(), /凛/);
    assert.equal(await page.locator("#roster-list .roster-row").count(), 1);

    await closeApp(app);
    app = null;
    addCompanions(ctx.dataDir);

    const second = await launchApp(ctx.dataDir);
    app = second.app;
    const page2 = second.page;
    await waitForStep(page2, "home");
    assert.equal(await page2.locator("#roster-list .roster-row").count(), 3);
    await openArrange(page2);
    assert.equal(await page2.locator("#fixed-select").inputValue(), "rin");

    const before = await getSnapshot(page2);
    const chengSlot = before.companionship.roster.find(
      (entry) => entry.characterId === "cheng",
    ).slot;

    await page2.selectOption("#fixed-select", "hu");
    await page2.locator("#fixed-save").click();
    await waitForText(page2, "#arrange-status", "固定陪伴已更新。");
    const afterFixed = await getSnapshot(page2);
    assert.equal(afterFixed.companionship.fixedCharacterId, "hu");
    const fixedRow = afterFixed.companionship.roster.find((entry) => entry.isFixed);
    assert.equal(fixedRow.characterId, "hu");
    assert.equal(
      afterFixed.companionship.roster.find((entry) => entry.characterId === "cheng").slot,
      chengSlot,
      "其他随机位不应重抽",
    );
    assert.equal(
      afterFixed.companionship.roster.some((entry) => entry.characterId === "rin"),
      true,
    );

    const beforeStats = readRelationships(ctx.dataDir).find((row) => row.character_id === "cheng");
    await page2.selectOption("#nickname-character", "cheng");
    await page2.locator("#nickname-input").fill("小澄");
    await page2.locator("#nickname-save").click();
    await waitForText(page2, "#arrange-status", "昵称已保存。");
    const afterNickname = await getSnapshot(page2);
    assert.equal(
      afterNickname.companionship.characters.find((entry) => entry.characterId === "cheng")
        .displayName,
      "小澄",
    );
    await openPage(page2, "home");
    assert.match(
      await page2.locator('.roster-row[data-character-id="cheng"] .roster-name').textContent(),
      /小澄/,
    );
    const afterStats = readRelationships(ctx.dataDir).find((row) => row.character_id === "cheng");
    assert.equal(afterStats.accepted_at, beforeStats.accepted_at);
    assert.ok(
      Math.abs(afterStats.energy - beforeStats.energy) < 1,
      "改昵称不应造成数值跳变；微小差异仅来自真实时间结算",
    );

    await closeApp(app);
    app = null;
    const third = await launchApp(ctx.dataDir);
    app = third.app;
    await waitForStep(third.page, "home");
    await openArrange(third.page);
    assert.equal(await third.page.locator("#fixed-select").inputValue(), "hu");
    await openPage(third.page, "home");
    assert.match(
      await third.page.locator('.roster-row[data-character-id="cheng"] .roster-name').textContent(),
      /小澄/,
    );
    assert.equal(await third.page.locator("#roster-list .roster-row").count(), 3);
  } finally {
    await closeApp(app);
    await ctx.server.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test("POL-COMPANION-003 UI：手动陪伴、安静休息并重启保持", async () => {
  const ctx = await setup();
  let app = null;
  try {
    const first = await launchApp(ctx.dataDir);
    app = first.app;
    await waitForStep(first.page, "config");
    await completeOnboarding(first.page, ctx.server.baseUrl);
    await closeApp(app);
    app = null;
    addCompanions(ctx.dataDir);

    const second = await launchApp(ctx.dataDir);
    app = second.app;
    const page = second.page;
    await waitForStep(page, "home");
    const before = await getSnapshot(page);
    const rosterBefore = before.companionship.roster.map((entry) => [
      entry.slot,
      entry.characterId,
    ]);

    await page.locator('.roster-row[data-character-id="cheng"] button[data-action="switch"]').click();
    await waitForText(page, "#home-name", "澄");
    await waitForText(page, "#presence-status", "已切换到这位 Bayper。");
    const switched = await getSnapshot(page);
    assert.equal(switched.companionship.current.characterId, "cheng");
    assert.deepEqual(
      switched.companionship.roster.map((entry) => [entry.slot, entry.characterId]),
      rosterBefore,
      "手动陪伴不应改变名单",
    );

    await page.locator("#rest-companion").click();
    await waitForText(page, "#presence-status", "已进入安静休息。");
    assert.match(await page.locator("#home-current").textContent(), /安静休息中/);
    const rested = await getSnapshot(page);
    assert.equal(rested.companionship.current.source, "resting");

    await page.locator("#rest-companion").click();
    await waitForText(page, "#presence-status", "已继续陪伴。");
    assert.equal(
      (await getSnapshot(page)).companionship.current.source,
      "roster",
      "休息后应能继续陪伴",
    );
    await page.locator("#rest-companion").click();
    await waitForText(page, "#presence-status", "已进入安静休息。");

    await closeApp(app);
    app = null;
    const third = await launchApp(ctx.dataDir);
    app = third.app;
    await waitForStep(third.page, "home");
    await waitForText(third.page, "#home-name", "澄");
    const afterRestart = await getSnapshot(third.page);
    assert.equal(afterRestart.companionship.current.characterId, "cheng");
    assert.equal(afterRestart.companionship.current.source, "resting");
    assert.deepEqual(
      afterRestart.companionship.roster.map((entry) => [entry.slot, entry.characterId]),
      rosterBefore,
    );
    assert.equal(await third.page.locator("#chat-send").count(), 0, "不得出现可发送的假聊天入口");
  } finally {
    await closeApp(app);
    await ctx.server.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test("POL-COMPANION-006 UI：旧 S01 库经真实应用启动升级并保留数据", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-s02-legacy-ui-"));
  const cipher = Buffer.from([4, 3, 2, 1]);
  const acceptedAt = "2026-10-20T09:00:00.000Z";
  let app = null;
  try {
    createLegacyDatabase(dataDir, {
      characters: [{ id: "rin", acceptedAt, energy: 55 }],
      modelCipher: cipher,
      baseUrl: "https://legacy.example.com/v1",
      modelName: "legacy-model",
      fixedId: "rin",
      currentId: "rin",
      rosterDay: localDay(new Date()),
    });

    const first = await launchApp(dataDir);
    app = first.app;
    await waitForStep(first.page, "home");
    await waitForText(first.page, "#home-name", "凛");
    assert.equal(await first.page.locator("#stat-energy").textContent(), "55");
    await openArrange(first.page);
    assert.equal(await first.page.locator("#fixed-select").inputValue(), "rin");
    assert.equal(await first.page.locator("#chat-send").count(), 0);

    await closeApp(app);
    app = null;

    const db = new DatabaseSync(dbPath(dataDir), { readOnly: true });
    try {
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, 1);
      const model = db.prepare("SELECT api_key_cipher FROM model_config WHERE id = 1").get();
      assert.equal(Buffer.from(model.api_key_cipher).equals(cipher), true);
      const relationship = db
        .prepare("SELECT accepted_at FROM relationships WHERE character_id = 'rin'")
        .get();
      assert.equal(relationship.accepted_at, acceptedAt);
      const rosterSql = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'roster'")
        .get().sql;
      assert.match(rosterSql, /random_1/);
    } finally {
      db.close();
    }

    const second = await launchApp(dataDir);
    app = second.app;
    await waitForStep(second.page, "home");
    await waitForText(second.page, "#home-name", "凛");
    assert.equal(await second.page.locator("#stat-energy").textContent(), "55");
    assert.equal(await second.page.locator("#roster-list .roster-row").count(), 1);
  } finally {
    await closeApp(app);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
