#!/usr/bin/env node
/** S02b 原生桌面验收底板：真实 app + 隔离 data-dir + loopback fixture-model，
 * 通过 UI 接纳 Rin 后关闭 fixture，再创建普通 Electron 验收底板。
 * 工具只观察真实鼠标/键盘/focus/blur，不模拟输入，也不切换 Spaces 或锁屏。 */

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("playwright");

const repoRoot = path.resolve(__dirname, "..", "..");
const electronPath = require("electron");
const plateHtml = path.join(__dirname, "plate.html");
const evidenceRoot = path.join(__dirname, "evidence");
fs.mkdirSync(evidenceRoot, { recursive: true });
const batchDir = fs.mkdtempSync(path.join(evidenceRoot, "batch-"));
const statesFile = path.join(batchDir, "states.jsonl");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-desktop-review-"));
let app, managementPage, platePage, fixture, sampleTimer, childPid;
let shutdownStarted = false;
let sampleQueue = Promise.resolve();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startFixtureModel() {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"choices":[{"message":{"role":"assistant","content":"fixture ok"}}]}');
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    }),
  };
}

async function waitForStep(page, name) {
  await page.locator(`[data-step="${name}"]`).waitFor({ state: "visible", timeout: 20000 });
}

async function waitUntil(predicate, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(100);
  }
  return false;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function recordFailure(message) {
  const line = { at: new Date().toISOString(), error: String(message).slice(0, 300) };
  fs.appendFileSync(statesFile, `${JSON.stringify(line)}\n`);
}

function sample() {
  const run = sampleQueue.then(async () => {
    const counters = await app.evaluate(() => globalThis.__desktopReviewCounters ?? null);
    const dom = platePage && !platePage.isClosed()
      ? await platePage.evaluate(() => window.__desktopReviewDom ?? null)
      : null;
    const snapshot = (await managementPage.evaluate(() => window.bayper.getSnapshot()))?.snapshot ?? {};
    const desktop = snapshot.desktop ?? {};
    if (Number.isInteger(desktop.pid)) childPid = desktop.pid;
    const state = {
      at: new Date().toISOString(),
      plate: { counters, dom },
      management: {
        focused: await managementPage.evaluate(() => document.hasFocus()),
        characterId: snapshot.companionship?.current?.characterId ?? null,
        desktop: {
          state: desktop.state ?? null,
          pid: desktop.pid ?? null,
          assetState: desktop.assetState ?? null,
        },
      },
    };
    fs.appendFileSync(statesFile, `${JSON.stringify(state)}\n`);
    return state;
  });
  sampleQueue = run.catch(() => undefined);
  return run;
}

async function shutdown(code) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  if (sampleTimer) clearInterval(sampleTimer);
  let failed = false;
  const fail = (message) => {
    failed = true;
    recordFailure(message);
    console.error(`[desktop-review] ${message}`);
  };
  if (app && managementPage && platePage) {
    await sample().catch((error) => fail(`退出快照失败: ${error.message}`));
  }
  const expectedChild = childPid;
  if (fixture) {
    await fixture.close().catch((error) => console.error(`[desktop-review] 关闭 fixture 失败: ${error.message}`));
    fixture = null;
  }
  await app?.close().catch((error) => fail(`关闭 app/底板失败: ${error.message}`));
  if (Number.isInteger(expectedChild)) {
    const exited = await waitUntil(() => !isAlive(expectedChild), 5000);
    if (!exited) fail(`子画布进程 ${expectedChild} 在 5 秒内未退出`);
  }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); }
  catch (error) { fail(`删除临时目录失败: ${error.message}`); }
  console.log(`[desktop-review] ${failed ? "清理未完成" : "已退出"}，证据: ${batchDir}`);
  process.exit(failed ? 1 : code);
}

