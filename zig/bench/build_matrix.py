#!/usr/bin/env python3
"""Plan/run isolated three-agent compiler-cold and no-change incremental builds.

Default only writes a plan. Run --execute during a coordinated compiler-idle
window. It never cleans the production target/global caches or edits sources.
Native prerequisite phases are explicit; prebuilt-SDK Zig compile timing is not
compared to Rust's dependency-inclusive cold build as a whole-build speedup.
"""
import argparse,datetime,hashlib,json,os,pathlib,platform,re,select,shutil,signal,subprocess,time
import inventory
import importlib.util
import cache_reclaim
import cold_matrix_owner as ownership
ROOT=inventory.ROOT

def cpu_module():
 spec=importlib.util.spec_from_file_location('cold_matrix_build_cpu',ROOT/'zig/tools/build_cpu.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

def cpu_configuration(policy,environ,cpu):
 if policy=='x86_64_v3_pclmul_native_abi':
  if platform.system()!='Linux'or platform.machine()not in{'x86_64','amd64'}:raise ValueError('Portable cold profile requires Linux x86_64')
  cpu.require_native_linux_host()
  return cpu.portable_environment(environ,tokio_unstable=True),cpu.zig_cpu_args('build')
 if policy not in{'native','production-default'}:raise ValueError('Unknown cold CPU profile')
 return dict(environ),['-Dcpu='+('native'if policy=='native'else'baseline')]

def chunk(text):return[text[i:i+32]for i in range(0,len(text),32)]
# Exact source-tree outputs owned by production build.rs -> utils/abigen.
# Tracked files (notably Starknet contracts/mod.rs) are never outputs here.
BINDING_OUTPUT_DIRS=(
 'rust/main/chains/hyperlane-ethereum/src/interfaces',
 'rust/main/chains/hyperlane-tron/src/interfaces',
 'rust/main/chains/hyperlane-starknet/src/contracts',
 'rust/main/ethers-prometheus/src/contracts',
)
def generated_binding_paths():
 tracked=set(subprocess.check_output(['git','ls-files','-z','--',*BINDING_OUTPUT_DIRS],cwd=ROOT).decode().split('\0'))
 candidates=[]
 for name in BINDING_OUTPUT_DIRS:
  directory=ROOT/name
  if directory.is_symlink():raise RuntimeError('Generated binding directory is a symlink: '+name)
  for path in directory.glob('*.rs'):
   if path.is_symlink():raise RuntimeError('Generated binding file is a symlink: '+str(path.relative_to(ROOT)))
   relative=str(path.relative_to(ROOT))
   if path.is_file()and relative not in tracked:candidates.append(relative)
 if not candidates:return set()
 checked=subprocess.run(['git','check-ignore','--stdin','-z'],cwd=ROOT,input=('\0'.join(candidates)+'\0').encode(),capture_output=True)
 if checked.returncode not in(0,1):raise RuntimeError('Cannot classify generated bindings')
 return {name for name in checked.stdout.decode().split('\0')if name}
def generated_binding_identity():
 h=hashlib.sha256()
 for name in sorted(generated_binding_paths()):h.update(name.encode()+b'\0'+''.join(inventory.digest(ROOT/name)).encode()+b'\n')
 return chunk(h.hexdigest())
def identity():
 h=hashlib.sha256();generated=generated_binding_paths()
 for base in[ROOT/'zig',ROOT/'rust/main',ROOT/'rust/sealevel']:
  for directory,children,files in os.walk(base):
   relative=pathlib.Path(directory).relative_to(ROOT)
   if relative.parts[:3]==('zig','bench','results'):children[:]=[];continue
   children[:]=sorted(v for v in children if not inventory.pruned(v))
   for name in sorted(files):
    path=pathlib.Path(directory)/name
    if str(path.relative_to(ROOT))in generated:continue
    if path.is_symlink()or(path.suffix not in inventory.SOURCE|inventory.DATA and name!='Dockerfile'):continue
    h.update(str(path.relative_to(ROOT)).encode()+b'\0'+''.join(inventory.digest(path)).encode()+b'\n')
 return chunk(h.hexdigest())
def remember_terminal_children(owned,direct_pid,witnesses,elapsed):
 # Caller has just proved with waitid(WNOWAIT) that the direct parent has NOT
 # completed after this measured snapshot. Cleanup never calls this function.
 for pid,row in owned.items():
  if pid!=direct_pid and row['state']=='Z':
   witnesses.setdefault((pid,row['start']),{**row,'observed_elapsed_seconds':elapsed,'parent_running_probe':'waitid_no_exit_after_snapshot'})

def phase_accounting(usage,cleanup,known,witnesses,elapsed):
 direct=None if usage is None else ownership.rusage_record(usage)
 reasons=[];accepted=[]
 if not cleanup or not cleanup.get('clean')or cleanup.get('owned_present_before_stop'):reasons.append('cleanup failed or descendants present at cleanup')
 expected={(row['pid'],row['start'])for row in known.values()if row.get('observed_as_adopted_child')}
 waits=[]if not cleanup else cleanup.get('actual_adopted_child_waits',[])
 identities=[(row['pid'],row['start'])for row in waits]
 if len(set(identities))!=len(identities)or set(identities)!=expected:reasons.append('adopted wait coverage/uniqueness differs')
 for receipt in waits:
  key=(receipt['pid'],receipt['start']);witness=witnesses.get(key)
  if not witness or witness.get('pid')!=receipt['pid']or witness.get('start')!=receipt['start']or witness.get('state')!='Z'or witness.get('parent_running_probe')!='waitid_no_exit_after_snapshot'or not 0<=witness.get('observed_elapsed_seconds',-1)<=elapsed:
   reasons.append('adopted child not terminal before parent completion');continue
  try:
   status=receipt['status']
   if receipt.get('waited_pid')!=receipt['pid']or isinstance(status,bool)or not isinstance(status,int)or not(os.WIFEXITED(status)or os.WIFSIGNALED(status))or receipt.get('actual_wait4_usage_available')is not True:raise ValueError('adopted wait4 identity/status/usage unavailable')
   recorded=receipt['rusage'];checked=ownership.checked_rusage(recorded['raw'])
   if recorded!=checked:raise ValueError('adopted normalized usage differs from raw wait4')
  except (KeyError,TypeError,ValueError,OverflowError)as error:reasons.append(str(error));continue
  accepted.append({'pid':receipt['pid'],'start':receipt['start'],'status':status,'rusage':checked})
 quiescent=not reasons;complete=quiescent and direct is not None
 return {'phase_owned_quiescent':quiescent,'phase_quiescence_rejections':reasons,'terminal_descendants_before_parent_completion':list(witnesses.values()),'direct_wait4_rusage':direct,'adopted_wait4_rusage':accepted,'phase_rusage_complete':complete,'cpu_user_seconds':None if not complete else direct['cpu_user_seconds']+sum(row['rusage']['cpu_user_seconds']for row in accepted),'cpu_system_seconds':None if not complete else direct['cpu_system_seconds']+sum(row['rusage']['cpu_system_seconds']for row in accepted),'maximum_child_RSS_bytes':None if not complete else max([direct['maximum_child_RSS_bytes']]+[row['rusage']['maximum_child_RSS_bytes']for row in accepted]),'rusage_scope':'Actual direct wait4 includes descendants reaped by that parent; independently adopted terminal orphans are waited by this owner and added once. Maximum child RSS is max across those disjoint wait4 trees, not concurrent tree RSS. Rejected phases retain components without complete CPU/RSS credit.'}

def run_phase(phase,base_env,output,expected_source,runtime_floor_bytes,phase_timeout_seconds=7200):
 if platform.system()=='Linux':ownership.enable_subreaper()
 before=identity();bindings_before=generated_binding_identity()
 if before!=expected_source:raise RuntimeError('Source changed before phase '+phase['name'])
 if shutil.disk_usage(output).free<runtime_floor_bytes:raise RuntimeError('Runtime free-disk floor before phase')
 log=output/(phase['name']+'.log');env=dict(base_env);env.update(phase['environment'])
 start=time.monotonic();load_before=os.getloadavg();free_before=shutil.disk_usage(output).free
 tree_peak=0;samples=0;disk_guard=False;known={};groups={};terminal_before_parent={};process=None;usage=None;error=None;cleanup=None;pidfd=None;elapsed=None
 watched=[signal.SIGTERM,signal.SIGINT,signal.SIGHUP];previous={sig:signal.getsignal(sig)for sig in watched}
 def interrupted(sig,frame):raise ownership.TaskInterrupted('Phase received signal '+str(sig))
 for sig in watched:signal.signal(sig,interrupted)
 try:
  with log.open('w')as stream:
   old_mask=signal.pthread_sigmask(signal.SIG_BLOCK,watched)
   try:
    def unmask_child():signal.pthread_sigmask(signal.SIG_SETMASK,old_mask)
    process=subprocess.Popen(phase['command'],cwd=phase['cwd'],env=env,stdout=stream,stderr=subprocess.STDOUT,start_new_session=True,preexec_fn=unmask_child)
    groups[process.pid]=process.pid
   finally:signal.pthread_sigmask(signal.SIG_SETMASK,old_mask)
   poller=None
   if platform.system()=='Linux':
    pidfd=os.pidfd_open(process.pid,0);poller=select.poll();poller.register(pidfd,select.POLLIN)
   while True:
    pid,status,child_usage=os.wait4(process.pid,os.WNOHANG)
    if pid:
     process.returncode=os.waitstatus_to_exitcode(status);usage=child_usage;elapsed=time.monotonic()-start;break
    current=ownership.processes();owned=ownership.owned_processes(current,process.pid,known,groups,True)
    if platform.system()=='Linux':
     parent_exit=os.waitid(os.P_PID,process.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT)
     if parent_exit is None:remember_terminal_children(owned,process.pid,terminal_before_parent,time.monotonic()-start)
    tree_peak=max(tree_peak,sum(row['rss_bytes']for row in owned.values()));samples+=1
    if shutil.disk_usage(output).free<runtime_floor_bytes:
     disk_guard=True;raise RuntimeError('Phase runtime free-disk floor breached')
    if time.monotonic()-start>phase_timeout_seconds:raise RuntimeError('Phase deadline exceeded')
    if poller is not None:poller.poll(200)
    else:time.sleep(.01)
 except BaseException as failure:
  error={'type':type(failure).__name__,'message':str(failure)}
  if elapsed is None:elapsed=time.monotonic()-start
 finally:
  # Preserve elapsed before cleanup AND before subsequent Source/artifact hashes.
  if elapsed is None:elapsed=time.monotonic()-start
  for sig in watched:signal.signal(sig,signal.SIG_IGN)
  try:
   if process is not None:cleanup=ownership.stop_owned(process,known,groups)
  except BaseException as failure:
   cleanup={'clean':False,'error':{'type':type(failure).__name__,'message':str(failure)}}
  finally:
   if pidfd is not None:os.close(pidfd)
   for sig,handler in previous.items():signal.signal(sig,handler)
 after=identity();bindings_after=generated_binding_identity()
 accounting=phase_accounting(usage,cleanup,known,terminal_before_parent,elapsed)
 row={**phase,'exit_code':None if process is None else process.returncode,'wall_seconds':elapsed,'sampled_process_tree_RSS_peak_bytes':tree_peak,'RSS_samples':samples,'RSS_sample_interval_ms':200,'actual_wait4_usage_available':usage is not None,'exit_wait_method':'pidfd_poll'if platform.system()=='Linux'else'wait4_10ms_poll','disk_guard_triggered':disk_guard,'phase_error':error,'phase_cleanup':cleanup,'source_before_sha256_chunks':before,'source_after_sha256_chunks':after,'source_unchanged':before==after,'generated_bindings_before_sha256_chunks':bindings_before,'generated_bindings_after_sha256_chunks':bindings_after,'generated_bindings_unchanged':bindings_before==bindings_after,'load_before':load_before,'load_after':os.getloadavg(),'free_disk_bytes_before':free_before,'free_disk_bytes_after':shutil.disk_usage(output).free,'log':log.name,'artifacts':[]}
 row.update(accounting)
 if phase.get('CPU_recipe')is not None and process is not None and process.returncode==0 and error is None and accounting['phase_owned_quiescent']and accounting['phase_rusage_complete']and before==after:
  row['CPU_recipe']=cpu_module().finish_recipe(phase['CPU_recipe'],{'actual_parent_wait':usage is not None,'exit_code':process.returncode,'error':None},ROOT)
 for artifact in phase.get('artifacts',[]):
  path=pathlib.Path(artifact)
  if path.exists():row['artifacts'].append({'path':str(path),'bytes':path.stat().st_size,'sha256_chunks':inventory.digest(path)})
 if phase.get('CPU_manifest')is not None and process is not None and process.returncode==0 and error is None and before==after:
  manifest_path=pathlib.Path(phase['CPU_manifest'])
  if manifest_path.is_symlink()or not manifest_path.is_file()or manifest_path.stat().st_size>1024**2:raise ValueError('bounded regular native CPU manifest required')
  manifest=json.loads(manifest_path.read_text());contract=manifest['cpu_contract'];cpu=cpu_module();expected={pathlib.Path(r['path']).name:''.join(r['sha256_chunks'])for r in row['artifacts']}
  cpu.validate(contract,'native-deps','shared',phase['CPU_source_commit'],expected);cpu.require_same_profile([contract],require_portable=True)
  if any(contract['artifacts'][pathlib.Path(r['path']).name]['bytes']!=r['bytes']for r in row['artifacts']):raise ValueError('native CPU artifact size differs')
  cpu.validate_recipe_sources(contract,lambda relative:(ROOT/relative).read_bytes());row['CPU_manifest']={'path':str(manifest_path),'bytes':manifest_path.stat().st_size,'sha256_chunks':inventory.digest(manifest_path)}
 return row


def validate_phase(row,phase,expected_source):
 if row['exit_code']!=0:raise SystemExit(row['exit_code']or 1)
 if row.get('phase_error')or not row.get('phase_owned_quiescent',False):raise RuntimeError('Owned phase failed or left work running: '+phase['name'])
 if not row.get('phase_rusage_complete',False):raise RuntimeError('Complete disjoint wait4 usage unavailable: '+phase['name'])
 if not row['source_unchanged'] or row['source_after_sha256_chunks']!=expected_source:raise RuntimeError('Source changed during phase '+phase['name'])
 if phase['name']!='rust-three-agent-cold'and not row['generated_bindings_unchanged']:raise RuntimeError('Generated bindings changed outside Rust cold phase '+phase['name'])
 if row['disk_guard_triggered']:raise RuntimeError('Runtime disk floor breached during phase '+phase['name'])
 if len(row['artifacts'])!=len(phase.get('artifacts',[])):raise RuntimeError('Missing expected product after '+phase['name'])

def cache_group(phase):
 name=phase['name']
 if name=='native-sdk-cold':return 'native'
 if name=='url-cold':return 'url'
 if name.startswith('optional-'):return name.removeprefix('optional-').removesuffix('-cold')
 if name.startswith('rust-'):return 'rust'
 if name.startswith('zig-'):return 'zig-'+name.split('-')[1]
 raise ValueError('Unknown cache phase '+name)

def disk_model(phases,reclaim):
 # Conservative planning estimates, not measured build outcomes. Actual disk
 # samples and the6GiB runtime guard remain authoritative and preserve failures.
 peak={'native':2,'url':.5,'regex':1,'starknet':4,'aleo-crypto':4,'aleo-vm':8,'rust':28,'zig-ReleaseSafe':6,'zig-ReleaseFast':6}
 runtime={'native':.2,'url':.01,'regex':.05,'starknet':.1,'aleo-crypto':.1,'aleo-vm':.5,'rust':1,'zig-ReleaseSafe':.15,'zig-ReleaseFast':.15}
 held={};rows=[];maximum=0
 for i,phase in enumerate(phases):
  group=cache_group(phase);held[group]=peak[group];at_phase=sum(held.values());maximum=max(maximum,at_phase)
  final=not any(cache_group(later)==group for later in phases[i+1:])
  if reclaim and final:held[group]=runtime[group]
  rows.append({'phase':phase['name'],'cache_group':group,'estimated_peak_retained_GiB':at_phase,'estimated_after_phase_GiB':sum(held.values()),'reclaim_after_phase':reclaim and final})
 return {'estimate_not_measurement':True,'group_peak_GiB':peak,'group_retained_runtime_GiB':runtime,'phases':rows,'estimated_maximum_retained_GiB':maximum,'additional_headroom_GiB':8,'required_estimated_GiB':maximum+8,'qualification':'Source/toolchain/download caches already exist and are excluded. Estimates are conservative budgets based on observed task targets, not guaranteed maxima; actual samples and disk guard retained. No-cache-reclamation plan retains all prior target/compiler caches.'}

def reclaim_phase(cache,phase,all_phases,index):
 group=cache_group(phase)
 if any(cache_group(later)==group for later in all_phases[index+1:]):return None
 artifacts=[pathlib.Path(path)for path in phase.get('artifacts',[])]
 if group=='native':
  target=cache/'native-target';output=cache/'native-sdk'
  return cache_reclaim.reclaim(cache,target,artifacts,extra_preserve=[output])
 if group=='rust':return cache_reclaim.reclaim(cache,cache/'rust-target',artifacts)
 if group.startswith('zig-'):
  mode=group.removeprefix('zig-')
  return cache_reclaim.reclaim_zig(cache,[cache/('zig-local-'+mode),cache/('zig-global-'+mode)],artifacts)
 return cache_reclaim.reclaim(cache,cache/('sdk-'+group),artifacts)

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--compiler',required=True);p.add_argument('--sdk-root',type=pathlib.Path);p.add_argument('--native-db-libs-file',type=pathlib.Path,required=True);p.add_argument('--libpq-library',type=pathlib.Path,required=True);p.add_argument('--toolchain',default='1.98.0');p.add_argument('--jobs',type=int,default=2);p.add_argument('--cpu',choices=['native','production-default','x86_64_v3_pclmul_native_abi'],default='native');p.add_argument('--rust-features',default='');p.add_argument('--native-cold',action='store_true');p.add_argument('--optional-native-sdks',action='store_true');p.add_argument('--execute',action='store_true');p.add_argument('--reclaim-phase-caches',action='store_true',help='Outside timers, preserve runtime artifacts and reclaim generated compiler outputs after their final paired phase');p.add_argument('--min-free-GiB',type=float,default=40);p.add_argument('--runtime-free-GiB',type=float,default=6);p.add_argument('--git-sha');p.add_argument('--phase-timeout-seconds',type=float,default=7200);p.add_argument('--comparison-order',choices=['rust-safe-fast','fast-rust-safe','safe-fast-rust'],default='rust-safe-fast');p.add_argument('--cache-root',type=pathlib.Path);p.add_argument('--output',type=pathlib.Path,default=ROOT/'zig/bench/results/build-matrix-plan');args=p.parse_args()
 if not 1<=args.jobs<=64:p.error('jobs must be1..64')
 if not 0<args.phase_timeout_seconds<=14400:p.error('phase timeout must be0..14400 seconds')
 if not 0<args.runtime_free_GiB<=args.min_free_GiB:p.error('Runtime floor must be positive and no larger than initial floor')
 if args.git_sha is not None and re.fullmatch('[0-9a-f]{40}',args.git_sha) is None:p.error('git-sha must be exact lower-case 40hex')
 if args.cpu=='x86_64_v3_pclmul_native_abi'and args.git_sha is None:p.error('portable build requires actual procedure git-sha')
 output=args.output.resolve();output.mkdir(parents=True,exist_ok=True);cache=(args.cache_root or ROOT/'zig/bench/.cache'/('build-matrix-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))).resolve();libraries=[str(pathlib.Path(v.strip()).resolve())for v in args.native_db_libs_file.read_text().replace('\n',',').split(',')if v.strip()]
 if len(libraries)!=7:p.error('seven production RocksDB/compression/ABI archives required')
 setup=[['python3',str(ROOT/'zig/tools/fixture_pack.py'),'restore-locks']]
 if args.native_cold:setup.append(['python3',str(ROOT/'zig/tools/native_deps.py'),'--restore-only']+(['--cpu-profile','x86_64_v3_pclmul_native_abi','--git-sha',args.git_sha]if args.cpu=='x86_64_v3_pclmul_native_abi'else[]))
 # Validator startup always uses the reference URL normalizer, including core
 # images. Every dependency-inclusive or full-SDK trial measures it separately.
 url_cold=args.native_cold or args.optional_native_sdks
 if url_cold:setup.append(['python3',str(ROOT/'zig/src/net/native-url/locked.py'),'--restore-only'])
 if args.optional_native_sdks:
  setup.extend([['python3',str(ROOT/path),'--restore-only']for path in ['zig/src/starknet/testing/locked.py','zig/src/aleo/testing/locked.py','zig/src/ops/tools/locked.py']])
 cpu=cpu_module();phases=[];cargo=['cargo',f'+{args.toolchain}','build','--locked','--offline','--release'];rust_flags='--cfg tokio_unstable'+(' -Ctarget-cpu=native'if args.cpu=='native'else'');base_env=dict(os.environ)
 if args.sdk_root:base_env.update(SDKROOT=str(args.sdk_root.resolve()),MACOSX_DEPLOYMENT_TARGET='11.0')
 cache_env_names={'RUSTC_WRAPPER','RUSTC_WORKSPACE_WRAPPER','CARGO_BUILD_RUSTC_WRAPPER','CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER','CCACHE_DIR','CCACHE_PREFIX','SCCACHE_DIR','SCCACHE_RUSTC_WRAPPER','CARGO_INCREMENTAL'}
 inherited_cache_controls={name:{'present':True,'value_sha256_chunks':chunk(hashlib.sha256(base_env[name].encode()).hexdigest())}for name in sorted(cache_env_names)if name in base_env}
 opaque_compilers={name:{'value_sha256_chunks':chunk(hashlib.sha256(base_env[name].encode()).hexdigest())}for name in ['CC','CXX','HOST_CC','HOST_CXX']if name in base_env}
 cache_wrapped_compilers=[name for name in ['CC','CXX','HOST_CC','HOST_CXX']if any(value in base_env.get(name,'').lower()for value in ['ccache','sccache'])]
 removed=[v for v in base_env if v in cache_env_names|{'RUSTFLAGS','CARGO_ENCODED_RUSTFLAGS','CARGO_TARGET_DIR','ZIG_GLOBAL_CACHE_DIR','ZIG_LOCAL_CACHE_DIR'}or v.startswith('CARGO_PROFILE_RELEASE_')]
 for name in removed:base_env.pop(name,None)
 # Cargo's empty RUSTC_*_WRAPPER explicitly disables configured wrappers too.
 # C/C++ cache tools are disabled; explicit compiler commands naming cache
 # wrappers reject execution rather than being mislabeled compiler-cache-cold.
 base_env.update(RUSTC_WRAPPER='',RUSTC_WORKSPACE_WRAPPER='',CARGO_BUILD_RUSTC_WRAPPER='',CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER='',CCACHE_DISABLE='1',SCCACHE_DISABLE='1')
 base_env,zig_cpu=cpu_configuration(args.cpu,base_env,cpu)
 if args.cpu=='x86_64_v3_pclmul_native_abi':rust_flags=base_env['RUSTFLAGS']
 compiler_cache_policy={'rust_wrappers_explicitly_empty':True,'ccache_disable':'1','sccache_disable':'1','inherited_cache_controls':inherited_cache_controls,'compiler_environment_signatures':opaque_compilers,'explicit_cache_wrapper_compiler_keys':cache_wrapped_compilers,'no_user_cache_deleted':True}
 def add(name,command,cwd,environment,kind,artifacts=()):
  actual=[str(v)for v in command];row={'name':name,'command':actual,'cwd':str(cwd),'environment':environment,'cache_state':kind,'artifacts':[str(v)for v in artifacts]}
  if args.cpu=='x86_64_v3_pclmul_native_abi'and name=='native-sdk-cold':row.update(CPU_manifest=str(native_output/'manifest.json'),CPU_source_commit=args.git_sha)
  if args.cpu=='x86_64_v3_pclmul_native_abi'and name!='native-sdk-cold':
   actual_env={**base_env,**environment};row['CPU_recipe']=cpu.recipe('zig-build'if name.startswith('zig-')else'rust',actual,actual_env,'zig/bench/build_matrix.py',ROOT)
  phases.append(row)
 if args.native_cold:
  native_output=cache/'native-sdk';command=['python3',ROOT/'zig/tools/native_deps.py','--offline','--target-dir',cache/'native-target','--output',native_output,'--jobs',args.jobs,'--toolchain',args.toolchain,'--format','libs']
  if args.sdk_root:command+=['--sdk-root',args.sdk_root]
  if args.cpu=='x86_64_v3_pclmul_native_abi':command+=['--cpu-profile','x86_64_v3_pclmul_native_abi','--git-sha',args.git_sha]
  add('native-sdk-cold',command,ROOT,{},'fresh standalone native dependency target; downloads excluded', [native_output/name for name in ['libziggy_rocks_abi.a','librocksdb.a','libsnappy.a','liblz4.a','libzstd.a','libz.a','libbz2.a']])
  libraries=[str(native_output/v)for v in['libziggy_rocks_abi.a','librocksdb.a','libsnappy.a','liblz4.a','libzstd.a','libz.a','libbz2.a']]
 if url_cold:
  target=cache/'sdk-url';library='libziggy_url'+('.dylib'if platform.system()=='Darwin'else'.so')
  add('url-cold',cargo+['--manifest-path',ROOT/'zig/src/net/native-url/Cargo.toml','--target-dir',target,'-j',args.jobs],ROOT,{'RUSTFLAGS':rust_flags},'fresh required Rust URL normalization target; downloaded source cache retained',[target/'release'/library])
 if args.optional_native_sdks:
  for name,manifest in [('regex','zig/src/ops/regex-native/Cargo.toml'),('starknet','zig/src/starknet/native-crypto/Cargo.toml'),('aleo-crypto','zig/src/aleo/native-crypto/Cargo.toml'),('aleo-vm','zig/src/aleo/native-vm/Cargo.toml')]:
   target=cache/('sdk-'+name);library='lib'+{'regex':'ziggy_regex','starknet':'ziggy_starknet_crypto','aleo-crypto':'ziggy_aleo_crypto','aleo-vm':'ziggy_aleo_vm'}[name]+('.dylib'if platform.system()=='Darwin'else'.so');add('optional-'+name+'-cold',cargo+['--manifest-path',ROOT/manifest,'--target-dir',target,'-j',args.jobs],ROOT,{'RUSTFLAGS':rust_flags},'fresh optional Rust SDK target; parameter downloads/runtime proving excluded',[target/'release'/library])
 rust_target=cache/'rust-target';rust=cargo+['-p','relayer','-p','validator','-p','scraper','--target-dir',rust_target,'-j',args.jobs]
 if args.rust_features:rust+=['--features',args.rust_features]
 binaries=[rust_target/'release'/role for role in ['relayer','validator','scraper']]
 add('rust-three-agent-cold',rust,ROOT/'rust/main',{'RUSTFLAGS':rust_flags},'fresh cargo target; default production release profiles + explicit recorded CPU flag; registry/git source caches retained',binaries)
 add('rust-three-agent-no-change',rust,ROOT/'rust/main',{'RUSTFLAGS':rust_flags},'same isolated target, no source changes, no-change incremental',binaries)
 for mode in['ReleaseSafe','ReleaseFast']:
  local=cache/('zig-local-'+mode);global_=cache/('zig-global-'+mode);prefix=cache/('zig-out-'+mode)
  command=['python3',ROOT/'zig/tools/zig.py','--compiler',args.compiler]
  if args.sdk_root:command+=['--sdk-root',args.sdk_root]
  command+=['build','validator','relayer','scraper','-Doptimize='+mode,'-Dnative-db-libs='+','.join(libraries),'-Dlibpq-library='+str(args.libpq_library.resolve()),'--cache-dir',local,'--global-cache-dir',global_,'--prefix',prefix,'-j'+str(args.jobs)]
  command+=zig_cpu
  if args.git_sha:command+=['-Dgit-sha='+args.git_sha]
  binaries=[prefix/'bin'/role for role in['relayer','validator','scraper']]
  if args.optional_native_sdks:command+=['aleo-vm-worker'];binaries.append(prefix/'bin/hyperlane-aleo-vm-worker')
  add('zig-'+mode+'-three-agent-cold',command,ROOT/'zig',{},'fresh local+global compiler cache; native SDKs '+('built in separately measured prerequisite phases'if args.native_cold else'PREBUILT/REUSED: compiler-only cold, not dependency-inclusive cold'),binaries)
  add('zig-'+mode+'-three-agent-no-change',command,ROOT/'zig',{},'same isolated compiler cache; no source changes, no-change incremental',binaries)
 prereqs=[phase for phase in phases if not phase['name'].startswith(('rust-','zig-'))]
 pairs={group:[phase for phase in phases if cache_group(phase)==group]for group in ['rust','zig-ReleaseSafe','zig-ReleaseFast']}
 orders={'rust-safe-fast':['rust','zig-ReleaseSafe','zig-ReleaseFast'],'fast-rust-safe':['zig-ReleaseFast','rust','zig-ReleaseSafe'],'safe-fast-rust':['zig-ReleaseSafe','zig-ReleaseFast','rust']}
 phases=prereqs+[phase for group in orders[args.comparison_order]for phase in pairs[group]]
 model=disk_model(phases,args.reclaim_phase_caches);required_free=max(args.min_free_GiB,model['required_estimated_GiB'])
 plan={'source_integrity_policy':'Hash packed and decoded input siblings; only ignored untracked direct Rust binding outputs in four production build.rs directories are separate measured outputs. Tracked binding modules remain immutable inputs. Generation stays inside Rust cold timing; outputs may change only in that phase and are frozen afterward.','comparison_order':args.comparison_order,'counterbalance_scope':'compiler cold/no-change pair positions only; prerequisites fixed first; no carryover or full dependency-block counterbalance claim','phase_timeout_seconds':args.phase_timeout_seconds,'runtime_free_disk_floor_GiB':args.runtime_free_GiB,'compiled_git_sha':args.git_sha,'scope':'All three actual agent executables; native dependency and optional Rust FFI phases explicit. Correctness/feature parity required separately. No execution by default.','captured_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'cache_root':str(cache),'jobs':args.jobs,'cpu_policy':args.cpu,'sdk_root':str(args.sdk_root.resolve())if args.sdk_root else None,'rust_features':args.rust_features or'default (Aleo optional feature disabled)','removed_environment_key_names':removed,'minimum_free_disk_GiB':args.min_free_GiB,'required_free_disk_GiB':required_free,'disk_model':model,'reclaim_phase_caches':args.reclaim_phase_caches,'compiler_cache_policy':compiler_cache_policy,'free_disk_bytes':shutil.disk_usage(output).free,'native_cold':args.native_cold,'optional_sdk_cold':args.optional_native_sdks,'required_url_cold':url_cold,'setup_commands_before_measurement':setup,'phases':phases,'methodology':['Cold means fresh compiler/target caches, with already-downloaded source/toolchains. SDK and registry network downloads are excluded.','No-change incremental is labeled explicitly; no source-edit incremental claim.','Required Rust URL normalization is measured whenever native-cold or optional-native-sdks is selected; the other four Rust SDK/proving/regex dependencies are measured with optional-native-sdks. Compiler-only phases reuse runtime dependencies. No zero-dependency claim.','wait4 maximum-child RSS and sampled200ms aggregate process-tree RSS are separate; summed RSS double-counts shared pages and may miss shorter peaks. Binaries/bundle/disk sizes reported separately.','Run only in coordinated team compiler-idle window; capture shared-host load and preserve every row/failure.','Full-feature build includes the required URL library and uses Rust features relayer/aleo,validator/aleo,scraper/aleo plus --optional-native-sdks and --native-cold. Runtime Aleo parameters/proving not a compile-time operation.']}
 (output/'plan.json').write_text(json.dumps(plan,indent=2)+'\n')
 if not args.execute:print(json.dumps({'executed':False,'plan':str(output/'plan.json'),'phases':len(phases),'free_GiB':plan['free_disk_bytes']/1024**3}));return
 if cache.exists()and any(cache.iterdir()):raise SystemExit('Cold cache root already contains files; choose a fresh task-owned directory (nothing deleted).')
 if plan['free_disk_bytes']<required_free*1024**3:
  (output/'blocked.json').write_text(json.dumps({'executed':False,'reason':'insufficient free disk for isolated cold targets; production/shared caches preserved','free_bytes':plan['free_disk_bytes'],'required_GiB':required_free},indent=2)+'\n');raise SystemExit('Insufficient free disk; no builds started.')
 if cache_wrapped_compilers:raise SystemExit('Explicit C/C++ cache wrapper configured; select an uncached compiler before claiming compiler-cache-cold: '+','.join(cache_wrapped_compilers))
 for index,command in enumerate(setup):
  with(output/f'setup-{index}.log').open('w')as log:subprocess.run(command,cwd=ROOT,env=base_env,stdout=log,stderr=subprocess.STDOUT,check=True)
 cache_reclaim.mark(cache);rows=[];reclamations=[];expected_source=identity();expected_bindings=generated_binding_identity()
 for index,phase in enumerate(phases):
  if generated_binding_identity()!=expected_bindings:raise RuntimeError('Generated bindings changed between phases before '+phase['name'])
  row=run_phase(phase,base_env,output,expected_source,int(args.runtime_free_GiB*1024**3),args.phase_timeout_seconds);rows.append(row);(output/'results.json').write_text(json.dumps({'plan':'plan.json','results':rows,'reclamations':reclamations},indent=2)+'\n')
  print(json.dumps({'phase':phase['name'],'exit_code':row['exit_code'],'wall_seconds':row['wall_seconds'],'source_unchanged':row['source_unchanged']}),flush=True)
  validate_phase(row,phase,expected_source)
  expected_bindings=row['generated_bindings_after_sha256_chunks']
  if args.reclaim_phase_caches:
   try:event=reclaim_phase(cache,phase,phases,index)
   except Exception as error:
    (output/'reclamation-failure.json').write_text(json.dumps({'after_phase':phase['name'],'error_type':type(error).__name__,'message_chunks':chunk(str(error)),'outside_measured_intervals':True},indent=2)+'\n');raise
   if event is not None:
    event['after_phase']=phase['name'];reclamations.append(event)
    (output/'results.json').write_text(json.dumps({'plan':'plan.json','results':rows,'reclamations':reclamations},indent=2)+'\n')
    print(json.dumps({'reclaimed_after':phase['name'],'free_GiB':event['free_disk_bytes_after']/1024**3,'all_artifacts_preserved':event['all_preserved_hashes_identical']}),flush=True)
if __name__=='__main__':main()
