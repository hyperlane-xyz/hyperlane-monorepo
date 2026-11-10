"""Pure owned-observer hard-latch/serve controls; no sockets, threads or children."""
from pathlib import Path
import ast
import hashlib
import io
import json
import re
import signal
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import multivm_evidence as evidence
import multivm_process as process
import multivm_session as sessions

FAILURE = 'actual observer hard failure latched'


class ObserverHardLatchTests(unittest.TestCase):
    def session(self, trace=None):
        trace = [] if trace is None else trace
        value = sessions.Session.__new__(sessions.Session)
        value.lock = threading.RLock()
        value.failures = []
        value.hard_failure_latched = threading.Event()
        value.stop = threading.Event()
        value._init_restart_sampler()
        value.manifest = {'scenario': 'evm'}
        value.transport_notices = []
        value.append = mock.Mock()
        value.diagnostic = mock.Mock(return_value=None)
        value.sampler = SimpleNamespace(join=lambda **kw: trace.append('sampler-join'), is_alive=lambda: False)
        value.proxies = [SimpleNamespace(close=lambda: trace.append('proxy-close'))]
        return value

    def test_real_constructor_initializes_unset_independent_event_without_starting_thread(self):
        with tempfile.TemporaryDirectory(dir='/tmp') as directory:
            root = Path(directory).resolve()
            case = root / 'case.json'
            case.write_text(json.dumps({'schema': 1, 'scenario': 'evm'}))
            body = case.read_bytes()
            manifest = {'scenario': 'evm', 'task_root': str(root), 'case_inputs': {'path': str(case), 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()}, 'verifier': {'evidence_root': str(root / 'evidence')}}
            def create(task_root, relative):
                path = Path(task_root) / relative
                path.mkdir()
                return path
            with mock.patch.object(sessions, 'read_approval', return_value={}), mock.patch.object(sessions, 'validate_evidence_nodes', return_value={}), mock.patch.object(sessions.threading, 'Thread') as thread:
                value = sessions.Session(manifest, lambda r, n: Path(r) / n, create, adapter=SimpleNamespace(validate_case=lambda: None))
            self.assertFalse(value.hard_failure_latched.is_set())
            self.assertIsNot(value.hard_failure_latched, value.stop)
            self.assertEqual(value.failures, [])
            thread.return_value.start.assert_called_once_with()

    def test_hard_append_sets_sticky_event_before_optional_journal_failure(self):
        value = self.session()
        value.append.side_effect = OSError('synthetic journal failure')
        with self.assertRaisesRegex(OSError, 'synthetic journal'):
            value.failure('fixed public hard failure')
        self.assertEqual(value.failures, ['fixed public hard failure'])
        self.assertTrue(value.hard_failure_latched.is_set())
        value.append.side_effect = None
        value.failure({'kind': 'peer_disconnect'})
        self.assertTrue(value.hard_failure_latched.is_set())
        self.assertEqual(len(value.failures), 1)

    def test_peer_and_both_approved_unavailable_filters_do_not_latch(self):
        value = self.session()
        value.failure({'kind': 'peer_disconnect'})
        self.assertFalse(value.hard_failure_latched.is_set())
        definition = {'chain': 'cosmostest99990', 'domain': 99990, 'field': 'grpcurls', 'ordinal': 0, 'upstream': 'http://localhost:1337', 'healthy_fallback': 'http://127.0.0.1:26603', 'error_type': 'ConnectionRefusedError', 'phase': 'upstream_connect'}
        value.manifest = {'scenario': 'cosmwasm', 'case_inputs': {'sha256': 'a' * 64}}
        value.expected_unavailable_definitions = [definition]
        value.expected_unavailable_notices = []
        context = dict(definition, scenario='cosmwasm', role='relayer', case_inputs_sha256='a' * 64)
        value.failure({'kind': 'expected_source_endpoint_unavailable', 'context': context, 'error_type': 'ConnectionRefusedError', 'monotonic_ns': 1, 'positive_receipt_credit': False})
        self.assertFalse(value.hard_failure_latched.is_set())
        definition = evidence.starknet_unavailable_peers()[0]
        value.manifest['scenario'] = 'starknet'
        value.starknet_unavailable_definitions = [definition]
        value.starknet_unavailable_notices = []
        context = dict(definition, scenario='starknet', role='relayer', case_inputs_sha256='a' * 64)
        value.failure({'kind': 'expected_starknet_rpc_endpoint_unavailable', 'context': context, 'error_type': 'ConnectionRefusedError', 'monotonic_ns': 1, 'positive_receipt_credit': False})
        self.assertFalse(value.hard_failure_latched.is_set())
        self.assertEqual(value.failures, [])

    def test_provisional_restart_exception_does_not_become_generic_hard_latch(self):
        value = self.session()
        value.restart_window = sessions.RestartWindow()
        value.restart_deadline_ns = 1000
        value._restart_sample_once = mock.Mock(side_effect=ValueError('ordinary incomplete readiness'))
        with mock.patch.object(sessions.time, 'monotonic_ns', return_value=100), mock.patch.object(value.restart_live_stop, 'wait', side_effect=lambda timeout: value.restart_live_stop.set()):
            value._restart_sample_loop()
        self.assertIsNone(value.restart_live_error)
        self.assertFalse(value.restart_window.failed)
        self.assertFalse(value.hard_failure_latched.is_set())
        self.assertEqual(value.failures, [])

    def test_ordinary_sampler_cancel_does_not_append_or_set_hard_latch(self):
        value = self.session()
        value.captures = [{'original': {'role': 'relayer', 'chains': {'public': {}}, 'metrics_port': 1}}]
        value.lifecycle = SimpleNamespace(first={'fixture': 1}, sample_deadline=lambda *a: 1000)
        value.sampling_finished = False
        def cancelled(*args):
            value.stop.set()
            raise ValueError('ordinary shutdown cancellation')
        with mock.patch.object(value.stop, 'wait', return_value=False), mock.patch.object(sessions, 'collect_admin_sample', side_effect=cancelled):
            value._sample()
        self.assertFalse(value.hard_failure_latched.is_set())
        self.assertEqual(value.failures, [])

    def test_actual_sampler_hard_failure_latches_then_serve_drains_nonzero(self):
        value = self.session()
        value.captures = [{'original': {'role': 'relayer', 'chains': {'public': {}}, 'metrics_port': 1}}]
        value.lifecycle = SimpleNamespace(first={'fixture': 1}, sample_deadline=lambda *a: 1000)
        value.sampling_finished = False
        with mock.patch.object(value.stop, 'wait', return_value=False), mock.patch.object(sessions, 'collect_admin_sample', side_effect=ValueError('fixed whole-sample failure')):
            value._sample()
        self.assertTrue(value.hard_failure_latched.is_set())
        self.assertEqual(value.failures, ['ValueError: fixed whole-sample failure'])
        state = self.serve(value)
        self.assertIs(type(state.caught), ValueError)
        self.assertEqual(str(state.caught), FAILURE)
        self.assertEqual(state.iterations, 0)
        self.assert_drained(state)

    def serve(self, value, step=None, close_hook=None, stop_on_install=False):
        """Run actual serve/finally with only socket/signal boundaries simulated."""
        trace = []
        value.sampler = SimpleNamespace(join=lambda **kw: trace.append('sampler-join'), is_alive=lambda: False)
        value.proxies = [SimpleNamespace(close=lambda: (trace.append('proxy-close'), close_hook() if close_hook else None))]
        handlers = {}
        calls = []
        original_signal = {signal.SIGTERM: object(), signal.SIGINT: object()}
        def install(number, handler):
            previous = handlers.get(number, original_signal[number])
            handlers[number] = handler
            calls.append(number)
            if stop_on_install and number == signal.SIGTERM and callable(handler):
                handler(number, None)
            return previous
        with tempfile.TemporaryDirectory(prefix='ol-', dir='/tmp') as directory:
            root = Path(directory).resolve()
            manifest = {'scenario': 'evm', 'mode': 'ReleaseSafe', 'task_root': str(root), 'runtime_source_commit': 'a' * 40, 'execution_approval': {}, 'verifier': {'evidence_root': str(root / 'evidence'), 'python': {}}}
            value.manifest = manifest
            socket_path = root / 'evidence/controller.sock'
            state = SimpleNamespace(iterations=0, reply=None)
            class FakeUnixServer:
                def __init__(self, path, handler):
                    Path(path).write_bytes(b'public simulated socket inode')
                    self.handler = handler
                    trace.append('server-init')
                def handle_request(self):
                    state.iterations += 1
                    trace.append('handle-request')
                    if step is None:
                        raise AssertionError('OLD_LOOP_WAITED_AFTER_HARD_LATCH')
                    if state.iterations > 3:
                        raise AssertionError('bounded simulated loop')
                    step(value, state, handlers, self.handler, root)
                def server_close(self):
                    trace.append('server-close')
            caught = None
            with mock.patch.object(process.multivm_evidence, 'read_approval', return_value={'python_modules': {}}), mock.patch.object(process.multivm_session, 'Session', return_value=value), mock.patch.object(process.socketserver, 'UnixStreamServer', FakeUnixServer), mock.patch.object(process.signal, 'signal', side_effect=install), mock.patch.object(process.stat, 'S_ISSOCK', return_value=True):
                try:
                    process.serve(manifest)
                except BaseException as error:
                    caught = error
            state.trace = trace
            state.caught = caught
            state.socket_removed = not socket_path.exists()
            state.signal_handlers_restored = all(handlers.get(k) is v for k, v in original_signal.items())
            return state

    def assert_drained(self, state):
        self.assertTrue(state.socket_removed)
        self.assertTrue(state.signal_handlers_restored)
        self.assertEqual(state.trace[-3:], ['server-close', 'sampler-join', 'proxy-close'])

    def test_preexisting_hard_latch_exits_before_next_wait_and_drains(self):
        value = self.session()
        value.failure('fixed public hard failure')
        state = self.serve(value)
        self.assertIs(type(state.caught), ValueError)
        self.assertEqual(str(state.caught), FAILURE)
        self.assertEqual(state.iterations, 0)
        self.assert_drained(state)

    def test_latch_during_tick_exits_before_second_wait(self):
        value = self.session()
        state = self.serve(value, step=lambda v, *args: v.failure('fixed public hard failure'))
        self.assertIs(type(state.caught), ValueError)
        self.assertEqual(str(state.caught), FAILURE)
        self.assertEqual(state.iterations, 1)
        self.assert_drained(state)

    def test_normal_stop_before_first_loop_work_remains_normal(self):
        state = self.serve(self.session(), stop_on_install=True)
        self.assertIsNone(state.caught)
        self.assertEqual(state.iterations, 0)
        self.assert_drained(state)

    def test_normal_stop_wins_loop_without_erasing_hard_latch(self):
        value = self.session()
        def stop_and_fail(v, state, handlers, *args):
            handlers[signal.SIGTERM](signal.SIGTERM, None)
            v.failure('fixed public hard failure')
        state = self.serve(value, step=stop_and_fail)
        self.assertEqual(state.iterations, 1)
        self.assertIs(type(state.caught), ValueError)
        self.assertEqual(str(state.caught), FAILURE)
        self.assert_drained(state)

    def test_late_hard_latch_during_close_remains_nonzero(self):
        value = self.session()
        state = self.serve(value, step=lambda v, s, h, *a: h[signal.SIGTERM](signal.SIGTERM, None), close_hook=lambda: value.failure('fixed public drain failure'))
        self.assertTrue(value.stop.is_set())
        self.assertIs(type(state.caught), ValueError)
        self.assertEqual(str(state.caught), FAILURE)
        self.assert_drained(state)

    def test_original_cleanup_exception_is_preserved_without_absence_credit(self):
        value = self.session()
        error = OSError('fixed synthetic cleanup failure')
        def failed_close():
            raise error
        state = self.serve(value, step=lambda v, s, h, *a: h[signal.SIGTERM](signal.SIGTERM, None), close_hook=failed_close)
        self.assertIs(state.caught, error)
        self.assertIn('server-close', state.trace)
        self.assertIn('sampler-join', state.trace)
        self.assertFalse(state.socket_removed)  # Original cleanup fence remains unresolved.

    def request(self, handler_class, root, payload):
        token = json.loads((root / 'evidence/controller.json').read_text())['controller_token']
        handler = handler_class.__new__(handler_class)
        handler.rfile = io.BytesIO(json.dumps(dict(payload, controller_token=token)).encode() + b'\n')
        handler.wfile = io.BytesIO()
        handler.handle()
        return json.loads(handler.wfile.getvalue())

    def test_normal_final_reply_and_close_without_hard_append_are_unchanged(self):
        value = self.session()
        value.verify = mock.Mock(return_value={'verified': True, 'stage': 'final'})
        def final(v, state, handlers, handler, root):
            state.reply = self.request(handler, root, {'action': 'verify', 'payload': {'stage': 'final', 'expected': 0, 'harness_parent': {}}})
            handlers[signal.SIGTERM](signal.SIGTERM, None)
        state = self.serve(value, step=final)
        self.assertIsNone(state.caught)
        self.assertEqual(state.reply, {'ok': True, 'result': {'verified': True, 'stage': 'final'}})
        self.assertFalse(value.hard_failure_latched.is_set())
        self.assert_drained(state)

    def test_final_reply_cannot_erase_later_actual_hard_append(self):
        value = self.session()
        value.verify = mock.Mock(return_value={'verified': True, 'stage': 'final'})
        def final(v, state, handlers, handler, root):
            state.reply = self.request(handler, root, {'action': 'verify', 'payload': {'stage': 'final', 'expected': 0, 'harness_parent': {}}})
            v.failure('fixed public late failure')
            handlers[signal.SIGTERM](signal.SIGTERM, None)
        state = self.serve(value, step=final)
        self.assertIs(type(state.caught), ValueError)
        self.assertEqual(str(state.caught), FAILURE)
        self.assertTrue(state.reply['ok'])  # A controller reply is not case acceptance.
        self.assert_drained(state)

    def test_provisional_request_error_does_not_latch_and_no_status_action_added(self):
        for action in ['verify', 'hard-failure-status']:
            value = self.session()
            value.verify = mock.Mock(side_effect=ValueError('ordinary provisional request failure'))
            def request(v, state, handlers, handler, root):
                state.reply = self.request(handler, root, {'action': action, 'payload': {'stage': 'after_restart', 'expected': 0, 'harness_parent': {}}})
                handlers[signal.SIGTERM](signal.SIGTERM, None)
            state = self.serve(value, step=request)
            self.assertIsNone(state.caught)
            self.assertFalse(state.reply['ok'])
            self.assertFalse(value.hard_failure_latched.is_set())
            self.assertEqual(value.failures, [])
            self.assert_drained(state)

    def test_workflow_exact_once_invocation_inverse_and_poisons(self):
        root = HERE.parents[1]
        text = (root / '.github/workflows/zig-agents.yml').read_text()
        command = '          python3 -I -B -W error zig/integration/multivm_observer_latch_test.py -v\n'
        self.assertEqual(text.count(command), 1)
        self.assertIn('          python3 -I -B zig/integration/multivm_diagnostics_test.py -v\n' + command, text)
        functions = []
        normalized = []
        for name in ['zig/bench/paired_linux_test.py', 'zig/tools/aleo_linux_case/ci_fullcase_test.py']:
            node = next(n for n in ast.parse((root / name).read_text()).body if isinstance(n, ast.FunctionDef) and n.name == 'ordinary_native_http_workflow')
            functions.append(ast.dump(node, include_attributes=False))
            scope = {'hashlib': hashlib, 're': re}
            exec(compile(ast.Module(body=[node], type_ignores=[]), 'actual-reviewed-workflow-inverse', 'exec'), scope)
            inverse = scope['ordinary_native_http_workflow']
            normalized.append(inverse(text))
            for changed in [text.replace(command, '', 1), text.replace(command, command * 2, 1), text.replace(command, command.replace('-W error ', ''), 1)]:
                with self.assertRaises(AssertionError): inverse(changed)
        self.assertEqual(functions[0], functions[1])
        self.assertEqual(normalized[0], normalized[1])
        self.assertEqual(hashlib.sha256(normalized[0].encode()).hexdigest(), 'e08ffd005159dd3915047706df9a1806b' '13cf3344795e5700980910bc38f9ef3')


if __name__ == '__main__':
    unittest.main(verbosity=2)
