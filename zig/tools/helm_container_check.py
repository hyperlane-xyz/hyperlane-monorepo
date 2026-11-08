#!/usr/bin/env python3
"""Actual rendered Helm overrides on disposable Docker fixtures; never Kubernetes."""
from pathlib import Path
import argparse,hashlib,json,os,re,shutil,stat,subprocess,tempfile,time,types
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
PROFILE_TEMPLATE='''{{- $role := .Values.fixtureRole -}}
{{- $state := include (print $.Template.BasePath "/" $role "-statefulset.yaml") . | fromYaml -}}
{{- $common := include (print $.Template.BasePath "/configmap.yaml") . | fromYaml -}}
{{- $validator := dict -}}
{{- if eq $role "validator" -}}{{- $validator = include (print $.Template.BasePath "/validator-configmap.yaml") . | fromYaml -}}{{- end -}}
{{- dict "apiVersion" "v1" "kind" "ConfigMap" "metadata" (dict "name" "fixture-launch") "data" (dict "profile" (dict "statefulset" $state "common" $common "validator" $validator | toJson)) | toJson -}}
'''
ROLES=('relayer','validator','scraper')
def need(ok,message):
 if not ok:raise AssertionError(message)
def pin(path):
 path=Path(path);raw=path.read_bytes();return {'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
def absent_receipt(result,target):
 need(result.returncode==1 and result.stdout.strip()=='[]'and result.stderr.strip()in('Error: No such object: '+target,'Error response from daemon: No such container: '+target,'Error response from daemon: No such image: '+target),'exact Docker not-found response required')
 return {'negative_inspect_exit':result.returncode,'absence_error_kind':'exact_owned_target_not_found','owned_container_absent':True}
def load_checker():
 # Execute exactly read local Source, never a timestamp-compatible __pycache__.
 path=HERE/'container_check.py';raw=path.read_bytes();module=types.ModuleType('helm_checked_container');module.__file__=str(path)
 exec(compile(raw,str(path),'exec'),module.__dict__);return module

def observe_created(c,argv,name,image,labels):
 reply=None;primary=None
 try:reply=c.command(argv)
 except BaseException as error:primary=error
 try:
  observed=c.command(['docker','inspect',name]);need(observed.returncode==0,'created CID cannot be independently observed')
  v=json.loads(observed.stdout)[0];need(re.fullmatch('[0-9a-f]{64}',v['Id'])and v['Name']=='/'+name and v['Image']==image['Id']and v['Config'].get('Labels')==labels,'exact created CID identity')
 except BaseException as resolution:
  if primary is not None:primary.add_note('owned create resolution failed: '+type(resolution).__name__);raise primary
  raise
 return reply,v,primary
def configured_recipe(base):
 need(type(base)is str and re.fullmatch('[A-Za-z0-9][A-Za-z0-9._/:@+-]*',base),'closed local image reference')
 return 'FROM '+base+'\nUSER 0:0\nCOPY --chown=0:0 defaults/ /etc/hyperlane/\nRUN chmod 0555 /etc/hyperlane && chmod 0444 /etc/hyperlane/*.json\nUSER 10001:10001\n'
def configured_lineage(base,derived,after_base):
 need(base['Id']==after_base['Id'],'qualified local base tag changed')
 layers=base['RootFS']['Layers'];actual=derived['RootFS']['Layers']
 need(layers and len(actual)>len(layers)and actual[:len(layers)]==layers,'configured rootfs must extend actual qualified base layers')
 for key in ('User','WorkingDir','Entrypoint','Cmd','Env','Labels','Volumes','StopSignal'):
  need(derived['Config'].get(key)==base['Config'].get(key),'configured image changed runtime configuration')
 return True
def decode_profile(text):
 body='\n'.join(x for x in text.splitlines()if x!='---'and not x.startswith('#'))
 v=json.loads(body);need(v.get('kind')=='ConfigMap'and set(v['data'])=={'profile'},'unexpected Helm fixture wrapper')
 return json.loads(v['data']['profile'])
def validate_profile(value,role,mode):
 need(role in ROLES and mode in ('configmap','configured-image'),'closed fixture family')
 spec=value['statefulset']['spec']['template']['spec'];a=spec['containers'][0]
 need(a['name']=='agent'and a['securityContext']=={'runAsNonRoot':True,'runAsUser':10001,'runAsGroup':10001}and spec['securityContext']['fsGroup']==2000,'rendered nonroot identities')
 if role=='validator':
  need(a['command']==['/bin/sh','-c']and len(a['args'])==1 and a['args'][0].endswith('/opt/hyperlane/bin/validator\n'),'rendered validator wrapper')
 else:need(a['command']==['/opt/hyperlane/bin/'+role]and not a.get('args'),'rendered role command')
 need(spec['terminationGracePeriodSeconds']==10 and 'workingDir'not in a,'rendered workdir/grace')
 mounts=[r for r in a.get('volumeMounts',[])if r['name']=='agent-defaults']
 if mode=='configmap':need(mounts==[{'name':'agent-defaults','mountPath':'/etc/hyperlane','readOnly':True}],'rendered readonly defaults')
 else:need(not mounts,'configured image must not mask baked defaults')
 env=value['common']['data'];need(env['HOME']=='/var/lib/hyperlane','rendered HOME')
 return spec,a,env

def render(c,root,helm,role,mode,db,folder):
 chart=folder/'chart';shutil.copytree(root/'rust/main/helm/hyperlane-agent',chart,ignore=shutil.ignore_patterns('charts'))
 common=folder/'agent-common';shutil.copytree(root/'rust/main/helm/agent-common',common)
 # Local dependency reference remains exactly ../agent-common.
 (chart/'templates/fixture-launch.yaml').write_text(PROFILE_TEMPLATE)
 values={'fixtureRole':role,'hyperlane':{'chains':[],'relayerChains':[],'dbPath':db,'metrics':{'port':0},'validator':{'enabled':role=='validator','configs':[{'originChainName':'containerfixture','chainSigner':{},'validator':{'type':'hexKey'},'checkpointSyncer':{'type':'localStorage','path':'/data/checkpoints'}}]if role=='validator'else[]},'relayer':{'enabled':role=='relayer'},'scraper':{'enabled':role=='scraper'}}}
 if mode=='configured-image':values['hyperlane']['defaultsConfigMap']=''
 file=folder/'fixture-values.json';file.write_text(json.dumps(values))
 c.checked([str(helm),'dependency','build','--skip-refresh',str(chart)],timeout=30)
 text=c.checked([str(helm),'template','compat',str(chart),'-f',str(chart/'values-zig.yaml'),'-f',str(file),'--show-only','templates/fixture-launch.yaml'],timeout=30).stdout
 value=decode_profile(text);validate_profile(value,role,mode);return value

class Launch:
 def initialize(self,c,root,helm,base,role,mode,config,data,value,rows):
  self.c=c;self.role=role;self.mode=mode;self.base=base;self.image=base;self.rows=rows;self.grace_seconds=10;self.temp=tempfile.TemporaryDirectory(prefix='ziggy-helm-render-');self.folder=Path(self.temp.name);self.removals=[];self.utilities=[];self.active=None;self.owner_token=str(os.getpid())+'-'+str(time.monotonic_ns());self.summary={"role":role,"mode":mode,"runs":self.removals,"utilities":self.utilities};rows.append(self.summary)
  db=value['db'];self.profile=render(c,root,helm,role,mode,db,self.folder);self.spec,self.agent,self.environment=validate_profile(self.profile,role,mode)
  # This is a NEW disposable fixture only, not an existing PVC or CSI test.
  data.chmod(0o755)
  probe=data/'ownership-probe';probe.mkdir(mode=0o700)
  self.owner_command(probe,'1000:2000')
  denied=self.utility(probe,'10001:10001','/bin/sh',['-c','test -w /fixture'],'old0700-access')
  need(denied==1,'old0700 ownership must refuse new UID')
  self.owner_command(probe,'10001:2000')
  need(self.utility(probe,'10001:10001','/bin/sh',['-c','test -w /fixture'],'new0700-access')==0,'new explicit owner writable')
  self.owner_command(data,'10001:2000')
  need(self.utility(data,'10001:10001','/bin/rm',['-rf','--','/fixture/ownership-probe'],'remove-disposable-owner-probe')==0,'owner probe cleanup')
  (config/'mainnet_config.json').write_text('{}\n');(config/'relayer-config.json').write_text('{}\n')
  self.config_env=self.folder/'config-env';self.secret_env=self.folder/'secret-env';self.config_env.mkdir();self.secret_env.mkdir();self.folder.chmod(0o755)
  if role=='validator':
   for name,text in self.profile['validator']['data'].items():(self.config_env/name).write_text(text)
   (self.secret_env/'validator-0.env').write_text("HYP_VALIDATOR_KEY='0x"+'11'*32+"'\n")
  for path in [*config.iterdir(),*self.config_env.iterdir(),*self.secret_env.iterdir()]:path.chmod(0o444)
  self.summary.update({'defaults_inputs':[{'name':f.name,**pin(f)}for f in sorted(config.iterdir())],'public_fixture_configuration_only':True})
  if mode=='configured-image':
   context=self.folder/'image';context.mkdir();shutil.copytree(config,context/'defaults')
   base_inspect=json.loads(c.checked(['docker','image','inspect',base]).stdout)[0];identity=base_inspect['Id'];need(re.fullmatch('sha256:[0-9a-f]{64}',identity),'qualified local base content identity')
   (context/'Dockerfile').write_text(configured_recipe(base))
   self.image='ziggy-helm-configured-'+str(os.getpid())+'-'+str(time.monotonic_ns())+':fixture'
   c.checked(['docker','build','--pull=false','--tag',self.image,str(context)],timeout=120)
   derived=json.loads(c.checked(['docker','image','inspect',self.image]).stdout)[0];self.derived_id=derived['Id']
   configured_lineage(base_inspect,derived,json.loads(c.checked(['docker','image','inspect',base]).stdout)[0])
   need(re.fullmatch('sha256:[0-9a-f]{64}',self.derived_id),'actual configured image identity')
   self.summary.update({'configured_image_id':self.derived_id,'qualified_local_base_image_id':identity,'data_only_recipe_sha256':pin(context/'Dockerfile')['sha256'],'runtime_recompiled':False,'actual_base_tag_and_layers_and_config_bound':True})
  self.summary.update({'role':role,'mode':mode,'rendered_command':self.agent['command'],'rendered_validator_args_sha256':hashlib.sha256(''.join(self.agent.get('args',[])).encode()).hexdigest(),'environment_names':sorted(set(self.environment)|{r['name']for r in self.agent.get('env',[])}),'home':'/var/lib/hyperlane','uid':10001,'gid':10001,'supplementary_fsGroup':2000,'explicit_new_volume_owner':'10001:2000','old_UID1000_mode0700_refused':True,'live_PVC_or_CSI_claim':False,'runs':self.removals})
 def owner_command(self,data,owner):
  need(owner in ('1000:2000','10001:2000'),'closed new fixture owner')
  need(self.utility(data,'0:0','/bin/chown',[owner,'/fixture'],'new-volume-owner')==0,'new fixture owner command')
 def utility(self,data,user,entry,arguments,phase):
  result={'phase':phase,'container_id':None,'actual_exit_code':None,'docker_start_client_exit':None,'docker_wait_client_exit':None,'docker_rm_client_exit':None,'negative_inspect_exit':None,'owned_container_absent':False};self.utilities.append(result)
  name='ziggy-helm-utility-'+str(os.getpid())+'-'+str(time.monotonic_ns())
  image=json.loads(self.c.checked(['docker','image','inspect',self.base]).stdout)[0];labels=dict(image['Config'].get('Labels')or{});labels['io.hyperlane.ziggy.helm-fixture']=self.owner_token
  argv=['docker','create','--name',name,'--label','io.hyperlane.ziggy.helm-fixture='+self.owner_token,'--network','none','--user',user,'--group-add','2000','--mount',f'type=bind,src={data},dst=/fixture','--entrypoint',entry,self.base,*arguments]
  reply,v,failure=observe_created(self.c,argv,name,image,labels);cid=v['Id'];result['container_id']=cid;result['create_exception_class']=None if failure is None else type(failure).__name__;exit_code=None
  try:
   if failure is not None:raise failure
   need(reply.returncode==0 and reply.stdout.strip()==cid,'actual utility create reply')
   start=self.c.command(['docker','start','--attach',cid]);result['docker_start_client_exit']=start.returncode
   v=json.loads(self.c.checked(['docker','inspect',cid]).stdout)[0];need(v['Id']==cid and v['State']['Running']is False,'same completed utility CID');result['actual_exit_code']=v['State']['ExitCode']
   wait=self.c.checked(['docker','wait',cid]);result['docker_wait_client_exit']=wait.returncode;need(wait.stdout.strip()==str(result['actual_exit_code'])and start.returncode==result['actual_exit_code'],'utility wait/status binding');exit_code=result['actual_exit_code']
  except BaseException as error:failure=error
  try:
   rm=self.c.checked(['docker','rm','--force','--volumes',cid]);result['docker_rm_client_exit']=rm.returncode
   result.update(absent_receipt(self.c.command(['docker','inspect',cid]),cid))
  except BaseException as cleanup:
   if failure is None:failure=cleanup
   else:failure.add_note('owned utility cleanup failed: '+type(cleanup).__name__)
  if failure is not None:raise failure
  return exit_code
 def create(self,args,name):
  self.active=None
  identity=json.loads(self.c.checked(['docker','image','inspect',self.image]).stdout)[0]
  labels=dict(identity['Config'].get('Labels')or{});labels['io.hyperlane.ziggy.helm-fixture']=self.owner_token
  reply,v,primary=observe_created(self.c,args,name,identity,labels);cid=v['Id']
  self.active={'container_id':cid,'docker_create_client_exit':None if reply is None else reply.returncode,'create_exception_class':None if primary is None else type(primary).__name__,'docker_start_client_exit':None,'actual_started_pid':None,'pid1_executable':None,'rendered_command_verified':False,'readonly_defaults_verified':False,'docker_stop_client_exit':None,'container_exit_code':None,'docker_wait_client_exit':None,'docker_rm_client_exit':None,'negative_inspect_exit':None,'owned_container_absent':False};self.removals.append(self.active)
  if primary is not None:raise primary
  need(reply.returncode==0 and reply.stdout.strip()==cid,'actual create reply')
 def start(self):
  self.active['docker_start_client_exit']=self.c.checked(['docker','start',self.active['container_id']]).returncode
 def stopped(self,code):
  need(type(code)is int and code==0,'actual Docker stop client');self.active['docker_stop_client_exit']=code
 def docker_args(self,image,name,config,data):
  need(image==self.base,'same qualified runtime base')
  args=['docker','create','--name',name,'--label','io.hyperlane.ziggy.helm-fixture='+self.owner_token,'--network','host','--user','10001:10001','--group-add','2000','--mount',f'type=bind,src={data},dst=/data']
  if self.mode=='configmap':args+=['--mount',f'type=bind,src={config},dst=/etc/hyperlane,readonly']
  if self.role=='relayer':args+=['--mount',f'type=bind,src={config},dst=/relayer-configmap,readonly']
  if self.role=='validator':args+=['--mount',f'type=bind,src={self.config_env},dst=/config-env-vars,readonly','--mount',f'type=bind,src={self.secret_env},dst=/secret-env-vars,readonly','-e','REPLICA_NAME=compat-validator-0']
  env=dict(self.environment)
  for row in self.agent.get('env',[]):
   if 'value'in row:env[row['name']]=row['value']
  for name,value in sorted(env.items()):args+=['-e',name+'='+str(value)]
  return args+['--entrypoint',self.agent['command'][0],self.image,*self.agent['command'][1:],*self.agent.get('args',[])]
 def started(self,name):
  cid=self.active['container_id'];v=json.loads(self.c.checked(['docker','inspect',cid]).stdout)[0];need(v['Id']==cid,'actual exact CID');need(v['State']['Running']is True and v['State']['Pid']>0,'actual started container PID')
  need(v['Config']['User']=='10001:10001'and v['Config']['Entrypoint']==[self.agent['command'][0]]and v['Config']['Cmd']==self.agent['command'][1:]+self.agent.get('args',[])and v['HostConfig']['GroupAdd']==['2000'],'actual rendered command/UID/fsGroup')
  actual_env=dict(item.split('=',1)for item in v['Config']['Env']);need(all(actual_env.get(k)==str(value)for k,value in self.environment.items())and actual_env.get('HYPERLANE_ZIG_DEFAULTS')=='/etc/hyperlane','actual defaults and common environment')
  for row in self.agent.get('env',[]):
   if 'value'in row:need(actual_env.get(row['name'])==str(row['value']),'actual role environment')
  if self.mode=='configmap':need(any(r['Destination']=='/etc/hyperlane'and r['RW']is False for r in v['Mounts']),'actual readonly config mount')
  self.c.checked(['docker','exec',cid,'/bin/sh','-c','test -r /etc/hyperlane/fixture.json && test ! -w /etc/hyperlane/fixture.json'])
  exe=self.c.checked(['docker','exec',cid,'/usr/bin/readlink','/proc/1/exe']).stdout.strip();need(exe in ('/opt/hyperlane/bin/'+self.role,'/usr/bin/dash','/bin/dash','/bin/sh'),'actual PID1 is role or rendered shell')
  self.active.update({'actual_started_pid':v['State']['Pid'],'pid1_executable':exe,'rendered_command_verified':True,'readonly_defaults_verified':True})
 def finish(self,name):
  # Exact CID came from our completed create/run command. Every cleanup phase is attempted.
  row=self.active
  if row is None:return
  cid=row['container_id'];failure=None
  try:
   v=json.loads(self.c.checked(['docker','inspect',cid]).stdout)[0];need(v['Id']==cid,'same owned CID')
   if v['State']['Running']:
    self.stopped(self.c.checked(['docker','stop','--time','10',cid],timeout=20).returncode)
    v=json.loads(self.c.checked(['docker','inspect',cid]).stdout)[0]
   if v['State']['Status']!='created':
    row['container_exit_code']=v['State']['ExitCode'];row['OOMKilled']=v['State'].get('OOMKilled',False);need(row['OOMKilled']is False,'container OOM');wait=self.c.checked(['docker','wait',cid],timeout=20);row['docker_wait_client_exit']=wait.returncode
    need(wait.stdout.strip()=='0'and row['container_exit_code']==0 and row['docker_stop_client_exit']==0,'actual container stop/wait0')
  except BaseException as error:failure=error
  try:
   rm=self.c.checked(['docker','rm','--force','--volumes',cid]);row['docker_rm_client_exit']=rm.returncode
   absent=self.c.command(['docker','inspect',cid]);row.update(absent_receipt(absent,cid))
  except BaseException as error:
   if failure is None:failure=error
  if failure is not None:
   primary=getattr(self,'primary_error',None)
   if primary is not None:primary.add_note('owned role cleanup failed: '+type(failure).__name__)
   else:raise failure
 def retire(self):
  try:
   if self.image!=self.base and hasattr(self,'derived_id'):
    need(json.loads(self.c.checked(['docker','image','inspect',self.image]).stdout)[0]['Id']==self.derived_id,'same owned configured image tag')
    self.c.checked(['docker','image','rm',self.image])
    absent_receipt(self.c.command(['docker','image','inspect',self.image]),self.image)
  finally:self.temp.cleanup()

class Factory:
 def __init__(self,c,root,helm,image,mode,rows):
  self.c=c;self.root=root;self.helm=helm;self.image=image;self.mode=mode;self.rows=rows;self.postgres=None
 def __call__(self,role,config,data,value):
  obj=Launch();self.preparing=obj
  try:obj.initialize(self.c,self.root,self.helm,self.image,role,self.mode,config,data,value,self.rows);return obj
  except BaseException as original:
   try:
    if hasattr(obj,'utilities'):obj.utility(data,'0:0','/bin/rm',['-rf','--','/fixture/ownership-probe'],'failed-probe-cleanup')
   except BaseException as cleanup:original.add_note('owner probe cleanup failed: '+type(cleanup).__name__)
   try:
    if hasattr(obj,'temp'):obj.retire()
   except BaseException as cleanup:original.add_note('render context cleanup failed: '+type(cleanup).__name__)
   raise
 def clean_data(self,role,data,launch):
  obj=launch or getattr(self,'preparing',None)
  if obj is not None and hasattr(obj,'utilities'):
   need(obj.utility(data,'10001:10001','/bin/rm',['-rf','--','/fixture/relayer','/fixture/validator','/fixture/checkpoints'],'fixed-output-cleanup')==0,'fixed fixture data cleanup')
 def start_postgres(self,argv,name):
  image=json.loads(self.c.checked(['docker','image','inspect',self.c.POSTGRES_PIN]).stdout)[0];token=str(os.getpid())+'-'+str(time.monotonic_ns());labels=dict(image['Config'].get('Labels')or{});labels['io.hyperlane.ziggy.helm-fixture']=token
  reply,v,primary=observe_created(self.c,argv[:-1]+['--label','io.hyperlane.ziggy.helm-fixture='+token,argv[-1]],name,image,labels);cid=v['Id']
  self.postgres={'container_id':cid,'docker_create_run_client_exit':None if reply is None else reply.returncode,'create_exception_class':None if primary is None else type(primary).__name__,'docker_stop_client_exit':None,'container_exit_code':None,'docker_wait_client_exit':None,'docker_rm_client_exit':None,'negative_inspect_exit':None,'owned_container_absent':False}
  if primary is not None or reply.returncode!=0 or reply.stdout.strip()!=cid:
   error=primary if primary is not None else AssertionError('actual PG create/run reply')
   try:self.finish_postgres(name)
   except BaseException as cleanup:error.add_note('owned PG cleanup failed: '+type(cleanup).__name__)
   raise error
 def finish_postgres(self,name):
  row=self.postgres
  if row is None:return
  cid=row['container_id'];failure=None
  try:
   seen=json.loads(self.c.checked(['docker','inspect',cid]).stdout)[0];need(seen['Id']==cid,'actual PG identity')
   if seen['State'].get('Status')!='created':
    stopped=self.c.checked(['docker','stop','--time','10',cid],timeout=20);row['docker_stop_client_exit']=stopped.returncode
    seen=json.loads(self.c.checked(['docker','inspect',cid]).stdout)[0];need(seen['Id']==cid and seen['State']['Running']is False,'actual PG stopped identity');row['container_exit_code']=seen['State']['ExitCode']
    wait=self.c.checked(['docker','wait',cid],timeout=20);row['docker_wait_client_exit']=wait.returncode;need(wait.stdout.strip()=='0'and row['container_exit_code']==0,'actual PG stop/wait0')
  except BaseException as error:failure=error
  try:
   row['docker_rm_client_exit']=self.c.checked(['docker','rm','--force','--volumes',cid]).returncode
   absent=self.c.command(['docker','inspect',cid]);row.update(absent_receipt(absent,cid))
  except BaseException as error:
   if failure is None:failure=error
  if failure is not None:raise failure

def main():
 p=argparse.ArgumentParser();p.add_argument('--image',required=True);p.add_argument('--migration-image',required=True);p.add_argument('--expected-git-sha',required=True);p.add_argument('--helm',type=Path,required=True);p.add_argument('--output',type=Path,required=True);args=p.parse_args();c=load_checker();c.validate_git_sha(args.expected_git_sha)
 need(args.helm.is_file()and not args.helm.is_symlink(),'explicit regular Helm tool');version=c.checked([str(args.helm),'version','--short']).stdout.strip();need(version.startswith('v3.15.2+'),'pinned Helm3.15.2')
 chart=ROOT/'rust/main/helm/hyperlane-agent';common=ROOT/'rust/main/helm/agent-common';source_paths=[HERE/'container_check.py',Path(__file__).resolve(),*[f for base in (chart,common)for f in base.rglob('*')if f.is_file()and 'charts'not in f.relative_to(base).parts]]
 need(all(not f.is_symlink()for f in source_paths),'regular chart Source inputs')
 result={'source_inputs':[{ 'path':str(f.relative_to(ROOT)),**pin(f)}for f in sorted(source_paths)],'schema':1,'passed':False,'scope':'Actual disposable Docker lifecycle using rendered Zig Helm overrides; no Kubernetes/PVC/production rollout','source_commit':args.expected_git_sha,'helm':pin(args.helm),'profiles':[],'flavors':{},'postgres':{},'error_class':None,'native18_or_timing_credit':False}
 try:
  for mode in ('configmap','configured-image'):
   factory=Factory(c,ROOT,args.helm,args.image,mode,result['profiles'])
   try:result['flavors'][mode]=c.smoke_test(args.image,args.migration_image,c.POSTGRES_PIN,args.output.parent/('helm-'+mode),True,args.expected_git_sha,role_launch=factory)
   finally:result['postgres'][mode]=factory.postgres
  need(len(result['profiles'])==6 and all(len(r['runs'])==2 and all(x['owned_container_absent']is True for x in r['runs']+r['utilities'])for r in result['profiles']),'all12 actual lifecycle runs closed');need(all(r is not None and r['owned_container_absent']is True and r['container_exit_code']==0 for r in result['postgres'].values()),'all PG lifecycles closed');result['passed']=True
 except BaseException as error:result['error_class']=type(error).__name__;raise
 finally:c.write(args.output,result)
if __name__=='__main__':main()
