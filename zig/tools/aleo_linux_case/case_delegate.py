"""One fixed full-case delegated service; inert without exact case authority."""
import argparse
import hashlib
import json
import stat
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


STARTUP_STAGES={'authority','properties','invocation','delegated-paths','publish-custody','prepare-controllers','manager-caps','parent-admission','controller-binding','controller-resources','payload-binding','payload-publication','payload-run'}
DIAGNOSTIC_CLASSES={'ValueError','RuntimeError','AssertionError','KeyError','FileNotFoundError','FileExistsError','PermissionError','OSError','TimeoutError','ChildProcessError','TaskInterrupted','ImportError','ModuleNotFoundError','MemoryError','SystemExit'}
FRAME_SOURCE_FILES={
 'case_delegate.py':'zig/tools/aleo_linux_case/case_delegate.py',
 'case_specs.py':'zig/tools/aleo_linux_case/case_specs.py',
 'case_supervisor.py':'zig/tools/aleo_linux_case/case_supervisor.py',
 'controller_resources.py':'zig/tools/aleo_linux_case/controller_resources.py',
 'case_cohort.py':'zig/tools/aleo_linux_case/case_cohort.py',
 'case_assets.py':'zig/tools/aleo_linux_case/case_assets.py',
 'custody.py':'zig/tools/aleo_linux_case/custody.py',
 'kernel_delegate.py':'zig/tools/aleo_linux/kernel_delegate.py',
 'kernel_probe.py':'zig/tools/aleo_linux/kernel_probe.py',
 'receipts.py':'zig/tools/aleo_linux/receipts.py',
 'sdk_specs.py':'zig/tools/aleo_linux_sdk/sdk_specs.py',
 'sdk_provision.py':'zig/tools/aleo_linux_sdk/sdk_provision.py',
 'sdk_build.py':'zig/tools/aleo_linux_sdk/sdk_build.py'}
STARTUP_PREFIX='ALEO_CASE_STARTUP_DIAGNOSTIC '


