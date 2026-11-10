"""One original paired workload. Activation belongs to the checked outer Root gate."""
from pathlib import Path
import argparse
import ast
import contextlib
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import types

MODES=('ReleaseSafe','ReleaseFast')
METHODS_SHA='0ef8f04ec32387abf5cb0be2f72a96f1'+'58bd33afd760c6ea1de05cf1257e95f1'
METHOD_ROWS=(('validator','ReleaseSafe','majority'),('validator','ReleaseSafe','fallback'),('validator','ReleaseFast','majority'),('validator','ReleaseFast','fallback'),('scraper','ReleaseSafe','single'),('scraper','ReleaseFast','single'),('relayer','ReleaseSafe','singleton-maxBatch1'),('relayer','ReleaseFast','singleton-maxBatch1'),('relayer','ReleaseSafe','genuine-batch-cap4'),('relayer','ReleaseFast','genuine-batch-cap4'))
ORDER=[name for sample in range(5)for name in(['rust','zig']if sample%2==0 else['zig','rust'])]
LOADS=(('paired_runtime_cpu','zig/tools/build_cpu.py'),('inventory','zig/bench/inventory.py'),('cold_matrix_owner','zig/bench/cold_matrix_owner.py'),('native_harness_controls','zig/bench/native_harness_controls.py'),('native_case_tools','zig/bench/native_case_tools.py'),('evm','zig/integration/evm.py'),('zig.integration.validator','zig/integration/validator.py'),('validator','zig/bench/validator.py'),('relayer_process','zig/integration/relayer_process.py'),('relayer','zig/bench/relayer.py'),('scraper','zig/bench/scraper.py'),('paired_linux_postgres','zig/bench/paired_linux_postgres.py'))
SOURCE_REQUIRED={p for _,p in LOADS}|{'zig/bench/native_harness_census.py','zig/bench/paired_linux_runtime.py','zig/bench/paired_linux_runtime_owner.py','zig/bench/paired_linux_reuse.py'}
ENV_KEYS={'url':'HYPERLANE_URL_LIBRARY','regex':'HYPERLANE_REGEX_LIBRARY','starknetCrypto':'HYPERLANE_STARKNET_CRYPTO_LIBRARY','aleoCrypto':'HYPERLANE_ALEO_CRYPTO_LIBRARY','aleoVm':'HYPERLANE_ALEO_VM_LIBRARY','worker':'HYPERLANE_ALEO_VM_WORKER'}

class Refused(RuntimeError):pass

def need(value,message):
    if not value:raise Refused(message)

def sha(wire):return hashlib.sha256(wire).hexdigest()

def pin(path):
    path=Path(path);need(path.is_absolute()and path.resolve(strict=True)==path and path.is_file()and not path.is_symlink(),'Canonical regular runtime input required')
    before=path.stat()
    with path.open('rb')as stream:digest=hashlib.file_digest(stream,'sha256').hexdigest()
    after=path.stat();need((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns),'Runtime input changed while hashing')
    return {'path':str(path),'bytes':after.st_size,'sha256':digest}

def checked(row,root=None):
    need(type(row)is dict and set(row)=={'path','bytes','sha256'}and type(row['bytes'])is int and 0<=row['bytes']<=2*1024**3 and type(row['sha256'])is str and re.fullmatch('[0-9a-f]{64}',row['sha256']),'Exact runtime descriptor required')
    path=Path(row['path'])
    if root is not None:
        need(not path.is_absolute()and path.as_posix()==row['path']and path.parts and all(x not in {'.','..'}for x in path.parts),'Root-relative runtime descriptor required');path=Path(root)/path
    need(pin(path)=={**row,'path':str(path)},'Runtime descriptor changed');return path

def decode(wire):
    def pairs(items):
        out={}
        for key,value in items:need(key not in out,'Duplicate runtime metadata key');out[key]=value
        return out
    return json.loads(wire,object_pairs_hook=pairs,parse_constant=lambda _:(_ for _ in()).throw(Refused('Nonfinite runtime metadata')))

def read(path):
    need(Path(path).stat().st_size<=16*1024**2,'Runtime metadata size bound')
    return decode(Path(path).read_bytes())

