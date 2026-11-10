#!/usr/bin/env python3
"""Evidence controls. No agent, SDK or native node; explicit loopback HTTP only."""
import copy
import hashlib
import importlib.util
import json
import pathlib
import http.server
import tempfile
import threading
import time
import unittest
from unittest import mock

import multivm_evidence as evidence
import multivm_evm as evm
import multivm_tron as tron
import multivm_session as session_module
from multivm_session import Lifecycle, Session, tron_transaction_id

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("multivm_process", HERE / "multivm_process.py")
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="ziggy-multivm-pure-")
        self.addCleanup(self.directory.cleanup)
        self.root = pathlib.Path(self.directory.name).resolve()
        def artifact(name):
            p = self.root / name
            p.write_bytes(("public fixture " + name).encode())
            p.chmod(0o700)
            return {"path": str(p), "bytes": p.stat().st_size, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
        self.value = {"schema": 3, "implementation": "zig", "scenario": "evm", "runtime_source_commit": "a" * 40, "mode": "ReleaseSafe", "task_root": str(self.root), "artifacts": {name: artifact(name) for name in api.ROLES + api.LIBRARIES}, "environment": {}, "verifier": {"python": artifact("python"), "script": artifact("checker.py"), "evidence_root": str(self.root / "evidence")}, "execution_approval": artifact("execution-approval.json"), "case_inputs": artifact("case-inputs.json"), "verifier_tools": {name: artifact("tool-" + name) for name in ["cast", "oracle", "native_rows", "psql", "docker", "ps"]}, "harness_deadline_seconds": 1800, "tool_overrides": {}}
        self.value["environment"] = {key: self.value["artifacts"][name]["path"] for key, name in api.ALIASES.items()}

    def rejected(self, mutate):
        value = copy.deepcopy(self.value)
        mutate(value)
        with self.assertRaises((ValueError, FileNotFoundError)):
            api.validate_manifest(value)

    def test_complete_explicit_runtime(self):
        self.assertEqual(api.validate_manifest(self.value), self.value)

    def test_each_role_and_dependency_is_mandatory(self):
        for role in api.ROLES + api.LIBRARIES:
            with self.subTest(role=role):
                self.rejected(lambda v: v["artifacts"].pop(role))

    def test_schema2_provenance_and_verifier_tools_required(self):
        for key in ["execution_approval", "case_inputs", "verifier_tools"]:
            self.rejected(lambda v: v.pop(key))
        self.rejected(lambda v: v["verifier_tools"].pop("oracle"))
        self.rejected(lambda v: v["artifacts"].pop("url"))
        self.rejected(lambda v: v["environment"].pop("HYPERLANE_URL_LIBRARY"))

    def test_bad_hash_or_size_or_permissions(self):
        self.rejected(lambda v: v["artifacts"]["relayer"].__setitem__("sha256", "0" * 64))
        self.rejected(lambda v: v["artifacts"]["relayer"].__setitem__("bytes", 10000))
        pathlib.Path(self.value["artifacts"]["relayer"]["path"]).chmod(0o600)
        with self.assertRaises(ValueError):
            api.validate_manifest(self.value)

    def test_relative_absent_symlink_and_parent_artifacts(self):
        self.rejected(lambda v: v["artifacts"]["relayer"].__setitem__("path", "relative"))
        self.rejected(lambda v: v["artifacts"]["relayer"].__setitem__("path", str(self.root / "missing")))
        link = self.root / "link"
        link.symlink_to(self.value["artifacts"]["relayer"]["path"])
        self.rejected(lambda v: v["artifacts"]["relayer"].__setitem__("path", str(link)))
        self.rejected(lambda v: v["artifacts"]["relayer"].__setitem__("path", str(self.root / "a" / ".." / "relayer")))

    def test_alias_conflicts_and_unknown_environment(self):
        for key in api.ALIASES:
            self.rejected(lambda v: v["environment"].__setitem__(key, "/wrong"))
        self.rejected(lambda v: v["environment"].__setitem__("AWS_SECRET_ACCESS_KEY", "forbidden"))

    def test_duplicate_artifact_and_unknown_manifest_keys(self):
        self.rejected(lambda v: v["artifacts"].__setitem__("validator", v["artifacts"]["relayer"]))
        self.rejected(lambda v: v.__setitem__("pretend_passed", True))

    def test_schema_and_scenario_are_strict(self):
        self.rejected(lambda v: v.__setitem__("schema", True))
        self.rejected(lambda v: v.__setitem__("scenario", "mainnet"))

    def test_deadline_mode_and_commit(self):
        self.rejected(lambda v: v.__setitem__("harness_deadline_seconds", 600))
        self.rejected(lambda v: v.__setitem__("harness_deadline_seconds", True))
        self.rejected(lambda v: v.__setitem__("mode", "Debug"))
        self.rejected(lambda v: v.__setitem__("runtime_source_commit", "HEAD"))

    def test_evidence_and_tools_cannot_escape_owned_root(self):
        self.rejected(lambda v: v["verifier"].__setitem__("evidence_root", str(self.root.parent)))
        self.rejected(lambda v: v["verifier"].__setitem__("evidence_root", str(self.root / ".." / "escape")))
        self.rejected(lambda v: v["tool_overrides"].__setitem__("UNREVIEWED_TOOL", v["artifacts"]["relayer"]))

    def test_all_eight_scenarios_preserve_actual_production_time(self):
        for name in api.SCENARIOS:
            with self.subTest(name=name):
                value = copy.deepcopy(self.value)
                value["scenario"] = name
                plan = api.construction_plan(value, name)
                self.assertEqual(plan["actual_production_confirm_seconds"], 600)
                self.assertEqual(plan["actual_production_finality_grace_seconds"], 30)
                self.assertTrue(plan["init_db_is_separate_existing_rust_helper"])
                self.assertFalse(plan["passed"])
                self.assertFalse(plan["execution_authorized_by_preparation"])

    def test_local_endpoint_boundary(self):
        for url in ["http://localhost:1234", "http://127.0.0.1:1", "ws://[::1]:2"]:
            self.assertEqual(api.local_endpoint(url), url)
        for url in ["https://mainnet.example", "http://127.0.0.1.evil.example", "file:///etc/passwd", "http://user:secret@localhost:5"]:
            with self.assertRaises(ValueError):
                api.local_endpoint(url)

    def test_external_node_preflight_blocks_until_family_and_capacity_ready(self):
        with mock.patch.dict(api.FAMILY_VERIFIERS):
            api.FAMILY_VERIFIERS.pop(self.value["scenario"], None)
            with self.assertRaisesRegex(ValueError, "no node may start"):
                api.verify_stage(self.value, "preflight", 0)

    def test_missing_or_self_reported_evidence_never_passes(self):
        with mock.patch.dict(api.FAMILY_VERIFIERS):
            api.FAMILY_VERIFIERS.pop(self.value["scenario"], None)
            with self.assertRaises(ValueError):
                api.verify_stage(self.value, "live", 1)
            root = pathlib.Path(self.value["verifier"]["evidence_root"])
            root.mkdir()
            (root / "live.json").write_text(json.dumps({"passed": True, "scenario": "evm", "runtime_source_commit": self.value["runtime_source_commit"]}))
            with self.assertRaisesRegex(ValueError, "not implemented/reviewed"):
                api.verify_stage(self.value, "live", 1)

    def test_owned_component_symlinks_cannot_write_outside(self):
        with tempfile.TemporaryDirectory(prefix="ziggy-outside-negative-") as other:
            outside = pathlib.Path(other).resolve()
            for name in ["databases", "agent-logs", "sealevel-checkpoints", "composite-checkpoints", "evidence"]:
                with self.subTest(name=name):
                    link = self.root / name
                    link.symlink_to(outside, target_is_directory=True)
                    with self.assertRaises(ValueError):
                        api.validate_manifest(self.value)
                    with self.assertRaises(ValueError):
                        api.create_owned_directory(self.root, pathlib.Path(name) / "new-leaf")
                    self.assertEqual(list(outside.iterdir()), [])
                    link.unlink()
            (self.root / "databases").mkdir()
            (self.root / "databases" / "retained").symlink_to(outside, target_is_directory=True)
            with self.assertRaises(ValueError):
                api.create_owned_directory(self.root, "databases/retained")
            self.assertEqual(list(outside.iterdir()), [])

    def test_evidence_file_symlink_rejected_before_open(self):
        evidence = api.create_owned_directory(self.root, "evidence")
        outside = self.root / "outside-record"
        outside.write_text("unchanged")
        (evidence / "live.json").symlink_to(outside)
        with self.assertRaises(ValueError):
            api.checked_owned_path(self.root, "evidence/live.json")
        self.assertEqual(outside.read_text(), "unchanged")

    def test_existing_log_and_db_internal_symlinks_rejected(self):
        with tempfile.TemporaryDirectory(prefix="ziggy-outside-leaf-") as other:
            outside = pathlib.Path(other).resolve()
            marker = outside / "marker"
            marker.write_text("unchanged")
            for parent, leaf in [("agent-logs", "RLY-output.log"), ("databases/retained", "CURRENT")]:
                path = api.create_owned_directory(self.root, parent)
                link = path / leaf
                link.symlink_to(marker)
                with self.assertRaises(ValueError):
                    api.validate_manifest(self.value)
                with self.assertRaises(ValueError):
                    api.create_owned_directory(self.root, parent)
                self.assertEqual(marker.read_text(), "unchanged")
                link.unlink()

    def test_owned_restart_preserves_existing_bytes(self):
        path = api.create_owned_directory(self.root, "databases/retained")
        marker = path / "marker"
        marker.write_bytes(b"durable state")
        self.assertEqual(path, api.create_owned_directory(self.root, "databases/retained"))
        self.assertEqual(marker.read_bytes(), b"durable state")

    def test_resource_name_has_task_identity_and_pid(self):
        first = api.resource_name(self.value, "radix", 42)
        self.assertEqual(first, api.resource_name(self.value, "radix", 42))
        with tempfile.TemporaryDirectory(prefix="ziggy-another-task-") as other:
            changed = copy.deepcopy(self.value)
            changed["task_root"] = str(pathlib.Path(other).resolve())
            self.assertNotEqual(first, api.resource_name(changed, "radix", 42))
        self.assertIn("-42-radix", first)

    def test_nonexecutable_pinned_tool_rejected_at_preflight(self):
        tool = copy.deepcopy(self.value["verifier"]["python"])
        pathlib.Path(tool["path"]).chmod(0o600)
        self.value["tool_overrides"]["E2E_HYPD_PATH"] = tool
        with self.assertRaisesRegex(ValueError, "executable"):
            api.validate_manifest(self.value)

    def test_execution_approval_requires_every_import_module_and_actual_mode_product_closure(self):
        value = copy.deepcopy(self.value)
        def descriptor(path):
            path = pathlib.Path(path).resolve()
            return {"path": str(path), "bytes": path.stat().st_size, "sha256": evidence.sha(path)}
        def write(name, record):
            path = self.root / name
            path.write_text(json.dumps(record))
            return descriptor(path)
        docker = {"host": "unix:///public-fixture/docker.sock", "config_dir": str(self.root / "docker-config")}
        value["case_inputs"] = write("case-inputs.json", {"schema": 1, "scenario": "evm", "chain_names": ["test1"], "local_docker": docker})
        modules = {name: descriptor(HERE / name) for name in evidence.import_module_closure(value["scenario"])}
        value["verifier"]["script"] = modules["multivm_process.py"]
        build = write("actual-build-summary-fixture.json", {"source_commit": value["runtime_source_commit"], "mode": value["mode"], "passed": True, "source_unchanged": True, "runtime_artifacts": value["artifacts"]})
        gate = write("actual-gate-summary-fixture.json", {"source_commit": value["runtime_source_commit"], "source_unchanged": True, "checks": [{"exit_code": 0}]})
        interop = write("actual-native-reader-interop-fixture.json", {"accepted_component_source_and_actual_Zig_storage_interop": True, "family_chain_SDK_finality_delivery_elapsed600_acceptance": False, "reader": value["verifier_tools"]["native_rows"], "modes": {name: {"actual_writer_parent_wait_exit": 0, "actual_db_files_rehashed": 10} for name in ("safe", "fast")}, "source_sha256": {str(self.root / "relayer"): evidence.sha(self.root / "relayer")}})
        approval = {"schema": 1, "root_approved": True, "scenario": value["scenario"], "runtime_source_commit": value["runtime_source_commit"], "mode": value["mode"], "runtime_artifacts": value["artifacts"], "verifier_tools": value["verifier_tools"], "verifier_python": value["verifier"]["python"], "case_inputs": value["case_inputs"], "python_modules": modules, "accepted_runtime_build": build, "harness": value["artifacts"]["init-db"], "native_reader_interoperability": interop, "source_gates": [gate], "capacity": {"reviewed": True, "minimum_free_bytes": 1}, "confirm_seconds": 600, "finality_grace_seconds": 30}
        approval["local_docker"] = docker
        def check(record):
            value["execution_approval"] = write("approval-fixture.json", record)
            with mock.patch.dict(evidence.os.environ, {"DOCKER_HOST": docker["host"], "DOCKER_CONFIG": docker["config_dir"]}, clear=True):
                return evidence.read_approval(value)
        self.assertIs(check(approval)["root_approved"], True)
        # A consumer-only commit must not relabel the tested runtime as rebuilt.
        execution_commit = "c" * 40
        comparison = self.root / "compiled-comparison.log"
        comparison.write_text("public tracked input comparison completed\n")
        closure = {"schema": 1, "runtime_source_commit": value["runtime_source_commit"], "helper_source_commit": value["runtime_source_commit"], "tools_source_commit": value["runtime_source_commit"], "execution_source_commit": execution_commit, "source_unchanged": True, "native_case_acceptance": False, "scopes": {category: [{"path": name, "producer_tree": None if name.endswith(".zon") else "d" * 40, "current_tree": None if name.endswith(".zon") else "d" * 40, "worktree_unchanged": True} for name in names] for category, names in evidence.COMPILED_INPUT_SCOPES.items()}, "checks": [{"exit_code": 0, "log": descriptor(comparison)}]}
        cross_source = copy.deepcopy(approval)
        cross_source["execution_source_commit"] = execution_commit
        cross_source["compiled_input_closure"] = write("compiled-input-closure.json", closure)
        with self.assertRaisesRegex(ValueError, "execution source gate missing"):
            check(cross_source)
        cross_source["source_gates"] = [gate, write("actual-consumer-gate.json", {"source_commit": execution_commit, "source_unchanged": True, "checks": [{"exit_code": 0}]})]
        self.assertEqual(check(cross_source)["runtime_source_commit"], value["runtime_source_commit"])
        cross_source.pop("compiled_input_closure")
        with self.assertRaisesRegex(ValueError, "requires compiled input closure"):
            check(cross_source)
        for name in evidence.MODULE_NAMES:
            changed = copy.deepcopy(approval)
            changed["python_modules"].pop(name)
            with self.assertRaisesRegex(ValueError, "complete verifier"):
                check(changed)
        for key, bad in [("root_approved", 1), ("mode", "ReleaseFast"), ("runtime_source_commit", "b" * 40), ("confirm_seconds", 60)]:
            changed = copy.deepcopy(approval)
            changed[key] = bad
            with self.assertRaises(ValueError):
                check(changed)
        changed = copy.deepcopy(approval)
        changed["runtime_artifacts"]["worker"] = value["artifacts"]["relayer"]
        with self.assertRaisesRegex(ValueError, "artifact closure"):
            check(changed)
        changed = copy.deepcopy(approval)
        changed["accepted_runtime_build"] = write("wrong-mode-build.json", {"source_commit": value["runtime_source_commit"], "mode": "ReleaseFast", "passed": True, "source_unchanged": True, "runtime_artifacts": value["artifacts"]})
        with self.assertRaisesRegex(ValueError, "build identity"):
            check(changed)
        changed = copy.deepcopy(approval)
        changed["source_gates"] = [write("failed-gate.json", {"source_commit": value["runtime_source_commit"], "source_unchanged": True, "checks": [{"exit_code": 1}]})]
        with self.assertRaisesRegex(ValueError, "source gate failed"):
            check(changed)

    def test_evm_every_source_chain_requires_reviewed_public_payer(self):
        names = ["test1", "test2", "test3"]
        case = {"schema": 1, "scenario": "evm", "chain_names": names, "domain_names": {str(9913371 + i): name for i, name in enumerate(names)}, "initial_corpus": {"dispatches": 3, "deliveries": 3, "zero_insertions": 0, "failed_body": 0, "double_insertions": 0}, "payments_supported": True, "additional_refused_dispatches": 1, "validator_addresses": {name: "0x" + "11" * 20 for name in names}, "relayer_addresses": {name: "0x" + bytes([i + 1] * 20).hex() for i, name in enumerate(names)}, "reorg_origin_chain": "test1"}
        from multivm_session import validate_evm_case
        validate_evm_case(self.value, case)
        for mutate in [lambda row: row.pop("relayer_addresses"), lambda row: row["relayer_addresses"].pop("test3"), lambda row: row["relayer_addresses"].update(test2="not-an-address")]:
            changed = copy.deepcopy(case)
            mutate(changed)
            with self.subTest(mutation=mutate), self.assertRaises(ValueError):
                validate_evm_case(self.value, changed)

    def starknet_case(self):
        self.value["scenario"] = "starknet"
        case = {"chain_names": ["starknet1", "starknet2"], "local_docker": {"host": "unix:///public-fixture/docker.sock", "config_dir": str(self.root / "docker-config")}, "evidence_nodes": {}}
        for index, chain in enumerate(case["chain_names"]):
            port = 5050 + index * 20
            case["evidence_nodes"][chain] = {"effective_field": "rpcurls", "configured_ordinal": 2, "original_url": f"http://0.0.0.0:{port}", "connect_url": f"http://127.0.0.1:{port}", "rewrite": "source-wildcard-to-loopback", "source_container_suffix": f"starknet-{port}", "host_port": port, "container_port": 5050, "source_image": "shardlabs/starknet-devnet-rs:0.4.2", "image_id": "sha256:" + "1" * 64, "command": ["--state-archive-capacity", "full", "--block-generation-on", "5", "--seed", "0"]}
        return case

    def test_source_owned_direct_endpoint_preserves_dead_slots_and_wildcard_authority(self):
        case = self.starknet_case()
        nodes = evidence.validate_evidence_nodes(self.value, case)
        node = nodes["starknet1"]
        chain = {"rpcurls": [{"http": url} for url in ["http://127.0.0.1:1337", "http://127.0.0.1:1338", node["original_url"], "http://127.0.0.1:1347"]]}
        self.assertEqual(evidence.selected_evidence_node(chain, node), node["connect_url"])
        before = copy.deepcopy(chain)
        self.assertEqual([evidence.source_connect_url(url, node) for url in evidence.urls(chain["rpcurls"])], ["http://127.0.0.1:1337", "http://127.0.0.1:1338", node["connect_url"], "http://127.0.0.1:1347"])
        self.assertEqual(chain, before)
        for key, value in [("configured_ordinal", 0), ("connect_url", "http://127.0.0.1:5051"), ("source_image", "other"), ("rewrite", "identity")]:
            changed = copy.deepcopy(case)
            changed["evidence_nodes"]["starknet1"][key] = value
            with self.assertRaises(ValueError):
                evidence.validate_evidence_nodes(self.value, changed)
        chain["customrpcurls"] = "http://127.0.0.1:1234"
        with self.assertRaises(ValueError):
            evidence.selected_evidence_node(chain, node)
        with self.assertRaises(ValueError):
            evidence.source_connect_url("http://0.0.0.0:5050")

    def test_actual_starknet_layering_captures_all_four_source_peers_without_chainid_injection(self):
        case = self.starknet_case()
        source = {}
        for name, node in case["evidence_nodes"].items():
            source[name] = {"name": name, "protocol": "starknet", "rpcUrls": [{"http": url} for url in ["http://127.0.0.1:1337", "http://127.0.0.1:1338", node["original_url"], "http://127.0.0.1:1347"]]}
        config = self.root / "config"
        config.mkdir()
        (config / "source.json").write_text(json.dumps({"chains": source, "relayChains": ",".join(case["chain_names"])}))
        casepath = pathlib.Path(self.value["case_inputs"]["path"])
        casepath.write_text(json.dumps(case))
        self.value["case_inputs"].update(bytes=casepath.stat().st_size, sha256=evidence.sha(casepath))
        request = {"schema": 1, "scenario": "starknet", "runtime_source_commit": self.value["runtime_source_commit"], "role": "relayer", "harness_pid": 42, "cwd": str(self.root), "environment": {}, "arguments": [], "selected_chain_names": case["chain_names"]}
        captured = evidence.effective_config(request, self.value)
        replacements = {(name, "rpcurls"): [f"http://127.0.0.1:{20000 + i * 4 + j}" for j in range(4)] for i, name in enumerate(case["chain_names"])}
        env, proxied = evidence.endpoint_replacements(captured, replacements)
        self.assertEqual(len(env), 8)
        for name, node in case["evidence_nodes"].items():
            self.assertEqual(evidence.urls(captured["chains"][name]["rpcurls"])[2], node["original_url"])
            self.assertEqual(evidence.urls(proxied["chains"][name]["rpcurls"]), replacements[name, "rpcurls"])
            self.assertNotIn("chainid", captured["chains"][name])
        source[case["chain_names"][0]]["rpcUrls"][0]["http"] = "http://0.0.0.0:1337"
        (config / "source.json").write_text(json.dumps({"chains": source, "relayChains": ",".join(case["chain_names"])}))
        with self.assertRaisesRegex(ValueError, "unreviewed Source wildcard"):
            evidence.effective_config(request, self.value)

    def test_exact_owned_container_cannot_be_old_foreign_image_or_replaced(self):
        case = self.starknet_case()
        node = case["evidence_nodes"]["starknet1"]
        name = evidence.owned_devnet_name(self.root, 42, node["source_container_suffix"])
        row = {"Name": "/" + name, "Id": "a" * 64, "State": {"Running": True}, "Image": node["image_id"], "Config": {"Image": node["source_image"], "Cmd": node["command"]}, "Created": "2026-11-06T00:00:00Z", "NetworkSettings": {"Ports": {"5050/tcp": [{"HostPort": "5050", "HostIp": "0.0.0.0"}]}}}
        self.assertEqual(evidence.verify_devnet_inspect(row, node, name, 1), row)
        for key, value in [("Name", "/foreign"), ("Image", "sha256:" + "2" * 64), ("Created", "1970-01-01T00:00:00Z"), ("State", {"Running": False})]:
            changed = copy.deepcopy(row)
            changed[key] = value
            with self.assertRaises(ValueError):
                evidence.verify_devnet_inspect(changed, node, name, 1)
        changed = dict(row, Id="b" * 64)
        with self.assertRaises(ValueError):
            evidence.verify_devnet_inspect(changed, node, name, 1, row)
        with tempfile.TemporaryDirectory() as other:
            self.assertNotEqual(name, evidence.owned_devnet_name(other, 42, node["source_container_suffix"]))

    def test_external_devnet_immutable_image_requires_explicit_approved_identity(self):
        node = self.starknet_case()["evidence_nodes"]["starknet1"]
        name = evidence.owned_devnet_name(self.root, 42, node["source_container_suffix"])
        labels = {"io.hyperlane.ziggy.case-root": "a" * 64, "io.hyperlane.ziggy.harness-pid": "42", "io.hyperlane.ziggy.run-token": "b" * 32}
        row = {"Name": "/" + name, "Id": "c" * 64, "State": {"Running": True}, "Image": node["image_id"], "Config": {"Image": node["image_id"], "Labels": labels, "Cmd": node["command"]}, "Created": "2026-11-06T00:00:00Z", "NetworkSettings": {"Ports": {"5050/tcp": [{"HostPort": "5050", "HostIp": "127.0.0.1"}]}}, "HostConfig": {"Memory": 2 * 1024**3, "MemorySwap": 2 * 1024**3, "NanoCpus": 2_000_000_000, "PidsLimit": 256, "PortBindings": {"5050/tcp": [{"HostPort": "5050", "HostIp": "127.0.0.1"}]}}}
        with self.assertRaises(ValueError):
            evidence.verify_devnet_inspect(row, node, name, 1)
        self.assertEqual(evidence.verify_devnet_inspect(row, node, name, 1, approved_image_id=node["image_id"], approved_labels=labels), row)
        for mutate in [lambda value: value["Config"].update(Image="foreign"), lambda value: value["Config"]["Labels"].update({"io.hyperlane.ziggy.run-token": "c" * 32}), lambda value: value["HostConfig"].update(MemorySwap=0), lambda value: value["NetworkSettings"]["Ports"]["5050/tcp"][0].update(HostIp="0.0.0.0")]:
            changed = copy.deepcopy(row)
            mutate(changed)
            with self.assertRaises(ValueError):
                evidence.verify_devnet_inspect(changed, node, name, 1, approved_image_id=node["image_id"], approved_labels=labels)
        with self.assertRaises(ValueError):
            evidence.verify_devnet_inspect(row, node, name, 1, approved_image_id="sha256:" + "f" * 64, approved_labels=labels)

    def test_direct_session_selects_only_bound_peer_and_family_tool_has_closed_name(self):
        session = Session.__new__(Session)
        session.evidence_nodes = self.starknet_case()["evidence_nodes"]
        node = session.evidence_nodes["starknet1"]
        session.devnets = {"starknet1": {"inspect": {"Id": "a" * 64}}}
        session.append = mock.Mock()
        session.chain_config = lambda _: {"rpcurls": [{"http": "http://127.0.0.1:1337"}, {"http": "http://127.0.0.1:1338"}, {"http": node["original_url"]}]}
        with mock.patch.object(session, "verify_devnet") as owned, mock.patch("multivm_session.direct_rpc", return_value={"chain": "actual"}) as rpc:
            self.assertEqual(session.rpc("starknet1", "starknet_chainId", []), {"chain": "actual"})
            owned.assert_called_once_with("starknet1")
            rpc.assert_called_once_with(node["connect_url"], "starknet_chainId", [])
        session.manifest = {"scenario": "radix"}
        session.case = {"family_tools": {"radix_reference": self.value["artifacts"]["init-db"]}}
        with mock.patch("multivm_session.run_artifact", return_value="actual") as tool:
            self.assertEqual(session.family_tool("radix_reference", ["evidence"], stdin="{}"), "actual")
            tool.assert_called_once()
            for name, args in [("other", ["evidence"]), ("radix_reference", ["shell"])]:
                with self.assertRaises(ValueError):
                    session.family_tool(name, args)

    def test_devnet_preflight_records_successful_absence_before_inspect_and_rejects_existing(self):
        session = Session.__new__(Session)
        session.manifest = self.value
        session.approval = {}
        session.evidence_nodes = self.starknet_case()["evidence_nodes"]
        session.harness_parent = None
        session.devnets = {}
        session.append = mock.Mock()
        identity = {"pid": 42, "os_start_token": "actual pinned ps", "executable": self.value["artifacts"]["init-db"]}
        with mock.patch("multivm_session.verified_harness_identity", return_value=identity), mock.patch.object(session, "docker", return_value="") as docker:
            session.prepare_devnets(identity)
            self.assertEqual(docker.call_count, 2)
            for call in docker.call_args_list:
                self.assertEqual(call.args[0][:4], ["container", "ls", "--all", "--no-trunc"])
                self.assertIn("name=^/ziggy-e2e-", call.args[0][5])
            session.prepare_devnets(identity)
            self.assertEqual(docker.call_count, 2)
        session.harness_parent = None
        with mock.patch("multivm_session.verified_harness_identity", return_value=identity), mock.patch.object(session, "docker", return_value="a" * 64), self.assertRaisesRegex(ValueError, "already exists"):
            session.prepare_devnets(identity)
        session.harness_parent = None
        with mock.patch.object(session, "docker") as docker, self.assertRaisesRegex(ValueError, "ownership receipt"):
            session.verify_devnet("starknet1")
        docker.assert_not_called()

    def test_radix_component_must_be_accepted_and_actual_source_and_logs_pinned(self):
        self.value["scenario"] = "radix"
        tool = self.value["artifacts"]["init-db"]
        case = {"family_tools": {"radix_reference": tool}}
        with self.assertRaises(ValueError):
            evidence.verify_family_tools(self.value, {}, {})
        record = {"root_approved": True, "accepted_reference_component": True, "tool": tool, "source_sha256": {"zig/integration/multivm_evidence.py": evidence.sha(HERE / "multivm_evidence.py")}, "checks": [{"exit_code": 0, "log": self.value["case_inputs"]}]}
        path = self.root / "reference-acceptance.json"
        def approval(value):
            path.write_text(json.dumps(value))
            return {"family_tools": case["family_tools"], "family_tool_acceptance": {"radix_reference": {"path": str(path), "bytes": path.stat().st_size, "sha256": evidence.sha(path)}}}
        evidence.verify_family_tools(self.value, case, approval(record))
        for key, value in [("root_approved", 1), ("tool", self.value["artifacts"]["relayer"]), ("source_sha256", {"../escape": "a" * 64}), ("checks", [{"exit_code": 1}])]:
            changed = dict(record)
            changed[key] = value
            with self.assertRaises((ValueError, FileNotFoundError)):
                evidence.verify_family_tools(self.value, case, approval(changed))


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="ziggy-evidence-pure-")
        self.addCleanup(self.directory.cleanup)
        self.root = pathlib.Path(self.directory.name)
        (self.root / "config").mkdir()
        self.chain = {"name": "test1", "protocol": "ethereum", "domainId": 1, "mailbox": "0x" + "11" * 20, "merkleTreeHook": "0x" + "22" * 20, "interchainGasPaymaster": "0x" + "33" * 20, "rpcUrls": [{"http": "http://127.0.0.1:8545"}, {"http": "http://localhost:8546"}]}
        self.file = self.root / "config" / "test.json"
        self.file.write_text(json.dumps({"chains": {"test1": self.chain}, "relayChains": "test1"}))
        self.case = self.root / "case.json"
        self.case.write_text(json.dumps({"schema": 1, "scenario": "evm", "chain_names": ["test1"]}))
        self.manifest = {"scenario": "evm", "runtime_source_commit": "a" * 40, "case_inputs": {"path": str(self.case), "bytes": self.case.stat().st_size, "sha256": evidence.sha(self.case)}}
        self.request = {"schema": 1, "scenario": "evm", "runtime_source_commit": "a" * 40, "role": "relayer", "harness_pid": 42, "cwd": str(self.root), "environment": {}, "arguments": [], "selected_chain_names": ["test1"]}

    def test_effective_endpoint_capture_preserves_both_default_and_custom_fallbacks(self):
        self.request["environment"]["HYP_CHAINS_TEST1_CUSTOMRPCURLS"] = "http://127.0.0.1:8547,http://127.0.0.1:8548"
        captured = evidence.effective_config(self.request, self.manifest)
        replacements = {("test1", "rpcurls"): ["http://127.0.0.1:9001", "http://127.0.0.1:9002"], ("test1", "customrpcurls"): ["http://127.0.0.1:9003", "http://127.0.0.1:9004"]}
        env, proxied = evidence.endpoint_replacements(captured, replacements)
        self.assertEqual(len(env), 3)
        self.assertEqual(env["HYP_CHAINS_TEST1_CUSTOMRPCURLS"], "http://127.0.0.1:9003,http://127.0.0.1:9004")
        self.assertEqual(proxied["chains"]["test1"]["mailbox"], captured["chains"]["test1"]["mailbox"])
        with self.assertRaisesRegex(ValueError, "every original"):
            evidence.endpoint_replacements(captured, {("test1", "rpcurls"): replacements[("test1", "rpcurls")]})
        replacements[("test1", "rpcurls")].pop()
        with self.assertRaisesRegex(ValueError, "fallback count"):
            evidence.endpoint_replacements(captured, replacements)

    def test_base_endpoint_indexed_environment_roundtrips_every_consumed_field(self):
        self.chain["rpcUrls"][0]["public"] = True
        self.chain["rpcUrls"][1]["public"] = False
        self.chain["grpcUrls"] = [{"http": "http://127.0.0.1:9090", "public": False}]
        self.file.write_text(json.dumps({"chains": {"test1": self.chain}, "relayChains": "test1"}))
        captured = evidence.effective_config(self.request, self.manifest)
        replacements = {("test1", "rpcurls"): ["http://127.0.0.1:19001", "http://127.0.0.1:19002"], ("test1", "grpcurls"): ["http://127.0.0.1:19003"]}
        env, proxied = evidence.endpoint_replacements(captured, replacements)
        self.assertEqual(env, {"HYP_CHAINS_TEST1_RPCURLS_0_HTTP": "http://127.0.0.1:19001", "HYP_CHAINS_TEST1_RPCURLS_0_PUBLIC": "true", "HYP_CHAINS_TEST1_RPCURLS_1_HTTP": "http://127.0.0.1:19002", "HYP_CHAINS_TEST1_RPCURLS_1_PUBLIC": "false", "HYP_CHAINS_TEST1_GRPCURLS_0_HTTP": "http://127.0.0.1:19003", "HYP_CHAINS_TEST1_GRPCURLS_0_PUBLIC": "false"})
        replay = copy.deepcopy(self.request)
        replay["environment"] = env
        actual = evidence.effective_config(replay, self.manifest)
        self.assertEqual(actual["chains"], proxied["chains"])

    def test_base_public_boolean_strings_normalize_without_truthiness_coercion(self):
        for flag in ["false", "FALSE", False, "true", "TRUE", True]:
            self.chain["rpcUrls"][0]["public"] = flag
            self.file.write_text(json.dumps({"chains": {"test1": self.chain}, "relayChains": "test1"}))
            captured = evidence.effective_config(self.request, self.manifest)
            env, proxied = evidence.endpoint_replacements(captured, {("test1", "rpcurls"): ["http://127.0.0.1:19001", "http://127.0.0.1:19002"]})
            expected = flag is True or isinstance(flag, str) and flag.lower() == "true"
            self.assertIs(proxied["chains"]["test1"]["rpcurls"][0]["public"], expected)
            self.assertEqual(env["HYP_CHAINS_TEST1_RPCURLS_0_PUBLIC"], "true" if expected else "false")
        for flag in [1, 0, None, [], "0", " false "]:
            self.chain["rpcUrls"][0]["public"] = flag
            self.file.write_text(json.dumps({"chains": {"test1": self.chain}, "relayChains": "test1"}))
            with self.subTest(flag=flag), self.assertRaises(ValueError):
                evidence.effective_config(self.request, self.manifest)

    def test_native_base_endpoint_arrays_reject_json_string_and_sparse_index_tables(self):
        for environment in [{"HYP_CHAINS_TEST1_RPCURLS": json.dumps(self.chain["rpcUrls"])}, {"HYP_CHAINS_TEST1_RPCURLS_0_HTTP": "http://127.0.0.1:1", "HYP_CHAINS_TEST1_RPCURLS_2_HTTP": "http://127.0.0.1:3"}, {"HYP_CHAINS_TEST1_RPCURLS_0_HTTP": "http://127.0.0.1:1", "HYP_CHAINS_TEST1_RPCURLS_0_PUBLIC": "0"}]:
            request = copy.deepcopy(self.request)
            request["environment"] = environment
            with self.subTest(environment=environment), self.assertRaises(ValueError):
                evidence.effective_config(request, self.manifest)

    def test_cosmosnative_source_two_chain_rpc_grpc_indexed_roundtrip(self):
        names = ["cosmostestnative1", "cosmostestnative2"]
        chains = {name: dict(self.chain, name=name, protocol="cosmosnative", domainId=75898670 + index, rpcUrls=[{"http": f"http://127.0.0.1:{26659 + index * 6}"}], grpcUrls=[{"http": f"http://127.0.0.1:{26660 + index * 6}"}]) for index, name in enumerate(names)}
        self.file.write_text(json.dumps({"chains": chains, "relayChains": ",".join(names)}))
        self.case.write_text(json.dumps({"schema": 1, "scenario": "cosmosnative", "chain_names": names}))
        self.manifest.update(scenario="cosmosnative", case_inputs={"path": str(self.case), "bytes": self.case.stat().st_size, "sha256": evidence.sha(self.case)})
        self.request.update(scenario="cosmosnative", selected_chain_names=names)
        captured = evidence.effective_config(self.request, self.manifest)
        replacements = {(name, field): [f"http://127.0.0.1:{19000 + index * 2 + (field == 'grpcurls')}"] for index, name in enumerate(names) for field in ["rpcurls", "grpcurls"]}
        env, proxied = evidence.endpoint_replacements(captured, replacements)
        self.assertEqual(len(env), 4)
        self.assertTrue(all(key.endswith("_0_HTTP") for key in env))
        replay = copy.deepcopy(self.request)
        replay["environment"] = env
        self.assertEqual(evidence.effective_config(replay, self.manifest)["chains"], proxied["chains"])

    def test_custom_gateway_urls_keep_source_override_and_all_original_fallbacks(self):
        self.manifest["scenario"] = self.request["scenario"] = "radix"
        self.chain.update(protocol="radix", gatewayUrls=[{"http": "http://127.0.0.1:8010"}], customGatewayUrls="http://127.0.0.1:8020,http://127.0.0.1:8021")
        self.file.write_text(json.dumps({"chains": {"test1": self.chain}, "relayChains": "test1"}))
        captured = evidence.effective_config(self.request, self.manifest)
        pairs = {("test1", field): [f"http://127.0.0.1:{21000 + ordinal * 10 + index}" for index, _ in enumerate(evidence.urls(value))] for ordinal, (field, value) in enumerate(captured["chains"]["test1"].items()) if field in evidence.ENDPOINT_FIELDS}
        env, proxied = evidence.endpoint_replacements(captured, pairs)
        self.assertEqual(len(evidence.urls(proxied["chains"]["test1"]["customgatewayurls"])), 2)
        self.assertIn("HYP_CHAINS_TEST1_CUSTOMGATEWAYURLS", env)
        with self.assertRaisesRegex(ValueError, "every original"):
            evidence.endpoint_replacements(captured, {key: value for key, value in pairs.items() if key[1] != "customgatewayurls"})
        self.chain["customGatewayUrls"] = "http://public.example:8020"
        self.file.write_text(json.dumps({"chains": {"test1": self.chain}, "relayChains": "test1"}))
        with self.assertRaises(ValueError):
            evidence.effective_config(self.request, self.manifest)

    def test_effective_config_file_env_argument_precedence_and_public_capture(self):
        override = self.root / "override.json"
        override.write_text(json.dumps({"chains": {"test1": {"customRpcUrls": "http://127.0.0.1:8549", "signer": {"key": "public-test-key-must-not-be-recorded"}}}}))
        self.request["environment"] = {"CONFIG_FILES": str(override), "HYP_METRICSPORT": "9000"}
        self.request["arguments"] = ["--metricsPort", "9001"]
        result = evidence.effective_config(self.request, self.manifest)
        self.assertEqual(result["metrics_port"], 9001)
        self.assertEqual(result["chains"]["test1"]["customrpcurls"], "http://127.0.0.1:8549")
        self.assertNotIn("public-test-key-must-not-be-recorded", json.dumps(result))
        self.assertEqual(len(result["config_sources"]), 2)

    def test_actual_source_testnet_explorer_metadata_is_inert_but_unknown_url_authority_rejects(self):
        source = json.loads((HERE.parents[1] / "rust/main/config/testnet_config.json").read_text())
        names = ["test1", "test2", "test3"]
        self.file.write_text(json.dumps({"chains": {name: source["chains"][name] for name in names}, "relayChains": ",".join(names)}))
        self.case.write_text(json.dumps({"schema": 1, "scenario": "evm", "chain_names": names}))
        self.manifest["case_inputs"].update(bytes=self.case.stat().st_size, sha256=evidence.sha(self.case))
        self.request["selected_chain_names"] = names
        captured = evidence.effective_config(self.request, self.manifest)
        self.assertEqual([captured["chains"][name]["blocks"]["reorgperiod"] for name in names], [0, 1, 2])
        for name in names:
            explorer = captured["chains"][name]["blockexplorers"][0]
            self.assertEqual(explorer["url"], "https://etherscan.io")
            self.assertEqual(explorer["apikey"], {"redacted_config_sha256": hashlib.sha256(b"fakekey").hexdigest()})
            self.assertEqual(evidence.urls(captured["chains"][name]["rpcurls"]), ["http://127.0.0.1:8545"])
        source["chains"]["test1"]["blockExplorers"][0]["rpcUrls"] = "http://remote.example:1"
        self.file.write_text(json.dumps({"chains": {name: source["chains"][name] for name in names}, "relayChains": ",".join(names)}))
        with self.assertRaisesRegex(ValueError, "explorer metadata shape"):
            evidence.effective_config(self.request, self.manifest)

    def test_cli_endpoint_ws_remote_nested_or_extra_selected_chain_bypass_rejected(self):
        original = copy.deepcopy(self.request)
        for arguments, environment in [(["--chains.test1.customRpcUrls", "http://127.0.0.1:4"], {}), ([], {"HYP_CHAINS_TEST1_CUSTOMRPCURLS": "ws://localhost:4"}), ([], {"HYP_CHAINS_TEST1_CUSTOMRPCURLS": "http://mainnet.example:4"}), ([], {"HYP_CHAINS_TEST1_CONNECTION_WEBSOCKETURL": "http://localhost:4"}), ([], {"HYP_RELAYCHAINS": "test1,test2"})]:
            self.request = copy.deepcopy(original)
            self.request["arguments"], self.request["environment"] = arguments, environment
            with self.subTest(arguments=arguments, environment=environment):
                with self.assertRaises(ValueError):
                    evidence.effective_config(self.request, self.manifest)

    def test_known_source_inert_connection_fields_preserved_without_becoming_endpoint_authority(self):
        self.request["environment"] = {"HYP_CHAINS_TEST1_CONNECTION_URLS": "http://127.0.0.1:8545,http://127.0.0.1:8545"}
        capture = evidence.effective_config(self.request, self.manifest)
        self.assertEqual(capture["inert_legacy_connection_fields"], {"chains.test1.connection.urls": self.request["environment"]["HYP_CHAINS_TEST1_CONNECTION_URLS"]})
        env, proxied = evidence.endpoint_replacements(capture, {("test1", "rpcurls"): ["http://127.0.0.1:9001", "http://127.0.0.1:9002"]})
        self.assertNotIn("HYP_CHAINS_TEST1_CONNECTION_URLS", env)
        self.assertEqual(proxied["chains"]["test1"]["connection"], capture["chains"]["test1"]["connection"])

    def test_endpoint_network_does_not_discover_ambient_proxy_credentials_or_retry(self):
        with mock.patch.dict("os.environ", {"HTTP_PROXY": "http://evil.example", "AWS_PROFILE": "production"}), mock.patch.object(evidence.http.client, "HTTPConnection") as connection:
            response = connection.return_value.getresponse.return_value
            response.status = 200
            response.read.return_value = b'{"result":true}'
            self.assertEqual(evidence.direct_request("http://localhost:8545", {}), {"result": True})
            connection.assert_called_once_with("127.0.0.1", 8545, timeout=20)
            connection.return_value.request.assert_called_once()
        for url in ["http://127.0.0.1.evil.example:8", "https://localhost:8", "http://user:secret@localhost:8", "http://localhost:8/?apikey=secret", "ws://localhost:8"]:
            with self.assertRaises(ValueError):
                evidence.direct_endpoint(url)

    def test_exact_wire_frame_preserves_headers_chunking_and_pipelining(self):
        first = b'HTTP/1.1 200 Public Fixture\r\nX-Public-Header: AbC\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{"a"\r\n3\r\n:1}\r\n0\r\n\r\n'
        second = b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}'
        parser = evidence.HttpFrames(response=True)
        frames = []
        for byte in first + second:
            frames.extend(parser.feed(bytes([byte])))
        self.assertEqual([f["wire"] for f in frames], [first, second])
        self.assertEqual(json.loads(frames[0]["body"]), {"a": 1})
        self.assertFalse(parser.buffer)

    def test_http_ambiguous_truncated_encoded_and_upgrade_cannot_hide_evidence(self):
        for raw in [b'HTTP/1.1 200 OK\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\nx', b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nx', b'HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 1\r\n\r\nx', b'HTTP/1.1 101 Switching Protocols\r\n\r\n', b'HTTP/1.1 200 OK\r\nContent-Length: 1\r\ncontent-length: 1\r\n\r\nx']:
            with self.subTest(raw=raw):
                with self.assertRaises(ValueError):
                    evidence.HttpFrames(response=True).feed(raw, eof=True)

    def test_dispatch_wire_identity_rejects_wrong_indexed_destination_and_padding(self):
        raw = bytes([3]) + (7).to_bytes(4, "big") + (1).to_bytes(4, "big") + b"\x00" * 12 + b"\x11" * 20 + (2).to_bytes(4, "big") + b"\x00" * 12 + b"\x22" * 20 + b"fixture"
        data = (32).to_bytes(32, "big") + len(raw).to_bytes(32, "big") + raw + b"\x00" * ((-len(raw)) % 32)
        topics = ["0x" + "aa" * 32, "0x" + (b"\x00" * 12 + b"\x11" * 20).hex(), "0x" + (2).to_bytes(32, "big").hex(), "0x" + (b"\x00" * 12 + b"\x22" * 20).hex()]
        log = {"topics": topics, "data": "0x" + data.hex()}
        result = evm.decode_dispatch(log, lambda value: "0x" + "bb" * 32)
        self.assertEqual((result["nonce"], result["origin"], result["destination"]), (7, 1, 2))
        changed = copy.deepcopy(log)
        changed["topics"][2] = "0x" + (3).to_bytes(32, "big").hex()
        with self.assertRaises(ValueError):
            evm.decode_dispatch(changed, lambda value: "0x" + "bb" * 32)
        log["data"] = log["data"][:-2] + "01"
        with self.assertRaises(ValueError):
            evm.decode_dispatch(log, lambda value: "0x" + "bb" * 32)

    def test_canonical_native_receipt_requires_number_membership_status_identity_and_actual_fee(self):
        tx = "0x" + "aa" * 32
        block_hash = "0x" + "bb" * 32
        receipt = {"transactionHash": tx, "status": "0x1", "blockNumber": "0x5", "blockHash": block_hash, "transactionIndex": "0x0", "logs": [], "gasUsed": "0x10", "effectiveGasPrice": "0x2"}
        block = {"number": "0x5", "hash": block_hash, "transactions": [tx]}
        transaction = {"hash": tx, "blockHash": block_hash, "blockNumber": "0x5", "transactionIndex": "0x0"}
        values = {"eth_getTransactionReceipt": receipt, "eth_getBlockByNumber": block, "eth_getTransactionByHash": transaction, "eth_blockNumber": "0x9"}
        calls = []
        def call(method, params):
            calls.append((method, params))
            return values[method]
        adapter = evm.EvmEvidence({}, "unused-pure", call=call)
        self.assertEqual(adapter.canonical_receipt(tx)["tokens_used"], 32)
        self.assertIn(("eth_getBlockByNumber", ["0x5", False]), calls)
        for key, field, value in [("eth_getTransactionReceipt", "status", "0x0"), ("eth_getBlockByNumber", "hash", "0x" + "cc" * 32), ("eth_getBlockByNumber", "transactions", []), ("eth_getTransactionByHash", "transactionIndex", "0x1"), ("eth_getTransactionReceipt", "effectiveGasPrice", "0x0")]:
            original = values[key][field]
            values[key][field] = value
            with self.subTest(key=key, field=field):
                with self.assertRaises(ValueError):
                    adapter.canonical_receipt(tx)
            values[key][field] = original

    def test_evm_source_finality_depth_and_same_height_after_fence_reject_early_or_moving_receipt(self):
        tx, block_hash = "0x" + "aa" * 32, "0x" + "bb" * 32
        receipt = {"transactionHash": tx, "status": "0x1", "blockNumber": "0x5", "blockHash": block_hash, "transactionIndex": "0x0", "logs": [], "gasUsed": "0x10", "effectiveGasPrice": "0x2"}
        block = {"number": "0x5", "hash": block_hash, "transactions": [tx]}
        transaction = {"hash": tx, "blockHash": block_hash, "blockNumber": "0x5", "transactionIndex": "0x0"}
        values = {"eth_getTransactionReceipt": receipt, "eth_getBlockByNumber": block, "eth_getTransactionByHash": transaction, "eth_blockNumber": "0x6"}
        def call(method, params): return copy.deepcopy(values[method])
        for depth in (0, 1):
            self.assertEqual(evm.EvmEvidence({}, "unused", call=call, reorg_depth=depth).canonical_receipt(tx)["tokens_used"], 32)
        with self.assertRaisesRegex(ValueError, "configured finality"):
            evm.EvmEvidence({}, "unused", call=call, reorg_depth=2).canonical_receipt(tx)
        for depth in (True, -1, "1", None):
            with self.assertRaisesRegex(ValueError, "finality depth"):
                evm.EvmEvidence({}, "unused", reorg_depth=depth)
        headers = 0
        def moving(method, params):
            nonlocal headers
            value = call(method, params)
            if method == "eth_getBlockByNumber":
                headers += 1
                if headers == 2: value["hash"] = "0x" + "cc" * 32
            return value
        with self.assertRaisesRegex(ValueError, "header changed"):
            evm.EvmEvidence({}, "unused", call=moving, reorg_depth=1).canonical_receipt(tx)

    def test_tron_native_address_and_raw_transaction_identity_are_protocol_correct(self):
        self.assertEqual(tron.tron_address("T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb"), "0x" + "00" * 20)
        with self.assertRaises(ValueError):
            tron.tron_address("T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwa")
        raw_data = b"actual public raw_data"
        signature = b"x" * 65
        signed = b"\x0a" + bytes([len(raw_data)]) + raw_data + b"\x12\x41" + signature
        self.assertEqual(tron_transaction_id(signed.hex()), "0x" + hashlib.sha256(raw_data).hexdigest())
        self.assertNotEqual(tron_transaction_id(signed.hex()), "0x" + hashlib.sha256(signed).hexdigest())
        for changed in [signed[:-1], signed + b"\x0a\x01x", b"\x12\x41" + signature]:
            with self.assertRaises(ValueError):
                tron_transaction_id(changed.hex())

    def test_independent_checkpoint_signature_recovery_uses_digest_and_full_curve_identity(self):
        # Deterministic public private-key1/k2 vector constructed algebraically,
        # with a synthetic SHA256 hash callback isolating ECDSA math from cast.
        z, private, k = 3, 1, 2
        point = evm.point_multiply(k, evm.SECP_G)
        r = point[0] % evm.SECP_N
        s = (z + r * private) * pow(k, -1, evm.SECP_N) % evm.SECP_N
        signature = {"r": hex(r), "s": hex(s), "v": 27 + (point[1] & 1)}
        digest = "0x" + z.to_bytes(32, "big").hex()
        def hashed(value):
            return "0x" + hashlib.sha256(bytes.fromhex(value[2:])).hexdigest()
        public = "0x" + evm.SECP_G[0].to_bytes(32, "big").hex() + evm.SECP_G[1].to_bytes(32, "big").hex()
        expected = "0x" + bytes.fromhex(hashed(public)[2:])[12:].hex()
        self.assertEqual(evm.recover_signature(digest, signature, hashed), expected)
        self.assertNotEqual(evm.recover_signature("0x" + (z + 1).to_bytes(32, "big").hex(), signature, hashed), expected)
        self.assertIsNone(evm.point_multiply(evm.SECP_N, evm.SECP_G))
        for field, value in [("r", "0x0"), ("s", hex(evm.SECP_N)), ("v", 29)]:
            changed = dict(signature, **{field: value})
            with self.assertRaises(ValueError):
                evm.recover_signature(digest, changed, hashed)

    def test_merkle_stream_double_insertions_do_not_assume_message_nonce_equals_leaf_index(self):
        messages = [{"nonce": 0, "id": "0x" + "11" * 32, "insertions": []}, {"nonce": 1, "id": "0x" + "22" * 32, "insertions": [0, 1]}, {"nonce": 2, "id": "0x" + "33" * 32, "insertions": [2]}]
        def hashed(value):
            return "0x" + hashlib.sha256(bytes.fromhex(value[2:])).hexdigest()
        roots = evm.merkle_roots(messages, hashed)
        self.assertEqual([row["message_id"] for row in roots], [messages[1]["id"], messages[1]["id"], messages[2]["id"]])
        self.assertEqual(len({row["root"] for row in roots}), 3)
        messages[2]["insertions"] = [3]
        with self.assertRaisesRegex(ValueError, "gap/duplicate"):
            evm.merkle_roots(messages, hashed)

    def test_stopped_canonical_rust_reader_validates_real_nonce_leaf_and_payment_semantics(self):
        ids = ["0x" + byte * 32 for byte in ("11", "22", "33")]
        messages = [{"nonce": i, "id": identity, "origin": 1, "destination": 2, "payments": [{"payment": 10, "gas_amount": 5}], "insertions": indexes} for i, (identity, indexes) in enumerate(zip(ids, [[], [0, 1], [2]]))]
        rows = [{"nonce": i, "present": True, "origin": 1, "destination": 2, "id_chunks": [identity[2:34], identity[34:]], "insertion_id_chunks": [leaf[2:34], leaf[34:]], "payment": {"payment": "10", "gas_amount": "5"}, "processed": True if i > 0 else None, "spent": {"gas_used": str(100 if i else 0), "tokens_used": str(200 if i else 0)}, "gas_expenditure_record_present": i > 0} for i, (identity, leaf) in enumerate(zip(ids, [ids[1], ids[1], ids[2]]))]
        probe = {"reader": "actual production HyperlaneRocksDB + FullPayload decoder", "origin_namespace": "test1", "origin_domain": 1, "origin_nonce_count": 3, "messages": rows}
        self.assertEqual(len(evm.verify_canonical_rocks(probe, {"name": "test1", "domainid": 1}, messages, set(ids[1:]))), 3)
        for mutate in [lambda p: p["messages"][0].__setitem__("insertion_id_chunks", rows[0]["id_chunks"]), lambda p: p["messages"][1].__setitem__("processed", False), lambda p: p["messages"][1]["payment"].__setitem__("payment", "9"), lambda p: p["messages"][1].__setitem__("nonce", 0), lambda p: p.__setitem__("reader", "canned passed JSON")]:
            changed = copy.deepcopy(probe)
            mutate(changed)
            with self.assertRaises(ValueError):
                evm.verify_canonical_rocks(changed, {"name": "test1", "domainid": 1}, messages, set(ids[1:]))

    def test_stopped_canonical_processed_marker_requires_explicit_optional_bool(self):
        identity = "0x" + "11" * 32
        message = {"nonce": 0, "id": identity, "origin": 1, "destination": 2, "payments": [], "insertions": []}
        row = {"nonce": 0, "present": True, "origin": 1, "destination": 2, "id_chunks": [identity[2:34], identity[34:]], "insertion_id_chunks": None, "payment": None, "processed": None, "spent": {"gas_used": "0", "tokens_used": "0"}, "gas_expenditure_record_present": False}
        probe = {"reader": "actual production HyperlaneRocksDB + FullPayload decoder", "origin_namespace": "test1", "origin_domain": 1, "origin_nonce_count": 1, "messages": [row]}
        chain = {"name": "test1", "domainid": 1}
        # Rust Option<bool> is emitted as JSON null for an absent key, or an
        # explicit bool for an existing key. Both absent and stored-false mean
        # unprocessed; an omitted JSON field is not the same schema.
        for value in (None, False):
            changed = copy.deepcopy(probe)
            changed["messages"][0]["processed"] = value
            with self.subTest(unprocessed=value):
                self.assertIs(evm.verify_canonical_rocks(changed, chain, [message], set())[0]["processed"], False)
        missing = copy.deepcopy(probe)
        missing["messages"][0].pop("processed")
        with self.assertRaisesRegex(ValueError, "explicit optional bool"):
            evm.verify_canonical_rocks(missing, chain, [message], set())
        for value in (0, 1, "false", "true", [], {}):
            changed = copy.deepcopy(probe)
            changed["messages"][0]["processed"] = value
            with self.subTest(wrong_type=type(value).__name__), self.assertRaisesRegex(ValueError, "explicit optional bool"):
                evm.verify_canonical_rocks(changed, chain, [message], set())
        processed = copy.deepcopy(probe)
        processed["messages"][0]["processed"] = True
        with self.assertRaisesRegex(ValueError, "differs from actual native delivery"):
            evm.verify_canonical_rocks(processed, chain, [message], set())
        for value in (None, False):
            changed = copy.deepcopy(probe)
            changed["messages"][0]["processed"] = value
            with self.subTest(delivered_marker=value), self.assertRaisesRegex(ValueError, "differs from actual native delivery"):
                evm.verify_canonical_rocks(changed, chain, [message], {identity})

    def test_sql_origin_and_destination_databases_are_checked_separately_by_exact_identity(self):
        message = {"id": "0x" + "11" * 32, "dispatch_transaction": "0x" + "22" * 32, "origin": 1, "destination": 2, "nonce": 7, "body": "0x66697874757265", "payments": [{"gas_amount": 5, "payment": 10}, {"gas_amount": 6, "payment": 20}], "insertions": [2, 3]}
        origin = evm.sql_message_query(message)
        destination = evm.sql_delivery_query(message, "0x" + "33" * 32)
        self.assertNotIn("confirmed_delivered_message", origin)
        self.assertIn("confirmed_delivered_message", destination)
        self.assertIn("m.nonce=7", origin)
        self.assertIn("d.domain=2", destination)
        proof = evm.verify_sql_message("1|2|30|11|2,3", "1", message, delivered=True)
        self.assertEqual(proof["payment"], 30)
        for output, delivered in [("1|1|30|11|2,3", "1"), ("1|2|30|11|2", "1"), ("1|2|30|11|2,3", "0")]:
            with self.assertRaises(ValueError):
                evm.verify_sql_message(output, delivered, message, delivered=True)
        message["id"] = "0x';DROP TABLE message;"
        with self.assertRaises(ValueError):
            evm.sql_message_query(message)

    def test_native_tron_signed_wire_matches_reader_authority_crypto_and_actual_process(self):
        # Synthetic hash callback isolates protobuf/ECDSA/ABI binding. No SDK,
        # node or cast executes; actual-node Keccak/signature acceptance is later.
        def hashed(value):
            raw = bytes.fromhex(value[2:]) if value.startswith("0x") else value.encode()
            return "0x" + hashlib.sha256(raw).hexdigest()
        def field(number, value):
            return tron.varint(number << 3 | 2) + tron.varint(len(value)) + value
        public = "0x" + evm.SECP_G[0].to_bytes(32, "big").hex() + evm.SECP_G[1].to_bytes(32, "big").hex()
        sender = "0x" + bytes.fromhex(hashed(public)[2:])[12:].hex()
        mailbox = "0x" + "11" * 20
        hook = "0x" + "22" * 20
        wire = bytes([3]) + (7).to_bytes(4, "big") + (1).to_bytes(4, "big") + bytes(32) + (2).to_bytes(4, "big") + bytes(12) + bytes.fromhex(mailbox[2:]) + b"public fixture"
        data = (64).to_bytes(32, "big") + (96).to_bytes(32, "big") + bytes(32) + len(wire).to_bytes(32, "big") + wire + bytes((-len(wire)) % 32)
        calldata = bytes.fromhex(hashed("process(bytes,bytes)")[2:10]) + data
        trigger = field(1, b"\x41" + bytes.fromhex(sender[2:])) + field(2, b"\x41" + bytes.fromhex(mailbox[2:])) + field(4, calldata)
        any_contract = field(1, b"/protocol.TriggerSmartContract") + field(2, trigger)
        contract = b"\x08\x1f" + field(2, any_contract)
        raw = field(1, b"\x00\x01") + b"\x18\x01" + field(4, bytes(8)) + field(11, contract)
        identity = "0x" + hashlib.sha256(raw).hexdigest()
        point = evm.point_multiply(2, evm.SECP_G)
        r = point[0] % evm.SECP_N
        s = (int(identity[2:], 16) + r) * pow(2, -1, evm.SECP_N) % evm.SECP_N
        parity = point[1] & 1
        if s > evm.SECP_N // 2:
            s, parity = evm.SECP_N - s, parity ^ 1
        signature = r.to_bytes(32, "big") + s.to_bytes(32, "big") + bytes([27 + parity])
        signed = field(1, raw) + field(2, signature)
        message = {"id": hashed("0x" + wire.hex()), "wire": "0x" + wire.hex(), "nonce": 7, "origin": 1, "destination": 2, "delivery_transaction": identity}
        origin_chain = {"merkletreehook": hook}
        destination_chain = {"mailbox": mailbox, "chainid": 31337}
        padded = lambda v: "0x" + "00" * 12 + v[2:]
        operation = {"kind": "process", "target": None, "stage": "delivered", "confirmation_started": True, "nonce": 7, "origin": 1, "destination": 2, "generation": 3, "identity": {"kind": "hash256", "hex": identity}, "authority": {"protocol": "tron", "origin": 1, "destination": 2, "mailbox": padded(mailbox), "chain_id": "31337", "origin_hook": padded(hook), "operation_id": message["id"], "generation": 3, "kind": "process", "target": None}, "signed": {"bytes": len(signed), "sha256": "0x" + hashlib.sha256(signed).hexdigest()}, "expenditure": {"present": True, "gas_used_hex": "0x" + (50).to_bytes(32, "big").hex(), "tokens_used_hex": "0x" + (100).to_bytes(32, "big").hex()}, "context": "0x" + "33" * 32, "expected_context_checked": False}
        native_tx = {"txID": identity[2:], "raw_data_hex": raw.hex(), "signature": [signature.hex()]}
        proof = {"native_fee_sun": 110, "gas_used": 50, "tokens_used": 100, "transaction": {"to": mailbox, "from": sender, "input": "0x" + calldata.hex()}}
        adapter = tron.TronEvidence({}, "unused", "unused", "unused", command=lambda command, value: hashed(value), native=lambda *args: native_tx)
        verified = adapter.verify_signed_operation(operation, message, origin_chain, destination_chain, sender, proof)
        self.assertEqual(verified["identity"], identity)
        self.assertEqual(verified["signer"], sender)
        self.assertFalse(verified["expected_context_checked"])
        wrong_fee = copy.deepcopy(proof)
        wrong_fee["tokens_used"] = 99
        with self.assertRaisesRegex(ValueError, "energy/price expenditure"):
            adapter.verify_signed_operation(operation, message, origin_chain, destination_chain, sender, wrong_fee)
        for key, value in [("identity", {"kind": "signature512", "hex": identity}), ("generation", 4), ("signed", {"bytes": len(signed), "sha256": "0x" + "00" * 32})]:
            changed = copy.deepcopy(operation)
            changed[key] = value
            with self.subTest(key=key):
                with self.assertRaises(ValueError):
                    adapter.verify_signed_operation(changed, message, origin_chain, destination_chain, sender, proof)
        changed = copy.deepcopy(proof)
        changed["transaction"]["input"] = "0x" + calldata[:-1].hex()
        with self.assertRaises(ValueError):
            adapter.verify_signed_operation(operation, message, origin_chain, destination_chain, sender, changed)
        with self.assertRaises(ValueError):
            adapter.verify_signed_operation(operation, message, origin_chain, destination_chain, "0x" + "44" * 20, proof)
        with self.assertRaises(ValueError):
            tron.native_trigger(raw + field(11, contract))
        with self.assertRaises(ValueError):
            tron.process_message(calldata + bytes(32), hashed("process(bytes,bytes)")[:10])


class RadixExpenditureContractTests(unittest.TestCase):
    def fixture(self, count=2, origin="first", domain=1):
        ids = ["0x" + bytes([i + domain] * 32).hex() for i in range(count)]
        messages = [{"id": identity, "nonce": i, "origin": domain, "destination": 3 - domain, "origin_chain": origin, "insertions": [i], "payments": []} for i, identity in enumerate(ids)]
        rows = [{"nonce": i, "present": True, "id_chunks": [identity[2:]], "origin": domain, "destination": 3 - domain, "insertion_id_chunks": [identity[2:]], "payment": None, "processed": True, "spent": {"gas_used": "0", "tokens_used": "0"}, "gas_expenditure_record_present": False} for i, identity in enumerate(ids)]
        probe = {"reader": "actual production HyperlaneRocksDB + FullPayload decoder", "origin_namespace": origin, "origin_domain": domain, "origin_nonce_count": count, "messages": rows}
        chain = {"name": origin, "domainid": domain, "protocol": "radix"}
        return probe, chain, messages, set(ids)

    def test_default_none_keeps_strict_positive_self_delivery_expenditure(self):
        fixture = self.fixture()
        for marker in (False, True):
            for row in fixture[0]["messages"]: row["gas_expenditure_record_present"] = marker
            with self.assertRaisesRegex(ValueError, "marker/value missing"):
                evm.verify_canonical_rocks(*fixture)
        for row in fixture[0]["messages"]: row["spent"] = {"gas_used": "7", "tokens_used": "11"}
        self.assertEqual(len(evm.verify_canonical_rocks(*fixture)), 2)

    def test_actual_unknown_requires_marker_absence_and_exact_zero_projection(self):
        fixture = self.fixture()
        expected = {identity: None for identity in fixture[3]}
        self.assertEqual(len(evm.verify_canonical_rocks(*fixture, expenditure_expectations=expected)), 2)
        for mutate in [lambda row: row.update(gas_expenditure_record_present=True), lambda row: row.update(gas_expenditure_record_present=0), lambda row: row["spent"].update(gas_used="1"), lambda row: row["spent"].update(tokens_used="1")]:
            bad = copy.deepcopy(fixture)
            mutate(bad[0]["messages"][0])
            with self.subTest(mutation=mutate), self.assertRaisesRegex(ValueError, "fabricated canonical"):
                evm.verify_canonical_rocks(*bad, expenditure_expectations=expected)

    def test_known_zero_and_known_positive_require_present_exact_markers(self):
        for gas, tokens in [(0, 0), (5, 0), (7, 11)]:
            fixture = self.fixture()
            expected = {identity: {"gas_used": gas, "tokens_used": tokens} for identity in fixture[3]}
            for row in fixture[0]["messages"]: row.update(gas_expenditure_record_present=True, spent={"gas_used": str(gas), "tokens_used": str(tokens)})
            self.assertEqual(len(evm.verify_canonical_rocks(*fixture, expenditure_expectations=expected)), 2)
            fixture[0]["messages"][0]["gas_expenditure_record_present"] = False
            with self.assertRaisesRegex(ValueError, "known actual Radix fee"):
                evm.verify_canonical_rocks(*fixture, expenditure_expectations=expected)
            fixture[0]["messages"][0].update(gas_expenditure_record_present=True, spent={"gas_used": str(gas + 1), "tokens_used": str(tokens)})
            with self.assertRaisesRegex(ValueError, "known actual Radix fee"):
                evm.verify_canonical_rocks(*fixture, expenditure_expectations=expected)

    def test_missing_foreign_malformed_expectations_and_other_protocol_bypass_reject(self):
        fixture = self.fixture()
        ids = list(fixture[3]);correct = {identity: None for identity in ids}
        for wrong in [None, [], {ids[0]: None}, dict(correct, **{"0x" + "ff" * 32: None}), {identity: {"gas_used": True, "tokens_used": 0} for identity in ids}, {identity: {"gas_used": 2 ** 256, "tokens_used": 0} for identity in ids}, {identity: {"gas_used": -1, "tokens_used": 0} for identity in ids}, {identity: {"gas_used": 0} for identity in ids}]:
            with self.subTest(expectations=wrong), self.assertRaises(ValueError):
                evm.validate_expenditure_expectations(wrong, fixture[3])
        fixture[1]["protocol"] = "ethereum"
        with self.assertRaisesRegex(ValueError, "Radix-only"):
            evm.verify_canonical_rocks(*fixture, expenditure_expectations=correct)

    def test_session_requires_complete_family_receipt_map_before_oracle_and_slices_each_origin(self):
        with tempfile.TemporaryDirectory(prefix="ziggy-radix-fee-contract-pure-") as directory:
            root = pathlib.Path(directory).resolve();database = root / "db";database.mkdir();(database / "CURRENT").write_text("pure placeholder, never opened by Rocks")
            a, b = self.fixture(1, "first", 1), self.fixture(1, "second", 2)
            b[0]["messages"][0]["gas_expenditure_record_present"] = True
            messages = a[2] + b[2]
            expected = {a[2][0]["id"]: None, b[2][0]["id"]: {"gas_used": 0, "tokens_used": 0}}
            snapshot = {"messages": messages, "deliverable_messages": messages}
            session = Session.__new__(Session);session.manifest = {"scenario": "radix", "task_root": str(root)};session.evidence_relative = pathlib.Path("evidence")
            session._owned_path = api.checked_owned_path
            session.captures = [{"original": {"role": "relayer", "db": str(database), "chains": {"first": a[1], "second": b[1]}}}]
            session.family = mock.Mock();session.family.canonical_expenditure.return_value = expected
            def oracle(manifest, name, args, timeout):
                self.assertEqual(name, "oracle")
                return json.dumps({"first": a[0], "second": b[0]}[args[3]])
            with mock.patch("multivm_session.run_tool", side_effect=oracle) as tool:
                self.assertEqual(len(session.stopped_store_proofs(snapshot)), 2)
                session.family.canonical_expenditure.assert_called_once_with(snapshot)
                self.assertEqual(tool.call_count, 2)
            for wrong in [None, {}, dict(expected, **{"0x" + "ff" * 32: None})]:
                session.family.canonical_expenditure.return_value = wrong
                with mock.patch("multivm_session.run_tool") as tool, self.assertRaises(ValueError):
                    session.stopped_store_proofs(snapshot)
                tool.assert_not_called()
            session.family = object()
            with mock.patch("multivm_session.run_tool") as tool, self.assertRaisesRegex(ValueError, "contract missing"):
                session.stopped_store_proofs(snapshot)
            tool.assert_not_called()
            # A similarly named family method cannot relax any other VM.
            for scenario in ("evm", "tron", "cosmwasm", "cosmosnative", "sealevel", "starknet"):
                session.manifest["scenario"] = scenario;session.family = mock.Mock()
                with mock.patch("multivm_session.run_tool", side_effect=oracle), self.assertRaisesRegex(ValueError, "marker/value missing"):
                    session.stopped_store_proofs(snapshot)
                session.family.canonical_expenditure.assert_not_called()


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.identity = "0x" + "11" * 32
        self.tx = "0x" + "22" * 32
        self.operation = {"id": self.identity, "operation": {"type": "PendingMessage", "status": {"Confirm": "SubmittedBySelf"}, "submitted": True, "message": {"version": 3, "nonce": 7, "origin": 1, "sender": "0x" + "00" * 32, "destination": 2, "recipient": "0x" + "00" * 32, "body": []}}}

    def test_continuous_real_clock_samples_preserve_per_id600_then_retire(self):
        lifecycle = Lifecycle()
        lifecycle.included(self.identity, self.tx, "test2", 0)
        for second in range(600):
            lifecycle.sample({"test2": [self.operation]}, second * 1_000_000_000)
        lifecycle.sample({"test2": []}, 600_000_000_000)
        result = lifecycle.complete([("test2", self.identity)])
        self.assertEqual(result[0]["retired_monotonic_ns"], 600_000_000_000)
        self.assertEqual(result[0]["early_active_samples"], 600)
        self.assertEqual(result[0]["confirm_by_self_samples"], 600)

    def test_early_partial_retirement_rejected_even_when_another_id_finishes_later(self):
        second_id = "0x" + "33" * 32
        lifecycle = Lifecycle()
        lifecycle.included(self.identity, self.tx, "test2", 0)
        lifecycle.included(second_id, self.tx, "test2", 21_000_000_000)
        later = copy.deepcopy(self.operation)
        later["id"] = second_id
        for second in range(21):
            lifecycle.sample({"test2": [self.operation]}, second * 1_000_000_000)
        # The later inclusion never resets the earlier ID's observation clock.
        for second in range(21, 610):
            lifecycle.sample({"test2": [self.operation, later]}, second * 1_000_000_000)
        with self.assertRaisesRegex(ValueError, "own600s"):
            lifecycle.sample({"test2": [self.operation]}, 610_000_000_000)

    def test_gap_rollback_late_retirement_and_missing_self_confirm_cannot_pass(self):
        for sample_times in [[0, 10_000_000_001], [5_000_000_000, 4_000_000_000]]:
            lifecycle = Lifecycle()
            lifecycle.included(self.identity, self.tx, "test2", 0)
            lifecycle.sample({"test2": [self.operation]}, sample_times[0])
            with self.assertRaises(ValueError):
                lifecycle.sample({"test2": [self.operation]}, sample_times[1])
        lifecycle = Lifecycle()
        lifecycle.included(self.identity, self.tx, "test2", 0)
        for second in range(631):
            lifecycle.sample({"test2": [self.operation]}, second * 1_000_000_000)
        with self.assertRaisesRegex(ValueError, "within600"):
            lifecycle.sample({"test2": [self.operation]}, 631_000_000_000)

    def test_same_id_cannot_hide_changed_admin_message_wire(self):
        lifecycle = Lifecycle()
        lifecycle.included(self.identity, self.tx, "test2", 0)
        lifecycle.sample({"test2": [self.operation]}, 0)
        changed = copy.deepcopy(self.operation)
        changed["operation"]["message"]["nonce"] = 8
        with self.assertRaisesRegex(ValueError, "message changed"):
            lifecycle.sample({"test2": [changed]}, 1_000_000_000)

    def test_reviewed10s_coverage_cap_accepts_boundary_but_never_late_or_rollback(self):
        lifecycle = Lifecycle()
        lifecycle.included(self.identity, self.tx, "test2", 0)
        lifecycle.sample({"test2": [self.operation]}, 0)
        lifecycle.sample({"test2": [self.operation]}, 3_000_000_000)
        lifecycle.sample({"test2": [self.operation]}, 13_000_000_000)
        with self.assertRaisesRegex(ValueError, "exceeds10s"):
            lifecycle.sample({"test2": [self.operation]}, 23_000_000_001)

    def test_first_observation500s_after_native_inclusion_cannot_pass(self):
        lifecycle = Lifecycle()
        lifecycle.included(self.identity, self.tx, "a", 0)
        self.assertEqual(lifecycle.sample_deadline(["a"], 500_000_000_000), 10_000_000_000)
        with self.assertRaisesRegex(ValueError, "exceeds10s"):
            lifecycle.sample({"a": [self.operation]}, 500_000_000_000)

    def test_first_domain_exact10s_boundary_does_not_wait_for_other_inclusions(self):
        lifecycle = Lifecycle()
        lifecycle.included(self.identity, self.tx, "a", 0)
        self.assertEqual(lifecycle.sample_deadline(["a", "b"], 1_000_000_000), 10_000_000_000)
        lifecycle.sample({"a": [self.operation], "b": []}, 10_000_000_000)
        self.assertEqual(lifecycle.rows[("a", self.identity)]["early_active_samples"], 1)
        lifecycle.included(self.identity, self.tx, "b", 19_000_000_000)
        self.assertEqual(lifecycle.sample_deadline(["a", "b"], 19_000_000_000), 20_000_000_000)
        lifecycle.sample({"a": [self.operation], "b": [self.operation]}, 20_000_000_000)

    def test_new_domain_inclusion_never_renews_an_unobserved_older_domain(self):
        lifecycle = Lifecycle()
        lifecycle.included(self.identity, self.tx, "a", 0)
        lifecycle.included(self.identity, self.tx, "b", 20_000_000_000)
        self.assertEqual(lifecycle.sample_deadline(["a", "b"], 20_000_000_000), 10_000_000_000)
        lifecycle.sample({"b": [self.operation]}, 21_000_000_000)
        self.assertEqual(lifecycle.sample_deadline(["a", "b"], 21_000_000_000), 10_000_000_000)
        self.assertNotIn(("a", self.identity), lifecycle.rows)

    def test_each_domain_uses_actual_response_time_not_later_round_time(self):
        lifecycle = Lifecycle()
        lifecycle.included(self.identity, self.tx, "a", 0)
        for second in range(0, 600, 5):
            lifecycle.sample({"a": [self.operation]}, second * 1_000_000_000)
        observations = {"a": {"request_started_monotonic_ns": 598_000_000_000, "response_received_monotonic_ns": 599_000_000_000}, "b": {"request_started_monotonic_ns": 598_000_000_000, "response_received_monotonic_ns": 601_000_000_000}}
        with self.assertRaisesRegex(ValueError, "own600s"):
            lifecycle.sample({"a": [], "b": []}, 601_000_000_000, domain_observations=observations)

    def test_partial_out_of_order_domains_never_retire_unobserved_siblings(self):
        lifecycle = Lifecycle()
        lifecycle.included(self.identity, self.tx, "a", 0)
        lifecycle.included(self.identity, self.tx, "b", 0)
        lifecycle.sample({"a": [self.operation], "b": [self.operation]}, 0)
        lifecycle.sample({"b": [self.operation]}, 9_000_000_000)
        lifecycle.sample({"a": [self.operation]}, 9_000_000_000, domain_observations={"a": {"request_started_monotonic_ns": 7_000_000_000, "response_received_monotonic_ns": 8_000_000_000}})
        self.assertTrue(all(row["retired_monotonic_ns"] is None for row in lifecycle.rows.values()))
        with self.assertRaisesRegex(ValueError, "rollback"):
            lifecycle.sample({"a": [self.operation]}, 7_000_000_000)

    def test_unseen_domain_never_hides_global_round_clock_rollback(self):
        lifecycle = Lifecycle()
        lifecycle.sample({"a": []}, 9_000_000_000)
        with self.assertRaisesRegex(ValueError, "round clock rollback"):
            lifecycle.sample({"previously-unseen": []}, 8_000_000_000)

    def test_retirement_keeps_observed_interval_and_original600_to630_bounds(self):
        lifecycle = Lifecycle()
        lifecycle.included(self.identity, self.tx, "a", 0)
        for second in range(0, 600, 5):
            lifecycle.sample({"a": [self.operation]}, second * 1_000_000_000)
        observations = {"a": {"request_started_monotonic_ns": 600_000_000_000, "response_received_monotonic_ns": 601_000_000_000}}
        lifecycle.sample({"a": []}, 602_000_000_000, domain_observations=observations)
        row = lifecycle.complete([("a", self.identity)])[0]
        self.assertEqual(row["retired_monotonic_ns"], 601_000_000_000)
        self.assertEqual(row["first_absent_request_started_ns"], 600_000_000_000)
        self.assertEqual(row["last_present_response_received_ns"], 595_000_000_000)
        self.assertLessEqual(row["maximum_observed_sample_gap_ns"], 10_000_000_000)

    def test_shared_family_snapshot_keeps_full_signature512_and_exact_shared_members(self):
        signature = "0x" + "ab" * 64
        admin = self.operation["operation"]["message"]
        wire = bytes([admin["version"]]) + admin["nonce"].to_bytes(4, "big") + admin["origin"].to_bytes(4, "big") + bytes(32) + admin["destination"].to_bytes(4, "big") + bytes(32)
        message = {"id": self.identity, "wire": "0x" + wire.hex(), "delivery_chain": "test2", "delivery_transaction": signature}
        snapshot = {"messages": [message], "deliverable_messages": [message], "native_delivery_transactions": [{"chain": "test2", "transaction_hash": signature, "proof": {"message_ids": [self.identity]}}]}
        class Family:
            def collect(self, *_):
                return copy.deepcopy(snapshot)
        session = object.__new__(Session)
        session.family = Family()
        session.manifest = {"runtime_source_commit": "a" * 40, "scenario": "sealevel"}
        session.captures = [{"capture_ordinal": 0, "original": {"role": "relayer"}}]
        session.self_transactions = {("test2", signature)}
        session.broadcasts = []
        session.failures = []
        session.expected_unavailable_notices = []
        session.cw_healthy_grpc_fallbacks = {}
        session.lock = threading.RLock()
        session.lifecycle = Lifecycle()
        session.lifecycle.included(self.identity, signature, "test2", 0)
        for second in range(600):
            session.lifecycle.sample({"test2": [self.operation]}, second * 1_000_000_000)
        session.lifecycle.sample({"test2": []}, 600_000_000_000)
        result = session.canonical_snapshot(1, initial=True)
        self.assertEqual(result["per_id_lifecycle"][0]["transaction_hash"], signature)
        self.assertEqual(len(bytes.fromhex(result["per_id_lifecycle"][0]["transaction_hash"][2:])), 64)
        snapshot["native_delivery_transactions"] = []
        with self.assertRaisesRegex(ValueError, "coverage missing"):
            session.canonical_snapshot(1, initial=True)
        snapshot["native_delivery_transactions"] = [{"chain": "test2", "transaction_hash": signature, "proof": {"message_ids": [self.identity, self.identity]}}]
        with self.assertRaisesRegex(ValueError, "membership differs"):
            session.canonical_snapshot(1, initial=True)


class AdminSamplingTests(unittest.TestCase):
    def server(self, handler):
        requests, lock = [], threading.Lock()
        releases = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                with lock:
                    requests.append(self.path)
                    ordinal = len(requests)
                body = handler(ordinal, releases)
                try:
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(body)))
                    self.send_header("Connection", "close")
                    self.end_headers()
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass # Expected only when this test's bounded client closes.

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02})
        thread.start()

        def close():
            for event in releases:
                event.set()
            server.shutdown()
            server.server_close()
            thread.join(2)
            self.assertFalse(thread.is_alive())

        self.addCleanup(close)
        return server.server_port, requests

    def test_actual_HTTP_timeout_recovers_within_original_budget_and_retains_diagnostic(self):
        first = threading.Event()
        def reply(ordinal, releases):
            if ordinal == 1:
                releases.append(first)
                first.wait(4)
            return b"[]"
        port, requests = self.server(reply)
        diagnostics = []
        deadline = time.monotonic_ns() + 10_000_000_000
        operations, observed = session_module.collect_admin_sample(port, {"a": {"domainid": 1}}, deadline, diagnostics.append, lambda: False)
        first.set()
        self.assertEqual(operations, {"a": []})
        self.assertEqual(len(requests), 2)
        self.assertEqual([row["outcome"] for row in diagnostics], ["transport_timeout", "success"])
        self.assertTrue(all(row["whole_sample_deadline_ns"] == deadline for row in diagnostics))
        self.assertLessEqual(observed["a"]["response_received_monotonic_ns"], deadline)

    def test_actual_HTTP_schema_error_is_immediate_not_transport_retry(self):
        port, requests = self.server(lambda *_: b"{}")
        diagnostics = []
        with self.assertRaisesRegex(ValueError, "operation list"):
            session_module.collect_admin_sample(port, {"a": {"domainid": 1}}, time.monotonic_ns() + 10_000_000_000, diagnostics.append, lambda: False)
        self.assertEqual(len(requests), 1)
        self.assertEqual([row["outcome"] for row in diagnostics], ["hard_error"])

    def test_actual_HTTP_fixed_deadline_expires_and_joins_all_sample_workers(self):
        release = threading.Event()
        def reply(_, releases):
            releases.append(release)
            release.wait(2)
            return b"[]"
        port, _ = self.server(reply)
        started = time.monotonic()
        with self.assertRaises(ValueError):
            session_module.collect_admin_sample(port, {"a": {"domainid": 1}}, time.monotonic_ns() + 150_000_000, lambda _: None, lambda: False)
        release.set()
        self.assertLess(time.monotonic() - started, 1)
        self.assertFalse(any(t.name.startswith("native-admin-sample") for t in threading.enumerate()))

    def test_actual_HTTP_stop_interrupts_owned_socket_and_joins_workers(self):
        started, release, stopped = threading.Event(), threading.Event(), threading.Event()
        def reply(_, releases):
            releases.append(release)
            started.set()
            release.wait(3)
            return b"[]"
        port, _ = self.server(reply)
        errors = []
        def collect():
            try:
                session_module.collect_admin_sample(port, {"a": {"domainid": 1}}, time.monotonic_ns() + 10_000_000_000, lambda _: None, stopped.is_set)
            except Exception as error:
                errors.append(error)
        owner = threading.Thread(target=collect)
        owner.start()
        try:
            self.assertTrue(started.wait(2))
            stopped.set()
            owner.join(2)
            self.assertFalse(owner.is_alive())
            self.assertEqual(len(errors), 1)
            self.assertFalse(any(t.name.startswith("native-admin-sample") for t in threading.enumerate()))
        finally:
            stopped.set()
            release.set()
            owner.join(3)

    def test_parallel_domains_share_one_nonrenewable_deadline(self):
        clock, lock, first_recorded = [0], threading.Lock(), threading.Event()
        def now():
            with lock:
                return clock[0]
        def get(_, domain, **_options):
            if domain == 1:
                with lock:
                    clock[0] = 9_000_000_000
            else:
                self.assertTrue(first_recorded.wait(2))
                with lock:
                    clock[0] = 11_000_000_000
            return []
        def diagnostic(row):
            if row["chain"] == "a" and row["outcome"] == "success":
                first_recorded.set()
        with mock.patch.object(session_module.time, "monotonic_ns", side_effect=now), mock.patch.object(session_module, "admin_operations", side_effect=get), self.assertRaisesRegex(ValueError, "deadline"):
            session_module.collect_admin_sample(1, {"a": {"domainid": 1}, "b": {"domainid": 2}}, 10_000_000_000, diagnostic, lambda: False)
        self.assertFalse(any(t.name.startswith("native-admin-sample") for t in threading.enumerate()))

    def test_remaining_budget_clips_GET_timeout_without_reset(self):
        clock = [9_000_000_000]
        timeouts, diagnostics = [], []
        def get(_, _domain, **options):
            timeouts.append(options["timeout"])
            clock[0] += 250_000_000
            if len(timeouts) == 1:
                raise TimeoutError("public fixture timeout")
            return []
        with mock.patch.object(session_module.time, "monotonic_ns", side_effect=lambda: clock[0]), mock.patch.object(session_module, "admin_operations", side_effect=get):
            session_module.collect_admin_sample(1, {"a": {"domainid": 1}}, 10_000_000_000, diagnostics.append, lambda: False)
        self.assertEqual(timeouts, [1, 0.75])
        self.assertEqual({row["whole_sample_deadline_ns"] for row in diagnostics}, {10_000_000_000})

    def test_sampler_deadline_uses_earliest_domain_not_later_global_completion(self):
        class Stop:
            calls = 0
            def wait(self, _):
                self.calls += 1
                return self.calls > 1
            def is_set(self):
                return False
        session = object.__new__(Session)
        session.stop, session.lock = Stop(), threading.RLock()
        session.lifecycle = Lifecycle()
        session.lifecycle.first = {("a", "0x" + "11" * 32): {"first_positive_monotonic_ns": 20_000_000_000}}
        session.lifecycle.last_domain_samples = {"a": 3_000_000_000, "b": 8_000_000_000}
        session.lifecycle.last_sample_ns = 8_000_000_000
        session.sampling_finished = False
        session.captures = [{"original": {"role": "relayer", "metrics_port": 1, "chains": {"a": {"domainid": 1}, "b": {"domainid": 2}}}}]
        records = []
        session.append = lambda name, value: records.append((name, value))
        session.failure = lambda error: self.fail(error)
        observed = {name: {"request_started_monotonic_ns": 9_000_000_000, "response_received_monotonic_ns": 9_000_000_000} for name in ("a", "b")}
        with mock.patch.object(session_module, "collect_admin_sample", return_value=({"a": [], "b": []}, observed)) as collector, mock.patch.object(session_module.time, "monotonic_ns", return_value=9_000_000_000):
            session._sample()
        self.assertEqual(collector.call_args.args[2], 13_000_000_000)
        self.assertEqual(records[-1][1]["domain_observations"], observed)

    def test_sampler_hard_error_latches_once_without_fabricating_empty_domains(self):
        class Stop:
            calls = 0
            def wait(self, _):
                self.calls += 1
                return self.calls > 2
            def is_set(self):
                return False
        session = object.__new__(Session)
        session.stop, session.lock = Stop(), threading.RLock()
        session.lifecycle = Lifecycle()
        session.lifecycle.first = {("a", "0x" + "11" * 32): {"first_positive_monotonic_ns": 0}}
        session.sampling_finished = False
        session.captures = [{"original": {"role": "relayer", "metrics_port": 1, "chains": {"a": {"domainid": 1}}}}]
        failures, records = [], []
        session.failure = failures.append
        session.append = lambda *value: records.append(value)
        with mock.patch.object(session_module, "collect_admin_sample", side_effect=ValueError("invalid public admin schema")) as collector:
            session._sample()
        self.assertEqual(collector.call_count, 1)
        self.assertEqual(failures, ["ValueError: invalid public admin schema"])
        self.assertEqual(records, [])
        self.assertEqual(session.lifecycle.samples, 0)


