/* S03h 明确“这件事只让你记得”服务首片验收：真实 SQLite 连接与记忆服务，
   不启动 GUI、不调用模型。覆盖 POL-EXCLUSIVE-001～005；聊天入口、面板确认、
   单次确认与真实用户输入不在本切片，不能据本文件宣称这些边界已通过。 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { MemoryError, createMemoryService } = require("../../app/memory.cjs");
const { createMemoryDatabase, openMemoryDatabase } = require("./memory-fixtures.cjs");

const START = Date.UTC(2026, 9, 27, 12, 0, 0);

function makeContext(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-memory-exclusive-"));
  createMemoryDatabase(dir, ["a", "b", "c", "d"]).db.close();
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

function remember(service, characterId, factKey, body, sourceId, kind = "detail") {
  return service.remember({ characterId, factKey, body, sourceId, kind });
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

function countRows(db, table) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

function countFactRows(db, table, characterId, factKey) {
  return db
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE character_id = ? AND fact_key = ?`)
    .get(characterId, factKey).count;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function hasCode(code) {
  return (error) => error instanceof MemoryError && error.code === code;
}

function businessSnapshot(db) {
  return {
    roster: countRows(db, "roster"),
    stats: db.prepare("SELECT * FROM character_stats ORDER BY character_id").all(),
    relationships: db.prepare("SELECT * FROM relationships ORDER BY character_id").all(),
  };
}

test("POL-EXCLUSIVE-001 A 保留独属，清除 B 正文与检索，C 无新增且业务状态不变", (t) => {
  const ctx = makeContext(t);
  const original = remember(
    ctx.service,
    "a",
    "pref.drink",
    "用户的饮品偏好是冰美式",
    "a-drink",
    "preference",
  );
  relayOne(ctx.service, "a", "b", original.entry.id, 1);
  const bEntry = entryOf(ctx.service, "b", "pref.drink");
  assert.equal(bEntry.body, "用户的饮品偏好是冰美式");
  assert.equal(countRows(ctx.db, "memory_fts"), 2);
  const aContextBefore = ctx.service.getContextVersion("a");
  const bContextBefore = ctx.service.getContextVersion("b");
  const businessBefore = businessSnapshot(ctx.db);

  const result = ctx.service.keepExclusive({
    characterId: "a",
    entryId: original.entry.id,
    expectedVersion: 1,
  });
  assert.equal(result.cleared, 1);
  assert.deepEqual(result.clearedCharacters, ["b"]);
  assert.equal(result.retainedCharacterId, "a");
  assert.equal(result.retainedEntryId, original.entry.id);
  assert.equal(result.blockedSharing, true);
  assert.equal(result.alreadyExclusive, false);

  // 保留内容、可检索与版本变化。
  const retained = entryOf(ctx.service, "a", "pref.drink");
  assert.equal(retained.body, "用户的饮品偏好是冰美式");
  assert.equal(retained.version, 2);
  assert.equal(result.version, 2);
  assert.equal(ctx.service.searchMemories({ characterId: "a", query: "冰美式" }).length, 1);
  assert.ok(ctx.service.getContextVersion("a") > aContextBefore);
  assert.equal(result.contextVersions.a, ctx.service.getContextVersion("a"));

  // B 的正文、索引和持有关系全部清除，上下文旧操作失效。
  assert.deepEqual(ctx.service.listMemories("b"), []);
  assert.deepEqual(ctx.service.searchMemories({ characterId: "b", query: "冰美式" }), []);
  assert.equal(countFactRows(ctx.db, "memory_entries", "b", "pref.drink"), 0);
  assert.equal(
    ctx.db.prepare("SELECT COUNT(*) AS count FROM memory_fts WHERE entry_id = ?").get(bEntry.id)
      .count,
    0,
  );
  assert.ok(ctx.service.getContextVersion("b") > bContextBefore);
  assert.equal(result.contextVersions.b, ctx.service.getContextVersion("b"));

  // C 未因操作获得任何信息，也没有新增条目或控制。
  assert.deepEqual(ctx.service.listMemories("c"), []);
  assert.deepEqual(ctx.service.searchMemories({ characterId: "c", query: "冰美式" }), []);
  assert.equal(countRows(ctx.db, "memory_entries"), 1);
  assert.equal(countRows(ctx.db, "memory_fts"), 1);
  assert.equal(
    ctx.db.prepare("SELECT COUNT(*) AS count FROM memory_share_controls WHERE fact_key_hash = ?")
      .get(sha256("pref.drink")).count,
    1,
  );
  assert.deepEqual(businessSnapshot(ctx.db), businessBefore);
});

test("POL-EXCLUSIVE-002 A 保留听来的记忆，原持有者被清除后来源仍可说明且禁止转告", (t) => {
  const ctx = makeContext(t);
  const dEntry = remember(
    ctx.service,
    "d",
    "exp.qingdao",
    "用户曾在青岛吃蛤蜊",
    "d-qingdao",
    "experience",
  );
  relayOne(ctx.service, "d", "a", dEntry.entry.id, 1);
  const hearsay = entryOf(ctx.service, "a", "exp.qingdao");
  assert.equal(hearsay.derived, true);
  assert.equal(hearsay.originCharacterId, "d");
  assert.equal(hearsay.narratorCharacterId, "d");
  relayOne(ctx.service, "a", "b", hearsay.id, hearsay.version);
  const bEntry = entryOf(ctx.service, "b", "exp.qingdao");
  assert.equal(bEntry.narratorCharacterId, "a");

  const result = ctx.service.keepExclusive({
    characterId: "a",
    entryId: hearsay.id,
    expectedVersion: hearsay.version,
  });
  assert.equal(result.cleared, 2);
  assert.deepEqual(result.clearedCharacters, ["b", "d"]);
  assert.equal(result.version, 2);

  // D 与 B 的可用正文和检索被清除。
  assert.deepEqual(ctx.service.listMemories("d"), []);
  assert.deepEqual(ctx.service.listMemories("b"), []);
  assert.deepEqual(ctx.service.searchMemories({ characterId: "d", query: "蛤蜊" }), []);
  assert.deepEqual(ctx.service.searchMemories({ characterId: "b", query: "蛤蜊" }), []);
  assert.equal(countRows(ctx.db, "memory_entries"), 1);
  assert.equal(countRows(ctx.db, "memory_fts"), 1);

  // A 仍是“听 D 说”的派生内容，不变成亲历；父条目删除不抹掉讲述链。
  const retained = entryOf(ctx.service, "a", "exp.qingdao");
  assert.equal(retained.body, "用户曾在青岛吃蛤蜊");
  assert.equal(retained.trust, "stated");
  assert.equal(retained.derived, true);
  assert.equal(retained.originCharacterId, "d");
  assert.equal(retained.narratorCharacterId, "d");
  assert.equal(retained.derivedFromEntryId, dEntry.entry.id);
  assert.equal(retained.sourceId, `relay:${dEntry.entry.id}:a`);
  assert.equal(retained.version, 2);
  const derivation = ctx.db
    .prepare("SELECT * FROM memory_derivations WHERE entry_id = ?")
    .get(retained.id);
  assert.equal(derivation.parent_entry_id, dEntry.entry.id);
  assert.equal(derivation.origin_character_id, "d");
  assert.equal(derivation.narrator_character_id, "d");
  assert.equal(ctx.service.searchMemories({ characterId: "a", query: "蛤蜊" }).length, 1);

  // 派生内容本就不能再 share；明确 relay 被事实级禁分享拦下，且 C 不新增。
  assert.throws(
    () => ctx.service.share({ fromCharacterId: "a", toCharacterId: "c", entryIds: [retained.id] }),
    hasCode("SHARE_NOT_ALLOWED"),
  );
  assert.throws(
    () => relayOne(ctx.service, "a", "c", retained.id, retained.version),
    hasCode("SHARE_BLOCKED"),
  );
  assert.throws(() => relayOne(ctx.service, "b", "c", bEntry.id, bEntry.version), hasCode("SHARE_NOT_ALLOWED"));
  assert.deepEqual(ctx.service.listMemories("c"), []);
  assert.equal(countRows(ctx.db, "memory_entries"), 1);
});

test("POL-EXCLUSIVE-003 过期版本、未知条目、非持有者明确拒绝，重复确认幂等", (t) => {
  const ctx = makeContext(t);
  const original = remember(ctx.service, "a", "pref.tea", "用户喜欢茉莉花茶", "a-tea", "preference");
  relayOne(ctx.service, "a", "b", original.entry.id, 1);
  ctx.service.correct({
    characterId: "a",
    factKey: "pref.tea",
    body: "用户喜欢乌龙茶",
    sourceId: "a-tea-new",
  });
  const entryCountBefore = countRows(ctx.db, "memory_entries");
  const shareCountBefore = countRows(ctx.db, "memory_share_controls");
  const forgetCountBefore = countRows(ctx.db, "memory_forget_controls");
  const sourceCountBefore = countRows(ctx.db, "memory_source_controls");
  const ftsCountBefore = countRows(ctx.db, "memory_fts");
  const aVersionBefore = ctx.service.getContextVersion("a");
  const bVersionBefore = ctx.service.getContextVersion("b");

  // 过期版本不执行，B 与所有控制保持原样。
  assert.throws(
    () =>
      ctx.service.keepExclusive({
        characterId: "a",
        entryId: original.entry.id,
        expectedVersion: 1,
      }),
    hasCode("MEMORY_CHANGED"),
  );
  assert.equal(entryOf(ctx.service, "b", "pref.tea").body, "用户喜欢乌龙茶");
  assert.equal(countRows(ctx.db, "memory_entries"), entryCountBefore);
  assert.equal(countRows(ctx.db, "memory_share_controls"), shareCountBefore);
  assert.equal(countRows(ctx.db, "memory_forget_controls"), forgetCountBefore);
  assert.equal(countRows(ctx.db, "memory_source_controls"), sourceCountBefore);
  assert.equal(countRows(ctx.db, "memory_fts"), ftsCountBefore);
  assert.equal(ctx.service.getContextVersion("a"), aVersionBefore);
  assert.equal(ctx.service.getContextVersion("b"), bVersionBefore);

  // 未知条目、非持有者与缺少选中项均无假成功。
  assert.throws(
    () => ctx.service.keepExclusive({ characterId: "a", entryId: "missing-entry", expectedVersion: 1 }),
    hasCode("ENTRY_NOT_FOUND"),
  );
  assert.throws(
    () =>
      ctx.service.keepExclusive({
        characterId: "c",
        entryId: original.entry.id,
        expectedVersion: 2,
      }),
    hasCode("ENTRY_NOT_FOUND"),
  );
  assert.throws(
    () => ctx.service.keepExclusive({ characterId: "a" }),
    hasCode("INVALID_INPUT"),
  );

  const result = ctx.service.keepExclusive({
    characterId: "a",
    entryId: original.entry.id,
    expectedVersion: 2,
  });
  assert.equal(result.cleared, 1);
  assert.equal(result.version, 3);
  assert.deepEqual(ctx.service.listMemories("b"), []);
  const retained = entryOf(ctx.service, "a", "pref.tea");
  assert.equal(retained.body, "用户喜欢乌龙茶");
  assert.equal(retained.version, 3);

  // 用新版本重复确认：幂等返回，不再递增版本或新增控制。
  const stable = {
    entries: countRows(ctx.db, "memory_entries"),
    share: countRows(ctx.db, "memory_share_controls"),
    forget: countRows(ctx.db, "memory_forget_controls"),
    source: countRows(ctx.db, "memory_source_controls"),
    fts: countRows(ctx.db, "memory_fts"),
    a: ctx.service.getContextVersion("a"),
    b: ctx.service.getContextVersion("b"),
  };
  const repeated = ctx.service.keepExclusive({
    characterId: "a",
    entryId: original.entry.id,
    expectedVersion: 3,
  });
  assert.equal(repeated.alreadyExclusive, true);
  assert.equal(repeated.cleared, 0);
  assert.equal(repeated.version, 3);
  assert.deepEqual(repeated.contextVersions, {});
  assert.equal(entryOf(ctx.service, "a", "pref.tea").version, 3);
  assert.equal(countRows(ctx.db, "memory_entries"), stable.entries);
  assert.equal(countRows(ctx.db, "memory_share_controls"), stable.share);
  assert.equal(countRows(ctx.db, "memory_forget_controls"), stable.forget);
  assert.equal(countRows(ctx.db, "memory_source_controls"), stable.source);
  assert.equal(countRows(ctx.db, "memory_fts"), stable.fts);
  assert.equal(ctx.service.getContextVersion("a"), stable.a);
  assert.equal(ctx.service.getContextVersion("b"), stable.b);

  // 旧的已消费版本仍然被拒绝，不会因幂等分支变成成功。
  assert.throws(
    () =>
      ctx.service.keepExclusive({
        characterId: "a",
        entryId: original.entry.id,
        expectedVersion: 2,
      }),
    hasCode("MEMORY_CHANGED"),
  );
  assert.equal(entryOf(ctx.service, "a", "pref.tea").body, "用户喜欢乌龙茶");
});

test("POL-EXCLUSIVE-004 删除中途与最后版本写失败都全事务回滚，重试后成功", (t) => {
  const ctx = makeContext(t);
  const original = remember(ctx.service, "a", "detail.secret", "用户的秘密是银钥匙", "a-secret");
  relayOne(ctx.service, "a", "b", original.entry.id, 1);
  const bBefore = entryOf(ctx.service, "b", "detail.secret");
  const ftsBefore = countRows(ctx.db, "memory_fts");
  const aContextBefore = ctx.service.getContextVersion("a");
  const bContextBefore = ctx.service.getContextVersion("b");
  const hash = sha256("detail.secret");

  function assertUntouched() {
    const aNow = entryOf(ctx.service, "a", "detail.secret");
    const bNow = entryOf(ctx.service, "b", "detail.secret");
    assert.equal(aNow.body, "用户的秘密是银钥匙");
    assert.equal(aNow.version, 1);
    assert.equal(bNow.id, bBefore.id);
    assert.equal(bNow.body, "用户的秘密是银钥匙");
    assert.equal(ctx.service.searchMemories({ characterId: "b", query: "银钥匙" }).length, 1);
    assert.equal(countRows(ctx.db, "memory_entries"), 2);
    assert.equal(countRows(ctx.db, "memory_fts"), ftsBefore);
    assert.equal(
      ctx.db.prepare("SELECT COUNT(*) AS count FROM memory_share_controls WHERE fact_key_hash = ?")
        .get(hash).count,
      0,
    );
    assert.equal(
      ctx.db.prepare("SELECT COUNT(*) AS count FROM memory_forget_controls WHERE fact_key_hash = ?")
        .get(hash).count,
      0,
    );
    assert.equal(countRows(ctx.db, "memory_source_controls"), 0);
    assert.equal(countRows(ctx.db, "memory_derivations"), 1);
    assert.equal(ctx.service.getContextVersion("a"), aContextBefore);
    assert.equal(ctx.service.getContextVersion("b"), bContextBefore);
  }

  // 删除中途失败：派生关系与索引已先删，仍须完整恢复。
  ctx.db.exec(`
    CREATE TRIGGER fail_exclusive_delete BEFORE DELETE ON memory_entries
    WHEN OLD.character_id = 'b' AND OLD.fact_key = 'detail.secret'
    BEGIN SELECT RAISE(ABORT, 'injected exclusive delete failure'); END;
  `);
  assert.throws(
    () =>
      ctx.service.keepExclusive({
        characterId: "a",
        entryId: original.entry.id,
        expectedVersion: 1,
      }),
    /injected exclusive delete failure/u,
  );
  ctx.db.exec("DROP TRIGGER fail_exclusive_delete");
  assertUntouched();

  // 最后写上下文版本失败：此前的删除、保留者改版本与控制写入全部回滚。
  ctx.db.exec(`
    CREATE TRIGGER fail_exclusive_final BEFORE UPDATE ON memory_context_versions
    WHEN NEW.character_id = 'a'
    BEGIN SELECT RAISE(ABORT, 'injected exclusive final failure'); END;
  `);
  assert.throws(
    () =>
      ctx.service.keepExclusive({
        characterId: "a",
        entryId: original.entry.id,
        expectedVersion: 1,
      }),
    /injected exclusive final failure/u,
  );
  ctx.db.exec("DROP TRIGGER fail_exclusive_final");
  assertUntouched();

  // 移除注入故障后重试成功，且只产生一次结果。
  const result = ctx.service.keepExclusive({
    characterId: "a",
    entryId: original.entry.id,
    expectedVersion: 1,
  });
  assert.equal(result.cleared, 1);
  assert.equal(result.version, 2);
  assert.equal(entryOf(ctx.service, "a", "detail.secret").version, 2);
  assert.deepEqual(ctx.service.listMemories("b"), []);
  assert.deepEqual(ctx.service.searchMemories({ characterId: "b", query: "银钥匙" }), []);
  assert.equal(countRows(ctx.db, "memory_entries"), 1);
  assert.equal(countRows(ctx.db, "memory_fts"), 1);
  assert.equal(countRows(ctx.db, "memory_derivations"), 0);
  assert.equal(
    ctx.db.prepare("SELECT COUNT(*) AS count FROM memory_share_controls WHERE fact_key_hash = ?")
      .get(hash).count,
    1,
  );
  assert.ok(ctx.service.getContextVersion("a") > aContextBefore);
  assert.ok(ctx.service.getContextVersion("b") > bContextBefore);
});

test("POL-EXCLUSIVE-005 旧来源与历史派生不能回流，无关事实和控制保持", (t) => {
  const ctx = makeContext(t);
  const cat = remember(ctx.service, "a", "exp.cat", "用户养过一只叫团子的猫", "a-cat", "experience");
  relayOne(ctx.service, "a", "b", cat.entry.id, 1);
  const bCat = entryOf(ctx.service, "b", "exp.cat");
  const bOldSource = bCat.sourceId;

  const teaA = remember(ctx.service, "a", "pref.tea", "用户喜欢茉莉花茶", "a-tea", "preference");
  relayOne(ctx.service, "a", "b", teaA.entry.id, 1);
  ctx.service.restrictSharing({
    characterId: "a",
    entryId: teaA.entry.id,
    expectedVersion: 1,
  });
  const teaShareHash = sha256("pref.tea");

  const result = ctx.service.keepExclusive({
    characterId: "a",
    entryId: cat.entry.id,
    expectedVersion: 1,
  });
  assert.equal(result.cleared, 1);
  assert.deepEqual(ctx.service.listMemories("b").map((entry) => entry.factKey), ["pref.tea"]);

  // 无关事实与控制未被整段清理。
  assert.equal(entryOf(ctx.service, "a", "pref.tea").body, "用户喜欢茉莉花茶");
  assert.equal(entryOf(ctx.service, "b", "pref.tea").body, "用户喜欢茉莉花茶");
  assert.equal(ctx.service.searchMemories({ characterId: "b", query: "茉莉花茶" }).length, 1);
  assert.equal(ctx.service.searchMemories({ characterId: "a", query: "团子" }).length, 1);
  assert.equal(
    ctx.db.prepare("SELECT COUNT(*) AS count FROM memory_share_controls WHERE fact_key_hash = ?")
      .get(teaShareHash).count,
    1,
  );
  assert.equal(countRows(ctx.db, "memory_share_controls"), 2);
  assert.equal(countRows(ctx.db, "memory_entries"), 3);
  assert.equal(countRows(ctx.db, "memory_fts"), 3);

  // 旧来源重新记忆被无正文来源控制拦下。
  const oldSourceRecall = remember(ctx.service, "b", "exp.cat", "用户养过一只叫团子的猫", bOldSource, "experience");
  assert.equal(oldSourceRecall.created, false);
  assert.equal(oldSourceRecall.blocked, "source");
  // 换新来源仍被事实级忘记控制拦下。
  const newSourceRecall = remember(ctx.service, "b", "exp.cat", "用户养过一只叫团子的猫", "b-new-cat", "experience");
  assert.equal(newSourceRecall.created, false);
  assert.equal(newSourceRecall.blocked, "forget");

  // 历史来源重分析（同来源或新来源）都不能重建被清除的持有关系。
  const sameSourceAnalysis = ctx.service.applyExtractionBatch({
    characterId: "b",
    sourceId: bOldSource,
    sourceVersion: 1,
    facts: [{ factKey: "exp.cat", body: "用户养过一只叫团子的猫", kind: "experience" }],
  });
  assert.equal(sameSourceAnalysis.applied, false);
  assert.equal(sameSourceAnalysis.reason, "blocked_source");
  const newSourceAnalysis = ctx.service.applyExtractionBatch({
    characterId: "b",
    sourceId: "b-reanalysis",
    sourceVersion: 1,
    facts: [{ factKey: "exp.cat", body: "用户养过一只叫团子的猫", kind: "experience" }],
  });
  assert.equal(newSourceAnalysis.applied, true);
  assert.equal(newSourceAnalysis.facts[0].created, false);
  assert.equal(newSourceAnalysis.facts[0].blocked, "forget");
  assert.deepEqual(ctx.service.listMemories("b").map((entry) => entry.factKey), ["pref.tea"]);

  // 历史派生转告与重放都不能送回 B 或新增 C。
  assert.throws(() => relayOne(ctx.service, "b", "c", bCat.id, bCat.version), hasCode("SHARE_NOT_ALLOWED"));
  assert.throws(
    () =>
      relayOne(
        ctx.service,
        "a",
        "b",
        entryOf(ctx.service, "a", "exp.cat").id,
        entryOf(ctx.service, "a", "exp.cat").version,
      ),
    hasCode("SHARE_BLOCKED"),
  );
  assert.throws(
    () =>
      relayOne(
        ctx.service,
        "a",
        "c",
        entryOf(ctx.service, "a", "exp.cat").id,
        entryOf(ctx.service, "a", "exp.cat").version,
      ),
    hasCode("SHARE_BLOCKED"),
  );
  assert.throws(
    () =>
      ctx.service.share({
        fromCharacterId: "a",
        toCharacterId: "c",
        entryIds: [entryOf(ctx.service, "a", "exp.cat").id],
      }),
    hasCode("SHARE_BLOCKED"),
  );
  assert.deepEqual(ctx.service.listMemories("c"), []);

  // 重开数据库后控制仍生效，不会重新学习。
  ctx.reopen();
  assert.equal(ctx.service.searchMemories({ characterId: "a", query: "团子" }).length, 1);
  assert.deepEqual(ctx.service.listMemories("b").map((entry) => entry.factKey), ["pref.tea"]);
  const afterReopen = remember(ctx.service, "b", "exp.cat", "用户养过一只叫团子的猫", "b-after-reopen", "experience");
  assert.equal(afterReopen.created, false);
  assert.equal(afterReopen.blocked, "forget");
  assert.equal(countRows(ctx.db, "memory_entries"), 3);
});
