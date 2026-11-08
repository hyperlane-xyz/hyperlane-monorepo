"""Explicit Linux-only paired method/input/functional gates. Inert false request."""
from pathlib import Path,PurePosixPath
import argparse,ast,copy,gzip,hashlib,importlib.util,json,math,os,platform,re,sys,time,zipfile

MODES=('ReleaseSafe','ReleaseFast');KINDS=('relayer_process','relayer_stream','public_relay_process')
BASELINE='c5202242cc6569da4a858ed7ddbb34170ab696aa'
ZIG={'relayer','validator','scraper','worker','aleoCrypto','aleoVm','starknetCrypto','regex','url'};RUST={'relayer','validator','scraper'};TOOLS={'init-db','ziggy-rocks-oracle','ziggy-native-rows','ziggy-rust-reference'}
ENV={'aleoCrypto':'HYPERLANE_ALEO_CRYPTO_LIBRARY','aleoVm':'HYPERLANE_ALEO_VM_LIBRARY','starknetCrypto':'HYPERLANE_STARKNET_CRYPTO_LIBRARY','regex':'HYPERLANE_REGEX_LIBRARY','url':'HYPERLANE_URL_LIBRARY','worker':'HYPERLANE_ALEO_VM_WORKER'}
SOURCE_PATHS={'zig/tools/foundry_official.py','zig/tools/foundry_official_test.py','zig/tools/foundry_public_good_root.json','.github/workflows/zig-agents.yml','.nvmrc','package.json','zig/reference/evm/Cargo.toml','zig/reference/evm/Cargo.lock.gz','zig/reference/evm/src/main.rs','zig/bench/paired_linux.py','zig/bench/paired_linux_stage.py','zig/bench/cohort_readback.py','zig/bench/paired_linux_owner.py','zig/bench/paired_linux_proofs.py','zig/bench/paired_linux_inputs.py','zig/bench/paired_linux_methods.json','zig/bench/validator.py','zig/bench/relayer.py','zig/bench/scraper.py','zig/bench/inventory.py','zig/bench/cold_matrix_owner.py','zig/integration/evm.py','zig/integration/validator.py','zig/integration/relayer_process.py','zig/integration/relayer_stream.py','zig/integration/tls_fixture.py','zig/integration/public_relay_process.py','zig/integration/faults/seal_crash.c','zig/integration/faults/seal_crash_test.c','zig/bench/native_case_ci.py','zig/bench/native_payload_export.py','zig/integration/native_case_inputs.py','zig/bench/native_case_tools.py','zig/bench/native_harness_census.py','zig/tools/build_cpu.py'}
FIELDS={'schema','kind','root_approved','inputs_enabled','functional_enabled','runtime_enabled','producer_source_commit','baseline_source_commit','baseline_profile','qualified_cohort','transport_requests','required_source','prepared_inputs','accepted_six','runtime_authority'}
class Refused(RuntimeError):pass

def need(value,message):
 if not value:raise Refused(message)
def sha(raw):return hashlib.sha256(raw).hexdigest()
def decode(raw,maximum=32*1024**2,maximum_nodes=300000):
 need(type(raw)is bytes and len(raw)<=maximum,'bounded metadata')
 def pairs(rows):
  out={}
  for k,v in rows:need(k not in out,'duplicate JSON key');out[k]=v
  return out
 value=json.loads(raw,object_pairs_hook=pairs,parse_constant=lambda v:(_ for _ in ()).throw(Refused('nonfinite JSON')));nodes=0
 def walk(v,d=0):
  nonlocal nodes
  nodes+=1;need(d<=32 and nodes<=maximum_nodes,'metadata structure')
  if isinstance(v,dict):
   if 'sha256_hex_chunks'in v:
    need(set(v)in ({'sha256_hex_chunks'},{'sha256_hex_chunks','prefix'}),'public digest fields');prefix=v.get('prefix','');need(isinstance(prefix,str)and (prefix==''or re.fullmatch(r'(?:[a-z0-9._/-]+@)?sha256:',prefix)),'public digest prefix');need(isinstance(v['sha256_hex_chunks'],list)and len(v['sha256_hex_chunks'])==2 and all(isinstance(x,str)and re.fullmatch('[0-9a-f]{32}',x)for x in v['sha256_hex_chunks']),'public digest encoding');return prefix+''.join(v['sha256_hex_chunks'])
   return{k:walk(x,d+1)for k,x in v.items()}
  if isinstance(v,list):return[walk(x,d+1)for x in v]
  if type(v)is float:need(math.isfinite(v),'nonfinite JSON')
  return v
 return walk(value)
