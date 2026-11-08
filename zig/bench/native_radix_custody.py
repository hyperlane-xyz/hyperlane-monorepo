"""Radix Compose custody. Caller owns bounded Docker clients and their waits.

Daemon objects never receive direct-parent-wait credit. Imports perform no I/O.
"""
import errno
import hashlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import select
import selectors
import socket
import subprocess
import threading
import time

GIB = 1024 ** 3
MIB = 1024 ** 2
SERVICES = {
    'fullnode': (1536, 256, {'3333/tcp': 3333}),
    'postgres_db': (512, 128, {'5432/tcp': 5433}),
    'database_migrations_image': (256, 128, {}),
    'data_aggregator_image': (1024, 256, {'8080/tcp': 5207, '1234/tcp': 1234}),
    'gateway_api_image': (512, 128, {'8080/tcp': 5308, '1235/tcp': 1235}),
}
PROJECT_LABEL = 'com.docker.compose.project'
SERVICE_LABEL = 'com.docker.compose.service'
TOKEN_LABEL = 'io.hyperlane.ziggy.radix-token'
PGDATA = '/var/lib/postgresql/data'


def require(ok, message):
    if not ok:
        raise ValueError(message)


def shared():
    path = Path(__file__).with_name('native_starknet_custody.py')
    spec = importlib.util.spec_from_file_location('radix_custody_records', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def project_name(case, pid):
    require(type(pid) is int and pid > 0, 'Actual helper PID required')
    return 'ziggy-e2e-' + hashlib.sha256(os.fsencode(case)).hexdigest()[:10] + '-' + str(pid) + '-radix'


def resource_charge(host_ram, case_bytes, initial_free, current_free, writable_bytes=0, volume_bytes=0):
    require(all(type(v) is int and v >= 0 for v in (host_ram, case_bytes, initial_free, current_free, writable_bytes, volume_bytes)), 'Actual resource observations required')
    # Five Compose hard caps plus separate agent PG14 cap. Direct volume bytes
    # remain charged even when unrelated filesystem deletions mask free decline.
    reservation = sum(v[0] for v in SERVICES.values()) * MIB + GIB
    return host_ram + reservation, max(case_bytes + writable_bytes + volume_bytes, max(0, initial_free - current_free)) + 2 * GIB


def public_resource_failure(host_ram, case_bytes, initial_free, current_free, writable_bytes, volume_bytes, charged_ram, charged_disk, observed_ns, deadline_ns):
    """Closed scalar failure evidence only; does not alter resource admission."""
    require(all(type(v) is int and v >= 0 for v in (host_ram, case_bytes, initial_free, current_free, writable_bytes, volume_bytes, charged_ram, charged_disk, observed_ns, deadline_ns)), 'Actual bounded Radix resource failure values required')
    require(all(v < 2 ** 63 for v in (host_ram, case_bytes, initial_free, current_free, writable_bytes, volume_bytes, charged_ram, charged_disk, observed_ns, deadline_ns)), 'Radix resource diagnostic scalar bound')
    require((charged_ram, charged_disk) == resource_charge(host_ram, case_bytes, initial_free, current_free, writable_bytes, volume_bytes), 'Radix diagnostic differs from original resource charge')
    limits = {'RAM_bytes': 8 * GIB, 'disk_bytes': 8 * GIB, 'host_free_bytes': 6 * GIB}
    checks = {'before_original_deadline': observed_ns < deadline_ns, 'RAM_within_limit': charged_ram <= limits['RAM_bytes'], 'disk_within_limit': charged_disk <= limits['disk_bytes'], 'host_free_above_floor': current_free >= limits['host_free_bytes']}
    require(not all(checks.values()), 'Radix resource failure diagnostic requires actual failing conjunction')
    record = {'schema': 1, 'kind': 'public-radix-resource-limit-failure', 'observed_monotonic_ns': observed_ns, 'original_deadline_monotonic_ns': deadline_ns, 'owned_host_RAM_bytes': host_ram, 'case_allocated_bytes': case_bytes, 'maximum_five_service_writable_bytes': writable_bytes, 'maximum_captured_gateway_PG15_volume_bytes': volume_bytes, 'initial_host_free_bytes': initial_free, 'current_host_free_bytes': current_free, 'host_free_drop_bytes': max(0, initial_free - current_free), 'case_plus_writable_plus_volume_bytes': case_bytes + writable_bytes + volume_bytes, 'container_RAM_reservation_bytes': sum(v[0] for v in SERVICES.values()) * MIB + GIB, 'agent_PG_tmpfs_reservation_bytes': 2 * GIB, 'charged_RAM_bytes': charged_ram, 'charged_disk_bytes': charged_disk, 'limits': limits, 'conjuncts': checks, 'native_or_timing_credit': False}
    require(len(json.dumps(record, sort_keys=True, separators=(',', ':')).encode()) <= 4096, 'Radix resource diagnostic byte bound')
    return record


def missing_object(status, stderr, target, kind):
    if status != 1 or kind not in {'network', 'volume'}:
        return False
    text = stderr.decode().strip()
    return text in ({'Error: No such object: ' + target,
                     'Error response from daemon: network ' + target + ' not found'} if kind == 'network' else
                    {'Error: No such volume: ' + target,
                     'Error response from daemon: get ' + target + ': no such volume'})


def client_waits(path, parent, tool, source, mode):
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 1024 * 1024, 'Bounded Source Docker client receipts required')
    rows = [json.loads(line) for line in path.read_text().splitlines()]
    require(0 < len(rows) <= 256, 'Bounded nonempty actual client wait set required')
    identities, up, down = set(), False, False
    for row in rows:
        require(type(row.get('schema')) is int and row['schema'] == 1 and row.get('purpose') == 'radix-fixture-docker-client' and row.get('runtime_source_commit') == source and row.get('mode') == mode and type(row.get('parent_pid')) is int and row['parent_pid'] == parent and type(row.get('pid')) is int and row['pid'] > 0 and row.get('os') == 'linux' and isinstance(row.get('os_start_token'), str) and re.fullmatch('linux-ticks:[1-9][0-9]*', row['os_start_token']), 'Source Docker client identity differs')
        identity = (row['pid'], row['os_start_token'])
        require(identity not in identities and row.get('executable') == tool and row.get('parent_wait_completed') is True and type(row.get('exit_code')) is int and row['exit_code'] == 0 and row.get('signal') is None and row.get('forced_cleanup') is False and row.get('success') is True and row.get('error') is None, 'Source Docker client did not complete cleanly')
        identities.add(identity)
        require(type(row.get('elapsed_monotonic_ns')) is int and row['elapsed_monotonic_ns'] >= 0 and type(row.get('output_bytes')) is int and 0 <= row['output_bytes'] <= 4 * MIB and isinstance(row.get('output_sha256'), str) and re.fullmatch('[0-9a-f]{64}', row['output_sha256']), 'Source Docker client clock/output observation absent')
        args = row.get('arguments')
        require(isinstance(args, list) and args and all(isinstance(a, str) for a in args), 'Source Docker client arguments absent')
        if args[0] == 'compose':
            up |= args[-5:] == ['up', '--detach', '--no-build', '--pull', 'never']
            down |= args[-4:] == ['down', '--timeout', '15', '--volumes']
    require(up and down, 'Actual Source Compose up/down client waits missing')
    return rows


