#!/usr/bin/env python3
"""Bayper × Herdr 真实 GUI 生命周期研究 fixture。

只验证启动/停止机制，不是 Bayper 产品插件。ensure/start/stop 是短命入口：记录
Herdr 注入的环境后立即退出；daemon 用按 socket 区分的 flock 独占启动真实 Electron。
"""

import fcntl
import hashlib
import json
import os
import signal
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

PLUGIN_ID = "bayper.research.gui"
HERDR_PREFIXES = ("/tmp/bayper-herdr-spike-", "/private/tmp/bayper-herdr-spike-")
GUI_PREFIXES = ("/tmp/bayper-window-spike-", "/private/tmp/bayper-window-spike-")
POLL_SECONDS, REQUEST_TIMEOUT, MAX_LIFETIME, FAILURE_LIMIT = 1.0, 3.0, 600.0, 3
STOP_FLAG = False

def stamp():
    return datetime.now(timezone.utc).isoformat()

def evidence(root, event, **fields):
    record = {"at": stamp(), "event": event, **fields}
    with open(root / "gui-lifecycle.jsonl", "a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")

def require_env(name):
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"缺少环境变量 {name}")
    return value

def scoped_dir(name, prefixes):
    """强制隔离目录前缀，不接受用户现有配置或构建目录。"""
    path = Path(require_env(name)).expanduser().resolve()
    text = str(path)
    if not any(text.startswith(p) and len(text) > len(p) for p in prefixes) or not path.is_dir():
        raise SystemExit(f"拒绝使用隔离根目录之外的路径: {path}")
    return path

def session_paths():
    """解析隔离根、会话 socket 和状态目录，并按 socket 生成短 key。"""
    root = scoped_dir("BAYPER_RESEARCH_ROOT", HERDR_PREFIXES)
    socket_path = Path(require_env("HERDR_SOCKET_PATH")).expanduser().resolve()
    if not socket_path.is_relative_to(root) or socket_path.name != "herdr.sock":
        raise SystemExit(f"拒绝连接隔离根目录之外的 socket: {socket_path}")
    state = Path(require_env("HERDR_PLUGIN_STATE_DIR")).expanduser().resolve()
    if not state.is_relative_to(root):
        raise SystemExit(f"插件状态目录不在隔离根目录内: {state}")
    state.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha256(str(socket_path).encode("utf-8")).hexdigest()[:16]
    return root, socket_path, state, key

def plugin_state(socket_path):
    """请求一次 plugin.list；请求失败返回 None，成功返回 enabled/disabled/absent。"""
    payload = json.dumps({"id": "bayper-gui", "method": "plugin.list", "params": {}})
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(REQUEST_TIMEOUT)
    try:
        client.connect(str(socket_path))
        with client.makefile("r", encoding="utf-8") as reader:
            client.sendall((payload + "\n").encode("utf-8"))
            message = json.loads(reader.readline())
    except (OSError, ValueError):
        return None
    finally:
        client.close()
    if "error" in message:
        return None
    plugins = (message.get("result") or {}).get("plugins") or []
    found = next((item for item in plugins if item.get("plugin_id") == PLUGIN_ID), None)
    if found is None:
        return "absent"
    return "enabled" if found.get("enabled") else "disabled"

def entry(command):
    """ensure/start/stop 共用入口：记录注入环境，只有 ensure/start 拉起 daemon。"""
    root, socket_path, state, key = session_paths()
    stop_marker = state / f"stop-{key}"
    fields = {"command": command, "socket": str(socket_path), "key": key,
              "plugin_config_dir": os.environ.get("HERDR_PLUGIN_CONFIG_DIR"),
              "plugin_state_dir": str(state), "research_root": str(root),
              "plugin_event": os.environ.get("HERDR_PLUGIN_EVENT"), "entry_pid": os.getpid()}
    if command == "stop":
        stop_marker.write_text(stamp() + "\n", encoding="utf-8")
        evidence(root, "stop", **fields)
        return 0
    if command == "start":
        stop_marker.unlink(missing_ok=True)
    elif stop_marker.exists():
        evidence(root, "ensure_skipped", **fields)
        return 0
    evidence(root, command, **fields)
    subprocess.Popen([sys.executable or "python3", str(Path(__file__).resolve()), "daemon"],
                     env=os.environ.copy(), stdin=subprocess.DEVNULL,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     start_new_session=True)
    return 0

