"""Authenticate one completed input job; materialize closed regular files only.

No artifact Python/library/program is imported or executed. Consumer performs its
own CPU, ELF, tool-manifest and Source admission before a functional/timing main.
"""
from pathlib import Path
import argparse,hashlib,json,os,platform,re,resource,shutil,signal,stat,sys,time
sys.path.insert(0,str(Path(__file__).resolve().parent))
import paired_linux as policy
GIB=1024**3
REPO='hyperlane-xyz/hyperlane-monorepo'
LIMITS={'wall_seconds':1800,'cleanup_seconds':60,'inspector_RAM_bytes':GIB,'child_RAM_bytes':512*1024**2,'owned_disk_bytes':8*GIB,'host_free_bytes':6*GIB,'maximum_archive_bytes':4*GIB,'compressed_total_bytes':4*GIB,'streamed_total_bytes':8*GIB,'member_count':100000,'central_directory_bytes':32*1024**2,'metadata_bytes':32*1024**2,'report_bytes':2*1024**2}

class TaskInterrupted(RuntimeError):pass
WATCHED=(signal.SIGTERM,signal.SIGINT,signal.SIGHUP,signal.SIGALRM)
def interrupted(sig,frame):
 # First cancellation enters Runner.call's independent kill/wait cleanup;
 # repeated cancellation cannot interrupt those actual direct-child waits.
 for watched in WATCHED:signal.signal(watched,signal.SIG_IGN)
 raise TaskInterrupted('paired input consumption interrupted')
def arm_interrupts(guard):
 policy.need(signal.getitimer(signal.ITIMER_REAL)==(0.0,0.0),'preexisting manager timer refused')
 previous={sig:signal.signal(sig,interrupted)for sig in WATCHED};signal.setitimer(signal.ITIMER_REAL,max(.001,guard.deadline-guard.clock()));return previous
def restore_interrupts(previous):
 signal.setitimer(signal.ITIMER_REAL,0)
 for sig,handler in previous.items():signal.signal(sig,handler)

def identity(run,jobs,artifacts,run_id,attempt,source,name):
 policy.need(type(run_id)is int and type(attempt)is int and re.fullmatch('[0-9a-f]{40}',source),'explicit input run identity')
 policy.need(run.get('id')==run_id and run.get('run_attempt')==attempt and run.get('head_sha')==source and run.get('repository',{}).get('full_name')==REPO and run.get('head_repository',{}).get('full_name')==REPO and run.get('event')in {'push','workflow_dispatch'}and run.get('path')=='.github/workflows/zig-agents.yml','input run publisher')
 rows=[j for j in jobs if j.get('name')=='paired-linux-inputs'];policy.need(len(rows)==1 and rows[0].get('run_id')==run_id and rows[0].get('status')=='completed'and rows[0].get('conclusion')=='success','actual once-input job success required')
 matches=[a for a in artifacts if a.get('name')==name];policy.need(len(matches)==1,'unique input artifact');row=matches[0];origin=row.get('workflow_run',{})
 policy.need(name==f'paired-linux-inputs-{run_id}-{attempt}'and row.get('expired')is False and type(row.get('id'))is int and type(row.get('size_in_bytes'))is int and 0<row['size_in_bytes']<=4*GIB and isinstance(row.get('digest'),str)and re.fullmatch('sha256:[0-9a-f]{64}',row['digest'])and origin.get('id')==run_id and origin.get('head_sha')==source,'authenticated input artifact metadata')
 return {'id':row['id'],'name':name,'bytes':row['size_in_bytes'],'sha256':row['digest'][7:],'run_id':run_id,'run_attempt':attempt,'source_commit':source,'job_id':rows[0]['id']}

def extract(archive,destination):
 policy.need(not destination.exists(),'fresh extraction root');destination.mkdir(mode=0o700);written=[]
 # Archive already rejects NUL, traversal, duplicate, file-parent, link, special,
 # encrypted and noncanonical ZIP metadata before the first output is created.
 for name in sorted(archive.files(),key=lambda n:archive.entries[n].header_offset):
  target=destination/policy.relative(name);target.parent.mkdir(parents=True,exist_ok=True)
  with target.open('xb')as out:row=archive.stream(name,out.write);out.flush();os.fsync(out.fileno())
  target.chmod(0o600);written.append({'path':name,**row})
 return written

