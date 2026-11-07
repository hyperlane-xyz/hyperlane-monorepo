"""Authorized offline direct SDK compilation/import receipt producer, not a case.

The normal locked package-manager installation is a separate acquisition step.
This runner never installs packages, runs lifecycle scripts or fetches missing
packages. Every namespace has no host network and only declared outputs RW.
"""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import platform
import signal
import subprocess
import sys
import time

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
KERNEL=HERE.parent/'aleo_linux'
sys.path.insert(0,str(KERNEL))
from receipts import checked, decode, files, load, need, source_copies
from kernel_probe import Lease, process, reap_terminal, bootstrap
from supervisor import allocated, free, owner_rss, kernel_receipt, pin, write
from worker_catalog import catalog
from sdk_provision import admitted, delegated_lease, leaf_caps, cleanup_owned, stage_deadline

GIB=1024**3


def argv(spec,node,compiler,config,root):
    bwrap=str(checked(spec['bwrap']))
    result=[bwrap,'--unshare-user','--unshare-net','--unshare-pid','--unshare-ipc','--unshare-uts','--disable-userns','--assert-userns-disabled','--die-with-parent','--new-session','--cap-drop','ALL','--clearenv','--proc','/proc','--dev','/dev','--size',str(64*1024**2),'--tmpfs','/tmp']
    for alias,target in {'/bin':'usr/bin','/lib':'usr/lib','/lib64':'usr/lib64','/sbin':'usr/sbin'}.items():result+=['--symlink',target,alias]
    need('/usr'in spec['readonly_roots']and '/'not in spec['readonly_roots'],'exact RO merged-/usr runtime required')
    for path in spec['readonly_roots']:result+=['--ro-bind',path,path]
    for path in [str(root),*spec['output_directories']]:result+=['--bind',path,path]
    for key,value in {'PATH':'/usr/bin:/bin','HOME':str(root/'home'),'TMPDIR':str(root/'tmp'),'LC_ALL':'C.UTF-8','NODE_OPTIONS':'--max-old-space-size=3072'}.items():result+=['--setenv',key,value]
    result+=['--remount-ro','/','--remount-ro','/proc','--chdir',str(root),'--',node]
    return result+[compiler,'-p',config]


