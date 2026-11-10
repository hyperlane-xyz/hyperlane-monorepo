"""EVM family dispatch/admission controls; no SDK, nodes or daemon processes."""
import copy
import hashlib
import json
import tempfile
import threading
import types
import importlib.util
import pathlib
import unittest
from unittest import mock
import multivm_runtime_test as runtime_controls

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("multivm_evm_admission", HERE / "multivm_process.py")
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


# This existing CI entrypoint discovers only the pure parent-wait class, not
# RuntimeTests or the explicit-loopback transport classes in its module.
class EvmSourceParentWaitTests(runtime_controls.ParentWaitTests):
    pass


class EvmAdmission(unittest.TestCase):
    def test_registry_and_construction_do_not_grant_execution(self):
        self.assertTrue({"cosmosnative", "evm", "cosmwasm"} <= set(api.FAMILY_VERIFIERS))
        self.assertIs(api.FAMILY_VERIFIERS["evm"], api.session_verifier)
        with mock.patch.object(api, "validate_manifest"):
            result = api.construction_plan({"scenario": "evm", "runtime_source_commit": "a" * 40, "mode": "ReleaseSafe", "artifacts": {}, "harness_deadline_seconds": 3600}, "evm")
        self.assertIs(result["family_verifier_implemented"], True)
        self.assertIs(result["execution_authorized_by_preparation"], False)
        self.assertIs(result["passed"], False)
        self.assertEqual((result["actual_production_confirm_seconds"], result["actual_production_finality_grace_seconds"]), (600, 30))

    def test_evm_route_requires_actual_parent_and_strict_verified_boolean(self):
        value = {"scenario": "evm"}
        for reply, expected in [({"verified": True}, True), ({"verified": False}, False), ({"verified": 1}, False), ({"verified": "true"}, False), ({"passed": True}, False)]:
            with self.subTest(reply=reply), mock.patch.object(api, "validate_manifest") as validate, mock.patch.object(api.multivm_evidence, "verify_harness_parent", return_value={"pid": 11}) as parent, mock.patch.object(api, "controller_request", return_value=reply) as controller:
                self.assertIs(api.verify_stage(value, "live", 20), expected)
                validate.assert_called_once_with(value)
                self.assertEqual(parent.call_count, 2)
                controller.assert_called_once_with(value, "verify", {"stage": "live", "expected": 20, "harness_parent": {"pid": 11}})

    def test_wrong_parent_and_missing_approval_fail_before_effects(self):
        value = {"scenario": "evm"}
        with mock.patch.object(api, "validate_manifest"), mock.patch.object(api.multivm_evidence, "verify_harness_parent", side_effect=ValueError("wrong executable")), mock.patch.object(api, "controller_request") as controller:
            with self.assertRaisesRegex(ValueError, "wrong executable"):
                api.verify_stage(value, "preflight", 0)
            controller.assert_not_called()
        with mock.patch.object(api.multivm_evidence, "read_approval", side_effect=ValueError("execution approval missing")), mock.patch.object(api.multivm_session, "Session") as session:
            with self.assertRaisesRegex(ValueError, "approval missing"):
                api.serve(value)
            session.assert_not_called()

    def test_controller_refusal_and_bad_stage_count_remain_hard(self):
        value = {"scenario": "evm"}
        with mock.patch.object(api, "validate_manifest"), mock.patch.object(api.multivm_evidence, "verify_harness_parent"), mock.patch.object(api, "controller_request", side_effect=ValueError("observer refused")):
            with self.assertRaisesRegex(ValueError, "observer refused"):
                api.verify_stage(value, "final", 20)
        for stage, count in [("unreviewed", 20), ("live", True), ("live", -1)]:
            with self.subTest(stage=stage, count=count), mock.patch.object(api, "validate_manifest"), mock.patch.object(api, "controller_request") as controller:
                with self.assertRaises(ValueError):
                    api.verify_stage(value, stage, count)
                controller.assert_not_called()


