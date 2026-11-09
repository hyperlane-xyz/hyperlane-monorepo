"""Bounded Linux proof/timing custody outside existing daemon timers."""
from pathlib import Path
import argparse,hashlib,importlib.util,json,os,shutil,signal,subprocess,sys,time
sys.path.insert(0,str(Path(__file__).resolve().parent))
import paired_linux as policy
GIB=1024**3
PROFILES={'functional':{'wall_seconds':7200,'RSS_bytes':4*GIB,'new_disk_bytes':512*1024**2,'free_bytes':6*GIB},'runtime':{'wall_seconds':18000,'RSS_bytes':8*GIB,'new_disk_bytes':4*GIB,'free_bytes':6*GIB}}
class TaskInterrupted(RuntimeError):pass


def completed_worker(args,authority,request_pin):
 value=policy.decode((args.output/'functional-result.json').read_bytes());mode=policy.MODES[args.index//3];kind=policy.KINDS[args.index%3]
 policy.need(value.get('schema')==1 and value.get('kind')=='paired-linux-functional-result'and value.get('platform')=='linux-x86_64'and value.get('passed')is True and type(value.get('index'))is int and value['index']==args.index and value.get('mode')==mode and value.get('proof_kind')==kind,'actual successful functional worker receipt')
 policy.need(value.get('request')==request_pin and value.get('production_confirm_seconds')==600 and value.get('bounded_grace_seconds')==30 and value.get('native18_or_timing_acceptance')is False,'functional receipt scope')
 policy.need(value.get('input_manifest')==policy.pin(args.inputs/'input-manifest.json'),'same exact once-input manifest')
 proof=policy.checked(value['proof']);policy.need(Path(proof['path'])==args.output/'proof.json','fixed actual proof output')
 inputs=policy.decode((args.inputs/'input-manifest.json').read_bytes());expected=inputs['artifacts']['zig'][mode]['relayer']['sha256'];roles={inputs['artifacts']['zig'][mode][r]['sha256']for r in ['relayer','validator']};events=value.get('actual_role_launches');policy.need(isinstance(events,list)and events and all(type(e.get('pid'))is int and e['pid']>0 and e.get('mode')==mode and e.get('binary_sha256')in roles for e in events)and any(e['binary_sha256']==expected for e in events),'actual exact role launch records')
 validator=policy.load_source(args.repo/'zig/bench/paired_linux_proofs.py','paired_parent_proof_validator',authority,args.repo);summary=validator.validate(kind,policy.decode(Path(proof['path']).read_bytes(),64*1024**2,2000000),expected,args.repo)
 policy.need(summary==value['strict_cases'],'actual worker and parent proof validation agree')
 for row in authority['required_source']:policy.checked(row,args.repo)
 for row in inputs.get('repository_source_files',[]):policy.checked(row,args.repo)
 return policy.pin(args.output/'functional-result.json')

def owner(args):
 authority,request_pin=policy.request(args.request,args.request_sha256,args.repo);phase=args.phase;policy.need(authority['root_approved']and authority['functional_enabled'if phase=='functional'else'runtime_enabled'],'explicit owner phase authority')
 policy.need(sys.platform=='linux'and hasattr(os,'pidfd_open')and hasattr(signal,'pidfd_send_signal'),'Linux pidfd ownership required');policy.need(args.output.is_absolute()and args.output.parent.resolve()==args.output.parent and not args.output.exists()and not args.output.is_relative_to(args.repo),'fresh external owner root')
 args.output.mkdir(mode=0o700);(args.output/'tmp').mkdir(mode=0o700)
 custody=policy.load_source(args.repo/'zig/bench/cold_matrix_owner.py','paired_checked_custody',authority,args.repo);custody.enable_subreaper();limits=PROFILES[phase];started=time.monotonic();deadline=started+limits['wall_seconds'];paths=[args.output,args.repo/'zig/integration/.cache',args.repo/'zig/bench/.cache'];baseline=sum(custody.allocated(p)for p in paths if p.exists());policy.need(shutil.disk_usage(args.output).free>=limits['free_bytes'],'host free6GiB floor')
 cmd=[sys.executable,'-I','-B',str(args.repo/'zig/bench/paired_linux.py'),phase+'-worker','--request',str(args.request),'--request-sha256',args.request_sha256,'--repo',str(args.repo),'--inputs',str(args.inputs),'--index',str(args.index),'--output',str(args.output)]
 env={k:os.environ[k]for k in ['PATH','LANG','LC_ALL','HOME']if k in os.environ};env.update(TMPDIR=str(args.output/'tmp'),PYTHONDONTWRITEBYTECODE='1',PYTHONNOUSERSITE='1',LC_ALL='C.UTF-8')
 child=None;known={};groups={};error=None;cleanup=None;worker_receipt=None;peak=0;maximum_growth=0;minimum_free=shutil.disk_usage(args.output).free;watched=[signal.SIGINT,signal.SIGTERM,signal.SIGHUP];previous={s:signal.getsignal(s)for s in watched}
 def interrupted(*ignored):raise TaskInterrupted('owned paired task interrupted')
 for s in watched:signal.signal(s,interrupted)
 try:
  with(args.output/'worker.log').open('xb')as log,(args.output/'resources.jsonl').open('x',buffering=1)as samples:
   mask=signal.pthread_sigmask(signal.SIG_BLOCK,watched)
   try:
    def unmask():signal.pthread_sigmask(signal.SIG_SETMASK,mask)
    child=subprocess.Popen(cmd,cwd=args.repo,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True,preexec_fn=unmask);groups[child.pid]=child.pid
   finally:signal.pthread_sigmask(signal.SIG_SETMASK,mask)
   while True:
    current=custody.processes();live=custody.owned_processes(current,child.pid,known,groups,True);rss=sum(r['rss_bytes']for r in live.values())+current.get(os.getpid(),{}).get('rss_bytes',0);growth=max(0,sum(custody.allocated(p)for p in paths if p.exists())-baseline);free=shutil.disk_usage(args.output).free;peak=max(peak,rss);maximum_growth=max(maximum_growth,growth);minimum_free=min(minimum_free,free);now=time.monotonic();policy.need(now<deadline and rss<=limits['RSS_bytes']and growth<=limits['new_disk_bytes']and free>=limits['free_bytes'],'original owner wall/RSS/disk/free bound')
    if phase=='runtime':policy.need(not[r for pid,r in current.items()if pid not in live and pid!=os.getpid()and r['state']!='Z'and r['comm']in custody.COMPILERS],'foreign compiler/native process; timing refused')
    samples.write(json.dumps({'elapsed_seconds':now-started,'sampled_owned_tree_RSS_bytes':rss,'new_allocated_bytes':growth,'free_bytes':free})+'\n')
    if os.waitid(os.P_PID,child.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT)is not None:
     policy.need(time.monotonic()<deadline,'late positive original owner deadline');break
    time.sleep(.25)
 except BaseException as e:error=type(e).__name__
 finally:
  for s in watched:signal.signal(s,signal.SIG_IGN)
  try:
   if child is not None:cleanup=custody.stop_owned(child,known,groups,grace_seconds=30,kill_seconds=10)
  except BaseException as e:error=error or'Cleanup'+type(e).__name__
  try:
   if error is None and cleanup is not None and cleanup.get('actual_parent_wait')is True and cleanup.get('exit_code')==0 and cleanup.get('clean')is True:worker_receipt=completed_worker(args,authority,request_pin)
  except BaseException as e:error=error or'WorkerReceipt'+type(e).__name__
  result={'schema':1,'kind':'paired-linux-owned-'+phase,'platform':'linux-x86_64','passed':error is None and worker_receipt is not None and time.monotonic()<deadline and cleanup is not None and cleanup['actual_parent_wait']is True and cleanup['exit_code']==0 and cleanup['clean']is True and not cleanup['signals']and not cleanup['errors'],'index':args.index,'request':request_pin,'original_wall_seconds':limits['wall_seconds'],'limits':limits,'started_monotonic':started,'original_deadline_monotonic':deadline,'ended_monotonic':time.monotonic(),'sampled_tree_RSS_peak_bytes':peak,'new_allocated_peak_bytes':maximum_growth,'minimum_host_free_bytes':minimum_free,'cleanup':cleanup,'worker_receipt':worker_receipt,'error_type':error,'measured_agent_wait4_scope':'Unchanged benchmark daemon records; outer tree samples are separate','native18_or_performance_acceptance':False}
  try:policy.write(args.output/'owner-result.json',result)
  finally:
   for s,h in previous.items():signal.signal(s,h)
 policy.need(result['passed'],'paired owner failed; raw evidence retained')

def worker(args,authority,request_pin):
 value=policy.input_manifest(args.inputs/'input-manifest.json',args.inputs,args.repo,authority['producer_source_commit'],authority);mode=policy.MODES[args.index//3]if args.action=='functional-worker'else None
 if args.action=='runtime-worker':raise policy.Refused('phase1 timing execution not implemented; no benchmark import')
 policy.need(0<=args.index<6,'six exact functional indices');mode=policy.MODES[args.index//3];kind=policy.KINDS[args.index%3]
 for root in [args.repo/'zig/bench',args.repo/'zig/integration']:policy.need(not(root/'__pycache__').exists(),'no stale local Python cache')
 sys.path.insert(0,str(args.repo/'zig/integration'));sys.path.insert(0,str(args.repo/'zig/bench'))
 rp=policy.load_source(args.repo/'zig/integration/relayer_process.py','relayer_process',authority,args.repo);original=rp.launch;environment=policy.env_for(value,args.inputs,mode);expected={value['artifacts']['zig'][mode][r]['sha256']for r in ['relayer','validator']};events=[]
 def bound(binary,config,log,extra_environment=None):
  digest=hashlib.sha256(Path(binary).read_bytes()).hexdigest();policy.need(digest in expected,'exact actual Linux role launch');effective=dict(environment)
  for k,v in (extra_environment or{}).items():
   if k in effective and effective[k]!=v:policy.need(k=='HYPERLANE_URL_LIBRARY'and policy.pin(v)['sha256']==value['artifacts']['zig'][mode]['url']['sha256'],'conflicting SDK environment')
   effective[k]=v
  child=original(binary,config,log,effective);events.append({'pid':child.pid,'mode':mode,'binary_sha256':digest});return child
 rp.launch=bound;module=rp if kind=='relayer_process'else policy.load_source(args.repo/'zig/integration'/(kind+'.py'),'paired_'+kind,authority,args.repo);proof=args.output/'proof.json';command=policy.functional_command(value,args.inputs,args.repo,args.index,proof);sys.argv=[command[3],*command[4:]]
 try:module.main()
 finally:policy.write(args.output/'actual-agent-launches.json',events)
 from paired_linux_proofs import validate
 raw=policy.decode(proof.read_bytes(),64*1024**2,2000000);summary=validate(kind,raw,value['artifacts']['zig'][mode]['relayer']['sha256'],args.repo)
 # Original per-ID600+30, crash/signing/public schemas remain checked. CI
 # correctness is not Root native18 or final quiet/performance authority.
 for row in authority['required_source']:policy.checked(row,args.repo)
 policy.write(args.output/'functional-result.json',{'schema':1,'kind':'paired-linux-functional-result','platform':'linux-x86_64','passed':True,'index':args.index,'mode':mode,'proof_kind':kind,'proof':policy.pin(proof),'input_manifest':policy.pin(args.inputs/'input-manifest.json'),'request':request_pin,'actual_role_launches':events,'strict_cases':summary,'production_confirm_seconds':600,'bounded_grace_seconds':30,'native18_or_timing_acceptance':False})

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--phase',choices=['functional','runtime'],required=True);p.add_argument('--request',type=Path,required=True);p.add_argument('--request-sha256',required=True);p.add_argument('--repo',type=Path,required=True);p.add_argument('--inputs',type=Path,required=True);p.add_argument('--index',type=int,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();owner(a)
