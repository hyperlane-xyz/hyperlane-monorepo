"""Schema and task-owned Unix protocol controls only; never a Docker call."""
import contextlib
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import socket
import tempfile
import threading
import time
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('radix_volume_controls', Path(__file__).with_name('native_radix_volume.py'))
m = importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
NAME = 'a' * 64


def payload(size=123):
    return {'Volumes': [{'Name': 'unrelated-public-volume', 'Driver': 'local', 'UsageData': {'Size': 987, 'RefCount': 0}}, {'Name': NAME, 'Driver': 'local', 'Options': None, 'UsageData': {'Size': size, 'RefCount': 1}}]}


def wire(value):
    return json.dumps(value, separators=(',', ':')).encode()


def response(raw):
    return b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ' + str(len(raw)).encode() + b'\r\n\r\n' + raw


class BytesSocket:
    def __init__(self, raw):self.raw = raw
    def settimeout(self, _value):pass
    def recv(self, amount):
        value, self.raw = self.raw[:amount], self.raw[amount:]
        return value


class RedirectSocket:
    """Test-only private Unix endpoint. Production still requests fixed SOCKET."""
    def __init__(self, target, requests):
        self.actual = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.target, self.requests = target, requests
    def connect(self, endpoint):
        if endpoint != m.SOCKET:raise AssertionError('Nonfixed native socket requested')
        self.requests.append(endpoint);self.actual.connect(self.target)
    def __getattr__(self, name):return getattr(self.actual, name)


class UnixPeer:
    def __init__(self, handler):
        self.handler = handler;self.stop = threading.Event();self.errors = [];self.requests = []
        self.temp = tempfile.TemporaryDirectory(prefix='rxv-', dir='/tmp')
        self.path = str(Path(self.temp.name) / 'peer.sock')
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.listener.bind(self.path);self.listener.listen(1);self.listener.settimeout(2)
        self.thread = threading.Thread(target=self.serve)
    def serve(self):
        try:
            connection, _ = self.listener.accept()
            with connection:
                connection.settimeout(1);request = b''
                while not request.endswith(b'\r\n\r\n'):
                    chunk = connection.recv(4096)
                    if not chunk:raise AssertionError('Missing fixed request')
                    request += chunk
                    if len(request) > 4096:raise AssertionError('Request bound')
                self.requests.append(request)
                if request != m.REQUEST:raise AssertionError('Unexpected HTTP request')
                self.handler(connection, self.stop)
        except (BrokenPipeError, ConnectionResetError):pass
        except Exception as error:self.errors.append(type(error).__name__ + ':' + str(error))
    def identity(self):
        row = Path(self.path).stat()
        return {'device': row.st_dev, 'inode': row.st_ino}
    def __enter__(self):self.thread.start();return self
    def __exit__(self, *_args):
        self.stop.set();self.listener.close();self.thread.join(3)
        self.temp.cleanup()
        if self.thread.is_alive():raise AssertionError('Owned fake Unix peer thread remains')
        if self.errors:raise AssertionError(self.errors)
    @contextlib.contextmanager
    def redirect(self):
        requested = []
        with mock.patch.object(m, '_socket_identity', side_effect=self.identity), mock.patch.object(m, '_new_socket', side_effect=lambda: RedirectSocket(self.path, requested)):
            yield requested


