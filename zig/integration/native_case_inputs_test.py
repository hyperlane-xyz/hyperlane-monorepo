import gzip,hashlib,importlib.util,json,pathlib,subprocess,tempfile,unittest,os,struct,copy
from unittest import mock
spec=importlib.util.spec_from_file_location('inputs',pathlib.Path(__file__).with_name('native_case_inputs.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Controls(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=pathlib.Path(self.tmp.name)
 def git(self,*args):return subprocess.check_output(['git',*args],cwd=self.root,text=True,stderr=subprocess.PIPE).strip()
 def repository(self):
  self.git('init','-q');self.git('config','user.name','Fixture');self.git('config','user.email','fixture@example.invalid');self.git('config','core.hooksPath','/dev/null')
  for n in ['zig/src/root.zig','zig/native/Cargo.toml','zig/build.zig','rust/main/Cargo.toml','rust/sealevel/Cargo.toml','zig/reference/Cargo.toml']:
   p=self.root/n;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('source fixture')
  p=self.root/'zig/reference/Cargo.lock.gz';p.write_bytes(gzip.compress(b'canonical lock',mtime=0));(p.parent/'Cargo.lock').write_bytes(b'canonical lock');(self.root/'.gitignore').write_text('Cargo.lock\n')
  self.git('add','.');self.git('commit','-qm','fixture initial');return self.git('rev-parse','HEAD')
 def test_ci_only_git_change_preserves_all_three_exact_scopes(self):
  r=self.repository();(self.root/'CI.txt').write_text('CI-only');self.git('add','CI.txt');self.git('commit','-qm','CI fixture');c=self.git('rev-parse','HEAD');logs=[]
  for f in m.SCOPES:
   values=m.cohort(self.root,r,c,f,logs);self.assertTrue(all(v['worktree_unchanged']for v in values))
  self.assertTrue(logs);self.assertTrue(all(v['actual_parent_wait']for v in logs));self.assertTrue(any(v['exit_code']!=0 for v in logs))
 def test_actual_compiled_scope_change_rejects(self):
  r=self.repository();(self.root/'zig/src/root.zig').write_text('changed');self.git('add','.');self.git('commit','-qm','source changed')
  with self.assertRaisesRegex(ValueError,'scope differs'):m.cohort(self.root,r,self.git('rev-parse','HEAD'),'runtime')
 def test_uncommitted_compiled_input_rejects(self):
  r=self.repository();(self.root/'rust/main/Cargo.toml').write_text('dirty')
  with self.assertRaisesRegex(ValueError,'Dirty compiled'):m.cohort(self.root,r,r,'helper')
 def test_untracked_optional_absent_scope_shadow_rejects(self):
  r=self.repository();(self.root/'zig/build.zig.zon').write_text('untracked shadow')
  with self.assertRaisesRegex(ValueError,'absent or untracked'):m.cohort(self.root,r,r,'runtime')
 def test_actual_decoded_lock_matches_canonical_gzip(self):
  self.repository();logs=[];rows=m.decoded_locks(self.root,logs);self.assertEqual(len(rows),1);self.assertEqual(rows[0]['working']['sha256'],hashlib.sha256(b'canonical lock').hexdigest());self.assertTrue(logs)
 def test_mutated_ignored_decoded_lock_rejects(self):
  self.repository();(self.root/'zig/reference/Cargo.lock').write_bytes(b'mutated lock')
  with self.assertRaisesRegex(ValueError,'differs from tracked canonical'):m.decoded_locks(self.root,[])
 def test_decoded_lock_symlink_rejects(self):
  self.repository();p=self.root/'zig/reference/Cargo.lock';p.unlink();p.symlink_to('/dev/null')
  with self.assertRaisesRegex(ValueError,'symlink'):m.decoded_locks(self.root,[])
 def test_absent_decoded_lock_does_not_restore_or_build(self):
  self.repository();p=self.root/'zig/reference/Cargo.lock';p.unlink();rows=m.decoded_locks(self.root,[]);self.assertIsNone(rows[0]['working']);self.assertFalse(p.exists())
 def test_copy_owned_executable_preserves_bytes_and_normalizes_mode(self):
  source=self.root/'input';source.write_bytes(b'public fixture');source.chmod(0o600);dest=self.root/'owned/tool';row=m.copy_verified(source,m.artifact(source),dest,0o755);self.assertEqual(row['sha256'],m.checksum(source));self.assertEqual(dest.stat().st_mode&0o777,0o755)
 def test_copy_collision_never_overwrites(self):
  source=self.root/'input';source.write_bytes(b'source');dest=self.root/'existing';dest.write_bytes(b'preserve')
  with self.assertRaisesRegex(ValueError,'must be new'):m.copy_verified(source,m.artifact(source),dest,0o755)
  self.assertEqual(dest.read_bytes(),b'preserve')
 def test_copy_changed_source_rejects_before_output(self):
  source=self.root/'input';source.write_bytes(b'source');row=m.artifact(source);source.write_bytes(b'changed');dest=self.root/'output'
  with self.assertRaisesRegex(ValueError,'before copy'):m.copy_verified(source,row,dest,0o755)
  self.assertFalse(dest.exists())
 def test_duplicate_json_keys_reject(self):
  p=self.root/'data.json';p.write_text('{"approved":false,"approved":true}')
  with self.assertRaisesRegex(ValueError,'Duplicate'):m.read_json(p)
 def test_artifact_member_escape_reject(self):
  for n in ['../escape','/absolute','a/../../outside','a\\b']:
   with self.subTest(n=n),self.assertRaises(ValueError):m.relative_file(self.root,n)
 def test_artifact_member_symlink_reject(self):
  (self.root/'link').symlink_to('/etc')
  with self.assertRaisesRegex(ValueError,'Symlink'):m.relative_file(self.root,'link/passwd')
class HelperCpuControls(unittest.TestCase):
 setUp=Controls.setUp
 def receipt(self):
  helper=self.root/'helper';(helper/'setup').mkdir(parents=True)
  path=helper/'setup/tools-platform.txt';path.write_text('flags: actual producer fixture')
  return {'artifacts':{'helper':{'directory':str(helper)}},'artifact_pins':{'helper_cpu':m.artifact(path)}}
 def test_exact_extracted_helper_cpu_descriptor_accepted(self):
  value=self.receipt();self.assertEqual(m.helper_cpu_input(value),pathlib.Path(value['artifact_pins']['helper_cpu']['path']))
 def test_other_pinned_cpu_file_cannot_weaken_producer_flags(self):
  value=self.receipt();alternate=self.root/'softer-cpu.txt';alternate.write_text('flags: baseline');value['artifact_pins']['helper_cpu']=m.artifact(alternate)
  with self.assertRaisesRegex(ValueError,'actual extracted producer'):m.helper_cpu_input(value)
 def test_same_bytes_at_other_path_are_not_producer_setup_identity(self):
  value=self.receipt();alternate=self.root/'same-cpu.txt';alternate.write_bytes(pathlib.Path(value['artifact_pins']['helper_cpu']['path']).read_bytes());value['artifact_pins']['helper_cpu']=m.artifact(alternate)
  with self.assertRaisesRegex(ValueError,'actual extracted producer'):m.helper_cpu_input(value)

class IsolatedImports(unittest.TestCase):
 def test_real_consumer_modules_load_under_isolated_python_with_path_restored(self):
  import sys
  previous=sys.path[:]
  module=m.load_module('actual_case_tools_control','zig/bench/native_case_tools.py')
  self.assertTrue(callable(module.load_manifest));self.assertEqual(sys.path,previous)
  module=m.load_module('actual_case_process_control','zig/integration/multivm_process.py')
  self.assertTrue(callable(module.validate_manifest));self.assertEqual(sys.path,previous)

class StageControls(unittest.TestCase):
 setUp=Controls.setUp
 git=Controls.git
 repository=Controls.repository
 def fixture_stage(self,scenario='evm'):
  commit=self.repository();tools={};wire=bytearray(1024);wire[:8]=b'\x7fELF\x02\x01\x01\x00';struct.pack_into('<HHIQQ',wire,16,3,62,1,0x400100,64);struct.pack_into('<HHH',wire,52,64,56,2);struct.pack_into('<IIQQQQQQ',wire,64,1,5,0,0x400000,0,len(wire),len(wire),4096);name=b'/lib64/ld-linux-x86-64.so.2\0';struct.pack_into('<IIQQQQQQ',wire,120,3,4,512,0,0,len(name),len(name),1);wire[512:512+len(name)]=name
  native=self.root/'native-tool';native.write_bytes(wire);native.chmod(0o755);tool=m.artifact(native)
  names={'cast','docker','psql','ps','lsof'}|({'anvil','node','pnpm_launcher','pnpm_native','sh','esbuild'}if scenario=='evm'else{'native_cli'})
  tools=dict.fromkeys(names,tool);contract=self.root/'public-contract.json';contract.write_text('{}')
  files=[]
  for i in range(14):
   f=self.root/('package-file-'+str(i));f.write_text('public package fixture');files.append(m.artifact(f))
  wheel=self.root/'public-wheel';wheel.write_bytes(b'public synthetic wheel');wp=m.artifact(wheel)
  dep={'accepted_test_dependency_setup':True,'version':'4.2.0','copied_interpreter':True,'no_extra_dependencies_or_package_hooks':True,'wheel':wp,'interpreter':tool,'venv_configuration':files[0],'source_metadata':files[1],'files':files}
  descriptor=self.root/'hpack.json';descriptor.write_text(json.dumps(dep))
  log=self.root/'check.log';log.write_text('actual test metadata fixture; no setup/node executed')
  stage={'schema':1,'passed':True,'execution_source_commit':commit,'scenario':scenario,'source_before':{'tracked':'fixture'},'source_after':{'tracked':'fixture'},'checks':[{'name':'fixture','exit_code':0,'actual_parent_wait':True,'log':m.artifact(log)}],'tools':tools,'contract_artifacts':{'contract':m.artifact(contract)}if scenario=='evm'else{},'hpack':m.artifact(descriptor),'registry':{'path':str(self.root),'commit':commit},'explicit_environment':{'PATH':'/usr/bin:/bin','REGISTRY_URI':str(self.root)}}
  if scenario != 'evm': stage['registry']={'path':None,'commit':None};stage['explicit_environment'].pop('REGISTRY_URI')
  libraries={k:tool for k in ['HYPERLANE_CURL_LIBRARY','HYPERLANE_CLOUD_CURL_LIBRARY','HYPERLANE_LIBCRYPTO_LIBRARY']};ll=self.root/'system-libraries.json';ll.write_text(json.dumps(libraries));stage['checks'].append({'name':'system-libraries','exit_code':0,'actual_parent_wait':True,'log':m.artifact(ll)});stage['explicit_environment'].update({k:v['path']for k,v in libraries.items()})
  context={'execution_source_commit':commit,'scenario':scenario,'consumer_cpu':{'architecture':'amd64'}};request={'prerequisites':{'registry_commit':commit,'hpack':{'wheel_bytes':wp['bytes'],'wheel_sha256':wp['sha256']},'native_cli':{'name':'hypd','architecture':'amd64','bytes':tool['bytes'],'sha256':tool['sha256']}}}
  return stage,context,request
 def validate(self,stage,context,request):
  with mock.patch.object(m.platform,'machine',return_value='x86_64'):return m.validate_stage(stage,context,request)
 def test_native_pnpm_same_actual_elf_accepted(self):
  stage,context,request=self.fixture_stage();self.assertTrue(self.validate(stage,context,request))
 def test_different_native_pnpm_launcher_rejects(self):
  stage,context,request=self.fixture_stage();f=self.root/'other-native';f.write_bytes(pathlib.Path(stage['tools']['pnpm_launcher']['path']).read_bytes());f.chmod(0o755);stage['tools']['pnpm_launcher']=m.artifact(f)
  with self.assertRaisesRegex(ValueError,'exact approved native'):self.validate(stage,context,request)
 def test_existing_script_pnpm_launcher_preserved(self):
  stage,context,request=self.fixture_stage();f=self.root/'pnpm';f.write_text('#!/bin/sh\n# existing public launcher fixture\n');f.chmod(0o755);stage['tools']['pnpm_launcher']=m.artifact(f);self.assertTrue(self.validate(stage,context,request))
 def test_native_cosmos_empty_contract_map_is_honest(self):
  stage,context,request=self.fixture_stage('cosmosnative');self.assertEqual(stage['contract_artifacts'],{});self.assertTrue(self.validate(stage,context,request))
 def test_native_cosmos_fake_contract_artifact_rejects(self):
  stage,context,request=self.fixture_stage('cosmosnative');stage['contract_artifacts']['fake']=stage['tools']['native_cli']
  with self.assertRaisesRegex(ValueError,'built-in hypd'):self.validate(stage,context,request)
 def test_evm_missing_generated_contracts_rejects(self):
  stage,context,request=self.fixture_stage();stage['contract_artifacts']={}
  with self.assertRaisesRegex(ValueError,'actual contract outputs'):self.validate(stage,context,request)
 def test_setup_incomplete_wait_or_boolean_exit_rejects(self):
  stage,context,request=self.fixture_stage()
  for field,value in [('actual_parent_wait',False),('exit_code',True),('exit_code',1)]:
   bad=copy.deepcopy(stage);bad['checks'][0][field]=value
   with self.subTest(field=field,value=value),self.assertRaisesRegex(ValueError,'actual local setup|Actual local setup'):self.validate(bad,context,request)
 def test_setup_source_change_rejects(self):
  stage,context,request=self.fixture_stage();stage['source_after']['tracked']='changed'
  with self.assertRaisesRegex(ValueError,'changed tracked'):self.validate(stage,context,request)
 def test_setup_extra_credential_environment_rejects(self):
  stage,context,request=self.fixture_stage();stage['explicit_environment']['GITHUB_TOKEN']='synthetic-public-not-a-credential'
  with self.assertRaisesRegex(ValueError,'ambient setup environment'):self.validate(stage,context,request)
 def test_native_cli_wrong_reviewed_hash_rejects(self):
  stage,context,request=self.fixture_stage('cosmosnative');request['prerequisites']['native_cli']['sha256']='0'*64
  with self.assertRaisesRegex(ValueError,'CLI bytes/platform'):self.validate(stage,context,request)
class InteropControls(unittest.TestCase):
 setUp=Controls.setUp
 def fixture_interop(self):
  tools={}
  for name in ['ziggy-native-rows','ziggy-rocks-oracle','ziggy-rust-reference']:
   f=self.root/name;f.write_bytes(b'public metadata test tool');f.chmod(0o755);tools[name]=m.artifact(f)
  manifest=self.root/'tool-manifest.json';manifest.write_text('{}');writers={}
  for mode in ['ReleaseSafe','ReleaseFast']:
   f=self.root/mode;f.write_bytes(mode.encode());f.chmod(0o755);writers[mode]=m.artifact(f)
  context={'tools':tools,'writers':writers,'tool_manifest':m.artifact(manifest),'runtime_source_commit':'a'*40};raw={}
  sources={name:m.checksum(m.ROOT/name)for name in ['zig/src/native_rows_interop_fixture.zig','zig/integration/native_rows_interop.py','zig/bench/native_case_tools.py','zig/bench/native_harness_census.py']}
  for label,mode in [('safe','ReleaseSafe'),('fast','ReleaseFast')]:
   fixture=self.root/label;fixture.mkdir();db=fixture/'db';db.mkdir();data=db/'MANIFEST';data.write_bytes(b'public synthetic database metadata')
   old={'argv':[tools['ziggy-rocks-oracle']['path'],'relayer-probe-all'],'exit_code':0,'started_monotonic':2,'ended_monotonic':3};native={'argv':[tools['ziggy-native-rows']['path']],'exit_code':0,'started_monotonic':4,'ended_monotonic':5}
   (fixture/'old-canonical-first-command.json').write_text(json.dumps(old));(fixture/'native-reader-command.json').write_text(json.dumps(native))
   value={'passed':True,'errors':[],'source_unchanged':True,'source_before':sources,'source_after':sources,'actual_chain_or_SDK_signature_acceptance':False,'elapsed_confirmation_hold_credit_ms':0,'artifacts':{'writer':writers[mode],'native_reader':tools['ziggy-native-rows'],'old_canonical_oracle':tools['ziggy-rocks-oracle'],'rust_message_reference':tools['ziggy-rust-reference']},'tool_producer_authority':{'manifest':context['tool_manifest'],'source_commit':'a'*40},'writer_wait_receipt':{'exit_code':0,'wait_returned':True,'ended_monotonic':1},'owned_process_cleanup':{'writer_reaped':True},'old_and_new_oracles_sequential':True,'all_database_files_unchanged_by_readers_or_readonly_reopen':True,'reopened_signed_bytes_identical':True,'fixture_root':str(fixture),'database_file_hashes_after_old_oracle':{'MANIFEST':{'bytes':data.stat().st_size,'sha256':m.checksum(data)}}}
   f=fixture/'result.json';f.write_text(json.dumps(value));raw[label]=m.artifact(f)
  return context,raw
 def changed(self,raw,label,change):
  path=pathlib.Path(raw[label]['path']);value=json.loads(path.read_text());change(value);path.write_text(json.dumps(value));raw[label]=m.artifact(path)
 def test_raw_dual_mode_metadata_composes_without_native_credit(self):
  context,raw=self.fixture_interop();result=m.interop_summary(context,raw);self.assertEqual(set(result['modes']),{'safe','fast'});self.assertFalse(result['family_chain_SDK_finality_delivery_elapsed600_acceptance']);self.assertEqual(result['modes']['safe']['actual_db_files_rehashed'],1)
 def test_missing_transitive_consumer_source_rejected(self):
  context,raw=self.fixture_interop()
  def remove(v):
   v['source_before'].pop('zig/bench/native_harness_census.py');v['source_after']=v['source_before'].copy()
  self.changed(raw,'safe',remove)
  with self.assertRaisesRegex(ValueError,'Exact actual interoperability'):m.interop_summary(context,raw)
 def test_other_writer_mode_rejected(self):
  context,raw=self.fixture_interop();self.changed(raw,'fast',lambda v:v['artifacts'].update(writer=context['writers']['ReleaseSafe']))
  with self.assertRaisesRegex(ValueError,'different writer/mode'):m.interop_summary(context,raw)
 def test_unwaited_writer_rejected(self):
  context,raw=self.fixture_interop();self.changed(raw,'safe',lambda v:v['writer_wait_receipt'].update(wait_returned=False))
  with self.assertRaisesRegex(ValueError,'writer wait absent'):m.interop_summary(context,raw)
 def test_native_oracle_started_before_old_finished_rejected(self):
  context,raw=self.fixture_interop();path=self.root/'safe/native-reader-command.json';value=json.loads(path.read_text());value['started_monotonic']=2.5;path.write_text(json.dumps(value))
  with self.assertRaisesRegex(ValueError,'waited before native'):m.interop_summary(context,raw)
 def test_changed_database_after_readback_rejected(self):
  context,raw=self.fixture_interop();(self.root/'fast/db/MANIFEST').write_bytes(b'changed database')
  with self.assertRaisesRegex(ValueError,'databases changed'):m.interop_summary(context,raw)
 def test_fabricated_lifecycle_credit_rejected(self):
  context,raw=self.fixture_interop();self.changed(raw,'safe',lambda v:v.update(elapsed_confirmation_hold_credit_ms=600000))
  with self.assertRaisesRegex(ValueError,'cannot supply native lifecycle'):m.interop_summary(context,raw)
 def test_old_mac_alias_or_unbound_manifest_rejected(self):
  context,raw=self.fixture_interop();self.changed(raw,'safe',lambda v:v.update(tool_producer_authority=None))
  with self.assertRaises((ValueError,TypeError)):m.interop_summary(context,raw)
class PreparationControls(unittest.TestCase):
 setUp=Controls.setUp
 git=Controls.git
 repository=Controls.repository
 fixture_stage=StageControls.fixture_stage
 def test_actual_prepare_outputs_match_manifest_and_owner_schemas_without_executing(self):
  # Admission fixtures are synthetic, explicitly mocked below. Actual output
  # construction plus existing manifest and launch-owner validators remain real.
  import shutil,sys
  from types import SimpleNamespace
  self.root=self.root.resolve()
  stage,base,request=self.fixture_stage('cosmosnative')
  repo=self.root;case=repo/'case';case.mkdir()
  for name in ['evidence','tools','home','tmp','docker-config']:(case/name).mkdir()
  for rel in ['zig/bench/native_case_owner.py','zig/bench/cold_matrix_owner.py']:
   target=repo/rel;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(m.ROOT/rel,target)
  for source in (m.ROOT/'zig/integration').glob('multivm_*.py'):
   target=repo/'zig/integration'/source.name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target)
  (repo/'rust/main/utils/run-locally').mkdir(parents=True)
  request['limits']=m.LIMITS.copy();request['postgres']={'schema':2,'image':'postgres:14','image_id':'sha256:'+'1'*64,'repo_digest':'postgres@sha256:'+'2'*64,'architecture':'amd64'}
  def output(path,value):path.write_text(json.dumps(value));return m.artifact(path)
  request_pin=output(repo/'request.json',request);receipt=output(repo/'receipt.json',{})
  tools={}
  template=pathlib.Path(stage['tools']['native_cli']['path'])
  for name in ['init-db','ziggy-native-rows','ziggy-rocks-oracle','ziggy-rust-reference']:
   path=case/'tools'/name;shutil.copyfile(template,path);path.chmod(0o755);tools[name]=m.artifact(path)
  artifacts={}
  process=m.load_module('preparation_process_fixture','zig/integration/multivm_process.py')
  for name in process.ROLES+process.LIBRARIES:
   path=case/('runtime-'+name);shutil.copyfile(template,path);path.chmod(0o755);artifacts[name]=m.artifact(path)
  log=output(case/'evidence/cohort-log.json',{'actual_checked_decoded_locks':[]})
  closure=output(case/'compiled-input-closure.json',{'scopes':{f:[]for f in m.SCOPES},'checks':[{'log':log}]})
  output(case/'tools/source-gate.json',{'source_before':{'fixture':'same'},'source_after':{'fixture':'same'}})
  context={'phase':'HYDRATED_NOT_EXECUTION_APPROVAL','nodes_started':False,'native_case_acceptance':False,'task_root':str(case),'scenario':'cosmosnative','mode':'ReleaseSafe','execution_source_commit':base['execution_source_commit'],'runtime_source_commit':base['execution_source_commit'],'request':request_pin,'producer_receipt':receipt,'runtime_artifacts':artifacts,'tools':tools,'writers':{'ReleaseSafe':tools['init-db'],'ReleaseFast':tools['init-db']},'harness':{'normal':tools['init-db'],'construction':tools['init-db']},'tool_manifest':output(case/'tools/manifest.json',{}),'compiled_input_closure':closure,'consumer_cpu':{'architecture':'amd64'}}
  cp=case/'hydrated-inputs.json';output(cp,context)
  interop={'accepted_component_source_and_actual_Zig_storage_interop':True,'family_chain_SDK_finality_delivery_elapsed600_acceptance':False,'reader':tools['ziggy-native-rows'],'modes':{n:{'actual_writer_parent_wait_exit':0,'actual_db_files_rehashed':1,'raw_result':{}}for n in ['safe','fast']},'source_sha256':{'zig/integration/multivm_process.py':m.checksum(repo/'zig/integration/multivm_process.py')}}
  interop_pin=output(case/'accepted-native-rows-interop.json',interop);stage_pin=output(repo/'stage.json',stage)
  actual_load=m.load_module
  def load(name,relative):
   if name=='case_tool_readmission':return SimpleNamespace(load_manifest=lambda *a:tools)
   return actual_load(name,relative)
  with mock.patch.object(m.sys,'platform','linux'),mock.patch.object(m.platform,'machine',return_value='x86_64'),mock.patch.object(m,'producer_receipt',return_value={}),mock.patch.object(m,'cohort',return_value=[]),mock.patch.object(m,'decoded_locks',return_value=[]),mock.patch.object(m,'interop_summary',return_value=interop),mock.patch.object(m,'load_module',side_effect=load):
   paths=m.prepare(cp,m.checksum(cp),interop_pin,stage_pin,repo)
  manifest=json.loads(paths['manifest'].read_text());process.validate_manifest(manifest)
  owner_spec=importlib.util.spec_from_file_location('actual_prepared_owner',repo/'zig/bench/native_case_owner.py');owner=importlib.util.module_from_spec(owner_spec);owner_spec.loader.exec_module(owner)
  plan,*_=owner.load_plan(paths['launch-plan'],m.checksum(paths['launch-plan']))
  self.assertEqual(plan['harness_argv'][1:],['--exact','cosmosnative::test::test_run','--nocapture','--test-threads=1'])
  owned=pathlib.Path(manifest['tool_overrides']['E2E_HYPD_PATH']['path']);self.assertTrue(owned.is_relative_to(case));self.assertEqual(owned.read_bytes(),template.read_bytes())
  self.assertEqual(set(paths),{'manifest','execution-approval','case-inputs','launch-plan'})
  self.assertFalse(plan['native_case_acceptance'])


class HarnessWorkingDirectoryControls(unittest.TestCase):
 def planned_cwd(self,repo,scenario):
  import ast
  tree=ast.parse(pathlib.Path(m.__file__).read_text())
  prepare=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='prepare')
  plan=next(n.value for n in prepare.body if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='plan'for t in n.targets))
  value=plan.values[next(i for i,key in enumerate(plan.keys)if isinstance(key,ast.Constant)and key.value=='harness_cwd')]
  return pathlib.Path(eval(compile(ast.Expression(value),'actual plan harness_cwd','eval'),{'str':str,'repo':repo,'scenario':scenario}))
 def test_evm_relative_agent_slots_match_baked_Rust_workspace(self):
  # Exercise the actual plan expression against the Rust caller/resolver contract.
  # No helper/agent/compiler is executed to validate this path relationship.
  import re
  source=m.ROOT/'rust/main/utils/run-locally/src'
  self.assertRegex((source/'main.rs').read_text(),r'const AGENT_BIN_PATH: &str = "target/debug";')
  self.assertIn('workspace.join("target/debug").join(role)',(source/'external_agents.rs').read_text())
  repo=pathlib.Path('/owned/checkout');workspace=repo/'rust/main';cwd=self.planned_cwd(repo,'evm')
  for role in ['relayer','validator','scraper','init-db']:
   self.assertEqual(cwd/'target/debug'/role,workspace/'target/debug'/role)
   self.assertNotEqual(repo/'rust/main/utils/run-locally/target/debug'/role,workspace/'target/debug'/role)
 def test_all_seven_altvm_fixture_working_directories_preserved(self):
  repo=pathlib.Path('/owned/checkout')
  for scenario in ['cosmosnative','cosmwasm','starknet','sealevel','sealevel-composite','radix','tron']:
   with self.subTest(scenario=scenario):self.assertEqual(self.planned_cwd(repo,scenario),repo/'rust/main/utils/run-locally')

if __name__=='__main__':unittest.main(verbosity=2)
