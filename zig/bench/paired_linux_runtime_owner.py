#!/usr/bin/env python3
"""Own one fixed Linux paired workload; no action at import or false authority."""
from pathlib import Path
import argparse
import hashlib
import json
import math
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import time
import types

NS=10**9
GIB=1024**3
LIMITS={'wall_seconds':18000,'worker_drain_seconds':40,'stop_grace_seconds':30,'stop_kill_seconds':10,'PG_cleanup_seconds':60,'sampled_manager_and_owned_tree_RSS_bytes':8*GIB,'new_owned_disk_bytes':4*GIB,'minimum_free_bytes':6*GIB}
SOURCE={'runtime':'zig/bench/paired_linux_runtime.py','custody':'zig/bench/cold_matrix_owner.py','postgres':'zig/bench/paired_linux_postgres.py','owner':'zig/bench/paired_linux_runtime_owner.py'}
class Refused(RuntimeError):pass
class TaskInterrupted(RuntimeError):pass

def need(value,reason):
    if not value:raise Refused(reason)

def decode(raw):
    need(type(raw)is bytes and len(raw)<=16*1024**2,'Metadata size bound')
    def pairs(items):
        out={}
        for key,value in items:need(key not in out,'Duplicate metadata key');out[key]=value
        return out
    value=json.loads(raw,object_pairs_hook=pairs,parse_constant=lambda _:(_ for _ in()).throw(Refused('Nonfinite metadata')));count=0
    def finite(item,depth=0):
        nonlocal count
        count+=1;need(depth<=32 and count<=250000,'Metadata structure bound')
        if type(item)is float:need(math.isfinite(item),'Nonfinite metadata')
        if type(item)is dict:
            for v in item.values():finite(v,depth+1)
        elif type(item)is list:
            for v in item:finite(v,depth+1)
    finite(value);return value

def read(path):
    path=Path(path);need(path.stat().st_size<=16*1024**2,'Metadata size bound')
    with path.open('rb')as stream:raw=stream.read(16*1024**2+1)
    return decode(raw)


def pin(path):
    path=Path(path);need(path.is_absolute()and path.resolve(strict=True)==path and not path.is_symlink(),'Canonical regular input required');before=path.stat();need(stat.S_ISREG(before.st_mode),'Regular input required')
    with path.open('rb')as stream:digest=hashlib.file_digest(stream,'sha256').hexdigest()
    after=path.stat();need((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns),'Input changed while hashing')
    return {'path':str(path),'bytes':after.st_size,'sha256':digest}

def checked(row):
    need(type(row)is dict and set(row)=={'path','bytes','sha256'}and type(row['bytes'])is int and row['bytes']>=0 and type(row['sha256'])is str and re.fullmatch('[0-9a-f]{64}',row['sha256']),'Closed descriptor required')
    path=Path(row['path']);need(pin(path)==row,'Input descriptor differs');return path

def captured_module(row,name):
    path=checked(row);wire=path.read_bytes();need(len(wire)==row['bytes']and hashlib.sha256(wire).hexdigest()==row['sha256'],'Captured Source differs')
    module=types.ModuleType(name);module.__file__=str(path);exec(compile(wire,str(path),'exec'),module.__dict__);return module

