"""Root-qualified Linux once-input/six-proof reuse. No timing or native grant.

Only this module/test are new. No producer rebuild, benchmark import or old
runner path is executed. All artifact paths returned belong to a fresh root.
"""
from pathlib import Path,PurePosixPath
import hashlib,json,math,os,platform,re,resource,sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
import paired_linux as policy
GIB=1024**3
REPOSITORY='hyperlane-xyz/hyperlane-monorepo'
WORKFLOW='.github/workflows/zig-agents.yml'
REQUEST='zig/bench/paired_linux_request.json'
SELF='zig/bench/paired_linux_reuse.py'
PORT_TEST='zig/bench/paired_linux_platform_test.py'
BASELINE_PROFILE='locked-c520224-production-three-agent-linux-v1'
PROFILE={'wall_seconds':1800,'cleanup_seconds':60,'inspector_RAM_bytes':GIB,'child_RAM_bytes':512*1024**2,'owned_disk_bytes':8*GIB,'host_free_bytes':6*GIB,'maximum_archive_bytes':4*GIB,'compressed_total_bytes':4*GIB,'streamed_total_bytes':8*GIB,'member_count':100000,'central_directory_bytes':32*1024**2,'metadata_bytes':64*1024**2,'report_bytes':2*1024**2}
FIELDS={'schema','kind','root_approved','producer_source_commit','baseline_source_commit','origin','original_request','original_source','input_artifact','input_manifest','proofs','current_source','workflow_recipe_delta','Root_input_accepted','Root_six_accepted'}
MEMBERS={'owner','worker','proof','launches','consumer'}


def need(v,message):
 if not v:raise policy.Refused(message)
def integer(v,low=0,high=2**63-1):return type(v)is int and low<=v<=high
def digest(v):return type(v)is str and re.fullmatch('[0-9a-f]{64}',v)is not None
def commit(v):return type(v)is str and re.fullmatch('[0-9a-f]{40}',v)is not None
def inert_header():
 return {'schema':1,'kind':'paired-linux-reuse-v1','root_approved':False,**{k:None for k in FIELDS-{'schema','kind','root_approved'}}}
def size_sha(row,maximum):
 need(type(row)is dict and integer(row.get('bytes'),0,maximum)and digest(row.get('sha256')),'bounded byte identity');return {'bytes':row['bytes'],'sha256':row['sha256']}
def source_row(row):
 need(type(row)is dict and set(row)=={'path','bytes','sha256'},'closed Source row');policy.relative(row['path']);size_sha(row,16*1024**2);return row
def member_row(row,maximum=64*1024**2):
 need(type(row)is dict and set(row)=={'member','bytes','sha256'},'closed artifact member');policy.relative(row['member']);size_sha(row,maximum);return row
def artifact_row(row):
 need(type(row)is dict and set(row)=={'id','name','size_in_bytes','sha256'}and integer(row['id'],1)and type(row['name'])is str and re.fullmatch('[A-Za-z0-9_.-]{1,160}',row['name'])and integer(row['size_in_bytes'],1,4*GIB)and digest(row['sha256']),'closed actual artifact identity');return row
def origin_row(row,job_name):
 need(type(row)is dict and set(row)=={'run_id','run_attempt','source_commit','job_id','job_name'}and integer(row['run_id'],1)and integer(row['run_attempt'],1)and commit(row['source_commit'])and integer(row['job_id'],1)and row['job_name']==job_name,'exact original run/attempt/head/job');return row

