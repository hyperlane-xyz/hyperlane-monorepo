#!/usr/bin/env python3
"""Plan/run isolated three-agent compiler-cold and no-change incremental builds.

Default only writes a plan. Run --execute during a coordinated compiler-idle
window. It never cleans the production target/global caches or edits sources.
Native prerequisite phases are explicit; prebuilt-SDK Zig compile timing is not
compared to Rust's dependency-inclusive cold build as a whole-build speedup.
"""
import argparse,datetime,hashlib,json,os,pathlib,platform,shutil,signal,subprocess,time
import inventory
import cache_reclaim
ROOT=inventory.ROOT

def chunk(text):return[text[i:i+32]for i in range(0,len(text),32)]
def identity():
 h=hashlib.sha256()
 for base in[ROOT/'zig',ROOT/'rust/main',ROOT/'rust/sealevel']:
  for directory,children,files in os.walk(base):
   relative=pathlib.Path(directory).relative_to(ROOT)
   if relative.parts[:3]==('zig','bench','results'):children[:]=[];continue
   children[:]=sorted(v for v in children if not inventory.pruned(v))
   for name in sorted(files):
    path=pathlib.Path(directory)/name
    if path.is_symlink()or(path.suffix != '.gz' and pathlib.Path(str(path)+'.gz').exists())or(path.suffix not in inventory.SOURCE|inventory.DATA and name!='Dockerfile'):continue
    h.update(str(path.relative_to(ROOT)).encode()+b'\0'+''.join(inventory.digest(path)).encode()+b'\n')
 return chunk(h.hexdigest())
def run_phase(phase,base_env,output):
 before=identity();log=output/(phase['name']+'.log');env=dict(base_env);env.update(phase['environment']);start=time.monotonic();load_before=os.getloadavg();free_before=shutil.disk_usage(output).free
 tree_peak=0;samples=0;disk_guard=False
 with log.open('w')as stream:
  process=subprocess.Popen(phase['command'],cwd=phase['cwd'],env=env,stdout=stream,stderr=subprocess.STDOUT,start_new_session=True)
  while True:
   pid,status,usage=os.wait4(process.pid,os.WNOHANG)
   if pid:process.returncode=os.waitstatus_to_exitcode(status);break
   memory=subprocess.run(['ps','-Ao','pid=,ppid=,rss='],capture_output=True,text=True)
   if memory.returncode==0:
    records=[tuple(map(int,line.split()))for line in memory.stdout.splitlines()if len(line.split())==3]
    descendants={process.pid};previous=-1
    while len(descendants)!=previous:
     previous=len(descendants)
     descendants.update(pid for pid,parent,_ in records if parent in descendants)
    tree_peak=max(tree_peak,sum(rss*1024 for pid,_,rss in records if pid in descendants));samples+=1
   if not disk_guard and shutil.disk_usage(output).free<2*1024**3:
    disk_guard=True
    try:os.killpg(process.pid,signal.SIGTERM)
    except ProcessLookupError:pass
   time.sleep(.2)
 elapsed=time.monotonic()-start;after=identity();rss=usage.ru_maxrss if platform.system()=='Darwin'else usage.ru_maxrss*1024
 row={**phase,'exit_code':process.returncode,'wall_seconds':elapsed,'cpu_user_seconds':usage.ru_utime,'cpu_system_seconds':usage.ru_stime,'maximum_child_RSS_bytes':rss,'sampled_process_tree_RSS_peak_bytes':tree_peak,'RSS_samples':samples,'RSS_sample_interval_ms':200,'disk_guard_triggered':disk_guard,'source_before_sha256_chunks':before,'source_after_sha256_chunks':after,'source_unchanged':before==after,'load_before':load_before,'load_after':os.getloadavg(),'free_disk_bytes_before':free_before,'free_disk_bytes_after':shutil.disk_usage(output).free,'log':log.name,'artifacts':[]}
 for artifact in phase.get('artifacts',[]):
  path=pathlib.Path(artifact)
  if path.exists():row['artifacts'].append({'path':str(path),'bytes':path.stat().st_size,'sha256_chunks':inventory.digest(path)})
 return row

def cache_group(phase):
 name=phase['name']
 if name=='native-sdk-cold':return 'native'
 if name.startswith('optional-'):return name.removeprefix('optional-').removesuffix('-cold')
 if name.startswith('rust-'):return 'rust'
 if name.startswith('zig-'):return 'zig-'+name.split('-')[1]
 raise ValueError('Unknown cache phase '+name)

