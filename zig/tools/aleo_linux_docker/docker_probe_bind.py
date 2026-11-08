"""Materialize exact task specs from a reviewed false-by-default public policy.

No image pull, service or Node main runs here. Those are separate owned steps.
"""
import argparse,hashlib,json,os,platform,re,shutil,subprocess,sys
from pathlib import Path
HERE=Path(__file__).resolve().parent
for source_dir in (HERE,HERE.parent/'aleo_linux',HERE.parent/'aleo_linux_sdk'):
 if(source_dir/'__pycache__').exists()or(source_dir/'__pycache__').is_symlink():raise ValueError('Docker profile forbids cached local bytecode')
sys.path.insert(0,str(HERE))
from sibling_imports import load_shared,SHARED,SDK
load_shared()
from receipts import checked,decode,load,need
import docker_probe as probe
import docker_probe_stage as stage
import docker_delegate as delegate
OWN=('sibling_imports.py','docker_probe.py','docker_probe.mjs','docker_delegate.py','docker_probe_stage.py','docker_probe_bind.py')
def policy(path,sha):
 p=Path(path).resolve(strict=True);raw=p.read_bytes();need(len(raw)<=4096 and hashlib.sha256(raw).hexdigest()==sha,'exact bounded reviewed policy required');v=decode(raw)
 need(set(v)=={'schema','root_approved','purpose','caps','provision_caps','delegation_caps','fresh_kernel_prerequisite'}and v['schema']==1 and type(v['root_approved'])is bool and v['purpose']==probe.PURPOSE and v['caps']==probe.CAPS and v['provision_caps']==stage.CAPS and v['delegation_caps']==delegate.PROFILE and v['fresh_kernel_prerequisite']is True,'closed exact Docker-only policy required')
 return v,probe.pin(p)
def source_pins(repo):
 paths=[HERE/n for n in OWN]+[SHARED/n for n in ('receipts.py','loopback_bridge.py','kernel_probe.py','kernel_delegate.py')]+[SDK/n for n in ('docker_gate.py','docker_cli.py')]+[Path(repo)/'zig/bench/cold_matrix_owner.py']
 return [probe.pin(p)for p in paths]
def tools():
 values={name:Path(shutil.which(name)or'/absent').resolve(strict=True)for name in ('python3','node','docker','bwrap','systemd-run','systemctl','sudo')}
 need(values['python3']==Path('/usr/bin/python3.12'),'Ubuntu pinned Python3.12 required')
 return {k:probe.pin(p)for k,p in values.items()}
