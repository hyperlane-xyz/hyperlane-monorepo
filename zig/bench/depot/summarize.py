#!/usr/bin/env python3
"""Summarise Depot paired-bench results: summary.json + summary.md.

Input: a directory containing */result.json (one per workload, from bench.py).
For every metric: median and min-max per implementation over completed runs,
and Zig/Rust = median(zig) / median(rust). Lower is better for every metric
except deliveries_per_s.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import statistics

HIGHER_IS_BETTER = {"deliveries_per_s"}
ORDER = ["startup_ms", "catchup_ms", "post_ready_catchup_ms", "deliveries_per_s", "freshness_median_ms", "freshness_max_ms",
         "e2e_latency_median_ms", "e2e_latency_p95_ms", "steady_ms", "restart_catchup_ms", "cpu_s", "cpu_user_s", "cpu_sys_s",
         "restart_cpu_s", "peak_rss_mib", "shutdown_ms", "restart_shutdown_ms", "process_wall_s", "rpc_requests",
         "rpc_requests_catchup", "transactions", "db_statements", "db_rows", "db_exec_ms", "db_bytes"]


def stats(values):
    values = [v for v in values if v is not None]
    if not values:
        return None
    return {"median": statistics.median(values), "min": min(values), "max": max(values), "n": len(values)}


def fmt(value):
    if value is None:
        return "–"
    if abs(value) >= 1000:
        return f"{value:,.0f}"
    if abs(value) >= 100:
        return f"{value:.0f}"
    if abs(value) >= 10:
        return f"{value:.1f}"
    return f"{value:.2f}" if abs(value) >= 1 else f"{value:.3f}"


def summarise(result: dict) -> dict:
    rows = result.get("rows", [])
    metrics = [m for m in ORDER if any(m in r["metrics"] for r in rows)]
    metrics += sorted({m for r in rows for m in r["metrics"]} - set(metrics))
    table = {}
    for metric in metrics:
        per = {impl: stats([r["metrics"].get(metric) for r in rows if r["impl"] == impl]) for impl in ("rust", "zig")}
        ratio = None
        if per["rust"] and per["zig"] and per["rust"]["median"]:
            ratio = per["zig"]["median"] / per["rust"]["median"]
        # Paired view: per-pair zig/rust ratios (pairs where both arms completed).
        pairs = []
        for pair in sorted({r["pair"] for r in rows}):
            a = next((r["metrics"].get(metric) for r in rows if r["impl"] == "rust" and r["pair"] == pair), None)
            b = next((r["metrics"].get(metric) for r in rows if r["impl"] == "zig" and r["pair"] == pair), None)
            if a and b is not None:
                pairs.append(b / a)
        table[metric] = {**per, "zig_over_rust": ratio, "paired_ratio_median": statistics.median(pairs) if pairs else None}
    methods = {}
    for impl in ("rust", "zig"):
        impl_rows = [r for r in rows if r["impl"] == impl]
        names = sorted({m for r in impl_rows for m in r.get("rpc_methods", {})})
        methods[impl] = {m: statistics.median([r.get("rpc_methods", {}).get(m, 0) for r in impl_rows]) for m in names}
    host = result.get("host", {})
    return {
        "workload": result.get("workload"), "role": result.get("role"), "mode": result.get("mode"),
        "passed": result.get("passed"), "completed": result.get("completed"), "pairs_requested": result.get("pairs_requested"),
        "failures": result.get("failures"), "harness_exit_code": result.get("harness_exit_code"),
        "host": {"cpu_model": host.get("cpu_model"), "nproc": host.get("nproc"), "kernel": host.get("kernel")},
        "cpu_placement": result.get("cpu_placement"),
        "load_before": (result.get("host_before") or {}).get("loadavg"),
        "load_after": (result.get("host_after") or {}).get("loadavg"),
        "host_cpu_busy_fraction": result.get("host_cpu_busy_fraction"),
        "duration_s": result.get("duration_s"),
        "metrics": table, "rpc_methods_median": methods,
    }


def markdown(summaries: list[dict]) -> str:
    out = ["# Zig vs Rust paired benchmark", ""]
    if summaries:
        h = summaries[0]["host"]
        out.append(f"Runner: {h.get('cpu_model')}, {h.get('nproc')} vCPU, kernel {h.get('kernel')}; "
                   f"agents pinned to {summaries[0]['cpu_placement']['agent_cpus']}, fixtures to {summaries[0]['cpu_placement']['fixture_cpus']}.")
        out.append("Zig/Rust = median(Zig) / median(Rust); < 1 means Zig lower (better, except deliveries_per_s).")
        out.append("")
        out.append("| workload | runs R/Z | catchup | freshness/e2e p50 | CPU | peak RSS | RPC | status |")
        out.append("|---|---|---|---|---|---|---|---|")
        for s in summaries:
            m = s["metrics"]
            fresh = m.get("freshness_median_ms") or m.get("e2e_latency_median_ms") or {}
            def r(entry):
                return fmt(entry.get("zig_over_rust")) if entry else "–"
            status = "ok" if s["passed"] else f"FAIL ({len(s.get('failures') or [])} failures, exit {s.get('harness_exit_code')})"
            comp = s.get("completed") or {}
            out.append(f"| {s['workload']} | {comp.get('rust', 0)}/{comp.get('zig', 0)} | {r(m.get('catchup_ms'))} | {r(fresh)} | "
                       f"{r(m.get('cpu_s'))} | {r(m.get('peak_rss_mib'))} | {r(m.get('rpc_requests'))} | {status} |")
        out.append("")
    for s in summaries:
        load_b = s.get("load_before") or [None]
        load_a = s.get("load_after") or [None]
        busy = s.get("host_cpu_busy_fraction")
        out.append(f"## {s['workload']}")
        out.append("")
        out.append(f"{s['role']} {s['mode']}; completed rust={s['completed'].get('rust', 0) if s.get('completed') else 0} "
                   f"zig={s['completed'].get('zig', 0) if s.get('completed') else 0} of {s.get('pairs_requested')}; "
                   f"load1 before {fmt(load_b[0])} after {fmt(load_a[0])}; host busy {fmt(busy * 100 if busy is not None else None)}%; "
                   f"duration {fmt(s.get('duration_s'))} s; host {s['host'].get('cpu_model')} x{s['host'].get('nproc')}")
        out.append("")
        if s["metrics"]:
            out.append("| metric | Rust median (min–max) | Zig median (min–max) | Zig/Rust | paired |")
            out.append("|---|---|---|---|---|")
            for name, e in s["metrics"].items():
                def cell(x):
                    return f"{fmt(x['median'])} ({fmt(x['min'])}–{fmt(x['max'])})" if x else "–"
                out.append(f"| {name} | {cell(e['rust'])} | {cell(e['zig'])} | {fmt(e['zig_over_rust'])} | {fmt(e['paired_ratio_median'])} |")
            out.append("")
            rm, zm = s["rpc_methods_median"]["rust"], s["rpc_methods_median"]["zig"]
            names = sorted(set(rm) | set(zm), key=lambda k: -(rm.get(k, 0) + zm.get(k, 0)))
            if names:
                out.append("RPC median per run by method (Rust / Zig): " + ", ".join(f"`{n}` {fmt(rm.get(n, 0))}/{fmt(zm.get(n, 0))}" for n in names))
                out.append("")
        for f in s.get("failures") or []:
            text = f.get("error") or "".join(f.get("message_chunks") or f.get("error_chunks") or [])
            who = f"{f.get('implementation')} pair {f.get('sample')}"
            out.append(f"- failure {who}: `{text[:400].replace('`', '')}`")
        if s.get("failures"):
            out.append("")
    return "\n".join(out) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("results", type=pathlib.Path)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    summaries = []
    for path in sorted(args.results.glob("**/result.json")):
        if "raw" in path.parts:
            continue
        summaries.append(summarise(json.loads(path.read_text())))
    order = {"validator": 0, "scraper": 1, "relayer": 2}
    summaries.sort(key=lambda s: (order.get(s["role"], 9), s["workload"]))
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "summary.json").write_text(json.dumps(summaries, indent=2) + "\n")
    (args.output / "summary.md").write_text(markdown(summaries))
    print(f"{len(summaries)} workloads summarised -> {args.output}")


if __name__ == "__main__":
    main()
