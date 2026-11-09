import ast
import gzip,hashlib,importlib.util,json,pathlib,subprocess,tempfile,unittest,os,struct,copy
from unittest import mock
spec=importlib.util.spec_from_file_location('inputs',pathlib.Path(__file__).with_name('native_case_inputs.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Controls(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=pathlib.Path(self.tmp.name)
 def git(self,*args):return subprocess.check_output(['git',*args],cwd=self.root,text=True,stderr=subprocess.PIPE).strip()
 def repository(self):
  self.git('init','-q');self.git('config','user.name','Fixture');self.git('config','user.email','fixture@example.invalid');self.git('config','core.hooksPath','/dev/null')
  for n in ['zig/src/root.zig','zig/native/Cargo.toml','zig/build.zig','rust/main/Cargo.toml','rust/main/chains/hyperlane-radix/src/error.rs','rust/main/hyperlane-core/src/error.rs','rust/main/hyperlane-core/src/rpc_clients/error.rs','rust/sealevel/Cargo.toml','zig/reference/Cargo.toml']:
   p=self.root/n;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('source fixture')
  (self.root/'rust/main/Cargo.lock').write_bytes(b'synthetic public Radix client lock')
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


class EvmKathyConfigurationControls(unittest.TestCase):
 def planned_environment(self,scenario,include_override=True):
  import ast
  tree=ast.parse(pathlib.Path(m.__file__).read_text());fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='prepare');start=next(i for i,n in enumerate(fn.body)if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='env'for t in n.targets));nodes=fn.body[start:start+2]if include_override else fn.body[start:start+1]
  space={'scenario':scenario,'stage':{'explicit_environment':{'PATH':'/usr/bin:/bin'}},'environment':{'FIXED_PUBLIC_WORKER':'/owned/worker'},'paths':{'manifest':pathlib.Path('/owned/manifest.json')},'root':pathlib.Path('/owned/case'),'profile':{'local_docker':{'host':'unix:///owned/docker.sock','config_dir':'/owned/docker-config'}},'str':str,'overrides':{}}
  exec(compile(ast.Module(body=nodes,type_ignores=[]),'actual-prepare-explicit-environment','exec'),space);return space['env']
 def test_actual_EVM_environment_matches_Rust_config_fixture_public_corpus_and_original_CI(self):
  import ast,re
  environment=self.planned_environment('evm');self.assertEqual(environment['E2E_CI_MODE'],'true');self.assertIn('E2E_KATHY_MESSAGES',environment);self.assertEqual(environment['E2E_KATHY_MESSAGES'],'20')
  root=m.ROOT;config=(root/'rust/main/utils/run-locally/src/config.rs').read_text();self.assertIn('env::var("E2E_KATHY_MESSAGES")',config);self.assertRegex(config,r'r\.unwrap_or\(16\)')
  main=(root/'rust/main/utils/run-locally/src/main.rs').read_text();self.assertIn('let config = Config::load();',main);self.assertIn('.arg("messages", (config.kathy_messages / 4).to_string())',main)
  source=(root/'rust/main/utils/run-locally/src/external_agents.rs').read_text();fixture=source.split('fn configure_evm_fixture(',1)[1].split('type FixtureSnapshot',1)[0];self.assertRegex(fixture,r'"kathy",\s*"--messages",\s*"5",');self.assertIn('Kathy Source20 fixture arguments differ',fixture)
  owner=ast.parse((root/'zig/bench/native_case_owner.py').read_text());calls=[n for n in ast.walk(owner)if isinstance(n,ast.Call)and isinstance(n.func,ast.Attribute)and isinstance(n.func.value,ast.Name)and n.func.value.id=='os'and n.func.attr=='execve'];self.assertEqual(len(calls),1);self.assertEqual(ast.unparse(calls[0].args[2]),"plan['explicit_environment']")
  messages=int(environment['E2E_KATHY_MESSAGES']);self.assertEqual(messages//4,5);self.assertNotEqual(16//4,5);profile=m.public_profile('evm')['initial_corpus'];self.assertEqual(profile,{'dispatches':31,'deliveries':20,'zero_insertions':10,'failed_body':1,'double_insertions':10});self.assertEqual(messages,profile['deliveries'])
  workflow=(root/'.github/workflows/test-rust-e2e.yml').read_text();evm=workflow.split('- name: agent tests (EVM)',1)[1].split('- name:',1)[0];self.assertIn("E2E_CI_MODE: 'true'",evm);self.assertIn("E2E_KATHY_MESSAGES: '20'",evm)
 def test_all_seven_other_families_keep_their_actual_original_environment(self):
  for scenario in ['cosmosnative','cosmwasm','starknet','sealevel','sealevel-composite','radix','tron']:
   with self.subTest(scenario=scenario):
    expected=self.planned_environment(scenario,include_override=False);actual=self.planned_environment(scenario);self.assertEqual(actual,expected);self.assertNotIn('E2E_KATHY_MESSAGES',actual)


class ZigDiagnosticCatalogControls(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(prefix='znc-zig-source-control-');self.addCleanup(self.tmp.cleanup);self.repo=pathlib.Path(self.tmp.name).resolve()
  self.git('init','-q');self.git('config','user.name','Fixture');self.git('config','user.email','fixture@example.invalid');self.git('config','core.hooksPath','/dev/null');self.git('config','commit.gpgSign','false')
  for name in ['zig/src/root.zig','zig/native/Cargo.toml','zig/build.zig','rust/main/Cargo.toml','rust/sealevel/Cargo.toml','zig/reference/Cargo.toml']:
   path=self.repo/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text('pub const public_value = 1;\n'if name.endswith('.zig')else'fixture\n')
  self.git('add','.');self.git('commit','-qm','pure Source fixture');self.commit=self.git('rev-parse','HEAD');self.runtime=m.cohort(self.repo,self.commit,self.commit,'runtime');self.evidence=[]
 def git(self,*args):return subprocess.check_output(['git',*args],cwd=self.repo,text=True,stderr=subprocess.PIPE).strip()
 def collect(self):return m.diagnostic_zig_source_catalog(self.repo,self.commit,self.commit,self.runtime,self.evidence)
 def test_actual_Git_blob_join_produces_exact_catalog_and_serialized_consumer_frames(self):
  import ast
  fn=next(n for n in ast.parse(pathlib.Path(m.__file__).read_bytes()).body if isinstance(n,ast.FunctionDef)and n.name=='prepare');assignment=next(n for n in fn.body if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='diagnostic_zig_sources'for t in n.targets));addition=next(n for n in fn.body if isinstance(n,ast.AugAssign)and isinstance(n.target,ast.Name)and n.target.id=='required'and 'diagnostic_rust_sources'in ast.unparse(n));plan_literal=next(n.value for n in fn.body if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='plan'for t in n.targets));plan_value=next(v for k,v in zip(plan_literal.keys,plan_literal.values)if isinstance(k,ast.Constant)and k.value=='diagnostic_zig_sources')
  env=dict(m.__dict__,repo=self.repo,context={'runtime_source_commit':self.commit,'execution_source_commit':self.commit},closure={'scopes':{'runtime':self.runtime}},scenario='sealevel',evidence=self.evidence,diagnostic_rust_sources={},diagnostic_relayer_sources={},diagnostic_radix_scraper_sources={},required=[]);exec(compile(ast.fix_missing_locations(ast.Module(body=[assignment,addition],type_ignores=[])),str(m.__file__),'exec'),env);catalog=eval(compile(ast.Expression(body=plan_value),str(m.__file__),'eval'),env)
  self.assertEqual(set(catalog),{'zig/src/root.zig'});row=catalog['zig/src/root.zig'];self.assertEqual(row,m.artifact(self.repo/'zig/src/root.zig'));self.assertIn(row,env['required']);self.assertTrue(any('ls-tree'in r['argv']for r in self.evidence));self.assertTrue(all(r['actual_parent_wait']for r in self.evidence))
  path=self.repo/'catalog.json';path.write_text(json.dumps({'diagnostic_zig_sources':catalog,'required_inputs':env['required']}));decoded_plan=json.loads(path.read_text());decoded=decoded_plan['diagnostic_zig_sources'];base=pathlib.Path(__file__).resolve().parents[1]
  spec=importlib.util.spec_from_file_location('catalog_consumer_diag',base/'integration/multivm_diagnostics.py');diag=importlib.util.module_from_spec(spec);spec.loader.exec_module(diag)
  spec=importlib.util.spec_from_file_location('catalog_consumer_owner',base/'bench/native_case_owner.py');owner=importlib.util.module_from_spec(spec);spec.loader.exec_module(owner)
  self.assertEqual(owner.admitted_zig_diagnostic_catalog(decoded_plan,self.repo),decoded)
  frames=diag.zig_role_source_frames(b'<RLY> /PRIVATE_BUILD/zig/src/root.zig:1:5: 0x123 in PRIVATE_FUNCTION (role)\n',{'RLY':'relayer'},decoded,self.repo);self.assertEqual(frames,{'RLY':[{'source':'zig/src/root.zig','line':1,'column':5}]});self.assertNotIn('PRIVATE',json.dumps(frames))
 def test_wrong_blob_or_index_tree_mismatch_refuses_even_when_other_cohort_is_valid(self):
  real=m.git
  def wrong_blob(repo,*args,**kwargs):
   value=real(repo,*args,**kwargs)
   if args[0]=='ls-tree':
    records=[]
    for record in value.split('\0'):
     if record and record.endswith('zig/src/root.zig'):record='100644 blob '+'0'*40+'\tzig/src/root.zig'
     records.append(record)
    return '\0'.join(records)
   return value
  with mock.patch.object(m,'git',side_effect=wrong_blob),self.assertRaisesRegex(ValueError,'producer blob'):self.collect()
  def wrong_index(repo,*args,**kwargs):return 'zig/src/foreign.zig\0'if args[0]=='ls-files'else real(repo,*args,**kwargs)
  with mock.patch.object(m,'git',side_effect=wrong_index),self.assertRaisesRegex(ValueError,'index/tree'):self.collect()
 def test_actual_dirty_Source_refuses_without_catalog_or_runtime_admission(self):
  (self.repo/'zig/src/root.zig').write_text('dirty\n')
  with self.assertRaisesRegex(ValueError,'Dirty compiled'):self.collect()
 def test_links_oversize_and_midcapture_change_refuse_at_real_file_boundary(self):
  path=self.repo/'zig/src/root.zig';original=path.read_bytes();other=self.repo/'private-data';other.write_bytes(b'SECRET');path.unlink();path.symlink_to(other)
  with mock.patch.object(m,'cohort',return_value=self.runtime),self.assertRaisesRegex(ValueError,'Symlink'):self.collect()
  path.unlink()
  with path.open('wb')as stream:stream.truncate(1024**2+1)
  with mock.patch.object(m,'cohort',return_value=self.runtime),mock.patch.object(m.os,'open',side_effect=AssertionError('oversize must not open')),self.assertRaisesRegex(ValueError,'Bounded regular'):self.collect()
  path.write_bytes(original);real=m.os.fstat;calls=[]
  def changed(fd):
   row=real(fd);calls.append(fd)
   if len(calls)==2:
    from types import SimpleNamespace
    return SimpleNamespace(st_dev=row.st_dev,st_ino=row.st_ino,st_size=row.st_size,st_mtime_ns=row.st_mtime_ns+1,st_nlink=row.st_nlink)
   return row
  with mock.patch.object(m.os,'fstat',side_effect=changed),self.assertRaisesRegex(ValueError,'during capture'):self.collect()
 def test_catalog_bounds_and_actual_prepare_required_input_binding(self):
  real=m.git
  def many(repo,*args,**kwargs):return '\0'.join('zig/src/f'+str(i)+'.zig'for i in range(769))if args[0]=='ls-files'else real(repo,*args,**kwargs)
  with mock.patch.object(m,'git',side_effect=many),self.assertRaisesRegex(ValueError,'Bounded unique'):self.collect()
  import ast
  tree=ast.parse(pathlib.Path(m.__file__).read_bytes());fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='prepare');calls=[n for n in ast.walk(fn)if isinstance(n,ast.Call)and isinstance(n.func,ast.Name)and n.func.id=='diagnostic_zig_source_catalog'];self.assertEqual(len(calls),1)
  assigned=next(n for n in fn.body if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='diagnostic_zig_sources'for t in n.targets));self.assertIsInstance(assigned.value,ast.IfExp);self.assertEqual(ast.literal_eval(assigned.value.test.comparators[0]),{'sealevel','sealevel-composite'})
  updates=[n for n in fn.body if isinstance(n,ast.AugAssign)and isinstance(n.target,ast.Name)and n.target.id=='required'];self.assertTrue(any('list(diagnostic_zig_sources.values())'in ast.unparse(n)for n in updates));plan=next(n.value for n in fn.body if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='plan'for t in n.targets));self.assertIn('diagnostic_zig_sources',[k.value for k in plan.keys if isinstance(k,ast.Constant)])

