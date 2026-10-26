/* S05f 通知排队与呈现确认。
   只消费正式 connector ledger 的 pending 事实；普通三位与独立加急位由 tick 驱
   动准备。准备/入队不等于可见，只有 renderer 对当前 presentationId/eventIds
   的真实回执才 markPresented，并从回执时间计算 4/6 秒最短阅读。 */
const crypto = require("node:crypto");
const { AppError } = require("./errors.cjs");
const { createNotificationPresentationStore } = require("./notification-presentation-store.cjs");

const TIERS = {
  0: { aggregate: 500, target: 1000, hold: 6000, channel: "urgent" },
  1: { aggregate: 1000, target: 4000, hold: 4000, channel: "ordinary" },
  2: { aggregate: 2000, target: 8000, hold: 4000, channel: "ordinary" },
};
const ORDINARY_SLOTS = 3;
const SCHEDULE_TARGETS = {
  0: TIERS[0].target, 1: TIERS[1].target, 2: TIERS[2].target,
};
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_SCAN_PAGES = 8;
const DEFAULT_AUDIT_LIMIT = 50;
const MAX_AUDIT_LIMIT = 500;
const STATE_TEXT = {
  working: "正在工作",
  idle: "空闲",
  needs_attention: "需要确认",
  finished: "已结束",
  failed: "异常结束",
  stopped: "已停止",
  unknown: "状态未知",
};
const CONTINUED_TEXT = {
  working: "继续工作",
  idle: "空闲",
  finished: "结束",
  failed: "异常结束",
  stopped: "停止",
  unknown: "状态未知",
};

const invalid = (message) => new AppError("NOTIFICATION_INVALID_INPUT", message);
const writeFailed = (message) => new AppError("NOTIFICATION_WRITE_FAILED", message);

function cleanId(value, field) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 200) throw invalid(`${field} 必须是 1～200 字符的字符串。`);
  return text;
}

function cleanTime(value, field) {
  const ms = value instanceof Date ? value.getTime() : value;
  if (!Number.isInteger(ms) || ms < 0) throw invalid(`${field} 必须是非负毫秒整数。`);
  return ms;
}

function cleanLimit(value, field) {
  if (value === undefined || value === null) return DEFAULT_AUDIT_LIMIT;
  if (!Number.isInteger(value) || value < 1) throw invalid(`${field} 必须是正整数。`);
  return Math.min(value, MAX_AUDIT_LIMIT);
}

function cleanEventIds(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalid("eventIds 必须是非空数组。");
  }
  const ids = [...new Set(value)];
  for (const id of ids) {
    if (!Number.isInteger(id) || id < 1) throw invalid("eventIds 只能包含正整数。");
  }
  return ids;
}

function effectivePriority(event) {
  const priority = event.historical
    ? (event.originalPriority ?? event.priority ?? 2)
    : (event.priority ?? event.originalPriority ?? 2);
  return TIERS[priority] ? priority : 2;
}

function agentState(input) {
  return STATE_TEXT[input] ?? "状态未知";
}

