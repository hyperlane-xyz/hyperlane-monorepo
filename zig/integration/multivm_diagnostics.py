"""Bounded public observer diagnostics; no messages, request data or proof credit."""
from pathlib import Path
import ast
import base64
import copy
import hashlib
import io
import json
import os
import re
import stat
import threading
import types

STAGES={'shutdown','capture','preflight','live','before_restart','after_restart','restart','final','sampler','transport','restart_approval','restart_canonical','restart_identity','restart_readiness','restart_checkpoints','restart_continuous'}
LIMIT=256*1024


def pin(path):
    path=Path(path)
    if path.is_symlink()or not path.is_file()or path.stat().st_size>1024*1024:raise ValueError('Diagnostic source must be regular')
    return {'path':str(path),'bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}


def checked_modules(modules,directory):
    """Names/locations/hashes come only from already approved Python modules."""
    out={};directory=Path(directory).resolve()
    for name,row in modules.items():
        if not isinstance(name,str)or not re.fullmatch(r'multivm_[a-z_]+\.py',name):continue
        path=directory/name
        if len(out)>=32:break
        try:
            if row==pin(path)and path.resolve()==path:out[str(path)]=(name,dict(row))
        except(ValueError,OSError):continue
    return out


def public_frames(error,modules,directory):
    approved=checked_modules(modules,directory);frames=[];unapproved=0;tb=error.__traceback__;walked=0
    while tb is not None and walked<64:
        walked+=1;code=tb.tb_frame.f_code;path=str(Path(code.co_filename).resolve())
        if path in approved and re.fullmatch(r'[A-Za-z_<>][A-Za-z_<>0-9]*',code.co_name):
            name,row=approved[path];frames.append({'module':name,'source':row,'function':code.co_name,'line':tb.tb_lineno})
        else:unapproved+=1
        tb=tb.tb_next
    return {'frames':frames[-8:],'unapproved_frames_omitted':unapproved,'stack_truncated':tb is not None or len(frames)>8}


def note_success(session,role,chain,start,received):
    """Called under Session.lock. Diagnostic state never affects observer logic."""
    try:
        captures=[v['captured_monotonic_ns']for v in getattr(session,'captures',[])if v['original']['role']==role and chain in v['original']['role_chain_names']]
        if not captures:return
        capture=max(captures)
        if type(start)is not int or type(received)is not int or not capture<start<=received:return
        if not hasattr(session,'diagnostic_first_activity'):session.diagnostic_first_activity={}
        key=(role,chain);old=session.diagnostic_first_activity.get(key)
        if old is not None and old['capture_monotonic_ns']==capture:return
        if len(session.diagnostic_first_activity)>=16 and key not in session.diagnostic_first_activity:return
        session.diagnostic_first_activity[key]={'capture_monotonic_ns':capture,'request_started_monotonic_ns':start,'response_received_monotonic_ns':received}
    except Exception:return


def snapshot(session,now):
    with session.lock:
        captures={}
        for capture in getattr(session,'captures',[])[-64:]:
            role=capture['original']['role']
            for chain in capture['original']['role_chain_names']:
                if role not in {'relayer','validator','scraper'}or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}',chain):continue
                key=(role,chain);captures[key]=max(captures.get(key,0),capture['captured_monotonic_ns'])
        def pair(value):
            if not isinstance(value,dict):return None
            start=value.get('request_started_monotonic_ns');received=value.get('response_received_monotonic_ns')
            if type(start)is not int or type(received)is not int or not 0<=start<=received<=now:return {'invalid_clock_pair':True}
            return {'request_started_monotonic_ns':start,'response_received_monotonic_ns':received,'request_age_ns':now-start,'response_age_ns':now-received}
        rows=[]
        for (role,chain),capture in sorted(captures.items())[:16]:
            first=getattr(session,'diagnostic_first_activity',{}).get((role,chain))
            if first is not None and first.get('capture_monotonic_ns')!=capture:first=None
            rows.append({'role':role,'chain':chain,'capture_monotonic_ns':capture,'first_successful_new_capture_exchange':pair(first),'latest_successful_exchange':pair(getattr(session,'successful_activity',{}).get((role,chain)))})
        window=getattr(session,'restart_window',None);samples=[]if window is None else window.samples
        return {'observed_monotonic_ns':now,'restart_sample_count':len(samples),'restart_failed':False if window is None else window.failed,'restart_first_observed_ns':None if not samples else samples[0]['observed_monotonic_ns'],'restart_last_observed_ns':None if not samples else samples[-1]['observed_monotonic_ns'],'role_activity':rows,'observer_failure_count':len(getattr(session,'failures',[])),'lifecycle_error_count':len(getattr(getattr(session,'lifecycle',None),'errors',[]))}


class Recorder:
    def __init__(self,path,modules,directory):
        self.path=Path(path);self.modules=modules;self.directory=Path(directory);self.lock=threading.Lock()
        if self.path.exists()or self.path.is_symlink():raise ValueError('Preserve existing diagnostic file')
        self.value={'schema':1,'kind':'public-native-observer-diagnostics','stages':{},'failures':{},'dropped_new_failure_signatures':0,'native_or_timing_credit':False,'scope':'Only approved source frames, stage/attempt status and observed public monotonic clocks; no exception message, locals, payload, config or environment.'}
    def save(self):
        wire=json.dumps(self.value,sort_keys=True,separators=(',',':')).encode()+b'\n'
        if len(wire)>LIMIT:raise ValueError('Diagnostic output bound')
        if self.path.is_symlink():raise ValueError('Diagnostic output symlink')
        temp=self.path.with_name(self.path.name+'.'+str(os.getpid())+'.tmp')
        try:
            with temp.open('xb')as stream:stream.write(wire);stream.flush();os.fsync(stream.fileno())
            os.replace(temp,self.path)
        finally:
            if temp.exists():temp.unlink()
    def enter(self,stage,state):
        if stage not in STAGES:stage='unknown'
        with self.lock:
            row=self.value['stages'].setdefault(stage,{'attempts':0,'first':None,'latest':None});row['attempts']=min(row['attempts']+1,2**32-1)
            token={'stage':stage,'attempt':row['attempts'],'started_monotonic_ns':state['observed_monotonic_ns'],'finished_monotonic_ns':None,'status':'inflight','state':copy.deepcopy(state)}
            if row['first']is None:row['first']=copy.deepcopy(token)
            row['latest']=copy.deepcopy(token);self.value['last_stage']=copy.deepcopy(token);self.save();return token
    def finish(self,token,state,status,error=None):
        with self.lock:
            row=copy.deepcopy(token);row.update(finished_monotonic_ns=state['observed_monotonic_ns'],status=status,state=copy.deepcopy(state))
            if error is not None:
                kind=type(error).__name__;row['exception_type']=kind if re.fullmatch('[A-Za-z_][A-Za-z_0-9]{0,127}',kind)else'UnclassifiedException'
                row.update(public_frames(error,self.modules,self.directory))
                signature=hashlib.sha256(json.dumps({'stage':row['stage'],'exception_type':row['exception_type'],'frames':row['frames']},sort_keys=True).encode()).hexdigest()
                if signature not in self.value['failures']:
                    if len(self.value['failures'])<8:self.value['failures'][signature]={'count':0,'first':copy.deepcopy(row),'latest':None}
                    else:self.value['dropped_new_failure_signatures']=min(self.value['dropped_new_failure_signatures']+1,2**32-1)
                if signature in self.value['failures']:
                    failure=self.value['failures'][signature];failure['count']=min(failure['count']+1,2**32-1);failure['latest']=copy.deepcopy(row)
            stage=self.value['stages'][row['stage']]
            if stage['latest']['attempt']==row['attempt']:stage['latest']=copy.deepcopy(row)
            if self.value['last_stage']['stage']==row['stage']and self.value['last_stage']['attempt']==row['attempt']:self.value['last_stage']=copy.deepcopy(row)
            self.save()


def observer_startup_sites(log,modules,directory,entry_script):
    """Project only pinned Source frames from a completed local startup log.

    Printed traceback frames explain a failed startup; they grant no execution,
    signature or native proof credit. Never retain source snippets or messages.
    """
    path=Path(log);before=path.lstat()
    if not stat.S_ISREG(before.st_mode)or before.st_size>32*1024**2:raise ValueError('Bounded regular observer log required')
    raw=path.read_bytes();after=path.lstat()
    if (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns)or len(raw)!=before.st_size:raise ValueError('Observer log changed during snapshot')
    approved=checked_modules(modules,directory)
    if not isinstance(entry_script,dict)or set(entry_script)!={'path','bytes','sha256'}:raise ValueError('Exact approved observer entry descriptor required')
    entry=Path(entry_script['path'])
    expected=Path(directory).resolve()/'multivm_process.py'
    if entry!=expected or entry.resolve(strict=True)!=entry or entry_script!=pin(entry):raise ValueError('Actual pinned observer entry differs')
    approved[str(entry)]=(entry.name,dict(entry_script))
    frames=[];omitted=0;tracebacks=0;walked=0;active=False;truncated=False
    for line in raw.splitlines():
        if len(line)>65536:truncated=True;active=False;continue
        text=re.sub(r'\x1b\[[0-9;]*m','',line.decode('utf-8','replace'))
        if text=='Traceback (most recent call last):':
            tracebacks+=1;active=True
            if tracebacks>8:truncated=True;break
            continue
        if not active:continue
        match=re.fullmatch(r'  File "([^"\r\n]{1,4096})", line ([1-9][0-9]{0,6}), in ([A-Za-z_<>][A-Za-z_<>0-9]{0,127})',text)
        if match is None:
            if text and not text.startswith('    '):active=False
            continue
        walked+=1
        if walked>64:truncated=True;break
        filename,line_,_function=match.groups();line_=int(line_)
        # Exact approved absolute paths only: no suffix/path inference.
        if filename not in approved:omitted+=1;continue
        name,row=approved[filename]
        if not 0<line_<=len(Path(filename).read_bytes().splitlines()):omitted+=1;continue
        # Unlike a live traceback object, printed function text is untrusted.
        # Project only the approved Source identity and bounded line number.
        frames.append({'module':name,'source':row,'line':line_})
    return {'log':{'path':str(path),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()},'frames':frames[-8:],'unapproved_frames_omitted':omitted,'stack_truncated':truncated or len(frames)>8,'recognized_tracebacks':min(tracebacks,8),'native_or_timing_credit':False}


def rust_panic_observation(log,sources,repo,radix_client_lock=None,radix_scraper=None):
    """One checked capture; approved sites and Source-bound finite reason labels."""
    def capture(path,maximum):
        path=Path(path);info=path.lstat()
        if path.is_symlink()or not stat.S_ISREG(info.st_mode)or info.st_size>maximum:raise ValueError('Bounded regular diagnostic input required')
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
        try:
            opened=os.fstat(fd)
            if(info.st_dev,info.st_ino)!=(opened.st_dev,opened.st_ino):raise ValueError('Diagnostic input changed before capture')
            with os.fdopen(fd,'rb',closefd=False)as stream:wire=stream.read(maximum+1)
            after=os.fstat(fd);latest=path.lstat();identity=lambda v:(v.st_dev,v.st_ino,v.st_size,v.st_mtime_ns)
            if len(wire)!=info.st_size or len(wire)>maximum or identity(info)!=identity(after)or identity(info)!=identity(latest):raise ValueError('Diagnostic input changed while capturing')
        finally:os.close(fd)
        return wire,{'path':str(path),'bytes':len(wire),'sha256':hashlib.sha256(wire).hexdigest()}
    wire,fingerprint=capture(log,32*1024**2)
    approved={};bodies={}
    for name,row in sources.items():
        if len(approved)>=256:break
        if not (re.fullmatch(r'rust/main/utils/run-locally/src/[A-Za-z0-9_./-]+\.rs',name)or radix_client_lock is not None and name in RADIX_SUBMIT_SOURCES)or'..'in Path(name).parts:continue
        source=Path(repo)/name;body,actual=capture(source,1024*1024)
        if actual==row:approved[name]=dict(row);bodies[name]=body
    if radix_client_lock is not None:
        try:
            source=Path(repo)/RADIX_SUBMIT_LOCK;body,actual=capture(source,1024*1024)
            if actual==radix_client_lock:approved[RADIX_SUBMIT_LOCK]=actual;bodies[RADIX_SUBMIT_LOCK]=body
        except (OSError,ValueError,TypeError):pass
    helper='rust/main/utils/run-locally/src/external_agents.rs';caller='rust/main/utils/run-locally/src/sealevel/warp_route_composite_ism.rs'
    needed=(b'"symlink in owned writable path: {}"',b'"owned parent is not a directory"',b'pub fn svm_tempfile() -> Result<tempfile::NamedTempFile>',b'create_owned_directory(&manifest.task_root, Path::new("tmp"))?;',b'tempfile::NamedTempFile::new_in(root)?;')
    reason_source=helper in bodies and all(value in bodies[helper]for value in needed)
    # Standard Linux IO phrases are observations only within the exact admitted
    # SVM tempfile expect message; they are never classified across arbitrary log.
    labels={b'symlink in owned writable path':'OWNED_PATH_SYMLINK',b'owned parent is not a directory':'OWNED_PARENT_NOT_DIRECTORY',b'No space left on device':'IO_NO_SPACE_LEFT',b'Permission denied':'IO_PERMISSION_DENIED',b'File exists':'IO_FILE_EXISTS'}
    prefix=b'Failed to create temp ISM config:';output=[];seen=set();reasons=set();await_message=False
    def message(body):
        body=body.strip()
        if not body.startswith(prefix):return
        for phrase,label in labels.items():
            if phrase in body:reasons.add(label)
    for raw in io.BytesIO(wire):
        if len(raw)>65536:await_message=False;continue
        clean=re.sub(rb'\x1b\[[0-9;]*m',b'',raw);text=clean.decode('utf-8','replace')
        header=re.match(r"^thread '[^'\r\n]{1,128}'(?: \([0-9]{1,20}\))? panicked at ",text)
        if header is None:
            if await_message and clean.strip():message(clean);await_message=False
            continue
        await_message=False
        # Parse the immediate header location independently of approved suffixes.
        # A later Source-looking token in panic text cannot grant reason authority.
        actual_location=re.match(r'[^:\r\n]{1,4096}:\d{1,7}:\d{1,5}(?=[:\s])',text[header.end():])
        actual_location_end=None if actual_location is None else header.end()+actual_location.end()
        for match in re.finditer(r'((?:rust/main/)?utils/run-locally/src/[A-Za-z0-9_./-]+\.rs):(\d{1,7}):(\d{1,5})(?=[:\s])',text):
            name,line_,column=match.groups();name=name if name.startswith('rust/main/')else'rust/main/'+name;identity=(name,int(line_),int(column))
            if name not in approved:continue
            lines=bodies[name].splitlines()
            if not 0<identity[1]<=len(lines)or identity[2]==0:continue
            if identity not in seen and len(output)<8:
                seen.add(identity);output.append({'module':name,'source':approved[name],'line':identity[1],'column':identity[2]})
            if identity not in seen:continue
            snippet=lines[identity[1]-1]
            context=actual_location_end==match.end() and reason_source and name==caller and re.search(rb'svm_tempfile\(\)\s*\.expect\(\s*"Failed to create temp ISM config"\s*\)',snippet)is not None
            if context:
                trailing=text[match.end():].lstrip(': \r\n').encode()
                if trailing:message(trailing)
                else:await_message=True
    authority={'module':helper,'source':approved[helper],'owned_path_guard_literals_verified':True,'tempfile_directory_and_file_calls_verified':True}if reasons else None
    scraper_headers=None
    if radix_scraper is not None:
        try:scraper_headers=radix_scraper.headers(wire)
        except Exception:scraper_headers={'collection_status':'unavailable'}
    return {**({'Radix_scraper_headers':scraper_headers}if radix_scraper is not None else{}),'sites':output,'reason_codes':sorted(reasons),'reason_source':authority,'log_fingerprint':fingerprint,'EVM_child_wait_text':evm_child_wait_text_observation(wire,bodies,approved),**({'Radix_submit_error_text':radix_submit_error_text_observation(wire,bodies,approved,radix_client_lock)}if radix_client_lock is not None else{})}



RADIX_SUBMIT_SOURCES = (
    'rust/main/chains/hyperlane-radix/src/error.rs',
    'rust/main/hyperlane-core/src/error.rs',
    'rust/main/hyperlane-core/src/rpc_clients/error.rs',
)
RADIX_SUBMIT_LOCK = 'rust/main/Cargo.lock'
RADIX_CLIENT_REVISION = '2d284dad4ef48cab302cfa0435c548b54923b7e1'
RADIX_GATEWAY_ERRORS = frozenset((
    'AccountLockerNotFoundError', 'EntityNotFoundError', 'InvalidEntityError',
    'NotSyncedUpError', 'InvalidRequestError', 'InvalidTransactionError',
    'TransactionNotFoundError', 'InternalServerError',
))


RADIX_SUBMIT_SOURCE_SHA = {
    'rust/main/utils/run-locally/src/radix/cli.rs': 'e299c8770820273b71d24419a024ae59' + '915fdb2b111348be4dc5ed02f074ef54',
    'rust/main/chains/hyperlane-radix/src/error.rs': '1c46514e6dfe175000407250465cf3da' + '2af3c75ab287de08392e9de67e76f7e1',
    'rust/main/hyperlane-core/src/error.rs': '1fabecdb5cdfe68d75c6b847b465fcbe' + '5c3d2530e3e802012a7d2f9554f18458',
    'rust/main/hyperlane-core/src/rpc_clients/error.rs': '91a65cc7086fbb45123a30130015d859' + '0514f60a46184daf09136f04c4de819e',
    'rust/main/Cargo.lock': '773987fad52712c3c433427be0bb881f' + '7b87a6c6b4378193c0f637eefcdaf4ee',
}

class RadixDebugUnavailable(ValueError):
    pass


def radix_debug_string(text):
    """Decode one bounded Rust Debug String; never return it to a publisher."""
    if not isinstance(text,str) or not 2<=len(text)<=65536 or text[0]!='"' or text[-1]!='"':raise RadixDebugUnavailable()
    output=[];i=1
    while i<len(text)-1:
        char=text[i];i+=1
        if char=='"' or ord(char)<32:raise RadixDebugUnavailable()
        if char!='\\':output.append(char);continue
        if i>=len(text)-1:raise RadixDebugUnavailable()
        char=text[i];i+=1
        escapes={'n':'\n','r':'\r','t':'\t','0':'\0','\\':'\\','"':'"',"'":"'"}
        if char in escapes:output.append(escapes[char]);continue
        if char=='x':
            digits=text[i:i+2]
            if len(digits)!=2 or re.fullmatch('[0-9a-fA-F]{2}',digits)is None or int(digits,16)>127:raise RadixDebugUnavailable()
            output.append(chr(int(digits,16)));i+=2;continue
        if char=='u' and text[i:i+1]=='{':
            end=text.find('}',i+1,i+9);digits=text[i+1:end]if end>=0 else''
            if re.fullmatch('[0-9a-fA-F]{1,6}',digits)is None:raise RadixDebugUnavailable()
            code=int(digits,16)
            if code>0x10ffff or 0xd800<=code<=0xdfff:raise RadixDebugUnavailable()
            output.append(chr(code));i=end+1;continue
        raise RadixDebugUnavailable()
    return ''.join(output)


def radix_debug_parts(text):
    """Split structural commas only; quoted private data never becomes syntax."""
    if not isinstance(text,str)or len(text)>65536:raise RadixDebugUnavailable()
    stack=[];parts=[];start=0;i=0;matching={')':'(',']':'[','}':'{'}
    while i<len(text):
        char=text[i]
        if char=='"':
            first=i;i+=1
            while i<len(text):
                if text[i]=='\\':i+=2;continue
                if text[i]=='"':break
                i+=1
            if i>=len(text):raise RadixDebugUnavailable()
            radix_debug_string(text[first:i+1]);i+=1;continue
        if char in '([{':
            stack.append(char)
            if len(stack)>32:raise RadixDebugUnavailable()
        elif char in ')]}':
            if not stack or stack.pop()!=matching[char]:raise RadixDebugUnavailable()
        elif char==',' and not stack:
            parts.append(text[start:i].strip());start=i+1
            if len(parts)>64:raise RadixDebugUnavailable()
        i+=1
    if stack:raise RadixDebugUnavailable()
    final=text[start:].strip()
    if final:parts.append(final)
    elif parts:raise RadixDebugUnavailable()
    return parts


def radix_debug_call(text,name):
    prefix=name+'('
    if not text.startswith(prefix)or not text.endswith(')'):raise RadixDebugUnavailable()
    inner=text[len(prefix):-1];radix_debug_parts(inner);return inner


def radix_debug_fields(text,name,fields):
    prefix=name+' { '
    if not text.startswith(prefix)or not text.endswith(' }'):raise RadixDebugUnavailable()
    parts=radix_debug_parts(text[len(prefix):-2])
    if len(parts)!=len(fields):raise RadixDebugUnavailable()
    values={}
    for key,part in zip(fields,parts):
        if not part.startswith(key+': '):raise RadixDebugUnavailable()
        values[key]=part[len(key)+2:]
    return values


def radix_submit_debug_leaf(text):
    inner=radix_debug_call(text,'Other');variant=inner.split('(',1)[0]
    if variant not in {'ReqwestError','ResponseError','Serde','Io'}:
        return {'variant':'UNKNOWN','http_status_text':None,'entity_kind':'UNKNOWN','gateway_error_type_text':None,'details_shape':'UNKNOWN','content_fingerprint':None,'message_fingerprint':None}
    payload=radix_debug_call(inner,variant)
    row={'variant':variant,'http_status_text':None,'entity_kind':'UNKNOWN','gateway_error_type_text':None,'details_shape':'UNKNOWN','content_fingerprint':None,'message_fingerprint':None}
    if variant!='ResponseError':return row
    response=radix_debug_fields(radix_debug_string(payload),'ResponseContent',('status','content','entity'))
    if re.fullmatch('[45][0-9]{2}',response['status'])is None:raise RadixDebugUnavailable()
    row['http_status_text']=int(response['status'])
    def fingerprint(text):
        wire=text.encode('utf-8');return {'bytes':len(wire),'sha256':hashlib.sha256(wire).hexdigest()}
    row['content_fingerprint']=fingerprint(radix_debug_string(response['content']))
    if response['entity']=='None':row['entity_kind']='NONE';return row
    entity=radix_debug_call(response['entity'],'Some')
    if entity.startswith('UnknownValue('):
        radix_debug_call(entity,'UnknownValue');row['entity_kind']='UNKNOWN_VALUE';return row
    entity=radix_debug_fields(radix_debug_call(entity,'Status4XX'),'ErrorResponse',('code','details','message','trace_id'))
    if entity['code']!='None':
        code=radix_debug_call(entity['code'],'Some')
        if re.fullmatch('-?(?:0|[1-9][0-9]{0,9})',code)is None or not -(2**31)<=int(code)<2**31:raise RadixDebugUnavailable()
    if entity['trace_id']!='None':radix_debug_string(radix_debug_call(entity['trace_id'],'Some'))
    row['entity_kind']='STATUS4XX';row['message_fingerprint']=fingerprint(radix_debug_string(entity['message']))
    if entity['details']=='None':row['details_shape']='ABSENT';return row
    detail=radix_debug_call(entity['details'],'Some');kind=detail.split('(',1)[0]
    if kind not in RADIX_GATEWAY_ERRORS:return row
    radix_debug_call(detail,kind);row['gateway_error_type_text']=kind
    row['details_shape']='UNTYPED_JSON'if kind=='InvalidTransactionError'else'TYPED'
    return row


