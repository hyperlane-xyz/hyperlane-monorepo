#!/usr/bin/env python3
"""Compile exact source snapshots into one opt-in Lander test executable.

Run `build` only in the root agent's exclusive Cargo/source-edit slot. Run
`measure` only in the exclusive measurement slot. No worktrees are created.
"""

import argparse
import base64
import gzip
from datetime import datetime, timezone
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import shutil
import statistics
import subprocess
import tempfile
import tarfile
import time

ROOT = Path(__file__).resolve().parents[4]
HERE = Path(__file__).resolve().parent
BASELINE = "7e80c603f0278c9b1f0555fe0106279e2df5f070"
PROPOSED = "d555ffbfd7d82438851e6f848ea7dfc28b2e336d"
SVM = "rust/main/lander/src/adapter/chains/sealevel/adapter.rs"
GAS = "rust/main/lander/src/adapter/chains/ethereum/adapter/gas_limit_estimator.rs"
EVM = "rust/main/lander/src/adapter/chains/ethereum/adapter.rs"
TEST = "adapter::chains::sealevel::hot_path_metrics::measure_actual_hot_paths"
SCOPE = "Controlled adapter-boundary stress, not end-to-end per-chain pipeline throughput; InclusionStage intentionally awaits transaction mutations serially."


def sha(data):
    return hashlib.sha256(data).hexdigest()


def source(commit, path):
    return subprocess.check_output(["git", "show", f"{commit}:{path}"], cwd=ROOT)


def host_info():
    values = {"system": os.uname().sysname, "release": os.uname().release, "machine": os.uname().machine}
    for field in ["machdep.cpu.brand_string", "hw.memsize", "hw.logicalcpu"]:
        values[field] = subprocess.check_output(["sysctl", "-n", field], text=True).strip()
    values["macos"] = subprocess.check_output(["sw_vers", "-productVersion"], text=True).strip()
    return values


def method(text, name):
    start = text.index(f"    async fn {name}(")
    opening = text.index("{", start)
    depth = 1
    cursor = opening + 1
    # These particular method bodies have no brace characters inside strings.
    while depth:
        depth += (text[cursor] == "{") - (text[cursor] == "}")
        cursor += 1
    return text[start:cursor]


def snapshots(directory):
    manifest = []
    for version, commit in [("baseline", BASELINE), ("proposed", PROPOSED)]:
        for kind, path in [("svm", SVM), ("gas", GAS), ("payload", EVM)]:
            raw = source(commit, path)
            text = raw.decode()
            if kind == "svm":
                text, count = re.subn(r"#\[cfg\(test\)\]\s*pub mod tests;\s*$", "", text)
                assert count == 1
                text += """
impl SealevelAdapter {
    pub(crate) fn benchmark_new(
        provider: Arc<dyn SealevelProviderForLander>,
        submitter: Arc<dyn TransactionSubmitter>,
    ) -> Self {
        use crate::adapter::chains::sealevel::adapter::tests::tests_common::{MockClient, MockOracle};
        Self::new_internal_default(Arc::new(MockClient::new()), provider, Arc::new(MockOracle::new()), submitter)
    }
}
"""
                count = "self.estimate_freshness_cache.lock().await.len()" if version == "baseline" else "self.fresh_estimates.len()"
                text += "impl SealevelAdapter { pub(crate) async fn benchmark_freshness_entries(&self) -> usize { " + count + " } }\n"
            elif kind == "gas":
                text = text[:text.index("#[cfg(test)]\npub mod tests {")]
            else:
                extracted = method(text, "reverted_payloads")
                limit = re.search(r"^const PAYLOAD_STATUS_READ_CONCURRENCY:.*$", text, re.MULTILINE)
                assert "self.provider" in extracted or ".provider" in extracted
                text = """
use std::sync::Arc;
use futures_util::{future, stream, StreamExt};
use ethers::types::H160;
use hyperlane_ethereum::EvmProviderForLander;
use crate::{adapter::EthereumTxPrecursor, payload::PayloadDetails, transaction::Transaction, LanderError};
""" + (limit[0] if limit else "") + """
pub(crate) struct PayloadAdapter {
    pub(crate) provider: Arc<dyn EvmProviderForLander>,
    pub(crate) signer: H160,
}
#[async_trait::async_trait]
trait PayloadCheck {
    async fn reverted_payloads(&self, tx: &Transaction) -> Result<Vec<PayloadDetails>, LanderError>;
}
#[async_trait::async_trait]
impl PayloadCheck for PayloadAdapter {
""" + extracted + """
}
impl PayloadAdapter {
    pub(crate) async fn benchmark_check(&self, tx: &Transaction) -> Result<Vec<PayloadDetails>, LanderError> {
        self.reverted_payloads(tx).await
    }
}
"""
            generated = directory / f"{version}_{kind}.rs"
            generated.write_text(text)
            manifest.append({
                "version": version, "commit": commit, "path": path,
                "source_sha256": sha(raw), "generated_sha256": sha(text.encode()),
                "adaptation": {"svm": "Removed test module declaration; appended constructor access and freshness-entry count only",
                               "gas": "Removed unit-test module only",
                               "payload": "Exact reverted_payloads method in provider/signer field wrapper; call-access shim only"}[kind],
            })
    return manifest


