#!/usr/bin/env python3
"""Build, differential-check, and time equivalent protocol kernels. No network RPCs."""
from __future__ import annotations

import argparse
import inventory
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import random
import re
import shutil
import statistics
import struct
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]


def command(args, *, cwd=ROOT, env=None, input=None):
    result = subprocess.run([str(x) for x in args], cwd=cwd, env=env, input=input,
                            text=True, capture_output=True)
    if result.returncode:
        print(result.stdout, file=sys.stderr, end="")
        print(result.stderr, file=sys.stderr, end="")
        result.check_returncode()
    return result


def digest_chunks(data):
    digest = hashlib.sha256(data).hexdigest()
    return [digest[:32], digest[32:]]


def git(*args):
    return command(["git", *args]).stdout.strip()


def fixture(version, nonce, origin, sender, destination, recipient, body):
    return struct.pack(">BII32sI32s", version, nonce, origin, sender, destination, recipient) + body


def corpus():
    # Existing repository vector supplies an independent known ID, before oracle comparisons.
    known = json.loads((ROOT / "vectors/message.json").read_text())[0]
    inputs = [fixture(known["version"], known["nonce"], known["origin"],
                      bytes.fromhex(known["sender"][2:]), known["destination"],
                      bytes.fromhex(known["recipient"][2:]), bytes(known["body"]))]
    inputs.extend(bytes(length) for length in range(77))
    rng = random.Random(0x5A49474759)
    lengths = [0, 1, 2, 58, 59, 60, 135, 136, 137, 271, 272, 1024, 4096, 65536]
    for length in lengths:
        for version in [0, 3, 255]:
            for nonce in [0, 1, 2**32 - 1]:
                inputs.append(fixture(version, nonce, nonce ^ 0xA5A5A5A5,
                                      rng.randbytes(32), nonce, rng.randbytes(32),
                                      rng.randbytes(length)))
    for _ in range(512):
        inputs.append(fixture(rng.randrange(256), rng.randrange(2**32),
                              rng.randrange(2**32), rng.randbytes(32),
                              rng.randrange(2**32), rng.randbytes(32),
                              rng.randbytes(rng.randrange(4097))))
    return known, inputs


def differential(rust, zig, output):
    known, inputs = corpus()
    wire = "\n".join(row.hex() for row in inputs) + "\n"
    results = {}
    for label, binary in [("rust", rust), ("zig", zig)]:
        results[label] = [json.loads(line) for line in command([binary, "vectors"], input=wire).stdout.splitlines()]
        if len(results[label]) != len(inputs):
            raise RuntimeError(f"{label}: expected {len(inputs)} rows, got {len(results[label])}")
        assert results[label][0]["id"] == known["id"][2:], f"{label}: known independent ID differs"
    for index, (left, right) in enumerate(zip(results["rust"], results["zig"])):
        if left != right:
            failure = {"index": index, "input": inputs[index].hex(), "rust": left, "zig": right}
            (output / "differential-failure.json").write_text(json.dumps(failure, indent=2) + "\n")
            raise RuntimeError(f"Differential mismatch at input {index}; see differential-failure.json")
    summary = {
        "input_count": len(inputs), "valid_count": sum(len(row) >= 77 for row in inputs),
        "invalid_count": sum(len(row) < 77 for row in inputs),
        "seed": "0x5a49474759", "corpus_sha256_chunks": digest_chunks(wire.encode()),
        "checked": ["canonical encoding", "message ID", "incremental root after every valid message",
                    "count", "checkpoint signing hash", "EIP-191 digest", "truncated message rejection"],
        "independent_vector": "vectors/message.json", "passed": True,
    }
    (output / "differential.json").write_text(json.dumps(summary, indent=2) + "\n")
    return summary


