/* S04c 获准来源到角色初步记忆的最小闭环。
   一次 analyze 只处理一个已授权文件、只发一次模型请求；读取、预算、模型与
   记忆接口均由调用方显式注入。发布在同一 SQLite 事务内写记忆与已处理标识，
   授权撤销、资格失效、上下文版本变化或来源被删除时拒绝发布。
   本服务不扫描目录、不调度机会、不重试、不转发给其他角色，也不把结果写成
   用户亲口告诉角色的记忆。 */
const crypto = require("node:crypto");
const { AppError } = require("./errors.cjs");
const { requestChatCompletion } = require("./model.cjs");
const { buildMessages, parseModelFacts } = require("./source-analysis-protocol.cjs");
const { createSourceProvenance } = require("./source-provenance.cjs");

const PROCESSED_SCHEMA = `
  CREATE TABLE IF NOT EXISTS source_analysis_processed (
    character_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    processed_at INTEGER NOT NULL,
    PRIMARY KEY (character_id, source_id)
  );
`;

const MAX_VERIFY_REGIONS = 8;
const MAX_VERIFY_BYTES = 4 * 1024 * 1024;

const STALE_CODES = new Set([
  "PERMIT_INVALID",
  "PERMIT_REVOKED",
  "ANALYSIS_DISABLED",
  "GRANT_NOT_FOUND",
  "GRANT_NOT_ACTIVE",
  "GRANT_PATH_CHANGED",
  "PATH_UNAVAILABLE",
  "PATH_INACCESSIBLE",
  "NOT_ELIGIBLE",
  "STALE_CONTEXT",
  "SOURCE_EXCLUDED",
]);

const SKIP_PERMISSION_CODES = new Set([
  "PERMIT_INVALID",
  "PERMIT_REVOKED",
  "ANALYSIS_DISABLED",
  "GRANT_NOT_FOUND",
  "GRANT_NOT_ACTIVE",
]);

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function externalSourceId(readerSourceId) {
  return `external:${sha256(readerSourceId)}`;
}

function result(status, code, truncated = false) {
  const value = { status, created: 0, truncated: Boolean(truncated) };
  if (code) {
    value.code = code;
  }
  return value;
}

function requireDependencies(dependencies) {
  for (const [service, methods, label] of dependencies) {
    if (!service || methods.some((method) => typeof service[method] !== "function")) {
      throw new AppError("DEPENDENCY_REQUIRED", `来源分析需要${label}。`);
    }
  }
}

function requireInput(input) {
  if (
    typeof input?.requestId !== "string" ||
    input.requestId.trim() === "" ||
    typeof input.characterId !== "string" ||
    input.characterId.trim() === "" ||
    typeof input.directoryId !== "string" ||
    input.directoryId.trim() === "" ||
    typeof input.relativePath !== "string" ||
    input.relativePath === ""
  ) {
    throw new AppError("INVALID_INPUT", "来源分析参数不完整。");
  }
  return input;
}

