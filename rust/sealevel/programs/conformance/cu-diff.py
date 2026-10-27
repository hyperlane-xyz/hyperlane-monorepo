#!/usr/bin/env python3
"""Compare CU between two conformance.sh JSON runs (A = baseline, B = candidate).

Pairs invocations per (suite, test, program_id) by order. When the invocation
counts differ (B took a different path, e.g. extra CPIs) the pair falls back to
per-test sums and is flagged; count mismatches are conformance signals too.

ratio = B / A, so > 1 is a regression for B.
"""

import argparse
import json
import statistics
import sys
from collections import defaultdict


def pct(xs, p):
    if not xs:
        return float("nan")
    xs = sorted(xs)
    k = (len(xs) - 1) * p / 100
    lo, hi = int(k), min(int(k) + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def index(run, metric):
    out = defaultdict(list)
    status = {}
    names = {}
    for sname, s in run["suites"].items():
        for tname, t in s["tests"].items():
            status[(sname, tname)] = t["status"]
            for inv in t["invocations"]:
                v = inv.get(metric)
                if v is None:
                    continue
                out[(sname, tname, inv["program_id"])].append(v)
                names[inv["program_id"]] = f"{inv['program']} [{inv['program_id'][:4]}..{inv['program_id'][-4:]}]"
    return out, status, names


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("a", help="baseline JSON (e.g. Rust ELFs)")
    ap.add_argument("b", help="candidate JSON (e.g. goSVM ELFs)")
    ap.add_argument("--metric", choices=["cu", "self_cu"], default="cu",
                    help="cu = inclusive of CPI children (per-transaction view); self_cu = minus BPF children")
    ap.add_argument("--program", action="append", help="only these program names or ids (repeatable)")
    ap.add_argument("--top", type=int, default=10, help="show N worst regressions")
    ap.add_argument("--json", help="write machine-readable summary here")
    args = ap.parse_args()

    a_run, b_run = (json.load(open(p)) for p in (args.a, args.b))
    a, a_status, a_names = index(a_run, args.metric)
    b, b_status, b_names = index(b_run, args.metric)
    names = {**a_names, **b_names}

    def wanted(pid):
        return not args.program or pid in args.program or names.get(pid, "").split(" [")[0] in args.program

    # Test status changes.
    status_changes = []
    # Only suites present in both runs, so a subset run can be compared to a full one.
    common = set(a_run["suites"]) & set(b_run["suites"])
    for key in sorted(k for k in set(a_status) | set(b_status) if k[0] in common):
        sa, sb = a_status.get(key, "missing"), b_status.get(key, "missing")
        if sa != sb:
            status_changes.append({"suite": key[0], "test": key[1], "a": sa, "b": sb})

    per_prog = defaultdict(lambda: {"ratios": [], "a_total": 0, "b_total": 0, "mismatched": 0, "unpaired": 0})
    worst = []
    for key in sorted(set(a) | set(b)):
        pid = key[2]
        if not wanted(pid):
            continue
        xa, xb = a.get(key, []), b.get(key, [])
        p = per_prog[pid]
        if not xa or not xb:
            p["unpaired"] += 1
            continue
        if len(xa) == len(xb):
            pairs = list(zip(xa, xb))
        else:
            p["mismatched"] += 1
            pairs = [(sum(xa), sum(xb))]
        for i, (va, vb) in enumerate(pairs):
            p["a_total"] += va
            p["b_total"] += vb
            if va > 0:
                r = vb / va
                p["ratios"].append(r)
                worst.append((r, key[0], key[1], names.get(pid, pid), i, va, vb, len(xa) != len(xb)))

    summary = {"metric": args.metric, "status_changes": status_changes, "programs": {}}
    hdr = f"{'program':36} {'pairs':>6} {'median':>7} {'p90':>7} {'max':>7} {'min':>7} {'sumA':>12} {'sumB':>12} {'B/A':>6} {'cnt!=':>5} {'unpr':>5}"
    print(f"metric={args.metric}  ratio=B/A  A={args.a}  B={args.b}")
    print(hdr)
    all_ratios = []
    for pid, p in sorted(per_prog.items(), key=lambda kv: names.get(kv[0], kv[0])):
        rs = p["ratios"]
        all_ratios += rs
        row = {
            "program": names.get(pid, pid),
            "pairs": len(rs),
            "median": statistics.median(rs) if rs else None,
            "p90": pct(rs, 90) if rs else None,
            "max": max(rs) if rs else None,
            "min": min(rs) if rs else None,
            "a_total": p["a_total"],
            "b_total": p["b_total"],
            "count_mismatch_tests": p["mismatched"],
            "unpaired_tests": p["unpaired"],
        }
        summary["programs"][pid] = row
        f = lambda v: f"{v:7.3f}" if v is not None else f"{'-':>7}"
        tot = p["b_total"] / p["a_total"] if p["a_total"] else float("nan")
        print(f"{row['program'][:36]:36} {len(rs):6} {f(row['median'])} {f(row['p90'])} {f(row['max'])} {f(row['min'])}"
              f" {p['a_total']:12} {p['b_total']:12} {tot:6.3f} {p['mismatched']:5} {p['unpaired']:5}")
    if all_ratios:
        summary["overall"] = {"pairs": len(all_ratios), "median": statistics.median(all_ratios),
                              "p90": pct(all_ratios, 90), "max": max(all_ratios), "min": min(all_ratios)}
        o = summary["overall"]
        print(f"{'ALL':36} {o['pairs']:6} {o['median']:7.3f} {o['p90']:7.3f} {o['max']:7.3f} {o['min']:7.3f}")

    worst.sort(reverse=True)
    summary["worst"] = [
        {"ratio": r, "suite": s, "test": t, "program": prog, "index": i, "a": va, "b": vb, "count_mismatch": mm}
        for r, s, t, prog, i, va, vb, mm in worst[: args.top]
    ]
    if worst and args.top:
        print(f"\nworst {args.top} (ratio suite::test program[#i] A->B):")
        for w in summary["worst"]:
            tag = " (sum, count mismatch)" if w["count_mismatch"] else ""
            print(f"  {w['ratio']:.3f} {w['suite']}::{w['test']} {w['program']}[#{w['index']}] {w['a']}->{w['b']}{tag}")

    if status_changes:
        print(f"\nstatus changes ({len(status_changes)}):")
        for c in status_changes:
            print(f"  {c['suite']}::{c['test']}: {c['a']} -> {c['b']}")

    if args.json:
        with open(args.json, "w") as fh:
            json.dump(summary, fh, indent=1)
    sys.exit(1 if status_changes else 0)


if __name__ == "__main__":
    main()
