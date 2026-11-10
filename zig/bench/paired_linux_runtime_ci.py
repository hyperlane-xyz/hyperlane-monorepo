#!/usr/bin/env python3
"""Independent runtime CI gates/reuse/budget mint. Inert until actual Root pins."""
from pathlib import Path
import argparse
import calendar
import datetime
import hashlib
import json
import math
import os
import re
import resource
import signal
import sys
import time
import types

NS=10**9
REPO='hyperlane-xyz/hyperlane-monorepo'
BRANCH='refs/heads/feat/zig-agent-rewrite'
WORKFLOW='.github/workflows/zig-agents.yml'
SELF='zig/bench/paired_linux_runtime_ci.py'
REQUEST='zig/bench/paired_linux_runtime_request.json'
METHODS_SHA=('0ef8f04ec32387abf5cb0be2f72a96f1' '58bd33afd760c6ea1de05cf1257e95f1')
FIELDS={'schema','kind','root_approved','reuse_header','cohort_qualification','native18_qualification','general_CI_qualification','final_Source_qualification','methods','required_source'}
MODES=('ReleaseSafe','ReleaseFast')
FAMILIES=('evm','cosmosnative','cosmwasm','starknet','tron','sealevel','sealevel-composite','radix','aleo')
PRODUCTS={'relayer','validator','scraper','worker','aleoCrypto','aleoVm','starknetCrypto','regex','url'}
MINIMUM_REMAINING_NS=18110*NS
JOB_WALL_NS=330*60*NS
MEASURED_STEP_WALL_NS=306*60*NS
MEASURED_STEP_NAME='Check actual job budget and supervise the unchanged original workload'
REQUIRED_SOURCE={'zig/bench/native_tron_setup.py','zig/bench/native_tron_assets.py','zig/tools/foundry_official.py','zig/tools/foundry_official_test.py','zig/tools/foundry_public_good_root.json','zig/bench/cold_matrix_owner.py', 'zig/bench/relayer.py', 'zig/bench/inventory.py', 'zig/bench/paired_linux_platform_test.py', 'zig/reference/evm/src/main.rs', 'zig/bench/native_harness_controls.py', '.nvmrc', 'zig/integration/tls_fixture.py', 'zig/bench/scraper.py', 'zig/bench/paired_linux_runtime.py', 'zig/bench/paired_linux_stage.py', 'zig/reference/evm/Cargo.toml', 'zig/integration/public_relay_process.py', 'zig/bench/paired_linux.py', 'zig/bench/paired_linux_runtime_test.py', 'zig/bench/paired_linux_inputs.py', 'zig/bench/paired_linux_postgres.py', 'package.json', 'zig/bench/paired_linux_owner.py', 'zig/integration/faults/seal_crash.c', 'zig/bench/native_case_tools.py', 'zig/bench/paired_linux_proofs.py', 'zig/bench/paired_linux_runtime_ci.py', 'zig/integration/relayer_process.py', 'zig/bench/paired_linux_runtime_ci_test.py', 'zig/bench/native_case_request.json', 'zig/bench/paired_linux_methods.json', 'zig/integration/faults/seal_crash_test.c', 'zig/bench/paired_linux_reuse.py', 'zig/bench/cohort_readback.py', 'zig/integration/native_case_inputs.py', '.github/workflows/zig-agents.yml', 'zig/reference/evm/Cargo.lock.gz', 'zig/bench/paired_linux_runtime_owner.py', 'zig/bench/native_case_ci.py', 'zig/integration/relayer_stream.py', 'zig/integration/evm.py', 'zig/integration/validator.py', 'zig/bench/native_payload_export.py', 'zig/bench/validator.py', 'zig/tools/build_cpu.py', 'zig/bench/native_harness_census.py', 'zig/bench/paired_linux_runtime_owner_test.py', 'zig/bench/paired_linux_reuse_test.py'}
class Refused(RuntimeError):pass

def need(value,reason):
    if not value:raise Refused(reason)

def integer(value,low=0,high=2**63-1):return type(value)is int and low<=value<=high

