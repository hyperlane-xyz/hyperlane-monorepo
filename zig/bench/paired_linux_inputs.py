#!/usr/bin/env python3
"""Once-only Linux comparators and verified runtime inputs; never a benchmark.

The checked request is inert by default. Acquisition/builds precede all runtime
measurements. No compiler targets/caches or opaque user environment are exported.
"""
from __future__ import annotations
import argparse,ast,gzip,hashlib,json,math,os,platform,re,shutil,signal,subprocess,sys,time,types
from pathlib import Path

GIB=1024**3
MODES=('ReleaseSafe','ReleaseFast')
BASELINE='c5202242cc6569da4a858ed7ddbb34170ab696aa'
PROFILE='locked-c520224-production-three-agent-linux-v1'
LIMITS={'maximum_wall_seconds':9000,'maximum_tree_RAM_bytes':16*GIB,'maximum_owned_growth_bytes':30*GIB,'minimum_host_free_bytes':6*GIB,'minimum_initial_free_bytes':40*GIB,'maximum_log_bytes':64*1024**2,'maximum_published_bytes':2*GIB}
SDK_KEYS={'relayer':'relayer','validator':'validator','scraper':'scraper','hyperlane-aleo-vm-worker':'worker','libziggy_aleo_crypto.so':'aleoCrypto','libziggy_aleo_vm.so':'aleoVm','libziggy_starknet_crypto.so':'starknetCrypto','libziggy_regex.so':'regex','libziggy_url.so':'url'}
TOOLS={'init-db','ziggy-rocks-oracle','ziggy-native-rows','ziggy-rust-reference'}
CODE={'.nvmrc','package.json','zig/bench/paired_linux_inputs.py','zig/bench/native_case_ci.py','zig/bench/native_payload_export.py','zig/bench/native_case_tools.py','zig/bench/native_harness_census.py','zig/bench/cold_matrix_owner.py','zig/tools/build_cpu.py','zig/integration/native_case_inputs.py','zig/integration/evm.py','zig/integration/relayer_process.py','zig/integration/public_relay_process.py','zig/integration/validator.py','zig/bench/validator.py','zig/bench/scraper.py'}
FIELDS={'schema','kind','root_approved','inputs_enabled','functional_enabled','runtime_enabled','producer_source_commit','qualified_cohort','transport_requests','baseline_source_commit','baseline_profile','required_source','prepared_inputs','accepted_six','runtime_authority'}
PUBLIC_ERROR_NAMES={'Refused','TaskInterrupted','ValueError','AssertionError','FileNotFoundError','FileExistsError','PermissionError','OSError','TypeError','KeyError','RuntimeError','AttributeError','NameError','ImportError','ModuleNotFoundError','TimeoutExpired','CalledProcessError'}
class Refused(RuntimeError):pass
class TaskInterrupted(RuntimeError):pass

def need(value,message):
 if not value:raise Refused(message)
def digest(path):
 with Path(path).open('rb')as source:return hashlib.file_digest(source,'sha256').hexdigest()
def pin(path):
 path=Path(path);need(path.is_absolute()and path.resolve(strict=True)==path and path.is_file()and not path.is_symlink(),'regular canonical input required');before=path.stat();hashed=digest(path);after=path.stat();need((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns),'input changed while hashing');return {'path':str(path),'bytes':after.st_size,'sha256':hashed}
def decode(raw):
 need(len(raw)<=16*1024**2,'bounded metadata required')
 def pairs(items):
  value={}
  for key,item in items:need(key not in value,'duplicate JSON key');value[key]=item
  return value
 def bad(value):raise Refused('nonfinite JSON')
 value=json.loads(raw,object_pairs_hook=pairs,parse_constant=bad);count=0
 def walk(item,depth=0):
  nonlocal count
  count+=1;need(count<=250000 and depth<=32,'metadata structure bound')
  if type(item)is dict:
   if set(item)=={'sha256_hex_chunks'}:
    parts=item['sha256_hex_chunks'];need(type(parts)is list and len(parts)==2 and all(type(v)is str and re.fullmatch('[0-9a-f]{32}',v)for v in parts),'public SHA halves');return ''.join(parts)
   return {key:walk(v,depth+1)for key,v in item.items()}
  if type(item)is list:return[walk(v,depth+1)for v in item]
  if type(item)is float:need(math.isfinite(item),'nonfinite JSON')
  return item
 return walk(value)
def write(path,value):
 wire=(json.dumps(value,sort_keys=True,indent=2,allow_nan=False)+'\n').encode();need(len(wire)<=16*1024**2,'output metadata bound')
 with Path(path).open('xb')as stream:stream.write(wire);stream.flush();os.fsync(stream.fileno())
 return pin(path)
def checked(row,root=None):
 need(type(row)is dict and set(row)=={'path','bytes','sha256'}and type(row['bytes'])is int and 0<=row['bytes']<=2*GIB and type(row['sha256'])is str and re.fullmatch('[0-9a-f]{64}',row['sha256']),'closed artifact pin')
 p=Path(row['path'])
 if root is not None:
  need(type(row['path'])is str and not p.is_absolute()and p.as_posix()==row['path']and p.parts and all(x not in{'.','..'}for x in p.parts)and'\\'not in row['path'],'canonical root-relative pin')
  p=root/p;need(p.resolve(strict=True)==p,'pin symlink/alias')
 need(pin(p)=={**row,'path':str(p)},'input pin changed');return p

