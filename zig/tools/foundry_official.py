#!/usr/bin/env python3
"""Fixed official Foundry 1.5.0 Linux installer. No updater, cache, or tool execution.

Only the installed, separately admitted gh executable performs Sigstore verification.
No Foundry program runs. The public-good trust root is exactly the released
foundryup 2.0.0 / sigstore-trust-root 0.11.0 production root.
"""
import argparse
import base64
import contextlib
import gzip
import hashlib
import io
import json
import math
import os
from pathlib import Path
import resource
import signal
import stat
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request

RELEASE_ID = 264689506
REPO_ID = 404320053
VERSION = 'v1.5.0'
NAMES = ('anvil', 'cast', 'chisel', 'forge')
SUBJECTS = {
    'anvil': ('9797b1e9bcdf65c9d6193470c94c2ee76' 'e5524af2985cfb5db7fc641ba216cfa'),
    'cast': ('9db0414588508e131bdb4aa4bf46c3dd5' '357482a2ae81c48ffeeb6801a4daa8d'),
    'chisel': ('ad6514593981d025d509c963cb279df3a2' 'e39b58a100a2c702b7ea6c253ca8ed'),
    'forge': ('d34f672dbeee3d6892b7e2640d0946a52' 'ca7b4fbfb095997fe0bf1c350e27cc1'),
}
ASSETS = {
    320137029: ('foundry_v1.5.0_linux_amd64.attestation.txt', 60,
                '53d652b3df1de950b0d4c4e6bf9498ad2' 'd15a6c11bf86704d5730c6a392cf679'),
    320137030: ('foundry_v1.5.0_linux_amd64.tar.gz', 80099301,
                '5cd98f9092bcc28be087939491f786b2bf' '3ed55e492996a409e29519b8ab4dc8'),
}
LINK = b'https://github.com/foundry-rs/foundry/attestations/13856257\n'
BUNDLE_SHA = ('f9554c4bc2a1d3887ee3784c9176bedba' 'e996943eafe0008435bd6f0d1a9bafd')
ROOT_SHA = ('6494e21ea73fa7ee769f85f57d5a3e6a08' '725eae1e38c755fc3517c9e6bc0b66')
IDENTITY = 'https://github.com/foundry-rs/foundry/.github/workflows/release.yml@refs/tags/v1.5.0'
ISSUER = 'https://token.actions.githubusercontent.com'
PREDICATE = 'https://slsa.dev/provenance/v1'
API = 'https://api.github.com/repos/foundry-rs/foundry'
HOSTS = frozenset({'api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'})
MIB = 1024 ** 2
HEADROOM = 128 * MIB
DISK_MAX = 512 * MIB
RSS_MAX = 1024 * MIB
OUTPUT_MAX = 256 * 1024
ROOT_NAME = 'ziggy-foundry-v1.5.0'


class Refused(RuntimeError):
    """Fixed public failure code; never interpolate external error text."""


class Interrupted(Refused):
    pass


def need(value, code):
    if not value:
        raise Refused(code)


def sha(wire):
    return hashlib.sha256(wire).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def decode(wire, maximum):
    need(type(wire) is bytes and len(wire) <= maximum, 'JSON_BYTE_BOUND')
    def pairs(rows):
        result = {}
        for key, value in rows:
            need(key not in result, 'JSON_DUPLICATE_KEY')
            result[key] = value
        return result
    value = json.loads(wire, object_pairs_hook=pairs,
                       parse_constant=lambda unused: (_ for _ in ()).throw(Refused('JSON_NONFINITE')))
    nodes = 0
    def visit(row, depth):
        nonlocal nodes
        nodes += 1
        need(depth <= 32 and nodes <= 100000, 'JSON_STRUCTURE_BOUND')
        if isinstance(row, float):
            need(math.isfinite(row), 'JSON_NONFINITE')
        elif isinstance(row, dict):
            for child in row.values():
                visit(child, depth + 1)
        elif isinstance(row, list):
            for child in row:
                visit(child, depth + 1)
    visit(value, 0)
    return value


