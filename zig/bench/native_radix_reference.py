#!/usr/bin/env python3
"""Optional independent Radix verifier producer. No cases or implicit downloads.

Stage-only fetches exact Cargo.lock dependencies into the existing isolated
helper Cargo home. Execute is offline and runs only SDK unit tests/build/clippy.
The canonical checkout and its decoded-lock existence are never modified.
"""
import argparse
import contextlib
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import stat
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
REFERENCE = 'zig/src/radix/reference'
BIN = 'ziggy-radix-reference'
SCOPES = [REFERENCE, 'zig/bench/native_radix_reference.py', 'zig/bench/native_radix_reference_test.py',
          'zig/bench/native_case_tools.py', 'zig/bench/native_harness_census.py', 'zig/bench/cold_matrix_owner.py',
          'zig/bench/native_harness_controls.py', '.github/workflows/zig-agents.yml']
TESTS = ['actual_sdk_notarized_authority_hashes_and_process_fields', 'sdk_signature_truncation_trailing_and_foreign_effects_reject',
         'typed_outputs_use_real_sdk_decode_canonical_reencode', 'byte_argument_is_sdk_vec_encoding_and_validators_are_full_width',
         'input_bounds_duplicate_keys_and_unknown_schema_fail_closed']
CHECKS = ['rustc', 'cargo', 'test', 'build', 'clippy', 'linkage']
GIB = 1024 ** 3


def require(value, message):
    if not value:
        raise ValueError(message)


def regular(path):
    require(not path.is_symlink() and path.is_file(), 'Regular nonsymlink input required: ' + str(path))
    return path


