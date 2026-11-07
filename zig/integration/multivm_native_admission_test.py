"""Closed eight-family route selection; never grants execution/elapsed credit."""
import importlib.util
import pathlib
import unittest
from unittest import mock
HERE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('native_all_admission',HERE/'multivm_process.py')
api=importlib.util.module_from_spec(spec);spec.loader.exec_module(api)

class NativeAdmission(unittest.TestCase):
    def test_exact_eight_source_families_only_with_no_execution_preparation(self):
        expected={'evm','cosmwasm','cosmosnative','sealevel','sealevel-composite','starknet','radix','tron'}
        self.assertEqual(set(api.SCENARIOS),expected);self.assertEqual(set(api.FAMILY_VERIFIERS),expected)
        for scenario in expected:
            self.assertIs(api.FAMILY_VERIFIERS[scenario],api.session_verifier)
            with mock.patch.object(api,'validate_manifest'):
                plan=api.construction_plan({'scenario':scenario,'runtime_source_commit':'a'*40,'mode':'ReleaseSafe','artifacts':{},'harness_deadline_seconds':3600},scenario)
            self.assertIs(plan['passed'],False);self.assertIs(plan['execution_authorized_by_preparation'],False)
            self.assertEqual((plan['actual_production_confirm_seconds'],plan['actual_production_finality_grace_seconds']),(600,30))
        with mock.patch.object(api,'validate_manifest'),self.assertRaises(ValueError):api.construction_plan({'scenario':'aleo'},'aleo')

    def test_every_selected_family_needs_actual_approval_before_session_side_effects(self):
        for scenario in api.SCENARIOS:
            with self.subTest(scenario=scenario),mock.patch.object(api.multivm_evidence,'read_approval',side_effect=ValueError('approval absent')),mock.patch.object(api.multivm_session,'Session')as session:
                with self.assertRaisesRegex(ValueError,'approval absent'):api.serve({'scenario':scenario})
                session.assert_not_called()

    def test_every_family_keeps_real_parent_and_strict_controller_verified_boolean(self):
        for scenario in api.SCENARIOS:
            for reply,want in [({'verified':True},True),({'verified':False},False),({'verified':1},False),({'passed':True},False)]:
                with self.subTest(scenario=scenario,reply=reply),mock.patch.object(api,'validate_manifest'),mock.patch.object(api.multivm_evidence,'verify_harness_parent',return_value={'pid':11})as parent,mock.patch.object(api,'controller_request',return_value=reply):
                    self.assertIs(api.verify_stage({'scenario':scenario},'preflight',0),want);self.assertEqual(parent.call_count,2)

if __name__=='__main__':unittest.main()
