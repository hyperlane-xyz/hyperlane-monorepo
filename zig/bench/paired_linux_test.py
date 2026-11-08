"""Pure Source/schema/archive controls. No fixture main/native/process/network."""
from pathlib import Path
import ast,copy,hashlib,importlib.util,io,itertools,json,os,re,selectors,stat,struct,sys,tempfile,unittest,warnings,zipfile
from types import SimpleNamespace as N
from unittest import mock
HERE=Path(__file__).resolve().parent;sys.path.insert(0,str(HERE))
import paired_linux as p
import paired_linux_stage as stage
import paired_linux_proofs as proof
ROOT=Path(os.environ.get('PAIRED_CONTROL_REPO',str(HERE.parents[1]))).resolve()
def load(path,name):
 spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
reader=load(ROOT/'zig/bench/cohort_readback.py','paired_control_archive')
class Controls(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name).resolve();self.repo=self.root/'repo';self.repo.mkdir()
 def test_false_gate_has_no_source_import_or_artifact_access(self):
  path=self.root/'request.json';path.write_bytes((HERE/'paired_linux_request.json').read_bytes())
  with mock.patch.object(p,'checked',side_effect=AssertionError('artifact admission reached')),mock.patch.object(p,'load_source',side_effect=AssertionError('Source import reached')):
   value,row=p.request(path,p.pin(path)['sha256'],self.repo)
   self.assertFalse(value['root_approved']);self.assertFalse(any(value[k]for k in ['inputs_enabled','functional_enabled','runtime_enabled']))
 def approved(self,producer='b'*40):
  # Real canonical dispatcher Source and actual encoded transport/header shape;
  # only the Root-curated qualification and finite checkout file bytes are
  # controlled fixtures. No downloader, custody or executable runs here.
  for name in p.SOURCE_PATHS:
   target=self.repo/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes((ROOT/name).read_bytes()if name=='zig/bench/native_case_ci.py'else b'# controlled public Source\n')
  cohort=p.decode((ROOT/'zig/tools/aleo_linux_case/cohort-qualification.PENDING.json').read_bytes());cohort['source_commit']=producer;cohort['eight_artifacts']['tools']['name']='zig-native-case-tools-'+producer;cohort['eight_artifacts']['radix_reference']['name']='zig-native-radix-reference-'+producer
  cohort_path=self.repo/'qualified.json';cohort_path.write_text(json.dumps(cohort));value=json.loads((HERE/'paired_linux_request.json').read_text());value.update(root_approved=True,inputs_enabled=True,functional_enabled=True,producer_source_commit=producer,required_source=[{**p.pin(self.repo/name),'path':name}for name in sorted(p.SOURCE_PATHS)],qualified_cohort={**p.pin(cohort_path),'path':'qualified.json'})
  for mode in p.MODES:
   raw=json.loads((ROOT/f'zig/tools/aleo_linux_case/transport-{mode}.PENDING.json').read_text());raw['producer_source_commit']=producer;raw['artifact_pins']['tools']['name']='zig-native-case-tools-'+producer;path=self.repo/(mode+'.json');path.write_text(json.dumps(raw));value['transport_requests'][mode]={**p.pin(path),'path':path.name}
  path=self.repo/'request.json';path.write_text(json.dumps(value));return path,value
 def test_actual_approved_request_loads_four_argument_dispatcher_and_future_cohort(self):
  path,value=self.approved();result,row=p.request(path,p.pin(path)['sha256'],self.repo);self.assertTrue(result['root_approved']);self.assertTrue(result['functional_enabled']);self.assertEqual(result['producer_source_commit'],'b'*40);self.assertEqual(row,p.pin(path))
  module=sys.modules['paired_checked_dispatch'];self.assertEqual(Path(module.__file__),self.repo/'zig/bench/native_case_ci.py');decoded=module.read_request(self.repo/'ReleaseSafe.json');self.assertIsInstance(decoded['postgres']['image_id'],str);module.validate_request(decoded)
 def test_approved_request_refuses_foreign_8_transport_Source_and_runtime_enable(self):
  path,value=self.approved()
  for mutate in [lambda v:v.update(producer_source_commit='c'*40),lambda v:v.update(runtime_enabled=True)]:
   changed=copy.deepcopy(value);mutate(changed);path.write_text(json.dumps(changed))
   with self.assertRaises(p.Refused):p.request(path,p.pin(path)['sha256'],self.repo)
  path.write_text(json.dumps(value));(self.repo/'ReleaseSafe.json').write_text('{}')
  with self.assertRaises(p.Refused):p.request(path,p.pin(path)['sha256'],self.repo)
 def test_all_internal_checked_loader_calls_match_real_function_arity(self):
  for name in ['paired_linux.py','paired_linux_owner.py','paired_linux_stage.py']:
   tree=ast.parse((HERE/name).read_text())
   for node in ast.walk(tree):
    if isinstance(node,ast.Call)and ((isinstance(node.func,ast.Name)and node.func.id=='load_source')or(isinstance(node.func,ast.Attribute)and node.func.attr=='load_source')):self.assertEqual(len(node.args),4,(name,node.lineno));self.assertFalse(node.keywords)
 def test_all_resolvable_internal_calls_bind_actual_current_signatures(self):
  modules={name:ast.parse((HERE/(name+'.py')).read_text())for name in ['paired_linux','paired_linux_owner','paired_linux_stage','paired_linux_proofs']};functions={name:{n.name:n for n in tree.body if isinstance(n,ast.FunctionDef)}for name,tree in modules.items()};aliases={'p':'paired_linux','policy':'paired_linux','stage':'paired_linux_stage','proof':'paired_linux_proofs'}
  for name,tree in modules.items():
   for node in ast.walk(tree):
    if not isinstance(node,ast.Call):continue
    fn=functions[name].get(node.func.id)if isinstance(node.func,ast.Name)else functions.get(aliases.get(node.func.value.id,''),{}).get(node.func.attr)if isinstance(node.func,ast.Attribute)and isinstance(node.func.value,ast.Name)else None
    if fn is None or any(isinstance(v,ast.Starred)for v in node.args)or any(k.arg is None for k in node.keywords):continue
    names=[v.arg for v in [*fn.args.posonlyargs,*fn.args.args]];required=set(names[:len(names)-len(fn.args.defaults)]);positional=set(names[:len(node.args)]);keywords={k.arg for k in node.keywords};where=(name,node.lineno,fn.name)
    if fn.args.vararg is None:self.assertLessEqual(len(node.args),len(names),where)
    self.assertFalse(positional&keywords,where);self.assertTrue(required<=positional|keywords,where)
    if fn.args.kwarg is None:self.assertTrue(keywords<=set(names)|{v.arg for v in fn.args.kwonlyargs},where)
 def test_false_policy_cannot_authorize_work_and_unknown_fields_refuse(self):
  base=json.loads((HERE/'paired_linux_request.json').read_text())
  for key,value in [('root_approved',1),('inputs_enabled',True),('functional_enabled',True),('runtime_enabled',True),('unknown',None)]:
   v={**base,key:value};path=self.root/'request.json';path.write_text(json.dumps(v))
   with self.subTest(key=key),self.assertRaises(p.Refused):p.request(path,p.pin(path)['sha256'],self.repo)
 def test_strict_json_duplicate_nonfinite_and_nested_refuse(self):
  for raw in [b'{"x":1,"x":2}',b'{"x":NaN}',b'{"x":1e999}',b'['*34+b'0'+b']'*34]:
   with self.subTest(raw=raw[:30]),self.assertRaises(p.Refused):p.decode(raw)
  self.assertEqual(p.decode(b'{"sha256_hex_chunks":["'+b'a'*32+b'","'+b'b'*32+b'"]}'),'a'*32+'b'*32)
 def test_relative_names_refuse_source_escape_and_noncanonical(self):
  for name in ['../x','/x','a//x','a/../x','a\\x','a\0x','a\nx','a\rx','./x']:
   with self.subTest(name=name),self.assertRaises(p.Refused):p.relative(name)
 def test_source_loader_executes_captured_checked_bytes_and_refuses_mutation(self):
  path=self.repo/'module.py';path.write_text('value=7\n');r=p.pin(path);authority={'required_source':[{**r,'path':'module.py'}]}
  self.assertEqual(p.load_source(path,'paired_control_checked',authority,self.repo).value,7)
  path.write_text('value=8\n')
  with self.assertRaises(p.Refused):p.load_source(path,'paired_control_changed',authority,self.repo)
 def test_six_commands_use_exact_mode_roles_full_manifest_and_original_proof_kind(self):
  value={'producer_source_commit':'b'*40,'artifacts':{'zig':{m:{n:{'path':m+'/'+n,'sha256':str(i)*64}for i,n in enumerate(sorted(p.ZIG))}for m in p.MODES},'tools':{n:{'path':'tools/bin/'+n}for n in p.TOOLS},'tool_manifest':{'path':'tools/manifest.json','sha256':'c'*64}}}
  for index in range(6):
   mode=p.MODES[index//3];kind=p.KINDS[index%3];cmd=p.functional_command(value,self.root,self.repo,index,self.root/'out.json')
   self.assertEqual(cmd[3],str(self.repo/'zig/integration'/(kind+'.py')));self.assertEqual(cmd[cmd.index('--binary')+1],str(self.root/mode/'relayer'))
   self.assertEqual(cmd[-6:],['--tool-manifest',str(self.root/'tools/manifest.json'),'--tool-manifest-sha256','c'*64,'--tool-source-commit','b'*40]);self.assertEqual('--reference'in cmd,kind=='relayer_stream');self.assertEqual('--validator-binary'in cmd,kind!='public_relay_process')
  for index in [-1,6,True]:
   with self.assertRaises(p.Refused):p.functional_command(value,self.root,self.repo,index,self.root/'out')
 def remote(self):
  run={'id':42,'run_attempt':1,'head_sha':'b'*40,'repository':{'full_name':stage.REPO},'head_repository':{'full_name':stage.REPO},'event':'push','path':'.github/workflows/zig-agents.yml'}
  jobs=[{'name':'paired-linux-inputs','id':7,'run_id':42,'status':'completed','conclusion':'success'}];artifacts=[{'id':8,'name':'paired-linux-inputs-42-1','expired':False,'size_in_bytes':100,'digest':'sha256:'+'c'*64,'workflow_run':{'id':42,'head_sha':'b'*40}}]
  return run,jobs,artifacts
 def test_actual_completed_input_publisher_bound_to_all_identities(self):
  run,jobs,artifacts=self.remote();row=stage.identity(run,jobs,artifacts,42,1,'b'*40,'paired-linux-inputs-42-1');self.assertEqual(row['job_id'],7)
  variants=[(dict(run,head_sha='d'*40),jobs,artifacts),(dict(run,run_attempt=2),jobs,artifacts),(run,jobs*2,artifacts),(run,[dict(jobs[0],conclusion='failure')],artifacts),(run,jobs,artifacts*2),(run,jobs,[dict(artifacts[0],expired=True)]),(run,jobs,[dict(artifacts[0],workflow_run={'id':43,'head_sha':'b'*40})])]
  for args in variants:
   with self.subTest(args=args),self.assertRaises(p.Refused):stage.identity(*args,42,1,'b'*40,'paired-linux-inputs-42-1')
 def archive(self,rows):
  path=self.root/'archive.zip'
  with zipfile.ZipFile(path,'w')as z:
   for name,body,mode in rows:
    i=zipfile.ZipInfo(name);i.external_attr=mode<<16
    with warnings.catch_warnings():warnings.simplefilter('ignore',UserWarning);z.writestr(i,body)
  return path
 def test_real_zip_regular_extraction_is_data_mode_and_exact_digest(self):
  path=self.archive([('tools/bin/oracle',b'public fixture',stat.S_IFREG|0o755)]);a=reader.Archive(path,lambda count=0:None)
  try:rows=stage.extract(a,self.root/'out');self.assertEqual(rows[0]['sha256'],hashlib.sha256(b'public fixture').hexdigest());self.assertEqual((self.root/'out/tools/bin/oracle').stat().st_mode&0o777,0o600)
  finally:a.close()
 def test_malformed_zip_refuses_before_destination_creation(self):
  for rows in [[('../escape',b'x',stat.S_IFREG)],[('link',b'outside',stat.S_IFLNK|0o777)],[('p',b'x',stat.S_IFREG),('p/c',b'x',stat.S_IFREG)],[('x',b'x',stat.S_IFREG),('x',b'y',stat.S_IFREG)]]:
   with self.subTest(rows=rows),self.assertRaises(reader.Refused):reader.Archive(self.archive(rows),lambda count=0:None)
   self.assertFalse((self.root/'out').exists())
 def test_fixture_data_cannot_overwrite_source_and_existing_mismatch_refuses(self):
  source=self.root/'published';source.mkdir();f=source/'data';f.write_bytes(b'data');r={**p.pin(f),'path':'data'};valid={'repository_fixture_files':[{'repository_path':'zig/integration/.cache/contracts.json','file':r}]}
  self.assertEqual(stage.materialize(valid,source,self.repo)[0]['sha256'],r['sha256']);target=self.repo/'zig/integration/.cache/contracts.json';target.write_bytes(b'foreign')
  with self.assertRaises(p.Refused):stage.materialize(valid,source,self.repo)
  for name in ['zig/src/agents/main.zig','zig/integration/evm.py','../foreign']:
   v={'repository_fixture_files':[{'repository_path':name,'file':r}]}
   with self.assertRaises(p.Refused):stage.materialize(v,source,self.repo)
 def test_stage_clock_caps_and_no_native_execution(self):
  self.assertEqual(stage.LIMITS['wall_seconds'],1800);self.assertEqual(stage.LIMITS['host_free_bytes'],6*1024**3);self.assertEqual(stage.LIMITS['inspector_RAM_bytes'],1024**3)
  tree=ast.parse((HERE/'paired_linux_stage.py').read_text());self.assertFalse(any(isinstance(n,ast.Attribute)and n.attr in {'Popen','CDLL','dlopen'}for n in ast.walk(tree)))
 def test_consumer_cancellation_uses_actual_Runner_independent_kill_wait(self):
  self.assertTrue(issubclass(stage.TaskInterrupted,RuntimeError));self.assertFalse(issubclass(stage.TaskInterrupted,InterruptedError))
  guard=N(deadline=10,cleanup_deadline=20,clock=lambda:0)
  with mock.patch.object(stage.signal,'getitimer',return_value=(0.0,0.0)),mock.patch.object(stage.signal,'signal')as signals,mock.patch.object(stage.signal,'setitimer')as timer:
   previous=stage.arm_interrupts(guard);self.assertEqual(timer.call_args.args,(stage.signal.ITIMER_REAL,10));self.assertEqual(len(previous),4)
   work=self.root/'runner';work.mkdir();runner=reader.Runner.__new__(reader.Runner)
   runner.root=work;runner.repo=self.repo;runner.gh=Path('/fixture/gh');runner.token='private-control-token';runner.guard=N(deadline=10,cleanup_deadline=20,clock=lambda:0);runner.guard=mock.Mock(wraps=lambda count=0:None);runner.guard.deadline=10;runner.guard.cleanup_deadline=20;runner.guard.clock=lambda:0
   runner.count=runner.waited=runner.failed=0;runner.wait_hash=hashlib.sha256();runner.last_failed_command=None;runner.last_command_diagnostic=None;runner.gh_startup=None
   child=mock.Mock(pid=123);child.wait.return_value=-9
   count=[0]
   def exit_probe(*ignored):
    count[0]+=1
    if count[0]==1:stage.interrupted(stage.signal.SIGTERM,None)
    return None
   with mock.patch.object(reader.subprocess,'Popen',return_value=child),mock.patch.object(reader.os,'waitid',side_effect=exit_probe):
    with self.assertRaises(stage.TaskInterrupted):runner.call(['/fixture/gh','api','fixture'],'API_JSON',65536)
   child.kill.assert_called_once();child.wait.assert_called_once();self.assertEqual(runner.count,runner.waited);self.assertEqual(runner.failed,1);self.assertNotIn('private-control-token',json.dumps(runner.last_command_diagnostic));self.assertTrue(all(call.args[1]==stage.signal.SIG_IGN for call in signals.call_args_list[-4:]))
   with selectors.SelectSelector()as selected,mock.patch.object(selectors.SelectSelector,'_select',side_effect=lambda *ignored:stage.interrupted(stage.signal.SIGTERM,None)):
    with self.assertRaises(stage.TaskInterrupted):selected.select(0)
   stage.restore_interrupts(previous)
 def test_actual_WSS_TLS_Source_and_OpenSSL_resolution_are_required(self):
  stream=ast.parse((ROOT/'zig/integration/relayer_stream.py').read_text());self.assertTrue(any(isinstance(n,ast.Import)and any(a.name=='tls_fixture'for a in n.names)for n in stream.body));self.assertIn('zig/integration/tls_fixture.py',p.SOURCE_PATHS)
  tls=ast.parse((ROOT/'zig/integration/tls_fixture.py').read_text());calls=[n for n in ast.walk(tls)if isinstance(n,ast.Call)and isinstance(n.func,ast.Attribute)and n.func.attr=='run'];self.assertEqual(len(calls),1);self.assertEqual(ast.literal_eval(calls[0].args[0].elts[0]),'openssl')
  root=self.root/'input';root.mkdir();payload=root/'public-data';payload.write_bytes(b'public fixture');row={**p.pin(payload),'path':payload.name};flags=['fixture_cpu'];groups={'rust':{n:row for n in p.RUST},'zig':{m:{n:row for n in p.ZIG}for m in p.MODES},'tools':{n:row for n in p.TOOLS},'tool_manifest':row,'evm_oracle':row}
  # Distinct producer metadata is mocked explicitly. Execute the ACTUAL consumer
  # gate through its real required-tool checks; no ELF/main or SDK runs here.
  names={'anvil','cast','clang','cc','node','pnpm','git','ps','lsof','sh','openssl'};external=p.pin(payload);value={'schema':1,'kind':'paired-linux-inputs-v1','platform':'linux-x86_64','producer_source_commit':'b'*40,'baseline_source_commit':p.BASELINE,'passed':True,'source_unchanged':True,'all_actual_parent_waits':True,'owned_absent':True,'artifacts':groups,'files':[row],'required_cpu_flags':flags,'external':{'tools':{n:external for n in names},'libraries':{}},'repository_fixture_files':[]};manifest=root/'input-manifest.json';manifest.write_text(json.dumps(value));original=p.Path.read_text
  def text(path,*args,**kwargs):return 'flags : fixture_cpu\n'if str(path)=='/proc/cpuinfo'else original(path,*args,**kwargs)
  with mock.patch.object(p.Path,'read_text',text),mock.patch.object(__import__('shutil'),'which',return_value=str(payload)):
   self.assertTrue(p.input_manifest(manifest,root,self.repo,'b'*40)['passed']);del value['external']['tools']['openssl'];manifest.write_text(json.dumps(value))
   with self.assertRaisesRegex(p.Refused,'fixture executable closure'):p.input_manifest(manifest,root,self.repo,'b'*40)
 def test_method_matrix_original_schedule_and_pair_order(self):
  value=p.decode((HERE/'paired_linux_methods.json').read_bytes());rows=value['sequence'];self.assertEqual(len(rows),10)
  for i,row in enumerate(rows):
   self.assertEqual(row['index'],i);self.assertEqual(row['pairs'],5);self.assertEqual(row['pair_orders'],[['rust','zig'],['zig','rust'],['rust','zig'],['zig','rust'],['rust','zig']]);self.assertEqual(row['argv'][row['argv'].index('--samples')+1],'5');self.assertNotIn('/private/tmp/',json.dumps(row['argv']))
  self.assertEqual([r['role']for r in rows],['validator']*4+['scraper']*2+['relayer']*4)
 def settlement(self,count):
  return {'production_confirm_seconds':600,'bounded_grace_seconds':30,'expected_tracked_messages':count,'historical_offset_is_upper_bound_not_injected_counter':True,'historical_confirmed_offset':0,'operations_confirmed':count,'first_live_completion':{'confirmed':count,'monotonic':701},'first_proxy_inclusions':[{'id_chunks':[str(i)],'first_positive_receipt_or_delivered_monotonic_seconds':100}for i in range(count)]}
 def process(self):
  crash={'passed':True,'recovery_new_nonce_count':1,'restart_new_nonce_count':0,'settlement':self.settlement(1),'recovery_stop':{'exit':0},'replay_stop':{'exit':0}}
  return {'passed':True,'binaries':{'relayer_sha256_chunks':['a'*64]},'settlement':self.settlement(3),'max_batch_4':{'settlement':self.settlement(4),'actual_allocation':{'calls':4,'members':[1,2,3,4]},'stop':{'exit':0}},'preenqueue_crash':crash,'restart_nonce_unchanged':True,'gas_expenditure_recorded':True,'origin_progress_during_receipt_stall':True,**{k:{'exit':0}for k in ['validator_stop','first_stop','restart_stop','stalled_stop']},'fault_injection':{'self_test':{'positive_real_write_sigkill':True,'unrelated_path_negative_control':True,'write_modes':['write','pwrite','writev','pwrite64'],'path_negative_count':4}}}
 def test_actual_process_validator_rejects_599s_wrong_binary_bad_stop_batch_or_fault(self):
  value=self.process();self.assertEqual(set(proof.validate('relayer_process',value,'a'*64,ROOT)),{'three-ISM','batch4','WAL-recovery'})
  changes=[lambda v:v['settlement']['first_live_completion'].update(monotonic=699),lambda v:v['binaries'].update(relayer_sha256_chunks=['b'*64]),lambda v:v['first_stop'].update(exit=-9),lambda v:v['max_batch_4']['actual_allocation'].update(calls=3),lambda v:v['fault_injection']['self_test'].update(path_negative_count=3)]
  for mutate in changes:
   changed=copy.deepcopy(value);mutate(changed)
   with self.assertRaises(RuntimeError):proof.validate('relayer_process',changed,'a'*64,ROOT)
 def test_wss_validator_preserves_historical_provenance_and_exact_retirement(self):
  s=self.settlement(2);s['historical_confirmed_offset']=3;s['operations_confirmed']=5;s['first_live_completion']['confirmed']=5
  value={'passed':True,'executables':{'relayer_sha256_chunks':['a'*64]},'case':{'passed':True,'restart':{'existing_rust_rows_unchanged':True,'nonce_increase':2,'sigterm':{'exit':0},'settlement':s},'late_and_stalled_origin':{'sigterm':{'exit':0}}}}
  proof.validate('relayer_stream',value,'a'*64,ROOT);value['case']['restart']['nonce_increase']=3
  with self.assertRaises(RuntimeError):proof.validate('relayer_stream',value,'a'*64,ROOT)
 def test_owner_keeps_original_two_hour_four_gib_and_no_timing_acceptance(self):
  import paired_linux_owner as owner
  self.assertEqual(owner.PROFILES['functional'],{'wall_seconds':7200,'RSS_bytes':4*1024**3,'new_disk_bytes':512*1024**2,'free_bytes':6*1024**3})
  source=(HERE/'paired_linux_owner.py').read_text();self.assertIn("time.monotonic()<deadline and cleanup",source);self.assertIn('os.WNOWAIT',source)

class OwnerPublication(unittest.TestCase):
 setUp=Controls.setUp
 process=Controls.process
 settlement=Controls.settlement
 # Reuse only the DTO constructors, not inherited test collection below.
 def fixture(self):
  import paired_linux_owner as owner
  out=self.root/'owned';out.mkdir();inputs=self.root/'inputs';inputs.mkdir();request_file=self.root/'request';request_file.write_bytes(b'public fixture');rp=p.pin(request_file)
  (inputs/'input-manifest.json').write_text(json.dumps({'artifacts':{'zig':{'ReleaseSafe':{'relayer':{'sha256':'a'*64},'validator':{'sha256':'b'*64}}}}}))
  raw=self.process();proof_path=out/'proof.json';proof_path.write_text(json.dumps(raw));summary=proof.validate('relayer_process',raw,'a'*64,ROOT)
  for name,source in [('zig/bench/paired_linux_proofs.py',HERE/'paired_linux_proofs.py'),('zig/bench/relayer.py',ROOT/'zig/bench/relayer.py')]:
   target=self.repo/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(source.read_bytes())
  authority={'required_source':[{**p.pin(self.repo/name),'path':name}for name in ['zig/bench/paired_linux_proofs.py','zig/bench/relayer.py']]}
  value={'schema':1,'kind':'paired-linux-functional-result','platform':'linux-x86_64','passed':True,'index':0,'mode':'ReleaseSafe','proof_kind':'relayer_process','request':rp,'production_confirm_seconds':600,'bounded_grace_seconds':30,'native18_or_timing_acceptance':False,'input_manifest':p.pin(inputs/'input-manifest.json'),'proof':p.pin(proof_path),'actual_role_launches':[{'pid':123,'mode':'ReleaseSafe','binary_sha256':'a'*64}],'strict_cases':summary};p.write(out/'functional-result.json',value)
  return owner,N(output=out,repo=self.repo,inputs=inputs,index=0),authority,rp
 def test_actual_parent_requires_crossbound_worker_raw_proof_and_roles(self):
  owner,args,authority,request_pin=self.fixture();self.assertEqual(owner.completed_worker(args,authority,request_pin),p.pin(args.output/'functional-result.json'))
  path=args.output/'functional-result.json';original=path.read_bytes()
  for mutate in [lambda v:v.update(index=1),lambda v:v.update(actual_role_launches=[]),lambda v:v.update(native18_or_timing_acceptance=True),lambda v:v['request'].update(sha256='f'*64)]:
   v=json.loads(original);mutate(v);path.write_text(json.dumps(v))
   with self.assertRaises(p.Refused):owner.completed_worker(args,authority,request_pin)
  path.write_bytes(original);(args.output/'proof.json').write_text('{}')
  with self.assertRaises(p.Refused):owner.completed_worker(args,authority,request_pin)
 def test_actual_owner_late_zero_and_RSS_failure_still_clean_and_never_pass(self):
  import contextlib
  import paired_linux_owner as owner
  for case in ['late','rss']:
   args=N(phase='functional',request=self.root/'request',request_sha256='a'*64,repo=self.repo,inputs=self.root/'inputs',index=0,output=self.root/('outer-'+case));child=N(pid=123);custody=mock.Mock();custody.allocated.return_value=0;custody.processes.return_value={};custody.owned_processes.return_value={123:{'rss_bytes':4*1024**3+1 if case=='rss'else 1}};custody.stop_owned.return_value={'actual_parent_wait':True,'exit_code':0,'clean':True,'signals':[],'errors':[]}
   clock=iter([0,1,7201,7202,7203,7204])
   with contextlib.ExitStack()as stack:
    for target,name,replacement in [(owner.policy,'request',mock.Mock(return_value=({'root_approved':True,'functional_enabled':True},{'sha256':'a'*64}))),(owner.policy,'load_source',mock.Mock(return_value=custody)),(owner.sys,'platform','linux'),(owner.os,'pidfd_open',mock.Mock()),(owner.signal,'pidfd_send_signal',mock.Mock()),(owner.signal,'getsignal',mock.Mock(return_value=0)),(owner.signal,'signal',mock.Mock()),(owner.signal,'pthread_sigmask',mock.Mock(return_value=set())),(owner.shutil,'disk_usage',mock.Mock(return_value=N(free=7*1024**3))),(owner.subprocess,'Popen',mock.Mock(return_value=child)),(owner.os,'waitid',mock.Mock(return_value=N())),(owner.time,'monotonic',mock.Mock(side_effect=lambda:next(clock)))]:stack.enter_context(mock.patch.object(target,name,replacement,create=True))
    with self.assertRaises(p.Refused):owner.owner(args)
   custody.stop_owned.assert_called_once();row=json.loads((args.output/'owner-result.json').read_text());self.assertFalse(row['passed']);self.assertEqual(row['cleanup']['exit_code'],0);self.assertEqual(row['error_type'],'Refused');self.assertIsNone(row['worker_receipt']);self.assertEqual(row['minimum_host_free_bytes'],7*1024**3)
 def test_proof_parser_allows_large_actual_shape_but_retains_structure_bounds(self):
  # Current accepted historical process schema had353061 values; this generated
  # public-only DTO tests equivalent parser scale without borrowing any proof.
  raw=json.dumps({'observations':[0]*353061}).encode()
  with self.assertRaises(p.Refused):p.decode(raw)
  self.assertEqual(len(p.decode(raw,64*1024**2,2000000)['observations']),353061)
  with self.assertRaises(p.Refused):p.decode(raw,len(raw)-1,2000000)
 def test_fixture_parent_symlink_is_refused_before_foreign_directory_creation(self):
  source=self.root/'published';source.mkdir();f=source/'data';f.write_bytes(b'data');foreign=self.root/'foreign';foreign.mkdir();cache=self.repo/'zig/integration/.cache';cache.parent.mkdir(parents=True);cache.symlink_to(foreign,target_is_directory=True);row={**p.pin(f),'path':'data'}
  with self.assertRaises(p.Refused):stage.materialize({'repository_fixture_files':[{'repository_path':'zig/integration/.cache/new/file','file':row}]},source,self.repo)
  self.assertEqual(list(foreign.iterdir()),[])

class Workflow(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.text=(HERE.parents[1]/'.github/workflows/zig-agents.yml').read_text();tree=ast.parse((HERE.parents[1]/'zig/tools/aleo_linux/kernel_only_test.py').read_text());ns={'re':re,'N':N};exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='conditions'],type_ignores=[]),'actual-condition-reader','exec'),ns);cls.rows=ns['conditions'](cls.text)
 def evaluate(self,rows,event='push',ref='refs/heads/feat/zig-agent-rewrite',message='',paired=False,functional=False,runtime=False,**flags):
  scope={'github':N(event_name=event,ref=ref,event=N(head_commit=N(message=message))),'inputs':N(paired_linux=paired,svm_prerequisites=flags.get('svm',False),cold_full_feature=flags.get('cold',False),aleo_linux_prerequisite=flags.get('aleo',False),aleo_linux_sdk_prerequisite=flags.get('sdk',False),aleo_native_docker_prerequisite=flags.get('docker',False),aleo_full_case=flags.get('full',False)),'needs':N(paired_linux_inputs=N(outputs=N(functional_enabled=str(functional).lower(),runtime_enabled=str(runtime).lower()))),'contains':lambda text,needle:needle in text}
  selected=set()
  for name,value in rows.items():
   code=value.removeprefix('${{ ').removesuffix(' }}').replace('needs.paired-linux-inputs','needs.paired_linux_inputs');code=re.sub(r'!(?!=)',' not ',code).replace('&&',' and ').replace('||',' or ').strip()
   if eval(compile(code,'actual-job-if','eval'),{'__builtins__':{}},scope):selected.add(name)
  return selected
 def legacy(self):
  pd="((github.event_name == 'push' && github.ref == 'refs/heads/feat/zig-agent-rewrite' && contains(github.event.head_commit.message, '[zig-paired-linux]')) || (github.event_name == 'workflow_dispatch' && inputs.paired_linux))"
  block="      paired_linux:\n        description: Run reviewed Linux paired input/proof preparation; timings require separate final authority\n        type: boolean\n        default: false\n"
  text=self.text.split('  # BEGIN REVIEWED PAIRED LINUX JOBS',1)[0].rstrip()+'\n';text=text.replace(block,'',1);prefix='    if: ${{ !'+pd+' && (';lines=[];count=0
  for line in text.splitlines(True):
   if line.startswith(prefix):line='    if: ${{ '+line[len(prefix):-5]+' }}\n';count+=1
   lines.append(line)
  self.assertEqual(count,15);return ''.join(lines)
 def test_actual18jobs_exact_old15_byte_inverse(self):
  self.assertEqual(len(self.rows),18);self.assertEqual(hashlib.sha256(self.legacy().encode()).hexdigest(),'0b16d88b378d9073ad056e8e7e65087d'+'da795bb72007139f5c83f4000e079364')
 def test_old_routes_preserved_across_all_existing_contexts(self):
  old={k:v for k,v in self.rows.items()if not k.startswith('paired-linux-')};pd="((github.event_name == 'push' && github.ref == 'refs/heads/feat/zig-agent-rewrite' && contains(github.event.head_commit.message, '[zig-paired-linux]')) || (github.event_name == 'workflow_dispatch' && inputs.paired_linux))";prefix='${{ !'+pd+' && (';old={k:'${{ '+v[len(prefix):-4]+' }}'for k,v in old.items()}
  count=0
  for event,ref,message,svm,cold,sdk,aleo in itertools.product(['push','pull_request','workflow_dispatch'],['refs/heads/main','refs/heads/feat/zig-agent-rewrite'],['ordinary','[zig-native-case]','[zig-svm-prerequisites-only]'],[False,True],[False,True],[False,True],[False,True]):
   kw=dict(event=event,ref=ref,message=message,svm=svm,cold=cold,sdk=sdk,aleo=aleo);self.assertEqual(self.evaluate(self.rows,**kw),self.evaluate(old,**kw));count+=1
  self.assertEqual(count,288)
 def test_explicit_marker_dispatch_phase_outputs_and_conflicts(self):
  for flags in [dict(message='[zig-paired-linux]'),dict(event='workflow_dispatch',paired=True)]:
   self.assertEqual(self.evaluate(self.rows,**flags),{'paired-linux-inputs'})
   self.assertEqual(self.evaluate(self.rows,functional=True,**flags),{'paired-linux-inputs','paired-linux-functional'})
   self.assertEqual(self.evaluate(self.rows,functional=True,runtime=True,**flags),{'paired-linux-inputs','paired-linux-functional','paired-linux-runtime'})
  for key,marker in [('aleo','kernel'),('sdk','sdk'),('docker','docker'),('full','fullcase')]:
   self.assertEqual(self.evaluate(self.rows,event='workflow_dispatch',paired=True,**{key:True}),set());self.assertEqual(self.evaluate(self.rows,message='[zig-paired-linux] [zig-aleo-'+marker+'-only]'),set())
  for event,ref in [('pull_request','refs/heads/feat/zig-agent-rewrite'),('push','refs/heads/main')]:self.assertFalse(any(k.startswith('paired-linux-')for k in self.evaluate(self.rows,event=event,ref=ref,message='[zig-paired-linux]')))
 def test_only_new_input_job_uses_explicit_canonical_PG16(self):
  job=self.text.split('\n  paired-linux-inputs:',1)[1].split('\n  paired-linux-functional:',1)[0];self.assertIn('PAIRED_PG16_DIGEST_A: 43f9275df91e012c3da3d86bea5d7bb5',job);self.assertIn('PAIRED_PG16_DIGEST_B: e67a473296cc906c5f9e80b8176b1a37',job);self.assertIn('docker pull "postgres@sha256:${PAIRED_PG16_DIGEST_A}${PAIRED_PG16_DIGEST_B}"',job)
  self.assertIn('POSTGRES_DIGEST_A: 933463a6c8eba2b9f5cd414138738cd8',self.legacy());self.assertNotIn('PAIRED_PG16_DIGEST',self.legacy())
 def test_fixed_six_and_ten_matrices_limits_and_timing_refusal(self):
  functional=self.text.split('\n  paired-linux-functional:',1)[1].split('\n  paired-linux-runtime:',1)[0];runtime=self.text.split('\n  paired-linux-runtime:',1)[1]
  self.assertIn('index: [0, 1, 2, 3, 4, 5]',functional);self.assertIn('timeout-minutes: 180',functional);self.assertIn('timeout-minutes: 122',functional);self.assertIn('index: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]',runtime);self.assertIn('max-parallel: 2',runtime);self.assertIn('timing owner not activated',runtime);self.assertNotIn('paired_linux_owner.py',runtime)

if __name__=='__main__':unittest.main()
