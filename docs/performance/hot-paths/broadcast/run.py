#!/usr/bin/env python3
"""Build verbatim broadcast snapshots in a small, optimized comparison binary."""

import argparse
import base64
import gzip
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import re
import shutil
import statistics
import subprocess
import tempfile
from datetime import datetime, timezone

BASELINE = "7e80c603f0278c9b1f0555fe0106279e2df5f070"
PROPOSED = "64c9c07b5d77c83f1f2b5230eb13ab5939f9af6c"
SOURCE = "rust/main/hyperlane-base/src/contract_sync/broadcast.rs"
ROOT = Path(__file__).resolve().parents[4]


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def percentile(values, q):
    if q == .5:
        return statistics.median(values)
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * q) - 1)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", default=BASELINE)
    parser.add_argument("--proposed", default=PROPOSED)
    parser.add_argument("--repetitions", type=int, default=30)
    parser.add_argument("--warmups", type=int, default=5)
    parser.add_argument("--build-only", action="store_true")
    parser.add_argument("--measure-only", action="store_true")
    parser.add_argument("--build-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path(__file__).with_name("results.json"))
    args = parser.parse_args()
    build = args.build_dir.resolve()
    if args.measure_only:
        metadata = json.loads((build / "metadata.json").read_text())
        assert metadata["sources"]["baseline"]["commit"] == args.baseline
        assert metadata["sources"]["proposed"]["commit"] == args.proposed
    else:
        build.mkdir(parents=True, exist_ok=True)
        source_dir = build / "src"
        source_dir.mkdir(exist_ok=True)
        hashes = {}
        for label, commit in [("baseline", args.baseline), ("proposed", args.proposed)]:
            original = subprocess.check_output(["git", "show", f"{commit}:{SOURCE}"], cwd=ROOT)
            # Omit only unit tests. Timed code and the actual notification type stay verbatim.
            production = original.decode().split("#[cfg(test)]", 1)[0]
            (source_dir / f"{label}.rs").write_text(production)
            hashes[label] = {
                "commit": commit,
                "path": SOURCE,
                "file_sha256_base64": base64.b64encode(hashlib.sha256(original).digest()).decode(),
                "production_sha256_base64": base64.b64encode(hashlib.sha256(production.encode()).digest()).decode(),
            }
        shutil.copyfile(Path(__file__).with_name("main.rs"), source_dir / "main.rs")
        # H512 is supplied by the real core crate. Its source is unchanged between
        # comparison commits; this keeps the complete production payload definition.
        core = ROOT / "rust/main/hyperlane-core"
        manifest = f'''[package]
    name = "hotpath-broadcast-bench"
    version = "0.0.0"
    edition = "2021"
    [workspace]
    [dependencies]
    derive-new = "=0.5.9"
    eyre = "=0.6.8"
    futures = "=0.3.31"
    hyperlane-core = {{ path = {json.dumps(str(core))} }}
    serde = {{ version = "=1.0.228", features = ["derive"] }}
    serde_json = "=1.0.151"
    tokio = {{ version = "=1.53.1", features = ["rt", "rt-multi-thread", "macros", "sync", "time"] }}
    [profile.release]
    opt-level = 3
    debug = false
    '''
        (build / "Cargo.toml").write_text(manifest)
        pinned_lock = Path(__file__).with_name("Cargo.lock.gz")
        if pinned_lock.exists():
            (build / "Cargo.lock").write_bytes(gzip.decompress(pinned_lock.read_bytes()))
        env = dict(os.environ, CARGO_INCREMENTAL="0", CARGO_TARGET_DIR=str(build / "target"))
        run("cargo", "+1.88.0", "build", "--locked", "--offline", "--release", "--manifest-path", str(build / "Cargo.toml"), "-j", "4", env=env)
        metadata = {
            "timestamp_utc": datetime.now(timezone.utc).isoformat(),
            "platform": platform.platform(),
            "cpu": subprocess.check_output(["sysctl", "-n", "machdep.cpu.brand_string"], text=True).strip(),
            "logical_cpus": os.cpu_count(),
            "rustc": subprocess.check_output(["rustc", "+1.88.0", "--version"], text=True).strip(),
            "profile": "release opt-level=3 including dependencies",
            "cargo_lock_sha256_base64": base64.b64encode(hashlib.sha256((build / "Cargo.lock").read_bytes()).digest()).decode(),
            "binary_sha256_base64": base64.b64encode(hashlib.sha256((build / "target/release/hotpath-broadcast-bench").read_bytes()).digest()).decode(),
            "tokio": "1.53.1",
            "payload": "u64 fast-path control; production IndexingNotification(H512, Vec<Option<u32>>) for notifications_3; component microbenchmark, not end-to-end throughput",
            "sources": hashes,
            "repetitions": args.repetitions,
            "warmups": args.warmups,
            "method": "Two AB/BA process passes per scenario; per-process warmup; timed process CPU/RSS includes warmup. Single process at a time.",
        }
        (build / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
    if args.build_only:
        print(build / "target/release/hotpath-broadcast-bench")
        return
    binary = build / "target/release/hotpath-broadcast-bench"
    assert metadata["binary_sha256_base64"] == base64.b64encode(hashlib.sha256(binary.read_bytes()).digest()).decode()
    metadata["measured_at_utc"] = datetime.now(timezone.utc).isoformat()
    metadata["percentiles"] = "p50 sample median; p95 nearest rank"
    metadata["repetitions"] = args.repetitions
    metadata["warmups"] = args.warmups
    observations = []
    for threads in [1, 2]:
        for scenario in ["uniform_1", "uniform_3", "notifications_3", "slow_consumer"]:
            for pass_index, order in enumerate([["baseline", "proposed"], ["proposed", "baseline"]]):
                for version in order:
                    with tempfile.NamedTemporaryFile(mode="r+") as timing:
                        completed = run("/usr/bin/time", "-l", "-o", timing.name, str(binary), version, scenario, str(args.repetitions), str(args.warmups), str(threads), capture_output=True)
                        report = Path(timing.name).read_text()
                    cpu = re.search(r"([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys", report)
                    rss = re.search(r"(\d+)\s+maximum resident set size", report)
                    observations.append({
                        "scenario": scenario, "version": version, "threads": threads, "pass": pass_index,
                        "samples": json.loads(completed.stdout),
                        "user_s": float(cpu[2]) if cpu else None,
                        "system_s": float(cpu[3]) if cpu else None,
                        "peak_rss_bytes": int(rss[1]) if rss else None,
                        "time_report": report,
                    })
    summaries = []
    for threads in [1, 2]:
        for scenario in ["uniform_1", "uniform_3", "notifications_3", "slow_consumer"]:
            for version in ["baseline", "proposed"]:
                runs = [r for r in observations if (r["threads"], r["scenario"], r["version"]) == (threads, scenario, version)]
                samples = [s for r in runs for s in r["samples"]]
                metrics = {}
                for key in ["elapsed_ms", "ready_delivery_ms", "registration_ms"]:
                    values = [s[key] for s in samples if s[key] is not None]
                    if values:
                        metrics[key] = {"p50": percentile(values, .5), "p95": percentile(values, .95)}
                summaries.append({"threads": threads, "scenario": scenario, "version": version, "n": len(samples), "metrics": metrics,
                    "deliveries_per_second": sum(s["deliveries"] for s in samples) / (sum(s["elapsed_ms"] for s in samples) / 1000),
                    "process_cpu_s": [r["user_s"] + r["system_s"] for r in runs],
                    "peak_rss_bytes": max(r["peak_rss_bytes"] for r in runs),
                })
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({"metadata": metadata, "summary": summaries, "raw": observations}, indent=2) + "\n")
    print(json.dumps(summaries, indent=2))


if __name__ == "__main__":
    main()