def request(path,expected_sha,repo):
 actual=pin(path);need(actual['bytes']<=1024**2 and actual['sha256']==expected_sha,'reviewed request changed');value=decode(path.read_bytes())
 need(type(value)is dict and set(value)==FIELDS and type(value['schema'])is int and value['schema']==1 and value['kind']=='paired-linux-ci-v1','paired request schema')
 need(all(type(value[k])is bool for k in ['root_approved','inputs_enabled','functional_enabled','runtime_enabled']),'literal stage approvals required')
 need(value['baseline_source_commit']==BASELINE and value['baseline_profile']==PROFILE,'original comparator profile required')
 need(type(value['producer_source_commit'])is str and re.fullmatch('[0-9a-f]{40}',value['producer_source_commit']),'exact coherent producer Source required')
 if not value['root_approved']:
  need(not any(value[k]for k in ['inputs_enabled','functional_enabled','runtime_enabled']),'unapproved work flags');return value,None
 if not value['inputs_enabled']:return value,None
 need(type(value['required_source'])is list and value['required_source'],'applied Source closure required')
 rows={}
 for row in value['required_source']:
  p=checked(row,repo);need(row['path']not in rows,'duplicate Source pin');rows[row['path']]=pin(p)
 need(CODE<=set(rows),'required executable producer dependency missing')
 cohort=decode(checked(value['qualified_cohort'],repo).read_bytes())
 need(cohort.get('schema')==1 and cohort.get('root_approved')is True and cohort.get('passed')is True and cohort.get('Root_actual_cohort_acceptance')is True and cohort.get('source_commit')==value['producer_source_commit']and cohort.get('all8_same_run_required_product_artifacts')is True,'actual qualified coherent eight-product receipt required')
 need(set(cohort.get('eight_artifacts',{}))=={'sdk_safe','sdk_fast','helper','tools','writer_safe','writer_fast','svm','radix_reference'},'all eight Source-qualified products required')
 jobs=cohort.get('all4_required_jobs_actual_success');need(type(jobs)is list and len(jobs)==4 and {row.get('name')for row in jobs}=={'svm-prerequisites','native-harness-controls','full-sdk-native (ReleaseSafe)','full-sdk-native (ReleaseFast)'}and all(type(row.get('id'))is int and row['id']>0 for row in jobs)and len({row['id']for row in jobs})==4,'four exact actual accepted producer jobs required')
 need(type(value['transport_requests'])is dict and set(value['transport_requests'])==set(MODES),'two exact mode transport requests required')
 for mode,row in value['transport_requests'].items():
  item=decode(checked(row,repo).read_bytes());need(item.get('root_approved')is True and item.get('scenario')=='cosmosnative'and item.get('mode')==mode and item.get('producer_source_commit')==cohort['source_commit']and item.get('producer_run_id')==cohort['run_id']and item.get('producer_run_attempt')==cohort['run_attempt'],'metadata-only transport/cohort mismatch')
  need(set(item.get('artifact_pins',{}))=={'sdk','helper','tools','writer_safe','writer_fast'},'exact existing CN transport products required')
  for key,payload in item['artifact_pins'].items():
   expected=cohort['eight_artifacts'][('sdk_safe'if mode=='ReleaseSafe'else'sdk_fast')if key=='sdk'else key];need(payload==expected,'transport artifact differs from accepted cohort')
 return value,{'request':actual,'source':rows,'cohort':cohort,'metadata':[pin(checked(value['qualified_cohort'],repo)),*[pin(checked(row,repo))for row in value['transport_requests'].values()]]}

def source_cache_guard(repo):
 need(sys.pycache_prefix is None,'alternate Source pycache prefix refused')
 for relative in ['zig/bench','zig/integration','zig/tools']:
  for p in (repo/relative).rglob('*'):
   need(p.name!='__pycache__'and p.suffix not in{'.pyc','.pyo'},'unexpected executable Source bytecode cache')
def load_source(repo,relative,name,authority):
 need(relative in authority['source'],'unbound executed Source module');p=checked(authority['source'][relative]);source_cache_guard(repo)
 module=types.ModuleType(name);module.__file__=str(p);old=sys.path[:]
 try:sys.path.insert(0,str(p.parent));exec(compile(p.read_bytes(),str(p),'exec'),module.__dict__)
 finally:sys.path[:]=old
 return module

def compile_plan(repo,root):
 cargo=['cargo','+1.98.0'];flags=['--locked','--offline','--release','--manifest-path',str(repo/'rust/main/Cargo.toml'),'-p','relayer','-p','validator','-p','scraper','--features','relayer/aleo,validator/aleo,scraper/aleo','--target-dir',str(root/'target'),'-j','2','--message-format=json-render-diagnostics']
 return [
  {'name':'fetch-rust-sources','cwd':str(repo/'rust/main'),'command':cargo+['fetch','--locked','--manifest-path',str(repo/'rust/main/Cargo.toml')]},
  {'name':'fetch-evm-oracle-sources','command':cargo+['fetch','--locked','--manifest-path',str(repo/'zig/reference/evm/Cargo.toml')]},
  {'name':'runtime-cargo-metadata','cwd':str(repo/'rust/main'),'command':cargo+['metadata','--locked','--offline','--format-version','1','--manifest-path',str(repo/'rust/main/Cargo.toml'),'--features','relayer/aleo,validator/aleo,scraper/aleo']},
  {'name':'build-rust-three-agent','cwd':str(repo/'rust/main'),'command':cargo+['build',*flags]},
  {'name':'build-evm-recover-oracle','command':cargo+['build','--locked','--offline','--release','--manifest-path',str(repo/'zig/reference/evm/Cargo.toml'),'--target-dir',str(root/'oracle-target'),'-j','2','--message-format=json-render-diagnostics']},
 ]

def compile_environment(root,environ):
 need(all(type(environ.get(k))is str and environ[k]for k in ['PATH','RUSTUP_HOME']),'explicit staged toolchain inputs required')
 need(not(root/'cargo-home/config').exists()and not(root/'cargo-home/config.toml').exists(),'unreviewed Cargo home configuration')
 return {'PATH':environ['PATH'],'RUSTUP_HOME':environ['RUSTUP_HOME'],'HOME':str(root/'home'),'TMPDIR':str(root/'tmp'),'CARGO_HOME':str(root/'cargo-home'),'CARGO_INCREMENTAL':'0','CARGO_BUILD_JOBS':'2','CARGO_TERM_COLOR':'never','RUSTFLAGS':'--cfg tokio_unstable -Ctarget-cpu=native','RUSTC_WRAPPER':'','RUSTC_WORKSPACE_WRAPPER':'','CARGO_BUILD_RUSTC_WRAPPER':'','CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER':'','CCACHE_DISABLE':'1','SCCACHE_DISABLE':'1','LC_ALL':'C.UTF-8','PYTHONNOUSERSITE':'1','PYTHONDONTWRITEBYTECODE':'1'}

def baseline_reachable_paths(metadata,repo):
 need(type(metadata)is dict and metadata.get('resolve')is not None,'actual Cargo resolved graph required')
 packages={p['id']:p for p in metadata['packages']};nodes={n['id']:n for n in metadata['resolve']['nodes']};roots=[]
 for role in ['relayer','validator','scraper']:
  selected=[p for p in packages.values()if p['name']==role and Path(p['manifest_path'])==repo/'rust/main/agents'/role/'Cargo.toml'];need(len(selected)==1,'exact runtime package root required');roots.append(selected[0]['id'])
 seen=set();stack=list(roots)
 while stack:
  key=stack.pop()
  if key in seen:continue
  seen.add(key);need(key in nodes,'resolved dependency node missing')
  for dep in nodes[key]['deps']:
   if any(k['kind']in(None,'build')for k in dep['dep_kinds']):stack.append(dep['pkg'])
 paths={'rust/main/Cargo.toml','rust/main/Cargo.lock','rust/main/.cargo','rust/sealevel/Cargo.toml','rust/sealevel/Cargo.lock'}
 for key in seen:
  p=Path(packages[key]['manifest_path'])
  if p.is_relative_to(repo):paths.add(str(p.parent.relative_to(repo)))
 need(not any(p=='rust/main/utils/run-locally'or p.startswith('rust/main/utils/run-locally/')for p in paths),'fixture helper cannot justify original production comparator')
 return sorted(paths)