def decode(raw):
    need(type(raw)is bytes and len(raw)<=64*1024**2,'Metadata bound')
    def pairs(rows):
        out={}
        for k,v in rows:need(k not in out,'Duplicate JSON key');out[k]=v
        return out
    value=json.loads(raw,object_pairs_hook=pairs,parse_constant=lambda _:(_ for _ in()).throw(Refused('Nonfinite JSON')));nodes=0
    def walk(v,depth=0):
        nonlocal nodes
        nodes+=1;need(depth<=32 and nodes<=1000000,'Metadata structure')
        if type(v)is dict:
            if set(v)=={'sha256_hex_chunks'}:
                parts=v['sha256_hex_chunks'];need(type(parts)is list and len(parts)==2 and all(type(p)is str and re.fullmatch('[0-9a-f]{32}',p)for p in parts),'Digest chunks');return ''.join(parts)
            return{k:walk(x,depth+1)for k,x in v.items()}
        if type(v)is list:return[walk(x,depth+1)for x in v]
        if type(v)is float:need(math.isfinite(v),'Nonfinite JSON')
        return v
    return walk(value)

def relative(text):
    need(type(text)is str and text and Path(text).as_posix()==text and not Path(text).is_absolute()and all(x not in {'.','..'}for x in Path(text).parts)and not any(c in text for c in ['\\','\0','\n','\r']),'Canonical relative path');return text

def descriptor(row,maximum=64*1024**2):
    need(type(row)is dict and set(row)=={'path','bytes','sha256'}and integer(row['bytes'],0,maximum)and type(row['sha256'])is str and re.fullmatch('[0-9a-f]{64}',row['sha256']),'Exact bounded descriptor');return row

def captured(row,repo=None,maximum=64*1024**2):
    descriptor(row,maximum);path=Path(row['path'])if repo is None else Path(repo)/relative(row['path']);need(path.is_absolute()and path.resolve(strict=True)==path and path.is_file()and not path.is_symlink(),'Canonical input')
    before=path.stat()
    with path.open('rb')as stream:raw=stream.read(maximum+1)
    after=path.stat();need((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns)and len(raw)==row['bytes']and hashlib.sha256(raw).hexdigest()==row['sha256'],'Captured input changed');return path,raw

def pin(path):
    path=Path(path);need(path.is_file()and not path.is_symlink()and path.resolve(strict=True)==path,'Canonical metadata file');before=path.stat()
    with path.open('rb')as stream:digest=hashlib.file_digest(stream,'sha256').hexdigest()
    after=path.stat();need((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns),'Metadata changed');return {'path':str(path),'bytes':after.st_size,'sha256':digest}

def data(row,repo=None):return decode(captured(row,repo)[1])

def write(path,value):
    wire=(json.dumps(value,sort_keys=True,allow_nan=False)+'\n').encode();need(len(wire)<=64*1024**2,'Publication bound')
    with Path(path).open('xb')as stream:stream.write(wire);stream.flush();os.fsync(stream.fileno())
    return pin(path)

def source_module(context,relative_path,name):
    row=context['source'][relative_path];path,wire=captured(row,context['repo'],16*1024**2);need(name not in sys.modules,'Foreign preloaded gate module')
    module=types.ModuleType(name);module.__file__=str(path);sys.modules[name]=module
    try:exec(compile(wire,str(path),'exec'),module.__dict__)
    except BaseException:sys.modules.pop(name,None);raise
    return module

def root_dto(context,key,kind,fields,*,schema=1):
    value=data(context['request'][key],context['repo']);need(type(value)is dict and set(value)==fields and type(value['schema'])is int and value['schema']==schema and value['kind']==kind and value['root_approved']is True and value['passed']is True,'Actual Root qualification required: '+key);return value

