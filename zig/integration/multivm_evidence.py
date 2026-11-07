"""Shared correctness evidence primitives. Importing this module has no effects.

All network access is explicit loopback HTTP with proxy discovery disabled. The
approval describes actual coordinator-reviewed products and module bytes; it is
not a substitute for native chain, SQL, stopped database or lifecycle evidence.
"""
from __future__ import annotations

import copy
import ast
import datetime
import hashlib
import http.client
import json
import os
import pathlib
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.parse


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(path):
    h = hashlib.sha256()
    with pathlib.Path(path).open("rb") as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(part)
    return h.hexdigest()


def checked_artifact(row, executable=False):
    require(isinstance(row, dict) and set(row) == {"path", "bytes", "sha256"}, "artifact fields differ")
    path = pathlib.Path(row["path"])
    require(path.is_absolute() and ".." not in path.parts and path.is_file() and not path.is_symlink(), "unsafe evidence artifact")
    require(type(row["bytes"]) is int and row["bytes"] >= 0, "bad evidence size")
    require(isinstance(row["sha256"], str) and re.fullmatch("[0-9a-f]{64}", row["sha256"]), "bad evidence hash")
    require(path.stat().st_size == row["bytes"] and sha(path) == row["sha256"], "evidence artifact changed")
    require(not executable or path.stat().st_mode & 0o111, "evidence tool is not executable")
    return path


MODULE_NAMES = {"multivm_process.py", "multivm_evidence.py", "multivm_evm.py", "multivm_tron.py", "multivm_session.py", "multivm_h2.py"}
FAMILY_MODULES = {"evm": "multivm_evm", "tron": "multivm_tron", "starknet": "multivm_starknet", "cosmwasm": "multivm_cosmos", "cosmosnative": "multivm_cosmos", "sealevel": "multivm_sealevel", "sealevel-composite": "multivm_sealevel", "radix": "multivm_radix"}


def import_module_closure(scenario):
    """Source-only local import traversal; never executes a family module."""
    require(scenario in FAMILY_MODULES, "unknown native family module")
    directory = pathlib.Path(__file__).resolve().parent
    pending = list(MODULE_NAMES | {FAMILY_MODULES[scenario] + ".py"})
    found = set()
    while pending:
        name = pending.pop()
        if name in found:
            continue
        path = directory / name
        require(path.is_file() and not path.is_symlink(), "native family implementation module missing")
        found.add(name)
        for node in ast.walk(ast.parse(path.read_text())):
            names = [item.name for item in node.names] if isinstance(node, ast.Import) else ([node.module] if isinstance(node, ast.ImportFrom) and node.module else [])
            for module in names:
                local = module.split(".")[0] + ".py"
                if (directory / local).is_file():
                    pending.append(local)
    return found


COMPILED_INPUT_SCOPES = {
    "runtime": ("zig/src", "zig/native", "zig/build.zig", "zig/build.zig.zon"),
    "helper": ("rust/main", "rust/sealevel"),
    "tools": ("rust/main", "rust/sealevel", "zig/reference"),
}


def validate_compiled_input_closure(manifest, approval):
    """Pin the pre-node producer/execution tree comparison; no runtime rewrite.

    The builder compares Git objects and clean working inputs BEFORE any node or
    generated fixture writes. Reopening this receipt never reruns cleanliness
    against the EVM fixture's six legitimate generated slots.
    """
    runtime = manifest["runtime_source_commit"]
    execution = approval.get("execution_source_commit", runtime)
    require(isinstance(execution, str) and re.fullmatch("[0-9a-f]{40}", execution), "exact execution source commit required")
    descriptor = approval.get("compiled_input_closure")
    if descriptor is None:
        require(execution == runtime, "different execution source requires compiled input closure")
        return execution
    receipt = json.loads(checked_artifact(descriptor).read_text())
    require(type(receipt.get("schema")) is int and receipt["schema"] == 1 and receipt.get("source_unchanged") is True and receipt.get("native_case_acceptance") is False, "compiled input closure not verified")
    require(receipt.get("runtime_source_commit") == runtime and receipt.get("helper_source_commit") == runtime and receipt.get("tools_source_commit") == runtime and receipt.get("execution_source_commit") == execution, "compiled producer/execution cohort differs")
    scopes = receipt.get("scopes")
    require(isinstance(scopes, dict) and set(scopes) == set(COMPILED_INPUT_SCOPES), "compiled scope categories differ")
    for category, expected in COMPILED_INPUT_SCOPES.items():
        rows = scopes[category]
        require(isinstance(rows, list) and len(rows) == len(expected) and {row.get("path") for row in rows if isinstance(row, dict)} == set(expected), "compiled scope closure differs")
        for row in rows:
            require(isinstance(row, dict) and set(row) == {"path", "producer_tree", "current_tree", "worktree_unchanged"} and row["worktree_unchanged"] is True and row["producer_tree"] == row["current_tree"], "compiled input changed since producer")
            tree = row["producer_tree"]
            require(isinstance(tree, str) and re.fullmatch("[0-9a-f]{40}", tree) or tree is None and row["path"] == "zig/build.zig.zon", "compiled tracked object missing/invalid")
    checks = receipt.get("checks")
    require(isinstance(checks, list) and checks and all(isinstance(check, dict) and type(check.get("exit_code")) is int and check["exit_code"] == 0 for check in checks), "compiled input checks failed")
    for check in checks:
        checked_artifact(check["log"])
    return execution


