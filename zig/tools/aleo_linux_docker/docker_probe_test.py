"""Socket/process-free control coverage; never native admission."""
import copy,importlib.util,json,os,pathlib,sys,unittest
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
   with mock.patch.object(api,'checked',side_effect=lambda v:pathlib.Path(v['path'])),mock.patch.object(api,'namespace_argv',return_value=['bwrap','--','node','fixed-main']),mock.patch.object(api.os,'readlink',side_effect=lambda v,*a,**kw:'namespace:[owned]'if str(v).startswith('/proc/self/ns/')else readlink(v,*a,**kw)),mock.patch.object(api,'RecordingGate',return_value=gate)as gate_factory,mock.patch.object(api.time,'monotonic_ns',return_value=200*10**9),mock.patch.object(api,'Server',return_value=server),mock.patch.object(api.threading,'Thread',return_value=mock.Mock()),mock.patch.object(api.subprocess,'Popen',side_effect=ValueError('controlled child-start failure')):
    value=api.phase(spec,root,lease,[1,2],'b'*64,190*10**9,'failed-child','postgres',False,[],mock.Mock(),0)
   self.assertFalse(value['passed']);gate.cleanup.assert_called_once();self.assertTrue(value['container_cleanup']['passed']);self.assertIn('gate_server:ValueError',value['cleanup_errors'])
   self.assertEqual(gate_factory.call_args.args[1].deadline_ns,280*10**9)  # Original190+90, NOT now200+90.

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
  import time
  gs['original_deadline_ns']=time.monotonic_ns()+10**9
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
   def call(self,method,path,body=None,maximum=None,cleanup_deadline_ns=None):
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
    def call(self,method,path,body=None,maximum=None,cleanup_deadline_ns=None):calls.append(method);return 200,json.dumps(row).encode()
   gate=api.Gate(gs,Daemon(),None);gate.containers[cid]=selected;value=gate.cleanup();self.assertFalse(value['passed']);self.assertEqual(calls,['GET']);self.assertFalse(value['rows'][0]['stopped_removed_absent'])
 def test_actual_create_branch_rejects_unproven_image_label_map_before_create(self):
  import time
  gs,selected=self.label_fixture();gs['original_deadline_ns']=time.monotonic_ns()+10**9;calls=[]
  class Daemon:
   def call(self,method,path,body=None,maximum=None,cleanup_deadline_ns=None):
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
   def call(self,method,path,body=None,maximum=None,cleanup_deadline_ns=None):
    if method=='DELETE':self.removed=True;return 204,b''
    return (404,b'')if self.removed else(200,json.dumps(row).encode())
  gate=api.Gate(gs,Daemon(),None);gate.attempted[selected['name']]=selected;value=gate.cleanup();self.assertTrue(value['passed']);self.assertEqual(list(gate.containers),[cid]);self.assertTrue(value['rows'][0]['stopped_removed_absent'])
 def test_stop10_cleanup_margin_is_bounded_and_never_changes_execution_budget(self):
  import docker_gate
  with mock.patch.object(docker_gate.time,'monotonic_ns',return_value=10**9):
   route='/containers/'+'c'*64+'/stop?t=10'
   self.assertEqual(docker_gate.daemon_request_deadline(100*10**9,'POST',route),13*10**9)
   self.assertEqual(docker_gate.daemon_request_deadline(100*10**9,'POST',route,100*10**9),13*10**9)
   self.assertEqual(docker_gate.daemon_request_deadline(100*10**9,'POST',route,2*10**9),2*10**9)
   for method,path in [('GET',route),('POST',route.replace('t=10','t=11')),('DELETE','/containers/'+'c'*64+'?v=1')]:self.assertEqual(docker_gate.daemon_request_deadline(100*10**9,method,path,100*10**9),11*10**9)
   for end in [10**9,101*10**9,None]:
    if end is not None:
     with self.assertRaises(ValueError):docker_gate.daemon_request_deadline(100*10**9,'POST',route,end)
 def test_actual_bounded_call_exposes_margin_only_during_explicit_caller_cleanup(self):
  from types import SimpleNamespace
  daemon=mock.Mock(deadline_ns=100);daemon.call.return_value=(204,b'');gate=api.Gate({'original_deadline_ns':10},daemon,None)
  gate.bounded_call('POST','/containers/'+'c'*64+'/stop?t=10');self.assertNotIn('cleanup_deadline_ns',daemon.call.call_args.kwargs)
  gate.cleaning=True;gate.bounded_call('POST','/containers/'+'c'*64+'/stop?t=10');self.assertEqual(daemon.call.call_args.kwargs['cleanup_deadline_ns'],100)
  # Full-case caller already owns120s after its direct cleanup; shared Gate
  # must not impose Docker-prerequisite's separate90s profile budget.
  daemon.deadline_ns=10+120*10**9;daemon.call.reset_mock();gate.bounded_call('GET','/containers/'+'c'*64+'/json')
  self.assertEqual(daemon.call.call_args.kwargs['cleanup_deadline_ns'],10+120*10**9)
 def test_actual_Gate_crossprofile_remaining_cleanup_deadlines_and_stop_margin(self):
  import docker_gate
  class Transport:
   def __init__(self,end):self.deadline_ns=end;self.observed=[]
   def call(self,method,path,body=None,maximum=None,cleanup_deadline_ns=None):
    self.observed.append(docker_gate.daemon_request_deadline(self.deadline_ns,method,path,cleanup_deadline_ns));return 204,b''
  for end in [100*10**9,130*10**9]:
   daemon=Transport(end);gate=api.Gate({'original_deadline_ns':10*10**9},daemon,None);route='/containers/'+'c'*64+'/stop?t=10'
   with mock.patch.object(docker_gate.time,'monotonic_ns',return_value=20*10**9):
    gate.bounded_call('POST',route);self.assertEqual(daemon.observed[-1],32*10**9)
    gate.cleaning=True;gate.bounded_call('POST',route);self.assertEqual(daemon.observed[-1],32*10**9)
    gate.bounded_call('GET',route);self.assertEqual(daemon.observed[-1],30*10**9)
    daemon.deadline_ns=21*10**9;gate.bounded_call('POST',route);self.assertEqual(daemon.observed[-1],21*10**9)

 def test_failed_phase_retains_closed_owned_State_kernel_and_no_raw_messages(self):
  import tempfile,time
  state={'Status':'running','Running':True,'Pid':123,'ExitCode':0,'OOMKilled':False,'StartedAt':'2026-11-08T00:00:00Z','FinishedAt':'0001-01-01T00:00:00Z','private':'DO-NOT-EXPORT-STATE'};gs={'original_deadline_ns':time.monotonic_ns()+10**9};daemon=mock.Mock(deadline_ns=gs['original_deadline_ns'],committed=None);gate=api.Gate(gs,daemon,None);gate.containers={'c'*64:{}};gate.owned=mock.Mock(return_value={'State':state});gate.actual_kernel=[{'cid':'c'*64,'actual_NoNewPrivs':'1'}];gate.failed='ValueError:DO-NOT-EXPORT-ERROR';result={}
  with tempfile.TemporaryDirectory()as temp:
   root=pathlib.Path(temp);(root/'node.stderr').write_text('DO-NOT-EXPORT-STDERR');api.retain_failure_state(result,gate,root)
  encoded=json.dumps(result);self.assertNotIn('DO-NOT-EXPORT',encoded);self.assertEqual(result['actual_kernel'],gate.actual_kernel);row=result['owned_container_State'][0];self.assertTrue(row['full_owned_identity_verified']);self.assertEqual(set(row['State']),{'Status','Running','Pid','ExitCode','OOMKilled','StartedAt','FinishedAt'});self.assertEqual(result['latched_API_failure']['type'],'ValueError');self.assertIn('node_stderr_fingerprint',result)
 def test_state_metadata_error_keeps_prior_identity_without_publishing_nested_values(self):
  gate=mock.Mock();gate.containers={'c'*64:{}};gate.owned.return_value={'State':{'Status':{'private':'DO-NOT-EXPORT'},'Running':True,'Pid':1,'ExitCode':0,'OOMKilled':False,'StartedAt':'0','FinishedAt':'0'}};rows=api.owned_state_snapshot(gate);self.assertTrue(rows[0]['full_owned_identity_verified']);self.assertNotIn('State',rows[0]);self.assertNotIn('DO-NOT-EXPORT',json.dumps(rows));gate.owned.side_effect=ValueError('DO-NOT-EXPORT');rows=api.owned_state_snapshot(gate);self.assertFalse(rows[0]['full_owned_identity_verified']);self.assertNotIn('DO-NOT-EXPORT',json.dumps(rows))
