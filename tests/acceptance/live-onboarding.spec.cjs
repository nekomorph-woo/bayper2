/* POL-ONBOARD-006 真实服务验证。仅在显式执行 npm run test:live 时运行，
   从仓库根 .env 读取 OPEN_AI_BASE_URL / OPEN_AI_API_KEY。
   本文件不打印 .env 内容、API Key、Authorization 或 reasoning_content。
   真实 chat 请求最多两次：首次配置一次，重启后主进程解密复验一次。 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { _electron: electron } = require("playwright");

const electronPath = require("electron");
const repoRoot = path.resolve(__dirname, "..", "..");
const evidenceDir = path.join(repoRoot, ".hapilon", "polaris", "Bayper完整交付", "evidence");
const DB_FILE = "bayper.sqlite3";
const LIVE_MODEL = "deepseek-flash";
const LIVE_TIMEOUT_MS = 60000;

test("POL-ONBOARD-006 真实服务：窗口配置、接纳、重启后解密复验", async () => {
  const { baseUrl, apiKey } = loadCredentials();
  const modelIds = await listModels(baseUrl, apiKey);
  assert.ok(modelIds.includes(LIVE_MODEL), `GET /models 未返回 ${LIVE_MODEL}`);

  fs.mkdirSync(evidenceDir, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-live-"));
  let app = null;
  let firstLogs = [];
  let secondLogs = [];
  let firstLogsClosed = null;
  let secondLogsClosed = null;
  try {
    const first = await launchApp(dataDir);
    app = first.app;
    firstLogs = first.logs;
    firstLogsClosed = first.logsClosed;
    const page = first.page;
    await waitForStep(page, "config");

    // 唯一一次首次配置请求；失败即停止，不重试。
    await page.locator("#base-url").fill(baseUrl);
    await page.locator("#model-name").fill(LIVE_MODEL);
    await page.locator("#api-key").fill(apiKey);
    await page.locator("#config-submit").click();

    const reachedWish = await waitForWishOrError(page);
    if (!reachedWish.ok) {
      assert.fail(`真实模型连通检查未通过：${reachedWish.code || "UNKNOWN"}`);
    }
    assert.equal(await page.locator("#api-key").inputValue(), "", "成功后应从 DOM 清除 Key");
    await capture(page, "s01-live-wish.png");

    await page.locator("#wish-input").fill("想找安静陪着我的伙伴");
    await page.locator("#wish-submit").click();
    await page.locator("#candidate-card").waitFor({ state: "visible", timeout: 15000 });
    await page.locator("#accept-button").click();
    await waitForStep(page, "home", LIVE_TIMEOUT_MS);
    await capture(page, "s01-live-home.png");

    const snapshot = await getSnapshot(page);
    assert.equal(snapshot.state, "accepted");
    assert.equal(snapshot.model.modelName, LIVE_MODEL);
    assert.equal(JSON.stringify(snapshot).includes(apiKey), false, "快照不应包含 Key");

    await app.close();
    app = null;
    if (firstLogsClosed) {
      await firstLogsClosed;
    }
    assertStoredCipherWithoutPlaintext(dataDir, apiKey);

    // 重启后只通过正式主进程业务入口：解密 safeStorage 密文并复验一次。
    const second = await launchApp(dataDir);
    app = second.app;
    secondLogs = second.logs;
    secondLogsClosed = second.logsClosed;
    await waitForStep(second.page, "home", LIVE_TIMEOUT_MS);
    await openPage(second.page, "settings");
    await second.page.locator("#check-model").click();
    await second.page.waitForFunction(
      () => {
        const status = document.querySelector("#check-model-status");
        return status?.dataset.state === "ok" || status?.dataset.state === "error";
      },
      null,
      { timeout: LIVE_TIMEOUT_MS },
    );

    const check = await second.page.evaluate(() => ({
      state: document.querySelector("#check-model-status")?.dataset.state ?? "",
      text: document.querySelector("#check-model-status")?.textContent ?? "",
    }));
    assert.equal(check.state, "ok", `重启后模型复验未通过：${check.text}`);
    await capture(second.page, "s01-live-restart-check.png");

    // 关闭第二轮后再用两轮完整实时日志做泄漏断言。
    await app.close();
    app = null;
    if (secondLogsClosed) {
      await secondLogsClosed;
    }
    const allLogs = [...firstLogs, ...secondLogs].join("");
    assert.equal(allLogs.includes(apiKey), false, "两轮应用日志都不应包含 Key");
  } finally {
    if (app) {
      try {
        await app.close();
      } catch {
        // 清理继续；不输出应用日志或配置值。
      }
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

function loadCredentials() {
  const envPath = path.join(repoRoot, ".env");
  let text;
  try {
    text = fs.readFileSync(envPath, "utf8");
  } catch {
    throw new Error("无法读取根 .env；test:live 需要显式配置 OPEN_AI_BASE_URL / OPEN_AI_API_KEY。");
  }

  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const index = line.indexOf("=");
    if (index === -1) {
      continue;
    }
    const name = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[name] = value;
  }

  const baseUrl = values.OPEN_AI_BASE_URL;
  const apiKey = values.OPEN_AI_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error("根 .env 缺少 OPEN_AI_BASE_URL 或 OPEN_AI_API_KEY。");
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey };
}

async function listModels(baseUrl, apiKey) {
  const response = await fetch(`${baseUrl}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(response.status, 200, `GET /models 返回 HTTP ${response.status}`);
  const data = await response.json();
  return Array.isArray(data?.data)
    ? data.data.map((item) => item?.id).filter((id) => typeof id === "string")
    : [];
}

async function launchApp(dataDir) {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [repoRoot, `--data-dir=${dataDir}`],
  });
  const logs = [];
  const streams = [app.process().stdout, app.process().stderr].filter(Boolean);
  for (const stream of streams) {
    stream.on("data", (chunk) => logs.push(chunk.toString()));
  }
  const logsClosed = Promise.all(
    streams.map(
      (stream) =>
        new Promise((resolve) => {
          if (stream.readableEnded || stream.destroyed) {
            resolve();
            return;
          }
          stream.once("close", resolve);
        }),
    ),
  );
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page, logs, logsClosed };
}

async function waitForStep(page, name, timeout = 20000) {
  await page.locator(`[data-step="${name}"]`).waitFor({ state: "visible", timeout });
}

async function openPage(page, name) {
  await page.locator(`[data-nav="${name}"]`).click();
  await page.locator(`[data-page="${name}"]`).waitFor({ state: "visible", timeout: 10000 });
}

async function waitForWishOrError(page) {
  await page.waitForFunction(
    () => {
      const wish = document.querySelector('[data-step="wish"]');
      const alert = document.querySelector("#config-alert");
      if (wish && !wish.hidden) {
        return "wish";
      }
      if (alert && !alert.hidden && alert.dataset.code) {
        return "error";
      }
      return false;
    },
    null,
    { timeout: LIVE_TIMEOUT_MS },
  );

  return page.evaluate(() => {
    const wish = document.querySelector('[data-step="wish"]');
    if (wish && !wish.hidden) {
      return { ok: true };
    }
    const alert = document.querySelector("#config-alert");
    return {
      ok: false,
      code: alert?.dataset.code ?? "UNKNOWN",
      text: alert?.textContent ?? "",
    };
  });
}

async function getSnapshot(page) {
  const result = await page.evaluate(() => window.bayper.getSnapshot());
  assert.equal(result.ok, true);
  return result.snapshot;
}

function assertStoredCipherWithoutPlaintext(dataDir, apiKey) {
  const dbPath = path.join(dataDir, DB_FILE);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT api_key_cipher FROM model_config WHERE id = 1").get();
    assert.ok(row, "重启前应已保存模型配置");
    assert.ok(row.api_key_cipher && row.api_key_cipher.length > 0, "应保存 Key 密文");
  } finally {
    db.close();
  }
  const raw = fs.readFileSync(dbPath);
  assert.equal(raw.includes(Buffer.from(apiKey, "utf8")), false, "数据库不应包含明文 Key");
}

async function capture(page, name) {
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(evidenceDir, name) });
}
