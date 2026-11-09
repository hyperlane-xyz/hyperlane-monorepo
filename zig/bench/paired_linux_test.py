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
def ordinary_native_http_workflow(text):
 # Exact inverse of the once-only Source Tron admission command before clock controls.
 admission = '          python3 -B -W error zig/integration/multivm_tron_admission_test.py -v\n'
 clock = '          python3 -I -B -W error zig/integration/multivm_tron_clock_test.py -v\n'
 if text.count(admission) != 1 or text.count(admission + clock) != 1: raise AssertionError('Exact once-only Tron admission before clock required')
 text = text.replace(admission, '', 1)
 # Exact inverse of the independently reviewed EVM consumer-control additions.
 evm_after = '      - name: Run three independent EVM dependency controls after owned case cleanup\n        id: evm_controls\n        if: ${{ success() && steps.request.outputs.enabled == \'true\' && steps.request.outputs.scenario == \'evm\' }}\n        timeout-minutes: 15\n        env:\n          GH_TOKEN: ${{ github.token }}\n        shell: bash\n        run: |\n          set -euo pipefail\n          sudo apt-get update\n          sudo apt-get install -y --no-install-recommends build-essential\n          exec env -i PATH=/usr/local/bin:/usr/bin:/bin LC_ALL=C.UTF-8 GITHUB_ACTIONS=true GH_TOKEN="$GH_TOKEN" \\\n            python3 -I -B zig/bench/native_case_tools.py evm-controls --execute \\\n            --repo "$GITHUB_WORKSPACE" --execution-source-commit "$GITHUB_SHA" \\\n            --case-root "/tmp/znc-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" \\\n            --composition-result "$RUNNER_TEMP/native-case-composition-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT/result.json" \\\n            --tools "$RUNNER_TEMP/native-case-selection/preinstalled-tools.json" \\\n            --gh "$(readlink -f "$(command -v gh)")" \\\n            --output "$RUNNER_TEMP/evm-consumer-controls-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"\n'
 evm_before = ''
 if text.count(evm_after) != 1: raise AssertionError('Exact once-only EVM post-case component step required')
 text = text.replace(evm_after, evm_before, 1)
 evm_after = "      - name: Retain only the closed independent EVM control result\n        if: ${{ always() && steps.request.outputs.enabled == 'true' && steps.request.outputs.scenario == 'evm' }}\n        uses: actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f\n        with:\n          name: native-evm-consumer-controls-${{ github.run_id }}-${{ github.run_attempt }}\n          if-no-files-found: warn\n          retention-days: 14\n          path: ${{ runner.temp }}/evm-consumer-controls-${{ github.run_id }}-${{ github.run_attempt }}/public/result.json\n"
 evm_before = ''
 if text.count(evm_after) != 1: raise AssertionError('Exact once-only EVM closed component artifact required')
 text = text.replace(evm_after, evm_before, 1)
 evm_after = "with Path(os.environ['GITHUB_OUTPUT']).open('a') as output:output.write('enabled='+str(enabled).lower()+'\\n');output.write('sha256='+module.pin(path)['sha256']+'\\n');output.write('scenario='+(request['scenario'] if enabled else '')+'\\n')"
 evm_before = "with Path(os.environ['GITHUB_OUTPUT']).open('a') as output:output.write('enabled='+str(enabled).lower()+'\\n');output.write('sha256='+module.pin(path)['sha256']+'\\n')"
 if text.count(evm_after) != 1: raise AssertionError('Exact once-only EVM validated scenario metadata required')
 text = text.replace(evm_after, evm_before, 1)
 # Exact inverse of the isolated diagnostic's three native-http-only hunks.
 only = "(github.event_name == 'push' && github.ref == 'refs/heads/feat/zig-agent-rewrite' && contains(github.event.head_commit.message, '[zig-native-http-diagnostic-only]') && contains(github.event.head_commit.message, '[zig-paired-linux]') && !contains(github.event.head_commit.message, '[zig-native-case]') && !contains(github.event.head_commit.message, '[zig-svm-prerequisites-only]'))"
 prefix = '    if: ${{ ' + only + ' || ('
 rows = text.splitlines(True)
 matches = [i for i, line in enumerate(rows) if line.startswith(prefix)]
 if len(matches) != 1: raise AssertionError('Exact native HTTP diagnostic-only branch required')
 index = matches[0];line = rows[index]
 if not line.endswith(') }}\n'): raise AssertionError('Exact diagnostic-only branch suffix required')
 rows[index] = '    if: ${{ ' + line[len(prefix):-len(') }}\n')] + ' }}\n'
 text = ''.join(rows)
 guard = '        if: ${{ !' + only + ' }}\n'
 if text.count(guard) != 1: raise AssertionError('Exact diagnostic-only suite guard required')
 text = text.replace(guard, '', 1)
 before = "contains(github.event.head_commit.message, '[zig-native-http-diagnostic]')"
 after = "(contains(github.event.head_commit.message, '[zig-native-http-diagnostic]') || (github.event_name == 'push' && github.ref == 'refs/heads/feat/zig-agent-rewrite' && contains(github.event.head_commit.message, '[zig-native-http-diagnostic-only]') && contains(github.event.head_commit.message, '[zig-paired-linux]') && !contains(github.event.head_commit.message, '[zig-native-case]') && !contains(github.event.head_commit.message, '[zig-svm-prerequisites-only]')))"
 if text.count(after) != 1: raise AssertionError('Exact diagnostic marker extension required')
 text = text.replace(after, before, 1)
 full_timeout = "        timeout-minutes: ${{ ((github.event_name == 'push' && github.ref == 'refs/heads/feat/zig-agent-rewrite' && contains(github.event.head_commit.message, '[zig-native-http-diagnostic-only]') && contains(github.event.head_commit.message, '[zig-paired-linux]') && !contains(github.event.head_commit.message, '[zig-native-case]') && !contains(github.event.head_commit.message, '[zig-svm-prerequisites-only]')) && contains(github.event.head_commit.message, '[zig-native-http-full-suite]')) && 23 || 7 }}\n"
 if text.count(full_timeout) != 1: raise AssertionError('Exact full-suite timeout branch required')
 return text.replace(full_timeout, '        timeout-minutes: 7\n', 1)