class OwnedEndpointControls(unittest.TestCase):
 def setUp(self):
  import copy,time,os
  from contextlib import contextmanager
  self.g=__import__('docker_gate');self.bridge=__import__('loopback_bridge');self.cid='c'*64;self.net='a'*64;self.token='b'*32
  self.spec={'original_deadline_ns':100*10**9,'internal_network':self.net,'run_token':self.token,'actual_case_cgroup_line':'0::/owned\n','manifest':{'taskRoot':'/owned/task','domains':[{'name':'aleo_a','port':23030},{'name':'aleo_b','port':23031}],**api.IMAGES},'public_node_env':api.PUBLIC_ENV,'postgres_command':['postgres']}
  self.selected=next(x for x in api.container_templates(self.spec,1)if x['kind']=='aleo_a');self.endpoint={'NetworkID':self.net,'EndpointID':'d'*64,'IPAddress':'172.18.0.2','IPPrefixLen':16};self.row={'Id':self.cid,'Name':'/'+self.selected['name'],'Image':self.selected['image'],'Config':{'Labels':self.selected['labels'],'Cmd':self.selected['create_body']['Cmd']},'State':{'Running':True,'Pid':123},'HostConfig':self.selected['create_body']['HostConfig'],'NetworkSettings':{'Networks':{'ziggy-aleo-net-'+self.token:self.endpoint},'Ports':{'3030/tcp':None}}}
  self.network={'Id':self.net,'Name':'ziggy-aleo-net-'+self.token,'Labels':{'ziggy.aleo.run-token':self.token},'Internal':True,'Driver':'bridge','Attachable':False,'EnableIPv6':False,'Containers':{self.cid:{'Name':self.selected['name'],'EndpointID':'d'*64,'IPv4Address':'172.18.0.2/16'}},'IPAM':{'Config':[{'Subnet':'172.18.0.0/16'}]}}
  parent=self
  class Daemon:
   deadline_ns=100*10**9
   @contextmanager
   def operation(self,end):yield
   def call(self,method,path,body=None,maximum=None,cleanup_deadline_ns=None):
    if path=='/containers/'+parent.cid+'/json':return 200,json.dumps(parent.row).encode()
    if path=='/networks/'+parent.net:return 200,json.dumps(parent.network).encode()
    if path=='/version':return 200,json.dumps({'Version':'28.5.2','ApiVersion':'1.51','MinAPIVersion':'1.24','Os':'linux','Arch':'amd64','private':'DROP'}).encode()
    raise AssertionError('foreign route')
  self.gate=self.g.Gate(self.spec,Daemon(),None);self.gate.containers[self.cid]=self.selected;self.gate.node_identity={'pid':77,'start':33,'namespace_pids':[77,1],'exe':'/pinned/node','group':77}
  self.node={**self.gate.node_identity,'uid':os.getuid(),'state':'S','cgroup':self.spec['actual_case_cgroup_line']}
  patches=[mock.patch.object(self.g.time,'monotonic_ns',return_value=10**9),mock.patch.object(self.g,'proc_identity',side_effect=lambda pid:dict(self.node)),mock.patch.object(self.g.Gate,'kernel_caps',return_value={'pid':123,'start':'22','actual_kernel_caps_checked':True}),mock.patch.object(self.g.Gate,'endpoint_witness',side_effect=lambda anchor:{'authority':anchor,'listeners':{'tcp':{'available':True,'rows':[]}}})]
  for patch in patches:patch.start();self.addCleanup(patch.stop)
 def actual_handler_soft_condition(self,error,callback=True):
  import ast
  tree=ast.parse((P.parent/'aleo_linux/loopback_bridge.py').read_text());conditions=[n.test for n in ast.walk(tree)if isinstance(n,ast.If)and 'OwnedBackendRefused' in ast.unparse(n.test)]
  self.assertEqual(len(conditions),1)
  return eval(compile(ast.Expression(conditions[0]),'<actual Handler refusal condition>','eval'),{'host':True,'other':object(),'target_lease':object()if callback else None,'error':error,'ConnectionRefusedError':ConnectionRefusedError,'OwnedBackendRefused':self.bridge.OwnedBackendRefused,'isinstance':isinstance})
 def test_authority_API_enter_refusal_is_hard_not_a_validated_backend_refusal(self):
  sock=mock.Mock()
  with mock.patch.object(self.gate.daemon,'call',side_effect=ConnectionRefusedError('PRIVATE-DAEMON-ENTER')):
   with self.assertRaises(ConnectionRefusedError)as caught:self.bridge.connect_target(sock,True,23030,'/fixed',('127.0.0.1',23030),lambda:self.gate.endpoint_lease(23030),100*10**9)
  self.assertNotIsInstance(caught.exception,self.bridge.OwnedBackendRefused);self.assertFalse(self.actual_handler_soft_condition(caught.exception));self.assertTrue(self.gate.failed.startswith('OwnedEndpoint:'));sock.connect.assert_not_called()
 def test_authority_API_postvalidation_refusal_is_hard_even_after_real_connect_return(self):
  connected=[];original=self.gate.daemon.call
  def call(*args,**kwargs):
   if connected:raise ConnectionRefusedError('PRIVATE-DAEMON-POST')
   return original(*args,**kwargs)
  sock=mock.Mock();sock.connect.side_effect=lambda unused:connected.append(True)
  with mock.patch.object(self.gate.daemon,'call',side_effect=call):
   with self.assertRaises(ConnectionRefusedError)as caught:self.bridge.connect_target(sock,True,23030,'/fixed',('127.0.0.1',23030),lambda:self.gate.endpoint_lease(23030),100*10**9)
  self.assertNotIsInstance(caught.exception,self.bridge.OwnedBackendRefused);self.assertFalse(self.actual_handler_soft_condition(caught.exception));self.assertTrue(self.gate.failed.startswith('OwnedEndpoint:'));self.assertEqual(self.gate.endpoint_observations[23030]['connect_returned'],0);self.assertEqual(self.gate.endpoint_observations[23030]['connect_refused'],0)
 def test_nonrefusal_connect_failure_preserves_primary_error_and_latches_hard(self):
  sock=mock.Mock();sock.connect.side_effect=TimeoutError('PRIVATE-CONNECT-TIMEOUT')
  with self.assertRaises(TimeoutError)as caught:self.bridge.connect_target(sock,True,23030,'/fixed',('127.0.0.1',23030),lambda:self.gate.endpoint_lease(23030),100*10**9)
  self.assertFalse(self.actual_handler_soft_condition(caught.exception));self.assertTrue(self.gate.failed.startswith('OwnedEndpoint:'));self.assertEqual(self.gate.endpoint_observations[23030]['connect_returned'],0)
 def test_ONLY_actual_connect_refusal_after_successful_full_postvalidation_is_soft(self):
  sock=mock.Mock();sock.connect.side_effect=ConnectionRefusedError('PRIVATE-BACKEND')
  with self.assertRaises(self.bridge.OwnedBackendRefused)as caught:self.bridge.connect_target(sock,True,23030,'/fixed',('127.0.0.1',23030),lambda:self.gate.endpoint_lease(23030),100*10**9)
  self.assertTrue(self.actual_handler_soft_condition(caught.exception));self.assertTrue(self.actual_handler_soft_condition(ConnectionRefusedError(),callback=False));self.assertIsNone(self.gate.failed);self.assertEqual(self.gate.endpoint_observations[23030]['connect_refused'],1);self.assertEqual(self.gate.endpoint_observations[23030]['connect_returned'],0);sock.connect.assert_called_once_with(('172.18.0.2',3030))
 def test_exact_internal_endpoint_not_unavailable_host_publisher_and_lease_connect_scope(self):
  held=[];gate=self.gate
  class Socket:
   def settimeout(self,value):self.timeout=value
   def connect(self,target):
    held.append(gate.lock._is_owned());self.target=target
  sock=Socket();self.bridge.connect_target(sock,True,23030,'/fixed.sock',('127.0.0.1',23030),lambda:gate.endpoint_lease(23030),100*10**9)
  self.assertEqual(sock.target,('172.18.0.2',3030));self.assertEqual(held,[True]);self.assertFalse(gate.lock._is_owned());self.assertEqual(gate.endpoint_observations[23030]['connect_returned'],1)
  self.assertIsNone(gate.endpoint_observations[23030]['first']['authority']['actual_published_ports'])
 def test_crossed_CID_network_IPAM_IP_and_caps_reject_before_connect(self):
  import copy
  variants=[('foreignCID',lambda:self.row.__setitem__('Id','f'*64)),('foreignNetwork',lambda:self.endpoint.__setitem__('NetworkID','f'*64)),('outsideIP',lambda:self.endpoint.__setitem__('IPAddress','8.8.8.8')),('crossedIPAM',lambda:self.network['Containers'][self.cid].__setitem__('IPv4Address','172.18.0.3/16')),('caps',lambda:self.row['HostConfig'].__setitem__('Privileged',True))]
  original=copy.deepcopy((self.row,self.network))
  for name,mutate in variants:
   with self.subTest(name=name):
    mutate();sock=mock.Mock()
    with self.assertRaises(ValueError):self.bridge.connect_target(sock,True,23030,'/fixed',('127.0.0.1',23030),lambda:self.gate.endpoint_lease(23030),100*10**9)
    sock.connect.assert_not_called();self.row,self.network=copy.deepcopy(original);self.endpoint=self.row['NetworkSettings']['Networks']['ziggy-aleo-net-'+self.token];self.gate.failed=None
 def test_postconnect_endpoint_or_main_Node_change_and_cancel_never_get_credit(self):
  import threading,copy
  cases=[lambda:(self.endpoint.__setitem__('EndpointID','e'*64),self.network['Containers'][self.cid].__setitem__('EndpointID','e'*64)),lambda:self.node.__setitem__('start',34)]
  for mutate in cases:
   with self.subTest(change=mutate):
    with self.assertRaises(ValueError):
     with self.gate.endpoint_lease(23030)as lease:lease['connect_result']='connected';mutate()
    self.assertEqual(self.gate.endpoint_observations[23030]['connect_returned'],0)
    self.endpoint['EndpointID']='d'*64;self.network['Containers'][self.cid]['EndpointID']='d'*64;self.node['start']=33;self.gate.failed=None
  cancel=threading.Event()
  with self.assertRaises(ValueError):
   with self.gate.endpoint_lease(23030,cancel)as lease:lease['connect_result']='connected';cancel.set()
  self.assertEqual(self.gate.endpoint_observations[23030]['connect_returned'],0)
 def test_native_PID_birth_change_after_connect_rejects(self):
  with self.assertRaises(ValueError):
   with self.gate.endpoint_lease(23030)as lease:
    lease['connect_result']='connected'
    self.g.Gate.kernel_caps.return_value={'pid':123,'start':'23','actual_kernel_caps_checked':True}
  self.assertEqual(self.gate.endpoint_observations[23030]['connect_returned'],0)
 def test_late_postconnect_witness_never_increments_validated_connect_counter(self):
  calls=[]
  def witness(anchor):
   calls.append(1)
   if len(calls)==2:self.g.time.monotonic_ns.configure_mock(return_value=20*10**9)
   return {'authority':anchor}
  with mock.patch.object(self.g.Gate,'endpoint_witness',side_effect=witness):
   with self.assertRaisesRegex(ValueError,'witness completed late'):
    with self.gate.endpoint_lease(23030)as lease:lease['connect_result']='connected'
  self.assertEqual(self.gate.endpoint_observations[23030]['connect_returned'],0)
 def test_unknown_port_and_forwarder_is_not_confused_with_main_Node(self):
  with self.assertRaises(ValueError):
   with self.gate.endpoint_lease(9999):pass
  self.gate.failed=None
  with self.assertRaises(ValueError):self.gate.bridge_main_node_peer(66,os.getuid())
  self.gate.bridge_main_node_peer(77,os.getuid())
  # Fullcase validates its Python forwarder separately; lease validates saved Node.
  with self.gate.endpoint_lease(23030)as lease:lease['connect_result']='connected'
 def test_host_false_callback_foreign_target_and_late_connect_reject(self):
  from contextlib import contextmanager
  @contextmanager
  def target(address='172.18.0.2',port=3030):yield {'target':(address,port),'deadline_ns':2*10**9,'connect_result':None}
  for host,lease in [(False,target),(True,lambda:target('8.8.8.8')),(True,lambda:target(port=5432))]:
   sock=mock.Mock()
   with self.assertRaises(ValueError):self.bridge.connect_target(sock,host,23030,'/fixed',('127.0.0.1',23030),lease,100*10**9)
   sock.connect.assert_not_called()
  sock=mock.Mock();sock.connect.side_effect=lambda unused:self.g.time.monotonic_ns.configure_mock(return_value=3*10**9)
  with self.assertRaises(ValueError):self.bridge.connect_target(sock,True,23030,'/fixed',('127.0.0.1',23030),target,100*10**9)
 def test_default_bridge_destination_and_closed_actual_version_unchanged(self):
  sock=mock.Mock();self.bridge.connect_target(sock,True,23030,'/fixed',('127.0.0.1',23030),None,100*10**9);sock.connect.assert_called_once_with(('127.0.0.1',23030))
  self.assertEqual(set(self.gate.engine_version()),{'Version','ApiVersion','MinAPIVersion','Os','Arch'})


 def test_PG_old_publisher_negative_and_owned_backend_positive_are_separate(self):
  import threading,errno
  self.selected=next(x for x in api.container_templates(self.spec,1)if x['kind']=='postgres');self.gate.containers[self.cid]=self.selected
  self.row.update(Name='/'+self.selected['name'],Image=self.selected['image'],Config={'Labels':self.selected['labels'],'Cmd':self.selected['create_body']['Cmd'],'User':'999:999'},HostConfig=self.selected['create_body']['HostConfig']);self.row['NetworkSettings']['Ports']={'5432/tcp':None};self.network['Containers'][self.cid]['Name']=self.selected['name']
  events=[];parent=self
  class Connection:
   def __init__(self,publisher):self.publisher=publisher
   def __enter__(self):return self
   def __exit__(self,*args):events.append(('closed',self.publisher))
   def settimeout(self,value):pass
   def connect(self,target):
    events.append(('connect',target))
    if self.publisher:raise ConnectionRefusedError(errno.ECONNREFUSED,'PRIVATE-NOT-PUBLISHED')
    parent.assertTrue(parent.gate.lock._is_owned());parent.assertEqual(target,('172.18.0.2',5432))
  with mock.patch.object(api.socket,'socket',side_effect=[Connection(True),Connection(False)]):result=api.postgres_transport_witness(self.gate,threading.Event(),100*10**9)
  self.assertFalse(result['requested_host_TCP']['connected']);self.assertTrue(result['owned_backend_TCP_connected']);self.assertFalse(result['native_SQL_or_parent_wait_credit']);self.assertNotIn('PRIVATE',json.dumps(result));self.assertEqual(sum(x[0]=='connect'for x in events),2)
 def test_listener_projection_only_fixed_LISTEN_and_namespace_availability_no_private_dump(self):
  import tempfile
  with tempfile.TemporaryDirectory()as temp:
   root=pathlib.Path(temp);(root/'net').mkdir();(root/'stat').write_text('123 (leo) S '+'0 '*18+'22\n')
   header='sl local_address rem_address st tx_queue tr tm retr uid timeout inode\n'
   (root/'net/tcp').write_text(header+'0: 00000000:0BD6 00000000:0000 0A 0:0 0:0 0 999 0 77\n'+'1: DEADBEEF:01BB 00000000:0000 0A 0:0 0:0 0 999 0 88\n')
   (root/'net/tcp6').write_text(header)
   original=pathlib.Path
   with mock.patch.object(self.g,'Path',side_effect=lambda value:root if str(value)=='/proc'else original(value)),mock.patch.object(self.g.os,'readlink',side_effect=PermissionError('PRIVATE-NAMESPACE')):
    # Actual method normally maps /proc/<PID>; keep fixed synthetic PID subdir.
    native=root/'123';native.mkdir();(native/'net').mkdir()
    for name in ['tcp','tcp6']:(native/'net'/name).write_bytes((root/'net'/name).read_bytes())
    (native/'stat').write_bytes((root/'stat').read_bytes())
    actual=self.g.Gate.endpoint_witness.__wrapped__ if hasattr(self.g.Gate.endpoint_witness,'__wrapped__')else None
    self.assertIsNone(actual)
    # The class method is temporarily mocked for authority tests; recover exact
    # captured source AST for this standalone diagnostic control.
    import ast
    tree=ast.parse((P.parent/'aleo_linux_sdk/docker_gate.py').read_text());method=next(n for n in next(n for n in tree.body if isinstance(n,ast.ClassDef)and n.name=='Gate').body if isinstance(n,ast.FunctionDef)and n.name=='endpoint_witness');space=dict(vars(self.g));exec(compile(ast.Module(body=[method],type_ignores=[]),'<actual fixed listener projector>','exec'),space)
    result=space['endpoint_witness'](self.gate,{'pid':123,'birth':'22','inside_port':3030})
    self.assertEqual(result['listeners']['tcp']['rows'],[{'local_address_hex':'00000000','port':3030,'state':'LISTEN','uid':999,'inode':77}]);self.assertFalse(result['net_namespace']['available']);self.assertNotIn('PRIVATE',json.dumps(result));self.assertNotIn('DEADBEEF',json.dumps(result))
    (native/'stat').write_text('123 (leo) S '+'0 '*18+'23\n')
    with self.assertRaises(ValueError):space['endpoint_witness'](self.gate,{'pid':123,'birth':'22','inside_port':3030})
 def test_policy_failure_is_latched_before_owner_lock_release(self):
  import threading
  original=threading.RLock();seen=[];gate=self.gate
  class Lock:
   def acquire(self,**kwargs):return original.acquire(**kwargs)
   def release(self):seen.append(gate.failed);original.release()
  gate.lock=Lock()
  with self.assertRaises(ValueError):
   with gate.endpoint_lease(23030)as lease:lease['connect_result']='connected';self.node['start']=34
  self.assertEqual(len(seen),1);self.assertTrue(seen[0].startswith('OwnedEndpoint:'))
 def test_gate_lock_blocks_foreign_mutation_until_connect_lease_released(self):
  import threading
  attempts=[]
  def other():
   acquired=self.gate.lock.acquire(blocking=False);attempts.append(acquired)
   if acquired:self.gate.lock.release()
  with self.gate.endpoint_lease(23030)as lease:
   lease['connect_result']='connected'
   worker=threading.Thread(target=other);worker.start();worker.join(1);self.assertFalse(worker.is_alive());self.assertEqual(attempts,[False])
  worker=threading.Thread(target=other);worker.start();worker.join(1);self.assertFalse(worker.is_alive());self.assertEqual(attempts,[False,True])
 def test_endpoint_callbacks_are_not_new_namespace_Docker_API_routes(self):
  import ast
  before=(P.parent/'aleo_linux_sdk/docker_gate.py').read_text()
  function=next(n for n in next(n for n in ast.parse(before).body if isinstance(n,ast.ClassDef)and n.name=='Gate').body if isinstance(n,ast.FunctionDef)and n.name=='_dispatch')
  self.assertNotIn('endpoint_lease',ast.unparse(function));self.assertNotIn('endpoint_anchor',ast.unparse(function))


