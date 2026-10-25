const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { pathToFileURL } = require("node:url");
const { _electron: electron, chromium } = require("playwright");
const { startModelServer } = require("./fixture-server.cjs");
const { createDesktopHost, presentationAssetKey } = require("../../app/desktop-host.cjs");
const { buildDesktopPresentation } = require("../../app/desktop-assets.cjs");

const electronPath = require("electron");
const repoRoot = path.resolve(__dirname, "..", "..");
const evidenceDir = path.join(repoRoot, ".hapilon", "polaris", "Bayper完整交付", "evidence");
const DB_FILE = "bayper.sqlite3";
const SCREENSHOT_PREFIX = process.env.BAYPER_SCREENSHOT_PREFIX || "s02b-r2";

function makeDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bayper-desktop-"));
}

function localDay(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function manifestDisplayPlan(characterId, animationNames) {
  const characterDir = path.join(repoRoot, "assets", "characters", characterId, "animations");
  const frames = [];
  let frameSize = null;
  for (const name of animationNames) {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(characterDir, name, "manifest.json"), "utf8"),
    );
    frameSize = manifest.atlas.frame_size;
    frames.push(...manifest.frames);
  }
  const minX = Math.min(...frames.map((frame) => frame.paste.x));
  const minY = Math.min(...frames.map((frame) => frame.paste.y));
  const maxX = Math.max(...frames.map((frame) => frame.paste.x + frame.scaled_size.width));
  const maxY = Math.max(...frames.map((frame) => frame.paste.y + frame.scaled_size.height));
  const width = maxX - minX;
  const height = maxY - minY;
  const scale = 128 / Math.max(width, height);
  return {
    scale,
    windowWidth: Math.ceil(width * scale - 1e-6),
    windowHeight: Math.ceil(height * scale - 1e-6),
    canvasWidth: frameSize.width * scale,
    canvasHeight: frameSize.height * scale,
    offsetX: minX * scale,
    offsetY: minY * scale,
    footAnchor: {
      x: frames[0].output_foot_anchor.x * scale - minX * scale,
      y: frames[0].output_foot_anchor.y * scale - minY * scale,
    },
  };
}

function assertWithinWorkArea(bounds, workArea) {
  assert.ok(bounds.x >= workArea.x);
  assert.ok(bounds.y >= workArea.y);
  assert.ok(bounds.x + bounds.width <= workArea.x + workArea.width);
  assert.ok(bounds.y + bounds.height <= workArea.y + workArea.height);
}

function assertDisplayPlan(desktop, plan, label) {
  assert.equal(desktop.bounds.width, plan.windowWidth, `${label} 窗口宽度`);
  assert.equal(desktop.bounds.height, plan.windowHeight, `${label} 窗口高度`);
  assert.ok(plan.windowWidth <= 128, `${label} 宽度应约 128pt 以内`);
  assert.ok(plan.windowHeight <= 128, `${label} 高度应约 128pt 以内`);
  assert.ok(Math.abs(plan.footAnchor.y - plan.windowHeight) < 1, `${label} 落脚点应在窗口底部`);
}

async function setup() {
  const dataDir = makeDataDir();
  const server = await startModelServer();
  return { dataDir, server };
}

async function launchApp(dataDir, extraEnv = {}) {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [repoRoot, `--data-dir=${dataDir}`],
    env: { ...process.env, BAYPER_HEARTBEAT_MS: "400", ...extraEnv },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page };
}

async function waitForStep(page, name, timeout = 20000) {
  await page.locator(`[data-step="${name}"]`).waitFor({ state: "visible", timeout });
}

async function openPage(page, name) {
  await page.locator(`[data-nav="${name}"]`).click();
  await page.locator(`[data-page="${name}"]`).waitFor({ state: "visible", timeout: 10000 });
}

async function completeOnboarding(page, baseUrl) {
  await waitForStep(page, "config");
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

async function waitForSnapshot(page, predicate, timeout = 15000) {
  const started = Date.now();
  let snapshot = null;
  while (Date.now() - started < timeout) {
    snapshot = await getSnapshot(page);
    if (predicate(snapshot)) {
      return snapshot;
    }
    await page.waitForTimeout(100);
  }
  assert.fail(`快照条件超时：${JSON.stringify(snapshot?.desktop ?? null)}`);
}

async function waitFor(predicate, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("等待条件超时");
}

async function waitForSnapshotStatus(predicate, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("等待画布状态超时");
}

async function waitForHostStatus(host, predicate, timeout = 12000) {
  const started = Date.now();
  let status = null;
  while (Date.now() - started < timeout) {
    status = host.getStatus();
    if (predicate(status)) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`等待宿主状态超时：${JSON.stringify(status)}`);
}

async function capture(page, name) {
  fs.mkdirSync(evidenceDir, { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(100);
  await page.screenshot({ path: path.join(evidenceDir, `${SCREENSHOT_PREFIX}-${name}.png`) });
}

function desktopProcesses() {
  const output = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes(electronPath) && line.endsWith("/app/desktop"))
    .map((line) => {
      const [pid, ppid] = line.split(/\s+/, 3);
      return { pid: Number(pid), ppid: Number(ppid) };
    });
}

function makeSlowFrames(count = 8) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-slow-frame-"));
  const source = path.join(
    repoRoot,
    "tools",
    "appearance-catalog",
    "references",
    "style-board-02-maid.png",
  );
  const frames = [];
  for (let index = 0; index < count; index += 1) {
    const target = path.join(directory, `frame-${index}.png`);
    fs.copyFileSync(source, target);
    frames.push(pathToFileURL(target).href);
  }
  return { directory, frames };
}

function childPidFrom(snapshot) {
  return snapshot.desktop?.state === "running" ? snapshot.desktop.pid : null;
}

async function closeApp(app) {
  if (app) {
    try {
      await app.close();
    } catch {
      // 父进程可能已被测试强制结束。
    }
  }
}

function seedRouteToHandoff(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, DB_FILE));
  try {
    db.prepare("UPDATE character_stats SET energy = 25 WHERE character_id = 'rin'").run();
    const acceptedAt = new Date().toISOString();
    for (const [id, energy] of [
      ["hu", 70],
      ["cheng", 100],
    ]) {
      db.prepare("INSERT INTO relationships (character_id, accepted_at) VALUES (?, ?)").run(
        id,
        acceptedAt,
      );
      db.prepare(`
        INSERT INTO character_stats (character_id, intimacy, energy, mood)
        VALUES (?, 10, ?, 0)
      `).run(id, energy);
    }
    const day = localDay();
    db.prepare("DELETE FROM roster WHERE day = ?").run(day);
    for (const [slot, characterId] of [
      ["fixed", "rin"],
      ["random_1", "hu"],
      ["random_2", "cheng"],
    ]) {
      db.prepare("INSERT INTO roster (day, slot, character_id) VALUES (?, ?, ?)").run(
        day,
        slot,
        characterId,
      );
    }
  } finally {
    db.close();
  }
}

