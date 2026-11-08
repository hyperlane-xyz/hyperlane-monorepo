#!/usr/bin/env python3
"""Inventory owned source, explicit tests/fixtures, native helpers and locked packages.

Physical source lines are not an equivalence or productivity claim. Inline tests
are classified lexically; helpers outside test blocks remain in implementation.
No dependencies are downloaded and no build/timing occurs.
"""
import argparse,collections,datetime,gzip,hashlib,json,os,pathlib,platform,re,shutil,subprocess,tomllib
ROOT=pathlib.Path(__file__).resolve().parents[2]
PRUNE={'target','.git','.zig-cache','zig-out','node_modules','.pnpm-store','__pycache__','.cache','.toolchain','out','out-final'}
SOURCE={'.zig','.rs','.c','.cc','.cpp','.h','.hpp','.py','.sh','.mjs','.ts','.mts'}
DATA={'.json','.jsonl','.toml','.lock','.txt','.bin','.hex','.pem','.sql','.yaml','.yml','.gz','.zon'}
def pruned(name):
 return name in PRUNE or name.startswith(('target-','.zig-cache-','zig-out-'))
def digest(path):
 h=hashlib.sha256()
 with path.open('rb')as file:
  for block in iter(lambda:file.read(1024*1024),b''):h.update(block)
 value=h.hexdigest();return[value[:32],value[32:]]
def mask(text):
 """Preserve offsets/newlines, mask comments and string/character literals."""
 out=list(text);i=0;n=len(text)
 def blank(a,b):
  for p in range(a,b):
   if text[p]!='\n':out[p]=' '
 while i<n:
  begin=i
  if text.startswith('//',i):
   end=text.find('\n',i);i=n if end<0 else end;blank(begin,i);continue
  if text.startswith('/*',i):
   depth=1;i+=2
   while i<n and depth:
    if text.startswith('/*',i):depth+=1;i+=2
    elif text.startswith('*/',i):depth-=1;i+=2
    else:i+=1
   blank(begin,i);continue
  # Rust raw strings and Zig line strings, including arbitrary brace content.
  raw=re.compile(r'(?:br|r)(#{0,255})"').match(text,i)if text[i]in'br'else None
  if raw:
   close='"'+raw.group(1);end=text.find(close,raw.end());i=n if end<0 else end+len(close);blank(begin,i);continue
  if text.startswith('\\\\',i)and not text[text.rfind('\n',0,i)+1:i].strip():
   end=text.find('\n',i);i=n if end<0 else end;blank(begin,i);continue
  if text[i]=='"':
   i+=1
   while i<n:
    if text[i]=='\\':i+=2
    elif text[i]=='"':i+=1;break
    else:i+=1
   blank(begin,min(i,n));continue
  if text[i]=="'":
   # Match actual short characters; leave Rust lifetimes such as 'a intact.
   char=re.compile(r"'(?:[^'\\\n]|\\(?:u\{[0-9a-fA-F]+\}|x[0-9a-fA-F]{2}|.))'").match(text,i)
   if char:i=char.end();blank(begin,i);continue
  i+=1
 return''.join(out)
def inline_test_lines(text,language):
 if language not in{'zig','rs'}:return set()
 code=mask(text);starts=[]
 if language=='zig':starts=[v.start()for v in re.finditer(r'\btest\b',code)]
 else:starts=[v.start()for v in re.finditer(r'#\s*\[\s*(?:cfg\s*\(\s*test\s*\)|(?:tokio\s*::\s*)?test)\s*\]',code)]
 result=set()
 # Intervals are disjoint or nested; merging line sets avoids double-counting.
 for start in starts:
  begin=code.find('{',start)
  semicolon=code.find(';',start)
  if begin<0 or(semicolon>=0 and semicolon<begin):continue
  depth=1;end=begin+1
  while end<len(code)and depth:
   if code[end]=='{':depth+=1
   elif code[end]=='}':depth-=1
   end+=1
  if depth:continue
  first=text.count('\n',0,start);last=text.count('\n',0,end)
  result.update(range(first,last+1))
 return result
def category(path):
 parts=path.parts;name=path.name
 if any(v=='fixtures'or v.endswith('_fixtures')for v in parts):return'test_benchmark_or_integration_source'if path.suffix in SOURCE else'fixture_data'
 if name.endswith(('.jsonl','.jsonl.gz','.bin','.hex','.pem')):return'fixture_data'
 if any(v=='reference'or v.endswith('-reference')for v in parts):return'independent_reference_harness'
 if any(p in{'native-crypto','native-vm','regex-native','native-url'}for p in parts)or parts[:2]==('zig','native'):
  return'native_vendored_source'if'vendor'in parts else'native_helper_source'
 if name=='Dockerfile':return'build_or_operational_tool_source'
 if path.suffix not in SOURCE:return'configuration_or_data'
 if any(p in{'tests','testing','test','benches','bench','integration','examples'}for p in parts)or name in{'test.zig','tests.zig','testing.zig'}or name.endswith(('_test.zig','_tests.zig','_integration.zig','_bench.zig')):return'test_benchmark_or_integration_source'
 if parts[0]=='zig'and parts[1]in{'tools','deploy'}:return'build_or_operational_tool_source'
 return'implementation_source'
