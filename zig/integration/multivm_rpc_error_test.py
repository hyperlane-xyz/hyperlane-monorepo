"""Pure canonical-block RPC error projection controls; no RPC is performed."""
from pathlib import Path
import copy
import json
import tempfile
import types
import unittest
from unittest.mock import patch

import multivm_evidence as evidence
import multivm_diagnostics as diagnostics

HERE = Path(__file__).resolve().parent
ATTRIBUTE = '_canonical_block_rpc_error'
MESSAGE = 'native JSONRPC error/identity mismatch'


class CanonicalBlockRpcErrorTests(unittest.TestCase):
    def setUp(self):
        self.modules = {'multivm_evidence.py': diagnostics.pin(HERE / 'multivm_evidence.py')}

    def failure(self, response, method='getBlock'):
        with patch.object(evidence, 'direct_request', return_value=response) as request:
            try:
                evidence.rpc('http://127.0.0.1:1', method, [320])
            except ValueError as error:
                self.assertIs(type(error), ValueError)
                self.assertEqual(error.args, (MESSAGE,))
                request.assert_called_once_with('http://127.0.0.1:1', {'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': [320]})
                return error
        self.fail('Original RPC guard did not reject response')

    def response(self, code):
        return {'jsonrpc': '2.0', 'id': 1, 'error': {'code': code, 'message': 'SECRET_SENTINEL', 'data': {'private': 'SECRET_SENTINEL'}}}

    def project(self, error, modules=None):
        return diagnostics.public_frames(error, self.modules if modules is None else modules, HERE)

    def test_closed_codes_and_no_raw_references(self):
        for code in (-32001, -32004, -32007):
            with self.subTest(code=code):
                response = self.response(code)
                error = self.failure(response)
                origin, guard, observed = error.__dict__[ATTRIBUTE]
                self.assertIs(origin, evidence.rpc.__code__)
                self.assertIs(guard, evidence.require.__code__)
                self.assertEqual(observed, code)
                self.assertEqual(set(error.__dict__), {ATTRIBUTE})
                self.assertTrue(all(isinstance(v, types.CodeType) or type(v) is int for v in error.__dict__[ATTRIBUTE]))
                projected = self.project(error)
                self.assertEqual(projected['canonical_block_rpc_error'], {'code': code})
                self.assertNotIn('SECRET_SENTINEL', json.dumps(projected))

    def test_unknown_codes_and_malformed_envelopes_preserve_original_guard(self):
        rows = [self.response(v) for v in (True, False, 1.0, -32001.0, '-32001', -32002, None, {}, [])]
        rows += [None, [], {'id': 1}, {'id': True, 'error': {'code': -32001}}, {'id': 2, 'jsonrpc': '2.0', 'error': {'code': -32001}}, {'id': 1, 'jsonrpc': '1.0', 'error': {'code': -32001}}, {'id': 1, 'jsonrpc': '2.0', 'error': {'code': -32001}, 'result': None}]
        for response in rows:
            with self.subTest(response=response):
                self.assertEqual(self.project(self.failure(response))['canonical_block_rpc_error'], {'code': 'unknown'})

    def test_success_and_other_methods_unchanged(self):
        for identity in (1, True):  # Preserve the original guard's existing equality.
            with patch.object(evidence, 'direct_request', return_value={'id': identity, 'result': {'ok': 7}}) as request:
                self.assertEqual(evidence.rpc('http://127.0.0.1:1', 'getBlock', [320]), {'ok': 7})
                self.assertEqual(request.call_count, 1)
        error = self.failure(self.response(-32001), 'getSignaturesForAddress')
        self.assertNotIn(ATTRIBUTE, error.__dict__)
        self.assertNotIn('canonical_block_rpc_error', self.project(error))

    def test_original_error_identity_and_optional_failure(self):
        original_require = evidence.require
        observed = []
        def require(condition, message):
            try:
                original_require(condition, message)
            except ValueError as error:
                observed.append(error)
                raise
        for optional in (KeyboardInterrupt('private'), ValueError('private')):
            with patch.object(evidence, 'require', side_effect=require), patch.object(evidence, '_bind_canonical_block_rpc_error', side_effect=optional):
                error = self.failure(self.response(-32001))
                self.assertIs(error, observed[-1])
                self.assertNotIn(ATTRIBUTE, error.__dict__)
        transport = ValueError('transport private')
        with patch.object(evidence, 'direct_request', side_effect=transport):
            try:
                evidence.rpc('http://127.0.0.1:1', 'getBlock', [320])
            except ValueError as error:
                self.assertIs(error, transport)
                self.assertNotIn(ATTRIBUTE, error.__dict__)

    def test_false_source_and_nonadjacent_guard_refused(self):
        real = self.failure(self.response(-32001))
        forged = ValueError(MESSAGE)
        forged.__dict__[ATTRIBUTE] = real.__dict__[ATTRIBUTE]
        try:
            raise forged
        except ValueError as error:
            self.assertNotIn('canonical_block_rpc_error', self.project(error))
        def callback(*args, **kwargs):
            try:
                evidence.require(False, MESSAGE)
            except ValueError as error:
                error.__dict__[ATTRIBUTE] = real.__dict__[ATTRIBUTE]
                raise
        with patch.object(evidence, 'direct_request', side_effect=callback):
            try:
                evidence.rpc('http://127.0.0.1:1', 'getBlock', [320])
            except ValueError as error:
                self.assertNotIn('canonical_block_rpc_error', self.project(error))
        scope = {'ValueError': ValueError, 'MESSAGE': MESSAGE, 'ATTRIBUTE': ATTRIBUTE}
        exec(compile('def require():\n raise ValueError(MESSAGE)\ndef rpc():\n try: require()\n except ValueError as error:\n  error.__dict__[ATTRIBUTE]=(rpc.__code__,require.__code__,-32001)\n  raise\n', evidence.__file__, 'exec'), scope)
        try:
            scope['rpc']()
        except ValueError as error:
            self.assertNotIn('canonical_block_rpc_error', self.project(error))
        bad = copy.deepcopy(self.modules)
        bad['multivm_evidence.py']['sha256'] = '0' * 64
        self.assertNotIn('canonical_block_rpc_error', self.project(real, bad))

    def test_private_attribute_poison_refused(self):
        for value in (None, [], (evidence.rpc.__code__, evidence.require.__code__, True), (evidence.rpc.__code__, evidence.require.__code__, -32001.0), (evidence.rpc.__code__, evidence.require.__code__, '-32001'), (evidence.rpc.__code__, evidence.require.__code__, -1), ('rpc', 'require', -32001)):
            with self.subTest(value=value):
                error = self.failure(self.response(-32001))
                error.__dict__[ATTRIBUTE] = value
                self.assertNotIn('canonical_block_rpc_error', self.project(error))

    def record(self, error=None):
        state = {'observed_monotonic_ns': 1, 'restart_sample_count': 0, 'restart_failed': False, 'restart_first_observed_ns': None, 'restart_last_observed_ns': None, 'role_activity': [], 'observer_failure_count': 0, 'lifecycle_error_count': 0}
        with tempfile.TemporaryDirectory() as directory:
            recorder = diagnostics.Recorder(Path(directory) / 'observer.json', self.modules, HERE)
            token = recorder.enter('before_restart', state)
            recorder.finish(token, dict(state, observed_monotonic_ns=2), 'exception' if error else 'completed', error)
            result = json.loads(recorder.path.read_text())
        return result

    def test_recorder_closed_schema_privacy_and_success(self):
        value = self.record(self.failure(self.response(-32001)))
        self.assertEqual(diagnostics.validate_record(value, self.modules), value)
        self.assertNotIn('SECRET_SENTINEL', json.dumps(value))
        self.assertEqual(value['last_stage']['canonical_block_rpc_error'], {'code': -32001})
        success = self.record()
        diagnostics.validate_record(success, self.modules)
        self.assertNotIn('canonical_block_rpc_error', success['last_stage'])
        for replacement in ({'code': True}, {'code': -32001.0}, {'code': -1}, {'code': '-32001'}, {'code': -32001, 'data': 'private'}):
            bad = copy.deepcopy(value)
            bad['last_stage']['canonical_block_rpc_error'] = replacement
            with self.subTest(replacement=replacement), self.assertRaises(ValueError):
                diagnostics.validate_record(bad, self.modules)
        for mutation in ('exception', 'source', 'frame'):
            bad = copy.deepcopy(value)
            if mutation == 'exception': bad['last_stage']['exception_type'] = 'TypeError'
            elif mutation == 'source': bad['last_stage']['frames'][0]['source']['sha256'] = '0' * 64
            else: bad['last_stage']['frames'] = []
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                diagnostics.validate_record(bad, self.modules)


if __name__ == '__main__':
    unittest.main()