def build(out):
    out.mkdir(parents=True, exist_ok=True)
    generated = out / "generated"
    generated.mkdir(exist_ok=True)
    manifest = snapshots(generated)
    library = ROOT / "rust/main/lander/src/adapter/chains/sealevel.rs"
    original = library.read_bytes()
    hook = f'\n#[cfg(test)]\n#[path = "{HERE / "harness.rs"}"]\nmod hot_path_metrics;\n'.encode()
    hooked = original + hook
    (out / "sealevel.rs.backup").write_bytes(original)
    env = dict(os.environ, CARGO_INCREMENTAL="0", LANDER_BENCH_SNAPSHOT=str(generated))
    env.setdefault("CARGO_TARGET_DIR", "/Users/pbio/work/hm1/rust/main/target")
    command = ["cargo", "test", "-p", "lander", "--lib", "--no-run", "--locked", "--offline",
               "-j", "4", "--config", "profile.test.package.lander.opt-level=3", "--message-format=json"]
    executable = None
    leaf_profile = None
    try:
        library.write_bytes(hooked)
        with (out / "build.stderr.log").open("w") as err, (out / "build.jsonl").open("w") as log:
            process = subprocess.Popen(command, cwd=ROOT / "rust/main", env=env,
                                       stdout=subprocess.PIPE, stderr=err, text=True)
            for line in process.stdout:
                log.write(line)
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if item.get("reason") == "compiler-artifact" and item.get("target", {}).get("name") == "lander":
                    executable = item.get("executable") or executable
                    leaf_profile = item.get("profile")
            status = process.wait()
        if status:
            raise RuntimeError(f"Cargo failed ({status}); see {out / 'build.stderr.log'} and build.jsonl")
        assert executable, "No Lander unit-test executable found"
        binary = out / "lander-hotpaths-bench"
        shutil.copy2(executable, binary)
    finally:
        current = library.read_bytes()
        if current == hooked:
            library.write_bytes(original)
        elif current.endswith(hook):
            library.write_bytes(current[:-len(hook)])
            raise RuntimeError("Concurrent source edit detected; removed only our hook; inspect sealevel.rs")
        else:
            raise RuntimeError(f"Concurrent source edit detected; backup: {out / 'sealevel.rs.backup'}")
    info = {
        "baseline": BASELINE, "proposed": PROPOSED, "sources": manifest,
        "command": command, "target_dir": env["CARGO_TARGET_DIR"],
        "profile": "Lander test leaf opt-level=3; dependencies retain cached test/debug profile",
        "leaf_profile": leaf_profile,
        "rustc": subprocess.check_output(["rustc", "--version"], cwd=ROOT / "rust/main", text=True).strip(),
        "parent_path": str(library.relative_to(ROOT)),
        "parent_before_sha256": sha(original), "parent_after_sha256": sha(library.read_bytes()),
        "binary_sha256": sha(binary.read_bytes()),
        "harness_sha256": sha((HERE / "harness.rs").read_bytes()),
        "host": host_info(),
        "built_at_utc": datetime.now(timezone.utc).isoformat(),
        "benchmark_scope": SCOPE,
    }
    (out / "build-manifest.json").write_text(json.dumps(info, indent=2) + "\n")
    print(json.dumps({"binary": str(binary), "manifest": str(out / "build-manifest.json")}))