def regular(path, maximum):
    before = path.lstat()
    need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= maximum,
         'REGULAR_SINGLE_LINK_BOUND')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd)
        need((opened.st_dev, opened.st_ino) == (before.st_dev, before.st_ino), 'READ_IDENTITY')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            wire = stream.read(maximum + 1)
        after = os.fstat(fd)
        named_after = path.lstat()
        need((named_after.st_dev, named_after.st_ino, named_after.st_size, named_after.st_mtime_ns, named_after.st_ctime_ns) ==
             (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns), 'READ_PATH_CHANGED')
        need((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
             (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) and
             len(wire) == before.st_size, 'READ_CHANGED')
        return wire
    finally:
        os.close(fd)


def descriptor(path, maximum=256 * MIB):
    wire = regular(path, maximum)
    return {'path': str(path), 'bytes': len(wire), 'sha256': sha(wire)}


class Budget:
    def __init__(self, directory):
        self.directory = directory
        self.started_ns = time.monotonic_ns()
        self.deadline_ns = self.started_ns + 300 * 10**9
        self.trace = []
        self.requests = 0
        self.child = None

    def check(self, extra=0):
        need(time.monotonic_ns() < self.deadline_ns, 'WHOLE_DEADLINE')
        fs = os.statvfs(self.directory)
        need(fs.f_bavail * fs.f_frsize >= HEADROOM + extra, 'REAL_FREE_HEADROOM')
        own = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        own = own if sys.platform == 'darwin' else own * 1024
        child_rss = 0
        if self.child is not None and sys.platform == 'linux':
            try:
                for row in Path(f'/proc/{self.child.pid}/status').read_text().splitlines():
                    if row.startswith('VmRSS:'):
                        child_rss = int(row.split()[1]) * 1024
            except FileNotFoundError:
                pass
        need(own + child_rss <= RSS_MAX, 'ONE_GIB_MANAGER_CHILD_RSS')

    @contextlib.contextmanager
    def alarm(self, seconds):
        self.check()
        old = signal.getsignal(signal.SIGALRM)
        need(signal.getitimer(signal.ITIMER_REAL) == (0.0, 0.0), 'NO_FOREIGN_TIMER')
        def expired(unused_signum, unused_frame):
            raise Interrupted('WHOLE_OR_REQUEST_DEADLINE')
        signal.signal(signal.SIGALRM, expired)
        remaining = min(seconds, (self.deadline_ns - time.monotonic_ns()) / 10**9)
        signal.setitimer(signal.ITIMER_REAL, max(0.000001, remaining))
        try:
            yield
            self.check()
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, old)


def official_url(url):
    parsed = urllib.parse.urlsplit(url)
    need(parsed.scheme == 'https' and parsed.hostname in HOSTS and parsed.port in (None, 443)
         and not parsed.username and not parsed.password and not parsed.fragment,
         'OFFICIAL_HTTPS_REDIRECT')
    return parsed.hostname


def public_quota(headers):
    result = {}
    if headers is None:
        return result
    for header, field in [('X-RateLimit-Limit', 'limit'), ('X-RateLimit-Remaining', 'remaining'),
                          ('X-RateLimit-Reset', 'reset'), ('Retry-After', 'retry_after_seconds')]:
        value = headers.get(header)
        if type(value) is str and 1 <= len(value) <= 16 and value.isascii() and value.isdigit():
            number = int(value)
            if number <= 2**53 - 1:
                result[field] = number
    return result


