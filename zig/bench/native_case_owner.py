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
RESTART_CLOCK_SCOPE = 'One complete canonical/SDK/checkpoint/readiness proof BEFORE the first live anchor; then continuous actual child/config/authority/admin/no-resubmission and paired role-RPC checks; full canonical/SDK/SQL/checkpoint and stopped-reader proof again at final acceptance. No heavy proof is claimed per live sample.'
RESTART_DEADLINE_SCOPE = 'Python first after_restart entry+120s; not the earlier Rust caller Instant.'
RESTART_FINAL_SCOPE = 'Fresh final canonical/SDK/checkpoint/SQL and stopped-reader verification after live window and clean actual parent waits.'

GIB = 1024 ** 3
LABEL_ROOT = 'io.hyperlane.ziggy.case-root'
LABEL_PID = 'io.hyperlane.ziggy.harness-pid'
LABEL_TOKEN = 'io.hyperlane.ziggy.run-token'
GENERATED = ('typescript/infra/config/environments/test/ism/addresses.json', 'typescript/infra/config/environments/test/ism/verification.json', 'typescript/infra/config/environments/test/core/addresses.json', 'typescript/infra/config/environments/test/core/verification.json', 'rust/main/config/testnet_config.json', 'rust/main/app-contexts/testnet_config.json')
FILTERS = {'evm': [], 'cosmosnative': ['--exact', 'cosmosnative::test::test_run', '--nocapture', '--test-threads=1'], 'cosmwasm': ['--exact', 'cosmos::test::test_run', '--nocapture', '--test-threads=1'], 'starknet': ['--exact', 'starknet::test::test_run', '--nocapture', '--test-threads=1']}


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
    for code in [Path(__file__).resolve(),Path(owner.__file__).resolve(),*([Path(__file__).with_name('native_starknet_custody.py').resolve()] if plan['scenario']=='starknet' else [])]:
        require(pin(code) in plan['required_inputs'],'Exact owner/shared ownership Source closure missing')
    for row in approval['python_modules'].values(): checked(row)
    env = plan['explicit_environment']
    require(isinstance(env, dict) and all(isinstance(k,str) and isinstance(v,str) for k,v in env.items()) and not any(k in env for k in ['GH_TOKEN','GITHUB_TOKEN','ACTIONS_RUNTIME_TOKEN','DOCKER_CONTEXT','DOCKER_AUTH_CONFIG','PYTHONPATH','PYTHONHOME']), 'Ambient credentials/context cannot enter case environment')
    require(inputs['local_docker'] == approval['local_docker'] and env.get('DOCKER_HOST') == inputs['local_docker']['host'] and env.get('DOCKER_CONFIG') == str(case/'docker-config') and inputs['local_docker']['config_dir'] == str(case/'docker-config'), 'Exact independent Docker capability required')
    return plan, manifest, inputs, approval


