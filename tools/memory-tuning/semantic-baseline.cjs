#!/usr/bin/env node
/* S03l 首步：语义关联真实服务基线。
   每个场景使用独立临时 SQLite，直接调用正式 createMemoryService；不调用模型、
   不修改产品实现、不 mock 记忆操作。Expected 只参与事后评分，不传给产品。
   实际 FAIL 是当前语义关联缺口证据；执行异常单独记为 ERROR。
   未知异常不会被当成业务拒绝：只有预期业务拒绝码或 blocked/reason 才计入评分。 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { isDeepStrictEqual } = require("node:util");
const { DatabaseSync } = require("node:sqlite");
const { createMemoryService } = require("../../app/memory.cjs");

const REPO_ROOT = path.resolve(__dirname, "../..");
const A = "role-a";
const B = "role-b";
const C = "role-c";
const CHARACTERS = Object.freeze({ a: A, b: B, c: C });
const SCENARIO_MS = Date.UTC(2026, 9, 27, 10, 0, 0);

const SWEET_A = "用户喜欢甜咖啡";
const SWEET_B = "用户喜欢加糖的咖啡";
const NEW = "用户现在只喝纯黑咖啡";
const SISTER = "用户的姐姐喜欢甜咖啡";
const HISTORY = "去年和用户一起喝甜咖啡";

const SOURCE_FILES = Object.freeze([
  "app/memory.cjs",
  "app/memory-store.cjs",
  "app/memory-retrieval.cjs",
  "tools/memory-tuning/semantic-baseline.cjs",
]);

/* 正式服务会抛出的已知业务错误码；其余异常一律视为 Runner ERROR。 */
const KNOWN_ERROR_CODES = Object.freeze(new Set([
  "SHARE_BLOCKED",
  "SHARE_NOT_ALLOWED",
  "MEMORY_CHANGED",
  "SHARE_CONFLICT",
  "FACT_NOT_HELD",
  "INVALID_INPUT",
]));

/* 正式服务返回的已知业务拒绝理由；未知理由不参与 PASS/FAIL 评分。 */
const KNOWN_RESULT_REASONS = Object.freeze(new Set([
  "source",
  "forget",
  "blocked_source",
  "duplicate_batch",
]));

const EXPECTED_SHARE_REJECTIONS = Object.freeze(new Set(["SHARE_BLOCKED"]));
const EXPECTED_RELEARN_REJECTIONS = Object.freeze(new Set([
  "source",
  "forget",
  "blocked_source",
]));

function createClock() {
  let current = SCENARIO_MS;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
    },
  };
}

function openDatabase(directory) {
  const databasePath = path.join(directory, "semantic-baseline.sqlite3");
  const db = new DatabaseSync(databasePath);
  // 重启场景会重新打开同一个库，建表和角色插入都必须幂等。
  db.exec(`
    CREATE TABLE IF NOT EXISTS relationships (
      character_id TEXT PRIMARY KEY,
      accepted_at TEXT NOT NULL
    );
  `);
  const insertRelationship = db.prepare(`
    INSERT OR IGNORE INTO relationships (character_id, accepted_at)
    VALUES (?, ?)
  `);
  for (const characterId of Object.values(CHARACTERS)) {
    insertRelationship.run(characterId, "2026-01-01T00:00:00.000Z");
  }
  return db;
}

