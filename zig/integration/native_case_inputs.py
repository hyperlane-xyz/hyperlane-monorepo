#!/usr/bin/env python3
"""Hydrate verified Linux CI artifacts into an owned native-case profile.

No artifact acquisition, Cargo/SDK/node build, Docker mutation or native case
execution. Root authority comes from the SAME reviewed case-only request; actual
producer/read-only storage receipts remain mandatory. No Mac binary aliases.
"""
from __future__ import annotations
import argparse
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import secrets
import shutil
import stat
import struct
import subprocess
import sys
import types

ROOT = Path(__file__).resolve().parents[2]
GIB = 1024 ** 3
SCOPES = {
    'runtime': ('zig/src', 'zig/native', 'zig/build.zig', 'zig/build.zig.zon'),
    'helper': ('rust/main', 'rust/sealevel'),
    'tools': ('rust/main', 'rust/sealevel', 'zig/reference'),
}
OPTIONAL_ABSENT = {'zig/build.zig.zon'}
ARCHITECTURES = {'x86_64': ('amd64', 62), 'aarch64': ('arm64', 183)}
SDK_NAMES = {
    'relayer': 'relayer', 'validator': 'validator', 'scraper': 'scraper',
    'hyperlane-aleo-vm-worker': 'worker', 'libziggy_url.so': 'url',
    'libziggy_regex.so': 'regex', 'libziggy_starknet_crypto.so': 'starknet',
    'libziggy_aleo_crypto.so': 'aleo-crypto', 'libziggy_aleo_vm.so': 'aleo-vm',
}
LIMITS = {'maximum_owned_RAM_bytes': 8 * GIB, 'maximum_case_allocated_bytes': 4 * GIB,
          'minimum_host_free_bytes': 6 * GIB, 'maximum_wall_seconds': 3600}


def require(value, message):
    if not value:
        raise ValueError(message)


def checksum(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def regular(path):
    require(path.is_file() and not path.is_symlink(), 'Regular nonsymlink input required')
    return path


def artifact(path):
    regular(path)
    return {'path': str(path), 'bytes': path.stat().st_size, 'sha256': checksum(path)}


def checked(row, executable=False):
    require(isinstance(row, dict) and set(row) == {'path', 'bytes', 'sha256'}, 'Exact artifact descriptor required')
    path = Path(row['path'])
    require(path.is_absolute() and '..' not in path.parts and type(row['bytes']) is int and 0 <= row['bytes'] <= 2 * GIB and re.fullmatch('[0-9a-f]{64}', row['sha256']), 'Invalid artifact descriptor')
    require(artifact(path) == row, 'Artifact bytes changed')
    require(not executable or path.stat().st_mode & 0o111, 'Input executable mode absent')
    return path


def relative_file(directory, relative):
    require(isinstance(relative, str) and '\\' not in relative, 'Invalid relative artifact path')
    value = PurePosixPath(relative)
    require(not value.is_absolute() and str(value) == relative and '..' not in value.parts, 'Artifact path traversal')
    path = directory
    require(directory.is_absolute() and directory.is_dir() and not directory.is_symlink(), 'Artifact root must be regular absolute directory')
    for part in value.parts:
        path /= part
        require(not path.is_symlink(), 'Symlink in artifact path')
    return regular(path)


def read_json(path, maximum=16 * 1024 ** 2):
    regular(path)
    require(path.stat().st_size <= maximum, 'JSON input exceeds bound')
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, 'Duplicate JSON key')
            result[key] = value
        return result
    return json.loads(path.read_text(), object_pairs_hook=unique)