def admission(args):
    authority_pin=pin(args.runtime_authority);need(authority_pin['sha256']==args.runtime_authority_sha256,'Runtime authority pin differs')
    with Path(args.runtime_authority).open('rb')as stream:wire=stream.read(16*1024**2+1)
    need(len(wire)==authority_pin['bytes']and len(wire)<=16*1024**2 and hashlib.sha256(wire).hexdigest()==authority_pin['sha256'],'Captured Root authority differs')
    value=decode(wire)
    need(type(value)is dict and type(value.get('schema'))is int and value.get('schema')==1 and value.get('kind')=='paired-linux-runtime-authority-v1'and type(value.get('root_approved'))is bool,'Runtime authority schema')
    if not value['root_approved']:return None
    need(type(args.index)is int and 0<=args.index<10 and sys.dont_write_bytecode and sys.pycache_prefix is None,'Exact no-bytecode workload index required')
    repo=args.repo;need(repo.is_absolute()and repo.resolve(strict=True)==repo,'Canonical checkout required');rows=value.get('required_source');need(type(rows)is list,'Root Source closure required')
    source={}
    for row in rows:
        need(type(row)is dict and set(row)=={'path','bytes','sha256'}and type(row['path'])is str,'Root Source descriptor required');relative=Path(row['path']);need(not relative.is_absolute()and relative.as_posix()==row['path']and relative.parts and not any(p in {'.','..'}for p in relative.parts)and row['path']not in source,'Finite unique Source paths')
        source[row['path']]={**row,'path':str(repo/relative)};checked(source[row['path']])
    need(set(SOURCE.values())<=set(source),'Runtime owner/custody/PG Source closure required');need(source[SOURCE['owner']]==pin(Path(__file__).resolve()),'Executed owner Source differs')
    runtime=captured_module(source[SOURCE['runtime']],'paired_runtime_checked')
    context=runtime.admit(args.runtime_authority,args.runtime_authority_sha256,args.reuse,args.reuse_sha256,repo,args.index)
    need(context is not None and context['authority_pin']==authority_pin,'Independent runtime admission required')
    need(all(context['source'][name]==source[name]for name in SOURCE.values()),'Runtime and owner Source closure differs')
    # These are checked standard-library-only definitions. No benchmark module,
    # Docker client, SDK, compiler or prepared-input acquisition is imported here.
    custody=captured_module(source[SOURCE['custody']],'paired_runtime_custody')
    postgres=captured_module(source[SOURCE['postgres']],'paired_runtime_postgres')
    runtime.no_bytecode(repo);return runtime,context,custody,postgres

def planned_paths(runtime,context,repo,output,index):
    worker=output/'worker';role=context['method']['role'];token=hashlib.sha256((str(worker)+context['authority_pin']['sha256']).encode()).hexdigest()[:32]
    raw=repo/'zig/bench/results'/('scraper-process-linux-'+token+'-'+str(index))if role=='scraper'else worker/'raw'
    expected=[worker,raw,repo/'zig/bench/.cache',repo/'zig/integration/.cache',repo/'zig/integration/.deps'];paths=runtime.runtime_paths(context,repo,worker,index)
    need(paths['raw_output']==raw and paths['owned_write_roots']==expected,'Fixed original runtime write roots differ')
    roots=[output,repo/'zig/bench/.cache',repo/'zig/integration/.cache',repo/'zig/integration/.deps']
    if role=='scraper':roots.append(raw)
    need(len(roots)==len(set(roots))and all(p.is_absolute()and p.resolve(strict=False)==p and not p.is_symlink()for p in roots),'Canonical exact write-root union required')
    handoff=paths['postgres']
    if role=='scraper':
        receipt=worker/'postgres';expected_pg={'docker':context['manifest']['external']['tools']['docker'],'docker_config':receipt/'docker-config','token':token,'receipts':receipt,'journal':receipt/'paired-postgres-owner.json'}
        need(handoff==expected_pg,'Exact owned PG recovery handoff required')
    else:need(handoff is None,'Non-scraper cannot acquire PG authority')
    need(not worker.exists()and not raw.exists()and not worker.is_symlink()and not raw.is_symlink(),'Preserve previous workload output')
    return worker,raw,roots,handoff

def foreign_compilers(custody,current,owned):
    return [{'pid':pid,'start':row['start'],'comm':row['comm']}for pid,row in current.items()if pid not in owned and pid!=os.getpid()and row['state']!='Z'and row['comm']in custody.COMPILERS]

COMPILER_NAMES={'cargo','rustc','rustup','zig','clang','clang++','gcc','g++','cc1','cc1plus','cmake','make'}
VERSION_ARGUMENTS={('rustc','--version'):'rustc-version',('cargo','--version'):'cargo-version',('rustup','toolchain','list'):'rustup-toolchain-list',('zig','version'):'zig-version'}


