#!/usr/bin/env python3
"""Compose existing producer artifacts, explicit setup and one owned Linux case.

No SDK/helper/tool/writer compilation. A failed phase never becomes approval;
all runtime proofs remain the actual shared verifier/Source/helper/owner proofs.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time

ROOT=Path(__file__).resolve().parents[2]
GIB=1024**3


def require(value,message):
    if not value:raise ValueError(message)


def pin(path):
    require(path.is_file() and not path.is_symlink(),'Regular composition input required')
    with path.open('rb') as stream:digest=hashlib.file_digest(stream,'sha256').hexdigest()
    return {'path':str(path),'bytes':path.stat().st_size,'sha256':digest}


def load(name,relative):
    spec=importlib.util.spec_from_file_location(name,ROOT/relative);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


def interop_command(repo,context,mode,output):
    require(mode in {'ReleaseSafe','ReleaseFast'},'Closed writer mode required')
    writer=context['writers'][mode];reader=context['tools']['ziggy-native-rows'];manifest=context['tool_manifest']
    return [sys.executable,'-I','-B',str(repo/'zig/integration/native_rows_interop.py'),'--writer',writer['path'],'--writer-sha256',writer['sha256'],'--reader',reader['path'],'--reader-sha256',reader['sha256'],'--tool-manifest',manifest['path'],'--tool-manifest-sha256',manifest['sha256'],'--tool-source-commit',context['runtime_source_commit'],'--output',str(output)]


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ['request','producer-receipt','tools']:parser.add_argument('--'+name,type=Path,required=True);parser.add_argument('--'+name+'-sha256',required=True)
    parser.add_argument('--execution-source-commit',required=True);parser.add_argument('--repo',type=Path,required=True);parser.add_argument('--output',type=Path,required=True);parser.add_argument('--case-root',type=Path,required=True);parser.add_argument('--execute',action='store_true')
    args=parser.parse_args();dispatch=load('run_request','zig/bench/native_case_ci.py')
    for name in ['request','producer_receipt','tools']:require(pin(getattr(args,name))['sha256']==getattr(args,name+'_sha256'),'Composition input changed: '+name)
    request=dispatch.validate_request(dispatch.read_request(args.request))
    require(request['scenario'] in {'evm','cosmosnative','cosmwasm','starknet','sealevel','sealevel-composite','radix','tron'},'Unsupported native composition family')
    require(args.repo.resolve(strict=True)==args.repo and args.output.is_absolute() and not args.output.is_relative_to(args.repo) and not args.output.exists() and not args.output.is_symlink(),'Fresh composition root outside checkout required')
    require(str(args.case_root).startswith('/tmp/znc-') and args.case_root.parent==Path('/tmp') and not args.case_root.exists() and not args.case_root.is_symlink(),'Fresh short case root required')
    receipt=json.loads(args.producer_receipt.read_text());require(receipt['passed'] is True and receipt['all_owned_jobs_joined'] is True and receipt['execution_source_commit']==args.execution_source_commit and receipt['producer_source_commit']==request['producer_source_commit'],'Actual producer download cohort differs')
    plan={'schema':1,'execution_source_commit':args.execution_source_commit,'runtime_source_commit':request['producer_source_commit'],'scenario':request['scenario'],'mode':request['mode'],'steps':['hydrate-verified-source-cohort','explicit-prerequisites','actual-interop-ReleaseSafe','actual-interop-ReleaseFast','accept-actual-interop','prepare-reviewed-profile','owned-native-case'],'SDK_or_helper_rebuild':False,'native_case_acceptance':False,'scope':'Setup/interop precede and never credit actual600/30 case clock.'}
    if not args.execute:print(json.dumps(plan,indent=2));return
    require(sys.platform=='linux' and os.environ.get('GITHUB_ACTIONS')=='true' and args.repo==ROOT,'Actual composition uses this Linux CI checkout only')
    require(shutil.disk_usage(args.output.parent).free>=24*GIB,'24GiB initial composition headroom required;6GiB ongoing floor unchanged')
    args.output.mkdir(mode=0o700);(args.output/'logs').mkdir();(args.output/'home').mkdir()
    (args.output/'plan.json').write_text(json.dumps(plan,indent=2)+'\n')
    initial_free=shutil.disk_usage(args.output).free
    census=load('run_allocation_census','zig/bench/native_harness_census.py')
    owner=load('run_process_owner','zig/bench/cold_matrix_owner.py');owner.enable_subreaper();checks=[];failure=None;result={'schema':1,'kind':'linux-native-case-composition','passed':False,'native_case_acceptance':False,'plan':pin(args.output/'plan.json'),'checks':checks}
    env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':str(args.output/'home'),'LC_ALL':'C.UTF-8','GITHUB_ACTIONS':'true'}
    def run(name,argv,seconds,resource_root):
        started=time.monotonic();deadline=started+seconds;log=args.output/'logs'/(name+'.log');child=None;known={};groups={};cleanup=None;error=None
        try:
            with log.open('xb') as stream:
                child=subprocess.Popen(argv,cwd=args.repo,env=env,stdin=subprocess.DEVNULL,stdout=stream,stderr=subprocess.STDOUT,start_new_session=True);groups[child.pid]=child.pid
                while os.waitid(os.P_PID,child.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT) is None:
                    rows=owner.processes();owned=owner.owned_processes(rows,child.pid,known,groups,True)
                    free=shutil.disk_usage(args.output).free
                    require(time.monotonic()<deadline and sum(row['rss_bytes'] for row in owned.values())<=8*GIB and free>=6*GIB and initial_free-free<=12*GIB,'Composition phase deadline/RSS/total-growth/free guard')
                    if resource_root.exists():require(census.functional_allocated(resource_root)<=(4 if resource_root==args.case_root else 8)*GIB,'Composition owned output allocation cap')
                    require(log.stat().st_size<=64*1024**2,'Composition phase log guard');time.sleep(.2)
        except BaseException as caught:error=caught
        finally:
            old={sig:signal.signal(sig,signal.SIG_IGN) for sig in [signal.SIGTERM,signal.SIGINT,signal.SIGHUP]}
            try:
                if child is not None:
                    try:cleanup=owner.stop_owned(child,known,groups,grace_seconds=240 if request['scenario']=='radix' and name=='owned-native-case' else 150 if request['scenario']=='starknet' and name=='owned-native-case' else 100,kill_seconds=3)
                    except BaseException as cleanup_error:
                        cleanup={'clean':False,'actual_parent_wait':False,'error':{'type':type(cleanup_error).__name__,'message':str(cleanup_error)}}
                        if error is None:error=cleanup_error
            finally:
                for sig,value in old.items():signal.signal(sig,value)
            checks.append({'name':name,'argv':argv,'pid':None if child is None else child.pid,'exit_code':None if child is None else child.returncode,'actual_parent_wait':bool(cleanup and cleanup['actual_parent_wait']),'cleanup':cleanup,'log':pin(log),'error':None if error is None else {'type':type(error).__name__,'message':str(error)}})
        if error is not None:raise error
        require(child.returncode==0 and cleanup['clean'] and not cleanup['signals'],'Actual composition command/wait/cleanup failed')
        require(log.stat().st_size<=64*1024**2,'Postflight composition log guard')
        if resource_root.exists():require(census.functional_allocated(resource_root)<=(4 if resource_root==args.case_root else 8)*GIB,'Postflight composition allocation cap')
        require(time.monotonic()<deadline and shutil.disk_usage(args.output).free>=6*GIB and initial_free-shutil.disk_usage(args.output).free<=12*GIB,'Phase postflight original deadline/growth/free guard')
    try:
        builder=args.repo/'zig/integration/native_case_inputs.py'
        run('hydrate-verified-source-cohort',[sys.executable,'-I','-B',str(builder),'hydrate','--reviewed-policy',str(args.request),'--reviewed-policy-sha256',args.request_sha256,'--producer-receipt',str(args.producer_receipt),'--producer-receipt-sha256',args.producer_receipt_sha256,'--expected-source-commit',args.execution_source_commit,'--output',str(args.case_root)],180,args.case_root)
        context_path=args.case_root/'hydrated-inputs.json';context=json.loads(context_path.read_text());context_pin=pin(context_path)
        require(context['phase']=='HYDRATED_NOT_EXECUTION_APPROVAL' and context['nodes_started'] is False and context['native_case_acceptance'] is False,'Only nonexecuting hydration may precede setup')
        run('explicit-prerequisites',[sys.executable,'-I','-B',str(args.repo/'zig/bench/native_case_setup.py'),'--execute','--request',str(args.request),'--request-sha256',args.request_sha256,'--execution-source-commit',args.execution_source_commit,'--repo',str(args.repo),'--output',str(args.output/'setup'),'--tools',str(args.tools),'--tools-sha256',args.tools_sha256,*(['--hydrated-inputs',str(context_path),'--hydrated-inputs-sha256',context_pin['sha256']] if request['scenario']in{'sealevel','sealevel-composite'} else [])],2760,args.output/'setup')
        raw={}
        for mode,key in [('ReleaseSafe','safe'),('ReleaseFast','fast')]:
            output=args.output/('actual-interop-'+mode+'.json');run('actual-interop-'+mode,interop_command(args.repo,context,mode,output),300,args.output);raw[key]=pin(output)
        run('accept-actual-interop',[sys.executable,'-I','-B',str(builder),'accept-interop','--hydrated-inputs',str(context_path),'--hydrated-inputs-sha256',context_pin['sha256'],'--safe-result',raw['safe']['path'],'--safe-result-sha256',raw['safe']['sha256'],'--fast-result',raw['fast']['path'],'--fast-result-sha256',raw['fast']['sha256']],120,args.output)
        interop=pin(args.case_root/'accepted-native-rows-interop.json');stage=pin(args.output/'setup/local-stage.json')
        run('prepare-reviewed-profile',[sys.executable,'-I','-B',str(builder),'prepare','--hydrated-inputs',str(context_path),'--hydrated-inputs-sha256',context_pin['sha256'],'--interoperability',interop['path'],'--interoperability-sha256',interop['sha256'],'--local-stage',stage['path'],'--local-stage-sha256',stage['sha256']],180,args.output)
        launch=pin(args.case_root/'launch-plan.json')
        run('owned-native-case',[sys.executable,'-I','-B',str(args.repo/'zig/bench/native_case_owner.py'),'--plan',launch['path'],'--plan-sha256',launch['sha256'],'--output',str(args.case_root/'ci-supervision')],4050 if request['scenario']=='radix'else 3780 if request['scenario']=='starknet' else 3720,args.case_root)
        final=pin(args.case_root/'ci-supervision/result.json');accepted=json.loads(Path(final['path']).read_text())
        require(accepted['kind']=='owned-linux-native-case-result' and accepted['passed'] is True and accepted['native_case_acceptance'] is True and accepted['runtime_source_commit']==request['producer_source_commit'] and accepted['execution_source_commit']==args.execution_source_commit and accepted['scenario']==request['scenario'] and accepted['mode']==request['mode'] and accepted['accepted_inputs_unchanged_after'] is True,'Actual full owned case result missing/mismatched')
        result.update(passed=True,native_case_acceptance=True,actual_case_result=final,actual_interoperability=interop,actual_stage=stage)
    except BaseException as caught:failure=caught;result['error']={'type':type(caught).__name__,'message':str(caught)}
    finally:
        with (args.output/'result.json').open('x') as stream:json.dump(result,stream,indent=2);stream.write('\n')
    if failure is not None:raise failure


if __name__=='__main__':
    def interrupted(sig,frame):raise RuntimeError('Case composition interrupted '+str(sig))
    for sig in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP):signal.signal(sig,interrupted)
    main()