def read_approval(manifest):
    """Verify exact reviewed module/runtime/tool closure before a node may start."""
    approval = json.loads(checked_artifact(manifest["execution_approval"]).read_text())
    require(type(approval.get("schema")) is int and approval["schema"] == 1 and approval.get("root_approved") is True, "actual coordinator execution approval missing")
    for key in ("scenario", "runtime_source_commit", "mode"):
        require(approval.get(key) == manifest[key], "execution approval belongs to another runtime/scenario")
    require(approval.get("runtime_artifacts") == manifest["artifacts"], "execution approval artifact closure differs")
    require(approval.get("verifier_tools") == manifest["verifier_tools"], "execution approval tool closure differs")
    require(approval.get("verifier_python") == manifest["verifier"]["python"], "execution approval Python differs")
    verify_python_dependencies(manifest, approval)
    require(approval.get("case_inputs") == manifest["case_inputs"], "execution approval corpus differs")
    case = json.loads(checked_artifact(manifest["case_inputs"]).read_text())
    nodes = validate_evidence_nodes(manifest, case)
    require(approval.get("evidence_nodes", {}) == nodes, "direct evidence ownership approval differs")
    validate_docker_approval(manifest, case, approval)
    verify_family_tools(manifest, case, approval)
    checked_artifact(approval["harness"], True)
    interop = json.loads(checked_artifact(approval["native_reader_interoperability"]).read_text())
    reader = interop.get("reader", {})
    require(interop.get("accepted_component_source_and_actual_Zig_storage_interop") is True and interop.get("family_chain_SDK_finality_delivery_elapsed600_acceptance") is False and {key: reader.get(key) for key in ("path", "bytes", "sha256")} == manifest["verifier_tools"]["native_rows"], "actual Zig-writer/native-reader interoperability is not accepted")
    require(set(interop.get("modes", {})) == {"safe", "fast"} and all(row.get("actual_writer_parent_wait_exit") == 0 and type(row.get("actual_writer_parent_wait_exit")) is int and row.get("actual_db_files_rehashed", 0) > 0 for row in interop["modes"].values()), "actual Safe/Fast writer/reap/read-only proof missing")
    require(isinstance(interop.get("source_sha256"), dict) and interop["source_sha256"], "native reader source closure missing")
    for name, expected in interop["source_sha256"].items():
        # Prose formatting is not an executed reader/fixture input. The exact
        # accepted prose remains bound by the immutable result descriptor.
        if pathlib.Path(name).suffix != ".md":
            require(sha(pathlib.Path(__file__).resolve().parents[2] / name) == expected, "accepted native reader/interop source changed")
    modules = approval.get("python_modules")
    require(isinstance(modules, dict) and set(modules) == import_module_closure(manifest["scenario"]), "complete verifier import-module closure required")
    directory = pathlib.Path(__file__).resolve().parent
    for name, row in modules.items():
        require(checked_artifact(row).resolve() == directory / name, "verifier module path differs")
    require(modules["multivm_process.py"] == manifest["verifier"]["script"], "verifier entrypoint differs")
    build = json.loads(checked_artifact(approval["accepted_runtime_build"]).read_text())
    require(build.get("source_commit") == manifest["runtime_source_commit"] and build.get("mode") == manifest["mode"], "actual accepted build identity differs")
    require(build.get("passed") is True and build.get("source_unchanged") is True, "actual runtime build was not accepted")
    require(build.get("runtime_artifacts") == manifest["artifacts"], "build products do not bind declared mode/worker/libraries")
    execution_commit = validate_compiled_input_closure(manifest, approval)
    gates = approval.get("source_gates")
    require(isinstance(gates, list) and gates, "fresh actual source gates required")
    execution_gate_seen = False
    for row in gates:
        gate = json.loads(checked_artifact(row).read_text())
        require(gate.get("source_unchanged") is True and gate.get("source_commit") in {manifest["runtime_source_commit"], execution_commit}, "source gate identity differs")
        execution_gate_seen = execution_gate_seen or gate.get("source_commit") == execution_commit
        checks = gate.get("checks")
        require(isinstance(checks, list) and checks and all(c.get("exit_code") == 0 and type(c.get("exit_code")) is int for c in checks), "actual source gate failed")
    require(execution_gate_seen, "fresh execution source gate missing")
    capacity = approval.get("capacity")
    require(isinstance(capacity, dict) and capacity.get("reviewed") is True, "family dependency/capacity review missing")
    minimum = capacity.get("minimum_free_bytes")
    require(type(minimum) is int and minimum > 0, "positive family disk floor required")
    require(os.statvfs(manifest["task_root"]).f_bavail * os.statvfs(manifest["task_root"]).f_frsize >= minimum, "family disk floor not met")
    require(approval.get("confirm_seconds") == 600 and approval.get("finality_grace_seconds") == 30, "production lifecycle bounds changed")
    return approval


def verify_python_dependencies(manifest, approval):
    dependencies = approval.get("python_dependencies")
    if dependencies is None and manifest["scenario"] not in {"cosmwasm", "cosmosnative"}:
        return
    require(isinstance(dependencies, dict) and set(dependencies) == {"hpack"}, "reviewed passive H2 dependency descriptor required")
    descriptor = json.loads(checked_artifact(dependencies["hpack"]).read_text())
    require(descriptor.get("accepted_test_dependency_setup") is True and descriptor.get("version") == "4.2.0" and descriptor.get("copied_interpreter") is True and descriptor.get("no_extra_dependencies_or_package_hooks") is True, "passive H2 dependency setup/version differs")
    require(descriptor.get("interpreter") == manifest["verifier"]["python"] and pathlib.Path(sys.executable).resolve() == checked_artifact(descriptor["interpreter"], True).resolve(), "passive H2 copied interpreter differs")
    require(sys.flags.no_user_site == 1 and not os.environ.get("PYTHONPATH") and not os.environ.get("PYTHONHOME"), "passive H2 forbids ambient Python path/user-site/home")
    wheel = descriptor.get("wheel", {})
    require(wheel.get("bytes") == 34246 and wheel.get("sha256") == "858ac0b02280fa582b5080d68db0899c6" + "2a80375e0e5413a74970c5e518b6986", "passive H2 exact4.2.0 wheel differs")
    checked_artifact(wheel)
    configuration = checked_artifact(descriptor["venv_configuration"])
    require(configuration.resolve() == pathlib.Path(sys.prefix).resolve() / "pyvenv.cfg" and re.search(r"^include-system-site-packages\s*=\s*false\s*$", configuration.read_text(), re.M), "passive H2 venv permits external packages")
    site = pathlib.Path(descriptor["site_packages"])
    root = pathlib.Path(descriptor["package_root"])
    require(site.is_dir() and not site.is_symlink() and site.resolve().is_relative_to(pathlib.Path(sys.prefix).resolve()) and root == site / "hpack" and root.is_dir() and not root.is_symlink(), "passive H2 package escaped copied environment")
    files = descriptor.get("files")
    require(isinstance(files, list) and len(files) == 14 and len({row["path"] for row in files}) == 14, "passive H2 package/metadata closure differs")
    expected = {str(root / name) for name in ("__init__.py", "exceptions.py", "hpack.py", "huffman.py", "huffman_constants.py", "huffman_table.py", "py.typed", "struct.py", "table.py")}
    metadata = site / "hpack-4.2.0.dist-info"
    expected |= {str(metadata / name) for name in ("METADATA", "RECORD", "WHEEL", "licenses/LICENSE", "top_level.txt")}
    require({row["path"] for row in files} == expected and {path.name for path in site.iterdir()} == {"hpack", "hpack-4.2.0.dist-info"}, "passive H2 unreviewed package/site content")
    for row in files:
        checked_artifact(row)
    checked_artifact(descriptor["source_metadata"])
    from multivm_h2 import load_verified_hpack
    load_verified_hpack(root, files)


