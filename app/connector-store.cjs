/* S05a 连接账本的 SQLite 持久化层。
   只负责幂等建表、预编译语句、事务和事件行写入；来源/Agent 的业务判断、
   优先级和通知语义留在 connector-ledger.cjs。复用注入连接，不打开新的生产库。 */
const AGENT_STATES = [
  "idle", "working", "needs_attention", "finished", "failed", "stopped", "unknown",
];
const STATE_SQL = AGENT_STATES.map((state) => `'${state}'`).join(", ");

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS connector_instances (
    instance_id TEXT PRIMARY KEY, label TEXT, disabled INTEGER NOT NULL DEFAULT 0,
    disabled_at INTEGER, current_run_id TEXT, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS connector_runs (
    instance_id TEXT NOT NULL REFERENCES connector_instances(instance_id),
    run_id TEXT NOT NULL, app_run_id TEXT NOT NULL, online INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL CHECK (state IN ('online', 'reconnecting', 'offline')),
    registered_at INTEGER NOT NULL, online_at INTEGER, disconnected_at INTEGER, stopped_at INTEGER,
    disconnect_notified INTEGER NOT NULL DEFAULT 0,
    gap_open INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (instance_id, run_id)
  );
  CREATE TABLE IF NOT EXISTS connector_agents (
    instance_id TEXT NOT NULL, run_id TEXT NOT NULL, agent_id TEXT NOT NULL, label TEXT,
    effective_state TEXT NOT NULL CHECK (effective_state IN (${STATE_SQL})),
    last_known_state TEXT NOT NULL CHECK (last_known_state IN (${STATE_SQL})),
    raw_state TEXT, max_sequence INTEGER NOT NULL, occurred_at INTEGER, received_at INTEGER NOT NULL,
    in_snapshot INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (instance_id, run_id, agent_id),
    FOREIGN KEY (instance_id, run_id) REFERENCES connector_runs(instance_id, run_id)
  );
  CREATE TABLE IF NOT EXISTS connector_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, app_run_id TEXT NOT NULL, instance_id TEXT NOT NULL,
    run_id TEXT, agent_id TEXT, kind TEXT NOT NULL, state TEXT, raw_state TEXT, sequence INTEGER,
    source_event_id TEXT, priority INTEGER, historical INTEGER NOT NULL DEFAULT 0,
    reconciled INTEGER NOT NULL DEFAULT 0, gapped INTEGER NOT NULL DEFAULT 0,
    notification_status TEXT NOT NULL DEFAULT 'none', linked_event_id INTEGER,
    occurred_at INTEGER, received_at INTEGER NOT NULL
  );
  /* 来源事件身份只在同一 instance/run 代次内唯一；新 episode 使用新 eventId。 */
  CREATE UNIQUE INDEX IF NOT EXISTS connector_events_source_once
    ON connector_events (instance_id, run_id, source_event_id)
    WHERE source_event_id IS NOT NULL;
  /* 上线/停止提示按 app 运行与来源代次各一次，重复登记或服务重建不追加。 */
  CREATE UNIQUE INDEX IF NOT EXISTS connector_events_online_once
    ON connector_events (app_run_id, instance_id, run_id) WHERE kind = 'online';
  CREATE UNIQUE INDEX IF NOT EXISTS connector_events_offline_once
    ON connector_events (app_run_id, instance_id, run_id) WHERE kind = 'offline';
  CREATE INDEX IF NOT EXISTS connector_events_pending ON connector_events (notification_status, id);
  CREATE INDEX IF NOT EXISTS connector_events_listing ON connector_events (instance_id, run_id, id);
  CREATE INDEX IF NOT EXISTS connector_events_episode
    ON connector_events (instance_id, run_id, agent_id, sequence, state);