function ftsRowCount(db, entryId) {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM memory_fts
    WHERE entry_id = ?
  `).get(entryId);
  return Number(row.count);
}

function ftsHasToken(db, entryId, token) {
  const query = `char_tokens : "${String(token).replace(/"/gu, "")}"`;
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM memory_fts
    WHERE entry_id = ?
      AND memory_fts MATCH ?
  `).get(entryId, query);
  return Number(row.count) > 0;
}

function snapshot(ctx) {
  const result = {};
  for (const [key, characterId] of Object.entries(CHARACTERS)) {
    const entries = ctx.service().listMemories(characterId, {
      nowMs: ctx.now(),
      limit: 200,
    });
    const ftsRow = ctx.db().prepare(`
      SELECT COUNT(*) AS count
      FROM memory_fts
      WHERE entry_id IN (
        SELECT id FROM memory_entries WHERE character_id = ?
      )
    `).get(characterId);
    result[key] = {
      characterId,
      count: entries.length,
      ftsCount: Number(ftsRow.count),
      entries: entries.map((entry) => ({
        id: entry.id,
        factKey: entry.factKey,
        body: entry.body,
        kind: entry.kind,
        version: entry.version,
        derived: entry.derived,
        derivedFromEntryId: entry.derivedFromEntryId,
      })),
    };
  }
  return result;
}

function createScenarioContext(directory) {
  const clock = createClock();
  let db = openDatabase(directory);
  let service = createMemoryService({ db, now: clock.now });

  function controlCount(table) {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
    return Number(row.count);
  }

  const ctx = {
    clock,
    now: () => clock.now(),
    db: () => db,
    service: () => service,
    snapshot: () => snapshot(ctx),
    ftsRows: (entryId) => ftsRowCount(db, entryId),
    ftsHas: (entryId, token) => ftsHasToken(db, entryId, token),
    controls() {
      return {
        forgetControls: controlCount("memory_forget_controls"),
        sourceControls: controlCount("memory_source_controls"),
        shareControls: controlCount("memory_share_controls"),
        extractionBatches: controlCount("memory_extraction_batches"),
      };
    },
    restart() {
      db.close();
      db = openDatabase(directory);
      service = createMemoryService({ db, now: clock.now });
    },
    close() {
      db.close();
    },
  };
  return ctx;
}

function findEntry(state, characterKey, factKey) {
  return state[characterKey].entries.find((entry) => entry.factKey === factKey) ?? null;
}

function remember(ctx, characterId, factKey, body, kind, sourceId) {
  const result = ctx.service().remember({
    characterId,
    factKey,
    body,
    kind,
    sourceId,
  });
  if (!result.created) {
    throw new Error(
      `构造记忆失败：${characterId}/${factKey}/${result.blocked ?? "unknown"}`,
    );
  }
  return result.entry;
}

/* 001/002/005/006/007 复用的“两角色不同键、同一理解”夹具。 */
function seedPair(ctx) {
  const entryForA = remember(
    ctx,
    A,
    "pref.a.coffee",
    SWEET_A,
    "preference",
    "a-coffee-old",
  );
  const entryForB = remember(
    ctx,
    B,
    "pref.b.coffee",
    SWEET_B,
    "preference",
    "b-coffee-old",
  );
  return { a: entryForA, b: entryForB };
}

/* 场景统一先记录 Given 状态，再推进固定业务时钟。 */
function begin(ctx) {
  const initial = ctx.snapshot();
  ctx.clock.advance(60_000);
  return initial;
}

function attempt(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return {
      ok: false,
      code: error.code ?? null,
      message: error.message,
    };
  }
}

/* 只有预期业务拒绝才返回 rejected=true。
   非业务异常、未知错误码或未知拒绝理由会抛出，由 Runner 记为 ERROR。 */
function classifyRejection(result, expectedReasons) {
  if (result.ok) {
    const reason = result.value?.blocked ?? result.value?.reason ?? null;
    if (reason === null) {
      return { rejected: false, reason: null, via: "result" };
    }
    if (!KNOWN_RESULT_REASONS.has(reason)) {
      throw new Error(`未预期的业务拒绝理由：${reason}`);
    }
    return {
      rejected: expectedReasons.has(reason),
      reason,
      via: "result",
    };
  }

  if (!KNOWN_ERROR_CODES.has(result.code)) {
    throw new Error(
      `未预期的执行异常：${result.code ?? "NO_CODE"} ${result.message}`,
    );
  }
  return {
    rejected: expectedReasons.has(result.code),
    reason: result.code,
    via: "throw",
  };
}

function check(name, expected, actual) {
  return {
    name,
    expected,
    actual,
    status: isDeepStrictEqual(expected, actual) ? "PASS" : "FAIL",
  };
}

const SCENARIOS = [
  {
    id: "SEM-001",
    title: "不同键同义偏好：A 纠正后 A/B 同步，C 未知",
    run(ctx) {
      seedPair(ctx);
      const initial = begin(ctx);

      ctx.service().correct({
        characterId: A,
        factKey: "pref.a.coffee",
        body: NEW,
        sourceId: "a-coffee-new",
        nowMs: ctx.now(),
      });

      const after = ctx.snapshot();
      const entryForA = findEntry(after, "a", "pref.a.coffee");
      const entryForB = findEntry(after, "b", "pref.b.coffee");

      return {
        states: { initial, after },
        checks: [
          check("A 当前偏好为新理解", NEW, entryForA?.body ?? null),
          check("B 当前偏好严格同步为新理解", NEW, entryForB?.body ?? null),
          check("A 版本递增", 2, entryForA?.version ?? null),
          check("B 版本随同步递增", 2, entryForB?.version ?? null),
          check(
            "A FTS 索引新正文",
            true,
            entryForA ? ctx.ftsHas(entryForA.id, "纯") : false,
          ),
          check(
            "A FTS 不残留旧正文",
            false,
            entryForA ? ctx.ftsHas(entryForA.id, "甜") : null,
          ),
          check(
            "B FTS 索引新正文",
            true,
            entryForB ? ctx.ftsHas(entryForB.id, "纯") : false,
          ),
          check(
            "B FTS 不残留旧正文",
            false,
            entryForB ? ctx.ftsHas(entryForB.id, "加") : null,
          ),
          check("C 无新增条目", 0, after.c.count),
          check("C 无 FTS 记录", 0, after.c.ftsCount),
        ],
      };
    },
  },
  {
    id: "SEM-002",
    title: "不同键同义偏好：A 默认删除后 A/B 正文与 FTS 消失，重启保持",
    run(ctx) {
      const pair = seedPair(ctx);
      const initial = begin(ctx);

      ctx.service().forget({
        characterId: A,
        factKey: "pref.a.coffee",
        nowMs: ctx.now(),
      });

      const afterForget = ctx.snapshot();
      const ftsAfterForget = {
        a: ctx.ftsRows(pair.a.id),
        b: ctx.ftsRows(pair.b.id),
      };

      ctx.restart();

      const afterRestart = ctx.snapshot();
      const ftsAfterRestart = {
        a: ctx.ftsRows(pair.a.id),
        b: ctx.ftsRows(pair.b.id),
      };

      return {
        states: { initial, afterForget, afterRestart },
        checks: [
          check("删除后 A 无条目", 0, afterForget.a.count),
          check("删除后 B 同义条目消失", 0, afterForget.b.count),
          check("删除后 A FTS 行为空", 0, ftsAfterForget.a),
          check("删除后 B FTS 行为空", 0, ftsAfterForget.b),
          check("删除后 C 无新增条目", 0, afterForget.c.count),
          check("删除后 C 无 FTS 记录", 0, afterForget.c.ftsCount),
          check("重启后 A 仍无条目", 0, afterRestart.a.count),
          check("重启后 B 仍无条目", 0, afterRestart.b.count),
          check("重启后 A FTS 行为空", 0, ftsAfterRestart.a),
          check("重启后 B FTS 行为空", 0, ftsAfterRestart.b),
          check("重启后 C 仍无条目", 0, afterRestart.c.count),
        ],
      };
    },
  },
  {
    id: "SEM-003",
    title: "同键不同主体：A 纠正只改 A，B 的姐姐偏好不变",
    run(ctx) {
      remember(
        ctx,
        A,
        "pref.coffee",
        SWEET_A,
        "preference",
        "a-coffee-old",
      );
      remember(
        ctx,
        B,
        "pref.coffee",
        SISTER,
        "preference",
        "b-sister",
      );
      const initial = begin(ctx);

      ctx.service().correct({
        characterId: A,
        factKey: "pref.coffee",
        body: NEW,
        sourceId: "a-coffee-new",
        nowMs: ctx.now(),
      });

      const after = ctx.snapshot();
      const entryForA = findEntry(after, "a", "pref.coffee");
      const entryForB = findEntry(after, "b", "pref.coffee");

      return {
        states: { initial, after },
        checks: [
          check("A 正文更新", NEW, entryForA?.body ?? null),
          check("A 版本递增", 2, entryForA?.version ?? null),
          check("B 正文保持原主体事实", SISTER, entryForB?.body ?? null),
          check("B 版本不变", 1, entryForB?.version ?? null),
          check(
            "B FTS 保留原正文",
            true,
            entryForB ? ctx.ftsHas(entryForB.id, "姐") : false,
          ),
          check(
            "B FTS 不索引 A 的新正文",
            false,
            entryForB ? ctx.ftsHas(entryForB.id, "纯") : null,
          ),
          check("C 无新增条目", 0, after.c.count),
        ],
      };
    },
  },
  {
    id: "SEM-004",
    title: "同键不同性质：A 当前偏好纠正不改 B 的历史经历",
    run(ctx) {
      remember(
        ctx,
        A,
        "pref.coffee",
        SWEET_A,
        "preference",
        "a-current",
      );
      remember(
        ctx,
        B,
        "pref.coffee",
        HISTORY,
        "experience",
        "b-history",
      );
      const initial = begin(ctx);

      ctx.service().correct({
        characterId: A,
        factKey: "pref.coffee",
        body: NEW,
        sourceId: "a-coffee-new",
        nowMs: ctx.now(),
      });

      const after = ctx.snapshot();
      const entryForA = findEntry(after, "a", "pref.coffee");
      const entryForB = findEntry(after, "b", "pref.coffee");

      return {
        states: { initial, after },
        checks: [
          check("A 正文已更新", NEW, entryForA?.body ?? null),
          check("A 版本已递增", 2, entryForA?.version ?? null),
          check("A 性质仍为当前偏好", "preference", entryForA?.kind ?? null),
          check("B 历史经历仍为原文", HISTORY, entryForB?.body ?? null),
          check("B 版本不变", 1, entryForB?.version ?? null),
          check("B 性质仍为经历", "experience", entryForB?.kind ?? null),
          check(
            "B FTS 保留历史正文",
            true,
            entryForB ? ctx.ftsHas(entryForB.id, "去") : false,
          ),
          check(
            "B FTS 不索引当前偏好正文",
            false,
            entryForB ? ctx.ftsHas(entryForB.id, "纯") : null,
          ),
          check("C 无新增条目", 0, after.c.count),
        ],
      };
    },
  },
  {
    id: "SEM-005",
    title: "不同键同义：A 禁分享后 B 明确转告 C 仍必须拒绝",
    run(ctx) {
      const pair = seedPair(ctx);
      const initial = ctx.snapshot();
      const entryForA = findEntry(initial, "a", "pref.a.coffee");

      ctx.clock.advance(60_000);

      ctx.service().restrictSharing({
        characterId: A,
        entryId: entryForA.id,
        expectedVersion: 1,
        nowMs: ctx.now(),
      });

      const relayAttempt = attempt(() => ctx.service().relay({
        fromCharacterId: B,
        toCharacterId: C,
        entries: [{
          entryId: pair.b.id,
          expectedVersion: 1,
        }],
        nowMs: ctx.now(),
      }));
      const relayOutcome = classifyRejection(
        relayAttempt,
        EXPECTED_SHARE_REJECTIONS,
      );

      const after = ctx.snapshot();

      return {
        details: {
          relay: {
            rejected: relayOutcome.rejected,
            reason: relayOutcome.reason,
            via: relayOutcome.via,
          },
        },
        states: { initial, after },
        checks: [
          check(
            "B 明确转告被业务规则拒绝",
            true,
            relayOutcome.rejected,
          ),
          check("C 无新增条目", 0, after.c.count),
          check("C 无 FTS 记录", 0, after.c.ftsCount),
        ],
      };
    },
  },
  {
    id: "SEM-006",
    title: "不同键同义：A 要求只让 A 记得，B 删除且旧来源新键不能学回",
    run(ctx) {
      const pair = seedPair(ctx);
      const initial = begin(ctx);

      ctx.service().keepExclusive({
        characterId: A,
        entryId: pair.a.id,
        expectedVersion: 1,
        nowMs: ctx.now(),
      });

      const afterExclusive = ctx.snapshot();

      const relearnAttempt = attempt(() => ctx.service().remember({
        characterId: B,
        factKey: "pref.b.coffee.relearn",
        body: SWEET_B,
        kind: "preference",
        sourceId: "b-coffee-old",
        createdAt: ctx.now(),
      }));
      const relearnOutcome = classifyRejection(
        relearnAttempt,
        EXPECTED_RELEARN_REJECTIONS,
      );

      const afterRelearn = ctx.snapshot();

      return {
        details: {
          relearn: {
            rejected: relearnOutcome.rejected,
            reason: relearnOutcome.reason,
            via: relearnOutcome.via,
          },
        },
        states: { initial, afterExclusive, afterRelearn },
        checks: [
          check(
            "A 保留原理解",
            SWEET_A,
            findEntry(afterExclusive, "a", "pref.a.coffee")?.body ?? null,
          ),
          check("B 正文条目被清除", 0, afterExclusive.b.count),
          check("B 全部 FTS 被清除", 0, afterExclusive.b.ftsCount),
          check("B 原条目 FTS 行被清除", 0, ctx.ftsRows(pair.b.id)),
          check("C 无新增条目", 0, afterExclusive.c.count),
          check(
            "B 旧来源新键重学被业务规则拒绝",
            true,
            relearnOutcome.rejected,
          ),
          check("B 最终未恢复旧理解", 0, afterRelearn.b.count),
          check("B 最终全部 FTS 为空", 0, afterRelearn.b.ftsCount),
          check("B 最终原条目无 FTS 残留", 0, ctx.ftsRows(pair.b.id)),
        ],
      };
    },
  },
  {
    id: "SEM-007",
    title: "不同键同义：A 默认删除后，B 用旧来源新键重提炼不能恢复",
    run(ctx) {
      const pair = seedPair(ctx);
      const initial = begin(ctx);

      ctx.service().forget({
        characterId: A,
        factKey: "pref.a.coffee",
        nowMs: ctx.now(),
      });

      const afterForget = ctx.snapshot();

      const relearnAttempt = attempt(
        () => ctx.service().applyExtractionBatch({
          characterId: B,
          sourceId: "b-coffee-old",
          sourceVersion: 2,
          appliedAt: ctx.now(),
          createdAt: ctx.now(),
          facts: [{
            factKey: "pref.b.coffee.relearn",
            body: SWEET_B,
            kind: "preference",
          }],
        }),
      );
      const relearnOutcome = classifyRejection(
        relearnAttempt,
        EXPECTED_RELEARN_REJECTIONS,
      );

      const afterRelearn = ctx.snapshot();

      return {
        details: {
          relearn: {
            rejected: relearnOutcome.rejected,
            reason: relearnOutcome.reason,
            via: relearnOutcome.via,
          },
        },
        states: { initial, afterForget, afterRelearn },
        checks: [
          check("A 默认删除后无条目", 0, afterForget.a.count),
          check("B 同义条目被清除", 0, afterForget.b.count),
          check("B 删除后全部 FTS 为空", 0, afterForget.b.ftsCount),
          check("B 原条目 FTS 行被清除", 0, ctx.ftsRows(pair.b.id)),
          check("C 无新增条目", 0, afterForget.c.count),
          check(
            "B 旧来源新键重提炼被业务规则拒绝",
            true,
            relearnOutcome.rejected,
          ),
          check("B 重提炼后未恢复旧理解", 0, afterRelearn.b.count),
          check("B 重提炼后全部 FTS 为空", 0, afterRelearn.b.ftsCount),
          check("B 重提炼后原条目无 FTS 残留", 0, ctx.ftsRows(pair.b.id)),
        ],
      };
    },
  },
  {
    id: "SEM-008",
    title: "同键真实派生正控制：纠正同步、删除防回流、C 未知",
    run(ctx) {
      const entryForA = remember(
        ctx,
        A,
        "pref.coffee",
        SWEET_A,
        "preference",
        "a-coffee-old",
      );

      const shareResult = ctx.service().share({
        fromCharacterId: A,
        toCharacterId: B,
        entryIds: [entryForA.id],
        nowMs: ctx.now(),
      });
      const sharedEntryId = shareResult.shared[0]?.entryId;
      if (!sharedEntryId) {
        throw new Error("分享未产生派生条目");
      }

      const initial = ctx.snapshot();
      const entryForB = findEntry(initial, "b", "pref.coffee");
      const initialEntryForA = findEntry(initial, "a", "pref.coffee");

      ctx.clock.advance(60_000);

      const correctionResult = ctx.service().correct({
        characterId: A,
        factKey: "pref.coffee",
        body: NEW,
        sourceId: "a-coffee-new",
        nowMs: ctx.now(),
      });

      const afterCorrect = ctx.snapshot();
      const correctedEntryForA = findEntry(afterCorrect, "a", "pref.coffee");
      const correctedEntryForB = findEntry(afterCorrect, "b", "pref.coffee");

      const ftsAfterCorrect = {
        a: correctedEntryForA
          ? ctx.ftsHas(correctedEntryForA.id, "纯")
          : false,
        b: correctedEntryForB
          ? ctx.ftsHas(correctedEntryForB.id, "纯")
          : false,
      };

      ctx.clock.advance(60_000);

      const forgetResult = ctx.service().forget({
        characterId: A,
        factKey: "pref.coffee",
        nowMs: ctx.now(),
      });

      const afterDelete = ctx.snapshot();
      const ftsAfterDelete = {
        a: ctx.ftsRows(entryForA.id),
        b: ctx.ftsRows(sharedEntryId),
      };

      const relearnAttempt = attempt(() => ctx.service().remember({
        characterId: B,
        factKey: "pref.coffee",
        body: NEW,
        kind: "preference",
        sourceId: `share:${entryForA.id}:${B}`,
        createdAt: ctx.now(),
      }));
      const relearnOutcome = classifyRejection(
        relearnAttempt,
        EXPECTED_RELEARN_REJECTIONS,
      );

      const afterRelearn = ctx.snapshot();

      return {
        details: {
          correction: {
            updated: correctionResult.updated,
            updatedDerived: correctionResult.updatedDerived,
            affectedCharacters: correctionResult.affectedCharacters,
          },
          forget: {
            deleted: forgetResult.deleted,
            affectedCharacters: forgetResult.affectedCharacters,
          },
          relearn: {
            rejected: relearnOutcome.rejected,
            reason: relearnOutcome.reason,
            via: relearnOutcome.via,
          },
        },
        states: {
          initial,
          afterCorrect,
          afterDelete,
          afterRelearn,
        },
        checks: [
          check(
            "A 初始条目存在",
            { body: SWEET_A, version: 1 },
            initialEntryForA
              ? {
                  body: initialEntryForA.body,
                  version: initialEntryForA.version,
                }
              : null,
          ),
          check(
            "B 建立同键真实派生",
            {
              body: SWEET_A,
              derived: true,
              version: 1,
              derivedFromEntryId: entryForA.id,
            },
            entryForB
              ? {
                  body: entryForB.body,
                  derived: entryForB.derived,
                  version: entryForB.version,
                  derivedFromEntryId: entryForB.derivedFromEntryId,
                }
              : null,
          ),
          check("纠正后 A 正文同步", NEW, correctedEntryForA?.body ?? null),
          check("纠正后 A 版本递增", 2, correctedEntryForA?.version ?? null),
          check("纠正后 B 派生正文同步", NEW, correctedEntryForB?.body ?? null),
          check(
            "纠正后 B 派生版本递增",
            2,
            correctedEntryForB?.version ?? null,
          ),
          check(
            "纠正后 B 仍为真实派生",
            true,
            correctedEntryForB?.derived ?? null,
          ),
          check("纠正后 A FTS 索引新正文", true, ftsAfterCorrect.a),
          check("纠正后 B 派生 FTS 索引新正文", true, ftsAfterCorrect.b),
          check("默认删除后 A 无条目", 0, afterDelete.a.count),
          check("默认删除后 B 无条目", 0, afterDelete.b.count),
          check("默认删除后 A FTS 行为空", 0, ftsAfterDelete.a),
          check("默认删除后 B FTS 行为空", 0, ftsAfterDelete.b),
          check(
            "C 全阶段无新增条目",
            [0, 0, 0, 0],
            [
              initial.c.count,
              afterCorrect.c.count,
              afterDelete.c.count,
              afterRelearn.c.count,
            ],
          ),
          check(
            "旧分享来源重学被业务规则拒绝",
            true,
            relearnOutcome.rejected,
          ),
          check("重学后 B 无条目", 0, afterRelearn.b.count),
          check("重学后 B 全部 FTS 为空", 0, afterRelearn.b.ftsCount),
        ],
      };
    },
  },
];

function sha256File(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function readSource() {
  let gitHead = null;
  try {
    gitHead = execFileSync(
      "git",
      ["rev-parse", "HEAD"],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
      },
    ).trim();
  } catch (error) {
    gitHead = null;
  }

  let version = null;
  try {
    version = fs.readFileSync(
      path.join(REPO_ROOT, "VERSION"),
      "utf8",
    ).trim();
  } catch (error) {
    version = null;
  }

  const files = {};
  for (const relativePath of SOURCE_FILES) {
    files[relativePath] = sha256File(
      path.join(REPO_ROOT, relativePath),
    );
  }

  return {
    sha: gitHead,
    version,
    node: process.version,
    files,
  };
}

function parseOutputPath() {
  const args = process.argv.slice(2);
  const index = args.indexOf("--out");
  if (index === -1) {
    return path.join(
      __dirname,
      "results",
      "semantic-baseline-latest.json",
    );
  }
  const value = args[index + 1];
  if (!value) {
    throw new Error("--out 需要一个文件路径。");
  }
  return path.resolve(process.cwd(), value);
}

function runScenario(definition) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "bayper-semantic-baseline-"),
  );
  const startedAt = new Date().toISOString();
  const started = process.hrtime.bigint();

  let ctx = null;
  let body = null;
  let error = null;

  try {
    ctx = createScenarioContext(directory);
    body = definition.run(ctx);
  } catch (caught) {
    error = {
      name: caught.name,
      message: caught.message,
      stack: caught.stack ?? null,
    };
  }

  let controls = null;
  if (ctx) {
    try {
      controls = ctx.controls();
    } catch (caught) {
      error = error ?? {
        name: caught.name,
        message: caught.message,
        stack: caught.stack ?? null,
      };
    }

    try {
      ctx.close();
    } catch (caught) {
      error = error ?? {
        name: caught.name,
        message: caught.message,
        stack: caught.stack ?? null,
      };
    }
  }

  const cleanup = {
    path: directory,
    removed: false,
    existsAfter: true,
  };
  try {
    fs.rmSync(directory, {
      recursive: true,
      force: true,
    });
  } catch (caught) {
    cleanup.error = caught.message;
  }
  cleanup.existsAfter = fs.existsSync(directory);
  cleanup.removed = !cleanup.existsAfter;
  if (cleanup.error || !cleanup.removed) {
    error = error ?? {
      name: "CleanupError",
      message: cleanup.error
        ? `临时目录清理失败：${cleanup.error}`
        : `临时目录未清理：${directory}`,
      stack: null,
    };
  }

  const endedAt = new Date().toISOString();
  const durationNs = process.hrtime.bigint() - started;
  const durationMs = Number((Number(durationNs) / 1e6).toFixed(3));

  if (error || !body) {
    return {
      id: definition.id,
      title: definition.title,
      status: "ERROR",
      error: error ?? {
        name: "Error",
        message: "场景未返回结果",
        stack: null,
      },
      controls,
      cleanup,
      startedAt,
      endedAt,
      durationMs,
    };
  }

  const checks = body.checks ?? [];
  const status = checks.every((item) => item.status === "PASS")
    ? "PASS"
    : "FAIL";

  return {
    id: definition.id,
    title: definition.title,
    status,
    details: body.details ?? null,
    states: body.states,
    checks,
    controls,
    cleanup,
    startedAt,
    endedAt,
    durationMs,
  };
}

function main() {
  const outputPath = parseOutputPath();
  const scenarios = SCENARIOS.map(runScenario);

  const summary = {
    total: scenarios.length,
    passed: scenarios.filter((item) => item.status === "PASS").length,
    failed: scenarios.filter((item) => item.status === "FAIL").length,
    error: scenarios.filter((item) => item.status === "ERROR").length,
    checksPassed: scenarios.reduce(
      (total, item) =>
        total + (item.checks?.filter((row) => row.status === "PASS").length ?? 0),
      0,
    ),
    checksFailed: scenarios.reduce(
      (total, item) =>
        total + (item.checks?.filter((row) => row.status === "FAIL").length ?? 0),
      0,
    ),
  };

  const report = {
    tool: "semantic-baseline",
    generatedAt: new Date().toISOString(),
    scenarioTime: new Date(SCENARIO_MS).toISOString(),
    source: readSource(),
    summary,
    scenarios,
    boundaries: [
      "使用正式 createMemoryService 与真实 SQLite；每场景独立临时库，结束清理",
      "不调用模型、不修改产品实现、不 mock 记忆操作；Expected 只用于事后评分",
      "实际 FAIL 是语义关联缺口证据，执行异常单独记为 ERROR",
      "未知异常不会被当作业务拒绝；源文件哈希用于复核实际运行内容",
      "不包含真实用户内容；控制表只记录摘要计数",
      "未验证真实模型提炼、真实聊天上下文、GUI 或权限目录",
    ],
  };

  fs.mkdirSync(path.dirname(outputPath), {
    recursive: true,
  });
  fs.writeFileSync(
    outputPath,
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );

  console.log("Bayper 语义关联真实服务基线（构造数据，不是修复验收）");
  console.log(
    `源 SHA: ${report.source.sha ?? "unknown"}  版本: ${report.source.version ?? "unknown"}`,
  );
  for (const scenario of scenarios) {
    const failedChecks = (scenario.checks ?? []).filter(
      (item) => item.status === "FAIL",
    );
    const checkLabel = scenario.checks
      ? `${scenario.checks.length - failedChecks.length}/${scenario.checks.length}`
      : "n/a";
    console.log(
      `${scenario.id} ${scenario.status.padEnd(5)} 检查 ${checkLabel}  ${scenario.title}`,
    );
    for (const item of failedChecks) {
      console.log(
        `  FAIL ${item.name}：期望 ${JSON.stringify(item.expected)}，实际 ${JSON.stringify(item.actual)}`,
      );
    }
    if (scenario.error) {
      console.log(
        `  ERROR ${scenario.error.name}: ${scenario.error.message}`,
      );
    }
  }

  console.log(
    `\n汇总：场景 PASS ${summary.passed} FAIL ${summary.failed} ERROR ${summary.error}；` +
      `检查 PASS ${summary.checksPassed} FAIL ${summary.checksFailed}`,
  );
  console.log(`结果已写入：${outputPath}`);

  if (summary.error > 0) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