class EvmConfiguredDepth(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="ziggy-evm-depth-pure-")
        self.addCleanup(directory.cleanup)
        self.root = pathlib.Path(directory.name).resolve()
        (self.root / "config").mkdir()
        self.chain = {"name": "test1", "protocol": "ethereum", "domainId": 9913371, "mailbox": "0x" + "11" * 20, "merkleTreeHook": "0x" + "22" * 20, "interchainGasPaymaster": "0x" + "33" * 20, "rpcUrls": [{"http": "http://127.0.0.1:8545"}]}
        (self.root / "config/test.json").write_text(json.dumps({"chains": {"test1": self.chain}}))
        case = self.root / "case.json"
        case.write_text(json.dumps({"schema": 1, "scenario": "evm", "chain_names": ["test1"]}))
        self.manifest = {"scenario": "evm", "runtime_source_commit": "a" * 40, "task_root": str(self.root), "case_inputs": {"path": str(case), "bytes": case.stat().st_size, "sha256": hashlib.sha256(case.read_bytes()).hexdigest()}}
        checkpoints = self.root / "checkpoints"
        checkpoints.mkdir()
        self.request = {"schema": 1, "scenario": "evm", "runtime_source_commit": "a" * 40, "role": "validator", "harness_pid": 42, "cwd": str(self.root), "environment": {"HYP_ORIGINCHAINNAME": "test1", "HYP_CHAINS_TEST1_BLOCKS_REORGPERIOD": "0", "HYP_CHECKPOINTSYNCER_TYPE": "localStorage", "HYP_CHECKPOINTSYNCER_PATH": str(checkpoints)}, "arguments": [], "selected_chain_names": ["test1"]}
        self.session = api.multivm_session.Session.__new__(api.multivm_session.Session)
        self.session.manifest = self.manifest
        self.session.family = None
        self.session.case = {"validator_addresses": {"test1": "0x" + "44" * 20}}
        self.session._owned_path = api.checked_owned_path

    def test_actual_validator_env_decimal_string_reaches_checkpoint_adapter_without_mutating_capture(self):
        captured = api.multivm_evidence.effective_config(self.request, self.manifest)
        self.assertEqual(captured["chains"]["test1"]["blocks"]["reorgperiod"], "0")
        original = copy.deepcopy(captured)
        self.session.captures = [{"original": captured, "proxied": copy.deepcopy(captured)}]
        with mock.patch.object(api.multivm_session, "verify_checkpoint_objects", return_value={"fixture_checkpoint_crypto_boundary": True}) as verify:
            self.session.checkpoint_proofs({"messages": []})
        verify.assert_called_once()
        keccak = verify.call_args.args[4]
        self.assertEqual(keccak.__self__.reorg_depth, 0)
        self.assertEqual(captured, original)

    def test_configured_numeric_string_depth_preserves_exact_receipt_finality_fence(self):
        tx, block_hash = "0x" + "aa" * 32, "0x" + "bb" * 32
        receipt = {"transactionHash": tx, "status": "0x1", "blockNumber": "0x5", "blockHash": block_hash, "transactionIndex": "0x0", "logs": [], "gasUsed": "0x10", "effectiveGasPrice": "0x2"}
        block = {"number": "0x5", "hash": block_hash, "transactions": [tx]}
        transaction = {"hash": tx, "blockHash": block_hash, "blockNumber": "0x5", "transactionIndex": "0x0"}
        for depth in (2, "2", "0002"):
            chain = dict(self.chain, rpcurls=self.chain["rpcUrls"], blocks={"reorgperiod": depth})
            adapter = self.session.adapter(chain)
            self.assertEqual(adapter.reorg_depth, 2)
            values = {"eth_getTransactionReceipt": receipt, "eth_getBlockByNumber": block, "eth_getTransactionByHash": transaction, "eth_blockNumber": "0x6"}
            adapter.call = lambda method, params: copy.deepcopy(values[method])
            with self.assertRaisesRegex(ValueError, "configured finality"):
                adapter.canonical_receipt(tx)
            values["eth_blockNumber"] = "0x7"
            self.assertEqual(adapter.canonical_receipt(tx)["tokens_used"], 32)

    def test_config_boundary_refuses_invalid_depth_and_keeps_typed_adapter_strict(self):
        for depth in (True, False, None, -1, 1.0, float("inf"), float("nan"), 2**32, str(2**32), "9" * 100, "-1", "+1", " 1", "1 ", "0x1", "1_0", "1.0", "latest", "safe", "finalized", "earliest", "pending", "", "١", [], {}):
            with self.subTest(depth=depth), self.assertRaisesRegex(ValueError, "finality depth"):
                self.session.adapter(dict(self.chain, rpcurls=self.chain["rpcUrls"], blocks={"reorgperiod": depth}))
        for depth in (0, 2**32 - 1, "0", str(2**32 - 1)):
            self.assertEqual(self.session.adapter(dict(self.chain, rpcurls=self.chain["rpcUrls"], blocks={"reorgperiod": depth})).reorg_depth, int(depth))
        with self.assertRaisesRegex(ValueError, "finality depth"):
            api.multivm_session.EvmEvidence({}, "unused", reorg_depth="1")


