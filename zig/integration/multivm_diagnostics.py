"""Bounded public observer diagnostics; no messages, request data or proof credit."""
from pathlib import Path
import copy
import hashlib
import io
import json
import os
import re
import stat
import threading

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


def rust_panic_observation(log,sources,repo):
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
        if not re.fullmatch(r'rust/main/utils/run-locally/src/[A-Za-z0-9_./-]+\.rs',name)or'..'in Path(name).parts:continue
        source=Path(repo)/name;body,actual=capture(source,1024*1024)
        if actual==row:approved[name]=dict(row);bodies[name]=body
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
    return {'sites':output,'reason_codes':sorted(reasons),'reason_source':authority,'log_fingerprint':fingerprint}



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



def role_failure_observation(case,manifest,parent_pid,sources,repo,harness_log,zig_sources):
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
    harness_prefixes={**prefixes,**({'SCR':'scraper'}if manifest['scenario']=='sealevel'else{})}
    harness_prefixes={prefix:role for prefix,role in harness_prefixes.items()if any(row['role']==role for row in owned)}
    try:raw,fingerprint=captured_failure_bytes(harness_log,32*1024**2)
    except Exception:
        logs.extend({'role':role,'fixed_log':'harness.log prefix '+prefix,'status':'unavailable','exact_pid_or_epoch_attribution':False}for prefix,role in harness_prefixes.items())
    else:
        source_frames=zig_role_source_frames(raw,harness_prefixes,zig_sources,repo)
        logs.extend({'role':role,'fixed_log':'harness.log prefix '+prefix,'status':'captured',**fingerprint,'finite_observed_flags':flags(raw,prefix.encode()),'stream_scope':'merged_prefixed_stdout_and_stderr','Source_frames':source_frames.get(prefix,[]),'exact_pid_or_epoch_attribution':False}for prefix,role in harness_prefixes.items())
    return {'schema':1,'kind':'public-SVM-role-failure-observation','writer_sources':writer_sources,'owned_child_journal':owned_pin,'parent_exit_journal':exit_pin,'roles':public,'fixed_role_logs':logs,'scope':'Actual existing parent wait records joined to admitted owned-child epochs/products. Fixed role files contain stdout only; harness prefixes merge stdout and stderr. Finite flags and bounded admitted Zig coordinates; no std/foreign frames, stderr-only or original metrics HTTP/error attribution. Logs may contain multiple role epochs. Zig relative coordinates are matched to admitted captured Source; no function/address/rawpath/message or unforgeable execution claim.','native_or_timing_or_cleanup_authority':False}



