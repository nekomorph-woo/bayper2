/* S05a 连接来源与独立 Agent 事实账本。
   只持久化来源连接、Agent 状态和待呈现事实，不接真实 Herdr、不生成台词，
   也不消耗角色精力、亲密度或心情。来源身份是 instanceId（稳定安装/端点）与
   runId（来源进程运行代次）的组合；Agent 身份再叠加 agentId。显示名、会话或
   终端标签只保存为展示字段，不参与任何判重。sequence 仅在本来源 run 代次内
   比较，不代表 Herdr 的全局原生事件序号。 */
const { AppError } = require("./errors.cjs");
const { createConnectorStore, AGENT_STATES } = require("./connector-store.cjs");

const PRIORITY = {
  needs_attention: 0, finished: 1, failed: 1, stopped: 1, idle: 2, working: 2, unknown: 2,
};
/* 已结束或迟到的事实不再升级为当前催促；needs_attention 的历史提示与终态同级。 */
const HISTORICAL_PRIORITY = { ...PRIORITY, needs_attention: 1 };
const DISCONNECT_MS = 3000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function invalid(message) {
  return new AppError("INVALID_INPUT", message);
}

function cleanId(value, field) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 200) throw invalid(`${field} 必须是 1～200 字符的字符串。`);
  return text;
}

function cleanText(value, field, max = 200) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw invalid(`${field} 必须是字符串或空值。`);
  const text = value.trim();
  if (text.length > max) throw invalid(`${field} 长度无效。`);
  return text || null;
}

function cleanState(value) {
  if (!AGENT_STATES.includes(value)) throw invalid("state 不是受支持的 Agent 状态。");
  return value;
}

function cleanSequence(value) {
  if (!Number.isInteger(value) || value < 0) throw invalid("sequence 必须是非负整数。");
  return value;
}

function cleanTime(value, field) {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : value;
  if (!Number.isInteger(ms) || ms < 0) throw invalid(`${field} 必须是非负毫秒整数或空值。`);
  return ms;
}

function cleanLimit(value) {
  if (value === undefined || value === null) return DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1) throw invalid("limit 必须是正整数。");
  return Math.min(value, MAX_LIMIT);
}

