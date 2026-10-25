/* Bayper Herdr 正式插件登记入口。
   只使用 Herdr 注入的 socket/state/config 环境与自身 ppid；短命运行，登记后退出。
   registryDir 必须由插件 config 目录中的 bayper.json 明确给出；不猜测其他用户目录。 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PLUGIN_ID = "bayper.herdr";
const SCHEMA_VERSION = 2;
const NAMESPACE_SCHEMA_VERSION = 1;
const NAMESPACE_FILE = "install.json";

function fail(message) {
  throw new Error(message);
}

function env(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) fail(`缺少 ${name}`);
  return value;
}

function readConfig(configDir) {
  const file = path.join(configDir, "bayper.json");
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    fail(`缺少插件配置 ${file}`);
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    fail("插件配置 bayper.json 不是有效 JSON");
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    fail("插件配置 bayper.json 必须是对象");
  }
  if (typeof config.registryDir !== "string" || !path.isAbsolute(config.registryDir)) {
    fail("插件配置必须提供绝对 registryDir");
  }
  return config;
}

function readNamespace(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    fail("安装 namespace 不可读");
  }
  let namespace;
  try {
    namespace = JSON.parse(raw);
  } catch {
    fail("安装 namespace 损坏，拒绝更换身份");
  }
  if (
    !namespace
    || typeof namespace !== "object"
    || namespace.schemaVersion !== NAMESPACE_SCHEMA_VERSION
    || typeof namespace.namespaceId !== "string"
    || !/^[0-9a-f-]{36}$/i.test(namespace.namespaceId)
  ) {
    fail("安装 namespace 损坏或 schema 不受支持，拒绝更换身份");
  }
  return namespace;
}

/* 原子独占创建：先在独占临时文件写完整内容，再 hard-link 到最终名。
   并发首次启动时只有一个 link 成功，其余读取同一完整文件。 */
function ensureNamespace(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(stateDir, NAMESPACE_FILE);
  if (fs.existsSync(file)) return readNamespace(file);
  const temp = path.join(
    stateDir,
    `.install-${process.pid}-${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  const namespace = { schemaVersion: NAMESPACE_SCHEMA_VERSION, namespaceId: crypto.randomUUID() };
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(namespace));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(temp, file);
  } catch (error) {
    if (error.code !== "EEXIST") fail(`安装 namespace 创建失败: ${error.code || "unknown"}`);
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {
      // 临时文件仅用于独占创建。
    }
  }
  return readNamespace(file);
}

function canonicalSocket(socketPath) {
  let stat;
  try {
    stat = fs.statSync(socketPath, { bigint: true });
  } catch {
    fail("HERDR_SOCKET_PATH 不存在");
  }
  if (!stat.isSocket()) fail("HERDR_SOCKET_PATH 不是 Unix socket");
  return { path: fs.realpathSync(socketPath), stat };
}

function digest(...parts) {
  const hash = crypto.createHash("sha256");
  for (const part of parts) {
    hash.update(String(part));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function readExistingRegistration(file, instanceId, runId) {
  try {
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      record
      && record.instanceId === instanceId
      && record.runId === runId
      && typeof record.firstRegisteredAt === "string"
    ) {
      return record.firstRegisteredAt;
    }
  } catch {
    // 损坏的旧文件由本次登记原子覆盖。
  }
  return null;
}

function writeRegistry(registryDir, record) {
  fs.mkdirSync(registryDir, { recursive: true, mode: 0o700 });
  const file = path.join(registryDir, `${record.instanceId}.json`);
  const existingFirst = readExistingRegistration(
    file, record.instanceId, record.runId,
  );
  if (existingFirst) record.firstRegisteredAt = existingFirst;
  const temp = path.join(
    registryDir,
    `.${record.instanceId}-${process.pid}-${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(record));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch {
      // 失败时只保留明确错误。
    }
    fail(`registry 写入失败: ${error.code || "unknown"}`);
  }
  return file;
}

function main() {
  const socketInput = env("HERDR_SOCKET_PATH");
  const stateDir = env("HERDR_PLUGIN_STATE_DIR");
  const configDir = env("HERDR_PLUGIN_CONFIG_DIR");
  const pluginId = PLUGIN_ID;
  const observedServerPid = process.ppid;
  if (!Number.isInteger(observedServerPid) || observedServerPid < 1) {
    fail("无法取得有效的 server 父 PID");
  }

  const config = readConfig(configDir);
  const namespace = ensureNamespace(stateDir);
  const socket = canonicalSocket(socketInput);
  const instanceId = `inst-${digest(namespace.namespaceId, socket.path).slice(0, 32)}`;
  const runId = `run-${digest(
    instanceId,
    socket.stat.dev,
    socket.stat.ino,
    socket.stat.birthtimeMs,
    observedServerPid,
  ).slice(0, 32)}`;
  const now = new Date().toISOString();
  const record = {
    schemaVersion: SCHEMA_VERSION,
    pluginId,
    instanceId,
    runId,
    namespaceId: namespace.namespaceId,
    socket: {
      path: socket.path,
      dev: socket.stat.dev.toString(),
      ino: socket.stat.ino.toString(),
      birthtimeMs: socket.stat.birthtimeMs.toString(),
    },
    observedServerPid,
    firstRegisteredAt: now,
    lastRegisteredAt: now,
  };
  const file = writeRegistry(config.registryDir, record);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    instanceId,
    runId,
    registry: file,
  })}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`bayper herdr registration failed: ${error.message}\n`);
  process.exitCode = 1;
}