def load_module(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    # Isolated Python excludes script siblings. Permit only this trusted repository
    # module directory while its imports execute, then restore the caller path.
    previous = sys.path[:]
    try:
        sys.path.insert(0, str((ROOT / relative).parent))
        spec.loader.exec_module(module)
    finally:
        sys.path[:] = previous
    return module


def git(repo, *arguments, missing=False, evidence=None):
    result = subprocess.run(['git', *arguments], cwd=repo, capture_output=True, text=True, timeout=15)
    require(len(result.stdout) <= 2 * 1024 ** 2 and len(result.stderr) <= 32768, 'Git evidence output bound')
    if evidence is not None:
        evidence.append({'argv': ['git', *arguments], 'cwd': str(repo), 'exit_code': result.returncode, 'actual_parent_wait': True, 'stdout': result.stdout, 'stderr': result.stderr})
    if missing and result.returncode:
        return None
    require(result.returncode == 0, 'Required local Git object/evidence unavailable; no implicit fetch')
    return result.stdout.strip()


def cohort(repo, producer, execution, family, evidence=None):
    require(family in SCOPES and all(re.fullmatch('[0-9a-f]{40}', value) for value in (producer, execution)), 'Invalid exact source cohort')
    require(git(repo, 'rev-parse', 'HEAD', evidence=evidence) == execution, 'Execution checkout differs from actual CI source')
    require(git(repo, 'cat-file', '-t', producer, evidence=evidence) == 'commit', 'Producer commit must be staged locally')
    rows = []
    for path in SCOPES[family]:
        before = git(repo, 'rev-parse', '--verify', producer + ':' + path, missing=True, evidence=evidence)
        current = git(repo, 'rev-parse', '--verify', execution + ':' + path, missing=True, evidence=evidence)
        if before is None or current is None:
            require(path in OPTIONAL_ABSENT and before is None and current is None and not (repo / path).exists() and not (repo / path).is_symlink(), 'Required tracked input scope absent or untracked shadow present')
        else:
            require(re.fullmatch('[0-9a-f]{40}', before) and before == current, 'Producer/current compiled input scope differs: ' + path)
            require(git(repo, 'diff', '--name-only', 'HEAD', '--', path, evidence=evidence) == '', 'Dirty compiled inputs: ' + path)
        rows.append({'path': path, 'producer_tree': before, 'current_tree': current, 'worktree_unchanged': True})
    return rows


def decoded_locks(repo, evidence):
    tracked = git(repo, 'ls-files', '-z', '--', *sorted({p for paths in SCOPES.values() for p in paths}), evidence=evidence).split('\0')
    records = []
    for name in sorted(n for n in tracked if n.endswith('/Cargo.lock.gz')):
        packed = relative_file(repo, name)
        with gzip.open(packed, 'rb') as stream:
            wire = stream.read(4 * 1024 ** 2 + 1)
        require(len(wire) <= 4 * 1024 ** 2, 'Decoded canonical Cargo lock exceeds bound')
        expected = hashlib.sha256(wire).hexdigest()
        raw = packed.with_suffix('')
        require(not raw.is_symlink(), 'Decoded lock symlink forbidden')
        if raw.exists():
            require(regular(raw).read_bytes() == wire, 'Decoded working lock differs from tracked canonical gzip: ' + name)
        records.append({'canonical': artifact(packed), 'decoded_sha256': expected, 'decoded_bytes': len(wire), 'working': artifact(raw) if raw.exists() else None})
    require(records, 'Canonical standalone lock closure absent')
    return records


def copy_verified(source, expected, destination, mode):
    require(source.stat().st_size == expected['bytes'] and checksum(source) == expected['sha256'], 'Producer content mismatch before copy')
    require(not destination.exists() and not destination.is_symlink(), 'Hydration output must be new')
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with source.open('rb') as src, destination.open('xb') as dst:
        shutil.copyfileobj(src, dst)
    destination.chmod(mode)
    require(checksum(destination) == expected['sha256'] and destination.stat().st_size == expected['bytes'] and stat.S_IMODE(destination.stat().st_mode) == mode, 'Hydrated content/mode mismatch')
    return artifact(destination)


def sdk_inputs(directory, expected_pin, mode, producer, architecture, available_flags):
    manifest = read_json(checked(expected_pin))
    require(Path(expected_pin['path']).resolve() == (directory / 'manifest.json').resolve(), 'SDK manifest path differs')
    require(manifest['passed'] is True and manifest['source_commit'] == producer and manifest['mode'] == mode and manifest['platform'] == 'linux/' + architecture, 'Actual matching SDK source/mode/platform required')
    require(manifest['native_case_acceptance'] is False and manifest['image_started_by_exporter'] is False and manifest['exact_created_CID_removed'] is True and not manifest.get('cleanup_error'), 'SDK export failure or invented native execution')
    require(set(manifest['artifacts']) == set(SDK_NAMES), 'Exact nine SDK payloads required')
    require(manifest['calls'] and all(row['actual_parent_wait'] is True and row['error'] is None for row in manifest['calls']), 'Actual SDK export process waits required')
    exporter = load_module('case_payload_export', 'zig/bench/native_payload_export.py')
    cpu = load_module('case_build_cpu', 'zig/tools/build_cpu.py')
    native = manifest['inputs']['native']; runtime = manifest['inputs']['runtime']
    inputs = []
    for value in (native, runtime):
        path = relative_file(directory, value['path'])
        require(path.stat().st_size == value['bytes'] and checksum(path) == value['sha256'], 'SDK actual receipt differs')
        inputs.append(read_json(path))
    expected = exporter.validate_receipts(inputs[0], inputs[1], mode)
    records, compiled = {}, []
    for name, row in manifest['artifacts'].items():
        path = relative_file(directory, row['path'])
        require(path.stat().st_size == row['bytes'], 'SDK artifact size differs')
        exporter.validate_payload(path, expected[name], architecture)
        records[name] = (path, row)
    require(set(manifest['build_provenance']) == set(cpu.SCOPES), 'All five actual baked CPU provenance scopes required')
    for scope, row in manifest['build_provenance'].items():
        path = relative_file(directory, row['path'])
        require(path.stat().st_size == row['bytes'] and checksum(path) == row['sha256'], 'Baked CPU receipt changed')
        value = cpu.validate(read_json(path), scope, mode, producer, expected)
        require(all(value['artifacts'][n]['bytes'] == manifest['artifacts'][n]['bytes'] for n in cpu.SCOPES[scope]), 'Baked artifact sizes differ')
        compiled.append(value)
    require(cpu.consumer_covers(compiled, architecture, available_flags), 'Consumer CPU does not cover actual compiler host features')
    return manifest, records, compiled


def producer_receipt(request_path, request, receipt_pin, execution):
    receipt = read_json(checked(receipt_pin))
    dispatch = load_module('case_dispatch', 'zig/bench/native_case_ci.py')
    dispatch.validate_request(request)
    require(receipt['passed'] is True and receipt['all_owned_jobs_joined'] is True and receipt['native_case_acceptance'] is False, 'Actual successful download readback required')
    require(receipt['execution_source_commit'] == execution and receipt['producer_source_commit'] == request['producer_source_commit'] and receipt['request'] == artifact(request_path), 'Producer receipt/request/execution cross-binding failed')
    remote = receipt['remote']
    dispatch.validate_remote(request, remote['run'], remote['required_jobs'], list(remote['artifacts'].values()))
    require(receipt['calls'] and all(row['actual_parent_wait'] is True and row['exit_code'] == 0 for row in receipt['calls']), 'Actual dispatcher process waits required')
    require(set(receipt['artifacts']) == set(request['artifact_pins']), 'Exact downloaded artifact closure required')
    for name, row in receipt['artifacts'].items():
        require(row['remote'] == request['artifact_pins'][name], 'Downloaded remote pin differs')
        checked(row['archive'])
        require(row['archive']['sha256'] == request['artifact_pins'][name]['sha256'] and row['archive']['bytes'] == request['artifact_pins'][name]['size_in_bytes'], 'ZIP differs from reviewed artifact')
        directory = Path(row['directory'])
        expected = {f['relative_path']: f for f in row['files']}
        require(len(expected) == len(row['files']), 'Duplicate extracted file record')
        actual = []
        for path in directory.rglob('*'):
            require(not path.is_symlink(), 'Extracted artifact link')
            if path.is_file(): actual.append(str(path.relative_to(directory)))
        require(set(actual) == set(expected), 'Extracted artifact files changed')
        for relative, pin in expected.items():
            path = relative_file(directory, relative)
            require(path.stat().st_size == pin['bytes'] and checksum(path) == pin['sha256'], 'Extracted artifact bytes changed')
    return receipt


def helper_cpu_input(receipt):
    # The dispatcher CPU descriptor must identify the exact ZIP-validated helper
    # setup file, not a separately pinned local file with fewer CPU requirements.
    directory = Path(receipt['artifacts']['helper']['directory'])
    expected = artifact(relative_file(directory, 'setup/tools-platform.txt'))
    require(receipt['artifact_pins']['helper_cpu'] == expected, 'Helper CPU descriptor differs from actual extracted producer setup')
    return checked(expected)


def helper_inputs(directory, producer):
    value = read_json(relative_file(directory, 'result.json'))
    require(value['passed'] is True and value['source_commit'] == producer and value['source_unchanged'] is True and value['all_owned_jobs_joined'] is True and value['native_case_acceptance'] is False, 'Actual immutable helper compile/control gate required')
    require(set(value['products']) == {'normal', 'construction'}, 'Both exact helper products required')
    require(value['checks'] and all(row['actual_parent_wait'] is True and row['exit_code'] == 0 and row['error'] is None and row['cleanup']['clean'] for row in value['checks']), 'Helper actual controls/waits failed')
    records = {}
    for name, row in value['products'].items():
        path = relative_file(directory, row['artifact_relative_path'])
        pin = row['published']
        require(row['producer']['bytes'] == pin['bytes'] and row['producer']['sha256'] == pin['sha256'] and path.stat().st_size == pin['bytes'] and checksum(path) == pin['sha256'], 'Cargo/helper copy differs')
        records[name] = (path, pin)
    return value, records


def writer_inputs(directory, producer, mode, architecture, available_flags):
    value = read_json(relative_file(directory, 'manifest.json'))
    require(value['passed'] is True and value['source_commit'] == producer and value['mode'] == mode, 'Actual matching writer compile required')
    require(value['writer_executed'] is False and value['native_case_acceptance'] is False and value['component_interoperability_acceptance'] is False and value['input_before'] == value['input_after'], 'Writer Source/input fence or scope differs')
    require(value['cpu']['architecture'] == architecture and value['cpu']['flags'] and set(value['cpu']['flags']) <= set(available_flags), 'Writer CPU not covered by consumer')
    pin = value['writer']
    require(pin['path'] == 'bin/native-rows-writer-' + mode, 'Writer mode/path mismatch')
    path = relative_file(directory, pin['path'])
    require(path.stat().st_size == pin['bytes'] and checksum(path) == pin['sha256'], 'Writer ELF bytes differ')
    return value, (path, pin)


def hydrate(request_path, request_sha, receipt_pin, execution, output, repo=ROOT):
    require(sys.platform == 'linux' and platform.machine() in ARCHITECTURES, 'Native Linux hydration only')
    request = load_module('case_reviewed_request_wire', 'zig/bench/native_case_ci.py').read_request(request_path)
    require(checksum(request_path) == request_sha, 'Reviewed selector bytes changed')
    receipt = producer_receipt(request_path, request, receipt_pin, execution)
    producer = request['producer_source_commit']
    architecture, machine = ARCHITECTURES[platform.machine()]
    require(architecture=='amd64'if request['scenario']=='sealevel-composite'else request['postgres']['architecture']==architecture,'Fixture platform differs from actual consumer')
    cpu_module = load_module('case_consumer_cpu', 'zig/tools/build_cpu.py')
    flags = cpu_module.cpu_flags(Path('/proc/cpuinfo').read_text(), intersection=True)
    helper_flags = cpu_module.cpu_flags(helper_cpu_input(receipt).read_text())
    require(set(helper_flags) <= set(flags), 'Helper/tools compiler-host CPU not covered by consumer')
    inputs = {k: Path(v['directory']) for k, v in receipt['artifacts'].items()}
    sdk_pin = artifact(relative_file(inputs['sdk'], 'manifest.json'))
    sdk, sdk_records, compiled = sdk_inputs(inputs['sdk'], sdk_pin, request['mode'], producer, architecture, flags)
    helper, helper_records = helper_inputs(inputs['helper'], producer)
    writers = {mode: writer_inputs(inputs[key], producer, mode, architecture, flags) for key, mode in [('writer_safe', 'ReleaseSafe'), ('writer_fast', 'ReleaseFast')]}
    git_evidence = []
    scopes = {family: cohort(repo, producer, execution, family, git_evidence) for family in SCOPES}
    locks = decoded_locks(repo, git_evidence)
    unhydrated_tools = read_json(relative_file(inputs['tools'], 'manifest.json'))
    radix_reference = None
    if request['scenario']=='radix':
        radix_reference=load_module('hydrate_radix_case','zig/bench/native_radix_case.py').inspect_reference(receipt,request,repo,machine,flags,types.SimpleNamespace(relative_file=relative_file,checksum=checksum,read_json=read_json,artifact=artifact))
    svm = None
    if request['scenario']in{'sealevel','sealevel-composite'}:
        require(architecture=='amd64','SVM requires actual x86_64 publisher assets')
        svm=load_module('hydrate_svm_case','zig/bench/native_svm_case.py').inspect_receipt(receipt,request,repo)
    copied_bytes = (0 if radix_reference is None else radix_reference['product']['bytes']) + sum(row['bytes'] for _, row in sdk_records.values()) + sum(row['bytes'] for _, row in helper_records.values()) + sum(row['bytes'] for _, (_, row) in writers.values()) + sum(row['bytes'] for row in unhydrated_tools['tools'].values())
    if svm: copied_bytes += sum(v['bytes']for v in svm['inspected']['files'].values()) + sum(v['bytes']for v in svm['environment'].values())
    require(copied_bytes <= request['limits']['maximum_case_allocated_bytes'], 'Owned case product copies exceed reviewed disk cap')
    require(shutil.disk_usage(output.parent).free >= request['limits']['minimum_host_free_bytes'] + copied_bytes, 'Hydration must preserve reviewed free disk floor')
    require(re.fullmatch(r'/tmp/znc-[A-Za-z0-9-]{1,45}', str(output)) and output.parent.resolve() == output.parent and not output.exists() and not output.is_symlink(), 'Exclusive short owned /tmp/znc-* root required')
    require(len(str(output / 'evidence/controller.sock').encode()) < 100, 'Controller socket pathname bound')
    require(shutil.disk_usage(output.parent).free >= LIMITS['minimum_host_free_bytes'], '6GiB case floor before hydration')
    output.mkdir(mode=0o700)
    for name in ('home', 'tmp', 'evidence', 'docker-config'): (output / name).mkdir(mode=0o700)
    (output / 'docker-config/config.json').write_text('{}\n')
    (output / 'owned-root.json').write_text(json.dumps({'schema': 1, 'request': artifact(request_path), 'execution_source_commit': execution, 'token': secrets.token_hex(16), 'nodes_started': False}) + '\n')
    tools_module = load_module('case_tool_admission', 'zig/bench/native_case_tools.py')
    runtime = {}
    for name, (path, pin) in sdk_records.items():
        role = SDK_NAMES[name]
        mode = 0o755 if name in {'relayer', 'validator', 'scraper', 'hyperlane-aleo-vm-worker'} else 0o644
        runtime[role] = copy_verified(path, pin, output / 'runtime' / name, mode)
    helper_copies = {name: copy_verified(path, pin, output / 'harness' / name, 0o755) for name, (path, pin) in helper_records.items()}
    for row in helper_copies.values(): tools_module.validate_elf(Path(row['path']), machine)
    writer_copies = {}
    for mode, (_, (path, pin)) in writers.items():
        writer_copies[mode] = copy_verified(path, pin, output / 'writers' / mode, 0o755)
        tools_module.validate_elf(Path(writer_copies[mode]['path']), machine)
    # Transport permissions are normalized only on validated owned COPIES.
    tools_dir = inputs['tools']
    tools_manifest = read_json(relative_file(tools_dir, 'manifest.json'))
    require(set(tools_manifest['tools']) == set(tools_module.TOOLS), 'Exact four tool descriptors required')
    for name, row in tools_manifest['tools'].items():
        path = relative_file(tools_dir, row['relative_path'])
        copy_verified(path, row, output / 'tools' / row['relative_path'], 0o755)
    for name in ('manifest.json', 'source-gate.json'):
        path = relative_file(tools_dir, name)
        copy_verified(path, artifact(path), output / 'tools' / name, 0o644)
    tool_manifest = output / 'tools/manifest.json'
    tools = tools_module.load_manifest(tool_manifest, checksum(tool_manifest), producer, machine)
    runtime['init-db'] = tools['init-db']
    require({family: cohort(repo, producer, execution, family, git_evidence) for family in SCOPES} == scopes, 'Compiled inputs changed during hydration')
    require(decoded_locks(repo, git_evidence) == locks, 'Working decoded Cargo locks changed during hydration')
    log = output / 'evidence/compiled-input-check.log'
    log.write_text(json.dumps({'producer_source_commit': producer, 'execution_source_commit': execution, 'actual_checked_scopes': scopes, 'actual_checked_decoded_locks': locks, 'actual_waited_git_calls': git_evidence, 'method': 'Actual local git object/clean-working-input comparisons returned successfully before any node; missing producer objects fail, never fetched'}, indent=2) + '\n')
    closure = {'schema': 1, 'runtime_source_commit': producer, 'helper_source_commit': producer, 'tools_source_commit': producer, 'execution_source_commit': execution, 'source_unchanged': True, 'native_case_acceptance': False, 'scopes': scopes, 'checks': [{'name': 'all actual tracked input cohort comparisons', 'exit_code': 0, 'log': artifact(log)}]}
    closure_path = output / 'compiled-input-closure.json'
    closure_path.write_text(json.dumps(closure, indent=2) + '\n')
    context = {'schema': 1, 'phase': 'HYDRATED_NOT_EXECUTION_APPROVAL', 'request': artifact(request_path), 'producer_receipt': receipt_pin, 'runtime_source_commit': producer, 'execution_source_commit': execution, 'scenario': request['scenario'], 'mode': request['mode'], 'task_root': str(output), 'runtime_artifacts': runtime, 'harness': helper_copies, 'tools': tools, 'tool_manifest': artifact(tool_manifest), 'writers': writer_copies, 'compiled_input_closure': artifact(closure_path), 'consumer_cpu': {'architecture': architecture, 'flags': flags, 'helper_tools_conservative_flags': helper_flags}, 'nodes_started': False, 'native_case_acceptance': False, 'storage_interoperability_acceptance': False}
    if svm:context['svm_prerequisites']=svm
    if radix_reference is not None:context['radix_reference']=radix_reference
    require(artifact(request_path)['sha256'] == request_sha and checked(receipt_pin), 'Hydration inputs changed')
    path = output / 'hydrated-inputs.json'
    path.write_text(json.dumps(context, indent=2) + '\n')
    return path


def interop_summary(context, raw_results, repo=ROOT):
    require(set(raw_results) == {'safe', 'fast'}, 'Both actual storage interoperability results required')
    modes = {}; sources = None
    for label, mode in [('safe', 'ReleaseSafe'), ('fast', 'ReleaseFast')]:
        value = read_json(checked(raw_results[label]))
        require(value['passed'] is True and value['errors'] == [] and value['source_unchanged'] is True and value['source_before'] == value['source_after'], 'Interop execution/Source gate failed')
        require(value['actual_chain_or_SDK_signature_acceptance'] is False and value['elapsed_confirmation_hold_credit_ms'] == 0, 'Storage proof cannot supply native lifecycle credit')
        expected = {'writer': context['writers'][mode], 'native_reader': context['tools']['ziggy-native-rows'], 'old_canonical_oracle': context['tools']['ziggy-rocks-oracle'], 'rust_message_reference': context['tools']['ziggy-rust-reference']}
        require(value['artifacts'] == expected, 'Interop ran different writer/mode/canonical tools')
        authority = value['tool_producer_authority']
        require(authority['manifest'] == context['tool_manifest'] and authority['source_commit'] == context['runtime_source_commit'], 'Interop lacks actual Linux tool producer authority')
        wait = value['writer_wait_receipt']
        require(type(wait['exit_code']) is int and wait['exit_code'] == 0 and wait['wait_returned'] is True and value['owned_process_cleanup']['writer_reaped'] is True, 'Actual fixture writer wait absent')
        require(value['old_and_new_oracles_sequential'] is True and value['all_database_files_unchanged_by_readers_or_readonly_reopen'] is True and value['reopened_signed_bytes_identical'] is True, 'Independent canonical/read-only order proof absent')
        fixture = Path(value['fixture_root']); require(fixture.is_absolute() and not fixture.is_symlink(), 'Interop fixture path unsafe')
        old = read_json(fixture / 'old-canonical-first-command.json'); native = read_json(fixture / 'native-reader-command.json')
        require(type(old['exit_code']) is int and old['exit_code'] == 0 and type(native['exit_code']) is int and native['exit_code'] == 0 and wait['ended_monotonic'] <= old['started_monotonic'] <= old['ended_monotonic'] <= native['started_monotonic'], 'Old canonical oracle was not actually waited before native reader')
        require(old['argv'][:2] == [expected['old_canonical_oracle']['path'], 'relayer-probe-all'] and native['argv'][0] == expected['native_reader']['path'], 'Actual oracle command identity differs')
        raw_hashes = value['database_file_hashes_after_old_oracle']; require(isinstance(raw_hashes, dict) and raw_hashes, 'Actual database file hashes absent')
        interop_module = load_module('case_raw_interop', 'zig/integration/native_rows_interop.py')
        require(interop_module.database_files(fixture / 'db') == raw_hashes, 'Interop databases changed after readback')
        require(set(value['source_after']) == {'zig/src/native_rows_interop_fixture.zig', 'zig/integration/native_rows_interop.py', 'zig/bench/native_case_tools.py', 'zig/bench/native_harness_census.py'}, 'Exact actual interoperability consumer Source closure required')
        for name, digest in value['source_after'].items():
            require(checksum(relative_file(repo, name)) == digest, 'Actual interop Source changed')
        if sources is None: sources = value['source_after']
        require(sources == value['source_after'], 'Safe/Fast interop source differs')
        modes[label] = {'writer': expected['writer'], 'actual_writer_parent_wait_exit': 0, 'actual_db_files_rehashed': len(raw_hashes), 'raw_result': raw_results[label], 'old_canonical_command': artifact(fixture / 'old-canonical-first-command.json'), 'native_reader_command': artifact(fixture / 'native-reader-command.json')}
    return {'accepted_component_source_and_actual_Zig_storage_interop': True, 'family_chain_SDK_finality_delivery_elapsed600_acceptance': False, 'reader': context['tools']['ziggy-native-rows'], 'modes': modes, 'source_sha256': sources}


def accept_interop(context_path, context_sha, raw_results, repo=ROOT):
    require(checksum(context_path) == context_sha, 'Hydrated context changed')
    context = read_json(context_path)
    require(context['phase'] == 'HYDRATED_NOT_EXECUTION_APPROVAL' and context['nodes_started'] is False, 'Nonexecuting hydrated context required')
    result = interop_summary(context, raw_results, repo)
    path = Path(context['task_root']) / 'accepted-native-rows-interop.json'
    with path.open('x') as stream: json.dump(result, stream, indent=2); stream.write('\n')
    return path


def public_profile(scenario):
    if scenario in{'sealevel','sealevel-composite'}:return load_module('svm_public_profile','zig/bench/native_svm_case.py').profile(scenario)
    if scenario == 'evm':
        chains = ['test1', 'test2', 'test3']
        return {'schema': 1, 'scenario': scenario, 'chain_names': chains,
                'domain_names': dict(zip(('9913371', '9913372', '9913373'), chains)),
                'initial_corpus': {'dispatches': 31, 'deliveries': 20, 'zero_insertions': 10, 'failed_body': 1, 'double_insertions': 10},
                'payments_supported': True, 'additional_refused_dispatches': 1, 'reorg_origin_chain': 'test1',
                'validator_addresses': dict(zip(chains, ('0x15d34aaf54267db7d7c367839aaf71a00a2c6a65', '0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc', '0x976ea74026e726554db657fa54763abd0c3a0aa9'))),
                'relayer_addresses': dict(zip(chains, ('0xa0ee7a142d267c1f36714e4a8f75612f20a79720', '0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f', '0x14dc79964da2c08b23698b3d3cc7ca32193d9955')))}
    if scenario == 'cosmwasm':
        chains = ['cosmostest99990', 'cosmostest99991']
        return {'schema': 1, 'scenario': scenario, 'chain_names': chains,
                'domain_names': dict(zip(('99990', '99991'), chains)),
                'initial_corpus': {'dispatches': 4, 'deliveries': 4, 'zero_insertions': 0, 'failed_body': 0, 'double_insertions': 0},
                'payments_supported': True,
                'validator_addresses': dict.fromkeys(chains, '0x01d7525e91dfc3f594fd366aad70f956b398de9e'),
                'relayer_addresses': dict.fromkeys(chains, 'osmo1l83956lgpak5sun7ggupls7rk7p5cr95499jdf'),
                'expected_unavailable_endpoints': {'schema': 1, 'scenario': 'cosmwasm', 'endpoints': [
                    {'chain': name, 'domain': domain, 'field': 'grpcurls', 'ordinal': 0,
                     'upstream': 'http://localhost:1337', 'healthy_fallback': f'http://127.0.0.1:{port}',
                     'error_type': 'ConnectionRefusedError', 'phase': 'upstream_connect'}
                    for name, domain, port in [(chains[0], 99990, 26603), (chains[1], 99991, 26613)]]},
                'native_limits': {c: {'maximum_fee': str(2**128-1), 'maximum_gas': str(2**64-1)} for c in chains}}
    if scenario=='tron':
        names=['anvil1','anvil2'];return {'schema':1,'scenario':'tron','chain_names':names,'domain_names':dict(zip(('1212538670','1212538671'),names)),'initial_corpus':{'dispatches':4,'deliveries':4,'zero_insertions':0,'failed_body':0,'double_insertions':0},'payments_supported':True,'additional_refused_dispatches':0,'validator_addresses':dict.fromkeys(names,'0xc8599111f29c1e1e061265b4af93ea1f274ad78a'),'relayer_addresses':dict.fromkeys(names,'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH')}
    if scenario == 'starknet':
        chains=['starknettest23448593','starknettest23448594']
        return {'schema':1,'scenario':scenario,'chain_names':chains,
                'domain_names':dict(zip(('23448593','23448594'),chains)),
                'initial_corpus':{'dispatches':10,'deliveries':10,'zero_insertions':0,'failed_body':0,'double_insertions':0},
                'additional_refused_dispatches':0,'payments_supported':False,
                'validator_addresses':dict.fromkeys(chains,'0x15d34aaf54267db7d7c367839aaf71a00a2c6a65'),
                'relayer_addresses':dict.fromkeys(chains,'0x064b48806902a367c8598f4f95c305e8' 'c1a1acba5f082d294a43793113115691')}
    require(scenario == 'cosmosnative', 'Unsupported native profile family')
    chains = ['cosmostestnative1', 'cosmostestnative2']
    return {'schema': 1, 'scenario': scenario, 'chain_names': chains,
            'domain_names': dict(zip(('75898670', '75898671'), chains)),
            'initial_corpus': {'dispatches': 8, 'deliveries': 8, 'zero_insertions': 0, 'failed_body': 0, 'double_insertions': 0},
            'payments_supported': True,
            'validator_addresses': dict.fromkeys(chains, '0xb05b6a0aa112b61a7aa16c19cac27d970692995e'),
            'relayer_addresses': dict.fromkeys(chains, 'hyp1ay22rr3kz659fupu0tcswlagq4ql6rwm8mktdf'),
            'native_limits': {c: {'maximum_fee': str(2**128-1), 'maximum_gas': str(2**64-1)} for c in chains}}


def validate_stage(stage, context, request):
    keys = {'schema', 'passed', 'execution_source_commit', 'scenario', 'source_before', 'source_after', 'checks', 'tools', 'contract_artifacts', 'hpack', 'registry', 'explicit_environment'}
    if context['scenario'] == 'cosmwasm': keys |= {'wasm_bundle', 'static_cli'}
    if context['scenario'] == 'starknet': keys |= {'starknet_assets'}
    if context['scenario']in{'sealevel','sealevel-composite'}: keys |= {'svm_assets'}
    if context['scenario'] == 'radix': keys |= {'radix_assets'}
    if context['scenario']=='tron':keys|={'tron_assets'}
    require(set(stage) == keys and stage['schema'] == 1 and stage['passed'] is True, 'Exact successful local-stage receipt required')
    require(stage['execution_source_commit'] == context['execution_source_commit'] and stage['scenario'] == context['scenario'], 'Stage belongs to another source/scenario')
    require(stage['source_before'] and stage['source_before'] == stage['source_after'], 'Stage changed tracked inputs')
    require(stage['checks'] and all(type(c['exit_code']) is int and c['exit_code'] == 0 and c['actual_parent_wait'] is True for c in stage['checks']), 'Actual local setup/check waits required')
    for row in stage['checks']: checked(row['log'])
    require(stage['tools'] and isinstance(stage['contract_artifacts'], dict) and len(stage['contract_artifacts']) <= 25000, 'Actual local tools/typed contract artifact map required')
    require(bool(stage['contract_artifacts']) if context['scenario'] in {'evm', 'cosmwasm', 'starknet', 'tron'} else stage['contract_artifacts'] == {}, 'EVM needs actual contract outputs; native Cosmos uses built-in hypd modules')
    elf_admission = load_module('case_local_tool_elf', 'zig/bench/native_case_tools.py')
    machine = ARCHITECTURES[platform.machine()][1]
    for name, row in stage['tools'].items():
        path = checked(row, executable=True)
        if name == 'pnpm_launcher':
            with path.open('rb') as stream: prefix = stream.read(4)
            if prefix == b'\x7fELF':
                require(row == stage['tools']['pnpm_native'], 'Native pnpm launcher must be the exact approved native executable')
                elf_admission.validate_elf(path, machine)
            else:
                require(prefix.startswith(b'#!'), 'Existing pnpm launcher must be a pinned script or exact native ELF')
        else:
            elf_admission.validate_elf(path, machine)
    for row in stage['contract_artifacts'].values(): checked(row)
    required = {'cast', 'docker', 'psql', 'ps', 'lsof'}
    required |= {'anvil', 'node', 'pnpm_launcher', 'pnpm_native', 'sh', 'esbuild'} if context['scenario'] == 'evm' else {'node','pnpm_launcher','pnpm_native','sh'}if context['scenario']=='tron'else (set() if context['scenario']in{'radix','sealevel','sealevel-composite'} else {'native_cli'})
    require(set(stage['tools']) == required, 'Exact scenario tools required')
    if context['scenario'] == 'evm':
        require(set(stage['registry']) == {'path', 'commit'} and stage['registry']['commit'] == request['prerequisites']['registry_commit'], 'Reviewed registry commit differs')
        registry = Path(stage['registry']['path'])
        require(registry.is_absolute() and not registry.is_symlink() and git(registry, 'rev-parse', 'HEAD') == stage['registry']['commit'] and git(registry, 'status', '--porcelain', '--untracked-files=no') == '', 'Actual clean registry checkout required')
    else:
        require(stage['registry'] == {'path': None, 'commit': None}, 'Native Cosmos does not consume a TypeScript registry')
        registry = None
    require(isinstance(stage['explicit_environment'], dict) and set(stage['explicit_environment']) <= {'PATH', 'REGISTRY_URI', 'E2E_HYPD_PATH', 'E2E_OSMOSIS_CLI_PATH', 'E2E_STARKLI_CLI_PATH', 'HYPERLANE_CURL_LIBRARY', 'HYPERLANE_CLOUD_CURL_LIBRARY', 'HYPERLANE_LIBCRYPTO_LIBRARY'}, 'Unexpected ambient setup environment')
    require(stage['explicit_environment'].get('PATH'), 'Explicit public tool PATH required')
    require(stage['explicit_environment'].get('REGISTRY_URI') == str(registry) if registry is not None else 'REGISTRY_URI' not in stage['explicit_environment'], 'Registry environment must match actual family consumption')
    for key, value in stage['explicit_environment'].items():
        require(isinstance(value, str) and value and '\x00' not in value and '\n' not in value, 'Malformed explicit stage environment')
    library_keys = {'HYPERLANE_CURL_LIBRARY', 'HYPERLANE_CLOUD_CURL_LIBRARY', 'HYPERLANE_LIBCRYPTO_LIBRARY'}
    library_checks = [c for c in stage['checks'] if c['name'] == 'system-libraries']
    require(len(library_checks) == 1, 'Actual system library descriptor log required')
    libraries = read_json(checked(library_checks[0]['log']))
    require(set(libraries) == library_keys, 'Exact three system library aliases required')
    for key, row in libraries.items():
        path = checked(row)
        require(stage['explicit_environment'].get(key) == str(path), 'System library environment/actual descriptor differs')
        with path.open('rb') as stream: header = stream.read(64)
        require(len(header) == 64 and header[:6] == b'\x7fELF\x02\x01' and struct.unpack_from('<H', header, 18)[0] == machine, 'Wrong system library Linux ELF platform')
    require(libraries['HYPERLANE_CURL_LIBRARY'] == libraries['HYPERLANE_CLOUD_CURL_LIBRARY'], 'Cloud and chain HTTP must use the same actual scoped Curl library')
    dependency = read_json(checked(stage['hpack']))
    require(dependency['accepted_test_dependency_setup'] is True and dependency['version'] == '4.2.0' and dependency['copied_interpreter'] is True and dependency['no_extra_dependencies_or_package_hooks'] is True, 'Actual passive H2 setup required')
    require(dependency['wheel']['bytes'] == request['prerequisites']['hpack']['wheel_bytes'] and dependency['wheel']['sha256'] == request['prerequisites']['hpack']['wheel_sha256'], 'Reviewed Hpack wheel differs')
    checked(dependency['wheel']); checked(dependency['interpreter'], executable=True); checked(dependency['venv_configuration']); checked(dependency['source_metadata'])
    require(len(dependency['files']) == 14 and len({f['path'] for f in dependency['files']}) == 14, 'Exact fourteen Hpack files required')
    for row in dependency['files']: checked(row)
    if context['scenario'] not in {'evm','tron','radix','sealevel','sealevel-composite'}:
        cli = request['prerequisites']['native_cli']
        row = stage['tools']['native_cli']
        require(row['bytes'] == cli['bytes'] and row['sha256'] == cli['sha256'] and cli['name'] == ({'cosmwasm':'osmosisd','cosmosnative':'hypd','starknet':'starkli'}[context['scenario']]) and cli['architecture'] == context['consumer_cpu']['architecture'], 'Reviewed native CLI bytes/platform differ')
    if context['scenario'] == 'cosmwasm':
        cw = load_module('case_closed_cw_assets', 'zig/bench/native_cw_assets.py')
        architecture = context['consumer_cpu']['architecture']
        cw.validate_policy(request['prerequisites'], architecture)
        cw.read_wasm_bundle(stage['wasm_bundle'])
        require(stage['static_cli'] == cw.static_cli(Path(stage['tools']['native_cli']['path']), architecture), 'Actual exact static CLI admission differs')
        require(stage['contract_artifacts'] == stage['wasm_bundle']['files'], 'CW contract map must be the exact closed Source members')
        require(stage['explicit_environment'].get('E2E_OSMOSIS_CLI_PATH') == stage['tools']['native_cli']['path'] and 'E2E_HYPD_PATH' not in stage['explicit_environment'], 'Crossed Cosmos CLI environment')
    if context['scenario'] == 'starknet':
        assets=load_module('validate_starknet_assets','zig/bench/native_starknet_assets.py')
        assets.validate_policy(request['prerequisites'],context['consumer_cpu']['architecture'])
        value=stage['starknet_assets']
        require(set(value)=={'schema','passed','bundle','cli_archive','cli_elf','image_readback','native_code_executed'} and value['schema']==1 and value['passed'] is True and value['native_code_executed'] is False,'Actual nonexecuting Starknet asset readback required')
        assets.read_contracts(value['bundle'])
        require(stage['contract_artifacts']==value['bundle']['files'],'Exact558 Source Starknet contract data required')
        archive=assets.checked(value['cli_archive']);actual=assets.cli_member(archive.read_bytes(),request['prerequisites']['native_cli'])
        require(hashlib.sha256(actual).hexdigest()==stage['tools']['native_cli']['sha256'],'Archive/member CLI differs')
        cli_pin=stage['tools']['native_cli']
        graph=read_json(checked(value['cli_elf']));assets.validate_cli_loader(graph,Path(cli_pin['path']),context['consumer_cpu']['architecture'])
        image=read_json(checked(value['image_readback']))
        assets.image_inspect(image['actual_image_rows'],request['prerequisites']['starknet_devnet'])
        require(image['passed'] is True and image['no_container_or_node_started'] is True and image['all_actual_parent_waits'] is True and image['same_host_filesystem'] is True,'Actual immutable devnet image and local daemon accounting proof required')
        require(stage['explicit_environment'].get('E2E_STARKLI_CLI_PATH')==cli_pin['path'],'Actual scoped Starkli environment differs')
        versions=[c for c in stage['checks'] if c['name']=='native-cli-version-readonly']
        require(len(versions)==1,'Exactly one actual bounded Source0.4.1 version probe required')
        assets.parse_cli_version(checked(versions[0]['log']).read_bytes())
    if context['scenario']in{'sealevel','sealevel-composite'}:
        require(stage['svm_assets']==context['svm_prerequisites'],'Stage SVM dataset differs from actual hydrated artifact')
        load_module('validate_svm_case','zig/bench/native_svm_case.py').check_inspection(stage['svm_assets'],request,ROOT)
    if context['scenario']=='radix':
        load_module('validate_radix_stage','zig/bench/native_radix_case.py').validate_stage(stage['radix_assets'],request,types.SimpleNamespace(checked=checked,read_json=read_json))
    if context['scenario']=='tron':
        assets=load_module('validate_tron_assets','zig/bench/native_tron_assets.py');recipe=load_module('validate_tron_setup','zig/bench/native_tron_setup.py');assets.validate_policy(request['prerequisites'],context['consumer_cpu']['architecture'])
        value=stage['tron_assets'];require(set(value)=={'schema','passed','graph','static_import_audit','compiler_outputs','image_readback','SDK_or_CLI_evaluated','native_case_acceptance','pnpm_archive'}and value['schema']==1 and value['passed']is True and value['SDK_or_CLI_evaluated']is False and value['native_case_acceptance']is False,'Actual closed Linux CLI prerequisite receipt required')
        graph=assets.read_graph(value['graph']);require(graph['architecture']==context['consumer_cpu']['architecture'],'Tron package graph platform differs');assets.cli_source(Path(graph['root']))
        audit=read_json(checked(value['static_import_audit']));require(audit['passed']is True and audit['missing']==[]and audit['opaque']==[]and audit['tronDynamic']is True and audit['actualTVMFactories']is True,'Actual full original CLI static import resolution required')
        require(recipe.compiler_outputs(Path(graph['root']))==value['compiler_outputs'],'Actual EVM0.8.33/TVM0.8.24 metadata changed')
        image=read_json(checked(value['image_readback']));assets.image_inspect(image['actual_image_rows'],request['prerequisites']['tron_tre']);require(image['passed']is True and image['no_container_or_node_started']is True and image['all_actual_parent_waits']is True and image['same_host_filesystem']is True,'Actual TRE immutable image and same-daemon-filesystem admission required')
        policy=recipe.PNPM_RELEASE[context['consumer_cpu']['architecture']];manager=stage['tools']['pnpm_native'];require(manager==stage['tools']['pnpm_launcher']and manager['bytes']==policy['bytes']and manager['sha256']==policy['sha256'],'Exact official Linux native pnpm12.3.0 required');recipe.pnpm_member(checked(value['pnpm_archive']).read_bytes(),context['consumer_cpu']['architecture'])
        for name,version in [('node-version','v26.12.1'),('pnpm-version','12.3.0')]:
            rows=[r for r in stage['checks']if r['name']==name];require(len(rows)==1 and checked(rows[0]['log']).read_text().strip()==version,'Actual Node/pnpm version probe required')
    return dependency


def prepare(context_path, context_sha, interop_pin, stage_pin, repo=ROOT):
    require(sys.platform == 'linux', 'Linux native preparation only')
    require(checksum(context_path) == context_sha, 'Hydrated context changed')
    context = read_json(context_path)
    require(context['phase'] == 'HYDRATED_NOT_EXECUTION_APPROVAL' and context['nodes_started'] is False and context['native_case_acceptance'] is False, 'Expected nonexecuting hydration receipt')
    root = Path(context['task_root'])
    require(root.is_absolute() and root.resolve() == root and context_path == root / 'hydrated-inputs.json', 'Hydrated owned root differs')
    request_path = checked(context['request']); request = load_module('case_reviewed_request_wire', 'zig/bench/native_case_ci.py').read_request(request_path)
    receipt = producer_receipt(request_path, request, context['producer_receipt'], context['execution_source_commit'])
    for category in ['runtime_artifacts', 'tools', 'writers', 'harness']:
        for row in context[category].values(): checked(row, executable=category != 'runtime_artifacts')
    admission = load_module('case_tool_readmission', 'zig/bench/native_case_tools.py')
    readmitted = admission.load_manifest(checked(context['tool_manifest']), context['tool_manifest']['sha256'], context['runtime_source_commit'], ARCHITECTURES[platform.machine()][1])
    require(readmitted == context['tools'], 'Owned tool copies changed since hydration')
    closure = read_json(checked(context['compiled_input_closure']))
    evidence = []
    require({f: cohort(repo, context['runtime_source_commit'], context['execution_source_commit'], f, evidence) for f in SCOPES} == closure['scopes'], 'Source cohort changed after hydration')
    locks = decoded_locks(repo, evidence)
    require(read_json(checked(closure['checks'][0]['log']))['actual_checked_decoded_locks'] == locks, 'Decoded working locks changed since hydration')
    interop = read_json(checked(interop_pin))
    require(interop_summary(context, {k: v['raw_result'] for k, v in interop['modes'].items()}, repo) == interop, 'Interop aggregate differs from actual bound Safe/Fast executions')
    reader = context['tools']['ziggy-native-rows']
    require(interop['accepted_component_source_and_actual_Zig_storage_interop'] is True and interop['family_chain_SDK_finality_delivery_elapsed600_acceptance'] is False and {k: interop['reader'][k] for k in ('path', 'bytes', 'sha256')} == reader, 'Actual independent reader interoperability required')
    require(set(interop['modes']) == {'safe', 'fast'} and all(type(v['actual_writer_parent_wait_exit']) is int and v['actual_writer_parent_wait_exit'] == 0 and v['actual_db_files_rehashed'] > 0 for v in interop['modes'].values()), 'Actual matching Safe/Fast writer/reap/read-only gates required')
    require(interop['source_sha256'], 'Actual interoperability source closure absent')
    for name, expected in interop['source_sha256'].items():
        path = relative_file(repo, name)
        require(checksum(path) == expected, 'Interop source changed before case')
    stage = read_json(checked(stage_pin)); dependency = validate_stage(stage, context, request)
    process = load_module('case_process', 'zig/integration/multivm_process.py')
    verifier = load_module('case_evidence', 'zig/integration/multivm_evidence.py')
    scenario = context['scenario'];radix_required=[];radix_acceptance=None
    if scenario=='radix':
        case_api=types.SimpleNamespace(checked=checked,copy_verified=copy_verified,read_json=read_json,artifact=artifact)
        reference,radix_acceptance,radix_required=load_module('prepare_radix_case','zig/bench/native_radix_case.py').materialize_reference(context['radix_reference'],root,case_api)
        assets=load_module('prepare_radix_assets','zig/bench/native_radix_assets.py');profile=assets.public_profile(reference)
        profile['radix_localnet']=load_module('prepare_radix_configuration','zig/bench/native_radix_case.py').fixture_configuration(secrets.token_hex(16))
        daemon=load_module('prepare_radix_daemon','zig/bench/native_radix_case.py').validate_stage(stage['radix_assets'],request,types.SimpleNamespace(checked=checked,read_json=read_json))
        require(daemon[2]==root.stat().st_dev,'Radix Docker data must share actual case filesystem for volume accounting')
        profile['radix_daemon']={'ID':daemon[0],'DockerRootDir':daemon[1],'filesystem_device':daemon[2]}
        profile['fixture_contracts']=assets.materialize_contracts(artifact(repo/'zig/integration/fixtures/radix-release-v1.0.0.json.gz'),stage['radix_assets']['bundle']['files'],root/'radix-contracts')
    else:profile = public_profile(scenario)
    if scenario!='sealevel-composite':
        profile['postgres'] = {**request['postgres'], 'run_token': secrets.token_hex(16)}
        profile['local_docker'] = {'host': 'unix:///var/run/docker.sock', 'config_dir': str(root / 'docker-config')}
    profile['node_ownership_tools'] = {'lsof': stage['tools']['lsof']}
    fixture = {k: stage['tools'][k] for k in ['anvil', 'node', 'pnpm_launcher', 'pnpm_native', 'sh', 'esbuild']} if scenario == 'evm' else None
    if fixture: profile['fixture_tools'] = fixture
    artifacts = context['runtime_artifacts']
    tools = {k: stage['tools'][k] for k in ['cast', 'docker', 'psql', 'ps']}
    tools.update(oracle=context['tools']['ziggy-rocks-oracle'], native_rows=reader)
    python = dependency['interpreter']; harness = context['harness']['normal' if scenario == 'evm' else 'construction']
    paths = {k: root / (k + '.json') for k in ['manifest', 'execution-approval', 'case-inputs', 'launch-plan']}
    environment = {key: artifacts[value]['path'] for key, value in process.ALIASES.items()}
    environment.update({k: stage['explicit_environment'][k] for k in ('HYPERLANE_CURL_LIBRARY', 'HYPERLANE_CLOUD_CURL_LIBRARY', 'HYPERLANE_LIBCRYPTO_LIBRARY')})
    environment['HYPERLANE_ZIG_DEFAULTS'] = str(repo / 'rust/main/config')
    overrides = {}
    if scenario not in {'evm','tron','radix','sealevel','sealevel-composite'}:
        cli = stage['tools']['native_cli']
        require(shutil.disk_usage(root).free >= request['limits']['minimum_host_free_bytes'] + cli['bytes'], 'Native CLI copy must preserve free disk floor')
        cli_name = {'cosmwasm':'osmosisd','cosmosnative':'hypd','starknet':'starkli'}[scenario]
        cli_key = {'cosmwasm':'E2E_OSMOSIS_CLI_PATH','cosmosnative':'E2E_HYPD_PATH','starknet':'E2E_STARKLI_CLI_PATH'}[scenario]
        owned_cli = copy_verified(Path(cli['path']), cli, root / 'fixture-tools' / cli_name, 0o755)
        overrides = {cli_key: owned_cli}
        if scenario == 'cosmwasm':
            cw = load_module('prepare_closed_cw_assets', 'zig/bench/native_cw_assets.py')
            bundle = cw.materialize_wasm(cw.read_wasm_bundle(stage['wasm_bundle']), root / 'cw-assets')
            profile['fixture_contracts'] = bundle
            cw.static_cli(Path(owned_cli['path']), context['consumer_cpu']['architecture'])
        if scenario == 'starknet':
            sn=load_module('prepare_starknet_assets','zig/bench/native_starknet_assets.py')
            value=stage['starknet_assets'];bundle=value['bundle']
            profile['fixture_contracts']=sn.materialize_contracts(bundle['archive'],bundle['publisher_checksum'],root/'starknet-assets')
            profile['starknet_devnet']={**request['prerequisites']['starknet_devnet'],'run_token':secrets.token_hex(16)}
            profile['expected_starknet_unavailable_endpoints']={'schema':1,'scenario':'starknet','endpoints':verifier.starknet_unavailable_peers()}
            profile['evidence_nodes']={name:{'effective_field':'rpcurls','configured_ordinal':2,'original_url':f'http://127.0.0.1:{port}','connect_url':f'http://127.0.0.1:{port}','rewrite':'identity','source_container_suffix':f'starknet-{port}','host_port':port,'container_port':5050,'source_image':sn.SOURCE_IMAGE,'image_id':profile['starknet_devnet']['image_id'],'command':sn.COMMAND} for name,port in zip(profile['chain_names'],(5050,5070))}
    svm_required=[]
    if scenario in{'sealevel','sealevel-composite'}:
        svm_case=load_module('prepare_svm_case','zig/bench/native_svm_case.py')
        profile['svm_assets'],svm_required=svm_case.materialize(stage['svm_assets'],request,repo,root,context['request'],context['producer_receipt'])
    if scenario=='tron':
        assets=load_module('prepare_tron_assets','zig/bench/native_tron_assets.py');census=load_module('prepare_tron_census','zig/bench/native_harness_census.py');graph=assets.read_graph(stage['tron_assets']['graph']);copied=assets.materialize(graph,root/'tron-cli',census.functional_allocated(root))
        copied_path=root/'tron-cli-copy.json'
        with copied_path.open('x')as stream:json.dump(copied,stream,sort_keys=True);stream.write('\n')
        profile['tron_cli']=artifact(copied_path);profile['tron_tre']={**{k:v for k,v in request['prerequisites']['tron_tre'].items()if k!='schema'},'run_token':secrets.token_hex(16),'cli_directory':str(root/'tron-cli'),'cli_entrypoint':copied['entrypoint'],'pnpm':stage['tools']['pnpm_native']}
    manifest = {'schema': 3, 'implementation': 'zig', 'scenario': scenario, 'runtime_source_commit': context['runtime_source_commit'], 'mode': context['mode'], 'task_root': str(root), 'artifacts': artifacts, 'environment': environment, 'verifier': {'python': python, 'script': artifact(repo / 'zig/integration/multivm_process.py'), 'evidence_root': str(root / 'evidence')}, 'execution_approval': {}, 'case_inputs': {}, 'verifier_tools': tools, 'harness_deadline_seconds': LIMITS['maximum_wall_seconds'], 'tool_overrides': overrides}
    # These four owned files are created only after all actual product/source/setup
    # and independent storage gates above. No node or lifecycle success is inferred.
    def write_new(path, value):
        require(not path.exists() and not path.is_symlink(), 'Prepared output already exists')
        with path.open('x') as stream: json.dump(value, stream, indent=2); stream.write('\n')
    write_new(paths['case-inputs'], profile); case_pin = artifact(paths['case-inputs'])
    gate_path = root / 'evidence/execution-source-gate.json'
    git_log = root / 'evidence/prepare-git.log'
    diagnostic_rust_sources={}
    for name in git(repo,'ls-files','-z','--','rust/main/utils/run-locally/src',evidence=evidence).split('\0'):
        if not name or not name.endswith('.rs'):continue
        require(len(diagnostic_rust_sources)<256,'Bounded diagnostic Rust source set')
        row=artifact(relative_file(repo,name));require(row['bytes']<=1024**2,'Bounded diagnostic Rust source file');diagnostic_rust_sources[name]=row
    require(sum(row['bytes']for row in diagnostic_rust_sources.values())<=4*1024**2,'Bounded diagnostic Rust source bytes')
    write_new(git_log, {'actual_waited_git_calls': evidence, 'decoded_locks': locks})
    write_new(gate_path, {'source_commit': context['execution_source_commit'], 'source_unchanged': True, 'checks': [{'name': 'actual tracked cohort and restored lock recheck before nodes', 'exit_code': 0, 'log': artifact(git_log)}]})
    tool_gate = read_json(root / 'tools/source-gate.json')
    producer_gate_path = root / 'evidence/accepted-tool-source-gate.json'
    write_new(producer_gate_path, {'source_commit': context['runtime_source_commit'], 'source_unchanged': tool_gate['source_before'] == tool_gate['source_after'], 'checks': [{'name': 'actual producer build/tests/lock/input fences accepted by strict tool manifest loader', 'exit_code': 0, 'log': artifact(root / 'tools/source-gate.json')}], 'method': 'Derived from actual unchanged before/after producer maps; original producer receipt is retained unchanged.'})
    build_path = root / 'evidence/accepted-runtime-products.json'
    write_new(build_path, {'source_commit': context['runtime_source_commit'], 'mode': context['mode'], 'passed': True, 'source_unchanged': True, 'runtime_artifacts': artifacts, 'source_identity_scope': 'Actual producer SDK native/runtime receipts and baked CPU product hashes; actual consumer tracked-tree equality and clean working locks. No unrecorded producer pre/post Source fence inferred.', 'producer_receipt': context['producer_receipt'], 'compiled_input_closure': context['compiled_input_closure'], 'native_case_acceptance': False})
    approval = {'schema': 1, 'root_approved': True, 'scenario': scenario, 'runtime_source_commit': context['runtime_source_commit'], 'execution_source_commit': context['execution_source_commit'], 'mode': context['mode'], 'runtime_artifacts': artifacts, 'verifier_tools': tools, 'verifier_python': python, 'case_inputs': case_pin, 'python_modules': {n: artifact(repo / 'zig/integration' / n) for n in verifier.import_module_closure(scenario)}, 'python_dependencies': {'hpack': stage['hpack']}, 'accepted_runtime_build': artifact(build_path), 'harness': harness, 'native_reader_interoperability': interop_pin, 'source_gates': [artifact(producer_gate_path), artifact(gate_path)], 'compiled_input_closure': context['compiled_input_closure'], 'capacity': {'reviewed': True, **request['limits'], 'minimum_free_bytes': request['limits']['minimum_host_free_bytes']}, 'confirm_seconds': 600, 'finality_grace_seconds': 30, 'family_tools': {}, 'evidence_nodes': {}, **({'local_docker':profile['local_docker'],'source_PG14_tag':request['postgres']['image'],'canonical_PG14_image_id':request['postgres']['image_id'],'postgres_run_token':profile['postgres']['run_token']}if scenario!='sealevel-composite'else{}),'node_ownership_tools':profile['node_ownership_tools'], 'reviewed_policy': context['request'], 'local_stage': stage_pin, 'native_case_acceptance': False}
    if scenario=='radix':approval.update(radix_localnet=profile['radix_localnet'],radix_daemon=profile['radix_daemon'],fixture_contracts=profile['fixture_contracts'],family_tools=profile['family_tools'],family_tool_acceptance={'radix_reference':radix_acceptance})
    if fixture: approval['fixture_tools'] = fixture
    if scenario in{'sealevel','sealevel-composite'}:approval['svm_assets']=profile['svm_assets']
    if scenario=='tron':approval.update(tron_tre=profile['tron_tre'],tron_cli=profile['tron_cli'])
    if scenario == 'starknet':approval.update(starknet_devnet=profile['starknet_devnet'],evidence_nodes=profile['evidence_nodes'],expected_starknet_unavailable_endpoints=profile['expected_starknet_unavailable_endpoints'])
    if scenario == 'cosmwasm': approval['expected_unavailable_endpoints'] = profile['expected_unavailable_endpoints']
    write_new(paths['execution-approval'], approval)
    manifest.update(case_inputs=case_pin, execution_approval=artifact(paths['execution-approval']))
    process.validate_manifest(manifest)
    write_new(paths['manifest'], manifest)
    env = {**stage['explicit_environment'], **environment, 'CI': 'true', 'E2E_CI_MODE': 'true', 'E2E_EXTERNAL_AGENT_MANIFEST': str(paths['manifest']), 'HOME': str(root / 'home'), 'TMPDIR': str(root / 'tmp'), **({'DOCKER_HOST':profile['local_docker']['host'],'DOCKER_CONFIG':profile['local_docker']['config_dir']}if scenario!='sealevel-composite'else{}), 'PYTHONNOUSERSITE': '1', 'PYTHONDONTWRITEBYTECODE': '1', 'RUST_BACKTRACE': 'full'}
    env.update({key: row['path'] for key, row in overrides.items()})
    if scenario=='tron':env.update(NPM_CONFIG_USERCONFIG='/dev/null',NPM_CONFIG_GLOBALCONFIG='/dev/null',npm_config_userconfig='/dev/null',npm_config_globalconfig='/dev/null',PNPM_DISABLE_SELF_UPDATE_CHECK='1',NO_UPDATE_NOTIFIER='1')
    argv = [harness['path']]
    if scenario != 'evm': argv += ['--exact', process.SCENARIOS[scenario]['test'], '--nocapture', '--test-threads=1']
    required = list(artifacts.values()) + list(tools.values()) + list(approval['python_modules'].values()) + list(stage['contract_artifacts'].values()) + list(stage['tools'].values())
    required += [context['request'], context['producer_receipt'], context['compiled_input_closure'], interop_pin, stage_pin, stage['hpack'], artifact(gate_path), artifact(producer_gate_path), artifact(build_path), artifact(repo / 'zig/bench/native_case_owner.py'), artifact(repo / 'zig/bench/cold_matrix_owner.py')]
    required += dependency['files'] + [dependency['wheel'], dependency['venv_configuration'], dependency['source_metadata'], python]
    required += list(overrides.values())
    if scenario in{'sealevel','sealevel-composite'}:required += svm_required + [artifact(repo/'zig/bench/native_svm_case.py'),artifact(repo/'zig/bench/native_svm_assets.py')]
    if scenario=='radix':
        required += radix_required + [profile['fixture_contracts']['release_metadata'],*profile['fixture_contracts']['files'].values(),artifact(repo/'zig/bench/native_radix_case.py'),artifact(repo/'zig/bench/native_radix_assets.py'),artifact(repo/'zig/bench/native_radix_custody.py'),artifact(repo/'zig/bench/native_radix_volume.py'),artifact(repo/'zig/bench/native_radix_reference.py'),artifact(repo/'zig/bench/native_starknet_custody.py')]
        required += list(stage['radix_assets']['images'].values())
    required += [check['log'] for check in stage['checks']]
    required += list(diagnostic_rust_sources.values())
    if scenario == 'cosmwasm':
        required += [bundle['archive'], *bundle['files'].values(), artifact(repo / 'zig/bench/native_cw_assets.py')]
    if scenario == 'starknet':
        value=stage['starknet_assets'];bundle=profile['fixture_contracts'];graph=read_json(checked(value['cli_elf']))
        required += [bundle['archive'],bundle['publisher_checksum'],*bundle['files'].values(),value['cli_archive'],value['cli_elf'],value['image_readback'],*([graph['interpreter']] if graph['interpreter'] is not None else []),*graph['files'].values(),artifact(repo/'zig/bench/native_starknet_assets.py'),artifact(repo/'zig/bench/native_starknet_custody.py')]
    if scenario=='tron':
        value=stage['tron_assets'];required += [profile['tron_cli'],value['graph'],value['static_import_audit'],value['image_readback'],value['pnpm_archive'],artifact(repo/'zig/bench/native_tron_assets.py'),artifact(repo/'zig/bench/native_tron_setup.py'),artifact(repo/'zig/bench/native_tron_custody.py'),artifact(repo/'zig/bench/native_tron_cli_audit.mjs'),*copied['immutable_files']]
        required += [{'path':str(Path(copied['workspace']['root'])/name),'bytes':row['bytes'],'sha256':row['sha256']}for name,row in copied['workspace']['entries'].items()if row['kind']=='file']
        required += [r for compiler in value['compiler_outputs'].values()for r in compiler['actual_build_info']]
    required += list(read_json(checked(next(c['log'] for c in stage['checks'] if c['name'] == 'system-libraries'))).values())
    plan = {'schema': 1, 'root_approved': True, 'scenario': scenario, 'manifestArtifact': artifact(paths['manifest']), 'harnessArtifact': harness, 'harness_argv': argv, 'harness_cwd': str(repo / 'rust/main/utils/run-locally'), 'explicit_environment': env, 'required_inputs': required, 'lsofArtifact': stage['tools']['lsof'], **LIMITS, 'confirm_seconds': 600, 'grace_seconds': 30, 'clean_fixture_parent_waits_required': 1 if scenario in{'sealevel-composite','radix'}else 2 if scenario in{'sealevel','tron'}else 3, 'reviewed_policy': context['request'], 'runtime_source_commit': context['runtime_source_commit'], 'execution_source_commit': context['execution_source_commit'], 'native_case_acceptance': False,'diagnostic_rust_sources':diagnostic_rust_sources}
    write_new(paths['launch-plan'], plan)
    return paths


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    first = commands.add_parser('hydrate', help='Verify producer artifacts and copy owned runtime/tool inputs; no approval or nodes')
    first.add_argument('--reviewed-policy', type=Path, required=True)
    first.add_argument('--reviewed-policy-sha256', required=True)
    first.add_argument('--producer-receipt', type=Path, required=True)
    first.add_argument('--producer-receipt-sha256', required=True)
    first.add_argument('--expected-source-commit', required=True)
    first.add_argument('--output', type=Path, required=True)
    interop = commands.add_parser('accept-interop', help='Verify both actual writer/canonical-first/read-only executions; no nodes')
    interop.add_argument('--hydrated-inputs', type=Path, required=True)
    interop.add_argument('--hydrated-inputs-sha256', required=True)
    interop.add_argument('--safe-result', type=Path, required=True)
    interop.add_argument('--safe-result-sha256', required=True)
    interop.add_argument('--fast-result', type=Path, required=True)
    interop.add_argument('--fast-result-sha256', required=True)
    final = commands.add_parser('prepare', help='Compose reviewed case only after actual dual-mode storage interoperability and local setup')
    final.add_argument('--hydrated-inputs', type=Path, required=True)
    final.add_argument('--hydrated-inputs-sha256', required=True)
    final.add_argument('--interoperability', type=Path, required=True)
    final.add_argument('--interoperability-sha256', required=True)
    final.add_argument('--local-stage', type=Path, required=True)
    final.add_argument('--local-stage-sha256', required=True)
    args = parser.parse_args()
    def expected(path, digest):
        value = artifact(path)
        require(value['sha256'] == digest, 'Explicit input SHA mismatch')
        return value
    if args.command == 'hydrate':
        result = hydrate(args.reviewed_policy, args.reviewed_policy_sha256, expected(args.producer_receipt, args.producer_receipt_sha256), args.expected_source_commit, args.output)
        print(json.dumps({'hydrated_inputs': artifact(result), 'nodes_started': False, 'native_case_acceptance': False}))
    elif args.command == 'accept-interop':
        result = accept_interop(args.hydrated_inputs, args.hydrated_inputs_sha256, {'safe': expected(args.safe_result, args.safe_result_sha256), 'fast': expected(args.fast_result, args.fast_result_sha256)})
        print(json.dumps({'interoperability': artifact(result), 'native_case_acceptance': False}))
    else:
        paths = prepare(args.hydrated_inputs, args.hydrated_inputs_sha256, expected(args.interoperability, args.interoperability_sha256), expected(args.local_stage, args.local_stage_sha256))
        print(json.dumps({'outputs': {k: artifact(v) for k, v in paths.items()}, 'nodes_started': False, 'native_case_acceptance': False}))


if __name__ == '__main__':
    main()