class RelayerStartupCatalogControls(unittest.TestCase):
 git=ZigDiagnosticCatalogControls.git
 def setUp(self):
  ZigDiagnosticCatalogControls.setUp(self);root=pathlib.Path(__file__).resolve().parents[2]
  spec=importlib.util.spec_from_file_location('relayer_catalog_diagnostic',pathlib.Path(__file__).with_name('multivm_diagnostics.py'));diagnostic=importlib.util.module_from_spec(spec);spec.loader.exec_module(diagnostic)
  self.diagnostic=diagnostic
  for name,_,_ in diagnostic.RELAYER_STARTUP_SOURCE:
   target=self.repo/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes((root/name).read_bytes())
  self.git('add','.');self.git('commit','-qm','fixed relayer Source fixture');self.commit=self.git('rev-parse','HEAD');self.runtime=m.cohort(self.repo,self.commit,self.commit,'runtime');self.evidence=[]
 def collect_relayer(self):
  with mock.patch.object(m,'load_module',return_value=self.diagnostic):return m.relayer_startup_source_catalog(self.repo,self.commit,self.commit,self.runtime,self.evidence)
 def test_fixed28_actual_producer_Git_blob_join_and_no_unbounded_source_set(self):
  rows=self.collect_relayer();self.assertEqual(len(rows),28);self.assertEqual(set(rows),{name for name,_,_ in self.diagnostic.RELAYER_STARTUP_SOURCE})
  self.assertTrue(all(m.artifact(self.repo/name)==row for name,row in rows.items()));self.assertTrue(any('rev-parse'in e['argv']for e in self.evidence));self.assertTrue(all(e['actual_parent_wait']for e in self.evidence))
 def test_dirty_or_replaced_producer_blob_is_refused(self):
  p=self.repo/'zig/src/evm/provider.zig';wire=p.read_bytes();p.write_bytes(wire+b'\n')
  with self.assertRaisesRegex(ValueError,'Dirty compiled'):self.collect_relayer()
  p.write_bytes(wire);real=m.git
  def wrong(repo,*args,**kwargs):return'0'*40 if args[:1]==('rev-parse',)and len(args)==2 and ':'in args[1]else real(repo,*args,**kwargs)
  with mock.patch.object(m,'git',side_effect=wrong),self.assertRaisesRegex(ValueError,'producer blob'):self.collect_relayer()
 def test_each_new_metric_emitter_and_Stark_codec_source_is_mandatory(self):
  names=['zig/src/ops/indexing_metrics.zig','zig/src/ops/relayer_metrics.zig','zig/src/agents/indexing/source.zig','zig/src/starknet/events.zig','zig/src/starknet/codec.zig']
  for name in names:
   path=self.repo/name;wire=path.read_bytes();path.write_bytes(wire+b'\n')
   with self.subTest(path=name),self.assertRaisesRegex(ValueError,'Dirty compiled'):self.collect_relayer()
   path.write_bytes(wire)
  self.assertTrue(set(names)<=set(self.collect_relayer()))
 def test_prepare_fixed_catalog_is_both_required_and_in_actual_approval(self):
  fn=next(n for n in ast.parse(pathlib.Path(m.__file__).read_bytes()).body if isinstance(n,ast.FunctionDef)and n.name=='prepare');text=ast.unparse(fn)
  self.assertIn("scenario in {'evm', 'starknet'}",text);self.assertIn("approval['diagnostic_relayer_sources'] = diagnostic_relayer_sources",text);self.assertIn('list(diagnostic_relayer_sources.values())',text)

