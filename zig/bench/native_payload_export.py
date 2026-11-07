#!/usr/bin/env python3
"""Export only the exact nine tested Linux runtime payloads; never start an image."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import time
import signal
import tarfile
import tempfile
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import build_cpu

FILES = {
    'relayer': ('bin/relayer', '/opt/hyperlane/bin/relayer'),
    'validator': ('bin/validator', '/opt/hyperlane/bin/validator'),
    'scraper': ('bin/scraper', '/opt/hyperlane/bin/scraper'),
    'hyperlane-aleo-vm-worker': ('bin/hyperlane-aleo-vm-worker', '/opt/hyperlane/bin/hyperlane-aleo-vm-worker'),
    **{name: ('lib/' + name, '/opt/hyperlane/lib/' + name) for name in [
        'libziggy_url.so', 'libziggy_regex.so', 'libziggy_starknet_crypto.so',
        'libziggy_aleo_crypto.so', 'libziggy_aleo_vm.so']},
}


def pin(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError('regular non-symlink payload required')
    with path.open('rb') as stream:
        sha = hashlib.file_digest(stream, 'sha256').hexdigest()
    return {'path': str(path), 'bytes': path.stat().st_size, 'sha256': sha}


def validate_receipts(native, runtime, mode):
    if native.get('passed') is not True or runtime.get('passed') is not True or (type(native.get('exit_code')) is not int or native.get('exit_code') != 0) or native.get('mode') != mode:
        raise ValueError('successful actual matching-mode native suite/runtime receipts required')
    expected = native.get('artifact_sha256')
    if not isinstance(expected, dict) or set(expected) != set(FILES) or runtime.get('artifact_sha256') != expected:
        raise ValueError('tested/runtime nine-payload identities differ')
    if any(not isinstance(value, str) or re.fullmatch('[0-9a-f]{64}', value) is None for value in expected.values()):
        raise ValueError('invalid payload identity')
    return expected


def validate_payload(path, expected_sha, architecture):
    row = pin(path)
    with path.open('rb') as stream:
        header = stream.read(20)
    if len(header) != 20 or header[:6] != b'\x7fELF\x02\x01' or int.from_bytes(header[18:20], 'little') != {'amd64': 62, 'arm64': 183}[architecture]:
        raise ValueError('payload is not the approved native Linux64 ELF platform')
    if row['sha256'] != expected_sha:
        raise ValueError('payload differs from actually tested bytes')
    return row


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--image', required=True)
    p.add_argument('--mode', choices=['ReleaseSafe', 'ReleaseFast'], required=True)
    p.add_argument('--git-sha', required=True)
    p.add_argument('--native', type=Path, required=True)
    p.add_argument('--runtime', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--docker', type=Path, default=Path('/usr/bin/docker'))
    args = p.parse_args()
    if re.fullmatch('[0-9a-f]{40}', args.git_sha) is None or not args.output.is_absolute() or args.output.exists() or args.output.is_symlink():
        raise ValueError('exact commit and exclusive absolute output required')
    native_pin, runtime_pin = pin(args.native), pin(args.runtime)
    expected = validate_receipts(json.loads(args.native.read_text()), json.loads(args.runtime.read_text()), args.mode)
    if shutil.disk_usage(args.output.parent).free < 6 * 1024**3:
        raise RuntimeError('6GiB export floor')
    args.output.mkdir(mode=0o700)
    receipts = args.output / 'receipts'
    receipts.mkdir()
    for source, name, receipt_expected in [(args.native, 'native.json', native_pin), (args.runtime, 'runtime.json', runtime_pin)]:
        shutil.copyfile(source, receipts / name)
        if pin(source) != receipt_expected or pin(receipts / name)['sha256'] != receipt_expected['sha256']:
            raise RuntimeError('receipt changed during export preparation')
    native_pin['path'] = 'receipts/native.json'
    runtime_pin['path'] = 'receipts/runtime.json'
    config = args.output / 'docker-config'
    config.mkdir(mode=0o700)
    env = {'PATH': '/usr/bin:/bin', 'HOME': str(args.output)}
    base = [str(args.docker), '--host', 'unix:///var/run/docker.sock', '--config', str(config)]
    deadline = time.monotonic() + 120
    cleanup_deadline = deadline + 30
    cleaning = False
    calls = []
    class ExportInterrupted(RuntimeError):
        pass
    def interrupted(signum, frame):
        raise ExportInterrupted(f'export interrupted by signal {signum}')
    watched = {sig:signal.getsignal(sig) for sig in (signal.SIGINT,signal.SIGTERM,signal.SIGHUP)}
    for sig in watched:
        signal.signal(sig, interrupted)
    def call(arguments, okay=(0,), archive=False):
        # Docker's fixed builtin commands do not launch shell/plugin children.
        # File capture bounds output during execution; no unbounded PIPE read.
        active_deadline = cleanup_deadline if cleaning else deadline
        process = None
        code = None
        waited = False
        error = None
        limit = 2 * 1024**3 if archive else 2 * 1024**2
        stdout = tempfile.NamedTemporaryFile(dir=args.output, prefix="capture-", delete=False)
        stderr = tempfile.TemporaryFile(dir=args.output)
        try:
            process = subprocess.Popen(base + arguments, env=env, stdin=subprocess.DEVNULL,
                                       stdout=stdout, stderr=stderr)
            while True:
                if time.monotonic() >= active_deadline or stdout.tell() > limit:
                    raise RuntimeError("original export deadline/output bound")
                # Child writes through another file description: use fstat.
                if os.fstat(stdout.fileno()).st_size > limit or os.fstat(stderr.fileno()).st_size > 2 * 1024**2 or shutil.disk_usage(args.output).free < 6 * 1024**3:
                    raise RuntimeError("export output/free-space guard")
                code = process.poll()
                if code is not None:
                    break
                time.sleep(.05)
            if code not in okay:
                raise RuntimeError("bounded Docker export command failed")
        except BaseException as failure:
            error = failure
        finally:
            if process is not None:
                if process.returncode is None:
                    process.kill()
                code = process.wait(timeout=2)
                waited = True
            calls.append({'arguments': arguments, 'pid': None if process is None else process.pid,
                          'exit_code': code, 'actual_parent_wait': waited,
                          'error': None if error is None else type(error).__name__})
            if os.fstat(stdout.fileno()).st_size > limit or os.fstat(stderr.fileno()).st_size > 2 * 1024**2:
                error = error or RuntimeError('final export output cap')
            stdout.close()
            stderr.seek(0)
            detail = stderr.read(2 * 1024**2)
            stderr.close()
        capture = Path(stdout.name)
        if error is not None:
            capture.unlink(missing_ok=True)
            raise error
        if archive:
            return capture
        data = capture.read_bytes()
        capture.unlink()
        return subprocess.CompletedProcess(base + arguments, code, data, detail)
    image = json.loads(call(['image', 'inspect', args.image]).stdout)
    if len(image) != 1 or image[0]['Os'] != 'linux' or image[0]['Architecture'] not in ['amd64', 'arm64']:
        raise RuntimeError('native Linux runtime image required')
    image_id, architecture = image[0]['Id'], image[0]['Architecture']
    runtime_receipt = json.loads(args.runtime.read_text())
    if runtime_receipt.get('image_id_chunks') != [image_id.removeprefix('sha256:')[:32], image_id.removeprefix('sha256:')[32:]] or runtime_receipt.get('architecture') != architecture:
        raise RuntimeError('inspected image differs from actually tested runtime receipt')
    if re.fullmatch('sha256:[0-9a-f]{64}', image_id) is None:
        raise RuntimeError('immutable imageId required')
    token = secrets.token_hex(16)
    name = 'ziggy-native-payload-' + token
    labels = {'io.hyperlane.ziggy.component': 'native-payload-export', 'io.hyperlane.ziggy.run-token': token, 'io.hyperlane.ziggy.source-commit': args.git_sha}
    cid = None
    create_attempted = False
    primary = None
    result = {'schema': 1, 'passed': False, 'source_commit': args.git_sha, 'mode': args.mode, 'platform': 'linux/' + architecture, 'inputs': {'native': native_pin, 'runtime': runtime_pin}, 'artifacts': {}, 'native_case_acceptance': False, 'image_started_by_exporter': False}
    def inspect(target):
        rows = json.loads(call(['container', 'inspect', target]).stdout)
        if len(rows) != 1:
            raise RuntimeError('one exact export container required')
        return rows[0]
    def owned(row):
        return (cid is None or row['Id'] == cid) and re.fullmatch('[0-9a-f]{64}', row['Id']) is not None and row['Image'] == image_id and row['Name'] == '/' + name and all(row['Config']['Labels'].get(key) == value for key, value in labels.items())
    def copy_member(source, destination, cap):
        archive = call(['cp', cid + ':' + source, '-'], archive=True)
        try:
            with tarfile.open(archive, mode='r:') as contents:
                members = []
                for member in contents:
                    members.append(member)
                    if len(members) > 1:
                        raise ValueError('one exact regular exported payload required')
                if len(members) != 1 or not members[0].isfile() or members[0].issparse() or members[0].name != destination.name or members[0].size > cap:
                    raise ValueError('unsafe export member/type/size')
                member = members[0]
                # Verify data padding AND all bytes after the sole member. This
                # rejects a second archive hidden after the first TAR EOF.
                end = member.offset_data + member.size
                with archive.open('rb') as raw:
                    raw.seek(end)
                    tail_size = archive.stat().st_size - end
                    if tail_size < 1024 or archive.stat().st_size % 512:
                        raise ValueError('missing closed TAR terminator')
                    while block := raw.read(65536):
                        if any(block):
                            raise ValueError('nonzero padding/concatenated export archive')
                with contents.extractfile(member) as reader, destination.open('xb') as writer:
                    shutil.copyfileobj(reader, writer, length=1024*1024)
        finally:
            archive.unlink(missing_ok=True)

    try:
        missing = call(['container', 'inspect', name], okay=(1,))
        if b'no such' not in missing.stderr.lower() and b'not found' not in missing.stderr.lower():
            raise RuntimeError('fresh export name absence not proved')
        (args.output / 'intent.json').write_text(json.dumps({'name': name, 'image_id': image_id, 'labels': labels}) + '\n')
        argv = ['create', '--pull=never', '--name', name, '--network', 'none', '--read-only', '--entrypoint', '/bin/true']
        for key, value in labels.items():
            argv += ['--label', key + '=' + value]
        # create never invokes an image entrypoint. The immutable Id avoids retag races.
        create_attempted = True
        candidate = call(argv + [image_id]).stdout.decode().strip()
        if re.fullmatch('[0-9a-f]{64}', candidate) is None:
            raise RuntimeError('exact created CID required')
        cid = candidate
        for name_key, (relative, source) in FILES.items():
            row = inspect(cid)
            if not owned(row) or row['State']['Running']:
                raise RuntimeError('export ownership changed or unexpected image start')
            destination = args.output / 'payload' / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            copy_member(source, destination, 2 * 1024**3 - sum(value['bytes'] for value in result['artifacts'].values()))
            descriptor = validate_payload(destination, expected[name_key], architecture)
            destination.chmod(0o755 if relative.startswith('bin/') else 0o644)
            descriptor['path'] = 'payload/' + relative
            result['artifacts'][name_key] = descriptor
            if sum(value['bytes'] for value in result['artifacts'].values()) > 2 * 1024**3:
                raise RuntimeError('2GiB payload cap')
        provenance = {}
        required_flags = set()
        for scope in sorted(build_cpu.SCOPES):
            destination = args.output / 'build-cpu' / (scope + '.json')
            destination.parent.mkdir(exist_ok=True)
            copy_member('/opt/hyperlane/share/build-cpu/' + scope + '.json', destination, 4 * 1024**2)
            row = build_cpu.validate(json.loads(destination.read_text()), scope, args.mode, args.git_sha, expected)
            if row['architecture'] != architecture or any(row['artifacts'][name]['bytes'] != result['artifacts'][name]['bytes'] for name in build_cpu.SCOPES[scope]):
                raise RuntimeError('baked compiled bytes/platform differ')
            descriptor = pin(destination)
            descriptor['path'] = 'build-cpu/' + destination.name
            provenance[scope] = descriptor
            required_flags.update(row['flags'])
        result['build_provenance'] = provenance
        result['required_cpu_flags'] = sorted(required_flags)
        result['consumer_cpu_superset_required'] = True
        result['image_id'] = image_id
        if time.monotonic() >= deadline:
            raise RuntimeError('export completed beyond original deadline')
        result['passed'] = True
    except BaseException as error:
        primary = error
        result['error'] = type(error).__name__
    finally:
        cleaning = True
        for sig in watched:
            signal.signal(sig, signal.SIG_IGN)
        # A failed create may still have created its exact labelled container.
        # A random-name collision is never authority to remove a foreign CID.
        if create_attempted and cid is None:
            try:
                found = call(['container', 'inspect', name], okay=(0, 1))
                if found.returncode == 0:
                    rows = json.loads(found.stdout)
                    if len(rows) != 1 or not owned(rows[0]):
                        raise RuntimeError('failed-create foreign identity remains untouched')
                    cid = rows[0]['Id']
            except BaseException as error:
                result['cleanup_error'] = type(error).__name__
                if primary is None:
                    primary = error
        if cid is not None:
            try:
                if not owned(inspect(cid)):
                    raise RuntimeError('no authority to remove changed export CID')
                call(['container', 'rm', '--force', cid])
                absent = call(['container', 'inspect', cid], okay=(1,))
                if b'no such' not in absent.stderr.lower() and b'not found' not in absent.stderr.lower():
                    raise RuntimeError('exact export CID absence not proved')
                result['exact_created_CID_removed'] = True
            except BaseException as error:
                result['passed'] = False
                result['cleanup_error'] = type(error).__name__
                if primary is None:
                    primary = error
        result['calls'] = calls
        (args.output / 'manifest.json').write_text(json.dumps(result, indent=2) + '\n')
        for sig, handler in watched.items():
            signal.signal(sig, handler)
    if primary is not None:
        raise primary


if __name__ == '__main__':
    main()
