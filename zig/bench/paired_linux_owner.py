"""Bounded Linux proof/timing custody outside existing daemon timers."""
from pathlib import Path
import argparse,hashlib,importlib.util,json,os,shutil,signal,subprocess,sys,time
sys.path.insert(0,str(Path(__file__).resolve().parent))
import paired_linux as policy
GIB=1024**3
PROFILES={'functional':{'wall_seconds':7200,'RSS_bytes':4*GIB,'new_disk_bytes':512*1024**2,'free_bytes':6*GIB},'handoff':{'wall_seconds':7200,'RSS_bytes':4*GIB,'new_disk_bytes':512*1024**2,'free_bytes':6*GIB},'runtime':{'wall_seconds':18000,'RSS_bytes':8*GIB,'new_disk_bytes':4*GIB,'free_bytes':6*GIB}}
class TaskInterrupted(RuntimeError):pass


def completed_worker(args,authority,request_pin):
 if args.phase=='handoff':return completed_handoff(args,authority,request_pin)
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
 authority,request_pin=policy.request(args.request,args.request_sha256,args.repo);phase=args.phase;policy.need(authority['root_approved']and authority[{'functional':'functional_enabled','runtime':'runtime_enabled','handoff':'handoff_enabled'}[phase]],'explicit owner phase authority')
 policy.need(sys.platform=='linux'and hasattr(os,'pidfd_open')and hasattr(signal,'pidfd_send_signal'),'Linux pidfd ownership required');policy.need(args.output.is_absolute()and args.output.parent.resolve()==args.output.parent and not args.output.exists()and not args.output.is_relative_to(args.repo),'fresh external owner root')
 args.output.mkdir(mode=0o700);(args.output/'tmp').mkdir(mode=0o700)
 custody=policy.load_source(args.repo/'zig/bench/cold_matrix_owner.py','paired_checked_custody',authority,args.repo);custody.enable_subreaper();limits=PROFILES[phase];started=time.monotonic();deadline=started+limits['wall_seconds'];paths=[args.output,args.repo/'zig/integration/.cache',args.repo/'zig/bench/.cache'];baseline=sum(custody.allocated(p)for p in paths if p.exists());policy.need(shutil.disk_usage(args.output).free>=limits['free_bytes'],'host free6GiB floor')
 cmd=[sys.executable,'-I','-B',str(args.repo/'zig/bench/paired_linux.py'),phase+'-worker','--request',str(args.request),'--request-sha256',args.request_sha256,'--repo',str(args.repo),'--inputs',str(args.inputs),'--index',str(args.index),'--output',str(args.output)]
 if phase=='handoff':cmd+=['--execution-deadline',str(deadline)]
 env={k:os.environ[k]for k in ['PATH','LANG','LC_ALL','HOME']if k in os.environ};env.update(TMPDIR=str(args.output/'tmp'),PYTHONDONTWRITEBYTECODE='1',PYTHONNOUSERSITE='1',LC_ALL='C.UTF-8')
 pg_module=handoff_pg_module(args,authority)if phase=='handoff'and args.index%3==2 else None;pg_cleanup=None
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
    current=custody.processes();live=custody.owned_processes(current,child.pid,known,groups,True);rss=sum(r['rss_bytes']for r in live.values())+current.get(os.getpid(),{}).get('rss_bytes',0)+(GIB if pg_module is not None else 0);growth=max(0,sum(custody.allocated(p)for p in paths if p.exists())-baseline);free=shutil.disk_usage(args.output).free;peak=max(peak,rss);maximum_growth=max(maximum_growth,growth);minimum_free=min(minimum_free,free);now=time.monotonic();policy.need(now<(deadline-100 if phase=='handoff'else deadline)and rss<=limits['RSS_bytes']and growth<=limits['new_disk_bytes']and free>=limits['free_bytes'],'original owner wall/RSS/disk/free bound')
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
   if pg_module is not None and(args.output/'postgres/paired-postgres-owner.json').exists():
    receipts=args.output/'postgres';token=policy.sha((str(args.output)+request_pin['sha256']).encode())[:32]
    inputs=policy.decode((args.inputs/'input-manifest.json').read_bytes())
    pg_cleanup=pg_module.cleanup_all(policy=pg_module.POLICY,docker=inputs['external']['tools']['docker'],docker_config=receipts/'docker-config',token=token,receipts=receipts,deadline=deadline)
  except BaseException as e:error=error or'PostgresCleanup'+type(e).__name__
  try:
   if error is None and cleanup is not None and cleanup.get('actual_parent_wait')is True and cleanup.get('exit_code')==0 and cleanup.get('clean')is True:worker_receipt=completed_worker(args,authority,request_pin)
  except BaseException as e:error=error or'WorkerReceipt'+type(e).__name__
  result={'schema':1,'kind':'paired-linux-owned-'+phase,'platform':'linux-x86_64','passed':error is None and worker_receipt is not None and time.monotonic()<deadline and cleanup is not None and cleanup['actual_parent_wait']is True and cleanup['exit_code']==0 and cleanup['clean']is True and not cleanup['signals']and not cleanup['errors'],'index':args.index,'request':request_pin,'original_wall_seconds':limits['wall_seconds'],'limits':limits,'started_monotonic':started,'original_deadline_monotonic':deadline,'ended_monotonic':time.monotonic(),'sampled_tree_RSS_peak_bytes':peak,'new_allocated_peak_bytes':maximum_growth,'minimum_host_free_bytes':minimum_free,'cleanup':cleanup,'postgres_cleanup':pg_cleanup,'RSS_includes_PG_reserved_1GiB':pg_module is not None,'worker_receipt':worker_receipt,'error_type':error,'measured_agent_wait4_scope':'Unchanged benchmark daemon records; outer tree samples are separate','native18_or_performance_acceptance':False}
  try:policy.write(args.output/'owner-result.json',result)
  finally:
   for s,h in previous.items():signal.signal(s,h)
 policy.need(result['passed'],'paired owner failed; raw evidence retained')

