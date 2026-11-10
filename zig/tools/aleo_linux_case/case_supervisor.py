"""Explicit Linux Aleo resource owner. Inert unless an exact case is authorized.

No SDK import or Docker request occurs when importing this module. The private
kernel prerequisite must have actually passed on this boot before case launch.
"""
import argparse
import ctypes
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import signal
import stat
import subprocess
import sys
import threading
import time

HERE=Path(__file__).resolve().parent
for code_root in (HERE,HERE.parent/'aleo_linux',HERE.parent/'aleo_linux_sdk'):
    if(code_root/'__pycache__').exists()or(code_root/'__pycache__').is_symlink():raise ValueError('full-case profile forbids cached local Python bytecode')
sys.path.insert(0,str(HERE))
KERNEL=HERE.parent/'aleo_linux'
SDK=HERE.parent/'aleo_linux_sdk'
sys.path.insert(0,str(KERNEL))
sys.path.insert(0,str(SDK))
sys.path.insert(0,str(HERE))
from case_cohort import source_cohort,storage_interop
from receipts import checked, clock_bridge, decode, load, need, sdk_receipt
from kernel_probe import Lease, process, reap_terminal, bootstrap
from docker_gate import Daemon, Gate, NamespacePeer, NetworkLease, Server
from loopback_bridge import FixedServer, PORTS
from bridge_close import close_bridge_bounded
import controller_resources
from custody import Journal,RecordedMap,RecordedNetwork