def radix_submit_error_text_observation(wire,bodies,approved,context):
    """Source-bound Debug text only; no typed exception, endpoint or causal claim."""
    result={'schema':1,'kind':'public-Radix-submit-error-text','collection_status':'unavailable','reason':'SOURCE_CONTEXT_UNAVAILABLE','envelope':'UNKNOWN','leaf_count':None,'errors':[],'expect_body_fingerprint':None,'Source_contracts':None,'client_revision':None,'text_only':True,'typed_IO_error_kind':None,'role':None,'pid':None,'primary_signal':None,'native_or_timing_or_cleanup_authority':False}
    caller='rust/main/utils/run-locally/src/radix/cli.rs'
    if context is None:return result
    try:
        names=(caller,*RADIX_SUBMIT_SOURCES,RADIX_SUBMIT_LOCK)
        for name in names:
            body=bodies[name]
            if name not in approved or hashlib.sha256(body).hexdigest()!=RADIX_SUBMIT_SOURCE_SHA[name]:raise RadixDebugUnavailable()
        if approved[RADIX_SUBMIT_LOCK]!=context:raise RadixDebugUnavailable()
        if bodies[caller].splitlines()[142]!=b'            .expect("Failed to submit transaction");':raise RadixDebugUnavailable()
        lock=bodies[RADIX_SUBMIT_LOCK]
        for package in ('gateway-api-client','gateway-api-client-async'):
            source=('name = "'+package+'"\nversion = "1.0.0"\nsource = "git+https://github.com/hyperlane-xyz/radix-apis-rust-clients.git?rev='+RADIX_CLIENT_REVISION+'#'+RADIX_CLIENT_REVISION+'"').encode()
            if lock.count(source)!=1:raise RadixDebugUnavailable()
        result['Source_contracts']={name:approved[name]for name in names};result['client_revision']=RADIX_CLIENT_REVISION
    except (KeyError,ValueError,IndexError,TypeError):return result
    message=None;waiting=False
    for raw in io.BytesIO(wire):
        if len(raw)>65536:result['reason']='LOG_LINE_BOUND';return result
        clean=re.sub(rb'\x1b\[[0-9;]*m',b'',raw)
        try:text=clean.decode('utf-8').rstrip('\r\n')
        except UnicodeError:result['reason']='LOG_ENCODING_UNAVAILABLE';return result
        header=re.match(r"^thread '[^'\r\n]{1,128}'(?: \([0-9]{1,20}\))? panicked at ",text)
        if header is None and text.startswith("thread '"):
            result['reason']='FIRST_PANIC_SITE_UNKNOWN';return result
        if header is not None:
            if waiting:result['reason']='EXPECT_BODY_UNAVAILABLE';return result
            location=re.match(r'([^:\r\n]{1,4096}):([1-9][0-9]{0,6}):([1-9][0-9]{0,4}):(?:\s|$)',text[header.end():])
            if location is None:result['reason']='FIRST_PANIC_SITE_UNKNOWN';return result
            name,line,column=location.groups();parts=name.split('/')
            canonical='\\'not in name and'\0'not in name and all(x not in {'','.','..'}for x in(parts[1:]if name.startswith('/')else parts))
            suffix='utils/run-locally/src/radix/cli.rs'
            if not canonical or not(name==suffix or name=='rust/main/'+suffix or name.endswith('/'+suffix))or(line,column)!=('143','14'):
                result['reason']='FIRST_PANIC_SITE_UNKNOWN';return result
            message=text[header.end()+location.end():].strip()
            if message:break
            waiting=True
        elif waiting and text.strip():message=text.strip();break
    if not message:result['reason']='EXPECT_BODY_UNAVAILABLE';return result
    raw=message.encode('utf-8');result['expect_body_fingerprint']={'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
    prefix='Failed to submit transaction: '
    if not message.startswith(prefix):result['reason']='EXPECT_PREFIX_UNAVAILABLE';return result
    try:
        text=message[len(prefix):]
        if text.startswith('RpcClientError('):
            vector=radix_debug_call(radix_debug_call(text,'RpcClientError'),'FallbackProvidersFailed')
            if not vector.startswith('[')or not vector.endswith(']'):raise RadixDebugUnavailable()
            leaves=radix_debug_parts(vector[1:-1]);envelope='FALLBACK_PROVIDERS_FAILED'
        else:leaves=[text];envelope='DIRECT'
        if not 1<=len(leaves)<=8:result['reason']='LEAF_BOUND';return result
        rows=[radix_submit_debug_leaf(leaf)for leaf in leaves]
        result.update(collection_status='observed',reason='SOURCE_BOUND_DEBUG_TEXT',envelope=envelope,leaf_count=len(rows),errors=rows)
    except (ValueError,UnicodeError,OverflowError):result['reason']='DEBUG_GRAMMAR_UNAVAILABLE'
    return result


def evm_child_wait_text_observation(wire,bodies,approved):
    """One already verified capture. Static text is not typed error/origin proof."""
    result={'schema':1,'kind':'public-EVM-child-wait-text-observation','collection_status':'unavailable','classification':'UNKNOWN','guard_text_code':None,'reason':'SOURCE_CONTEXT_UNAVAILABLE','caller_line':828,'caller_column':48,'Source_contracts':None,'typed_IO_error_kind':None,'role':None,'pid':None,'primary_signal':None,'text_only':True,'native_or_timing_or_cleanup_authority':False}
    main='rust/main/utils/run-locally/src/main.rs';helper='rust/main/utils/run-locally/src/external_agents.rs'
    def section(body,start,end):
        if body.count(start)!=1:raise ValueError('Unique Source context required')
        first=body.index(start);last=body.find(end,first+len(start))
        if last<0:raise ValueError('Bounded Source context required')
        return body[first:last]
    try:
        caller=bodies[main];fixture=bodies[helper]
        if main not in approved or helper not in approved:raise ValueError('Admitted Source required')
        line=b'        if let Some(status) = child.try_wait().unwrap() {'
        if caller.splitlines()[827]!=line or line.index(b'unwrap')+1!=48:raise ValueError('Exact caller required')
        check=section(caller,b'fn long_running_processes_exited_check(state: &mut State) -> bool {',b'\npub fn report_test_result(')
        if check.count(line)!=1 or b'for (name, (child, _)) in state.agents.iter_mut() {'not in check or b'crate::external_agents::TrackedChild,'not in section(caller,b'struct State {',b'\nimpl State {'):raise ValueError('Exact tracked caller required')
        wrapper=section(fixture,b'    pub fn try_wait(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {',b'\n    pub fn retain_restart(')
        expected=b'''    pub fn try_wait(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        if let Some(fixture) = &self.fixture {
            let state = fixture
                .processes
                .lock()
                .map_err(|_| std::io::Error::other("fixture monitor poisoned"))?;
            if let Some(error) = &state.failure {
                return Err(std::io::Error::other(error.clone()));
            }
        }
        self.child.try_wait()
    }'''
        if wrapper!=expected:raise ValueError('Exact wrapper required')
        monitor=section(fixture,b'impl EvmFixtureOwnership {',b'\nimpl Drop for EvmFixtureOwnership {')
        contracts=[b'initial.failure = Some(format!("{error:#}"));',b'let result = fixture_process_snapshot(&ps, group).and_then(|rows| {',b'observe_fixture_processes(&mut state, &rows, group, &allowed)',b'state.failure = Some(format!("{error:#}"));']
        if not all(x in monitor for x in contracts):raise ValueError('Exact monitor required')
        ownership=section(fixture,b'fn observe_fixture_processes(',b'\nimpl EvmFixtureOwnership {')
        snapshot=section(fixture,b'fn fixture_process_snapshot(',b'\nfn signal_fixture_process(')
        # Every phrase is bound to its real guard context, not a global string.
        catalog=[
            (b'fixture monitor poisoned','FIXTURE_MONITOR_POISONED_TEXT',wrapper,[b'.map_err(|_| std::io::Error::other("fixture monitor poisoned"))?;']),
            (b'fixture PID/start/parent changed','FIXTURE_IDENTITY_CHANGED_TEXT',ownership,[b'old.parent_pid == row.1 && old.group_pid == row.2 && old.start == row.3,\n                "fixture PID/start/parent changed"']),
            (b'fixture descendant executable not approved','FIXTURE_EXECUTABLE_UNAPPROVED_TEXT',ownership,[b'.find(|a| a.path == actual)\n                .ok_or_else(|| eyre::eyre!("fixture descendant executable not approved"))?;']),
            (b'fixture descendant count exceeds bound','FIXTURE_DESCENDANT_BOUND_TEXT',ownership,[b'known || state.known.len() < 256,\n                "fixture descendant count exceeds bound"']),
            (b'unknown fixture group member has no observed parent lineage','FIXTURE_LINEAGE_UNOBSERVED_TEXT',ownership,[b'rest.len() < before,\n            "unknown fixture group member has no observed parent lineage"']),
            (b'fixture process snapshot timeout','FIXTURE_SNAPSHOT_TIMEOUT_TEXT',snapshot,[b'Instant::now() < deadline,\n                "fixture process snapshot timeout"']),
            (b'fixture process snapshot output limit','FIXTURE_SNAPSHOT_OUTPUT_BOUND_TEXT',snapshot,[b'captured.metadata()?.len() <= 4 * 1024 * 1024,\n                "fixture process snapshot output limit"',b'bytes.len() <= 4 * 1024 * 1024,\n        "fixture process snapshot output limit"']),
            (b'fixture process snapshot failed','FIXTURE_SNAPSHOT_FAILED_TEXT',snapshot,[b'ensure!(status.success(), "fixture process snapshot failed");']),
        ]
        if not all(context.count(fragment)==1 for _,_,context,fragments in catalog for fragment in fragments):raise ValueError('Exact guard contexts required')
    except (KeyError,IndexError,ValueError):return result
    result['Source_contracts']={key:{'bytes':approved[name]['bytes'],'sha256':approved[name]['sha256']}for key,name in [('caller',main),('fixture',helper)]}
    result['reason']='NO_MAIN828_WINDOW';pending=False
    def body_observation(body):
        result.update(collection_status='observed',reason='NO_FIXED_GUARD_TEXT')
        try:body.decode('utf8','strict')
        except UnicodeError:result['reason']='MESSAGE_ENCODING_UNAVAILABLE';return result
        if not body.startswith(b'called `Result::unwrap()` on an `Err` value: '):result['reason']='NOT_UNWRAP_TEXT';return result
        labels={label for phrase,label,_,_ in catalog if phrase in body}
        if len(labels)==1:result.update(classification='FIXTURE_MONITOR_GUARD_TEXT',guard_text_code=next(iter(labels)),reason=None)
        elif len(labels)>1:result['reason']='AMBIGUOUS_FIXED_GUARD_TEXT'
        return result
    for raw in io.BytesIO(wire):
        if len(raw)>65536:
            result['reason']='LOG_LINE_BOUND';return result
        clean=re.sub(rb'\x1b\[[0-9;]*m',b'',raw)
        header=re.match(rb"^thread '[^'\r\n]{1,128}'(?: \([0-9]{1,20}\))? panicked at ",clean)
        if pending:
            if not clean.strip():continue
            if header is not None or clean.startswith(b'<')or clean.startswith(b'backtrace:')or clean.startswith(b'stack backtrace:'):result['reason']='NEXT_HEADER_BEFORE_MESSAGE';return result
            return body_observation(clean.strip())
        if header is None:continue
        # Only the FIRST canonical panic can qualify; later teardown cannot lend it.
        match=re.fullmatch(rb'([^:\r\n]{1,4096}):([0-9]{1,7}):([0-9]{1,5}):([^\r\n]*)[\r\n]*',clean[header.end():])
        if match is None:return result
        path,line,column,tail=match.groups();relative=b'utils/run-locally/src/main.rs';full=b'rust/main/'+relative
        canonical=path in {relative,full}or path.startswith(b'/')and not any(part in {b'',b'.',b'..'}for part in path[1:].split(b'/'))and b'\\'not in path and b'\x00'not in path and(path.endswith(b'/'+relative)or path.endswith(b'/'+full))
        if not canonical or int(line)!=828 or int(column)!=48:return result
        if tail.strip():return body_observation(tail.strip())
        pending=True;result['reason']='MESSAGE_NOT_RETAINED'
    return result



def starknet_admin_sampling_observation(case,manifest,modules,case_inputs,observer=None):
    """Failure-only terminal-attempt clocks; no raw admin data or proof credit."""
    absent={'schema':1,'collection_status':'unavailable','native_or_timing_or_cleanup_authority':False}
    def require(ok):
        if not ok:raise ValueError('Closed Stark admin diagnostic unavailable')
    def integer(value,maximum=2**64-1):return type(value)is int and 0<=value<=maximum
    try:
        expected={'starknettest23448593':23448593,'starknettest23448594':23448594}
        require(manifest['scenario']=='starknet'and case_inputs['scenario']=='starknet'and case_inputs['chain_names']==list(expected)and case_inputs['domain_names']=={str(domain):name for name,domain in expected.items()})
        # The caller already admitted modules/case-inputs. Recheck the row
        # producer; never import or execute its sampler here.
        source=modules['multivm_session.py'];path=Path(source['path'])
        require(set(source)=={'path','bytes','sha256'}and path.name=='multivm_session.py'and path.is_absolute()and path.resolve(strict=True)==path)
        body,identity=captured_failure_bytes(path,1024**2)
        require(identity=={key:source[key]for key in ('bytes','sha256')})
        tree=ast.parse(body);functions=[node for node in tree.body if isinstance(node,ast.FunctionDef)and node.name=='collect_admin_sample'];require(len(functions)==1)
        function=functions[0];timings=[node.value for node in ast.walk(function)if isinstance(node,ast.Assign)and any(isinstance(target,ast.Name)and target.id=='timing'for target in node.targets)]
        base={'chain','domain','port','attempt','request_started_monotonic_ns','whole_sample_deadline_ns'}
        require(len(timings)==1 and isinstance(timings[0],ast.Dict)and {ast.literal_eval(key)for key in timings[0].keys}==base)
        emitted={}
        for node in ast.walk(function):
            if not(isinstance(node,ast.Call)and isinstance(node.func,ast.Name)and node.func.id=='diagnostic'):continue
            require(len(node.args)==1 and not node.keywords)
            row=node.args[0];require(isinstance(row,ast.Call)and isinstance(row.func,ast.Name)and row.func.id=='dict'and len(row.args)==1 and isinstance(row.args[0],ast.Name)and row.args[0].id=='timing'and all(key.arg is not None for key in row.keywords))
            keys={key.arg:key.value for key in row.keywords};outcome=ast.literal_eval(keys['outcome']);require(outcome not in emitted);emitted[outcome]=set(keys)
        require(emitted=={'transport_timeout':{'response_received_monotonic_ns','outcome'},'hard_error':{'response_received_monotonic_ns','outcome','error_type'},'success':{'response_received_monotonic_ns','outcome','operation_count'}})
        policy=next(ast.literal_eval(node.value)for node in tree.body if isinstance(node,ast.Assign)and any(isinstance(target,ast.Name)and target.id=='OBSERVER_POLICY'for target in node.targets))
        require((policy['maximum_successful_domain_sample_gap_ns'],policy['maximum_GET_timeout_seconds'],policy['maximum_GET_attempts_per_domain'])==(10_000_000_000,2,8))
        sampler=next(node for cls in tree.body if isinstance(cls,ast.ClassDef)and cls.name=='Session'for node in cls.body if isinstance(node,ast.FunctionDef)and node.name=='_sample')
        handlers=[node for node in ast.walk(sampler)if isinstance(node,ast.ExceptHandler)]
        require(len(handlers)==1 and isinstance(handlers[0].body[-1],ast.Return)and handlers[0].body[-1].value is None)
        require(sum(isinstance(node,ast.Constant)and node.value=='admin-sampling-diagnostics.jsonl'for node in ast.walk(tree))==1)
        failure_ns=None
        if observer is not None:
            validate_record(observer,modules)
            failures=[row['first']['finished_monotonic_ns']for row in observer['failures'].values()if row['first']['stage']=='sampler']
            if failures:failure_ns=min(failures)
        case=Path(case);evidence=case/'evidence';require(case.is_absolute()and case.resolve(strict=True)==case and evidence.resolve(strict=True)==evidence)
        raw,fingerprint=captured_failure_bytes(evidence/'admin-sampling-diagnostics.jsonl',32*1024**2)
        require(raw and raw.endswith(b'\n'))
        complete=raw.count(b'\n');tail=raw.rsplit(b'\n',49)[:-1][-48:];rows=[]
        def unique(pairs):
            result={}
            for key,value in pairs:require(key not in result);result[key]=value
            return result
        errors={'TimeoutError','ConnectionRefusedError','ConnectionResetError','ConnectionAbortedError','BrokenPipeError','OSError','ValueError','JSONDecodeError','RemoteDisconnected','IncompleteRead','HTTPException','CannotSendRequest','ResponseNotReady','TypeError','KeyError','AssertionError'}
        for index,line in enumerate(tail,complete-len(tail)+1):
            require(0<len(line)<=4096)
            value=json.loads(line,object_pairs_hook=unique,parse_constant=lambda _:(_ for _ in()).throw(ValueError('nonfinite')))
            require(type(value)is dict and value.get('outcome')in emitted)
            outcome=value['outcome'];require(set(value)==base|emitted[outcome])
            require(value['chain']in expected and value['domain']==expected[value['chain']]and type(value['domain'])is int)
            require(type(value['port'])is int and 0<value['port']<=65535 and type(value['attempt'])is int and 1<=value['attempt']<=8)
            require(all(integer(value[key])for key in ['request_started_monotonic_ns','whole_sample_deadline_ns','response_received_monotonic_ns']))
            row={key:value[key]for key in ['chain','domain','port','attempt','request_started_monotonic_ns','whole_sample_deadline_ns','response_received_monotonic_ns','outcome']};row['journal_line']=index
            start,end,deadline=(value[key]for key in ['request_started_monotonic_ns','response_received_monotonic_ns','whole_sample_deadline_ns'])
            # Late rows are precisely the needed evidence, never accepted work.
            row.update(elapsed_ns=end-start,remaining_at_request_start_ns=deadline-start,response_after_deadline_ns=max(0,end-deadline),clock_rollback_observed=end<start)
            if outcome=='success':require(integer(value['operation_count'],2**32-1));row['operation_count']=value['operation_count']
            if outcome=='hard_error':require(type(value['error_type'])is str);row['error_type']=value['error_type']if value['error_type']in errors else'OtherError'
            rows.append(row)
        record={'schema':1,'collection_status':'observed','source_contract':{'module':'multivm_session.py',**identity,'Source_sampler_exception_handler_returns':True},'input':fingerprint,'input_limit_bytes':32*1024**2,'complete_line_count':complete,'selected_tail_line_count':len(rows),'prefix_lines_not_parsed':complete-len(rows),'selection':'Last48 complete terminal-attempt rows in journal order; earliest sampler exception retained separately in existing public observer diagnostics.','sampler_exception_observed_monotonic_ns':failure_ns,'rows':rows,'scope':'Existing completed-attempt timing only. A pre-request deadline failure can leave no row. No request start/whole-round duration or unique cause is inferred from an absent row or sampler exception timestamp. No raw operations, URLs, addresses, messages or exception text. Original10s/2s/8attempt and latched failure guards unchanged.','native_or_timing_or_cleanup_authority':False}
        require(len(json.dumps(record,sort_keys=True,separators=(',',':')).encode())<=24*1024)
        return record
    except(OSError,ValueError,TypeError,KeyError,OverflowError,RecursionError,SyntaxError,StopIteration):return absent


def captured_failure_bytes(path, maximum):
    """One stable bounded regular file; private bytes are never returned publicly."""
    path=Path(path);before=path.lstat()
    if not stat.S_ISREG(before.st_mode) or path.is_symlink() or before.st_nlink!=1 or before.st_size>maximum:raise ValueError('Bounded single-link diagnostic file required')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        opened=os.fstat(fd)
        identity=lambda row:(row.st_dev,row.st_ino,row.st_size,row.st_mtime_ns,row.st_nlink)
        if identity(before)!=identity(opened)or not stat.S_ISREG(opened.st_mode):raise ValueError('Diagnostic file changed before capture')
        with os.fdopen(fd,'rb',closefd=False)as stream:wire=stream.read(maximum+1)
        if len(wire)!=before.st_size or len(wire)>maximum or identity(before)!=identity(os.fstat(fd))or identity(before)!=identity(path.lstat()):raise ValueError('Diagnostic file changed during capture')
    finally:os.close(fd)
    return wire,{'bytes':len(wire),'sha256':hashlib.sha256(wire).hexdigest()}


def zig_role_source_frames(raw,prefixes,catalog,repo):
    """Relative coordinates from Source-prefixed text, never execution evidence."""
    if not isinstance(catalog,dict)or len(catalog)>768:raise ValueError('Bounded Zig frame catalog required')
    total=0
    for name,row in catalog.items():
        if not isinstance(name,str)or re.fullmatch(r'zig/src/[A-Za-z0-9_./-]+\.zig',name)is None or str(Path(name))!=name or'..'in Path(name).parts or not isinstance(row,dict)or set(row)!={'path','bytes','sha256'}or row['path']!=str(Path(repo)/name)or type(row['bytes'])is not int or not 0<row['bytes']<=1024**2 or not isinstance(row['sha256'],str)or re.fullmatch('[0-9a-f]{64}',row['sha256'])is None:raise ValueError('Exact admitted Zig frame catalog required')
        total+=row['bytes']
    if total>16*1024**2:raise ValueError('Bounded Zig frame Source bytes required')
    allowed={p for p in prefixes if p in {'RLY','VL1','VL2','VL3'}};result={p:[]for p in allowed};seen=set();cache={};count=0;captured=0
    for line in io.BytesIO(raw):
        if len(line)>65536:continue
        clean=re.sub(rb'\x1b\[[0-9;]*m',b'',line).strip();prefix=re.match(rb'^<(RLY|VL1|VL2|VL3)> ',clean)
        if prefix is None:continue
        role=prefix[1].decode()
        if role not in allowed:continue
        body=clean[prefix.end():].lstrip()
        match=re.match(rb'^((?:/[^:\r\n]{1,4096}/)?zig/src/[A-Za-z0-9_./-]+\.zig|src/[A-Za-z0-9_./-]+\.zig):([0-9]{1,7}):([0-9]{1,7})(?=[:\s]|$)',body)
        if match is None:continue
        printed=match[1].decode();name=printed[printed.rfind('/zig/src/')+1:]if '/zig/src/'in printed else'zig/'+printed if printed.startswith('src/')else printed;row=catalog.get(name)
        if row is None:continue
        if name not in cache:
            cache[name]=None
            try:
                path=Path(repo)/name
                if any(p.is_symlink()for p in [path,*[p for p in path.parents if p.is_relative_to(repo)]]):continue
                source,fingerprint=captured_failure_bytes(path,1024**2);captured+=len(source)
                if captured>16*1024**2:break
                if row=={'path':str(path),**fingerprint}:cache[name]=source.splitlines()
            except Exception:continue
        source_lines=cache[name];line_number,column=int(match[2]),int(match[3])
        if source_lines is None or not 0<line_number<=len(source_lines)or not 0<column<=len(source_lines[line_number-1])+1:continue
        key=(role,name,line_number,column)
        if key in seen:continue
        seen.add(key);result[role].append({'source':name,'line':line_number,'column':column});count+=1
        if count==8:break
    return result




def svm_private_windows(raw,sources,repo,scenario,check=lambda:None):
    """Private Source-tagged bytes only; never a PID/epoch or error attribution."""
    if scenario not in {'sealevel','sealevel-composite'}or not isinstance(raw,bytes)or len(raw)>32*1024**2:raise ValueError('Bounded SVM capture required')
    root='rust/main/utils/run-locally/src/'
    contracts={root+'program.rs':[b'let mut reader = BufReader::new(output).lines();',b'println!("<{prefix}> {line}");'],root+'sealevel/solana.rs':[b'args.spawn("SOL", None)'],root+'sealevel/mod.rs':[b'.zip(["SCR1", "SCR2", "SCR3"])',b'scraper_env.spawn(scraper_name, None)']}
    for name,needles in contracts.items():
        check()
        path=Path(repo)/name;body,fingerprint=captured_failure_bytes(path,1024**2)
        if sources.get(name)!={'path':str(path),**fingerprint}or any(body.count(needle)!=1 for needle in needles):raise ValueError('SVM prefix Source changed')
    # Physical-line anchors only. Prefix writer is uncolored; payload ANSI/bytes stay private.
    prefix={tag:bytearray()for tag in ('SOL','SCR')};tail={tag:bytearray()for tag in prefix};sizes=dict.fromkeys(prefix,0);oversized=0
    for line in io.BytesIO(raw):
        check()
        if len(line)>65536:oversized=min(2**32-1,oversized+1);continue
        for tag in prefix:
            markers=(b'<SOL> ',)if tag=='SOL'else(b'<SCR1> ',b'<SCR2> ',b'<SCR3> ')
            if not any(line.startswith(marker)for marker in markers)or tag=='SCR'and scenario=='sealevel-composite':continue
            sizes[tag]+=len(line);room=4096-len(prefix[tag]);prefix[tag].extend(line[:room]);tail[tag].extend(line);del tail[tag][:-4096]
    windows=[];plain=bytearray()
    for tag in ('SOL','SCR'):
        # Remove overlap in short streams, preserving byte-exact prefix then suffix.
        suffix=bytes(tail[tag])[max(0,len(prefix[tag])+len(tail[tag])-sizes[tag]):]
        for position,wire in [('first',bytes(prefix[tag])),('tail',suffix)]:
            windows.append({'tag':tag,'position':position,'bytes':len(wire)});plain.extend(wire)
    check()
    if len(plain)>16384:raise ValueError('SVM private window bound')
    return bytes(plain),{'windows':windows,'oversized_lines_omitted':oversized,'scope':'Fixed Source-tagged merged pipe bytes; no unique PID/epoch/typed exception claim.'}


SVM_ENCRYPTION_KEY_ID = '8bab6daee3714c8284aa166219000493'+'8b0a5dfb10dea336372e4b11f51e0655'
SVM_ENCRYPTION_SCRIPT = "'use strict';\nconst fs=require('node:fs'),crypto=require('node:crypto');\nif(process.version!=='v26.12.1')process.exit(2);\nconst chunks=[];let total=0;const buffer=Buffer.alloc(4096);\nfor(;;){const n=fs.readSync(0,buffer,0,buffer.length,null);if(!n)break;total+=n;if(total>16384)process.exit(2);chunks.push(Buffer.from(buffer.subarray(0,n)));}\nconst plain=Buffer.concat(chunks);if(!plain.length)process.exit(2);\nconst key=crypto.createPublicKey('-----BEGIN PUBLIC KEY-----\\nMIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAxe5zq7ZGiGgBvSAtT+hX\\nS4ezY8xH8aOO3+8YcQSe7p0v/l6TFKQjHcyJxDClozTxFtowMRXmR6dMb014MS7r\\ny7pu0OITH8o/WWUCc0nUodtU1WH/lHaEOw1Q1mE24Im25YZYpMUzNXCfia9YHB3R\\nn1+grv9Ii9334GsUMBCwgb/XK6Sql3Nx/fKsjBC5pyaC28ErrGHIf5pU79RYoUUR\\nkcF4FEOcUoczsFDy/AvwFM2fH64QFDxOfoty/lpROhQIcTKwX/IKDnnPleHa4V0O\\nSv/YdavwPK9ffZ+b7GDLEhJhhu6akSfhR/SjXrDOGAYMs9vRliztUearu6aDKVNq\\nHVt0+X72NyT2BAzZ0WW/U0BrKBSWCJtzzdrYGlmWZaDnw5ewDmHuAeW+FTP2VBEJ\\ntGaXqeNLnrnnJ28cxbHd6MecqUbSl9S5FIVfvahkyAM9mOdvPdKri3NyRQwPatqv\\nhefBMiQ2r7gKRKzXcrsyZM+9CoTiB/ZJY8cZdDOo/cEai3nMN7ZWoFlCqZ33j/OM\\npWBlD9TyMYb1Xlz2+zX1TrB/UhbFfASBghgZiIDpOmpwjFf8pQyvydhSVf4iiEMf\\nYoGk4zaFR/5sH46x2jJl7DfJGvk9y/O/30LOGbvN493ayrG9DBT52PX8i1RT7+DZ\\nXG9dTcSWOCb847U28lDwtxsCAwEAAQ==\\n-----END PUBLIC KEY-----\\n'),der=key.export({type:'spki',format:'der'});\nif(crypto.createHash('sha256').update(der).digest('hex')!=='8bab6daee3714c8284aa166219000493'+'8b0a5dfb10dea336372e4b11f51e0655')process.exit(2);\nlet limits=null;if(process.platform==='linux'){const fd=fs.openSync('/proc/self/limits','r');const b=Buffer.alloc(4097);let n;try{n=fs.readSync(fd,b,0,b.length,null);}finally{fs.closeSync(fd);}if(n>4096)process.exit(2);const text=b.subarray(0,n).toString('ascii');limits={};for(const [name,label,unit] of [['address_space','Max address space','bytes'],['open_files','Max open files','files']]){const match=text.match(new RegExp('^'+label+' +([0-9]+|unlimited) +([0-9]+|unlimited) +'+unit+' *$','m'));if(!match)process.exit(2);limits[name]=match.slice(1).map(value=>{if(value==='unlimited')return null;const number=Number(value);if(!Number.isSafeInteger(number)||number<0)process.exit(2);return number;});}}\nconst blocks=[];for(let i=0;i<plain.length;i+=384){const cipher=crypto.publicEncrypt({key,padding:crypto.constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256',oaepLabel:Buffer.from('ziggy-private-failure-v1','ascii')},plain.subarray(i,i+384));if(cipher.length!==512||blocks.length>=43)process.exit(2);blocks.push(cipher.toString('base64'));}\nprocess.stdout.write(JSON.stringify({schema:1,key_id:'8bab6daee3714c8284aa166219000493'+'8b0a5dfb10dea336372e4b11f51e0655',blocks,limits}));\n"


def svm_encrypted_blocks(wire,plaintext_bytes):
    """Strict public ciphertext-only child protocol; unknown fields never pass."""
    if not isinstance(wire,bytes)or len(wire)>32768 or type(plaintext_bytes)is not int or not 0<plaintext_bytes<=16384:raise ValueError('Bounded encrypted SVM response required')
    value=startup_unique_json(wire.decode('ascii','strict'))
    if set(value)!={'schema','key_id','blocks','limits'}or type(value['schema'])is not int or value['schema']!=1 or value['key_id']!=SVM_ENCRYPTION_KEY_ID or not isinstance(value['blocks'],list)or len(value['blocks'])!=(plaintext_bytes+383)//384 or len(value['blocks'])>43:raise ValueError('Exact encrypted SVM block count/key required')
    limits=value['limits']
    if limits is not None:
        if not isinstance(limits,dict)or set(limits)!={'address_space','open_files'}:raise ValueError('Closed numeric child limits required')
        if any(not isinstance(pair,list)or len(pair)!=2 or any(v is not None and(type(v)is not int or not 0<=v<=2**53-1)for v in pair)for pair in limits.values()):raise ValueError('Numeric child limits required')
    for block in value['blocks']:
        if not isinstance(block,str)or len(block)!=684:raise ValueError('Fixed RSA block required')
        cipher=base64.b64decode(block,validate=True)
        if len(cipher)!=512 or base64.b64encode(cipher).decode()!=block:raise ValueError('Canonical RSA block required')
    return value


def role_failure_observation(case,manifest,parent_pid,sources,repo,harness_log,zig_sources,private_capture=None):
    """Existing Source parent receipts and finite role-log flags, no new probe."""
    if manifest['scenario']not in {'sealevel','sealevel-composite'}or type(parent_pid)is not int or parent_pid<=0:raise ValueError('Actual SVM harness identity required')
    case=Path(case)
    if case.is_symlink()or case.resolve()!=case:raise ValueError('Canonical owned diagnostic case required')
    def path(relative):
        target=case/relative
        if any(p.is_symlink()for p in [target,*[p for p in target.parents if p.is_relative_to(case)]]):raise ValueError('Diagnostic path symlink')
        return target
    def lines(relative):
        target=path(relative)
        if not target.exists():return [],{'status':'absent'}
        raw,fingerprint=captured_failure_bytes(target,1024**2)
        rows=raw.splitlines()
        if len(rows)>128 or any(len(row)>65536 for row in rows):raise ValueError('Role journal row bound')
        def unique(pairs):
            result={}
            for key,value in pairs:
                if key in result:raise ValueError('Duplicate role journal key')
                result[key]=value
            return result
        return [json.loads(row,object_pairs_hook=unique)for row in rows],{'status':'captured',**fingerprint}
    helper='rust/main/utils/run-locally/src/external_agents.rs';program='rust/main/utils/run-locally/src/program.rs';main='rust/main/utils/run-locally/src/main.rs'
    caller='rust/main/utils/run-locally/src/sealevel/'+('mod.rs'if manifest['scenario']=='sealevel'else'warp_route_composite_ism.rs')
    logging='rust/main/utils/run-locally/src/logging.rs'
    writer_sources={};bodies={}
    for name in [helper,program,main,caller,logging]:
        row=sources[name];source=Path(repo)/name;body,fingerprint=captured_failure_bytes(source,1024**2)
        if row!={'path':str(source),**fingerprint}:raise ValueError('Role journal or log writer Source changed')
        writer_sources[name]=dict(row);bodies[name]=body
    needles={helper:[b'pub struct OwnedChild',b'struct ChildExit',b'.join("parent-child-exits.jsonl")',b'impl Drop for TrackedChild'],program:[b'format!("{log_prefix}-output.log")',b'println!("<{prefix}> {line}")',b'log!("Error reading from output for {}: {}", prefix, e)'],logging:[b'::std::println!(concat!("<E2E> ", $arg), $($rest)*)'],main:[b'create_owned_path(Path::new("/tmp/test_logs"), "agent-logs")'],caller:[b'.spawn("RLY", Some(&AGENT_LOGGING_DIR))']}
    if manifest['scenario']=='sealevel':needles[caller].extend([b'.zip(["SCR1", "SCR2", "SCR3"])',b'scraper_env.spawn(scraper_name, None)'])
    if not all(needle in bodies[name]for name,values in needles.items()for needle in values):raise ValueError('Exact Source role journal/log contract missing')
    owned,owned_pin=lines('evidence/owned-children.jsonl');exits,exit_pin=lines('evidence/parent-child-exits.jsonl')
    roles={'relayer','validator'}if manifest['scenario']=='sealevel-composite'else{'relayer','validator','scraper'}
    def identity(row):
        if not isinstance(row,dict)or row.get('role')not in roles or row.get('executable')!=manifest['artifacts'][row['role']]or type(row.get('pid'))is not int or not 0<row['pid']<2**31 or row.get('parent_pid')!=parent_pid or type(row.get('parent_pid'))is not int or not isinstance(row.get('os_start_token'),str)or not 0<len(row['os_start_token'])<=4096:raise ValueError('Role receipt identity differs from admitted product/harness')
        return row['pid'],row['parent_pid'],row['os_start_token']
    admitted={}
    for row in owned:
        key=identity(row)
        if key in admitted:raise ValueError('Repeated owned role identity')
        admitted[key]=row
    joined={};public=[]
    for row in exits:
        key=identity(row)
        if key not in admitted or key in joined or row['role']!=admitted[key]['role']:raise ValueError('Unmatched/replayed role parent wait')
        for field in ['parent_wait_completed','already_exited','forced_kill','success','planned_exit']:
            if type(row.get(field))is not bool:raise ValueError('Typed role parent wait required')
        code,signum=row.get('exit_code'),row.get('signal')
        if not(code is None or type(code)is int and 0<=code<=255)or not(signum is None or type(signum)is int and 1<=signum<=64)or((code is None)==(signum is None)):raise ValueError('Invalid role exit/signal')
        if row.get('parent_wait_completed')is not True or row.get('purpose')not in {'final','same_db_restart','intentional_restart','intentional_reorg','unwind_or_early_drop'}:raise ValueError('Actual typed parent wait required')
        joined[key]=row
    for key,row in admitted.items():
        item={'role':row['role'],'pid':row['pid'],'parent_pid':parent_pid,'os_start_token_sha256':hashlib.sha256(row['os_start_token'].encode()).hexdigest(),'executable':manifest['artifacts'][row['role']],'status':'actual_parent_wait_recorded'if key in joined else'parent_wait_not_recorded'}
        if key in joined:item['actual_parent_wait']={name:joined[key][name]for name in ['parent_wait_completed','already_exited','forced_kill','success','exit_code','signal','purpose','planned_exit']}
        public.append(item)
    prefixes={'RLY':'relayer','VL1':'validator'}
    if manifest['scenario']=='sealevel':prefixes.update(VL2='validator',VL3='validator')
    patterns={b'integer overflow':'INTEGER_OVERFLOW',b'attempt to use null value':'NULL_UNWRAP',b'index out of bounds':'INDEX_OUT_OF_BOUNDS',b'reached unreachable code':'UNREACHABLE',b'incorrect alignment':'INCORRECT_ALIGNMENT',b'Deadlock detected':'DEADLOCK'}
    def flags(raw,prefix=None):
        result=set()
        for line in io.BytesIO(raw):
            if len(line)>65536:continue
            line=re.sub(rb'\x1b\[[0-9;]*m',b'',line).strip()
            if prefix is not None:
                pipe_marker=b'<E2E> Error reading from output for '+prefix+b': '
                if line.startswith(pipe_marker)and len(line)>len(pipe_marker):result.add('ROLE_PIPE_READ_ERROR_OBSERVED');continue
                marker=b'<'+prefix+b'> '
                if not line.startswith(marker):continue
                line=line[len(marker):]
            match=re.match(rb'^(?:thread [0-9]{1,20} )?panic: (.*)$',line)
            if match:
                result.add('PANIC_HEADER_OBSERVED')
                if match[1]in patterns:result.add(patterns[match[1]])
            if re.fullmatch(rb'error: [A-Za-z_][A-Za-z_0-9]{0,127}',line):result.add('ERROR_RETURN_HEADER_OBSERVED')
            fatal={b'Segmentation fault':'SEGMENTATION_FAULT',b'Bus error':'BUS_ERROR',b'Illegal instruction':'ILLEGAL_INSTRUCTION',b'Arithmetic exception':'ARITHMETIC_EXCEPTION'}
            for phrase,label in fatal.items():
                if re.fullmatch(re.escape(phrase)+rb' at address 0x[0-9a-f]{1,16}',line):result.add(label)
            if line==b'General protection exception (no address available)':result.add('GENERAL_PROTECTION_EXCEPTION')
            match=re.fullmatch(rb'bzip2 internal invariant failure: (-?[0-9]{1,10})',line)
            if match and -(2**31)<=int(match[1])<2**31:result.add('BZIP2_INTERNAL_INVARIANT_FAILURE')
        return sorted(result)
    logs=[]
    for prefix,role in prefixes.items():
        if not any(row['role']==role for row in owned):continue
        relative='agent-logs/'+prefix+'-output.log';target=path(relative)
        if not target.exists():logs.append({'role':role,'fixed_log':relative,'status':'absent'});continue
        try:
            raw,fingerprint=captured_failure_bytes(target,32*1024**2);logs.append({'role':role,'fixed_log':relative,'status':'captured',**fingerprint,'finite_observed_flags':flags(raw),'exact_pid_or_epoch_attribution':False})
        except Exception:logs.append({'role':role,'fixed_log':relative,'status':'unavailable','exact_pid_or_epoch_attribution':False})
    harness_prefixes={**prefixes,**({prefix:'scraper'for prefix in ('SCR1','SCR2','SCR3')}if manifest['scenario']=='sealevel'else{})}
    harness_prefixes={prefix:role for prefix,role in harness_prefixes.items()if any(row['role']==role for row in owned)}
    try:raw,fingerprint=captured_failure_bytes(harness_log,32*1024**2)
    except Exception:
        logs.extend({'role':role,'fixed_log':'harness.log prefix '+prefix,'status':'unavailable','exact_pid_or_epoch_attribution':False}for prefix,role in harness_prefixes.items())
    else:
        if private_capture is not None:
            try:private_capture(raw)
            except Exception:pass
        source_frames=zig_role_source_frames(raw,harness_prefixes,zig_sources,repo)
        logs.extend({'role':role,'fixed_log':'harness.log prefix '+prefix,'status':'captured',**fingerprint,'finite_observed_flags':flags(raw,prefix.encode()),'stream_scope':'merged_prefixed_stdout_and_stderr','Source_frames':source_frames.get(prefix,[]),'exact_pid_or_epoch_attribution':False}for prefix,role in harness_prefixes.items())
    return {'schema':1,'kind':'public-SVM-role-failure-observation','writer_sources':writer_sources,'owned_child_journal':owned_pin,'parent_exit_journal':exit_pin,'roles':public,'fixed_role_logs':logs,'scope':'Actual existing parent wait records joined to admitted owned-child epochs/products. Fixed role files contain stdout only; harness prefixes merge stdout and stderr. Finite flags and bounded admitted Zig coordinates; no std/foreign frames, stderr-only or original metrics HTTP/error attribution. Logs may contain multiple role epochs. Zig relative coordinates are matched to admitted captured Source; no function/address/rawpath/message or unforgeable execution claim.','native_or_timing_or_cleanup_authority':False}



def late_invariant_observation(scenario,sources,repo,harness_log):
    """Fixed helper text and numeric fields only; never a metric or PID proof."""
    if scenario not in {'evm','sealevel','sealevel-composite','tron'}:raise ValueError('Shared termination helper scenario required')
    root='rust/main/utils/run-locally/src/';checked={};bodies={}
    for suffix in ['invariants/termination_invariants.rs','main.rs','logging.rs']:
        name=root+suffix;path=Path(repo)/name;body,fingerprint=captured_failure_bytes(path,1024**2)
        if sources[name]!={'path':str(path),**fingerprint}:raise ValueError('Termination diagnostic Source changed')
        checked[name]=sources[name];bodies[suffix]=body
    # Each regex is anchored to the actual Rust log literal; no freeform suffix
    # or caller-provided label is returned. Integer arguments are Rust u32.
    count=rb'([0-9]{1,10})';number=rb'([0-9]{1,16}(?:\.[0-9]{1,16})?(?:[eE][+-]?[0-9]{1,3})?)'
    specs=[
        ('RELAYER_GAS_PAYMENT_COUNT',b'Relayer has {} gas payment events, expected at least {}',rb'Relayer has '+count+rb' gas payment events, expected at least '+count,'u32'),
        ('RELAYER_MERKLE_SEQUENCE_COUNT',b'highest tree index does not match messages sent. got {} expected {}',rb'highest tree index does not match messages sent\. got '+count+rb' expected '+count,'u32'),
        ('RELAYER_BALANCE_NOT_DECREASED',b'Expected starting relayer balance to be greater than ending relayer balance, but got {} <= {}',rb'Expected starting relayer balance to be greater than ending relayer balance, but got '+number+rb' <= '+number,'balance'),
        ('LANDER_FINALIZED_ZERO',b'hyperlane_lander_finalized_transactions is zero, expected at least one',rb'hyperlane_lander_finalized_transactions is zero, expected at least one','u32'),
        ('LANDER_BUILDING_QUEUE',b'hyperlane_lander_building_stage_queue_length {} count, expected {}',rb'hyperlane_lander_building_stage_queue_length '+count+rb' count, expected '+count,'u32'),
        ('LANDER_INCLUSION_POOL',b'hyperlane_lander_inclusion_stage_pool_length {} count, expected {}',rb'hyperlane_lander_inclusion_stage_pool_length '+count+rb' count, expected '+count,'u32'),
        ('LANDER_FINALITY_POOL',b'hyperlane_lander_finality_stage_pool_length {} count, expected {}',rb'hyperlane_lander_finality_stage_pool_length '+count+rb' count, expected '+count,'u32'),
        ('LANDER_DROPPED_PAYLOADS',b'hyperlane_lander_dropped_payloads {} count, expected less than {}',rb'hyperlane_lander_dropped_payloads '+count+rb' count, expected less than '+count,'u32'),
        ('LANDER_DROPPED_TRANSACTIONS',b'hyperlane_lander_dropped_transactions {} count, expected less than {}',rb'hyperlane_lander_dropped_transactions '+count+rb' count, expected less than '+count,'u32'),
        ('LANDER_MISMATCHED_NONCE',b'hyperlane_lander_mismatched_nonce {} count, expected {}',rb'hyperlane_lander_mismatched_nonce '+count+rb' count, expected '+count,'u32'),
        ('LANDER_SUBMISSIONS',b'hyperlane_lander_transaction_submissions {} count',rb'hyperlane_lander_transaction_submissions '+count+rb' count','u32'),
        ('SCRAPER_DISPATCH_COUNT',b'Scraper has scraped {} dispatched messages, expected {}',rb'Scraper has scraped '+count+rb' dispatched messages, expected '+count,'u32'),
        ('SCRAPER_RAW_DISPATCH_COUNT',b'Scraper has scraped {} raw message dispatches, expected {}',rb'Scraper has scraped '+count+rb' raw message dispatches, expected '+count,'u32'),
        ('SCRAPER_GAS_PAYMENT_COUNT',b'Scraper has scraped {} gas payments, expected {}',rb'Scraper has scraped '+count+rb' gas payments, expected '+count,'u32'),
        ('SCRAPER_DELIVERY_COUNT',b'Scraper has scraped {} delivered messages, expected {}',rb'Scraper has scraped '+count+rb' delivered messages, expected '+count,'u32'),
        ('RELAYER_CHECK_ENTERED',b'Checking relayer termination invariants',rb'Checking relayer termination invariants','u32'),
        ('SCRAPER_CHECK_ENTERED',b'Checking scraper termination invariants',rb'Checking scraper termination invariants','u32'),
        ('PROVIDER_REQUEST_COUNT',b'hyperlane_request_count {} count, expected {}',rb'hyperlane_request_count '+count+rb' count, expected '+count,'u32'),
        ('PROVIDER_CREATED_COUNT',b'Provider created count: {}',rb'Provider created count: '+count,'u32'),
        ('PROVIDER_CREATED_TOO_LOW',b'hyperlane_provider_create_count only has {} count, expected at least {}',rb'hyperlane_provider_create_count only has '+count+rb' count, expected at least '+count,'u32'),
        ('PROVIDER_METADATA_COUNT',b'hyperlane_metadata_build_count only has {} count, expected at least {}',rb'hyperlane_metadata_build_count only has '+count+rb' count, expected at least '+count,'u32'),
    ]
    if not all(b'"'+literal+b'"'in bodies['invariants/termination_invariants.rs']for _,literal,_,_ in specs):raise ValueError('Exact termination log literals required')
    if scenario=='sealevel':
        name=root+'sealevel/sealevel_termination_invariants.rs';path=Path(repo)/name;body,fingerprint=captured_failure_bytes(path,1024**2)
        if sources[name]!={'path':str(path),**fingerprint}:raise ValueError('SVM termination diagnostic Source changed')
        checked[name]=sources[name]
        stages=[('SVM_SOLANA_TERMINATION_NOT_MET',b'Solana termination invariants not met'),('SVM_PROVIDER2_NOT_MET',b'Provider metrics invariants not met for sealeveltest2'),('SVM_PROVIDER3_NOT_MET',b'Provider metrics invariants not met for sealeveltest3')]
        if not all(b'log!("'+literal+b'")'in body for _,literal in stages):raise ValueError('Exact SVM termination log literals required')
        specs.extend((code,literal,re.escape(literal),'u32')for code,literal in stages)
    if b'log!("Error checking e2e invariants: {}", e)'not in bodies['main.rs']or b'::std::println!(concat!("<E2E> ", $arg), $($rest)*)'not in bodies['logging.rs']:raise ValueError('Exact helper log writer required')
    wire,fingerprint=captured_failure_bytes(harness_log,32*1024**2);rows={};scanned=0;oversized=0
    patterns=[(code,re.compile(pattern),kind)for code,_,pattern,kind in specs]
    for raw in io.BytesIO(wire):
        scanned+=1
        if len(raw)>65536:oversized+=1;continue
        clean=re.sub(rb'\x1b\[[0-9;]*m',b'',raw).rstrip(b'\r\n')
        if not clean.startswith(b'<E2E> '):continue
        text=clean[6:];code=None;values=[]
        if text.startswith(b'Error checking e2e invariants: '):code='INVARIANT_ERROR_PREFIX_ONLY'
        else:
            for label,pattern,kind in patterns:
                match=pattern.fullmatch(text)
                if match is None:continue
                values=[float(v)if kind=='balance'else int(v)for v in match.groups()]
                if any(not 0<=v<=(2**53-1 if kind=='balance'else 2**32-1)for v in values):break
                code=label;break
        if code is None:continue
        observation={'log_line':scanned,'values':values}
        if code not in rows:rows[code]={'code':code,'count':0,'first':observation}
        row=rows[code];row['count']+=1;row['latest']=observation
    # Source and log captures are observations only; no metric HTTP/PID/clock,
    # stage success, native acceptance, timeout extension or cleanup authority.
    return {'schema':1,'kind':'public-fixed-late-invariant-observation','collection_status':'observed','writer_sources':checked,'harness_log_fingerprint':fingerprint,'lines_scanned':scanned,'oversized_lines_omitted':oversized,'observations':[rows[k]for k in sorted(rows)],'native_or_timing_or_cleanup_authority':False,'scope':'Exact Source-defined E2E helper text, counts and first/latest numeric fields only. Error prefix count omits all suffix text. No direct metric sample, unique PID/epoch, stage success, root cause or proof claim.'}


def fixture_failure_observation(case,manifest,approval,parent_pid,sources,repo,harness_log,case_inputs=None,required_inputs=(),private_capture=None):
    """Fixed Source markers and actual client status only; no external text."""
    scenario=manifest['scenario']
    if scenario not in {'tron','radix'}or type(parent_pid)is not int or not 0<parent_pid<2**31:raise ValueError('Exact fixture helper parent required')
    case=Path(case)
    if case.is_symlink()or case.resolve()!=case:raise ValueError('Canonical fixture case required')
    root='rust/main/utils/run-locally/src/'
    suffixes=['program.rs','logging.rs','tron/mod.rs','main.rs','external_agents.rs']if scenario=='tron'else['radix/mod.rs','external_agents/radix_fixture.rs','external_agents.rs']
    bodies={};checked_sources={}
    for suffix in suffixes:
        name=root+suffix;path=Path(repo)/name;raw,fingerprint=captured_failure_bytes(path,1024**2)
        if sources[name]!={'path':str(path),**fingerprint}:raise ValueError('Fixture diagnostic Source changed')
        bodies[name]=raw;checked_sources[name]=sources[name]
    wire,log_pin=captured_failure_bytes(harness_log,32*1024**2)
    program=root+'program.rs';caller=root+('tron/mod.rs'if scenario=='tron'else'radix/mod.rs');fixture=root+'external_agents/radix_fixture.rs'
    markers={};guards={}
    if scenario=='tron':
        required={program:[b'log!("{:#}", &self)',b'.field("bin", &self.bin)',b'.field("args", &self.args)',b'Command returned non-zero exit code: {:?}'],root+'logging.rs':[b'::std::println!(concat!("<E2E> ", $arg), $($rest)*)'],caller:[b'"Deploying core contracts to {}..."',b'"Deployed core contracts to {}"',b'.cmd("hyperlane")',b'.cmd("core")',b'.cmd("deploy")',b'.cmd("registry")',b'.cmd("agent-config")',b'.cmd("send")',b'.cmd("message")'],root+'main.rs':[b'const AGENT_BIN_PATH: &str = "target/debug";'],root+'external_agents.rs':[b'.bin(fixture.pnpm.path)']}
        for name,needles in required.items():
            if not all(n in bodies[name]for n in needles):raise ValueError('Exact Tron command writer contract missing')
        literal_markers={b'Starting TRE docker container...':'TRE_START_REQUESTED',b'Waiting for TRE node...':'TRE_WAIT_ENTERED',b'Generating agent config...':'CONFIG_GENERATION_ENTERED',b'Patching agent config with Tron wallet URLs...':'CONFIG_PATCH_ENTERED',b'Patched agent config with wallet URLs':'CONFIG_PATCH_RETURNED',b'Starting postgres...':'POSTGRES_START_REQUESTED',b'Initializing postgres DB...':'POSTGRES_INIT_ENTERED',b'All agents started. Dispatching messages...':'DISPATCH_BATCH_ENTERED'}
        for literal,category in literal_markers.items():
            if b'"'+literal+b'"'not in bodies[caller]:raise ValueError('Tron stage Source literal missing')
            markers[b'<E2E> '+literal]=category
        for chain,ordinal in [(b'anvil1','FIRST'),(b'anvil2','SECOND')]:
            if b'deploy_core(&cli_path, "'+chain+b'")'not in bodies[caller]:raise ValueError('Tron fixed chain call changed')
            markers[b'<E2E> Deploying core contracts to '+chain+b'...']='CORE_DEPLOY_'+ordinal+'_ENTERED';markers[b'<E2E> Deployed core contracts to '+chain]='CORE_DEPLOY_'+ordinal+'_RETURNED'
    else:
        if b'panic!("actual owned Radix localnet: {error:#}")'not in bodies[caller]or b'"radix-client-parent-waits.jsonl"'not in bodies[fixture]or b'super::append_fixture_observation'not in bodies[fixture]or b'fn append_fixture_observation('not in bodies[root+'external_agents.rs']:raise ValueError('Exact Radix failure writer contract missing')
        startup_format=b'owned Radix Core/Gateway startup deadline; phase={}, status={:?}'
        literals={startup_format:'CORE_GATEWAY_STARTUP_DEADLINE',b'Radix Core readiness belongs to another native network':'CORE_NETWORK_MISMATCH',b'Radix Gateway readiness has no local committed ledger':'GATEWAY_LEDGER_MISSING',b'Radix Docker command exceeded time/output bound':'DOCKER_TIME_OR_OUTPUT_BOUND',b'Radix Docker output bound':'DOCKER_OUTPUT_BOUND',b'Radix fixture network is not owned and isolated from external networks':'NETWORK_CUSTODY_GUARD',b'Radix Compose service coverage differs':'SERVICE_COVERAGE_GUARD',b'actual Radix service resource bounds differ':'SERVICE_RESOURCE_GUARD',b'Radix container owner/image differs':'CONTAINER_CUSTODY_GUARD',b'Radix inspect coverage differs':'INSPECT_COVERAGE_GUARD',b'Radix service container replaced':'CONTAINER_REPLACED_GUARD'}
        guards={literal:category for literal,category in literals.items()if b'"'+literal+b'"'in bodies[fixture]}
        if len(guards)!=len(literals)or b'"Radix Docker command failed ({status})"'not in bodies[fixture]:raise ValueError('Radix static guard Source changed')
    result={'schema':1,'kind':'public-fixed-fixture-failure-observation','scenario':scenario,'writer_sources':checked_sources,'harness_log_fingerprint':log_pin,'last_seen_stage':None,'panic_observations':[],'client_waits':None,'native_or_timing_or_cleanup_authority':False,'scope':'Source marker and finite panic-category observations only. Last seen is not stage success. No arbitrary error/command text, numeric Program status, root-cause, direct container wait or proof claim.'}
    cli=None;cli_reason='CONTEXT_NOT_SUPPLIED';cli_frontier='CONSTRUCTOR'
    if scenario=='tron'and case_inputs is not None:
        try:cli=TronCLIProjection(case,case_inputs,approval,required_inputs,bodies,sources,repo,private_requested=private_capture is not None)
        except TronCLIProjectionError as error:cli_reason=error.reason
        except Exception:cli_reason='CONSTRUCTOR_CONTEXT_REJECTED'
    pending=None;observations=[];seen=set();lines_scanned=0
    def classify(body,context):
        if context=='radix':
            if body.startswith(b'actual owned Radix localnet:'):body=body[len(b'actual owned Radix localnet:'):].strip()
            body=re.sub(rb'^[0-9]{1,2}: ',b'',body)
            label=guards.get(body)
            if label is not None and body!=startup_format:return {'category':label}
            if startup_format in guards and re.fullmatch(rb'owned Radix Core/Gateway startup deadline; phase=(?:startup|core-status|gateway-status|gateway-read), status=(?:Pending|Transport|BodyBound|Schema|Deadline|HttpStatus\([1-5][0-9]{2}\))',body):return {'category':'CORE_GATEWAY_STARTUP_DEADLINE'}
            if re.fullmatch(rb'Radix Docker command failed \(exit status: [0-9]{1,3}\)',body):return {'category':'DOCKER_NONZERO_STATUS'}
            return None
        prefix=b'Command returned non-zero exit code: '
        if not body.startswith(prefix):return None
        match=re.match(rb'^Program \{ bin: Some\(("(?:[^"\\]|\\.){1,4096}")\), args: \[',body[len(prefix):])
        category='OTHER_PROGRAM_NONZERO'
        if match is not None:
            try:binary=json.loads(match[1])
            except (ValueError,UnicodeError):binary=None
            args=body[len(prefix)+match.end():]
            if binary==approval.get('tron_tre',{}).get('pnpm',{}).get('path'):
                for literal,name in [(b'"hyperlane", "core", "deploy"','HYPERLANE_CORE_DEPLOY'),(b'"hyperlane", "registry", "agent-config"','HYPERLANE_REGISTRY_AGENT_CONFIG'),(b'"hyperlane", "send", "message"','HYPERLANE_SEND_MESSAGE')]:
                    if args.startswith(literal)and args[len(literal):len(literal)+1]in {b',',b']'}:category=name
            elif binary=='../../target/debug/init-db'and b'Program::new(concat_path(format!("../../{AGENT_BIN_PATH}"), "init-db"))'in bodies[caller]:category='INIT_DB'
        return {'category':category,'program_exit_code':None,'program_signal':None,'numeric_status_scope':'not emitted by Source Program assertion'}
    for raw in io.BytesIO(wire):
        lines_scanned+=1
        if len(raw)>65536:
            pending=None
            if cli is not None:cli.state='ambiguous';cli.qualified=False;cli.reason='LOG_LINE_BOUND';cli.frontier='WINDOW_SCAN'
            continue
        clean=re.sub(rb'\x1b\[[0-9;]*m',b'',raw).strip()
        if clean in markers:result['last_seen_stage']={'category':markers[clean],'log_line':lines_scanned,'observed_only':True}
        if cli is not None:
            try:cli.feed(clean,lines_scanned,markers.get(clean))
            except Exception:cli=None;cli_reason='COLLECTOR_FAILED';cli_frontier='WINDOW_SCAN'
        header=re.match(rb"^thread '[^'\r\n]{1,128}'(?: \([0-9]{1,20}\))? panicked at ([^:\r\n]{1,4096}):([0-9]{1,7}):([0-9]{1,5}):\s*(.*)$",clean)
        if header is not None:
            pending=None;path,line,column,tail=header.groups();line,column=int(line),int(column)
            target=program if scenario=='tron'else caller;relative=target[len('rust/main/'):].encode();full=target.encode()
            if not(path in {relative,full}or path.endswith(b'/'+relative)or path.endswith(b'/'+full)):continue
            source_lines=bodies[target].splitlines()
            if not 0<line<=len(source_lines)or column==0:continue
            snippet=b'\n'.join(source_lines[line-1:min(line+4,len(source_lines))]);required=b'Command returned non-zero exit code: {:?}'if scenario=='tron'else b'panic!("actual owned Radix localnet: {error:#}")'
            if required not in snippet or(scenario=='tron'and source_lines[line-1].strip()!=b'assert!(')or(scenario=='radix'and required not in source_lines[line-1]):continue
            if cli is not None:
                try:cli.source_header(lines_scanned)
                except Exception:cli=None;cli_reason='COLLECTOR_FAILED';cli_frontier='PRIMARY_PANIC'
            pending={'context':scenario,'remaining':16,'source':target,'line':line,'column':column}
            if tail:
                item=classify(tail,pending['context'])
                if cli is not None:
                    try:cli.classify(item)
                    except Exception:cli=None;cli_reason='COLLECTOR_FAILED';cli_frontier='PRIMARY_PANIC'
                if item is not None:
                    key=(item['category'],target,line,column)
                    if key not in seen and len(observations)<16:seen.add(key);observations.append({**item,'source':target,'line':line,'column':column})
                pending=None
            continue
        if pending is None:continue
        pending['remaining']-=1
        if pending['remaining']<0 or clean.startswith(b'stack backtrace:'):pending=None;continue
        if not clean:continue
        context=pending;pending=None
        item=classify(clean,context['context'])
        if cli is not None:
            try:cli.classify(item)
            except Exception:cli=None;cli_reason='COLLECTOR_FAILED';cli_frontier='PRIMARY_PANIC'
        if item is not None:
            key=(item['category'],context['source'],context['line'],context['column'])
            if key not in seen and len(observations)<16:seen.add(key);observations.append({**item,'source':context['source'],'line':context['line'],'column':context['column']})
    result['panic_observations']=observations
    if scenario=='tron':
        try:result['CLI_failure']=cli.public()if cli is not None else tron_cli_unavailable(cli_reason,cli_frontier)
        except Exception:result['CLI_failure']=tron_cli_unavailable('PUBLIC_SOURCE_RECHECK_FAILED','PUBLICATION')
        if private_capture is not None and cli is not None:
            try:
                value=cli.private_error_window()
                if value is not None:private_capture(*value)
            except BaseException:pass
    if scenario=='radix':
        journal=Path(case)/'evidence/radix-client-parent-waits.jsonl'
        if journal.exists():
            try:
                if (case/'evidence').is_symlink():raise ValueError('Fixture evidence directory symlink')
                raw,fingerprint=captured_failure_bytes(journal,1024**2);rows=raw.splitlines()
                if not 0<len(rows)<=256 or any(len(row)>65536 for row in rows):raise ValueError('Bounded Radix wait rows required')
                def unique(pairs):
                    value={}
                    for key,item in pairs:
                        if key in value:raise ValueError('Duplicate Radix journal key')
                        value[key]=item
                    return value
                public=[];identities=set()
                for wire_row in rows:
                    row=json.loads(wire_row,object_pairs_hook=unique);pid=row.get('pid');birth=row.get('os_start_token')
                    if row.get('schema')!=1 or type(row.get('schema'))is not int or row.get('purpose')!='radix-fixture-docker-client'or row.get('runtime_source_commit')!=manifest['runtime_source_commit']or row.get('mode')!=manifest['mode']or type(row.get('parent_pid'))is not int or row['parent_pid']!=parent_pid or type(pid)is not int or not 0<pid<2**31 or row.get('os')!='linux'or not isinstance(birth,str)or re.fullmatch('linux-ticks:[1-9][0-9]{0,19}',birth)is None or row.get('executable')!=manifest['verifier_tools']['docker']or row.get('parent_wait_completed')is not True:raise ValueError('Radix actual client identity mismatch')
                    if(pid,birth)in identities:raise ValueError('Repeated Radix client identity')
                    identities.add((pid,birth));code,sig=row.get('exit_code'),row.get('signal')
                    if not(code is None or type(code)is int and 0<=code<=255)or not(sig is None or type(sig)is int and 1<=sig<=64)or((code is None)==(sig is None))or any(type(row.get(k))is not bool for k in ['forced_cleanup','success']):raise ValueError('Typed Radix client status required')
                    if row['success']and(code!=0 or sig is not None or row['forced_cleanup']or row.get('error')is not None):raise ValueError('Inconsistent successful Radix client status')
                    elapsed,size=row.get('elapsed_monotonic_ns'),row.get('output_bytes')
                    if type(elapsed)is not int or not 0<=elapsed<=2**64-1 or not(size is None or type(size)is int and 0<=size<=2**64-1):raise ValueError('Typed Radix client budget observation required')
                    args=row.get('arguments')
                    if not isinstance(args,list)or not 0<len(args)<=256 or any(not isinstance(a,str)or len(a)>4096 for a in args)or sum(len(a)for a in args)>65536:raise ValueError('Bounded Radix argument classification required')
                    category='OTHER_DOCKER_CLIENT'
                    if args[:2]==['image','inspect']:category='IMAGE_INSPECT'
                    elif args[:2]==['network','inspect']:category='NETWORK_INSPECT'
                    elif args[0]=='inspect':category='CONTAINER_INSPECT'
                    elif args[:2]==['ps','--all']:category='PROJECT_CONTAINER_LIST'
                    elif args[0]=='compose'and args[-5:]==['up','--detach','--no-build','--pull','never']:category='COMPOSE_UP'
                    elif args[0]=='compose'and args[-4:]==['down','--timeout','15','--volumes']:category='COMPOSE_DOWN'
                    elif args[:2]in [['network','ls'],['volume','ls']]:category='PROJECT_NETWORK_OR_VOLUME_LIST'
                    public.append({'pid':pid,'parent_pid':parent_pid,'os_start_token_sha256':hashlib.sha256(birth.encode()).hexdigest(),'category':category,'actual_parent_wait':True,'exit_code':code,'signal':sig,'forced_cleanup':row['forced_cleanup'],'success':row['success'],'elapsed_monotonic_ns':elapsed,'output_bytes':size})
                result['client_waits']={'status':'captured','journal':fingerprint,'rows':public,'scope':'Source direct Docker client parent waits only; no container parent-wait or absence/proof claim.'}
            except Exception:result['client_waits']={'status':'unavailable'}
        else:result['client_waits']={'status':'absent'}
    return result

def validate_record(value,modules):
    """Closed public wire schema before a failed-run artifact is retained."""
    def require(ok):
        if not ok:raise ValueError('Invalid public diagnostic schema')
    def integer(v):return type(v)is int and 0<=v<=2**64-1
    def state(v):
        keys={'observed_monotonic_ns','restart_sample_count','restart_failed','restart_first_observed_ns','restart_last_observed_ns','role_activity','observer_failure_count','lifecycle_error_count'}
        require(isinstance(v,dict)and set(v)==keys and type(v['restart_failed'])is bool)
        for k in keys-{'restart_failed','role_activity','restart_first_observed_ns','restart_last_observed_ns'}:require(integer(v[k]))
        for k in ['restart_first_observed_ns','restart_last_observed_ns']:require(v[k]is None or integer(v[k]))
        require(isinstance(v['role_activity'],list)and len(v['role_activity'])<=16)
        for row in v['role_activity']:
            require(set(row)=={'role','chain','capture_monotonic_ns','first_successful_new_capture_exchange','latest_successful_exchange'}and row['role']in{'relayer','validator','scraper'}and isinstance(row['chain'],str)and re.fullmatch('[A-Za-z0-9_-]{1,64}',row['chain'])and integer(row['capture_monotonic_ns']))
            for k in ['first_successful_new_capture_exchange','latest_successful_exchange']:
                pair=row[k]
                if pair is None:continue
                require(isinstance(pair,dict))
                if pair=={'invalid_clock_pair':True}:continue
                require(set(pair)=={'request_started_monotonic_ns','response_received_monotonic_ns','request_age_ns','response_age_ns'}and all(integer(n)for n in pair.values()))
    def entry(v):
        keys={'stage','attempt','started_monotonic_ns','finished_monotonic_ns','status','state'};error={'exception_type','frames','unapproved_frames_omitted','stack_truncated'}
        require(isinstance(v,dict)and set(v)in(keys,keys|error)and v['stage']in STAGES|{'unknown'}and integer(v['attempt'])and integer(v['started_monotonic_ns'])and(v['finished_monotonic_ns']is None or integer(v['finished_monotonic_ns']))and v['status']in{'inflight','pending','completed','exception'})
        state(v['state'])
        if 'exception_type'in v:
            require(isinstance(v['exception_type'],str)and re.fullmatch('[A-Za-z_][A-Za-z_0-9]{0,127}',v['exception_type'])and type(v['stack_truncated'])is bool and integer(v['unapproved_frames_omitted'])and isinstance(v['frames'],list)and len(v['frames'])<=8)
            for frame in v['frames']:
                require(set(frame)=={'module','source','function','line'}and frame['module']in modules and frame['source']==modules[frame['module']]and isinstance(frame['function'],str)and re.fullmatch('[A-Za-z_<>][A-Za-z_<>0-9]*',frame['function'])and integer(frame['line']))
    keys={'schema','kind','stages','failures','dropped_new_failure_signatures','native_or_timing_credit','scope','last_stage'}
    require(isinstance(value,dict)and set(value)==keys and type(value['schema'])is int and value['schema']==1 and value['kind']=='public-native-observer-diagnostics'and value['native_or_timing_credit']is False and value['scope']=='Only approved source frames, stage/attempt status and observed public monotonic clocks; no exception message, locals, payload, config or environment.')
    require(isinstance(value['stages'],dict)and len(value['stages'])<=len(STAGES)+1 and isinstance(value['failures'],dict)and len(value['failures'])<=8 and integer(value['dropped_new_failure_signatures']))
    entry(value['last_stage'])
    for stage,row in value['stages'].items():
        require(stage in STAGES|{'unknown'}and set(row)=={'attempts','first','latest'}and integer(row['attempts']));entry(row['first']);entry(row['latest'])
    for signature,row in value['failures'].items():
        require(re.fullmatch('[0-9a-f]{64}',signature)and set(row)=={'count','first','latest'}and integer(row['count']));entry(row['first']);entry(row['latest'])
    return value


RELAYER_STARTUP_SOURCE = (
    ('zig/src/service_main.zig', 15166, '6b9101771890b56a5303975c7f1433ea' + 'fc5cacc23b7f548f0d083356d32cca78'),
    ('zig/src/agents/relayer_task.zig', 163776, '2161d89399ec666ff1bf66a2f577004e' + '8f5d78a2e6588e6e61a33c4798307dbd'),
    ('zig/src/runtime/lane_owner.zig', 10263, '694159949d9c7b67cba9e4514812dc7e' + 'e3ab2f284afdf5c3336704522d7d722b'),
    ('zig/src/runtime/supervisor.zig', 17573, 'ef34f29f9bb69e4ab1effc7c7c7ae02f' + '6c72cf233a2b1ac3091c28238658b5c3'),
    ('zig/src/agents/origin_tasks.zig', 20356, '26b7a93daddea7e5866499a9bb685aaa' + '9e3ffbbb4e59a79eb425f8db5be566d3'),
    ('zig/src/agents/health_set.zig', 9871, '0010bf67352a7ef38db3078eed8d2861' + '384b4629e69907b35dc92812a26956eb'),
    ('zig/src/agents/health_metrics.zig', 9378, '2600a2196ec6da551ff79c99208350c6' + 'f0d253560ceac5280cd47ba36fc51f3e'),
    ('zig/src/ops/metrics_schema.zig', 36606, '3294839328444cead6812c8f47778466' + 'b3ee07b0c8822c20ee236d993193ebb0'),
    ('zig/src/ops/init_metrics.zig', 4813, '7ab0cc739441ec9a4bc8be197e37da95' + '211781e09e058cd0d3c9c1651e9be16d'),
    ('zig/src/ops/critical_metrics.zig', 5138, 'a7e1125be31ca9dd320659188f6a438f' + '176dd0a7035ab23c13a865709bbabec8'),
    ('zig/src/ops/health_metrics.zig', 2432, 'db829a94c2c6091b39db646c2017948a' + '6d93c09e9462714b781abe13ef11c576'),
    ('zig/src/ops/routes.zig', 1778, '9396bbf0696c0dceed740770a96c8677' + '3bfccac6f03327f108b991c4dcad4037'),
    ('zig/src/ops/admin/api.zig', 39480, '06e58abacaa25a682d9e68ad03b0ab0c' + 'c741228784d0d024726cf36243850d68'),
    ('zig/src/agents/chain_source.zig', 38677, '1a3a84779465123ae1d35a7b8cf02070' + '8f5444d5e08c1d802b35f2740d3523ee'),
    ('zig/src/agents/scraper/factory.zig', 4790, '1111dc5800e33ea665c8b869594e2c7b' + 'df38f2a22562c068f3353a4646c0ce73'),
    ('zig/src/evm/provider.zig', 46267, '52a65850b3388fc8c8ae8c87cc2fd174' + '9b078b056fbde0e212aa59d6230cf9eb'),
    ('zig/src/evm/pool.zig', 108400, '731228e473268d0fb75af269ebec4113' + '78f2a11a4ae2e3a2ebac60e2e82de08d'),
    ('zig/src/evm/indexer.zig', 11172, '75d4e760b2769290f3514801c1afa1fe' + '9e7555236f12feb87f141b8e2c7e4fa3'),
    ('zig/src/net/curl.zig', 49214, '119612ce3f174b10622881ac532b5ec9' + '997f37352efc1e44da8c9a75d11dc6e7'),
    ('zig/src/net/read_replay.zig', 21043, '31ad6faec0e3e82300b0045a5c9b11c0' + 'cb6637efaf2d295225381fafaf6c0225'),
    ('zig/src/net/http_replay.zig', 15499, '0c70c6e40b2bd76aef4f96b853427608' + '9108114834b71ad0bee2a8a1959ec872'),
    ('zig/src/ops/rpc_metrics.zig', 36505, '979925193ffaa3bb4b00bdb8ed48241b' + '37d712ce1a928685d28eb18f342aa56f'),
    ('zig/src/agents/signer.zig', 7390, '8880ce064eaa40629715df3d6422cebb' + '996fcb5aba4bb008e00ac76870e1110d'),
    ('zig/src/ops/indexing_metrics.zig', 4601, '95d5b7d01177904ebe9983586833822e' + '4c6ec989c7762319ede62cb2ac653a0e'),
    ('zig/src/ops/relayer_metrics.zig', 17895, '9193285896d1c115b72bf3b8809fc05a' + '856500e4e56b8cb3212810c0633e1c88'),
    ('zig/src/agents/indexing/source.zig', 40323, 'bc650fd3b96b012ca5004f05ef2e1450' + 'f8e269a6415171e0189fd99a8d6a921c'),
    ('zig/src/starknet/events.zig', 12139, '2f9a8655565f56f9524f76f3b8cd403d' + '298c8e98a29c902df623d2705d19c86e'),
    ('zig/src/starknet/codec.zig', 8476, '2ce49b9e85a5aa854418329737a1a36d' + '126e3df3b1446691fed66875128ea489'),
)


STARTUP_PIPELINE_TARGETS = {
    **{f'origin_{stream}_{metric}':(family,'chain',{'data_type':kind})
       for stream,kind in [('dispatch','dispatched_messages'),('insertion','merkle_tree_hook')]
       for metric,family in [('stored','hyperlane_contract_sync_stored_events'),('fetch_retries','hyperlane_contract_sync_fetch_retries'),('backoff_seconds','hyperlane_contract_sync_fetch_backoff_seconds')]},
    **{f'origin_{stream}_{metric}':(family,'chain',{'event_type':kind,**({'cursor_type':'forward_sequenced'}if metric=='current_sequence'else{})})
       for stream,kind in [('dispatch','hyperlane_message'),('insertion','merkle_tree_insertion')]
       for metric,family in [('current_sequence','hyperlane_cursor_current_sequence'),('max_sequence','hyperlane_cursor_max_sequence')]},
    **{f'queue_{kind}':('hyperlane_submitter_queue_length','remote',{'queue_name':kind+'_queue'})for kind in ['prepare','submit','confirm']},
    **{f'metadata_{status}':('hyperlane_metadata_build_count','remote',{'status':status})for status in ['success','failure']},
    'metadata_wait_active':('hyperlane_metadata_wait_active','remote',{}),
    **{f'operations_{phase}':('hyperlane_operations_processed_count','chain',{'phase':phase})for phase in ['prepared','submitted','confirmed','failed','dropped']},
}
STARTUP_PIPELINE_LABELS = {
    **{name:('data_type','chain')for name in ['hyperlane_contract_sync_stored_events','hyperlane_contract_sync_fetch_retries','hyperlane_contract_sync_fetch_backoff_seconds']},
    'hyperlane_cursor_current_sequence':('event_type','chain','cursor_type'),
    'hyperlane_cursor_max_sequence':('event_type','chain'),
    'hyperlane_submitter_queue_length':('remote','queue_name','operation_status','app_context'),
    'hyperlane_metadata_build_count':('app_context','origin','remote','status'),
    'hyperlane_metadata_wait_active':('app_context','origin','remote'),
    'hyperlane_operations_processed_count':('app_context','phase','chain'),
}
STARTUP_PIPELINE_ENUMS = {
    'data_type':frozenset(['dispatched_messages','merkle_tree_hook','gas_payments']),
    'event_type':frozenset(['hyperlane_message','merkle_tree_insertion','interchain_gas_payment']),
    'cursor_type':frozenset(['forward_sequenced','backward_sequenced','forward_rate_limited']),
    'queue_name':frozenset(['prepare_queue','submit_queue','confirm_queue']),
    'status':frozenset(['success','failure']),
    'phase':frozenset(['prepared','submitted','confirmed','failed','dropped']),
}


def startup_metric_projection(raw, chains):
    """Fixed numeric families only. Never persist response labels or text."""
    import math
    import decimal
    if not isinstance(raw,bytes) or len(raw)>1024**2 or not isinstance(chains,tuple) or not 0<len(chains)<=8 or len(set(chains))!=len(chains) or any(not isinstance(x,str) or re.fullmatch('[A-Za-z0-9_-]{1,64}',x)is None for x in chains):raise ValueError('Bounded selected startup metrics required')
    targets={'destination_mailbox':('hyperlane_chain_init_latency',{'role':'destination','entity':'mailbox'}),'destination_dispatcher':('hyperlane_chain_init_latency',{'role':'destination','entity':'dispatcher_and_entrypoint'}),'block_height':('hyperlane_block_height',{}),'wallet_balance':('hyperlane_wallet_balance',{'wallet_name':'relayer'}),'critical_error':('hyperlane_critical_error',{})}
    families={name:False for name,_ in targets.values()};families.update({name:False for name,_,_ in STARTUP_PIPELINE_TARGETS.values()});samples={};pipeline={};seen=set()
    for line in raw.decode('utf8','strict').splitlines():
        if not line or line.startswith('#'):continue
        if len(line)>16384:raise ValueError('Bounded startup metric line required')
        family=line.split('{',1)[0]
        if family not in families:continue
        families[family]=True
        match=re.fullmatch(re.escape(family)+r'\{([^\r\n]*)\} ([^ \t]+)',line)
        if match is None:raise ValueError('Malformed selected startup metric')
        labels={};cursor=0;label_text=match[1]
        while cursor<len(label_text):
            item=re.match(r'([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\["\\n])*")',label_text[cursor:])
            if item is None or item[1]in labels or len(labels)>=16:raise ValueError('Malformed startup metric labels')
            labels[item[1]]=json.loads(item[2]);cursor+=item.end()
            if cursor<len(label_text):
                if label_text[cursor]!=',':raise ValueError('Malformed startup metric separator')
                cursor+=1
                if cursor==len(label_text):raise ValueError('Trailing startup metric separator')
        identity=(family,tuple(sorted(labels.items())))
        if identity in seen or len(seen)>=512:raise ValueError('Duplicate or excessive startup series')
        seen.add(identity)
        try: exact=decimal.Decimal(match[2])
        except decimal.InvalidOperation:raise ValueError('Malformed startup number')from None
        if not exact.is_finite()or abs(exact)>2**53:raise ValueError('Nonfinite or excessive startup metric')
        number=float(exact)
        if not math.isfinite(number):raise ValueError('Nonfinite startup metric')
        if labels.get('agent')!='relayer' or labels.get('hyperlane_baselib_version')!='3.0.0':raise ValueError('Startup metric Source base labels differ')
        if family in STARTUP_PIPELINE_LABELS:
            if set(labels)!=set(STARTUP_PIPELINE_LABELS[family])|{'agent','hyperlane_baselib_version'}:raise ValueError('Closed startup pipeline labels required')
            if any(key in labels and labels[key]not in allowed for key,allowed in STARTUP_PIPELINE_ENUMS.items()):raise ValueError('Closed startup pipeline enum required')
            if exact<0 or exact!=exact.to_integral_value():raise ValueError('Nonnegative integer startup pipeline metric required')
            value=int(exact)
            for index,chain in enumerate(chains):
                for key,(name,identity,required)in STARTUP_PIPELINE_TARGETS.items():
                    if name!=family or labels.get(identity)!=chain or not all(labels.get(k)==v for k,v in required.items()):continue
                    if 'origin'in labels and labels['origin']not in chains:continue
                    values=pipeline.setdefault((index,key),[])
                    if len(values)>=16 or sum(values)+value>2**53:raise ValueError('Bounded startup pipeline count and sum required')
                    values.append(value)
            continue
        for index,chain in enumerate(chains):
            if labels.get('chain')!=chain:continue
            for key,(name,required)in targets.items():
                if name==family and all(labels.get(k)==value for k,value in required.items()):
                    values=samples.setdefault((index,key),[])
                    if len(values)>=16:raise ValueError('Bounded selected startup samples required')
                    values.append(number)
    return [{'chain_index':index,'metrics':{key:{'family_present':families[name],'selected_present':bool(samples.get((index,key))),'series_count':len(samples.get((index,key),[])),'finite_values':samples.get((index,key),[])}for key,(name,_)in targets.items()},'pipeline':{key:{'family_present':families[name],'selected_present':bool(pipeline.get((index,key))),'series_count':len(pipeline.get((index,key),[])),'aggregation':'sum','finite_values':[sum(pipeline[index,key])]if(index,key)in pipeline else[]}for key,(name,_,_)in STARTUP_PIPELINE_TARGETS.items()}}for index in range(len(chains))]


def startup_header_projection(raw, sources):
    """Text-header observations, never typed exception or lane attribution."""
    if not isinstance(raw,bytes)or len(raw)>32*1024**2:raise ValueError('Bounded existing harness capture required')
    known=set()
    for source in sources.values():
        known.update(x.decode()for x in re.findall(rb'\berror\.([A-Za-z][A-Za-z0-9_]{0,63})\b',source))
    if len(known)>2048:raise ValueError('Bounded Source error-name catalog required')
    # These emitters are in the hash-captured startup Source catalog. They
    # swallow recoverable/optional errors, so no supervisor failure is implied.
    warnings=(
        ('native_group_rpc_warning','zig/src/agents/relayer_task.zig',b'native submission group RPC'),
        ('relayer_telemetry_warning','zig/src/agents/relayer_task.zig',b'relayer telemetry update failed'),
        ('initialization_metric_warning','zig/src/ops/init_metrics.zig',b'initialization metric update failed'),
        ('critical_metric_warning','zig/src/ops/critical_metrics.zig',b'critical metric update failed'),
    )
    armed=[(kind,header)for kind,path,header in warnings if sources.get(path,b'').count(b'std.log.warn("'+header+b': {s}", .{@errorName(err)})')==1]
    origin_source=sources.get('zig/src/agents/indexing/source.zig',b'')
    origin_emitter=b'std.log.warn("origin {s} range fetch failed; retry in {d}ms: {s}", .{ @tagName(stream), delay, @errorName(err) });'
    origin_armed=origin_source.count(origin_emitter)==1
    rows=[];counts={'supervised_task_failed':0,'health_warning':0,'agent_stopped':0,**{kind:0 for kind,_,_ in warnings},'origin_range_fetch_warning':0}
    for line in io.BytesIO(raw):
        if len(line)>16384:continue
        clean=re.sub(rb'\x1b\[[0-9;]*m',b'',line).strip()
        match=re.fullmatch(rb'<RLY> (?:warning|warn): task ([0-9]{1,3}) failed: ([A-Za-z][A-Za-z0-9_]{0,63})',clean)
        kind=None;index=None;name=None;origin_observation={}
        if match is not None and int(match[1])<=255:kind='supervised_task_failed';index=int(match[1]);name=match[2].decode()
        else:
            match=re.fullmatch(rb'<RLY> (?:warning|warn): Common health metric update failed: ([A-Za-z][A-Za-z0-9_]{0,63})',clean)
            if match is not None:kind='health_warning';name=match[1].decode()
            else:
                match=re.fullmatch(rb'<RLY> error: agent stopped: ([A-Za-z][A-Za-z0-9_]{0,63})',clean)
                if match is not None:kind='agent_stopped';name=match[1].decode()
        if kind is None:
            for candidate,header in armed:
                match=re.fullmatch(rb'<RLY> (?:warning|warn): '+re.escape(header)+rb': ([A-Za-z][A-Za-z0-9_]{0,63})',clean)
                if match is not None:kind=candidate;name=match[1].decode();break
        if kind is None and origin_armed:
            match=re.fullmatch(rb'<RLY> (?:warning|warn): origin (dispatch|insertion|gas) range fetch failed; retry in ([1-9][0-9]{0,5})ms: ([A-Za-z][A-Za-z0-9_]{0,63})',clean)
            if match is not None and int(match[2])<=300000:
                kind='origin_range_fetch_warning';name=match[3].decode();origin_observation={'stream':match[1].decode(),'retry_delay_ms':int(match[2])}
        if kind is not None:
            counts[kind]=min(2**32-1,counts[kind]+1)
            row={'header':kind,'task_index':index,'Source_error_name':name if name in known else None,'error_name_status':'Source_literal'if name in known else'unknown','lane_attribution':None,**origin_observation}
            if row not in rows and len(rows)<16:rows.append(row)
    return {'counts':counts,'observations':rows,'scope':'Fixed RLY-prefixed text only; no typed exception, task-to-lane, unique PID/epoch or readiness claim.'}


class RelayerStartup:
    """Diagnostic state only. Source is captured once; clocks never renewed."""
    def __init__(self,repo,manifest,modules):
        if manifest.get('scenario')not in{'evm','starknet'}or type(manifest.get('runtime_source_commit'))is not str or not re.fullmatch('[a-f0-9]{40}',manifest['runtime_source_commit']):raise ValueError('Exact startup producer epoch required')
        self.repo=Path(repo);self.sources={};self.source_identities={};self.module_identities={};self.last=None
        for relative,size,digest in RELAYER_STARTUP_SOURCE:
            path=self.repo/relative
            if any(x.is_symlink()for x in [path,*[x for x in path.parents if x.is_relative_to(self.repo)]]):raise ValueError('Startup Source symlink')
            wire,fingerprint=captured_failure_bytes(path,1024**2)
            if fingerprint!={'bytes':size,'sha256':digest}:raise ValueError('Startup producer Source changed')
            self.sources[relative]=wire;self.source_identities[path]=self.identity(path)
        if b'Address.parseIp4("0.0.0.0", configured.metrics_port)' not in self.sources['zig/src/service_main.zig']:raise ValueError('Exact Source wildcard metrics bind required')
        for name,needles in {'multivm_session.py':[b'"effective-role-configs.jsonl"',b'capture = effective_config(request, self.manifest)'],'multivm_evidence.py':[b'def effective_config(',b'def process_identity(']}.items():
            row=modules[name];path=Path(row['path']);wire,fingerprint=captured_failure_bytes(path,1024**2)
            if row!={'path':str(path),**fingerprint}or not all(x in wire for x in needles):raise ValueError('Actual capture writer Source differs')
            self.module_identities[path]=self.identity(path)
            if name=='multivm_evidence.py':evidence_wire=wire;evidence_path=path
        # Reuse the exact already-approved pure closure validator. A successor
        # producer is named only by the existing admitted producer/tree receipt.
        evidence=types.ModuleType('startup_admitted_evidence');evidence.__file__=str(evidence_path)
        exec(compile(evidence_wire,str(evidence_path),'exec'),evidence.__dict__)
        def read_bound(row):
            if type(row)is not dict or set(row)!={'path','bytes','sha256'}or type(row['bytes'])is not int or not 0<row['bytes']<=1024**2 or type(row['path'])is not str or type(row['sha256'])is not str or not re.fullmatch('[a-f0-9]{64}',row['sha256']):raise ValueError('Bounded startup admission descriptor required')
            path=Path(row['path'])
            if not path.is_absolute()or path.resolve()!=path:raise ValueError('Canonical startup admission required')
            wire,actual=captured_failure_bytes(path,1024**2)
            if row!={'path':str(path),**actual}:raise ValueError('Startup admission bytes changed')
            self.module_identities[path]=self.identity(path)
            return json.loads(wire)
        approval=read_bound(manifest.get('execution_approval'))
        if approval.get('root_approved')is not True or approval.get('scenario')!=manifest['scenario']or approval.get('runtime_source_commit')!=manifest['runtime_source_commit']or approval.get('python_modules')!=modules:raise ValueError('Startup admission cross-binding differs')
        closure=read_bound(approval.get('compiled_input_closure'))
        for check in closure.get('checks',[]):read_bound(check.get('log'))
        evidence.validate_compiled_input_closure(manifest,approval)
        admitted=approval.get('diagnostic_relayer_sources')
        if type(admitted)is not dict or set(admitted)!=set(self.sources):raise ValueError('Exact startup Source admission required')
        for relative,size,digest in RELAYER_STARTUP_SOURCE:
            if admitted[relative]!={'path':str(self.repo/relative),'bytes':size,'sha256':digest}:raise ValueError('Startup Source admission differs')
        self.epoch=manifest['runtime_source_commit']
        self.check_sources()

    @staticmethod
    def identity(path):
        st=path.lstat()
        if not stat.S_ISREG(st.st_mode)or st.st_nlink!=1 or path.is_symlink():raise ValueError('Stable startup Source required')
        return st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,st.st_ctime_ns

    def check_sources(self):
        # Interpret only the captured hash-matched Source, with unchanged file
        # identity checked before interpretation/publication. No per-second
        # full Source rehash and no authority inferred from an unrelated map.
        if any(self.identity(p)!=identity for p,identity in {**self.source_identities,**self.module_identities}.items()):raise ValueError('Startup Source identity changed')

    def project(self,raw,chains,status,started,finished):
        self.check_sources()
        if type(started)is not int or type(finished)is not int or not 0<started<=finished or finished-started>500_000_000:raise ValueError('Original whole startup probe budget expired')
        metrics=startup_metric_projection(raw,chains)
        self.last={'collection_status':'observed','started_monotonic_ns':started,'finished_monotonic_ns':finished,'wholeprobe_limit_ns':500_000_000,'HEAD_messages_status':status if status in{200,404,405}else None,'admin_extra_handler_observed':status==405,'metrics':metrics,'metrics_body_bytes':len(raw),'metrics_body_sha256':hashlib.sha256(raw).hexdigest(),'native_or_timing_or_readiness_credit':False}
        return self.last

    def public(self,harness_log):
        self.check_sources()
        raw,fingerprint=captured_failure_bytes(harness_log,32*1024**2)
        return {'schema':1,'kind':'public-EVM-Stark-relayer-startup-observation','last_probe':self.last,'fixed_harness_headers':startup_header_projection(raw,self.sources),'harness_log_fingerprint':fingerprint,'Source_epoch':self.epoch,'Source_contracts':[{'path':name,'bytes':size,'sha256_hex_chunks':[digest[:32],digest[32:]]}for name,size,digest in RELAYER_STARTUP_SOURCE],'native_or_timing_or_cleanup_authority':False,'scope':'Bounded read-only observations of an actual owned wildcard relayer listener via fixed numeric loopback.405 only proves installed messages handler;404/absence unknown.0 metric is not absence. No ccipSigners/critical0 readiness, raw labels/address/error/config/env/token or inferred lane.'}



def startup_http(port, method, deadline_ns, cancelled, clock):
    """One fixed read-only numeric-loopback request, one absolute deadline."""
    import errno
    import select
    import socket
    if port not in{9092,9093}or method not in{'GET','HEAD'}or type(deadline_ns)is not int:raise ValueError('Fixed startup endpoint required')
    def check():
        if cancelled()or clock()>=deadline_ns:raise TimeoutError('Startup absolute probe deadline/cancel')
    def wait(stream,writing=False):
        while True:
            check();remaining=(deadline_ns-clock())/10**9
            if remaining<=0:raise TimeoutError('Startup absolute probe deadline')
            ready=select.select([]if writing else[stream],[stream]if writing else[],[],min(.025,remaining))
            check()
            if (ready[1]if writing else ready[0]):return
    check();stream=socket.socket(socket.AF_INET,socket.SOCK_STREAM)
    try:
        stream.setblocking(False);check();status=stream.connect_ex(('127.0.0.1',port));check()
        if status not in{0,errno.EINPROGRESS,errno.EWOULDBLOCK,errno.EALREADY}:raise OSError('Startup connect unavailable')
        if status:
            wait(stream,True)
            if stream.getsockopt(socket.SOL_SOCKET,socket.SO_ERROR)!=0:raise OSError('Startup connect unavailable')
        route='/metrics'if method=='GET'else'/messages';request=f'{method} {route} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n'.encode();sent=0
        while sent<len(request):
            wait(stream,True)
            try:size=stream.send(request[sent:])
            except BlockingIOError:continue
            check()
            if size<=0:raise OSError('Startup socket closed')
            sent+=size
        wire=bytearray();boundary=None;length=None;response_status=None
        while True:
            wait(stream)
            try:chunk=stream.recv(16384)
            except BlockingIOError:continue
            check()
            if not chunk:raise ValueError('Incomplete startup HTTP response')
            wire.extend(chunk)
            if len(wire)>1024**2+32768:raise ValueError('Startup HTTP bound')
            if boundary is None:
                offset=wire.find(b'\r\n\r\n')
                if offset<0:
                    if len(wire)>32768:raise ValueError('Startup header bound')
                    continue
                if offset>32764:raise ValueError('Startup header bound')
                lines=bytes(wire[:offset]).split(b'\r\n');match=re.fullmatch(rb'HTTP/1\.[01] ([1-5][0-9]{2})(?: [^\r\n]*)?',lines[0])
                if match is None:raise ValueError('Malformed startup HTTP status')
                response_status=int(match[1]);headers={}
                for line in lines[1:]:
                    item=re.fullmatch(rb'([!#$%&\x27*+.^_`|~0-9A-Za-z-]+):[ \t]*([^\r\n]*)',line)
                    if item is None:raise ValueError('Malformed startup header')
                    name=item[1].lower()
                    if name in headers:raise ValueError('Duplicate startup header')
                    if any(value<32 and value!=9 or value==127 for value in item[2]):raise ValueError('Control byte in startup header')
                    headers[name]=item[2].strip()
                if b'transfer-encoding'in headers or headers.get(b'content-encoding',b'identity')!=b'identity':raise ValueError('Unsupported startup HTTP encoding')
                if method=='HEAD':check();return response_status,b''
                if response_status!=200 or re.fullmatch(rb'[0-9]{1,7}',headers.get(b'content-length',b''))is None:raise ValueError('Exact startup metrics HTTP200 length required')
                length=int(headers[b'content-length'])
                if length>1024**2:raise ValueError('Startup body bound')
                boundary=offset+4
            body=len(wire)-boundary
            if body>length:raise ValueError('Excess startup HTTP body')
            if body==length:check();return response_status,bytes(wire[boundary:])
    finally:stream.close()



def startup_proc_read(path,maximum,deadline_ns,cancelled,clock):
    def check():
        if cancelled()or clock()>=deadline_ns:raise TimeoutError('Startup absolute probe deadline/cancel')
    check();fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):raise ValueError('Kernel startup table required')
        wire=bytearray()
        while True:
            check();chunk=os.read(fd,min(65536,maximum+1-len(wire)));check()
            if not chunk:return bytes(wire)
            wire.extend(chunk)
            if len(wire)>maximum:raise ValueError('Bounded kernel startup table required')
    finally:os.close(fd)


