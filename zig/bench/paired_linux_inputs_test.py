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
  env=m.compile_environment(self.root,{'PATH':'/bin','RUSTUP_HOME':'/staged/rustup','GH_TOKEN':'secret','HTTPS_PROXY':'secret','RUSTC_WRAPPER':'secret','CARGO_PROFILE_RELEASE_DEBUG':'1'})
  self.assertNotIn('GH_TOKEN',env);self.assertNotIn('HTTPS_PROXY',env);self.assertNotIn('CARGO_PROFILE_RELEASE_DEBUG',env);self.assertEqual(env['RUSTC_WRAPPER'],'');self.assertEqual(env['RUSTFLAGS'],'--cfg tokio_unstable -Ctarget-cpu=native');self.assertEqual(env['CARGO_HOME'],str(self.root/'cargo-home'))
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
  def namespace(clang):return {'Path':pathlib.Path,'pin':lambda p:{'path':str(p)},'TOOL_NAMES':m.TOOL_NAMES,'sys':m.sys,'need':m.need,'plain':{'PATH':'fixture-only'},'shutil':types.SimpleNamespace(which=lambda name,path=None:clang if name=='clang'else'/bin/sh')}
  good=namespace(fixed);exec(code,good);self.assertEqual(good['paths']['clang']['path'],str(pathlib.Path(fixed).resolve(strict=True)))
  with self.assertRaisesRegex(m.Refused,'fixed crash compiler'):exec(code,namespace('/bin/sh'))

if __name__=='__main__':unittest.main(verbosity=2)