def ownership(row, project, fixture, previous=None):
    labels = row.get('Config', {}).get('Labels') or {}
    service, cid = labels.get(SERVICE_LABEL), row.get('Id')
    require(service in SERVICES and labels.get(PROJECT_LABEL) == project and labels.get(TOKEN_LABEL) == fixture['token'], 'Foreign Radix service; no cleanup authority')
    require(isinstance(cid, str) and re.fullmatch('[0-9a-f]{64}', cid) and row.get('Image') == fixture['images'][service]['id'] and (previous is None or previous == cid), 'Foreign or replaced Radix image/CID')
    return service, cid


def public_network_ports(row, service):
    """Only known service port keys and categorized host bindings; no raw IPs."""
    settings = row.get('NetworkSettings')
    out = {'status': 'invalid', 'known_ports': {}, 'other_port_key_count': 0}
    if not isinstance(settings, dict):
        return out
    if 'Ports' not in settings:
        out['status'] = 'missing'
        return out
    value = settings['Ports']
    if value is None:
        out['status'] = 'null'
        return out
    if not isinstance(value, dict):
        return out
    allowed = SERVICES[service][2]
    out['status'] = 'map'
    out['other_port_key_count'] = len(value) - sum(key in value for key in allowed)
    for key in allowed:
        record = {'status': 'missing', 'bindings': []}
        out['known_ports'][key] = record
        if key not in value:
            continue
        bindings = value[key]
        if bindings is None:
            record['status'] = 'null'
            continue
        if not isinstance(bindings, list) or len(bindings) > 4:
            record['status'] = 'invalid'
            continue
        record['status'] = 'bindings'
        for binding in bindings:
            if not isinstance(binding, dict):
                record['status'] = 'invalid'
                continue
            host, port = binding.get('HostIp'), binding.get('HostPort')
            if isinstance(port, str) and re.fullmatch('[0-9]{1,5}', port):
                port = int(port)
            if not isinstance(host, str) or len(host) > 64 or type(port) is not int or not 0 < port < 65536:
                record['status'] = 'invalid'
                continue
            if host == '':
                category = 'wildcard'
            else:
                try:
                    address = ipaddress.ip_address(host)
                    category = 'wildcard' if address.is_unspecified else 'loopback' if address.is_loopback else 'other'
                except ValueError:
                    record['status'] = 'invalid'
                    continue
            record['bindings'].append({'host_ip_category': category, 'host_port': port})
    return out


def public_service_state(row, service, observed_ns):
    """Closed diagnostics from an already authenticated CID; never raw inspect."""
    state = row.get('State')
    out = {'service': service, 'container_id': row['Id'], 'image_id': row['Image'],
           'observed_monotonic_ns': observed_ns, 'state': {}, 'invalid_fields': [], 'network_ports': public_network_ports(row, service)}
    if not isinstance(state, dict):
        out['invalid_fields'].append('State')
        return out
    for key in ('Running', 'OOMKilled', 'Dead', 'Restarting', 'Paused'):
        if key in state:
            if type(state[key]) is bool: out['state'][key] = state[key]
            else: out['invalid_fields'].append(key)
    for key in ('Pid', 'ExitCode'):
        if key in state:
            value = state[key]
            if type(value) is int and (0 <= value <= 2147483647 if key == 'Pid' else -255 <= value <= 255): out['state'][key] = value
            else: out['invalid_fields'].append(key)
    if 'Status' in state:
        if state['Status'] in ('created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead'): out['state']['Status'] = state['Status']
        else: out['invalid_fields'].append('Status')
    for key in ('StartedAt', 'FinishedAt'):
        if key in state:
            if isinstance(state[key], str) and re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})', state[key]): out['state'][key] = state[key]
            else: out['invalid_fields'].append(key)
    return out