def relative(text):
 need(isinstance(text,str)and text and str(PurePosixPath(text))==text and not text.startswith('/')and not any(c in text for c in ['\\','\0','\n','\r'])and '..'not in PurePosixPath(text).parts,'canonical relative path');return text
def pin(path):
 path=Path(path);need(path.is_file()and not path.is_symlink(),'regular file');before=path.stat()
 with path.open('rb')as stream:digest=hashlib.file_digest(stream,'sha256').hexdigest()
 after=path.stat();need((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns),'file changed');return {'path':str(path),'bytes':after.st_size,'sha256':digest}
def checked(row,root=None):
 need(isinstance(row,dict)and set(row)=={'path','bytes','sha256'}and type(row['bytes'])is int and 0<=row['bytes']<=2*1024**3 and isinstance(row['sha256'],str)and re.fullmatch('[0-9a-f]{64}',row['sha256']),'closed file descriptor')
 path=Path(row['path'])if root is None else Path(root)/relative(row['path']);need(path.is_absolute()and path.resolve()==path,'canonical owned input');actual=pin(path);need(actual['bytes']==row['bytes']and actual['sha256']==row['sha256'],'input bytes changed');return actual
def captured_source(path,authority,repo):
 row=next((r for r in authority['required_source']if r['path']==str(Path(path).relative_to(repo))),None);need(row is not None,'Source outside admitted closure');raw=Path(path).read_bytes();need(len(raw)==row['bytes']and sha(raw)==row['sha256'],'captured Source differs');return raw
def load_source(path,name,authority,repo):
 raw=captured_source(path,authority,repo);module=type(sys)(name);module.__file__=str(path);sys.modules[name]=module;exec(compile(raw,str(path),'exec'),module.__dict__);return module
def source_api(path,names,extra=None):
 raw=Path(path).read_bytes();tree=ast.parse(raw);nodes=[n for n in tree.body if isinstance(n,(ast.FunctionDef,ast.ClassDef))and n.name in names];need({n.name for n in nodes}==set(names),'exact existing pure Source API');ns={'Path':Path,'pathlib':__import__('pathlib'),'hashlib':hashlib,'json':json,'gzip':gzip,'copy':copy,'math':math,'re':re,'time':time,**(extra or{})};exec(compile(ast.Module(body=nodes,type_ignores=[]),str(path),'exec'),ns);return ns
