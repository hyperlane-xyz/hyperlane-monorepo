#!/usr/bin/env python3
"""Record observed hosts and explicit portable compiler recipes; legacy schema unchanged."""
import argparse
import ast
import copy
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shlex
import subprocess
import sys

SCOPES = {
    'native-db': {'relayer', 'validator', 'scraper'},
    'url': {'libziggy_url.so'},
    'regex': {'libziggy_regex.so'},
    'starknet': {'libziggy_starknet_crypto.so'},
    'aleo': {'libziggy_aleo_crypto.so', 'libziggy_aleo_vm.so', 'hyperlane-aleo-vm-worker'},
}


def cpu_flags(text, intersection=False):
    rows = [set(line.split(':', 1)[1].strip().split()) for line in text.splitlines()
            if line.split(':', 1)[0].strip().lower() in {'flags', 'features'}]
    if not rows or any(not row for row in rows):
        raise ValueError('CPU feature evidence unavailable')
    return sorted(set.intersection(*rows) if intersection else set.union(*rows))


def validate_v1(row, scope, mode, commit, expected):
    if set(row) != {'schema', 'scope', 'mode', 'source_commit', 'architecture', 'flags', 'artifacts'} or row['schema'] != 1 or type(row['schema']) is not int:
        raise ValueError('compile provenance schema differs')
    if row['scope'] != scope or row['mode'] != mode or row['source_commit'] != commit or row['architecture'] not in {'amd64', 'arm64'}:
        raise ValueError('compile provenance scope/mode/source/platform differs')
    if not isinstance(row['flags'], list) or not row['flags'] or row['flags'] != sorted(set(row['flags'])) or any(re.fullmatch('[A-Za-z0-9_.+-]+', value) is None for value in row['flags']):
        raise ValueError('invalid observed compile CPU flags')
    if set(row['artifacts']) != SCOPES[scope]:
        raise ValueError('compile provenance artifact set differs')
    for name, value in row['artifacts'].items():
        if set(value) != {'bytes', 'sha256'} or type(value['bytes']) is not int or value['bytes'] <= 0 or value['sha256'] != expected[name]:
            raise ValueError('compiled artifact identity differs from tested bytes')
    return row


ROOT = Path(__file__).resolve().parents[2]
PROFILE = 'linux-x86_64-v3-pclmul-native-abi-v1'
# ISA-only Linux names for the pinned x86_64_v3 model plus explicit PCLMUL.
# Pinned RocksDB10.4.2 CRC compilation requires PCLMUL independently of GCC v3.
# Linux calls SSE3 pni, BMI bmi1, LZCNT abm, SAHF lahf_lm, x87 fpu, and pclmul pclmulqdq.
REQUIRED_FLAGS = tuple(sorted(('cmov', 'cx8', 'cx16', 'fpu', 'fxsr', 'mmx', 'sse', 'sse2',
                               'pni', 'ssse3', 'sse4_1', 'sse4_2', 'popcnt', 'lahf_lm',
                               'avx', 'avx2', 'bmi1', 'bmi2', 'f16c', 'fma', 'abm', 'movbe', 'nopl', 'pclmulqdq', 'xsave')))
RUST_CPU = '-Ctarget-cpu=x86-64-v3 -Ctarget-feature=+pclmulqdq'
C_FLAGS = '-march=x86-64-v3 -mtune=generic -mpclmul'
TARGET = {'profile': PROFILE, 'zig_target': 'native', 'abi_policy': 'publisher-native-linux-gnu', 'zig_cpu': 'x86_64_v3+pclmul',
          'rust_target': 'x86_64-unknown-linux-gnu', 'rust_cpu': 'x86-64-v3', 'rust_features': ['pclmulqdq'],
          'cc_cpu': 'x86-64-v3', 'cc_features': ['pclmul'], 'required_flags': list(REQUIRED_FLAGS)}