def download(url, maximum, budget, binary=False):
    need(url.startswith(API + '/'), 'FIXED_ORIGIN_ROUTE')
    budget.requests += 1
    need(budget.requests <= 4, 'REQUEST_COUNT')
    stages = {API + '/releases/' + str(RELEASE_ID): 'release_metadata',
              API + '/releases/assets/320137029': 'attestation_link',
              API + '/attestations/sha256:' + SUBJECTS['anvil']: 'signed_bundle',
              API + '/releases/assets/320137030': 'archive'}
    attempt = {'stage': stages.get(url, 'other_fixed_origin'), 'phase': 'request_open',
               'host': 'api.github.com', 'status': None, 'passed': False,
               'started_ns': time.monotonic_ns()}
    budget.trace.append(attempt)
    redirects = 0
    class Redirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, message, headers, newurl):
            nonlocal redirects
            redirects += 1
            need(redirects <= 4, 'REDIRECT_COUNT')
            attempt['phase'] = 'redirect_validation'
            host = official_url(newurl)
            attempt['host'] = host
            attempt['phase'] = 'request_open'
            budget.trace.append({'redirect_status': code, 'host': host})
            redirected = super().redirect_request(req, fp, code, message, headers, newurl)
            if redirected is not None:
                for mapping in (redirected.headers, redirected.unredirected_hdrs):
                    for header in tuple(mapping):
                        if header.lower() == 'authorization':
                            del mapping[header]
            return redirected
    # No proxy credentials, cookies or inherited authentication handlers.
    # The only optional credential is scoped to the exact initial API request below.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), Redirect())
    req = urllib.request.Request(url, headers={
        'Accept': 'application/octet-stream' if binary else 'application/vnd.github+json',
        'User-Agent': 'ziggy-foundry-fixed-official-installer', 'X-GitHub-Api-Version': '2022-11-28'})
    token = os.environ.get('FOUNDRY_GITHUB_TOKEN')
    if token is not None:
        need(url in stages, 'FIXED_AUTHENTICATED_API_ROUTE')
        need(type(token) is str and 1 <= len(token) <= 4096 and
             all(33 <= ord(character) <= 126 for character in token), 'INVALID_SCOPED_API_TOKEN')
        # urllib copies only normal headers on redirect. This is NEVER forwarded,
        # including same-origin redirects; no cookies/auth handler/proxy fallback.
        req.add_unredirected_header('Authorization', 'Bearer ' + token)
    body = bytearray()
    try:
        with budget.alarm(45 if binary else 20):
            with opener.open(req, timeout=10) as response:
                attempt['status'] = response.status if type(response.status) is int else None
                need(response.status == 200, 'HEALTHY_OFFICIAL_GET')
                host = official_url(response.url)
                attempt.update(host=host, phase='response_read')
                while True:
                    budget.check()
                    chunk = response.read(min(MIB, maximum + 1 - len(body)))
                    if not chunk:
                        break
                    body.extend(chunk)
                    need(len(body) <= maximum, 'DOWNLOAD_BYTE_BOUND')
        attempt.update(passed=True, phase='response_complete', bytes=len(body), sha256=sha(body))
        return bytes(body)
    except BaseException as error:
        attempt['error_class'] = type(error).__name__
        if isinstance(error, urllib.error.HTTPError):
            attempt['status'] = error.code if type(error.code) is int and 100 <= error.code <= 599 else None
            try:
                attempt['quota'] = public_quota(error.headers)
            except BaseException as projection_error:
                attempt['quota_error_class'] = type(projection_error).__name__
        raise
    finally:
        attempt['completed_ns'] = time.monotonic_ns()
        attempt['received_bytes'] = len(body)


def release_assets(wire):
    value = decode(wire, MIB)
    need(value['id'] == RELEASE_ID and type(value['id']) is int and value['tag_name'] == VERSION
         and value['draft'] is False and value['prerelease'] is False, 'FIXED_OFFICIAL_RELEASE')
    for asset_id, (name, size, digest) in ASSETS.items():
        rows = [row for row in value['assets'] if row.get('id') == asset_id]
        need(len(rows) == 1, 'UNIQUE_ASSET_METADATA')
        row = rows[0]
        need(type(row['id']) is int and row['name'] == name and type(row['size']) is int and
             row['size'] == size and row['digest'] == 'sha256:' + digest and row['state'] == 'uploaded'
             and row['url'] == API + '/releases/assets/' + str(asset_id), 'FIXED_ASSET_METADATA')
    return {'release_id': RELEASE_ID, 'tag': VERSION, 'metadata_bytes': len(wire), 'metadata_sha256': sha(wire)}


