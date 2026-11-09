"""TRE admission/case controls. No node, daemon, SDK, or deployment execution."""
import copy
import importlib.util
import pathlib
import json
import tempfile
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

    def test_source_wallet_aliases_are_captured_for_all_three_roles_and_intercepted(self):
        evidence=api.multivm_evidence
        source=(HERE.parents[1]/'rust/main/utils/run-locally/src/tron/mod.rs').read_text()
        helper=source[source.index('fn with_tron_wallet_env('):source.index('fn run_locally()')]
        for suffix,constant in [('CUSTOMWALLETURLS','TRON_WALLET_URL'),('CUSTOMWALLETSOLIDITYURLS','TRON_WALLET_SOLIDITY_URL')]:
            self.assertIn('format!("CHAINS_{}_'+suffix+'", upper)',helper)
            self.assertIn(constant,helper)
        with tempfile.TemporaryDirectory(prefix='ziggy-tre-alias-pure-')as directory:
            root=pathlib.Path(directory);(root/'config').mkdir()
            chain={'protocol':'tron','chainId':3360022319,'rpcUrls':[{'http':'http://127.0.0.1:9090/jsonrpc'}],'walletUrls':[{'http':'http://127.0.0.1:9090/wallet'}],'walletSolidityUrls':[{'http':'http://127.0.0.1:9090/walletsolidity'}]}
            chains={name:dict(chain,name=name,domainId=1212538670+index)for index,name in enumerate(['anvil1','anvil2'])}
            (root/'config'/'fixture.json').write_text(json.dumps({'chains':chains}))
            case=root/'case.json';case.write_text(json.dumps({'chain_names':['anvil1','anvil2']}))
            manifest={'scenario':'tron','runtime_source_commit':'a'*40,'case_inputs':{'path':str(case),'bytes':case.stat().st_size,'sha256':evidence.sha(case)}}
            for role,selector,names in [('validator','ORIGINCHAINNAME','anvil1'),('relayer','RELAYCHAINS','anvil1,anvil2'),('scraper','CHAINSTOSCRAPE','anvil1,anvil2')]:
                environment={'HYP_'+selector:names}
                for name in chains:
                    environment['HYP_CHAINS_'+name.upper()+'_CUSTOMWALLETURLS']='http://127.0.0.1:9090/wallet'
                    environment['HYP_CHAINS_'+name.upper()+'_CUSTOMWALLETSOLIDITYURLS']='http://127.0.0.1:9090/walletsolidity'
                request={'schema':1,'scenario':'tron','runtime_source_commit':'a'*40,'role':role,'cwd':str(root),'environment':environment,'arguments':[],'selected_chain_names':['anvil1','anvil2'],'harness_pid':42}
                with self.subTest(role=role):
                    captured=evidence.effective_config(request,manifest)
                    expected={'rpcurls','walleturls','walletsolidityurls','customwalleturls','customwalletsolidityurls'}
                    self.assertTrue(all(set(value)&evidence.ENDPOINT_FIELDS==expected for value in captured['chains'].values()))
                    replacements={(name,field):['http://127.0.0.1:'+str(19000+index)]for index,(name,field)in enumerate((name,field)for name in chains for field in sorted(expected))}
                    replacement_env,proxied=evidence.endpoint_replacements(captured,replacements)
                    for name in chains:
                        self.assertEqual(evidence.urls(proxied['chains'][name]['customwalleturls']),replacements[name,'customwalleturls'])
                        self.assertIn('HYP_CHAINS_'+name.upper()+'_CUSTOMWALLETSOLIDITYURLS',replacement_env)
                    missing=dict(replacements);missing.pop(('anvil1','customwalleturls'))
                    with self.assertRaisesRegex(ValueError,'every original'):evidence.endpoint_replacements(captured,missing)

    def test_wallet_alias_authorities_never_allow_foreign_host_path_fallback_or_field(self):
        evidence=api.multivm_evidence
        chain={'chainid':'3360022319','domainid':'1212538670','rpcurls':[{'http':'http://127.0.0.1:9090/jsonrpc'}],'walleturls':[{'http':'http://127.0.0.1:9090/wallet'}],'walletsolidityurls':[{'http':'http://127.0.0.1:9090/walletsolidity'}],'customwalleturls':'http://127.0.0.1:9090/wallet','customwalletsolidityurls':'http://127.0.0.1:9090/walletsolidity'}
        evidence.validate_tron_chain_authorities(chain)
        for field in ['rpcurls','walleturls','walletsolidityurls']:
            changed=copy.deepcopy(chain);changed.pop(field)
            with self.subTest(missing=field),self.assertRaises(ValueError):evidence.validate_tron_chain_authorities(changed)
        for field in ['customwalleturls','customwalletsolidityurls']:
            for value in ['http://outside.invalid:9090/wallet','http://127.0.0.1:9091/wallet','http://127.0.0.1:9090/jsonrpc','http://127.0.0.1:9090/wallet,http://127.0.0.1:9090/wallet']:
                changed=copy.deepcopy(chain);changed[field]=value
                with self.subTest(field=field,value=value),self.assertRaises(ValueError):evidence.validate_tron_chain_authorities(changed)
        for field in evidence.ENDPOINT_FIELDS-set(chain):
            changed=copy.deepcopy(chain);changed[field]='http://127.0.0.1:9090/wallet'
            with self.subTest(extra=field),self.assertRaises(ValueError):evidence.validate_tron_chain_authorities(changed)
        for field,value in [('chainid','1'),('domainid','1')]:
            changed=copy.deepcopy(chain);changed[field]=value
            with self.subTest(field=field),self.assertRaises(ValueError):evidence.validate_tron_chain_authorities(changed)

if __name__=='__main__':unittest.main()
