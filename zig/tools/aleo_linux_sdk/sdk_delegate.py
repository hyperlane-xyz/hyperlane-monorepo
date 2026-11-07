"""Two fixed SDK service profiles. No privileged SDK payload; default inert."""
import argparse
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
KERNEL=HERE.parent/'aleo_linux'
sys.path.insert(0,str(KERNEL))
import kernel_delegate as base
import kernel_probe
import sdk_specs
import sdk_provision
import sdk_build
from receipts import checked,load,need

GIB=1024**3
MEMORY=9*GIB//2
TASKS=160
PROPERTIES={**base.PROPERTIES,'MemoryMax':str(MEMORY),'TasksMax':str(TASKS),'RuntimeMaxUSec':'32min 30s','TimeoutStopUSec':'20s'}


class TaskInterrupted(RuntimeError):
    """Cancellation must escape stdlib InterruptedError retry handling."""


def identity(spec):
    need(spec.get('purpose')=='aleo-linux-sdk-service-v1'and spec.get('root_approved')is True,'explicit SDK service authority required')
    token=spec['run_token'];phase=spec['phase']
    need(type(token)is str and re.fullmatch('[0-9a-f]{32}',token)and phase in {'packages','build'},'two exact SDK service profiles required')
    need(os.getuid()>0 and os.getuid()==os.geteuid()and os.getgid()==os.getegid(),'unprivileged SDK manager required')
    return 'ziggy-aleo-sdk-'+phase+'-'+token+'.service'


def owned(rows,spec,invocation=None,allow_stopped=False):
    unit=identity(spec)
    need(type(rows)is dict and rows.get('Id')==unit and rows.get('Description')==unit,'SDK unit differs')
    need(rows.get('User')==str(os.getuid())and rows.get('Group')==str(os.getgid()),'SDK service UID/GID differs')
    stopped=allow_stopped and invocation is not None and rows.get('ActiveState')in {'inactive','failed'}and rows.get('ControlGroup')==''
    need(stopped or rows.get('ControlGroup')=='/system.slice/'+unit,'SDK service cgroup differs')
    need(re.fullmatch('[0-9a-f]{32}',rows.get('InvocationID',''))is not None,'actual SDK service invocation required')
    if invocation is not None:need(rows['InvocationID']==invocation,'SDK service invocation replaced')
    need(set(rows.get('DelegateControllers','').split())=={'memory','pids'},'SDK controllers differ')
    for key,value in PROPERTIES.items():need(rows.get(key)==value,'actual SDK property differs: '+key)
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


def approved(spec_pin):
    spec=load(spec_pin);identity(spec)
    need(isinstance(spec['pins'],list),'SDK Source pins required')
    expected=sdk_specs.runtime_paths()
    need({row['path']for row in spec['pins']}=={str(p)for p in expected}and len(spec['pins'])==len(expected),'closed exact SDK controller/runtime Source required')
    for row in spec['pins']:checked(row)
    for row in spec['tools'].values():checked(row)
    base.tools(spec)
    need('delegation'not in spec and 'delegation_context'not in spec,'caller-supplied custody forbidden')
    checked(spec['kernel_spec']);checked(spec['kernel_receipt'])
    return spec


def launch_argv(spec,tools,spec_pin):
    unit=identity(spec)
    return [tools['sudo'],'-n',tools['systemd-run'],'--unit='+unit,'--description='+unit,'--service-type=exec','--uid='+str(os.getuid()),'--gid='+str(os.getgid()),'--wait','--pipe','--property=Delegate=memory pids','--property=DelegateSubgroup=manager','--property=MemoryMax='+str(MEMORY),'--property=MemorySwapMax=0','--property=TasksMax='+str(TASKS),'--property=RuntimeMaxSec=1950','--property=TimeoutStopSec=20','--property=KillMode=control-group','--property=NoNewPrivileges=yes',str(checked(spec['tools']['python'])),'-I','-B',str(Path(__file__).resolve()),'--inside','--spec',spec_pin['path'],'--spec-sha',spec_pin['sha256']]