def attestations(link, wire):
    need(link == LINK and len(link) == ASSETS[320137029][1] and
         sha(link) == ASSETS[320137029][2], 'EXACT_ATTESTATION_LINK')
    value = decode(wire, 4 * MIB)
    need(type(value) is dict and set(value) == {'attestations'} and
         type(value['attestations']) is list and len(value['attestations']) <= 16, 'ATTESTATION_RESPONSE')
    matching = []
    for row in value['attestations']:
        need(type(row) is dict and type(row.get('repository_id')) is int and
             row['repository_id'] == REPO_ID and type(row.get('bundle')) is dict,
             'ATTESTATION_REPOSITORY')
        if sha(canonical(row['bundle'])) == BUNDLE_SHA:
            matching.append(row['bundle'])
    need(len(matching) == 1, 'UNIQUE_PINNED_SIGNED_BUNDLE')
    bundle = matching[0]
    envelope = bundle['dsseEnvelope']
    need(envelope['payloadType'] == 'application/vnd.in-toto+json' and
         type(envelope['signatures']) is list and len(envelope['signatures']) >= 1, 'DSSE_ENVELOPE')
    payload = base64.b64decode(envelope['payload'], validate=True)
    statement = decode(payload, MIB)
    need(statement['_type'] == 'https://in-toto.io/Statement/v1' and
         statement['predicateType'] == PREDICATE, 'SLSA_STATEMENT')
    subjects = statement['subject']
    need(type(subjects) is list and len(subjects) == 4 and all(
        type(row) is dict and set(row) == {'name', 'digest'} and row['name'] in SUBJECTS and
        row['digest'] == {'sha256': SUBJECTS[row['name']]} for row in subjects) and
        len({row['name'] for row in subjects}) == 4, 'EXACT_FOUR_SUBJECTS')
    return canonical(bundle) + b'\n'


