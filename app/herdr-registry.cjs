/* S05d 正式 Herdr 登记的只读消费者。
   只读取显式 registryDir 下的有限 JSON 文件；不递归用户目录、不写文件、不修改权限。
   读取结果只给端点事实，不宣告 online；是否在线由后续 transport ping/snapshot 确认。 */
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { AppError } = require("./errors.cjs");

const PLUGIN_ID = "bayper.herdr";
const SCHEMA_VERSION = 2;
const MAX_FILES = 100;
const MAX_BYTES = 64 * 1024;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function digest(...parts) {
  const hash = crypto.createHash("sha256");
  for (const part of parts) {
    hash.update(String(part));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function expectedInstance(namespaceId, socketPath) {
  return `inst-${digest(namespaceId, socketPath).slice(0, 32)}`;
}

function expectedRun(instanceId, socket, observedServerPid) {
  return `run-${digest(
    instanceId, socket.dev, socket.ino, socket.birthtimeMs, observedServerPid,
  ).slice(0, 32)}`;
}

function diagnostic(file, code, message) {
  return { file, code, message };
}

function endpointOf(record) {
  let stat;
  try {
    stat = fs.statSync(record.socket.path, { bigint: true });
  } catch {
    return "missing";
  }
  if (!stat.isSocket()) return "invalid";
  return stat.dev.toString() === record.socket.dev
    && stat.ino.toString() === record.socket.ino
    && stat.birthtimeMs.toString() === record.socket.birthtimeMs
    ? "matches"
    : "replaced";
}

function validateRecord(record, name) {
  if (!isObject(record)) return "记录必须是对象";
  if (record.schemaVersion !== SCHEMA_VERSION) return "不支持的 schemaVersion";
  if (record.pluginId !== PLUGIN_ID) return "pluginId 不是正式 Bayper 插件";
  for (const field of [
    "pluginId", "instanceId", "runId", "namespaceId", "firstRegisteredAt", "lastRegisteredAt",
  ]) {
    if (typeof record[field] !== "string" || record[field].length === 0) {
      return `${field} 无效`;
    }
  }
  if (!/^[0-9a-f-]{36}$/i.test(record.namespaceId)) return "namespaceId 无效";
  if (path.basename(name, ".json") !== record.instanceId) {
    return "文件名与 instanceId 不一致";
  }
  if (!isObject(record.socket)) return "socket 元数据缺失";
  if (typeof record.socket.path !== "string" || !path.isAbsolute(record.socket.path)) {
    return "socket.path 必须是绝对路径";
  }
  for (const field of ["dev", "ino", "birthtimeMs"]) {
    if (typeof record.socket[field] !== "string" || !/^\d+$/.test(record.socket[field])) {
      return `socket.${field} 必须是整数字符串`;
    }
  }
  if (!Number.isInteger(record.observedServerPid) || record.observedServerPid < 1) {
    return "observedServerPid 无效";
  }
  if (record.instanceId !== expectedInstance(record.namespaceId, record.socket.path)) {
    return "instanceId 与 namespace/socket 派生不一致";
  }
  if (record.runId !== expectedRun(record.instanceId, record.socket, record.observedServerPid)) {
    return "runId 与 instance/socket/pid 派生不一致";
  }
  return null;
}

function readHerdrRegistry({ registryDir } = {}) {
  if (typeof registryDir !== "string" || !path.isAbsolute(registryDir)) {
    throw new AppError("INVALID_INPUT", "registryDir 必须是绝对路径。");
  }
  let entries;
  try {
    entries = fs.readdirSync(registryDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return { found: false, registryDir, registrations: [], diagnostics: [] };
    }
    return {
      found: false,
      registryDir,
      registrations: [],
      diagnostics: [diagnostic(null, "DIRECTORY_UNREADABLE", "registryDir 不可读")],
    };
  }

  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
  const diagnostics = [];
  if (names.length > MAX_FILES) {
    diagnostics.push(diagnostic(null, "TOO_MANY_FILES", `只读取前 ${MAX_FILES} 个文件`));
  }
  const registrations = [];
  for (const name of names.slice(0, MAX_FILES)) {
    const file = path.join(registryDir, name);
    let record;
    try {
      const stat = fs.statSync(file);
      if (stat.size > MAX_BYTES) {
        diagnostics.push(diagnostic(name, "OVERSIZED", `文件超过 ${MAX_BYTES} 字节`));
        continue;
      }
      record = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      diagnostics.push(diagnostic(name, "FILE_UNREADABLE", "文件不可读或不是有效 JSON"));
      continue;
    }
    const invalid = validateRecord(record, name);
    if (invalid) {
      diagnostics.push(diagnostic(name, "INVALID_RECORD", invalid));
      continue;
    }
    const endpoint = endpointOf(record);
    registrations.push({
      ...record,
      endpoint,
      connectable: endpoint === "matches",
    });
  }
  return {
    found: true,
    registryDir,
    registrations,
    diagnostics,
    truncated: names.length > MAX_FILES,
  };
}

module.exports = {
  readHerdrRegistry,
  SCHEMA_VERSION,
  MAX_FILES,
  MAX_BYTES,
};