def verify_family_tools(manifest, case, approval):
    tools = case.get("family_tools", {})
    require(approval.get("family_tools", {}) == tools, "family tool approval differs")
    if not tools:
        require(manifest["scenario"] != "radix", "actual Radix SDK reference evidence tool required")
        return
    require(manifest["scenario"] == "radix" and isinstance(tools, dict) and set(tools) == {"radix_reference"}, "unknown family evidence tool")
    acceptance = approval.get("family_tool_acceptance")
    require(isinstance(acceptance, dict) and set(acceptance) == set(tools), "actual family reference acceptance missing")
    repository = pathlib.Path(__file__).resolve().parents[2]
    for name, row in tools.items():
        checked_artifact(row, True)
        result = json.loads(checked_artifact(acceptance[name]).read_text())
        require(result.get("root_approved") is True and result.get("accepted_reference_component") is True and result.get("tool") == row, "family SDK reference component not actually accepted")
        sources = result.get("source_sha256")
        require(isinstance(sources, dict) and sources, "actual family SDK reference source closure missing")
        for source, expected in sources.items():
            path = pathlib.Path(source)
            require(not path.is_absolute() and ".." not in path.parts and sha(repository / path) == expected, "family reference source changed/escaped")
        checks = result.get("checks")
        require(isinstance(checks, list) and checks and all(type(check.get("exit_code")) is int and check["exit_code"] == 0 for check in checks), "actual family reference build/check failed")
        for check in checks:
            checked_artifact(check["log"])


def verify_harness_parent(manifest, expected_pid=None):
    approval = read_approval(manifest)
    pid = os.getppid()
    require(expected_pid is None or type(expected_pid) is int and expected_pid == pid, "capture caller is not actual Rust harness parent")
    token = run_tool(manifest, "ps", ["-ww", "-p", str(pid), "-o", "pid=,ppid=,lstart=,comm="])
    fields = token.split(maxsplit=7)
    require(len(fields) == 8 and int(fields[0]) == pid, "actual harness parent identity missing")
    executable = pathlib.Path(f"/proc/{pid}/exe").readlink() if sys.platform.startswith("linux") else pathlib.Path(fields[7])
    require(executable.resolve() == checked_artifact(approval["harness"], True).resolve(), "actual parent is not the approved compiled Rust harness")
    return {"pid": pid, "os_start_token": token, "executable": approval["harness"]}