def fixture_failure_observation(case,manifest,approval,parent_pid,sources,repo,harness_log):
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
        literals={b'owned Radix Core/Gateway startup deadline':'CORE_GATEWAY_STARTUP_DEADLINE',b'Radix Core readiness belongs to another native network':'CORE_NETWORK_MISMATCH',b'Radix Gateway readiness has no local committed ledger':'GATEWAY_LEDGER_MISSING',b'Radix Docker command exceeded time/output bound':'DOCKER_TIME_OR_OUTPUT_BOUND',b'Radix Docker output bound':'DOCKER_OUTPUT_BOUND',b'Radix fixture network is not owned and isolated from external networks':'NETWORK_CUSTODY_GUARD',b'Radix Compose service coverage differs':'SERVICE_COVERAGE_GUARD',b'actual Radix service resource bounds differ':'SERVICE_RESOURCE_GUARD',b'Radix container owner/image differs':'CONTAINER_CUSTODY_GUARD',b'Radix inspect coverage differs':'INSPECT_COVERAGE_GUARD',b'Radix service container replaced':'CONTAINER_REPLACED_GUARD'}
        guards={literal:category for literal,category in literals.items()if b'"'+literal+b'"'in bodies[fixture]}
        if len(guards)!=len(literals)or b'"Radix Docker command failed ({status})"'not in bodies[fixture]:raise ValueError('Radix static guard Source changed')
    result={'schema':1,'kind':'public-fixed-fixture-failure-observation','scenario':scenario,'writer_sources':checked_sources,'harness_log_fingerprint':log_pin,'last_seen_stage':None,'panic_observations':[],'client_waits':None,'native_or_timing_or_cleanup_authority':False,'scope':'Source marker and finite panic-category observations only. Last seen is not stage success. No arbitrary error/command text, numeric Program status, root-cause, direct container wait or proof claim.'}
    pending=None;observations=[];seen=set();lines_scanned=0
    def classify(body,context):
        if context=='radix':
            if body.startswith(b'actual owned Radix localnet:'):body=body[len(b'actual owned Radix localnet:'):].strip()
            body=re.sub(rb'^[0-9]{1,2}: ',b'',body)
            label=guards.get(body)
            if label is not None:return {'category':label}
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
        if len(raw)>65536:pending=None;continue
        clean=re.sub(rb'\x1b\[[0-9;]*m',b'',raw).strip()
        if clean in markers:result['last_seen_stage']={'category':markers[clean],'log_line':lines_scanned,'observed_only':True}
        header=re.match(rb"^thread '[^'\r\n]{1,128}'(?: \([0-9]{1,20}\))? panicked at ([^:\r\n]{1,4096}):([0-9]{1,7}):([0-9]{1,5}):\s*(.*)$",clean)
        if header is not None:
            pending=None;path,line,column,tail=header.groups();line,column=int(line),int(column)
            target=program if scenario=='tron'else caller;relative=target[len('rust/main/'):].encode();full=target.encode()
            if not(path in {relative,full}or path.endswith(b'/'+relative)or path.endswith(b'/'+full)):continue
            source_lines=bodies[target].splitlines()
            if not 0<line<=len(source_lines)or column==0:continue
            snippet=b'\n'.join(source_lines[line-1:min(line+4,len(source_lines))]);required=b'Command returned non-zero exit code: {:?}'if scenario=='tron'else b'panic!("actual owned Radix localnet: {error:#}")'
            if required not in snippet or(scenario=='tron'and source_lines[line-1].strip()!=b'assert!(')or(scenario=='radix'and required not in source_lines[line-1]):continue
            pending={'context':scenario,'remaining':16,'source':target,'line':line,'column':column}
            if tail:
                item=classify(tail,pending['context'])
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
        if item is not None:
            key=(item['category'],context['source'],context['line'],context['column'])
            if key not in seen and len(observations)<16:seen.add(key);observations.append({**item,'source':context['source'],'line':context['line'],'column':context['column']})
    result['panic_observations']=observations
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


RELAYER_STARTUP_EPOCH = '4c0df031d53df423b779194cf1f8ac4c0788bef7'
RELAYER_STARTUP_SOURCE = (
    ('zig/src/service_main.zig', 15117, 'e15bec2398d71a70a3b0a16ea26fe756' + '70751c6fc579d4eacd7e8d3d17d50db3'),
    ('zig/src/agents/relayer_task.zig', 153439, '768e6eca02149602e28d15caa7955a9c' + '58c7912665c5f49b9ab9da0e81ce9e73'),
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
)


def startup_metric_projection(raw, chains):
    """Fixed numeric families only. Never persist response labels or text."""
    import math
    import decimal
    if not isinstance(raw,bytes) or len(raw)>1024**2 or not isinstance(chains,tuple) or not 0<len(chains)<=8 or len(set(chains))!=len(chains) or any(not isinstance(x,str) or re.fullmatch('[A-Za-z0-9_-]{1,64}',x)is None for x in chains):raise ValueError('Bounded selected startup metrics required')
    targets={'destination_mailbox':('hyperlane_chain_init_latency',{'role':'destination','entity':'mailbox'}),'destination_dispatcher':('hyperlane_chain_init_latency',{'role':'destination','entity':'dispatcher_and_entrypoint'}),'block_height':('hyperlane_block_height',{}),'wallet_balance':('hyperlane_wallet_balance',{'wallet_name':'relayer'}),'critical_error':('hyperlane_critical_error',{})}
    families={name:False for name,_ in targets.values()};samples={};seen=set()
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
        for index,chain in enumerate(chains):
            if labels.get('chain')!=chain:continue
            for key,(name,required)in targets.items():
                if name==family and all(labels.get(k)==value for k,value in required.items()):
                    values=samples.setdefault((index,key),[])
                    if len(values)>=16:raise ValueError('Bounded selected startup samples required')
                    values.append(number)
    return [{'chain_index':index,'metrics':{key:{'family_present':families[name],'selected_present':bool(samples.get((index,key))),'series_count':len(samples.get((index,key),[])),'finite_values':samples.get((index,key),[])}for key,(name,_)in targets.items()}}for index in range(len(chains))]


