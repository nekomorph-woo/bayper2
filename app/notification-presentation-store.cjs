/* S05f 通知呈现的持久状态。
   只保存 presentation 代次、槽位、事件引用、回执/最短阅读时间和超期审计；
   通知事实仍由 connector_events 提供，不复制来源状态或 Agent 内容。 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS notification_presentations (
    presentation_id TEXT PRIMARY KEY,
    generation TEXT NOT NULL,
    channel TEXT NOT NULL CHECK (channel IN ('ordinary', 'urgent')),
    slot INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('offered', 'visible', 'closed')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    closed_at INTEGER,
    close_reason TEXT
  );
  CREATE INDEX IF NOT EXISTS notification_presentations_active
    ON notification_presentations (generation, state, channel, slot);
  CREATE TABLE IF NOT EXISTS notification_presentation_items (
    presentation_id TEXT NOT NULL REFERENCES notification_presentations(presentation_id),
    event_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    acknowledged_at INTEGER,
    hold_until INTEGER,
    PRIMARY KEY (presentation_id, event_id)
  );
  CREATE INDEX IF NOT EXISTS notification_presentation_items_event
    ON notification_presentation_items (event_id);
  CREATE TABLE IF NOT EXISTS notification_active_events (
    event_id INTEGER PRIMARY KEY,
    presentation_id TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS notification_active_events_presentation
    ON notification_active_events (presentation_id);
  CREATE TRIGGER IF NOT EXISTS notification_presentation_item_active
  AFTER INSERT ON notification_presentation_items
  BEGIN
    INSERT OR IGNORE INTO notification_active_events (event_id, presentation_id)
    VALUES (NEW.event_id, NEW.presentation_id);
  END;
  CREATE TRIGGER IF NOT EXISTS notification_presentation_deactivated
  AFTER UPDATE OF state ON notification_presentations
  WHEN NEW.state = 'closed'
  BEGIN
    DELETE FROM notification_active_events WHERE presentation_id = NEW.presentation_id;
  END;
  CREATE TABLE IF NOT EXISTS notification_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    due_at INTEGER,
    observed_at INTEGER NOT NULL,
    reason TEXT,
    presentation_id TEXT,
    UNIQUE (event_id, kind)
  );
`;

function createNotificationPresentationStore({ db }) {
  if (!db || typeof db.prepare !== "function") {
    throw new Error("通知呈现存储需要共享 SQLite 连接。");
  }
  db.exec(SCHEMA);
  const q = {
    insertPresentation: db.prepare(`
      INSERT INTO notification_presentations (
        presentation_id, generation, channel, slot, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'offered', ?, ?)
    `),
    presentation: db.prepare(
      "SELECT * FROM notification_presentations WHERE presentation_id = ?",
    ),
    activePresentations: db.prepare(`
      SELECT * FROM notification_presentations
      WHERE generation = ? AND state IN ('offered', 'visible')
      ORDER BY channel ASC, slot ASC, created_at ASC
    `),
    items: db.prepare(`
      SELECT * FROM notification_presentation_items
      WHERE presentation_id = ? ORDER BY position ASC
    `),
    insertItem: db.prepare(`
      INSERT INTO notification_presentation_items (
        presentation_id, event_id, position
      ) VALUES (?, ?, ?)
    `),
    maxPosition: db.prepare(`
      SELECT COALESCE(MAX(position), -1) AS position
      FROM notification_presentation_items WHERE presentation_id = ?
    `),
    acknowledgeItem: db.prepare(`
      UPDATE notification_presentation_items
      SET acknowledged_at = ?, hold_until = ?
      WHERE presentation_id = ? AND event_id = ? AND acknowledged_at IS NULL
    `),
    markVisible: db.prepare(`
      UPDATE notification_presentations
      SET state = 'visible', updated_at = ?
      WHERE presentation_id = ? AND generation = ? AND state = 'offered'
    `),
    closePresentation: db.prepare(`
      UPDATE notification_presentations
      SET state = 'closed', updated_at = ?, closed_at = ?, close_reason = ?
      WHERE presentation_id = ? AND state IN ('offered', 'visible')
    `),
    closeActive: db.prepare(`
      UPDATE notification_presentations
      SET state = 'closed', updated_at = ?, closed_at = ?, close_reason = ?
      WHERE generation = ? AND state IN ('offered', 'visible')
    `),
    closeAllOpen: db.prepare(`
      UPDATE notification_presentations
      SET state = 'closed', updated_at = ?, closed_at = ?, close_reason = ?
      WHERE state IN ('offered', 'visible')
    `),
    activeItemForEvent: db.prepare(`
      SELECT i.* FROM notification_presentation_items i
      JOIN notification_presentations p ON p.presentation_id = i.presentation_id
      WHERE p.generation = ? AND p.state IN ('offered', 'visible') AND i.event_id = ?
      ORDER BY i.presentation_id LIMIT 1
    `),
    audit: db.prepare(`
      INSERT OR IGNORE INTO notification_audit (
        event_id, kind, due_at, observed_at, reason, presentation_id
      ) VALUES (?, 'overdue', ?, ?, ?, ?)
    `),
    auditCount: db.prepare("SELECT COUNT(*) AS count FROM notification_audit WHERE kind = 'overdue'"),
    auditRows: db.prepare(
      "SELECT * FROM notification_audit WHERE kind = 'overdue' ORDER BY id ASC LIMIT ?",
    ),
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

  function item(row) {
    return {
      presentationId: row.presentation_id,
      eventId: row.event_id,
      position: row.position,
      acknowledgedAt: row.acknowledged_at,
      holdUntil: row.hold_until,
    };
  }

  function presentation(row) {
    return row ? {
      presentationId: row.presentation_id,
      generation: row.generation,
      channel: row.channel,
      slot: row.slot,
      state: row.state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      closedAt: row.closed_at,
      closeReason: row.close_reason,
    } : null;
  }

  return {
    q, tx, item, presentation,
    auditRow(row) {
      return {
        eventId: row.event_id,
        dueAt: row.due_at,
        observedAt: row.observed_at,
        reason: row.reason,
        presentationId: row.presentation_id,
      };
    },
  };
}

module.exports = { createNotificationPresentationStore };
