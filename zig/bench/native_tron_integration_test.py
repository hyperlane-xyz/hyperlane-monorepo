"""Portable Tron selector/setup/profile/wait/public-DTo controls; no native case."""
import copy,importlib.util,json,pathlib,tempfile,unittest
from unittest import mock
ROOT=pathlib.Path(__file__).resolve().parents[2]
def load(name,relative):
 spec=importlib.util.spec_from_file_location(name,ROOT/relative);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
assets=load('tron_int_assets','zig/bench/native_tron_assets.py');recipe=load('tron_int_recipe','zig/bench/native_tron_setup.py');inputs=load('tron_int_inputs','zig/integration/native_case_inputs.py');owner=load('tron_int_owner','zig/bench/native_case_owner.py');dispatch=load('tron_int_dispatch','zig/bench/native_case_ci.py');setup=load('tron_int_setup','zig/bench/native_case_setup.py');fixtures=load('tron_int_fixtures','zig/bench/native_tron_test.py');owner_fixtures=load('tron_int_owner_fixtures','zig/bench/native_case_owner_test.py')
import sys
saved_path=list(sys.path)
try:
 sys.path.insert(0,str(ROOT/'zig/integration'))
 import multivm_evidence
 import multivm_session
finally:sys.path[:]=saved_path
class Integration(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=pathlib.Path(self.temp.name).resolve()
 def request(self):
  r={'schema':1,'root_approved':True,'scenario':'tron','mode':'ReleaseSafe','producer_source_commit':'a'*40,'producer_run_id':42,'producer_run_attempt':1,'limits':dict(dispatch.LIMITS),'postgres':{'schema':2,'architecture':'amd64','image':'postgres:14','image_id':'sha256:'+'d'*64,'canonical_digest':'postgres@sha256:'+'e'*64},'prerequisites':{'local_checkout_build':True,'registry_commit':None,'hpack':{'version':'4.2.0','wheel_sha256':'858ac0b02280fa582b5080d68db0899c6' '2a80375e0e5413a74970c5e518b6986','wheel_bytes':34246},'tron_cli':dict(assets.CLI_POLICY),'tron_tre':{'schema':2,'architecture':'amd64','source_image':assets.SOURCE_IMAGE,'canonical_digest':assets.SOURCE_IMAGE,'image_id':assets.IMAGE_IDS['amd64'],'command':assets.COMMAND,'entrypoint':None}}};r['artifact_pins']={key:{'id':index,'name':name,'sha256':'b'*64,'size_in_bytes':1024}for index,(key,name)in enumerate(dispatch.artifact_names(r).items(),1)};return r
 def test_explicit_Tron_request_retains_same_five_compiled_producer_artifacts(self):self.assertEqual(dispatch.validate_request(self.request())['scenario'],'tron')
 def test_false_approval_does_not_start_route(self):
  r=self.request();r['root_approved']=False
  with self.assertRaises(ValueError):dispatch.validate_request(r)
  dispatch.validate_request(r,require_approved=False)
 def test_unknown_or_Mac_or_crossed_image_policy_reject(self):
  for change in[lambda r:r['prerequisites'].update(extra=True),lambda r:r['prerequisites']['tron_tre'].update(image_id='sha256:'+'f'*64),lambda r:r['prerequisites']['tron_cli'].update(full_original_tsconfig=1),lambda r:r['prerequisites'].update(native_cli={})]:
   r=self.request();change(r)
   with self.assertRaises(ValueError):dispatch.validate_request(r)
 def test_exact_Source_four_corpi_and_actual_signer(self):
  import multivm_session
  c=inputs.public_profile('tron');multivm_session.validate_evm_case({'scenario':'tron'},c);self.assertEqual(c['initial_corpus']['deliveries'],4);self.assertNotIn('reorg_origin_chain',c)
 def test_other_family_profile_unchanged(self):
  self.assertEqual(inputs.public_profile('cosmosnative')['initial_corpus']['dispatches'],8);self.assertEqual(inputs.public_profile('starknet')['initial_corpus']['dispatches'],10);self.assertEqual(inputs.public_profile('evm')['additional_refused_dispatches'],1)
 def test_original_full_CLI_build_graph_and_new_manager_syntax(self):
  fixture=fixtures.Assets();fixture.setUp();self.addCleanup(fixture.doCleanups);repo=fixture.workspace();tools={name:pathlib.Path('/owned')/name for name in['pnpm','node','forge','sh']};stage=self.root/'stage';original=setup.build_commands(repo,tools,stage);commands=recipe.build_commands(repo,tools,stage,{'packages':setup.PACKAGES,'commands':original});install=commands[0]['argv'];self.assertEqual(install[install.index('--filter')+1],'@hyperlane-xyz/cli...');self.assertIn('--frozen-lockfile',install);self.assertIn('--ignore-scripts',install);self.assertIn('--config.cache-dir='+str(stage/'cache'),install);self.assertNotIn('--cache-dir',install);self.assertEqual(commands[-1]['argv'],['/owned/pnpm','exec','tsc','--project','tsconfig.json']);self.assertTrue(all(not any(x in{'turbo','version:update','prebuild','ncc'}for x in row['argv'])for row in commands));self.assertEqual([r['name']for r in commands[1:-1]],[r['name']for r in original[1:]])
 def test_missing_actual_compiler_metadata_never_passes(self):
  with self.assertRaises(ValueError):recipe.compiler_outputs(self.root)
 def test_exact_EVM_and_TVM_actual_build_metadata_versions(self):
  for relative,version in [('solidity/artifacts/build-info','0.8.33'),('solidity/artifacts-tron/build-info','0.8.24')]:
   p=self.root/relative;p.mkdir(parents=True);(p/'fixture.json').write_text(json.dumps({'solcVersion':version,'input':{'sources':{'actual.sol':{}}},'output':{'contracts':{'actual.sol':{}}}}))
  self.assertEqual(set(recipe.compiler_outputs(self.root)),{'EVM','TVM'});p=self.root/'solidity/artifacts-tron/build-info/fixture.json';v=json.loads(p.read_text());v['solcVersion']='0.8.33';p.write_text(json.dumps(v))
  with self.assertRaises(ValueError):recipe.compiler_outputs(self.root)
 def waits(self):return[{'pid':i+100,'parent_pid':42,'role':'fixture-docker','parent_wait_completed':True,'forced_kill':False,'purpose':'fixture_teardown','already_exited':False,'success':True,'exit_code':0,'signal':None,'planned_container_stop':{'kind':kind}}for i,kind in enumerate(['tron','postgres'])]
 def waitfile(self,rows):p=self.root/'waits.jsonl';p.write_text(''.join(json.dumps(r)+'\n'for r in rows));return p
 def test_two_real_foreground_waits_not_generic_three(self):self.assertEqual(len(owner.fixture_waits(self.waitfile(self.waits()),'tron',42)),2)
 def test_missing_repeated_wrong_parent_or_Kathy_wait_rejects(self):
  for change in[lambda r:r.pop(),lambda r:r.append(copy.deepcopy(r[0])),lambda r:r[0].update(parent_pid=99),lambda r:r[0].update(role='fixture-kathy'),lambda r:r[0].update(role='fixture-anvil'),lambda r:r[0]['planned_container_stop'].update(kind='postgres')]:
   rows=self.waits();change(rows)
   with self.assertRaises(ValueError):owner.fixture_waits(self.waitfile(rows),'tron',42)
 def test_early_or_forced_or_boolean_or_failed_foreground_stop_rejects(self):
  for key,val in[('already_exited',True),('forced_kill',True),('success',False),('exit_code',False),('exit_code',1),('signal',9)]:
   rows=self.waits();rows[0][key]=val
   with self.assertRaises(ValueError):owner.fixture_waits(self.waitfile(rows),'tron',42)
 def chain(self):return{'chainid':3360022319,'domainid':1212538670,'rpcurls':[{'http':'http://127.0.0.1:9090/jsonrpc'}],'walleturls':[{'http':'http://127.0.0.1:9090/wallet'}],'walletsolidityurls':[{'http':'http://127.0.0.1:9090/walletsolidity'}]}
 def test_only_actual_TRE9090_three_protocol_authorities(self):
  import multivm_evidence
  multivm_evidence.validate_tron_chain_authorities(self.chain())
 def test_crossed_wallet_path_port_fallback_or_shadow_field_rejects(self):
  import multivm_evidence
  for change in[lambda c:c.update(walleturls=[{'http':'http://127.0.0.1:9090/jsonrpc'}]),lambda c:c.update(rpcurls=[{'http':'http://127.0.0.1:9091/jsonrpc'}]),lambda c:c['walleturls'].append({'http':'http://127.0.0.1:9090/wallet'}),lambda c:c.update(customrpcurls=[{'http':'http://127.0.0.1:9090/jsonrpc'}]),lambda c:c.update(chainid=31337)]:
   c=self.chain();change(c)
   with self.assertRaises(ValueError):multivm_evidence.validate_tron_chain_authorities(c)
 def tron_snapshot(self):
  snapshot=owner_fixtures.CaseOwnerTests().public_snapshot_fixture();snapshot['scenario']='tron';tx=snapshot['native_delivery_transactions'][0]['transaction_hash'];identity=snapshot['native_operations'][0]['id'];signed=snapshot['native_operations'][0]['operation']['signed'];native={'identity':tx,'signer':'0x'+'ab'*20,'target':'0x'+'cd'*20,'actual_sdk_signed_wire':signed,'actual_native_fee_sun':123,'recorded_gas_used':10,'recorded_tokens_used':20,'context':'0x'+'ef'*32,'expected_context_checked':True,'private':'DO-NOT-EXPORT-TRON-PRIVATE'};snapshot['native_operations'][0]['actual_native_crypto']=native
  receipt={'id':tx[2:],'blockNumber':7,'fee':123,'receipt':{'result':'SUCCESS','energy_usage_total':10},'raw_data_hex':'DO-NOT-EXPORT-WALLET-RAW','signature':['DO-NOT-EXPORT-WALLET-SIGNATURE']};proof=snapshot['native_delivery_transactions'][0]['proof'];proof.update(native_fee_sun=123,native_wallet_receipt=copy.deepcopy(receipt),native_solidity_receipt=copy.deepcopy(receipt),native_solidity_block={'blockID':'ab'*32,'block_header':{'raw_data':{'number':7}},'transactions':[{'txID':tx[2:],'raw_data_hex':'DO-NOT-EXPORT-BLOCK-RAW','signature':['DO-NOT-EXPORT-BLOCK-SIG']}]});return snapshot
 def test_public_Tron_native_fees_and_signature_fingerprint_without_wallet_payloads(self):
  v=owner.public_native_snapshot(self.tron_snapshot());encoded=json.dumps(v);self.assertNotIn('DO-NOT-EXPORT',encoded);crypto=v['native_operations'][0]['actual_Tron_native_crypto'];self.assertEqual(crypto['actual_native_fee_sun'],123);self.assertFalse(crypto['configuration_authority_independently_recomputed']);self.assertIn('sdk_signed_wire_fingerprint',crypto);self.assertEqual(v['native_delivery_transactions'][0]['canonical']['native_solidity_block']['exact_transaction_membership'],1)
 def test_public_native_fee_or_wallet_identity_mismatch_rejects(self):
  for change in[lambda v:v['native_delivery_transactions'][0]['proof'].update(native_fee_sun=0),lambda v:v['native_delivery_transactions'][0]['proof']['native_wallet_receipt'].update(id='00'*32),lambda v:v['native_operations'][0]['actual_native_crypto'].update(signer='DO-NOT-EXPORT')]:
   v=self.tron_snapshot();change(v)
   with self.assertRaises(ValueError):owner.public_native_snapshot(v)
 def test_public_original600_630_and_restart30_witness_still_retained(self):
  v=self.tron_snapshot();out=owner.public_native_snapshot(v);self.assertEqual(out['same_db_restart_observation']['minimum_live_ns'],30*10**9);self.assertEqual(len(out['same_db_restart_observation']['samples']),7);v['per_id_lifecycle'][0]['retired_monotonic_ns']-=10*10**9
  with self.assertRaises(ValueError):owner.public_native_snapshot(v)
if __name__=='__main__':unittest.main(verbosity=2)
