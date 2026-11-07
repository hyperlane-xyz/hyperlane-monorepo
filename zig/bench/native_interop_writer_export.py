#!/usr/bin/env python3
"""Compile, never execute, the real native-row writer in the SDK fixture image."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import build_cpu
import native_http_tests
from native_payload_export import pin, validate_payload

ROOT = Path(__file__).resolve().parents[2]
ARCHIVES = {'libziggy_rocks_abi.a', 'librocksdb.a', 'libsnappy.a', 'liblz4.a', 'libzstd.a', 'libz.a', 'libbz2.a'}


def compile_plan(root, compiler, mode, jobs, libraries, binary):
    if mode not in {'ReleaseSafe', 'ReleaseFast'} or jobs not in {1, 2} or len(libraries) != 7 or {path.name for path in libraries} != ARCHIVES:
        raise ValueError('exact matching-mode seven-archive writer plan required')
    return [sys.executable, str(root / 'zig/tools/zig.py'), '--compiler', str(compiler),
            'build-exe', 'src/native_rows_interop_fixture.zig', '-O', mode, '-j' + str(jobs),
            '-lc', '-lstdc++', *map(str, libraries), '--cache-dir', '/tmp/writer-cache',
            '--global-cache-dir', '/tmp/writer-global', '-femit-bin=' + str(binary)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', required=True, choices=['ReleaseSafe', 'ReleaseFast'])
    parser.add_argument('--jobs', type=int, default=2)
    parser.add_argument('--git-sha', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if platform.system() != 'Linux' or os.environ.get('ZIG_NATIVE_TEST_MODE') != args.mode or re.fullmatch('[0-9a-f]{40}', args.git_sha) is None:
        raise ValueError('Linux matching image mode/commit required')
    baked = json.loads(Path('/opt/hyperlane-build-cpu/native-db.json').read_text())
    if baked['source_commit'] != args.git_sha or baked['mode'] != args.mode:
        raise ValueError('writer Source context differs from compiled fixture image')
    output = args.output.resolve(strict=True)
    if args.output.is_symlink() or list(output.iterdir()):
        raise ValueError('exclusive empty writer output mount required')
    architecture = {'x86_64': 'amd64', 'aarch64': 'arm64'}[platform.machine()]
    compiler = ROOT / f'zig/.toolchain/zig-{platform.machine()}-linux-0.15.2/zig'
    if compiler.is_symlink() or not compiler.is_file():
        raise ValueError('existing pinned compiler required; no bootstrap/download')
    manifest = json.loads(Path('/opt/hyperlane-native/manifest.json').read_text())
    libraries = [Path(value) for value in manifest['native_db_libs'].split(',')]
    if any(not path.resolve(strict=True).is_relative_to(Path('/opt/hyperlane-native')) for path in libraries):
        raise ValueError('native archives escaped fixture bundle')
    inputs = [compiler, *libraries, ROOT / 'zig/src/native_rows_interop_fixture.zig', ROOT / 'zig/tools/zig.py']
    before = [pin(path) for path in inputs]
    (output / 'bin').mkdir()
    binary = output / 'bin' / ('native-rows-writer-' + args.mode)
    argv = compile_plan(ROOT, compiler, args.mode, args.jobs, libraries, binary)
    result = {'schema': 1, 'passed': False, 'source_commit': args.git_sha, 'mode': args.mode,
              'argv': argv, 'input_before': before, 'writer_executed': False,
              'native_case_acceptance': False, 'component_interoperability_acceptance': False}
    try:
        code = native_http_tests.run_command(argv, ROOT, dict(os.environ, TMPDIR='/tmp'), 900, output / 'diagnostics')
        if code != 0:
            raise RuntimeError('writer compiler exited nonzero')
        descriptor = pin(binary)
        validate_payload(binary, descriptor['sha256'], architecture)
        descriptor['path'] = 'bin/' + binary.name
        binary.chmod(0o755)
        result['writer'] = descriptor
        result['cpu'] = {'architecture': architecture, 'flags': build_cpu.cpu_flags(Path('/proc/cpuinfo').read_text())}
        result['input_after'] = [pin(path) for path in inputs]
        if result['input_after'] != before:
            raise RuntimeError('writer compiler/Source/archives changed')
        result['passed'] = True
    finally:
        (output / 'manifest.json').write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    main()