def archive_members(wire, budget, write_root=None):
    # Inspect physical headers, not TarFile's transparent PAX/GNU expansion.
    need(len(wire) == ASSETS[320137030][1] and sha(wire) == ASSETS[320137030][2], 'WHOLE_ARCHIVE_DIGEST')
    seen = set()
    rows = []
    total = 0
    def exact(stream, size):
        result = stream.read(size)
        need(len(result) == size, 'TAR_TRUNCATED')
        return result
    with gzip.GzipFile(fileobj=io.BytesIO(wire)) as stream:
        while True:
            budget.check()
            header = exact(stream, 512)
            if header == bytes(512):
                need(exact(stream, 512) == bytes(512), 'TAR_END_MARKERS')
                tail_bytes = 0
                while True:
                    trailing = stream.read(MIB)
                    tail_bytes += len(trailing)
                    need(tail_bytes <= MIB, 'TAR_PADDING_BOUND')
                    budget.check()
                    if not trailing:
                        break
                    need(not any(trailing), 'TAR_TRAILING_DATA')
                break
            member = tarfile.TarInfo.frombuf(header, 'utf-8', 'strict')
            raw_name = header[:100].split(b'\0', 1)[0]
            need(member.type in (tarfile.REGTYPE, tarfile.AREGTYPE) and member.name in NAMES and
                 member.name not in seen and raw_name == member.name.encode() and
                 header[:100] == raw_name + bytes(100 - len(raw_name)) and
                 not header[345:500].strip(b'\0') and not member.linkname and
                 not member.mode & 0o7000 and not any(header[157:257]), 'EXACT_FOUR_REGULAR_TAR_MEMBERS')
            seen.add(member.name)
            total += member.size
            need(64 <= member.size <= 256 * MIB and total <= DISK_MAX - 4 * MIB, 'MEMBER_SIZE_BOUND')
            digest = hashlib.sha256()
            first = b''
            fd = None
            if write_root is not None:
                budget.check(member.size)
                fd = os.open(write_root / member.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            try:
                left = member.size
                while left:
                    budget.check()
                    chunk = exact(stream, min(MIB, left))
                    left -= len(chunk)
                    digest.update(chunk)
                    first = (first + chunk[:64])[:64]
                    if fd is not None:
                        rest = memoryview(chunk)
                        while rest:
                            amount = os.write(fd, rest)
                            need(amount > 0, 'WRITE_PROGRESS')
                            rest = rest[amount:]
                need(first[:7] == b'\x7fELF\x02\x01\x01' and
                     int.from_bytes(first[18:20], 'little') == 62, 'LINUX_X86_64_ELF')
                need(digest.hexdigest() == SUBJECTS[member.name], 'BINARY_SUBJECT_SHA256')
                if fd is not None:
                    os.fsync(fd)
            finally:
                if fd is not None:
                    os.close(fd)
            need(not any(exact(stream, (-member.size) % 512)), 'TAR_MEMBER_PADDING')
            rows.append({'name': member.name, 'bytes': member.size, 'sha256': digest.hexdigest(),
                         'elf_class': 64, 'elf_machine': 62})
    need(seen == set(NAMES), 'MISSING_FOUNDRY_BINARY')
    return rows, total


def exclusive(path, wire):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(wire)
            stream.flush()
            os.fsync(fd)
    finally:
        os.close(fd)


def verifier_command(gh, binary, bundle, root):
    return [str(gh), 'attestation', 'verify', str(binary), '--bundle', str(bundle),
            '--custom-trusted-root', str(root), '--repo', 'foundry-rs/foundry',
            '--cert-identity', IDENTITY, '--cert-oidc-issuer', ISSUER,
            '--predicate-type', PREDICATE, '--format', 'json']


def verified_output(wire):
    value = decode(wire, OUTPUT_MAX)
    need(type(value) is list and len(value) == 1 and
         set(value[0]) == {'attestation', 'verificationResult'}, 'SIGSTORE_JSON_RESULT')
    signed = value[0]['attestation']['bundle']
    need(sha(canonical(signed)) == BUNDLE_SHA, 'VERIFIED_SAME_SIGNED_BUNDLE')
    result = value[0]['verificationResult']
    certificate = result['signature']['certificate']
    need(certificate['subjectAlternativeName'] == IDENTITY and certificate['issuer'] == ISSUER and
         certificate['sourceRepositoryIdentifier'] == str(REPO_ID) and
         certificate['sourceRepositoryRef'] == 'refs/tags/v1.5.0' and
         certificate['sourceRepositoryURI'] == 'https://github.com/foundry-rs/foundry',
         'VERIFIED_EXACT_CERTIFICATE_POLICY')
    original = decode(base64.b64decode(signed['dsseEnvelope']['payload'], validate=True), MIB)
    need(result['statement'] == original and original['predicateType'] == PREDICATE,
         'VERIFIED_SAME_STATEMENT')
    return 1


def verify_one(gh, binary, bundle, root, work, budget, records):
    row = {'name': binary.name, 'start_ns': time.monotonic_ns(), 'actual_wait_observed': False,
           'exit_code': None, 'forced_cleanup': False}
    records.append(row)
    out, err = work / (binary.name + '.stdout'), work / (binary.name + '.stderr')
    child = None
    primary = None
    def limits():
        resource.setrlimit(resource.RLIMIT_FSIZE, (OUTPUT_MAX, OUTPUT_MAX))
        resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    env = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C', 'GH_CONFIG_DIR': str(work / 'gh-config'),
           'XDG_CONFIG_HOME': str(work / 'config'), 'XDG_CACHE_HOME': str(work / 'cache'),
           'TMPDIR': str(work / 'tmp'), 'GH_PROMPT_DISABLED': '1', 'GH_NO_UPDATE_NOTIFIER': '1',
           'GH_NO_EXTENSION_UPDATE_NOTIFIER': '1'}
    try:
        budget.check()
        with out.open('xb') as stdout, err.open('xb') as stderr:
            child = subprocess.Popen(verifier_command(gh, binary, bundle, root), stdin=subprocess.DEVNULL,
                                     stdout=stdout, stderr=stderr, env=env, close_fds=True, preexec_fn=limits)
            budget.child = child
            row['pid'] = child.pid
            call_deadline = min(budget.deadline_ns, time.monotonic_ns() + 45 * 10**9)
            while True:
                budget.check()
                need(time.monotonic_ns() < call_deadline, 'VERIFIER_DEADLINE')
                try:
                    code = child.wait(timeout=min(0.1, (call_deadline - time.monotonic_ns()) / 10**9))
                    row.update(actual_wait_observed=True, exit_code=code)
                    break
                except subprocess.TimeoutExpired:
                    continue
        budget.check()
        need(time.monotonic_ns() < call_deadline and code == 0, 'SIGSTORE_VERIFIER_OUTCOME')
        row['verified_attestations'] = verified_output(regular(out, OUTPUT_MAX))
    except BaseException as error:
        primary = error
    finally:
        if child is not None and not row['actual_wait_observed']:
            try:
                if child.poll() is None:
                    child.kill()
                    row['forced_cleanup'] = True
            except BaseException as error:
                row['signal_error_class'] = type(error).__name__
            try:
                row.update(exit_code=child.wait(timeout=5), actual_wait_observed=True)
            except BaseException as error:
                row['wait_error_class'] = type(error).__name__
        budget.child = None
        row['end_ns'] = time.monotonic_ns()
        for key, path in [('stdout', out), ('stderr', err)]:
            if path.exists():
                try:
                    wire = regular(path, OUTPUT_MAX)
                    row[key] = {'bytes': len(wire), 'sha256': sha(wire)}
                except BaseException as evidence_error:
                    row[key + '_error_class'] = type(evidence_error).__name__
                    if primary is None:
                        primary = evidence_error
    if primary is not None:
        raise primary