class PGBarrierControls(unittest.TestCase):
 def test_actual_parent_publication_is_atomic_closed_case_phase_CID_bound(self):
  import tempfile
  with tempfile.TemporaryDirectory()as temp:
   root=pathlib.Path(temp);(root/'readonly').mkdir();witness={'cid':'c'*64,'owned_backend_TCP_connected':True};result=api.publish_postgres_barrier(root,'postgres','d'*64,witness,api.time.monotonic_ns()+10**9)
   self.assertEqual(json.loads(pathlib.Path(result['path']).read_text()),{'schema':1,'phase':'postgres','case':'d'*64,'cid':'c'*64,'passed':True});self.assertFalse((root/'readonly/PG-host-receipt.tmp').exists())
   with self.assertRaises(ValueError):api.publish_postgres_barrier(root,'postgres','d'*64,witness,api.time.monotonic_ns()+10**9)
 def test_missing_backend_foreign_CID_and_expired_publication_never_write_ack(self):
  import tempfile
  for witness,deadline in [({'cid':'c'*64,'owned_backend_TCP_connected':False},10**20),({'cid':'foreign','owned_backend_TCP_connected':True},10**20),({'cid':'c'*64,'owned_backend_TCP_connected':True},0)]:
   with tempfile.TemporaryDirectory()as temp:
    root=pathlib.Path(temp);(root/'readonly').mkdir()
    with self.assertRaises(ValueError):api.publish_postgres_barrier(root,'postgres','d'*64,witness,deadline)
    self.assertFalse((root/'readonly/PG-host-receipt.json').exists())
 def test_source_Node_barrier_is_before_stop_and_uses_readonly_case_CID_bound_receipt(self):
  node=(P/'docker_probe.mjs').read_text();start=node.index("progress('postgres.ready')");stop=node.index("docker(['stop'",start);self.assertLess(start,stop)
  for text in ['receipt.phase,c.phase','receipt.case,c.manifest_digest','receipt.cid,cid','receipt.passed,true',"while(!fs.existsSync(c.PG_host_receipt)){check();"]:self.assertIn(text,node[start:stop])
  source=(P/'docker_probe.py').read_text();self.assertIn("'PG_host_receipt':str(root/'readonly/PG-host-receipt.json')",source);self.assertIn("'--ro-bind',str(root/'readonly'),str(root/'readonly')",source)