class ParentWaitTests(unittest.TestCase):
    def fixture(self, root, scenario="tron"):
        roles = ["relayer", "validator", "validator"]
        if scenario != "sealevel-composite":
            roles.append("scraper")
        session = object.__new__(Session)
        session.manifest = {"scenario": scenario, "artifacts": {role: {"path": "/public/" + role, "bytes": 1, "sha256": "a" * 64} for role in set(roles)}}
        session.evidence_relative = pathlib.Path("evidence")
        (root / "evidence").mkdir()
        session._owned_path = lambda _, relative: root / relative
        session.manifest["task_root"] = str(root)
        session.initial = {"capture_count": len(roles)}
        session.captures = [{"original": {"role": role}} for role in roles * 2]
        launches, exits = [], []
        for ordinal, role in enumerate(roles * 2):
            launch = {"pid": ordinal + 100, "parent_pid": 90, "role": role, "executable": session.manifest["artifacts"][role], "os_start_token": "actual-start-" + str(ordinal)}
            launches.append(launch)
            exits.append(dict(launch, purpose="same_db_restart" if ordinal < len(roles) else "final", parent_wait_completed=True, success=True, already_exited=False, forced_kill=False, exit_code=0, signal=None, planned_exit=ordinal < len(roles)))
        return session, launches, exits

    @staticmethod
    def write(session, launches, exits):
        for name, rows in [("owned-children.jsonl", launches), ("parent-child-exits.jsonl", exits)]:
            session.owned_path(session.evidence_relative / name).write_text("".join(json.dumps(row) + "\n" for row in rows))

    def test_all_configured_validators_and_source_composite_roles_have_exact_parent_waits(self):
        for scenario in ["tron", "sealevel-composite"]:
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory(prefix="ziggy-parent-wait-pure-") as directory:
                session, launches, exits = self.fixture(pathlib.Path(directory), scenario)
                self.write(session, launches, exits)
                self.assertEqual(session.parent_wait_proofs(), exits)
                self.assertEqual(session.parent_wait_proofs("same_db_restart"), exits)
                # Reusing a numeric PID cannot conflate two OS process epochs.
                launches[-1]["pid"] = exits[-1]["pid"] = launches[0]["pid"]
                self.write(session, launches, exits)
                self.assertEqual(session.parent_wait_proofs(), exits)

    def test_missing_duplicate_wrong_executable_or_unclean_historical_child_cannot_pass(self):
        changes = {
            "missing validator": lambda l, e: e.pop(2),
            "duplicate receipt": lambda l, e: e.append(copy.deepcopy(e[0])),
            "duplicate launch": lambda l, e: l.append(copy.deepcopy(l[0])),
            "wrong epoch": lambda l, e: e[0].__setitem__("os_start_token", "foreign"),
            "wrong artifact": lambda l, e: e[0].__setitem__("executable", dict(e[0]["executable"], sha256="b" * 64)),
            "unwind": lambda l, e: e[0].__setitem__("purpose", "unwind_or_early_drop"),
            "historical nonzero": lambda l, e: e[0].update(success=False, exit_code=1),
            "forced": lambda l, e: e[0].__setitem__("forced_kill", True),
            "already exited": lambda l, e: e[0].__setitem__("already_exited", True),
        }
        for name, mutate in changes.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory(prefix="ziggy-parent-wait-negative-") as directory:
                session, launches, exits = self.fixture(pathlib.Path(directory))
                mutate(launches, exits)
                self.write(session, launches, exits)
                with self.assertRaises(ValueError):
                    session.parent_wait_proofs()

    def test_restart_launch_epochs_accept_pid_reuse_but_reject_replayed_epoch_and_changed_artifact(self):
        with tempfile.TemporaryDirectory(prefix="ziggy-role-epoch-pure-") as directory:
            session, launches, _ = self.fixture(pathlib.Path(directory))
            launches[4]["pid"] = launches[0]["pid"]
            self.assertEqual(len(session.role_launch_epochs(launches)), len(launches))
            for mutate in [lambda rows: rows.__setitem__(4, copy.deepcopy(rows[0])), lambda rows: rows[4].update(executable=dict(rows[4]["executable"], sha256="b" * 64)), lambda rows: rows[4].update(parent_pid=True), lambda rows: rows[4].update(os_start_token="")]:
                changed = copy.deepcopy(launches)
                mutate(changed)
                with self.subTest(mutation=mutate), self.assertRaises(ValueError):
                    session.role_launch_epochs(changed)

    def evm_retired_fixture(self, root):
        session, _, _ = self.fixture(root, "evm")
        roles = ["relayer", "validator", "validator", "validator", "scraper"]
        captured = roles + roles + ["relayer"]
        session.initial = {"capture_count": len(roles)}
        session.captures = [{"original": {"role": role}} for role in captured]
        launches, exits = [], []
        for ordinal, role in enumerate(captured):
            launch = {"pid": ordinal + 100, "parent_pid": 90, "role": role, "executable": session.manifest["artifacts"][role], "os_start_token": "actual-start-" + str(ordinal)}
            purpose = "same_db_restart" if ordinal < 5 else "intentional_restart" if ordinal == 5 else "intentional_reorg" if ordinal == 7 else "final"
            planned = purpose.startswith("intentional_")
            launches.append(launch)
            exits.append(dict(launch, purpose=purpose, parent_wait_completed=True, success=not planned, already_exited=False, forced_kill=False, exit_code=None if planned else 0, signal=9 if planned else None, planned_exit=planned))
        return session, launches, exits

    def test_intentional_source_kill_has_separate_planned_nonclean_receipt(self):
        with tempfile.TemporaryDirectory(prefix="ziggy-parent-wait-planned-") as directory:
            session, launches, exits = self.evm_retired_fixture(pathlib.Path(directory))
            self.write(session, launches, exits)
            self.assertEqual(session.parent_wait_proofs(), exits)
            next(row for row in exits if row["purpose"] == "intentional_reorg")["planned_exit"] = False
            self.write(session, launches, exits)
            with self.assertRaisesRegex(ValueError, "planned parent kill/wait"):
                session.parent_wait_proofs()

    def test_evm_final_census_accounts_only_actual_planned_validator_retirement(self):
        with tempfile.TemporaryDirectory(prefix="ziggy-evm-final-census-") as directory:
            session, launches, exits = self.evm_retired_fixture(pathlib.Path(directory))
            self.write(session, launches, exits)
            self.assertEqual(session.parent_wait_proofs(), exits)
            self.assertEqual(session.parent_wait_proofs("same_db_restart"), exits)
            self.assertEqual(len(exits), 11)
            self.assertEqual(sum(row["purpose"] == "final" for row in exits), 4)
            self.assertEqual(sum(row["purpose"] == "same_db_restart" for row in exits), 5)

    def test_evm_missing_foreign_duplicate_or_unplanned_retirement_cannot_change_final_census(self):
        changes = {
            "missing retirement": lambda s, l, e: next(row for row in e if row["purpose"] == "intentional_reorg").update(purpose="final", success=True, exit_code=0, signal=None),
            "wrong role": lambda s, l, e: next(row for row in e if row["purpose"] == "intentional_reorg").update(role="relayer"),
            "foreign family": lambda s, l, e: s.manifest.update(scenario="tron"),
            "missing final": lambda s, l, e: e.pop(),
            "duplicate retirement": lambda s, l, e: e.append(copy.deepcopy(next(row for row in e if row["purpose"] == "intentional_reorg"))),
            "unplanned": lambda s, l, e: next(row for row in e if row["purpose"] == "intentional_reorg").update(planned_exit=False),
            "wrong signal": lambda s, l, e: next(row for row in e if row["purpose"] == "intentional_reorg").update(signal=15),
            "wrong epoch": lambda s, l, e: next(row for row in e if row["purpose"] == "intentional_reorg").update(os_start_token="foreign"),
            "changed executable": lambda s, l, e: next(row for row in e if row["purpose"] == "intentional_reorg").update(executable={"path":"/foreign","bytes":1,"sha256":"b"*64}),
        }
        for name, change in changes.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory(prefix="ziggy-evm-retirement-negative-") as directory:
                session, launches, exits = self.evm_retired_fixture(pathlib.Path(directory))
                change(session, launches, exits);self.write(session, launches, exits)
                with self.assertRaises(ValueError):session.parent_wait_proofs()


class CheckpointPublicationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="ziggy-zero-leaf-publication-pure-")
        self.addCleanup(self.directory.cleanup)
        self.root = pathlib.Path(self.directory.name).resolve()
        self.session = Session.__new__(Session)
        self.session.manifest = {"scenario": "starknet", "task_root": str(self.root), "runtime_source_commit": "a" * 40}
        self.session.case = {"domain_names": {"23448593": "starknettest23448593", "23448594": "starknettest23448594"}}
        self.session._owned_path = api.checked_owned_path
        self.session.keccak = lambda value: "0x" + hashlib.sha256(value.encode()).hexdigest()
        self.session.captures = []
        self.metadata = {}
        for domain, name in self.session.case["domain_names"].items():
            directory = self.root / name
            directory.mkdir()
            chain = {"domainid": int(domain), "rpcurls": [{"http": "http://127.0.0.1:" + ("5050" if domain == "23448593" else "5070")}]}
            original = {"role": "validator", "role_chain_names": [name], "chains": {name: chain}, "checkpoint_syncer": {"type": "localStorage", "path": str(directory)}, "allows_public_rpcs": False}
            self.session.captures.append({"original": original, "proxied": copy.deepcopy(original)})
            endpoint = evidence.urls(chain["rpcurls"])[0]
            metadata = {"git_sha": "a" * 40, "rpcs": [{"url_hash": self.session.keccak(endpoint), "host_hash": self.session.keccak("127.0.0.1")}], "allows_public_rpcs": False}
            (directory / "metadata_latest.json").write_text(json.dumps(metadata, indent=2) + "\n")
            self.metadata[name] = metadata
        self.origin, self.empty = list(self.metadata)
        # Exact Source Starknet one-way10: populated A, configured empty B.
        self.snapshot = {"messages": [{"origin_chain": self.origin, "origin": 23448593, "insertions": [nonce]} for nonce in range(10)]}
        self.zero = {"chain": self.empty, "metadata": self.metadata[self.empty], "zero_leaf_origin_no_signature_credit": True, "verified_checkpoint_objects": [], "published_bytes": []}

    def test_actual_source_configured_empty_origin_binds_metadata_bytes_without_signature_credit(self):
        positive = {"published_bytes": [{"path": "already independently verified positive object"}]}
        proofs = self.session.checkpoint_publications(self.snapshot, [positive, self.zero])
        self.assertEqual(proofs[0], positive)
        empty = proofs[1]
        self.assertEqual((empty["chain"], empty["domain"], empty["canonical_origin_message_count"], empty["canonical_origin_leaf_count"]), (self.empty, 23448594, 0, 0))
        self.assertEqual(empty["published_bytes"], [])
        raw = pathlib.Path(empty["metadata_bytes"]["path"]).read_bytes()
        self.assertEqual(empty["metadata_bytes"]["bytes"], len(raw))
        self.assertEqual(empty["metadata_bytes"]["sha256"], hashlib.sha256(raw).hexdigest())
        self.assertEqual(json.loads(raw), empty["metadata"])

    def test_empty_positive_origin_missing_flag_signature_credit_and_wrong_binding_rejected(self):
        changes = [lambda p: p.pop("zero_leaf_origin_no_signature_credit"), lambda p: p.update(zero_leaf_origin_no_signature_credit=1), lambda p: p.update(chain=self.origin, metadata=self.metadata[self.origin]), lambda p: p.update(published_bytes=[{}]), lambda p: p.update(verified_checkpoint_objects=[{}]), lambda p: p.update(domain=1), lambda p: p.update(canonical_origin_leaf_count=3), lambda p: p.update(metadata_bytes={"path": "fake", "bytes": 1, "sha256": "0" * 64})]
        for change in changes:
            proof = copy.deepcopy(self.zero)
            change(proof)
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.session.checkpoint_publications(self.snapshot, [proof])

    def test_actual_metadata_missing_corrupt_source_or_unexpected_signed_object_never_passes(self):
        path = self.root / self.empty / "metadata_latest.json"
        original = path.read_bytes()
        for value in [{}, dict(self.metadata[self.empty], git_sha="b" * 40), dict(self.metadata[self.empty], rpcs=[])]:
            path.write_text(json.dumps(value))
            with self.assertRaisesRegex(ValueError, "ValidatorMetadata"):
                self.session.checkpoint_publications(self.snapshot, [self.zero])
        path.write_bytes(original)
        unexpected = path.parent / "0_with_id.json"
        unexpected.write_text("{}")
        with self.assertRaisesRegex(ValueError, "unexpected signed"):
            self.session.checkpoint_publications(self.snapshot, [self.zero])
        unexpected.unlink()
        path.unlink()
        with self.assertRaisesRegex(ValueError, "metadata missing"):
            self.session.checkpoint_publications(self.snapshot, [self.zero])

    def test_canonical_domain_or_insertion_change_cannot_turn_positive_origin_into_zero(self):
        for message in [{"origin_chain": self.empty, "origin": 23448594, "insertions": [0]}, {"origin_chain": self.origin, "origin": 23448594, "insertions": []}]:
            snapshot = {"messages": [message]}
            with self.assertRaises(ValueError):
                self.session.checkpoint_publications(snapshot, [self.zero])

    def test_source_svm_zero_destination_has_no_configured_validator_and_positive_origin_cannot_be_empty(self):
        # Actual Source standard/composite configure validator only on test1;
        # test2(/test3) zero origins are not extra validator publications.
        row = self.session.captures[0]
        row["original"]["role_chain_names"] = ["sealeveltest1"]
        row["original"]["chains"] = {"sealeveltest1": {"domainid": 13375}}
        self.session.captures = [row]
        for scenario, count, names in [("sealevel", 13, ["sealeveltest1", "sealeveltest2", "sealeveltest3"]), ("sealevel-composite", 2, ["sealeveltest1", "sealeveltest2"])]:
            self.session.manifest["scenario"] = scenario
            self.session.case["domain_names"] = {str(13375 + index): name for index, name in enumerate(names)}
            snapshot = {"messages": [{"origin_chain": "sealeveltest1", "origin": 13375, "insertions": [i]} for i in range(count)]}
            for name in names:
                zero = dict(self.zero, chain=name)
                with self.subTest(scenario=scenario, name=name), self.assertRaises(ValueError):
                    self.session.checkpoint_publications(snapshot, [zero])


