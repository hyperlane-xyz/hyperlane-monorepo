#!/usr/bin/env python3
"""One reviewed Linux native case; reusable ownership code, no builds or downloads."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import resource
import select
import shutil
import signal
import stat
import subprocess
import sys
import time

spec = importlib.util.spec_from_file_location('cold_matrix_owner', Path(__file__).with_name('cold_matrix_owner.py'))
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)
RESTART_CLOCK_SCOPE = 'One complete canonical/SDK/checkpoint/readiness proof BEFORE the first live anchor; then continuous actual child/config/authority/admin/no-resubmission and paired role-RPC checks; full canonical/SDK/SQL/checkpoint and stopped-reader proof again at final acceptance. No heavy proof is claimed per live sample.'
RESTART_DEADLINE_SCOPE = 'Python first after_restart entry+120s; not the earlier Rust caller Instant.'
RESTART_FINAL_SCOPE = 'Fresh final canonical/SDK/checkpoint/SQL and stopped-reader verification after live window and clean actual parent waits.'

GIB = 1024 ** 3
LABEL_ROOT = 'io.hyperlane.ziggy.case-root'
LABEL_PID = 'io.hyperlane.ziggy.harness-pid'
LABEL_TOKEN = 'io.hyperlane.ziggy.run-token'
GENERATED = ('typescript/infra/config/environments/test/ism/addresses.json', 'typescript/infra/config/environments/test/ism/verification.json', 'typescript/infra/config/environments/test/core/addresses.json', 'typescript/infra/config/environments/test/core/verification.json', 'rust/main/config/testnet_config.json', 'rust/main/app-contexts/testnet_config.json')
FILTERS = {'tron':['--exact','tron::test::test_run','--nocapture','--test-threads=1'],'radix':['--exact','radix::test::test_run','--nocapture','--test-threads=1'],'sealevel-composite':['--exact','sealevel::warp_route_composite_ism::test::test_warp_route_custom_composite_ism_process','--nocapture','--test-threads=1'],'sealevel':['--exact','sealevel::test::test_run','--nocapture','--test-threads=1'],'evm': [], 'cosmosnative': ['--exact', 'cosmosnative::test::test_run', '--nocapture', '--test-threads=1'], 'cosmwasm': ['--exact', 'cosmos::test::test_run', '--nocapture', '--test-threads=1'], 'starknet': ['--exact', 'starknet::test::test_run', '--nocapture', '--test-threads=1']}


def require(value, message):
    if not value: raise ValueError(message)


def pin(path):
    require(path.is_file() and not path.is_symlink(), 'Regular nonsymlink case input required')
    with path.open('rb') as stream: digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    return {'path': str(path), 'bytes': path.stat().st_size, 'sha256': digest}


def checked(row, executable=False):
    require(isinstance(row, dict) and set(row) == {'path', 'bytes', 'sha256'}, 'Exact case artifact descriptor required')
    path = Path(row['path'])
    require(path.is_absolute() and '..' not in path.parts and pin(path) == row and (not executable or os.access(path, os.X_OK)), 'Case input changed/not executable')
    return path


def admitted_zig_diagnostic_catalog(plan,repo):
    catalog=plan['diagnostic_zig_sources']
    require(isinstance(catalog,dict)and 0<len(catalog)<=768,'Bounded admitted Zig diagnostic Source catalog required')
    total=0
    for name,row in catalog.items():
        require(isinstance(name,str)and re.fullmatch(r'zig/src/[A-Za-z0-9_./-]+\.zig',name)and str(Path(name))==name and'..'not in Path(name).parts,'Canonical admitted Zig Source name required')
        require(isinstance(row,dict)and set(row)=={'path','bytes','sha256'}and row['path']==str(repo/name)and type(row['bytes'])is int and 0<row['bytes']<=1024**2 and isinstance(row['sha256'],str)and re.fullmatch('[0-9a-f]{64}',row['sha256'])and row in plan['required_inputs'],'Zig diagnostic Source must be exact required input')
        total+=row['bytes']
    require(total<=16*1024**2,'Bounded Zig diagnostic Source bytes required')
    return catalog



def admitted_radix_submit_context(plan,repo):
    names=('rust/main/chains/hyperlane-radix/src/error.rs','rust/main/hyperlane-core/src/error.rs','rust/main/hyperlane-core/src/rpc_clients/error.rs')
    catalog=plan.get('diagnostic_rust_sources',{});lock=plan.get('diagnostic_radix_client_lock')
    require(isinstance(catalog,dict)and all(name in catalog for name in names),'Fixed Radix error Source contracts required')
    rows=[*catalog.values(),lock]
    require(len(rows)<=256,'Original bounded Radix Source count includes lock')
    total=0
    for name,row in [*catalog.items(),('rust/main/Cargo.lock',lock)]:
        require(isinstance(row,dict)and set(row)=={'path','bytes','sha256'}and row['path']==str(repo/name)and type(row['bytes'])is int and 0<row['bytes']<=1024**2 and isinstance(row['sha256'],str)and re.fullmatch('[0-9a-f]{64}',row['sha256'])and row in plan['required_inputs'],'Radix diagnostic Source must be exact required input')
        total+=row['bytes']
    require(total<=4*1024**2,'Original bounded Radix Source bytes includes lock')
    return lock


def load_plan(path, expected_sha):
    require(pin(path)['sha256'] == expected_sha, 'Approved launch plan changed')
    plan = json.loads(path.read_text())
    require(type(plan.get('schema')) is int and plan['schema'] == 1 and plan.get('root_approved') is True and plan.get('scenario') in FILTERS, 'Approved initial native family plan required')
    require(all(type(plan.get(k)) is int and plan[k] == v for k,v in {'maximum_owned_RAM_bytes':8*GIB,'maximum_case_allocated_bytes':8*GIB,'minimum_host_free_bytes':6*GIB,'maximum_wall_seconds':3600,'confirm_seconds':600,'grace_seconds':30,'clean_fixture_parent_waits_required':1 if plan['scenario']in{'sealevel-composite','radix'}else 2 if plan['scenario']in{'sealevel','tron'}else 3}.items()), 'Native lifecycle/resource policy changed')
    manifest_path = checked(plan['manifestArtifact'])
    manifest = json.loads(manifest_path.read_text())
    require(manifest['scenario'] == plan['scenario'] and manifest['implementation'] == 'zig', 'Wrong native scenario/runtime')
    helper = checked(plan['harnessArtifact'], True)
    require(plan['harness_argv'] == [str(helper), *FILTERS[plan['scenario']]], 'Arbitrary/mismatched helper invocation')
    require(Path(plan['harness_cwd']).is_absolute() and Path(plan['harness_cwd']).resolve(strict=True) == Path(plan['harness_cwd']), 'Canonical harness cwd required')
    case = Path(manifest['task_root'])
    require(case.is_absolute() and not case.is_symlink() and case.resolve(strict=True) == case and len(os.fsencode(case/'evidence/controller.sock')) < 100, 'Canonical short owned case root required')
    approval = json.loads(checked(manifest['execution_approval']).read_text())
    inputs = json.loads(checked(manifest['case_inputs']).read_text())
    require(approval.get('root_approved') is True and approval['harness'] == plan['harnessArtifact'] and approval['scenario'] == plan['scenario'] and approval['runtime_source_commit'] == manifest['runtime_source_commit'], 'Launch helper/approval/runtime mismatch')
    checked(plan['lsofArtifact'], True)
    require(isinstance(plan['required_inputs'], list) and plan['required_inputs'], 'Pinned execution closure required')
    for row in plan['required_inputs']: checked(row)
    if plan['scenario']in{'sealevel','sealevel-composite'}:admitted_zig_diagnostic_catalog(plan,Path(__file__).resolve().parents[2])
    if plan['scenario']=='radix':admitted_radix_submit_context(plan,Path(__file__).resolve().parents[2])
    for code in [Path(__file__).resolve(),Path(owner.__file__).resolve(),*([Path(__file__).with_name('native_starknet_custody.py').resolve()] if plan['scenario']in{'starknet','radix'} else []),*([Path(__file__).with_name(n).resolve() for n in ['native_radix_custody.py','native_radix_volume.py','native_radix_assets.py','native_radix_case.py','native_radix_reference.py']]if plan['scenario']=='radix'else[]),*([Path(__file__).with_name(n).resolve()for n in ['native_svm_case.py','native_svm_assets.py']]if plan['scenario']in{'sealevel','sealevel-composite'}else[]),*([Path(__file__).with_name(n).resolve()for n in ['native_tron_custody.py','native_tron_assets.py']]if plan['scenario']=='tron'else[])]:
        require(pin(code) in plan['required_inputs'],'Exact owner/shared ownership Source closure missing')
    for row in approval['python_modules'].values(): checked(row)
    env = plan['explicit_environment']
    require(isinstance(env, dict) and all(isinstance(k,str) and isinstance(v,str) for k,v in env.items()) and not any(k in env for k in ['GH_TOKEN','GITHUB_TOKEN','ACTIONS_RUNTIME_TOKEN','DOCKER_CONTEXT','DOCKER_AUTH_CONFIG','PYTHONPATH','PYTHONHOME']), 'Ambient credentials/context cannot enter case environment')
    if plan['scenario']=='sealevel-composite':require(all(k not in inputs and k not in approval for k in ['postgres','local_docker'])and all(k not in env for k in ['DOCKER_HOST','DOCKER_CONFIG']),'Composite Source has no PG/scraper/Docker authority')
    else:
        require(inputs['local_docker'] == approval['local_docker'] and env.get('DOCKER_HOST') == inputs['local_docker']['host'] and env.get('DOCKER_CONFIG') == str(case/'docker-config') and inputs['local_docker']['config_dir'] == str(case/'docker-config'), 'Exact independent Docker capability required')
    if plan['scenario']=='tron':
        require(approval.get('tron_tre')==inputs.get('tron_tre')and approval.get('tron_cli')==inputs.get('tron_cli'),'Exact approved owned TRE/CLI custody required')
        copied=tron_module('native_tron_assets').read_materialized(inputs['tron_cli']);require(copied['root']==str(case/'tron-cli')and copied['entrypoint']==inputs['tron_tre']['cli_entrypoint'],'Approved CLI copy/entrypoint differs')
        pnpm=tron_module('native_tron_setup').PNPM_RELEASE[inputs['tron_tre']['architecture']];require(inputs['tron_tre']['pnpm']['sha256']==pnpm['sha256']and inputs['tron_tre']['pnpm']['bytes']==pnpm['bytes'],'Only exact official native Linux pnpm allowed');checked(inputs['tron_tre']['pnpm'],True)
    return plan, manifest, inputs, approval



def functional_census(plan, approval):
    descriptor = approval['native_reader_interoperability']
    require(descriptor in plan['required_inputs'], 'Functional census interoperability descriptor is not admitted')
    interop_path = checked(descriptor)
    require(interop_path.stat().st_size <= 1024**2, 'Bounded interoperability metadata required')
    wire = interop_path.read_bytes()
    require(len(wire) == descriptor['bytes'] and hashlib.sha256(wire).hexdigest() == descriptor['sha256'], 'Interoperability metadata changed during capture')
    interop = json.loads(wire)
    require(interop.get('accepted_component_source_and_actual_Zig_storage_interop') is True and interop.get('family_chain_SDK_finality_delivery_elapsed600_acceptance') is False, 'Actual admitted interoperability required for census Source')
    path = Path(__file__).resolve().with_name('native_harness_census.py')
    expected = interop['source_sha256']['zig/bench/native_harness_census.py']
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 1024**2, 'Bounded regular functional census Source required')
    source = path.read_bytes()
    require(hashlib.sha256(source).hexdigest() == expected, 'Functional census Source differs from admitted interoperability')
    # Execute the exact captured Source bytes, never an importlib bytecode cache.
    module = importlib.util.module_from_spec(importlib.util.spec_from_file_location('owned_functional_census', path))
    exec(compile(source, str(path), 'exec'), module.__dict__)
    return module, {'path':str(path), 'bytes':len(source), 'sha256':expected}


def svm_case():
    spec=importlib.util.spec_from_file_location('owned_svm_case',Path(__file__).with_name('native_svm_case.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

def tron_module(name):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


def starknet_custody():
    spec=importlib.util.spec_from_file_location('native_starknet_custody',Path(__file__).with_name('native_starknet_custody.py'))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


def radix_custody():
    spec=importlib.util.spec_from_file_location('native_radix_custody',Path(__file__).with_name('native_radix_custody.py'))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


def missing_container(status, stderr, target):
    return status == 1 and stderr.decode().strip() in {
        'Error: No such object: ' + target,
        'Error response from daemon: No such container: ' + target,
    }


def pg_owned(row, case, pid, pg, name, cid=None):
    labels = row.get('Config', {}).get('Labels', {}) or {}
    root_hash = hashlib.sha256(os.fsencode(case)).hexdigest()
    require(isinstance(row, dict) and re.fullmatch('[0-9a-f]{64}', row.get('Id','')) and row.get('Name') == '/' + name and row.get('Image') == pg['image_id'] and labels.get(LABEL_ROOT) == root_hash and labels.get(LABEL_PID) == str(pid) and labels.get(LABEL_TOKEN) == pg['run_token'] and (cid is None or cid == row['Id']), 'PG cleanup authority refused foreign/replaced CID')
    return row['Id']


def read_owned_cid(path):
    wire=checked(pin(path)).read_bytes();row=json.loads(wire)
    require(isinstance(row,dict) and set(row)=={'container_id'} and isinstance(row['container_id'],str) and re.fullmatch('[0-9a-f]{64}',row['container_id']),'Malformed immutable CID record')
    require(wire==(json.dumps(row,sort_keys=True,separators=(',',':'))+'\n').encode(),'Noncanonical immutable CID record')
    return row['container_id']


def persist_owned_cid(output, cid):
    import tempfile
    require(isinstance(cid,str) and re.fullmatch('[0-9a-f]{64}',cid),'Invalid captured CID')
    target=output/'owned-pg.json'
    if target.exists() or target.is_symlink():
        require(read_owned_cid(target)==cid,'Previously captured PG CID changed');return
    wire=(json.dumps({'container_id':cid},sort_keys=True,separators=(',',':'))+'\n').encode()
    pending=None;identity=None
    try:
        with tempfile.NamedTemporaryFile(dir=output,prefix='.owned-pg-',suffix='.pending',delete=False) as stream:
            pending=Path(stream.name);st=os.fstat(stream.fileno());identity=(st.st_dev,st.st_ino);stream.write(wire);stream.flush();os.fsync(stream.fileno())
        # Atomic no-overwrite publication: crash leaves either no final record
        # or the complete fsynced first CID, never a truncated poll rewrite.
        try:os.link(pending,target)
        except FileExistsError:require(read_owned_cid(target)==cid,'Concurrent captured PG CID differs')
        directory=os.open(output,os.O_RDONLY)
        try:os.fsync(directory)
        finally:os.close(directory)
        require(read_owned_cid(target)==cid,'Published captured CID differs')
    finally:
        if pending is not None and pending.exists():
            st=pending.lstat();require((st.st_dev,st.st_ino)==identity,'Owned pending CID identity changed');pending.unlink()


def pg_caps(row):
    cfg = row.get('HostConfig', {})
    require(cfg.get('Memory') == cfg.get('MemorySwap') == GIB and cfg.get('NanoCpus') == 2_000_000_000 and cfg.get('PidsLimit') == 256, 'PG resource cap differs')
    require(cfg.get('PortBindings') == {'5432/tcp':[{'HostIp':'127.0.0.1','HostPort':'5432'}]}, 'PG must publish loopback only')
    value = cfg.get('Tmpfs',{}).get('/var/lib/postgresql/data','')
    require('size=2147483648' in value.split(',') or 'size=2g' in value.split(',') or 'size=2G' in value.split(','), 'PGDATA tmpfs cap differs')


def kernel_tmpfs(text):
    matches = []
    for line in text.splitlines():
        if ' - ' not in line: continue
        left,right = line.split(' - ',1); fields,kind = left.split(),right.split()
        if len(fields)>5 and fields[4]=='/var/lib/postgresql/data': matches.append((fields,kind))
    require(len(matches)==1 and len(matches[0][1])>=3 and matches[0][1][0]=='tmpfs', 'Actual kernel PGDATA tmpfs missing')
    options = matches[0][0][5].split(',') + matches[0][1][2].split(',')
    sizes = [v[5:] for v in options if v.startswith('size=')]
    require(sizes, 'Actual kernel tmpfs size missing')
    for value in sizes:
        match = re.fullmatch(r'(\d+)([kmg]?)',value,re.I)
        require(match is not None and int(match[1])*{'':1,'k':1024,'m':1024**2,'g':GIB}[match[2].lower()] == 2*GIB, 'Actual kernel tmpfs size differs')


def fixture_waits(path, scenario, parent):
    rows = [json.loads(line) for line in checked(pin(path)).read_text().splitlines()]
    if scenario=='tron':
        require(len(rows)==2 and len({r.get('pid')for r in rows})==2 and all(type(r.get('pid'))is int and r['pid']>0 and r.get('role')=='fixture-docker'and r.get('parent_pid')==parent and r.get('parent_wait_completed')is True and r.get('forced_kill')is False and r.get('purpose')=='fixture_teardown'and r.get('already_exited')is False and r.get('success')is True and type(r.get('exit_code'))is int and r['exit_code']==0 and r.get('signal')is None for r in rows),'TRE+PG require two actual clean foreground Child waits; no Kathy/anvil credit')
        require({r.get('planned_container_stop',{}).get('kind')for r in rows}=={'tron','postgres'},'Separate TRE and PG stop receipts required');return rows
    roles = ['fixture-anvil','fixture-kathy','fixture-postgres'] if scenario=='evm' else ['fixture-docker', 'fixture-hypd' if scenario=='cosmosnative' else 'fixture-osmosisd', 'fixture-hypd' if scenario=='cosmosnative' else 'fixture-osmosisd']
    if scenario=='radix':roles=['fixture-docker']
    if scenario=='sealevel':roles=['fixture-docker','fixture-svm-SOL']
    if scenario=='sealevel-composite':roles=['fixture-svm-SOL']
    if scenario=='starknet':
        roles=['fixture-docker']*3
        require(all(r.get('success') is True and r.get('exit_code')==0 and r.get('signal') is None for r in rows),'All three Source container Child waits must be actual clean success')
    require(len(rows)==len(roles) and all(type(r.get('pid')) is int and r['pid']>0 for r in rows) and len({r['pid'] for r in rows})==len(roles) and sorted(r['role'] for r in rows)==sorted(roles), 'Actual fixture child wait set differs')
    require(all(r['parent_pid']==parent and r['parent_wait_completed'] is True and r['forced_kill'] is False and r['purpose']=='fixture_teardown' and (r['already_exited'] is False or scenario=='evm' and r['role']=='fixture-kathy') for r in rows), 'Missing/forced/early fixture child wait')
    return rows


class GeneratedSlots:
    def __init__(self, repo, evidence, enabled):
        self.repo, self.evidence, self.rows = repo,evidence,[]
        if not enabled:return
        evidence.mkdir(mode=0o700)
        for index,name in enumerate(GENERATED):
            path=repo/name
            require(not path.is_symlink() and all(not p.is_symlink() for p in path.parents if p.is_relative_to(repo)), 'Generated path symlink')
            record={'relative_path':name,'before':None,'mode':None}
            if path.exists():
                record['before']=pin(path);record['mode']=stat.S_IMODE(path.stat().st_mode)
                shutil.copyfile(path,evidence/(str(index)+'.before'))
            self.rows.append(record)
        with (evidence/'before.json').open('x') as stream:
            json.dump(self.rows,stream);stream.write('\n');stream.flush();os.fsync(stream.fileno())
    def restore(self):
        for index,row in enumerate(self.rows):
            path=self.repo/row['relative_path'];require(not path.is_symlink() and all(not parent.is_symlink() for parent in path.parents if parent.is_relative_to(self.repo)), 'Generated slot became symlink; preserve unknown path')
            generated=self.evidence/(str(index)+'.generated');metadata=self.evidence/(str(index)+'.generated.json')
            if generated.exists() or metadata.exists():
                require(generated.exists() and metadata.exists(),'Incomplete retained generated snapshot')
                capture=json.loads(checked(pin(metadata)).read_text())
                require(capture['captured_from']==str(path) and capture['snapshot']['path']==str(generated),'Generated snapshot belongs to another slot')
                checked(capture['snapshot']);row['generated']=capture['observed']
            elif path.exists():
                observed=pin(path)
                with path.open('rb') as incoming,generated.open('xb') as outgoing:
                    shutil.copyfileobj(incoming,outgoing);outgoing.flush();os.fsync(outgoing.fileno())
                snapshot=pin(generated);require(snapshot['sha256']==observed['sha256'] and snapshot['bytes']==observed['bytes'],'Generated file changed during snapshot')
                capture={'captured_from':str(path),'snapshot':snapshot,'observed':observed}
                with metadata.open('x') as stream:
                    json.dump(capture,stream);stream.write('\n');stream.flush();os.fsync(stream.fileno())
                row['generated']=observed
            if row['before'] is None:
                if path.exists():path.unlink()
            else:
                saved=self.evidence/(str(index)+'.before');require(pin(saved)['sha256']==row['before']['sha256'], 'Generated backup changed')
                path.write_bytes(saved.read_bytes());path.chmod(row['mode']);require(pin(path)==row['before'], 'Generated restore mismatch')
        if self.rows:(self.evidence/'transaction.json').write_text(json.dumps(self.rows,indent=2)+'\n')


def native_listener_proof(scenario, manifest, case_inputs, case, lsof, observations):
    if scenario in{'sealevel','sealevel-composite'}:return svm_case().listener_proof(manifest,case_inputs,case,lsof,observations,owner,subprocess)
    expected = {'evm': [{8545}], 'cosmosnative': [{26659,26660},{26665,26666}], 'cosmwasm': [{26602,26603},{26612,26613}]}[scenario]
    artifact = case_inputs['fixture_tools']['anvil'] if scenario=='evm' else manifest['tool_overrides']['E2E_HYPD_PATH' if scenario=='cosmosnative' else 'E2E_OSMOSIS_CLI_PATH']
    executable = checked(artifact,True)
    rows=owner.proc_fallback()
    for pid,row in rows.items():
        if row['state']=='Z':continue
        try:
            # The census includes unrelated protected host PIDs (e.g. PID1).
            # No candidate identity has matched yet; an unreadable executable
            # contributes no readiness proof. Permission failures AFTER a match
            # remain errors, and all required node proofs still must exist.
            try:actual=Path(os.readlink(f'/proc/{pid}/exe'))
            except PermissionError:continue
            if actual!=executable:continue
            argv=Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
            if scenario!='evm' and b'start' not in argv:continue
            if scenario!='evm':
                index=argv.index(b'--home');home=Path(os.fsdecode(argv[index+1]))
                require(home.is_absolute() and home.resolve(strict=True).is_relative_to(case) and not home.is_symlink(),'Native home escaped case')
            query=subprocess.run([str(lsof),'-nP','-a','-p',str(pid),'-iTCP','-sTCP:LISTEN','-F','pn'],env={'PATH':'/usr/bin:/bin','LC_ALL':'C'},capture_output=True,timeout=2,check=False)
            require(query.returncode in (0,1) and len(query.stdout)<=65536 and len(query.stderr)<=65536,'Native listener observation failed/oversized')
            live=owner._linux_row(pid);require(live is not None and owner.same_process(row,live),'Native PID changed during listener observation')
            ports=set();current=None
            for line in query.stdout.decode().splitlines():
                if line.startswith('p'):current=int(line[1:]);require(current==pid,'Foreign listener PID')
                elif line.startswith('n'):
                    require(current==pid,'Listener address lacks actual PID')
                    endpoint=line[1:];require(endpoint.startswith(('127.0.0.1:','[::1]:')),'Native listener is not loopback')
                    ports.add(int(endpoint.rsplit(':',1)[1]))
            for required in expected:
                if required<=ports:observations[','.join(map(str,sorted(required))) ]={'pid':pid,'start':row['start'],'executable':str(executable),'owned_loopback_ports':sorted(ports)}
        except (FileNotFoundError,ProcessLookupError):
            continue
    return expected


def public_restart_clock_map(value):
    require(isinstance(value,dict) and 0<len(value)<=16 and all(isinstance(key,str) and re.fullmatch(r'(?:relayer|validator|scraper):[A-Za-z0-9_-]{1,64}',key) and type(number)is int and number>0 for key,number in value.items()),'Closed scalar restarted role/chain clock map required')
    return dict(value)


def public_restart_admin(rows):
    require(isinstance(rows,list) and 0 < len(rows) <= 32,'Bounded actual restart readiness samples required')
    result=[]
    for value in rows:
        base={'role','chain','port','request_started_monotonic_ns','response_received_monotonic_ns'}
        extra={'operation_count'} if value.get('role')=='relayer' else {'response_bytes','response_sha256'}
        require(isinstance(value,dict) and set(value)==base|extra and value['role'] in {'relayer','validator','scraper'},'Closed public restart admin DTO required')
        require(type(value['port']) is int and 0<value['port']<65536 and type(value['request_started_monotonic_ns']) is int and type(value['response_received_monotonic_ns']) is int and 0<value['request_started_monotonic_ns']<=value['response_received_monotonic_ns'],'Actual restart admin clocks/port required')
        if value['role']=='relayer':require(isinstance(value['chain'],str) and re.fullmatch('[A-Za-z0-9_-]{1,64}',value['chain']) and type(value['operation_count']) is int and 0<=value['operation_count']<=100000,'Actual relayer readiness domain/count required')
        else:require(value['chain'] is None and type(value['response_bytes']) is int and 0<value['response_bytes']<=8*1024**2 and re.fullmatch('[0-9a-f]{64}',value['response_sha256']),'Metrics fingerprint/count only; no response payload')
        result.append(dict(value))
    return result


def public_native_snapshot(snapshot):
    """Explicit public evidence projection; never serialize arbitrary nested DTOs."""
    require(isinstance(snapshot,dict) and snapshot.get('scenario') in {'evm','cosmosnative','cosmwasm','starknet','sealevel','sealevel-composite','radix','tron'}, 'Public projection family not implemented')
    def fields(value,names):
        require(isinstance(value,dict),'Public proof object required')
        return {k:value[k] for k in names if k in value}
    def money(value):
        if value is None:return None
        row=fields(value,('gas_used','tokens_used','payment','gas_amount'))
        require(all((type(v)is int or isinstance(v,str) and re.fullmatch(r'0|[1-9][0-9]*',v)) and 0<=int(v)<2**256 for v in row.values()),'Public expenditure must be exact uint256 values')
        return row
    def fingerprint(value):
        row=fields(value,('bytes','sha256'))
        require(set(row)=={'bytes','sha256'} and type(row['bytes']) is int and row['bytes']>=0 and isinstance(row['sha256'],str) and re.fullmatch(r'(?:0x)?[0-9a-f]{64}',row['sha256']),'Public byte fingerprint required')
        return row
    life=[]
    required=('id','chain','transaction_hash','first_positive_monotonic_ns','early_active_samples','confirm_by_self_samples','retired_monotonic_ns','observed_message_sha256','last_present_request_started_ns','last_present_response_received_ns','maximum_observed_sample_gap_ns','first_absent_request_started_ns','first_absent_response_received_ns')
    for value in snapshot['per_id_lifecycle']:
        row=fields(value,required);require(set(row)==set(required),'Complete actual per-ID clock witness required')
        for key in required:
            if key not in {'id','chain','transaction_hash','observed_message_sha256'}:require(type(row[key]) is int and row[key]>=0,'Actual nonnegative lifecycle clock/counter required')
        age=row['retired_monotonic_ns']-row['first_positive_monotonic_ns']
        require(600_000_000_000<=age<=630_000_000_000 and row['early_active_samples']>0 and row['confirm_by_self_samples']>0 and row['maximum_observed_sample_gap_ns']<=10_000_000_000,'Strict per-ID600..630 witness failed')
        require(row['retired_monotonic_ns']==row['first_absent_response_received_ns'] and row['last_present_request_started_ns']<=row['last_present_response_received_ns']<=row['retired_monotonic_ns'] and row['first_absent_request_started_ns']<=row['first_absent_response_received_ns'],'Per-ID observed clock order differs')
        life.append(row)
    require(life and len({(v['chain'],v['id']) for v in life})==len(life),'Duplicate/empty lifecycle identities')
    messages=[fields(v,('id','nonce','origin','destination','origin_chain','delivery_chain','delivery_transaction','insertions')) for v in snapshot['messages']]
    delivered=[v['id'] for v in snapshot['deliverable_messages']]
    require(len(delivered)==len(set(delivered)) and {(v['chain'],v['id']) for v in life}=={(v['delivery_chain'],v['id']) for v in messages if v['id'] in delivered},'Actual message/lifecycle coverage differs')
    native=[]
    for value in snapshot.get('native_operations',[]):
        operation=value['operation'];row=fields(operation,('version','context','expected_context_checked','nonce','origin','destination','kind','target','stage','generation','retries','confirmation_started','deadline','identity'))
        # Deadline/identity are closed scalar public DTOs, never the intent body.
        if row.get('deadline') is not None:row['deadline']=fields(row['deadline'],('unix_ms','delay_ms'))
        if row.get('identity') is not None:row['identity']=fields(row['identity'],('kind','hex'))
        for key in ('row','stored_canonical_intent','signed'):
            if operation.get(key) is not None:row[key]=fingerprint(operation[key])
        if operation.get('expenditure') is not None:
            expenditure=operation['expenditure'];row['expenditure']=fields(expenditure,('present','gas_used_hex','tokens_used_hex'))
            if expenditure.get('marker') is not None:row['expenditure']['marker']=fingerprint(expenditure['marker'])
        if operation.get('starknet') is not None:
            quote=operation['starknet'];row['starknet']=fields(quote,('gas_limit','estimated_cost'))
            if 'batch' in quote:row['starknet']['batch']=None
            if quote.get('batch') is not None:
                row['starknet']['batch']={'version':quote['batch']['version'],'members':[fields(v,('operation_id','origin','origin_hook','generation','source_intent_digest','gas_limit','estimated_cost')) for v in quote['batch']['members']]}
        projected={'id':value['id'],'operation':row}
        if snapshot['scenario']=='tron':
            proof=value['actual_native_crypto'];crypto=fields(proof,('identity','signer','target','actual_native_fee_sun','recorded_gas_used','recorded_tokens_used','context','expected_context_checked'))
            require(set(crypto)=={'identity','signer','target','actual_native_fee_sun','recorded_gas_used','recorded_tokens_used','context','expected_context_checked'}and re.fullmatch(r'0x[0-9a-f]{64}',crypto['identity'])and all(re.fullmatch(r'0x[0-9a-f]{40}',crypto[k])for k in('signer','target'))and re.fullmatch(r'(?:0x)?[0-9a-f]{64}',crypto['context'])and type(crypto['expected_context_checked'])is bool,'Closed public native Tron signature/authority DTO required')
            require(all(type(crypto[k])is int and 0<crypto[k]<2**256 for k in ('actual_native_fee_sun','recorded_gas_used','recorded_tokens_used')),'Actual TRE fee/energy expenditure required')
            crypto['sdk_signed_wire_fingerprint']=fingerprint(proof['actual_sdk_signed_wire']);crypto['configuration_authority_independently_recomputed']=False
            projected['actual_Tron_native_crypto']=crypto
        native.append(projected)
    canonical=[]
    for value in snapshot.get('stopped_canonical_Rust_readback',[]):
        verified=[]
        for item in value['verified_canonical_messages']:
            row=fields(item,('id','nonce','processed','gas_expenditure_record_present'));row['payment']=money(item.get('payment'));row['spent']=money(item.get('spent'));verified.append(row)
        raw=value['actual_Rust_output']
        canonical.append({'origin':value['origin'],'reader':raw['reader'],'origin_domain':raw['origin_domain'],'origin_nonce_count':raw['origin_nonce_count'],'verified_canonical_messages':verified,'actual_Rust_output_canonical_JSON_sha256':hashlib.sha256(json.dumps(raw,sort_keys=True,separators=(',',':')).encode()).hexdigest()})
    sql=[]
    for value in snapshot.get('postgres',[]):
        row=fields(value,('id','origin','destination','payments_supported','dispatch_rows','separate_payment_rows','delivery_rows'))
        for key in ('verified','proof'):
            if isinstance(value.get(key),dict):row[key]=fields(value[key],('canonical_dispatch_rows','canonical_delivery_rows','payment_rows','payment','gas_amount','leaf_indices'))
            elif type(value.get(key)) is bool:row[key]=value[key]
        if value.get('scraper_configured_by_Source') is False:row['scraper_configured_by_Source']=False
        # Actual three DTOs: EVM nests a list in verified, Cosmos uses a
        # top-level kind->metadata[] map, Stark has a top-level exact_rows list.
        events=value.get('canonical_event_rows',value.get('canonical_event_coordinates'))
        if events is None and isinstance(value.get('verified'),dict):events=value['verified'].get('canonical_event_coordinates')
        if events is not None:
            if isinstance(events,dict):events=[{'kind':kind,'metadata':metadata}for kind,items in events.items()for metadata in items]
            require(isinstance(events,list),'Actual canonical SQL event rows required')
            row['canonical_event_rows']=[]
            for event in events:
                require(event['kind'] in {'dispatch','insertion','payment','delivery'},'Unknown canonical SQL event kind')
                item=fields(event,('kind','exact_rows'));item['metadata']=fields(event['metadata'],('chain','domain','transaction_hash','block_hash','block_number','transaction_index','log_index','emitter'))
                row['canonical_event_rows'].append(item)
        sql.append(row)
    crypto=[]
    for value in snapshot.get('family_native_row_proofs',[]):
        row=fields(value,('id','native_identity','independently_verified_signature','independent_Ed25519_verified','signer','sequence','account_number','signed_upfront_fee','retained_intent_fingerprint_verified','identity','account','public_key','account_nonce','canonical_slot','fee','compute_units','initial_context','allocated_fee','whole_fee','rounding_dust','context','expected_context_checked','configuration_authority_verified'))
        if 'actual_composite'in value:
            proof=value['actual_composite'];row['actual_composite']=None if proof is None else fields(proof,('aggregation_threshold','branches','rate_limit_capacity','fallback'))
        if 'configured_price_expenditure' in value:row['configured_price_expenditure']=money(value['configured_price_expenditure'])
        if value.get('native_signed_wire') is not None:row['native_signed_wire_fingerprint']=fingerprint(value['native_signed_wire'])
        crypto.append(row)
    def checkpoint_rows(values):
        output=[]
        for value in values:
            row=fields(value,('chain','zero_leaf_origin_no_signature_credit','canonical_origin_message_count','canonical_origin_leaf_count'))
            if value.get('metadata_bytes') is not None:row['metadata_bytes']=fields(value['metadata_bytes'],('path','bytes','sha256'))
            row['metadata']=fields(value.get('metadata',{}),('git_sha','allows_public_rpcs'))
            row['metadata']['rpcs']=[fields(v,('url_hash','host_hash')) for v in value.get('metadata',{}).get('rpcs',[])]
            row['verified_checkpoint_objects']=[fields(v,('path','bytes','sha256','index','root','message_id','signer')) for v in value.get('verified_checkpoint_objects',[])]
            row['published_bytes']=[fields(v,('path','bytes','sha256')) for v in value.get('published_bytes',[])]
            output.append(row)
        return output
    checkpoints=checkpoint_rows(snapshot.get('checkpoint_proofs',[]))
    readiness=None
    if isinstance(snapshot.get('same_db_restart_readiness'),dict):
        value=snapshot['same_db_restart_readiness']
        readiness=fields(value,('actual_native_dispatches','actual_native_deliveries','production600_policy_unchanged','shared_restart_PID_and_no_resubmission_checks_required','shared_parent_pid_config_admin_and_no_resubmission_checks_required'))
        if 'actual_native_heads' in value:
            heads=value['actual_native_heads'];require(isinstance(heads,dict) and all(isinstance(k,str) and re.fullmatch('[A-Za-z0-9_-]+',k) and type(v)is int and v>0 for k,v in heads.items()),'Actual public native heads required')
            readiness['actual_native_heads']=dict(heads)
        if snapshot.get('scenario')in{'sealevel','sealevel-composite'} and 'actual_native_readiness'in value:
            require(isinstance(value['actual_native_readiness'],list),'Actual SVM finalized readiness list required')
            readiness['actual_native_readiness']=[]
            for head in value['actual_native_readiness']:
                require(set(head)=={'chain','finalized_slot'}and isinstance(head['chain'],str)and re.fullmatch('[A-Za-z0-9_-]+',head['chain'])and type(head['finalized_slot'])is int and head['finalized_slot']>0,'Actual SVM finalized slot required')
                readiness['actual_native_readiness'].append(dict(head))
        for key in ('actual_publications','actual_validator_publications'):
            if key in value:readiness[key]=checkpoint_rows(value[key])
    transactions=[]
    for value in snapshot['native_delivery_transactions']:
        proof=value['proof'];row=fields(value,('chain','transaction_hash'));row['canonical']=fields(proof,('identity','block_hash','height','index','gas_used','gas_price','tokens_used','fee','units','slot','transaction_index','message_ids','chain_id','actual_fee','fee_unit','wire_sha256','wire_bytes'))
        if isinstance(proof.get('receipt'),dict):row['canonical']['receipt']=fields(proof['receipt'],('transactionHash','blockHash','blockNumber','transactionIndex','status','gasUsed','effectiveGasPrice','transaction_hash','block_hash','block_number','execution_status','finality_status'))
        if isinstance(proof.get('transaction'),dict):row['canonical']['sender']=fields(proof['transaction'],('from','sender_address','chainId','nonce'))
        if proof.get('signed') is not None:row['canonical']['signed']=fingerprint(proof['signed'])
        if snapshot['scenario']=='tron':
            require(type(proof.get('native_fee_sun'))is int and proof['native_fee_sun']>0,'Actual native wallet/solidity fee required');row['canonical']['native_fee_sun']=proof['native_fee_sun']
            for key in ('native_wallet_receipt','native_solidity_receipt'):
                info=proof[key];safe=fields(info,('id','blockNumber','fee','result'));require(safe['id'].lower()==value['transaction_hash'].removeprefix('0x').lower()and type(safe['blockNumber'])is int and type(safe['fee'])is int and safe['fee']==proof['native_fee_sun']and safe.get('result','SUCESS')=='SUCESS','Native wallet/solidity public identity/fee differs')
                safe['receipt']=fields(info['receipt'],('result','energy_usage_total','energy_usage','origin_energy_usage','net_usage','net_fee','energy_fee'));require(safe['receipt'].get('result','SUCCESS')=='SUCCESS'and all(type(v)is int and 0<=v<2**256 for k,v in safe['receipt'].items()if k!='result'),'Closed public native receipt counters required');row['canonical'][key]=safe
            block=proof['native_solidity_block'];require(isinstance(block['blockID'],str)and re.fullmatch(r'[0-9a-fA-F]{64}',block['blockID'])and type(block['block_header']['raw_data']['number'])is int and block['block_header']['raw_data']['number']>=0,'Closed native solidity block identity required')
            block=proof['native_solidity_block'];row['canonical']['native_solidity_block']={'blockID':block['blockID'],'number':block['block_header']['raw_data']['number'],'exact_transaction_membership':sum(v.get('txID','').lower()==value['transaction_hash'].removeprefix('0x').lower()for v in block['transactions'])};require(row['canonical']['native_solidity_block']['exact_transaction_membership']==1,'Native solidity transaction membership differs')
        transactions.append(row)
    waits=[]
    actual_waits=snapshot.get('parent_wait_receipts',[])
    require(isinstance(actual_waits,list) and len(actual_waits)<=4096,'Bounded actual role parent waits required')
    for value in actual_waits:
        require(isinstance(value,dict),'Actual role parent wait object required')
        row=fields(value,('role','pid','parent_pid','os_start_token','purpose','parent_wait_completed','already_exited','forced_kill','success','exit_code','signal','planned_exit'))
        if 'executable' in value:row['executable']=fields(value['executable'],('path','bytes','sha256'))
        require(isinstance(row.get('role'),str) and isinstance(row.get('purpose'),str) and row['role'] in {'relayer','validator','scraper'} and row['purpose'] in {'final','same_db_restart','intentional_reorg','intentional_restart'},'Known actual role/wait purpose required')
        require(all(type(row.get(k))is int and 0<row[k]<2**31 for k in ('pid','parent_pid')) and isinstance(row.get('os_start_token'),str) and 0<len(row['os_start_token'])<=4096 and all(32<=ord(c)<127 for c in row['os_start_token']),'Bounded actual parent/child identity required')
        require(all(type(row.get(k))is bool for k in ('parent_wait_completed','already_exited','forced_kill','success')) and ('planned_exit'not in row or type(row['planned_exit'])is bool),'Typed actual wait flags required')
        require((row.get('exit_code')is None or type(row['exit_code'])is int and 0<=row['exit_code']<=255) and (row.get('signal')is None or type(row['signal'])is int and 0<row['signal']<=127),'Typed actual child exit required')
        if 'executable'in row:
            executable=row['executable'];require(isinstance(executable.get('path'),str) and executable['path'].startswith('/') and len(executable['path'])<=4096 and all(32<=ord(c)<127 for c in executable['path']) and type(executable.get('bytes'))is int and 0<executable['bytes']<=2**31 and isinstance(executable.get('sha256'),str) and re.fullmatch('[0-9a-f]{64}',executable['sha256']),'Bounded actual child executable required')
        waits.append(row)
    accounting=[]
    for value in snapshot.get('actual_EVM_accounting',[]):
        row=fields(value,('chain','transaction_hash','receipt_gas_used','effective_gas_price','unallocated_floor_dust'))
        row['members']=[]
        for member in value['members']:
            item=fields(member,('id','nonce','weight','estimated_gas','uuid'));item['spent']=money(member.get('spent'))
            item['original_prepare_reads']=[dict(fields(read,('chain','requested_monotonic_ns','received_monotonic_ns','result')), request_parameters_canonical_JSON_sha256=hashlib.sha256(json.dumps(read.get('params'),sort_keys=True,separators=(',',':')).encode()).hexdigest()) for read in member.get('original_prepare_reads',[])]
            row['members'].append(item)
        accounting.append(row)
    out=fields(snapshot,('runtime_source_commit','scenario','capture_count','relayer_capture_ordinal','verified'))
    out['observer_policy']=fields(snapshot.get('observer_policy',{}),('version','maximum_successful_domain_sample_gap_ns','maximum_GET_timeout_seconds','maximum_GET_attempts_per_domain','retirement_observed_age_seconds'))
    broadcasts=[fields(value,('chain','transaction_hash','monotonic_ns','requested_monotonic_ns','raw_transaction_sha256','message_ids')) for value in snapshot.get('broadcasts',[])]
    out.update(parent_wait_receipts=waits,messages=messages,deliverable_ids=delivered,per_id_lifecycle=life,native_delivery_transactions=transactions,broadcasts=broadcasts,native_operations=native,stopped_canonical_Rust_readback=canonical,postgres=sql,family_native_row_proofs=crypto,checkpoint_proofs=checkpoints,actual_EVM_accounting=accounting)
    if readiness is not None:out['same_db_restart_readiness']=readiness
    if 'same_db_restart_observation' in snapshot:
        value=snapshot['same_db_restart_observation']
        restart=fields(value,('schema','minimum_live_ns','epoch_sha256','maximum_successful_sample_gap_ns','elapsed_live_ns','new_capture_last_monotonic_ns','before_effective_config_sha256','after_effective_config_sha256'))
        restart['new_capture_monotonic_ns_by_role_chain']=public_restart_clock_map(value['new_capture_monotonic_ns_by_role_chain'])
        restart['clock_scope']=value.get('clock_scope','Historical schema1 callback proof; no schema2 live-sampler claim.')
        require(isinstance(restart['clock_scope'],str) and len(restart['clock_scope'])<=1024,'Bounded explicit restart scope required')
        if value.get('schema')==2:
            for key in ('clock_scope','checker_deadline_scope','full_baseline_completed_monotonic_ns','checker_first_entry_monotonic_ns','checker_deadline_monotonic_ns','checker_result_monotonic_ns'):
                restart[key]=value[key]
            require(all(type(restart[k]) is int for k in ('full_baseline_completed_monotonic_ns','checker_first_entry_monotonic_ns','checker_deadline_monotonic_ns','checker_result_monotonic_ns')) and isinstance(restart['clock_scope'],str) and len(restart['clock_scope'])<=1024 and isinstance(restart['checker_deadline_scope'],str) and len(restart['checker_deadline_scope'])<=256,'Closed restart boundary clocks/scopes required')
            require(restart['clock_scope']==RESTART_CLOCK_SCOPE and restart['checker_deadline_scope']==RESTART_DEADLINE_SCOPE,'Fixed public schema2 proof/deadline scopes required')
            phases=value['full_baseline_phases'];require(isinstance(phases,dict) and set(phases) in ({'restart_approval','restart_canonical','restart_identity','restart_checkpoints'},{'restart_approval','restart_canonical','restart_identity','restart_readiness','restart_checkpoints'}),'Actual full baseline subphases required')
            for row in phases.values():require(isinstance(row,dict) and set(row)=={'started_monotonic_ns','finished_monotonic_ns'} and all(type(v)is int and v>=0 for v in row.values()),'Closed scalar full baseline subphase clocks required')
            restart['full_baseline_phases']={name:dict(row) for name,row in phases.items()}
            targets=value['readiness_targets'];require(isinstance(targets,list) and 0<len(targets)<=16,'Bounded restarted admin targets required')
            restart['readiness_targets']=[]
            for target in targets:
                require(set(target)=={'role','port','chains'} and target['role'] in {'relayer','validator','scraper'} and type(target['port']) is int and 0<target['port']<65536 and isinstance(target['chains'],list) and target['chains'] and all(isinstance(v,str) and re.fullmatch('[A-Za-z0-9_-]{1,64}',v) for v in target['chains']),'Closed role readiness target required')
                restart['readiness_targets'].append(dict(target,chains=list(target['chains'])))
            check=value['publication_live_check'];require(set(check)=={'observed_monotonic_ns','epoch_sha256','actual_admin_readiness','role_rpc_activity','role_rpc_request_started_ns'},'Closed final live publication check required')
            require(type(check['observed_monotonic_ns'])is int and check['observed_monotonic_ns']>=0 and isinstance(check['epoch_sha256'],str) and re.fullmatch('[0-9a-f]{64}',check['epoch_sha256']),'Closed scalar live publication identity/clock required')
            restart['publication_live_check']={**fields(check,('observed_monotonic_ns','epoch_sha256')),'actual_admin_readiness':public_restart_admin(check['actual_admin_readiness']),'role_rpc_activity':public_restart_clock_map(check['role_rpc_activity']),'role_rpc_request_started_ns':public_restart_clock_map(check['role_rpc_request_started_ns'])}

        restart['samples']=[]
        for sample in value['samples']:
            require(type(sample['observed_monotonic_ns'])is int and sample['observed_monotonic_ns']>=0,'Public restart observed clock must be a nonnegative monotonic integer')
            activity=sample['role_rpc_activity']
            require(isinstance(activity,dict) and all(re.fullmatch(r'(?:relayer|validator|scraper):[A-Za-z0-9_-]+',k) and type(v)is int for k,v in activity.items()),'Public restarted-role clock map required')
            restart['samples'].append({'observed_monotonic_ns':sample['observed_monotonic_ns'],'role_rpc_activity':public_restart_clock_map(activity),'role_rpc_request_started_ns':public_restart_clock_map(sample['role_rpc_request_started_ns'])})
            if value.get('schema')==2:restart['samples'][-1]['actual_admin_readiness']=public_restart_admin(sample['actual_admin_readiness'])
        restart['new_child_identities']=[]
        for child in value['new_child_identities']:
            row=fields(child,('role','pid','parent_pid','os_start_token'))
            row['executable']=fields(child['executable'],('path','bytes','sha256'))
            restart['new_child_identities'].append(row)
        out['same_db_restart_observation']=restart
    for key in ('full_final_proof_completed_monotonic_ns','full_final_proof_scope'):
        if key in snapshot:
            value=snapshot[key]
            if key=='full_final_proof_completed_monotonic_ns':require(type(value)is int and value>=0,'Public final completion must be a nonnegative monotonic integer')
            else:require(isinstance(value,str) and value==RESTART_FINAL_SCOPE,'Public final scope must be the fixed Source proof scope')
            out[key]=value
    if snapshot['scenario']=='radix':
        path=Path(__file__).resolve().parents[1]/'integration/multivm_radix_observations.py'
        spec=importlib.util.spec_from_file_location('native_radix_public_projection',path)
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        return module.extend_public_snapshot(snapshot,out)
    return out


def write_public_native_proof(plan,manifest,case,output,expected_final):
    """Hash-match the real records, publish only explicit public evidence fields."""
    def read(relative):
        path=case/'evidence'/relative
        before=pin(path);require(before['bytes']<=8*1024**2,'Bounded actual native proof record required')
        def unique(pairs):
            row={}
            for key,value in pairs:require(key not in row,'Duplicate native proof key');row[key]=value
            return row
        rows=[json.loads(line,object_pairs_hook=unique) for line in path.read_text().splitlines()]
        require(rows and pin(path)==before,'Actual native proof changed while projecting')
        return rows[-1],before
    phases={};raw={}
    for name,relative in [('initial','verified-initial-native.jsonl'),('before_restart','verified-before-restart.jsonl'),('after_restart','verified-after-restart.jsonl'),('final','verified-final-native.jsonl')]:
        value,raw[name]=read(relative);phases[name]=public_native_snapshot(value)
    require(raw['final']==expected_final and phases['final'].get('verified') is True,'Hash-matched actual verified final required')
    restart=phases['after_restart'].get('same_db_restart_observation');require(isinstance(restart,dict) and restart.get('minimum_live_ns')==30_000_000_000,'Actual timed30 restart proof missing; legacy SameDB is not30 credit')
    require(phases['final'].get('same_db_restart_observation')==restart,'Final/after-restart actual witness differs')
    waits=phases['final']['parent_wait_receipts']
    require(waits and all(row['parent_wait_completed']is True and row['already_exited']is False and row['forced_kill']is False for row in waits),'Actual clean role parent wait receipts missing')
    identities=[(row['pid'],row['parent_pid'],row['os_start_token'])for row in waits]
    require(len(identities)==len(set(identities)),'Duplicate actual role parent wait')
    for row in waits:
        if row['purpose']in {'final','same_db_restart'}:require(row['success']is True and type(row['exit_code'])is int and row['exit_code']==0 and row['signal']is None,'Actual final/restart role shutdown not clean')
        else:require(row.get('planned_exit')is True and row['success']is False and row['exit_code']is None and row['signal']==9,'Actual intentional role shutdown not planned')
    actual_final={(row['role'],row['pid'],row['parent_pid'],row['os_start_token'])for row in waits if row['purpose']=='final'}
    restarted={(row['role'],row['pid'],row['parent_pid'],row['os_start_token'])for row in restart['new_child_identities']}
    require(actual_final==restarted and actual_final,'Actual final parent waits do not cover the restarted children')
    require(restart.get('schema')==2,'Legacy full-callback restart scope is historical; schema2 continuous proof required')
    require(restart['clock_scope']==RESTART_CLOCK_SCOPE and restart['checker_deadline_scope']==RESTART_DEADLINE_SCOPE,'Exact schema2 baseline/continuous/full-final clock scope required')
    entered=restart['checker_first_entry_monotonic_ns'];baseline=restart['full_baseline_completed_monotonic_ns'];deadline=restart['checker_deadline_monotonic_ns'];published=restart['checker_result_monotonic_ns']
    require(0<entered<=baseline<=published<deadline and deadline-entered==120_000_000_000,'Actual Python first-entry deadline/baseline/publication ordering differs')
    for row in restart['full_baseline_phases'].values():require(set(row)=={'started_monotonic_ns','finished_monotonic_ns'} and type(row['started_monotonic_ns'])is int and type(row['finished_monotonic_ns'])is int and entered<=row['started_monotonic_ns']<=row['finished_monotonic_ns']<=baseline,'Actual full proof phase order invalid')
    previous_phase_end=entered
    for name in ('restart_approval','restart_canonical','restart_identity','restart_readiness','restart_checkpoints'):
        if name not in restart['full_baseline_phases']:continue
        phase=restart['full_baseline_phases'][name];require(phase['started_monotonic_ns']>=previous_phase_end,'Full baseline proof phases overlap or reorder');previous_phase_end=phase['finished_monotonic_ns']
    targets=restart['readiness_targets'];expected_admin=[]
    for target in targets:
        expected_admin.extend([(target['role'],target['port'],chain)for chain in target['chains']]if target['role']=='relayer'else[(target['role'],target['port'],None)])
    require(len(expected_admin)==len(set(expected_admin)),'Duplicate actual readiness targets')
    require({target['role']+':'+chain for target in targets for chain in target['chains']}==set(restart['new_capture_monotonic_ns_by_role_chain']),'Readiness targets and actual restarted role/chain keys differ')
    def admin_checked(rows,now):
        require(len(rows)==len(expected_admin) and {(row['role'],row['port'],row['chain'])for row in rows}==set(expected_admin),'Actual admin target coverage differs')
        for row in rows:require(baseline<=row['request_started_monotonic_ns']<=row['response_received_monotonic_ns']<=now and now-row['response_received_monotonic_ns']<=10_000_000_000,'Stale/misattributed actual admin readiness')
    samples=restart['samples'];require(isinstance(samples,list) and len(samples)>=4,'Actual restarted live samples missing')
    previous=None
    for row in samples:
        now=row['observed_monotonic_ns'];activity=row['role_rpc_activity'];starts=row['role_rpc_request_started_ns']
        require(type(now)is int and isinstance(activity,dict) and activity and isinstance(starts,dict) and set(starts)==set(activity) and all(type(activity[k])is int and type(starts[k])is int and 0<starts[k]<=activity[k]<=now and now-activity[k]<=10_000_000_000 and k in restart['new_capture_monotonic_ns_by_role_chain'] and type(restart['new_capture_monotonic_ns_by_role_chain'][k])is int and starts[k]>restart['new_capture_monotonic_ns_by_role_chain'][k] for k in activity),'Invalid actual restarted request/response sample')
        require(set(activity)==set(restart['new_capture_monotonic_ns_by_role_chain']) and baseline<=now<published,'Actual full role coverage/live boundary differs')
        admin_checked(row['actual_admin_readiness'],now)
        if previous:
            require(0<now-previous['observed_monotonic_ns']<=10_000_000_000 and set(activity)==set(previous['role_rpc_activity']) and all(activity[k]>previous['role_rpc_activity'][k] and starts[k]>previous['role_rpc_activity'][k] for k in activity),'Stale/gapped actual restarted role observations')
        previous=row
    elapsed=samples[-1]['observed_monotonic_ns']-samples[0]['observed_monotonic_ns'];require(elapsed>=30_000_000_000 and elapsed==restart['elapsed_live_ns'],'Actual restart30 duration differs')
    require(restart['new_capture_last_monotonic_ns']<samples[0]['observed_monotonic_ns'],'Restart observation predates new captures')
    check=restart['publication_live_check'];now=check['observed_monotonic_ns']
    require(check['epoch_sha256']==restart['epoch_sha256'] and samples[-1]['observed_monotonic_ns']<=now<=published and set(check['role_rpc_activity'])==set(samples[-1]['role_rpc_activity'])==set(check['role_rpc_request_started_ns']),'Final live publication epoch/coverage differs')
    for key,value in check['role_rpc_activity'].items():require(type(value)is int and type(check['role_rpc_request_started_ns'][key])is int and 0<check['role_rpc_request_started_ns'][key]<=value<=now and now-value<=10_000_000_000 and value>=samples[-1]['role_rpc_activity'][key] and check['role_rpc_request_started_ns'][key]>restart['new_capture_monotonic_ns_by_role_chain'][key],'Final publication role freshness differs')
    require(now-samples[-1]['observed_monotonic_ns']<=10_000_000_000,'Live publication gap exceeds10s')
    admin_checked(check['actual_admin_readiness'],now)
    completed=phases['final'].get('full_final_proof_completed_monotonic_ns');require(type(completed)is int and completed>=published and phases['final'].get('full_final_proof_scope')==RESTART_FINAL_SCOPE,'Actual fresh full final proof completion missing')

    require(restart['before_effective_config_sha256']==restart['after_effective_config_sha256'] and re.fullmatch('[0-9a-f]{64}',restart['before_effective_config_sha256']),'SameDB effective config hashes differ')
    require(phases['initial']['broadcasts']==phases['after_restart']['broadcasts'],'Restart submitted extra transactions')
    before={row['id']:row['operation'] for row in phases['before_restart']['native_operations']};after={row['id']:row['operation'] for row in phases['final']['native_operations']}
    if before:
        require(set(before)==set(after),'Native sameDB operation coverage differs')
        for identity in before:
            for key in ('context','generation','identity','stored_canonical_intent','signed'):require(before[identity].get(key)==after[identity].get(key),'Native sameDB frozen signed operation changed')
    record={'schema':1,'kind':'public-actual-native-proof-v1','runtime_source_commit':manifest['runtime_source_commit'],'execution_source_commit':plan['execution_source_commit'],'scenario':manifest['scenario'],'mode':manifest['mode'],'raw_records':raw,'phase_evidence':phases,'actual_timed_restart_ns':elapsed,'source_and_products':{'manifest':plan['manifestArtifact'],'harness':plan['harnessArtifact'],'runtime_artifacts':manifest['artifacts']},'qualification':'Projection of hash-matched actual verifier records only. Raw signed wire, message bodies, keys, authorization and captured environment/config are never serialized. Canonical/signature/SQL verdicts are retained as actual Source verifier outputs, not independently reconstructed from this projection. Observed retirement is not an exact deletion timestamp.','native_or_performance_credit_from_projection_alone':False}
    require(not output.exists() and not output.is_symlink(),'Preserve existing public proof')
    with output.open('x')as stream:json.dump(record,stream,sort_keys=True,separators=(',',':'));stream.write('\n');stream.flush();os.fsync(stream.fileno())
    return pin(output)


def diagnostic_module(approval):
    path=checked(approval['python_modules']['multivm_diagnostics.py'])
    spec=importlib.util.spec_from_file_location('owned_public_diagnostics',path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


def snapshot_public_diagnostics(case,approval,out,name):
    source=case/'evidence/public-observer-diagnostics.json'
    if not source.exists():return None
    before=pin(source);require(before['bytes']<=256*1024,'Public observer diagnostic bound')
    def unique(pairs):
        value={}
        for key,item in pairs:require(key not in value,'Duplicate public diagnostic key');value[key]=item
        return value
    value=json.loads(source.read_text(),object_pairs_hook=unique)
    require(pin(source)==before,'Observer diagnostic changed during snapshot')
    diagnostic_module(approval).validate_record(value,approval['python_modules'])
    path=out/name;require(not path.exists()and not path.is_symlink(),'Preserve public diagnostic snapshot')
    with path.open('x')as stream:json.dump(value,stream,sort_keys=True,separators=(',',':'));stream.write('\n');stream.flush();os.fsync(stream.fileno())
    return {'artifact':pin(path),'actual_observer_record':before}




def arm_relayer_startup(plan,manifest,approval,repo,deadline_ns):
    if plan['scenario']not in{'evm','starknet'}:return None
    try:
        require(time.monotonic_ns()<deadline_ns,'Original diagnostic deadline expired')
        module=diagnostic_module(approval);state=module.RelayerStartup(repo,manifest,approval['python_modules'])
        name='rust/main/utils/run-locally/src/external_agents.rs';row=plan['diagnostic_rust_sources'][name];path=Path(repo)/name;wire,fingerprint=module.captured_failure_bytes(path,1024**2)
        require(row=={'path':str(path),**fingerprint}and all(needle in wire for needle in [b'pub fn record_child(',b'let record = OwnedChild',b'.join("owned-children.jsonl")',b'parent_pid: std::process::id()']),'Actual role ownership writer changed')
        state.module_identities[path]=state.identity(path)
        product=checked(manifest['artifacts']['relayer'],True);identity=state.identity(product)
        require(time.monotonic_ns()<deadline_ns,'Original diagnostic deadline expired')
        return {'module':module,'state':state,'product':product,'product_identity':identity,'latest_probe':{'collection_status':'not_attempted'}}
    except Exception:return None


def observe_relayer_startup(context,manifest,inputs,case,harness,controller,helper_row,original_deadline_ns):
    if context is None:return
    previous=context['state'].last
    started=time.monotonic_ns();end=min(original_deadline_ns,started+500_000_000)
    def cancelled():return harness.poll()is not None or controller.poll()is not None
    def check():
        require(not cancelled()and time.monotonic_ns()<end,'Original absolute diagnostic probe expired/cancelled')
        live=owner._linux_row(harness.pid)
        require(live is not None and owner.same_process(helper_row,live)and live['state']!='Z','Actual helper epoch changed')
        require(context['state'].identity(context['product'])==context['product_identity'],'Admitted relayer product changed')
    try:
        check();module=context['module'];context['state'].check_sources()
        def read(path,maximum):
            check();wire=module.captured_failure_bytes(path,maximum);check();return wire
        row,chains,port=module.startup_selected_role(case,manifest,inputs,harness.pid,read,owner._linux_row,lambda pid:os.readlink(f'/proc/{pid}/exe'),check)
        pid=row['pid']
        def same_role():
            check();live=owner._linux_row(pid)
            require(live is not None and owner.same_process(row,live)and live['ppid']==harness.pid and live['state']!='Z'and os.readlink(f'/proc/{pid}/exe')==str(context['product']),'Current relayer epoch/product changed')
        same_role();inode=module.startup_owned_listener(pid,port,row,end,cancelled,time.monotonic_ns,owner._linux_row)
        _,body=module.startup_http(port,'GET',end,cancelled,time.monotonic_ns)
        same_role();require(module.startup_owned_listener(pid,port,row,end,cancelled,time.monotonic_ns,owner._linux_row)==inode,'Relayer listener changed before HEAD')
        status,_=module.startup_http(port,'HEAD',end,cancelled,time.monotonic_ns)
        same_role();require(module.startup_owned_listener(pid,port,row,end,cancelled,time.monotonic_ns,owner._linux_row)==inode,'Actual relayer listener inode changed')
        check();value=context['state'].project(body,chains,status,started,time.monotonic_ns());check()
        value['finished_monotonic_ns']=time.monotonic_ns();require(value['finished_monotonic_ns']<=end,'Absolute diagnostic publication fence')
        value['current_role_identity']={'pid':pid,'parent_pid':harness.pid,'kernel_start_token':row['start'],'historical_journal_PS_epoch_compared':False,'scope':'Current kernel epoch/product/owned helper parent observed before and after read. Captured relayer configurations agree; no ordinal-to-PID or PS-token-to-ticks equivalence inferred.'}
        context['latest_probe']={'collection_status':'observed','started_monotonic_ns':started,'finished_monotonic_ns':value['finished_monotonic_ns']}
    except Exception:
        context['state'].last=previous
        context['latest_probe']={'collection_status':'unavailable','started_monotonic_ns':started,'finished_monotonic_ns':time.monotonic_ns(),'scope':'Missing, uncertain, cancelled, changed or outside original deadline; no primary/verdict effect.'}



def arm_radix_scraper(plan,manifest,approval,repo,deadline_ns):
    if plan['scenario']!='radix':return None
    try:
        require(time.monotonic_ns()<deadline_ns,'Original SCR diagnostic deadline')
        module=diagnostic_module(approval);state=module.RadixScraper(repo,manifest,approval['python_modules'])
        product=checked(manifest['artifacts']['scraper'],True);identity=state.identities.get(product)or module.RelayerStartup.identity(product)
        require(time.monotonic_ns()<deadline_ns,'Original SCR diagnostic deadline')
        return {'module':module,'state':state,'product':product,'product_identity':identity}
    except Exception:return None


def observe_radix_scraper(context,manifest,inputs,case,harness,controller,helper_row,cadence_deadline_ns):
    if context is None:return
    started=time.monotonic_ns();phase='OWNERSHIP_UNAVAILABLE';module=context['module'];state=context['state'];previous=(state.first,state.last)
    def cancelled():return harness.poll()is not None or controller.poll()is not None
    def check():
        require(not cancelled()and time.monotonic_ns()<cadence_deadline_ns,'Original shared Radix diagnostic deadline/cancel')
        live=owner._linux_row(harness.pid)
        require(live is not None and owner.same_process(helper_row,live)and live['state']!='Z','Actual SCR helper epoch changed')
        require(module.RelayerStartup.identity(context['product'])==context['product_identity'],'Admitted SCR product changed')
    try:
        check();state.check_sources()
        def read(path,maximum):
            check();wire=module.captured_failure_bytes(path,maximum);check();return wire
        row,chains,port=module.radix_selected_scraper(case,manifest,inputs,harness.pid,read,owner._linux_row,lambda pid:os.readlink(f'/proc/{pid}/exe'),check)
        pid=row['pid']
        def same_role():
            check();live=owner._linux_row(pid)
            require(live is not None and owner.same_process(row,live)and live['ppid']==harness.pid and live['state']!='Z'and os.readlink(f'/proc/{pid}/exe')==str(context['product']),'Current SCR epoch/product changed')
        same_role();inode=module.startup_owned_listener(pid,port,row,cadence_deadline_ns,cancelled,time.monotonic_ns,owner._linux_row)
        phase='REQUEST_ERROR';_,body=module.startup_http(port,'GET',cadence_deadline_ns,cancelled,time.monotonic_ns)
        phase='OWNERSHIP_UNAVAILABLE';same_role()
        require(module.startup_owned_listener(pid,port,row,cadence_deadline_ns,cancelled,time.monotonic_ns,owner._linux_row)==inode,'Actual SCR listener changed')
        check();phase='SOURCE_UNAVAILABLE';state.check_sources();check();phase='METRICS_PARSE_ERROR'
        # Commit operands only after ownership, parsing and original shared fence.
        state.project(body,chains,started,time.monotonic_ns());check()
    except Exception:
        state.first,state.last=previous
        state.latest_probe={'collection_status':'unavailable','reason':'DEADLINE_OR_CANCEL'if cancelled()or time.monotonic_ns()>=cadence_deadline_ns else phase,'started_monotonic_ns':started,'finished_monotonic_ns':time.monotonic_ns(),'native_or_timing_or_cleanup_authority':False}


def arm_radix_transport(plan,manifest,approval,repo,fixture,engine_info,deadline_ns):
    if plan['scenario']!='radix':return None
    try:
        require(time.monotonic_ns()<deadline_ns,'Original Radix diagnostic case deadline')
        module=diagnostic_module(approval);name='rust/main/utils/run-locally/src/external_agents/radix_fixture.rs';source=plan['diagnostic_rust_sources'][name]
        path=str(Path(repo)/'zig/bench/native_radix_custody.py');rows=[row for row in plan['required_inputs']if row.get('path')==path]
        require(len(rows)==1 and source in plan['required_inputs'],'Existing admitted Radix Source descriptors required')
        state=module.RadixTransport(fixture,source,rows[0],repo)
        version=engine_info.get('ServerVersion');state.engine_version=version if isinstance(version,str)and re.fullmatch(r'[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}(?:[-+][A-Za-z0-9_.-]{1,32})?',version)else None
        require(time.monotonic_ns()<deadline_ns,'Original Radix diagnostic case deadline')
        state.runtime_source_commit=manifest['runtime_source_commit']
        return {'module':module,'state':state,'case':Path(manifest['task_root'])}
    except Exception:return None


def tap_radix_transport(context,arguments,wire):
    if context is None:return
    try:context['state'].capture(arguments,wire)
    except Exception:context['state'].capture_invalid=True


def observe_radix_transport(context,custody,harness,controller,helper_row,deadline_ns):
    if context is None:return
    def cancelled():return harness.poll()is not None or controller.poll()is not None
    def check():
        require(not cancelled()and time.monotonic_ns()<deadline_ns,'Original Radix diagnostic case deadline/cancel')
        require(custody.case==context['case']and custody.pid==harness.pid and custody.start==helper_row['start'],'Bound Radix fixture/helper context required')
        live=owner._linux_row(harness.pid)
        require(live is not None and owner.same_process(helper_row,live)and live['state']!='Z','Actual Radix helper birth changed')
    try:context['state'].observe(custody,owner._linux_row,check,time.monotonic_ns,cancelled,deadline_ns,context['module'].radix_transport_http)
    except Exception:return

def svm_fixture_wait_observation(case, manifest, plan, case_inputs, parent, approval):
    """Failure-only closed projection of existing Source ChildExit records.

    Does not replace fixture_waits, independently replay kernel identity, grant
    parent-wait acceptance or change the worker's original harness0 barrier.
    """
    require(manifest['scenario'] in {'sealevel', 'sealevel-composite'} and type(parent) is int and 0 < parent < 2**31, 'Actual SVM fixture helper parent required')
    module = diagnostic_module(approval)
    name = 'rust/main/utils/run-locally/src/external_agents.rs'
    source = Path(__file__).resolve().parents[2] / name
    descriptor = plan['diagnostic_rust_sources'][name]
    require(descriptor in plan['required_inputs'], 'Fixture journal writer must be an existing admitted Source input')
    body, fingerprint = module.captured_failure_bytes(source, 1024**2)
    require(descriptor == {'path':str(source), **fingerprint}, 'Fixture journal writer Source changed')
    needles = [b'fn append_fixture_exit(manifest: &Manifest, receipt: &ChildExit)', b'.join("fixture-parent-waits.jsonl")', b'parent_pid: std::process::id(),', b'receipt.purpose = "fixture_teardown".into();', b'role: format!("fixture-svm-{prefix}")', b'"SOL" => assets.bundle.agave_files["bin/solana-test-validator"].clone()']
    require(all(needle in body for needle in needles), 'Exact SVM fixture parent journal contract missing')
    require(isinstance(case_inputs, dict), 'Existing SVM inputs required')
    tools = {'fixture-svm-SOL':case_inputs['svm_assets']['agave_files']['bin/solana-test-validator']}
    if manifest['scenario'] == 'sealevel':tools['fixture-docker'] = manifest['verifier_tools']['docker']
    for tool in tools.values():
        require(type(tool) is dict and set(tool) == {'path','bytes','sha256'} and type(tool['bytes']) is int and 0 < tool['bytes'] < 2**40 and isinstance(tool['sha256'], str) and re.fullmatch('[0-9a-f]{64}', tool['sha256']) and tool in plan['required_inputs'], 'Existing exact fixture executable input required')
    case = Path(case)
    require(case.is_absolute() and not case.is_symlink() and case.resolve(strict=True) == case and not (case/'evidence').is_symlink(), 'Canonical fixed journal root required')
    wire, journal = module.captured_failure_bytes(case/'evidence/fixture-parent-waits.jsonl', 1024**2)
    lines = wire.splitlines()
    require(0 < len(lines) <= 256 and all(0 < len(line) <= 16384 for line in lines), 'Bounded nonempty fixture parent journal required')
    def unique(pairs):
        value = {}
        for key,item in pairs:
            require(key not in value, 'Duplicate fixture journal key')
            value[key] = item
        return value
    def nonfinite(value):raise ValueError('Nonfinite fixture journal value')
    fields = {'pid','role','executable','parent_pid','os_start_token','parent_wait_completed','already_exited','forced_kill','success','exit_code','signal','purpose','planned_exit'}
    rows, identities = [], set()
    for line in lines:
        row = json.loads(line, object_pairs_hook=unique, parse_constant=nonfinite)
        require(type(row) is dict and set(row) in (fields, fields|{'planned_container_stop'}), 'Closed Source fixture parent row required')
        role = row['role'];pid = row['pid'];token = row['os_start_token']
        require(type(role) is str and role in tools and row['executable'] == tools[role] and type(pid) is int and 0 < pid < 2**31 and type(row['parent_pid']) is int and row['parent_pid'] == parent, 'Fixture executable/role/actual helper parent differs')
        require(type(token) is str and 0 < len(token) <= 4096 and (pid,token) not in identities, 'Bounded unique fixture child identity required')
        identities.add((pid,token))
        require(all(type(row[field]) is bool for field in ['parent_wait_completed','already_exited','forced_kill','success','planned_exit']) and row['parent_wait_completed'] is True and row['purpose'] == 'fixture_teardown', 'Typed actual Source fixture teardown wait required')
        code, signum = row['exit_code'], row['signal']
        require((code is None or type(code) is int and 0 <= code <= 255) and (signum is None or type(signum) is int and 1 <= signum <= 64) and (code is None) != (signum is None), 'Typed fixture exit/signal required')
        require(not row['success'] or code == 0 and not row['already_exited'] and not row['forced_kill'], 'Successful Source fixture status inconsistent')
        rows.append({'role':role,'pid':pid,'parent_pid':parent,'os_start_token_sha256':hashlib.sha256(token.encode()).hexdigest(),'executable_bytes':tools[role]['bytes'],'executable_sha256':tools[role]['sha256'], **{field:row[field] for field in ['parent_wait_completed','already_exited','forced_kill','success','exit_code','signal','purpose','planned_exit']}})
    return {'schema':1,'kind':'public-SVM-fixture-parent-wait-observation','collection_status':'observed','writer_Source':{'relative_path':name,**fingerprint},'journal':journal,'rows':rows,'native_or_timing_or_cleanup_authority':False,'scope':'Existing Source ChildExit journal observed after owned waits, including failed helper; exact admitted executable and helper parent join only, no independent kernel replay, child success or native acceptance claim.'}



def svm_encrypt_failure_windows(plan,module,plain,selection,out,result,end_ns):
    """One optional owned ciphertext child; no primary/verdict or limit mutation."""
    child=None;wire=bytearray();sent=0;waited=False;candidate=None;cleanup_ok=False;cleanup_debt=False;birth=None;started=time.monotonic_ns()
    work_end_ns=end_ns-900_000_000 if type(end_ns)is int else 0
    unavailable={'schema':1,'collection_status':'unavailable','native_or_timing_or_cleanup_authority':False}
    def check(reserve_ns=0):
        require(type(end_ns)is int and time.monotonic_ns()+reserve_ns<work_end_ns,'Original private diagnostic budget expired')
    try:
        check(600_000_000)
        require(sys.platform=='linux'and isinstance(plain,bytes)and 0<len(plain)<=16384,'Linux bounded private diagnostic required')
        require(set(selection)=={'windows','oversized_lines_omitted','scope'}and type(selection['oversized_lines_omitted'])is int and 0<=selection['oversized_lines_omitted']<2**32,'Closed window metadata required')
        windows=selection['windows'];require(isinstance(windows,list)and len(windows)==4,'Fixed four windows required')
        for row,(tag,position)in zip(windows,[('SOL','first'),('SOL','tail'),('SCR','first'),('SCR','tail')]):require(isinstance(row,dict)and set(row)=={'tag','position','bytes'}and row['tag']==tag and row['position']==position and type(row['bytes'])is int and 0<=row['bytes']<=4096,'Fixed window framing required')
        require(sum(row['bytes']for row in windows)==len(plain),'Window bytes differ')
        waits=result['direct_waits'];helpers={row['pid']for row in waits if row.get('role')in{'harness','harness-cleanup'}and row.get('actual_parent_wait')is True}
        require(len(helpers)==1,'Actual helper wait required')
        launch,_=module.captured_failure_bytes(out/'helper-launch.json',4096);launch=json.loads(launch)
        require(set(launch)=={'helper_pid','helper_start'}and launch['helper_pid']==next(iter(helpers))and isinstance(launch['helper_start'],str),'Captured helper birth required')
        # Existing bounded Linux fallback (8192 rows / .5s), no ambient ps process.
        rows=owner.proc_fallback();check(100_000_000)
        anchors={row['pid']for row in waits if row.get('actual_parent_wait')is True and row.get('role')in{'harness','harness-cleanup','observer'}}
        roles=result.get('_svm_diagnostic_roles',())
        require(isinstance(roles,list),'Captured actual role identities required')
        for row in rows.values():
            require(row['sid']not in anchors and row['pgid']not in anchors,'Known helper/observer group remains')
            for role in roles:
                require(row['pid']!=role['pid'],'Known role PID remains; PS and Linux start tokens are incomparable')
        require(not any(row['pid']==launch['helper_pid']and row['start']==launch['helper_start']for row in rows.values()),'Helper birth remains')
        descriptor=plan['diagnostic_node'];require(descriptor in plan['required_inputs']and set(descriptor)=={'path','bytes','sha256'},'Admitted diagnostic Node required')
        node=Path(descriptor['path']);before=node.lstat();require(node.is_absolute()and node.resolve()==node and stat.S_ISREG(before.st_mode)and before.st_nlink==1 and os.access(node,os.X_OK)and 0<before.st_size<=512*1024**2 and before.st_size==descriptor['bytes'],'Bounded regular diagnostic Node required')
        fd=os.open(node,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK);digest=hashlib.sha256();header=b''
        identity=lambda row:(row.st_dev,row.st_ino,row.st_size,row.st_mtime_ns,row.st_nlink)
        try:
            require(identity(os.fstat(fd))==identity(before),'Node changed before capture')
            with os.fdopen(fd,'rb',closefd=False)as stream:
                while True:
                    check(100_000_000);block=stream.read(1024**2)
                    if not block:break
                    if not header:header=block[:64]
                    digest.update(block)
            require(identity(os.fstat(fd))==identity(before)==identity(node.lstat())and digest.hexdigest()==descriptor['sha256'],'Node identity changed')
        finally:os.close(fd)
        require(len(header)==64 and header[:6]==b'\x7fELF\x02\x01','Admitted Linux Node ELF required')
        limits={name:[None if value==resource.RLIM_INFINITY else value for value in resource.getrlimit(kind)]for name,kind in [('address_space',resource.RLIMIT_AS),('open_files',resource.RLIMIT_NOFILE)]}
        check(100_000_000)
        child=subprocess.Popen([str(node),'--no-addons','-e',module.SVM_ENCRYPTION_SCRIPT],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env={'PATH':'/usr/bin:/bin','LC_ALL':'C.UTF-8'},start_new_session=True)
        birth=owner._linux_row(child.pid)
        require(birth is not None and birth['pid']==child.pid and birth['sid']==child.pid and birth['pgid']==child.pid,'Actual diagnostic child birth/session required')
        os.set_blocking(child.stdin.fileno(),False);os.set_blocking(child.stdout.fileno(),False)
        while True:
            check(50_000_000)
            readers=[child.stdout];writers=[child.stdin]if sent<len(plain)else[]
            ready_read,ready_write,_=select.select(readers,writers,[],min(.01,max(0,(work_end_ns-time.monotonic_ns()-50_000_000)/1e9)))
            if ready_write:
                try:sent+=os.write(child.stdin.fileno(),memoryview(plain)[sent:])
                except BlockingIOError:pass
                if sent==len(plain):child.stdin.close()
            if ready_read:
                try:block=os.read(child.stdout.fileno(),32769-len(wire))
                except BlockingIOError:continue
                if block:wire.extend(block);require(len(wire)<=32768,'Bounded ciphertext response required')
                elif child.poll()is not None:break
            if child.poll()is not None and not ready_read:break
        code=child.wait(timeout=max(0,(work_end_ns-time.monotonic_ns())/1e9));waited=True;check()
        require(code==0 and sent==len(plain),'Diagnostic child failed')
        value=module.svm_encrypted_blocks(bytes(wire),len(plain));require(sum(row['bytes']for row in selection['windows'])==len(plain),'Window framing changed')
        require(value['limits']is not None and value['limits']['address_space']==limits['address_space'],'Actual child AS differs from unchanged inherited parent cap')
        require(identity(node.lstat())==identity(before),'Diagnostic Node changed after execution')
        candidate={'schema':1,'collection_status':'encrypted','key_id':value['key_id'],'windows':selection['windows'],'oversized_lines_omitted':selection['oversized_lines_omitted'],'chunk_bytes':384,'ciphertext_block_bytes':512,'blocks':value['blocks'],'actual_parent_wait':True,'child_exit_code':code,'parent_resource_limits_at_launch':limits,'actual_child_resource_limits':value['limits'],'started_monotonic_ns':started,'finished_monotonic_ns':time.monotonic_ns(),'scope':'Private fixed Source-tagged merged pipe windows encrypted to Root; no unique PID/epoch/typed error or cause claim. Known groups/role identities absent at pre-probe snapshot only.','native_or_timing_or_cleanup_authority':False}
    except BaseException:candidate=None
    finally:
        if child is not None:
            try:
                if child.poll()is None:os.killpg(child.pid,signal.SIGKILL)
                child.wait(timeout=max(0,(end_ns-time.monotonic_ns())/1e9));waited=True
                require(time.monotonic_ns()+550_000_000<end_ns,'Diagnostic cleanup snapshot reserve expired')
                rows=owner.proc_fallback()
                require(time.monotonic_ns()<end_ns and not any(row['sid']==child.pid or row['pgid']==child.pid for row in rows.values()),'Diagnostic group absence not established')
                cleanup_ok=True
            except BaseException:cleanup_debt=True
            for stream in (child.stdin,child.stdout):
                try:stream.close()
                except Exception:cleanup_ok=False;cleanup_debt=True
    if candidate is not None and cleanup_ok and waited and birth is not None:
        candidate['child_identity']={'pid':child.pid,'linux_start_token_sha256':hashlib.sha256(birth['start'].encode()).hexdigest()}
        candidate['owned_group_absent_after_wait']=True;candidate['finished_monotonic_ns']=time.monotonic_ns()
        if candidate['finished_monotonic_ns']<end_ns:return candidate
    return {**unavailable,'actual_parent_wait':waited if child is not None else None,'owned_cleanup_debt':cleanup_debt}


def write_public_failure_diagnostics(plan,manifest,approval,case,out,result,started_ns,startup_context=None,radix_transport=None,case_inputs=None,original_deadline_ns=None,radix_scraper=None):
    private_end_ns=min(original_deadline_ns,time.monotonic_ns()+5_000_000_000)if type(original_deadline_ns)is int else 0
    selected=[]
    observed=snapshot_public_diagnostics(case,approval,out,'public-observer-diagnostics.json')
    value=None if observed is None else json.loads(checked(observed['artifact']).read_text())
    # Observer transport errors can accompany Rust fixture failure/teardown.
    # Retain both approved boundaries; neither projection grants acceptance.
    rust={'sites':[],'reason_codes':[],'reason_source':None,'log_fingerprint':None};log=out/'harness.log'
    if log.exists():
        arguments=(log,plan.get('diagnostic_rust_sources',{}),Path(__file__).resolve().parents[2])
        rust=diagnostic_module(approval).rust_panic_observation(*arguments,**({'radix_scraper':radix_scraper['state']}if manifest['scenario']=='radix'and radix_scraper is not None else{}),**({'radix_client_lock':admitted_radix_submit_context(plan,Path(__file__).resolve().parents[2])}if manifest['scenario']=='radix'and'diagnostic_radix_client_lock'in plan else{}))
    startup=None;observer_log=out/'observer.log'
    waits=result['direct_waits']
    observer_failed=any(row.get('role')=='observer'and row.get('actual_parent_wait')is True and type(row.get('exit_code'))is int and row['exit_code']!=0 for row in waits)
    harness_started=any(row.get('role')in{'harness','harness-cleanup'}for row in waits)
    if observed is None and observer_failed and not harness_started and observer_log.exists():
        script=checked(manifest['verifier']['script'])
        startup=diagnostic_module(approval).observer_startup_sites(observer_log,approval['python_modules'],script.parent,manifest['verifier']['script'])
    record={'schema':1,'kind':'public-native-failure-observation','runtime_source_commit':manifest['runtime_source_commit'],'execution_source_commit':plan['execution_source_commit'],'scenario':manifest['scenario'],'mode':manifest['mode'],'worker_started_monotonic_ns':started_ns,'observed_after_owned_waits_monotonic_ns':time.monotonic_ns(),'observer_before_stop':result.get('public_diagnostic_before_stop'),'observer_after_stop':observed,'rust_panic_source_locations':rust['sites'],'rust_panic_reason_codes':rust['reason_codes'],'rust_panic_reason_source':rust['reason_source'],'rust_reason_scope':'Static phrase observations only in the next exact Source-bound SVM tempfile expect message; no inferred root cause or native/timing credit.','rust_location_scope':'Only canonical panic-header locations matched to exact pinned Source; no message, thread, payload or inferred execution credit. Unknown/ambiguous paths omitted.','harness_log_fingerprint':rust['log_fingerprint'],'actual_direct_parent_waits':[{k:row[k]for k in ['role','pid','actual_parent_wait','exit_code','observed_monotonic_ns']if k in row}for row in result['direct_waits']],'native_or_timing_credit':False}
    record['observer_startup_source_traceback']=startup
    if manifest['scenario']=='evm':record['EVM_child_wait_text']=rust.get('EVM_child_wait_text')
    if manifest['scenario']=='radix':
        record['Radix_submit_error_text']=rust.get('Radix_submit_error_text')
        try:
            require(radix_scraper is not None,'SCR diagnostic unavailable');record['Radix_scraper_cutover']=radix_scraper['state'].public(rust.get('Radix_scraper_headers'))
        except Exception:record['Radix_scraper_cutover']={'collection_status':'unavailable','native_or_timing_or_cleanup_authority':False}
    if manifest['scenario']in{'sealevel','sealevel-composite'}:
        module=diagnostic_module(approval)
        def private_capture(raw):
            def check_private():require(time.monotonic_ns()<private_end_ns,'Original private diagnostic budget expired')
            selected.append(module.svm_private_windows(raw,plan['diagnostic_rust_sources'],Path(__file__).resolve().parents[2],manifest['scenario'],check_private))
        try:
            helper_pids={row['pid']for row in waits if row.get('role')in{'harness','harness-cleanup'}and row.get('actual_parent_wait')is True}
            require(len(helper_pids)==1,'One actual SVM helper parent required for failure projection')
            record['SVM_role_failure']=diagnostic_module(approval).role_failure_observation(case,manifest,next(iter(helper_pids)),plan['diagnostic_rust_sources'],Path(__file__).resolve().parents[2],log,plan['diagnostic_zig_sources'],private_capture=private_capture)
        except Exception:record['SVM_role_failure']={'collection_status':'unavailable','native_or_timing_or_cleanup_authority':False}
        record['SVM_encrypted_fixture_windows']={'schema':1,'collection_status':'unavailable','native_or_timing_or_cleanup_authority':False}
        try:
            helper_pids={row['pid']for row in waits if row.get('role')in{'harness','harness-cleanup'}and row.get('actual_parent_wait')is True}
            require(len(helper_pids)==1,'One actual SVM fixture helper parent required')
            record['SVM_fixture_parent_waits']=svm_fixture_wait_observation(case,manifest,plan,case_inputs,next(iter(helper_pids)),approval)
        except Exception:record['SVM_fixture_parent_waits']={'collection_status':'unavailable','native_or_timing_or_cleanup_authority':False}
    if manifest['scenario']in{'tron','radix'}:
        try:
            helper_pids={row['pid']for row in waits if row.get('role')in{'harness','harness-cleanup'}and row.get('actual_parent_wait')is True}
            require(len(helper_pids)==1,'One actual fixture helper parent required for failure projection')
            record['fixture_failure']=diagnostic_module(approval).fixture_failure_observation(case,manifest,approval,next(iter(helper_pids)),plan['diagnostic_rust_sources'],Path(__file__).resolve().parents[2],log,case_inputs=case_inputs,required_inputs=plan.get('required_inputs',()))
        except Exception:record['fixture_failure']={'collection_status':'unavailable','native_or_timing_or_cleanup_authority':False}
    if manifest['scenario']in{'evm','starknet'}:
        try:
            require(startup_context is not None,'Startup diagnostic unavailable')
            record['EVM_Stark_startup']=startup_context['state'].public(log)
            record['EVM_Stark_startup']['latest_probe']=startup_context['latest_probe']
        except Exception:record['EVM_Stark_startup']={'collection_status':'unavailable','native_or_timing_or_cleanup_authority':False}
    if manifest['scenario']=='radix':
        try:
            require(radix_transport is not None,'Radix transport diagnostic unavailable');record['Radix_transport']=radix_transport['state'].public()
        except Exception:record['Radix_transport']={'collection_status':'unavailable','native_or_timing_or_cleanup_authority':False}
    if manifest['scenario']in{'sealevel','sealevel-composite'}:
        if len(selected)==1 and len(json.dumps(record,sort_keys=True,separators=(',',':')).encode())<=512*1024-40*1024:
            private_result={**result,'_svm_diagnostic_roles':record.get('SVM_role_failure',{}).get('roles')}
            record['SVM_encrypted_fixture_windows']=svm_encrypt_failure_windows(plan,module,*selected[0],out,private_result,private_end_ns)
        selected.clear()
    path=out/'public-failure-diagnostics.json';require(not path.exists()and not path.is_symlink(),'Preserve public failure record')
    with path.open('x')as stream:json.dump(record,stream,sort_keys=True,separators=(',',':'));stream.write('\n');stream.flush();os.fsync(stream.fileno())
    require(path.stat().st_size<=512*1024,'Public failure record bound')
    return pin(path)


def container_reservation(scenario):
    return (0,0)if scenario=='sealevel-composite'else((4864*1024**2 if scenario=='radix'else(5 if scenario=='starknet'else 4 if scenario=='tron'else 1)*GIB),2*GIB)


def container_observation_ok(scenario,result):
    if scenario=='sealevel-composite':
        return result.get('owned_container_absent')is None and result.get('container_fixture_configured')is False and result.get('docker_calls')==[]
    return result.get('owned_container_absent')is True


class StarknetProgress:
    """Observations only: fixed Source markers, never raw log lines or verdicts."""
    ROOT = 'rust/main/utils/run-locally/src/'
    SOURCE_NEEDLES = {
        'starknet/mod.rs': ('Relayer confirmed series {} samples, sum {}, expected {}', 'Building rust...', 'Running postgres db...', 'Init postgres db...', 'DISPATCHING MAILBOX: {} -> {:?}', 'Relayer confirmed {} submitted messages, expected {}', 'Scraper has scraped {} dispatched messages, expected {}', 'Scraper has scraped {} delivered messages, expected {}', 'Termination invariants have been met', 'timeout reached before message submission was confirmed', 'E2E tests passed'),
        'starknet/cli.rs': ('send-tx result: {:?}', 'declare result: {:?}', 'deploy result: {:?}', 'invoke result: {:?}', '.cmd(function_name)', '.run_with_output()', '.run_with_status_and_output()', 'assert!(success, "Starknet invoke failed")', 'assert!(success, "Starknet send transaction failed")'),
        'program.rs': ('({wd})$ ', 'log!("{:#}", &self)', 'self.run_full(false, true)', 'child.try_wait()', 'stdout.join()', 'stderr.join()'),
        'logging.rs': ('concat!("<E2E> ", $arg)',),
    }
    EXACT = {
        b'<E2E> Building rust...': 'fixture_entry_marker',
        b'<E2E> Running postgres db...': 'postgres_start_requested',
        b'<E2E> Init postgres db...': 'postgres_init_requested',
        b'DISPATCHING MAILBOX: 23448593 -> [23448594]': 'dispatch_batch_entered',
        b'<E2E> Termination invariants have been met': 'termination_invariants_marker',
        b'<E2E> timeout reached before message submission was confirmed': 'fixture_timeout_marker',
        b'<E2E> E2E tests passed': 'fixture_pass_marker',
    }
    RETURNS = {b'send-tx result: [': 'dispatch_command_returned', b'declare result: [': 'declare_command_returned', b'deploy result: [': 'deploy_command_returned', b'invoke result: [': 'invoke_command_returned'}
    METRICS = {
        rb'<E2E> Relayer confirmed series [0-9]+ samples, sum [0-9]+, expected [0-9]+': 'confirmed_metric_series_observed',
        rb'<E2E> Relayer confirmed [0-9]+ submitted messages, expected [0-9]+': 'confirmed_metric_observed',
        rb'<E2E> Scraper has scraped [0-9]+ dispatched messages, expected [0-9]+': 'dispatch_metric_observed',
        rb'<E2E> Scraper has scraped [0-9]+ delivered messages, expected [0-9]+': 'delivery_metric_observed',
    }
    KINDS = {'starkli', 'relayer', 'validator', 'scraper', 'docker', 'init-db', 'cargo', 'rustc'}
    MAX_SCAN = 32 * 1024**2
    READ_BYTES = 512 * 1024
    LINE_BYTES = 64 * 1024

    def __init__(self, plan, manifest, repo):
        self.runtime_source_commit = manifest['runtime_source_commit']; self.execution_source_commit = plan['execution_source_commit']; self.mode = manifest['mode']
        require(all(isinstance(value, str) and re.fullmatch('[0-9a-f]{40}', value) for value in [self.runtime_source_commit, self.execution_source_commit]) and self.mode in {'ReleaseSafe', 'ReleaseFast'}, 'Stark progress provenance differs')
        self.sources = {}
        for suffix, needles in self.SOURCE_NEEDLES.items():
            name = self.ROOT + suffix
            row = plan['diagnostic_rust_sources'][name]
            require(checked(row) == repo / name, 'Stark progress Source path differs')
            text = (repo / name).read_text()
            require(all(needle in text for needle in needles), 'Stark progress Source marker changed')
            self.sources[name] = row
        cli = checked(manifest['tool_overrides']['E2E_STARKLI_CLI_PATH'], True)
        self.cli = manifest['tool_overrides']['E2E_STARKLI_CLI_PATH']
        self.attempt_prefix = b'<E2E> (../../)$ ' + os.fsencode(cli) + b' invoke '
        self.offset = 0; self.identity = None; self.digest = hashlib.sha256()
        self.pending = bytearray(); self.discard_line = False; self.events = {}
        self.last_marker = None; self.last_clock = None; self.last_window = None
        self.overlong_lines = 0; self.scans = 0; self.disabled = False

    def _line(self, wire, start, end, now):
        marker = self.EXACT.get(wire)
        if marker is None:
            for prefix, name in self.RETURNS.items():
                if wire.startswith(prefix) and wire.endswith(b']'): marker = name; break
        if marker is None:
            for pattern, name in self.METRICS.items():
                if re.fullmatch(pattern, wire): marker = name; break
        if marker is None and wire.startswith(self.attempt_prefix):
            if re.match(rb'0x[0-9a-fA-F]+ dispatch [^\r\n]+$', wire[len(self.attempt_prefix):]):
                marker = 'dispatch_command_attempt'
        if marker is None: return
        event = self.events.setdefault(marker, {'count': 0, 'first': None, 'latest': None})
        observation = {'observed_monotonic_ns': now, 'line_start_offset': start, 'line_end_offset': end}
        if marker == 'confirmed_metric_series_observed':
            values = re.fullmatch(rb'<E2E> Relayer confirmed series ([0-9]{1,10}) samples, sum ([0-9]{1,10}), expected ([0-9]{1,10})', wire)
            if values is not None and all(int(value) <= 0xffffffff for value in values.groups()):
                observation.update({'series_count': int(values[1]), 'confirmed_count': int(values[2]), 'expected_count': int(values[3]), 'metric_values_status': 'observed_u32'})
            else:
                observation['metric_values_status'] = 'outside_u32'
        if marker == 'confirmed_metric_observed':
            values = re.fullmatch(rb'<E2E> Relayer confirmed ([0-9]{1,10}) submitted messages, expected ([0-9]{1,10})', wire)
            if values is not None and all(int(value) <= 0xffffffff for value in values.groups()):
                observation.update({'confirmed_count': int(values[1]), 'expected_count': int(values[2]), 'metric_values_status': 'observed_u32'})
            else:
                observation['metric_values_status'] = 'outside_u32'
        event['count'] += 1
        if event['first'] is None: event['first'] = observation
        event['latest'] = observation; self.last_marker = marker

    def observe(self, log, now, owned, output):
        require(type(now) is int and now > 0 and (self.last_clock is None or now >= self.last_clock), 'Stark observation clock regressed')
        self.last_clock = now
        if not log.exists():
            require(self.identity is None, 'Observed harness log disappeared')
            status = 'log_not_created'
        else:
            fd = os.open(log, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                before = os.fstat(fd); require(stat.S_ISREG(before.st_mode), 'Harness diagnostic requires regular file')
                identity = (before.st_dev, before.st_ino)
                require(self.identity is None or self.identity == identity, 'Harness diagnostic log replaced')
                self.identity = identity; require(before.st_size >= self.offset, 'Harness diagnostic log truncated')
                os.lseek(fd, self.offset, os.SEEK_SET)
                wire = os.read(fd, min(self.READ_BYTES, self.MAX_SCAN - self.offset))
                after = os.fstat(fd)
                require((after.st_dev, after.st_ino) == identity and after.st_size >= before.st_size, 'Harness diagnostic changed while reading')
            finally: os.close(fd)
            chunk_start = self.offset
            self.digest.update(wire)
            if wire: self.last_window = {'offset': chunk_start, 'bytes': len(wire), 'sha256': hashlib.sha256(wire).hexdigest()}
            # Newline framing is byte based. Long or unterminated data never becomes
            # a second artificial line, and incomplete final markers earn no count.
            for byte in wire:
                self.offset += 1
                if byte == 10:
                    if not self.discard_line:
                        self._line(bytes(self.pending), self.offset - len(self.pending) - 1, self.offset, now)
                    self.pending.clear(); self.discard_line = False
                elif not self.discard_line:
                    self.pending.append(byte)
                    if len(self.pending) > self.LINE_BYTES:
                        self.overlong_lines += 1; self.pending.clear(); self.discard_line = True
            status = 'scan_cap_reached' if self.offset == self.MAX_SCAN else 'backlog' if after.st_size > self.offset else 'caught_up'
        self.scans += 1
        processes = []
        for pid, row in sorted(owned.items())[:64]:
            require(type(pid) is int and pid > 0 and row['pid'] == pid and type(row['ppid']) is int and row['ppid'] >= 0 and re.fullmatch(r'linux-ticks:[0-9]{1,24}', row['start']) is not None and row['state'] in {'R','S','D','Z','T','t','X','I','W','P'}, 'Malformed owned process observation')
            processes.append({'pid': pid, 'parent_pid': row['ppid'], 'start_token': row['start'], 'state': row['state'], 'executable_kind': row['comm'] if row['comm'] in self.KINDS else 'other'})
        record = {'schema': 1, 'kind': 'public-starknet-source-progress', 'runtime_source_commit': self.runtime_source_commit, 'execution_source_commit': self.execution_source_commit, 'mode': self.mode, 'observed_monotonic_ns': now, 'scan_status': status, 'scans': self.scans, 'sources': self.sources, 'approved_starkli': self.cli, 'events': self.events, 'last_observed_marker': self.last_marker, 'dispatch_attempt_marker_count': self.events.get('dispatch_command_attempt', {}).get('count', 0), 'dispatch_return_marker_count': self.events.get('dispatch_command_returned', {}).get('count', 0), 'scanned_bytes': self.offset, 'scanned_prefix_sha256': self.digest.hexdigest(), 'latest_window': self.last_window, 'overlong_lines_discarded': self.overlong_lines, 'pending_line_bytes': len(self.pending), 'owned_census': processes, 'owned_census_total': len(owned), 'owned_census_truncated': len(owned) > 64, 'scope': 'Parent-observed fixed Source markers and existing owned census only; clocks are observation times, offsets are into the private log. Commands may print before spawn; returned calls do not prove exit0, transaction success or delivery. Census kinds are basename observations, never executable admission. No raw lines, suffixes, argv, environment or bodies. No stage completion, lifecycle, native or timing credit.'}
        import tempfile
        pending = None
        try:
            with tempfile.NamedTemporaryFile(dir=output.parent, prefix='.stark-progress-', delete=False) as stream:
                pending = Path(stream.name); stream.write((json.dumps(record, sort_keys=True) + '\n').encode()); stream.flush()
            os.replace(pending, output)
        finally:
            if pending is not None and pending.exists(): pending.unlink()
        return record


def observe_stark_progress(progress, log, owned, output, result):
    """Diagnostics cannot repair a primary failure or become a native verdict."""
    if progress is None or progress.disabled: return
    try: progress.observe(log, time.monotonic_ns(), owned, output)
    except Exception:
        progress.disabled = True
        result['stark_progress_diagnostic_status'] = 'observation_refused_or_unavailable'


def worker(args, plan, manifest, inputs, approval):
    case=Path(manifest['task_root']);out=args.output;out.mkdir(mode=0o700);worker_started_ns=time.monotonic_ns()
    env=plan['explicit_environment'];pg=inputs.get('postgres');docker=checked(manifest['verifier_tools']['docker'],True)if pg is not None else None
    for name in ('controller.json','controller.sock'):require(not (case/'evidence'/name).exists(), 'Preserve existing controller')
    controller=harness=None;cid=None;pg_name=None;kernel=False;error=None;forced=False;node_proofs={};devnets=None;radix=None
    radix_transport=None
    radix_scraper=None
    radix_publisher=None
    result={'schema':1,'kind':'native-case-worker-observation','passed':False,'native_case_acceptance':False,'docker_calls':[],'direct_waits':[]}
    deadline=args.original_deadline_ns/1e9
    cleanup_deadline=deadline+(180 if plan['scenario']=='radix'else 45)
    docker_env={'PATH':'/usr/bin:/bin','HOME':str(case/'home'),'DOCKER_HOST':inputs['local_docker']['host'],'DOCKER_CONFIG':inputs['local_docker']['config_dir']}if pg is not None else {}
    def docker_call(arguments, missing=False, cleaning=False):
        require(pg is not None,'Composite fixture cannot acquire Docker authority')
        process=None;code=None
        active=cleanup_deadline if cleaning else deadline
        require(time.monotonic()<active, 'Original Docker/case deadline expired')
        with tempfile_files(out) as files:
            stdout,stderr=files
            try:
                process=subprocess.Popen([str(docker),'--host',inputs['local_docker']['host'],'--config',inputs['local_docker']['config_dir'],*arguments],env=docker_env,stdin=subprocess.DEVNULL,stdout=stdout,stderr=stderr)
                code=process.wait(timeout=min(12 if cleaning else 4,max(.01,active-time.monotonic())))
            finally:
                if process is not None:
                    if process.returncode is None:process.kill()
                    code=process.wait(timeout=3)
                    result['docker_calls'].append({'arguments':arguments,'pid':process.pid,'actual_parent_wait':True,'exit_code':code})
            require(os.fstat(stdout.fileno()).st_size<=2*1024**2 and os.fstat(stderr.fileno()).st_size<=65536, 'Bounded Docker observation output')
            stdout.seek(0);stderr.seek(0);wire=stdout.read();detail=stderr.read()
        if missing and (missing_container(code,detail,arguments[-1]) or plan['scenario']=='radix' and radix_custody().missing_object(code,detail,arguments[-1],arguments[0])):return None
        require(code==0,'Owned Docker command failed')
        decoded=wire.decode()
        if not cleaning:tap_radix_transport(radix_transport,arguments,decoded)
        return decoded
    def inspect(cleaning=False):
        nonlocal cid,kernel
        if harness is None or pg is None:return
        raw=docker_call(['container','inspect',cid or pg_name],missing=True,cleaning=cleaning)
        if raw is None:return None
        rows=json.loads(raw);require(isinstance(rows,list) and len(rows)==1,'Exact one PG container required')
        row=rows[0];cid=pg_owned(row,case,harness.pid,pg,pg_name,cid)
        persist_owned_cid(out,cid)
        # Ownership is retained before resource validation; bad caps fail
        # acceptance, never prevent cleanup of the still-owned immutable CID.
        if not cleaning:
            pg_caps(row)
            if row.get('State',{}).get('Running') and not kernel:
                wire=docker_call(['exec',cid,'cat','/proc/self/mountinfo']);kernel_tmpfs(wire)
                (out/'PG-kernel-mountinfo.log').write_text(wire);kernel=True
        return row
    def stop_direct(child,role,seconds,cleaning=False):
        nonlocal forced
        if child is None:return
        if child.returncode is None:
            child.terminate()
            try:child.wait(timeout=seconds)
            except subprocess.TimeoutExpired:child.kill();child.wait(timeout=3);forced=True
        code=child.wait(timeout=3)
        result['direct_waits'].append({'role':role,'pid':child.pid,'actual_parent_wait':True,'exit_code':code,'observed_monotonic_ns':time.monotonic_ns()})
        require(not result['passed'] or role!='observer' or code==0,'Observer failed during actual final close')
    repo=Path(__file__).resolve().parents[2]
    transaction=GeneratedSlots(repo,out/'generated-slots',plan['scenario']=='evm')
    startup_context=arm_relayer_startup(plan,manifest,approval,repo,args.original_deadline_ns)
    if plan['scenario']=='tron':tron_module('native_tron_assets').read_materialized(inputs['tron_cli'])
    try:
        with (out/'observer.log').open('xb') as observer_log,(out/'harness.log').open('xb') as harness_log:
            controller=subprocess.Popen([str(checked(manifest['verifier']['python'],True)),'-s','-B',str(checked(manifest['verifier']['script'])),'serve','--manifest',str(checked(plan['manifestArtifact']))],cwd=repo,env=env,stdout=observer_log,stderr=subprocess.STDOUT,start_new_session=True)
            ready=min(deadline,time.monotonic()+30)
            while not (case/'evidence/controller.json').exists():
                require(time.monotonic()<ready and controller.poll() is None,'Observer startup failed/expired');time.sleep(.05)
            record=json.loads((case/'evidence/controller.json').read_text())
            require(record['pid']==controller.pid and record['execution_approval']==manifest['execution_approval'] and record['runtime_source_commit']==manifest['runtime_source_commit'],'Foreign observer readiness descriptor')
            harness=subprocess.Popen([sys.executable,'-I','-B',str(Path(__file__).resolve()),'--helper-bootstrap','--plan',str(args.plan),'--plan-sha256',args.plan_sha256,'--output',str(out)],cwd=plan['harness_cwd'],env=env,stdin=subprocess.PIPE,stdout=harness_log,stderr=subprocess.STDOUT,start_new_session=True)
            helper_row=owner._linux_row(harness.pid)
            require(helper_row is not None,'Actual helper identity missing')
            with (out/'helper-launch.json').open('x') as context:
                context.write(json.dumps({'helper_pid':harness.pid,'helper_start':helper_row['start']})+'\n');context.flush();os.fsync(context.fileno())
            if plan['scenario']=='starknet':
                devnets=starknet_custody().Custody(case,harness.pid,helper_row['start'],inputs['starknet_devnet'],out,docker_call)
                devnets.arm()
            if plan['scenario']=='radix':
                require(inputs['radix_daemon']==approval['radix_daemon'],'Radix daemon approval differs')
                info=json.loads(docker_call(['info','--format','{{json .}}']));daemon=inputs['radix_daemon'];directory=Path(info['DockerRootDir']).resolve(strict=True)
                require(info.get('OSType')=='linux' and info['ID']==daemon['ID'] and str(directory)==daemon['DockerRootDir'] and directory.stat().st_dev==daemon['filesystem_device']==case.stat().st_dev,'Actual Radix daemon/filesystem differs before GO')
                volume_spec=importlib.util.spec_from_file_location('native_radix_volume',Path(__file__).with_name('native_radix_volume.py'))
                volume=importlib.util.module_from_spec(volume_spec);volume_spec.loader.exec_module(volume)
                radix=radix_custody().Custody(case,harness.pid,helper_row['start'],inputs['radix_localnet'],out,docker_call,volume_sample=lambda name:volume.sample_volume(name,args.original_deadline_ns));radix.arm()
                radix_transport=arm_radix_transport(plan,manifest,approval,repo,inputs['radix_localnet'],info,args.original_deadline_ns)
                radix_scraper=arm_radix_scraper(plan,manifest,approval,repo,args.original_deadline_ns)
                radix_publisher=radix_custody().LoopbackPublisher(radix,owner._linux_row,lambda:harness.poll()is not None or controller.poll()is not None,args.original_deadline_ns)
            if plan['scenario']=='tron':
                devnets=tron_module('native_tron_custody').Custody(case,harness.pid,helper_row['start'],inputs['tron_tre'],out,docker_call);devnets.arm()
            require(harness.stdin is not None,'Owned helper bootstrap pipe missing')
            harness.stdin.write(b'GO\n');harness.stdin.flush();harness.stdin.close()
            pg_name='ziggy-e2e-'+hashlib.sha256(os.fsencode(case)).hexdigest()[:10]+'-'+str(harness.pid)+'-scraper-testnet-postgres'
            next_inspect=0
            while harness.poll() is None:
                require(time.monotonic()<deadline and controller.poll() is None,'Case deadline/observer failed')
                if radix_publisher is not None:radix_publisher.check()
                if time.monotonic()>=next_inspect:
                    inspect()
                    if radix is not None:
                        if radix_transport is not None:radix_transport['state'].begin_custody()
                        radix.observe()
                        if radix_publisher is not None:radix_publisher.observe()
                        diagnostic_end=min(args.original_deadline_ns,time.monotonic_ns()+500_000_000)
                        observe_radix_transport(radix_transport,radix,harness,controller,helper_row,diagnostic_end)
                        observe_radix_scraper(radix_scraper,manifest,inputs,case,harness,controller,helper_row,diagnostic_end)
                    elif devnets is not None:devnets.observe()
                    else:native_listener_proof(plan['scenario'],manifest,inputs,case,checked(plan['lsofArtifact'],True),node_proofs)
                    observe_relayer_startup(startup_context,manifest,inputs,case,harness,controller,helper_row,args.original_deadline_ns)
                    next_inspect=time.monotonic()+1
                time.sleep(.1)
            code=harness.wait();result['direct_waits'].append({'role':'harness','pid':harness.pid,'actual_parent_wait':True,'exit_code':code,'observed_monotonic_ns':time.monotonic_ns()});require(code==0,'Actual native Rust/verifier failed')
            if radix_publisher is not None:radix_publisher.check()
            final=case/'evidence/verified-final-native.jsonl';lines=checked(pin(final)).read_text().splitlines()
            require(lines and json.loads(lines[-1]).get('verified') is True,'Actual final native verification absent')
            waits=fixture_waits(case/'evidence/fixture-parent-waits.jsonl',plan['scenario'],harness.pid)
            if plan['scenario']=='sealevel':
                pg_waits=[r for r in waits if r['role']=='fixture-docker']
                require(len(pg_waits)==1,'Actual Source SVM PG parent wait absent')
                stop=pg_waits[0].get('planned_container_stop',{})
                require(stop.get('kind')=='postgres'and stop.get('container_id')==cid and stop.get('exact_owned_CID_absent')is True and pg_waits[0].get('success')is True and pg_waits[0].get('exit_code')==0 and pg_waits[0].get('signal')is None,'Actual SVM PG wait/immutable CID differs')
            if radix is not None:
                require(set(radix.ready)==set(radix_custody().SERVICES),'All five immutable Radix services must have passed readiness')
                pg_wait=waits[0];stop=pg_wait.get('planned_container_stop',{})
                require(pg_wait.get('success')is True and pg_wait.get('exit_code')==0 and pg_wait.get('signal')is None and stop.get('kind')=='postgres' and stop.get('container_id')==cid and stop.get('exact_owned_CID_absent')is True,'Actual foreground agent PG wait/CID binding missing')
                closed=radix_custody().shared().read_record(case/'radix-localnet/stopped.json')
                require(closed.get('project')==radix.project and closed.get('removed')==radix.seen and closed.get('all_owned_containers_absent')is True and closed.get('actual_client_waits')is True and closed.get('runtime_source_commit')==manifest['runtime_source_commit'],'Source Radix stop receipt differs from captured CIDs')
                clients=radix_custody().client_waits(case/'evidence/radix-client-parent-waits.jsonl',harness.pid,manifest['verifier_tools']['docker'],manifest['runtime_source_commit'],manifest['mode'])
                result['native_container_proofs']={'captured_CIDs':radix.seen,'maximum_writable_layer_bytes':radix.maximum_writable_bytes,'maximum_gateway_volume_bytes':radix.maximum_volume_bytes,'latest_gateway_volume_observation':radix.last_volume_observation,'actual_Docker_client_parent_waits':clients,'daemon_containers_are_not_parent_waits':True,'source_stopped':closed}
            elif plan['scenario']=='starknet':
                require(set(devnets.ready)=={5050,5070},'Both actual immutable devnets must have passed readiness')
                pg_waits=[r for r in waits if r.get('planned_container_stop',{}).get('kind')=='postgres']
                require(len(pg_waits)==1 and pg_waits[0]['planned_container_stop'].get('container_id')==cid and pg_waits[0]['planned_container_stop'].get('exact_owned_CID_absent') is True,'Actual PG Child wait must bind the captured PG CID')
                planned=[r for r in waits if r.get('planned_container_stop',{}).get('kind')=='starknet']
                require(len(planned)==2 and {r['planned_container_stop'].get('port') for r in planned}=={5050,5070},'Actual two Starknet foreground Child waits required')
                for row in planned:
                    stop=row['planned_container_stop'];require(stop['container_id']==devnets.ready[stop['port']] and stop.get('exact_owned_CID_absent') is True and stop.get('completed_before_original_deadline') is True and stop.get('acceptance_failed_before_cleanup') is False and stop.get('pre_stop_live_identity') and row.get('success') is True and row.get('exit_code')==0 and row.get('signal') is None,'Starknet planned stop/actual wait differs from captured immutable CID')
                require(all(devnets.inspect(port,cleaning=True) is None for port in (5050,5070)),'Source helper left an owned devnet')
                result['native_container_proofs']={'captured_CIDs':devnets.ready,'maximum_writable_layer_bytes':devnets.maximum_writable_bytes,'actual_foreground_parent_waits':planned}
            elif plan['scenario']=='tron':
                require(devnets is not None and set(devnets.ready)=={9090},'Actual owned TRE9090 readiness required');pg_wait=next(r for r in waits if r['planned_container_stop']['kind']=='postgres');tre_wait=next(r for r in waits if r['planned_container_stop']['kind']=='tron')
                require(pg_wait['planned_container_stop']['container_id']==cid and pg_wait['planned_container_stop'].get('exact_owned_CID_absent')is True,'Actual PG wait must bind captured PG CID')
                stop=tre_wait['planned_container_stop'];require(stop.get('port')==9090 and stop.get('container_id')==devnets.ready[9090]and stop.get('exact_owned_CID_absent')is True and stop.get('completed_before_original_deadline')is True and stop.get('acceptance_failed_before_cleanup')is False and stop.get('pre_stop_live_identity'),'Actual TRE foreground wait must bind captured live CID/epoch')
                require(devnets.inspect(9090,cleaning=True)is None,'Source helper left TRE');tron_module('native_tron_assets').read_materialized(inputs['tron_cli']);result['native_container_proofs']={'captured_CIDs':devnets.ready,'maximum_writable_layer_bytes':devnets.maximum_writable_bytes,'actual_foreground_parent_waits':[tre_wait],'synchronous_CLI_wait_scope':'Frozen Source Program::run_full real Child::wait plus successful helper and four actual dispatch/delivery receipts; not a fabricated fixture wait'}
            else:
                require(len(node_proofs)==(1 if plan['scenario']in{'evm','sealevel','sealevel-composite'} else 2),'Actual native loopback listener proof missing')
                node_roles={'fixture-svm-SOL'} if plan['scenario']in{'sealevel','sealevel-composite'}else {'fixture-anvil'} if plan['scenario']=='evm' else {'fixture-hypd' if plan['scenario']=='cosmosnative' else 'fixture-osmosisd'}
                require({r['pid'] for r in waits if r['role'] in node_roles}=={r['pid'] for r in node_proofs.values()},'Native readiness identity differs from actual child waits')
                result['native_listener_proofs']=node_proofs
            if plan['scenario']=='evm':
                stops=[json.loads(line) for line in (case/'evidence/fixture-descendant-stops.jsonl').read_text().splitlines()]
                require(len(stops)==3 and {r['fixture'] for r in stops}=={'anvil','postgres','kathy'} and {r['direct_child_pid'] for r in stops}=={r['pid'] for r in waits} and all(r['parent_wait_completed'] is False and r['unknown_group_members_never_signalled'] is True for r in stops),'Source fixture descendant/parent cleanup binding missing')
            if pg is not None:
                require(cid is not None and kernel,'Actual PG identity/kernel evidence missing')
                require(inspect(cleaning=True) is None,'Source fixture did not remove owned PG')
            else:require(plan['scenario']=='sealevel-composite'and not result['docker_calls'],'NoPG Source composite must make zero Docker calls')
            public_proof=write_public_native_proof(plan,manifest,case,out/'public-final-proof.json',pin(final))
            result.update({'actual_fixture_parent_waits':waits,'actual_final_evidence':pin(final),'public_final_proof':public_proof,'passed':True,'native_case_acceptance':True})
    except BaseException as failure:
        if radix_publisher is not None:radix_publisher.revoke(failure)
        error=failure;result['error']={'type':type(failure).__name__,'message':str(failure)}
    finally:
        old={s:signal.signal(s,signal.SIG_IGN) for s in [signal.SIGTERM,signal.SIGINT,signal.SIGHUP]}
        try:
            if radix is not None:
                try:result['radix_service_observation']=radix.public_observation()
                except Exception:result['radix_service_observation']={'schema':1,'collection_status':'unavailable'}
                if not result['passed']:
                    try:
                        target=radix.failed_fullnode_log_target()
                        if target is not None:
                            result['radix_fullnode_failure_log']=radix_custody().capture_fullnode_log(target,[str(docker),'--host',inputs['local_docker']['host'],'--config',inputs['local_docker']['config_dir']],docker_env,out/'radix-fullnode-failure.log',deadline)
                    except Exception:result['radix_fullnode_failure_log']={'schema':1,'capture_status':'unavailable'}
            if not result['passed']:
                try:result['public_diagnostic_before_stop']=snapshot_public_diagnostics(case,approval,out,'public-observer-before-stop.json')
                except Exception as diagnostic_error:result['public_diagnostic_before_stop_error']={'type':type(diagnostic_error).__name__}
            stop_direct(harness,'harness-cleanup',15)
            stop_direct(controller,'observer',20)
            if radix_publisher is not None:
                try:
                    result['radix_loopback_publisher']=radix_publisher.close(cleanup_deadline)
                    require(result['radix_loopback_publisher']['error_class']is None,'Owned Radix loopback publisher failed')
                except BaseException as publisher_error:
                    result['radix_loopback_publisher_error']={'type':type(publisher_error).__name__};result['passed']=False;result['native_case_acceptance']=False
            if radix is not None:
                recovered=radix.cleanup();result['radix_cleanup']=recovered
                if not recovered['passed'] or recovered['recovery_needed']:result['passed']=False;result['native_case_acceptance']=False
            if devnets is not None:
                recovered=devnets.cleanup();result['devnet_cleanup']=recovered
                if not recovered['container_absent'] or any(r['container_id'] is not None for r in recovered['containers']):result['passed']=False;result['native_case_acceptance']=False
            if harness is not None:
                row=inspect(cleaning=True)
                if row is not None:
                    result['passed']=False;result['native_case_acceptance']=False
                    if row.get('State',{}).get('Running'):docker_call(['container','stop','--time','10',cid],cleaning=True)
                    if inspect(cleaning=True) is not None:docker_call(['container','rm',cid],cleaning=True)
                    require(inspect(cleaning=True) is None,'Owned PG remains after exact cleanup')
            if result['passed']:transaction.restore()
            else:result['generated_restore_deferred_until_outer_descendants_absent']=True
            for row in [*plan['required_inputs'],*approval['python_modules'].values(),*manifest['artifacts'].values(),manifest['execution_approval'],manifest['case_inputs']]:checked(row)
            require(not forced,'Forced fixture cleanup cannot pass native acceptance')
            if plan['scenario']=='tron':tron_module('native_tron_assets').read_materialized(inputs['tron_cli'])
            result['inputs_unchanged_after']=True;result['container_fixture_configured']=pg is not None;result['owned_container_absent']=True if pg is not None else None
        except BaseException as failure:
            result['cleanup_error']={'type':type(failure).__name__,'message':str(failure)};result['passed']=False;result['native_case_acceptance']=False
        finally:
            for signum,handler in old.items():signal.signal(signum,handler)
            result['forced_cleanup']=forced
            if not result['passed']:
                try:result['public_failure_diagnostics']=write_public_failure_diagnostics(plan,manifest,approval,case,out,result,worker_started_ns,startup_context,radix_transport,inputs,original_deadline_ns=args.original_deadline_ns,radix_scraper=radix_scraper)
                except Exception as diagnostic_error:result['public_diagnostic_write_error']={'type':type(diagnostic_error).__name__}
            (out/'worker-result.json').write_text(json.dumps(result,indent=2)+'\n')
    require(result['passed'],'Native worker failed; retain original result')


class tempfile_files:
    def __init__(self,root):self.root=root
    def __enter__(self):
        import tempfile
        self.files=(tempfile.TemporaryFile(dir=self.root),tempfile.TemporaryFile(dir=self.root));return self.files
    def __exit__(self,*unused):
        for stream in self.files:stream.close()


def recover_owned_pg(case, manifest, inputs, worker_output, output):
    calls=[];deadline=time.monotonic()+20;cid=None
    receipt={'container_id':None,'container_absent':False,'calls':calls,'native_parent_wait_credit':False,'whole_cleanup_budget_seconds':20,'scope':'Recovery cleanup only; never repairs primary case failure.'}
    try:
        context=worker_output/'helper-launch.json'
        if not context.exists():
            receipt['container_creation_not_released']=True
            return receipt
        row=json.loads(checked(pin(context)).read_text());pid=row['helper_pid']
        require(type(pid) is int and pid>0 and isinstance(row['helper_start'],str) and row['helper_start'].startswith('linux-ticks:'),'Owned helper launch context malformed')
        pg=inputs['postgres'];name='ziggy-e2e-'+hashlib.sha256(os.fsencode(case)).hexdigest()[:10]+'-'+str(pid)+'-scraper-testnet-postgres'
        receipt['expected_name']=name
        previous=worker_output/'owned-pg.json'
        expected_cid=read_owned_cid(previous) if previous.exists() or previous.is_symlink() else None
        receipt['previously_captured_CID']=expected_cid
        docker=checked(manifest['verifier_tools']['docker'],True)
        env={'PATH':'/usr/bin:/bin','HOME':str(case/'home'),'DOCKER_HOST':inputs['local_docker']['host'],'DOCKER_CONFIG':inputs['local_docker']['config_dir']}
        def call(argv,missing=False):
            require(time.monotonic()<deadline,'Fixed PG recovery cleanup deadline expired')
            child=None
            with tempfile_files(output) as files:
                stdout,stderr=files
                try:
                    child=subprocess.Popen([str(docker),'--host',inputs['local_docker']['host'],'--config',inputs['local_docker']['config_dir'],*argv],env=env,stdin=subprocess.DEVNULL,stdout=stdout,stderr=stderr)
                    child.wait(timeout=min(12,max(.01,deadline-time.monotonic())))
                finally:
                    if child is not None:
                        if child.returncode is None:child.kill()
                        status=child.wait(timeout=3);calls.append({'arguments':argv,'pid':child.pid,'exit_code':status,'actual_parent_wait':True})
                require(os.fstat(stdout.fileno()).st_size<=2*1024**2 and os.fstat(stderr.fileno()).st_size<=65536,'Bounded recovery output')
                stdout.seek(0);stderr.seek(0);wire=stdout.read();detail=stderr.read()
            if missing and missing_container(status,detail,argv[-1]):return None
            require(status==0,'Fixed PG recovery command failed');return wire.decode()
        raw=call(['container','inspect',name],missing=True)
        if raw is not None:
            rows=json.loads(raw);require(len(rows)==1,'Ambiguous PG recovery inspect')
            cid=pg_owned(rows[0],case,pid,pg,name,expected_cid)
            # Identity only: bad caps/unhealthy state never block cleanup.
            if rows[0].get('State',{}).get('Running'):call(['container','stop','--time','10',cid])
            current=call(['container','inspect',cid],missing=True)
            if current is not None:
                values=json.loads(current);require(len(values)==1,'Ambiguous PG recovery CID')
                pg_owned(values[0],case,pid,pg,name,cid);call(['container','rm',cid])
            require(call(['container','inspect',cid],missing=True) is None,'Owned PG remains after recovery')
        receipt['container_absent']=True
    except BaseException as failure:
        receipt['error']={'type':type(failure).__name__,'message':str(failure)}
    finally:
        receipt['container_id']=cid
        (output/'PG-recovery.json').write_text(json.dumps(receipt,indent=2)+'\n')
    return receipt


def recover_owned_starknet(case, manifest, inputs, worker_output, output):
    calls=[];deadline=time.monotonic()+45
    receipt={'container_absent':False,'containers':[],'calls':calls,'native_parent_wait_credit':False,'whole_cleanup_budget_seconds':45,'scope':'Recovery only; cannot repair primary failure or invent Rust Child waits.'}
    try:
        context=worker_output/'helper-launch.json';armed=worker_output/'starknet-armed.json'
        if not context.exists() or not armed.exists():
            require(not context.is_symlink() and not armed.is_symlink(),'Custody context became symlink')
            receipt.update(container_absent=True,creation_not_released=True);return receipt
        row=json.loads(checked(pin(context)).read_text());docker=checked(manifest['verifier_tools']['docker'],True)
        env={'PATH':'/usr/bin:/bin','HOME':str(case/'home'),'DOCKER_HOST':inputs['local_docker']['host'],'DOCKER_CONFIG':inputs['local_docker']['config_dir']}
        def call(arguments,missing=False,cleaning=False):
            require(time.monotonic()<deadline,'Fixed devnet recovery deadline expired');child=None;status=None
            with tempfile_files(output) as files:
                stdout,stderr=files
                try:
                    child=subprocess.Popen([str(docker),'--host',inputs['local_docker']['host'],'--config',inputs['local_docker']['config_dir'],*arguments],env=env,stdin=subprocess.DEVNULL,stdout=stdout,stderr=stderr)
                    child.wait(timeout=min(12,max(.01,deadline-time.monotonic())))
                finally:
                    if child is not None:
                        if child.returncode is None:child.kill()
                        status=child.wait(timeout=3);calls.append({'arguments':arguments,'pid':child.pid,'exit_code':status,'actual_parent_wait':True})
                require(os.fstat(stdout.fileno()).st_size<=2*1024**2 and os.fstat(stderr.fileno()).st_size<=65536,'Bounded devnet recovery output')
                stdout.seek(0);stderr.seek(0);wire=stdout.read();detail=stderr.read()
            if missing and missing_container(status,detail,arguments[-1]):return None
            require(status==0,'Exact devnet recovery command failed');return wire.decode()
        custody=starknet_custody().Custody(case,row['helper_pid'],row['helper_start'],inputs['starknet_devnet'],worker_output,call)
        receipt.update(custody.cleanup())
    except BaseException as error:receipt['error']={'type':type(error).__name__,'message':str(error)}
    finally:(output/'Starknet-recovery.json').write_text(json.dumps(receipt,indent=2)+'\n')
    return receipt


def recover_owned_radix(case, manifest, inputs, worker_output, output):
    calls=[];deadline=time.monotonic()+180
    receipt={'container_absent':False,'containers':[],'calls':calls,'native_parent_wait_credit':False,'whole_cleanup_budget_seconds':180,'scope':'Recovery only; cannot repair primary failure or invent Rust Child waits.'}
    try:
        context=worker_output/'helper-launch.json';armed=worker_output/'radix-armed.json'
        if not context.exists() or not armed.exists():
            require(not context.is_symlink() and not armed.is_symlink(),'Custody context became symlink')
            receipt.update(container_absent=True,creation_not_released=True);return receipt
        row=json.loads(checked(pin(context)).read_text());docker=checked(manifest['verifier_tools']['docker'],True)
        env={'PATH':'/usr/bin:/bin','HOME':str(case/'home'),'DOCKER_HOST':inputs['local_docker']['host'],'DOCKER_CONFIG':inputs['local_docker']['config_dir']}
        def call(arguments,missing=False,cleaning=False):
            require(time.monotonic()<deadline,'Fixed Radix recovery deadline expired');child=None;status=None
            with tempfile_files(output) as files:
                stdout,stderr=files
                try:
                    child=subprocess.Popen([str(docker),'--host',inputs['local_docker']['host'],'--config',inputs['local_docker']['config_dir'],*arguments],env=env,stdin=subprocess.DEVNULL,stdout=stdout,stderr=stderr)
                    child.wait(timeout=min(12,max(.01,deadline-time.monotonic())))
                finally:
                    if child is not None:
                        if child.returncode is None:child.kill()
                        status=child.wait(timeout=3);calls.append({'arguments':arguments,'pid':child.pid,'exit_code':status,'actual_parent_wait':True})
                require(os.fstat(stdout.fileno()).st_size<=2*1024**2 and os.fstat(stderr.fileno()).st_size<=65536,'Bounded Radix recovery output')
                stdout.seek(0);stderr.seek(0);wire=stdout.read();detail=stderr.read()
            if missing and (missing_container(status,detail,arguments[-1]) or radix_custody().missing_object(status,detail,arguments[-1],arguments[0])):return None
            require(status==0,'Exact Radix recovery command failed');return wire.decode()
        custody=radix_custody().Custody(case,row['helper_pid'],row['helper_start'],inputs['radix_localnet'],worker_output,call)
        receipt.update(custody.cleanup())
    except BaseException as error:receipt['error']={'type':type(error).__name__,'message':str(error)}
    finally:(output/'Radix-recovery.json').write_text(json.dumps(receipt,indent=2)+'\n')
    return receipt


def recover_owned_tron(case, manifest, inputs, worker_output, output):
    calls=[];deadline=time.monotonic()+20
    receipt={'container_absent':False,'containers':[],'calls':calls,'native_parent_wait_credit':False,'whole_cleanup_budget_seconds':20,'scope':'Recovery only; cannot repair primary failure or invent Rust Child waits.'}
    try:
        context=worker_output/'helper-launch.json';armed=worker_output/'tron-armed.json'
        if not context.exists() or not armed.exists():
            require(not context.is_symlink() and not armed.is_symlink(),'Custody context became symlink')
            receipt.update(container_absent=True,creation_not_released=True);return receipt
        row=json.loads(checked(pin(context)).read_text());docker=checked(manifest['verifier_tools']['docker'],True)
        env={'PATH':'/usr/bin:/bin','HOME':str(case/'home'),'DOCKER_HOST':inputs['local_docker']['host'],'DOCKER_CONFIG':inputs['local_docker']['config_dir']}
        def call(arguments,missing=False,cleaning=False):
            require(time.monotonic()<deadline,'Fixed devnet recovery deadline expired');child=None;status=None
            with tempfile_files(output) as files:
                stdout,stderr=files
                try:
                    child=subprocess.Popen([str(docker),'--host',inputs['local_docker']['host'],'--config',inputs['local_docker']['config_dir'],*arguments],env=env,stdin=subprocess.DEVNULL,stdout=stdout,stderr=stderr)
                    child.wait(timeout=min(12,max(.01,deadline-time.monotonic())))
                finally:
                    if child is not None:
                        if child.returncode is None:child.kill()
                        status=child.wait(timeout=3);calls.append({'arguments':arguments,'pid':child.pid,'exit_code':status,'actual_parent_wait':True})
                require(os.fstat(stdout.fileno()).st_size<=2*1024**2 and os.fstat(stderr.fileno()).st_size<=65536,'Bounded devnet recovery output')
                stdout.seek(0);stderr.seek(0);wire=stdout.read();detail=stderr.read()
            if missing and missing_container(status,detail,arguments[-1]):return None
            require(status==0,'Exact devnet recovery command failed');return wire.decode()
        custody=tron_module('native_tron_custody').Custody(case,row['helper_pid'],row['helper_start'],inputs['tron_tre'],worker_output,call)
        receipt.update(custody.cleanup())
    except BaseException as error:receipt['error']={'type':type(error).__name__,'message':str(error)}
    finally:(output/'Tron-recovery.json').write_text(json.dumps(receipt,indent=2)+'\n')
    return receipt


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan',type=Path,required=True);parser.add_argument('--plan-sha256',required=True);parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--worker',action='store_true');parser.add_argument('--helper-bootstrap',action='store_true');parser.add_argument('--original-deadline-ns',type=int)
    args=parser.parse_args()
    require(sys.platform=='linux','Actual Linux case owner required')
    plan,manifest,inputs,approval=load_plan(args.plan,args.plan_sha256)
    if args.helper_bootstrap:
        require(sys.stdin.buffer.read(3)==b'GO\n','Original helper launch was not released')
        os.chdir(plan['harness_cwd']);os.execve(str(checked(plan['harnessArtifact'],True)),plan['harness_argv'],plan['explicit_environment'])
    case=Path(manifest['task_root']);require(args.output.is_absolute() and '..' not in args.output.parts and args.output.parent==case and not args.output.exists() and not args.output.is_symlink(),'Exclusive supervision directory inside case required')
    if args.worker:
        require(args.original_deadline_ns is not None,'Original outer case deadline required')
        worker(args,plan,manifest,inputs,approval);return
    census,census_source = functional_census(plan, approval)
    require(shutil.disk_usage(case).free>=6*GIB,'6GiB case floor')
    deadline_ns=time.monotonic_ns()+3600*10**9
    initial_free=shutil.disk_usage(case).free
    sn_resources=starknet_custody() if plan['scenario']=='starknet' else None
    rx_resources=radix_custody() if plan['scenario']=='radix' else None
    tr_resources=tron_module('native_tron_custody')if plan['scenario']=='tron'else None
    owner.enable_subreaper();known={};groups={};child=None;cleanup=None;failure=None;samples=[]
    args.output.mkdir(mode=0o700);worker_output=case/(args.output.name+'-worker');require(not worker_output.exists(),'Preserve earlier worker')
    result={'schema':1,'kind':'owned-linux-native-case-result','scenario':plan['scenario'],'mode':manifest['mode'],'runtime_source_commit':manifest['runtime_source_commit'],'execution_source_commit':approval.get('execution_source_commit',manifest['runtime_source_commit']),'passed':False,'native_case_acceptance':False,'plan':pin(args.plan),'samples':samples,'scope':'Correctness only. Original case deadline/per-ID600..630 unchanged; actual continuous30s restarted-role observations required and retained. Nonchild cleanup never invents Source parent waits.'}
    census_observations = {'source':census_source,'scope':'Untimed functional census up to15s/250k; original wall/RAM/disk/free limits unchanged. Resource sampling cadence includes census duration.'}
    result['functional_allocation_census'] = census_observations
    stark_progress = None
    if plan['scenario'] == 'starknet':
        try: stark_progress = StarknetProgress(plan, manifest, Path(__file__).resolve().parents[2])
        except Exception: result['stark_progress_diagnostic_status'] = 'source_or_tool_binding_unavailable'
    try:
        with (args.output/'owner-worker.log').open('xb') as stream:
            child=subprocess.Popen([sys.executable,'-I','-B',str(Path(__file__).resolve()),'--worker','--plan',str(args.plan),'--plan-sha256',args.plan_sha256,'--output',str(worker_output),'--original-deadline-ns',str(deadline_ns)],env={'PATH':'/usr/bin:/bin','LC_ALL':'C.UTF-8'},stdin=subprocess.DEVNULL,stdout=stream,stderr=subprocess.STDOUT,start_new_session=True)
            groups[child.pid]=child.pid
            while os.waitid(os.P_PID,child.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT) is None:
                rows=owner.processes();owned=owner.owned_processes(rows,child.pid,known,groups,True)
                if stark_progress is not None and (stark_progress.last_clock is None or time.monotonic_ns()-stark_progress.last_clock >= 1_000_000_000):
                    observe_stark_progress(stark_progress, worker_output/'harness.log', owned, args.output/'public-starknet-progress.json', result)
                container_ram,container_disk=container_reservation(plan['scenario'])
                ram=sum(row['rss_bytes'] for row in owned.values())+container_ram
                require(time.monotonic_ns()<deadline_ns and ram<=8*GIB and shutil.disk_usage(case).free>=6*GIB,'Original native case deadline/resource guard before census')
                disk=census.functional_allocated(case,census_observations)+container_disk
                rows=owner.processes();owned=owner.owned_processes(rows,child.pid,known,groups,True)
                ram=sum(row['rss_bytes'] for row in owned.values())+container_ram
                free=shutil.disk_usage(case).free
                if sn_resources is not None:
                    writable=0;record=worker_output/'starknet-writable.json'
                    if record.exists():
                        value=sn_resources.read_record(record);require(value['case_root']==str(case) and value['image_id']==inputs['starknet_devnet']['image_id'] and value['run_token']==inputs['starknet_devnet']['run_token'],'Resource record belongs to another devnet fixture');writable=value['maximum_writable_bytes']
                    ram,disk=sn_resources.resource_charge(sum(row['rss_bytes'] for row in owned.values()),disk-2*GIB,initial_free,free,writable)
                if rx_resources is not None:
                    writable=volume_bytes=0;record=worker_output/'radix-writable.json'
                    if record.exists():
                        value=rx_resources.shared().read_record(record);require(value['case_root']==str(case) and value['fixture']==inputs['radix_localnet'],'Resource record belongs to another Radix fixture');writable=value['maximum_writable_bytes'];volume_bytes=value['maximum_volume_bytes']
                    radix_case_allocated = disk-2*GIB
                    ram,disk=rx_resources.resource_charge(sum(row['rss_bytes'] for row in owned.values()),disk-2*GIB,initial_free,free,writable,volume_bytes)
                if tr_resources is not None:
                    writable=0;record=worker_output/'tron-writable.json'
                    if record.exists():
                        value=tr_resources.read_record(record);require(value['case_root']==str(case)and value['image_id']==inputs['tron_tre']['image_id']and value['run_token']==inputs['tron_tre']['run_token'],'Tron resource record identity differs');writable=value['maximum_writable_bytes']
                    ram,disk=tr_resources.resource_charge(sum(row['rss_bytes']for row in owned.values()),disk-2*GIB,initial_free,free,writable)
                resource_observed_ns = time.monotonic_ns()
                resource_guard_passed = resource_observed_ns<deadline_ns and ram<=8*GIB and disk<=plan['maximum_case_allocated_bytes'] and free>=6*GIB
                if rx_resources is not None and not resource_guard_passed:
                    try:
                        result['radix_resource_limit_failure'] = rx_resources.public_resource_failure(sum(row['rss_bytes'] for row in owned.values()),radix_case_allocated,initial_free,free,writable,volume_bytes,ram,disk,resource_observed_ns,deadline_ns)
                    except Exception as diagnostic_error:
                        result['radix_resource_diagnostic_error'] = {'type':type(diagnostic_error).__name__}
                require(resource_guard_passed,'Original native case deadline/resource guard')
                require((args.output/'owner-worker.log').stat().st_size<=32*1024**2,'Bounded owner log')
                samples.append({'monotonic_ns':time.monotonic_ns(),'owned_host_RAM_plus_PG_cap_bytes':ram,'case_allocated_plus_PG_tmpfs_cap_bytes':disk,'host_free_bytes':free,'owned_process_count':len(owned),**({'container_memory_reservation_bytes':5*GIB,'disk_scope':'max(case allocation, host filesystem free drop)+2GiB PG tmpfs; initial image acquisition excluded, ongoing6GiB floor'} if plan['scenario']=='starknet'else{'container_memory_reservation_bytes':4*GIB,'disk_scope':'max(case allocation plus TRE writable, host filesystem free drop)+2GiB PG tmpfs; reviewed8GiB native case cap/6GiB floor'}if plan['scenario']=='tron'else{})})
                time.sleep(.2)
    except BaseException as error:
        failure=error;result['error']={'type':type(error).__name__,'message':str(error)}
    finally:
        old={s:signal.signal(s,signal.SIG_IGN) for s in [signal.SIGTERM,signal.SIGINT,signal.SIGHUP]}
        try:
            if child is not None:
                if plan['scenario']in{'starknet','radix','tron'}:
                    try:cleanup=owner.stop_owned(child,known,groups,grace_seconds=180 if plan['scenario']=='radix'else 60,kill_seconds=3)
                    except BaseException as cleanup_error:result['process_cleanup_error']={'type':type(cleanup_error).__name__,'message':str(cleanup_error)}
                else:cleanup=owner.stop_owned(child,known,groups,grace_seconds=180 if plan['scenario']=='radix'else 60,kill_seconds=3)
            result['cleanup']=cleanup
            if plan['scenario']=='starknet':result['devnet_cleanup']=recover_owned_starknet(case,manifest,inputs,worker_output,args.output)
            if plan['scenario']=='tron':result['devnet_cleanup']=recover_owned_tron(case,manifest,inputs,worker_output,args.output)
            if plan['scenario']=='radix':result['radix_cleanup']=recover_owned_radix(case,manifest,inputs,worker_output,args.output)
            result['PG_cleanup']=recover_owned_pg(case,manifest,inputs,worker_output,args.output)if plan['scenario']!='sealevel-composite'else {'configured':False,'cleanup_attempted':False,'scope':'Source composite has no PG/scraper'}
            if plan['scenario']in{'starknet','tron'}:require(result['devnet_cleanup'].get('container_absent') is True and not any(r.get('container_id') is not None for r in result['devnet_cleanup'].get('containers',[])),'Devnet recovery needed/unproven; primary case cannot pass')
            if plan['scenario']=='radix':require(result['radix_cleanup'].get('passed')is True and result['radix_cleanup'].get('container_absent')is True and result['radix_cleanup'].get('recovery_needed')is False,'Radix recovery needed/unproven; primary case remains failed')
            require(plan['scenario']=='sealevel-composite'and result['PG_cleanup']=={'configured':False,'cleanup_attempted':False,'scope':'Source composite has no PG/scraper'}or result['PG_cleanup'].get('container_absent') is True and result['PG_cleanup'].get('container_id') is None,'PG needed recovery or creation context missing; case remains failed')
            require(cleanup and cleanup['clean'] and cleanup['actual_parent_wait'] and child.returncode==0 and not cleanup['signals'],'Owner cleanup/actual worker wait failed or required residual signals')
            worker_result=json.loads(checked(pin(worker_output/'worker-result.json')).read_text())
            require(worker_result.get('passed') is True and worker_result.get('native_case_acceptance') is True and container_observation_ok(plan['scenario'],worker_result)and worker_result.get('inputs_unchanged_after') is True,'Actual worker acceptance missing')
            require(failure is None,'Primary case failure remains failed')
            result['worker_result']=pin(worker_output/'worker-result.json');result['passed']=True;result['native_case_acceptance']=True
        except BaseException as error:
            result['postflight_error']={'type':type(error).__name__,'message':str(error)}
        finally:
            try:
                before=worker_output/'generated-slots/before.json'
                if plan['scenario']=='evm' and not result['passed'] and before.exists():
                    require(cleanup and cleanup.get('cleanup_confirmed_absent') is True,'Defer restore: owned consumers absence unproven')
                    rows=json.loads(checked(pin(before)).read_text())
                    require(isinstance(rows,list) and [row.get('relative_path') for row in rows]==list(GENERATED),'Generated recovery set differs')
                    transaction=GeneratedSlots.__new__(GeneratedSlots);transaction.repo=Path(__file__).resolve().parents[2];transaction.evidence=before.parent;transaction.rows=rows
                    for row in rows:
                        if row['before'] is not None:require(row['before']['path']==str(transaction.repo/row['relative_path']),'Generated backup belongs to another checkout')
                    transaction.restore();result['generated_recovery_completed']=True
            except BaseException as recovery_error:
                result['generated_recovery_error']={'type':type(recovery_error).__name__,'message':str(recovery_error)};result['passed']=False;result['native_case_acceptance']=False
            try:
                for row in [*plan['required_inputs'],*approval['python_modules'].values(),*manifest['artifacts'].values(),manifest['execution_approval'],manifest['case_inputs']]:checked(row)
                checked(census_source)
                result['accepted_inputs_unchanged_after']=True
            except BaseException as pin_error:
                result['input_error']={'type':type(pin_error).__name__,'message':str(pin_error)};result['passed']=False;result['native_case_acceptance']=False
            worker_record=worker_output/'worker-result.json'
            if worker_record.exists()and not worker_record.is_symlink():result['worker_result']=pin(worker_record)
            for signum,handler in old.items():signal.signal(signum,handler)
            result['observed_owned_identities']=list(known.values());(args.output/'result.json').write_text(json.dumps(result,indent=2)+'\n')
    require(result['passed'],'Owned native case failed')


if __name__=='__main__':
    def interrupted(sig,frame):raise RuntimeError('Native case interrupted '+str(sig))
    for sig in [signal.SIGTERM,signal.SIGINT,signal.SIGHUP]:signal.signal(sig,interrupted)
    main()
