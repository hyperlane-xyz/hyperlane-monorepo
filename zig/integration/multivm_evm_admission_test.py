"""EVM family dispatch/admission controls; no SDK, nodes or daemon processes."""
import copy
import hashlib
import json
import tempfile
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


if __name__ == "__main__":
    unittest.main()
