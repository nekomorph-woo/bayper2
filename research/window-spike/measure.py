#!/usr/bin/env python3
"""按固定间隔测量进程组的 RSS 与区间 CPU（仅标准库与 macOS ps）。

第一个 --pids 为根进程，其余为已确认归属、需额外纳入的进程（含后代）；
不自动纳入系统其它 WebKit，也不启动或结束进程。RSS 为各进程 RSS 之和，可能
重复计算共享页，不代表物理内存 footprint。
"""

import argparse, json, os, re, subprocess, sys, time

PS_ARGS = ["ps", "-axo", "pid=,ppid=,rss=,time=,comm="]
ROOT_PREFIX = "/tmp/bayper-window-spike-"

def parse_cpu_time(value):
    """把 ps 的 [[dd-]hh:]mm:ss.xx 转为累计秒。"""
    days, _, clock_text = value.rpartition("-")
    seconds, multiplier = 0.0, 1
    for part in reversed(clock_text.split(":")):
        seconds += float(part) * multiplier
        multiplier *= 60
    return int(days or 0) * 86400 + seconds

def read_process_table():
    """读取全表，只保留 pid、ppid、rss、累计 CPU 秒和 comm。"""
    result = subprocess.run(PS_ARGS, capture_output=True, text=True, check=True, errors="replace")
    table = {}
    for line in result.stdout.splitlines():
        fields = line.split(maxsplit=4)
        if len(fields) != 5:
            continue
        pid, ppid, rss, cpu_time, comm = fields
        table[int(pid)] = {"pid": int(pid), "ppid": int(ppid), "rss": int(rss),
                           "time": parse_cpu_time(cpu_time), "comm": comm}
    return table

def collect_descendants(table, seeds):
    """从 seeds 出发递归收集存活的后代 PID。"""
    children = {}
    for proc in table.values():
        children.setdefault(proc["ppid"], []).append(proc["pid"])
    tracked, stack = set(), list(seeds)
    while stack:
        pid = stack.pop()
        if pid not in tracked and pid in table:
            tracked.add(pid)
            stack.extend(children.get(pid, ()))
    return tracked

def stats(values):
    if not values:
        return None
    return {"mean": round(sum(values) / len(values), 2), "min": round(min(values), 2), "max": round(max(values), 2)}

def main():
    parser = argparse.ArgumentParser(description="固定间隔测量进程组 RSS 与区间 CPU")
    parser.add_argument("--root", required=True, help="已存在的 /tmp/bayper-window-spike-* 目录")
    parser.add_argument("--label", required=True, help="输出标签，仅字母、数字、- 和 _")
    parser.add_argument("--pids", required=True, nargs="+", type=int, help="首个为根 PID，其余为额外归属 PID")
    parser.add_argument("--seconds", type=int, default=20, help="采样时长，默认 20，最大 60")
    args = parser.parse_args()

    root = os.path.normpath(args.root)
    suffix = root[len(ROOT_PREFIX):] if root.startswith(ROOT_PREFIX) else ""
    if not suffix or "/" in suffix or not os.path.isdir(root):
        parser.error("--root 必须是已存在的 /tmp/bayper-window-spike-<名称> 目录")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", args.label):
        parser.error("--label 只能包含字母、数字、- 和 _")
    if not 1 <= args.seconds <= 60:
        parser.error("--seconds 必须在 1 到 60 之间")
    if any(pid <= 0 for pid in args.pids) or len(set(args.pids)) != len(args.pids):
        parser.error("--pids 必须是多个不重复的正整数 PID")

    root_pid, start = args.pids[0], time.monotonic()
    samples, previous_times, previous_wall, exit_error = [], {}, None, None
    for index in range(args.seconds + 1):
        wait = start + index - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        table = read_process_table()
        if root_pid not in table:
            if index == 0:
                print(f"根 PID {root_pid} 不在 ps 表中，无法开始采样", file=sys.stderr)
                return 1
            exit_error = f"根 PID {root_pid} 在第 {index} 个采样点前退出，保留 {len(samples)} 个样本"
            break

        wall = time.monotonic()
        tracked = collect_descendants(table, args.pids)
        processes, cpu_delta = [], 0.0
        for pid in sorted(tracked):
            delta = None
            if pid in previous_times:
                delta = table[pid]["time"] - previous_times[pid]
                cpu_delta += delta
            processes.append(dict(table[pid], cpuDelta=delta))
        interval = None if previous_wall is None else wall - previous_wall
        samples.append({
            "wallIntervalSeconds": None if interval is None else round(interval, 3),
            "intervalCpuPct": None if not interval else round(cpu_delta / interval * 100, 2),
            "rssKiB": sum(table[pid]["rss"] for pid in tracked),
            "processes": processes,
        })
        previous_times = {pid: table[pid]["time"] for pid in tracked}
        previous_wall = wall

    summary = {
        "sampleCount": len(samples),
        "cpuPct": stats([s["intervalCpuPct"] for s in samples if s["intervalCpuPct"] is not None]),
        "rssMiB": stats([s["rssKiB"] / 1024 for s in samples]),
        "initialPids": [p["pid"] for p in samples[0]["processes"]], "finalPids": [p["pid"] for p in samples[-1]["processes"]],
    }
    document = {
        "label": args.label, "rootPid": root_pid, "seedPids": args.pids,
        "note": "intervalCpuPct 以单核 100% 计；rssKiB 为跟踪进程 RSS 之和，可能重复计算共享页，不代表物理内存占用。",
        "samples": samples, "summary": summary, "exitError": exit_error,
    }
    output = os.path.join(root, f"resources-{args.label}.json")
    with open(output, "w", encoding="utf-8") as handle:
        json.dump(document, handle, ensure_ascii=False, indent=2)
        handle.write("\n")

    brief = {"label": args.label, "output": output, **summary, "exitError": exit_error}
    print(json.dumps(brief, ensure_ascii=False))
    if exit_error or len(samples) < 2:
        print(exit_error or "样本不足两个，无法计算区间 CPU", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
