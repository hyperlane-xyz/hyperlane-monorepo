"""Pure tool-binding controls. No Rustup/Cargo/helper/native process executes."""
import copy
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest import mock
from types import SimpleNamespace

P = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('svm_workspace_controls', P / 'native_svm_workspace.py')
api = importlib.util.module_from_spec(spec); spec.loader.exec_module(api)


class Controls(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve(); self.repo = self.root / 'repo'
        (self.repo / 'rust/main/utils/run-locally').mkdir(parents=True)
        (self.repo / 'rust/main/Cargo.toml').write_text('[workspace]\n')

    def write(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True); path.write_text(json.dumps(value)); return api.pin(path)

    def elf(self, path, cargo=None, machine=62):
        path.parent.mkdir(parents=True, exist_ok=True)
        data = bytearray(64); data[:7] = b'\x7fELF\x02\x01\x01'; struct.pack_into('<H', data, 18, machine)
        path.write_bytes(data + b'\0' + (cargo or str(api.CARGO)).encode() + b'\0'); path.chmod(0o600)
        return api.pin(path)

    def fixture(self, family="svm"):
        base = self.root / 'producer/helper'; base.mkdir(parents=True)
        product = self.elf(base / 'products/construction')
        template = json.loads((P/f'fixtures/native_{family}_c20_encoded_request.json').read_text())
        result = {'passed': True, 'source_unchanged': True, 'source_commit': template['producer_source_commit'], 'products': {'construction': {'artifact_relative_path': 'products/construction', 'published': product, 'producer': product}}}
        self.write(base / 'result.json', result)
        platform = base / 'setup/tools-platform.txt'; platform.parent.mkdir(); platform.write_text('cargo 1.98.0 (797e8a9bc 2026-08-05)\n')
        archive = self.root / 'archive.zip'; archive.write_bytes(b'SYNTHETIC transport metadata only; never actual producer admission')
        remote = {'id': 123, 'name': 'zig-native-harness-controls', 'sha256': api.pin(archive)['sha256'], 'size_in_bytes': archive.stat().st_size}
        request = template
        request['artifact_pins']['helper'] = {**remote, 'sha256': {'sha256_hex_chunks': [remote['sha256'][:32], remote['sha256'][32:]]}}
        request_path = self.root / 'request.json'; request_pin = self.write(request_path, request)
        files = [{'relative_path': name, **{k: value for k, value in api.pin(base / name).items() if k != 'path'}} for name in ['result.json', 'products/construction', 'setup/tools-platform.txt']]
        receipt = {'passed': True, 'all_owned_jobs_joined': True, 'request': request_pin, 'execution_source_commit': 'b' * 40, 'producer_source_commit': template['producer_source_commit'], 'artifacts': {'helper': {'remote': remote, 'archive': api.pin(archive), 'directory': str(base), 'files': files}}}
        receipt_path = self.root / 'receipt.json'; receipt_pin = self.write(receipt_path, receipt)
        return request_path, request_pin, receipt_path, receipt_pin, request, receipt, base

    def call(self, args):
        request, request_pin, receipt, receipt_pin, *_ = args
        return api.inputs(request, request_pin['sha256'], receipt, receipt_pin['sha256'], self.repo, 'b' * 40)

    def test_exact_baked_path_data_only_never_chmods_or_executes_helper(self):
        path = self.root / 'construction'; self.elf(path)
        self.assertEqual(api.baked_cargo(path), api.pin(path)); self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        for cargo, machine in [(str(api.CARGO).replace('1.98.0', '1.97.0'), 62), (str(api.CARGO), 183), (str(api.CARGO) + '\0/home/runner/.rustup/toolchains/1.97.0-x86_64-unknown-linux-gnu/bin/cargo', 62)]:
            self.elf(path, cargo, machine)
            with self.assertRaises(ValueError): api.baked_cargo(path)

    def test_disabled_and_other_family_do_not_read_receipt_or_discover_tools(self):
        for request in [{'schema': 1, 'root_approved': False, 'scenario': 'sealevel'}, {'schema': 1, 'root_approved': True, 'scenario': 'cosmosnative'}]:
            path = self.root / 'request'; row = self.write(path, request)
            self.assertIsNone(api.inputs(path, row['sha256'], self.root / 'ABSENT', 'unused', self.repo, 'b' * 40))

    def test_actual_binding_checks_product_version_request_and_original_cwd(self):
        args = self.fixture(); bound = self.call(args)
        self.assertEqual(bound['cwd'], str(self.repo / 'rust/main/utils/run-locally'))
        self.assertEqual(bound['baked_cargo_path'], str(api.CARGO)); self.assertEqual(bound['producer_cargo_version'], 'cargo 1.98.0 (797e8a9bc 2026-08-05)')
        args[6].joinpath('products/construction').write_bytes(b'mutated')
        with self.assertRaises(ValueError): self.call(args)

    def test_real_retained_encoded_request_uses_shared_decoder_full_validator(self):
        path = P/'fixtures/native_svm_c20_encoded_request.json'
        raw = json.loads(path.read_text()); self.assertIsInstance(raw['artifact_pins']['helper']['sha256'], dict)
        module = api.request_module(); decoded = module.read_request(path)
        self.assertIsInstance(decoded['artifact_pins']['helper']['sha256'], str)
        module.validate_request(decoded)
        args = self.fixture(); self.assertEqual(self.call(args)['request'], args[1])
        # A valid codec value does not bypass the original family policy.
        request = json.loads(args[0].read_text()); request['limits']['maximum_wall_seconds'] = 3601
        row = self.write(args[0], request)
        with self.assertRaisesRegex(ValueError, 'resource/lifecycle'): api.inputs(args[0], row['sha256'], args[2], args[3]['sha256'], self.repo, 'b'*40)

    def test_actual_encoded_EVM_CW_Tron_requests_use_full_validator_and_same_baked_Cargo(self):
        for family, scenario in [('evm', 'evm'), ('cw', 'cosmwasm'), ('tron', 'tron')]:
            with self.subTest(family=family), tempfile.TemporaryDirectory() as temporary:
                original_root, original_repo = self.root, self.repo
                self.root = Path(temporary).resolve(); self.repo = self.root / 'repo'
                (self.repo / 'rust/main/utils/run-locally').mkdir(parents=True)
                (self.repo / 'rust/main/Cargo.toml').write_text('[workspace]\n')
                try:
                    source = P / f'fixtures/native_{family}_c20_encoded_request.json'
                    raw = json.loads(source.read_text())
                    self.assertIsInstance(raw['artifact_pins']['helper']['sha256'], dict)
                    dispatch = api.request_module(); decoded = dispatch.read_request(source)
                    self.assertEqual(decoded['scenario'], scenario); dispatch.validate_request(decoded)
                    args = self.fixture(family); bound = self.call(args)
                    self.assertEqual(bound['baked_cargo_path'], str(api.CARGO))
                    self.assertEqual(bound['workspace_manifest'], str(self.repo / 'rust/main/Cargo.toml'))
                    request = json.loads(args[0].read_text()); request['limits']['maximum_wall_seconds'] = 3601
                    row = self.write(args[0], request)
                    with self.assertRaisesRegex(ValueError, 'resource/lifecycle'):
                        api.inputs(args[0], row['sha256'], args[2], args[3]['sha256'], self.repo, 'b' * 40)
                finally:
                    self.root, self.repo = original_root, original_repo

    def test_wrong_cohort_request_join_or_archive_cannot_provision(self):
        args = self.fixture()
        for field in ('source', 'request', 'join', 'archive'):
            receipt = copy.deepcopy(args[5])
            if field == 'source': receipt['producer_source_commit'] = 'c' * 40
            elif field == 'request': receipt['request'] = {}
            elif field == 'join': receipt['all_owned_jobs_joined'] = False
            else: receipt['artifacts']['helper']['archive']['sha256'] = 'f' * 64
            row = self.write(args[2], receipt)
            with self.subTest(field=field), self.assertRaises(ValueError): api.inputs(args[0], args[1]['sha256'], args[2], row['sha256'], self.repo, 'b' * 40)

    def test_original_locator_exact_output_and_no_path_fallback(self):
        manifest = self.repo / 'rust/main/Cargo.toml'; api.locator((str(manifest) + '\n').encode(), manifest)
        for raw in [str(manifest).encode(), (str(manifest) + '\n\n').encode(), b'/foreign/Cargo.toml\n', b'']:
            with self.assertRaises(ValueError): api.locator(raw, manifest)

    def test_workflow_keeps_finite_step_after_controls_before_composition(self):
        workflow = P.parents[1] / '.github/workflows/zig-agents.yml'
        text = workflow.read_text(); block = text[text.index('      - name: Stage exact producer-baked Cargo'):text.index('      - name: Pin preinstalled tools')]
        self.assertIn('native Source workspace discovery', block); self.assertIn('timeout-minutes: 5', block); self.assertIn("if: steps.request.outputs.enabled == 'true'", block)
        self.assertLess(text.index('native_svm_workspace_test.py'), text.index('      - name: Stage exact producer-baked Cargo'))
        self.assertNotIn('rustup default', text[text.index('  native-case-producer-inputs:'):text.index('  aleo-linux-sdk-prerequisite:')])

    def provision(self, bad_version=False):
        bound = self.call(self.fixture()); output = self.root / 'prerequisite.json'
        rustup, cargo = self.root / 'rustup', self.root / 'cargo'
        for path in (rustup, cargo): path.write_bytes(b'PUBLIC MOCK TOOL, NEVER EXECUTED'); path.chmod(0o755)
        args = SimpleNamespace(execute=True, request=Path(bound['request']['path']), request_sha256=bound['request']['sha256'], producer_receipt=Path(bound['producer_receipt']['path']), producer_receipt_sha256=bound['producer_receipt']['sha256'], repo=self.repo, output=output, execution_source_commit='b'*40)
        calls = []
        def run(argv, **kwargs):
            calls.append((argv, kwargs))
            raw = b'' if argv[0] == str(rustup) else (('cargo 1.97.0 (797e8a9bc 2026-08-05)\n' if bad_version else bound['producer_cargo_version']+'\n').encode() if argv[-1] == '--version' else (bound['workspace_manifest']+'\n').encode())
            return SimpleNamespace(returncode=0, stdout=raw, stderr=b'')
        with mock.patch.object(api.argparse.ArgumentParser, 'parse_args', return_value=args), mock.patch.object(api, 'inputs', return_value=bound), mock.patch.object(api, 'RUSTUP', rustup), mock.patch.object(api, 'CARGO', cargo), mock.patch.object(api, 'default_toolchain', return_value='stable-x86_64-unknown-linux-gnu'), mock.patch.object(api.shutil, 'disk_usage', return_value=SimpleNamespace(free=10*api.GIB)), mock.patch.dict(api.os.environ, {'GITHUB_ACTIONS':'true', 'GITHUB_SHA':'b'*40, 'GH_TOKEN':'PRIVATE-NOT-FOR-CHILD'}, clear=True), mock.patch.object(api.subprocess, 'run', side_effect=run):
            if bad_version:
                with self.assertRaisesRegex(ValueError, 'prerequisite failed'): api.main()
            else: api.main()
        return json.loads(output.read_text()), calls

    def test_actual_main_commands_version_locator_metadata_and_clean_child_env(self):
        result, calls = self.provision()
        self.assertTrue(result['passed']); self.assertFalse(result['actual_future_case_environment_checked']); self.assertFalse(result['native_case_acceptance']); self.assertFalse(result['helper_or_SDK_rebuilt'])
        self.assertEqual(calls[0][0][1:], ['toolchain','install','1.98.0','--profile','minimal','--no-self-update'])
        self.assertEqual(calls[2][0][1:], ['locate-project','--workspace','--message-format=plain'])
        for argv, kw in calls:
            self.assertEqual(kw['cwd'], str(self.repo/'rust/main/utils/run-locally')); self.assertNotIn('GH_TOKEN', kw['env']); self.assertLessEqual(kw['timeout'], 270); self.assertNotIn('build', argv)
        self.assertEqual(calls[2][1]['env']['PATH'], '/usr/bin:/bin'); self.assertNotIn('RUSTUP_HOME', calls[2][1]['env'])
        self.assertNotIn('PRIVATE', json.dumps(result))

    def test_actual_main_wrong_version_stops_before_original_locator(self):
        result, calls = self.provision(bad_version=True)
        self.assertFalse(result['passed']); self.assertEqual(result['error_type'], 'ValueError'); self.assertEqual(len(calls),2)


if __name__ == '__main__': unittest.main()
