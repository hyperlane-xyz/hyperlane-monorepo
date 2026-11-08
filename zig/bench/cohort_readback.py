#!/usr/bin/env python3
"""Read-only publisher/ZIP/receipt inspection. No product or native-case execution."""
from __future__ import annotations
import argparse,ast,contextlib,gzip,hashlib,io,json,math,os,posixpath,re,resource,shutil,signal,stat,struct,subprocess,sys,time,zipfile
from pathlib import Path,PurePosixPath

GIB=1024**3
REPOSITORY='hyperlane-xyz/hyperlane-monorepo'
BRANCH='feat/zig-agent-rewrite'
PRODUCER='06e263fe7950e6051502a771646bbcc6d0453369'  # Real producer; policy remains disabled pending all eight artifact pins.
REQUIRED_JOBS=('full-sdk-native (ReleaseSafe)','full-sdk-native (ReleaseFast)','native-harness-controls','svm-prerequisites')
PRODUCT_KEYS=('sdk_safe','sdk_fast','helper','tools','writer_safe','writer_fast','svm','radix_reference')
LIMITS={'wall_seconds':1800,'cleanup_seconds':60,'inspector_RAM_bytes':GIB,'child_RAM_bytes':512*1024**2,'owned_disk_bytes':8*GIB,'host_free_bytes':6*GIB,'maximum_archive_bytes':4*GIB,'compressed_total_bytes':16*GIB,'streamed_total_bytes':24*GIB,'member_count':100000,'central_directory_bytes':32*1024**2,'metadata_bytes':64*1024**2,'report_bytes':2*1024**2}
SDK_NAMES={'relayer','validator','scraper','hyperlane-aleo-vm-worker','libziggy_url.so','libziggy_regex.so','libziggy_starknet_crypto.so','libziggy_aleo_crypto.so','libziggy_aleo_vm.so'}
CPU_SCOPES={'native-db':{'relayer','validator','scraper'},'url':{'libziggy_url.so'},'regex':{'libziggy_regex.so'},'starknet':{'libziggy_starknet_crypto.so'},'aleo':{'libziggy_aleo_crypto.so','libziggy_aleo_vm.so','hyperlane-aleo-vm-worker'}}
TOOLS=('init-db','ziggy-rocks-oracle','ziggy-native-rows','ziggy-rust-reference')
HELPER_PHASES=('compile-construction','external_agents-tests','external_agents-radix_fixture-tests','external_agents-radix_contracts-tests','program-tests','cosmos-validator_config_tests','starknet-cli-tests','compile-normal','clippy')
COMPILED_SCOPES={'runtime':('zig/src','zig/native','zig/build.zig','zig/build.zig.zon'),'helper':('rust/main','rust/sealevel'),'tools':('rust/main','rust/sealevel','zig/reference')}

class Refused(RuntimeError):
    def __init__(self,code):
        assert re.fullmatch('[A-Z][A-Z0-9_]{0,63}',code)
        self.code=code
        super().__init__(code)

class TaskInterrupted(RuntimeError):pass

def need(value,code):
    if not value:raise Refused(code)

def sha(data):return hashlib.sha256(data).hexdigest()
def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
def integer(value,minimum=0,maximum=2**63-1):return type(value)is int and minimum<=value<=maximum
def digest_text(value):return isinstance(value,str)and re.fullmatch('[0-9a-f]{64}',value)is not None
def relative(value):
    need(isinstance(value,str)and value and len(value.encode())<=4096 and '\\'not in value and '\x00'not in value and '\n'not in value,'MEMBER_PATH')
    p=PurePosixPath(value)
    need(not p.is_absolute()and str(p)==value and all(x not in {'','.','..'}for x in p.parts),'MEMBER_PATH')
    return value

def unique_json(data,maximum=16*1024**2):
    need(len(data)<=maximum,'JSON_BOUND')
    def pairs(rows):
        result={}
        for key,value in rows:
            need(key not in result,'JSON_DUPLICATE');result[key]=value
        return result
    def bad_number(value):raise Refused('JSON_NONFINITE')
    value=json.loads(data,object_pairs_hook=pairs,parse_constant=bad_number)
    count=0
    def walk(node,depth=0):
        nonlocal count
        count+=1;need(depth<=32 and count<=250000,'JSON_STRUCTURE')
        if isinstance(node,dict):
            for key,item in node.items():need(isinstance(key,str),'JSON_KEY');walk(item,depth+1)
        elif isinstance(node,list):
            for item in node:walk(item,depth+1)
        elif type(node)is float:need(math.isfinite(node),'JSON_NONFINITE')
    walk(value)
    return value

def decode_policy(data):
    value=unique_json(data,1024**2)
    def decode(node):
        if isinstance(node,dict):
            if 'sha256_hex_chunks'in node:
                need(set(node)=={'sha256_hex_chunks'}and isinstance(node['sha256_hex_chunks'],list)and len(node['sha256_hex_chunks'])==2 and all(isinstance(x,str)and re.fullmatch('[0-9a-f]{32}',x)for x in node['sha256_hex_chunks']),'PUBLIC_HASH_ENCODING')
                return ''.join(node['sha256_hex_chunks'])
            return {k:decode(v)for k,v in node.items()}
        if isinstance(node,list):return [decode(v)for v in node]
        return node
    return decode(value)

def artifact_names(run,attempt):
    return {'sdk_safe':'zig-native-runtime-payload-ReleaseSafe','sdk_fast':'zig-native-runtime-payload-ReleaseFast','helper':'zig-native-harness-controls','tools':'zig-native-case-tools-'+PRODUCER,'writer_safe':'zig-native-interop-writer-ReleaseSafe','writer_fast':'zig-native-interop-writer-ReleaseFast','svm':f'svm-linux-prerequisites-{run}-{attempt}','radix_reference':'zig-native-radix-reference-'+PRODUCER}

def validate_policy(policy):
    need(isinstance(policy,dict)and set(policy)=={'schema','root_approved','scope','producer','jobs','artifacts','core607','limits'},'POLICY_KEYS')
    need(type(policy['schema'])is int and policy['schema']==1 and type(policy['root_approved'])is bool and policy['scope']=='fresh-eight-product-data-inspection','POLICY_IDENTITY')
    need(policy['limits']==LIMITS and all(type(v)is int for v in policy['limits'].values()),'POLICY_LIMITS')
    need(isinstance(policy['jobs'],dict)and isinstance(policy['artifacts'],dict)and set(policy['jobs'])==set(REQUIRED_JOBS)and set(policy['artifacts'])==set(PRODUCT_KEYS),'POLICY_CLOSURE')
    if not policy['root_approved']:return False
    need(isinstance(PRODUCER,str)and re.fullmatch('[0-9a-f]{40}',PRODUCER)is not None,'FRESH_PRODUCER_NOT_BOUND')
    producer=policy['producer']
    need(isinstance(producer,dict)and set(producer)=={'source_commit','run_id','run_attempt'}and producer['source_commit']==PRODUCER and integer(producer['run_id'],1)and integer(producer['run_attempt'],1),'POLICY_PRODUCER')
    need(all(integer(v,1)for v in policy['jobs'].values())and len(set(policy['jobs'].values()))==4,'POLICY_JOBS')
    names=artifact_names(producer['run_id'],producer['run_attempt']);ids=[]
    for key,row in policy['artifacts'].items():
        need(isinstance(row,dict)and set(row)=={'id','name','size_in_bytes','sha256'}and integer(row['id'],1)and row['name']==names[key]and integer(row['size_in_bytes'],1,LIMITS['maximum_archive_bytes'])and digest_text(row['sha256']),'POLICY_ARTIFACT')
        ids.append(row['id'])
    need(len(set(ids))==8 and sum(r['size_in_bytes']for r in policy['artifacts'].values())<=LIMITS['compressed_total_bytes'],'POLICY_ARTIFACT_CLOSURE')
    core=policy['core607'];need(isinstance(core,dict)and len(core)==607,'POLICY_CORE607')
    for name,row in core.items():
        relative(name);need(name in {'zig/build.zig','zig/build.zig.zon','zig/tools/zig.py'}or name.startswith(('zig/src/','zig/native/')),'POLICY_CORE_SOURCE_PATH')
        need(isinstance(row,dict)and set(row)=={'bytes','sha256'}and integer(row['bytes'],0,16*1024**2)and digest_text(row['sha256']),'POLICY_CORE_ROW')
    return True

def require_disabled_case(data):
    # Only the literal top-level switch is consumed here. Native policy hashes
    # may use the existing prefix/chunk wire encoding; do not reinterpret them.
    case=unique_json(data,1024**2)
    need(type(case.get('schema'))is int and case['schema']==1 and case.get('root_approved')is False,'NATIVE_SELECTOR_MUST_BE_FALSE')

def validate_remote(policy,run,jobs,artifacts):
    p=policy['producer']
    need(run.get('id')==p['run_id']and type(run.get('id'))is int and run.get('run_attempt')==p['run_attempt']and type(run.get('run_attempt'))is int and run.get('head_sha')==PRODUCER,'RUN_IDENTITY')
    need(run.get('repository',{}).get('full_name')==REPOSITORY and run.get('head_repository',{}).get('full_name')==REPOSITORY and run.get('head_branch')==BRANCH and run.get('event')=='push'and run.get('path')=='.github/workflows/zig-agents.yml','RUN_ORIGIN')
    need(run.get('status')in {'in_progress','completed'},'RUN_STATUS')
    selected=[]
    for name,identity in policy['jobs'].items():
        rows=[r for r in jobs if r.get('name')==name]
        need(len(rows)==1 and rows[0].get('id')==identity and type(rows[0].get('id'))is int and rows[0].get('run_id')==p['run_id']and rows[0].get('status')=='completed'and rows[0].get('conclusion')=='success','PRODUCER_JOB')
        selected.append({'id':identity,'name':name,'status':'completed','conclusion':'success'})
    checked={}
    for key,expected in policy['artifacts'].items():
        rows=[r for r in artifacts if r.get('id')==expected['id']]
        need(len(rows)==1,'ARTIFACT_ID_UNIQUE');row=rows[0];origin=row.get('workflow_run',{})
        need(len([r for r in artifacts if r.get('name')==expected['name']])==1,'ARTIFACT_NAME_UNIQUE')
        need(row.get('name')==expected['name']and row.get('size_in_bytes')==expected['size_in_bytes']and type(row.get('size_in_bytes'))is int and row.get('digest')=='sha256:'+expected['sha256']and row.get('expired')is False,'ARTIFACT_IDENTITY')
        need(origin.get('id')==p['run_id']and origin.get('head_sha')==PRODUCER and origin.get('head_branch')==BRANCH,'ARTIFACT_ORIGIN')
        checked[key]=dict(expected)
    return {'source_commit':PRODUCER,'run_id':p['run_id'],'run_attempt':p['run_attempt'],'required_jobs':selected,'artifacts':checked,'whole_workflow_success_claim':False}