def request(path,expected,repo):
    repo=Path(repo);need(repo.is_absolute()and repo.resolve(strict=True)==repo,'Canonical checkout');need(Path(path).stat().st_size<=2*1024**2,'Request metadata bound before hash');row=pin(path);need(row['sha256']==expected,'Request pin');value=decode(captured(row,maximum=2*1024**2)[1]);need(type(value)is dict and set(value)==FIELDS and type(value['schema'])is int and value['schema']==1 and value['kind']=='paired-linux-runtime-ci-v1'and type(value['root_approved'])is bool,'Closed runtime request')
    if not value['root_approved']:
        need(value['required_source']==[]and all(value[k]is None for k in FIELDS-{'schema','kind','root_approved','required_source'}),'Unapproved future gates must remain null');return None
    need(Path(path)==repo/REQUEST,'Fixed committed runtime request path')
    rows=value['required_source'];need(type(rows)is list and len(rows)==len(REQUIRED_SOURCE)and{r['path']for r in rows}==REQUIRED_SOURCE,'Full finite runtime CI Source closure')
    source={}
    for item in rows:
        need(item['path']not in source,'Duplicate Source');captured(item,repo,16*1024**2);source[item['path']]=item
    need(captured(source[SELF],repo)[0]==Path(__file__).resolve(),'Actual runtime CI Source differs')
    context={'request':value,'request_pin':row,'repo':repo,'source':source}
    native_selector=decode(captured(source['zig/bench/native_case_request.json'],repo)[1]);need(native_selector.get('root_approved')is False,'Native case selector must remain inert for runtime route')
    cohort=data(value['cohort_qualification'],repo);need(cohort.get('passed')is True and cohort.get('root_approved')is True and cohort.get('Root_actual_cohort_acceptance')is True and cohort.get('all8_same_run_required_product_artifacts')is True and type(cohort.get('source_commit'))is str and re.fullmatch('[0-9a-f]{40}',cohort['source_commit']),'Actual coherent eight-product Root qualification')
    need(set(cohort.get('eight_artifacts',{}))=={'sdk_safe','sdk_fast','helper','tools','writer_safe','writer_fast','svm','radix_reference'}and len(cohort.get('all4_required_jobs_actual_success',[]))==4,'Exact fresh eight/four-job cohort')
    jobs=cohort['all4_required_jobs_actual_success'];need({j.get('name')for j in jobs}=={'full-sdk-native (ReleaseSafe)','full-sdk-native (ReleaseFast)','native-harness-controls','svm-prerequisites'}and len({j.get('id')for j in jobs})==4 and all(integer(j.get('id'),1)for j in jobs),'Exact four actual producer jobs')
    for artifact in cohort['eight_artifacts'].values():need(type(artifact)is dict and set(artifact)=={'id','name','size_in_bytes','sha256'}and integer(artifact['id'],1)and integer(artifact['size_in_bytes'],1)and type(artifact['sha256'])is str and re.fullmatch('[0-9a-f]{64}',artifact['sha256']),'Actual coherent artifact pin')
    context['producer']=cohort['source_commit'];context['cohort']=cohort
    native=root_dto(context,'native18_qualification','paired-linux-Root-native18-v1',{'schema','kind','root_approved','passed','producer_source_commit','cases'})
    need(native['producer_source_commit']==context['producer']and type(native['cases'])is list and len(native['cases'])==18,'Actual fresh native18 cohort')
    seen=set()
    for case in native['cases']:
        need(type(case)is dict and set(case)=={'family','mode','passed','public_proof','Root_readback','runtime_products'},'Closed actual native row');identity=(case['family'],case['mode']);need(identity not in seen and case['family']in FAMILIES and case['mode']in MODES and case['passed']is True,'Actual native family/mode verdict');seen.add(identity)
        for field in ['public_proof','Root_readback']:captured(case[field],repo)
        need(type(case['runtime_products'])is dict and set(case['runtime_products'])==PRODUCTS,'All nine actual runtime input hashes')
        for product in case['runtime_products'].values():need(type(product)is dict and set(product)=={'bytes','sha256'}and integer(product['bytes'],1,2*1024**3)and type(product['sha256'])is str and re.fullmatch('[0-9a-f]{64}',product['sha256']),'Actual native runtime product identity')
    need(seen=={(family,mode)for family in FAMILIES for mode in MODES},'All nine families both modes required');context['native']=native
    ci=root_dto(context,'general_CI_qualification','paired-linux-Root-general-CI-v1',{'schema','kind','root_approved','passed','producer_source_commit','Source_scope_qualified','required_jobs','jobs'})
    need(ci['producer_source_commit']==context['producer']and ci['Source_scope_qualified']is True and type(ci['required_jobs'])is list and ci['required_jobs']and len(set(ci['required_jobs']))==len(ci['required_jobs'])and type(ci['jobs'])is list and{j['name']for j in ci['jobs']}==set(ci['required_jobs'])and len(ci['jobs'])==len(ci['required_jobs']),'Actual general CI qualification')
    for job in ci['jobs']:
        need(type(job)is dict and set(job)=={'name','run_id','run_attempt','job_id','source_commit','conclusion','Root_readback'}and all(integer(job[k],1)for k in ['run_id','run_attempt','job_id'])and type(job['source_commit'])is str and re.fullmatch('[0-9a-f]{40}',job['source_commit'])and job['conclusion']=='success','Actual general CI job');captured(job['Root_readback'],repo)
    context['general']=ci
    final=root_dto(context,'final_Source_qualification','paired-linux-Root-final-Source-v2',{'schema','kind','root_approved','passed','producer_source_commit','runtime_608','Root_readback'},schema=2)
    need(final['producer_source_commit']==context['producer']and type(final['runtime_608'])is list and len(final['runtime_608'])==608 and len({r['path']for r in final['runtime_608']})==608 and any(r['path']=='zig/src/agents/relayer/queue_view.zig'for r in final['runtime_608']),'Actual final608 Source qualification')
    for item in final['runtime_608']:captured(item,repo,16*1024**2)
    captured(final['Root_readback'],repo);context['runtime_608']=final['runtime_608'];context['final']=final
    header=data(value['reuse_header'],repo);need(header.get('root_approved')is True and header.get('producer_source_commit')==context['producer']and header.get('Root_input_accepted')is True and header.get('Root_six_accepted')is True,'Actual original-input/six Root reuse header')
    need(value['methods']['path']=='zig/bench/paired_linux_methods.json'and value['methods']['bytes']==12131 and value['methods']['sha256']==METHODS_SHA,'Exact committed original methods identity');captured(value['methods'],repo);return context

