"""Pure controls. No network, real child, Foundry, Docker, build, or activation outside tempfiles."""
import base64
import gzip
import io
import json
from pathlib import Path
import stat
import sys
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch

HERE = Path(__file__).parent
m = types.ModuleType('tested_foundry_official')
m.__file__ = str(HERE / 'foundry_official.py')
exec(compile(Path(m.__file__).read_bytes(), m.__file__, 'exec'), m.__dict__)


def audit(event, args):
    if event in {'subprocess.Popen', 'os.system', 'socket.__new__', 'socket.connect', 'socket.bind',
                 'ctypes.dlopen', 'os.kill', 'os.killpg', 'os.fork', 'os.posix_spawn'}:
        raise AssertionError('Forbidden test effect: ' + event)


class Budget:
    deadline_ns = 10**30
    child = None
    def check(self, extra=0):
        pass


def elf(machine=62):
    value = bytearray(128)
    value[:7] = b'\x7fELF\x02\x01\x01'
    value[18:20] = machine.to_bytes(2, 'little')
    return bytes(value)


def archive(entries=None):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w', format=tarfile.USTAR_FORMAT) as tar:
        for name, data, kind in (entries if entries is not None else [(name, elf(), tarfile.REGTYPE) for name in m.NAMES]):
            member = tarfile.TarInfo(name)
            member.size = len(data) if kind == tarfile.REGTYPE else 0
            member.type = kind
            member.mode = 0o755
            if kind == tarfile.SYMTYPE:
                member.linkname = 'elsewhere'
            tar.addfile(member, io.BytesIO(data))
    return gzip.compress(stream.getvalue(), mtime=0)


def synthetic_subjects():
    return {name: m.sha(elf()) for name in m.NAMES}


def assets_for(wire):
    result = dict(m.ASSETS)
    result[320137030] = (m.ASSETS[320137030][0], len(wire), m.sha(wire))
    return result


def release():
    return {'id': m.RELEASE_ID, 'tag_name': m.VERSION, 'draft': False, 'prerelease': False,
            'assets': [{'id': key, 'name': row[0], 'size': row[1], 'digest': 'sha256:' + row[2],
                        'state': 'uploaded', 'url': m.API + '/releases/assets/' + str(key)}
                       for key, row in m.ASSETS.items()]}


def bundle():
    statement = {'_type': 'https://in-toto.io/Statement/v1', 'predicateType': m.PREDICATE,
                 'subject': [{'name': name, 'digest': {'sha256': value}} for name, value in m.SUBJECTS.items()]}
    return {'dsseEnvelope': {'payloadType': 'application/vnd.in-toto+json',
                            'payload': base64.b64encode(m.canonical(statement)).decode(),
                            'signatures': [{'sig': 'fixed-control-not-a-real-signature'}]},
            'verificationMaterial': {'certificate': 'control'}}


def response(value):
    return {'attestations': [{'repository_id': m.REPO_ID, 'bundle': value}]}


def verified_response():
    signed = bundle()
    certificate = {'subjectAlternativeName': m.IDENTITY, 'issuer': m.ISSUER,
                   'sourceRepositoryIdentifier': str(m.REPO_ID), 'sourceRepositoryRef': 'refs/tags/v1.5.0',
                   'sourceRepositoryURI': 'https://github.com/foundry-rs/foundry'}
    return [{'attestation': {'bundle': signed}, 'verificationResult': {
        'signature': {'certificate': certificate},
        'statement': json.loads(base64.b64decode(signed['dsseEnvelope']['payload']))}}]


def records():
    return [{'name': name, 'actual_wait_observed': True, 'exit_code': 0,
             'forced_cleanup': False, 'verified_attestations': 1} for name in m.NAMES]