class Guard:
    def __init__(self,root,limits=LIMITS,clock=time.monotonic,free=lambda p:shutil.disk_usage(p).free):
        self.root=root;self.limits=limits;self.clock=clock;self.started=clock();self.deadline=self.started+limits['wall_seconds'];self.cleanup_deadline=self.deadline+limits['cleanup_seconds'];self.free=free;self.initial_free=free(root);self.streamed=0;self.members=0;self.phase='PREFLIGHT';self.peak_rss=0
    def __call__(self,byte_count=0):
        need(integer(byte_count,0),'GUARD_BYTE_COUNT');self.streamed+=byte_count
        need(self.clock()<self.deadline,'ORIGINAL_DEADLINE')
        need(self.streamed<=self.limits['streamed_total_bytes'],'STREAM_BYTE_CAP')
        available=self.free(self.root)
        need(available>=self.limits['host_free_bytes']and self.initial_free-available<=self.limits['owned_disk_bytes'],'DISK_GUARD')
        if sys.platform=='linux':
            raw=Path('/proc/self/statm').read_text().split();rss=int(raw[1])*os.sysconf('SC_PAGE_SIZE');self.peak_rss=max(self.peak_rss,rss)
            need(rss<=self.limits['inspector_RAM_bytes'],'INSPECTOR_RSS')
    def add_members(self,count):
        need(integer(count,0),'MEMBER_COUNT');self.members+=count;need(self.members<=self.limits['member_count'],'AGGREGATE_MEMBER_CAP');self()
    def cleanup(self):need(self.clock()<self.cleanup_deadline,'ORIGINAL_CLEANUP_DEADLINE')

def zip_directory_preflight(path):
    size=path.stat().st_size
    need(size>=22,'ZIP_TOO_SHORT')
    with path.open('rb')as f:
        f.seek(max(0,size-65557));tail=f.read();offset=tail.rfind(b'PK\x05\x06');need(offset>=0,'ZIP_EOCD')
        fields=struct.unpack_from('<4s4H2LH',tail,offset)
        need(fields[1:3]==(0,0)and fields[3]==fields[4]and offset+22+fields[7]==len(tail),'ZIP_DIRECTORY')
        need(fields[4]!=65535 and fields[5]!=0xffffffff and fields[6]!=0xffffffff,'ZIP64_OUTER_NOT_ADMITTED')
        need(0<fields[4]<=LIMITS['member_count']and fields[5]<=LIMITS['central_directory_bytes']and fields[6]+fields[5]<=size,'ZIP_DIRECTORY_BOUND')

class Archive:
    """One authenticated immutable ZIP; stream content, never materialize members."""
    def __init__(self,path,guard):
        self.path=path;self.guard=guard;zip_directory_preflight(path);guard()
        self.before=path.stat();self.zip=zipfile.ZipFile(path);self.entries={};self.catalog={};self.metadata_retained=0;self._json={}
        try:
            infos=self.zip.infolist();need(0<len(infos)<=LIMITS['member_count'],'ZIP_MEMBER_COUNT')
            if hasattr(guard,'add_members'):guard.add_members(len(infos))
            need(sum(i.file_size for i in infos)<=LIMITS['streamed_total_bytes'],'ZIP_DECLARED_EXPANSION')
            for info in infos:
                name=info.filename.rstrip('/')if info.is_dir()else info.filename;relative(name)
                need(info.orig_filename==info.filename and(not info.is_dir()or info.filename==name+'/'),'ZIP_NONCANONICAL_NAME')
                need(name not in self.entries and not(info.flag_bits&1),'ZIP_DUPLICATE_OR_ENCRYPTED')
                kind=stat.S_IFMT(info.external_attr>>16)
                need(kind in (0,stat.S_IFDIR if info.is_dir()else stat.S_IFREG),'ZIP_SPECIAL_OR_LINK')
                need(info.compress_type in (zipfile.ZIP_STORED,zipfile.ZIP_DEFLATED),'ZIP_COMPRESSION')
                self.entries[name]=info
            for name in self.entries:
                need(all(str(parent)not in self.entries or self.entries[str(parent)].is_dir()for parent in PurePosixPath(name).parents if str(parent)!='.'),'ZIP_FILE_AS_PARENT')
        except BaseException:
            self.zip.close();raise
    def close(self):self.zip.close()
    def stable(self):
        now=self.path.stat();need((now.st_dev,now.st_ino,now.st_size,now.st_mtime_ns)==(self.before.st_dev,self.before.st_ino,self.before.st_size,self.before.st_mtime_ns),'ARCHIVE_MUTATED');self.guard()
    def files(self,prefix=''):return {n for n,i in self.entries.items()if not i.is_dir()and n.startswith(prefix)}
    def _info(self,name):relative(name);need(name in self.entries and not self.entries[name].is_dir(),'MEMBER_MISSING');return self.entries[name]
    def stream(self,name,consume=None):
        info=self._info(name);h=hashlib.sha256();size=0
        with self.zip.open(info)as source:
            for block in iter(lambda:source.read(1024**2),b''):
                self.guard(len(block));size+=len(block);need(size<=info.file_size,'MEMBER_SIZE');h.update(block)
                if consume is not None:consume(block)
        need(size==info.file_size,'MEMBER_TRUNCATED');row={'bytes':size,'sha256':h.hexdigest()};self.catalog[name]=row;self.stable();return row
    def bytes(self,name,maximum=16*1024**2):
        info=self._info(name);need(info.file_size<=maximum,'MEMBER_MEMORY_BOUND');out=bytearray();self.stream(name,out.extend);return bytes(out)
    def data(self,name):
        if name not in self._json:
            body=self.bytes(name);self.metadata_retained+=len(body);need(self.metadata_retained<=LIMITS['metadata_bytes'],'METADATA_MEMORY_BOUND');self._json[name]=unique_json(body)
        return self._json[name]
    def pin(self,name):return self.catalog.get(name)or self.stream(name)
    def match(self,name,row):
        actual=self.pin(name);need(integer(row.get('bytes'),0)and digest_text(row.get('sha256'))and actual=={'bytes':row['bytes'],'sha256':row['sha256']},'MEMBER_DIGEST');return actual
    def read_at(self,name,offset,count):
        info=self._info(name);need(integer(offset,0,info.file_size)and integer(count,0,65536)and offset+count<=info.file_size,'ELF_READ_BOUND')
        # Charge replay as well as returned bytes: no hidden decompression work.
        with self.zip.open(info)as source:
            left=offset
            while left:
                block=source.read(min(left,1024**2));need(block,'ELF_READ_TRUNCATED');self.guard(len(block));left-=len(block)
            out=source.read(count);self.guard(len(out));need(len(out)==count,'ELF_READ_TRUNCATED');return out
    def finish(self):
        for name in sorted(self.files(),key=lambda n:self.entries[n].header_offset):
            if name not in self.catalog:self.stream(name)
        self.stable();return {'files':len(self.catalog),'expanded_bytes':sum(r['bytes']for r in self.catalog.values()),'catalog_sha256':sha(canonical(self.catalog))}

def elf(archive,name,machine=62,kind='executable'):
    size=archive._info(name).file_size;header=archive.read_at(name,0,64)
    need(header[:7]==b'\x7fELF\x02\x01\x01'and header[7]in (0,3),'ELF_HEADER')
    filetype,observed,version=struct.unpack_from('<HHI',header,16);entry,phoff=struct.unpack_from('<QQ',header,24);ehsize,phsize,phcount=struct.unpack_from('<HHH',header,52)
    need(observed==machine and version==1 and ehsize==64,'ELF_MACHINE')
    if kind=='program':need(filetype==3 and machine in (247,263)and header[7]==0,'SBF_HEADER');return {'machine':machine,'type':filetype,'class':64,'endianness':'little'}
    need(filetype in (2,3)and phsize==56 and 1<=phcount<=1024 and phoff>=64 and phoff+phsize*phcount<=size,'ELF_PROGRAM_HEADERS')
    table=archive.read_at(name,phoff,phsize*phcount);loads=[];interpreters=[]
    for i in range(phcount):
        tag,flags,offset,virtual,physical,filesz,memsz,alignment=struct.unpack_from('<IIQQQQQQ',table,i*56)
        need(offset<=size and filesz<=size-offset,'ELF_SEGMENT_RANGE')
        if tag==1:need(memsz>=filesz,'ELF_LOAD_SIZE');loads.append((virtual,memsz,flags))
        if tag==3:
            need(1<filesz<=4096,'ELF_INTERPRETER_SIZE');value=archive.read_at(name,offset,filesz);need(value.endswith(b'\0')and b'\0'not in value[:-1],'ELF_INTERPRETER_TERMINATOR')
            value=value[:-1].decode('ascii');need(value.startswith('/')and '\n'not in value and '..'not in PurePosixPath(value).parts,'ELF_INTERPRETER_PATH');interpreters.append(value)
    need(loads and len(interpreters)<=1,'ELF_LOADS')
    if kind=='executable':need(entry!=0 and any(flags&1 and address<=entry<address+length for address,length,flags in loads)and(filetype==2 or len(interpreters)==1),'ELF_EXECUTABLE_ENTRY')
    else:need(kind=='library'and filetype==3 and not interpreters,'ELF_LIBRARY')
    return {'class':64,'endianness':'little','machine':machine,'type':filetype,'interpreter':interpreters[0]if interpreters else None}

def literal_constants(source,names):
    """Evaluate literal producer catalogs only; never import producer modules."""
    tree=ast.parse(source);values={}
    def value(node):
        if isinstance(node,ast.Name):need(node.id in values,'CONSTANT_REFERENCE');return values[node.id]
        if isinstance(node,ast.Constant):return node.value
        if isinstance(node,(ast.List,ast.Tuple,ast.Set)):
            rows=[value(n)for n in node.elts];return rows if isinstance(node,ast.List)else tuple(rows)if isinstance(node,ast.Tuple)else set(rows)
        if isinstance(node,ast.Dict):return {value(k):value(v)for k,v in zip(node.keys,node.values)}
        if isinstance(node,ast.BinOp)and isinstance(node.op,ast.Add):return value(node.left)+value(node.right)
        raise Refused('NONLITERAL_PRODUCER_CATALOG')
    for node in tree.body:
        if isinstance(node,ast.Assign)and len(node.targets)==1:
            target=node.targets[0]
            if isinstance(target,ast.Name):
                try:values[target.id]=value(node.value)
                except Refused:pass
            elif isinstance(target,ast.Subscript)and isinstance(target.value,ast.Name)and target.value.id in names:
                need(target.value.id in values,'CATALOG_SUBSCRIPT');values[target.value.id][value(target.slice)]=value(node.value)
    need(set(names)<=set(values),'PRODUCER_CATALOG_MISSING');return {n:values[n]for n in names}

