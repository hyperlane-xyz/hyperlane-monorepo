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

_CPU_SPEC = importlib.util.spec_from_file_location("producer_cpu", Path(__file__).resolve().parents[1] / "tools/build_cpu.py")
cpu = importlib.util.module_from_spec(_CPU_SPEC)
_CPU_SPEC.loader.exec_module(cpu)

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
    names = subprocess.check_output(['git', 'ls-files', '-z', '--', 'rust/main', 'rust/sealevel', 'zig/reference', 'zig/bench/native_case_tools.py', 'zig/bench/native_case_tools_test.py', 'zig/tools/build_cpu.py', 'zig/bench/native_harness_census.py', 'zig/bench/cold_matrix_owner.py', 'zig/integration/native_rows_interop.py'], cwd=repo, timeout=10).decode().split('\0')
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
    recipe = cpu.recipe('rust',phase['command'],env,Path(__file__),repo=ROOT)
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
        row['cpu_recipe'] = cpu.finish_recipe(recipe,row,repo=ROOT)
        row['passed'] = True
    except BaseException as failure:
        row['passed'] = False
        if row['error'] is None:
            row['error'] = {'type': type(failure).__name__, 'message': str(failure)}
    return row


def execute(root, repo, git_sha, minutes):
    require(sys.platform == 'linux' and platform.machine() == 'x86_64', 'Portable Linux x86_64 producer required')
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
    env=cpu.portable_environment(env,tokio_unstable=True)
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
    manifest['cpu_contract']=cpu.make_record('tools','shared',git_sha,'amd64',cpu.cpu_flags(Path('/proc/cpuinfo').read_text()),{name:{k:row[k]for k in ['bytes','sha256']}for name,row in products.items()},[row['cpu_recipe']for row in rows])
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')



def validate_cpu_contract(row, scope, mode, producer, artifacts):
    spec = importlib.util.spec_from_file_location('producer_cpu_admission', ROOT / 'zig/integration/native_case_inputs.py')
    admission = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(admission)
    return admission.validate_cpu_contract(row, scope, mode, producer, artifacts, repo=ROOT)


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
    if 'cpu_contract' in manifest:
        validate_cpu_contract(manifest['cpu_contract'],'tools','shared',expected_commit,{name:{k:manifest['tools'][name][k]for k in ['bytes','sha256']}for name in TOOLS})
    return products


# Separately bounded, post-case verification. Never changes the main case verdict.
EVM_CONTROL_PRODUCER = 'c83dff3d2047299cafaddd740a9a9444c2636ce6'
EVM_CONTROL_DEP = {'run_id': 42827307915, 'attempt': 1, 'job_id': 129867879513, 'artifact_id': 13771616045, 'bytes': 54158690, 'sha256': '6b173f61d4cbc24eeaeef7362cf018be'+'2f9c6511783b7d9f41161e3433d25e68'}
EVM_CONTROL_DEP_MEMBERS = {
    'bench/results/native-linux/deps/libbz2.a': {'bytes': 99164, 'sha256': 'b7f015e8e160ac2dfc1a4413771b3bf1'+'f0acdd200e6245a50e0ac3bb55ad11a8', 'crc32': 1489836117},
    'bench/results/native-linux/deps/liblz4.a': {'bytes': 302550, 'sha256': '75eaf72d208bea02ed5e92c662844bd3'+'88e5cb518b8653fff7f203cebb58080e', 'crc32': 1889339944},
    'bench/results/native-linux/deps/librocksdb.a': {'bytes': 40944322, 'sha256': '2a6e409c8286d22f450529f5f11e3d51'+'a8e9a753634c6c401f110fdce8e8438e', 'crc32': 2378478871},
    'bench/results/native-linux/deps/libsnappy.a': {'bytes': 90074, 'sha256': 'd683584d0edeb635e3b5674d7a1ebd1b'+'25b5b935d5acc1342e2f78105ead36ce', 'crc32': 2399089470},
    'bench/results/native-linux/deps/libz.a': {'bytes': 132194, 'sha256': '4b7d62fe404f4f4a06f2bb5a860d4e77'+'86a4056f42fda6989b8c21d6814e65a4', 'crc32': 1160046960},
    'bench/results/native-linux/deps/libziggy_rocks_abi.a': {'bytes': 3998, 'sha256': 'f719c8c4ca28245c74e6b33159ea4f6e'+'bc4967fb44c628a0d89a1cd746bf6202', 'crc32': 2337018755},
    'bench/results/native-linux/deps/libzstd.a': {'bytes': 1564248, 'sha256': 'c4745efa7d2ad163de0291ebd40c0cba'+'4ecbe7c410ac73fc1799edeae0f2819d', 'crc32': 1942127412},
    'bench/results/native-linux/deps/manifest.json': {'bytes': 53493, 'sha256': '5f56f0c4f841f45c5620e63b9d60b507'+'8a8fa0501d1867355a05d9db0505a7df', 'crc32': 475727500},
}
EVM_CONTROL_ARCHIVES = {'libziggy_rocks_abi.a','librocksdb.a','libsnappy.a','liblz4.a','libzstd.a','libz.a','libbz2.a'}
EVM_CONTROL_TESTS = ('local Anvil Multicall3 returns positional allowFailure results','opt-in loopback prepares actual repo Solidity without delivery or nonce mutation','consumer portable transaction-ID crash window repairs reopened dispatch and actual Source Rust decoder agrees')
EVM_CONTROL_CONTRACTS = {'Mailbox':'contracts/Mailbox.sol','MerkleTreeHook':'contracts/hooks/MerkleTreeHook.sol','TestPostDispatchHook':'contracts/test/TestPostDispatchHook.sol','TestIsm':'contracts/test/TestIsm.sol','TestRecipient':'contracts/test/TestRecipient.sol'}
EVM_CONTROL_LIMITS = {'wall_seconds':600,'cleanup_seconds':30,'RSS_bytes':8*GIB,'allocated_bytes':4*GIB,'minimum_free_bytes':6*GIB,'phase_log_bytes':64*1024**2,'expanded_ZIP_bytes':1024**3,'public_bytes':32768}
EVM_PREPARE_ENTRY = 'test { _ = @import("evm_prepare_delegated_tests.zig"); _ = @import("lander/anvil_tests.zig"); }\n'