`;

function createConnectorStore({ db, appRunId }) {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  /* 新 appRunId 启动后，上一 app 进程的在线记录先变为待重连；只有来源重新登记
     才算连接，不把上次 online 当已连接，也不为没有来源的实例伪造记录。 */
  db.prepare(`
    UPDATE connector_runs SET online = 0, state = 'reconnecting', disconnected_at = NULL,
      disconnect_notified = 0, gap_open = 0
    WHERE app_run_id <> ? AND online = 1
  `).run(appRunId);
  /* 新 appRunId 启动后旧连接记录不可再确认：保留 lastKnown，但当前有效状态
     置 unknown，等待本 app run 的新权威快照；不能把上次 finished 等当已连接。 */
  db.prepare(`
    UPDATE connector_agents SET effective_state = 'unknown', in_snapshot = 0
    WHERE EXISTS (
      SELECT 1 FROM connector_runs r
      WHERE r.instance_id = connector_agents.instance_id
        AND r.run_id = connector_agents.run_id
        AND r.app_run_id <> ?
    )
  `).run(appRunId);

  const q = {
    instance: db.prepare("SELECT * FROM connector_instances WHERE instance_id = ?"),
    addInstance: db.prepare("INSERT INTO connector_instances (instance_id, label, created_at) VALUES (?, ?, ?)"),
    setInstanceLabel: db.prepare("UPDATE connector_instances SET label = ? WHERE instance_id = ?"),
    disableInstance: db.prepare("UPDATE connector_instances SET disabled = 1, disabled_at = ? WHERE instance_id = ?"),
    enableInstance: db.prepare("UPDATE connector_instances SET disabled = 0, disabled_at = NULL WHERE instance_id = ?"),
    setCurrentRun: db.prepare("UPDATE connector_instances SET current_run_id = ? WHERE instance_id = ?"),
    run: db.prepare("SELECT * FROM connector_runs WHERE instance_id = ? AND run_id = ?"),
    addRun: db.prepare("INSERT INTO connector_runs (instance_id, run_id, app_run_id, online, state, registered_at, online_at) VALUES (?, ?, ?, 1, 'online', ?, ?)"),
    retireRun: db.prepare("UPDATE connector_runs SET online = 0, state = 'offline' WHERE instance_id = ? AND run_id = ?"),
    adoptRun: db.prepare("UPDATE connector_runs SET app_run_id = ?, online = 1, state = 'online', online_at = ?, disconnected_at = NULL, disconnect_notified = 0, gap_open = 0 WHERE instance_id = ? AND run_id = ?"),
    reconnectRun: db.prepare("UPDATE connector_runs SET online = 1, state = 'online', online_at = ?, disconnected_at = NULL, disconnect_notified = 0 WHERE instance_id = ? AND run_id = ?"),
    disconnectRun: db.prepare("UPDATE connector_runs SET online = 0, state = 'reconnecting', disconnected_at = ?, disconnect_notified = 0 WHERE instance_id = ? AND run_id = ?"),
    markDisconnectNotified: db.prepare("UPDATE connector_runs SET disconnect_notified = 1 WHERE instance_id = ? AND run_id = ?"),
    stopRun: db.prepare("UPDATE connector_runs SET online = 0, state = 'offline', stopped_at = ?, disconnected_at = NULL, disconnect_notified = 0 WHERE instance_id = ? AND run_id = ?"),
    disableRun: db.prepare("UPDATE connector_runs SET online = 0, state = 'offline', disconnected_at = NULL, disconnect_notified = 0 WHERE instance_id = ? AND run_id = ?"),
    setGapOpen: db.prepare("UPDATE connector_runs SET gap_open = ? WHERE instance_id = ? AND run_id = ?"),
    timedOutRuns: db.prepare(`
      SELECT r.instance_id, r.run_id, r.disconnected_at
      FROM connector_runs r JOIN connector_instances i ON i.instance_id = r.instance_id
      WHERE r.app_run_id = ? AND r.online = 0 AND r.state = 'reconnecting'
        AND r.disconnected_at IS NOT NULL AND r.disconnect_notified = 0 AND i.disabled = 0
    `),
    agent: db.prepare("SELECT * FROM connector_agents WHERE instance_id = ? AND run_id = ? AND agent_id = ?"),
    agents: db.prepare("SELECT * FROM connector_agents WHERE instance_id = ? AND run_id = ? ORDER BY agent_id"),
    addAgent: db.prepare("INSERT INTO connector_agents (instance_id, run_id, agent_id, label, effective_state, last_known_state, raw_state, max_sequence, occurred_at, received_at, in_snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
    updateAgentFromSnapshot: db.prepare("UPDATE connector_agents SET effective_state = ?, last_known_state = ?, raw_state = ?, max_sequence = ?, occurred_at = ?, received_at = ?, in_snapshot = 1, label = COALESCE(?, label) WHERE instance_id = ? AND run_id = ? AND agent_id = ?"),
    updateAgentFromEvent: db.prepare("UPDATE connector_agents SET effective_state = ?, last_known_state = ?, raw_state = ?, max_sequence = ?, occurred_at = ?, received_at = ? WHERE instance_id = ? AND run_id = ? AND agent_id = ?"),
    touchSnapshotAgent: db.prepare("UPDATE connector_agents SET in_snapshot = 1, label = COALESCE(?, label) WHERE instance_id = ? AND run_id = ? AND agent_id = ?"),
    missAgent: db.prepare("UPDATE connector_agents SET effective_state = 'unknown', in_snapshot = 0 WHERE instance_id = ? AND run_id = ? AND agent_id = ?"),
    agentsUnknown: db.prepare("UPDATE connector_agents SET effective_state = 'unknown' WHERE instance_id = ? AND run_id = ?"),
    addEvent: db.prepare(`
      INSERT INTO connector_events (
        app_run_id, instance_id, run_id, agent_id, kind, state, raw_state, sequence,
        source_event_id, priority, historical, reconciled, gapped, notification_status,
        linked_event_id, occurred_at, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    eventBySource: db.prepare("SELECT * FROM connector_events WHERE instance_id = ? AND run_id = ? AND source_event_id = ?"),
    onlineEvent: db.prepare("SELECT id FROM connector_events WHERE app_run_id = ? AND instance_id = ? AND run_id = ? AND kind = 'online'"),
    offlineEvent: db.prepare("SELECT id FROM connector_events WHERE app_run_id = ? AND instance_id = ? AND run_id = ? AND kind = 'offline'"),
    episode: db.prepare(`
      SELECT * FROM connector_events
      WHERE instance_id = ? AND run_id = ? AND agent_id = ? AND sequence = ? AND state = ?
        AND kind IN ('baseline', 'agent_change', 'reconciled')
      ORDER BY id ASC LIMIT 1
    `),
    setEventSource: db.prepare("UPDATE connector_events SET source_event_id = ? WHERE id = ?"),
    /* 断联期间留下的历史通知被新快照确认成为当前：升级同一条，不新增提示。 */
    promoteEpisode: db.prepare(`
      UPDATE connector_events
      SET historical = 0, reconciled = 1, gapped = 1, priority = ?
      WHERE id = ? AND historical = 1 AND notification_status = 'pending'
    `),
    events: db.prepare(`
      SELECT * FROM connector_events
      WHERE id > ? AND (? IS NULL OR instance_id = ?) AND (? IS NULL OR run_id = ?)
      ORDER BY id ASC LIMIT ?
    `),
    pending: db.prepare("SELECT * FROM connector_events WHERE notification_status = 'pending' ORDER BY id ASC LIMIT ?"),
    markPresented: db.prepare("UPDATE connector_events SET notification_status = 'presented' WHERE id = ? AND notification_status = 'pending'"),
  };

  function tx(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function addEvent(event) {
    return q.addEvent.run(
      appRunId, event.instanceId, event.runId ?? null, event.agentId ?? null, event.kind,
      event.state ?? null, event.rawState ?? null, event.sequence ?? null, event.sourceEventId ?? null,
      event.priority ?? null, event.historical ? 1 : 0, event.reconciled ? 1 : 0, event.gapped ? 1 : 0,
      event.notificationStatus ?? "none", event.linkedEventId ?? null,
      event.occurredAt ?? null, event.receivedAt,
    ).lastInsertRowid;
  }

  function rowToEvent(row) {
    return {
      id: row.id, appRunId: row.app_run_id, instanceId: row.instance_id, runId: row.run_id,
      agentId: row.agent_id, kind: row.kind, state: row.state, rawState: row.raw_state,
      sequence: row.sequence, eventId: row.source_event_id, priority: row.priority,
      historical: row.historical === 1, reconciled: row.reconciled === 1,
      gapped: row.gapped === 1, notificationStatus: row.notification_status,
      linkedEventId: row.linked_event_id, occurredAt: row.occurred_at,
      receivedAt: row.received_at,
    };
  }

  return { q, tx, addEvent, rowToEvent };
}

module.exports = { createConnectorStore, AGENT_STATES };
