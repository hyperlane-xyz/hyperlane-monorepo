#!/usr/bin/env python3
"""WSS scenario guards: real extracted Handler, fake connections; no fixture imports or sockets."""
import ast
import base64
import copy
import hashlib
import json
import pathlib
import struct
import socket
import time
import threading
import types
import unittest

SOURCE = pathlib.Path(__file__).with_name('relayer_stream.py')
TREE = ast.parse(SOURCE.read_text())
SERVER = next(node for node in TREE.body if isinstance(node, ast.ClassDef) and node.name == 'StreamServer')
ENTER = next(node for node in SERVER.body if isinstance(node, ast.FunctionDef) and node.name == '__enter__')
HANDLER = next(node for node in ENTER.body if isinstance(node, ast.ClassDef) and node.name == 'Handler')
CONSTANTS = [node for node in TREE.body if isinstance(node, ast.Assign) and any(
    (isinstance(target, ast.Name) and target.id == 'EVENT_KINDS') or
    (isinstance(target, ast.Tuple) and [item.id for item in target.elts] == ['ORIGIN_A', 'ORIGIN_B', 'DESTINATION'])
    for target in node.targets)]
API = {'threading': threading, 'copy': copy, 'json': json, 'hashlib': hashlib,
       'base64': base64, 'struct': struct, 'socket': socket, 'time': time, 'socketserver': types.SimpleNamespace(BaseRequestHandler=object)}
exec(compile(ast.Module(body=CONSTANTS + [SERVER], type_ignores=[]), str(SOURCE), 'exec'), API)
A, B, D = API['ORIGIN_A'], API['ORIGIN_B'], API['DESTINATION']
KINDS = API['EVENT_KINDS']


def subscription(domains, kinds=KINDS):
    return {'type': 'subscribe', 'streams': [
        {'eventType': kind, 'domains': list(domains), 'cursors': [
            {'domain': domain, 'address': 'public-' + str(domain),
             **({'afterStreamCursor': '0'} if kind == 'gas_payment' else {})}
            for domain in domains],
         **({'streamCursorVersion': 3} if kind == 'gas_payment' else {})}
        for kind in kinds]}


def server_at(index):
    server = API['StreamServer']()
    server.sessions = [{'index': i, 'mode': server.scenarios[i]} for i in range(index)]
    server.ready_gate.set()
    server.late_replay_gate.set()
    server.previous_ack = [{'eventType': 'dispatch', 'cursors': [{'domain': A, 'address': 'previous'}]}]
    server.sent_messages, server.frames = [], []
    server.send = lambda session, value: server.sent_messages.append((session['transport_index'], copy.deepcopy(value)))
    server.frame = lambda session, opcode, data: server.frames.append((opcode, data))
    server.receive = lambda connection: connection.next_frame()
    return server


class Connection:
    def __init__(self, messages, before_receive):
        self.header = bytearray(b'GET /events HTTP/1.1\r\nSec-WebSocket-Key: cHVibGljLWZpeHR1cmU=\r\n\r\n')
        self.frames = [(1, json.dumps(message).encode()) for message in messages]
        self.before_receive = before_receive
        self.upgrades, self.timeouts, self.reads = [], [], 0

    def settimeout(self, seconds):
        self.timeouts.append(seconds)

    def recv(self, count):
        value = bytes(self.header[:count])
        del self.header[:count]
        return value

    def sendall(self, value):
        self.upgrades.append(value)

    def next_frame(self):
        self.reads += 1
        if self.before_receive is not None:
            callback, self.before_receive = self.before_receive, None
            callback()
        if not self.frames:
            raise ConnectionError('fake EOF')
        return self.frames.pop(0)


def drive(server, messages=(), before_receive=None):
    namespace = dict(API, owner=server)
    exec(compile(ast.Module(body=[HANDLER], type_ignores=[]), str(SOURCE), 'exec'), namespace)
    handler = namespace['Handler']()
    handler.request = Connection(messages, before_receive)
    handler.handle()
    return server.transports[-1], handler.request