class Controls(unittest.TestCase):
 def test_worker_environment_uses_actual_native_consumer_key(self):
  source=(ROOT/'zig/src/aleo/worker.zig').read_text()
  self.assertIn('getEnvVarOwned(a, "'+p.ENV['worker']+'")',source)
  self.assertEqual(p.env_for({'artifacts':{'zig':{'ReleaseSafe':{'worker':{'path':'bin/worker'},**{n:{'path':'lib/'+n}for n in p.ENV if n!='worker'}}}}},self.root,'ReleaseSafe')['HYPERLANE_ALEO_VM_WORKER'],str(self.root/'bin/worker'))
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name).resolve();self.repo=self.root/'repo';self.repo.mkdir()
 def inert_request(self):
  # Explicit control fixture, independent of the live request approval state.
  return {'schema':1,'kind':'paired-linux-ci-v1','root_approved':False,'inputs_enabled':False,'functional_enabled':False,'runtime_enabled':False,'producer_source_commit':'b'*40,'baseline_source_commit':p.BASELINE,'baseline_profile':'locked-c520224-production-three-agent-linux-v1','qualified_cohort':None,'transport_requests':{mode:None for mode in p.MODES},'required_source':None,'prepared_inputs':None,'accepted_six':None,'runtime_authority':None}
 def test_false_gate_has_no_source_import_or_artifact_access(self):
  path=self.root/'request.json';path.write_text(json.dumps(self.inert_request()))
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
  cohort_path=self.repo/'qualified.json';cohort_path.write_text(json.dumps(cohort));value=self.inert_request();value.update(root_approved=True,inputs_enabled=True,functional_enabled=True,producer_source_commit=producer,required_source=[{**p.pin(self.repo/name),'path':name}for name in sorted(p.SOURCE_PATHS)],qualified_cohort={**p.pin(cohort_path),'path':'qualified.json'})
  for mode in p.MODES:
   raw=json.loads((ROOT/f'zig/tools/aleo_linux_case/transport-{mode}.PENDING.json').read_text());raw['root_approved']=True;raw['producer_source_commit']=producer;raw['artifact_pins']['tools']['name']='zig-native-case-tools-'+producer;path=self.repo/(mode+'.json');path.write_text(json.dumps(raw));value['transport_requests'][mode]={**p.pin(path),'path':path.name}
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
  base=self.inert_request()
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
  cls.text=(HERE.parents[1]/'.github/workflows/zig-agents.yml').read_text();tree=ast.parse((HERE.parents[1]/'zig/tools/aleo_linux/kernel_only_test.py').read_text());ns={'re':re,'N':N};exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='conditions'],type_ignores=[]),'actual-condition-reader','exec'),ns);cls.rows=ns['conditions'](cls.text);cls.ordinary_rows=ns['conditions'](ordinary_native_http_workflow(cls.text))
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
  text=ordinary_native_http_workflow(self.text).split('  # BEGIN REVIEWED PAIRED LINUX JOBS',1)[0].rstrip()+'\n';text=text.replace(block,'',1);prefix='    if: ${{ !'+pd+' && (';lines=[];count=0
  for line in text.splitlines(True):
   if line.startswith(prefix):line='    if: ${{ '+line[len(prefix):-5]+' }}\n';count+=1
   lines.append(line)
  self.assertEqual(count,15);return ''.join(lines)
 def test_actual18jobs_exact_old15_byte_inverse(self):
  self.assertEqual(len(self.rows),18);self.assertEqual(hashlib.sha256(self.legacy().encode()).hexdigest(),'3d14d7c59bf11e9b791d75bc0abbf179'+'7b4705290ed0340dd62d6d7b23a94f72')
 def test_six_foundry_callers_use_fixed_verified_recipe_and_preserve_existing_gates(self):
  names=['native-linux','evm','native-case-producer-inputs','paired-linux-inputs','paired-linux-functional','paired-linux-runtime'];seen=[]
  for name in names:
   body=re.split(r'\n  [a-z][a-z0-9-]*:\n',self.text.split('\n  '+name+':',1)[1],maxsplit=1)[0]
   block=body.split('      - name: Install verified official Foundry v1.5.0\n',1)[1].split('      - ',1)[0];seen.append(block)
   for command in ['python3 -I -B -W error zig/tools/foundry_official_test.py -v','python3 -I -B zig/tools/foundry_official.py','--runner-temp "$RUNNER_TEMP"','--gh "$(readlink -f "$(command -v gh)")"','echo "$RUNNER_TEMP/ziggy-foundry-v1.5.0/bin" >> "$GITHUB_PATH"']:self.assertIn(command,block)
  self.assertEqual(sum('        if: 'in b for b in seen),3);self.assertNotIn('foundry-rs/foundry-toolchain@',self.text)
  required={'zig/tools/foundry_official.py','zig/tools/foundry_official_test.py','zig/tools/foundry_public_good_root.json'};self.assertTrue(required<=p.SOURCE_PATHS);self.assertEqual(len(p.SOURCE_PATHS),37)
  aleo=self.text.split('\n  aleo-full-case:',1)[1].split('\n  # BEGIN REVIEWED PAIRED LINUX JOBS',1)[0];self.assertNotIn('foundry_official',aleo)
 def test_foundry_token_is_only_six_steps_and_existing_job_permissions_unchanged(self):
  names=['native-linux','evm','native-case-producer-inputs','paired-linux-inputs','paired-linux-functional','paired-linux-runtime'];self.assertEqual(self.text.count('FOUNDRY_GITHUB_TOKEN: ${{ github.token }}'),6)
  for name in names:
   body=re.split(r'\n  [a-z][a-z0-9-]*:\n',self.text.split('\n  '+name+':',1)[1],maxsplit=1)[0]
   step=body.split('      - name: Install verified official Foundry v1.5.0\n',1)[1].split('      - ',1)[0];self.assertIn('        env:\n          FOUNDRY_GITHUB_TOKEN: ${{ github.token }}\n',step);self.assertEqual(body.count('FOUNDRY_GITHUB_TOKEN:'),1);self.assertIn('cat -- "$RUNNER_TEMP/ziggy-foundry-v1.5.0/result.json"',step);order=[step.index(c)for c in ['python3 -I -B zig/tools/foundry_official.py','cat --','echo "$RUNNER_TEMP/ziggy-foundry-v1.5.0/bin"']];self.assertEqual(order,sorted(order))
   permission=re.search(r'^    permissions:\n((?:      [^\n]+\n)+)',body,re.M)
   if name in {'native-linux','evm'}:self.assertIsNone(permission)
   else:self.assertIsNotNone(permission);self.assertEqual(dict(re.findall(r'^      ([a-z-]+): ([a-z]+)$',permission[1],re.M)),{'contents':'read','actions':'read'})
 def svm_wrapper(self):
  step=self.text.split('      - name: Provision then compile exact SVM prerequisites\n',1)[1].split('      - uses:',1)[0];source=step.split("<<'PY'\n",1)[1].rsplit('          PY\n',1)[0];return step,'\n'.join(line[10:]for line in source.splitlines())+'\n'
 def run_svm_wrapper(self,rustup='/runner/toolchain/rustup',executable=True,token=True):
  _,source=self.svm_wrapper();environment={'GITHUB_WORKSPACE':'/workspace/source','RUNNER_TEMP':'/runner/tmp','GITHUB_RUN_ID':'123','GITHUB_RUN_ATTEMPT':'4','PATH':'/foreign/bin','HOME':'/private/home','GH_TOKEN':'foreign-token','AWS_SECRET_ACCESS_KEY':'foreign-key'}
  if token:environment['SVM_GITHUB_TOKEN']='test-token-not-for-argv'
  calls=[];self.svm_wrapper_calls=calls;fake_os=N(environ=environment,X_OK=os.X_OK,access=lambda path,mode:executable,execve=lambda path,argv,env:calls.append((path,argv,env)));fake_shutil=N(which=lambda name:rustup if name=='rustup'else None)
  def importer(name,*args,**kwargs):return {'os':fake_os,'shutil':fake_shutil}[name]
  exec(compile(source,'actual-SVM-step-clean-exec','exec'),{'__builtins__':{'__import__':importer,'RuntimeError':RuntimeError}});return calls
 def test_svm_step_token_is_only_clean_exec_environment_never_argv(self):
  calls=self.run_svm_wrapper();self.assertEqual(len(calls),1);path,argv,environment=calls[0];self.assertEqual(path,'/usr/bin/python3');self.assertEqual(argv,['/usr/bin/python3','-I','-B','zig/tools/svm_prerequisites.py','--execute','--repo','/workspace/source','--output','/runner/tmp/svm-prerequisites-123-4','--rustup','/runner/toolchain/rustup','--bwrap','/usr/bin/bwrap']);self.assertEqual(environment,{'PATH':'/usr/bin:/bin','LC_ALL':'C.UTF-8','SVM_GITHUB_TOKEN':'test-token-not-for-argv'});self.assertNotIn('test-token-not-for-argv',argv);self.assertNotIn('foreign-token',repr(calls));self.assertNotIn('foreign-key',repr(calls))
 def test_svm_wrapper_missing_rustup_nonexec_or_missing_token_never_executes(self):
  for kwargs,error in [(dict(rustup=None),RuntimeError),(dict(executable=False),RuntimeError),(dict(token=False),KeyError)]:
   with self.subTest(kwargs=kwargs),self.assertRaises(error):self.run_svm_wrapper(**kwargs)
   self.assertEqual(self.svm_wrapper_calls,[])
 def test_svm_token_scope_keeps_original_isolation_and_step_budget(self):
  step,source=self.svm_wrapper();self.assertEqual(self.text.count('SVM_GITHUB_TOKEN: ${{ github.token }}'),1);self.assertIn('        env:\n          SVM_GITHUB_TOKEN: ${{ github.token }}\n',step);self.assertIn('timeout-minutes: 182',step);self.assertIn('exec /usr/bin/python3 -I -B -',step);self.assertNotIn('env -i',step);self.assertNotIn('SVM_GITHUB_TOKEN=',step);self.assertNotIn('print(',source);self.assertNotIn('open(',source)
 def test_old_routes_preserved_across_all_existing_contexts(self):
  old={k:v for k,v in self.ordinary_rows.items()if not k.startswith('paired-linux-')};pd="((github.event_name == 'push' && github.ref == 'refs/heads/feat/zig-agent-rewrite' && contains(github.event.head_commit.message, '[zig-paired-linux]')) || (github.event_name == 'workflow_dispatch' && inputs.paired_linux))";prefix='${{ !'+pd+' && (';old={k:'${{ '+v[len(prefix):-4]+' }}'for k,v in old.items()}
  count=0
  for event,ref,message,svm,cold,sdk,aleo in itertools.product(['push','pull_request','workflow_dispatch'],['refs/heads/main','refs/heads/feat/zig-agent-rewrite'],['ordinary','[zig-native-case]','[zig-svm-prerequisites-only]'],[False,True],[False,True],[False,True],[False,True]):
   kw=dict(event=event,ref=ref,message=message,svm=svm,cold=cold,sdk=sdk,aleo=aleo);self.assertEqual(self.evaluate(self.rows,**kw),self.evaluate(old,**kw));count+=1
  self.assertEqual(count,288)
 def test_explicit_marker_dispatch_phase_outputs_and_conflicts(self):
  for flags in [dict(message='[zig-paired-linux]'),dict(event='workflow_dispatch',paired=True)]:
   self.assertEqual(self.evaluate(self.rows,**flags),{'paired-linux-inputs'})
   self.assertEqual(self.evaluate(self.rows,functional=True,**flags),{'paired-linux-inputs','paired-linux-functional'})
   self.assertEqual(self.evaluate(self.rows,functional=True,runtime=True,**flags),{'paired-linux-inputs','paired-linux-functional'})
  self.assertEqual(self.evaluate(self.rows,message='[zig-native-case] [zig-paired-runtime]'),{'native-case-producer-inputs','paired-linux-runtime'})
  for key,marker in [('aleo','kernel'),('sdk','sdk'),('docker','docker'),('full','fullcase')]:
   self.assertEqual(self.evaluate(self.rows,event='workflow_dispatch',paired=True,**{key:True}),set());self.assertEqual(self.evaluate(self.rows,message='[zig-paired-linux] [zig-aleo-'+marker+'-only]'),set())
  for event,ref in [('pull_request','refs/heads/feat/zig-agent-rewrite'),('push','refs/heads/main')]:self.assertFalse(any(k.startswith('paired-linux-')for k in self.evaluate(self.rows,event=event,ref=ref,message='[zig-paired-linux]')))
 def test_only_new_input_job_uses_explicit_canonical_PG16(self):
  job=self.text.split('\n  paired-linux-inputs:',1)[1].split('\n  paired-linux-functional:',1)[0];self.assertIn('PAIRED_PG16_DIGEST_A: 43f9275df91e012c3da3d86bea5d7bb5',job);self.assertIn('PAIRED_PG16_DIGEST_B: e67a473296cc906c5f9e80b8176b1a37',job);self.assertIn('docker pull "postgres@sha256:${PAIRED_PG16_DIGEST_A}${PAIRED_PG16_DIGEST_B}"',job)
  self.assertIn('POSTGRES_DIGEST_A: 933463a6c8eba2b9f5cd414138738cd8',self.legacy());self.assertNotIn('PAIRED_PG16_DIGEST',self.legacy())
 def test_fixed_six_and_ten_matrices_limits_and_timing_refusal(self):
  functional=self.text.split('\n  paired-linux-functional:',1)[1].split('\n  paired-linux-runtime:',1)[0];runtime=self.text.split('\n  paired-linux-runtime:',1)[1]
  self.assertIn('index: [0, 1, 2, 3, 4, 5]',functional);self.assertIn('timeout-minutes: 180',functional);self.assertIn('timeout-minutes: 122',functional);self.assertIn('index: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]',runtime);self.assertIn('max-parallel: 2',runtime);self.assertIn('paired_linux_runtime_ci.py select',runtime);self.assertIn("if: steps.runtime.outputs.runtime_enabled == 'true'",runtime);self.assertIn('exec env -u GH_TOKEN python3 -I -B zig/bench/paired_linux_runtime_owner.py',runtime);self.assertIn('timeout-minutes: 306',runtime);self.assertNotIn('paired_linux_owner.py',runtime)

