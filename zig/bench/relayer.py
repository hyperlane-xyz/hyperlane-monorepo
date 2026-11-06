#!/usr/bin/env python3
"""Matched actual Rust/Zig relayer daemons on disposable Anvil, public key11 only.

Execution requires --execute and checked c520224 provenance. No inherited
endpoints, credentials, production databases, or unverified performance claims.
"""
from __future__ import annotations

import argparse
import collections
from datetime import datetime, timezone
import gzip
import hashlib
import http.server
import json
import os
import pathlib
import platform
import shutil
import signal
import socket
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "integration"))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import evm
import inventory
import relayer_process
import validator

ROOT = evm.ROOT
ORIGIN, DESTINATION, DESTINATION_ALT = 9913371, 9913372, 9913373
PUBLIC_KEY = "0x" + "11" * 32
CURL_LIBRARY = "/usr/lib/libcurl.4.dylib"
ACCEPTED_ORACLE_SHA256 = "8e295002b44b4248d00d6627aaa47a21" + "2315f6f837f3a2d652f2e7f6ada69fd9"


def chunks(value):
    text = str(value)
    return [text[i:i + 32] for i in range(0, len(text), 32)] or [""]


def digest(path):
    return chunks(hashlib.sha256(path.read_bytes()).hexdigest())


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def pin_binary(source, output, name):
    source = source.resolve()
    identity = digest(source)
    target = output / "pinned" / identity[0] / name
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        if digest(target) != identity:
            raise RuntimeError(f"pinned {name} digest mismatch")
    else:
        shutil.copy2(source, target)
    if digest(target) != identity or digest(source) != identity:
        raise RuntimeError(f"{name} changed while pinning; wait for build completion")
    return target


def source_inventory():
    entries = {}
    excluded = {"target", ".zig-cache", "zig-out", ".git", "node_modules", "__pycache__", ".cache"}
    roots = ["zig/src", "zig/native", "zig/integration", "zig/reference/rocks", "rust/main/agents/relayer", "rust/main/lander", "rust/main/chains", "rust/main/hyperlane-base", "rust/main/hyperlane-core", "rust/main/.cargo", "solidity/contracts", "solidity/lib"]
    for root in roots:
        for directory, subdirs, files in os.walk(ROOT / root):
            subdirs[:] = sorted(name for name in subdirs if not inventory.pruned(name))
            for name in sorted(files):
                path = pathlib.Path(directory) / name
                if path.suffix in {".zig", ".rs", ".toml", ".lock", ".json", ".jsonl", ".gz", ".py", ".h", ".c", ".sol"} and not (path.suffix != ".gz" and pathlib.Path(str(path) + ".gz").exists()):
                    entries[str(path.relative_to(ROOT))] = digest(path)
    for name in ["zig/build.zig", "zig/build.zig.zon", "rust/main/Cargo.lock", "rust/main/Cargo.toml", "zig/bench/relayer.py"]:
        path = ROOT / name
        if path.exists():
            entries[name] = digest(path)
    return entries


def compiler_inventory():
    result = subprocess.run(["ps", "-axo", "pid,etime,pcpu,comm"], text=True, capture_output=True, timeout=10)
    names = {"cargo", "rustc", "zig", "clang", "solc", "pnpm"}
    return [line for line in result.stdout.splitlines() if line.split() and pathlib.Path(line.split()[-1]).name in names]


def load_provenance(path, binaries, oracle):
    value = json.loads(path.read_text())
    if value.get("baseline") != "c520224":
        raise RuntimeError("baseline provenance must identify c520224")
    for name, binary in binaries.items():
        expected = value.get(f"{name}_sha256")
        if not expected:
            raise RuntimeError(f"provenance missing {name}_sha256")
        actual = "".join(digest(binary)).lower()
        expected_text = "".join(expected) if isinstance(expected, list) else expected
        if expected_text.lower().removeprefix("0x") != actual:
            raise RuntimeError(f"{name} does not match provenance")
    expected_oracle = value.get("oracle_sha256")
    if not expected_oracle:
        raise RuntimeError("provenance missing oracle_sha256")
    actual_oracle = "".join(digest(oracle)).lower()
    expected_text = "".join(expected_oracle) if isinstance(expected_oracle, list) else expected_oracle
    normalized_oracle = expected_text.lower().removeprefix("0x")
    if normalized_oracle != ACCEPTED_ORACLE_SHA256 or actual_oracle != ACCEPTED_ORACLE_SHA256:
        raise RuntimeError("oracle does not match accepted immutable provenance")
    return value


class CountingProxy:
    def __init__(self, target, chain_namespace):
        self.target = target
        self.chain_namespace = chain_namespace
        self.counts = collections.Counter()
        self.method_times = collections.defaultdict(list)
        self.http_requests = 0
        self.signed = []
        self.receipt_stalls = 0
        self.receipt_observations = {}
        self.fault_start_ns = 0
        self.fault_end_ns = 0
        self.fault_events = []
        self.next_fault_id = 0
        self.stop_event = threading.Event()
        self.lock = threading.Lock()

    def snapshot(self):
        with self.lock:
            return {
                "http_requests": self.http_requests,
                "json_rpc_subrequests": sum(self.counts.values()),
                "methods": dict(self.counts),
                "method_times": {method: list(times) for method, times in self.method_times.items()},
                "broadcast_attempts": len(self.signed),
                "receipt_stalls": self.receipt_stalls,
                "fault_start_ns": self.fault_start_ns,
                "fault_end_ns": self.fault_end_ns,
                "receipt_observations": list(self.receipt_observations.values()),
            }

    def signed_transactions(self):
        with self.lock:
            return list(self.signed)

    def observations(self):
        with self.lock:
            return list(self.receipt_observations.values())

    def start_fault(self):
        with self.lock:
            now = time.perf_counter_ns()
            self.fault_start_ns = now
            self.fault_end_ns = now + 3_000_000_000

    def fault_record(self):
        with self.lock:
            return {"start_ns": self.fault_start_ns, "end_ns": self.fault_end_ns, "events": list(self.fault_events)}

    def fault_remaining(self, now):
        with self.lock:
            if self.fault_start_ns <= now < self.fault_end_ns:
                return (self.fault_end_ns - now) / 1e9
            return None

    def __enter__(self):
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self):
                data = self.rfile.read(int(self.headers.get("content-length", "0")))
                try:
                    decoded = json.loads(data)
                    requests = decoded if isinstance(decoded, list) else [decoded]
                    with owner.lock:
                        owner.http_requests += 1
                        for request in requests:
                            method = request.get("method", "invalid")
                            owner.counts[method] += 1
                            owner.method_times[method].append(time.perf_counter_ns())
                            if method == "eth_sendRawTransaction":
                                owner.signed.append(request["params"][0])
                    if any(request.get("method") == "eth_getTransactionReceipt" for request in requests):
                        now = time.perf_counter_ns()
                        remaining = owner.fault_remaining(now)
                        if remaining is not None:
                            with owner.lock:
                                owner.receipt_stalls += 1
                                owner.next_fault_id += 1
                                fault_id = owner.next_fault_id
                                owner.fault_events.append({"id": fault_id, "event": "accepted", "time_ns": now})
                            owner.stop_event.wait(remaining)
                            retired = time.perf_counter_ns()
                            with owner.lock:
                                owner.fault_events.append({"id": fault_id, "event": "retired", "time_ns": retired})
                            self.close_connection = True
                            return
                    upstream = urllib.request.Request(owner.target, data=data, headers={"Content-Type": "application/json"})
                    with urllib.request.urlopen(upstream, timeout=20) as response:
                        body = response.read()
                        status = response.status
                    try:
                        response_json = json.loads(body)
                        response_values = response_json if isinstance(response_json, list) else [response_json]
                        for request, result in zip(requests, response_values):
                            if request.get("method") == "eth_getTransactionReceipt" and isinstance(result.get("result"), dict) and result["result"].get("blockNumber") is not None:
                                observed = result["result"]
                                tx_hash = observed.get("transactionHash")
                                key = (owner.chain_namespace, tx_hash)
                                observed_ns = time.perf_counter_ns()
                                with owner.lock:
                                    if tx_hash is not None and key not in owner.receipt_observations:
                                        owner.receipt_observations[key] = {
                                            "time_ns": observed_ns,
                                            "hash": tx_hash,
                                            "chain_namespace": owner.chain_namespace,
                                            "block_number": observed.get("blockNumber"),
                                            "status": observed.get("status"),
                                            "logs": [{"address": log.get("address"), "topics": list(log.get("topics", []))} for log in observed.get("logs", [])],
                                        }
                    except (ValueError, TypeError):
                        pass
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                except (OSError, ValueError, urllib.error.URLError):
                    self.close_connection = True

            def log_message(self, *args):
                pass

        class Server(http.server.ThreadingHTTPServer):
            daemon_threads = True

        self.server = Server(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=0.01), daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        return self

    def __exit__(self, *args):
        self.stop_event.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