def capture_fullnode_log(target, prefix, environment, output, deadline):
    """Owned fixture CID only; tail80, retained16KiB, read3s plus bounded wait."""
    require(set(target) == {'service', 'container_id', 'image_id', 'project'} and target['service'] == 'fullnode' and re.fullmatch('[0-9a-f]{64}', target['container_id']) and re.fullmatch('sha256:[0-9a-f]{64}', target['image_id']), 'Exact failed fullnode log authority required')
    require(len(prefix) == 5 and Path(prefix[0]).is_absolute() and prefix[1] == '--host' and prefix[2] == 'unix:///var/run/docker.sock' and prefix[3] == '--config' and Path(prefix[4]).is_absolute(), 'Exact native Docker log prefix required')
    require(output.name == 'radix-fullnode-failure.log' and not output.exists() and not output.is_symlink(), 'Preserve exact bounded Radix diagnostic')
    entered = time.monotonic()
    end = min(deadline, entered + 3)
    require(entered < end, 'No diagnostic time remains')
    arguments = ['container', 'logs', '--tail', '80', '--timestamps', target['container_id']]
    result = {'schema': 1, 'service': 'fullnode', 'container_id': target['container_id'], 'image_id': target['image_id'], 'project': target['project'], 'capture_status': 'unavailable', 'tail_lines': 80, 'maximum_retained_bytes': 16384, 'read_deadline_seconds': end, 'entered_monotonic_ns': time.monotonic_ns(), 'actual_parent_wait': False, 'pid': None, 'exit_code': None, 'cleanup_failures': []}
    child = None
    selector = None
    retained = 0
    digest = hashlib.sha256()
    with output.open('xb') as stream:
        os.chmod(output, 0o600)
        try:
            child = subprocess.Popen([*prefix, *arguments], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=environment)
            result['pid'] = child.pid
            os.set_blocking(child.stdout.fileno(), False)
            selector = selectors.DefaultSelector()
            selector.register(child.stdout, selectors.EVENT_READ)
            while True:
                remaining = end - time.monotonic()
                if remaining <= 0:
                    result['capture_status'] = 'deadline'
                    break
                if not selector.select(min(.05, remaining)):
                    continue
                block = os.read(child.stdout.fileno(), min(4096, 16384 - retained))
                if not block:
                    result['capture_status'] = 'complete'
                    break
                stream.write(block)
                digest.update(block)
                retained += len(block)
                if retained == 16384:
                    # Exact-boundary EOF is deliberately not inferred.
                    result['capture_status'] = 'byte_limit'
                    break
        except Exception:
            result['capture_status'] = 'unavailable'
        finally:
            if child is not None:
                if result['capture_status'] != 'complete' and child.poll() is None:
                    try: child.kill()
                    except Exception: result['cleanup_failures'].append('client-kill')
                try:
                    child.wait(timeout=min(1, max(.01, end - time.monotonic())) if result['capture_status'] == 'complete' else 1)
                    result['actual_parent_wait'] = True
                except subprocess.TimeoutExpired:
                    try: child.kill()
                    except Exception: result['cleanup_failures'].append('client-kill')
                    try:
                        child.wait(timeout=1)
                        result['actual_parent_wait'] = True
                    except Exception:
                        result['capture_status'] = 'unavailable'
                except Exception:
                    result['capture_status'] = 'unavailable'
                result['exit_code'] = child.returncode
                if result['capture_status'] == 'complete' and child.returncode != 0:
                    result['capture_status'] = 'client_error'
                try: child.stdout.close()
                except Exception: result['cleanup_failures'].append('stdout-close')
            if selector is not None:
                try: selector.close()
                except Exception: result['cleanup_failures'].append('selector-close')
            stream.flush()
            os.fsync(stream.fileno())
    if result['cleanup_failures']:
        result['capture_status'] = 'unavailable'
    result['log'] = {'path': str(output), 'bytes': retained, 'sha256': digest.hexdigest()}
    result['finished_monotonic_ns'] = time.monotonic_ns()
    result['arguments'] = arguments
    return result


def readiness(row, service, fixture, network):
    memory, pids, ports = SERVICES[service]
    host, config = row.get('HostConfig', {}), row.get('Config', {})
    expected = {p: [{'HostIp': '127.0.0.1', 'HostPort': str(n)}] for p, n in ports.items()}
    require(config.get('Image') == fixture['images'][service]['id'] and host.get('Memory') == host.get('MemorySwap') == memory * MIB and host.get('NanoCpus') == 2_000_000_000 and host.get('PidsLimit') == pids and host.get('Init') is True, 'Radix service resource bounds differ')
    require(host.get('RestartPolicy', {}).get('Name') == 'no' and 'no-new-privileges:true' in (host.get('SecurityOpt') or []) and not host.get('Privileged'), 'Radix service privilege/restart policy differs')
    require((host.get('PortBindings') or {}) == expected and not host.get('Binds') and not host.get('Tmpfs'), 'Radix service loopback ports or mounts differ')
    require(set(row.get('NetworkSettings', {}).get('Networks', {})) == {network}, 'Radix service joined an additional network')
    require(type(row.get('SizeRw')) is int and row['SizeRw'] >= 0, 'Actual Radix writable-layer size missing')
    mounts = row.get('Mounts')
    require(isinstance(mounts, list), 'Actual Radix mount list required')
    if service == 'postgres_db':
        require(len(mounts) == 1 and mounts[0].get('Type') == 'volume' and mounts[0].get('Destination') == PGDATA and mounts[0].get('RW') is True and re.fullmatch('[0-9a-f]{64}', mounts[0].get('Name', '')), 'Exact anonymous Gateway PG15 data volume required')
    else:
        require(not mounts, 'Unexpected Radix service volume')
    state = row.get('State', {})
    if service == 'database_migrations_image':
        if state.get('Status') == 'exited':
            require(state.get('ExitCode') == 0 and not state.get('OOMKilled'), 'Radix database migration failed')
            return True
        require(state.get('Status') in {'created', 'running'} and not state.get('OOMKilled'), 'Radix database migration failed')
        return False
    require(state.get('Status') in {'created', 'running'} and not state.get('OOMKilled'), 'Radix service failed or stopped before planned teardown')
    return state.get('Running') is True


