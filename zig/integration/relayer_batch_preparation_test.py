#!/usr/bin/env python3
"""Pure preparation-barrier controls; no fixture imports, roles or network."""
import ast
import copy
import contextlib
import json
import os
import tempfile
import time
from types import SimpleNamespace
import pathlib
import re
import unittest

SOURCE = pathlib.Path(__file__).with_name('relayer_process.py')
NAMES = {'prepared_batch_snapshot', 'prepared_batch_probe', 'assert_prepared_batch_replayed'}
API = {'re': re, 'ORIGIN': 9913371, 'DESTINATION': 9913372}
exec(compile(ast.Module(body=[node for node in ast.parse(SOURCE.read_text()).body if isinstance(node, ast.FunctionDef) and node.name in NAMES], type_ignores=[]), str(SOURCE), 'exec'), API)


def fixture():
    messages, operations, links, rows = [], [], [], []
    for i in range(4):
        nonce = i + 5
        identity = f'{nonce:064x}'
        wire = bytes([3]) + nonce.to_bytes(4, 'big') + (9913371).to_bytes(4, 'big') + bytes([17])*32 + (9913372).to_bytes(4, 'big') + bytes([34])*32 + bytes([nonce])
        messages.append({'id': '0x'+identity, 'wire': wire.hex()})
        known = {'version': 3, 'nonce': nonce, 'origin': 9913371, 'sender': '0x'+'11'*32, 'destination': 9913372, 'recipient': '0x'+'22'*32, 'body': [nonce]}
        operations.append({'id': '0x'+identity, 'operation': {'type': 'PendingMessage', 'message': known, 'status': 'ReadyToSubmit', 'submitted': False}})
        uuid = f'{nonce:032x}'
        links.append({'message_id_chunks': [identity], 'uuid_chunks': [uuid], 'nonce': nonce, 'message_source': 'canonical', 'canonical_nonce_message_present': True, 'canonical_nonce_matches_message': True, 'private_operation_stage': 'ready', 'destination_payload_present': True, 'estimated_gas': str(70000+nonce), 'gas_expenditure_record_present': False})
        rows.append({'id_chunks': [identity], 'nonce': nonce, 'present': True, 'processed': None, 'payment': {'payment': '100000'}, 'gas_expenditure_record_present': False, 'payloads': [{'uuid': uuid, 'present': True, 'status': 'ReadyToSubmit'}]})
    return messages, operations, {'sealed_payload_links': links, 'messages': rows}