def evm_control_admission(context, case, stage):
    require(context.get('scenario')=='evm' and context.get('mode') in {'ReleaseSafe','ReleaseFast'},'EVM mode only')
    require(context.get('runtime_source_commit')==EVM_CONTROL_PRODUCER and re.fullmatch('[0-9a-f]{40}',context.get('execution_source_commit','')),'Exact NEXT runtime/current execution required')
    require(context.get('phase')=='HYDRATED_NOT_EXECUTION_APPROVAL' and context.get('nodes_started') is False and context.get('native_case_acceptance') is False,'Original hydrated context required')
    require(case.get('kind')=='owned-linux-native-case-result' and case.get('passed') is True and case.get('native_case_acceptance') is True and case.get('accepted_inputs_unchanged_after') is True,'Successful completed main case required')
    require(all(case.get(k)==context[k] for k in ['runtime_source_commit','execution_source_commit','scenario','mode']),'Main case/context identity differs')
    require(stage.get('passed') is True and type(stage.get('contract_artifacts')) is dict,'Actual successful Solidity stage required')
    return context['mode']


def evm_control_dependency_selection(infos, members):
    from pathlib import PurePosixPath
    require(type(members)is dict and len(members)==8,'Actual eight dependency member pins required')
    expected=EVM_CONTROL_ARCHIVES|{'manifest.json'}
    require({PurePosixPath(n).name for n in members}==expected,'Exact seven archives plus manifest required')
    seen=set();selected=[]
    for info in infos:
        name=info.filename;path=PurePosixPath(name.rstrip('/'))
        require(name and not path.is_absolute() and str(path)==name.rstrip('/') and '..'not in path.parts and '\\'not in name,'Unsafe dependency ZIP path')
        require(name not in seen and not info.flag_bits&1,'Duplicate/encrypted dependency member');seen.add(name)
        require(stat.S_IFMT(info.external_attr>>16)in (0,stat.S_IFDIR if info.is_dir()else stat.S_IFREG),'Nonregular dependency ZIP member')
        if name in members:
            row=members[name];require(not info.is_dir() and info.file_size==row['bytes'] and info.CRC==row['crc32'],'Dependency catalog identity differs');selected.append(info)
    require(len(selected)==8 and {i.filename for i in selected}==set(members),'Dependency ZIP member missing')
    require(len(infos)<=25000 and sum(i.file_size for i in infos)<=EVM_CONTROL_LIMITS['expanded_ZIP_bytes'],'Bounded dependency ZIP required')
    return selected


def evm_control_extract_dependencies(archive, output, members, guard=lambda:None):
    import zipfile
    require(not output.exists(),'Fresh static archive extraction required')
    with zipfile.ZipFile(archive)as package:
        infos=package.infolist();selected=evm_control_dependency_selection(infos,members);names={i.filename for i in selected};output.mkdir(mode=0o700);catalog=[]
        for info in infos:
            guard();h=hashlib.sha256();count=0;out=None
            if info.filename in names:out=(output/Path(info.filename).name).open('xb')
            try:
                with package.open(info)as source:
                    while block:=source.read(65536):
                        count+=len(block);require(count<=info.file_size,'ZIP expansion changed');h.update(block)
                        if out is not None:out.write(block)
                        guard()
            finally:
                if out is not None:out.close()
            require(count==info.file_size,'ZIP member length differs')
            row={'path':info.filename,'bytes':count,'sha256':h.hexdigest(),'crc32':info.CRC};catalog.append(row)
            if info.filename in names:
                require(row=={'path':info.filename,**members[info.filename]},'Dependency body/CRC differs');(output/Path(info.filename).name).chmod(0o444)
    return catalog


def evm_control_validate_archives(output, repo):
    manifest=json.loads((output/'manifest.json').read_text());rows=manifest['archives']
    require(manifest['host']=={'system':'Linux','architecture':'x86_64'} and len(rows)==7 and {Path(r['path']).name for r in rows}==EVM_CONTROL_ARCHIVES,'Exact Linux archive manifest required')
    require(''.join(manifest['production_lock_sha256_chunks'])==sha(repo/'rust/main/Cargo.lock'),'Archive production lock differs')
    require(manifest['native_lock_sha256_chunks']==json.loads((repo/'zig/native/rocks/lock.json').read_text())['sha256_chunks'],'Archive native lock differs')
    libraries=[]
    for row in rows:
        path=output/Path(row['path']).name;require(path.stat().st_size==row['size_bytes'] and sha(path)==''.join(row['sha256_chunks']),'Static archive manifest/body differs')
        with path.open('rb')as stream:require(stream.read(8)==b'!<arch>\n','Ordinary static archive required')
        libraries.append(str(path))
    return libraries