def startup_owned_listener(pid,port,expected,deadline_ns,cancelled,clock,kernel_row):
    """Source wildcard IPv4 LISTEN owned by PID/inode, reached via numeric loopback."""
    def check():
        if cancelled()or clock()>=deadline_ns:raise TimeoutError('Startup absolute probe deadline/cancel')
    def same():
        check();live=kernel_row(pid);check()
        if live is None or live.get('state')=='Z'or any(live.get(k)!=expected.get(k)for k in('pid','ppid','start')):raise ValueError('Startup listener epoch changed')
    if type(pid)is not int or not 0<pid<2**31 or port not in{9092,9093}or not isinstance(expected,dict)or expected.get('pid')!=pid:raise ValueError('Positive fixed startup listener required')
    same();inodes=set();count=0
    with os.scandir(f'/proc/{pid}/fd')as entries:
        for entry in entries:
            check();count+=1
            if count>1024 or re.fullmatch('[0-9]{1,10}',entry.name)is None:raise ValueError('Bounded kernel FD census required')
            target=os.readlink(f'/proc/{pid}/fd/{entry.name}');check();match=re.fullmatch(r'socket:\[([0-9]{1,20})\]',target)
            if match is not None:inodes.add(match[1])
    if not inodes:raise ValueError('No current role socket')
    wire=startup_proc_read(Path(f'/proc/{pid}/net/tcp'),1024**2,deadline_ns,cancelled,clock);lines=wire.splitlines()
    if not lines or len(lines)>16384 or b'local_address'not in lines[0]or b'inode'not in lines[0]:raise ValueError('Kernel TCP table shape changed')
    matched=set();endpoint=f'00000000:{port:04X}'.encode()
    for line in lines[1:]:
        check();fields=line.split()
        if not 10<=len(fields)<=32 or re.fullmatch(rb'[0-9]{1,20}',fields[9])is None:raise ValueError('Kernel TCP row shape changed')
        if fields[3]==b'0A'and fields[1]==endpoint and fields[9].decode()in inodes:matched.add(fields[9].decode())
    same()
    if len(matched)!=1:raise ValueError('One owned numeric loopback listener required')
    return next(iter(matched))


