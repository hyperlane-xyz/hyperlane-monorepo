"""Pure producer admission/actual command and unwind controls; no builds/SDK IO."""
import ast,copy,hashlib,importlib.util,json,os,pathlib,signal,tempfile,types,unittest
from unittest import mock
P=pathlib.Path(__file__).with_name('paired_linux_inputs.py');S=importlib.util.spec_from_file_location('paired_linux_inputs_under_test',P);m=importlib.util.module_from_spec(S);S.loader.exec_module(m)
REPO=pathlib.Path(__file__).resolve().parents[2]
class Controls(unittest.TestCase):
 def test_failure_projection_retains_actual_Source_guard_and_coordinates_only(self):
  source=P.resolve();repo=REPO.resolve();authority={'source':{'zig/bench/paired_linux_inputs.py':m.pin(source)}}
  try:m.need(False,'six-GiB preparation floor')
  except m.Refused as error:observed=m.failure_observation(error,repo,authority)
  self.assertEqual(observed['Source_guard'],'six-GiB preparation floor');self.assertEqual(observed['type'],'Refused');self.assertTrue(observed['Source_frames']);self.assertTrue(all(row['source']=='zig/bench/paired_linux_inputs.py'and row['sha256']==m.digest(source)for row in observed['Source_frames']))
 def test_public_failure_projection_drops_private_text_commands_paths_and_logs(self):
  sentinel='private-authorization-and-error-sentinel';result={'passed':False,'actual_command_waits':[{'name':'fetch-ReleaseSafe','actual_parent_wait':True,'exit_code':1,'owned_absent':True,'signals':[],'error_type':None,'completed_within_original_deadline':True,'command':[sentinel],'cwd':sentinel,'stdout':sentinel,'stderr':sentinel}],'source_policy':{'path':'reviewed-request.json','bytes':1,'sha256':'a'*64},'limits':m.LIMITS,'started_monotonic_ns':1,'completed_monotonic_ns':2,'whole_deadline_observed':True}
  observed=m.public_preparation_result(result,ValueError(sentinel),self.repo,{'source':{}});self.assertNotIn(sentinel,json.dumps(observed));self.assertIsNone(observed['error_observation']['Source_guard']);self.assertEqual(observed['actual_phase_waits'][0]['exit_code'],1);self.assertFalse(observed['native_or_timing_acceptance'])
  result['actual_command_waits'][0]['error_type']=sentinel;self.assertNotIn(sentinel,json.dumps(m.public_preparation_result(result,None,self.repo,{'source':{}})))
  for key,value in [('exit_code',{'private':sentinel}),('exit_code',True),('exit_code',256),('error_type',{'private':sentinel})]:
   changed=copy.deepcopy(result);changed['actual_command_waits'][0][key]=value
   with self.subTest(key=key,value=value),self.assertRaises(m.Refused):m.public_preparation_result(changed,None,self.repo,{'source':{}})
 def test_workflow_always_retains_only_the_fixed_closed_diagnostic(self):
  text=(REPO/'.github/workflows/zig-agents.yml').read_text();step=text.split('      - name: Retain closed input-preparation diagnostics\n',1)[1].split('      - uses:',1)[0]
  self.assertIn("if: always() && steps.authority.outputs.inputs_enabled == 'true'",step);self.assertIn('/input-diagnostic.json',step);self.assertNotIn('/logs',step);self.assertNotIn('/result.json',step)
 def test_actual_version_phase_names_and_projection_failure_keep_primary_failure(self):
  result={'passed':False,'actual_command_waits':[{'name':'resolve-1.98.0-cargo','actual_parent_wait':True,'exit_code':1,'owned_absent':True,'signals':[],'error_type':None,'completed_within_original_deadline':True}],'source_policy':{},'limits':m.LIMITS,'started_monotonic_ns':1,'completed_monotonic_ns':2,'whole_deadline_observed':True}
  self.assertEqual(m.public_preparation_result(result,None,self.repo,{'source':{}})['actual_phase_waits'][0]['name'],'resolve-1.98.0-cargo')
  result['actual_command_waits'][0]['name']='private/path';m.publish_input_diagnostic(self.root,result,ValueError('private sentinel'),self.repo,{'source':{}});value=json.loads((self.root/'input-diagnostic.json').read_text());self.assertEqual(value['primary_error_type'],'ValueError');self.assertEqual(value['diagnostic_error_type'],'Refused');self.assertNotIn('private',json.dumps(value));self.assertFalse(value['passed'])
  with mock.patch.object(m,'write',side_effect=OSError('private write detail')),mock.patch.object(m.sys,'stderr')as stderr:m.publish_input_diagnostic(self.root,result,ValueError('private sentinel'),self.repo,{'source':{}})
  self.assertNotIn('private',str(stderr.write.call_args_list))
  with mock.patch.object(m,'write',side_effect=OSError('private write detail')),mock.patch.object(m.sys,'stderr')as stderr:
   stderr.write.side_effect=OSError('private stderr detail');m.publish_input_diagnostic(self.root,result,ValueError('private sentinel'),self.repo,{'source':{}})
 def test_only_successfully_waited_Cargo_metadata_uses_larger_bounded_structure_budget(self):
  raw=b'['+b'0,'*250000+b'0]';path=self.file('cargo.json',raw);row={'name':'runtime-cargo-metadata','stdout':m.pin(path),'error_type':None,'actual_parent_wait':True,'exit_code':0,'signals':[],'owned_absent':True,'completed_within_original_deadline':True}
  with self.assertRaisesRegex(m.Refused,'metadata structure bound'):m.decode(raw)
  value=m.read_phase_json(row);self.assertEqual(len(value),250001);self.assertEqual(row['metadata_shape'],{'bytes':len(raw),'nodes':250002,'maximum_nodes':2000000,'deepest_depth':1,'maximum_depth':32})
  for changed in [dict(row,exit_code=1),dict(row,actual_parent_wait=False)]:
   with self.assertRaisesRegex(m.Refused,'actual waited Cargo metadata phase'):m.read_phase_json(changed)
  with self.assertRaisesRegex(m.Refused,'metadata structure bound'):m.read_phase_json(dict(row,name='postgres16-image-metadata'))
  small=self.file('postgres-image.json',b'{"id":"public-image","architecture":"amd64"}');pg={'name':'postgres16-image-metadata','stdout':m.pin(small)}
  self.assertEqual(m.read_phase_json(pg),{'id':'public-image','architecture':'amd64'});self.assertNotIn('metadata_shape',pg)
  for budget in [True,0,3000000]:
   with self.assertRaises(m.Refused):m.decode(b'{}',maximum_nodes=budget)
  for budget in [250000,2000000]:
   with self.assertRaisesRegex(m.Refused,'metadata structure bound'):m.decode(b'['*33+b'0'+b']'*33,maximum_nodes=budget)
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=pathlib.Path(self.tmp.name).resolve();self.repo=self.root/'repo';self.repo.mkdir()
 def file(self,name,data=b'fixture'):
  p=self.repo/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(data);return p
 def relative(self,p):return {**m.pin(p),'path':str(p.relative_to(self.repo))}
 def request(self,enabled=False):
  v={k:None for k in m.FIELDS};v.update(schema=1,kind='paired-linux-ci-v1',root_approved=enabled,inputs_enabled=enabled,functional_enabled=False,runtime_enabled=False,producer_source_commit='a'*40,baseline_source_commit=m.BASELINE,baseline_profile=m.PROFILE,transport_requests={mode:None for mode in m.MODES})
  if enabled:
   v['required_source']=[self.relative(self.file(p))for p in sorted(m.CODE)]
   entries={k:{'id':i+1,'name':k,'size_in_bytes':1,'sha256':'b'*64}for i,k in enumerate(['sdk_safe','sdk_fast','helper','tools','writer_safe','writer_fast','svm','radix_reference'])}
   cohort={'schema':1,'root_approved':True,'passed':True,'Root_actual_cohort_acceptance':True,'source_commit':'a'*40,'all8_same_run_required_product_artifacts':True,'eight_artifacts':entries,'run_id':10,'run_attempt':1,'all4_required_jobs_actual_success':[{'name':n,'id':i+1}for i,n in enumerate(['svm-prerequisites','native-harness-controls','full-sdk-native (ReleaseSafe)','full-sdk-native (ReleaseFast)'])]}
   v['qualified_cohort']=self.relative(self.file('cohort.json',json.dumps(cohort).encode()))
   for mode in m.MODES:
    row={'root_approved':True,'scenario':'cosmosnative','mode':mode,'producer_source_commit':'a'*40,'producer_run_id':10,'producer_run_attempt':1,'artifact_pins':{k:entries[('sdk_safe'if mode=='ReleaseSafe'else'sdk_fast')if k=='sdk'else k]for k in ['sdk','helper','tools','writer_safe','writer_fast']}}
    v['transport_requests'][mode]=self.relative(self.file(mode+'.json',json.dumps(row).encode()))
  p=self.file('request.json',json.dumps(v).encode());return p,m.digest(p),v
 def test_false_main_has_no_source_import_platform_process_or_output(self):
  p,sha,_=self.request();out=self.root/'out'
  with mock.patch.object(m,'load_source',side_effect=AssertionError('import')),mock.patch.object(m.platform,'machine',side_effect=AssertionError('platform')),mock.patch.object(m.subprocess,'Popen',side_effect=AssertionError('spawn')):
   value=m.producer_main(p,sha,self.repo,out,{},None)
  self.assertFalse(value['inputs_prepared']);self.assertFalse(out.exists())
 def test_false_authority_cannot_set_any_work_flag(self):
  for key in ['inputs_enabled','functional_enabled','runtime_enabled']:
   p,_,v=self.request();v[key]=True;p.write_text(json.dumps(v))
   with self.subTest(key=key),self.assertRaises(m.Refused):m.request(p,m.digest(p),self.repo)
 def test_request_hash_before_source_and_no_missing_pin_waiver(self):
  p,sha,v=self.request(True)
  with self.assertRaises(m.Refused):m.request(p,'0'*64,self.repo)
  v['required_source'].pop();p.write_text(json.dumps(v))
  with self.assertRaises(m.Refused):m.request(p,m.digest(p),self.repo)
 def test_foundry_installer_test_and_root_must_be_pinned_before_producer_setup(self):
  required={'zig/tools/foundry_official.py','zig/tools/foundry_official_test.py','zig/tools/foundry_public_good_root.json'};self.assertTrue(required<=m.CODE);self.assertEqual(len(m.CODE),21)
  for missing in required:
   path,_,value=self.request(True);value['required_source']=[r for r in value['required_source']if r['path']!=missing];path.write_text(json.dumps(value))
   with self.subTest(missing=missing),self.assertRaisesRegex(m.Refused,'required executable producer dependency missing'):m.request(path,m.digest(path),self.repo)
 def test_cohort_and_both_mode_transport_exact_binding(self):
  p,sha,_=self.request(True);v,a=m.request(p,sha,self.repo);self.assertEqual(a['cohort']['source_commit'],'a'*40);m.source_authority_recheck(a)
  transport=self.repo/'ReleaseFast.json';value=json.loads(transport.read_text());value['artifact_pins']['sdk']['sha256']='c'*64;transport.write_text(json.dumps(value))
  with self.assertRaises(m.Refused):m.source_authority_recheck(a)
 def test_cohort_cannot_borrow_other_source_or_missing_eighth_product(self):
  for change in ['source','product']:
   root=self.root/change;root.mkdir();old=self.repo;self.repo=root
   p,_,v=self.request(True);c=self.repo/'cohort.json';cv=json.loads(c.read_text())
   if change=='source':cv['source_commit']='c'*40
   else:cv['eight_artifacts'].pop('svm')
   c.write_text(json.dumps(cv));v['qualified_cohort']=self.relative(c);p.write_text(json.dumps(v))
   with self.subTest(change=change),self.assertRaises(m.Refused):m.request(p,m.digest(p),self.repo)
   self.repo=old
 def test_pin_rejects_lexical_symlink_and_relative_escape(self):
  p=self.file('target');alias=self.repo/'alias';alias.symlink_to(p)
  with self.assertRaises(m.Refused):m.pin(alias)
  with self.assertRaises(m.Refused):m.checked({**m.pin(p),'path':'../target'},self.repo)
 def test_json_duplicate_infinity_depth_and_public_digest_encoding(self):
  for wire in [b'{"a":1,"a":2}',b'{"a":1e999}',b'['*34+b'0'+b']'*34]:
   with self.subTest(wire=wire[:30]),self.assertRaises(m.Refused):m.decode(wire)
  self.assertEqual(m.decode(b'{"sha256_hex_chunks":["'+b'a'*32+b'","'+b'b'*32+b'"]}'),'a'*32+'b'*32)
 def test_fixed_locked_offline_full_aleo_native_profile_and_two_jobs(self):
  rows=m.compile_plan(self.repo,self.root);self.assertEqual([r['name']for r in rows],['fetch-rust-sources','fetch-evm-oracle-sources','runtime-cargo-metadata','build-rust-three-agent','build-evm-recover-oracle'])
  for row in rows:
   self.assertEqual(row['command'][:2],['cargo','+1.98.0']);self.assertIn('--locked',row['command'])
   if row['name'].startswith('build-'):
    self.assertIn('--offline',row['command']);self.assertIn('--release',row['command']);self.assertEqual(row['command'][row['command'].index('-j')+1],'2');self.assertNotIn('--no-default-features',row['command'])
  runtime=rows[3];self.assertEqual(runtime['cwd'],str(self.repo/'rust/main'));self.assertIn('relayer/aleo,validator/aleo,scraper/aleo',runtime['command']);self.assertIn(str(self.root/'oracle-target'),rows[-1]['command'])
 def test_compile_environment_strips_auth_proxy_wrappers_and_preserves_profile(self):
  cpu=__import__('runpy').run_path(str(REPO/'zig/tools/build_cpu.py'));cpu=types.SimpleNamespace(**cpu)
  env=m.compile_environment(self.root,{'PATH':'/bin','RUSTUP_HOME':'/staged/rustup','GH_TOKEN':'secret','HTTPS_PROXY':'secret','RUSTC_WRAPPER':'secret','CARGO_PROFILE_RELEASE_DEBUG':'1'},cpu)
  self.assertNotIn('GH_TOKEN',env);self.assertNotIn('HTTPS_PROXY',env);self.assertNotIn('CARGO_PROFILE_RELEASE_DEBUG',env);self.assertEqual(env['RUSTC_WRAPPER'],'');self.assertEqual(env['RUSTFLAGS'],'--cfg tokio_unstable -Ctarget-cpu=x86-64-v3');self.assertEqual(m.PROFILE,'locked-c520224-production-three-agent-linux-x86_64-v3-v2');self.assertEqual(env['CARGO_HOME'],str(self.root/'cargo-home'))
 def graph(self,helper_kind='dev'):
  packages=[{'id':n,'name':n,'manifest_path':str(self.repo/'rust/main/agents'/n/'Cargo.toml')}for n in ['relayer','validator','scraper']]+[{'id':'core','name':'core','manifest_path':str(self.repo/'rust/main/hyperlane-core/Cargo.toml')},{'id':'helper','name':'run-locally','manifest_path':str(self.repo/'rust/main/utils/run-locally/Cargo.toml')}]
  nodes=[{'id':n,'deps':[{'pkg':'core','dep_kinds':[{'kind':None}]},{'pkg':'helper','dep_kinds':[{'kind':helper_kind}]}]}for n in ['relayer','validator','scraper']]+[{'id':'core','deps':[]},{'id':'helper','deps':[]}]
  return {'packages':packages,'resolve':{'nodes':nodes}}
 def test_actual_cargo_graph_excludes_dev_only_helper_but_keeps_runtime_core(self):
  paths=m.baseline_reachable_paths(self.graph(),self.repo);self.assertIn('rust/main/hyperlane-core',paths);self.assertIn('rust/main/.cargo',paths);self.assertNotIn('rust/main/utils/run-locally',paths)
 def test_runtime_or_build_helper_edge_rejects_baseline_alias(self):
  for kind in [None,'build']:
   with self.subTest(kind=kind),self.assertRaises(m.Refused):m.baseline_reachable_paths(self.graph(kind),self.repo)
 def test_cargo_missing_resolve_or_wrong_root_fails(self):
  with self.assertRaises(m.Refused):m.baseline_reachable_paths({'resolve':None},self.repo)
  v=self.graph();v['packages'][0]['manifest_path']=str(self.repo/'unrelated/Cargo.toml')
  with self.assertRaises(m.Refused):m.baseline_reachable_paths(v,self.repo)
 def test_actual_cargo_emitted_products_reject_missing_duplicate_foreign_path(self):
  target=self.root/'target';p=target/'release/relayer';p.parent.mkdir(parents=True);p.write_bytes(b'ELF data');log=self.root/'cargo.jsonl';event={'reason':'compiler-artifact','target':{'name':'relayer'},'profile':{'test':False},'executable':str(p)};log.write_text(json.dumps(event)+'\n')
  self.assertEqual(m.cargo_products(log,{'relayer'},target),{'relayer':p})
  for rows,expected in [([event,event],{'relayer'}),([event],{'relayer','validator'}),([{**event,'executable':str(self.file('foreign'))}],{'relayer'})]:
   log.write_text('\n'.join(json.dumps(v)for v in rows))
   with self.assertRaises(m.Refused):m.cargo_products(log,expected,target)
 def test_closed_archive_copy_keeps_layout_modes_hashes_no_symlink(self):
  source=self.root/'archive';source.mkdir();p=source/'bin/tool';p.parent.mkdir();p.write_bytes(b'fixture tool');receipt={'artifacts':{'tools':{'directory':str(source),'files':[{'relative_path':'bin/tool','bytes':p.stat().st_size,'sha256':m.digest(p)}]}}};dest=self.root/'published'
  self.assertEqual(m.archive_copy(receipt,'tools',dest,lambda:None,{'bin/tool'}),{'bin/tool'});self.assertEqual((dest/'bin/tool').read_bytes(),p.read_bytes());self.assertEqual((dest/'bin/tool').stat().st_mode&0o777,0o755)
  with self.assertRaises(m.Refused):m.archive_copy(receipt,'tools',dest,lambda:None,{'bin/tool'})
 def test_original_fixture_preset_ast_without_benchmark_import(self):
  evm=types.SimpleNamespace(CONTRACTS={'Mailbox':'M','MerkleTreeHook':'H','TestIsm':'I','TestRecipient':'R','TestPostDispatchHook':'P','unused':'U'})
  for label in ['validator','scraper']:
   evm.CONTRACTS={'Mailbox':'M','MerkleTreeHook':'H','TestIsm':'I','TestRecipient':'R','TestPostDispatchHook':'P','unused':'U'};nodes=m.fixture_preset_nodes(REPO,label);namespace={'evm':evm};exec(compile(ast.Module(body=nodes,type_ignores=[]),'<actual preset AST>','exec'),namespace)
   self.assertNotIn('unused',evm.CONTRACTS);self.assertIn('Mailbox',evm.CONTRACTS);self.assertIn('ValidatorAnnounce'if label=='validator'else'TestInterchainGasPaymaster',evm.CONTRACTS)
  for label in ['relayer','public']:self.assertEqual(m.fixture_preset_nodes(REPO,label)[0].name,'compile_contracts')
 def test_actual_fixture_source_bytes_are_bound_and_foreign_paths_reject(self):
  p=self.file('solidity/contracts/Fixture.sol',b'contract Actual {}');inputs={'sources':{'solidity/contracts/Fixture.sol':{'content':p.read_text()},'@openzeppelin/contracts/x.sol':{'content':'package data'}}};rows=m.fixture_source_records(inputs,self.repo);self.assertEqual(rows,[self.relative(p)])
  inputs['sources']['solidity/contracts/Fixture.sol']['content']='changed'
  with self.assertRaises(m.Refused):m.fixture_source_records(inputs,self.repo)
  with self.assertRaises(m.Refused):m.fixture_source_records({'sources':{'/private/unrelated.sol':{'content':'not read'}}},self.repo)
 def test_late_result_fsync_revokes_manifest_and_result_no_deadline_reset(self):
  published=self.root/'published';published.mkdir();m.write(published/'input-manifest.json',{'passed':True});result={'passed':True,'whole_deadline_observed':True}
  with mock.patch.object(m.time,'monotonic',return_value=11):final=m.publish_final_result(self.root,published,result,10)
  self.assertFalse(final['passed']);self.assertFalse(json.loads((published/'input-manifest.json').read_text())['passed']);self.assertFalse(json.loads((self.root/'result.json').read_text())['passed']);self.assertTrue(final['publication_deadline_failed'])
 def test_runtime_dlopen_libraries_are_explicit_unique_not_only_role_ldd(self):
  curl=self.file('lib/libcurl.so.4');pq=self.file('lib/libpq.so.5');alias=self.repo/'lib/alias';alias.symlink_to(curl)
  with mock.patch.object(m,'RUNTIME_LIBRARIES',{'libcurl.so.4':[curl,alias],'libpq.so.5':[pq]}):self.assertEqual(m.fixed_runtime_libraries(),{'libcurl.so.4':m.pin(curl),'libpq.so.5':m.pin(pq)})
  other=self.file('lib/other')
  for rows in [{'libcurl.so.4':[curl,other]},{'libpq.so.5':[self.repo/'missing']}]:
   with mock.patch.object(m,'RUNTIME_LIBRARIES',rows),self.assertRaises(m.Refused):m.fixed_runtime_libraries()
 def test_library_parser_rejects_missing_or_unexpected_rows(self):
  self.assertEqual(m.library_rows('libc.so.6 => /lib/libc.so.6 (0x123)\n /lib/ld-linux.so.2 (0x456)\nlinux-vdso.so.1 (0x1)'),{'/lib/libc.so.6','/lib/ld-linux.so.2'})
  for text in ['libfoo.so => not found','arbitrary command output']:
   with self.assertRaises(m.Refused):m.library_rows(text)
 def test_final_phase_rejects_late_zero_signals_missing_wait_and_cleanup(self):
  good={'error_type':None,'actual_parent_wait':True,'exit_code':0,'signals':[],'owned_absent':True,'completed_within_original_deadline':True};self.assertTrue(m.final_phase(good))
  for key,value in [('exit_code',True),('actual_parent_wait',False),('owned_absent',False),('completed_within_original_deadline',False),('signals',[{'signal':9}]),('error_type','TaskInterrupted')]:self.assertFalse(m.final_phase({**good,key:value}))
 def test_real_disk_floor_guard_never_borrowed_from_unit_fixture(self):
  usage=__import__('shutil').disk_usage(self.root);census=types.SimpleNamespace(functional_allocated=lambda root,counters:0);prep=m.Preparation(self.root,self.repo,None,census,100)
  with mock.patch.object(m.time,'monotonic',return_value=1),mock.patch.object(m.shutil,'disk_usage',return_value=type(usage)(usage.total,usage.used,6*m.GIB-1)),self.assertRaises(m.Refused):prep.guard()
  with mock.patch.object(m.time,'monotonic',return_value=101),self.assertRaises(m.Refused):prep.guard()
 def test_scoped_source_cache_guard_rejects_direct_nested_legacy_and_prefix(self):
  for n in ['zig/bench','zig/integration','zig/tools']:(self.repo/n).mkdir(parents=True,exist_ok=True)
  m.source_cache_guard(self.repo)
  for n in ['zig/bench/stale.pyc','zig/integration/nested/__pycache__/m.pyc','zig/tools/stale.pyo']:
   p=self.file(n)
   with self.assertRaises(m.Refused):m.source_cache_guard(self.repo)
   p.unlink()
   if p.parent.name=='__pycache__':p.parent.rmdir()
  with mock.patch.object(m.sys,'pycache_prefix','/foreign'),self.assertRaises(m.Refused):m.source_cache_guard(self.repo)

