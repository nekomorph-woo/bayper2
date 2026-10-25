#!/usr/bin/env python3
"""Bayper × Herdr 0.9.5 隔离技术探针。

只连接 root/xdg/herdr/sessions/{a,b}/herdr.sock，不启动或停止 server。
请求、事件、检查追加写入 root/trace.jsonl，阶段结果追加写入 root/results.jsonl。
"""

import argparse, json, os, signal, socket, subprocess, sys, time, traceback
from datetime import datetime, timezone
from pathlib import Path

SPIKE_PREFIXES = ("/tmp/bayper-herdr-spike-", "/private/tmp/bayper-herdr-spike-")
SOURCE = "custom:bayper-research"
AGENT = "bayper-probe"
PLUGIN_ID = "bayper.research.lifecycle"
PLUGIN_DIR = Path(__file__).resolve().parent
MANIFEST = PLUGIN_DIR / "herdr-plugin.toml"
FIXTURE = PLUGIN_DIR / "fixture_hook.py"
REQUEST_TIMEOUT, POLL_INTERVAL = 3.0, 0.1
TRACE = None


def stamp():
    return datetime.now(timezone.utc).isoformat()


def log(stage, kind, **fields):
    record = {"kind": kind, "stage": stage, "monotonic": round(time.monotonic(), 6),
              "wall": stamp(), **fields}
    with open(TRACE, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")


def check(stage, name, ok, expected=None, observed=None, details=None):
    """失败立即抛错；expected 原样记录，不因失败改写。"""
    log(stage, "check", check=name, ok=ok, expected=expected, observed=observed, details=details)
    if not ok:
        raise AssertionError(f"{name}: 期望 {expected!r}，实际 {observed!r}")


def wait_until(poll, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if poll():
            return True
        time.sleep(POLL_INTERVAL)
    return None


def jsonl(path):
    if not path.exists():
        return []
    records = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return records


def startups(root):
    return sum("startup" in str(r.get("event", "")).lower()
               for r in jsonl(root / "plugin-events.jsonl"))


def heartbeats(root):
    return len(jsonl(root / "heartbeat.jsonl"))


def read_pid(path):
    try:
        value = int(path.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return None
    return value if value > 0 else None


def pid_alive(pid):
    if not pid:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def process_command(pid):
    try:
        result = subprocess.run(["ps", "-p", str(pid), "-o", "command="],
                                capture_output=True, text=True, timeout=3)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return result.stdout.strip() if result.returncode == 0 else None


def validate_root(raw):
    """root 必须是 /tmp 或 /private/tmp 下的 bayper-herdr-spike-* 目录。"""
    root = Path(raw).expanduser().resolve()
    text = str(root)
    if not any(text.startswith(p) and len(text) > len(p) for p in SPIKE_PREFIXES) or not root.is_dir():
        raise RuntimeError(f"拒绝使用隔离根目录之外的路径: {root}")
    return root


def socket_path(root, session):
    path = (root / "xdg" / "herdr" / "sessions" / session / "herdr.sock").resolve()
    if not path.is_relative_to(root):
        raise RuntimeError(f"socket 越出隔离根目录: {path}")
    return path


class Socket:
    """按行读取 JSON；普通请求每次新开连接，订阅复用同一连接和 buffer。"""

    def __init__(self, root, session, stage):
        self.path, self.session, self.stage = socket_path(root, session), session, stage
        self.buffer, self.sock, self.seq = b"", None, 0

    def _open(self):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(REQUEST_TIMEOUT)
        try:
            sock.connect(str(self.path))
        except OSError:
            sock.close()
            raise
        self.sock = sock

    def close(self):
        if self.sock is not None:
            self.sock.close()
            self.sock = None

    def _line(self, deadline):
        while b"\n" not in self.buffer:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("等待消息超时")
            self.sock.settimeout(remaining)
            chunk = self.sock.recv(65536)
            if not chunk:
                raise EOFError("连接关闭")
            self.buffer += chunk
        line, self.buffer = self.buffer.split(b"\n", 1)
        return json.loads(line.decode("utf-8"))

    def _send(self, method, params):
        self.seq += 1
        request_id = f"{self.stage}-{self.session}-{os.getpid()}-{self.seq}"
        payload = {"id": request_id, "method": method, "params": params or {}}
        log(self.stage, "request", session=self.session, id=request_id, method=method, params=params or {})
        self.sock.sendall((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
        return request_id

    def _reply(self, request_id, method, deadline):
        while True:
            message = self._line(deadline)
            if message.get("id") == request_id:
                log(self.stage, "reply", session=self.session, id=request_id, method=method, response=message)
                return message
            log(self.stage, "stray_message", session=self.session, message=message)

    def request_raw(self, method, params=None):
        self._open()
        try:
            request_id = self._send(method, params)
            return self._reply(request_id, method, time.monotonic() + REQUEST_TIMEOUT)
        finally:
            self.close()

    def request(self, method, params=None):
        message = self.request_raw(method, params)
        if "error" in message:
            raise RuntimeError(f"{method} 返回错误: {message['error']}")
        return message.get("result") or {}

    def subscribe(self, entries):
        self._open()
        try:
            request_id = self._send("events.subscribe", {"subscriptions": entries})
            return self._reply(request_id, "events.subscribe", time.monotonic() + REQUEST_TIMEOUT)
        except BaseException:
            self.close()
            raise

    def read_event(self, timeout):
        try:
            message = self._line(time.monotonic() + timeout)
        except TimeoutError:
            return None
        log(self.stage, "event", session=self.session, message=message)
        return message

    def expect_eof(self, timeout):
        deadline = time.monotonic() + timeout
        while True:
            try:
                message = self._line(deadline)
            except TimeoutError:
                return False
            except (EOFError, OSError):
                return True
            log(self.stage, "event", session=self.session, message=message)


def pane_state(client, pane_id):
    return (client.request("pane.get", {"pane_id": pane_id}).get("pane") or {}).get("agent_status")


def wait_state(client, pane_id, wanted, timeout=3.0):
    return wait_until(lambda: pane_state(client, pane_id) == wanted, timeout)


def report(client, pane_id, state):
    return client.request("pane.report_agent",
                          {"pane_id": pane_id, "source": SOURCE, "agent": AGENT, "state": state})


def prepare_session(root, stage, session):
    client = Socket(root, session, stage)
    workspaces = client.request("workspace.list").get("workspaces") or []
    check(stage, f"{session}_control_workspace", bool(workspaces), "至少一个 control workspace", workspaces)
    created = client.request("workspace.create",
                             {"label": f"bayper-research-{session}", "cwd": str(root), "focus": False})
    workspace, root_pane = created.get("workspace") or {}, created.get("root_pane") or {}
    check(stage, f"{session}_workspace_created",
          created.get("type") == "workspace_created"
          and bool(workspace.get("workspace_id") and root_pane.get("pane_id")),
          "workspace_created 且带 workspace/pane id", created)
    listing = client.request("workspace.list").get("workspaces") or []
    found = next((w for w in listing if w.get("workspace_id") == workspace["workspace_id"]), None)
    check(stage, f"{session}_workspace_non_focused",
          bool(found) and found.get("focused") is False, "存在且 focused=false", found)
    # 空闲 shell pane 上报 working 后会立即回落为 unknown；用受控前台 sleep 承载该状态。
    # sleep 仅作前台上报载体，不冒充真实 Agent。
    pane_id = root_pane["pane_id"]
    client.request("pane.send_text", {"pane_id": pane_id, "text": "sleep 180"})
    client.request("pane.send_keys", {"pane_id": pane_id, "keys": ["enter"]})
    time.sleep(0.2)
    return {"client": client, "control_id": workspaces[0]["workspace_id"],
            "workspace_id": workspace["workspace_id"], "pane_id": root_pane["pane_id"]}


def stage_inspect(root, stage):
    for session in ("a", "b"):
        path = socket_path(root, session)
        check(stage, f"{session}_socket_in_root",
              path.is_relative_to(root) and path.name == "herdr.sock", True, str(path))
    a, b = prepare_session(root, stage, "a"), prepare_session(root, stage, "b")
    report(a["client"], a["pane_id"], "working")
    report(b["client"], b["pane_id"], "blocked")
    check(stage, "a_working_observable", bool(wait_state(a["client"], a["pane_id"], "working")),
          "working", pane_state(a["client"], a["pane_id"]))
    check(stage, "b_blocked_observable", bool(wait_state(b["client"], b["pane_id"], "blocked")),
          "blocked", pane_state(b["client"], b["pane_id"]))

    agents_a = a["client"].request("agent.list").get("agents") or []
    agents_b = b["client"].request("agent.list").get("agents") or []
    own_a = next((x for x in agents_a if x.get("pane_id") == a["pane_id"]), None)
    own_b = next((x for x in agents_b if x.get("pane_id") == b["pane_id"]), None)
    terminal_a = own_a.get("terminal_id") if own_a else None
    terminal_b = own_b.get("terminal_id") if own_b else None
    terminals_a = {x.get("terminal_id") for x in agents_a if x.get("terminal_id") is not None}
    terminals_b = {x.get("terminal_id") for x in agents_b if x.get("terminal_id") is not None}
    # 多会话下 pane_id 允许重复，隔离应以 terminal_id 与各自状态判断。
    check(stage, "agent_lists_isolated",
          bool(own_a) and own_a.get("agent") == AGENT and own_a.get("agent_status") == "working"
          and bool(own_b) and own_b.get("agent") == AGENT and own_b.get("agent_status") == "blocked"
          and terminal_a is not None and terminal_b is not None and terminal_a != terminal_b
          and terminal_a not in terminals_b and terminal_b not in terminals_a,
          "a/b 各自包含 bayper-probe 且状态为 working/blocked，terminal_id 不同且互不出现于对方列表",
          {"a": own_a, "b": own_b,
           "a_terminals": sorted(terminals_a), "b_terminals": sorted(terminals_b)})
    log(stage, "pane_identity", a_pane=a["pane_id"], b_pane=b["pane_id"],
        pane_ids_a=sorted(x.get("pane_id") for x in agents_a if x.get("pane_id") is not None),
        pane_ids_b=sorted(x.get("pane_id") for x in agents_b if x.get("pane_id") is not None),
        a_terminal=terminal_a, b_terminal=terminal_b,
        terminals_a=sorted(terminals_a), terminals_b=sorted(terminals_b))

    report(a["client"], a["pane_id"], "idle")
    check(stage, "idle_projects_to_done", bool(wait_state(a["client"], a["pane_id"], "done")),
          "done", pane_state(a["client"], a["pane_id"]))
    first, second = pane_state(a["client"], a["pane_id"]), pane_state(a["client"], a["pane_id"])
    check(stage, "done_survives_repeated_read", first == second == "done",
          "两次读取仍为 done", {"first": first, "second": second})
    a["client"].request("pane.focus", {"pane_id": a["pane_id"]})
    check(stage, "focus_clears_done", bool(wait_state(a["client"], a["pane_id"], "idle")),
          "idle", pane_state(a["client"], a["pane_id"]))
    rejected = a["client"].request_raw("pane.report_agent",
                                       {"pane_id": a["pane_id"], "source": SOURCE, "agent": AGENT, "state": "done"})
    check(stage, "report_done_rejected", "error" in rejected, "error", rejected)

    entries = [{"type": "pane.agent_status_changed", "pane_id": a["pane_id"]}]
    subscription = Socket(root, "a", stage)
    reply = subscription.subscribe(entries)
    check(stage, "subscription_ack", "error" not in reply
          and (reply.get("result") or {}).get("type") == "subscription_started", "subscription_started", reply)
    sent_wall, sent_monotonic = stamp(), time.monotonic()
    report(a["client"], a["pane_id"], "blocked")
    event, deadline = None, time.monotonic() + 5.0
    while time.monotonic() < deadline:
        message = subscription.read_event(deadline - time.monotonic())
        data = (message or {}).get("data") or {}
        if (message and message.get("event") == "pane.agent_status_changed"
                and data.get("pane_id") == a["pane_id"] and data.get("agent_status") == "blocked"):
            event = message
            break
    check(stage, "blocked_event_for_same_pane", event is not None, "blocked 事件", event)
    log(stage, "event_timing", request_wall=sent_wall, request_monotonic=sent_monotonic,
        event_monotonic=time.monotonic(), elapsed_seconds=round(time.monotonic() - sent_monotonic, 3))
    subscription.close()

    quiet = Socket(root, "a", stage)
    reply = quiet.subscribe(entries)
    check(stage, "replay_subscription_ack", "error" not in reply
          and (reply.get("result") or {}).get("type") == "subscription_started", "subscription_started", reply)
    historical = quiet.read_event(0.5)
    check(stage, "no_historical_event_replay", historical is None, "0.5 秒内无事件", historical)
    quiet.close()

    mixed = Socket(root, "a", stage)
    reply = mixed.subscribe(entries + [{"type": "pane.agent_status_changed", "pane_id": "pane-invalid-bayper"}])
    check(stage, "mixed_subscription_error", "error" in reply, "error", reply)
    mixed_eof = mixed.expect_eof(3.0)
    check(stage, "mixed_subscription_eof", mixed_eof, True, mixed_eof)
    mixed.close()

    check(stage, "plugin_manifest_exists", MANIFEST.is_file(), True, str(MANIFEST))
    check(stage, "startup_absent_before_link", startups(root) == 0, 0, startups(root))
    linked = a["client"].request("plugin.link", {"path": str(PLUGIN_DIR), "enabled": True})
    check(stage, "plugin_linked", linked.get("type") == "plugin_linked", "plugin_linked", linked)
    time.sleep(0.5)
    check(stage, "startup_absent_after_link", startups(root) == 0, 0, startups(root))
    plugin_ids = {score: [p.get("plugin_id") for p in item["client"].request("plugin.list").get("plugins") or []]
                  for score, item in (("a", a), ("b", b))}
    check(stage, "plugin_visible_in_b", PLUGIN_ID in plugin_ids["b"], PLUGIN_ID, plugin_ids)
    disabled = a["client"].request("plugin.disable", {"plugin_id": PLUGIN_ID})
    check(stage, "plugin_disabled", disabled.get("type") == "plugin_disabled", "plugin_disabled", disabled)
    time.sleep(0.5)
    check(stage, "startup_absent_after_disable", startups(root) == 0, 0, startups(root))
    enabled = a["client"].request("plugin.enable", {"plugin_id": PLUGIN_ID})
    check(stage, "plugin_enabled", enabled.get("type") == "plugin_enabled", "plugin_enabled", enabled)
    time.sleep(0.5)
    check(stage, "startup_absent_after_enable", startups(root) == 0, 0, startups(root))
    reloaded = a["client"].request("server.reload_config")
    check(stage, "config_reloaded", reloaded.get("type") == "config_reload", "config_reload", reloaded)
    time.sleep(0.5)
    check(stage, "startup_absent_after_reload", startups(root) == 0, 0, startups(root))

    context = {session: {"pane_id": item["pane_id"], "workspace_id": item["workspace_id"],
                         "control_workspace_id": item["control_id"]}
               for session, item in (("a", a), ("b", b))}
    (root / "context.json").write_text(json.dumps(context, ensure_ascii=False, indent=2) + "\n",
                                       encoding="utf-8")
    log(stage, "context_written", context=context)


def stage_watch(root, stage):
    context = json.loads((root / "context.json").read_text(encoding="utf-8"))
    client = Socket(root, "a", stage)
    reply = client.subscribe([{"type": "pane.agent_status_changed", "pane_id": context["a"]["pane_id"]}])
    check(stage, "watch_subscription_ack", "error" not in reply
          and (reply.get("result") or {}).get("type") == "subscription_started", "subscription_started", reply)
    print("READY", flush=True)
    watch_eof = client.expect_eof(30.0)
    check(stage, "watch_eof", watch_eof, True, watch_eof)
    client.close()


def stage_lifecycle(root, stage):
    check(stage, "startup_after_restart", startups(root) > 0, ">=1", startups(root))
    client, pid_path = Socket(root, "a", stage), root / "heartbeat.pid"
    before = heartbeats(root)
    actions = client.request("plugin.action.list", {"plugin_id": PLUGIN_ID}).get("actions") or []
    action = next((x for x in actions if x.get("action_id") in ("bayper.research.lifecycle.spawn", "spawn")), None)
    check(stage, "spawn_action_present", action is not None, "spawn action", actions)
    invoked = client.request("plugin.action.invoke",
                             {"plugin_id": PLUGIN_ID, "action_id": action["action_id"]})
    check(stage, "spawn_action_invoked", invoked.get("type") == "plugin_action_invoked",
          "plugin_action_invoked", invoked)
    log(stage, "spawn_action_log", log=invoked.get("log"))
    wait_until(lambda: read_pid(pid_path) is not None, 5.0)
    pid = read_pid(pid_path)
    check(stage, "heartbeat_pid_written", pid is not None, "heartbeat.pid", pid)
    check(stage, "heartbeat_process_alive", pid_alive(pid), True, pid_alive(pid))
    check(stage, "heartbeat_growing_after_spawn", bool(wait_until(lambda: heartbeats(root) > before, 5.0)),
          f"heartbeat 行数 > {before}", heartbeats(root))
    count = heartbeats(root)
    disabled = client.request("plugin.disable", {"plugin_id": PLUGIN_ID})
    check(stage, "plugin_disabled", disabled.get("type") == "plugin_disabled", "plugin_disabled", disabled)
    check(stage, "heartbeat_growing_after_disable", bool(wait_until(lambda: heartbeats(root) > count, 3.0)),
          f"heartbeat 行数 > {count}", heartbeats(root))
    check(stage, "heartbeat_alive_after_disable", pid_alive(pid), True, pid_alive(pid))
    count = heartbeats(root)
    unlinked = client.request("plugin.unlink", {"plugin_id": PLUGIN_ID})
    check(stage, "plugin_unlinked",
          unlinked.get("type") == "plugin_unlinked" and unlinked.get("removed") is True,
          "plugin_unlinked removed=true", unlinked)
    check(stage, "heartbeat_growing_after_unlink", bool(wait_until(lambda: heartbeats(root) > count, 3.0)),
          f"heartbeat 行数 > {count}", heartbeats(root))
    check(stage, "heartbeat_alive_after_unlink", pid_alive(pid), True, pid_alive(pid))
    log(stage, "heartbeat_surviving_pid", pid=pid)


def stage_cleanup(root, stage):
    pid_path = root / "heartbeat.pid"
    pid, before = read_pid(pid_path), heartbeats(root)
    time.sleep(0.6)
    after = heartbeats(root)
    log(stage, "cleanup_before", pid=pid, alive=pid_alive(pid),
        heartbeat_before=before, heartbeat_after=after, growing=after > before)
    if pid is None:
        print(json.dumps({"pid": None, "result": "pid 文件不存在，视为正常"}, ensure_ascii=False))
        return
    command = process_command(pid)
    check(stage, "cleanup_pid_is_fixture", bool(command and str(FIXTURE) in command and "heartbeat" in command),
          "命令行含 fixture 绝对路径和 heartbeat", {"pid": pid, "command": command})
    if pid_alive(pid):
        os.kill(pid, signal.SIGTERM)
        if not wait_until(lambda: not pid_alive(pid), 3.0):
            os.kill(pid, signal.SIGKILL)
            wait_until(lambda: not pid_alive(pid), 3.0)
    check(stage, "cleanup_process_stopped", not pid_alive(pid), False, pid_alive(pid))
    count = heartbeats(root)
    time.sleep(0.5)
    check(stage, "cleanup_heartbeat_stopped", heartbeats(root) == count, count, heartbeats(root))
    print(json.dumps({"pid": pid, "alive": pid_alive(pid), "heartbeats": count}, ensure_ascii=False))


STAGES = {"inspect": stage_inspect, "watch": stage_watch,
          "lifecycle": stage_lifecycle, "cleanup": stage_cleanup}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Bayper Herdr 隔离实验探针")
    parser.add_argument("stage", choices=tuple(STAGES))
    parser.add_argument("--root", required=True)
    args = parser.parse_args(argv)
    try:
        root = validate_root(args.root)
    except RuntimeError as exc:
        print(f"探针拒绝运行: {exc}", file=sys.stderr)
        return 2
    global TRACE
    TRACE = root / "trace.jsonl"
    log(args.stage, "stage_start", root=str(root), argv=sys.argv)
    ok, error = True, None
    try:
        STAGES[args.stage](root, args.stage)
    except Exception as exc:
        ok = False
        error = {"type": type(exc).__name__, "message": str(exc), "traceback": traceback.format_exc()}
        print(f"{args.stage} 失败: {exc}", file=sys.stderr)
    finally:
        log(args.stage, "stage_end", ok=ok, error=error)
        with open(root / "results.jsonl", "a", encoding="utf-8") as handle:
            handle.write(json.dumps({"stage": args.stage, "ok": ok, "error": error,
                                     "finished_at": stamp()}, ensure_ascii=False) + "\n")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