def evm_control_commands(copied, compiler, mode, libraries, output):
    require(mode in {'ReleaseSafe','ReleaseFast'} and len(libraries)==7,'Exact mode/archive arguments required')
    common=[sys.executable,'-I','-B',str(copied/'zig/tools/zig.py'),'--compiler',str(compiler),'test']
    link=[*cpu.zig_cpu_args('direct'),'-O',mode,'-j2','-lc','-lstdc++',*libraries,'--test-no-exec']
    return [common+['src/consumer_prepare_control.zig',*link,'--test-filter',EVM_CONTROL_TESTS[0],'--test-filter',EVM_CONTROL_TESTS[1],'-femit-bin='+str(output/'prepare-tests')],common+['src/consumer_txid_control.zig',*link,'--test-filter',EVM_CONTROL_TESTS[2],'-femit-bin='+str(output/'txid-tests')]]


def evm_control_test_verdict(text, targets, parser):
    parsed=parser(text);rows=parsed['per_test'];require(rows and all(r['status']!='FAIL' for r in rows),'Component test failed')
    for target in targets:
        matches=[r for r in rows if r['name'].endswith('.test.'+target)];require(len(matches)==1 and matches[0]['status']=='OK','Actual unique required component test OK missing')
    return {'total':parsed['total'],'required_OK':[r for r in rows if any(r['name'].endswith('.test.'+t)for t in targets)],'status_counts':{s:sum(r['status']==s for r in rows)for s in ['OK','SKIP','FAIL']}}