def captured_metadata(path,expected_sha):
    # Authority and reuse are decoded only from the one bounded captured body
    # whose bytes and digest this call admits, never a later pathname reread.
    path=Path(path);need(path.is_absolute()and path.resolve(strict=True)==path and path.is_file()and not path.is_symlink(),'Canonical regular runtime metadata required')
    before=path.stat();need(before.st_size<=16*1024**2,'Runtime metadata size bound')
    with path.open('rb')as stream:wire=stream.read(16*1024**2+1)
    after=path.stat();need((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns)and len(wire)==before.st_size,'Runtime metadata changed while capturing')
    row={'path':str(path),'bytes':len(wire),'sha256':sha(wire)}
    need(row['sha256']==expected_sha,'Runtime metadata digest changed')
    return row,decode(wire)

def write(path,value):
    wire=(json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False)+'\n').encode();need(len(wire)<=2*1024**2,'Runtime result bound')
    with Path(path).open('xb')as stream:stream.write(wire);stream.flush();os.fsync(stream.fileno())
    return pin(path)

def gate(row):
    need(type(row)is dict and set(row)=={'artifact','Root_passed'}and row['Root_passed']is True,'Independent Root evidence gate required')
    checked(row['artifact']);return row['artifact']

def current_head(repo):
    result=subprocess.run(['git','rev-parse','HEAD'],cwd=repo,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10,check=True)
    need(len(result.stdout)<=128 and len(result.stderr)<=65536,'Git identity output bound');return result.stdout.decode().strip()

def admit(authority,authority_sha,reuse,reuse_sha,repo,index):
    need(type(index)is int and 0<=index<10,'One fixed workload index required')
    authority_pin,value=captured_metadata(authority,authority_sha)
    need(type(value.get('schema'))is int and value.get('schema')==1 and value.get('kind')=='paired-linux-runtime-authority-v1'and type(value.get('root_approved'))is bool,'Root runtime authority schema')
    if not value['root_approved']:return None
    need(sys.platform=='linux'and os.uname().machine in {'x86_64','amd64'}and sys.dont_write_bytecode,'Linux no-bytecode runtime worker required')
    required={'schema','kind','root_approved','execution_source_commit','producer_source_commit','methods','required_source','accepted_six','final_native18','quiet'}
    need(set(value)==required,'Closed runtime authority fields')
    for key in ['execution_source_commit','producer_source_commit']:need(type(value[key])is str and re.fullmatch('[0-9a-f]{40}',value[key]),'Exact runtime Source commit')
    need(current_head(repo)==value['execution_source_commit'],'Actual runtime checkout differs')
    gates={key:gate(value[key])for key in ['accepted_six','final_native18','quiet']}
    methods_path=checked(value['methods']);need(value['methods']['sha256']==METHODS_SHA,'Original immutable method authority differs');methods=read(methods_path);sequence=methods['sequence']
    need(methods.get('schema')==1 and methods.get('Linux_only')is True and len(sequence)==10,'Original ten-method authority required')
    for number,(entry,identity)in enumerate(zip(sequence,METHOD_ROWS)):
        need(entry['index']==number and(entry['role'],entry['mode'],entry['scenario'])==identity and entry['pairs']==5 and entry['pair_orders']==[['rust','zig']if sample%2==0 else['zig','rust']for sample in range(5)],'Method shape/pair schedule differs')
    need(sequence[index]['script']=='zig/bench/'+METHOD_ROWS[index][0]+'.py','Fixed original benchmark script required')
    pins={}
    for item in value['required_source']:
        path=checked(item,repo);need(item['path']not in pins,'Duplicate runtime Source');pins[item['path']]=pin(path)
    need(SOURCE_REQUIRED<=set(pins),'Runtime executable Source closure incomplete')
    need(pins['zig/bench/paired_linux_runtime.py']['sha256']==pin(Path(__file__).resolve())['sha256'],'Executed runtime worker Source differs')
    reuse_pin,joined=captured_metadata(reuse,reuse_sha)
    need(joined.get('enabled')is True and joined.get('accepted_six')==gates['accepted_six'],'Checked reuse/accepted-six join differs')
    root=Path(joined['inputs_root']);need(root.is_absolute()and root.resolve(strict=True)==root,'Canonical prepared input root')
    manifest_path=checked(joined['input_manifest']);need(manifest_path==root/'input-manifest.json','Prepared manifest root differs');manifest=read(manifest_path);need(manifest.get('kind')=='paired-linux-inputs-v1'and manifest.get('platform')=='linux-x86_64'and manifest.get('passed')is True and manifest.get('source_unchanged')is True and manifest.get('all_actual_parent_waits')is True and manifest.get('owned_absent')is True and manifest.get('producer_source_commit')==value['producer_source_commit'],'Actual prepared inputs not admitted')
    for mode in MODES:
        need(set(joined['proofs'][mode])=={'relayer_process','relayer_stream','public_relay_process'},'Six exact fresh Linux proofs required')
        for item in joined['proofs'][mode].values():checked(item)
    for item in manifest['files']:checked(item,root)
    for name,row in manifest['external']['tools'].items():
        actual=Path(sys.executable).resolve(strict=True)if name=='python3'else Path('/usr/lib/postgresql/16/bin/psql').resolve(strict=True)if name=='psql'else Path(shutil.which(name)or'/nonexistent').resolve(strict=True)
        need(pin(actual)==row,'Runtime system tool differs from admitted input: '+name)
    for group in ['runtime_libraries','libraries']:
        for row in manifest['external'][group].values():checked(row)
    need(set(manifest['artifacts']['rust'])=={'relayer','validator','scraper'}and set(manifest['artifacts']['zig'])==set(MODES),'Prepared product closure differs')
    return {'authority':value,'authority_pin':authority_pin,'source':pins,'gates':gates,'method':sequence[index],'reuse':joined,'reuse_pin':reuse_pin,'inputs_root':root,'manifest':manifest,'manifest_pin':joined['input_manifest']}

