"""Normal locked Linux pnpm acquisition. Inert; no SDK imports or package scripts."""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import signal
import shutil
import subprocess
import sys
import time

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
KERNEL=HERE.parent/'aleo_linux'
sys.path.insert(0,str(KERNEL))
from receipts import checked, decode, load, need, source_copies
from kernel_probe import Lease, bootstrap, process, reap_terminal
from supervisor import free, owner_rss, kernel_receipt, pin, write

GIB=1024**3
PACKAGES=('utils','provider-sdk','aleo-sdk','tsconfig')
CAPS={'seconds':1800,'child_memory_bytes':4*GIB,'owner_memory_bytes':GIB//2,'pids':128,'new_disk_bytes':4*GIB,'free_floor_bytes':6*GIB,'log_bytes':8*1024**2}
MANAGER=('pnpm@12.3.0+sha512.'
    'd7bd39a488131de200aeec1dbc9ca58b'
    '890437f09b1f925b1bf820fdc463df01'
    'a329e3699c3d8a7bb186d5cf3f75cb68'
    'ce820c69d6b2c983525bc0821de4c529')


def beneath(path,root):
    need(path.is_absolute()and path.resolve(strict=True)==path and path.is_relative_to(root),'canonical owned path required')
    for component in [path,*path.parents]:need(not component.is_symlink(),'Source alias forbidden')
    return path


def allocated(root):
    """Count ordinary pnpm symlink inodes without following payload targets."""
    total=0;seen=set()
    for directory,dirs,names in os.walk(root,followlinks=False):
        for name in dirs+names:
            path=Path(directory)/name
            try:
                info=path.lstat()
                if path.is_symlink():
                    target=Path(os.path.abspath(path.parent/os.readlink(path)))
                    need(target.is_relative_to(root),'live package link escaped owned acquisition root')
            except FileNotFoundError:continue
            key=(info.st_dev,info.st_ino)
            if key not in seen:seen.add(key);total+=info.st_blocks*512
    return total


def source_paths(repo):
    """Original manifests plus exact compilation Source; no generated packages."""
    fixed=['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','.nvmrc','zig/integration/aleo_process.ts','zig/integration/aleo_process_test.ts','zig/src/native_rows_interop_fixture.zig','zig/integration/native_rows_interop.py','zig/bench/native_case_tools.py','zig/bench/native_harness_census.py']
    result={repo/p for p in fixed}
    for path in [repo/'solidity/package.json',repo/'solhint-plugin/package.json',repo/'starknet/package.json',*sorted((repo/'typescript').glob('*/package.json'))]:
        if path.is_file():result.add(path)
    result.update(p for p in (repo/'patches').rglob('*')if p.is_file())
    for name in PACKAGES:
        root=repo/'typescript'/name
        result.update(p for p in root.glob('*.json')if p.is_file())
        if name=='tsconfig':continue
        for directory,dirs,files in os.walk(root/'src',followlinks=False):
            need(not any((Path(directory)/n).is_symlink()for n in dirs),'Source directory alias forbidden')
            result.update(Path(directory)/n for n in files)
    return [beneath(p,repo)for p in sorted(result)]


def stage_sources(repo,stage,expected):
    need(not stage.exists()and stage.parent.resolve()==stage.parent,'new exclusive workspace required')
    need(isinstance(expected,list)and 0<len(expected)<=5000 and sum(row['bytes']for row in expected)<=128*1024**2,'bounded original Source selection required')
    actual=[pin(p)for p in source_paths(repo)]
    need(actual==expected,'Original Source membership/pins changed')
    need(decode((repo/'package.json').read_bytes())['packageManager']==MANAGER,'Source package manager changed')
    need((repo/'.nvmrc').read_bytes()==b'v26.12.1\n','Source Node version changed')
    stage.mkdir(mode=0o700);origins=[]
    for row in expected:
        original=checked(row);target=stage/original.relative_to(repo);target.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
        with target.open('xb')as out:os.chmod(target,0o600);out.write(original.read_bytes())
        staged=pin(target);need(staged['sha256']==row['sha256']and staged['bytes']==row['bytes'],'Source copy mismatch');origins.append({'origin':row,'staged':staged})
    return origins


def environment(root,node,pnpm):
    # Entire explicit environment, never merge ambient credentials/proxies.
    return {'PATH':os.pathsep.join([str(node.parent),str(pnpm.parent),'/usr/bin','/bin']),'HOME':str(root/'home'),'TMPDIR':str(root/'tmp'),'LC_ALL':'C.UTF-8','PYTHONNOUSERSITE':'1','PYTHONDONTWRITEBYTECODE':'1','NODE_OPTIONS':'--max-old-space-size=3072','npm_config_userconfig':str(root/'empty-user.npmrc'),'npm_config_globalconfig':str(root/'empty-global.npmrc'),'COREPACK_ENABLE_NETWORK':'0','COREPACK_ENABLE_PROJECT_SPEC':'0','CI':'true'}


def install_argv(pnpm,root):
    return [str(pnpm),'--filter','@hyperlane-xyz/aleo-sdk...','install','--frozen-lockfile','--ignore-scripts','--prefer-offline','--config.ignore-pnpmfile=true','--config.manage-package-manager-versions=false','--config.verify-store-integrity=true','--config.package-import-method=copy','--config.fetch-retries=0','--config.registry=https://registry.npmjs.org/','--config.store-dir='+str(root/'store'),'--config.cache-dir='+str(root/'cache')]


def namespace_argv(spec,root,stage,command,network):
    need(type(network)is bool,'explicit acquisition/offline mode required')
    tools=[checked(spec[k])for k in ('node','pnpm','python','bwrap')]
    command_root=[str(p)for p in tools]
    need(command[0]in command_root,'only pinned ordinary tool command')
    bwrap=tools[-1]
    argv=[str(bwrap),'--unshare-user','--unshare-pid','--unshare-ipc','--unshare-uts','--disable-userns','--assert-userns-disabled','--die-with-parent','--new-session','--cap-drop','ALL','--clearenv','--proc','/proc','--dev','/dev','--size',str(64*1024**2),'--tmpfs','/tmp']
    if not network:argv+=['--unshare-net']
    for alias,target in {'/bin':'usr/bin','/lib':'usr/lib','/lib64':'usr/lib64','/sbin':'usr/sbin'}.items():argv+=['--symlink',target,alias]
    roots=spec['readonly_roots']
    need('/usr'in roots and '/'not in roots and not any(Path(p)==root or root.is_relative_to(Path(p))for p in roots),'exact RO tools/Source roots required')
    for path in roots:argv+=['--ro-bind',path,path]
    if network:
        # Public resolver/CA data only. No host HOME, user npmrc, socket or auth.
        need(set(spec['resolver_files'])=={'/etc/resolv.conf','/etc/hosts','/etc/nsswitch.conf'},'exact public resolver files required')
        for path,row in sorted(spec['resolver_files'].items()):
            argv+=['--ro-bind',str(checked(row)),path]
        argv+=['--ro-bind','/etc/ssl/certs','/etc/ssl/certs']
    argv+=['--bind',str(root),str(root),'--remount-ro','/','--remount-ro','/proc','--chdir',str(stage)]
    for k,v in environment(root,tools[0],tools[1]).items():argv+=['--setenv',k,v]
    return argv+['--',*command]


def inventory(stage):
    """Normal pnpm layout, not a manually decoded package store."""
    payloads=[];links=[]
    for directory,dirs,names in os.walk(stage,followlinks=False):
        for name in dirs+names:
            p=Path(directory)/name
            if p.is_symlink():
                target=p.resolve(strict=True);need(target.is_relative_to(stage),'package symlink escaped owned stage')
                links.append({'path':str(p),'target':os.readlink(p),'resolved':str(target)})
            elif p.is_file():payloads.append(pin(p))
    need(payloads and len(payloads)<=100000 and len(links)<=20000,'bounded nonempty package closure required')
    return sorted(payloads,key=lambda v:v['path']),sorted(links,key=lambda v:v['path'])


def compiler(stage):
    alias=(stage/'typescript/utils/node_modules/typescript').resolve(strict=True)
    need(alias.is_relative_to(stage),'compiler outside owned packages')
    wrapper=alias/'lib/tsc.js';package=alias/'package.json';version=decode(package.read_bytes())
    need(version['name']=='@typescript/typescript6'and version['version']=='6.0.2'and version['dependencies']['@typescript/old']=='npm:typescript@^6','locked6 wrapper manifest changed')
    need(wrapper.read_bytes()in {b'require("@typescript/old/lib/tsc.js");',b'require("@typescript/old/lib/tsc.js");\n'},'unexpected compiler wrapper')
    delegated=(alias.parent/'old').resolve(strict=True);need(delegated.is_relative_to(stage),'delegated compiler escaped packages')
    manifest=delegated/'package.json';data=decode(manifest.read_bytes())
    need(data['name']=='typescript'and data['version']=='6.0.3','locked delegated compiler differs')
    return {'compiler_wrapper':pin(wrapper),'compiler_wrapper_manifest':pin(package),'delegated_compiler':pin(delegated/'lib/tsc.js'),'delegated_compiler_manifest':pin(manifest),'advertised_wrapper_version':'6.0.2','executed_compiler_version':data['version']}


def delegated_lease(spec,phase):
    need(phase in {'packages','build'},'closed SDK service phase required')
    context=load(spec['delegation_context'])
    keys={'unit','invocation','uid','gid','root','root_dev','root_ino','manager_dev','manager_ino','boot_id'}
    need(set(context)==keys and context['unit']=='ziggy-aleo-sdk-'+phase+'-'+spec['run_token']+'.service','exact separate SDK service context required')
    need(context['uid']==os.getuid()and context['gid']==os.getgid(),'unprivileged SDK service identity differs')
    # The separately reviewed SDK controller verifies unit caps/invocation;
    # delegated Lease re-admits exact inode/boot/manager and sibling custody.
    return Lease(spec['run_token'],4*GIB,128,delegation=context,family='sdk-'+phase)


def leaf_caps(lease):
    row={'path':str(lease.path),'device':lease.identity[0],'inode':lease.identity[1],'memory_max_bytes':int(lease.read('memory.max')),'memory_swap_max_bytes':int(lease.read('memory.swap.max')),'pids_max':int(lease.read('pids.max')),'cgroup_line':lease.line,'observed_monotonic_ns':time.monotonic_ns()}
    need(row['memory_max_bytes']==4*GIB and row['memory_swap_max_bytes']==0 and row['pids_max']==128,'actual SDK workload leaf caps differ')
    return row


def cleanup_owned(lease,child,pidfd,waits,signals):
    """Independent SDK cleanup stages; direct child is waited BEFORE adoption."""
    result={'owned_absent':False,'cleanup_errors':[]};direct_waited=child is None
    def failure(stage,error):result['cleanup_errors'].append({'stage':stage,'error_type':type(error).__name__})
    try:
        if lease is not None and lease.populated():lease.kill_owned();signals.append('actual-owned-cgroup-kill')
    except BaseException as error:failure('leaf-kill',error)
    try:
        if child is not None:
            if child.poll()is None:
                need(pidfd is not None,'exact bootstrap pidfd missing')
                try:signal.pidfd_send_signal(pidfd,signal.SIGKILL)
                except ProcessLookupError:pass
                else:signals.append('actual-owned-bootstrap-pidfd-kill')
            code=child.wait(timeout=10);need(type(code)is int,'actual direct wait status required')
            result['last_actual_parent_wait']={'pid':child.pid,'actual_parent_wait':True,'exit_code':code};direct_waited=True
    except BaseException as error:failure('direct-wait',error)
    try:
        if pidfd is not None:os.close(pidfd)
    except BaseException as error:failure('pidfd-close',error)
    if lease is not None:
        try:
            need(direct_waited,'cannot adopt before direct child actual wait')
            end=time.monotonic()+10
            while time.monotonic()<end:
                reap_terminal(lease,waits)
                if not lease.populated():break
                time.sleep(.05)
        except BaseException as error:failure('adopted-waits',error)
        try:result['actual_leaf_caps_after']=leaf_caps(lease)
        except BaseException as error:failure('leaf-readback',error)
        try:
            need(not lease.populated(),'SDK owned leaf remains populated');lease.remove();result['owned_absent']=direct_waited
        except BaseException as error:failure('leaf-absence',error)
    else:result['owned_absent']=direct_waited
    result['owned_absent']=result['owned_absent']and not result['cleanup_errors']
    return result


def stage_deadline(value):
    started=value.get('original_started_ns');deadline=value.get('original_deadline_ns');finished=value.get('final_publication_check_ns')
    return all(type(n)is int for n in (started,deadline,finished))and deadline-started==1800*10**9 and started<=finished<=deadline


def final_pass(value):
    return stage_deadline(value)and value.get('source_unchanged')is True and value.get('owned_absent')is True and not value.get('signals')and not value.get('error')and not value.get('cleanup_errors')and len(value.get('commands',[]))==3 and all(row.get('actual_parent_wait')is True and type(row.get('exit_code'))is int and row['exit_code']==0 for row in value['commands'])and all(row.get('exit_code')==0 for row in value.get('adopted_waits',[]))


def service_receipt(result_pin,owner_pin,phase):
    need(owner_pin is not None,'actual SDK service-client/custody receipt required')
    value=load(result_pin,32*1024**2);payload=load(value['spec'],32*1024**2)
    outer_pin=payload['service_owner_spec']
    from sdk_delegate import approved
    outer=approved(outer_pin);owner=load(owner_pin)
    unit='ziggy-aleo-sdk-'+phase+'-'+outer['run_token']+'.service'
    need(outer.get('root_approved')is True and outer.get('purpose')=='aleo-linux-sdk-service-v1'and outer['phase']==phase and outer['output']==payload['output'],'actual service/payload phase differs')
    need(owner.get('kind')=='aleo-linux-sdk-service-v1'and owner.get('schema')==1 and owner.get('passed')is True and owner['unit']==unit and owner['phase']==phase and owner['spec']==outer_pin and owner['payload_result']==result_pin,'actual outer SDK result binding differs')
    wait=owner['client_wait'];need(wait.get('actual_parent_wait')is True and type(wait.get('exit_code'))is int and wait['exit_code']==0 and wait.get('waits_for_systemd_client_only')is True,'actual systemd-client wait required; no daemon wait credit')
    need(owner['cleanup'].get('owned_cgroup_absent')is True and not owner.get('cleanup_errors')and not owner.get('error'),'actual SDK service custody/drain failed')
    for row in outer['pins']+list(outer['tools'].values())+list(outer['delegation_tools'].values()):checked(row)
    return owner


def admitted(receipt_pin,owner_pin):
    value=load(receipt_pin,32*1024**2)
    need(value.get('kind')=='aleo-linux-locked-packages-v1'and value.get('schema')==1 and value.get('platform')=='linux-x86_64'and value.get('passed')is True and final_pass(value),'actual complete Linux package receipt required')
    service_receipt(receipt_pin,owner_pin,'packages')
    spec=load(value['spec']);need(spec.get('root_approved')is True and spec.get('purpose')=='aleo-linux-locked-packages-v1'and spec.get('caps')==CAPS,'actual bounded package spec required')
    need(value['source_commit']==spec['execution_source_commit']and value['tools']=={k:spec[k]for k in ('node','pnpm','python','bwrap')},'package Source/tool cohort mismatch')
    for row in value['tools'].values():checked(row)
    for row in spec['pins']:checked(row)
    need([row['name']for row in value['commands']]==['node_version','pnpm_version','locked_install'],'exact package commands required')
    root=Path(spec['output']);stage=root/'workspace'
    for row in value['commands']:
        checked(row['stdout']);checked(row['stderr'])
    need(Path(value['commands'][0]['stdout']['path']).read_bytes()==b'v26.12.1\n'and Path(value['commands'][1]['stdout']['path']).read_bytes()==b'12.3.0\n','actual version evidence differs')
    expected_commands=[[spec['node']['path'],'--version'],[spec['pnpm']['path'],'--version'],install_argv(Path(spec['pnpm']['path']),root)]
    for row,expected in zip(value['commands'],expected_commands):
        need(row['argv']==namespace_argv(spec,root,stage,expected,row['name']=='locked_install'),'actual acquisition argv/sandbox differs')
    need(value['stage']==str(stage),'owned package workspace differs')
    source_copies(value['source_origins'],value['source_files'])
    for row in value['source_files']+value['dependency_payloads']:checked(row)
    actual,links=inventory(stage)
    outputs=[stage/'typescript'/name/'dist'for name in ('utils','provider-sdk','aleo-sdk')]
    actual=[row for row in actual if not any(Path(row['path']).is_relative_to(d)for d in outputs)]
    need(actual==sorted(value['source_files']+value['dependency_payloads'],key=lambda row:row['path'])and links==value['symlinks'],'package bytes/membership/symlink layout changed')
    resolved=compiler(stage)
    need(all(value[key]==item for key,item in resolved.items()),'actual locked compiler closure differs')
    return value


def execute(spec_pin):
    spec=load(spec_pin)
    need(spec.get('root_approved')is True and spec.get('purpose')=='aleo-linux-locked-packages-v1'and spec.get('caps')==CAPS,'explicit bounded acquisition authorization required')
    need(platform.system()=='Linux'and platform.machine()=='x86_64','native Linux packages required')
    kernel=kernel_receipt(spec['kernel_receipt']);need(kernel['spec']==spec['kernel_spec'],'acquisition kernel spec differs')
    kernel_inputs=load(spec['kernel_spec'])
    need(kernel_inputs['python']==spec['python']and kernel_inputs['bwrap']==spec['bwrap'],'actual kernel Python/bwrap tools differ')
    for p in spec['pins']+[spec[k]for k in ('node','pnpm','python','bwrap')]:checked(p)
    need(pin(Path(__file__).resolve())in spec['pins'],'exact provisioner Source required')
    repo=Path(spec['repo']);root=Path(spec['output']);need(root.is_absolute()and root.parent.resolve()==root.parent and not root.exists(),'new owned acquisition root required')
    need(free(root.parent)>=6*GIB,'free6GiB floor');root.mkdir(mode=0o700)
    for name in ('home','tmp','store','cache'):(root/name).mkdir(mode=0o700)
    for name in ('empty-user.npmrc','empty-global.npmrc'):(root/name).write_bytes(b'')
    stage=root/'workspace';lease=None;child=None;pidfd=None;waits=[]
    value={'kind':'aleo-linux-locked-packages-v1','schema':1,'platform':'linux-x86_64','passed':False,'source_commit':spec['execution_source_commit'],'spec':spec_pin,'tools':{k:spec[k]for k in ('node','pnpm','python','bwrap')},'source_unchanged':False,'owned_absent':False,'commands':[],'adopted_waits':waits,'signals':[],'network_scope':'ordinary pinned pnpm acquisition only','SDK_build_or_import_or_proof':False}
    started=time.monotonic_ns();deadline=started+1800*10**9
    value['original_started_ns']=started;value['original_deadline_ns']=deadline
    try:
        origins=stage_sources(repo,stage,spec['source_files']);value['source_origins']=origins
        need(ctypes.CDLL(None,use_errno=True).prctl(36,1,0,0,0)==0,'actual subreaper required');lease=delegated_lease(spec,'packages');value['actual_leaf_caps_before']=leaf_caps(lease)
        for name,command,network,expected in [('node_version',[spec['node']['path'],'--version'],False,b'v26.12.1\n'),('pnpm_version',[spec['pnpm']['path'],'--version'],False,b'12.3.0\n'),('locked_install',install_argv(Path(spec['pnpm']['path']),root),True,None)]:
            argv=namespace_argv(spec,root,stage,command,network)
            with (root/(name+'.stdout')).open('xb')as out,(root/(name+'.stderr')).open('xb')as err:
                child=subprocess.Popen([spec['python']['path'],'-I','-B',str(Path(__file__).resolve()),'--bootstrap',json.dumps(argv)],stdin=subprocess.PIPE,stdout=out,stderr=err,env={'PATH':'/usr/bin:/bin','HOME':str(root/'home'),'TMPDIR':str(root/'tmp'),'LC_ALL':'C.UTF-8'},start_new_session=True)
                pidfd=os.pidfd_open(child.pid)
                lease.attach(child.pid);birth=process(child.pid);child.stdin.write(b'GO\n');child.stdin.flush();child.stdin.close()
                while child.poll()is None:
                    need(time.monotonic_ns()<deadline and allocated(root)<=4*GIB and free(root)>=6*GIB,'acquisition time/disk/floor exceeded')
                    need(int(lease.read('memory.current'))<=4*GIB and owner_rss()<=GIB//2 and (root/(name+'.stdout')).stat().st_size+(root/(name+'.stderr')).stat().st_size<=CAPS['log_bytes'],'acquisition memory/log cap');time.sleep(.2)
                status=child.wait();need((root/(name+'.stdout')).stat().st_size+(root/(name+'.stderr')).stat().st_size<=CAPS['log_bytes'],'acquisition final log cap');value['commands'].append({'name':name,'pid':birth['pid'],'start':birth['start'],'group':birth['group'],'argv':argv,'actual_parent_wait':True,'exit_code':status,'stdout':pin(root/(name+'.stdout')),'stderr':pin(root/(name+'.stderr'))})
            os.close(pidfd);pidfd=None
            reap_terminal(lease,waits);need(not lease.populated(),'acquisition live descendants remain')
            need(status==0 and time.monotonic_ns()<deadline,'ordinary locked package command failed/late')
            if expected is not None:need((root/(name+'.stdout')).read_bytes()==expected,'actual package tool version differs')
        payloads,links=inventory(stage);sources=[row['staged']for row in origins];source_copies(origins,sources)
        value.update(compiler(stage));value['stage']=str(stage);value['source_files']=sources;value['dependency_payloads']=[row for row in payloads if row not in sources];value['symlinks']=links
        need(value['dependency_payloads'],'actual installed payload closure absent')
        need(allocated(root)<=4*GIB and free(root)>=6*GIB and owner_rss()<=GIB//2,'acquisition final disk/floor')
    except BaseException as error:value['error']=type(error).__name__+':'+str(error)
    finally:
        value.update(cleanup_owned(lease,child,pidfd,waits,value['signals']))
        pidfd=None
        try:
            for row in spec['source_files']+spec['pins']:checked(row)
            if value.get('source_origins'):source_copies(value['source_origins'],[row['staged']for row in value['source_origins']])
            value['source_unchanged']=True
        except Exception as error:value['preservation_error_type']=type(error).__name__
        value['final_publication_check_ns']=time.monotonic_ns();value['whole_stage_deadline_met']=stage_deadline(value)
        value['passed']=final_pass(value);write(root/'result.json',value)
    return 0 if value['passed']else 1


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--execute-provision',action='store_true');parser.add_argument('--spec');parser.add_argument('--spec-sha');parser.add_argument('--bootstrap');args=parser.parse_args()
    if args.bootstrap:bootstrap(json.loads(args.bootstrap));return 1
    need(args.execute_provision and args.spec and args.spec_sha,'inert: explicit package provision spec required')
    p=Path(args.spec);raw=p.read_bytes();need(hashlib.sha256(raw).hexdigest()==args.spec_sha,'provision spec changed');return execute({'path':str(p),'bytes':len(raw),'sha256':args.spec_sha})

if __name__=='__main__':raise SystemExit(main())
