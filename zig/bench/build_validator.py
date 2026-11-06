#!/usr/bin/env python3
"""Build separately named actual validator daemons; no project build edits."""
import inventory
import argparse,hashlib,json,os,pathlib,re,subprocess,time
ROOT=pathlib.Path(__file__).resolve().parents[2]
def digest(path):
 value=hashlib.sha256(path.read_bytes()).hexdigest();return[value[:32],value[32:]]
def source_inventory():
 excluded={'target','.zig-cache','zig-out','__pycache__','.cache','.git'}
 paths=[pathlib.Path(__file__).resolve(),ROOT/'zig/bench/service_options.zig']
 for directory,children,files in os.walk(ROOT/'zig/src'):
  children[:]=sorted(name for name in children if not inventory.pruned(name))
  paths.extend(pathlib.Path(directory)/name for name in sorted(files)if pathlib.Path(name).suffix in {'.zig','.json','.jsonl','.gz','.txt','.toml'} and not (pathlib.Path(name).suffix != '.gz' and pathlib.Path(str(pathlib.Path(directory)/name)+'.gz').exists()))
 return{str(path.relative_to(ROOT)):digest(path)for path in paths}
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--zig',required=True);p.add_argument('--sdk-root');p.add_argument('--native-db-libs-file',type=pathlib.Path,required=True);p.add_argument('--mode',choices=['ReleaseSafe','ReleaseFast','both'],default='both');p.add_argument('--output',type=pathlib.Path,default=ROOT/'zig/bench/results/validator-builds');args=p.parse_args();args.output.mkdir(parents=True,exist_ok=True)
 libraries=[str(pathlib.Path(line.strip()).resolve())for line in re.split(r'[,\n]+',args.native_db_libs_file.read_text())if line.strip()];modes=['ReleaseSafe','ReleaseFast']if args.mode=='both'else[args.mode];results=[]
 for mode in modes:
  binary=ROOT/'zig/zig-out/bin'/('validator-'+mode.lower());binary.parent.mkdir(parents=True,exist_ok=True);command=[args.zig,'build-exe',*libraries,'-O',mode,'--dep','service_options','-Mroot=zig/src/service_main.zig','-Mservice_options=zig/bench/service_options.zig','-lc','-lc++',f'-femit-bin={binary}']
  if args.sdk_root:command+=['--sysroot',args.sdk_root,'-L/usr/lib']
  before=source_inventory();(args.output/(mode+'-source-before.json')).write_text(json.dumps(before,indent=2)+'\n')
  start=time.monotonic()
  with(args.output/(mode+'.log')).open('w')as log:completed=subprocess.run(command,cwd=ROOT,stdout=log,stderr=log)
  elapsed=time.monotonic()-start;after=source_inventory();(args.output/(mode+'-source-after.json')).write_text(json.dumps(after,indent=2)+'\n')
  results.append({'mode':mode,'command':command,'elapsed_seconds':elapsed,'source_unchanged_during_build':before==after,'source_before':mode+'-source-before.json','source_after':mode+'-source-after.json','cache_state':'normal shared compiler cache; not cold','exit_code':completed.returncode,'binary':str(binary.relative_to(ROOT))if completed.returncode==0 else None,'bytes':binary.stat().st_size if completed.returncode==0 else None,'sha256_chunks':digest(binary)if completed.returncode==0 else None})
  (args.output/'builds.json').write_text(json.dumps({'compiler_version':subprocess.check_output([args.zig,'version'],text=True).strip(),'native_db_libraries':[{'path':v,'bytes':pathlib.Path(v).stat().st_size,'sha256_chunks':digest(pathlib.Path(v))}for v in libraries],'builds':results},indent=2)+'\n')
  if completed.returncode:raise SystemExit(completed.returncode)
if __name__=='__main__':main()