def evm_control_main(argv):
    import resource
    started=time.monotonic();deadline=started+EVM_CONTROL_LIMITS['wall_seconds']
    parser=argparse.ArgumentParser(description='Independent post-EVM-case components; no main clock/performance credit')
    for name in ['repo','case-root','composition-result','tools','gh','output']:parser.add_argument('--'+name,type=Path,required=True)
    parser.add_argument('--execution-source-commit',required=True);parser.add_argument('--execute',action='store_true');args=parser.parse_args(argv)
    require(args.execute and sys.platform=='linux' and platform.machine()=='x86_64' and os.environ.get('GITHUB_ACTIONS')=='true','Explicit Linux CI component execution required')
    require(args.repo==ROOT and args.repo.resolve(strict=True)==args.repo and not args.output.exists() and args.output.is_absolute() and not args.output.is_relative_to(args.repo),'Fresh post-case root outside checkout required')
    require(EVM_CONTROL_DEP_MEMBERS is not None,'Actual dependency ZIP catalog is not yet bound')
    gh_token=os.environ.pop('GH_TOKEN',None)
    watched={sig:signal.signal(sig,interrupted)for sig in [signal.SIGINT,signal.SIGTERM,signal.SIGHUP]}
    api_spec=importlib.util.spec_from_file_location('evm_control_inputs',ROOT/'zig/integration/native_case_inputs.py');api=importlib.util.module_from_spec(api_spec);api_spec.loader.exec_module(api)
    context=json.loads((args.case_root/'hydrated-inputs.json').read_text());require(context.get('task_root')==str(args.case_root),'Actual case root/context differs');composition=json.loads(args.composition_result.read_text());case_path=api.checked(composition['actual_case_result']);case=json.loads(case_path.read_text());stage_path=api.checked(composition['actual_stage']);stage=json.loads(stage_path.read_text())
    require(case_path==args.case_root/'ci-supervision/result.json' and stage_path==args.composition_result.parent/'setup/local-stage.json','Actual main result/stage paths differ')
    require(composition['passed'] is True and composition['native_case_acceptance'] is True,'No component before successful main composition')
    mode=evm_control_admission(context,case,stage);require(context['execution_source_commit']==args.execution_source_commit,'Execution binding differs')
    git_rows=[];scopes={n:api.cohort(ROOT,EVM_CONTROL_PRODUCER,args.execution_source_commit,n,git_rows)for n in api.SCOPES}
    admitted=load_manifest(api.checked(context['tool_manifest']),context['tool_manifest']['sha256'],EVM_CONTROL_PRODUCER,62);require(admitted==context['tools'],'Actual NEXT tool admission differs')
    oracle=api.checked(admitted['ziggy-rocks-oracle']);url=api.checked(context['runtime_artifacts']['url']);tools=json.loads(args.tools.read_text());require(args.gh.is_absolute() and args.gh.is_file() and os.access(args.gh,os.X_OK),'Explicit gh required')
    args.output.mkdir(mode=0o700)
    for name in ['logs','home','tmp','bin','public']:(args.output/name).mkdir()
    tool_before={n:api.artifact(api.checked(tools[n]))for n in ['anvil','cast']};input_before={'context':descriptor(args.case_root/'hydrated-inputs.json'),'composition':descriptor(args.composition_result),'case':descriptor(case_path),'stage':descriptor(stage_path),'tools':descriptor(args.tools),'oracle':descriptor(oracle),'url':descriptor(url),'gh':descriptor(args.gh)}
    for n,r in tool_before.items():(args.output/'bin'/n).symlink_to(r['path'])
    source_names=['zig/bench/native_case_tools.py','zig/bench/native_harness_census.py','zig/bench/cold_matrix_owner.py','zig/integration/native_case_inputs.py','zig/integration/evm.py','zig/tools/container_check.py','zig/tools/bootstrap.py','zig/tools/zig.py','zig/tools/build_cpu.py'];consumer_sources=evm_control_execution_sources(ROOT,args.execution_source_commit,source_names)
    own_spec=importlib.util.spec_from_file_location('evm_control_owner',ROOT/'zig/bench/cold_matrix_owner.py');owner=importlib.util.module_from_spec(own_spec);own_spec.loader.exec_module(owner);owner.enable_subreaper()
    calls=[];error=None;result={'schema':1,'kind':'post-case-EVM-three-SDK-skip-controls','passed':False,'runtime_source_commit':EVM_CONTROL_PRODUCER,'execution_source_commit':args.execution_source_commit,'mode':mode,'main_native_case_result':input_before['case'],'main600_restart30_clock_modified':False,'native_case_or_performance_acceptance':False,'published_agent_or_SDK_rebuild':False,'calls':calls}
    env={'PATH':str(args.output/'bin')+':/usr/local/bin:/usr/bin:/bin','HOME':str(args.output/'home'),'TMPDIR':str(args.output/'tmp'),'LC_ALL':'C.UTF-8','GITHUB_ACTIONS':'true','HYPERLANE_URL_LIBRARY':str(url)}
    last_census=[0.0]
    def guard():
        require(time.monotonic()<deadline-EVM_CONTROL_LIMITS['cleanup_seconds'],'Original component600s deadline')
        require(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*1024<=EVM_CONTROL_LIMITS['RSS_bytes'],'Component parent RSS cap')
        require(shutil.disk_usage(args.output).free>=EVM_CONTROL_LIMITS['minimum_free_bytes'],'Component6GiB free floor')
        if time.monotonic()-last_census[0]>=1:
            require(functional_allocated(args.output)<=EVM_CONTROL_LIMITS['allocated_bytes'],'Component4GiB allocation cap');last_census[0]=time.monotonic()
    def run(name,command,cwd=ROOT,extra=None,maximum=64*1024**2):
        guard();child=None;known={};groups={};cleanup=None;failure=None;out=args.output/'logs'/(name+'.stdout');err=args.output/'logs'/(name+'.stderr')
        try:
            with out.open('xb')as stdout,err.open('xb')as stderr:
                child=subprocess.Popen(command,cwd=cwd,env={**env,**(extra or {})},stdin=subprocess.DEVNULL,stdout=stdout,stderr=stderr,start_new_session=True);groups[child.pid]=child.pid
                while os.waitid(os.P_PID,child.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT)is None:
                    rows=owner.processes();live=owner.owned_processes(rows,child.pid,known,groups,True);require(sum(r['rss_bytes']for r in live.values())+resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*1024<=EVM_CONTROL_LIMITS['RSS_bytes'],'Component8GiB RSS cap');require(out.stat().st_size<=maximum and err.stat().st_size<=EVM_CONTROL_LIMITS['phase_log_bytes'],'Component log cap');guard();time.sleep(.1)
        except BaseException as caught:failure=caught
        finally:
            ignored={sig:signal.signal(sig,signal.SIG_IGN)for sig in [signal.SIGINT,signal.SIGTERM,signal.SIGHUP]}
            try:
                if child is not None:
                    try:cleanup=owner.stop_owned(child,known,groups,grace_seconds=10,kill_seconds=3)
                    except BaseException as debt:
                        if failure is None:failure=debt
                        cleanup={'actual_parent_wait':False,'clean':False,'cleanup_confirmed_absent':False,'signals':[]}
            finally:
                for sig,previous in ignored.items():signal.signal(sig,previous)
            calls.append({'phase':name,'actual_parent_wait':bool(cleanup and cleanup['actual_parent_wait']),'exit_code':None if child is None else child.returncode,'clean':bool(cleanup and cleanup['clean']and cleanup['cleanup_confirmed_absent']and not cleanup['signals']),'stdout':descriptor(out)if out.exists()else None,'stderr':descriptor(err)if err.exists()else None})
        if failure is not None:raise failure
        last_census[0]=0.0
        require(child.returncode==0 and calls[-1]['clean'],'Actual component command/wait/absence failed');require(out.stat().st_size<=maximum and err.stat().st_size<=EVM_CONTROL_LIMITS['phase_log_bytes'],'Postflight component log cap');guard();return out,err
    try:
        # A ninth, separately pinned dependency artifact. No change to core eight.
        gh_env={'GH_TOKEN':gh_token or'','GH_CONFIG_DIR':str(args.output/'gh-config'),'GH_PROMPT_DISABLED':'1','GH_NO_UPDATE_NOTIFIER':'1'};require(gh_env['GH_TOKEN'],'Explicit CI read-only token required');(args.output/'gh-config').mkdir()
        archive,_=run('dependency-archive',[str(args.gh),'api','--hostname','github.com','repos/hyperlane-xyz/hyperlane-monorepo/actions/artifacts/'+str(EVM_CONTROL_DEP['artifact_id'])+'/zip'],extra=gh_env,maximum=EVM_CONTROL_DEP['bytes'])
        require(archive.stat().st_size==EVM_CONTROL_DEP['bytes'] and sha(archive)==EVM_CONTROL_DEP['sha256'],'Exact ninth archive SHA required')
        dep_catalog=evm_control_extract_dependencies(archive,args.output/'deps',EVM_CONTROL_DEP_MEMBERS,guard);libraries=evm_control_validate_archives(args.output/'deps',ROOT);archive.unlink()
        copied,source_rows=evm_control_copy_source(ROOT,args.output/'source',EVM_CONTROL_PRODUCER)
        (copied/'zig/src/consumer_prepare_control.zig').write_text(EVM_PREPARE_ENTRY);(copied/'zig/src/consumer_txid_control.zig').write_text(EVM_TXID_CONTROL)
        entries=[descriptor(copied/'zig/src'/n)for n in ['consumer_prepare_control.zig','consumer_txid_control.zig']]
        bootstrap,_=run('compiler-bootstrap',[sys.executable,'-I','-B',str(copied/'zig/tools/bootstrap.py'),'--cache-dir',str(args.output/'compiler')],maximum=65536);compiler=Path(bootstrap.read_text().strip());require(compiler.is_relative_to(args.output/'compiler') and compiler.is_file(),'Owned verified compiler required')
        compiler_pin=descriptor(compiler);commands=evm_control_commands(copied,compiler,mode,libraries,args.output)
        compiler_recipes=[]
        for index,command in enumerate(commands):
            recipe=cpu.recipe('zig-direct',command,env,Path(__file__),repo=ROOT)
            run('compile-'+str(index),command)
            compiler_recipes.append(cpu.finish_recipe(recipe,{'actual_parent_wait':calls[-1]['actual_parent_wait'],'exit_code':calls[-1]['exit_code'],'error':None},repo=ROOT))
        fixture=args.output/'fixture';fixture.mkdir();rust=fixture/'rust/main/utils/run-locally/src/ethereum/multicall.rs';rust.parent.mkdir(parents=True);shutil.copyfile(copied/'rust/main/utils/run-locally/src/ethereum/multicall.rs',rust);fixture_rust=descriptor(rust);require(fixture_rust['sha256']==source_rows['rust/main/utils/run-locally/src/ethereum/multicall.rs']['sha256'],'Fixture Rust Source copy differs')
        worker={'schema':1,'tools':tool_before,'contracts':evm_control_contracts(stage,ROOT),'test_binary':descriptor(args.output/'prepare-tests'),'fixture_root':str(fixture),'output':str(args.output/'prepare-actual.json')};worker_path=args.output/'prepare-worker.json';worker_path.write_text(json.dumps(worker)+'\n')
        aout,aerr=run('prepare-and-Anvil',[sys.executable,'-I','-B',str(ROOT/'zig/bench/native_case_tools.py'),'evm-prepare-worker','--manifest',str(worker_path)],maximum=65536)
        tout,terr=run('txid-crash-window',[str(args.output/'txid-tests')],cwd=fixture,extra={'CONTROL_ORACLE_PATH':str(oracle),'CONTROL_ORACLE_SHA256':admitted['ziggy-rocks-oracle']['sha256']},maximum=65536)
        spec=importlib.util.spec_from_file_location('evm_control_parser',ROOT/'zig/tools/container_check.py');checker=importlib.util.module_from_spec(spec);spec.loader.exec_module(checker)
        # Filtered components enforce their own exact targets below; SDK census stays separate.
        checker.NATIVE_REQUIRED=()
        tests=[evm_control_test_verdict(aout.read_text()+aerr.read_text(),EVM_CONTROL_TESTS[:2],checker.native_test_results),evm_control_test_verdict(tout.read_text()+terr.read_text(),EVM_CONTROL_TESTS[2:],checker.native_test_results)]
        require('CONSUMER_TXID_CRASH_WINDOW_OK'in(tout.read_text()+terr.read_text()),'Actual crash-window completion marker required')
        fixture_result=json.loads((args.output/'prepare-actual.json').read_text());require(set(fixture_result)=={'schema','passed','Anvil_stopped_and_waited','exact_existing_prepare_and_Anvil_tests','fixture_json'}and all(fixture_result[k]is True for k in ['passed','Anvil_stopped_and_waited','exact_existing_prepare_and_Anvil_tests'])and set(fixture_result['fixture_json'])=={'bytes','sha256'},'Actual prepare fixture cleanup missing')
        require(evm_control_validate_archives(args.output/'deps',ROOT)==libraries and all(descriptor(Path(r['path']))==r for r in entries)and descriptor(rust)==fixture_rust,'Compiler/archive/entrypoint/fixture Source postflight differs')
        require({n:api.cohort(ROOT,EVM_CONTROL_PRODUCER,args.execution_source_commit,n,git_rows)for n in api.SCOPES}==scopes,'Original compiled7 changed')
        require(evm_control_execution_sources(ROOT,args.execution_source_commit,source_names)==consumer_sources and all(descriptor(Path(r['path']))==r for r in input_before.values())and all(descriptor(Path(r['path']))==r for r in tool_before.values())and descriptor(compiler)==compiler_pin,'Postflight component inputs changed')
        require(all(descriptor(copied/n)['sha256']==r['sha256']for n,r in source_rows.items()),'Owned Source copy changed')
        last_census[0]=0.0;guard()
        result['cpu_contract']=cpu.make_record('evm-controls',mode,args.execution_source_commit,'amd64',cpu.cpu_flags(Path('/proc/cpuinfo').read_text()),{name:{k:descriptor(args.output/name)[k]for k in ['bytes','sha256']}for name in ['prepare-tests','txid-tests']},compiler_recipes)
        result.update(passed=True,published_agent_ELFs_executed=False,admitted_URL_DSO_used=True,admitted_Source_built_oracle_executed=True,required_tests=tests,component_entries=entries,fixture_JSON=fixture_result['fixture_json'],fixture_Rust_Source=fixture_rust,temporary_dependency_ZIP_removed=not archive.exists(),separate_ninth_dependency={**EVM_CONTROL_DEP,'whole_SHA_all_member_CRC':True,'catalog_sha256':hashlib.sha256(json.dumps(dep_catalog,sort_keys=True).encode()).hexdigest()},producer_Source_copy={'files':len(source_rows),'catalog_sha256':hashlib.sha256(json.dumps(source_rows,sort_keys=True).encode()).hexdigest()},consumer_Source={n:{k:v for k,v in r.items()if k!='path'}for n,r in consumer_sources.items()},compiler=compiler_pin,oracle=admitted['ziggy-rocks-oracle'],archive_inputs=[descriptor(Path(x))for x in libraries],main_scope_trees=scopes,all_component_waits_clean=True)
    except BaseException as caught:error=caught;result['error_class']=type(caught).__name__
    finally:
        for sig,previous in watched.items():signal.signal(sig,previous)
        wire=json.dumps(result,indent=2)+'\n';require(len(wire.encode())<=EVM_CONTROL_LIMITS['public_bytes'],'Closed public component result cap');(args.output/'public/result.json').write_text(wire)
    if error is not None:raise error


