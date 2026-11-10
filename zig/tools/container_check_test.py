"""Pure container-checker controls. No Docker, SDK, node or compiler invocation."""
import copy
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

import container_check as c

SHA = 'a' * 40


def publication():
    return {'git_sha': SHA, 'rpcs': [{'url_hash': '0x' + '1' * 64,
                                    'host_hash': '0x' + '2' * 64}], 'allows_public_rpcs': False}


class Controls(unittest.TestCase):
    def test_metadata_exact_schema_identity_and_no_raw_rpc_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'metadata_latest.json'
            value = publication()
            path.write_text(json.dumps(value))
            self.assertEqual(c.metadata_snapshot(path, SHA)['metadata'], value)
            variants = []
            bad = copy.deepcopy(value); bad['git_sha'] = 'b' * 40; variants.append(bad)
            bad = copy.deepcopy(value); bad['allows_public_rpcs'] = True; variants.append(bad)
            bad = copy.deepcopy(value); bad['allows_public_rpcs'] = 0; variants.append(bad)
            bad = copy.deepcopy(value); bad['rpcs'] = []; variants.append(bad)
            bad = copy.deepcopy(value); bad['rpcs'][0]['url'] = 'http://private'; variants.append(bad)
            bad = copy.deepcopy(value); bad['rpcs'][0]['url_hash'] = '0xabc'; variants.append(bad)
            for bad in variants:
                with self.subTest(bad=bad):
                    path.write_text(json.dumps(bad))
                    with self.assertRaises(AssertionError): c.metadata_snapshot(path, SHA)
            for raw in ['{', '{"git_sha":"x","git_sha":"y"}']:
                path.write_text(raw)
                with self.assertRaises((ValueError, AssertionError)): c.metadata_snapshot(path, SHA)
            path.unlink()
            with self.assertRaises(FileNotFoundError): c.metadata_snapshot(path, SHA)
            target = Path(tmp) / 'real'; target.write_text(json.dumps(value)); path.symlink_to(target)
            with self.assertRaises(AssertionError): c.metadata_snapshot(path, SHA)

    def test_identity_required_before_docker(self):
        with mock.patch.object(c, 'checked', side_effect=AssertionError('Docker must not run')) as called:
            for sha in [None, '', 'g' * 40]:
                with self.subTest(sha=sha), self.assertRaises(ValueError):
                    c.smoke_test('image', 'migration', 'postgres', Path('/unused'), expected_git_sha=sha)
            called.assert_not_called()

    def test_startup_waits_for_current_metadata_without_budget_renewal(self):
        class Clock:
            now = 0.0
            def time(self): return self.now
            def sleep(self, seconds): self.now += seconds
        for outcome in ['late-positive', 'absent', 'malformed', 'disappears']:
            clock = Clock()
            def read(*args):
                if outcome == 'malformed': raise ValueError('bad JSON')
                if outcome == 'absent' or (outcome == 'late-positive' and clock.now < 2.5) or (outcome == 'disappears' and clock.now >= .1):
                    raise FileNotFoundError('not published')
                return {'sha256': '1' * 64, 'metadata': publication()}
            def docker(args, **kwargs):
                if args[1] == 'inspect':
                    return SimpleNamespace(stdout=json.dumps([{'State': {'Running': True, 'ExitCode': 0}}]))
                return SimpleNamespace(stdout='', stderr='', returncode=0)
            with self.subTest(outcome=outcome), mock.patch.object(c.time, 'monotonic', clock.time), mock.patch.object(c.time, 'sleep', clock.sleep), mock.patch.object(c, 'metadata_snapshot', side_effect=read), mock.patch.object(c, 'checked', side_effect=docker), mock.patch.object(c, 'command', side_effect=docker), mock.patch.object(c, 'safe_logs'):
                if outcome == 'late-positive':
                    row = c.run_role('image', 'validator', Path('/config'), Path('/data'), Path('/logs'), [], 0, SHA)
                    self.assertGreaterEqual(row['startup_grace_ms'], 2500)
                    self.assertLess(clock.now, 10)
                else:
                    with self.assertRaises((AssertionError, ValueError)):
                        c.run_role('image', 'validator', Path('/config'), Path('/data'), Path('/logs'), [], 0, SHA)
                    self.assertLessEqual(clock.now, 10.1)

    def test_late_positive_metadata_or_inspect_cannot_borrow_startup_time(self):
        for role in ['validator', 'relayer']:
            clock = SimpleNamespace(now=0.0)
            calls = []
            def docker(args, **kwargs):
                calls.append(args)
                if args[1] == 'inspect':
                    if role == 'relayer': clock.now = 11.0
                    return SimpleNamespace(stdout=json.dumps([{'State': {'Running': True, 'ExitCode': 0}}]), stderr='', returncode=0)
                return SimpleNamespace(stdout='', stderr='', returncode=0)
            def metadata(*args):
                clock.now = 11.0
                return {'sha256': '1' * 64, 'metadata': publication()}
            with self.subTest(role=role), mock.patch.object(c.time, 'monotonic', side_effect=lambda: clock.now), mock.patch.object(c, 'checked', side_effect=docker), mock.patch.object(c, 'command', side_effect=docker), mock.patch.object(c, 'metadata_snapshot', side_effect=metadata), mock.patch.object(c, 'safe_logs'):
                with self.assertRaisesRegex(AssertionError, 'beyond original deadline'):
                    c.run_role('image', role, Path('/config'), Path('/data'), Path('/logs'), [], 0, SHA)
            self.assertFalse(any(args[1] == 'stop' for args in calls))

    def test_private_metadata_is_copied_without_changing_source_mode(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / 'metadata.json'
            raw = json.dumps(publication()).encode()
            source.write_bytes(raw); source.chmod(0o600)
            def copied(args, **kwargs):
                self.assertEqual(args[:3], ['docker', 'cp', 'owned:/data/checkpoints/metadata_latest.json'])
                self.assertEqual(kwargs['timeout'], 3)
                Path(args[3]).write_bytes(raw)
                return SimpleNamespace(stdout='', stderr='', returncode=0)
            with mock.patch.object(c, 'checked', side_effect=copied) as call:
                value = c.metadata_snapshot(source, SHA, lambda: c.copied_metadata_bytes('owned'))
            self.assertEqual(value['metadata'], publication())
            self.assertEqual(source.stat().st_mode & 0o777, 0o600)
            call.assert_called_once()
            for read in [lambda: b'x' * 65537, lambda: 'not bytes']:
                with self.assertRaises(AssertionError): c.metadata_snapshot(source, SHA, read)
            def changed():
                source.write_bytes(raw + b' ')
                return raw
            with self.assertRaises(AssertionError): c.metadata_snapshot(source, SHA, changed)

    def test_metadata_copy_rejects_links_and_oversize(self):
        for kind in ['link', 'oversize']:
            def copied(args, **kwargs):
                target = Path(args[3])
                if kind == 'link': target.symlink_to('/unused')
                else: target.write_bytes(b'x' * 65537)
                return SimpleNamespace(stdout='', stderr='', returncode=0)
            with self.subTest(kind=kind), mock.patch.object(c, 'checked', side_effect=copied):
                with self.assertRaises(AssertionError): c.copied_metadata_bytes('owned')

    def test_fixture_cleanup_keeps_runtime_uid_and_fixed_owned_paths(self):
        with tempfile.TemporaryDirectory() as folder:
            data = Path(folder) / 'data'; data.mkdir()
            with mock.patch.object(c, 'checked') as call:
                c.remove_fixture_data('image', data)
                args = call.call_args_list[0].args[0]
                self.assertEqual(args[args.index('--user') + 1], '10001:10001')
                self.assertEqual(args[-5:], ['-rf', '--', '/fixture/relayer', '/fixture/validator', '/fixture/checkpoints'])
                self.assertIn('type=bind,src=' + str(data) + ',dst=/fixture', args)
                self.assertIn('none', args); self.assertIn('--read-only', args)
                self.assertIn('ALL', args); self.assertEqual(call.call_args_list[0].kwargs['timeout'], 15)
                name = args[args.index('--name') + 1]
                self.assertEqual(call.call_args_list[1].args[0], ['docker', 'rm', '--force', '--volumes', name])
                self.assertEqual(call.call_args_list[1].kwargs['timeout'], 10)
                link = Path(folder) / 'link'; link.symlink_to(data, target_is_directory=True)
                with self.assertRaises(AssertionError): c.remove_fixture_data('image', link)
                self.assertEqual(call.call_count, 2)

    def test_cleanup_helper_timeout_or_failure_still_removes_exact_name(self):
        for kind in ['timeout', 'failed-client', 'cancel']:
            with tempfile.TemporaryDirectory() as folder:
                data = Path(folder)
                failure = c.subprocess.TimeoutExpired('docker', 15) if kind == 'timeout' else RuntimeError('failed client') if kind == 'failed-client' else KeyboardInterrupt()
                with self.subTest(kind=kind), mock.patch.object(c, 'checked', side_effect=[failure, SimpleNamespace(returncode=0)]) as call:
                    with self.assertRaises(type(failure)) as caught: c.remove_fixture_data('image', data)
                self.assertIs(caught.exception, failure)
                first = call.call_args_list[0].args[0]
                name = first[first.index('--name') + 1]
                self.assertTrue(name.startswith('ziggy-image-cleanup-'))
                self.assertEqual(call.call_args_list[1].args[0], ['docker', 'rm', '--force', '--volumes', name])
                self.assertEqual(call.call_count, 2)

    def test_cleanup_helper_removal_failure_refuses_success_preserves_primary(self):
        with tempfile.TemporaryDirectory() as folder:
            data = Path(folder)
            cleanup = RuntimeError('daemon removal failed')
            with mock.patch.object(c, 'checked', side_effect=[SimpleNamespace(returncode=0), cleanup]):
                with self.assertRaisesRegex(RuntimeError, 'daemon removal failed'): c.remove_fixture_data('image', data)
            primary = c.subprocess.TimeoutExpired('docker', 15)
            with mock.patch.object(c, 'checked', side_effect=[primary, cleanup]):
                with self.assertRaises(c.subprocess.TimeoutExpired) as caught: c.remove_fixture_data('image', data)
            self.assertIs(caught.exception, primary)
            self.assertIn('fixture helper removal failed', primary.__notes__[0])

    def test_same_db_attempts_precede_cleanup_and_failures_still_cleanup(self):
        for failure_attempt in [None, 0, 1]:
            events = []
            def docker(args, **kwargs):
                text = '127.0.0.1:12345' if args[1] == 'port' else '21' if args[-1] == 'SELECT count(*) FROM seaql_migrations' else 'postgres (PostgreSQL) 16.15'
                return SimpleNamespace(stdout=text, stderr='', returncode=0)
            def role(image, name, config, data, logs, forbidden, attempt, sha):
                events.append(('role', name, attempt, data))
                if attempt == failure_attempt: raise RuntimeError('actual role failure')
                return {'validator_metadata': {'sha256': '1' * 64}}
            def cleanup(image, data): events.append(('cleanup', data))
            with self.subTest(failure_attempt=failure_attempt), mock.patch.object(c, 'RpcFixture', return_value=SimpleNamespace(url='http://127.0.0.1:1234', close=lambda: None)), mock.patch.object(c, 'checked', side_effect=docker), mock.patch.object(c, 'command', side_effect=docker), mock.patch.object(c, 'run_role', side_effect=role), mock.patch.object(c, 'remove_fixture_data', side_effect=cleanup):
                if failure_attempt is None:
                    c.smoke_test('image', 'migration', 'postgres', Path('/unused'), expected_git_sha=SHA)
                    self.assertEqual([event[0] for event in events], ['role', 'role', 'cleanup'] * 3)
                    for i in range(0, len(events), 3):
                        self.assertEqual(events[i][3], events[i + 1][3])
                        self.assertEqual(events[i][3], events[i + 2][1])
                else:
                    with self.assertRaisesRegex(RuntimeError, 'actual role failure'):
                        c.smoke_test('image', 'migration', 'postgres', Path('/unused'), expected_git_sha=SHA)
                    self.assertEqual(events[-1][0], 'cleanup')
                    self.assertEqual(sum(event[0] == 'role' for event in events), failure_attempt + 1)

    def test_native_catalog_is_dynamic_and_rejects_sdk_skip_or_incomplete_output(self):
        names = ['fixture.test.' + name for name in c.NATIVE_REQUIRED]
        def log(names, status=None):
            return '\n'.join(f'{i}/{len(names)} {name}...{(status or {}).get(name, "OK")}'
                             for i, name in enumerate(names, 1))
        self.assertEqual(c.native_test_results(log(names))['total'], len(names))
        allowed = next(iter(c.NATIVE_SKIP_REASONS))
        self.assertIn(allowed, c.native_test_results(log(names + [allowed], {allowed: 'SKIP'}))['skipped'])
        for bad in [log(names, {names[0]: 'SKIP'}), log(names[:-1]), log(names) + '\n999/999 unexpected...OK', log(names).replace('1/', '2/', 1), log(names, {names[0]: 'FAIL'}), 'Build Summary: cached']:
            with self.subTest(bad=bad), self.assertRaises(AssertionError): c.native_test_results(bad)

    def test_native_suite_requires_every_canonical_receipt_regression(self):
        required = (
            'malformed older receipt cannot win included replacement',
            'malformed older receipt cannot win finalized replacement',
            'paged malformed older receipt cannot win included replacement after restart',
            'paged malformed older receipt cannot win finalized replacement after restart',
        )
        names = ['fixture.test.' + name for name in c.NATIVE_REQUIRED]
        for name in required:
            self.assertIn(name, c.NATIVE_REQUIRED)
            remaining = [row for row in names if row != 'fixture.test.' + name]
            log = '\n'.join(f'{i}/{len(remaining)} {row}...OK'
                            for i, row in enumerate(remaining, 1))
            with self.subTest(missing=name), self.assertRaises(AssertionError):
                c.native_test_results(log)

    def test_native_suite_requires_existing_settings_golden_cases(self):
        required = (
            'committed configs select Ethereum relayer without reading process environment',
            'all committed chain settings and validator scraper roles parse with explicit sources',
            '15 production Rust config source differential fixtures',
            'role selection deduplicates and numeric parser rejects Rust-invalid underscore and hex strings',
            '62 actual production Rust role parser differential fixtures',
        )
        names = ['fixture.test.' + name for name in c.NATIVE_REQUIRED]
        for name in required:
            self.assertIn(name, c.NATIVE_REQUIRED)
            remaining = [row for row in names if row != 'fixture.test.' + name]
            log = '\n'.join(f'{i}/{len(remaining)} {row}...OK'
                            for i, row in enumerate(remaining, 1))
            with self.subTest(missing=name), self.assertRaises(AssertionError):
                c.native_test_results(log)

    def test_native_suite_requires_current_scraper_and_worker_regressions(self):
        required = (
            'scraper generic raw sequence snapshots dispatch before derived insertion union write',
            'Aleo worker forwards explicit public consensus override into actual clean child and preserves absence',
        )
        names = ['fixture.test.' + name for name in c.NATIVE_REQUIRED]
        for name in required:
            self.assertIn(name, c.NATIVE_REQUIRED)
            remaining = [row for row in names if row != 'fixture.test.' + name]
            for status in ['absent', 'SKIP']:
                selected = remaining if status == 'absent' else names
                log = '\n'.join(f'{i}/{len(selected)} {row}...{("SKIP" if status == "SKIP" and row.endswith(name) else "OK")}'
                                for i, row in enumerate(selected, 1))
                with self.subTest(name=name, status=status), self.assertRaises(AssertionError):
                    c.native_test_results(log)

    def test_admin_queue_view14_are_required_in_actual_native_census(self):
        required = ('queue view cannot bypass startup cancellation halt or generation change', 'queue view concurrent captures cannot exceed original retained byte budget', 'queue view every allocation failure retires view rows captures and accounting', 'queue view render arena and owned response remain charged after membership retirement', 'queue view render quota allocation resize remap and failures release exact ownership', 'queue view retains retired message and charges every HTTP reference array', 'admin absent domain keeps bounded original response while configured view remains gated', 'admin queue observation progresses while destination mutation owner is held', 'admin queue policy publication owns contexts and leaves old captures immutable', 'admin queue response survives actor retirement and retains quota until actual response free', 'admin queue row and policy generation changes refuse after fresh store read without dangling actors', 'admin public authorized batch commits owned view rows without any later allocation', 'admin public reservation abort releases prepared rows and leaves current view untouched', 'admin public reservation allocation failures never partially publish or authorize')
        self.assertEqual(len(c.NATIVE_REQUIRED), 68)
        self.assertEqual(len(set(c.NATIVE_REQUIRED)), 68)
        self.assertTrue(set(required) <= set(c.NATIVE_REQUIRED))
        names = ['fixture.test.' + name for name in c.NATIVE_REQUIRED]
        log = '\n'.join(f'{i}/{len(names)} {name}...OK' for i, name in enumerate(names, 1))
        self.assertEqual(c.native_test_results(log)['total'], 68)
        for name in required:
            for variant in ('missing', 'SKIP', 'FAIL', 'altered'):
                selected = [row for row in names if row != 'fixture.test.' + name] if variant == 'missing' else list(names)
                if variant == 'altered': selected[selected.index('fixture.test.' + name)] += ' altered'
                wire = '\n'.join(f'{i}/{len(selected)} {row}...{variant if variant in {"SKIP", "FAIL"} and row == "fixture.test." + name else "OK"}' for i, row in enumerate(selected, 1))
                with self.subTest(name=name, variant=variant), self.assertRaises(AssertionError):
                    c.native_test_results(wire)

    def test_missing_worker_and_mode_cannot_reach_commands(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(c.cpu, 'require_native_linux_host'), mock.patch.object(c, 'command', side_effect=AssertionError('no subprocess')) as called:
            library = Path(tmp) / 'fixture.so'; library.write_bytes(b'\x7fELFpublic-fixture')
            env = {'ZIG_NATIVE_TEST_MODE': 'ReleaseSafe'}
            for key in ['HYPERLANE_URL_LIBRARY', 'HYPERLANE_REGEX_LIBRARY', 'HYPERLANE_STARKNET_CRYPTO_LIBRARY', 'HYPERLANE_ALEO_CRYPTO_LIBRARY', 'HYPERLANE_ALEO_VM_LIBRARY']:
                env[key] = str(library)
            with mock.patch.dict(os.environ, env, clear=True), self.assertRaisesRegex(AssertionError, 'worker.*not selected|SDK/worker is not selected'):
                c.native_suite('ReleaseSafe', 2, Path(tmp) / 'out.json')
            with mock.patch.dict(os.environ, env, clear=True), self.assertRaisesRegex(AssertionError, 'mode differs'):
                c.native_suite('ReleaseFast', 2, Path(tmp) / 'out.json')
            called.assert_not_called()


class NativeAbiHostFenceTests(unittest.TestCase):
    def test_actual_x86_native_suite_refuses_non_Linux_or_non_GNU_before_effects(self):
        for system,libc in [('Darwin','glibc'),('Linux','musl')]:
            with mock.patch.object(c.os,'uname',return_value=SimpleNamespace(machine='x86_64')), mock.patch.object(c.cpu.platform,'system',return_value=system), mock.patch.object(c.cpu.platform,'machine',return_value='x86_64'), mock.patch.object(c.cpu.platform,'libc_ver',return_value=(libc,'2.36')), mock.patch.dict(c.os.environ,{'ZIG_NATIVE_TEST_MODE':'ReleaseSafe'},clear=True), mock.patch.object(c,'command',side_effect=AssertionError('compiler cannot start'))as command:
                with self.assertRaisesRegex(ValueError,'native ABI compiler requires Linux x86_64 GNU host'):
                    c.native_suite('ReleaseSafe',2,Path('/not-created/result.json'))
                command.assert_not_called()

    def test_existing_ARM_path_keeps_its_mode_fence_without_x86_profile_guard(self):
        with mock.patch.object(c.os,'uname',return_value=SimpleNamespace(machine='aarch64')), mock.patch.object(c.cpu,'require_native_linux_host',side_effect=AssertionError('x86-only guard')), mock.patch.dict(c.os.environ,{},clear=True):
            with self.assertRaisesRegex(AssertionError,'mode differs'):
                c.native_suite('ReleaseSafe',2,Path('/not-created/result.json'))


class ExistingCompilerTests(unittest.TestCase):
    def test_actual_fixture_path_is_explicit_in_both_modes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            for machine in ("x86_64", "aarch64"):
                compiler = root / "zig/.toolchain" / ("zig-" + machine + "-linux-0.15.2") / "zig"
                compiler.parent.mkdir(parents=True); compiler.write_bytes(b"compiler path fixture, never executed"); compiler.chmod(0o755)
                for mode in ("ReleaseSafe", "ReleaseFast"):
                    libraries = ["/native/librocksdb.a", "/native/libgcc_s.so.1"]
                    pq = root / ("libpq-" + machine + ".so.5")
                    header = bytearray(20);header[:7] = b"\x7fELF\x02\x01\x01";header[16:18] = (3).to_bytes(2, "little");header[18:20] = ({"x86_64":62,"aarch64":183}[machine]).to_bytes(2, "little");pq.write_bytes(header)
                    argv = c.native_suite_command(mode, 2, libraries, root, machine, pq)
                    self.assertEqual(argv.count(str(pq)), 1)
                    if machine=="x86_64":
                        self.assertEqual(argv[argv.index("-target")+1],"native");self.assertEqual([v for v in argv if v.startswith("-mcpu=")],["-mcpu=x86_64_v3+pclmul"])
                    else:self.assertNotIn("-mcpu=x86_64_v3+pclmul",argv)
                    self.assertEqual(argv[argv.index("--compiler") + 1], str(compiler))
                    self.assertIn(mode, argv); self.assertIn("src/db_tests.zig", argv)
                    self.assertEqual(argv[-2:], libraries)
                    self.assertEqual(argv[argv.index("--timeout-seconds") + 1], "7200")
                    self.assertFalse(any("bootstrap" in word for word in argv))
    def test_missing_compiler_fails_without_fetch_or_ambient_alias(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError, "existing pinned fixture compiler"):
                c.native_suite_command("ReleaseSafe", 2, [], Path(tmp), "x86_64", Path(tmp)/"libpq.so.5")
    def test_symlink_or_nonexecutable_compiler_rejects(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); compiler = root / "zig/.toolchain/zig-x86_64-linux-0.15.2/zig"; compiler.parent.mkdir(parents=True)
            compiler.symlink_to("/bin/sh")
            with self.assertRaises(ValueError): c.native_suite_command("ReleaseSafe", 2, [], root, "x86_64", root/"libpq.so.5")
            compiler.unlink(); compiler.write_text("not executable"); compiler.chmod(0o644)
            with self.assertRaises(ValueError): c.native_suite_command("ReleaseSafe", 2, [], root, "x86_64", root/"libpq.so.5")
    def test_wrong_platform_mode_or_jobs_rejects(self):
        for mode,jobs,machine in [("Debug",2,"x86_64"),("ReleaseSafe",8,"x86_64"),("ReleaseSafe",2,"arm64")]:
            with self.subTest(mode=mode,jobs=jobs,machine=machine), self.assertRaises(ValueError):
                c.native_suite_command(mode,jobs,[],Path("/work"),machine,Path("/native/libpq.so.5"))


class AtomicPublicationControls(unittest.TestCase):
    def replace(self, path, body):
        other = path.with_name('publication.tmp')
        other.write_bytes(body)
        other.chmod(0o600)
        os.replace(other, path)

    def test_actual_atomic_replacement_is_typed_but_stable_copy_validates(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'metadata.json'
            raw = json.dumps(publication()).encode()
            path.write_bytes(raw)
            def copied():
                self.replace(path, raw)
                return raw
            with self.assertRaises(c.MetadataPublicationReplaced) as caught:
                c.metadata_snapshot(path, SHA, copied)
            observation = caught.exception.observation
            self.assertEqual(set(observation), {'before', 'after'})
            self.assertNotEqual(observation['before']['inode'], observation['after']['inode'])
            for row in observation.values():
                self.assertEqual(set(row), {'device', 'inode', 'bytes', 'mtime_ns', 'nlink', 'regular'})
                self.assertEqual(row['bytes'], len(raw)); self.assertEqual(row['nlink'], 1)
                self.assertIs(row['regular'], True)
            self.assertNotIn('git_sha', str(caught.exception))
            self.assertEqual(c.metadata_snapshot(path, SHA, path.read_bytes)['metadata'], publication())

    def test_same_inode_mutation_or_replaced_link_and_hardlink_remain_hard(self):
        for kind in ['in-place', 'symlink', 'hardlink']:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as folder:
                path = Path(folder) / 'metadata.json'; raw = json.dumps(publication()).encode()
                path.write_bytes(raw)
                def copied():
                    if kind == 'in-place': path.write_bytes(raw + b' ')
                    else:
                        other = path.with_name('other'); other.write_bytes(raw)
                        path.unlink()
                        if kind == 'symlink': path.symlink_to(other)
                        else: os.link(other, path)
                    return raw
                with self.assertRaises(AssertionError) as caught: c.metadata_snapshot(path, SHA, copied)
                self.assertNotIsInstance(caught.exception, c.MetadataPublicationReplaced)

    def run_startup(self, kind, launch=None, cid=None):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        root = Path(temporary.name); data = root / 'data'; (data / 'checkpoints').mkdir(parents=True)
        path = data / 'checkpoints/metadata_latest.json'; raw = json.dumps(publication()).encode()
        path.write_bytes(raw); clock = SimpleNamespace(now=0.0); state = {'copies': 0, 'stopped': False}; calls = []
        def copied(target):
            if cid is not None: self.assertEqual(target, cid)
            state['copies'] += 1
            if state['copies'] == 1 or (kind == 'stopped' and state['stopped']):
                self.replace(path, raw)
            elif kind == 'late': clock.now = 11.0
            return path.read_bytes()
        def docker(args, **kwargs):
            calls.append(args)
            if cid is not None and args[1] in ('inspect', 'stop', 'rm'): self.assertEqual(args[-1], cid)
            if args[1] == 'stop': state['stopped'] = True
            if args[1] == 'inspect': return SimpleNamespace(stdout=json.dumps([{'State': {'Running': True, 'ExitCode': 0}}]), stderr='', returncode=0)
            return SimpleNamespace(stdout='', stderr='', returncode=0)
        with mock.patch.object(c.time, 'monotonic', side_effect=lambda: clock.now), mock.patch.object(c.time, 'sleep', side_effect=lambda n: setattr(clock, 'now', clock.now + n)), mock.patch.object(c, 'copied_metadata_bytes', side_effect=copied), mock.patch.object(c, 'checked', side_effect=docker), mock.patch.object(c, 'command', side_effect=docker), mock.patch.object(c, 'safe_logs') as logs:
            options = {} if launch is None else {'launch': launch}
            if kind == 'stopped':
                with self.assertRaises(c.MetadataPublicationReplaced): c.run_role('image', 'validator', root/'config', data, root/'logs', [], 1, SHA, **options)
                self.assertTrue(state['stopped'])
            elif kind == 'late':
                with self.assertRaisesRegex(AssertionError, 'beyond original deadline'): c.run_role('image', 'validator', root/'config', data, root/'logs', [], 1, SHA, **options)
                self.assertFalse(state['stopped']); self.assertEqual(clock.now, 11.0)
            else:
                row = c.run_role('image', 'validator', root/'config', data, root/'logs', [], 1, SHA, **options)
                self.assertEqual(row['metadata_replacement_count'], 1)
                self.assertEqual(row['validator_metadata']['metadata'], publication())
                self.assertGreaterEqual(row['startup_grace_ms'], 2000); self.assertLess(clock.now, 10)
                self.assertTrue(state['stopped']); self.assertTrue(row['reopened'])
            self.assertTrue(any(args[1] == 'rm' for args in calls))
            if cid is not None:
                self.assertGreater(state['copies'], 0)
                self.assertTrue(any(args[1] == 'inspect' for args in calls))
                self.assertTrue(logs.called)
                for call in logs.call_args_list: self.assertEqual(call.args[0], cid)

    def test_real_atomic_restart_replacement_retries_only_startup(self): self.run_startup('normal')
    def test_stopped_atomic_replacement_never_retries(self): self.run_startup('stopped')
    def test_atomic_retry_cannot_borrow_original_startup_deadline(self): self.run_startup('late')


    def ready_replacement(self, repeat):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); data = root / 'data'; (data/'checkpoints').mkdir(parents=True)
            path = data/'checkpoints/metadata_latest.json'; raw = json.dumps(publication()).encode(); path.write_bytes(raw)
            clock = SimpleNamespace(now=0.0); state = {'replaced': False, 'stable_after': False, 'stopped': False}
            def copied(_):
                if not state['stopped'] and clock.now >= 2 and (repeat or not state['replaced']):
                    state['replaced'] = True; self.replace(path, raw)
                elif state['replaced']: state['stable_after'] = True
                return path.read_bytes()
            def docker(args, **kwargs):
                if args[1] == 'stop':
                    self.assertTrue(state['stable_after'], 'Cannot stop using the pre-replacement sample')
                    state['stopped'] = True
                if args[1] == 'inspect': return SimpleNamespace(stdout=json.dumps([{'State': {'Running': True, 'ExitCode': 0}}]), stderr='', returncode=0)
                return SimpleNamespace(stdout='', stderr='', returncode=0)
            with mock.patch.object(c.time, 'monotonic', side_effect=lambda: clock.now), mock.patch.object(c.time, 'sleep', side_effect=lambda n: setattr(clock, 'now', clock.now+n)), mock.patch.object(c, 'copied_metadata_bytes', side_effect=copied), mock.patch.object(c, 'checked', side_effect=docker), mock.patch.object(c, 'command', side_effect=docker), mock.patch.object(c, 'safe_logs'):
                if repeat:
                    with self.assertRaisesRegex(AssertionError, 'metadata startup deadline'): c.run_role('image','validator',root/'config',data,root/'logs',[],1,SHA)
                    self.assertFalse(state['stopped']); self.assertLessEqual(clock.now,10.1)
                else:
                    row=c.run_role('image','validator',root/'config',data,root/'logs',[],1,SHA)
                    self.assertEqual(row['metadata_replacement_count'],1); self.assertTrue(state['stable_after']); self.assertGreater(clock.now,2)
                    self.assertTrue(state['stopped'])

    def test_ready_time_replacement_requires_subsequent_stable_copy(self): self.ready_replacement(False)
    def test_ready_time_replacement_churn_never_reuses_prior_stable_sample(self): self.ready_replacement(True)


    def test_device_change_is_hard_even_with_changed_regular_inode(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'metadata.json'; path.write_text(json.dumps(publication()))
            before=path.lstat()
            fields={key:getattr(before,key)for key in ['st_mode','st_nlink','st_size','st_dev','st_ino','st_mtime_ns']}
            after=SimpleNamespace(**dict(fields,st_dev=before.st_dev+1,st_ino=before.st_ino+1))
            with mock.patch.object(Path,'lstat',side_effect=[before,after]),self.assertRaisesRegex(AssertionError,'device changed during read')as caught:
                c.metadata_snapshot(path,SHA)
            self.assertNotIsInstance(caught.exception,c.MetadataPublicationReplaced)


class FixedCIDLaunch:
    grace_seconds = 10

    def __init__(self, cid):
        self.cid = cid
        self.active = None

    def docker_args(self, *args): return ['docker', 'create', 'fixed-args']
    def create(self, args, name): self.active = {'container_id': self.cid}
    def start(self): pass
    def started(self, name): pass
    def stopped(self, code):
        if code != 0: raise AssertionError('mock owned container did not stop cleanly')
    def finish(self, name): c.command(['docker', 'rm', self.active['container_id']])


class AtomicCIDPublicationControls(unittest.TestCase):
    def exercise(self, kind):
        fixture = AtomicPublicationControls()
        self.addCleanup(fixture.doCleanups)
        cid = 'a' * 64
        fixture.run_startup(kind, launch=FixedCIDLaunch(cid), cid=cid)

    def test_Helm_CID_retry_retains_replacement_diagnostics(self): self.exercise('normal')
    def test_Helm_CID_stopped_replacement_stays_hard(self): self.exercise('stopped')
    def test_Helm_CID_late_metadata_stays_inside_original_clock(self): self.exercise('late')


class NativePqLinkControls(unittest.TestCase):
    def test_native_suite_rejects_missing_alias_wrong_format_type_and_arch_libpq(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve(); compiler = root / "zig/.toolchain/zig-x86_64-linux-0.15.2/zig"
            compiler.parent.mkdir(parents=True); compiler.write_text("never executed"); compiler.chmod(0o755)
            pq = root / "libpq.so.5"
            with self.assertRaises(FileNotFoundError):c.native_suite_command("ReleaseSafe",2,[],root,"x86_64",pq)
            valid = bytearray(20);valid[:7] = b"\x7fELF\x02\x01\x01";valid[16:18] = (3).to_bytes(2,"little");valid[18:20] = (62).to_bytes(2,"little")
            for offset,value in [(0,0),(4,1),(5,2),(16,2),(18,183)]:
                bad = valid.copy();bad[offset] = value;pq.write_bytes(bad)
                with self.subTest(offset=offset),self.assertRaisesRegex(ValueError,"matching Linux libpq"):c.native_suite_command("ReleaseSafe",2,[],root,"x86_64",pq)
            pq.write_bytes(valid);alias = root / "alias.so";alias.symlink_to(pq)
            with self.assertRaisesRegex(ValueError,"canonical libpq"):c.native_suite_command("ReleaseSafe",2,[],root,"x86_64",alias)
            with self.assertRaisesRegex(ValueError,"canonical libpq"):c.native_suite_command("ReleaseSafe",2,[],root,"x86_64",Path("libpq.so.5"))

    def test_every_native_db_build_caller_passes_existing_explicit_pq_and_roles_stay_unchanged(self):
        root = c.ROOT
        build = (root / "zig/build.zig").read_text();docker = (root / "zig/Dockerfile").read_text();workflow = (root / ".github/workflows/zig-agents.yml").read_text()
        self.assertEqual(build.count('b.option([]const u8, "libpq-library"'),1)
        self.assertIn('if (libpq_library) |library| native_module.addObjectFile(.{ .cwd_relative = library });',build)
        self.assertNotIn('validator_module.addObjectFile(.{ .cwd_relative = library });',build)
        self.assertEqual(workflow.count('"-Dnative-db-libs=$LIBS" "-Dlibpq-library=$LIBPQ" --summary all'),1)
        self.assertEqual(docker.count('"-Dnative-db-libs=${LIBS}" "-Dlibpq-library=${LIBPQ}" --summary all'),2)
        self.assertIn('&& LIBPQ="$(readlink -f "$(pkg-config --variable=libdir libpq)/libpq.so.5")"',docker.split('FROM native-db AS native-starknet\n',1)[1].split('FROM native-db AS native-aleo',1)[0])
        import ast
        tree = ast.parse((root / "zig/tools/container_check.py").read_text());suite = next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name == 'native_suite')
        calls = [n for n in ast.walk(suite) if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id == 'native_suite_command']
        self.assertEqual(len(calls),1);self.assertEqual(len(calls[0].args),6);self.assertIsInstance(calls[0].args[-1],ast.Name);self.assertEqual(calls[0].args[-1].id,'libpq_library')

if __name__ == '__main__':
    unittest.main()