def request(path,expected,repo):
 repo=Path(repo);need(repo.is_absolute()and repo.resolve()==repo,'canonical checkout');p=pin(path);raw=Path(path).read_bytes();need(p['sha256']==expected and sha(raw)==expected and len(raw)==p['bytes'],'request SHA/captured bytes');value=decode(raw);need(isinstance(value,dict)and set(value)==FIELDS and type(value['schema'])is int and value['schema']==1 and value['kind']=='paired-linux-ci-v1','closed paired request')
 for name in ['root_approved','inputs_enabled','functional_enabled','runtime_enabled']:need(type(value[name])is bool,'explicit gate booleans')
 need(isinstance(value['producer_source_commit'],str)and re.fullmatch('[0-9a-f]{40}',value['producer_source_commit'])and value['baseline_source_commit']==BASELINE and value['baseline_profile']=='locked-c520224-production-three-agent-linux-v1','separate real Linux cohorts')
 need(set(value['transport_requests'])==set(MODES),'both metadata transports')
 if not value['root_approved']:
  need(not any(value[n]for n in ['inputs_enabled','functional_enabled','runtime_enabled']),'unapproved work flags');return value,p
 need(value['inputs_enabled']or value['prepared_inputs']is not None,'once inputs or exact existing input artifact required')
 need(type(value['functional_enabled'])is bool,'functional gate');
 need(isinstance(value['required_source'],list)and len(value['required_source'])==len(SOURCE_PATHS)and {r['path']for r in value['required_source']}==SOURCE_PATHS,'exact executed Source closure')
 for row in value['required_source']:checked(row,repo)
 cohort=decode(Path(checked(value['qualified_cohort'],repo)['path']).read_bytes());need(cohort.get('passed')is True and cohort.get('all8_same_run_required_product_artifacts')is True and cohort.get('source_commit')==value['producer_source_commit'] and len(cohort.get('all4_required_jobs_actual_success',[]))==4,'actual eight-product Root qualification')
 jobs=cohort['all4_required_jobs_actual_success'];need({r.get('name')for r in jobs}=={'svm-prerequisites','native-harness-controls','full-sdk-native (ReleaseSafe)','full-sdk-native (ReleaseFast)'}and len({r.get('id')for r in jobs})==4 and all(type(r.get('id'))is int and r['id']>0 for r in jobs),'exact four qualified producer jobs')
 eight=cohort.get('eight_artifacts');need(isinstance(eight,dict)and set(eight)=={'sdk_safe','sdk_fast','helper','tools','writer_safe','writer_fast','svm','radix_reference'}and len({r.get('id')for r in eight.values()})==8,'exact qualified eight product identities')
 dispatch=load_source(repo/'zig/bench/native_case_ci.py','paired_checked_dispatch',value,repo)
 for mode,row in value['transport_requests'].items():
  request_path=Path(checked(row,repo)['path']);v=dispatch.read_request(request_path);dispatch.validate_request(v);need(v.get('root_approved')is True and v.get('scenario')=='cosmosnative'and v.get('mode')==mode and v.get('producer_source_commit')==value['producer_source_commit']and v.get('producer_run_id')==cohort.get('run_id')and v.get('producer_run_attempt')==cohort.get('run_attempt'),'honest producer transport only')
  selection={**{key:eight[key]for key in ['helper','tools','writer_safe','writer_fast']},'sdk':eight['sdk_safe'if mode=='ReleaseSafe'else'sdk_fast']};need(v['artifact_pins']==selection,'transport pins must equal actual accepted cohort')
 need(value['runtime_enabled']is False,'phase1 timing execution is not implemented or authorized')
 return value,p

def input_manifest(path,root,repo,producer):
 root=Path(root);need(root.is_absolute()and root.resolve()==root,'canonical input root');value=decode(Path(path).read_bytes());need(value.get('schema')==1 and value.get('kind')=='paired-linux-inputs-v1'and value.get('platform')=='linux-x86_64','Linux input manifest only')
 need(value.get('producer_source_commit')==producer and value.get('baseline_source_commit')==BASELINE,'exact independent comparator/producer Source')
 for field in ['passed','source_unchanged','all_actual_parent_waits','owned_absent']:need(value.get(field)is True,'actual once producer postconditions')
 a=value['artifacts'];need(set(a)=={'rust','zig','tools','tool_manifest','evm_oracle'}and set(a['rust'])==RUST and set(a['zig'])==set(MODES)and set(a['tools'])==TOOLS and all(set(a['zig'][m])==ZIG for m in MODES),'closed Linux product groups')
 groups=[*a['rust'].values(),*a['tools'].values(),a['evm_oracle'],a['tool_manifest'],*[r for m in MODES for r in a['zig'][m].values()]]
 for row in groups:checked(row,root)
 files=value['files'];need(isinstance(files,list)and len(files)==len({r['path']for r in files})and all(r['path']!='input-manifest.json'for r in files),'closed manifest file catalog')
 need(not any(p.is_symlink()for p in root.rglob('*')),'no published tree symlinks');actual={str(p.relative_to(root))for p in root.rglob('*')if p.is_file()};need(actual=={r['path']for r in files}|{'input-manifest.json'},'closed published file tree')
 for row in files:checked(row,root)
 needed={r['path']for r in groups};need(needed<={r['path']for r in files},'products missing from actual files')
 flags=value['required_cpu_flags'];need(isinstance(flags,list)and flags and flags==sorted(set(flags)),'actual aggregate producer CPU flags')
 from_cpu=Path('/proc/cpuinfo').read_text();rows=[set(line.split(':',1)[1].split())for line in from_cpu.splitlines()if line.startswith('flags')and':'in line];need(rows and set(flags)<=set.intersection(*rows),'consumer CPU superset')
 required_tools={'anvil','cast','clang','cc','node','pnpm','git','ps','lsof','sh','openssl'};need(required_tools<=set(value['external']['tools']),'actual fixture executable closure')
 for name in required_tools:
  row=value['external']['tools'][name];checked(row);need(__import__('shutil').which(name)is not None and str(Path(__import__('shutil').which(name)).resolve())==row['path'],'original bare tool resolution differs from producer')
 for row in value['external']['libraries'].values():checked(row)
 for row in value.get('repository_source_files',[]):checked(row,repo)
 for row in value.get('repository_fixture_files',[]):
  target=relative(row['repository_path']);need(target.startswith(('zig/integration/.deps/','zig/integration/.cache/','zig/bench/.cache/')),'only declared fixture cache destinations');checked(row['file'],root)
 return value

