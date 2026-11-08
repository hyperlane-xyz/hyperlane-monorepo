"""Pure lifecycle authority controls; optional actual local Helm render only."""
from pathlib import Path
import copy,hashlib,json,sys,tempfile,types,unittest,subprocess,os
from types import SimpleNamespace
from unittest.mock import Mock
HERE=Path(__file__).resolve().parent
m=types.ModuleType('helm_fixture');m.__file__=str(HERE/'helm_container_check.py');sys.modules[m.__name__]=m
exec(compile(Path(m.__file__).read_bytes(),m.__file__,'exec'),m.__dict__)
def effect_audit(event,args):
 if event.startswith(('socket.','subprocess.','ctypes.'))or event in ('os.system','os.exec','os.posix_spawn','os.fork','os.forkpty'):raise RuntimeError('forbidden fixture effect:'+event)
sys.addaudithook(effect_audit)
class Controls(unittest.TestCase):
 def profile(self,role='relayer',mode='configmap'):
  command=['/bin/sh','-c']if role=='validator'else['/opt/hyperlane/bin/'+role]
  a={'name':'agent','securityContext':{'runAsNonRoot':True,'runAsUser':10001,'runAsGroup':10001},'command':command}
  if role=='validator':a['args']=['env fixture /opt/hyperlane/bin/validator\n']
  if mode=='configmap':a['volumeMounts']=[{'name':'agent-defaults','mountPath':'/etc/hyperlane','readOnly':True}]
  return {'statefulset':{'spec':{'template':{'spec':{'containers':[a],'securityContext':{'fsGroup':2000},'terminationGracePeriodSeconds':10}}}},'common':{'data':{'HOME':'/var/lib/hyperlane','HYP_DB':'/data/relayer'}},'validator':{}}
 def launch(self):
  o=m.Launch();o.c=SimpleNamespace(checked=Mock(),command=Mock());o.active={'container_id':'a'*64,'docker_stop_client_exit':0};o.removals=[];o.base='base';o.image='base';o.owner_token='owned';return o
 def result(self,code=0,text='',missing=None):return SimpleNamespace(returncode=code,stdout='[]\n'if missing else text,stderr='Error: No such object: '+missing+'\n'if missing else'')
 def test_actual_renderer_decodes_closed_JSON_wrapper(self):
  v=self.profile();text='---\n# Source: fixture\n'+json.dumps({'kind':'ConfigMap','data':{'profile':json.dumps(v)}})+'\n';self.assertEqual(m.decode_profile(text),v)
 def test_wrong_image_paths_UID_mount_or_workdir_refuse(self):
  v=self.profile();m.validate_profile(v,'relayer','configmap')
  for key,value in [('command',['./relayer']),('securityContext',{}),('workingDir','/app'),('volumeMounts',[])]:
   changed=copy.deepcopy(v);changed['statefulset']['spec']['template']['spec']['containers'][0][key]=value
   with self.subTest(key=key),self.assertRaises(AssertionError):m.validate_profile(changed,'relayer','configmap')
 def test_configured_image_rejects_any_defaults_mask(self):
  v=self.profile(mode='configured-image');m.validate_profile(v,'relayer','configured-image')
  v['statefulset']['spec']['template']['spec']['containers'][0]['volumeMounts']=self.profile()['statefulset']['spec']['template']['spec']['containers'][0]['volumeMounts']
  with self.assertRaises(AssertionError):m.validate_profile(v,'relayer','configured-image')
 def test_docker_arguments_are_rendered_commands_env_and_readonly_mounts(self):
  o=self.launch();o.role='relayer';o.mode='configmap';o.agent={'command':['/opt/hyperlane/bin/relayer'],'env':[{'name':'CONFIG_FILES','value':'/relayer-configmap/relayer-config.json,/etc/hyperlane/mainnet_config.json'}]};o.environment={'HOME':'/var/lib/hyperlane'}
  args=o.docker_args('base','owned',Path('/config'),Path('/data'))
  self.assertEqual(args[:2],['docker','create']);self.assertIn('type=bind,src=/config,dst=/etc/hyperlane,readonly',args);self.assertEqual(args[-3:],['--entrypoint','/opt/hyperlane/bin/relayer','base']);self.assertNotIn('--privileged',args);self.assertIn('10001:10001',args)
 def test_exact_created_CID_full_labels_bind_before_start(self):
  o=self.launch();o.c.checked.return_value=self.result(text=json.dumps([{'Id':'sha256:'+'b'*64,'Config':{'Labels':{'inherited':'yes'}}}]))
  v={'Id':'a'*64,'Name':'/own','Image':'sha256:'+'b'*64,'Config':{'Labels':{'inherited':'yes','io.hyperlane.ziggy.helm-fixture':'owned'}}}
  o.c.command.side_effect=[self.result(text='a'*64+'\n'),self.result(text=json.dumps([v]))];o.create(['create'],'own');self.assertEqual(o.active['container_id'],'a'*64)
  for field,value in [('Name','/foreign'),('Image','sha256:'+'c'*64),('Config',{'Labels':{'io.hyperlane.ziggy.helm-fixture':'owned'}})]:
   bad=copy.deepcopy(v);bad[field]=value;o.c.command.side_effect=[self.result(text='a'*64),self.result(text=json.dumps([bad]))]
   with self.assertRaises(AssertionError):o.create(['create'],'own')
 def test_lost_create_reply_records_owned_CID_for_cleanup_but_fails(self):
  o=self.launch();o.c.checked.return_value=self.result(text=json.dumps([{'Id':'sha256:'+'b'*64,'Config':{'Labels':{}}}]))
  v={'Id':'a'*64,'Name':'/own','Image':'sha256:'+'b'*64,'Config':{'Labels':{'io.hyperlane.ziggy.helm-fixture':'owned'}}}
  o.c.command.side_effect=[self.result(code=1,missing='a'*64),self.result(text=json.dumps([v]))]
  with self.assertRaises(AssertionError):o.create(['create'],'own')
  self.assertEqual(o.active['container_id'],'a'*64)
 def test_wait_failure_still_attempts_exact_rm_and_absence(self):
  o=self.launch();calls=[]
  def checked(argv,**kw):
   calls.append(argv)
   if argv[1]=='inspect':return self.result(text=json.dumps([{'Id':'a'*64,'State':{'Running':False,'Status':'exited','ExitCode':0}}]))
   if argv[1]=='wait':raise RuntimeError('injected wait')
   return self.result()
  o.c.checked.side_effect=checked;o.c.command.return_value=self.result(code=1,missing='a'*64)
  with self.assertRaisesRegex(RuntimeError,'injected wait'):o.finish('own')
  self.assertIn(['docker','rm','--force','--volumes','a'*64],calls);self.assertTrue(o.active['owned_container_absent']);self.assertIsNone(o.active.get('docker_wait_client_exit'))
 def test_actual_stop_wait_rm_absence_rows_are_retained(self):
  o=self.launch();o.c.checked.side_effect=[self.result(text=json.dumps([{'Id':'a'*64,'State':{'Running':False,'Status':'exited','ExitCode':0}}])),self.result(text='0\n'),self.result()];o.c.command.return_value=self.result(code=1,missing='a'*64);o.finish('own')
  self.assertEqual(o.active['container_exit_code'],0);self.assertEqual(o.active['docker_wait_client_exit'],0);self.assertEqual(o.active['docker_rm_client_exit'],0);self.assertEqual(o.active['negative_inspect_exit'],1);self.assertTrue(o.active['owned_container_absent'])
 def test_failed_absence_never_claims_success(self):
  o=self.launch();o.c.checked.side_effect=[self.result(text=json.dumps([{'Id':'a'*64,'State':{'Running':False,'Status':'exited','ExitCode':0}}])),self.result(text='0\n'),self.result()];o.c.command.return_value=self.result(code=0)
  with self.assertRaises(AssertionError):o.finish('own')
  self.assertFalse(o.active.get('owned_container_absent',False))
 def test_pg_stop_wait_rm_absence_receipts_are_real_statuses(self):
  c=SimpleNamespace(checked=Mock(),command=Mock());f=m.Factory(c,Path('/repo'),Path('/helm'),'base','configmap',[]);f.postgres={'container_id':'b'*64}
  c.checked.side_effect=[self.result(text=json.dumps([{'Id':'b'*64,'State':{'Running':True,'Status':'running'}}])),self.result(),self.result(text=json.dumps([{'Id':'b'*64,'State':{'Running':False,'ExitCode':0}}])),self.result(text='0\n'),self.result()];c.command.return_value=self.result(code=1,missing='b'*64);f.finish_postgres('unused-name')
  self.assertEqual(f.postgres['docker_stop_client_exit'],0);self.assertEqual(f.postgres['docker_wait_client_exit'],0);self.assertEqual(f.postgres['docker_rm_client_exit'],0);self.assertEqual(f.postgres['negative_inspect_exit'],1);self.assertTrue(f.postgres['owned_container_absent'])
 def test_pg_stop_failure_still_removes_exact_CID(self):
  calls=[]
  def checked(args,**kwargs):
   calls.append(args)
   if args[1]=='stop':raise RuntimeError('stop fault')
   if args[1]=='inspect':return self.result(text=json.dumps([{'Id':'b'*64,'State':{'Running':True,'Status':'running'}}]))
   return self.result()
  c=SimpleNamespace(checked=Mock(side_effect=checked),command=Mock(return_value=self.result(code=1,missing='b'*64)));f=m.Factory(c,Path('/repo'),Path('/helm'),'base','configmap',[]);f.postgres={'container_id':'b'*64}
  with self.assertRaisesRegex(RuntimeError,'stop fault'):f.finish_postgres('unused-name')
  self.assertIn(['docker','rm','--force','--volumes','b'*64],calls);self.assertTrue(f.postgres['owned_container_absent']);self.assertNotIn('docker_wait_client_exit',f.postgres)
 def test_never_started_role_still_removes_CID_without_wait_credit(self):
  o=self.launch();o.c.checked.side_effect=[self.result(text=json.dumps([{'Id':'a'*64,'State':{'Running':False,'Status':'created','ExitCode':0}}])),self.result()];o.c.command.return_value=self.result(code=1,missing='a'*64)
  o.finish('own')
  self.assertTrue(o.active['owned_container_absent']);self.assertNotIn('docker_wait_client_exit',o.active)
 def test_real_rendered_validator_shell_is_preserved_exactly(self):
  v=self.profile('validator');m.validate_profile(v,'validator','configmap');v['statefulset']['spec']['template']['spec']['containers'][0]['args'][0]+='; extra'
  with self.assertRaises(AssertionError):m.validate_profile(v,'validator','configmap')
 def test_Docker_permission_or_transport_error_is_not_absence(self):
  good=SimpleNamespace(returncode=1,stdout='[]\n',stderr='Error response from daemon: No such image: owned:fixture\n');self.assertTrue(m.absent_receipt(good,'owned:fixture')['owned_container_absent'])
  with self.assertRaises(AssertionError):m.absent_receipt(good,'owned:other')
  for text in ('Cannot connect to the Docker daemon','permission denied','Error: No such object: '+'b'*64):
   result=SimpleNamespace(returncode=1,stdout='[]\n',stderr=text)
   with self.assertRaises(AssertionError):m.absent_receipt(result,'a'*64)
 def test_actual_started_observations_bind_full_rendered_command(self):
  o=self.launch();o.role='relayer';o.mode='configmap';o.agent={'command':['/opt/hyperlane/bin/relayer']};o.environment={'HOME':'/var/lib/hyperlane'}
  v={'Id':'a'*64,'State':{'Running':True,'Pid':123},'Config':{'User':'10001:10001','Entrypoint':['/opt/hyperlane/bin/relayer'],'Cmd':[],'Env':['HOME=/var/lib/hyperlane','HYPERLANE_ZIG_DEFAULTS=/etc/hyperlane']},'HostConfig':{'GroupAdd':['2000']},'Mounts':[{'Destination':'/etc/hyperlane','RW':False}]}
  o.c.checked.side_effect=[self.result(text=json.dumps([v])),self.result(),self.result(text='/opt/hyperlane/bin/relayer\n')];o.started('unused');self.assertEqual(o.active['actual_started_pid'],123);self.assertTrue(o.active['readonly_defaults_verified'])
  v['Config']['Cmd']=['foreign'];o.c.checked.side_effect=[self.result(text=json.dumps([v]))]
  with self.assertRaisesRegex(AssertionError,'command'):o.started('unused')
 def test_utility_expected_denial_records_nonzero_and_actual_cleanup(self):
  o=self.launch();o.utilities=[];state={'name':None}
  def command(args,**kwargs):
   if args[1]=='create':state['name']=args[args.index('--name')+1];return self.result(text='c'*64+'\n')
   if args[1]=='inspect'and args[2]==state['name']:return self.result(text=json.dumps([{'Id':'c'*64,'Name':'/'+state['name'],'Image':'sha256:'+'d'*64,'Config':{'Labels':{'io.hyperlane.ziggy.helm-fixture':'owned'}}}]))
   if args[1]=='start':return self.result(code=1)
   return self.result(code=1,missing='c'*64)
  o.c.command.side_effect=command;o.c.checked.side_effect=[self.result(text=json.dumps([{'Id':'sha256:'+'d'*64,'Config':{'Labels':{}}}])),self.result(text=json.dumps([{'Id':'c'*64,'State':{'Running':False,'ExitCode':1}}])),self.result(text='1\n'),self.result()]
  self.assertEqual(o.utility(Path('/owned'),'10001:10001','/bin/sh',['-c','test -w /fixture'],'negative'),1);self.assertEqual(o.utilities[0]['actual_exit_code'],1);self.assertTrue(o.utilities[0]['owned_container_absent'])
 def test_configured_recipe_uses_owned_name_and_rejects_Dockerfile_injection(self):
  text=m.configured_recipe('zig-agents:ci-core');self.assertTrue(text.startswith('FROM zig-agents:ci-core\n'));self.assertNotIn('FROM sha256:',text)
  for bad in ('base\nRUN unexpected','base value','base${unsafe}'):
   with self.assertRaises(AssertionError):m.configured_recipe(bad)
 def test_configured_base_tag_layers_and_runtime_configuration_are_bound(self):
  base={'Id':'sha256:'+'a'*64,'RootFS':{'Layers':['base1','base2']},'Config':{'User':'10001:10001','WorkingDir':'/var/lib/hyperlane','Env':['pinned']}}
  derived={'Id':'sha256:'+'b'*64,'RootFS':{'Layers':['base1','base2','only-data']},'Config':copy.deepcopy(base['Config'])};self.assertTrue(m.configured_lineage(base,derived,copy.deepcopy(base)))
  after=copy.deepcopy(base);after['Id']='sha256:'+'c'*64
  with self.assertRaises(AssertionError):m.configured_lineage(base,derived,after)
  for field in ('rootfs','config'):
   bad=copy.deepcopy(derived)
   if field=='rootfs':bad['RootFS']['Layers'][0]='foreign'
   else:bad['Config']['Env']=['foreign']
   with self.assertRaises(AssertionError):m.configured_lineage(base,bad,base)
 def test_role_create_TimeoutExpired_is_resolved_and_caller_cleans_before_original(self):
  o=self.launch();o.docker_args=Mock(return_value=['docker','create']);original=subprocess.TimeoutExpired(['docker','create'],1);name='ziggy-image-relayer-'+str(os.getpid())+'-0'
  image={'Id':'sha256:'+'b'*64,'Config':{'Labels':{}}};owned={'Id':'a'*64,'Name':'/'+name,'Image':image['Id'],'Config':{'Labels':{'io.hyperlane.ziggy.helm-fixture':'owned'}}}
  def command(args,**kwargs):
   if args[1]=='create':raise original
   if args[2]==name:return self.result(text=json.dumps([owned]))
   return self.result(code=1,missing='a'*64)
  o.c.command.side_effect=command;o.c.checked.side_effect=[self.result(text=json.dumps([image])),self.result(text=json.dumps([{'Id':'a'*64,'State':{'Running':False,'Status':'created'}}])),self.result()]
  checker=m.load_checker();checker.safe_logs=Mock()
  with self.assertRaises(subprocess.TimeoutExpired)as caught:checker.run_role('base','relayer',Path('/config'),Path('/data'),Path('/logs'),[],0,launch=o)
  self.assertIs(caught.exception,original);self.assertTrue(o.active['owned_container_absent']);self.assertIsNone(o.active['docker_wait_client_exit']);self.assertEqual(o.active['create_exception_class'],'TimeoutExpired');self.assertEqual(checker.safe_logs.call_args.args[0],'a'*64)
 def test_utility_create_exception_keeps_original_and_exact_cleanup(self):
  o=self.launch();o.utilities=[];original=subprocess.TimeoutExpired(['docker','create'],1);state={};image={'Id':'sha256:'+'b'*64,'Config':{'Labels':{}}}
  def command(args,**kwargs):
   if args[1]=='create':state['name']=args[args.index('--name')+1];raise original
   if args[2]==state['name']:return self.result(text=json.dumps([{'Id':'c'*64,'Name':'/'+state['name'],'Image':image['Id'],'Config':{'Labels':{'io.hyperlane.ziggy.helm-fixture':'owned'}}}]))
   return self.result(code=1,missing='c'*64)
  o.c.command.side_effect=command;o.c.checked.side_effect=[self.result(text=json.dumps([image])),self.result()]
  with self.assertRaises(subprocess.TimeoutExpired)as caught:o.utility(Path('/owned'),'10001:10001','/bin/rm',['-f','/fixture/test'],'test')
  self.assertIs(caught.exception,original);self.assertTrue(o.utilities[0]['owned_container_absent']);self.assertIsNone(o.utilities[0]['docker_wait_client_exit'])
 def test_PG_run_exception_resolves_and_cleans_without_wait_fiction(self):
  original=subprocess.TimeoutExpired(['docker','run'],1);image={'Id':'sha256:'+'b'*64,'Config':{'Labels':{}}};state={}
  def command(args,**kwargs):
   if args[1]=='run':state['token']=args[args.index('--label')+1].split('=',1)[1];raise original
   if args[2]=='own':return self.result(text=json.dumps([{'Id':'c'*64,'Name':'/own','Image':image['Id'],'Config':{'Labels':{'io.hyperlane.ziggy.helm-fixture':state['token']}}}]))
   return self.result(code=1,missing='c'*64)
  c=SimpleNamespace(POSTGRES_PIN='pinned',command=Mock(side_effect=command),checked=Mock(side_effect=[self.result(text=json.dumps([image])),self.result(text=json.dumps([{'Id':'c'*64,'State':{'Status':'created','Running':False}}])),self.result()]))
  f=m.Factory(c,Path('/repo'),Path('/helm'),'base','configmap',[])
  with self.assertRaises(subprocess.TimeoutExpired)as caught:f.start_postgres(['docker','run','pinned'],'own')
  self.assertIs(caught.exception,original);self.assertTrue(f.postgres['owned_container_absent']);self.assertIsNone(f.postgres['docker_wait_client_exit'])
 def test_create_exception_and_inspect_failure_keep_original_no_foreign_cleanup(self):
  image={'Id':'sha256:'+'b'*64,'Config':{'Labels':{}}};original=subprocess.TimeoutExpired(['docker','create'],1)
  for resolution in (RuntimeError('inspect failed'),self.result(text=json.dumps([{'Id':'a'*64,'Name':'/foreign','Image':image['Id'],'Config':{'Labels':{}}}]))):
   o=self.launch();o.c.checked.return_value=self.result(text=json.dumps([image]));o.c.command.side_effect=[original,resolution]
   with self.assertRaises(subprocess.TimeoutExpired)as caught:o.create(['docker','create'],'own')
   self.assertIs(caught.exception,original);self.assertIsNone(o.active);self.assertFalse(any(call.args[0][1]=='rm'for call in o.c.checked.call_args_list));self.assertEqual(o.c.command.call_count,2)
 def test_optin_data_cleanup_uses_tracked_fixed_CID_utility(self):
  actor=SimpleNamespace(utilities=[],utility=Mock(return_value=0));f=m.Factory(None,Path('/repo'),Path('/helm'),'base','configmap',[]);f.clean_data('relayer',Path('/owned'),actor)
  actor.utility.assert_called_once_with(Path('/owned'),'10001:10001','/bin/rm',['-rf','--','/fixture/relayer','/fixture/validator','/fixture/checkpoints'],'fixed-output-cleanup')
 def test_role_unresolved_or_foreign_create_never_reads_named_logs(self):
  original=subprocess.TimeoutExpired(['docker','create'],1);image={'Id':'sha256:'+'b'*64,'Config':{'Labels':{}}}
  foreign=self.result(text=json.dumps([{'Id':'a'*64,'Name':'/foreign','Image':image['Id'],'Config':{'Labels':{}}}]))
  for resolution in (RuntimeError('inspect failure'),foreign):
   o=self.launch();o.docker_args=Mock(return_value=['docker','create']);o.c.checked.return_value=self.result(text=json.dumps([image]));o.c.command.side_effect=[original,resolution];checker=m.load_checker();checker.safe_logs=Mock()
   with self.assertRaises(subprocess.TimeoutExpired)as caught:checker.run_role('base','relayer',Path('/config'),Path('/data'),Path('/logs'),[],0,launch=o)
   self.assertIs(caught.exception,original);self.assertIsNone(o.active);checker.safe_logs.assert_not_called();self.assertFalse(any(call.args[0][1]=='rm'for call in o.c.checked.call_args_list))
 def test_all_optin_postcreate_operations_use_admitted_CID(self):
  checker=m.load_checker();cid='a'*64;calls=[]
  def checked(args,**kwargs):
   calls.append(args)
   if args[1]=='inspect':return self.result(text=json.dumps([{'State':{'Running':True,'ExitCode':0}}]))
   return self.result()
  checker.checked=Mock(side_effect=checked);checker.safe_logs=Mock();checker.copied_metadata_bytes=Mock(return_value=b'{}')
  def metadata(path,source,reader):reader();return {'sha256':'unchanged'}
  checker.metadata_snapshot=Mock(side_effect=metadata);clock=iter(range(20));checker.time=SimpleNamespace(monotonic=lambda:next(clock),sleep=Mock())
  launch=SimpleNamespace(active={'container_id':cid},grace_seconds=10,docker_args=Mock(return_value=['docker','create']),create=Mock(),start=Mock(),started=Mock(),stopped=Mock(),finish=Mock())
  result=checker.run_role('base','validator',Path('/config'),Path('/data'),Path('/logs'),[],0,'b'*40,launch=launch)
  self.assertEqual(result['exit_code'],0);self.assertTrue(calls);self.assertTrue(all(args[-1]==cid for args in calls));self.assertEqual(checker.copied_metadata_bytes.call_count,2);self.assertTrue(all(call.args==(cid,)for call in checker.copied_metadata_bytes.call_args_list));self.assertEqual(checker.safe_logs.call_args.args[0],cid)
if __name__=='__main__':unittest.main(verbosity=2)