def cargo_products(log,expected,target):
 need(log.stat().st_size<=LIMITS['maximum_log_bytes'],'Cargo log bound');found={}
 with log.open()as source:
  for line in source:
   need(len(line)<=2*1024**2,'Cargo event bound')
   try:value=json.loads(line)
   except json.JSONDecodeError:continue
   if value.get('reason')!='compiler-artifact'or value.get('target',{}).get('name')not in expected or value.get('profile',{}).get('test')or not value.get('executable'):continue
   name=value['target']['name'];path=Path(value['executable']);need(name not in found and path==target/'release'/name and path.resolve(strict=True)==path,'exclusive actual Cargo executable path required');found[name]=path
 need(set(found)==set(expected),'actual emitted product set incomplete');return found

def relative_pin(path,published):
 value=pin(path);return{**value,'path':str(path.relative_to(published))}
def copy_owned(source,target,expected,guard,mode):
 need(pin(source)['bytes']==expected['bytes']and pin(source)['sha256']==expected['sha256'],'source payload changed');need(not target.exists()and not target.is_symlink(),'exclusive output payload required');target.parent.mkdir(parents=True,exist_ok=True)
 with source.open('rb')as src,target.open('xb')as dst:
  for data in iter(lambda:src.read(1024**2),b''):guard();dst.write(data)
  dst.flush();os.fsync(dst.fileno())
 target.chmod(mode);need(pin(target)['bytes']==expected['bytes']and digest(target)==expected['sha256'],'published copy changed');guard();return target

def final_phase(row):
 return row.get('error_type')is None and row.get('actual_parent_wait')is True and type(row.get('exit_code'))is int and row['exit_code']==0 and row.get('signals')==[]and row.get('owned_absent')is True and row.get('completed_within_original_deadline')is True

class Preparation:
 def __init__(self,root,repo,owner,census,deadline):
  self.root=root;self.repo=repo;self.owner=owner;self.census=census;self.deadline=deadline;self.rows=[];self.counters={};self.peak=0
 def guard(self):
  need(time.monotonic()<self.deadline,'original whole preparation deadline')
  need(shutil.disk_usage(self.root).free>=LIMITS['minimum_host_free_bytes'],'six-GiB preparation floor')
  need(self.census.functional_allocated(self.root,self.counters)<=LIMITS['maximum_owned_growth_bytes'],'owned preparation growth cap')
 def run(self,name,argv,env,seconds=None,cwd=None):
  phase_deadline=min(self.deadline,time.monotonic()+seconds)if seconds is not None else self.deadline
  self.guard();out=self.root/'logs'/(name+'.stdout');err=self.root/'logs'/(name+'.stderr');child=None;known={};groups={};cleanup=None;failure=None
  row={'name':name,'actual_parent_wait':False,'exit_code':None,'signals':[],'owned_absent':False,'error_type':None,'started_monotonic_ns':time.monotonic_ns(),'command':[str(x)for x in argv],'cwd':str(self.repo if cwd is None else cwd)}
  try:
   with out.open('xb')as stdout,err.open('xb')as stderr:
    # Same qualified cold-owner launch fence: cancellation cannot land between
    # successful Popen and capture; compiler child restores the original mask.
    watched={signal.SIGINT,signal.SIGTERM,signal.SIGHUP};old_mask=signal.pthread_sigmask(signal.SIG_BLOCK,watched)
    try:
     def unmask_child():signal.pthread_sigmask(signal.SIG_SETMASK,old_mask)
     child=subprocess.Popen([str(x)for x in argv],cwd=self.repo if cwd is None else cwd,env=env,stdin=subprocess.DEVNULL,stdout=stdout,stderr=stderr,start_new_session=True,preexec_fn=unmask_child)
     groups[child.pid]=child.pid
    finally:signal.pthread_sigmask(signal.SIG_SETMASK,old_mask)
    while True:
     self.guard();need(time.monotonic()<phase_deadline,'original phase deadline');current=self.owner.processes();owned=self.owner.owned_processes(current,child.pid,known,groups,True)
     need(os.getpid()in current,'manager RAM observation absent');self.peak=max(self.peak,current[os.getpid()]['rss_bytes']+sum(x['rss_bytes']for x in owned.values()));need(self.peak<=LIMITS['maximum_tree_RAM_bytes'],'preparation owned-tree RAM cap')
     need(out.stat().st_size<=LIMITS['maximum_log_bytes']and err.stat().st_size<=LIMITS['maximum_log_bytes'],'phase output bound')
     if os.waitid(os.P_PID,child.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT)is not None:break
     time.sleep(.2)
  except BaseException as error:failure=error;row['error_type']=type(error).__name__
  finally:
   if child is not None:
    saved={sig:signal.signal(sig,signal.SIG_IGN)for sig in [signal.SIGINT,signal.SIGTERM,signal.SIGHUP]}
    try:
     try:cleanup=self.owner.stop_owned(child,known,groups)
     except BaseException as error:
      row['cleanup_error_type']=type(error).__name__
      if failure is None:failure=error;row['error_type']=type(error).__name__
     # A stop helper failure may not suppress the actual direct-parent wait.
     if child.returncode is None:
      # Independent positively-owned direct/group fallback if discovery failed.
      try:
       if os.waitid(os.P_PID,child.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT)is None:
        os.killpg(child.pid,signal.SIGKILL);row['fallback_signal']=int(signal.SIGKILL)
      except BaseException as error:row['fallback_signal_error_type']=type(error).__name__
      try:child.wait(timeout=3);row['fallback_actual_parent_wait']=True
      except BaseException as error:row['direct_wait_error_type']=type(error).__name__
    finally:
     for sig,value in saved.items():signal.signal(sig,value)
    row['pid']=child.pid;row['exit_code']=child.returncode;row['cleanup']=cleanup
    row['actual_parent_wait']=bool(cleanup and cleanup.get('actual_parent_wait'))or row.get('fallback_actual_parent_wait')is True
    row['signals']=[]if cleanup is None else cleanup.get('signals',[])
    row['owned_absent']=bool(cleanup and cleanup.get('clean')and not cleanup.get('errors')and not cleanup.get('remaining_identities')and not cleanup.get('unanchored_session_members'))
   row['completion_check_ns']=time.monotonic_ns();row['original_deadline_monotonic_ns']=int(phase_deadline*10**9);row['completed_within_original_deadline']=time.monotonic()<phase_deadline
   row['stdout']=pin(out);row['stderr']=pin(err);self.rows.append(row)
   write(self.root/'logs'/(name+'.result.json'),row)
  if failure is not None:raise failure
  need(final_phase(row),'fixed preparation phase failed: '+name)
  self.guard();return row

