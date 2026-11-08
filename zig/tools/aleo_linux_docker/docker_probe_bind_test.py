"""Pure false-by-default authority and immutable profile controls."""
import copy,hashlib,importlib.util,json,pathlib,sys,tempfile,unittest
from unittest import mock
P=pathlib.Path(__file__).resolve().parent;sys.path.insert(0,str(P))
s=importlib.util.spec_from_file_location('binder',P/'docker_probe_bind.py');api=importlib.util.module_from_spec(s);s.loader.exec_module(api)
class Tests(unittest.TestCase):
 def setUp(self):self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=pathlib.Path(self.temp.name).resolve()
 def policy(self):return {'schema':1,'root_approved':False,'purpose':api.probe.PURPOSE,'caps':api.probe.CAPS,'provision_caps':api.stage.CAPS,'delegation_caps':api.delegate.PROFILE,'fresh_kernel_prerequisite':True}
 def write(self,v):
  p=self.root/'policy.json';p.write_text(json.dumps(v));return p,hashlib.sha256(p.read_bytes()).hexdigest()
 def test_false_authority_never_discovers_tools_git_or_mints_outputs(self):
  p,h=self.write(self.policy());out=self.root/'must-not-exist'
  with mock.patch.object(api,'tools',side_effect=AssertionError('no tools')),mock.patch.object(api,'source_pins',side_effect=AssertionError('no Source')),mock.patch.object(api.subprocess,'check_output',side_effect=AssertionError('no child')):
   for mode in ['stage','kernel','probe']:self.assertEqual(api.prepare(p,h,out,self.root,mode),{'enabled':False,'native_or_proof_credit':False})
  self.assertFalse(out.exists())
 def test_each_bound_profile_and_fresh_kernel_requirement_is_exact(self):
  for key in ['caps','provision_caps','delegation_caps','fresh_kernel_prerequisite','purpose','root_approved']:
   value=copy.deepcopy(self.policy());value[key]=False if key=='fresh_kernel_prerequisite'else 'foreign';p,h=self.write(value)
   with self.subTest(key=key),self.assertRaises(ValueError):api.policy(p,h)
 def test_duplicate_unknown_or_changed_request_bytes_never_authorize(self):
  p,h=self.write(self.policy());p.write_text(p.read_text()+' ')
  with self.assertRaises(ValueError):api.policy(p,h)
  v=self.policy();v['authorization_override']=True;p,h=self.write(v)
  with self.assertRaises(ValueError):api.policy(p,h)
  p.write_text('{"schema":1,"schema":1}');h=hashlib.sha256(p.read_bytes()).hexdigest()
  with self.assertRaises(ValueError):api.policy(p,h)
 def test_stage_pending_and_crossed_images_reject_before_process_or_network(self):
  with mock.patch.object(api.stage,'checked',side_effect=AssertionError('unapproved filesystem')):
   for value in [{},{'schema':1,'root_approved':False,'purpose':api.stage.PURPOSE,'images':api.probe.IMAGES},{'schema':1,'root_approved':True,'purpose':api.stage.PURPOSE,'images':{},'caps':api.stage.CAPS}]:
    with self.assertRaises(ValueError):api.stage.approved(value)
 def test_runtime_kernel_validator_is_exact_reused_fresh_sameboot_scope(self):
  row={'kind':'aleo-linux-kernel-prerequisite-v1','schema':1,'passed':True,'boot_id':'boot','kernel_release':'kernel','finished_monotonic_ns':100,'namespace':{k:True for k in ('private_network','NoNewPrivs','zero_capabilities','no_outside_route','outside_TCP_denied','private_PID1','host_UNIX_hidden','readonly_owned_sentinel','nested_userns_disabled','same_python_time_namespace','three_byte_halfclose_channels')},'MemTotal_bytes':32*api.probe.GIB,'cgroup_v2_limits_applied':True,'pidfd_open_supported':True,'all_owned_absent':True,'forced_cleanup':False,'negative_owner_cleanup':{'all_owned_absent':True,'actual_parent_wait':True},'commands':[{'actual_parent_wait':True,'exit_code':0}]}
  self.assertEqual(api.probe.validate_kernel(row,'boot','kernel',101),row)
  for key,value in [('boot_id','foreign'),('kernel_release','other'),('finished_monotonic_ns',102),('forced_cleanup',True),('MemTotal_bytes',31*api.probe.GIB)]:
   changed=copy.deepcopy(row);changed[key]=value
   with self.subTest(key=key),self.assertRaises(ValueError):api.probe.validate_kernel(changed,'boot','kernel',101)
  with self.assertRaises(ValueError):api.probe.validate_kernel(row,'boot','kernel',301*10**9+100)
 def test_actual_14_job_Docker_routes_and_conflicts(self):
  import ast,re
  from types import SimpleNamespace as N
  kernel=P.parent/'aleo_linux/kernel_only_test.py';source=ast.parse(kernel.read_text());functions=[n for n in source.body if isinstance(n,ast.FunctionDef)and n.name in {'conditions','selected'}];ns={'re':re,'N':N};exec(compile(ast.Module(body=functions,type_ignores=[]),'actual-existing-route-reader','exec'),ns)
  rows=ns['conditions']((P.parents[2]/'.github/workflows/zig-agents.yml').read_text());selected=ns['selected'];self.assertEqual(len(rows),15)
  for suffix in ['', ' [zig-native-case] [zig-svm-prerequisites-only]']:
   self.assertEqual(selected(rows,message='[zig-aleo-docker-only]'+suffix),{'aleo-native-docker-prerequisite'})
   self.assertEqual(selected(rows,message='[zig-aleo-docker-only] [zig-aleo-sdk-only]'+suffix),set())
   self.assertEqual(selected(rows,message='[zig-aleo-docker-only] [zig-aleo-kernel-only]'+suffix),set())
  for sdk in [False,True]:
   for kernel in [False,True]:
    self.assertEqual(selected(rows,event='workflow_dispatch',docker=True,sdk=sdk,aleo=kernel,svm=True,cold=True),set()if sdk or kernel else {'aleo-native-docker-prerequisite'})
  self.assertEqual(selected(rows,message='[zig-native-case]'),{'native-case-producer-inputs'})
  self.assertEqual(selected(rows,message='[zig-svm-prerequisites-only]'),{'svm-prerequisites'})
  self.assertEqual(selected(rows,message='[zig-aleo-sdk-only]'),{'aleo-linux-sdk-prerequisite'})
  self.assertEqual(selected(rows,message='[zig-aleo-kernel-only]'),{'aleo-linux-prerequisite'})
if __name__=='__main__':unittest.main()