function createSourceAnalysis({
  db,
  memory,
  permissions,
  reader,
  budget,
  getCredentials,
  isEligible,
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  if (!db || typeof db.exec !== "function" || typeof db.prepare !== "function") {
    throw new AppError("DEPENDENCY_REQUIRED", "来源分析需要显式传入 SQLite 连接。");
  }
  requireDependencies([
    [
      memory,
      ["applyExtractionBatch", "listExcludedSources", "getContextVersion", "isContextCurrent"],
      "记忆服务",
    ],
    [
      permissions,
      ["issueReadPermit", "releaseReadPermit", "validateReadPermit"],
      "权限服务",
    ],
    [reader, ["readSession", "fileKey", "verifyCheckpoint"], "会话读取器"],
    [budget, ["reserve", "beginAttempt", "finish", "cancel"], "自动发送预算"],
  ]);
  if (typeof getCredentials !== "function" || typeof isEligible !== "function") {
    throw new AppError("DEPENDENCY_REQUIRED", "来源分析需要凭证与资格接口。");
  }
  if (typeof fetchImpl !== "function") {
    throw new AppError("DEPENDENCY_REQUIRED", "来源分析需要可用的 fetch 实现。");
  }

  db.exec(PROCESSED_SCHEMA);
  const provenance = createSourceProvenance(db);
  const statements = {
    hasProcessed: db.prepare(`
      SELECT 1 AS present FROM source_analysis_processed
      WHERE character_id = ? AND source_id = ?
    `),
    insertProcessed: db.prepare(`
      INSERT OR IGNORE INTO source_analysis_processed (character_id, source_id, processed_at)
      VALUES (?, ?, ?)
    `),
  };

  function clockNow() {
    const value = typeof now === "function" ? now() : now;
    const ms = value instanceof Date ? value.getTime() : Math.trunc(Number(value));
    if (!Number.isFinite(ms)) {
      throw new AppError("INVALID_TIME", "时间必须是有效数字。");
    }
    return ms;
  }

  function excludedHashes(characterId) {
    return new Set(memory.listExcludedSources(characterId));
  }

  function hasExcluded(characterId, sourceIds) {
    const excluded = excludedHashes(characterId);
    return sourceIds.some((sourceId) => excluded.has(sha256(sourceId)));
  }

  /* 同一读取区段被多个来源共享时只校验一次；超过 8 段或 4MiB 时明确拒绝，
     不把未核实的历史当作安全。 */
  function protectedRegions(characterId, fileKey, excluded) {
    const rows = provenance.listProtected(characterId, fileKey, excluded);
    const seen = new Set();
    const checkpoints = [];
    let totalBytes = 0;
    for (const row of rows) {
      const key = [
        row.fileKey,
        row.bodyStart,
        row.byteLength,
        row.regionSha256,
        row.dev,
        row.ino,
        row.snapshotBytes,
      ].join("|");
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      if (
        checkpoints.length >= MAX_VERIFY_REGIONS ||
        totalBytes + row.byteLength > MAX_VERIFY_BYTES
      ) {
        return { limit: true, checkpoints: [] };
      }
      checkpoints.push(row);
      totalBytes += row.byteLength;
    }
    return { limit: false, checkpoints };
  }

  async function eligibleNow(characterId) {
    try {
      return (await isEligible(characterId)) === true;
    } catch {
      return false;
    }
  }

  /* 资格、许可、上下文版本与来源排除在发送前和发布前都要复核；
     返回 null 表示仍可继续，否则返回 stale 错误码。 */
  async function recheck(characterId, permit, contextVersion, sourceIds) {
    if (!(await eligibleNow(characterId))) {
      return "NOT_ELIGIBLE";
    }
    permissions.validateReadPermit(permit);
    if (!memory.isContextCurrent(characterId, contextVersion)) {
      return "STALE_CONTEXT";
    }
    if (hasExcluded(characterId, sourceIds)) {
      return "SOURCE_EXCLUDED";
    }
    return null;
  }

  /* 已处理与被删除来源在组装请求前排除；助手消息只作为上下文保留，
     不代表用户的偏好或经历。 */
  function prepareMessages(characterId, read) {
    const excluded = excludedHashes(characterId);
    const sources = [];
    const userTextById = new Map();
    const includedUserIds = [];
    let hadUser = false;

    for (const message of read.messages) {
      if (
        !message ||
        typeof message.sourceId !== "string" ||
        typeof message.text !== "string" ||
        (message.role !== "user" && message.role !== "assistant")
      ) {
        continue;
      }
      if (message.role === "user") {
        hadUser = true;
      }
      const sourceId = externalSourceId(message.sourceId);
      if (excluded.has(sha256(sourceId))) {
        continue;
      }
      if (message.role === "assistant") {
        sources.push({
          sourceId,
          role: "assistant",
          timestamp: message.timestamp ?? null,
          text: message.text,
        });
        continue;
      }
      if (statements.hasProcessed.get(characterId, sourceId)) {
        continue;
      }
      sources.push({
        sourceId,
        role: "user",
        timestamp: message.timestamp ?? null,
        text: message.text,
      });
      userTextById.set(sourceId, message.text);
      includedUserIds.push(sourceId);
    }
    return { sources, userTextById, includedUserIds, hadUser };
  }

  function mapError(error, truncated) {
    const code = typeof error?.code === "string" ? error.code : "ANALYSIS_FAILED";
    return {
      status: STALE_CODES.has(code) ? "stale" : "failed",
      code,
      created: 0,
      truncated: Boolean(truncated),
    };
  }

  /* 一次发布事务：重核上下文、来源排除与许可，按来源分组写记忆，
     最后写无正文的已处理标识与读取区段映射；任一步失败都回滚。 */
  function publish({
    characterId,
    permit,
    contextVersion,
    includedUserIds,
    facts,
    checkpoint,
    publishedAt,
  }) {
    const groups = new Map();
    for (const fact of facts) {
      if (!groups.has(fact.sourceId)) {
        groups.set(fact.sourceId, []);
      }
      groups.get(fact.sourceId).push(fact);
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      if (!memory.isContextCurrent(characterId, contextVersion)) {
        throw new AppError("STALE_CONTEXT", "角色上下文已变化。");
      }
      if (hasExcluded(characterId, includedUserIds)) {
        throw new AppError("SOURCE_EXCLUDED", "来源已被删除或纠正。");
      }
      permissions.validateReadPermit(permit);

      let created = 0;
      for (const [sourceId, group] of groups) {
        const applied = memory.applyExtractionBatch({
          characterId,
          sourceId,
          sourceVersion: 1,
          appliedAt: publishedAt,
          createdAt: publishedAt,
          inTransaction: true,
          facts: group.map((fact) => ({
            factKey: fact.factKey,
            body: fact.body,
            kind: fact.kind,
            trust: "inferred",
          })),
        });
        if (!applied.applied) {
          if (applied.reason === "duplicate_batch") {
            continue;
          }
          throw new AppError(
            applied.reason === "blocked_source" ? "SOURCE_EXCLUDED" : "STALE_CONTEXT",
            "来源或角色上下文已变化，本次结果未写入。",
          );
        }
        created += applied.facts.filter((item) => item.created).length;
      }
      for (const sourceId of includedUserIds) {
        statements.insertProcessed.run(characterId, sourceId, publishedAt);
      }
      provenance.save(characterId, includedUserIds, checkpoint, publishedAt);
      db.exec("COMMIT");
      return created;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // 回滚失败不覆盖原始业务错误。
      }
      if (error instanceof AppError && STALE_CODES.has(error.code)) {
        throw error;
      }
      throw new AppError("PUBLISH_FAILED", "来源分析结果未能写入记忆。");
    }
  }

  let active = null;
  let disposed = false;

  async function run(input, current, lifecycle) {
    let truncated = false;
    let permit = null;
    let reservation = null;
    let sent = false;
    let budgetOutcome = null;

    try {
      const { requestId, characterId, directoryId, relativePath } = requireInput(input);

      if (!(await eligibleNow(characterId))) {
        return result("skipped", "NOT_ELIGIBLE");
      }
      if (current.cancelled || disposed) {
        return result("cancelled", "CANCELLED");
      }

      try {
        permit = permissions.issueReadPermit(directoryId);
      } catch (error) {
        const code = typeof error?.code === "string" ? error.code : "PERMIT_DENIED";
        return result(SKIP_PERMISSION_CODES.has(code) ? "skipped" : "failed", code);
      }

      // 先核对本文件受保护的历史读取区段，再读取当前 tail/组装请求。
      let identity;
      try {
        identity = reader.fileKey(permit, relativePath);
      } catch (error) {
        return mapError(error, truncated);
      }
      const protectedHistory = protectedRegions(
        characterId,
        identity.fileKey,
        excludedHashes(characterId),
      );
      if (protectedHistory.limit) {
        return result("skipped", "SOURCE_VERIFICATION_LIMIT");
      }
      for (const checkpoint of protectedHistory.checkpoints) {
        let verification;
        try {
          verification = reader.verifyCheckpoint(permit, relativePath, checkpoint);
        } catch (error) {
          return result(
            "skipped",
            typeof error?.code === "string" ? error.code : "SOURCE_VERIFICATION_FAILED",
          );
        }
        if (!verification || verification.verified !== true) {
          return result("skipped", "SOURCE_HISTORY_CHANGED");
        }
      }
      if (current.cancelled || disposed) {
        return result("cancelled", "CANCELLED");
      }

      let read;
      try {
        read = reader.readSession(permit, relativePath);
      } catch (error) {
        return mapError(error, truncated);
      }
      if (!read || !Array.isArray(read.messages) || !read.checkpoint) {
        return result("failed", "INVALID_READER_RESULT");
      }
      truncated = Boolean(read.truncated);

      const prepared = prepareMessages(characterId, read);
      if (prepared.includedUserIds.length === 0) {
        return result(
          "skipped",
          prepared.hadUser ? "NO_NEW_TEXT" : "NO_USER_TEXT",
          truncated,
        );
      }

      const contextVersion = memory.getContextVersion(characterId);
      if (current.cancelled || disposed) {
        return result("cancelled", "CANCELLED", truncated);
      }

      const reserved = budget.reserve({ requestId, characterId });
      if (!reserved.reserved) {
        return result("skipped", reserved.reason ?? "BUDGET_DENIED", truncated);
      }
      reservation = reserved;

      let credentials = null;
      try {
        credentials = await getCredentials();
      } catch {
        credentials = null;
      }
      if (current.cancelled || disposed) {
        return result("cancelled", "CANCELLED", truncated);
      }
      if (!credentials) {
        return result("failed", "CREDENTIALS_UNAVAILABLE", truncated);
      }

      const preflight = await recheck(
        characterId,
        permit,
        contextVersion,
        prepared.includedUserIds,
      );
      if (current.cancelled || disposed) {
        return result("cancelled", "CANCELLED", truncated);
      }
      if (preflight) {
        return result("stale", preflight, truncated);
      }

      const messages = buildMessages(prepared.sources);
      const wrappedFetch = async (url, options) => {
        if (current.cancelled || disposed) {
          throw new AppError("CANCELLED", "分析已取消。");
        }
        const stale = await recheck(
          characterId,
          permit,
          contextVersion,
          prepared.includedUserIds,
        );
        if (current.cancelled || disposed) {
          throw new AppError("CANCELLED", "分析已取消。");
        }
        if (stale) {
          throw new AppError(stale, "来源分析状态已变化。");
        }
        const begin = budget.beginAttempt(reservation.token);
        if (!begin.canSend) {
          throw new AppError("BUDGET_DENIED", "自动发送预算未获许可。");
        }
        sent = true;
        return fetchImpl(url, options);
      };

      let response;
      try {
        response = await requestChatCompletion(
          {
            baseUrl: credentials.baseUrl,
            modelName: credentials.modelName,
            apiKey: credentials.apiKey,
            messages,
            maxTokens: 2048,
            temperature: 0.2,
            signal: current.controller.signal,
          },
          wrappedFetch,
        );
        budgetOutcome = "success";
      } catch (error) {
        if (current.cancelled || disposed) {
          return result("cancelled", "CANCELLED", truncated);
        }
        if (sent) {
          budgetOutcome = error?.code === "TIMEOUT" ? "timeout" : "failed";
        }
        return mapError(error, truncated);
      }

      if (current.cancelled || disposed) {
        return result("cancelled", "CANCELLED", truncated);
      }
      const postflight = await recheck(
        characterId,
        permit,
        contextVersion,
        prepared.includedUserIds,
      );
      if (current.cancelled || disposed) {
        return result("cancelled", "CANCELLED", truncated);
      }
      if (postflight) {
        return result("stale", postflight, truncated);
      }

      // 在途响应返回后再次核验本次读取区段；改写则拒绝过时提炼。
      let currentVerification;
      try {
        currentVerification = reader.verifyCheckpoint(
          permit,
          relativePath,
          read.checkpoint,
        );
      } catch (error) {
        return mapError(error, truncated);
      }
      if (!currentVerification || currentVerification.verified !== true) {
        return result("stale", "SOURCE_HISTORY_CHANGED", truncated);
      }

      let facts;
      try {
        facts = parseModelFacts(response.content, prepared.userTextById);
      } catch (error) {
        return mapError(error, truncated);
      }

      const publishedAt = clockNow();
      let created;
      try {
        created = publish({
          characterId,
          permit,
          contextVersion,
          includedUserIds: prepared.includedUserIds,
          facts,
          checkpoint: read.checkpoint,
          publishedAt,
        });
      } catch (error) {
        return mapError(error, truncated);
      }
      return { status: "completed", created, truncated };
    } catch (error) {
      return mapError(error, truncated);
    } finally {
      if (reservation) {
        try {
          if (sent) {
            if (current.cancelled || disposed) {
              budget.cancel(reservation.token);
            } else {
              budget.finish(reservation.token, budgetOutcome ?? "failed");
            }
          } else {
            budget.cancel(reservation.token);
          }
        } catch (error) {
          // 不吞掉预算收尾故障：保留真实结果并记录 cleanupError，
          // 再按本次精确 token 尝试本地恢复，绝不释放其他活跃占位。
          lifecycle.cleanupError = {
            code: typeof error?.code === "string" ? error.code : "BUDGET_CLEANUP_FAILED",
            message: "自动发送预算收尾失败。",
            recovered: false,
          };
          if (typeof budget.recover === "function") {
            try {
              const recovery = budget.recover(reservation.token);
              lifecycle.cleanupError.recovered = recovery?.recovered === true;
            } catch {
              // 故障仍在时保留待恢复记录，下一次预算写操作按精确 token 重试。
            }
          }
        }
      }
      if (permit) {
        try {
          permissions.releaseReadPermit(permit);
        } catch {
          // 释放失败不覆盖本次结果。
        }
      }
    }
  }

  async function analyze(input = {}) {
    if (disposed) {
      return result("skipped", "DISPOSED");
    }
    if (active) {
      return result("skipped", "BUSY");
    }
    const current = { cancelled: false, controller: new AbortController() };
    active = current;
    const lifecycle = { cleanupError: null };
    try {
      const output = await run(input, current, lifecycle);
      if (lifecycle.cleanupError) {
        output.cleanupError = lifecycle.cleanupError;
      }
      return output;
    } finally {
      if (active === current) {
        active = null;
      }
    }
  }

  function cancel() {
    if (!active) {
      return false;
    }
    active.cancelled = true;
    active.controller.abort();
    return true;
  }

  function dispose() {
    disposed = true;
    if (active) {
      active.cancelled = true;
      active.controller.abort();
    }
  }

  return { analyze, cancel, dispose };
}

module.exports = { createSourceAnalysis };
