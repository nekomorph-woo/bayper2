#!/usr/bin/env python3
"""Herdr 事件恢复实验 REC-01 至 REC-04。

复用 probe 的 socket、日志和断言，只做受控状态上报与权威快照对账。
不关闭 pane/server、不注册插件、不发送系统通知；trace 与结果写入 root。
"""

import argparse
import json
import sys
import time
import traceback

import probe

STAGE = "event-recovery"
EVENT_TYPE = "pane.agent_status_changed"


def current(client, pane_id):
    # 权威来源是 result.snapshot.agents；pane.get 不含 state_change_seq。
    snapshot = client.request("session.snapshot").get("snapshot") or {}
    matches = [a for a in snapshot.get("agents") or [] if a.get("pane_id") == pane_id]
    if len(matches) != 1:
        raise RuntimeError(f"权威快照中 pane {pane_id} 匹配到 {len(matches)} 个 AgentInfo")
    agent = matches[0]
    missing = [k for k in ("terminal_id", "agent_status", "state_change_seq") if agent.get(k) is None]
    if missing:
        raise RuntimeError(f"AgentInfo 缺少字段 {missing}: {agent}")
    return agent


def key_of(agent):
    return (agent["terminal_id"], agent["agent_status"], agent["state_change_seq"])


def report_and_wait(client, pane_id, report_state, expected, label):
    # idle 在权威快照中投影为 done。
    probe.report(client, pane_id, report_state)
    confirmed = probe.wait_until(
        lambda: current(client, pane_id)["agent_status"] == expected, probe.REQUEST_TIMEOUT)
    agent = current(client, pane_id)
    probe.check(STAGE, f"{label}_authoritative", bool(confirmed), expected,
                agent["agent_status"], details=agent)
    return agent


def subscribe(root, pane_id, label, opened):
    subscription = probe.Socket(root, "a", STAGE)
    opened.append(subscription)
    reply = subscription.subscribe([{"type": EVENT_TYPE, "pane_id": pane_id}])
    probe.check(STAGE, f"{label}_subscription_ack",
                "error" not in reply
                and (reply.get("result") or {}).get("type") == "subscription_started",
                "subscription_started", reply)
    return subscription


def drain(subscription, seconds):
    """在截止时间内读取事件，保留原始 message。"""
    messages, deadline = [], time.monotonic() + seconds
    while (remaining := deadline - time.monotonic()) > 0:
        message = subscription.read_event(remaining)
        if message is None:
            break
        messages.append(message)
    return messages


def pane_events(messages, pane_id, state=None):
    events = []
    for message in messages:
        data = message.get("data") or {}
        if (message.get("event") == EVENT_TYPE and data.get("pane_id") == pane_id
                and (state is None or data.get("agent_status") == state)):
            events.append(message)
    return events


def note(counters, agent):
    """对照组每次观察都计数；去重组按权威 tuple 只计一次。"""
    if agent["agent_status"] in ("blocked", "done"):
        counters["naive"] += 1
        counters["keys"].add(key_of(agent))


