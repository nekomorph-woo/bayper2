/* S03b 聊天持久化。与记忆、陪伴共用 createStore 的同一条 SQLite 连接。
   只保存真实角色ID、消息、请求状态、上下文版本与来源；不保存提示词、Key 或模型原始响应。 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS chat_conversations (
    id TEXT PRIMARY KEY,
    character_id TEXT NOT NULL REFERENCES relationships(character_id),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    closed_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES chat_conversations(id),
    character_id TEXT NOT NULL REFERENCES relationships(character_id),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL CHECK (length(content) > 0),
    source_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    seq INTEGER
  );

  CREATE INDEX IF NOT EXISTS chat_messages_conversation
    ON chat_messages (conversation_id, created_at, id);

  CREATE TABLE IF NOT EXISTS chat_requests (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES chat_conversations(id),
    character_id TEXT NOT NULL REFERENCES relationships(character_id),
    user_message_id TEXT NOT NULL UNIQUE REFERENCES chat_messages(id),
    status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'cancelled', 'stale')),
    context_version INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    completed_at INTEGER,
    assistant_message_id TEXT REFERENCES chat_messages(id),
    error_code TEXT,
    memory_applied INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS chat_requests_conversation
    ON chat_requests (conversation_id, status, created_at);
`;

function mapConversation(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    characterId: row.character_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at ?? null,
  };
}

function mapMessage(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    conversationId: row.conversation_id,
    characterId: row.character_id,
    role: row.role,
    content: row.content,
    sourceId: row.source_id,
    createdAt: row.created_at,
    seq: row.seq ?? null,
  };
}

function mapRequest(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    conversationId: row.conversation_id,
    characterId: row.character_id,
    userMessageId: row.user_message_id,
    status: row.status,
    contextVersion: row.context_version,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? null,
    assistantMessageId: row.assistant_message_id ?? null,
    errorCode: row.error_code ?? null,
    memoryApplied: row.memory_applied,
  };
}

function createChatStore(db) {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  ensureMessageSeq(db);

  const statements = {
    isKnownCharacter: db.prepare("SELECT 1 AS found FROM relationships WHERE character_id = ?"),
    getNickname: db.prepare("SELECT nickname FROM relationships WHERE character_id = ?"),
    listKnownCharacters: db.prepare(
      "SELECT character_id, nickname FROM relationships ORDER BY character_id",
    ),
    insertConversation: db.prepare(`
      INSERT INTO chat_conversations (id, character_id, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `),
    getConversation: db.prepare("SELECT * FROM chat_conversations WHERE id = ?"),
    listConversations: db.prepare(`
      SELECT c.*,
        (SELECT m.content FROM chat_messages m
         WHERE m.conversation_id = c.id ORDER BY m.seq DESC, m.id DESC LIMIT 1) AS last_content,
        (SELECT m.created_at FROM chat_messages m
         WHERE m.conversation_id = c.id ORDER BY m.seq DESC, m.id DESC LIMIT 1) AS last_at
      FROM chat_conversations c
      WHERE c.character_id = ?
      ORDER BY c.updated_at DESC, c.created_at DESC, c.id DESC
      LIMIT ?
    `),
    closeConversation: db.prepare(
      "UPDATE chat_conversations SET closed_at = ?, updated_at = ? WHERE id = ?",
    ),
    touchConversation: db.prepare(
      "UPDATE chat_conversations SET updated_at = ? WHERE id = ?",
    ),
    insertMessage: db.prepare(`
      INSERT INTO chat_messages (
        id, conversation_id, character_id, role, content, source_id, created_at, seq
      ) VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM chat_messages))
    `),
    getMessage: db.prepare("SELECT * FROM chat_messages WHERE id = ?"),
    listMessages: db.prepare(`
      SELECT * FROM (
        SELECT * FROM chat_messages
        WHERE conversation_id = ? AND character_id = ?
        ORDER BY seq DESC, id DESC
        LIMIT ?
      )
      ORDER BY seq ASC, id ASC
    `),
    insertRequest: db.prepare(`
      INSERT INTO chat_requests (
        id, conversation_id, character_id, user_message_id, status,
        context_version, created_at, completed_at, assistant_message_id,
        error_code, memory_applied
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    getRequest: db.prepare("SELECT * FROM chat_requests WHERE id = ?"),
    updateRequest: db.prepare(`
      UPDATE chat_requests SET
        status = ?, completed_at = ?, assistant_message_id = ?,
        error_code = ?, memory_applied = ?
      WHERE id = ?
    `),
    prepareRetry: db.prepare(`
      UPDATE chat_requests SET
        status = 'pending', context_version = ?, completed_at = NULL,
        assistant_message_id = NULL, error_code = NULL, memory_applied = 0
      WHERE id = ?
    `),
    listPendingRequests: db.prepare(`
      SELECT * FROM chat_requests
      WHERE conversation_id = ? AND status = 'pending'
      ORDER BY created_at ASC, id ASC
    `),
    cancelAllPendingRequests: db.prepare(`
      UPDATE chat_requests SET
        status = 'cancelled', completed_at = ?, memory_applied = 0
      WHERE status = 'pending'
    `),
    recoverInterruptedRequests: db.prepare(`
      UPDATE chat_requests SET
        status = 'failed', completed_at = ?, error_code = 'INTERRUPTED', memory_applied = 0
      WHERE status = 'pending'
    `),
  };

  function transaction(fn) {
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

  function isKnownCharacter(characterId) {
    return Boolean(statements.isKnownCharacter.get(characterId));
  }

  function getNickname(characterId) {
    const nickname = statements.getNickname.get(characterId)?.nickname;
    return typeof nickname === "string" && nickname.trim() ? nickname.trim() : null;
  }

  /* 聊天转告只向模型提供已结识角色的稳定编号映射；昵称来自既有关系表。 */
  function listKnownCharacters() {
    return statements.listKnownCharacters.all().map((row) => ({
      characterId: row.character_id,
      nickname:
        typeof row.nickname === "string" && row.nickname.trim() ? row.nickname.trim() : null,
    }));
  }

  function createConversation({ id, characterId, createdAt }) {
    statements.insertConversation.run(id, characterId, createdAt, createdAt);
    return getConversation(id);
  }

  function getConversation(id) {
    return mapConversation(statements.getConversation.get(id));
  }

  function listConversations(characterId, limit) {
    return statements.listConversations.all(characterId, limit).map((row) => ({
      ...mapConversation(row),
      lastMessage: row.last_content ?? null,
      lastMessageAt: row.last_at ?? null,
    }));
  }

  function closeConversation(id, closedAt) {
    statements.closeConversation.run(closedAt, closedAt, id);
    return getConversation(id);
  }

  function insertMessage(message) {
    statements.insertMessage.run(
      message.id,
      message.conversationId,
      message.characterId,
      message.role,
      message.content,
      message.sourceId,
      message.createdAt,
    );
    statements.touchConversation.run(message.createdAt, message.conversationId);
    return getMessage(message.id);
  }

  function getMessage(id) {
    return mapMessage(statements.getMessage.get(id));
  }

  function listMessages(conversationId, characterId, limit) {
    return statements.listMessages.all(conversationId, characterId, limit).map(mapMessage);
  }

  function insertRequest(request) {
    statements.insertRequest.run(
      request.id,
      request.conversationId,
      request.characterId,
      request.userMessageId,
      request.status,
      request.contextVersion,
      request.createdAt,
      request.completedAt ?? null,
      request.assistantMessageId ?? null,
      request.errorCode ?? null,
      request.memoryApplied ?? 0,
    );
    return getRequest(request.id);
  }

  function getRequest(id) {
    return mapRequest(statements.getRequest.get(id));
  }

  function updateRequest(id, update) {
    statements.updateRequest.run(
      update.status,
      update.completedAt ?? null,
      update.assistantMessageId ?? null,
      update.errorCode ?? null,
      update.memoryApplied ?? 0,
      id,
    );
    return getRequest(id);
  }

  function prepareRetry(id, contextVersion) {
    statements.prepareRetry.run(contextVersion, id);
    return getRequest(id);
  }

  function listPendingRequests(conversationId) {
    return statements.listPendingRequests.all(conversationId).map(mapRequest);
  }

  function cancelAllPendingRequests(completedAt) {
    return statements.cancelAllPendingRequests.run(completedAt).changes;
  }

  function recoverInterruptedRequests(completedAt) {
    return statements.recoverInterruptedRequests.run(completedAt).changes;
  }

  return {
    isKnownCharacter,
    getNickname,
    listKnownCharacters,
    transaction,
    createConversation,
    getConversation,
    listConversations,
    closeConversation,
    insertMessage,
    getMessage,
    listMessages,
    insertRequest,
    getRequest,
    updateRequest,
    prepareRetry,
    listPendingRequests,
    cancelAllPendingRequests,
    recoverInterruptedRequests,
  };
}

module.exports = { createChatStore, SCHEMA };

function ensureMessageSeq(db) {
  const columns = db.prepare("PRAGMA table_info(chat_messages)").all();
  let added = false;
  if (!columns.some((column) => column.name === "seq")) {
    db.exec("ALTER TABLE chat_messages ADD COLUMN seq INTEGER");
    added = true;
  }
  // 仅首次补列时按 SQLite rowid（插入顺序）回填旧记录。
  if (added) {
    db.exec("UPDATE chat_messages SET seq = rowid WHERE seq IS NULL");
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS chat_messages_seq ON chat_messages (conversation_id, seq)",
  );
}
