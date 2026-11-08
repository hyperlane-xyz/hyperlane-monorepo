#!/usr/bin/env python3
"""Fetch an explicitly reviewed native-case producer cohort; never build or run cases.

A later validation-only commit may execute producer artifacts only when the
hydrator proves the exact compiled-input trees unchanged. This dispatcher binds
remote run/job/artifact provenance, not chain acceptance or that source proof.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import stat
import subprocess
import tempfile
import time
import zipfile

GIB = 1024 ** 3
REPOSITORY = 'hyperlane-xyz/hyperlane-monorepo'
BRANCH = 'feat/zig-agent-rewrite'
LIMITS = {'maximum_owned_RAM_bytes': 8 * GIB, 'maximum_case_allocated_bytes': 8 * GIB, 'minimum_host_free_bytes': 6 * GIB, 'maximum_wall_seconds': 3600}


def require(value, message):
    if not value:
        raise ValueError(message)


def pin(path):
    require(path.is_file() and not path.is_symlink(), 'Regular nonsymlink input required')
    with path.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    return {'path': str(path.resolve()), 'bytes': path.stat().st_size, 'sha256': digest}



def read_request(path):
    """Read a bounded policy; public SHA-256 values may use two visible halves.

    This keeps machine-generated public digests distinct from raw key literals.
    Existing request/provenance validators receive the same ordinary strings.
    Raw file bytes remain the signed-off request identity throughout execution.
    """
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 1024 ** 2, 'Bounded regular request required')
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, 'Duplicate request key')
            result[key] = value
        return result
    count = 0
    def decode(value, depth=0):
        nonlocal count
        count += 1
        require(depth <= 16 and count <= 4096, 'Request structure bound')
        if isinstance(value, dict):
            if 'sha256_hex_chunks' in value:
                require(set(value) in ({'sha256_hex_chunks'}, {'sha256_hex_chunks', 'prefix'}), 'Unknown public digest fields')
                chunks = value['sha256_hex_chunks']; prefix = value.get('prefix', '')
                require(isinstance(chunks, list) and len(chunks) == 2 and all(isinstance(part, str) and re.fullmatch('[0-9a-f]{32}', part) for part in chunks), 'Exact public SHA-256 halves required')
                require(isinstance(prefix, str) and (prefix == '' or re.fullmatch(r'(?:[a-z0-9._/-]+@)?sha256:', prefix)), 'Invalid public digest prefix')
                return prefix + ''.join(chunks)
            return {key: decode(item, depth + 1) for key, item in value.items()}
        if isinstance(value, list):
            return [decode(item, depth + 1) for item in value]
        return value
    return decode(json.loads(path.read_text(), object_pairs_hook=unique))


def checked(row):
    require(isinstance(row, dict) and set(row) == {'path', 'bytes', 'sha256'}, 'Exact descriptor required')
    path = Path(row['path'])
    require(path.is_absolute() and '..' not in path.parts and pin(path) == row, 'Input descriptor changed')
    return path


def artifact_names(request):
    return {'sdk': 'zig-native-runtime-payload-' + request['mode'], 'helper': 'zig-native-harness-controls', 'tools': 'zig-native-case-tools-' + request['producer_source_commit'], 'writer_safe': 'zig-native-interop-writer-ReleaseSafe', 'writer_fast': 'zig-native-interop-writer-ReleaseFast', **({'svm':f"svm-linux-prerequisites-{request['producer_run_id']}-{request['producer_run_attempt']}"} if request['scenario']in{'sealevel','sealevel-composite'} else {}), **({'radix_reference':'zig-native-radix-reference-'+request['producer_source_commit']} if request['scenario']=='radix' else {})}


def validate_request(request, require_approved=True):
    fields = {'schema', 'root_approved', 'scenario', 'mode', 'producer_source_commit', 'producer_run_id', 'producer_run_attempt', 'limits', 'artifact_pins', 'postgres', 'prerequisites'}
    require(isinstance(request, dict) and set(request) == fields and type(request['schema']) is int and request['schema'] == 1, 'Unknown/missing native request fields')
    require(type(request['root_approved']) is bool and (request['root_approved'] or not require_approved), 'Reviewed native request approval absent')
    require(request['scenario'] in {'evm', 'cosmosnative', 'cosmwasm', 'starknet', 'sealevel','sealevel-composite','radix','tron'} and request['mode'] in {'ReleaseSafe', 'ReleaseFast'}, 'Initial native family/mode not implemented')
    require(isinstance(request['producer_source_commit'], str) and re.fullmatch('[0-9a-f]{40}', request['producer_source_commit']), 'Exact compiled producer Source required')
    require(type(request['producer_run_id']) is int and request['producer_run_id'] > 0 and type(request['producer_run_attempt']) is int and request['producer_run_attempt'] > 0, 'Exact producer run and attempt required')
    require(request['limits'] == LIMITS and all(type(value) is int for value in request['limits'].values()), 'Native resource/lifecycle policy changed')
    pg = request['postgres']
    if request['scenario']=='sealevel-composite':require(pg is None,'Source SVM composite has no PG fixture policy')
    else:
        require(isinstance(pg, dict) and set(pg) == {'schema', 'architecture', 'image', 'image_id', 'canonical_digest'} and type(pg['schema']) is int and pg['schema'] == 2 and pg['architecture'] in {'amd64', 'arm64'} and pg['image'] == 'postgres:14', 'Exact portable Source PG14 policy required')
        require(isinstance(pg['image_id'], str) and re.fullmatch('sha256:[0-9a-f]{64}', pg['image_id']) and isinstance(pg['canonical_digest'], str) and re.fullmatch('postgres@sha256:[0-9a-f]{64}', pg['canonical_digest']), 'Independent PG config ID and RepoDigest required')
    prerequisites = request['prerequisites']
    keys = {'local_checkout_build', 'hpack', 'registry_commit'} | ({'native_cli'} if request['scenario'] not in {'evm','tron','radix','sealevel','sealevel-composite'} else set()) | ({'radix_images','radix_contracts','radix_reference'} if request['scenario']=='radix' else set()) | ({'tron_cli','tron_tre'}if request['scenario']=='tron'else set()) | ({'svm_offline'} if request['scenario']in{'sealevel','sealevel-composite'} else set()) | ({'wasm_bundle'} if request['scenario'] == 'cosmwasm' else set()) | ({'starknet_devnet','starknet_contracts'} if request['scenario']=='starknet' else set())
    require(isinstance(prerequisites, dict) and set(prerequisites) == keys and prerequisites['local_checkout_build'] is True, 'Reviewed prerequisite source policy required')
    require(isinstance(prerequisites['registry_commit'], str) and re.fullmatch('[0-9a-f]{40}', prerequisites['registry_commit']) if request['scenario'] == 'evm' else prerequisites['registry_commit'] is None, 'Registry policy must match actual family consumption')
    require(prerequisites['hpack'] == {'version': '4.2.0', 'wheel_sha256': '858ac0b02280fa582b5080d68db0899c6' + '2a80375e0e5413a74970c5e518b6986', 'wheel_bytes': 34246}, 'Exact passive H2 wheel policy required')
    if request['scenario'] not in {'evm','starknet','tron','radix','sealevel','sealevel-composite'}:
        cli = prerequisites['native_cli']
        require(isinstance(cli, dict) and set(cli) == {'name', 'architecture', 'source_url', 'bytes', 'sha256'} and cli['name'] == ('hypd' if request['scenario'] == 'cosmosnative' else 'osmosisd') and cli['architecture'] == pg['architecture'] and isinstance(cli['source_url'], str) and cli['source_url'].startswith('https://') and type(cli['bytes']) is int and 0 < cli['bytes'] <= 256 * 1024 ** 2 and re.fullmatch('[0-9a-f]{64}', cli['sha256']), 'Exact native CLI acquisition policy required')
    if request['scenario'] == 'cosmwasm':
        spec = importlib.util.spec_from_file_location('request_cw_assets', Path(__file__).with_name('native_cw_assets.py'))
        assets = importlib.util.module_from_spec(spec); spec.loader.exec_module(assets)
        assets.validate_policy(prerequisites, pg['architecture'])
    if request['scenario']=='starknet':
        spec=importlib.util.spec_from_file_location('request_starknet_assets',Path(__file__).with_name('native_starknet_assets.py'))
        assets=importlib.util.module_from_spec(spec);spec.loader.exec_module(assets);assets.validate_policy(prerequisites,pg['architecture'])
    if request['scenario']in{'sealevel','sealevel-composite'}:
        spec=importlib.util.spec_from_file_location('request_svm_case',Path(__file__).with_name('native_svm_case.py'))
        svm=importlib.util.module_from_spec(spec);spec.loader.exec_module(svm);svm.validate_policy(request)
    if request['scenario']=='radix':
        spec=importlib.util.spec_from_file_location('request_radix_case',Path(__file__).with_name('native_radix_case.py'))
        radix=importlib.util.module_from_spec(spec);spec.loader.exec_module(radix);radix.validate_policy(request)
    if request['scenario']=='tron':
        spec=importlib.util.spec_from_file_location('request_tron_assets',Path(__file__).with_name('native_tron_assets.py'));assets=importlib.util.module_from_spec(spec);spec.loader.exec_module(assets);assets.validate_policy(prerequisites,pg['architecture'])
    pins = request['artifact_pins']
    names = artifact_names(request)
    require(isinstance(pins, dict) and set(pins) == set(names), 'Exact family producer artifact set required')
    require(len({row.get('id') for row in pins.values() if isinstance(row, dict)}) == len(names), 'Repeated/invalid producer artifact ID')
    for key, expected_name in names.items():
        row = pins[key]
        require(isinstance(row, dict) and set(row) == {'id', 'name', 'sha256', 'size_in_bytes'}, 'Artifact descriptor fields differ')
        require(type(row['id']) is int and row['id'] > 0 and row['name'] == expected_name and isinstance(row['sha256'], str) and re.fullmatch('[0-9a-f]{64}', row['sha256']), 'Exact artifact ID/name/digest required')
        require(type(row['size_in_bytes']) is int and 0 < row['size_in_bytes'] <= 4 * GIB, 'Artifact size not bounded')
    return request


def validate_remote(request, run, jobs, artifacts):
    require(run.get('id') == request['producer_run_id'] and type(run.get('id')) is int and run.get('run_attempt') == request['producer_run_attempt'] and run.get('head_sha') == request['producer_source_commit'], 'Producer run/attempt/source mismatch')
    require(run.get('repository', {}).get('full_name') == REPOSITORY and run.get('head_repository', {}).get('full_name') == REPOSITORY and run.get('head_branch') == BRANCH and run.get('event') == 'push' and run.get('path') == '.github/workflows/zig-agents.yml', 'Foreign repository/ref/workflow producer')
    require(run.get('status') in {'completed', 'in_progress'}, 'Producer workflow run not started/invalid')
    # Unrelated unit/SVM failures do not relabel successful producer jobs; require
    # the exact artifact-producing mode and native helper jobs themselves green.
    required_jobs = {'full-sdk-native (ReleaseSafe)', 'full-sdk-native (ReleaseFast)', 'native-harness-controls'} | ({'svm-prerequisites'} if request['scenario']in{'sealevel','sealevel-composite'} else set())
    selected = [row for row in jobs if row.get('name') in required_jobs]
    require(len(selected) == len(required_jobs) and {row['name'] for row in selected} == required_jobs and all(row.get('status') == 'completed' and row.get('conclusion') == 'success' and row.get('run_id') == request['producer_run_id'] for row in selected), 'Actual successful matching producer jobs missing/duplicated')
    output = {}
    for key, expected in request['artifact_pins'].items():
        rows = [row for row in artifacts if row.get('id') == expected['id']]
        require(len(rows) == 1, 'Pinned artifact ID absent/duplicated')
        row = rows[0]
        require(row.get('name') == expected['name'] and row.get('size_in_bytes') == expected['size_in_bytes'] and row.get('expired') is False and row.get('digest') == 'sha256:' + expected['sha256'], 'Remote artifact identity/digest/expiry differs')
        provenance = row.get('workflow_run', {})
        require(provenance.get('id') == request['producer_run_id'] and provenance.get('head_sha') == request['producer_source_commit'] and provenance.get('head_branch') == BRANCH, 'Artifact run provenance differs')
        output[key] = row
    return {'run': run, 'required_jobs': selected, 'artifacts': output, 'unrelated_workflow_conclusion': run.get('conclusion')}


def extract_closed(archive, destination, maximum_bytes=4 * GIB, guard=lambda: None):
    require(not destination.exists() and not destination.is_symlink(), 'Exclusive artifact extraction root required')
    with zipfile.ZipFile(archive) as source:
        rows = source.infolist()
        require(0 < len(rows) <= 25000 and sum(row.file_size for row in rows) <= maximum_bytes, 'Artifact expansion/member cap')
        seen = {}
        for row in rows:
            path = PurePosixPath(row.filename)
            require(row.filename and not row.filename.startswith('/') and '\\' not in row.filename and all(part not in {'', '.', '..'} for part in path.parts) and str(path) == row.filename.rstrip('/'), 'Unsafe artifact path')
            require(str(path) not in seen and not row.flag_bits & 1, 'Duplicate/encrypted artifact member')
            seen[str(path)] = row.is_dir()
            mode = row.external_attr >> 16
            require(stat.S_IFMT(mode) in (0, stat.S_IFDIR if row.is_dir() else stat.S_IFREG), 'Artifact link/nonregular member')
        # Prevalidate the whole archive before creating a single member.
        for row in rows:
            path = PurePosixPath(row.filename)
            require(all(str(parent) not in seen or seen[str(parent)] for parent in path.parents if str(parent) != '.'), 'Artifact file-as-parent conflict')
        destination.mkdir(mode=0o700)
        for row in rows:
            guard()
            target = destination / row.filename
            if row.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.open(row) as incoming, target.open('xb') as outgoing:
                    while chunk := incoming.read(1024 * 1024):
                        guard()
                        outgoing.write(chunk)
                require(target.stat().st_size == row.file_size, 'Truncated artifact member')
                # No execution until the independent hydrator checks ELF+digest.
                target.chmod(0o600)
    return [{'relative_path': str(p.relative_to(destination)), 'bytes': p.stat().st_size, 'sha256': pin(p)['sha256']} for p in sorted(destination.rglob('*')) if p.is_file()]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request', type=Path, required=True)
    parser.add_argument('--request-sha256', required=True)
    parser.add_argument('--execution-source-commit', required=True)
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--gh', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    require(re.fullmatch('[0-9a-f]{40}', args.execution_source_commit) is not None, 'Exact execution Source required')
    request_pin = pin(args.request)
    require(request_pin['sha256'] == args.request_sha256, 'Reviewed request changed')
    request = validate_request(read_request(args.request))
    require(args.repo.resolve() == args.repo and args.output.is_absolute() and not args.output.exists() and not args.output.is_symlink() and not args.output.is_relative_to(args.repo), 'Exclusive output outside checkout required')
    require(shutil.disk_usage(args.output.parent).free >= 6 * GIB, '6GiB staging floor')
    gh_pin = pin(args.gh)
    require(args.gh.is_absolute() and os.access(args.gh, os.X_OK), 'Explicit GitHub CLI required')
    args.output.mkdir(mode=0o700)
    calls, error = [], None
    deadline = time.monotonic() + 600
    started_free = shutil.disk_usage(args.output).free
    # Existing CI token is provided ONLY to gh; never copied to case environments
    # or receipts. No credential/config files are read by this Python process.
    gh_env = {key: os.environ[key] for key in ['PATH', 'GH_TOKEN'] if key in os.environ}
    require('GH_TOKEN' in gh_env, 'Explicit CI read-only token required for artifact download')
    (args.output / 'gh-config').mkdir()
    (args.output / 'home').mkdir()
    gh_env.update({'HOME': str(args.output / 'home'), 'GH_CONFIG_DIR': str(args.output / 'gh-config'), 'GH_PROMPT_DISABLED': '1', 'GH_NO_UPDATE_NOTIFIER': '1', 'LC_ALL': 'C.UTF-8'})
    def call(argv, name, env, maximum=16 * 1024 ** 2):
        process = None
        output = args.output / name
        err = args.output / (name + '.stderr')
        with output.open('xb') as stream, err.open('xb') as errors:
            try:
                process = subprocess.Popen(argv, cwd=args.repo, env=env, stdin=subprocess.DEVNULL, stdout=stream, stderr=errors, start_new_session=True)
                while os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is None:
                    require(time.monotonic() < deadline and output.stat().st_size <= maximum and err.stat().st_size <= 1024 ** 2, 'Artifact command deadline/output guard')
                    raw = Path(f'/proc/{process.pid}/stat').read_text()
                    fields = raw[raw.rindex(')') + 2:].split()
                    require(int(fields[21]) * os.sysconf('SC_PAGE_SIZE') <= 512 * 1024 ** 2, 'Artifact CLI RSS cap')
                    free = shutil.disk_usage(args.output).free
                    require(free >= 6 * GIB and started_free - free <= 4 * GIB, 'Artifact staging growth/floor guard')
                    time.sleep(.1)
            finally:
                if process is not None:
                    if os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is None:
                        # gh builtin API / git rev-parse spawn no external tools.
                        process.kill()
                    code = process.wait(timeout=3)
                    calls.append({'argv': argv, 'pid': process.pid, 'actual_parent_wait': True, 'exit_code': code, 'stdout': pin(output), 'stderr': pin(err)})
        require(code == 0 and output.stat().st_size <= maximum and err.stat().st_size <= 1024 ** 2, 'Artifact command failed/oversized')
        return output
    def api(path, name, maximum=16 * 1024 ** 2):
        return call([str(args.gh), 'api', '--hostname', 'github.com', '-H', 'Accept: application/vnd.github+json', path], name, gh_env, maximum)
    result = {'schema': 1, 'passed': False, 'execution_source_commit': args.execution_source_commit, 'producer_source_commit': request['producer_source_commit'], 'request': request_pin, 'gh': gh_pin, 'calls': calls, 'native_case_acceptance': False}
    try:
        head = call(['/usr/bin/git', 'rev-parse', 'HEAD'], 'execution-head.txt', {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'})
        require(head.read_text().strip() == args.execution_source_commit, 'Actual checkout execution commit differs')
        require(pin(args.request) == request_pin, 'Request changed after checkout identity')
        base = f'repos/{REPOSITORY}/actions/runs/{request["producer_run_id"]}'
        run_path = api(base, 'run.json')
        run = json.loads(run_path.read_text())
        jobs, artifacts = [], []
        for kind, key, collection in [('jobs', 'jobs', jobs), ('artifacts', 'artifacts', artifacts)]:
            for page in range(1, 21):
                path = api(base + '/' + kind + '?per_page=100&page=' + str(page), kind + '-' + str(page) + '.json')
                data = json.loads(path.read_text())
                require(type(data.get('total_count')) is int and data['total_count'] <= 2000 and isinstance(data.get(key), list), 'Bounded remote inventory required')
                collection.extend(data[key])
                if len(collection) >= data['total_count']: break
            require(len(collection) == data['total_count'], 'Incomplete remote inventory')
        result['remote'] = validate_remote(request, run, jobs, artifacts)
        result['artifacts'] = {}
        for key, expected in request['artifact_pins'].items():
            archive = api(f'repos/{REPOSITORY}/actions/artifacts/{expected["id"]}/zip', key + '.zip', expected['size_in_bytes'])
            require(archive.stat().st_size == expected['size_in_bytes'] and pin(archive)['sha256'] == expected['sha256'], 'Downloaded artifact differs from reviewed remote digest')
            destination = args.output / key
            def extraction_guard():
                free = shutil.disk_usage(args.output).free
                require(time.monotonic() < deadline and free >= 6 * GIB and started_free - free <= 4 * GIB, 'Original artifact extraction deadline/growth/floor guard')
            files = extract_closed(archive, destination, guard=extraction_guard)
            extraction_guard()
            result['artifacts'][key] = {'remote': expected, 'archive': pin(archive), 'directory': str(destination), 'files': files}
        cpu = args.output / 'helper/setup/tools-platform.txt'
        result['artifact_pins'] = {'helper_cpu': pin(cpu)}
        require(pin(args.request) == request_pin and pin(args.gh) == gh_pin, 'Dispatcher input changed')
        extraction_guard()
        result['passed'] = True
    except BaseException as failure:
        error = failure
        result['error'] = {'type': type(failure).__name__, 'message': str(failure)}
    finally:
        result['all_owned_jobs_joined'] = all(row['actual_parent_wait'] for row in calls)
        (args.output / 'producer-receipt.json').write_text(json.dumps(result, indent=2) + '\n')
    if error is not None: raise error


if __name__ == '__main__':
    def interrupted(sig, frame):
        raise RuntimeError('Native artifact dispatcher interrupted: ' + str(sig))
    for signum in [signal.SIGTERM, signal.SIGINT, signal.SIGHUP]: signal.signal(signum, interrupted)
    main()