def prepare(policy_path,policy_sha,root,repo,mode):
 authority,authority_pin=policy(policy_path,policy_sha)
 if not authority['root_approved']:return {'enabled':False,'native_or_proof_credit':False}
 need(platform.system()=='Linux'and platform.machine()=='x86_64','actual native Linux binding only')
 root=Path(root);repo=Path(repo).resolve(strict=True)
 need(root.is_absolute()and root.parent.resolve()==root.parent and re.fullmatch('/tmp/zad-[0-9]+-[0-9]+',str(root)),'short unique task root required')
 commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True,timeout=5).strip();need(re.fullmatch('[0-9a-f]{40}',commit)and commit==os.environ.get('GITHUB_SHA'),'actual execution head required')
 if mode=='stage':
  need(not root.exists(),'new exclusive task root required');root.mkdir(mode=0o700);t=tools();pins=source_pins(repo);spec={'schema':1,'root_approved':True,'purpose':stage.PURPOSE,'caps':stage.CAPS,'images':probe.IMAGES,'output':str(root/'stage'),'node':t['node'],'docker':t['docker'],'owner':probe.pin(repo/'zig/bench/cold_matrix_owner.py'),'pins':pins+[authority_pin]}
  state=probe.write(root/'binding.json',{'execution_source_commit':commit,'reviewed_policy':authority_pin,'source_pins':pins,'tools':t,'probe_output':str(root/'probe')});result=probe.write(root/'stage.spec.json',spec)
 else:
  bound=load(probe.pin(root/'binding.json'));need(bound['execution_source_commit']==commit and bound['reviewed_policy']==authority_pin,'execution/policy changed after provision')
  for pin in bound['source_pins']:checked(pin)
  for pin in bound['tools'].values():checked(pin)
  t=bound['tools']
  if mode=='kernel':
   names={'kernel_probe.py','loopback_bridge.py','receipts.py','kernel_delegate.py','kernel_only_test.py','kernel_delegate_test.py'}
   need({p.name for p in SHARED.iterdir()}==names and all((SHARED/n).is_file()and not(SHARED/n).is_symlink()for n in names),'exact existing finite kernel closure required')
   spec={'schema':1,'root_approved':True,'purpose':'aleo-linux-kernel-probe-v1','authorization':'Reviewed Docker-only policy explicitly requires separate same-runner kernel prerequisite; no Docker grant from kernel authority.','output':str(root/'kernel'),'run_token':os.urandom(16).hex(),'bwrap':t['bwrap'],'python':t['python3'],'pins':[probe.pin(SHARED/n)for n in ('kernel_probe.py','loopback_bridge.py','receipts.py','kernel_delegate.py')],'delegation_tools':{k:t[k]for k in ('systemd-run','systemctl','sudo')}}
   return {'enabled':True,'spec':probe.write(root/'kernel.spec.json',spec),'native_or_proof_credit':False}
  receipt=probe.pin(root/'stage/stage-result.json');actual=load(receipt);need(actual['passed']is True and actual['source_unchanged']is True,'actual successful provision required')
  spec={'schema':1,'root_approved':True,'purpose':probe.PURPOSE,'caps':probe.CAPS,'images':probe.IMAGES,'public_node_env':probe.PUBLIC_ENV,'run_token':os.urandom(16).hex(),'output':bound['probe_output'],'python':t['python3'],'node':t['node'],'bwrap':t['bwrap'],'shim':probe.pin(SDK/'docker_cli.py'),'node_main':probe.pin(HERE/'docker_probe.mjs'),'readonly_roots':[str(HERE),str(SHARED),str(SDK),str(checked(t['node']).parent)],'docker_socket':'/var/run/docker.sock','docker_api_version':'1.45','daemon_id':actual['native_engine']['id'],'docker_filesystem':actual['native_engine']['filesystem'],'stage_receipt':receipt,'kernel_receipt':probe.pin(root/'kernel/result.json'),'kernel_owner_receipt':probe.pin(root/'kernel.owner/owner.json'),'delegation_tools':{k:t[k]for k in ('systemd-run','systemctl','sudo')}}
  kernel_result=load(spec['kernel_receipt']);kernel_owner=load(spec['kernel_owner_receipt'])
  spec['pins']=bound['source_pins']+[authority_pin,receipt,actual['spec'],spec['kernel_receipt'],spec['kernel_owner_receipt'],kernel_result['spec'],kernel_owner['original_spec'],*[r['log']for r in actual['commands']],*t.values()]
  spec['pins']=list({r['path']:r for r in spec['pins']}.values());probe.approved(spec);result=probe.write(root/'probe.spec.json',spec)
 return {'enabled':True,'spec':result,'native_or_proof_credit':False}
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--mode',choices=['stage','kernel','probe'],required=True);p.add_argument('--reviewed-policy',required=True);p.add_argument('--policy-sha256',required=True);p.add_argument('--output',required=True);p.add_argument('--repo',required=True);a=p.parse_args();v=prepare(a.reviewed_policy,a.policy_sha256,a.output,a.repo,a.mode)
 if os.environ.get('GITHUB_OUTPUT'):
  with open(os.environ['GITHUB_OUTPUT'],'a')as f:
   f.write('enabled='+str(v['enabled']).lower()+'\n')
   if v['enabled']:f.write('spec='+v['spec']['path']+'\nspec_sha256='+v['spec']['sha256']+'\n')
 print(json.dumps(v))
