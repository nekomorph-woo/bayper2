/* S05c 隔离身份 fixture：startup/action 只追加白名单观测后退出。
   不记录终端内容、selected_text、完整参数或 .env；只写 BAYPER_IDENTITY_ROOT 内。 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const PREFIXES = ["/tmp/bayper-herdr-identity-", "/private/tmp/bayper-herdr-identity-"];
const env = (name) => {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? null : value;
};

function realish(target) {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync(resolved);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
    } catch {
      return resolved;
    }
  }
}

function inside(root, target) {
  if (!target) return false;
  const base = realish(root);
  const value = realish(target);
  return value === base || value.startsWith(`${base}${path.sep}`);
}

function socketMeta(root, socketPath) {
  if (!inside(root, socketPath)) throw new Error("HERDR_SOCKET_PATH 不在隔离根内");
  const stat = fs.statSync(socketPath, { bigint: true });
  return {
    path: socketPath,
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    birthtime_ms: stat.birthtimeMs.toString(),
    ctime_ms: stat.ctimeMs.toString(),
  };
}

function contextMeta() {
  const raw = env("HERDR_PLUGIN_CONTEXT_JSON");
  if (!raw) return { keys: [], ids: {} };
  let context;
  try {
    context = JSON.parse(raw);
  } catch {
    return { keys: ["<invalid-json>"], ids: {} };
  }
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    return { keys: ["<invalid-shape>"], ids: {} };
  }
  return {
    keys: Object.keys(context).sort(),
    ids: {
      workspace_id: context.workspace_id ?? context.workspace?.workspace_id ?? null,
      tab_id: context.tab_id ?? context.tab?.tab_id ?? null,
      pane_id: context.pane_id ?? context.pane?.pane_id ?? context.focused_pane_id ?? null,
    },
  };
}

function parentMeta(ppid) {
  try {
    const output = execFileSync(
      "ps",
      ["-o", "pid=,ppid=,comm=,lstart=", "-p", String(ppid)],
      { encoding: "utf8", timeout: 2000 },
    ).trim();
    const match = output.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    return match
      ? { pid: Number(match[1]), ppid: Number(match[2]), comm: match[3], lstart: match[4] }
      : { raw: output };
  } catch {
    return null;
  }
}

function main() {
  const rawRoot = env("BAYPER_IDENTITY_ROOT");
  if (!rawRoot || !fs.existsSync(rawRoot)) throw new Error("缺少 BAYPER_IDENTITY_ROOT");
  const root = fs.realpathSync(rawRoot);
  if (!fs.statSync(root).isDirectory() || !PREFIXES.some(
    (prefix) => root.startsWith(prefix) && root.length > prefix.length,
  )) {
    throw new Error("BAYPER_IDENTITY_ROOT 不在允许的隔离前缀内");
  }
  const recordPath = env("BAYPER_IDENTITY_RECORD_PATH");
  if (!inside(root, recordPath)) throw new Error("记录路径不在隔离根内");
  const record = {
    kind: process.argv[2] || "unknown",
    event: env("HERDR_PLUGIN_EVENT"),
    action_id: env("HERDR_PLUGIN_ACTION_ID"),
    plugin_id: env("HERDR_PLUGIN_ID"),
    plugin_root: env("HERDR_PLUGIN_ROOT"),
    config_dir: env("HERDR_PLUGIN_CONFIG_DIR"),
    state_dir: env("HERDR_PLUGIN_STATE_DIR"),
    bin_path: env("HERDR_BIN_PATH"),
    socket: socketMeta(root, env("HERDR_SOCKET_PATH")),
    workspace_id: env("HERDR_WORKSPACE_ID"),
    tab_id: env("HERDR_TAB_ID"),
    pane_id: env("HERDR_PANE_ID"),
    own_pid: process.pid,
    own_ppid: process.ppid,
    parent: parentMeta(process.ppid),
    context: contextMeta(),
    root,
    recorded_at: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.appendFileSync(recordPath, `${JSON.stringify(record)}\n`, "utf8");
}

try {
  main();
} catch (error) {
  process.stderr.write(`identity fixture refused: ${error.message}\n`);
  process.exitCode = 1;
}