class Parser(unittest.TestCase):
    def test_duplicate_nonfinite_depth_and_byte_bounds(self):
        for wire in [b'{"a":1,"a":2}', b'{"n":1e999}', b'{"n":NaN}', b'[' * 34 + b'0' + b']' * 34]:
            with self.subTest(wire=wire[:20]), self.assertRaises(m.Refused):
                m.decode(wire, 1000)
        with self.assertRaises(m.Refused):
            m.decode(b'{}', 1)
        self.assertEqual(m.decode(b'{"n":1.5}', 20), {'n': 1.5})

    def test_release_exact_two_assets(self):
        self.assertEqual(m.release_assets(m.canonical(release()))['release_id'], m.RELEASE_ID)
        for field, value in [('id', 1), ('size', True), ('name', 'foreign'), ('digest', 'sha256:wrong'), ('url', 'https://foreign.invalid')]:
            row = release()
            row['assets'][0][field] = value
            with self.subTest(field=field), self.assertRaises(m.Refused):
                m.release_assets(m.canonical(row))
        row = release()
        row['assets'].append(row['assets'][0])
        with self.assertRaises(m.Refused):
            m.release_assets(m.canonical(row))

    def test_fixed_release_not_tag_or_latest_alias(self):
        for key, value in [('id', 9), ('tag_name', 'latest'), ('draft', True), ('prerelease', True)]:
            row = release()
            row[key] = value
            with self.subTest(key=key), self.assertRaises(m.Refused):
                m.release_assets(m.canonical(row))

    def test_same_bundle_semantics_and_unique_record(self):
        value = bundle()
        with patch.object(m, 'BUNDLE_SHA', m.sha(m.canonical(value))):
            out = m.attestations(m.LINK, m.canonical(response(value)))
            self.assertEqual(json.loads(out), value)
            duplicate = response(value)
            duplicate['attestations'] *= 2
            with self.assertRaises(m.Refused):
                m.attestations(m.LINK, m.canonical(duplicate))
            with self.assertRaises(m.Refused):
                m.attestations(m.LINK.replace(b'13856257', b'13856258'), m.canonical(response(value)))
            wrong = response(value)
            wrong['attestations'][0]['repository_id'] = 1
            with self.assertRaises(m.Refused):
                m.attestations(m.LINK, m.canonical(wrong))

    def test_pinned_bundle_cannot_swap_cert_signature_payload(self):
        value = bundle()
        with patch.object(m, 'BUNDLE_SHA', m.sha(m.canonical(value))):
            value['verificationMaterial']['certificate'] = 'other-cert'
            with self.assertRaises(m.Refused):
                m.attestations(m.LINK, m.canonical(response(value)))

    def test_subject_four_names_hashes_and_slsa_required(self):
        for mutation in ('missing', 'duplicate', 'hash', 'predicate'):
            value = bundle()
            payload = json.loads(base64.b64decode(value['dsseEnvelope']['payload']))
            if mutation == 'missing':
                payload['subject'].pop()
            elif mutation == 'duplicate':
                payload['subject'][0] = payload['subject'][1]
            elif mutation == 'hash':
                payload['subject'][0]['digest']['sha256'] = 'wrong'
            else:
                payload['predicateType'] = 'other'
            value['dsseEnvelope']['payload'] = base64.b64encode(m.canonical(payload)).decode()
            with self.subTest(mutation=mutation), patch.object(m, 'BUNDLE_SHA', m.sha(m.canonical(value))), self.assertRaises(m.Refused):
                m.attestations(m.LINK, m.canonical(response(value)))

    def test_redirect_exact_https_hosts_no_credentials(self):
        for url in ['http://api.github.com/x', 'https://api.github.com.foreign.invalid/x',
                    'https://user:password@github.com/x', 'https://github.com:444/x', 'https://github.com/x#fragment']:
            with self.subTest(url=url), self.assertRaises(m.Refused):
                m.official_url(url)
        self.assertEqual(m.official_url('https://release-assets.githubusercontent.com/a?fixed=1'),
                         'release-assets.githubusercontent.com')

    def test_root_data_actual_released_updater_pin(self):
        raw = (HERE / 'foundry_public_good_root.json').read_bytes()
        self.assertEqual(m.sha(raw), m.ROOT_SHA)
        self.assertTrue(json.loads(raw)['certificateAuthorities'])


