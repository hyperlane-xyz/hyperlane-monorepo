#!/usr/bin/env python3
"""Explicit external-runtime E2E preparation and fail-closed evidence dispatch.

No node/build/download is launched by this Phase 1 driver. Real family adapters
must be reviewed before the corresponding scenario can execute or be accepted.
Default Rust harness behavior remains in Rust when no manifest is supplied.
"""
from __future__ import annotations
import argparse
import hashlib
import importlib
import json
import os
import pathlib
import re
import shutil
import signal
import socket
import socketserver
import stat
import sys
import threading
import urllib.parse

import multivm_evidence
import multivm_session

ROOT = pathlib.Path(__file__).resolve().parents[2]
ROLES = ("relayer", "validator", "scraper", "init-db", "worker")
LIBRARIES = ("starknet", "aleo-crypto", "aleo-vm", "regex", "url")
ALIASES = {
    "HYPERLANE_STARKNET_CRYPTO_LIBRARY": "starknet",
    "HYPERLANE_ALEO_CRYPTO_LIBRARY": "aleo-crypto",
    "HYPERLANE_ALEO_VM_LIBRARY": "aleo-vm",
    "HYPERLANE_REGEX_LIBRARY": "regex",
    "ZIGGY_REGEX_LIBRARY": "regex",
    "HYPERLANE_ALEO_VM_WORKER": "worker",
    "HYPERLANE_URL_LIBRARY": "url",
}
OPTIONAL_ENV = {"HYPERLANE_CURL_LIBRARY", "HYPERLANE_CLOUD_CURL_LIBRARY", "HYPERLANE_LIBCRYPTO_LIBRARY", "HYPERLANE_ZIG_DEFAULTS", "HYPERLANE_ALEO_PARAMETER_HOME"}
TOOL_KEYS = {"E2E_OSMOSIS_CLI_PATH", "E2E_STARKLI_CLI_PATH", "E2E_HYPD_PATH"}
SCENARIOS = {
    "evm": {"features": "test-utils memory-profiling", "test": None},
    "cosmwasm": {"features": "cosmos test-utils", "test": "cosmos::test::test_run"},
    "cosmosnative": {"features": "cosmosnative test-utils", "test": "cosmosnative::test::test_run"},
    "sealevel": {"features": "sealevel test-utils", "test": "sealevel::test::test_run"},
    "sealevel-composite": {"features": "sealevel test-utils", "test": "sealevel::warp_route_composite_ism::test::test_warp_route_custom_composite_ism_process"},
    "starknet": {"features": "starknet test-utils", "test": "starknet::test::test_run"},
    "radix": {"features": "radix test-utils", "test": "radix::test::test_run"},
    "tron": {"features": "tron test-utils memory-profiling", "test": "tron::test::test_run"},
}
# Only explicitly reviewed families enter this registry below. Other native
# scenarios remain blocked; passed flags or canned receipts cannot pass.
FAMILY_VERIFIERS = {}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    h = hashlib.sha256()
    with pathlib.Path(path).open("rb") as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(part)
    return h.hexdigest()


def local_endpoint(value):
    parsed = urllib.parse.urlsplit(value)
    require(parsed.scheme in {"http", "https", "ws", "wss", "postgres", "postgresql"}, "unsupported local transport")
    require(parsed.hostname in {"127.0.0.1", "localhost", "::1"}, "external E2E endpoint must be loopback")
    require(parsed.username is None and parsed.password is None or parsed.scheme in {"postgres", "postgresql"}, "RPC endpoint cannot contain credentials")
    return value


def artifact(value, executable=False):
    require(set(value) == {"path", "bytes", "sha256"}, "artifact descriptor fields differ")
    path = pathlib.Path(value["path"])
    require(path.is_absolute() and ".." not in path.parts and path.is_file() and not path.is_symlink(), "regular absolute non-symlink artifact required")
    require(type(value["bytes"]) is int and value["bytes"] >= 0, "invalid artifact size")
    require(isinstance(value["sha256"], str) and re.fullmatch("[0-9a-f]{64}", value["sha256"]), "invalid artifact SHA256")
    require(path.stat().st_size == value["bytes"] and digest(path) == value["sha256"], "artifact bytes changed")
    require(not executable or bool(path.stat().st_mode & 0o111), "missing executable permission")
    return path