def read_header(header_pin,repo):
 size_sha(header_pin,2*1024**2);path=Path(policy.checked(header_pin)['path']);raw=path.read_bytes();need({'bytes':len(raw),'sha256':policy.sha(raw)}==size_sha(header_pin,2*1024**2),'captured header bytes');value=policy.decode(raw,2*1024**2,50000)
 need(type(value)is dict and set(value)==FIELDS and type(value['schema'])is int and value['schema']==1 and value['kind']=='paired-linux-reuse-v1'and type(value['root_approved'])is bool,'closed reuse header')
 if not value['root_approved']:
  need(all(value[k]is None for k in FIELDS-{'schema','kind','root_approved'}),'inert future pins must be null');return value
 need(value['Root_input_accepted']is True and value['Root_six_accepted']is True and commit(value['producer_source_commit'])and value['baseline_source_commit']==policy.BASELINE,'explicit actual input/six acceptance')
 origin_row(value['origin'],'paired-linux-inputs');source_row(value['original_request']);need(value['original_request']['path']==REQUEST,'fixed original request Git path');artifact_row(value['input_artifact']);need(value['input_artifact']['name']==f"paired-linux-inputs-{value['origin']['run_id']}-{value['origin']['run_attempt']}",'input artifact name/attempt')
 member_row(value['input_manifest'],32*1024**2);need(value['input_manifest']['member']=='input-manifest.json','original root manifest member')
 sources=value['original_source'];need(type(sources)is list and len(sources)==len({r['path']for r in sources})and {r['path']for r in sources}==policy.SOURCE_PATHS|{PORT_TEST},'finite original Source closure plus complete port8')
 for row in sources:source_row(row)
 current=value['current_source'];need(type(current)is list and len(current)==len({r['path']for r in current})and {r['path']for r in current}=={r['path']for r in sources}|{SELF},'exact current reader/unchanged Source closure')
 for row in current:source_row(row);policy.checked(row,repo)
 old={r['path']:r for r in sources};now={r['path']:r for r in current}
 need(all(old[n]==now[n]for n in old if n!=WORKFLOW),'original proof/port8/owner/helper Source changed')
 delta=value['workflow_recipe_delta'];need(type(delta)is dict and set(delta)=={'original','current'}and delta['original']==old[WORKFLOW]and delta['current']==now[WORKFLOW],'finite exact workflow recipe delta')
 proofs=value['proofs'];need(type(proofs)is list and len(proofs)==6 and [r.get('index')for r in proofs]==list(range(6)),'six fixed proof slots')
 ids={value['input_artifact']['id']};jobs={value['origin']['job_id']}
 for row in proofs:
  need(type(row)is dict and set(row)=={'index','mode','kind','origin','artifact','members'}and type(row['index'])is int,'closed proof slot')
  i=row['index'];need(row['mode']==policy.MODES[i//3]and row['kind']==policy.KINDS[i%3],'exact mode/kind slot');origin_row(row['origin'],f'paired-linux-functional ({i})')
  need(row['origin']['run_id']==value['origin']['run_id']and row['origin']['run_attempt']==value['origin']['run_attempt']and row['origin']['source_commit']==value['origin']['source_commit'],'first reuse requires one exact successful original input/six cohort')
  artifact_row(row['artifact']);need(row['artifact']['name']==f"paired-linux-proof-{i}-{row['origin']['run_id']}-{row['origin']['run_attempt']}",'proof artifact name/attempt')
  need(row['artifact']['id']not in ids and row['origin']['job_id']not in jobs,'distinct actual proof artifacts/jobs');ids.add(row['artifact']['id']);jobs.add(row['origin']['job_id'])
  need(type(row['members'])is dict and set(row['members'])==MEMBERS,'complete actual proof/owner/worker/launch/consumer receipts')
  for m in row['members'].values():member_row(m)
  need(len({m['member']for m in row['members'].values()})==5,'distinct proof members')
 return value

def actual_remote(origin,expected,run,jobs,artifacts):
 need(run.get('id')==origin['run_id']and type(run.get('run_attempt'))is int and run['run_attempt']==origin['run_attempt']and run.get('head_sha')==origin['source_commit']and run.get('repository',{}).get('full_name')==REPOSITORY and run.get('head_repository',{}).get('full_name')==REPOSITORY and run.get('path')==WORKFLOW and run.get('event')in {'push','workflow_dispatch'},'actual original publisher run')
 selected=[r for r in jobs if r.get('id')==origin['job_id']];need(len(selected)==1 and selected[0].get('name')==origin['job_name']and type(selected[0].get('run_attempt'))is int and selected[0]['run_attempt']==origin['run_attempt']and selected[0].get('run_id')==origin['run_id']and selected[0].get('status')=='completed'and selected[0].get('conclusion')=='success'and len([r for r in jobs if r.get('name')==origin['job_name']])==1,'actual exact original successful job')
 rows=[r for r in artifacts if r.get('id')==expected['id']];need(len(rows)==1 and len([r for r in artifacts if r.get('name')==expected['name']])==1,'actual artifact ID/name unique');row=rows[0];owner=row.get('workflow_run',{})
 need(row.get('name')==expected['name']and row.get('size_in_bytes')==expected['size_in_bytes']and row.get('digest')=='sha256:'+expected['sha256']and row.get('expired')is False and owner.get('id')==origin['run_id']and owner.get('head_sha')==origin['source_commit'],'actual artifact publisher/content identity')
 return {'run_id':origin['run_id'],'run_attempt':origin['run_attempt'],'source_commit':origin['source_commit'],'job_id':origin['job_id'],'artifact_id':expected['id'],'artifact_sha256':expected['sha256']}

def attempt_json(runner,run_id,attempt,collection=None,page=None):
 # Keep the qualified command ownership/resource implementation. Only extend
 # its endpoint allowlist locally to exact immutable-attempt read routes.
 need(integer(run_id,1)and integer(attempt,1),'exact attempt API IDs')
 path=f'repos/{REPOSITORY}/actions/runs/{run_id}/attempts/{attempt}'
 if collection is not None:
  need(collection=='jobs'and integer(page,1,20),'attempt jobs page');path+=f'/jobs?per_page=100&page={page}'
 return runner.call([str(runner.gh),'api','--hostname','github.com','-H','Accept: application/vnd.github+json',path],'API_JSON',16*1024**2)[0]

def remote_snapshot(runner,origin,decode):
 base=f"repos/{REPOSITORY}/actions/runs/{origin['run_id']}";run=decode(attempt_json(runner,origin['run_id'],origin['run_attempt']).read_bytes());out={}
 for name in ['jobs','artifacts']:
  rows=[]
  for page in range(1,21):
   path=attempt_json(runner,origin['run_id'],origin['run_attempt'],'jobs',page)if name=='jobs'else runner.api(base+f'/artifacts?per_page=100&page={page}');value=decode(path.read_bytes());batch=value[name];need(type(batch)is list,'bounded publisher rows');rows.extend(batch)
   if len(batch)<100:break
  else:raise policy.Refused('publisher page bound')
  out[name]=rows
 return run,out['jobs'],out['artifacts']

def git_original(runner,header):
 head=header['origin']['source_commit'];request=header['original_request'];output,_=runner.git(['show',head+':'+request['path']],maximum=2*1024**2);need(size_sha(policy.pin(output),2*1024**2)==size_sha(request,2*1024**2),'original request actual Git blob');value=policy.decode(output.read_bytes());need(type(value)is dict and set(value)==policy.FIELDS and type(value.get('schema'))is int and value['schema']==1 and value.get('kind')=='paired-linux-ci-v1','actual original request schema');need(value.get('root_approved')is True and value.get('inputs_enabled')is True and value.get('functional_enabled')is True and value.get('runtime_enabled')is False and value.get('producer_source_commit')==header['producer_source_commit']and value.get('baseline_source_commit')==policy.BASELINE and type(value.get('baseline_profile'))is str and value['baseline_profile']in policy.PROFILE_RUSTFLAGS,'actual original input/proof request scope')
 declared={r['path']:r for r in value['required_source']};expected={r['path']:r for r in header['original_source']};need(set(declared)==policy.SOURCE_PATHS and all(declared[n]==expected[n]for n in declared),'header Source matches actual original request')
 for row in header['original_source']:
  output,_=runner.git(['show',head+':'+row['path']],maximum=16*1024**2);need(size_sha(policy.pin(output),16*1024**2)==size_sha(row,16*1024**2),'original Source actual Git blob')
 return {'head':head,'baseline_profile':value['baseline_profile'],'request_sha256':request['sha256'],'Source_rows':len(header['original_source']),'Source_catalog_sha256':policy.sha(json.dumps(header['original_source'],sort_keys=True,separators=(',',':')).encode())}

def download(runner,reader,guard,row):
 archive_path=runner.api(f"repos/{REPOSITORY}/actions/artifacts/{row['id']}/zip",row['size_in_bytes']);need(size_sha(policy.pin(archive_path),4*GIB)=={'bytes':row['size_in_bytes'],'sha256':row['sha256']},'actual archive byte digest');archive=reader.Archive(archive_path,guard)
 return archive,archive_path

def bound_member(archive,row,root):
 # Member identity comes from the Root-approved header, not an absolute path in
 # an old receipt. Local extraction root is the only filesystem authority.
 archive.match(row['member'],row);path=root/policy.relative(row['member']);actual=policy.pin(path);need(size_sha(actual,64*1024**2)==size_sha(row,64*1024**2),'actual relocated member bytes');return path

def data_reference(row,expected):
 need(type(row)is dict and set(row)=={'path','bytes','sha256'}and type(row['path'])is str and str(PurePosixPath(row['path']))==row['path']and row['path'].startswith('/')and not any(c in row['path']for c in ['\\','\0','\r','\n'])and '..'not in PurePosixPath(row['path']).parts,'bounded old descriptor syntax')
 need(size_sha(row,64*1024**2)==size_sha(expected,64*1024**2),'old receipt byte link differs');return PurePosixPath(row['path'])

def validate_input_provenance(value,root,header,profile=BASELINE_PROFILE,repo=None,authority=None):
 need(value.get('request_sha256')==header['original_request']['sha256']and value.get('execution_source_commit')==header['origin']['source_commit']and value.get('producer_source_commit')==header['producer_source_commit']and value.get('baseline_profile')==profile and type(value.get('baseline_profile'))is str and value['baseline_profile']in policy.PROFILE_RUSTFLAGS,'original input request/Source provenance')
 gate=policy.decode(Path(policy.checked(value['source_gate'],root)['path']).read_bytes());baseline=gate['baseline'];need(gate.get('schema')==1 and gate.get('source_unchanged')is True and gate.get('source_before')==gate.get('source_after')and gate.get('execution_source_commit')==header['origin']['source_commit']and gate.get('producer_source_commit')==header['producer_source_commit']and baseline.get('baseline_source_commit')==policy.BASELINE and baseline.get('build_checkout_commit')==header['origin']['source_commit']and baseline.get('profile')==value['baseline_profile']and baseline.get('RUSTFLAGS')==policy.PROFILE_RUSTFLAGS[value['baseline_profile']]and baseline.get('compiled_Source_equal')is True and baseline.get('helper_fixture_excluded_by_actual_Cargo_reachability')is True,'actual original comparator Source gate')
 checks=gate.get('actual_waited_Git_checks');need(type(checks)is list and checks and all(r.get('actual_parent_wait')is True and type(r.get('exit_code'))is int for r in checks),'actual recorded Git waits (optional missing objects may be nonzero)')
 build=policy.decode(Path(policy.checked(value['build_receipt'],root)['path']).read_bytes());rows=build.get('actual_commands');need(build.get('passed')is True and build.get('fixed_profile')==value['baseline_profile'] and type(rows)is list and rows,'actual once build receipt')
 if profile==policy.PORTABLE_PROFILE:
  need(repo is not None,'portable reuse requires admitted current Source');policy.portable_build_provenance(build,repo,header['producer_source_commit'],authority)
 for row in rows:
  need(row.get('error_type')is None and row.get('actual_parent_wait')is True and type(row.get('exit_code'))is int and row['exit_code']==0 and row.get('signals')==[]and row.get('owned_absent')is True and row.get('completed_within_original_deadline')is True and integer(row.get('completion_check_ns'))and integer(row.get('original_deadline_monotonic_ns'))and row['completion_check_ns']<row['original_deadline_monotonic_ns'],'actual once-input bounded phase wait')
 return {'actual_build_command_waits':len(rows),'actual_Git_waits':len(checks),'baseline_source_commit':policy.BASELINE,'all_declared_products_sha256':policy.sha(json.dumps(value['artifacts'],sort_keys=True,separators=(',',':')).encode())}

def validate_proof(slot,files,manifest,header,semantic,repo):
 i=slot['index'];mode=slot['mode'];kind=slot['kind'];owner=policy.decode(files['owner'].read_bytes());worker=policy.decode(files['worker'].read_bytes());launches=policy.decode(files['launches'].read_bytes());consumer=policy.decode(files['consumer'].read_bytes());raw=policy.decode(files['proof'].read_bytes(),64*1024**2,2000000);expected=slot['members'];request=header['original_request']
 need(owner.get('schema')==1 and owner.get('kind')=='paired-linux-owned-functional'and owner.get('platform')=='linux-x86_64'and owner.get('passed')is True and type(owner.get('index'))is int and owner['index']==i and owner.get('error_type')is None and owner.get('native18_or_performance_acceptance')is False,'actual Linux functional owner receipt')
 data_reference(owner['request'],request);cleanup=owner.get('cleanup');need(type(cleanup)is dict and cleanup.get('actual_parent_wait')is True and type(cleanup.get('exit_code'))is int and cleanup['exit_code']==0 and cleanup.get('clean')is True and cleanup.get('cleanup_confirmed_absent')is True and cleanup.get('signals')==[]and cleanup.get('errors')==[]and not cleanup.get('remaining_identities')and not cleanup.get('unanchored_session_members'),'actual bounded clean no-signal owner wait/absence')
 for adopted in cleanup.get('actual_adopted_child_waits',[]):
  need(integer(adopted.get('pid'),1)and adopted.get('waited_pid')==adopted['pid']and adopted.get('actual_wait4_usage_available')is True and type(adopted.get('status'))is int and os.WIFEXITED(adopted['status'])and os.WEXITSTATUS(adopted['status'])==0,'actual successful adopted child waits')
 limits={'wall_seconds':7200,'RSS_bytes':4*GIB,'new_disk_bytes':512*1024**2,'free_bytes':6*GIB};need(owner.get('limits')==limits and owner.get('original_wall_seconds')==7200,'original owner limits')
 for field in ['started_monotonic','original_deadline_monotonic','ended_monotonic']:need(type(owner.get(field))in(int,float)and math.isfinite(owner[field]),'finite original owner clock')
 need(owner['original_deadline_monotonic']==owner['started_monotonic']+7200 and owner['started_monotonic']<=owner['ended_monotonic']<owner['original_deadline_monotonic']and integer(owner.get('sampled_tree_RSS_peak_bytes'),0,4*GIB)and integer(owner.get('new_allocated_peak_bytes'),0,512*1024**2)and integer(owner.get('minimum_host_free_bytes'),6*GIB),'actual original wall/RSS/disk/free limits')
 need(worker.get('schema')==1 and worker.get('kind')=='paired-linux-functional-result'and worker.get('platform')=='linux-x86_64'and worker.get('passed')is True and type(worker.get('index'))is int and worker['index']==i and worker.get('mode')==mode and worker.get('proof_kind')==kind and worker.get('production_confirm_seconds')==600 and worker.get('bounded_grace_seconds')==30 and worker.get('native18_or_timing_acceptance')is False,'actual exact-binary600+30 functional worker')
 old_worker=data_reference(owner['worker_receipt'],expected['worker']);old_proof=data_reference(worker['proof'],expected['proof']);need(old_worker.name=='functional-result.json'and old_proof.name=='proof.json'and old_worker.parent==old_proof.parent,'consistent old receipt paths; never local IO authority')
 data_reference(worker['request'],request);data_reference(worker['input_manifest'],header['input_manifest']);need(consumer.get('schema')==1 and consumer.get('kind')=='paired-linux-input-consumer'and consumer.get('passed')is True and consumer.get('consumer_cpu_and_elf_admitted')is True and consumer.get('tool_manifest_admitted')is True and consumer.get('native18_or_timing_acceptance')is False,'original input admission')
 data_reference(consumer['input_manifest'],header['input_manifest']);data_reference(consumer['request'],request);remote=consumer.get('remote',{});need(remote.get('id')==header['input_artifact']['id']and remote.get('sha256')==header['input_artifact']['sha256']and remote.get('run_id')==header['origin']['run_id']and remote.get('run_attempt')==header['origin']['run_attempt']and remote.get('source_commit')==header['origin']['source_commit']and remote.get('bytes')==header['input_artifact']['size_in_bytes']and remote.get('name')==header['input_artifact']['name']and remote.get('job_id')==header['origin']['job_id'],'proof used exact original once artifact')
 commands=consumer.get('actual_commands');need(type(commands)is dict and commands.get('all_calls_actually_waited')is True and integer(commands.get('actual_calls'),1)and commands.get('actual_parent_waits')==commands['actual_calls']and commands.get('failure_count')==0,'actual original admission command waits')
 roles=manifest['artifacts']['zig'][mode];allowed={roles[n]['sha256']for n in ['relayer','validator']};relayer=roles['relayer']['sha256'];need(type(launches)is list and launches and launches==worker.get('actual_role_launches')and all(type(r.get('pid'))is int and r['pid']>0 and r.get('mode')==mode and r.get('binary_sha256')in allowed for r in launches)and any(r['binary_sha256']==relayer for r in launches),'actual same-mode role products')
 if kind!='public_relay_process':need(any(r['binary_sha256']==roles['validator']['sha256']for r in launches),'actual matching validator role')
 def chunks_equal(value,sha):return type(value)is list and all(type(x)is str for x in value)and ''.join(value)==sha
 if kind=='relayer_process':
  need(chunks_equal(raw['binaries']['validator_sha256_chunks'],roles['validator']['sha256'])and chunks_equal(raw['binaries']['rust_oracle_sha256_chunks'],manifest['artifacts']['tools']['ziggy-rocks-oracle']['sha256']),'exact process validator/oracle products')
 elif kind=='relayer_stream':
  need(chunks_equal(raw['executables']['validator_sha256_chunks'],roles['validator']['sha256'])and chunks_equal(raw['executables']['rocks_oracle_sha256_chunks'],manifest['artifacts']['tools']['ziggy-rocks-oracle']['sha256'])and chunks_equal(raw['executables']['rust_reference_sha256_chunks'],manifest['artifacts']['tools']['ziggy-rust-reference']['sha256']),'exact WSS validator/oracle/reference products')
 else:need(chunks_equal(raw['rust_oracle_sha256_chunks'],manifest['artifacts']['tools']['ziggy-rocks-oracle']['sha256']),'exact public oracle product')
 if kind!='public_relay_process':need(chunks_equal(raw['validator_url_library']['sha256_chunks'],roles['url']['sha256']),'exact required native URL dependency')
 summary=semantic.validate(kind,raw,relayer,repo);need(summary==worker.get('strict_cases'),'strict original per-ID/receipt/cost/restart/duplicate semantics')
 return {'index':i,'mode':mode,'kind':kind,'actual_owner_parent_wait0':True,'cleanup_absence_proven':True,'relayer_sha256':relayer,'strict_cases':summary,'raw_proof_sha256':expected['proof']['sha256']}


def reuse(header_pin,repo,output,current_source_commit,gh,token):
 repo=Path(repo);output=Path(output);need(repo.is_absolute()and repo.resolve()==repo,'canonical current checkout');header=read_header(header_pin,repo)
 if not header['root_approved']:return {'enabled':False,'input_rebuild':False,'native_or_timing_acceptance':False}
 need(sys.platform=='linux'and platform.machine()=='x86_64'and commit(current_source_commit),'native Linux current execution identity');need(Path(__file__).resolve()==repo/SELF,'exact executing reuse reader path');need(output.is_absolute()and output.parent.resolve()==output.parent and not output.exists()and not output.is_relative_to(repo),'fresh outside Source reuse output');need(type(token)is str and token,'read-only CI token required')
 authority={'required_source':header['current_source'],'producer_source_commit':header['producer_source_commit']};output.mkdir(mode=0o700);reader=policy.load_source(repo/'zig/bench/cohort_readback.py','paired_reuse_reader',authority,repo);stage=policy.load_source(repo/'zig/bench/paired_linux_stage.py','paired_reuse_stage',authority,repo);semantic=policy.load_source(repo/'zig/bench/paired_linux_proofs.py','paired_reuse_semantics',authority,repo);resource.setrlimit(resource.RLIMIT_AS,(GIB,GIB));guard=reader.Guard(output,PROFILE);runner=reader.Runner(output,repo,Path(gh),guard,token);previous=stage.arm_interrupts(guard);result=None;error=None;archives=[];join=None
 try:
  guard();head,_=runner.git(['rev-parse','HEAD'],maximum=65536);need(head.read_text().strip()==current_source_commit,'actual current checkout head');origin=git_original(runner,header);authority['baseline_profile']=origin['baseline_profile'];snapshot=remote_snapshot(runner,header['origin'],reader.unique_json);actual_remote(header['origin'],header['input_artifact'],*snapshot)
  compressed=sum(r['artifact']['size_in_bytes']for r in header['proofs'])+header['input_artifact']['size_in_bytes'];need(compressed<=PROFILE['compressed_total_bytes'],'all7 compressed byte cap')
  archive,path=download(runner,reader,guard,header['input_artifact']);archives.append(path)
  try:stage.extract(archive,output/'published');archive.finish()
  finally:archive.close()
  manifest_path=output/'published/input-manifest.json';need(size_sha(policy.pin(manifest_path),32*1024**2)==size_sha(header['input_manifest'],32*1024**2),'actual original manifest SHA');manifest=policy.input_manifest(manifest_path,output/'published',repo,header['producer_source_commit'],authority);input_scope=validate_input_provenance(manifest,output/'published',header,origin['baseline_profile'],repo,authority);stage.admit(manifest,output/'published',repo,authority,guard)
  proofs={mode:{}for mode in policy.MODES};summaries=[]
  for slot in header['proofs']:
   guard();actual_remote(slot['origin'],slot['artifact'],*snapshot);archive,path=download(runner,reader,guard,slot['artifact']);archives.append(path);root=output/('proof-'+str(slot['index']))
   try:
    stage.extract(archive,root);archive.finish();files={name:bound_member(archive,row,root)for name,row in slot['members'].items()};summary=validate_proof(slot,files,manifest,header,semantic,repo)
   finally:archive.close()
   proofs[slot['mode']][slot['kind']]=policy.pin(files['proof']);summaries.append(summary)
  for row in header['current_source']:policy.checked(row,repo)
  guard();join={'schema':1,'kind':'paired-linux-accepted-six-reuse','passed':True,'platform':'linux-x86_64','header':header_pin,'original_input_execution':dict(header['origin']),'original_input_request_sha256':header['original_request']['sha256'],'runtime_product_source_commit':header['producer_source_commit'],'current_consumer_execution_source_commit':current_source_commit,'whole_original_proof_source_unchanged':True,'workflow_recipe_delta':header['workflow_recipe_delta'],'original_Git':origin,'input_provenance':input_scope,'input_manifest':policy.pin(manifest_path),'proofs':proofs,'strict_six':summaries,'input_rebuilt':False,'native18_or_timing_acceptance':False};guard();result={'enabled':True,'inputs_root':str(output/'published'),'input_manifest':policy.pin(manifest_path),'proofs':proofs,'accepted_six':None,'provenance':{'original_input_execution':dict(header['origin']),'original_request_sha256':header['original_request']['sha256'],'current_execution_source_commit':current_source_commit,'product_source_commit':header['producer_source_commit'],'input_rebuilt':False,'native_or_timing_acceptance':False}}
 except BaseException as failure:error=type(failure).__name__
 finally:
  try:
   # Only fixed outputs created by this qualified Runner are removed. Every
   # cleanup attempt is independent and cannot suppress actual wait evidence.
   for path in archives:
    try:need(path.parent==output and path.name.startswith('call-')and not path.is_symlink(),'owned archive cleanup');path.unlink(missing_ok=True)
    except BaseException as failure:error=error or'Cleanup'+type(failure).__name__
   try:
    guard.cleanup()
    if result is not None and error is None:guard()
   except BaseException as failure:error=error or'FinalResource'+type(failure).__name__
   commands=runner.summary()
   if commands.get('all_calls_actually_waited')is not True or commands.get('failure_count')!=0:error=error or'CommandWaitRefused'
   report={'schema':1,'kind':'paired-linux-reuse-readback','passed':result is not None and error is None,'error_type':error,'header':header_pin,'actual_commands':commands,'native_or_timing_acceptance':False}
   try:
    policy.write(output/'reuse-result.json',report)
    if error is None and result is not None:
     guard();policy.write(output/'accepted-six.json',join);guard();result['accepted_six']=policy.pin(output/'accepted-six.json')
   except BaseException as failure:error=error or'Publication'+type(failure).__name__
   if error is not None:
    report.update(passed=False,error_type=error)
    # Only owned fixed sidecars are rewritten; failure never authorizes touching
    # old runner paths or compiler caches. The caller still receives failure if
    # a broken filesystem also prevents this durable revocation.
    for path,value in [(output/'reuse-result.json',report),(output/'accepted-six.json',{'schema':1,'kind':'paired-linux-accepted-six-reuse','passed':False,'error_type':error,'native18_or_timing_acceptance':False})]:
     if not path.exists():continue
     try:
      with path.open('w')as out:json.dump(value,out,indent=2);out.write('\n');out.flush();os.fsync(out.fileno())
     except BaseException as failure:report.setdefault('revocation_error_types',[]).append(type(failure).__name__)
  finally:stage.restore_interrupts(previous)
 need(error is None and result is not None,'reuse failed; closed evidence retained');return result