EXTRA_SCOPES = {'writer', 'helper', 'tools', 'radix-reference', 'svm-host', 'native-deps', 'evm-controls'}
EXTRA_ARTIFACTS = {
    'writer': {'writer'}, 'helper': {'normal', 'construction'},
    'tools': {'init-db', 'ziggy-rocks-oracle', 'ziggy-native-rows', 'ziggy-rust-reference'},
    'radix-reference': {'tool'}, 'svm-host': {'client', 'spl'},
    'native-deps': {'libziggy_rocks_abi.a', 'librocksdb.a', 'libsnappy.a', 'liblz4.a', 'libzstd.a', 'libz.a', 'libbz2.a'},
    'evm-controls': {'prepare-tests', 'txid-tests'},
}
SHARED_SCOPES = {'helper', 'tools', 'radix-reference', 'svm-host', 'native-deps'}
KINDS = {'rust', 'zig-build', 'zig-direct', 'cc'}
# Complete compiler-family coverage, pinned to the actual producer caller files.
# Multiplicity means distinct executed commands, not duplicate declarations.
COVERAGE = {
    'native-db': [('zig/Dockerfile', 'zig-build', 2), ('zig/tools/native_deps.py', 'rust', 1), ('zig/tools/native_deps.py', 'cc', 2)],
    'url': [('zig/src/net/native-url/locked.py', 'rust', 1)],
    'regex': [('zig/src/ops/tools/locked.py', 'rust', 1)],
    'starknet': [('zig/src/starknet/testing/locked.py', 'rust', 1)],
    'aleo': [('zig/src/aleo/testing/locked.py', 'rust', 2), ('zig/Dockerfile', 'zig-build', 1)],
    'writer': [('zig/bench/native_interop_writer_export.py', 'zig-direct', 1)],
    'helper': [('zig/bench/native_harness_controls.py', 'rust', 2)],
    'tools': [('zig/bench/native_case_tools.py', 'rust', 4)],
    'radix-reference': [('zig/bench/native_radix_reference.py', 'rust', 1)],
    'svm-host': [('zig/tools/svm_prerequisites.py', 'rust', 2)],
    'native-deps': [('zig/tools/native_deps.py', 'rust', 1), ('zig/tools/native_deps.py', 'cc', 2)],
    'evm-controls': [('zig/bench/native_case_tools.py', 'zig-direct', 2)],
}



