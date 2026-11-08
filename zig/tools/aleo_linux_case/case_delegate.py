"""One fixed full-case delegated service; inert without exact case authority."""
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
for code_root in (HERE,HERE.parent/'aleo_linux',HERE.parent/'aleo_linux_sdk'):
    if(code_root/'__pycache__').exists()or(code_root/'__pycache__').is_symlink():raise ValueError('full-case profile forbids cached local Python bytecode')
sys.path.insert(0,str(HERE.parent/'aleo_linux'))
sys.path.insert(0,str(HERE.parent/'aleo_linux_sdk'))
sys.path.insert(0,str(HERE))
import kernel_delegate as base
import kernel_probe
import case_specs
import case_supervisor
import controller_resources
import custody
from receipts import checked,load,need

GIB=1024**3
MEMORY=14*GIB
TASKS=1024
SERVICE_SECONDS=11160
PROPERTIES={**base.PROPERTIES,'MemoryMax':str(MEMORY),'TasksMax':str(TASKS),'RuntimeMaxUSec':'3h 6min','TimeoutStopUSec':'4min'}


class TaskInterrupted(RuntimeError):
    """Cancellation must not be swallowed as a retried InterruptedError."""


def identity(spec):
    need(spec.get('schema')==1 and spec.get('purpose')=='aleo-linux-case-service-v1'and spec.get('root_approved')is True,'explicit full-case service authority required')
    token=spec['run_token']
    need(type(token)is str and re.fullmatch('[0-9a-f]{32}',token),'exact fresh case token required')
    need(os.getuid()>0 and os.getuid()==os.geteuid()and os.getgid()==os.getegid(),'unprivileged case manager required')
    return 'ziggy-aleo-case-'+token+'.service'


def owned(rows,spec,invocation=None,allow_stopped=False):
    unit=identity(spec)
    need(type(rows)is dict and rows.get('Id')==unit and rows.get('Description')==unit,'case unit differs')
    need(rows.get('User')==str(os.getuid())and rows.get('Group')==str(os.getgid()),'case service UID/GID differs')
    stopped=allow_stopped and invocation is not None and rows.get('ActiveState')in {'inactive','failed'}and rows.get('ControlGroup')==''
    need(stopped or rows.get('ControlGroup')=='/system.slice/'+unit,'case service cgroup differs')
    need(re.fullmatch('[0-9a-f]{32}',rows.get('InvocationID',''))is not None,'actual case invocation required')
    if invocation is not None:need(rows['InvocationID']==invocation,'case invocation replaced')
    need(set(rows.get('DelegateControllers','').split())=={'memory','pids'},'case controllers differ')
    for key,value in PROPERTIES.items():need(rows.get(key)==value,'actual case service property differs: '+key)
    return rows['InvocationID']


def checked_context(value,spec):
    keys={'unit','invocation','uid','gid','root','root_dev','root_ino','manager_dev','manager_ino','boot_id'}
    need(type(value)is dict and set(value)==keys,'exact case custody required')
    need(value['unit']==identity(spec)and value['root']=='/sys/fs/cgroup/system.slice/'+identity(spec),'case custody path differs')
    need(type(value['uid'])is int and value['uid']==os.getuid()and type(value['gid'])is int and value['gid']==os.getgid(),'case custody UID/GID differs')
    need(type(value['invocation'])is str and re.fullmatch('[0-9a-f]{32}',value['invocation'])is not None,'actual case custody invocation missing')
    need(all(type(value[key])is int and value[key]>=0 for key in ('root_dev','root_ino','manager_dev','manager_ino')),'typed case inode required')
    need(value['boot_id']==Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'case custody boot differs')
    return value


def approved(spec_pin):
    spec=load(spec_pin,32*1024**2);identity(spec)
    need(set(spec)=={'schema','root_approved','purpose','case_spec','output','run_token','tools','delegation_tools','pins'},'closed exact case service spec required')
    need(set(row['path']for row in spec['pins'])=={str(p)for p in case_specs.runtime_paths()}and len(spec['pins'])==len(case_specs.runtime_paths()),'exact full-case code closure required')
    for row in spec['pins']:checked(row)
    for row in spec['tools'].values():checked(row)
    base.tools(spec)
    need('delegation'not in spec and 'delegation_context'not in spec,'caller-supplied case custody forbidden')
    payload=load(spec['case_spec'],32*1024**2);need(payload['root_approved']is True and payload['run_token']==spec['run_token']and payload['output']==spec['output'],'exact case payload binding differs')
    need('delegation_context'not in payload and 'controller_receipt'not in payload,'caller-supplied payload custody forbidden')
    need(set(spec['tools'])=={'python'}and spec['tools']['python']==payload['python'],'exact case Python differs')
    case_specs.admission(payload)
    return spec