class ScenarioCommitTests(unittest.TestCase):
    def test_pre_subscribe_disconnect_does_not_consume_legacy_or_restart(self):
        for index in (0, 9):
            with self.subTest(index=index):
                server = server_at(index)
                attempt, connection = drive(server)
                self.assertEqual(len(server.sessions), index)
                self.assertIsNone(attempt['index'])
                self.assertTrue(attempt['closed'])
                self.assertFalse(attempt['subscribed'])
                self.assertEqual(server.errors, [])
                self.assertEqual(connection.timeouts, [.5])
                self.assertIn(b'101 Switching Protocols', connection.upgrades[0])

    def test_partial_membership_reconnects_commit_only_full_restart(self):
        server = server_at(9)
        previous = copy.deepcopy(server.previous_ack)
        drive(server)
        for domains in ([A], [A, D]):
            attempt, _ = drive(server, [subscription(domains)])
            self.assertIsNone(attempt['index'])
            self.assertTrue(attempt['subscribed'] and attempt['replayed'])
            self.assertEqual(attempt['subscription']['message'], subscription(domains))
            self.assertEqual(len(server.sessions), 9)
            self.assertEqual(server.subscriptions, [])
            self.assertEqual(server.previous_ack, previous)
        committed, _ = drive(server, [subscription([A, B, D])])
        self.assertEqual((committed['index'], committed['transport_index'], committed['mode']), (9, 3, 'restart'))
        self.assertIs(server.sessions[9], committed)
        self.assertEqual(len(server.subscriptions), 1)
        self.assertEqual(server.subscriptions[0]['transport_session'], 3)
        self.assertTrue(all(row['index'] is None for row in server.transports[:3]))

    def test_empty_startup_subscription_is_partial_not_scenario_completion(self):
        server = server_at(9)
        attempt, _ = drive(server, [subscription([])])
        self.assertIsNone(attempt['index'])
        self.assertTrue(attempt['subscribed'] and attempt['replayed'])
        self.assertEqual(len(server.sessions), 9)
        self.assertEqual(server.subscriptions, [])

    def test_late_domain_wait_begins_only_after_full_membership(self):
        server = server_at(8)
        drive(server, [subscription([A, D])])
        self.assertFalse(server.late_subscribed.is_set())
        attempt, _ = drive(server, [subscription([A, B, D])])
        self.assertTrue(server.late_subscribed.is_set())
        self.assertEqual((attempt['index'], attempt['mode']), (8, 'late'))

    def test_replay_and_publication_bind_each_partial_transport_subscription(self):
        server = server_at(9)
        for domains in ([A], [A, D]):
            attempt, _ = drive(server, [subscription(domains)])
            attempt['closed'] = False
        server.sent_messages.clear()
        server.add(D, 'dispatch', 0, {'public': True})
        server.publish(D)
        self.assertEqual(server.sent_messages, [(1, {'type': 'event', 'domain': D, 'eventType': 'dispatch', 'data': {'public': True}, 'sequence': '0'})])
        self.assertNotIn((D, 'dispatch'), server.transports[0]['sent'])
        self.assertEqual(server.transports[1]['sent'][(D, 'dispatch')], 0)
        self.assertEqual(server.subscriptions, [])

    def test_intentional_failed_slot_still_fails_before_ready_and_subscribe(self):
        server = server_at(1)
        attempt, connection = drive(server)
        self.assertEqual((attempt['index'], attempt['mode']), (1, 'failed'))
        self.assertEqual(len(server.sessions), 2)
        self.assertFalse(attempt['subscribed'] or attempt['replayed'])
        self.assertEqual(server.sent_messages, [])
        self.assertEqual(connection.reads, 0)

    def test_full_scenario_modes_and_fault_payloads_are_preserved(self):
        for index in range(10):
            with self.subTest(index=index):
                server = server_at(index)
                previous = copy.deepcopy(server.previous_ack)
                domains = [A, D] if index <= 7 else [A, B, D]
                attempt, connection = drive(server, [subscription(domains, KINDS[:2] if index == 0 else KINDS)])
                self.assertEqual((attempt['index'], attempt['mode']), (index, server.scenarios[index]))
                self.assertEqual(server.errors, [])
                values = [value for _, value in server.sent_messages]
                if index == 1:
                    self.assertEqual(values, [])
                    continue
                self.assertEqual(values[0], {'type': 'ready', 'streamCursorVersions': {'gas_payment': 2 if index == 0 else 3}})
                if index == 2:
                    self.assertEqual(values[1], {'type': 'subscribed', 'streams': previous})
                elif index == 4:
                    self.assertEqual(values[1]['streams'][0]['cursors'][0]['afterSequence'], '9223372036854775807')
                else:
                    self.assertEqual(values[1]['type'], 'subscribed')
                if index == 3:
                    self.assertEqual(server.frames, [(1, b'{not-json')])
                if index == 5:
                    self.assertEqual(values[-1]['eventType'], 'dispatch')
                    self.assertEqual(values[-1]['sequence'], '-1')
                    self.assertFalse(attempt['replayed'])
                if index in (2, 3, 4, 5, 6):
                    self.assertEqual(connection.reads, 1)
                if index in (0, 7, 8, 9):
                    self.assertTrue(attempt['replayed'])

    def test_invalid_membership_cannot_consume_scenario(self):
        mutations = [
            lambda value: value['streams'][0]['domains'].append(123),
            lambda value: value['streams'][0]['domains'].append(A),
            lambda value: value['streams'][0]['cursors'].append(copy.deepcopy(value['streams'][0]['cursors'][0])),
            lambda value: value['streams'][0]['cursors'].pop(),
            lambda value: value['streams'][0].update(domains=[A], cursors=[value['streams'][0]['cursors'][0]]),
            lambda value: value['streams'].pop(),
            lambda value: value['streams'].reverse(),
        ]
        for index, mutate in enumerate(mutations):
            with self.subTest(index=index):
                server = server_at(9)
                message = subscription([A, B, D])
                mutate(message)
                attempt, _ = drive(server, [message])
                self.assertEqual(len(server.sessions), 9)
                self.assertIsNone(attempt['index'])
                self.assertEqual(server.subscriptions, [])
                self.assertEqual(server.errors, [{'session': None, 'type': 'AssertionError'}])

    def test_repeated_subscription_rejects_without_extra_generation(self):
        server = server_at(9)
        message = subscription([A, B, D])
        attempt, _ = drive(server, [message, message])
        self.assertEqual((len(server.sessions), len(server.subscriptions)), (10, 1))
        self.assertEqual(server.errors, [{'session': 9, 'type': 'AssertionError'}])
        self.assertTrue(attempt['closed'])

    def test_stale_candidate_cannot_overwrite_another_committed_attempt(self):
        server = server_at(9)
        def other_commits():
            server.sessions.append({'index': 9, 'mode': 'restart', 'other_attempt': True})
        attempt, _ = drive(server, [subscription([A, B, D])], other_commits)
        self.assertTrue(server.sessions[9]['other_attempt'])
        self.assertIsNone(attempt['index'])
        self.assertEqual(server.subscriptions, [])
        self.assertEqual(server.errors, [{'session': None, 'type': 'AssertionError'}])


