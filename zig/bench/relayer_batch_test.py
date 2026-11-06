#!/usr/bin/env python3
"""Pure batch-cap workload witnesses; no daemon, network, compiler or oracle."""
import copy
import importlib.util
import pathlib
import sys
import unittest
from unittest import mock

sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('relayer_batch_benchmark', ROOT / 'zig/bench/relayer.py')
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)


def word(value):
    return value.to_bytes(32, 'big')


def padded(value):
    return value + bytes((-len(value)) % 32)


def process_call(wire):
    return bytes.fromhex('7c39d130') + word(64) + word(96) + word(0) + word(len(wire)) + padded(wire)


def aggregate(calls):
    tuples = [bytes(12) + bytes.fromhex(target[2:]) + word(1) + word(96) + word(len(data)) + padded(data) for target, data in calls]
    offset = len(calls) * 32
    offsets = []
    for value in tuples:
        offsets.append(word(offset))
        offset += len(value)
    return '0x82ad56cb' + (word(32) + word(len(calls)) + b''.join(offsets) + b''.join(tuples)).hex()


class Chain:
    def __init__(self, transaction, receipt):
        self.transaction = transaction
        self.value = receipt
        self.header = {'hash': receipt['blockHash'], 'number': receipt['blockNumber']}

    def rpc(self, method, params):
        if method == 'eth_getTransactionByHash':
            return self.transaction
        if method in {'eth_getBlockByHash', 'eth_getBlockByNumber'}:
            return self.header
        raise AssertionError(method)

    def receipt(self, identity):
        return self.value


