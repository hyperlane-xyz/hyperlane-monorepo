"""EVM family dispatch/admission controls; no SDK, nodes or daemon processes."""
import importlib.util
import pathlib
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("multivm_evm_admission", HERE / "multivm_process.py")
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


class EvmAdmission(unittest.TestCase):
    def test_registry_and_construction_do_not_grant_execution(self):
        self.assertEqual(set(api.FAMILY_VERIFIERS), {"cosmosnative", "evm", "cosmwasm"})
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


if __name__ == "__main__":
    unittest.main()