function seedBoundedFallback(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, DB_FILE));
  try {
    db.prepare("UPDATE character_stats SET energy = 25 WHERE character_id = 'cheng'").run();
    db.prepare("UPDATE character_stats SET energy = 100 WHERE character_id = 'rin'").run();
    db.prepare(
      "UPDATE character_runtime SET last_auto_exit_at = NULL WHERE character_id = 'rin'",
    ).run();
    db.prepare(
      "UPDATE app_state SET value = 'cheng' WHERE key = 'current_character_id'",
    ).run();
    db.prepare("UPDATE app_state SET value = 'companion' WHERE key = 'current_mode'").run();
  } finally {
    db.close();
  }
}

function seedHuCompanion(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, DB_FILE));
  try {
    db.prepare("UPDATE character_stats SET energy = 100 WHERE character_id = 'rin'").run();
    db.prepare("INSERT INTO relationships (character_id, accepted_at) VALUES (?, ?)").run(
      "hu",
      new Date().toISOString(),
    );
    db.prepare(`
      INSERT INTO character_stats (character_id, intimacy, energy, mood)
      VALUES ('hu', 10, 100, 0)
    `).run();
    const day = localDay();
    db.prepare("DELETE FROM roster WHERE day = ?").run(day);
    db.prepare("INSERT INTO roster (day, slot, character_id) VALUES (?, 'fixed', 'rin')").run(day);
    db.prepare("INSERT INTO roster (day, slot, character_id) VALUES (?, 'random_1', 'hu')").run(day);
  } finally {
    db.close();
  }
}

