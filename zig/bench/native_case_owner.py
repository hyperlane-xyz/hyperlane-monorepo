#!/usr/bin/env python3
"""One reviewed Linux native case; reusable ownership code, no builds or downloads."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import time

spec = importlib.util.spec_from_file_location('cold_matrix_owner', Path(__file__).with_name('cold_matrix_owner.py'))
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)
GIB = 1024 ** 3
LABEL_ROOT = 'io.hyperlane.ziggy.case-root'
LABEL_PID = 'io.hyperlane.ziggy.harness-pid'
LABEL_TOKEN = 'io.hyperlane.ziggy.run-token'
GENERATED = ('typescript/infra/config/environments/test/ism/addresses.json', 'typescript/infra/config/environments/test/ism/verification.json', 'typescript/infra/config/environments/test/core/addresses.json', 'typescript/infra/config/environments/test/core/verification.json', 'rust/main/config/testnet_config.json', 'rust/main/app-contexts/testnet_config.json')
FILTERS = {'evm': [], 'cosmosnative': ['--exact', 'cosmosnative::test::test_run', '--nocapture', '--test-threads=1'], 'cosmwasm': ['--exact', 'cosmos::test::test_run', '--nocapture', '--test-threads=1']}


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


def load_plan(path, expected_sha):
    require(pin(path)['sha256'] == expected_sha, 'Approved launch plan changed')
    plan = json.loads(path.read_text())
    require(type(plan.get('schema')) is int and plan['schema'] == 1 and plan.get('root_approved') is True and plan.get('scenario') in FILTERS, 'Approved initial native family plan required')
    require(all(type(plan.get(k)) is int and plan[k] == v for k,v in {'maximum_owned_RAM_bytes':8*GIB,'maximum_case_allocated_bytes':4*GIB,'minimum_host_free_bytes':6*GIB,'maximum_wall_seconds':3600,'confirm_seconds':600,'grace_seconds':30,'clean_fixture_parent_waits_required':3}.items()), 'Native lifecycle/resource policy changed')
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
    for code in [Path(__file__).resolve(),Path(owner.__file__).resolve()]:
        require(pin(code) in plan['required_inputs'],'Exact owner/shared ownership Source closure missing')
    for row in approval['python_modules'].values(): checked(row)
    env = plan['explicit_environment']
    require(isinstance(env, dict) and all(isinstance(k,str) and isinstance(v,str) for k,v in env.items()) and not any(k in env for k in ['GH_TOKEN','GITHUB_TOKEN','ACTIONS_RUNTIME_TOKEN','DOCKER_CONTEXT','DOCKER_AUTH_CONFIG','PYTHONPATH','PYTHONHOME']), 'Ambient credentials/context cannot enter case environment')
    require(inputs['local_docker'] == approval['local_docker'] and env.get('DOCKER_HOST') == inputs['local_docker']['host'] and env.get('DOCKER_CONFIG') == str(case/'docker-config') and inputs['local_docker']['config_dir'] == str(case/'docker-config'), 'Exact independent Docker capability required')
    return plan, manifest, inputs, approval


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
    roles = ['fixture-anvil','fixture-kathy','fixture-postgres'] if scenario=='evm' else ['fixture-docker', 'fixture-hypd' if scenario=='cosmosnative' else 'fixture-osmosisd', 'fixture-hypd' if scenario=='cosmosnative' else 'fixture-osmosisd']
    require(len(rows)==3 and all(type(r.get('pid')) is int and r['pid']>0 for r in rows) and len({r['pid'] for r in rows})==3 and sorted(r['role'] for r in rows)==sorted(roles), 'Actual fixture child wait set differs')
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


def worker(args, plan, manifest, inputs, approval):
    case=Path(manifest['task_root']);out=args.output;out.mkdir(mode=0o700)
    env=plan['explicit_environment'];pg=inputs['postgres'];docker=checked(manifest['verifier_tools']['docker'],True)
    for name in ('controller.json','controller.sock'):require(not (case/'evidence'/name).exists(), 'Preserve existing controller')
    controller=harness=None;cid=None;pg_name=None;kernel=False;error=None;forced=False;node_proofs={}
    result={'schema':1,'kind':'native-case-worker-observation','passed':False,'native_case_acceptance':False,'docker_calls':[],'direct_waits':[]}
    deadline=args.original_deadline_ns/1e9
    cleanup_deadline=deadline+45
    docker_env={'PATH':'/usr/bin:/bin','HOME':str(case/'home'),'DOCKER_HOST':inputs['local_docker']['host'],'DOCKER_CONFIG':inputs['local_docker']['config_dir']}
    def docker_call(arguments, missing=False, cleaning=False):
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
        if missing and missing_container(code,detail,arguments[-1]):return None
        require(code==0,'Owned Docker command failed')
        return wire.decode()
    def inspect(cleaning=False):
        nonlocal cid,kernel
        if harness is None:return
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
        result['direct_waits'].append({'role':role,'pid':child.pid,'actual_parent_wait':True,'exit_code':code})
        require(not result['passed'] or role!='observer' or code==0,'Observer failed during actual final close')
    repo=Path(__file__).resolve().parents[2]
    transaction=GeneratedSlots(repo,out/'generated-slots',plan['scenario']=='evm')
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
            require(harness.stdin is not None,'Owned helper bootstrap pipe missing')
            harness.stdin.write(b'GO\n');harness.stdin.flush();harness.stdin.close()
            pg_name='ziggy-e2e-'+hashlib.sha256(os.fsencode(case)).hexdigest()[:10]+'-'+str(harness.pid)+'-scraper-testnet-postgres'
            next_inspect=0
            while harness.poll() is None:
                require(time.monotonic()<deadline and controller.poll() is None,'Case deadline/observer failed')
                if time.monotonic()>=next_inspect:
                    inspect();native_listener_proof(plan['scenario'],manifest,inputs,case,checked(plan['lsofArtifact'],True),node_proofs);next_inspect=time.monotonic()+1
                time.sleep(.1)
            code=harness.wait();result['direct_waits'].append({'role':'harness','pid':harness.pid,'actual_parent_wait':True,'exit_code':code});require(code==0,'Actual native Rust/verifier failed')
            final=case/'evidence/verified-final-native.jsonl';lines=checked(pin(final)).read_text().splitlines()
            require(lines and json.loads(lines[-1]).get('verified') is True,'Actual final native verification absent')
            waits=fixture_waits(case/'evidence/fixture-parent-waits.jsonl',plan['scenario'],harness.pid)
            require(len(node_proofs)==(1 if plan['scenario']=='evm' else 2),'Actual native loopback listener proof missing')
            node_roles={'fixture-anvil'} if plan['scenario']=='evm' else {'fixture-hypd' if plan['scenario']=='cosmosnative' else 'fixture-osmosisd'}
            require({r['pid'] for r in waits if r['role'] in node_roles}=={r['pid'] for r in node_proofs.values()},'Native readiness identity differs from actual child waits')
            result['native_listener_proofs']=node_proofs
            if plan['scenario']=='evm':
                stops=[json.loads(line) for line in (case/'evidence/fixture-descendant-stops.jsonl').read_text().splitlines()]
                require(len(stops)==3 and {r['fixture'] for r in stops}=={'anvil','postgres','kathy'} and {r['direct_child_pid'] for r in stops}=={r['pid'] for r in waits} and all(r['parent_wait_completed'] is False and r['unknown_group_members_never_signalled'] is True for r in stops),'Source fixture descendant/parent cleanup binding missing')
            require(cid is not None and kernel,'Actual PG identity/kernel evidence missing')
            require(inspect(cleaning=True) is None,'Source fixture did not remove owned PG')
            result.update({'actual_fixture_parent_waits':waits,'actual_final_evidence':pin(final),'passed':True,'native_case_acceptance':True})
    except BaseException as failure:
        error=failure;result['error']={'type':type(failure).__name__,'message':str(failure)}
    finally:
        old={s:signal.signal(s,signal.SIG_IGN) for s in [signal.SIGTERM,signal.SIGINT,signal.SIGHUP]}
        try:
            stop_direct(harness,'harness-cleanup',15)
            stop_direct(controller,'observer',20)
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
            result['inputs_unchanged_after']=True;result['owned_container_absent']=True
        except BaseException as failure:
            result['cleanup_error']={'type':type(failure).__name__,'message':str(failure)};result['passed']=False;result['native_case_acceptance']=False
        finally:
            for signum,handler in old.items():signal.signal(signum,handler)
            result['forced_cleanup']=forced
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
    require(shutil.disk_usage(case).free>=6*GIB,'6GiB case floor')
    deadline_ns=time.monotonic_ns()+3600*10**9
    owner.enable_subreaper();known={};groups={};child=None;cleanup=None;failure=None;samples=[]
    args.output.mkdir(mode=0o700);worker_output=case/(args.output.name+'-worker');require(not worker_output.exists(),'Preserve earlier worker')
    result={'schema':1,'kind':'owned-linux-native-case-result','scenario':plan['scenario'],'mode':manifest['mode'],'runtime_source_commit':manifest['runtime_source_commit'],'execution_source_commit':approval.get('execution_source_commit',manifest['runtime_source_commit']),'passed':False,'native_case_acceptance':False,'plan':pin(args.plan),'samples':samples,'scope':'Correctness only. Original case deadline/600..630/restart30 unchanged. Nonchild cleanup never invents Source parent waits.'}
    try:
        with (args.output/'owner-worker.log').open('xb') as stream:
            child=subprocess.Popen([sys.executable,'-I','-B',str(Path(__file__).resolve()),'--worker','--plan',str(args.plan),'--plan-sha256',args.plan_sha256,'--output',str(worker_output),'--original-deadline-ns',str(deadline_ns)],env={'PATH':'/usr/bin:/bin','LC_ALL':'C.UTF-8'},stdin=subprocess.DEVNULL,stdout=stream,stderr=subprocess.STDOUT,start_new_session=True)
            groups[child.pid]=child.pid
            while os.waitid(os.P_PID,child.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT) is None:
                rows=owner.processes();owned=owner.owned_processes(rows,child.pid,known,groups,True)
                ram=sum(row['rss_bytes'] for row in owned.values())+GIB
                disk=owner.allocated(case)+2*GIB
                free=shutil.disk_usage(case).free
                require(time.monotonic_ns()<deadline_ns and ram<=8*GIB and disk<=4*GIB and free>=6*GIB,'Original native case deadline/resource guard')
                require((args.output/'owner-worker.log').stat().st_size<=32*1024**2,'Bounded owner log')
                samples.append({'monotonic_ns':time.monotonic_ns(),'owned_host_RAM_plus_PG_cap_bytes':ram,'case_allocated_plus_PG_tmpfs_cap_bytes':disk,'host_free_bytes':free,'owned_process_count':len(owned)})
                time.sleep(.2)
    except BaseException as error:
        failure=error;result['error']={'type':type(error).__name__,'message':str(error)}
    finally:
        old={s:signal.signal(s,signal.SIG_IGN) for s in [signal.SIGTERM,signal.SIGINT,signal.SIGHUP]}
        try:
            if child is not None:cleanup=owner.stop_owned(child,known,groups,grace_seconds=60,kill_seconds=3)
            result['cleanup']=cleanup
            result['PG_cleanup']=recover_owned_pg(case,manifest,inputs,worker_output,args.output)
            require(result['PG_cleanup'].get('container_absent') is True and result['PG_cleanup'].get('container_id') is None,'PG needed recovery or creation context missing; case remains failed')
            require(cleanup and cleanup['clean'] and cleanup['actual_parent_wait'] and child.returncode==0 and not cleanup['signals'],'Owner cleanup/actual worker wait failed or required residual signals')
            worker_result=json.loads(checked(pin(worker_output/'worker-result.json')).read_text())
            require(worker_result.get('passed') is True and worker_result.get('native_case_acceptance') is True and worker_result.get('owned_container_absent') is True and worker_result.get('inputs_unchanged_after') is True,'Actual worker acceptance missing')
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
                result['accepted_inputs_unchanged_after']=True
            except BaseException as pin_error:
                result['input_error']={'type':type(pin_error).__name__,'message':str(pin_error)};result['passed']=False;result['native_case_acceptance']=False
            for signum,handler in old.items():signal.signal(signum,handler)
            result['observed_owned_identities']=list(known.values());(args.output/'result.json').write_text(json.dumps(result,indent=2)+'\n')
    require(result['passed'],'Owned native case failed')


if __name__=='__main__':
    def interrupted(sig,frame):raise RuntimeError('Native case interrupted '+str(sig))
    for sig in [signal.SIGTERM,signal.SIGINT,signal.SIGHUP]:signal.signal(sig,interrupted)
    main()