class MeasuredProcess(validator.MeasuredProcess):
    def full_log(self):
        self.out.seek(0)
        self.err.seek(0)
        return self.out.read() + self.err.read()

    def stop_with_signal(self, sig):
        started = time.perf_counter_ns()
        if self.poll() is None:
            self.p.send_signal(sig)
        until = time.monotonic() + 30
        while self.poll() is None and time.monotonic() < until:
            time.sleep(0.01)
        if self.poll() is None:
            self.p.kill()
            _, status, self.usage = os.wait4(self.p.pid, 0)
            self.status = os.waitstatus_to_exitcode(status)
            self.p.returncode = self.status
        self.end_ns = time.perf_counter_ns()
        return {
            "signal": "SIGINT" if sig == signal.SIGINT else "SIGTERM",
            "exit_code": self.status,
            "user_seconds": self.usage.ru_utime,
            "system_seconds": self.usage.ru_stime,
            "max_rss_bytes": self.usage.ru_maxrss if sys.platform == "darwin" else self.usage.ru_maxrss * 1024,
            "process_wall_seconds": (self.end_ns - self.start_ns) / 1e9,
            "shutdown_ms": (self.end_ns - started) / 1e6,
        }


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def environment(name, config_file, config_dir):
    if name == "rust":
        return {"CONFIG_FILES": str(config_file)}
    return {"HYPERLANE_ZIG_DEFAULTS": str(config_dir), "HYPERLANE_CURL_LIBRARY": CURL_LIBRARY}


def launch(name, binary, cwd, config_file, config_dir):
    return MeasuredProcess(binary, cwd, environment(name, config_file, config_dir))


def wait_for(process, predicate, seconds, description):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"agent exited {process.status} waiting for {description}: {process.logs()}")
        if predicate():
            return time.perf_counter_ns()
        time.sleep(0.005)
    raise RuntimeError(f"deadline waiting for {description}: {process.logs()}")


def metrics_probe(port):
    url = f"http://127.0.0.1:{port}/metrics"
    with urllib.request.urlopen(url, timeout=4) as response:
        body = response.read(8 * 1024 * 1024)
        status = response.status
    with urllib.request.urlopen(urllib.request.Request(url, method="HEAD"), timeout=4) as response:
        head_body = response.read()
        head_status = response.status
    if status != 200 or head_status != 200 or head_body:
        raise RuntimeError("metrics GET/HEAD contract failed")
    if b'agent="relayer"' not in body or b'hyperlane_baselib_version="3.0.0"' not in body:
        raise RuntimeError("source relayer 3.0 metric labels missing")
    return {
        "get_status": status,
        "head_status": head_status,
        "head_bytes": len(head_body),
        "bytes": len(body),
        "help_inventory_count": body.count(b"# HELP"),
        "hyperlane_help_inventory_count": body.count(b"# HELP hyperlane_"),
        "source_base_version": "3.0.0",
        "sha256_chunks": chunks(hashlib.sha256(body).hexdigest()),
    }


def metrics_ready(port):
    try:
        metrics_probe(port)
        return True
    except (OSError, urllib.error.URLError):
        return False


def rust_probe(oracle, database, count, destination=DESTINATION):
    result = subprocess.run(
        [str(oracle), "relayer-probe", str(database), str(ORIGIN), "test1", str(destination), f"test{destination - ORIGIN + 1}", str(count)],
        cwd=ROOT,
        env={},
        capture_output=True,
        text=True,
        timeout=45,
    )
    if result.returncode:
        raise RuntimeError(f"production Rust DB oracle failed: {result.stderr[-4000:]}")
    return json.loads(result.stdout)


def rust_probe_all(oracle, database, messages):
    destinations = {}
    for message in messages:
        domain = message["destination"]
        destinations[str(domain)] = f"test{domain - ORIGIN + 1}"
    result = subprocess.run(
        [str(oracle), "relayer-probe-all", str(database), str(ORIGIN), "test1", str(len(messages)), json.dumps(destinations, sort_keys=True)],
        cwd=ROOT,
        env={},
        capture_output=True,
        text=True,
        timeout=45,
    )
    if result.returncode:
        raise RuntimeError(f"production Rust DB all-destination oracle failed: {result.stderr[-4000:]}")
    probe = json.loads(result.stdout)
    if probe.get("origin_nonce_count") != len(messages) or len(probe.get("messages", [])) != len(messages):
        raise RuntimeError("production Rust DB all-destination oracle incomplete origin nonce coverage")
    for index, message in enumerate(messages):
        row = probe["messages"][index]
        if not row.get("present"):
            raise RuntimeError(f"production Rust DB oracle missing origin nonce {index}")
        if row.get("message_source") != "canonical":
            raise RuntimeError("public receipt sidecar cannot stand in canonical producer trace")
        actual_id = "".join(row["id_chunks"]).lower().removeprefix("0x")
        if actual_id != message["id"].lower().removeprefix("0x") or row.get("destination") != message["destination"]:
            raise RuntimeError("production Rust DB oracle nonce/ID/destination mismatch")
    return probe


def settlement_metrics(port):
    names = [
        "hyperlane_submitter_queue_length",
        "hyperlane_lander_building_stage_queue_length",
        "hyperlane_lander_inclusion_stage_pool_length",
        "hyperlane_lander_finality_stage_pool_length",
    ]
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/metrics", timeout=4) as response:
        body = response.read(8 * 1024 * 1024).decode()
    values = {name: [] for name in names}
    processed = {"test2": [], "test3": []}
    for line in body.splitlines():
        for name in names:
            if line.startswith(name):
                values[name].append(float(line.rsplit(" ", 1)[1]))
        if line.startswith("hyperlane_messages_processed_count{") and 'origin="test1"' in line:
            for remote in processed:
                if f'remote="{remote}"' in line:
                    processed[remote].append(float(line.rsplit(" ", 1)[1]))
    missing = [name for name, samples in values.items() if not samples]
    if missing:
        raise RuntimeError(f"active queue metrics missing: {','.join(missing)}")
    return {
        "queues": {name: sum(samples) for name, samples in values.items()},
        "processed_by_destination": {remote: sum(samples) for remote, samples in processed.items()},
        "processed_count": sum(sum(samples) for samples in processed.values()),
    }


def contract_sync_progress(port):
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/metrics", timeout=4) as response:
        body = response.read(8 * 1024 * 1024).decode()
    liveness = []
    heights = []
    for line in body.splitlines():
        if line.startswith("hyperlane_contract_sync_liveness") and 'data_type="dispatched_messages"' in line and 'chain="test1"' in line:
            liveness.append(float(line.rsplit(" ", 1)[1]))
        if line.startswith("hyperlane_contract_sync_block_height") and 'data_type="dispatched_messages"' in line and 'chain="test1"' in line:
            heights.append(float(line.rsplit(" ", 1)[1]))
    if not liveness or not heights:
        raise RuntimeError("Source contract-sync progress metrics unavailable")
    return {"liveness": max(liveness), "indexed_height": max(heights)}


def prove_restart(metrics_port, process, deadline_seconds, process_start_unix):
    deadline = time.monotonic() + deadline_seconds
    first = None
    last_error = None
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"agent exited during restart recovery: {process.logs()}")
        try:
            current = contract_sync_progress(metrics_port)
            if current["indexed_height"] <= 0:
                raise RuntimeError("Source contract-sync has not indexed a block")
            if current["liveness"] < process_start_unix:
                raise RuntimeError("Source contract-sync liveness predates current process")
            if first is None:
                first = current
            elif current["liveness"] > first["liveness"]:
                return {"queue_families": None, "queue_status": "uninstantiated", "initial_sync": first, "fresh_sync": current}
        except (OSError, RuntimeError, ValueError) as error:
            last_error = error
        time.sleep(0.05)
    raise RuntimeError(f"restart fresh contract-sync proof failed: initial={first}, error={last_error}")


def active_operation_ids(metrics_port, destinations=(DESTINATION, DESTINATION_ALT)):
    identities = set()
    for destination in destinations:
        with urllib.request.urlopen(f"http://127.0.0.1:{metrics_port}/list_operations?destination_domain={destination}", timeout=4) as response:
            operations = json.loads(response.read(8 * 1024 * 1024))
        if not isinstance(operations, list):
            raise RuntimeError("actual operation list unavailable")
        for operation in operations:
            if not isinstance(operation, dict) or not isinstance(operation.get("id"), str):
                raise RuntimeError("actual operation identity unavailable")
            identities.add(operation["id"].lower().removeprefix("0x"))
    return identities


def presence_callback(mode, name, metrics_port):
    if mode not in {"smoke", "paired"} or name not in {"rust", "zig"}:
        raise ValueError("unknown measurement profile")
    return (lambda: active_operation_ids(metrics_port)) if mode == "smoke" and name == "zig" else None


def retirement_evidence_capabilities(active_ids_fn):
    enabled = active_ids_fn is not None
    return {
        "cumulative_600s_bound": True,
        "per_id_active_presence_guard": enabled,
        "retirement_evidence_scope": "cumulative counter bound plus diagnostic ineligible-ID active presence" if enabled else "common cumulative counter bound only; separate exact-binary native per-ID functional acceptance required for final timings",
    }


def require_functional_settlement(value, count, label, allow_historical=False):
    inclusions = value.get("first_proxy_inclusions", [])
    completion = value.get("first_live_completion") or {}
    identities = {"".join(row.get("id_chunks", [])).lower().removeprefix("0x") for row in inclusions}
    if value.get("production_confirm_seconds") != 600 or value.get("expected_tracked_messages") != count or len(inclusions) != count or len(identities) != count or not identities or "" in identities:
        raise RuntimeError(f"{label} lacks exact per-ID600s inclusion coverage")
    if value.get("historical_offset_is_upper_bound_not_injected_counter") is not True or not isinstance(value.get("historical_confirmed_offset"), int) or value["historical_confirmed_offset"] < 0:
        raise RuntimeError(f"{label} lacks explicit historical counter provenance")
    if not allow_historical and value["historical_confirmed_offset"] != 0:
        raise RuntimeError(f"{label} requires isolated target IDs with no historical counter allowance")
    confirmed = value["historical_confirmed_offset"] + count
    if value.get("operations_confirmed") != confirmed or completion.get("confirmed") != confirmed or completion.get("monotonic") is None:
        raise RuntimeError(f"{label} lacks actual live completion")
    for row in inclusions:
        included = row.get("first_positive_receipt_or_delivered_monotonic_seconds")
        if included is None or completion["monotonic"] < included + 600:
            raise RuntimeError(f"{label} completion precedes an included ID's600s bound")


