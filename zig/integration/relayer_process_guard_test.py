#!/usr/bin/env python3
"""Pure snapshot guards: no fixture imports, subprocesses, sockets or role execution."""
import ast
import copy
import hashlib
import json
import math
import pathlib
import re
import unittest
import types

SOURCE = pathlib.Path(__file__).with_name('relayer_process.py')
NAMES = {'chunks', 'metric_value', 'metric_observation', 'early_included_snapshot', 'retirement_poll', 'retirement_lower_bound', 'early_included_guard', 'wait_for_retirement', 'retirement_deadline'}
TREE = ast.parse(SOURCE.read_text())
MODULE = ast.Module(body=[node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name in NAMES], type_ignores=[])
API = {'json': json, 'math': math, 're': re, 'hashlib': hashlib, 'SOURCE_CONFIRM_SECONDS': 600, 'SOURCE_FINALITY_GRACE_SECONDS': 30, 'ORIGIN': 9913371, 'DESTINATION': 9913372}
exec(compile(MODULE, str(SOURCE), 'exec'), API)
BASE = 'agent="relayer",hyperlane_baselib_version="3.0.0"'
PROCESSED = 'hyperlane_messages_processed_count{origin="test1",remote="test2",'+BASE+'}'
LAST = 'hyperlane_last_known_message_nonce{phase="message_processed",origin="test1",'+BASE+'}'
CONFIRMED = 'hyperlane_operations_processed_count{app_context="Unknown",phase="confirmed",chain="test2",'+BASE+'}'
MANDATORY = ('hyperlane_lander_transaction_submissions{destination="test2"} 3\n'
             'hyperlane_operations_processed_count{app_context="Unknown",phase="submitted",chain="test2",'+BASE+'} 3\n'
             'hyperlane_submitter_queue_length{remote="test2",queue_name="confirm_queue",operation_status="Confirm(Submitted by this relayer)",app_context="Unknown",'+BASE+'} 3\n')


def fixture():
    wire = bytes([3])+(1).to_bytes(4, 'big')+(9913371).to_bytes(4, 'big')+bytes([0x11])*32+(9913372).to_bytes(4, 'big')+bytes([0x22])*32+b'public-fixture'
    message = {'id': '0x'+'aa'*32, 'wire': wire.hex(), 'included_monotonic': 100.0}
    value = {'version': 3, 'nonce': 1, 'origin': 9913371, 'sender': '0x'+'11'*32, 'destination': 9913372, 'recipient': '0x'+'22'*32, 'body': list(b'public-fixture')}
    row = {'id': message['id'], 'operation': {'type': 'PendingMessage', 'message': value, 'status': {'Confirm': 'SubmittedBySelf'}, 'submitted': True}}
    return message, row


class EarlySnapshotTests(unittest.TestCase):
    def setUp(self):
        self.message, self.row = fixture()

    def snapshot(self, body=MANDATORY, rows=None, messages=None, now=110.0, initial=True):
        return API['early_included_snapshot'](body.encode(), [self.row] if rows is None else rows, 'test1', 1, [self.message] if messages is None else messages, now, initial)

    def test_absent_children_are_none_and_explicit_zero_is_present(self):
        value = self.snapshot()
        self.assertTrue(value['ready'])
        for key in ('messages_processed', 'last_processed_nonce', 'operations_confirmed'):
            self.assertIsNone(value[key])
            self.assertFalse(value['metric_observations'][key]['present'])
        value = self.snapshot(MANDATORY+PROCESSED+' 0\n'+LAST+' 0\n'+CONFIRMED+' 0\n')
        self.assertEqual(value['messages_processed'], 0)
        self.assertTrue(all(x['present'] for x in value['metric_observations'].values()))

    def test_pending_confirmation_can_wait_without_any_metric_series(self):
        self.row['operation'].update(status='ReadyToSubmit', submitted=False)
        value = self.snapshot(body='')
        self.assertFalse(value['ready'])
        self.assertIsNone(value['mandatory_metric_observations']['confirm_queue']['value'])
        self.row['operation'].update(status={'Confirm': 'SubmittedBySelf'}, submitted=True)
        self.assertTrue(self.snapshot()['ready'])
        with self.assertRaisesRegex(AssertionError, 'positive Confirm'):
            self.snapshot(body='')

    def test_missing_or_duplicate_id_never_hidden_by_positive_queue(self):
        with self.assertRaisesRegex(AssertionError, 'disappeared'):
            self.snapshot(rows=[])
        with self.assertRaisesRegex(AssertionError, 'duplicate admin'):
            self.snapshot(rows=[self.row, copy.deepcopy(self.row)])
        with self.assertRaisesRegex(AssertionError, 'duplicate/invalid tracked'):
            self.snapshot(messages=[self.message, copy.deepcopy(self.message)])

    def test_exact_body_nonce_domain_and_submission_status(self):
        for key, value in [('nonce', 2), ('nonce', True), ('origin', 9913373), ('destination', 1), ('body', [False]), ('sender', '0x'+'33'*32)]:
            with self.subTest(key=key, value=value):
                changed = copy.deepcopy(self.row)
                changed['operation']['message'][key] = value
                with self.assertRaises(AssertionError):
                    self.snapshot(rows=[changed])
        for status, submitted in [({'Confirm': 'Unknown'}, True), ({'Confirm': 'SubmittedBySelf'}, False), ('ReadyToSubmit', True)]:
            changed = copy.deepcopy(self.row)
            changed['operation'].update(status=status, submitted=submitted)
            with self.assertRaises(AssertionError):
                self.snapshot(rows=[changed])

    def test_early_positive_and_nonce_without_counter_are_not_hidden(self):
        for suffix in [PROCESSED+' 1\n', CONFIRMED+' 1\n', LAST+' 1\n']:
            with self.assertRaises(AssertionError):
                self.snapshot(MANDATORY+suffix)
        with self.assertRaisesRegex(AssertionError, 'nonce reaches'):
            self.snapshot(MANDATORY+LAST+' 1\n', initial=False)

    def test_malformed_wrong_labels_wrong_version_and_duplicates_fail(self):
        for number in ['NaN', '+Inf', '-1', '0.5', 'garbage']:
            with self.assertRaises(AssertionError):
                self.snapshot(MANDATORY+PROCESSED+' '+number+'\n')
        for body in [MANDATORY.replace('3.0.0', '2.0.0'), MANDATORY.replace('agent="relayer"', 'agent="validator"'), MANDATORY+PROCESSED.replace('remote=', 'chain=')+' 0\n', MANDATORY+PROCESSED+' 0\n'+PROCESSED+' 0\n']:
            with self.assertRaises(AssertionError):
                self.snapshot(body)

    def test_zero_age_valid_but_negative_age_and_age600_reject(self):
        self.assertTrue(self.snapshot(now=100.0)['ready'])
        for now in (99.0, 700.0):
            with self.assertRaisesRegex(AssertionError, 'per-ID600'):
                self.snapshot(now=now)

    def test_absent_counter_cannot_hide_disappearance_or_complete_retirement(self):
        poll = API['retirement_poll']
        self.assertFalse(poll([self.row], None, [self.message], 110.0))
        with self.assertRaisesRegex(AssertionError, 'disappeared'):
            poll([], None, [self.message], 110.0)
        self.assertFalse(poll([], None, [self.message], 700.0))
        self.assertTrue(poll([], 1, [self.message], 700.0))
        with self.assertRaisesRegex(AssertionError, 'duplicate'):
            poll([self.row, self.row], None, [self.message], 110.0)