def origin_rows(rows,git_source):
    need(isinstance(rows,dict)and 0<len(rows)<=20000,'SOURCE_CATALOG')
    symlinks=0
    for name,row in rows.items():
        relative(name);need(isinstance(row,dict),'SOURCE_ROW')
        if row.get('type')=='symlink':
            target=row.get('target');need(set(row)=={'path','type','target'}and isinstance(target,str)and 0<len(target.encode())<=4096 and not target.startswith('/')and not any(c in target for c in ['\\','\x00','\n']),'SOURCE_SYMLINK')
            resolved=posixpath.normpath(posixpath.join(posixpath.dirname(name),target));relative(resolved)
            need(git_source.bytes(name)==target.encode(),'SOURCE_SYMLINK_ORIGIN');symlinks+=1
        else:
            need(integer(row.get('bytes'),0,16*1024**2)and digest_text(row.get('sha256')),'SOURCE_ROW')
            actual=git_source.digest(name)
            need(actual=={'bytes':row['bytes'],'sha256':row['sha256']},'SOURCE_ORIGIN')
    return {'count':len(rows),'symlink_count':symlinks,'catalog_sha256':sha(canonical(rows)),'all_declared_rows_match_producer_Git':True}

def member_row(archive,row,name=None):
    need(isinstance(row,dict),'MEMBER_DESCRIPTOR')
    path=name if name is not None else row.get('path',row.get('relative_path'))
    relative(path);archive.match(path,row);return path

def clean_wait(row):
    need(isinstance(row,dict)and row.get('actual_parent_wait')is True and type(row.get('exit_code'))is int and row['exit_code']==0 and row.get('error')is None,'ACTUAL_WAIT')
    cleanup=row.get('cleanup');need(isinstance(cleanup,dict)and cleanup.get('clean')is True and not cleanup.get('signals'),'PRODUCER_CLEANUP')
    need(not[v for v in cleanup.get('owned_present_before_stop',[])if v.get('pid')!=row.get('pid')],'PRODUCER_RESIDUE')

def native_required_tests(git_source):
    # Producer-Git data only: never import the container checker or its helpers.
    tree=ast.parse(git_source.bytes('zig/tools/container_check.py'))
    bindings=[n for n in tree.body if isinstance(n,(ast.Assign,ast.AnnAssign,ast.AugAssign))and any(isinstance(t,ast.Name)and t.id=='NATIVE_REQUIRED'for t in (n.targets if isinstance(n,ast.Assign)else[n.target]))]
    need(len(bindings)==1 and isinstance(bindings[0],ast.Assign)and len(bindings[0].targets)==1 and isinstance(bindings[0].value,(ast.Tuple,ast.List))and all(isinstance(n,ast.Constant)and isinstance(n.value,str)for n in bindings[0].value.elts),'NATIVE_REQUIRED_CATALOG')
    required=ast.literal_eval(bindings[0].value)
    need(isinstance(required,(tuple,list))and 0<len(required)<=512 and all(isinstance(n,str)and re.fullmatch('[A-Za-z0-9][A-Za-z0-9 ._(),:/+-]{0,511}',n)is not None and n.strip()==n for n in required)and len(set(required))==len(required),'NATIVE_REQUIRED_CATALOG')
    return required

def suite_counts(native,producer_required=()):
    tests=native.get('tests');need(isinstance(tests,dict)and integer(tests.get('total'),1),'NATIVE_SUITE')
    rows=tests.get('per_test');need(isinstance(rows,list)and len(rows)==tests['total'],'NATIVE_SUITE_ROWS')
    counts={'OK':0,'SKIP':0,'FAIL':0};names=set()
    for i,row in enumerate(rows,1):
        need(isinstance(row,dict)and row.get('ordinal')==i and type(row.get('ordinal'))is int and row.get('total')==tests['total']and row.get('status')in counts and isinstance(row.get('name'),str)and row['name']not in names,'NATIVE_SUITE_ROW')
        names.add(row['name']);counts[row['status']]+=1
    need(counts['FAIL']==0 and counts['OK']>0 and isinstance(tests.get('skipped'),dict)and len(tests['skipped'])==counts['SKIP'],'NATIVE_SUITE_OUTCOME')
    required=('readonly signed recovery allocation failure on every read path leaves Manual signed accounting and canonical bytes unchanged','readonly signed recovery every grouped allocation failure preserves journal nonce current owner member and signed rows','native group guards committed creation followed by load OOM remains durably owned and recoverable')
    need(all(any(r['name'].endswith(name)and r['status']=='OK'for r in rows)for name in required),'RECOVERY_ALLOCATION_TESTS')
    for name in producer_required:
        matches=[r for r in rows if r['name'].endswith('.test.'+name)]
        need(len(matches)==1 and matches[0]['status']=='OK','PRODUCER_NATIVE_REQUIRED_TESTS')
    return {'total':tests['total'],'status_counts':counts,'skip_catalog_sha256':sha(canonical(tests['skipped'])),'three_recovery_allocation_tests_observed_OK':True,'producer_native_required_count':len(producer_required)}

def validate_sdk(archive,mode,git_source):
    manifest=archive.data('manifest.json')
    need(manifest.get('passed')is True and manifest.get('source_commit')==PRODUCER and manifest.get('mode')==mode and manifest.get('platform')=='linux/amd64','SDK_IDENTITY')
    need(manifest.get('native_case_acceptance')is False and manifest.get('image_started_by_exporter')is False and manifest.get('exact_created_CID_removed')is True and not manifest.get('cleanup_error'),'SDK_EXPORT_SCOPE')
    # Exporter absence probes deliberately accept exit1. Its checked error=None
    # plus actual wait is the original contract; never invent all-zero exits.
    calls=manifest.get('calls');need(isinstance(calls,list)and calls and all(r.get('actual_parent_wait')is True and r.get('error')is None and type(r.get('exit_code'))is int for r in calls),'SDK_EXPORT_WAITS')
    need(set(manifest.get('artifacts',{}))==SDK_NAMES,'SDK_NINE')
    inputs=manifest['inputs'];native_name=member_row(archive,inputs['native']);runtime_name=member_row(archive,inputs['runtime']);native=archive.data(native_name);runtime=archive.data(runtime_name)
    need(native.get('passed')is True and runtime.get('passed')is True and native.get('mode')==mode and type(native.get('exit_code'))is int and native['exit_code']==0,'SDK_ACTUAL_TEST_RECEIPTS')
    expected=native.get('artifact_sha256');need(isinstance(expected,dict)and set(expected)==SDK_NAMES and runtime.get('artifact_sha256')==expected and all(digest_text(v)for v in expected.values()),'SDK_TESTED_RUNTIME_IDENTITIES')
    product_rows={};closed={'manifest.json',native_name,runtime_name}
    for name,row in manifest['artifacts'].items():
        path=member_row(archive,row);closed.add(path);need(row['sha256']==expected[name],'SDK_TESTED_COPY')
        observed=elf(archive,path,kind='library'if name.startswith('lib')else'executable')
        product_rows[name]={'bytes':row['bytes'],'sha256':row['sha256'],'ELF_machine':observed['machine'],'ELF_type':observed['type']}
    provenance=manifest.get('build_provenance');need(isinstance(provenance,dict)and set(provenance)==set(CPU_SCOPES),'SDK_CPU_SCOPES')
    advertised=manifest.get('required_cpu_flags');need(isinstance(advertised,list)and advertised and advertised==sorted(set(advertised))and all(isinstance(v,str)and re.fullmatch('[A-Za-z0-9_.+-]+',v)for v in advertised)and manifest.get('consumer_cpu_superset_required')is True,'SDK_CPU_ADMISSION_POLICY')
    cpu=[]
    for scope,row in provenance.items():
        path=member_row(archive,row);closed.add(path);value=archive.data(path)
        need(set(value)=={'schema','scope','mode','source_commit','architecture','flags','artifacts'}and type(value['schema'])is int and value['schema']==1 and value['scope']==scope and value['mode']==mode and value['source_commit']==PRODUCER and value['architecture']=='amd64','SDK_CPU_IDENTITY')
        flags=value['flags'];need(isinstance(flags,list)and flags and all(isinstance(v,str)and re.fullmatch('[A-Za-z0-9_.+-]+',v)for v in flags)and flags==sorted(set(flags)),'SDK_CPU_FLAGS')
        need(set(flags)<=set(advertised),'SDK_ADVERTISED_CPU_COVERAGE')
        need(set(value['artifacts'])==CPU_SCOPES[scope],'SDK_CPU_ARTIFACTS')
        for key,pin in value['artifacts'].items():need(pin=={'bytes':manifest['artifacts'][key]['bytes'],'sha256':expected[key]},'SDK_CPU_BYTES')
        cpu.append({'scope':scope,'flag_count':len(flags),'flags_sha256':sha(canonical(flags)),'receipt_sha256':archive.pin(path)['sha256']})
    need(archive.files()==closed,'SDK_CLOSED_MEMBERS')
    return {'mode':mode,'source_commit':PRODUCER,'products':product_rows,'native_suite':suite_counts(native,native_required_tests(git_source)),'CPU_receipts':cpu,'export_actual_waits':len(calls),'export_created_CID_removed':True,'actual_consumer_CPU_superset_checked':False,'SDK_or_native_product_executed_by_reader':False}