def embedded_locks():
 """Read committed chunk artifacts; ignored restored Cargo.lock is not source."""
 result={}
 for project in ['zig/src/starknet','zig/src/aleo']:
  artifact=ROOT/project/'testing/locks.json'
  if artifact.exists():
   for directory,record in json.loads(artifact.read_text()).items():
    result[str(pathlib.Path(project)/directory/'Cargo.lock')]=(artifact,record)
 for artifact,logical in [('zig/native/rocks/lock.json','zig/native/rocks/Cargo.lock'),('zig/src/ops/tools/regex-lock.json','zig/src/ops/regex-native/Cargo.lock'),('zig/src/ops/tools/denylist-lock.json','zig/src/ops/testing/reference/Cargo.lock')]:
  source=ROOT/artifact
  if source.exists():result[logical]=(source,json.loads(source.read_text()))
 output={}
 for logical,(artifact,record)in result.items():
  wire=''.join(record['utf8_chunks']).encode();expected=''.join(record['sha256_chunks'])
  if hashlib.sha256(wire).hexdigest()!=expected:raise ValueError('Pinned lock digest mismatch: '+str(artifact))
  packed=ROOT/(logical+'.gz')
  if packed.exists()and gzip.decompress(packed.read_bytes())!=wire:raise ValueError('Packed and chunked lock artifacts differ: '+logical)
  output[logical]=(artifact,wire)
 return output

