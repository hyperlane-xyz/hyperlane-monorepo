#!/usr/bin/env python3
"""Closed test312 diagnostic; no acceptance, builds of SDKs, or runtime changes."""
from pathlib import Path
import argparse
import ctypes
import gzip
import hashlib
import importlib.util
import io
import json
import os
import platform
import resource
import signal
import stat
import subprocess
import sys
import tempfile
import threading

TARGET = 'zig/src/metadata_parallel_delegated_tests.zig'
PAYLOAD = 'zig/tools/fixtures/native_http_312_diagnostic.zig.gz'
BEFORE_SHA = ('a2ba8412a9b0e961b76d8054764503c7'
              'fa181f7c9ffb4d780d20e15aa8767cb2')
AFTER_SHA = ('79f43abc40fba7df4f829eeabf156027'
              '8f8a18dab61b356b527243888ed4e139')
PAYLOAD_SHA = ('43d695278d7a0e8f8008cdfc13f0af6f'
              '99b8374337bf0530ccd0d5b9352d7b73')
FILTER = 'native Pool yields eight stalled peers and verifies healthy EVM children three times'
MARKER = '[zig-native-http-diagnostic]'
ONLY_MARKER = '[zig-native-http-diagnostic-only]'
FULL_MARKER = '[zig-native-http-full-suite]'
ENV_MARKER = '[zig-native-http-ordinary-env]'
CHILD_ENV_KEYS = ('PATH', 'HOME', 'RUNNER_TEMP', 'ZIG', 'LC_ALL', 'HYPERLANE_ZIG_SDKROOT')
REF = 'refs/heads/feat/zig-agent-rewrite'
LOG_LIMIT = 8 * 1024 * 1024


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def regular(path):
    require(path.is_file() and not path.is_symlink(), 'Regular nonsymlink input required')
    return path.read_bytes()


def authorized(name, ref, event):
    message = event.get('head_commit', {}).get('message', '')
    if not (name == 'push' and ref == REF and isinstance(message, str)
            and '[zig-native-case]' not in message and '[zig-svm-prerequisites-only]' not in message):
        return False
    dual = ONLY_MARKER in message and '[zig-paired-linux]' in message
    # An inherited request cannot fall back through any older marker.
    if ENV_MARKER in message:
        return FULL_MARKER in message and dual
    # A malformed full-suite request cannot fall back to the old filtered route.
    if FULL_MARKER in message:
        return dual
    return MARKER in message or dual


def selected_profile(name, ref, event):
    require(authorized(name, ref, event), 'Explicit feature push diagnostic marker required')
    message = event['head_commit']['message']
    if ENV_MARKER in message:
        return 'ordered-full-suite-inherited-env'
    return 'ordered-full-suite' if FULL_MARKER in message else 'filtered'


def profile_limits(profile):
    if profile == 'filtered':
        return {'inner': 300, 'outer': 340}
    require(profile in ('ordered-full-suite', 'ordered-full-suite-inherited-env'), 'One fixed diagnostic profile required')
    return {'inner': 1200, 'outer': 1240}


def child_environment(profile, environ):
    profile_limits(profile)
    if profile == 'ordered-full-suite-inherited-env':
        return dict(environ)
    return {key: environ[key] for key in CHILD_ENV_KEYS if key in environ}


def environment_policy(profile):
    profile_limits(profile)
    if profile == 'ordered-full-suite-inherited-env':
        return {'kind': 'inherited-copy', 'ordinary_wrapper_policy_match': True,
                'actual_cross_run_environment_equivalence': False}
    return {'kind': 'explicit-allowlist', 'allowed_keys': list(CHILD_ENV_KEYS),
            'ambient_equivalence_to_ordinary_suite': False}


def profile_command(repo, output, profile):
    limits = profile_limits(profile)
    command = [sys.executable, str(repo / 'zig/tools/native_http_tests.py'), '--timeout-seconds', str(limits['inner']), '--diagnostic-dir', str(output / 'inner-owner'), '--', sys.executable, str(repo / 'zig/tools/zig.py'), 'test', 'src/root.zig']
    if profile == 'filtered':
        command += ['--test-filter', FILTER]
    command += ['-j2', '-OReleaseSafe', '-lc']
    return command