def source_recheck(context,repo):
    for item in context['source'].values():checked(item)
    need(current_head(repo)==context['authority']['execution_source_commit'],'Runtime Source HEAD changed')
    for row in context['manifest']['files']:checked(row,context['inputs_root'])


def no_bytecode(repo):
    need(sys.pycache_prefix is None,'Runtime Source pycache prefix refused')
    for name in ['zig/bench','zig/integration','zig/tools']:
        for path in(Path(repo)/name).rglob('*'):need(path.name!='__pycache__'and path.suffix not in {'.pyc','.pyo'},'Runtime Source bytecode refused')

@contextlib.contextmanager
def original_modules(repo,source):
    """Compile exact checked Source bytes, canonical names, no stale module reuse."""
    no_bytecode(repo);names={name for name,_ in LOADS}|{'zig','zig.integration'};need(not any(name in sys.modules for name in names),'Foreign preloaded original module refused')
    saved_path=list(sys.path);installed=[]
    try:
        for name,path in [('zig',repo/'zig'),('zig.integration',repo/'zig/integration')]:
            module=types.ModuleType(name);module.__path__=[str(path)];module.__package__=name;sys.modules[name]=module;installed.append(name)
        modules={}
        for name,relative in LOADS:
            path=checked(source[relative]);wire=path.read_bytes();need(sha(wire)==source[relative]['sha256'],'Original Source changed before compile')
            module=types.ModuleType(name);module.__file__=str(path);module.__package__=name.rpartition('.')[0];sys.modules[name]=module;installed.append(name)
            exec(compile(wire,str(path),'exec'),module.__dict__);modules[name]=module
            if name=='zig.integration.validator':setattr(sys.modules['zig.integration'],'validator',module)
        yield modules
    finally:
        sys.path[:]=saved_path
        for name in reversed(installed):sys.modules.pop(name,None)


def product(context,group,name,mode=None):
    rows=context['manifest']['artifacts'][group]
    if mode is not None:rows=rows[mode]
    return checked(rows[name],context['inputs_root'])

