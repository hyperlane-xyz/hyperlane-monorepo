#!/usr/bin/env python3
"""Reproduce the public recovery optimization with balanced fresh-process pairs."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import statistics
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
JOINT = """    const z = reducedHash(digest);
    // Q = (s/r)R + (-z/r)G. Both scalars are public signature/digest data.
    // Use the standard curve's joint multiplication instead of computing
    // sR, zG and then multiplying their difference a third time.
    const inverse_r = r.invert();
    const public_key = try Curve.mulDoubleBasePublic(point_r, s.mul(inverse_r).toBytes(.big), Curve.basePoint, z.mul(inverse_r).neg().toBytes(.big), .big);
"""
ORIGINAL = """    const sr = try point_r.mulPublic(s.toBytes(.big), .big);
    const z = reducedHash(digest);
    const zg = if (z.isZero()) Curve.identityElement else try Curve.basePoint.mulPublic(z.toBytes(.big), .big);
    const numerator = sr.sub(zg);
    try numerator.rejectIdentity();
    const public_key = try numerator.mulPublic(r.invert().toBytes(.big), .big);
"""


def chunks(data):
    value = hashlib.sha256(data).hexdigest()
    return [value[:32], value[32:]]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--compiler", type=Path, required=True)
    parser.add_argument("--sdk-root", type=Path)
    parser.add_argument("--existing-prefix", type=Path)
    parser.add_argument("--samples", type=int, default=9)
    parser.add_argument("--iterations", type=int, default=200)
    parser.add_argument("--output", type=Path, default=ROOT / "zig/bench/results/signature-optimization")
    args = parser.parse_args()
    if args.samples < 1 or args.iterations < 1:
        parser.error("samples and iterations must be positive")
    source = (ROOT / "zig/src/protocol/signature.zig").read_text()
    if source.count(JOINT) != 1:
        raise RuntimeError("recovery source changed; review the original/joint source pair")
    snapshots = {"before": source.replace(JOINT, ORIGINAL), "after": source}
    harness = (ROOT / "zig/src/crypto_bench.zig").read_bytes()
    args.output.mkdir(parents=True, exist_ok=True)
    result = {
        "scope": "Zig public recovery/signing microbenchmark; not Rust or whole-agent performance",
        "host_limit": "Shared host; balanced pairs reduce order drift but do not establish idle-host performance",
        "samples_per_kernel_variant": args.samples,
        "iterations_per_process": args.iterations,
        "zig": subprocess.check_output([args.compiler, "version"], text=True).strip(),
        "source_sha256_chunks": {name: chunks(text.encode()) for name, text in snapshots.items()},
        "harness_sha256_chunks": chunks(harness),
        "load_start": os.getloadavg(),
        "raw": [],
        "builds": [],
    }
    output = args.output / "results.json"

    def persist():
        output.write_text(json.dumps(result, indent=2) + "\n")

    with tempfile.TemporaryDirectory(prefix="ziggy-signature-bench-") as scratch:
        temporary = Path(scratch)
        binaries = {}
        for mode in ("ReleaseSafe", "ReleaseFast"):
            for variant in ("before", "after"):
                if args.existing_prefix:
                    binary = Path(f"{args.existing_prefix}-{variant}-{mode.removeprefix('Release').lower()}")
                else:
                    tree = temporary / f"{mode}-{variant}"
                    (tree / "protocol/fixtures").mkdir(parents=True)
                    (tree / "protocol/signature.zig").write_text(snapshots[variant])
                    (tree / "crypto_bench.zig").write_bytes(harness)
                    # Test declarations embed this fixture even for an executable.
                    fixture = (ROOT / "zig/src/protocol/fixtures/ethers-recovery.json.gz").read_bytes()
                    (tree / "protocol/fixtures/ethers-recovery.json.gz").write_bytes(fixture)
                    # Historical supplied snapshots may still embed the raw name.
                    (tree / "protocol/fixtures/ethers-recovery.json").write_bytes(gzip.decompress(fixture))
                    (tree / "testing/fixtures").mkdir(parents=True)
                    (tree / "testing/fixture.zig").write_bytes((ROOT / "zig/src/testing/fixture.zig").read_bytes())
                    (tree / "testing/fixtures/gzip-probe.json.gz").write_bytes((ROOT / "zig/src/testing/fixtures/gzip-probe.json.gz").read_bytes())
                    binary = tree / "benchmark"
                    command = [str(args.compiler), "build-exe", str(tree / "crypto_bench.zig"), "-O", mode, "-lc", f"-femit-bin={binary}"]
                    if args.sdk_root:
                        command += ["--sysroot", str(args.sdk_root), "-L/usr/lib"]
                    started = time.monotonic_ns()
                    subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                    result["builds"].append({"mode": mode, "variant": variant, "elapsed_ns": time.monotonic_ns() - started})
                binaries[mode, variant] = binary
        result["binary_sha256_chunks"] = {f"{mode}/{variant}": chunks(path.read_bytes()) for (mode, variant), path in binaries.items()}
        for mode in ("ReleaseSafe", "ReleaseFast"):
            for kernel in ("recover", "sign"):
                for sample in range(args.samples):
                    checksum = None
                    order = ("before", "after") if sample % 2 == 0 else ("after", "before")
                    for variant in order:
                        value = json.loads(subprocess.check_output([binaries[mode, variant], kernel, str(args.iterations), str(41 + sample)], text=True))
                        if checksum is not None and checksum != value["checksum"]:
                            raise RuntimeError("before/after output checksum mismatch")
                        checksum = value["checksum"]
                        value.update(mode=mode, variant=variant, sample=sample, order=len(result["raw"]), ns_per_operation=value["elapsed_ns"] / value["iterations"])
                        result["raw"].append(value)
                        persist()
                    print(mode, kernel, sample + 1, "paired", flush=True)
        result["summary"] = []
        for mode in ("ReleaseSafe", "ReleaseFast"):
            for kernel in ("recover", "sign"):
                row = {"mode": mode, "kernel": kernel}
                for variant in ("before", "after"):
                    values = [r["ns_per_operation"] for r in result["raw"] if r["mode"] == mode and r["kernel"] == kernel and r["variant"] == variant]
                    row[variant] = {"median_ns": statistics.median(values), "min_ns": min(values), "max_ns": max(values)}
                row["before_over_after"] = row["before"]["median_ns"] / row["after"]["median_ns"]
                result["summary"].append(row)
        result["load_end"] = os.getloadavg()
        result["passed"] = True
        persist()
    print(json.dumps(result["summary"], indent=2))


if __name__ == "__main__":
    main()