def percentile(values, fraction):
    values = sorted(values)
    return values[max(0, math.ceil(len(values) * fraction) - 1)]


def time_metrics(text):
    result = {}
    first = re.search(r"([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys", text)
    if first:
        result.update(process_real_s=float(first[1]), process_user_s=float(first[2]), process_sys_s=float(first[3]))
    rss = re.search(r"(\d+)\s+maximum resident set size", text)
    if rss:
        result["process_peak_rss_bytes"] = int(rss[1])
    return result


def measure(out, controls=False):
    manifest = json.loads((out / "build-manifest.json").read_text())
    binary = out / "lander-hotpaths-bench"
    assert sha(binary.read_bytes()) == manifest["binary_sha256"]
    assert sha((HERE / "harness.rs").read_bytes()) == manifest["harness_sha256"]
    manifest["measured_at_utc"] = datetime.now(timezone.utc).isoformat()
    manifest["measurement_host"] = host_info()
    manifest["benchmark_scope"] = SCOPE
    result_out = out / "controls" if controls else out
    result_out.mkdir(exist_ok=True)
    summary = []
    process_metrics = []
    raw_dir = result_out / "raw"
    raw_dir.mkdir(exist_ok=True)
    cases = [(width, "svm_prepare_submit") for width in [1, 8]] if controls else [(32, case) for case in ["svm_submit", "svm_prepare_submit", "evm_gas", "evm_payload"]]
    for width, case in cases:
        for scenario in (["uniform"] if controls else ["uniform", "straggler", "no_io"]):
            all_samples = {"baseline": [], "proposed": []}
            case_processes = {"baseline": [], "proposed": []}
            for pass_number, versions in enumerate([["baseline", "proposed"], ["proposed", "baseline"]]):
                for version in versions:
                    name = f"{case}-{scenario}-{version}-pass{pass_number}"
                    if controls:
                        name = f"width{width}-" + name
                    env = dict(os.environ, BENCH_CASE=case, BENCH_SCENARIO=scenario, BENCH_VERSION=version,
                               BENCH_BATCHES="1000" if scenario == "no_io" else "50", BENCH_WIDTH=str(width))
                    command = ["/usr/bin/time", "-l", str(binary), "--exact", TEST,
                               "--ignored", "--nocapture", "--test-threads=1"]
                    started = time.monotonic()
                    process = subprocess.run(command, env=env, capture_output=True, text=True)
                    (result_out / f"{name}.stdout.log").write_text(process.stdout)
                    (result_out / f"{name}.time.log").write_text(process.stderr)
                    if process.returncode:
                        raise RuntimeError(f"{name} failed ({process.returncode})")
                    line = next(line.split("LANDER_BENCH_JSON=", 1)[1] for line in process.stdout.splitlines()
                                if "LANDER_BENCH_JSON=" in line)
                    raw = json.loads(line)
                    with gzip.open(raw_dir / f"{name}.json.gz", "wt") as stream:
                        json.dump(raw, stream, separators=(",", ":"))
                    all_samples[version].extend(raw["samples"])
                    timings = {"case": case, "scenario": scenario, "version": version, "width": width, "pass": pass_number,
                               "runner_elapsed_s": time.monotonic() - started, **time_metrics(process.stderr)}
                    timings["freshness_entries_final"] = raw["samples"][-1]["freshness_entries"]
                    assert "process_user_s" in timings and "process_peak_rss_bytes" in timings, process.stderr
                    case_processes[version].append(timings)
                    process_metrics.append(timings)
                    (result_out / "process-metrics.json").write_text(json.dumps(process_metrics, indent=2) + "\n")
                    print(json.dumps(timings), flush=True)
            for version, samples in all_samples.items():
                elapsed = [sample["elapsed_ms"] for sample in samples]
                latency = [value for sample in samples for value in sample["operation_latency_ms"]]
                ops = width * len(samples)
                seconds = sum(elapsed) / 1000
                processes = case_processes[version]
                row = {
                    "case": case, "scenario": scenario, "version": version, "width": width,
                    "batches": len(samples), "operations": ops,
                    "batch_p50_ms": percentile(elapsed, .50), "batch_p95_ms": percentile(elapsed, .95),
                    "operation_p50_ms": percentile(latency, .50), "operation_p95_ms": percentile(latency, .95),
                    "operations_per_second": ops / seconds,
                    "peak_inflight": max(sample["peak_inflight"] for sample in samples),
                    "provider_requests": sum(sample["provider_requests"] for sample in samples),
                    "measured_wall_s": seconds,
                    "process_cpu_s_mean": statistics.mean(p["process_user_s"] + p["process_sys_s"] for p in processes),
                    "process_peak_rss_bytes_max": max(p["process_peak_rss_bytes"] for p in processes),
                    "freshness_entries_max": max((sample["freshness_entries"] for sample in samples
                                                   if sample["freshness_entries"] is not None), default=None),
                    "freshness_entries_final_per_pass": [p["freshness_entries_final"] for p in processes],
                    "process_passes": processes,
                }
                summary.append(row)
                (result_out / "summary.json").write_text(json.dumps({"manifest": manifest, "results": summary}, indent=2) + "\n")
                print(json.dumps(row), flush=True)