class Transport(unittest.TestCase):
    def test_download_closed_bounds_noauth_and_404_no_fallback(self):
        class ReadBudget(Budget):
            requests = 0
            trace = []
            from contextlib import nullcontext
            def alarm(self, seconds):
                return self.nullcontext()
        class Response:
            status = 200
            url = m.API + '/fixed'
            def __init__(self, body):
                self.body = io.BytesIO(body)
            def read(self, amount):
                return self.body.read(amount)
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass
        from unittest.mock import Mock
        opened = Mock(return_value=Response(b'fixed'))
        with patch.object(m.urllib.request, 'build_opener', return_value=types.SimpleNamespace(open=opened)):
            self.assertEqual(m.download(m.API + '/fixed', 5, ReadBudget()), b'fixed')
        request = opened.call_args.args[0]
        self.assertNotIn('Authorization', request.headers)
        with patch.object(m.urllib.request, 'build_opener', return_value=types.SimpleNamespace(open=lambda *a, **k: Response(b'oversize'))), self.assertRaises(m.Refused):
            m.download(m.API + '/fixed', 3, ReadBudget())
        original = m.urllib.error.HTTPError(m.API + '/fixed', 404, 'Not Found', {}, None)
        opened = Mock(side_effect=original)
        with patch.object(m.urllib.request, 'build_opener', return_value=types.SimpleNamespace(open=opened)), self.assertRaises(m.urllib.error.HTTPError) as caught:
            m.download(m.API + '/fixed', 5, ReadBudget())
        self.assertIs(caught.exception, original)
        original.close()
        opened.assert_called_once()

    def test_failed_open_exact_stage_status_quota_and_no_raw_details(self):
        from unittest.mock import Mock
        class ReadBudget(Budget):
            requests = 0
            from contextlib import nullcontext
            def __init__(self):
                self.trace = []
            def alarm(self, seconds):
                return self.nullcontext()
        marker = 'PRIVATE_URL_BODY_HEADER_MARKER'
        original = m.urllib.error.HTTPError('https://foreign.invalid/' + marker, 403, marker,
                    {'X-RateLimit-Limit': '60', 'X-RateLimit-Remaining': '0',
                     'X-RateLimit-Reset': '1794137000', 'Retry-After': '12',
                     'Authorization': marker, 'Location': marker}, None)
        budget = ReadBudget()
        try:
            with patch.object(m.urllib.request, 'build_opener', return_value=types.SimpleNamespace(open=Mock(side_effect=original))), self.assertRaises(m.urllib.error.HTTPError) as caught:
                m.download(m.API + '/releases/' + str(m.RELEASE_ID), m.MIB, budget)
            self.assertIs(caught.exception, original)
            row = budget.trace[0]
            self.assertEqual(row['stage'], 'release_metadata')
            self.assertEqual(row['host'], 'api.github.com')
            self.assertEqual(row['phase'], 'request_open')
            self.assertEqual(row['status'], 403)
            self.assertEqual(row['quota'], {'limit': 60, 'remaining': 0, 'reset': 1794137000, 'retry_after_seconds': 12})
            self.assertEqual(row['error_class'], 'HTTPError')
            self.assertFalse(row['passed'])
            self.assertEqual(row['received_bytes'], 0)
            self.assertNotIn(marker, json.dumps(budget.trace))
        finally:
            original.close()

    def test_failed_response_read_records_admitted_host_and_status(self):
        class ReadBudget(Budget):
            requests = 0
            from contextlib import nullcontext
            def __init__(self):
                self.trace = []
            def alarm(self, seconds):
                return self.nullcontext()
        primary = TimeoutError('PRIVATE_ERROR_QUERY_ENV_MARKER')
        class Response:
            status = 200
            url = 'https://release-assets.githubusercontent.com/fixed?PRIVATE_QUERY_MARKER'
            def read(self, amount):
                raise primary
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass
        budget = ReadBudget()
        with patch.object(m.urllib.request, 'build_opener', return_value=types.SimpleNamespace(open=lambda *a, **k: Response())), self.assertRaises(TimeoutError) as caught:
            m.download(m.API + '/releases/assets/320137029', 60, budget, True)
        self.assertIs(caught.exception, primary)
        row = budget.trace[0]
        self.assertEqual((row['stage'], row['phase'], row['host'], row['status']),
                         ('attestation_link', 'response_read', 'release-assets.githubusercontent.com', 200))
        self.assertNotIn('PRIVATE', json.dumps(budget.trace))

    def test_quota_allowlist_numeric_bounds_only_and_projection_cannot_mask(self):
        for value in ['1e999', '-1', '2.5', '9' * 17, '9007199254740992', '９', 'Wed, 21 Oct', 'https://PRIVATE.invalid']:
            self.assertEqual(m.public_quota({'X-RateLimit-Limit': value, 'Other': 'PRIVATE'}), {})
        class BadHeaders:
            def get(self, name):
                raise RuntimeError('PRIVATE_METADATA_FAILURE')
        class ReadBudget(Budget):
            requests = 0
            trace = []
            from contextlib import nullcontext
            def alarm(self, seconds):
                return self.nullcontext()
        original = m.urllib.error.HTTPError('https://PRIVATE.invalid', 503, 'PRIVATE', None, None)
        original.headers = BadHeaders()
        budget = ReadBudget()
        try:
            def opening(*args, **kwargs):
                raise original
            with patch.object(m.urllib.request, 'build_opener', return_value=types.SimpleNamespace(open=opening)), self.assertRaises(m.urllib.error.HTTPError) as caught:
                m.download(m.API + '/releases/' + str(m.RELEASE_ID), m.MIB, budget)
            self.assertIs(caught.exception, original)
            self.assertEqual(budget.trace[-1]['quota_error_class'], 'RuntimeError')
            self.assertNotIn('PRIVATE', json.dumps(budget.trace))
        finally:
            original.close()

    def test_actual_installer_public_failure_binds_transport_before_download(self):
        from contextlib import redirect_stdout
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            gh = root / 'gh'
            gh.write_bytes(b'never-executed')
            gh.chmod(0o700)
            primary = TimeoutError('PRIVATE_RAW_NETWORK_MESSAGE')
            def opening(*a, **k):
                raise primary
            output = io.StringIO()
            with patch.object(m.sys, 'platform', 'linux'), patch.object(m.os, 'uname', return_value=types.SimpleNamespace(machine='x86_64')), patch.object(m.resource, 'getrusage', return_value=types.SimpleNamespace(ru_maxrss=1024)), patch.object(m.urllib.request, 'build_opener', return_value=types.SimpleNamespace(open=opening)), redirect_stdout(output), self.assertRaises(TimeoutError) as caught:
                m.install(root, gh)
            self.assertIs(caught.exception, primary)
            value = json.loads(output.getvalue())
            self.assertEqual(len(value['transport']), 1)
            self.assertEqual(value['transport'][0]['error_class'], 'TimeoutError')
            self.assertEqual(value['transport'][0]['stage'], 'release_metadata')
            self.assertIsNone(value['transport'][0]['status'])
            self.assertTrue(value['owned_absent'])
            self.assertFalse(value['activated'])
            self.assertNotIn('PRIVATE', output.getvalue())

    def test_real_capacity_and_late_deadline_refuse(self):
        with tempfile.TemporaryDirectory() as temp:
            budget = m.Budget(Path(temp))
            with patch.object(m.os, 'statvfs', return_value=types.SimpleNamespace(f_bavail=m.HEADROOM - 1, f_frsize=1)), self.assertRaisesRegex(m.Refused, 'REAL_FREE_HEADROOM'):
                budget.check()
            with patch.object(m.time, 'monotonic_ns', return_value=budget.deadline_ns), self.assertRaisesRegex(m.Refused, 'WHOLE_DEADLINE'):
                budget.check()