async function main() {
  fixture = await startFixtureModel();
  app = await electron.launch({
    executablePath: electronPath,
    args: [repoRoot, `--data-dir=${dataDir}`],
    env: { ...process.env, BAYPER_HEARTBEAT_MS: "400" },
  });
  managementPage = await app.firstWindow();
  await waitForStep(managementPage, "config");
  await managementPage.locator("#base-url").fill(fixture.baseUrl);
  await managementPage.locator("#model-name").fill("fixture-model");
  await managementPage.locator("#api-key").fill("fixture-key");
  await managementPage.locator("#config-submit").click();
  await waitForStep(managementPage, "wish");
  await managementPage.locator("#wish-submit").click();
  await managementPage.locator("#candidate-card").waitFor({ state: "visible" });
  await managementPage.locator("#accept-button").click();
  await waitForStep(managementPage, "home");
  await fixture.close();
  fixture = null;

  let snapshot = null;
  const ready = await waitUntil(async () => {
    const result = await managementPage.evaluate(() => window.bayper.getSnapshot());
    snapshot = result?.snapshot;
    return Boolean(snapshot?.desktop?.state === "running" && snapshot.desktop.assetState === "ready"
      && snapshot.desktop.characterId === "rin" && snapshot.desktop.pid);
  }, 25000);
  if (!ready) throw new Error("Rin 角色画布未在 25 秒内就绪");
  childPid = snapshot.desktop.pid;

  await app.evaluate(({ BrowserWindow, screen }, options) => {
    const current = BrowserWindow.getAllWindows().find((win) =>
      win.webContents.getURL().endsWith("/app/renderer/index.html"));
    const area = current
      ? screen.getDisplayMatching(current.getBounds()).workArea
      : screen.getPrimaryDisplay().workArea;
    const win = new BrowserWindow({
      x: area.x,
      y: area.y,
      width: area.width,
      height: area.height,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    globalThis.__desktopReviewCounters = { focus: 0, blur: 0 };
    const bump = (key) => { globalThis.__desktopReviewCounters[key] += 1; };
    win.on("focus", () => bump("focus"));
    win.on("blur", () => bump("blur"));
    win.loadFile(options.html);
    win.show();
    win.focus();
  }, { html: plateHtml });

  const found = await waitUntil(async () => {
    const pages = await app.windows();
    platePage = pages.find((page) => page.url().endsWith("/plate.html")) ?? null;
    return Boolean(platePage);
  }, 10000);
  if (!found || !platePage) throw new Error("验收底板页面未加载");
  await platePage.waitForFunction(() => Boolean(window.__desktopReviewDom));
  await app.evaluate(() => {
    globalThis.__desktopReviewCounters.focus = 0;
    globalThis.__desktopReviewCounters.blur = 0;
  });

  fs.appendFileSync(statesFile, `${JSON.stringify({ fixtureModel: "loopback fixture-model（仅本次验收）",
    note: "只观察真实输入；不模拟输入、Spaces 或锁屏。" })}\n`);

  await sample();
  sampleTimer = setInterval(() => {
    sample().catch((error) => {
      console.error(`[desktop-review] 采样失败: ${error.message}`);
    });
  }, 2000);

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    if (shutdownStarted) return;
    const command = chunk.trim();
    if (command === "snapshot") {
      sample().then((state) => {
        console.log(`[desktop-review] 快照 ${state.at}: ${batchDir}`);
      }).catch((error) => {
        console.error(`[desktop-review] 快照失败: ${error.message}`);
      });
    } else if (command === "quit") {
      shutdown(0);
    } else if (command) {
      console.log("[desktop-review] 可用命令: snapshot / quit");
    }
  });
  console.log(`[desktop-review] 证据目录: ${batchDir}`);
  console.log("[desktop-review] fixture-model 仅用于本次 loopback 验收；操作底板后输入 snapshot 记录，quit 退出。");
}

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));

main().catch(async (error) => {
  console.error(`[desktop-review] 启动失败: ${error.message}`);
  await shutdown(1);
});
