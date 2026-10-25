#!/usr/bin/env python3
"""Herdr REC-06 / REC-07：真实 events_lost 触发与恢复对账。

请求均经 probe.Socket 发往隔离 root，不模拟 events_lost；洪峰固定上限且不重试。
"""

import argparse
import json
import socket
import sys
import threading
import time
import traceback
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed

import probe
import recover_events

STAGE = "event-loss"
META_TYPE = "workspace.metadata_updated"
PANE_TYPE = "pane.agent_status_changed"
FLOOD_SOURCE = "bayper-recovery-flood"
BATCHES, BATCH_SIZE, WORKERS = 8, 128, 64
TOTAL = BATCHES * BATCH_SIZE
PADDING = "x" * 512
BATCH_WAIT, LOSS_WAIT, EOF_WAIT, MARKER_WAIT = 2.0, 10.0, 3.0, 3.0
FLOOD_DEADLINE = 20.0
BOUNDARIES = {512: "blocked", 768: "working", 1024: "blocked"}


def open_subscription(root, entries, label, opened):
    subscription = probe.Socket(root, "a", f"{STAGE}-{label}")
    opened.append(subscription)
    reply = subscription.subscribe(entries)
    probe.check(STAGE, f"{label}_ack",
                "error" not in reply
                and (reply.get("result") or {}).get("type") == "subscription_started",
                "subscription_started", reply)
    return subscription, reply


def start_reader(subscription, label, state):
    stop = threading.Event()

    def loop():
        while not stop.is_set():
            try:
                message = subscription.read_event(0.2)
            except (EOFError, OSError) as exc:
                with state["lock"]:
                    state["ends"].append({"label": label, "end": repr(exc)})
                return
            if message is None:
                continue
            data = message.get("data") or {}
            raw_n = ((data.get("workspace") or {}).get("tokens") or {}).get("n")
            record = ({"event": message.get("event"), "n": raw_n} if raw_n is not None
                      else {"event": message.get("event"), "data": data})
            with state["lock"]:
                state["messages"].append(record)
                state["names"].add(message.get("event"))
                if raw_n is not None:
                    state["indices"].append(int(raw_n))
            if raw_n is not None:
                probe.log(STAGE, "index", index=int(raw_n), event=message.get("event"))

    thread = threading.Thread(target=loop, name=label, daemon=True)
    thread.start()
    return stop, thread


def healthy_indices(state):
    with state["lock"]:
        return list(state["indices"])


def flood_one(root, control_id, index):
    params = {"workspace_id": control_id, "source": FLOOD_SOURCE,
              "tokens": {"n": str(index), "padding": PADDING}}
    client = probe.Socket(root, "a", f"{STAGE}-flood-{index}")
    try:
        response = client.request_raw("workspace.report_metadata", params)
    finally:
        client.close()
    if "error" in response:
        raise RuntimeError(f"洪峰请求 {index} 返回错误: {response['error']}")
    return index


def resume_slow(slow):
    """恢复读取慢订阅；只把 socket 中真实的 error 消息记为 events_lost。"""
    messages, loss, eof = [], None, False
    deadline = time.monotonic() + LOSS_WAIT
    eof_deadline = None
    while True:
        now = time.monotonic()
        limit = eof_deadline if eof_deadline is not None else deadline
        if now >= limit:
            break
        try:
            message = slow.read_event(min(0.5, limit - now))
        except (EOFError, OSError) as exc:
            messages.append({type(exc).__name__: repr(exc)})
            eof = isinstance(exc, EOFError)
            break
        if message is None:
            continue
        if "error" in message:
            messages.append({"id": message.get("id"), "error": message.get("error")})
            if (message.get("error") or {}).get("code") == "events_lost":
                loss = message
                if eof_deadline is None:
                    eof_deadline = time.monotonic() + EOF_WAIT
            continue
        data = message.get("data") or {}
        tokens = (data.get("workspace") or {}).get("tokens") or {}
        # 普通 metadata 只压缩记录 n；关键 pane 事件与 error 保留原始数据。
        if tokens.get("n") is not None:
            messages.append({"event": message.get("event"), "n": int(tokens["n"])})
        else:
            messages.append({"event": message.get("event"), "data": data})
    return messages, loss, eof