class NamespacePGPortControls(unittest.TestCase):
 def setUp(self):
  import tempfile,ast,types,re
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=pathlib.Path(self.tmp.name).resolve();task=self.root/'task';task.mkdir()
  self.policy={'manifest':{'taskRoot':str(task),'domains':[{'name':'aleo_a','port':23030},{'name':'aleo_b','port':23031}],**api.IMAGES},'manifest_digest':'d'*64,'run_token':'b'*32,'internal_network':'a'*64,'public_node_env':api.PUBLIC_ENV,'postgres_command':['postgres'],'gate_socket':str(self.root/'cap/docker.sock')}
  (task/'owner.json').write_text(json.dumps({'marker':'ziggy-aleo-owned-v1','pid':1,'manifest':self.policy['manifest_digest']}));self.selected=next(x for x in api.container_templates(self.policy,1)if x['kind']=='postgres');self.cid='c'*64
  self.row={'Id':self.cid,'Name':'/'+self.selected['name'],'Image':self.selected['image'],'Config':{'Labels':self.selected['labels'],'User':'999:999','Cmd':['postgres'],'private':'DO-NOT-EXPORT'},'HostConfig':self.selected['create_body']['HostConfig'],'NetworkSettings':{'Ports':{'5432/tcp':None},'Networks':{'ziggy-aleo-net-'+'b'*32:{'NetworkID':'a'*64}}}}
  source=(P.parent/'aleo_linux_sdk/docker_cli.py').read_text();tree=ast.parse(source);function=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='run');self.calls=[]
  def call(policy,method,path,body=None):self.calls.append((method,path));return json.dumps(self.row).encode()
  space={'decode':api.decode,'need':api.need,'Path':pathlib.Path,'os':os,'re':re,'container_templates':api.container_templates,'call':call};exec(compile(ast.Module(body=[function],type_ignores=[]),'<actual namespace PG CLI port>','exec'),space);self.run_cli=space['run']
 def call(self,command=None):
  endpoint='unix://'+self.policy['gate_socket'];environment={'DOCKER_HOST':endpoint,'DOCKER_CONFIG':str(pathlib.Path(self.policy['manifest']['taskRoot'])/'docker-cli')}
  with mock.patch.object(os,'getppid',return_value=1),mock.patch.dict(os.environ,environment):return self.run_cli(self.policy,['--host',endpoint,*(command or['port',self.cid,'5432/tcp'])])
 def test_absent_publisher_reports_namespace_contract_only_and_keeps_actual_inspect_data(self):
  original=copy.deepcopy(self.row)
  self.assertEqual(self.call(),(b'127.0.0.1:25432\n',b'',0));self.assertEqual(self.row,original);self.assertEqual(self.calls,[('GET','/containers/'+self.cid+'/json')])
 def test_exact_legacy_publisher_also_preserved_and_other_mapping_forms_reject(self):
  for ports in [None,{}, {'5432/tcp':[]},{'5432/tcp':[{'HostIp':'127.0.0.1','HostPort':'25432'}]}]:
   self.row['NetworkSettings']['Ports']=ports;self.assertEqual(self.call()[0],b'127.0.0.1:25432\n')
  for ports in [{'3030/tcp':None},{'5432/tcp':[{'HostIp':'0.0.0.0','HostPort':'25432'}]},{'5432/tcp':[{'HostIp':'127.0.0.1','HostPort':'25433'}]},{'5432/tcp':[{'HostIp':'127.0.0.1','HostPort':'25432'}]*2}]:
   self.row['NetworkSettings']['Ports']=ports
   with self.assertRaises(ValueError):self.call()
 def test_foreign_CID_image_labels_requested_binding_or_network_reject(self):
  initial=copy.deepcopy(self.row)
  mutations=[lambda:self.row.__setitem__('Id','f'*64),lambda:self.row.__setitem__('Name','/foreign'),lambda:self.row.__setitem__('Image',api.IMAGES['image']['id']),lambda:self.row['Config'].__setitem__('Labels',{}),lambda:self.row['Config'].__setitem__('User','0'),lambda:self.row['Config'].__setitem__('Cmd',['sh']),lambda:self.row['HostConfig'].__setitem__('NetworkMode','foreign'),lambda:self.row['HostConfig'].__setitem__('PortBindings',{'5432/tcp':[{'HostIp':'0.0.0.0','HostPort':'25432'}]}),lambda:self.row['NetworkSettings'].__setitem__('Networks',{'foreign':{'NetworkID':'a'*64}}),lambda:self.row['NetworkSettings']['Networks']['ziggy-aleo-net-'+'b'*32].__setitem__('NetworkID','f'*64)]
  for mutate in mutations:
   mutate()
   with self.assertRaises(ValueError):self.call()
   self.row=copy.deepcopy(initial)
 def test_other_kind_port_or_nonfullCID_has_no_general_port_emulation(self):
  for command in [['port',self.cid,'3030/tcp'],['port','foreign-name','5432/tcp']]:
   with self.assertRaises(ValueError):self.call(command)
  self.assertEqual(self.calls,[])