def worker(args,authority,request_pin):
 if args.action=='handoff-worker':return handoff_worker(args,authority,request_pin)
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



def handoff_sources(authority):
 rows=[*authority['required_source'],authority['handoff_postgres_source'],authority['handoff_reuse_source'],authority['handoff_port8_source']]
 policy.need(len(rows)==40 and len({r['path']for r in rows})==40,'Explicit handoff Source union40 required')
 return sorted(rows,key=lambda r:r['path'])

def handoff_pg_module(args,authority):
 row=authority['handoff_postgres_source'];policy.need(row['path']=='zig/bench/paired_linux_postgres.py','Only explicit existing PG owner may extend handoff Source')
 policy.checked(row,args.repo)
 extended={**authority,'required_source':[*authority['required_source'],row]}
 return policy.load_source(args.repo/row['path'],'handoff_checked_postgres',extended,args.repo)

def handoff_products(value,mode,role):
 result={implementation:{**value['artifacts'][implementation][mode][role]}if implementation=='zig'else{**value['artifacts']['rust'][role]}for implementation in ['rust','zig']}
 if role=='relayer':result['rust_validator_companion']={**value['artifacts']['rust']['validator']}
 if role=='validator':
  result['rust']['metadata_git_sha']=value['execution_source_commit'];result['zig']['metadata_git_sha']=value['producer_source_commit']
 return result

