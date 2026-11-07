"""Bounded public observer diagnostics; no messages, request data or proof credit."""
from pathlib import Path
import copy
import hashlib
import json
import os
import re
import threading

STAGES={'preflight','live','before_restart','after_restart','restart','final','sampler','transport','restart_approval','restart_canonical','restart_identity','restart_readiness','restart_checkpoints','restart_continuous'}
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


def rust_panic_sites(log,sources,repo):
    """Bounded source-location extraction; never emits a panic message or thread."""
    path=Path(log);info=path.stat()
    if info.st_size>32*1024**2:raise ValueError('Bounded local harness log required')
    approved={}
    for name,row in sources.items():
        if len(approved)>=256:break
        if not re.fullmatch(r'rust/main/utils/run-locally/src/[A-Za-z0-9_./-]+\.rs',name)or'..'in Path(name).parts:continue
        source=Path(repo)/name
        if pin(source)==row:approved[name]=row
    output=[];seen=set()
    with path.open('rb')as stream:
        for line in stream:
            if len(line)>65536:continue
            # Matching a source suffix is intentional: build-host absolute paths
            # differ; only an exact pinned repository module may become output.
            text=line.decode('utf-8','replace')
            text=re.sub(r'\x1b\[[0-9;]*m','',text)
            if re.match(r"^thread '[^'\r\n]{1,128}' panicked at ",text)is None:continue
            for match in re.finditer(r'((?:rust/main/)?utils/run-locally/src/[A-Za-z0-9_./-]+\.rs):(\d{1,7}):(\d{1,5})(?=[:\s])',text):
                name,line_,column=match.groups();name=name if name.startswith('rust/main/')else'rust/main/'+name;identity=(name,int(line_),int(column))
                if name not in approved or identity in seen:continue
                source=Path(repo)/name
                if not 0<identity[1]<=len(source.read_bytes().splitlines())or identity[2]==0:continue
                seen.add(identity);output.append({'module':name,'source':dict(approved[name]),'line':identity[1],'column':identity[2]})
                if len(output)>=8:return output
    return output


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