def validate_helper(archive,git_source):
    result=archive.data('result.json');need(result.get('passed')is True and result.get('source_commit')==PRODUCER and result.get('source_unchanged')is True and result.get('all_owned_jobs_joined')is True and result.get('error')is None and result.get('native_case_acceptance')is False,'HELPER_GATE')
    need(archive.data('job-status.json').get('primary_job_status')=='success','HELPER_PRIMARY_STATUS')
    source=archive.data('authoritative-source.json');origins=origin_rows(source,git_source)
    required=literal_constants(git_source.bytes('zig/bench/native_harness_controls.py').decode(),{'REQUIRED_TESTS'})['REQUIRED_TESTS'];observed=set();testcounts={}
    rows=result.get('checks');need(isinstance(rows,list)and [r.get('name')for r in rows]==list(HELPER_PHASES),'HELPER_PHASES')
    for row in rows:
        clean_wait(row);logname=Path(row['log']['path']).name;need(logname==row['name']+'.log','HELPER_LOG_PATH');member_row(archive,row['log'],logname);text=archive.bytes(logname,8*1024**2).decode()
        count=row.get('actual_tests_passed')
        if count is not None:
            need(integer(count,1),'HELPER_TEST_COUNT');match=re.search(r'test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored;',text)
            need(match and int(match[1])==count and int(match[2])==0 and int(match[3])==0,'HELPER_TEST_LOG')
            names=row.get('required_new_tests_observed');need(isinstance(names,list)and len(set(names))==len(names),'HELPER_REQUIRED_NAMES')
            for name in names:need(isinstance(name,str)and 'test '+name+' ... ok'in text,'HELPER_REQUIRED_TEST_LOG');observed.add(name)
            testcounts[row['name']]=count
    need(all(set(names)<=observed for names in required.values()),'HELPER_REQUIRED_CENSUS')
    need(len([name for name in observed if 'checker_deadline_'in name])==5,'HELPER_STRICT_CALLER_DEADLINES')
    stark_names={'starknet::cli::tests::invoke_and_send_tx_reject_failed_cli_status','starknet::cli::tests::invoke_and_send_tx_accept_successful_cli_status'}
    need(set(required.get('starknet::cli::tests::',[]))==stark_names,'HELPER_STARK_CLI_SOURCE_CENSUS')
    stark_row=next(row for row in rows if row['name']=='starknet-cli-tests')
    need(set(stark_row.get('required_new_tests_observed',[]))==stark_names and integer(stark_row.get('actual_tests_passed'),2),'HELPER_STARK_CLI_ACTUAL_TESTS')
    products=result.get('products');need(isinstance(products,dict)and set(products)=={'normal','construction'},'HELPER_PRODUCTS');out={}
    for name,row in products.items():
        need(row['artifact_relative_path']=='products/'+name,'HELPER_PRODUCT_PATH')
        path=member_row(archive,row['published'],row['artifact_relative_path']);need(row['producer']['bytes']==row['published']['bytes']and row['producer']['sha256']==row['published']['sha256'],'HELPER_CARGO_COPY');observed_elf=elf(archive,path)
        out[name]={**archive.pin(path),'ELF_machine':observed_elf['machine']}
    # The actual producer uploads its entire evidence root: tools/reference
    # duplicates and dependency-stage evidence are intentional members.
    tool_files={'manifest.json','partial.json','plan.json','source-gate.json'}|{'bin/'+n for n in TOOLS}|{n+'.log'for n in ['build-'+n for n in TOOLS]+['test-ziggy-rocks-oracle','test-ziggy-native-rows']}
    radix=literal_constants(git_source.bytes('zig/bench/native_radix_reference.py').decode(),{'CHECKS','BIN'})
    radix_files={'manifest.json','partial.json','source-gate.json','producer-cpuinfo.txt','bin/'+radix['BIN']}|{n+'.log'for n in radix['CHECKS']}
    own={'result.json','partial.json','authoritative-source.json','generated-compiler-inputs.json','job-status.json','products/normal','products/construction'}|{n+'.log'for n in HELPER_PHASES}
    stage={'radix-reference-stage/'+n for n in ['fetch.log','producer-cpuinfo.txt','partial.json','source-gate.json']}|{'setup/tools-platform.txt'}
    need(archive.files()==own|stage|{'native-case-tools/'+n for n in tool_files}|{'native-radix-reference/'+n for n in radix_files},'HELPER_CLOSED_MEMBERS')
    def embedded(prefix,names):return sha(canonical({n:archive.pin(prefix+n)for n in names}))
    return {'source_commit':PRODUCER,'Source_origin':origins,'actual_phase_waits':len(rows),'actual_test_counts':testcounts,'required_census_names_observed':len(observed),'five_strict_deadline_tests_observed':True,'products':out,'product_execution':False,'embedded_tools_catalog_sha256':embedded('native-case-tools/',tool_files),'embedded_radix_catalog_sha256':embedded('native-radix-reference/',radix_files)}

def validate_writer(archive,mode,git_source):
    value=archive.data('manifest.json');need(value.get('passed')is True and value.get('source_commit')==PRODUCER and value.get('mode')==mode,'WRITER_IDENTITY')
    need(value.get('writer_executed')is False and value.get('native_case_acceptance')is False and value.get('component_interoperability_acceptance')is False and value.get('input_before')==value.get('input_after'),'WRITER_SOURCE_FENCE')
    declared=value['input_before'];need(isinstance(declared,list)and len(declared)==10 and len({r.get('path')for r in declared})==10,'WRITER_INPUT_CLOSURE')
    source_rows={}
    for row in declared:
        need(isinstance(row,dict)and set(row)=={'path','bytes','sha256'}and isinstance(row['path'],str)and row['path'].startswith('/')and integer(row['bytes'],1)and digest_text(row['sha256']),'WRITER_INPUT_PIN')
        for logical in ('zig/src/native_rows_interop_fixture.zig','zig/tools/zig.py'):
            if row['path'].endswith('/'+logical):source_rows[logical]=row
    need(len(source_rows)==2,'WRITER_SOURCE_ROWS');origin=origin_rows(source_rows,git_source)
    cpu=value['cpu'];need(cpu.get('architecture')=='amd64'and isinstance(cpu.get('flags'),list)and cpu['flags']and all(isinstance(v,str)and re.fullmatch('[A-Za-z0-9_.+-]+',v)for v in cpu['flags']),'WRITER_CPU')
    row=value['writer'];need(row.get('path')=='bin/native-rows-writer-'+mode,'WRITER_PATH');name=member_row(archive,row);observed=elf(archive,name)
    need(archive.files()=={'manifest.json',name,'diagnostics/monitor-parent.json','diagnostics/progress.jsonl','diagnostics/result.json'},'WRITER_CLOSED_MEMBERS')
    diagnostic=archive.data('diagnostics/result.json');monitor=archive.data('diagnostics/monitor-parent.json')
    need(type(diagnostic.get('exit_code'))is int and diagnostic['exit_code']==0 and diagnostic.get('primary_error')is None and diagnostic.get('cleanup_error')is None and diagnostic.get('native_or_timing_acceptance')is False and monitor.get('primary_error')is None,'WRITER_ACTUAL_COMPILER_OUTCOME')
    for cleanup in [diagnostic.get('cleanup'),monitor.get('cleanup')]:
        need(isinstance(cleanup,dict)and cleanup.get('actual_parent_wait')is True and type(cleanup.get('exit_code'))is int and cleanup['exit_code']==0 and cleanup.get('clean')is True and cleanup.get('cleanup_confirmed_absent')is True and not cleanup.get('signals')and not cleanup.get('errors'),'WRITER_ACTUAL_CLEAN_WAIT')
    return {'mode':mode,'source_commit':PRODUCER,'product':archive.pin(name),'ELF_machine':observed['machine'],'Source_origin':origin,'unchanged_declared_compiler_input_count':len(declared),'declared_compiler_input_catalog_sha256':sha(canonical(declared)),'compiler_archive_inputs_independently_present_or_executed_by_reader':False,'CPU_flags_sha256':sha(canonical(cpu['flags'])),'actual_consumer_CPU_superset_checked':False,'writer_executed_by_reader':False}

def validate_tools(archive,git_source):
    constants=literal_constants(git_source.bytes('zig/bench/native_case_tools.py').decode(),{'CANONICAL','LOCKS'})
    manifest=archive.data('manifest.json');need(type(manifest.get('schema'))is int and manifest['schema']==1 and manifest.get('kind')=='source-built-linux-native-case-tools'and manifest.get('source_commit')==PRODUCER,'TOOLS_IDENTITY')
    platform=manifest['platform'];need(platform.get('os')=='linux'and platform.get('elf_machine')==62 and platform.get('architecture')=='x86_64'and platform.get('byte_order')=='little','TOOLS_PLATFORM')
    need(all(manifest.get(k)is False for k in ['native_chain_acceptance','storage_interoperability_acceptance','elapsed600_acceptance','timing_acceptance']),'TOOLS_SCOPE')
    need(manifest.get('canonical_compatibility_source')==constants['CANONICAL']and set(manifest.get('tools',{}))==set(TOOLS),'TOOLS_CANONICAL')
    member_row(archive,manifest['source_gate'],'source-gate.json');gate=archive.data('source-gate.json')
    need(gate.get('passed')is True and gate.get('source_commit')==PRODUCER and gate.get('source_before')==gate.get('source_after')and gate.get('actual_all_parent_waits')is True,'TOOLS_SOURCE_GATE')
    need(gate.get('canonical_compatibility_source')==constants['CANONICAL']and set(gate.get('locks',{}))==set(constants['LOCKS']),'TOOLS_LOCK_CLOSURE')
    origin=origin_rows(gate['source_before'],git_source);lock_origin=origin_rows(gate['locks'],git_source)
    required=('zig/reference/src/main.rs','zig/reference/Cargo.toml','zig/reference/native-rows/src/main.rs','zig/reference/native-rows/Cargo.toml','rust/main/hyperlane-core/src/lib.rs','rust/main/agents/scraper/migration/bin/init_db.rs','zig/bench/native_case_tools.py')
    need(set(required)<=set(gate['source_before']),'TOOLS_SOURCE_COVERAGE')
    for name,expected in constants['CANONICAL'].items():
        actual=gate['locks'][name]if name.endswith('Cargo.lock')else gate['source_before'][name]
        need(actual['sha256']==expected,'TOOLS_CANONICAL_BYTES')
    rows=gate['checks'];need([r.get('name')for r in rows]==['build-'+n for n in TOOLS]+['test-ziggy-rocks-oracle','test-ziggy-native-rows'],'TOOLS_PHASES')
    for row in rows:
        need(row.get('passed')is True,'TOOLS_PHASE_OUTCOME');clean_wait(row);member_row(archive,row['log'],row['name']+'.log')
        if row['name'].startswith('test-'):need(integer(row.get('actual_tests_passed'),3 if row['name'].endswith('oracle')else 13),'TOOLS_ACTUAL_TESTS')
    products={}
    for name,row in manifest['tools'].items():
        need(row.get('relative_path')=='bin/'+name,'TOOLS_PRODUCT_PATH');path=member_row(archive,row);observed=elf(archive,path)
        need(observed==row['elf']and row['producer']['bytes']==row['bytes']and row['producer']['sha256']==row['sha256'],'TOOLS_ELF_CARGO_COPY')
        products[name]={**archive.pin(path),'ELF_machine':observed['machine'],'ELF_type':observed['type']}
    closed={'manifest.json','partial.json','plan.json','source-gate.json'}|{'bin/'+n for n in TOOLS}|{r['name']+'.log'for r in rows}
    need(archive.files()==closed,'TOOLS_CLOSED_MEMBERS')
    return {'source_commit':PRODUCER,'Source_origin':origin,'canonical_lock_origin':lock_origin,'products':products,'actual_phase_waits':len(rows),'canonical_compatibility_Source_exact':True,'product_execution':False}