def system_environment(root,environ):
 need(type(environ.get('PATH'))is str and environ['PATH'],'explicit setup PATH required')
 return {'PATH':environ['PATH'],'HOME':str(root/'home'),'TMPDIR':str(root/'tmp'),'LC_ALL':'C.UTF-8','PYTHONNOUSERSITE':'1','PYTHONDONTWRITEBYTECODE':'1','NO_COLOR':'1','RUNNER_TEMP':environ['RUNNER_TEMP'],'npm_config_ignore_scripts':'true','npm_config_userconfig':str(root/'home/empty-user.npmrc'),'npm_config_globalconfig':str(root/'home/empty-global.npmrc')}

def archive_copy(receipt,key,destination,guard,executable_members):
 entry=receipt['artifacts'][key];source=Path(entry['directory']);names=set()
 for row in entry['files']:
  name=row['relative_path'];need(name not in names and Path(name).as_posix()==name and not Path(name).is_absolute()and'..'not in Path(name).parts,'closed archive member');names.add(name)
  copy_owned(source/name,destination/name,row,guard,0o755 if name in executable_members else 0o644)
 return names

def source_fence(api,tools,repo,expected,locks):
 need(tools.source(repo)==expected and {name:pin(repo/name)for name in locks}==locks,'tracked Source or decoded working lock changed')
 source_cache_guard(repo)

def source_authority_recheck(authority):
 for row in authority['source'].values():checked(row)
 checked(authority['request'])
 for row in authority['metadata']:checked(row)

def failure_observation(error,repo,authority):
 """Closed Source coordinates and literal guards; never exception text/logs."""
 if error is None:return None
 result={'type':type(error).__name__ if type(error).__name__ in PUBLIC_ERROR_NAMES else 'OtherError','errno':getattr(error,'errno',None),'Source_guard':None,'Source_frames':[]}
 if type(result['errno'])is not int or not 0<=result['errno']<=255:result['errno']=None
 literals=set();frame=error.__traceback__
 while frame is not None and len(result['Source_frames'])<16:
  path=Path(frame.tb_frame.f_code.co_filename)
  if path.is_absolute()and path.is_relative_to(repo):
   relative=str(path.relative_to(repo));expected=authority['source'].get(relative)
   if expected is not None:
    try:
     checked(expected);wire=path.read_bytes();need(hashlib.sha256(wire).hexdigest()==expected['sha256']and len(wire)==expected['bytes'],'diagnostic Source differs')
     function=frame.tb_frame.f_code.co_name
     if re.fullmatch('[A-Za-z_][A-Za-z0-9_]{0,127}|<module>',function):result['Source_frames'].append({'source':relative,'sha256':expected['sha256'],'line':frame.tb_lineno,'function':function})
     for call in ast.walk(ast.parse(wire)):
      if isinstance(call,ast.Call)and isinstance(call.func,ast.Name)and call.func.id in {'need','require'}and len(call.args)>1 and isinstance(call.args[1],ast.Constant)and type(call.args[1].value)is str:literals.add(call.args[1].value)
    except (OSError,Refused,SyntaxError):pass
  frame=frame.tb_next
 if type(error)in {Refused,ValueError,AssertionError}and len(error.args)==1 and type(error.args[0])is str and error.args[0]in literals:result['Source_guard']=error.args[0]
 return result

def public_preparation_result(result,error,repo,authority):
 rows=[]
 for row in result['actual_command_waits']:
  name=row.get('name');need(type(name)is str and re.fullmatch('[A-Za-z0-9_.-]{1,96}',name),'closed diagnostic phase name')
  exit_code=row.get('exit_code');need(exit_code is None or type(exit_code)is int and -255<=exit_code<=255,'closed diagnostic exit status')
  error_type=row.get('error_type');need(error_type is None or type(error_type)is str,'closed diagnostic error class')
  error_type=error_type if error_type is None or error_type in PUBLIC_ERROR_NAMES else 'OtherError'
  rows.append({'name':name,'actual_parent_wait':row.get('actual_parent_wait')is True,'exit_code':exit_code,'owned_absent':row.get('owned_absent')is True,'signal_count':len(row.get('signals',[])),'error_type':error_type,'completed_within_original_deadline':row.get('completed_within_original_deadline')is True})
 return {'schema':1,'kind':'paired-linux-input-diagnostic','passed':result['passed'],'error_observation':failure_observation(error,repo,authority),'actual_phase_waits':rows,'source_policy':result['source_policy'],'limits':result['limits'],'started_monotonic_ns':result['started_monotonic_ns'],'completed_monotonic_ns':result['completed_monotonic_ns'],'whole_deadline_observed':result['whole_deadline_observed'],'native_or_timing_acceptance':False,'raw_exception_argv_environment_or_logs_exported':False}

def publish_input_diagnostic(root,result,error,repo,authority):
 try:record=public_preparation_result(result,error,repo,authority)
 except Exception as diagnostic_error:
  primary=type(error).__name__ if error is not None else None
  record={'schema':1,'kind':'paired-linux-input-diagnostic','passed':False,'primary_error_type':primary if primary is None or primary in PUBLIC_ERROR_NAMES else 'OtherError','diagnostic_error_type':type(diagnostic_error).__name__ if type(diagnostic_error).__name__ in PUBLIC_ERROR_NAMES else 'OtherError','native_or_timing_acceptance':False,'raw_exception_argv_environment_or_logs_exported':False}
 try:write(root/'input-diagnostic.json',record)
 except OSError:print('INPUT_DIAGNOSTIC_WRITE_FAILED',file=sys.stderr)

def read_phase_json(row):
 p=checked(row['stdout']);need(p.stat().st_size<=16*1024**2,'metadata stdout bound');return decode(p.read_bytes())

def revoke_publication(published):
 path=published/'input-manifest.json'
 if path.exists():
  old=decode(path.read_bytes());old['passed']=False
  with path.open('w')as stream:json.dump(old,stream,sort_keys=True,indent=2,allow_nan=False);stream.write('\n');stream.flush();os.fsync(stream.fileno())

def publish_final_result(root,published,result,deadline):
 write(root/'result.json',result)
 # The advertised whole-stage fence includes result/manifest postprocessing,
 # not merely the final compiler command. A late fsync can never grant pass.
 if time.monotonic()>=deadline:
  result['passed']=False;result['whole_deadline_observed']=False;result['publication_deadline_failed']=True;result['completed_monotonic_ns']=time.monotonic_ns();revoke_publication(published)
  with (root/'result.json').open('w')as stream:json.dump(result,stream,sort_keys=True,indent=2,allow_nan=False);stream.write('\n');stream.flush();os.fsync(stream.fileno())
 return result

