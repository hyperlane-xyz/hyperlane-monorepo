#!/usr/bin/env python3
"""Top context-switch sites from --profile sched_switch folded stacks.

  sched_sites.py RESULT_DIR [--workload relayer-single-safe] [--impl zig] [--top 10] [--depth 3]

Reads <workload>/profiles/sched/<impl>-<role>.sched.folded (keys 'comm/pid/tid;root;...;leaf N'),
groups each switch by the innermost user-space frames above the blocking syscall/sync primitive,
and prints counts plus a per-thread-name split. Counts are switches out of the agent's threads
(voluntary + preemption) in the one profiled pair.
"""
from __future__ import annotations

import argparse
import collections
import pathlib
import re

PLUMBING = re.compile(r"^(os\.|posix\.|Thread\.(Futex|Mutex|Condition|ResetEvent|Semaphore|Pool|PosixThreadImpl|callFn|join)|atomic\.|"
                      r"curl_|Curl_|multi_|easy_|__|_|fsync$|fdatasync$|epoll_|poll$|syscall$|start\.|main$|net\.curl_multi\.failed|"
                      r"rocksdb::|std::|<|lll_)")
PRIMITIVE = re.compile(r"Thread\.(Condition|Mutex|Futex|ResetEvent|Semaphore)\.\w+|curl_multi_poll|curl_easy_perform|rocksdb::PosixWritableFile::Sync|rocksdb::\w+::Fsync\w*")


def sites(path: pathlib.Path, depth: int):
    total = 0
    by_site: collections.Counter = collections.Counter()
    by_thread: collections.Counter = collections.Counter()
    for line in path.read_text().splitlines():
        stack, _, count = line.rpartition(" ")
        if not count.isdigit():
            continue
        n = int(count)
        total += n
        frames = stack.split(";")
        thread = frames[0].split("/")[0]
        by_thread[thread] += n
        body = frames[1:]
        # user frames come first (root -> leaf), then kernel frames from the syscall/exception entry
        cut = next((i for i, f in enumerate(body) if f.startswith(("entry_SYSCALL", "asm_", "ret_from_fork"))), len(body))
        user = [f.split(" (inlined)")[0] for f in body[:cut] if not f.startswith(("0x", "["))]
        kernel = body[cut:]
        syscall = next((f.replace("__x64_sys_", "") for f in kernel if f.startswith("__x64_sys_")), "")
        # skip syscall/sync plumbing to reach the application frames that decided to block
        app = [f for f in user if not PLUMBING.match(f)]
        prim = next((f for f in reversed(user) if PRIMITIVE.search(f)), "")
        if prim.startswith("Thread.") and syscall != "futex":
            prim = ""  # stale fp leaf frame, not the blocking primitive
        chain = app[-depth:]
        site = " <- ".join(reversed([c[:60] for c in chain])) or "(no app frames)"
        if prim:
            site = f"{prim.split('(')[0][:40]} <- {site}"
        by_site[f"[{syscall or (kernel[0] if kernel else '?')}] {site}"] += n
    return total, by_site, by_thread


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("dirs", nargs="+", type=pathlib.Path)
    parser.add_argument("--workload")
    parser.add_argument("--impl", default="zig")
    parser.add_argument("--top", type=int, default=10)
    parser.add_argument("--depth", type=int, default=3)
    args = parser.parse_args()
    for d in args.dirs:
        for folded in sorted(d.glob(f"*/profiles/sched/{args.impl}-*.sched.folded")):
            workload = folded.parts[-4]
            if args.workload and workload != args.workload:
                continue
            total, by_site, by_thread = sites(folded, args.depth)
            print(f"== {d.resolve().name} {workload} {args.impl}: {total} switches")
            print("   threads: " + ", ".join(f"{k} {v}" for k, v in by_thread.most_common(6)))
            for site, n in by_site.most_common(args.top):
                print(f"   {n:6d} {100 * n / max(total, 1):5.1f}%  {site}")


if __name__ == "__main__":
    main()