class Tar(unittest.TestCase):
    def inspect(self, wire, output=None):
        with patch.object(m, 'ASSETS', assets_for(wire)), patch.object(m, 'SUBJECTS', synthetic_subjects()):
            return m.archive_members(wire, Budget(), output)

    def test_actual_four_header_parser_to_nonexecutable_files(self):
        wire = archive()
        with tempfile.TemporaryDirectory() as temp:
            rows, total = self.inspect(wire, Path(temp))
            self.assertEqual({r['name'] for r in rows}, set(m.NAMES))
            self.assertEqual(total, 4 * len(elf()))
            for name in m.NAMES:
                self.assertEqual((Path(temp) / name).read_bytes(), elf())
                self.assertEqual(stat.S_IMODE((Path(temp) / name).stat().st_mode), 0o600)

    def test_missing_extra_duplicate_and_traversal(self):
        normal = [(name, elf(), tarfile.REGTYPE) for name in m.NAMES]
        for rows in [normal[:-1], normal + [('extra', elf(), tarfile.REGTYPE)],
                     normal + [normal[0]], [('../anvil', elf(), tarfile.REGTYPE)] + normal[1:]]:
            with self.subTest(names=[r[0] for r in rows]), self.assertRaises(m.Refused):
                self.inspect(archive(rows))

    def test_link_and_pax_are_physical_member_rejections(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.DIRTYPE, tarfile.XHDTYPE):
            rows = [(name, elf(), kind if name == 'anvil' else tarfile.REGTYPE) for name in m.NAMES]
            with self.subTest(kind=kind), self.assertRaises(m.Refused):
                self.inspect(archive(rows))

    def test_whole_hash_before_any_member_write(self):
        wire = archive()
        wrong = assets_for(wire)
        wrong[320137030] = (wrong[320137030][0], len(wire), 'wrong-digest-same-length')
        with tempfile.TemporaryDirectory() as temp, patch.object(m, 'ASSETS', wrong), patch.object(m.os, 'open') as opened, self.assertRaises(m.Refused):
            m.archive_members(wire, Budget(), Path(temp))
        opened.assert_not_called()

    def test_foreign_elf_and_member_digest_rejected(self):
        rows = [(name, elf(183) if name == 'anvil' else elf(), tarfile.REGTYPE) for name in m.NAMES]
        with self.assertRaises(m.Refused):
            self.inspect(archive(rows))
        wire = archive()
        with patch.object(m, 'ASSETS', assets_for(wire)), self.assertRaises(m.Refused):
            m.archive_members(wire, Budget())

    def test_raw_name_nul_alias_and_unbounded_padding_rejected(self):
        wire = archive()
        raw = bytearray(gzip.decompress(wire))
        raw[6:10] = b'tail'
        raw[148:156] = b'        '
        raw[148:156] = ('%06o\0 ' % sum(raw[:512])).encode()
        with self.assertRaises(m.Refused):
            self.inspect(gzip.compress(raw, mtime=0))
        padded = gzip.compress(gzip.decompress(wire) + bytes(m.MIB + 1), mtime=0)
        with self.assertRaises(m.Refused):
            self.inspect(padded)

    def test_gzip_crc_and_truncation_refuse(self):
        wire = archive()
        broken = bytearray(wire)
        broken[-8] ^= 1
        for value in (bytes(broken), wire[:-5]):
            with self.subTest(size=len(value)), self.assertRaises((m.Refused, gzip.BadGzipFile, EOFError)):
                self.inspect(value)


