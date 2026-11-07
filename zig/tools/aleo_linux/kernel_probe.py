"""Explicit Linux prerequisite microprobe. Default inert; no SDK/Docker/node."""
import argparse
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import platform
import signal
import socket
import subprocess
import sys
import threading
import time

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
from receipts import checked, decode, load, need
from loopback_bridge import FixedServer, PORTS


def pin(path):
    return {'path':str(path),'bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}


def process(pid):
    root=Path('/proc')/str(pid)
    raw=(root/'stat').read_text();fields=raw[raw.rfind(')')+2:].split()
    row={'pid':pid,'state':fields[0],'parent':int(fields[1]),'group':int(fields[2]),'start':int(fields[19]),'cgroup':(root/'cgroup').read_text()}
    try:row['exe']=str((root/'exe').readlink())
    except FileNotFoundError:
        fresh=(root/'stat').read_text();values=fresh[fresh.rfind(')')+2:].split()
        need(int(values[19])==row['start'] and values[0] in {'Z','X'},'live process executable unavailable')
        row['state']=values[0];row['exe']=None
    return row


class Lease:
    """One fresh child cgroup in the current delegated job; no parent mutation."""
    def __init__(self, token, memory, pids):
        need(platform.system()=='Linux' and len(token)==32 and all(c in '0123456789abcdef'for c in token),'Linux fresh token required')
        line=Path('/proc/self/cgroup').read_text().strip();need(line.startswith('0::/')and '\n'not in line,'unified cgroup v2 required')
        parent=Path('/sys/fs/cgroup')/line[4:];need(parent.resolve()==parent and (parent/'cgroup.controllers').is_file(),'actual delegated unified cgroup required')
        self.path=parent/('ziggy-aleo-'+token);self.path.mkdir();self.identity=(self.path.stat().st_dev,self.path.stat().st_ino)
        self.line='0::/'+str(self.path.relative_to('/sys/fs/cgroup'))+'\n'
        try:
            self.write('memory.max',str(memory));self.write('memory.swap.max','0');self.write('pids.max',str(pids))
            need(self.read('memory.max')==str(memory) and self.read('pids.max')==str(pids),'actual kernel limits not applied')
        except Exception:
            # No child can have been attached before construction returns.
            need(not self.populated(),'unexpected task in newly created cgroup')
            self.path.rmdir()
            raise

    def verify(self):need((self.path.stat().st_dev,self.path.stat().st_ino)==self.identity,'cgroup lease replaced')
    def read(self,name):self.verify();return (self.path/name).read_text().strip()
    def write(self,name,value):self.verify();(self.path/name).write_text(value)
    def attach(self,pid):self.write('cgroup.procs',str(pid));need(process(pid)['cgroup']==self.line,'child did not join bounded leaf')
    def live(self):return [int(v)for v in self.read('cgroup.procs').split()]
    def populated(self):return dict(line.split()for line in self.read('cgroup.events').splitlines())['populated']=='1'
    def kill_owned(self):self.write('cgroup.kill','1')
    def remove(self):need(not self.populated(),'live cgroup cannot be removed');self.path.rmdir()


def reap_terminal(lease, records):
    # Actual kernel-owned children only. Never wait or signal a guessed PID.
    children=Path('/proc/self/task',str(os.getpid()),'children').read_text().split()
    for value in children:
        pid=int(value)
        try:row=process(pid)
        except FileNotFoundError:continue
        if row['state'] not in {'Z','X'}:continue
        need(row['cgroup']==lease.line,'terminal adopted child escaped bounded leaf')
        waited,status,usage=os.wait4(pid,os.WNOHANG)
        if waited:
            records.append({'pid':pid,'start':row['start'],'group':row['group'],'raw_wait_status':status,'exit_code':os.waitstatus_to_exitcode(status),'actual_wait4':True,'direct_or_adopted_kernel_child':True,'not_performance_credit':True})


def bootstrap(argv):
    need(sys.stdin.buffer.readline(4)==b'GO\n','owned cgroup GO barrier missing')
    libc=ctypes.CDLL(None,use_errno=True)
    need(libc.prctl(38,1,0,0,0)==0,'NoNewPrivs unavailable')
    os.execve(argv[0],argv,dict(os.environ))


def held_child(control):
    signal.signal(signal.SIGINT,signal.SIG_IGN);signal.signal(signal.SIGTERM,signal.SIG_IGN)
    child=os.fork()
    if child==0:
        os.setsid()
        while True:time.sleep(1)
    (Path(control)/'held-ready.json').write_text(json.dumps({'parent':os.getpid(),'child':child}))
    while True:time.sleep(1)


def inner(args):
    need(platform.system()=='Linux'and platform.machine()=='x86_64','native amd64 Linux required')
    status={line.split(':',1)[0]:line.split(':',1)[1].strip()for line in Path('/proc/self/status').read_text().splitlines()if ':'in line}
    need(status['NoNewPrivs']=='1'and int(status['CapEff'],16)==0,'NoNewPrivs/zero capabilities required')
    need(os.readlink('/proc/self/ns/net')!=args.host_net,'host network namespace leaked')
    need(os.readlink('/proc/self/ns/time')==args.host_time,'unexpected Python time namespace change')
    need(not Path('/proc/net/route').read_text().splitlines()[1:],'private namespace has outside route')
    need(not Path(args.hidden).exists()and not Path('/var/run/docker.sock').exists(),'host private/socket path visible')
    for destination in [('192.0.2.1',9),('198.51.100.1',443)]:
        with socket.socket()as connection:
            connection.settimeout(.2)
            try:connection.connect(destination)
            except OSError as error:need(error.errno in {errno.ENETUNREACH,errno.EHOSTUNREACH},'outside network did not fail closed')
            else:raise ValueError('outside TCP usable')
    before=Path(args.sentinel).read_bytes()
    try:Path(args.sentinel).write_bytes(b'probe-must-not-write')
    except OSError as error:need(error.errno in {errno.EROFS,errno.EACCES},'unexpected readonly failure')
    else:raise ValueError('readonly micro sentinel writable')
    need(Path(args.sentinel).read_bytes()==before,'micro sentinel changed')
    libc=ctypes.CDLL(None,use_errno=True)
    need(libc.unshare(0x10000000)!=0 and ctypes.get_errno()in {errno.EPERM,errno.EINVAL},'nested user namespace usable')
    need(os.getpid()==1,'private PID namespace/init missing')
    records=[];bridges=[];slots=threading.BoundedSemaphore(32)
    try:
        for port in PORTS:
            server=FixedServer(args.cap_root,port,False,None,args.deadline_python_ns,slots,records.append);server.start();bridges.append(server)
        control=Path(args.control_root);(control/'ready.json').write_text(json.dumps({'pid':os.getpid(),'private_namespace':True}))
        while not (control/'GO').exists():need(time.monotonic_ns()<args.deadline_python_ns,'micro mapping handshake deadline');time.sleep(.02)
        for port in PORTS:
            payload=('owned-half-close-'+str(port)).encode()
            with socket.create_connection(('127.0.0.1',port),timeout=2)as connection:
                connection.sendall(payload);connection.shutdown(socket.SHUT_WR);received=b''
                while True:
                    chunk=connection.recv(128)
                    if not chunk:break
                    received+=chunk;need(len(received)<=128,'micro byte cap')
                need(received==b'REPLY:'+payload,'fixed bridge changed bytes or half-close')
    finally:
        for server in reversed(bridges):server.close()
    need(len(records)==3 and all(row.get('both_pump_threads_joined')is True for row in records),'three inner byte channels did not drain')
    child=os.fork()
    if child==0:
        if os.fork()==0:os.setsid();os._exit(0)
        os._exit(0)
    waited,status=os.waitpid(child,0);need(waited==child and os.waitstatus_to_exitcode(status)==0,'direct micro child wait failed')
    adopted,adopted_status=os.waitpid(-1,0);need(adopted>0 and os.waitstatus_to_exitcode(adopted_status)==0,'terminal setsid orphan was not reaped normally')
    print(json.dumps({'schema':1,'private_network':True,'NoNewPrivs':True,'zero_capabilities':True,'no_outside_route':True,'outside_TCP_denied':True,'private_PID1':True,'host_UNIX_hidden':True,'readonly_owned_sentinel':True,'nested_userns_disabled':True,'same_python_time_namespace':True,'three_byte_halfclose_channels':True,'actual_terminal_adopted_wait':{'pid':adopted,'raw_status':adopted_status,'actual_waitpid':True},'SDK_or_native_credit':False}))


def probe(spec_pin):
    spec=load(spec_pin)
    need(spec.get('schema')==1 and spec.get('root_approved')is True and spec.get('purpose')=='aleo-linux-kernel-probe-v1','explicit microprobe authorization required')
    need(platform.system()=='Linux'and platform.machine()=='x86_64','actual native Linux required')
    for entry in spec['pins']:checked(entry)
    root=Path(spec['output']);need(root.is_absolute()and not root.exists()and root.parent.resolve()==root.parent,'new canonical micro output required');root.mkdir(mode=0o700)
    memory=int(next(line.split()[1]for line in Path('/proc/meminfo').read_text().splitlines()if line.startswith('MemTotal:')))*1024
    need(not root.is_relative_to(HERE),'micro private output must remain outside readonly code mount')
    sentinel=root/'readonly-sentinel';sentinel.write_bytes(b'owned micro sentinel');hidden=root/'hidden-host-only';hidden.write_bytes(b'owned visibility sentinel')
    control=root/'control';control.mkdir(mode=0o700);caps=root/'capabilities';caps.mkdir(mode=0o700)
    bwrap=str(checked(spec['bwrap']));python=str(checked(spec['python']));code=Path(__file__).resolve()
    need(pin(code)in spec['pins'],'exact micro Source pin required')
    original_deadline=time.monotonic_ns()+120*10**9
    argv=[bwrap,'--unshare-user','--unshare-net','--unshare-pid','--unshare-ipc','--unshare-uts','--disable-userns','--assert-userns-disabled','--die-with-parent','--new-session','--cap-drop','ALL','--clearenv','--ro-bind','/usr','/usr','--symlink','usr/bin','/bin','--symlink','usr/lib','/lib','--symlink','usr/lib64','/lib64','--proc','/proc','--dev','/dev','--ro-bind',str(HERE),str(HERE),'--ro-bind',str(sentinel),str(sentinel),'--ro-bind',str(caps),str(caps),'--bind',str(control),str(control),'--remount-ro','/','--',python,'-I','-B',str(code),'--inner','--host-net',os.readlink('/proc/self/ns/net'),'--host-time',os.readlink('/proc/self/ns/time'),'--hidden',str(hidden),'--sentinel',str(sentinel),'--cap-root',str(caps),'--control-root',str(control),'--deadline-python-ns',str(original_deadline)]
    result={'schema':1,'passed':False,'kind':'aleo-linux-kernel-prerequisite-v1','spec':spec_pin,'finished_monotonic_ns':None,'SDK_or_native_credit':False,'MemTotal_bytes':memory,'boot_id':Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'kernel_release':platform.release(),'commands':[]};child=None;lease=None;waits=[];forced=False;start=time.monotonic();servers=[];dummies=[];dummy_threads=[];bridge_records=[];stop=threading.Event();slots=threading.BoundedSemaphore(32);pidfd=None
    try:
        need(memory>=32*1024**3 and os.statvfs(root).f_bavail*os.statvfs(root).f_frsize>=6*1024**3,'actual32GiB/free6 floor required')
        libc=ctypes.CDLL(None,use_errno=True);need(libc.prctl(36,1,0,0,0)==0,'subreaper required')
        lease=Lease(spec['run_token'],256*1024**2,32)
        def peer_check(connection):
            import struct
            pid,_,_=struct.unpack('3i',connection.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12));need(process(pid)['cgroup']==lease.line,'non-owned capability peer')
        def dummy(listener):
            listener.settimeout(.2)
            while not stop.is_set():
                try:connection,_=listener.accept()
                except socket.timeout:continue
                except OSError:return
                with connection:
                    connection.settimeout(2);data=b''
                    while True:
                        chunk=connection.recv(128)
                        if not chunk:break
                        data+=chunk;need(len(data)<=128,'dummy byte cap')
                    connection.sendall(b'REPLY:'+data)
        for port in PORTS:
            listener=socket.socket();listener.bind(('127.0.0.1',port));listener.listen(4);dummies.append(listener)
            thread=threading.Thread(target=dummy,args=(listener,));thread.start();dummy_threads.append(thread)
            server=FixedServer(caps,port,True,peer_check,original_deadline,slots,bridge_records.append);server.start();servers.append(server)
        env={'PATH':'/usr/bin:/bin','HOME':str(root),'TMPDIR':str(root),'LC_ALL':'C','PYTHONNOUSERSITE':'1','PYTHONDONTWRITEBYTECODE':'1'}
        with (root/'stdout.log').open('xb')as out,(root/'stderr.log').open('xb')as err:
            child=subprocess.Popen([python,'-I','-B',str(code),'--bootstrap',json.dumps(argv)],stdin=subprocess.PIPE,stdout=out,stderr=err,env=env,start_new_session=True)
            lease.attach(child.pid);birth=process(child.pid);pidfd=os.pidfd_open(child.pid);child.stdin.write(b'GO\n');child.stdin.flush();child.stdin.close()
            mapped=False
            while child.poll()is None:
                need(time.monotonic()-start<=120,'micro whole120s cap');need(int(lease.read('memory.current'))<=256*1024**2,'micro RSS/cgroup cap')
                need(sum(p.stat().st_size for p in root.iterdir()if p.is_file())<=16*1024**2,'micro output cap')
                if not mapped and (control/'ready.json').exists():
                    matches=[]
                    for pid in lease.live():
                        try:
                            row=process(pid);status=(Path('/proc')/str(pid)/'status').read_text();line=next(line for line in status.splitlines()if line.startswith('NSpid:'));ids=[int(x)for x in line.split()[1:]]
                            if len(ids)>1 and ids[-1]==1 and row['exe']==python:matches.append(dict(row,namespace_pids=ids))
                        except FileNotFoundError:continue
                    need(len(matches)==1,'exact host→namespace PID1 mapping absent');result['actual_namespace_identity']=matches[0];(control/'GO').write_bytes(b'GO');mapped=True
                time.sleep(.1)
            code_value=child.wait();result['commands'].append({'argv':argv,'pid':child.pid,'start':birth['start'],'actual_parent_wait':True,'exit_code':code_value});need(code_value==0,'namespace micro failed')
        end=time.monotonic()+3
        while time.monotonic()<end:
            reap_terminal(lease,waits)
            if not lease.populated():break
            time.sleep(.05)
        need(not lease.populated(),'micro live descendants remain')
        verdict=decode((root/'stdout.log').read_bytes());need(all(value is True for key,value in verdict.items()if key not in {'schema','SDK_or_native_credit','actual_terminal_adopted_wait'}),'inner micro missing control')
        need(mapped and len(bridge_records)==3 and all(row.get('both_pump_threads_joined')is True for row in bridge_records),'host bridge/identity controls missing')
        with (root/'negative-stdout.log').open('xb')as out,(root/'negative-stderr.log').open('xb')as err:
            argv_held=[python,'-I','-B',str(code),'--held-child',str(control)]
            child=subprocess.Popen([python,'-I','-B',str(code),'--bootstrap',json.dumps(argv_held)],stdin=subprocess.PIPE,stdout=out,stderr=err,env=env,start_new_session=True)
            lease.attach(child.pid);held_birth=process(child.pid);child.stdin.write(b'GO\n');child.stdin.flush();child.stdin.close()
            ready_deadline=min(original_deadline,time.monotonic_ns()+5*10**9)
            while not (control/'held-ready.json').exists():need(child.poll()is None and time.monotonic_ns()<ready_deadline,'held-child control not ready');time.sleep(.02)
            need(process(child.pid)['start']==held_birth['start'],'held child identity changed')
            lease.kill_owned();code_held=child.wait(timeout=5);need(code_held==-signal.SIGKILL,'held direct child was not actually killed/waited')
            until=min(original_deadline,time.monotonic_ns()+5*10**9)
            while time.monotonic_ns()<until:
                reap_terminal(lease,waits)
                if not lease.populated():break
                time.sleep(.02)
            need(not lease.populated(),'setsid orphan escaped owned cgroup cleanup')
            result['negative_owner_cleanup']={'argv':argv_held,'pid':child.pid,'start':held_birth['start'],'actual_parent_wait':True,'exit_code':code_held,'expected_owned_cgroup_kill':True,'actual_adopted_waits':list(waits),'all_owned_absent':True,'foreign_signals':False,'not_a_native_case':True}
        result.update(passed=True,namespace=verdict,cgroup_v2_limits_applied=True,pidfd_open_supported=True,actual_terminal_waits=waits,all_owned_absent=True)
    except Exception as error:result['error']=type(error).__name__+':'+str(error)
    finally:
        cleanup_errors=[];stop.set()
        for listener in dummies:
            try:listener.close()
            except Exception as error:cleanup_errors.append(str(error))
        for server in reversed(servers):
            try:server.close()
            except Exception as error:cleanup_errors.append(str(error))
        for thread in dummy_threads:
            thread.join(3)
            if thread.is_alive():cleanup_errors.append('dummy thread did not join')
        if pidfd is not None:os.close(pidfd)
        try:
            if lease is not None:
                if lease.populated():lease.kill_owned();forced=True
                if child is not None:child.wait(timeout=10)
                reap_terminal(lease,waits)
                need(not lease.populated(),'micro cleanup left live owned members');lease.remove()
        except Exception as error:result['cleanup_error']=str(error);result['passed']=False
        try:
            for entry in spec['pins']:checked(entry)
        except Exception as error:result['inputs_changed']=str(error);result['passed']=False
        if cleanup_errors:result['cleanup_errors']=cleanup_errors;result['passed']=False
        result['forced_cleanup']=forced;result['passed']=result['passed']and not forced
        result['finished_monotonic_ns']=time.monotonic_ns()
        (root/'result.json').write_text(json.dumps(result,indent=2)+'\n')
    return 0 if result['passed']else 1


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--execute-probe',action='store_true');parser.add_argument('--spec');parser.add_argument('--spec-sha');parser.add_argument('--inner',action='store_true');parser.add_argument('--host-net');parser.add_argument('--host-time');parser.add_argument('--hidden');parser.add_argument('--sentinel');parser.add_argument('--cap-root');parser.add_argument('--control-root');parser.add_argument('--deadline-python-ns',type=int);parser.add_argument('--bootstrap');parser.add_argument('--held-child');args=parser.parse_args()
    if args.bootstrap:bootstrap(json.loads(args.bootstrap));return 1
    if args.inner:inner(args);return 0
    if args.held_child:held_child(args.held_child);return 1
    need(args.execute_probe and args.spec and args.spec_sha,'inert: explicit reviewed probe only')
    p=Path(args.spec);value=pin(p);need(value['sha256']==args.spec_sha,'micro spec changed');return probe(value)


if __name__=='__main__':raise SystemExit(main())