def environment(context,mode):
    rows=context['manifest']['artifacts']['zig'][mode]
    result={key:str(checked(rows[name],context['inputs_root']))for name,key in ENV_KEYS.items()}
    libraries=context['manifest']['external']['runtime_libraries']
    result['HYPERLANE_CURL_LIBRARY']=str(checked(libraries['libcurl.so.4']));result['HYPERLANE_CLOUD_CURL_LIBRARY']=result['HYPERLANE_CURL_LIBRARY']
    return result

class Launches:
    """Outer constructor factory; original class/methods and measured clocks intact."""
    def __init__(self,context):
        self.context=context;self.mode=context['method']['mode'];self.sdk=environment(context,self.mode);self.instances=[];self.identities={}
        for implementation in ['rust','zig']:
            for role in ['relayer','validator','scraper']:
                row=pin(product(context,implementation,role,self.mode if implementation=='zig'else None));identity=(row['bytes'],row['sha256']);need(identity not in self.identities,'Ambiguous daemon product identity');self.identities[identity]=(implementation,role)
    def factory(self,original):
        def create(*args,**kwargs):
            binary=Path(args[0]if args else kwargs['binary']);row=pin(binary);need((row['bytes'],row['sha256'])in self.identities,'Unadmitted measured daemon')
            implementation,role=self.identities[(row['bytes'],row['sha256'])]
            values=list(args);original_env=values[2]if len(values)>2 else kwargs['env'];need(type(original_env)is dict,'Original daemon environment required');before=dict(original_env)
            if implementation=='zig':
                changed=dict(original_env)
                for key,value in self.sdk.items():
                    if key in changed and changed[key]!=value:
                        # Original URL helper pins a byte-identical owned alias.
                        need(pin(Path(changed[key]))['sha256']==pin(Path(value))['sha256'],'Original SDK environment differs')
                    else:changed[key]=value
                if len(values)>2:values[2]=changed
                else:kwargs={**kwargs,'env':changed}
            instance=original(*values,**kwargs);need(original_env==before,'Original environment mutated')
            self.instances.append((instance,implementation,role,row));return instance
        return create
    def actual_waits(self):
        rows=[]
        for ordinal,(instance,implementation,role,binary)in enumerate(self.instances):
            usage=instance.usage;need(usage is not None and instance.end_ns is not None and instance.status==instance.p.returncode,'Original measured direct wait missing')
            rows.append({'launch_ordinal':ordinal,'implementation':implementation,'role':role,'binary':binary,'pid':instance.p.pid,'direct_parent_pid':os.getpid(),'actual_original_wait4':True,'exit_code':instance.status,'original_start_ns':instance.start_ns,'original_end_ns':instance.end_ns,'user_seconds':usage.ru_utime,'system_seconds':usage.ru_stime,'max_child_RSS_bytes':usage.ru_maxrss*1024,'voluntary_context_switches':usage.ru_nvcsw,'involuntary_context_switches':usage.ru_nivcsw,'scope':'Existing original direct-child kernel wait4 usage; not whole harness or daemon CPU. Expected Rust signal exits preserved.'})
        return rows