class HttpBoundaryTests(unittest.TestCase):
    def test_preconfirm_transition_waits_without_faking_missing_metrics(self):
        message, confirmed = fixture()
        pending = copy.deepcopy(confirmed)
        pending['operation'].update(status='ReadyToSubmit', submitted=False)
        state = {'pass': 0, 'now': 110.0}
        class Response:
            def __init__(self, body): self.body = body
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self): return self.body
        def open_(url, timeout):
            if '/list_operations?' in url:
                return Response(json.dumps([pending if state['pass'] == 0 else confirmed]).encode())
            body = b'' if state['pass'] == 0 else MANDATORY.encode()
            state['pass'] += 1
            return Response(body)
        clock = types.SimpleNamespace(monotonic=lambda: state['now'], sleep=lambda seconds: state.update(now=state['now']+seconds))
        old = {key: API.get(key) for key in ('urllib', 'time')}
        API.update(urllib=types.SimpleNamespace(request=types.SimpleNamespace(urlopen=open_)), time=clock)
        try:
            result = API['early_included_guard'](1, 'test1', 1, [message], initial=True)
            self.assertEqual(state['pass'], 2)
            self.assertTrue(result['ready'])
            self.assertIsNone(result['messages_processed'])
        finally:
            API.update(old)

    def test_wait_preserves_absence_and_requires_actual_final_counter(self):
        message, row = fixture()
        message.update(included_unix_seconds=1000.0, included_transaction_hash='0x'+'bb'*32)
        state = {'now': 110.0, 'index': 0}
        final = MANDATORY.replace('} 3\n', '} 0\n')+CONFIRMED+' 1\n'
        class Response:
            def __init__(self, body): self.body = body
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self): return self.body
        def open_(url, timeout):
            if '/list_operations?' in url:
                return Response(json.dumps([row] if state['index'] < 2 else []).encode())
            return Response((MANDATORY if state['index'] < 2 else final).encode())
        def wait_(predicate, process, seconds, description):
            self.assertEqual(seconds, 620.0)
            for index, now in enumerate((110.0, 699.0, 700.0)):
                state.update(index=index, now=now)
                self.assertEqual(predicate(), index == 2)
        old = {key: API.get(key) for key in ('urllib', 'time', 'wait')}
        API.update(urllib=types.SimpleNamespace(request=types.SimpleNamespace(urlopen=open_)), time=types.SimpleNamespace(monotonic=lambda: state['now'], time=lambda: 1600.0), wait=wait_)
        try:
            result = API['wait_for_retirement'](1, None, [message])
            self.assertIsNone(result['first_confirmed_counter_observation']['value'])
            self.assertFalse(result['first_confirmed_counter_observation']['present'])
            self.assertEqual(result['confirmed_counter_absent_samples'], 2)
            self.assertEqual(result['first_actual_confirmed_counter'], 1)
            self.assertEqual(result['operations_confirmed'], 1)
        finally:
            API.update(old)


if __name__ == '__main__':
    unittest.main()