def startup_unique_json(wire):
    def unique(pairs):
        out={}
        for key,value in pairs:
            if key in out:raise ValueError('Duplicate startup journal field')
            out[key]=value
        return out
    return json.loads(wire,object_pairs_hook=unique,parse_constant=lambda _:(_ for _ in()).throw(ValueError('Nonfinite startup journal')))


def startup_selected_role(case,manifest,inputs,parent_pid,read,kernel_row,read_executable,check):
    """No ordinal→PID guess: all actual relayer captures must agree."""
    check();port=9092 if manifest['scenario']=='evm'else 9093
    def journal(name):
        target=Path(case)/'evidence'/name
        if any(x.is_symlink()for x in [target,target.parent,Path(case)]):raise ValueError('Startup journal symlink')
        raw,_=read(target,1024**2);check();lines=raw.splitlines()
        if len(lines)>128 or any(len(line)>65536 for line in lines):raise ValueError('Bounded startup journal rows required')
        return [startup_unique_json(line)for line in lines]
    captures=[]
    for row in journal('effective-role-configs.jsonl'):
        if not isinstance(row,dict)or not isinstance(row.get('original'),dict):raise ValueError('Actual role capture shape differs')
        original=row['original']
        if original.get('role')!='relayer':continue
        chains=original.get('role_chain_names')
        if original.get('runtime_source_commit')!=manifest['runtime_source_commit']or original.get('scenario')!=manifest['scenario']or original.get('harness_pid')!=parent_pid or original.get('metrics_port')!=port or not isinstance(chains,list)or not 0<len(chains)<=8 or len(set(chains))!=len(chains)or any(not isinstance(x,str)or re.fullmatch('[A-Za-z0-9_-]{1,64}',x)is None or x not in inputs['chain_names']or x not in original.get('chains',{})or not isinstance(original['chains'][x],dict)or original['chains'][x].get('protocol')!=('ethereum'if manifest['scenario']=='evm'else'starknet')for x in chains):raise ValueError('Actual relayer capture differs')
        captures.append(tuple(chains))
    if not captures or len(set(captures))!=1:raise ValueError('Ambiguous selected relayer captures')
    candidates=[];seen=set()
    for row in journal('owned-children.jsonl'):
        if not isinstance(row,dict):raise ValueError('Actual role ownership shape differs')
        if row.get('role')!='relayer':continue
        pid=row.get('pid');token=row.get('os_start_token');key=(pid,token)
        if type(pid)is not int or not 0<pid<2**31 or row.get('parent_pid')!=parent_pid or row.get('executable')!=manifest['artifacts']['relayer']or not isinstance(token,str)or len(token)>4096 or len(token.split())<8 or token.split()[:2]!=[str(pid),str(parent_pid)]or key in seen:raise ValueError('Actual role ownership differs')
        seen.add(key);live=kernel_row(pid);check()
        if live is None or live.get('state')=='Z':continue
        if live.get('pid')!=pid or live.get('ppid')!=parent_pid or not isinstance(live.get('start'),str)or re.fullmatch('linux-ticks:[0-9]{1,24}',live['start'])is None or read_executable(pid)!=manifest['artifacts']['relayer']['path']:raise ValueError('Current relayer identity differs')
        candidates.append(live)
    if len(candidates)!=1:raise ValueError('One current owned relayer required')
    check();return candidates[0],captures[0],port


