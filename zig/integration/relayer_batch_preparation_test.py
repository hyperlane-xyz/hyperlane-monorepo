#!/usr/bin/env python3
"""Pure preparation-barrier controls; no fixture imports, roles or network."""
import ast
import copy
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


if __name__ == '__main__':
    unittest.main(verbosity=2)