function createConnectorLedger({ db, now = () => Date.now(), appRunId } = {}) {
  if (!db || typeof db.prepare !== "function") {
    throw new AppError("DATABASE_REQUIRED", "连接账本需要显式传入 SQLite 连接。");
  }
  const runScope = cleanId(appRunId, "appRunId");
  const { q, tx, addEvent, rowToEvent } = createConnectorStore({ db, appRunId: runScope });
  const clock = typeof now === "function" ? now : () => Date.now();

  function at() {
    const value = clock();
    const ms = value instanceof Date ? value.getTime() : value;
    if (!Number.isInteger(ms) || ms < 0) throw new AppError("INVALID_NOW", "now 必须返回非负毫秒整数。");
    return ms;
  }

  /* 同一 Agent/sequence/state 只产生一个通知项。若该事实先由快照记为 reconciled，
     后来的源事件只补事件身份，不再入队第二条提示。 */
  function attachEventIdentity(fact, fields) {
    if (fact.source_event_id === null) {
      q.setEventSource.run(fields.sourceEventId, fact.id);
      return;
    }
    addEvent({
      ...fields, kind: "agent_change", priority: null,
      notificationStatus: "none", linkedEventId: fact.id,
    });
  }

  function emitFact(fields, priority, extra = {}) {
    const fact = q.episode.get(
      fields.instanceId, fields.runId, fields.agentId, fields.sequence, fields.state,
    );
    if (fact) {
      attachEventIdentity(fact, fields);
      return false;
    }
    addEvent({
      ...fields, kind: "agent_change", priority, notificationStatus: "pending", ...extra,
    });
    return true;
  }

  /* 基线或同 episode 的观测只保留事件身份，不冒充新的变化通知。 */
  function recordObserved(fields) {
    const fact = q.episode.get(
      fields.instanceId, fields.runId, fields.agentId, fields.sequence, fields.state,
    );
    if (fact) {
      attachEventIdentity(fact, fields);
    } else {
      addEvent({ ...fields, kind: "agent_change", priority: null, notificationStatus: "none" });
    }
  }

  function ensureOnline(instanceId, runId, when) {
    if (q.onlineEvent.get(runScope, instanceId, runId)) return false;
    addEvent({
      instanceId, runId, kind: "online", priority: 2,
      notificationStatus: "pending", receivedAt: when,
    });
    return true;
  }

  function resolveRun(instanceId, runId) {
    const instance = q.instance.get(instanceId);
    if (!instance) return { reason: "UNKNOWN_INSTANCE" };
    if (instance.disabled === 1) return { reason: "DISABLED", instance };
    if (instance.current_run_id !== runId) return { reason: "STALE_RUN", instance };
    const run = q.run.get(instanceId, runId);
    if (!run) return { reason: "UNKNOWN_RUN", instance };
    if (run.app_run_id !== runScope) return { reason: "NOT_CONNECTED", instance, run };
    return { instance, run };
  }

  function describeInstance(instance) {
    const run = instance.current_run_id
      ? q.run.get(instance.instance_id, instance.current_run_id)
      : null;
    const connected = Boolean(
      run && instance.disabled === 0 && run.online === 1 && run.app_run_id === runScope,
    );
    let state = "offline";
    if (connected) state = "online";
    else if (instance.disabled === 0 && run && run.state === "reconnecting") state = "reconnecting";
    return {
      instanceId: instance.instance_id, label: instance.label, disabled: instance.disabled === 1,
      state, online: state === "online", runId: run ? run.run_id : null,
      registeredAt: run ? run.registered_at : null, onlineAt: run ? run.online_at : null,
      disconnectedAt: run ? run.disconnected_at : null, stoppedAt: run ? run.stopped_at : null,
    };
  }

  function registerInstance({ instanceId, runId, label = null }) {
    const iid = cleanId(instanceId, "instanceId");
    const rid = cleanId(runId, "runId");
    const text = cleanText(label, "label");
    return tx(() => {
      const when = at();
      let instance = q.instance.get(iid);
      if (!instance) {
        q.addInstance.run(iid, text, when);
        instance = q.instance.get(iid);
      } else if (text !== null && text !== instance.label) {
        q.setInstanceLabel.run(text, iid);
      }
      if (instance.disabled === 1) {
        return { online: false, reason: "DISABLED", instanceId: iid, runId: rid };
      }
      const run = q.run.get(iid, rid);
      if (run && run.run_id !== instance.current_run_id) {
        return { online: false, reason: "STALE_RUN", instanceId: iid, runId: rid };
      }
      if (run && run.stopped_at !== null) {
        return { online: false, reason: "STOPPED_RUN", instanceId: iid, runId: rid };
      }

      const flags = { newRun: false, adopted: false, recovered: false, duplicate: false };
      if (!run) {
        if (instance.current_run_id) q.retireRun.run(iid, instance.current_run_id);
        q.addRun.run(iid, rid, runScope, when, when);
        q.setCurrentRun.run(rid, iid);
        flags.newRun = true;
      } else if (run.app_run_id !== runScope) {
        /* 同一来源进程跨 app 重启：重新登记后只按新 appRunId 提示一次上线。 */
        q.adoptRun.run(runScope, when, iid, rid);
        flags.adopted = true;
      } else if (run.online === 1) {
        flags.duplicate = true;
      } else {
        q.reconnectRun.run(when, iid, rid);
        if (run.state === "reconnecting" && run.disconnect_notified === 1) {
          addEvent({
            instanceId: iid, runId: rid, kind: "recovered", priority: 2,
            notificationStatus: "pending", receivedAt: when,
          });
          flags.recovered = true;
        }
      }
      const notified = flags.newRun || flags.adopted ? ensureOnline(iid, rid, when) : false;
      return { online: true, instanceId: iid, runId: rid, state: "online", ...flags, notified };
    });
  }

  function markDisconnected({ instanceId, runId }) {
    const iid = cleanId(instanceId, "instanceId");
    const rid = cleanId(runId, "runId");
    return tx(() => {
      const resolved = resolveRun(iid, rid);
      if (resolved.reason) return { accepted: false, reason: resolved.reason };
      if (resolved.run.state === "offline") return { accepted: false, reason: "STOPPED" };
      if (resolved.run.online === 1) {
        const when = at();
        q.disconnectRun.run(when, iid, rid);
        /* 断联不伪造 Agent 终态：只把当前有效状态置 unknown，保留 lastKnown。 */
        q.agentsUnknown.run(iid, rid);
        return { accepted: true, first: true, disconnectedAt: when, notified: false };
      }
      /* 重复 EOF 保留首次断联时间，不能延后 3000ms 的提示计时。 */
      return {
        accepted: true, first: false, disconnectedAt: resolved.run.disconnected_at,
        notified: resolved.run.disconnect_notified === 1,
      };
    });
  }

  function tick() {
    return tx(() => {
      const when = at();
      const notified = [];
      for (const run of q.timedOutRuns.all(runScope)) {
        if (when - run.disconnected_at < DISCONNECT_MS) continue;
        addEvent({
          instanceId: run.instance_id, runId: run.run_id, kind: "disconnected", priority: 1,
          notificationStatus: "pending", occurredAt: run.disconnected_at, receivedAt: when,
        });
        q.markDisconnectNotified.run(run.instance_id, run.run_id);
        notified.push({ instanceId: run.instance_id, runId: run.run_id });
      }
      return { notified };
    });
  }

  function confirmStopped({ instanceId, runId }) {
    const iid = cleanId(instanceId, "instanceId");
    const rid = cleanId(runId, "runId");
    return tx(() => {
      const resolved = resolveRun(iid, rid);
      if (resolved.reason) return { stopped: false, reason: resolved.reason };
      if (resolved.run.stopped_at !== null) return { stopped: true, recorded: false };
      const when = at();
      q.stopRun.run(when, iid, rid);
      q.agentsUnknown.run(iid, rid);
      let recorded = false;
      if (!q.offlineEvent.get(runScope, iid, rid)) {
        addEvent({
          instanceId: iid, runId: rid, kind: "offline", priority: 1,
          notificationStatus: "pending", receivedAt: when,
        });
        recorded = true;
      }
      return { stopped: true, recorded };
    });
  }

  function disableInstance({ instanceId }) {
    const iid = cleanId(instanceId, "instanceId");
    return tx(() => {
      const when = at();
      const instance = q.instance.get(iid);
      if (!instance) throw new AppError("CONNECTOR_NOT_FOUND", "连接来源不存在。");
      if (instance.disabled === 1) return { disabled: true, changed: false };
      q.disableInstance.run(when, iid);
      const runId = instance.current_run_id;
      if (runId) {
        q.disableRun.run(iid, runId);
        q.agentsUnknown.run(iid, runId);
      }
      /* 主动停用是本地事实，不是 server stop：只留一条不通知的停用记录。 */
      addEvent({
        instanceId: iid, runId, kind: "disabled", notificationStatus: "none", receivedAt: when,
      });
      return { disabled: true, changed: true, runId };
    });
  }

  function enableInstance({ instanceId }) {
    const iid = cleanId(instanceId, "instanceId");
    return tx(() => {
      const instance = q.instance.get(iid);
      if (!instance) throw new AppError("CONNECTOR_NOT_FOUND", "连接来源不存在。");
      if (instance.disabled === 0) return { disabled: false, changed: false };
      q.enableInstance.run(iid);
      return { disabled: false, changed: true };
    });
  }

  function recordAgentChange({
    instanceId, runId, agentId, state, rawState = null, sequence, eventId, occurredAt = null,
  }) {
    const iid = cleanId(instanceId, "instanceId");
    const rid = cleanId(runId, "runId");
    const aid = cleanId(agentId, "agentId");
    const nextState = cleanState(state);
    const raw = cleanText(rawState, "rawState");
    const seq = cleanSequence(sequence);
    const sourceEventId = cleanId(eventId, "eventId");
    const occurred = cleanTime(occurredAt, "occurredAt");
    const priority = PRIORITY[nextState];

    return tx(() => {
      const resolved = resolveRun(iid, rid);
      if (resolved.reason) return { accepted: false, reason: resolved.reason };
      if (q.eventBySource.get(iid, rid, sourceEventId)) {
        return { accepted: false, reason: "DUPLICATE_EVENT", eventId: sourceEventId };
      }
      const when = at();
      const existing = q.agent.get(iid, rid, aid);
      const fields = {
        instanceId: iid, runId: rid, agentId: aid, state: nextState, rawState: raw,
        sequence: seq, sourceEventId, occurredAt: occurred, receivedAt: when,
      };

      if (resolved.run.online !== 1 || resolved.run.state !== "online") {
        /* 停止或断联尚未重新登记：迟到包只作为历史事实保留，不修改当前
           Agent，也不产生在线事实。 */
        const episode = q.episode.get(iid, rid, aid, seq, nextState);
        let notified = false;
        if (episode) {
          attachEventIdentity(episode, fields);
        } else {
          addEvent({
            ...fields, kind: "agent_change", priority: HISTORICAL_PRIORITY[nextState],
            historical: true, notificationStatus: "pending",
          });
          notified = true;
        }
        return {
          accepted: true, appliedCurrent: false, historical: true, notified, sequence: seq,
          reason: resolved.run.stopped_at !== null ? "STOPPED_HISTORY" : "DISCONNECTED_HISTORY",
        };
      }

      if (!existing) {
        /* 事件先于任何权威快照：这是首个已知事实，按真实变化入账并建立当前状态。 */
        q.addAgent.run(iid, rid, aid, null, nextState, nextState, raw, seq, occurred, when, 0);
        return { accepted: true, notified: emitFact(fields, priority), historical: false, sequence: seq };
      }
      if (seq > existing.max_sequence) {
        const notified = emitFact(fields, priority);
        q.updateAgentFromEvent.run(
          nextState, nextState, raw, seq, occurred, when, iid, rid, aid,
        );
        return { accepted: true, notified, historical: false, state: nextState, sequence: seq };
      }
      if (seq === existing.max_sequence) {
        if (nextState !== existing.effective_state) {
          const restorable = existing.effective_state === "unknown"
            && nextState === existing.last_known_state;
          /* 同一 sequence 的冲突状态拒绝；曾被快照遗漏的同一 episode 只恢复不通知。 */
          if (!restorable) {
            return { accepted: false, reason: "SEQUENCE_CONFLICT", sequence: seq };
          }
          q.updateAgentFromEvent.run(
            nextState, nextState, raw, seq, occurred, when, iid, rid, aid,
          );
          recordObserved(fields);
          return { accepted: true, notified: false, historical: false, reason: "RESTORED" };
        }
        /* 相同 episode（基线或快照已覆盖）不重复通知，只保留事件身份。 */
        recordObserved(fields);
        return { accepted: true, notified: false, historical: false, reason: "SAME_EPISODE" };
      }
      /* 晚到的低 sequence 真实事件补入历史，但不回滚当前状态；notification 仍
         pending，消费者可用 historical 区分它并非当前 episode。 */
      return {
        accepted: true,
        notified: emitFact(fields, HISTORICAL_PRIORITY[nextState], { historical: true }),
        historical: true, sequence: seq,
      };
    });
  }

  function applySnapshot({ instanceId, runId, complete, gapped = false, agents = [] }) {
    const iid = cleanId(instanceId, "instanceId");
    const rid = cleanId(runId, "runId");
    if (typeof complete !== "boolean") throw invalid("complete 必须由调用方明确声明为布尔值。");
    if (typeof gapped !== "boolean") throw invalid("gapped 必须是布尔值。");
    if (!Array.isArray(agents)) throw invalid("agents 必须是数组。");
    const seen = new Set();
    const incoming = agents.map((agent) => {
      const agentId = cleanId(agent?.agentId, "agentId");
      if (seen.has(agentId)) throw invalid(`快照中 agentId 重复：${agentId}`);
      seen.add(agentId);
      return {
        agentId, state: cleanState(agent.state), rawState: cleanText(agent.rawState, "rawState"),
        sequence: cleanSequence(agent.sequence), occurredAt: cleanTime(agent.occurredAt, "occurredAt"),
        label: cleanText(agent.label, "label"),
      };
    });

    return tx(() => {
      const resolved = resolveRun(iid, rid);
      if (resolved.reason) return { accepted: false, reason: resolved.reason };
      if (resolved.run.online !== 1 || resolved.run.state !== "online") {
        /* 停止代次或断联未重新登记时，任何快照都不能改写当前事实。 */
        return {
          accepted: false,
          reason: resolved.run.stopped_at !== null ? "STOPPED" : "NOT_CONNECTED",
        };
      }
      const when = at();
      let gapRecorded = false;
      if (gapped && resolved.run.gap_open === 0) {
        addEvent({
          instanceId: iid, runId: rid, kind: "gap", gapped: true,
          notificationStatus: "none", receivedAt: when,
        });
        q.setGapOpen.run(1, iid, rid);
        gapRecorded = true;
      } else if (complete && !gapped && resolved.run.gap_open === 1) {
        q.setGapOpen.run(0, iid, rid);
      }

      const result = {
        accepted: true, baseline: false, gapRecorded, added: [], updated: 0, reconciled: 0,
        conflicts: [], missing: [], stale: [],
      };
      if (q.agents.all(iid, rid).length === 0) {
        for (const agent of incoming) {
          q.addAgent.run(iid, rid, agent.agentId, agent.label, agent.state, agent.state,
            agent.rawState, agent.sequence, agent.occurredAt, when, 1);
          /* 初始基线也是最小去重事实；只入账不通知，迟到事件不能再冒充变化。 */
          addEvent({
            instanceId: iid, runId: rid, agentId: agent.agentId, kind: "baseline",
            state: agent.state, rawState: agent.rawState, sequence: agent.sequence,
            notificationStatus: "none", occurredAt: agent.occurredAt, receivedAt: when,
          });
        }
        return { ...result, baseline: true, updated: incoming.length };
      }
      for (const agent of incoming) {
        const existing = q.agent.get(iid, rid, agent.agentId);
        if (!existing) {
          /* 新出现的 Agent 没有可比较的旧状态，建立自己的基线，不冒充变化。 */
          q.addAgent.run(iid, rid, agent.agentId, agent.label, agent.state, agent.state,
            agent.rawState, agent.sequence, agent.occurredAt, when, 1);
          addEvent({
            instanceId: iid, runId: rid, agentId: agent.agentId, kind: "baseline",
            state: agent.state, rawState: agent.rawState, sequence: agent.sequence,
            notificationStatus: "none", occurredAt: agent.occurredAt, receivedAt: when,
          });
          result.added.push(agent.agentId);
          continue;
        }
        if (agent.sequence < existing.max_sequence) {
          /* 旧得快照不能回滚；只确认该 Agent 在本次快照中可见。 */
          result.stale.push(agent.agentId);
          q.touchSnapshotAgent.run(agent.label, iid, rid, agent.agentId);
          continue;
        }
        if (agent.sequence === existing.max_sequence) {
          if (agent.state === existing.effective_state) {
            q.touchSnapshotAgent.run(agent.label, iid, rid, agent.agentId);
            result.updated += 1;
            continue;
          }
          const restorable = existing.effective_state === "unknown"
            && agent.state === existing.last_known_state;
          if (!restorable) {
            /* 同 sequence 状态冲突：拒绝覆盖，只确认该 Agent 在快照中可见。 */
            result.conflicts.push(agent.agentId);
            q.touchSnapshotAgent.run(agent.label, iid, rid, agent.agentId);
            continue;
          }
        }
        /* 更高 sequence 的真实变化，或曾被完整快照遗漏的 Agent 重新出现。 */
        if (agent.sequence > existing.max_sequence && agent.state !== existing.effective_state) {
          const episode = q.episode.get(iid, rid, agent.agentId, agent.sequence, agent.state);
          if (!episode) {
            addEvent({
              instanceId: iid, runId: rid, agentId: agent.agentId, kind: "reconciled",
              state: agent.state, rawState: agent.rawState, sequence: agent.sequence,
              priority: PRIORITY[agent.state], reconciled: true, gapped: true,
              notificationStatus: "pending", occurredAt: agent.occurredAt, receivedAt: when,
            });
            result.reconciled += 1;
          } else if (episode.historical === 1 && episode.notification_status === "pending") {
            /* 断联历史被新快照确认成当前：升级原通知，不新增第二条。 */
            q.promoteEpisode.run(PRIORITY[agent.state], episode.id);
            result.reconciled += 1;
          }
        }
        const occurred = agent.sequence > existing.max_sequence
          ? agent.occurredAt
          : agent.occurredAt ?? existing.occurred_at;
        q.updateAgentFromSnapshot.run(agent.state, agent.state, agent.rawState, agent.sequence,
          occurred, when, agent.label, iid, rid, agent.agentId);
        result.updated += 1;
      }

      if (complete) {
        for (const row of q.agents.all(iid, rid)) {
          if (!seen.has(row.agent_id)) {
            /* 完整快照缺少的 Agent 只标为 unknown/不在当前快照，不伪造终态。 */
            q.missAgent.run(iid, rid, row.agent_id);
            result.missing.push(row.agent_id);
          }
        }
      }
      return result;
    });
  }

  function getInstance({ instanceId }) {
    const instance = q.instance.get(cleanId(instanceId, "instanceId"));
    return instance ? describeInstance(instance) : null;
  }

  function listAgents({ instanceId, runId = null }) {
    const iid = cleanId(instanceId, "instanceId");
    const instance = q.instance.get(iid);
    if (!instance) return [];
    const rid = runId === null ? instance.current_run_id : cleanId(runId, "runId");
    if (!rid) return [];
    return q.agents.all(iid, rid).map((row) => ({
      instanceId: row.instance_id, runId: row.run_id, agentId: row.agent_id, label: row.label,
      effectiveState: row.effective_state, lastKnownState: row.last_known_state,
      rawState: row.raw_state, sequence: row.max_sequence, occurredAt: row.occurred_at,
      receivedAt: row.received_at, inSnapshot: row.in_snapshot === 1,
    }));
  }

  function listEvents({ instanceId = null, runId = null, after = 0, limit } = {}) {
    const iid = instanceId === null ? null : cleanId(instanceId, "instanceId");
    const rid = runId === null ? null : cleanId(runId, "runId");
    if (!Number.isInteger(after) || after < 0) throw invalid("after 必须是非负整数游标。");
    const size = cleanLimit(limit);
    const rows = q.events.all(after, iid, iid, rid, rid, size + 1);
    const page = rows.slice(0, size);
    return {
      items: page.map(rowToEvent),
      nextCursor: rows.length > size ? page[page.length - 1].id : null,
    };
  }

  function listPending({ limit } = {}) {
    return q.pending.all(cleanLimit(limit)).map(rowToEvent);
  }

  function markPresented(eventIds) {
    if (!Array.isArray(eventIds)) throw invalid("eventIds 必须是数组。");
    const ids = new Set();
    for (const id of eventIds) {
      if (!Number.isInteger(id) || id < 1) throw invalid("eventIds 只能包含正整数。");
      ids.add(id);
    }
    return tx(() => {
      let updated = 0;
      for (const id of ids) updated += Number(q.markPresented.run(id).changes);
      return { updated };
    });
  }

  return {
    appRunId: runScope, registerInstance, markDisconnected, tick, confirmStopped,
    disableInstance, enableInstance, recordAgentChange, applySnapshot, getInstance,
    listAgents, listEvents, listPending, markPresented,
  };
}

module.exports = { createConnectorLedger, AGENT_STATES };