def activate(pending, destination, members, records, budget):
    need(len(records) == 4 and {row['name'] for row in records} == set(NAMES) and all(
        row['actual_wait_observed'] is True and row['exit_code'] == 0 and
        row.get('verified_attestations') == 1 and not row['forced_cleanup'] for row in records),
        'FOUR_ACTUAL_SIGNATURE_VERIFICATIONS')
    need(not destination.exists() and not destination.is_symlink(), 'FRESH_BIN_DESTINATION')
    for row in members:
        binary = pending / row['name']
        value = descriptor(binary)
        need(value['bytes'] == row['bytes'] and value['sha256'] == row['sha256'], 'PREACTIVATION_BINARY_HASH')
    budget.check()
    for name in NAMES:
        os.chmod(pending / name, 0o755, follow_symlinks=False)
    os.rename(pending, destination)
    fd = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def cleanup_created(root, identity):
    """Only an exclusively created private root, never a pre-existing destination."""
    current = root.lstat()
    need((current.st_dev, current.st_ino, current.st_uid) == identity and
         stat.S_ISDIR(current.st_mode), 'CLEANUP_ROOT_IDENTITY')
    # Every directory is private0700; no followed links and no recursive rmtree.
    for directory, subdirs, files in os.walk(root, topdown=False, followlinks=False):
        base = Path(directory)
        for name in files:
            leaf = base / name
            need(stat.S_ISREG(leaf.lstat().st_mode) and leaf.lstat().st_nlink == 1, 'CLEANUP_REGULAR_ONLY')
            leaf.unlink()
        for name in subdirs:
            leaf = base / name
            need(stat.S_ISDIR(leaf.lstat().st_mode), 'CLEANUP_DIRECTORY_ONLY')
            leaf.rmdir()
    root.rmdir()


