#!/usr/bin/env python3
"""Parse solana-program-test suite logs into a conformance/CU JSON report.

Input: one log per suite, produced by conformance.sh with
  RUST_LOG=solana_runtime::message_processor::stable_log=debug,solana_program_test=info
and libtest `--test-threads=1 -Z unstable-options --format json`, stdout+stderr merged.

Serial execution makes attribution exact: every log line between a test's
"started" and its result event belongs to that test.
"""

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone

# Program ids used by the functional tests -> human name. Unknown ids stay raw.
PROGRAM_NAMES = {
    "692KZJaoe2KRcD6uhCQDLLXnLNA5ZLnfvdqjE4aX9iu1": "mailbox",
    "BSffRJEwRcyEkjnbjAMMfv9kv3Y3SauxsBjCdNJyM2BN": "igp",
    "CWVYdRomCv3bksSsRTuds9SRR5y17Ft5nPqhaXjp4tnb": "test_ism",
    "FZ8hyduJy4GQAfBu9zEiuQtk429Gjc6inwHgEW5MvsEm": "test_send_receiver",
    "DH43ae1LwemXAboWwSh8zc9pG8j72gKUEXNi57w8fEnn": "validator_announce",
    "2YjtZDiUoptoSsA5eVrDCcX6wxNK6YoEVW7y82x5Z2fw": "multisig_ism_message_id",
    "CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8": "multisig_ism_message_id",
    "Bprmwvw4fCr1fXF4y3qq7JyNiVwb5JNpkVRqxqMhQgau": "composite_ism",
    "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR": "composite_ism",
    "8opHzTAnfzRpPEx21XtnrVTX28YQuCpAjcn1PczScKh": "mock_mailbox(native)",
    "3MzUPjP5LEkiHH82nEAe28Xtz9ztuMqWc8UmuKxrpVQH": "token",
    "G8t1qe3YnYvhi1zS9ioUXuVFkwhBgvfHaLJt5X6PF18z": "token_collateral",
    "CGn8yNtSD3aTTqJfYhUb6s1aVTN75NzwtsFKo1e83aga": "token_native",
    "CCo11atera1TokenProgram111111111111111111111": "token_cross_collateral",
    "CCo11atera1TokenProgram222222222222222222222": "token_cross_collateral",
    "Fee1111111111111111111111111111111111111111": "fee",
    "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx": "malicious_igp(native)",
    "noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV": "spl_noop",
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA": "spl_token",
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb": "spl_token_2022",
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL": "spl_associated_token_account",
    "11111111111111111111111111111111": "system",
    "ComputeBudget111111111111111111111111111111": "compute_budget",
}

# Native programs the harness tolerates as builtins in BPF mode (test-only mocks).
BUILTIN_ALLOWLIST = {"mock_mailbox", "malicious_igp"}

ANSI = re.compile(r"\x1b\[[0-9;]*m")
RUNNING = re.compile(r"^\s*Running (\S+(?: \S+)?) \((.+)\)\s*$")
INVOKE = re.compile(r"Program (\w+) invoke \[(\d+)\]")
CONSUMED = re.compile(r"Program (\w+) consumed (\d+) of (\d+) compute units")
SUCCESS = re.compile(r"Program (\w+) success")
FAILED = re.compile(r"Program (\w+) failed: (.*)$")
SBF_LOADED = re.compile(r'"([\w-]+)" SBF program from (\S+?)(?:,|$)')
BUILTIN_LOADED = re.compile(r'"([\w-]+)" builtin program')


def new_test():
    return {
        "status": "unknown",
        "exec_time_s": None,
        "sbf_programs": {},
        "builtin_programs": [],
        "invocations": [],
    }


def finish_frame(test, stack, ok, error=None):
    if not stack:
        return
    frame = stack.pop()
    inv = frame["inv"]
    inv["ok"] = ok
    if error:
        inv["error"] = error
    if inv["cu"] is not None:
        inv["self_cu"] = inv["cu"] - frame["child_cu"]
    if stack and inv["cu"] is not None:
        stack[-1]["child_cu"] += inv["cu"]


