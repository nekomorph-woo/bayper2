/* S03l-b 已核实事实原子关联验收：真实 SQLite、正式 memory 服务入口，
   不启动 GUI、不调用模型、不访问目录。覆盖 POL-ASSOC-001～005。
   等价决定由测试中的固定构造提供；本文件只验证执行器边界，不能据此
   宣称主体/时间/来源核验或生产模型接线已完成。 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { MemoryError, createMemoryService } = require("../../app/memory.cjs");
const { identityFingerprint } = require("../../app/memory-fact-identity.cjs");
const { createMemoryDatabase, openMemoryDatabase } = require("./memory-fixtures.cjs");

const START = Date.UTC(2026, 9, 27, 12, 0, 0);

function makeContext(t, characters = ["a", "b", "c", "d", "e"]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-memory-association-"));
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
    advance(ms) {
      nowMs += ms;
    },
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

function remember(service, characterId, factKey, body, sourceId, overrides = {}) {
  return service.remember({
    characterId,
    factKey,
    body,
    kind: "preference",
    sourceId,
    ...overrides,
  });
}

function entryOf(service, characterId, factKey) {
  return service.listMemories(characterId).find((entry) => entry.factKey === factKey) ?? null;
}

function identityOf(db, characterId, factKey) {
  return db
    .prepare(
      "SELECT fact_identity_id FROM memory_entries WHERE character_id = ? AND fact_key = ?",
    )
    .get(characterId, factKey)?.fact_identity_id ?? null;
}

function entryRow(db, entryId) {
  return db.prepare("SELECT * FROM memory_entries WHERE id = ?").get(entryId);
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

function associate(ctx, leftId, rightId, leftVersion = 1, rightVersion = 1) {
  return ctx.service.associateFacts({
    left: { entryId: leftId, expectedVersion: leftVersion },
    right: { entryId: rightId, expectedVersion: rightVersion },
    nowMs: ctx.nowMs(),
  });
}

function shareOne(ctx, fromCharacterId, toCharacterId, entryId, sourceId) {
  return ctx.service.share({
    fromCharacterId,
    toCharacterId,
    entryIds: [entryId],
    sourceId,
  });
}

function relayOne(ctx, fromCharacterId, toCharacterId, entryId, expectedVersion) {
  return ctx.service.relay({
    fromCharacterId,
    toCharacterId,
    entries: [{ entryId, expectedVersion }],
  });
}

function ftsSnapshot(db) {
  return db
    .prepare("SELECT entry_id, char_tokens, segment_tokens FROM memory_fts ORDER BY entry_id")
    .all();
}

/* 拒绝路径必须零部分变更：一并比对正文、身份、版本、FTS 内容、别名、歧义、
   来源/禁分享/删除控制、派生记录与上下文版本。 */
function stateSnapshot(db) {
  return {
    entries: db.prepare("SELECT * FROM memory_entries ORDER BY id").all(),
    fts: ftsSnapshot(db),
    identities: db.prepare("SELECT * FROM memory_fact_identities ORDER BY identity_id").all(),
    aliases: db.prepare("SELECT * FROM memory_fact_aliases ORDER BY fingerprint").all(),
    conflicts: db
      .prepare("SELECT * FROM memory_fact_alias_conflicts ORDER BY fingerprint, identity_id")
      .all(),
    shareControls: db
      .prepare("SELECT * FROM memory_share_identity_controls ORDER BY identity_id")
      .all(),
    legacyShareControls: db
      .prepare("SELECT * FROM memory_share_controls ORDER BY fact_key_hash")
      .all(),
    forgetControls: db
      .prepare("SELECT * FROM memory_forget_identity_controls ORDER BY character_id, identity_id")
      .all(),
    legacyForgetControls: db
      .prepare("SELECT * FROM memory_forget_controls ORDER BY character_id, fact_key_hash")
      .all(),
    sourceControls: db
      .prepare("SELECT * FROM memory_source_controls ORDER BY character_id, source_id_hash")
      .all(),
    deletedFingerprints: db
      .prepare("SELECT * FROM memory_deleted_fact_fingerprints ORDER BY character_id, fingerprint")
      .all(),
    derivations: db.prepare("SELECT * FROM memory_derivations ORDER BY entry_id").all(),
    contexts: db.prepare("SELECT * FROM memory_context_versions ORDER BY character_id").all(),
  };
}