def inside(spec_pin):
    spec=approved(spec_pin);unit=identity(spec);tools=base.tools(spec)
    properties=base.show(tools['systemctl'],unit);invocation=owned(properties,spec)
    need(os.environ.get('INVOCATION_ID')==invocation,'actual SDK invocation differs')
    root=Path('/sys/fs/cgroup/system.slice')/unit;manager=root/'manager'
    need(root.resolve()==root and manager.resolve()==manager,'canonical SDK delegated paths required')
    need(root.stat().st_uid==os.getuid()and manager.stat().st_uid==os.getuid(),'SDK delegated inode UID differs')
    context={'unit':unit,'invocation':invocation,'uid':os.getuid(),'gid':os.getgid(),'root':str(root),'root_dev':root.stat().st_dev,'root_ino':root.stat().st_ino,'manager_dev':manager.stat().st_dev,'manager_ino':manager.stat().st_ino,'boot_id':Path('/proc/sys/kernel/random/boot_id').read_text().strip()}
    directory=Path(spec['output']).with_suffix('.owner');base.atomic(directory/'delegation.json',context)
    base.atomic(directory/'service-properties.json',{'observed_monotonic_ns':time.monotonic_ns(),'properties':properties})
    base.prepare_inside(spec,unit)
    kernel_probe.delegated_parent(context,spec['run_token'],family='sdk-'+spec['phase'])
    context_pin=kernel_probe.pin(directory/'delegation.json')
    if spec['phase']=='packages':
        payload=sdk_specs.provision_spec(Path(spec['repo']),Path(spec['output']),spec['tools'],spec['execution_source_commit'],spec['kernel_spec'],spec['kernel_receipt'],spec['run_token'],context_pin)
        need(payload['source_files']==spec['source_files'],'pre-admitted package Source selection changed')
    else:payload=sdk_specs.build_spec(spec['package_receipt'],Path(spec['control']),Path(spec['output']),spec['kernel_spec'],spec['kernel_receipt'],spec['run_token'],context_pin,spec['package_owner_receipt'])
    payload['root_approved']=True;payload['service_owner_spec']=spec_pin
    payload['pins'] += [spec_pin,context_pin]
    base.atomic(directory/'payload.spec.json',payload);payload_pin=kernel_probe.pin(directory/'payload.spec.json')
    return sdk_provision.execute(payload_pin)if spec['phase']=='packages'else sdk_build.run(payload_pin)


def cleanup(spec,tools,context):
    unit=identity(spec);rows=base.show(tools['systemctl'],unit);root=Path('/sys/fs/cgroup/system.slice')/unit
    if rows is not None:
        need(context is not None,'no positive SDK custody; preserve unclaimed unit')
        owned(rows,spec,context['invocation'],allow_stopped=True)
        if root.exists():need((root.stat().st_dev,root.stat().st_ino)==(context['root_dev'],context['root_ino']),'SDK cgroup replaced')
        if rows['ActiveState']not in {'inactive','failed'}or root.exists():
            need(base.command([tools['sudo'],'-n',tools['systemctl'],'stop',unit],timeout=22).returncode==0,'owned SDK service stop failed')
    need(not root.exists(),'SDK service cgroup remains')
    return {'owned_cgroup_absent':True,'systemd_stop_is_not_parent_wait':True}


