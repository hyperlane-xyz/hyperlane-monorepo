"""CW-only dispatch controls. No native SDK, node, or daemon process."""
import importlib.util
import pathlib
import unittest
from unittest import mock
HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('multivm_process_cw_admission', HERE / 'multivm_process.py')
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)
class CosmosWasmAdmission(unittest.TestCase):
    def test_reviewed_cw_route_is_not_execution_or_elapsed_credit(self):
        self.assertIs(api.FAMILY_VERIFIERS['cosmwasm'], api.session_verifier)
        with mock.patch.object(api, 'validate_manifest'):
            row = api.construction_plan({'scenario':'cosmwasm','runtime_source_commit':'d51ca8d668b26a3fdd248b4dfa99609bdcd6e493','mode':'ReleaseSafe','artifacts':{},'harness_deadline_seconds':3600}, 'cosmwasm')
        self.assertIs(row['family_verifier_implemented'], True)
        self.assertIs(row['execution_authorized_by_preparation'], False)
        self.assertIs(row['passed'], False)
        self.assertEqual((row['actual_production_confirm_seconds'],row['actual_production_finality_grace_seconds']),(600,30))
    def test_cw_route_requires_true_verification_and_exact_four_source_messages(self):
        for reply,expected in [({'verified':True},True),({'verified':False},False),({'verified':1},False),({'passed':True},False)]:
            with self.subTest(reply=reply), mock.patch.object(api,'validate_manifest'), mock.patch.object(api.multivm_evidence,'verify_harness_parent',return_value={'pid':11}), mock.patch.object(api,'controller_request',return_value=reply) as controller:
                self.assertIs(api.verify_stage({'scenario':'cosmwasm'},'live',4),expected)
                controller.assert_called_once_with({'scenario':'cosmwasm'},'verify',{'stage':'live','expected':4,'harness_parent':{'pid':11}})
    def test_unreviewed_families_remain_blocked_before_capture_or_parent(self):
        for name in set(api.SCENARIOS)-{'cosmosnative','evm','cosmwasm'}:
            with self.subTest(scenario=name), mock.patch.object(api,'validate_manifest'), mock.patch.object(api.multivm_evidence,'verify_harness_parent') as parent, mock.patch.object(api,'controller_request') as controller:
                with self.assertRaisesRegex(ValueError,'no node may start'):api.verify_stage({'scenario':name},'preflight',0)
                parent.assert_not_called();controller.assert_not_called()
    def test_cw_approval_failure_precedes_session_side_effect(self):
        with mock.patch.object(api.multivm_evidence,'read_approval',side_effect=ValueError('execution approval missing')), mock.patch.object(api.multivm_session,'Session') as session:
            with self.assertRaisesRegex(ValueError,'approval missing'):api.serve({'scenario':'cosmwasm'})
            session.assert_not_called()
if __name__ == '__main__':unittest.main()
