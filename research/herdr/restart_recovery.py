#!/usr/bin/env python3
"""Herdr REC-05：server 停止/重启后的 pane 与 AgentInfo 恢复。

脚本只建立订阅、写 ready 文件和做受控上报；server 停止与启动由外部执行。
"""

import argparse
import json
import sys
import time
import traceback

import probe
import recover_events

STAGE = "restart-recovery"
EVENT_TYPE = "pane.agent_status_changed"
EOF_WAIT, RECONNECT_WAIT, POLL, DRAIN_WAIT = 30.0, 30.0, 0.2, 2.0


def open_subscription(root, pane_id, label, opened):
    subscription = probe.Socket(root, "a", f"{STAGE}-{label}")
    opened.append(subscription)
    reply = subscription.subscribe([{"type": EVENT_TYPE, "pane_id": pane_id}])
    probe.check(STAGE, f"{label}_subscription_ack",
                "error" not in reply
                and (reply.get("result") or {}).get("type") == "subscription_started",
                "subscription_started", reply)
    return subscription, reply


def wait_eof(subscription):
    """普通读超时返回 None，不算断开；只把 EOFError/OSError 记为实际断连。"""
    deadline = time.monotonic() + EOF_WAIT
    while time.monotonic() < deadline:
        try:
            subscription.read_event(min(0.5, deadline - time.monotonic()))
        except (EOFError, OSError) as exc:
            return {"type": type(exc).__name__, "message": str(exc)}
    return None


def wait_pane(client, pane_id):
    """重启后重连 session.snapshot，保留整个匹配 pane 与快照 agents。"""
    deadline = time.monotonic() + RECONNECT_WAIT
    while time.monotonic() < deadline:
        try:
            snapshot = client.request("session.snapshot").get("snapshot") or {}
        except (EOFError, OSError):
            time.sleep(POLL)
            continue
        panes = [p for p in snapshot.get("panes") or [] if p.get("pane_id") == pane_id]
        if len(panes) == 1:
            return {"pane": panes[0], "agents": snapshot.get("agents") or []}
        time.sleep(POLL)
    raise RuntimeError(f"{RECONNECT_WAIT} 秒内未能连回并匹配 pane {pane_id}")


def run(root, result):
    prepared = probe.prepare_session(root, STAGE, "a")
    client, pane_id = prepared["client"], prepared["pane_id"]
    # 先上报 blocked，权威快照中才会出现该 pane 的 AgentInfo。
    old = recover_events.report_and_wait(client, pane_id, "blocked", "blocked", "old_blocked")
    result["old"] = {"pane_id": pane_id, "control_id": prepared["control_id"], "snapshot": old}
    opened = []
    fresh = probe.Socket(root, "a", STAGE)
    try:
        old_sub, old_ack = open_subscription(root, pane_id, "old", opened)
        result["old"]["ack"] = old_ack
        ready = {"pane_id": pane_id, "terminal_id": old["terminal_id"]}
        (root / "restart-ready.json").write_text(
            json.dumps(ready, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print("READY", flush=True)

        disconnect = wait_eof(old_sub)
        probe.check(STAGE, "old_subscription_disconnected", disconnect is not None,
                    "EOFError 或 OSError", disconnect)
        result["disconnect"] = disconnect

        after = wait_pane(fresh, pane_id)
        pane, agents = after["pane"], after["agents"]
        own = [a for a in agents if a.get("pane_id") == pane_id]
        new_terminal = pane.get("terminal_id")
        probe.check(STAGE, "terminal_replaced",
                    new_terminal is not None and new_terminal != old["terminal_id"],
                    f"terminal_id != {old['terminal_id']}", new_terminal)
        probe.check(STAGE, "pane_unknown_after_restart",
                    pane.get("agent_status") == "unknown", "unknown", pane.get("agent_status"))
        probe.check(STAGE, "no_stale_blocked_agent_info",
                    not any(a.get("agent_status") == "blocked" for a in own),
                    "agents 不含该 pane 的旧 blocked", own)
        result["new"] = after

        new_sub, new_ack = open_subscription(root, pane_id, "new", opened)
        result["new"]["ack"] = new_ack
        # 新订阅建立后重读权威快照仍应为 unknown；Agent 可能尚未恢复，不能用 current 假设。
        recheck = wait_pane(fresh, pane_id)
        probe.check(STAGE, "snapshot_still_unknown_after_subscribe",
                    recheck["pane"].get("agent_status") == "unknown",
                    "unknown", recheck["pane"].get("agent_status"))

        # 沿用 probe 的后台 pane 写法：不 focus，只承载受控上报。
        fresh.request("pane.send_text", {"pane_id": pane_id, "text": "sleep 180"})
        fresh.request("pane.send_keys", {"pane_id": pane_id, "keys": ["enter"]})
        time.sleep(0.2)
        working = recover_events.report_and_wait(fresh, pane_id, "working", "working", "new_working")
        blocked = recover_events.report_and_wait(fresh, pane_id, "blocked", "blocked", "new_blocked")
        events = recover_events.drain(new_sub, DRAIN_WAIT)
        probe.check(STAGE, "new_working_event",
                    bool(recover_events.pane_events(events, pane_id, "working")),
                    "订阅上读到 working 事件", events)
        probe.check(STAGE, "new_blocked_event",
                    bool(recover_events.pane_events(events, pane_id, "blocked")),
                    "订阅上读到 blocked 事件", events)

        reads = [recover_events.current(fresh, pane_id) for _ in range(3)]
        keys = {recover_events.key_of(item) for item in reads}
        probe.check(STAGE, "blocked_reads_dedup_one", len(keys) == 1, 1, len(keys))
        probe.check(STAGE, "new_terminal_key_differs",
                    recover_events.key_of(reads[0]) != recover_events.key_of(old),
                    "新 terminal 的 key 与旧 key 不同",
                    {"new": list(recover_events.key_of(reads[0])),
                     "old": list(recover_events.key_of(old))})
        result["reports"] = {"working": working, "blocked": blocked}
        result["events"] = events
        result["counts"] = {"naive": len(reads), "dedup": len(keys),
                            "keys": [list(key) for key in keys],
                            "note": "仅受控通知计数；不是系统通知"}
    finally:
        fresh.close()
        for subscription in opened:
            subscription.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description="Herdr 重启恢复实验 REC-05")
    parser.add_argument("--root", required=True)
    args = parser.parse_args(argv)
    try:
        root = probe.validate_root(args.root)
    except RuntimeError as exc:
        print(f"拒绝运行: {exc}", file=sys.stderr)
        return 2
    probe.TRACE = root / "restart-trace.jsonl"
    probe.log(STAGE, "run_start", root=str(root), argv=sys.argv)
    result = {"ok": False, "error": None}
    try:
        run(root, result)
        result["ok"] = True
    except Exception as exc:
        result["error"] = {"type": type(exc).__name__, "message": str(exc),
                           "traceback": traceback.format_exc()}
        print(f"重启恢复实验失败: {exc}", file=sys.stderr)
    finally:
        probe.log(STAGE, "run_end", ok=result["ok"], error=result["error"])
        (root / "restart-result.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2, default=str) + "\n",
            encoding="utf-8")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