def run(spec_pin):
    spec=load(spec_pin,32*1024**2)
    need(platform.system()=='Linux'and platform.machine()=='x86_64','actual Linux SDK producer required')
    need(spec.get('schema')==1 and spec.get('root_approved')is True and spec.get('purpose')=='aleo-linux-offline-sdk-build-v1','exact compile/import authorization required')
    need(spec['network_acquisition_allowed']is False and spec['lifecycle_scripts_allowed']is False,'offline no-lifecycle stage required')
    actual_kernel=kernel_receipt(spec['kernel_receipt'])
    need(actual_kernel['spec']==spec['kernel_spec'],'SDK stage kernel spec differs')
    kernel_inputs=load(spec['kernel_spec'])
    need(kernel_inputs['python']==spec['python']and kernel_inputs['bwrap']==spec['bwrap'],'actual kernel Python/bwrap tools differ')
    package=admitted(spec['package_receipt'],spec['package_owner_receipt'])
    need(package['source_commit']==spec['execution_source_commit']and package['tools']['node']==spec['node']and package['stage']==spec['stage'],'actual package/Node/Source cohort differs')
    need(package['source_files']==spec['source_files']and package['source_origins']==spec['source_origins']and package['dependency_payloads']==spec['dependency_payloads'],'actual package Source/payload closure differs')
    for key in ('compiler_wrapper','compiler_wrapper_manifest','delegated_compiler','delegated_compiler_manifest','advertised_wrapper_version','executed_compiler_version'):
        need(spec[key]==package[key],'actual locked compiler binding differs')
    delegated_manifest=load(spec['delegated_compiler_manifest'])
    need(delegated_manifest['name']=='typescript'and delegated_manifest['version']==spec['executed_compiler_version']=='6.0.3'and spec['advertised_wrapper_version']=='6.0.2','distinct locked compiler versions required')
    sources=files(spec['source_files'],'SDK Source');dependencies=files(spec['dependency_payloads'],'actual locked Linux package payloads')
    source_copies(spec['source_origins'],sources)
    for entry in spec['pins']:checked(entry)
    need(pin(Path(__file__).resolve())in spec['pins'],'exact SDK runner Source required')
    node=str(checked(spec['node']));compiler=str(checked(spec['compiler_wrapper']));checked(spec['delegated_compiler'])
    root=Path(spec['output']);need(root.parent.resolve()==root.parent and not root.exists(),'exclusive output required');root.mkdir(mode=0o700)
    for name in ('home','tmp'):(root/name).mkdir(mode=0o700)
    projects=[('utils_compile','typescript/utils/tsconfig.build.json'),('provider_compile','typescript/provider-sdk/tsconfig.json'),('aleo_compile','typescript/aleo-sdk/tsconfig.json')]
    stage=Path(spec['stage'])
    need([row['path']for row in spec['configs']]==[str(stage/relative)for _,relative in projects],'exact three original configs required')
    for row in spec['configs']:checked(row)
    for name in ('utils','provider-sdk','aleo-sdk'):
        directory=stage/'typescript'/name/'dist'
        need(str(directory)in spec['output_directories']and directory.is_dir()and not any(directory.iterdir()),'new empty declared dist required')
    config=load(spec['driver_config'])
    need(config['compilerOptions']['noEmit']is True and config['compilerOptions']['strict']is True,'actual strict driver/test noEmit required')
    need(set(config['files'])=={str(checked(spec['driver'])),str(checked(spec['driver_test']))},'both actual owned TS files required')
    start=time.monotonic_ns();deadline=start+1800*10**9;lease=None;child=None;pidfd=None;waits=[];signals=[];result={'kind':'aleo-linux-js-sdk-build-v1','schema':1,'platform':'linux-x86_64','spec':spec_pin,'source_commit':spec['execution_source_commit'],'node':spec['node'],'passed':False,'checks':[],'compiler_wrapper':spec['compiler_wrapper'],'delegated_compiler':spec['delegated_compiler'],'package_receipt':spec['package_receipt'],'compiler_wrapper_manifest':spec['compiler_wrapper_manifest'],'delegated_compiler_manifest':spec['delegated_compiler_manifest'],'advertised_wrapper_version':spec['advertised_wrapper_version'],'executed_compiler_version':spec['executed_compiler_version'],'network_denied_for_import':True,'SDK_proof_or_node_credit':False,'actual_adopted_waits':waits,'signals':signals}
    result['original_started_ns']=start;result['original_deadline_ns']=deadline
    env={'PATH':'/usr/bin:/bin','HOME':str(root/'home'),'TMPDIR':str(root/'tmp'),'LC_ALL':'C.UTF-8','PYTHONNOUSERSITE':'1','PYTHONDONTWRITEBYTECODE':'1'}
    def command(name,command_argv):
        nonlocal child,pidfd
        with (root/(name+'.stdout')).open('xb')as out,(root/(name+'.stderr')).open('xb')as err:
            child=subprocess.Popen([str(checked(spec['python'])),'-I','-B',str(Path(__file__).resolve()),'--bootstrap',json.dumps(command_argv)],env=env,stdin=subprocess.PIPE,stdout=out,stderr=err,start_new_session=True)
            pidfd=os.pidfd_open(child.pid)
            lease.attach(child.pid);birth=process(child.pid);child.stdin.write(b'GO\n');child.stdin.flush();child.stdin.close()
            while child.poll()is None:
                need(time.monotonic_ns()<deadline and free(root)>=6*GIB and allocated(root)+sum(allocated(Path(p))for p in spec['output_directories'])<=2*GIB,'SDK whole1800s/disk2GiB/free6 limit')
                need(int(lease.read('memory.current'))<=4*GIB and owner_rss()<=GIB//2,'SDK child cgroup4GiB limit');time.sleep(.2)
            code=child.wait()
        os.close(pidfd);pidfd=None
        reap_terminal(lease,waits);need(not lease.populated(),'SDK live descendants remain after actual parent wait')
        row={'name':name,'argv':command_argv,'pid':birth['pid'],'start':birth['start'],'actual_parent_wait':True,'exit_code':code,'stdout':pin(root/(name+'.stdout')),'stderr':pin(root/(name+'.stderr'))}
        result.setdefault('all_actual_commands',[]).append(row)
        need(code==0 and time.monotonic_ns()<=deadline,'SDK exact command failed/ended late: '+name)
        return row
    try:
        need(ctypes.CDLL(None,use_errno=True).prctl(36,1,0,0,0)==0,'actual subreaper required')
        lease=delegated_lease(spec,'build');result['actual_leaf_caps_before']=leaf_caps(lease)
        version_argv=argv(spec,node,compiler,'unused',root)[:-3]+[compiler,'--version']
        version=command('compiler_version',version_argv)
        need(Path(version['stdout']['path']).read_bytes()==('Version '+delegated_manifest['version']+'\n').encode(),'actual locked delegated compiler version required')
        for (name,_),config_pin in zip(projects,spec['configs']):result['checks'].append(command(name,argv(spec,node,compiler,config_pin['path'],root)))
        result['checks'].append(command('driver_typecheck',argv(spec,node,compiler,spec['driver_config']['path'],root)))
        sdk_entry=pin(Path(spec['sdk_entry_path']));checked(sdk_entry)
        smoke_argv=argv(spec,node,compiler,'unused',root)[:-3]+[str(checked(spec['import_script'])),sdk_entry['path']]
        smoke=command('isolated_import',smoke_argv);result['checks'].append(smoke)
        lines=Path(smoke['stdout']['path']).read_bytes().splitlines();need(0<len(lines)<=4,'bounded actual import phases required');last=decode(lines[-1])
        need(last.get('phase')=='complete'and last.get('passed')is True and last.get('forbiddenSideEffects')==[]and last.get('roleOrNodeOrProofActions')is False,'actual import guard failed')
        result['outputs']=files([pin(path)for directory in spec['output_directories']for path in sorted(Path(directory).rglob('*'))if path.is_file()],'SDK JS/DTS/maps')
        need(sdk_entry in result['outputs'],'actual SDK import output missing');result['sdk_entry']=sdk_entry
        result['worker_policy']=catalog(spec['SDK_polyfills'],spec['WASM_workers'])
        need(all(row in dependencies for row in result['worker_policy']['allowed_worker_files']),'Worker files must belong to actual dependency payload closure')
        need(free(root)>=6*GIB and allocated(root)+sum(allocated(Path(p))for p in spec['output_directories'])<=2*GIB,'SDK final disk/free gate')
        result['passed']=True
    except BaseException as error:result['error']=type(error).__name__+':'+str(error)
    finally:
        result.update(cleanup_owned(lease,child,pidfd,waits,signals));pidfd=None
        try:
            for row in sources+dependencies+spec['pins']:checked(row)
            source_copies(spec['source_origins'],sources)
            admitted(spec['package_receipt'],spec['package_owner_receipt'])
            result['source_unchanged']=True
        except Exception as error:result['source_unchanged']=False;result['preservation_error']=str(error)
        result['source_files']=sources;result['dependency_payloads']=dependencies
        result['source_origins']=spec['source_origins']
        for key in ('source_files','outputs','dependency_payloads'):
            rows=result.get(key,[]);prefix='dependency_payload'if key=='dependency_payloads'else key
            result[prefix+'_count']=len(rows);result[prefix+'_bytes']=sum(row['bytes']for row in rows)
        result['final_publication_check_ns']=time.monotonic_ns();result['whole_stage_deadline_met']=stage_deadline(result)
        result['passed']=stage_deadline(result)and result['passed']and result['source_unchanged']and result['owned_absent']and not signals and not result.get('cleanup_errors')and len(result['checks'])==5 and all(row['actual_parent_wait']and row['exit_code']==0 for row in result['checks'])and all(row['exit_code']==0 for row in waits)
        write(root/'result.json',result)
    return 0 if result['passed']else 1


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--execute-build',action='store_true');parser.add_argument('--spec');parser.add_argument('--spec-sha');parser.add_argument('--bootstrap');args=parser.parse_args()
    if args.bootstrap:bootstrap(json.loads(args.bootstrap));return 1
    need(args.execute_build and args.spec and args.spec_sha,'inert: explicit offline SDK stage required')
    path=Path(args.spec);raw=path.read_bytes();need(hashlib.sha256(raw).hexdigest()==args.spec_sha,'SDK approved spec changed')
    return run({'path':str(path),'bytes':len(raw),'sha256':args.spec_sha})


if __name__=='__main__':raise SystemExit(main())