class RadixScraperCatalogControls(unittest.TestCase):
 git=ZigDiagnosticCatalogControls.git
 def setUp(self):
  ZigDiagnosticCatalogControls.setUp(self);root=pathlib.Path(__file__).resolve().parents[2]
  spec=importlib.util.spec_from_file_location('radix_catalog_diagnostic',pathlib.Path(__file__).with_name('multivm_diagnostics.py'));self.diagnostic=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.diagnostic)
  for name,_,_ in self.diagnostic.RADIX_SCRAPER_SOURCE:
   target=self.repo/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes((root/name).read_bytes())
  self.git('add','.');self.git('commit','-qm','fixed Radix Source fixture');self.commit=self.git('rev-parse','HEAD');self.scopes={family:m.cohort(self.repo,self.commit,self.commit,family)for family in ('runtime','helper')};self.evidence=[]
 def collect(self):
  with mock.patch.object(m,'load_module',return_value=self.diagnostic):return m.radix_scraper_source_catalog(self.repo,self.commit,self.commit,self.scopes,self.evidence)
 def test_actual14_producer_blobs_bind_runtime_and_helper_and_prepare_approval(self):
  rows=self.collect();self.assertEqual(len(rows),14);self.assertTrue(all(m.artifact(self.repo/name)==row for name,row in rows.items()));self.assertTrue(all(e['actual_parent_wait']for e in self.evidence))
  fn=next(n for n in ast.parse(pathlib.Path(m.__file__).read_bytes()).body if isinstance(n,ast.FunctionDef)and n.name=='prepare');text=ast.unparse(fn)
  self.assertIn("approval['diagnostic_radix_scraper_sources'] = diagnostic_radix_scraper_sources",text);self.assertIn('list(diagnostic_radix_scraper_sources.values())',text)
  assignment=next(n for n in fn.body if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='diagnostic_radix_scraper_sources'for t in n.targets));self.assertEqual(ast.literal_eval(assignment.value.test.comparators[0]),'radix')
 def test_dirty_runtime_or_helper_and_wrong_blob_cannot_borrow_any_epoch(self):
  for name in ['zig/src/radix/provider.zig','rust/main/utils/run-locally/src/external_agents.rs']:
   p=self.repo/name;wire=p.read_bytes();p.write_bytes(wire+b'\n')
   with self.subTest(path=name),self.assertRaisesRegex(ValueError,'Dirty compiled'):self.collect()
   p.write_bytes(wire)
  real=m.git
  def wrong(repo,*args,**kwargs):return'0'*40 if args[:1]==('rev-parse',)and len(args)==2 and ':'in args[1]else real(repo,*args,**kwargs)
  with mock.patch.object(m,'git',side_effect=wrong),self.assertRaisesRegex(ValueError,'producer blob'):self.collect()
  original=self.diagnostic.RADIX_SCRAPER_SOURCE
  with mock.patch.object(self.diagnostic,'RADIX_SCRAPER_SOURCE',original[:-1]),self.assertRaisesRegex(ValueError,'Exact SCR'):self.collect()

