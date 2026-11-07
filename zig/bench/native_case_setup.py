#!/usr/bin/env python3
"""Explicit CI-only native fixture prerequisites; never start a chain or runtime.

The checked request authorizes exact packages/assets, not native acceptance.
This setup is outside the original600/30 case clock and never rebuilds published
SDKs/helpers/tools/writers. Source scripts run only in the closed list below.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time
import tomllib

ROOT=Path(__file__).resolve().parents[2]
GIB=1024**3
LIMITS={'maximum_setup_seconds':2700,'maximum_setup_RAM_bytes':8*GIB,'maximum_setup_host_growth_bytes':8*GIB,'minimum_host_free_bytes':6*GIB,'maximum_log_bytes':64*1024**2}
PACKAGES=('typescript/tsconfig','typescript/utils','solhint-plugin','solidity','typescript/provider-sdk','typescript/aleo-sdk','typescript/cosmos-types','typescript/cosmos-sdk','typescript/radix-sdk','typescript/forking-sdk','typescript/svm-sdk','starknet','typescript/starknet-sdk','typescript/tron-sdk','typescript/deploy-sdk','typescript/sdk','typescript/http-registry-server','typescript/metrics','typescript/keyfunder','typescript/relayer','typescript/rebalancer','typescript/infra')
SOURCE_SCOPES=(*PACKAGES,'scripts','vectors','patches','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','turbo.json','.nvmrc','.registryrc','.npmrc','.pnpmfile.cjs','zig/integration','zig/bench','zig/tools')
TOOL_NAMES={'anvil','cast','forge','docker','psql','ps','lsof','node','pnpm','sh','git','ldconfig','curl','jq'}
PREDICATE_COMMIT='28b3d3222173392d274a0d0e7aef51bcc96c6a38'


def require(value,message):
    if not value:raise ValueError(message)


def pin(path):
    require(path.is_file() and not path.is_symlink(),'Regular nonsymlink prerequisite input required')
    with path.open('rb') as stream:digest=hashlib.file_digest(stream,'sha256').hexdigest()
    return {'path':str(path),'bytes':path.stat().st_size,'sha256':digest}


def module(name,relative):
    spec=importlib.util.spec_from_file_location(name,ROOT/relative)
    value=importlib.util.module_from_spec(spec)
    # These Source modules use existing sibling imports; -I omits their directory.
    directory=str((ROOT/relative).parent);saved=list(sys.path)
    try:
        sys.path.insert(0,directory);spec.loader.exec_module(value)
    finally:sys.path[:]=saved
    return value


def build_commands(repo,tools,stage):
    """Exact Source-equivalent build order; no turbo, prebuild or fetch hooks."""
    pnpm,node,forge,sh=(str(tools[name]) for name in ('pnpm','node','forge','sh'))
    rows=[]
    def add(name,cwd,argv,environment=None):rows.append({'name':name,'cwd':str(cwd),'argv':argv,'extra_environment':environment or {}})
    add('locked-ignore-scripts-install',repo,[pnpm,'--filter','@hyperlane-xyz/infra...','install','--frozen-lockfile','--ignore-scripts','--ignore-pnpmfile','--package-import-method=copy','--store-dir',str(stage/'store'),'--cache-dir',str(stage/'cache')])
    add('locked-soldeer',repo/'solidity',[forge,'soldeer','install','--config-location','foundry','--threads','1'])
    for path in PACKAGES:
        cwd=repo/path
        if path in {'typescript/tsconfig','solhint-plugin','typescript/infra'}:continue
        if path=='solidity':
            add('core-hardhat',cwd,[pnpm,'run','hardhat-esm','compile','--concurrency','1'])
            add('core-tsc',cwd,[pnpm,'exec','tsc'])
            add('core-typechain-fix',cwd,[node,'fix-typechain-ethers.mjs','./dist/typechain/factories'])
            add('core-export',cwd,[sh,'./exportBuildArtifact.sh'])
            # The imported Tron SDK requires these actual outputs even for EVM.
            for target in ('core','warp'):add('tron-'+target,cwd,[pnpm,'run','hardhat-tron','compile','--force','--no-typechain','--concurrency','1'],{'TRON_BUILD_TARGET':target})
            add('tron-typechain',cwd,[pnpm,'run','hardhat-tron','typechain'])
            add('tron-typechain-tsc',cwd,[pnpm,'exec','tsc','--project','tsconfig.tron-typechain.json'])
            add('tron-typechain-fix',cwd,[node,'fix-typechain-ethers.mjs','./dist/tron/typechain/factories'])
        else:
            argv=[pnpm,'exec','tsc']
            if path=='typescript/utils':argv+=['-p','tsconfig.build.json']
            add(path.replace('/','-')+'-tsc',cwd,argv)
    return rows


def version_constants(repo):
    package=json.loads((repo/'solidity/package.json').read_text())['version']
    require(re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+',package),'Closed Solidity source version expected')
    require('string public constant PACKAGE_VERSION = "'+package+'";' in (repo/'solidity/contracts/PackageVersioned.sol').read_text(),'Tracked Solidity version differs; do not rewrite Source')
    require("export const CONTRACTS_PACKAGE_VERSION = '"+package+"';" in (repo/'solidity/core-utils/index.ts').read_text(),'Tracked TypeScript contract version differs; do not rewrite Source')


def snapshot(repo,git):
    env={'PATH':'/usr/bin:/bin','LC_ALL':'C','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_OPTIONAL_LOCKS':'0'}
    rows={};count=0
    def walk(base,prefix,scopes,depth):
        nonlocal count
        require(depth<=8,'Bounded prerequisite submodule depth required')
        subprocess.run([str(git),'diff','--quiet','--no-ext-diff','--no-textconv','HEAD','--',*scopes],cwd=base,env=env,capture_output=True,timeout=10,check=True)
        result=subprocess.run([str(git),'ls-files','--stage','-z','--',*scopes],cwd=base,env=env,capture_output=True,timeout=10,check=True)
        require(len(result.stdout)<=8*1024**2,'Bounded tracked prerequisite Source list required')
        local={}
        for record in result.stdout.split(b'\0'):
            if not record:continue
            count+=1;require(count<=25000,'Bounded prerequisite Source count required')
            header,name=record.split(b'\t',1);parts=header.split();mode=parts[0].decode();relative=os.fsdecode(name);path=base/relative;logical=str(prefix/relative)
            require(path.resolve(strict=True).is_relative_to(repo),'Prerequisite Source escaped checkout')
            if mode=='160000':
                require(path.is_dir() and not path.is_symlink(),'Actual initialized Source submodule required')
                head=subprocess.run([str(git),'rev-parse','HEAD'],cwd=path,env=env,capture_output=True,timeout=5,check=True).stdout.strip().decode()
                require(head==parts[1].decode(),'Source submodule uninitialized/commit differs: '+logical)
                local[logical]={'gitlink':head,'tracked_inputs':walk(path,prefix/relative,[],depth+1)}
            elif mode=='120000':
                require(path.is_symlink(),'Tracked Source symlink missing')
                local[logical]={'symlink':os.readlink(path),'target':pin(path.resolve(strict=True))}
            else:local[logical]=pin(path)
        return local
    rows=walk(repo,Path('.'),SOURCE_SCOPES,0)
    require(rows,'Tracked prerequisite Source closure missing')
    return rows


def soldeer_expected(repo):
    rows=tomllib.loads((repo/'solidity/soldeer.lock').read_text())['dependencies']
    require(len(rows)==10 and len({row['name'] for row in rows})==10,'Exact Source Soldeer closure differs')
    expected={}
    for row in rows:
        if 'git' not in row:
            require(row['name']=='forge-std' and row.get('checksum') and row.get('integrity'),'Unknown non-Git Soldeer dependency')
            continue
        commit=row['rev']
        if row['name']=='@predicate-contracts':require(commit=='v2.2.2','Predicate Source version changed');commit=PREDICATE_COMMIT
        require(re.fullmatch('[0-9a-f]{40}',commit),'Immutable Soldeer Git revision required')
        expected[row['name']+'-'+row['version']]=commit
    return expected


def output_files(repo):
    roots=[repo/'solidity/artifacts',repo/'solidity/artifacts-tron',*[repo/path/'dist' for path in PACKAGES if path not in {'typescript/tsconfig','solhint-plugin','typescript/infra'}]]
    output={}
    for root in roots:
        require(root.is_dir() and not root.is_symlink(),'Actual Solidity output missing')
        for path in sorted(root.rglob('*')):
            require(not path.is_symlink(),'Contract output link rejected')
            if path.is_file():output[str(path.relative_to(repo))]=pin(path)
    require(0<len(output)<=25000 and 'solidity/dist/buildArtifact.json' in output and any(name.startswith('solidity/artifacts-tron/') and name.endswith('.json') for name in output),'Both compiler outputs and actual deployment artifact required')
    return output


def create_tool_aliases(stage,tools):
    directory=stage/'bin';directory.mkdir()
    for name,path in tools.items():
        alias=directory/name
        alias.symlink_to(path)
        require(alias.resolve(strict=True)==path and pin(path)['sha256'],'Owned tool alias differs')
    verify_tool_aliases(stage,tools)
    return directory


def verify_tool_aliases(stage,tools):
    directory=stage/'bin'
    require(directory.is_dir() and not directory.is_symlink() and {path.name for path in directory.iterdir()}==set(tools),'Owned tool alias closure changed')
    for name,path in tools.items():
        alias=directory/name
        require(alias.is_symlink() and alias.resolve(strict=True)==path,'Owned tool alias target changed: '+name)


def clean_environment(stage,tools):
    paths=[str(stage/'bin'),'/usr/bin','/bin']
    return {'PATH':':'.join(dict.fromkeys(paths)),'HOME':str(stage/'home'),'TMPDIR':str(stage/'tmp'),'XDG_CACHE_HOME':str(stage/'cache'),'CI':'true','LC_ALL':'C.UTF-8','NODE_OPTIONS':'--max-old-space-size=4096','PNPM_DISABLE_SELF_UPDATE_CHECK':'1','NO_UPDATE_NOTIFIER':'1','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_TERMINAL_PROMPT':'0','GIT_ASKPASS':'/bin/false','npm_config_ignore_scripts':'true','npm_config_audit':'false','npm_config_fund':'false','HARDHAT_DISABLE_TELEMETRY':'1','TURBO_TELEMETRY_DISABLED':'1'}


def discover_libraries(ldconfig):
    import platform
    query=subprocess.run([str(ldconfig),'-p'],env={'PATH':'/usr/bin:/bin','LC_ALL':'C'},capture_output=True,timeout=5,check=True)
    require(len(query.stdout)<=1024**2,'Bounded linker cache required')
    expected_machine={'x86_64':62,'aarch64':183}[platform.machine()]
    result={}
    for name in ('libcurl.so.4','libcrypto.so.3','libpq.so.5'):
        found=set()
        for line in query.stdout.decode().splitlines():
            if not line.strip().startswith(name+' ') or ' => ' not in line:continue
            path=Path(line.split(' => ',1)[1].strip()).resolve(strict=True)
            require(path.is_absolute(),'Absolute library required')
            with path.open('rb') as stream:header=stream.read(20)
            if header[:6]==b'\x7fELF\x02\x01' and int.from_bytes(header[18:20],'little')==expected_machine:found.add(path)
        require(len(found)==1,'Exactly one native system library required: '+name)
        result[name]=pin(next(iter(found)))
    return result


def library_probe():
    parser=argparse.ArgumentParser();parser.add_argument('--probe-system-libraries',action='store_true');parser.add_argument('--ldconfig',type=Path,required=True);parser.add_argument('--ldconfig-sha256',required=True);parser.add_argument('--versions',action='store_true');args=parser.parse_args()
    require(pin(args.ldconfig)['sha256']==args.ldconfig_sha256,'Linker-cache tool changed')
    libraries=discover_libraries(args.ldconfig)
    if not args.versions:
        print(json.dumps({'HYPERLANE_CURL_LIBRARY':libraries['libcurl.so.4'],'HYPERLANE_CLOUD_CURL_LIBRARY':libraries['libcurl.so.4'],'HYPERLANE_LIBCRYPTO_LIBRARY':libraries['libcrypto.so.3']},sort_keys=True));return
    import ctypes
    curl=ctypes.CDLL(libraries['libcurl.so.4']['path']);curl.curl_version.restype=ctypes.c_char_p
    crypto=ctypes.CDLL(libraries['libcrypto.so.3']['path']);crypto.OpenSSL_version_num.restype=ctypes.c_ulong
    pq=ctypes.CDLL(libraries['libpq.so.5']['path']);pq.PQlibVersion.restype=ctypes.c_int
    print(json.dumps({'libraries':libraries,'curl_version':curl.curl_version().decode(),'OpenSSL_version_num':crypto.OpenSSL_version_num(),'PQlibVersion':pq.PQlibVersion(),'no_socket_or_node_started':True},sort_keys=True))



def validate_hypd_policy(policy, architecture):
    require(policy['name']=='hypd' and policy['architecture']==architecture,'Exact native Hypd/platform policy required')
    source=policy['source_url']
    require(re.fullmatch(r'https://github\.com/(?:bcp-innovations|hyperlane-xyz)/hyperlane-cosmos/releases/download/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+',source) and all(part not in {'.','..'} for part in source.split('/')[-2:]),'Hypd requires the reviewed official raw release URL')
    return source


def validate_pg_image(row, policy):
    aliases={policy['canonical_digest'],'docker.io/library/'+policy['canonical_digest']}
    require(isinstance(row,dict) and row.get('Id')==policy['image_id'] and row.get('Os')=='linux' and row.get('Architecture')==policy['architecture'] and bool(aliases & set(row.get('RepoDigests',[]))),'Approved PG image ID/RepoDigest/native platform differs')


def prepare_pg_image():
    import tempfile
    parser=argparse.ArgumentParser();parser.add_argument('--prepare-pg-image',action='store_true');parser.add_argument('--request',type=Path,required=True);parser.add_argument('--request-sha256',required=True);parser.add_argument('--docker',type=Path,required=True);parser.add_argument('--docker-sha256',required=True);parser.add_argument('--config',type=Path,required=True);parser.add_argument('--deadline-ns',type=int,required=True);args=parser.parse_args()
    require(pin(args.request)['sha256']==args.request_sha256 and pin(args.docker)['sha256']==args.docker_sha256,'PG setup policy/tool changed')
    request=module('pg_case_request','zig/bench/native_case_ci.py').validate_request(json.loads(args.request.read_text()));policy=request['postgres']
    require(args.config.is_absolute() and not args.config.exists() and not args.config.is_symlink(),'Exclusive PG setup Docker config required')
    args.config.mkdir(mode=0o700);(args.config/'config.json').write_text('{}\n');calls=[]
    env={'PATH':'/usr/bin:/bin','HOME':str(args.config),'LC_ALL':'C'}
    base=[str(args.docker),'--host','unix:///var/run/docker.sock','--config',str(args.config)]
    def call(arguments, missing=None):
        child=None;status=None
        with tempfile.TemporaryFile(dir=args.config) as stdout,tempfile.TemporaryFile(dir=args.config) as stderr:
            try:
                require(time.monotonic_ns()<args.deadline_ns,'Original setup deadline expired')
                child=subprocess.Popen(base+arguments,env=env,stdin=subprocess.DEVNULL,stdout=stdout,stderr=stderr)
                while os.waitid(os.P_PID,child.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT) is None:
                    require(time.monotonic_ns()<args.deadline_ns and os.fstat(stdout.fileno()).st_size<=2*1024**2 and os.fstat(stderr.fileno()).st_size<=2*1024**2,'PG image command deadline/output limit');time.sleep(.1)
            finally:
                if child is not None:
                    if os.waitid(os.P_PID,child.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT) is None:child.kill()
                    status=child.wait(timeout=3)
            require(os.fstat(stdout.fileno()).st_size<=2*1024**2 and os.fstat(stderr.fileno()).st_size<=2*1024**2,'PG image response bound')
            stdout.seek(0);stderr.seek(0);wire=stdout.read();detail=stderr.read().decode()
        calls.append({'arguments':arguments,'pid':child.pid,'actual_parent_wait':True,'exit_code':status,'stdout_sha256':hashlib.sha256(wire).hexdigest(),'stderr_sha256':hashlib.sha256(detail.encode()).hexdigest()})
        if missing is not None and status==1 and detail.strip() in {'Error: No such object: '+missing,'Error response from daemon: No such image: '+missing}:return None
        require(status==0,'PG image setup command failed');return wire
    def inspect(reference,missing=False):
        wire=call(['image','inspect',reference],reference if missing else None)
        if wire is None:return None
        rows=json.loads(wire);require(isinstance(rows,list) and len(rows)==1,'One actual PG image required');return rows[0]
    record={'schema':1,'passed':False,'image_policy':policy,'calls':calls,'tag_created':False,'no_container_or_node_started':True,'native_case_acceptance':False}
    try:
        tag=inspect(policy['image'],True)
        if tag is not None:validate_pg_image(tag,policy)
        else:
            immutable=inspect(policy['canonical_digest'],True)
            if immutable is None:
                call(['pull','--platform','linux/'+policy['architecture'],policy['canonical_digest']]);immutable=inspect(policy['canonical_digest'])
            validate_pg_image(immutable,policy)
            # Never replace a foreign tag, including a tag created during pull.
            existing=inspect(policy['image'],True)
            if existing is None:call(['image','tag',policy['image_id'],policy['image']]);record['tag_created']=True
            else:validate_pg_image(existing,policy)
        final=inspect(policy['image']);validate_pg_image(final,policy)
        record['actual_image']={key:final[key] for key in ('Id','Os','Architecture','RepoDigests')}
        require(time.monotonic_ns()<args.deadline_ns,'PG preparation exceeded original setup deadline');record['passed']=True
    finally:
        print(json.dumps(record,sort_keys=True))
    require(record['passed'],'PG image prerequisite failed')

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request',type=Path,required=True);parser.add_argument('--request-sha256',required=True);parser.add_argument('--execution-source-commit',required=True);parser.add_argument('--repo',type=Path,required=True);parser.add_argument('--output',type=Path,required=True);parser.add_argument('--tools',type=Path,required=True);parser.add_argument('--tools-sha256',required=True);parser.add_argument('--execute',action='store_true')
    args=parser.parse_args()
    dispatch=module('case_dispatch','zig/bench/native_case_ci.py')
    require(pin(args.request)['sha256']==args.request_sha256,'Reviewed setup request changed')
    request=dispatch.validate_request(json.loads(args.request.read_text()))
    require(request['scenario'] in {'evm','cosmosnative'},'CW blocked until exact Wasm/library bundle composition is implemented')
    is_evm=request['scenario']=='evm'
    require(args.repo.is_absolute() and args.repo.resolve(strict=True)==args.repo and args.output.is_absolute() and not args.output.exists() and not args.output.is_symlink() and not args.output.is_relative_to(args.repo),'Exclusive CI setup outside canonical checkout required')
    require(pin(args.tools)['sha256']==args.tools_sha256,'Explicit setup tool receipt changed')
    tool_rows=json.loads(args.tools.read_text());require(set(tool_rows)==TOOL_NAMES,'Closed preinstalled CI tool set required')
    tools={name:Path(row['path']) for name,row in tool_rows.items()}
    for name,path in tools.items():require(pin(path)==tool_rows[name] and path.is_absolute() and os.access(path,os.X_OK),'Preinstalled tool changed/nonexecutable: '+name)
    if is_evm:version_constants(args.repo)
    plan={'schema':1,'root_approved_for_setup_only':True,'execution_source_commit':args.execution_source_commit,'scenario':request['scenario'],'limits':LIMITS,'commands':build_commands(args.repo,tools,args.output) if is_evm else [],'native_case_acceptance':False,'SDK_or_helper_rebuild':False}
    if not args.execute:
        print(json.dumps(plan,indent=2));return
    require(sys.platform=='linux' and os.environ.get('GITHUB_ACTIONS')=='true' and args.repo==ROOT,'Actual setup uses this CI checkout only; no local or cross-checkout package/build execution')
    require(shutil.disk_usage(args.output.parent).free>=6*GIB,'6GiB setup floor')
    require(not (args.repo/'node_modules').exists(),'Fresh checkout node_modules required; never replace foreign dependencies')
    args.output.mkdir(mode=0o700)
    for name in ('home','tmp','cache','logs'): (args.output/name).mkdir()
    create_tool_aliases(args.output,tools)
    (args.output/'plan.json').write_text(json.dumps(plan,indent=2)+'\n')
    before=snapshot(args.repo,tools['git']);expected_deps=soldeer_expected(args.repo) if is_evm else {}
    env=clean_environment(args.output,tools);owner=module('case_owner','zig/bench/cold_matrix_owner.py');owner.enable_subreaper()
    deadline=time.monotonic()+LIMITS['maximum_setup_seconds'];initial_free=shutil.disk_usage(args.output).free
    checks=[];failure=None;hpack=None;contracts={};registry={};final_tools={};samples=[]
    result={'schema':1,'passed':False,'execution_source_commit':args.execution_source_commit,'scenario':request['scenario'],'source_before':before,'source_after':{},'checks':checks,'tools':final_tools,'contract_artifacts':contracts,'hpack':None,'registry':registry,'explicit_environment':{}}
    def guard():
        free=shutil.disk_usage(args.output).free
        require(time.monotonic()<deadline and free>=6*GIB and initial_free-free<=8*GIB,'Original setup deadline/host-growth/free guard')
    def run(name,argv,cwd=None,extra=None):
        guard();child=None;known={};groups={};cleanup=None;error=None;log=args.output/'logs'/(name+'.log')
        try:
            with log.open('xb') as stream:
                child=subprocess.Popen(argv,cwd=cwd or args.repo,env={**env,**(extra or {})},stdin=subprocess.DEVNULL,stdout=stream,stderr=subprocess.STDOUT,start_new_session=True)
                groups[child.pid]=child.pid
                while os.waitid(os.P_PID,child.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT) is None:
                    rows=owner.processes();owned=owner.owned_processes(rows,child.pid,known,groups,True);ram=sum(r['rss_bytes'] for r in owned.values());guard()
                    require(ram<=8*GIB and log.stat().st_size<=LIMITS['maximum_log_bytes'],'Setup RSS/log guard')
                    samples.append({'phase':name,'monotonic_ns':time.monotonic_ns(),'owned_RAM_bytes':ram,'host_free_bytes':shutil.disk_usage(args.output).free});time.sleep(.2)
        except BaseException as caught:error=caught
        finally:
            saved={sig:signal.signal(sig,signal.SIG_IGN) for sig in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP)}
            try:
                if child is not None:
                    try:cleanup=owner.stop_owned(child,known,groups,grace_seconds=10,kill_seconds=3)
                    except BaseException as cleanup_error:
                        cleanup={'clean':False,'actual_parent_wait':False,'error':{'type':type(cleanup_error).__name__,'message':str(cleanup_error)}}
                        if error is None:error=cleanup_error
            finally:
                for sig,value in saved.items():signal.signal(sig,value)
            code=None if child is None else child.returncode
            checks.append({'name':name,'exit_code':code,'actual_parent_wait':bool(cleanup and cleanup['actual_parent_wait']),'log':pin(log)})
            evidence={'argv':argv,'cwd':str(cwd or args.repo),'cleanup':cleanup,'error':None if error is None else {'type':type(error).__name__,'message':str(error)}}
            (args.output/'logs'/(name+'.command.json')).write_text(json.dumps(evidence,indent=2)+'\n')
        if error is not None:raise error
        require(code==0 and cleanup['clean'] and not cleanup['signals'],'Setup command failed/required residual signals')
        require(log.stat().st_size<=LIMITS['maximum_log_bytes'],'Postflight setup log guard')
        require(snapshot(args.repo,tools['git'])==before,'Tracked prerequisite source changed')
        guard();return log
    try:
        head=run('execution-head',[str(tools['git']),'rev-parse','HEAD'])
        require(head.read_text().strip()==args.execution_source_commit,'Execution checkout commit differs')
        for name,argv,expected in ([('node-version',[str(tools['node']),'--version'],'v26.12.1'),('pnpm-version',[str(tools['pnpm']),'--version'],'12.3.0')] if is_evm else []):require(run(name,argv).read_text().strip()==expected,'Pinned version differs: '+name)
        for name in (('forge','anvil','cast') if is_evm else ('cast',)):require(re.search(r'(?<!\d)1\.5\.0(?!\d)',run(name+'-version',[str(tools[name]),'--version']).read_text()),'Pinned Foundryv1.5.0 differs')
        run('approved-pg-image-prerequisite',[sys.executable,'-I','-B',str(Path(__file__).resolve()),'--prepare-pg-image','--request',str(args.request),'--request-sha256',args.request_sha256,'--docker',str(tools['docker']),'--docker-sha256',pin(tools['docker'])['sha256'],'--config',str(args.output/'docker-config'),'--deadline-ns',str(int(deadline*1e9))])
        for row in plan['commands']:
            run(row['name'],row['argv'],Path(row['cwd']),row['extra_environment'])
            if row['name']=='locked-soldeer':
                for name,commit in expected_deps.items():require(run('soldeer-rev-'+name.replace('@','').replace('/','-'),[str(tools['git']),'-C',str(args.repo/'solidity/dependencies'/name),'rev-parse','HEAD']).read_text().strip()==commit,'Soldeer pinned revision differs')
        registry_path=None
        if is_evm:
            registry_path=args.output/'registry'
            run('registry-clone',[str(tools['git']),'clone','--no-checkout','--filter=blob:none','https://github.com/hyperlane-xyz/hyperlane-registry.git',str(registry_path)])
            commit=request['prerequisites']['registry_commit'];require((args.repo/'.registryrc').read_text().strip()==commit,'Requested registry must equal Source .registryrc')
            run('registry-checkout',[str(tools['git']),'-C',str(registry_path),'checkout','--detach',commit])
            require(run('registry-head',[str(tools['git']),'-C',str(registry_path),'rev-parse','HEAD']).read_text().strip()==commit,'Actual registry commit differs')
            registry.update({'path':str(registry_path),'commit':commit})
            # Resolution only. No SDK import, deployment, Kathy or chain CLI main.
            resolver="const{createRequire}=require('node:module');const{resolve}=require('node:path');const r=createRequire(resolve('typescript/infra/package.json'));const e=createRequire(r.resolve('tsx/package.json'));const x=createRequire(e.resolve('esbuild/package.json'));console.log(x.resolve('@esbuild/linux-'+({x64:'x64',arm64:'arm64'})[process.arch]+'/bin/esbuild'));"
            esbuild=Path(run('resolve-esbuild-only',[str(tools['node']),'-e',resolver]).read_text().strip()).resolve(strict=True)
            final_tools.update({name:pin(tools[name]) for name in ('cast','docker','psql','ps','lsof','anvil','node','sh')});final_tools.update({'pnpm_launcher':pin(tools['pnpm']),'pnpm_native':pin(tools['pnpm']),'esbuild':pin(esbuild)})
            contracts.update(output_files(args.repo))
        else:
            import platform
            cli_policy=request['prerequisites']['native_cli']
            source=validate_hypd_policy(cli_policy,{'x86_64':'amd64','aarch64':'arm64'}[platform.machine()])
            cli=args.output/'hypd'
            run('download-exact-native-cli',[str(tools['curl']),'--silent','--show-error','--fail','--location','--proto','=https','--proto-redir','=https','--noproxy','*','--connect-timeout','15','--max-time',str(max(1,int(deadline-time.monotonic()))),'--max-filesize',str(cli_policy['bytes']),'--output',str(cli),source])
            actual=pin(cli);require(actual['bytes']==cli_policy['bytes'] and actual['sha256']==cli_policy['sha256'],'Native CLI differs from exact reviewed asset')
            with cli.open('rb') as stream:header=stream.read(24)
            machine={'amd64':62,'arm64':183}[cli_policy['architecture']]
            require(header[:6]==b'\x7fELF\x02\x01' and int.from_bytes(header[18:20],'little')==machine and int.from_bytes(header[16:18],'little') in {2,3},'Native CLI ELF/header/platform differs')
            cli.chmod(0o755)
            module('case_cli_elf','zig/bench/native_case_tools.py').validate_elf(cli,machine)
            run('native-cli-version-readonly',[str(cli),'version','--long'])
            final_tools.update({name:pin(tools[name]) for name in ('cast','docker','psql','ps','lsof')});final_tools['native_cli']=pin(cli)
            registry.update({'path':None,'commit':None})
        library_log=run('system-libraries',[sys.executable,'-I','-B',str(Path(__file__).resolve()),'--probe-system-libraries','--ldconfig',str(tools['ldconfig']),'--ldconfig-sha256',pin(tools['ldconfig'])['sha256']])
        system_libraries=json.loads(library_log.read_text())
        run('system-library-versions',[sys.executable,'-I','-B',str(Path(__file__).resolve()),'--probe-system-libraries','--ldconfig',str(tools['ldconfig']),'--ldconfig-sha256',pin(tools['ldconfig'])['sha256'],'--versions'])
        run('hpack-exact-wheel',[sys.executable,'-I','-B',str(args.repo/'zig/tools/h2_dependency.py'),'--destination',str(args.output/'hpack'),'--download'])
        hpack=pin(args.output/'hpack/evidence/descriptor.json');result['hpack']=hpack
        result['explicit_environment']={'PATH':env['PATH'],**({'REGISTRY_URI':str(registry_path)} if is_evm else {'E2E_HYPD_PATH':str(args.output/'hypd')}),**{key:row['path'] for key,row in system_libraries.items()}}
        result['source_after']=snapshot(args.repo,tools['git']);require(result['source_after']==before,'Final prerequisite Source changed')
        require(pin(args.request)['sha256']==args.request_sha256 and pin(args.tools)['sha256']==args.tools_sha256,'Setup policy/tools changed');guard();result['passed']=True
    except BaseException as error:failure=error
    finally:
        try:
            result['source_after']=snapshot(args.repo,tools['git'])
            require(result['source_after']==before,'Postflight tracked prerequisite source changed')
            for name,path in tools.items():require(pin(path)==tool_rows[name],'Postflight setup tool changed: '+name)
            verify_tool_aliases(args.output,tools)
            guard()
        except BaseException as postflight_error:
            result['passed']=False
            if failure is None:failure=postflight_error
        owner_result={'schema':1,'passed':failure is None and result['passed'],'error':None if failure is None else {'type':type(failure).__name__,'message':str(failure)},'samples':samples,'native_case_acceptance':False,'SDK_or_helper_rebuild':False,'execution_plan':pin(args.output/'plan.json')}
        with (args.output/'setup-owner-result.json').open('x') as stream:json.dump(owner_result,stream,indent=2);stream.write('\n')
        with (args.output/'local-stage.json').open('x') as stream:json.dump(result,stream,indent=2);stream.write('\n')
    if failure is not None:raise failure


if __name__=='__main__':
    def interrupted(sig,frame):raise RuntimeError('Prerequisite setup interrupted: '+str(sig))
    for sig in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP):signal.signal(sig,interrupted)
    if '--probe-system-libraries' in sys.argv:library_probe()
    elif '--prepare-pg-image' in sys.argv:prepare_pg_image()
    else:main()