class ExactStopReplyMarginTests(unittest.TestCase):
 def setUp(self):
  import docker_gate
  self.gate=docker_gate;self.route='/containers/'+'c'*64+'/stop?t=10';self.clock=[1_000_000_000]
  patch=mock.patch.object(docker_gate.time,'monotonic_ns',side_effect=lambda:self.clock[0]);patch.start();self.addCleanup(patch.stop)
 def budget(self):
  import threading
  value=self.gate.WholeSocket.__new__(self.gate.WholeSocket);value.deadline_ns=11*10**9;value.socket=mock.Mock();value.expired=threading.Event();value.timer=mock.Mock();value.timer.is_alive.return_value=False;return value
 def test_exact_stop_margin_only_and_original_case_clamp(self):
  for method,path,body in [('GET',self.route,None),('POST',self.route+'x',None),('POST',self.route.replace('t=10','t=11'),None),('POST','/containers/foreign/stop?t=10',None),('POST',self.route,b'null'),('POST',self.route,b'{}'),('POST',self.route,b' '),('POST','/info',None)]:
   self.assertEqual(self.gate.request_reply_deadline(100*10**9,1*10**9,method,path,body),11*10**9)
  self.assertEqual(self.gate.request_reply_deadline(100*10**9,1*10**9,'POST',self.route,b''),13*10**9)
  self.assertEqual(self.gate.daemon_request_deadline(100*10**9,'POST',self.route,body=b'{}'),11*10**9)
  self.assertEqual(self.gate.request_reply_deadline(12*10**9,1*10**9,'POST',self.route),12*10**9)
  self.assertEqual(self.gate.request_reply_deadline(10*10**9,1*10**9,'POST',self.route),10*10**9)
 def test_same_socket_handoff_cancels_joins_then_rearms_never_reopens(self):
  value=self.budget();old=value.timer;order=[];old.cancel.side_effect=lambda:order.append('cancel');old.join.side_effect=lambda n:order.append('join');replacement=mock.Mock();replacement.start.side_effect=lambda:order.append('start')
  self.clock[0]=10*10**9
  with mock.patch.object(self.gate.threading,'Timer',return_value=replacement)as timers:value.exact_stop_reply_margin(13*10**9)
  self.assertEqual(order,['cancel','join','start']);self.assertEqual(value.deadline_ns,13*10**9);self.assertIs(value.timer,replacement);value.socket.close.assert_not_called();value.socket.shutdown.assert_not_called();self.assertEqual(timers.call_args.args[0],3)
 def test_expired_old_timer_cannot_be_reset_or_socket_reopened(self):
  value=self.budget();old=value.timer;old.join.side_effect=lambda n:value.expired.set()
  with mock.patch.object(self.gate.threading,'Timer')as timers:
   with self.assertRaisesRegex(ValueError,'deadline expired'):value.exact_stop_reply_margin(13*10**9)
  timers.assert_not_called();value.socket.close.assert_called_once();self.assertTrue(value.expired.is_set());self.assertEqual(value.deadline_ns,11*10**9)
 def test_timer_cancel_race_crossing_original_ingress10_is_not_response_credit(self):
  value=self.budget();value.timer.join.side_effect=lambda n:self.clock.__setitem__(0,11*10**9)
  with mock.patch.object(self.gate.threading,'Timer')as timers:
   with self.assertRaisesRegex(ValueError,'deadline expired'):value.exact_stop_reply_margin(13*10**9)
  timers.assert_not_called();value.socket.close.assert_called_once()
 def test_unjoined_old_timer_never_rearms(self):
  value=self.budget();value.timer.is_alive.return_value=True
  with mock.patch.object(self.gate.threading,'Timer')as timers:
   with self.assertRaisesRegex(ValueError,'did not join'):value.exact_stop_reply_margin(13*10**9)
  timers.assert_not_called();value.socket.close.assert_called_once()
 def test_late_header_or_body_cannot_borrow_reply_margin(self):
  for now in [11*10**9,12*10**9,13*10**9]:
   value=self.budget();self.clock[0]=now
   with mock.patch.object(self.gate.threading,'Timer')as timers:
    with self.assertRaisesRegex(ValueError,'deadline expired'):value.exact_stop_reply_margin(13*10**9)
   timers.assert_not_called()
 def test_handoff_cannot_add_more_than2_or_remove_original_case_fence(self):
  for end in [14*10**9,10*10**9,True]:
   value=self.budget()
   with self.assertRaises(ValueError):value.exact_stop_reply_margin(end)
   value.timer.cancel.assert_not_called()
 def test_handoff_same_case_clamped_deadline_does_not_restart_timer(self):
  value=self.budget();value.exact_stop_reply_margin(11*10**9);value.timer.cancel.assert_not_called();self.assertEqual(value.deadline_ns,11*10**9)
 def test_same_request_cannot_repeat_handoff_to_gain_another2seconds(self):
  value=self.budget();value.exact_stop_reply_margin(11*10**9)
  with self.assertRaisesRegex(ValueError,'only one'):
   value.exact_stop_reply_margin(13*10**9)
  self.assertEqual(value.deadline_ns,11*10**9);value.timer.cancel.assert_not_called()
 def test_Handler_uses_original_entry_not_late_framing_time(self):
  import io,struct,types
  seen=[];route=self.route;clock=self.clock;g=self.gate
  class Request:
   def getsockopt(self,*args):return struct.pack('3i',42,1001,117)
   def makefile(self,*args):
    clock[0]=9*10**9
    return io.BytesIO(('POST '+route+' HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: 0\r\n\r\n').encode())
   def sendall(self,wire):seen.append(('reply',wire[:12]))
  class Budget:
   def __init__(self,end,request):self.deadline_ns=end;seen.append(('ingress',end))
   def __enter__(self):return self
   def __exit__(self,*a):pass
   def check(self):g.need(clock[0]<self.deadline_ns,'whole socket deadline expired')
   def exact_stop_reply_margin(self,end):self.check();seen.append(('handoff',end));self.deadline_ns=end
  gate=mock.Mock(spec=['spec','dispatch','failed']);gate.spec={'original_deadline_ns':100*10**9};gate.failed=None
  def dispatch(method,path,body,pid,end):seen.append(('dispatch',end));clock[0]=12*10**9;return 204,b''
  gate.dispatch.side_effect=dispatch
  with mock.patch.object(g,'WholeSocket',Budget),mock.patch.object(g.socket,'SO_PEERCRED',17,create=True):g.Handler.handle(types.SimpleNamespace(server=types.SimpleNamespace(gate=gate),request=Request()))
  self.assertEqual(seen[:3],[('ingress',11*10**9),('handoff',13*10**9),('dispatch',13*10**9)]);self.assertEqual(seen[-1][0],'reply');self.assertIsNone(gate.failed)
 def test_actual_Handler_trickle_past_ingress_deadline_never_dispatches(self):
  import io,struct,types
  clock=self.clock;g=self.gate;route=self.route
  class Stream(io.BytesIO):
   def read(self,n=-1):clock[0]+=10**9;return super().read(n)
  request=mock.Mock();request.getsockopt.return_value=struct.pack('3i',42,1001,117);request.makefile.return_value=Stream(('POST '+route+' HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: 0\r\n\r\n').encode())
  class Budget:
   def __init__(self,end,*a):self.deadline_ns=end
   def __enter__(self):return self
   def __exit__(self,*a):pass
   def check(self):g.need(clock[0]<self.deadline_ns,'whole socket deadline expired')
   def exact_stop_reply_margin(self,end):raise AssertionError('late ingress must not rearm')
  gate=mock.Mock(spec=['spec','dispatch','failed']);gate.spec={'original_deadline_ns':1000*10**9};gate.failed=None
  with mock.patch.object(g,'WholeSocket',Budget),mock.patch.object(g.socket,'SO_PEERCRED',17,create=True):g.Handler.handle(types.SimpleNamespace(server=types.SimpleNamespace(gate=gate),request=request))
  gate.dispatch.assert_not_called();request.sendall.assert_not_called();self.assertIn('deadline expired',gate.failed)
 def test_actual_Gate_keeps_Handler_absolute_fence_instead_of_hop_reset(self):
  from contextlib import contextmanager
  import threading
  observed=[]
  class Daemon:
   @contextmanager
   def operation(self,end):observed.append(end);yield
  value=self.gate.Gate({'original_deadline_ns':100*10**9},Daemon(),None);value._dispatch=mock.Mock(return_value=(204,b''));self.clock[0]=2*10**9
  self.assertEqual(value.dispatch('POST',self.route,b'',42,13*10**9),(204,b''));self.assertEqual(observed,[13*10**9])
  self.clock[0]=14*10**9
  with self.assertRaisesRegex(ValueError,'gate lock deadline'):value.dispatch('POST',self.route,b'',42,13*10**9)
 def test_actual_Daemon_call_clamps_stop12_to_threadlocal_Handler_fence(self):
  import stat,types
  g=self.gate;daemon=g.Daemon('/fixed/socket',[1,2],'1.48',100*10**9);captured=[]
  class Budget:
   def __init__(self,end,*a):captured.append(end);self.socket=mock.Mock()
   def __enter__(self):return self
   def __exit__(self,*args):pass
   def check(self):pass
  reply=mock.Mock();reply.status=204;reply.read.return_value=b''
  self.clock[0]=2*10**9
  class Connection:
   def __init__(self,*args,**kwargs):pass
   def request(self,*a,**kw):self.connect()
   def getresponse(self):return reply
   def close(self):pass
  with mock.patch.object(g.os,'stat',return_value=types.SimpleNamespace(st_mode=stat.S_IFSOCK,st_dev=1,st_ino=2)),mock.patch.object(g,'WholeSocket',Budget),mock.patch.object(g.http.client,'HTTPConnection',Connection),daemon.operation(13*10**9):
   self.assertEqual(daemon.call('POST',self.route),(204,b''))
  self.assertEqual(captured,[13*10**9])
 def test_actual_CLI_call_uses_earlier_start12_and_rejects_late_positive(self):
  import ast,types
  path=P.parent/'aleo_linux_sdk/docker_cli.py';tree=ast.parse(path.read_text());function=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='call');clock=self.clock;captured=[];g=self.gate;finish=[12*10**9]
  class Budget:
   def __init__(self,end,*a):captured.append(end);self.deadline_ns=end;self.socket=mock.Mock()
   def __enter__(self):return self
   def __exit__(self,*a):pass
   def check(self):g.need(clock[0]<self.deadline_ns,'whole socket deadline expired')
  class Reply:
   status=204
   def read(self,*a):clock[0]=finish[0];return b''
   def close(self):pass
  class Connection:
   def __init__(self,*args,**kwargs):pass
   def putrequest(self,*a,**kw):self.connect()
   def putheader(self,*a):pass
   def endheaders(self,*a):pass
   def getresponse(self):return Reply()
   def close(self):pass
  ns={'WholeSocket':Budget,'request_reply_deadline':g.request_reply_deadline,'time':g.time,'http':types.SimpleNamespace(client=types.SimpleNamespace(HTTPConnection=Connection)),'need':g.need,'json':json}
  exec(compile(ast.Module(body=[function],type_ignores=[]),str(path),'exec'),ns)
  policy={'original_deadline_ns':100*10**9,'gate_socket':'/owned/fake'}
  self.assertEqual(ns['call'](policy,'POST',self.route),b'');self.assertEqual(captured,[13*10**9])
  self.clock[0]=1*10**9;finish[0]=13*10**9
  with self.assertRaisesRegex(ValueError,'deadline expired'):ns['call'](policy,'POST',self.route)
  self.clock[0]=1*10**9;finish[0]=11*10**9
  with self.assertRaisesRegex(ValueError,'deadline expired'):ns['call'](policy,'GET','/info')
  self.assertEqual(captured[-1],11*10**9)

 def test_unknown_CID_remains_rejected_before_any_daemon_stop(self):
  from contextlib import contextmanager
  class Daemon:
   @contextmanager
   def operation(self,end):yield
   def call(self,*args,**kwargs):raise AssertionError('unknown CID reached daemon')
  value=self.gate.Gate({'original_deadline_ns':100*10**9},Daemon(),lambda _: {'pid':1});value.node_identity={'pid':1};value.spec['containers']=[]
  with self.assertRaisesRegex(ValueError,'unowned CID'):value.dispatch('POST',self.route,b'',42,13*10**9)
  self.assertIn('unowned CID',value.failed)

if __name__=='__main__':unittest.main()