def validate_radix(archive,git_source):
    constants=literal_constants(git_source.bytes('zig/bench/native_radix_reference.py').decode(),{'SCOPES','TESTS','CHECKS','REFERENCE','BIN'})
    manifest=archive.data('manifest.json');need(type(manifest.get('schema'))is int and manifest['schema']==1 and manifest.get('kind')=='source-built-linux-radix-reference'and manifest.get('source_commit')==PRODUCER,'RADIX_IDENTITY')
    need(all(manifest.get(k)is False for k in ['native_case_acceptance','accepted_reference_component','timing_acceptance']),'RADIX_SCOPE')
    platform=manifest['platform'];need(platform.get('os')=='linux'and platform.get('byte_order')=='little'and platform.get('elf_machine')==62 and platform.get('architecture')=='x86_64','RADIX_PLATFORM')
    member_row(archive,manifest['source_gate'],'source-gate.json');gate=archive.data('source-gate.json')
    need(gate.get('passed')is True and gate.get('source_commit')==PRODUCER and gate.get('source_before')==gate.get('source_after')and gate.get('all_owned_jobs_joined')is True and gate.get('source_scopes')==constants['SCOPES'],'RADIX_SOURCE_GATE')
    origin=origin_rows(gate['source_before'],git_source)
    locks=gate['locks'];need(locks.get('working_lock_restored_to_original_absence')is True and locks['canonical']['packed']==gate['source_before'][constants['REFERENCE']+'/Cargo.lock.gz'],'RADIX_LOCK_FENCE')
    need(set(constants['SCOPES'][1:])<=set(gate['source_before'])and all(constants['REFERENCE']+'/'+n in gate['source_before']for n in ['Cargo.toml','Cargo.lock.gz','src/main.rs']),'RADIX_SOURCE_COVERAGE')
    rows=gate['checks'];need([r.get('name')for r in rows]==constants['CHECKS'],'RADIX_PHASES')
    for row in rows:
        need(row.get('passed')is True,'RADIX_PHASE_OUTCOME');clean_wait(row);path=member_row(archive,row['log'],row['name']+'.log')
        if row['name']=='test':
            text=archive.bytes(path,8*1024**2).decode();match=re.search(r'test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored;',text)
            need(match and tuple(map(int,match.groups()))==(5,0,0)and row.get('required_tests_observed')==constants['TESTS']and all('test evidence_tests::'+name+' ... ok'in text for name in constants['TESTS']),'RADIX_ACTUAL_SDK_TESTS')
    cpu_name=member_row(archive,gate['cpu']['cpuinfo'],'producer-cpuinfo.txt');text=archive.bytes(cpu_name,4*1024**2).decode();flags=[]
    for block in text.split('\n\n'):
        fields={k.strip():v.strip()for k,v in (line.split(':',1)for line in block.splitlines()if ':'in line)};value=fields.get('flags',fields.get('Features'))
        if value:flags.append(set(value.split()))
    need(flags,'RADIX_CPU_ROWS');required=sorted(set.intersection(*flags))
    need(required and required==gate['cpu']['required_flags']and len(flags)==gate['cpu']['processor_rows'],'RADIX_CPU_EVIDENCE')
    product=manifest['tool'];path=member_row(archive,product,'bin/'+constants['BIN']);observed=elf(archive,path)
    need(observed==product['elf']and product['producer']['bytes']==product['bytes']and product['producer']['sha256']==product['sha256'],'RADIX_CARGO_COPY')
    closed={'manifest.json','partial.json','source-gate.json','producer-cpuinfo.txt','bin/'+constants['BIN']}|{r['name']+'.log'for r in rows}
    need(archive.files()==closed,'RADIX_CLOSED_MEMBERS')
    return {'source_commit':PRODUCER,'Source_origin':origin,'actual_phase_waits':len(rows),'actual_five_named_SDK_tests':True,'product':archive.pin(path),'ELF_machine':observed['machine'],'producer_CPU_rows':len(flags),'producer_CPU_flags_sha256':sha(canonical(required)),'actual_consumer_CPU_superset_checked':False,'product_execution':False}

def validate_svm(archive,git_source):
    constants=literal_constants(git_source.bytes('zig/bench/native_svm_assets.py').decode(),{'AGAVE','AGAVE_BYTES','PROGRAMS','ENVIRONMENT'})
    assets=literal_constants(git_source.bytes('zig/tools/svm_prerequisites.py').decode(),{'ASSETS'})['ASSETS']
    result=archive.data('result.json')
    need(result.get('checkout_commit')==PRODUCER and result.get('passed')is True and result.get('Source_unchanged')is True and result.get('error')is None and result.get('owned_absent')is True and result.get('actual_owner_signals')==[]and result.get('forced_cleanup')is False,'SVM_ACTUAL_GATE')
    need(result.get('component_only')is True and all(result.get(k)is False for k in ['native_case_credit','linux_profile_admitted','performance_credit']),'SVM_SCOPE')
    commands=result.get('commands');need(isinstance(commands,list)and len(commands)==31 and len({r.get('name')for r in commands})==31,'SVM_COMMAND_CLOSURE')
    log_names=set();warnings=0
    for row in commands:
        need(row.get('actual_wait_observed')is True and type(row.get('exit_code'))is int and row['exit_code']==0,'SVM_ACTUAL_WAIT')
        for output in ['stdout','stderr']:
            name='logs/'+Path(row[output]['path']).name;need(name=='logs/'+row['name']+'.'+output,'SVM_LOG_NAME');member_row(archive,row[output],name);log_names.add(name)
            if archive._info(name).file_size<=8*1024**2:warnings+=archive.bytes(name,8*1024**2).count(b'Stack offset of')
    orphans=result.get('actual_orphan_waits');need(isinstance(orphans,list)and all(r.get('actual_wait_observed')is True and type(r.get('exit_code'))is int and r['exit_code']==0 and r.get('preceded_by_owner_signal')is False for r in orphans),'SVM_ADOPTED_WAITS')
    acquisition=[]
    for key in ['agave','platform','spl','criterion']:
        row=result[key+'_archive'];expected=assets[key]
        need(all(row.get(k)==expected[k]for k in ['bytes','sha256','url','asset_id','publisher_digest']),'SVM_ACQUISITION_PIN')
        acquisition.append({'asset':key,'bytes':row['bytes'],'sha256':row['sha256'],'publisher_digest':row['publisher_digest'],'original_acquisition_receipt_matches_pinned_source':True,'compressed_original_independently_present_in_readback':False})
    agave=constants['AGAVE'];programs=constants['PROGRAMS'];need(archive.files('published/agave/')=={'published/agave/'+n for n in agave}and archive.files('published/programs/')=={'published/programs/'+n for n in programs},'SVM_CLOSED_DATASET')
    total=0
    for name,expected in agave.items():
        path='published/agave/'+name;row=archive.pin(path);need(row=={'bytes':expected[0],'sha256':expected[1]},'SVM_OFFICIAL_AGAVE_BYTES');total+=row['bytes']
        if name in {'bin/solana','bin/solana-test-validator'}:elf(archive,path)
    need(total==constants['AGAVE_BYTES'],'SVM_AGAVE_TOTAL')
    products=archive.data('published/products.json');need(products==result.get('products')and set(products)=={'programs','client','spl'}and set(products['programs'])==set(programs),'SVM_PRODUCT_MANIFEST')
    def product(row,path,machine,maximum):
        need(isinstance(row,dict)and set(row)=={'path','bytes','sha256','elf_class','elf_machine'}and integer(row['bytes'],64,maximum)and digest_text(row['sha256'])and row['elf_class']==64 and row['elf_machine']==machine,'SVM_TYPED_PRODUCT')
        archive.match(path,row);return elf(archive,path,machine,kind='program'if machine!=62 else'executable')
    machines={247:0,263:0}
    for name,expected in programs.items():product(products['programs'][name],'published/programs/'+name,expected[2],32*1024**2);machines[expected[2]]+=1
    product(products['client'],'published/hyperlane-sealevel-client',62,512*1024**2);product(products['spl'],'published/spl-token',62,128*1024**2)
    header_names={'published/sbf-header-'+str(i)+'.json'for i in range(9)};seen=set()
    for name in header_names:
        row=archive.data(name);h=bytes(row['public_ELF_header_bytes']);program=row['program'];need(program in programs and program not in seen and len(h)>=64 and h[:8]==b'\x7fELF\x02\x01\x01\x00'and struct.unpack_from('<H',h,16)[0]==3 and struct.unpack_from('<H',h,18)[0]==row['observed_machine']==products['programs'][program]['elf_machine'],'SVM_ACTUAL_SBF_HEADER');seen.add(program)
    source=archive.data('source-before.json');origin=origin_rows(source,git_source)
    need(all('rust/sealevel/environments/local-e2e/'+n in source for n in constants['ENVIRONMENT']),'SVM_PUBLIC_ENVIRONMENT_SOURCE')
    metadata={'agave-linux-runtime-members.json','agave-publisher-members.json','client-cargo-artifact.json','compiler-inputs-before.json','criterion-publisher-members.json','custom-spl-commit.json','custom-spl-lock-overlay.json','custom-spl-source-map.json','custom-spl-upstream-source-map.json','custom-spl-upstream.Cargo.lock.gz','linux-profile.CANDIDATE.json','locks-before.json','platform-debugger-link-omissions.json','platform-linkage.json','platform-publisher-members.json','products.json','sbf-tool-authority.json','sdk-dependency-stage.json','spl-cargo-artifact.json','spl-publisher-members.json'}
    closed={'result.json','source-before.json','observations.jsonl','published/hyperlane-sealevel-client','published/spl-token'}|{'published/'+n for n in metadata}|header_names|{'published/agave/'+n for n in agave}|{'published/programs/'+n for n in programs}|log_names
    need(archive.files()==closed,'SVM_OUTER_CLOSED_MEMBERS')
    return {'source_commit':PRODUCER,'Source_origin':origin,'actual_direct_waits':len(commands),'actual_adopted_waits':len(orphans),'no_owner_signals_or_forced_cleanup':True,'closed_Agave_files':len(agave),'closed_Agave_bytes':total,'SBF_machine_counts':{str(k):v for k,v in machines.items()},'nine_actual_header_rows_verified':True,'official_acquisition_receipts':acquisition,'nonfatal_stack_offset_warning_count':warnings,'native_VM_acceptance':False,'product_execution':False}

