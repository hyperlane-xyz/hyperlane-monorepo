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


class EvmConsumerControls(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='evm-consumer-pure-');self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)

    def admission(self):
        context={'scenario':'evm','mode':'ReleaseSafe','runtime_source_commit':m.EVM_CONTROL_PRODUCER,'execution_source_commit':'e'*40,'phase':'HYDRATED_NOT_EXECUTION_APPROVAL','nodes_started':False,'native_case_acceptance':False}
        case={'kind':'owned-linux-native-case-result','passed':True,'native_case_acceptance':True,'accepted_inputs_unchanged_after':True,**{k:context[k]for k in ['scenario','mode','runtime_source_commit','execution_source_commit']}}
        return context,case,{'passed':True,'contract_artifacts':{}}

    def test_requires_actual_completed_matching_EVM_case_before_separate_controls(self):
        context,case,stage=self.admission();self.assertEqual(m.evm_control_admission(context,case,stage),'ReleaseSafe')
        # Historical dependency producers cannot authorize the fresh G case.
        for historical in ('c0e9b16f5f5361dbbc45260d0316ed8a03b80857','7fdbe182301e92ee7aaed7d82d679e52cffcd8f4','14c854379a86c74f36bd8f25f3b56c1fc3eed562'):
            old_context,old_case,old_stage=self.admission()
            old_context['runtime_source_commit']=historical;old_case['runtime_source_commit']=historical
            with self.subTest(historical=historical),self.assertRaises(ValueError):m.evm_control_admission(old_context,old_case,old_stage)
        for group,key,value in [('context','runtime_source_commit','a'*40),('context','scenario','starknet'),('context','mode','Debug'),('case','passed',False),('case','native_case_acceptance',False),('case','accepted_inputs_unchanged_after',False),('case','mode','ReleaseFast'),('stage','passed',False)]:
            values={'context':copy.deepcopy(context),'case':copy.deepcopy(case),'stage':copy.deepcopy(stage)};values[group][key]=value
            with self.subTest(group=group,key=key),self.assertRaises(ValueError):m.evm_control_admission(values['context'],values['case'],values['stage'])

    def archive(self):
        import zipfile,hashlib
        path=self.root/'dependency.zip';members={}
        with zipfile.ZipFile(path,'w',compression=zipfile.ZIP_STORED)as package:
            for name in sorted(m.EVM_CONTROL_ARCHIVES|{'manifest.json'}):package.writestr('deps/'+name,b'!<arch>\n'+name.encode())
            package.writestr('zig-out/bin/relayer',b'UNSELECTED_AGENT_NEVER_MATERIALIZED')
        with zipfile.ZipFile(path)as package:
            for info in package.infolist():
                if info.filename.startswith('deps/'):
                    wire=package.read(info);members[info.filename]={'bytes':len(wire),'sha256':hashlib.sha256(wire).hexdigest(),'crc32':info.CRC}
        return path,members

    def test_streams_all_member_CRC_but_materializes_only_exact_static7_and_manifest(self):
        path,members=self.archive();target=self.root/'selected';rows=m.evm_control_extract_dependencies(path,target,members)
        self.assertEqual(len(rows),9);self.assertEqual({p.name for p in target.iterdir()},m.EVM_CONTROL_ARCHIVES|{'manifest.json'});self.assertFalse((target/'relayer').exists())
        self.assertIn('zig-out/bin/relayer',{r['path']for r in rows})

    def test_dependency_missing_duplicate_unsafe_and_declared_identity_refuse(self):
        import zipfile
        path,members=self.archive()
        with zipfile.ZipFile(path)as package:
            infos=package.infolist()
            for rows in [infos[:-2]+infos[-1:],infos+[infos[0]],[*infos,zipfile.ZipInfo('../escape')]]:
                with self.subTest(rows=len(rows)),self.assertRaises(ValueError):m.evm_control_dependency_selection(rows,members)
            bad=copy.deepcopy(members);bad[next(iter(bad))]['bytes']+=1
            with self.assertRaises(ValueError):m.evm_control_dependency_selection(infos,bad)

    def test_unselected_agent_CRC_corruption_also_refuses_before_any_execution(self):
        import zipfile
        path,members=self.archive()
        with zipfile.ZipFile(path)as package:info=package.getinfo('zig-out/bin/relayer');offset=info.header_offset+30+len(info.filename.encode())+len(info.extra)
        wire=bytearray(path.read_bytes());wire[offset]^=1;path.write_bytes(wire)
        with self.assertRaises(zipfile.BadZipFile):m.evm_control_extract_dependencies(path,self.root/'corrupt',members)

    def test_actual_prepare_fixture_chunk_API_roundtrips_exact_native_dispatch(self):
        for count in [77,78,100,1024]:
            wire=bytes(i%256 for i in range(count));value=m.evm_control_fixture_document(wire,'http://127.0.0.1:31337','0x'+'11'*20,'0x'+'22'*20)
            self.assertIsInstance(value['message'],list);self.assertTrue(all(type(s)is str and len(s)<=32 for s in value['message']));self.assertEqual(bytes.fromhex(''.join(value['message'])[2:]),wire)
        for wire,url in [(b'x'*76,'http://127.0.0.1:1'),(b'x'*1025,'http://127.0.0.1:1'),(b'x'*77,'http://external.invalid:1'),(b'x'*77,'http://127.0.0.1:70000')]:
            with self.subTest(wire=len(wire),url=url),self.assertRaises(ValueError):m.evm_control_fixture_document(wire,url,'0x'+'11'*20,'0x'+'22'*20)

    def test_compile_commands_are_test_only_exact_mode_and_private_entrypoints(self):
        rows=m.evm_control_commands(Path('/owned/source'),Path('/owned/compiler'), 'ReleaseFast',[str(i)+'.a'for i in range(7)],Path('/owned'))
        self.assertEqual(len(rows),2)
        for row in rows:
            self.assertIn('test',row);self.assertIn('--test-no-exec',row);self.assertIn('ReleaseFast',row);self.assertIn('-j2',row);self.assertNotIn('cargo',row);self.assertNotIn('build',row)
        self.assertEqual(rows[0].count('--test-filter'),2);self.assertEqual(rows[1].count('--test-filter'),1)
        for mode,libraries in [('Debug',['a']*7),('ReleaseSafe',['a']*6)]:
            with self.assertRaises(ValueError):m.evm_control_commands(Path('/owned'),Path('/compiler'),mode,libraries,Path('/owned'))

    def test_required_actual_test_OK_cannot_borrow_SKIP_FAIL_missing_or_duplicate(self):
        target=m.EVM_CONTROL_TESTS[2];row={'name':'consumer.test.'+target,'status':'OK','ordinal':1,'total':1}
        self.assertEqual(m.evm_control_test_verdict('ignored',[target],lambda _: {'total':1,'per_test':[row]})['required_OK'],[row])
        for rows in [[],[{**row,'status':'SKIP'}],[{**row,'status':'FAIL'}],[row,row],[{**row,'name':'different.test.some other test'}]]:
            with self.subTest(rows=rows),self.assertRaises(ValueError):m.evm_control_test_verdict('ignored',[target],lambda _,rows=rows:{'total':len(rows),'per_test':rows})

    def test_filtered_component_uses_actual_parser_without_full_SDK_census(self):
        import ast,re,types
        source=Path(__file__).resolve().parents[1]/'tools/container_check.py'
        tree=ast.parse(source.read_text());nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='native_test_results' or isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id in {'NATIVE_REQUIRED','NATIVE_SKIP_REASONS'}for t in n.targets)]
        checker=types.ModuleType('actual_filtered_parser');checker.re=re
        exec(compile(ast.fix_missing_locations(ast.Module(nodes,type_ignores=[])),str(source),'exec'),checker.__dict__)
        full_required=checker.NATIVE_REQUIRED;self.assertEqual(len(full_required),54)
        chunks=['\n'.join(f'{i}/{len(targets)} component.test.{target}...OK'for i,target in enumerate(targets,1))for targets in [m.EVM_CONTROL_TESTS[:2],m.EVM_CONTROL_TESTS[2:]]]
        for text in chunks:
            with self.assertRaisesRegex(AssertionError,'required SDK/production regression absent'):checker.native_test_results(text)
        actual=ast.parse(Path(m.__file__).read_text());main=next(n for n in actual.body if isinstance(n,ast.FunctionDef)and n.name=='evm_control_main')
        assignments=[n for n in ast.walk(main)if isinstance(n,ast.Assign)and any(isinstance(t,ast.Attribute)and isinstance(t.value,ast.Name)and t.value.id=='checker'and t.attr=='NATIVE_REQUIRED'for t in n.targets)]
        self.assertEqual(len(assignments),1)
        exec(compile(ast.fix_missing_locations(ast.Module(assignments,type_ignores=[])),'actual private filtered-parser binding','exec'),{'checker':checker})
        self.assertEqual(checker.NATIVE_REQUIRED,())
        for text,targets in zip(chunks,[m.EVM_CONTROL_TESTS[:2],m.EVM_CONTROL_TESTS[2:]]):
            self.assertEqual(len(m.evm_control_test_verdict(text,targets,checker.native_test_results)['required_OK']),len(targets))
        for text in [chunks[1].replace('OK','FAIL'),chunks[1].replace('OK','SKIP'),chunks[1].replace('1/1','2/2'),chunks[1]+'\n'+chunks[1],chunks[1].replace(m.EVM_CONTROL_TESTS[2],'different')]:
            with self.assertRaises((AssertionError,ValueError)):m.evm_control_test_verdict(text,m.EVM_CONTROL_TESTS[2:],checker.native_test_results)
        checker.NATIVE_REQUIRED=full_required
        with self.assertRaisesRegex(AssertionError,'required SDK/production regression absent'):checker.native_test_results(chunks[0])

    def test_owned_Source_copy_joins_Git_blob_and_hashes_actual_helpers(self):
        import hashlib
        repo=self.root/'repo';names=['zig/src/db_tests.zig','zig/src/agents/indexing/tx_id_native_test.zig','zig/tools/zig.py','zig/tools/bootstrap.py'];listing=[]
        for name in names:
            path=repo/name;path.parent.mkdir(parents=True,exist_ok=True);wire=('source '+name).encode();path.write_bytes(wire);blob=hashlib.sha1(b'blob '+str(len(wire)).encode()+b'\0'+wire).hexdigest();listing.append(('100644 blob '+blob+'\t'+name+'\0').encode())
        with mock.patch.object(m.subprocess,'check_output',return_value=b''.join(listing)):
            copied,rows=m.evm_control_copy_source(repo,self.root/'copy','d'*40)
        self.assertEqual(set(rows),set(names));self.assertTrue(all((copied/n).read_bytes()==(repo/n).read_bytes()for n in names))
        (repo/names[0]).write_bytes(b'changed')
        with mock.patch.object(m.subprocess,'check_output',return_value=b''.join(listing)),self.assertRaises(ValueError):m.evm_control_copy_source(repo,self.root/'poison','d'*40)

    def test_contract_inputs_are_actual_stage_pins_and_exact_repository_Source(self):
        repo=self.root/'repo';artifacts={}
        for name,source in m.EVM_CONTROL_CONTRACTS.items():
            logical='solidity/artifacts/'+source+'/'+name+'.json';path=repo/logical;path.parent.mkdir(parents=True);path.write_text(json.dumps({'sourceName':source,'contractName':name,'bytecode':'0x6000'}));artifacts[logical]=m.descriptor(path)
        stage={'contract_artifacts':artifacts};self.assertEqual(set(m.evm_control_contracts(stage,repo)),set(m.EVM_CONTROL_CONTRACTS))
        first=next(iter(artifacts));path=Path(artifacts[first]['path']);path.write_text(json.dumps({'sourceName':'foreign.sol','contractName':'Mailbox','bytecode':'0x6000'}));artifacts[first]=m.descriptor(path)
        with self.assertRaises(ValueError):m.evm_control_contracts(stage,repo)

    def actual_run(self, *, cancel=False, debt=False):
        import ast
        from types import SimpleNamespace as N
        tree=ast.parse(Path(m.__file__).read_text());main=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='evm_control_main');run=next(n for n in main.body if isinstance(n,ast.FunctionDef)and n.name=='run')
        output=self.root/'run';output.mkdir();(output/'logs').mkdir();calls=[];stopped=[];child=N(pid=777,returncode=None)
        def stop(*args,**kwargs):stopped.append(args[0]);child.returncode=-15 if cancel else 0;return {'actual_parent_wait':not debt,'clean':not debt,'cleanup_confirmed_absent':not debt,'signals':[]}
        namespace={**m.__dict__,'args':N(output=output),'owner':N(stop_owned=stop,processes=lambda:{},owned_processes=lambda *args:{}),'env':{},'calls':calls,'guard':lambda:None,'last_census':[0], 'resource':N(getrusage=lambda _:N(ru_maxrss=0),RUSAGE_SELF=0)}
        exec(compile(ast.Module([run],type_ignores=[]),'actual-control-owned-run','exec'),namespace)
        wait=m.ToolInterrupted('simulated SIGTERM')if cancel else N()
        with mock.patch.object(m.subprocess,'Popen',return_value=child),mock.patch.object(m.os,'waitid',side_effect=wait if cancel else None,return_value=wait),mock.patch.object(m.signal,'signal',return_value=m.signal.SIG_DFL):
            with self.assertRaises((m.ToolInterrupted,ValueError)):namespace['run']('controlled',['never-executed'])
        self.assertEqual(stopped,[child]);self.assertEqual(len(calls),1);self.assertFalse(calls[0]['clean']if debt else False)
        if debt:self.assertFalse(calls[0]['actual_parent_wait'])
        return tree,main

    def test_actual_run_cancellation_preserves_primary_and_waits_owned_child(self):self.actual_run(cancel=True)

    def test_actual_run_cleanup_debt_cannot_return_positive(self):self.actual_run(debt=True)

    def test_dirty_consumed_orchestrator_refuses_execution_Git_join(self):
        import hashlib
        repo=self.root/'repo';name='zig/bench/native_case_tools.py';path=repo/name;path.parent.mkdir(parents=True);wire=b'committed consumer';path.write_bytes(wire);blob=hashlib.sha1(b'blob '+str(len(wire)).encode()+b'\0'+wire).hexdigest();listing=('100644 blob '+blob+'\t'+name+'\0').encode()
        with mock.patch.object(m.subprocess,'check_output',return_value=listing),mock.patch.object(m.subprocess,'Popen',side_effect=AssertionError('native/API must not run')):
            self.assertEqual(m.evm_control_execution_sources(repo,'e'*40,[name])[name],m.descriptor(path));path.write_bytes(b'dirty consumer')
            with self.assertRaisesRegex(ValueError,'Dirty/uncommitted consumer Source'):m.evm_control_execution_sources(repo,'e'*40,[name])

    def test_signal_handler_registration_precedes_first_owned_work(self):
        import ast
        tree=ast.parse(Path(m.__file__).read_text());main=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='evm_control_main');watched=next(n for n in main.body if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='watched'for t in n.targets));cohort=next(n for n in ast.walk(main)if isinstance(n,ast.Call)and isinstance(n.func,ast.Attribute)and n.func.attr=='cohort');self.assertLess(watched.lineno,cohort.lineno)
        constants={n.attr for n in ast.walk(watched)if isinstance(n,ast.Attribute)};self.assertTrue({'SIGINT','SIGTERM','SIGHUP'}<=constants)


if __name__ == '__main__':
    unittest.main()