function assertRejected(ctx, leftId, leftVersion, rightId, rightVersion, code) {
  const before = stateSnapshot(ctx.db);
  assert.throws(
    () => associate(ctx, leftId, rightId, leftVersion, rightVersion),
    hasCode(code),
  );
  assert.deepEqual(stateSnapshot(ctx.db), before);
}

test("POL-ASSOC-001 内部关联合并身份，正文/来源/派生不变，纠正同步且重启保持", (t) => {
  const ctx = makeContext(t);
  const aCoffee = remember(ctx.service, "a", "pref.assoc.coffee.a", "用户喜欢甜咖啡", "a-sweet-coffee");
  const bCoffee = remember(ctx.service, "b", "pref.assoc.coffee.b", "用户喜欢加糖咖啡", "b-sugared-coffee");
  assert.notEqual(
    identityOf(ctx.db, "a", "pref.assoc.coffee.a"),
    identityOf(ctx.db, "b", "pref.assoc.coffee.b"),
  );
  const aBefore = entryRow(ctx.db, aCoffee.entry.id);
  const bBefore = entryRow(ctx.db, bCoffee.entry.id);
  const ftsBefore = ftsSnapshot(ctx.db);
  const derivationsBefore = countRows(ctx.db, "memory_derivations");
  const aContextBefore = ctx.service.getContextVersion("a");
  const bContextBefore = ctx.service.getContextVersion("b");

  const result = associate(ctx, aCoffee.entry.id, bCoffee.entry.id);
  assert.equal(result.associated, true);
  assert.equal(result.alreadyAssociated, false);
  assert.equal(result.affectedEntries, 2);
  assert.deepEqual(result.affectedCharacters, ["a", "b"]);
  assert.deepEqual(result.contextVersions, {
    a: aContextBefore + 1,
    b: bContextBefore + 1,
  });
  assert.equal(identityOf(ctx.db, "a", "pref.assoc.coffee.a"), result.identityId);
  assert.equal(identityOf(ctx.db, "b", "pref.assoc.coffee.b"), result.identityId);

  // 正文、事实键、来源、创建时间与派生性质不变，仅身份与版本被重写。
  const aAfter = entryRow(ctx.db, aCoffee.entry.id);
  const bAfter = entryRow(ctx.db, bCoffee.entry.id);
  assert.equal(aAfter.version, 2);
  assert.equal(bAfter.version, 2);
  for (const [before, after] of [
    [aBefore, aAfter],
    [bBefore, bAfter],
  ]) {
    for (const key of [
      "body",
      "fact_key",
      "source_id",
      "source_version",
      "created_at",
      "origin_character_id",
    ]) {
      assert.equal(after[key], before[key]);
    }
  }
  assert.deepEqual(ftsSnapshot(ctx.db), ftsBefore);
  assert.equal(countRows(ctx.db, "memory_derivations"), derivationsBefore);
  assert.deepEqual(ctx.service.listMemories("c"), []);

  // 当前有效版本重复确认幂等：不再递增条目版本或上下文版本。
  const idempotent = associate(ctx, aCoffee.entry.id, bCoffee.entry.id, 2, 2);
  assert.equal(idempotent.associated, false);
  assert.equal(idempotent.alreadyAssociated, true);
  assert.deepEqual(idempotent.contextVersions, {});
  assert.equal(entryRow(ctx.db, aCoffee.entry.id).version, 2);
  assert.equal(entryRow(ctx.db, bCoffee.entry.id).version, 2);

  ctx.service.correct({
    characterId: "a",
    entryId: aCoffee.entry.id,
    expectedVersion: 2,
    body: "用户现在只喝黑咖啡",
    sourceId: "a-corrected-coffee",
  });
  const bCorrected = entryOf(ctx.service, "b", "pref.assoc.coffee.b");
  assert.equal(bCorrected.body, "用户现在只喝黑咖啡");
  assert.equal(bCorrected.version, 3);
  assert.ok(ctx.service.listExcludedSources("b").includes(sha256("b-sugared-coffee")));
  assert.deepEqual(ctx.service.listMemories("c"), []);
  assert.equal(countRows(ctx.db, "memory_entries"), 2);

  ctx.reopen();
  assert.equal(
    identityOf(ctx.db, "a", "pref.assoc.coffee.a"),
    identityOf(ctx.db, "b", "pref.assoc.coffee.b"),
  );
  assert.equal(
    entryOf(ctx.service, "b", "pref.assoc.coffee.b").body,
    "用户现在只喝黑咖啡",
  );
  assert.deepEqual(ctx.service.listMemories("c"), []);
});