class RestartProofContractTests(unittest.TestCase):
    def readiness(self):
        parser = ast.parse(SOURCE.with_name('relayer_process.py').read_text())
        metric = next(node for node in parser.body if isinstance(node, ast.FunctionDef) and node.name == 'metric_value')
        namespace = {}
        exec(compile(ast.Module(body=[metric], type_ignores=[]), 'actual metric parser', 'exec'), namespace)
        ready = next(node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name == 'websocket_readiness_evidence')
        namespace['relayer_process'] = types.SimpleNamespace(metric_value=namespace['metric_value'])
        exec(compile(ast.Module(body=[ready], type_ignores=[]), str(SOURCE), 'exec'), namespace)
        body = '\n'.join(f'hyperlane_relayer_scraper_websocket_{family}{{chain="{chain}",agent="relayer",hyperlane_baselib_version="3.0.0"}} 1' for chain in ('test1', 'test3', 'test2') for family in ('active', 'authority', 'fresh'))
        return namespace['websocket_readiness_evidence'], body

    def test_readiness_requires_exact_current_restart_transport_and_mode(self):
        ready, body = self.readiness()
        server = server_at(9)
        committed, _ = drive(server, [subscription([A, B, D])])
        committed['closed'] = False
        self.assertEqual(ready(body, server, 9, 100)['tls_session'], 0)
        mutations = [
            (lambda: committed.update(closed=True), lambda: committed.update(closed=False)),
            (lambda: server.subscriptions[0].update(mode='healthy'), lambda: server.subscriptions[0].update(mode='restart')),
            (lambda: server.subscriptions[0].update(transport_session=1), lambda: server.subscriptions[0].update(transport_session=0)),
        ]
        for mutate, restore in mutations:
            mutate()
            with self.assertRaises(AssertionError):
                ready(body, server, 9, 100)
            restore()

    def test_every_chain_active_authority_fresh_metric_stays_mandatory(self):
        ready, body = self.readiness()
        server = server_at(9)
        committed, _ = drive(server, [subscription([A, B, D])])
        committed['closed'] = False
        for line in body.splitlines():
            with self.subTest(line=line):
                with self.assertRaises(AssertionError):
                    ready(body.replace(line, line[:-1] + '0'), server, 9, 100)

    def assert_cursors(self, streams):
        run = next(node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name == 'run_acceptance')
        loop = next(node for node in ast.walk(run) if isinstance(node, ast.For) and isinstance(node.target, ast.Name) and node.target.id == 'stream_value')
        namespace = {'restart_subscription': streams, 'hidden': {'nonce': 10}, 'ORIGIN_A': A, 'ORIGIN_B': B, 'DESTINATION': D}
        exec(compile(ast.Module(body=[loop], type_ignores=[]), str(SOURCE), 'exec'), namespace)

    def cursors(self):
        return [{'eventType': kind, 'cursors': [
            {'domain': A, **({'afterStreamCursor': '10'} if kind == 'gas_payment' else {'afterSequence': '8'})},
            {'domain': B, **({'afterStreamCursor': '1'} if kind == 'gas_payment' else {'afterSequence': '-1'})},
            {'domain': D, **({'afterStreamCursor': '0'} if kind == 'gas_payment' else {})}]}
            for kind in KINDS]

    def test_saved_positive_and_fresh_zero_cursors_are_accepted(self):
        self.assert_cursors(self.cursors())

    def test_missing_fresh_zero_and_wrong_saved_cursors_are_rejected(self):
        mutations = [
            lambda rows: rows[2]['cursors'][2].pop('afterStreamCursor'),
            lambda rows: rows[2]['cursors'][0].update(afterStreamCursor='9'),
            lambda rows: rows[2]['cursors'][1].update(afterStreamCursor='0'),
            lambda rows: rows[0]['cursors'][0].update(afterSequence='9'),
            lambda rows: rows[0]['cursors'][2].update(afterSequence='0'),
        ]
        for index, mutate in enumerate(mutations):
            with self.subTest(index=index):
                rows = self.cursors()
                mutate(rows)
                with self.assertRaises((AssertionError, KeyError)):
                    self.assert_cursors(rows)