class PreparationBarrierTests(unittest.TestCase):
    def setUp(self):
        self.messages, self.operations, self.probe = fixture()

    def snapshot(self):
        return API['prepared_batch_snapshot'](self.operations, self.messages)

    def prepared(self):
        return API['prepared_batch_probe'](self.probe, self.messages)

    def test_four_exact_ready_operations(self):
        self.assertTrue(self.snapshot()['ready'])
        self.assertEqual(len(self.prepared()), 4)

    def test_empty_or_partial_admin_never_ready(self):
        for count in range(4):
            self.assertFalse(API['prepared_batch_snapshot'](self.operations[:count], self.messages)['ready'])

    def test_first_prepare_and_retry_are_waits(self):
        for status in ('FirstPrepareAttempt', {'Retry': 'ErrorBuildingMetadata'}):
            self.operations[0]['operation']['status'] = status
            self.assertFalse(self.snapshot()['ready'])

    def test_duplicate_or_foreign_admin_rejected(self):
        self.operations[1] = copy.deepcopy(self.operations[0])
        with self.assertRaises(AssertionError):
            self.snapshot()
        self.operations[1]['id'] = '0x'+'ff'*32
        with self.assertRaises(AssertionError):
            self.snapshot()

    def test_exact_wire_schema_nonce_domains_and_body(self):
        for field, wrong in [('nonce', 9), ('origin', 1), ('destination', 1), ('sender', '0x'+'ff'*32), ('body', [True])]:
            _, rows, _ = fixture()
            rows[0]['operation']['message'][field] = wrong
            with self.assertRaises(AssertionError):
                API['prepared_batch_snapshot'](rows, self.messages)

    def test_boolean_numeric_and_extra_schema_rejected(self):
        self.operations[0]['operation']['message']['nonce'] = True
        with self.assertRaises(AssertionError):
            self.snapshot()
        self.operations[0]['operation']['message']['nonce'] = 5
        self.operations[0]['operation']['message']['extra'] = 1
        with self.assertRaises(AssertionError):
            self.snapshot()

    def test_submitted_or_confirm_cannot_be_prepared(self):
        self.operations[0]['operation']['submitted'] = True
        with self.assertRaises(AssertionError):
            self.snapshot()
        self.operations[0]['operation']['submitted'] = False
        self.operations[0]['operation']['status'] = {'Confirm': 'SubmittedBySelf'}
        with self.assertRaises(AssertionError):
            self.snapshot()

    def test_corrupt_status_and_truncated_wire_rejected(self):
        self.operations[0]['operation']['status'] = {'unexpected': 1}
        with self.assertRaises(AssertionError):
            self.snapshot()
        self.messages[0]['wire'] = '00'
        with self.assertRaises(AssertionError):
            self.snapshot()

    def test_duplicate_expected_ids_rejected(self):
        self.messages[1]['id'] = self.messages[0]['id']
        with self.assertRaises(AssertionError):
            self.snapshot()
        with self.assertRaises(AssertionError):
            self.prepared()

    def test_missing_or_duplicate_sealed_link_rejected(self):
        self.probe['sealed_payload_links'].pop()
        with self.assertRaises(AssertionError):
            self.prepared()
        _, _, self.probe = fixture()
        self.probe['sealed_payload_links'][1] = self.probe['sealed_payload_links'][0]
        with self.assertRaises(AssertionError):
            self.prepared()

    def test_canonical_authority_required(self):
        for key, value in [('message_source', 'sidecar'), ('canonical_nonce_message_present', False), ('canonical_nonce_matches_message', False)]:
            _, _, probe = fixture()
            probe['sealed_payload_links'][0][key] = value
            with self.assertRaises(AssertionError):
                API['prepared_batch_probe'](probe, self.messages)

    def test_pending_stage_and_actual_payload_required(self):
        for key, value in [('private_operation_stage', 'delivered'), ('destination_payload_present', False)]:
            _, _, probe = fixture()
            probe['sealed_payload_links'][0][key] = value
            with self.assertRaises(AssertionError):
                API['prepared_batch_probe'](probe, self.messages)

    def test_estimate_must_be_present_positive(self):
        for value in (None, '0', '-1'):
            self.probe['sealed_payload_links'][0]['estimated_gas'] = value
            with self.assertRaises(AssertionError):
                self.prepared()

    def test_expenditure_or_processed_row_rejected(self):
        for side in ('messages', 'sealed_payload_links'):
            _, _, probe = fixture()
            probe[side][0]['gas_expenditure_record_present'] = True
            with self.assertRaises(AssertionError):
                API['prepared_batch_probe'](probe, self.messages)
        self.probe['messages'][0]['processed'] = True
        with self.assertRaises(AssertionError):
            self.prepared()

    def test_payload_uuid_status_and_nonce_bound(self):
        for key, value in [('uuid', 'ff'*16), ('status', 'InTransaction(Finalized)'), ('present', False)]:
            _, _, probe = fixture()
            probe['messages'][0]['payloads'][0][key] = value
            with self.assertRaises(AssertionError):
                API['prepared_batch_probe'](probe, self.messages)
        self.probe['sealed_payload_links'][0]['nonce'] = 6
        with self.assertRaises(AssertionError):
            self.prepared()

    def test_same_sealed_members_survive_restart(self):
        prepared = self.prepared()
        API['assert_prepared_batch_replayed'](prepared, self.probe)
        for key, value in [('uuid_chunks', ['ff'*16]), ('estimated_gas', '1'), ('nonce', 20)]:
            changed = copy.deepcopy(self.probe)
            changed['sealed_payload_links'][0][key] = value
            with self.assertRaises(AssertionError):
                API['assert_prepared_batch_replayed'](prepared, changed)
        self.probe['sealed_payload_links'].pop()
        with self.assertRaises(AssertionError):
            API['assert_prepared_batch_replayed'](prepared, self.probe)