class Verification(unittest.TestCase):
    def invoke(self, temp, wait, kill=None):
        root = Path(temp)
        binary = root / 'anvil'
        binary.write_bytes(elf())
        child = types.SimpleNamespace(pid=123, wait=wait, poll=lambda: None, kill=kill or (lambda: None))
        def popen(argv, **kwargs):
            self.assertEqual(argv, m.verifier_command(Path('/fixed/gh'), binary, root / 'bundle', root / 'trust'))
            self.assertNotIn('GH_TOKEN', kwargs['env'])
            self.assertNotIn('HOME', kwargs['env'])
            self.assertNotIn('--force', argv)
            kwargs['stdout'].write(m.canonical(verified_response()))
            return child
        rows = []
        with patch.object(m.subprocess, 'Popen', side_effect=popen), patch.object(m, 'BUNDLE_SHA', m.sha(m.canonical(bundle()))):
            m.verify_one(Path('/fixed/gh'), binary, root / 'bundle', root / 'trust', root, Budget(), rows)
        return rows

    def test_actual_command_policy_and_real_wait_required(self):
        from unittest.mock import Mock
        wait = Mock(return_value=0)
        with tempfile.TemporaryDirectory() as temp:
            rows = self.invoke(temp, wait)
        self.assertTrue(rows[0]['actual_wait_observed'])
        self.assertEqual(rows[0]['exit_code'], 0)
        wait.assert_called_once()
        command = m.verifier_command(Path('/gh'), Path('/a'), Path('/b'), Path('/r'))
        for flag, value in [('--repo', 'foundry-rs/foundry'), ('--cert-identity', m.IDENTITY),
                            ('--cert-oidc-issuer', m.ISSUER), ('--predicate-type', m.PREDICATE),
                            ('--custom-trusted-root', '/r'), ('--bundle', '/b')]:
            self.assertEqual(command[command.index(flag) + 1], value)

    def test_verified_output_rechecks_same_bundle_cert_and_statement(self):
        for bad in ('none', 'issuer', 'identity', 'bundle', 'statement'):
            row = verified_response()
            if bad == 'issuer':
                row[0]['verificationResult']['signature']['certificate']['issuer'] = 'foreign'
            elif bad == 'identity':
                row[0]['verificationResult']['signature']['certificate']['subjectAlternativeName'] = 'foreign'
            elif bad == 'bundle':
                row[0]['attestation']['bundle']['verificationMaterial']['certificate'] = 'foreign'
            elif bad == 'statement':
                row[0]['verificationResult']['statement']['predicateType'] = 'foreign'
            with self.subTest(bad=bad), patch.object(m, 'BUNDLE_SHA', m.sha(m.canonical(bundle()))):
                if bad == 'none':
                    self.assertEqual(m.verified_output(m.canonical(row)), 1)
                else:
                    with self.assertRaises(m.Refused):
                        m.verified_output(m.canonical(row))

    def test_nonzero_never_signature_acceptance_and_no_raw_error(self):
        with tempfile.TemporaryDirectory() as temp, self.assertRaisesRegex(m.Refused, 'SIGSTORE_VERIFIER_OUTCOME'):
            self.invoke(temp, lambda **kw: 2)

    def test_postwait_late_zero_rejected(self):
        original = m.time.monotonic_ns
        clock = [original()]
        def wait(**kw):
            clock[0] += 46 * 10**9
            return 0
        with tempfile.TemporaryDirectory() as temp, patch.object(m.time, 'monotonic_ns', side_effect=lambda: clock[0]), self.assertRaisesRegex(m.Refused, 'SIGSTORE_VERIFIER_OUTCOME'):
            self.invoke(temp, wait)

    def test_cancellation_still_waits_if_kill_fails(self):
        from unittest.mock import Mock
        primary = m.Interrupted('TASK_CANCELLED')
        wait = Mock(side_effect=[primary, -9])
        kill = Mock(side_effect=OSError('private-message-never-serialized'))
        with tempfile.TemporaryDirectory() as temp, self.assertRaises(m.Interrupted) as caught:
            self.invoke(temp, wait, kill)
        self.assertIs(caught.exception, primary)
        self.assertEqual(wait.call_count, 2)
        kill.assert_called_once()


