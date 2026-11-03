#!/usr/bin/env python3
"""Build/run paired experiments against actual Git source, without worktrees.

Only docs files persist. Package files receive a temporary cfg(test) module hook
during build and are restored byte-for-byte, including on build failure.
"""

import argparse
import base64
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import statistics
import subprocess
import shutil
import tempfile
from datetime import datetime, timezone


ROOT = Path(__file__).resolve().parents[4]
HERE = Path(__file__).resolve().parent
PACKAGES = {
    "multisig": {
        "package": "hyperlane-base",
        "source": "rust/main/hyperlane-base/src/types/multisig.rs",
        "test": "types::multisig::hot_path_bench::measure_hot_paths",
        "target": "hyperlane_base",
    },
    "scraper": {
        "package": "scraper",
        "source": "rust/main/agents/scraper/src/store/storage.rs",
        "test": "store::storage::hot_path_bench::measure_hot_paths",
        "target": "scraper",
    },
}
DEFAULT_BEFORE = "7e80c603f0278c9b1f0555fe0106279e2df5f070"
DEFAULT_AFTER = "d555ffbfd7d82438851e6f848ea7dfc28b2e336d"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def git_source(revision, path):
    return subprocess.check_output(["git", "show", f"{revision}:{path}"], cwd=ROOT)


def production_prefix(data):
    marker = b"\n#[cfg(test)]\n"
    if marker not in data:
        raise RuntimeError("expected original test-module boundary")
    return data.split(marker, 1)[0] + b"\n"


def build(args):
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    state = {
        "before": args.before,
        "after": args.after,
        "built_at_utc": datetime.now(timezone.utc).isoformat(),
        "profile": "Cargo test profile; hot-path leaf crates opt-level=3, dependency profile unchanged (normally opt-level=0)",
        "rustc": subprocess.check_output(["rustc", "--version"], cwd=ROOT / "rust/main", text=True).strip(),
        "platform": platform.platform(),
        "machine": platform.machine(),
        "workspace_lock_sha256": digest((ROOT / "rust/main/Cargo.lock").read_bytes()),
        "sources": {},
        "harness_sha256": {path.name: digest(path.read_bytes()) for path in HERE.glob("*.rs")},
        "artifacts": {},
        "artifact_profiles": {},
    }
    originals = {}
    injections = {}
    with tempfile.TemporaryDirectory(prefix="hm1-hotpath-rust-") as temporary:
        temporary = Path(temporary)
        try:
            for name, config in PACKAGES.items():
                path = ROOT / config["source"]
                original = path.read_bytes()
                proposed = git_source(args.after, config["source"])
                if production_prefix(original) != production_prefix(proposed):
                    raise RuntimeError(f"working production source differs from pinned proposed SHA: {path}")
                baseline = git_source(args.before, config["source"])
                generated = production_prefix(baseline)
                adjustments = ["removed original test modules after cfg(test) boundary"]
                if name == "scraper":
                    # Rust include! cannot carry the file's inner doc comment.
                    generated = b"\n".join(line for line in generated.split(b"\n") if not line.startswith(b"//!"))
                    adjustments.append("removed inner module doc comment")
                    for method in ["ensure_blocks", "ensure_txns"]:
                        old = f"    async fn {method}(".encode()
                        new = f"    pub(super) async fn {method}(".encode()
                        if generated.count(old) != 1:
                            raise RuntimeError(f"expected exactly one baseline method: {method}")
                        generated = generated.replace(old, new, 1)
                    adjustments.append("changed visibility of two private enrichment methods to pub(super), no body edits")
                (temporary / f"{name}_before.rs").write_bytes(generated)
                state["sources"][name] = {
                    "path": config["source"],
                    "before_original_sha256": digest(baseline),
                    "before_production_prefix_sha256": digest(production_prefix(baseline)),
                    "before_compiled_prefix_sha256": digest(generated),
                    "after_production_prefix_sha256": digest(production_prefix(proposed)),
                    "adjustments": adjustments,
                }
                harness = HERE / f"{name}.rs"
                # An absolute #[path] points only at the checked-in harness. All
                # generated Git source is included by env! inside that harness.
                if '"' in str(harness):
                    raise RuntimeError("unsupported quote in harness path")
                hook = f'\n#[cfg(test)]\n#[path = "{harness}"]\nmod hot_path_bench;\n'.encode()
                originals[path] = original
                injections[path] = original + hook
                path.write_bytes(injections[path])
            env = os.environ.copy()
            env.update({
                "CARGO_INCREMENTAL": "0",
                "HOTPATH_SOURCE_DIR": str(temporary),
                "HOTPATH_HARNESS_DIR": str(HERE),
            })
            command = ["cargo", "test", "--no-run", "--locked", "--offline", "-j4", "--message-format=json"]
            for config in PACKAGES.values():
                command.extend(["-p", config["package"]])
                command.extend(["--config", f'profile.test.package.{config["package"]}.opt-level=3'])
            state["build_command"] = command
            print("Build:", " ".join(command), flush=True)
            with (output / "build.jsonl").open("w") as stdout, (output / "build.stderr.log").open("w") as stderr:
                result = subprocess.run(command, cwd=ROOT / "rust/main", env=env, stdout=stdout, stderr=stderr)
            if result.returncode:
                raise RuntimeError(f"Cargo build failed; inspect {output / 'build.stderr.log'} and build.jsonl")
            for line in (output / "build.jsonl").read_text().splitlines():
                try:
                    artifact = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if artifact.get("reason") != "compiler-artifact" or not artifact.get("profile", {}).get("test"):
                    continue
                for name, config in PACKAGES.items():
                    if artifact.get("target", {}).get("name") == config["target"] and artifact.get("executable"):
                        state["artifacts"][name] = artifact["executable"]
                        state["artifact_profiles"][name] = artifact["profile"]
            if set(state["artifacts"]) != set(PACKAGES):
                raise RuntimeError(f"missing test executables: {state['artifacts']}")
            (output / "manifest.json").write_text(json.dumps(state, indent=2) + "\n")
        finally:
            changed = []
            for path, original in originals.items():
                if path.read_bytes() != injections[path]:
                    # Preserve independent edits rather than overwrite them.
                    recovery = output / f"recovery-{path.parent.name}-{path.name}"
                    recovery.write_bytes(original)
                    changed.append(str(path))
                    continue
                path.write_bytes(original)
            if changed:
                raise RuntimeError(f"concurrent source changes detected, originals preserved under {output}: {changed}")
    print("Built binaries; temporary package hooks restored. No benchmark timing has run.", flush=True)