def producer_main(request_path,request_sha,repo,root,environ,gh):
 value,authority=request(request_path,request_sha,repo)
 if authority is None:return {'enabled':False,'inputs_prepared':False,'native_or_timing_acceptance':False}
 need(sys.platform=='linux'and platform.machine()in{'x86_64','amd64'},'actual native Linux x86_64 producer required')
 need(repo.resolve(strict=True)==repo and root.is_absolute()and not root.exists()and not root.is_symlink()and root.parent.resolve(strict=True)==root.parent,'fresh canonical root required')
 need(root.is_relative_to(Path(environ['RUNNER_TEMP']).resolve(strict=True))and not root.is_relative_to(repo),'owned runner-temp preparation root required')
 need(shutil.disk_usage(root.parent).free>=LIMITS['minimum_initial_free_bytes'],'forty-GiB after tools/acquisition staging required')
 need(type(environ.get('GITHUB_SHA'))is str and re.fullmatch('[0-9a-f]{40}',environ['GITHUB_SHA']),'actual CI execution Source required')
 root.mkdir(mode=0o700)
 for name in ['home','tmp','cargo-home','logs','published']:(root/name).mkdir(mode=0o700)
 published=root/'published';
 for name in ['empty-user.npmrc','empty-global.npmrc']:(root/'home'/name).write_bytes(b'')
 started=time.monotonic();deadline=started+LIMITS['maximum_wall_seconds'];failure=None;failure_error=None;manifest=None;prep=None
 try:
  api=load_source(repo,'zig/integration/native_case_inputs.py','paired_verified_hydrator',authority)
  tools=load_source(repo,'zig/bench/native_case_tools.py','paired_tool_elf',authority)
  owner=load_source(repo,'zig/bench/cold_matrix_owner.py','paired_preparation_custody',authority)
  census=load_source(repo,'zig/bench/native_harness_census.py','paired_preparation_census',authority)
  cpu=load_source(repo,'zig/tools/build_cpu.py','paired_preparation_cpu',authority)
  owner.enable_subreaper()
  def interrupted(sig,frame):raise TaskInterrupted('preparation cancelled')
  for sig in [signal.SIGINT,signal.SIGTERM,signal.SIGHUP]:signal.signal(sig,interrupted)
  prep=Preparation(root,repo,owner,census,deadline);plain=system_environment(root,environ);env=compile_environment(root,environ)
  git_evidence=[];execution=environ['GITHUB_SHA'];need(api.git(repo,'rev-parse','HEAD',evidence=git_evidence)==execution,'actual execution head differs')
  scopes={name:api.cohort(repo,value['producer_source_commit'],execution,name,git_evidence)for name in api.SCOPES}
  api.decoded_locks(repo,git_evidence)
  locks={name:pin(repo/name)for name in ['rust/main/Cargo.lock','rust/sealevel/Cargo.lock','zig/reference/evm/Cargo.lock']}
  need(gzip.decompress((repo/'zig/reference/evm/Cargo.lock.gz').read_bytes())==(repo/'zig/reference/evm/Cargo.lock').read_bytes(),'EVM oracle canonical lock required')
  before=tools.source(repo);host_flags=cpu.cpu_flags(Path('/proc/cpuinfo').read_text());available=cpu.cpu_flags(Path('/proc/cpuinfo').read_text(),intersection=True);required=set(host_flags)
  artifacts={'rust':{},'zig':{},'tools':{},'evm_oracle':None,'tool_manifest':None};transport_receipts={};sdk_provenance={};sdk_manifests={};tools_manifest=None
  gh=Path(gh).resolve(strict=True);need(gh.is_file()and os.access(gh,os.X_OK),'explicit admitted GitHub CLI required')
  need(type(environ.get('GH_TOKEN'))is str and environ['GH_TOKEN'],'read-only CI download token required')
  download_env={**plain,'GH_TOKEN':environ['GH_TOKEN']}
  for mode in MODES:
   row=value['transport_requests'][mode];selector=checked(row,repo);target=root/('download-'+mode)
   prep.run('fetch-'+mode,[sys.executable,'-I','-B',repo/'zig/bench/native_case_ci.py','--request',selector,'--request-sha256',row['sha256'],'--execution-source-commit',execution,'--repo',repo,'--gh',gh,'--output',target],download_env)
   original=api.load_module('paired_request_wire','zig/bench/native_case_ci.py').read_request(selector)
   receipt=api.producer_receipt(selector,original,api.artifact(target/'producer-receipt.json'),execution);transport_receipts[mode]=receipt
   flags=cpu.cpu_flags(api.helper_cpu_input(receipt).read_text());need(set(flags)<=set(available),'input VM lacks helper/tools compile CPU');required.update(flags)
   source=Path(receipt['artifacts']['sdk']['directory']);sdk,records,compiled=api.sdk_inputs(source,api.artifact(source/'manifest.json'),mode,value['producer_source_commit'],'amd64',available)
   for item in compiled:required.update(item['flags'])
   executable={row['path']for name,row in sdk['artifacts'].items()if name in{'relayer','validator','scraper','hyperlane-aleo-vm-worker'}}
   names=archive_copy(receipt,'sdk',published/'zig'/mode,prep.guard,executable)
   need(len(names)==len(receipt['artifacts']['sdk']['files']),'SDK closed copied member count')
   artifacts['zig'][mode]={SDK_KEYS[name]:relative_pin(published/'zig'/mode/row['path'],published)for name,row in sdk['artifacts'].items()}
   sdk_manifests[mode]=relative_pin(published/'zig'/mode/'manifest.json',published);sdk_provenance[mode]=compiled
   if tools_manifest is None:
    source=Path(receipt['artifacts']['tools']['directory']);raw=api.read_json(source/'manifest.json');need(set(raw['tools'])==TOOLS,'exact original four tools required')
    archive_copy(receipt,'tools',published/'tools',prep.guard,{item['relative_path']for item in raw['tools'].values()})
    tools_manifest=published/'tools/manifest.json';accepted=tools.load_manifest(tools_manifest,digest(tools_manifest),value['producer_source_commit'],62)
    artifacts['tools']={name:relative_pin(Path(row['path']),published)for name,row in accepted.items()};artifacts['tool_manifest']=relative_pin(tools_manifest,published)
   source_fence(api,tools,repo,before,locks);source_authority_recheck(authority)
  system_paths,versions=staged_tools(prep,plain,env,repo)
  plans=compile_plan(repo,root)
  for phase in plans:
   row=prep.run(phase['name'],phase['command'],env,cwd=Path(phase.get('cwd',repo)))
   if phase['name']=='runtime-cargo-metadata':
    metadata=read_phase_json(row);reachable=baseline_reachable_paths(metadata,repo)
    need(api.git(repo,'diff','--name-only',BASELINE,execution,'--',*reachable,evidence=git_evidence)=='','actual reachable Rust baseline Source differs')
    need(api.git(repo,'diff','--name-only','HEAD','--',*reachable,evidence=git_evidence)=='','dirty actual reachable comparator Source')
    baseline_qualification={'baseline_source_commit':BASELINE,'build_checkout_commit':execution,'actual_normal_build_dependency_closure':reachable,'metadata_stdout':row['stdout'],'helper_fixture_excluded_by_actual_Cargo_reachability':True,'compiled_Source_equal':True,'profile':PROFILE,'RUSTFLAGS':env['RUSTFLAGS']}
   elif phase['name']=='build-rust-three-agent':
    for name,path in cargo_products(checked(row['stdout']),{'relayer','validator','scraper'},root/'target').items():
     tools.validate_elf(path,62);dest=published/'rust'/name;copy_owned(path,dest,pin(path),prep.guard,0o755);artifacts['rust'][name]=relative_pin(dest,published)
   elif phase['name']=='build-evm-recover-oracle':
    path=cargo_products(checked(row['stdout']),{'ziggy-evm-oracle'},root/'oracle-target')['ziggy-evm-oracle'];tools.validate_elf(path,62);dest=published/'oracles/ziggy-evm-oracle';copy_owned(path,dest,pin(path),prep.guard,0o755);artifacts['evm_oracle']=relative_pin(dest,published)
   source_fence(api,tools,repo,before,locks);source_authority_recheck(authority)
  external,versions=system_inventory(prep,plain,repo,root,published,artifacts,system_paths,versions)
  fixtures,fixture_sources=stage_fixture_inputs(prep,plain,repo,root,request_path,request_sha,published)
  for row in fixture_sources:
   checked(row,repo);need(api.git(repo,'hash-object',str(repo/row['path']),evidence=git_evidence)==api.git(repo,'rev-parse',execution+':'+row['path'],evidence=git_evidence),'fixture compiled Source differs from actual execution Git object')
  source_fence(api,tools,repo,before,locks);source_authority_recheck(authority);prep.guard()
  for group in ['tools','libraries','compile_toolchain','runtime_libraries']:
   for external_pin in external[group].values():checked(external_pin)
  provenance=published/'provenance';provenance.mkdir()
  transport_exports={}
  for mode in MODES:
   src=root/('download-'+mode)/'producer-receipt.json';dest=provenance/('transport-'+mode+'.json');copy_owned(src,dest,pin(src),prep.guard,0o644);transport_exports[mode]=relative_pin(dest,published)
  source_gate=write(provenance/'source-gate.json',{'schema':1,'producer_source_commit':value['producer_source_commit'],'execution_source_commit':execution,'baseline':baseline_qualification,'cohort':scopes,'source_before':before,'source_after':tools.source(repo),'locks':locks,'actual_waited_Git_checks':git_evidence,'source_unchanged':True,'timing_acceptance':False})
  command_records=[]
  for row in prep.rows:
   copied=dict(row)
   for stream in ['stdout','stderr']:
    dest=provenance/'commands'/(row['name']+'.'+stream);copy_owned(checked(row[stream]),dest,row[stream],prep.guard,0o644);copied[stream]=relative_pin(dest,published)
   command_records.append(copied)
  build_gate=write(provenance/'build-receipt.json',{'schema':1,'passed':all(final_phase(x)for x in prep.rows),'fixed_profile':PROFILE,'system_tool_resolution':{name:{'invocation_path':shutil.which(name,path=plain['PATH']),'actual_resolved_pin':system_paths[name]}for name in TOOL_NAMES},'actual_commands':command_records,'peak_observed_tree_RAM_bytes':prep.peak,'consumer_CPU_flags':available,'compile_CPU_flags':host_flags,'SDK_baked_CPU':sdk_provenance,'download_receipts':transport_exports,'tool_versions':versions,'native_or_timing_acceptance':False})
  manifest={'schema':1,'kind':'paired-linux-inputs-v1','platform':'linux-x86_64','passed':False,'source_unchanged':True,'all_actual_parent_waits':all(final_phase(x)for x in prep.rows),'owned_absent':all(x['owned_absent']for x in prep.rows),'producer_source_commit':value['producer_source_commit'],'baseline_source_commit':BASELINE,'execution_source_commit':execution,'request_sha256':request_sha,'baseline_profile':PROFILE,'artifacts':artifacts,'required_cpu_flags':sorted(required),'source_gate':relative_pin(Path(source_gate['path']),published),'build_receipt':relative_pin(Path(build_gate['path']),published),'SDK_manifests':sdk_manifests,'repository_source_files':fixture_sources,'repository_fixture_files':fixtures,'fixture_tools':{},'external':external,'native_or_timing_acceptance':False,'files':[]}
  manifest['files']=[relative_pin(p,published)for p in sorted(published.rglob('*'))if p.is_file()];need(sum(x['bytes']for x in manifest['files'])<=LIMITS['maximum_published_bytes'],'bounded published product closure')
  need(set(artifacts['rust'])=={'relayer','validator','scraper'}and set(artifacts['zig'])==set(MODES)and all(set(v)==set(SDK_KEYS.values())for v in artifacts['zig'].values())and set(artifacts['tools'])==TOOLS and artifacts['evm_oracle']and artifacts['tool_manifest'],'all actual input products required')
  need(manifest['source_unchanged']and manifest['all_actual_parent_waits']and manifest['owned_absent'],'input final custody gate failed');prep.guard();manifest['passed']=True;write(published/'input-manifest.json',manifest)
  prep.guard();source_fence(api,tools,repo,before,locks);source_authority_recheck(authority)
  for row in fixture_sources:checked(row,repo)
 except BaseException as error:failure=type(error).__name__;failure_error=error
 finally:
  result={'schema':1,'kind':'paired-linux-input-preparation-result','passed':failure is None and manifest is not None and manifest.get('passed')is True,'error_type':failure,'actual_command_waits':[]if prep is None else prep.rows,'source_policy':authority['request'],'limits':LIMITS,'started_monotonic_ns':int(started*10**9),'completed_monotonic_ns':time.monotonic_ns(),'whole_deadline_observed':time.monotonic()<deadline,'native_or_timing_acceptance':False}
  result['passed']=result['passed']and result['whole_deadline_observed']and bool(prep)and all(final_phase(x)for x in prep.rows)
  if not result['passed']:revoke_publication(published)
  publish_final_result(root,published,result,deadline)
  publish_input_diagnostic(root,result,failure_error,repo,authority)
 need(result['passed'],'input preparation failed; actual failure evidence retained');return result

