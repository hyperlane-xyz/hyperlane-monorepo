"""Opt-in fixed CI composition. False policy is inert; no raw case fallback.

The cosmosnative request authorizes producer hydration only. Separate full-case
policy authorizes Aleo's original workload/clock after actual prerequisite checks.
"""
import argparse, ast, datetime, email.utils, hashlib, http.client, importlib.util, json, os, re, secrets, shutil, signal, subprocess, sys, time
from pathlib import Path
HERE=Path(__file__).resolve().parent
MODES=('ReleaseSafe','ReleaseFast')
FIXED={'schema':1,'kind':'aleo-linux-fullcase-ci-policy-v1','confirm_seconds':600,'restart_seconds':30,'proof_seconds':10800,'service_seconds':11160,'stop_seconds':240,'job_minutes':330,'minimum_remaining_minutes':195}
FIELDS=set(FIXED)|{'root_approved','runtime_source_commit','requests','qualified_cohort','qualified_docker','required_source'}
def need(value,message):
 if not value:raise ValueError(message)
def decode(raw):
 def pairs(rows):
  out={}
  for k,v in rows:need(k not in out,'duplicate JSON key');out[k]=v
  return out
 return json.loads(raw,object_pairs_hook=pairs)
def pin(path):
 p=Path(path);need(p.is_absolute()and p.is_file()and not p.is_symlink(),'regular canonical artifact required');p=p.resolve(strict=True)
 with p.open('rb')as f:digest=hashlib.file_digest(f,'sha256').hexdigest()
 return {'path':str(p),'bytes':p.stat().st_size,'sha256':digest}
def checked(row):
 need(type(row)is dict and set(row)=={'path','bytes','sha256'}and type(row['bytes'])is int and row['bytes']>=0,'closed artifact descriptor required')
 need(pin(row['path'])==row,'artifact changed');return Path(row['path'])
def load(row,limit=32*1024**2):
 p=checked(row);need(row['bytes']<=limit,'bounded JSON required');return decode(p.read_bytes())
def write(path,value):
 with Path(path).open('x')as out:json.dump(value,out,indent=2);out.write('\n');out.flush();os.fsync(out.fileno())
 return pin(path)
def module(repo,name,relative):
 spec=importlib.util.spec_from_file_location(name,repo/relative);out=importlib.util.module_from_spec(spec);spec.loader.exec_module(out);return out
def source_policy_paths(repo):
 # Read literal reviewed inventories without importing SDK, setup or case code.
 def constant(relative,name):
  tree=ast.parse((repo/relative).read_text())
  row=next(n for n in tree.body if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id==name for t in n.targets))
  return ast.literal_eval(row.value)
 case='zig/tools/aleo_linux_case/';sdk='zig/tools/aleo_linux_sdk/';kernel='zig/tools/aleo_linux/';docker='zig/tools/aleo_linux_docker/'
 paths={case+n for n in constant(case+'case_specs.py','CASE_CODE')}
 shared={'kernel_probe.py','kernel_delegate.py','loopback_bridge.py','receipts.py'}
 paths|={(kernel if n in shared else sdk)+n for n in constant(sdk+'sdk_specs.py','CODE')}
 paths|={docker+n for n in ('sibling_imports.py','docker_probe.py','docker_probe.mjs','docker_delegate.py','docker_probe_stage.py','docker_probe_bind.py','docker_probe_policy.PENDING.json')}
 paths|={case+n for n in ('ci_fullcase.py','ci-case.sh','case_assets.py')}
 paths|={sdk+'sdk_specs.py',sdk+'ci-prerequisites.sh','zig/integration/native_case_inputs.py','zig/bench/native_case_ci.py','zig/bench/native_payload_export.py','zig/tools/build_cpu.py','zig/bench/native_case_tools.py','zig/bench/native_harness_census.py','zig/integration/native_rows_interop.py','zig/bench/cold_matrix_owner.py','zig/integration/aleo_process.ts','zig/integration/aleo_process_test.ts','.github/workflows/zig-agents.yml'}
 return {str(repo/p)for p in paths}