def payload(repo):
    compressed = regular(repo / PAYLOAD)
    require(len(compressed) <= 131072 and digest(compressed) == PAYLOAD_SHA, 'Diagnostic payload changed')
    with gzip.GzipFile(fileobj=io.BytesIO(compressed)) as stream:
        data = stream.read(131073)
    require(len(data) <= 131072 and digest(data) == AFTER_SHA, 'Diagnostic Source changed/oversized')
    return data


def atomic_write(path, data, mode):
    pending = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.native312-', delete=False) as stream:
            pending = Path(stream.name)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
            os.fchmod(stream.fileno(), mode)
        os.replace(pending, path)
        pending = None
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if pending is not None:
            pending.unlink()


class Overlay:
    def __init__(self, target, output, before_sha, replacement):
        require(target.is_absolute() and '..' not in target.parts and all(not p.is_symlink() for p in [target, *target.parents]), 'Canonical Source custody required')
        self.target, self.output = target, output
        self.before = regular(target)
        require(digest(self.before) == before_sha, 'Original Source hash differs; no mutation')
        self.mode = stat.S_IMODE(target.stat().st_mode)
        self.before_sha, self.after_sha = before_sha, digest(replacement)
        self.replacement, self.applied = replacement, False

    def apply(self):
        with (self.output / 'source.before').open('xb') as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(self.before)
            stream.flush()
            os.fsync(stream.fileno())
        directory = os.open(self.output, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        require(all(not p.is_symlink() for p in [self.target, *self.target.parents]), 'Source custody changed before apply')
        require(digest(regular(self.target)) == self.before_sha, 'Original Source changed before apply')
        # Mark before mutation: even an exception after replace must restore.
        self.applied = True
        atomic_write(self.target, self.replacement, self.mode)
        require(digest(regular(self.target)) == self.after_sha, 'Overlay readback differs')

    def restore(self, consumers_absent):
        require(consumers_absent, 'Consumers absence unproven: preserve backup and defer restore')
        require(all(not p.is_symlink() for p in [self.target, *self.target.parents]), 'Source custody changed before restore')
        require(digest(regular(self.output / 'source.before')) == self.before_sha, 'Original snapshot changed')
        require(digest(regular(self.target)) in {self.before_sha, self.after_sha}, 'Unknown Source mutation: preserve custody')
        atomic_write(self.target, self.before, self.mode)
        require(regular(self.target) == self.before and stat.S_IMODE(self.target.stat().st_mode) == self.mode, 'Source restoration differs')
        self.applied = False


def cleanup_proven(output):
    try:
        result = json.loads(regular(output / 'outer-owner/result.json'))
        monitor = json.loads(regular(output / 'outer-owner/monitor-parent.json'))
        if not isinstance(result, dict) or not isinstance(monitor, dict):
            return False
        rows = [result.get('cleanup'), monitor.get('cleanup')]
        return all(isinstance(row, dict) and row.get('actual_parent_wait') is True
                   and row.get('cleanup_confirmed_absent') is True and row.get('clean') is True
                   for row in rows)
    except (ValueError, KeyError, OSError):
        return False


class BoundedLog:
    """Drain every child byte; retain <=8MiB and interrupt owned command on overflow."""
    def __init__(self, path):
        self.path, self.overflow, self.failure, self.retained = path, False, None, 0

    def __enter__(self):
        self.read_fd, write_fd = os.pipe()
        self.saved = [os.dup(1), os.dup(2)]
        self.stream = self.path.open('xb')
        os.dup2(write_fd, 1)
        os.dup2(write_fd, 2)
        os.close(write_fd)
        self.thread = threading.Thread(target=self.drain, daemon=True)
        self.thread.start()
        return self

    def drain(self):
        try:
            while True:
                block = os.read(self.read_fd, 65536)
                if not block:
                    break
                keep = block[:max(0, LOG_LIMIT - self.retained)]
                self.stream.write(keep)
                self.retained += len(keep)
                if len(keep) != len(block) and not self.overflow:
                    self.overflow = True
                    os.kill(os.getpid(), signal.SIGTERM)
        except BaseException as error:
            self.failure = type(error).__name__
            os.kill(os.getpid(), signal.SIGTERM)

    def __exit__(self, *unused):
        # Qualified owner must finish and close all inherited writers first.
        for fd, saved in zip([1, 2], self.saved):
            os.dup2(saved, fd)
            os.close(saved)
        self.thread.join(timeout=5)
        require(not self.thread.is_alive(), 'Diagnostic log writer remains; cleanup incomplete')
        os.close(self.read_fd)
        self.stream.flush()
        os.fsync(self.stream.fileno())
        self.stream.close()
        require(not self.overflow and self.failure is None, 'Diagnostic log exceeded bound or drain failed')


def source_inventory(repo):
    files = sorted((repo / 'zig/src').rglob('*')) + sorted((repo / 'vectors').rglob('*'))
    files += [repo / value for value in ['zig/build.zig', 'zig/tools/zig.py', 'zig/tools/bootstrap.py', 'zig/tools/native_http_tests.py', 'zig/bench/cold_matrix_owner.py']]
    rows = {}
    for path in files:
        require(not path.is_symlink(), 'Source inventory symlink rejected')
        if path.is_file():
            wire = regular(path)
            rows[str(path.relative_to(repo))] = {'bytes': len(wire), 'sha256': digest(wire)}
    return rows


def diagnostic(repo, output, replacement, execute, inventory=None):
    """Pure injectable execution seam; production main supplies only closed argv."""
    overlay = Overlay(repo / TARGET, output, BEFORE_SHA, replacement)
    result = {'schema': 1, 'diagnostic_only': True, 'native_acceptance': False, 'timing_acceptance': False,
              'before_sha256': BEFORE_SHA, 'compiled_source_sha256': AFTER_SHA,
              'strict_bounds_changed': False, 'source_restored': False, 'command_exit_code': None}
    entered = False
    original = inventory() if inventory is not None else None
    if original is not None:
        (output / 'source-original.json').write_text(json.dumps(original, sort_keys=True) + '\n')
    try:
        overlay.apply()
        if inventory is not None:
            compiled = inventory()
            require(set(compiled) == set(original) and [p for p in compiled if compiled[p] != original[p]] == [TARGET], 'Only the reviewed test overlay may differ')
            (output / 'source-compiled.json').write_text(json.dumps(compiled, sort_keys=True) + '\n')
        entered = True
        result['command_exit_code'] = execute()
    except BaseException as error:
        result['diagnostic_error'] = {'type': type(error).__name__, 'message': str(error)}
    finally:
        handlers = {sig: signal.signal(sig, signal.SIG_IGN) for sig in [signal.SIGTERM, signal.SIGINT, signal.SIGHUP]}
        try:
            result['owned_consumers_absent'] = not entered or cleanup_proven(output)
            result['execution_released'] = entered
            if not result['owned_consumers_absent']:
                result['cleanup_ambiguity'] = 'Missing, malformed, wrong-shaped or unproven command/monitor cleanup receipts; no absence credit.'
            if overlay.applied:
                try:
                    overlay.restore(result['owned_consumers_absent'])
                    result['source_restored'] = True
                except BaseException as error:
                    result['restoration_error'] = {'type': type(error).__name__, 'message': str(error)}
            try:
                result['source_after_sha256'] = digest(regular(repo / TARGET))
                if inventory is not None:
                    restored = inventory()
                    (output / 'source-restored.json').write_text(json.dumps(restored, sort_keys=True) + '\n')
                    require(restored == original, 'Original compiled inputs changed after restoration')
                    result['all_original_inputs_restored'] = True
            except BaseException as error:
                result['source_restored'] = False
                result['source_readback_error'] = {'type': type(error).__name__, 'message': str(error)}
            result['interpretation'] = ('Isolated pass: cause unknown; possible order dependence, no fix or suite acceptance.'
                                        if result['command_exit_code'] == 0 else 'Diagnostic failure; classify public bounded events before proposing a fix.')
            (output / 'summary.json').write_text(json.dumps(result, indent=2) + '\n')
        finally:
            for sig, handler in handlers.items():
                signal.signal(sig, handler)
    return result


def public_context(repo, profile):
    executable = Path(os.environ['ZIG'])
    require(executable.is_absolute() and executable.is_file() and not executable.is_symlink(), 'Existing pinned Zig executable required')
    version = subprocess.run([str(executable), 'version'], cwd=repo, env={'PATH': '/usr/bin:/bin'}, capture_output=True, timeout=5, check=True)
    require(version.stdout == b'0.15.2\n' and len(version.stderr) < 4096, 'Pinned Zig0.15.2 required')
    with executable.open('rb') as stream:
        compiler_sha = hashlib.file_digest(stream, 'sha256').hexdigest()
    library = ctypes.CDLL('libcurl.so.4')
    library.curl_version.restype = ctypes.c_char_p
    curl_version = library.curl_version()
    require(curl_version is not None and len(curl_version) <= 1024, 'Bounded native curl version required')
    return {'system': platform.system(), 'machine': platform.machine(), 'allowed_cpu_count': len(os.sched_getaffinity(0)),
            'RLIMIT_NOFILE': list(resource.getrlimit(resource.RLIMIT_NOFILE)),
            'compiler_sha256': compiler_sha, 'compiler_version': '0.15.2', 'curl_version': curl_version.decode('ascii'),
            'command_timeouts_seconds': profile_limits(profile), 'original_suite_unchanged': True,
            'execution_profile': profile,
            'child_environment_policy': environment_policy(profile)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    require(sys.platform == 'linux' and platform.machine() in {'x86_64', 'AMD64'}, 'Native Linux x86_64 diagnostic only')
    repo = Path(__file__).resolve().parents[2]
    event_path = Path(os.environ['GITHUB_EVENT_PATH'])
    require(event_path.stat().st_size <= 1024 * 1024, 'Bounded CI event required')
    event = json.loads(regular(event_path))
    profile = selected_profile(os.environ.get('GITHUB_EVENT_NAME'), os.environ.get('GITHUB_REF'), event)
    sha = os.environ.get('GITHUB_SHA', '')
    require(len(sha) == 40 and all(c in '0123456789abcdef' for c in sha) and event.get('after') == sha and event.get('head_commit', {}).get('id') == sha, 'Exact push Source commit required')
    head = subprocess.run(['/usr/bin/git', 'rev-parse', 'HEAD'], cwd=repo, env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}, capture_output=True, timeout=3, check=True)
    require(head.stdout.decode().strip() == sha, 'Actual checkout differs from event commit')
    output = args.output
    temp = Path(os.environ['RUNNER_TEMP']).resolve(strict=True)
    require(output.is_absolute() and '..' not in output.parts and output.parent == temp and not output.exists() and not output.is_symlink(), 'Exclusive runner-temp output required')
    replacement = payload(repo)
    output.mkdir(mode=0o700)
    specification = importlib.util.spec_from_file_location('native312_owned', repo / 'zig/tools/native_http_tests.py')
    owner = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(owner)
    limits = profile_limits(profile)
    command = profile_command(repo, output, profile)
    env = child_environment(profile, os.environ)
    context = public_context(repo, profile)
    (output / 'context.json').write_text(json.dumps(context, indent=2) + '\n')
    log = BoundedLog(output / 'diagnostic.log')
    def execute():
        with log:
            return owner.run_command(command, repo, env, limits['outer'], output / 'outer-owner')
    def interrupted(signum, frame):
        raise RuntimeError('Diagnostic runner interrupted ' + str(signum))
    handlers = {sig: signal.signal(sig, interrupted) for sig in [signal.SIGTERM, signal.SIGINT, signal.SIGHUP]}
    try:
        result = diagnostic(repo, output, replacement, execute, lambda: source_inventory(repo))
    finally:
        for sig, handler in handlers.items():
            signal.signal(sig, handler)
    result.update({'git_commit': sha, 'compiled_inputs_scope': 'Recorded zig/src, vectors and named compiler/owner inputs with only pinned test312 overlay; no SDK/native input claim.', 'target_filter': FILTER if profile == 'filtered' else None, 'execution_profile': profile,
                   'command_timeouts_seconds': limits, 'full_suite_or_fix_acceptance': False,
                   'child_environment_policy': context['child_environment_policy'], 'log_bytes': log.retained, 'log_overflow': log.overflow, 'log_error': log.failure, 'runtime_acceptance': False})
    if profile != 'filtered':
        result['interpretation'] = ('Ordered full-suite command exited zero under the Source overlay; cause remains unknown; restoration and ownership require their separate qualified fields.'
                                    if result['command_exit_code'] == 0 else 'Ordered full-suite diagnostic failed; classify retained bounded observations before proposing a fix.')
    (output / 'summary.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({key: result[key] for key in ['diagnostic_only', 'git_commit', 'command_exit_code', 'source_restored', 'owned_consumers_absent', 'runtime_acceptance']}))
    return 0 if result['source_restored'] and result['owned_consumers_absent'] and result['command_exit_code'] == 0 and 'diagnostic_error' not in result else 1


if __name__ == '__main__':
    raise SystemExit(main())