TOOL_NAMES=('cargo','rustc','rustup','cc','clang','cmake','pkg-config','protoc','git','ps','ldd','ldconfig','node','pnpm','anvil','cast','forge','docker','psql','lsof','sh','openssl')
PG16='postgres@sha256:'+'43f9275df91e012c3da3d86bea5d7bb5'+'e67a473296cc906c5f9e80b8176b1a37'

def staged_tools(prep,plain,compile_env,repo):
 paths={name:pin(Path(shutil.which(name,path=plain['PATH'])or'/nonexistent').resolve(strict=True))for name in TOOL_NAMES}
 paths['python3']=pin(Path(sys.executable).resolve(strict=True))
 need(paths['clang']['path']==str(Path('/usr/bin/clang').resolve(strict=True)),'fixed crash compiler differs from recorded bare clang')
 versions={};toolchain={}
 for name in ['cargo','rustc']:
  row=prep.run('resolve-1.98.0-'+name,['rustup','which','--toolchain','1.98.0',name],compile_env,seconds=10);text=checked(row['stdout']).read_text().strip();need('\n'not in text and Path(text).is_absolute(),'single actual selected toolchain path');toolchain[name]=pin(Path(text).resolve(strict=True))
 for name,args in [('cargo',['+1.98.0','-V']),('rustc',['+1.98.0','-vV']),('node',['--version']),('pnpm',['--version']),('clang',['--version']),('anvil',['--version']),('cast',['--version']),('psql',['--version']),('openssl',['version'])]:
  row=prep.run('version-'+name,[name,*args],compile_env if name in{'cargo','rustc'}else plain,seconds=10);wire=checked(row['stdout']).read_text();need(len(wire)<=32768,'bounded tool version');versions[name]={'stdout':row['stdout'],'text':wire.strip()}
 need(versions['cargo']['text'].startswith('cargo 1.98.0 ')and versions['rustc']['text'].startswith('rustc 1.98.0 '),'exact staged Rust1.98.0 required')
 need(versions['node']['text']==(repo/'.nvmrc').read_text().strip(),'exact repository Node version')
 manager=decode((repo/'package.json').read_bytes())['packageManager'];need(re.fullmatch(r'pnpm@12\.3\.0\+sha512\.[0-9a-f]+',manager)and versions['pnpm']['text']=='12.3.0','exact pinned pnpm12.3.0 required')
 need('PostgreSQL) 16.'in versions['psql']['text'],'PostgreSQL16 client required')
 versions['actual_compile_toolchain']=toolchain
 return paths,versions