class AdmissionFailureDiagnostics(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.repo=Path(self.tmp.name).resolve();self.path=self.repo/'diagnostic.py'
 def failure(self,source,extra=None):
  self.path.write_text(source);namespace={'p':p,'reader':reader,**(extra or{})};exec(compile(source,str(self.path),'exec'),namespace)
  try:namespace['fail']()
  except BaseException as error:return error,{'required_source':[{**p.pin(self.path),'path':self.path.name}]}
  self.fail('expected controlled failure')
 def test_exact_policy_and_archive_guard_frames_use_checked_captured_Source(self):
  for call,guard in [('p.need','consumer CPU superset'),('reader.need','ZIP_SPECIAL_OR_LINK')]:
   error,authority=self.failure('def fail():\n '+call+'(False,"'+guard+'")\n');result=stage.failure_observation(error,self.repo,authority)
   self.assertEqual(result['Source_guard'],guard);self.assertEqual(result['error_type'],'Refused');self.assertEqual(result['status'],'observed');self.assertEqual(result['Source_frames'],[{'source':'diagnostic.py','sha256':p.pin(self.path)['sha256'],'line':2,'function':'fail'}])
 def test_foreign_and_changed_Source_never_grant_guard_or_frames(self):
  error,authority=self.failure('def fail():\n p.need(False,"consumer CPU superset")\n')
  self.assertEqual(stage.failure_observation(error,self.repo,{'required_source':[]})['Source_frames'],[])
  self.path.write_text('def fail():\n p.need(False,"consumer GPU superset")\n')
  result=stage.failure_observation(error,self.repo,authority);self.assertEqual(result['Source_frames'],[]);self.assertIsNone(result['Source_guard'])
 def test_guard_literal_must_be_on_actual_failing_Source_line(self):
  error,authority=self.failure('def fail():\n if False:p.need(False,"consumer CPU superset")\n raise p.Refused("consumer CPU superset")\n')
  result=stage.failure_observation(error,self.repo,authority);self.assertEqual(result['Source_frames'][0]['line'],3);self.assertIsNone(result['Source_guard'])
 def test_private_exception_payload_class_and_nested_values_never_export(self):
  sentinel='private-token-body-argv-environment-sentinel'
  for value in [sentinel,{'nested':sentinel}]:
   error,authority=self.failure('def fail():\n raise ValueError(payload)\n',{'payload':value});result=stage.failure_observation(error,self.repo,authority);self.assertIsNone(result['Source_guard']);self.assertNotIn(sentinel,json.dumps(result))
  private=type(sentinel,(RuntimeError,),{});error,authority=self.failure('def fail():\n raise Private(payload)\n',{'Private':private,'payload':sentinel});result=stage.failure_observation(error,self.repo,authority);self.assertEqual(result['error_type'],'OtherError');self.assertNotIn(sentinel,json.dumps(result))
 def test_capture_depth_frame_and_Source_byte_budgets_are_bounded(self):
  error,authority=self.failure('def recurse(n):\n if n:return recurse(n-1)\n p.need(False,"consumer CPU superset")\ndef fail():\n recurse(40)\n');result=stage.failure_observation(error,self.repo,authority);self.assertEqual(len(result['Source_frames']),16);self.assertIsNone(result['Source_guard'])
  authority['required_source'][0]['bytes']=2*1024**2+1
  with mock.patch.object(Path,'open',side_effect=AssertionError('oversized Source must not be read')):result=stage.failure_observation(error,self.repo,authority)
  self.assertEqual(result['Source_frames'],[]);self.assertIsNone(result['Source_guard'])
 def actual_boundary(self,primary=None,diagnostic=None):
  tree=ast.parse((HERE/'paired_linux_stage.py').read_bytes());fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='main');node=copy.deepcopy(next(n for n in fn.body if isinstance(n,ast.Try)))
  node.body=ast.parse('raise primary'if primary is not None else 'pass').body;code=compile(ast.fix_missing_locations(ast.Module(body=[node,copy.deepcopy(fn.body[-1])],type_ignores=[])),str(HERE/'paired_linux_stage.py'),'exec');events=[];saved=[]
  def write(path,value):events.append('write');saved.append(copy.deepcopy(value))
  error,authority=self.failure('def fail():\n p.need(False,"consumer CPU superset")\n')
  env={'policy':p,'args':N(repo=self.repo,output=self.repo/'out'),'authority':authority,'remote':None,'error':None,'observation':None,'receipt':None if primary is not None else {'schema':1,'passed':True},'primary':primary,'runner':N(summary=lambda:events.append('summary')or{'all_calls_actually_waited':True}),'restore_interrupts':lambda previous:events.append('restore'),'previous':{}}
  with mock.patch.object(p,'write',side_effect=write):
   env['failure_observation']=stage.failure_observation if diagnostic is None else diagnostic
   try:exec(code,env)
   except BaseException as raised:return env,saved,events,raised
  return env,saved,events,None
 def test_actual_except_finally_keeps_primary_failure_when_diagnostic_raises(self):
  primary=p.Refused('consumer CPU superset');env,saved,events,raised=self.actual_boundary(primary,lambda *args:(_ for _ in ()).throw(ValueError('private diagnostic failure')))
  self.assertIsInstance(raised,p.Refused);self.assertEqual(raised.args,('input consumer failed; closed receipt retained',));self.assertEqual(env['error'],'Refused');self.assertFalse(saved[0]['passed']);self.assertEqual(saved[0]['error_type'],'Refused');self.assertEqual(saved[0]['failure_observation'],{'status':'unavailable'});self.assertEqual(events,['summary','write','restore']);self.assertNotIn('private diagnostic failure',json.dumps(saved))
 def test_actual_except_publishes_only_closed_failure_observation(self):
  primary,authority=self.failure('def fail():\n p.need(False,"consumer CPU superset")\n');observed=stage.failure_observation(primary,self.repo,authority)
  env,saved,events,raised=self.actual_boundary(primary,lambda *args:observed)
  self.assertIsInstance(raised,p.Refused);self.assertEqual(saved[0]['failure_observation']['Source_guard'],'consumer CPU superset');self.assertEqual(events,['summary','write','restore']);self.assertFalse(saved[0]['native18_or_timing_acceptance'])
 def test_actual_success_boundary_never_calls_diagnostic_or_changes_receipt_shape(self):
  env,saved,events,raised=self.actual_boundary(diagnostic=lambda *args:(_ for _ in ()).throw(AssertionError('success invoked failure diagnostic')))
  self.assertIsNone(raised);self.assertEqual(saved,[{'schema':1,'passed':True,'actual_commands':{'all_calls_actually_waited':True}}]);self.assertEqual(events,['summary','write','restore'])