def run(root, result):
    prepared = probe.prepare_session(root, STAGE, "a")
    client, pane_id = prepared["client"], prepared["pane_id"]
    control_id = prepared["control_id"]
    # current 需要先 report，AgentInfo 才会出现在权威快照中。
    initial = recover_events.report_and_wait(client, pane_id, "working", "working", "setup_working")
    truth = [{"label": "setup_working", "agent_status": initial["agent_status"]}]
    result["context"] = {"pane_id": pane_id, "control_id": control_id, "terminal_id": initial["terminal_id"]}
    result["control_truth"] = truth
    opened, readers = [client], []
    try:
        health, _ = open_subscription(root, [{"type": META_TYPE}], "healthy", opened)
        hstate = {"messages": [], "indices": [], "names": set(), "ends": [],
                  "lock": threading.Lock()}
        readers.append(start_reader(health, "healthy-reader", hstate))
        slow, slow_ack = open_subscription(
            root, [{"type": META_TYPE}, {"type": PANE_TYPE, "pane_id": pane_id}],
            "slow", opened)
        slow_id = slow_ack.get("id")
        # ack 后缩小接收缓冲并暂停读取，让洪峰真实填满传输层。
        slow.sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1024)
        rcvbuf = slow.sock.getsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF)
        result["slow"] = {"ack": slow_ack, "subscription_id": slow_id, "so_rcvbuf": rcvbuf}
        pause_start = len(truth)
        flood_started = time.monotonic()
        flood_deadline = flood_started + FLOOD_DEADLINE
        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            for batch in range(BATCHES):
                if time.monotonic() >= flood_deadline:
                    raise RuntimeError(
                        f"洪峰阶段超过 {FLOOD_DEADLINE} 秒总 deadline，第 {batch + 1} 批未发送")
                start = batch * BATCH_SIZE
                indices = range(start, start + BATCH_SIZE)
                futures = [pool.submit(flood_one, root, control_id, n) for n in indices]
                for future in as_completed(futures):
                    result["flood_ok"].append(future.result())
                expected = set(indices)
                ok = probe.wait_until(
                    lambda: expected <= set(healthy_indices(hstate)), BATCH_WAIT)
                probe.check(STAGE, f"healthy_batch_{batch + 1}", bool(ok),
                            f"包含 {start}..{start + BATCH_SIZE - 1}",
                            len(healthy_indices(hstate)))
                boundary = start + BATCH_SIZE
                if boundary in BOUNDARIES:
                    wanted = BOUNDARIES[boundary]
                    label = f"after{boundary}_{wanted}"
                    agent = recover_events.report_and_wait(
                        client, pane_id, wanted, wanted, label)
                    truth.append({"label": label, "after": boundary,
                                  "agent_status": agent["agent_status"]})
        result["flood_elapsed_seconds"] = round(time.monotonic() - flood_started, 3)
        result["requests"] = {"scheduled": TOTAL, "succeeded": len(result["flood_ok"])}
        blocked = sum(item["agent_status"] == "blocked" for item in truth)
        probe.check(STAGE, "control_two_blocked_episodes", blocked >= 2, ">=2", blocked)
        probe.check(STAGE, "control_final_blocked",
                    truth[-1]["agent_status"] == "blocked", "blocked", truth[-1]["agent_status"])

        messages, loss, eof = resume_slow(slow)
        statuses = [item["data"].get("agent_status") for item in messages
                    if (item.get("data") or {}).get("pane_id") == pane_id]
        statuses = [status for status in statuses if status is not None]
        missing = [{"label": item["label"], "agent_status": item["agent_status"]}
                   for item in truth[pause_start:] if item["agent_status"] not in statuses]
        result["slow"].update({
            "messages": messages, "events_lost": loss, "eof": eof,
            "received_indices": [item["n"] for item in messages if "n" in item],
            "received_statuses": statuses, "missing_control_statuses": missing,
        })
        probe.check(STAGE, "raw_events_lost",
                    bool(loss and (loss.get("error") or {}).get("code") == "events_lost"
                         and loss.get("id") == slow_id),
                    {"code": "events_lost", "id": slow_id}, loss)
        probe.check(STAGE, "eof_after_events_lost", eof, True, eof)

        recovery, recovery_ack = open_subscription(
            root, [{"type": META_TYPE}, {"type": PANE_TYPE, "pane_id": pane_id}],
            "recovery", opened)
        rstate = {"messages": [], "indices": [], "names": set(), "ends": [],
                  "lock": threading.Lock()}
        readers.append(start_reader(recovery, "recovery-reader", rstate))
        observations = [recover_events.current(client, pane_id) for _ in range(3)]
        probe.check(STAGE, "recovery_all_blocked",
                    all(item["agent_status"] == "blocked" for item in observations),
                    "3 次均为 blocked", [item["agent_status"] for item in observations])
        keys = {recover_events.key_of(item) for item in observations}
        probe.check(STAGE, "recovery_dedup_one", len(keys) == 1, 1, len(keys))
        result["recovery"] = {
            "ack": recovery_ack, "snapshots": observations, "naive": len(observations),
            "dedup": len(keys), "keys": [list(key) for key in keys],
            "note": "研究用通知计数；不是 Herdr 系统通知，也不宣称通用 exactly-once",
        }

        marker = {"workspace_id": control_id, "source": FLOOD_SOURCE,
                  "tokens": {"n": str(TOTAL), "padding": PADDING}}
        client.request("workspace.report_metadata", marker)
        marker_seen = probe.wait_until(lambda: TOTAL in healthy_indices(hstate), MARKER_WAIT)
        probe.check(STAGE, "healthy_marker_1024", bool(marker_seen), TOTAL,
                    healthy_indices(hstate)[-5:])
        # 恢复订阅是洪峰后新建的，仍需独立收到 marker，证明确实在继续消费。
        recovery_marker_seen = probe.wait_until(
            lambda: TOTAL in healthy_indices(rstate), MARKER_WAIT)
        probe.check(STAGE, "recovery_marker_1024", bool(recovery_marker_seen), TOTAL,
                    healthy_indices(rstate)[-5:])
        # 短暂等待在途消息，再统计健康订阅索引，避免因 marker 到达顺序漏算重复。
        time.sleep(0.2)
        with hstate["lock"]:
            indices = list(hstate["indices"])
            names, ends = sorted(hstate["names"]), list(hstate["ends"])
        with rstate["lock"]:
            recovery_messages = list(rstate["messages"])
        result["recovery"].update({"marker_seen": bool(recovery_marker_seen),
                                   "healthy_marker_seen": bool(marker_seen),
                                   "messages": recovery_messages})
        counts = Counter(indices)
        missing_healthy = sorted(set(range(TOTAL + 1)) - set(indices))
        duplicates = {str(n): count for n, count in counts.items() if count > 1}
        result["healthy"] = {"indices": indices, "missing": missing_healthy,
                             "duplicates": duplicates, "event_names": names, "reader_ends": ends}
        probe.check(STAGE, "healthy_complete_0_to_1024", not missing_healthy, [], missing_healthy)
        probe.check(STAGE, "healthy_no_duplicates", not duplicates, {}, duplicates)
    finally:
        for stop, thread in readers:
            stop.set()
            thread.join(2.0)
        for subscription in opened:
            subscription.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description="Herdr 事件恢复实验 REC-06 / REC-07")
    parser.add_argument("--root", required=True)
    args = parser.parse_args(argv)
    try:
        root = probe.validate_root(args.root)
    except RuntimeError as exc:
        print(f"拒绝运行: {exc}", file=sys.stderr)
        return 2
    probe.TRACE = root / "loss-trace.jsonl"
    probe.log(STAGE, "run_start", root=str(root), argv=sys.argv)
    result = {"ok": False, "error": None, "flood_ok": []}
    started = time.monotonic()
    try:
        run(root, result)
        result["ok"] = True
    except Exception as exc:
        result["error"] = {"type": type(exc).__name__, "message": str(exc),
                           "traceback": traceback.format_exc()}
        print(f"事件丢失实验失败: {exc}", file=sys.stderr)
    finally:
        result["elapsed_seconds"] = round(time.monotonic() - started, 3)
        probe.log(STAGE, "run_end", ok=result["ok"], error=result["error"])
        (root / "loss-result.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2, default=str) + "\n",
            encoding="utf-8")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