class EvmAccountingTests(unittest.TestCase):
    def fixture(self, batch=True):
        def digest(value):
            raw = bytes.fromhex(value[2:]) if value.startswith("0x") else value.encode()
            return "0x" + hashlib.sha256(raw).hexdigest()
        def word(number):
            return number.to_bytes(32, "big")
        mailbox, signer, contract, transaction = ("0x" + byte * count for byte, count in [("11", 20), ("22", 20), ("33", 20), ("44", 32)])
        messages, calls, estimates, rows, links = [], [], [], [], []
        for nonce, weight in enumerate([10, 20] if batch else [10]):
            wire = bytes([3]) + nonce.to_bytes(4, "big") + (1).to_bytes(4, "big") + bytes(32) + (2).to_bytes(4, "big") + bytes(12) + bytes.fromhex(mailbox[2:]) + bytes([nonce])
            identity = digest("0x" + wire.hex())
            calldata = bytes.fromhex(digest("process(bytes,bytes)")[2:10]) + word(64) + word(96) + word(0) + word(len(wire)) + wire + bytes((-len(wire)) % 32)
            messages.append({"id": identity, "wire": "0x" + wire.hex(), "delivery_chain": "test2", "delivery_transaction": transaction})
            calls.append(calldata)
            request = {"from": signer, "to": mailbox, "data": "0x" + calldata.hex()}
            estimates.append({"chain": "test2", "params": [request], "result": hex(weight), "requested_monotonic_ns": 10 + nonce, "received_monotonic_ns": 20 + nonce})
            gas = 101 * weight // (30 if batch else 10)
            spent = {"gas_used": str(gas), "tokens_used": str(gas * 3)}
            rows.append({"id_chunks": [identity[2:]], "spent": spent, "gas_expenditure_record_present": True})
            links.append({"message_id_chunks": [identity[2:]], "estimated_gas": str(weight), "spent": spent, "message_source": "canonical", "canonical_nonce_message_present": True, "canonical_nonce_matches_message": True, "private_operation_stage": "delivered", "destination_payload_present": True, "gas_expenditure_record_present": True})
        if batch:
            tuples = [bytes(12) + bytes.fromhex(mailbox[2:]) + word(1) + word(96) + word(len(call)) + call + bytes((-len(call)) % 32) for call in calls]
            position, offsets = 32 * len(tuples), []
            for encoded in tuples:
                offsets.append(word(position))
                position += len(encoded)
            calldata = bytes.fromhex("82ad56cb") + word(32) + word(len(tuples)) + b"".join(offsets + tuples)
        else:
            calldata = calls[0]
        native = {"to": contract if batch else mailbox, "from": signer, "input": "0x" + calldata.hex()}
        proof = {"transaction": native, "message_ids": [m["id"] for m in messages], "gas_used": 101, "gas_price": 3}
        snapshot = {"deliverable_messages": messages, "native_delivery_transactions": [{"chain": "test2", "transaction_hash": transaction, "proof": proof}]}
        probe = {"messages": rows, "sealed_payload_links": links}
        broadcasts = [{"chain": "test2", "transaction_hash": transaction, "requested_monotonic_ns": 100}]
        chains = {"test2": {"mailbox": mailbox, "batchcontractaddress": contract, "maxbatchsize": 5}}
        return snapshot, [probe], estimates, broadcasts, chains, digest, {"test2": signer}

    def test_original_prepare_quorum_reads_and_actual_singleton_batch_floor_allocation(self):
        for batch in [False, True]:
            fixture = self.fixture(batch)
            # Source quorum can physically repeat the exact three-field read.
            fixture[2].append(copy.deepcopy(fixture[2][0]))
            # The later five-field Lander estimate cannot replace original
            # sealed weights, even if its result happens to differ materially.
            lander = copy.deepcopy(fixture[2][0])
            lander["params"][0].update(value="0x0", accessList=[])
            lander["result"] = "0xffff"
            fixture[2].append(lander)
            after = copy.deepcopy(fixture[2][0])
            after.update(requested_monotonic_ns=101, received_monotonic_ns=102, result="0xffff")
            fixture[2].append(after)
            result = evm.verify_evm_accounting(*fixture)
            self.assertEqual(result[0]["unallocated_floor_dust"], 1 if batch else 0)
            self.assertEqual([m["weight"] for m in result[0]["members"]], [10, 20] if batch else [10])
            self.assertEqual(len(result[0]["members"][0]["original_prepare_reads"]), 2)

    def test_sealed_estimate_matches_real_Rust_canonical_decimal_u256_schema(self):
        # Rust exact_gas_estimate returns Option<String>; JSON emits a
        # canonical decimal string, not the underlying Zig numeric token.
        fixture = self.fixture(batch=False)
        weight = (2 ** 256 - 1) // 101
        fixture[1][0]["sealed_payload_links"][0]["estimated_gas"] = str(weight)
        fixture[2][0]["result"] = hex(weight)
        self.assertEqual(evm.verify_evm_accounting(*fixture)[0]["members"][0]["weight"], weight)
        invalid = [None, True, False, 10, 10.0, [], {}, "", "0", "00", "010", "+10", "-10", " 10", "10 ", "1e1", "10.0", "0xa", "١٠", str(2 ** 256), "9" * 79]
        for value in invalid:
            fixture = self.fixture(batch=False)
            fixture[1][0]["sealed_payload_links"][0]["estimated_gas"] = value
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "actual sealed EVM original estimate"):
                evm.verify_evm_accounting(*fixture)
        fixture = self.fixture(batch=False)
        fixture[1][0]["sealed_payload_links"][0].pop("estimated_gas")
        with self.assertRaisesRegex(ValueError, "actual sealed EVM original estimate"):
            evm.verify_evm_accounting(*fixture)

    def test_funded_wrong_payer_cannot_pass_even_when_prepare_and_canonical_transaction_agree(self):
        fixture = self.fixture()
        wrong = "0x" + "99" * 20
        fixture[0]["native_delivery_transactions"][0]["proof"]["transaction"]["from"] = wrong
        for estimate in fixture[2]: estimate["params"][0]["from"] = wrong
        with self.assertRaisesRegex(ValueError, "reviewed Source signer"):
            evm.verify_evm_accounting(*fixture)
        fixture = self.fixture()
        rogue = copy.deepcopy(fixture[2][0]);rogue["params"][0]["from"] = wrong
        fixture[2].append(rogue)
        with self.assertRaisesRegex(ValueError, "prepare payer"):
            evm.verify_evm_accounting(*fixture)

    def test_accounting_rejects_postbroadcast_only_estimate_wrong_weight_spend_and_members(self):
        changes = {
            "missing prepare": lambda f: f[2].clear(),
            "late prepare": lambda f: f[2][0].update(requested_monotonic_ns=100, received_monotonic_ns=101),
            "wrong original": lambda f: f[2][0].__setitem__("result", "0xb"),
            "different method shape": lambda f: f[2][0]["params"][0].__setitem__("value", "0x0"),
            "wrong gas": lambda f: f[1][0]["messages"][0]["spent"].__setitem__("gas_used", "999"),
            "wrong tokens": lambda f: f[1][0]["messages"][0]["spent"].__setitem__("tokens_used", "999"),
            "missing marker": lambda f: f[1][0]["messages"][0].__setitem__("gas_expenditure_record_present", False),
            "extra member": lambda f: f[0]["native_delivery_transactions"][0]["proof"]["message_ids"].append("0x" + "55" * 32),
            "duplicate seal": lambda f: f[1][0]["sealed_payload_links"].append(copy.deepcopy(f[1][0]["sealed_payload_links"][0])),
            "wrong contract": lambda f: f[4]["test2"].__setitem__("batchcontractaddress", "0x" + "66" * 20),
            "lower cap": lambda f: f[4]["test2"].__setitem__("maxbatchsize", 1),
        }
        for name, mutate in changes.items():
            fixture = self.fixture()
            mutate(fixture)
            with self.subTest(name=name), self.assertRaises(ValueError):
                evm.verify_evm_accounting(*fixture)
        fixture = self.fixture()
        calldata = fixture[0]["native_delivery_transactions"][0]["proof"]["transaction"]["input"]
        for altered in [calldata + "00", "0x" + bytes.fromhex(calldata[2:])[:40].hex()]:
            with self.assertRaises(ValueError):
                evm.aggregate_calls(altered)