def published(value):
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            if key.endswith("_sha256"):
                result[key + "_base64"] = base64.b64encode(bytes.fromhex(item)).decode()
            else:
                result[key] = published(item)
        return result
    if isinstance(value, list):
        return [published(item) for item in value]
    return value


def export_raw(out, target):
    entries = []
    for prefix, directory in [("main", out / "raw"), ("controls", out / "controls/raw")]:
        for source in sorted(directory.glob("*.json.gz")):
            with gzip.open(source, "rb") as stream:
                data = stream.read()
            name = f"{prefix}/{source.name.removesuffix('.gz')}"
            assert not Path(name).is_absolute() and ".." not in Path(name).parts
            entries.append((name, data))
    assert len(entries) == 56, f"Expected 48 main + 8 control samples, found {len(entries)}"
    entries.sort(key=lambda entry: entry[0])
    archive = target / "raw-samples.tar.gz"
    with archive.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0, compresslevel=9) as zipped:
            with tarfile.open(fileobj=zipped, mode="w", format=tarfile.USTAR_FORMAT) as tar:
                for name, data in entries:
                    member = tarfile.TarInfo(name)
                    member.size = len(data)
                    member.mode = 0o644
                    member.uid = member.gid = member.mtime = 0
                    member.uname = member.gname = ""
                    tar.addfile(member, io.BytesIO(data))
    with tarfile.open(archive, "r:gz") as tar:
        members = tar.getmembers()
        assert [member.name for member in members] == [name for name, _ in entries]
        for member, (_, data) in zip(members, entries):
            assert member.isfile() and not Path(member.name).is_absolute()
            assert ".." not in Path(member.name).parts
            assert tar.extractfile(member).read() == data
    metadata = {
        "archive": archive.name,
        "archive_sha256_base64": base64.b64encode(hashlib.sha256(archive.read_bytes()).digest()).decode(),
        "entry_count": len(entries),
        "format": "Sorted USTAR JSON entries; uid/gid/mtime zero, mode 0644; gzip filename empty and mtime zero",
        "entries": [{"path": name, "size_bytes": len(data),
                     "sha256_base64": base64.b64encode(hashlib.sha256(data).digest()).decode()}
                    for name, data in entries],
    }
    (target / "raw-samples-manifest.json").write_text(json.dumps(metadata, indent=2) + "\n")
    # Remove only this exporter's superseded, task-owned individual raw files.
    for directory in [target / "raw", target / "controls/raw"]:
        if directory.exists():
            files = list(directory.iterdir())
            assert all(path.is_file() and path.name.endswith(".json.gz") for path in files), directory
            for path in files:
                path.unlink()
            directory.rmdir()