def checked_owned_path(root, relative):
    root = pathlib.Path(root)
    require(root.is_absolute() and root.is_dir() and not root.is_symlink(), "unsafe owned root")
    root = root.resolve(strict=True)
    relative = pathlib.Path(relative)
    require(not relative.is_absolute() and all(p not in {"..", "."} for p in relative.parts), "owned path must be relative without traversal")
    path = root
    for index, part in enumerate(relative.parts):
        path = path / part
        require(not path.is_symlink(), "symlink in owned writable path")
        if path.exists():
            require(path.resolve(strict=True).is_relative_to(root), "owned path escaped root")
            if index + 1 < len(relative.parts):
                require(path.is_dir(), "owned parent is not directory")
    return path


def check_owned_tree(root, relative):
    path = checked_owned_path(root, relative)
    if not path.exists():
        return
    require(path.is_dir(), "owned tree is not directory")
    for child in path.iterdir():
        child_relative = pathlib.Path(relative) / child.name
        checked_owned_path(root, child_relative)
        if child.is_dir():
            check_owned_tree(root, child_relative)


def create_owned_directory(root, relative):
    path = checked_owned_path(root, relative)
    if path.is_dir():
        check_owned_tree(root, relative)
    path.mkdir(parents=True, exist_ok=True)
    path = checked_owned_path(root, relative)
    require(path.is_dir(), "owned directory missing after creation")
    check_owned_tree(root, relative)
    return path


def resource_name(value, default, pid):
    identity = hashlib.sha256(str(pathlib.Path(value["task_root"]).resolve(strict=True)).encode()).hexdigest()[:10]
    return f"ziggy-e2e-{identity}-{pid}-{default}"


def validate_manifest(value):
    keys = {"schema", "implementation", "scenario", "runtime_source_commit", "mode", "task_root", "artifacts", "environment", "verifier", "execution_approval", "case_inputs", "verifier_tools", "harness_deadline_seconds", "tool_overrides"}
    require(set(value) <= keys and set(value) >= keys - {"tool_overrides"}, "unknown/missing external manifest fields")
    require(type(value["schema"]) is int and value["schema"] == 3 and value["implementation"] == "zig", "unsupported external runtime schema")
    require(isinstance(value["runtime_source_commit"], str) and re.fullmatch("[0-9a-fA-F]{40}", value["runtime_source_commit"]), "exact runtime commit required")
    require(value["mode"] in {"ReleaseSafe", "ReleaseFast"}, "unknown mode")
    require(value["scenario"] in SCENARIOS, "unknown actual-node scenario")
    task = pathlib.Path(value["task_root"])
    require(task.is_absolute() and ".." not in task.parts and task.is_dir() and not task.is_symlink(), "existing owned task directory required")
    require(type(value["harness_deadline_seconds"]) is int and 1800 <= value["harness_deadline_seconds"] <= 86400, "harness budget must preserve production confirmation")
    require(set(value["artifacts"]) == set(ROLES + LIBRARIES), "all three roles/init-db/worker/four SDKs required")
    require(len({r["path"] for r in value["artifacts"].values()}) == len(ROLES + LIBRARIES), "distinct runtime artifact paths required")
    for name, row in value["artifacts"].items():
        artifact(row, name in ROLES)
    env = value["environment"]
    require(set(env) <= set(ALIASES) | OPTIONAL_ENV and set(ALIASES) <= set(env), "unknown/missing runtime environment alias")
    for key, name in ALIASES.items():
        require(env[key] == value["artifacts"][name]["path"], "wrong SDK/worker alias")
    require(all(pathlib.Path(v).is_absolute() for v in env.values()), "absolute runtime environment paths required")
    artifact(value["execution_approval"])
    artifact(value["case_inputs"])
    require(set(value["verifier_tools"]) == {"cast", "oracle", "native_rows", "psql", "docker", "ps"}, "exact verifier tool descriptors required")
    for tool in value["verifier_tools"].values():
        artifact(tool, True)
    verifier = value["verifier"]
    require(set(verifier) == {"python", "script", "evidence_root"}, "verifier schema differs")
    artifact(verifier["python"], True)
    artifact(verifier["script"])
    require(pathlib.Path(verifier["evidence_root"]).is_absolute() and ".." not in pathlib.Path(verifier["evidence_root"]).parts and pathlib.Path(verifier["evidence_root"]).is_relative_to(task), "evidence escapes owned root")
    for relative in ["databases", "agent-logs", "sealevel-checkpoints", "composite-checkpoints", str(pathlib.Path(verifier["evidence_root"]).relative_to(task))]:
        owned = checked_owned_path(task, relative)
        require(not owned.exists() or owned.is_dir(), "owned directory is not directory")
        if owned.is_dir():
            check_owned_tree(task, relative)
    require(set(value.get("tool_overrides", {})) <= TOOL_KEYS, "unsupported tool override")
    for row in value.get("tool_overrides", {}).values():
        require(artifact(row, True).resolve().is_relative_to(task.resolve()), "tool override outside owned root")
    return value