def file_pin(path,owned=True):
    before=path.lstat();need(stat.S_ISREG(before.st_mode)and not path.is_symlink()and(not owned or before.st_nlink==1),'OWNED_REGULAR_FILE')
    with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW),'rb')as stream:
        need((os.fstat(stream.fileno()).st_dev,os.fstat(stream.fileno()).st_ino)==(before.st_dev,before.st_ino),'FILE_IDENTITY')
        digest=hashlib.file_digest(stream,'sha256').hexdigest()
    after=path.lstat();need((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns),'FILE_MUTATION')
    return {'bytes':before.st_size,'sha256':digest}

GH_DIAGNOSTIC_KINDS={'GH_VERSION_AS512','GH_VERSION_INHERITED'}
GH_ERROR_CLASSES={'NONE','GO_VIRTUAL_RESERVATION','HTTP_401','HTTP_403','HTTP_404','HTTP_429','HTTP_5XX','DNS_FAILURE','TLS_FAILURE','CONNECT_FAILURE','UNKNOWN','SIGNAL','STDERR_BOUND','UNAVAILABLE'}
def fixed_stderr_class(path,code):
    # Raw bytes are transient and never copied into public diagnostics.
    try:
        with path.open('rb')as stream:body=stream.read(1024**2+1)
    except OSError:return 'UNAVAILABLE'
    if len(body)>1024**2:return 'STDERR_BOUND'
    if type(code)is int and code<0:return 'SIGNAL'
    if re.search(rb'(?m)^fatal error: failed to reserve (?:page summary|arena) memory\r?$',body):return 'GO_VIRTUAL_RESERVATION'
    for status in (401,403,404,429):
        if re.search(rb'(?m)^gh: [^\r\n]*\(HTTP '+str(status).encode()+rb'\)\r?$',body):return 'HTTP_'+str(status)
    if re.search(rb'(?m)^gh: [^\r\n]*\(HTTP 5[0-9]{2}\)\r?$',body):return 'HTTP_5XX'
    if b'no such host'in body or b'Temporary failure in name resolution'in body:return 'DNS_FAILURE'
    if b'TLS handshake timeout'in body or b'x509: certificate'in body:return 'TLS_FAILURE'
    if body.startswith(b'error connecting to api.github.com')or b'connect: connection refused'in body:return 'CONNECT_FAILURE'
    return 'NONE'if code==0 and not body else 'UNKNOWN'

class Runner:
    """Only fixed builtin gh API and read-only git; never an artifact program."""
    def __init__(self,root,repo,gh,guard,token):
        self.root=root;self.repo=repo;self.gh=gh;self.guard=guard;self.token=token;self.count=0;self.waited=0;self.wait_hash=hashlib.sha256();self.failed=0;self.last_command_diagnostic=None;self.last_failed_command=None;self.gh_startup=None
        for name in ['home','gh-config']:(root/name).mkdir(mode=0o700)
        self.tool_pins={'gh':file_pin(gh,owned=False),'git':file_pin(Path('/usr/bin/git'),owned=False)}
    def _limits(self,maximum,*,inherited_address_space=False):
        if inherited_address_space:
            need(resource.getrlimit(resource.RLIMIT_AS)==(LIMITS['inspector_RAM_bytes'],LIMITS['inspector_RAM_bytes']),'CHILD_INHERITED_AS')
        else:resource.setrlimit(resource.RLIMIT_AS,(LIMITS['child_RAM_bytes'],LIMITS['child_RAM_bytes']))
        resource.setrlimit(resource.RLIMIT_FSIZE,(max(maximum,1024**2),max(maximum,1024**2)))
        resource.setrlimit(resource.RLIMIT_NOFILE,(128,128))
    def call(self,argv,kind,maximum=16*1024**2,allow_missing=False):
        probe=kind in GH_DIAGNOSTIC_KINDS
        need(kind in {'API_JSON','ARTIFACT_ZIP','GIT_READ'}|GH_DIAGNOSTIC_KINDS and integer(maximum,1,LIMITS['maximum_archive_bytes']),'COMMAND_PROFILE')
        if probe:need(argv==[str(self.gh),'--version']and maximum==65536,'GH_PROBE_PROFILE')
        need(Path(argv[0])in {self.gh,Path('/usr/bin/git')},'COMMAND_EXECUTABLE')
        self.guard();self.count+=1;out=self.root/('call-'+str(self.count)+'.stdout');err=self.root/('call-'+str(self.count)+'.stderr')
        env={'PATH':'/usr/bin:/bin','HOME':str(self.root/'home'),'LC_ALL':'C.UTF-8','GIT_CONFIG_NOSYSTEM':'1','GIT_TERMINAL_PROMPT':'0','GIT_LFS_SKIP_SMUDGE':'1'}
        if Path(argv[0])==self.gh:
            env.update({'GH_CONFIG_DIR':str(self.root/'gh-config'),'GH_PROMPT_DISABLED':'1','GH_NO_UPDATE_NOTIFIER':'1'})
            if not probe:env['GH_TOKEN']=self.token
        child=None;code=None;primary=None;forced=False;waited=False;birth=None;peak=0
        probe_deadline=min(self.guard.deadline,self.guard.clock()+5)if probe else None
        with out.open('xb')as output,err.open('xb')as errors:
            try:
                child=subprocess.Popen(argv,cwd=self.repo,env=env,stdin=subprocess.DEVNULL,stdout=output,stderr=errors,start_new_session=True,preexec_fn=lambda:self._limits(maximum,inherited_address_space=Path(argv[0])==self.gh and kind in {'API_JSON','ARTIFACT_ZIP','GH_VERSION_INHERITED'}))
                # Direct-child wait ownership starts immediately at Popen; any
                # following bookkeeping error still enters independent cleanup.
                while os.waitid(os.P_PID,child.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT)is None:
                    self.guard()
                    if probe:need(self.guard.clock()<probe_deadline,'GH_PROBE_DEADLINE')
                    need(out.stat().st_size<=maximum and err.stat().st_size<=1024**2,'COMMAND_OUTPUT_BOUND')
                    raw=Path(f'/proc/{child.pid}/stat').read_text();fields=raw[raw.rindex(')')+2:].split();start=int(fields[19]);rss=int(fields[21])*os.sysconf('SC_PAGE_SIZE')
                    if birth is None:birth=start
                    need(start==birth and rss<=LIMITS['child_RAM_bytes'],'CHILD_IDENTITY_OR_RSS');peak=max(peak,rss);time.sleep(.01)
                code=child.wait(timeout=3);waited=True;self.guard()
                if probe:need(self.guard.clock()<probe_deadline,'GH_PROBE_DEADLINE')
                need((code==0 or allow_missing and code in (1,128)or probe and type(code)is int)and out.stat().st_size<=maximum and err.stat().st_size<=1024**2,'COMMAND_OUTCOME')
            except BaseException as error:primary=error
            finally:
                cleanup_errors=[]
                if child is not None:
                    try:
                        if not waited and os.waitid(os.P_PID,child.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT)is None:child.kill();forced=True
                    except BaseException as error:cleanup_errors.append(type(error).__name__)
                    try:
                        if not waited:code=child.wait(timeout=max(.01,min(10,self.guard.cleanup_deadline-self.guard.clock())));waited=True
                    except BaseException as error:cleanup_errors.append(type(error).__name__)
                row={'kind':kind,'pid':None if child is None else child.pid,'birth_start_ticks':birth,'actual_parent_wait':waited,'exit_code':code,'forced_signal':forced,'cleanup_error_count':len(cleanup_errors),'peak_child_RSS_bytes':peak}
                self.last_command_diagnostic={'kind':kind,'actual_parent_wait':waited,'exit_code':code if type(code)is int and code>=0 else None,'signal':-code if type(code)is int and code<0 else None,'error_class':fixed_stderr_class(err,code),'peak_child_RSS_bytes':peak,'forced_signal':forced,'cleanup_error_count':len(cleanup_errors)}
                if not probe and(primary is not None or cleanup_errors):self.last_failed_command=dict(self.last_command_diagnostic)
                self.wait_hash.update(canonical(row)+b'\n');self.waited+=int(waited);self.failed+=int(primary is not None or bool(cleanup_errors))
                if primary is None and cleanup_errors:primary=Refused('COMMAND_CLEANUP')
        # Private raw stderr/output never becomes report content. Callers own
        # only bounded data files; no argv, environment or redirects are copied.
        err.unlink()
        if primary is not None:
            if out.exists():out.unlink()
            raise primary
        return out,code
    def startup_diagnostics(self):
        rows={};self.gh_startup={'probes':rows,'token_supplied':False,'API_original_AS512_unchanged':False,'API_inherited_hard_AS1GiB':True}
        for key,kind in [('AS512','GH_VERSION_AS512'),('INHERITED_AS1G','GH_VERSION_INHERITED')]:
            need(file_pin(self.gh,owned=False)==self.tool_pins['gh'],'SYSTEM_TOOL_MUTATION')
            output=None;self.last_command_diagnostic=None
            try:output,_=self.call([str(self.gh),'--version'],kind,65536)
            finally:
                if self.last_command_diagnostic is not None:rows[key]=dict(self.last_command_diagnostic)
                if output is not None:output.unlink()
            need(file_pin(self.gh,owned=False)==self.tool_pins['gh'],'SYSTEM_TOOL_MUTATION')
        return self.gh_startup
    def api(self,path,maximum=16*1024**2):
        need(re.fullmatch(r'repos/hyperlane-xyz/hyperlane-monorepo/actions/(?:runs/\d+(?:/(?:jobs|artifacts)\?per_page=100&page=\d+)?|artifacts/\d+/zip)',path)is not None,'API_ENDPOINT')
        return self.call([str(self.gh),'api','--hostname','github.com','-H','Accept: application/vnd.github+json',path],'ARTIFACT_ZIP'if path.endswith('/zip')else'API_JSON',maximum)[0]
    def git(self,args,maximum=16*1024**2,missing=False,*,submodule=False):
        allowed=args==['rev-parse','HEAD']or(len(args)==2 and args[0]=='show'and re.fullmatch('[0-9a-f]{40}:.+',args[1])is not None)or(len(args)==3 and args[:2]==['rev-parse','--verify']and re.fullmatch('[0-9a-f]{40}:.+',args[2])is not None)or(len(args)==7 and args[:6]==['diff','--no-ext-diff','--no-textconv','--name-only','HEAD','--']and args[6]in {n for paths in COMPILED_SCOPES.values()for n in paths})
        allowed=allowed or(len(args)==4 and args[0]=='ls-tree'and args[1]==PRODUCER and args[2:]==['--','solidity/lib/forge-std'])
        need(type(submodule)is bool and allowed and(not submodule or args==['rev-parse','HEAD']or(len(args)==2 and args[0]=='show')),'READ_ONLY_GIT_COMMAND')
        location=[]
        if submodule:
            directory=self.repo/'solidity/lib/forge-std'
            need(directory.is_dir()and directory.resolve()==directory,'FIXED_SUBMODULE_CHECKOUT');location=['-C',str(directory)]
        # Bounded mmap windows keep the real512MiB address-space/RSS cap usable
        # with a large history pack, without altering any checkout/global config.
        return self.call(['/usr/bin/git','-c','core.packedGitWindowSize=8m','-c','core.packedGitLimit=128m','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null',*location,*args],'GIT_READ',maximum,missing)
    def summary(self):
        return {'actual_calls':self.count,'actual_parent_waits':self.waited,'all_calls_actually_waited':self.waited==self.count,'failure_count':self.failed,'wait_catalog_sha256':self.wait_hash.hexdigest(),'tool_pins':self.tool_pins,'raw_argv_stderr_environment_exported':False,'last_failed_command':self.last_failed_command,'gh_startup_diagnostics':self.gh_startup}