class ExternalToolMismatchDiagnostics(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name).resolve();self.tool=self.root/'PRIVATE_TOOL_PATH';self.tool.write_bytes(b'PRIVATE_FIRST');self.expected=p.pin(self.tool);self.repo=Path(p.__file__).resolve().parents[2];self.authority={'required_source':[{**p.pin(Path(p.__file__).resolve()),'path':'zig/bench/paired_linux.py'}]}
 def changed(self,name='pnpm'):
  self.tool.write_bytes(b'PRIVATE_OTHER')
  try:p.checked(self.expected,external_tool=name)
  except p.Refused as error:return error
  self.fail('actual changed tool passed')
 def test_actual_changed_tool_captures_single_checked_operands_without_path_or_body(self):
  error=self.changed();self.assertEqual(error.args,('input bytes changed',));expected={'name':'pnpm','expected':{k:self.expected[k]for k in ['bytes','sha256']},'actual':{k:p.pin(self.tool)[k]for k in ['bytes','sha256']}};self.assertEqual(error.external_tool_mismatch,expected)
  with mock.patch.object(p,'pin',side_effect=AssertionError('diagnostic must not reobserve tool')):value=stage.failure_observation(error,self.repo,self.authority)
  self.assertEqual(value['Source_guard'],'input bytes changed');self.assertEqual(value['external_tool_mismatch'],expected);self.assertNotIn('PRIVATE',json.dumps(value));self.assertNotIn(str(self.tool),json.dumps(value))
 def test_unchanged_tool_and_ordinary_group_mismatch_keep_original_behavior(self):
  self.assertEqual(p.checked(self.expected,external_tool='pnpm'),p.pin(self.tool));self.tool.write_bytes(b'PRIVATE_OTHER')
  for name in [None,'PRIVATE_UNKNOWN']:
   try:p.checked(self.expected,external_tool=name)
   except p.Refused as error:self.assertEqual(error.args,('input bytes changed',));self.assertFalse(hasattr(error,'external_tool_mismatch'))
   else:self.fail('mismatch healed')
 def test_unknown_nested_bool_overflow_or_unapproved_Source_never_publish(self):
  error=self.changed();valid=copy.deepcopy(error.external_tool_mismatch)
  bad=[dict(valid,name='PRIVATE_UNKNOWN'),dict(valid,actual={'bytes':True,'sha256':'a'*64}),dict(valid,actual={'bytes':2*stage.GIB+1,'sha256':'a'*64}),dict(valid,actual={'bytes':1,'sha256':{'PRIVATE':'data'}}),dict(valid,actual={'bytes':1,'sha256':'a'*64,'path':'PRIVATE'})]
  for row in bad:
   error.external_tool_mismatch=row;value=stage.failure_observation(error,self.repo,self.authority);self.assertNotIn('external_tool_mismatch',value);self.assertNotIn('PRIVATE',json.dumps(value))
  error.external_tool_mismatch=valid;self.assertNotIn('external_tool_mismatch',stage.failure_observation(error,self.repo,{'required_source':[]}))
 def test_exact_actual_external_tool_loop_supplies_name_without_new_pin_calls(self):
  tree=ast.parse(Path(p.__file__).read_bytes());fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='input_manifest');loop=next(n for n in fn.body if isinstance(n,ast.For)and isinstance(n.target,ast.Name)and n.target.id=='name'and isinstance(n.iter,ast.Name)and n.iter.id=='required_tools');calls=[n for n in ast.walk(loop)if isinstance(n,ast.Call)and isinstance(n.func,ast.Name)and n.func.id=='checked'];self.assertEqual(len(calls),1);self.assertEqual([(k.arg,ast.unparse(k.value))for k in calls[0].keywords],[('external_tool','name')])