class RadixSubmitCatalogControls(unittest.TestCase):
 setUp=Controls.setUp
 def fixture(self):
  names=['rust/main/chains/hyperlane-radix/src/error.rs','rust/main/hyperlane-core/src/error.rs','rust/main/hyperlane-core/src/rpc_clients/error.rs','rust/main/Cargo.lock']
  for n in names:
   p=self.root/n;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b'public Source fixture')
  return names
 def test_fixed_three_plus_lock_actual_descriptors_and_nonmutation(self):
  names=self.fixture();prior={'rust/main/utils/run-locally/src/radix/cli.rs':{'path':'/prior','bytes':2,'sha256':'a'*64}};before=copy.deepcopy(prior);sources,lock=m.radix_submit_source_catalog(self.root,prior);self.assertEqual(prior,before);self.assertEqual(set(sources),set(prior)|set(names[:-1]));self.assertEqual(lock,m.artifact(self.root/names[-1]))
  for name in names[:-1]:self.assertEqual(sources[name],m.artifact(self.root/name))
 def test_original_count_bytes_file_bounds_include_lock(self):
  self.fixture()
  for count,size in [(253,1),(0,4*1024**2),(1,1024**2+1)]:
   prior={f'rust/main/utils/run-locally/src/public{i}.rs':{'path':'/prior','bytes':size,'sha256':'a'*64}for i in range(count)}
   if count==0:prior={'rust/main/utils/run-locally/src/public.rs':{'path':'/prior','bytes':size,'sha256':'a'*64}}
   with self.subTest(count=count,size=size),self.assertRaisesRegex(ValueError,'Original bounded'):m.radix_submit_source_catalog(self.root,prior)
  p=self.root/'rust/main/Cargo.lock';p.write_bytes(b'x'*(1024**2+1))
  with self.assertRaisesRegex(ValueError,'Original bounded'):m.radix_submit_source_catalog(self.root,{})
 def test_missing_duplicate_or_symlink_contract_refuses(self):
  names=self.fixture();p=self.root/names[0]
  with self.assertRaisesRegex(ValueError,'Duplicate'):m.radix_submit_source_catalog(self.root,{names[0]:m.artifact(p)})
  p.unlink()
  with self.assertRaises(ValueError):m.radix_submit_source_catalog(self.root,{})
  p.symlink_to(self.root/names[-1])
  with self.assertRaisesRegex(ValueError,'Symlink'):m.radix_submit_source_catalog(self.root,{})
 def test_prepare_Radix_only_admission_and_existing_required_inputs(self):
  tree=ast.parse(pathlib.Path(m.__file__).read_bytes());fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='prepare');calls=[n for n in ast.walk(fn)if isinstance(n,ast.Call)and isinstance(n.func,ast.Name)and n.func.id=='radix_submit_source_catalog'];self.assertEqual(len(calls),1)
  branch=next(n for n in ast.walk(fn)if isinstance(n,ast.If)and any(c is calls[0]for c in ast.walk(n)));self.assertEqual(ast.unparse(branch.test),"scenario == 'radix'");self.assertIn('[radix_submit_lock]',ast.unparse(fn));self.assertIn("'diagnostic_radix_client_lock': radix_submit_lock",ast.unparse(fn))