def launch_argv(spec,tools,spec_pin):
    unit=identity(spec)
    return [tools['sudo'],'-n',tools['systemd-run'],'--unit='+unit,'--description='+unit,'--service-type=exec','--uid='+str(os.getuid()),'--gid='+str(os.getgid()),'--wait','--pipe','--property=Delegate=memory pids','--property=DelegateSubgroup=manager','--property=MemoryMax='+str(MEMORY),'--property=MemorySwapMax=0','--property=TasksMax='+str(TASKS),'--property=RuntimeMaxSec='+str(SERVICE_SECONDS),'--property=TimeoutStopSec=240','--property=KillMode=control-group','--property=NoNewPrivileges=yes',str(checked(spec['tools']['python'])),'-I','-B',str(Path(__file__).resolve()),'--inside','--spec',spec_pin['path'],'--spec-sha',spec_pin['sha256']]


def inside(spec_pin):
    spec=approved(spec_pin);unit=identity(spec);tools=base.tools(spec)
    properties=base.show(tools['systemctl'],unit);invocation=owned(properties,spec)
    need(os.environ.get('INVOCATION_ID')==invocation,'actual case invocation differs')
    root=Path('/sys/fs/cgroup/system.slice')/unit;manager=root/'manager'
    need(root.resolve()==root and manager.resolve()==manager,'canonical case delegated paths required')
    need(root.stat().st_uid==os.getuid()and manager.stat().st_uid==os.getuid(),'case inode UID differs')
    context={'unit':unit,'invocation':invocation,'uid':os.getuid(),'gid':os.getgid(),'root':str(root),'root_dev':root.stat().st_dev,'root_ino':root.stat().st_ino,'manager_dev':manager.stat().st_dev,'manager_ino':manager.stat().st_ino,'boot_id':Path('/proc/sys/kernel/random/boot_id').read_text().strip()}
    directory=Path(spec['output']).with_suffix('.owner')
    # Publish positive custody before partition. A cancellation before initial
    # publication is never authority to stop an unclaimed unit (finite fallback).
    base.atomic(directory/'delegation.json',context)
    base.atomic(directory/'service-properties.json',{'observed_monotonic_ns':time.monotonic_ns(),'properties':properties})
    base.prepare_inside(spec,unit)
    # Bound the positively owned manager independently from its13.5GiB child.
    manager_limits={'memory.max':str(GIB//2),'memory.swap.max':'0','pids.max':'128'}
    for name,value in manager_limits.items():(manager/name).write_text(value)
    actual_manager={name:(manager/name).read_text().strip()for name in manager_limits}
    need(actual_manager==manager_limits,'actual case manager limits differ')
    base.atomic(directory/'manager-limits.json',{'observed_monotonic_ns':time.monotonic_ns(),'path':str(manager),'limits':actual_manager})
    kernel_probe.delegated_parent(context,spec['run_token'],family='case')
    context_pin=kernel_probe.pin(directory/'delegation.json')
    controller_pin=kernel_probe.pin(directory/'controller.json');controller=load(controller_pin)
    need(controller['service_spec']==spec_pin and controller['run_token']==spec['run_token'],'original controller binding differs')
    controller_resources.tree(controller['identity'])
    payload=dict(load(spec['case_spec'],32*1024**2),delegation_context=context_pin,controller_receipt=controller_pin,service_owner_spec=spec_pin)
    payload['pins']=payload['pins']+[spec_pin,context_pin,controller_pin]
    base.atomic(directory/'payload.spec.json',payload)
    return case_supervisor.run(kernel_probe.pin(directory/'payload.spec.json'))


def cleanup(spec,tools,context):
    unit=identity(spec);rows=base.show(tools['systemctl'],unit);root=Path('/sys/fs/cgroup/system.slice')/unit
    if rows is not None:
        need(context is not None,'no positive case custody; preserve unclaimed unit')
        owned(rows,spec,context['invocation'],allow_stopped=True)
        if root.exists():need((root.stat().st_dev,root.stat().st_ino)==(context['root_dev'],context['root_ino']),'case cgroup replaced')
        if rows['ActiveState']not in {'inactive','failed'}or root.exists():
            need(base.command([tools['sudo'],'-n',tools['systemctl'],'stop',unit],timeout=242).returncode==0,'owned case service stop failed')
    need(not root.exists(),'case service cgroup remains')
    return {'owned_cgroup_absent':True,'systemd_stop_is_not_parent_wait':True}


def final_pass(result):
    wait=result.get('client_wait')or{}
    return (result.get('Docker_recovery')or{}).get('passed')is True and result['Docker_recovery'].get('complete_positive_custody')is True and result['Docker_recovery'].get('performed_mutations')is False and result.get('payload_passed')is True and result.get('source_unchanged')is True and not result.get('error')and not result.get('cleanup_errors')and (result.get('cleanup')or{}).get('owned_cgroup_absent')is True and wait.get('actual_parent_wait')is True and type(wait.get('exit_code'))is int and wait['exit_code']==0


def qualify_public(proof,result,case):
    need(final_pass(result)and proof.get('kind')=='public-actual-aleo-proof-v1','actual clean case service required for final public projection')
    wait=result['client_wait'];need(type(wait.get('pid'))is int and wait['pid']>0,'actual service client PID required')
    observations=[]
    for row in result['property_observations']:
        props=row['properties']
        if props is not None:
            need(set(props)==set(base.QUERY)and all(type(v)is str for v in props.values()),'closed public systemd property projection required')
        observations.append({'phase':row['phase'],'observed_monotonic_ns':row['observed_monotonic_ns'],'properties':props,'unit_absent':row.get('unit_absent',False)})
    public=dict(proof);public['source']=dict(proof['source'],SDK_owner_receipt=case['sdk_owner_receipt'],kernel_receipt=case['kernel_receipt'],kernel_owner_receipt=case['kernel_owner_receipt'],Docker_prerequisite=case['docker_receipt'],Docker_owner_receipt=case['docker_owner_receipt'])
    public['actual_case_service']={'unit':result['unit'],'service_spec':result['spec'],'actual_client_wait':{key:wait[key]for key in ('pid','actual_parent_wait','exit_code','waits_for_systemd_client_only','completed_monotonic_ns')},'owned_cgroup_absent':True,'property_observations':observations,'actual_manager_limits':result['actual_manager_limits_before']['limits'],'daemon_container_parent_wait_credit':False}
    return public


def execute(spec_pin):
    spec=approved(spec_pin);need(platform.system()=='Linux'and platform.machine()=='x86_64','native Linux case service required')
    unit=identity(spec);tools=base.tools(spec);directory=Path(spec['output']).with_suffix('.owner')
    need(directory.parent.resolve()==directory.parent and not directory.exists()and not Path(spec['output']).exists(),'fresh case service output required');directory.mkdir(mode=0o700)
    result={'kind':'aleo-linux-case-service-v1','schema':1,'passed':False,'unit':unit,'spec':spec_pin,'client_wait':None,'cleanup':None,'property_observations':[],'benchmark_credit':False}
    child=None;context=None;created=False;started=time.monotonic()
    try:
        version=base.command([tools['systemd-run'],'--version']);match=re.match(rb'systemd ([0-9]+)',version.stdout)
        need(version.returncode==0 and match and int(match[1])>=254,'systemd254 required')
        need(base.show(tools['systemctl'],unit)is None,'preserve preexisting case unit')
        base.atomic(directory/'controller.json',{'identity':controller_resources.capture(),'service_spec':spec_pin,'run_token':spec['run_token']})
        argv=launch_argv(spec,tools,spec_pin);result['argv']=argv
        with(directory/'stdout.log').open('xb')as out,(directory/'stderr.log').open('xb')as err:
            child=subprocess.Popen(argv,stdin=subprocess.DEVNULL,stdout=out,stderr=err,env={'PATH':'/usr/bin:/bin','LC_ALL':'C.UTF-8'},start_new_session=True);created=True
            while child.poll()is None:
                need(time.monotonic()-started<SERVICE_SECONDS+5,'case service owner deadline')
                need((directory/'stdout.log').stat().st_size+(directory/'stderr.log').stat().st_size<=16*1024**2,'case service log cap');time.sleep(.2)
            code=child.wait();result['client_wait']={'pid':child.pid,'actual_parent_wait':True,'exit_code':code,'waits_for_systemd_client_only':True,'completed_monotonic_ns':time.monotonic_ns()};need(code==0,'actual case service failed')
        value=load(kernel_probe.pin(Path(spec['output'])/'result.json'),32*1024**2)
        need(case_supervisor.final_pass(value)and value.get('passed')is True,'actual full-case postconditions failed')
        need(value['actual_case_completed_monotonic_ns']<=value['original_deadline_ns']==value['original_started_ns']+10800*10**9,'original case clock exceeded/reminted')
        context=checked_context(load(kernel_probe.pin(directory/'delegation.json')),spec)
        before_pin=kernel_probe.pin(directory/'service-properties.json');before=load(before_pin);owned(before['properties'],spec,context['invocation'])
        result['property_observations'].append({'phase':'inside-before','record':before_pin,**before})
        after=base.show(tools['systemctl'],unit)
        if after is not None:owned(after,spec,context['invocation'],allow_stopped=True)
        result['property_observations'].append({'phase':'after-payload','observed_monotonic_ns':time.monotonic_ns(),'properties':after,'unit_absent':after is None})
        manager_pin=kernel_probe.pin(directory/'manager-limits.json');manager_row=load(manager_pin)
        need(manager_row['path']==context['root']+'/manager'and manager_row['limits']=={'memory.max':str(GIB//2),'memory.swap.max':'0','pids.max':'128'},'actual retained case manager caps differ')
        result['actual_manager_limits_before']={'record':manager_pin,**manager_row}
        need(value['actual_manager_limits_after']==manager_row['limits'],'case manager caps changed')
        result['payload_result']=kernel_probe.pin(Path(spec['output'])/'result.json');result['payload_passed']=True
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
            if (result.get('cleanup')or{}).get('owned_cgroup_absent')is True:
                payload_path=directory/'payload.spec.json'
                if payload_path.exists():result['Docker_recovery']=custody.recover(kernel_probe.pin(payload_path),spec_pin,True)
                else:
                    need(not Path(spec['output']).exists(),'no published payload cannot have a case output')
                    result['Docker_recovery']={'passed':True,'complete_positive_custody':False,'performed_mutations':False,'payload_never_started':True}
        except BaseException as error:errors.append('Docker-recovery:'+type(error).__name__)
        try:
            if child is not None:
                code=child.wait(timeout=243)
                if result['client_wait']is None:result['client_wait']={'pid':child.pid,'actual_parent_wait':True,'exit_code':code,'waits_for_systemd_client_only':True,'completed_monotonic_ns':time.monotonic_ns()}
                else:need(result['client_wait']['exit_code']==code,'actual case client status changed')
        except BaseException as error:errors.append('client_wait:'+type(error).__name__)
        try:
            for row in spec['pins']+list(spec['tools'].values())+list(spec['delegation_tools'].values()):checked(row)
            checked(spec['case_spec']);checked(spec_pin);result['source_unchanged']=True
        except BaseException as error:errors.append('Source:'+type(error).__name__);result['source_unchanged']=False
        result['cleanup_errors']=errors;result['passed']=final_pass(result)
        if result['passed']:
            try:
                from public_proof import project
                case=load(spec['case_spec'],32*1024**2)
                payload=load(result['payload_result'],32*1024**2)
                raw=payload['case_result'];actual=load(raw)
                public=qualify_public(project(actual,payload,raw,case),result,case)
                path=Path(spec['output'])/'public-final-proof.json';base.atomic(path,public)
                result['public_final_proof']=kernel_probe.pin(path)
            except BaseException as error:result['passed']=False;result['public_projection_error_type']=type(error).__name__
        base.atomic(directory/'owner.json',result)
    return 0 if result['passed']else 1


def main():
    p=argparse.ArgumentParser();p.add_argument('--execute',action='store_true');p.add_argument('--inside',action='store_true');p.add_argument('--spec');p.add_argument('--spec-sha');a=p.parse_args()
    need(a.spec and a.spec_sha and a.execute!=a.inside,'inert: exact full-case service mode required')
    spec=kernel_probe.pin(Path(a.spec));need(spec['sha256']==a.spec_sha,'case service spec changed')
    if a.inside:return inside(spec)
    def interrupt(number,frame):raise TaskInterrupted('owned case service cancelled')
    signal.signal(signal.SIGTERM,interrupt);signal.signal(signal.SIGINT,interrupt)
    return execute(spec)

if __name__=='__main__':raise SystemExit(main())