class FixedPnpmClosure(unittest.TestCase):
 def test_two_existing_helpers_are_required_without_dropping_old_members(self):
  self.assertTrue({'zig/bench/native_tron_setup.py','zig/bench/native_tron_assets.py'}<=p.SOURCE_PATHS)
 def test_identical_native_file_passes_but_changed_launcher_is_not_waived(self):
  with tempfile.TemporaryDirectory()as directory:
   path=Path(directory).resolve()/'pnpm';elf=b'\x7fELF\x02\x01'+b'fixed-native-fixture';path.write_bytes(elf);row=p.pin(path);self.assertEqual(p.checked(row,external_tool='pnpm'),row);path.write_bytes(elf);self.assertEqual(p.checked(row,external_tool='pnpm'),row);path.write_bytes(b'#!/bin/sh\nexec different-local-path\n')
   with self.assertRaises(p.Refused)as caught:p.checked(row,external_tool='pnpm')
   self.assertEqual(caught.exception.args,('input bytes changed',));self.assertEqual(caught.exception.external_tool_mismatch['name'],'pnpm')
 def test_only_paired_jobs_replace_their_generated_manager_and_keep_gates(self):
  text=(HERE.parents[1]/'.github/workflows/zig-agents.yml').read_text()
  for name,gate in [('paired-linux-inputs',"steps.authority.outputs.inputs_enabled == 'true'"),('paired-linux-functional',None),('paired-linux-runtime',"steps.runtime.outputs.runtime_enabled == 'true'")]:
   body=re.split(r'\n  [a-z][a-z0-9-]*:\n',text.split('\n  '+name+':',1)[1],maxsplit=1)[0];self.assertNotIn('uses: pnpm/action-setup@',body);step=body.split('      - name: Stage exact official native pnpm12.3.0 outside all measurements\n',1)[1].split('      - ',1)[0];self.assertIn('timeout-minutes: 3',step)
   if gate:self.assertIn('        if: '+gate,step)
   else:self.assertIn('paired_linux.py select --request',step);self.assertIn('needs.paired-linux-inputs.outputs.request_sha256',step)


