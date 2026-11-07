"""Explicit task-owned systemd delegation; payload remains the unprivileged runner."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import signal
import subprocess
import sys
import time

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
import kernel_probe
from receipts import checked, load, need

MEMORY=384*1024**2
TASKS=64
PROPERTIES={'Delegate':'yes','DelegateSubgroup':'manager','MemoryMax':str(MEMORY),'MemorySwapMax':'0','TasksMax':str(TASKS),'KillMode':'control-group','NoNewPrivileges':'yes','Transient':'yes','RuntimeMaxUSec':'2min 30s','TimeoutStopUSec':'15s'}
QUERY=('Id','Description','InvocationID','User','Group','ControlGroup','DelegateControllers','LoadState','ActiveState','SubState',*PROPERTIES)


class TaskInterrupted(RuntimeError):
    """Cancellation must propagate through stdlib EINTR retry handlers."""
    pass


def atomic(path,value):
    """Exclusive fsynced public receipt: never replace a prior ownership record."""
    raw=(json.dumps(value,sort_keys=True,indent=2)+'\n').encode()
    temporary=path.with_name(path.name+'.tmp')
    fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    try:
        with os.fdopen(fd,'wb')as stream:stream.write(raw);stream.flush();os.fsync(stream.fileno())
        os.link(temporary,path);temporary.unlink()
        directory=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
        try:os.fsync(directory)
        finally:os.close(directory)
    finally:
        if temporary.exists():temporary.unlink()


def approved(spec):
    need(spec.get('schema')==1 and spec.get('root_approved')is True and spec.get('purpose')=='aleo-linux-kernel-probe-v1' and 'delegation'not in spec,'explicit initial kernel authority required')
    rows=spec.get('pins');names={'kernel_probe.py','kernel_delegate.py','loopback_bridge.py','receipts.py'}
    need(type(rows)is list and len(rows)==len(names) and {row.get('path')for row in rows}=={str(HERE/name)for name in names},'exact reviewed kernel Source closure required')
    for row in rows:checked(row)
    return spec


def identity(spec):
    token=spec.get('run_token');need(type(token)is str and re.fullmatch('[a-f0-9]{32}',token),'exact fresh token required')
    need(os.getuid()>0 and os.geteuid()==os.getuid()and os.getgid()==os.getegid(),'unprivileged runner required')
    return 'ziggy-aleo-kernel-'+token+'.service'


def command(argv,timeout=5):
    result=subprocess.run(argv,env={'PATH':'/usr/bin:/bin','LC_ALL':'C.UTF-8'},capture_output=True,timeout=timeout)
    need(len(result.stdout)+len(result.stderr)<=1024**2,'bounded systemd response required')
    return result


def tools(spec):
    rows=spec.get('delegation_tools');need(type(rows)is dict and set(rows)=={'systemd-run','systemctl','sudo'},'closed delegation tool set required')
    out={name:str(checked(pin))for name,pin in rows.items()}
    need(all(Path(path).parent==Path('/usr/bin')and Path(path).name==name for name,path in out.items()),'fixed system tools required')
    return out


def show(executable,unit):
    result=command([executable,'show',unit,'--no-pager','--property='+','.join(QUERY)])
    text=result.stdout.decode('utf-8',errors='strict');rows={}
    for line in text.splitlines():
        key,sep,value=line.partition('=');need(sep and key in QUERY and key not in rows,'exact systemd property response required');rows[key]=value
    if rows.get('LoadState')=='not-found':return None
    need(result.returncode==0 and set(rows)==set(QUERY),'complete systemd identity response required')
    return rows


def owned(rows,spec,invocation=None,allow_stopped=False):
    unit=identity(spec)
    need(type(rows)is dict and rows.get('Id')==unit and rows.get('Description')==unit,'foreign unit identity')
    need(rows.get('User')==str(os.getuid())and rows.get('Group')==str(os.getgid()),'foreign unit UID/GID')
    stopped=allow_stopped and invocation is not None and rows.get('ActiveState')in {'inactive','failed'} and rows.get('ControlGroup')==''
    need(stopped or rows.get('ControlGroup')=='/system.slice/'+unit,'foreign cgroup path')
    need(re.fullmatch('[0-9a-f]{32}',rows.get('InvocationID',''))is not None,'missing actual invocation')
    if invocation is not None:need(rows['InvocationID']==invocation,'unit invocation replaced')
    need(set(rows.get('DelegateControllers','').split())=={'memory','pids'},'actual delegated memory/pids missing')
    for key,value in PROPERTIES.items():need(rows.get(key)==value,'actual unit property differs: '+key)
    return rows['InvocationID']


def checked_context(value,spec):
    keys={'unit','invocation','uid','gid','root','root_dev','root_ino','manager_dev','manager_ino','boot_id'}
    need(type(value)is dict and set(value)==keys,'exact service custody required')
    need(value['unit']==identity(spec)and value['root']=='/sys/fs/cgroup/system.slice/'+identity(spec),'service custody path differs')
    need(type(value['uid'])is int and value['uid']==os.getuid()and type(value['gid'])is int and value['gid']==os.getgid(),'service custody UID/GID differs')
    need(type(value['invocation'])is str and re.fullmatch('[0-9a-f]{32}',value['invocation'])is not None,'service custody invocation missing')
    need(all(type(value[key])is int and value[key]>=0 for key in ('root_dev','root_ino','manager_dev','manager_ino')),'typed custody inode required')
    need(value['boot_id']==Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'service custody boot differs')
    return value


def launch_argv(spec,tool,spec_pin):
    unit=identity(spec);python=str(checked(spec['python']))
    return [tool['sudo'],'-n',tool['systemd-run'],'--unit='+unit,'--description='+unit,'--service-type=exec','--uid='+str(os.getuid()),'--gid='+str(os.getgid()),'--wait','--pipe','--property=Delegate=memory pids','--property=DelegateSubgroup=manager','--property=MemoryMax='+str(MEMORY),'--property=MemorySwapMax=0','--property=TasksMax='+str(TASKS),'--property=RuntimeMaxSec=150','--property=TimeoutStopSec=15','--property=KillMode=control-group','--property=NoNewPrivileges=yes',python,'-I','-B',str(Path(__file__).resolve()),'--inside','--spec',spec_pin['path'],'--spec-sha',spec_pin['sha256']]


def prepare_inside(spec,unit,fsroot=Path('/sys/fs/cgroup')):
    need(platform.system()=='Linux'and platform.machine()=='x86_64','native Linux amd64 required')
    need(Path('/proc/self/cgroup').read_text()=='0::/system.slice/'+unit+'/manager\n','payload not in exact manager subgroup')
    root=fsroot/'system.slice'/unit;manager=root/'manager'
    need(root.resolve()==root and manager.resolve()==manager,'canonical delegated paths required')
    need(not (root/'cgroup.procs').read_text().split(),'delegated root not empty')
    need((manager/'cgroup.procs').read_text().split()==[str(os.getpid())],'foreign manager task')
    need({'memory','pids'}<=set((root/'cgroup.controllers').read_text().split()),'kernel controllers not delegated')
    enabled=set((root/'cgroup.subtree_control').read_text().split());need(enabled<={'memory','pids'},'unexpected delegated controllers')
    for path in (root,manager):need(path.stat().st_uid==os.getuid(),'delegated path not owned by runner')
    # Write only the positively owned delegated root's subtree partition, never its caps or a host ancestor.
    (root/'cgroup.subtree_control').write_text('+memory +pids')
    need({'memory','pids'}<=set((root/'cgroup.subtree_control').read_text().split()),'delegated controllers not enabled')
    return root,manager


def inside(spec_pin):
    spec=approved(load(spec_pin))
    unit=identity(spec);tool=tools(spec);rows=show(tool['systemctl'],unit);invocation=owned(rows,spec)
    need(os.environ.get('INVOCATION_ID')==invocation,'actual systemd invocation differs')
    root=Path('/sys/fs/cgroup/system.slice')/unit;manager=root/'manager'
    need(root.resolve()==root and manager.resolve()==manager,'canonical delegated paths required')
    context={'unit':unit,'invocation':invocation,'uid':os.getuid(),'gid':os.getgid(),'root':str(root),'root_dev':root.stat().st_dev,'root_ino':root.stat().st_ino,'manager_dev':manager.stat().st_dev,'manager_ino':manager.stat().st_ino,'boot_id':Path('/proc/sys/kernel/random/boot_id').read_text().strip()}
    need(root.stat().st_uid==os.getuid()and manager.stat().st_uid==os.getuid(),'delegated inode UID differs')
    directory=Path(spec['output']).with_suffix('.owner')
    atomic(directory/'delegation.json',context)
    prepare_inside(spec,unit)
    kernel_probe.delegated_parent(context,spec['run_token'])
    delegated=dict(spec,delegation=context)
    atomic(directory/'delegated.spec.json',delegated)
    return kernel_probe.probe(kernel_probe.pin(directory/'delegated.spec.json'))


def cleanup(spec,tool,context):
    """Stop only positively matched transient service, then require actual root absence."""
    if context is not None:checked_context(context,spec)
    rows=show(tool['systemctl'],identity(spec))
    root=Path('/sys/fs/cgroup/system.slice')/identity(spec)
    if rows is not None:
        need(context is not None,'no positive service custody; preserve unclaimed unit')
        owned(rows,spec,context['invocation'],allow_stopped=True)
        if root.exists():
            need((root.stat().st_dev,root.stat().st_ino)==(context['root_dev'],context['root_ino']),'owned cgroup replaced')
        # Exact positively identified owned unit only; systemd supplies the subtree lifecycle.
        if rows['ActiveState']not in {'inactive','failed'} or root.exists():
            stopped=command([tool['sudo'],'-n',tool['systemctl'],'stop',identity(spec)],timeout=17)
            need(stopped.returncode==0,'owned unit stop failed')
    need(not root.exists(),'owned unit cgroup remains')
    return {'owned_cgroup_absent':True,'systemd_stop_is_not_parent_wait':True,'native_credit':False}


def execute(spec_pin):
    spec=approved(load(spec_pin))
    need(platform.system()=='Linux'and platform.machine()=='x86_64','native Linux amd64 required')
    unit=identity(spec);tool=tools(spec);directory=Path(spec['output']).with_suffix('.owner')
    need(directory.is_absolute()and directory.parent.resolve()==directory.parent and not Path(spec['output']).exists(),'canonical fresh owner/probe output required');directory.mkdir(mode=0o700)
    receipt={'schema':1,'kind':'aleo-linux-kernel-delegation-v1','passed':False,'unit':unit,'original_spec':spec_pin,'SDK_or_native_credit':False,'client_actual_wait':None,'cleanup':None,'capabilities':{}}
    child=None;context=None;created=False;started=time.monotonic()
    try:
        controllers=Path('/sys/fs/cgroup/cgroup.controllers').read_text().split()
        need({'memory','pids'}<=set(controllers),'host memory/pids controllers unavailable')
        version=command([tool['systemd-run'],'--version']);need(version.returncode==0,'systemd version unavailable')
        match=re.match(rb'systemd ([0-9]+)',version.stdout);need(match and int(match[1])>=254,'systemd254 DelegateSubgroup required')
        bwrap=str(checked(spec['bwrap']));bwrap_version=command([bwrap,'--version'])
        need(bwrap_version.returncode==0 and len(bwrap_version.stdout)<=256 and len(bwrap_version.stderr)<=256,'bounded actual bwrap version unavailable')
        text=bwrap_version.stdout.decode('utf-8',errors='strict');need(re.fullmatch(r'bubblewrap [0-9]+(?:\.[0-9]+){1,3}\n',text)is not None,'unexpected actual bwrap version')
        receipt['capabilities']={'bwrap':spec['bwrap'],'bwrap_version':text.strip(),'root_controllers':controllers,'systemd_version':version.stdout.decode(),'runner_cgroup':Path('/proc/self/cgroup').read_text(),'boot_id':Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'uid':os.getuid(),'gid':os.getgid()}
        need(show(tool['systemctl'],unit)is None,'preserve preexisting systemd unit')
        argv=launch_argv(spec,tool,spec_pin);receipt['argv']=argv
        with(directory/'stdout.log').open('xb')as out,(directory/'stderr.log').open('xb')as err:
            child=subprocess.Popen(argv,stdout=out,stderr=err,stdin=subprocess.DEVNULL,env={'PATH':'/usr/bin:/bin','LC_ALL':'C.UTF-8'},start_new_session=True)
            # A unit is never stopped merely because this client PID exists; cleanup re-admits manager identity.
            created=True
            while child.poll()is None:
                need(time.monotonic()-started<155,'delegation owner deadline')
                need(sum(path.stat().st_size for path in directory.iterdir()if path.is_file())<=16*1024**2,'owner output cap')
                time.sleep(.1)
            code=child.wait();receipt['client_actual_wait']={'pid':child.pid,'exit_code':code,'actual_parent_wait':True,'waits_for_systemd_client_only':True}
            need(code==0,'delegated kernel service failed')
        result=load(kernel_probe.pin(Path(spec['output'])/'result.json'))
        need(result.get('passed')is True and result.get('SDK_or_native_credit')is False,'actual successful kernel receipt required')
        context=checked_context(load(kernel_probe.pin(directory/'delegation.json')),spec)
        delegated_pin=kernel_probe.pin(directory/'delegated.spec.json');delegated=load(delegated_pin)
        need(delegated==dict(spec,delegation=context) and result['spec']==delegated_pin,'kernel result/delegation binding differs')
        receipt['kernel_result']=kernel_probe.pin(Path(spec['output'])/'result.json')
        receipt['passed']=True
    except BaseException as error:
        receipt['error']=type(error).__name__+':'+str(error)
    finally:
        errors=[]
        try:
            marker=directory/'delegation.json'
            if marker.exists():
                fresh=checked_context(load(kernel_probe.pin(marker)),spec)
                need(context is None or context==fresh,'first delegation custody changed');context=fresh
        except BaseException as error:errors.append('custody:'+type(error).__name__+':'+str(error))
        try:
            if created:receipt['cleanup']=cleanup(spec,tool,context)
        except BaseException as error:errors.append('cleanup:'+type(error).__name__+':'+str(error))
        try:
            if child is not None:
                code=child.wait(timeout=18);receipt['client_actual_wait']={'pid':child.pid,'exit_code':code,'actual_parent_wait':True,'waits_for_systemd_client_only':True}
        except BaseException as error:errors.append('client_wait:'+type(error).__name__+':'+str(error))
        try:
            for entry in spec['pins']:checked(entry)
            for entry in spec['delegation_tools'].values():checked(entry)
        except BaseException as error:errors.append('input_rehash:'+type(error).__name__+':'+str(error))
        if errors:receipt['cleanup_errors']=errors;receipt['passed']=False
        receipt['elapsed_seconds']=time.monotonic()-started
        atomic(directory/'owner.json',receipt)
    return 0 if receipt['passed']else 1


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--execute',action='store_true');parser.add_argument('--inside',action='store_true');parser.add_argument('--spec');parser.add_argument('--spec-sha');args=parser.parse_args()
    need(args.spec and args.spec_sha and args.execute!=args.inside,'inert: exactly one reviewed delegate mode required')
    spec_pin=kernel_probe.pin(Path(args.spec));need(spec_pin['sha256']==args.spec_sha,'delegation spec changed')
    if args.inside:return inside(spec_pin)
    def interrupted(number,frame):raise TaskInterrupted('owned delegation cancelled')
    signal.signal(signal.SIGINT,interrupted);signal.signal(signal.SIGTERM,interrupted)
    return execute(spec_pin)


if __name__=='__main__':raise SystemExit(main())