def owned_version(custody,row):
    """Read only an already-owned compiler identity; never export command bytes."""
    pid=row['pid'];root=Path('/proc')/str(pid)
    try:
        with(root/'cmdline').open('rb')as stream:wire=stream.read(16385)
        if not wire:
            fresh=custody._linux_row(pid)
            if fresh is None or(fresh['start']==row['start']and fresh['state']=='Z'):return None
        need(0<len(wire)<=16384 and wire.endswith(b'\0'),'Owned compiler argument bound')
        argv=[word.decode('utf-8')for word in wire[:-1].split(b'\0')];need(argv and argv[0],'Owned compiler argument shape')
        shape=(Path(argv[0]).name,*argv[1:]);need(shape in VERSION_ARGUMENTS,'Owned compilation/non-version command refused')
        executable=(root/'exe').resolve(strict=True)
        need(executable.name in({shape[0],'rustup'}if shape[0]in {'cargo','rustc'}else {shape[0]}),'Owned metadata executable name differs')
        identity=pin(executable);fresh=custody._linux_row(pid)
        need(fresh is not None and custody.same_process(row,fresh),'Owned compiler birth changed while observing')
        return {'pid':pid,'start':row['start'],'command':VERSION_ARGUMENTS[shape],'executable':identity,'observed_monotonic_ns':time.monotonic_ns()}
    except (FileNotFoundError,ProcessLookupError):
        fresh=custody._linux_row(pid)
        if fresh is None or(fresh['start']==row['start']and fresh['state']=='Z'):return None
        raise Refused('Owned compiler identity unavailable')


def clock_backend():
    mono=time.get_clock_info('monotonic');perf=time.get_clock_info('perf_counter')
    need(mono.monotonic and perf.monotonic and mono.implementation==perf.implementation,'Actual Linux perf-counter/monotonic backends differ')


def metadata_before_measurement(rows,waits):
    clock_backend()
    if not rows:return
    first=min(row['original_start_ns']for row in waits)
    need(all(type(row['observed_monotonic_ns'])is int and row['observed_monotonic_ns']<first for row in rows),'Owned compiler metadata overlapped original measured work')


def resources(custody,paths,baseline,output,child,known,groups,unreaped,phase,record):
    current=custody.processes();owned=custody.owned_processes(current,child.pid if child else -1,known,groups,unreaped)
    rss=current.get(os.getpid(),{}).get('rss_bytes',0)+sum(row['rss_bytes']for row in owned.values())
    need(os.getpid()in current,'Manager RSS identity unavailable')
    allocated={str(p):custody.allocated(p)if p.exists()else 0 for p in paths};growth=sum(max(0,allocated[str(p)]-baseline[str(p)])for p in paths);free=shutil.disk_usage(output).free;foreign=foreign_compilers(custody,current,owned)
    record['sampled_RSS_peak_bytes']=max(record['sampled_RSS_peak_bytes'],rss);record['new_disk_peak_bytes']=max(record['new_disk_peak_bytes'],growth);record['minimum_free_bytes']=min(record['minimum_free_bytes'],free);record['resource_samples']+=1
    row={'phase':phase,'monotonic_ns':time.monotonic_ns(),'sampled_manager_and_owned_tree_RSS_bytes':rss,'new_allocated_bytes':growth,'free_bytes':free,'foreign_compilers':foreign}
    with(output/'resources.jsonl').open('a')as stream:stream.write(json.dumps(row,sort_keys=True)+'\n')
    need(rss<=LIMITS['sampled_manager_and_owned_tree_RSS_bytes']and growth<=LIMITS['new_owned_disk_bytes']and free>=LIMITS['minimum_free_bytes'],'Original RSS/disk/free bound')
    need(not foreign,'Foreign compiler/native workload; timing refused')
    metadata=record.setdefault('owned_metadata',[])
    for process in owned.values():
        if process['state']!='Z'and process['comm']in COMPILER_NAMES:
            observation=owned_version(custody,process)
            if observation is not None:
                prior=next((r for r in metadata if(r['pid'],r['start'])==(observation['pid'],observation['start'])),None)
                if prior is not None:need(observation['command']==prior['command']and observation['executable']==prior['executable']and observation['observed_monotonic_ns']-prior['observed_monotonic_ns']<=20*NS,'Owned version metadata exceeded original20s or changed')
                need(len(metadata)<4096,'Owned metadata observation bound');metadata.append(observation)
    return row