def native_functional_prerequisites(paths, native_binary):
    expected = "".join(digest(native_binary)).lower()
    proofs = {}
    for kind in ("relayer_process", "relayer_stream", "public_relay"):
        path = paths.get(kind)
        if path is None or not path.is_file():
            raise RuntimeError(f"paired timings require --{kind.replace('_', '-')}-proof")
        data = path.read_bytes()
        payload = gzip.decompress(data) if path.suffix == ".gz" else data
        value = json.loads(payload)
        if value.get("passed") is not True or value.get("errors"):
            raise RuntimeError(f"{kind} functional proof did not pass")
        if kind == "relayer_process":
            actual = value.get("binaries", {}).get("relayer_sha256_chunks", [])
            require_functional_settlement(value.get("settlement", {}), 3, "three-ISM")
            batch = value.get("max_batch_4", {})
            require_functional_settlement(batch.get("settlement", {}), 4, "maxBatch4")
            allocation = batch.get("actual_allocation", {})
            if allocation.get("calls") != 4 or len(allocation.get("members", [])) != 4:
                raise RuntimeError("maxBatch4 functional proof lacks four actual members")
            crash = value.get("preenqueue_crash", {})
            if crash.get("passed") is not True or crash.get("recovery_new_nonce_count") != 1 or crash.get("restart_new_nonce_count") != 0:
                raise RuntimeError("crash functional proof lacks exact recovery/restart acceptance")
            require_functional_settlement(crash.get("settlement", {}), 1, "crash recovery")
            cases = ["three_ISM", "maxBatch4", "preenqueue_crash"]
        elif kind == "relayer_stream":
            actual = value.get("executables", {}).get("relayer_sha256_chunks", [])
            case = value.get("case", {})
            if case.get("passed") is not True:
                raise RuntimeError("WSS functional proof did not pass")
            require_functional_settlement(case.get("restart", {}).get("settlement", {}), 2, "WSS restart", allow_historical=True)
            cases = ["WSS_restart"]
        else:
            actual = value.get("binary_sha256_chunks", [])
            for name in ("normal_indexed", "sole_sidecar"):
                case = value.get(name, {})
                if case.get("passed") is not True:
                    raise RuntimeError(f"public {name} functional proof did not pass")
                require_functional_settlement(case.get("settlement", {}), 2, f"public {name}")
            cases = ["normal_indexed", "sole_sidecar"]
        if not isinstance(actual, list) or "".join(actual).lower() != expected:
            raise RuntimeError(f"{kind} functional proof binary differs from exact pinned native binary")
        proofs[kind] = {"path": str(path.resolve()), "sha256_chunks": chunks(hashlib.sha256(data).hexdigest()), "encoding": "gzip" if path.suffix == ".gz" else "json", "decoded_sha256_chunks": chunks(hashlib.sha256(payload).hexdigest()), "cases": cases}
    return {"verified": True, "native_sha256_chunks": chunks(expected), "proofs": proofs}


def settle_live(metrics_port, process, deadline_seconds, inclusion_ns, expected_messages, inclusion_coverage=None, active_ids_fn=None):
    if expected_messages <= 0:
        raise ValueError("positive expected processed-message count required")
    if active_ids_fn is not None and inclusion_coverage is None:
        raise ValueError("per-ID active presence requires inclusion coverage")
    inclusion_times = [proof["time_ns"] for proof in inclusion_coverage.values()] if inclusion_coverage is not None else [inclusion_ns] * expected_messages
    if len(inclusion_times) != expected_messages:
        raise ValueError("one inclusion timestamp per expected message required")
    deadline = time.monotonic() + deadline_seconds
    last_error = None
    sample = None
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"agent exited during settlement: {process.logs()}")
        try:
            sample = settlement_metrics(metrics_port)
        except (OSError, RuntimeError, ValueError) as error:
            last_error = error
        else:
            if sample["processed_count"] > expected_messages:
                raise AssertionError(f"processed-message count {sample['processed_count']} exceeds expected {expected_messages}")
            observed_ns = time.perf_counter_ns()
            eligible = sum(observed_ns - included >= 600_000_000_000 - 50_000_000 for included in inclusion_times)
            if sample["processed_count"] > eligible:
                raise AssertionError(f"proven retirement of processed subset preceded the 600-second confirmation policy: processed={sample['processed_count']}, eligible_after_600s={eligible}, observed_ns={observed_ns}")
            if active_ids_fn is not None:
                try:
                    active_ids = active_ids_fn()
                except (OSError, RuntimeError, ValueError) as error:
                    last_error = error
                    time.sleep(0.05)
                    continue
                presence_ns = time.perf_counter_ns()
                missing = [identity for identity, proof in inclusion_coverage.items() if presence_ns - proof["time_ns"] < 600_000_000_000 - 50_000_000 and identity.lower().removeprefix("0x") not in active_ids]
                if missing:
                    raise AssertionError(f"tracked operation disappeared before its own600s bound: {','.join(sorted(missing))}")
            retired = sample["processed_count"] == expected_messages and all(value == 0 for value in sample["queues"].values())
            if retired:
                retirement_ns = observed_ns
                if retirement_ns - inclusion_ns < 600_000_000_000 - 50_000_000:
                    raise AssertionError(f"proven retirement at {retirement_ns} preceded the 600-second confirmation policy from inclusion {inclusion_ns}")
                return sample, retirement_ns
        time.sleep(0.05)
    raise RuntimeError(f"settlement deadline: sample={sample}, error={last_error}")


def inclusion_lower_bound(messages, observations, mailboxes):
    process_topic = evm.run(["cast", "keccak", "ProcessId(bytes32)"]).lower()
    expected = {message["id"].lower(): message for message in messages}
    first_by_transaction = {}
    for observation in observations:
        key = (observation.get("chain_namespace"), observation.get("hash"))
        if not all(key):
            continue
        previous = first_by_transaction.get(key)
        if previous is None or observation["time_ns"] < previous["time_ns"]:
            first_by_transaction[key] = observation
    coverage = {}
    for observation in first_by_transaction.values():
        if observation.get("status") != "0x1":
            continue
        for log in observation.get("logs", []):
            topics = log.get("topics", [])
            if len(topics) < 2 or topics[0].lower() != process_topic:
                continue
            identity = topics[1].lower()
            message = expected.get(identity)
            if message is None or log.get("address", "").lower() != mailboxes[message["destination"]].lower():
                continue
            proof = {
                "time_ns": observation["time_ns"],
                "transaction_hash": observation["hash"],
                "chain_namespace": observation["chain_namespace"],
                "mailbox": mailboxes[message["destination"]].lower(),
            }
            previous = coverage.get(identity)
            if previous is not None and (previous["transaction_hash"], previous["chain_namespace"]) != (proof["transaction_hash"], proof["chain_namespace"]):
                raise RuntimeError(f"ambiguous canonical inclusion observations for message {identity}")
            coverage[identity] = proof
    missing = sorted(set(expected) - set(coverage))
    if missing:
        raise RuntimeError(f"expected Mailbox ProcessId inclusion coverage missing: {','.join(missing)}")
    return max(proof["time_ns"] for proof in coverage.values()), coverage


def receipt_nonce(chain, receipt):
    transaction = chain.rpc("eth_getTransactionByHash", [receipt["transactionHash"]])
    if not transaction or transaction.get("nonce") is None:
        raise RuntimeError("canonical transaction nonce unavailable")
    if transaction.get("hash") != receipt["transactionHash"]:
        raise RuntimeError("transaction identity mismatch while reading nonce")
    if transaction.get("from", "").lower() != evm.TEST_SIGNER.lower():
        raise RuntimeError("transaction signer mismatch while reading nonce")
    if receipt.get("blockHash") and transaction.get("blockHash") != receipt["blockHash"]:
        raise RuntimeError("transaction block hash mismatch while reading nonce")
    if receipt.get("blockNumber") and transaction.get("blockNumber") != receipt["blockNumber"]:
        raise RuntimeError("transaction block number mismatch while reading nonce")
    if receipt.get("gasUsed") is None or receipt.get("effectiveGasPrice") is None:
        raise RuntimeError("canonical receipt fee fields missing")
    header = chain.rpc("eth_getBlockByNumber", [receipt["blockNumber"], False])
    if not header or header.get("hash") != receipt["blockHash"] or int(header["number"], 16) != int(receipt["blockNumber"], 16):
        raise RuntimeError("receipt does not match canonical block header")
    return int(transaction["nonce"], 16)


def percentile(values, quantile):
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * quantile
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    fraction = position - lower
    return ordered[lower] + (ordered[upper] - ordered[lower]) * fraction


def rpc_delta(later, earlier):
    return {
        "http_requests": later["http_requests"] - earlier["http_requests"],
        "json_rpc_subrequests": later["json_rpc_subrequests"] - earlier["json_rpc_subrequests"],
        "methods": {method: later["methods"].get(method, 0) - earlier["methods"].get(method, 0) for method in set(later["methods"]) | set(earlier["methods"])},
        "broadcast_attempts": later["broadcast_attempts"] - earlier["broadcast_attempts"],
    }