def starknet_custody():
    spec=importlib.util.spec_from_file_location('native_starknet_custody',Path(__file__).with_name('native_starknet_custody.py'))
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
    roles = ['fixture-anvil','fixture-kathy','fixture-postgres'] if scenario=='evm' else ['fixture-docker', 'fixture-hypd' if scenario=='cosmosnative' else 'fixture-osmosisd', 'fixture-hypd' if scenario=='cosmosnative' else 'fixture-osmosisd']
    if scenario=='starknet':
        roles=['fixture-docker']*3
        require(all(r.get('success') is True and r.get('exit_code')==0 and r.get('signal') is None for r in rows),'All three Source container Child waits must be actual clean success')
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
    require(isinstance(snapshot,dict) and snapshot.get('scenario') in {'evm','cosmosnative','cosmwasm','starknet'}, 'Public projection family not implemented')
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
        native.append({'id':value['id'],'operation':row})
    canonical=[]
    for value in snapshot.get('stopped_canonical_Rust_readback',[]):
        verified=[]
        for item in value['verified_canonical_messages']:
            row=fields(item,('id','nonce','processed','gas_expenditure_record_present'));row['payment']=money(item.get('payment'));row['spent']=money(item.get('spent'));verified.append(row)
        raw=value['actual_Rust_output']
        canonical.append({'origin':value['origin'],'reader':raw['reader'],'origin_domain':raw['origin_domain'],'origin_nonce_count':raw['origin_nonce_count'],'verified_canonical_messages':verified,'actual_Rust_output_canonical_JSON_sha256':hashlib.sha256(json.dumps(raw,sort_keys=True,separators=(',',':')).encode()).hexdigest()})
    sql=[]
    for value in snapshot.get('postgres',[]):
        row=fields(value,('id','origin','destination','payments_supported'))
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
        row=fields(value,('id','native_identity','independently_verified_signature','independent_Ed25519_verified','signer','sequence','account_number','signed_upfront_fee','retained_intent_fingerprint_verified','identity','account','public_key','account_nonce','allocated_fee','whole_fee','rounding_dust','context','expected_context_checked','configuration_authority_verified'))
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
        for key in ('actual_publications','actual_validator_publications'):
            if key in value:readiness[key]=checkpoint_rows(value[key])
    transactions=[]
    for value in snapshot['native_delivery_transactions']:
        proof=value['proof'];row=fields(value,('chain','transaction_hash'));row['canonical']=fields(proof,('identity','block_hash','height','index','gas_used','gas_price','tokens_used','fee','units','slot','transaction_index','message_ids','chain_id','actual_fee','fee_unit'))
        if isinstance(proof.get('receipt'),dict):row['canonical']['receipt']=fields(proof['receipt'],('transactionHash','blockHash','blockNumber','transactionIndex','status','gasUsed','effectiveGasPrice','transaction_hash','block_hash','block_number','execution_status','finality_status'))
        if isinstance(proof.get('transaction'),dict):row['canonical']['sender']=fields(proof['transaction'],('from','sender_address','chainId','nonce'))
        if proof.get('signed') is not None:row['canonical']['signed']=fingerprint(proof['signed'])
        transactions.append(row)
    waits=[]
    for value in snapshot.get('parent_wait_receipts',[]):
        row=fields(value,('role','pid','parent_pid','os_start_token','purpose','parent_wait_completed','already_exited','forced_kill','success','exit_code','signal','planned_exit'))
        if 'executable' in value:row['executable']=fields(value['executable'],('path','bytes','sha256'))
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
    out.update(messages=messages,deliverable_ids=delivered,per_id_lifecycle=life,native_delivery_transactions=transactions,broadcasts=broadcasts,native_operations=native,stopped_canonical_Rust_readback=canonical,postgres=sql,family_native_row_proofs=crypto,checkpoint_proofs=checkpoints,actual_EVM_accounting=accounting)
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


def write_public_failure_diagnostics(plan,manifest,approval,case,out,result,started_ns):
    observed=snapshot_public_diagnostics(case,approval,out,'public-observer-diagnostics.json')
    value=None if observed is None else json.loads(checked(observed['artifact']).read_text())
    # Rust locations explain failures outside the recorded observer boundary;
    # an observer exception retains its own approved Python source frames.
    rust=[];log=out/'harness.log'
    if log.exists()and(value is None or not value['failures']):
        rust=diagnostic_module(approval).rust_panic_sites(log,plan.get('diagnostic_rust_sources',{}),Path(__file__).resolve().parents[2])
    record={'schema':1,'kind':'public-native-failure-observation','runtime_source_commit':manifest['runtime_source_commit'],'execution_source_commit':plan['execution_source_commit'],'scenario':manifest['scenario'],'mode':manifest['mode'],'worker_started_monotonic_ns':started_ns,'observed_after_owned_waits_monotonic_ns':time.monotonic_ns(),'observer_before_stop':result.get('public_diagnostic_before_stop'),'observer_after_stop':observed,'rust_panic_source_locations':rust,'rust_location_scope':'Only canonical panic-header locations matched to exact pinned Source; no message, thread, payload or inferred execution credit. Unknown/ambiguous paths omitted.','harness_log_fingerprint':pin(log)if log.exists()else None,'actual_direct_parent_waits':[{k:row[k]for k in ['role','pid','actual_parent_wait','exit_code','observed_monotonic_ns']if k in row}for row in result['direct_waits']],'native_or_timing_credit':False}
    path=out/'public-failure-diagnostics.json';require(not path.exists()and not path.is_symlink(),'Preserve public failure record')
    with path.open('x')as stream:json.dump(record,stream,sort_keys=True,separators=(',',':'));stream.write('\n');stream.flush();os.fsync(stream.fileno())
    require(path.stat().st_size<=512*1024,'Public failure record bound')
    return pin(path)