def crypto_differential(rust, zig, output):
    # Published, disposable fixture keys only. Never read production signer material.
    order = ((0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFE << 128) | 0xBAAEDCE6AF48A03BBFD25E8CD0364141)
    rng = random.Random(0x5349474E)
    keys = [1, int.from_bytes(bytes([0x11]) * 32, "big"), order - 1]
    cases = [(key.to_bytes(32, "big"), digest) for key in keys
             for digest in [bytes(32), bytes([255]) * 32, bytes([0x22]) * 32]]
    cases += [(rng.randrange(1, order).to_bytes(32, "big"), rng.randbytes(32)) for _ in range(64)]
    wire = "\n".join((key + digest).hex() for key, digest in cases) + "\n"
    signed = {label: [json.loads(row) for row in command([binary, "crypto-vectors"], input=wire).stdout.splitlines()]
              for label, binary in [("rust", rust), ("zig", zig)]}
    assert len(signed["rust"]) == len(signed["zig"]) == len(cases)
    assert signed["rust"][0]["address"] == "7e5f4552091a69125d5dfcb7b8c2659029395bdf"
    checked = 0
    for label, binary, other in [("rust", rust, "zig"), ("zig", zig, "rust")]:
        external = "\n".join((key + digest).hex() + row["signature"]
                             for (key, digest), row in zip(cases, signed[other])) + "\n"
        rows = [json.loads(row) for row in command([binary, "crypto-vectors"], input=external).stdout.splitlines()]
        assert len(rows) == len(cases)
        for index, row in enumerate(rows):
            expected = signed[other][index]["address"]
            assert row["address"] == row["recovered"] == expected, (label, index, row)
            checked += 1
    # Invalid r, s, v, noncanonical scalar, and high-s must fail closed in both implementations.
    base = bytearray.fromhex(signed["rust"][0]["signature"])
    invalid = []
    for field in ["r_zero", "s_zero", "v_zero", "v_29", "r_order", "s_high"]:
        sig = bytearray(base)
        if field == "r_zero": sig[:32] = bytes(32)
        elif field == "s_zero": sig[32:64] = bytes(32)
        elif field == "v_zero": sig[64] = 0
        elif field == "v_29": sig[64] = 29
        elif field == "r_order": sig[:32] = order.to_bytes(32, "big")
        else: sig[32:64] = (order - 1).to_bytes(32, "big")
        invalid.append(bytes(sig))
    prefix = (cases[0][0] + cases[0][1]).hex()
    invalid_wire = "\n".join(prefix + sig.hex() for sig in invalid) + "\n"
    for label, binary in [("rust", rust), ("zig", zig)]:
        rows = [json.loads(row) for row in command([binary, "crypto-vectors"], input=invalid_wire).stdout.splitlines()]
        assert len(rows) == len(invalid)
        assert all(row["recovered"] is None for row in rows), (label, rows)
    summary = {"passed": True, "fixture_cases": len(cases), "cross_implementation_recoveries": checked,
               "invalid_signatures_per_implementation": len(invalid), "seed": "0x5349474e",
               "rust_crypto": "k256 0.13.4", "zig_crypto": "std.crypto Secp256k1",
               "policy": "Compare cross-recovery/address, not nonce-dependent signature byte equality"}
    (output / "crypto-differential.json").write_text(json.dumps(summary, indent=2) + "\n")
    return summary


def measured(binary, kernel, iterations, body_len):
    args = [binary, "bench", kernel, str(iterations), str(body_len)]
    rss = None
    if sys.platform == "darwin":
        result = command(["/usr/bin/time", "-l", *args])
        match = re.search(r"(\d+)\s+maximum resident set size", result.stderr)
        if match:
            rss = int(match.group(1))
    else:
        result = command(args)
    sample = json.loads(result.stdout)
    sample["max_rss_bytes"] = rss
    sample["ns_per_operation"] = sample["elapsed_ns"] / iterations
    return sample