RADIX_SCRAPER_SOURCE = (
    ('zig/src/service_main.zig', 15166, '6b9101771890b56a5303975c7f1433ea' + 'fc5cacc23b7f548f0d083356d32cca78'),
    ('zig/src/ops/critical_metrics.zig', 5138, 'a7e1125be31ca9dd320659188f6a438f' + '176dd0a7035ab23c13a865709bbabec8'),
    ('zig/src/ops/metrics_schema.zig', 36606, '3294839328444cead6812c8f47778466' + 'b3ee07b0c8822c20ee236d993193ebb0'),
    ('zig/src/runtime/supervisor.zig', 17573, 'ef34f29f9bb69e4ab1effc7c7c7ae02f' + '6c72cf233a2b1ac3091c28238658b5c3'),
    ('zig/src/agents/scraper/task.zig', 50839, '1a6e2c935934791326ce9451da722cb9' + '42b37d3de4a24bb0fd192a3d97aa024e'),
    ('zig/src/agents/scraper/radix.zig', 20076, '425e8aaede59d36cd26d8f15a9b9e9ec' + '27dfee54e8b3ce1e95b24ba415e027db'),
    ('zig/src/agents/scraper/setup.zig', 2232, 'ae1dc00f49f09da514b6819bdf5966f6' + '6a5cfcfac56ab5bfadf0478202392740'),
    ('zig/src/radix/provider.zig', 13805, '504d4ac521c66909288b0a8803ba52bb' + '4cc95cd1d12f95a5e0fa2c4b26405bd5'),
    ('zig/src/radix/events.zig', 7272, 'd8530bcdc7fef11963dad431186de67a' + '1ef4011d57436a3772abb5cc655db199'),
    ('zig/src/radix/sbor.zig', 11342, 'bf22610337733294df42cf51a7a60dbf' + '904feaa0767940bc9022739468862e84'),
    ('rust/main/utils/run-locally/src/radix/mod.rs', 17600, '7792d33957b75fee20925e56d82e7332' + '95310c575cddbed10c9ff59d65fc6461'),
    ('rust/main/utils/run-locally/src/program.rs', 18930, 'fd74db13536484d524e31b2188b6ef0a' + 'c8713422d0a63bf0eba7f60186751510'),
    ('rust/main/utils/run-locally/src/external_agents.rs', 347719, '24ee825613f4fa258af2dc4496addc420' + '943a916c051800b2fa742e6fc99e9cc'),
    ('rust/main/utils/run-locally/src/main.rs', 30900, 'a8e847063664cec776617dace03309dc' + 'e2ebe9c8cd5798108fe8c487d9ac0aaf'),
)