def pin(path):
    regular(path)
    return {'path': str(path), 'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}


def json_read(path):
    require(regular(path).stat().st_size <= 16 * 1024 ** 2, 'Bounded JSON required')
    def pairs(rows):
        result = {}
        for key, value in rows:
            require(key not in result, 'Duplicate JSON key')
            result[key] = value
        return result
    return json.loads(path.read_text(), object_pairs_hook=pairs)


def sibling(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def source(repo):
    subprocess.run(['git', 'diff', '--exit-code', 'HEAD', '--', *SCOPES], cwd=repo, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=10)
    names = subprocess.check_output(['git', 'ls-files', '-z', '--', *SCOPES], cwd=repo, timeout=10).decode().split('\0')
    require(all(n in names for n in SCOPES[1:]), 'Producer/control dependencies must be tracked')
    names = [n for n in names if n and n != REFERENCE + '/Cargo.lock']
    require(all(REFERENCE + '/' + n in names for n in ['Cargo.toml', 'Cargo.lock.gz', 'src/main.rs']), 'Tracked reference Source incomplete')
    return {name: pin(repo / name) for name in sorted(names)}


def checkout_lock(repo):
    packed = regular(repo / REFERENCE / 'Cargo.lock.gz')
    require(packed.stat().st_size <= 1024 ** 2, 'Packed reference lock bound')
    wire = gzip.decompress(packed.read_bytes())
    require(0 < len(wire) <= 4 * 1024 ** 2, 'Decoded reference lock bound')
    raw = repo / REFERENCE / 'Cargo.lock'
    previous = pin(raw) if raw.exists() or raw.is_symlink() else None
    require(previous is None or raw.read_bytes() == wire, 'Existing decoded lock differs from canonical gzip')
    return wire, {'packed': pin(packed), 'decoded_sha256': hashlib.sha256(wire).hexdigest(), 'original_decoded': previous}


@contextlib.contextmanager
def working_source(repo, destination):
    """Restore an owned working lock, then its original absence on every exit."""
    wire, original = checkout_lock(repo)
    before = source(repo)
    destination.mkdir(exist_ok=False)
    for name in before:
        if name.startswith(REFERENCE + '/'):
            target = destination / Path(name).relative_to(REFERENCE)
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open('xb') as stream:
                stream.write((repo / name).read_bytes())
    lock = destination / 'Cargo.lock'
    require(not lock.exists(), 'Owned decoded lock must begin absent')
    with lock.open('xb') as stream:
        stream.write(wire)
    lock.chmod(0o600)
    try:
        yield before, original, pin(lock)
    finally:
        # No recursive cleanup or canonical lock write. Keep owned Source/logs.
        require(lock.is_file() and not lock.is_symlink() and lock.read_bytes() == wire, 'Owned working lock changed')
        lock.unlink()
        require(source(repo) == before and checkout_lock(repo)[1] == original, 'Canonical Source/lock/absence changed')


def cpu_info(path=Path('/proc/cpuinfo')):
    data = regular(path).read_bytes()
    require(len(data) <= 4 * 1024 ** 2, 'CPU metadata bound')
    rows = []
    for block in data.decode().split('\n\n'):
        fields = dict(line.split(':', 1) for line in block.splitlines() if ':' in line)
        fields = {k.strip(): v.strip() for k, v in fields.items()}
        value = fields.get('flags', fields.get('Features'))
        if value:
            rows.append(set(value.split()))
    require(rows, 'Actual producer CPU flags missing')
    return {'cpuinfo': pin(path), 'processor_rows': len(rows), 'required_flags': sorted(set.intersection(*rows))}


def phases(root, owned, stage):
    base = ['cargo', '+1.98.0']
    manifest = str(owned / 'Cargo.toml')
    if stage:
        return [('fetch', base + ['fetch', '--locked', '--manifest-path', manifest])]
    common = ['--locked', '--offline', '--manifest-path', manifest, '--bin', BIN, '--target-dir', str(root / 'target'), '-j', '2']
    return [('rustc', ['rustc', '+1.98.0', '-vV']), ('cargo', base + ['-V']),
            ('test', base + ['test', *common, '--', '--nocapture']),
            ('build', base + ['build', *common, '--message-format=json-render-diagnostics']),
            ('clippy', base + ['clippy', '--no-deps', *common, '--tests', '--', '-D', 'warnings'])]


def command(name, argv, env, root, output, deadline, before, repo, owner, census, baseline):
    child, cleanup, error, known, groups = None, None, None, {}, {}
    log = output / (name + '.log')
    peak_rss, peak_growth, minimum_free = 0, 0, None
    try:
        require(source(repo) == before, 'Source changed before command')
        with log.open('xb') as stream:
            child = subprocess.Popen(argv, cwd=output.parent / 'source', env=env, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
            groups[child.pid] = child.pid
            while True:
                owned = owner.owned_processes(owner.processes(), child.pid, known, groups, True)
                peak_rss = max(peak_rss, sum(r['rss_bytes'] for r in owned.values()))
                free = shutil.disk_usage(root).free
                minimum_free = free if minimum_free is None else min(minimum_free, free)
                peak_growth = max(peak_growth, census(root) - baseline)
                require(peak_rss <= 16 * GIB, '16GiB producer RSS cap')
                require(free >= 6 * GIB, '6GiB producer free floor')
                require(peak_growth <= 30 * GIB, '30GiB producer growth cap')
                require(log.stat().st_size <= 64 * 1024 ** 2 and time.monotonic() < deadline, 'Original producer deadline/log bound')
                if os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None:
                    break
                time.sleep(.2)
    except BaseException as failure:
        error = {'type': type(failure).__name__, 'message': str(failure)}
    finally:
        if child is not None:
            previous = {sig: signal.signal(sig, signal.SIG_IGN) for sig in [signal.SIGINT, signal.SIGTERM, signal.SIGHUP]}
            try:
                try:
                    cleanup = owner.stop_owned(child, known, groups)
                except BaseException as failure:
                    cleanup = {'clean': False, 'actual_parent_wait': False, 'error': {'type': type(failure).__name__, 'message': str(failure)}}
                    if error is None:
                        error = cleanup['error']
            finally:
                for sig, handler in previous.items():
                    signal.signal(sig, handler)
    row = {'name': name, 'argv': argv, 'pid': None if child is None else child.pid, 'exit_code': None if child is None else child.returncode,
           'actual_parent_wait': bool(cleanup and cleanup.get('actual_parent_wait')), 'cleanup': cleanup, 'error': error, 'log': pin(log),
           'peak_tree_RSS_bytes': peak_rss, 'peak_task_growth_bytes': peak_growth, 'minimum_observed_free_bytes': minimum_free}
    row['passed'] = bool(error is None and cleanup and cleanup.get('clean') and row['actual_parent_wait'] and child.returncode == 0
                         and not [r for r in cleanup.get('owned_present_before_stop', []) if r['pid'] != child.pid])
    return row


def test_summary(text):
    match = re.search(r'test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored;', text)
    require(match and tuple(map(int, match.groups())) == (5, 0, 0), 'Exactly five real SDK reference controls required')
    require(all('test evidence_tests::' + name + ' ... ok' in text for name in TESTS), 'Named SDK reference controls missing')
    return TESTS


def cargo_product(log, target):
    found = []
    for line in log.read_text().splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get('reason') == 'compiler-artifact' and event.get('target', {}).get('name') == BIN and event.get('executable') and not event.get('profile', {}).get('test'):
            found.append(Path(event['executable']))
    require(len(found) == 1, 'Exactly one actual Cargo-emitted Radix executable required')
    product = regular(found[0])
    require(product.resolve(strict=True).is_relative_to(target.resolve(strict=True)), 'Cargo product outside owned target')
    return product


def execute(repo, root, commit, stage, minutes):
    require(sys.platform == 'linux' and platform.machine() in ('x86_64', 'aarch64', 'arm64'), 'Native Linux producer required')
    require(re.fullmatch('[0-9a-f]{40}', commit), 'Exact Source commit required')
    require(root.is_relative_to(Path(os.environ['RUNNER_TEMP']).resolve(strict=True)) and not root.is_symlink(), 'Exact owned runner root required')
    require((root / 'setup-owned').read_text() == commit + '\n', 'Helper setup ownership marker differs')
    require(subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True, timeout=10).strip() == commit, 'Exact producer checkout required')
    require(Path(os.environ['CARGO_HOME']).resolve(strict=True) == (root / 'cargo-home').resolve(strict=True), 'Isolated staged Cargo home required')
    require(not (root / 'cargo-home/config').exists() and not (root / 'cargo-home/config.toml').exists(), 'Unexpected Cargo config')
    if not stage:
        helper = json_read(root / 'evidence/result.json')
        require(helper['passed'] and helper['source_commit'] == commit and helper['source_unchanged'] and helper['all_owned_jobs_joined'], 'Actual same-head helper checks required')
        require((root / 'target').is_dir(), 'Existing helper target required')
        previous = json_read(root / 'evidence/radix-reference-stage/source-gate.json')
        require(previous['passed'] and previous['source_commit'] == commit and previous['all_owned_jobs_joined'], 'Successful same-head locked dependency stage required')
    owner = sibling('cold_matrix_owner')
    tools = sibling('native_case_tools')
    owner.enable_subreaper()
    def interrupted(sig, frame):
        raise owner.TaskInterrupted('Radix producer received signal ' + str(sig))
    for sig in [signal.SIGINT, signal.SIGTERM, signal.SIGHUP]:
        signal.signal(sig, interrupted)
    census_module = sibling('native_harness_census')
    allocations = {}
    census = lambda path: census_module.functional_allocated(path, allocations)
    baseline = census(root) if stage else previous['allocation_baseline_bytes']
    require(type(baseline) is int and 0 <= baseline <= census(root), 'Original stage allocation anchor required')
    require(shutil.disk_usage(root).free >= (40 if stage else 6) * GIB, 'Producer free floor before stage/build')
    area = root / ('radix-reference-stage' if stage else 'radix-reference-build')
    area.mkdir(exist_ok=False)
    output = area / 'output'
    output.mkdir()
    evidence = root / 'evidence' / ('radix-reference-stage' if stage else 'native-radix-reference')
    evidence.mkdir(exist_ok=False)
    (evidence / 'bin').mkdir()
    rows, failure, before, lock_record, product, cpu = [], None, {}, None, None, cpu_info()
    cpu_path = evidence / 'producer-cpuinfo.txt'
    shutil.copyfile(Path('/proc/cpuinfo'), cpu_path)
    cpu['cpuinfo'] = {'relative_path': cpu_path.name, **{k: v for k, v in pin(cpu_path).items() if k != 'path'}}
    env = {k: os.environ[k] for k in ['PATH', 'CARGO_HOME', 'RUSTUP_HOME'] if k in os.environ}
    env.update(HOME=str(root / 'home'), TMPDIR=str(root / 'tmp'), CARGO_TARGET_DIR=str(root / 'target'), CARGO_INCREMENTAL='0', CARGO_PROFILE_DEV_DEBUG='0', CARGO_PROFILE_TEST_DEBUG='0', CARGO_BUILD_JOBS='2', CARGO_TERM_COLOR='never')
    if not stage:
        env['CARGO_NET_OFFLINE'] = 'true'
    deadline = time.monotonic() + minutes * 60
    try:
        with working_source(repo, area / 'source') as (before, canonical_lock, working_lock):
            lock_record = {'canonical': canonical_lock, 'working_lock': working_lock, 'working_lock_restored_to_original_absence': False}
            for name, argv in phases(root, area / 'source', stage):
                row = command(name, argv, env, root, output, deadline, before, repo, owner, census, baseline)
                rows.append(row)
                (evidence / 'partial.json').write_text(json.dumps(rows, indent=2) + '\n')
                require(row['passed'], 'Radix prerequisite command failed; retained actual receipt')
                if name == 'test':
                    row['required_tests_observed'] = test_summary(Path(row['log']['path']).read_text())
                if name == 'build':
                    actual = cargo_product(Path(row['log']['path']), root / 'target')
                    elf = tools.validate_elf(actual, tools.MACHINES[platform.machine()])
                    destination = evidence / 'bin' / BIN
                    shutil.copyfile(actual, destination)
                    destination.chmod(stat.S_IMODE(actual.stat().st_mode))
                    require(pin(destination)['sha256'] == pin(actual)['sha256'], 'Published Radix copy changed')
                    product = {'relative_path': 'bin/' + BIN, 'bytes': destination.stat().st_size, 'sha256': pin(destination)['sha256'], 'elf': elf, 'producer': pin(actual)}
            if not stage:
                row = command('linkage', ['readelf', '--dynamic', '--wide', str(evidence / 'bin' / BIN)], env, root, output, deadline, before, repo, owner, census, baseline)
                rows.append(row)
                require(row['passed'], 'Actual ELF linkage read failed')
                product['needed_libraries'] = re.findall(r'\(NEEDED\).*?\[(.*?)\]', Path(row['log']['path']).read_text())
        lock_record['working_lock_restored_to_original_absence'] = not (area / 'source/Cargo.lock').exists()
        require(census(root) - baseline <= 30 * GIB and shutil.disk_usage(root).free >= 6 * GIB and time.monotonic() < deadline, 'Final publication bounds')
    except BaseException as error:
        failure = {'type': type(error).__name__, 'message': str(error)}
        if lock_record is not None:
            lock_record['working_lock_restored_to_original_absence'] = not (area / 'source/Cargo.lock').exists()
    # Logs are immutable artifact members, independent from runner-root paths.
    for row in rows:
        log = Path(row['log']['path'])
        shutil.copyfile(log, evidence / log.name)
        row['log'] = {'relative_path': log.name, **{k: v for k, v in pin(evidence / log.name).items() if k != 'path'}}
    try:
        after = source(repo)
    except BaseException as error:
        after = None
        if failure is None:
            failure = {'type': type(error).__name__, 'message': str(error)}
    try:
        require(after == before and census(root) - baseline <= 30 * GIB and shutil.disk_usage(root).free >= 6 * GIB and time.monotonic() < deadline, 'Final Source/publication deadline/disk bound')
    except BaseException as error:
        if failure is None:
            failure = {'type': type(error).__name__, 'message': str(error)}
    gate = {'schema': 1, 'passed': failure is None, 'source_commit': commit, 'source_before': before, 'source_after': after, 'source_scopes': SCOPES, 'locks': lock_record,
            'checks': rows, 'all_owned_jobs_joined': bool(rows) and all(r['actual_parent_wait'] and r['cleanup']['clean'] for r in rows), 'error': failure,
            'cpu': cpu, 'allocation_baseline_bytes': baseline, 'allocation_scope': 'Same owned helper root from optional dependency stage through final reference publication; no per-phase baseline renewal', 'functional_allocation_census': allocations, 'native_case_acceptance': False, 'timing_acceptance': False}
    gate_path = evidence / 'source-gate.json'
    gate_path.write_text(json.dumps(gate, indent=2) + '\n')
    require(failure is None, 'Radix producer failed; source-gate retained')
    if not stage:
        require(product is not None and [r['name'] for r in rows] == CHECKS, 'All actual reference checks required')
        manifest = {'schema': 1, 'kind': 'source-built-linux-radix-reference', 'source_commit': commit,
                    'platform': {'os': 'linux', 'architecture': platform.machine(), 'elf_machine': tools.MACHINES[platform.machine()], 'byte_order': 'little', 'libc': platform.libc_ver()},
                    'profile': 'dev debug=0; locked offline j2; no inherited RUSTFLAGS; no timing claim', 'tool': product,
                    'source_gate': {'relative_path': gate_path.name, **{k: v for k, v in pin(gate_path).items() if k != 'path'}},
                    'native_case_acceptance': False, 'accepted_reference_component': False, 'timing_acceptance': False}
        (evidence / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')


def member(base, row, relative):
    require(row['relative_path'] == relative, 'Artifact member path differs')
    path = base
    for part in Path(relative).parts:
        require(part not in ('', '.', '..') and not Path(relative).is_absolute(), 'Unsafe artifact member')
        path = path / part
        require(not path.is_symlink(), 'Artifact member/parent symlink')
    actual = pin(path)
    require(actual['bytes'] == row['bytes'] and actual['sha256'] == row['sha256'], 'Artifact member bytes differ')
    return path


def load_manifest(path, expected_sha256, expected_commit, expected_machine, consumer_flags):
    require(pin(path)['sha256'] == expected_sha256 and re.fullmatch('[0-9a-f]{40}', expected_commit), 'Exact artifact digest/Source required')
    manifest = json_read(path)
    require(manifest['schema'] == 1 and manifest['kind'] == 'source-built-linux-radix-reference' and manifest['source_commit'] == expected_commit, 'Reference identity differs')
    require(manifest['native_case_acceptance'] is False and manifest['accepted_reference_component'] is False and manifest['timing_acceptance'] is False, 'Producer is not Root/native acceptance')
    tools = sibling('native_case_tools')
    plat = manifest['platform']
    require(plat['os'] == 'linux' and plat['byte_order'] == 'little' and plat['elf_machine'] == expected_machine and tools.MACHINES.get(plat['architecture']) == expected_machine, 'Wrong Linux platform')
    base = path.parent.resolve(strict=True)
    gate = json_read(member(base, manifest['source_gate'], 'source-gate.json'))
    require(gate['passed'] is True and gate['source_commit'] == expected_commit and gate['source_before'] == gate['source_after'] and gate['all_owned_jobs_joined'] is True, 'Reference Source/check gate failed')
    require(gate['source_scopes'] == SCOPES, 'Exact independent producer Source scopes required')
    require(gate['locks']['working_lock_restored_to_original_absence'] is True, 'Owned decoded lock not restored')
    require(gate['locks']['canonical']['packed'] == gate['source_before'][REFERENCE + '/Cargo.lock.gz'], 'Canonical lock Source differs')
    require(all(n in gate['source_before'] for n in SCOPES[1:]) and all(REFERENCE + '/' + n in gate['source_before'] for n in ['Cargo.toml', 'Cargo.lock.gz', 'src/main.rs']), 'Reference Source coverage missing')
    require([r['name'] for r in gate['checks']] == CHECKS, 'Exact build/test/clippy/toolchain checks required')
    for row in gate['checks']:
        require(row['passed'] is True and row['exit_code'] == 0 and row['error'] is None and row['actual_parent_wait'] is True and row['cleanup']['clean'], 'Actual command/wait/cleanup failed')
        require(not [r for r in row['cleanup'].get('owned_present_before_stop', []) if r['pid'] != row['pid']], 'Producer left descendants')
        log = member(base, row['log'], row['name'] + '.log')
        if row['name'] == 'test':
            require(row['required_tests_observed'] == TESTS and test_summary(log.read_text()) == TESTS, 'Actual SDK tests differ')
    cpu_path = member(base, gate['cpu']['cpuinfo'], 'producer-cpuinfo.txt')
    observed_cpu = cpu_info(cpu_path)
    require(observed_cpu['required_flags'] == gate['cpu']['required_flags'] and observed_cpu['processor_rows'] == gate['cpu']['processor_rows'], 'CPU flags differ from actual recorded processor metadata')
    require(gate['cpu']['required_flags'] and set(gate['cpu']['required_flags']) <= set(consumer_flags), 'Consumer CPU is not producer superset')
    product = manifest['tool']
    actual = member(base, product, 'bin/' + BIN)
    require(tools.validate_elf(actual, expected_machine) == product['elf'], 'Actual reference ELF differs')
    require(product['producer']['sha256'] == product['sha256'] and product['producer']['bytes'] == product['bytes'], 'Cargo product/copy differs')
    return pin(actual)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--git-sha', required=True)
    parser.add_argument('--minutes', type=int, default=60)
    parser.add_argument('--stage-only', action='store_true')
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    require(1 <= args.minutes <= 90 and not (args.execute and args.stage_only), 'Bounded explicit mode required')
    require(re.fullmatch('[0-9a-f]{40}', args.git_sha), 'Exact Source commit required')
    root = args.root.resolve(strict=True)
    if args.execute or args.stage_only:
        execute(ROOT, root, args.git_sha, args.stage_only, args.minutes)
    else:
        print(json.dumps({'schema': 1, 'source_commit': args.git_sha, 'stage': phases(root, root / 'radix-reference-stage/source', True),
                          'offline': phases(root, root / 'radix-reference-build/source', False), 'native_case_acceptance': False}, indent=2))


if __name__ == '__main__':
    main()
