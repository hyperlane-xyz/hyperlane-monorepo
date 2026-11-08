#!/usr/bin/env python3
"""Source-pinned Linux native-case tools. Plan-only unless --execute; no cases.

Reuses the successful native-harness-controls job's owned Cargo target/profile.
No implicit rebuild in admissions: compiled tools are published as hash-pinned
ELF products. Compiling tools is neither storage nor chain/finality acceptance.
"""
import argparse
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
import struct
import subprocess
import sys
import time

_census_spec = importlib.util.spec_from_file_location('functional_allocation_census', Path(__file__).with_name('native_harness_census.py'))
_census_module = importlib.util.module_from_spec(_census_spec)
_census_spec.loader.exec_module(_census_module)
functional_allocated = _census_module.functional_allocated

ROOT = Path(__file__).resolve().parents[2]
GIB = 1024 ** 3
MACHINES = {'x86_64': 62, 'aarch64': 183, 'arm64': 183}
CANONICAL = {
    'zig/reference/rocks/src/main.rs': '854cc91506d8d19811aeae5710ebe0a3f' + '6a2ea1d137c813db71a8af208308a62',
    'zig/reference/rocks/Cargo.toml': 'd56a90e69be7e17f3306cbfd69187c52' + '108a8490784fef3b6617aa7b5d8f1474',
    'zig/reference/rocks/Cargo.lock': 'e05bd62a98071d2ab6f18c917d63561c' + '7e755bcb45f9f9637de8d36e97f09ba0',
}
TOOLS = {
    'init-db': ('rust/main/Cargo.toml', ['--package', 'migration']),
    'ziggy-rocks-oracle': ('zig/reference/rocks/Cargo.toml', []),
    'ziggy-native-rows': ('zig/reference/native-rows/Cargo.toml', []),
    'ziggy-rust-reference': ('zig/reference/Cargo.toml', []),
}
LOCKS = ['rust/main/Cargo.lock', 'zig/reference/rocks/Cargo.lock', 'zig/reference/native-rows/Cargo.lock', 'zig/reference/Cargo.lock']


class ToolInterrupted(RuntimeError):
    pass


def interrupted(sig, frame):
    raise ToolInterrupted('Tool producer received signal ' + str(sig))


def require(value, message):
    if not value:
        raise ValueError(message)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def regular(path):
    require(not path.is_symlink() and path.is_file(), 'Regular nonsymlink file required: ' + str(path))
    return path


def descriptor(path):
    regular(path)
    return {'path': str(path), 'bytes': path.stat().st_size, 'sha256': sha(path)}


def validate_elf(path, expected_machine, *, transport_data_only=False):
    """Parse bounded ELF64; default requires X mode, transport inspection never executes.

    PIE still requires PT_INTERP in both modes. Callers must independently bind
    hashes/provenance before copying a transport payload into executable mode.
    """
    regular(path)
    size = path.stat().st_size
    require(type(transport_data_only) is bool, 'Explicit ELF transport inspection flag required')
    require((transport_data_only or path.stat().st_mode & 0o111) and 64 <= size <= 512 * 1024 ** 2, 'Bounded executable required')
    with path.open('rb') as stream:
        header = stream.read(64)
        require(header[:7] == b'\x7fELF\x02\x01\x01' and header[7] in (0, 3), 'Linux little-endian ELF64 required')
        kind, machine, version = struct.unpack_from('<HHI', header, 16)
        entry, phoff = struct.unpack_from('<QQ', header, 24)
        ehsize, phsize, phcount = struct.unpack_from('<HHH', header, 52)
        require(kind in (2, 3) and machine == expected_machine and version == 1 and entry != 0, 'Wrong executable type/architecture/entry')
        require(ehsize == 64 and phsize == 56 and 1 <= phcount <= 1024 and phoff >= 64 and phoff + phsize * phcount <= size, 'Invalid program headers')
        stream.seek(phoff)
        headers = stream.read(phsize * phcount)
        loads, interpreters = [], []
        for index in range(phcount):
            tag, flags, offset, virtual, physical, file_size, memory_size, alignment = struct.unpack_from('<IIQQQQQQ', headers, index * 56)
            require(offset <= size and file_size <= size - offset, 'Segment outside file')
            if tag == 1:
                require(memory_size >= file_size, 'Invalid load size')
                loads.append((virtual, memory_size, flags))
            if tag == 3:
                require(1 < file_size <= 4096, 'Invalid interpreter size')
                stream.seek(offset)
                interpreter = stream.read(file_size)
                require(interpreter.endswith(b'\0') and b'\0' not in interpreter[:-1], 'Invalid interpreter terminator')
                value = interpreter[:-1].decode('ascii')
                require(value.startswith('/') and '\n' not in value and '..' not in Path(value).parts, 'Invalid interpreter path')
                interpreters.append(value)
    require(loads and any(flags & 1 and address <= entry < address + length for address, length, flags in loads), 'Entrypoint outside executable load')
    require(len(interpreters) <= 1 and (kind == 2 or len(interpreters) == 1), 'PIE must be an actual executable, not SDK shared library')
    return {'class': 64, 'endianness': 'little', 'machine': machine, 'type': kind, 'interpreter': interpreters[0] if interpreters else None}