def allocation_proof(messages, links, receipts, mailboxes, require_exact):
    process_topic = evm.run(["cast", "keccak", "ProcessId(bytes32)"])
    links_by_id = {"".join(link["message_id_chunks"]).lower().removeprefix("0x"): link for link in links}
    members = {}
    for message in messages:
        wanted = message["id"].lower().removeprefix("0x")
        link = links_by_id.get(wanted)
        if require_exact and link is None:
            raise RuntimeError("sealed message/payload link missing for allocation")
        if link is not None and link.get("estimated_gas") is None:
            raise RuntimeError("sealed estimate missing for allocation")
        mailbox = mailboxes[message["destination"]].lower()
        candidates = []
        for receipt in receipts:
            if (receipt.get("_mailbox") or "").lower() != mailbox or receipt.get("status") != "0x1":
                continue
            for log in receipt.get("logs", []):
                if len(log.get("topics", [])) >= 2 and log["topics"][0].lower() == process_topic.lower() and log["topics"][1].lower() == message["id"].lower() and log.get("address", "").lower() == mailbox:
                    candidates.append(receipt)
                    break
        if len(candidates) != 1:
            raise RuntimeError("canonical ProcessId receipt attribution missing")
        members.setdefault(candidates[0]["transactionHash"], []).append((message, link, candidates[0]))
    rows = []
    parity = True
    for tx_hash, entries in members.items():
        complete_estimates = all(link is not None for _, link, _ in entries)
        denominator = sum(int(link["estimated_gas"]) for _, link, _ in entries) if complete_estimates else None
        if denominator == 0:
            raise RuntimeError("zero sealed batch estimate denominator")
        receipt = entries[0][2]
        actual_gas = int(receipt["gasUsed"], 16)
        actual_price = int(receipt["effectiveGasPrice"], 16)
        allocated_sum = 0
        for message, link, _ in entries:
            spent = (link.get("spent") if link is not None else None) or message.get("spent") or {}
            record_present = link.get("gas_expenditure_record_present", message.get("gas_expenditure_record_present")) if link is not None else message.get("gas_expenditure_record_present")
            row = {
                "message_id": message["id"],
                "payload_uuid_chunks": link["uuid_chunks"] if link is not None else None,
                "receipt_hash": tx_hash,
                "chain_namespace": receipt["chain_namespace"],
                "mailbox_emitter": mailboxes[message["destination"]].lower(),
                "receipt_status": receipt["status"],
                "actual_receipt_gas": actual_gas,
                "actual_receipt_tokens": actual_gas * actual_price,
                "actual_db_gas": spent.get("gas_used"),
                "actual_db_tokens": spent.get("tokens_used"),
                "gas_expenditure_record_present": record_present,
            }
            if not complete_estimates:
                parity = False
                row.update({"sealed_estimate": None, "expected_gas": None, "expected_tokens": None, "exact": False})
                rows.append(row)
                continue
            estimate = int(link["estimated_gas"])
            expected_gas = actual_gas * estimate // denominator
            expected_tokens = expected_gas * actual_price
            exact = record_present is True and int(spent.get("gas_used", -1)) == expected_gas and int(spent.get("tokens_used", -1)) == expected_tokens
            parity = parity and exact
            allocated_sum += expected_gas
            row.update({
                "sealed_estimate": estimate,
                "batch_estimate_denominator": denominator,
                "expected_gas": expected_gas,
                "expected_tokens": expected_tokens,
                "exact": exact,
            })
            rows.append(row)
        if complete_estimates:
            dust = actual_gas - allocated_sum
            if dust < 0:
                raise RuntimeError("batch allocation exceeds actual receipt gas")
            for row in rows:
                if row["receipt_hash"] == tx_hash:
                    row["rounding_dust"] = dust
    if require_exact and not parity:
        raise RuntimeError("per-message sealed allocation mismatch")
    return {"parity": parity, "rows": rows}


def setup_batch_contracts(max_batch_size, chains, domains):
    if max_batch_size == 1:
        return None
    deployed = {}
    for namespace, chain, chain_name in chains:
        address = relayer_process.deploy_multicall3(chain)
        code = chain.rpc("eth_getCode", [address, "latest"])
        if not isinstance(code, str) or code in {"0x", "0x0"}:
            raise RuntimeError("batch benchmark requires deployed Multicall3 code")
        domains[chain_name]["batchContractAddress"] = address
        deployed[namespace] = {"address": address.lower(), "code_keccak256": evm.run(["cast", "keccak", code])}
    if len({(entry["address"], entry["code_keccak256"]) for entry in deployed.values()}) != 1:
        raise RuntimeError("batch destinations must use identical Multicall3 code and address")
    return deployed


def batch_membership_proof(messages, receipts, chains, mailboxes, contracts, max_batch_size):
    """Post-measurement evidence; no inference from a batch-size setting."""
    topic = evm.run(["cast", "keccak", "ProcessId(bytes32)"]).lower()
    expected = {message["id"].lower(): message for message in messages}
    if len(expected) != len(messages):
        raise RuntimeError("duplicate batch corpus message ID")
    seen = set()
    transaction_keys = set()
    histogram = collections.Counter()
    groups = []
    for receipt in receipts:
        namespace = receipt["chain_namespace"]
        key = (namespace, receipt["transactionHash"].lower())
        if key in transaction_keys:
            raise RuntimeError("duplicate canonical batch receipt")
        transaction_keys.add(key)
        mailbox = receipt["_mailbox"].lower()
        members = []
        for event in receipt.get("logs", []):
            topics = event.get("topics", [])
            if len(topics) >= 2 and topics[0].lower() == topic and event.get("address", "").lower() == mailbox:
                identity = topics[1].lower()
                if identity not in expected or mailboxes[expected[identity]["destination"]].lower() != mailbox or identity in seen:
                    raise RuntimeError("foreign or duplicate batch ProcessId member")
                seen.add(identity)
                members.append(identity)
        if not members:
            raise RuntimeError("broadcast receipt has no expected ProcessId members")
        relayer_process.verify_process_events(receipt, mailbox, members)
        if len(members) > max_batch_size:
            raise RuntimeError("actual batch exceeds configured maximum")
        histogram[len(members)] += 1
        if len(members) == 1:
            continue
        chain = chains[namespace]
        transaction = chain.rpc("eth_getTransactionByHash", [receipt["transactionHash"]])
        if not transaction or transaction["hash"].lower() != key[1] or transaction.get("from", "").lower() != evm.TEST_SIGNER.lower() or transaction.get("to", "").lower() != contracts[namespace]["address"]:
            raise RuntimeError("batch transaction signer, target or identity mismatch")
        canonical, header = relayer_process.canonical_receipt(chain, transaction)
        if any(canonical.get(field) != receipt.get(field) for field in ("transactionHash", "blockHash", "blockNumber", "status", "logs", "gasUsed", "effectiveGasPrice")):
            raise RuntimeError("batch receipt changed during canonical verification")
        calls = relayer_process.decode_aggregate3(transaction["input"])
        if len(calls) != len(members):
            raise RuntimeError("aggregate3 calls differ from receipt members")
        by_wire = {expected[identity]["wire"].lower(): identity for identity in members}
        ordered = []
        for call in calls:
            if call["to"].lower() != mailbox or call["calldata"][:4].hex() != "7c39d130":
                raise RuntimeError("aggregate3 contains a foreign mailbox or selector")
            identity = by_wire.get(relayer_process.process_wire(call["calldata"]).hex())
            if identity is None or identity in ordered:
                raise RuntimeError("aggregate3 contains foreign or duplicate message wire")
            ordered.append(identity)
        if set(ordered) != set(members):
            raise RuntimeError("aggregate3 membership differs from ProcessId receipt")
        groups.append({"chain_namespace": namespace, "transaction": transaction, "canonical_receipt": canonical, "canonical_header": header, "ordered_message_ids": ordered, "calls": len(calls)})
    if seen != set(expected):
        raise RuntimeError("batch receipt coverage is incomplete")
    if not groups:
        raise RuntimeError("batch benchmark produced only singleton transactions")
    return {"verified": True, "maximum_configured": max_batch_size, "group_size_histogram": dict(sorted(histogram.items())), "batched_message_count": sum(group["calls"] for group in groups), "singleton_message_count": histogram[1], "groups": groups}