def evidence(context):
    rows=[context['request'][key]for key in FIELDS-{'schema','kind','root_approved','required_source'}]
    rows += [row[field]for row in context['native']['cases']for field in ['public_proof','Root_readback']]
    rows += [row['Root_readback']for row in context['general']['jobs']]+[context['final']['Root_readback']]
    unique={}
    for row in rows:
        need(row['path']not in unique or unique[row['path']]==row,'Contradictory evidence descriptor');unique[row['path']]=row
    return list(unique.values())


def recheck(context):
    for row in context['source'].values():captured(row,context['repo'],16*1024**2)
    for row in context['runtime_608']:captured(row,context['repo'],16*1024**2)
    for row in evidence(context):captured(row,context['repo'])
    captured(context['request_pin'])

def current_identity(environment):
    need(environment.get('GITHUB_REPOSITORY')==REPO and environment.get('GITHUB_EVENT_NAME')=='push'and environment.get('GITHUB_REF')==BRANCH,'Exact independent runtime push route')
    sha=environment.get('GITHUB_SHA');need(type(sha)is str and re.fullmatch('[0-9a-f]{40}',sha),'Actual GitHub Source SHA')
    run=environment.get('GITHUB_RUN_ID');attempt=environment.get('GITHUB_RUN_ATTEMPT');need(type(run)is str and run.isdecimal()and int(run)>0 and type(attempt)is str and attempt.isdecimal()and int(attempt)>0,'Actual run/attempt');return sha,int(run),int(attempt)

def reuse_phase(context,output,gh,environment):
    sha,_,_=current_identity(environment);need(output.is_absolute()and output.parent.resolve(strict=True)==output.parent and not output.exists()and not output.is_relative_to(context['repo']),'Fresh external reuse stage')
    source_module(context,'zig/bench/paired_linux.py','paired_linux');module=source_module(context,'zig/bench/paired_linux_reuse.py','paired_linux_reuse')
    header={**context['request']['reuse_header'],'path':str(context['repo']/context['request']['reuse_header']['path'])}
    result=module.reuse(header,context['repo'],output,sha,gh,environment.get('GH_TOKEN'))
    need(result.get('enabled')is True and result.get('accepted_six')is not None,'Actual completed reuse required');recheck(context);return write(output/'reuse-result-binding.json',result)