class EvmConsumerWorkflowInverseControls(unittest.TestCase):
 def current(self):return (HERE.parents[1]/'.github/workflows/zig-agents.yml').read_text()
 def hunks(self):
  fn=next(n for n in ast.parse(Path(__file__).read_text()).body if isinstance(n,ast.FunctionDef)and n.name=='ordinary_native_http_workflow')
  return [ast.literal_eval(n.value)for n in fn.body if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='evm_after'for t in n.targets)]
 def test_each_EVM_hunk_missing_duplicated_or_mutated_refuses_exact_inverse(self):
  text=self.current();ordinary_native_http_workflow(text);self.assertEqual(len(self.hunks()),3)
  for index,hunk in enumerate(self.hunks()):
   for changed in [text.replace(hunk,'',1),text+hunk,text.replace(hunk,hunk+'UNREVIEWED',1)if hunk.endswith('\n')else text.replace(hunk,hunk.replace('scenario=','scenario_UNREVIEWED='),1)]:
    # A changed line may keep the old hunk as a strict prefix; exercise a real
    # content change as well, never count unrelated trailing text as accepted.
    if hunk in changed and changed.count(hunk)==1:
     changed=text.replace(hunk,hunk.replace(hunk[0],'X',1),1)
    with self.subTest(hunk=index),self.assertRaises(AssertionError):ordinary_native_http_workflow(changed)
 def test_EVM_source_predicate_clocks_artifact_and_shared_helpers_are_exact(self):
  text=self.current();other=HERE.parents[1]/'zig/tools/aleo_linux_case/ci_fullcase_test.py'
  function=lambda p:next(n for n in ast.parse(p.read_text()).body if isinstance(n,ast.FunctionDef)and n.name=='ordinary_native_http_workflow')
  self.assertEqual(ast.dump(function(Path(__file__))),ast.dump(function(other)))
  case=text.split('  native-case-producer-inputs:\n',1)[1].split('\n  aleo-linux-sdk-prerequisite:',1)[0]
  self.assertIn('    timeout-minutes: 190\n',case);self.assertIn('        timeout-minutes: 142\n',case)
  start=case.index('      - name: Run three independent EVM dependency controls');end=case.index('      - name: Retain only the closed independent EVM control result',start);step=case[start:end]
  self.assertLess(case.index('Hydrate, stage prerequisites'),start);self.assertIn('        timeout-minutes: 15\n',step)
  condition=next(line.strip()[len('if: ${{ '):-len(' }}')]for line in step.splitlines()if line.strip().startswith('if: ${{ '));code=condition.replace('&&',' and ')
  for success in [False,True]:
   for enabled in ['false','true']:
    for scenario in ['evm','radix','']:
     actual=eval(code,{'__builtins__':{}},{'success':lambda:success,'steps':N(request=N(outputs=N(enabled=enabled,scenario=scenario)))})
     self.assertEqual(actual,success and enabled=='true'and scenario=='evm')
  artifact=case[end:case.index('      - uses: actions/upload-artifact@',end)]
  path=next(line.strip()[len('path: '):]for line in artifact.splitlines()if line.strip().startswith('path: '))
  self.assertTrue(path.endswith('/public/result.json'));self.assertNotIn('*',path);self.assertNotIn('logs',path)
  self.assertIn('exec env -i ',step);self.assertIn('GH_TOKEN="$GH_TOKEN"',step);self.assertNotIn('printenv',step)

if __name__=='__main__':unittest.main()