def run_attempt(name, sample, args, binaries, output):
    raw_dir = output / "raw" / f"sample-{sample}-{name}"
    raw_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f"ziggy-whole-relayer-{name}-") as directory:
        temporary = pathlib.Path(directory)
        (temporary / "config").mkdir()
        anvil_log = (raw_dir / "anvil.log").open("wb")
        anvil_alt_log = (raw_dir / "anvil-destination-2.log").open("wb")
        anvil = anvil_alt = None
        chain = chain_alt = None
        validating = None
        running = None
        origin_rpc = destination_rpc = destination_alt_rpc = None
        messages = []
        emitted = []
        observed = []
        stall = {}
        first_stop = restart_stop = validator_stop = None
        first_probe = None
        phase_snapshots = {}
        try:
            anvil = subprocess.Popen(
                ["anvil", "--host", "127.0.0.1", "--port", str(free_port()), "--chain-id", "31337", "--silent"],
                cwd=ROOT,
                stdout=anvil_log,
                stderr=anvil_log,
            )
            chain = evm.Chain(f"http://127.0.0.1:{anvil.args[anvil.args.index('--port') + 1]}")
            anvil_alt = subprocess.Popen(
                ["anvil", "--host", "127.0.0.1", "--port", str(free_port()), "--chain-id", "31337", "--silent"],
                cwd=ROOT,
                stdout=anvil_alt_log,
                stderr=anvil_alt_log,
            )
            chain_alt = evm.Chain(f"http://127.0.0.1:{anvil_alt.args[anvil_alt.args.index('--port') + 1]}")
            for process, target in [(anvil, chain), (anvil_alt, chain_alt)]:
                for _ in range(100):
                    if process.poll() is not None:
                        raise RuntimeError(f"Anvil exited {process.returncode}")
                    try:
                        target.account = target.rpc("eth_accounts")[0]
                        break
                    except (ConnectionError, urllib.error.URLError):
                        time.sleep(0.05)
                else:
                    raise RuntimeError("Anvil readiness deadline")

            contracts = relayer_process.compile_contracts()

            def deploy(contract, signature=None, *values, target=None):
                target = target or chain
                return target.send("0x" + contracts[contract] + (evm.abi(signature, *values) if signature else ""))["contractAddress"]

            domains = {}
            for chain_name, domain in [("test1", ORIGIN), ("test2", DESTINATION), ("test3", DESTINATION_ALT)]:
                target = chain if domain != DESTINATION_ALT else chain_alt
                null_ism = deploy("TestIsm", target=target)
                required = deploy("TestPostDispatchHook", target=target)
                mailbox = deploy("Mailbox", "constructor(uint32)", str(domain), target=target)
                hook = deploy("MerkleTreeHook", "constructor(address)", mailbox, target=target)
                announce = deploy("ValidatorAnnounce", "constructor(address)", mailbox, target=target)
                igp = deploy("InterchainGasPaymaster", target=target)
                target.send(evm.calldata("initialize(address,address)", target.account, target.account), igp)
                target.send(evm.calldata("initialize(address,address,address,address)", target.account, null_ism, hook, required), mailbox)
                domains[chain_name] = {
                    "name": chain_name,
                    "domainId": domain,
                    "chainId": 31337,
                    "protocol": "ethereum",
                    "rpcUrls": [{"http": target.url}],
                    "mailbox": mailbox,
                    "merkleTreeHook": hook,
                    "validatorAnnounce": announce,
                    "interchainGasPaymaster": igp,
                    "blocks": {"reorgPeriod": 0, "confirmations": 0, "estimateBlockTime": 1},
                    "index": {"from": 0, "interval": 1},
                    "maxBatchSize": args.max_batch_size,
                    "signer": {"type": "hexKey", "key": PUBLIC_KEY},
                }
            batch_contracts = setup_batch_contracts(args.max_batch_size, [("anvil-1", chain, "test2"), ("anvil-2", chain_alt, "test3")], domains)
            gas_oracle = deploy("StorageGasOracle")
            for destination in [DESTINATION, DESTINATION_ALT]:
                chain.send(evm.calldata("setRemoteGasData((uint32,uint128,uint128))", f"({destination},10000000000,1)"), gas_oracle)
            chain.send(evm.calldata("setDestinationGasConfigs((uint32,(address,uint96))[])", f"[({DESTINATION},({gas_oracle},0)),({DESTINATION_ALT},({gas_oracle},0))]"), domains["test1"]["interchainGasPaymaster"])
            recipients = {DESTINATION: [], DESTINATION_ALT: []}
            for destination in recipients:
                target = chain if destination != DESTINATION_ALT else chain_alt
                isms = [
                    deploy("TestIsm", target=target),
                    deploy("StorageMessageIdMultisigIsm", "constructor(address[],uint8)", f"[{evm.TEST_SIGNER}]", "1", target=target),
                    deploy("StorageMerkleRootMultisigIsm", "constructor(address[],uint8)", f"[{evm.TEST_SIGNER}]", "1", target=target),
                ]
                for ism in isms:
                    recipient = deploy("TestRecipient", target=target)
                    target.send(evm.calldata("setInterchainSecurityModule(address)", ism), recipient)
                    recipients[destination].append(recipient)
            for target in [chain, chain_alt]:
                target.rpc("anvil_setBalance", [evm.TEST_SIGNER, hex(100 * 10**18)])
            dispatch_topic = evm.run(["cast", "keccak", "Dispatch(address,uint32,bytes32,bytes)"])
            messages = []

            def dispatch(index, destination=DESTINATION):
                recipient = recipients[destination][index % len(recipients[destination])]
                receipt = chain.send(evm.calldata("dispatch(uint32,bytes32,bytes)", str(destination), "0x" + "00" * 12 + recipient[2:], "0x" + f"whole-relayer-{index}-{destination}".encode().hex()), domains["test1"]["mailbox"])
                event = next(value for value in receipt["logs"] if value["address"].lower() == domains["test1"]["mailbox"].lower() and value["topics"][0] == dispatch_topic)
                raw = bytes.fromhex(event["data"][2:])
                wire = raw[64:64 + int.from_bytes(raw[32:64], "big")]
                identity = evm.run(["cast", "keccak", "0x" + wire.hex()])
                chain.receipt(chain.rpc("eth_sendTransaction", [{
                    "from": chain.account,
                    "to": domains["test1"]["interchainGasPaymaster"],
                    "data": evm.calldata("payForGas(bytes32,uint32,uint256,address)", identity, str(destination), "1000000", chain.account),
                    "value": hex(1_000_000),
                    "gas": "0xe00000",
                }]))
                sent = time.perf_counter_ns()
                messages.append({"id": identity, "wire": wire.hex(), "dispatch_ns": sent, "destination": destination})
                return sent

            for index in range(args.catchup):
                dispatch(index)

            checkpoints = temporary / "checkpoints"
            validator_config = temporary / "validator-config"
            validator_config.mkdir()
            validator_value = {
                "originChainName": "test1",
                "db": str(temporary / "validator-db"),
                "validator": {"key": PUBLIC_KEY},
                "checkpointSyncer": {"type": "localStorage", "path": str(checkpoints)},
                "interval": 1,
                "metricsPort": free_port(),
                "chains": {"test1": domains["test1"]},
            }
            validator_file = validator_config / "public.json"
            validator_file.write_text(json.dumps(validator_value))
            validating = MeasuredProcess(binaries["rust_validator"], temporary, environment("rust", validator_file, validator_config))
            wait_for(validating, lambda: validator.checkpoint_objects(checkpoints, args.catchup) is not None, args.deadline, "validator backlog")

            with CountingProxy(chain.url, "anvil-1") as origin_rpc, CountingProxy(chain.url, "anvil-1") as destination_rpc, CountingProxy(chain_alt.url, "anvil-2") as destination_alt_rpc:
                configured = json.loads(json.dumps(domains))
                configured["test1"]["rpcUrls"] = [{"http": origin_rpc.url}]
                configured["test2"]["rpcUrls"] = [{"http": destination_rpc.url}]
                configured["test3"]["rpcUrls"] = [{"http": destination_alt_rpc.url}]
                relayer_config = temporary / "relayer-config"
                relayer_config.mkdir()
                database = temporary / "relayer-db"
                relayer_value = {
                    "relayChains": "test1,test2,test3",
                    "db": str(database),
                    "allowLocalCheckpointSyncers": True,
                    "gasPaymentEnforcement": [{"type": "none"}],
                    "tracing": {"level": "debug", "fmt": "json"},
                    "metricsPort": free_port(),
                    "chains": configured,
                }
                relayer_file = relayer_config / "public.json"
                relayer_file.write_text(json.dumps(relayer_value))

                def delivered(message):
                    target = chain if message["destination"] != DESTINATION_ALT else chain_alt
                    mailbox = domains[f"test{message['destination'] - ORIGIN + 1}"]["mailbox"]
                    return int(target.rpc("eth_call", [{"to": mailbox, "data": evm.calldata("delivered(bytes32)", message["id"])}, "latest"]), 16) == 1

                signer_nonce_before = int(chain.rpc("eth_getTransactionCount", [evm.TEST_SIGNER, "latest"]), 16)
                signer_nonce_alt_before = int(chain_alt.rpc("eth_getTransactionCount", [evm.TEST_SIGNER, "latest"]), 16)
                with (raw_dir / "relayer-first.log").open("wb") as log:
                    running = launch(name, binaries[name], temporary, relayer_file, relayer_config)
                    daemon_start_ns = running.start_ns
                    ready_ns = wait_for(running, lambda: metrics_ready(relayer_value["metricsPort"]), args.deadline, "relayer readiness")
                    startup_rpc = [origin_rpc.snapshot(), destination_rpc.snapshot(), destination_alt_rpc.snapshot()]
                    caught_ns = wait_for(running, lambda: all(delivered(message) for message in messages), args.deadline, "backlog delivery")
                    catchup_rpc = [origin_rpc.snapshot(), destination_rpc.snapshot(), destination_alt_rpc.snapshot()]
                    threads_catchup = running.thread_snapshot()
                    emitted = [None] * args.steady
                    observed = [None] * args.steady
                    dispatch_errors = []
                    stall = {"same_destination": False, "different_destination": False}

                    def produce():
                        try:
                            for offset in range(args.steady):
                                interval_ms = args.steady_interval_ms
                                due = caught_ns + (offset + 1) * interval_ms * 1_000_000
                                time.sleep(max(0, (due - time.perf_counter_ns()) / 1e9))
                                destination = DESTINATION_ALT if offset >= 2 else DESTINATION
                                emitted[offset] = dispatch(args.catchup + offset, destination)
                        except Exception as error:
                            dispatch_errors.append(error)

                    if args.stall:
                        destination_rpc.start_fault()
                    producer = threading.Thread(target=produce)
                    producer.start()
                    try:
                        deadline = time.monotonic() + args.deadline + args.steady * args.steady_interval_ms / 1000
                        while any(value is None for value in observed):
                            if running.poll() is not None:
                                raise RuntimeError(f"relayer exited during fresh delivery: {running.logs()}")
                            if dispatch_errors:
                                raise dispatch_errors[0]
                            for offset in range(args.steady):
                                if emitted[offset] is not None and observed[offset] is None and delivered(messages[args.catchup + offset]):
                                    observed[offset] = time.perf_counter_ns()
                            if time.monotonic() > deadline:
                                raise RuntimeError("fresh delivery deadline")
                            time.sleep(0.005)
                    finally:
                        producer.join(timeout=30)
                    if args.stall:
                        fault = destination_rpc.fault_record()
                        accepted = [event for event in fault["events"] if event["event"] == "accepted"]
                        retired = {event["id"]: event["time_ns"] for event in fault["events"] if event["event"] == "retired"}

                        def overlaps(timestamp):
                            return any(event["time_ns"] <= timestamp < retired.get(event["id"], fault["end_ns"]) for event in accepted)

                        origin_log_reads = [timestamp for timestamp in origin_rpc.method_times.get("eth_getLogs", []) if fault["start_ns"] <= timestamp < fault["end_ns"]]
                        stall.update({
                            "same_destination": overlaps(observed[1]) and fault["start_ns"] <= observed[1] < fault["end_ns"],
                            "different_destination": overlaps(observed[2]) and fault["start_ns"] <= observed[2] < fault["end_ns"],
                            "healthy_wins_hold_window": overlaps(observed[1]) and observed[1] < fault["end_ns"],
                            "origin_indexing_liveness": bool(origin_log_reads) and overlaps(observed[2]) and fault["start_ns"] <= observed[2] < fault["end_ns"],
                            "origin_log_reads_ns": origin_log_reads,
                            "receipt_stalls": len(accepted),
                            "fault": fault,
                        })
                        if not accepted:
                            raise RuntimeError("no physical stalled receipt request accepted during fault window")
                        stall["acceptance_gaps"] = [name for name in ["different_destination", "origin_indexing_liveness"] if not stall[name]]
                        stall["same_destination_note"] = "false is a valid serial-owner performance tradeoff, not fabricated success"
                    settle_start_ns = time.perf_counter_ns()
                    delivery_complete_ns = settle_start_ns
                    delivery_rpc = [origin_rpc.snapshot(), destination_rpc.snapshot(), destination_alt_rpc.snapshot()]
                    inclusion_observations = origin_rpc.observations() + destination_rpc.observations() + destination_alt_rpc.observations()
                    inclusion_ns, inclusion_coverage = inclusion_lower_bound(messages, inclusion_observations, {DESTINATION: domains["test2"]["mailbox"], DESTINATION_ALT: domains["test3"]["mailbox"]})
                    active_ids_fn = presence_callback(args.mode, name, relayer_value["metricsPort"])
                    settlement_sample, retirement_ns = settle_live(relayer_value["metricsPort"], running, args.settlement_deadline, inclusion_ns, len(messages), inclusion_coverage, active_ids_fn=active_ids_fn)
                    settle_end_ns = retirement_ns
                    final_rpc = [origin_rpc.snapshot(), destination_rpc.snapshot(), destination_alt_rpc.snapshot()]
                    confirmation_hold_rpc = [rpc_delta(later, earlier) for later, earlier in zip(final_rpc, delivery_rpc)]
                    threads_steady = running.thread_snapshot()
                    metrics = metrics_probe(relayer_value["metricsPort"])
                    first_stop = running.stop_with_signal(signal.SIGTERM if sample % 2 == 0 else signal.SIGINT)
                (raw_dir / "relayer-first.log").write_bytes(running.full_log())
                running.close()
                running = None
                if first_stop["exit_code"] not in [0, -signal.SIGTERM, -signal.SIGINT]:
                    raise RuntimeError("relayer first shutdown failed")
                first_probe = rust_probe_all(args.oracle, database, messages)
                signer_nonce_after = int(chain.rpc("eth_getTransactionCount", [evm.TEST_SIGNER, "latest"]), 16)
                signer_nonce_alt_after = int(chain_alt.rpc("eth_getTransactionCount", [evm.TEST_SIGNER, "latest"]), 16)
                restart_rpc = [origin_rpc.snapshot(), destination_rpc.snapshot(), destination_alt_rpc.snapshot()]
                with (raw_dir / "relayer-restart.log").open("wb") as log:
                    restart_launch_unix = int(time.time())
                    running = launch(name, binaries[name], temporary, relayer_file, relayer_config)
                    wait_for(running, lambda: metrics_ready(relayer_value["metricsPort"]), args.deadline, "restart recovery readiness")
                    restart_active = prove_restart(relayer_value["metricsPort"], running, args.deadline, restart_launch_unix)
                    restart_stop = running.stop_with_signal(signal.SIGTERM)
                (raw_dir / "relayer-restart.log").write_bytes(running.full_log())
                running.close()
                running = None
                if restart_stop["exit_code"] not in [0, -signal.SIGTERM]:
                    raise RuntimeError("relayer restart shutdown failed")
                restart_nonce = int(chain.rpc("eth_getTransactionCount", [evm.TEST_SIGNER, "latest"]), 16)
                restart_nonce_alt = int(chain_alt.rpc("eth_getTransactionCount", [evm.TEST_SIGNER, "latest"]), 16)
                if restart_nonce != signer_nonce_after or restart_nonce_alt != signer_nonce_alt_after:
                    raise RuntimeError("restart broadcast duplicate transaction")
                restart_probe = rust_probe_all(args.oracle, database, messages)
                if restart_probe != first_probe:
                    raise RuntimeError("restart changed processed/expenditure database state")
                validator_stop = validating.stop()
                (raw_dir / "validator.log").write_bytes(validating.full_log())
                validating.close()
                validating = None
                if validator_stop["exit_code"] not in [0, -signal.SIGTERM, -signal.SIGINT]:
                    raise RuntimeError("validator shutdown failed")
                total_rpc = [origin_rpc.snapshot(), destination_rpc.snapshot(), destination_alt_rpc.snapshot()]
                restart_attempts = sum(later["broadcast_attempts"] - earlier["broadcast_attempts"] for later, earlier in zip(total_rpc, restart_rpc))
                if restart_attempts != 0:
                    raise RuntimeError("settled restart resubmitted a transaction attempt")
                signed = origin_rpc.signed_transactions() + destination_rpc.signed_transactions() + destination_alt_rpc.signed_transactions()
                signed_with_chain = [(chain, raw, domains["test2"]["mailbox"]) for raw in origin_rpc.signed_transactions() + destination_rpc.signed_transactions()] + [(chain_alt, raw, domains["test3"]["mailbox"]) for raw in destination_alt_rpc.signed_transactions()]
                unique_raw = list(dict.fromkeys(signed_with_chain))
                receipts = []
                unmined_attempts = []
                for target, raw, mailbox in unique_raw:
                    tx_hash = evm.run(["cast", "keccak", raw])
                    receipt = target.rpc("eth_getTransactionReceipt", [tx_hash])
                    if receipt:
                        if receipt.get("transactionHash") != tx_hash:
                            raise RuntimeError("receipt transaction hash differs from signed raw hash")
                        receipt["chain_namespace"] = "anvil-2" if target is chain_alt else "anvil-1"
                        receipt["_mailbox"] = mailbox
                        receipts.append(receipt)
                    else:
                        unmined_attempts.append(tx_hash)
                if not receipts:
                    raise RuntimeError("no canonical mined broadcast receipt")
                actual_gas = sum(int(receipt["gasUsed"], 16) for receipt in receipts)
                actual_tokens = sum(int(receipt["gasUsed"], 16) * int(receipt["effectiveGasPrice"], 16) for receipt in receipts)
                spent_gas = sum(int(message["spent"]["gas_used"]) for message in first_probe["messages"])
                spent_tokens = sum(int(message["spent"]["tokens_used"]) for message in first_probe["messages"])
                paid_gas = sum(int(message["payment"]["gas_amount"]) for message in first_probe["messages"])
                paid_tokens = sum(int(message["payment"]["payment"]) for message in first_probe["messages"])
                if not all(message["present"] and message["processed"] and message["payment"] for message in first_probe["messages"]):
                    raise RuntimeError("Rust DB oracle found unprocessed/unpaid message")
                if actual_gas <= 0 or actual_tokens <= 0:
                    raise RuntimeError("actual canonical receipt cost missing")
                source_accounting_gap = name == "rust" and spent_gas == 0 and spent_tokens == 0 and all(message.get("gas_expenditure_record_present") is False for message in first_probe["messages"])
                if name == "rust" and spent_gas == 0 and spent_tokens == 0 and not source_accounting_gap:
                    raise RuntimeError("zero expenditure without an explicit absent-record Source gap")
                if not source_accounting_gap:
                    if spent_gas <= 0 or spent_tokens <= 0:
                        raise RuntimeError("actual receipt expenditure missing")
                    if args.max_batch_size == 1 and (spent_gas != actual_gas or spent_tokens != actual_tokens):
                        raise RuntimeError("single-submission expenditure differs from actual receipt sums")
                    if args.max_batch_size > 1 and (spent_gas > actual_gas or spent_tokens > actual_tokens):
                        raise RuntimeError("batch expenditure exceeds actual receipt sums")
                canonical_receipts = [{"hash": receipt["transactionHash"], "nonce": receipt_nonce(chain if receipt["chain_namespace"] == "anvil-1" else chain_alt, receipt), "chain_namespace": receipt["chain_namespace"], "gas_used": receipt["gasUsed"], "effective_gas_price": receipt["effectiveGasPrice"]} for receipt in receipts]
                allocation = allocation_proof(messages, first_probe["sealed_payload_links"], receipts, {DESTINATION: domains["test2"]["mailbox"], DESTINATION_ALT: domains["test3"]["mailbox"]}, require_exact=name == "zig")
                batch_membership = batch_membership_proof(messages, receipts, {"anvil-1": chain, "anvil-2": chain_alt}, {DESTINATION: domains["test2"]["mailbox"], DESTINATION_ALT: domains["test3"]["mailbox"]}, batch_contracts, args.max_batch_size) if args.max_batch_size > 1 else None
                unique_nonces = {(receipt["chain_namespace"], receipt["nonce"]) for receipt in canonical_receipts}
                if args.max_batch_size == 1 and len(unique_nonces) != len(messages):
                    raise RuntimeError("single-submission unique nonce count mismatch")
                if args.max_batch_size > 1 and not 0 < len(unique_nonces) <= len(messages):
                    raise RuntimeError("batch unique nonce count invalid")
                main_nonce_count = sum(namespace == "anvil-1" for namespace, _ in unique_nonces)
                alt_nonce_count = sum(namespace == "anvil-2" for namespace, _ in unique_nonces)
                if signer_nonce_after - signer_nonce_before != main_nonce_count or signer_nonce_alt_after - signer_nonce_alt_before != alt_nonce_count:
                    raise RuntimeError("signer nonce and accepted unique nonces differ by chain")
                fresh_latencies = [max(0, (done - sent) / 1e6) for done, sent in zip(observed, emitted)]
                return {
                    "implementation": name,
                    "sample": sample,
                    "contract_artifacts": {contract: chunks(hashlib.sha256(bytes.fromhex(bytecode)).hexdigest()) for contract, bytecode in contracts.items()},
                    "readiness_ms": (ready_ns - daemon_start_ns) / 1e6,
                    "launch_to_ready_ms": (ready_ns - daemon_start_ns) / 1e6,
                    "launch_to_caught_up_ms": (caught_ns - daemon_start_ns) / 1e6,
                    "catchup_ms": (caught_ns - ready_ns) / 1e6,
                    "catchup_messages_per_second": args.catchup / max(0.001, (caught_ns - ready_ns) / 1e9),
                    "freshness_ms": fresh_latencies,
                    "effective_steady_interval_ms": args.steady_interval_ms,
                    "freshness_percentiles_ms": {quantile: percentile(fresh_latencies, value) for quantile, value in [("p50", 0.5), ("p95", 0.95), ("p99", 0.99)]},
                    "delivery_complete_ns": delivery_complete_ns,
                    "settle_start_ns": settle_start_ns,
                    "settle_end_ns": settle_end_ns,
                    "inclusion_ns": inclusion_ns,
                    "retirement_ns": retirement_ns,
                    "confirmation_hold_ms": (retirement_ns - inclusion_ns) / 1e6,
                    "processed_retirement_ms": (retirement_ns - inclusion_ns) / 1e6,
                    "confirmation_hold_rpc": confirmation_hold_rpc,
                    "cpu_scope": "whole daemon including delivery and confirmation hold",
                    "first_stop": first_stop,
                    "restart_stop": restart_stop,
                    "validator_stop": validator_stop,
                    "validator_profile": "common pinned Rust c520224 checkpoint producer; CPU/RPC excluded from relayer measurements",
                    "thread_snapshots": {"after_catchup": threads_catchup, "after_steady": threads_steady},
                    "rpc": {"startup": startup_rpc, "catchup": catchup_rpc, "fresh": final_rpc, "before_restart": restart_rpc, "total_including_restart": total_rpc, "fixture_direct_rpc_count": chain.counter + chain_alt.counter},
                    "metrics": metrics,
                    "stall": stall,
                    "settlement": {
                        **retirement_evidence_capabilities(active_ids_fn),
                        "active_zero": settlement_sample["queues"],
                        "processed_count": settlement_sample["processed_count"],
                        "expected_processed_count": len(messages),
                        "processed_by_destination": settlement_sample["processed_by_destination"],
                        "first_inclusion_coverage": inclusion_coverage,
                        "restart_recovery": restart_active,
                        "fixed_sleep_used": False,
                        "confirmation_lower_bound_ms": 600_000,
                        "observation_resolution_tolerance_ms": 50,
                        "retirement_evidence": "first complete live processed-count and zero-queue sample after full eligible Mailbox ProcessId coverage; per-ID capability reported separately",
                    },
                    "restart": {"nonce_unchanged": True, "database_unchanged": True, "physical_attempts": restart_attempts},
                    "proof": {
                        "message_count": len(messages),
                        "accounting_parity": allocation["parity"] and not source_accounting_gap,
                        "known_source_accounting_gap": source_accounting_gap,
                        "sealed_allocation": allocation,
                        "batch_contracts": batch_contracts,
                        "batch_membership": batch_membership,
                        "physical_broadcast_attempts": len(signed),
                        "unique_transaction_count": len(unique_raw),
                        "duplicate_raw_attempts": len(signed) - len(unique_raw),
                        "unmined_attempts": unmined_attempts,
                        "replacement_transactions": len(unique_raw) - len(unique_nonces),
                        "accepted_unique_nonce_count": len(unique_nonces),
                        "signer_nonce_delta": {"anvil-1": signer_nonce_after - signer_nonce_before, "anvil-2": signer_nonce_alt_after - signer_nonce_alt_before},
                        "canonical_receipts": canonical_receipts,
                        "actual_receipt_gas_sum": actual_gas,
                        "actual_receipt_token_sum": actual_tokens,
                        "rust_db_gas_sum": spent_gas,
                        "rust_db_token_sum": spent_tokens,
                        "payment_gas_budget": paid_gas,
                        "payment_token_budget": paid_tokens,
                        "production_rust_readback": first_probe,
                    },
                    "load_average": os.getloadavg(),
                }
        finally:
            if running is not None:
                if running.usage is None:
                    first_stop = running.stop_with_signal(signal.SIGTERM)
                (raw_dir / "relayer-failure.log").write_bytes(running.full_log())
                running.close()
            if validating is not None:
                if validating.usage is None:
                    validator_stop = validating.stop()
                (raw_dir / "validator-failure.log").write_bytes(validating.full_log())
                validating.close()
            for proxy, label in [(origin_rpc, "origin"), (destination_rpc, "destination-1"), (destination_alt_rpc, "destination-2")]:
                if proxy is not None:
                    phase_snapshots[f"{label}-cleanup"] = proxy.snapshot()
            for source, target in [(locals().get("validator_file"), "validator-public.json"), (locals().get("relayer_file"), "relayer-public.json")]:
                if source and source.exists():
                    shutil.copy2(source, raw_dir / target)
            if "checkpoints" in locals() and checkpoints.exists():
                shutil.copytree(checkpoints, raw_dir / "checkpoints", dirs_exist_ok=True)
            for key, target in [("startup_rpc", "startup"), ("catchup_rpc", "catchup"), ("final_rpc", "fresh"), ("restart_rpc", "before-restart"), ("total_rpc", "total")]:
                if key in locals():
                    phase_snapshots[target] = locals()[key]
            for proxy, label in [(origin_rpc, "origin"), (destination_rpc, "destination-1"), (destination_alt_rpc, "destination-2")]:
                if proxy is not None:
                    phase_snapshots[f"{label}-fault"] = proxy.fault_record()
            database = locals().get("database")
            if database is not None and database.exists() and messages:
                if first_probe is not None:
                    (raw_dir / "first-rust-probe.json").write_text(json.dumps(first_probe, indent=2) + "\n")
                try:
                    latest_probe = rust_probe_all(args.oracle, database, messages)
                    (raw_dir / "latest-rust-probe.json").write_text(json.dumps(latest_probe, indent=2) + "\n")
                except Exception as error:
                    (raw_dir / "latest-rust-probe-error.txt").write_text(str(error))
                shutil.copytree(database, raw_dir / "failed-db", dirs_exist_ok=True)
            partial_summary = {
                "implementation": name,
                "sample": sample,
                "messages": messages,
                "emitted_ns": emitted,
                "observed_ns": observed,
                "phase_snapshots": phase_snapshots,
                "stall": stall,
                "first_stop": first_stop,
                "restart_stop": restart_stop,
                "validator_stop": validator_stop,
                "contract_artifacts": ({contract: chunks(hashlib.sha256(bytes.fromhex(bytecode)).hexdigest()) for contract, bytecode in contracts.items()} if "contracts" in locals() else None),
            }
            (raw_dir / "partial-summary.json").write_text(json.dumps(partial_summary, indent=2) + "\n")
            if anvil is not None:
                anvil.terminate()
                try:
                    anvil.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    anvil.kill()
                    anvil.wait()
            anvil_log.close()
            if anvil_alt is not None:
                anvil_alt.terminate()
                try:
                    anvil_alt.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    anvil_alt.kill()
                    anvil_alt.wait()
            anvil_alt_log.close()


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["smoke", "paired"])
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--compile-only", action="store_true")
    parser.add_argument("--rust", type=pathlib.Path, default=ROOT / "rust/main/target/release/relayer")
    parser.add_argument("--zig", type=pathlib.Path, default=ROOT / "zig/zig-out/bin/relayer")
    parser.add_argument("--rust-validator", type=pathlib.Path, default=ROOT / "rust/main/target/release/validator")
    parser.add_argument("--zig-validator", type=pathlib.Path, default=ROOT / "zig/zig-out/bin/validator")
    parser.add_argument("--oracle", type=pathlib.Path, default=ROOT / "zig/bench/results/disk-preparation-20261106/rocks-helper-functional/ziggy-rocks-oracle")
    parser.add_argument("--baseline-provenance", type=pathlib.Path)
    parser.add_argument("--relayer-process-proof", type=pathlib.Path, help="passing exact-native-binary three-ISM/batch/crash functional result; required for paired execution")
    parser.add_argument("--relayer-stream-proof", type=pathlib.Path, help="passing exact-native-binary WSS functional result; required for paired execution")
    parser.add_argument("--public-relay-proof", type=pathlib.Path, help="passing exact-native-binary normal/public-sidecar functional result; required for paired execution")
    parser.add_argument("--samples", type=int)
    parser.add_argument("--catchup", type=int)
    parser.add_argument("--steady", type=int)
    parser.add_argument("--steady-interval-ms", type=int, default=500)
    parser.add_argument("--deadline", type=float, default=90)
    parser.add_argument("--settlement-deadline", type=float, default=660)
    parser.add_argument("--max-batch-size", type=int, default=1)
    parser.add_argument("--stall", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--quiet-host", action="store_true", help="assert compiler-idle measurement window; unrelated user workloads may remain; no exclusive-host claim")
    parser.add_argument("--output", type=pathlib.Path)
    args = parser.parse_args()
    args.samples = args.samples if args.samples is not None else (1 if args.mode == "smoke" else 5)
    args.catchup = args.catchup if args.catchup is not None else (4 if args.mode == "smoke" else 32)
    args.steady = args.steady if args.steady is not None else (3 if args.mode == "smoke" else 8)
    if args.output is None:
        args.output = ROOT / "zig/bench/results" / ("whole-relayer-smoke" if args.mode == "smoke" else "whole-relayer-final")
    if args.samples < 1 or args.catchup < 1 or args.steady < 1 or args.max_batch_size < 1:
        raise ValueError("positive sample/trace/batch counts required")
    if args.execute and args.dry_run:
        raise ValueError("--execute and --dry-run are mutually exclusive")
    if args.stall and args.steady < 3:
        raise ValueError("same/different destination stall coverage requires at least three fresh messages")
    return args


def main():
    args = parse_args()
    args.output = args.output.resolve()
    if (args.output / "manifest.json").exists():
        raise RuntimeError("output manifest exists; preserve prior raw attempt and choose a new output")
    args.output.mkdir(parents=True, exist_ok=True)
    binaries = {
        "rust": args.rust.resolve(),
        "zig": args.zig.resolve(),
        "rust_validator": args.rust_validator.resolve(),
        "zig_validator": args.zig_validator.resolve(),
    }
    for name, path in {**binaries, "oracle": args.oracle.resolve()}.items():
        if not path.is_file():
            raise RuntimeError(f"required {name} binary missing: {path}")
    args.oracle = args.oracle.resolve()
    manifest = {
        "passed": False,
        "stage": "dry-run plan; no daemons launched" if not args.execute else "executing",
        "started_at_utc": utc_now(),
        "scope": "Actual production Rust c520224 vs native Zig relayer; fresh local Anvil/Mailbox/IGP/three ISM types/public key11 only",
        "mode": args.mode,
        "measurement_profile": "common metrics-only cumulative settlement polling" if args.mode == "paired" else "diagnostic smoke; native per-ID admin polling; CPU/RSS not a performance comparison",
        "native_functional_prerequisites": {"verified": False, "required_for_paired": True},
        "configuration": vars(args) | {"rust": str(args.rust), "zig": str(args.zig), "rust_validator": str(args.rust_validator), "zig_validator": str(args.zig_validator), "oracle": str(args.oracle), "output": str(args.output), "baseline_provenance": str(args.baseline_provenance)},
        "environment": "CONFIG_FILES for Rust; HYPERLANE_ZIG_DEFAULTS and explicit native curl path for Zig; no inherited environment",
        "durability_and_feature_gaps": [
            "Zig operation/payload transitions request RocksDB WAL fsync; Rust production database/fsync policy is not rewritten by this harness",
            "Rust production tracing/Prometheus/Tokio behavior and Zig telemetry/runtime implementation differ; physical HELP inventories are recorded",
            "SIGTERM/SIGINT behavior is measured separately; no all-runtime-feature equivalence claim",
            "EVM/local signer/local checkpoint storage only; other VMs, KMS/cloud, production networks and workload shapes excluded",
        ],
        "host": {"platform": platform.platform(), "load_average_before": os.getloadavg(), "compilers_before": compiler_inventory(), "team_compilers_idle_asserted": args.quiet_host, "shared_host_note": "Unrelated user workloads may remain; no exclusive-host claim or process cleanup"},
        "raw_samples": [],
        "failures": [],
    }
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2, default=str) + "\n")
    if args.compile_only:
        contracts = relayer_process.compile_contracts()
        manifest["compiled_contracts"] = sorted(contracts)
        manifest["stage"] = "contract compilation complete; no daemons launched"
        (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2, default=str) + "\n")
        return
    if not args.execute:
        return
    if not args.baseline_provenance:
        raise RuntimeError("--execute requires --baseline-provenance")
    provenance = load_provenance(args.baseline_provenance, binaries, args.oracle)
    pinned = {name: pin_binary(path, args.output, name) for name, path in binaries.items()}
    args.oracle = pin_binary(args.oracle, args.output, "oracle")
    if args.mode == "paired":
        manifest["native_functional_prerequisites"] = native_functional_prerequisites({"relayer_process": args.relayer_process_proof, "relayer_stream": args.relayer_stream_proof, "public_relay": args.public_relay_proof}, pinned["zig"])
    manifest["baseline_provenance"] = provenance
    manifest["binaries"] = {name: {"path": str(path), "bytes": path.stat().st_size, "sha256_chunks": digest(path)} for name, path in pinned.items()}
    manifest["oracle"] = {"path": str(args.oracle), "bytes": args.oracle.stat().st_size, "sha256_chunks": digest(args.oracle)}
    manifest["source_inventory_sha256_chunks"] = source_inventory()
    manifest["source_inventory_scope"] = "captured at execution start; binary hashes/provenance identify executed artifacts; concurrent edits are not claimed as compiled content"
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2, default=str) + "\n")

    def persist():
        (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2, default=str) + "\n")

    for sample in range(args.samples):
        for name in (["rust", "zig"] if sample % 2 == 0 else ["zig", "rust"]):
            if args.quiet_host and compiler_inventory():
                raise RuntimeError("quiet-host assertion failed: compiler/build process active")
            try:
                row = run_attempt(name, sample, args, pinned, args.output)
                manifest["raw_samples"].append(row)
                persist()
                print(name, sample, round(row["catchup_ms"], 1), "ms catchup", flush=True)
            except Exception as error:
                partial_path = args.output / "raw" / f"sample-{sample}-{name}" / "partial-summary.json"
                partial = json.loads(partial_path.read_text()) if partial_path.exists() else None
                manifest["failure"] = {"implementation": name, "sample": sample, "message_chunks": chunks(error), "partial_summary": partial}
                manifest["failures"].append(manifest["failure"])
                persist()
                if args.mode != "smoke":
                    raise
    manifest["load_average_after"] = os.getloadavg()
    manifest["compilers_after"] = compiler_inventory()
    if args.quiet_host and manifest["compilers_after"]:
        manifest["failure"] = {"stage": "quiet-host-after", "message_chunks": ["compiler/build process active"]}
        persist()
        raise RuntimeError("quiet-host assertion failed after runs")
    manifest["summary"] = {}
    for name in ["rust", "zig"]:
        rows = [row for row in manifest["raw_samples"] if row["implementation"] == name]
        if not rows:
            manifest["summary"][name] = {"samples": 0, "failure": manifest["failures"][-1] if manifest["failures"] else None}
            continue
        fresh = [value for row in rows for value in row["freshness_ms"]]
        manifest["summary"][name] = {
            "samples": len(rows),
            "median_launch_to_caught_up_ms": statistics.median(row["launch_to_caught_up_ms"] for row in rows),
            "median_catchup_ms": statistics.median(row["catchup_ms"] for row in rows),
            "median_confirmation_hold_ms": statistics.median(row["confirmation_hold_ms"] for row in rows),
            "median_processed_retirement_ms": statistics.median(row["processed_retirement_ms"] for row in rows),
            "median_catchup_messages_per_second": statistics.median(row["catchup_messages_per_second"] for row in rows),
            "freshness_percentiles_ms": {quantile: percentile(fresh, value) for quantile, value in [("p50", 0.5), ("p95", 0.95), ("p99", 0.99)]},
            "median_cpu_seconds": statistics.median(row["first_stop"]["user_seconds"] + row["first_stop"]["system_seconds"] for row in rows),
            "median_max_rss_bytes": statistics.median(row["first_stop"]["max_rss_bytes"] for row in rows),
            "median_physical_http_total": statistics.median(sum(endpoint["http_requests"] for endpoint in row["rpc"]["total_including_restart"]) for row in rows),
            "median_logical_rpc_total": statistics.median(sum(endpoint["json_rpc_subrequests"] for endpoint in row["rpc"]["total_including_restart"]) for row in rows),
            "median_shutdown_ms": statistics.median(row["first_stop"]["shutdown_ms"] for row in rows),
        }
    manifest["comparison_caveat"] = "No broad outperform claim: fsync, telemetry, runtime, batch shape and host contention remain explicit; final claim requires Root-authorized quiet paired samples"
    manifest["finished_at_utc"] = utc_now()
    manifest["passed"] = args.mode == "paired" and manifest["native_functional_prerequisites"]["verified"] and args.samples >= 5 and args.quiet_host and all(len([row for row in manifest["raw_samples"] if row["implementation"] == name]) == args.samples for name in ["rust", "zig"]) and all(not row["stall"].get("acceptance_gaps") for row in manifest["raw_samples"]) and (args.max_batch_size == 1 or all(row["proof"]["batch_membership"]["verified"] is True for row in manifest["raw_samples"]))
    manifest["stage"] = "paired actual runs complete" if manifest["passed"] else "actual smoke complete; not a final paired benchmark"
    persist()
    print(json.dumps({"passed": manifest["passed"], "stage": manifest["stage"], "samples": len(manifest["raw_samples"])}))


if __name__ == "__main__":
    main()