def percentile(values, fraction):
    values = sorted(values)
    return values[max(0, math.ceil(len(values) * fraction) - 1)]


def summarize(output):
    groups = {}
    for name in PACKAGES:
        for line in (output / f"{name}.samples.jsonl").read_text().splitlines():
            sample = json.loads(line)
            if sample["warmup"]:
                continue
            key = (sample["case"], sample["scenario"], sample["version"])
            groups.setdefault(key, []).append(sample)
    results = []
    for (case, scenario, version), samples in sorted(groups.items()):
        elapsed = [sample["elapsed_ns"] / 1_000_000 for sample in samples]
        results.append({
            "case": case, "scenario": scenario, "version": version,
            "samples": len(samples), "p50_ms": statistics.median(elapsed),
            "p95_ms": percentile(elapsed, 0.95),
            "items_per_batch": samples[0]["items"],
            "throughput_unit": "quorums/s" if case == "multisig_quorum" else "records/s",
            "batch_normalized_items_per_second": sum(sample["items"] for sample in samples) / (sum(elapsed) / 1000),
            "requests": {"min": min(sample["requests"] for sample in samples), "median": statistics.median(sample["requests"] for sample in samples), "max": max(sample["requests"] for sample in samples)},
            "peak_concurrency": {"min": min(sample["peak_concurrency"] for sample in samples), "max": max(sample["peak_concurrency"] for sample in samples)},
        })
    (output / "summary.json").write_text(json.dumps(results, indent=2) + "\n")
    pairs = {}
    for result in results:
        pairs.setdefault((result["case"], result["scenario"]), {})[result["version"]] = result
    table = ["| Workload | Before p50/p95 ms | After p50/p95 ms | p50 ratio | Requests before/after | Peak before/after |", "|---|---:|---:|---:|---:|---:|"]
    for (case, scenario), pair in sorted(pairs.items()):
        before, after = pair["before"], pair["after"]
        table.append(f'| {case}/{scenario} | {before["p50_ms"]:.3f}/{before["p95_ms"]:.3f} | {after["p50_ms"]:.3f}/{after["p95_ms"]:.3f} | {before["p50_ms"] / after["p50_ms"]:.2f}x | {before["requests"]["median"]:g}/{after["requests"]["median"]:g} | {before["peak_concurrency"]["max"]}/{after["peak_concurrency"]["max"]} |')
    (output / "table.md").write_text("\n".join(table) + "\n")


