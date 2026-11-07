#!/usr/bin/env python3
"""Plan-only by default. Restore exact lock; execute only with approved budget."""
import argparse,gzip,hashlib,json,os,pathlib,platform,signal,subprocess,time
BASE=pathlib.Path(__file__).resolve().parent
ROOT=BASE.parents[2]
LOCK_SHA256='8c2a54c41c5a69abf21b96313fae4667'+'8ca62bf55bb7f6dd56efd4557036524d'
FLOOR=6*1024**3

def restore():
 with gzip.open(BASE/'Cargo.lock.gz','rb')as stream:wire=stream.read(1024*1024+1)
 if len(wire)>1024*1024 or hashlib.sha256(wire).hexdigest()!=LOCK_SHA256:raise ValueError('Pinned lock mismatch')
 target=BASE/'Cargo.lock'
 if target.is_symlink():raise ValueError('Raw lock cannot be a symlink')
 if target.exists():
  if target.read_bytes()!=wire:raise ValueError('Raw lock differs from pinned lock')
 else:
  with target.open('xb')as stream:stream.write(wire)
 return target

def plan(args):
 target=args.target_dir.resolve()
 if args.target_dir.is_symlink()or not target.is_relative_to(pathlib.Path('/tmp').resolve())or not target.name.startswith('ziggy-native-row-reader-target'):raise ValueError('Reader target must be its approved task-local /tmp namespace')
 env={'CARGO_TARGET_DIR':str(target),'CARGO_BUILD_JOBS':str(args.jobs),'CARGO_INCREMENTAL':'0','CARGO_TERM_COLOR':'never'}
 pins=[]
 if args.rocksdb_lib_dir:
  native=args.rocksdb_lib_dir.resolve()
  archives=[native/name for name in ['librocksdb.a','libsnappy.a','liblz4.a','libzstd.a','libz.a','libbz2.a']]
  if any(not p.is_file()or p.is_symlink()for p in archives):raise ValueError('Existing pinned native archives required')
  pins=[{'path':str(p),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}for p in archives]
  env.update(ROCKSDB_LIB_DIR=str(native),ROCKSDB_STATIC='1')
  env.update(SNAPPY_LIB_DIR=str(native),SNAPPY_STATIC='1',SNAPPY_COMPILE='0',ROCKSDB_COMPILE='0')
  if args.rocksdb_include_dir is None:raise ValueError('Exact matching RocksDB include path required')
  include=args.rocksdb_include_dir.resolve()
  if not (include/'rocksdb/c.h').is_file():raise ValueError('Missing pinned RocksDB C header')
  env['ROCKSDB_INCLUDE_DIR']=str(include)
 if platform.system()=='Darwin':
  if args.sdk_root is None or not args.sdk_root.is_dir():raise ValueError('Explicit SDK root required on Darwin')
  env.update(SDKROOT=str(args.sdk_root.resolve()),MACOSX_DEPLOYMENT_TARGET='11.0',RUSTFLAGS='-l dylib=c++',BINDGEN_EXTRA_CLANG_ARGS='-isysroot '+str(args.sdk_root.resolve()))
 env.update(CARGO_PROFILE_DEV_DEBUG='0',CARGO_PROFILE_TEST_DEBUG='0',CARGO_PROFILE_RELEASE_DEBUG='0',RUSTC_WRAPPER='',RUSTC_WORKSPACE_WRAPPER='',CARGO_BUILD_RUSTC_WRAPPER='',CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER='',CCACHE_DISABLE='1',SCCACHE_DISABLE='1')
 command=['cargo','+'+args.toolchain,'test'if args.test else'build','--locked','--offline','--manifest-path',str(BASE/'Cargo.toml'),'--target-dir',str(target),'-j',str(args.jobs)]
 if not args.test:command.append('--release')
 return {'execute':args.execute,'command':command,'explicit_environment':env,'native_archives':pins,'target':str(target),'minimum_free_bytes':FLOOR,'target_budget_bytes':2*1024**3,'lock_normalized_offline':True,'compile_and_link_not_validated':True,'scope':'new independent reader only; old oracle and production Rust agents untouched'}

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--toolchain',default='1.98.0');p.add_argument('--target-dir',type=pathlib.Path,default=pathlib.Path('/tmp/ziggy-native-row-reader-target-20261106'));p.add_argument('--rocksdb-lib-dir',type=pathlib.Path);p.add_argument('--rocksdb-include-dir',type=pathlib.Path);p.add_argument('--sdk-root',type=pathlib.Path);p.add_argument('--jobs',type=int,default=2);p.add_argument('--test',action='store_true');p.add_argument('--restore-only',action='store_true');p.add_argument('--execute',action='store_true');args=p.parse_args()
 if not 1<=args.jobs<=4:raise ValueError('jobs must be1..4')
 if args.restore_only:restore();return
 value=plan(args)
 if not args.execute:print(json.dumps(value,indent=2));return
 # Root must approve this exact graph/target/native archive pins first. No shell,
 # shared cache cleaning, network downloads or automatic lock updates.
 import shutil
 args.target_dir.mkdir(parents=True,exist_ok=True)
 if shutil.disk_usage(args.target_dir).free<FLOOR:raise RuntimeError('Below6GiB stop floor; no Cargo started')
 restore();env={**os.environ,**value['explicit_environment']};env.pop('CARGO_ENCODED_RUSTFLAGS',None)
 process=subprocess.Popen(value['command'],cwd=ROOT,env=env,start_new_session=True)
 try:
  while process.poll()is None:
   if shutil.disk_usage(args.target_dir).free<FLOOR:raise RuntimeError('6GiB floor reached')
   size=subprocess.run(['du','-sk',str(args.target_dir)],capture_output=True,text=True,check=True)
   if int(size.stdout.split()[0])*1024>2*1024**3:raise RuntimeError('2GiB target budget reached')
   time.sleep(.2)
  if process.returncode:raise SystemExit(process.returncode)
 finally:
  if process.poll()is None:
   os.killpg(process.pid,signal.SIGTERM)
   try:process.wait(timeout=10)
   except subprocess.TimeoutExpired:os.killpg(process.pid,signal.SIGKILL);process.wait()
  for pin in value['native_archives']:
   if hashlib.sha256(pathlib.Path(pin['path']).read_bytes()).hexdigest()!=pin['sha256']:raise RuntimeError('Preserved native archive changed')
if __name__=='__main__':main()