function createNotificationPresentation({
  db, ledger, now = () => Date.now(),
  pageSize = DEFAULT_PAGE_SIZE, maxScanPages = DEFAULT_MAX_SCAN_PAGES,
} = {}) {
  if (!db || typeof db.prepare !== "function") throw invalid("需要显式共享 SQLite 连接。");
  if (!ledger || typeof ledger.listPendingPage !== "function"
    || typeof ledger.listEventsByIds !== "function"
    || typeof ledger.listPendingScheduled !== "function"
    || typeof ledger.markPresentedWith !== "function"
    || typeof ledger.getInstance !== "function" || typeof ledger.listAgents !== "function") {
    throw invalid("需要正式 connector ledger。");
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) {
    throw invalid("pageSize 必须是 1～200 的整数。");
  }
  if (!Number.isInteger(maxScanPages) || maxScanPages < 1) {
    throw invalid("maxScanPages 必须是正整数。");
  }
  if (typeof now !== "function") throw invalid("now 必须是函数。");
  const clock = now;
  const store = createNotificationPresentationStore({ db });
  let generation = crypto.randomUUID();
  let disposed = false;
  let scanCursor = 0;
  let lastScan = null;

  function at() {
    const ms = clock();
    return cleanTime(ms, "now");
  }

  function sourceLabel(instanceId, cache) {
    if (!instanceId) return null;
    if (!cache.has(instanceId)) {
      const instance = ledger.getInstance({ instanceId });
      cache.set(instanceId, instance?.label ?? instanceId);
    }
    return cache.get(instanceId);
  }

  function agentRows(instanceId, runId, cache) {
    const key = `${instanceId}\u0000${runId}`;
    if (!cache.has(key)) cache.set(key, ledger.listAgents({ instanceId, runId }));
    return cache.get(key);
  }

  function context() {
    return { sources: new Map(), agents: new Map() };
  }

  function itemView(event, itemRow, ctx) {
    const priority = effectivePriority(event);
    const tier = TIERS[priority];
    const current = event.agentId
      ? agentRows(event.instanceId, event.runId, ctx.agents)
        .find((item) => item.agentId === event.agentId) ?? null
      : null;
    const source = sourceLabel(event.instanceId, ctx.sources);
    const agent = current?.label ?? event.agentId ?? null;
    const currentState = current?.effectiveState ?? null;
    const currentUnknown = event.state === "needs_attention"
      && (currentState === null || currentState === "unknown");
    const recovered = event.state === "needs_attention"
      && currentState !== null && currentState !== "needs_attention"
      && currentState !== "unknown";
    const currentNeedsAttention = currentState === "needs_attention";
    let phrase;
    if (event.kind === "online") phrase = "已连接";
    else if (event.kind === "recovered") phrase = "已恢复";
    else if (event.kind === "disconnected") phrase = "持续异常，已断开";
    else if (event.kind === "offline") phrase = "已下线";
    else if (event.state === "needs_attention" && recovered) {
      phrase = `曾需要确认，现已${CONTINUED_TEXT[currentState] ?? "恢复"}`;
    } else {
      phrase = agentState(event.state);
    }
    const subject = agent ? `${source ?? event.instanceId} / ${agent}` : (source ?? event.instanceId);
    const history = event.historical && priority > 0 ? "历史：" : "";
    return {
      eventId: event.id,
      sourceEventId: event.eventId,
      presentationId: itemRow?.presentationId ?? null,
      position: itemRow?.position ?? null,
      instanceId: event.instanceId,
      runId: event.runId,
      agentId: event.agentId,
      sourceLabel: source,
      agentLabel: agent,
      kind: event.kind,
      state: event.state,
      rawState: event.rawState,
      historical: event.historical,
      originalPriority: event.originalPriority,
      priority,
      receivedAt: event.receivedAt,
      aggregateBy: event.receivedAt + tier.aggregate,
      dueAt: event.receivedAt + tier.target,
      acknowledgedAt: itemRow?.acknowledgedAt ?? null,
      holdUntil: itemRow?.holdUntil ?? null,
      currentState,
      currentNeedsAttention,
      currentUnknown,
      recovered,
      text: `${history}${subject}：${phrase}`,
    };
  }

  function activeData() {
    const rows = store.q.activePresentations.all(generation);
    return rows.map((row) => ({
      row: store.presentation(row),
      items: store.q.items.all(row.presentation_id).map(store.item),
    }));
  }

  function viewFor(time, scan = lastScan) {
    const ctx = context();
    const active = activeData();
    const presentations = [];
    for (const entry of active) {
      const eventIds = entry.items.map((item) => item.eventId);
      const events = ledger.listEventsByIds(eventIds);
      const byId = new Map(events.map((event) => [event.id, event]));
      const items = [];
      for (const item of entry.items) {
        const event = byId.get(item.eventId);
        if (event) items.push(itemView(event, item, ctx));
      }
      const received = items.map((item) => item.receivedAt).filter(Number.isInteger);
      presentations.push({
        presentationId: entry.row.presentationId,
        channel: entry.row.channel,
        slot: entry.row.slot,
        state: entry.row.state,
        createdAt: entry.row.createdAt,
        updatedAt: entry.row.updatedAt,
        batchStartedAt: received.length ? Math.min(...received) : entry.row.createdAt,
        items,
      });
    }
    return {
      generation,
      now: time,
      presentations,
      counts: {
        ordinary: presentations.filter((item) => item.channel === "ordinary").length,
        urgent: presentations.filter((item) => item.channel === "urgent").length,
      },
      overdueCount: store.q.auditCount.get().count,
      scan,
    };
  }

  function closeExpired(time) {
    for (const entry of activeData()) {
      const items = entry.items;
      if (items.length === 0) continue;
      if (items.every((item) => item.acknowledgedAt !== null)
        && Math.max(...items.map((item) => item.holdUntil ?? 0)) <= time) {
        store.q.closePresentation.run(time, time, "HOLD_ELAPSED", entry.row.presentationId);
      }
    }
  }

  function scanPending(time) {
    let cursor = scanCursor;
    let pages = 0;
    let complete = false;
    const events = [];
    while (pages < maxScanPages) {
      const page = ledger.listPendingPage({ after: cursor, limit: pageSize });
      pages += 1;
      events.push(...page.items);
      if (!page.nextCursor) {
        complete = true;
        cursor = 0;
        break;
      }
      cursor = page.nextCursor;
    }
    scanCursor = complete ? 0 : cursor;
    lastScan = {
      pages,
      scanned: events.length,
      complete,
      nextCursor: complete ? null : scanCursor,
    };
    return { events, scan: lastScan, time };
  }

  function createPresentation(channel, slot, events, time) {
    const presentationId = crypto.randomUUID();
    store.tx(() => {
      store.q.insertPresentation.run(
        presentationId, generation, channel, slot, time, time,
      );
      events.forEach((event, index) => {
        store.q.insertItem.run(presentationId, event.id, index);
      });
    });
    return presentationId;
  }

  function appendUrgent(presentationId, events, time) {
    store.tx(() => {
      let position = store.q.maxPosition.get(presentationId).position;
      for (const event of events) {
        position += 1;
        store.q.insertItem.run(presentationId, event.id, position);
      }
      db.prepare(`
        UPDATE notification_presentations SET updated_at = ?
        WHERE presentation_id = ? AND state IN ('offered', 'visible')
      `).run(time, presentationId);
    });
  }

  /* 只在当前页之外也能选到全队列最早 deadline：普通位和加急位分别做
     有界 ORDER BY LIMIT 查询，不把整张 pending 表读进内存。 */
  function fillPresentations() {
    const active = activeData();
    const occupied = new Set(active
      .filter((entry) => entry.row.channel === "ordinary")
      .map((entry) => entry.row.slot));
    const free = [];
    for (let slot = 0; slot < ORDINARY_SLOTS; slot += 1) {
      if (!occupied.has(slot)) free.push(slot);
    }
    const selected = [];
    if (free.length > 0) {
      const normal = ledger.listPendingScheduled({
        limit: free.length, targets: SCHEDULE_TARGETS,
      });
      for (let index = 0; index < free.length && index < normal.length; index += 1) {
        createPresentation("ordinary", free[index], [normal[index]], at());
        selected.push(normal[index]);
      }
    }

    const afterOrdinary = activeData();
    const currentUrgent = afterOrdinary.find((entry) => entry.row.channel === "urgent");
    const urgent = ledger.listPendingScheduled({
      limit: pageSize, urgent: true, targets: SCHEDULE_TARGETS,
    });
    if (urgent.length > 0) {
      if (currentUrgent) appendUrgent(currentUrgent.row.presentationId, urgent, at());
      else createPresentation("urgent", 0, urgent, at());
      selected.push(...urgent);
    }
    return selected;
  }

  function recordOverdue(scanned, time) {
    for (const event of scanned) {
      const dueAt = event.receivedAt + TIERS[effectivePriority(event)].target;
      if (time <= dueAt) continue;
      const activeItem = store.q.activeItemForEvent.get(generation, event.id);
      const reason = activeItem && activeItem.acknowledged_at === null
        ? "NOT_ACKNOWLEDGED" : "QUEUED";
      store.q.audit.run(
        event.id, dueAt, time, reason, activeItem?.presentation_id ?? null,
      );
    }
  }

  function tick() {
    if (disposed) throw new AppError("NOTIFICATION_DISPOSED", "通知呈现服务已释放。");
    const time = at();
    closeExpired(time);
    const { events } = scanPending(time);
    const selected = fillPresentations();
    recordOverdue([...events, ...selected], time);
    return viewFor(time);
  }

  function getView() {
    if (disposed) throw new AppError("NOTIFICATION_DISPOSED", "通知呈现服务已释放。");
    return viewFor(at());
  }

  function acknowledge({ presentationId, eventIds } = {}) {
    if (disposed) throw new AppError("NOTIFICATION_DISPOSED", "通知呈现服务已释放。");
    const pid = cleanId(presentationId, "presentationId");
    const ids = cleanEventIds(eventIds);
    const row = store.presentation(store.q.presentation.get(pid));
    if (!row || row.generation !== generation || row.state === "closed") {
      throw new AppError(
        "NOTIFICATION_STALE_PRESENTATION", "该呈现不属于当前窗口代次或已结束。",
      );
    }
    const items = store.q.items.all(pid).map(store.item);
    const allowed = new Set(items.map((item) => item.eventId));
    if (ids.some((id) => !allowed.has(id))) {
      throw new AppError(
        "NOTIFICATION_EVENT_NOT_IN_PRESENTATION", "回执包含不属于该呈现的事件。",
      );
    }
    const time = at();
    const provided = new Set(ids);
    const unacked = items.filter(
      (item) => provided.has(item.eventId) && item.acknowledgedAt === null,
    );
    const alreadyPresented = ids.length - unacked.length;
    if (unacked.length === 0) {
      return {
        accepted: true, presentationId: pid, newlyPresented: 0, alreadyPresented,
        acknowledgedAt: null, holdUntil: null,
      };
    }
    const events = ledger.listEventsByIds(unacked.map((item) => item.eventId));
    const eventsById = new Map(events.map((event) => [event.id, event]));
    if (unacked.some((item) => !eventsById.has(item.eventId))) {
      throw new AppError("NOTIFICATION_EVENT_NOT_IN_PRESENTATION", "呈现事件已不存在。");
    }
    const hold = row.channel === "urgent" ? TIERS[0].hold : TIERS[1].hold;
    let holdUntil = null;
    try {
      /* 共享账本事务：任一呈现写入失败，presented 与 ack/hold 一起回滚。 */
      const committed = ledger.markPresentedWith(
        unacked.map((item) => item.eventId),
        () => {
          let highWater = null;
          for (const item of unacked) {
            const until = time + hold;
            store.q.acknowledgeItem.run(time, until, pid, item.eventId);
            highWater = highWater === null ? until : Math.max(highWater, until);
            const event = eventsById.get(item.eventId);
            const dueAt = event.receivedAt + TIERS[effectivePriority(event)].target;
            if (time > dueAt) {
              store.q.audit.run(event.id, dueAt, time, "ACK_AFTER_DUE", pid);
            }
          }
          store.q.markVisible.run(time, pid, generation);
          return { holdUntil: highWater };
        },
      );
      holdUntil = committed.extra?.holdUntil ?? null;
    } catch {
      throw writeFailed("通知事实与呈现状态未原子提交，可安全重试。");
    }
    return {
      accepted: true, presentationId: pid, newlyPresented: unacked.length,
      alreadyPresented, acknowledgedAt: time, holdUntil,
    };
  }

  /* 用户主动收起是阅读时长例外：关闭呈现但不把未回执事件标成已展示。 */
  function closePresentation({ presentationId, reason = "USER_CLOSED" } = {}) {
    if (disposed) throw new AppError("NOTIFICATION_DISPOSED", "通知呈现服务已释放。");
    const pid = cleanId(presentationId, "presentationId");
    const why = cleanId(reason, "reason");
    const row = store.presentation(store.q.presentation.get(pid));
    if (!row || row.generation !== generation || row.state === "closed") {
      throw new AppError(
        "NOTIFICATION_STALE_PRESENTATION", "该呈现不属于当前窗口代次或已结束。",
      );
    }
    const time = at();
    const closed = store.q.closePresentation.run(time, time, why, pid).changes > 0;
    return { closed, presentationId: pid };
  }

  function rebuildWindow() {
    if (disposed) throw new AppError("NOTIFICATION_DISPOSED", "通知呈现服务已释放。");
    const time = at();
    const invalidated = store.q.closeActive.run(
      time, time, "WINDOW_REBUILT", generation,
    ).changes;
    generation = crypto.randomUUID();
    scanCursor = 0;
    lastScan = null;
    return { generation, invalidated };
  }

  function listOverdue({ limit } = {}) {
    if (disposed) throw new AppError("NOTIFICATION_DISPOSED", "通知呈现服务已释放。");
    return store.q.auditRows.all(cleanLimit(limit, "limit")).map(store.auditRow);
  }

  function dispose() {
    if (disposed) return { disposed: true, invalidated: 0 };
    const time = at();
    const invalidated = store.q.closeActive.run(
      time, time, "DISPOSED", generation,
    ).changes;
    disposed = true;
    scanCursor = 0;
    lastScan = null;
    return { disposed: true, invalidated };
  }

  /* 新进程/新窗口代次：旧 offer 只关闭呈现状态，不把未回执事件标成已展示。 */
  const startedAt = at();
  store.q.closeAllOpen.run(startedAt, startedAt, "SERVICE_RESTART");

  return {
    tick, getView, acknowledge, closePresentation, rebuildWindow, listOverdue, dispose,
    get generation() { return disposed ? null : generation; },
  };
}

module.exports = { createNotificationPresentation };