def completed_worker(runtime,context,repo,worker,raw,index,work_deadline_ns,metadata):
    result=read(worker/'result.json');need(type(result.get('schema'))is int and result.get('schema')==1 and result.get('kind')=='paired-linux-original-runtime-workload'and type(result.get('index'))is int and result.get('index')==index and result.get('original_main_completed')is True and result.get('actual_pairs')==5 and result.get('Root_final_timing_acceptance')is False,'Actual original workload completion required')
    for key in ['role','mode','scenario']:need(result.get(key)==context['method'][key],'Actual original workload identity differs')
    need(result.get('runtime_authority')==context['authority_pin']and result.get('reuse')==context['reuse_pin'],'Actual worker authority/reuse differs')
    for key in ['execution_source_commit','producer_source_commit']:need(result.get(key)==context['authority'][key],'Actual worker Source differs')
    need(result.get('pair_order')==['rust','zig','zig','rust','rust','zig','zig','rust','rust','zig'],'Original five balanced pairs required')
    need(type(result['raw_result'])is dict and Path(result['raw_result']['path']).is_relative_to(raw),'Original raw result outside selected root');primary=checked(result['raw_result']);catalog=result['raw_outputs'];need(catalog['root']==str(raw)and type(catalog['files'])is list and len(catalog['files'])<=50000,'Closed raw output catalog required');seen=set();total=0
    for row in catalog['files']:
        need(type(row)is dict and Path(row['path']).is_relative_to(raw)and type(row.get('bytes'))is int and row['bytes']>=0 and total+row['bytes']<=LIMITS['new_owned_disk_bytes'],'Raw output root/byte bound differs')
        path=checked(row);need(path not in seen,'Raw output duplicate differs');seen.add(path);total+=row['bytes']
    need(type(catalog['bytes'])is int and total==catalog['bytes']and total<=LIMITS['new_owned_disk_bytes']and primary in seen,'Raw output bytes/result missing')
    actual=set()
    for path in raw.rglob('*'):
        need(not path.is_symlink(),'Raw output link refused')
        if path.is_file():actual.add(path)
    need(actual==seen,'Raw output closed membership differs')
    waits=result['actual_original_wait4_rows'];need(type(waits)is list and waits and len(waits)<=1000,'Actual original measured wait4 rows required')
    for ordinal,row in enumerate(waits):
        need(type(row.get('launch_ordinal'))is int and row.get('launch_ordinal')==ordinal and row.get('actual_original_wait4')is True and type(row.get('pid'))is int and row['pid']>0 and type(row.get('exit_code'))is int,'Actual original wait4 identity/status required')
        group=row['implementation'];role=row['role'];need(group in {'rust','zig'}and role in {'relayer','validator','scraper'},'Original measured role identity')
        artifact=context['manifest']['artifacts'][group][context['method']['mode']][role]if group=='zig'else context['manifest']['artifacts'][group][role]
        need(runtime.pin(runtime.checked(artifact,context['inputs_root']))==row['binary'],'Actual measured binary differs')
        need(type(row['original_start_ns'])is int and type(row['original_end_ns'])is int and 0<row['original_start_ns']<=row['original_end_ns']<work_deadline_ns,'Actual original measured clock differs')
        for key in ['user_seconds','system_seconds']:need(type(row[key])in(int,float)and math.isfinite(row[key])and row[key]>=0,'Actual wait4 CPU units invalid')
        for key in ['max_child_RSS_bytes','voluntary_context_switches','involuntary_context_switches']:need(type(row[key])is int and row[key]>=0,'Actual wait4 RSS/context units invalid')
    role=context['method']['role'];expected=5 if role=='validator'else 10
    need(all(sum(r['implementation']==name and r['role']==role for r in waits)==expected for name in ['rust','zig']),'Original direct wait4 census differs')
    metadata_before_measurement(metadata,waits);runtime.source_recheck(context,repo);return pin(worker/'result.json')

def cleanup_postgres(pg,handoff,execution_deadline_ns):
    if handoff is None:return {'required':False,'passed':True,'daemon_parent_wait_credit':False}
    journal=handoff['journal'];clock_error=None
    try:
        value=read(journal);clock=value['context'];need(clock['execution_deadline']==execution_deadline_ns/NS and clock['cleanup_deadline']==(execution_deadline_ns+60*NS)/NS,'Original PG execution/cleanup clock differs')
    except BaseException as error:clock_error=error
    # The PG implementation independently validates original boot/UID/token/CID
    # and immutable caps. A caller-side failed check cannot skip owned teardown.
    result=pg.cleanup_all(policy=pg.POLICY,docker=handoff['docker'],docker_config=handoff['docker_config'],token=handoff['token'],receipts=handoff['receipts'],deadline=(execution_deadline_ns+60*NS)/NS)
    if clock_error is not None:raise clock_error
    need(result.get('passed')is True and result.get('container_absent')is True and result.get('cleanup_failures',[])==[]and result.get('daemon_parent_wait_credit')is False,'Actual PG cleanup/absence failed')
    need(time.monotonic_ns()<=execution_deadline_ns+60*NS,'PG cleanup completed late');return {'required':True,'passed':True,'journal':pin(journal),'daemon_parent_wait_credit':False}