def run(root, result):
    prepared = probe.prepare_session(root, STAGE, "a")
    client, pane_id = prepared["client"], prepared["pane_id"]
    # 必须先上报，权威快照才会出现该 pane 的 AgentInfo。
    identity = report_and_wait(client, pane_id, "working", "working", "setup_working")
    result["context"] = {"pane_id": pane_id, "terminal_id": identity["terminal_id"],
                         "control_id": prepared["control_id"]}
    cases, subscriptions = {}, []
    try:
        # REC-01：断连期间变 blocked；重连后读取当前状态且不补发历史。
        report_and_wait(client, pane_id, "working", "working", "rec01_working")
        first = subscribe(root, pane_id, "rec01_first", subscriptions)
        first.close()
        blocked = report_and_wait(client, pane_id, "blocked", "blocked", "rec01_blocked")
        subscription = subscribe(root, pane_id, "rec01_reconnect", subscriptions)
        observed = current(client, pane_id)
        probe.check(STAGE, "rec01_reconnect_blocked", key_of(observed) == key_of(blocked),
                    key_of(blocked), key_of(observed))
        replay = drain(subscription, 0.3)
        probe.check(STAGE, "rec01_no_history_replay", not pane_events(replay, pane_id),
                    "0.3 秒内无该 pane 事件", replay)
        counters, reads = {"naive": 0, "keys": set()}, []
        for _ in range(3):
            frame = current(client, pane_id)
            reads.append(frame)
            note(counters, frame)
        probe.check(STAGE, "rec01_same_blocked_frame",
                    {key_of(x) for x in reads} == {key_of(blocked)},
                    {key_of(blocked)}, {key_of(x) for x in reads})
        probe.check(STAGE, "rec01_naive_three", counters["naive"] == 3, 3, counters["naive"])
        probe.check(STAGE, "rec01_dedup_one", len(counters["keys"]) == 1, 1, len(counters["keys"]))
        cases["rec01"] = {"blocked_snapshot": blocked, "reads": reads, "events": replay,
                          "key": key_of(blocked), "naive": 3, "dedup": 1}
        subscription.close()

        # REC-02：断连期间 blocked -> working；只恢复当前状态，不冒充历史。
        report_and_wait(client, pane_id, "working", "working", "rec02_working")
        gap_writes = [report_and_wait(client, pane_id, "blocked", "blocked", "rec02_gap_blocked"),
                      report_and_wait(client, pane_id, "working", "working", "rec02_gap_working")]
        subscription = subscribe(root, pane_id, "rec02_reconnect", subscriptions)
        recovered = current(client, pane_id)
        probe.check(STAGE, "rec02_recovered_working", recovered["agent_status"] == "working",
                    "working", recovered["agent_status"], details=recovered)
        window = drain(subscription, 0.5)
        probe.check(STAGE, "rec02_no_blocked_history",
                    not pane_events(window, pane_id, "blocked"),
                    "有限窗口内无历史 blocked 事件", window)
        cases["rec02"] = {
            "control_writes": [x["agent_status"] for x in gap_writes],
            "final_snapshot": recovered, "events": window,
            "observation_gap": "断连期间 blocked 写入不可观察；working 仅为当前状态，不冒充完整历史",
        }
        subscription.close()

        # REC-03：延迟应用旧快照；事件只作失效信号，由最新权威快照收敛。
        report_and_wait(client, pane_id, "working", "working", "rec03_working")
        subscription = subscribe(root, pane_id, "rec03_delayed", subscriptions)
        stale = current(client, pane_id)
        probe.check(STAGE, "rec03_stale_capture", stale["agent_status"] == "working",
                    "working", stale["agent_status"], details=stale)
        buffer = []
        for report_state, expected in (("blocked", "blocked"), ("working", "working"), ("idle", "done")):
            report_and_wait(client, pane_id, report_state, expected, f"rec03_{report_state}")
            buffer += drain(subscription, 0.3)
        latest = current(client, pane_id)
        probe.check(STAGE, "rec03_converged_done", latest["agent_status"] == "done",
                    "done", latest["agent_status"], details=latest)
        blocked_events = pane_events(buffer, pane_id, "blocked")
        probe.check(STAGE, "rec03_real_blocked_event", bool(blocked_events),
                    "缓冲中有真实 blocked 事件", blocked_events)
        stale_state = (blocked_events[0].get("data") or {}).get("agent_status")
        probe.check(STAGE, "rec03_stale_would_rollback",
                    stale_state == "blocked" and latest["agent_status"] == "done",
                    {"stale_event": "blocked", "latest": "done"},
                    {"stale_event": stale_state, "latest": latest["agent_status"]})
        cases["rec03"] = {
            "stale_snapshot": stale,
            "buffered_events": [m.get("data") for m in buffer],
            "latest_snapshot": latest,
            "comparison": {"naive_event_apply": stale_state,
                           "correct_latest_snapshot": latest["agent_status"],
                           "buffer_role": "仅作为失效信号；受控延迟应用，不伪造同时线程或网络时序"},
        }
        subscription.close()

        # REC-04：同一 blocked episode 的事件与重复快照去重；新 episode 重新计数。
        report_and_wait(client, pane_id, "working", "working", "rec04_working")
        subscription = subscribe(root, pane_id, "rec04_episodes", subscriptions)

        def read_episode(label):
            events = drain(subscription, 1.0)
            probe.check(STAGE, f"{label}_blocked_event",
                        bool(pane_events(events, pane_id, "blocked")),
                        "订阅上读到真实 blocked 事件", events)
            return events

        first = report_and_wait(client, pane_id, "blocked", "blocked", "rec04_first_blocked")
        first_events = read_episode("rec04_first")
        first_reads = [current(client, pane_id) for _ in range(3)]
        probe.check(STAGE, "rec04_first_frames_equal",
                    {key_of(x) for x in first_reads} == {key_of(first)},
                    {key_of(first)}, {key_of(x) for x in first_reads})
        first_blocked_events = pane_events(first_events, pane_id, "blocked")
        counters = {"naive": len(first_blocked_events), "keys": {key_of(first)}}
        for frame in first_reads:
            note(counters, frame)
        probe.check(STAGE, "rec04_first_naive",
                    counters["naive"] == len(first_blocked_events) + 3,
                    len(first_blocked_events) + 3, counters["naive"])
        probe.check(STAGE, "rec04_first_dedup_one", len(counters["keys"]) == 1, 1, len(counters["keys"]))
        report_and_wait(client, pane_id, "working", "working", "rec04_second_working")
        second = report_and_wait(client, pane_id, "blocked", "blocked", "rec04_second_blocked")
        second_events = read_episode("rec04_second")
        probe.check(STAGE, "rec04_new_episode_seq",
                    second["state_change_seq"] != first["state_change_seq"],
                    "不同的 state_change_seq",
                    {"first": first["state_change_seq"], "second": second["state_change_seq"]})
        # 合同只把 blocked/done 视为通知；working 事件不计入 naive。
        counters["naive"] += len(pane_events(second_events, pane_id, "blocked"))
        note(counters, second)
        probe.check(STAGE, "rec04_second_dedup_two", len(counters["keys"]) == 2, 2, len(counters["keys"]))
        probe.check(STAGE, "rec04_naive_exceeds_dedup",
                    counters["naive"] > len(counters["keys"]), "naive > dedup",
                    {"naive": counters["naive"], "dedup": len(counters["keys"])})
        cases["rec04"] = {
            "first": {"snapshot": first, "raw_event_count": len(first_events),
                      "raw_events": [m.get("data") for m in first_events], "reads": first_reads},
            "second": {"snapshot": second, "raw_event_count": len(second_events),
                       "raw_events": [m.get("data") for m in second_events]},
            "naive": counters["naive"], "dedup": len(counters["keys"]),
            "dedup_keys": [list(k) for k in counters["keys"]],
            "note": "去重键仅为研究用权威 tuple；不宣称通用 exactly-once",
        }
        subscription.close()
    finally:
        for subscription in subscriptions:
            subscription.close()
    result["cases"] = cases


def main(argv=None):
    parser = argparse.ArgumentParser(description="Herdr 事件恢复实验 REC-01 至 REC-04")
    parser.add_argument("--root", required=True)
    args = parser.parse_args(argv)
    try:
        root = probe.validate_root(args.root)
    except RuntimeError as exc:
        print(f"拒绝运行: {exc}", file=sys.stderr)
        return 2
    probe.TRACE = root / "recovery-trace.jsonl"
    probe.log(STAGE, "run_start", root=str(root), argv=sys.argv)
    result = {"ok": False, "error": None}
    try:
        run(root, result)
        result["ok"] = True
    except Exception as exc:
        result["error"] = {"type": type(exc).__name__, "message": str(exc),
                           "traceback": traceback.format_exc()}
        print(f"事件恢复实验失败: {exc}", file=sys.stderr)
    finally:
        probe.log(STAGE, "run_end", ok=result["ok"], error=result["error"])
        (root / "recovery-context.json").write_text(
            json.dumps(result.get("context") or {}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (root / "recovery-result.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2, default=str) + "\n", encoding="utf-8")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