def canonical_source(repo):
    values = {}
    for name, expected in CANONICAL.items():
        wire = regular(repo / name).read_bytes()
        require(hashlib.sha256(wire).hexdigest() == expected, 'Immutable canonical Source changed: ' + name)
        values[name] = expected
    return values


def verify_locks(repo):
    values = {}
    for name in LOCKS:
        path = regular(repo / name)
        if name.startswith('zig/'):
            wire = gzip.decompress(regular(repo / (name + '.gz')).read_bytes())
            require(path.read_bytes() == wire, 'Standalone raw lock differs from canonical gzip: ' + name)
        values[name] = descriptor(path)
    return values


def source(repo):
    names = subprocess.check_output(['git', 'ls-files', '-z', '--', 'rust/main', 'rust/sealevel', 'zig/reference', 'zig/bench/native_case_tools.py', 'zig/bench/native_case_tools_test.py', 'zig/bench/native_harness_census.py', 'zig/bench/cold_matrix_owner.py', 'zig/integration/native_rows_interop.py'], cwd=repo, timeout=10).decode().split('\0')
    return {n: descriptor(regular(repo / n)) for n in names if n and not n.endswith('Cargo.lock')}


def make_plan(root, repo, git_sha):
    target = root / 'target'
    phases = []
    cargo = ['cargo', '+1.98.0']
    for binary, (manifest, package) in TOOLS.items():
        phases.append({'name': 'build-' + binary, 'tool': binary, 'command': cargo + ['build', '--locked', '--offline', '--manifest-path', str(repo / manifest), *package, '--bin', binary, '--target-dir', str(target), '-j', '2', '--message-format=json-render-diagnostics']})
    for binary in ['ziggy-rocks-oracle', 'ziggy-native-rows']:
        manifest, package = TOOLS[binary]
        phases.append({'name': 'test-' + binary, 'tool': binary, 'command': cargo + ['test', '--locked', '--offline', '--manifest-path', str(repo / manifest), '--bin', binary, '--target-dir', str(target), '-j', '2', '--', '--nocapture']})
    return {'schema': 1, 'compiled_source_commit': git_sha, 'cargo_profile': 'dev, debug=0; same target/flags as successful harness controls; matching fingerprints reused, not guaranteed all dependencies identical', 'target': str(target), 'cwd': str(repo / 'rust/main'), 'phases': phases, 'minimum_free_bytes': 6 * GIB, 'maximum_task_growth_bytes': 30 * GIB, 'native_case_acceptance': False, 'storage_interoperability_acceptance': False, 'timing_acceptance': False}