class BatchWitnessTests(unittest.TestCase):
    def setUp(self):
        self.mailbox = '0x' + '44' * 20
        self.contract = bench.relayer_process.MULTICALL3.lower()
        self.topic = '0x' + 'aa' * 32
        self.patch = mock.patch.object(bench.evm, 'run', return_value=self.topic)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.make(2)

    def make(self, count):
        self.messages = [{'id': '0x' + f'{i + 1:064x}', 'wire': bytes([i + 1] * 77).hex(), 'destination': bench.DESTINATION} for i in range(count)]
        self.calls = [(self.mailbox, process_call(bytes.fromhex(message['wire']))) for message in self.messages]
        self.transaction = {'hash': '0x' + '11' * 32, 'from': bench.evm.TEST_SIGNER, 'to': self.contract, 'input': aggregate(self.calls), 'blockHash': '0x' + '22' * 32, 'blockNumber': '0x10'}
        self.receipt = {'status': '0x1', 'transactionHash': self.transaction['hash'], 'blockHash': self.transaction['blockHash'], 'blockNumber': '0x10', 'gasUsed': '0x100', 'effectiveGasPrice': '0x2', 'chain_namespace': 'anvil-1', '_mailbox': self.mailbox}
        self.receipt['logs'] = [{'address': self.mailbox, 'topics': [self.topic, message['id']], 'transactionHash': self.transaction['hash'], 'blockHash': self.receipt['blockHash'], 'blockNumber': '0x10'} for message in self.messages]
        self.chain = Chain(self.transaction, copy.deepcopy(self.receipt))

    def proof(self):
        return bench.batch_membership_proof(self.messages, [self.receipt], {'anvil-1': self.chain}, {bench.DESTINATION: self.mailbox}, {'anvil-1': {'address': self.contract}}, 4)

    def test_two_and_four_real_encoded_calls(self):
        for count in (2, 4):
            self.make(count)
            proof = self.proof()
            self.assertTrue(proof['verified'])
            self.assertEqual(proof['batched_message_count'], count)
            self.assertEqual(proof['groups'][0]['ordered_message_ids'], [message['id'] for message in self.messages])
            self.assertEqual(proof['group_size_histogram'], {count: 1})

    def test_only_singletons_rejected(self):
        self.make(1)
        with self.assertRaisesRegex(RuntimeError, 'only singleton'):
            self.proof()

    def test_over_capacity_rejected(self):
        self.make(5)
        with self.assertRaisesRegex(RuntimeError, 'maximum'):
            self.proof()

    def test_failed_receipt_rejected(self):
        self.receipt['status'] = '0x0'
        with self.assertRaisesRegex(AssertionError, 'succeed'):
            self.proof()

    def test_missing_event_cannot_hide_extra_call(self):
        self.receipt['logs'].pop()
        with self.assertRaisesRegex(RuntimeError, 'incomplete'):
            self.proof()

    def test_duplicate_process_id_rejected(self):
        self.receipt['logs'][1] = self.receipt['logs'][0]
        with self.assertRaisesRegex(RuntimeError, 'duplicate'):
            self.proof()

    def test_foreign_emitter_rejected(self):
        self.receipt['logs'][0]['address'] = self.contract
        with self.assertRaisesRegex(RuntimeError, 'incomplete'):
            self.proof()

    def test_wrong_event_transaction_rejected(self):
        self.receipt['logs'][0]['transactionHash'] = '0x' + '55' * 32
        with self.assertRaisesRegex(AssertionError, 'transaction identity'):
            self.proof()

    def test_orphan_header_rejected(self):
        self.chain.header['hash'] = '0x' + '55' * 32
        with self.assertRaises(AssertionError):
            self.proof()

    def test_receipt_changes_after_sampling_rejected(self):
        self.chain.value['gasUsed'] = '0x101'
        with self.assertRaisesRegex(RuntimeError, 'changed'):
            self.proof()

    def test_wrong_signer_and_target_rejected(self):
        for field in ('from', 'to'):
            self.make(2)
            self.transaction[field] = '0x' + '55' * 20
            with self.assertRaisesRegex(RuntimeError, 'signer, target'):
                self.proof()

    def test_duplicate_foreign_wire_and_selector_rejected(self):
        for kind in ('duplicate', 'foreign', 'selector', 'mailbox'):
            self.make(2)
            if kind == 'duplicate':
                self.calls[1] = self.calls[0]
            elif kind == 'foreign':
                self.calls[1] = (self.mailbox, process_call(b'not the corpus'))
            elif kind == 'selector':
                self.calls[1] = (self.mailbox, bytes(4) + self.calls[1][1][4:])
            else:
                self.calls[1] = (self.contract, self.calls[1][1])
            self.transaction['input'] = aggregate(self.calls)
            with self.assertRaisesRegex(RuntimeError, 'foreign or duplicate|mailbox or selector'):
                self.proof()

    def test_call_count_and_aggregate_selector_rejected(self):
        self.transaction['input'] = aggregate(self.calls[:1])
        with self.assertRaisesRegex(RuntimeError, 'calls differ'):
            self.proof()
        self.transaction['input'] = '0x00000000' + aggregate(self.calls)[10:]
        with self.assertRaisesRegex(AssertionError, 'aggregate3'):
            self.proof()

    def test_chain_namespace_selects_actual_chain(self):
        receipt = copy.deepcopy(self.receipt)
        receipt['chain_namespace'] = 'anvil-2'
        foreign = mock.Mock()
        proof = bench.batch_membership_proof(self.messages, [receipt], {'anvil-1': foreign, 'anvil-2': self.chain}, {bench.DESTINATION: self.mailbox}, {'anvil-2': {'address': self.contract}}, 4)
        self.assertEqual(proof['groups'][0]['chain_namespace'], 'anvil-2')
        foreign.rpc.assert_not_called()

    def test_mixed_actual_batch_and_singleton_preserves_all_members(self):
        batch_receipt = copy.deepcopy(self.receipt)
        self.messages.append({'id': '0x' + '33' * 32, 'wire': bytes([3] * 77).hex(), 'destination': bench.DESTINATION})
        singleton = copy.deepcopy(self.receipt)
        singleton['transactionHash'] = '0x' + '66' * 32
        singleton['logs'] = [dict(singleton['logs'][0], transactionHash=singleton['transactionHash'], topics=[self.topic, self.messages[-1]['id']])]
        proof = bench.batch_membership_proof(self.messages, [batch_receipt, singleton], {'anvil-1': self.chain}, {bench.DESTINATION: self.mailbox}, {'anvil-1': {'address': self.contract}}, 4)
        self.assertEqual(proof['group_size_histogram'], {1: 1, 2: 1})
        self.assertEqual(proof['singleton_message_count'], 1)
        self.assertEqual(proof['batched_message_count'], 2)

    def test_batch_one_never_deploys_or_mutates(self):
        chain = mock.Mock()
        domains = {'test2': {}}
        with mock.patch.object(bench.relayer_process, 'deploy_multicall3') as deploy:
            self.assertIsNone(bench.setup_batch_contracts(1, [('anvil-1', chain, 'test2')], domains))
            deploy.assert_not_called()
        self.assertEqual(domains, {'test2': {}})
        chain.rpc.assert_not_called()

    def test_setup_both_destinations_and_reject_missing_code(self):
        domains = {'test2': {}, 'test3': {}}
        first, second = mock.Mock(), mock.Mock()
        first.rpc.return_value = second.rpc.return_value = '0x6001'
        with mock.patch.object(bench.relayer_process, 'deploy_multicall3', return_value=self.contract) as deploy:
            proof = bench.setup_batch_contracts(4, [('anvil-1', first, 'test2'), ('anvil-2', second, 'test3')], domains)
            self.assertEqual(deploy.call_count, 2)
            self.assertEqual(len(proof), 2)
            self.assertEqual(domains['test2']['batchContractAddress'], domains['test3']['batchContractAddress'])
            second.rpc.return_value = '0x'
            with self.assertRaisesRegex(RuntimeError, 'deployed Multicall3'):
                bench.setup_batch_contracts(4, [('anvil-1', first, 'test2'), ('anvil-2', second, 'test3')], domains)

    def test_mismatched_destination_code_rejected(self):
        first, second = mock.Mock(), mock.Mock()
        first.rpc.return_value = '0x6001'
        second.rpc.return_value = '0x6002'
        with mock.patch.object(bench.relayer_process, 'deploy_multicall3', return_value=self.contract), mock.patch.object(bench.evm, 'run', side_effect=['0x11', '0x22']):
            with self.assertRaisesRegex(RuntimeError, 'identical Multicall3'):
                bench.setup_batch_contracts(4, [('anvil-1', first, 'test2'), ('anvil-2', second, 'test3')], {'test2': {}, 'test3': {}})


if __name__ == '__main__':
    unittest.main(verbosity=2)