class Custody(unittest.TestCase):
 setUp=Controls.setUp
 # These exercise the actual Preparation.run integration, never Popen/native IO.
 def setup_run(self,stop_error=False,body_error=None,late=False):
  logs=self.root/'logs';logs.mkdir();child=types.SimpleNamespace(pid=987654,returncode=None);waits=[]
  def wait(timeout):waits.append(timeout);child.returncode=0;return 0
  child.wait=wait
  def stop(child,known,groups):
   if stop_error:raise ValueError('cleanup source failure')
   child.wait(timeout=3);return {'actual_parent_wait':True,'clean':True,'errors':[],'signals':[],'remaining_identities':[],'unanchored_session_members':[]}
  def processes():
   if body_error:raise body_error
   return {os.getpid():{'rss_bytes':100},child.pid:{'rss_bytes':100}}
  owner=types.SimpleNamespace(processes=processes,owned_processes=lambda records,*args:{child.pid:records[child.pid]},stop_owned=stop);prep=m.Preparation(self.root,self.repo,owner,None,100);prep.guard=lambda:None
  return prep,child,waits
 def test_normal_zero_has_real_wait_no_signal_and_absence(self):
  prep,child,waits=self.setup_run()
  with mock.patch.object(m.subprocess,'Popen',return_value=child),mock.patch.object(m.os,'waitid',return_value=object()),mock.patch.object(m.signal,'signal',return_value=None),mock.patch.object(m.time,'monotonic',return_value=1):row=prep.run('normal',['fixed'],{})
  self.assertTrue(m.final_phase(row));self.assertTrue(waits)
 def test_late_actual_zero_is_retained_but_rejected(self):
  prep,child,waits=self.setup_run()
  with mock.patch.object(m.subprocess,'Popen',return_value=child),mock.patch.object(m.os,'waitid',return_value=object()),mock.patch.object(m.signal,'signal',return_value=None),mock.patch.object(m.time,'monotonic',side_effect=[0,1,11]):
   with self.assertRaises(m.Refused):prep.run('late',['fixed'],{},seconds=10)
  self.assertEqual(prep.rows[0]['exit_code'],0);self.assertTrue(prep.rows[0]['actual_parent_wait']);self.assertFalse(prep.rows[0]['completed_within_original_deadline'])
 def test_postspawn_cancellation_preserves_primary_and_still_waits(self):
  primary=m.TaskInterrupted('cancelled');prep,child,waits=self.setup_run(body_error=primary)
  with mock.patch.object(m.subprocess,'Popen',return_value=child),mock.patch.object(m.signal,'signal',return_value=None),mock.patch.object(m.time,'monotonic',return_value=1):
   with self.assertRaises(m.TaskInterrupted)as caught:prep.run('cancelled',['fixed'],{})
  self.assertIs(caught.exception,primary);self.assertTrue(waits);self.assertTrue(prep.rows[0]['actual_parent_wait']);self.assertFalse(m.final_phase(prep.rows[0]))
 def test_cleanup_error_cannot_skip_independent_actual_wait(self):
  primary=m.TaskInterrupted('cancelled');prep,child,waits=self.setup_run(stop_error=True,body_error=primary)
  with mock.patch.object(m.subprocess,'Popen',return_value=child),mock.patch.object(m.os,'waitid',return_value=object()),mock.patch.object(m.signal,'signal',return_value=None),mock.patch.object(m.time,'monotonic',return_value=1):
   with self.assertRaises(m.TaskInterrupted):prep.run('failed-cleanup',['fixed'],{})
  self.assertTrue(waits);self.assertTrue(prep.rows[0]['fallback_actual_parent_wait']);self.assertFalse(prep.rows[0]['owned_absent']);self.assertFalse(m.final_phase(prep.rows[0]))