def env_for(value,root,mode):
 return {key:str(Path(root)/value['artifacts']['zig'][mode][name]['path'])for name,key in ENV.items()}
def functional_command(value,root,repo,index,output):
 need(type(index)is int and 0<=index<6,'six fixed functional slots');mode=MODES[index//3];kind=KINDS[index%3];a=value['artifacts'];z=a['zig'][mode];command=[sys.executable,'-I','-B',str(Path(repo)/'zig/integration'/('public_relay_process.py'if kind=='public_relay_process'else kind+'.py')),'--binary',str(Path(root)/z['relayer']['path']),'--oracle',str(Path(root)/a['tools']['ziggy-rocks-oracle']['path']),'--output',str(output)]
 if kind!='public_relay_process':command+=['--validator-binary',str(Path(root)/z['validator']['path']),'--url-library',str(Path(root)/z['url']['path'])]
 if kind=='relayer_stream':command+=['--reference',str(Path(root)/a['tools']['ziggy-rust-reference']['path'])]
 command+=['--tool-manifest',str(Path(root)/a['tool_manifest']['path']),'--tool-manifest-sha256',a['tool_manifest']['sha256'],'--tool-source-commit',value['producer_source_commit']]
 return command

def write(path,value):
 with Path(path).open('x')as out:json.dump(value,out,indent=2);out.write('\n');out.flush();os.fsync(out.fileno())

def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('action',choices=['select','functional-worker','runtime-worker']);parser.add_argument('--request',type=Path,required=True);parser.add_argument('--request-sha256',required=True);parser.add_argument('--repo',type=Path,required=True);parser.add_argument('--inputs',type=Path);parser.add_argument('--index',type=int);parser.add_argument('--output',type=Path);args=parser.parse_args();authority,rp=request(args.request,args.request_sha256,args.repo)
 if args.action=='select':
  result={k:authority['root_approved']and authority[k]for k in ['inputs_enabled','functional_enabled','runtime_enabled']}
  if os.environ.get('GITHUB_OUTPUT'):
   with open(os.environ['GITHUB_OUTPUT'],'a')as out:
    for k,v in result.items():out.write(k+'='+str(v).lower()+'\n')
  print(json.dumps(result));return
 need(authority['root_approved']and authority['functional_enabled'if args.action=='functional-worker'else'runtime_enabled'],'explicit phase authority required')
 need(sys.platform=='linux'and platform.machine()=='x86_64','native Linux worker only');need(args.inputs and args.index is not None and args.output,'fixed admitted inputs/slot/output required')
 # Actual workers are separate checked Source, loaded only AFTER all phase gates.
 sys.path.insert(0,str(Path(__file__).resolve().parent))
 from paired_linux_owner import worker
 worker(args,authority,rp)
if __name__=='__main__':main()