def radix_scraper_metrics(raw, chains):
    """Exact SCR critical operands; absence and zero remain different."""
    if not isinstance(raw,bytes)or len(raw)>1024**2 or not isinstance(chains,tuple)or len(chains)!=2 or len(set(chains))!=2 or any(not isinstance(x,str)or re.fullmatch('[A-Za-z0-9_-]{1,64}',x)is None for x in chains):raise ValueError('Closed Radix scraper metrics required')
    values=[[]for _ in chains];seen=set();count=0
    for line in raw.decode('utf8','strict').splitlines():
        if not line.startswith('hyperlane_critical_error'):continue
        if len(line)>16384:raise ValueError('Bounded SCR sample required')
        match=re.fullmatch(r'hyperlane_critical_error\{([^\r\n]*)\} ([01])',line)
        if match is None:raise ValueError('Closed SCR boolean metric required')
        labels={};cursor=0
        while cursor<len(match[1]):
            item=re.match(r'([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\["\\n])*")',match[1][cursor:])
            if item is None or item[1]in labels or len(labels)>=3:raise ValueError('Closed SCR labels required')
            labels[item[1]]=json.loads(item[2]);cursor+=item.end()
            if cursor<len(match[1]):
                if match[1][cursor]!=',':raise ValueError('Closed SCR separator required')
                cursor+=1
                if cursor==len(match[1]):raise ValueError('Trailing SCR separator')
        if set(labels)!={'agent','hyperlane_baselib_version','chain'}or labels['agent']!='scraper'or labels['hyperlane_baselib_version']!='3.0.0'or labels['chain']not in chains:raise ValueError('SCR Source labels differ')
        index=chains.index(labels['chain'])
        if index in seen:raise ValueError('Duplicate SCR chain sample')
        seen.add(index);count+=1;values[index].append(int(match[2]))
    return {'family_present':count>0,'series_count':count,'expected_series_count':2,'chains':[{'chain_index':i,'selected_present':bool(v),'series_count':len(v),'finite_values':v}for i,v in enumerate(values)],'exact_cutover_operands_observed':count==2 and all(v==[0]for v in values),'native_or_readiness_credit':False}


def radix_scraper_headers(raw, sources):
    """Source-bound SCR text only; no typed exception or PID/lane attribution."""
    if not isinstance(raw,bytes)or len(raw)>32*1024**2:raise ValueError('Existing bounded harness capture required')
    task=sources['zig/src/agents/scraper/task.zig'];supervisor=sources['zig/src/runtime/supervisor.zig'];main=sources['zig/src/service_main.zig']
    needed=[(task,b'std.log.warn("scraper chain={s} lane={s} failed={s}", .{ self.chain.configured.name, @tagName(self.kind), @errorName(err) });'),(main,b'task {d} failed: {s}'),(main,b'agent stopped: {s}')]
    if any(wire.count(needle)!=1 for wire,needle in needed):raise ValueError('Exact SCR warning Source required')
    known=set()
    for wire in sources.values():known.update(x.decode()for x in re.findall(rb'\berror\.([A-Za-z][A-Za-z0-9_]{0,63})\b',wire))
    if len(known)>2048:raise ValueError('Bounded SCR Source error catalog required')
    counts={'lane_failure':0,'supervised_task_failed':0,'agent_stopped':0,'critical_metric_warning':0};rows=[]
    for line in io.BytesIO(raw):
        if len(line)>16384 or not line.startswith(b'<SCR> '):continue
        clean=re.sub(rb'\x1b\[[0-9;]*m',b'',line).strip();kind=None;lane=None;task_index=None;name=None
        m=re.fullmatch(rb'<SCR> (?:warning|warn): scraper chain=[A-Za-z0-9_-]{1,64} lane=(head|delivery|gas|reconciliation|ccr) failed=([A-Za-z][A-Za-z0-9_]{0,63})',clean)
        if m is not None:kind='lane_failure';lane=m[1].decode();name=m[2].decode()
        else:
            m=re.fullmatch(rb'<SCR> (?:warning|warn): task ([0-9]{1,3}) failed: ([A-Za-z][A-Za-z0-9_]{0,63})',clean)
            if m is not None and int(m[1])<=255:kind='supervised_task_failed';task_index=int(m[1]);name=m[2].decode()
            else:
                m=re.fullmatch(rb'<SCR> error: agent stopped: ([A-Za-z][A-Za-z0-9_]{0,63})',clean)
                if m is not None:kind='agent_stopped';name=m[1].decode()
                elif sources['zig/src/ops/critical_metrics.zig'].count(b'std.log.warn("critical metric update failed: {s}", .{@errorName(err)})')==1:
                    m=re.fullmatch(rb'<SCR> (?:warning|warn): critical metric update failed: ([A-Za-z][A-Za-z0-9_]{0,63})',clean)
                    if m is not None:kind='critical_metric_warning';name=m[1].decode()
        if kind is not None:
            counts[kind]=min(2**32-1,counts[kind]+1);row={'header':kind,'Source_lane_name':lane,'task_index':task_index,'Source_error_name':name if name in known else None,'error_name_status':'Source_literal'if name in known else'unknown','PID_or_chain_attribution':None}
            if row not in rows and len(rows)<16:rows.append(row)
    return {'collection_status':'observed','counts':counts,'observations':rows,'scope':'Exact SCR-prefixed Source text; no typed exception, chain label, PID, lane-from-task-index or readiness inference.'}


class RadixScraper:
    """One captured Source epoch; first/latest diagnostic operands, no authority."""
    def __init__(self,repo,manifest,modules):
        if manifest.get('scenario')!='radix'or type(manifest.get('runtime_source_commit'))is not str or re.fullmatch('[a-f0-9]{40}',manifest['runtime_source_commit'])is None:raise ValueError('Exact SCR producer epoch required')
        self.repo=Path(repo);self.sources={};self.identities={};self.first=None;self.last=None;self.latest_probe={'collection_status':'not_attempted'}
        for name,size,digest in RADIX_SCRAPER_SOURCE:
            path=self.repo/name
            if any(x.is_symlink()for x in [path,*[x for x in path.parents if x.is_relative_to(self.repo)]]):raise ValueError('SCR Source symlink')
            wire,actual=captured_failure_bytes(path,1024**2)
            if actual!={'bytes':size,'sha256':digest}:raise ValueError('SCR Source changed')
            self.sources[name]=wire;self.identities[path]=RelayerStartup.identity(path)
        checks={'rust/main/utils/run-locally/src/main.rs':[b'const SCRAPER_METRICS_PORT: &str = \"9093\";'],'zig/src/service_main.zig':[b'Address.parseIp4("0.0.0.0", configured.metrics_port)'],'rust/main/utils/run-locally/src/radix/mod.rs':[b'.spawn("SCR", None)',b'"Radix scraper cutovers", Duration::from_secs(60)',b'"hyperlane_critical_error"'],'rust/main/utils/run-locally/src/program.rs':[b'println!("<{prefix}> {line}");'],'rust/main/utils/run-locally/src/external_agents.rs':[b'pub fn record_child(',b'.join("owned-children.jsonl")']}
        for name,needles in checks.items():
            if any(self.sources[name].count(needle)!=1 for needle in needles):raise ValueError('SCR Source contract differs')
        for name,needles in {'multivm_session.py':[b'"effective-role-configs.jsonl"',b'capture = effective_config(request, self.manifest)'],'multivm_evidence.py':[b'def effective_config(',b'def process_identity(']}.items():
            row=modules[name];path=Path(row['path']);wire,actual=captured_failure_bytes(path,1024**2)
            if row!={'path':str(path),**actual}or any(needle not in wire for needle in needles):raise ValueError('SCR capture writer changed')
            self.identities[path]=RelayerStartup.identity(path)
            if name=='multivm_evidence.py':evidence_wire=wire;evidence_path=path
        # Same admitted pure closure validator as RelayerStartup. No guessed
        # future commit or unbound same-epoch shortcut may arm diagnostics.
        evidence=types.ModuleType('radix_admitted_evidence');evidence.__file__=str(evidence_path)
        exec(compile(evidence_wire,str(evidence_path),'exec'),evidence.__dict__)
        def read_bound(row):
            if type(row)is not dict or set(row)!={'path','bytes','sha256'}or type(row['bytes'])is not int or not 0<row['bytes']<=1024**2 or type(row['path'])is not str or type(row['sha256'])is not str or re.fullmatch('[a-f0-9]{64}',row['sha256'])is None:raise ValueError('Bounded SCR admission descriptor required')
            path=Path(row['path'])
            if not path.is_absolute()or path.resolve()!=path:raise ValueError('Canonical SCR admission required')
            wire,actual=captured_failure_bytes(path,1024**2)
            if row!={'path':str(path),**actual}:raise ValueError('SCR admission bytes changed')
            self.identities[path]=RelayerStartup.identity(path)
            return json.loads(wire)
        approval=read_bound(manifest.get('execution_approval'))
        if approval.get('root_approved')is not True or approval.get('scenario')!='radix'or approval.get('runtime_source_commit')!=manifest['runtime_source_commit']or approval.get('python_modules')!=modules:raise ValueError('SCR admission cross-binding differs')
        closure=read_bound(approval.get('compiled_input_closure'))
        for check in closure.get('checks',[]):read_bound(check.get('log'))
        evidence.validate_compiled_input_closure(manifest,approval)
        admitted=approval.get('diagnostic_radix_scraper_sources')
        if type(admitted)is not dict or set(admitted)!=set(self.sources):raise ValueError('Exact SCR Source admission required')
        for relative,size,digest in RADIX_SCRAPER_SOURCE:
            if admitted[relative]!={'path':str(self.repo/relative),'bytes':size,'sha256':digest}:raise ValueError('SCR Source admission differs')
        self.epoch=manifest['runtime_source_commit']
        self.check_sources()
    def check_sources(self):
        if any(RelayerStartup.identity(path)!=identity for path,identity in self.identities.items()):raise ValueError('SCR Source identity changed')
    def project(self,raw,chains,started,finished):
        self.check_sources()
        if type(started)is not int or type(finished)is not int or not 0<started<=finished or finished-started>500_000_000:raise ValueError('SCR absolute probe bound')
        row={'collection_status':'observed','started_monotonic_ns':started,'finished_monotonic_ns':finished,'whole_Radix_diagnostic_cadence_limit_ns':500_000_000,'operands':radix_scraper_metrics(raw,chains),'native_or_timing_or_cleanup_authority':False}
        if self.first is None:self.first=row
        self.last=row;self.latest_probe={'collection_status':'observed','started_monotonic_ns':started,'finished_monotonic_ns':finished}
        return row
    def headers(self,raw):
        self.check_sources();return radix_scraper_headers(raw,self.sources)
    def public(self,headers):
        self.check_sources()
        return {'schema':1,'collection_status':'observed','Source_epoch':self.epoch,'Source_contracts':[{'path':n,'bytes':z,'sha256_hex_chunks':[h[:32],h[32:]]}for n,z,h in RADIX_SCRAPER_SOURCE],'first_probe':self.first,'last_probe':self.last,'latest_probe':self.latest_probe,'fixed_harness_headers':headers if headers is not None else{'collection_status':'unavailable'},'native_or_timing_or_cleanup_authority':False,'scope':'Fixed owned SCR9093 read-only metric operands.0 differs from absence. No raw labels/messages or typed exception, actual parent-wait or native acceptance authority.'}


def radix_selected_scraper(case,manifest,inputs,parent_pid,read,kernel_row,read_executable,check):
    """Captured SCR configuration plus current child identity, never PS vs ticks."""
    check()
    if manifest.get('scenario')!='radix':raise ValueError('Radix-only SCR selection')
    def journal(name):
        target=Path(case)/'evidence'/name
        if any(x.is_symlink()for x in [target,target.parent,Path(case)]):raise ValueError('SCR journal symlink')
        raw,_=read(target,1024**2);check();lines=raw.splitlines()
        if len(lines)>128 or any(len(line)>65536 for line in lines):raise ValueError('Bounded SCR journal required')
        return [startup_unique_json(line)for line in lines]
    captures=[]
    for row in journal('effective-role-configs.jsonl'):
        if not isinstance(row,dict)or not isinstance(row.get('original'),dict):raise ValueError('SCR capture shape')
        original=row['original']
        if original.get('role')!='scraper':continue
        chains=original.get('role_chain_names')
        if original.get('runtime_source_commit')!=manifest['runtime_source_commit']or original.get('scenario')!='radix'or original.get('harness_pid')!=parent_pid or original.get('metrics_port')!=9093 or not isinstance(chains,list)or len(chains)!=2 or len(set(chains))!=2 or set(chains)!=set(inputs['chain_names'])or any(not isinstance(x,str)or re.fullmatch('[A-Za-z0-9_-]{1,64}',x)is None or not isinstance(original.get('chains',{}).get(x),dict)or original['chains'][x].get('protocol')!='radix'for x in chains):raise ValueError('SCR captured configuration differs')
        captures.append(tuple(chains))
    if not captures or len(set(captures))!=1:raise ValueError('One consistent SCR capture required')
    candidates=[];seen=set()
    for row in journal('owned-children.jsonl'):
        if not isinstance(row,dict):raise ValueError('SCR ownership shape')
        if row.get('role')!='scraper':continue
        pid=row.get('pid');token=row.get('os_start_token');key=(pid,token)
        if type(pid)is not int or not 0<pid<2**31 or row.get('parent_pid')!=parent_pid or row.get('executable')!=manifest['artifacts']['scraper']or not isinstance(token,str)or len(token)>4096 or len(token.split())<8 or token.split()[:2]!=[str(pid),str(parent_pid)]or key in seen:raise ValueError('SCR ownership differs')
        seen.add(key);live=kernel_row(pid);check()
        if live is None or live.get('state')=='Z':continue
        if live.get('pid')!=pid or live.get('ppid')!=parent_pid or not isinstance(live.get('start'),str)or re.fullmatch('linux-ticks:[0-9]{1,24}',live['start'])is None or read_executable(pid)!=manifest['artifacts']['scraper']['path']:raise ValueError('Current SCR identity differs')
        candidates.append(live)
    if len(candidates)!=1:raise ValueError('One current owned SCR required')
    check();return candidates[0],captures[0],9093


RADIX_RPC_CORE_ERRORS = frozenset(('Basic','TransactionSubmit','LtsTransactionSubmit','TransactionPreviewV2','StreamTransactions','StreamProofs'))
RADIX_RPC_ROUTES = {'CORE_NETWORK_STATUS':('core','/status/network-status'),'CORE_CALL_PREVIEW':('core','/transaction/call-preview'),'GATEWAY_STATUS':('gateway','/status/gateway-status'),'GATEWAY_STREAM':('gateway','/stream/transactions')}


