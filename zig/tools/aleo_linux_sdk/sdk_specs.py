"""Metadata generators for the ordinary package stage and offline SDK stage.

Default CLI is inert. Generated specs remain unapproved; Root authorizes exact
pins. No SDK, package manager, compiler or executable is imported/invoked here.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
KERNEL=HERE.parent/'aleo_linux'
sys.path.insert(0,str(KERNEL))
from receipts import checked, decode, load, need
from supervisor import pin, write
import sdk_provision as provision

CODE=('smoke.mjs','kernel_delegate.py','sdk_delegate.py','sdk_export.py','sdk_specs.py','sdk_provision.py','sdk_build.py','receipts.py','kernel_probe.py','loopback_bridge.py','worker_catalog.py','supervisor.py','docker_gate.py','docker_cli.py')


def source_path(name):
    return (KERNEL if name in {'kernel_probe.py','kernel_delegate.py','loopback_bridge.py','receipts.py'}else HERE)/name


def runtime_paths():return [source_path(name)for name in CODE]


def tool_roots(tools,code,repo):
    roots={Path('/usr'),code,repo}
    for row in tools.values():
        p=checked(row)
        if not p.is_relative_to('/usr'):roots.add(p.parent.parent)
    return [str(p)for p in sorted(roots)]


def provision_spec(repo,output,tools,execution_commit,kernel_spec,kernel_receipt,token,delegation_context):
    need(re.fullmatch('[0-9a-f]{40}',execution_commit)and re.fullmatch('[0-9a-f]{32}',token),'actual Source commit/fresh token required')
    need(set(tools)=={'node','pnpm','python','bwrap'},'exact ordinary tool set required')
    for row in tools.values():checked(row)
    need(not output.exists()and output.is_absolute()and output.parent.resolve()==output.parent,'absent owned provision root required')
    checked(kernel_spec);checked(kernel_receipt);checked(delegation_context)
    kernel=load(kernel_receipt);need(kernel.get('kind')=='aleo-linux-kernel-prerequisite-v1'and kernel.get('passed')is True and kernel['spec']==kernel_spec,'actual successful exact delegated kernel spec required')
    code=Path(__file__).resolve().parent
    resolvers={name:pin(Path(name).resolve(strict=True))for name in ('/etc/resolv.conf','/etc/hosts','/etc/nsswitch.conf')}
    pins=[pin(source_path(name))for name in CODE]+list(tools.values())+list(resolvers.values())+[delegation_context]
    return {'schema':1,'root_approved':False,'purpose':'aleo-linux-locked-packages-v1','caps':provision.CAPS,'repo':str(repo),'output':str(output),'execution_source_commit':execution_commit,'run_token':token,'source_files':[pin(p)for p in provision.source_paths(repo)],'kernel_spec':kernel_spec,'kernel_receipt':kernel_receipt,'delegation_context':delegation_context,'readonly_roots':tool_roots(tools,code,repo),'resolver_files':resolvers,'pins':pins,**tools}


def driver_config(stage):
    return {'compilerOptions':{'noEmit':True,'strict':True,'target':'ES2022','module':'ESNext','moduleResolution':'Bundler','allowImportingTsExtensions':True,'skipLibCheck':True,'types':['node'],'typeRoots':[str(stage/'typescript/utils/node_modules/@types')]},'files':[str(stage/'zig/integration/aleo_process.ts'),str(stage/'zig/integration/aleo_process_test.ts')]}


def workers(stage):
    sdk=(stage/'typescript/aleo-sdk/node_modules/@provablehq/sdk').resolve(strict=True)
    wasm=(sdk.parent/'wasm').resolve(strict=True)
    for directory,name in [(sdk,'@provablehq/sdk'),(wasm,'@provablehq/wasm')]:
        need(directory.is_relative_to(stage),'worker package outside owned stage')
        data=decode((directory/'package.json').read_bytes());need(data['name']==name and data['version']=='0.12.0','locked SDK/WASM version changed')
    return ([pin(sdk/'dist'/network/'node-polyfill.js')for network in ('testnet','mainnet')],[pin(wasm/'dist'/network/'worker.js')for network in ('testnet','mainnet')])


def build_spec(package_receipt,control,output,kernel_spec,kernel_receipt,token,delegation_context,package_owner_receipt):
    value=provision.admitted(package_receipt,package_owner_receipt)
    need(re.fullmatch('[0-9a-f]{32}',token),'new builder cgroup token required')
    need(not control.exists()and not output.exists()and control.parent.resolve()==control.parent and output.parent.resolve()==output.parent,'new exact metadata/build roots required')
    checked(kernel_spec);checked(kernel_receipt);checked(delegation_context)
    kernel=load(kernel_receipt);need(kernel.get('kind')=='aleo-linux-kernel-prerequisite-v1'and kernel.get('passed')is True and kernel['spec']==kernel_spec,'actual successful exact delegated kernel spec required')
    stage=Path(value['stage']);code=Path(__file__).resolve().parent
    # No output or config writes before complete package/Source/Worker admission.
    polyfills,worker_files=workers(stage)
    for row in polyfills+worker_files:need(row in value['dependency_payloads'],'actual Worker bytes outside package receipt')
    tools=value['tools'];source_spec=load(value['spec'])
    outputs=[stage/'typescript'/n/'dist'for n in ('utils','provider-sdk','aleo-sdk')]
    need(all(not p.exists()for p in outputs),'SDK products must be absent before build preparation')
    need(value['source_commit']==source_spec['execution_source_commit'],'actual Source cohort differs')
    control.mkdir(mode=0o700)
    config=write(control/'driver-noemit.json',driver_config(stage))
    for path in outputs:path.mkdir(mode=0o700)
    spec={'schema':1,'root_approved':False,'purpose':'aleo-linux-offline-sdk-build-v1','network_acquisition_allowed':False,'lifecycle_scripts_allowed':False,'execution_source_commit':value['source_commit'],'stage':str(stage),'output':str(output),'run_token':token,'kernel_spec':kernel_spec,'kernel_receipt':kernel_receipt,'delegation_context':delegation_context,'package_receipt':package_receipt,'package_owner_receipt':package_owner_receipt,'node':tools['node'],'python':tools['python'],'bwrap':tools['bwrap'],'source_files':value['source_files'],'source_origins':value['source_origins'],'dependency_payloads':value['dependency_payloads'],'configs':[pin(stage/'typescript'/name/config_name)for name,config_name in [('utils','tsconfig.build.json'),('provider-sdk','tsconfig.json'),('aleo-sdk','tsconfig.json')]],'compiler_wrapper':value['compiler_wrapper'],'compiler_wrapper_manifest':value['compiler_wrapper_manifest'],'delegated_compiler':value['delegated_compiler'],'delegated_compiler_manifest':value['delegated_compiler_manifest'],'advertised_wrapper_version':value['advertised_wrapper_version'],'executed_compiler_version':value['executed_compiler_version'],'driver':pin(stage/'zig/integration/aleo_process.ts'),'driver_test':pin(stage/'zig/integration/aleo_process_test.ts'),'driver_config':config,'import_script':pin(code/'smoke.mjs'),'sdk_entry_path':str(stage/'typescript/aleo-sdk/dist/index.js'),'SDK_polyfills':polyfills,'WASM_workers':worker_files,'output_directories':[str(p)for p in outputs]}
    spec['readonly_roots']=sorted(set(source_spec['readonly_roots']+[str(stage),str(control)]))
    spec['pins']=[pin(source_path(n))for n in CODE]+[spec['import_script'],config]+list(tools.values())+[package_receipt,package_owner_receipt,value['spec'],kernel_spec,kernel_receipt,delegation_context]
    return spec


def service_spec(phase,output,tools,repo,commit,kernel_spec,kernel_receipt,token,delegation_tools,package_receipt=None,control=None,package_owner_receipt=None):
    need(phase in {'packages','build'}and re.fullmatch('[0-9a-f]{40}',commit)and re.fullmatch('[0-9a-f]{32}',token),'exact Source/service phase required')
    need(set(tools)=={'node','pnpm','python','bwrap'}and set(delegation_tools)=={'systemd-run','systemctl','sudo'},'closed SDK and system tool sets required')
    for row in list(tools.values())+list(delegation_tools.values()):checked(row)
    kernel=load(kernel_receipt);checked(kernel_spec)
    need(kernel.get('passed')is True and kernel.get('kind')=='aleo-linux-kernel-prerequisite-v1'and kernel['spec']==kernel_spec,'actual successful exact delegated kernel spec required')
    code=Path(__file__).resolve().parent
    result={'schema':1,'root_approved':False,'purpose':'aleo-linux-sdk-service-v1','phase':phase,'output':str(output),'tools':tools,'repo':str(repo),'execution_source_commit':commit,'kernel_spec':kernel_spec,'kernel_receipt':kernel_receipt,'run_token':token,'delegation_tools':delegation_tools,'pins':[pin(source_path(n))for n in CODE]}
    if phase=='packages':result['source_files']=[pin(p)for p in provision.source_paths(repo)]
    else:
        need(package_receipt is not None and control is not None and package_owner_receipt is not None,'actual package receipt/build control required')
        admitted=provision.admitted(package_receipt,package_owner_receipt);need(admitted['source_commit']==commit and admitted['tools']==tools,'actual package Source/tools differ')
        result.update(package_receipt=package_receipt,control=str(control),package_owner_receipt=package_owner_receipt)
    return result


def kernel_spec(output,tools,token,delegation_tools):
    need(re.fullmatch('[0-9a-f]{32}',token),'fresh kernel token required')
    need(not output.exists()and output.parent.resolve()==output.parent,'new kernel output required')
    code=Path(__file__).resolve().parent
    need(set(delegation_tools)=={'systemd-run','systemctl','sudo'},'closed systemd tool set required')
    for row in delegation_tools.values():checked(row)
    return {'schema':1,'root_approved':False,'purpose':'aleo-linux-kernel-probe-v1','output':str(output),'run_token':token,'python':tools['python'],'bwrap':tools['bwrap'],'delegation_tools':delegation_tools,'pins':[pin(source_path(n))for n in ('kernel_probe.py','kernel_delegate.py','loopback_bridge.py','receipts.py')]}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--prepare-provision',action='store_true');parser.add_argument('--prepare-build',action='store_true');parser.add_argument('--binding');parser.add_argument('--binding-sha');parser.add_argument('--output-spec');args=parser.parse_args()
    need((args.prepare_provision!=args.prepare_build)and args.binding and args.binding_sha and args.output_spec,'inert: one explicit metadata preparation mode required')
    path=Path(args.binding);raw=path.read_bytes();need(hashlib.sha256(raw).hexdigest()==args.binding_sha,'exact metadata binding changed');binding=decode(raw)
    need(binding.get('root_approved')is True and binding.get('purpose')=='aleo-linux-sdk-metadata-binding-v1','Root-filled exact metadata binding required')
    if args.prepare_provision:
        spec=provision_spec(Path(binding['repo']),Path(binding['output']),binding['tools'],binding['execution_source_commit'],binding['kernel_spec'],binding['kernel_receipt'],binding['run_token'],binding['delegation_context'])
    else:spec=build_spec(binding['package_receipt'],Path(binding['control']),Path(binding['output']),binding['kernel_spec'],binding['kernel_receipt'],binding['run_token'],binding['delegation_context'],binding['package_owner_receipt'])
    write(Path(args.output_spec),spec)
    return 0

if __name__=='__main__':raise SystemExit(main())