def run_owned(phase, repo, env, root, output, deadline, owner, source_before, baseline, census=None):
    require(source(repo) == source_before, 'Source changed before tool phase')
    log = output / (phase['name'] + '.log')
    child, cleanup, error = None, None, None
    known, groups = {}, {}
    try:
        with log.open('wb') as stream:
            child = subprocess.Popen(phase['command'], cwd=repo / 'rust/main', env=env, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
            groups[child.pid] = child.pid
            while True:
                current = owner.processes()
                owned = owner.owned_processes(current, child.pid, known, groups, True)
                require(sum(r['rss_bytes'] for r in owned.values()) <= 16 * GIB, 'Tool RSS cap')
                require(shutil.disk_usage(root).free >= 6 * GIB, 'Tool6GiB free floor')
                require(functional_allocated(root, census) - baseline <= 30 * GIB, 'Tool30GiB task growth cap')
                require(log.stat().st_size <= 64 * 1024 ** 2 and time.monotonic() < deadline, 'Tool log/deadline cap')
                if os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None:
                    break
                time.sleep(.2)
    except BaseException as failure:
        error = {'type': type(failure).__name__, 'message': str(failure)}
    finally:
        if child is not None:
            old = {s: signal.signal(s, signal.SIG_IGN) for s in [signal.SIGTERM, signal.SIGINT, signal.SIGHUP]}
            try:
                try:
                    cleanup = owner.stop_owned(child, known, groups)
                except BaseException as failure:
                    cleanup = {'clean': False, 'actual_parent_wait': False, 'error': {'type': type(failure).__name__, 'message': str(failure)}}
                    if error is None:
                        error = cleanup['error']
            finally:
                for sig, value in old.items():
                    signal.signal(sig, value)
    row = {'name': phase['name'], 'pid': None if child is None else child.pid, 'command': phase['command'], 'error': error, 'actual_parent_wait': bool(cleanup and cleanup.get('actual_parent_wait')), 'exit_code': None if child is None else child.returncode, 'cleanup': cleanup, 'log': descriptor(log)}
    try:
        require(error is None and child is not None and child.returncode == 0 and row['actual_parent_wait'] and cleanup['clean'], 'Tool phase/cleanup failed')
        require(not [r for r in cleanup.get('owned_present_before_stop', []) if r['pid'] != child.pid], 'Tool left descendants requiring cleanup')
        require(source(repo) == source_before, 'Source changed during tool phase')
        if phase['name'].startswith('test-'):
            summary = re.search(r'test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored;', log.read_text())
            require(summary and int(summary[1]) >= (3 if phase['tool'] == 'ziggy-rocks-oracle' else 13) and int(summary[2]) == int(summary[3]) == 0, 'Actual tool tests missing/failed/ignored')
            row['actual_tests_passed'] = int(summary[1])
        row['passed'] = True
    except BaseException as failure:
        row['passed'] = False
        if row['error'] is None:
            row['error'] = {'type': type(failure).__name__, 'message': str(failure)}
    return row


def execute(root, repo, git_sha, minutes):
    require(sys.platform == 'linux' and platform.machine() in MACHINES, 'Native Linux producer required')
    require(root.is_relative_to(Path(os.environ['RUNNER_TEMP']).resolve(strict=True)) and not root.is_symlink(), 'Owned runner root required')
    require((root / 'setup-owned').read_text() == git_sha + '\n', 'Setup ownership marker mismatch')
    helper = json.loads((root / 'evidence/result.json').read_text())
    require(helper['passed'] and helper['source_commit'] == git_sha and helper['source_unchanged'] and helper['all_owned_jobs_joined'], 'Actual successful current helper gate required')
    require(subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip() == git_sha, 'Exact checked-out Source required')
    require((root / 'target').is_dir(), 'Reuse actual successful helper target; never silently create another target')
    require(Path(os.environ['CARGO_HOME']).resolve(strict=True) == (root / 'cargo-home').resolve(strict=True), 'Exact isolated staged Cargo home required')
    require(not (root / 'cargo-home/config').exists() and not (root / 'cargo-home/config.toml').exists(), 'Unreviewed Cargo-home config')
    canonical = canonical_source(repo)
    locks = verify_locks(repo)
    before = source(repo)
    plan = make_plan(root, repo, git_sha)
    output = root / 'evidence/native-case-tools'
    output.mkdir(exist_ok=False)
    (output / 'bin').mkdir()
    (output / 'plan.json').write_text(json.dumps(plan, indent=2) + '\n')
    env = {k: os.environ[k] for k in ('PATH', 'CARGO_HOME', 'RUSTUP_HOME') if k in os.environ}
    env.update(HOME=str(root / 'home'), TMPDIR=str(root / 'tmp'), CARGO_TARGET_DIR=str(root / 'target'), CARGO_INCREMENTAL='0', CARGO_PROFILE_DEV_DEBUG='0', CARGO_PROFILE_TEST_DEBUG='0', CARGO_BUILD_JOBS='2', CARGO_TERM_COLOR='never')
    import cold_matrix_owner as owner
    owner.enable_subreaper()
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, interrupted)
    census = {}
    baseline = functional_allocated(root, census)
    deadline = time.monotonic() + minutes * 60
    rows, products, failure = [], {}, None
    try:
        for phase in plan['phases']:
            row = run_owned(phase, repo, env, root, output, deadline, owner, before, baseline, census)
            rows.append(row)
            (output / 'partial.json').write_text(json.dumps(rows, indent=2) + '\n')
            require(row['passed'], 'Tool phase failed; actual receipt retained')
            if phase['name'].startswith('build-'):
                matches = []
                for line in Path(row['log']['path']).read_text().splitlines():
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if event.get('reason') == 'compiler-artifact' and event.get('target', {}).get('name') == phase['tool'] and event.get('executable') and not event.get('profile', {}).get('test'):
                        matches.append(Path(event['executable']))
                require(len(matches) == 1, 'Exactly one actual Cargo-emitted executable required')
                path = matches[0]
                require(path.resolve(strict=True).is_relative_to((root / 'target').resolve(strict=True)) and not path.is_symlink(), 'Product outside owned target')
                elf = validate_elf(path, MACHINES[platform.machine()])
                destination = output / 'bin' / phase['tool']
                shutil.copyfile(path, destination)
                destination.chmod(stat.S_IMODE(path.stat().st_mode))
                require(sha(destination) == sha(path), 'Published executable copy differs')
                linkage = subprocess.run(['readelf', '--dynamic', '--wide', str(destination)], capture_output=True, text=True, timeout=10, check=True)
                require(len(linkage.stdout) <= 256 * 1024 and len(linkage.stderr) <= 32768, 'Bounded ELF linkage output')
                products[phase['tool']] = {'relative_path': 'bin/' + phase['tool'], 'bytes': destination.stat().st_size, 'sha256': sha(destination), 'elf': elf, 'producer': descriptor(path), 'needed_libraries': re.findall(r'\(NEEDED\).*?\[(.*?)\]', linkage.stdout)}
        require(source(repo) == before and verify_locks(repo) == locks and canonical_source(repo) == canonical, 'Final Source/lock fence failed')
        require(set(products) == set(TOOLS), 'Four exact tools required')
    except BaseException as error:
        failure = {'type': type(error).__name__, 'message': str(error)}
    gate = {'schema': 1, 'passed': failure is None, 'source_commit': git_sha, 'source_before': before, 'source_after': source(repo), 'canonical_compatibility_source': canonical, 'locks': locks, 'checks': rows, 'error': failure, 'actual_all_parent_waits': all(r['actual_parent_wait'] for r in rows), 'functional_allocation_census': census, 'native_chain_acceptance': False, 'storage_interoperability_acceptance': False, 'elapsed600_acceptance': False, 'timing_acceptance': False}
    gate_path = output / 'source-gate.json'
    gate_path.write_text(json.dumps(gate, indent=2) + '\n')
    if failure is not None:
        raise SystemExit(1)
    manifest = {'schema': 1, 'kind': 'source-built-linux-native-case-tools', 'source_commit': git_sha, 'platform': {'os': 'linux', 'architecture': platform.machine(), 'elf_machine': MACHINES[platform.machine()], 'byte_order': 'little', 'libc': dict(zip(('name', 'version'), platform.libc_ver()))}, 'profile': plan['cargo_profile'], 'tools': products, 'source_gate': {'relative_path': 'source-gate.json', 'bytes': gate_path.stat().st_size, 'sha256': sha(gate_path)}, 'canonical_compatibility_source': canonical, 'native_chain_acceptance': False, 'storage_interoperability_acceptance': False, 'elapsed600_acceptance': False, 'timing_acceptance': False}
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')