def parse_suite(path):
    suite = {
        "log": path,
        "binaries": [],
        "tests": {},
        "passed": 0,
        "failed": 0,
        "ignored": 0,
        "unattributed_invocations": 0,
    }
    binary = None
    cur_name = None
    cur = None
    stack = []
    ix_seq = 0

    with open(path, errors="replace") as f:
        for raw in f:
            line = ANSI.sub("", raw.rstrip("\n"))
            m = RUNNING.match(line)
            if m:
                binary = m.group(1)
                suite["binaries"].append(binary)
                continue
            if line.startswith("{") and '"type"' in line:
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    ev = None
                if ev and ev.get("type") == "test":
                    event = ev.get("event")
                    name = ev.get("name")
                    if event == "started":
                        cur_name, cur, stack, ix_seq = name, new_test(), [], 0
                        cur["binary"] = binary
                        suite["tests"][name] = cur
                    elif event in ("ok", "failed", "ignored", "timeout"):
                        t = suite["tests"].setdefault(name, new_test())
                        t["status"] = {"ok": "passed", "timeout": "failed"}.get(
                            event, event
                        )
                        if "exec_time" in ev:
                            t["exec_time_s"] = ev["exec_time"]
                        if event == "failed" and ev.get("stdout"):
                            t["failure_output_tail"] = ev["stdout"][-2000:]
                        key = t["status"] if t["status"] in suite else None
                        if key:
                            suite[key] += 1
                        while stack:
                            finish_frame(t, stack, False, "unterminated")
                        cur_name, cur = None, None
                    continue
                if ev is not None:
                    continue
            m = SBF_LOADED.search(line)
            if m and cur is not None:
                cur["sbf_programs"][m.group(1)] = m.group(2)
                continue
            m = BUILTIN_LOADED.search(line)
            if m and cur is not None:
                if m.group(1) not in cur["builtin_programs"]:
                    cur["builtin_programs"].append(m.group(1))
                continue
            if "Program " not in line:
                continue
            m = INVOKE.search(line)
            if m:
                if cur is None:
                    suite["unattributed_invocations"] += 1
                    continue
                depth = int(m.group(2))
                # A new top-level invoke means any stale frames were abandoned.
                while stack and len(stack) >= depth:
                    finish_frame(cur, stack, False, "unterminated")
                if depth == 1:
                    ix_seq += 1
                pid = m.group(1)
                inv = {
                    "ix": ix_seq,
                    "program_id": pid,
                    "program": PROGRAM_NAMES.get(pid, pid),
                    "depth": depth,
                    "cu": None,
                    "limit": None,
                }
                cur["invocations"].append(inv)
                stack.append({"inv": inv, "child_cu": 0})
                continue
            if cur is None:
                continue
            m = CONSUMED.search(line)
            if m:
                if stack and stack[-1]["inv"]["program_id"] == m.group(1):
                    stack[-1]["inv"]["cu"] = int(m.group(2))
                    stack[-1]["inv"]["limit"] = int(m.group(3))
                continue
            m = SUCCESS.search(line)
            if m:
                finish_frame(cur, stack, True)
                continue
            m = FAILED.search(line)
            if m:
                finish_frame(cur, stack, False, m.group(2)[:200])
                continue

    suite["total"] = len(suite["tests"])
    sbf, builtin = set(), set()
    for t in suite["tests"].values():
        sbf.update(t["sbf_programs"])
        builtin.update(t["builtin_programs"])
        # Builtins (system program, native mocks) never log "consumed"; drop them.
        t["invocations"] = [i for i in t["invocations"] if i["cu"] is not None]
    suite["sbf_programs"] = sorted(sbf)
    suite["builtin_programs"] = sorted(builtin)
    suite["unexpected_builtins"] = sorted(builtin - BUILTIN_ALLOWLIST)
    suite["bpf_executions"] = sum(len(t["invocations"]) for t in suite["tests"].values())
    return suite


