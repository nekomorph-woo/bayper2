/* S03i 自动共享全局开关领域验收：真实 SQLite 与记忆服务，不启动 GUI、不调用模型。
   覆盖 POL-AUTOSHARE-CONTROL-001~003；正式设置页布局与 IPC 边界见 GUI Runner。
   固定样例只验证本切片：share 受全局开关控制，relay 仍按用户明确转告执行。
   用偏好事实调用 share 只验证旧服务入口的开关守卫，不代表生产会主动分享偏好。 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { MemoryError, createMemoryService } = require("../../app/memory.cjs");
const { createMemoryStore } = require("../../app/memory-store.cjs");
const { createMemoryDatabase, openMemoryDatabase } = require("./memory-fixtures.cjs");

const START = Date.UTC(2026, 9, 27, 12, 0, 0);
const AUTO_SHARE_KEY = "memory_auto_share_enabled";

function makeContext(t, characters = ["a", "b", "c"]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-memory-auto-share-"));
  createMemoryDatabase(dir, characters).db.close();
  const current = { db: openMemoryDatabase(dir), service: null };
  current.service = createMemoryService({ db: current.db, now: () => START });

  const ctx = {
    dir,
    get db() {
      return current.db;
    },
    get service() {
      return current.service;
    },
    reopen() {
      current.db.close();
      current.db = openMemoryDatabase(dir);
      current.service = createMemoryService({ db: current.db, now: () => START });
    },
    stateValue() {
      return (
        current.db
          .prepare("SELECT value FROM app_state WHERE key = ?")
          .get(AUTO_SHARE_KEY)?.value ?? null
      );
    },
    count(table) {
      return current.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
    },
    summary() {
      return {
        memories: current.db
          .prepare("SELECT id, character_id, fact_key, body, version FROM memory_entries ORDER BY id")
          .all(),
        stats: current.db
          .prepare("SELECT character_id, intimacy, energy, mood FROM character_stats ORDER BY character_id")
          .all(),
        relationships: current.db
          .prepare("SELECT character_id, accepted_at FROM relationships ORDER BY character_id")
          .all(),
      };
    },
  };
  t.after(() => {
    try {
      current.db.close();
    } catch {
      // 测试已主动关闭时继续清理临时目录。
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return ctx;
}

function remember(service, input) {
  return service.remember({
    characterId: "a",
    kind: "preference",
    sourceId: `src-${input.factKey}`,
    ...input,
  });
}

function entryOf(service, characterId, factKey) {
  return service.listMemories(characterId).find((entry) => entry.factKey === factKey) ?? null;
}

function relayOne(service, fromCharacterId, toCharacterId, entry) {
  return service.relay({
    fromCharacterId,
    toCharacterId,
    entries: [{ entryId: entry.id, expectedVersion: entry.version }],
  });
}

function hasCode(code) {
  return (error) => error instanceof MemoryError && error.code === code;
}

test("POL-AUTOSHARE-CONTROL-001 新库默认开启，关闭写入真实SQLite且不删记忆", (t) => {
  const ctx = makeContext(t);
  remember(ctx.service, { factKey: "pref.tea", body: "用户喜欢热茶" });
  const before = ctx.summary();

  assert.equal(ctx.service.isAutoShareEnabled(), true);
  assert.equal(ctx.stateValue(), null);
  assert.deepEqual(ctx.service.setAutoShareEnabled({ enabled: false }), { enabled: false });
  assert.equal(ctx.stateValue(), "false");
  assert.equal(ctx.service.isAutoShareEnabled(), false);

  // 关闭只限制自动分享，不删除记忆、数值或名单关系。
  assert.deepEqual(ctx.summary(), before);
  remember(ctx.service, { factKey: "pref.coffee", body: "用户喜欢热咖啡" });
  assert.equal(ctx.service.listMemories("a").length, 2);

  for (const input of [{}, { enabled: "false" }, { enabled: 0 }, { enabled: null }, null]) {
    assert.throws(() => ctx.service.setAutoShareEnabled(input), hasCode("INVALID_INPUT"));
  }
  assert.equal(ctx.stateValue(), "false");

  ctx.reopen();
  assert.equal(ctx.service.isAutoShareEnabled(), false);
  ctx.service.setAutoShareEnabled({ enabled: true });
  assert.equal(ctx.stateValue(), "true");
  assert.equal(ctx.service.isAutoShareEnabled(), true);
});

test("POL-AUTOSHARE-CONTROL-002 关闭后share明确拒绝，重开恢复原路径，逐事实限制仍生效", (t) => {
  const ctx = makeContext(t);
  const tea = remember(ctx.service, { factKey: "pref.tea", body: "用户喜欢热茶" });
  const hike = remember(ctx.service, { factKey: "exp.hike", body: "用户周末去爬山" });
  ctx.service.setAutoShareEnabled({ enabled: false });

  const ftsBefore = ctx.count("memory_fts");
  const contextBefore = ctx.service.getContextVersion("b");
  assert.throws(
    () =>
      ctx.service.share({
        fromCharacterId: "a",
        toCharacterId: "b",
        entryIds: [tea.entry.id],
      }),
    hasCode("AUTO_SHARE_DISABLED"),
  );
  assert.equal(ctx.service.listMemories("b").length, 0);
  assert.equal(ctx.count("memory_fts"), ftsBefore);
  assert.equal(ctx.service.getContextVersion("b"), contextBefore);
  assert.equal(ctx.count("memory_share_identity_controls"), 0);
  assert.equal(ctx.service.isAutoShareEnabled(), false);

  // 重新开启后仍走原 share 路径，不要求调用方换接口。
  ctx.service.setAutoShareEnabled({ enabled: true });
  const shared = ctx.service.share({
    fromCharacterId: "a",
    toCharacterId: "b",
    entryIds: [tea.entry.id],
  });
  assert.equal(shared.shared[0].alreadyHeld, false);
  const sharedTea = entryOf(ctx.service, "b", "pref.tea");
  assert.ok(sharedTea);
  assert.equal(sharedTea.derived, true);

  // 全局开关不能替代逐事实禁分享。
  ctx.service.restrictSharing({
    characterId: "a",
    entryId: hike.entry.id,
    expectedVersion: hike.entry.version,
  });
  assert.throws(
    () =>
      ctx.service.share({
        fromCharacterId: "a",
        toCharacterId: "c",
        entryIds: [hike.entry.id],
      }),
    hasCode("SHARE_BLOCKED"),
  );
  assert.equal(ctx.service.listMemories("c").length, 0);
});

test("POL-AUTOSHARE-CONTROL-003 全局关闭时明确relay仍成功且不改变开关", (t) => {
  const ctx = makeContext(t);
  const tea = remember(ctx.service, { factKey: "pref.tea", body: "用户喜欢热茶" });
  const coffee = remember(ctx.service, { factKey: "pref.coffee", body: "用户喜欢热咖啡" });
  ctx.service.setAutoShareEnabled({ enabled: false });

  const relayed = relayOne(ctx.service, "a", "b", tea.entry);
  assert.equal(relayed.contextVersion, 1);
  const received = entryOf(ctx.service, "b", "pref.tea");
  assert.ok(received);
  assert.equal(received.body, tea.entry.body);
  assert.equal(received.narratorCharacterId, "a");
  assert.equal(received.originCharacterId, "a");
  assert.equal(received.derived, true);

  // 明确转告不改变全局开关，也不顺带分享其他事实或角色。
  assert.equal(ctx.stateValue(), "false");
  assert.equal(ctx.service.isAutoShareEnabled(), false);
  assert.equal(entryOf(ctx.service, "b", "pref.coffee"), null);
  assert.equal(ctx.service.listMemories("c").length, 0);

  // 逐事实禁分享对 relay 仍强制。
  ctx.service.restrictSharing({
    characterId: "a",
    entryId: coffee.entry.id,
    expectedVersion: coffee.entry.version,
  });
  assert.throws(
    () => relayOne(ctx.service, "a", "b", coffee.entry),
    hasCode("SHARE_BLOCKED"),
  );
  assert.equal(entryOf(ctx.service, "b", "pref.coffee"), null);
  assert.equal(ctx.stateValue(), "false");
});

test("POL-AUTOSHARE-CONTROL-004 接收者排除显式来源后，换 factKey 也不能同源回流", (t) => {
  const ctx = makeContext(t);
  const first = remember(ctx.service, {
    factKey: "exp.first",
    body: "旧来源的第一条内容",
    kind: "detail",
    sourceId: "shared-source",
  });
  const shared = ctx.service.share({
    fromCharacterId: "a",
    toCharacterId: "b",
    entryIds: [first.entry.id],
    sourceId: "shared-source",
  });
  assert.equal(shared.shared[0].alreadyHeld, false);

  // 接收者只忘记自己的副本；来源控制保留，旧源不能靠新 factKey 重新投递。
  const received = entryOf(ctx.service, "b", "exp.first");
  assert.ok(received);
  ctx.service.forget({
    characterId: "b",
    entryId: received.id,
    expectedVersion: received.version,
    scope: "self",
  });
  const second = remember(ctx.service, {
    factKey: "exp.second",
    body: "旧来源换键后的内容",
    kind: "detail",
    sourceId: "shared-source",
  });
  assert.equal(second.created, true);
  assert.throws(
    () =>
      ctx.service.share({
        fromCharacterId: "a",
        toCharacterId: "b",
        entryIds: [second.entry.id],
        sourceId: "shared-source",
      }),
    hasCode("SHARE_BLOCKED"),
  );
  assert.equal(entryOf(ctx.service, "b", "exp.second"), null);
  assert.equal(ctx.service.listMemories("b").length, 0);
});

test("POL-THEME-SHARE-004F 旧记忆库迁移保守补 user 来源种类", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-memory-migrate-"));
  let db = null;
  t.after(() => {
    try {
      db?.close();
    } catch {
      // 已关闭时仍清理临时目录。
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  createMemoryDatabase(dir, ["a"]).db.close();
  db = openMemoryDatabase(dir);
  createMemoryStore(db);
  db.exec("ALTER TABLE memory_entries DROP COLUMN source_kind");
  db.prepare(`
    INSERT INTO memory_entries (
      id, character_id, fact_key, origin_character_id, derived_from_entry_id,
      kind, body, trust, importance, expires_at,
      source_id, source_version, version, created_at, updated_at
    ) VALUES ('legacy', 'a', 'legacy.fact', 'a', NULL,
              'detail', '旧库记忆', 'stated', 20, NULL,
              'legacy-source', 1, 1, ?, ?)
  `).run(START, START);
  db.close();

  db = openMemoryDatabase(dir);
  const service = createMemoryService({ db, now: () => START });
  const entries = service.listMemories("a");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].body, "旧库记忆");
  assert.equal(entries[0].sourceKind, "user");
});