def worker(args, plan, manifest, inputs, approval):
    case=Path(manifest['task_root']);out=args.output;out.mkdir(mode=0o700);worker_started_ns=time.monotonic_ns()
    env=plan['explicit_environment'];pg=inputs['postgres'];docker=checked(manifest['verifier_tools']['docker'],True)
    for name in ('controller.json','controller.sock'):require(not (case/'evidence'/name).exists(), 'Preserve existing controller')
    controller=harness=None;cid=None;pg_name=None;kernel=False;error=None;forced=False;node_proofs={};devnets=None
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
        result['direct_waits'].append({'role':role,'pid':child.pid,'actual_parent_wait':True,'exit_code':code,'observed_monotonic_ns':time.monotonic_ns()})
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
            if plan['scenario']=='starknet':
                devnets=starknet_custody().Custody(case,harness.pid,helper_row['start'],inputs['starknet_devnet'],out,docker_call)
                devnets.arm()
            require(harness.stdin is not None,'Owned helper bootstrap pipe missing')
            harness.stdin.write(b'GO\n');harness.stdin.flush();harness.stdin.close()
            pg_name='ziggy-e2e-'+hashlib.sha256(os.fsencode(case)).hexdigest()[:10]+'-'+str(harness.pid)+'-scraper-testnet-postgres'
            next_inspect=0
            while harness.poll() is None:
                require(time.monotonic()<deadline and controller.poll() is None,'Case deadline/observer failed')
                if time.monotonic()>=next_inspect:
                    inspect()
                    if devnets is not None:devnets.observe()
                    else:native_listener_proof(plan['scenario'],manifest,inputs,case,checked(plan['lsofArtifact'],True),node_proofs)
                    next_inspect=time.monotonic()+1
                time.sleep(.1)
            code=harness.wait();result['direct_waits'].append({'role':'harness','pid':harness.pid,'actual_parent_wait':True,'exit_code':code,'observed_monotonic_ns':time.monotonic_ns()});require(code==0,'Actual native Rust/verifier failed')
            final=case/'evidence/verified-final-native.jsonl';lines=checked(pin(final)).read_text().splitlines()
            require(lines and json.loads(lines[-1]).get('verified') is True,'Actual final native verification absent')
            waits=fixture_waits(case/'evidence/fixture-parent-waits.jsonl',plan['scenario'],harness.pid)
            if devnets is not None:
                require(set(devnets.ready)=={5050,5070},'Both actual immutable devnets must have passed readiness')
                pg_waits=[r for r in waits if r.get('planned_container_stop',{}).get('kind')=='postgres']
                require(len(pg_waits)==1 and pg_waits[0]['planned_container_stop'].get('container_id')==cid and pg_waits[0]['planned_container_stop'].get('exact_owned_CID_absent') is True,'Actual PG Child wait must bind the captured PG CID')
                planned=[r for r in waits if r.get('planned_container_stop',{}).get('kind')=='starknet']
                require(len(planned)==2 and {r['planned_container_stop'].get('port') for r in planned}=={5050,5070},'Actual two Starknet foreground Child waits required')
                for row in planned:
                    stop=row['planned_container_stop'];require(stop['container_id']==devnets.ready[stop['port']] and stop.get('exact_owned_CID_absent') is True and stop.get('completed_before_original_deadline') is True and stop.get('acceptance_failed_before_cleanup') is False and stop.get('pre_stop_live_identity') and row.get('success') is True and row.get('exit_code')==0 and row.get('signal') is None,'Starknet planned stop/actual wait differs from captured immutable CID')
                require(all(devnets.inspect(port,cleaning=True) is None for port in (5050,5070)),'Source helper left an owned devnet')
                result['native_container_proofs']={'captured_CIDs':devnets.ready,'maximum_writable_layer_bytes':devnets.maximum_writable_bytes,'actual_foreground_parent_waits':planned}
            else:
                require(len(node_proofs)==(1 if plan['scenario']=='evm' else 2),'Actual native loopback listener proof missing')
                node_roles={'fixture-anvil'} if plan['scenario']=='evm' else {'fixture-hypd' if plan['scenario']=='cosmosnative' else 'fixture-osmosisd'}
                require({r['pid'] for r in waits if r['role'] in node_roles}=={r['pid'] for r in node_proofs.values()},'Native readiness identity differs from actual child waits')
                result['native_listener_proofs']=node_proofs
            if plan['scenario']=='evm':
                stops=[json.loads(line) for line in (case/'evidence/fixture-descendant-stops.jsonl').read_text().splitlines()]
                require(len(stops)==3 and {r['fixture'] for r in stops}=={'anvil','postgres','kathy'} and {r['direct_child_pid'] for r in stops}=={r['pid'] for r in waits} and all(r['parent_wait_completed'] is False and r['unknown_group_members_never_signalled'] is True for r in stops),'Source fixture descendant/parent cleanup binding missing')
            require(cid is not None and kernel,'Actual PG identity/kernel evidence missing')
            require(inspect(cleaning=True) is None,'Source fixture did not remove owned PG')
            public_proof=write_public_native_proof(plan,manifest,case,out/'public-final-proof.json',pin(final))
            result.update({'actual_fixture_parent_waits':waits,'actual_final_evidence':pin(final),'public_final_proof':public_proof,'passed':True,'native_case_acceptance':True})
    except BaseException as failure:
        error=failure;result['error']={'type':type(failure).__name__,'message':str(failure)}
    finally:
        old={s:signal.signal(s,signal.SIG_IGN) for s in [signal.SIGTERM,signal.SIGINT,signal.SIGHUP]}
        try:
            if not result['passed']:
                try:result['public_diagnostic_before_stop']=snapshot_public_diagnostics(case,approval,out,'public-observer-before-stop.json')
                except Exception as diagnostic_error:result['public_diagnostic_before_stop_error']={'type':type(diagnostic_error).__name__}
            stop_direct(harness,'harness-cleanup',15)
            stop_direct(controller,'observer',20)
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
            result['inputs_unchanged_after']=True;result['owned_container_absent']=True
        except BaseException as failure:
            result['cleanup_error']={'type':type(failure).__name__,'message':str(failure)};result['passed']=False;result['native_case_acceptance']=False
        finally:
            for signum,handler in old.items():signal.signal(signum,handler)
            result['forced_cleanup']=forced
            if not result['passed']:
                try:result['public_failure_diagnostics']=write_public_failure_diagnostics(plan,manifest,approval,case,out,result,worker_started_ns)
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
    initial_free=shutil.disk_usage(case).free
    sn_resources=starknet_custody() if plan['scenario']=='starknet' else None
    owner.enable_subreaper();known={};groups={};child=None;cleanup=None;failure=None;samples=[]
    args.output.mkdir(mode=0o700);worker_output=case/(args.output.name+'-worker');require(not worker_output.exists(),'Preserve earlier worker')
    result={'schema':1,'kind':'owned-linux-native-case-result','scenario':plan['scenario'],'mode':manifest['mode'],'runtime_source_commit':manifest['runtime_source_commit'],'execution_source_commit':approval.get('execution_source_commit',manifest['runtime_source_commit']),'passed':False,'native_case_acceptance':False,'plan':pin(args.plan),'samples':samples,'scope':'Correctness only. Original case deadline/per-ID600..630 unchanged; actual continuous30s restarted-role observations required and retained. Nonchild cleanup never invents Source parent waits.'}
    try:
        with (args.output/'owner-worker.log').open('xb') as stream:
            child=subprocess.Popen([sys.executable,'-I','-B',str(Path(__file__).resolve()),'--worker','--plan',str(args.plan),'--plan-sha256',args.plan_sha256,'--output',str(worker_output),'--original-deadline-ns',str(deadline_ns)],env={'PATH':'/usr/bin:/bin','LC_ALL':'C.UTF-8'},stdin=subprocess.DEVNULL,stdout=stream,stderr=subprocess.STDOUT,start_new_session=True)
            groups[child.pid]=child.pid
            while os.waitid(os.P_PID,child.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT) is None:
                rows=owner.processes();owned=owner.owned_processes(rows,child.pid,known,groups,True)
                ram=sum(row['rss_bytes'] for row in owned.values())+(5 if plan['scenario']=='starknet' else 1)*GIB
                disk=owner.allocated(case)+2*GIB
                free=shutil.disk_usage(case).free
                if sn_resources is not None:
                    writable=0;record=worker_output/'starknet-writable.json'
                    if record.exists():
                        value=sn_resources.read_record(record);require(value['case_root']==str(case) and value['image_id']==inputs['starknet_devnet']['image_id'] and value['run_token']==inputs['starknet_devnet']['run_token'],'Resource record belongs to another devnet fixture');writable=value['maximum_writable_bytes']
                    ram,disk=sn_resources.resource_charge(sum(row['rss_bytes'] for row in owned.values()),disk-2*GIB,initial_free,free,writable)
                require(time.monotonic_ns()<deadline_ns and ram<=8*GIB and disk<=4*GIB and free>=6*GIB,'Original native case deadline/resource guard')
                require((args.output/'owner-worker.log').stat().st_size<=32*1024**2,'Bounded owner log')
                samples.append({'monotonic_ns':time.monotonic_ns(),'owned_host_RAM_plus_PG_cap_bytes':ram,'case_allocated_plus_PG_tmpfs_cap_bytes':disk,'host_free_bytes':free,'owned_process_count':len(owned),**({'container_memory_reservation_bytes':5*GIB,'disk_scope':'max(case allocation, host filesystem free drop)+2GiB PG tmpfs; initial image acquisition excluded, ongoing6GiB floor'} if plan['scenario']=='starknet' else {})})
                time.sleep(.2)
    except BaseException as error:
        failure=error;result['error']={'type':type(error).__name__,'message':str(error)}
    finally:
        old={s:signal.signal(s,signal.SIG_IGN) for s in [signal.SIGTERM,signal.SIGINT,signal.SIGHUP]}
        try:
            if child is not None:
                if plan['scenario']=='starknet':
                    try:cleanup=owner.stop_owned(child,known,groups,grace_seconds=60,kill_seconds=3)
                    except BaseException as cleanup_error:result['process_cleanup_error']={'type':type(cleanup_error).__name__,'message':str(cleanup_error)}
                else:cleanup=owner.stop_owned(child,known,groups,grace_seconds=60,kill_seconds=3)
            result['cleanup']=cleanup
            if plan['scenario']=='starknet':result['devnet_cleanup']=recover_owned_starknet(case,manifest,inputs,worker_output,args.output)
            result['PG_cleanup']=recover_owned_pg(case,manifest,inputs,worker_output,args.output)
            if plan['scenario']=='starknet':require(result['devnet_cleanup'].get('container_absent') is True and not any(r.get('container_id') is not None for r in result['devnet_cleanup'].get('containers',[])),'Devnet recovery needed/unproven; primary case cannot pass')
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
            worker_record=worker_output/'worker-result.json'
            if worker_record.exists()and not worker_record.is_symlink():result['worker_result']=pin(worker_record)
            for signum,handler in old.items():signal.signal(signum,handler)
            result['observed_owned_identities']=list(known.values());(args.output/'result.json').write_text(json.dumps(result,indent=2)+'\n')
    require(result['passed'],'Owned native case failed')


if __name__=='__main__':
    def interrupted(sig,frame):raise RuntimeError('Native case interrupted '+str(sig))
    for sig in [signal.SIGTERM,signal.SIGINT,signal.SIGHUP]:signal.signal(sig,interrupted)
    main()