def evm_control_copy_source(repo, copied, producer):
    scopes=['zig/src','zig/native','zig/build.zig','zig/build.zig.zon','rust/main/utils/run-locally/src/ethereum/multicall.rs','zig/tools/zig.py','zig/tools/bootstrap.py']
    raw=subprocess.check_output(['git','ls-tree','-r','-z',producer,'--',*scopes],cwd=repo,timeout=15);require(len(raw)<=2*1024**2,'Bounded NEXT Source tree listing')
    rows={};total=0;copied.mkdir(mode=0o700)
    for item in raw.split(b'\0'):
        if not item:continue
        record,name=item.split(b'\t',1);mode,kind,blob=record.decode().split();name=name.decode()
        require(mode in {'100644','100755'}and kind=='blob'and name not in rows and not Path(name).is_absolute()and'..'not in Path(name).parts,'Regular unique tracked D Source only')
        wire=regular(repo/name).read_bytes();total+=len(wire);require(len(rows)<2048 and len(wire)<=4*1024**2 and total<=64*1024**2,'Bounded owned D Source copy')
        require(hashlib.sha1(b'blob '+str(len(wire)).encode()+b'\0'+wire).hexdigest()==blob,'D Source body differs from actual Git object')
        path=copied/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(wire);path.chmod(0o444);rows[name]={'bytes':len(wire),'sha256':hashlib.sha256(wire).hexdigest(),'producer_blob':blob}
    require('zig/src/db_tests.zig'in rows and 'zig/src/agents/indexing/tx_id_native_test.zig'in rows,'Exact actual NEXT test graph required')
    return copied,rows