class NativeProviderLifecycle(unittest.TestCase):
    def setUp(self):
        # Reuse actual layered-config fixture; no nodes, sockets or agents.
        self.fixture = EvmConfiguredDepth()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.session = self.fixture.session
        self.session.approval = {"harness": {"fixture": True}}
        self.session.lock = threading.RLock()
        self.session.failures = []
        self.session.proxy_cache = {}
        self.next_proxy_port = 20000
        self.identity = {"pid": 42}
        self.request = dict(self.fixture.request, role="relayer", environment={"HYP_RELAYCHAINS": "test1", "HYP_METRICSPORT": "9092", "HYP_CHAINS_TEST1_CUSTOMRPCURLS": "http://127.0.0.1:8545,http://127.0.0.1:8545,http://127.0.0.1:8546"})
        self.capture()

    def capture(self):
        original = api.multivm_evidence.effective_config(self.request, self.fixture.manifest)
        self.install(original)

    def install(self, original):
        replacements = {}
        for name, chain in original["chains"].items():
            for field in api.multivm_evidence.ENDPOINT_FIELDS & chain.keys():
                replacements[name, field] = []
                for source in api.multivm_evidence.urls(chain[field]):
                    key = ("relayer", name, field, source)
                    if key not in self.session.proxy_cache:
                        endpoint = "http://127.0.0.1:" + str(self.next_proxy_port)
                        self.next_proxy_port += 1
                        self.session.proxy_cache[key] = types.SimpleNamespace(endpoint=endpoint)
                    replacements[name, field].append(self.session.proxy_cache[key].endpoint)
        _, proxied = api.multivm_evidence.endpoint_replacements(original, replacements)
        self.row = {"original": original, "proxied": proxied}
        self.session.captures = [self.row]

    def observe(self, created=4, dropped=0, **changes):
        payload = dict(chain="test1", metrics_port=9092, created=created, dropped=dropped, harness_parent=self.identity)
        payload.update(changes)
        with mock.patch.object(api.multivm_session, "read_approval") as approval, mock.patch.object(api.multivm_session, "verified_harness_identity", return_value=self.identity) as identity:
            result = self.session.provider_metrics(payload)
        approval.assert_called_once_with(self.session.manifest)
        identity.assert_called_once_with(self.session.manifest, self.session.approval, self.identity)
        return result

    def test_actual_config_custom_override_pool_dedup_and_active_lifecycle(self):
        before = copy.deepcopy(self.row)
        # Default RPC field is present but overridden, and duplicate custom
        # URLs resolve to one actual proxy/Pool identity, not extra providers.
        self.assertEqual(self.observe()["minimum_active"], 2)
        self.assertTrue(self.observe(created=4, dropped=2)["verified"])
        self.assertFalse(self.observe(created=4, dropped=3)["verified"])
        self.assertFalse(self.observe(created=0)["verified"])
        underflow = self.observe(created=1, dropped=2)
        self.assertIsNone(underflow["active"])
        self.assertFalse(underflow["verified"])
        self.assertEqual(self.row, before)

    def test_single_fallback_quorum_and_distinct_endpoint_identity(self):
        for strategy, floor in [("single", 1), ("fallback", 2), ("quorum", 2)]:
            with self.subTest(strategy=strategy):
                self.request["environment"]["HYP_CHAINS_TEST1_RPCCONSENSUSTYPE"] = strategy
                self.capture()
                self.assertEqual(self.observe()["minimum_active"], floor)
        self.row["proxied"]["chains"]["test1"]["customrpcurls"] += ",http://127.0.0.1:39999"
        with self.assertRaises(ValueError):
            self.observe()

    def test_only_latest_actual_relayer_chain_port_and_harness_are_counted(self):
        for change in [{"chain": "unrelated"}, {"metrics_port": 9093}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.observe(**change)
        original = self.row["original"]
        for key, value in [("harness_pid", 99), ("role_chain_names", ["other"])]:
            old = original[key]
            original[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.observe()
            original[key] = old
        unrelated = copy.deepcopy(self.row)
        unrelated["original"]["role"] = "scraper"
        unrelated["proxied"]["chains"]["test1"]["customrpcurls"] = "http://127.0.0.1:39999"
        self.session.captures.append(unrelated)
        self.assertEqual(self.observe()["minimum_active"], 2)
        newer = copy.deepcopy(self.row)
        newer["original"]["metrics_port"] = 9093
        self.session.captures.append(newer)
        with self.assertRaisesRegex(ValueError, "ownership"):
            self.observe()
        self.session.captures = [unrelated]
        with self.assertRaisesRegex(ValueError, "capture missing"):
            self.observe()

    def test_unowned_proxy_and_unknown_strategy_cannot_supply_floor(self):
        key = next(key for key in self.session.proxy_cache if key[2] == "customrpcurls")
        del self.session.proxy_cache[key]
        with self.assertRaisesRegex(ValueError, "owned proxy"):
            self.observe()
        self.capture()
        self.row["proxied"]["chains"]["test1"]["rpcconsensustype"] = "unknown"
        with self.assertRaisesRegex(ValueError, "strategy"):
            self.observe()
        self.session.failures.append("synthetic prior failure")
        with self.assertRaisesRegex(ValueError, "observer failed"):
            self.observe()

    def test_svm_pool_and_cosmos_grpc_wrapper_counts_remain_distinct(self):
        for protocol, floor in [("sealevel", 2), ("cosmos", 5), ("cosmosnative", 5)]:
            original = copy.deepcopy(self.row["original"])
            chain = original["chains"]["test1"]
            chain["protocol"] = protocol
            if protocol.startswith("cosmos"):
                chain["grpcurls"] = [{"http": "http://127.0.0.1:30001"}]
                chain["customgrpcurls"] = "http://127.0.0.1:30002,http://127.0.0.1:30002,http://127.0.0.1:30003"
            self.install(original)
            with self.subTest(protocol=protocol):
                self.assertEqual(self.observe(created=10)["minimum_active"], floor)

    def test_invalid_counter_types_and_ranges_do_not_gain_credit(self):
        for value in [True, False, -1, 2**32, 1.0, "4", None]:
            for field in ["created", "dropped"]:
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                    self.observe(**{field: value})
        for value in [True, 0, 65536, "9092"]:
            with self.subTest(port=value), self.assertRaises(ValueError):
                self.observe(metrics_port=value)

    def test_controller_action_authenticates_parent_and_passes_only_actual_operands(self):
        value = {"scenario": "evm"}
        with mock.patch.object(api, "validate_manifest") as validate, mock.patch.object(api.multivm_evidence, "verify_harness_parent", return_value=self.identity) as parent, mock.patch.object(api, "controller_request", return_value={"verified": True}) as request:
            self.assertTrue(api.provider_metrics_stage(value, "test1", 9092, 4, 1))
            validate.assert_called_once_with(value)
            parent.assert_called_once_with(value)
            request.assert_called_once_with(value, "provider-metrics", {"chain": "test1", "metrics_port": 9092, "created": 4, "dropped": 1, "harness_parent": self.identity})
        for reply in [{"verified": 1}, {"verified": "true"}, {"verified": False}]:
            with mock.patch.object(api, "validate_manifest"), mock.patch.object(api.multivm_evidence, "verify_harness_parent", return_value=self.identity), mock.patch.object(api, "controller_request", return_value=reply):
                self.assertFalse(api.provider_metrics_stage(value, "test1", 9092, 4, 1))
        with mock.patch.object(api, "validate_manifest"), mock.patch.object(api.multivm_evidence, "verify_harness_parent", side_effect=ValueError("wrong parent")), mock.patch.object(api, "controller_request") as request:
            with self.assertRaisesRegex(ValueError, "wrong parent"):
                api.provider_metrics_stage(value, "test1", 9092, 4, 1)
            request.assert_not_called()


if __name__ == "__main__":
    unittest.main()
