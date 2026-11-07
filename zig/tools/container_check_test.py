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

    def test_missing_worker_and_mode_cannot_reach_commands(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(c, 'command', side_effect=AssertionError('no subprocess')) as called:
            library = Path(tmp) / 'fixture.so'; library.write_bytes(b'\x7fELFpublic-fixture')
            env = {'ZIG_NATIVE_TEST_MODE': 'ReleaseSafe'}
            for key in ['HYPERLANE_URL_LIBRARY', 'HYPERLANE_REGEX_LIBRARY', 'HYPERLANE_STARKNET_CRYPTO_LIBRARY', 'HYPERLANE_ALEO_CRYPTO_LIBRARY', 'HYPERLANE_ALEO_VM_LIBRARY']:
                env[key] = str(library)
            with mock.patch.dict(os.environ, env, clear=True), self.assertRaisesRegex(AssertionError, 'worker.*not selected|SDK/worker is not selected'):
                c.native_suite('ReleaseSafe', 2, Path(tmp) / 'out.json')
            with mock.patch.dict(os.environ, env, clear=True), self.assertRaisesRegex(AssertionError, 'mode differs'):
                c.native_suite('ReleaseFast', 2, Path(tmp) / 'out.json')
            called.assert_not_called()


class ExistingCompilerTests(unittest.TestCase):
    def test_actual_fixture_path_is_explicit_in_both_modes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for machine in ("x86_64", "aarch64"):
                compiler = root / "zig/.toolchain" / ("zig-" + machine + "-linux-0.15.2") / "zig"
                compiler.parent.mkdir(parents=True); compiler.write_bytes(b"compiler path fixture, never executed"); compiler.chmod(0o755)
                for mode in ("ReleaseSafe", "ReleaseFast"):
                    libraries = ["/native/librocksdb.a", "/native/libgcc_s.so.1"]
                    argv = c.native_suite_command(mode, 2, libraries, root, machine)
                    self.assertEqual(argv[argv.index("--compiler") + 1], str(compiler))
                    self.assertIn(mode, argv); self.assertIn("src/db_tests.zig", argv)
                    self.assertEqual(argv[-2:], libraries)
                    self.assertEqual(argv[argv.index("--timeout-seconds") + 1], "7200")
                    self.assertFalse(any("bootstrap" in word for word in argv))
    def test_missing_compiler_fails_without_fetch_or_ambient_alias(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError, "existing pinned fixture compiler"):
                c.native_suite_command("ReleaseSafe", 2, [], Path(tmp), "x86_64")
    def test_symlink_or_nonexecutable_compiler_rejects(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); compiler = root / "zig/.toolchain/zig-x86_64-linux-0.15.2/zig"; compiler.parent.mkdir(parents=True)
            compiler.symlink_to("/bin/sh")
            with self.assertRaises(ValueError): c.native_suite_command("ReleaseSafe", 2, [], root, "x86_64")
            compiler.unlink(); compiler.write_text("not executable"); compiler.chmod(0o644)
            with self.assertRaises(ValueError): c.native_suite_command("ReleaseSafe", 2, [], root, "x86_64")
    def test_wrong_platform_mode_or_jobs_rejects(self):
        for mode,jobs,machine in [("Debug",2,"x86_64"),("ReleaseSafe",8,"x86_64"),("ReleaseSafe",2,"arm64")]:
            with self.subTest(mode=mode,jobs=jobs,machine=machine), self.assertRaises(ValueError):
                c.native_suite_command(mode,jobs,[],Path("/work"),machine)

if __name__ == '__main__':
    unittest.main()