def policy_pin(row,repo):
 # Source policy records are checkout-relative; execution receipts are canonical.
 need(type(row)is dict and set(row)=={'path','bytes','sha256'}and type(row['path'])is str,'closed relative policy pin required')
 relative=Path(row['path'])
 need(relative.as_posix()==row['path']and not relative.is_absolute()and relative.parts and all(part not in {'.','..'}for part in relative.parts)and '\\'not in row['path'],'checkout-relative policy path required')
 path=repo/relative;need(path.resolve(strict=True)==path and path.is_relative_to(repo),'policy path escaped checkout or aliases')
 digest=row['sha256']
 if type(digest)is dict:
  need(set(digest)=={'sha256_hex_chunks'}and type(digest['sha256_hex_chunks'])is list and len(digest['sha256_hex_chunks'])==2 and all(type(v)is str and re.fullmatch('[0-9a-f]{32}',v)for v in digest['sha256_hex_chunks']),'exact existing public digest halves required')
  digest=''.join(digest['sha256_hex_chunks'])
 need(type(digest)is str and re.fullmatch('[0-9a-f]{64}',digest),'exact policy SHA256 required')
 result={**row,'path':str(path),'sha256':digest};checked(result);return result

def policy(path,sha,mode,repo):
 row=pin(path);need(row['sha256']==sha,'policy SHA differs');value=load(row,65536)
 need(set(value)==FIELDS and all(type(value[k])is type(v)and value[k]==v for k,v in FIXED.items())and type(value['root_approved'])is bool,'fixed full-case policy required')
 need(mode in MODES and type(value['requests'])is dict and set(value['requests'])==set(MODES),'both mode request fields required')
 if not value['root_approved']:return value,None
 need(re.fullmatch('[0-9a-f]{40}',value['runtime_source_commit']or''),'qualified runtime Source required')
 for name in ('qualified_cohort','qualified_docker'):
  value[name]=policy_pin(value[name],repo)
  gate=load(value[name]);need(type(gate)is dict,'separate actual prerequisite qualification required')
  if name=='qualified_docker':need(gate.get('passed')is True,'actual complete Docker qualification required')
 need(type(value['required_source'])is list and value['required_source'],'closed applied composition Source required')
 value['required_source']=[policy_pin(r,repo)for r in value['required_source']]
 value['requests']={name:policy_pin(row,repo)for name,row in value['requests'].items()}
 paths=[r['path']for r in value['required_source']];need(len(paths)==len(set(paths)),'duplicate Source pin')
 for source in value['required_source']:
  p=checked(source);need(p.is_relative_to(repo),'Source pin outside checkout')
 need(set(paths)==source_policy_paths(repo),'exact applied case/SDK/kernel/Docker/transport Source closure required')
 # Source closure is rechecked before every phase and by the dedicated owners.
 for name in MODES:
  request=load(value['requests'][name],65536)
  need(request.get('root_approved')is True and request.get('scenario')=='cosmosnative'and request.get('mode')==name and request.get('producer_source_commit')==value['runtime_source_commit'],'honest metadata-only CN transport/mode/cohort required')
 return value,row

