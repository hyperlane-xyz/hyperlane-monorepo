#!/usr/bin/env python3
"""A/B two Depot bench result directories (e.g. baseline ref vs HEAD).

  compare.py zig/bench/results/depot/<A> zig/bench/results/depot/<B> [--metrics catchup_ms,cpu_s,...]

Per workload and metric: Rust median A/B (a host-consistency check: the Rust
artifact is the same, so it should barely move), Zig median A/B, Zig B/A, and
Zig/Rust in each run. Writes compare.md next to B (prints it too).
"""
from __future__ import annotations

import argparse
import json
import pathlib

DEFAULT = ["startup_ms", "catchup_ms", "freshness_median_ms", "e2e_latency_median_ms", "deliveries_per_s", "cpu_s",
           "cpu_util_pct", "peak_rss_mib", "rpc_requests", "db_statements", "ctx_voluntary", "minor_faults"]


def load(directory: pathlib.Path) -> tuple[dict, dict]:
    data = json.loads((directory / "summary" / "summary.json").read_text())
    if isinstance(data, list):
        return {}, {s["workload"]: s for s in data}
    return data.get("provenance") or {}, {s["workload"]: s for s in data["workloads"]}


def fmt(v):
    if v is None:
        return "–"
    return f"{v:,.0f}" if abs(v) >= 100 else (f"{v:.2f}" if abs(v) >= 1 else f"{v:.3f}")


def med(entry, impl):
    return entry[impl]["median"] if entry and entry.get(impl) else None


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("a", type=pathlib.Path)
    parser.add_argument("b", type=pathlib.Path)
    parser.add_argument("--metrics", default=",".join(DEFAULT))
    args = parser.parse_args()
    pa, wa = load(args.a)
    pb, wb = load(args.b)
    metrics = args.metrics.split(",")

    def label(p, d):
        return f"`{(p.get('local_head') or '?')[:10]}` (tree `{(p.get('source_tree') or '?')[:10]}`, {d.name})"

    out = ["# A/B: Zig change between two bench runs", "",
           f"A = {label(pa, args.a)}", f"B = {label(pb, args.b)}", "",
           "Rust A/B should be ~1.00 (same Rust artifact, different hosts/time); Zig B/A < 1 means B is lower.", ""]
    for name in [w for w in wa if w in wb]:
        a, b = wa[name]["metrics"], wb[name]["metrics"]
        out += [f"## {name}", "", "| metric | Rust A | Rust B | Rust B/A | Zig A | Zig B | Zig B/A | Zig/Rust A | Zig/Rust B |",
                "|---|---|---|---|---|---|---|---|---|"]
        for m in metrics:
            if m not in a and m not in b:
                continue
            ra, rb, za, zb = med(a.get(m), "rust"), med(b.get(m), "rust"), med(a.get(m), "zig"), med(b.get(m), "zig")
            def ratio(x, y):
                return y / x if x and y is not None else None
            out.append(f"| {m} | {fmt(ra)} | {fmt(rb)} | {fmt(ratio(ra, rb))} | {fmt(za)} | {fmt(zb)} | {fmt(ratio(za, zb))} | "
                       f"{fmt(ratio(ra, za))} | {fmt(ratio(rb, zb))} |")
        out.append("")
    text = "\n".join(out) + "\n"
    (args.b / "compare.md").write_text(text)
    print(text)


if __name__ == "__main__":
    main()
