"""One bounded read-only native Engine observation, not an OS child wait.

Only the captured anonymous PG15 volume is retained. No URL/config/environment
overrides, daemon mutation, credential handling or foreign volume data output.
"""
import hashlib
import json
import os
import re
import socket
import stat
import threading
import time

SOCKET = '/var/run/docker.sock'
PATH = '/v1.45/system/df?type=volume'
BODY_LIMIT = 2 * 1024 * 1024
HEADER_LIMIT = 16 * 1024
REQUEST = ('GET ' + PATH + ' HTTP/1.1\r\nHost: localhost\r\nAccept: application/json\r\nConnection: close\r\n\r\n').encode('ascii')


class VolumeObservationError(ValueError):
    def __init__(self, evidence):
        super().__init__('RadixVolumeObservationFailed')
        self.evidence = evidence


def require(value, message):
    if not value:
        raise ValueError(message)


def fingerprint(raw):
    return {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}


def _socket_identity():
    row = os.stat(SOCKET)
    require(stat.S_ISSOCK(row.st_mode), 'Native Docker Unix socket required')
    return {'device': row.st_dev, 'inode': row.st_ino}


def _new_socket():
    return socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)


def _unique_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'Duplicate Engine JSON key')
            result[key] = value
        return result
    def constant(_value):
        raise ValueError('Nonfinite Engine JSON number')
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)