def install(runner_temp, gh):
    need(sys.platform == 'linux' and os.uname().machine == 'x86_64', 'FIXED_LINUX_X86_64')
    runner_temp = Path(runner_temp)
    need(runner_temp.is_absolute() and runner_temp.resolve() == runner_temp and
         runner_temp.is_dir() and not runner_temp.is_symlink() and
         runner_temp.stat().st_uid == os.getuid(), 'RUNNER_TEMP_CANONICAL_OWNED')
    gh = Path(gh)
    need(gh.is_absolute() and gh.resolve() == gh and os.access(gh, os.X_OK), 'ADMITTED_GH_PATH')
    gh_pin = descriptor(gh)
    script = Path(__file__).resolve()
    script_pin = descriptor(script, MIB)
    root_data = script.with_name('foundry_public_good_root.json')
    raw_root = regular(root_data, MIB)
    need(sha(raw_root) == ROOT_SHA, 'UPDATER_EXACT_PRODUCTION_ROOT')
    # Fail on any pre-existing stable output; never reuse or modify it.
    root = runner_temp / ROOT_NAME
    root.mkdir(mode=0o700)
    st = root.stat()
    identity = (st.st_dev, st.st_ino, st.st_uid)
    records = []
    report = {'schema': 1, 'kind': 'foundry-official-fixed-linux-install', 'passed': False,
              'version': VERSION, 'foundry_executed': False, 'activated': False,
              'sigstore_verifier': gh_pin, 'installer_source': script_pin, 'commands': records}
    budget = Budget(root)
    report['transport'] = budget.trace
    try:
        pending, work = root / 'bin.pending', root / 'verification'
        pending.mkdir(mode=0o700)
        work.mkdir(mode=0o700)
        for name in ('gh-config', 'config', 'cache', 'tmp'):
            (work / name).mkdir(mode=0o700)
        trust = work / 'public-good-root.jsonl'
        exclusive(trust, canonical(decode(raw_root, MIB)) + b'\n')
        report['public_good_root'] = {'source_sha256': sha(raw_root), 'verifier_sha256': descriptor(trust)['sha256']}
        report['release'] = release_assets(download(API + '/releases/' + str(RELEASE_ID), MIB, budget))
        link = download(API + '/releases/assets/320137029', 60, budget, True)
        response = download(API + '/attestations/sha256:' + SUBJECTS['anvil'], 4 * MIB, budget)
        bundle = work / 'signed-bundle.jsonl'
        exclusive(bundle, attestations(link, response))
        report['signed_bundle_canonical_sha256'] = BUNDLE_SHA
        wire = download(API + '/releases/assets/320137030', ASSETS[320137030][1], budget, True)
        members, total = archive_members(wire, budget)
        budget.check(total)
        archive_members(wire, budget, pending)
        report['archive'] = {'asset_id': 320137030, 'bytes': len(wire), 'sha256': sha(wire)}
        del wire
        report['members'] = members
        for name in NAMES:
            verify_one(gh, pending / name, bundle, trust, work, budget, records)
        need(descriptor(gh) == gh_pin and descriptor(script, MIB) == script_pin and
             sha(regular(root_data, MIB)) == ROOT_SHA,
             'VERIFIER_AND_ROOT_UNCHANGED')
        need(sha(regular(bundle, 4 * MIB).rstrip(b'\n')) == BUNDLE_SHA, 'BUNDLE_UNCHANGED')
        activate(pending, root / 'bin', members, records, budget)
        budget.check()
        report.update(passed=True, activated=True, bin=str(root / 'bin'),
                      completed_ns=time.monotonic_ns(), execution_deadline_ns=budget.deadline_ns,
                      transport=budget.trace)
        exclusive(root / 'result.json', json.dumps(report, sort_keys=True, indent=2).encode() + b'\n')
        budget.check()
        return report
    except BaseException as error:
        report['error_class'] = type(error).__name__
        report['failure_code'] = str(error) if isinstance(error, Refused) else 'EXTERNAL_FAILURE'
        try:
            cleanup_created(root, identity)
            report['owned_absent'] = True
        except BaseException as cleanup_error:
            report['cleanup_error_class'] = type(cleanup_error).__name__
            report['owned_absent'] = False
        # No external error text, argv, environment, response body, URL query, or header.
        print(json.dumps(report, sort_keys=True))
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runner-temp', required=True)
    parser.add_argument('--gh', required=True, help='actual canonical preinstalled GitHub CLI')
    args = parser.parse_args()
    def cancelled(unused_signum, unused_frame):
        raise Interrupted('TASK_CANCELLED')
    signal.signal(signal.SIGTERM, cancelled)
    signal.signal(signal.SIGINT, cancelled)
    try:
        value = install(args.runner_temp, args.gh)
        print(json.dumps({'passed': True, 'bin': value['bin'], 'report': str(Path(value['bin']).parent / 'result.json')}))
        return 0
    except BaseException as error:
        # Do not serialize urllib/subprocess exception messages.
        print(json.dumps({'passed': False, 'error_class': type(error).__name__}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