test("POL-DESKTOP-001/004 真实画布、管理窗口输入、关闭隐藏与退出清理", async () => {
  const ctx = await setup();
  let app = null;
  try {
    const first = await launchApp(ctx.dataDir);
    app = first.app;
    const page = first.page;
    await completeOnboarding(page, ctx.server.baseUrl);

    const rinPlan = manifestDisplayPlan("rin", ["idle-pixel-v2", "wave-pixel-v1"]);
    const snapshot = await waitForSnapshot(
      page,
      (value) =>
        value.desktop?.state === "running" &&
        value.desktop?.assetState === "ready" &&
        value.desktop?.lastNode === "idle-loop" &&
        value.desktop?.bounds?.width === rinPlan.windowWidth &&
        value.desktop?.bounds?.height === rinPlan.windowHeight &&
        value.desktop?.displayedFrame?.includes("/idle-pixel-v2/frame-") &&
        value.desktop?.pid,
    );
    assert.equal(snapshot.desktop.windowType, "panel");
    assert.equal(snapshot.desktop.focusable, false);
    assert.equal(snapshot.desktop.transparent, true);
    assert.equal(snapshot.desktop.activationPolicy, "prohibited");
    assert.equal(snapshot.desktop.characterId, "rin");
    assert.equal(snapshot.desktop.lastNode, "idle-loop");
    assertDisplayPlan(snapshot.desktop, rinPlan, "Rin");
    assert.match(snapshot.desktop.displayedFrame, /idle-pixel-v2\/frame-/);
    const workArea = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
    assertWithinWorkArea(snapshot.desktop.bounds, workArea);

    const childPid = childPidFrom(snapshot);
    const children = desktopProcesses();
    assert.equal(children.length, 1);
    assert.equal(children[0].pid, childPid);
    assert.equal(children[0].ppid, app.process().pid);
    await page.waitForTimeout(2000);
    const resourceLines = [app.process().pid, childPid].map((pid) =>
      execFileSync("ps", ["-o", "pid=,rss=", "-p", String(pid)], { encoding: "utf8" }).trim(),
    );
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(
      path.join(evidenceDir, `${SCREENSHOT_PREFIX}-resource.txt`),
      [
        "单机一次 RSS 采样，仅父进程与画布主进程；不含共享页、辅助进程、CPU 或长期结论。",
        ...resourceLines,
      ].join("\n"),
    );

    await openPage(page, "characters");
    await page.locator('[data-character-tab="arrange"]').click();
    await page.locator("#nickname-input").waitFor({ state: "visible", timeout: 10000 });
    await page.locator("#nickname-input").fill("可输入");
    assert.equal(await page.locator("#nickname-input").inputValue(), "可输入");
    await page.locator("#nickname-input").fill("");
    await openPage(page, "home");
    await capture(page, "desktop-home");

    await app.evaluate(({ powerMonitor }) => {
      powerMonitor.emit("lock-screen");
      powerMonitor.emit("lock-screen");
      powerMonitor.emit("suspend");
      powerMonitor.emit("resume");
    });
    await page.waitForTimeout(150);
    const stillPaused = await page.evaluate(() => window.bayper.getSystemStatus());
    assert.equal(stillPaused.ok, true);
    assert.equal(stillPaused.paused, true, "屏幕仍锁定时不得提前恢复");
    assert.deepEqual(stillPaused.reasons, ["lock"]);

    await app.evaluate(({ powerMonitor }) => powerMonitor.emit("unlock-screen"));
    await page.waitForTimeout(150);
    const resumed = await page.evaluate(() => window.bayper.getSystemStatus());
    assert.equal(resumed.paused, false);
    assert.deepEqual(resumed.reasons, []);

    const hidden = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.close();
      return win.isVisible();
    });
    assert.equal(hidden, false);
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.bayper.getSnapshot()).then((r) => r.ok), true);
    assert.equal(childPidFrom(await getSnapshot(page)), childPid);

    await app.evaluate(({ app: electronApp }) => electronApp.emit("activate"));
    const visible = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isVisible(),
    );
    assert.equal(visible, true, "activate 应重新显示管理窗；托盘点击由 Codex 后验");

    const requestCount = ctx.server.requests.length;
    await ctx.server.close();
    ctx.server = null;
    await closeApp(app);
    app = null;
    await waitFor(() => !desktopProcesses().some((item) => item.pid === childPid));

    const second = await launchApp(ctx.dataDir);
    app = second.app;
    await waitForStep(second.page, "home");
    const restarted = await waitForSnapshot(
      second.page,
      (value) => value.desktop?.state === "running" && value.desktop?.assetState === "ready",
    );
    assert.equal(restarted.companionship.current.characterId, "rin");
    assert.equal(requestCount, 1);
    const restartPid = childPidFrom(restarted);
    await closeApp(app);
    app = null;
    await waitFor(() => !desktopProcesses().some((item) => item.pid === restartPid));
  } finally {
    await closeApp(app);
    if (ctx.server) {
      await ctx.server.close();
    }
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test("POL-DESKTOP-004 重复启动不重复画布，画布崩溃有界重启", async () => {
  const ctx = await setup();
  let app = null;
  try {
    const first = await launchApp(ctx.dataDir);
    app = first.app;
    const page = first.page;
    await completeOnboarding(page, ctx.server.baseUrl);
    const initial = await waitForSnapshot(
      page,
      (value) => value.desktop?.state === "running" && value.desktop?.pid,
    );
    const initialPid = initial.desktop.pid;

    const duplicate = spawn(
      electronPath,
      [repoRoot, `--data-dir=${ctx.dataDir}`],
      { env: { ...process.env }, stdio: "ignore" },
    );
    const duplicateExit = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        duplicate.kill("SIGTERM");
        resolve("timeout");
      }, 6000);
      duplicate.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    assert.notEqual(duplicateExit, "timeout", "重复启动应因单实例锁退出");
    const processesAfterDuplicate = desktopProcesses();
    assert.equal(processesAfterDuplicate.length, 1);
    assert.equal(processesAfterDuplicate[0].pid, initialPid);

    process.kill(initialPid, "SIGKILL");
    const firstRestart = await waitForSnapshot(
      page,
      (value) =>
        value.desktop?.state === "running" &&
        value.desktop?.pid &&
        value.desktop.pid !== initialPid,
    );
    const secondPid = firstRestart.desktop.pid;
    process.kill(secondPid, "SIGKILL");
    const secondRestart = await waitForSnapshot(
      page,
      (value) =>
        value.desktop?.state === "running" &&
        value.desktop?.pid &&
        value.desktop.pid !== secondPid,
    );
    const thirdPid = secondRestart.desktop.pid;
    process.kill(thirdPid, "SIGKILL");
    const failed = await waitForSnapshot(
      page,
      (value) => value.desktop?.state === "failed",
      8000,
    );
    assert.match(failed.desktop.error, /已停止自动恢复/);
    assert.equal(failed.desktop.pid, null, "达到上限后不得保留画布 pid");
    assert.equal(failed.desktop.restarts, 3, "最多两次自动恢复，第三次退出进入 failed");
    assert.equal(
      desktopProcesses().some((item) => item.pid === thirdPid),
      false,
      "超过有界重启后不得继续产生画布",
    );

    // 越过旧 800ms 回调可能触发的时段，并覆盖多次 400ms 心跳 start；不得偷偷复活。
    await page.waitForTimeout(1600);
    const afterFailed = await getSnapshot(page);
    assert.equal(afterFailed.desktop.state, "failed");
    assert.equal(afterFailed.desktop.pid, null);
    assert.equal(afterFailed.desktop.restarts, 3);
    assert.equal(
      desktopProcesses().length,
      0,
      "failed 后重复 start/心跳不得拉起新画布",
    );
  } finally {
    await closeApp(app);
    if (ctx.server) {
      await ctx.server.close();
    }
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test("POL-DESKTOP-004 宿主快速崩溃上限、失败后心跳与显式重启", { timeout: 30000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-desktop-host-"));
  const presentation = buildDesktopPresentation("rin", "凛");
  assert.equal(presentation.assetState, "ready");
  const host = createDesktopHost({ dataDir, electronPath });
  const seenPids = new Set();
  try {
    host.start(presentation);
    const first = await waitForHostStatus(host, (value) => value.state === "running" && value.pid);
    seenPids.add(first.pid);
    process.kill(first.pid, "SIGKILL");

    const firstWait = await waitForHostStatus(
      host,
      (value) => value.state === "restarting" && value.restarts === 1,
    );
    assert.equal(firstWait.pid, null);
    // 恢复等待期间的重复 start（心跳等价）不得抢跑，也不得再排第二个 timer。
    host.start(presentation);
    host.start(presentation);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const held = host.getStatus();
    assert.equal(held.state, "restarting", "重复 start 不得跨过恢复等待");
    assert.equal(held.pid, null);

    const second = await waitForHostStatus(
      host,
      (value) => value.state === "running" && value.pid && value.pid !== first.pid,
    );
    assert.equal(second.restarts, 1);
    seenPids.add(second.pid);
    process.kill(second.pid, "SIGKILL");

    const secondWait = await waitForHostStatus(
      host,
      (value) => value.state === "restarting" && value.restarts === 2,
    );
    assert.equal(secondWait.pid, null);
    host.start(presentation);
    const third = await waitForHostStatus(
      host,
      (value) => value.state === "running" && value.pid && value.pid !== second.pid,
    );
    assert.equal(third.restarts, 2);
    seenPids.add(third.pid);
    process.kill(third.pid, "SIGKILL");

    const failed = await waitForHostStatus(host, (value) => value.state === "failed");
    assert.equal(failed.restarts, 3);
    assert.equal(failed.pid, null);
    assert.match(failed.error, /已停止自动恢复/);
    // 越过旧 800ms 回调可能触发的时段：不得出现第四个自动恢复。
    await new Promise((resolve) => setTimeout(resolve, 1600));
    const steady = host.getStatus();
    assert.equal(steady.state, "failed");
    assert.equal(steady.pid, null);
    assert.equal(steady.restarts, 3);
    assert.equal(desktopProcesses().some((item) => seenPids.has(item.pid)), false);

    // failed 后重复 start 不能绕过显式重启边界。
    host.start(presentation);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(host.getStatus().state, "failed");
    assert.equal(host.getStatus().pid, null);

    // 用户显式 restart 重置上限并恢复；旧 timer 不得再拉起额外进程。
    await host.restart(presentation);
    const recovered = await waitForHostStatus(
      host,
      (value) => value.state === "running" && value.pid,
    );
    assert.equal(recovered.restarts, 0);
    assert.equal(seenPids.has(recovered.pid), false);
    seenPids.add(recovered.pid);
    await new Promise((resolve) => setTimeout(resolve, 1600));
    const stable = host.getStatus();
    assert.equal(stable.state, "running");
    assert.equal(stable.pid, recovered.pid);
    assert.equal(stable.restarts, 0);
    assert.equal(desktopProcesses().filter((item) => seenPids.has(item.pid)).length, 1);
  } finally {
    await host.stop().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 200));
    const remaining = desktopProcesses().filter((item) => seenPids.has(item.pid));
    for (const item of remaining) {
      process.kill(item.pid, "SIGKILL");
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("POL-DESKTOP-004 父进程强制退出后画布自行结束", async () => {
  const ctx = await setup();
  let app = null;
  try {
    const first = await launchApp(ctx.dataDir);
    app = first.app;
    await completeOnboarding(first.page, ctx.server.baseUrl);
    const snapshot = await waitForSnapshot(
      first.page,
      (value) => value.desktop?.state === "running" && value.desktop?.pid,
    );
    const childPid = snapshot.desktop.pid;
    const parentPid = app.process().pid;
    process.kill(parentPid, "SIGKILL");
    app = null;
    await waitFor(
      () => !desktopProcesses().some((item) => item.pid === childPid),
      10000,
    );
  } finally {
    await closeApp(app);
    if (ctx.server) {
      await ctx.server.close();
    }
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test("POL-DESKTOP-005 手动切换/休息等待真实自然节点并切到 Hu 真实待机", async () => {
  const ctx = await setup();
  let app = null;
  try {
    const first = await launchApp(ctx.dataDir);
    app = first.app;
    await completeOnboarding(first.page, ctx.server.baseUrl);
    await waitForSnapshot(
      first.page,
      (value) => value.desktop?.state === "running" && value.desktop?.pid,
    );
    await closeApp(app);
    app = null;
    await ctx.server.close();
    ctx.server = null;
    seedHuCompanion(ctx.dataDir);

    const second = await launchApp(ctx.dataDir);
    app = second.app;
    const page = second.page;
    await waitForStep(page, "home");
    const rinNode = await waitForSnapshot(
      page,
      (value) =>
        value.desktop?.characterId === "rin" &&
        value.desktop?.assetState === "ready" &&
        value.desktop?.lastNode === "idle-loop",
      10000,
    );
    const aligned = await waitForSnapshot(
      page,
      (value) => value.desktop?.lastNodeAt > rinNode.desktop.lastNodeAt,
      5000,
    );

    await page
      .locator('.roster-row[data-character-id="hu"] button[data-action="switch"]')
      .click();
    await page.waitForTimeout(300);
    const duringSwitch = await getSnapshot(page);
    assert.equal(
      duringSwitch.companionship.current.characterId,
      "rin",
      "手动切换必须等待当前自然节点，不能瞬间换身份",
    );

    const huPlan = manifestDisplayPlan("hu", ["idle-v1"]);
    const hu = await waitForSnapshot(
      page,
      (value) =>
        value.companionship?.current?.characterId === "hu" &&
        value.desktop?.characterId === "hu" &&
        value.desktop?.assetState === "ready" &&
        value.desktop?.lastNode === "idle-loop" &&
        value.desktop?.bounds?.width === huPlan.windowWidth &&
        value.desktop?.bounds?.height === huPlan.windowHeight &&
        value.desktop?.displayedFrame?.includes("/idle-v1/frame-"),
      10000,
    );
    assert.ok(hu.desktop.lastNodeAt > aligned.desktop.lastNodeAt);
    assertDisplayPlan(hu.desktop, huPlan, "Hu");
    const huWorkArea = await app.evaluate(({ screen }) =>
      screen.getPrimaryDisplay().workArea,
    );
    assertWithinWorkArea(hu.desktop.bounds, huWorkArea);
    await capture(page, "desktop-manual-hu");

    const huNode = await waitForSnapshot(
      page,
      (value) => value.desktop?.lastNodeAt > hu.desktop.lastNodeAt,
      5000,
    );
    await page.locator("#rest-companion").click();
    await page.waitForTimeout(300);
    const duringRest = await getSnapshot(page);
    assert.notEqual(
      duringRest.companionship.current.source,
      "resting",
      "手动休息必须等待当前自然节点",
    );
    await waitForSnapshot(
      page,
      (value) =>
        value.companionship?.current?.source === "resting" &&
        value.desktop?.lastNodeAt > huNode.desktop.lastNodeAt,
      10000,
    );
  } finally {
    await closeApp(app);
    if (ctx.server) {
      await ctx.server.close();
    }
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test("POL-DESKTOP-005 心跳与 idle 自然节点完成低精力交接；无素材时有界收束", async () => {
  const ctx = await setup();
  let app = null;
  try {
    const first = await launchApp(ctx.dataDir);
    app = first.app;
    await completeOnboarding(first.page, ctx.server.baseUrl);
    await waitForSnapshot(
      first.page,
      (value) => value.desktop?.state === "running" && value.desktop?.pid,
    );
    await closeApp(app);
    app = null;
    await ctx.server.close();
    ctx.server = null;
    seedRouteToHandoff(ctx.dataDir);

    const second = await launchApp(ctx.dataDir);
    app = second.app;
    await waitForStep(second.page, "home");
    const handedOff = await waitForSnapshot(
      second.page,
      (value) =>
        value.companionship?.current?.characterId === "hu" &&
        value.companionship?.pendingRotation === false &&
        value.desktop?.characterId === "hu" &&
        value.desktop?.assetState === "ready" &&
        value.desktop?.lastNode === "idle-loop",
      15000,
    );
    assert.equal(handedOff.desktop.assetState, "ready", "Hu 真实 idle-v1 应可播放");
    assert.equal(
      handedOff.companionship.roster.some((entry) => entry.characterId === "hu"),
      true,
    );
    await capture(second.page, "desktop-hu-handoff");

    await closeApp(app);
    app = null;
    seedBoundedFallback(ctx.dataDir);

    const third = await launchApp(ctx.dataDir);
    app = third.app;
    await waitForStep(third.page, "home");
    const pendingCheng = await waitForSnapshot(
      third.page,
      (value) =>
        value.companionship?.current?.characterId === "cheng" &&
        value.desktop?.assetState === "pending",
      8000,
    );
    assert.equal(pendingCheng.desktop.characterId, "cheng");
    await capture(third.page, "desktop-pending-asset");

    const fallback = await waitForSnapshot(
      third.page,
      (value) =>
        value.companionship?.current?.characterId === "rin" &&
        value.desktop?.assetState === "ready",
      12000,
    );
    assert.equal(fallback.companionship.pendingRotation, false);
    assert.equal(fallback.desktop.pid > 0, true);
    await capture(third.page, "desktop-fallback-ready");
  } finally {
    await closeApp(app);
    if (ctx.server) {
      await ctx.server.close();
    }
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  }
});

test("POL-DESKTOP-005 真实损坏 PNG 解码失败保留错误并解除节点等待", async () => {
  const dataDir = makeDataDir();
  const corruptDir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-corrupt-png-"));
  const corruptFile = path.join(corruptDir, "broken.png");
  fs.writeFileSync(corruptFile, Buffer.from("this is not a decodable PNG file\n"));
  let host = null;
  try {
    host = createDesktopHost({
      dataDir,
      electronPath,
      onAssetError: () => {},
    });
    const presentation = {
      character: { id: "corrupt-fixture", displayName: "损坏素材" },
      animations: {
        idle: {
          frames: [pathToFileURL(corruptFile).href],
          durations: [300],
          frameSize: { width: 256, height: 384 },
          loop: true,
        },
      },
      assetState: "ready",
      assetNote: "",
      mode: "companion",
      visible: false,
      ignoreMouse: false,
      position: null,
    };
    host.start(presentation);
    await waitFor(
      () => host.getStatus().state === "running" && host.getStatus().assetState === "error",
      10000,
    );
    const status = host.getStatus();
    assert.equal(status.assetState, "error", "getStatus 不得把加载错误覆盖回 ready");
    assert.match(status.error, /加载失败/);
    const boundary = await host.waitForNodeBoundary(1000);
    assert.equal(boundary.ok, false);
    assert.equal(boundary.reason, "asset-error");
  } finally {
    if (host) {
      await host.stop();
    }
    fs.rmSync(corruptDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("POL-DESKTOP-005 旧身份异步加载失效，迟到节点不能完成新身份", async () => {
  const dataDir = makeDataDir();
  const slow = makeSlowFrames();
  let host = null;
  try {
    let sentPending = false;
    host = createDesktopHost({
      dataDir,
      electronPath,
      onAssetError: () => {},
      onStatusChange: (status) => {
        if (status.state === "running" && !sentPending) {
          sentPending = true;
          setImmediate(() => host.update(pendingPresentation));
        }
      },
    });
    const slowPresentation = {
      character: { id: "slow-a", displayName: "慢加载 A" },
      animations: {
        idle: {
          frames: slow.frames,
          durations: new Array(8).fill(100),
          frameSize: { width: 256, height: 384 },
          loop: true,
        },
      },
      assetState: "ready",
      assetNote: "",
      mode: "companion",
      visible: false,
      ignoreMouse: false,
      position: null,
    };
    const pendingPresentation = {
      character: { id: "cheng", displayName: "澄" },
      animations: null,
      assetState: "pending",
      assetNote: "该角色的正式桌面素材尚未接入或验证",
      mode: "companion",
      visible: false,
      ignoreMouse: false,
      position: null,
    };

    host.start(slowPresentation);
    await new Promise((resolve) => setTimeout(resolve, 2800));

    const status = host.getStatus();
    assert.equal(status.assetState, "pending");
    assert.equal(status.displayedKind, "status");
    assert.equal(status.displayedKey, presentationAssetKey(pendingPresentation));
    assert.equal(status.lastNode, null, "旧身份不得继续发送自然节点");
  } finally {
    if (host) {
      await host.stop();
    }
    fs.rmSync(slow.directory, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("POL-DESKTOP-005 A→慢加载B→A缓存竞态与失败后返回已加载A", async () => {
  const dataDir = makeDataDir();
  const slow = makeSlowFrames(24);
  const corruptFile = path.join(dataDir, "broken.png");
  fs.writeFileSync(corruptFile, Buffer.from("not a decodable PNG\n"));
  let host = null;
  try {
    host = createDesktopHost({
      dataDir,
      electronPath,
      onAssetError: () => {},
    });
    const aPresentation = {
      character: { id: "loaded-a", displayName: "已加载 A" },
      animations: {
        idle: {
          frames: [pathToFileURL(
            path.join(repoRoot, "assets/characters/hu/animations/idle-v1/frame-00.png"),
          ).href],
          durations: [100],
          frameSize: { width: 256, height: 384 },
          loop: true,
        },
      },
      assetState: "ready",
      assetNote: "",
      assetLabel: "A",
      mode: "companion",
      visible: false,
      ignoreMouse: false,
      position: null,
    };
    const bPresentation = {
      character: { id: "slow-b", displayName: "慢加载 B" },
      animations: {
        idle: {
          frames: slow.frames,
          durations: new Array(24).fill(200),
          frameSize: { width: 256, height: 384 },
          loop: true,
        },
      },
      assetState: "ready",
      assetNote: "",
      assetLabel: "B",
      mode: "companion",
      visible: false,
      ignoreMouse: false,
      position: null,
    };
    const corruptPresentation = {
      character: { id: "corrupt-c", displayName: "损坏 C" },
      animations: {
        idle: {
          frames: [pathToFileURL(corruptFile).href],
          durations: [100],
          frameSize: { width: 256, height: 384 },
          loop: true,
        },
      },
      assetState: "ready",
      assetNote: "",
      assetLabel: "C",
      mode: "companion",
      visible: false,
      ignoreMouse: false,
      position: null,
    };

    const aFrame = aPresentation.animations.idle.frames[0];
    const bFrame = bPresentation.animations.idle.frames[0];
    host.start(aPresentation);
    await waitForSnapshotStatus(
      () =>
        host.getStatus().displayedKind === "character" &&
        host.getStatus().displayedKey === presentationAssetKey(aPresentation) &&
        host.getStatus().displayedFrame === aFrame,
      10000,
    );

    // B 与 A 两条 state 紧邻发送：B 仍在预载时 A 已切回。
    host.update(bPresentation);
    host.update(aPresentation);
    await waitForSnapshotStatus(
      () =>
        host.getStatus().displayedKind === "character" &&
        host.getStatus().displayedKey === presentationAssetKey(aPresentation) &&
        host.getStatus().displayedFrame === aFrame,
      1000,
    );

    await new Promise((resolve) => setTimeout(resolve, 1200));
    const backToA = host.getStatus();
    assert.equal(backToA.displayedKey, presentationAssetKey(aPresentation));
    assert.equal(backToA.displayedFrame, aFrame, "慢加载 B 不得在失效后接管画面");
    assert.notEqual(backToA.displayedFrame, bFrame);

    host.update(corruptPresentation);
    await waitForSnapshotStatus(
      () =>
        host.getStatus().assetState === "error" ||
        host.getStatus().displayedKind === "status",
      3000,
    );
    host.update(aPresentation);
    await waitForSnapshotStatus(
      () =>
        host.getStatus().displayedKind === "character" &&
        host.getStatus().displayedKey === presentationAssetKey(aPresentation) &&
        host.getStatus().displayedFrame === aFrame,
      1000,
    );
  } finally {
    if (host) {
      await host.stop();
    }
    fs.rmSync(slow.directory, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("POL-DESKTOP-007 真实画布 DOM 按共同包围裁切，点击招呼回待机并切 Hu", async () => {
  const dataDir = makeDataDir();
  const profileDir = path.join(dataDir, "canvas-profile");
  const childEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG || "zh_CN.UTF-8",
    BAYPER_DESKTOP_PROFILE: profileDir,
    BAYPER_DESKTOP_CHILD: "1",
  };
  let child = null;
  let browser = null;
  try {
    const desktopDir = path.join(repoRoot, "app", "desktop");
    child = spawn(
      electronPath,
      ["--remote-debugging-port=0", "--remote-allow-origins=*", desktopDir],
      { env: childEnv, stdio: ["pipe", "pipe", "pipe"] },
    );
    const outputLines = [];
    child.stdout.on("data", (chunk) => outputLines.push(chunk.toString()));
    child.stderr.on("data", (chunk) => outputLines.push(chunk.toString()));

    const portFile = path.join(profileDir, "DevToolsActivePort");
    await waitFor(() => fs.existsSync(portFile), 10000);
    const port = Number(fs.readFileSync(portFile, "utf8").split("\n")[0]);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    let page = null;
    await waitFor(() => {
      const pages = browser.contexts().flatMap((context) => context.pages());
      page = pages.find((candidate) =>
        candidate.url().includes("/app/desktop/renderer/index.html"),
      );
      return Boolean(page);
    }, 10000);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await page.waitForLoadState("domcontentloaded");
    const stdin = child.stdin;

    const rin = buildDesktopPresentation("rin", "凛");
    const rinState = {
      type: "state",
      ...rin,
      displayKey: "dom-rin",
      mode: "companion",
      visible: false,
      ignoreMouse: false,
      position: null,
    };
    stdin.write(`${JSON.stringify(rinState)}\n`);
    await page.waitForFunction(
      () =>
        document.getElementById("sprite")?.complete &&
        document.getElementById("sprite")?.src.includes("idle-pixel-v2"),
      null,
      { timeout: 10000 },
    );

    const rinPlan = manifestDisplayPlan("rin", ["idle-pixel-v2", "wave-pixel-v1"]);
    const rinDom = await readCanvasDom(page);
    assert.equal(rinDom.windowWidth, rinPlan.windowWidth);
    assert.equal(rinDom.windowHeight, rinPlan.windowHeight);
    assertClose(rinDom.imageWidth, rinPlan.canvasWidth, "Rin 图片宽");
    assertClose(rinDom.imageHeight, rinPlan.canvasHeight, "Rin 图片高");
    assertClose(rinDom.left, -rinPlan.offsetX, "Rin 图片左偏移");
    assertClose(rinDom.top, -rinPlan.offsetY, "Rin 图片上偏移");
    assert.match(rinDom.src, /idle-pixel-v2\/frame-/);
    assert.ok(Math.abs(rinPlan.footAnchor.y - rinPlan.windowHeight) < 1);
    await captureDirectChild(page, `${SCREENSHOT_PREFIX}-dom-rin.png`);

    await page.locator("#stage").click({ position: { x: 10, y: 10 } });
    await page.waitForFunction(
      () => document.getElementById("sprite")?.src.includes("wave-pixel-v1"),
      null,
      { timeout: 5000 },
    );
    const waveDom = await readCanvasDom(page);
    assert.equal(waveDom.windowWidth, rinPlan.windowWidth);
    assert.equal(waveDom.windowHeight, rinPlan.windowHeight);
    assertClose(waveDom.imageWidth, rinPlan.canvasWidth, "wave 图片宽");
    assertClose(waveDom.imageHeight, rinPlan.canvasHeight, "wave 图片高");
    assertClose(waveDom.left, -rinPlan.offsetX, "wave 左偏移");
    await page.waitForFunction(
      () => document.getElementById("sprite")?.src.includes("idle-pixel-v2"),
      null,
      { timeout: 6000 },
    );
    await waitFor(
      () => outputLines.join("").includes('"node":"wave"'),
      3000,
    );

    const hu = buildDesktopPresentation("hu", "琥珀");
    stdin.write(
      `${JSON.stringify({
        type: "state",
        ...hu,
        displayKey: "dom-hu",
        mode: "companion",
        visible: false,
        ignoreMouse: false,
        position: null,
      })}\n`,
    );
    await page.waitForFunction(
      () => document.getElementById("sprite")?.src.includes("idle-v1"),
      null,
      { timeout: 10000 },
    );
    const huPlan = manifestDisplayPlan("hu", ["idle-v1"]);
    const huDom = await readCanvasDom(page);
    assert.equal(huDom.windowWidth, huPlan.windowWidth);
    assert.equal(huDom.windowHeight, huPlan.windowHeight);
    assertClose(huDom.imageWidth, huPlan.canvasWidth, "Hu 图片宽");
    assertClose(huDom.imageHeight, huPlan.canvasHeight, "Hu 图片高");
    assertClose(huDom.left, -huPlan.offsetX, "Hu 图片左偏移");
    assertClose(huDom.top, -huPlan.offsetY, "Hu 图片上偏移");
    await captureDirectChild(page, `${SCREENSHOT_PREFIX}-dom-hu.png`);

    stdin.write(`${JSON.stringify(rinState)}\n`);
    await page.waitForFunction(
      () =>
        document.getElementById("sprite")?.src.includes("idle-pixel-v2") &&
        document.getElementById("sprite")?.complete,
      null,
      { timeout: 10000 },
    );
    const backDom = await readCanvasDom(page);
    assert.equal(backDom.windowWidth, rinPlan.windowWidth);
    assert.equal(backDom.windowHeight, rinPlan.windowHeight);
    assertClose(backDom.imageWidth, rinPlan.canvasWidth, "返回 Rin 图片宽");
    assertClose(backDom.left, -rinPlan.offsetX, "返回 Rin 偏移");
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
    await captureDirectChild(page, `${SCREENSHOT_PREFIX}-dom-rin-return.png`);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (child) {
      child.stdin.end();
      const exited = await waitForChildExit(child, 3000);
      if (!exited) {
        child.kill("SIGKILL");
      }
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

async function waitForChildExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function readCanvasDom(page) {
  return page.evaluate(() => {
    const sprite = document.getElementById("sprite");
    const rect = sprite.getBoundingClientRect();
    return {
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight,
      imageWidth: rect.width,
      imageHeight: rect.height,
      left: rect.left,
      top: rect.top,
      src: sprite.src,
    };
  });
}

function assertClose(actual, expected, label) {
  assert.ok(
    Math.abs(actual - expected) < 0.6,
    `${label}：期望 ${expected}，实际 ${actual}`,
  );
}

async function captureDirectChild(page, name) {
  fs.mkdirSync(evidenceDir, { recursive: true });
  await page.screenshot({ path: path.join(evidenceDir, name) });
}

test("POL-DESKTOP-007 几何 bounds 更新不得重置素材错误/展示/节点", async () => {
  const corruptDir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-bounds-corrupt-"));
  const corruptFile = path.join(corruptDir, "broken.png");
  fs.writeFileSync(corruptFile, Buffer.from("not a decodable PNG\n"));
  let corruptHost = null;
  let validHost = null;
  const corruptDataDir = makeDataDir();
  const validDataDir = makeDataDir();
  try {
    corruptHost = createDesktopHost({
      dataDir: corruptDataDir,
      electronPath,
      onAssetError: () => {},
    });
    const corruptPresentation = {
      character: { id: "bounds-corrupt", displayName: "损坏素材" },
      animations: {
        idle: {
          frames: [pathToFileURL(corruptFile).href],
          durations: [100],
          frameSize: { width: 256, height: 384 },
          loop: true,
        },
      },
      assetState: "ready",
      assetNote: "",
      assetLabel: "损坏",
      mode: "companion",
      visible: false,
      ignoreMouse: false,
      position: null,
    };
    corruptHost.start(corruptPresentation);
    await waitForSnapshotStatus(
      () =>
        corruptHost.getStatus().state === "running" &&
        corruptHost.getStatus().assetState === "error",
      10000,
    );
    const errorBefore = corruptHost.getStatus();
    assert.ok(errorBefore.error);
    assert.equal(errorBefore.displayedKind, "status");
    corruptHost.update({ ...corruptPresentation, position: { x: 80, y: 80 } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const errorAfter = corruptHost.getStatus();
    assert.equal(errorAfter.assetState, "error", "几何更新不得清除素材错误");
    assert.equal(errorAfter.error, errorBefore.error);
    assert.equal(errorAfter.displayedKind, "status");
    assert.equal(errorAfter.displayedAt, errorBefore.displayedAt);

    validHost = createDesktopHost({
      dataDir: validDataDir,
      electronPath,
      onAssetError: () => {},
    });
    const rin = buildDesktopPresentation("rin", "凛");
    const validPresentation = {
      ...rin,
      displayKey: "bounds-rin",
      mode: "companion",
      visible: false,
      ignoreMouse: false,
      position: null,
    };
    validHost.start(validPresentation);
    await waitForSnapshotStatus(
      () =>
        validHost.getStatus().state === "running" &&
        validHost.getStatus().displayedKind === "character" &&
        validHost.getStatus().lastNode === "idle-loop",
      10000,
    );
    const validBefore = validHost.getStatus();
    validHost.update({ ...validPresentation, position: { x: 90, y: 90 } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const validAfter = validHost.getStatus();
    assert.equal(validAfter.displayedKind, "character", "几何更新不得清除展示身份");
    assert.equal(validAfter.displayedKey, validBefore.displayedKey);
    assert.equal(validAfter.displayedFrame, validBefore.displayedFrame);
    assert.equal(validAfter.lastNode, "idle-loop", "几何更新不得清除最后节点");
    assert.equal(validAfter.lastNodeAt, validBefore.lastNodeAt);
    assert.equal(validAfter.displayedAt, validBefore.displayedAt);
  } finally {
    if (corruptHost) {
      await corruptHost.stop();
    }
    if (validHost) {
      await validHost.stop();
    }
    fs.rmSync(corruptDir, { recursive: true, force: true });
    fs.rmSync(corruptDataDir, { recursive: true, force: true });
    fs.rmSync(validDataDir, { recursive: true, force: true });
  }
});