class SvmDiagnosticNodeAdmissionControls(unittest.TestCase):
 setUp=StageControls.setUp
 tearDown=StageControls.tearDown
 git=StageControls.git
 repository=StageControls.repository
 fixture_stage=StageControls.fixture_stage
 def test_separate_actual_elf_descriptor_and_poison_refusal(self):
  stage,_,_=self.fixture_stage('cosmosnative');stage['diagnostic_node']=stage['tools']['native_cli'];before=copy.deepcopy(stage['tools'])
  elf=m.load_module('diagnostic_node_elf','zig/bench/native_case_tools.py')
  self.assertEqual(m.admitted_svm_diagnostic_node(stage,62,elf),stage['diagnostic_node']);self.assertEqual(stage['tools'],before)
  bad=copy.deepcopy(stage);bad['diagnostic_node']['sha256']='f'*64
  with self.assertRaises(ValueError):m.admitted_svm_diagnostic_node(bad,62,elf)
  with self.assertRaises(ValueError):m.admitted_svm_diagnostic_node(stage,183,elf)
  bad=copy.deepcopy(stage);bad['diagnostic_node']['ambient']='PRIVATE'
  with self.assertRaises(ValueError):m.admitted_svm_diagnostic_node(bad,62,elf)


if __name__=='__main__':unittest.main(verbosity=2)
