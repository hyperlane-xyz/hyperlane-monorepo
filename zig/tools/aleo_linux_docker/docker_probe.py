"""Explicit real native Docker micro-prerequisite; importing performs no IO."""
import argparse,ctypes,hashlib,json,os,platform,re,signal,socket,stat,subprocess,sys,threading,time
from pathlib import Path
HERE=Path(__file__).resolve().parent
for source_dir in (HERE,HERE.parent/'aleo_linux',HERE.parent/'aleo_linux_sdk'):
 if(source_dir/'__pycache__').exists()or(source_dir/'__pycache__').is_symlink():raise ValueError('Docker profile forbids cached local bytecode')
sys.path.insert(0,str(HERE))
from sibling_imports import load_shared,SHARED,SDK,CLI_SHA
load_shared()
from receipts import checked,decode,load,need
from docker_gate import Daemon,Gate,NamespacePeer,NetworkLease,Server,container_templates,proc_identity,inherited_image_labels
from loopback_bridge import FixedServer
GIB=1024**3;MIB=1024**2
PURPOSE='aleo-linux-native-docker-probe-v1'
CAPS={'whole_seconds':300,'cleanup_seconds':90,'child_memory_bytes':512*MIB,'owner_memory_bytes':256*MIB,'pids':64,'maximum_container_memory_bytes':3*GIB,'new_disk_bytes':4*GIB,'free_floor_bytes':6*GIB}
IMAGES={'image':{'reference':'gcr.io/abacus-labs-dev/hyperlane-aleo-tools@sha256:'+'441e92f73a1ac75b0d17ad477efa9586'+'58585c0f7de3d5840830292a7d37cd92','id':'sha256:'+'af2bdda6ccb9461b6ba7f69320f8e355'+'b07b0442bb500afc3e7c3a434a233068'},'postgresImage':{'reference':'postgres@sha256:'+'a4a139181ce9290fbc5a16973ef1931f'+'3e1dfb491ccaf2407a992a3557cf71ea','id':'sha256:'+'47b95c5ad45838febbc39cae4194b6f9'+'c3f6c3d7409b20043e8cea4a5bd70fec'}}
PUBLIC_ENV=['NETWORK=testnet','PRIVATE_KEY=APrivateKey1zkp8CZNn3yeCseEtxuVPbDCwSyhGW6yZKUYKfgXmcpoGPWH','ENDPOINT=http://0.0.0.0:3030','CONSENSUS_VERSION_HEIGHTS=0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16','CREATE_BLOCK=true']
def pin(p):
 p=Path(p).resolve(strict=True);raw=p.read_bytes();return {'path':str(p),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
def write(p,value):
 with Path(p).open('xb')as f:f.write((json.dumps(value,sort_keys=True,indent=2)+'\n').encode());f.flush();os.fsync(f.fileno())
 return pin(p)
def free(p):v=os.statvfs(p);return v.f_bavail*v.f_frsize
def approved(s):
 need(s.get('schema')==1 and s.get('root_approved')is True and s.get('purpose')==PURPOSE and s.get('caps')==CAPS,'explicit separate Docker probe authority required')
 need(s.get('images')==IMAGES and s.get('public_node_env')==PUBLIC_ENV,'exact native images/public fixtures required')
 need(type(s.get('run_token'))is str and re.fullmatch('[0-9a-f]{32}',s['run_token']),'fresh token required')
 need(type(s.get('pins'))is list and 0<len(s['pins'])<=40 and len({row['path']for row in s['pins']})==len(s['pins']),'bounded unique exact Source pins required')
 for row in s['pins']:checked(row)
 need(all(s[k]in s['pins']for k in ('python','node','bwrap','shim','node_main'))and pin(__file__)in s['pins'],'exact code/tool pins required')
 need(checked(s['python'])==Path('/usr/bin/python3.12')and checked(s['shim'])==SDK/'docker_cli.py'and s['shim']['sha256']==CLI_SHA and checked(s['node_main'])==HERE/'docker_probe.mjs','actual real shim and fixed main Source required')
 required={str(HERE/n)for n in ('docker_probe.py','docker_probe.mjs','sibling_imports.py')}|{str(SHARED/n)for n in ('receipts.py','loopback_bridge.py')}|{str(SDK/n)for n in ('docker_gate.py','docker_cli.py')}
 need(required<={row['path']for row in s['pins']},'complete exact Gate/peer/shim/bridge Source closure required')
 need(set(s['readonly_roots'])=={str(HERE),str(SHARED),str(SDK),str(checked(s['node']).parent)},'closed readonly Source/Node roots required')
 need(s['docker_socket']=='/var/run/docker.sock'and re.fullmatch(r'1\.[0-9]{2}',s['docker_api_version']),'fixed native Docker API required')
 kernel=validate_kernel(load(s['kernel_receipt']),Path('/proc/sys/kernel/random/boot_id').read_text().strip(),platform.release(),time.monotonic_ns())
 kernel_owner=load(s['kernel_owner_receipt']);need(kernel_owner['passed']is True and kernel_owner['kernel_result']==s['kernel_receipt']and kernel_owner['client_actual_wait']['actual_parent_wait']is True and kernel_owner['client_actual_wait']['exit_code']==0 and kernel_owner['cleanup']['owned_cgroup_absent']is True,'actual successful same-boot kernel owner/cleanup required')
 need(kernel['spec']in s['pins']and kernel_owner['original_spec']in s['pins'],'actual original/delegated kernel specs pinned')
 kernel_spec=load(kernel['spec']);need(kernel_spec['python']==s['python']and kernel_spec['bwrap']==s['bwrap']and kernel_spec['root_approved']is True and kernel_spec['purpose']=='aleo-linux-kernel-probe-v1','same actual kernel tools/authority required')
 need(s['kernel_receipt']in s['pins']and s['kernel_owner_receipt']in s['pins'],'immutable actual kernel receipt pins required')
 stage=load(s['stage_receipt']);need(stage['spec']in s['pins'],'actual original provision spec pinned');need(s['stage_receipt']in s['pins']and stage.get('kind')=='aleo-linux-native-docker-stage-v1'and stage.get('passed')is True and stage.get('source_unchanged')is True and stage.get('node')==s['node'],'actual matching provision receipt required')
 need(stage['native_engine']=={'id':s['daemon_id'],'filesystem':s['docker_filesystem']},'actual staged Engine identity differs')
 need(set(stage['images'])==set(IMAGES)and all(stage['images'][key]['id']==v['id']and stage['images'][key]['reference']==v['reference']for key,v in IMAGES.items()),'actual staged native image closure differs')
 expected={'node-version','native-engine-info','image-pull','image-inspect','postgresImage-pull','postgresImage-inspect'}
 need(len(stage['commands'])==len(expected)and {r['name']for r in stage['commands']}==expected,'exact provision phases required')
 for row in stage['commands']:
  need(row['actual_parent_wait']is True and row['exit_code']==0 and row['cleanup']['clean']is True,'actual provision command wait missing');checked(row['log']);need(row['log']in s['pins'],'immutable actual provision log pin required')
 return s

def validate_kernel(row,boot,kernel,now):
    need(row.get('kind')=='aleo-linux-kernel-prerequisite-v1'and row.get('schema')==1 and row.get('passed')is True,'actual Linux kernel prerequisite required')
    need(row['boot_id']==boot and row['kernel_release']==kernel,'kernel prerequisite belongs to another boot/kernel')
    need(type(row['finished_monotonic_ns'])is int and 0<=now-row['finished_monotonic_ns']<=300*10**9,'fresh kernel prerequisite required')
    checks=('private_network','NoNewPrivs','zero_capabilities','no_outside_route','outside_TCP_denied','private_PID1','host_UNIX_hidden','readonly_owned_sentinel','nested_userns_disabled','same_python_time_namespace','three_byte_halfclose_channels')
    need(all(row.get('namespace',{}).get(key)is True for key in checks),'actual namespace capability checks missing')
    need(type(row['MemTotal_bytes'])is int and row['MemTotal_bytes']>=32*GIB,'actual32GiB runner floor required')
    need(row.get('cgroup_v2_limits_applied')is True and row.get('pidfd_open_supported')is True and row.get('all_owned_absent')is True and row.get('forced_cleanup')is False,'actual kernel ownership/capability controls incomplete')
    need(row['negative_owner_cleanup']['all_owned_absent']is True and row['negative_owner_cleanup']['actual_parent_wait']is True,'actual setsid cleanup prerequisite missing')
    need(len(row['commands'])==1 and row['commands'][0].get('actual_parent_wait')is True and row['commands'][0].get('exit_code')==0,'actual successful namespace parent wait required')
    return row

def delegated_parent(context,token):
 keys={'unit','invocation','uid','gid','root','root_dev','root_ino','manager_dev','manager_ino','boot_id'}
 need(type(context)is dict and set(context)==keys,'exact separate delegation context required')
 unit='ziggy-aleo-docker-probe-'+token+'.service';root=Path('/sys/fs/cgroup/system.slice')/unit;manager=root/'manager'
 need(context['unit']==unit and context['root']==str(root)and re.fullmatch('[0-9a-f]{32}',context['invocation']),'Docker-purpose custody required')
 need(os.getuid()>0 and context['uid']==os.getuid()and context['gid']==os.getgid(),'same unprivileged runner required')
 need(context['boot_id']==Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'delegation boot differs')
 need(Path('/proc/self/cgroup').read_text()=='0::/system.slice/'+unit+'/manager\n','probe outside owned manager')
 for name,path in [('root',root),('manager',manager)]:
  row=path.stat();need(path.resolve()==path and(row.st_dev,row.st_ino)==(context[name+'_dev'],context[name+'_ino'])and row.st_uid==os.getuid(),'delegated inode/UID changed')
 need(not(root/'cgroup.procs').read_text().split()and(manager/'cgroup.procs').read_text().split()==[str(os.getpid())],'foreign delegated task')
 need({'memory','pids'}<=set((root/'cgroup.subtree_control').read_text().split()),'delegated controllers missing')
 return root

class Lease:
 def __init__(self,s):
  self.path=delegated_parent(s['delegation'],s['run_token'])/('probe-'+s['run_token']);self.path.mkdir();v=self.path.stat();self.identity=(v.st_dev,v.st_ino);self.line='0::/'+str(self.path.relative_to('/sys/fs/cgroup'))+'\n'
  try:
   for n,v in [('memory.max',CAPS['child_memory_bytes']),('memory.swap.max',0),('pids.max',CAPS['pids'])]:self.write(n,str(v));need(self.read(n)==str(v),'actual cgroup caps differ')
  except BaseException:self.path.rmdir();raise
 def verify(self):v=self.path.stat();need((v.st_dev,v.st_ino)==self.identity,'probe cgroup replaced')
 def read(self,n):self.verify();return(self.path/n).read_text().strip()
 def write(self,n,v):self.verify();(self.path/n).write_text(v)
 def attach(self,pid):self.write('cgroup.procs',str(pid));need(Path('/proc',str(pid),'cgroup').read_text()==self.line,'child outside actual leaf')
 def populated(self):return dict(r.split()for r in self.read('cgroup.events').splitlines())['populated']=='1'
 def close(self):need(not self.populated(),'owned descendant remains');self.verify();self.path.rmdir()

def route_verdict(ipv4,ipv6,namespace_only=False):
 rows=[r.split()for r in ipv4.splitlines()[1:]if r.strip()];need(all(len(r)>=8 for r in rows),'typed actual IPv4 routes required')
 need(all(r[1]!='00000000'or r[7]!='00000000'or r[0]=='lo'for r in rows),'outside IPv4 default route')
 rows6=[r.split()for r in ipv6.splitlines()if r.strip()];need(all(len(r)==10 for r in rows6),'typed actual IPv6 routes required')
 need(all(not(r[0]=='0'*32 and r[1]=='00'and r[-1]!='lo')for r in rows6),'outside IPv6 default route')
 if namespace_only:need(all(r[0]=='lo'for r in rows)and all(r[-1]=='lo'for r in rows6),'namespace has nonloopback route')
 return {'no_outside_default_route':True,'ipv4_rows':len(rows),'ipv6_rows':len(rows6),'external_TCP_blackhole_credit':False}
def kernel_network(pid,cid,network,expected):
 p=Path('/proc')/str(pid);raw=(p/'stat').read_text();start=raw[raw.rfind(')')+2:].split()[19];status=dict(r.split(':',1)for r in(p/'status').read_text().splitlines()if ':'in r)
 caps={key:status[key].strip()for key in ('CapEff','CapPrm','CapBnd','CapAmb','CapInh')}
 need(all(int(v,16)==0 for v in caps.values())and status['NoNewPrivs'].strip()=='1','actual all container caps/NNP differ')
 line=(p/'cgroup').read_text().strip();need(line.startswith('0::/')and cid in line,'actual native container cgroup differs');directory=Path('/sys/fs/cgroup')/line[4:];need(directory.resolve()==directory,'actual kernel cgroup alias')
 limits={key:(directory/key).read_text().strip()for key in ('memory.max','memory.swap.max','pids.max','cpu.max')};need(limits['memory.max']==str(expected['Memory'])and limits['memory.swap.max']=='0'and limits['pids.max']==str(expected['PidsLimit']),'actual retained kernel limits differ')
 quota,period=limits['cpu.max'].split();need(quota!='max'and int(quota)*10**9==expected['NanoCpus']*int(period),'actual retained CPU quota differs')
 routes=route_verdict((p/'net/route').read_text(),(p/'net/ipv6_route').read_text());fresh=(p/'stat').read_text();need(fresh[fresh.rfind(')')+2:].split()[19]==start,'container PID changed during observation')
 return {'cid':cid,'pid':pid,'start':start,'network':network,'actual_capability_hex':caps,'actual_NoNewPrivs':status['NoNewPrivs'].strip(),'actual_UID_fields':[int(v)for v in status['Uid'].split()],'actual_GID_fields':[int(v)for v in status['Gid'].split()],'actual_cgroup_line':line,'actual_kernel_limits':limits,**routes}
class LostReplyDaemon(Daemon):
 def __init__(self,*a,inject=False,**k):super().__init__(*a,**k);self.inject=inject;self.committed=None
 def call(self,method,path,body=None,maximum=16*MIB,cleanup_deadline_ns=None):
  status,raw=super().call(method,path,body,maximum,cleanup_deadline_ns=cleanup_deadline_ns)
  if self.inject and method=='POST'and path.startswith('/containers/create?name=')and status==201:
   self.inject=False;self.committed={'cid':decode(raw)['Id'],'name':path.split('=',1)[1]};raise TimeoutError('controlled actual committed-create lost reply')
  return status,raw
class RecordingGate(Gate):
 def __init__(self,*a,**k):super().__init__(*a,**k);self.actual_kernel=[]
 def kernel_caps(self,cid):
  v=super().kernel_caps(cid);row=self.owned(cid);networks=row['NetworkSettings']['Networks']
  need(networks and all(n['NetworkID']==self.spec['internal_network']for n in networks.values()),'foreign container network')
  actual=row['HostConfig'];need(actual.get('CapDrop')==['ALL']and actual.get('SecurityOpt')==['no-new-privileges:true']and actual.get('Binds')in(None,[])and actual.get('Privileged')is False,'actual closed safe HostConfig differs')
  v['actual_container_labels']=dict(row['Config']['Labels']);v['expected_inherited_image_labels']=inherited_image_labels(self.containers[cid]['image'])
  v['actual_HostConfig']={k:actual.get(k)for k in ('Memory','MemorySwap','NanoCpus','PidsLimit','NetworkMode','PortBindings','Tmpfs','CapDrop','SecurityOpt','Binds','Privileged')}
  if self.containers[cid]['kind']=='postgres':
   rows=[r.split()for r in Path('/proc',str(v['pid']),'mountinfo').read_text().splitlines()];found=[r for r in rows if len(r)>6 and r[4]=='/var/lib/postgresql/data'];need(len(found)==1,'exact actual PG data mount required');mount=found[0];index=mount.index('-');options=set(mount[5].split(','))|set(mount[index+3].split(','));size=[o for o in options if o.startswith('size=')]
   need(mount[index+1]=='tmpfs'and len(size)==1 and size[0]in {'size=2147483648','size=2097152k','size=2g'}and {'noexec','nosuid','uid=999','gid=999'}<=options,'actual PG tmpfs differs');v['actual_PG_tmpfs']={'path':mount[4],'filesystem':mount[index+1],'flags':sorted({'noexec','nosuid','uid=999','gid=999',*size})}
  v.update(kernel_network(v['pid'],cid,self.spec['internal_network'],self.containers[cid]['create_body']['HostConfig']));self.actual_kernel.append(v);return v


def safe_failure(value):
 if value is None:return None
 raw=str(value).encode();kind=str(value).split(':',1)[0]
 return {'type':kind if re.fullmatch('[A-Za-z_][A-Za-z0-9_]{0,127}',kind)else'Unclassified','message_bytes':len(raw),'message_sha256':hashlib.sha256(raw).hexdigest()}

def owned_state_snapshot(gate):
 rows=[]
 for cid in list(gate.containers):
  row={'cid':cid,'full_owned_identity_verified':False}
  try:
   value=gate.owned(cid);row['full_owned_identity_verified']=True;state=value['State'];keys=('Status','Running','Pid','ExitCode','OOMKilled','StartedAt','FinishedAt');v={k:state[k]for k in keys}
   need(v['Status']in{'created','running','paused','restarting','removing','exited','dead'}and type(v['Running'])is bool and type(v['OOMKilled'])is bool,'Typed owned container State flags required')
   need(all(type(v[k])is int and 0<=v[k]<2**31 for k in('Pid','ExitCode')),'Typed owned container State counters required')
   need(all(isinstance(v[k],str)and re.fullmatch('[0-9T:Z.+-]{1,64}',v[k])for k in('StartedAt','FinishedAt')),'Typed owned container State clocks required')
   row.update(State=v,observed_monotonic_ns=time.monotonic_ns(),scope='cleanup read-only observation; no execution/liveness credit')
  except BaseException as error:row['observation_error']=safe_failure(type(error).__name__+':'+str(error))
  rows.append(row)
 return rows

def retain_failure_state(result,gate,root):
 # API worker drain is attempted first; the actual Gate lock bounds snapshots.
 with gate.locked(gate.daemon.deadline_ns):
  result['actual_kernel']=list(gate.actual_kernel);result['latched_API_failure']=safe_failure(gate.failed)
  result['actual_NamespacePeer_Node']=gate.node_identity;result['committed_create']=gate.daemon.committed
  result['owned_container_State']=owned_state_snapshot(gate)
 for name in('node.stdout','node.stderr'):
  path=root/name
  if path.is_file():
   value=pin(path);result[name.replace('.','_')+'_fingerprint']={k:value[k]for k in('bytes','sha256')}

def close_bridge_bounded(bridge,deadline_ns):
 bridge.stopping.set();errors=[]
 def drain():
  try:
   if bridge.thread.ident is None:bridge.server.server_close()
   else:bridge.close()
  except BaseException as error:errors.append(type(error).__name__)
 worker=threading.Thread(target=drain,daemon=True);worker.start();worker.join(max(0,(deadline_ns-time.monotonic_ns())/10**9))
 need(not worker.is_alive()and not errors,'private bridge drain failed or missed original cleanup deadline')
 need(not bridge.thread.is_alive(),'shared bridge serve thread remains')
 return {'drain_thread_joined':True,'server_started':bridge.thread.ident is not None,'nonchild_wait_credit':False}

def stop_child_bounded(child,pidfd,lease,signals,result,deadline_ns):
 def failure(stage,error):result.setdefault('cleanup_errors',[]).append(stage+':'+type(error).__name__);result['passed']=False
 def budget():return max(.001,min(3,(deadline_ns-time.monotonic_ns())/10**9))
 if child is not None and 'direct_wait'not in result:
  running=True
  try:running=child.poll()is None
  except BaseException as error:failure('child_poll',error)
  if running:
   try:
    if pidfd is not None:signal.pidfd_send_signal(pidfd,signal.SIGTERM)
    else:child.terminate()
    signals.append({'actual_direct_child_SIGTERM':child.pid})
   except BaseException as error:failure('child_signal',error)
  try:
   code=child.wait(timeout=budget());result['direct_wait']={'pid':child.pid,'actual_parent_wait':True,'exit_code':code,'scope':'original bootstrap/bwrap child; never a daemon-container wait'}
  except BaseException as error:
   failure('child_wait',error)
   try:lease.write('cgroup.kill','1');signals.append({'owned_cgroup_kill':True})
   except BaseException as error:failure('owned_kill',error)
   try:
    code=child.wait(timeout=budget());result['direct_wait']={'pid':child.pid,'actual_parent_wait':True,'exit_code':code,'scope':'original bootstrap/bwrap child; never a daemon-container wait'}
   except BaseException as error:failure('child_final_wait',error)
 if pidfd is not None:
  try:os.close(pidfd)
  except BaseException as error:failure('pidfd_close',error)

def namespace_argv(s,root,config):
 a=[str(checked(s['bwrap'])),'--unshare-user','--unshare-net','--unshare-pid','--as-pid-1','--unshare-ipc','--unshare-uts','--disable-userns','--assert-userns-disabled','--die-with-parent','--new-session','--cap-drop','ALL','--clearenv','--ro-bind','/usr','/usr','--symlink','usr/bin','/bin','--symlink','usr/lib','/lib','--symlink','usr/lib64','/lib64','--proc','/proc','--dev','/dev']
 for p in s['readonly_roots']:need(Path(p).resolve()==Path(p)and not str(p).startswith(('/run','/var','/proc','/sys','/etc')),'unapproved readonly authority');a+=['--ro-bind',p,p]
 return a+['--ro-bind',str(root/'readonly'),str(root/'readonly'),'--ro-bind',str(root/'capabilities'),str(root/'capabilities'),'--bind',str(root/'task'),str(root/'task'),'--remount-ro','/','--',str(checked(s['node'])),str(checked(s['node_main'])),config['path'],config['sha256']]
def bootstrap(argv):
 need(sys.stdin.buffer.readline(4)==b'GO\n','cgroup GO barrier absent');need(ctypes.CDLL(None,use_errno=True).prctl(38,1,0,0,0)==0,'NNP missing');os.execve(argv[0],argv,{'PATH':'/usr/bin:/bin','LC_ALL':'C.UTF-8','HOME':'/tmp','TMPDIR':'/tmp'})

def phase(s,root,lease,identity,network_id,deadline,name,kind,lost,signals,cancel,initial_free):
 for d in (root,root/'readonly',root/'task',root/'capabilities'):d.mkdir(mode=0o700)
 manifest={'taskRoot':str(root/'task/case'),'domains':[{'name':'aleo_a','port':23030},{'name':'aleo_b','port':23031}],**IMAGES};digest=hashlib.sha256(json.dumps(manifest,sort_keys=True,separators=(',',':')).encode()).hexdigest();cap=root/'capabilities'
 gs={'manifest':manifest,'daemon_id':s['daemon_id'],'run_token':s['run_token'],'internal_network':network_id,'original_deadline_ns':deadline,'public_node_env':PUBLIC_ENV,'postgres_command':['postgres'],'python':s['python'],'node':s['node'],'docker_cli':s['shim'],'actual_case_cgroup_line':lease.line,'task_root':manifest['taskRoot'],'manifest_digest':digest}
 selected=next(v for v in container_templates(gs,1)if v['kind']==kind)
 config=write(root/'readonly/probe.json',{'phase':name,'selected':selected,'python':str(checked(s['python'])),'shim':str(checked(s['shim'])),'task_root':manifest['taskRoot'],'manifest_digest':digest,'socket':str(cap/'docker.sock'),'deadline_ns':str(deadline),'host_net':os.readlink('/proc/self/ns/net'),'host_time':os.readlink('/proc/self/ns/time'),'inject_lost_create_reply':lost})
 argv=namespace_argv(s,root,config);gs['exact_node_argv']=argv[argv.index('--')+1:]
 write(root/'readonly/docker-client-policy.json',{k:gs[k]for k in('manifest','run_token','internal_network','original_deadline_ns','public_node_env','postgres_command','manifest_digest')}|{'gate_socket':str(cap/'docker.sock')})
 daemon=LostReplyDaemon(s['docker_socket'],identity,s['docker_api_version'],deadline,inject=lost);gate=RecordingGate(gs,daemon,NamespacePeer(gs));server=Server(str(cap/'docker.sock'),gate);thread=threading.Thread(target=server.serve_forever);thread.start()
 bridge=None;child=None;pidfd=None;rows=[];result={'phase':name,'controlled_fault':lost,'passed':False}
 try:
  if kind=='aleo_a'and not lost:
   def peer(connection):
    import struct
    pid,uid,_=struct.unpack('3i',connection.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12));need(uid==os.getuid()and Path('/proc',str(pid),'cgroup').read_text()==lease.line,'foreign byte-bridge peer')
   bridge=FixedServer(cap,23030,True,peer,deadline,threading.BoundedSemaphore(4),rows.append);bridge.start()
  with(root/'node.stdout').open('xb')as out,(root/'node.stderr').open('xb')as err:child=subprocess.Popen([str(checked(s['python'])),'-I','-B',str(Path(__file__).resolve()),'--bootstrap',json.dumps(argv)],stdin=subprocess.PIPE,stdout=out,stderr=err,env={'PATH':'/usr/bin:/bin','LC_ALL':'C.UTF-8'},start_new_session=True)
  birth=proc_identity(child.pid);result['actual_child_birth']={k:birth[k]for k in ('pid','parent','group','start','uid','exe','cgroup')};lease.attach(child.pid);pidfd=os.pidfd_open(child.pid);child.stdin.write(b'GO\n');child.stdin.flush();child.stdin.close()
  while child.poll()is None:
   need(time.monotonic_ns()<deadline and not cancel.is_set(),'original probe deadline/cancel');need(gate.failed is None or lost,'unexpected API gate failure')
   need(int(lease.read('memory.current'))<=CAPS['child_memory_bytes']and free(root)>=6*GIB and initial_free-free(root)<=4*GIB,'actual memory/disk/floor guard')
   rss=int(next(line.split()[1]for line in Path('/proc/self/status').read_text().splitlines()if line.startswith('VmRSS:')))*1024;need(rss<=CAPS['owner_memory_bytes'],'actual owner memory bound')
   need((root/'node.stdout').stat().st_size+(root/'node.stderr').stat().st_size<=2*MIB,'Node output bound');time.sleep(.05)
  code=child.wait();result['direct_wait']={'pid':child.pid,'actual_parent_wait':True,'exit_code':code,'scope':'original bootstrap/bwrap child; never a daemon-container wait'}
  need(code==0 and time.monotonic_ns()<deadline,'real pinned Node main failed/late');actual=decode((root/'node.stdout').read_bytes(),MIB)
  need(actual['passed']is True and actual['node_version']=='v26.12.1'and actual['controlled_lost_create_reply']is lost and gate.node_identity is not None,'actual NamespacePeer/Node result missing')
  if lost:need(daemon.committed is not None and gate.failed is not None and actual['cid']is None,'real committed-create fault not reached')
  else:need(gate.failed is None and len(gate.containers)==1 and len(gate.actual_kernel)==1 and actual['actual_readonly_API']is not None,'actual one-container/API/kernel witness missing')
  result.update(actual_Node=actual,actual_NamespacePeer_Node=gate.node_identity,actual_host_uid=os.getuid(),actual_host_gid=os.getgid(),actual_kernel=gate.actual_kernel,committed_create=daemon.committed,gate_failed=gate.failed,passed=True)
 except BaseException as error:result['error_type']=type(error).__name__
 finally:
  cleanup_deadline=min(deadline+90*10**9,time.monotonic_ns()+90*10**9)
  stop_child_bounded(child,pidfd,lease,signals,result,cleanup_deadline)
  for label,action in [('gate_server',lambda:server.close_bounded(thread,cleanup_deadline))]:
   try:action()
   except BaseException as error:result.setdefault('cleanup_errors',[]).append(label+':'+type(error).__name__);result['passed']=False
  progress=root/'task/case/probe-progress.json'
  if progress.exists():
   try:
    v=decode(progress.read_bytes(),4096);need(set(v)=={'schema','phase','stage','attempt','observed_monotonic_ns'}and v['schema']==1 and v['phase']==name and v['stage']in {'starting','docker.info','docker.image','docker.run','docker.exec','docker.stop','native.height','finished'}and type(v['attempt'])is int and 0<=v['attempt']<=8192 and isinstance(v['observed_monotonic_ns'],str)and re.fullmatch('[0-9]{1,20}',v['observed_monotonic_ns']),'closed safe Node progress required');result['public_Node_progress']=v
   except BaseException as error:result.setdefault('cleanup_errors',[]).append('public_progress:'+type(error).__name__);result['passed']=False
  daemon.deadline_ns=cleanup_deadline
  try:retain_failure_state(result,gate,root)
  except BaseException as error:result['diagnostic_error']=safe_failure(type(error).__name__+':'+str(error));result['passed']=False
  try:
   clean=gate.cleanup();result['container_cleanup']=clean;result['bridge_records']=rows
   need(clean['passed']is True and len(clean['rows'])==1 and clean['rows'][0]['stopped_removed_absent']is True,'exact single CID cleanup missing')
  except BaseException as error:result.setdefault('cleanup_errors',[]).append('containers:'+type(error).__name__);result['passed']=False
  if bridge is not None:
   try:result['bridge_drain']=close_bridge_bounded(bridge,cleanup_deadline)
   except BaseException as error:result.setdefault('cleanup_errors',[]).append('bridge:'+type(error).__name__);result['passed']=False
 return result