def construction_plan(value, scenario):
    validate_manifest(value)
    require(scenario in SCENARIOS and value["scenario"] == scenario, "scenario differs from runtime manifest; Aleo uses a separate future adapter")
    config = SCENARIOS[scenario]
    return {
        "scenario": scenario,
        "runtime_source_commit": value["runtime_source_commit"],
        "mode": value["mode"],
        "runtime_artifacts": value["artifacts"],
        "harness_features": config["features"],
        "harness_test_filter": config["test"],
        "harness_deadline_seconds": value["harness_deadline_seconds"],
        "skip_only_rust_role_builds": True,
        "init_db_is_separate_existing_rust_helper": True,
        "actual_production_confirm_seconds": 600,
        "actual_production_finality_grace_seconds": 30,
        "required_evidence": ["known_dispatch_ids", "native_canonical_delivery_receipts", "validator_metadata_and_checkpoints", "stopped_canonical_rocks_readback", "postgres_dispatch_delivery_gas_rows", "restart_no_duplicate_submission", "owned_child_cleanup"],
        "family_verifier_implemented": scenario in FAMILY_VERIFIERS,
        "passed": False,
        "execution_authorized_by_preparation": False,
    }


def verify_stage(value, stage, expected):
    validate_manifest(value)
    require(stage in {"preflight", "live", "before_restart", "after_restart", "restart", "final"} and type(expected) is int and expected >= 0, "invalid evidence stage")
    require(value["scenario"] in FAMILY_VERIFIERS, "actual family verifier/capacity preflight not implemented/reviewed; no node may start")
    multivm_evidence.verify_harness_parent(value)
    # All acceptance is produced by actual active controller/RPC/SQL/stopped
    # reader calls. No stage.json/passed record can grant acceptance.
    return FAMILY_VERIFIERS[value["scenario"]](value, stage, expected)


