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

    def cleanup_response(self, slot=320, first=400):
        return {'jsonrpc': '2.0', 'id': 1, 'error': {'code': -32001, 'message': f'Block {slot} cleaned up, does not exist on node. First available block: {first}', 'data': None}}

    def cleanup_failure(self, response, params=None, method='getBlock'):
        params = [320] if params is None else params
        with patch.object(evidence, 'direct_request', return_value=response) as request:
            try:
                evidence.rpc('http://127.0.0.1:1', method, params)
            except ValueError as error:
                self.assertIs(type(error), ValueError)
                self.assertEqual(error.args, (MESSAGE,))
                request.assert_called_once_with('http://127.0.0.1:1', {'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params})
                return error
        self.fail('Original RPC guard did not reject response')

    def test_cleanup_numeric_actual_rpc_positive_and_u64_edges(self):
        for slot, first in [(320, 400), (0, 0), (2**64-1, 2**64-1)]:
            with self.subTest(slot=slot, first=first):
                error = self.cleanup_failure(self.cleanup_response(slot, first), [slot, {'encoding': 'json'}])
                self.assertEqual(self.project(error)['canonical_block_rpc_error'], {'code': -32001, 'queried_slot': slot, 'first_available_block': first})
                self.assertEqual(error.__dict__['_canonical_block_cleanup_slots'], (evidence.rpc.__code__, evidence.require.__code__, slot, first))
                self.assertTrue(all(type(v) is int or isinstance(v, types.CodeType) for v in error.__dict__['_canonical_block_cleanup_slots']))

    def test_cleanup_numeric_strict_formatter_poison_keeps_code_only(self):
        good = self.cleanup_response()['error']['message']
        messages = [None, 7, b'private', 'SECRET_SENTINEL', 'x'+good, good+'\n', good+' SECRET_SENTINEL', good.replace('320', '0320'), good.replace('320', '+320'), good.replace('320', '-320'), good.replace('320', '３２０'), good.replace('400', str(2**64)), good.replace('320', '9'*10000), good.replace('First available', 'first available')]
        for message in messages:
            response = self.cleanup_response(); response['error']['message'] = message
            with self.subTest(message_type=type(message).__name__):
                error = self.cleanup_failure(response)
                self.assertNotIn('_canonical_block_cleanup_slots', error.__dict__)
                self.assertEqual(self.project(error)['canonical_block_rpc_error'], {'code': -32001})
                self.assertNotIn('SECRET_SENTINEL', json.dumps(self.project(error)))
        response = self.cleanup_response(); response['error']['data'] = {'private': 'SECRET_SENTINEL'}
        self.assertEqual(self.project(self.cleanup_failure(response))['canonical_block_rpc_error'], {'code': -32001})

    def test_cleanup_numeric_params_code_envelope_crossmethod_poison(self):
        for params in [[321], [True], [-1], [320.0], ['320'], [2**64], [], [320, {}, {}], (320,)]:
            error = self.cleanup_failure(self.cleanup_response(), params)
            self.assertEqual(self.project(error)['canonical_block_rpc_error'], {'code': -32001})
        for code in [-32004, -32007, True, '-32001', -32001.0, 2]:
            response = self.cleanup_response(); response['error']['code'] = code
            projected = self.project(self.cleanup_failure(response))['canonical_block_rpc_error']
            self.assertEqual(projected, {'code': code if type(code) is int and code in {-32004, -32007} else 'unknown'})
        for mutate in [lambda r:r.update(id=True), lambda r:r.update(jsonrpc='1.0'), lambda r:r.update(result=None)]:
            response = self.cleanup_response(); mutate(response)
            self.assertEqual(self.project(self.cleanup_failure(response))['canonical_block_rpc_error'], {'code': 'unknown'})
        other = self.cleanup_failure(self.cleanup_response(), [320], 'getSignaturesForAddress')
        self.assertNotIn('_canonical_block_cleanup_slots', other.__dict__)
        self.assertNotIn('canonical_block_rpc_error', self.project(other))

    def test_cleanup_numeric_pair_and_source_poison_preserve_old_code(self):
        poison = [None, [], (evidence.rpc.__code__, evidence.require.__code__, True, 400), (evidence.rpc.__code__, evidence.require.__code__, -1, 400), (evidence.rpc.__code__, evidence.require.__code__, 320, 2**64), (evidence.rpc.__code__, evidence.require.__code__, 320.0, 400), ('rpc', 'require', 320, 400), (evidence.require.__code__, evidence.rpc.__code__, 320, 400), (evidence.rpc.__code__, evidence.require.__code__, 320)]
        for pair in poison:
            error = self.cleanup_failure(self.cleanup_response()); error.__dict__['_canonical_block_cleanup_slots'] = pair
            self.assertEqual(self.project(error)['canonical_block_rpc_error'], {'code': -32001})
        real = self.cleanup_failure(self.cleanup_response())
        forged = ValueError(MESSAGE); forged.__dict__.update(real.__dict__)
        try:
            raise forged
        except ValueError as error:
            self.assertNotIn('canonical_block_rpc_error', self.project(error))
        bad = copy.deepcopy(self.modules); bad['multivm_evidence.py']['sha256'] = '0'*64
        self.assertNotIn('canonical_block_rpc_error', self.project(real, bad))
        # Rebinding a previously used error cannot carry forward stale slots.
        evidence._bind_canonical_block_rpc_error(real, 'getBlock', self.response(-32001), [320])
        self.assertNotIn('_canonical_block_cleanup_slots', real.__dict__)
        self.assertEqual(self.project(real)['canonical_block_rpc_error'], {'code': -32001})
        # Optional numeric metadata failure must preserve already-valid code.
        real = self.cleanup_failure(self.cleanup_response())
        with patch.object(diagnostics, 'all', side_effect=KeyboardInterrupt('SECRET_SENTINEL'), create=True):
            self.assertEqual(self.project(real)['canonical_block_rpc_error'], {'code': -32001})

    def test_cleanup_numeric_primary_identity_success_and_no_extra_request(self):
        original = evidence.require; seen = []
        def require(condition, message):
            try:
                original(condition, message)
            except ValueError as error:
                seen.append(error); raise
        with patch.object(evidence, 'require', side_effect=require), patch.object(evidence, '_bind_canonical_block_rpc_error', side_effect=KeyboardInterrupt('SECRET_SENTINEL')):
            error = self.cleanup_failure(self.cleanup_response())
            self.assertIs(error, seen[-1]); self.assertNotIn('_canonical_block_cleanup_slots', error.__dict__)
        with patch.object(evidence, 'direct_request', return_value={'id': 1, 'result': {'ok': 7}}) as request:
            self.assertEqual(evidence.rpc('http://127.0.0.1:1', 'getBlock', [320]), {'ok': 7})
            self.assertEqual(request.call_count, 1)

    def test_cleanup_numeric_closed_record_schema_and_old_code_unchanged(self):
        result = self.record(self.cleanup_failure(self.cleanup_response()))
        self.assertEqual(diagnostics.validate_record(result, self.modules), result)
        self.assertEqual(result['last_stage']['canonical_block_rpc_error'], {'code': -32001, 'queried_slot': 320, 'first_available_block': 400})
        for value in [{'code': -32001, 'queried_slot': True, 'first_available_block': 400}, {'code': -32001, 'queried_slot': 320}, {'code': -32004, 'queried_slot': 320, 'first_available_block': 400}, {'code': -32001, 'queried_slot': 320, 'first_available_block': 2**64}, {'code': -32001, 'queried_slot': 320, 'first_available_block': 400, 'message': 'SECRET_SENTINEL'}]:
            bad = copy.deepcopy(result); bad['last_stage']['canonical_block_rpc_error'] = value
            with self.assertRaises(ValueError): diagnostics.validate_record(bad, self.modules)
        old = self.record(self.failure(self.response(-32001)))
        self.assertEqual(old['last_stage']['canonical_block_rpc_error'], {'code': -32001})
        self.assertEqual(diagnostics.validate_record(old, self.modules), old)

    def test_cleanup_numeric_original_cap_drops_pair_not_old_code(self):
        value = self.record(self.cleanup_failure(self.cleanup_response()))
        # Padding is a synthetic local fixture, never an admitted public field.
        # Pick a cap between the exact original code-only and extended bodies.
        original = copy.deepcopy(value)
        for row in [original['last_stage'], *[v for group in ['stages','failures'] for g in original[group].values() for v in [g.get('first'),g.get('latest')]]]:
            if type(row) is dict and 'canonical_block_rpc_error' in row:
                row['canonical_block_rpc_error'] = {'code': -32001}
        size = len(json.dumps(original, sort_keys=True, separators=(',', ':')).encode())+1
        with patch.object(diagnostics, 'LIMIT', size): diagnostics.trim_optional_canonical_block_slots(value)
        self.assertEqual(value, original)
        self.assertEqual(value['last_stage']['canonical_block_rpc_error'], {'code': -32001})
        # Exercise the actual 256KiB boundary too. Synthetic padding is only
        # a serialization size model; no admission of this extra key is claimed.
        real = copy.deepcopy(original); real['size_model_padding'] = ''
        empty = len(json.dumps(real, sort_keys=True, separators=(',', ':')).encode())+1
        real['size_model_padding'] = 'x'*(diagnostics.LIMIT-empty)
        self.assertEqual(len(json.dumps(real, sort_keys=True, separators=(',', ':')).encode())+1, 256*1024)
        extended = copy.deepcopy(real)
        extended['last_stage']['canonical_block_rpc_error'].update(queried_slot=320, first_available_block=400)
        diagnostics.trim_optional_canonical_block_slots(extended)
        self.assertEqual(extended, real)
        # Still reject an independently overbound old record; no cap waiver.
        with tempfile.TemporaryDirectory() as directory:
            recorder = diagnostics.Recorder(Path(directory)/'observer.json', self.modules, HERE)
            recorder.value = value
            with patch.object(diagnostics, 'LIMIT', size-1), self.assertRaises(ValueError): recorder.save()



if __name__ == '__main__':
    unittest.main()
