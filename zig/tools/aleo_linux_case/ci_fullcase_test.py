"""Pure composition/route checks. No SDK/VM/process/network entry is invoked."""
import ast,copy,datetime,hashlib,importlib.util,itertools,json,pathlib,re,subprocess,tempfile,time,unittest
from types import SimpleNamespace as N
from unittest import mock
HERE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('actual_ci_fullcase',HERE/'ci_fullcase.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
REPO=HERE.parents[2]
FULL="((github.event_name == 'push' && github.ref == 'refs/heads/feat/zig-agent-rewrite' && contains(github.event.head_commit.message, '[zig-aleo-fullcase-only]')) || (github.event_name == 'workflow_dispatch' && inputs.aleo_full_case))"
INPUT="      aleo_full_case:\n        description: Run only reviewed dedicated Aleo Safe/Fast full cases (requires actual same-job prerequisites)\n        type: boolean\n        default: false\n"
# Exact current14-job inverse, including reviewed C45 progress/C46 cold/C47 readback hunks.
# Further workflow-body changes still require explicit review and a new baseline.
BASE_SHA=('e5907c15c98fde981fec43b356786ce34' '44c5c237a2ab790c3bed6172b86f401')
def evaluator():
 tree=ast.parse((REPO/'zig/tools/aleo_linux/kernel_only_test.py').read_text());ns={'re':re,'N':N}
 functions=[n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name in {'conditions','selected'}]
 exec(compile(ast.Module(body=functions,type_ignores=[]),'actual-shared-route-evaluator','exec'),ns);return ns
class Routes(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.text=(REPO/'.github/workflows/zig-agents.yml').read_text();cls.ns=evaluator();cls.rows=cls.ns['conditions'](cls.text)
 def selected(self,**kw):return self.ns['selected'](self.rows,**kw)
 def test_exact15jobs_and_both_mode_serial_hardbounds(self):
  self.assertEqual(len(self.rows),15);job=self.text.split('\n  aleo-full-case:',1)[1]
  for item in ['mode: [ReleaseSafe, ReleaseFast]','max-parallel: 1','timeout-minutes: 330','runs-on: depot-ubuntu-24.04-16','actions: read','persist-credentials: false']:self.assertIn(item,job)
 def test_all14_old_bodies_have_exact_inverse(self):
  old=self.text.split('\n  aleo-full-case:',1)[0];old=old.replace(INPUT,'',1)
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
  old={k:v[len('${{ !'+FULL+' && ('):-4]+' }}'for k,v in self.rows.items()if k!='aleo-full-case'}
  # v tail is ') }}'; reconstruct exact old expression, never drop arbitrary fields.
  old={k:'${{ '+v[len('${{ !'+FULL+' && ('):-4]+' }}'for k,v in self.rows.items()if k!='aleo-full-case'}
  count=0
  for event,ref,message,flags in itertools.product(['push','pull_request','workflow_dispatch'],['refs/heads/main','refs/heads/feat/zig-agent-rewrite'],['ordinary','[zig-native-case]','[zig-svm-prerequisites-only]'],itertools.product([False,True],repeat=4)):
   svm,cold,sdk,aleo=flags;kw=dict(event=event,ref=ref,message=message,svm=svm,cold=cold,sdk=sdk,aleo=aleo)
   self.assertEqual(self.selected(**kw),self.ns['selected'](old,**kw));count+=1
  self.assertEqual(count,288)
 def test_unrelated_branch_and_PR_full_marker_do_not_activate(self):
  for event,ref in [('pull_request','refs/heads/feat/zig-agent-rewrite'),('push','refs/heads/main')]:self.assertNotIn('aleo-full-case',self.selected(event=event,ref=ref,message='[zig-aleo-fullcase-only]'))
 def test_all_python_invocations_isolated_and_no_raw_fallback(self):
  job=self.text.split('\n  aleo-full-case:',1)[1]
  calls=[line for line in job.splitlines()if 'python3 'in line and 'apt-get'not in line]
  self.assertEqual(len(calls),3);self.assertTrue(all('python3 -I -B'in line for line in calls))
  self.assertNotIn('run-locally',job);self.assertNotIn('**',job);self.assertNotIn('workflow_dispatch:',job)
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

if __name__=='__main__':unittest.main(verbosity=2)