class FixtureExecutableClosure(unittest.TestCase):
 def test_actual_TLS_command_is_exported_as_a_runtime_tool(self):
  tree=ast.parse((REPO/'zig/integration/tls_fixture.py').read_bytes())
  call=next(n for n in ast.walk(tree)if isinstance(n,ast.Call)and isinstance(n.func,ast.Attribute)and isinstance(n.func.value,ast.Name)and n.func.value.id=='subprocess'and n.func.attr=='run')
  command=ast.literal_eval(call.args[0].elts[0]);self.assertIn(command,m.TOOL_NAMES)
  tree=ast.parse(P.read_bytes());fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='system_inventory');names=next(ast.literal_eval(n.value)for n in fn.body if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='fixture_names'for t in n.targets));self.assertIn(command,names)
 def test_fixed_crash_compiler_must_match_the_recorded_bare_command(self):
  tree=ast.parse((REPO/'zig/integration/relayer_process.py').read_bytes());fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='fault_compile');fixed=ast.literal_eval(next(n for n in fn.body if isinstance(n,ast.Return)).value.elts[0])
  fn=next(n for n in ast.parse(P.read_bytes()).body if isinstance(n,ast.FunctionDef)and n.name=='staged_tools');end=next(i for i,n in enumerate(fn.body)if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='versions'for t in n.targets));code=compile(ast.Module(body=fn.body[:end],type_ignores=[]),'actual-tool-resolution-prefix','exec')
  def namespace(clang):return {'Path':pathlib.Path,'pin':lambda p:{'path':str(p)},'TOOL_NAMES':m.TOOL_NAMES,'native_psql16':lambda tools:{'path':'/fixture-native/psql'},'tools':None,'sys':m.sys,'need':m.need,'plain':{'PATH':'fixture-only'},'shutil':types.SimpleNamespace(which=lambda name,path=None:clang if name=='clang'else'/bin/sh')}
  good=namespace(fixed);exec(code,good);self.assertEqual(good['paths']['clang']['path'],str(pathlib.Path(fixed).resolve(strict=True)))
  with self.assertRaisesRegex(m.Refused,'fixed crash compiler'):exec(code,namespace('/bin/sh'))