def execute(spec_pin):
    spec=approved(spec_pin);need(platform.system()=='Linux'and platform.machine()=='x86_64','native Linux SDK service required')
    unit=identity(spec);tools=base.tools(spec);directory=Path(spec['output']).with_suffix('.owner')
    need(directory.parent.resolve()==directory.parent and not directory.exists()and not Path(spec['output']).exists(),'fresh SDK service output required');directory.mkdir(mode=0o700)
    result={'kind':'aleo-linux-sdk-service-v1','schema':1,'passed':False,'unit':unit,'phase':spec['phase'],'spec':spec_pin,'client_wait':None,'cleanup':None,'property_observations':[],'SDK_proof_or_node_credit':False}
    child=None;context=None;created=False;started=time.monotonic()
    try:
        version=base.command([tools['systemd-run'],'--version']);match=re.match(rb'systemd ([0-9]+)',version.stdout)
        need(version.returncode==0 and match and int(match[1])>=254,'systemd254 required')
        need(base.show(tools['systemctl'],unit)is None,'preserve preexisting SDK unit')
        argv=launch_argv(spec,tools,spec_pin);result['argv']=argv
        with(directory/'stdout.log').open('xb')as out,(directory/'stderr.log').open('xb')as err:
            child=subprocess.Popen(argv,stdin=subprocess.DEVNULL,stdout=out,stderr=err,env={'PATH':'/usr/bin:/bin','LC_ALL':'C.UTF-8'},start_new_session=True);created=True
            while child.poll()is None:
                need(time.monotonic()-started<1955,'SDK service owner deadline')
                need((directory/'stdout.log').stat().st_size+(directory/'stderr.log').stat().st_size<=16*1024**2,'SDK service log cap');time.sleep(.2)
            code=child.wait();result['client_wait']={'pid':child.pid,'actual_parent_wait':True,'exit_code':code,'waits_for_systemd_client_only':True,'completed_monotonic_ns':time.monotonic_ns()};need(code==0,'actual SDK service failed')
        value=load(kernel_probe.pin(Path(spec['output'])/'result.json'),32*1024**2)
        need(result['client_wait']['completed_monotonic_ns']<=value['original_deadline_ns'],'actual SDK service completion exceeded original1800s stage')
        need(value.get('passed')is True and value.get('source_unchanged')is True and value.get('owned_absent')is True and not value.get('signals'),'actual SDK stage postconditions failed')
        context=checked_context(load(kernel_probe.pin(directory/'delegation.json')),spec)
        before_pin=kernel_probe.pin(directory/'service-properties.json');before=load(before_pin);owned(before['properties'],spec,context['invocation'])
        result['property_observations'].append({'phase':'inside-before','record':before_pin,**before})
        after=base.show(tools['systemctl'],unit)
        if after is not None:owned(after,spec,context['invocation'],allow_stopped=True)
        result['property_observations'].append({'phase':'after-payload','observed_monotonic_ns':time.monotonic_ns(),'properties':after,'unit_absent':after is None})
        result['payload_result']=kernel_probe.pin(Path(spec['output'])/'result.json');result['passed']=True
    except BaseException as error:result['error']=type(error).__name__+':'+str(error)
    finally:
        errors=[]
        try:
            marker=directory/'delegation.json'
            if marker.exists():context=checked_context(load(kernel_probe.pin(marker)),spec)
        except BaseException as error:errors.append('custody:'+type(error).__name__)
        try:
            if created:result['cleanup']=cleanup(spec,tools,context)
        except BaseException as error:errors.append('cleanup:'+type(error).__name__)
        try:
            if child is not None:
                code=child.wait(timeout=23)
                if result['client_wait']is None:result['client_wait']={'pid':child.pid,'actual_parent_wait':True,'exit_code':code,'waits_for_systemd_client_only':True,'completed_monotonic_ns':time.monotonic_ns()}
                else:need(result['client_wait']['exit_code']==code,'actual SDK client status changed')
        except BaseException as error:errors.append('client_wait:'+type(error).__name__)
        try:
            for row in spec['pins']+list(spec['tools'].values())+list(spec['delegation_tools'].values()):checked(row)
            checked(spec_pin)
        except BaseException as error:errors.append('Source:'+type(error).__name__)
        result['cleanup_errors']=errors;result['passed']=result['passed']and not errors and result['cleanup']is not None and result['cleanup']['owned_cgroup_absent']is True and result['client_wait']['exit_code']==0
        base.atomic(directory/'owner.json',result)
    return 0 if result['passed']else 1


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--execute',action='store_true');parser.add_argument('--inside',action='store_true');parser.add_argument('--spec');parser.add_argument('--spec-sha');args=parser.parse_args()
    need(args.spec and args.spec_sha and args.execute!=args.inside,'inert: exact SDK service mode required')
    spec=kernel_probe.pin(Path(args.spec));need(spec['sha256']==args.spec_sha,'SDK service spec changed')
    if args.inside:return inside(spec)
    def interrupt(number,frame):raise TaskInterrupted('owned SDK service cancelled')
    signal.signal(signal.SIGTERM,interrupt);signal.signal(signal.SIGINT,interrupt)
    return execute(spec)

if __name__=='__main__':raise SystemExit(main())