def run(spec_pin):
 s=approved(load(spec_pin));need(platform.system()=='Linux'and platform.machine()=='x86_64','native Linux amd64 only')
 root=Path(s['output']);need(root.is_absolute()and root.parent.resolve()==root.parent and not root.exists(),'new canonical output required');need(free(root.parent)>=6*GIB,'actual free6GiB floor');root.mkdir(mode=0o700)
 result={'schema':1,'kind':PURPOSE,'passed':False,'spec':spec_pin,'phases':[],'signals':[],'native_case_acceptance':False,'SDK_or_proof_or_agent_execution':False};start=time.monotonic_ns();deadline=start+300*10**9;result.update(started_monotonic_ns=start,original_deadline_ns=deadline);lease=None;network=None;initial_free=free(root);cancel=threading.Event();old_handlers={}
 def interrupted(sig,frame):cancel.set();result['signals'].append({'owner_signal':sig})
 for sig in (signal.SIGINT,signal.SIGTERM):old_handlers[sig]=signal.signal(sig,interrupted)
 try:
  lease=Lease(s);v=Path(s['docker_socket']).stat(follow_symlinks=False);need(stat.S_ISSOCK(v.st_mode),'native Engine Unix socket required');identity=[v.st_dev,v.st_ino];daemon=Daemon(s['docker_socket'],identity,s['docker_api_version'],deadline)
  status,raw=daemon.call('GET','/info');info=decode(raw);need(status==200 and info['ID']==s['daemon_id']and info['OSType']=='linux'and info['Architecture']=='x86_64'and info['DockerRootDir']==s['docker_filesystem'],'actual native Engine differs')
  need(Path(s['docker_filesystem']).stat().st_dev==root.stat().st_dev,'daemon/probe disk must share observed filesystem')
  network=NetworkLease(daemon,'ziggy-aleo-net-'+s['run_token'],{'ziggy.aleo.run-token':s['run_token']});network_id=network.create();n=network.inspect();need(n['Internal']is True and n['Driver']=='bridge'and n['Attachable']is False and n['Scope']=='local'and type(n['EnableIPv6'])is bool,'actual internal local bridge required');result['actual_network_configuration']={k:n[k]for k in ('Id','Name','Driver','Internal','Attachable','Scope','EnableIPv6','Labels')}
  for name,kind,lost in [('postgres','postgres',False),('leo','aleo_a',False),('committed_create_lost_reply','aleo_a',True)]:
   need(time.monotonic_ns()<deadline and initial_free-free(root)<=4*GIB,'original time/disk bound')
   row=phase(s,root/name,lease,identity,network_id,deadline,name,kind,lost,result['signals'],cancel,initial_free);result['phases'].append(row);need(row['passed'],'actual prerequisite phase failed')
  need(not result['signals'],'unexpected child signals');result['passed']=True
 except BaseException as error:result['error_type']=type(error).__name__
 finally:
  for label,action in [('cgroup',lambda:lease.close()if lease is not None else None),('network',lambda:network.close()if network is not None else None)]:
   try:
    if network is not None:network.daemon.deadline_ns=min(deadline+90*10**9,time.monotonic_ns()+90*10**9)
    value=action()
    if label=='network':result['network_cleanup']=value
   except BaseException as error:result.setdefault('cleanup_errors',[]).append(label+':'+type(error).__name__);result['passed']=False
  try:
   for row in s['pins']:checked(row)
   result['source_unchanged']=True
  except BaseException as error:result['source_error_type']=type(error).__name__;result['passed']=False
  for sig,h in old_handlers.items():signal.signal(sig,h)
  result['completed_monotonic_ns']=time.monotonic_ns();write(root/'result.json',result)
 return 0 if result['passed']else 1

def main():
 if sys.argv[1:2]==['--bootstrap']:bootstrap(json.loads(sys.argv[2]));return
 p=argparse.ArgumentParser();p.add_argument('--spec',required=True);p.add_argument('--spec-sha256',required=True);a=p.parse_args();q=Path(a.spec);need(pin(q)['sha256']==a.spec_sha256,'immutable probe spec required');raise SystemExit(run(pin(q)))
if __name__=='__main__':main()