def materialize(value,root,repo,guard=lambda count=0:None):
 """Only producer-declared immutable fixture data; no executable/source overwrite."""
 rows=value.get('repository_fixture_files',[]);policy.need(len(rows)==len({r['repository_path']for r in rows}),'unique fixture destinations');copied=[]
 for row in rows:
  name=policy.relative(row['repository_path']);policy.need(name.startswith(('zig/integration/.deps/','zig/integration/.cache/','zig/bench/.cache/')),'fixture cache destination only');source=Path(policy.checked(row['file'],root)['path']);target=repo/name
  parent=repo
  for part in Path(name).parts[:-1]:
   parent=parent/part;policy.need(not parent.is_symlink(),'fixture parent symlink')
   if not parent.exists():parent.mkdir(mode=0o700)
   policy.need(parent.is_dir()and parent.resolve()==parent,'canonical fixture parent')
  policy.need(not target.is_symlink(),'canonical fixture destination')
  if target.exists():policy.need(policy.pin(target)['sha256']==row['file']['sha256']and target.stat().st_size==row['file']['bytes'],'existing fixture mismatch')
  else:
   with source.open('rb')as src,target.open('xb')as dst:
    for block in iter(lambda:src.read(1024**2),b''):guard(len(block));dst.write(block)
    dst.flush();os.fsync(dst.fileno())
   target.chmod(0o600)
  policy.checked({'path':str(target),'bytes':row['file']['bytes'],'sha256':row['file']['sha256']});copied.append({'repository_path':name,'bytes':row['file']['bytes'],'sha256':row['file']['sha256']})
 return copied

def admit(value,root,repo,authority,guard=lambda count=0:None):
 tools=policy.load_source(repo/'zig/bench/native_case_tools.py','paired_admitted_native_tools',authority,repo)
 a=value['artifacts'];executables=[*a['rust'].values(),a['evm_oracle'],*[a['zig'][m][n]for m in policy.MODES for n in ['relayer','validator','scraper','worker']],*a['tools'].values()]
 for row in executables:
  path=Path(policy.checked(row,root)['path']);tools.validate_elf(path,62,transport_data_only=True);path.chmod(0o700);tools.validate_elf(path,62)
 # Libraries require the existing bounded ELF library parser, not executable
 # admission (entry/PT_INTERP requirements differ from actual shared objects).
 reader=policy.load_source(repo/'zig/bench/cohort_readback.py','paired_admitted_archive_reader',authority,repo)
 class FileView:
  def __init__(self,path):self.path=path
  def _info(self,name):return type('Info',(),{'file_size':self.path.stat().st_size})()
  def read_at(self,name,offset,count):
   with self.path.open('rb')as f:f.seek(offset);out=f.read(count)
   policy.need(len(out)==count,'bounded library ELF read');return out
 for mode in policy.MODES:
  for name in ['aleoCrypto','aleoVm','starknetCrypto','regex','url']:reader.elf(FileView(root/a['zig'][mode][name]['path']),'library',62,'library')
 manifest=a['tool_manifest'];products=tools.load_manifest(root/manifest['path'],manifest['sha256'],authority['producer_source_commit'],62)
 policy.need(set(products)==policy.TOOLS,'full exact tool manifest');
 for name,row in a['tools'].items():policy.need(policy.pin(root/row['path'])==products[name],'tool member and manifest mismatch')
 return materialize(value,root,repo,guard)