def startup_frames(error):
    repo=HERE.parents[2];paths={str(repo/relative):name for name,relative in FRAME_SOURCE_FILES.items()};frames=[];tb=error.__traceback__;visited=0;cache={}
    while tb is not None and visited<64:
        visited+=1;name=paths.get(tb.tb_frame.f_code.co_filename)
        if name is not None:
            if name not in cache:
                path=repo/FRAME_SOURCE_FILES[name];need(path.stat().st_size<=16*1024**2,'bounded startup Source')
                with path.open('rb')as stream:raw=stream.read(16*1024**2+1)
                need(len(raw)<=16*1024**2,'bounded captured startup Source');cache[name]={'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'lines':len(raw.splitlines())}
            row=cache[name]
            if type(tb.tb_lineno)is int and 0<tb.tb_lineno<=row['lines']:frames.append({'source':name,'line':tb.tb_lineno,'bytes':row['bytes'],'sha256':row['sha256']})
        tb=tb.tb_next
    return frames[-8:]


def emit_startup_failure(stage,error):
    need(stage in STARTUP_STAGES,'fixed startup diagnostic stage');kind=type(error).__name__;row={'schema':1,'kind':'aleo-case-service-startup-failure-v1','stage':stage,'error_class':kind if kind in DIAGNOSTIC_CLASSES else'other','observed_monotonic_ns':time.monotonic_ns(),'frames':startup_frames(error)}
    number=getattr(error,'errno',None)
    if type(number)is int and 0<number<=4095:row['errno']=number
    wire=STARTUP_PREFIX+json.dumps(row,sort_keys=True,separators=(',',':'),allow_nan=False)+'\n';need(len(wire.encode())<=8192,'bounded startup diagnostic marker');sys.stderr.write(wire);sys.stderr.flush()


def checked_startup_marker(value,spec):
    need(type(value)is dict and set(value)in ({'schema','kind','stage','error_class','observed_monotonic_ns','frames'},{'schema','kind','stage','error_class','observed_monotonic_ns','frames','errno'}),'closed startup marker')
    need(type(value['schema'])is int and value['schema']==1 and value['kind']in {'aleo-case-service-startup-failure-v1','aleo-case-service-source-trace-v1'}and ((value['stage']in STARTUP_STAGES and value['kind']=='aleo-case-service-startup-failure-v1')or(value['stage']=='unobserved'and value['kind']=='aleo-case-service-source-trace-v1')) and value['error_class']in DIAGNOSTIC_CLASSES|{'other'},'typed startup marker')
    need(type(value['observed_monotonic_ns'])is int and 0<value['observed_monotonic_ns']<=time.monotonic_ns(),'actual startup observation clock')
    if 'errno'in value:need(type(value['errno'])is int and 0<value['errno']<=4095,'typed startup errno')
    rows=value['frames'];need(type(rows)is list and len(rows)<=8,'bounded startup frames');expected={r['path']:r for r in spec['pins']};repo=HERE.parents[2];frames=[]
    for row in rows:
        need(type(row)is dict and set(row)=={'source','line','bytes','sha256'}and row['source']in FRAME_SOURCE_FILES,'closed startup Source frame');path=repo/FRAME_SOURCE_FILES[row['source']];pin=expected.get(str(path));need(pin is not None and {'bytes':row['bytes'],'sha256':row['sha256']}=={k:pin[k]for k in ['bytes','sha256']},'startup frame Source pin differs');need(type(pin['bytes'])is int and 0<=pin['bytes']<=16*1024**2,'bounded admitted frame Source')
        with path.open('rb')as stream:raw=stream.read(16*1024**2+1)
        need(len(raw)==pin['bytes']and hashlib.sha256(raw).hexdigest()==pin['sha256'],'captured startup frame Source differs')
        need(type(row['line'])is int and 0<row['line']<=len(raw.splitlines()),'startup frame line differs');frames.append(dict(row))
    result={k:value[k]for k in ['schema','kind','stage','error_class','observed_monotonic_ns']};result['frames']=frames
    if 'errno'in value:result['errno']=value['errno']
    return result


def service_failure_diagnostics(directory,spec):
    # Actual terminal fixed service logs only; no body, arbitrary paths, argv,
    # exception text or environments enter this record. Do not open unsafe files.
    result={'schema':1,'kind':'aleo-case-service-failure-metadata-v1','files':{},'startup':{'status':'absent'},'raw_logs_argv_environment_exported':False};tail=b''
    for name in ['stdout','stderr']:
        row={'status':'absent'};result['files'][name]=row;path=directory/(name+'.log');fd=None
        try:
            before=path.lstat()
            if path.resolve()!=path or not stat.S_ISREG(before.st_mode)or before.st_nlink!=1:row['status']='unsafe';continue
            if before.st_size>16*1024**2:row.update(status='oversized',bytes=before.st_size);continue
            fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK);opened=os.fstat(fd)
            def stable(s):return (s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns,s.st_nlink)
            need(stable(before)==stable(opened)and stat.S_ISREG(opened.st_mode),'service diagnostic opened identity differs');digest=hashlib.sha256();count=0
            while True:
                block=os.read(fd,65536)
                if not block:break
                count+=len(block);need(count<=16*1024**2,'service diagnostic read bound');digest.update(block)
                if name=='stderr':tail=(tail+block)[-65536:]
            need(stable(before)==stable(os.fstat(fd))==stable(path.lstat())and count==before.st_size,'service diagnostic changed');row.update(status='available',bytes=count,sha256=digest.hexdigest())
        except FileNotFoundError:row['status']='absent'
        except BaseException:row['status']='unavailable';tail=b''if name=='stderr'else tail
        finally:
            if fd is not None:os.close(fd)
    if result['files']['stderr']['status']=='available':
        candidates=[line[len(STARTUP_PREFIX):]for line in tail.decode('utf-8',errors='replace').splitlines()if line.startswith(STARTUP_PREFIX)]
        if candidates:
            try:
                need(len(candidates)==1 and len(candidates[0].encode())<=8192,'one bounded startup marker')
                def pairs(rows):
                    out={}
                    for key,value in rows:need(key not in out,'duplicate startup key');out[key]=value
                    return out
                value=json.loads(candidates[0],object_pairs_hook=pairs);result['startup']={'status':'available','record':checked_startup_marker(value,spec)}
            except BaseException:result['startup']={'status':'refused'}
    if result['files']['stderr']['status']=='available'and result['startup']['status']=='absent':
        # A marker cannot cover failures before Python enters inside(). A parsed
        # Source trace is explicitly weaker diagnostic evidence, not a child
        # execution witness; never export its text or arbitrary file paths.
        lines=tail.decode('utf-8',errors='replace').splitlines();repo=HERE.parents[2];paths={str(repo/p):name for name,p in FRAME_SOURCE_FILES.items()};expected={r['path']:r for r in spec['pins']};frames=[]
        try:
            for line in lines:
                match=re.fullmatch(r'  File "([^"\n]+)", line ([0-9]{1,8})(?:, in .*)?',line)
                if match and match[1]in paths:
                    name=paths[match[1]];row=expected.get(match[1]);need(row is not None,'trace frame must be admitted Source');frames.append({'source':name,'line':int(match[2]),'bytes':row['bytes'],'sha256':row['sha256']})
            nonempty=[line for line in lines if line.strip()];kind=nonempty[-1].partition(':')[0]if nonempty else''
            if frames and kind in DIAGNOSTIC_CLASSES:
                record={'schema':1,'kind':'aleo-case-service-source-trace-v1','stage':'unobserved','error_class':kind,'observed_monotonic_ns':time.monotonic_ns(),'frames':frames[-8:]};result['startup']={'status':'source-trace-only','record':checked_startup_marker(record,spec)}
        except BaseException:result['startup']={'status':'refused'}
    return result