def library_rows(wire):
 need(type(wire)is str and len(wire)<=1024**2,'bounded trusted ldd metadata');out=set()
 for line in wire.splitlines():
  text=line.strip()
  need('not found'not in text,'required dynamic library missing')
  if not text or text.startswith(('linux-vdso','statically linked')):continue
  match=re.fullmatch(r'(?:[^ ]+ => )?(/[^ ]+) \(0x[0-9a-fA-F]+\)',text)
  need(match is not None,'unrecognized dynamic library row');out.add(match[1])
 return out

RUNTIME_LIBRARIES={name:[Path(prefix)/name for prefix in ['/usr/lib/x86_64-linux-gnu','/lib/x86_64-linux-gnu']]for name in ['libcurl.so.4','libpq.so.5']}
def fixed_runtime_libraries():
 out={}
 for name,candidates in RUNTIME_LIBRARIES.items():
  found={p.resolve(strict=True)for p in candidates if p.exists()};need(len(found)==1,'exact fixed runtime library absent or ambiguous: '+name);out[name]=pin(found.pop())
 return out

def system_inventory(prep,plain,repo,root,published,artifacts,paths,versions):
 runtime_libraries=fixed_runtime_libraries();libraries={row['path']:row for row in runtime_libraries.values()};products=[*artifacts['rust'].values(),artifacts['evm_oracle'],*artifacts['tools'].values(),*[r for mode in MODES for r in artifacts['zig'][mode].values()]]
 # All are independently Source/ELF-admitted before this loader metadata query;
 # no chain/agent main, database or benchmark is started.
 targets=[published/row['path']for row in products]+[Path(paths[n]['path'])for n in ['node','anvil','cast','psql','clang']]+[Path(row['path'])for row in runtime_libraries.values()]
 for index,path in enumerate(targets):
  row=prep.run('dynamic-libraries-'+str(index),[paths['ldd']['path'],str(path)],plain,seconds=10)
  for name in library_rows(checked(row['stdout']).read_text()):
   actual=Path(name).resolve(strict=True);libraries[str(actual)]=pin(actual)
 need(any('libcurl.so' in n for n in libraries)or any('libcurl-gnutls.so'in n for n in libraries),'actual runtime curl library required')
 row=prep.run('postgres16-image-metadata',[paths['docker']['path'],'image','inspect',PG16,'--format','{"id":{{json .Id}},"repo_digests":{{json .RepoDigests}},"os":{{json .Os}},"architecture":{{json .Architecture}}}'],plain,seconds=10)
 pg=read_phase_json(row);need(type(pg)is dict and set(pg)=={'id','repo_digests','os','architecture'}and re.fullmatch('sha256:[0-9a-f]{64}',pg['id'])and pg['os']=='linux'and pg['architecture']=='amd64'and type(pg['repo_digests'])is list and 'postgres@'+PG16.split('@')[1]in pg['repo_digests'],'exact staged PostgreSQL16 image identity required')
 fixture_names={'python3','cc','clang','git','ps','node','pnpm','anvil','cast','forge','docker','psql','lsof','sh','openssl'}
 return {'tools':{name:row for name,row in paths.items()if name in fixture_names},'runtime_libraries':runtime_libraries,'compile_toolchain':{**{name:row for name,row in paths.items()if name not in fixture_names},**versions['actual_compile_toolchain']},'libraries':libraries,'postgres':{'image':'postgres:16.15','pinned_reference':PG16,**pg,'metadata_only_no_container_started':True}},versions

def fixture_preset_nodes(repo,label):
 if label in{'relayer','public'}:
  relative='zig/integration/'+('relayer_process.py'if label=='relayer'else'public_relay_process.py')
  nodes=[n for n in ast.parse((repo/relative).read_bytes()).body if isinstance(n,ast.FunctionDef)and n.name=='compile_contracts'];need(len(nodes)==1,'actual fixture compile function required');return nodes
 relative='zig/bench/'+label+'.py';tree=ast.parse((repo/relative).read_bytes());main=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='main');nodes=[]
 # Read only the original contract-preset assignments, never a benchmark import
 # or its measured constructors/main. Body AST and input_digest method retained.
 if label=='scraper':nodes=[n for n in tree.body if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='CONTRACT_NAMES'for t in n.targets)]
 for n in ast.walk(main):
  if isinstance(n,ast.Assign)and any((isinstance(t,ast.Attribute)and isinstance(t.value,ast.Name)and t.value.id=='evm'and t.attr=='CONTRACTS')or(isinstance(t,ast.Subscript)and isinstance(t.value,ast.Attribute)and isinstance(t.value.value,ast.Name)and t.value.value.id=='evm'and t.value.attr=='CONTRACTS')for t in n.targets):nodes.append(n)
 need(len(nodes)==(3 if label=='scraper'else 2),'exact original paired fixture preset');return sorted(nodes,key=lambda n:n.lineno)