GIB=1024**3
MIB=1024**2
CAPS={'whole_seconds':10800,'host_memory_bytes':14*GIB,'child_memory_bytes':27*GIB//2,'owner_memory_bytes':GIB//2,'container_memory_bytes':13*GIB//2,'combined_memory_bytes':41*GIB//2,'new_disk_bytes':6*GIB,'free_floor_bytes':6*GIB,'pids':512,'observation_seconds':1}


def pin(path):
    path=Path(path)
    with path.open('rb')as stream:digest=hashlib.file_digest(stream,'sha256').hexdigest()
    return {'path':str(path),'bytes':path.stat().st_size,'sha256':digest}


def write(path,value):
    raw=(json.dumps(value,indent=2)+'\n').encode()
    with path.open('xb')as stream:os.chmod(path,0o600);stream.write(raw);stream.flush();os.fsync(stream.fileno())
    return pin(path)


def allocated(root):
    """Allocated bytes, unique inode once, disappearing temporary leaves only."""
    total=0;seen=set()
    for directory,dirs,files in os.walk(root,followlinks=False):
        for name in dirs+files:
            path=Path(directory)/name
            try:info=path.lstat()
            except FileNotFoundError:continue
            need(not stat.S_ISLNK(info.st_mode),'unexpected writable-root symlink')
            key=(info.st_dev,info.st_ino)
            if key not in seen:seen.add(key);total+=info.st_blocks*512
    return total


def free(path):
    row=os.statvfs(path);return row.f_bavail*row.f_frsize


def owner_rss():
    return int(next(line.split()[1]for line in Path('/proc/self/status').read_text().splitlines()if line.startswith('VmRSS:')))*1024


def resource_verdict(child_memory,parent_memory,allocated_bytes,container_rw,initial_free,current_free,daemon_free):
    values=(child_memory,parent_memory,allocated_bytes,container_rw,initial_free,current_free,daemon_free)
    need(all(type(value)is int and value>=0 for value in values),'actual nonnegative resource bytes required')
    host=child_memory+parent_memory
    # PG bounded tmpfs and two private 64MiB namespace tmpfs are conservatively
    # reserved even when their current usage is smaller or a node is not up yet.
    disk=max(allocated_bytes+container_rw+2*GIB+128*MIB,max(0,initial_free-current_free))
    return {'host_memory_bytes':host,'reserved_combined_memory_bytes':host+CAPS['container_memory_bytes'],'new_disk_bytes':disk,'free_bytes':current_free,'daemon_free_bytes':daemon_free,'passed':child_memory<=CAPS['child_memory_bytes']and parent_memory<=CAPS['owner_memory_bytes']and host<=CAPS['host_memory_bytes']and host+CAPS['container_memory_bytes']<=CAPS['combined_memory_bytes']and disk<=CAPS['new_disk_bytes']and min(current_free,daemon_free)>=CAPS['free_floor_bytes']}


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


def kernel_receipt(pin_value):
    row=validate_kernel(load(pin_value),Path('/proc/sys/kernel/random/boot_id').read_text().strip(),platform.release(),time.monotonic_ns())
    checked(row['spec'])
    return row


def xhr_adapter_provenance(spec,control):
    from case_specs import xhr_adapter_contract
    contract=xhr_adapter_contract();expected={'original':spec['xhr_caller'],'adapter':spec['bootstrap'],'executed':contract['executed']}
    directory=Path(control)/'xhr-adapters';need(directory.resolve(strict=True)==directory and directory.is_dir()and not directory.is_symlink(),'canonical XHR adapter state directory required')
    names=list(directory.iterdir());need(0<len(names)<=1024,'bounded actual adapter isolates required');loaded=waited=0;maximum=0
    for path in names:
        match=__import__('re').fullmatch(r'([1-9][0-9]{0,10})-([0-9]{1,10})\.json',path.name);need(match is not None,'fixed adapter state leaf required')
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        try:
            before=os.fstat(fd);need(stat.S_ISREG(before.st_mode)and before.st_uid==os.getuid()and 0<before.st_size<=4096,'bounded regular adapter state required');raw=os.read(fd,4097);after=os.fstat(fd)
            need(len(raw)==before.st_size and all(getattr(before,k)==getattr(after,k)for k in ('st_dev','st_ino','st_size','st_mtime_ns','st_ctime_ns')),'stable adapter state required')
        finally:os.close(fd)
        value=decode(raw);need(type(value)is dict and set(value)=={'schema','kind','pid','threadId','original','adapter','executed','disk_mutated','loads','started','actual_waits','not_started','failed','in_flight','maximum_in_flight'},'closed XHR actual state required')
        need(type(value['schema'])is int and value['schema']==1 and value['kind']==contract['kind']and value['disk_mutated']is False and all(value[k]==v for k,v in expected.items()),'actual XHR Source provenance differs')
        need(type(value['pid'])is int and type(value['threadId'])is int and(value['pid'],value['threadId'])==(int(match[1]),int(match[2])),'adapter state identity differs')
        for key in ('loads','started','actual_waits','not_started','failed','in_flight','maximum_in_flight'):need(type(value[key])is int and 0<=value[key]<=2**31,'typed XHR actual state count required')
        need(value['loads']>0 and value['started']==value['actual_waits']and value['failed']==value['not_started']==value['in_flight']==0 and value['maximum_in_flight']<=2,'actual synchronous XHR waits incomplete or failed')
        loaded+=value['loads'];waited+=value['actual_waits'];maximum=max(maximum,value['maximum_in_flight'])
    need({p.name for p in directory.iterdir()}=={p.name for p in names},'adapter state set changed')
    checked(spec['xhr_caller']);checked(spec['bootstrap'])
    return {'schema':1,'kind':contract['kind'],'original_dependency':contract['original'],'adapter_Source':{'path':'zig/tools/aleo_linux_case/bootstrap.mjs','bytes':spec['bootstrap']['bytes'],'sha256':spec['bootstrap']['sha256']},'executed_dependency':contract['executed'],'published_dependency_disk_unchanged':True,'executed_original_dependency_verbatim':False,'actual_isolate_states':len(names),'actual_adapter_loads':loaded,'actual_synchronous_waits':waited,'all_actual_waits_successful':True,'maximum_observed_per_isolate_helpers':maximum,'per_isolate_helper_limit':2,'global_helper_limit_claimed':False,'live_PID_birth_observation_claimed':False}


def final_pass(result):
    return result.get('case_verdict')is True and result.get('source_unchanged')is True and result.get('owned_absent')is True and result.get('container_cleanup',{}).get('passed')is True and result.get('network_cleanup',{}).get('owned_internal_network_removed_and_absent')is True and result.get('bridges_joined')is True and result.get('gate_failed')is None and not result.get('signals')and not result.get('error')and not result.get('cleanup_errors')and all(row.get('actual_parent_wait')is True and row.get('exit_code')==0 for row in result.get('direct_waits',[]))and len(result.get('direct_waits',[]))==2 and all(row.get('exit_code')==0 for row in result.get('actual_adopted_waits',[]))


def cleanup_phase(errors,name,action):
    try:return action()
    except BaseException as error:errors.append(name+': '+type(error).__name__+':'+str(error))


def run(spec_pin):
    spec=load(spec_pin,32*1024**2)
    need(spec.get('schema')==1 and spec.get('root_approved')is True and spec.get('purpose')=='actual-aleo-linux-case-v1'and spec.get('caps')==CAPS,'exact approved Aleo case and caps required')
    need(platform.system()=='Linux'and platform.machine()=='x86_64','native Linux amd64 required')
    need(pin(Path(__file__).resolve())in spec['pins'],'exact owner Source required')
    for row in spec['pins']:checked(row)
    actual_kernel=kernel_receipt(spec['kernel_receipt'])
    from case_specs import admission
    admission(spec)
    need(actual_kernel['spec']==spec['kernel_spec'],'approved kernel spec differs')
    cohort=source_cohort(spec['context'],spec['source_loader'],spec['repo'],spec['execution_source_commit'],spec['runtime_source_commit'],spec['verifier_pins'])
    actual_sdk=sdk_receipt(spec['sdk_receipt'],spec['node'],spec['sdk_entry'],spec['execution_source_commit'],spec['sdk_owner_receipt'])
    storage_interop(spec['storage_interop'],spec['context'],spec['source_loader'],spec['repo'],spec['verifier_pins'])
    manifest=load(spec['manifest']);template=load(spec['policy_template'])
    need(manifest['runtimeSourceCommit']==spec['runtime_source_commit']and manifest['artifacts']==cohort['runtime_products'],'actual mode runtime9 differs')
    root=Path(spec['output']);need(root.is_absolute()and root.parent.resolve()==root.parent and not root.exists(),'exclusive canonical output required')
    control=root/'control';data=root/'data';cap=root/'capabilities';readonly=root/'readonly'
    need(manifest['taskRoot']==str(data/'case')and manifest['dockerHost']=='unix://'+str(cap/'docker.sock'),'exact absent case/API path required')
    need(template['root']==str(control)and template.get('deadline_python_ns')is None and template.get('deadline_monotonic_ns')is None and template.get('uncertainty_ns')is None,'unminted exact policy template required')
    need(template['cache_port']==23032 and template['rpc_ports']==[23030,23031,23032,23033,23034,25432,29091,29092,29093,29094],'exact private loopback ports required')
    need(template['allowed_sdk_worker_files']==actual_sdk['worker_policy']['allowed_worker_files']and template['allowed_eval_sha256']==actual_sdk['worker_policy']['allowed_eval_sha256'],'SDK Worker targets must equal actual Linux SDK catalog')
    need(template['allowed_worker_files']==[spec['driver'],*actual_sdk['worker_policy']['allowed_worker_files']],'exact TS SDK isolate plus real SDK Worker targets required')
    policy_module=checked(spec['namespace_policy']);module_spec=importlib.util.spec_from_file_location('fixed_aleo_namespace_policy',policy_module);policy_code=importlib.util.module_from_spec(module_spec);module_spec.loader.exec_module(policy_code)
    python=str(checked(spec['python']));node=str(checked(spec['node']));bwrap=str(checked(spec['bwrap']))
    need(checked(spec['case_launcher']).with_name('bootstrap.mjs')==checked(spec['bootstrap']),'actual immutable launcher must import the admitted sibling bootstrap')
    need(python=='/usr/bin/python3.12'and manifest['tools']['node']['path']==node,'exact Ubuntu Python and admitted Node required')
    need(min(free(root.parent),free(spec['docker_filesystem']))>=CAPS['free_floor_bytes']+CAPS['new_disk_bytes'],'case growth headroom plus free6GiB floor required')
    memory={line.split(':',1)[0]:int(line.split()[1])*1024 for line in Path('/proc/meminfo').read_text().splitlines()if line.startswith(('MemTotal:','MemAvailable:'))}
    need(memory['MemTotal']>=32*GIB and memory['MemAvailable']>=CAPS['combined_memory_bytes'],'actual combined20.5GiB memory reservation unavailable')
    # Admission can hash a large closed SDK. Recheck freshness at the final
    # pre-write boundary; never extend/reissue the completed probe's receipt.
    kernel_receipt(spec['kernel_receipt'])
    root.mkdir(mode=0o700)
    for directory in (control,data,cap,readonly,control/'home',control/'tmp'):directory.mkdir(mode=0o700)
    # This is the sole mint: preflight and all receipt checks happened first.
    started=time.monotonic_ns();deadline=started+CAPS['whole_seconds']*10**9
    initial_free=free(root);child=None;lease=None;pidfd=None;daemon=None;servers=[];gate_server=None;gate_thread=None;gate=None;network=None;orphan_waits=[];bridge_rows=[];slots=threading.BoundedSemaphore(32)
    result={'schema':1,'kind':'dedicated-aleo-linux-case-owner-v1','passed':False,'spec':spec_pin,'original_started_ns':started,'original_deadline_ns':deadline,'direct_waits':[],'actual_adopted_waits':orphan_waits,'signals':[],'resource_samples':[],'generic_Python_NativeSession_acceptance':False,'performance_credit':False}
    cancelled=threading.Event()
    def cancel(signum,_frame):cancelled.set();result['signals'].append({'owner_received_signal':signum})
    for signum in (signal.SIGINT,signal.SIGTERM):signal.signal(signum,cancel)
    env={'PATH':'/usr/bin:/bin','HOME':str(control/'home'),'TMPDIR':str(control/'tmp'),'LC_ALL':'C.UTF-8','PYTHONNOUSERSITE':'1','PYTHONDONTWRITEBYTECODE':'1'}
    def launch(argv,label):
        nonlocal child,pidfd
        need(time.monotonic_ns()<deadline and not cancelled.is_set(),'original deadline/cancellation')
        out=(control/(label+'.stdout')).open('xb');err=(control/(label+'.stderr')).open('xb')
        try:child=subprocess.Popen([python,'-I','-B',str(Path(__file__).resolve()),'--bootstrap',json.dumps(argv)],env=env,stdin=subprocess.PIPE,stdout=out,stderr=err,start_new_session=True,close_fds=True)
        finally:out.close();err.close()
        pidfd=os.pidfd_open(child.pid);birth=process(child.pid);lease.attach(child.pid)
        child.stdin.write(b'GO\n');child.stdin.flush();child.stdin.close()
        return birth
    def wait_child(label,birth,limit=None):
        nonlocal pidfd
        limit=min(deadline,time.monotonic_ns()+int(limit*10**9))if limit else deadline
        while child.poll()is None:
            need(not cancelled.is_set()and time.monotonic_ns()<limit,'original case cancelled/deadline')
            need(int(lease.read('memory.current'))<=CAPS['child_memory_bytes']and owner_rss()+controller_resources.tree(load(spec['controller_receipt'])['identity'])['rss_bytes']<=CAPS['owner_memory_bytes'],'bounded host memory exceeded')
            if label=='case':sample_resources()
            time.sleep(1 if label=='case'else .02)
        code=child.wait();completed=time.monotonic_ns();result['direct_waits'].append({'phase':label,'pid':birth['pid'],'start':birth['start'],'group':birth['group'],'actual_parent_wait':True,'exit_code':code,'completed_monotonic_ns':completed})
        os.close(pidfd)
        pidfd=None
        need(completed<=limit,'actual parent completion exceeded original phase/case deadline')
        return code
    def sample_resources():
        need(gate.failed is None and not any(row.get('failure')for row in bridge_rows),'latched API/bridge failure')
        rw=0
        with gate.locked(deadline):
            for cid in list(gate.containers):
                row=gate.json_call('GET','/containers/'+cid+'/json?size=true');saved=gate.containers[cid]
                need(row['Id']==cid and row['Config']['Labels']==saved['labels']and row['Image']==saved['image'],'owned resource identity changed')
                need(type(row.get('SizeRw'))is int and row['SizeRw']>=0,'actual container writable bytes absent');rw+=row['SizeRw']
                if row['State']['Running']:gate.kernel_caps(cid)
        external=controller_resources.tree(load(spec['controller_receipt'])['identity'])
        sample=resource_verdict(int(lease.read('memory.current')),owner_rss()+external['rss_bytes'],allocated(root),rw,initial_free,free(root),free(spec['docker_filesystem']))
        sample['controller_tree']=external;sample['manager_rss_bytes']=owner_rss();sample['monotonic_ns']=time.monotonic_ns();result['resource_samples'].append(sample)
        need(len(result['resource_samples'])<=10802 and sample['passed'],'case resource cap/floor failed')
    try:
        need(ctypes.CDLL(None,use_errno=True).prctl(36,1,0,0,0)==0,'actual subreaper required')
        lease=Lease(spec['run_token'],CAPS['child_memory_bytes'],CAPS['pids'],load(spec['delegation_context']),family='case')
        result['actual_leaf_caps_before']={name:lease.read(name)for name in ('memory.max','memory.swap.max','pids.max')}
        need(result['actual_leaf_caps_before']=={'memory.max':str(CAPS['child_memory_bytes']),'memory.swap.max':'0','pids.max':'512'},'actual case leaf limits differ')
        # Pure Node clock has no SDK, helper, network or writable Source. Its
        # own real parent wait is retained separately from the actual case.
        clock_argv=policy_code.namespace_argv(bwrap,spec['readonly_roots'],{'control':str(control),'task':str(data)},str(cap),python,str(checked(spec['inner'])),str(readonly/'unused'))
        clock_argv=clock_argv[:clock_argv.index('--')+1]+[node,str(checked(spec['clock_script']))]
        clock_argv.remove('--as-pid-1') # Only the Python full-case inner owns PID1.
        before=time.monotonic_ns();birth=launch(clock_argv,'clock');need(wait_child('clock',birth,10)==0,'pure Node clock failed');pidfd=None
        after=time.monotonic_ns();raw=(control/'clock.stdout').read_bytes();need(len(raw)<=128 and raw.strip().isdigit(),'bounded exact Node clock scalar required');node_sample=int(raw.strip())
        bridge=clock_bridge(deadline,before,after,node_sample)
        policy=dict(template,**bridge);policy_pin=write(readonly/'policy.json',policy)
        clock_pin=write(readonly/'clock-receipt.json',dict(approved_plan=spec_pin,python_started_ns=started,python_deadline_ns=deadline,python_before_ns=before,python_after_ns=after,node_sample_ns=node_sample,no_remint=True))
        exact_node_argv=[node,'--experimental-strip-types','--no-warnings',str(checked(spec['case_launcher'])),policy_pin['path'],policy_pin['sha256'],str(checked(spec['manifest'])),str(checked(spec['driver']))]
        need(exact_node_argv==spec['exact_node_argv_template'][:4]+[policy_pin['path'],policy_pin['sha256']]+spec['exact_node_argv_template'][6:],'actual Source launcher argv differs')
        socket_info=Path(spec['docker_socket']).stat(follow_symlinks=False);need(stat.S_ISSOCK(socket_info.st_mode),'native Docker Unix socket required')
        daemon=Daemon(spec['docker_socket'],[socket_info.st_dev,socket_info.st_ino],spec['docker_api_version'],deadline)
        status,raw=daemon.call('GET','/info');info=decode(raw,16*MIB)
        need(status==200 and info['ID']==spec['daemon_id']and info['OSType']=='linux'and info['Architecture']=='x86_64'and info['DockerRootDir']==spec['docker_filesystem'],'native host Docker identity/root differs')
        journal=Journal(root/'custody',spec_pin,[socket_info.st_dev,socket_info.st_ino])
        network=RecordedNetwork(daemon,'ziggy-aleo-net-'+spec['run_token'],{'ziggy.aleo.run-token':spec['run_token']},journal);network_id=network.create()
        gate_spec=dict(manifest=manifest,daemon_id=spec['daemon_id'],run_token=spec['run_token'],internal_network=network_id,original_deadline_ns=deadline,public_node_env=spec['public_node_env'],postgres_command=['postgres'],python=spec['python'],node=spec['node'],docker_cli=spec['docker_cli'],exact_node_argv=exact_node_argv,actual_case_cgroup_line=lease.line,task_root=manifest['taskRoot'],manifest_digest=spec['manifest_digest'])
        write(readonly/'docker-client-policy.json',{key:gate_spec[key]for key in ('manifest','run_token','internal_network','original_deadline_ns','public_node_env','postgres_command','manifest_digest')}|{'gate_socket':str(cap/'docker.sock')})
        gate=Gate(gate_spec,daemon,NamespacePeer(gate_spec));gate.attempted=RecordedMap(journal,'attempts');gate.containers=RecordedMap(journal,'containers');gate_server=Server(str(cap/'docker.sock'),gate);gate_thread=threading.Thread(target=gate_server.serve_forever);gate_thread.start()
        def peer(connection):
            import struct
            pid,uid,_=struct.unpack('3i',connection.getsockopt(__import__('socket').SOL_SOCKET,__import__('socket').SO_PEERCRED,12));need(uid==os.getuid()and process(pid)['cgroup']==lease.line,'byte bridge peer outside owned cgroup')
        for port in PORTS:
            server=FixedServer(cap,port,True,peer,deadline,slots,bridge_rows.append,target_lease=lambda port=port:gate.endpoint_lease(port,cancelled));servers.append(server);server.start()
        inner_spec={'parent_spec':spec_pin,'deadline_receipt':clock_pin,'policy':policy_pin,'original_deadline_ns':deadline,'pins':spec['namespace_pins'],'python':spec['python'],'cache_server':spec['cache_server'],'capability_root':str(cap),'exact_node_argv':exact_node_argv}
        inner_pin=write(readonly/'inner.json',inner_spec)
        argv=policy_code.namespace_argv(bwrap,spec['readonly_roots']+[str(readonly),spec_pin['path']],{'control':str(control),'task':str(data)},str(cap),python,str(checked(spec['inner'])),inner_pin['path'])+['--spec-sha',inner_pin['sha256']]
        result['argv']=argv;result['clock_receipt']=clock_pin;birth=launch(argv,'case');need(wait_child('case',birth)==0,'actual isolated Aleo case failed');pidfd=None
        inner_result=decode((control/'inner-result.json').read_bytes());need(inner_result['passed']is True and not inner_result.get('error'),'namespace proof/cleanup failed')
        need(gate.node_identity is not None and len(gate.containers)==3,'all exact positive node/PG custody required')
        result['actual_case_completed_monotonic_ns']=time.monotonic_ns()
        actual=decode((data/'case/result.json').read_bytes());result['case_result']=pin(data/'case/result.json');result['case_verdict']=actual.get('passed')is True and actual.get('errors')==[]
        need(result['case_verdict'],'dedicated TS actual final proof failed')
    except BaseException as error:result['error']=type(error).__name__+':'+str(error)
    finally:
        cleanup=[]
        # Each positively owned cleanup phase runs even when an earlier phase
        # fails. Preserve the primary case error; never convert cleanup to proof.
        def phase(name,action):return cleanup_phase(cleanup,name,action)
        def stop_direct():
            if child is not None and child.poll()is None:
                need(pidfd is not None,'direct child lacks exact pidfd custody')
                for signum,seconds in ((signal.SIGINT,15),(signal.SIGTERM,5)):
                    if child.poll()is not None:break
                    try:signal.pidfd_send_signal(pidfd,signum)
                    except ProcessLookupError:pass
                    result['signals'].append({'actual_pidfd_signal':signum,'pid':child.pid})
                    try:child.wait(timeout=seconds)
                    except subprocess.TimeoutExpired:pass
                if child.poll()is None:
                    try:signal.pidfd_send_signal(pidfd,signal.SIGKILL)
                    except ProcessLookupError:pass
                    result['signals'].append({'actual_pidfd_signal':signal.SIGKILL,'pid':child.pid})
        phase('direct-stop',stop_direct)
        def wait_direct():
            if child is not None:
                code=child.wait(timeout=10)
                if not any(row['pid']==child.pid for row in result['direct_waits']):result['direct_waits'].append({'phase':'failed-child','pid':child.pid,'actual_parent_wait':True,'exit_code':code})
        phase('direct-wait',wait_direct)
        if pidfd is not None:phase('pidfd-close',lambda:os.close(pidfd))
        def stop_leaf():
            if lease is not None:
                reap_terminal(lease,orphan_waits)
                if lease.populated():lease.kill_owned();result['signals'].append({'actual_owned_cgroup_kill':str(lease.path)})
        phase('leaf-stop',stop_leaf)
        def drain_leaf():
            if lease is not None:
                end=time.monotonic()+10
                while time.monotonic()<end:
                    reap_terminal(lease,orphan_waits)
                    if not lease.populated():break
                    time.sleep(.05)
                result['owned_absent']=not lease.populated();need(result['owned_absent'],'owned descendants remain')
                result['actual_leaf_caps_after']={name:lease.read(name)for name in ('memory.max','memory.swap.max','pids.max')}
                need(result['actual_leaf_caps_after']==result['actual_leaf_caps_before'],'case leaf caps changed')
                lease.remove()
        phase('leaf-drain',drain_leaf)
        cleanup_started=time.monotonic_ns();cleanup_deadline=cleanup_started+120*10**9
        result['API_cleanup_started_ns']=cleanup_started;result['API_cleanup_deadline_ns']=cleanup_deadline
        if gate_server is not None:
            try:result['API_server_cleanup']=gate_server.close_bounded(gate_thread,min(cleanup_deadline,time.monotonic_ns()+12*10**9))
            except Exception as error:cleanup.append(str(error))
        if daemon is not None:daemon.deadline_ns=cleanup_deadline
        if gate is not None:
            result['gate_failed']=gate.failed;result['Docker_calls']=gate.calls;result['actual_main_node_identity']=gate.node_identity
            try:result['container_cleanup']=gate.cleanup()
            except Exception as error:cleanup.append('containers: '+str(error));result['container_cleanup']={'passed':False,'error_type':type(error).__name__}
        if network is not None:
            try:result['network_cleanup']=network.close()
            except Exception as error:cleanup.append(str(error))
        for server in reversed(servers):
            try:close_bridge_bounded(server,min(cleanup_deadline,time.monotonic_ns()+5*10**9))
            except Exception as error:cleanup.append(str(error))
        result['bridge_records']=bridge_rows;result['bridges_joined']=not cleanup and all(not row.get('failure')and(row.get('both_pump_threads_joined')is True or(row.get('actual_owned_endpoint_connect_refused')is True and row.get('pump_threads_started')==0 and row.get('reply_or_parent_wait_credit')is False))for row in bridge_rows)
        try:
            for row in spec['pins']+spec['namespace_pins']:checked(row)
            checked(spec_pin);result['source_unchanged']=True
        except Exception as error:cleanup.append(str(error));result['source_unchanged']=False
        try:
            context=load(spec['delegation_context']);manager=Path(context['root'])/'manager'
            result['actual_manager_limits_after']={name:(manager/name).read_text().strip()for name in ('memory.max','memory.swap.max','pids.max')}
            need(result['actual_manager_limits_after']=={'memory.max':str(CAPS['owner_memory_bytes']),'memory.swap.max':'0','pids.max':'128'},'actual manager limits changed')
        except BaseException as error:cleanup.append('manager limits:'+type(error).__name__)
        if result.get('case_verdict')is True and not result.get('error'):
            try:result['fixture_dependency_adapter']=xhr_adapter_provenance(spec,control)
            except BaseException as error:result['error']='XHR adapter provenance:'+type(error).__name__
        result['cleanup_errors']=cleanup;result['passed']=final_pass(result);result['finished_ns']=time.monotonic_ns()
        # Final public proof is published only by case_delegate after its actual
        # systemd-client wait and positive cgroup absence, not inside the unit.
        write(root/'result.json',result)
    return 0 if result['passed']else 1


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--execute-case',action='store_true');parser.add_argument('--spec');parser.add_argument('--spec-sha');parser.add_argument('--bootstrap');args=parser.parse_args()
    if args.bootstrap:bootstrap(json.loads(args.bootstrap));return 1
    need(args.execute_case and args.spec and args.spec_sha,'inert: explicit authorized case required')
    path=Path(args.spec);raw=path.read_bytes();need(hashlib.sha256(raw).hexdigest()==args.spec_sha,'approved case spec changed')
    return run({'path':str(path),'bytes':len(raw),'sha256':args.spec_sha})


if __name__=='__main__':raise SystemExit(main())
