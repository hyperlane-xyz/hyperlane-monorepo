"""Pure custody controls. No systemd unit or Docker/namespace operation."""
import ast,copy,importlib.util,os,pathlib,selectors,signal,sys,unittest
from unittest import mock
P=pathlib.Path(__file__).resolve().parent;sys.path.insert(0,str(P))
s=importlib.util.spec_from_file_location('docker_delegate',P/'docker_delegate.py');api=importlib.util.module_from_spec(s);s.loader.exec_module(api)
class Tests(unittest.TestCase):
 def spec(self):return {'run_token':'a'*32}
 def row(self):
  unit='ziggy-aleo-docker-probe-'+'a'*32+'.service'
  return {**api.PROPERTIES,'Id':unit,'Description':unit,'User':str(os.getuid()),'Group':str(os.getgid()),'ControlGroup':'/system.slice/'+unit,'InvocationID':'b'*32,'DelegateControllers':'memory pids','LoadState':'loaded','ActiveState':'active','SubState':'running'}
 def test_separate_scope_and_actual_lifetime_properties(self):
  self.assertEqual(api.identity(self.spec()),self.row()['Id']);self.assertEqual(api.MEMORY,768*1024**2);self.assertEqual(api.TASKS,96)
  self.assertEqual(api.owned(self.row(),self.spec()),'b'*32)
  for k,v in [('RuntimeMaxUSec','2min 30s'),('TimeoutStopUSec','15s'),('MemoryMax',str(384*1024**2)),('TasksMax','64'),('DelegateControllers','memory'),('NoNewPrivileges','no'),('MemorySwapMax','max')]:
   row=self.row();row[k]=v
   with self.subTest(k=k),self.assertRaises(ValueError):api.owned(row,self.spec())
 def test_foreign_kernel_unit_or_replaced_invocation_never_owns_cleanup(self):
  for k,v in [('Id','ziggy-aleo-kernel-'+'a'*32+'.service'),('User',str(os.getuid()+1)),('Group',str(os.getgid()+1)),('ControlGroup','/system.slice/foreign.service'),('InvocationID','c'*32)]:
   row=self.row();row[k]=v
   with self.subTest(k=k),self.assertRaises(ValueError):api.owned(row,self.spec(),'b'*32)
 def test_exact_launch_is_unprivileged_payload_not_privileged_namespace(self):
  tools={k:'/usr/bin/'+k for k in ['sudo','systemd-run','systemctl']};spec={**self.spec(),'python':{'path':'/usr/bin/python3.12'}}
  with mock.patch.object(api,'checked',side_effect=lambda x:pathlib.Path(x['path'])):argv=api.launch_argv(spec,tools,{'path':'/owned/spec.json','sha256':'c'*32})
  for part in ['--uid='+str(os.getuid()),'--gid='+str(os.getgid()),'--property=Delegate=memory pids','--property=MemoryMax='+str(768*1024**2),'--property=MemorySwapMax=0','--property=RuntimeMaxSec=390','--property=TimeoutStopSec=90','--property=NoNewPrivileges=yes']:self.assertIn(part,argv)
  self.assertEqual(argv[:3],['/usr/bin/sudo','-n','/usr/bin/systemd-run']);self.assertNotIn('--privileged',argv)
 def test_builtin_EINTR_retry_cannot_swallow_actual_handler_class(self):
  tree=ast.parse((P/'docker_delegate.py').read_text());fn=next(n for n in ast.walk(tree)if isinstance(n,ast.FunctionDef)and n.name=='interrupted');namespace={'TaskInterrupted':api.TaskInterrupted};exec(compile(ast.fix_missing_locations(ast.Module(body=[fn],type_ignores=[])),'<actual source handler>','exec'),namespace)
  selector=selectors.SelectSelector()
  try:
   with mock.patch.object(selector,'_select',side_effect=lambda *a:namespace['interrupted'](signal.SIGTERM,None)):
    with self.assertRaises(api.TaskInterrupted):selector.select(0)
  finally:selector.close()
 def test_probe_and_delegation_have_no_kernel_family_fallback(self):
  text=(P/'docker_delegate.py').read_text();self.assertNotIn('ziggy-aleo-kernel-',text);self.assertNotIn('aleo-linux-kernel-probe-v1',text);self.assertNotIn('import kernel_probe',text)
  with mock.patch.object(api.docker_probe,'approved',side_effect=ValueError('pending authority')):
   with self.assertRaisesRegex(ValueError,'pending'):api.approved({'root_approved':False})
if __name__=='__main__':unittest.main()