def completed_handoff(args,authority,request_pin):
 value=policy.decode((args.output/'handoff-result.json').read_bytes());mode=policy.MODES[args.index//3];role=('relayer','validator','scraper')[args.index%3]
 policy.need(value.get('kind')=='paired-linux-handoff-result'and value.get('passed')is True and value.get('request')==request_pin and value.get('index')==args.index and value.get('mode')==mode and value.get('role')==role and value.get('performance_credit')is False,'actual successful separate handoff worker required')
 inputs=policy.input_manifest(args.inputs/'input-manifest.json',args.inputs,args.repo,authority['producer_source_commit'],authority);proof=policy.checked(value['proof']);policy.need(Path(proof['path'])==args.output/'handoff-proof.json','fixed separate handoff proof path')
 validator=policy.load_source(args.repo/'zig/bench/paired_linux_proofs.py','handoff_parent_closed_proofs',authority,args.repo)
 raw=policy.decode(Path(proof['path']).read_bytes())
 if role=='scraper':
  journal=policy.decode((args.output/'postgres/paired-postgres-owner.json').read_bytes());snapshot=raw['postgres_cleanup'];policy.need(type(snapshot)is dict and all(v.get('passed')is True and v.get('container_absent')is True and not v.get('cleanup_failures')for v in [journal,snapshot])and snapshot.get('container_id')==journal.get('container_id')and snapshot.get('context')==journal.get('context'),'actual independent parent/worker PG identity cleanup differs')
 summary=validator.validate_handoff(raw,role,mode,handoff_products(inputs,mode,role),policy.pin(args.inputs/'input-manifest.json'),authority['producer_source_commit'],handoff_sources(authority),inputs['required_cpu_flags'])
 policy.need(summary==value.get('strict_handoff'),'actual parent and worker handoff review differ')
 for row in handoff_sources(authority):policy.checked(row,args.repo)
 return policy.pin(args.output/'handoff-result.json')

def handoff_worker(args,authority,request_pin):
 policy.need(authority['handoff_enabled']is True and not any(authority[k]for k in ['inputs_enabled','functional_enabled','runtime_enabled']),'exclusive explicit handoff phase required')
 policy.need(type(args.index)is int and 0<=args.index<6,'six fixed role/mode handoff indices')
 policy.need(type(args.execution_deadline)in(int,float)and time.monotonic()<args.execution_deadline-60,'actual outer handoff deadline required')
 value=policy.input_manifest(args.inputs/'input-manifest.json',args.inputs,args.repo,authority['producer_source_commit'],authority);mode=policy.MODES[args.index//3];role=('relayer','validator','scraper')[args.index%3]
 for row in handoff_sources(authority):policy.checked(row,args.repo)
 cpu=policy.load_source(args.repo/'zig/tools/build_cpu.py','handoff_existing_cpu_contract',authority,args.repo)
 with Path('/proc/cpuinfo').open()as stream:cpu_text=stream.read(1024**2+1)
 policy.need(len(cpu_text)<=1024**2,'bounded actual handoff CPU observation');available=cpu.cpu_flags(cpu_text,intersection=True);required=value['required_cpu_flags'];policy.need(type(required)is list and required and set(required)<=set(available),'handoff consumer CPU lacks compiled instruction flags')
 for relative in ['zig/bench','zig/integration']:policy.need(not(args.repo/relative/'__pycache__').exists(),'no executable Source bytecode')
 sys.path.insert(0,str(args.repo/'zig/integration'));sys.path.insert(0,str(args.repo/'zig/bench'))
 evm=policy.load_source(args.repo/'zig/integration/evm.py','evm',authority,args.repo)
 rp=policy.load_source(args.repo/'zig/integration/relayer_process.py','relayer_process',authority,args.repo)
 validator=policy.load_source(args.repo/'zig/bench/validator.py','validator',authority,args.repo)
 module=validator if role=='validator'else policy.load_source(args.repo/('zig/bench/'+role+'.py'),role,authority,args.repo)
 source=policy.load_source(args.repo/'zig/bench/paired_linux_inputs.py','handoff_input_preset_source',authority,args.repo)
 import ast,types
 namespace={'evm':evm,'ROOT':args.repo,'__builtins__':__builtins__}
 if role!='relayer':exec(compile(ast.Module(body=source.fixture_preset_nodes(args.repo,role),type_ignores=[]),str(args.repo/('zig/bench/'+role+'.py')),'exec'),namespace)
 original_compile=evm.compile_contracts
 if role=='validator':evm.CACHE=args.repo/'zig/integration/.cache/whole-validator'
 elif role=='scraper':
  cache=next((r for r in value['files']if r['path']=='fixture-provenance/scraper.contracts.json'),None);policy.need(cache is not None,'actual once scraper compiler fixture required');policy.checked(cache,args.inputs)
  evm.CACHE=args.output/'scraper-contracts';evm.CACHE.mkdir();shutil.copyfile(args.inputs/cache['path'],evm.CACHE/'contracts.json')
 def checked_compile():
  body=evm.compiler_inputs();cache=evm.CACHE/'contracts.json';policy.need(cache.is_file(),'handoff compilation fallback refused')
  old=policy.decode(cache.read_bytes());policy.need(old['input_digest']==hashlib.sha256(json.dumps(body,sort_keys=True).encode()).hexdigest(),'handoff compiled fixture Source changed')
  return original_compile()
 evm.compile_contracts=checked_compile
 sdk=policy.env_for(value,args.inputs,mode);sdk['HYPERLANE_CURL_LIBRARY']=str(policy.checked(value['external']['runtime_libraries']['libcurl.so.4'])['path'])
 products=handoff_products(value,mode,role);binaries={k:args.inputs/v['path']for k,v in products.items()};binaries['rust_validator']=args.inputs/value['artifacts']['rust']['validator']['path']
 allowed={value['artifacts']['rust'][r]['sha256']:('rust',r)for r in ['relayer','validator','scraper']};allowed.update({value['artifacts']['zig'][mode][r]['sha256']:('zig',r)for r in ['relayer','validator','scraper']});instances=[]
 def factory(original):
  def create(*values,**kwargs):
   binary=Path(values[0]);pin=policy.pin(binary);policy.need(pin['sha256']in allowed,'unadmitted actual handoff daemon')
   implementation,actual_role=allowed[pin['sha256']];environment=dict(values[2]);changed=list(values)
   if implementation=='zig':
    for key,path in sdk.items():
     if key in environment and environment[key]!=path:policy.need(policy.pin(environment[key])['sha256']==policy.pin(path)['sha256'],'handoff SDK environment conflict')
     environment[key]=path
   changed[2]=environment;instance=original(*changed,**kwargs);instances.append((instance,implementation,actual_role,pin));return instance
  return create
 validator.MeasuredProcess=factory(validator.MeasuredProcess)
 if module is not validator:module.MeasuredProcess=factory(module.MeasuredProcess)
 context={'output':args.output/'raw','binaries':binaries,'oracle':args.inputs/value['artifacts']['tools']['ziggy-rocks-oracle']['path'],'reference':args.inputs/value['artifacts']['tools']['ziggy-rust-reference']['path'],'evm_oracle':args.inputs/value['artifacts']['evm_oracle']['path'],'sdk_environment':sdk,'metadata_git_shas':{'rust':value['execution_source_commit'],'zig':value['producer_source_commit']}}
 context['output'].mkdir()
 if role=='scraper':
  pg=handoff_pg_module(args,authority);receipts=args.output/'postgres';receipts.mkdir();token=policy.sha((str(args.output)+request_pin['sha256']).encode())[:32]
  owned=pg.bind_postgres(module,pg.POLICY,docker=value['external']['tools']['docker'],docker_config=receipts/'docker-config',token=token,receipts=receipts,deadline=args.execution_deadline-60,cleanup_deadline=args.execution_deadline)
  context['postgres']=owned('postgres:16.15',args.inputs/value['artifacts']['tools']['init-db']['path'],context['output']);context['contracts']=evm.compile_contracts()
 result=module.run_drained_handoff(context)
 if role=='scraper':
  journal=policy.decode((args.output/'postgres/paired-postgres-owner.json').read_bytes());policy.need(journal.get('passed')is True and journal.get('container_absent')is True and not journal.get('cleanup_failures'),'actual PG ownership cleanup missing');result['postgres_cleanup']=journal
 actual=[]
 for instance,implementation,actual_role,pin in instances:
  policy.need(instance.usage is not None and instance.status==instance.p.returncode and instance.end_ns is not None,'actual handoff daemon direct wait4 missing')
  policy.need(type(instance.status)is int and instance.status in([0]if implementation=='zig'else[0,-signal.SIGTERM]),'every actual handoff daemon including companion must exit cleanly without force')
  actual.append({'pid':instance.p.pid,'direct_parent_pid':os.getpid(),'implementation':implementation,'role':actual_role,'binary':pin,'actual_parent_wait':True,'exit_code':instance.status})
 primary=[r for r in actual if r['role']==role];policy.need(len(primary)==3 and [r['implementation']for r in primary]==['rust','zig','rust'],'actual daemon role order differs')
 policy.need([r['pid']for r in primary]==[r['pid']for r in result['epochs']],'proof epochs differ from actual daemon constructors')
 executed=subprocess.run(['git','rev-parse','HEAD'],cwd=args.repo,check=True,capture_output=True,text=True,timeout=10).stdout.strip()
 result.update(mode=mode,producer_source_commit=authority['producer_source_commit'],baseline_source_commit=policy.BASELINE,execution_source_commit=executed,input_manifest=policy.pin(args.inputs/'input-manifest.json'),source_pins=handoff_sources(authority),actual_role_launches=actual,actual_consumer_CPU={'required_flags':required,'available_intersection_flags':available,'cpuinfo_sha256':policy.sha(cpu_text.encode()),'cpuinfo_bytes':len(cpu_text.encode())})
 checked=policy.load_source(args.repo/'zig/bench/paired_linux_proofs.py','handoff_worker_closed_proofs',authority,args.repo)
 summary=checked.validate_handoff(result,role,mode,products,result['input_manifest'],authority['producer_source_commit'],handoff_sources(authority),value['required_cpu_flags'])
 for row in handoff_sources(authority):policy.checked(row,args.repo)
 policy.write(args.output/'handoff-proof.json',result)
 policy.write(args.output/'handoff-result.json',{'schema':1,'kind':'paired-linux-handoff-result','passed':True,'index':args.index,'mode':mode,'role':role,'request':request_pin,'proof':policy.pin(args.output/'handoff-proof.json'),'strict_handoff':summary,'performance_credit':False})

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--phase',choices=['functional','runtime','handoff'],required=True);p.add_argument('--request',type=Path,required=True);p.add_argument('--request-sha256',required=True);p.add_argument('--repo',type=Path,required=True);p.add_argument('--inputs',type=Path,required=True);p.add_argument('--index',type=int,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();owner(a)