def publish(output,result,deadline_ns,final_check=lambda:None):
    path=output/'owner-result.json'
    def write(stream):
        wire=(json.dumps(result,sort_keys=True,separators=(',',':'),allow_nan=False)+'\n').encode();need(len(wire)<=2*1024**2,'Owner result size bound');stream.seek(0);stream.write(wire);stream.truncate();stream.flush();os.fsync(stream.fileno())
    candidate=result['passed'];result['passed']=False
    with path.open('xb')as stream:
        write(stream)  # Publication remains false until its own I/O is counted.
        try:
            final_check();need(time.monotonic_ns()<=deadline_ns and shutil.disk_usage(output).free>=LIMITS['minimum_free_bytes'],'Final publication deadline/free floor')
            result['passed']=candidate;write(stream)
            final_check();need(time.monotonic_ns()<=deadline_ns and shutil.disk_usage(output).free>=LIMITS['minimum_free_bytes'],'Final publication completed late')
        except BaseException as error:
            result['passed']=False;result['errors'].append({'stage':'publication','type':type(error).__name__});write(stream)
    return result


def owner(args):
    started=time.monotonic_ns();deadline=started+LIMITS['wall_seconds']*NS;work_deadline=deadline-40*NS;loaded=admission(args)
    if loaded is None:return {'enabled':False,'passed':False,'native_or_timing_acceptance':False}
    runtime,context,custody,pg=loaded
    clock_backend()
    need(sys.platform=='linux'and hasattr(os,'pidfd_open')and hasattr(signal,'pidfd_send_signal'),'Linux pidfd/subreaper custody required')
    output=args.output;need(output.is_absolute()and output.parent.resolve(strict=True)==output.parent and not output.exists()and not output.is_symlink()and not output.is_relative_to(args.repo)and not output.is_relative_to(context['inputs_root'])and not context['inputs_root'].is_relative_to(output),'Fresh external owner root required')
    need(time.monotonic_ns()<work_deadline and shutil.disk_usage(output.parent).free>=LIMITS['minimum_free_bytes'],'Original prework deadline/free bound')
    worker,raw,paths,handoff=planned_paths(runtime,context,args.repo,output,args.index);custody.enable_subreaper();output.mkdir(mode=0o700);(output/'tmp').mkdir(mode=0o700)
    baseline={str(p):custody.allocated(p)if p.exists()else 0 for p in paths};known={};groups={};child=None;cleanup=None;receipt=None;pg_cleanup=None;completed=False;stopped_by_deadline=False;errors=[];record={'sampled_RSS_peak_bytes':0,'new_disk_peak_bytes':0,'minimum_free_bytes':shutil.disk_usage(output).free,'resource_samples':0}
    watched=[signal.SIGINT,signal.SIGTERM,signal.SIGHUP];previous={s:signal.getsignal(s)for s in watched}
    def interrupted(*_):raise TaskInterrupted('Owned runtime interrupted')
    def failure(stage,error):errors.append({'stage':stage,'type':type(error).__name__})
    for s in watched:signal.signal(s,interrupted)
    try:
        resources(custody,paths,baseline,output,None,known,groups,False,'before',record)
        runtime.source_recheck(context,args.repo);need(time.monotonic_ns()<work_deadline,'Admission completed beyond original positive-work budget')
        argv=[sys.executable,'-I','-B',str(args.repo/SOURCE['runtime']),'--runtime-authority',str(args.runtime_authority),'--runtime-authority-sha256',args.runtime_authority_sha256,'--reuse',str(args.reuse),'--reuse-sha256',args.reuse_sha256,'--repo',str(args.repo),'--output',str(worker),'--index',str(args.index),'--execution-deadline-ns',str(deadline),'--work-deadline-ns',str(work_deadline)]
        env={k:os.environ[k]for k in ['PATH','HOME','LANG']if k in os.environ};env.update(TMPDIR=str(output/'tmp'),LC_ALL='C.UTF-8',PYTHONDONTWRITEBYTECODE='1',PYTHONNOUSERSITE='1')
        with(output/'worker.log').open('xb')as log:
            mask=signal.pthread_sigmask(signal.SIG_BLOCK,watched)
            try:
                def unmask():signal.pthread_sigmask(signal.SIG_SETMASK,mask)
                child=subprocess.Popen(argv,cwd=args.repo,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True,preexec_fn=unmask);groups[child.pid]=child.pid
            finally:signal.pthread_sigmask(signal.SIG_SETMASK,mask)
            while True:
                need(time.monotonic_ns()<work_deadline,'Original positive-work deadline exhausted')
                resources(custody,paths,baseline,output,child,known,groups,True,'during',record)
                event=os.waitid(os.P_PID,child.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT)
                if event is not None:
                    need(event.si_pid==child.pid,'Direct exit observation identity differs')
                    need(time.monotonic_ns()<work_deadline,'Actual worker completed late');completed=True;break
                time.sleep(.25)
    except BaseException as error:failure('work',error)
    finally:
        for s in watched:signal.signal(s,signal.SIG_IGN)
        try:
            if child is not None:
                remaining=max(0,(deadline-time.monotonic_ns())/NS);kill=min(10,remaining);grace=min(30,max(0,remaining-kill))
                cleanup=custody.stop_owned(child,known,groups,grace_seconds=grace,kill_seconds=kill)
                stopped_by_deadline=time.monotonic_ns()<=deadline
                need(stopped_by_deadline,'Owned worker stop completed beyond original execution deadline')
        except BaseException as error:failure('worker_stop',error)
        # Keep PG cleanup independent of worker status, signals, parent-wait or
        # positive receipt validation. It cannot repair any earlier failure.
        try:pg_cleanup=cleanup_postgres(pg,handoff if child is not None else None,deadline)
        except BaseException as error:failure('postgres_cleanup',error)
        try:
            resources(custody,paths,baseline,output,child,known,groups,False,'after',record)
            runtime.source_recheck(context,args.repo)
            if completed and not errors:receipt=completed_worker(runtime,context,args.repo,worker,raw,args.index,work_deadline,record.get('owned_metadata',[]))
        except BaseException as error:failure('postconditions',error)
        clean=cleanup is not None and cleanup.get('actual_parent_wait')is True and cleanup.get('exit_code')==0 and cleanup.get('clean')is True and cleanup.get('cleanup_confirmed_absent')is True and not cleanup.get('signals')and not cleanup.get('errors')and not cleanup.get('remaining_identities')and not cleanup.get('unanchored_session_members')
        passed=not errors and completed and stopped_by_deadline and clean and receipt is not None and pg_cleanup is not None and pg_cleanup['passed']is True and time.monotonic_ns()<=deadline+60*NS
        result={'schema':1,'kind':'paired-linux-owned-runtime-v1','enabled':True,'passed':passed,'index':args.index,'limits':LIMITS,'started_monotonic_ns':started,'original_execution_deadline_ns':deadline,'original_work_deadline_ns':work_deadline,'original_PG_cleanup_deadline_ns':deadline+60*NS,'ended_monotonic_ns':time.monotonic_ns(),'runtime_authority':context['authority_pin'],'reuse':context['reuse_pin'],'worker_receipt':receipt,'cleanup':cleanup,'postgres_cleanup':pg_cleanup,'errors':errors,'resources':record,'measured_agent_wait4_scope':'Original daemon wait4 rows in checked worker receipt; sampled outer RSS is separate','Root_final_timing_acceptance':False}
        def final_check():
            current=custody.processes();owned=custody.owned_processes(current,child.pid if child else -1,known,groups,False)
            need(os.getpid()in current and current[os.getpid()]['rss_bytes']+sum(r['rss_bytes']for r in owned.values())<=LIMITS['sampled_manager_and_owned_tree_RSS_bytes'],'Final manager/tree RSS bound')
            need(not foreign_compilers(custody,current,owned),'Final foreign compiler/native workload')
            need(sum(max(0,(custody.allocated(p)if p.exists()else 0)-baseline[str(p)])for p in paths)<=LIMITS['new_owned_disk_bytes'],'Final publication disk bound')
            runtime.source_recheck(context,args.repo)
        try:publish(output,result,deadline+60*NS,final_check)
        finally:
            for s,handler in previous.items():signal.signal(s,handler)
    need(result['passed'],'Paired runtime owner refused; closed evidence retained');return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ['runtime-authority','reuse','repo','output']:parser.add_argument('--'+name,type=Path,required=True)
    parser.add_argument('--runtime-authority-sha256',required=True);parser.add_argument('--reuse-sha256',required=True);parser.add_argument('--index',type=int,required=True);args=parser.parse_args();owner(args)

if __name__=='__main__':main()
