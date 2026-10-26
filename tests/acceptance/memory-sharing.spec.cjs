/* S03d 明确转告与事实禁分享验收：真实 SQLite 连接与记忆服务，不启动 GUI、
   不调用模型。覆盖 POL-SHARING-001~006；正式 IPC/自然语言入口与自动共享
   不在本切片，不能据本文件宣称全链路已通过。 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { MemoryError, createMemoryService } = require("../../app/memory.cjs");
const { createMemoryDatabase, openMemoryDatabase } = require("./memory-fixtures.cjs");

const START = Date.UTC(2026, 9, 27, 12, 0, 0);

function makeContext(t, characters = ["a", "b", "c", "d"]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-memory-sharing-"));
  createMemoryDatabase(dir, characters).db.close();
  let nowMs = START;
  const current = { db: openMemoryDatabase(dir), service: null };
  current.service = createMemoryService({ db: current.db, now: () => nowMs });

  const ctx = {
    dir,
    get db() {
      return current.db;
    },
    get service() {
      return current.service;
    },
    nowMs: () => nowMs,
    reopen() {
      current.db.close();
      current.db = openMemoryDatabase(dir);
      current.service = createMemoryService({ db: current.db, now: () => nowMs });
    },
  };
  t.after(() => {
    try {
      current.db.close();
    } catch {
      // 测试已主动关闭时仍要清理临时目录。
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return ctx;
}

function remember(service, input) {
  return service.remember({
    characterId: "a",
    kind: "preference",
    sourceId: "src-default",
    ...input,
  });
}

function countRows(db, table) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function hasCode(code) {
  return (error) => error instanceof MemoryError && error.code === code;
}

function relayOne(service, fromCharacterId, toCharacterId, entryId, expectedVersion) {
  return service.relay({
    fromCharacterId,
    toCharacterId,
    entries: [{ entryId, expectedVersion }],
  });
}

function entryOf(service, characterId, factKey) {
  return service.listMemories(characterId).find((entry) => entry.factKey === factKey) ?? null;
}

test("POL-SHARING-001 明确转告只给指定条目、保留来源且重复操作幂等", (t) => {
  const ctx = makeContext(t);
  const anecdote = remember(ctx.service, {
    factKey: "exp.qingdao",
    body: "用户分享过在青岛吃蛤蜊的经历",
    kind: "experience",
    sourceId: "a-daily",
  });
  const privateEntry = remember(ctx.service, {
    factKey: "detail.private",
    body: "用户的私人联系人是林舟",
    kind: "detail",
    sourceId: "a-private",
  });
  const work = remember(ctx.service, {
    factKey: "detail.work",
    body: "用户的工作代号是白鹭",
    kind: "detail",
    sourceId: "a-work",
  });
  const rosterBefore = countRows(ctx.db, "roster");
  const statsBefore = ctx.db.prepare("SELECT * FROM character_stats ORDER BY character_id").all();

  const result = ctx.service.relay({
    fromCharacterId: "a",
    toCharacterId: "b",
    entries: [{ entryId: anecdote.entry.id, expectedVersion: 1 }],
  });
  assert.equal(result.shared.length, 1);
  assert.equal(result.shared[0].alreadyHeld, false);
  assert.ok(result.contextVersion > 0);

  const bEntries = ctx.service.listMemories("b");
  assert.equal(bEntries.length, 1);
  assert.equal(bEntries[0].body, "用户分享过在青岛吃蛤蜊的经历");
  assert.equal(bEntries[0].originCharacterId, "a");
  assert.equal(bEntries[0].derived, true);
  assert.equal(bEntries[0].derivedFromEntryId, anecdote.entry.id);
  assert.equal(bEntries[0].narratorCharacterId, "a");
  assert.equal(bEntries[0].sourceId, `relay:${anecdote.entry.id}:b`);

  const derivation = ctx.db
    .prepare("SELECT * FROM memory_derivations WHERE entry_id = ?")
    .get(bEntries[0].id);
  assert.equal(derivation.parent_entry_id, anecdote.entry.id);
  assert.equal(derivation.origin_character_id, "a");
  assert.equal(derivation.narrator_character_id, "a");

  assert.equal(ctx.service.searchMemories({ characterId: "b", query: "蛤蜊" }).length, 1);
  assert.deepEqual(ctx.service.searchMemories({ characterId: "b", query: "林舟" }), []);
  assert.deepEqual(ctx.service.searchMemories({ characterId: "b", query: "白鹭" }), []);
  assert.deepEqual(ctx.service.listMemories("c"), []);
  assert.deepEqual(ctx.service.searchMemories({ characterId: "c", query: "蛤蜊" }), []);
  const context = ctx.service.buildContext({ characterId: "b" });
  assert.deepEqual(
    context.sections.experiences.map((entry) => entry.id),
    [bEntries[0].id],
  );

  assert.equal(countRows(ctx.db, "roster"), rosterBefore);
  assert.deepEqual(
    ctx.db.prepare("SELECT * FROM character_stats ORDER BY character_id").all(),
    statsBefore,
  );
  assert.equal(privateEntry.created, true);
  assert.equal(work.created, true);

  const bVersionBefore = ctx.service.getContextVersion("b");
  const repeated = relayOne(ctx.service, "a", "b", anecdote.entry.id, 1);
  assert.equal(repeated.shared[0].alreadyHeld, true);
  assert.equal(repeated.shared[0].entryId, bEntries[0].id);
  assert.equal(repeated.contextVersion, null);
  assert.equal(ctx.service.getContextVersion("b"), bVersionBefore);
  assert.equal(ctx.service.listMemories("b").length, 1);
  assert.equal(ctx.service.listMemories("b")[0].version, 1);
});

test("POL-SHARING-002 保守分享仍拒绝派生内容，明确转告保留来源与讲述链", (t) => {
  const ctx = makeContext(t);
  const original = remember(ctx.service, {
    factKey: "exp.qingdao",
    body: "用户分享过在青岛吃蛤蜊的经历",
    kind: "experience",
    sourceId: "a-daily",
  });
  relayOne(ctx.service, "a", "b", original.entry.id, 1);
  const bEntry = ctx.service.listMemories("b")[0];

  assert.throws(
    () => ctx.service.share({ fromCharacterId: "b", toCharacterId: "c", entryIds: [bEntry.id] }),
    hasCode("SHARE_NOT_ALLOWED"),
  );
  assert.deepEqual(ctx.service.listMemories("c"), []);

  const relayed = relayOne(ctx.service, "b", "c", bEntry.id, bEntry.version);
  assert.equal(relayed.shared[0].alreadyHeld, false);
  const cEntry = ctx.service.listMemories("c")[0];
  assert.equal(cEntry.originCharacterId, "a");
  assert.equal(cEntry.derived, true);
  assert.equal(cEntry.derivedFromEntryId, bEntry.id);
  assert.equal(cEntry.narratorCharacterId, "b");
  assert.equal(cEntry.sourceId, `relay:${bEntry.id}:c`);
  const cDerivation = ctx.db
    .prepare("SELECT * FROM memory_derivations WHERE entry_id = ?")
    .get(cEntry.id);
  assert.equal(cDerivation.parent_entry_id, bEntry.id);
  assert.equal(cDerivation.origin_character_id, "a");
  assert.equal(cDerivation.narrator_character_id, "b");

  // A 仅自己忘记后，B 的派生身份仍由记忆派生关系保留，C 也仍可追溯 A。
  ctx.service.forget({
    characterId: "a",
    entryId: original.entry.id,
    expectedVersion: 1,
    scope: "self",
  });
  assert.deepEqual(ctx.service.listMemories("a"), []);
  const bAfter = entryOf(ctx.service, "b", "exp.qingdao");
  assert.equal(bAfter.derived, true);
  assert.equal(bAfter.originCharacterId, "a");
  assert.equal(bAfter.narratorCharacterId, "a");
  assert.equal(bAfter.derivedFromEntryId, original.entry.id);
  const cAfter = entryOf(ctx.service, "c", "exp.qingdao");
  assert.equal(cAfter.derived, true);
  assert.equal(cAfter.originCharacterId, "a");
  assert.equal(cAfter.narratorCharacterId, "b");
  assert.equal(cAfter.derivedFromEntryId, bEntry.id);
  assert.equal(ctx.service.searchMemories({ characterId: "c", query: "蛤蜊" }).length, 1);
});

test("REVIEW-S03D-1 B自删除后C仍保留直接讲述者，重开并再转告D", (t) => {
  const ctx = makeContext(t);
  const original = remember(ctx.service, {
    factKey: "exp.qingdao",
    body: "用户分享过在青岛吃蛤蜊的经历",
    kind: "experience",
    sourceId: "a-daily",
  });
  relayOne(ctx.service, "a", "b", original.entry.id, 1);
  const bEntry = ctx.service.listMemories("b")[0];
  assert.equal(bEntry.narratorCharacterId, "a");
  relayOne(ctx.service, "b", "c", bEntry.id, bEntry.version);
  const cEntry = ctx.service.listMemories("c")[0];
  assert.equal(cEntry.originCharacterId, "a");
  assert.equal(cEntry.narratorCharacterId, "b");

  // B 只让自己忘记后，父条目与 B 的派生行都删除；C 的讲述者身份独立保留。
  ctx.service.forget({
    characterId: "b",
    entryId: bEntry.id,
    expectedVersion: bEntry.version,
    scope: "self",
  });
  assert.deepEqual(ctx.service.listMemories("b"), []);
  ctx.reopen();

  const cAfter = entryOf(ctx.service, "c", "exp.qingdao");
  assert.equal(cAfter.body, "用户分享过在青岛吃蛤蜊的经历");
  assert.equal(cAfter.derived, true);
  assert.equal(cAfter.originCharacterId, "a");
  assert.equal(cAfter.narratorCharacterId, "b");
  assert.equal(cAfter.derivedFromEntryId, bEntry.id);
  assert.equal(ctx.service.listMemories("c").length, 1);
  assert.equal(ctx.service.searchMemories({ characterId: "c", query: "蛤蜊" }).length, 1);
  const context = ctx.service.buildContext({ characterId: "c" });
  assert.deepEqual(
    context.sections.experiences.map((entry) => entry.id),
    [cAfter.id],
  );
  assert.equal(context.sections.experiences[0].narratorCharacterId, "b");
  assert.equal(context.sections.experiences[0].originCharacterId, "a");
  const persisted = ctx.db
    .prepare("SELECT * FROM memory_derivations WHERE entry_id = ?")
    .get(cAfter.id);
  assert.equal(persisted.parent_entry_id, bEntry.id);
  assert.equal(persisted.origin_character_id, "a");
  assert.equal(persisted.narrator_character_id, "b");

  // C 继续明确转告 D：直接讲述者变为 C，最初来源仍是 A。
  relayOne(ctx.service, "c", "d", cAfter.id, cAfter.version);
  const dEntry = entryOf(ctx.service, "d", "exp.qingdao");
  assert.equal(dEntry.originCharacterId, "a");
  assert.equal(dEntry.narratorCharacterId, "c");
  assert.equal(dEntry.derivedFromEntryId, cAfter.id);
  const dDerivation = ctx.db
    .prepare("SELECT * FROM memory_derivations WHERE entry_id = ?")
    .get(dEntry.id);
  assert.equal(dDerivation.origin_character_id, "a");
  assert.equal(dDerivation.narrator_character_id, "c");
  assert.equal(dDerivation.parent_entry_id, cAfter.id);
  assert.equal(countRows(ctx.db, "memory_entries"), 3);
});

test("REVIEW-S03D-2 旧派生关系迁移只补可确定的直接讲述者", (t) => {
  const ctx = makeContext(t);
  const parent = remember(ctx.service, {
    factKey: "exp.parent",
    body: "用户讲过一件旧事",
    kind: "experience",
    sourceId: "a-parent",
  });
  // 构造旧版没有 narrator_character_id 列的派生关系，再交给新代码迁移。
  ctx.db.exec("ALTER TABLE memory_derivations DROP COLUMN narrator_character_id");
  const insertRawEntry = ctx.db.prepare(`
    INSERT INTO memory_entries (
      id, character_id, fact_key, origin_character_id, derived_from_entry_id,
      kind, body, trust, importance, expires_at, source_id, source_version,
      version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'experience', ?, 'stated', 50, NULL, ?, 1, 1, ?, ?)
  `);
  const insertRawDerivation = ctx.db.prepare(`
    INSERT INTO memory_derivations (
      entry_id, parent_entry_id, origin_character_id, source_id, source_version, created_at
    ) VALUES (?, ?, ?, ?, 1, ?)
  `);
  const nowMs = ctx.nowMs();
  const keptParent = "legacy-kept-parent";
  const missingParent = "legacy-missing-parent";
  insertRawEntry.run(
    keptParent, "a", "exp.kept", "a", null,
    "保留父条目的旧记忆", "a-kept", nowMs, nowMs,
  );
  insertRawEntry.run(
    "legacy-kept", "b", "exp.kept", "a", keptParent,
    "听A说过的旧记忆", `share:${keptParent}:b`, nowMs, nowMs,
  );
  insertRawDerivation.run("legacy-kept", keptParent, "a", `share:${keptParent}:b`, nowMs);

  insertRawEntry.run(
    missingParent, "b", "exp.missing", "b", null,
    "父条目后来被删除的旧记忆", "b-missing", nowMs, nowMs,
  );
  insertRawEntry.run(
    "legacy-missing", "c", "exp.missing", "b", missingParent,
    "听B说过的旧记忆", `share:${missingParent}:c`, nowMs, nowMs,
  );
  insertRawDerivation.run("legacy-missing", missingParent, "b", `share:${missingParent}:c`, nowMs);
  ctx.db.prepare("DELETE FROM memory_entries WHERE id = ?").run(missingParent);

  ctx.reopen();
  const kept = entryOf(ctx.service, "b", "exp.kept");
  assert.equal(kept.narratorCharacterId, "a");
  assert.equal(kept.originCharacterId, "a");
  assert.equal(kept.derivedFromEntryId, keptParent);
  const missing = entryOf(ctx.service, "c", "exp.missing");
  assert.equal(missing.narratorCharacterId, null);
  assert.equal(missing.originCharacterId, "b");
  assert.equal(missing.derivedFromEntryId, missingParent);
  assert.equal(
    ctx.db.prepare("SELECT body FROM memory_entries WHERE id = ?").get(missingParent),
    undefined,
  );
  const columns = ctx.db
    .prepare("PRAGMA table_info(memory_derivations)")
    .all()
    .map((column) => column.name);
  assert.equal(columns.includes("body"), false);
});

test("POL-SHARING-003 事实禁分享跨持有者持久生效，独立解除且失败事务无半写", (t) => {
  const ctx = makeContext(t);
  const original = remember(ctx.service, {
    factKey: "detail.secret",
    body: "用户的秘密是银钥匙",
    kind: "detail",
    sourceId: "a-secret",
  });
  relayOne(ctx.service, "a", "b", original.entry.id, 1);
  const bEntry = ctx.service.listMemories("b")[0];

  const restriction = ctx.service.restrictSharing({
    characterId: "a",
    entryId: original.entry.id,
    expectedVersion: 1,
  });
  assert.equal(restriction.alreadyRestricted, false);
  assert.deepEqual(restriction.holders, ["a", "b"]);
  assert.equal(restriction.factKeyHash, sha256("detail.secret"));
  assert.equal(countRows(ctx.db, "memory_share_controls"), 1);

  ctx.reopen();
  const entriesBefore = countRows(ctx.db, "memory_entries");
  assert.throws(() => relayOne(ctx.service, "a", "c", original.entry.id, 1), hasCode("SHARE_BLOCKED"));
  assert.throws(
    () =>
      relayOne(
        ctx.service,
        "b",
        "c",
        entryOf(ctx.service, "b", "detail.secret").id,
        entryOf(ctx.service, "b", "detail.secret").version,
      ),
    hasCode("SHARE_BLOCKED"),
  );
  assert.throws(
    () => ctx.service.share({ fromCharacterId: "a", toCharacterId: "c", entryIds: [original.entry.id] }),
    hasCode("SHARE_BLOCKED"),
  );
  // 普通转告失败后限制仍在，已有副本不撤回，也没有写给未知角色。
  assert.deepEqual(ctx.service.listMemories("c"), []);
  assert.deepEqual(ctx.service.listMemories("d"), []);
  assert.equal(countRows(ctx.db, "memory_entries"), entriesBefore);
  assert.equal(entryOf(ctx.service, "a", "detail.secret").body, "用户的秘密是银钥匙");
  assert.equal(entryOf(ctx.service, "b", "detail.secret").body, "用户的秘密是银钥匙");
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS count FROM memory_share_controls").get().count, 1);

  // 纠正同步持有者内容，但不会解除事实禁分享，也不通知未知角色。
  ctx.service.correct({
    characterId: "a",
    factKey: "detail.secret",
    body: "用户的秘密已更换",
    sourceId: "a-secret-new",
  });
  assert.equal(countRows(ctx.db, "memory_share_controls"), 1);
  assert.equal(entryOf(ctx.service, "a", "detail.secret").body, "用户的秘密已更换");
  assert.equal(entryOf(ctx.service, "b", "detail.secret").body, "用户的秘密已更换");
  assert.deepEqual(ctx.service.listMemories("c"), []);
  assert.throws(
    () => relayOne(ctx.service, "a", "c", original.entry.id, 2),
    hasCode("SHARE_BLOCKED"),
  );

  // 注入限制写入失败：事务回滚，不留下第二条控制。
  const failing = remember(ctx.service, {
    factKey: "detail.restrict-fail",
    body: "用于验证失败回滚的记忆",
    kind: "detail",
    sourceId: "a-fail-control",
  });
  const failingHash = sha256("detail.restrict-fail");
  ctx.db.exec(`
    CREATE TRIGGER fail_share_control BEFORE INSERT ON memory_share_controls
    WHEN NEW.fact_key_hash = '${failingHash}'
    BEGIN SELECT RAISE(ABORT, 'injected share control failure'); END;
  `);
  assert.throws(
    () =>
      ctx.service.restrictSharing({
        characterId: "a",
        entryId: failing.entry.id,
        expectedVersion: 1,
      }),
    /injected share control failure/u,
  );
  ctx.db.exec("DROP TRIGGER fail_share_control");
  assert.equal(
    ctx.db
      .prepare("SELECT COUNT(*) AS count FROM memory_share_controls WHERE fact_key_hash = ?")
      .get(failingHash).count,
    0,
  );
  assert.equal(entryOf(ctx.service, "a", "detail.restrict-fail").body, "用于验证失败回滚的记忆");

  // 只有独立的解除操作能恢复转告。
  const bNow = entryOf(ctx.service, "b", "detail.secret");
  const lifted = ctx.service.allowSharing({
    characterId: "b",
    entryId: bNow.id,
    expectedVersion: bNow.version,
  });
  assert.equal(lifted.lifted, true);
  assert.deepEqual(lifted.holders, ["a", "b"]);
  assert.equal(countRows(ctx.db, "memory_share_controls"), 0);
  relayOne(ctx.service, "a", "c", original.entry.id, 2);
  assert.equal(entryOf(ctx.service, "c", "detail.secret").originCharacterId, "a");
  assert.equal(entryOf(ctx.service, "c", "detail.secret").body, "用户的秘密已更换");
});

test("POL-SHARING-004 自己忘记后禁止回流，全局删除后只留无正文控制", (t) => {
  const ctx = makeContext(t);
  const original = remember(ctx.service, {
    factKey: "exp.cat",
    body: "用户养过一只叫团子的猫",
    kind: "experience",
    sourceId: "a-cat",
  });
  relayOne(ctx.service, "a", "b", original.entry.id, 1);
  relayOne(ctx.service, "a", "c", original.entry.id, 1);
  const bEntry = ctx.service.listMemories("b")[0];
  const statsBefore = ctx.db.prepare("SELECT * FROM character_stats ORDER BY character_id").all();

  ctx.service.forget({
    characterId: "b",
    entryId: bEntry.id,
    expectedVersion: bEntry.version,
    scope: "self",
  });
  assert.deepEqual(ctx.service.listMemories("b"), []);
  assert.equal(
    ctx.db
      .prepare("SELECT COUNT(*) AS count FROM memory_forget_controls WHERE character_id = 'b'")
      .get().count,
    1,
  );

  assert.throws(() => relayOne(ctx.service, "a", "b", original.entry.id, 1), hasCode("SHARE_BLOCKED"));
  const cEntry = ctx.service.listMemories("c")[0];
  assert.throws(
    () => relayOne(ctx.service, "c", "b", cEntry.id, cEntry.version),
    hasCode("SHARE_BLOCKED"),
  );
  assert.deepEqual(ctx.service.listMemories("b"), []);
  assert.equal(countRows(ctx.db, "memory_entries"), 2);
  assert.deepEqual(
    ctx.db.prepare("SELECT * FROM character_stats ORDER BY character_id").all(),
    statsBefore,
  );

  const deleted = ctx.service.forget({
    characterId: "a",
    entryId: original.entry.id,
    expectedVersion: 1,
  });
  assert.deepEqual(deleted.affectedCharacters, ["a", "c"]);
  assert.equal(countRows(ctx.db, "memory_entries"), 0);
  for (const table of ["memory_forget_controls", "memory_source_controls", "memory_share_controls"]) {
    const columns = ctx.db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
    assert.equal(columns.includes("body"), false);
  }
  assert.throws(
    () => relayOne(ctx.service, "a", "c", original.entry.id, 1),
    hasCode("SHARE_NOT_ALLOWED"),
  );
  const reimported = remember(ctx.service, {
    factKey: "exp.cat",
    body: "用户养过一只叫团子的猫",
    kind: "experience",
    sourceId: "a-cat",
  });
  assert.equal(reimported.created, false);
  assert.equal(reimported.blocked, "source");
});

test("POL-SHARING-005 旧版本与已删除条目拒绝，接收者较新内容不被覆盖", (t) => {
  const ctx = makeContext(t);
  const original = remember(ctx.service, {
    factKey: "pref.coffee",
    body: "用户喜欢甜咖啡",
    sourceId: "a-old",
  });
  ctx.service.correct({
    characterId: "a",
    factKey: "pref.coffee",
    body: "用户喜欢无糖咖啡",
    sourceId: "a-new",
  });
  const bContextBefore = ctx.service.getContextVersion("b");
  assert.throws(
    () => relayOne(ctx.service, "a", "b", original.entry.id, 1),
    hasCode("MEMORY_CHANGED"),
  );
  assert.deepEqual(ctx.service.listMemories("b"), []);
  assert.equal(ctx.service.getContextVersion("b"), bContextBefore);

  relayOne(ctx.service, "a", "b", original.entry.id, 2);
  assert.equal(entryOf(ctx.service, "b", "pref.coffee").body, "用户喜欢无糖咖啡");
  relayOne(ctx.service, "a", "d", original.entry.id, 2);
  assert.equal(entryOf(ctx.service, "d", "pref.coffee").body, "用户喜欢无糖咖啡");
  assert.deepEqual(ctx.service.listMemories("c"), []);
  assert.equal(ctx.service.getContextVersion("c"), 0);

  // 接收者已持有更新的同事实内容：如实冲突，不覆盖、不增加版本或上下文。
  const conflictA = remember(ctx.service, {
    factKey: "pref.conflict",
    body: "用户喜欢甜咖啡",
    sourceId: "a-conflict",
  });
  const conflictB = remember(ctx.service, {
    characterId: "b",
    factKey: "pref.conflict",
    body: "用户喜欢无糖咖啡",
    sourceId: "b-conflict",
  });
  ctx.db
    .prepare("UPDATE memory_entries SET version = 2, updated_at = ? WHERE id = ?")
    .run(ctx.nowMs() + 1000, conflictB.entry.id);
  const bConflictContext = ctx.service.getContextVersion("b");
  assert.throws(
    () => relayOne(ctx.service, "a", "b", conflictA.entry.id, 1),
    hasCode("SHARE_CONFLICT"),
  );
  const bConflictAfter = entryOf(ctx.service, "b", "pref.conflict");
  assert.equal(bConflictAfter.body, "用户喜欢无糖咖啡");
  assert.equal(bConflictAfter.version, 2);
  assert.equal(ctx.service.getContextVersion("b"), bConflictContext);
  assert.equal(countRows(ctx.db, "memory_entries"), 5);

  // 删除后的旧条目不能凭旧 ID/版本重新转告。
  ctx.service.forget({
    characterId: "a",
    entryId: original.entry.id,
    expectedVersion: 2,
    scope: "self",
  });
  assert.throws(
    () => relayOne(ctx.service, "a", "c", original.entry.id, 2),
    hasCode("SHARE_NOT_ALLOWED"),
  );
  assert.deepEqual(ctx.service.listMemories("c"), []);
});

test("POL-SHARING-006 输入拒绝、整批原子与接收者上下文失效", (t) => {
  const ctx = makeContext(t);
  const first = remember(ctx.service, {
    factKey: "pref.first",
    body: "用户喜欢茉莉茶",
    sourceId: "a-first",
  });
  const second = remember(ctx.service, {
    factKey: "pref.second",
    body: "用户喜欢桂花糕",
    sourceId: "a-second",
  });

  assert.throws(
    () => relayOne(ctx.service, "b", "c", first.entry.id, 1),
    hasCode("SHARE_NOT_ALLOWED"),
  );
  assert.throws(
    () => relayOne(ctx.service, "a", "ghost", first.entry.id, 1),
    hasCode("CHARACTER_UNKNOWN"),
  );
  assert.throws(
    () => relayOne(ctx.service, "a", "a", first.entry.id, 1),
    hasCode("INVALID_INPUT"),
  );
  assert.throws(
    () =>
      ctx.service.relay({
        fromCharacterId: "a",
        toCharacterId: "b",
        entries: [
          { entryId: first.entry.id, expectedVersion: 1 },
          { entryId: first.entry.id, expectedVersion: 1 },
        ],
      }),
    hasCode("INVALID_INPUT"),
  );

  // 批次中一条被禁止：整批不写入，接收者上下文版本不变。
  ctx.service.restrictSharing({
    characterId: "a",
    entryId: second.entry.id,
    expectedVersion: 1,
  });
  assert.throws(
    () =>
      ctx.service.relay({
        fromCharacterId: "a",
        toCharacterId: "b",
        entries: [
          { entryId: first.entry.id, expectedVersion: 1 },
          { entryId: second.entry.id, expectedVersion: 1 },
        ],
      }),
    hasCode("SHARE_BLOCKED"),
  );
  assert.deepEqual(ctx.service.listMemories("b"), []);
  assert.equal(ctx.service.getContextVersion("b"), 0);
  assert.equal(countRows(ctx.db, "memory_entries"), 2);
  assert.equal(countRows(ctx.db, "memory_derivations"), 0);

  // 写入失败时回滚整个事务，不留下部分条目或派生关系。
  const third = remember(ctx.service, {
    factKey: "pref.third",
    body: "用户喜欢青梅酒",
    sourceId: "a-third",
  });
  ctx.db.exec(`
    CREATE TRIGGER fail_relay_insert BEFORE INSERT ON memory_entries
    WHEN NEW.character_id = 'c'
    BEGIN SELECT RAISE(ABORT, 'injected relay failure'); END;
  `);
  assert.throws(
    () => relayOne(ctx.service, "a", "c", third.entry.id, 1),
    /injected relay failure/u,
  );
  ctx.db.exec("DROP TRIGGER fail_relay_insert");
  assert.deepEqual(ctx.service.listMemories("c"), []);
  assert.equal(ctx.service.getContextVersion("c"), 0);
  assert.equal(countRows(ctx.db, "memory_derivations"), 0);
  assert.equal(entryOf(ctx.service, "a", "pref.third").body, "用户喜欢青梅酒");

  // 第二条插入失败：触发器要求第一条已写入，证明失败发生在部分写入之后。
  const ftsBefore = countRows(ctx.db, "memory_fts");
  const entriesBefore = countRows(ctx.db, "memory_entries");
  ctx.db.exec(`
    CREATE TRIGGER fail_relay_second BEFORE INSERT ON memory_entries
    WHEN NEW.character_id = 'd' AND NEW.fact_key = 'pref.third'
      AND EXISTS (
        SELECT 1 FROM memory_entries
        WHERE character_id = 'd' AND fact_key = 'pref.first'
      )
    BEGIN SELECT RAISE(ABORT, 'injected second insert failure'); END;
  `);
  assert.throws(
    () =>
      ctx.service.relay({
        fromCharacterId: "a",
        toCharacterId: "d",
        entries: [
          { entryId: first.entry.id, expectedVersion: 1 },
          { entryId: third.entry.id, expectedVersion: 1 },
        ],
      }),
    /injected second insert failure/u,
  );
  ctx.db.exec("DROP TRIGGER fail_relay_second");
  assert.deepEqual(ctx.service.listMemories("d"), []);
  assert.equal(ctx.service.getContextVersion("d"), 0);
  assert.equal(countRows(ctx.db, "memory_entries"), entriesBefore);
  assert.equal(countRows(ctx.db, "memory_fts"), ftsBefore);
  assert.equal(countRows(ctx.db, "memory_derivations"), 0);

  // 最后写入上下文版本失败：要求条目已写入，证明后续失败会回滚先前写入。
  ctx.db.exec(`
    CREATE TRIGGER fail_relay_context BEFORE INSERT ON memory_context_versions
    WHEN NEW.character_id = 'd'
      AND EXISTS (
        SELECT 1 FROM memory_entries
        WHERE character_id = 'd' AND fact_key = 'pref.first'
      )
    BEGIN SELECT RAISE(ABORT, 'injected context failure'); END;
  `);
  assert.throws(
    () => relayOne(ctx.service, "a", "d", first.entry.id, 1),
    /injected context failure/u,
  );
  ctx.db.exec("DROP TRIGGER fail_relay_context");
  assert.deepEqual(ctx.service.listMemories("d"), []);
  assert.equal(ctx.service.getContextVersion("d"), 0);
  assert.equal(countRows(ctx.db, "memory_entries"), entriesBefore);
  assert.equal(countRows(ctx.db, "memory_fts"), ftsBefore);
  assert.equal(countRows(ctx.db, "memory_derivations"), 0);

  // 明确转告成功后接收者旧上下文失效。
  const bBefore = ctx.service.getContextVersion("b");
  const result = relayOne(ctx.service, "a", "b", first.entry.id, 1);
  assert.ok(result.contextVersion > bBefore);
  assert.equal(ctx.service.getContextVersion("b"), result.contextVersion);
  assert.equal(ctx.service.isContextCurrent("b", bBefore), false);
  assert.equal(ctx.service.listMemories("b").length, 1);
});