def disk_model(phases,reclaim):
 # Conservative planning estimates, not measured build outcomes. Actual disk
 # samples and the2GiB runtime guard remain authoritative and preserve failures.
 peak={'native':2,'regex':1,'starknet':4,'aleo-crypto':4,'aleo-vm':8,'rust':28,'zig-ReleaseSafe':6,'zig-ReleaseFast':6}
 runtime={'native':.2,'regex':.05,'starknet':.1,'aleo-crypto':.1,'aleo-vm':.5,'rust':1,'zig-ReleaseSafe':.15,'zig-ReleaseFast':.15}
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
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--compiler',required=True);p.add_argument('--sdk-root',type=pathlib.Path);p.add_argument('--native-db-libs-file',type=pathlib.Path,required=True);p.add_argument('--libpq-library',type=pathlib.Path,required=True);p.add_argument('--toolchain',default='1.98.0');p.add_argument('--jobs',type=int,default=2);p.add_argument('--cpu',choices=['native','production-default'],default='native');p.add_argument('--rust-features',default='');p.add_argument('--native-cold',action='store_true');p.add_argument('--optional-native-sdks',action='store_true');p.add_argument('--execute',action='store_true');p.add_argument('--reclaim-phase-caches',action='store_true',help='Outside timers, preserve runtime artifacts and reclaim generated compiler outputs after their final paired phase');p.add_argument('--min-free-GiB',type=float,default=40);p.add_argument('--cache-root',type=pathlib.Path);p.add_argument('--output',type=pathlib.Path,default=ROOT/'zig/bench/results/build-matrix-plan');args=p.parse_args()
 if not 1<=args.jobs<=64:p.error('jobs must be1..64')
 output=args.output.resolve();output.mkdir(parents=True,exist_ok=True);cache=(args.cache_root or ROOT/'zig/bench/.cache'/('build-matrix-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))).resolve();libraries=[str(pathlib.Path(v.strip()).resolve())for v in args.native_db_libs_file.read_text().replace('\n',',').split(',')if v.strip()]
 if len(libraries)!=7:p.error('seven production RocksDB/compression/ABI archives required')
 setup=[['python3',str(ROOT/'zig/tools/fixture_pack.py'),'restore-locks']]
 if args.native_cold:setup.append(['python3',str(ROOT/'zig/tools/native_deps.py'),'--restore-only'])
 if args.optional_native_sdks:
  setup.extend([['python3',str(ROOT/path),'--restore-only']for path in ['zig/src/starknet/testing/locked.py','zig/src/aleo/testing/locked.py','zig/src/ops/tools/locked.py']])
 phases=[];cargo=['cargo',f'+{args.toolchain}','build','--locked','--offline','--release'];rust_flags='--cfg tokio_unstable'+(' -Ctarget-cpu=native'if args.cpu=='native'else'');base_env=dict(os.environ)
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
 compiler_cache_policy={'rust_wrappers_explicitly_empty':True,'ccache_disable':'1','sccache_disable':'1','inherited_cache_controls':inherited_cache_controls,'compiler_environment_signatures':opaque_compilers,'explicit_cache_wrapper_compiler_keys':cache_wrapped_compilers,'no_user_cache_deleted':True}
 def add(name,command,cwd,environment,kind,artifacts=()):phases.append({'name':name,'command':[str(v)for v in command],'cwd':str(cwd),'environment':environment,'cache_state':kind,'artifacts':[str(v)for v in artifacts]})
 if args.native_cold:
  native_output=cache/'native-sdk';command=['python3',ROOT/'zig/tools/native_deps.py','--offline','--target-dir',cache/'native-target','--output',native_output,'--jobs',args.jobs,'--toolchain',args.toolchain,'--format','libs']
  if args.sdk_root:command+=['--sdk-root',args.sdk_root]
  add('native-sdk-cold',command,ROOT,{},'fresh standalone native dependency target; downloads excluded', [native_output/'librocksdb.a',native_output/'libziggy_rocks_abi.a'])
  libraries=[str(native_output/v)for v in['libziggy_rocks_abi.a','librocksdb.a','libsnappy.a','liblz4.a','libzstd.a','libz.a','libbz2.a']]
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
  if args.cpu=='native':command+=['-Dcpu=native']
  binaries=[prefix/'bin'/role for role in['relayer','validator','scraper']]
  if args.optional_native_sdks:command+=['aleo-vm-worker'];binaries.append(prefix/'bin/hyperlane-aleo-vm-worker')
  add('zig-'+mode+'-three-agent-cold',command,ROOT/'zig',{},'fresh local+global compiler cache; native SDKs '+('built in separately measured prerequisite phases'if args.native_cold else'PREBUILT/REUSED: compiler-only cold, not dependency-inclusive cold'),binaries)
  add('zig-'+mode+'-three-agent-no-change',command,ROOT/'zig',{},'same isolated compiler cache; no source changes, no-change incremental',binaries)
 model=disk_model(phases,args.reclaim_phase_caches);required_free=max(args.min_free_GiB,model['required_estimated_GiB'])
 plan={'scope':'All three actual agent executables; native dependency and optional Rust FFI phases explicit. Correctness/feature parity required separately. No execution by default.','captured_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'cache_root':str(cache),'jobs':args.jobs,'cpu_policy':args.cpu,'sdk_root':str(args.sdk_root.resolve())if args.sdk_root else None,'rust_features':args.rust_features or'default (Aleo optional feature disabled)','removed_environment_key_names':removed,'minimum_free_disk_GiB':args.min_free_GiB,'required_free_disk_GiB':required_free,'disk_model':model,'reclaim_phase_caches':args.reclaim_phase_caches,'compiler_cache_policy':compiler_cache_policy,'free_disk_bytes':shutil.disk_usage(output).free,'native_cold':args.native_cold,'optional_sdk_cold':args.optional_native_sdks,'setup_commands_before_measurement':setup,'phases':phases,'methodology':['Cold means fresh compiler/target caches, with already-downloaded source/toolchains. SDK and registry network downloads are excluded.','No-change incremental is labeled explicitly; no source-edit incremental claim.','Native Rust SDK/proving/regex dependencies are included when selected. No zero-dependency claim.','wait4 maximum-child RSS and sampled200ms aggregate process-tree RSS are separate; summed RSS double-counts shared pages and may miss shorter peaks. Binaries/bundle/disk sizes reported separately.','Run only in coordinated team compiler-idle window; capture shared-host load and preserve every row/failure.','Optional all-eight build uses Rust features relayer/aleo,validator/aleo,scraper/aleo plus --optional-native-sdks and --native-cold. Runtime Aleo parameters/proving not a compile-time operation.']}
 (output/'plan.json').write_text(json.dumps(plan,indent=2)+'\n')
 if not args.execute:print(json.dumps({'executed':False,'plan':str(output/'plan.json'),'phases':len(phases),'free_GiB':plan['free_disk_bytes']/1024**3}));return
 if cache.exists()and any(cache.iterdir()):raise SystemExit('Cold cache root already contains files; choose a fresh task-owned directory (nothing deleted).')
 if plan['free_disk_bytes']<required_free*1024**3:
  (output/'blocked.json').write_text(json.dumps({'executed':False,'reason':'insufficient free disk for isolated cold targets; production/shared caches preserved','free_bytes':plan['free_disk_bytes'],'required_GiB':required_free},indent=2)+'\n');raise SystemExit('Insufficient free disk; no builds started.')
 if cache_wrapped_compilers:raise SystemExit('Explicit C/C++ cache wrapper configured; select an uncached compiler before claiming compiler-cache-cold: '+','.join(cache_wrapped_compilers))
 for index,command in enumerate(setup):
  with(output/f'setup-{index}.log').open('w')as log:subprocess.run(command,cwd=ROOT,env=base_env,stdout=log,stderr=subprocess.STDOUT,check=True)
 cache_reclaim.mark(cache);rows=[];reclamations=[]
 for index,phase in enumerate(phases):
  row=run_phase(phase,base_env,output);rows.append(row);(output/'results.json').write_text(json.dumps({'plan':'plan.json','results':rows,'reclamations':reclamations},indent=2)+'\n')
  print(json.dumps({'phase':phase['name'],'exit_code':row['exit_code'],'wall_seconds':row['wall_seconds'],'source_unchanged':row['source_unchanged']}),flush=True)
  if row['exit_code']!=0:raise SystemExit(row['exit_code'])
  if args.reclaim_phase_caches:
   try:event=reclaim_phase(cache,phase,phases,index)
   except Exception as error:
    (output/'reclamation-failure.json').write_text(json.dumps({'after_phase':phase['name'],'error_type':type(error).__name__,'message_chunks':chunk(str(error)),'outside_measured_intervals':True},indent=2)+'\n');raise
   if event is not None:
    event['after_phase']=phase['name'];reclamations.append(event)
    (output/'results.json').write_text(json.dumps({'plan':'plan.json','results':rows,'reclamations':reclamations},indent=2)+'\n')
    print(json.dumps({'reclaimed_after':phase['name'],'free_GiB':event['free_disk_bytes_after']/1024**3,'all_artifacts_preserved':event['all_preserved_hashes_identical']}),flush=True)
if __name__=='__main__':main()