def portable_environment(environment, tokio_unstable=False):
    result = dict(environment)
    for name in list(result):
        if (name in {'RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'CARGO_BUILD_TARGET', 'CARGO_BUILD_RUSTFLAGS', 'CC', 'CXX', 'RUSTC', 'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER', 'CARGO_BUILD_RUSTC', 'CARGO_BUILD_RUSTC_WRAPPER', 'CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER'} or
            name.startswith('CARGO_TARGET_') and name.endswith('_RUSTFLAGS') or
            name.startswith('CARGO_PROFILE_') and name.endswith(('_RUSTFLAGS', '_BUILD_OVERRIDE_OPT_LEVEL')) or
            name.startswith(('CFLAGS', 'CXXFLAGS', 'HOST_CFLAGS', 'HOST_CXXFLAGS', 'TARGET_CFLAGS', 'TARGET_CXXFLAGS', 'CC_', 'CXX_', 'HOST_CC', 'HOST_CXX', 'TARGET_CC', 'TARGET_CXX'))):
            result.pop(name)
    result.update(RUSTFLAGS=('--cfg tokio_unstable ' if tokio_unstable else '') + RUST_CPU,
                  CFLAGS=C_FLAGS, CXXFLAGS=C_FLAGS)
    for name in ('RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER', 'CARGO_BUILD_RUSTC_WRAPPER', 'CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER'):
        result[name] = ''  # Override any config-file wrapper without executing it.
    return result


def zig_cpu_args(kind):
    if kind == 'build':
        return ['-Dtarget=native', '-Dcpu=x86_64_v3+pclmul']
    if kind == 'direct':
        return ['-target', 'native', '-mcpu=x86_64_v3+pclmul']
    raise ValueError('fixed Zig command kind required')


def _source_pin(source_path, repo):
    repo = Path(repo).resolve()
    path = Path(source_path)
    if not path.is_absolute():
        path = repo / path
    relative = path.relative_to(repo)
    if '..' in relative.parts or path.is_symlink() or not path.is_file() or path.stat().st_size > 1024**2:
        raise ValueError('bounded regular recipe Source required')
    for part in [path, *path.parents]:
        if part == repo: break
        if part.is_symlink(): raise ValueError('recipe Source symlink')
    wire = path.read_bytes()
    return {'path': relative.as_posix(), 'bytes': len(wire), 'sha256': hashlib.sha256(wire).hexdigest()}


def recipe(kind, argv, environment, source_path, repo=ROOT):
    if kind not in KINDS or type(argv) is not list or not argv or any(type(v) is not str for v in argv):
        raise ValueError('actual compiler argv required')
    # Only known public compiler settings are retained; never serialize the env.
    flags = {}
    if kind in {'rust', 'cc'} and any(name in {'CC', 'CXX', 'RUSTC'} or name.startswith(('CC_', 'CXX_', 'HOST_CC', 'HOST_CXX', 'TARGET_CC', 'TARGET_CXX')) for name in environment):
        raise ValueError('ambient compiler command override')
    if kind == 'rust':
        if any(environment.get(name) != '' for name in ('RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER', 'CARGO_BUILD_RUSTC_WRAPPER', 'CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER')):
            raise ValueError('compiler wrappers must be explicitly disabled')
        rust = environment.get('RUSTFLAGS')
        if rust not in {RUST_CPU, '--cfg tokio_unstable ' + RUST_CPU}:
            raise ValueError('explicit portable Rust CPU required')
        if 'CARGO_ENCODED_RUSTFLAGS' in environment or any(k.startswith('CARGO_TARGET_') and k.endswith('_RUSTFLAGS') for k in environment):
            raise ValueError('ambient Rust target override')
        # Cargo rustc/--config may override the environment; none of our fixed
        # producer recipes uses those compiler-argument escape hatches.
        if 'rustc' in argv or '--config' in argv or any(v.startswith(('--config=', '-C', '--codegen', '--target-cpu', '-march', '-mtune')) for v in argv):
            raise ValueError('Rust argv compiler override')
        if environment.get('CARGO_BUILD_TARGET') or environment.get('CARGO_BUILD_RUSTFLAGS') or any(v.startswith('--target=') and v != '--target=x86_64-unknown-linux-gnu' for v in argv) or any(v == '--target' and argv[i+1:i+2] != ['x86_64-unknown-linux-gnu'] for i, v in enumerate(argv)):
            raise ValueError('Rust target override')
        flags['RUSTFLAGS'] = rust
    if kind in {'rust', 'cc'}:
        if any(environment.get(k) != C_FLAGS for k in ('CFLAGS', 'CXXFLAGS')):
            raise ValueError('explicit portable C/C++ CPU required')
        if any(k.startswith(('CFLAGS_', 'CXXFLAGS_', 'HOST_CFLAGS', 'HOST_CXXFLAGS', 'TARGET_CFLAGS', 'TARGET_CXXFLAGS', 'CC_', 'CXX_', 'HOST_CC', 'HOST_CXX', 'TARGET_CC', 'TARGET_CXX')) for k in environment):
            raise ValueError('ambient C/C++ target override')
        flags.update(CFLAGS=C_FLAGS, CXXFLAGS=C_FLAGS)
    if kind == 'zig-build':
        if any(v in {'-Dtarget', '-Dcpu'} for v in argv): raise ValueError('ambiguous Zig target option')
        expected = zig_cpu_args('build')
        if [v for v in argv if v.startswith(('-Dtarget=', '-Dcpu='))] != expected:
            raise ValueError('exact portable Zig build target required')
        flags['argv'] = expected
    elif kind == 'zig-direct':
        if any(v.startswith('-target=') for v in argv) or argv.count('-target') != 1 or argv[argv.index('-target') + 1:argv.index('-target') + 2] != ['native'] or [v for v in argv if v.startswith('-mcpu')] != ['-mcpu=x86_64_v3+pclmul']:
            raise ValueError('exact portable Zig direct target required')
        flags['argv'] = zig_cpu_args('direct')
    elif kind == 'cc':
        if [v for v in argv if v.startswith(('-march=', '-mtune=', '-mpclmul', '-mno-pclmul'))] != shlex.split(C_FLAGS):
            raise ValueError('exact portable C/C++ argv required')
        flags['argv'] = shlex.split(C_FLAGS)
    return {'kind': kind, 'source': _source_pin(source_path, repo), 'flags': flags,
            'command_sha256': hashlib.sha256(json.dumps(argv, separators=(',', ':')).encode()).hexdigest(),
            'actual_parent_wait': None, 'exit_code': None}


def finish_recipe(value, actual_wait, repo=ROOT):
    if actual_wait.get('actual_parent_wait') is not True or type(actual_wait.get('exit_code')) is not int or actual_wait['exit_code'] != 0 or actual_wait.get('error') is not None:
        raise ValueError('actual successful compiler parent wait required')
    if _source_pin(value['source']['path'], repo) != value['source']:
        raise ValueError('compiler recipe Source changed')
    result = copy.deepcopy(value)
    result.update(actual_parent_wait=True, exit_code=0)
    _validate_recipe(result)
    return result


def _validate_recipe(value):
    if type(value) is not dict or set(value) != {'kind', 'source', 'flags', 'command_sha256', 'actual_parent_wait', 'exit_code'} or value['kind'] not in KINDS or value['actual_parent_wait'] is not True or type(value['exit_code']) is not int or value['exit_code'] != 0:
        raise ValueError('closed successful compiler recipe required')
    source = value['source']
    if type(source) is not dict or set(source) != {'path', 'bytes', 'sha256'} or type(source['path']) is not str or not 0 < len(source['path']) <= 4096 or not re.fullmatch(r'[A-Za-z0-9_./-]+', source['path']) or Path(source['path']).is_absolute() or '..' in Path(source['path']).parts or type(source['bytes']) is not int or not 0 < source['bytes'] <= 1024**2 or type(source['sha256']) is not str or re.fullmatch('[0-9a-f]{64}', source['sha256']) is None:
        raise ValueError('closed recipe Source pin required')
    if type(value['command_sha256']) is not str or re.fullmatch('[0-9a-f]{64}', value['command_sha256']) is None:
        raise ValueError('actual compiler command hash required')
    flags = value['flags'];kind = value['kind']
    expected = {'argv': zig_cpu_args('build' if kind == 'zig-build' else 'direct')} if kind.startswith('zig-') else {'CFLAGS': C_FLAGS, 'CXXFLAGS': C_FLAGS}
    if kind == 'rust':
        if type(flags) is not dict or flags.get('RUSTFLAGS') not in {RUST_CPU, '--cfg tokio_unstable ' + RUST_CPU}:
            raise ValueError('portable Rust recipe required')
        expected['RUSTFLAGS'] = flags['RUSTFLAGS']
    elif kind == 'cc': expected['argv'] = shlex.split(C_FLAGS)
    if flags != expected: raise ValueError('compiler profile flags differ')
    return value


def make_record(scope, mode, commit, architecture, host_flags, artifacts, recipes):
    row = {'schema': 2, 'scope': scope, 'mode': mode, 'source_commit': commit,
           'architecture': architecture, 'flags': list(host_flags), 'artifacts': copy.deepcopy(artifacts),
           'target': copy.deepcopy(TARGET), 'recipes': copy.deepcopy(recipes)}
    validate(row, scope, mode, commit, {n: p['sha256'] for n, p in artifacts.items()})
    return row


def validate(row, scope, mode, commit, expected):
    if type(row) is dict and row.get('schema') == 1:
        return validate_v1(row, scope, mode, commit, expected)
    if type(row) is not dict or set(row) != {'schema', 'scope', 'mode', 'source_commit', 'architecture', 'flags', 'artifacts', 'target', 'recipes'} or type(row['schema']) is not int or row['schema'] != 2:
        raise ValueError('compile provenance schema differs')
    if scope not in set(SCOPES) | EXTRA_SCOPES or row['scope'] != scope or mode not in ({'shared'} if scope in SHARED_SCOPES else {'ReleaseSafe', 'ReleaseFast'}) or row['mode'] != mode or row['source_commit'] != commit or type(commit) is not str or re.fullmatch('[0-9a-f]{40}', commit) is None or row['architecture'] != 'amd64' or row['target'] != TARGET:
        raise ValueError('portable compile provenance identity differs')
    flags = row['flags']
    if type(flags) is not list or not 0 < len(flags) <= 512 or any(type(v) is not str or re.fullmatch('[A-Za-z0-9_.+-]{1,64}', v) is None for v in flags) or flags != sorted(set(flags)):
        raise ValueError('invalid observed compile CPU flags')
    if type(row['artifacts']) is not dict or not row['artifacts'] or set(row['artifacts']) != (SCOPES[scope] if scope in SCOPES else EXTRA_ARTIFACTS[scope]):
        raise ValueError('compile provenance artifact set differs')
    for name, value in row['artifacts'].items():
        if type(value) is not dict or set(value) != {'bytes', 'sha256'} or type(value['bytes']) is not int or value['bytes'] <= 0 or type(value['sha256']) is not str or re.fullmatch('[0-9a-f]{64}', value['sha256']) is None or value['sha256'] != expected[name]:
            raise ValueError('compiled artifact identity differs from tested bytes')
    if type(row['recipes']) is not list or not 0 < len(row['recipes']) <= 64:
        raise ValueError('actual compiler recipes required')
    for value in row['recipes']: _validate_recipe(value)
    allowed = {(path, kind) for path, kind, _ in COVERAGE[scope]}
    if scope == 'native-db': allowed.add(('zig/Dockerfile', 'cc'))
    if any((r['source']['path'], r['kind']) not in allowed for r in row['recipes']):
        raise ValueError('foreign compiler recipe Source/kind')
    for path, kind, minimum in COVERAGE[scope]:
        commands = {r['command_sha256'] for r in row['recipes'] if r['source']['path'] == path and r['kind'] == kind}
        if len(commands) < minimum: raise ValueError('incomplete actual compiler recipe coverage')
    return row


def profile_from_source(wire):
    if type(wire) is not bytes or not 0 < len(wire) <= 1024**2:
        raise ValueError('bounded admitted CPU procedure Source required')
    try: tree=ast.parse(wire)
    except (SyntaxError,ValueError) as error: raise ValueError('invalid CPU procedure Source') from error
    declarations=[]
    for node in tree.body:
        targets=node.targets if isinstance(node,ast.Assign) else [node.target] if isinstance(node,(ast.AnnAssign,ast.AugAssign)) else []
        imports=node.names if isinstance(node,(ast.Import,ast.ImportFrom)) else []
        if any(isinstance(target,ast.Name) and target.id=='PROFILE' for target in targets) or any((item.asname or item.name)=='PROFILE' for item in imports):
            declarations.append(node)
    if not declarations: return None  # Historical V1 publisher; never reinterpret it.
    if len(declarations)!=1 or not isinstance(declarations[0],ast.Assign) or len(declarations[0].targets)!=1 or not isinstance(declarations[0].targets[0],ast.Name) or not isinstance(declarations[0].value,ast.Constant) or declarations[0].value.value!=PROFILE:
        raise ValueError('admitted CPU procedure profile differs')
    return PROFILE


def required_flags(row):
    if row.get('schema') == 1: return row['flags']
    if row.get('schema') == 2:
        validate(row, row.get('scope'), row.get('mode'), row.get('source_commit'),
                 {name: item['sha256'] for name, item in row.get('artifacts', {}).items()})
        return list(REQUIRED_FLAGS)
    raise ValueError('actual CPU profile required')


def validate_recipe_sources(row, loader):
    """Join completed recipe pins to bytes from the admitted producer Source."""
    required_flags(row)
    if row['schema'] == 1: return row
    for value in row['recipes']:
        source = value['source']
        wire = loader(source['path'])
        if type(wire) is not bytes or len(wire) != source['bytes'] or hashlib.sha256(wire).hexdigest() != source['sha256']:
            raise ValueError('compiler recipe Source differs from admitted producer')
    return row


def require_same_profile(rows, require_portable=False):
    if not rows or any(type(row) is not dict for row in rows):
        raise ValueError('complete CPU receipt family required')
    if any(type(row.get('schema')) is not int for row in rows): raise ValueError('exact CPU schema integer required')
    schemas = {row.get('schema') for row in rows}
    if len(schemas) != 1 or schemas not in ({1}, {2}) or require_portable and schemas != {2}:
        raise ValueError('mixed or missing portable CPU contracts')
    for row in rows: required_flags(row)
    return PROFILE if schemas == {2} else None


def consumer_covers(rows, architecture, available_flags):
    return bool(rows) and all(row['architecture'] == architecture and set(required_flags(row) if row.get('schema') == 2 else row['flags']) <= set(available_flags) for row in rows)


def require_native_linux_host():
    # Native ABI inference must execute on the admitted Linux GNU publisher;
    # the explicit CPU remains fixed independently of host feature detection.
    if platform.system() != 'Linux' or platform.machine() != 'x86_64' or platform.libc_ver()[0] != 'glibc':
        raise ValueError('native ABI compiler requires Linux x86_64 GNU host')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--scope', required=True, choices=sorted(SCOPES))
    parser.add_argument('--mode', required=True, choices=['ReleaseSafe', 'ReleaseFast'])
    parser.add_argument('--git-sha', required=True)
    parser.add_argument('--artifact', action='append', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--profile', choices=[PROFILE])
    parser.add_argument('--recipe', type=Path, action='append', default=[])
    args = parser.parse_args()
    if platform.system() != 'Linux' or not (re.fullmatch('[0-9a-f]{40}', args.git_sha) or args.git_sha == 'VERGEN_IDEMPOTENT_OUTPUT'):
        raise ValueError('Linux and compiled source identity required')
    architecture = {'x86_64': 'amd64', 'aarch64': 'arm64'}.get(platform.machine())
    if architecture is None:
        raise ValueError('unsupported compiler architecture')
    if args.profile:
        require_native_linux_host()
    artifacts = {}
    for value in args.artifact:
        name, path = value.split('=', 1)
        path = Path(path)
        if name in artifacts or path.is_symlink() or not path.is_file():
            raise ValueError('duplicate or nonregular compiled artifact')
        with path.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        artifacts[name] = {'bytes': path.stat().st_size, 'sha256': digest}
    row = {'schema': 1, 'scope': args.scope, 'mode': args.mode, 'source_commit': args.git_sha,
           'architecture': architecture, 'flags': cpu_flags(Path('/proc/cpuinfo').read_text()), 'artifacts': artifacts}
    if args.profile:
        row = make_record(args.scope, args.mode, args.git_sha, architecture, row['flags'], artifacts, [json.loads(p.read_text()) for p in args.recipe])
    elif args.recipe:
        raise ValueError('recipe without portable profile')
    validate(row, args.scope, args.mode, args.git_sha, {name: value['sha256'] for name, value in artifacts.items()})
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('x') as stream:
        stream.write(json.dumps(row, indent=2) + '\n')


def run_main():
    parser = argparse.ArgumentParser(description='Execute one explicit portable compiler recipe')
    parser.add_argument('--kind', choices=sorted(KINDS), required=True)
    parser.add_argument('--recipe-source', required=True)
    parser.add_argument('--recipe-output', type=Path, required=True)
    parser.add_argument('--repo', type=Path, default=ROOT)
    parser.add_argument('--tokio-unstable', action='store_true')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args(sys.argv[2:])
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command or not args.recipe_output.is_absolute() or args.recipe_output.exists() or args.recipe_output.is_symlink():
        raise ValueError('actual compiler command and fresh absolute recipe output required')
    require_native_linux_host()
    environment = portable_environment(os.environ, args.tokio_unstable)
    pending = recipe(args.kind, command, environment, args.recipe_source, args.repo)
    # Same process group and inherited streams: existing outer ownership/deadline
    # remains authoritative. Never print compiler argv or the environment.
    result = subprocess.run(command, env=environment)
    if result.returncode:
        raise SystemExit(result.returncode if result.returncode > 0 else 128 - result.returncode)
    completed = finish_recipe(pending, {'actual_parent_wait': True, 'exit_code': result.returncode}, args.repo)
    args.recipe_output.parent.mkdir(parents=True, exist_ok=True)
    with args.recipe_output.open('x') as stream:
        stream.write(json.dumps(completed, indent=2) + '\n')


if __name__ == '__main__':
    run_main() if sys.argv[1:2] == ['run'] else main()