def load_manifest(path, expected_sha256, expected_commit, expected_machine):
    """Admission reads pinned products only; never fetches/builds/normalizes tools."""
    require(re.fullmatch('[0-9a-f]{64}', expected_sha256) and sha(regular(path)) == expected_sha256, 'Tool manifest digest mismatch')
    require(re.fullmatch('[0-9a-f]{40}', expected_commit), 'Exact tool producer Source required')
    manifest = json.loads(path.read_text())
    require(manifest['schema'] == 1 and manifest['kind'] == 'source-built-linux-native-case-tools' and manifest['source_commit'] == expected_commit, 'Tool manifest identity mismatch')
    plat = manifest['platform']
    require(plat['os'] == 'linux' and plat['elf_machine'] == expected_machine and MACHINES.get(plat['architecture']) == expected_machine and plat['byte_order'] == 'little', 'Wrong tool platform')
    require(all(manifest[k] is False for k in ['native_chain_acceptance', 'storage_interoperability_acceptance', 'elapsed600_acceptance', 'timing_acceptance']), 'Tool compile cannot grant native acceptance')
    require(manifest['canonical_compatibility_source'] == CANONICAL and set(manifest['tools']) == set(TOOLS), 'Immutable canonical Source/exact tool set mismatch')
    base = path.parent.resolve(strict=True)
    gate_pin = manifest['source_gate']
    require(gate_pin['relative_path'] == 'source-gate.json', 'Invalid source gate path')
    gate_path = regular(base / 'source-gate.json')
    require(gate_path.stat().st_size == gate_pin['bytes'] and sha(gate_path) == gate_pin['sha256'], 'Source gate digest mismatch')
    gate = json.loads(gate_path.read_text())
    require(gate['passed'] is True and gate['source_commit'] == expected_commit and gate['source_before'] == gate['source_after'] and gate['actual_all_parent_waits'] is True, 'Actual immutable tool producer gate required')
    require(gate['canonical_compatibility_source'] == CANONICAL, 'Canonical tool Source gate differs')
    required_sources = ['zig/reference/src/main.rs', 'zig/reference/Cargo.toml', 'zig/reference/native-rows/src/main.rs', 'zig/reference/native-rows/Cargo.toml', 'rust/main/hyperlane-core/src/lib.rs', 'rust/main/agents/scraper/migration/bin/init_db.rs', 'zig/bench/native_case_tools.py']
    require(all(name in gate['source_before'] for name in required_sources), 'Actual production/reference Source coverage incomplete')
    require(set(gate['locks']) == set(LOCKS), 'Locked producer closure incomplete')
    for logical, expected in CANONICAL.items():
        if logical.endswith('Cargo.lock'):
            require(gate['locks'][logical]['sha256'] == expected, 'Canonical producer lock differs')
        else:
            require(gate['source_before'][logical]['sha256'] == expected, 'Canonical compiled Source differs')
    expected_phases = ['build-' + name for name in TOOLS] + ['test-ziggy-rocks-oracle', 'test-ziggy-native-rows']
    require([r['name'] for r in gate['checks']] == expected_phases, 'Incomplete tool build/test phases')
    for row in gate['checks']:
        require(row['passed'] is True and row['actual_parent_wait'] is True and row['exit_code'] == 0 and row['error'] is None and row['cleanup']['clean'], 'Tool phase/wait/cleanup unsuccessful')
        require(not [v for v in row['cleanup'].get('owned_present_before_stop', []) if v['pid'] != row['pid']], 'Tool phase required residual-work cleanup')
        if row['name'].startswith('test-'):
            require(row['actual_tests_passed'] >= (3 if row['name'].endswith('oracle') else 13), 'Actual tool unit tests absent')
    products = {}
    for name, item in manifest['tools'].items():
        require(item['relative_path'] == 'bin/' + name and not (base / 'bin').is_symlink(), 'Tool output path mismatch/link')
        product = regular(base / item['relative_path'])
        require(product.stat().st_size == item['bytes'] and sha(product) == item['sha256'], 'Published tool bytes mismatch')
        require(validate_elf(product, expected_machine) == item['elf'], 'Published ELF descriptor mismatch')
        require(item['producer']['bytes'] == item['bytes'] and item['producer']['sha256'] == item['sha256'], 'Actual Cargo product/copy differs')
        products[name] = descriptor(product)
    return products


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--git-sha', required=True)
    parser.add_argument('--minutes', type=int, default=60)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    require(re.fullmatch('[0-9a-f]{40}', args.git_sha) and 1 <= args.minutes <= 120, 'Invalid exact Source/deadline')
    root = args.root.resolve(strict=True)
    if args.execute:
        execute(root, ROOT, args.git_sha, args.minutes)
    else:
        print(json.dumps(make_plan(root, ROOT, args.git_sha), indent=2))


if __name__ == '__main__':
    main()
