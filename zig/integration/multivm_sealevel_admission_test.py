"""Deferred SVM admission controls. No compiler, SDK, node or elapsed credit."""
import importlib.util
import pathlib
import unittest
from unittest import mock
HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("multivm_process_svm_admission", HERE / "multivm_process.py")
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)
class SealevelAdmission(unittest.TestCase):
    def test_only_two_svm_entries_added_without_execution_credit(self):
        self.assertTrue({"cosmosnative", "evm", "cosmwasm", "sealevel", "sealevel-composite"} <= set(api.FAMILY_VERIFIERS))
        for scenario in ["sealevel", "sealevel-composite"]:
            self.assertIs(api.FAMILY_VERIFIERS[scenario], api.session_verifier)
            with mock.patch.object(api, "validate_manifest"):
                row = api.construction_plan({"scenario":scenario,"runtime_source_commit":"5"*40,"mode":"ReleaseSafe","artifacts":{},"harness_deadline_seconds":3600}, scenario)
            self.assertIs(row["passed"], False)
            self.assertIs(row["execution_authorized_by_preparation"], False)
            self.assertEqual((row["actual_production_confirm_seconds"], row["actual_production_finality_grace_seconds"]), (600,30))
    def test_exact_configured_role_delivery_counts_and_strict_boolean(self):
        for scenario, count in [("sealevel",12),("sealevel-composite",2)]:
            for reply, expected in [({"verified":True},True),({"verified":False},False),({"verified":1},False),({"passed":True},False)]:
                with self.subTest(scenario=scenario,reply=reply), mock.patch.object(api,"validate_manifest"), mock.patch.object(api.multivm_evidence,"verify_harness_parent",return_value={"pid":11}), mock.patch.object(api,"controller_request",return_value=reply) as controller:
                    self.assertIs(api.verify_stage({"scenario":scenario},"live",count),expected)
                    controller.assert_called_once_with({"scenario":scenario},"verify",{"stage":"live","expected":count,"harness_parent":{"pid":11}})
    def test_other_families_stay_closed_before_parent_or_controller(self):
        for scenario in set(api.SCENARIOS)-{"cosmosnative","evm","cosmwasm","sealevel","sealevel-composite"}:
            with mock.patch.object(api,"validate_manifest"), mock.patch.object(api.multivm_evidence,"verify_harness_parent") as parent, mock.patch.object(api,"controller_request") as controller, mock.patch.dict(api.FAMILY_VERIFIERS):
                api.FAMILY_VERIFIERS.pop(scenario,None)
                with self.assertRaisesRegex(ValueError,"no node may start"): api.verify_stage({"scenario":scenario},"preflight",0)
                parent.assert_not_called();controller.assert_not_called()
    def test_missing_approval_cannot_construct_session(self):
        for scenario in ["sealevel","sealevel-composite"]:
            with mock.patch.object(api.multivm_evidence,"read_approval",side_effect=ValueError("execution approval missing")), mock.patch.object(api.multivm_session,"Session") as session:
                with self.assertRaisesRegex(ValueError,"approval missing"):api.serve({"scenario":scenario})
                session.assert_not_called()
if __name__ == "__main__": unittest.main()