def evm_control_contracts(stage,repo):
    rows=stage['contract_artifacts'];selected={}
    for name,source in EVM_CONTROL_CONTRACTS.items():
        logical='solidity/artifacts/'+source+'/'+name+'.json';require(logical in rows,'Exact actual compiled repository Solidity artifact missing')
        row=rows[logical];path=Path(row['path']);require(path==repo/logical and descriptor(path)==row,'Compiled Solidity artifact changed')
        value=json.loads(path.read_text());require(value['sourceName']==source and value['contractName']==name and re.fullmatch('0x[0-9a-fA-F]+',value['bytecode'])is not None,'Repository Solidity output identity differs')
        selected[name]=row
    return selected


def evm_control_prepare_worker(argv):
    import socket
    parser=argparse.ArgumentParser();parser.add_argument('--manifest',type=Path,required=True);args=parser.parse_args(argv);value=json.loads(args.manifest.read_text())
    require(set(value)=={'schema','tools','contracts','test_binary','fixture_root','output'}and value['schema']==1,'Closed prepare worker required')
    require(set(value['tools'])=={'anvil','cast'}and set(value['contracts'])==set(EVM_CONTROL_CONTRACTS),'Exact admitted fixture inputs required')
    fixed=[*value['tools'].values(),*value['contracts'].values(),value['test_binary']]
    for row in fixed:require(descriptor(Path(row['path']))==row,'Fixture input differs')
    fixture=Path(value['fixture_root']);require(fixture.is_dir()and not fixture.is_symlink(),'Fresh private fixture cwd required')
    spec=importlib.util.spec_from_file_location('evm_control_rpc',ROOT/'zig/integration/evm.py');evm=importlib.util.module_from_spec(spec);spec.loader.exec_module(evm)
    with socket.socket()as reserve:reserve.bind(('127.0.0.1',0));port=reserve.getsockname()[1]
    child=None;clean=False
    try:
        child=subprocess.Popen([value['tools']['anvil']['path'],'--host','127.0.0.1','--port',str(port),'--chain-id','31337','--silent'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        chain=evm.Chain('http://127.0.0.1:'+str(port))
        for _ in range(100):
            require(child.poll()is None,'Owned Anvil exited')
            try:chain.account=chain.rpc('eth_accounts')[0];break
            except (ConnectionError,evm.urllib.error.URLError):time.sleep(.05)
        else:raise ValueError('Owned Anvil startup deadline')
        require(chain.rpc('eth_chainId')=='0x7a69','Owned fixture physical chain differs')
        bytecodes={name:json.loads(Path(row['path']).read_text())['bytecode']for name,row in value['contracts'].items()}
        def deploy(name,signature=None,*args):return chain.send(bytecodes[name]+(evm.abi(signature,*args)if signature else''))['contractAddress']
        origin=deploy('Mailbox','constructor(uint32)','1000');destination=deploy('Mailbox','constructor(uint32)','2000')
        origin_hook=deploy('MerkleTreeHook','constructor(address)',origin);destination_hook=deploy('MerkleTreeHook','constructor(address)',destination)
        required=deploy('TestPostDispatchHook');ism=deploy('TestIsm');recipient=deploy('TestRecipient')
        for mailbox,hook in [(origin,origin_hook),(destination,destination_hook)]:chain.send(evm.calldata('initialize(address,address,address,address)',chain.account,ism,hook,required),mailbox)
        receipt=chain.send(evm.calldata('dispatch(uint32,bytes32,bytes)','2000','0x'+'00'*12+recipient[2:],'0x636f6e73756d6572207072657061726520636f6e74726f6c'),origin)
        topic=evm.run([value['tools']['cast']['path'],'keccak','Dispatch(address,uint32,bytes32,bytes)']);logs=[r for r in receipt['logs']if r['address'].lower()==origin.lower()and r['topics'][0]==topic];require(len(logs)==1,'Actual singleton dispatch required')
        raw=bytes.fromhex(logs[0]['data'][2:]);length=int.from_bytes(raw[32:64],'big');wire=raw[64:64+length];require(77<=len(wire)<=1024 and len(wire)==length,'Actual dispatch wire bounds')
        for _ in range(2):chain.rpc('evm_mine')
        path=fixture/'zig/src/agents/relayer/evm_prepare_fixtures/loopback.json';path.parent.mkdir(parents=True);path.write_text(json.dumps(evm_control_fixture_document(wire,chain.url,destination,chain.account))+'\n')
        fixture_pin=descriptor(path)
        test=subprocess.run([value['test_binary']['path']],cwd=fixture,env={**{k:os.environ[k]for k in ['PATH','HOME','TMPDIR','LC_ALL','GITHUB_ACTIONS','HYPERLANE_URL_LIBRARY']if k in os.environ},'ZIG_EVM_PREPARE_LOOPBACK':'1'},timeout=120);require(test.returncode==0,'Actual existing prepare/Anvil tests failed')
        for row in fixed:require(descriptor(Path(row['path']))==row,'Fixture input changed during test')
        require(descriptor(path)==fixture_pin,'Fixture JSON changed during test')
    finally:
        if child is not None:
            child.terminate()
            try:child.wait(timeout=5);clean=True
            except subprocess.TimeoutExpired:child.kill();child.wait(timeout=3)
    require(clean,'Owned fixture needed forced cleanup')
    Path(value['output']).write_text(json.dumps({'schema':1,'passed':True,'Anvil_stopped_and_waited':True,'exact_existing_prepare_and_Anvil_tests':True,'fixture_json':{k:v for k,v in fixture_pin.items()if k!='path'}})+'\n')


def evm_control_execution_sources(repo,execution,names):
    env={'PATH':'/usr/bin:/bin','LC_ALL':'C','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_OPTIONAL_LOCKS':'0'}
    raw=subprocess.check_output(['/usr/bin/git','ls-tree','-r','-z',execution,'--',*names],cwd=repo,env=env,timeout=15);require(len(raw)<=1024**2,'Bounded consumer Git Source listing')
    result={}
    for item in raw.split(b'\0'):
        if not item:continue
        record,name=item.split(b'\t',1);mode,kind,blob=record.decode().split();name=name.decode();require(name in names and name not in result and mode in {'100644','100755'}and kind=='blob','Fixed committed consumer Source only')
        wire=regular(repo/name).read_bytes();require(len(wire)<=1024**2 and hashlib.sha1(b'blob '+str(len(wire)).encode()+b'\0'+wire).hexdigest()==blob,'Dirty/uncommitted consumer Source')
        result[name]=descriptor(repo/name)
    require(set(result)==set(names),'Consumer Source missing from actual execution Git');return result


def evm_control_fixture_document(wire,url,mailbox,relayer):
    require(type(wire)is bytes and 77<=len(wire)<=1024,'Actual dispatch wire bounds')
    require(re.fullmatch(r'http://127\.0\.0\.1:[1-9][0-9]{0,4}',url)is not None and 1<=int(url.rsplit(':',1)[1])<=65535,'Owned loopback fixture only')
    require(all(re.fullmatch('0x[0-9a-fA-F]{40}',address)is not None for address in [mailbox,relayer]),'Exact public fixture addresses')
    encoded='0x'+wire.hex()
    # The EXISTING exact test fixtureText API takes <=32-character string chunks.
    return {'message':[encoded[i:i+32]for i in range(0,len(encoded),32)],'rpc_url':url,'mailbox':mailbox,'relayer':relayer}

EVM_TXID_CONTROL = '//! Consumer-only entrypoint. Copy beside exact producer src/ in an OWNED copy.\n//! The tracked repository\'s compiled7 and original SDK tests are never changed.\nconst std = @import("std");\nconst fixture = @import("agents/indexing/tx_id_native_test.zig");\n\ntest "consumer portable transaction-ID crash window repairs reopened dispatch and actual Source Rust decoder agrees" {\n    const a = std.testing.allocator;\n    const oracle = try std.process.getEnvVarOwned(a, "CONTROL_ORACLE_PATH");\n    defer a.free(oracle);\n    const expected = try std.process.getEnvVarOwned(a, "CONTROL_ORACLE_SHA256");\n    defer a.free(expected);\n    try std.testing.expectEqual(@as(usize, 64), expected.len);\n    const executable = try std.fs.cwd().readFileAlloc(a, oracle, 256 * 1024 * 1024);\n    defer a.free(executable);\n    var digest: [32]u8 = undefined;\n    std.crypto.hash.sha2.Sha256.hash(executable, &digest, .{});\n    try std.testing.expectEqualStrings(expected, &std.fmt.bytesToHex(digest, .lower));\n    const self = try fixture.Harness.init(a, 1, 2);\n    defer self.deinit();\n    for (0..3) |_| _ = try self.service.tick(0, &self.cancel);\n    const id = self.wire.messages[0].id();\n    try std.testing.expect((try self.service.store.payment(.{ .message_id = id, .destination = 9913372 })) == null);\n    try std.testing.expect((try self.service.store.insertionByIndex(0)) == null);\n    try std.testing.expect((try self.service.store.dispatchedTransaction(id)) != null);\n    self.database.deinit();\n    self.database_open = false;\n    self.database = try @TypeOf(self.database).open(a, self.path, .{});\n    self.database_open = true;\n    var reopened_store = @TypeOf(self.service.store).init(a, &self.database, self.chain.name);\n    var reopened_queue = try @TypeOf(self.queue).init(a, 2, .{ .tree = true, .gas = true });\n    defer reopened_queue.deinit();\n    try std.testing.expectEqual(@as(usize, 0), reopened_queue.count());\n    var restarted: @TypeOf(self.companion) = .{\n        .allocator = a,\n        .queue = &reopened_queue,\n        .store = &reopened_store,\n        .contracts = self.companion.contracts,\n        .domain = self.chain.domain,\n        .source = self.adapter.interface(),\n    };\n    defer restarted.deinit();\n    _ = try restarted.tick(100, &self.cancel);\n    const payment = (try reopened_store.payment(.{ .message_id = id, .destination = 9913372 })).?;\n    try std.testing.expectEqual(@as(u256, 500), payment.payment);\n    try std.testing.expectEqual(@as(u256, 1000), payment.gas_amount);\n    var transaction: [64]u8 = @splat(0);\n    transaction[63] = 10;\n    try std.testing.expectEqual(transaction, (try reopened_store.dispatchedTransaction(id)).?);\n    try std.testing.expectEqual(id, (try reopened_store.insertionByIndex(0)).?.message_id);\n    self.database.deinit();\n    self.database_open = false;\n    var environment = std.process.EnvMap.init(a);\n    defer environment.deinit();\n    const result = try std.process.Child.run(.{\n        .allocator = a,\n        .argv = &.{ oracle, "relayer-probe", self.path, "9913371", "test1", "9913372", "test2", "1" },\n        .env_map = &environment,\n        .max_output_bytes = 8 * 1024 * 1024,\n    });\n    defer a.free(result.stdout);\n    defer a.free(result.stderr);\n    try std.testing.expect(result.term == .Exited and result.term.Exited == 0);\n    const decoded = try std.json.parseFromSlice(std.json.Value, a, result.stdout, .{});\n    defer decoded.deinit();\n    const rows = decoded.value.object.get("messages").?.array.items;\n    try std.testing.expectEqual(@as(usize, 1), rows.len);\n    try std.testing.expect(rows[0].object.get("present").?.bool);\n    const processed = rows[0].object.get("processed").?;\n    try std.testing.expect(processed == .null or (processed == .bool and !processed.bool));\n    try std.testing.expectEqualStrings("500", rows[0].object.get("payment").?.object.get("payment").?.string);\n    try std.testing.expectEqualStrings("1000", rows[0].object.get("payment").?.object.get("gas_amount").?.string);\n    const insertion = rows[0].object.get("insertion_id_chunks").?;\n    try std.testing.expect(insertion != .null);\n    const after = try std.fs.cwd().readFileAlloc(a, oracle, 256 * 1024 * 1024);\n    defer a.free(after);\n    std.crypto.hash.sha2.Sha256.hash(after, &digest, .{});\n    try std.testing.expectEqualStrings(expected, &std.fmt.bytesToHex(digest, .lower));\n    std.debug.print("CONSUMER_TXID_CRASH_WINDOW_OK\\n", .{});\n}\n'

def main():
    if sys.argv[1:2]==['evm-controls']:return evm_control_main(sys.argv[2:])
    if sys.argv[1:2]==['evm-prepare-worker']:return evm_control_prepare_worker(sys.argv[2:])
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
