"""TRE admission/case controls. No node, daemon, SDK, or deployment execution."""
import copy
import importlib.util
import pathlib
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('multivm_tron_admission', HERE / 'multivm_process.py')
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)

class TronAdmission(unittest.TestCase):
    def case(self):
        signer = '0xc8599111f29c1e1e061265b4af93ea1f274ad78a'
        return {'schema':1, 'scenario':'tron', 'chain_names':['anvil1','anvil2'],
            'domain_names':{'1212538670':'anvil1','1212538671':'anvil2'},
            'initial_corpus':{'dispatches':4,'deliveries':4,'zero_insertions':0,'failed_body':0,'double_insertions':0},
            'payments_supported':True,'additional_refused_dispatches':0,
            'validator_addresses':dict.fromkeys(['anvil1','anvil2'],signer),
            'relayer_addresses':dict.fromkeys(['anvil1','anvil2'],'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH')}

    def test_tre_route_is_preparation_not_execution_or_elapsed_credit(self):
        self.assertIs(api.FAMILY_VERIFIERS['tron'],api.session_verifier)
        with mock.patch.object(api,'validate_manifest'):
            p=api.construction_plan({'scenario':'tron','runtime_source_commit':'a'*40,'mode':'ReleaseSafe','artifacts':{},'harness_deadline_seconds':3600},'tron')
        self.assertIs(p['family_verifier_implemented'],True)
        self.assertIs(p['execution_authorized_by_preparation'],False)
        self.assertIs(p['passed'],False)
        self.assertEqual((p['actual_production_confirm_seconds'],p['actual_production_finality_grace_seconds']),(600,30))

    def test_tre_native_route_keeps_real_parent_and_boolean_verification(self):
        for reply,want in [({'verified':True},True),({'verified':False},False),({'verified':1},False),({'passed':True},False)]:
            with self.subTest(reply=reply),mock.patch.object(api,'validate_manifest'),mock.patch.object(api.multivm_evidence,'verify_harness_parent',return_value={'pid':11})as parent,mock.patch.object(api,'controller_request',return_value=reply):
                self.assertIs(api.verify_stage({'scenario':'tron'},'live',4),want)
                self.assertEqual(parent.call_count,2)

    def test_tre_source_case_exact_four_corpi_domains_and_public_signers(self):
        c=self.case();api.multivm_session.validate_evm_case({'scenario':'tron'},c)
        for key,value in [('chain_names',['anvil2','anvil1']),('domain_names',{'1':'anvil1','2':'anvil2'}),('initial_corpus',{'dispatches':8,'deliveries':8,'zero_insertions':0,'failed_body':0,'double_insertions':0}),('additional_refused_dispatches',1),('payments_supported',False),('validator_addresses',dict.fromkeys(['anvil1','anvil2'],'0x'+'12'*20)),('relayer_addresses',dict.fromkeys(['anvil1','anvil2'],'0x'+'12'*20))]:
            changed=copy.deepcopy(c);changed[key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):api.multivm_session.validate_evm_case({'scenario':'tron'},changed)

    def test_tre_wrong_parent_or_missing_approval_stops_before_controller(self):
        with mock.patch.object(api,'validate_manifest'),mock.patch.object(api.multivm_evidence,'verify_harness_parent',side_effect=ValueError('wrong parent')),mock.patch.object(api,'controller_request')as controller:
            with self.assertRaisesRegex(ValueError,'wrong parent'):api.verify_stage({'scenario':'tron'},'final',4)
            controller.assert_not_called()
        with mock.patch.object(api.multivm_evidence,'read_approval',side_effect=ValueError('approval absent')),mock.patch.object(api.multivm_session,'Session')as session:
            with self.assertRaisesRegex(ValueError,'approval absent'):api.serve({'scenario':'tron'})
            session.assert_not_called()

    def test_future_family_isolated_blocked_route_remains_fail_closed(self):
        for name in api.SCENARIOS:
            with self.subTest(name=name),mock.patch.dict(api.FAMILY_VERIFIERS),mock.patch.object(api.multivm_evidence,'read_approval')as approve:
                api.FAMILY_VERIFIERS.pop(name,None)
                with self.assertRaisesRegex(ValueError,'not enabled'):api.serve({'scenario':name})
                approve.assert_not_called()

if __name__=='__main__':unittest.main()