def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',type=pathlib.Path,default=ROOT/'zig/bench/results/source-inventory.json');parser.add_argument('--generated-sizes',action='store_true');args=parser.parse_args();rows=[];generated=[];locks=[];native_packages=set();native_external_packages=set();embedded=embedded_locks()
 for base in[ROOT/'zig',ROOT/'rust/main',ROOT/'rust/sealevel']:
  for directory,children,names in os.walk(base):
   relative=pathlib.Path(directory).relative_to(ROOT)
   if relative.parts[:3]==('zig','bench','results'):children[:]=[];continue
   for child in children:
    if pruned(child):generated.append(pathlib.Path(directory)/child)
   children[:]=sorted(v for v in children if not pruned(v))
   for name in sorted(names):
    path=pathlib.Path(directory)/name;rel=path.relative_to(ROOT)
    if path.is_symlink()or(name=='Cargo.lock'and str(rel)in embedded)or(path.suffix != '.gz' and pathlib.Path(str(path)+'.gz').exists())or(path.suffix not in SOURCE|DATA and name not in{'Cargo.lock','Dockerfile'}):continue
    value={'path':str(rel),'bytes':path.stat().st_size,'category':category(rel),'language':path.suffix.lstrip('.')or name,'sha256_chunks':digest(path)}
    if path.suffix in SOURCE or name=='Dockerfile':
     text=path.read_text(errors='replace');lines=text.splitlines();tests=inline_test_lines(text,path.suffix.lstrip('.'))if value['category']in{'implementation_source','native_helper_source','native_vendored_source'}else set()
     value.update(physical_lines=len(lines),nonblank_lines=sum(bool(v.strip())for v in lines),inline_test_physical_lines=len(tests),implementation_physical_lines=len(lines)-len(tests),generated_header=any(v in text[:8192].lower()for v in['@generated','automatically generated','auto-generated']))
    rows.append(value)
    if name in {'Cargo.lock','Cargo.lock.gz'}and str(rel).removesuffix('.gz')not in embedded:
     try:
      packages=tomllib.loads(gzip.decompress(path.read_bytes()).decode()if path.suffix=='.gz'else path.read_text()).get('package',[])
      if value['category']=='native_helper_source':
       for package in packages:
        identity=(package['name'],package['version'],package.get('source','local'));native_packages.add(identity)
        if'source'in package:native_external_packages.add(identity)
      locks.append({'path':str(rel),'category':value['category'],'package_entries':len(packages),'registry_entries':sum(v.get('source','').startswith('registry+')for v in packages),'git_entries':sum(v.get('source','').startswith('git+')for v in packages),'local_entries':sum('source'not in v for v in packages),'sha256_chunks':value['sha256_chunks']})
     except tomllib.TOMLDecodeError as error:locks.append({'path':str(rel),'parse_error':str(error)})
 for logical,(artifact,wire)in sorted(embedded.items()):
  packages=tomllib.loads(wire.decode()).get('package',[]);kind=category(pathlib.Path(logical));h=hashlib.sha256(wire).hexdigest()
  if kind=='native_helper_source':
   for package in packages:
    identity=(package['name'],package['version'],package.get('source','local'));native_packages.add(identity)
    if 'source'in package:native_external_packages.add(identity)
  locks.append({'path':logical,'source_artifact':str(artifact.relative_to(ROOT)),'category':kind,'package_entries':len(packages),'registry_entries':sum(v.get('source','').startswith('registry+')for v in packages),'git_entries':sum(v.get('source','').startswith('git+')for v in packages),'local_entries':sum('source'not in v for v in packages),'sha256_chunks':[h[:32],h[32:]],'restored_raw_file_excluded':True})
 totals={}
 for row in rows:
  parts=row['path'].split('/');family='/'.join(parts[:2])if parts[0]=='rust'else parts[0];key='/'.join((family,row['category'],row['language']));total=totals.setdefault(key,dict(files=0,bytes=0,physical_lines=0,inline_test_physical_lines=0,implementation_physical_lines=0))
  total['files']+=1
  for field in['bytes','physical_lines','inline_test_physical_lines','implementation_physical_lines']:total[field]+=row.get(field,0)
 identity=hashlib.sha256()
 for row in sorted(rows,key=lambda v:v['path']):identity.update(row['path'].encode()+b'\0'+''.join(row['sha256_chunks']).encode()+b'\n')
 fingerprint=identity.hexdigest();git=lambda *argv:subprocess.check_output(['git',*argv],cwd=ROOT,text=True).strip()
 artifacts=[]
 for family,directory in[('rust',ROOT/'rust/main/target/release'),('zig',ROOT/'zig/zig-out/bin')]:
  for role in['validator','relayer','scraper']:
   binary=directory/role
   if binary.exists():
    libraries=subprocess.run(['otool','-L',str(binary)]if platform.system()=='Darwin'else['ldd',str(binary)],capture_output=True,text=True)
    artifacts.append({'family':family,'role':role,'path':str(binary.relative_to(ROOT)),'bytes':binary.stat().st_size,'sha256_chunks':digest(binary),'mtime_utc':datetime.datetime.fromtimestamp(binary.stat().st_mtime,datetime.timezone.utc).isoformat(),'linker_readback':libraries.stdout.splitlines()[1:]if libraries.returncode==0 else None})
 generated_sizes=[]
 if args.generated_sizes:
  for path in sorted(set(generated)):
   if not path.exists():continue
   value=subprocess.run(['du','-sk',str(path)],capture_output=True,text=True)
   generated_sizes.append({'path':str(path.relative_to(ROOT)),'allocated_KiB':int(value.stdout.split()[0])if value.returncode==0 else None})
 result={'captured_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'git_head':git('rev-parse','HEAD'),'branch':git('branch','--show-current'),'git_status':git('status','--short','--untracked-files=all').splitlines(),'source_fingerprint_sha256_chunks':[fingerprint[:32],fingerprint[32:]],'methodology':{'measurement':'Physical lines including comments/blank lines. Explicit inline test blocks are separated lexically; this is not AST semantic LOC or equivalent-feature productivity.','inline_tests':'Zig test blocks; Rust cfg(test) modules and test/tokio::test functions. Helpers outside those blocks remain conservatively in implementation.','scope':'rust/main plus separately visible Rust Sealevel local dependencies; Zig source, native helpers, tooling and independent references. Not every Rust workspace utility is agent runtime code.','generated':'Generated/header-marked source is tagged; target/cache/output directories are pruned before walking. Generated compilation output is not claimed absent from Rust dependency cost.','dependencies':'Cargo.lock counts are locked entries across targets/features, not target-specific runtime graph counts. No zero-dependency claim: Zig uses native C/C++, required Rust URL normalization and optional Rust SDK/regex/proving FFI. dlopen libraries are not shown by otool/ldd.','binaries':'Existing artifact identities only. Matching current source or cold build provenance is not inferred.'},'native_runtime_boundaries':['libcurl HTTP/TLS/DNS; system TLS/crypto backend','libpq PostgreSQL client','RocksDB10.4.2 and compression/ABI archives','required Rust URL normalization cdylib','optional Rust regex cdylib','optional Starknet crypto SDK cdylib','optional Aleo crypto SDK cdylib and Aleo VM/proving worker plus parameters'],'totals':totals,'native_locked_package_union_entries':len(native_packages),'native_external_locked_package_union_entries':len(native_external_packages),'cargo_lock_inventories':locks,'existing_agent_artifacts':artifacts,'generated_tree_sizes':generated_sizes,'files':rows}
 args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'files':len(rows),'locked_graphs':len(locks),'fingerprint_chunks':result['source_fingerprint_sha256_chunks'],'output':str(args.output)}))
if __name__=='__main__':main()