def started_ns(text):
    need(type(text)is str and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z',text),'Actual job started_at UTC required');dt=datetime.datetime.fromisoformat(text.replace('Z','+00:00'));return calendar.timegm(dt.utctimetuple())*NS+dt.microsecond*1000

def actual_budget(run,jobs,source,run_id,attempt,index,before_mono,before_utc,after_mono,after_utc):
    need(integer(index,0,9)and run.get('id')==run_id and run.get('run_attempt')==attempt and run.get('head_sha')==source and run.get('event')=='push'and run.get('head_branch')=='feat/zig-agent-rewrite'and run.get('status')=='in_progress'and run.get('path')==WORKFLOW and run.get('repository',{}).get('full_name')==REPO and run.get('head_repository',{}).get('full_name')==REPO,'Actual current runtime run identity')
    message=run.get('head_commit',{}).get('message','');need(type(message)is str and '[zig-native-case]'in message and '[zig-paired-runtime]'in message,'Actual dual-marker run required')
    selected=[j for j in jobs if j.get('name')==f'paired-linux-runtime ({index})'];need(len(selected)==1,'Exact unique current matrix job')
    job=selected[0];need(integer(job.get('id'),1)and job.get('run_id')==run_id and job.get('run_attempt')==attempt and job.get('status')=='in_progress'and job.get('conclusion')is None,'Actual current in-progress job')
    need(all(integer(x)for x in [before_mono,before_utc,after_mono,after_utc])and after_mono>=before_mono and after_utc>=before_utc and abs((after_utc-before_utc)-(after_mono-before_mono))<=NS,'UTC/monotonic observation shifted')
    start=started_ns(job.get('started_at'));need(start<=before_utc,'Actual job clock is future')
    steps=job.get('steps');need(type(steps)is list and 1<=len(steps)<=1000 and all(type(row)is dict for row in steps),'Actual bounded current step inventory')
    selected_steps=[row for row in steps if row.get('name')==MEASURED_STEP_NAME];need(len(selected_steps)==1,'Exact unique current measured step');step=selected_steps[0]
    need(integer(step.get('number'),1,1000)and sum(row.get('number')==step['number']for row in steps)==1 and step.get('status')=='in_progress'and step.get('conclusion')is None and step.get('completed_at')is None,'Actual unique in-progress measured step identity')
    step_start=started_ns(step.get('started_at'));need(start<=step_start<=before_utc,'Actual measured step clock is future or predates job')
    observed_utc=max(after_utc,before_utc+after_mono-before_mono);job_deadline=start+JOB_WALL_NS;step_deadline=step_start+MEASURED_STEP_WALL_NS;job_remaining=job_deadline-observed_utc;step_remaining=step_deadline-observed_utc;remaining=min(job_remaining,step_remaining)
    need(remaining>=MINIMUM_REMAINING_NS,'Insufficient original job or measured-step budget')
    return {'job_id':job['id'],'job_name':job['name'],'run_id':run_id,'run_attempt':attempt,'source_commit':source,'actual_started_at':job['started_at'],'job_wall_seconds':330*60,'actual_step_number':step['number'],'actual_step_name':step['name'],'actual_step_started_at':step['started_at'],'step_wall_seconds':306*60,'job_deadline_UTC_ns':job_deadline,'step_deadline_UTC_ns':step_deadline,'observed_monotonic_ns':after_mono,'observed_UTC_ns':observed_utc,'minimum_remaining_seconds':18110,'remaining_ns':remaining,'job_remaining_ns':job_remaining,'step_remaining_ns':step_remaining,'conservative_job_deadline_monotonic_ns':after_mono+job_remaining,'conservative_step_deadline_monotonic_ns':after_mono+step_remaining}


def quiet(custody):
    rows=custody.processes();bad=[{'pid':pid,'start':r['start'],'comm':r['comm']}for pid,r in rows.items()if pid!=os.getpid()and r['state']!='Z'and r['comm']in custody.COMPILERS];need(not bad,'Actual foreign compiler/native workload before owner')
    return {'schema':1,'kind':'paired-linux-actual-prework-quiet-v1','passed':True,'observed_monotonic_ns':time.monotonic_ns(),'foreign_compilers':bad,'exclusive_host_claim':False}


def mint(context,reuse_pin,output,gh,index,environment,owner_output):
    source,run_id,attempt=current_identity(environment);need(integer(index,0,9),'One fixed workload index');need(owner_output is not None and owner_output.is_absolute()and owner_output.parent.resolve(strict=True)==owner_output.parent and not owner_output.exists()and not owner_output.is_relative_to(context['repo']),'Fresh outside-Source owner output');binding=data(reuse_pin);need(binding.get('enabled')is True and binding.get('accepted_six')is not None and binding.get('provenance',{}).get('current_execution_source_commit')==source and binding['provenance'].get('product_source_commit')==context['producer'],'Actual same execution reuse binding')
    need(output.is_absolute()and output.parent.resolve(strict=True)==output.parent and not output.exists()and not output.is_relative_to(context['repo']),'Fresh outside-Source mint root');output.mkdir(mode=0o700)
    source_module(context,'zig/bench/paired_linux.py','paired_linux');reader=source_module(context,'zig/bench/cohort_readback.py','paired_runtime_CI_reader');custody=source_module(context,'zig/bench/cold_matrix_owner.py','paired_runtime_CI_quiet');stage=source_module(context,'zig/bench/paired_linux_stage.py','paired_runtime_CI_interrupts')
    resource.setrlimit(resource.RLIMIT_AS,(1024**3,1024**3));guard=reader.Guard(output,{**reader.LIMITS,'wall_seconds':180,'cleanup_seconds':30,'owned_disk_bytes':512*1024**2});runner=reader.Runner(output,context['repo'],gh,guard,environment.get('GH_TOKEN'));failure=None;previous=stage.arm_interrupts(guard)
    try:
        head,_=runner.git(['rev-parse','HEAD'],maximum=128);need(head.read_text().strip()==source,'Actual checkout differs from GitHub Source')
        request_relative={**context['request_pin'],'path':REQUEST}
        for row in [*context['source'].values(),*context['runtime_608'],request_relative,*evidence(context)]:
            raw,_=runner.git(['show',source+':'+row['path']],maximum=16*1024**2);need(raw.stat().st_size==row['bytes']and hashlib.sha256(raw.read_bytes()).hexdigest()==row['sha256'],'Actual Git Source blob differs')
        recheck(context);manifest=data(binding['input_manifest']);need(manifest.get('producer_source_commit')==context['producer'],'Reused actual product Source differs')
        for case in context['native']['cases']:
            for name,expected in case['runtime_products'].items():
                actual=manifest['artifacts']['zig'][case['mode']][name];need({k:actual[k]for k in ['bytes','sha256']}==expected,'Native18 does not use actual reused fresh SDK bytes')
        observed=quiet(custody);before_mono=time.monotonic_ns();before_utc=time.time_ns();base=f'repos/{REPO}/actions/runs/{run_id}/attempts/{attempt}'
        def api(endpoint):
            path,_=runner.call([str(runner.gh),'api','--hostname','github.com','-H','Accept: application/vnd.github+json',endpoint],'API_JSON',16*1024**2);return decode(path.read_bytes())
        run=api(base);jobs=[];total=None
        for page in range(1,21):
            value=api(base+f'/jobs?per_page=100&page={page}');need(type(value.get('jobs'))is list and integer(value.get('total_count'),1,2000),'Current jobs page');need(total is None or total==value['total_count'],'Current jobs total changed');total=value['total_count'];jobs+=value['jobs']
            if len(jobs)>=total:break
        need(len(jobs)==total and len({j.get('id')for j in jobs})==total,'Complete unique current job membership');budget=actual_budget(run,jobs,source,run_id,attempt,index,before_mono,before_utc,time.monotonic_ns(),time.time_ns());observed['job_budget']=budget;quiet_pin=write(output/'actual-prework-quiet-and-budget.json',observed)
        accepted=data(binding['accepted_six']);need(accepted.get('passed')is True and accepted.get('whole_original_proof_source_unchanged')is True,'Actual accepted-six join');recheck(context);guard();commands=runner.summary();need(commands['all_calls_actually_waited']is True and commands['failure_count']==0,'Actual preparation waits required')
        authority={'schema':1,'kind':'paired-linux-runtime-authority-v1','root_approved':True,'execution_source_commit':source,'producer_source_commit':context['producer'],'methods':{**context['request']['methods'],'path':str(context['repo']/context['request']['methods']['path'])},'required_source':list(context['source'].values()),'accepted_six':{'artifact':binding['accepted_six'],'Root_passed':True},'final_native18':{'artifact':{**context['request']['native18_qualification'],'path':str(context['repo']/context['request']['native18_qualification']['path'])},'Root_passed':True},'quiet':{'artifact':quiet_pin,'Root_passed':True}}
        need(min(budget['conservative_job_deadline_monotonic_ns'],budget['conservative_step_deadline_monotonic_ns'])-time.monotonic_ns()>=MINIMUM_REMAINING_NS,'Job or measured-step budget consumed before authority publication');result=write(output/'runtime-authority.json',authority);guard();write(output/'mint-result.json',{'schema':1,'passed':True,'authority':result,'reuse':reuse_pin,'actual_job_budget':budget,'actual_commands':commands,'Root_final_timing_acceptance':False});guard();emit_paths(context,result,owner_output,index);guard();return result
    except BaseException as error:failure=error;raise
    finally:
        cleanup_error=None
        try:guard.cleanup()
        except BaseException as error:cleanup_error=error
        try:stage.restore_interrupts(previous)
        except BaseException as error:cleanup_error=cleanup_error or error
        if failure is not None or cleanup_error is not None:
            path=output/'runtime-authority.json'
            if path.exists():
                with path.open('w')as stream:json.dump({'schema':1,'kind':'paired-linux-runtime-authority-v1','root_approved':False},stream);stream.flush();os.fsync(stream.fileno())
            failed=output/'mint-result.json';failed_value={'schema':1,'passed':False,'error_type':type(failure or cleanup_error).__name__,'cleanup_error_type':None if cleanup_error is None else type(cleanup_error).__name__,'actual_commands':runner.summary(),'Root_final_timing_acceptance':False}
            if failed.exists():
                with failed.open('w')as stream:json.dump(failed_value,stream,allow_nan=False);stream.flush();os.fsync(stream.fileno())
            else:write(failed,failed_value)
        if failure is None and cleanup_error is not None:raise cleanup_error


def emit_paths(context,authority,owner_output,index):
    need(owner_output.is_absolute()and owner_output.parent.resolve(strict=True)==owner_output.parent and not owner_output.exists()and not owner_output.is_relative_to(context['repo'])and not any(x in str(owner_output)for x in ['\n','\r']),'Fresh exact external owner output')
    methods=data(context['request']['methods'],context['repo']);method=methods['sequence'][index];worker=owner_output/'worker';token=hashlib.sha256((str(worker)+authority['sha256']).encode()).hexdigest()[:32]
    raw=context['repo']/'zig/bench/results'/('scraper-process-linux-'+token+'-'+str(index))if method['role']=='scraper'else worker/'raw'
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'],'a')as stream:
            for key,value in {'runtime_authority':authority['path'],'authority_sha256':authority['sha256'],'raw_output':str(raw)}.items():stream.write(key+'='+value+'\n')
    return raw


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('action',choices=['select','reuse','mint']);parser.add_argument('--request',type=Path,required=True);parser.add_argument('--request-sha256',required=True);parser.add_argument('--repo',type=Path,required=True);parser.add_argument('--output',type=Path);parser.add_argument('--gh',type=Path);parser.add_argument('--reuse',type=Path);parser.add_argument('--reuse-sha256');parser.add_argument('--index',type=int);parser.add_argument('--owner-output',type=Path);args=parser.parse_args();context=request(args.request,args.request_sha256,args.repo)
    if args.action=='select':
        if os.environ.get('GITHUB_OUTPUT'):
            with open(os.environ['GITHUB_OUTPUT'],'a')as stream:stream.write('runtime_enabled='+str(context is not None).lower()+'\n')
        return
    if context is None:return
    need(args.output is not None and args.gh is not None,'Concrete preparation paths required')
    if args.action=='reuse':reuse_phase(context,args.output,args.gh,os.environ)
    else:
        need(args.reuse is not None and args.reuse_sha256 is not None,'Actual completed reuse pin required');row=pin(args.reuse);need(row['sha256']==args.reuse_sha256,'Actual reuse result pin');need(args.owner_output is not None,'Concrete owner output required');mint(context,row,args.output,args.gh,args.index,os.environ,args.owner_output)

if __name__=='__main__':main()