def observed_budget(job,headers,*,run_id,attempt,head,mode,wall_before_ns,wall_after_ns,mono_after_ns):
 """Conservative job age from actual API clock; no unsupported job-start env."""
 need(job.get('run_id')==run_id and job.get('run_attempt')==attempt and job.get('head_sha')==head,'actual job identity differs')
 need(job.get('name')=='aleo-full-case ('+mode+')'and job.get('status')=='in_progress'and job.get('conclusion')is None,'exact current matrix job required')
 need(type(job.get('started_at'))is str and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z',job['started_at']),'exact API UTC job start required')
 started=datetime.datetime.fromisoformat(job['started_at'].replace('Z','+00:00'));need(started.tzinfo is not None,'API UTC job start required')
 server=email.utils.parsedate_to_datetime(headers['date']);server_ns=int(server.timestamp()*10**9)
 need(int(started.timestamp()*10**9)<=server_ns+10**9,'job start is in the future')
 need(abs(server_ns-wall_after_ns)<=5*10**9 and 0<=wall_after_ns-wall_before_ns<=20*10**9,'bounded API clock observation required')
 # API timestamps have second resolution. Subtract one second from start and
 # add the full allowed clock skew; never give elapsed time back to the job.
 elapsed=max(0,wall_after_ns-int(started.timestamp()*10**9)+6*10**9)
 need(elapsed<330*60*10**9,'job budget already exhausted')
 return {'job_id':job['id'],'run_id':run_id,'run_attempt':attempt,'head_sha':head,'name':job['name'],'api_started_at':job['started_at'],'api_date':headers['date'],'observed_monotonic_ns':mono_after_ns,'conservative_remaining_ns':330*60*10**9-elapsed,'clock_uncertainty_ns':6*10**9,'no_proof_clock_minted':True}
def require_launch_budget(observation,now_ns):
 need(type(now_ns)is int and now_ns>=observation['observed_monotonic_ns'],'monotonic budget observation required')
 remaining=observation['conservative_remaining_ns']-(now_ns-observation['observed_monotonic_ns'])
 need(remaining>=195*60*10**9,'full original case plus cleanup no longer fits330min job');return remaining

def job_observation(mode,env):
 """Exactly one bounded authenticated GitHub metadata GET; token never retained."""
 repo=env['GITHUB_REPOSITORY'];need(re.fullmatch('[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+',repo),'exact repository required')
 run=int(env['GITHUB_RUN_ID']);attempt=int(env['GITHUB_RUN_ATTEMPT']);head=env['GITHUB_SHA']
 token=env.get('GH_TOKEN');need(type(token)is str and token,'actions-read job token required')
 def expired(*args):raise RuntimeError('whole20s GitHub job metadata deadline')
 previous=signal.signal(signal.SIGALRM,expired);signal.setitimer(signal.ITIMER_REAL,20);connection=None
 try:
  before=time.time_ns();connection=http.client.HTTPSConnection('api.github.com',timeout=20)
  connection.request('GET',f'/repos/{repo}/actions/runs/{run}/attempts/{attempt}/jobs?per_page=100',headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'ziggy-aleo-fullcase','Connection':'close'})
  response=connection.getresponse();need(response.status==200,'actual job metadata request failed; no redirect')
  data=response.read(2*1024**2+1);need(len(data)<=2*1024**2,'bounded job metadata response required');after=time.time_ns();mono=time.monotonic_ns();rows=decode(data)
  need(type(rows.get('total_count'))is int and rows['total_count']==len(rows['jobs'])and len(rows['jobs'])<=100,'closed first-page job membership required')
  selected=[j for j in rows['jobs']if j['name']=='aleo-full-case ('+mode+')'];need(len(selected)==1,'one actual matrix job required')
  result=observed_budget(selected[0],{'date':response.getheader('Date')},run_id=run,attempt=attempt,head=head,mode=mode,wall_before_ns=before,wall_after_ns=after,mono_after_ns=mono)
  result['response_sha256']=hashlib.sha256(data).hexdigest();return result
 finally:
  if connection is not None:connection.close()
  signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,previous)

def fixed_environment(env):
 names=('PATH','GITHUB_WORKSPACE','RUNNER_TEMP','GITHUB_SHA','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_REPOSITORY')
 need(all(type(env.get(k))is str and env[k]for k in names),'explicit CI inputs required')
 return {**{k:env[k]for k in names},'LC_ALL':'C.UTF-8','PYTHONNOUSERSITE':'1','PYTHONDONTWRITEBYTECODE':'1'}
