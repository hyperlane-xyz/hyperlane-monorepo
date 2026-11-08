"""Fixed Aleo namespace entry; all SDK isolates remain inside this one jail."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time

HERE=Path(__file__).resolve().parent
for code_root in (HERE,HERE.parent/'aleo_linux',HERE.parent/'aleo_linux_sdk'):
    if(code_root/'__pycache__').exists()or(code_root/'__pycache__').is_symlink():raise ValueError('full-case profile forbids cached local Python bytecode')
sys.path.insert(0,str(HERE.parent/'aleo_linux'))
sys.path.insert(0,str(HERE))
from receipts import checked, clock_bridge, decode, load, need
from loopback_bridge import FixedServer, PORTS
from bridge_close import close_bridge_bounded


def run(spec_pin):
    spec=load(spec_pin,32*1024**2);parent=load(spec['parent_spec'],32*1024**2)
    need(parent.get('schema')==1 and parent.get('root_approved')is True and parent.get('purpose')=='actual-aleo-linux-case-v1','actual original case authorization required')
    clock=load(spec['deadline_receipt'])
    need(clock['approved_plan']==spec['parent_spec']and clock['python_deadline_ns']==clock['python_started_ns']+10800*10**9 and spec['original_deadline_ns']==clock['python_deadline_ns'],'one original Python3h deadline required')
    policy=load(spec['policy'])
    bridge=clock_bridge(clock['python_deadline_ns'],clock['python_before_ns'],clock['python_after_ns'],clock['node_sample_ns'])
    need(all(policy[key]==value for key,value in bridge.items()),'conservative original Python/Node deadline bridge differs')
    for pin in spec['pins']:checked(pin)
    control=Path(policy['root']);bridges=[];children=[];streams=[];records=[];slots=threading.BoundedSemaphore(32);cancelled=threading.Event()
    result={'schema':1,'passed':False,'actual_waits':[],'bridge_records':records,'signals':[],'SDK_or_native_credit_from_inner_alone':False}
    def interrupt(signum,_frame):cancelled.set();result['signals'].append(signum)
    for signum in (signal.SIGINT,signal.SIGTERM):signal.signal(signum,interrupt)
    def launch(label,argv):
        need(time.monotonic_ns()<spec['original_deadline_ns']and not cancelled.is_set(),'original case interrupted/deadline')
        stdout=(control/(label+'.stdout')).open('xb');stderr=(control/(label+'.stderr')).open('xb');streams.extend((stdout,stderr))
        env={'PATH':'/usr/bin:/bin','HOME':str(control/'home'),'TMPDIR':str(control/'tmp'),'LANG':'C.UTF-8','LC_ALL':'C.UTF-8','PYTHONNOUSERSITE':'1','PYTHONDONTWRITEBYTECODE':'1'}
        process=subprocess.Popen(argv,env=env,stdout=stdout,stderr=stderr,close_fds=True)
        children.append((label,process));return process
    try:
        need(os.getpid()==1,'private namespace PID1 required')
        for path in (control/'home',control/'tmp',control/'errors'):path.mkdir(mode=0o700,exist_ok=True)
        for port in PORTS:
            server=FixedServer(spec['capability_root'],port,False,None,spec['original_deadline_ns'],slots,records.append);bridges.append(server);server.start()
        cache=launch('cache',[str(checked(spec['python'])),'-I','-B',str(checked(spec['cache_server'])),spec['policy']['path'],spec['policy']['sha256']])
        ready_until=min(spec['original_deadline_ns'],time.monotonic_ns()+10*10**9)
        while not (control/'cache-ready.json').exists():need(cache.poll()is None and time.monotonic_ns()<ready_until,'closed cache not ready');time.sleep(.05)
        # Same immutable launcher/bootstrap as final42, not the raw TS driver.
        main=launch('node-case',spec['exact_node_argv'])
        while main.poll()is None:
            need(not cancelled.is_set()and time.monotonic_ns()<spec['original_deadline_ns'],'original case cancelled/deadline')
            need(cache.poll()is None and not any(row.get('failure')for row in records),'cache/byte bridge failed')
            need(not any((control/'errors').iterdir()),'latched all-isolate policy violation')
            time.sleep(.1)
        code=main.wait();result['actual_waits'].append({'role':'case-main','pid':main.pid,'actual_parent_wait':True,'exit_code':code});need(code==0,'actual Node Aleo case failed')
        manifest=load(parent['manifest'])
        actual=decode(Path(manifest['taskRoot'],'result.json').read_bytes())
        need(actual.get('passed')is True and actual.get('errors')==[],'actual dedicated Aleo final proof failed')
        # PID1 reaps actual adopted terminal helpers; a live unregistered helper
        # is never killed into a successful case.
        direct={process.pid for _,process in children}
        for item in Path('/proc').iterdir():
            if not item.name.isdigit()or int(item.name)in direct|{1}:continue
            try:raw=(item/'stat').read_text()
            except FileNotFoundError:continue
            values=raw[raw.rfind(')')+2:].split()
            need(values[0]in {'Z','X'},'live namespace helper remains after Node close')
            pid,status=os.waitpid(int(item.name),os.WNOHANG);need(pid==int(item.name),'adopted helper not reaped')
            result['actual_waits'].append({'role':'actual-adopted-helper','pid':pid,'actual_waitpid':True,'raw_status':status,'exit_code':os.waitstatus_to_exitcode(status)})
            need(os.waitstatus_to_exitcode(status)==0,'adopted helper failed')
        result['passed']=True
    except BaseException as error:result['error']=type(error).__name__+':'+str(error)
    finally:
        cleanup_deadline=time.monotonic_ns()+45*10**9
        for label,process in reversed(children):
            try:
                if process.poll()is None:
                    if label!='cache':result['passed']=False;result['signals'].append({'pid':process.pid,'signal':'TERM'})
                    process.terminate()
                    try:process.wait(timeout=10)
                    except subprocess.TimeoutExpired:process.kill();process.wait(timeout=3);result['passed']=False;result['signals'].append({'pid':process.pid,'signal':'KILL'})
                if not any(row.get('pid')==process.pid for row in result['actual_waits']):result['actual_waits'].append({'role':label,'pid':process.pid,'actual_parent_wait':True,'exit_code':process.wait()})
                if process.returncode!=0:result['passed']=False
            except BaseException as error:result['passed']=False;result.setdefault('cleanup_errors',[]).append('child:'+type(error).__name__)
        for server in reversed(bridges):
            try:close_bridge_bounded(server,min(cleanup_deadline,time.monotonic_ns()+5*10**9))
            except Exception as error:result['passed']=False;result.setdefault('cleanup_errors',[]).append(str(error))
        for stream in streams:
            try:stream.close()
            except BaseException as error:result['passed']=False;result.setdefault('cleanup_errors',[]).append('stream:'+type(error).__name__)
        try:
            for pin in spec['pins']:checked(pin)
        except Exception as error:result['passed']=False;result['inputs_changed']=str(error)
        result['passed']=result['passed']and not any(row.get('failure')for row in records)and not any((control/'errors').iterdir())
        (control/'inner-result.json').write_text(json.dumps(result,indent=2)+'\n')
    return 0 if result['passed']else 1


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--spec',required=True);parser.add_argument('--spec-sha',required=True);args=parser.parse_args()
    path=Path(args.spec);raw=path.read_bytes()
    import hashlib
    need(hashlib.sha256(raw).hexdigest()==args.spec_sha,'immutable inner spec changed')
    return run({'path':str(path),'bytes':len(raw),'sha256':args.spec_sha})


if __name__=='__main__':raise SystemExit(main())