class HeartbeatTests(unittest.TestCase):
    def open_transport(self, server):
        connection = types.SimpleNamespace(shutdown=lambda how: None)
        session = {"transport_index": 0, "index": 9, "mode": "restart", "connection": connection,
                   "closed": False, "upgraded": True, "subscribed": True, "replayed": True, "heartbeat_alive": True,
                   "sent": {"unchanged": 7}, "pong": threading.Event()}
        server.transports.append(session)
        return session

    def test_actual_legacy_wait_before_http_upgrade_never_receives_heartbeat(self):
        server = server_at(0)
        class HeldGate:
            def wait(self, seconds):
                server.heartbeat_once('held-before-upgrade')
                server.stop.set()
                return False
        server.ready_gate = HeldGate()
        attempt, connection = drive(server)
        self.assertFalse(attempt['upgraded'])
        self.assertEqual(connection.upgrades, [])
        self.assertEqual(server.frames, [])
        self.assertEqual(server.sent_messages, [])
        self.assertEqual(server.sessions, [])
        self.assertIsNone(attempt['index'])
        self.assertEqual(server.errors, [])

    def test_source_ping_and_heartbeat_pair_does_not_grant_progress(self):
        server = server_at(9)
        session = self.open_transport(server)
        before = (copy.deepcopy(session['sent']), len(server.sessions), len(server.subscriptions))
        server.heartbeat_once('public-time')
        self.assertEqual(server.frames, [(9, b'')])
        self.assertEqual(server.sent_messages, [(0, {'serverTime': 'public-time', 'type': 'heartbeat'})])
        self.assertFalse(session['heartbeat_alive'])
        self.assertEqual((session['sent'], len(server.sessions), len(server.subscriptions)), before)

    def test_missing_pong_closes_only_its_transport_before_next_heartbeat(self):
        server = server_at(9)
        missing = self.open_transport(server)
        healthy = self.open_transport(server)
        closed = []
        missing['connection'] = types.SimpleNamespace(shutdown=lambda how: closed.append(how))
        server.heartbeat_once('first')
        healthy['heartbeat_alive'] = True
        server.heartbeat_once('second')
        self.assertTrue(missing['closed'])
        self.assertFalse(healthy['closed'])
        self.assertEqual(closed, [socket.SHUT_RDWR])
        self.assertEqual(len(server.frames), 3)

    def test_actual_handler_pong_rearms_heartbeat_without_changing_scenario(self):
        server = server_at(9)
        namespace = dict(API, owner=server)
        exec(compile(ast.Module(body=[HANDLER], type_ignores=[]), str(SOURCE), 'exec'), namespace)
        connection = Connection([subscription((A, B, D))], None)
        connection.frames.append((10, b''))
        def first_tick():server.heartbeat_once('before-pong')
        connection.before_receive = first_tick
        handler = namespace['Handler']();handler.request = connection;handler.handle()
        self.assertTrue(server.sessions[9]['heartbeat_alive'])
        self.assertTrue(server.sessions[9]['pong'].is_set())
        self.assertEqual(server.sessions[9]['mode'], 'restart')
        self.assertEqual(len(server.sessions), 10)

    def test_heartbeat_skips_closed_failed_transport_and_preserves_all_fault_modes(self):
        server = server_at(9)
        session = self.open_transport(server);session['closed'] = True
        server.heartbeat_once('public-time')
        self.assertEqual(server.frames, [])
        self.assertEqual(server.sent_messages, [])
        self.assertEqual(server.scenarios[1:7], ['failed','stale_ack','malformed','rejected','freshness','disconnect'])

    def test_idle630_synthetic_seconds_remain_live_with_pongs_not_cursor_credit(self):
        server = server_at(9);session = self.open_transport(server)
        for seconds in range(30, 631, 30):
            server.heartbeat_once(str(seconds));session['heartbeat_alive'] = True
        self.assertFalse(session['closed'])
        self.assertEqual(len(server.frames), 21)
        self.assertEqual(session['sent'], {'unchanged': 7})
        self.assertEqual(len(server.subscriptions), 0)
        # Synthetic scheduling is not an elapsed600s/native transport proof.

    def test_stopped_loop_exits_without_another_tick_or_sleep(self):
        server = server_at(9);self.open_transport(server);server.stop.set()
        server.heartbeat_loop()
        self.assertEqual(server.frames, [])
        self.assertEqual(server.sent_messages, [])

if __name__ == '__main__':
    unittest.main()