def radix_rpc_failure_observation(case,manifest,approval,plan,inputs,parent_pid,state,end_ns,clock):
    """Read existing passive journal only; Source contract, no HTTP or raw text."""
    import urllib.parse,ast
    def check():
        if type(end_ns)is not int or clock()>=end_ns:raise TimeoutError('Original private failure budget expired')
    def identity(path):
        value=path.lstat()
        if path.is_symlink()or not stat.S_ISREG(value.st_mode)or value.st_nlink!=1 or value.st_uid!=os.getuid():raise ValueError('Owned regular RPC evidence required')
        return value.st_dev,value.st_ino,value.st_size,value.st_mtime_ns,value.st_ctime_ns
    identities={}
    def read(path,maximum):
        check();path=Path(path)
        if not path.is_absolute()or path.resolve(strict=True)!=path:raise ValueError('Canonical RPC evidence required')
        before=identity(path)
        if before[2]>maximum:raise ValueError('Bounded RPC evidence required')
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        try:
            info=os.fstat(fd)
            if (info.st_dev,info.st_ino)!=(before[0],before[1]):raise ValueError('RPC evidence replaced')
            wire=bytearray()
            while True:
                check();part=os.read(fd,min(65536,maximum+1-len(wire)));check()
                if not part:break
                wire.extend(part)
                if len(wire)>maximum:raise ValueError('RPC evidence bound')
            if len(wire)!=before[2]or identity(path)!=before:raise ValueError('RPC evidence changed')
        finally:os.close(fd)
        identities[path]=before;return bytes(wire)
    def bound(row,maximum,owned=False):
        if type(row)is not dict or set(row)!={'path','bytes','sha256'}or type(row['bytes'])is not int or not 0<row['bytes']<=maximum or type(row['sha256'])is not str or re.fullmatch('[a-f0-9]{64}',row['sha256'])is None:raise ValueError('Exact RPC context descriptor required')
        path=Path(row['path'])
        if owned and not path.is_relative_to(root):raise ValueError('RPC context outside owned case')
        wire=read(path,maximum)
        if len(wire)!=row['bytes']or hashlib.sha256(wire).hexdigest()!=row['sha256']:raise ValueError('RPC context changed')
        return wire
    def records(path,maximum,limit,line_limit):
        wire=read(path,maximum);lines=wire.splitlines()
        if len(lines)>limit or any(not line or len(line)>line_limit for line in lines):raise ValueError('RPC record bound')
        return lines
    def finite(value,depth=0):
        nonlocal nodes
        check();nodes+=1
        if depth>32 or nodes>100000:raise ValueError('RPC JSON structure bound')
        if isinstance(value,dict):
            for child in value.values():finite(child,depth+1)
        elif isinstance(value,list):
            for child in value:finite(child,depth+1)
    def uint(value):return value if type(value)is int and 0<=value<2**64 else None
    check();state.check_sources();root=Path(case)
    if root!=Path(manifest['task_root'])or not root.is_absolute()or root.is_symlink()or root.resolve(strict=True)!=root or manifest.get('scenario')!='radix'or plan.get('scenario')!='radix'or plan.get('root_approved')is not True or manifest.get('implementation')!='zig'or manifest.get('runtime_source_commit')!=state.epoch or type(parent_pid)is not int or not 0<parent_pid<2**31:raise ValueError('Exact owned Radix case required')
    if startup_unique_json(bound(plan['manifestArtifact'],1024**2,True))!=manifest or startup_unique_json(bound(manifest['execution_approval'],1024**2,True))!=approval or startup_unique_json(bound(manifest['case_inputs'],1024**2,True))!=inputs:raise ValueError('RPC case/control context differs')
    if approval.get('root_approved')is not True or approval.get('scenario')!='radix'or approval.get('runtime_source_commit')!=manifest['runtime_source_commit']or approval.get('execution_source_commit')!=plan['execution_source_commit']:raise ValueError('RPC approval differs')
    module_bodies={}
    for name,needles in {'multivm_session.py':[b'record = {"chain": chain, "role": role, "endpoint_field": field, "upstream": endpoint, "status": status,',b'"path": request["start"].split(" ")[1]',b'self.append("native-rpc-observations.jsonl", record)',b'self.captures.append(row)',b'capture = effective_config(request, self.manifest)'],'multivm_evidence.py':[b'def effective_config(',b'def urls(value):',b'def direct_endpoint(',b'def endpoint(self):']}.items():
        row=approval['python_modules'][name]
        if row not in plan['required_inputs']or row['path']!=str(state.repo/'zig/integration'/name):raise ValueError('RPC writer not admitted')
        wire=bound(row,1024**2)
        if any(wire.count(needle)!=1 for needle in needles):raise ValueError('RPC writer Source contract differs')
        module_bodies[name]=wire
    provider=state.sources['zig/src/radix/provider.zig']
    if provider.count(b'.method = .POST')!=1 or any(path.encode()not in provider for _,path in RADIX_RPC_ROUTES.values()):raise ValueError('RPC Source POST/routes differ')
    lock=plan['diagnostic_radix_client_lock']
    if lock not in plan['required_inputs']or lock['path']!=str(state.repo/RADIX_SUBMIT_LOCK):raise ValueError('RPC official client lock not admitted')
    wire=bound(lock,1024**2)
    if hashlib.sha256(wire).hexdigest()!=RADIX_SUBMIT_SOURCE_SHA[RADIX_SUBMIT_LOCK]or ('rev='+RADIX_CLIENT_REVISION+'#'+RADIX_CLIENT_REVISION).encode()not in wire:raise ValueError('RPC official error catalog revision differs')
    names=inputs['chain_names']
    if type(names)is not list or len(names)!=2 or len(set(names))!=2:raise ValueError('Two admitted Radix chains required')
    # Reuse only the admitted pure URL parser, not a second interpretation.
    tree=ast.parse(module_bodies['multivm_evidence.py']);node=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='urls');scope={'json':json,'require':lambda value,reason:None if value else(_ for _ in()).throw(ValueError('RPC URL shape differs'))}
    exec(compile(ast.Module(body=[node],type_ignores=[]),'admitted-RPC-urls','exec'),scope)
    endpoint_sets=[]
    for line in records(root/'evidence/effective-role-configs.jsonl',1024**2,128,65536):
        row=startup_unique_json(line);original=row.get('original')if isinstance(row,dict)else None
        if not isinstance(original,dict):raise ValueError('RPC capture shape')
        if original.get('role')!='scraper':continue
        if original.get('scenario')!='radix'or original.get('runtime_source_commit')!=manifest['runtime_source_commit']or original.get('harness_pid')!=parent_pid or original.get('metrics_port')!=9093 or type(original.get('role_chain_names'))is not list or len(original['role_chain_names'])!=2 or len(set(original['role_chain_names']))!=2 or set(original['role_chain_names'])!=set(names)or type(original.get('chains'))is not dict or set(original['chains'])!=set(names):raise ValueError('RPC SCR capture differs')
        selected=set()
        for name in names:
            chain=original['chains'][name]
            if chain.get('protocol')!='radix':raise ValueError('RPC captured family differs')
            for field in ('rpcurls','customrpcurls','gatewayurls','customgatewayurls'):
                if field not in chain:continue
                kind='core'if field in{'rpcurls','customrpcurls'}else'gateway'
                for endpoint in scope['urls'](chain[field]):
                    parsed=urllib.parse.urlsplit(endpoint)
                    if parsed.scheme!='http'or parsed.hostname not in{'localhost','127.0.0.1'}or parsed.port!=(3333 if kind=='core'else 5308)or parsed.username is not None or parsed.password is not None or parsed.query or parsed.fragment or parsed.path.rstrip('/')!=('/core'if kind=='core'else''):raise ValueError('RPC Source endpoint differs')
                    selected.add((name,field,endpoint,kind,parsed.path.rstrip('/')))
        if not all(any(x[0]==name and x[3]==kind for x in selected)for name in names for kind in ('core','gateway')):raise ValueError('RPC endpoint coverage differs')
        endpoint_sets.append(selected)
    if not endpoint_sets or any(value!=endpoint_sets[0]for value in endpoint_sets):raise ValueError('Ambiguous RPC SCR captures')
    allowed={(name,field,url):(kind,path)for name,field,url,kind,path in endpoint_sets[0]};groups={key:{'matched_count':0,'error_count':0,'first':None,'latest':None,'latest_error':None}for key in RADIX_RPC_ROUTES};other=0;scanned=0
    keys={'chain','role','endpoint_field','upstream','status','requested_monotonic_ns','received_monotonic_ns','request_wire_sha256','response_wire_sha256','request','response','path'}
    for index,line in enumerate(records(root/'evidence/native-rpc-observations.jsonl',8*1024**2,4096,1024**2)):
        check();row=startup_unique_json(line);nodes=0;finite(row);scanned+=1
        if type(row)is not dict or set(row)!=keys or row['role']not in{'relayer','validator','scraper'}:raise ValueError('RPC writer record differs')
        if row['role']!='scraper':continue
        endpoint_key=(row['chain'],row['endpoint_field'],row['upstream'])
        if endpoint_key not in allowed:raise ValueError('RPC endpoint not captured')
        kind,base=allowed[endpoint_key];route=next((key for key,(api,path)in RADIX_RPC_ROUTES.items()if api==kind and row['path']==base+path),None)
        if route is None:other+=1;continue
        status=row['status'];requested=row['requested_monotonic_ns'];received=row['received_monotonic_ns']
        if type(status)is not int or not 100<=status<=599 or type(requested)is not int or type(received)is not int or not 0<requested<=received<=end_ns or any(type(row[name])is not str or re.fullmatch('[a-f0-9]{64}',row[name])is None for name in ('request_wire_sha256','response_wire_sha256')):raise ValueError('RPC status/clock/shape differs')
        request=row['request'];response=row['response'];request=request if isinstance(request,dict)else{};response=response if isinstance(response,dict)else{};selector=request.get('at_ledger_state');selector=selector if isinstance(selector,dict)else{};target=request.get('target');target=target if isinstance(target,dict)else{}
        requested_sv=uint(selector.get('state_version'))if route=='GATEWAY_STREAM'or route=='CORE_CALL_PREVIEW'and selector.get('type')=='ByStateVersion'else None
        ledger=response.get('current_state_identifier'if route=='CORE_NETWORK_STATUS'else'at_ledger_state'if route=='CORE_CALL_PREVIEW'else'ledger_state');ledger=ledger if isinstance(ledger,dict)else{}
        current_sv=uint(ledger.get('state_version'))if status==200 else None
        error=None
        if status!=200:
            if kind=='core':error=response.get('error_type')if type(response.get('error_type'))is str and response.get('error_type')in RADIX_RPC_CORE_ERRORS else None
            else:
                details=response.get('details');error=details.get('type')if isinstance(details,dict)and type(details.get('type'))is str and details.get('type')in RADIX_GATEWAY_ERRORS else None
        method=target.get('method_name')if route=='CORE_CALL_PREVIEW'and target.get('type')=='Method'and type(target.get('method_name'))is str and target.get('method_name')in{'nonce','processed','sequence','count'}else None
        public={'journal_record_index':index,'observed_method':None,'Source_method':'POST','Source_method_basis':'Pinned SCR Client.callOne; HTTPmethod not recorded by journal','HTTP_status':status,'official_error_type':error,'error_type_basis':'Allowlisted JSON text only; no typed exception or cause claim','requested_state_version':requested_sv,'returned_state_version':current_sv,'Source_counter_method':method,'requested_monotonic_ns':requested,'received_monotonic_ns':received}
        group=groups[route];group['matched_count']+=1
        if group['first']is None:group['first']=public
        group['latest']=public
        if status!=200:group['error_count']+=1;group['latest_error']=public
    check();state.check_sources()
    if any(identity(path)!=before for path,before in identities.items()):raise ValueError('RPC evidence changed before publication')
    check();return {'schema':1,'collection_status':'observed','records_scanned':scanned,'unselected_scraper_records':other,'routes':groups,'ordering_basis':'Persisted append order; concurrent requests need not be chronological','official_catalog_revision':RADIX_CLIENT_REVISION,'native_or_timing_or_cleanup_authority':False,'scope':'Existing Source-bound SCR proxy journal. No new requests, rawURL/headers/body/message/chain labels or PID inference. Method is Source-only, not observed; optional integers from fixed structured fields. No actual Rust-poll simultaneity or causal fix claim.'}


RADIX_TRANSPORT_SERVICES = ('fullnode','postgres_db','database_migrations_image','data_aggregator_image','gateway_api_image')
RADIX_HTTP_SERVICES = {'fullnode':(3333,3333,'/core/status/network-configuration'),'gateway_api_image':(5308,8080,'/status/gateway-status')}


class RadixTargetConnectRefused(Exception):
    """Only the fixed target socket.connect outcome, not a daemon/API error."""


def radix_readiness_predicate(service,wire):
    import math
    value=startup_unique_json(wire);nodes=0
    def finite(item,depth=0):
        nonlocal nodes
        nodes+=1
        if depth>32 or nodes>250000:raise ValueError('Radix JSON structure bound')
        if isinstance(item,float)and not math.isfinite(item):raise ValueError('Nonfinite Radix JSON')
        if type(item)is int and abs(item)>10**308:raise ValueError('Radix JSON number bound')
        if isinstance(item,dict):
            for child in item.values():finite(child,depth+1)
        elif isinstance(item,list):
            for child in item:finite(child,depth+1)
    finite(value)
    if not isinstance(value,dict):return 'INVALID_PAYLOAD'
    if service=='fullnode':
        return 'SOURCE_READY'if value.get('network')=='localnet'and type(value.get('network_id'))is int and value['network_id']==240 and value.get('network_hrp_suffix')=='loc'else'WRONG_SOURCE_NETWORK'
    state=value.get('ledger_state')
    return 'SOURCE_READY'if isinstance(state,dict)and state.get('network')=='localnet'and type(state.get('state_version'))is int and 0<state['state_version']<2**64 else'NO_SOURCE_COMMITTED_LEDGER'


class RadixTransport:
    """Read-only first/latest bounded HTTP snapshots; never custody authority."""
    def __init__(self,fixture,source_descriptor,custody_descriptor,repo):
        self.fixture=copy.deepcopy(fixture);self.repo=Path(repo);self.source_identities={};self.source_descriptors=[];self.samples=[];self.pending=None;self.first_started=None;self.active=False;self.rows={};self.network=None;self.capture_invalid=False
        for path,descriptor,needles in [(Path(repo)/'rust/main/utils/run-locally/src/external_agents/radix_fixture.rs',source_descriptor,[b'"networks":{"default":{"internal":true}}',b'http://127.0.0.1:3333/core/status/network-configuration',b'http://127.0.0.1:5308/status/gateway-status',b'.post(endpoint)',b'.send_string("{}")?',b'Duration::from_secs(120)']), (Path(repo)/'zig/bench/native_radix_custody.py',custody_descriptor,[b"'fullnode': (1536, 256, {'3333/tcp': 3333})",b"'gateway_api_image': (512, 128, {'8080/tcp': 5308",b'def readiness(',b'def ownership('])]:
            wire,fingerprint=captured_failure_bytes(path,1024**2)
            if descriptor!={'path':str(path),**fingerprint}or not all(x in wire for x in needles):raise ValueError('Exact existing Radix Source binding required')
            self.source_identities[path]=RelayerStartup.identity(path);self.source_descriptors.append({'path':path.relative_to(self.repo).as_posix(),**fingerprint})
        if set(fixture)!={'architecture','token','images'}or fixture['architecture']!='amd64'or re.fullmatch('[0-9a-f]{32}',fixture['token'])is None or set(fixture['images'])!=set(RADIX_TRANSPORT_SERVICES):raise ValueError('Exact Radix fixture required')

    def check_sources(self):
        if any(RelayerStartup.identity(path)!=identity for path,identity in self.source_identities.items()):raise ValueError('Radix diagnostic Source changed')

    def begin_custody(self):
        self.active=True;self.rows={};self.network=None;self.capture_invalid=False

    def capture(self,arguments,wire):
        # This tap is invoked only for already completed ordinary Docker calls.
        # It never calls Docker and never exports a raw response/config/IP.
        if not self.active:return
        if not ((len(arguments)==4 and arguments[:3]==['container','inspect','--size'])or(len(arguments)==3 and arguments[:2]==['network','inspect'])):return
        try:
            if not isinstance(wire,str)or len(wire.encode())>2*1024**2:raise ValueError('Radix capture bound')
            rows=startup_unique_json(wire)
            if not isinstance(rows,list)or len(rows)!=1:raise ValueError('One captured Radix row required')
            row=rows[0]
            if arguments[0]=='container':
                labels=row['Config']['Labels'];service=labels['com.docker.compose.service'];networks=row['NetworkSettings']['Networks']
                if service not in RADIX_TRANSPORT_SERVICES or service in self.rows or len(networks)>8:raise ValueError('Captured service set differs')
                self.rows[service]={'Id':row['Id'],'Image':row['Image'],'Config':{'Labels':{k:labels.get(k)for k in ('com.docker.compose.project','com.docker.compose.service','io.hyperlane.ziggy.radix-token')}},'State':{k:row['State'].get(k)for k in ('Running','OOMKilled','Pid','Status','ExitCode')},'Networks':{name:{k:v.get(k)for k in ('NetworkID','EndpointID','IPAddress')}for name,v in networks.items()}}
            else:
                containers=row.get('Containers')or{}
                if len(containers)>8 or self.network is not None:raise ValueError('Captured network set differs')
                self.network={'Id':row['Id'],'Name':row['Name'],'Internal':row['Internal'],'Driver':row['Driver'],'project':row['Labels'].get('com.docker.compose.project'),'Containers':{cid:{k:v.get(k)for k in ('EndpointID','IPv4Address')}for cid,v in containers.items()}}
        except Exception:self.capture_invalid=True

    def identity(self,custody,kernel_row,check):
        import ipaddress
        check();self.check_sources()
        if custody.fixture!=self.fixture or self.capture_invalid or set(self.rows)!=set(RADIX_TRANSPORT_SERVICES)or set(custody.seen)!=set(RADIX_TRANSPORT_SERVICES)or custody.ready!=custody.seen or custody.stopping():raise ValueError('Positive ordinary custody required')
        network=self.network
        if not isinstance(network,dict)or network['Internal']is not True or network['Driver']!='bridge'or network['Name']!=custody.network or network['project']!=custody.project or re.fullmatch('[0-9a-f]{64}',network['Id'])is None or set(network['Containers'])-set(custody.seen.values()):raise ValueError('Exact internal owned network required')
        for service,row in self.rows.items():
            state=row['State']
            if state['OOMKilled']is not False:raise ValueError('Current Radix readiness required')
            if service=='database_migrations_image':
                if state['Status']!='exited'or state['ExitCode']!=0:raise ValueError('Current successful migration required')
            elif state['Running']is not True or type(state['Pid'])is not int or state['Pid']<=0:raise ValueError('Current running service required')
        result={}
        for service in RADIX_HTTP_SERVICES:
            check();row=self.rows[service];cid=custody.seen[service];labels=row['Config']['Labels'];state=row['State']
            if row['Id']!=cid or re.fullmatch('[0-9a-f]{64}',cid)is None or row['Image']!=self.fixture['images'][service]['id']or labels!={'com.docker.compose.project':custody.project,'com.docker.compose.service':service,'io.hyperlane.ziggy.radix-token':self.fixture['token']}or state['Running']is not True or state['OOMKilled']is not False or type(state['Pid'])is not int or state['Pid']<=0 or set(row['Networks'])!={custody.network}:raise ValueError('Exact live Radix CID/image/epoch required')
            live=kernel_row(state['Pid']);check()
            if live is None or live.get('pid')!=state['Pid']or live.get('state')=='Z'or not isinstance(live.get('start'),str)or re.fullmatch('linux-ticks:[0-9]{1,24}',live['start'])is None:raise ValueError('Actual container process birth required')
            endpoint=row['Networks'][custody.network];peer=network['Containers'].get(cid);address=ipaddress.IPv4Address(endpoint['IPAddress'])
            if peer is None or endpoint['NetworkID']!=network['Id']or re.fullmatch('[0-9a-f]{64}',endpoint['EndpointID'])is None or endpoint['EndpointID']!=peer['EndpointID']or ipaddress.IPv4Interface(peer['IPv4Address']).ip!=address or not address.is_private or address.is_loopback or address.is_unspecified or address.is_multicast:raise ValueError('Exact owned private endpoint required')
            result[service]=(cid,row['Image'],state['Pid'],live['start'],network['Id'],endpoint['EndpointID'],str(address))
        check();return result

    def observe(self,custody,kernel_row,check,clock,cancelled,deadline_ns,http):
        self.active=False
        try:
            before=self.identity(custody,kernel_row,check);observed=clock()
            if self.pending is not None:
                if before==self.pending['identity']and observed>self.pending['public']['HTTP_finished_ns']:
                    self.pending['public'].update(crossbinding_status='FRESH_CUSTODY_MATCHED',crossbinding_verified=True,post_custody_observed_ns=observed)
                else:self.pending['public']['crossbinding_status']='POST_CUSTODY_CHANGED'
                self.pending=None
            if len(self.samples)>=2 or(self.first_started is not None and observed-self.first_started<90_000_000_000):return
            start=clock();end=min(deadline_ns,start+500_000_000)
            def transport_cancelled():return cancelled()or custody.stopping()
            def within():
                check()
                if transport_cancelled()or clock()>=end:raise TimeoutError('Original HTTP-only Radix fence')
            report={'schema':1,'HTTP_started_ns':start,'HTTP_deadline_ns':end,'HTTP_finished_ns':None,'post_custody_observed_ns':None,'crossbinding_status':'PENDING_FRESH_CUSTODY','crossbinding_verified':False,'observations':[]}
            for service,(host_port,private_port,_)in RADIX_HTTP_SERVICES.items():
                for route in ('host_loopback','owned_private_endpoint'):
                    row={'service':service,'route':route,'outcome':'NOT_ATTEMPTED','http_status':None,'Source_predicate':'UNAVAILABLE'};report['observations'].append(row)
                    try:
                        within();target=('127.0.0.1',host_port)if route=='host_loopback'else(before[service][-1],private_port)
                        status,wire=http(service,route,target,end,transport_cancelled,clock);within()
                        if type(status)is not int or not 100<=status<=599 or not isinstance(wire,bytes)or len(wire)>2*1024**2:raise ValueError('Bounded fixed HTTP result required')
                        predicate=radix_readiness_predicate(service,wire)if status==200 else'HTTP_NOT_200';within();row.update(outcome='HTTP_RESPONSE',http_status=status,Source_predicate=predicate)
                    except RadixTargetConnectRefused:row['outcome']='TARGET_CONNECT_REFUSED'
                    except TimeoutError:row['outcome']='HTTP_DEADLINE_OR_CANCELLED'
                    except Exception:row['outcome']='UNAVAILABLE'
            report['HTTP_finished_ns']=clock()
            if transport_cancelled()or report['HTTP_finished_ns']>=end:
                for row in report['observations']:row.update(outcome='HTTP_DEADLINE_OR_CANCELLED',http_status=None,Source_predicate='UNAVAILABLE')
            self.samples.append(report);self.first_started=start if self.first_started is None else self.first_started
            self.pending={'identity':before,'public':report}
        except Exception:
            # Existing custody/worker guard retains the primary failure. A
            # missing next cadence can never become a postvalidated observation.
            return

    def public(self):
        self.check_sources()
        return {'schema':1,'kind':'public-Radix-transport-observation','collection_status':'observed'if self.samples else'not_attempted_or_unavailable','Source_contracts':copy.deepcopy(self.source_descriptors),'runtime_source_commit':getattr(self,'runtime_source_commit',None),'samples':copy.deepcopy(self.samples),'HTTP_only_budget_ns':500_000_000,'ordinary_custody_outside_HTTP_budget':True,'ordinary_Docker_timeout_seconds':4,'ordinary_Docker_owned_child_cleanup_seconds':3,'Rust120s_clock_observed':False,'Docker_ServerVersion':getattr(self,'engine_version',None),'native_or_timing_or_cleanup_authority':False,'scope':'Fixed Source POST readiness observations only. CID/network/process endpoint crossbinding remains pending unless next ordinary custody matches. No raw IP/URL/header/body/error, daemon-parent wait or native readiness authority.'}


def radix_response_body(wire,length,chunked,eof):
    maximum=2*1024**2
    if len(wire)>maximum+32768 or(length is not None and not 0<=length<=maximum):raise ValueError('Radix encoded body bound')
    if length is not None:
        if len(wire)>length:raise ValueError('Excess Radix HTTP body')
        if len(wire)==length:return bytes(wire)
    elif not chunked:
        if len(wire)>maximum:raise ValueError('Radix response body bound')
        if eof:return bytes(wire)
    else:
        cursor=0;decoded=bytearray();count=0
        while True:
            boundary=wire.find(b'\r\n',cursor)
            if boundary<0:
                if len(wire)-cursor>128:raise ValueError('Radix chunk header bound')
                break
            value=wire[cursor:boundary]
            if re.fullmatch(rb'[0-9A-Fa-f]{1,8}(?:;[ -~]{0,96})?',value)is None:raise ValueError('Invalid Radix chunk header')
            size=int(value.split(b';',1)[0],16);cursor=boundary+2;count+=1
            if count>4096 or size>maximum-len(decoded):raise ValueError('Radix chunk body bound')
            if size==0:
                if len(wire)-cursor<2:break
                if wire[cursor:cursor+2]==b'\r\n':end=cursor+2
                else:
                    trailer_end=wire.find(b'\r\n\r\n',cursor)
                    if trailer_end<0:
                        if len(wire)-cursor>8192:raise ValueError('Radix trailer bound')
                        break
                    trailer=wire[cursor:trailer_end];lines=trailer.split(b'\r\n')
                    if len(trailer)>8192 or len(lines)>32:raise ValueError('Radix trailer bound')
                    names=set()
                    for line in lines:
                        field=re.fullmatch(rb'([A-Za-z0-9-]{1,64}):[ \t]*([^\r\n]*)',line)
                        if field is None or field[1].lower()in names or field[1].lower()in{b'content-length',b'transfer-encoding'}or any(x<32 and x!=9 or x==127 for x in field[2]):raise ValueError('Invalid Radix trailer')
                        names.add(field[1].lower())
                    end=trailer_end+4
                if len(wire)!=end:raise ValueError('Excess Radix chunk wire')
                return bytes(decoded)
            if len(wire)-cursor<size+2:break
            if wire[cursor+size:cursor+size+2]!=b'\r\n':raise ValueError('Invalid Radix chunk boundary')
            decoded.extend(wire[cursor:cursor+size]);cursor+=size+2
    if eof:raise ValueError('Incomplete Radix HTTP response')
    return None