# These are the only host APIs consumed by the admitted Rust Radix fixture.
PUBLISH_ROUTES = {'fullnode': (3333, 3333), 'gateway_api_image': (5308, 8080)}


class PublisherStopped(Exception):
    """Only a bound Source stop intent or owner cancellation; no success credit."""


class LoopbackPublisher:
    """One case-owned pump thread; fixed routes, no HTTP interpretation/replies.

    Docker custody snapshots run on the original worker cadence/budgets. The
    pump checks the bound live process births before each nonblocking IO batch;
    it cannot attest Docker identity continuously between those snapshots.
    """
    def __init__(self, custody, kernel_row, cancelled, deadline_ns):
        require(type(deadline_ns) is int and deadline_ns > time.monotonic_ns(), 'Original Radix publisher deadline required')
        self.custody, self.kernel_row, self.cancelled, self.deadline_ns = custody, kernel_row, cancelled, deadline_ns
        self.lock = threading.Lock()
        self.targets, self.listeners, self.connections = None, {}, []
        self.stop_event = threading.Event()
        self.thread, self.error, self.finished = None, None, False
        self.close_failed = False
        self.revoked = False
        self.accepted, self.refused, self.forwarded, self.maximum_active = 0, 0, 0, 0

    def _live(self, targets):
        if self.revoked or self.stop_event.is_set():raise PublisherStopped()
        require(time.monotonic_ns() < self.deadline_ns, 'Original Radix publisher deadline expired')
        if self.cancelled() or self.custody.stopping():
            raise PublisherStopped()
        parent = self.kernel_row(self.custody.pid)
        require(parent is not None and parent.get('pid') == self.custody.pid and parent.get('start') == self.custody.start and parent.get('state') != 'Z', 'Radix publisher helper birth changed')
        for lease in targets.values():
            live = self.kernel_row(lease[2])
            require(live is not None and live.get('pid') == lease[2] and live.get('start') == lease[3] and live.get('state') != 'Z', 'Radix publisher container birth changed')

    def observe(self):
        """A rejected custody refresh revokes existing transport before unwind."""
        try:
            self._observe()
        except BaseException as error:
            self.revoke(error)
            raise

    def revoke(self, error):
        # First revoke independently of Event/diagnostic reporting. This method
        # cannot replace the worker's primary exception, even on report failure.
        self.revoked = True
        try:
            if self.error is None:self.error = type(error).__name__ if type(error).__name__ in {'ValueError', 'OSError', 'TimeoutError', 'RuntimeError'} else 'OtherError'
            self.stop_event.set()
        except BaseException:
            if self.error is None:self.error = 'OtherError'

    def _observe(self):
        """Called only after successful original ordinary Docker custody."""
        targets = self.custody.publisher_targets(self.kernel_row)
        if self.custody.stopping():
            self.stop_event.set()
            return
        with self.lock:
            if self.targets is not None:
                require(targets == self.targets, 'Radix publisher CID/network/process endpoint changed')
            if targets is None:
                return
            self._live(targets)
            if self.targets is None:
                self.targets = targets
                # No reuse option: never take over an existing host listener.
                try:
                    for service, (port, _) in PUBLISH_ROUTES.items():
                        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                        self.listeners[listener] = service
                        listener.setblocking(False)
                        listener.bind(('127.0.0.1', port))
                        listener.listen(32)
                    self.thread = threading.Thread(target=self._run, name='owned-radix-loopback', daemon=False)
                    self.thread.start()
                except BaseException:
                    self._close_sockets()
                    raise
        self.check()

    def check(self):
        require(self.error is None, 'Owned Radix loopback publisher failed')

    def _close_stream(self, stream):
        try:
            stream.close()
        except OSError:
            self.close_failed = True
            if self.error is None:self.error = 'OSError'

    def _drop(self, connection):
        for stream in connection['sockets']:
            self._close_stream(stream)
        self.connections.remove(connection)

    def _close_sockets(self):
        for stream in list(self.listeners):
            self._close_stream(stream)
        self.listeners.clear()
        for connection in list(self.connections):
            self._drop(connection)

    def _step(self):
        self._live(self.targets)
        if self.custody.stopping():
            self.stop_event.set()
            return
        reads = list(self.listeners)
        writes = []
        for row in self.connections:
            left, right = row['sockets']
            if row['connecting']:
                writes.append(right)
            else:
                for index, stream in enumerate((left, right)):
                    if not row['eof'][index] and len(row['buffers'][1-index]) < 65536:
                        reads.append(stream)
                    if row['buffers'][index]:
                        writes.append(stream)
        readable, writable, _ = select.select(reads, writes, [], .01)
        self._live(self.targets)
        for listener in list(self.listeners):
            if listener not in readable:
                continue
            try:
                left, peer = listener.accept()
            except BlockingIOError:
                continue
            try:
                require(ipaddress.IPv4Address(peer[0]).is_loopback, 'Radix publisher client must be loopback')
                if len(self.connections) >= 32:
                    self.refused += 1
                    left.close()
                    continue
                service = self.listeners[listener]
                lease = self.targets[service]
                self._live(self.targets)
                left.setblocking(False)
                left.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 65536)
                left.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 65536)
                right = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                try:
                    right.setblocking(False)
                    right.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 65536)
                    right.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 65536)
                    status = right.connect_ex((lease[6], PUBLISH_ROUTES[service][1]))
                    self._live(self.targets)
                    if status not in {0, errno.EINPROGRESS, errno.EWOULDBLOCK, errno.EALREADY, errno.EINTR}:
                        self.refused += 1
                        right.close()
                        left.close()
                        continue
                    self.connections.append({'sockets': (left, right), 'connecting': status != 0, 'buffers': [b'', b''], 'eof': [False, False], 'shutdown': [False, False]})
                    self.accepted += 1
                    self.maximum_active = max(self.maximum_active, len(self.connections))
                except BaseException:
                    right.close()
                    raise
            except BaseException:
                left.close()
                raise
        for row in list(self.connections):
            left, right = row['sockets']
            try:
                if row['connecting']:
                    if right not in writable:
                        continue
                    if right.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR) != 0:
                        self.refused += 1
                        self._drop(row)
                        continue
                    self._live(self.targets)
                    row['connecting'] = False
                for index, stream in enumerate((left, right)):
                    self._live(self.targets)
                    if stream in writable and row['buffers'][index]:
                        sent = stream.send(row['buffers'][index])
                        require(sent > 0, 'Radix publisher zero send')
                        row['buffers'][index] = row['buffers'][index][sent:]
                        self.forwarded += sent
                    if stream in readable and not row['eof'][index]:
                        data = stream.recv(65536-len(row['buffers'][1-index]))
                        if data:
                            row['buffers'][1-index] += data
                        else:
                            row['eof'][index] = True
                    if row['eof'][1-index] and not row['buffers'][index] and not row['shutdown'][index]:
                        stream.shutdown(socket.SHUT_WR)
                        row['shutdown'][index] = True
                if all(row['eof']) and not any(row['buffers']):
                    self._drop(row)
            except BlockingIOError:
                continue
            except (ConnectionError, BrokenPipeError):
                self._drop(row)

    def _run(self):
        try:
            while not self.revoked and not self.stop_event.is_set():
                # Source stopping and an actual finished helper are normal transport
                # shutdown; the existing owner alone decides native acceptance.
                if self.cancelled():
                    self.stop_event.set()
                    break
                self._step()
        except PublisherStopped:
            self.stop_event.set()
        except BaseException as error:
            self.error = type(error).__name__ if type(error).__name__ in {'ValueError', 'OSError', 'TimeoutError', 'RuntimeError'} else 'OtherError'
            self.stop_event.set()
        finally:
            self._close_sockets()
            self.finished = True

    def close(self, cleanup_deadline):
        self.stop_event.set()
        if self.thread is not None:
            self.thread.join(timeout=max(0, cleanup_deadline-time.monotonic()))
            require(not self.thread.is_alive(), 'Owned Radix publisher thread remains')
        else:
            self._close_sockets()
            self.finished = True
        require(self.finished and not self.listeners and not self.connections, 'Owned Radix publisher sockets remain')
        return {'error_class': self.error, 'schema': 1, 'kind': 'owned-Radix-loopback-publisher', 'routes': ['fullnode', 'gateway_api_image'], 'accepted_connections': self.accepted, 'refused_connections': self.refused, 'forwarded_bytes': self.forwarded, 'maximum_active_connections': self.maximum_active, 'connection_limit': 32, 'buffer_bytes_per_direction': 65536, 'actual_thread_joined': self.thread is not None, 'all_owned_sockets_closed': not self.close_failed, 'new_processes': 0, 'native_or_parent_wait_credit': False, 'scope': 'Fixed loopback byte relay to owned internal endpoints; Docker identity checked at ordinary custody cadence, process births checked before nonblocking IO.'}


