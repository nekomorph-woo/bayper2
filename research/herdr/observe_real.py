#!/usr/bin/env python3
"""监听真实 Claude Code 实验 pane 的 agent 状态变化。

只读取 Herdr 状态，不模拟上报，也不发送 prompt、确认、focus 或停止命令。
"""

import argparse
import json
import sys
import time

import probe

STAGE = "real-cli-followup"
POLL_INTERVAL = 0.2
WANTED = ("working", "done", "idle")


def has_sequence(states):
    index = 0
    for state in states:
        if state == WANTED[index]:
            index += 1
            if index == len(WANTED):
                return True
    return False


def main(argv=None):
    parser = argparse.ArgumentParser(description="监听真实 Claude Code 实验 pane")
    parser.add_argument("--root", required=True)
    parser.add_argument("--pane", required=True)
    parser.add_argument("--seconds", type=float, default=120.0)
    args = parser.parse_args(argv)
    try:
        root = probe.validate_root(args.root)
    except RuntimeError as exc:
        print(f"拒绝运行: {exc}", file=sys.stderr)
        return 2

    probe.TRACE = root / "real-cli-followup-trace.jsonl"
    started_at, started = probe.stamp(), time.monotonic()
    deadline = started + args.seconds
    event_states, poll_states = [], []
    subscription = probe.Socket(root, "a", STAGE)
    poll = probe.Socket(root, "a", STAGE)
    ok, error = False, None

    def observe(states, source, state):
        if state is None or (states and states[-1] == state):
            return
        states.append(state)
        probe.log(STAGE, "state_change", source=source, pane_id=args.pane, state=state)

    try:
        reply = subscription.subscribe(
            [{"type": "pane.agent_status_changed", "pane_id": args.pane}])
        subscribed = (reply.get("result") or {}).get("type") == "subscription_started"
        if "error" in reply or not subscribed:
            raise RuntimeError(f"订阅失败: {reply}")
        print("READY", flush=True)

        while time.monotonic() < deadline:
            timeout = min(POLL_INTERVAL, max(0.0, deadline - time.monotonic()))
            message = subscription.read_event(timeout)
            if message is not None:
                data = message.get("data") or {}
                if (message.get("event") == "pane.agent_status_changed"
                        and data.get("pane_id") == args.pane):
                    observe(event_states, "event", data.get("agent_status"))

            response = poll.request("pane.get", {"pane_id": args.pane})
            pane = response.get("pane") or {}
            observe(poll_states, "poll", pane.get("agent_status"))

            if has_sequence(event_states) and has_sequence(poll_states):
                ok = True
                break

        if not ok:
            raise TimeoutError(
                f"{args.seconds:g} 秒内未观察到完整 working -> done -> idle: "
                f"event={event_states}, poll={poll_states}")
    except Exception as exc:
        error = {"type": type(exc).__name__, "message": str(exc)}
        print(f"观察失败: {exc}", file=sys.stderr)
    finally:
        subscription.close()
        poll.close()
        finished_at, finished = probe.stamp(), time.monotonic()
        result = {
            "ok": ok,
            "error": error,
            "started_at": started_at,
            "finished_at": finished_at,
            "started_monotonic": round(started, 6),
            "finished_monotonic": round(finished, 6),
            "event_states": event_states,
            "poll_states": poll_states,
        }
        (root / "real-cli-followup-result.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
