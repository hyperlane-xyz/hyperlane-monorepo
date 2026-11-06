#!/usr/bin/env python3
"""Pure gas-proof capture/selection and durable-progress controls; no agent/RPC execution."""
import ast
import copy
import hashlib
import json
import math
import os
import pathlib
import re
import tempfile
import threading
import time
import types
import unittest

SOURCE = pathlib.Path(__file__).with_name('relayer_process.py')
NAMES = {'chunks', 'sha', 'record_first_inclusion', 'capture_proxy_response', 'rpc_snapshot', 'write_snapshot', 'existing_snapshot', 'persist_progress', 'persist_failure', 'finish_result', 'original_estimate'}
TREE = ast.parse(SOURCE.read_text())
MODULE = ast.Module(body=[node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name in NAMES], type_ignores=[])
API = dict(copy=copy, hashlib=hashlib, json=json, math=math, os=os, pathlib=pathlib, re=re, time=time, DELIVERED_SELECTOR='0x12345678')
exec(compile(MODULE, str(SOURCE), 'exec'), API)


class EstimateTests(unittest.TestCase):
    def setUp(self):
        self.proxy = types.SimpleNamespace(trace_lock=threading.Lock(), rpc_log=[], estimates=[], broadcasts=[], raw_transactions=[], receipt_inclusions={}, delivered_inclusions={})
        self.call = {'from': '0x'+'11'*20, 'to': '0x'+'22'*20, 'data': '0xabcd'}
        self.tx = '0x'+'33'*32
        self.capture('eth_estimateGas', [self.call], '0x10', 1, 10, 11)
        self.capture('eth_sendRawTransaction', ['0xdead'], self.tx, 2, 20, 21)

    def capture(self, method, params, result, identity, start, end, error=None):
        request = {'jsonrpc': '2.0', 'id': identity, 'method': method, 'params': copy.deepcopy(params)}
        response = dict(jsonrpc='2.0', id=identity, **({'error': error} if error else {'result': result}))
        original_time = API['time']
        API['time'] = types.SimpleNamespace(monotonic=lambda: end, time=lambda: end+1000)
        try:
            API['capture_proxy_response'](self.proxy, method, request, json.dumps(response), start+1000, start)
        finally:
            API['time'] = original_time

    def select(self):
        return API['original_estimate'](self.proxy, self.call['data'], self.call['from'], self.call['to'], self.tx)

    def test_lander_different_value_is_retained_but_prepare_alone_selected(self):
        self.capture('eth_estimateGas', [dict(self.call, value='0x0', gasPrice='0x1')], '0x999', 3, 12, 13)
        selected = self.select()
        self.assertEqual(selected['result'], '0x10')
        self.assertEqual(len(selected['matching_estimate_attempts']), 2)
        self.assertEqual(selected['broadcast_requested_monotonic_seconds'], 20)
        self.assertEqual(selected['request']['params'], [self.call])

    def test_duplicate_successful_prepare_is_ambiguous_even_when_equal(self):
        self.capture('eth_estimateGas', [self.call], '0x10', 3, 12, 13)
        with self.assertRaisesRegex(AssertionError, 'unique prebroadcast'):
            self.select()

    def test_error_attempt_retained_and_never_used_as_weight(self):
        self.capture('eth_estimateGas', [self.call], None, 3, 12, 13, {'code': -32000, 'message': 'fixture retry'})
        self.assertEqual(len(self.select()['matching_estimate_attempts']), 2)
        self.proxy.estimates = self.proxy.estimates[1:]
        with self.assertRaises(AssertionError):
            self.select()

    def test_wrong_shapes_cannot_be_only_prepare(self):
        for params in [[dict(self.call, value='0x0')], [self.call, 'latest']]:
            with self.subTest(params=params):
                self.proxy.estimates.clear()
                self.capture('eth_estimateGas', params, '0x10', 3, 12, 13)
                with self.assertRaises(AssertionError):
                    self.select()

    def test_postbroadcast_and_equal_completion_fail_closed(self):
        for completed in (20, 21):
            self.proxy.estimates[0]['completed_monotonic_seconds'] = completed
            with self.assertRaises(AssertionError):
                self.select()

    def test_first_matching_broadcast_controls_even_when_later_rebroadcast_exists(self):
        self.capture('eth_sendRawTransaction', ['0xdead'], self.tx, 3, 30, 31)
        self.proxy.estimates[0]['completed_monotonic_seconds'] = 25
        with self.assertRaises(AssertionError):
            self.select()

    def test_malformed_identity_result_and_envelope_reject(self):
        original = copy.deepcopy(self.proxy.estimates[0])
        for mutate in (
            lambda row: row['response'].update(id=99),
            lambda row: row['response'].update(id=True),
            lambda row: row['response'].update(result='bad'),
            lambda row: row['response'].update(error={'code': 1, 'message': 'both'}),
            lambda row: row.update(result='0x999'),
            lambda row: row['request']['params'][0].update(to='0x'+'44'*20),
            lambda row: row.update(completed_monotonic_seconds=float('nan')),
        ):
            self.proxy.estimates = [copy.deepcopy(original)]
            mutate(self.proxy.estimates[0])
            with self.assertRaises(AssertionError):
                self.select()

    def test_nonmatching_identity_cannot_supply_weight(self):
        self.proxy.estimates[0].update(to='0x'+'44'*20)
        self.proxy.estimates[0]['request']['params'][0]['to'] = '0x'+'44'*20
        with self.assertRaises(AssertionError):
            self.select()

    def test_full_capture_preserves_request_response_clocks_and_completion_sequence(self):
        row = self.proxy.estimates[0]
        self.assertEqual((row['requested_monotonic_seconds'], row['completed_monotonic_seconds']), (10, 11))
        self.assertEqual((row['requested_unix_seconds'], row['completed_unix_seconds']), (1010, 1011))
        self.assertEqual(row['request_id'], row['response']['id'])
        self.assertEqual(row['completion_sequence'], 0)
        self.capture('eth_getBlockByNumber', ['latest', False], {'lots': 'poll data'}, 3, 22, 23)
        self.assertEqual(len(self.proxy.rpc_log), 2)
        snapshot = API['rpc_snapshot'](self.proxy)
        snapshot['estimates'][0]['request']['id'] = 99
        self.assertEqual(row['request']['id'], 1)

    def test_partial_settlement_readback_trace_survive_receipt_assertion_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            output = pathlib.Path(directory)/'proof.json'
            point = API['persist_progress'](output, 'stopped-readback', {'destination': self.proxy}, settlement={'seconds': 600}, stopped_rust_readback={'processed': True})
            trace = pathlib.Path(point['rpc_trace']['path'])
            self.assertEqual(API['sha'](trace), point['rpc_trace']['sha256_chunks'])
            API['persist_failure'](output, AssertionError('receipt assertion'), directory)
            API['persist_failure'](output, RuntimeError('outer wrapper'), directory)
            API['finish_result'](output, {'passed': False, 'errors': []})
            saved = json.loads(output.read_text())
            self.assertEqual(saved['last_completed_stage'], 'stopped-readback')
            self.assertEqual(saved['progress'][0]['achieved']['settlement']['seconds'], 600)
            self.assertTrue(saved['progress'][0]['achieved']['stopped_rust_readback']['processed'])
            self.assertIn('receipt assertion', saved['errors'][0]['detail'])
            self.assertEqual(len(json.loads(trace.read_text())['destination']['observations']), 2)
            with self.assertRaisesRegex(AssertionError, 'overwrite'):
                API['persist_progress'](output, 'stopped-readback', {'destination': self.proxy})


if __name__ == '__main__':
    unittest.main()