def daemon():
    global STOP_FLAG
    root, socket_path, state, key = session_paths()
    stop_marker = state / f"stop-{key}"
    common = {"key": key, "socket": str(socket_path), "daemon_pid": os.getpid()}
    # 锁由内核回收，不以 pid 文件存在代替排他锁；不同 socket 得到不同锁。
    lock = open(state / f"lock-{key}", "a+", encoding="utf-8")
    try:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        evidence(root, "daemon_lock_busy", **common)
        lock.close()
        return 0

    def request_stop(_signum, _frame):
        global STOP_FLAG
        STOP_FLAG = True

    # SIGKILL 无法捕获，若发生只能留下状态 JSON 和 GUI 进程供人工核对。
    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)

    build = scoped_dir("BAYPER_GUI_BUILD_ROOT", GUI_PREFIXES)
    executable = build / "deps/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
    app_dir = build / "source/electron"
    gui_root = build / f"life-{key}"
    gui, reason = None, "not_started"
    try:
        if not executable.is_file() or not app_dir.is_dir():
            evidence(root, "daemon_missing_runtime", executable=str(executable),
                     app_dir=str(app_dir), **common)
            return 1
        gui_root.mkdir(parents=True, exist_ok=True)
        (gui_root / "command.json").write_text('{"seq": 0}\n', encoding="utf-8")
        child_env = {**os.environ, "BAYPER_WINDOW_ROOT": str(gui_root), "BAYPER_PANEL": "1",
                     "BAYPER_OWNER_PID": str(os.getpid())}
        log_path = gui_root / "electron.log"
        with open(log_path, "ab") as log:
            gui = subprocess.Popen([str(executable), str(app_dir)], cwd=str(gui_root),
                                   env=child_env, stdin=subprocess.DEVNULL, stdout=log,
                                   stderr=subprocess.STDOUT, start_new_session=True)
        status = {"plugin_id": PLUGIN_ID, "socket": str(socket_path), "key": key,
                  "daemon_pid": os.getpid(), "gui_pid": gui.pid, "gui_root": str(gui_root),
                  "electron_log": str(log_path), "started_at": stamp()}
        (state / f"status-{key}.json").write_text(
            json.dumps(status, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        evidence(root, "daemon_started", gui_pid=gui.pid, gui_root=str(gui_root), **common)
        failures, deadline = 0, time.monotonic() + MAX_LIFETIME
        while not STOP_FLAG and time.monotonic() < deadline:
            if stop_marker.exists():
                reason = "stop_marker"
                break
            if gui.poll() is not None:
                reason = "gui_exited"
                break
            observed = plugin_state(socket_path)
            if observed is None:
                failures += 1
                if failures >= FAILURE_LIMIT:
                    reason = "request_failures"
                    break
            else:
                failures = 0
                if observed != "enabled":
                    reason = f"plugin_{observed}"
                    break
            time.sleep(POLL_SECONDS)
        else:
            reason = "signal" if STOP_FLAG else "max_lifetime"
    except Exception as exc:
        reason = f"error:{type(exc).__name__}"
        evidence(root, "daemon_error", error=str(exc), **common)
    finally:
        if gui is not None:
            if gui.poll() is None:
                gui.terminate()
                try:
                    gui.wait(timeout=5.0)
                except subprocess.TimeoutExpired:
                    gui.kill()
                    gui.wait(timeout=5.0)
            evidence(root, "daemon_exit", reason=reason, gui_exit=gui.poll(), **common)
        lock.close()
    return 0

def main():
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command in ("ensure", "start", "stop"):
        return entry(command)
    if command == "daemon":
        return daemon()
    raise SystemExit("用法: bridge.py ensure|start|stop|daemon")

if __name__ == "__main__":
    raise SystemExit(main())
