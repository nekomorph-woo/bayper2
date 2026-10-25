/* S06a 正式验收：真实 SQLite、构造时钟与真实事务。
   覆盖 POL-BUDGET-001～004；不联网、不启动 GUI、不读取真实 HOME/.env。
   只验证预算与占位生命周期，不覆盖上层名单、优先级、抽签或网络取消。 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const { AppError } = require("../../app/errors.cjs");
const { createAutomaticBudget } = require("../../app/automatic-budget.cjs");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const START = Date.UTC(2026, 9, 26, 12, 0, 0);

function makeContext(t, start = START) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bayper-budget-"));
  const dbPath = path.join(dir, "budget.sqlite3");
  let clock = start;
  let db = new DatabaseSync(dbPath);
  let budget = createAutomaticBudget({ db, now: () => clock });
  const ctx = {
    dir,
    dbPath,
    get db() {
      return db;
    },
    get budget() {
      return budget;
    },
    setNow(value) {
      clock = value;
    },
    advance(ms) {
      clock += ms;
    },
    reopen() {
      db.close();
      db = new DatabaseSync(dbPath);
      budget = createAutomaticBudget({ db, now: () => clock });
    },
  };
  t.after(() => {
    try {
      db.close();
    } catch {
      // 测试已主动关闭时仍要清理临时目录。
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return ctx;
}

function send(ctx, requestId, characterId, outcome = "success") {
  const reservation = ctx.budget.reserve({ requestId, characterId });
  assert.equal(reservation.reserved, true, `reserve ${requestId}: ${reservation.reason}`);
  const begin = ctx.budget.beginAttempt(reservation.token);
  assert.equal(begin.canSend, true, `begin ${requestId}: ${begin.reason}`);
  const finished = ctx.budget.finish(reservation.token, outcome);
  assert.equal(finished.finished, true);
  return { token: reservation.token, begin, finished };
}

function sentCount(ctx) {
  return ctx.db
    .prepare("SELECT COUNT(*) AS count FROM automatic_budget_attempts WHERE sent = 1")
    .get().count;
}

function activeCount(ctx) {
  return ctx.db
    .prepare(
      "SELECT COUNT(*) AS count FROM automatic_budget_attempts WHERE status IN ('reserved', 'in_flight')",
    )
    .get().count;
}

function windowCount(ctx, from, to) {
  return ctx.db
    .prepare(
      "SELECT COUNT(*) AS count FROM automatic_budget_attempts WHERE sent = 1 AND sent_at > ? AND sent_at <= ?",
    )
    .get(from, to).count;
}

function rowOf(ctx, token) {
  return ctx.db.prepare("SELECT * FROM automatic_budget_attempts WHERE id = ?").get(token);
}

function storageFailure(fn) {
  assert.throws(
    fn,
    (error) => error instanceof AppError && error.code === "BUDGET_STORAGE_FAILED",
    "预期预算存储失败",
  );
}

test("POL-BUDGET-001 1h/8h/24h 与角色 2h 的真实时间边界", (t) => {
  const ctx = makeContext(t);
  send(ctx, "r1", "a");

  ctx.advance(30 * MINUTE);
  let blocked = ctx.budget.reserve({ requestId: "r-30m", characterId: "b" });
  assert.deepEqual(
    { reserved: blocked.reserved, reason: blocked.reason },
    { reserved: false, reason: "HOURLY_LIMIT" },
  );

  ctx.setNow(START + HOUR);
  blocked = ctx.budget.reserve({ requestId: "r-cooldown", characterId: "a" });
  assert.equal(blocked.reserved, false);
  assert.equal(blocked.reason, "CHARACTER_COOLDOWN");
  const cooldown = ctx.budget.status("a");
  assert.equal(cooldown.sentLastHour, 0);
  assert.equal(cooldown.characterLastSentAt, START);
  assert.equal(cooldown.characterCooldownUntil, START + 2 * HOUR);
  send(ctx, "r2", "b");

  ctx.setNow(START + 2 * HOUR);
  send(ctx, "r3", "a");
  ctx.setNow(START + 3 * HOUR);
  send(ctx, "r4", "c");

  ctx.setNow(START + 4 * HOUR);
  blocked = ctx.budget.reserve({ requestId: "r-8h", characterId: "d" });
  assert.equal(blocked.reserved, false);
  assert.equal(blocked.reason, "EIGHT_HOUR_LIMIT");

  ctx.setNow(START + 8 * HOUR);
  // t0 恰好离开 8 小时窗口，发送前窗口内只剩 3 次。
  assert.equal(windowCount(ctx, START, START + 8 * HOUR), 3);
  send(ctx, "r5", "e");
  assert.equal(windowCount(ctx, START, START + 8 * HOUR), 4);

  ctx.setNow(START + 9 * HOUR);
  assert.equal(windowCount(ctx, START + HOUR, START + 9 * HOUR), 3);
  send(ctx, "r6", "b");
  assert.equal(windowCount(ctx, START + HOUR, START + 9 * HOUR), 4);

  ctx.setNow(START + 11 * HOUR);
  blocked = ctx.budget.reserve({ requestId: "r-24h", characterId: "c" });
  assert.equal(blocked.reserved, false);
  assert.equal(blocked.reason, "DAILY_LIMIT");
  const status = ctx.budget.status("a");
  assert.equal(status.sentLastHour, 0);
  assert.equal(status.sentLast8Hours, 2);
  assert.equal(status.sentLast24Hours, 6);
  assert.equal(status.canReserve, false);

  ctx.setNow(START + 25 * HOUR);
  // t0+1h 恰好离开 24 小时窗口，发送前窗口内只剩 4 次。
  assert.equal(windowCount(ctx, START + HOUR, START + 25 * HOUR), 4);
  send(ctx, "r7", "d");
  assert.equal(sentCount(ctx), 7);

  // 独立 SQL 核对具体窗口，不读取模块内部额度常量。
  assert.equal(windowCount(ctx, START - 4 * HOUR, START + 4 * HOUR), 4);
  assert.equal(windowCount(ctx, START + 3 * HOUR, START + 4 * HOUR), 0);
  assert.equal(windowCount(ctx, START + 10 * HOUR, START + 11 * HOUR), 0);
  assert.equal(windowCount(ctx, START + 3 * HOUR, START + 11 * HOUR), 2);
  assert.equal(windowCount(ctx, START + 11 * HOUR - 24 * HOUR, START + 11 * HOUR), 6);
  assert.equal(windowCount(ctx, START + HOUR, START + 25 * HOUR), 5);
  const rows = ctx.db
    .prepare("SELECT status, sent FROM automatic_budget_attempts ORDER BY rowid")
    .all();
  assert.equal(rows.length, 7);
  assert.ok(rows.every((row) => row.status === "success" && row.sent === 1));
});

test("POL-BUDGET-002 单占位、取消、发送与重复 begin/finish", (t) => {
  const ctx = makeContext(t);
  const first = ctx.budget.reserve({ requestId: "r1", characterId: "a" });
  assert.equal(first.reserved, true);

  const busy = ctx.budget.reserve({ requestId: "r2", characterId: "b" });
  assert.equal(busy.reserved, false);
  assert.equal(busy.reason, "BUSY");
  assert.equal(busy.token, null);

  const cancelledBefore = ctx.budget.cancel(first.token);
  assert.equal(cancelledBefore.cancelled, true);
  assert.equal(cancelledBefore.sent, false);
  assert.equal(sentCount(ctx), 0);
  assert.equal(activeCount(ctx), 0);

  const reservation = ctx.budget.reserve({ requestId: "r3", characterId: "b" });
  assert.equal(reservation.reserved, true);
  const begun = ctx.budget.beginAttempt(reservation.token);
  assert.equal(begun.canSend, true);
  const repeatedBegin = ctx.budget.beginAttempt(reservation.token);
  assert.equal(repeatedBegin.canSend, false);
  assert.equal(repeatedBegin.reason, "ALREADY_STARTED");
  assert.equal(sentCount(ctx), 1);

  const busyInFlight = ctx.budget.reserve({ requestId: "r4", characterId: "c" });
  assert.equal(busyInFlight.reason, "BUSY");

  const finished = ctx.budget.finish(reservation.token, "success");
  assert.equal(finished.finished, true);
  assert.equal(finished.sent, true);
  const repeatedFinish = ctx.budget.finish(reservation.token, "failed");
  assert.equal(repeatedFinish.duplicate, true);
  assert.equal(repeatedFinish.status, "success");
  const cancelAfterSuccess = ctx.budget.cancel(reservation.token);
  assert.equal(cancelAfterSuccess.status, "success");
  assert.equal(cancelAfterSuccess.sent, true);
  assert.equal(rowOf(ctx, reservation.token).status, "success");

  ctx.advance(HOUR);
  const afterHour = ctx.budget.reserve({ requestId: "r5", characterId: "d" });
  assert.equal(afterHour.reserved, true);
  assert.equal(ctx.budget.beginAttempt(afterHour.token).canSend, true);
  const cancelAfterSend = ctx.budget.cancel(afterHour.token);
  assert.equal(cancelAfterSend.sent, true);
  assert.equal(rowOf(ctx, afterHour.token).sent, 1);
  assert.equal(rowOf(ctx, afterHour.token).status, "cancelled");
  assert.equal(sentCount(ctx), 2);

  const stillHourly = ctx.budget.reserve({ requestId: "r6", characterId: "e" });
  assert.equal(stillHourly.reason, "HOURLY_LIMIT");

  ctx.setNow(START + 2 * HOUR);
  const failedAttempt = ctx.budget.reserve({ requestId: "r6", characterId: "e" });
  assert.equal(failedAttempt.reserved, true);
  assert.equal(ctx.budget.beginAttempt(failedAttempt.token).canSend, true);
  assert.equal(ctx.budget.finish(failedAttempt.token, "failed").status, "failed");

  ctx.setNow(START + 3 * HOUR);
  const timedOut = ctx.budget.reserve({ requestId: "r7", characterId: "c" });
  assert.equal(timedOut.reserved, true);
  assert.equal(ctx.budget.beginAttempt(timedOut.token).canSend, true);
  assert.equal(ctx.budget.finish(timedOut.token, "timeout").status, "timeout");
  assert.equal(sentCount(ctx), 4);

  const duplicate = ctx.budget.reserve({ requestId: "r3", characterId: "b" });
  assert.equal(duplicate.reserved, false);
  assert.equal(duplicate.reason, "DUPLICATE_REQUEST");
  assert.equal(duplicate.token, reservation.token);
  assert.equal(ctx.budget.beginAttempt(reservation.token).canSend, false);

  const rows = ctx.db
    .prepare("SELECT request_id, status, sent FROM automatic_budget_attempts ORDER BY rowid")
    .all();
  assert.deepEqual(
    rows.map((row) => [row.request_id, row.status, row.sent]),
    [
      ["r1", "cancelled", 0],
      ["r3", "success", 1],
      ["r5", "cancelled", 1],
      ["r6", "failed", 1],
      ["r7", "timeout", 1],
    ],
  );
});

test("POL-BUDGET-003 重启恢复、旧ID与时钟回拨/跨自然日", (t) => {
  const midnight = Date.UTC(2026, 9, 26, 23, 0, 0);
  const ctx = makeContext(t, midnight);

  const pending = ctx.budget.reserve({ requestId: "pending", characterId: "a" });
  assert.equal(pending.reserved, true);
  ctx.reopen();
  assert.equal(rowOf(ctx, pending.token).status, "interrupted");
  assert.equal(rowOf(ctx, pending.token).sent, 0);
  assert.equal(activeCount(ctx), 0);
  assert.equal(sentCount(ctx), 0);
  assert.equal(ctx.budget.reserve({ requestId: "pending", characterId: "a" }).reason, "DUPLICATE_REQUEST");
  assert.equal(ctx.budget.beginAttempt(pending.token).canSend, false);
  const freeReservation = ctx.budget.reserve({ requestId: "fresh", characterId: "b" });
  assert.equal(freeReservation.reserved, true);
  assert.equal(ctx.budget.cancel(freeReservation.token).sent, false);

  const sent = send(ctx, "sent-a", "a");
  assert.equal(sentCount(ctx), 1);

  // 系统时钟回拨：持久化逻辑时间不回退，未来记录与冷却保持有效。
  ctx.setNow(midnight - 5 * HOUR);
  ctx.reopen();
  const rolledBack = ctx.budget.status("a");
  assert.equal(rolledBack.now, midnight);
  assert.equal(rolledBack.sentLast24Hours, 1);
  assert.equal(rolledBack.characterLastSentAt, midnight);
  assert.equal(rolledBack.characterCooldownUntil, midnight + 2 * HOUR);
  assert.equal(rolledBack.canReserve, false);
  assert.equal(
    ctx.budget.reserve({ requestId: "rollback-b", characterId: "b" }).reason,
    "HOURLY_LIMIT",
  );
  assert.equal(ctx.budget.reserve({ requestId: "sent-a", characterId: "a" }).reason, "DUPLICATE_REQUEST");
  assert.equal(ctx.budget.beginAttempt(sent.token).canSend, false);
  assert.equal(sentCount(ctx), 1);

  // 跨自然日：滚动额度与冷却不清零。
  ctx.setNow(midnight + 90 * MINUTE);
  const nextDay = ctx.budget.status("a");
  assert.equal(nextDay.now, midnight + 90 * MINUTE);
  assert.equal(nextDay.sentLastHour, 0);
  assert.equal(nextDay.sentLast8Hours, 1);
  assert.equal(nextDay.sentLast24Hours, 1);
  assert.equal(nextDay.canReserve, false);
  assert.equal(
    ctx.budget.reserve({ requestId: "midnight-a", characterId: "a" }).reason,
    "CHARACTER_COOLDOWN",
  );
  const otherCharacter = ctx.budget.reserve({ requestId: "midnight-d", characterId: "d" });
  assert.equal(otherCharacter.reserved, true);
  ctx.budget.cancel(otherCharacter.token);
  assert.equal(sentCount(ctx), 1);
  assert.equal(
    windowCount(ctx, midnight + 90 * MINUTE - 24 * HOUR, midnight + 90 * MINUTE),
    1,
  );

  // 真正在途：reserve + begin 后不 finish，关闭重开恢复为 interrupted。
  ctx.setNow(midnight + 25 * HOUR);
  const inFlight = ctx.budget.reserve({ requestId: "inflight", characterId: "e" });
  assert.equal(inFlight.reserved, true);
  assert.equal(ctx.budget.beginAttempt(inFlight.token).canSend, true);
  assert.equal(rowOf(ctx, inFlight.token).status, "in_flight");
  ctx.reopen();
  const recoveredInFlight = rowOf(ctx, inFlight.token);
  assert.equal(recoveredInFlight.status, "interrupted");
  assert.equal(recoveredInFlight.sent, 1);
  assert.equal(recoveredInFlight.sent_at, midnight + 25 * HOUR);
  assert.equal(activeCount(ctx), 0);
  assert.equal(ctx.budget.status("e").activeAttempt, null);
  const retained = ctx.budget.status("e");
  assert.equal(retained.sentLastHour, 1);
  assert.equal(retained.sentLast8Hours, 1);
  assert.equal(retained.sentLast24Hours, 1);
  assert.equal(sentCount(ctx), 2);
  assert.equal(ctx.budget.beginAttempt(inFlight.token).canSend, false);
  assert.equal(
    ctx.budget.reserve({ requestId: "inflight", characterId: "e" }).reason,
    "DUPLICATE_REQUEST",
  );
  assert.equal(
    ctx.budget.reserve({ requestId: "after-inflight", characterId: "f" }).reason,
    "HOURLY_LIMIT",
  );
  ctx.setNow(midnight + 26 * HOUR);
  const freed = ctx.budget.reserve({ requestId: "after-inflight", characterId: "f" });
  assert.equal(freed.reserved, true);
  ctx.budget.cancel(freed.token);
  assert.equal(sentCount(ctx), 2);
});

test("POL-BUDGET-004 事务故障不提前发许可或部分更新", (t) => {
  const ctx = makeContext(t);
  ctx.db.exec(`
    CREATE TRIGGER fail_insert BEFORE INSERT ON automatic_budget_attempts
    BEGIN SELECT RAISE(ABORT, 'forced failure'); END
  `);
  storageFailure(() => ctx.budget.reserve({ requestId: "trig-1", characterId: "a" }));
  assert.equal(
    ctx.db.prepare("SELECT COUNT(*) AS count FROM automatic_budget_attempts").get().count,
    0,
  );
  assert.equal(ctx.budget.status("a").activeAttempt, null);
  ctx.db.exec("DROP TRIGGER fail_insert");

  const first = ctx.budget.reserve({ requestId: "r1", characterId: "a" });
  assert.equal(first.reserved, true);
  ctx.db.exec(`
    CREATE TRIGGER fail_update BEFORE UPDATE ON automatic_budget_attempts
    BEGIN SELECT RAISE(ABORT, 'forced failure'); END
  `);
  storageFailure(() => ctx.budget.beginAttempt(first.token));
  assert.equal(rowOf(ctx, first.token).status, "reserved");
  assert.equal(rowOf(ctx, first.token).sent, 0);
  ctx.db.exec("DROP TRIGGER fail_update");

  const begun = ctx.budget.beginAttempt(first.token);
  assert.equal(begun.canSend, true);
  ctx.db.exec(`
    CREATE TRIGGER fail_update BEFORE UPDATE ON automatic_budget_attempts
    BEGIN SELECT RAISE(ABORT, 'forced failure'); END
  `);
  storageFailure(() => ctx.budget.finish(first.token, "success"));
  assert.equal(rowOf(ctx, first.token).status, "in_flight");
  assert.equal(rowOf(ctx, first.token).sent, 1);
  ctx.db.exec("DROP TRIGGER fail_update");
  assert.equal(ctx.budget.finish(first.token, "success").status, "success");

  ctx.advance(HOUR);
  const second = ctx.budget.reserve({ requestId: "r2", characterId: "b" });
  assert.equal(second.reserved, true);
  ctx.db.exec(`
    CREATE TRIGGER fail_update BEFORE UPDATE ON automatic_budget_attempts
    BEGIN SELECT RAISE(ABORT, 'forced failure'); END
  `);
  storageFailure(() => ctx.budget.cancel(second.token));
  assert.equal(rowOf(ctx, second.token).status, "reserved");
  assert.equal(rowOf(ctx, second.token).sent, 0);
  ctx.db.exec("DROP TRIGGER fail_update");
  assert.equal(ctx.budget.cancel(second.token).sent, false);

  ctx.db.exec(`
    CREATE TRIGGER fail_state BEFORE UPDATE ON automatic_budget_state
    BEGIN SELECT RAISE(ABORT, 'forced failure'); END
  `);
  storageFailure(() => ctx.budget.reserve({ requestId: "trig-3", characterId: "c" }));
  assert.equal(
    ctx.db
      .prepare("SELECT COUNT(*) AS count FROM automatic_budget_attempts WHERE request_id = 'trig-3'")
      .get().count,
    0,
  );
  assert.equal(activeCount(ctx), 0);
  assert.equal(sentCount(ctx), 1);
  ctx.db.exec("DROP TRIGGER fail_state");
  const recovered = ctx.budget.reserve({ requestId: "trig-3", characterId: "c" });
  assert.equal(recovered.reserved, true);
  ctx.budget.cancel(recovered.token);
  assert.equal(rowOf(ctx, first.token).status, "success");
  assert.equal(rowOf(ctx, first.token).sent, 1);
});

test("POL-BUDGET-005 begin 前复核预算失败会取消未发送预留", (t) => {
  const ctx = makeContext(t);
  const reservation = ctx.budget.reserve({ requestId: "recheck", characterId: "a" });
  assert.equal(reservation.reserved, true);

  // 未发送尝试不能宣称发送结果，也不消耗次数。
  const notSent = ctx.budget.finish(reservation.token, "success");
  assert.equal(notSent.finished, false);
  assert.equal(notSent.reason, "NOT_SENT");
  assert.equal(sentCount(ctx), 0);

  // 独立 SQL 模拟预留后、begin 前同窗口额度被其他路径消耗。
  ctx.db
    .prepare(`
      INSERT INTO automatic_budget_attempts
        (id, request_id, character_id, created_at, updated_at, status, sent, sent_at, finished_at)
      VALUES (?, ?, ?, ?, ?, 'success', 1, ?, ?)
    `)
    .run("external", "external-request", "b", START, START, START, START);

  const begin = ctx.budget.beginAttempt(reservation.token);
  assert.equal(begin.canSend, false);
  assert.equal(begin.reason, "HOURLY_LIMIT");
  assert.equal(rowOf(ctx, reservation.token).status, "cancelled");
  assert.equal(rowOf(ctx, reservation.token).sent, 0);
  assert.equal(activeCount(ctx), 0);
  assert.equal(sentCount(ctx), 1);
});

test("POL-BUDGET-006 精确恢复收尾失败的令牌而不清其他活跃", (t) => {
  const ctx = makeContext(t);
  const reservation = ctx.budget.reserve({ requestId: "cleanup-1", characterId: "a" });
  assert.equal(reservation.reserved, true);
  assert.equal(ctx.budget.beginAttempt(reservation.token).canSend, true);
  ctx.db.exec(`
    CREATE TRIGGER fail_cleanup BEFORE UPDATE ON automatic_budget_attempts
    BEGIN SELECT RAISE(ABORT, 'forced failure'); END
  `);
  storageFailure(() => ctx.budget.finish(reservation.token, "success"));
  assert.equal(rowOf(ctx, reservation.token).status, "in_flight");
  assert.equal(rowOf(ctx, reservation.token).sent, 1);
  assert.equal(sentCount(ctx), 1);

  // 恢复 SQL 仍故障时必须明确存储失败，不能伪装成普通 BUSY。
  storageFailure(() =>
    ctx.budget.reserve({ requestId: "during-recovery-failure", characterId: "b" }),
  );
  assert.equal(rowOf(ctx, reservation.token).status, "in_flight");
  ctx.db.exec("DROP TRIGGER fail_cleanup");

  const recovered = ctx.budget.recover(reservation.token);
  assert.equal(recovered.recovered, true);
  assert.equal(rowOf(ctx, reservation.token).status, "success");
  assert.equal(rowOf(ctx, reservation.token).sent, 1);
  assert.equal(activeCount(ctx), 0);

  ctx.setNow(START + 2 * HOUR);
  const next = ctx.budget.reserve({ requestId: "next-active", characterId: "b" });
  assert.equal(next.reserved, true);
  const unknown = ctx.budget.recover("missing-token");
  assert.deepEqual(unknown, { recovered: false, reason: "NOT_PENDING" });
  assert.equal(rowOf(ctx, next.token).status, "reserved");
  assert.equal(activeCount(ctx), 1);
  ctx.budget.cancel(next.token);
  assert.equal(activeCount(ctx), 0);
});

test("POL-BUDGET-007 恢复事务回滚保留待收尾令牌", (t) => {
  const ctx = makeContext(t);
  const reservation = ctx.budget.reserve({ requestId: "rollback-1", characterId: "a" });
  assert.equal(reservation.reserved, true);
  assert.equal(ctx.budget.beginAttempt(reservation.token).canSend, true);
  ctx.db.exec(`
    CREATE TRIGGER fail_update BEFORE UPDATE ON automatic_budget_attempts
    BEGIN SELECT RAISE(ABORT, 'forced failure'); END
  `);
  storageFailure(() => ctx.budget.finish(reservation.token, "success"));
  assert.equal(rowOf(ctx, reservation.token).status, "in_flight");

  // 恢复 SQL 仍故障：reserve 必须抛存储错误，而不是返回 BUSY。
  storageFailure(() =>
    ctx.budget.reserve({ requestId: "recovery-fails", characterId: "b" }),
  );
  assert.equal(rowOf(ctx, reservation.token).status, "in_flight");
  ctx.db.exec("DROP TRIGGER fail_update");

  // 恢复 UPDATE 成功但随后 INSERT 失败时，整笔事务回滚，内存待收尾标记必须保留。
  ctx.setNow(START + 2 * HOUR);
  ctx.db.exec(`
    CREATE TRIGGER fail_insert BEFORE INSERT ON automatic_budget_attempts
    BEGIN SELECT RAISE(ABORT, 'forced failure'); END
  `);
  storageFailure(() =>
    ctx.budget.reserve({ requestId: "insert-fails", characterId: "b" }),
  );
  assert.equal(rowOf(ctx, reservation.token).status, "in_flight");
  assert.equal(rowOf(ctx, reservation.token).sent, 1);
  ctx.db.exec("DROP TRIGGER fail_insert");

  const next = ctx.budget.reserve({ requestId: "after-rollback", characterId: "b" });
  assert.equal(next.reserved, true);
  const recovered = rowOf(ctx, reservation.token);
  assert.equal(recovered.status, "success");
  assert.equal(recovered.sent, 1);
  assert.equal(sentCount(ctx), 1);
  ctx.budget.cancel(next.token);
  assert.equal(activeCount(ctx), 0);
});

test("POL-BUDGET-008 成功 finish/cancel 清理精确待收尾标记", (t) => {
  const ctx = makeContext(t);
  const finished = ctx.budget.reserve({ requestId: "finish-cleanup", characterId: "a" });
  assert.equal(finished.reserved, true);
  assert.equal(ctx.budget.beginAttempt(finished.token).canSend, true);
  ctx.db.exec(`
    CREATE TRIGGER fail_cleanup_finish BEFORE UPDATE ON automatic_budget_attempts
    BEGIN SELECT RAISE(ABORT, 'forced failure'); END
  `);
  storageFailure(() => ctx.budget.finish(finished.token, "success"));
  ctx.db.exec("DROP TRIGGER fail_cleanup_finish");
  assert.equal(ctx.budget.finish(finished.token, "success").status, "success");
  assert.deepEqual(ctx.budget.recover(finished.token), {
    recovered: false,
    reason: "NOT_PENDING",
  });
  assert.equal(ctx.budget.finish(finished.token, "failed").duplicate, true);
  assert.deepEqual(ctx.budget.recover(finished.token), {
    recovered: false,
    reason: "NOT_PENDING",
  });

  ctx.setNow(START + 2 * HOUR);
  const cancelled = ctx.budget.reserve({ requestId: "cancel-cleanup", characterId: "b" });
  assert.equal(cancelled.reserved, true);
  assert.equal(ctx.budget.beginAttempt(cancelled.token).canSend, true);
  ctx.db.exec(`
    CREATE TRIGGER fail_cleanup_cancel BEFORE UPDATE ON automatic_budget_attempts
    BEGIN SELECT RAISE(ABORT, 'forced failure'); END
  `);
  storageFailure(() => ctx.budget.cancel(cancelled.token));
  ctx.db.exec("DROP TRIGGER fail_cleanup_cancel");
  assert.equal(ctx.budget.cancel(cancelled.token).status, "cancelled");
  assert.deepEqual(ctx.budget.recover(cancelled.token), {
    recovered: false,
    reason: "NOT_PENDING",
  });
  assert.equal(ctx.budget.cancel(cancelled.token).duplicate, true);
  assert.deepEqual(ctx.budget.recover(cancelled.token), {
    recovered: false,
    reason: "NOT_PENDING",
  });
});