class NativePsql16(unittest.TestCase):
 setUp=Controls.setUp
 file=Controls.file
 def tools(self):
  import sys
  old=sys.path[:];sys.path.insert(0,str(P.parent))
  try:
   spec=importlib.util.spec_from_file_location('psql_actual_ELF_admission',P.with_name('native_case_tools.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
  finally:sys.path[:]=old
 def elf(self,machine=62):
  import struct
  wire=bytearray(1024);wire[:8]=b'\x7fELF\x02\x01\x01\x00';struct.pack_into('<HHIQQ',wire,16,3,machine,1,0x400100,64);struct.pack_into('<HHH',wire,52,64,56,2);struct.pack_into('<IIQQQQQQ',wire,64,1,5,0,0x400000,0,len(wire),len(wire),4096);name=b'/lib64/ld-linux-x86-64.so.2\0';struct.pack_into('<IIQQQQQQ',wire,120,3,4,512,0,0,len(name),len(name),1);wire[512:512+len(name)]=name;return wire
 def fixed_path(self,target):
  return mock.patch.object(m,'Path',side_effect=lambda raw:target if str(raw)=='/usr/lib/postgresql/16/bin/psql'else pathlib.Path(raw))
 def test_exact_installed16_native_ELF_is_selected_without_PATH_wrapper(self):
  path=self.file('16/bin/psql',self.elf());path.chmod(0o755)
  with self.fixed_path(path)as selected,mock.patch.object(m.shutil,'which',side_effect=AssertionError('PATH wrapper selected')):row=m.native_psql16(self.tools())
  self.assertEqual(row,m.pin(path));selected.assert_any_call('/usr/lib/postgresql/16/bin/psql')
 def test_script_missing_nonexec_wrong_arch_and_foreign_family_refuse(self):
  path=self.file('16/bin/psql',self.elf());path.chmod(0o755);tools=self.tools()
  for data,mode in [(b'#!/usr/bin/perl\n'+b'#wrapper\n'*20,0o755),(self.elf(183),0o755),(self.elf(),0o644)]:
   path.write_bytes(data);path.chmod(mode)
   with self.subTest(mode=mode),self.fixed_path(path),self.assertRaises(ValueError):m.native_psql16(tools)
  path.unlink()
  with self.fixed_path(path),self.assertRaises(ValueError):m.native_psql16(tools)
  foreign=self.file('17/bin/psql',self.elf());foreign.chmod(0o755);path.symlink_to(foreign)
  with self.fixed_path(path),self.assertRaises(ValueError):m.native_psql16(tools)
 def staged(self,pg_version='psql (PostgreSQL) 16.15'):
  path=self.file('16/bin/psql',self.elf());path.chmod(0o755);self.file('.nvmrc',b'v26.12.1\n');self.file('package.json',json.dumps({'packageManager':'pnpm@12.3.0+sha512.'+'a'*128}).encode());calls=[]
  versions={'cargo':'cargo 1.98.0 fixture','rustc':'rustc 1.98.0 fixture','node':'v26.12.1','pnpm':'12.3.0','psql':pg_version}
  def run(name,command,env,seconds):
   calls.append((name,command,seconds));text='/bin/sh'if name.startswith('resolve-')else versions.get(name.removeprefix('version-'),'fixture tool version');out=self.file('version-results/'+name,text.encode());return {'stdout':m.pin(out)}
  which=lambda name,path=None:'/usr/bin/clang'if name=='clang'else'/bin/sh'
  with self.fixed_path(path),mock.patch.object(m.shutil,'which',side_effect=which):values=m.staged_tools(types.SimpleNamespace(run=run),{'PATH':'fixture-only'},{'PATH':'fixture-compile'},self.repo,self.tools())
  return path,values,calls
 def test_public_inventory_records_selected_psql_invocation_and_preserves_other_resolution(self):
  fn=next(n for n in ast.parse(P.read_bytes()).body if isinstance(n,ast.FunctionDef)and n.name=='producer_main');row=next(n for n in ast.walk(fn)if isinstance(n,ast.Dict)and {getattr(k,'value',None)for k in n.keys}=={'invocation_path','actual_resolved_pin'})
  ns={'name':'psql','plain':{'PATH':'fixture-only'},'system_paths':{'psql':{'path':'/selected-native/psql'},'clang':{'path':'/recorded/clang'}},'shutil':types.SimpleNamespace(which=lambda name,path:'/bare-wrapper/'+name)}
  code=compile(ast.Expression(row),'actual-public-tool-resolution','eval');self.assertEqual(eval(code,ns),{'invocation_path':'/selected-native/psql','actual_resolved_pin':ns['system_paths']['psql']});ns['name']='clang';self.assertEqual(eval(code,ns)['invocation_path'],'/bare-wrapper/clang')
 def test_actual_staged_version_uses_same_native_pin_and_rejects_other_major(self):
  path,(paths,versions),calls=self.staged();self.assertEqual(paths['psql'],m.pin(path));self.assertEqual(next(row for row in calls if row[0]=='version-psql'),('version-psql',[str(path),'--version'],10));self.assertIn('PostgreSQL) 16.',versions['psql']['text'])
  with self.assertRaisesRegex(m.Refused,'PostgreSQL16 client'):self.staged('psql (PostgreSQL) 17.0')

class FixedNativePnpm(unittest.TestCase):
 def recipe(self):
  text=(REPO/'.github/workflows/zig-agents.yml').read_text();chunks=text.split("          /usr/bin/python3 -I -B - <<'PYTHON'\n");rows=[]
  for chunk in chunks[1:]:
   body=chunk.split('          PYTHON\n',1)[0];source='\n'.join(line[10:]for line in body.splitlines())+'\n'
   if 'def run_owned('in source and 'def stage('in source:rows.append(source)
  self.assertEqual(len(rows),3);self.assertEqual(len(set(rows)),1);scope={'__name__':'paired_pnpm_recipe_test'};exec(compile(rows[0],'actual-fixed-pnpm-workflow','exec'),scope);return scope,rows[0]
 def fixture(self):
  tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup);root=pathlib.Path(tmp.name).resolve();repo=root/'repo';helper=repo/'zig/bench/native_tron_setup.py';helper.parent.mkdir(parents=True);base=root/'temp';base.mkdir();path=root/'PATH';path.write_text('existing\n')
  payload=bytearray(40);payload[:6]=b'\x7fELF\x02\x01';payload[18:20]=(62).to_bytes(2,'little');payload=bytes(payload);archive=b'closed fake downloaded package'
  policy={'source_url':'https://registry.npmjs.org/@pnpm/exe.linux-x64/-/exe.linux-x64-12.3.0.tgz','archive_bytes':len(archive),'archive_sha256':hashlib.sha256(archive).hexdigest(),'member':'package/pnpm','bytes':len(payload),'sha256':hashlib.sha256(payload).hexdigest()}
  helper.write_text('PNPM_RELEASE='+repr({'amd64':policy})+'\n');helper.with_name('native_tron_assets.py').write_text('# fixture helper\n');return root,base,repo,path,payload,archive,{'RUNNER_TEMP':str(base),'GITHUB_WORKSPACE':str(repo),'GITHUB_PATH':str(path)}
 def attempt(self,failure=None):
  scope,_=self.recipe();root,base,repo,path,payload,archive,env=self.fixture();calls=[]
  def run(argv,clean,seconds,stdout,file_limit):
   calls.append((argv,dict(clean),seconds,file_limit));self.assertEqual(path.read_text(),'existing\n');self.assertEqual(set(clean),{'PATH','LC_ALL','HOME'})
   kind='download'if argv[1]=='-q'else'admit'if argv[0]=='/usr/bin/python3'else'version'
   if kind==failure:raise RuntimeError('injected '+kind)
   if kind=='download':stdout.write(archive[:-1]if failure=='short-download'else archive)
   elif kind=='admit':
    binary=pathlib.Path(argv[argv.index('--output')+1]);binary.write_bytes(b'#!/bin/sh\nforeign generated launcher\n'if failure=='changed-shim'else payload);binary.chmod(0o755)
   else:stdout.write(b'foreign-version\n'if failure=='bad-version'else b'12.3.0\n')
  with mock.patch.dict(scope,run_owned=run),mock.patch.object(scope['sys'],'platform','linux'),mock.patch.object(scope['os'],'uname',return_value=types.SimpleNamespace(machine='x86_64')),mock.patch.object(scope['shutil'],'which',return_value='/usr/bin/curl'):
   if failure:
    with self.assertRaises(RuntimeError):scope['stage'](env)
    self.assertEqual(path.read_text(),'existing\n');self.assertFalse((base/'ziggy-paired-pnpm-12.3.0').exists())
   else:
    scope['stage'](env);target=base/'ziggy-paired-pnpm-12.3.0';self.assertEqual(path.read_text(),'existing\n'+str(target)+'\n');self.assertEqual([p.name for p in target.iterdir()],['pnpm']);self.assertEqual((target/'pnpm').read_bytes(),payload);self.assertEqual(target.stat().st_mode&0o777,0o700)
  return calls
 def test_same_actual_workflow_recipe_stages_only_exact_owned_native(self):
  rows=self.attempt();self.assertEqual([r[2]for r in rows],[65,30,10]);argv,clean,seconds,cap=rows[0];self.assertEqual(argv[1],'-q');self.assertIn('--proto',argv);self.assertEqual(argv[argv.index('--max-filesize')+1],str(cap));self.assertEqual(argv[argv.index('--max-time')+1],'60');self.assertEqual(argv[argv.index('--connect-timeout')+1],'15');self.assertEqual(argv[argv.index('--retry')+1],'0');self.assertEqual(argv[argv.index('--output')+1],'-');self.assertEqual(clean['PATH'],'/usr/bin:/bin')
 def test_all_failure_boundaries_leave_PATH_unpublished_and_remove_only_owned_scratch(self):
  for phase in ['download','admit','version','bad-version','short-download','changed-shim']:
   with self.subTest(phase=phase):self.attempt(phase)
 def test_preexisting_or_foreign_replaced_root_never_removed(self):
  scope,_=self.recipe();_,base,_,path,_,_,env=self.fixture();target=base/'ziggy-paired-pnpm-12.3.0';target.mkdir();(target/'foreign').write_text('preserve')
  with mock.patch.object(scope['sys'],'platform','linux'),mock.patch.object(scope['os'],'uname',return_value=types.SimpleNamespace(machine='x86_64')),self.assertRaises(FileExistsError):scope['stage'](env)
  self.assertEqual((target/'foreign').read_text(),'preserve');self.assertEqual(path.read_text(),'existing\n')
 def test_replaced_root_cannot_be_cleaned_or_publish_PATH(self):
  scope,_=self.recipe();_,base,_,path,_,_,env=self.fixture();target=base/'ziggy-paired-pnpm-12.3.0'
  def replace(*args,**kwargs):
   target.rename(base/'owned-previous');target.mkdir();(target/'foreign').write_text('preserve');raise RuntimeError('original download failure')
  with mock.patch.dict(scope,run_owned=replace),mock.patch.object(scope['sys'],'platform','linux'),mock.patch.object(scope['os'],'uname',return_value=types.SimpleNamespace(machine='x86_64')),mock.patch.object(scope['shutil'],'which',return_value='/usr/bin/curl'),self.assertRaisesRegex(RuntimeError,'Setup root identity changed'):scope['stage'](env)
  self.assertEqual((target/'foreign').read_text(),'preserve');self.assertEqual(path.read_text(),'existing\n')
 def test_actual_owned_runner_applies_child_file_limit_and_restores_parent_limit(self):
  scope,_=self.recipe();old=scope['resource'].getrlimit(scope['resource'].RLIMIT_FSIZE);seen=[];child=mock.Mock(pid=123);child.wait.return_value=0
  def spawn(*args,**kwargs):seen.append(scope['resource'].getrlimit(scope['resource'].RLIMIT_FSIZE));self.assertNotIn('preexec_fn',kwargs);return child
  with mock.patch.object(scope['subprocess'],'Popen',side_effect=spawn):scope['run_owned'](['fake-curl'],{},65,None,4096)
  self.assertEqual(seen[0][0],4096);self.assertEqual(scope['resource'].getrlimit(scope['resource'].RLIMIT_FSIZE),old);child.wait.assert_called_once_with(timeout=65)
 def test_nonzero_child_is_not_accepted(self):
  scope,_=self.recipe();child=mock.Mock(pid=123);child.wait.return_value=7
  with mock.patch.object(scope['subprocess'],'Popen',return_value=child),self.assertRaisesRegex(RuntimeError,'Fixed pnpm preparation child failed'):scope['run_owned'](['fake'],{},10,None,4096)
  child.wait.assert_called_once_with(timeout=10)
 def test_captured_signal_handler_kills_and_reaps_before_propagating(self):
  scope,source=self.recipe();self.assertIn('signal.signal(signum,interrupted)',source);self.assertIn('[signal.SIGINT,signal.SIGTERM,signal.SIGHUP]',source);child=mock.Mock(pid=123)
  def interruption(*args,**kwargs):scope['interrupted'](scope['signal'].SIGTERM,None)
  calls=[]
  def wait(**kwargs):
   calls.append(kwargs)
   if len(calls)==1:interruption()
   return -9
  child.wait.side_effect=wait
  with mock.patch.object(scope['subprocess'],'Popen',return_value=child),mock.patch.object(scope['os'],'killpg')as kill,self.assertRaisesRegex(RuntimeError,'Fixed pnpm setup interrupted'):scope['run_owned'](['fake'],{},10,None,4096)
  kill.assert_called_once_with(123,scope['signal'].SIGKILL);self.assertEqual(calls,[{'timeout':10},{'timeout':5}])
 def test_timeout_kills_owned_group_and_waits_before_failure(self):
  scope,_=self.recipe();child=mock.Mock(pid=123);child.wait.side_effect=[scope['subprocess'].TimeoutExpired('fake',10),-9]
  with mock.patch.object(scope['subprocess'],'Popen',return_value=child),mock.patch.object(scope['os'],'killpg')as kill,self.assertRaises(scope['subprocess'].TimeoutExpired):scope['run_owned'](['fake'],{},10,None,4096)
  kill.assert_called_once_with(123,scope['signal'].SIGKILL);self.assertEqual(child.wait.call_args_list,[mock.call(timeout=10),mock.call(timeout=5)])
 def test_existing_admission_rejects_same_length_archive_mutation_and_wrong_machine(self):
  import io,tarfile
  scope={'__name__':'existing_pnpm_admission_test'};exec(compile((REPO/'zig/bench/native_tron_setup.py').read_bytes(),'actual-native-tron-setup','exec'),scope)
  payload=bytearray(24);payload[:6]=b'\x7fELF\x02\x01';payload[18:20]=(62).to_bytes(2,'little');payload=bytes(payload)
  def archive(body):
   output=io.BytesIO()
   with tarfile.open(fileobj=output,mode='w:gz')as tar:
    for name,wire in [('package/pnpm',body),('package/package.json',json.dumps({'name':'@pnpm/exe.linux-x64','version':'12.3.0','os':['linux'],'libc':['glibc']}).encode()),('package/LICENSE',b'x'),('package/THIRD-PARTY-NOTICES.md',b'x')]:
     row=tarfile.TarInfo(name);row.size=len(wire);tar.addfile(row,io.BytesIO(wire))
   return output.getvalue()
  blob=archive(payload);policy={'archive_bytes':len(blob),'archive_sha256':hashlib.sha256(blob).hexdigest(),'member':'package/pnpm','bytes':len(payload),'sha256':hashlib.sha256(payload).hexdigest()}
  with mock.patch.dict(scope['PNPM_RELEASE'],amd64=policy):
   self.assertEqual(scope['pnpm_member'](blob,'amd64'),payload);changed=bytearray(blob);changed[4]^=1
   with self.assertRaisesRegex(ValueError,'Exact official Linux'):scope['pnpm_member'](bytes(changed),'amd64')
  wrong=bytearray(payload);wrong[18:20]=(183).to_bytes(2,'little');wrong=bytes(wrong);blob=archive(wrong);policy.update(archive_bytes=len(blob),archive_sha256=hashlib.sha256(blob).hexdigest(),sha256=hashlib.sha256(wrong).hexdigest())
  with mock.patch.dict(scope['PNPM_RELEASE'],amd64=policy),self.assertRaisesRegex(ValueError,'Actual native pnpm payload differs'):scope['pnpm_member'](blob,'amd64')
 def test_actual_curated_archive_and_ELF_policy_are_unchanged(self):
  tree=ast.parse((REPO/'zig/bench/native_tron_setup.py').read_text());policy=next(ast.literal_eval(n.value)for n in tree.body if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='PNPM_RELEASE'for t in n.targets))['amd64'];self.assertEqual((policy['archive_bytes'],policy['bytes']),(19223500,44686464));self.assertEqual(policy['archive_sha256'],'bca0e805a33855a99c7b2557a842212d'+'67994785217cb8922b33d2c0e40815cb');self.assertEqual(policy['sha256'],'5635ac1a8305715ce6edc028890c9b30'+'d26f743733e215105ddc131ae5cfe186');self.assertTrue({'zig/bench/native_tron_setup.py','zig/bench/native_tron_assets.py'}<=m.CODE)

if __name__=='__main__':unittest.main(verbosity=2)
