#!/usr/bin/env python3
"""Pure ELF/descriptor/profile controls; never invokes Cargo, DBs or native cases."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import platform
import signal
import threading
import time
import struct
import sys
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('native_case_tools', Path(__file__).with_name('native_case_tools.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def elf(machine=62, kind=3, interpreter=True):
    wire = bytearray(1024)
    wire[:8] = b'\x7fELF\x02\x01\x01\x00'
    struct.pack_into('<HHIQQ', wire, 16, kind, machine, 1, 0x400100, 64)
    struct.pack_into('<HHH', wire, 52, 64, 56, 2 if interpreter else 1)
    struct.pack_into('<IIQQQQQQ', wire, 64, 1, 5, 0, 0x400000, 0, len(wire), len(wire), 4096)
    if interpreter:
        name = b'/lib64/ld-linux-x86-64.so.2\0'
        struct.pack_into('<IIQQQQQQ', wire, 120, 3, 4, 512, 0, 0, len(name), len(name), 1)
        wire[512:512 + len(name)] = name
    return wire


class Controls(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='zig-native-tools-pure-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / 'program'
        self.path.write_bytes(elf())
        self.path.chmod(0o755)
        self.commit = 'a' * 40

    def bad(self, fn):
        with self.assertRaises((ValueError, OSError, KeyError, UnicodeError)):
            fn()

    def test_elf_accepts_actual_header_types_and_machines(self):
        for machine in (62, 183):
            for kind in (2, 3):
                self.path.write_bytes(elf(machine, kind))
                self.assertEqual(machine, m.validate_elf(self.path, machine)['machine'])
        self.path.write_bytes(elf(62, 2, False))
        self.assertIsNone(m.validate_elf(self.path, 62)['interpreter'])

    def test_elf_rejects_macho_shared_library_foreign_arch_and_non_executable(self):
        for wire in (b'\xcf\xfa\xed\xfe' + bytes(1020), elf(62, 3, False), elf(183)):
            self.path.write_bytes(wire)
            self.bad(lambda: m.validate_elf(self.path, 62))
        self.path.write_bytes(elf())
        self.path.chmod(0o644)
        self.bad(lambda: m.validate_elf(self.path, 62))

    def test_elf_rejects_truncation_unsafe_segments_and_entry(self):
        for field in ('short', 'headers', 'entry', 'segment', 'interpreter', 'class', 'endian'):
            with self.subTest(field=field):
                wire = elf()
                if field == 'short': wire = wire[:20]
                elif field == 'headers': struct.pack_into('<Q', wire, 32, 1000)
                elif field == 'entry': struct.pack_into('<Q', wire, 24, 0x900000)
                elif field == 'segment': struct.pack_into('<Q', wire, 64 + 32, 2000)
                elif field == 'interpreter': wire[512] = ord('.')
                elif field == 'class': wire[4] = 1
                else: wire[5] = 2
                self.path.write_bytes(wire)
                self.bad(lambda: m.validate_elf(self.path, 62))

    def test_symlink_tool_rejected(self):
        target = self.root / 'link'
        target.symlink_to(self.path)
        self.bad(lambda: m.validate_elf(target, 62))

    @unittest.skipUnless(sys.platform == 'linux', 'Actual Linux ELF input only; host pure controls remain separate')
    def test_actual_existing_linux_python_elf_metadata_only(self):
        path = Path(sys.executable).resolve(strict=True)
        parsed = m.validate_elf(path, m.MACHINES[platform.machine()])
        self.assertEqual(m.MACHINES[platform.machine()], parsed['machine'])

    def fixture(self):
        source = {name: {'path': '/producer/' + name, 'bytes': 1, 'sha256': 'b' * 64} for name in ['zig/reference/src/main.rs', 'zig/reference/Cargo.toml', 'zig/reference/native-rows/src/main.rs', 'zig/reference/native-rows/Cargo.toml', 'rust/main/hyperlane-core/src/lib.rs', 'rust/main/agents/scraper/migration/bin/init_db.rs', 'zig/bench/native_case_tools.py']}
        locks = {name: {'path': '/producer/' + name, 'bytes': 1, 'sha256': 'c' * 64} for name in m.LOCKS}
        for name, value in m.CANONICAL.items():
            (locks if name.endswith('Cargo.lock') else source)[name] = {'path': '/producer/' + name, 'bytes': 1, 'sha256': value}
        checks = [{'name': 'build-' + name, 'pid': 123, 'passed': True, 'actual_parent_wait': True, 'exit_code': 0, 'error': None, 'cleanup': {'clean': True, 'owned_present_before_stop': []}} for name in m.TOOLS]
        checks += [{'name': 'test-' + name, 'pid': 123, 'passed': True, 'actual_parent_wait': True, 'exit_code': 0, 'error': None, 'cleanup': {'clean': True, 'owned_present_before_stop': []}, 'actual_tests_passed': 3 if name.endswith('oracle') else 13} for name in ('ziggy-rocks-oracle', 'ziggy-native-rows')]
        gate = {'schema': 1, 'passed': True, 'source_commit': self.commit, 'source_before': source, 'source_after': copy.deepcopy(source), 'actual_all_parent_waits': True, 'canonical_compatibility_source': m.CANONICAL, 'locks': locks, 'checks': checks}
        tools = {}
        (self.root / 'bin').mkdir(exist_ok=True)
        for name in m.TOOLS:
            path = self.root / 'bin' / name
            path.write_bytes(elf())
            path.chmod(0o755)
            d = m.descriptor(path)
            tools[name] = {'relative_path': 'bin/' + name, 'bytes': d['bytes'], 'sha256': d['sha256'], 'elf': m.validate_elf(path, 62), 'producer': d}
        manifest = {'schema': 1, 'kind': 'source-built-linux-native-case-tools', 'source_commit': self.commit, 'platform': {'os': 'linux', 'architecture': 'x86_64', 'elf_machine': 62, 'byte_order': 'little'}, 'tools': tools, 'canonical_compatibility_source': m.CANONICAL, 'native_chain_acceptance': False, 'storage_interoperability_acceptance': False, 'elapsed600_acceptance': False, 'timing_acceptance': False}
        return gate, manifest

    def save(self, gate, manifest):
        gp = self.root / 'source-gate.json'
        gp.write_text(json.dumps(gate))
        manifest['source_gate'] = {'relative_path': gp.name, 'bytes': gp.stat().st_size, 'sha256': m.sha(gp)}
        path = self.root / 'manifest.json'
        path.write_text(json.dumps(manifest))
        return path

    def load(self, gate, manifest):
        path = self.save(gate, manifest)
        return m.load_manifest(path, m.sha(path), self.commit, 62)

    def test_exact_structural_manifest_no_implicit_build(self):
        gate, manifest = self.fixture()
        with mock.patch.object(m.subprocess, 'run', side_effect=AssertionError('No implicit subprocess/build')):
            self.assertEqual(set(m.TOOLS), set(self.load(gate, manifest)))

    def test_manifest_digest_and_source_commit_required(self):
        gate, manifest = self.fixture()
        path = self.save(gate, manifest)
        self.bad(lambda: m.load_manifest(path, '0' * 64, self.commit, 62))
        self.bad(lambda: m.load_manifest(path, m.sha(path), 'd' * 40, 62))

    def test_manifest_cross_platform_and_incomplete_or_extra_tools(self):
        gate, original = self.fixture()
        for kind in ('arch', 'os', 'missing', 'extra', 'acceptance'):
            with self.subTest(kind=kind):
                manifest = copy.deepcopy(original)
                if kind == 'arch': manifest['platform']['elf_machine'] = 183
                elif kind == 'os': manifest['platform']['os'] = 'darwin'
                elif kind == 'missing': manifest['tools'].pop('init-db')
                elif kind == 'extra': manifest['tools']['unexpected'] = manifest['tools']['init-db']
                else: manifest['native_chain_acceptance'] = True
                self.bad(lambda: self.load(gate, manifest))

    def test_source_gate_failure_mutation_wait_and_phase_exhaustion(self):
        original, manifest = self.fixture()
        for kind in ('failed', 'source', 'wait', 'phases', 'zero-tests', 'residual', 'canonical', 'lock', 'coverage'):
            with self.subTest(kind=kind):
                gate = copy.deepcopy(original)
                if kind == 'failed': gate['passed'] = False
                elif kind == 'source': gate['source_after'].pop('zig/reference/src/main.rs')
                elif kind == 'wait': gate['actual_all_parent_waits'] = False
                elif kind == 'phases': gate['checks'].pop()
                elif kind == 'zero-tests': gate['checks'][-1]['actual_tests_passed'] = 0
                elif kind == 'residual': gate['checks'][0]['cleanup']['owned_present_before_stop'] = [{'pid': 456}]
                elif kind == 'canonical': gate['canonical_compatibility_source'] = {}
                elif kind == 'lock': gate['locks']['zig/reference/rocks/Cargo.lock']['sha256'] = 'e' * 64
                else:
                    gate['source_before'].pop('zig/reference/src/main.rs')
                    gate['source_after'].pop('zig/reference/src/main.rs')
                self.bad(lambda: self.load(gate, copy.deepcopy(manifest)))

    def test_actual_product_copy_and_relative_path_cross_binding(self):
        gate, original = self.fixture()
        for kind in ('copy', 'path', 'elf'):
            with self.subTest(kind=kind):
                manifest = copy.deepcopy(original)
                tool = manifest['tools']['init-db']
                if kind == 'copy': tool['producer']['sha256'] = 'f' * 64
                elif kind == 'path': tool['relative_path'] = '../program'
                else: tool['elf']['type'] = 2
                self.bad(lambda: self.load(gate, manifest))

    def test_published_tool_mutation_and_bin_symlink_reject(self):
        gate, manifest = self.fixture()
        (self.root / 'bin/init-db').write_bytes(elf() + b'changed')
        self.bad(lambda: self.load(gate, manifest))
        (self.root / 'bin/init-db').write_bytes(elf())
        (self.root / 'bin').rename(self.root / 'real-bin')
        (self.root / 'bin').symlink_to(self.root / 'real-bin', target_is_directory=True)
        self.bad(lambda: self.load(gate, manifest))

    def interop(self):
        path = Path(__file__).resolve().parents[1] / 'integration/native_rows_interop.py'
        spec = importlib.util.spec_from_file_location('interop', path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def argv(self, manifest, digest=None):
        return ['interop', '--writer', str(self.path), '--reader', str(self.root / 'bin/ziggy-native-rows'), '--reader-sha256', m.sha(self.root / 'bin/ziggy-native-rows'), '--tool-manifest', str(manifest), '--tool-manifest-sha256', digest or m.sha(manifest), '--tool-source-commit', self.commit, '--writer-sha256', m.sha(self.path), '--output', str(self.root / 'interop.json')]

    def test_linux_interop_admission_fail_closed_before_writer_or_database(self):
        gate, manifest = self.fixture()
        path = self.save(gate, manifest)
        api = self.interop()
        for mutation in ('manifest', 'source', 'writer', 'reader', 'missing-authority'):
            with self.subTest(mutation=mutation):
                argv = self.argv(path)
                if mutation == 'manifest': argv[argv.index('--tool-manifest-sha256') + 1] = '0' * 64
                elif mutation == 'source': argv[argv.index('--tool-source-commit') + 1] = 'd' * 40
                elif mutation == 'writer': argv[argv.index('--writer-sha256') + 1] = '0' * 64
                elif mutation == 'reader': argv[argv.index('--reader') + 1] = str(self.path)
                else: del argv[argv.index('--writer-sha256'):argv.index('--writer-sha256') + 2]
                with mock.patch.object(sys, 'argv', argv), mock.patch.object(sys, 'platform', 'linux'), mock.patch.object(platform, 'machine', return_value='x86_64'), mock.patch.object(api.subprocess, 'Popen') as child, mock.patch.object(api.tempfile, 'mkdtemp') as fixture:
                    with self.assertRaises(ValueError): api.main()
                    child.assert_not_called()
                    fixture.assert_not_called()

    def test_linux_interop_exact_authority_reaches_only_fixture_boundary(self):
        gate, manifest = self.fixture()
        path = self.save(gate, manifest)
        api = self.interop()
        class FixtureBoundary(Exception): pass
        with mock.patch.object(sys, 'argv', self.argv(path)), mock.patch.object(sys, 'platform', 'linux'), mock.patch.object(platform, 'machine', return_value='x86_64'), mock.patch.object(api.subprocess, 'Popen') as child, mock.patch.object(api.tempfile, 'mkdtemp', side_effect=FixtureBoundary):
            with self.assertRaises(FixtureBoundary): api.main()
            child.assert_not_called()

    def test_legacy_interop_still_requires_exact_immutable_mac_hashes(self):
        api = self.interop()
        calls = []
        def artifact(path, expected=None):
            calls.append((path, expected))
            return {'path': str(path), 'bytes': 1, 'sha256': expected or 'a' * 64}
        class FixtureBoundary(Exception): pass
        argv = ['interop', '--writer', 'writer', '--reader', 'reader', '--reader-sha256', 'a' * 64, '--output', str(self.root / 'result.json')]
        with mock.patch.object(sys, 'argv', argv), mock.patch.object(api, 'artifact', side_effect=artifact), mock.patch.object(api.tempfile, 'mkdtemp', side_effect=FixtureBoundary):
            with self.assertRaises(FixtureBoundary): api.main()
        self.assertEqual(api.OLD_SHA, calls[2][1])
        self.assertEqual(api.REFERENCE_SHA, calls[3][1])
        self.assertEqual('8e295002b44b4248d00d6627aaa47a21' + '2315f6f837f3a2d652f2e7f6ada69fd9', api.OLD_SHA)

    @unittest.skipUnless(sys.platform == 'linux', 'Actual Linux owner/signal regression')
    def test_actual_owned_python_cancellation_retains_error_wait_and_absence(self):
        owner_path = Path(os.environ.get('ZIGGY_COLD_OWNER_SOURCE', str(Path(__file__).with_name('cold_matrix_owner.py'))))
        spec = importlib.util.spec_from_file_location('actual_cold_owner', owner_path)
        owner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(owner)
        owner.enable_subreaper()
        repo = self.root / 'repo'
        (repo / 'rust/main').mkdir(parents=True)
        output = self.root / 'evidence'
        output.mkdir()
        phase = {'name': 'build-python-cancel', 'tool': 'synthetic', 'command': [sys.executable, '-c', "import time; print('owned-child-ready', flush=True); time.sleep(30)"]}
        log = output / 'build-python-cancel.log'
        sent, timer_errors = [], []
        def cancel_ready():
            end = time.monotonic() + 4
            while time.monotonic() < end:
                if log.exists() and 'owned-child-ready' in log.read_text():
                    sent.append(True)
                    os.kill(os.getpid(), signal.SIGTERM)
                    return
                time.sleep(.01)
            timer_errors.append('owned child never ready')
        old = signal.signal(signal.SIGTERM, m.interrupted)
        thread = threading.Thread(target=cancel_ready)
        thread.start()
        try:
            # The isolated test tmpfs is32MiB; fixture capacity admits the signal
            # path without changing production6GiB guards. Process/owner are real.
            with mock.patch.object(m, 'source', return_value={}), mock.patch.object(m.shutil, 'disk_usage', return_value=mock.Mock(free=8 * m.GIB)):
                row = m.run_owned(phase, repo, {'PATH': os.environ['PATH']}, self.root, output, time.monotonic() + 6, owner, {}, owner.allocated(self.root))
        finally:
            thread.join(timeout=5)
            signal.signal(signal.SIGTERM, old)
        self.assertFalse(thread.is_alive())
        self.assertEqual([], timer_errors)
        self.assertTrue(sent)
        self.assertFalse(row['passed'])
        self.assertEqual('ToolInterrupted', row['error']['type'])
        self.assertEqual(-signal.SIGTERM, row['exit_code'])
        self.assertTrue(row['actual_parent_wait'])
        self.assertTrue(row['cleanup']['clean'])
        self.assertEqual([], row['cleanup']['remaining_identities'])
        with self.assertRaises(ProcessLookupError): os.kill(row['pid'], 0)
        print('OWNED_CANCEL_RECEIPT ' + json.dumps({'primary_error': row['error'], 'actual_parent_wait': row['actual_parent_wait'], 'exit_code': row['exit_code'], 'cleanup_clean': row['cleanup']['clean'], 'remaining_identities': row['cleanup']['remaining_identities'], 'child_absence_proven': True, 'source_and_free_capacity_fixture_only': True, 'real_process_and_exact_existing_owner': True}), flush=True)

    def test_plan_reuses_helper_target_and_dev_profile_no_hidden_fetch(self):
        plan = m.make_plan(self.root, self.root / 'repo', self.commit)
        self.assertEqual(6, len(plan['phases']))
        for phase in plan['phases']:
            self.assertIn('--locked', phase['command'])
            self.assertIn('--offline', phase['command'])
            self.assertNotIn('--release', phase['command'])
            self.assertEqual(str(self.root / 'target'), phase['command'][phase['command'].index('--target-dir') + 1])
        self.assertFalse(plan['native_case_acceptance'])
        self.assertFalse(plan['timing_acceptance'])


if __name__ == '__main__':
    unittest.main()