class Publication(unittest.TestCase):
    def pending(self, temp):
        root = Path(temp)
        pending = root / 'pending'
        pending.mkdir()
        rows = []
        for name in m.NAMES:
            path = pending / name
            path.write_bytes(elf())
            path.chmod(0o600)
            rows.append({'name': name, 'bytes': len(elf()), 'sha256': m.sha(elf())})
        return pending, root / 'bin', rows

    def test_no_executable_activation_before_all_four_crypto(self):
        for bad in ('missing', 'nonzero', 'no_wait', 'forced'):
            with tempfile.TemporaryDirectory() as temp:
                pending, destination, members = self.pending(temp)
                rows = records()
                if bad == 'missing':
                    rows.pop()
                elif bad == 'nonzero':
                    rows[0]['exit_code'] = 1
                elif bad == 'no_wait':
                    rows[0]['actual_wait_observed'] = False
                else:
                    rows[0]['forced_cleanup'] = True
                with self.subTest(bad=bad), self.assertRaises(m.Refused):
                    m.activate(pending, destination, members, rows, Budget())
                self.assertFalse(destination.exists())
                self.assertEqual(stat.S_IMODE((pending / 'anvil').stat().st_mode), 0o600)

    def test_success_stable_fresh_bin_and_no_clobber(self):
        with tempfile.TemporaryDirectory() as temp:
            pending, destination, members = self.pending(temp)
            m.activate(pending, destination, members, records(), Budget())
            self.assertTrue(destination.is_dir())
            self.assertFalse(pending.exists())
            self.assertEqual(stat.S_IMODE((destination / 'forge').stat().st_mode), 0o755)
        with tempfile.TemporaryDirectory() as temp:
            pending, destination, members = self.pending(temp)
            destination.mkdir()
            (destination / 'foreign').write_text('preserve')
            with self.assertRaises(m.Refused):
                m.activate(pending, destination, members, records(), Budget())
            self.assertEqual((destination / 'foreign').read_text(), 'preserve')

    def test_rehash_before_activation(self):
        with tempfile.TemporaryDirectory() as temp:
            pending, destination, members = self.pending(temp)
            (pending / 'forge').write_bytes(b'changed')
            with self.assertRaises(m.Refused):
                m.activate(pending, destination, members, records(), Budget())
            self.assertFalse(destination.exists())

    def test_cleanup_refuses_replaced_root(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / 'owned'
            root.mkdir()
            own = root.stat()
            with self.assertRaises(m.Refused):
                m.cleanup_created(root, (own.st_dev, own.st_ino + 1, own.st_uid))
            self.assertTrue(root.exists())

    def test_actual_install_flow_and_failure_cleanup(self):
        wire = archive()
        signed = bundle()
        for failure in (False, True):
            with tempfile.TemporaryDirectory() as temp:
                root = Path(temp).resolve()
                gh = root / 'gh'
                gh.write_bytes(b'control-gh-never-executed')
                gh.chmod(0o700)
                calls = []
                def verified(gh, binary, bundle_path, trust, work, budget, rows):
                    self.assertEqual(stat.S_IMODE(binary.stat().st_mode), 0o600)
                    self.assertEqual(m.sha(m.regular(trust, m.MIB).rstrip(b'\n')),
                                     m.sha(m.canonical(json.loads((HERE / 'foundry_public_good_root.json').read_bytes()))))
                    calls.append(binary.name)
                    if failure and binary.name == 'cast':
                        raise m.Refused('SIGSTORE_VERIFIER_OUTCOME')
                    rows.append(next(row for row in records() if row['name'] == binary.name))
                bodies = [m.canonical(release()), m.LINK, m.canonical(response(signed)), wire]
                with patch.object(m.sys, 'platform', 'linux'), patch.object(m.os, 'uname', return_value=types.SimpleNamespace(machine='x86_64')), patch.object(m.resource, 'getrusage', return_value=types.SimpleNamespace(ru_maxrss=1024)), patch.object(m, 'ASSETS', assets_for(wire)), patch.object(m, 'SUBJECTS', synthetic_subjects()), patch.object(m, 'BUNDLE_SHA', m.sha(m.canonical(signed))), patch.object(m, 'download', side_effect=bodies) as downloaded, patch.object(m, 'verify_one', side_effect=verified):
                    # Refresh synthetic statement after the subject policy change.
                    signed2 = bundle()
                    downloaded.side_effect = [m.canonical(release()), m.LINK, m.canonical(response(signed2)), wire]
                    with patch.object(m, 'BUNDLE_SHA', m.sha(m.canonical(signed2))):
                        if failure:
                            with context_stdout(), self.assertRaises(m.Refused):
                                m.install(root, gh)
                            self.assertFalse((root / m.ROOT_NAME).exists())
                        else:
                            value = m.install(root, gh)
                            self.assertTrue(value['passed'])
                            self.assertEqual(Path(value['bin']), root / 'ziggy-foundry-v1.5.0/bin')
                            self.assertEqual(calls, list(m.NAMES))
                    self.assertEqual(downloaded.call_count, 4)
                self.assertEqual(gh.read_bytes(), b'control-gh-never-executed')


from contextlib import redirect_stdout

def context_stdout():
    return redirect_stdout(io.StringIO())


if __name__ == '__main__':
    sys.addaudithook(audit)
    unittest.main()