def measure(args):
    output = args.output.resolve()
    manifest = json.loads((output / "manifest.json").read_text())
    for filename, expected in manifest["harness_sha256"].items():
        if digest((HERE / filename).read_bytes()) != expected:
            raise RuntimeError(f"harness changed after build; rebuild before measuring: {filename}")
    # This command deliberately never invokes Cargo: the parent coordinates
    # timing only after every parallel agent has stopped compiling.
    for name, config in PACKAGES.items():
        samples = output / f"{name}.samples.jsonl"
        samples.unlink(missing_ok=True)
        env = os.environ.copy()
        env.update({
            "HOTPATH_SAMPLES": str(samples),
            "HOTPATH_WARMUP": str(args.warmup),
            "HOTPATH_REPETITIONS": str(args.repetitions),
        })
        command = [manifest["artifacts"][name], "--ignored", "--exact", config["test"], "--nocapture", "--test-threads=1"]
        envelope = output / f"{name}.process-time.txt"
        if platform.system() == "Darwin":
            command = ["/usr/bin/time", "-l", "-o", str(envelope)] + command
        elif Path("/usr/bin/time").exists():
            command = ["/usr/bin/time", "-v", "-o", str(envelope)] + command
        print(f"Measuring {name}: {args.repetitions} repetitions/version/scenario, {args.warmup} warmups, alternating AB/BA", flush=True)
        with (output / f"{name}.test.log").open("w") as log:
            subprocess.run(command, cwd=ROOT / "rust/main", env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
    manifest["measured_at_utc"] = datetime.now(timezone.utc).isoformat()
    manifest["repetitions"] = args.repetitions
    manifest["warmups"] = args.warmup
    manifest["p50_definition"] = "sample median"
    manifest["p95_definition"] = "nearest-rank percentile, ceil(n*0.95)"
    manifest["process_envelope"] = "time -l/-v files cover both versions, warmups, fixture setup and test runtime; not per-version CPU/RSS"
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    summarize(output)
    print((output / "table.md").read_text(), flush=True)


def export_results(args):
    """Curate portable evidence, excluding compiler logs and executable paths."""
    output = args.output.resolve()
    destination = args.destination.resolve()
    destination.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((output / "manifest.json").read_text())
    if "measured_at_utc" not in manifest:
        raise RuntimeError("measurement has not completed")
    manifest["compiled_targets"] = sorted(manifest.pop("artifacts"))

    def encode_digests(value):
        if isinstance(value, dict):
            result = {}
            for key, child in value.items():
                if key.endswith("_sha256"):
                    if isinstance(child, dict):
                        result[f"{key}_base64"] = {name: base64.b64encode(bytes.fromhex(hex_digest)).decode("ascii") for name, hex_digest in child.items()}
                    else:
                        result[f"{key}_base64"] = base64.b64encode(bytes.fromhex(child)).decode("ascii")
                else:
                    result[key] = encode_digests(child)
            return result
        if isinstance(value, list):
            return [encode_digests(child) for child in value]
        return value

    (destination / "manifest.json").write_text(json.dumps(encode_digests(manifest), indent=2) + "\n")
    names = ["summary.json", "table.md"]
    for name in PACKAGES:
        names.extend([f"{name}.samples.jsonl", f"{name}.process-time.txt"])
    for name in names:
        shutil.copyfile(output / name, destination / name)
    print(f"Curated evidence written to {destination}; compiler logs/binaries remain outside the repository.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=["build", "measure", "export"])
    parser.add_argument("--before", default=DEFAULT_BEFORE)
    parser.add_argument("--after", default=DEFAULT_AFTER)
    parser.add_argument("--output", type=Path, default=Path(tempfile.gettempdir()) / "hm1-hotpath-rust-bench")
    parser.add_argument("--warmup", type=int, default=5)
    parser.add_argument("--repetitions", type=int, default=30)
    parser.add_argument("--destination", type=Path, default=HERE / "results")
    args = parser.parse_args()
    if args.warmup < 0 or args.repetitions < 2:
        parser.error("warmup must be nonnegative and repetitions >= 2")
    {"build": build, "measure": measure, "export": export_results}[args.phase](args)


if __name__ == "__main__":
    main()
