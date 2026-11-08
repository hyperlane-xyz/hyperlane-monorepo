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