def main():
 p=argparse.ArgumentParser();p.add_argument('--request',type=Path,required=True);p.add_argument('--request-sha256',required=True);p.add_argument('--repo',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--input-run-id',type=int,required=True);p.add_argument('--input-run-attempt',type=int,required=True);p.add_argument('--input-source-commit',required=True);p.add_argument('--manifest-sha256',required=True);args=p.parse_args();authority,request_pin=policy.request(args.request,args.request_sha256,args.repo)
 policy.need(authority['root_approved']and (authority['functional_enabled']or authority['runtime_enabled']),'consumer phase authority');policy.need(sys.platform=='linux'and platform.machine()=='x86_64','native Linux consumer');policy.need(args.output.is_absolute()and args.output.parent.resolve()==args.output.parent and not args.output.exists()and not args.output.is_relative_to(args.repo),'fresh outside Source stage')
 args.output.mkdir(mode=0o700);reader=policy.load_source(args.repo/'zig/bench/cohort_readback.py','paired_stage_reader',authority,args.repo);resource.setrlimit(resource.RLIMIT_AS,(GIB,GIB));guard=reader.Guard(args.output,LIMITS);runner=reader.Runner(args.output,args.repo,Path(shutil.which('gh')).resolve(strict=True),guard,os.environ.get('GH_TOKEN',''));remote=None;error=None;receipt=None;previous=arm_interrupts(guard)
 try:
  guard();run=reader.unique_json(runner.api(f'repos/{REPO}/actions/runs/{args.input_run_id}').read_bytes());jobs=[];artifacts=[]
  for collection,target in [('jobs',jobs),('artifacts',artifacts)]:
   for page in range(1,21):
    body=reader.unique_json(runner.api(f'repos/{REPO}/actions/runs/{args.input_run_id}/{collection}?per_page=100&page={page}').read_bytes());rows=body[collection];target.extend(rows)
    if len(rows)<100:break
   else:raise policy.Refused('bounded input publisher pages')
  remote=identity(run,jobs,artifacts,args.input_run_id,args.input_run_attempt,args.input_source_commit,f'paired-linux-inputs-{args.input_run_id}-{args.input_run_attempt}')
  # Normal dependent jobs may consume only this exact executing workflow run.
  # Cross-run reuse requires a future explicit Root-bound prepared-input header;
  # it cannot be minted from caller IDs or a filename.
  policy.need(authority['prepared_inputs']is None and str(args.input_run_id)==os.environ.get('GITHUB_RUN_ID')and str(args.input_run_attempt)==os.environ.get('GITHUB_RUN_ATTEMPT')and args.input_source_commit==os.environ.get('GITHUB_SHA'),'same-run input authority; cross-run reuse not yet enabled')
  archive_path=runner.api(f"repos/{REPO}/actions/artifacts/{remote['id']}/zip",remote['bytes']);policy.need(policy.pin(archive_path)['sha256']==remote['sha256']and archive_path.stat().st_size==remote['bytes'],'actual downloaded ZIP digest')
  archive=reader.Archive(archive_path,guard)
  try:
   policy.need(sum(i.file_size for i in archive.entries.values())<=8*GIB,'input expansion bound');extract(archive,args.output/'published');archive.finish()
  finally:archive.close()
  manifest=args.output/'published/input-manifest.json';policy.need(policy.pin(manifest)['sha256']==args.manifest_sha256,'actual once manifest output');value=policy.input_manifest(manifest,args.output/'published',args.repo,authority['producer_source_commit']);policy.need(value.get('execution_source_commit')==args.input_source_commit and value.get('request_sha256')==request_pin['sha256'],'input request/executed Source bound');copied=admit(value,args.output/'published',args.repo,authority,guard)
  for row in authority['required_source']:policy.checked(row,args.repo)
  guard();receipt={'schema':1,'kind':'paired-linux-input-consumer','passed':True,'remote':remote,'input_manifest':policy.pin(manifest),'request':request_pin,'closed_catalog_members':len(value['files']),'fixture_data':copied,'consumer_cpu_and_elf_admitted':True,'tool_manifest_admitted':True,'native18_or_timing_acceptance':False}
 except BaseException as e:error=type(e).__name__
 finally:
  result=receipt or{'schema':1,'kind':'paired-linux-input-consumer','passed':False,'remote':remote,'error_type':error,'native18_or_timing_acceptance':False};result['actual_commands']=runner.summary()
  try:policy.write(args.output/'consumer-result.json',result)
  finally:restore_interrupts(previous)
 policy.need(error is None,'input consumer failed; closed receipt retained')
if __name__=='__main__':main()