class SchemaControls(unittest.TestCase):
    def test_zero_and_large_literal_bytes_are_exact_not_formatted_or_aggregated(self):
        for size in (0, 123, 2**53 + 7, 2**63 - 1):
            value = m.selected_volume(wire(payload(size)), NAME)
            self.assertEqual(value['size_bytes'], size);self.assertEqual(value['reference_count'], 1)
            self.assertEqual(value['name'], NAME)
    def test_missing_unknown_boolean_float_string_or_overflow_size_rejects(self):
        for size in (-1, None, True, False, 1.5, '1.5GB', 2**63):
            with self.subTest(size=size), self.assertRaises(ValueError):m.selected_volume(wire(payload(size)), NAME)
        value = payload();del value['Volumes'][1]['UsageData']['Size']
        with self.assertRaises(ValueError):m.selected_volume(wire(value), NAME)
    def test_missing_duplicated_or_foreign_captured_volume_cannot_be_zero(self):
        for value in ({}, {'Volumes': []}, {'Volumes': [payload()['Volumes'][0]]}, {'Volumes': [payload()['Volumes'][1]] * 2}):
            with self.subTest(value=value), self.assertRaises(ValueError):m.selected_volume(wire(value), NAME)
        with self.assertRaises(ValueError):m.selected_volume(wire(payload()), 'not-a-captured-anonymous-name')
    def test_local_driver_options_and_reference_count_are_typed(self):
        for key, value in [('Driver', 'foreign'), ('Options', {'device': 'foreign'}), ('ClusterVolume', {}), ('UsageData', {'Size': 1, 'RefCount': True}), ('UsageData', {'Size': 1})]:
            changed = payload();changed['Volumes'][1][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):m.selected_volume(wire(changed), NAME)
    def test_duplicate_json_keys_at_root_and_nested_depth_reject(self):
        for raw in (b'{"Volumes":[],"Volumes":[]}', ('{"Volumes":[{"Name":"' + NAME + '","Driver":"local","UsageData":{"Size":1,"Size":0,"RefCount":1}}]}').encode()):
            with self.assertRaises(ValueError):m.selected_volume(raw, NAME)
    def test_no_arbitrary_or_foreign_volume_subtrees_enter_observation(self):
        value = payload();value['Volumes'][0]['Mountpoint'] = 'FOREIGN-DO-NOT-EXPORT'
        value['Volumes'][1]['Labels'] = {'private': 'SELECTED-DO-NOT-EXPORT'}
        selected = m.selected_volume(wire(value), NAME)
        self.assertNotIn('DO-NOT-EXPORT', json.dumps(selected))
        row = json.dumps(value['Volumes'][1], sort_keys=True, separators=(',', ':')).encode()
        self.assertEqual(selected['selected_row_fingerprint'], {'bytes': len(row), 'sha256': hashlib.sha256(row).hexdigest()})
    def test_response_bounds_nonfinite_and_absent_json_refused(self):
        for raw in (b'', b'x' * (m.BODY_LIMIT + 1), b'{"Volumes":NaN}'):
            with self.assertRaises(ValueError):m.selected_volume(raw, NAME)
    def test_content_length_and_chunked_frames_preserve_exact_body(self):
        raw = wire(payload());reader = m._Response(BytesSocket(response(raw)), time.monotonic_ns() + 10**9)
        self.assertEqual(reader.read(), raw)
        chunks = b''.join(format(len(chunk), 'x').encode() + b'\r\n' + chunk + b'\r\n' for chunk in [raw[:7], raw[7:]]) + b'0\r\n\r\n'
        reader = m._Response(BytesSocket(b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n' + chunks), time.monotonic_ns() + 10**9)
        self.assertEqual(reader.read(), raw)
    def test_header_smuggling_wrong_status_encoding_and_truncated_body_refused(self):
        raw = wire(payload());good = response(raw)
        for bad in (good.replace(b'200 OK', b'302 Moved'), good.replace(b'Content-Type:', b'Content-Encoding: gzip\r\nContent-Type:'), good.replace(b'Content-Length:', b'Transfer-Encoding: chunked\r\nContent-Length:'), good.replace(b'Content-Length:', b'Content-Length: 0\r\nContent-Length:'), good[:-1]):
            with self.subTest(bad=bad[:80]), self.assertRaises(ValueError):m._Response(BytesSocket(bad), time.monotonic_ns() + 10**9).read()
    def test_original_expired_deadline_or_name_refuses_before_any_socket(self):
        with mock.patch.object(m, '_new_socket', side_effect=AssertionError('Must reject before socket')):
            with self.assertRaises(ValueError):m.sample_volume(NAME, time.monotonic_ns() - 1)
            with self.assertRaises(ValueError):m.sample_volume('foreign', time.monotonic_ns() + 10**9)


class LocalUnixControls(unittest.TestCase):
    def test_actual_owned_unix_exchange_pins_bytes_and_joins_timer(self):
        raw = wire(payload())
        with UnixPeer(lambda connection, _stop: connection.sendall(response(raw))) as peer, peer.redirect() as requested:
            value = m.sample_volume(NAME, time.monotonic_ns() + 10**9)
        self.assertEqual(requested, [m.SOCKET]);self.assertEqual(peer.requests, [m.REQUEST]);self.assertEqual(value['size_bytes'], 123)
        self.assertTrue(value['timer_joined'] and value['socket_closed']);self.assertFalse(value['parent_wait_credit'] or value['daemon_mutation'])
        self.assertEqual(value['response_fingerprint'], {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()})
    def test_full_four_second_header_trickle_is_actually_stopped(self):
        def trickle(connection, stop):
            connection.sendall(b'HTTP/1.1 200 OK\r\nX-Incomplete: ')
            while not stop.wait(.08):connection.sendall(b'x')
        started = time.monotonic()
        with UnixPeer(trickle) as peer, peer.redirect():
            with self.assertRaises(m.VolumeObservationError) as caught:m.sample_volume(NAME, time.monotonic_ns() + 30 * 10**9)
        elapsed = time.monotonic() - started;value = caught.exception.evidence
        self.assertGreaterEqual(elapsed, 3.7);self.assertLess(elapsed, 5.5)
        self.assertLessEqual(value['whole_deadline_ns'] - value['started_monotonic_ns'], 4 * 10**9)
        self.assertGreater(value['wire_fingerprint']['bytes'], 0);self.assertTrue(value['timer_joined'] and value['socket_closed'])
    def test_original_short_deadline_stops_partial_body_not_per_read_timeout(self):
        raw = wire(payload())
        def trickle(connection, stop):
            connection.sendall(response(raw)[:-len(raw)])
            for byte in raw:
                if stop.wait(.04):return
                connection.sendall(bytes([byte]))
        started = time.monotonic();deadline = time.monotonic_ns() + 250_000_000
        with UnixPeer(trickle) as peer, peer.redirect():
            with self.assertRaises(m.VolumeObservationError) as caught:m.sample_volume(NAME, deadline)
        value = caught.exception.evidence
        self.assertLess(time.monotonic() - started, 1.5);self.assertEqual(value['whole_deadline_ns'], deadline)
        self.assertTrue(value['timer_joined'] and value['socket_closed']);self.assertGreater(value['wire_fingerprint']['bytes'], 0)
        self.assertNotIn('response_fingerprint', value)
    def test_actual_partial_eof_preserved_as_failure_without_wait_credit(self):
        def partial(connection, _stop):connection.sendall(response(wire(payload()))[:-20])
        with UnixPeer(partial) as peer, peer.redirect():
            with self.assertRaises(m.VolumeObservationError) as caught:m.sample_volume(NAME, time.monotonic_ns() + 10**9)
        value = caught.exception.evidence
        self.assertEqual(value['outcome'], 'failure');self.assertFalse(value['parent_wait_credit'])
        self.assertTrue(value['timer_joined'] and value['socket_closed']);self.assertGreater(value['wire_fingerprint']['bytes'], 0)
    def test_socket_identity_change_refuses_even_valid_reply(self):
        raw = wire(payload())
        with UnixPeer(lambda connection, _stop: connection.sendall(response(raw))) as peer:
            original = peer.identity();changed = dict(original, inode=original['inode'] + 1)
            with mock.patch.object(m, '_socket_identity', side_effect=[original, original, changed]), mock.patch.object(m, '_new_socket', side_effect=lambda: RedirectSocket(peer.path, [])):
                with self.assertRaises(m.VolumeObservationError) as caught:m.sample_volume(NAME, time.monotonic_ns() + 10**9)
        self.assertTrue(caught.exception.evidence['socket_closed'])
    def test_actual_timer_cancels_blocked_connect_without_resetting_case_deadline(self):
        released = threading.Event()
        class BlockedConnect:
            closed = False
            def settimeout(self, _timeout):pass
            def connect(self, endpoint):
                if endpoint != m.SOCKET:raise AssertionError('Nonfixed socket')
                if not released.wait(2):raise AssertionError('Timer did not interrupt connect')
                raise OSError('test-owned connect interrupted')
            def shutdown(self, _how):released.set()
            def close(self):self.closed = True;released.set()
            def fileno(self):return -1 if self.closed else 7
        connection = BlockedConnect();deadline = time.monotonic_ns() + 200_000_000;started = time.monotonic()
        with mock.patch.object(m, '_socket_identity', return_value={'device': 1, 'inode': 2}), mock.patch.object(m, '_new_socket', return_value=connection):
            with self.assertRaises(m.VolumeObservationError) as caught:m.sample_volume(NAME, deadline)
        value = caught.exception.evidence
        self.assertLess(time.monotonic() - started, 1.5);self.assertTrue(released.is_set())
        self.assertEqual(value['whole_deadline_ns'], deadline);self.assertTrue(value['whole_timeout_observed'] and value['timer_joined'] and value['socket_closed'])


if __name__ == '__main__':
    # The only sockets are test-owned AF_UNIX endpoints; no subprocess/native
    # client/SDK or daemon access can silently be added to these controls.
    with mock.patch('subprocess.Popen', side_effect=AssertionError('No native execution in volume controls')):
        unittest.main()
