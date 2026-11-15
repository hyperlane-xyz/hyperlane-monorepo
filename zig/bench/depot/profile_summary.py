#!/usr/bin/env python3
"""Tabulate --profile outputs (perf stat counters, strace syscall counts) per workload/impl.

  profile_summary.py RESULT_DIR [RESULT_DIR...] [--syscalls futex,poll,ppoll,epoll_wait]

Reads <workload>/profiles/perf/*.perf-stat.txt and profiles/strace/*.strace.txt
(one profiled pair per workload; multiple process launches, e.g. scraper restart,
are summed per impl).
"""
from __future__ import annotations

import argparse
import collections
import pathlib
import re

COUNTERS = ["task-clock", "context-switches", "cpu-migrations", "page-faults", "cycles", "instructions"]


def perf_stat(path: pathlib.Path) -> dict:
    out = {}
    for line in path.read_text().splitlines():
        parts = line.split()
        if len(parts) >= 2:
            for name in COUNTERS:
                if name in parts[1:3]:
                    try:
                        out[name] = float(parts[0].replace(",", ""))
                    except ValueError:
                        pass
    return out


def strace(path: pathlib.Path) -> dict:
    calls = {}
    for line in path.read_text().splitlines():
        parts = line.split()
        if len(parts) >= 5 and re.fullmatch(r"[\d.]+", parts[0]) and parts[-1] != "total":
            try:
                calls[parts[-1]] = int(parts[3])
            except ValueError:
                pass
    return calls


def collect(directory: pathlib.Path) -> dict:
    table: dict = {}
    for workload in sorted(p for p in directory.iterdir() if (p / "profiles").is_dir()):
        for impl in ("rust", "zig"):
            agg = collections.Counter()
            for f in (workload / "profiles/perf").glob(f"{impl}-*.perf-stat.txt"):
                agg.update(perf_stat(f))
            sys_calls = collections.Counter()
            for f in (workload / "profiles/strace").glob(f"{impl}-*.strace.txt"):
                sys_calls.update(strace(f))
            table[(workload.name, impl)] = {"perf": dict(agg), "strace": dict(sys_calls)}
    return table


def fmt(v):
    if v is None:
        return "–"
    return f"{v / 1e9:.2f}G" if v >= 1e9 else (f"{v / 1e6:.1f}M" if v >= 1e6 else f"{v:,.0f}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("dirs", nargs="+", type=pathlib.Path)
    parser.add_argument("--syscalls", default="futex,poll,ppoll,epoll_wait,epoll_pwait,nanosleep,clock_nanosleep,write,sendto,recvfrom,fdatasync")
    args = parser.parse_args()
    syscalls = args.syscalls.split(",")
    print("| run | workload | impl | task-clock ms | instructions | cycles | ctx sw | page faults | syscalls total | " +
          " | ".join(syscalls) + " |")
    print("|" + "---|" * (9 + len(syscalls)))
    for d in args.dirs:
        for (workload, impl), v in collect(d).items():
            p, s = v["perf"], v["strace"]
            print(f"| {d.name.split('-')[1] if '-' in d.name else d.name} | {workload} | {impl} | {fmt(p.get('task-clock'))} | "
                  f"{fmt(p.get('instructions'))} | {fmt(p.get('cycles'))} | {fmt(p.get('context-switches'))} | "
                  f"{fmt(p.get('page-faults'))} | {fmt(sum(s.values()) if s else None)} | " +
                  " | ".join(fmt(s.get(c)) for c in syscalls) + " |")


if __name__ == "__main__":
    main()