def direct_endpoint(value):
    parsed = urllib.parse.urlsplit(value)
    require(parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost", "::1"}, "evidence requires direct loopback HTTP")
    require(parsed.username is None and parsed.password is None and not parsed.fragment and not parsed.query, "public credential-free endpoint required")
    require(parsed.port is not None and 0 < parsed.port <= 65535, "explicit local node port required")
    return parsed


DOCKER_FIXTURE_FAMILIES = frozenset({"evm", "cosmosnative", "cosmwasm", "sealevel", "starknet", "radix", "tron"})


def validate_local_docker(manifest, case):
    """Owned Docker capability; grants no native RPC/evidence peer override."""
    if "local_docker" not in case:
        return None
    require(manifest["scenario"] in DOCKER_FIXTURE_FAMILIES, "family has no approved Docker fixture capability")
    docker = case["local_docker"]
    require(isinstance(docker, dict) and set(docker) == {"host", "config_dir"}, "explicit local Docker service/config required")
    value = docker["host"]
    require(isinstance(value, str) and value.startswith("unix:///") and not any(ord(char) < 33 or ord(char) == 127 for char in value) and "%" not in value and "\\" not in value, "literal local Docker unix service required")
    host = urllib.parse.urlsplit(value)
    require(host.scheme == "unix" and not host.netloc and host.path.startswith("/") and host.path != "/" and ".." not in pathlib.Path(host.path).parts and not host.query and not host.fragment, "only explicit local Docker unix service allowed")
    require(isinstance(docker["config_dir"], str), "Docker config must be exact owned child")
    root = pathlib.Path(manifest["task_root"])
    config = pathlib.Path(docker["config_dir"])
    require(root.is_absolute() and root.resolve(strict=True) == root and config == root / "docker-config" and not config.is_symlink(), "Docker config must be exact owned child")
    require(not config.exists() or config.is_dir(), "Docker config must be an owned directory")
    return docker


def validate_docker_approval(manifest, case, approval):
    docker = validate_local_docker(manifest, case)
    require(manifest["scenario"] not in DOCKER_FIXTURE_FAMILIES or docker is not None, "approved Docker fixture capability missing")
    require(approval.get("local_docker") == docker, "Docker service ownership approval differs")
    if docker is not None:
        require(os.environ.get("DOCKER_HOST") == docker["host"] and os.environ.get("DOCKER_CONFIG") == docker["config_dir"] and not any(os.environ.get(key) for key in ("DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "DOCKER_AUTH_CONFIG")), "helper/controller must bind the exact local Docker service/config without ambient overrides")
    return docker


def validate_evidence_nodes(manifest, case):
    docker = validate_local_docker(manifest, case)
    nodes = case.get("evidence_nodes", {})
    if not nodes:
        require(manifest["scenario"] != "starknet", "Source Starknet healthy owned evidence peer must be explicit")
        return {}
    require(manifest["scenario"] == "starknet" and isinstance(nodes, dict) and set(nodes) == set(case["chain_names"]) and len(nodes) == 2, "direct evidence override is Source Starknet-only")
    require(docker is not None, "explicit local Docker service/config required")
    expected_keys = {"effective_field", "configured_ordinal", "original_url", "connect_url", "rewrite", "source_container_suffix", "host_port", "container_port", "source_image", "image_id", "command"}
    command = ["--state-archive-capacity", "full", "--block-generation-on", "5", "--seed", "0"]
    for index, name in enumerate(case["chain_names"]):
        row = nodes[name]
        require(isinstance(row, dict) and set(row) == expected_keys and row["effective_field"] in {"rpcurls", "customrpcurls"} and type(row["configured_ordinal"]) is int and row["configured_ordinal"] == 2, "Source healthy evidence ordinal/field differs")
        port = 5050 + 20 * index
        require(type(row["host_port"]) is int and row["host_port"] == port and row["container_port"] == 5050 and row["source_container_suffix"] == "starknet-" + str(port), "Source owned devnet ports/name differ")
        require(row["source_image"] == "shardlabs/starknet-devnet-rs:0.4.2" and isinstance(row["image_id"], str) and re.fullmatch(r"sha256:[0-9a-f]{64}", row["image_id"]) and row["command"] == command, "Source devnet image/command differs")
        original, connect = urllib.parse.urlsplit(row["original_url"]), direct_endpoint(row["connect_url"])
        require(original.scheme == "http" and original.hostname in {"127.0.0.1", "localhost", "::1", "0.0.0.0"} and original.port == connect.port == port and original.path == connect.path and not original.username and not original.password and not original.query and not original.fragment, "direct evidence changed native service/port/path")
        if original.hostname == "0.0.0.0":
            require(row["rewrite"] == "source-wildcard-to-loopback" and connect.hostname == "127.0.0.1", "wildcard evidence rewrite must be exact local loopback")
        else:
            require(row["rewrite"] == "identity" and row["original_url"] == row["connect_url"], "nonwildcard evidence endpoint must remain exact")
    return nodes


def selected_evidence_node(chain, node):
    field = "customrpcurls" if "customrpcurls" in chain else "rpcurls"
    values = urls(chain[field])
    require(field == node["effective_field"] and node["configured_ordinal"] < len(values) and values[node["configured_ordinal"]] == node["original_url"], "evidence selection differs from effective configured Source peer")
    return node["connect_url"]


def source_connect_url(value, node=None):
    if urllib.parse.urlsplit(value).hostname == "0.0.0.0":
        require(node is not None and value == node["original_url"] and node["rewrite"] == "source-wildcard-to-loopback", "unreviewed Source wildcard endpoint")
        direct_endpoint(node["connect_url"])
        return node["connect_url"]
    direct_endpoint(value)
    return value


def verified_harness_identity(manifest, approval, row):
    require(isinstance(row, dict) and set(row) == {"pid", "os_start_token", "executable"} and type(row["pid"]) is int and row["pid"] > 0 and row["executable"] == approval["harness"], "actual checker harness identity differs")
    token = run_tool(manifest, "ps", ["-ww", "-p", str(row["pid"]), "-o", "pid=,ppid=,lstart=,comm="])
    require(token == row["os_start_token"], "actual harness PID/start epoch changed")
    fields = token.split(maxsplit=7)
    require(len(fields) == 8 and int(fields[0]) == row["pid"], "actual harness identity missing")
    executable = pathlib.Path(f'/proc/{row["pid"]}/exe').readlink() if sys.platform.startswith("linux") else pathlib.Path(fields[7])
    require(executable.resolve() == checked_artifact(row["executable"], True).resolve(), "actual harness executable changed")
    return row


def owned_devnet_name(task_root, pid, suffix):
    require(type(pid) is int and pid > 0 and re.fullmatch(r"starknet-(5050|5070)", suffix), "invalid owned devnet identity")
    digest = hashlib.sha256(os.fsencode(pathlib.Path(task_root).resolve(strict=True))).hexdigest()[:10]
    return f"ziggy-e2e-{digest}-{pid}-{suffix}"


def verify_devnet_inspect(row, node, name, absent_wall_ns, previous=None, *, approved_image_id=None, approved_labels=None):
    require(isinstance(row, dict) and row.get("Name") == "/" + name and re.fullmatch(r"[0-9a-f]{64}", row.get("Id", "")) and row.get("State", {}).get("Running") is True, "actual owned devnet missing/not running")
    allowed_images = {node["source_image"]}
    if approved_image_id is not None:
        require(approved_image_id == node["image_id"] and isinstance(approved_labels, dict) and set(approved_labels) == {"io.hyperlane.ziggy.case-root", "io.hyperlane.ziggy.harness-pid", "io.hyperlane.ziggy.run-token"}, "unbound external immutable image/labels")
        allowed_images.add(approved_image_id)
        require(all(row.get("Config", {}).get("Labels", {}).get(key) == value for key, value in approved_labels.items()), "actual devnet ownership labels differ")
        limits = row.get("HostConfig", {})
        require(limits.get("Memory") == limits.get("MemorySwap") == 2 * 1024**3 and limits.get("NanoCpus") == 2_000_000_000 and limits.get("PidsLimit") == 256 and limits.get("PortBindings") == {"5050/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(node["host_port"])}]}, "actual external devnet caps/loopback differ")
    else:
        require(approved_labels is None, "labels require explicit approved image")
    require(row.get("Image") == node["image_id"] and row.get("Config", {}).get("Image") in allowed_images and row["Config"].get("Cmd") == node["command"], "actual devnet image/command differs")
    created = datetime.datetime.fromisoformat(row["Created"].replace("Z", "+00:00"))
    require(created.tzinfo is not None and created.timestamp() * 1_000_000_000 >= absent_wall_ns, "devnet predates actual absence receipt")
    bindings = row.get("NetworkSettings", {}).get("Ports", {}).get("5050/tcp")
    require(isinstance(bindings, list) and bindings and all(binding.get("HostPort") == str(node["host_port"]) and binding.get("HostIp") in {"", "0.0.0.0", "127.0.0.1", "::", "::1"} for binding in bindings), "actual owned devnet port mapping differs")
    if approved_image_id is not None:
        require(bindings == [{"HostPort": str(node["host_port"]), "HostIp": "127.0.0.1"}], "external devnet must expose only exact loopback")
    if previous is not None:
        require(row["Id"] == previous["Id"] and row["Created"] == previous["Created"], "owned devnet container identity changed")
    return row


def direct_request(endpoint, payload, *, path=None, timeout=20):
    """No urllib opener, environment proxy, credential provider or retries."""
    parsed = direct_endpoint(endpoint)
    target = path if path is not None else parsed.path or "/"
    require(target.startswith("/") and not target.startswith("//"), "invalid local RPC path")
    connection = http.client.HTTPConnection("127.0.0.1" if parsed.hostname == "localhost" else parsed.hostname, parsed.port, timeout=timeout)
    try:
        connection.request("POST", target, json.dumps(payload, separators=(",", ":")).encode(), {"Content-Type": "application/json"})
        response = connection.getresponse()
        body = response.read(32 * 1024 * 1024 + 1)
        require(response.status == 200 and len(body) <= 32 * 1024 * 1024, "native evidence RPC failed")
        return json.loads(body)
    finally:
        connection.close()


def rpc(endpoint, method, params):
    result = direct_request(endpoint, {"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    require(isinstance(result, dict) and result.get("id") == 1 and "error" not in result and "result" in result, "native JSONRPC error/identity mismatch")
    return result["result"]


def run_tool(manifest, tool, arguments, *, stdin=None, timeout=30):
    return run_artifact(manifest, manifest["verifier_tools"][tool], arguments, stdin=stdin, timeout=timeout)


def run_artifact(manifest, artifact, arguments, *, stdin=None, timeout=30):
    path = checked_artifact(artifact, True)
    # Tools get no ambient credentials, proxy, wallet home or provider settings.
    environment = {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C", "PGPASSFILE": "/dev/null", "PGSERVICEFILE": "/dev/null"}
    result = subprocess.run([str(path), *map(str, arguments)], input=stdin, text=True, capture_output=True, timeout=timeout, env=environment, cwd=manifest["task_root"], check=False)
    require(result.returncode == 0, "pinned evidence command failed")
    require(len(result.stdout) <= 32 * 1024 * 1024, "oversized evidence command output")
    return result.stdout.strip()


def normalized(value):
    if isinstance(value, dict):
        result = {}
        for key, child in value.items():
            name = re.sub("[_ -]", "", key).lower()
            require(name and name.isascii() and name.isalnum() and name not in result, "ambiguous config key")
            result[name] = normalized(child)
        return result
    if isinstance(value, list):
        return [normalized(child) for child in value]
    return value


def merge(target, source):
    for key, value in source.items():
        if isinstance(value, dict) and isinstance(target.get(key), dict):
            merge(target[key], value)
        else:
            target[key] = copy.deepcopy(value)


def set_path(target, path, value):
    parts = [re.sub("[_ -]", "", p).lower() for p in path]
    require(parts and all(p.isascii() and p.isalnum() for p in parts), "invalid config path")
    current = target
    for part in parts[:-1]:
        require(isinstance(current, dict), "config path crosses scalar")
        # config0.13 and Zig setPath replace an array/scalar with a numeric
        # table when dotted environment paths descend into it.
        if not isinstance(current.get(part), dict):
            current[part] = {}
        current = current[part]
    require(isinstance(current, dict), "config path crosses scalar")
    current[parts[-1]] = value


ENDPOINT_FIELDS = {"rpcurls", "customrpcurls", "walleturls", "customwalleturls", "walletsolidityurls", "customwalletsolidityurls", "grpcurls", "customgrpcurls", "gatewayurls", "customgatewayurls"}
SUFFIX = {field: field.upper() for field in ENDPOINT_FIELDS}


def urls(value):
    if isinstance(value, str):
        if value.startswith("["):
            return urls(json.loads(value))
        require(value and all(part.strip() == part and part for part in value.split(",")), "invalid endpoint CSV")
        return value.split(",")
    require(isinstance(value, list) and value, "endpoint array required")
    result = []
    for row in value:
        require(isinstance(row, dict) and {"http"} <= set(row) <= {"http", "public"} and isinstance(row["http"], str) and ("public" not in row or type(row["public"]) is bool), "unsupported/WS endpoint shape")
        result.append(row["http"])
    return result


def effective_config(request, manifest):
    """Replay native layering, capture selected public setup and reject bypasses.

    Unrelated chain bodies/signing keys are never serialized. Defaults are
    inspected only to produce the exact selected-chain effective result.
    """
    require(request.get("schema") == 1 and request.get("scenario") == manifest["scenario"] and request.get("runtime_source_commit") == manifest["runtime_source_commit"], "capture runtime differs")
    require(request.get("role") in {"relayer", "validator", "scraper"}, "invalid role capture")
    case = json.loads(checked_artifact(manifest["case_inputs"]).read_text())
    nodes = validate_evidence_nodes(manifest, case)
    names = request.get("selected_chain_names")
    require(names == case.get("chain_names") and names and len(names) == len(set(names)), "capture chain binding differs")
    cwd = pathlib.Path(request["cwd"] or os.getcwd()).resolve(strict=True)
    env = request["environment"]
    require(isinstance(env, dict) and all(isinstance(k, str) and isinstance(v, str) for k, v in env.items()), "bad explicit role environment")
    defaults = pathlib.Path(env.get("HYPERLANE_ZIG_DEFAULTS", "./config"))
    if not defaults.is_absolute():
        defaults = cwd / defaults
    require(defaults.is_dir() and not defaults.is_symlink(), "actual defaults directory missing")
    # Native loader uses directory iteration order. Preserve it in capture.
    paths = [p for p in defaults.iterdir() if p.is_file() and not p.is_symlink() and p.suffix == ".json"]
    for filename in env.get("CONFIG_FILES", "").split(","):
        if filename:
            p = pathlib.Path(filename)
            paths.append(p if p.is_absolute() else cwd / p)
    config, sources = {}, []
    for path in paths:
        require(path.is_file() and not path.is_symlink(), "actual configuration file missing/unsafe")
        raw = path.read_bytes()
        parsed = normalized(json.loads(raw))
        require(isinstance(parsed, dict), "config root must be object")
        merge(config, parsed)
        sources.append({"path": str(path.resolve()), "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()})
    for key, value in env.items():
        if key.startswith("HYP_"):
            set_path(config, key[4:].split("_"), value)
    arguments = iter(request["arguments"])
    for argument in arguments:
        require(argument.startswith("--") and len(argument) > 2, "unrecognized role argument")
        key, separator, value = argument[2:].partition("=")
        if not separator:
            value = next(arguments, None)
            require(value is not None and not value.startswith("--"), "ambiguous argument capture")
        # Environment overrides cannot intercept higher-precedence CLI endpoints.
        require(not (key.lower().startswith("chains.") and any(p in ENDPOINT_FIELDS or "url" in p.lower() for p in key.lower().split("."))), "CLI endpoint would bypass capture")
        set_path(config, key.split("."), value)
    selected = {}
    inert = {}
    for name in names:
        chain = copy.deepcopy(config.get("chains", {}).get(name.lower()))
        require(isinstance(chain, dict) and chain.get("name") == name, "selected deployed chain missing")
        for field in ENDPOINT_FIELDS & chain.keys():
            if field.startswith("custom"):
                continue
            value = chain[field]
            if isinstance(value, dict):
                require(value and set(value) == {str(i) for i in range(len(value))}, "base endpoint indexes must be contiguous")
                value = [copy.deepcopy(value[str(i)]) for i in range(len(value))]
                chain[field] = value
            require(isinstance(chain[field], list), "base endpoints require native array or indexed table, not JSON string")
            for row in chain[field]:
                require(isinstance(row, dict), "base endpoint row must be object")
                if "public" in row:
                    if isinstance(row["public"], str):
                        require(row["public"].lower() in {"true", "false"}, "invalid endpoint public flag")
                        row["public"] = row["public"].lower() == "true"
                    require(type(row["public"]) is bool, "invalid endpoint public flag")
        node = nodes.get(name)
        if node is not None:
            selected_evidence_node(chain, node)
        protocol = {"evm": "ethereum", "tron": "tron", "starknet": "starknet", "radix": "radix", "cosmwasm": "cosmos", "cosmosnative": "cosmosnative", "sealevel": "sealevel", "sealevel-composite": "sealevel"}.get(manifest["scenario"])
        require(protocol is not None and chain.get("protocol") == protocol, "wrong actual VM family")
        # Reject ANY additional URL-bearing authority in the selected chain;
        # supporting a new shape requires explicit interception, never bypass.
        if "connection" in chain:
            legacy = chain["connection"]
            require(isinstance(legacy, dict) and legacy and set(legacy) <= {"url", "urls"}, "unknown nested connection authority")
            for field, value in legacy.items():
                for endpoint in urls(value):
                    direct_endpoint(endpoint)
                inert[f"chains.{name}.connection.{field}"] = value
        if "blockexplorers" in chain:
            explorers = chain["blockexplorers"]
            require(isinstance(explorers, list), "inert explorer metadata must be an array")
            for explorer in explorers:
                require(isinstance(explorer, dict) and set(explorer) == {"apikey", "apiurl", "family", "name", "url"} and all(isinstance(value, str) for value in explorer.values()), "unknown inert explorer metadata shape")
                for field in ("url", "apiurl"):
                    parsed = urllib.parse.urlsplit(explorer[field])
                    require(parsed.scheme in {"http", "https"} and parsed.hostname and parsed.username is None and parsed.password is None, "invalid public inert explorer URL")
                explorer["apikey"] = {"redacted_config_sha256": hashlib.sha256(explorer["apikey"].encode()).hexdigest()}
        def inspect(value, top=False):
            if isinstance(value, dict):
                for key, child in value.items():
                    if key in {"connection", "blockexplorers"} and top:
                        continue # exact Source-proven inert metadata shapes above
                    if "url" in key:
                        require(key in ENDPOINT_FIELDS, "unintercepted selected-chain URL field")
                        for endpoint in urls(child):
                            source_connect_url(endpoint, node)
                        continue
                    inspect(child)
            elif isinstance(value, list):
                for child in value:
                    inspect(child)
            elif isinstance(value, str) and re.match(r"^[a-z][a-z0-9+.-]*://", value):
                source_connect_url(value, node)
        inspect(chain, top=True)
        for field in ENDPOINT_FIELDS & chain.keys():
            for endpoint in urls(chain[field]):
                source_connect_url(endpoint, node)
        require("rpcurls" in chain, "required actual JSONRPC config absent")
        if manifest["scenario"] == "tron":
            require({"walleturls", "walletsolidityurls"} <= chain.keys(), "actual TRE wallet endpoints absent")
        # Selected signers may contain the public fixture key. No key material
        # is needed in endpoint/receipt evidence, even when it is disposable.
        for field in ("signer", "identity", "ccssigner"):
            if field in chain:
                chain[field] = {"redacted_config_sha256": hashlib.sha256(json.dumps(chain[field], sort_keys=True).encode()).hexdigest()}
        selected[name] = chain
    selector = {"relayer": "relaychains", "validator": "originchainname", "scraper": "chainstoscrape"}[request["role"]]
    role_names = config.get(selector)
    require(isinstance(role_names, str) and set(role_names.split(",")) <= set(names), "role selected chain bypass")
    require(role_names and (request["role"] != "validator" or "," not in role_names), "invalid role chain selector")
    return {"schema": 1, "scenario": manifest["scenario"], "role": request["role"], "runtime_source_commit": manifest["runtime_source_commit"], "harness_pid": request["harness_pid"], "config_sources": sources, "chains": selected, "inert_legacy_connection_fields": inert, "inert_field_source_contract": "blockExplorers: Rust config/testnet_config.json metadata, not RPC endpoints in Rust/Zig chain parsers; API key redacted. Rust settings/parser/mod.rs parse_base_and_override_urls(rpcUrls,customRpcUrls) and Zig settings/root.zig parseChain typed URLs; connection.url(s) not consumed.", "role_chain_names": role_names.split(","), "metrics_port": int(config.get("metricsport", 9090)), "db": config.get("db"), "checkpoint_syncer": config.get("checkpointsyncer"), "allows_public_rpcs": str(config.get("allowpublicrpcs", False)).lower() == "true"}


def endpoint_replacements(capture, replacements):
    """Only original selected endpoint fields, preserving all fallback entries."""
    expected = {(name, field) for name, chain in capture["chains"].items() for field in ENDPOINT_FIELDS & chain.keys()}
    require(set(replacements) == expected, "every original default/custom endpoint field must be intercepted")
    env = {}
    proxied = copy.deepcopy(capture)
    for (name, field), endpoints in replacements.items():
        original = urls(capture["chains"][name][field])
        require(len(original) == len(endpoints) and endpoints, "fallback count changed")
        equivalence = {}
        for before, after in zip(original, endpoints):
            require(before not in equivalence or equivalence[before] == after, "duplicate original endpoint equivalence changed")
            equivalence[before] = after
        require(len(set(equivalence.values())) == len(equivalence), "distinct endpoint slots collapsed")
        for endpoint in endpoints:
            direct_endpoint(endpoint)
        if field.startswith("custom"):
            proxied["chains"][name][field] = ",".join(endpoints)
            env[f"HYP_CHAINS_{name.upper()}_{SUFFIX[field]}"] = ",".join(endpoints)
        else:
            base = capture["chains"][name][field]
            if isinstance(base, str):
                base = json.loads(base)
            require(isinstance(base, list), "base endpoint metadata array required")
            proxied["chains"][name][field] = [dict(original_row, http=endpoint) for original_row, endpoint in zip(base, endpoints)]
            # Both real loaders keep environment values as strings. A whole
            # JSON array string is NOT a base URL array. Numeric paths create
            # an array-like table, replacing the original array: repeat every
            # consumed field, including public=false/true privacy metadata.
            for index, row in enumerate(proxied["chains"][name][field]):
                prefix = f"HYP_CHAINS_{name.upper()}_{SUFFIX[field]}_{index}"
                env[prefix + "_HTTP"] = row["http"]
                if "public" in row:
                    env[prefix + "_PUBLIC"] = "true" if row["public"] else "false"
    return env, proxied


def hex_bytes(value, count=None):
    require(isinstance(value, str) and value.startswith("0x") and re.fullmatch("[0-9a-fA-F]*", value[2:]) and len(value) % 2 == 0, "invalid native hex")
    result = bytes.fromhex(value[2:])
    require(count is None or len(result) == count, "native hex width differs")
    return result


def message_wire(value, keccak):
    raw = hex_bytes(value)
    require(len(raw) >= 77 and raw[0] == 3, "invalid canonical Hyperlane message")
    return {"id": keccak(value).lower(), "wire": value.lower(), "nonce": int.from_bytes(raw[1:5], "big"), "origin": int.from_bytes(raw[5:9], "big"), "sender": "0x" + raw[9:41].hex(), "destination": int.from_bytes(raw[41:45], "big"), "recipient": "0x" + raw[45:77].hex(), "body": "0x" + raw[77:].hex()}


def process_identity(manifest, row):
    require(row["executable"] == manifest["artifacts"][row["role"]], "child binary differs")
    checked_artifact(row["executable"], True)
    token = run_tool(manifest, "ps", ["-ww", "-p", str(row["pid"]), "-o", "pid=,ppid=,lstart=,comm="])
    require(token == row["os_start_token"], "owned child PID/start token changed")
    columns = token.split(maxsplit=7)
    require(len(columns) == 8 and int(columns[0]) == row["pid"] and int(columns[1]) == row["parent_pid"], "owned child parent identity differs")
    executable = pathlib.Path(f'/proc/{row["pid"]}/exe').readlink() if sys.platform.startswith("linux") else pathlib.Path(columns[7])
    require(executable.resolve() == pathlib.Path(row["executable"]["path"]).resolve(), "actual child executable differs")
    return True


class HttpFrames:
    """Bounded HTTP/1 wire framing for a transparent local correctness tap.

    Returned wire bytes are forwarded unchanged, including chunk framing and
    header spelling/order. No transport retry, header injection or RPC rewrite.
    Ambiguous framing/encoding is rejected instead of silently losing evidence.
    """
    LIMIT = 32 * 1024 * 1024

    def __init__(self, response=False):
        self.buffer = bytearray()
        self.response = response

    def feed(self, data, *, eof=False):
        self.buffer.extend(data)
        require(len(self.buffer) <= self.LIMIT, "HTTP tap frame exceeded bound")
        frames = []
        while self.buffer:
            boundary = self.buffer.find(b"\r\n\r\n")
            if boundary < 0:
                require(not eof, "truncated HTTP headers")
                break
            require(boundary <= 65536, "oversized HTTP headers")
            lines = bytes(self.buffer[:boundary]).split(b"\r\n")
            start = lines[0].decode("ascii")
            headers = {}
            for line in lines[1:]:
                require(line and line[:1] not in b" \t" and b":" in line, "ambiguous HTTP header")
                key, value = line.split(b":", 1)
                key = key.decode("ascii").lower()
                require(key not in headers, "duplicate HTTP header unsupported by evidence tap")
                headers[key] = value.strip().decode("ascii")
            require("content-length" not in headers or "transfer-encoding" not in headers, "ambiguous HTTP framing")
            require(headers.get("content-encoding", "identity").lower() == "identity", "encoded RPC response cannot be inspected")
            offset = boundary + 4
            body = None
            if "transfer-encoding" in headers:
                require(headers["transfer-encoding"].lower() == "chunked", "unsupported transfer encoding")
                cursor, chunks = offset, []
                while True:
                    end = self.buffer.find(b"\r\n", cursor)
                    if end < 0:
                        break
                    size_text = bytes(self.buffer[cursor:end]).split(b";", 1)[0]
                    require(re.fullmatch(b"[0-9a-fA-F]+", size_text), "invalid HTTP chunk size")
                    size = int(size_text, 16)
                    require(size <= self.LIMIT, "oversized HTTP chunk")
                    cursor = end + 2
                    if size == 0:
                        if self.buffer[cursor:cursor + 2] == b"\r\n":
                            total = cursor + 2
                            body = b"".join(chunks)
                        else:
                            end = self.buffer.find(b"\r\n\r\n", cursor)
                            if end >= 0:
                                total, body = end + 4, b"".join(chunks)
                        break
                    if len(self.buffer) < cursor + size + 2:
                        break
                    require(self.buffer[cursor + size:cursor + size + 2] == b"\r\n", "invalid HTTP chunk terminator")
                    chunks.append(bytes(self.buffer[cursor:cursor + size]))
                    cursor += size + 2
            elif "content-length" in headers:
                require(headers["content-length"].isdigit(), "invalid HTTP content length")
                size = int(headers["content-length"])
                require(size <= self.LIMIT, "oversized HTTP body")
                total = offset + size
                if len(self.buffer) >= total:
                    body = bytes(self.buffer[offset:total])
            elif self.response:
                fields = start.split(" ", 2)
                require(len(fields) >= 2 and fields[0].startswith("HTTP/1.") and fields[1].isdigit(), "bad HTTP response line")
                status = int(fields[1])
                if status in {204, 304} or 100 <= status < 200:
                    require(status != 101, "WebSocket escape forbidden")
                    total, body = offset, b""
                elif eof:
                    total, body = len(self.buffer), bytes(self.buffer[offset:])
            else:
                # A request without transfer framing has no message body.
                total, body = offset, b""
            if body is None:
                require(not eof, "truncated HTTP body")
                break
            wire = bytes(self.buffer[:total])
            del self.buffer[:total]
            frames.append({"wire": wire, "start": start, "headers": headers, "body": body})
        return frames


def checked_cw_peer_context(context, upstream):
    if context is None:
        return None
    keys = {"scenario", "chain", "domain", "field", "ordinal", "upstream", "healthy_fallback", "error_type", "phase", "role", "case_inputs_sha256"}
    require(isinstance(context, dict) and set(context) == keys and context["scenario"] == "cosmwasm"
            and context["role"] in {"validator", "relayer", "scraper"}
            and type(context["domain"]) is int and type(context["ordinal"]) is int and context["ordinal"] == 0
            and context["field"] == "grpcurls" and context["phase"] == "upstream_connect"
            and context["error_type"] == "ConnectionRefusedError" and context["upstream"] == upstream == "http://localhost:1337"
            and isinstance(context["case_inputs_sha256"], str) and re.fullmatch("[0-9a-f]{64}", context["case_inputs_sha256"]),
            "unexpected unavailable endpoint context")
    expected = {"cosmostest99990": (99990,"http://127.0.0.1:26603"), "cosmostest99991": (99991,"http://127.0.0.1:26613")}
    require(context["chain"] in expected and (context["domain"],context["healthy_fallback"]) == expected[context["chain"]], "crossed CW domain/fallback")
    return dict(context)


class TransparentProxy:
    """Owned node proxy. Callback completes BEFORE original response is sent."""
    def __init__(self, upstream, observe, failure, *, connect_upstream=None):
        if connect_upstream is not None:
            original = urllib.parse.urlsplit(upstream)
            connected = direct_endpoint(connect_upstream)
            require(original.scheme == connected.scheme == "http" and original.hostname == "0.0.0.0" and connected.hostname == "127.0.0.1" and original.port == connected.port and original.path == connected.path and not original.query and not original.fragment and not original.username and not original.password, "proxy connect normalization changed Source authority")
            self.upstream = connected
        else:
            self.upstream = direct_endpoint(upstream)
        self.observe = observe
        self.failure = failure
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(32)
        self.listener.settimeout(0.2)
        self.stopping = threading.Event()
        self.lock = threading.Lock()
        self.connections = set()
        self.workers = []
        self.thread = threading.Thread(target=self._accept, name="owned-native-rpc-tap", daemon=True)
        self.thread.start()

    @property
    def endpoint(self):
        return f"http://127.0.0.1:{self.listener.getsockname()[1]}" + self.upstream.path

    def _accept(self):
        while not self.stopping.is_set():
            try:
                client, _ = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            worker = threading.Thread(target=self._connection, args=(client,), daemon=True)
            self.workers.append(worker)
            worker.start()

    def report_error(self, error, scope):
        if isinstance(error, (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)):
            # A role may cancel/close its actual RPC socket during owned
            # shutdown/restart. Retain the transport observation; it neither
            # grants a receipt nor rewrites the upstream RPC result. Parse and
            # lifecycle failures remain hard acceptance errors.
            self.failure({"kind": "peer_disconnect", "scope": scope, "error": type(error).__name__, "monotonic_ns": time.monotonic_ns()})
        else:
            self.failure(type(error).__name__ + ": " + str(error))

    def _connection(self, client):
        upstream = None
        try:
            upstream = socket.create_connection(("127.0.0.1" if self.upstream.hostname == "localhost" else self.upstream.hostname, self.upstream.port), timeout=20)
            # Normal keep-alive idle periods are not RPC failures. The agent
            # retains its own physical/owner deadlines; owned shutdown closes
            # both sockets to drain these blocking relay threads.
            upstream.settimeout(None)
            client.settimeout(None)
            with self.lock:
                self.connections.update((client, upstream))
            requests = []
            condition = threading.Condition()

            def outbound():
                parser = HttpFrames()
                try:
                    while not self.stopping.is_set():
                        data = client.recv(65536)
                        for frame in parser.feed(data, eof=not data):
                            parts = frame["start"].split(" ")
                            require(len(parts) == 3 and parts[0] == "POST" and parts[1].startswith("/") and not parts[1].startswith("//") and parts[2] in {"HTTP/1.0", "HTTP/1.1"}, "non-RPC/proxy escape request")
                            require("authorization" not in frame["headers"] and "proxy-authorization" not in frame["headers"], "secret authorization header forbidden in public fixture capture")
                            try:
                                frame["json"] = json.loads(frame["body"])
                            except (UnicodeDecodeError, json.JSONDecodeError):
                                self.failure("InvalidJsonRequest: native observer could not decode public RPC body")
                                frame["json"] = None
                            frame["requested_monotonic_ns"] = time.monotonic_ns()
                            with condition:
                                requests.append(frame)
                                condition.notify_all()
                            upstream.sendall(frame["wire"])
                        if not data:
                            upstream.shutdown(socket.SHUT_WR)
                            break
                except Exception as error:
                    if not self.stopping.is_set():
                        self.report_error(error, "request")
                    try:
                        upstream.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass

            sender = threading.Thread(target=outbound, daemon=True)
            sender.start()
            parser = HttpFrames(response=True)
            while not self.stopping.is_set():
                data = upstream.recv(65536)
                for frame in parser.feed(data, eof=not data):
                    status = int(frame["start"].split(" ")[1])
                    if status < 200:
                        client.sendall(frame["wire"])
                        continue
                    with condition:
                        require(requests, "RPC response without observed request")
                        request = requests.pop(0)
                    try:
                        response_json = json.loads(frame["body"])
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        self.failure("InvalidJsonResponse: native observer could not decode public RPC body")
                        client.sendall(frame["wire"])
                        continue
                    # Persist first positive witness and receive time BEFORE the
                    # exact response can affect the agent's lifecycle state.
                    try:
                        self.observe(request, response_json, status, time.monotonic_ns(), frame)
                    except Exception as error:
                        self.failure(type(error).__name__ + ": " + str(error))
                    client.sendall(frame["wire"])
                if not data:
                    break
            try:
                client.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            sender.join(timeout=31)
            require(not sender.is_alive(), "RPC proxy request worker did not retire")
        except Exception as error:
            if not self.stopping.is_set():
                self.report_error(error, "connection")
        finally:
            for connection in (client, upstream):
                if connection is not None:
                    with self.lock:
                        self.connections.discard(connection)
                    connection.close()

    def close(self):
        self.stopping.set()
        self.listener.close()
        with self.lock:
            for connection in self.connections:
                try:
                    connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
        self.thread.join(timeout=2)
        for worker in self.workers:
            worker.join(timeout=32)
        require(not self.thread.is_alive() and all(not worker.is_alive() for worker in self.workers), "owned RPC proxy did not drain")


class RawTcpProxy(TransparentProxy):
    """Exact TCP forwarding, with an optional separately approved passive tap."""
    def __init__(self, *args, h2_observer_factory=None, connect_upstream=None, expected_unavailable=None):
        self.h2_observer_factory = h2_observer_factory
        self.expected_unavailable = checked_cw_peer_context(expected_unavailable, args[0])
        require(expected_unavailable is None or connect_upstream is None, "expected unavailable peer cannot normalize authority")
        super().__init__(*args, connect_upstream=connect_upstream)

    def _open_upstream(self):
        try:
            return socket.create_connection(("127.0.0.1" if self.upstream.hostname == "localhost" else self.upstream.hostname, self.upstream.port), timeout=20)
        except ConnectionRefusedError as error:
            if self.expected_unavailable is None:
                raise
            self.failure({"kind":"expected_source_endpoint_unavailable", "context":dict(self.expected_unavailable),
                          "error_type":type(error).__name__, "error":str(error),
                          "monotonic_ns":time.monotonic_ns(), "positive_receipt_credit":False})
            return None

    def _connection(self, client):
        upstream = None
        try:
            upstream = self._open_upstream()
            if upstream is None:
                return
            upstream.settimeout(None)
            client.settimeout(None)
            with self.lock:
                self.connections.update((client, upstream))
            results = {}
            observer = self.h2_observer_factory() if self.h2_observer_factory is not None else None
            def relay(source, target, direction):
                digest, count = hashlib.sha256(), 0
                try:
                    while not self.stopping.is_set():
                        data = source.recv(65536)
                        if not data:
                            if observer is not None:
                                observer.close(direction)
                            try:
                                target.shutdown(socket.SHUT_WR)
                            except OSError:
                                pass
                            break
                        digest.update(data)
                        count += len(data)
                        if observer is not None:
                            observer.feed(direction, data)
                        target.sendall(data)
                    results[direction] = {"bytes": count, "sha256": digest.hexdigest()}
                except OSError as error:
                    if not self.stopping.is_set():
                        self.report_error(error, "raw_tcp_" + direction)
                    try:
                        target.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
            sender = threading.Thread(target=relay, args=(client, upstream, "request"), daemon=True)
            sender.start()
            relay(upstream, client, "response")
            try:
                client.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            sender.join(timeout=2)
            require(not sender.is_alive(), "owned raw TCP request relay did not retire")
            if "request" in results and "response" in results:
                self.observe({"transport": "tcp", **results}, None, None, time.monotonic_ns(), None)
        except Exception as error:
            if not self.stopping.is_set():
                self.report_error(error, "raw_tcp_connection")
        finally:
            for connection in (client, upstream):
                if connection is not None:
                    with self.lock:
                        self.connections.discard(connection)
                    connection.close()
