#!/usr/bin/env python3
"""Tracer-free per-thread sampler for an agent's first N ms (diagnostic; separate process).

  startup_sampler.py PID|- DURATION_MS   ("-": PID read from stdin); JSON on stdout

Polls /proc/PID/task/*/{comm,stat,wchan,syscall[,stack]} as fast as Python allows and
writes per-thread transitions only: {tid: [[t_ms, comm, state, wchan, syscall], ...]}.
t_ms is time.perf_counter_ns() (CLOCK_MONOTONIC) in ms; the harness subtracts its launch_ns.
/proc/*/syscall needs ptrace-attach rights (Yama scope 1 allows only ancestors) and /proc/*/stack
needs root: the harness runs this under `sudo -n` when available; unreadable fields come back null.
"""
from __future__ import annotations

import json
import os
import sys
import time


def read(path: str) -> str | None:
    try:
        with open(path, "rb") as f:
            return f.read().decode(errors="replace").strip()
    except OSError:
        return None


def main() -> int:
    # PID "-": read it from stdin, so the interpreter is already warm when the agent launches.
    pid = int(sys.stdin.readline()) if sys.argv[1] == "-" else int(sys.argv[1])
    duration_ms = float(sys.argv[2])
    start = time.perf_counter_ns()
    until = start + int(duration_ms * 1e6)
    stack_ok = True
    last: dict[str, tuple] = {}
    series: dict[str, list] = {}
    samples = 0
    while time.perf_counter_ns() < until:
        try:
            tids = os.listdir(f"/proc/{pid}/task")
        except OSError:
            break
        for tid in tids:
            base = f"/proc/{pid}/task/{tid}/"
            t_ns = time.perf_counter_ns()
            stat = read(base + "stat")
            if stat is None:
                continue
            state = stat.rsplit(")", 1)[1].split()[0]
            syscall = read(base + "syscall")
            # Keep number + first two args (fd/uaddr, nfds/op); drop sp/pc noise.
            syscall = " ".join(syscall.split()[:3]) if syscall is not None else None
            row = (read(base + "comm"), state, read(base + "wchan"), syscall)
            if stack_ok:
                stack = read(base + "stack")
                if stack is None:
                    stack_ok = False
                else:
                    row = row + (" <- ".join(line.split()[-1] for line in stack.splitlines()[:6]),)
            if last.get(tid) != row:
                last[tid] = row
                series.setdefault(tid, []).append([t_ns, *row])
        samples += 1
    json.dump({"pid": pid, "start_ns": start, "samples": samples, "stack_readable": stack_ok, "threads": series}, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