class Custody:
    def __init__(self, case, pid, start, fixture, output, call, volume_sample=None):
        require(isinstance(start, str) and start.startswith('linux-ticks:'), 'Actual Linux helper birth token required')
        require(set(fixture) == {'architecture', 'token', 'images'} and fixture['architecture'] == 'amd64' and re.fullmatch('[0-9a-f]{32}', fixture['token']) and set(fixture['images']) == set(SERVICES), 'Closed Radix fixture required')
        for image in fixture['images'].values():
            require(set(image) == {'source', 'id'} and re.fullmatch('sha256:[0-9a-f]{64}', image['id']), 'Pinned Radix image required')
        spec = importlib.util.spec_from_file_location('radix_custody_assets', Path(__file__).with_name('native_radix_assets.py'))
        assets = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(assets)
        require(fixture['images'] == {name: {'source': row['source_image'], 'id': row['image_id']} for name, row in assets.IMAGES.items()}, 'Exact approved five Radix images required')
        self.case, self.pid, self.start, self.fixture, self.output, self.call = case, pid, start, fixture, output, call
        self.project = project_name(case, pid)
        self.network = self.project + '_default'
        self.seen, self.ready = {}, {}
        self.maximum_writable_bytes = 0
        self.maximum_volume_bytes = 0
        self.volume_sample = volume_sample
        self.last_volume_observation = None
        self.service_states = {}
        self.last_inspected_service = None
        self.service_observation_unavailable = False
        self.missing_inspection_observation = None
        self.publisher_rows, self.publisher_network = {}, None

    def public_observation(self):
        return {'schema': 1, 'collection_status': 'unavailable' if self.service_observation_unavailable else 'available', 'scope': 'Owned service State before readiness checks; no log bodies or native acceptance credit.',
                'last_inspected_service': self.last_inspected_service,
                'missing_inspection': json.loads(json.dumps(self.missing_inspection_observation)),
                'readiness_passed_services': sorted(self.ready),
                'services': [json.loads(json.dumps(self.service_states[name])) for name in SERVICES if name in self.service_states]}

    def failed_fullnode_log_target(self):
        # This exact CID/image/project/token was authenticated by inspect_container
        # immediately before the failed readiness check. No request-chosen target.
        if self.service_observation_unavailable or self.last_inspected_service != 'fullnode':
            return None
        row = self.service_states.get('fullnode')
        if row is None or row['container_id'] != self.seen.get('fullnode') or row['image_id'] != self.fixture['images']['fullnode']['id']:
            return None
        state = row['state']
        if state.get('Status') not in {'exited', 'dead', 'restarting'} and state.get('OOMKilled') is not True:
            return None
        return {'service': 'fullnode', 'container_id': row['container_id'], 'image_id': row['image_id'], 'project': self.project}

    def context(self):
        return {'case_root': str(self.case), 'helper_pid': self.pid, 'helper_start': self.start, 'project': self.project, 'fixture': self.fixture}

    def ids(self, kind, cleaning=False):
        args = [kind, 'ls', '--quiet', '--filter', 'label=' + PROJECT_LABEL + '=' + self.project]
        if kind == 'container':
            args = ['container', 'ls', '--all', '--no-trunc', '--quiet', '--filter', 'label=' + PROJECT_LABEL + '=' + self.project]
        value = self.call(args, cleaning=cleaning)
        rows = value.splitlines()
        require(len(rows) <= 8 and len(set(rows)) == len(rows), 'Bounded unique Radix object set required')
        return rows

    def arm(self):
        for kind in ['container', 'network', 'volume']:
            require(not self.ids(kind), 'Preserve pre-existing Radix project')
        # Source Compose declares no volume mapping. Retain the actual baseline
        # to refuse cleanup if a PG image volume somehow reuses an old name.
        volumes = self.call(['volume', 'ls', '--quiet']).splitlines()
        require(len(volumes) <= 128 and all(re.fullmatch('[A-Za-z0-9_.-]{1,255}', v) for v in volumes), 'Bounded volume baseline required')
        hashes = sorted(hashlib.sha256(v.encode()).hexdigest() for v in volumes)
        shared().publish_first(self.output / 'radix-armed.json', {**self.context(), 'preexisting_volume_name_hashes': hashes})

    def admitted_context(self):
        value = shared().read_record(self.output / 'radix-armed.json')
        require({k: value[k] for k in self.context()} == self.context(), 'Missing Radix pre-GO custody context')
        for service in SERVICES:
            path = self.output / ('radix-' + service + '-cid.json')
            if path.exists() or path.is_symlink():
                row = shared().read_record(path)
                require(set(row) == {'container_id'} and re.fullmatch('[0-9a-f]{64}', row['container_id']) and self.seen.get(service, row['container_id']) == row['container_id'], 'Radix first CID changed')
                self.seen[service] = row['container_id']
        return value

    def stopping(self):
        path = self.case / 'radix-localnet/stopping.json'
        if not path.exists():
            return False
        value = shared().read_record(path)
        require(value == {'project': self.project, 'parent_pid': self.pid, 'containers': self.seen}, 'Unbound Radix Source stop intent')
        return True

    def missing_inspection(self, cid):
        # The list target is an observation, never new cleanup authority. Only
        # previously authenticated fixed service CIDs are named as captured.
        report={'stage':'listed_CID_missing_on_inspect','observed_monotonic_ns':time.monotonic_ns(),'listed_container_id':cid,
                'previously_captured_services':[name for name in SERVICES if self.seen.get(name)==cid],
                'captured_CIDs':{name:self.seen[name] for name in SERVICES if name in self.seen},
                'readiness_passed_services':[name for name in SERVICES if name in self.ready],
                'Source_stop_intent':{'status':'unavailable','binding_matches':False},'native_or_cleanup_authority':False}
        try:
            matched=self.stopping()
            report['Source_stop_intent']={'status':'present_and_exactly_bound' if matched else 'absent','binding_matches':matched}
        except Exception as error:
            report['Source_stop_intent']={'status':'invalid_or_unavailable','binding_matches':False,'error_class':type(error).__name__ if type(error).__name__ in {'ValueError','OSError','JSONDecodeError','FileNotFoundError','PermissionError'} else 'OtherError'}
        report['completed_monotonic_ns']=time.monotonic_ns()
        return report

    def inspect_container(self, cid, cleaning=False):
        require(re.fullmatch('[0-9a-f]{64}', cid), 'Complete Radix CID required')
        wire = self.call(['container', 'inspect', '--size', cid], missing=True, cleaning=cleaning)
        if wire is None:
            return None
        rows = json.loads(wire)
        require(isinstance(rows, list) and len(rows) == 1, 'One Radix container inspection required')
        row = rows[0]
        service, actual = ownership(row, self.project, self.fixture, self.seen.get((row.get('Config', {}).get('Labels') or {}).get(SERVICE_LABEL)))
        require(actual == cid, 'Radix inspect target changed')
        shared().publish_first(self.output / ('radix-' + service + '-cid.json'), {'container_id': cid})
        self.seen[service] = cid
        return row

    def inspect_network(self, cleaning=False):
        wire = self.call(['network', 'inspect', self.network], missing=True, cleaning=cleaning)
        if wire is None:
            return None
        rows = json.loads(wire)
        require(isinstance(rows, list) and len(rows) == 1, 'One Radix network required')
        row = rows[0]
        require(row.get('Name') == self.network and row.get('Labels', {}).get(PROJECT_LABEL) == self.project and row.get('Internal') is True and re.fullmatch('[0-9a-f]{64}', row.get('Id', '')), 'Foreign or external Radix network')
        shared().publish_first(self.output / 'radix-network.json', {'network_id': row['Id'], 'name': self.network})
        require(set(row.get('Containers') or {}) <= set(self.seen.values()), 'Radix network contains an unowned container')
        return row

    def inspect_volume(self, mount, cleaning=False):
        name = mount['Name']
        armed = self.admitted_context()
        require(hashlib.sha256(name.encode()).hexdigest() not in armed['preexisting_volume_name_hashes'], 'Preserve pre-existing Gateway database volume')
        wire = self.call(['volume', 'inspect', name], missing=True, cleaning=cleaning)
        require(wire is not None, 'Captured Gateway volume disappeared')
        rows = json.loads(wire)
        require(isinstance(rows, list) and len(rows) == 1 and rows[0].get('Name') == name and rows[0].get('Driver') == 'local' and not rows[0].get('Options'), 'Unreviewed Gateway volume driver/options')
        labels = rows[0].get('Labels') or {}
        # Engine adds this exact marker to newly-created anonymous volumes.
        # Pre-GO baseline, captured CID/mount/name and driver/options remain mandatory.
        require(not labels or labels == {'com.docker.volume.anonymous': ''} or labels.get(PROJECT_LABEL) == self.project, 'Gateway volume has foreign labels')
        shared().publish_first(self.output / 'radix-volume.json', {'name': name, 'container_id': self.seen['postgres_db'], 'destination': PGDATA})

    def publisher_targets(self, kernel_row):
        if self.stopping() or set(self.ready) != set(SERVICES) or set(self.publisher_rows) != set(PUBLISH_ROUTES):
            return None
        self.admitted_context()
        network = self.publisher_network
        require(isinstance(network, dict) and network.get('Internal') is True and network.get('Driver') == 'bridge' and network.get('Name') == self.network and network.get('Labels', {}).get(PROJECT_LABEL) == self.project and re.fullmatch('[0-9a-f]{64}', network.get('Id', '')), 'Exact internal Radix publisher network required')
        require(set(network.get('Containers') or {}) <= set(self.seen.values()) and {self.seen[name] for name in PUBLISH_ROUTES} <= set(network.get('Containers') or {}), 'Radix publisher network membership changed')
        result = {}
        for service in PUBLISH_ROUTES:
            row = self.publisher_rows[service]
            _, cid = ownership(row, self.project, self.fixture, self.seen.get(service))
            require(self.ready.get(service) == cid and readiness(row, service, self.fixture, self.network), 'Radix publisher Source readiness/caps required')
            state = row['State']
            require(type(state.get('Pid')) is int and state['Pid'] > 0 and state.get('Running') is True and state.get('OOMKilled') is False, 'Live Radix publisher endpoint required')
            live = kernel_row(state['Pid'])
            require(live is not None and live.get('pid') == state['Pid'] and live.get('state') != 'Z' and isinstance(live.get('start'), str) and re.fullmatch('linux-ticks:[1-9][0-9]{0,23}', live['start']), 'Actual Radix publisher process birth required')
            endpoints = row['NetworkSettings']['Networks']
            require(set(endpoints) == {self.network}, 'Sole Radix publisher network required')
            endpoint = endpoints[self.network]
            peer = network['Containers'].get(cid)
            address = ipaddress.IPv4Address(endpoint['IPAddress'])
            require(peer is not None and endpoint.get('NetworkID') == network['Id'] and re.fullmatch('[0-9a-f]{64}', endpoint.get('EndpointID', '')) and peer.get('EndpointID') == endpoint['EndpointID'] and ipaddress.IPv4Interface(peer['IPv4Address']).ip == address and address.is_private and not (address.is_loopback or address.is_unspecified or address.is_multicast or address.is_link_local), 'Exact owned private Radix publisher endpoint required')
            result[service] = (cid, row['Image'], state['Pid'], live['start'], network['Id'], endpoint['EndpointID'], str(address))
        return result

    def observe(self):
        self.admitted_context()
        self.publisher_rows, self.publisher_network = {}, None
        found, total = {}, 0
        for cid in self.ids('container'):
            row = self.inspect_container(cid)
            if row is None:
                try:self.missing_inspection_observation=self.missing_inspection(cid)
                except Exception:self.missing_inspection_observation={'stage':'listed_CID_missing_on_inspect','collection_status':'unavailable','native_or_cleanup_authority':False}
                bound_stopping = False
                if cid in self.seen.values():
                    try:bound_stopping = self.stopping() is True
                    except Exception:bound_stopping = False
                require(bound_stopping, 'Radix object vanished during inspection')
                continue
            service = row['Config']['Labels'][SERVICE_LABEL]
            require(service not in found, 'Duplicate Radix Compose service')
            found[service] = cid
            if service in PUBLISH_ROUTES:self.publisher_rows[service] = row
            if not self.service_observation_unavailable:
                try:
                    self.service_states[service] = public_service_state(row, service, time.monotonic_ns())
                    self.last_inspected_service = service
                except Exception:
                    self.service_observation_unavailable = True
            if not self.stopping():
                if readiness(row, service, self.fixture, self.network):
                    self.ready[service] = cid
                if service == 'postgres_db':
                    self.inspect_volume(row['Mounts'][0])
                    require(callable(self.volume_sample), 'Actual bounded volume byte observer required')
                    observation = self.volume_sample(row['Mounts'][0]['Name'])
                    require(observation['name'] == row['Mounts'][0]['Name'] and type(observation['size_bytes']) is int and observation['size_bytes'] >= 0, 'Actual captured Gateway volume byte observation required')
                    self.last_volume_observation = observation
                    self.maximum_volume_bytes = max(self.maximum_volume_bytes, observation['size_bytes'])
            total += row.get('SizeRw', 0)
        if set(self.seen.values()) - set(found.values()):
            require(self.stopping(), 'Radix container disappeared before Source stop intent')
        self.publisher_network = self.inspect_network()
        self.maximum_writable_bytes = max(self.maximum_writable_bytes, total)
        path = self.output / 'radix-writable.json'
        pending = self.output / '.radix-writable.pending'
        require(not pending.exists() and not pending.is_symlink() and not path.is_symlink(), 'Radix resource record replaced')
        with pending.open('x') as stream:
            json.dump({**self.context(), 'maximum_writable_bytes': self.maximum_writable_bytes, 'maximum_volume_bytes': self.maximum_volume_bytes, 'latest_volume_observation': self.last_volume_observation}, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(pending, path)
        return total

    def cleanup(self):
        self.admitted_context()
        report = {'passed': False, 'container_absent': False, 'containers': [], 'native_parent_wait_credit': False, 'recovery_needed': False, 'errors': []}
        def failed(phase, error):
            report['errors'].append({'phase': phase, 'type': type(error).__name__})
        # One foreign/replaced object must not prevent cleanup of other exact
        # positive identities. Never authorize broad Compose/project deletion.
        try:
            discovered = self.ids('container', cleaning=True)
        except Exception as error:
            failed('discover', error)
            discovered = []
        for cid in discovered:
            try:
                self.inspect_container(cid, cleaning=True)
            except Exception as error:
                failed('authenticate-container', error)
        for service, cid in list(self.seen.items()):
            item = {'service': service, 'container_id': cid, 'absent': False}
            try:
                row = self.inspect_container(cid, cleaning=True)
                if row is not None:
                    report['recovery_needed'] = True
                    if service == 'postgres_db' and row.get('Mounts'):
                        mounts = row['Mounts']
                        require(len(mounts) == 1 and mounts[0].get('Type') == 'volume' and mounts[0].get('Destination') == PGDATA and re.fullmatch('[0-9a-f]{64}', mounts[0].get('Name', '')), 'Unknown Gateway mount; preserve')
                        self.inspect_volume(mounts[0], cleaning=True)
                    if row.get('State', {}).get('Running'):
                        self.call(['container', 'stop', '--time', '10', cid], cleaning=True)
                    if self.inspect_container(cid, cleaning=True) is not None:
                        self.call(['container', 'rm', cid], cleaning=True)
                    require(self.inspect_container(cid, cleaning=True) is None, 'Owned Radix container remains')
                item['absent'] = True
            except Exception as error:
                failed('cleanup-' + service, error)
            report['containers'].append(item)
        try:
            network = self.inspect_network(cleaning=True)
            if network is not None:
                require(not network.get('Containers'), 'Preserve network with attached objects')
                report['recovery_needed'] = True
                self.call(['network', 'rm', network['Id']], cleaning=True)
                require(self.inspect_network(cleaning=True) is None, 'Owned Radix network remains')
            report['network_absent'] = True
        except Exception as error:
            failed('cleanup-network', error)
        try:
            path = self.output / 'radix-volume.json'
            if path.exists() or path.is_symlink():
                value = shared().read_record(path)
                require(set(value) == {'name', 'container_id', 'destination'} and value['container_id'] == self.seen.get('postgres_db') and value['destination'] == PGDATA and re.fullmatch('[0-9a-f]{64}', value['name']), 'Unbound captured Gateway volume')
                require(self.inspect_container(value['container_id'], cleaning=True) is None, 'Preserve volume of a remaining Gateway container')
                wire = self.call(['volume', 'inspect', value['name']], missing=True, cleaning=True)
                if wire is not None:
                    self.inspect_volume({'Name': value['name']}, cleaning=True)
                    report['recovery_needed'] = True
                    self.call(['volume', 'rm', value['name']], cleaning=True)
                    require(self.call(['volume', 'inspect', value['name']], missing=True, cleaning=True) is None, 'Owned Gateway volume remains')
            report['captured_volume_absent'] = True
        except Exception as error:
            failed('cleanup-volume', error)
        try:
            require(all(not self.ids(k, cleaning=True) for k in ['container', 'network', 'volume']), 'Radix project still contains objects')
            report['container_absent'] = all(r['absent'] for r in report['containers'])
        except Exception as error:
            failed('final-project-absence', error)
        report['passed'] = not report['errors'] and report['container_absent'] and report.get('network_absent') is True and report.get('captured_volume_absent') is True
        return report