class HeldProbeDiagnosticsTests(unittest.TestCase):
    def test_actual_held_probe_is_saved_before_each_compound_assert_failure(self):
        source = SOURCE.read_text()
        names = {'hold_batch_preparation', 'persist_progress', 'write_snapshot', 'existing_snapshot'}
        nodes = [node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef) and node.name in names]
        for field, changed in [('processed', True), ('payment', None), ('payloads', [])]:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory); config = root/'config'; config.mkdir()
                output = root/'proof.json'; messages, _, probe = fixture(); probe['messages'][0][field] = changed
                expected = copy.deepcopy(probe); events = []; agents = []
                def check(actual, targets):
                    saved = json.loads(output.read_text())['progress'][-1]
                    self.assertEqual(saved['stage'], 'batch-held-stopped-readback')
                    self.assertEqual(saved['achieved']['stopped_rust_readback'], expected)
                    self.assertEqual(saved['achieved']['stop']['exit'], 0)
                    self.assertTrue(saved['achieved']['poststop_nonce_and_broadcast_assertions_passed'])
                    events.append('saved-before-validation')
                    return API['prepared_batch_probe'](actual, targets)
                api = {'copy':copy, 'json':json, 'pathlib':pathlib, 'os':os, 'time':time,
                       'launch':lambda *args:SimpleNamespace(), 'stop':lambda process:{'exit':0},
                       'wait_role_ready':lambda *args:None, 'wait':lambda predicate,*args:self.assertTrue(predicate()),
                       'rpc_snapshot':lambda proxy:{'observations':[]},
                       'prepared_batch_snapshot':lambda *args:{'ready':True,'operations':[]},
                       'prepared_batch_probe':check, 'rust_probe':lambda *args:probe,
                       'urllib':SimpleNamespace(request=SimpleNamespace(urlopen=lambda *args,**kwargs:contextlib.nullcontext(SimpleNamespace(read=lambda:b'[]')))),
                       'DESTINATION':9913372, 'evm':SimpleNamespace(TEST_SIGNER='fixture-public-signer')}
                exec(compile(ast.Module(body=nodes,type_ignores=[]),str(SOURCE),'exec'),api)
                with self.assertRaisesRegex(AssertionError,'held canonical row already processed or payload missing'):
                    api['hold_batch_preparation'](None,config,{'chains':{'test2':{'maxBatchSize':4}},'metricsPort':1},root/'db',root/'role.log',messages,9,SimpleNamespace(rpc=lambda *args:7),None,None,agents,output)
                self.assertEqual(events,['saved-before-validation'])
                self.assertEqual(len(agents),1)
                self.assertIn('maxSubmitQueueLength',json.loads((config/'public.json').read_text())['chains']['test2'])


class CompactSnapshotControls(unittest.TestCase):
    def test_compact_snapshot_preserves_every_value_and_raw_response(self):
        node=next(n for n in ast.parse(SOURCE.read_text()).body if isinstance(n,ast.FunctionDef)and n.name=='write_snapshot')
        scope={'pathlib':pathlib,'json':json,'os':os};exec(compile(ast.Module([node],type_ignores=[]),str(SOURCE),'exec'),scope)
        value={'passed':False,'errors':[],'observations':[{'request':{'method':'fixture','params':[' unicode \u2603 ',None,False,2**256]},'response':{'raw':' a \n b ','result':[0,1.25,True,{'nested':[]}]} }]*4}
        with tempfile.TemporaryDirectory()as directory:
            path=pathlib.Path(directory)/'proof.json';scope['write_snapshot'](path,value);raw=path.read_bytes()
            self.assertEqual(json.loads(raw),value)
            self.assertEqual(raw,(json.dumps(value,separators=(',',':'))+'\n').encode())
            self.assertLess(len(raw),len((json.dumps(value,indent=2)+'\n').encode()))
            self.assertFalse(path.with_name('.proof.json.tmp').exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