class Commands:
 def __init__(self,root,env):self.root=root;self.env=env;self.rows=[]
 def finish_child(self,child,row):
  # Independent signal and wait stages: a bookkeeping/signal error cannot skip
  # the actual captured child's parent wait. Never signal after a successful wait.
  for signum,grace in ((signal.SIGINT,245),(signal.SIGTERM,15),(signal.SIGKILL,15)):
   if row['actual_parent_wait']:break
   live=True
   try:live=child.poll()is None
   except BaseException as error:row['cleanup_errors'].append('poll:'+type(error).__name__)
   if live:
    try:
     pid=child.pid;need(type(pid)is int and pid>0,'captured direct child PID required')
     row.setdefault('pid',pid);os.killpg(pid,signum);row['signals'].append(signal.Signals(signum).name)
    except ProcessLookupError:pass
    except BaseException as error:row['cleanup_errors'].append('signal:'+type(error).__name__)
   try:row['exit_code']=child.wait(timeout=grace if live else 1);row['actual_parent_wait']=True
   except subprocess.TimeoutExpired:continue
   except BaseException as error:row['cleanup_errors'].append('wait:'+type(error).__name__)
  if not row['actual_parent_wait']:
   try:row['exit_code']=child.wait(timeout=1);row['actual_parent_wait']=True
   except BaseException as error:row['cleanup_errors'].append('final-wait:'+type(error).__name__)
 def run(self,name,argv,seconds,extra=None):
  need(re.fullmatch('[a-z0-9-]+',name)and type(seconds)is int and seconds>0,'fixed phase name/bound required')
  started=time.monotonic_ns();row={'name':name,'argv':[str(x)for x in argv],'started_monotonic_ns':started,'maximum_wall_seconds':seconds,'original_deadline_ns':started+seconds*10**9,'actual_parent_wait':False,'signals':[],'cleanup_errors':[]};child=None;primary=None
  try:
   with(self.root/(name+'.private.log')).open('xb')as log:
    child=subprocess.Popen(row['argv'],env={**self.env,**(extra or{})},stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
    # The captured object is already protected by the outer finally here.
    row['pid']=child.pid
    remaining=(row['original_deadline_ns']-time.monotonic_ns())/10**9
    if remaining<=0:raise subprocess.TimeoutExpired(row['argv'],seconds)
    row['exit_code']=child.wait(timeout=remaining);row['actual_parent_wait']=True
    row['completion_check_ns']=time.monotonic_ns()
    need(row['exit_code']==0 and phase_fence(row),'phase failed or completed after original monotonic bound: '+name)
  except BaseException as error:primary=error;row['interruption_type']=type(error).__name__
  finally:
   if child is not None and not row['actual_parent_wait']:self.finish_child(child,row)
   row['ended_monotonic_ns']=time.monotonic_ns();self.rows.append(row)
   try:write(self.root/(name+'.wait.json'),row)
   except BaseException as error:
    row['cleanup_errors'].append('receipt:'+type(error).__name__)
    if primary is None:primary=error
  if primary is not None:raise primary
  need(row['actual_parent_wait']and not row['signals']and not row['cleanup_errors']and phase_fence(row),'phase failed actual wait/cleanup/deadline gates')
  return row

def phase_fence(row):
 fields=('started_monotonic_ns','original_deadline_ns','maximum_wall_seconds','completion_check_ns')
 return all(type(row.get(k))is int for k in fields)and row['maximum_wall_seconds']>0 and row['original_deadline_ns']==row['started_monotonic_ns']+row['maximum_wall_seconds']*10**9 and row['started_monotonic_ns']<=row['completion_check_ns']<=row['original_deadline_ns']

PHASES=('fetch','hydrate','interop-safe','interop-fast','accept-interop','locked-sdk','docker-bind-stage','docker-stage','docker-bind-kernel','docker-kernel','docker-bind-probe','docker-probe','parameters','case-kernel','full-case')
def final_pass(value):
 rows=value.get('command_waits')
 return value.get('source_unchanged')is True and value.get('proof_owner_crossbound')is True and value.get('error_type')is None and type(rows)is list and [r.get('name')for r in rows]==list(PHASES)and all(r.get('actual_parent_wait')is True and type(r.get('exit_code'))is int and r['exit_code']==0 and r.get('signals')==[]and r.get('cleanup_errors')==[]and phase_fence(r)for r in rows)

def execute(policy_path,policy_sha,mode,env):
 repo=Path(env['GITHUB_WORKSPACE']).resolve(strict=True);authority,authority_pin=policy(policy_path,policy_sha,mode,repo)
 if authority_pin is None:return {'enabled':False,'native_case_acceptance':False}
 need(sys.platform=='linux'and sys.dont_write_bytecode is True and sys.pycache_prefix is None,'isolated -I -B Linux entry only')
 # All imports below are Source-only metadata or existing verifier modules, never SDK/main.
 for parent in ('integration','bench','tools'):
  p=repo/'zig'/parent/'__pycache__';need(not p.exists()and not p.is_symlink(),'unexpected verifier cache; never delete to force admission')
 ci=module(repo,'aleo_transport_admission','zig/bench/native_case_ci.py')
 expected_jobs={'full-sdk-native (ReleaseSafe)','full-sdk-native (ReleaseFast)','native-harness-controls','svm-prerequisites'}
 qualified=load(authority['qualified_cohort']);jobs=qualified.get('all4_required_jobs_actual_success')
 need(type(jobs)is list and {r['name']for r in jobs}==expected_jobs and len(jobs)==4 and all(type(r['id'])is int and r['id']>0 for r in jobs)and len({r['id']for r in jobs})==4 and qualified.get('all8_same_run_required_product_artifacts')is True and qualified.get('source_commit')==authority['runtime_source_commit'],'actual coherent Source/product qualification required')
 request=ci.read_request(checked(authority['requests'][mode]));ci.validate_request(request)
 need(request['producer_run_id']==qualified['run_id']and request['producer_run_attempt']==qualified['run_attempt'],'request must use exact qualified producer run/attempt')
 for request_pin in authority['requests'].values():
  other=ci.read_request(checked(request_pin));ci.validate_request(other)
  need(other['producer_run_id']==request['producer_run_id']and other['producer_run_attempt']==request['producer_run_attempt'],'both modes must use one coherent producer')
 root=Path(env['RUNNER_TEMP']).resolve(strict=True)/('aleo-fullcase-'+env['GITHUB_RUN_ID']+'-'+env['GITHUB_RUN_ATTEMPT']+'-'+mode.lower())
 need(not root.exists()and not root.is_symlink(),'fresh exclusive job root required');root.mkdir(mode=0o700)
 for n in ('home','tmp','public'): (root/n).mkdir(mode=0o700)
 explicit=fixed_environment(env);explicit.update(HOME=str(root/'home'),TMPDIR=str(root/'tmp'))
 cmd=Commands(root,explicit);python=Path('/usr/bin/python3.12');token=env.get('GH_TOKEN');job=None;case=None;error=None;crossbound=False
 def run(name,argv,seconds,extra=None):
  for row in [authority_pin,authority['qualified_cohort'],authority['qualified_docker'],*authority['requests'].values(),*authority['required_source']]:checked(row)
  return cmd.run(name,argv,seconds,extra)
 try:
  job=job_observation(mode,env);write(root/'job-observation.json',job)
  head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,env=explicit,text=True,timeout=5).strip();need(head==env['GITHUB_SHA'],'actual checked-out execution Source differs')
  req=authority['requests'][mode];producer=root/'producer'
  run('fetch',[python,'-I','-B',repo/'zig/bench/native_case_ci.py','--request',req['path'],'--request-sha256',req['sha256'],'--execution-source-commit',head,'--repo',repo,'--gh',Path(shutil.which('gh',path=explicit['PATH'])or'/absent').resolve(),'--output',producer],12*60,{'GH_TOKEN':token})
  transport=Path('/tmp')/('znc-'+env['GITHUB_RUN_ID']+'-'+env['GITHUB_RUN_ATTEMPT']+'-'+mode.lower())
  receipt=pin(producer/'producer-receipt.json')
  run('hydrate',[python,'-I','-B',repo/'zig/integration/native_case_inputs.py','hydrate','--reviewed-policy',req['path'],'--reviewed-policy-sha256',req['sha256'],'--producer-receipt',receipt['path'],'--producer-receipt-sha256',receipt['sha256'],'--expected-source-commit',head,'--output',transport],5*60)
  context_pin=pin(transport/'hydrated-inputs.json');context=load(context_pin)
  need(context['scenario']=='cosmosnative'and context['mode']==mode and context['nodes_started']is False,'transport is metadata only; no Rust harness grant')
  for label,writer_mode in [('safe','ReleaseSafe'),('fast','ReleaseFast')]:
   writer=context['writers'][writer_mode];tools=context['tools'];manifest=context['tool_manifest'];output=root/('interop-'+label+'.json')
   for row in (writer,tools['ziggy-native-rows'],tools['ziggy-rocks-oracle'],tools['ziggy-rust-reference'],manifest):checked(row)
   run('interop-'+label,[python,'-I','-B',repo/'zig/integration/native_rows_interop.py','--writer',writer['path'],'--writer-sha256',writer['sha256'],'--reader',tools['ziggy-native-rows']['path'],'--reader-sha256',tools['ziggy-native-rows']['sha256'],'--tool-manifest',manifest['path'],'--tool-manifest-sha256',manifest['sha256'],'--tool-source-commit',authority['runtime_source_commit'],'--output',output],8*60)
  a=pin(root/'interop-safe.json');b=pin(root/'interop-fast.json')
  run('accept-interop',[python,'-I','-B',repo/'zig/integration/native_case_inputs.py','accept-interop','--hydrated-inputs',context_pin['path'],'--hydrated-inputs-sha256',context_pin['sha256'],'--safe-result',a['path'],'--safe-result-sha256',a['sha256'],'--fast-result',b['path'],'--fast-result-sha256',b['sha256']],5*60)
  # Ordinary package acquisition, then exact offline build; never raw SDK import.
  run('locked-sdk',['/usr/bin/bash',repo/'zig/tools/aleo_linux_sdk/ci-prerequisites.sh'],80*60,{'ALEO_SDK_AUTHORIZED':'true'})
  sdk_root=Path(explicit['RUNNER_TEMP'])/('aleo-sdk-'+env['GITHUB_RUN_ID']+'-'+env['GITHUB_RUN_ATTEMPT'])
  probe_root=Path('/tmp')/('zad-'+env['GITHUB_RUN_ID']+'-'+env['GITHUB_RUN_ATTEMPT']);docker_policy=repo/'zig/tools/aleo_linux_docker/docker_probe_policy.PENDING.json';docker_policy_pin=pin(docker_policy)
  need(load(docker_policy_pin)['root_approved']is True,'separately reviewed Docker prerequisite policy required')
  def bind(phase):
   run('docker-bind-'+phase,[python,'-I','-B',repo/'zig/tools/aleo_linux_docker/docker_probe_bind.py','--mode',phase,'--reviewed-policy',docker_policy,'--policy-sha256',docker_policy_pin['sha256'],'--repo',repo,'--output',probe_root],30)
  bind('stage');stage_pin=pin(probe_root/'stage.spec.json')
  run('docker-stage',[python,'-I','-B',repo/'zig/tools/aleo_linux_docker/docker_probe_stage.py','--spec',stage_pin['path'],'--spec-sha256',stage_pin['sha256']],22*60)
  bind('kernel');kernel_pin=pin(probe_root/'kernel.spec.json')
  run('docker-kernel',[python,'-I','-B',repo/'zig/tools/aleo_linux/kernel_delegate.py','--execute','--spec',kernel_pin['path'],'--spec-sha',kernel_pin['sha256']],4*60)
  bind('probe');probe_pin=pin(probe_root/'probe.spec.json')
  run('docker-probe',[python,'-I','-B',repo/'zig/tools/aleo_linux_docker/docker_delegate.py','--execute','--spec',probe_pin['path'],'--spec-sha',probe_pin['sha256']],10*60)
  # Only actual complete same-job result is eligible for fullcase admission.
  docker_receipt=pin(probe_root/'probe/result.json');docker_owner=pin(probe_root/'probe.owner/owner.json')
  case_specs=module(repo,'actual_fullcase_specs','zig/tools/aleo_linux_case/case_specs.py')
  sdk=load(pin(sdk_root/'build/result.json'));node=sdk['node']
  case_specs.docker_admission(docker_receipt,docker_owner,node)
  parameter_home=root/'parameters';grant=pin(HERE/'closed-cache-assets.json.gz')
  run('parameters',[python,'-I','-B',HERE/'case_assets.py','--acquire','--output',parameter_home,'--grant',grant['path'],'--grant-sha',grant['sha256']],11*60)
  parameter=load(pin(parameter_home/'result.json'));need(parameter['passed']is True,'actual closed parameter acquisition required')
  case_specs.stage_shim(root/'fixture-tools')
  # All long acquisition/build work precedes the final fresh same-boot kernel.
  sdk_specs=module(repo,'actual_final_kernel_spec','zig/tools/aleo_linux_sdk/sdk_specs.py')
  tools={name:pin(Path(path).resolve(strict=True))for name,path in {'python':str(python),'node':node['path'],'bwrap':'/usr/bin/bwrap'}.items()};delegation={n:pin(Path('/usr/bin')/n)for n in ('systemd-run','systemctl','sudo')}
  kernel_output=root/'kernel-case';spec=sdk_specs.kernel_spec(kernel_output,tools,secrets.token_hex(16),delegation);spec['root_approved']=True
  spec_pin=write(root/'kernel-case.spec.json',spec)
  run('case-kernel',[python,'-I','-B',repo/'zig/tools/aleo_linux/kernel_delegate.py','--execute','--spec',spec_pin['path'],'--spec-sha',spec_pin['sha256']],4*60)
  kernel_receipt=pin(kernel_output/'result.json');kernel_owner=pin(kernel_output.with_suffix('.owner')/'owner.json');kernel=load(kernel_receipt)
  case=Path('/tmp')/('zac-'+env['GITHUB_RUN_ID']+'-'+env['GITHUB_RUN_ATTEMPT']+'-'+mode.lower())
  binding={'schema':1,'root_approved':True,'purpose':'aleo-linux-fullcase-metadata-binding-v1','repo':str(repo),'execution_source_commit':head,'runtime_source_commit':authority['runtime_source_commit'],'mode':mode,'run_token':secrets.token_hex(16),'output':str(case),'control':str(root/'control'),'context':context_pin,'sdk_receipt':pin(sdk_root/'build/result.json'),'sdk_owner_receipt':pin(sdk_root/'build.owner/owner.json'),'storage_interop':pin(transport/'accepted-native-rows-interop.json'),'kernel_receipt':kernel_receipt,'kernel_spec':kernel['spec'],'kernel_owner_receipt':kernel_owner,'docker_receipt':docker_receipt,'docker_owner_receipt':docker_owner,'assets':parameter['assets'],'parameter_home':str(parameter_home),'tools':{**tools,'docker':pin(root/'fixture-tools/aleo_linux_sdk/docker_cli.py'),'psql':pin(Path('/usr/bin/psql').resolve(strict=True)),'ps':pin(Path('/usr/bin/ps'))},'http_library':pin(Path('/usr/lib/x86_64-linux-gnu/libcurl.so.4').resolve(strict=True)),'crypto_library':pin(Path('/usr/lib/x86_64-linux-gnu/libcrypto.so.3').resolve(strict=True))}
  # Never reset the job clock. Fetch fresh API state and retain both observations.
  final_job=job_observation(mode,env);write(root/'job-observation-precase.json',final_job);remaining=require_launch_budget(final_job,time.monotonic_ns());need(require_launch_budget(job,time.monotonic_ns())>=195*60*10**9,'initial observation no longer admits original full-case bound')
  binding_pin=write(root/'actual-binding.json',binding)
  run('full-case',['/usr/bin/bash',HERE/'ci-case.sh',binding_pin['path'],binding_pin['sha256']],190*60,{'ALEO_CASE_AUTHORIZED':'true'})
  proof=pin(case/'public-final-proof.json');value=load(proof)
  need(value.get('kind')=='public-actual-aleo-proof-v1'and value.get('benchmark_or_performance_credit')is False,'dedicated actual public proof required')
  owner=load(pin(case.with_suffix('.owner')/'owner.json'));need(owner['passed']is True and owner['cleanup']['owned_cgroup_absent']is True,'actual service final wait/absence required')
  payload=load(owner['payload_result']);need(owner['public_final_proof']==proof,'actual owner/public proof fingerprint differs')
  need(value['raw_final']==payload['case_result']and value['source']['execution_source_commit']==head and value['source']['runtime_source_commit']==authority['runtime_source_commit'],'public proof/actual owner/Source crossbinding differs')
  crossbound=True
  shutil.copyfile(checked(proof),root/'public/public-final-proof.json')
 except BaseException as caught:error=type(caught).__name__;raise
 finally:
  unchanged=True
  try:
   for row in [authority_pin,authority['qualified_cohort'],authority['qualified_docker'],*authority['requests'].values(),*authority['required_source']]:checked(row)
  except BaseException:unchanged=False
  summary={'schema':1,'kind':'aleo-fullcase-ci-composition-v1','mode':mode,'passed':error is None and case is not None and (root/'public/public-final-proof.json').is_file()and unchanged,'error_type':error,'policy':authority_pin,'execution_source_commit':env['GITHUB_SHA'],'runtime_source_commit':authority['runtime_source_commit'],'source_unchanged':unchanged,'proof_owner_crossbound':crossbound,'command_waits':[{'name':r['name'],'pid':r.get('pid'),'actual_parent_wait':r['actual_parent_wait'],'exit_code':r.get('exit_code'),'signals':r['signals'],'cleanup_errors':r['cleanup_errors'],**{k:r.get(k)for k in ('started_monotonic_ns','maximum_wall_seconds','original_deadline_ns','completion_check_ns')}}for r in cmd.rows],'native_acceptance_requires_Root_readback':True,'performance_credit':False}
  summary['passed']=final_pass(summary)and summary['passed']
  write(root/'public/ci-result.json',summary)
  need(summary['passed'],'composition failed; private evidence retained, no raw fallback')
 return summary

class TaskInterrupted(RuntimeError):pass
def cancel(*args):raise TaskInterrupted('CI task interrupted')

if __name__=='__main__':
 signal.signal(signal.SIGINT,cancel);signal.signal(signal.SIGTERM,cancel)
 parser=argparse.ArgumentParser();group=parser.add_mutually_exclusive_group(required=True);group.add_argument('--execute',action='store_true');group.add_argument('--select',action='store_true');parser.add_argument('--policy',type=Path,required=True);parser.add_argument('--policy-sha',required=True);parser.add_argument('--mode',choices=MODES,required=True);args=parser.parse_args()
 if args.select:
  value,row=policy(args.policy,args.policy_sha,args.mode,Path(os.environ['GITHUB_WORKSPACE']).resolve(strict=True));enabled=row is not None
  if os.environ.get('GITHUB_OUTPUT'):
   with open(os.environ['GITHUB_OUTPUT'],'a')as output:output.write('enabled='+str(enabled).lower()+'\n')
  print(json.dumps({'enabled':enabled,'native_case_acceptance':False}))
 else:print(json.dumps(execute(args.policy,args.policy_sha,args.mode,os.environ)))
