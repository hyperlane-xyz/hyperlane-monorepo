"""Cosmos-native dispatch boundaries only; no SDK, node or daemon processes."""
import importlib.util
import pathlib
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("multivm_process_admission", HERE / "multivm_process.py")
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


class CosmosNativeAdmission(unittest.TestCase):
    def test_only_reviewed_native_family_enters_registry(self):
        self.assertEqual(set(api.FAMILY_VERIFIERS), {"cosmosnative", "evm", "cosmwasm"})
        self.assertIs(api.FAMILY_VERIFIERS["cosmosnative"], api.session_verifier)

    def test_all_other_families_reject_before_parent_or_controller(self):
        for name in set(api.SCENARIOS) - {"cosmosnative", "evm", "cosmwasm"}:
            with self.subTest(scenario=name), mock.patch.object(api, "validate_manifest"), mock.patch.object(api.multivm_evidence, "verify_harness_parent") as parent, mock.patch.object(api, "controller_request") as controller:
                with self.assertRaisesRegex(ValueError, "no node may start"):
                    api.verify_stage({"scenario": name}, "preflight", 0)
                parent.assert_not_called()
                controller.assert_not_called()

    def test_native_route_never_upgrades_truthy_or_passed_only_reply(self):
        value = {"scenario": "cosmosnative"}
        for reply, expected in [({"verified": True}, True), ({"verified": False}, False), ({"verified": 1}, False), ({"verified": "true"}, False), ({"passed": True}, False)]:
            with self.subTest(reply=reply), mock.patch.object(api, "validate_manifest") as validate, mock.patch.object(api.multivm_evidence, "verify_harness_parent", return_value={"pid": 11}) as parent, mock.patch.object(api, "controller_request", return_value=reply) as controller:
                self.assertIs(api.verify_stage(value, "live", 8), expected)
                validate.assert_called_once_with(value)
                self.assertEqual(parent.call_count, 2)
                controller.assert_called_once_with(value, "verify", {"stage": "live", "expected": 8, "harness_parent": {"pid": 11}})

    def test_wrong_parent_or_controller_failure_cannot_become_acceptance(self):
        value = {"scenario": "cosmosnative"}
        with mock.patch.object(api, "validate_manifest"), mock.patch.object(api.multivm_evidence, "verify_harness_parent", side_effect=ValueError("wrong executable")), mock.patch.object(api, "controller_request") as controller:
            with self.assertRaisesRegex(ValueError, "wrong executable"):
                api.verify_stage(value, "live", 8)
            controller.assert_not_called()
        with mock.patch.object(api, "validate_manifest"), mock.patch.object(api.multivm_evidence, "verify_harness_parent"), mock.patch.object(api, "controller_request", side_effect=ValueError("actual observer refused")):
            with self.assertRaisesRegex(ValueError, "observer refused"):
                api.verify_stage(value, "final", 8)

    def test_bad_stage_or_boolean_count_reject_before_controller(self):
        for stage, count in [("accept-anything", 8), ("live", True), ("live", -1)]:
            with self.subTest(stage=stage, count=count), mock.patch.object(api, "validate_manifest"), mock.patch.object(api.multivm_evidence, "verify_harness_parent") as parent:
                with self.assertRaises(ValueError):
                    api.verify_stage({"scenario": "cosmosnative"}, stage, count)
                parent.assert_not_called()

    def test_native_serve_requires_actual_approval_before_session_effects(self):
        with mock.patch.object(api.multivm_evidence, "read_approval", side_effect=ValueError("coordinator execution approval missing")) as approve, mock.patch.object(api.multivm_session, "Session") as session:
            with self.assertRaisesRegex(ValueError, "approval missing"):
                api.serve({"scenario": "cosmosnative"})
            approve.assert_called_once()
            session.assert_not_called()

    def test_other_family_serve_and_capture_are_still_blocked(self):
        for name in set(api.SCENARIOS) - {"cosmosnative", "evm", "cosmwasm"}:
            with self.subTest(scenario=name), mock.patch.object(api.multivm_evidence, "read_approval") as approval, mock.patch.object(api.multivm_evidence, "verify_harness_parent") as parent:
                with self.assertRaisesRegex(ValueError, "not enabled"):
                    api.serve({"scenario": name})
                with self.assertRaisesRegex(ValueError, "not enabled"):
                    api.capture_stage({"scenario": name}, {"harness_pid": 11})
                approval.assert_not_called()
                parent.assert_not_called()

    def test_enabled_construction_does_not_grant_execution_or_shorten_lifecycle(self):
        with mock.patch.object(api, "validate_manifest"):
            plan = api.construction_plan({"scenario": "cosmosnative", "runtime_source_commit": "a" * 40, "mode": "ReleaseSafe", "artifacts": {}, "harness_deadline_seconds": 3600}, "cosmosnative")
        self.assertIs(plan["family_verifier_implemented"], True)
        self.assertIs(plan["execution_authorized_by_preparation"], False)
        self.assertIs(plan["passed"], False)
        self.assertEqual((plan["actual_production_confirm_seconds"], plan["actual_production_finality_grace_seconds"]), (600, 30))


if __name__ == "__main__":
    unittest.main()