def bind_actual_samples(waits,samples,role):
    """Cross-bind existing raw stop metrics to actual original instance usage."""
    primary=[row for row in waits if row['role']==role]
    keys={'validator':['measurements'],'scraper':['first_process','restart_process'],'relayer':['first_stop','restart_stop']}[role]
    need(len(primary)==10*len(keys),'Actual initial/restart direct wait count differs')
    for ordinal,sample in enumerate(samples):
        for phase,key in enumerate(keys):
            actual=primary[ordinal*len(keys)+phase];need(actual['implementation']==sample['implementation'],'Measured launch implementation order differs')
            metrics=sample.get(key);need(type(metrics)is dict,'Original raw stop metric absent')
            for source,target in [('exit_code','exit_code'),('user_seconds','user_seconds'),('system_seconds','system_seconds'),('max_rss_bytes','max_child_RSS_bytes'),('voluntary_context_switches','voluntary_context_switches'),('involuntary_context_switches','involuntary_context_switches')]:
                need(metrics.get(source)==actual[target],'Original raw wait4 fields differ from actual measured instance')
            actual.update(sample=ordinal//2,pair_position=ordinal%2,original_stop_field=key,process_phase='initial'if phase==0 else'same_db_restart')
    return waits


def copy_identical(source,target):
    need(not target.is_symlink()and target.resolve(strict=False)==target,'Runtime data link refused');target.parent.mkdir(parents=True,exist_ok=True)
    if target.exists():need(pin(target)['sha256']==pin(source)['sha256'],'Preserve different runtime data')
    else:
        with target.open('xb')as output,source.open('rb')as stream:shutil.copyfileobj(stream,output)
        need(pin(target)['sha256']==pin(source)['sha256'],'Runtime data copy changed')


def bind_cache(module,context,label,repo):
    evm=module;root=context['inputs_root'];manifest=context['manifest']
    for row in manifest['repository_fixture_files']:
        name=row['repository_path'];need(name.startswith(('zig/integration/.deps/','zig/integration/.cache/'))and '..'not in Path(name).parts,'Fixed repository fixture data only');copy_identical(checked(row['file'],root),repo/name)
    selected={'validator':root/'repository/zig/integration/.cache/whole-validator/contracts.json','relayer':root/'repository/zig/integration/.cache/relayer-contracts/contracts.json','scraper':root/'fixture-provenance/scraper.contracts.json'}[label]
    admitted=pin(selected);original=evm.compile_contracts;original_run=evm.run;observed=[]
    def no_compile(args,**kwargs):
        need(not(args and str(args[0])in {'pnpm','solc','cargo','rustc','clang','cc'}),'Runtime fixture compiler/acquisition refused');return original_run(args,**kwargs)
    evm.run=no_compile
    original_subprocess=evm.subprocess
    def no_compile_child(args,*values,**kwargs):
        need(not(args and Path(str(args[0])).name in {'pnpm','solc','cargo','rustc','clang','cc'}),'Runtime fixture compiler/acquisition refused before fork')
        return original_subprocess.run(args,*values,**kwargs)
    # Only this original module's subprocess binding changes, not the stdlib or
    # any MeasuredProcess. Actual compile_contracts calls subprocess.run directly.
    evm.subprocess=types.SimpleNamespace(run=no_compile_child,Popen=original_subprocess.Popen,PIPE=original_subprocess.PIPE,TimeoutExpired=original_subprocess.TimeoutExpired)
    def cached():
        for package in evm.DEPENDENCIES:need((evm.HERE/'.deps'/package/'package/package.json').is_file(),'Admitted dependency data missing; no acquisition')
        need(pin(selected)==admitted,'Published fixture cache changed');inputs=evm.compiler_inputs();current=sha(json.dumps(inputs,sort_keys=True).encode());value=read(selected)
        need(value.get('input_digest')==current,'Original compiler inputs do not match published preset')
        target=evm.CACHE/'contracts.json';copy_identical(selected,target);need(read(target)['input_digest']==current,'Owned fixture cache digest differs')
        output=original();observed.append({'preset':label,'original_compiler_input_digest':current,'published_cache':admitted,'actual_original_compiler_cache_hit':True,'compiler_child_executed':False});return output
    evm.compile_contracts=cached;return observed


def argv_for(context,output,raw_output,baseline):
    method=context['method'];mode=method['mode'];role=method['role'];root=context['inputs_root'];manifest=context['manifest'];proofs=context['reuse']['proofs'][mode]
    values={'@rust':str(product(context,'rust',role)),'@zig':str(product(context,'zig',role,mode)),'@migration-bin':str(product(context,'tools','init-db')),'@url-library':str(product(context,'zig','url',mode)),'@rust-validator':str(product(context,'rust','validator')),'@zig-validator':str(product(context,'zig','validator',mode)),'@oracle':str(product(context,'tools','ziggy-rocks-oracle')),'@baseline-provenance':str(baseline),'@relayer-process-proof':str(checked(proofs['relayer_process'])),'@relayer-stream-proof':str(checked(proofs['relayer_stream'])),'@public-relay-proof':str(checked(proofs['public_relay_process'])),'@output':str(raw_output)}
    args=[];original=method['argv'];index=0
    while index<len(original):
        word=original[index]
        if word=='--zig-toolchain':index+=2;continue
        args.append(values.get(word,word));index+=1
    need(not any('@'==word[:1]for word in args),'Unknown workload placeholder')
    if role=='validator':
        pos=args.index('--rust-build-description')+1;args[pos]='Actual Source-qualified '+manifest['baseline_profile']+'; original input-stage Cargo/CPU/build receipts govern provenance, not host tool metadata.'
        args+=['--message-reference',str(product(context,'tools','ziggy-rust-reference')),'--evm-oracle',str(checked(manifest['artifacts']['evm_oracle'],root))]
    if role=='relayer':
        tool=checked(manifest['artifacts']['tool_manifest'],root);args+=['--tool-manifest',str(tool),'--tool-manifest-sha256',pin(tool)['sha256'],'--tool-source-commit',manifest['producer_source_commit']]
    return args


def raw_catalog(root):
    rows=[];total=0
    for path in sorted(root.rglob('*')):
        need(not path.is_symlink(),'Raw output symlink refused')
        if path.is_file():
            row=pin(path);total+=row['bytes'];need(total<=4*1024**3 and len(rows)<50000,'Raw runtime output bound');rows.append(row)
    return {'root':str(root),'files':rows,'bytes':total}


def runtime_paths(context,repo,output,index):
    """Same closed pre-launch roots and PG identity for worker/outer recovery."""
    output=Path(output);repo=Path(repo);need(type(index)is int and 0<=index<10 and context['method']['index']==index,'Runtime path method index differs')
    token=sha((str(output)+context['authority_pin']['sha256']).encode())[:32]
    raw=(repo/'zig/bench/results'/('scraper-process-linux-'+token+'-'+str(index)))if context['method']['role']=='scraper'else output/'raw'
    result={'raw_output':raw,'owned_write_roots':[output,raw,repo/'zig/bench/.cache',repo/'zig/integration/.cache',repo/'zig/integration/.deps'],'postgres':None}
    if context['method']['role']=='scraper':
        receipts=output/'postgres'
        result['postgres']={'docker':context['manifest']['external']['tools']['docker'],'docker_config':receipts/'docker-config','token':token,'receipts':receipts,'journal':receipts/'paired-postgres-owner.json'}
    return result


def worker(context,repo,output,index,execution_deadline,cleanup_deadline):
    need(time.monotonic()<execution_deadline-40,'Original runtime positive-work budget exhausted')
    source_recheck(context,repo);output=Path(output);need(output.is_absolute()and output.parent.resolve()==output.parent and not output.exists()and not output.is_relative_to(repo),'Fresh outer runtime output required');output.mkdir(mode=0o700)
    role=context['method']['role'];mode=context['method']['mode'];paths=runtime_paths(context,repo,output,index);raw=paths['raw_output']
    need(not raw.exists()and not raw.is_symlink(),'Preserve old raw workload')
    artifacts=context['manifest']['artifacts'];baseline=output/'baseline-provenance.json'
    provenance={'baseline':'c520224'}
    for name,group,member,selected_mode in [('rust','rust','relayer',None),('zig','zig','relayer',mode),('rust_validator','rust','validator',None),('zig_validator','zig','validator',mode),('oracle','tools','ziggy-rocks-oracle',None)]:provenance[name+'_sha256']=[pin(product(context,group,member,selected_mode))['sha256'][:32],pin(product(context,group,member,selected_mode))['sha256'][32:]]
    write(baseline,provenance);launches=Launches(context);result=None
    with original_modules(repo,context['source'])as modules:
        cpu_path=Path('/proc/cpuinfo')
        with cpu_path.open()as stream:cpu_text=stream.read(1024**2+1)
        need(len(cpu_text)<=1024**2,'Bounded actual CPU observation');available=modules['paired_runtime_cpu'].cpu_flags(cpu_text,intersection=True)
        required=context['manifest']['required_cpu_flags'];need(type(required)is list and required and set(required)<=set(available),'Runtime consumer CPU lacks compiled instruction flags')
        module=modules[role];cache=bind_cache(modules['evm'],context,role,repo)
        for name in ['validator','relayer','scraper']:modules[name].MeasuredProcess=launches.factory(modules[name].MeasuredProcess)
        optional=[]
        if role=='scraper':
            original_run=module.run
            def runtime_run(args,**kwargs):
                if list(map(str,args))==['pnpm','dlx','solc@0.8.33','--version']:
                    optional.append({'command':'original optional solc-version','executed':False,'reason':'runtime-only compiler-version refused; actual preparation provenance separate'});raise Refused('Runtime compiler-version command not executed; input-stage compiler receipt supplied separately')
                return original_run(args,**kwargs)
            module.run=runtime_run;pg=modules['paired_linux_postgres'];handoff=paths['postgres'];receipts=handoff['receipts'];receipts.mkdir()
            module.Postgres=pg.bind_postgres(module,pg.POLICY,**{k:handoff[k]for k in ['docker','docker_config','token','receipts']},deadline=execution_deadline,cleanup_deadline=cleanup_deadline)
        args=argv_for(context,output,raw,baseline);saved=list(sys.argv);sys.argv=[str(repo/context['method']['script']),*args]
        try:module.main()
        finally:sys.argv[:]=saved
        need(time.monotonic()<execution_deadline-40,'Original runtime worker completed late')
        data_path=raw/({'validator':'validator.json','scraper':'scraper-process.json','relayer':'manifest.json'}[role]);data=read(data_path);samples=data.get('raw_samples')
        need(isinstance(samples,list)and len(samples)==10 and[r.get('implementation')for r in samples]==ORDER and all(row.get('sample')==number//2 for number,row in enumerate(samples)),'Original five alternating paired samples absent')
        need(not data.get('failure')and not data.get('failures')and(role!='scraper'or data.get('status')=='passed')and(role!='relayer'or data.get('passed')is True),'Original workload did not pass')
        waits=launches.actual_waits();need(waits,'Actual original measured waits absent')
        bind_actual_samples(waits,samples,role)
        source_recheck(context,repo);result={'schema':1,'kind':'paired-linux-original-runtime-workload','index':index,'mode':mode,'role':role,'scenario':context['method']['scenario'],'original_main_completed':True,'actual_pairs':5,'pair_order':ORDER,'execution_source_commit':context['authority']['execution_source_commit'],'producer_source_commit':context['authority']['producer_source_commit'],'runtime_authority':context['authority_pin'],'reuse':context['reuse_pin'],'raw_result':pin(data_path),'raw_outputs':raw_catalog(raw),'actual_original_wait4_rows':waits,'fixture_cache_hits':cache,'actual_consumer_CPU':{'required_flags':required,'available_intersection_flags':sorted(available),'all_required_present':True,'cpuinfo_sha256':sha(cpu_text.encode()),'cpuinfo_bytes':len(cpu_text.encode())},'optional_tool_metadata':optional,'input_build_provenance':context['manifest']['build_receipt'],'owned_write_roots':[str(path)for path in paths['owned_write_roots']],'method_scope':'Unchanged original workload and MeasuredProcess classes; outer factory injects explicit SDK paths into Zig only; Rust original environment preserved.','allocation_counts_measured':False,'write_amplification_measured':False,'Root_final_timing_acceptance':False}
    source_recheck(context,repo);need(time.monotonic()<execution_deadline-40,'Runtime publication completed late');write(output/'result.json',result);need(time.monotonic()<execution_deadline-40,'Runtime result serialization completed late');return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ['runtime-authority','reuse','repo','output']:parser.add_argument('--'+name,type=Path,required=True)
    parser.add_argument('--runtime-authority-sha256',required=True);parser.add_argument('--reuse-sha256',required=True);parser.add_argument('--index',type=int,required=True);parser.add_argument('--execution-deadline-ns',type=int,required=True);parser.add_argument('--work-deadline-ns',type=int,required=True);args=parser.parse_args()
    context=admit(args.runtime_authority,args.runtime_authority_sha256,args.reuse,args.reuse_sha256,args.repo,args.index)
    if context is None:return
    need(args.execution_deadline_ns>0 and args.work_deadline_ns==args.execution_deadline_ns-40*10**9,'Original runtime/worker-drain clock bound')
    worker(context,args.repo,args.output,args.index,args.execution_deadline_ns/10**9,(args.execution_deadline_ns+60*10**9)/10**9)

if __name__=='__main__':main()