def pct(xs, p):
    xs = sorted(xs)
    k = (len(xs) - 1) * p / 100
    lo, hi = int(k), min(int(k) + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def write_md(report, path):
    lines = [
        f"# Conformance run: {report['elf_dir']}",
        "",
        f"Generated {report['generated_at']}.",
        "",
        "## Suites",
        "",
        "| suite | tests | passed | failed | ignored | SBF invocations | SBF programs loaded | native builtins |",
        "|---|---:|---:|---:|---:|---:|---|---|",
    ]
    tot = {"total": 0, "passed": 0, "failed": 0, "ignored": 0, "bpf_executions": 0}
    for name, s in report["suites"].items():
        for k in tot:
            tot[k] += s[k]
        lines.append(
            f"| {name} | {s['total']} | {s['passed']} | {s['failed']} | {s['ignored']} | {s['bpf_executions']}"
            f" | {', '.join(s['sbf_programs'])} | {', '.join(s['builtin_programs']) or '-'} |"
        )
    lines.append(
        f"| **total** | {tot['total']} | {tot['passed']} | {tot['failed']} | {tot['ignored']} | {tot['bpf_executions']} | | |"
    )
    failed = [
        (sn, tn) for sn, s in report["suites"].items() for tn, t in s["tests"].items() if t["status"] == "failed"
    ]
    if failed:
        lines += ["", "## Failed tests", ""] + [f"- {sn}::{tn}" for sn, tn in failed]

    by_prog = {}
    for s in report["suites"].values():
        for t in s["tests"].values():
            for inv in t["invocations"]:
                label = f"{inv['program']} [{inv['program_id'][:4]}..{inv['program_id'][-4:]}]"
                d = by_prog.setdefault(label, {"all": [], "top": [], "self": [], "tests": set()})
                d["all"].append(inv["cu"])
                d["tests"].add(id(t))
                if inv["depth"] == 1:
                    d["top"].append(inv["cu"])
                if inv.get("self_cu") is not None:
                    d["self"].append(inv["self_cu"])
    lines += [
        "",
        "## CU per program",
        "",
        "`cu` is inclusive of CPI children (the per-transaction view when depth 1); `self` subtracts BPF children.",
        "",
        "| program | tests | invocations | top-level | cu median | cu p90 | cu max | self median | self p90 | total cu |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for prog, d in sorted(by_prog.items()):
        a, sf = d["all"], d["self"] or [0]
        lines.append(
            f"| {prog} | {len(d['tests'])} | {len(a)} | {len(d['top'])} | {pct(a, 50):.0f} | {pct(a, 90):.0f}"
            f" | {max(a)} | {pct(sf, 50):.0f} | {pct(sf, 90):.0f} | {sum(a)} |"
        )
    lines += ["", "## ELFs", "", "| file | sha256 | resolved path |", "|---|---|---|"]
    for name, e in report["elfs"].items():
        lines.append(f"| {name} | `{e['sha256'][:16]}` | {e['path']} |")
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--elf-dir", required=True)
    ap.add_argument("--staging-dir", required=True)
    ap.add_argument("--exit-codes", help="file with '<suite> <exit-code>' lines")
    ap.add_argument("--out", required=True)
    ap.add_argument("--md", help="also write a markdown summary here")
    ap.add_argument("logs", nargs="+", help="<suite>=<logfile>")
    args = ap.parse_args()

    exit_codes = {}
    if args.exit_codes and os.path.exists(args.exit_codes):
        for line in open(args.exit_codes):
            parts = line.split()
            if len(parts) == 2:
                exit_codes[parts[0]] = int(parts[1])

    elfs = {}
    for name in sorted(os.listdir(args.staging_dir)):
        p = os.path.join(args.staging_dir, name)
        if name.endswith(".so"):
            elfs[name] = {"path": os.path.realpath(p), "sha256": sha256(p)}

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "elf_dir": os.path.realpath(args.elf_dir),
        "elfs": elfs,
        "suites": {},
    }
    for spec in args.logs:
        name, path = spec.split("=", 1)
        s = parse_suite(path)
        s["exit_code"] = exit_codes.get(name)
        report["suites"][name] = s

    with open(args.out, "w") as f:
        json.dump(report, f, indent=1)
    if args.md:
        write_md(report, args.md)

    # Human summary to stdout.
    print(f"{'suite':38} {'pass':>5} {'fail':>5} {'ign':>4} {'total':>5} {'bpf_ix':>7}  notes")
    bad = False
    for name, s in report["suites"].items():
        notes = []
        if s["exit_code"] not in (0, None):
            notes.append(f"exit={s['exit_code']}")
        if s["total"] and not s["sbf_programs"]:
            notes.append("NO SBF PROGRAMS LOADED")
        if s["unexpected_builtins"]:
            notes.append("builtins:" + ",".join(s["unexpected_builtins"]))
        if s["total"] == 0:
            notes.append("no tests parsed")
        if s["failed"] or notes:
            bad = True
        print(
            f"{name:38} {s['passed']:5} {s['failed']:5} {s['ignored']:4} {s['total']:5}"
            f" {s['bpf_executions']:7}  {' '.join(notes)}"
        )
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