def fixture_source_records(inputs,repo):
 rows=[]
 for name,value in inputs['sources'].items():
  if name.startswith('@openzeppelin/'):continue
  need(type(name)is str and name.startswith(('solidity/contracts/','zig/integration/public_contracts/'))and name.endswith('.sol'),'original closed repository contract Source required')
  row=relative_pin(repo/name,repo);need((repo/name).read_text()==value['content'],'actual compiler Source bytes differ');rows.append(row)
 need(rows and len(rows)<=4096,'bounded actual contract Source closure');return sorted(rows,key=lambda row:row['path'])

def fixture_worker(request_path,request_sha,repo,root):
 value,authority=request(request_path,request_sha,repo);need(authority is not None,'actual approved input stage required')
 need(sys.platform=='linux'and platform.machine()in{'x86_64','amd64'},'actual Linux compiler preparation worker required')
 need(root.is_relative_to(Path(os.environ['RUNNER_TEMP']).resolve(strict=True))and not root.is_relative_to(repo),'owned runner-temp fixture worker only')
 need(root.is_absolute()and not root.exists()and root.parent.resolve()==root.parent,'fresh owned fixture root');root.mkdir(mode=0o700)
 evm=load_source(repo,'zig/integration/evm.py','paired_source_contract_compiler',authority);evm.HERE=root/'integration';evm.HERE.mkdir();evm.CACHE=root/'base';evm.CACHE.mkdir();base=evm.CONTRACTS.copy();outputs={};source_files={}
 for label in ['validator','scraper','relayer','public']:
  evm.CONTRACTS=base.copy();evm.CACHE=root/label;evm.CACHE.mkdir();namespace={'evm':evm,'ROOT':root,'__builtins__':__builtins__}
  if label in{'relayer','public'}:
   nodes=fixture_preset_nodes(repo,'relayer');exec(compile(ast.Module(body=nodes,type_ignores=[]),str(repo/'zig/integration/relayer_process.py'),'exec'),namespace)
   relayer=types.SimpleNamespace(compile_contracts=namespace['compile_contracts'])
   if label=='public':namespace['relayer_process']=relayer;exec(compile(ast.Module(body=fixture_preset_nodes(repo,'public'),type_ignores=[]),str(repo/'zig/integration/public_relay_process.py'),'exec'),namespace)
   namespace['compile_contracts']()
  else:exec(compile(ast.Module(body=fixture_preset_nodes(repo,label),type_ignores=[]),str(repo/'zig/bench'/ (label+'.py')),'exec'),namespace);evm.compile_contracts()
  # Actual unchanged compilers select the original cache path. Save each actual
  # manifest separately; only the matched validator/relayer defaults are mapped.
  inputs=evm.compiler_inputs();cache=decode((evm.CACHE/'contracts.json').read_bytes());need(hashlib.sha256(json.dumps(inputs,sort_keys=True).encode()).hexdigest()==cache['input_digest'],'actual compiler input Source changed during compile')
  for row in fixture_source_records(inputs,repo):
   need(row['path']not in source_files or source_files[row['path']]==row,'fixture Source changed between presets');source_files[row['path']]=row
  target=root/(label+'.contracts.json');copy_owned(evm.CACHE/'contracts.json',target,pin(evm.CACHE/'contracts.json'),lambda:None,0o644);outputs[label]=pin(target)
 write(root/'compilation-receipt.json',{'schema':1,'actual_original_compiler_inputs_and_digest':True,'no_benchmark_module_import':True,'presets':outputs,'repository_source_files':list(source_files.values()),'source':{n:authority['source'][n]for n in CODE if n in{'zig/integration/evm.py','zig/integration/relayer_process.py','zig/integration/public_relay_process.py','zig/bench/validator.py','zig/bench/scraper.py'}},'native_or_timing_acceptance':False})
 source_authority_recheck(authority);source_cache_guard(repo)
 return outputs

def stage_fixture_inputs(prep,plain,repo,root,request_path,request_sha,published):
 worker=root/'fixture-stage';prep.run('original-fixture-compilation',[sys.executable,'-I','-B',repo/'zig/bench/paired_linux_inputs.py','--stage-fixtures','--request',request_path,'--request-sha256',request_sha,'--repo',repo,'--output',worker],plain)
 mappings=[]
 for source in sorted((worker/'integration/.deps').rglob('*')):
  need(not source.is_symlink(),'published OpenZeppelin dependency link refused')
  if not source.is_file():continue
  name='zig/integration/.deps/'+str(source.relative_to(worker/'integration/.deps'));dest=published/'repository'/name;copy_owned(source,dest,pin(source),prep.guard,0o644);mappings.append({'repository_path':name,'file':relative_pin(dest,published)})
 need(mappings and len(mappings)<=25000,'closed dependency-data member count')
 for label,destination in [('validator','zig/integration/.cache/whole-validator/contracts.json'),('relayer','zig/integration/.cache/relayer-contracts/contracts.json')]:
  source=worker/(label+'.contracts.json');dest=published/'repository'/destination;copy_owned(source,dest,pin(source),prep.guard,0o644);mappings.append({'repository_path':destination,'file':relative_pin(dest,published)})
 for source in [worker/'compilation-receipt.json',worker/'public.contracts.json',worker/'scraper.contracts.json']:
  copy_owned(source,published/'fixture-provenance'/source.name,pin(source),prep.guard,0o644)
 receipt=decode((worker/'compilation-receipt.json').read_bytes());sources=receipt['repository_source_files']
 for row in sources:checked(row,repo)
 return mappings,sources

def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--request',type=Path,required=True);parser.add_argument('--request-sha256',required=True);parser.add_argument('--repo',type=Path,required=True);parser.add_argument('--output',type=Path,required=True);parser.add_argument('--gh',type=Path);parser.add_argument('--stage-fixtures',action='store_true');args=parser.parse_args()
 if args.stage_fixtures:fixture_worker(args.request,args.request_sha256,args.repo,args.output)
 else:
  value=producer_main(args.request,args.request_sha256,args.repo,args.output,os.environ,args.gh)
  if value.get('enabled')is False:print(json.dumps(value,sort_keys=True))

if __name__=='__main__':main()