def provider_metrics_stage(value, chain, port, created, dropped):
    validate_manifest(value)
    require(value["scenario"] in {"evm", "sealevel", "cosmosnative", "cosmwasm"}, "native provider family not reviewed")
    require(isinstance(chain, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", chain) and type(port) is int and 0 < port <= 65535, "invalid provider operand")
    require(all(type(v) is int and 0 <= v <= 2**32 - 1 for v in (created, dropped)), "invalid provider counters")
    parent = multivm_evidence.verify_harness_parent(value)
    return controller_request(value, "provider-metrics", {"chain": chain, "metrics_port": port, "created": created, "dropped": dropped, "harness_parent": parent}).get("verified") is True


def session_verifier(value, stage, expected):
    return controller_request(value, "verify", {"stage": stage, "expected": expected, "harness_parent": multivm_evidence.verify_harness_parent(value)}).get("verified") is True


# Cosmos-native component review is complete; execution still requires every
# exact runtime/module/tool/dependency/capacity approval and actual live proof.
FAMILY_VERIFIERS["cosmosnative"] = session_verifier
FAMILY_VERIFIERS["evm"] = session_verifier
FAMILY_VERIFIERS["cosmwasm"] = session_verifier
FAMILY_VERIFIERS["sealevel"] = session_verifier
FAMILY_VERIFIERS["sealevel-composite"] = session_verifier
FAMILY_VERIFIERS["tron"] = session_verifier
FAMILY_VERIFIERS["starknet"] = session_verifier
FAMILY_VERIFIERS["radix"] = session_verifier


def controller_path(value, name):
    relative = pathlib.Path(value["verifier"]["evidence_root"]).relative_to(value["task_root"]) / name
    return checked_owned_path(value["task_root"], relative)


def controller_request(value, action, payload):
    multivm_evidence.read_approval(value)
    path = controller_path(value, "controller.json")
    require(path.is_file() and not path.is_symlink(), "actual owned correctness observer has not started")
    record = json.loads(path.read_text())
    require(record.get("runtime_source_commit") == value["runtime_source_commit"] and record.get("scenario") == value["scenario"] and record.get("mode") == value["mode"], "observer belongs to another runtime")
    expected_socket = controller_path(value, "controller.sock")
    require(pathlib.Path(record["socket"]) == expected_socket and stat.S_ISSOCK(expected_socket.stat().st_mode), "actual owned observer socket missing")
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(180)
    try:
        client.connect(str(expected_socket))
        client.sendall(json.dumps({"action": action, "payload": payload, "controller_token": record["controller_token"]}, separators=(",", ":")).encode() + b"\n")
        with client.makefile("rb") as stream:
            raw = stream.readline(32 * 1024 * 1024 + 1)
        require(raw.endswith(b"\n") and len(raw) <= 32 * 1024 * 1024, "bad observer response")
        reply = json.loads(raw)
        require(reply.get("ok") is True, "actual observer refused: " + str(reply.get("error", "unknown error")))
        return reply["result"]
    finally:
        client.close()


def capture_stage(value, request):
    require(value["scenario"] in FAMILY_VERIFIERS, "actual reviewed family capture not enabled")
    multivm_evidence.verify_harness_parent(value, request.get("harness_pid"))
    return controller_request(value, "capture", request)


def serve(value):
    """Explicit correctness-only observer, launched by the coordinator first."""
    require(value["scenario"] in FAMILY_VERIFIERS, "actual reviewed family observer not enabled")
    approval = multivm_evidence.read_approval(value)
    evidence = pathlib.Path(value["verifier"]["evidence_root"]).relative_to(value["task_root"])
    create_owned_directory(value["task_root"], evidence)
    path = controller_path(value, "controller.sock")
    require(not path.exists() and not path.is_symlink() and len(os.fsencode(path)) < 100, "fresh short owned observer socket required")
    descriptor = controller_path(value, "controller.json")
    require(not descriptor.exists(), "preserve previous observer descriptor")
    token = os.urandom(32).hex()
    stopping = threading.Event()
    adapter = None
    if value["scenario"] not in {"evm", "tron"}:
        module_name = multivm_evidence.FAMILY_MODULES[value["scenario"]]
        module = importlib.import_module(module_name)
        require(pathlib.Path(module.__file__).resolve() == pathlib.Path(__file__).resolve().parent / (module_name + ".py"), "native adapter import path differs from approved module")
        adapter = module.Adapter(value, json.loads(artifact(value["case_inputs"]).read_text()))
    session = multivm_session.Session(value, checked_owned_path, create_owned_directory, adapter=adapter)
    class Handler(socketserver.StreamRequestHandler):
        def handle(self):
            try:
                raw = self.rfile.readline(32 * 1024 * 1024 + 1)
                require(raw.endswith(b"\n") and len(raw) <= 32 * 1024 * 1024, "bad observer control request")
                request = json.loads(raw)
                require(set(request) == {"action", "payload", "controller_token"} and request["controller_token"] == token, "wrong owned observer token")
                if request["action"] == "capture":
                    result = session.capture(request["payload"])
                elif request["action"] == "provider-metrics":
                    result = session.provider_metrics(request["payload"])
                else:
                    require(request["action"] == "verify" and set(request["payload"]) == {"stage", "expected", "harness_parent"}, "unknown observer action")
                    result = session.verify(request["payload"]["stage"], request["payload"]["expected"], request["payload"]["harness_parent"])
                reply = {"ok": True, "result": result}
            except Exception as error:
                reply = {"ok": False, "error": type(error).__name__ + ": " + str(error)}
            self.wfile.write(json.dumps(reply, separators=(",", ":")).encode() + b"\n")
    class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
        daemon_threads = False
        block_on_close = True
        request_queue_size = 16
    server = None
    socket_identity = None
    prior_signals = {}
    try:
        server = Server(str(path), Handler)
        os.chmod(path, 0o600)
        socket_identity = (path.stat().st_dev, path.stat().st_ino)
        server.timeout = 0.2
        row = {"schema": 1, "scenario": value["scenario"], "mode": value["mode"], "runtime_source_commit": value["runtime_source_commit"], "socket": str(path), "controller_token": token, "pid": os.getpid(), "python": value["verifier"]["python"], "execution_approval": value["execution_approval"], "python_modules": approval["python_modules"], "scope": "Correctness only, no benchmark timers; exact transparent endpoints and per-ID600s observer."}
        with descriptor.open("x") as stream:
            os.chmod(descriptor, 0o600)
            json.dump(row, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        for signum in (signal.SIGTERM, signal.SIGINT):
            prior_signals[signum] = signal.signal(signum, lambda *_: stopping.set())
        while not stopping.is_set():
            require(not session.hard_failure_latched.is_set(), "actual observer hard failure latched")
            server.handle_request()
    finally:
        if server is not None:
            server.server_close()
        session.close()
        for signum, handler in prior_signals.items():
            signal.signal(signum, handler)
        if socket_identity is not None:
            current = controller_path(value, "controller.sock")
            require(stat.S_ISSOCK(current.stat().st_mode) and (current.stat().st_dev, current.stat().st_ino) == socket_identity, "owned socket changed; preserve unknown file")
            current.unlink()
    # A normal stop ends loop work, but cannot erase a failure during drain.
    require(not session.hard_failure_latched.is_set(), "actual observer hard failure latched")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["plan", "verify", "capture", "serve", "provider-metrics"])
    parser.add_argument("--manifest", required=True, type=pathlib.Path)
    parser.add_argument("--scenario", choices=sorted(SCENARIOS))
    parser.add_argument("--stage", choices=["preflight", "live", "before_restart", "after_restart", "restart", "final"])
    parser.add_argument("--expected", type=int)
    parser.add_argument("--output", type=pathlib.Path)
    parser.add_argument("--provider-chain")
    parser.add_argument("--metrics-port", type=int)
    parser.add_argument("--provider-created", type=int)
    parser.add_argument("--provider-dropped", type=int)
    args = parser.parse_args()
    value = validate_manifest(json.loads(args.manifest.read_text()))
    if args.action == "provider-metrics":
        require(provider_metrics_stage(value, args.provider_chain, args.metrics_port, args.provider_created, args.provider_dropped), "native provider lifecycle did not pass")
        print(json.dumps({"verified": True, "scope": "native provider lifecycle"}))
        return
    if args.action == "capture":
        request = json.loads(sys.stdin.buffer.read(1024 * 1024 + 1))
        print(json.dumps(capture_stage(value, request)))
        return
    if args.action == "serve":
        serve(value)
        return
    if args.action == "verify":
        require(verify_stage(value, args.stage, args.expected) is True, "native evidence did not pass")
        print(json.dumps({"verified": True, "stage": args.stage}))
        return
    require(args.scenario is not None and args.output is not None, "plan requires scenario and fresh output")
    result = construction_plan(value, args.scenario)
    result["observed_host_free_bytes"] = shutil.disk_usage(value["task_root"]).free
    result["scope"] = "Preparation only; dependency/tool/image budget and actual family adapter required before any execution."
    require(not args.output.exists() and not args.output.is_symlink(), "preserve prior plan")
    with args.output.open("x") as stream:
        json.dump(result, stream, indent=2)
        stream.write("\n")


if __name__ == "__main__":
    main()
