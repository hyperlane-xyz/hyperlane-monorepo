"""Pure composition/route checks. No SDK/VM/process/network entry is invoked."""
import ast,copy,datetime,hashlib,importlib.util,itertools,json,pathlib,re,subprocess,tempfile,time,unittest
from types import SimpleNamespace as N
from unittest import mock
HERE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('actual_ci_fullcase',HERE/'ci_fullcase.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
REPO=HERE.parents[2]
FULL="((github.event_name == 'push' && github.ref == 'refs/heads/feat/zig-agent-rewrite' && contains(github.event.head_commit.message, '[zig-aleo-fullcase-only]')) || (github.event_name == 'workflow_dispatch' && inputs.aleo_full_case))"
INPUT="      aleo_full_case:\n        description: Run only reviewed dedicated Aleo Safe/Fast full cases (requires actual same-job prerequisites)\n        type: boolean\n        default: false\n"
# Exact current14-job inverse, including the reviewed fixed Radix startup-log upload.
# Further workflow-body changes still require explicit review and a new baseline.
BASE_SHA=('4cd870d5400e176162b90604d291e12a' '687ae7df934266f3ae7969e2c8173dac')
def evaluator():
 tree=ast.parse((REPO/'zig/tools/aleo_linux/kernel_only_test.py').read_text());ns={'re':re,'N':N}
 functions=[n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name in {'conditions','selected'}]
 exec(compile(ast.Module(body=functions,type_ignores=[]),'actual-shared-route-evaluator','exec'),ns);return ns
def ordinary_native_http_workflow(text):
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

class Routes(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.text=(REPO/'.github/workflows/zig-agents.yml').read_text();cls.ns=evaluator();cls.rows=cls.ns['conditions'](cls.text)
  cls.legacy_text=ordinary_native_http_workflow(cls.text).split('  # BEGIN REVIEWED PAIRED LINUX JOBS',1)[0].rstrip()+'\n';cls.legacy_text=cls.legacy_text.replace('      paired_linux:\n        description: Run reviewed Linux paired input/proof preparation; timings require separate final authority\n        type: boolean\n        default: false\n','',1)
  prefix='    if: ${{ !'+"((github.event_name == 'push' && github.ref == 'refs/heads/feat/zig-agent-rewrite' && contains(github.event.head_commit.message, '[zig-paired-linux]')) || (github.event_name == 'workflow_dispatch' && inputs.paired_linux))"+' && ('
  cls.legacy_text=''.join(('    if: ${{ '+line[len(prefix):-5]+' }}\n')if line.startswith(prefix)else line for line in cls.legacy_text.splitlines(True));cls.legacy_rows=cls.ns['conditions'](cls.legacy_text)
 def selected(self,**kw):return self.ns['selected'](self.rows,**kw)
 def test_exact15jobs_and_both_mode_serial_hardbounds(self):
  self.assertEqual(len(self.rows),18);self.assertEqual(len(self.legacy_rows),15);job=self.legacy_text.split('\n  aleo-full-case:',1)[1]
  for item in ['mode: [ReleaseSafe, ReleaseFast]','max-parallel: 1','timeout-minutes: 330','runs-on: depot-ubuntu-24.04-16','actions: read','persist-credentials: false']:self.assertIn(item,job)
 def test_all14_old_bodies_have_exact_inverse(self):
  old=self.legacy_text.split('\n  aleo-full-case:',1)[0];old=old.replace(INPUT,'',1)
  lines=[];count=0
  for line in old.splitlines(True):
   prefix='    if: ${{ !'+FULL+' && ('
   if line.startswith(prefix):
    self.assertTrue(line.endswith(') }}\n'));line='    if: ${{ '+line[len(prefix):-5]+' }}\n';count+=1
   lines.append(line)
  self.assertEqual(count,14);self.assertEqual(hashlib.sha256(''.join(lines).encode()).hexdigest(),BASE_SHA)
 def test_full_request_excludes_all14_with_old_svm_cold_case_markers(self):
  for extra in ['', ' [zig-native-case]', ' [zig-svm-prerequisites-only]',' [zig-native-case] [zig-svm-prerequisites-only]']:
   self.assertEqual(self.selected(message='[zig-aleo-fullcase-only]'+extra),{'aleo-full-case'})
  for svm,cold in itertools.product([False,True],repeat=2):self.assertEqual(self.selected(event='workflow_dispatch',full=True,svm=svm,cold=cold),{'aleo-full-case'})
 def test_conflicting_dedicated_authorities_all_skip(self):
  for sdk,kernel,docker in itertools.product([False,True],repeat=3):
   if sdk or kernel or docker:self.assertEqual(self.selected(event='workflow_dispatch',full=True,sdk=sdk,aleo=kernel,docker=docker),set())
  for marker in ['sdk','kernel','docker']:self.assertEqual(self.selected(message='[zig-aleo-fullcase-only] [zig-aleo-'+marker+'-only]'),set())
 def test_ordinary288_combinations_identical_to_original14(self):
  old={k:v[len('${{ !'+FULL+' && ('):-4]+' }}'for k,v in self.legacy_rows.items()if k!='aleo-full-case'}
  # v tail is ') }}'; reconstruct exact old expression, never drop arbitrary fields.
  old={k:'${{ '+v[len('${{ !'+FULL+' && ('):-4]+' }}'for k,v in self.legacy_rows.items()if k!='aleo-full-case'}
  count=0
  for event,ref,message,flags in itertools.product(['push','pull_request','workflow_dispatch'],['refs/heads/main','refs/heads/feat/zig-agent-rewrite'],['ordinary','[zig-native-case]','[zig-svm-prerequisites-only]'],itertools.product([False,True],repeat=4)):
   svm,cold,sdk,aleo=flags;kw=dict(event=event,ref=ref,message=message,svm=svm,cold=cold,sdk=sdk,aleo=aleo)
   self.assertEqual(self.selected(**kw),self.ns['selected'](old,**kw));count+=1
  self.assertEqual(count,288)
 def test_unrelated_branch_and_PR_full_marker_do_not_activate(self):
  for event,ref in [('pull_request','refs/heads/feat/zig-agent-rewrite'),('push','refs/heads/main')]:self.assertNotIn('aleo-full-case',self.selected(event=event,ref=ref,message='[zig-aleo-fullcase-only]'))
 def test_all_python_invocations_isolated_and_no_raw_fallback(self):
  job=self.legacy_text.split('\n  aleo-full-case:',1)[1]
  calls=[line for line in job.splitlines()if 'python3 'in line and 'apt-get'not in line]
  self.assertEqual(len(calls),4);self.assertTrue(all('python3 -I -B'in line for line in calls))
  self.assertNotIn('run-locally',job);self.assertNotIn('**',job);self.assertNotIn('workflow_dispatch:',job)
 def test_policy_cli_binds_absolute_checkout_path_for_select_and_execute(self):
  # Both actual CLI sites call pin(), which deliberately rejects relative paths.
  job=self.legacy_text.split('\n  aleo-full-case:',1)[1]
  assigned=re.findall(r'^\s+POLICY=(.+)$',job,re.MULTILINE)
  self.assertEqual(assigned,['"$GITHUB_WORKSPACE/zig/tools/aleo_linux_case/ci_policy.PENDING.json"']*2)
  self.assertIn('--select',job);self.assertIn('--execute',job)
class Policy(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=pathlib.Path(self.temp.name).resolve();self.value=json.loads((HERE/'ci_policy.PENDING.json').read_text())
  # Negative fixtures stay inert even when the real checked-in case policy is activated.
  self.value.update(root_approved=False,runtime_source_commit=None,requests={mode:None for mode in m.MODES},qualified_cohort=None,qualified_docker=None,required_source=None)
 def descriptor(self,value):
  p=self.root/'policy.json';p.write_text(json.dumps(value));return m.pin(p)
 def test_false_policy_is_inert_for_both_modes_before_any_effect(self):
  row=self.descriptor(self.value)
  for mode in m.MODES:
   with mock.patch.object(m,'job_observation',side_effect=AssertionError('API reached')),mock.patch.object(m.subprocess,'Popen',side_effect=AssertionError('child reached')):
    out=m.execute(row['path'],row['sha256'],mode,{'GITHUB_WORKSPACE':str(self.root)})
    self.assertEqual(out,{'enabled':False,'native_case_acceptance':False});self.assertEqual(sorted(p.name for p in self.root.iterdir()),['policy.json'])
 def test_lifecycle_and_authority_types_cannot_be_changed(self):
  for key,value in [('confirm_seconds',599),('restart_seconds',29),('proof_seconds',10799),('service_seconds',11161),('job_minutes',331),('root_approved',1)]:
   bad={**self.value,key:value};row=self.descriptor(bad)
   with self.subTest(key=key),self.assertRaises(ValueError):m.policy(row['path'],row['sha256'],'ReleaseSafe',self.root)
 def test_approved_missing_qualification_never_becomes_execution(self):
  self.value.update(root_approved=True,runtime_source_commit='a'*40);row=self.descriptor(self.value)
  with self.assertRaises(ValueError):m.policy(row['path'],row['sha256'],'ReleaseSafe',self.root)
 def test_duplicate_json_keys_reject(self):
  with self.assertRaisesRegex(ValueError,'duplicate'):m.decode('{"root_approved":false,"root_approved":true}')
 def test_fixed_child_environment_excludes_auth_proxy_fault_aliases(self):
  env={k:'fixture'for k in ['PATH','GITHUB_WORKSPACE','RUNNER_TEMP','GITHUB_SHA','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_REPOSITORY']};env.update(GH_TOKEN='private-marker',HTTPS_PROXY='private-marker',NODE_OPTIONS='private-marker',CONFIG_FILES='private-marker')
  out=m.fixed_environment(env);self.assertNotIn('private-marker',json.dumps(out));self.assertNotIn('HOME',out)
class ActivatedPolicyFixture(unittest.TestCase):
 def test_real_activation_cannot_turn_negative_policy_fixture_into_authority(self):
  active={**m.FIXED,'root_approved':True,'runtime_source_commit':'a'*40,'requests':{mode:{'path':'not-to-be-read.json','bytes':1,'sha256':'b'*64}for mode in m.MODES},'qualified_cohort':{'path':'not-to-be-read.json','bytes':1,'sha256':'b'*64},'qualified_docker':{'path':'not-to-be-read.json','bytes':1,'sha256':'b'*64},'required_source':[{'path':'not-to-be-read.json','bytes':1,'sha256':'b'*64}]}
  case=Policy('test_false_policy_is_inert_for_both_modes_before_any_effect')
  try:
   with mock.patch.object(pathlib.Path,'read_text',return_value=json.dumps(active)):case.setUp()
   self.assertIs(case.value['root_approved'],False)
   for key in ['runtime_source_commit','qualified_cohort','qualified_docker','required_source']:self.assertIsNone(case.value[key])
   self.assertEqual(case.value['requests'],{mode:None for mode in m.MODES})
   case.test_false_policy_is_inert_for_both_modes_before_any_effect()
  finally:case.doCleanups()

class PolicyPins(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=pathlib.Path(self.temp.name).resolve()
 def test_relative_policy_resolves_only_pinned_current_checkout_bytes(self):
  p=self.root/'public.json';p.write_text('{}');row=m.pin(p);relative={**row,'path':'public.json'}
  self.assertEqual(m.policy_pin(relative,self.root),row)
  chunked={**relative,'sha256':{'sha256_hex_chunks':[row['sha256'][:32],row['sha256'][32:]]}};self.assertEqual(m.policy_pin(chunked,self.root),row)
  with self.assertRaises(ValueError):m.policy_pin({**chunked,'sha256':{**chunked['sha256'],'unexpected':True}},self.root)
  p.write_text('changed')
  with self.assertRaises(ValueError):m.policy_pin(relative,self.root)
 def test_absolute_parent_alias_and_symlink_policy_inputs_reject(self):
  p=self.root/'public.json';p.write_text('{}');row=m.pin(p)
  for name in [str(p),'../public.json','./public.json','a//b','a\\b']:
   with self.subTest(name=name),self.assertRaises(ValueError):m.policy_pin({**row,'path':name},self.root)
  (self.root/'alias.json').symlink_to(p)
  with self.assertRaises(ValueError):m.policy_pin({**row,'path':'alias.json'},self.root)
 def test_source_inventory_has_no_caller_selected_subset(self):
  for relative,contents in [('zig/tools/aleo_linux_case/case_specs.py',"CASE_CODE=('case_specs.py','inner.py')"),('zig/tools/aleo_linux_sdk/sdk_specs.py',"CODE=('receipts.py','sdk_build.py')")]:
   p=self.root/relative;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(contents)
  paths=m.source_policy_paths(self.root)
  for required in ['zig/tools/aleo_linux_case/inner.py','zig/tools/aleo_linux/kernel_probe.py','zig/tools/aleo_linux_sdk/sdk_build.py','zig/integration/aleo_process.ts','zig/bench/native_case_ci.py']:
   # kernel_probe is in real SDK CODE; this synthetic CODE intentionally lacks it.
   if required.endswith('kernel_probe.py'):continue
   self.assertIn(str(self.root/required),paths)
  self.assertIn(str(self.root/'zig/tools/aleo_linux/receipts.py'),paths)

class InteropCommandContract(unittest.TestCase):
 def test_both_manifest_commands_satisfy_actual_Linux_reader_API(self):
  import argparse
  producer_tree=ast.parse((HERE/'ci_fullcase.py').read_text())
  execute=next(n for n in producer_tree.body if isinstance(n,ast.FunctionDef)and n.name=='execute')
  calls=[n for n in ast.walk(execute)if isinstance(n,ast.Call)and isinstance(n.func,ast.Name)and n.func.id=='run'and n.args and isinstance(n.args[0],ast.BinOp)and isinstance(n.args[0].left,ast.Constant)and n.args[0].left.value=='interop-']
  self.assertEqual(len(calls),1)
  reader_tree=ast.parse((REPO/'zig/integration/native_rows_interop.py').read_text())
  main=next(n for n in reader_tree.body if isinstance(n,ast.FunctionDef)and n.name=='main')
  parser_nodes=[]
  for node in main.body:
   if isinstance(node,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='args'for t in node.targets):break
   parser_nodes.append(node)
  ns={'argparse':argparse,'pathlib':pathlib,'__doc__':'actual reader argument contract'}
  exec(compile(ast.Module(body=parser_nodes,type_ignores=[]),'actual reader argparse','exec'),ns)
  manifest=next(n for n in main.body if isinstance(n,ast.If)and isinstance(n.test,ast.Compare)and isinstance(n.test.left,ast.Attribute)and n.test.left.attr=='tool_manifest')
  refusal=next(n.test for n in manifest.body if isinstance(n,ast.If))
  for mode in m.MODES:
   writer={'path':'/owned/'+mode,'sha256':'a'*64};tools={name:{'path':'/owned/'+name,'sha256':'b'*64}for name in ['ziggy-native-rows','ziggy-rocks-oracle','ziggy-rust-reference']}
   values={'python':pathlib.Path('/usr/bin/python3.12'),'repo':REPO,'writer':writer,'tools':tools,'manifest':{'path':'/owned/manifest.json','sha256':'c'*64},'authority':{'runtime_source_commit':'d'*40},'output':pathlib.Path('/owned/interop-'+mode+'.json')}
   command=eval(compile(ast.Expression(calls[0].args[1]),'actual fullcase interop argv','eval'),values)
   args=ns['parser'].parse_args([str(x)for x in command[4:]])
   self.assertFalse(eval(compile(ast.Expression(refusal),'actual Linux reader admission','eval'),{'args':args,'sys':N(platform='linux')}))
   # The former override combination really is refused by the pinned reader API.
   args.old_oracle=pathlib.Path('/owned/forbidden-override')
   self.assertTrue(eval(compile(ast.Expression(refusal),'actual Linux reader admission','eval'),{'args':args,'sys':N(platform='linux')}))
class FailedCaseTail(unittest.TestCase):
 def script(self):
  import textwrap
  job=(REPO/'.github/workflows/zig-agents.yml').read_text().split('\n  aleo-full-case:',1)[1]
  step=job.split('      - name: Retain bounded failure tail from token-free laboratory case\n',1)[1].split('      - uses:',1)[0]
  self.assertIn("if: failure() && steps.authority.outputs.enabled == 'true'",step)
  return textwrap.dedent(step.split("python3 -I -B - <<'PYTHON'\n",1)[1].split('          PYTHON',1)[0])
 def fixture(self):
  temp=tempfile.TemporaryDirectory(prefix='ziggy-case-failure-tail-');self.addCleanup(temp.cleanup);root=pathlib.Path(temp.name);case=root/'aleo-fullcase-123-1-releasesafe';case.mkdir();return root,case
 def capture(self,root):
  import os
  with mock.patch.dict(os.environ,{'MODE':'ReleaseSafe','RUNNER_TEMP':str(root),'GITHUB_RUN_ID':'123','GITHUB_RUN_ATTEMPT':'1','PRIVATE_SENTINEL':'never-read'},clear=True):exec(compile(self.script(),'actual bounded failure-tail workflow','exec'),{})
 def test_actual_workflow_retains_only64KiB_tail_and_fingerprint(self):
  root,case=self.fixture();raw=b'prefix'+b'x'*70000;source=case/'full-case.private.log';source.write_bytes(raw);self.capture(root)
  target=case/'public/full-case-failure-tail.log';meta=json.loads((case/'public/full-case-failure-tail.json').read_text());self.assertEqual(target.read_bytes(),raw[-65536:]);self.assertEqual(source.read_bytes(),raw);self.assertEqual(target.stat().st_mode&0o777,0o600)
  self.assertEqual(meta['sha256'],hashlib.sha256(raw[-65536:]).hexdigest());self.assertEqual(meta['retained_bytes'],65536);self.assertEqual(meta['original_bytes'],len(raw));self.assertTrue(meta['truncated']);self.assertFalse(meta['native_or_performance_credit']);self.assertNotIn('PRIVATE_SENTINEL',json.dumps(meta))
 def test_actual_workflow_short_log_is_complete_and_never_native_acceptance(self):
  root,case=self.fixture();raw=b'known laboratory failure\n';(case/'full-case.private.log').write_bytes(raw);self.capture(root);self.assertEqual((case/'public/full-case-failure-tail.log').read_bytes(),raw);self.assertFalse(json.loads((case/'public/full-case-failure-tail.json').read_text())['truncated'])
 def test_actual_workflow_missing_or_symlink_log_never_reads_foreign_file(self):
  root,case=self.fixture();self.capture(root);self.assertFalse((case/'public').exists());other=root/'unrelated';other.write_bytes(b'PRIVATE_SENTINEL');(case/'full-case.private.log').symlink_to(other);self.capture(root);self.assertFalse((case/'public').exists());self.assertEqual(other.read_bytes(),b'PRIVATE_SENTINEL')
class Budget(unittest.TestCase):
 def observation(self,**changes):
  now=datetime.datetime(2026,11,8,12,0,0,tzinfo=datetime.timezone.utc);self.now=int(now.timestamp()*10**9)
  job={'id':123,'run_id':456,'run_attempt':1,'head_sha':'a'*40,'name':'aleo-full-case (ReleaseSafe)','status':'in_progress','conclusion':None,'started_at':'2026-11-08T11:00:00Z'};job.update(changes)
  return m.observed_budget(job,{'date':'Sun, 08 Nov 2026 12:00:00 GMT'},run_id=456,attempt=1,head='a'*40,mode='ReleaseSafe',wall_before_ns=self.now-10**9,wall_after_ns=self.now,mono_after_ns=100)
 def test_actual_start_is_not_reset_and_cleanup195min_is_mandatory(self):
  out=self.observation();self.assertEqual(out['conservative_remaining_ns'],(270*60-6)*10**9)
  boundary=out['observed_monotonic_ns']+out['conservative_remaining_ns']-195*60*10**9
  self.assertEqual(m.require_launch_budget(out,boundary),195*60*10**9)
  with self.assertRaises(ValueError):m.require_launch_budget(out,boundary+1)
 def test_wrong_job_mode_head_attempt_and_terminal_status_reject(self):
  for changes in [{'run_id':789},{'run_attempt':2},{'head_sha':'b'*40},{'name':'aleo-full-case (ReleaseFast)'},{'status':'completed'},{'conclusion':'success'}]:
   with self.subTest(changes=changes),self.assertRaises(ValueError):self.observation(**changes)
 def test_time_cannot_move_back_to_buy_budget(self):
  out=self.observation()
  with self.assertRaises(ValueError):m.require_launch_budget(out,99)
 def test_future_api_start_and_clock_disagreement_reject(self):
  # Negative elapsed timestamps cannot provide a new330min budget.
  with self.assertRaises(ValueError):self.observation(started_at='2026-11-08T13:00:00Z')
class FinalGate(unittest.TestCase):
 def good(self):return {'source_unchanged':True,'proof_owner_crossbound':True,'error_type':None,'command_waits':[{'name':n,'actual_parent_wait':True,'exit_code':0,'signals':[],'cleanup_errors':[],'started_monotonic_ns':1,'maximum_wall_seconds':1,'original_deadline_ns':1000000001,'completion_check_ns':2}for n in m.PHASES]}
 def test_success_requires_every_actual_phase_and_crossbound_proof(self):self.assertTrue(m.final_pass(self.good()))
 def test_no_component_postcondition_can_be_ignored(self):
  for key,value in [('source_unchanged',False),('proof_owner_crossbound',False),('error_type','Cancellation')]:
   bad=self.good();bad[key]=value
   with self.subTest(key=key):self.assertFalse(m.final_pass(bad))
  for key,value in [('actual_parent_wait',False),('exit_code',True),('exit_code',1),('signals',['SIGINT'])]:
   bad=self.good();bad['command_waits'][-1][key]=value
   with self.subTest(key=key):self.assertFalse(m.final_pass(bad))
  bad=self.good();bad['command_waits'].pop();self.assertFalse(m.final_pass(bad))

class Custody(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=pathlib.Path(self.temp.name).resolve()
 def test_command_actual_wait_and_no_signals_required(self):
  child=mock.Mock(pid=123);child.wait.return_value=0;cmd=m.Commands(self.root,{'PATH':'/usr/bin:/bin'})
  with mock.patch.object(m.subprocess,'Popen',return_value=child):cmd.run('actual-command',['/fixed/tool'],10)
  self.assertTrue(cmd.rows[0]['actual_parent_wait']);self.assertEqual(cmd.rows[0]['exit_code'],0);self.assertEqual(cmd.rows[0]['signals'],[])
 def test_timeout_graceful_exit0_still_fails_proof(self):
  child=mock.Mock(pid=123);child.wait.side_effect=[subprocess.TimeoutExpired('/fixed/tool',1),0,0];child.poll.return_value=None;cmd=m.Commands(self.root,{})
  with mock.patch.object(m.subprocess,'Popen',return_value=child),mock.patch.object(m.os,'killpg')as kill:
   with self.assertRaises(subprocess.TimeoutExpired):cmd.run('actual-timeout',['/fixed/tool'],1)
  self.assertTrue(cmd.rows[0]['actual_parent_wait']);self.assertEqual(cmd.rows[0]['signals'],['SIGINT']);kill.assert_called_once_with(123,m.signal.SIGINT)
 def test_cancellation_is_not_eintr_and_preserves_wait(self):
  self.assertFalse(issubclass(m.TaskInterrupted,InterruptedError))
  child=mock.Mock(pid=123);child.wait.side_effect=[m.TaskInterrupted('stop'),0,0];child.poll.return_value=None;cmd=m.Commands(self.root,{})
  with mock.patch.object(m.subprocess,'Popen',return_value=child),mock.patch.object(m.os,'killpg'):
   with self.assertRaises(m.TaskInterrupted):cmd.run('actual-cancel',['/fixed/tool'],1)
  self.assertTrue(cmd.rows[0]['actual_parent_wait']);self.assertEqual(cmd.rows[0]['interruption_type'],'TaskInterrupted')
class DeadlineAndLaunchUnwind(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=pathlib.Path(self.temp.name).resolve()
 def test_late_zero_is_retained_actual_wait_but_fails_original_deadline(self):
  child=mock.Mock(pid=123);child.wait.return_value=0;cmd=m.Commands(self.root,{})
  with mock.patch.object(m.subprocess,'Popen',return_value=child),mock.patch.object(m.time,'monotonic_ns',side_effect=[0,0,11*10**9,11*10**9]):
   with self.assertRaisesRegex(ValueError,'monotonic'):cmd.run('late-zero',['/fixed/tool'],10)
  row=cmd.rows[0];self.assertTrue(row['actual_parent_wait']);self.assertEqual(row['exit_code'],0);self.assertEqual(row['original_deadline_ns'],10*10**9);self.assertEqual(row['completion_check_ns'],11*10**9);self.assertFalse(m.phase_fence(row))
 def test_postspawn_pid_bookkeeping_cancellation_still_waits_actual_child(self):
  child=mock.Mock();type(child).pid=mock.PropertyMock(side_effect=[m.TaskInterrupted('original-postspawn'),123]);child.poll.return_value=None;child.wait.return_value=0;cmd=m.Commands(self.root,{})
  with mock.patch.object(m.subprocess,'Popen',return_value=child),mock.patch.object(m.os,'killpg')as kill:
   with self.assertRaisesRegex(m.TaskInterrupted,'original-postspawn'):cmd.run('postspawn-cancel',['/fixed/tool'],10)
  child.wait.assert_called_once();kill.assert_called_once_with(123,m.signal.SIGINT);self.assertTrue(cmd.rows[0]['actual_parent_wait']);self.assertEqual(cmd.rows[0]['pid'],123)
 def test_signal_failure_cannot_skip_actual_wait_or_replace_primary(self):
  child=mock.Mock(pid=123);child.poll.return_value=None;original=subprocess.TimeoutExpired('/fixed/tool',10);child.wait.side_effect=[original,0];cmd=m.Commands(self.root,{})
  with mock.patch.object(m.subprocess,'Popen',return_value=child),mock.patch.object(m.os,'killpg',side_effect=OSError('signal failed')):
   with self.assertRaises(subprocess.TimeoutExpired)as observed:cmd.run('signal-failed',['/fixed/tool'],10)
  self.assertIs(observed.exception,original);self.assertTrue(cmd.rows[0]['actual_parent_wait']);self.assertIn('signal:OSError',cmd.rows[0]['cleanup_errors']);self.assertEqual(child.wait.call_count,2)

class CaseLogOwnership(unittest.TestCase):
 def test_actual_inner_launch_cannot_reopen_supervisor_case_logs(self):
  outer=next(n for n in ast.parse((HERE/'case_supervisor.py').read_text()).body if isinstance(n,ast.FunctionDef)and n.name=='run')
  launch=next(n for n in ast.walk(outer)if isinstance(n,ast.FunctionDef)and n.name=='launch')
  opens=[n for n in launch.body if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id in {'out','err'}for t in n.targets)]
  self.assertEqual(len(opens),2)
  source=(HERE/'inner.py').read_text();run=next(n for n in ast.parse(source).body if isinstance(n,ast.FunctionDef)and n.name=='run')
  inner=next(n for n in run.body if isinstance(n,ast.FunctionDef)and n.name=='launch')
  call=next(n for n in ast.walk(run)if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='main'for t in n.targets))
  with tempfile.TemporaryDirectory()as directory:
   control=pathlib.Path(directory);space={'control':control,'label':'case'}
   exec(compile(ast.Module(body=opens,type_ignores=[]),'actual-supervisor-log-creation','exec'),space)
   for name in ('out','err'):space[name].write(b'preserve-outer-log');space[name].close()
   before={p.name:p.read_bytes()for p in control.iterdir()}
   child=mock.Mock();popen=mock.Mock(return_value=child);streams=[];children=[]
   env={'control':control,'spec':{'original_deadline_ns':2,'exact_node_argv':['admitted-node','admitted-launcher']},'cancelled':N(is_set=lambda:False),'time':N(monotonic_ns=lambda:1),'need':m.need,'subprocess':N(Popen=popen),'streams':streams,'children':children}
   exec(compile(ast.Module(body=[inner],type_ignores=[]),'actual-inner-launch-definition','exec'),env)
   old=copy.deepcopy(call);old.value.args[0]=ast.Constant(value='case');ast.fix_missing_locations(old)
   with self.assertRaises(FileExistsError):exec(compile(ast.Module(body=[old],type_ignores=[]),'old-colliding-call','exec'),env)
   popen.assert_not_called()
   try:exec(compile(ast.Module(body=[call],type_ignores=[]),'actual-distinct-inner-call','exec'),env)
   finally:
    for stream in streams:stream.close()
   popen.assert_called_once();self.assertEqual(children,[('node-case',child)])
   self.assertEqual({p.name:p.read_bytes()for p in control.iterdir()if p.name in before},before)
   self.assertEqual({p.name for p in control.iterdir()},set(before)|{'node-case.stdout','node-case.stderr'})

class ClosedCaseFailure(unittest.TestCase):
 def test_typed_projection_retains_io_guard_and_actual_waits_without_private_values(self):
  with tempfile.TemporaryDirectory()as directory:
   case=pathlib.Path(directory).resolve()/'case';(case/'control').mkdir(parents=True);case.with_suffix('.owner').mkdir()
   (case/'result.json').write_text(json.dumps({'passed':False,'error':'ValueError:actual isolated Aleo case failed','direct_waits':[{'phase':'case','pid':123,'actual_parent_wait':True,'exit_code':1,'argv':['PRIVATE_SENTINEL']}],'argv':['PRIVATE_SENTINEL'],'gate_failed':None}))
   (case/'control/inner-result.json').write_text(json.dumps({'passed':False,'error':"FileExistsError:[Errno 17] PRIVATE_SENTINEL",'actual_waits':[],'signals':[],'cleanup_errors':['PRIVATE_SENTINEL']}))
   (case.with_suffix('.owner')/'owner.json').write_text(json.dumps({'passed':False,'error':'ValueError:actual case service failed','client_wait':{'pid':456,'actual_parent_wait':True,'exit_code':1,'private':'PRIVATE_SENTINEL'},'cleanup':{'owned_cgroup_absent':True,'private':'PRIVATE_SENTINEL'}}))
   value=m.case_failure_diagnostics(case,REPO);text=json.dumps(value);self.assertNotIn('PRIVATE_SENTINEL',text);self.assertNotIn(str(case),text);self.assertFalse(value['native_or_performance_credit'])
   payload=value['records']['payload'];self.assertEqual(payload['error']['fixed_Source_guard']['guard'],'actual isolated Aleo case failed');self.assertEqual(payload['direct_waits']['rows'],[{'pid':123,'exit_code':1,'actual_parent_wait':True,'phase':'case'}])
   self.assertEqual(value['records']['namespace']['error'],{'present':True,'class':'FileExistsError','errno':17});self.assertEqual(value['records']['service']['cleanup'],{'owned_cgroup_absent':True});self.assertEqual(value['records']['driver']['status'],'absent')
 def test_projection_refuses_alias_and_oversized_metadata_and_never_reads_logs(self):
  with tempfile.TemporaryDirectory()as directory:
   case=pathlib.Path(directory).resolve()/'case';case.mkdir();outside=case.parent/'private.json';outside.write_text('{"private":"PRIVATE_SENTINEL"}');(case/'result.json').symlink_to(outside);(case/'private.log').write_text('PRIVATE_SENTINEL')
   value=m.case_failure_diagnostics(case,REPO);self.assertEqual(value['records']['payload']['status'],'unsafe-path');self.assertNotIn('PRIVATE_SENTINEL',json.dumps(value))
   (case/'result.json').unlink()
   with (case/'result.json').open('wb')as output:output.truncate(32*1024**2+1)
   with mock.patch.object(m,'pin',side_effect=AssertionError('oversized metadata hashed'))as pin_mock,mock.patch.object(m,'load',side_effect=AssertionError('oversized metadata loaded'))as load_mock:
    value=m.case_failure_diagnostics(case,REPO);pin_mock.assert_not_called();load_mock.assert_not_called()
   self.assertEqual(value['records']['payload']['status'],'unavailable');self.assertFalse(value['native_or_performance_credit'])


class StartupFailureProjection(unittest.TestCase):
 def fixture(self,case):
  path=REPO/'zig/tools/aleo_linux_case/case_delegate.py';row=m.pin(path);marker={'schema':1,'kind':'aleo-case-service-startup-failure-v1','stage':'prepare-controllers','error_class':'PermissionError','errno':13,'observed_monotonic_ns':time.monotonic_ns(),'frames':[{'source':'case_delegate.py','line':1,'bytes':row['bytes'],'sha256':row['sha256']}]}
  diagnostics={'schema':1,'kind':'aleo-case-service-failure-metadata-v1','files':{'stdout':{'status':'available','bytes':0,'sha256':hashlib.sha256(b'').hexdigest()},'stderr':{'status':'available','bytes':99,'sha256':'a'*64}},'startup':{'status':'available','record':marker},'raw_logs_argv_environment_exported':False}
  value={'passed':False,'error':'ValueError:actual case service failed','client_wait':{'pid':123,'actual_parent_wait':True,'exit_code':1},'service_failure_diagnostics':diagnostics,'private':{'authorization':'PRIVATE_SENTINEL'}};directory=case.with_suffix('.owner');directory.mkdir();path=directory/'owner.json';path.write_text(json.dumps(value));return path,value
 def test_actual_already_uploaded_public_caller_reconstructs_validated_stage_frames_logs(self):
  with tempfile.TemporaryDirectory()as root:
   case=pathlib.Path(root).resolve()/'case';path,value=self.fixture(case);result=m.case_failure_diagnostics(case,REPO);service=result['records']['service'];self.assertEqual(service['status'],'available');self.assertEqual(service['error']['fixed_Source_guard']['guard'],'actual case service failed');diagnostic=service['service_failure_diagnostics'];self.assertEqual(diagnostic['startup']['record']['stage'],'prepare-controllers');self.assertEqual(diagnostic['startup']['record']['errno'],13);self.assertEqual(diagnostic['files']['stderr']['bytes'],99);self.assertNotIn('PRIVATE_SENTINEL',json.dumps(result));self.assertNotIn(str(case),json.dumps(result));self.assertFalse(result['native_or_performance_credit'])
 def test_public_malformed_private_or_stale_source_cannot_mask_original_service_error(self):
  with tempfile.TemporaryDirectory()as root:
   case=pathlib.Path(root).resolve()/'case';path,original=self.fixture(case)
   for change in ['extra','nested','schema','bool-clock','wrong-source','wrong-hash','wrong-stage']:
    value=copy.deepcopy(original);d=value['service_failure_diagnostics'];v=d['startup']['record']
    if change=='extra':d['private']='PRIVATE_SENTINEL'
    if change=='nested':v['frames'][0]['authorization']={'private':'PRIVATE_SENTINEL'}
    if change=='schema':d['schema']=True
    if change=='bool-clock':v['observed_monotonic_ns']=True
    if change=='wrong-source':v['frames'][0]['source']='PRIVATE_SENTINEL'
    if change=='wrong-hash':v['frames'][0]['sha256']='b'*64
    if change=='wrong-stage':v['stage']='PRIVATE_SENTINEL'
    path.write_text(json.dumps(value));result=m.case_failure_diagnostics(case,REPO);service=result['records']['service'];self.assertEqual(service['status'],'available');self.assertEqual(service['error']['fixed_Source_guard']['guard'],'actual case service failed');self.assertEqual(service['service_failure_diagnostics'],{'status':'refused'},change);self.assertNotIn('PRIVATE_SENTINEL',json.dumps(result))
 def test_source_trace_fallback_stays_unobserved_and_no_performance_or_acceptance_credit(self):
  with tempfile.TemporaryDirectory()as root:
   case=pathlib.Path(root).resolve()/'case';path,value=self.fixture(case);d=value['service_failure_diagnostics'];d['startup']['status']='source-trace-only';d['startup']['record'].update(kind='aleo-case-service-source-trace-v1',stage='unobserved');path.write_text(json.dumps(value));result=m.case_failure_diagnostics(case,REPO);record=result['records']['service']['service_failure_diagnostics']['startup'];self.assertEqual(record['status'],'source-trace-only');self.assertEqual(record['record']['stage'],'unobserved');self.assertFalse(result['native_or_performance_credit'])


class DriverFailureProjection(unittest.TestCase):
 def sources(self):
  value=json.loads((REPO/'zig/tools/aleo_linux_case/ci_policy.PENDING.json').read_bytes())
  row=next(r for r in value['required_source']if r['path']=='zig/integration/aleo_process.ts')
  return [m.policy_pin(row,REPO)]
 def test_actual_public_caller_projects_pinned_stage_and_static_guard_without_raw_errors(self):
  with tempfile.TemporaryDirectory()as directory:
   case=pathlib.Path(directory).resolve()/'case';path=case/'data/case/result.json';path.parent.mkdir(parents=True)
   errors=['Docker daemon changed since resource approval','owned child cleanup: PermissionError: [Errno 13] PRIVATE_SENTINEL/path','owned command failed: PRIVATE_SENTINEL/token: private SDK reply','unclassified PRIVATE_SENTINEL']
   path.write_text(json.dumps({'passed':False,'stage':'actual-runtime-preflight','errors':errors,'evidence':{'authorization':'PRIVATE_SENTINEL'}}))
   result=m.case_failure_diagnostics(case,REPO,self.sources());record=result['records']['driver'];d=record['driver_observation'];self.assertEqual(record['errors_count'],4);self.assertEqual(d['status'],'observed');self.assertEqual(d['last_persisted_stage']['value'],'actual-runtime-preflight');self.assertGreater(d['last_persisted_stage']['source_literal_line'],0)
   self.assertEqual(d['source']['sha256'],self.sources()[0]['sha256']);self.assertEqual(d['error_rows'][0]['classification'],'DOCKER_DAEMON_CHANGED');self.assertEqual(d['error_rows'][1]['prefix']['kind'],'OWNED_CHILD_CLEANUP');self.assertEqual(d['error_rows'][1]['text_class'],'PermissionError');self.assertEqual(d['error_rows'][1]['text_errno'],13);self.assertEqual(d['error_rows'][2]['classification'],'OWNED_COMMAND_FAILED');self.assertEqual(d['error_rows'][3]['classification'],'UNCLASSIFIED')
   for raw,row in zip(errors,d['error_rows']):self.assertEqual((row['bytes'],row['sha256']),(len(raw.encode()),hashlib.sha256(raw.encode()).hexdigest()))
   text=json.dumps(result);self.assertNotIn('PRIVATE_SENTINEL',text);self.assertNotIn(str(case),text);self.assertIn('Text',d['basis'].replace('text','Text'));self.assertFalse(result['native_or_performance_credit'])
 def test_unknown_malicious_nested_or_nonstring_values_never_become_public_messages(self):
  value={'passed':False,'stage':{'PRIVATE_SENTINEL':'secret'},'errors':[{'name':'PRIVATE_SENTINEL','errno':13},'SDK private PRIVATE_SENTINEL','EACCES: PRIVATE_SENTINEL']}
  d=m.driver_failure_observation(value,REPO,self.sources());self.assertEqual(d['last_persisted_stage'],{'status':'unrecognized'});self.assertEqual(d['error_rows'][0],{'status':'non-string'});self.assertEqual(d['error_rows'][1]['classification'],'UNCLASSIFIED');self.assertEqual(d['error_rows'][2]['text_code'],'EACCES');self.assertNotIn('text_errno',d['error_rows'][2]);self.assertNotIn('PRIVATE_SENTINEL',json.dumps(d))
 def test_error_row_count_size_and_malformed_text_are_bounded_without_leakage(self):
  errors=['PRIVATE_SENTINEL'*6000,'\ud800']+['private']*20;d=m.driver_failure_observation({'passed':False,'stage':'preflight','errors':errors},REPO,self.sources());self.assertEqual(d['errors_count'],22);self.assertTrue(d['errors_truncated']);self.assertEqual(len(d['error_rows']),16);self.assertEqual(d['error_rows'][0]['status'],'oversized');self.assertEqual(d['error_rows'][0]['sha256'],hashlib.sha256(errors[0].encode()).hexdigest());self.assertEqual(d['error_rows'][1]['status'],'invalid-text');self.assertLess(len(json.dumps(d).encode()),32768);self.assertNotIn('PRIVATE_SENTINEL',json.dumps(d))
 def test_absent_duplicate_mismatched_or_unbounded_admitted_Source_refuses_classification(self):
  sources=self.sources();value={'passed':False,'stage':'actual-runtime-preflight','errors':['Docker daemon changed since resource approval']}
  for rows in (None,[],sources+sources,[{**sources[0],'sha256':'0'*64}],[{**sources[0],'sha256':{'private':'PRIVATE_SENTINEL'}}]):
   with self.subTest(rows=rows):self.assertEqual(m.driver_failure_observation(value,REPO,rows),{'status':'source-refused'})
  with mock.patch.object(pathlib.Path,'open',side_effect=AssertionError('oversized Source opened'))as opened:self.assertEqual(m.driver_failure_observation(value,REPO,[{**sources[0],'bytes':1024**2+1}]),{'status':'source-refused'});opened.assert_not_called()
 def test_Source_capture_is_single_bounded_read_and_replacement_bytes_fail_hash(self):
  value={'passed':False,'stage':'preflight','errors':[]};source=self.sources()[0];original=pathlib.Path.open;seen=[]
  def observe(path,*args,**kwargs):seen.append(path);return original(path,*args,**kwargs)
  with mock.patch.object(pathlib.Path,'open',autospec=True,side_effect=observe):d=m.driver_failure_observation(value,REPO,[source])
  self.assertEqual(d['status'],'observed');self.assertEqual(seen,[pathlib.Path(source['path'])])
  stream=mock.MagicMock();stream.__enter__.return_value.read.return_value=b'PRIVATE_SENTINEL changed Source'
  with mock.patch.object(pathlib.Path,'open',return_value=stream):self.assertEqual(m.driver_failure_observation(value,REPO,[source]),{'status':'source-refused'})
 def test_dynamic_readback_stage_reports_only_Source_pattern_and_epoch(self):
  for stage,kind in [('stopped-PRIVATE_SENTINEL-0','STOPPED_READBACK'),('readonly-files-PRIVATE_SENTINEL-1','READONLY_FILES')]:
   d=m.driver_failure_observation({'passed':False,'stage':stage,'errors':[]},REPO,self.sources());self.assertEqual(d['last_persisted_stage']['category'],kind);self.assertNotIn('PRIVATE_SENTINEL',json.dumps(d));self.assertNotIn('value',d['last_persisted_stage'])
  d=m.driver_failure_observation({'passed':False,'stage':'PRIVATE_SENTINEL','errors':[]},REPO,self.sources());self.assertEqual(d['last_persisted_stage'],{'status':'unrecognized'})
 def test_ambiguous_Source_stage_or_guard_literal_is_not_assigned_a_callsite(self):
  with tempfile.TemporaryDirectory()as directory:
   repo=pathlib.Path(directory).resolve();path=repo/'zig/integration/aleo_process.ts';path.parent.mkdir(parents=True);original=(REPO/'zig/integration/aleo_process.ts').read_bytes();path.write_bytes(original+b"\nawait save('actual-runtime-preflight', {});\n'Docker daemon changed since resource approval';\n")
   d=m.driver_failure_observation({'passed':False,'stage':'actual-runtime-preflight','errors':['Docker daemon changed since resource approval']},repo,[m.pin(path)]);self.assertEqual(d['last_persisted_stage'],{'status':'unrecognized'});self.assertEqual(d['error_rows'][0]['classification'],'UNCLASSIFIED')
 def test_success_is_not_classified_and_actual_failure_caller_supplies_admitted_Source(self):
  with mock.patch.object(pathlib.Path,'open',side_effect=AssertionError('success Source read')):self.assertEqual(m.driver_failure_observation({'passed':True},REPO,None),{'status':'not-failed'})
  tree=ast.parse(pathlib.Path(m.__file__).read_bytes());execute=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='execute');call=next(n for n in ast.walk(execute)if isinstance(n,ast.Call)and isinstance(n.func,ast.Name)and n.func.id=='case_failure_diagnostics');self.assertEqual(len(call.args),3);self.assertEqual(ast.unparse(call.args[2]),"authority['required_source']")



class DriverCaughtErrorProjection(unittest.TestCase):
 def source(self):return (REPO/'zig/integration/aleo_process.ts').read_text()
 def diagnostic(self):
  point={'attempted_boundary':'sdk-worker-deploy-left','error_class':'TypeError','error_code':'EACCES','driver_frames':[{'line':1,'column':1}]}
  return {'schema':1,'kind':'aleo-source-bound-caught-error-v1','attempted_boundary':'sdk-deployment','error_class':'Error','error_code':None,'driver_frames':[{'line':1,'column':1}],'worker':point}
 def test_actual_failed_driver_public_projection_checks_pinned_Source_and_caught_worker_properties(self):
  with tempfile.TemporaryDirectory()as directory:
   root=pathlib.Path(directory).resolve();repo=root/'repo';source=repo/'zig/integration/aleo_process.ts';source.parent.mkdir(parents=True);source.write_text(self.source())
   for name in ['case_delegate.py','case_supervisor.py','inner.py']:
    target=repo/'zig/tools/aleo_linux_case'/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes((REPO/'zig/tools/aleo_linux_case'/name).read_bytes())
   case=root/'case';driver=case/'data/case/result.json';driver.parent.mkdir(parents=True)
   driver.write_text(json.dumps({'passed':False,'stage':'actual-runtime-preflight','errors':['PRIVATE_PRIMARY'],'evidence':{'caughtErrorDiagnostic':self.diagnostic(),'PRIVATE':'AUTH_TOKEN'}}))
   value=m.case_failure_diagnostics(case,repo,[m.pin(source)]);point=value['records']['driver']['driver_observation']['caught_error']
   self.assertEqual(point['status'],'observed');self.assertEqual(point['attempted_boundary'],'sdk-deployment');self.assertEqual(point['worker']['attempted_boundary'],'sdk-worker-deploy-left');self.assertEqual(point['worker']['error_class'],'TypeError');self.assertEqual(point['worker']['error_code'],'EACCES');self.assertEqual(point['worker']['driver_frames'],[{'line':1,'column':1}])
   self.assertNotIn('PRIVATE',json.dumps(value));self.assertNotIn('AUTH_TOKEN',json.dumps(value));self.assertLess(len(json.dumps(value)),32768)
   self.assertFalse(value['native_or_performance_credit'])
 def test_unknown_metadata_fields_values_nested_objects_and_bad_Source_coordinates_refuse(self):
  original=self.diagnostic();cases=[]
  for key,value in [('PRIVATE','secret'),('error_class','PRIVATE_CLASS'),('error_code','PRIVATE_CODE'),('attempted_boundary','PRIVATE_STAGE'),('driver_frames',[{'line':1,'column':1,'path':'PRIVATE'}]),('driver_frames',[{'line':1000000,'column':1}]),('driver_frames',[{'line':1,'column':1000000}]),('driver_frames',[{'line':True,'column':1}]),('driver_frames',[{'line':1,'column':1}]*9),('worker',{'attempted_boundary':'PRIVATE'})]:
   row=copy.deepcopy(original);row[key]=value;cases.append(row)
  child=copy.deepcopy(original);child['worker']['attempted_boundary']='node-launch';cases.append(child)
  for row in cases:
   with self.subTest(rowkey=list(row)):
    self.assertEqual(m.source_bound_caught_error(row,self.source()),{'status':'refused'})
 def test_missing_metadata_is_honest_and_duplicate_Source_catalog_is_not_authority(self):
  self.assertEqual(m.source_bound_caught_error(None,self.source()),{'status':'not-recorded'})
  self.assertEqual(m.source_bound_caught_error(self.diagnostic(),self.source()+self.source()),{'status':'refused'})
  self.assertEqual(m.source_bound_caught_error(self.diagnostic(),''),{'status':'refused'})
 def test_actual_driver_Source_hash_mismatch_prevents_any_caught_error_classification(self):
  with tempfile.TemporaryDirectory()as directory:
   repo=pathlib.Path(directory).resolve();source=repo/'zig/integration/aleo_process.ts';source.parent.mkdir(parents=True);source.write_text(self.source());row=m.pin(source);source.write_text(self.source()+'\nchanged')
   result=m.driver_failure_observation({'passed':False,'errors':['PRIVATE'],'evidence':{'caughtErrorDiagnostic':self.diagnostic()}},repo,[row]);self.assertEqual(result,{'status':'source-refused'})

if __name__=='__main__':unittest.main(verbosity=2)
