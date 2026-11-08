"""Exact full-case metadata and receipt composition. No execution on import."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import sys
import time

HERE=Path(__file__).resolve().parent
for code_root in (HERE,HERE.parent/'aleo_linux',HERE.parent/'aleo_linux_sdk'):
    if(code_root/'__pycache__').exists()or(code_root/'__pycache__').is_symlink():raise ValueError('full-case profile forbids cached local Python bytecode')
SDK=HERE.parent/'aleo_linux_sdk';KERNEL=HERE.parent/'aleo_linux'
sys.path.insert(0,str(KERNEL));sys.path.insert(0,str(SDK));sys.path.insert(0,str(HERE))
from case_cohort import source_cohort,storage_interop
from receipts import checked,load,need,sdk_receipt
import sdk_specs
from case_supervisor import CAPS,pin,write,kernel_receipt

CASE_CODE=('verifier_cache.py','custody.py','controller_resources.py','case_cohort.py','case_supervisor.py','case_delegate.py','case_specs.py','inner.py','bridge_close.py','namespace_policy.py','public_proof.py','cache_server.py','case_launcher.mjs','bootstrap.mjs','clock.mjs','prepare_manifest.mjs','public-profile.json.gz','closed-cache-assets.json.gz')
VERIFIERS=('zig/integration/native_case_inputs.py','zig/bench/native_case_ci.py','zig/bench/native_payload_export.py','zig/tools/build_cpu.py','zig/bench/native_case_tools.py','zig/bench/native_harness_census.py','zig/integration/native_rows_interop.py')
GRANT_SHA=('50edaa4a75ce4657d3c163e5bf644f1f' 'b90e101d5c879acb06f84e3028e87742')
GIB=1024**3


def public_profile():
    raw=(HERE/'public-profile.json.gz').read_bytes();need(len(raw)<=16384,'bounded public profile required')
    decoded=gzip.decompress(raw);need(len(decoded)<=16384,'bounded public profile output required')
    from receipts import decode
    return decode(decoded,16384)


def runtime_paths():
    return sorted(set([HERE/name for name in CASE_CODE]+sdk_specs.runtime_paths()))


def unique(rows):
    out={}
    for row in rows:
        checked(row)
        if row['path']in out:need(out[row['path']]==row,'conflicting path pin')
        out[row['path']]=row
    return list(out.values())


def parameters(grant_pin,assets):
    need(grant_pin['sha256']==GRANT_SHA,'original closed publisher grant required')
    grant=load(grant_pin);expected={row['url']:row['file']for row in grant['assets']}
    need(len(expected)==17 and type(assets)is list and len(assets)==17,'exact17 publisher aliases required')
    need({row['url']for row in assets}==set(expected),'parameter alias changed')
    physical={}
    for row in assets:
        need(set(row)=={'url','file'},'closed parameter mapping required')
        value=row['file'];old=expected[row['url']]
        need((value['bytes'],value['sha256'])==(old['bytes'],old['sha256']),'parameter publisher bytes differ')
        checked(value)
        if value['sha256']in physical:need(value==physical[value['sha256']],'one actual path per unique parameter required')
        physical[value['sha256']]=value
    need(len(physical)==9 and sum(row['bytes']for row in physical.values())==79506114,'original nine parameter files only')
    paths=[Path(row['path'])for row in physical.values()];parents={p.parent for p in paths}
    need(len(parents)==1,'one closed owned resource directory required')
    directory=next(iter(parents));need({p.name for p in directory.iterdir()}=={p.name for p in paths},'parameter directory contains unapproved members')
    return list(physical.values())


def docker_admission(result_pin,owner_pin,node):
    result=load(result_pin);owner=load(owner_pin)
    need(result.get('schema')==1 and result.get('kind')=='aleo-linux-native-docker-probe-v1'and result.get('passed')is True and result.get('source_unchanged')is True,'actual Docker prerequisite required')
    need(not result.get('signals')and not result.get('cleanup_errors')and not result.get('error_type'),'Docker prerequisite failed/forced')
    need(result.get('native_case_acceptance')is False and result.get('SDK_or_proof_or_agent_execution')is False,'Docker prerequisite cannot claim native acceptance')
    need(owner.get('kind')=='aleo-linux-docker-probe-delegation-v1'and owner.get('passed')is True and owner['docker_probe_result']==result_pin,'matching actual Docker parent receipt required')
    wait=owner.get('client_actual_wait')or{}
    need(wait.get('actual_parent_wait')is True and type(wait.get('exit_code'))is int and wait['exit_code']==0 and owner.get('cleanup',{}).get('owned_cgroup_absent')is True and not owner.get('cleanup_errors'),'actual Docker service wait/absence required')
    spec=load(result['spec']);need(spec['node']==node,'Docker actual Node differs')
    kernel=load(spec['kernel_receipt'])
    need(kernel.get('passed')is True and kernel['boot_id']==Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'Docker prerequisite belongs to another boot')
    for row in spec['pins']:checked(row)
    names=('postgres','leo','committed_create_lost_reply')
    need([row['phase']for row in result['phases']]==list(names),'all actual Docker capability phases required')
    for row in result['phases']:
        need(row.get('passed')is True and not row.get('cleanup_errors'),'Docker capability phase failed')
        wait=row.get('direct_wait')or{}
        need(wait.get('actual_parent_wait')is True and type(wait.get('exit_code'))is int and wait['exit_code']==0,'actual Docker namespace child wait required')
        clean=row['container_cleanup'];need(clean.get('passed')is True and len(clean['rows'])==1 and clean['rows'][0].get('stopped_removed_absent')is True,'actual Docker CID absence required')
        need(row.get('actual_NamespacePeer_Node')is not None,'actual native Docker peer custody required')
        lost=row['phase']=='committed_create_lost_reply'
        need(row.get('controlled_fault')is lost,'exact controlled Docker phase differs')
        if lost:
            committed=row.get('committed_create');need(type(committed)is dict and set(committed)=={'cid','name'}and re.fullmatch('[0-9a-f]{64}',committed['cid'])and clean['rows'][0]['cid']==committed['cid'],'actual committed-create recovery CID differs')
        else:need(row.get('actual_kernel'),'actual started native Docker kernel proof required')
    need(result['network_cleanup']['owned_internal_network_removed_and_absent']is True,'actual owned Docker network absence required')
    checked(result['spec']);checked(owner['original_spec'])
    return spec


def namespace_inputs(spec,sdk):
    """Derive actual visible leaves; host-only origins/cohort receipts stay out."""
    manifest=load(spec['manifest'])
    rows=[*manifest['sourceFiles'],*manifest['artifacts'].values(),*manifest['tools'].values(),*manifest['parameterFiles'],*manifest['sourceGates'],manifest['acceptedBuild'],manifest['sdkBuild'],manifest['nativeRowsAcceptance'],manifest['approval'],spec['manifest'],spec['policy_template'],load(spec['policy_template'])['grant'],spec['python'],spec['node'],spec['bwrap'],*spec['system_libraries'].values()]
    shim=Path(manifest['tools']['docker']['path']).parent.parent
    for relative,origin in [('aleo_linux_sdk/docker_gate.py',SDK/'docker_gate.py'),('aleo_linux/receipts.py',KERNEL/'receipts.py')]:
        copy=pin(shim/relative);source=pin(origin);need((copy['bytes'],copy['sha256'])==(source['bytes'],source['sha256']),'owned shim sibling Source differs');rows.append(copy)
    rows += sdk['source_files']+sdk['outputs']+sdk['dependency_payloads']
    summary=load(spec['storage_interop'])
    for mode in summary['modes'].values():
        raw=load(mode['raw_result'])
        rows += [mode['raw_result'],mode['old_canonical_command'],mode['native_reader_command'],*raw['artifacts'].values()]
        database=Path(raw['fixture_root'])/'db'
        for name,record in raw['database_file_hashes_after_old_oracle'].items():rows.append(dict(path=str(database/name),**record))
    return unique(rows)


def namespace_roots(spec,sdk):
    manifest=load(spec['manifest']);roots={Path('/usr'),HERE,SDK,KERNEL,Path(load(sdk['spec'])['stage']),Path(spec['manifest']['path']).parent,Path(manifest['parameterHome'])/'.aleo/resources'}
    for row in namespace_inputs(spec,sdk):
        p=checked(row)
        if not any(p.is_relative_to(root)for root in roots):roots.add(p)
    roots={p for p in roots if not any(p!=q and p.is_relative_to(q)for q in roots)}
    return sorted(str(p)for p in roots)


def kernel_pair(result_pin,owner_pin,spec_pin):
    row=kernel_receipt(result_pin);owner=load(owner_pin)
    need(row['spec']==spec_pin and owner.get('kind')=='aleo-linux-kernel-delegation-v1'and owner.get('schema')==1 and owner.get('passed')is True and owner['kernel_result']==result_pin,'matching actual kernel service receipt required')
    wait=owner.get('client_actual_wait')or{}
    need(wait.get('actual_parent_wait')is True and type(wait.get('exit_code'))is int and wait['exit_code']==0 and owner.get('cleanup',{}).get('owned_cgroup_absent')is True and not owner.get('cleanup_errors'),'actual kernel service wait/absence required')
    checked(owner['original_spec']);return row


def admission(spec):
    need(spec.get('schema')==1 and spec.get('purpose')=='actual-aleo-linux-case-v1'and spec.get('root_approved')is True and spec.get('caps')==CAPS,'explicit exact case authority required')
    if 'controller_receipt'in spec:
        controller=load(spec['controller_receipt']);need(controller['service_spec']==spec['service_owner_spec']and controller['run_token']==spec['run_token'],'original controller receipt differs')
        import controller_resources
        controller_resources.tree(controller['identity'])
    need(type(spec.get('run_token'))is str and re.fullmatch('[0-9a-f]{32}',spec['run_token']),'fresh case token required')
    paths={row['path']:row for row in spec['pins']}
    need(len(paths)==len(spec['pins']),'unique complete case pins required')
    for path in runtime_paths():need(paths.get(str(path))==pin(path),'exact current case/SDK/kernel code missing')
    for row in spec['pins']:checked(row)
    need(spec['namespace_policy']==pin(HERE/'namespace_policy.py')and spec['inner']==pin(HERE/'inner.py')and spec['bootstrap']==pin(HERE/'bootstrap.mjs')and spec['case_launcher']==pin(HERE/'case_launcher.mjs'),'fixed case entry points required')
    probe=docker_admission(spec['docker_receipt'],spec['docker_owner_receipt'],spec['node'])
    need(probe['daemon_id']==spec['daemon_id']and probe['docker_filesystem']==spec['docker_filesystem']and probe['docker_socket']==spec['docker_socket']and probe['docker_api_version']==spec['docker_api_version'],'actual native Engine binding differs')
    manifest=load(spec['manifest']);profile=public_profile()
    for key,value in profile.items():need(manifest[key]==value,'original fixed Aleo public fixture changed: '+key)
    need(manifest['image']==probe['images']['image']and manifest['postgresImage']==probe['images']['postgresImage'],'actual canonical images differ')
    need(manifest['tools']['docker']==spec['docker_cli']and manifest['tools']['node']==spec['node'],'actual admitted tool paths differ')
    need(manifest['nativeRowsAcceptance']==spec['storage_interop']and manifest['sdkBuild']==spec['sdk_receipt'],'actual SDK/storage receipts differ')
    sdk=sdk_receipt(spec['sdk_receipt'],spec['node'],spec['sdk_entry'],spec['execution_source_commit'],spec['sdk_owner_receipt'])
    need(spec['driver']==pin(Path(load(sdk['spec'])['stage'])/'zig/integration/aleo_process.ts'),'actual compiled staged driver differs')
    need(manifest['sourceFiles']==unique([pin(p)for p in runtime_paths()]+[spec['driver'],pin(Path(load(sdk['spec'])['stage'])/'zig/integration/aleo_process_test.ts'),spec['policy_template']]),'exact inner manifest Source leaves differ')
    need(spec['driver']in sdk['source_files']and pin(Path(load(sdk['spec'])['stage'])/'zig/integration/aleo_process_test.ts')in sdk['source_files'],'both original staged TS inputs required')
    kernel_pair(spec['kernel_receipt'],spec['kernel_owner_receipt'],spec['kernel_spec'])
    need(probe['images']['postgresImage']['reference'].startswith('postgres@sha256:'),'canonical PG reference required')
    template=load(spec['policy_template']);files=parameters(template['grant'],template['assets'])
    need(manifest['parameterFiles']==files,'manifest/closed cache parameters differ')
    need(all(Path(row['path']).is_relative_to(Path(manifest['parameterHome'])/'.aleo')for row in files),'native parameter home differs')
    need(spec['namespace_pins']==namespace_inputs(spec,sdk)and spec['readonly_roots']==namespace_roots(spec,sdk),'derived closed namespace leaves/mounts differ')
    need(template['deadline_python_ns']is None and template['deadline_monotonic_ns']is None and template['uncertainty_ns']is None,'metadata cannot mint a proving clock')
    return spec


def prepare(binding_pin):
    binding=load(binding_pin)
    need(binding.get('root_approved')is True and binding.get('purpose')=='aleo-linux-fullcase-metadata-binding-v1','explicit exact metadata binding required')
    need(set(binding)=={'schema','root_approved','purpose','repo','execution_source_commit','runtime_source_commit','mode','run_token','output','control','context','sdk_receipt','sdk_owner_receipt','storage_interop','kernel_receipt','kernel_spec','kernel_owner_receipt','docker_receipt','docker_owner_receipt','assets','parameter_home','tools','http_library','crypto_library'},'closed case metadata binding required')
    repo=Path(binding['repo']);control=Path(binding['control']);root=Path(binding['output'])
    need(not root.is_relative_to(repo)and not repo.is_relative_to(root),'case output cannot contain or modify Source checkout')
    need(control.is_absolute()and control.parent.resolve()==control.parent and not control.exists()and root.is_absolute()and root.parent.resolve()==root.parent and not root.exists()and not control.is_relative_to(root)and not root.is_relative_to(control),'new separate metadata/case roots required')
    token=binding['run_token'];need(type(token)is str and re.fullmatch('[0-9a-f]{32}',token),'fresh token required')
    need(binding['mode']in {'ReleaseSafe','ReleaseFast'},'exact actual mode required')
    tools=binding['tools'];need(set(tools)=={'node','python','bwrap','docker','psql','ps'},'fixed native tool set required')
    for row in tools.values():checked(row)
    need(checked(tools['python'])==Path('/usr/bin/python3.12')and checked(tools['ps'])==Path('/usr/bin/ps'),'pinned Ubuntu system tools required')
    sdk=load(binding['sdk_receipt'],32*1024**2);entry=sdk['sdk_entry']
    sdk=sdk_receipt(binding['sdk_receipt'],tools['node'],entry,binding['execution_source_commit'],binding['sdk_owner_receipt'])
    verifier_pins=[pin(repo/name)for name in VERIFIERS];loader=pin(repo/VERIFIERS[0])
    cohort=source_cohort(binding['context'],loader,repo,binding['execution_source_commit'],binding['runtime_source_commit'],verifier_pins)
    context=load(binding['context']);need(context['mode']==binding['mode'],'mode context differs')
    storage_interop(binding['storage_interop'],binding['context'],loader,repo,verifier_pins)
    probe=docker_admission(binding['docker_receipt'],binding['docker_owner_receipt'],tools['node'])
    kernel_pair(binding['kernel_receipt'],binding['kernel_owner_receipt'],binding['kernel_spec'])
    grant=pin(Path(binding['parameter_home'])/'publisher-grant.json');files=parameters(grant,binding['assets'])
    profile=public_profile()
    need(profile['image']==probe['images']['image']and profile['postgresImage']==probe['images']['postgresImage'],'actual prerequisite image differs')
    code=[pin(p)for p in runtime_paths()]
    driver=pin(Path(load(sdk['spec'])['stage'])/'zig/integration/aleo_process.ts');driver_test=pin(Path(load(sdk['spec'])['stage'])/'zig/integration/aleo_process_test.ts')
    need(driver in sdk['source_files']and driver_test in sdk['source_files'],'actual strict-compiled TS driver/test required')
    libs={'http':binding['http_library'],'crypto':binding['crypto_library']}
    for row in libs.values():checked(row)
    # Bind a tiny owned executable shim sibling tree exactly as the Docker probe.
    need(checked(tools['docker']).name=='docker_cli.py'and os.access(tools['docker']['path'],os.X_OK),'owned exact executable Docker shim required')
    checked(tools['docker']);need(tools['docker']['sha256']==pin(SDK/'docker_cli.py')['sha256'],'Docker shim Source differs')
    products=cohort['runtime_products'];native_tools={'node':tools['node'],'docker':tools['docker'],'psql':tools['psql'],'initDb':context['tools']['init-db'],'rocksOracle':context['tools']['ziggy-rocks-oracle'],'nativeRows':context['tools']['ziggy-native-rows']}
    # All validation precedes the first output write. No clock is minted here.
    control.mkdir(mode=0o700)
    accepted=write(control/'accepted-runtime.json',{'schema':1,'passed':True,'source_unchanged':True,'source_commit':binding['runtime_source_commit'],'mode':binding['mode'],'runtime_artifacts':products,'actual_hydrated_context':binding['context'],'compiled_input_closure':cohort['compiled_input_closure'],'correctness_input_reuse_only':True,'native_acceptance':False,'performance_credit':False})
    closure=load(cohort['compiled_input_closure']);gate=write(control/'compiled-source-gate.json',{'schema':1,'source_commit':binding['runtime_source_commit'],'source_unchanged':True,'checks':closure['checks'],'actual_compiled_input_closure':cohort['compiled_input_closure'],'actual_waited_git_rechecks':cohort['actual_waited_git_checks'],'not_a_fresh_build':True})
    policy={'schema':1,'root':str(root/'control'),'grant':grant,'node':tools['node'],'diagnostic_ps':tools['ps'],'code_pins':unique(code+[driver,driver_test,tools['docker']]),'assets':binding['assets'],'rpc_ports':[23030,23031,23032,23033,23034,25432,29091,29092,29093,29094],'cache_port':23032,'deadline_monotonic_ns':None,'deadline_python_ns':None,'uncertainty_ns':None,'allowed_sdk_worker_files':sdk['worker_policy']['allowed_worker_files'],'allowed_worker_files':[driver,*sdk['worker_policy']['allowed_worker_files']],'allowed_eval_sha256':sdk['worker_policy']['allowed_eval_sha256'],'max_threads_per_parent':8,'max_threads_total':8,'max_old_space_mb':3072,'allowed_native_executables':[products[k]for k in ('relayer','validator','scraper','worker')]+[native_tools[k]for k in ('docker','psql','initDb','rocksOracle','nativeRows')]}
    policy_pin=write(control/'policy-template.json',policy)
    manifest=dict(profile,schema=1,runtimeSourceCommit=binding['runtime_source_commit'],mode=binding['mode'],taskRoot=str(root/'data/case'),acceptedBuild=accepted,approval={'path':str(control/'approval.json'),'bytes':1,'sha256':'0'*64},artifacts=products,tools=native_tools,sdkBuild=binding['sdk_receipt'],nativeRowsAcceptance=binding['storage_interop'],sourceGates=[gate],parameterHome=binding['parameter_home'],dockerHost='unix://'+str(root/'capabilities/docker.sock'),dockerDaemonId=probe['daemon_id'],httpLibrary=libs['http']['path'],cryptoLibrary=libs['crypto']['path'],parameterFiles=files,sourceFiles=unique(code+[driver,driver_test,policy_pin]))
    manifest_input=write(control/'manifest-input.json',manifest)
    template=[tools['node']['path'],'--experimental-strip-types','--no-warnings',str(HERE/'case_launcher.mjs'),str(root/'readonly/policy.json'),'MINT_AT_LAUNCH',str(control/'manifest.json'),driver['path']]
    spec={k:binding[k]for k in ('repo','execution_source_commit','runtime_source_commit','run_token','output','context','sdk_receipt','sdk_owner_receipt','storage_interop','kernel_receipt','kernel_spec','kernel_owner_receipt','docker_receipt','docker_owner_receipt')}
    spec.update(schema=1,root_approved=False,purpose='actual-aleo-linux-case-v1',caps=CAPS,system_libraries=libs,sdk_entry=entry,node=tools['node'],python=tools['python'],bwrap=tools['bwrap'],docker_cli=tools['docker'],driver=driver,source_loader=loader,verifier_pins=verifier_pins,manifest={'path':str(control/'manifest.json'),'bytes':None,'sha256':None},manifest_digest=None,policy_template=policy_pin,namespace_policy=pin(HERE/'namespace_policy.py'),inner=pin(HERE/'inner.py'),cache_server=pin(HERE/'cache_server.py'),case_launcher=pin(HERE/'case_launcher.mjs'),bootstrap=pin(HERE/'bootstrap.mjs'),clock_script=pin(HERE/'clock.mjs'),daemon_id=probe['daemon_id'],docker_filesystem=probe['docker_filesystem'],docker_socket=probe['docker_socket'],docker_api_version=probe['docker_api_version'],public_node_env=probe['public_node_env'],exact_node_argv_template=template)
    spec['namespace_pins']=None;spec['readonly_roots']=None
    spec['pins']=unique(code+[grant,binding_pin,manifest_input,policy_pin,accepted,gate,entry,driver,driver_test,*tools.values(),*libs.values(),*verifier_pins,*files,*products.values(),*context['tools'].values(),binding['context'],binding['sdk_receipt'],binding['sdk_owner_receipt'],binding['storage_interop'],binding['kernel_receipt'],binding['kernel_spec'],binding['kernel_owner_receipt'],binding['docker_receipt'],binding['docker_owner_receipt']])
    return write(control/'case.PENDING.json',spec)


def stage_shim(output):
    """Copy exact closed public Source siblings; change mode only on owned copy."""
    need(output.is_absolute()and output.parent.resolve()==output.parent and not output.exists(),'new owned shim sibling root required')
    selected=[(SDK/'docker_cli.py','aleo_linux_sdk/docker_cli.py',0o700),(SDK/'docker_gate.py','aleo_linux_sdk/docker_gate.py',0o600),(KERNEL/'receipts.py','aleo_linux/receipts.py',0o600)]
    sources=[pin(p)for p,_,_ in selected]
    output.mkdir(mode=0o700)
    copies=[]
    for (source,name,mode),row in zip(selected,sources):
        checked(row);target=output/name;target.parent.mkdir(mode=0o700,exist_ok=True)
        with target.open('xb')as stream:os.chmod(target,mode);stream.write(source.read_bytes());stream.flush();os.fsync(stream.fileno())
        copy=pin(target);need((copy['bytes'],copy['sha256'])==(row['bytes'],row['sha256']),'owned shim copy differs');copies.append({'source':row,'copy':copy})
    return write(output/'source-copies.json',{'schema':1,'kind':'aleo-linux-closed-shim-copy-v1','copies':copies,'Source_changed':False})


def bind_namespace(case_pin):
    spec=load(case_pin,32*1024**2)
    need(spec['root_approved']is True and spec['namespace_pins']is None and spec['readonly_roots']is None,'exact typed finalized unminted metadata required')
    sdk=sdk_receipt(spec['sdk_receipt'],spec['node'],spec['sdk_entry'],spec['execution_source_commit'],spec['sdk_owner_receipt'])
    spec['namespace_pins']=namespace_inputs(spec,sdk);spec['readonly_roots']=namespace_roots(spec,sdk)
    admission(spec)
    return write(Path(case_pin['path']).with_name('case-approved.json'),spec)


def service_spec(case_pin,delegation_tools):
    case=load(case_pin,32*1024**2);admission(case)
    need('delegation_context'not in case and set(delegation_tools)=={'systemd-run','systemctl','sudo'},'no caller custody; exact systemd tools required')
    for row in delegation_tools.values():checked(row)
    return {'schema':1,'root_approved':False,'purpose':'aleo-linux-case-service-v1','case_spec':case_pin,'output':case['output'],'run_token':case['run_token'],'tools':{'python':case['python']},'delegation_tools':delegation_tools,'pins':[pin(p)for p in runtime_paths()]}


def main():
    p=argparse.ArgumentParser();p.add_argument('--prepare',action='store_true');p.add_argument('--bind-namespace',action='store_true');p.add_argument('--stage-shim',type=Path);p.add_argument('--service',action='store_true');p.add_argument('--binding');p.add_argument('--binding-sha');p.add_argument('--system-tools');p.add_argument('--system-tools-sha');p.add_argument('--output',type=Path);a=p.parse_args()
    need(sum((a.prepare,a.bind_namespace,a.stage_shim is not None,a.service))==1,'inert: one explicit metadata-only mode required')
    if a.stage_shim is not None:stage_shim(a.stage_shim);return
    need(a.binding and a.binding_sha,'exact metadata input required')
    binding=pin(Path(a.binding));need(binding['sha256']==a.binding_sha,'exact metadata binding changed')
    if a.prepare:prepare(binding)
    elif a.bind_namespace:bind_namespace(binding)
    else:
        need(a.system_tools and a.system_tools_sha and a.output,'exact service tools/output required')
        tool_pin=pin(Path(a.system_tools));need(tool_pin['sha256']==a.system_tools_sha,'system tool binding changed')
        write(a.output,service_spec(binding,load(tool_pin)))

if __name__=='__main__':main()