def radix_transport_http(service,route,target,deadline_ns,cancelled,clock):
    """Fixed Source POST{}, numeric AF_INET only, one supplied absolute fence."""
    import errno
    import ipaddress
    import select
    import socket
    if service not in RADIX_HTTP_SERVICES or route not in{'host_loopback','owned_private_endpoint'}or not isinstance(target,tuple)or len(target)!=2 or type(deadline_ns)is not int:raise ValueError('Fixed Radix diagnostic route required')
    address=ipaddress.IPv4Address(target[0]);host_port,private_port,path=RADIX_HTTP_SERVICES[service]
    if target[1]!=(host_port if route=='host_loopback'else private_port)or(route=='host_loopback'and str(address)!='127.0.0.1')or(route=='owned_private_endpoint'and(not address.is_private or address.is_loopback or address.is_unspecified or address.is_multicast)):raise ValueError('Fixed admitted Radix endpoint required')
    def check():
        if cancelled()or clock()>=deadline_ns:raise TimeoutError('Radix HTTP absolute fence/cancel')
    def wait(stream,writing=False):
        while True:
            check();remaining=(deadline_ns-clock())/10**9
            if remaining<=0:raise TimeoutError('Radix HTTP absolute fence')
            value=select.select([]if writing else[stream],[stream]if writing else[],[],min(.025,remaining));check()
            if(value[1]if writing else value[0]):return
    def connected(code):
        check()
        if code==errno.ECONNREFUSED:raise RadixTargetConnectRefused()
        if code:raise OSError('Radix target connect unavailable')
    check();stream=socket.socket(socket.AF_INET,socket.SOCK_STREAM)
    try:
        stream.setblocking(False);check();code=stream.connect_ex((str(address),target[1]));check()
        if code in{errno.EINPROGRESS,errno.EWOULDBLOCK,errno.EALREADY}:wait(stream,True);connected(stream.getsockopt(socket.SOL_SOCKET,socket.SO_ERROR))
        else:connected(code)
        wire=f'POST {path} HTTP/1.1\r\nHost: {address}:{target[1]}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}'.encode();sent=0
        while sent<len(wire):
            wait(stream,True)
            try:size=stream.send(wire[sent:])
            except BlockingIOError:continue
            check()
            if size<=0:raise OSError('Radix socket closed')
            sent+=size
        response=bytearray();boundary=None;length=None;status=None;chunked=False
        while True:
            wait(stream)
            try:chunk=stream.recv(16384)
            except BlockingIOError:continue
            check()
            if not chunk and boundary is None:raise ValueError('Incomplete Radix HTTP header')
            response.extend(chunk)
            if len(response)>2*1024**2+32768:raise ValueError('Radix response bound')
            if boundary is None:
                offset=response.find(b'\r\n\r\n')
                if offset<0:
                    if len(response)>32768:raise ValueError('Radix header bound')
                    continue
                if offset>32764:raise ValueError('Radix header bound')
                lines=bytes(response[:offset]).split(b'\r\n');match=re.fullmatch(rb'HTTP/1\.[01] ([1-5][0-9]{2})(?: [^\r\n]*)?',lines[0])
                if match is None:raise ValueError('Invalid Radix HTTP status')
                status=int(match[1]);headers={}
                for line in lines[1:]:
                    item=re.fullmatch(rb'([!#$%&\x27*+.^_`|~0-9A-Za-z-]+):[ \t]*([^\r\n]*)',line)
                    if item is None or item[1].lower()in headers or any(x<32 and x!=9 or x==127 for x in item[2]):raise ValueError('Invalid Radix HTTP header')
                    headers[item[1].lower()]=item[2].strip()
                if headers.get(b'content-encoding',b'identity')!=b'identity'or(b'transfer-encoding'in headers and b'content-length'in headers):raise ValueError('Ambiguous Radix response framing')
                if b'transfer-encoding'in headers:
                    if headers[b'transfer-encoding'].lower()!=b'chunked':raise ValueError('Unsupported Radix encoding')
                    chunked=True
                if b'content-length'in headers:
                    if re.fullmatch(rb'[0-9]{1,7}',headers[b'content-length'])is None:raise ValueError('Invalid Radix length')
                    length=int(headers[b'content-length'])
                    if length>2*1024**2:raise ValueError('Radix body bound')
                boundary=offset+4
            body=radix_response_body(response[boundary:],length,chunked,not chunk);check()
            if body is not None:return status,body
    finally:stream.close()



class TronCLIProjectionError(ValueError):
    def __init__(self,reason):self.reason=reason;super().__init__(reason)


def tron_cli_unavailable(reason,frontier):
    if reason not in{'CONTEXT_NOT_SUPPLIED','CONSTRUCTOR_CONTEXT_REJECTED','ENTRY_SOURCE_CAPTURE_REJECTED','ENTRY_SOURCE_CONTRACT_REJECTED','COLLECTOR_FAILED','PUBLIC_SOURCE_RECHECK_FAILED','NO_QUALIFIED_WINDOW','LOG_LINE_BOUND','JOIN_CASCADE_MESSAGE_REJECTED','JOIN_CASCADE_MESSAGE_UNQUALIFIED','LATER_PANIC_AMBIGUITY','DUPLICATE_FIRST_DEPLOY','DEPLOY_WINDOW_CLOSED','PRIMARY_PANIC_UNQUALIFIED'}:reason='COLLECTOR_FAILED'
    if frontier not in{'CONSTRUCTOR','WINDOW_SCAN','WINDOW_OPEN','PRIMARY_PANIC','LATER_PANIC','PUBLICATION'}:frontier='WINDOW_SCAN'
    return {'collection_status':'unavailable','discard_reason':reason,'frontier':frontier,'native_or_timing_or_cleanup_authority':False,'scope':'Finite collector frontier only; no retained CLI cause, raw error or execution authority.'}


def tron_encrypted_prefix(value,key_id):
    if type(value)is not dict or type(value.get('schema'))is not int or value['schema']!=1:raise ValueError('Closed encrypted CLI schema required')
    if set(value)=={'schema','status'}and value['status']=='ENCRYPTION_UNAVAILABLE':return dict(value)
    if set(value)!={'schema','status','key_id','prefix_bytes','truncated','ciphertext_base64','ciphertext_sha256'}or value['status']!='ENCRYPTED_PREFIX'or value['key_id']!=key_id or type(value['prefix_bytes'])is not int or not 0<=value['prefix_bytes']<=384 or type(value['truncated'])is not bool:raise ValueError('Closed encrypted CLI prefix required')
    wire=value['ciphertext_base64']
    if type(wire)is not str or len(wire)!=684:raise ValueError('Fixed encrypted CLI encoding required')
    cipher=base64.b64decode(wire,validate=True)
    if len(cipher)!=512 or base64.b64encode(cipher).decode('ascii')!=wire or type(value['ciphertext_sha256'])is not str or re.fullmatch('[0-9a-f]{64}',value['ciphertext_sha256'])is None or hashlib.sha256(cipher).hexdigest()!=value['ciphertext_sha256']:raise ValueError('Fixed encrypted CLI fingerprint required')
    return dict(value)


class TronCLIProjection:
    """One existing harness scan. Text/Source coordinates are not execution proof."""
    def __init__(self,case,inputs,approval,required_inputs,bodies,sources,repo,private_requested=False):
        root=Path(case)/'tron-cli';fixture=inputs['tron_tre'];receipt=inputs['tron_cli']
        if fixture!=approval['tron_tre']or receipt!=approval['tron_cli']or receipt not in required_inputs or fixture['cli_directory']!=str(root)or root.is_symlink()or root.resolve()!=root or not isinstance(required_inputs,list)or len(required_inputs)>250000:raise ValueError('Already admitted owned CLI context required')
        tool=fixture['pnpm'];entry=fixture['cli_entrypoint']
        if tool not in required_inputs or Path(tool['path']).name!='pnpm-native'or entry not in required_inputs or entry['path']!=str(root/'dist/cli.js'):raise ValueError('Exact admitted CLI tool/entry required')
        program=bodies['rust/main/utils/run-locally/src/program.rs'];external=bodies['rust/main/utils/run-locally/src/external_agents.rs']
        if not all(n in program for n in [b'pub fn get_bin_name(',b'.file_name()',b'let name = self.get_bin_name()',b'println!("<{prefix}> {line}")',b'Error reading from output for {}: {}'])or b'.bin(fixture.pnpm.path)'not in external:raise ValueError('Exact CLI log prefix Source required')
        self.root=root;self.prefix=b'<'+Path(tool['path']).name.encode()+b'> ';self.rows=required_inputs;self.files={};self.fixed_sources={};self.total=0;self.state='not_started';self.starts=0;self.source_panic=False;self.qualified=False;self.headers=[];self.frames=[];self.seen=set();self.unadmitted=0;self.last_header=None;self.start_line=None;self.end_line=None;self.pipe_error=False;self.frame_attempts=0;self.frame_attempts_truncated=False
        self.reason='NO_QUALIFIED_WINDOW';self.frontier='WINDOW_SCAN';self.join_source=None;self.join_identity=None;self.join_count=0;self.join_pending=0;self.source_capture_failures=0
        try:wire=self.capture(entry['path'])
        except Exception as error:raise TronCLIProjectionError('ENTRY_SOURCE_CAPTURE_REJECTED')from error
        if not all(n in wire for n in [b'error.message',b"'Error: '",b'process.exit(1)']):raise TronCLIProjectionError('ENTRY_SOURCE_CONTRACT_REJECTED')
        # Already preadmitted Rust Source; missing/changed Source never grants a cascade.
        name='rust/main/utils/run-locally/src/utils.rs';path=Path(repo)/name
        try:
            raw,pin=captured_failure_bytes(path,1024**2)
            if sources[name]!={'path':str(path),**pin}or raw.splitlines()[81]!=b'        self.0.join().expect("Task thread panicked!")'or b'impl<T> TaskHandle for SimpleTaskHandle<T> {\n    type Output = T;\n\n    fn join(self) -> Self::Output {\n        self.0.join().expect("Task thread panicked!")\n    }'not in raw:raise ValueError('Exact helper join Source required')
            self.join_source={'module':name,'source':sources[name],'line':82,'column':23};self.join_identity=RelayerStartup.identity(path)
        except Exception:self.source_capture_failures=1

        self.private_requested=private_requested is True;self.private_error=None;self.private_error_truncated=False;self.private_window_refused=False
        self.cause=None;self.cause_reason='MARKER_NOT_OBSERVED';self.cause_seen=0;self.cause_contract=None;self.cause_identity=None;self.cause_path=None
        try:
            source=Path(repo)/'zig/bench/native_tron_assets.py';raw,source_pin=captured_failure_bytes(source,1024**2)
            matches=[row for row in required_inputs if row.get('path')==str(source)]
            if not matches or any(row!={'path':str(source),**source_pin}for row in matches):raise ValueError('Preadmitted CLI diagnostic Source required')
            names={'CLI_CAUSE_MARKER','CLI_CAUSE_KEY_ID','CLI_CAUSE_INSERT','CLI_ORIGINAL_OPEN','CLI_ORIGINAL_END','CLI_CATCH_OBSERVER','CLI_CATCH_BODY'};constants={}
            for node in ast.parse(raw).body:
                if isinstance(node,ast.Assign)and len(node.targets)==1 and isinstance(node.targets[0],ast.Name)and node.targets[0].id in names:
                    if node.targets[0].id in constants:raise ValueError('Unique CLI diagnostic constant required')
                    constants[node.targets[0].id]=ast.literal_eval(node.value)
            if set(constants)!=names or constants['CLI_CAUSE_MARKER']!='HYPERLANE_TRON_ENCRYPTED_V1 'or type(constants['CLI_CAUSE_KEY_ID'])is not str or re.fullmatch('[0-9a-f]{64}',constants['CLI_CAUSE_KEY_ID'])is None or type(constants['CLI_CAUSE_INSERT'])is not bytes or not 0<len(constants['CLI_CAUSE_INSERT'])<=4096:raise ValueError('Exact encrypted derivative Source required')
            for key in ['CLI_CAUSE_INSERT','CLI_ORIGINAL_OPEN','CLI_ORIGINAL_END']:
                if type(constants[key])is not bytes or not constants[key]or wire.count(constants[key])!=1:raise ValueError('One exact CLI derivative required')
            if type(constants['CLI_CATCH_OBSERVER'])is not bytes or type(constants['CLI_CATCH_BODY'])is not bytes or wire.count(constants['CLI_CATCH_OBSERVER']+b'\n'+constants['CLI_CATCH_BODY'])!=1:raise ValueError('Original catch fallback required')
            if sum(line in {b"import _args from 'yargs';",b'import _args from \"yargs\";'}for line in wire.splitlines())!=1:raise ValueError('Exact delegated Yargs import required')
            self.cause_contract={**constants,'pin':source_pin};self.cause_identity=RelayerStartup.identity(source);self.cause_path=source
        except Exception:self.cause_reason='DIAGNOSTIC_SOURCE_UNAVAILABLE'

    def capture(self,path):
        if path in self.files:return self.files[path]['wire']
        candidate=Path(path)
        if not(candidate.is_relative_to(self.root/'dist')or candidate.is_relative_to(self.root/'.workspace'))or candidate.suffix not in{'.js','.mjs','.cjs'}or'..'in candidate.parts or str(candidate)!=path:raise ValueError('Canonical emitted CLI JS only')
        rows=[row for row in self.rows if isinstance(row,dict)and row.get('path')==path]
        if not rows or any(row!=rows[0]for row in rows)or set(rows[0])!={'path','bytes','sha256'}or type(rows[0]['bytes'])is not int or not 0<rows[0]['bytes']<=1024**2 or len(self.files)>=8 or self.total+rows[0]['bytes']>4*1024**2:raise ValueError('Bounded already admitted emitted Source required')
        if candidate.is_symlink()or candidate.resolve()!=candidate or any(x.is_symlink()for x in candidate.parents if x.is_relative_to(self.root)):raise ValueError('Emitted Source links forbidden')
        wire,pin=captured_failure_bytes(candidate,1024**2)
        if rows[0]!={'path':path,**pin}:raise ValueError('Emitted Source changed')
        self.total+=len(wire);self.files[path]={'wire':wire,'fingerprint':pin,'identity':RelayerStartup.identity(candidate)};return wire

    def feed(self,clean,line,marker):
        panic=clean.startswith(b"thread '")and b' panicked at 'in clean
        if self.state=='join_pending':
            self.join_pending-=1
            if not panic and (clean==b'Task thread panicked!: Any { .. }'or not clean and self.join_pending>0):
                if clean:self.state='frozen';self.join_count=1;self.frontier='QUALIFIED_PRIMARY_WITH_JOIN_CASCADE';self.reason=None
                return
            self.state='ambiguous';self.qualified=False;self.reason='JOIN_CASCADE_MESSAGE_REJECTED';self.frontier='LATER_PANIC';return
        if self.state=='frozen'and panic:
            match=re.fullmatch(rb"thread '[^'\r\n]{1,128}'(?: \([0-9]{1,20}\))? panicked at ([^:\r\n]{1,4096}):([0-9]{1,7}):([0-9]{1,5}):[ \t]*(.*)",clean)
            if self.qualified and self.join_count==0 and self.join_source is not None and match is not None:
                path,row,column,tail=match.groups();relative=b'utils/run-locally/src/utils.rs';full=b'rust/main/'+relative
                if (path in{relative,full}or path.endswith(b'/'+full)or path.endswith(b'/'+relative))and int(row)==82 and int(column)==23:
                    self.frontier='LATER_PANIC';self.reason='JOIN_CASCADE_MESSAGE_UNQUALIFIED'
                    if tail==b'Task thread panicked!: Any { .. }':self.join_count=1;self.frontier='QUALIFIED_PRIMARY_WITH_JOIN_CASCADE';self.reason=None;return
                    if not tail:self.state='join_pending';self.join_pending=2;return
            self.state='ambiguous';self.qualified=False;self.reason='LATER_PANIC_AMBIGUITY';self.frontier='LATER_PANIC';return
        if marker is not None:
            if marker=='CORE_DEPLOY_FIRST_ENTERED':
                self.starts+=1
                if self.starts==1:self.state='open';self.start_line=line;self.frontier='WINDOW_OPEN'
                else:self.state='ambiguous';self.qualified=False;self.reason='DUPLICATE_FIRST_DEPLOY';self.frontier='WINDOW_SCAN'
            elif self.state=='open':self.state='closed';self.reason='DEPLOY_WINDOW_CLOSED';self.frontier='WINDOW_SCAN'
        if self.state!='open':return
        if panic:self.state='frozen';self.end_line=line;self.reason='PRIMARY_PANIC_UNQUALIFIED';self.frontier='PRIMARY_PANIC';return
        pipe=b'<E2E> Error reading from output for '+self.prefix[1:-2]+b': '
        if clean.startswith(pipe):self.pipe_error=True;return
        if not clean.startswith(self.prefix):return
        raw=clean[len(self.prefix):]
        if not raw or len(raw)>16384:
            if raw and self.private_requested and self.private_error is None:self.private_window_refused=True
            return
        # Only one printed line; JSON logger msg is accepted only if single-line.
        text=raw
        if raw.startswith(b'{'):
            try:
                obj=startup_unique_json(raw);message=obj.get('msg')
                if not isinstance(message,str)or'\n'in message or'\r'in message:
                    if self.private_requested and self.private_error is None:self.private_window_refused=True
                    return
                text=message.encode()
            except Exception:
                if self.private_requested and self.private_error is None:self.private_window_refused=True
                return
        try:message=text.decode('utf8','strict').strip()
        except UnicodeError:
            if self.private_requested and self.private_error is None:self.private_window_refused=True
            return
        if message.startswith('HYPERLANE_TRON_ENCRYPTED_V1 '):
            self.cause_seen+=1
            if self.cause_seen!=1:self.cause=None;self.cause_reason='AMBIGUOUS_DIAGNOSTIC_RECORD';return
            if self.cause_contract is None:return
            try:
                if len(text)>4096:raise ValueError('CLI diagnostic record bound')
                value=startup_unique_json(message[len('HYPERLANE_TRON_ENCRYPTED_V1 '):]);encrypted=tron_encrypted_prefix(value,self.cause_contract['CLI_CAUSE_KEY_ID'])
                if encrypted['status']=='ENCRYPTION_UNAVAILABLE':self.cause=None;self.cause_reason='ENCRYPTION_UNAVAILABLE'
                else:self.cause={'collection_status':'observed','encrypted_prefix':encrypted,'log_line':line,'typed_exception_or_root_cause_claim':False};self.cause_reason=None
            except Exception:self.cause=None;self.cause_reason='INVALID_DIAGNOSTIC_RECORD'
            return
        fixed={
            'Hyperlane Core deployment':('dist/src/commands/core.js',b'logCommandHeader',b'Hyperlane Core deployment','CORE_DEPLOY_HEADER'),
            'Running pre-flight checks for chains...':('dist/src/deploy/utils.js',b'log',b'Running pre-flight checks for chains...','PREFLIGHT_HEADER'),
            'Error: Empty chain selection':('dist/src/deploy/utils.js',b'Error',b'Empty chain selection','EMPTY_CHAIN_SELECTION_TEXT'),
            'Error: signer is invalid':('dist/src/deploy/utils.js',b'Error',b'signer is invalid','INVALID_SIGNER_TEXT'),
            'Error: Deployment cancelled':('dist/src/deploy/utils.js',b'Error',b'Deployment cancelled','DEPLOYMENT_CANCELLED_TEXT'),
        }
        if message in fixed:
            relative,call,needle,label=fixed[message]
            if relative not in self.fixed_sources:
                try:self.fixed_sources[relative]=self.capture(str(self.root/relative))
                except Exception:self.fixed_sources[relative]=b'';self.source_capture_failures=min(32,self.source_capture_failures+1)
            if any(re.search(rb'(?<![A-Za-z0-9_$])'+re.escape(call+b'('+quote+needle+quote+b')'),self.fixed_sources[relative])is not None for quote in(b"'",b'"',b'`')):self.last_header={'enum':label,'log_line':line,'observed_only':True}
        error_header=message.startswith('Error: ')or re.match(r'^Error \[[A-Z][A-Z_0-9]{1,63}\]:',message)is not None
        if error_header and self.private_requested and not self.private_window_refused and self.private_error is None:
            self.private_error=bytes(text[:4096]);self.private_error_truncated=len(text)>4096
        if error_header and len(self.headers)<8:
            row={'header':'CLI_ERROR_TEXT','bytes':len(text),'sha256':hashlib.sha256(text).hexdigest(),'typed_exception':False,'log_line':line}
            if not any(all(prior[key]==row[key]for key in('header','bytes','sha256'))for prior in self.headers):self.headers.append(row)
        if len(self.frames)>=8:
            if message.startswith('at '):self.frame_attempts_truncated=True
            return
        match=re.fullmatch(r'at (?:[^\r\n]{1,256} \()?((?:file://)?/[^()\r\n]{1,4096}\.(?:js|mjs|cjs)):([0-9]{1,7}):([0-9]{1,7})\)?',message)
        if match is None:return
        if self.frame_attempts>=32:self.frame_attempts_truncated=True;return
        self.frame_attempts+=1
        path=match[1]
        if path.startswith('file://'):path=path[7:]
        if '%'in path or'?'in path or'#'in path:return
        try:
            source=self.capture(path);row,column=int(match[2]),int(match[3]);lines=re.split(r'\r\n|[\n\r\u2028\u2029]',source.decode('utf8','strict'))
            if not 0<row<=len(lines)or not 0<column<=len(lines[row-1].encode('utf-16-le'))//2+1:raise ValueError('Valid emitted JS coordinate required')
            relative=Path(path).relative_to(self.root).as_posix();key=(relative,row,column)
            if key not in self.seen:
                self.seen.add(key);pin=self.files[path]['fingerprint'];self.frames.append({'source':relative,'line':row,'column':column,'source_bytes':pin['bytes'],'source_sha256':pin['sha256']})
        except Exception:self.unadmitted=min(2**32-1,self.unadmitted+1);self.source_capture_failures=min(32,self.source_capture_failures+1)

    def private_error_window(self):
        """Only first Source-tagged Error text after unchanged public qualification."""
        try:
            value=self.public()
            if self.private_window_refused or value.get('collection_status')!='observed'or self.cause_contract is None or RelayerStartup.identity(self.cause_path)!=self.cause_identity or not isinstance(self.private_error,bytes)or not 0<len(self.private_error)<=4096:return None
            return self.private_error,{'windows':[{'tag':'PNPM_NATIVE','position':'first_error','bytes':len(self.private_error),'truncated':self.private_error_truncated}],'oversized_lines_omitted':0,'scope':'First Source-tagged normalized Error header in the unique first-deploy/panic window only; no typed error or CLI PID attribution.'}
        finally:self.private_error=None

    def source_header(self,line):
        if self.state=='frozen'and self.starts==1 and line==self.end_line:self.source_panic=True

    def classify(self,item):
        if self.state=='frozen'and self.source_panic and self.starts==1 and item is not None and item.get('category')=='HYPERLANE_CORE_DEPLOY':self.qualified=True;self.reason=None;self.frontier='QUALIFIED_PRIMARY'

    def public(self):
        if not self.qualified or self.state!='frozen':return {**tron_cli_unavailable(self.reason or'NO_QUALIFIED_WINDOW',self.frontier),'join_source_status':'MATCHED'if self.join_source is not None else'UNAVAILABLE','source_capture_failures':self.source_capture_failures}
        if any(RelayerStartup.identity(Path(path))!=row['identity']for path,row in self.files.items()):raise ValueError('Emitted Source identity changed before publication')
        if self.join_count and RelayerStartup.identity(Path(self.join_source['source']['path']))!=self.join_identity:raise ValueError('Helper join Source changed before publication')
        caught=self.cause or{'collection_status':'unavailable','reason':self.cause_reason}
        if self.cause_contract is not None and RelayerStartup.identity(self.cause_path)!=self.cause_identity:caught={'collection_status':'unavailable','reason':'DIAGNOSTIC_SOURCE_CHANGED'}
        return {'schema':1,'kind':'public-Tron-CLI-failure-text-observation','caught_cause':caught,'caught_cause_scope':'Fixed encrypted-prefix marker on the original errorRed writer; original usage.fail delegate and outer catch preserved. Primitive/own-DATA message only, no stack/getter/toJSON access or unique PID/typed exception/root-cause credit.','frontier':self.frontier,'source_capture_failures':self.source_capture_failures,'known_join_cascade_count':self.join_count,'known_join_Source':{'module':self.join_source['module'],'line':82,'column':23,'source_bytes':self.join_source['source']['bytes'],'source_sha256':self.join_source['source']['sha256']}if self.join_count else None,'collection_status':'observed','window':{'stage':'CORE_DEPLOY_FIRST_ENTERED','start_log_line':self.start_line,'end_log_line':self.end_line,'matched_Source_panic_category':'HYPERLANE_CORE_DEPLOY'},'prefix_kind':'admitted_pnpm_native_basename','last_seen_header':self.last_header,'error_header_fingerprints':self.headers,'emitted_JS_coordinates':self.frames,'unadmitted_coordinates_omitted':self.unadmitted,'frame_candidates_truncated':self.frame_attempts_truncated,'CLI_pipe_read_error_observed':self.pipe_error,'CLI_numeric_status':None,'native_or_timing_or_cleanup_authority':False,'scope':'Exact prefixed text within one Source first-deploy/panic window only. Source bytes/UTF16 coordinates matched existing admitted JS descriptors, not unique execution/PIDepoch/typed exception or parent wait. Original CLI output/error/exit flow preserved; derivative adds only bounded RSA-OAEP ciphertext. Plaintext and underlying cause remain unavailable here. No TS/sourcemap claim, function/address/rawpath/key/URL/argv/env/body/error text.'}