def inside(spec_pin):
    stage='authority'
    try:
        spec=approved(spec_pin);unit=identity(spec);tools=base.tools(spec)
        stage='properties'
        properties=base.show(tools['systemctl'],unit);invocation=owned(properties,spec)
        stage='invocation'
        need(os.environ.get('INVOCATION_ID')==invocation,'actual case invocation differs')
        stage='delegated-paths'
        root=Path('/sys/fs/cgroup/system.slice')/unit;manager=root/'manager'
        need(root.resolve()==root and manager.resolve()==manager,'canonical case delegated paths required')
        need(root.stat().st_uid==os.getuid()and manager.stat().st_uid==os.getuid(),'case inode UID differs')
        context={'unit':unit,'invocation':invocation,'uid':os.getuid(),'gid':os.getgid(),'root':str(root),'root_dev':root.stat().st_dev,'root_ino':root.stat().st_ino,'manager_dev':manager.stat().st_dev,'manager_ino':manager.stat().st_ino,'boot_id':Path('/proc/sys/kernel/random/boot_id').read_text().strip()}
        directory=Path(spec['output']).with_suffix('.owner')
        # Publish positive custody before partition. A cancellation before initial
        # publication is never authority to stop an unclaimed unit (finite fallback).
        stage='publish-custody'
        base.atomic(directory/'delegation.json',context)
        base.atomic(directory/'service-properties.json',{'observed_monotonic_ns':time.monotonic_ns(),'properties':properties})
        stage='prepare-controllers'
        base.prepare_inside(spec,unit)
        # Bound the positively owned manager independently from its13.5GiB child.
        stage='manager-caps'
        manager_limits={'memory.max':str(GIB//2),'memory.swap.max':'0','pids.max':'128'}
        for name,value in manager_limits.items():(manager/name).write_text(value)
        actual_manager={name:(manager/name).read_text().strip()for name in manager_limits}
        need(actual_manager==manager_limits,'actual case manager limits differ')
        base.atomic(directory/'manager-limits.json',{'observed_monotonic_ns':time.monotonic_ns(),'path':str(manager),'limits':actual_manager})
        stage='parent-admission'
        kernel_probe.delegated_parent(context,spec['run_token'],family='case')
        stage='controller-binding'
        context_pin=kernel_probe.pin(directory/'delegation.json')
        controller_pin=kernel_probe.pin(directory/'controller.json');controller=load(controller_pin)
        need(controller['service_spec']==spec_pin and controller['run_token']==spec['run_token'],'original controller binding differs')
        stage='controller-resources'
        controller_resources.tree(controller['identity'])
        stage='payload-binding'
        payload=dict(load(spec['case_spec'],32*1024**2),delegation_context=context_pin,controller_receipt=controller_pin,service_owner_spec=spec_pin)
        payload['pins']=payload['pins']+[spec_pin,context_pin,controller_pin]
        stage='payload-publication'
        base.atomic(directory/'payload.spec.json',payload)
        stage='payload-run'
        return case_supervisor.run(kernel_probe.pin(directory/'payload.spec.json'))
    except BaseException as error:
        try:emit_startup_failure(stage,error)
        except BaseException:pass  # Diagnostic failure must preserve the original exception.
        raise

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
        if result.get('error'):
            try:result['service_failure_diagnostics']=service_failure_diagnostics(directory,spec)
            except BaseException:result['service_failure_diagnostics']={'schema':1,'kind':'aleo-case-service-failure-metadata-v1','status':'unavailable','raw_logs_argv_environment_exported':False}
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