test("POL-ASSOC-002 真实 share/relay 组成关联后禁分享覆盖同义组，第三方歧义保留", (t) => {
  const ctx = makeContext(t);
  const aTea = remember(ctx.service, "a", "pref.assoc.tea.a", "用户喜欢甜咖啡", "a-tea");
  shareOne(ctx, "a", "b", aTea.entry.id);
  const bTea = entryOf(ctx.service, "b", "pref.assoc.tea.a");
  relayOne(ctx, "b", "c", bTea.id, 1);
  const cCoffee = remember(ctx.service, "c", "pref.assoc.tea.c", "用户喜欢加糖咖啡", "c-coffee");
  shareOne(ctx, "c", "d", cCoffee.entry.id);
  const groupOneIdentity = identityOf(ctx.db, "a", "pref.assoc.tea.a");
  const groupTwoIdentity = identityOf(ctx.db, "c", "pref.assoc.tea.c");
  assert.notEqual(groupOneIdentity, groupTwoIdentity);

  // 先禁分享其中一组；关联后限制必须随身份迁移到 canonical。
  ctx.service.restrictSharing({
    characterId: "a",
    entryId: aTea.entry.id,
    expectedVersion: 1,
  });

  // 第三方歧义：同一指纹还指向另一个身份，关联不得消除该引用。
  // 把别名/歧义挂在将被合并的身份上，确保覆盖真实的迁移路径。
  const [canonicalExpected, mergedExpected] = [groupOneIdentity, groupTwoIdentity].sort();
  const thirdIdentity = crypto.randomUUID();
  const ambiguousFingerprint = crypto.randomBytes(32).toString("hex");
  const aliasFingerprint = crypto.randomBytes(32).toString("hex");
  ctx.db
    .prepare("INSERT INTO memory_fact_identities (identity_id, created_at) VALUES (?, ?)")
    .run(thirdIdentity, START);
  for (const identityId of [mergedExpected, thirdIdentity]) {
    ctx.db
      .prepare(
        `INSERT INTO memory_fact_alias_conflicts (fingerprint, identity_id, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(ambiguousFingerprint, identityId, START);
  }
  ctx.db
    .prepare(
      `INSERT INTO memory_fact_aliases (fingerprint, identity_id, created_at)
       VALUES (?, ?, ?)`,
    )
    .run(aliasFingerprint, mergedExpected, START);

  // c 同时属于两组：上下文版本仍只递增一次。
  const cContextBefore = ctx.service.getContextVersion("c");
  const result = associate(ctx, aTea.entry.id, cCoffee.entry.id);
  assert.equal(result.associated, true);
  assert.deepEqual(result.affectedCharacters, ["a", "b", "c", "d"]);
  assert.equal(result.contextVersions.c, cContextBefore + 1);
  assert.equal(ctx.service.getContextVersion("c"), cContextBefore + 1);
  const canonical = result.identityId;
  assert.equal(canonical, canonicalExpected);
  assert.equal(
    ctx.db
      .prepare("SELECT identity_id FROM memory_share_identity_controls WHERE identity_id = ?")
      .get(canonical)?.identity_id,
    canonical,
  );
  assert.equal(
    ctx.db
      .prepare("SELECT identity_id FROM memory_fact_aliases WHERE fingerprint = ?")
      .get(aliasFingerprint)?.identity_id,
    canonical,
  );
  const conflictIdentities = () =>
    ctx.db
      .prepare(
        `SELECT identity_id FROM memory_fact_alias_conflicts
         WHERE fingerprint = ? ORDER BY identity_id`,
      )
      .all(ambiguousFingerprint)
      .map((row) => row.identity_id);
  assert.deepEqual(conflictIdentities(), [canonical, thirdIdentity].sort());
  assert.equal(
    ctx.db
      .prepare("SELECT COUNT(*) AS count FROM memory_fact_identities WHERE identity_id = ?")
      .get(thirdIdentity).count,
    1,
  );

  // 禁分享覆盖合并后的全部同义持有者，转告与分享被拒绝且不泄漏给新角色。
  const dTea = entryOf(ctx.service, "d", "pref.assoc.tea.c");
  assert.throws(
    () => relayOne(ctx, "d", "e", dTea.id, 2),
    hasCode("SHARE_BLOCKED"),
  );
  assert.throws(
    () => shareOne(ctx, "c", "e", cCoffee.entry.id),
    hasCode("SHARE_BLOCKED"),
  );
  assert.deepEqual(ctx.service.listMemories("e"), []);

  // 重启后限制与第三方歧义仍保留。
  ctx.reopen();
  const afterRestart = entryOf(ctx.service, "d", "pref.assoc.tea.c");
  assert.throws(
    () => relayOne(ctx, "d", "e", afterRestart.id, 2),
    hasCode("SHARE_BLOCKED"),
  );
  assert.deepEqual(conflictIdentities(), [canonical, thirdIdentity].sort());
});

test("POL-ASSOC-002 仅清理本次合并消除的歧义，精确正文别名仍可复用", (t) => {
  const ctx = makeContext(t);
  const aEntry = remember(ctx.service, "a", "pref.assoc.alias.a", "用户喜欢冷泡咖啡", "a-alias");
  const bEntry = remember(ctx.service, "b", "pref.assoc.alias.b", "用户爱喝冷泡咖啡", "b-alias");
  const leftIdentity = identityOf(ctx.db, "a", "pref.assoc.alias.a");
  const rightIdentity = identityOf(ctx.db, "b", "pref.assoc.alias.b");
  const [canonical, merged] = [leftIdentity, rightIdentity].sort();
  const mergedEntry = merged === leftIdentity ? aEntry.entry : bEntry.entry;
  const fingerprint = identityFingerprint({
    kind: "preference",
    trust: "stated",
    sourceKind: "user",
    expiresAt: null,
    body: mergedEntry.body,
  });
  assert.equal(
    ctx.db
      .prepare("SELECT identity_id FROM memory_fact_aliases WHERE fingerprint = ?")
      .get(fingerprint)?.identity_id,
    merged,
  );
  for (const identityId of [canonical, merged]) {
    ctx.db
      .prepare(
        `INSERT INTO memory_fact_alias_conflicts (fingerprint, identity_id, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(fingerprint, identityId, START);
  }
  const identitiesBefore = countRows(ctx.db, "memory_fact_identities");

  associate(ctx, aEntry.entry.id, bEntry.entry.id);
  assert.equal(
    ctx.db
      .prepare("SELECT COUNT(*) AS count FROM memory_fact_alias_conflicts WHERE fingerprint = ?")
      .get(fingerprint).count,
    0,
  );
  assert.equal(
    ctx.db
      .prepare("SELECT identity_id FROM memory_fact_aliases WHERE fingerprint = ?")
      .get(fingerprint)?.identity_id,
    canonical,
  );

  // 正式 remember 用精确同文重新学入，必须复用已确认的 canonical 身份。
  const reused = remember(
    ctx.service,
    "c",
    "pref.assoc.alias.c",
    mergedEntry.body,
    "c-alias",
  );
  assert.equal(reused.created, true);
  assert.equal(reused.entry.factIdentityId, canonical);
  assert.equal(countRows(ctx.db, "memory_fact_identities"), identitiesBefore);
});

test("POL-ASSOC-003 关联后独属清除其他持有者，原文换键重学受限且重启保持", (t) => {
  const ctx = makeContext(t);
  const aEntry = remember(ctx.service, "a", "pref.assoc.exclusive.a", "用户喜欢桂花乌龙", "a-osmanthus");
  const bEntry = remember(ctx.service, "b", "pref.assoc.exclusive.b", "用户喜欢桂花乌龙茶", "b-osmanthus");
  associate(ctx, aEntry.entry.id, bEntry.entry.id);
  const exclusive = ctx.service.keepExclusive({
    characterId: "a",
    entryId: aEntry.entry.id,
    expectedVersion: 2,
  });
  assert.equal(exclusive.cleared, 1);
  assert.deepEqual(exclusive.clearedCharacters, ["b"]);
  assert.deepEqual(ctx.service.listMemories("b"), []);
  assert.deepEqual(ctx.service.listMemories("c"), []);
  assert.equal(entryOf(ctx.service, "a", "pref.assoc.exclusive.a").version, 3);
  assert.equal(countRows(ctx.db, "memory_fts"), 1);

  const relearnB = remember(
    ctx.service,
    "b",
    "pref.assoc.exclusive.relearn",
    "用户喜欢桂花乌龙茶",
    "b-never-seen",
  );
  assert.equal(relearnB.created, false);
  assert.equal(relearnB.blocked, "forget");

  ctx.reopen();
  assert.equal(entryOf(ctx.service, "a", "pref.assoc.exclusive.a").body, "用户喜欢桂花乌龙");
  assert.deepEqual(ctx.service.listMemories("b"), []);
  assert.equal(countRows(ctx.db, "memory_fts"), 1);
  assert.equal(countRows(ctx.db, "memory_entries"), 1);
  const afterRestart = remember(
    ctx.service,
    "b",
    "pref.assoc.exclusive.after-restart",
    "用户喜欢桂花乌龙茶",
    "b-after-restart",
  );
  assert.equal(afterRestart.created, false);
  assert.equal(afterRestart.blocked, "forget");
});

test("POL-ASSOC-003 关联后默认删除清除全部持有者，FTS/重启检查", (t) => {
  const ctx = makeContext(t);
  const aEntry = remember(ctx.service, "a", "pref.assoc.remove.a", "用户喜欢冷泡咖啡", "a-cold-brew");
  const bEntry = remember(ctx.service, "b", "pref.assoc.remove.b", "用户爱喝冷泡咖啡", "b-cold-brew");
  associate(ctx, aEntry.entry.id, bEntry.entry.id);
  const removed = ctx.service.forget({
    characterId: "a",
    entryId: aEntry.entry.id,
    expectedVersion: 2,
  });
  assert.equal(removed.deleted, 2);
  assert.deepEqual(removed.affectedCharacters, ["a", "b"]);
  assert.deepEqual(ctx.service.listMemories("a"), []);
  assert.deepEqual(ctx.service.listMemories("b"), []);
  assert.deepEqual(ctx.service.listMemories("c"), []);
  assert.equal(countRows(ctx.db, "memory_fts"), 0);
  assert.equal(countRows(ctx.db, "memory_entries"), 0);

  ctx.reopen();
  assert.deepEqual(ctx.service.listMemories("b"), []);
  assert.equal(countRows(ctx.db, "memory_fts"), 0);
  const relearn = remember(
    ctx.service,
    "b",
    "pref.assoc.remove.relearn",
    "用户爱喝冷泡咖啡",
    "b-never-seen",
  );
  assert.equal(relearn.created, false);
  assert.equal(relearn.blocked, "forget");
});

test("POL-ASSOC-004 过期、metadata 不同、主题、推断与来源受限均整体拒绝", (t) => {
  const ctx = makeContext(t);
  const expired = remember(ctx.service, "a", "pref.assoc.reject.expired", "用户喜欢会过期的甜咖啡", "a-expired", {
    expiresAt: START + 1000,
  });
  const unexpired = remember(ctx.service, "b", "pref.assoc.reject.unexpired", "用户喜欢不会过期的加糖咖啡", "b-unexpired");
  const kindLeft = remember(ctx.service, "a", "pref.assoc.reject.kind-a", "用户喜欢浅烘", "a-kind");
  const kindRight = remember(ctx.service, "b", "pref.assoc.reject.kind-b", "用户喜欢深烘", "b-kind", {
    kind: "detail",
  });
  const themeLeft = remember(ctx.service, "a", "pref.assoc.reject.theme-a", "故事里的用户喜欢红茶", "a-theme", {
    sourceKind: "theme",
  });
  const themeRight = remember(ctx.service, "b", "pref.assoc.reject.theme-b", "故事里的用户喜欢奶茶", "b-theme", {
    sourceKind: "theme",
  });
  const inferredLeft = remember(ctx.service, "a", "pref.assoc.reject.inferred-a", "用户可能喜欢气泡水", "a-inferred", {
    trust: "inferred",
  });
  const inferredRight = remember(ctx.service, "b", "pref.assoc.reject.inferred-b", "用户可能喜欢苏打水", "b-inferred", {
    trust: "inferred",
  });
  const restrictedSource = remember(ctx.service, "a", "pref.assoc.reject.source", "用户喜欢青柠苏打", "a-controlled-source");
  const sourceToExclude = remember(ctx.service, "a", "pref.assoc.reject.source-other", "用户喜欢柠檬汽水", "a-controlled-source");
  ctx.service.forget({
    characterId: "a",
    entryId: sourceToExclude.entry.id,
    expectedVersion: 1,
    scope: "self",
  });
  const sourceRight = remember(ctx.service, "b", "pref.assoc.reject.source-b", "用户喜欢青柠气泡水", "b-source");
  ctx.advance(5000);

  for (const [left, right] of [
    [expired, unexpired],
    [kindLeft, kindRight],
    [themeLeft, themeRight],
    [inferredLeft, inferredRight],
    [restrictedSource, sourceRight],
  ]) {
    assertRejected(ctx, left.entry.id, 1, right.entry.id, 1, "ASSOCIATION_REJECTED");
  }
});

test("POL-ASSOC-004 真实 share/forget 使组内第三持有者来源受限时整体拒绝", (t) => {
  const ctx = makeContext(t);
  const aEntry = remember(ctx.service, "a", "pref.assoc.group.a", "用户喜欢冷泡咖啡", "a-group");
  const aOther = remember(ctx.service, "a", "pref.assoc.group.other", "用户喜欢冰美式", "a-other");
  shareOne(ctx, "a", "c", aEntry.entry.id, "shared-source");
  shareOne(ctx, "a", "c", aOther.entry.id, "shared-source");
  const cOther = entryOf(ctx.service, "c", "pref.assoc.group.other");
  ctx.service.forget({
    characterId: "c",
    entryId: cOther.id,
    expectedVersion: 1,
    scope: "self",
  });
  const dEntry = remember(ctx.service, "d", "pref.assoc.group.d", "用户爱喝冷泡咖啡", "d-group");

  // c 仍持有同来源的组内条目；该来源已被正式 forget 排除。
  assert.ok(ctx.service.listExcludedSources("c").includes(sha256("shared-source")));
  assertRejected(ctx, aEntry.entry.id, 1, dEntry.entry.id, 1, "ASSOCIATION_REJECTED");
});

test("POL-ASSOC-004 缺失、过旧版本与身份级 forget 限制均拒绝且零部分变更", (t) => {
  const ctx = makeContext(t);
  const left = remember(ctx.service, "a", "pref.assoc.forget.a", "用户喜欢蜂蜜水", "a-honey");
  const right = remember(ctx.service, "b", "pref.assoc.forget.b", "用户爱喝蜂蜜水", "b-honey");
  const other = remember(ctx.service, "c", "pref.assoc.forget.c", "用户喜欢蜂蜜柚子茶", "c-honey");
  assertRejected(ctx, "missing-entry", 1, right.entry.id, 1, "ENTRY_NOT_FOUND");
  assertRejected(ctx, left.entry.id, 9, right.entry.id, 1, "MEMORY_CHANGED");

  associate(ctx, left.entry.id, right.entry.id);
  // a 仅自己忘记后不再持有该身份，但身份级限制仍留在数据库里。
  ctx.service.forget({
    characterId: "a",
    entryId: left.entry.id,
    expectedVersion: 2,
    scope: "self",
  });
  assert.equal(
    ctx.db
      .prepare(
        "SELECT COUNT(*) AS count FROM memory_forget_identity_controls WHERE character_id = 'a'",
      )
      .get().count,
    1,
  );
  assertRejected(
    ctx,
    right.entry.id,
    2,
    other.entry.id,
    1,
    "ASSOCIATION_FORGET_RESTRICTED",
  );
});

test("POL-ASSOC-005 迁移故障整体回滚，重试只递增一次上下文，旧版本不可重放", (t) => {
  const ctx = makeContext(t);
  const left = remember(ctx.service, "a", "pref.assoc.rollback.a", "用户喜欢茉莉花茶", "a-jasmine");
  const right = remember(ctx.service, "b", "pref.assoc.rollback.b", "用户爱喝茉莉花茶", "b-jasmine");
  const leftIdentity = identityOf(ctx.db, "a", "pref.assoc.rollback.a");
  const rightIdentity = identityOf(ctx.db, "b", "pref.assoc.rollback.b");
  const fingerprintOf = (entry) =>
    identityFingerprint({
      kind: "preference",
      trust: "stated",
      sourceKind: "user",
      expiresAt: null,
      body: entry.body,
    });
  const leftFingerprint = fingerprintOf(left.entry);
  const rightFingerprint = fingerprintOf(right.entry);
  // 两个拟合并身份都有真实禁分享限制，确保无论哪组被迁移都覆盖控制回滚。
  ctx.service.restrictSharing({
    characterId: "a",
    entryId: left.entry.id,
    expectedVersion: 1,
  });
  ctx.service.restrictSharing({
    characterId: "b",
    entryId: right.entry.id,
    expectedVersion: 1,
  });
  const shareControlIdentities = () =>
    ctx.db
      .prepare("SELECT identity_id FROM memory_share_identity_controls ORDER BY identity_id")
      .all()
      .map((row) => row.identity_id);
  const aliasIdentity = (fingerprint) =>
    ctx.db
      .prepare("SELECT identity_id FROM memory_fact_aliases WHERE fingerprint = ?")
      .get(fingerprint)?.identity_id ?? null;
  const assertRestrictionsRestored = () => {
    assert.deepEqual(shareControlIdentities(), [leftIdentity, rightIdentity].sort());
    assert.equal(aliasIdentity(leftFingerprint), leftIdentity);
    assert.equal(aliasIdentity(rightFingerprint), rightIdentity);
  };
  assertRestrictionsRestored();
  const before = stateSnapshot(ctx.db);
  const ftsBefore = ftsSnapshot(ctx.db);

  ctx.db.exec(`
    CREATE TRIGGER fail_association
    BEFORE UPDATE OF fact_identity_id ON memory_entries
    WHEN NEW.id = '${right.entry.id}'
    BEGIN
      SELECT RAISE(ABORT, 'injected association failure');
    END
  `);
  assert.throws(
    () => associate(ctx, left.entry.id, right.entry.id),
    /injected association failure/,
  );
  assert.deepEqual(stateSnapshot(ctx.db), before);
  assertRestrictionsRestored();
  ctx.db.exec("DROP TRIGGER fail_association");

  // 在最后一条 context 写入失败：此前的条目、别名与控制迁移也必须回滚。
  ctx.db.exec(`
    CREATE TRIGGER fail_context_write
    BEFORE UPDATE ON memory_context_versions
    WHEN NEW.character_id = 'b'
    BEGIN
      SELECT RAISE(ABORT, 'injected context failure');
    END
  `);
  assert.throws(
    () => associate(ctx, left.entry.id, right.entry.id),
    /injected context failure/,
  );
  assert.deepEqual(stateSnapshot(ctx.db), before);
  assertRestrictionsRestored();
  ctx.db.exec("DROP TRIGGER fail_context_write");

  // 故障回滚后同一当前版本可重试成功，且每个角色只递增一次上下文。
  const aContextBefore = ctx.service.getContextVersion("a");
  const bContextBefore = ctx.service.getContextVersion("b");
  const associated = associate(ctx, left.entry.id, right.entry.id);
  assert.equal(associated.associated, true);
  assert.deepEqual(associated.contextVersions, {
    a: aContextBefore + 1,
    b: bContextBefore + 1,
  });
  const identity = associated.identityId;
  assert.equal(identityOf(ctx.db, "a", "pref.assoc.rollback.a"), identity);
  assert.equal(identityOf(ctx.db, "b", "pref.assoc.rollback.b"), identity);
  assert.deepEqual(shareControlIdentities(), [identity]);
  assert.equal(aliasIdentity(leftFingerprint), identity);
  assert.equal(aliasIdentity(rightFingerprint), identity);
  assert.equal(entryRow(ctx.db, left.entry.id).version, 2);
  assert.equal(entryRow(ctx.db, right.entry.id).version, 2);
  assert.deepEqual(ftsSnapshot(ctx.db), ftsBefore);
  const aliasCount = countRows(ctx.db, "memory_fact_aliases");

  const idempotent = associate(ctx, left.entry.id, right.entry.id, 2, 2);
  assert.equal(idempotent.alreadyAssociated, true);
  assert.deepEqual(idempotent.contextVersions, {});
  assert.equal(entryRow(ctx.db, left.entry.id).version, 2);
  assert.equal(entryRow(ctx.db, right.entry.id).version, 2);
  assert.equal(countRows(ctx.db, "memory_fact_aliases"), aliasCount);

  // 成功关联后旧版本不可重放，也不改变上下文。
  assertRejected(ctx, left.entry.id, 1, right.entry.id, 2, "MEMORY_CHANGED");

  ctx.reopen();
  assert.equal(identityOf(ctx.db, "a", "pref.assoc.rollback.a"), identity);
  assert.equal(identityOf(ctx.db, "b", "pref.assoc.rollback.b"), identity);
  const afterRestart = associate(ctx, left.entry.id, right.entry.id, 2, 2);
  assert.equal(afterRestart.alreadyAssociated, true);
  assert.deepEqual(afterRestart.contextVersions, {});
  assert.equal(ctx.service.getContextVersion("a"), aContextBefore + 1);
  assert.equal(ctx.service.getContextVersion("b"), bContextBefore + 1);
});