class ExpectedCwPeerPolicyTests(unittest.TestCase):
    def policy(self):
        rows=[{"chain":name,"domain":domain,"field":"grpcurls","ordinal":0,"upstream":"http://localhost:1337","healthy_fallback":f"http://127.0.0.1:{port}","error_type":"ConnectionRefusedError","phase":"upstream_connect"}
              for name,domain,port in [("cosmostest99990",99990,26603),("cosmostest99991",99991,26613)]]
        definition={"schema":1,"scenario":"cosmwasm","endpoints":rows}
        manifest={"scenario":"cosmwasm","case_inputs":{"sha256":"a"*64}}
        case={"scenario":"cosmwasm","chain_names":["cosmostest99990","cosmostest99991"],"domain_names":{"99990":"cosmostest99990","99991":"cosmostest99991"},"expected_unavailable_endpoints":definition}
        return manifest,case,{"expected_unavailable_endpoints":definition}
    def test_definition_is_exact_case_scoped_and_cannot_cross_native_or_healthy_endpoint(self):
        manifest,case,approval=self.policy()
        rows=session_module.cw_expected_unavailable_definitions(manifest,case,approval)
        self.assertEqual(len(rows),2)
        for scenario in ["cosmosnative","evm","tron"]:
            with self.assertRaises(ValueError):session_module.cw_expected_unavailable_definitions(dict(manifest,scenario=scenario),case,approval)
        changed=copy.deepcopy(case);changed["expected_unavailable_endpoints"]["endpoints"][0]["upstream"]="http://127.0.0.1:26603"
        with self.assertRaises(ValueError):session_module.cw_expected_unavailable_definitions(manifest,changed,{"expected_unavailable_endpoints":changed["expected_unavailable_endpoints"]})
        with self.assertRaises(ValueError):session_module.cw_expected_unavailable_definitions(manifest,case,{})
    def test_context_binds_actual_selected_fallback_order_and_not_other_peer(self):
        manifest,case,approval=self.policy();definitions=session_module.cw_expected_unavailable_definitions(manifest,case,approval)
        chain={"domainid":99990,"grpcurls":[{"http":"http://localhost:1337"},{"http":"http://127.0.0.1:26603"}]}
        context=session_module.cw_expected_peer_context(definitions,manifest,"cosmostest99990",chain,"relayer","grpcurls",0,"http://localhost:1337")
        self.assertEqual(context["case_inputs_sha256"],manifest["case_inputs"]["sha256"])
        self.assertIsNone(session_module.cw_expected_peer_context(definitions,manifest,"cosmostest99990",chain,"relayer","grpcurls",1,"http://127.0.0.1:26603"))
        changed=copy.deepcopy(chain);changed["grpcurls"].reverse()
        with self.assertRaises(ValueError):session_module.cw_expected_peer_context(definitions,manifest,"cosmostest99990",changed,"relayer","grpcurls",0,"http://localhost:1337")
    def test_notice_requires_real_healthy_fallback_and_never_starts_lifecycle_clock(self):
        manifest,case,approval=self.policy();definitions=session_module.cw_expected_unavailable_definitions(manifest,case,approval)
        session=Session.__new__(Session);session.manifest=manifest;session.lock=threading.RLock()
        session.expected_unavailable_definitions=definitions;session.expected_unavailable_notices=[];session.cw_healthy_grpc_fallbacks={}
        session.failures=[];session.transport_notices=[];session.lifecycle=Lifecycle();session.append=mock.Mock()
        session.captures=[{"captured_monotonic_ns":1,"original":{"role":"relayer","role_chain_names":["cosmostest99990"],"chains":{"cosmostest99990":{}}}}]
        context=dict(definitions[0],scenario="cosmwasm",role="relayer",case_inputs_sha256="a"*64)
        session.failure({"kind":"expected_source_endpoint_unavailable","context":context,"error_type":"ConnectionRefusedError","error":"public fixture refused","monotonic_ns":1,"positive_receipt_credit":False})
        self.assertEqual(session.failures,[]);self.assertEqual(session.lifecycle.first,{})
        with self.assertRaisesRegex(ValueError,"no fresh healthy fallback"):session.require_expected_peer_recovery()
        session.record_cw_grpc_recovery({"role":"relayer","chain":"cosmostest99990","endpoint_field":"grpcurls","upstream":"http://127.0.0.1:26603","status":200,"response":{"trailers":{"grpc-status":"0"}},"received_monotonic_ns":2})
        session.require_expected_peer_recovery()
        self.assertEqual(session.lifecycle.first,{})
        session.failure("ConnectionRefusedError: actual healthy node refused")
        self.assertEqual(session.failures,["ConnectionRefusedError: actual healthy node refused"])

    def test_replacement_capture_and_new_notice_cannot_reuse_old_healthy_success(self):
        manifest,case,approval=self.policy();definitions=session_module.cw_expected_unavailable_definitions(manifest,case,approval)
        session=Session.__new__(Session);session.manifest=manifest;session.lock=threading.RLock()
        session.expected_unavailable_definitions=definitions;session.expected_unavailable_notices=[];session.cw_healthy_grpc_fallbacks={}
        session.failures=[];session.transport_notices=[];session.lifecycle=Lifecycle();session.append=mock.Mock()
        def capture(clock, chain="cosmostest99990"):
            return {"captured_monotonic_ns":clock,"original":{"role":"relayer","role_chain_names":[chain],"chains":{chain:{}}}}
        session.captures=[capture(100)]
        context=dict(definitions[0],scenario="cosmwasm",role="relayer",case_inputs_sha256="a"*64)
        def notice(clock):
            return {"kind":"expected_source_endpoint_unavailable","context":context,"error_type":"ConnectionRefusedError","error":"public fixture refused","monotonic_ns":clock,"positive_receipt_credit":False}
        def healthy(clock, code="0", endpoint="http://127.0.0.1:26603"):
            return {"role":"relayer","chain":"cosmostest99990","endpoint_field":"grpcurls","upstream":endpoint,"status":200,"response":{"trailers":{"grpc-status":code}},"received_monotonic_ns":clock}
        session.failure(notice(110));session.record_cw_grpc_recovery(healthy(120));session.require_expected_peer_recovery()
        # A capture for another selected chain cannot redefine this consumer's epoch.
        session.captures.append(capture(190,"cosmostest99991"));session.require_expected_peer_recovery()
        session.captures.append(capture(200));session.failure(notice(210))
        with self.assertRaisesRegex(ValueError,"no fresh healthy fallback"):session.require_expected_peer_recovery()
        for invalid in [healthy(199),healthy(220,code="14"),healthy(221,endpoint="http://127.0.0.1:26613")]:
            session.record_cw_grpc_recovery(invalid)
            with self.assertRaisesRegex(ValueError,"no fresh healthy fallback"):session.require_expected_peer_recovery()
        session.record_cw_grpc_recovery(healthy(220));session.require_expected_peer_recovery()
        # Out-of-order old callbacks cannot roll successful receive time backward.
        session.record_cw_grpc_recovery(healthy(150))
        key=("relayer","cosmostest99990","grpcurls","http://127.0.0.1:26603")
        self.assertEqual(session.cw_healthy_grpc_fallbacks[key],220)
        self.assertEqual(session.lifecycle.first,{})
        self.assertEqual(session.failures,[])



if __name__ == "__main__":
    unittest.main()
