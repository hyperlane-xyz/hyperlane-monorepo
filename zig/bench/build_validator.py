#!/usr/bin/env python3
"""Build separately named actual validator daemons; no project build edits."""
import inventory
import argparse,hashlib,json,os,pathlib,re,subprocess,sys,time
ROOT=pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'zig/integration'))
sys.path.insert(0,str(ROOT))
from zig.integration import validator as validator_fixture
def digest(path):
 value=hashlib.sha256(path.read_bytes()).hexdigest();return[value[:32],value[32:]]
def source_inventory():
 excluded={'target','.zig-cache','zig-out','__pycache__','.cache','.git'}
 paths=[pathlib.Path(__file__).resolve(),ROOT/'zig/bench/service_options.zig',ROOT/'zig/integration/validator.py']
 for directory,children,files in os.walk(ROOT/'zig/src'):
  children[:]=sorted(name for name in children if not inventory.pruned(name))
  paths.extend(pathlib.Path(directory)/name for name in sorted(files)if pathlib.Path(name).suffix in {'.zig','.json','.jsonl','.gz','.txt','.toml'} and not (pathlib.Path(name).suffix != '.gz' and pathlib.Path(str(pathlib.Path(directory)/name)+'.gz').exists()))
 return{str(path.relative_to(ROOT)):digest(path)for path in paths}
def compiled_git_sha(explicit):
 if explicit is None:
  try:explicit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True,stderr=subprocess.DEVNULL).strip()
  except (OSError,subprocess.CalledProcessError):explicit='VERGEN_IDEMPOTENT_OUTPUT'
 if explicit!='VERGEN_IDEMPOTENT_OUTPUT' and not re.fullmatch('[0-9a-fA-F]{40}',explicit):raise ValueError('git-sha must be exact40hex or VERGEN_IDEMPOTENT_OUTPUT')
 return explicit

def service_options(output, revision):
 path=output.resolve()/('service_options-'+revision+'.zig')
 wire=('pub const role = "validator";\npub const git_sha = "'+revision+'";\n').encode()
 if path.is_symlink():raise ValueError('Generated service options must not be a symlink')
 if path.exists():
  if path.read_bytes()!=wire:raise ValueError('Generated service options differ')
 else:
  with path.open('xb')as stream:stream.write(wire)
 return path

def build_command(args, libraries, mode, options, binary):
 command=[args.zig,'build-exe',*libraries,'-O',mode,'--dep','service_options','-Mroot=zig/src/service_main.zig','-Mservice_options='+str(options),'-lc','-lc++',f'-femit-bin={binary}']
 if args.sdk_root:command+=['--sysroot',args.sdk_root,'-L/usr/lib']
 return command

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--zig',required=True);p.add_argument('--sdk-root');p.add_argument('--git-sha');p.add_argument('--url-library',type=pathlib.Path,required=True);p.add_argument('--plan-only',action='store_true');p.add_argument('--native-db-libs-file',type=pathlib.Path,required=True);p.add_argument('--mode',choices=['ReleaseSafe','ReleaseFast','both'],default='both');p.add_argument('--output',type=pathlib.Path,default=ROOT/'zig/bench/results/validator-builds');args=p.parse_args();args.output.mkdir(parents=True,exist_ok=True)
 revision=compiled_git_sha(args.git_sha);options=service_options(args.output,revision);url_library=validator_fixture.url_dependency(args.url_library,ROOT/'zig/bench/.cache/validator-url')
 options_identity={'path':str(options),'bytes':options.stat().st_size,'sha256_chunks':digest(options)}
 libraries=[str(pathlib.Path(line.strip()).resolve())for line in re.split(r'[,\n]+',args.native_db_libs_file.read_text())if line.strip()];modes=['ReleaseSafe','ReleaseFast']if args.mode=='both'else[args.mode];results=[]
 for mode in modes:
  binary=ROOT/'zig/zig-out/bin'/('validator-'+mode.lower());binary.parent.mkdir(parents=True,exist_ok=True);command=build_command(args,libraries,mode,options,binary)
  if args.plan_only:
   results.append({'mode':mode,'command':command,'executed':False});continue
  before=source_inventory();(args.output/(mode+'-source-before.json')).write_text(json.dumps(before,indent=2)+'\n')
  start=time.monotonic()
  with(args.output/(mode+'.log')).open('w')as log:completed=subprocess.run(command,cwd=ROOT,stdout=log,stderr=log)
  elapsed=time.monotonic()-start
  if digest(options)!=options_identity['sha256_chunks']:raise ValueError('Compiled service options changed during build')
  after=source_inventory();(args.output/(mode+'-source-after.json')).write_text(json.dumps(after,indent=2)+'\n')
  results.append({'mode':mode,'command':command,'elapsed_seconds':elapsed,'source_unchanged_during_build':before==after,'source_before':mode+'-source-before.json','source_after':mode+'-source-after.json','cache_state':'normal shared compiler cache; not cold','exit_code':completed.returncode,'binary':str(binary.relative_to(ROOT))if completed.returncode==0 else None,'bytes':binary.stat().st_size if completed.returncode==0 else None,'sha256_chunks':digest(binary)if completed.returncode==0 else None})
  (args.output/'builds.json').write_text(json.dumps({'compiled_git_sha':revision,'service_options':options_identity,'url_library':url_library,'compiler_version':subprocess.check_output([args.zig,'version'],text=True).strip(),'native_db_libraries':[{'path':v,'bytes':pathlib.Path(v).stat().st_size,'sha256_chunks':digest(pathlib.Path(v))}for v in libraries],'builds':results},indent=2)+'\n')
  if completed.returncode:raise SystemExit(completed.returncode)
 if args.plan_only:(args.output/'plan.json').write_text(json.dumps({'executed':False,'compiled_git_sha':revision,'service_options':options_identity,'url_library':url_library,'builds':results},indent=2)+'\n')
if __name__=='__main__':main()