def startup_header_projection(raw, sources):
    """Text-header observations, never typed exception or lane attribution."""
    if not isinstance(raw,bytes)or len(raw)>32*1024**2:raise ValueError('Bounded existing harness capture required')
    known=set()
    for source in sources.values():
        known.update(x.decode()for x in re.findall(rb'\berror\.([A-Za-z][A-Za-z0-9_]{0,63})\b',source))
    if len(known)>2048:raise ValueError('Bounded Source error-name catalog required')
    rows=[];counts={'supervised_task_failed':0,'health_warning':0,'agent_stopped':0}
    for line in io.BytesIO(raw):
        if len(line)>16384:continue
        clean=re.sub(rb'\x1b\[[0-9;]*m',b'',line).strip()
        match=re.fullmatch(rb'<RLY> (?:warning|warn): task ([0-9]{1,3}) failed: ([A-Za-z][A-Za-z0-9_]{0,63})',clean)
        kind=None;index=None;name=None
        if match is not None and int(match[1])<=255:kind='supervised_task_failed';index=int(match[1]);name=match[2].decode()
        else:
            match=re.fullmatch(rb'<RLY> (?:warning|warn): Common health metric update failed: ([A-Za-z][A-Za-z0-9_]{0,63})',clean)
            if match is not None:kind='health_warning';name=match[1].decode()
            else:
                match=re.fullmatch(rb'<RLY> error: agent stopped: ([A-Za-z][A-Za-z0-9_]{0,63})',clean)
                if match is not None:kind='agent_stopped';name=match[1].decode()
        if kind is not None:
            counts[kind]=min(2**32-1,counts[kind]+1)
            row={'header':kind,'task_index':index,'Source_error_name':name if name in known else None,'error_name_status':'Source_literal'if name in known else'unknown','lane_attribution':None}
            if row not in rows and len(rows)<16:rows.append(row)
    return {'counts':counts,'observations':rows,'scope':'Fixed RLY-prefixed text only; no typed exception, task-to-lane, unique PID/epoch or readiness claim.'}


class RelayerStartup:
    """Diagnostic state only. Source is captured once; clocks never renewed."""
    def __init__(self,repo,manifest,modules):
        if manifest.get('scenario')not in{'evm','starknet'}or manifest.get('runtime_source_commit')!=RELAYER_STARTUP_EPOCH:raise ValueError('Exact startup producer epoch required')
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
        return {'schema':1,'kind':'public-EVM-Stark-relayer-startup-observation','last_probe':self.last,'fixed_harness_headers':startup_header_projection(raw,self.sources),'harness_log_fingerprint':fingerprint,'Source_epoch':RELAYER_STARTUP_EPOCH,'Source_contracts':[{'path':name,'bytes':size,'sha256_hex_chunks':[digest[:32],digest[32:]]}for name,size,digest in RELAYER_STARTUP_SOURCE],'native_or_timing_or_cleanup_authority':False,'scope':'Bounded read-only observations of an actual owned wildcard relayer listener via fixed numeric loopback.405 only proves installed messages handler;404/absence unknown.0 metric is not absence. No ccipSigners/critical0 readiness, raw labels/address/error/config/env/token or inferred lane.'}



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
