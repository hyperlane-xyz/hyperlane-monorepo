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
import urllib.error

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
            status = 200
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
        API.update(urllib=types.SimpleNamespace(request=types.SimpleNamespace(urlopen=open_),error=urllib.error), time=clock)
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
            status = 200
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
        API.update(urllib=types.SimpleNamespace(request=types.SimpleNamespace(urlopen=open_),error=urllib.error), time=types.SimpleNamespace(monotonic=lambda: state['now'], time=lambda: 1600.0), wait=wait_)
        try:
            result = API['wait_for_retirement'](1, None, [message])
            self.assertIsNone(result['first_confirmed_counter_observation']['value'])
            self.assertFalse(result['first_confirmed_counter_observation']['present'])
            self.assertEqual(result['confirmed_counter_absent_samples'], 2)
            self.assertEqual(result['first_actual_confirmed_counter'], 1)
            self.assertEqual(result['operations_confirmed'], 1)
        finally:
            API.update(old)

    def test_admin599_absence_is_not_restamped_by_metrics601(self):
        message, _ = fixture()
        message['included_monotonic'] = 0
        with self.assertRaisesRegex(AssertionError, 'own600s'):
            API['retirement_poll']([], 1, [message], 599.0, 0, 601.0)
        self.assertFalse(API['retirement_poll']([{'id':message['id']}], 1, [message], 599.0, 0, 601.0))
        self.assertTrue(API['retirement_poll']([], 1, [message], 600.0, 0, 601.0))
        self.assertFalse(API['retirement_poll']([], None, [message], 600.0, 0, 601.0))

    def test_actual_wait_retains_independent_admin_metric_intervals(self):
        message, _ = fixture()
        message.update(included_unix_seconds=1000.0, included_transaction_hash='0x'+'bb'*32)
        state = {'now':699.0}
        class Response:
            status = 200
            def __init__(self, body, now): self.body, self.now = body, now
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self): state['now']=self.now; return self.body
        def open_(url, timeout):
            return Response(b'[]',700.0) if '/list_operations?' in url else Response((CONFIRMED+' 1\n'+'hyperlane_submitter_queue_length{remote="test2",queue_name="confirm_queue",operation_status="Confirm(Submitted by this relayer)",app_context="Unknown",'+BASE+'} 0\n').encode(),701.0)
        def wait_(predicate, *_): self.assertTrue(predicate())
        old = {key: API.get(key) for key in ('urllib','time','wait')}
        API.update(urllib=types.SimpleNamespace(request=types.SimpleNamespace(urlopen=open_),error=urllib.error),time=types.SimpleNamespace(monotonic=lambda:state['now'],time=lambda:1601.0),wait=wait_)
        try:
            result=API['wait_for_retirement'](1,None,[message])
            intervals=result['first_live_completion']['observation_intervals']
            self.assertEqual(intervals,{'admin_request_started':699.0,'admin_response_received':700.0,'metrics_request_started':700.0,'metrics_response_received':701.0})
            self.assertEqual(result['first_live_completion']['first_observed_empty_admin_monotonic'],700.0)
            self.assertEqual(result['first_live_completion']['monotonic'],701.0)
        finally: API.update(old)

    def test_actual_wait_rejects_late_admin_response_even_when_request_began_before_deadline(self):
        message, _ = fixture()
        state={'now':729.0}
        class Response:
            status = 200
            def __init__(self,body):self.body=body
            def __enter__(self):return self
            def __exit__(self,*_):pass
            def read(self):state['now']=731.0;return self.body
        def open_(url,timeout):return Response(b'[]' if '/list_operations?' in url else (CONFIRMED+' 1\n').encode())
        def wait_(predicate,*_):predicate()
        old={key:API.get(key)for key in ('urllib','time','wait')}
        API.update(urllib=types.SimpleNamespace(request=types.SimpleNamespace(urlopen=open_),error=urllib.error),time=types.SimpleNamespace(monotonic=lambda:state['now'],time=lambda:1631.0),wait=wait_)
        try:
            with self.assertRaisesRegex(AssertionError,r'600\+30 deadline'):API['wait_for_retirement'](1,None,[message])
        finally:API.update(old)

    def test_late_metrics_cannot_complete_even_after_timely_admin_absence(self):
        message,_=fixture()
        state={'now':729.0};calls=[]
        class Response:
            status=200
            def __init__(self,body,received):self.body,self.received=body,received
            def __enter__(self):return self
            def __exit__(self,*_):pass
            def read(self):state['now']=self.received;return self.body
        def open_(url,timeout):
            calls.append((url,timeout))
            return Response(b'[]',729.5) if '/list_operations?' in url else Response((CONFIRMED+' 1\n').encode(),731.0)
        def wait_(predicate,*_):predicate()
        old={key:API.get(key)for key in ('urllib','time','wait')}
        API.update(urllib=types.SimpleNamespace(request=types.SimpleNamespace(urlopen=open_),error=urllib.error),time=types.SimpleNamespace(monotonic=lambda:state['now'],time=lambda:1631.0),wait=wait_)
        try:
            with self.assertRaisesRegex(AssertionError,r'metrics observation after actual600\+30 deadline'):API['wait_for_retirement'](1,None,[message])
            self.assertEqual([timeout for _,timeout in calls],[1.0,.5])
        finally:API.update(old)

    def test_malformed_admin_then_valid_cannot_be_skipped_as_transport_retry(self):
        message,_=fixture()
        calls=[]
        class Response:
            status=200
            def __enter__(self):return self
            def __exit__(self,*_):pass
            def read(self):return b'{' if len(calls)==1 else b'[]'
        def open_(url,timeout):calls.append(url);return Response()
        def wait_(predicate,*_):
            if not predicate():predicate()
        old={key:API.get(key)for key in ('urllib','time','wait')}
        API.update(urllib=types.SimpleNamespace(request=types.SimpleNamespace(urlopen=open_),error=urllib.error),time=types.SimpleNamespace(monotonic=lambda:700.0,time=lambda:1600.0),wait=wait_)
        try:
            with self.assertRaises(json.JSONDecodeError):API['wait_for_retirement'](1,None,[message])
            self.assertEqual(len(calls),1)
        finally:API.update(old)

    def test_HTTP500_then_valid_is_hard_for_both_admin_and_metrics(self):
        message,_=fixture()
        message.update(included_unix_seconds=1000.0,included_transaction_hash='0x'+'bb'*32)
        final=(CONFIRMED+' 1\n'+'hyperlane_submitter_queue_length{remote="test2",queue_name="confirm_queue",operation_status="Confirm(Submitted by this relayer)",app_context="Unknown",'+BASE+'} 0\n').encode()
        for failing in ('admin','metrics'):
            calls=[];state={'raised':False}
            class Response:
                status=200
                def __init__(self,body):self.body=body
                def __enter__(self):return self
                def __exit__(self,*_):pass
                def read(self):return self.body
            def open_(url,timeout):
                calls.append(url)
                selected='/list_operations?' in url if failing=='admin' else url.endswith('/metrics')
                if selected and not state['raised']:
                    state['raised']=True
                    raise urllib.error.HTTPError(url,500,'public unit500',None,None)
                return Response(b'[]' if '/list_operations?' in url else final)
            def wait_(predicate,*_):
                if not predicate():predicate()
            old={key:API.get(key)for key in ('urllib','time','wait')}
            API.update(urllib=types.SimpleNamespace(request=types.SimpleNamespace(urlopen=open_),error=urllib.error),time=types.SimpleNamespace(monotonic=lambda:700.0,time=lambda:1600.0),wait=wait_)
            try:
                with self.assertRaises(urllib.error.HTTPError):API['wait_for_retirement'](1,None,[message])
                self.assertEqual(len(calls),1 if failing=='admin' else 2)
            finally:API.update(old)

    def test_non200_response_objects_cannot_pass_even_with_valid_body(self):
        message,_=fixture()
        for failing in ('admin','metrics'):
            class Response:
                def __init__(self,status):self.status=status
                def __enter__(self):return self
                def __exit__(self,*_):pass
                def read(self):return b'[]'
            def open_(url,timeout):
                selected='/list_operations?' in url if failing=='admin' else url.endswith('/metrics')
                return Response(206 if selected else 200)
            def wait_(predicate,*_):predicate()
            old={key:API.get(key)for key in ('urllib','time','wait')}
            API.update(urllib=types.SimpleNamespace(request=types.SimpleNamespace(urlopen=open_),error=urllib.error),time=types.SimpleNamespace(monotonic=lambda:700.0,time=lambda:1600.0),wait=wait_)
            try:
                with self.assertRaisesRegex(AssertionError,'HTTP status'):API['wait_for_retirement'](1,None,[message])
            finally:API.update(old)

    def test_transport_timeout_recovers_only_inside_original_retirement_deadline(self):
        message,_=fixture()
        message.update(included_unix_seconds=1000.0,included_transaction_hash='0x'+'bb'*32)
        state={'now':728.0};calls=[]
        final=(CONFIRMED+' 1\n'+'hyperlane_submitter_queue_length{remote="test2",queue_name="confirm_queue",operation_status="Confirm(Submitted by this relayer)",app_context="Unknown",'+BASE+'} 0\n').encode()
        class Response:
            status=200
            def __init__(self,body):self.body=body
            def __enter__(self):return self
            def __exit__(self,*_):pass
            def read(self):return self.body
        def open_(url,timeout):
            calls.append((url,timeout))
            if len(calls)==1:
                state['now']=729.0
                raise TimeoutError('public socket timeout')
            return Response(b'[]' if '/list_operations?' in url else final)
        def wait_(predicate,_process,seconds,_description):
            self.assertEqual(seconds,2.0)
            self.assertFalse(predicate())
            self.assertTrue(predicate())
        old={key:API.get(key)for key in ('urllib','time','wait')}
        API.update(urllib=types.SimpleNamespace(request=types.SimpleNamespace(urlopen=open_),error=urllib.error),time=types.SimpleNamespace(monotonic=lambda:state['now'],time=lambda:1629.0),wait=wait_)
        try:
            result=API['wait_for_retirement'](1,None,[message])
            self.assertEqual([timeout for _,timeout in calls],[2.0,1.0,1.0,3])
            self.assertEqual(result['deadline_from_latest_actual_inclusion'],730.0)
            self.assertEqual(result['first_live_completion']['first_observed_empty_admin_monotonic'],729.0)
        finally:API.update(old)

    def test_decoded_admin_semantics_fail_before_a_later_metrics_timeout(self):
        message,row=fixture()
        for label,operations,pattern in [('early missing',[],'own600s'),('schema',{},''),('duplicate',[row,row],'duplicate active')]:
            calls=[]
            class Response:
                status=200
                def __enter__(self):return self
                def __exit__(self,*_):pass
                def read(self):return json.dumps(operations).encode()
            def open_(url,timeout):
                calls.append(url)
                if url.endswith('/metrics'):raise TimeoutError('must not hide decoded admin evidence')
                return Response()
            def wait_(predicate,*_):predicate()
            old={key:API.get(key)for key in ('urllib','time','wait')}
            API.update(urllib=types.SimpleNamespace(request=types.SimpleNamespace(urlopen=open_),error=urllib.error),time=types.SimpleNamespace(monotonic=lambda:699.0,time=lambda:1599.0),wait=wait_)
            try:
                with self.subTest(label=label),self.assertRaisesRegex(AssertionError,pattern):API['wait_for_retirement'](1,None,[message])
                self.assertEqual(len(calls),1)
            finally:API.update(old)

    def test_each_staggered_ID_keeps_its_own630_bound_before_metrics(self):
        first,row=fixture();second=copy.deepcopy(first);second.update(id='0x'+'cc'*32,included_monotonic=120.0)
        other=copy.deepcopy(row);other['id']=second['id']
        for operations in ([row,other],[other]):
            calls=[]
            class Response:
                status=200
                def __enter__(self):return self
                def __exit__(self,*_):pass
                def read(self):return json.dumps(operations).encode()
            def open_(url,timeout):calls.append(url);return Response()
            def wait_(predicate,*_):predicate()
            old={key:API.get(key)for key in ('urllib','time','wait')}
            API.update(urllib=types.SimpleNamespace(request=types.SimpleNamespace(urlopen=open_),error=urllib.error),time=types.SimpleNamespace(monotonic=lambda:731.0,time=lambda:1631.0),wait=wait_)
            try:
                with self.assertRaisesRegex(AssertionError,r'own600\+30'):API['wait_for_retirement'](1,None,[first,second])
                self.assertEqual(len(calls),1)
            finally:API.update(old)

    def test_valid_earlier_absence_survives_metrics_timeout_and_later_ID_wait(self):
        first,row=fixture();first.update(included_unix_seconds=1000.0,included_transaction_hash='0x'+'bb'*32)
        second=copy.deepcopy(first);second.update(id='0x'+'cc'*32,included_monotonic=120.0,included_unix_seconds=1020.0)
        other=copy.deepcopy(row);other['id']=second['id'];state={'now':710.0,'index':0}
        class Response:
            status=200
            def __init__(self,body):self.body=body
            def __enter__(self):return self
            def __exit__(self,*_):pass
            def read(self):return self.body
        def open_(url,timeout):
            if '/list_operations?' in url:return Response(json.dumps([other] if state['index']<2 else []).encode())
            if state['index']==0:raise TimeoutError('first metrics read unavailable')
            count=1 if state['index']==1 else 2
            return Response((CONFIRMED+f' {count}\n'+'hyperlane_submitter_queue_length{remote="test2",queue_name="confirm_queue",operation_status="Confirm(Submitted by this relayer)",app_context="Unknown",'+BASE+'} 0\n').encode())
        def wait_(predicate,*_):
            for index,now in enumerate((710.0,731.0,741.0)):
                state.update(index=index,now=now)
                self.assertEqual(predicate(),index==2)
        old={key:API.get(key)for key in ('urllib','time','wait')}
        API.update(urllib=types.SimpleNamespace(request=types.SimpleNamespace(urlopen=open_),error=urllib.error),time=types.SimpleNamespace(monotonic=lambda:state['now'],time=lambda:1641.0),wait=wait_)
        try:
            result=API['wait_for_retirement'](1,None,[first,second])
            self.assertEqual([row['observed_retirement']['response_received']for row in result['per_id_retirement_observations']],[710.0,741.0])
            self.assertEqual(result['transport_error_observations'][0]['stage'],'metrics')
            self.assertEqual(result['transport_error_observations'][0]['original_retirement_deadline'],750.0)
        finally:API.update(old)

    def test_retired_ID_reappearance_cannot_hide_behind_metrics_timeout(self):
        message,row=fixture();state={'now':710.0,'index':0};calls=[]
        class Response:
            status=200
            def __enter__(self):return self
            def __exit__(self,*_):pass
            def read(self):return json.dumps([] if state['index']==0 else [row]).encode()
        def open_(url,timeout):
            calls.append(url)
            if url.endswith('/metrics'):raise TimeoutError('metrics unavailable')
            return Response()
        def wait_(predicate,*_):
            self.assertFalse(predicate())
            state.update(index=1,now=711.0)
            predicate()
        old={key:API.get(key)for key in ('urllib','time','wait')}
        API.update(urllib=types.SimpleNamespace(request=types.SimpleNamespace(urlopen=open_),error=urllib.error),time=types.SimpleNamespace(monotonic=lambda:state['now'],time=lambda:1611.0),wait=wait_)
        try:
            with self.assertRaisesRegex(AssertionError,'reappeared'):API['wait_for_retirement'](1,None,[message])
            self.assertEqual(len(calls),3)
        finally:API.update(old)


if __name__ == '__main__':
    unittest.main()
