#!/usr/bin/env python3
"""Pure optional Radix producer/receipt controls; no Cargo or native products."""
import copy
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('native_radix_reference', Path(__file__).with_name('native_radix_reference.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def elf(machine=62):
    wire = bytearray(1024)
    wire[:8] = b'\x7fELF\x02\x01\x01\x00'
    struct.pack_into('<HHIQQ', wire, 16, 2, machine, 1, 0x400100, 64)
    struct.pack_into('<HHH', wire, 52, 64, 56, 1)
    struct.pack_into('<IIQQQQQQ', wire, 64, 1, 5, 0, 0x400000, 0, len(wire), len(wire), 4096)
    return wire


class Controls(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='radix-reference-pure-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.commit = 'a' * 40
        self.repo = self.root / 'checkout'
        self.ref = self.repo / m.REFERENCE
        self.ref.mkdir(parents=True)
        (self.ref / 'src').mkdir()
        (self.ref / 'src/main.rs').write_text('fixture Source only')
        (self.ref / 'Cargo.toml').write_text('[package]\nname="fixture"')
        (self.ref / 'Cargo.lock.gz').write_bytes(gzip.compress(b'closed lock\n'))
        self.before = {m.REFERENCE + '/' + name: m.pin(self.ref / name) for name in ['src/main.rs', 'Cargo.toml', 'Cargo.lock.gz']}

    def bad(self, fn):
        with self.assertRaises((ValueError, OSError, KeyError, TypeError)):
            fn()

    def test_owned_lock_is_restored_without_touching_original_absence(self):
        owned = self.root / 'owned'
        with mock.patch.object(m, 'source', return_value=self.before):
            with m.working_source(self.repo, owned) as (_source, record, lock):
                self.assertIsNone(record['original_decoded'])
                self.assertEqual((owned / 'Cargo.lock').read_bytes(), b'closed lock\n')
                self.assertEqual(lock['sha256'], record['decoded_sha256'])
            self.assertFalse((owned / 'Cargo.lock').exists())
        self.assertFalse((self.ref / 'Cargo.lock').exists())
        self.assertEqual(m.pin(self.ref / 'Cargo.lock.gz'), self.before[m.REFERENCE + '/Cargo.lock.gz'])

    def test_failure_also_restores_owned_absence_and_existing_canonical_bytes(self):
        (self.ref / 'Cargo.lock').write_bytes(b'closed lock\n')
        original = m.pin(self.ref / 'Cargo.lock')
        owned = self.root / 'owned'
        with mock.patch.object(m, 'source', return_value=self.before):
            with self.assertRaisesRegex(RuntimeError, 'primary failure'):
                with m.working_source(self.repo, owned):
                    raise RuntimeError('primary failure')
        self.assertFalse((owned / 'Cargo.lock').exists())
        self.assertEqual(m.pin(self.ref / 'Cargo.lock'), original)

    def test_mutated_or_symlink_decoded_lock_rejects_without_rewriting(self):
        raw = self.ref / 'Cargo.lock'
        raw.write_bytes(b'mutated')
        self.bad(lambda: m.checkout_lock(self.repo))
        self.assertEqual(raw.read_bytes(), b'mutated')
        raw.unlink()
        foreign = self.root / 'foreign'
        foreign.write_bytes(b'closed lock\n')
        raw.symlink_to(foreign)
        self.bad(lambda: m.checkout_lock(self.repo))
        self.assertTrue(raw.is_symlink())

    def test_offline_phases_are_exact_and_stage_alone_fetches(self):
        stage = m.phases(self.root, self.root / 'source', True)
        self.assertEqual([row[0] for row in stage], ['fetch'])
        self.assertIn('--locked', stage[0][1])
        phases = m.phases(self.root, self.root / 'source', False)
        self.assertEqual([r[0] for r in phases], m.CHECKS[:-1])
        for name, argv in phases:
            if name in ['test', 'build', 'clippy']:
                self.assertIn('--locked', argv)
                self.assertIn('--offline', argv)
                self.assertNotIn('run-locally', argv)
                self.assertIn(m.BIN, argv)
        self.assertIn('--tests', phases[-1][1])

    def summary(self):
        return '\n'.join('test evidence_tests::' + name + ' ... ok' for name in m.TESTS) + '\ntest result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out;\n'

    def test_all_five_named_real_sdk_tests_are_required(self):
        self.assertEqual(m.test_summary(self.summary()), m.TESTS)
        for text in [self.summary().replace('5 passed', '0 passed'), self.summary().replace('0 ignored', '1 ignored'), self.summary().replace(m.TESTS[0], 'different_test')]:
            self.bad(lambda: m.test_summary(text))

    def test_cargo_product_is_exact_emitted_executable_inside_target(self):
        target = self.root / 'target'
        target.mkdir()
        product = target / m.BIN
        product.write_bytes(elf())
        log = self.root / 'build.log'
        event = {'reason': 'compiler-artifact', 'target': {'name': m.BIN}, 'executable': str(product), 'profile': {'test': False}}
        log.write_text(json.dumps(event) + '\n')
        self.assertEqual(m.cargo_product(log, target), product)
        log.write_text((json.dumps(event) + '\n') * 2)
        self.bad(lambda: m.cargo_product(log, target))
        event['executable'] = str(self.ref / 'Cargo.toml')
        log.write_text(json.dumps(event) + '\n')
        self.bad(lambda: m.cargo_product(log, target))

    def fixture(self):
        out = self.root / 'artifact'
        out.mkdir()
        (out / 'bin').mkdir()
        binary = out / 'bin' / m.BIN
        binary.write_bytes(elf())
        binary.chmod(0o755)
        def member(path):
            return {'relative_path': str(path.relative_to(out)), **{k: v for k, v in m.pin(path).items() if k != 'path'}}
        cpu = out / 'producer-cpuinfo.txt'
        cpu.write_text('processor : 0\nflags : sse sse2\n\nprocessor : 1\nflags : sse sse2 avx\n')
        rows = []
        for name in m.CHECKS:
            log = out / (name + '.log')
            log.write_text(self.summary() if name == 'test' else 'bounded fixture metadata')
            row = {'name': name, 'passed': True, 'exit_code': 0, 'error': None, 'pid': 123, 'actual_parent_wait': True, 'cleanup': {'clean': True, 'owned_present_before_stop': []}, 'log': member(log)}
            if name == 'test': row['required_tests_observed'] = m.TESTS
            rows.append(row)
        covered = {**self.before, **{name: {'path': '/synthetic-producer/' + name, 'bytes': 1, 'sha256': 'b' * 64} for name in m.SCOPES[1:]}}
        gate = {'schema': 1, 'passed': True, 'source_commit': self.commit, 'source_before': covered, 'source_after': copy.deepcopy(covered), 'source_scopes': m.SCOPES, 'all_owned_jobs_joined': True,
                'locks': {'canonical': {'packed': self.before[m.REFERENCE + '/Cargo.lock.gz']}, 'working_lock_restored_to_original_absence': True}, 'checks': rows,
                'cpu': {'cpuinfo': member(cpu), 'required_flags': ['sse', 'sse2'], 'processor_rows': 2}}
        manifest = {'schema': 1, 'kind': 'source-built-linux-radix-reference', 'source_commit': self.commit,
                    'platform': {'os': 'linux', 'architecture': 'x86_64', 'elf_machine': 62, 'byte_order': 'little'},
                    'native_case_acceptance': False, 'accepted_reference_component': False, 'timing_acceptance': False,
                    'tool': {**member(binary), 'elf': m.sibling('native_case_tools').validate_elf(binary, 62), 'producer': m.pin(binary)}}
        return out, gate, manifest

    def save_load(self, out, gate, manifest, flags=('sse', 'sse2', 'avx')):
        gate_path = out / 'source-gate.json'
        gate_path.write_text(json.dumps(gate))
        manifest['source_gate'] = {'relative_path': gate_path.name, **{k: v for k, v in m.pin(gate_path).items() if k != 'path'}}
        path = out / 'manifest.json'
        path.write_text(json.dumps(manifest))
        with mock.patch.object(m.subprocess, 'Popen', side_effect=AssertionError('No implicit execution')):
            return m.load_manifest(path, m.pin(path)['sha256'], self.commit, 62, flags)

    def test_optional_manifest_admission_reads_only_no_root_or_native_claim(self):
        out, gate, manifest = self.fixture()
        self.assertEqual(self.save_load(out, gate, manifest)['path'], str((out / 'bin' / m.BIN).resolve(strict=True)))
        manifest['accepted_reference_component'] = True
        self.bad(lambda: self.save_load(out, gate, manifest))

    def test_manifest_rejects_failed_missing_checks_source_drift_and_wrong_platform(self):
        out, gate, manifest = self.fixture()
        for field in ['exit', 'wait', 'missing', 'drift', 'lock', 'platform']:
            g, v = copy.deepcopy(gate), copy.deepcopy(manifest)
            if field == 'exit': g['checks'][2]['exit_code'] = 1
            elif field == 'wait': g['checks'][2]['actual_parent_wait'] = False
            elif field == 'missing': g['checks'].pop()
            elif field == 'drift': g['source_after'] = {}
            elif field == 'lock': g['locks']['working_lock_restored_to_original_absence'] = False
            else: v['platform']['elf_machine'] = 183
            self.bad(lambda: self.save_load(out, g, v))

    def test_cpu_flags_cannot_be_weakened_or_inferred_from_consumer(self):
        out, gate, manifest = self.fixture()
        self.bad(lambda: self.save_load(out, gate, manifest, ('sse',)))
        gate['cpu']['required_flags'] = ['sse']
        self.bad(lambda: self.save_load(out, gate, manifest))

    def test_changed_product_symlink_parent_and_crossed_path_reject(self):
        out, gate, manifest = self.fixture()
        product = out / 'bin' / m.BIN
        product.write_bytes(b'changed')
        self.bad(lambda: self.save_load(out, gate, manifest))
        product.write_bytes(elf())
        manifest['tool']['relative_path'] = '../outside'
        self.bad(lambda: self.save_load(out, gate, manifest))
        manifest['tool']['relative_path'] = 'bin/' + m.BIN
        (out / 'bin').rename(out / 'real-bin')
        (out / 'bin').symlink_to(out / 'real-bin', target_is_directory=True)
        self.bad(lambda: self.save_load(out, gate, manifest))

    def test_duplicate_manifest_keys_are_rejected(self):
        path = self.root / 'duplicate.json'
        path.write_text('{"schema":1,"schema":1}')
        self.bad(lambda: m.json_read(path))


if __name__ == '__main__':
    unittest.main()
