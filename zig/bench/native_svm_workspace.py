"""Ordinary CI tool provisioning only; never builds or starts a native case."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import struct
import subprocess
import time
import tomllib
import types

VERSION = '1.98.0'
CARGO = Path('/home/runner/.rustup/toolchains/1.98.0-x86_64-unknown-linux-gnu/bin/cargo')
RUSTUP = Path('/home/runner/.cargo/bin/rustup')
GIB = 1024 ** 3


def need(ok, message):
    if not ok: raise ValueError(message)


def pin(path):
    path = Path(path)
    row = path.lstat()
    need(path.is_absolute() and path.resolve(strict=True) == path and stat.S_ISREG(row.st_mode) and row.st_nlink == 1, 'Canonical regular input required')
    with path.open('rb') as stream: digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    return {'path': str(path), 'bytes': row.st_size, 'sha256': digest}


def checked(row):
    need(type(row) is dict and set(row) == {'path', 'bytes', 'sha256'}, 'Exact input descriptor required')
    path = Path(row['path']); need(pin(path) == row, 'Input changed'); return path


def member(base, relative):
    relative = Path(relative)
    need(not relative.is_absolute() and '..' not in relative.parts, 'Closed relative member required')
    path = base
    for part in relative.parts:
        path = path / part; need(not path.is_symlink(), 'Member alias forbidden')
    pin(path); return path


def request_module():
    # Reuse the checkout's bounded public-digest decoder and full validator.
    # Execute captured Source directly, without selecting cached bytecode.
    path = Path(__file__).with_name('native_case_ci.py').resolve(strict=True)
    raw = path.read_bytes(); module = types.ModuleType('svm_workspace_request')
    module.__file__ = str(path); exec(compile(raw, str(path), 'exec'), module.__dict__)
    return module


def baked_cargo(path):
    """Read/hash the actual producer ELF; never execute it or change its mode."""
    before = pin(path); need(64 <= before['bytes'] <= 256 * 1024 ** 2, 'Bounded construction ELF required')
    matches = set(); overlap = b''
    with path.open('rb') as stream:
        header = stream.read(20)
        need(header[:7] == b'\x7fELF\x02\x01\x01' and struct.unpack_from('<H', header, 18)[0] == 62, 'Linux amd64 construction ELF required')
        stream.seek(0)
        while chunk := stream.read(1024 * 1024):
            data = overlap + chunk
            matches.update(m.group().decode('ascii') for m in re.finditer(rb'/home/runner/\.rustup/toolchains/[A-Za-z0-9_.-]+/bin/cargo', data))
            overlap = data[-512:]
    need(matches == {str(CARGO)} and pin(path) == before, 'Exact single producer-baked Cargo1.98 path required')
    return before


def inputs(request_path, request_sha, receipt_path, receipt_sha, repo, execution_sha):
    request_pin = pin(request_path); need(request_pin['sha256'] == request_sha, 'Reviewed request changed')
    dispatch = request_module(); request = dispatch.read_request(request_path)
    need(type(request.get('root_approved')) is bool and type(request.get('schema')) is int and request['schema'] == 1, 'Typed request authority required')
    if not request['root_approved'] or request.get('scenario') not in {'sealevel', 'sealevel-composite', 'evm', 'cosmwasm'}: return None
    dispatch.validate_request(request)
    receipt_pin = pin(receipt_path); need(receipt_pin['sha256'] == receipt_sha, 'Producer receipt changed')
    receipt = json.loads(receipt_path.read_text())
    need(receipt['passed'] is True and receipt['all_owned_jobs_joined'] is True and receipt['request'] == request_pin and receipt['execution_source_commit'] == execution_sha and receipt['producer_source_commit'] == request['producer_source_commit'], 'Actual matching producer download required')
    helper = receipt['artifacts']['helper']; need(helper['remote'] == request['artifact_pins']['helper'], 'Exact helper archive policy required')
    archive = checked(helper['archive']); need(archive.stat().st_size == helper['remote']['size_in_bytes'] and pin(archive)['sha256'] == helper['remote']['sha256'], 'Helper archive transport differs')
    base = Path(helper['directory']).resolve(strict=True); result_path = member(base, 'result.json'); result = json.loads(result_path.read_text())
    need(result['passed'] is True and result['source_unchanged'] is True and result['source_commit'] == request['producer_source_commit'], 'Actual coherent helper build required')
    product = result['products']['construction']; need(product['artifact_relative_path'] == 'products/construction', 'Fixed helper construction member required')
    actual = member(base, product['artifact_relative_path']); actual_pin = baked_cargo(actual)
    need(all(actual_pin[k] == product['published'][k] == product['producer'][k] for k in ('bytes', 'sha256')), 'Actual construction product differs')
    files = {row['relative_path']: row for row in helper['files']}
    for name, path in [('result.json', result_path), ('products/construction', actual), ('setup/tools-platform.txt', member(base, 'setup/tools-platform.txt'))]:
        need(name in files and all(pin(path)[key] == files[name][key] for key in ('bytes', 'sha256')), 'Actual extracted helper member differs')
    platform_path = member(base, 'setup/tools-platform.txt'); need(platform_path.stat().st_size <= 2 * 1024 ** 2, 'Bounded producer platform record required')
    versions = [line for line in platform_path.read_text().splitlines() if line.startswith('cargo ')]
    need(len(versions) == 1 and re.fullmatch(r'cargo 1\.98\.0 \([0-9a-f]{9,40} [0-9]{4}-[0-9]{2}-[0-9]{2}\)', versions[0]), 'Exact producer Cargo version required')
    cwd = repo / 'rust/main/utils/run-locally'; need(cwd.resolve(strict=True) == cwd, 'Exact Source harness cwd required')
    manifest = repo / 'rust/main/Cargo.toml'; pin(manifest)
    return {'request': request_pin, 'request_decoder_source': pin(Path(dispatch.__file__)), 'producer_receipt': receipt_pin, 'construction': actual_pin, 'helper_result': pin(result_path), 'producer_platform': pin(platform_path), 'producer_cargo_version': versions[0], 'cwd': str(cwd), 'workspace_manifest': str(manifest), 'baked_cargo_path': str(CARGO)}


def locator(raw, expected):
    need(raw == (str(expected) + '\n').encode(), 'Original Source workspace locator differs')


def default_toolchain():
    path = Path('/home/runner/.rustup/settings.toml')
    if not path.exists(): return None
    need(pin(path)['bytes'] <= 65536, 'Bounded ordinary Rustup settings required')
    value = tomllib.loads(path.read_text()).get('default_toolchain')
    need(value is None or type(value) is str and re.fullmatch('[A-Za-z0-9_.-]{1,128}', value), 'Typed public default toolchain required')
    return value


def main():
    parser = argparse.ArgumentParser()
    for name in ('request', 'producer-receipt', 'repo', 'output'): parser.add_argument('--' + name, type=Path, required=True)
    for name in ('request-sha256', 'producer-receipt-sha256', 'execution-source-commit'): parser.add_argument('--' + name, required=True)
    parser.add_argument('--execute', action='store_true'); args = parser.parse_args()
    need(args.execute, 'Ordinary CI provision requires explicit execution')
    bound = inputs(args.request, args.request_sha256, args.producer_receipt, args.producer_receipt_sha256, args.repo, args.execution_source_commit)
    if bound is None: print(json.dumps({'enabled': False, 'native_case_acceptance': False})); return
    need(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('GITHUB_SHA') == args.execution_source_commit and os.getuid() > 0, 'Ordinary unprivileged CI only')
    need(args.output.parent.resolve(strict=True) == args.output.parent and not args.output.exists(), 'New ordinary prerequisite receipt required')
    rustup_pin = pin(RUSTUP); need(os.access(RUSTUP, os.X_OK), 'Actual fixed rustup executable required')
    started = time.monotonic_ns(); deadline = started + 270 * 10 ** 9; free_before = shutil.disk_usage(args.output.parent).free; original_default = default_toolchain()
    env = {'PATH': '/usr/bin:/bin:/home/runner/.cargo/bin', 'LC_ALL': 'C.UTF-8', 'HOME': '/home/runner', 'RUSTUP_HOME': '/home/runner/.rustup', 'CARGO_HOME': '/home/runner/.cargo', 'RUSTUP_NO_UPDATE_CHECK': '1'}
    result = {'schema': 1, 'kind': 'ordinary-native-baked-Cargo-prerequisite', 'passed': False, 'binding': bound, 'rustup': rustup_pin, 'commands': [], 'native_case_acceptance': False, 'helper_or_SDK_rebuilt': False, 'original_deadline_monotonic_ns': deadline, 'actual_future_case_environment_checked': False}
    def run(name, argv, maximum_seconds, child_env):
        remaining = (deadline - time.monotonic_ns()) / 10 ** 9
        need(remaining > 0 and shutil.disk_usage(args.output.parent).free >= 6 * GIB, 'Original prerequisite deadline/free6GiB floor')
        call = subprocess.run(argv, cwd=bound['cwd'], env=child_env, capture_output=True, timeout=min(maximum_seconds, remaining), check=False)
        need(len(call.stdout) + len(call.stderr) <= 1024 ** 2, 'Bounded ordinary tool output required')
        result['commands'].append({'name': name, 'argv': argv, 'exit_code': call.returncode, 'actual_direct_command_return': True, 'stdout_bytes': len(call.stdout), 'stderr_bytes': len(call.stderr), 'output_sha256': hashlib.sha256(call.stdout + call.stderr).hexdigest(), 'daemon_or_case_wait_credit': False})
        need(call.returncode == 0 and time.monotonic_ns() < deadline and shutil.disk_usage(args.output.parent).free >= 6 * GIB and free_before - shutil.disk_usage(args.output.parent).free <= 2 * GIB, 'Ordinary prerequisite command/time/disk failed')
        return call.stdout
    try:
        need(free_before >= 8 * GIB, 'Conservative toolchain staging margin required')
        run('install-exact-producer-toolchain', [str(RUSTUP), 'toolchain', 'install', VERSION, '--profile', 'minimal', '--no-self-update'], 240, env)
        cargo_pin = pin(CARGO); need(os.access(CARGO, os.X_OK), 'Exact baked Cargo is not executable')
        version = run('actual-baked-cargo-version', [str(CARGO), '--version'], 10, env)
        need(version == (bound['producer_cargo_version'] + '\n').encode(), 'Actual Cargo differs from producer version')
        # Clean env and exact original cwd/argv; future case env is bound later.
        clean_home = args.output.with_suffix('.home'); clean_home.mkdir(mode=0o700)
        case_env = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C.UTF-8', 'HOME': str(clean_home), 'TMPDIR': str(clean_home), 'CI': 'true', 'E2E_CI_MODE': 'true'}
        raw = run('original-readonly-workspace-locator', [str(CARGO), 'locate-project', '--workspace', '--message-format=plain'], 10, case_env)
        locator(raw, bound['workspace_manifest'])
        need(pin(CARGO) == cargo_pin and pin(RUSTUP) == rustup_pin, 'Provisioned tools changed')
        need(default_toolchain() == original_default, 'Original Rustup default toolchain changed')
        for key in ('request', 'request_decoder_source', 'producer_receipt', 'construction', 'helper_result', 'producer_platform'): checked(bound[key])
        need(time.monotonic_ns() < deadline, 'Original prerequisite deadline before publication')
        result.update(passed=True, cargo=cargo_pin, actual_cargo_version=version.decode().strip(), original_locator_workspace=bound['workspace_manifest'], locator_environment_keys=sorted(case_env), default_toolchain_unchanged=True, default_toolchain=original_default)
    except BaseException as error: result['error_type'] = type(error).__name__
    finally:
        result['finished_monotonic_ns'] = time.monotonic_ns()
        with args.output.open('x') as stream: json.dump(result, stream, indent=2); stream.write('\n')
    need(result['passed'], 'Ordinary exact Cargo prerequisite failed')


if __name__ == '__main__': main()
