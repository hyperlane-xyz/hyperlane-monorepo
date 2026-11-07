"""Socket/process-free diagnostic custody and route controls; no Zig compilation."""
import importlib.util
import ast
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('native312', Path(__file__).with_name('native_http_312_diagnostic.py'))
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


class CustodyControls(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.repo = self.root / 'repo'
        self.target = self.repo / api.TARGET
        self.target.parent.mkdir(parents=True)
        self.target.write_bytes(b'original')
        self.target.chmod(0o640)
        self.output = self.root / 'output'
        self.output.mkdir(mode=0o700)
        self.before = api.digest(b'original')
        self.after = b'instrumented'
        self.patch = mock.patch.multiple(api, BEFORE_SHA=self.before, AFTER_SHA=api.digest(self.after))
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def receipts(self, absent=True):
        output = self.output / 'outer-owner'
        output.mkdir()
        cleanup = {'actual_parent_wait': True, 'cleanup_confirmed_absent': absent, 'clean': absent}
        (output / 'result.json').write_text(json.dumps({'cleanup': cleanup}))
        (output / 'monitor-parent.json').write_text(json.dumps({'cleanup': cleanup}))

    def test_snapshot_exists_before_execute_and_normal_return_restores_exact_mode(self):
        def execute():
            self.assertEqual(self.target.read_bytes(), self.after)
            self.assertEqual((self.output / 'source.before').read_bytes(), b'original')
            self.assertEqual((self.output / 'source.before').stat().st_mode & 0o777, 0o600)
            self.receipts()
            return 0
        result = api.diagnostic(self.repo, self.output, self.after, execute)
        self.assertTrue(result['source_restored'])
        self.assertEqual(self.target.read_bytes(), b'original')
        self.assertEqual(self.target.stat().st_mode & 0o777, 0o640)
        self.assertFalse(result['native_acceptance'])
        self.assertIn('cause unknown', result['interpretation'])

    def test_wrong_before_hash_refuses_before_snapshot_or_execute(self):
        self.target.write_bytes(b'unreviewed')
        with self.assertRaisesRegex(ValueError, 'Original Source hash'):
            api.diagnostic(self.repo, self.output, self.after, lambda: self.fail('executed'))
        self.assertEqual(self.target.read_bytes(), b'unreviewed')
        self.assertFalse((self.output / 'source.before').exists())

    def test_execution_failure_after_actual_cleanup_restores_and_preserves_failure(self):
        def execute():
            self.receipts()
            raise RuntimeError('fake owned timeout after actual cleanup')
        result = api.diagnostic(self.repo, self.output, self.after, execute)
        self.assertTrue(result['source_restored'])
        self.assertTrue(result['owned_consumers_absent'])
        self.assertIn('fake owned timeout', result['diagnostic_error']['message'])
        self.assertIsNone(result['command_exit_code'])
        self.assertEqual(self.target.read_bytes(), b'original')

    def test_unproven_cleanup_preserves_snapshot_and_defers_restore(self):
        def execute():
            self.receipts(False)
            raise RuntimeError('unproven child')
        result = api.diagnostic(self.repo, self.output, self.after, execute)
        self.assertFalse(result['source_restored'])
        self.assertFalse(result['owned_consumers_absent'])
        self.assertEqual(self.target.read_bytes(), self.after)
        self.assertEqual((self.output / 'source.before').read_bytes(), b'original')

    def test_null_wrongshape_or_malformed_cleanup_keeps_backup_and_writes_summary(self):
        good = {'cleanup': {'actual_parent_wait': True, 'cleanup_confirmed_absent': True, 'clean': True}}
        bad = [None, [], {'cleanup': None}, {'cleanup': []}, {'cleanup': 'true'}, {'cleanup': True}, {}, '{malformed']
        for side in ['command', 'monitor']:
            for index, value in enumerate(bad):
                with self.subTest(side=side, value=value):
                    self.target.write_bytes(b'original')
                    output = self.root / (side+'-'+str(index))
                    output.mkdir()
                    def execute():
                        receipts = output / 'outer-owner'
                        receipts.mkdir()
                        rows = [value, good] if side == 'command' else [good, value]
                        for name, row in zip(['result.json', 'monitor-parent.json'], rows):
                            (receipts / name).write_text(row if row == '{malformed' else json.dumps(row))
                        return 0
                    result = api.diagnostic(self.repo, output, self.after, execute)
                    self.assertFalse(result['owned_consumers_absent'])
                    self.assertFalse(result['source_restored'])
                    self.assertFalse(result['native_acceptance'])
                    self.assertIn('cleanup_ambiguity', result)
                    self.assertEqual((output / 'source.before').read_bytes(), b'original')
                    self.assertEqual(self.target.read_bytes(), self.after)
                    self.assertEqual(json.loads((output / 'summary.json').read_text()), result)

    def test_unknown_mutation_never_clobbered_by_restore(self):
        def execute():
            self.receipts()
            self.target.write_bytes(b'foreign')
            return 1
        result = api.diagnostic(self.repo, self.output, self.after, execute)
        self.assertFalse(result['source_restored'])
        self.assertEqual(self.target.read_bytes(), b'foreign')
        self.assertEqual((self.output / 'source.before').read_bytes(), b'original')

    def test_changed_snapshot_refuses_restore(self):
        def execute():
            self.receipts()
            (self.output / 'source.before').write_bytes(b'foreign')
            return 1
        result = api.diagnostic(self.repo, self.output, self.after, execute)
        self.assertFalse(result['source_restored'])
        self.assertEqual(self.target.read_bytes(), self.after)

    def test_nonzero_test_exit_stays_nonzero_diagnostic_with_restored_source(self):
        def execute():
            self.receipts()
            return 7
        result = api.diagnostic(self.repo, self.output, self.after, execute)
        self.assertEqual(result['command_exit_code'], 7)
        self.assertTrue(result['source_restored'])
        self.assertFalse(result['native_acceptance'])

    def test_independent_inventory_detects_nonoverlay_input_change(self):
        extra = self.repo / 'zig/src/extra.zig'
        extra.write_bytes(b'original-extra')
        def inventory():
            return {api.TARGET: {'sha256': api.digest(self.target.read_bytes())}, 'zig/src/extra.zig': {'sha256': api.digest(extra.read_bytes())}}
        def execute():
            self.receipts()
            extra.write_bytes(b'changed')
            return 0
        result = api.diagnostic(self.repo, self.output, self.after, execute, inventory)
        self.assertFalse(result['source_restored'])
        self.assertEqual(self.target.read_bytes(), b'original')
        self.assertIn('Original compiled inputs changed', result['source_readback_error']['message'])


class RouteControls(unittest.TestCase):
    def test_log_cap_retains_bounded_bytes_and_requests_only_own_cancellation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'diagnostic.log'
            with mock.patch.object(api, 'LOG_LIMIT', 16), mock.patch.object(api.os, 'kill') as cancel:
                with self.assertRaisesRegex(ValueError, 'log exceeded'):
                    with api.BoundedLog(path):
                        os.write(1, b'0123456789'*4)
            self.assertEqual(path.stat().st_size, 16)
            cancel.assert_called_once_with(os.getpid(), api.signal.SIGTERM)

    def test_adjacent_sha_literals_retain_exact_whole_ast_values(self):
        tree = ast.parse(Path(api.__file__).read_text())
        values = {node.targets[0].id: node.value.value for node in tree.body
                  if isinstance(node, ast.Assign) and len(node.targets) == 1
                  and isinstance(node.targets[0], ast.Name) and isinstance(node.value, ast.Constant)}
        expected = {
            'BEFORE_SHA': ('c0b144c8319586990d9b8b722a745e648c' 'b1a01574c0fcbef1f8932627ede0e0'),
            'AFTER_SHA': (('2b2a47d04f5c440f85f9ff56faaad2eb' '47ac4b54937038e837617afb1ed0640f')),
            'PAYLOAD_SHA': (('9cc72cc24d37aadd80e82ba63962d1aa' '0d357df7efcfc64f8588e19e24f080c8')),
        }
        self.assertEqual({name: values[name] for name in expected}, expected)

    def test_feature_push_marker_only_and_cross_context_refusal(self):
        for name, ref, message, expected in [
            ('push', api.REF, 'chore: diagnostic '+api.MARKER, True),
            ('push', api.REF, 'ordinary', False),
            ('pull_request', api.REF, api.MARKER, False),
            ('workflow_dispatch', api.REF, api.MARKER, False),
            ('push', 'refs/heads/main', api.MARKER, False),
            ('push', api.REF, api.MARKER+' [zig-native-case]', False),
            ('push', api.REF, api.MARKER+' [zig-svm-prerequisites-only]', False),
            ('push', api.REF, '[zig-native-http-diagnosticX]', False),
        ]:
            with self.subTest(name=name, ref=ref, message=message):
                self.assertIs(api.authorized(name, ref, {'head_commit': {'message': message}}), expected)

    def test_workflow_original_suite_stays_unconditional_and_diagnostic_cannot_heal(self):
        repo = Path(__file__).resolve().parents[2]
        workflow = (repo / '.github/workflows/zig-agents.yml').read_text()
        # Find the precise next job independently of its name.
        lines = workflow.splitlines()
        begin = lines.index('  native-http:')
        end = next((i for i in range(begin+1, len(lines)) if lines[i].startswith('  ') and not lines[i].startswith('   ') and lines[i].endswith(':')), len(lines))
        native = '\n'.join(lines[begin:end])
        original = 'run: python3 zig/tools/native_http_tests.py --timeout-seconds 1200 --diagnostic-dir "$RUNNER_TEMP/native-http-diagnostics" -- python3 zig/tools/zig.py test src/root.zig -j"${BUILD_JOBS}" -OReleaseSafe -lc'
        self.assertEqual(native.count(original), 1)
        self.assertIn('timeout-minutes: 40', native)
        self.assertLess(native.index(original), native.index('- name: Diagnose native HTTP test312'))
        diagnostic = native.split('- name: Diagnose native HTTP test312', 1)[1].split('- uses:', 1)[0]
        self.assertIn("always() && github.event_name == 'push' && github.ref == 'refs/heads/feat/zig-agent-rewrite'", diagnostic)
        self.assertIn("contains(github.event.head_commit.message, '[zig-native-http-diagnostic]')", diagnostic)
        self.assertIn('continue-on-error: true', diagnostic)
        self.assertIn('timeout-minutes: 7', diagnostic)
        self.assertIn('python3 -I -B zig/tools/native_http_312_diagnostic_test.py', diagnostic)
        self.assertIn('python3 -I -B zig/tools/native_http_312_diagnostic.py', diagnostic)
        self.assertNotIn('inputs.', diagnostic)
        self.assertNotIn('source.before', native)
        self.assertNotIn('continue-on-error', native.split('- name: Diagnose native HTTP test312',1)[0])

    def test_payload_exact_decode_and_original_strict_policy_literals(self):
        repo = Path(__file__).resolve().parents[2]
        overlay = api.payload(repo).decode()
        for text in ['.threshold = 8, .max_attempts = 1, .retry_delay_ms = 1', '.max_sessions = 4', '.max_concurrent = 128', '.timeout_ms = 20000', '.connect_timeout_ms = 20000', 'if (path_index < 8)', 'for (8..16) |index| try std.testing.expect(server.pathHits(index) >= 8);']:
            self.assertIn(text, overlay)
        self.assertEqual(overlay.count('diagnostic_events: [2048]DiagnosticEvent'), 1)
        self.assertEqual(api.LOG_LIMIT, 8*1024*1024)


if __name__ == '__main__':
    unittest.main()
