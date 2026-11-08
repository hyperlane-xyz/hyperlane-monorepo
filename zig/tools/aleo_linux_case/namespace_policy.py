"""Inert Aleo Linux policy prototype. Pure construction only: no launcher/main."""
from pathlib import PurePosixPath
import re
GIB=1024**3
HOST_PORTS=(23030,23031,25432)
PRIVATE_PORTS=(23032,23033,23034,29091,29092,29093,29094)
NODES=('aleo_a','aleo_b')
CAPS={'aleo_a':(3*GIB,2_000_000_000,256),'aleo_b':(3*GIB,2_000_000_000,256),'postgres':(GIB//2,1_000_000_000,128)}
REQUIRED_KERNEL=('userns_net_pid_mount','loopback_only_no_route','private_proc','no_new_privs','nested_userns_disabled','outside_TCP_denied','host_UNIX_hidden','source_readonly','private_UNIX_roundtrip','cgroup_v2_delegated_memory_pids','same_host_Docker_filesystem','internal_network_egress_denied','namespace_to_host_PID_mapping')
def need(value,message):
    if not value:raise ValueError(message)
def path(value):
    need(isinstance(value,str),'Path string required');p=PurePosixPath(value)
    need(p.is_absolute() and str(p)==value and '..'not in p.parts,'Canonical absolute path required');return p
def clock_bridge(owner_ns,before_ns,after_ns,node_ns):
    need(all(type(x)is int and x>0 for x in (owner_ns,before_ns,after_ns,node_ns)) and before_ns<=after_ns<owner_ns,'Original unexpired clock observations required')
    need(owner_ns-before_ns<=10800*10**9,'Never mint more than original3h')
    return {'python_original_deadline_ns':owner_ns,'node_deadline_ns':node_ns+owner_ns-after_ns,'uncertainty_ns':after_ns-before_ns,'no_remint':True}
def routes(cap_root):
    base=path(cap_root)
    return [{'listen_host':'127.0.0.1','listen_port':port,'unix_socket':str(base/(str(port)+'.sock')),'host_target':['127.0.0.1',port]}for port in HOST_PORTS]
def namespace_argv(bwrap,readonly,writable,cap_root,inner_python,inner_entry,spec):
    # A filesystem policy, not a claim the target kernel supports it. All paths
    # must be full-SHA/canonical/nonsymlink checked before applying this plan.
    path(bwrap);path(inner_python);path(inner_entry);path(spec);cap=path(cap_root)
    need(set(writable)=={'control','task'},'Exactly two accounted writable roots')
    rw=[path(writable[k])for k in ('control','task')]
    need(all(p!=PurePosixPath('/') and cap!=p and not cap.is_relative_to(p)and not p.is_relative_to(cap) for p in rw),'Capabilities must be outside writable roots')
    need(not rw[0].is_relative_to(rw[1])and not rw[1].is_relative_to(rw[0]),'No overlapping accounted roots')
    ro=[path(p)for p in readonly]
    denied={'/','/home','/root','/run','/var','/tmp','/sys','/proc','/dev','/bin','/sbin','/lib','/lib64'}
    need(ro and len(ro)==len(set(ro)) and all(str(p)not in denied for p in ro),'No host root/credential/socket/proc mount')
    need(all(not p.is_relative_to(q)and not q.is_relative_to(p)for p in ro for q in rw+[cap]),'No overlapping readonly/writable/capability mounts')
    argv=[bwrap,'--unshare-user','--unshare-net','--unshare-pid','--as-pid-1','--unshare-ipc','--unshare-uts','--disable-userns','--assert-userns-disabled','--die-with-parent','--new-session','--cap-drop','ALL','--clearenv','--proc','/proc','--dev','/dev','--size',str(64*1024**2),'--tmpfs','/tmp','--size',str(64*1024**2),'--tmpfs','/dev/shm']
    need(PurePosixPath('/usr') in ro,'Pinned Ubuntu merged-/usr runtime required')
    for alias,target in {'/bin':'usr/bin','/sbin':'usr/sbin','/lib':'usr/lib','/lib64':'usr/lib64'}.items():argv+=['--symlink',target,alias]
    for p in ro:argv+=['--ro-bind',str(p),str(p)]
    for p in rw:argv+=['--bind',str(p),str(p)]
    argv+=['--ro-bind',str(cap),str(cap)]
    env={'PATH':'/usr/bin:/bin','HOME':str(rw[0]/'home'),'TMPDIR':str(rw[0]/'tmp'),'LC_ALL':'C.UTF-8','PYTHONNOUSERSITE':'1','PYTHONDONTWRITEBYTECODE':'1'}
    for key,value in env.items():argv+=['--setenv',key,value]
    return argv+['--remount-ro','/','--remount-ro','/proc','--chdir',str(rw[0]),'--',inner_python,'-I','-B',inner_entry,'--spec',spec]
