#!/usr/bin/env python3
"""Herdr 隔离实验 fixture：记录 hook、启动脱离的 heartbeat。

只允许在 BAYPER_RESEARCH_ROOT=/tmp/bayper-herdr-spike-* 内工作。
"""

import json
import os
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

SPIKE_PREFIXES = ("/tmp/bayper-herdr-spike-", "/private/tmp/bayper-herdr-spike-")
INTERVAL = 0.2
MAX_SECONDS = 120.0
FIXTURE = Path(__file__).resolve()
STOP = False


def now():
    return datetime.now(timezone.utc).isoformat()


def research_root():
    raw = os.environ.get("BAYPER_RESEARCH_ROOT")
    if not raw:
        raise SystemExit("缺少 BAYPER_RESEARCH_ROOT")
    root = Path(raw).expanduser().resolve()
    text = str(root)
    in_scope = any(text.startswith(prefix) and len(text) > len(prefix)
                   for prefix in SPIKE_PREFIXES)
    if not in_scope or not root.is_dir():
        raise SystemExit(f"拒绝使用隔离根目录之外的路径: {root}")
    return root


def append(path, record):
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")


def record(root):
    append(root / "plugin-events.jsonl", {
        "event": os.environ.get("HERDR_PLUGIN_EVENT") or "startup",
        "pid": os.getpid(),
        "socket": os.environ.get("HERDR_SOCKET_PATH"),
        "HERDR_PLUGIN_CONFIG_DIR": os.environ.get("HERDR_PLUGIN_CONFIG_DIR"),
        "HERDR_PLUGIN_STATE_DIR": os.environ.get("HERDR_PLUGIN_STATE_DIR"),
        "root": str(root),
        "at": now(),
    })


def spawn(root):
    process = subprocess.Popen(
        [sys.executable, str(FIXTURE), "heartbeat"],
        env=os.environ.copy(),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    (root / "heartbeat.pid").write_text(f"{process.pid}\n", encoding="utf-8")
    print(json.dumps({"event": "spawn", "pid": process.pid}, ensure_ascii=False))


def heartbeat(root):
    def stop(_signum, _frame):
        global STOP
        STOP = True

    signal.signal(signal.SIGTERM, stop)
    deadline = time.monotonic() + MAX_SECONDS
    while not STOP and time.monotonic() < deadline:
        append(root / "heartbeat.jsonl", {
            "event": "heartbeat", "pid": os.getpid(), "at": now()})
        time.sleep(INTERVAL)


def main():
    root = research_root()
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "record":
        record(root)
    elif command == "spawn":
        spawn(root)
    elif command == "heartbeat":
        heartbeat(root)
    else:
        raise SystemExit(f"未知命令: {command}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
