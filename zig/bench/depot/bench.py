#!/usr/bin/env python3
"""Run one paired Rust/Zig workload on this host and normalise the results.

Wraps the existing role harnesses without their approval/hash-pinning ceremony:
  validator -> zig/bench/depot/validator_run.py -> zig/bench/validator.py
               (checkpoint roots/ids vs Rust reference, signatures recovered; publication
               predicate ignores merkle_snapshot.json, see validator_run.py)
  scraper   -> zig/bench/scraper.py    (all four event streams, receipt links, restart replay)
  relayer   -> zig/bench/depot/relayer_bench.py (on-chain delivery of every message, nonce/tx accounting)
Each harness runs both implementations on this machine in alternating order
(pair i: rust,zig when i is even, zig,rust when odd).

CPU placement: agents run under `taskset -c <agent cpus>`; this process, Anvil,
RPC proxies, Postgres (docker --cpuset-cpus) and other fixtures stay on the
disjoint fixture CPUs. Host load is recorded, never gated on.

Logging parity: Rust reads `log.{level,format}` (or HYP_LOG_*), not the
harnesses' `tracing` key, so it silently ran at INFO/pretty (~2.5 MB/run) while
Zig logs only warnings/errors. The Rust exec wrapper sets HYP_LOG_LEVEL
(default `error`, the level the harness configs ask for) and HYP_LOG_FORMAT=json.

Output (--output DIR): result.json (normalised rows + host info), raw/ (harness output), logs.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import platform
import shutil
import statistics
import subprocess
import sys
import time
from datetime import datetime, timezone

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(HERE))
import workloads as catalogue  # noqa: E402


def sh(*argv: str) -> str | None:
    try:
        return subprocess.run(argv, capture_output=True, text=True, timeout=30).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None


def cpu_times() -> list[int]:
    return [int(x) for x in pathlib.Path("/proc/stat").read_text().splitlines()[0].split()[1:]]


def host_snapshot() -> dict:
    snap = {
        "utc": datetime.now(timezone.utc).isoformat(),
        "loadavg": os.getloadavg(),
        "cpu_times": cpu_times(),
    }
    mem = {}
    for line in pathlib.Path("/proc/meminfo").read_text().splitlines()[:3]:
        key, value = line.split(":", 1)
        mem[key] = value.strip()
    snap["meminfo"] = mem
    snap["top"] = sh("sh", "-c", "ps -eo pid,pcpu,pmem,etime,comm --sort=-pcpu | head -12")
    return snap


def host_info() -> dict:
    lscpu = sh("lscpu") or ""
    model = next((line.split(":", 1)[1].strip() for line in lscpu.splitlines() if line.startswith("Model name")), None)
    return {
        "cpu_model": model,
        "nproc": os.cpu_count(),
        "kernel": platform.release(),
        "platform": platform.platform(),
        "lscpu": lscpu,
        "runner": os.environ.get("RUNNER_NAME"),
        "docker": sh("docker", "version", "--format", "{{.Server.Version}}"),
        "anvil": sh("anvil", "--version"),
        "python": sys.version,
    }


def split_cpus(spec_agent: str | None, spec_fixture: str | None) -> tuple[list[int], list[int]]:
    def parse(spec: str) -> list[int]:
        out: list[int] = []
        for part in spec.split(","):
            lo, _, hi = part.partition("-")
            out += list(range(int(lo), int(hi or lo) + 1))
        return out

    available = sorted(os.sched_getaffinity(0))
    if spec_agent and spec_fixture:
        return parse(spec_agent), parse(spec_fixture)
    half = len(available) // 2
    if half < 2:
        return available, available
    return available[half:], available[:half]


def cpu_spec(cpus: list[int]) -> str:
    return ",".join(str(c) for c in cpus)


RUST_LOG_LEVEL = os.environ.get("BENCH_RUST_LOG_LEVEL", "error")


def make_wrappers(bins: pathlib.Path, mode: str, agent_cpus: list[int], work: pathlib.Path) -> dict[str, dict[str, pathlib.Path]]:
    """Tiny exec wrappers: same pid/rusage as the real binary, pinned to agent CPUs."""
    taskset = shutil.which("taskset")
    assert taskset, "taskset (util-linux) required"
    zig_dir = {"ReleaseSafe": "zig-safe", "ReleaseFast": "zig-fast"}[mode]
    out: dict[str, dict[str, pathlib.Path]] = {"rust": {}, "zig": {}}
    for impl, sub in (("rust", "rust"), ("zig", zig_dir)):
        for role in ("relayer", "validator", "scraper"):
            real = (bins / sub / role).resolve(strict=True)
            wrapper = work / "wrap" / impl / role
            wrapper.parent.mkdir(parents=True, exist_ok=True)
            env = f"HYP_LOG_LEVEL={RUST_LOG_LEVEL} HYP_LOG_FORMAT=json " if impl == "rust" else ""
            wrapper.write_text(f'#!/bin/sh\n{env}exec {taskset} -c {cpu_spec(agent_cpus)} {real} "$@"\n')
            wrapper.chmod(0o755)
            out[impl][role] = wrapper
    return out


def binary_identity(bins: pathlib.Path) -> dict:
    manifest = bins / "build-manifest.json"
    return json.loads(manifest.read_text()) if manifest.is_file() else {}


# ------------------------------------------------------------------ runners

def run_harness(argv: list[str], log: pathlib.Path, env: dict | None = None) -> int:
    print("+", " ".join(argv), flush=True)
    with log.open("w") as stream:
        proc = subprocess.Popen(argv, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
        assert proc.stdout is not None
        for line in proc.stdout:
            sys.stdout.write(line)
            stream.write(line)
        return proc.wait()


def run_validator(spec: dict, pairs: int, wrappers, bins: pathlib.Path, raw: pathlib.Path) -> tuple[int, dict | None]:
    p = spec["params"]
    argv = [sys.executable, str(HERE / "validator_run.py"),
            "--rust", str(wrappers["rust"]["validator"]), "--zig", str(wrappers["zig"]["validator"]),
            "--url-library", str(bins / "lib/libziggy_url.so"),
            "--message-reference", str(bins / "tools/ziggy-rust-reference"),
            "--evm-oracle", str(bins / "tools/ziggy-evm-oracle"),
            "--zig-mode", spec["mode"], "--consensus", p["consensus"], "--samples", str(pairs),
            "--catchup", str(p["catchup"]), "--steady", str(p["steady"]),
            "--steady-interval-ms", str(p["steady_interval_ms"]), "--check-metrics",
            "--rust-build-description", "depot cargo --release, portable x86-64-v3+pclmulqdq, tokio_unstable, aleo features",
            "--output", str(raw)]
    code = run_harness(argv, raw.parent / "harness.log")
    path = raw / "validator.json"
    return code, json.loads(path.read_text()) if path.is_file() else None


def run_scraper(spec: dict, pairs: int, wrappers, bins: pathlib.Path, raw: pathlib.Path, work: pathlib.Path,
                fixture_cpus: list[int], workload: str) -> tuple[int, dict | None]:
    p = spec["params"]
    shim_dir = work / "shim"
    shim_dir.mkdir(parents=True, exist_ok=True)
    real_docker = shutil.which("docker")
    assert real_docker, "docker required"
    (shim_dir / "docker").write_text(f"#!/bin/sh\nexec {sys.executable} {HERE / 'docker_shim.py'} \"$@\"\n")
    (shim_dir / "docker").chmod(0o755)
    # init-db runs as role `harness` so pg_stat_statements separates migrations from agent SQL.
    init_db = work / "wrap" / "init-db"
    init_db.write_text('#!/bin/sh\nDATABASE_URL=$(printf %s "$DATABASE_URL" | sed "s#//ziggy@#//harness@#")\n'
                       f'export DATABASE_URL\nexec {(bins / "rust/init-db").resolve()} "$@"\n')
    init_db.chmod(0o755)
    pgstat = raw.parent / "pg_stat_statements.json"
    env = {**os.environ, "PATH": f"{shim_dir}:{os.environ['PATH']}", "BENCH_REAL_DOCKER": real_docker,
           "BENCH_FIXTURE_CPUS": cpu_spec(fixture_cpus), "BENCH_PGSTAT_OUT": str(pgstat),
           "BENCH_PGSTAT_ROLE_FLAG": str(work / "pg-role")}
    # The harness insists on a fresh zig/bench/results/scraper-process-* directory.
    out = ROOT / "zig/bench/results" / f"scraper-process-depot-{workload}-{int(time.time())}"
    argv = [sys.executable, "zig/bench/scraper.py",
            "--rust", str(wrappers["rust"]["scraper"]), "--zig", str(wrappers["zig"]["scraper"]),
            "--migration-bin", str(init_db), "--image", os.environ.get("POSTGRES_IMAGE", "postgres:16.15"),
            "--samples", str(pairs), "--catchup", str(p["catchup"]), "--fresh", str(p["fresh"]),
            "--fresh-interval-ms", str(p["fresh_interval_ms"]), "--chunk", str(p["chunk"]),
            "--interval", str(p["interval"]), "--deadline", str(p["deadline"]), "--output", str(out)]
    code = run_harness(argv, raw.parent / "harness.log", env)
    if out.exists():
        shutil.copytree(out, raw, dirs_exist_ok=True, ignore=shutil.ignore_patterns("pinned", "fixture-cache"))
    path = raw / "scraper-process.json"
    return code, json.loads(path.read_text()) if path.is_file() else None


def run_relayer(spec: dict, pairs: int, wrappers, bins: pathlib.Path, raw: pathlib.Path) -> tuple[int, dict | None]:
    p = spec["params"]
    argv = [sys.executable, str(HERE / "relayer_bench.py"),
            "--rust", str(wrappers["rust"]["relayer"]), "--zig", str(wrappers["zig"]["relayer"]),
            "--checkpoint-validator", str((bins / "rust/validator").resolve()),
            "--samples", str(pairs), "--catchup", str(p["catchup"]), "--steady", str(p["steady"]),
            "--steady-interval-ms", str(p["steady_interval_ms"]), "--max-batch-size", str(p["max_batch_size"]),
            "--output", str(raw)]
    code = run_harness(argv, raw.parent / "harness.log")
    path = raw / "relayer.json"
    return code, json.loads(path.read_text()) if path.is_file() else None


# ------------------------------------------------------------ normalisation

def med(values):
    values = [v for v in values if v is not None]
    return statistics.median(values) if values else None


def rpc_total(methods_list) -> tuple[int, dict]:
    merged: dict[str, int] = {}
    for methods in methods_list:
        for k, v in methods.items():
            merged[k] = merged.get(k, 0) + v
    return sum(merged.values()), dict(sorted(merged.items()))


def proc_metrics(m: dict | None) -> dict:
    if not m:
        return {}
    return {
        "cpu_s": m["user_seconds"] + m["system_seconds"],
        "cpu_user_s": m["user_seconds"],
        "cpu_sys_s": m["system_seconds"],
        "peak_rss_mib": m["max_rss_bytes"] / 2**20,
        "shutdown_ms": m["shutdown_ms"],
        "process_wall_s": m["process_wall_seconds"],
    }


def normalise_validator(data: dict) -> list[dict]:
    rows = []
    for r in data.get("raw_samples", []):
        total, methods = rpc_total(r["rpc_total"])
        startup_total, _ = rpc_total(r["rpc_startup"])
        rows.append({
            "impl": r["implementation"], "pair": r["sample"], "order": r["order"],
            "metrics": {
                "catchup_ms": r["catchup_ms"],
                "freshness_median_ms": med(r["freshness_ms"]),
                "freshness_max_ms": max(r["freshness_ms"]),
                "steady_ms": r["steady_ms"],
                **proc_metrics(r["measurements"]),
                "rpc_requests": total,
                "rpc_requests_catchup": startup_total,
                "db_bytes": r["storage"]["database"]["allocated_bytes"],
            },
            "rpc_methods": methods,
            "checks": {"checkpoints": r["canonical_checkpoint_count"], "signatures_verified": r["signatures_verified"],
                       "exit_code": r["measurements"]["exit_code"]},
            "load_average": r.get("load_average"),
        })
    return rows


def normalise_scraper(data: dict, pgstat: dict | None) -> list[dict]:
    queries = {}
    if pgstat and pgstat.get("grouped"):
        for g in pgstat["grouped"]:
            if g["role"] == "ziggy" and g["database"].startswith("bench_"):
                queries[g["database"]] = g
    rows = []
    for r in data.get("raw_samples", []):
        if r.get("status") == "failed" or "catchup_ms" not in r:
            continue
        methods = r["rpc_total"]["methods"]
        q = queries.get(r.get("database_name"))
        rows.append({
            "impl": r["implementation"], "pair": r["sample"], "order": r.get("order"),
            "metrics": {
                "startup_ms": r["startup_ms"],
                "catchup_ms": r["catchup_ms"],
                "freshness_median_ms": med(r["fresh_event_group_to_durable_ms"]),
                "freshness_max_ms": max(r["fresh_event_group_to_durable_ms"]),
                "restart_catchup_ms": r["restart_catchup_ms"],
                **proc_metrics(r["first_process"]),
                "restart_cpu_s": r["restart_process"]["user_seconds"] + r["restart_process"]["system_seconds"],
                "restart_shutdown_ms": r["restart_process"]["shutdown_ms"],
                "rpc_requests": sum(methods.values()),
                "rpc_requests_catchup": sum(r["rpc_at_catchup"]["methods"].values()),
                "rpc_requests_first_run": sum(r["rpc_before_first_stop"]["methods"].values()),
                "db_statements": q["calls"] if q else None,
                "db_rows": q["rows"] if q else None,
                "db_exec_ms": float(q["exec_ms"]) if q else None,
            },
            "rpc_methods": dict(sorted(methods.items())),
            "checks": {"first_exit": r["first_process"].get("exit_code"), "restart_exit": r["restart_process"].get("exit_code")},
            "notes": "db_* cover the whole trial (first run + restart replay), agent role only; migrations/harness SQL excluded",
        })
    return rows


def normalise_relayer(data: dict) -> list[dict]:
    rows = []
    for r in data.get("raw_samples", []):
        total, methods = rpc_total([e["methods"] for e in r["rpc"]["total"]])
        rows.append({
            "impl": r["implementation"], "pair": r["sample"], "order": r["order"],
            "metrics": {
                "startup_ms": r["launch_to_ready_ms"],
                "catchup_ms": r["launch_to_caught_up_ms"],
                "post_ready_catchup_ms": r["post_readiness_catchup_ms"],
                "deliveries_per_s": r["launch_to_caught_up_messages_per_second"],
                "e2e_latency_median_ms": med(r["freshness_ms"]),
                "e2e_latency_p95_ms": r["freshness_percentiles_ms"]["p95"],
                **proc_metrics(r["stop"]),
                "rpc_requests": total,
                "rpc_requests_catchup": sum(e["json_rpc_subrequests"] for e in r["rpc"]["catchup"]),
                "transactions": r["proof"]["unique_transaction_count"],
                "db_bytes": r.get("db_allocated_bytes"),
            },
            "rpc_methods": methods,
            "checks": {"delivered": r["proof"]["message_count"], "exit_code": r["stop"]["exit_code"],
                       "batch_histogram": (r["proof"].get("batch_membership") or {}).get("group_size_histogram")},
            "load_average": r.get("load_average"),
        })
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--workload", required=True, choices=sorted(catalogue.WORKLOADS))
    parser.add_argument("--pairs", type=int, default=5)
    parser.add_argument("--bins", type=pathlib.Path, required=True, help="build artifact dir (rust/ zig-safe/ zig-fast/ lib/ tools/)")
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--agent-cpus", default=os.environ.get("BENCH_AGENT_CPUS"))
    parser.add_argument("--fixture-cpus", default=os.environ.get("BENCH_FIXTURE_CPUS"))
    args = parser.parse_args()
    spec = catalogue.WORKLOADS[args.workload]
    out = args.output.resolve()
    raw = out / "raw"
    work = out / "work"
    raw.mkdir(parents=True, exist_ok=True)
    work.mkdir(parents=True, exist_ok=True)
    bins = args.bins.resolve()

    agent_cpus, fixture_cpus = split_cpus(args.agent_cpus, args.fixture_cpus)
    os.sched_setaffinity(0, fixture_cpus)  # harness, Anvil, proxies, Rust checkpoint validator inherit this
    wrappers = make_wrappers(bins, spec["mode"], agent_cpus, work)

    result = {
        "schema": 1,
        "workload": args.workload, "role": spec["role"], "mode": spec["mode"], "params": spec["params"],
        "pairs_requested": args.pairs,
        "pair_order": "pair i runs rust then zig when i is even, zig then rust when odd; same host",
        "rust_log": {"HYP_LOG_LEVEL": RUST_LOG_LEVEL, "HYP_LOG_FORMAT": "json"},
        "cpu_placement": {"agent_cpus": cpu_spec(agent_cpus), "fixture_cpus": cpu_spec(fixture_cpus),
                          "method": "agents via taskset exec wrapper; harness/anvil/proxies via sched_setaffinity; postgres via docker --cpuset-cpus"},
        "host": host_info(),
        "host_before": host_snapshot(),
        "build": binary_identity(bins),
        "git_head": sh("git", "-C", str(ROOT), "rev-parse", "HEAD"),
    }
    (out / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    started = time.monotonic()
    try:
        if spec["role"] == "validator":
            code, data = run_validator(spec, args.pairs, wrappers, bins, raw)
            rows = normalise_validator(data) if data else []
        elif spec["role"] == "scraper":
            code, data = run_scraper(spec, args.pairs, wrappers, bins, raw, work, fixture_cpus, args.workload)
            pgstat_path = out / "pg_stat_statements.json"
            pgstat = json.loads(pgstat_path.read_text()) if pgstat_path.is_file() else None
            rows = normalise_scraper(data, pgstat) if data else []
        else:
            code, data = run_relayer(spec, args.pairs, wrappers, bins, raw)
            rows = normalise_relayer(data) if data else []
    finally:
        result["duration_s"] = time.monotonic() - started
        result["host_after"] = host_snapshot()
        before, after = result["host_before"]["cpu_times"], result["host_after"]["cpu_times"]
        delta = [a - b for a, b in zip(after, before)]
        idle = delta[3] + delta[4]
        result["host_cpu_busy_fraction"] = 1 - idle / sum(delta) if sum(delta) else None
    failures = []
    if data:
        failures = data.get("failures") or ([data["failure"]] if data.get("failure") else [])
    complete = {impl: sum(1 for r in rows if r["impl"] == impl) for impl in ("rust", "zig")}
    result.update({
        "harness_exit_code": code,
        "passed": code == 0 and complete["rust"] == complete["zig"] == args.pairs,
        "completed": complete,
        "failures": failures,
        "rows": rows,
    })
    (out / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    shutil.rmtree(work, ignore_errors=True)
    print(json.dumps({"workload": args.workload, "passed": result["passed"], "completed": complete,
                      "harness_exit_code": code}), flush=True)
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