class GitSource:
    def __init__(self,runner,head):self.runner=runner;self.head=head;self.digests={};self.body_cache={};self.retained=0;self.forge_commit=None
    def bytes(self,name):
        relative(name)
        if name in self.body_cache:return self.body_cache[name]
        submodule=name.startswith('solidity/lib/forge-std/')
        if submodule:
            if self.forge_commit is None:
                link,_=self.runner.git(['ls-tree',self.head,'--','solidity/lib/forge-std'],maximum=65536)
                try:match=re.fullmatch(r'160000 commit ([0-9a-f]{40})\tsolidity/lib/forge-std\n',link.read_text())
                finally:link.unlink()
                need(match,'FIXED_SUBMODULE_GITLINK');commit=match[1]
                current,_=self.runner.git(['rev-parse','HEAD'],maximum=65536,submodule=True)
                try:need(current.read_text().strip()==commit,'SUBMODULE_CHECKOUT_DIFFERS')
                finally:current.unlink()
                self.forge_commit=commit
            object_name=self.forge_commit+':'+name.removeprefix('solidity/lib/forge-std/')
        else:object_name=self.head+':'+name
        path,code=self.runner.git(['show',object_name],missing=True,submodule=submodule)
        try:body=path.read_bytes()
        finally:path.unlink()
        if code!=0:
            # Same explicit canonical-lock transport supported by the current
            # readers; never fetch or invent a missing ordinary Source blob.
            need(name in {'rust/main/Cargo.lock','zig/reference/rocks/Cargo.lock','zig/reference/native-rows/Cargo.lock','zig/reference/Cargo.lock'},'GIT_SOURCE_MISSING')
            packed=self.bytes(name+'.gz')
            with gzip.GzipFile(fileobj=io.BytesIO(packed))as stream:body=stream.read(16*1024**2+1)
        need(len(body)<=16*1024**2,'GIT_SOURCE_BOUND');self.digests[name]={'bytes':len(body),'sha256':sha(body)}
        if self.retained+len(body)<=32*1024**2:self.body_cache[name]=body;self.retained+=len(body)
        self.runner.guard(len(body));return body
    def digest(self,name):
        if name not in self.digests:self.bytes(name)
        return self.digests[name]
    def compiled_cohort(self,execution):
        output={}
        for family,scopes in COMPILED_SCOPES.items():
            rows=[]
            for name in scopes:
                hashes=[]
                for head in [self.head,execution]:
                    path,code=self.runner.git(['rev-parse','--verify',head+':'+name],maximum=65536,missing=True)
                    try:text=path.read_text().strip()
                    finally:path.unlink()
                    if code:need(name=='zig/build.zig.zon','COMPILED_SCOPE_MISSING');text=None
                    else:need(re.fullmatch('[0-9a-f]{40}',text)is not None,'GIT_OBJECT_ID')
                    hashes.append(text)
                need(hashes[0]==hashes[1],'COMPILED_SCOPE_DIFFERS')
                path,code=self.runner.git(['diff','--no-ext-diff','--no-textconv','--name-only','HEAD','--',name],maximum=65536)
                try:need(path.read_bytes()==b'','COMPILED_WORKTREE_DIRTY')
                finally:path.unlink()
                if hashes[0]is None:need(not(self.runner.repo/name).exists()and not(self.runner.repo/name).is_symlink(),'OPTIONAL_SCOPE_SHADOW')
                rows.append({'path':name,'producer_tree':hashes[0],'execution_tree':hashes[1],'worktree_clean_in_scope':True})
            output[family]=rows
        return output

def remote_inventory(runner,policy):
    base=f'repos/{REPOSITORY}/actions/runs/{policy["producer"]["run_id"]}'
    path=runner.api(base)
    try:run=unique_json(path.read_bytes())
    finally:path.unlink()
    collections={}
    for kind in ['jobs','artifacts']:
        collected=[];expected=None
        for page in range(1,21):
            path=runner.api(base+'/'+kind+'?per_page=100&page='+str(page))
            try:value=unique_json(path.read_bytes())
            finally:path.unlink()
            need(integer(value.get('total_count'),0,2000)and isinstance(value.get(kind),list),'API_INVENTORY_BOUND')
            need(expected is None or expected==value['total_count'],'API_INVENTORY_CHANGED');expected=value['total_count'];collected.extend(value[kind])
            if len(collected)>=expected:break
        need(len(collected)==expected,'API_INVENTORY_INCOMPLETE');collections[kind]=collected
    return validate_remote(policy,run,collections['jobs'],collections['artifacts'])

PUBLIC_FACT_KEYS=set(('mode source_commit products native_suite CPU_receipts export_actual_waits export_created_CID_removed actual_consumer_CPU_superset_checked SDK_or_native_product_executed_by_reader Source_origin actual_phase_waits actual_test_counts required_census_names_observed five_strict_deadline_tests_observed product_execution product ELF_machine ELF_type unchanged_declared_compiler_input_count declared_compiler_input_catalog_sha256 compiler_archive_inputs_independently_present_or_executed_by_reader CPU_flags_sha256 writer_executed_by_reader canonical_lock_origin canonical_compatibility_Source_exact actual_five_named_SDK_tests producer_CPU_rows producer_CPU_flags_sha256 actual_direct_waits actual_adopted_waits no_owner_signals_or_forced_cleanup closed_Agave_files closed_Agave_bytes SBF_machine_counts nine_actual_header_rows_verified official_acquisition_receipts nonfatal_stack_offset_warning_count native_VM_acceptance count catalog_sha256 all_declared_rows_match_producer_Git bytes sha256 total status_counts skip_catalog_sha256 three_recovery_allocation_tests_observed_OK scope flag_count flags_sha256 receipt_sha256 asset publisher_digest original_acquisition_receipt_matches_pinned_source compressed_original_independently_present_in_readback files expanded_bytes archive catalog actual_calls actual_parent_waits all_calls_actually_waited failure_count wait_catalog_sha256 tool_pins raw_argv_stderr_environment_exported path producer_tree execution_tree worktree_clean_in_scope source_rows_checked policy_map_sha256 all_policy_Git_blobs_match inspector_peak_RSS_bytes actual_streamed_bytes elapsed_seconds own_downloads_removed actual_remote_inventory_verified compiled_cohort core607 command_waits inspection_resources remote run_id run_attempt required_jobs artifacts id name size_in_bytes status conclusion whole_workflow_success_claim reader_sources committed_execution_sources_unchanged').split())|SDK_NAMES|set(TOOLS)|set(PRODUCT_KEYS)|set(REQUIRED_JOBS)|set(HELPER_PHASES)|{'producer_native_required_count','embedded_tools_catalog_sha256','embedded_radix_catalog_sha256','embedded_duplicate_catalogs_match_separate_artifacts','symlink_count','normal','construction','OK','SKIP','FAIL','247','263','gh','git','runtime','helper','tools'}
PUBLIC_FACT_KEYS|={'gh_startup_diagnostics','probes','AS512','INHERITED_AS1G','token_supplied','API_original_AS512_unchanged','API_inherited_hard_AS1GiB','last_failed_command','kind','actual_parent_wait','exit_code','signal','error_class','peak_child_RSS_bytes','forced_signal','cleanup_error_count'}
PUBLIC_STRINGS=set(CPU_SCOPES)|{'ReleaseSafe','ReleaseFast','agave','platform','spl','criterion','completed','success'}|set(REQUIRED_JOBS)|set(artifact_names(0,0).values())|set(n for names in COMPILED_SCOPES.values()for n in names)

PUBLIC_STRINGS|=GH_DIAGNOSTIC_KINDS|GH_ERROR_CLASSES|{'API_JSON','ARTIFACT_ZIP','GIT_READ'}

def public_facts(value):
    """Reconstruct a closed public projection, including nested failure data."""
    if isinstance(value,dict):return {k:public_facts(v)for k,v in value.items()if k in PUBLIC_FACT_KEYS}
    if isinstance(value,list):return [public_facts(v)for v in value]
    if value is None or type(value)is bool:return value
    if type(value)is int:need(0<=value<2**63,'REPORT_INTEGER');return value
    if type(value)is float:need(value==value and 0<=value<=LIMITS['wall_seconds']+LIMITS['cleanup_seconds'],'REPORT_NUMBER');return value
    need(isinstance(value,str)and(value in PUBLIC_STRINGS or re.fullmatch('[0-9a-f]{40}|[0-9a-f]{64}|svm-linux-prerequisites-[0-9]+-[0-9]+',value)is not None),'REPORT_STRING')
    return value

def closed_report(status,execution,policy_pin,case_pin,components=None,failure=None):
    need(status in {'DISABLED','PASSED','FAILED'},'REPORT_STATUS')
    need(re.fullmatch('[0-9a-f]{40}',execution)is not None and(failure is None or re.fullmatch('[A-Z][A-Z0-9_]{0,63}',failure)is not None),'REPORT_IDENTITY')
    # Whitelist reconstruction, never a copy of policy/producer nested objects.
    return {'schema':1,'scope':'remote-CI-eight-product-archive-inspection','status':status,'inspection_passed':status=='PASSED','execution_source_commit':execution,'producer_source_commit':PRODUCER,'policy':public_facts(policy_pin),'inactive_native_selector':public_facts(case_pin),'components':public_facts(components or{}),'failure_code':failure,'Root_cohort_acceptance':False,'local_full_archive_possession_claim':False,'native_case_acceptance':False,'SDK_C42_component_inspected':False,'actual_consumer_CPU_superset_checked':False,'timing_acceptance':False,'raw_environment_argv_headers_redirects_stderr_or_logs_exported':False}

