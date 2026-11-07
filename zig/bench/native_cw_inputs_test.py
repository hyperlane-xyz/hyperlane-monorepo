"""CW profile schema parity. No CLI, chain, database, remote RPC or SDK executes."""
import copy
import importlib.util
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('cw_inputs',ROOT/'zig/integration/native_case_inputs.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)


class CwProfileTests(unittest.TestCase):
    def test_source_four_message_domains_keep_only_exact_approved_fallback_notice(self):
        case=m.public_profile('cosmwasm');self.assertEqual(case['chain_names'],['cosmostest99990','cosmostest99991'])
        self.assertEqual(case['initial_corpus'],{'dispatches':4,'deliveries':4,'zero_insertions':0,'failed_body':0,'double_insertions':0})
        session=m.load_module('cw_actual_session_profile','zig/integration/multivm_session.py')
        approval={'expected_unavailable_endpoints':case['expected_unavailable_endpoints']}
        rows=session.cw_expected_unavailable_definitions({'scenario':'cosmwasm'},case,approval)
        self.assertEqual(len(rows),2);self.assertEqual([row['healthy_fallback'] for row in rows],['http://127.0.0.1:26603','http://127.0.0.1:26613'])
        for change in [lambda c:c['expected_unavailable_endpoints']['endpoints'][0].update(ordinal=1),lambda c:c['expected_unavailable_endpoints']['endpoints'][0].update(upstream='http://localhost:1338'),lambda c:c.update(scenario='cosmosnative')]:
            bad=copy.deepcopy(case);change(bad)
            with self.subTest(case=bad),self.assertRaises(ValueError):session.cw_expected_unavailable_definitions({'scenario':'cosmwasm'},bad,{'expected_unavailable_endpoints':bad['expected_unavailable_endpoints']})
        with self.assertRaises(ValueError):session.cw_expected_unavailable_definitions({'scenario':'cosmwasm'},case,{})

    def test_native_cosmos_and_evm_profiles_never_inherit_cw_contract_or_unavailable_notice(self):
        for scenario in ['cosmosnative','evm']:
            profile=m.public_profile(scenario);self.assertNotIn('fixture_contracts',profile);self.assertNotIn('expected_unavailable_endpoints',profile)
        self.assertEqual(m.public_profile('cosmosnative')['initial_corpus']['dispatches'],8)
        self.assertEqual(m.public_profile('evm')['initial_corpus']['dispatches'],31)

    def test_static_cw_source_has_no_module_acquisition_or_loader_override(self):
        setup=(ROOT/'zig/bench/native_case_setup.py').read_text();inputs=(ROOT/'zig/integration/native_case_inputs.py').read_text()
        self.assertNotIn('wasmvm-module.zip',setup);self.assertNotIn('module-zip',setup)
        self.assertNotIn('LD_LIBRARY_PATH',setup);self.assertNotIn('LD_LIBRARY_PATH',inputs)
        self.assertIn('static_cli',setup);self.assertIn("keys |= {'wasm_bundle', 'static_cli'}",inputs)
        self.assertIn("cw_assets.tendermint_version(compat)",setup)

    def test_cw_missing_static_cli_or_bundle_is_not_native_cosmos_empty_stage(self):
        keys={'schema':1,'passed':True,'execution_source_commit':'a'*40,'scenario':'cosmwasm','source_before':{'synthetic':'same'},'source_after':{'synthetic':'same'},'checks':[],'tools':{},'contract_artifacts':{},'hpack':{},'registry':{'path':None,'commit':None},'explicit_environment':{}}
        context={'scenario':'cosmwasm','execution_source_commit':'a'*40}
        for extra in [{},{'static_cli':{}},{'wasm_bundle':{}},{'static_cli':{},'wasm_bundle':{},'unknown':True}]:
            with self.subTest(fields=extra),self.assertRaisesRegex(ValueError,'Exact successful local-stage'):m.validate_stage({**keys,**extra},context,{})


if __name__=='__main__':unittest.main()