def benchmark(rust, zig, samples):
    cases = [("message_id", 100_000, 0), ("message_id", 100_000, 64),
             ("message_id", 20_000, 1024), ("message_id", 500, 65536),
             ("message_roundtrip_owned", 100_000, 0),
             ("message_roundtrip_owned", 100_000, 64),
             ("message_roundtrip_owned", 20_000, 1024),
             ("message_roundtrip_owned", 500, 65536),
             ("merkle_ingest", 100_000, 0), ("merkle_ingest_root", 10_000, 0)]
    binaries = {"rust": rust, "zig": zig}
    output = []
    for kernel, iterations, body_len in cases:
        # Fresh process per sample; untimed warmup also verifies result parity.
        warm = {label: measured(binary, kernel, iterations, body_len) for label, binary in binaries.items()}
        assert warm["rust"]["checksum"] == warm["zig"]["checksum"], (kernel, body_len, warm)
        raw = {label: [] for label in binaries}
        for trial in range(samples):
            order = ["rust", "zig"] if trial % 2 == 0 else ["zig", "rust"]
            for label in order:
                sample = measured(binaries[label], kernel, iterations, body_len)
                assert sample["checksum"] == warm[label]["checksum"], (label, kernel, body_len, sample)
                sample["trial"] = trial
                raw[label].append(sample)
        stats = {}
        for label, rows in raw.items():
            ns = [row["ns_per_operation"] for row in rows]
            stats[label] = {"median_ns": statistics.median(ns), "min_ns": min(ns), "max_ns": max(ns),
                            "stdev_ns": statistics.stdev(ns) if samples > 1 else 0,
                            "median_max_rss_bytes": statistics.median([row["max_rss_bytes"] for row in rows]) if sys.platform == "darwin" else None}
        ratio = stats["rust"]["median_ns"] / stats["zig"]["median_ns"]
        output.append({"kernel": kernel, "iterations": iterations, "body_len": body_len,
                       "summary": stats, "rust_over_zig": ratio, "samples": raw})
        print(f"{kernel:26} body={body_len:5} Rust={stats['rust']['median_ns']:10.1f} ns Zig={stats['zig']['median_ns']:10.1f} ns Rust/Zig={ratio:.3f}", flush=True)
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--zig", default=os.environ.get("ZIG", shutil.which("zig")))
    parser.add_argument("--rust-toolchain", default="1.98.0")
    parser.add_argument("--sysroot", type=Path)
    parser.add_argument("--library-dir", type=Path)
    parser.add_argument("--samples", type=int, default=9)
    parser.add_argument("--optimize", choices=["ReleaseSafe", "ReleaseFast"], default="ReleaseSafe")
    parser.add_argument("--skip-build", action="store_true")
    parser.add_argument("--clean-build", action="store_true", help="Use fresh task-owned target and compiler cache directories (downloads remain cached)")
    parser.add_argument("--only-differential", action="store_true")
    parser.add_argument("--output", type=Path, default=ROOT / "zig/bench/results")
    args = parser.parse_args()
    if args.samples < 1:
        parser.error("--samples must be positive")
    if args.skip_build and args.clean_build:
        parser.error("--skip-build and --clean-build are mutually exclusive")
    if not args.zig:
        parser.error("Zig 0.15.2 required; pass --zig or set ZIG")
    if command([args.zig, "version"]).stdout.strip() != "0.15.2":
        parser.error("This harness is pinned to Zig 0.15.2")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    env["RUSTFLAGS"] = "-C target-cpu=native"
    rust = ROOT / "zig/reference/target/release/ziggy-rust-reference"
    zig = ROOT / "zig/zig-out/bin" / f"zig-agent-bench-{args.optimize.lower()}"
    build_stats = []
    temporary = tempfile.TemporaryDirectory(prefix="ziggy-kernel-build-") if args.clean_build else None
    if temporary:
        rust = Path(temporary.name) / "rust/release/ziggy-rust-reference"
        zig = Path(temporary.name) / f"zig-agent-bench-{args.optimize.lower()}"
    reference_lock = ROOT / "zig/reference/Cargo.lock"
    command([sys.executable, ROOT / "zig/tools/fixture_pack.py", "restore-locks"])
    rust_cmd = ["cargo", f"+{args.rust_toolchain}", "build", "--manifest-path", "zig/reference/Cargo.toml", "--release", "--locked", "-j", "4"]
    if temporary:
        rust_cmd += ["--target-dir", str(Path(temporary.name) / "rust")]
    zig_cmd = [args.zig, "build-exe", "-O", args.optimize, "--dep", "protocol",
               "-Mroot=zig/bench/main.zig", "-O", args.optimize,
               "-Mprotocol=zig/src/protocol/root.zig", "-lc", f"-femit-bin={zig}"]
    if temporary:
        zig_cmd += ["--cache-dir", str(Path(temporary.name) / "zig-local"),
                    "--global-cache-dir", str(Path(temporary.name) / "zig-global")]
    if args.sysroot:
        zig_cmd += ["--sysroot", str(args.sysroot)]
    if args.library_dir:
        zig_cmd += [f"-L{args.library_dir}"]
    zig.parent.mkdir(parents=True, exist_ok=True)
    if not args.skip_build:
        for label, cmd, cwd in [
            ("rust", rust_cmd, ROOT),
            ("zig", zig_cmd, ROOT),
        ]:
            start = time.perf_counter()
            result = command(cmd, cwd=cwd, env=env)
            build_stats.append({"language": label, "command": cmd, "elapsed_seconds": time.perf_counter() - start,
                                "cache_state": "fresh compiler target/global cache; dependency downloads cached" if temporary else "existing caches; not a clean-build comparison"})
            (output / f"{label}-kernel-build.log").write_text(result.stdout + result.stderr)
    sources = ["zig/reference/Cargo.lock", "zig/reference/Cargo.toml", "zig/reference/src/main.rs",
               "rust/main/hyperlane-core/src/types/message.rs",
               "rust/main/hyperlane-core/src/accumulator/incremental.rs", "zig/bench/main.zig", "zig/bench/run.py"]
    excluded = {"target", ".zig-cache", "zig-out", "__pycache__", ".cache", ".git"}
    source_extensions = {".zig", ".zon", ".json", ".jsonl", ".rs", ".toml", ".py", ".sh", ".sql", ".gz"}
    for directory, subdirectories, filenames in os.walk(ROOT / "zig/src"):
        subdirectories[:] = sorted(name for name in subdirectories if not inventory.pruned(name))
        for name in sorted(filenames):
            path = Path(directory) / name
            if path.suffix in source_extensions and not (path.suffix != ".gz" and Path(str(path)+".gz").exists()):
                sources.append(str(path.relative_to(ROOT)))
    sources += [str(path.relative_to(ROOT)) for path in sorted((ROOT / "rust/main/hyperlane-core/src").rglob("*.rs"))]
    sources += ["rust/main/Cargo.toml", "rust/main/Cargo.lock", "rust/main/hyperlane-core/Cargo.toml"]
    sources = sorted(set(source+".gz" if (ROOT/(source+".gz")).exists() else source for source in sources))
    metadata = {
        "started_at_utc": datetime.now(timezone.utc).isoformat(),
        "base_commit": git("rev-parse", "HEAD"), "git_status": git("status", "--short"),
        "host": platform.platform(), "machine": platform.machine(),
        "cpu": command(["sysctl", "-n", "machdep.cpu.brand_string"]).stdout.strip() if sys.platform == "darwin" else platform.processor(),
        "zig_version": command([args.zig, "version"]).stdout.strip(),
        "rust_version": command(["rustc", f"+{args.rust_toolchain}", "--version"]).stdout.strip(),
        "builds": build_stats, "rustflags": env["RUSTFLAGS"], "reference_lock_seeded_from_production": seeded_lock, "zig_optimize": args.optimize, "rust_release_overflow_checks": False,
        "allocator": {"rust": "Rust system allocator", "zig": "std.heap.smp_allocator"},
        "sample_count": args.samples, "execution": "alternating language order; one warmup each; fresh process per sample",
        "binary_sizes": {"rust_reference": rust.stat().st_size, "zig_benchmark": zig.stat().st_size},
        "binary_sha256_chunks": {"rust_reference": digest_chunks(rust.read_bytes()), "zig_benchmark": digest_chunks(zig.read_bytes())},
        "source_sha256_chunks": {path: digest_chunks((ROOT / path).read_bytes()) for path in sources},
        "scope": "protocol CPU kernels only; not whole-agent throughput, memory, build, LOC, or dependency parity",
        "sdkroot": str(args.sysroot) if args.sysroot else os.environ.get("SDKROOT"),
    }
    metadata["differential"] = differential(rust, zig, output)
    metadata["crypto_differential"] = crypto_differential(rust, zig, output)
    print(f"Differential parity passed: {metadata['differential']['input_count']} inputs", flush=True)
    if not args.only_differential:
        metadata["load_average_before"] = os.getloadavg()
        metadata["benchmarks"] = benchmark(rust, zig, args.samples)
        metadata["load_average_after"] = os.getloadavg()
        lines = [f"# Protocol kernels: Zig {args.optimize}", "",
                 "Production Rust core versus partial Zig protocol implementation; no whole-agent speedup claim.", "",
                 f"{args.samples} measured samples per language/case; median inner-loop ns/op; native Apple M3 Pro.", "",
                 "| Kernel | Body bytes | Rust ns/op | Zig ns/op | Rust/Zig |",
                 "| --- | ---: | ---: | ---: | ---: |"]
        for row in metadata["benchmarks"]:
            lines.append(f"| `{row['kernel']}` | {row['body_len']:,} | {row['summary']['rust']['median_ns']:,.1f} | {row['summary']['zig']['median_ns']:,.1f} | {row['rust_over_zig']:.3f} |")
        lines += ["", "Rust/Zig >1 means Zig was faster in that case; <1 is a regression. All cases retained.", "",
                  "These CPU kernels exclude RPC, persistence, metadata fetching, queues, signing, confirmation, and scraper databases.",
                  "Allocator implementations and language safety configurations differ; see the benchmark methodology."]
        if build_stats:
            lines += ["", "| Harness build | Seconds | Cache state |", "| --- | ---: | --- |"]
            lines += [f"| {row['language']} | {row['elapsed_seconds']:.3f} | {row['cache_state']} |" for row in build_stats]
            lines += ["", "Harness build feature sets differ; these are not whole-agent build improvements."]
        (output / "summary.md").write_text("\n".join(lines) + "\n")
    metadata["finished_at_utc"] = datetime.now(timezone.utc).isoformat()
    (output / "protocol-kernels.json").write_text(json.dumps(metadata, indent=2) + "\n")
    if temporary:
        temporary.cleanup()


if __name__ == "__main__":
    main()
