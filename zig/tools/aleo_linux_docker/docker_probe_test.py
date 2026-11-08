"""Socket/process-free control coverage; never native admission."""
import copy,importlib.util,json,pathlib,sys,unittest
from unittest import mock
P=pathlib.Path(__file__).resolve().parent;sys.path.insert(0,str(P))
spec=importlib.util.spec_from_file_location('docker_probe',P/'docker_probe.py');api=importlib.util.module_from_spec(spec);spec.loader.exec_module(api)
class Tests(unittest.TestCase):
 def test_default_pending_authority_refuses_before_native_or_tool_work(self):
  with mock.patch.object(api,'checked',side_effect=AssertionError('unapproved IO')):
   for s in [{},{'schema':1,'root_approved':False,'purpose':api.PURPOSE,'caps':api.CAPS},{'schema':1,'root_approved':True,'purpose':'aleo-linux-kernel-probe-v1','caps':api.CAPS}]:
    with self.subTest(s=s),self.assertRaisesRegex(ValueError,'separate Docker'):api.approved(s)
 def test_profile_does_not_borrow_kernel_limits_or_full_case(self):
  for k,v in [('whole_seconds',150),('whole_seconds',10800),('maximum_container_memory_bytes',6*api.GIB),('child_memory_bytes',384*1024**2),('cleanup_seconds',91)]:
   c=dict(api.CAPS);c[k]=v
   with self.subTest(k=k),self.assertRaises(ValueError):api.approved({'schema':1,'root_approved':True,'purpose':api.PURPOSE,'caps':c})
 def test_all_image_identities_are_full_native_config_ids(self):
  import re
  for row in api.IMAGES.values():self.assertRegex(row['id'],r'^sha256:[0-9a-f]{64}$');self.assertRegex(row['reference'],r'@sha256:[0-9a-f]{64}$');self.assertNotEqual(row['id'].split(':')[-1],row['reference'].split(':')[-1])
 def test_namespace_no_route_is_not_testnet_blackhole_credit(self):
  v=api.route_verdict('Iface Destination Gateway Flags RefCnt Use Metric Mask\n','',True);self.assertTrue(v['no_outside_default_route']);self.assertFalse(v['external_TCP_blackhole_credit'])
 def test_container_link_route_is_allowed_but_outside_default_is_not(self):
  head='Iface Destination Gateway Flags RefCnt Use Metric Mask\n';link='eth0 000011AC 00000000 0001 0 0 0 0000FFFF\n';self.assertTrue(api.route_verdict(head+link,'')['no_outside_default_route'])
  with self.assertRaises(ValueError):api.route_verdict(head+link,'',True)
  with self.assertRaises(ValueError):api.route_verdict(head+'eth0 00000000 010011AC 0003 0 0 0 00000000\n','')
 def test_ipv6_outside_default_and_malformed_routes_reject(self):
  route='0'*32+' 00 '+'0'*32+' 00 '+'0'*32+' 00000000 00000000 00000000 00000001 eth0\n'
  with self.assertRaises(ValueError):api.route_verdict('header\n',route)
  for v in ['wrong\n','eth0 zero\n']:
   with self.assertRaises(ValueError):api.route_verdict('header\n'+v,'')
 def test_no_fake_namespace_peer_in_runtime_gate_construction(self):
  import ast
  tree=ast.parse((P/'docker_probe.py').read_text());calls=[n for n in ast.walk(tree)if isinstance(n,ast.Call)and isinstance(n.func,ast.Name)and n.func.id=='RecordingGate'];self.assertEqual(len(calls),1);self.assertIsInstance(calls[0].args[2],ast.Call);self.assertEqual(calls[0].args[2].func.id,'NamespacePeer')
 def test_kernel_context_cannot_authorize_docker_unit(self):
  c=dict.fromkeys(['unit','invocation','uid','gid','root','root_dev','root_ino','manager_dev','manager_ino','boot_id'],0);c.update(unit='ziggy-aleo-kernel-'+'a'*32+'.service',root='/foreign',invocation='b'*32)
  with self.assertRaisesRegex(ValueError,'Docker-purpose'):api.delegated_parent(c,'a'*32)
 def test_real_create_fault_records_only_after_actual_successful_commit(self):
  instance=api.LostReplyDaemon.__new__(api.LostReplyDaemon);instance.inject=True;instance.committed=None
  with mock.patch.object(api.Daemon,'call',return_value=(500,b'{}')):self.assertEqual(instance.call('POST','/containers/create?name=owned')[0],500);self.assertIsNone(instance.committed)
  with mock.patch.object(api.Daemon,'call',return_value=(201,json.dumps({'Id':'a'*64}).encode())):
   with self.assertRaisesRegex(TimeoutError,'controlled actual'):instance.call('POST','/containers/create?name=owned')
  self.assertEqual(instance.committed,{'cid':'a'*64,'name':'owned'});self.assertFalse(instance.inject)
 def test_node_source_never_imports_sdk_or_proof_or_executes_raw_docker(self):
  text=(P/'docker_probe.mjs').read_text();self.assertNotIn('import(',text);self.assertNotIn('child_process.exec',text);self.assertIn("['-I',c.shim",text);self.assertIn("process.pid,1",text)
 def test_real_failed_child_start_still_attempts_container_cleanup_after_server_failure(self):
  import tempfile,time
  with tempfile.TemporaryDirectory()as temp:
   root=pathlib.Path(temp)/'phase';spec={'run_token':'a'*32,'daemon_id':'fixed','python':{'path':'/usr/bin/python3.12'},'node':{'path':'/pinned/node'},'shim':{'path':str(P/'docker_cli.py')},'docker_socket':'/var/run/docker.sock','docker_api_version':'1.45'}
   lease=mock.Mock();lease.line='0::/owned/probe\n';gate=mock.Mock();gate.cleanup.return_value={'passed':True,'rows':[{'cid':'c'*64,'stopped_removed_absent':True}]}
   server=mock.Mock();server.close_bounded.side_effect=ValueError('controlled server close error');readlink=api.os.readlink
   with mock.patch.object(api,'checked',side_effect=lambda v:pathlib.Path(v['path'])),mock.patch.object(api,'namespace_argv',return_value=['bwrap','--','node','fixed-main']),mock.patch.object(api.os,'readlink',side_effect=lambda v,*a,**kw:'namespace:[owned]'if str(v).startswith('/proc/self/ns/')else readlink(v,*a,**kw)),mock.patch.object(api,'RecordingGate',return_value=gate),mock.patch.object(api,'Server',return_value=server),mock.patch.object(api.threading,'Thread',return_value=mock.Mock()),mock.patch.object(api.subprocess,'Popen',side_effect=ValueError('controlled child-start failure')):
    value=api.phase(spec,root,lease,[1,2],'b'*64,time.monotonic_ns()+30*10**9,'failed-child','postgres',False,[],mock.Mock(),0)
   self.assertFalse(value['passed']);gate.cleanup.assert_called_once();self.assertTrue(value['container_cleanup']['passed']);self.assertIn('gate_server:ValueError',value['cleanup_errors'])
 def test_actual_consensus_table_is_source_full17_not_synthetic_two(self):
  self.assertIn('CONSENSUS_VERSION_HEIGHTS='+','.join(map(str,range(17))),api.PUBLIC_ENV);self.assertNotIn('CONSENSUS_VERSION_HEIGHTS=0,1',api.PUBLIC_ENV)
 def test_rootless_PG_exact_User_tmpfs_and_Leo_full_labels(self):
  import hashlib
  gs={'manifest':{'taskRoot':'/tmp/public-control','domains':[{'name':'aleo_a','port':23030},{'name':'aleo_b','port':23031}],**api.IMAGES},'run_token':'a'*32,'internal_network':'b'*64,'postgres_command':['postgres'],'public_node_env':api.PUBLIC_ENV}
  after=api.container_templates(gs,1)
  # Intentional full-label Source successor, exact fixed public fixture; no private before tree.
  expected=('8e5f627f4430ee536fc4eed1878fccba' '4a49df7d175c70f3371f9e43e654857a')
  self.assertEqual(hashlib.sha256(json.dumps(after[:2],sort_keys=True,separators=(',',':')).encode()).hexdigest(),expected);pg=after[2];self.assertEqual(pg['create_body']['User'],'999:999');self.assertEqual(pg['create_body']['HostConfig']['Tmpfs'],{'/var/lib/postgresql/data':'rw,noexec,nosuid,size=2147483648,uid=999,gid=999'})
  gate=api.Gate.__new__(api.Gate);row={'Config':{'User':'999:999'},'HostConfig':copy.deepcopy(pg['create_body']['HostConfig'])};gate.caps(row,pg)
  for value in ['0','postgres','1000:999','999:1000',None]:
   wrong=copy.deepcopy(row);wrong['Config']['User']=value
   with self.subTest(user=value),self.assertRaises(ValueError):gate.caps(wrong,pg)
  for key,value in [('Privileged',True),('CapDrop',[]),('SecurityOpt',[]),('Tmpfs',{'/var/lib/postgresql/data':'rw,size=2147483648'})]:
   wrong=copy.deepcopy(row);wrong['HostConfig'][key]=value
   with self.subTest(key=key),self.assertRaises(ValueError):gate.caps(wrong,pg)
 def test_unstarted_bridge_never_calls_unbounded_shutdown(self):
  import time
  bridge=mock.Mock();bridge.thread.ident=None;bridge.thread.is_alive.return_value=False
  value=api.close_bridge_bounded(bridge,time.monotonic_ns()+10**9);self.assertTrue(value['drain_thread_joined']);self.assertFalse(value['server_started']);bridge.close.assert_not_called();bridge.server.server_close.assert_called_once()
 def test_blocked_private_drain_is_bounded_and_never_gets_join_credit(self):
  import time,threading
  entered=threading.Event();release=threading.Event();captured=[];real=threading.Thread;bridge=mock.Mock();bridge.thread.ident=None;bridge.thread.is_alive.return_value=False
  def blocked():entered.set();release.wait(1)
  bridge.server.server_close.side_effect=blocked
  def factory(*a,**k):t=real(*a,**k);captured.append(t);return t
  try:
   with mock.patch.object(api.threading,'Thread',side_effect=factory):
    with self.assertRaisesRegex(ValueError,'drain failed'):api.close_bridge_bounded(bridge,time.monotonic_ns()+20*10**6)
   self.assertTrue(entered.wait(.1))
  finally:
   release.set()
   for t in captured:t.join(.2);self.assertFalse(t.is_alive())
 def test_exact_captured_source_ignores_valid_stale_bytecode_and_rejects_foreign_same_path(self):
  import hashlib,os,py_compile,tempfile,types
  import sibling_imports
  with tempfile.TemporaryDirectory()as temp:
   path=pathlib.Path(temp).resolve()/'public_fixture.py';path.write_text('answer=1\n');stamp=path.stat().st_mtime;py_compile.compile(str(path),doraise=True)
   path.write_text('answer=2\n');os.utime(path,(stamp,stamp));name='exact_source_control';digest=hashlib.sha256(path.read_bytes()).hexdigest()
   try:
    value=sibling_imports.load_exact_source(path,digest,name);self.assertEqual(value.answer,2);self.assertIs(sibling_imports.load_exact_source(path,digest,name),value)
    alien=types.ModuleType(name);alien.__file__=str(path);sys.modules[name]=alien
    with self.assertRaisesRegex(ValueError,'foreign preloaded'):sibling_imports.load_exact_source(path,digest,name)
   finally:sys.modules.pop(name,None);sibling_imports._OWNED.pop(name,None)
 def test_hash_and_execution_use_same_captured_bytes_for_stage_owner(self):
  import hashlib,tempfile
  import sibling_imports
  with tempfile.TemporaryDirectory()as temp:
   path=pathlib.Path(temp).resolve()/'owner.py';raw=b'answer=3\n';path.write_bytes(raw);original=pathlib.Path.read_bytes;name='stage_capture_control'
   def read(p):
    value=original(p)
    if p==path:p.write_bytes(b'answer=4\n')
    return value
   try:
    with mock.patch.object(pathlib.Path,'read_bytes',read):value=sibling_imports.load_exact_source(path,hashlib.sha256(raw).hexdigest(),name)
    self.assertEqual(value.answer,3)
   finally:sys.modules.pop(name,None);sibling_imports._OWNED.pop(name,None)
 def test_real_CLI_header_executes_checked_source_not_valid_stale_PYC(self):
  import ast,hashlib,os,py_compile,tempfile,types
  tree=ast.parse((P.parent/'aleo_linux_sdk/docker_cli.py').read_text());function=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='_reviewed_module');ns={'hashlib':hashlib,'Path':pathlib.Path,'types':types,'sys':sys};exec(compile(ast.Module(body=[function],type_ignores=[]),'<actual CLI header>','exec'),ns)
  with tempfile.TemporaryDirectory()as temp:
   path=pathlib.Path(temp).resolve()/'checked.py';path.write_text('answer=1\n');stamp=path.stat().st_mtime;py_compile.compile(str(path),doraise=True);path.write_text('answer=2\n');os.utime(path,(stamp,stamp));name='cli_exact_source_control'
   try:
    self.assertEqual(ns['_reviewed_module'](name,path,hashlib.sha256(path.read_bytes()).hexdigest()).answer,2)
    with self.assertRaisesRegex(ValueError,'foreign preloaded'):ns['_reviewed_module'](name,path,hashlib.sha256(path.read_bytes()).hexdigest())
   finally:sys.modules.pop(name,None)
 def test_signal_failure_still_waits_actual_child_and_closes_pidfd(self):
  import time
  child=mock.Mock(pid=123);child.poll.return_value=None;child.wait.return_value=0;result={'passed':True};lease=mock.Mock()
  with mock.patch.object(api.signal,'pidfd_send_signal',side_effect=ProcessLookupError,create=True),mock.patch.object(api.os,'close')as close:
   api.stop_child_bounded(child,777,lease,[],result,time.monotonic_ns()+10**9)
  child.wait.assert_called_once();close.assert_called_once_with(777);self.assertTrue(result['direct_wait']['actual_parent_wait']);self.assertFalse(result['passed']);lease.write.assert_not_called()
 def test_signal_and_wait_errors_never_skip_fdclose_or_invent_wait_credit(self):
  import time
  child=mock.Mock(pid=123);child.poll.return_value=None;child.wait.side_effect=ValueError('controlled wait error');result={'passed':True};lease=mock.Mock();lease.write.side_effect=ValueError('controlled kill error')
  with mock.patch.object(api.signal,'pidfd_send_signal',side_effect=ProcessLookupError,create=True),mock.patch.object(api.os,'close')as close:
   api.stop_child_bounded(child,777,lease,[],result,time.monotonic_ns()+10**9)
  self.assertEqual(child.wait.call_count,2);close.assert_called_once_with(777);self.assertNotIn('direct_wait',result);self.assertFalse(result['passed']);lease.write.assert_called_once_with('cgroup.kill','1')
 def test_stage_final_latepositive_is_not_passed(self):
  import ast,time
  tree=ast.parse((P/'docker_probe_stage.py').read_text());function=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='require_original_deadline');ns={'time':time,'need':api.need};exec(compile(ast.Module(body=[function],type_ignores=[]),'<actual staging deadline>','exec'),ns)
  with mock.patch.object(time,'monotonic_ns',return_value=100):
   ns['require_original_deadline'](101)
   for expired in (99,100):
    with self.assertRaisesRegex(ValueError,'original staging deadline'):ns['require_original_deadline'](expired)
  run=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='run');calls=[n for n in ast.walk(run)if isinstance(n,ast.Call)and isinstance(n.func,ast.Name)and n.func.id=='require_original_deadline'];self.assertEqual(len(calls),1)
 def test_each_direct_new_entry_refuses_own_stale_cache_before_local_import(self):
  import ast,tempfile
  for name in ('docker_probe.py','docker_delegate.py','docker_probe_stage.py','docker_probe_bind.py'):
   tree=ast.parse((P/name).read_text());guard=next(n for n in tree.body if isinstance(n,ast.For)and isinstance(n.target,ast.Name)and n.target.id=='source_dir')
   with tempfile.TemporaryDirectory()as temp:
    here=pathlib.Path(temp).resolve()/'aleo_linux_docker';here.mkdir();(here/'__pycache__').mkdir();(here/'__pycache__/sibling_imports.cpython-public.pyc').write_bytes(b'public stale cache')
    with self.subTest(entry=name),self.assertRaisesRegex(ValueError,'cached local bytecode'):exec(compile(ast.Module(body=[guard],type_ignores=[]),name,'exec'),{'HERE':here})
 def label_fixture(self):
  gs={'manifest':{'taskRoot':'/tmp/public-label-control','domains':[{'name':'aleo_a','port':23030},{'name':'aleo_b','port':23031}],**api.IMAGES},'run_token':'a'*32,'internal_network':'b'*64,'postgres_command':['postgres'],'public_node_env':api.PUBLIC_ENV}
  selected=api.container_templates(gs,1)[0];return gs,selected
 def test_exact_pinned_image_labels_are_full_create_and_owned_labels(self):
  import docker_gate
  gs,selected=self.label_fixture();self.assertEqual(selected['labels']['org.opencontainers.image.version'],'22.04');self.assertEqual(selected['create_body']['Labels'],selected['labels'])
  image={'Id':selected['image'],'Config':{'Labels':{'org.opencontainers.image.version':'22.04'}}};docker_gate.verify_inherited_image_labels(image,selected)
  for labels in [{},{'org.opencontainers.image.version':'24.04'},{'org.opencontainers.image.version':'22.04','foreign':'extra'}]:
   with self.subTest(labels=labels),self.assertRaises(ValueError):docker_gate.verify_inherited_image_labels({'Id':selected['image'],'Config':{'Labels':labels}},selected)
  with self.assertRaises(ValueError):docker_gate.inherited_image_labels('sha256:'+'c'*64)
 def test_full_inherited_labels_cleanup_created_container_without_subset_waiver(self):
  import time
  gs,selected=self.label_fixture();cid='c'*64;row={'Id':cid,'Name':'/'+selected['name'],'Image':selected['image'],'Config':{'Labels':dict(selected['labels'])},'State':{'Running':False}};calls=[]
  class Daemon:
   deadline_ns=time.monotonic_ns()+10**9
   removed=False
   def call(self,method,path,body=None,maximum=None):
    calls.append((method,path))
    if method=='GET':return (404,b'')if self.removed else(200,json.dumps(row).encode())
    if method=='DELETE':self.removed=True;return 204,b''
    raise AssertionError('unapproved model call')
  daemon=Daemon();gate=api.Gate(gs,daemon,None);gate.containers[cid]=selected;gate.failed='earlier actual health failure';result=gate.cleanup();self.assertTrue(result['passed']);self.assertTrue(result['rows'][0]['stopped_removed_absent']);self.assertEqual([m for m,p in calls],['GET','DELETE','GET'])
 def test_changed_or_extra_full_label_foreign_container_is_never_removed(self):
  import time
  gs,selected=self.label_fixture();cid='c'*64
  for change in [lambda r:r['Config']['Labels'].update(extra='foreign'),lambda r:r['Config']['Labels'].pop('org.opencontainers.image.version'),lambda r:r.update(Image='sha256:'+'d'*64),lambda r:r.update(Name='/foreign'),lambda r:r.update(Id='e'*64)]:
   row={'Id':cid,'Name':'/'+selected['name'],'Image':selected['image'],'Config':{'Labels':dict(selected['labels'])},'State':{'Running':False}};change(row);calls=[]
   class Daemon:
    deadline_ns=time.monotonic_ns()+10**9
    def call(self,method,path,body=None,maximum=None):calls.append(method);return 200,json.dumps(row).encode()
   gate=api.Gate(gs,Daemon(),None);gate.containers[cid]=selected;value=gate.cleanup();self.assertFalse(value['passed']);self.assertEqual(calls,['GET']);self.assertFalse(value['rows'][0]['stopped_removed_absent'])
 def test_actual_create_branch_rejects_unproven_image_label_map_before_create(self):
  import time
  gs,selected=self.label_fixture();gs['original_deadline_ns']=time.monotonic_ns()+10**9;calls=[]
  class Daemon:
   def call(self,method,path,body=None,maximum=None):
    calls.append((method,path))
    if path.startswith('/containers/'):return 404,b''
    if path.startswith('/images/'):return 200,json.dumps({'Id':selected['image'],'RepoDigests':[selected['reference']],'Os':'linux','Architecture':'amd64','Config':{'Labels':{},'Volumes':None}}).encode()
    raise AssertionError('create must not happen with unproven labels')
  gate=api.Gate(gs,Daemon(),lambda pid:{'namespace_pids':[1]})
  with self.assertRaisesRegex(ValueError,'Exact immutable image inherited labels'):gate._dispatch('POST','/containers/create?name='+selected['name'],json.dumps(selected['create_body']).encode(),1)
  self.assertEqual(gate.attempted,{});self.assertTrue(all(method=='GET'for method,path in calls))
 def test_lost_create_recovery_uses_exact_full_inherited_labels(self):
  import time
  gs,selected=self.label_fixture();cid='c'*64;row={'Id':cid,'Name':'/'+selected['name'],'Image':selected['image'],'Config':{'Labels':dict(selected['labels'])},'State':{'Running':False}}
  class Daemon:
   deadline_ns=time.monotonic_ns()+10**9
   removed=False
   def call(self,method,path,body=None,maximum=None):
    if method=='DELETE':self.removed=True;return 204,b''
    return (404,b'')if self.removed else(200,json.dumps(row).encode())
  gate=api.Gate(gs,Daemon(),None);gate.attempted[selected['name']]=selected;value=gate.cleanup();self.assertTrue(value['passed']);self.assertEqual(list(gate.containers),[cid]);self.assertTrue(value['rows'][0]['stopped_removed_absent'])
if __name__=='__main__':unittest.main()