def curate(out):
    target = HERE / "results"
    target.mkdir(exist_ok=True)
    for name in ["build-manifest.json", "process-metrics.json", "summary.json"]:
        value = json.loads((out / name).read_text())
        if name == "build-manifest.json":
            value["benchmark_scope"] = SCOPE
        elif name == "summary.json":
            value["manifest"]["benchmark_scope"] = SCOPE
            for row in value["results"]:
                row.setdefault("width", row["operations"] // row["batches"])
        (target / name).write_text(json.dumps(published(value), indent=2) + "\n")
    summary = json.loads((out / "summary.json").read_text())
    rows = {(row["case"], row["scenario"], row["version"]): row for row in summary["results"]}
    latency = ["# Measured Lander comparisons", "", SCOPE, "", "The main tables pre-admit 32 operations directly to the adapter. They bypass InclusionStage's serialized transaction-mutation loop. Ops/s below means adapter operations/s, not deployed per-chain pipeline throughput.", "", "Values are baseline → proposed. All times are milliseconds unless marked otherwise.", "",
               "| Case | Scenario | Batch p50 | Batch p95 | Operation p50 | Operation p95 | Adapter ops/s |",
               "| --- | --- | ---: | ---: | ---: | ---: | ---: |"]
    resources = ["", "CPU is mean whole-process CPU per pass, including setup/warm-ups/fixtures/output. RSS is max process peak across passes.", "",
                 "| Case | Scenario | Peak in-flight | Calls/batch | CPU ms/pass | Peak RSS MiB | Retained entries |",
                 "| --- | --- | ---: | ---: | ---: | ---: | ---: |"]
    for case in ["svm_submit", "svm_prepare_submit", "evm_gas", "evm_payload"]:
        for scenario in ["uniform", "straggler", "no_io"]:
            before, after = [rows[(case, scenario, version)] for version in ["baseline", "proposed"]]
            pair = lambda key: f'{before[key]:.6f} → {after[key]:.6f}'
            latency.append(f'| {case} | {scenario} | {pair("batch_p50_ms")} | {pair("batch_p95_ms")} | {pair("operation_p50_ms")} | {pair("operation_p95_ms")} | {before["operations_per_second"]:.1f} → {after["operations_per_second"]:.1f} |')
            calls = before["provider_requests"] // before["batches"]
            assert calls == after["provider_requests"] // after["batches"]
            cpu = [row["process_cpu_s_mean"] * 1000 for row in [before, after]]
            rss = [row["process_peak_rss_bytes_max"] / 1024 ** 2 for row in [before, after]]
            retained = f'{before["freshness_entries_max"]} → {after["freshness_entries_max"]}' if before["freshness_entries_max"] is not None else "—"
            resources.append(f'| {case} | {scenario} | {before["peak_inflight"]} → {after["peak_inflight"]} | {calls} | {cpu[0]:.1f} → {cpu[1]:.1f} | {rss[0]:.2f} → {rss[1]:.2f} | {retained} |')
    controls = []
    controls_out = out / "controls"
    if (controls_out / "summary.json").exists():
        controls_target = target / "controls"
        controls_target.mkdir(exist_ok=True)
        for name in ["summary.json", "process-metrics.json"]:
            value = json.loads((controls_out / name).read_text())
            (controls_target / name).write_text(json.dumps(published(value), indent=2) + "\n")
        data = json.loads((controls_out / "summary.json").read_text())
        by_width = {(row["width"], row["version"]): row for row in data["results"]}
        controls = ["", "## Fresh-path controls below the estimate cap", "", "Same binary/provider/ABBA protocol, uniform delay. These remain adapter controls, not complete InclusionStage pipeline measurements.", "",
                    "| Width | Batch p50 | Batch p95 | Operation p95 | Peak in-flight | Calls/batch | Retained entries |",
                    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: |"]
        for width in [1, 8]:
            before, after = [by_width[(width, version)] for version in ["baseline", "proposed"]]
            pair = lambda key: f'{before[key]:.6f} → {after[key]:.6f}'
            controls.append(f'| {width} | {pair("batch_p50_ms")} | {pair("batch_p95_ms")} | {pair("operation_p95_ms")} | {before["peak_inflight"]} → {after["peak_inflight"]} | {width * 3} | {before["freshness_entries_max"]} → {after["freshness_entries_max"]} |')
    export_raw(out, target)
    (HERE / "COMPARISON.md").write_text("\n".join(latency + resources + controls) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["build", "measure", "controls", "curate"])
    parser.add_argument("--out", type=Path, default=Path("/tmp/hm1-lander-hotpath-benchmark"))
    arguments = parser.parse_args()
    {"build": build, "measure": measure, "controls": lambda out: measure(out, controls=True), "curate": curate}[arguments.action](arguments.out.resolve())