def selected_volume(raw, captured_name):
    """Exact typed byte count. Missing/unknown data never becomes zero."""
    require(type(raw) is bytes and 0 < len(raw) <= BODY_LIMIT, 'Bounded Engine JSON bytes required')
    require(isinstance(captured_name, str) and re.fullmatch('[0-9a-f]{64}', captured_name), 'Exact captured anonymous volume name required')
    value = _unique_json(raw)
    require(isinstance(value, dict) and isinstance(value.get('Volumes'), list) and len(value['Volumes']) <= 4096, 'Engine volume list required')
    rows = [row for row in value['Volumes'] if isinstance(row, dict) and row.get('Name') == captured_name]
    require(len(rows) == 1, 'Exact one captured Engine volume required')
    row = rows[0]
    require(row.get('Driver') == 'local' and row.get('Options') in (None, {}) and row.get('ClusterVolume') is None, 'Only the captured local volume is admitted')
    usage = row.get('UsageData')
    require(isinstance(usage, dict) and type(usage.get('Size')) is int and 0 <= usage['Size'] < 2**63, 'Actual nonnegative int64 volume byte count required')
    require(type(usage.get('RefCount')) is int and usage['RefCount'] >= 0, 'Actual volume reference count required')
    # The digest is of the complete selected row, but arbitrary row subtrees
    # (mountpoints/labels/unknown fields) never enter the returned public data.
    canonical = json.dumps(row, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
    return {'name': captured_name, 'driver': 'local', 'size_bytes': usage['Size'], 'reference_count': usage['RefCount'], 'selected_row_fingerprint': fingerprint(canonical)}


class _Response:
    def __init__(self, connection, deadline):
        self.connection = connection
        self.deadline = deadline
        self.buffer = bytearray()
        self.wire_bytes = 0
        self.wire_digest = hashlib.sha256()

    def receive(self):
        remaining = self.deadline - time.monotonic_ns()
        require(remaining > 0, 'Whole volume observation deadline expired')
        self.connection.settimeout(remaining / 10**9)
        data = self.connection.recv(65536)
        self.wire_bytes += len(data)
        self.wire_digest.update(data)
        require(self.wire_bytes <= BODY_LIMIT + 128 * 1024, 'Engine response framing bound')
        require(data, 'Truncated Engine response')
        self.buffer.extend(data)

    def line(self, maximum):
        while True:
            index = self.buffer.find(b'\r\n')
            if index >= 0:
                require(index <= maximum, 'Engine response line bound')
                value = bytes(self.buffer[:index]);del self.buffer[:index + 2]
                return value
            require(len(self.buffer) <= maximum, 'Engine response line bound')
            self.receive()

    def exact(self, length):
        require(0 <= length <= BODY_LIMIT, 'Engine response body bound')
        while len(self.buffer) < length:
            self.receive()
        value = bytes(self.buffer[:length]);del self.buffer[:length]
        return value

    def read(self):
        status = self.line(4096)
        parts = status.split(b' ', 2)
        require(len(parts) >= 2 and parts[0] == b'HTTP/1.1' and parts[1] == b'200', 'Exact successful native Engine HTTP reply required')
        headers = {};size = len(status) + 2
        while True:
            line = self.line(HEADER_LIMIT);size += len(line) + 2
            require(size <= HEADER_LIMIT, 'Engine header bound')
            if not line:break
            require(b':' in line and not line[:1].isspace(), 'Invalid Engine header')
            key, value = line.split(b':', 1);key = key.lower()
            require(re.fullmatch(b'[a-z0-9-]+', key) and key not in headers, 'Duplicate/invalid Engine header')
            headers[key] = value.strip().lower()
        require(headers.get(b'content-type', b'').split(b';', 1)[0] == b'application/json' and headers.get(b'content-encoding', b'identity') == b'identity', 'Unencoded Engine JSON required')
        if b'content-length' in headers:
            require(b'transfer-encoding' not in headers and re.fullmatch(b'0|[1-9][0-9]*', headers[b'content-length']), 'Ambiguous Engine response framing')
            raw = self.exact(int(headers[b'content-length']))
        else:
            require(headers.get(b'transfer-encoding') == b'chunked', 'Explicit bounded Engine response framing required')
            chunks = [];total = 0
            for _ in range(4096):
                line = self.line(32)
                require(re.fullmatch(b'[0-9A-Fa-f]{1,8}', line), 'Closed Engine chunk size required')
                length = int(line, 16)
                if length == 0:
                    require(self.line(2) == b'', 'Engine trailers forbidden')
                    break
                total += length;require(total <= BODY_LIMIT, 'Engine decoded body bound')
                chunks.append(self.exact(length));require(self.exact(2) == b'\r\n', 'Engine chunk delimiter differs')
            else:raise ValueError('Engine chunk count bound')
            raw = b''.join(chunks)
        require(not self.buffer, 'Unexpected bytes after Engine JSON response')
        return raw


def sample_volume(captured_name, original_case_deadline_ns):
    """Fixed Unix GET, <=4s whole (headers/body included), original clock intact.

    Caller must already have immutable CID/mount/volume custody and retain the
    maximum size across observations. This function confers no deletion rights.
    """
    require(isinstance(captured_name, str) and re.fullmatch('[0-9a-f]{64}', captured_name), 'Exact captured volume required')
    started = time.monotonic_ns()
    require(type(original_case_deadline_ns) is int and started < original_case_deadline_ns, 'Original unexpired case deadline required')
    deadline = min(original_case_deadline_ns, started + 4 * 10**9)
    evidence = {'schema': 1, 'kind': 'radix-owned-volume-byte-observation', 'name': captured_name, 'request': 'GET ' + PATH, 'started_monotonic_ns': started, 'whole_deadline_ns': deadline, 'original_case_deadline_ns': original_case_deadline_ns, 'parent_wait_credit': False, 'daemon_mutation': False}
    connection = None;timer = None;expired = threading.Event();raw = None;reader = None;failure = None
    def expire():
        expired.set()
        if connection is not None:
            try:connection.shutdown(socket.SHUT_RDWR)
            except OSError:pass
            try:connection.close()
            except OSError:pass
    try:
        identity = _socket_identity();evidence['socket_identity'] = identity
        connection = _new_socket()
        # Keep the actual socket object, not a numeric FD which could be reused.
        timer = threading.Timer(max(0, deadline - time.monotonic_ns()) / 10**9, expire)
        timer.start()
        connection.settimeout(max(.000001, deadline - time.monotonic_ns()) / 10**9)
        connection.connect(SOCKET)
        require(_socket_identity() == identity, 'Native Docker socket replaced while connecting')
        connection.sendall(REQUEST)
        reader = _Response(connection, deadline);raw = reader.read()
        selected = selected_volume(raw, captured_name)
        require(_socket_identity() == identity and not expired.is_set() and time.monotonic_ns() <= deadline, 'Whole volume observation expired/socket replaced')
        evidence.update(selected, response_fingerprint=fingerprint(raw), outcome='success')
    except Exception as error:
        failure = type(error).__name__;evidence.update(outcome='failure', error_type=failure)
    finally:
        if timer is not None:
            timer.cancel();timer.join()
        if connection is not None:connection.close()
        evidence.update(completed_monotonic_ns=time.monotonic_ns(), timer_joined=timer is None or not timer.is_alive(), socket_closed=connection is None or connection.fileno() == -1, whole_timeout_observed=expired.is_set())
        if raw is not None:evidence['response_fingerprint'] = fingerprint(raw)
        if reader is not None:evidence['wire_fingerprint'] = {'bytes':reader.wire_bytes,'sha256':reader.wire_digest.hexdigest()}
    if failure is None and (expired.is_set() or evidence['completed_monotonic_ns'] > deadline):
        failure='WholeDeadlineExceeded';evidence.update(outcome='failure',error_type=failure)
    if failure is not None:raise VolumeObservationError(evidence)
    require(evidence['timer_joined'] and evidence['socket_closed'], 'Volume observer cleanup failed')
    return evidence
