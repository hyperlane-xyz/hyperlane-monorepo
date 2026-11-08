"""Explicit image/tool provisioning outside the actual Docker probe clock."""
import argparse,hashlib,json,os,platform,signal,subprocess,sys,time
from pathlib import Path
HERE=Path(__file__).resolve().parent
for source_dir in (HERE,HERE.parent/'aleo_linux',HERE.parent/'aleo_linux_sdk'):
 if(source_dir/'__pycache__').exists()or(source_dir/'__pycache__').is_symlink():raise ValueError('Docker profile forbids cached local bytecode')
sys.path.insert(0,str(HERE))
from sibling_imports import load_shared,load_exact_source,SHARED
load_shared()
from receipts import checked,load,need
from docker_probe import IMAGES,pin,write,free,GIB,MIB
PURPOSE='aleo-linux-native-docker-stage-v1'
CAPS={'whole_seconds':1200,'maximum_process_memory_bytes':256*MIB,'new_disk_bytes':8*GIB,'free_floor_bytes':6*GIB}
def approved(s):
 need(s.get('schema')==1 and s.get('root_approved')is True and s.get('purpose')==PURPOSE and s.get('images')==IMAGES,'explicit exact image stage required')
 need(s.get('caps')==CAPS,'fixed separate provision limits required')
 for n in ('node','docker','owner'):checked(s[n])
 for p in s['pins']:checked(p)
 need(pin(__file__)in s['pins'],'exact provision Source required');return s

def require_original_deadline(deadline):
 need(time.monotonic_ns()<deadline,'original staging deadline expired before publication')

def run(spec_pin):
 s=approved(load(spec_pin));need(platform.system()=='Linux'and platform.machine()=='x86_64','native Linux amd64 provision only');root=Path(s['output']);need(root.is_absolute()and root.parent.resolve()==root.parent and not root.exists(),'new canonical stage output required');need(free(root.parent)>=14*GIB,'14GiB staging preflight margin');root.mkdir(mode=0o700)
 config=root/'docker-config';config.mkdir(mode=0o700);(config/'config.json').write_text('{}\n');env={'PATH':'/usr/bin:/bin','LC_ALL':'C.UTF-8','DOCKER_HOST':'unix:///var/run/docker.sock','DOCKER_CONFIG':str(config)}
 p=checked(s['owner']);owner=load_exact_source(p,s['owner']['sha256'],'explicit_stage_owner');owner.enable_subreaper()
 start=time.monotonic_ns();deadline=start+1200*10**9;baseline=free(root);rows=[];result={'schema':1,'kind':PURPOSE,'passed':False,'spec':spec_pin,'started_monotonic_ns':start,'original_deadline_ns':deadline,'commands':rows,'actual_native_Docker_probe_credit':False};old={}
 def interrupted(sig,frame):raise owner.TaskInterrupted('explicit Docker prerequisite staging interrupted')
 for sig in (signal.SIGINT,signal.SIGTERM):old[sig]=signal.signal(sig,interrupted)
 def command(label,argv):
  child=None;known={};groups={};cleanup=None;peak=0;error=None;log=root/(label+'.log')
  try:
   with log.open('xb')as stream:child=subprocess.Popen(argv,env=env,stdin=subprocess.DEVNULL,stdout=stream,stderr=subprocess.STDOUT,start_new_session=True)
   groups[child.pid]=child.pid
   while True:
    active=owner.owned_processes(owner.processes(),child.pid,known,groups,True);peak=max(peak,sum(r['rss_bytes']for r in active.values()))
    need(peak<=256*MIB and free(root)>=6*GIB and baseline-free(root)<=8*GIB and log.stat().st_size<=2*MIB,'actual staging memory/disk/floor/log cap')
    need(time.monotonic_ns()<deadline,'original staging deadline')
    if os.waitid(os.P_PID,child.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT)is not None:break
    time.sleep(.1)
  except BaseException as e:error=type(e).__name__
  finally:
   if child is not None:
    for sig in old:signal.signal(sig,signal.SIG_IGN)
    try:cleanup=owner.stop_owned(child,known,groups)
    finally:
     for sig in old:signal.signal(sig,interrupted)
   rows.append({'name':label,'argv':argv,'exit_code':None if child is None else child.returncode,'actual_parent_wait':bool(cleanup and cleanup.get('actual_parent_wait')),'cleanup':cleanup,'peak_owned_RSS_bytes':peak,'error_type':error,'log':pin(log),'completed_monotonic_ns':time.monotonic_ns()})
  need(error is None and child is not None and child.returncode==0 and cleanup['clean']and not cleanup['signals'],'actual staging command/owned wait/cleanup failed')
  return log.read_bytes()
 try:
  need(command('node-version',[str(checked(s['node'])),'--version']).strip()==b'v26.12.1','actual pinned Node version differs')
  info=json.loads(command('native-engine-info',[str(checked(s['docker'])),'info','--format','{"ID":{{json .ID}},"OSType":{{json .OSType}},"Architecture":{{json .Architecture}},"DockerRootDir":{{json .DockerRootDir}}}']));need(info['OSType']=='linux'and info['Architecture']=='x86_64'and info['ID'],'native Engine required')
  filesystem=Path(info['DockerRootDir']);need(filesystem.stat().st_dev==root.stat().st_dev,'daemon staging filesystem must match observed free-space filesystem')
  images={}
  for name,row in IMAGES.items():
   command(name+'-pull',[str(checked(s['docker'])),'pull','--platform','linux/amd64',row['reference']])
   parsed=json.loads(command(name+'-inspect',[str(checked(s['docker'])),'image','inspect','--format','{"Id":{{json .Id}},"RepoDigests":{{json .RepoDigests}},"Os":{{json .Os}},"Architecture":{{json .Architecture}},"Size":{{json .Size}}}',row['reference']]));need(isinstance(parsed,dict),'exact public image inspect required');v=parsed
   need(v['Id']==row['id']and row['reference']in v['RepoDigests']and v['Os']=='linux'and v['Architecture']=='amd64','actual native immutable config/manifest differs')
   need(type(v['Size'])is int and 0<v['Size']<=8*GIB,'bounded actual native image size required')
   images[name]={'id':v['Id'],'reference':row['reference'],'os':v['Os'],'architecture':v['Architecture'],'actual_size_bytes':v['Size']}
  need(sum(v['actual_size_bytes']for v in images.values())<=8*GIB,'conservative total image-size cap')
  for p in s['pins']:checked(p)
  checked(s['node']);checked(s['docker']);checked(s['owner']);require_original_deadline(deadline)
  result.update(passed=True,node=s['node'],native_engine={'id':info['ID'],'filesystem':str(filesystem)},images=images,source_unchanged=True,daemon_images_retained_as_explicit_prerequisites=True)
 except BaseException as e:result['error_type']=type(e).__name__
 finally:
  for sig,h in old.items():signal.signal(sig,h)
  result['completed_monotonic_ns']=time.monotonic_ns();write(root/'stage-result.json',result)
 return 0 if result['passed']else 1
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--spec',required=True);p.add_argument('--spec-sha256',required=True);a=p.parse_args();q=Path(a.spec);need(pin(q)['sha256']==a.spec_sha256,'immutable stage specification required');raise SystemExit(run(pin(q)))
