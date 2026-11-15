#!/usr/bin/env python3
"""Workload catalogue and selection for the Depot paired Rust/Zig bench.

Selection sources, highest priority first:
  1. explicit CLI/env value (workflow_dispatch input BENCH_WORKLOADS / BENCH_PAIRS)
  2. zig/bench/depot/selection.json (written by run.sh; travels in the Depot patch)
  3. defaults: all workloads, 5 pairs

Selectors are workload names, or prefixes/aliases matched against them:
  all, validator, scraper, relayer, safe, fast, validator-fast, relayer-batch4 ...
A selector matches every workload whose name contains all of its '-' tokens.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib

HERE = pathlib.Path(__file__).resolve().parent

# name -> (role, mode, params). Params mirror zig/bench/paired_linux_methods.json.
WORKLOADS: dict[str, dict] = {}
for _mode, _tag in (("ReleaseSafe", "safe"), ("ReleaseFast", "fast")):
    for _consensus in ("majority", "fallback"):
        WORKLOADS[f"validator-{_consensus}-{_tag}"] = {
            "role": "validator", "mode": _mode,
            "params": {"consensus": _consensus, "catchup": 32, "steady": 8, "steady_interval_ms": 1000},
        }
    WORKLOADS[f"scraper-{_tag}"] = {
        "role": "scraper", "mode": _mode,
        "params": {"catchup": 100, "fresh": 10, "fresh_interval_ms": 250, "chunk": 50, "interval": 1, "deadline": 120},
    }
    for _label, _batch in (("single", 1), ("batch4", 4)):
        WORKLOADS[f"relayer-{_label}-{_tag}"] = {
            "role": "relayer", "mode": _mode,
            "params": {"catchup": 32, "steady": 8, "steady_interval_ms": 500, "max_batch_size": _batch},
        }


def select(selectors: list[str]) -> list[str]:
    chosen: list[str] = []
    for raw in selectors:
        sel = raw.strip().lower()
        if not sel:
            continue
        if sel == "all":
            matches = list(WORKLOADS)
        elif sel in WORKLOADS:
            matches = [sel]
        else:
            tokens = sel.split("-")
            matches = [name for name in WORKLOADS if all(t in name.split("-") for t in tokens)]
        if not matches:
            raise SystemExit(f"unknown workload selector {raw!r}; known: {', '.join(WORKLOADS)}")
        chosen += [m for m in matches if m not in chosen]
    return chosen


def resolve(workloads: str | None, pairs: str | None) -> tuple[list[str], int]:
    file = HERE / "selection.json"
    data = json.loads(file.read_text()) if file.is_file() else {}
    raw = workloads or data.get("workloads") or ["all"]
    if isinstance(raw, str):
        raw = raw.replace(",", " ").split()
    n = int(pairs or data.get("pairs") or 5)
    if n < 1:
        raise SystemExit("pairs must be >= 1")
    return select(raw), n


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--workloads", default=os.environ.get("BENCH_WORKLOADS") or None)
    parser.add_argument("--pairs", default=os.environ.get("BENCH_PAIRS") or None)
    parser.add_argument("--github-output", action="store_true", help="append matrix/pairs to $GITHUB_OUTPUT")
    args = parser.parse_args()
    names, pairs = resolve(args.workloads, args.pairs)
    print(json.dumps({"workloads": names, "pairs": pairs}))
    if args.github_output:
        with open(os.environ["GITHUB_OUTPUT"], "a") as out:
            out.write(f"workloads={json.dumps(names)}\n")
            out.write(f"pairs={pairs}\n")


if __name__ == "__main__":
    main()
