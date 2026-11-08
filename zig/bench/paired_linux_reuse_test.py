"""Pure reuse/schema/ZIP/semantic boundaries. No network/process/SDK/native."""
from pathlib import Path
import ast,copy,hashlib,importlib.util,io,json,os,re,sys,tempfile,types,unittest,zipfile
from unittest import mock
HERE=Path(__file__).resolve().parent
SUPPORT=Path(os.environ.get('PAIRED_REUSE_CONTROL_SUPPORT',str(HERE)))
sys.path.insert(0,str(SUPPORT));sys.path.insert(0,str(HERE))
import paired_linux_reuse as r
p=r.policy
SOURCE_REPO=Path(os.environ.get('PAIRED_REUSE_CONTROL_REPO',str(HERE.parents[1]))).resolve()
def metadata(path,value):
 path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(value));return p.pin(path)
def member(path,name):return {'member':name,'bytes':path.stat().st_size,'sha256':p.pin(path)['sha256']}
class Reuse(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve();self.repo=self.root/'repo';self.repo.mkdir();self.commit='a'*40;self.producer='b'*40
 def header(self):
  original=[];current=[]
  for name in sorted(p.SOURCE_PATHS|{r.PORT_TEST}):
   path=self.repo/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text('# public Source fixture\n');row={**p.pin(path),'path':name};original.append(copy.deepcopy(row));current.append(row)
  old=next(x for x in original if x['path']==r.WORKFLOW);old.update(bytes=3,sha256=hashlib.sha256(b'old').hexdigest());(self.repo/r.WORKFLOW).write_text('current');now=next(x for x in current if x['path']==r.WORKFLOW);now.update(bytes=7,sha256=hashlib.sha256(b'current').hexdigest())
  path=self.repo/r.SELF;path.write_bytes((HERE/'paired_linux_reuse.py').read_bytes());current.append({**p.pin(path),'path':r.SELF})
  origin={'run_id':42,'run_attempt':1,'source_commit':self.commit,'job_id':100,'job_name':'paired-linux-inputs'};input_artifact={'id':200,'name':'paired-linux-inputs-42-1','size_in_bytes':123,'sha256':'c'*64};proofs=[]
  for i in range(6):
   proofs.append({'index':i,'mode':p.MODES[i//3],'kind':p.KINDS[i%3],'origin':{**origin,'job_id':101+i,'job_name':f'paired-linux-functional ({i})'},'artifact':{'id':201+i,'name':f'paired-linux-proof-{i}-42-1','size_in_bytes':100,'sha256':'d'*64},'members':{name:{'member':f'paired-linux-proof-{i}/{name}.json','bytes':10,'sha256':'e'*64}for name in r.MEMBERS}})
  return {'schema':1,'kind':'paired-linux-reuse-v1','root_approved':True,'Root_input_accepted':True,'Root_six_accepted':True,'producer_source_commit':self.producer,'baseline_source_commit':p.BASELINE,'origin':origin,'original_request':{'path':r.REQUEST,'bytes':100,'sha256':'f'*64},'original_source':original,'input_artifact':input_artifact,'input_manifest':{'member':'input-manifest.json','bytes':100,'sha256':'1'*64},'proofs':proofs,'current_source':current,'workflow_recipe_delta':{'original':old,'current':now}}
 def test_empty_header_inert_before_any_Source_or_IO_or_import(self):
  row=metadata(self.root/'header.json',r.inert_header());out=self.root/'untouched'
  with mock.patch.object(p,'load_source',side_effect=AssertionError('module loaded')),mock.patch.object(r.resource,'setrlimit',side_effect=AssertionError('limit changed')):
   value=r.reuse(row,self.repo,out,'not-current',None,None)
  self.assertEqual(value,{'enabled':False,'input_rebuild':False,'native_or_timing_acceptance':False});self.assertFalse(out.exists())
 def test_false_future_pins_and_oversized_header_refuse_before_read(self):
  value=r.inert_header();value['origin']={};row=metadata(self.root/'header.json',value)
  with self.assertRaises(p.Refused):r.read_header(row,self.repo)
  with mock.patch.object(p,'checked',side_effect=AssertionError('oversized header read')):
   with self.assertRaises(p.Refused):r.read_header({'path':'/not-read','bytes':2*1024**2+1,'sha256':'a'*64},self.repo)
 def test_closed_actual_header_accepts_finite_original_and_current_source(self):
  value=self.header();row=metadata(self.root/'header.json',value);self.assertEqual(r.read_header(row,self.repo),value)
 def test_header_rejects_missing_duplicate_foreign_Mode_Source_request_or_paths(self):
  value=self.header();changes=[lambda v:v['proofs'].pop(),lambda v:v['proofs'][1].update(index=0),lambda v:v['proofs'][0].update(mode='ReleaseFast'),lambda v:v['proofs'][0]['origin'].update(source_commit='c'*40),lambda v:v['proofs'][0]['artifact'].update(id=v['input_artifact']['id']),lambda v:v['proofs'][0]['members']['proof'].update(member='../escape'),lambda v:v['original_request'].update(path='.git/config'),lambda v:v.update(Root_six_accepted=False),lambda v:v.update(extra=True)]
  for change in changes:
   v=copy.deepcopy(value);change(v);row=metadata(self.root/'header.json',v)
   with self.subTest(change=change),self.assertRaises(p.Refused):r.read_header(row,self.repo)
 def test_current_port_owner_helpers_must_equal_original_whole_files(self):
  value=self.header()
  for name in ['zig/integration/relayer_process.py','zig/bench/paired_linux_owner.py','zig/bench/paired_linux_proofs.py',r.PORT_TEST]:
   path=self.repo/name;old=path.read_bytes();path.write_text('changed')
   row=metadata(self.root/'header.json',value)
   with self.assertRaises(p.Refused):r.read_header(row,self.repo)
   # Even an updated current pin cannot turn this into a broad Source exception.
   v=copy.deepcopy(value);selected=next(x for x in v['current_source']if x['path']==name);selected.update(bytes=7,sha256=hashlib.sha256(b'changed').hexdigest());row=metadata(self.root/'header.json',v)
   with self.assertRaisesRegex(p.Refused,'original proof/port8'):r.read_header(row,self.repo)
   path.write_bytes(old)
 def remote(self,header,origin=None,artifact=None):
  origin=origin or header['origin'];artifact=artifact or header['input_artifact'];run={'id':42,'run_attempt':1,'head_sha':self.commit,'repository':{'full_name':r.REPOSITORY},'head_repository':{'full_name':r.REPOSITORY},'path':r.WORKFLOW,'event':'push'};jobs=[{'id':origin['job_id'],'name':origin['job_name'],'run_id':42,'run_attempt':1,'status':'completed','conclusion':'success'}];artifacts=[{**artifact,'expired':False,'digest':'sha256:'+artifact['sha256'],'workflow_run':{'id':42,'head_sha':self.commit}}];return run,jobs,artifacts
 def test_actual_remote_job_artifact_digest_attempt_and_repo_are_independent(self):
  h=self.header();args=self.remote(h);self.assertEqual(r.actual_remote(h['origin'],h['input_artifact'],*args)['artifact_id'],200)
  bad=[(dict(args[0],run_attempt=2),args[1],args[2]),(dict(args[0],head_repository={'full_name':'foreign/repo'}),args[1],args[2]),(args[0],[dict(args[1][0],conclusion='failure')],args[2]),(args[0],args[1]*2,args[2]),(args[0],args[1],[dict(args[2][0],digest='sha256:'+'f'*64)]),(args[0],args[1],[dict(args[2][0],expired=True)])]
  for values in bad:
   with self.assertRaises(p.Refused):r.actual_remote(h['origin'],h['input_artifact'],*values)
 def test_attempt_API_uses_qualified_runner_with_only_exact_read_route(self):
  runner=types.SimpleNamespace(gh=Path('/fixed/gh'),call=mock.Mock(return_value=(Path('/owned/data'),0)))
  self.assertEqual(r.attempt_json(runner,42,1,'jobs',2),Path('/owned/data'));self.assertEqual(runner.call.call_args.args[0][-1],'repos/'+r.REPOSITORY+'/actions/runs/42/attempts/1/jobs?per_page=100&page=2');self.assertEqual(runner.call.call_args.args[1],'API_JSON')
  for args in [(True,1,None,None),(42,0,None,None),(42,1,'artifacts',1),(42,1,'jobs',21)]:
   with self.assertRaises(p.Refused):r.attempt_json(runner,*args)
 def test_original_request_and_all_source_come_from_exact_Git_objects(self):
  h=self.header();original={row['path']:row for row in h['original_source']};wire={'schema':1,'kind':'paired-linux-ci-v1',**{k:None for k in p.FIELDS-{'schema','kind','root_approved','inputs_enabled','functional_enabled','runtime_enabled','producer_source_commit','baseline_source_commit','baseline_profile','required_source'}},'root_approved':True,'inputs_enabled':True,'functional_enabled':True,'runtime_enabled':False,'producer_source_commit':self.producer,'baseline_source_commit':p.BASELINE,'baseline_profile':r.BASELINE_PROFILE,'required_source':[row for name,row in original.items()if name!=r.PORT_TEST]};path=self.root/'original-request';metadata(path,wire);h['original_request']={**p.pin(path),'path':r.REQUEST};blobs={r.REQUEST:path.read_bytes()}
  for row in h['original_source']:
   raw=b'old'if row['path']==r.WORKFLOW else(self.repo/row['path']).read_bytes();blobs[row['path']]=raw
  calls=[]
  class Runner:
   def git(inner,args,maximum):
    calls.append(args);self.assertTrue(args[1].startswith(self.commit+':'));out=self.root/'git-result';out.write_bytes(blobs[args[1].split(':',1)[1]]);return out,0
  value=r.git_original(Runner(),h);self.assertEqual(value['Source_rows'],len(original));self.assertEqual(len(calls),len(original)+1)
  blobs[r.REQUEST]=b'{}'
  with self.assertRaises(p.Refused):r.git_original(Runner(),h)
 def proof(self,index=0):
  mode=p.MODES[index//3];kind=p.KINDS[index%3];raw={'passed':True,'binaries':{'relayer_sha256_chunks':['a'*64],'validator_sha256_chunks':['b'*64],'rust_oracle_sha256_chunks':['d'*64]},'executables':{'relayer_sha256_chunks':['a'*64],'validator_sha256_chunks':['b'*64],'rocks_oracle_sha256_chunks':['d'*64],'rust_reference_sha256_chunks':['e'*64]},'rust_oracle_sha256_chunks':['d'*64],'validator_url_library':{'sha256_chunks':['c'*64]}}
  root=self.root/('proof-'+str(index));root.mkdir();raw_pin=metadata(root/'proof.json',raw);launches=[{'pid':1,'mode':mode,'binary_sha256':'a'*64},{'pid':2,'mode':mode,'binary_sha256':'b'*64}];launch_pin=metadata(root/'launches.json',launches);h=self.header();h['input_manifest']={'member':'input-manifest.json','bytes':20,'sha256':'2'*64};req={'path':'/old/runner/request.json',**r.size_sha(h['original_request'],1024)};manifest_pin={'path':'/old/runner/published/input-manifest.json',**r.size_sha(h['input_manifest'],1024)};summary={'strict':'synthetic semantic boundary'}
  worker={'schema':1,'kind':'paired-linux-functional-result','platform':'linux-x86_64','passed':True,'index':index,'mode':mode,'proof_kind':kind,'production_confirm_seconds':600,'bounded_grace_seconds':30,'native18_or_timing_acceptance':False,'request':req,'input_manifest':manifest_pin,'proof':{**raw_pin,'path':'/old/runner/proof/proof.json'},'actual_role_launches':launches,'strict_cases':summary};worker_pin=metadata(root/'functional-result.json',worker)
  clean={'actual_parent_wait':True,'exit_code':0,'clean':True,'cleanup_confirmed_absent':True,'signals':[],'errors':[],'remaining_identities':[],'unanchored_session_members':[],'actual_adopted_child_waits':[]};owner={'schema':1,'kind':'paired-linux-owned-functional','platform':'linux-x86_64','passed':True,'index':index,'error_type':None,'native18_or_performance_acceptance':False,'request':req,'cleanup':clean,'limits':{'wall_seconds':7200,'RSS_bytes':4*r.GIB,'new_disk_bytes':512*1024**2,'free_bytes':6*r.GIB},'original_wall_seconds':7200,'started_monotonic':1,'original_deadline_monotonic':7201,'ended_monotonic':7000,'sampled_tree_RSS_peak_bytes':100,'new_allocated_peak_bytes':100,'minimum_host_free_bytes':7*r.GIB,'worker_receipt':{**worker_pin,'path':'/old/runner/proof/functional-result.json'}};owner_pin=metadata(root/'owner-result.json',owner)
  a=h['input_artifact'];o=h['origin'];consumer={'schema':1,'kind':'paired-linux-input-consumer','passed':True,'consumer_cpu_and_elf_admitted':True,'tool_manifest_admitted':True,'native18_or_timing_acceptance':False,'request':req,'input_manifest':manifest_pin,'actual_commands':{'all_calls_actually_waited':True,'actual_calls':4,'actual_parent_waits':4,'failure_count':0},'remote':{'id':a['id'],'name':a['name'],'bytes':a['size_in_bytes'],'sha256':a['sha256'],'run_id':o['run_id'],'run_attempt':o['run_attempt'],'source_commit':o['source_commit'],'job_id':o['job_id']}};metadata(root/'consumer-result.json',consumer)
  files={'owner':root/'owner-result.json','worker':root/'functional-result.json','proof':root/'proof.json','launches':root/'launches.json','consumer':root/'consumer-result.json'};slot=h['proofs'][index];slot['members']={name:member(path,path.name)for name,path in files.items()};manifest={'artifacts':{'zig':{mode:{'relayer':{'sha256':'a'*64},'validator':{'sha256':'b'*64},'url':{'sha256':'c'*64}}},'tools':{'ziggy-rocks-oracle':{'sha256':'d'*64},'ziggy-rust-reference':{'sha256':'e'*64}}}};semantic=types.SimpleNamespace(validate=mock.Mock(return_value=summary));return slot,files,manifest,h,semantic
 def test_relocated_owner_worker_and_products_checked_without_oldpath_IO(self):
  for i in range(6):
   slot,files,manifest,h,semantic=self.proof(i);value=r.validate_proof(slot,files,manifest,h,semantic,self.repo);self.assertEqual(value['index'],i);semantic.validate.assert_called_once_with(slot['kind'],p.decode(files['proof'].read_bytes()),'a'*64,self.repo)
 def test_owner_late_signal_ambiguous_absence_Mac_or_failed_wait_cannot_be_reused(self):
  slot,files,manifest,h,semantic=self.proof();old=files['owner'].read_bytes();changes=[lambda v:v.update(platform='darwin-arm64'),lambda v:v['cleanup'].update(actual_parent_wait=False),lambda v:v['cleanup'].update(cleanup_confirmed_absent=False),lambda v:v['cleanup'].update(signals=[15]),lambda v:v.update(ended_monotonic=7201),lambda v:v.update(sampled_tree_RSS_peak_bytes=5*r.GIB)]
  for change in changes:
   v=json.loads(old);change(v);metadata(files['owner'],v)
   with self.assertRaises(p.Refused):r.validate_proof(slot,files,manifest,h,semantic,self.repo)
 def test_foreign_role_dependency_or_600_policy_receipt_is_refused(self):
  slot,files,manifest,h,semantic=self.proof();old=files['worker'].read_bytes()
  for change in [lambda v:v.update(bounded_grace_seconds=29),lambda v:v.update(production_confirm_seconds=599),lambda v:v.update(mode='ReleaseFast'),lambda v:v['request'].update(sha256='9'*64)]:
   v=json.loads(old);change(v);metadata(files['worker'],v)
   with self.assertRaises(p.Refused):r.validate_proof(slot,files,manifest,h,semantic,self.repo)
  files['worker'].write_bytes(old);raw=json.loads(files['proof'].read_text());raw['binaries']['validator_sha256_chunks']=['f'*64];metadata(files['proof'],raw)
  with self.assertRaises(p.Refused):r.validate_proof(slot,files,manifest,h,semantic,self.repo)
 def settlement(self,count,historical=0):
  return {'production_confirm_seconds':600,'bounded_grace_seconds':30,'expected_tracked_messages':count,'historical_offset_is_upper_bound_not_injected_counter':True,'historical_confirmed_offset':historical,'operations_confirmed':historical+count,'first_live_completion':{'confirmed':historical+count,'monotonic':701},'first_proxy_inclusions':[{'id_chunks':[str(i)],'first_positive_receipt_or_delivered_monotonic_seconds':100}for i in range(count)]}
 def semantic(self):
  spec=importlib.util.spec_from_file_location('actual_reuse_semantic',SUPPORT/'paired_linux_proofs.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
 def update_raw(self,slot,files,raw,summary):
  metadata(files['proof'],raw);slot['members']['proof']=member(files['proof'],files['proof'].name);worker=json.loads(files['worker'].read_text());worker['proof']={'path':'/old/runner/proof/proof.json',**r.size_sha(p.pin(files['proof']),64*1024**2)};worker['strict_cases']=summary;metadata(files['worker'],worker);slot['members']['worker']=member(files['worker'],files['worker'].name);owner=json.loads(files['owner'].read_text());owner['worker_receipt']={'path':'/old/runner/proof/functional-result.json',**r.size_sha(p.pin(files['worker']),64*1024**2)};metadata(files['owner'],owner)
 def test_actual_process_semantic_parser_still_enforces_600_batch_crash_and_fault(self):
  slot,files,manifest,h,_=self.proof();semantic=self.semantic();raw=json.loads(files['proof'].read_text());raw.update(settlement=self.settlement(3),max_batch_4={'settlement':self.settlement(4),'actual_allocation':{'calls':4,'members':[1,2,3,4]},'stop':{'exit':0}},preenqueue_crash={'passed':True,'recovery_new_nonce_count':1,'restart_new_nonce_count':0,'settlement':self.settlement(1),'recovery_stop':{'exit':0},'replay_stop':{'exit':0}},restart_nonce_unchanged=True,gas_expenditure_recorded=True,origin_progress_during_receipt_stall=True,fault_injection={'self_test':{'positive_real_write_sigkill':True,'unrelated_path_negative_control':True,'write_modes':['write','pwrite','writev','pwrite64'],'path_negative_count':4}},**{name:{'exit':0}for name in ['validator_stop','first_stop','restart_stop','stalled_stop']});summary=semantic.validate(slot['kind'],raw,'a'*64,SOURCE_REPO);self.update_raw(slot,files,raw,summary);self.assertTrue(r.validate_proof(slot,files,manifest,h,semantic,SOURCE_REPO)['actual_owner_parent_wait0'])
  for mutate in [lambda v:v['settlement']['first_live_completion'].update(monotonic=699),lambda v:v['max_batch_4']['actual_allocation'].update(calls=3),lambda v:v['preenqueue_crash'].update(restart_new_nonce_count=1),lambda v:v['fault_injection']['self_test'].update(path_negative_count=3)]:
   bad=copy.deepcopy(raw);mutate(bad);self.update_raw(slot,files,bad,summary)
   with self.assertRaises(RuntimeError):r.validate_proof(slot,files,manifest,h,semantic,SOURCE_REPO)
 def test_actual_WSS_semantic_parser_retains_exact_restart_and_history(self):
  slot,files,manifest,h,_=self.proof(1);semantic=self.semantic();raw=json.loads(files['proof'].read_text());raw['case']={'passed':True,'restart':{'existing_rust_rows_unchanged':True,'nonce_increase':2,'sigterm':{'exit':0},'settlement':self.settlement(2,3)},'late_and_stalled_origin':{'sigterm':{'exit':0}}};summary=semantic.validate(slot['kind'],raw,'a'*64,SOURCE_REPO);self.update_raw(slot,files,raw,summary);self.assertEqual(r.validate_proof(slot,files,manifest,h,semantic,SOURCE_REPO)['strict_cases'],summary)
  raw['case']['restart']['nonce_increase']=3;self.update_raw(slot,files,raw,summary)
  with self.assertRaises(RuntimeError):r.validate_proof(slot,files,manifest,h,semantic,SOURCE_REPO)
 def transport_fixture(self):
  h=self.header();manifest={'schema':1,'kind':'paired-linux-inputs-v1','platform':'linux-x86_64','producer_source_commit':self.producer,'execution_source_commit':self.commit,'baseline_source_commit':p.BASELINE,'request_sha256':None,'baseline_profile':r.BASELINE_PROFILE,'artifacts':{'zig':{mode:{'relayer':{'sha256':'a'*64},'validator':{'sha256':'b'*64},'url':{'sha256':'c'*64}}for mode in p.MODES},'tools':{'ziggy-rocks-oracle':{'sha256':'d'*64},'ziggy-rust-reference':{'sha256':'e'*64}}}}
  original={x['path']:x for x in h['original_source']};request={'schema':1,'kind':'paired-linux-ci-v1',**{k:None for k in p.FIELDS-{'schema','kind','root_approved','inputs_enabled','functional_enabled','runtime_enabled','producer_source_commit','baseline_source_commit','baseline_profile','required_source'}},'root_approved':True,'inputs_enabled':True,'functional_enabled':True,'runtime_enabled':False,'producer_source_commit':self.producer,'baseline_source_commit':p.BASELINE,'baseline_profile':r.BASELINE_PROFILE,'required_source':[v for k,v in original.items()if k!=r.PORT_TEST]};request_wire=json.dumps(request).encode();h['original_request']={'path':r.REQUEST,'bytes':len(request_wire),'sha256':hashlib.sha256(request_wire).hexdigest()};manifest['request_sha256']=h['original_request']['sha256']
  source_gate={'schema':1,'source_unchanged':True,'source_before':{'public':'Source'},'source_after':{'public':'Source'},'execution_source_commit':self.commit,'producer_source_commit':self.producer,'baseline':{'baseline_source_commit':p.BASELINE,'build_checkout_commit':self.commit,'compiled_Source_equal':True,'helper_fixture_excluded_by_actual_Cargo_reachability':True,'profile':r.BASELINE_PROFILE,'RUSTFLAGS':'--cfg tokio_unstable -Ctarget-cpu=native'},'actual_waited_Git_checks':[{'actual_parent_wait':True,'exit_code':0}]};build={'passed':True,'fixed_profile':r.BASELINE_PROFILE,'actual_commands':[{'error_type':None,'actual_parent_wait':True,'exit_code':0,'signals':[],'owned_absent':True,'completed_within_original_deadline':True,'completion_check_ns':1,'original_deadline_monotonic_ns':2}]};payload={}
  for name,value in [('source-gate.json',source_gate),('build.json',build)]:
   raw=json.dumps(value).encode();payload[name]=raw;manifest['source_gate'if name=='source-gate.json'else'build_receipt']={'path':name,'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
  raw=json.dumps(manifest).encode();payload['input-manifest.json']=raw;h['input_manifest']={'member':'input-manifest.json','bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()};blobs={r.REQUEST:request_wire,**{x['path']:(b'old'if x['path']==r.WORKFLOW else(self.repo/x['path']).read_bytes())for x in h['original_source']}}
  zip_rows={}
  def zipped(files):
   out=io.BytesIO()
   with zipfile.ZipFile(out,'w',compression=zipfile.ZIP_DEFLATED)as z:
    for name,wire in files.items():z.writestr(name,wire)
   return out.getvalue()
  raw=zipped(payload);h['input_artifact'].update(size_in_bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest());zip_rows[h['input_artifact']['id']]=raw
  for i in range(6):
   slot,files,_,_,semantic=self.proof(i)
   worker=json.loads(files['worker'].read_text());consumer=json.loads(files['consumer'].read_text());owner=json.loads(files['owner'].read_text());request_pin={'path':'/old/request.json',**r.size_sha(h['original_request'],1024**2)};input_pin={'path':'/old/published/input-manifest.json',**r.size_sha(h['input_manifest'],32*1024**2)}
   worker.update(request=request_pin,input_manifest=input_pin);metadata(files['worker'],worker);owner.update(request=request_pin,worker_receipt={'path':'/old/runner/proof/functional-result.json',**r.size_sha(p.pin(files['worker']),64*1024**2)});metadata(files['owner'],owner);a=h['input_artifact'];o=h['origin'];consumer.update(request=request_pin,input_manifest=input_pin,remote={'id':a['id'],'name':a['name'],'bytes':a['size_in_bytes'],'sha256':a['sha256'],'run_id':o['run_id'],'run_attempt':o['run_attempt'],'source_commit':o['source_commit'],'job_id':o['job_id']});metadata(files['consumer'],consumer)
   payload={path.name:path.read_bytes()for path in files.values()};slot['members']={name:member(path,path.name)for name,path in files.items()};raw=zipped(payload);slot['artifact'].update(size_in_bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest());h['proofs'][i]=slot;zip_rows[slot['artifact']['id']]=raw
  return h,manifest,blobs,zip_rows
 def test_actual_crossrun_reader_relocates_all7_ZIPs_without_oldpath_IO(self):
  self.exercise_transport(False)
 def test_actual_archive_digest_failure_leaves_no_accepted_join(self):
  self.exercise_transport(True)
 def test_final_cleanup_failure_cannot_publish_accepted_join(self):
  self.exercise_transport(False,'cleanup')
 def test_publication_failure_cannot_leave_positive_join(self):
  self.exercise_transport(False,'publication')
 def exercise_transport(self,corrupt,final_failure=None):
  import contextlib
  h,manifest,blobs,zips=self.transport_fixture();header_pin=metadata(self.root/'header.json',h);output=self.root/'new-run';read_spec=importlib.util.spec_from_file_location('reuse_real_archive',SOURCE_REPO/'zig/bench/cohort_readback.py');reader=importlib.util.module_from_spec(read_spec);read_spec.loader.exec_module(reader)
  stage_spec=importlib.util.spec_from_file_location('reuse_real_extract',SUPPORT/'paired_linux_stage.py');stage=importlib.util.module_from_spec(stage_spec);stage_spec.loader.exec_module(stage)
  # Transport integration is real Source/header/Git-byte/API/ZIP/hash/receipt
  # binding. Hardware/ELF admission is stubbed explicitly and asserted called;
  # strict actual semantic parser is exercised separately, never fake-native.
  admitted=mock.Mock();st=types.SimpleNamespace(extract=stage.extract,admit=admitted,arm_interrupts=lambda guard:{},restore_interrupts=lambda previous:None);semantic=types.SimpleNamespace(validate=mock.Mock(return_value={'strict':'synthetic semantic boundary'}))
  run={'id':42,'run_attempt':1,'head_sha':self.commit,'repository':{'full_name':r.REPOSITORY},'head_repository':{'full_name':r.REPOSITORY},'path':r.WORKFLOW,'event':'push'};origins=[h['origin'],*[s['origin']for s in h['proofs']]];artifacts=[h['input_artifact'],*[s['artifact']for s in h['proofs']]];jobs=[{'id':o['job_id'],'name':o['job_name'],'run_id':42,'run_attempt':1,'status':'completed','conclusion':'success'}for o in origins];remote=[{**a,'expired':False,'digest':'sha256:'+a['sha256'],'workflow_run':{'id':42,'head_sha':self.commit}}for a in artifacts];calls=[];case=self
  class Guard:
   def __init__(self,root,limits):self.deadline=1800;self.cleanup_deadline=1860;self.clock=lambda:0
   def __call__(self,*args):pass
   def cleanup(self):
    if final_failure=='cleanup':raise RuntimeError('fixed synthetic cleanup failure')
  class Runner:
   def __init__(self,root,*args):self.root=root;self.n=0;self.gh=Path('/fixed/gh')
   def save(self,raw):
    self.n+=1;path=self.root/('call-'+str(self.n)+'.stdout');path.write_bytes(raw);return path
   def git(self,args,maximum):
    calls.append(('git',args));return self.save(('c'*40).encode()if args==['rev-parse','HEAD']else blobs[args[1].split(':',1)[1]]),0
   def api(self,path,maximum=0):
    calls.append(('api',path))
    if path.endswith('/zip'):
     identity=int(path.split('/')[-2]);raw=zips[identity]
     if corrupt and identity==200:
      # A valid alternate archive with identical member bytes; only the whole
      # publisher archive digest gate may reject its changed ZIP comment.
      changed=io.BytesIO(raw)
      with zipfile.ZipFile(changed,'a')as archive:archive.comment=b'tampered archive bytes'
      raw=changed.getvalue()
     return self.save(raw)
    value=run if path.endswith('/attempts/1')else {'jobs':jobs}if '/jobs?'in path else {'artifacts':remote};return self.save(json.dumps(value).encode())
   def call(self,args,kind,maximum):
    case.assertEqual(kind,'API_JSON');case.assertEqual(args[:3],['/fixed/gh','api','--hostname']);return self.api(args[-1]),0
   def summary(self):return {'all_calls_actually_waited':True,'failure_count':0,'synthetic_transport_control':True}
  reader.Runner=Runner;reader.Guard=Guard
  def loader(path,name,authority,repo):return reader if path.name=='cohort_readback.py'else st if path.name=='paired_linux_stage.py'else semantic
  with contextlib.ExitStack()as stack:
   stack.enter_context(mock.patch.object(r.sys,'platform','linux'));stack.enter_context(mock.patch.object(r.platform,'machine',return_value='x86_64'));stack.enter_context(mock.patch.object(r.resource,'setrlimit'));stack.enter_context(mock.patch.object(r,'__file__',str(self.repo/r.SELF)));stack.enter_context(mock.patch.object(p,'load_source',side_effect=loader));stack.enter_context(mock.patch.object(p,'input_manifest',return_value=manifest))
   if final_failure=='publication':
    original_write=p.write
    def write(path,value):
     if path.name=='reuse-result.json':raise OSError('fixed synthetic publication failure')
     return original_write(path,value)
    stack.enter_context(mock.patch.object(p,'write',side_effect=write))
   if corrupt or final_failure is not None:
    with self.assertRaises(p.Refused):r.reuse(header_pin,self.repo,output,'c'*40,Path('/fixed/gh'),'PRIVATE_SENTINEL')
    self.assertFalse((output/'accepted-six.json').exists())
    if final_failure!='publication':self.assertFalse(json.loads((output/'reuse-result.json').read_text())['passed'])
    if corrupt:admitted.assert_not_called()
    else:admitted.assert_called_once()
   else:
    value=r.reuse(header_pin,self.repo,output,'c'*40,Path('/fixed/gh'),'PRIVATE_SENTINEL');self.assertEqual(value['inputs_root'],str(output/'published'));self.assertTrue(all(Path(row['path']).is_relative_to(output)for group in value['proofs'].values()for row in group.values()));self.assertEqual(len(semantic.validate.call_args_list),6);admitted.assert_called_once();joined=json.loads(Path(value['accepted_six']['path']).read_text());self.assertEqual(joined['original_input_execution']['source_commit'],self.commit);self.assertEqual(joined['current_consumer_execution_source_commit'],'c'*40);self.assertFalse(joined['input_rebuilt']);self.assertFalse(joined['native18_or_timing_acceptance']);self.assertNotIn('PRIVATE_SENTINEL',json.dumps(value));self.assertEqual(len(list(output.glob('*.stdout')))>0,True)
  self.assertTrue(any(kind=='git'for kind,_ in calls))
 def test_source_publication_no_benchmark_or_artifact_code_execution(self):
  tree=ast.parse((HERE/'paired_linux_reuse.py').read_text());calls=[n for n in ast.walk(tree)if isinstance(n,ast.Call)and isinstance(n.func,ast.Attribute)and n.func.attr in {'Popen','run','CDLL','dlopen'}];self.assertEqual(calls,[])
  text=(HERE/'paired_linux_reuse.py').read_text();self.assertNotIn('from paired_linux_owner import',text);self.assertNotIn('read_bytes())for',text)
def audit(event,args):
 if event.startswith('socket.')or event in {'subprocess.Popen','os.fork','os.exec','ctypes.dlopen'}:raise RuntimeError('reuse pure control refused '+event)
if __name__=='__main__':sys.addaudithook(audit);unittest.main()