def write_report(directory,value):
    wire=json.dumps(value,indent=2,sort_keys=True,allow_nan=False).encode()+b'\n';need(len(wire)<=LIMITS['report_bytes']-1024,'REPORT_BOUND')
    path=directory/'report.json'
    with path.open('xb')as stream:stream.write(wire);stream.flush();os.fsync(stream.fileno())
    with(directory/'report.sha256').open('x')as stream:stream.write(sha(wire)+'  report.json\n');stream.flush();os.fsync(stream.fileno())

def inspect_archive(key,archive,git_source):
    if key in {'sdk_safe','sdk_fast'}:return validate_sdk(archive,'ReleaseSafe'if key=='sdk_safe'else'ReleaseFast',git_source)
    if key=='helper':return validate_helper(archive,git_source)
    if key=='tools':return validate_tools(archive,git_source)
    if key in {'writer_safe','writer_fast'}:return validate_writer(archive,'ReleaseSafe'if key=='writer_safe'else'ReleaseFast',git_source)
    if key=='svm':return validate_svm(archive,git_source)
    if key=='radix_reference':return validate_radix(archive,git_source)
    raise Refused('UNEXPECTED_COMPONENT')

def validate_embedded_components(components):
    need(components['helper']['embedded_tools_catalog_sha256']==components['tools']['catalog']['catalog_sha256']and components['helper']['embedded_radix_catalog_sha256']==components['radix_reference']['catalog']['catalog_sha256'],'EMBEDDED_COMPONENT_DIFFERS')
    components['helper']['embedded_duplicate_catalogs_match_separate_artifacts']=True


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--policy',type=Path,required=True);parser.add_argument('--policy-sha256',required=True);parser.add_argument('--native-request',type=Path,required=True);parser.add_argument('--native-request-sha256',required=True);parser.add_argument('--repo',type=Path,required=True);parser.add_argument('--execution-source-commit',required=True);parser.add_argument('--gh',type=Path,required=True);parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
    need(sys.platform=='linux'and re.fullmatch('[0-9a-f]{40}',args.execution_source_commit)is not None,'LINUX_EXECUTION_PROFILE')
    need(args.repo.is_absolute()and args.repo.resolve()==args.repo and args.output.is_absolute()and args.output.parent.resolve()==args.output.parent and not args.output.exists()and not args.output.is_symlink()and not args.output.is_relative_to(args.repo),'EXCLUSIVE_OUTPUT')
    need(args.policy.resolve()==args.repo/'zig/bench/cohort_readback_request.json'and args.native_request.resolve()==args.repo/'zig/bench/native_case_request.json','FIXED_POLICY_PATHS')
    policy_pin=file_pin(args.policy);case_pin=file_pin(args.native_request);need(policy_pin['sha256']==args.policy_sha256 and case_pin['sha256']==args.native_request_sha256,'REQUEST_SHA')
    require_disabled_case(args.native_request.read_bytes());policy=decode_policy(args.policy.read_bytes());enabled=validate_policy(policy)
    args.output.mkdir(mode=0o700);report_root=args.output/'public';report_root.mkdir(mode=0o700)
    if not enabled:
        write_report(report_root,closed_report('DISABLED',args.execution_source_commit,policy_pin,case_pin));return
    need(re.fullmatch(r'/[^\x00\n]+',str(args.gh))is not None and args.gh.is_file()and not args.gh.is_symlink()and os.access(args.gh,os.X_OK)and not args.gh.is_relative_to(args.repo)and not args.gh.is_relative_to(args.output),'EXPLICIT_GH')
    need(shutil.disk_usage(args.output).free>=LIMITS['host_free_bytes']+max(r['size_in_bytes']for r in policy['artifacts'].values())+LIMITS['metadata_bytes'],'ORIGINAL_FLOOR_PLUS_ARCHIVE')
    # Real process address-space/file-descriptor bounds supplement live RSS,
    # disk and original-deadline observations; no privileged resource fallback.
    resource.setrlimit(resource.RLIMIT_AS,(LIMITS['inspector_RAM_bytes'],LIMITS['inspector_RAM_bytes']));resource.setrlimit(resource.RLIMIT_NOFILE,(128,128))
    work=args.output/'owned';work.mkdir(mode=0o700);guard=Guard(work);runner=None;components={};failure=None;complete=False;download=None
    token=os.environ.get('GH_TOKEN');need(isinstance(token,str)and token,'READ_ONLY_CI_TOKEN_REQUIRED')
    def interrupted(sig,frame):raise TaskInterrupted()
    need(signal.getitimer(signal.ITIMER_REAL)==(0.0,0.0),'EXISTING_PROCESS_TIMER')
    old_handlers={sig:signal.signal(sig,interrupted)for sig in [signal.SIGTERM,signal.SIGINT,signal.SIGHUP,signal.SIGALRM]}
    signal.setitimer(signal.ITIMER_REAL,LIMITS['wall_seconds']+LIMITS['cleanup_seconds'])
    try:
        runner=Runner(work,args.repo,args.gh,guard,token);head,_=runner.git(['rev-parse','HEAD'],maximum=65536)
        try:need(head.read_text().strip()==args.execution_source_commit,'EXECUTION_CHECKOUT')
        finally:head.unlink()
        reader_sources={}
        for logical in ['zig/bench/cohort_readback.py','.github/workflows/zig-agents.yml']:
            actual=file_pin(args.repo/logical);blob,_=runner.git(['show',args.execution_source_commit+':'+logical])
            try:need(file_pin(blob)==actual,'READER_SOURCE_NOT_COMMITTED')
            finally:blob.unlink()
            reader_sources[logical]=actual
        source=GitSource(runner,PRODUCER);components['compiled_cohort']=source.compiled_cohort(args.execution_source_commit)
        guard.phase='GH_STARTUP_DIAGNOSTIC';components['gh_startup_diagnostics']=runner.startup_diagnostics()
        guard.phase='REMOTE_PROVENANCE';components['remote']=remote_inventory(runner,policy)
        guard.phase='CORE607_GIT';core_origin=origin_rows(policy['core607'],source);components['core607']={'source_rows_checked':core_origin['count'],'policy_map_sha256':core_origin['catalog_sha256'],'all_policy_Git_blobs_match':True}
        for key in PRODUCT_KEYS:
            guard.phase=key.upper();expected=policy['artifacts'][key];guard()
            download=runner.api(f'repos/{REPOSITORY}/actions/artifacts/{expected["id"]}/zip',expected['size_in_bytes'])
            actual=file_pin(download);need(actual=={'bytes':expected['size_in_bytes'],'sha256':expected['sha256']},'PUBLISHER_ARCHIVE_SHA')
            archive=Archive(download,guard)
            try:
                component=inspect_archive(key,archive,source);component['catalog']=archive.finish();component['archive']=actual;components[key]=component
            finally:archive.close()
            checkpoint=closed_report('FAILED',args.execution_source_commit,policy_pin,case_pin,{key:component},'INSPECTION_INCOMPLETE')
            wire=canonical(checkpoint);need(len(wire)<=128*1024,'CHECKPOINT_BOUND')
            with(work/('validated-'+key+'.json')).open('xb')as stream:stream.write(wire);stream.flush();os.fsync(stream.fileno())
            guard()
            # Retire ONLY this exact owned transient download, after durable
            # original artifact identity/catalog facts have been constructed.
            need(file_pin(download)==actual,'OWN_DOWNLOAD_MUTATION');download.unlink();download=None;guard()
        validate_embedded_components(components)
        need(file_pin(args.policy)==policy_pin and file_pin(args.native_request)==case_pin,'INPUT_CHANGED_AFTER_INSPECTION');require_disabled_case(args.native_request.read_bytes())
        for logical,expected in reader_sources.items():need(file_pin(args.repo/logical)==expected,'READER_SOURCE_MUTATION')
        need(file_pin(args.gh,owned=False)==runner.tool_pins['gh']and file_pin(Path('/usr/bin/git'),owned=False)==runner.tool_pins['git'],'SYSTEM_TOOL_MUTATION')
        components['reader_sources']={'count':len(reader_sources),'catalog_sha256':sha(canonical(reader_sources)),'committed_execution_sources_unchanged':True};guard()
        complete=True
    except BaseException as error:
        failure=error.code if isinstance(error,Refused)else'INTERRUPTED'if isinstance(error,TaskInterrupted)else'UNEXPECTED_FAILURE'
    finally:
        # Keep the independent wall alarm armed through cleanup/publication.
        if download is not None and download.exists():
            # This path is created exclusively by our fixed command runner;
            # failure never authorizes deleting any external/root input.
            try:need(download.parent==work and download.name.startswith('call-')and not download.is_symlink(),'CLEANUP_OWNERSHIP');download.unlink()
            except BaseException:complete=False;failure=failure or'OWN_DOWNLOAD_CLEANUP'
        try:
            guard.cleanup()
            if runner is not None:
                components['command_waits']=runner.summary();need(runner.waited==runner.count,'UNWAITED_COMMAND')
            guard();components['inspection_resources']={'inspector_peak_RSS_bytes':guard.peak_rss,'actual_streamed_bytes':guard.streamed,'elapsed_seconds':round(guard.clock()-guard.started,6),'own_downloads_removed':download is None or not download.exists()}
        except BaseException as error:complete=False;failure=failure or(error.code if isinstance(error,Refused)else'FINAL_RESOURCE_GUARD')
        # No raw failure object, command output, source JSON, headers or redirect
        # URL may cross the public boundary, even on partial verification.
        status='PASSED'if complete and failure is None else'FAILED'
        try:report=closed_report(status,args.execution_source_commit,policy_pin,case_pin,components,failure)
        except BaseException:report=closed_report('FAILED',args.execution_source_commit,policy_pin,case_pin,failure='PUBLIC_PROJECTION_REFUSED');complete=False;failure='PUBLIC_PROJECTION_REFUSED'
        try:
            write_report(report_root,report)
            guard.cleanup()
            if complete and failure is None:guard()
        finally:
            signal.setitimer(signal.ITIMER_REAL,0)
            for sig,previous in old_handlers.items():signal.signal(sig,previous)
    if not complete or failure is not None:raise SystemExit(1)

if __name__=='__main__':main()
