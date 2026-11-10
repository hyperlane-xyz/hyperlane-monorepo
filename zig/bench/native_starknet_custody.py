"""Exactly two approved Starknet devnets. Caller owns every Docker child/wait.

Creation/readiness acceptance and immutable-CID cleanup authority are separate.
No process signals, name-only removal, Docker discovery, or CLI execution here.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile

GIB = 1024 ** 3
PORTS = (5050, 5070)
LABEL_ROOT = 'io.hyperlane.ziggy.case-root'
LABEL_PID = 'io.hyperlane.ziggy.harness-pid'
LABEL_TOKEN = 'io.hyperlane.ziggy.run-token'
COMMAND = ['--state-archive-capacity', 'full', '--block-generation-on', '5', '--seed', '0']


def require(value, message):
    if not value: raise ValueError(message)


def resource_charge(host_ram, case_bytes, initial_free, current_free, writable_bytes=0):
    require(all(type(value) is int and value >= 0 for value in (host_ram, case_bytes, initial_free, current_free, writable_bytes)), 'Actual nonnegative resource observations required')
    # Two exact2GiB devnet caps plus exact1GiB PG; never infer guest RSS from
    # host Docker-client processes. The approved daemon shares this filesystem.
    return host_ram + 5 * GIB, max(case_bytes + writable_bytes, max(0, initial_free - current_free)) + 2 * GIB


def read_record(path):
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 16384, 'Bounded regular custody record required')
    return json.loads(path.read_text())


def publish_first(path, row):
    """Fsynced no-overwrite record; repeated polls cannot erase the first CID."""
    wire = (json.dumps(row, sort_keys=True, separators=(',', ':')) + '\n').encode()
    if path.exists() or path.is_symlink():
        require(read_record(path) == row and path.read_bytes() == wire, 'First custody identity changed'); return
    pending = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.starknet-', delete=False) as stream:
            pending = Path(stream.name); identity = os.fstat(stream.fileno()); stream.write(wire); stream.flush(); os.fsync(stream.fileno())
        try: os.link(pending, path)
        except FileExistsError: require(read_record(path) == row and path.read_bytes() == wire, 'Concurrent custody identity changed')
        descriptor = os.open(path.parent, os.O_RDONLY)
        try: os.fsync(descriptor)
        finally: os.close(descriptor)
    finally:
        if pending is not None:
            current = pending.lstat(); require((current.st_dev, current.st_ino) == (identity.st_dev, identity.st_ino), 'Pending custody record replaced'); pending.unlink()


def expected_name(case, pid, port):
    require(port in PORTS and type(pid) is int and pid > 0, 'Fixed devnet port/helper PID required')
    return 'ziggy-e2e-' + hashlib.sha256(os.fsencode(case)).hexdigest()[:10] + '-' + str(pid) + '-starknet-' + str(port)


def ownership(row, case, pid, fixture, port, previous=None):
    labels = row.get('Config', {}).get('Labels', {}) or {}
    cid = row.get('Id')
    require(isinstance(cid, str) and re.fullmatch('[0-9a-f]{64}', cid) and row.get('Name') == '/' + expected_name(case, pid, port) and row.get('Image') == fixture['image_id'] and labels.get(LABEL_ROOT) == hashlib.sha256(os.fsencode(case)).hexdigest() and labels.get(LABEL_PID) == str(pid) and labels.get(LABEL_TOKEN) == fixture['run_token'] and (previous is None or previous == cid), 'Foreign/replaced devnet; no cleanup authority')
    return cid


def readiness(row, fixture, port):
    cfg = row.get('HostConfig', {}); bindings = {'5050/tcp': [{'HostIp': '127.0.0.1', 'HostPort': str(port)}]}
    require(row.get('State', {}).get('Running') is True and row.get('Config', {}).get('Image') == fixture['image_id'] and row['Config'].get('Cmd') == COMMAND, 'Devnet not running/exact Source command')
    require(cfg.get('Memory') == cfg.get('MemorySwap') == 2 * GIB and cfg.get('NanoCpus') == 2_000_000_000 and cfg.get('PidsLimit') == 256 and cfg.get('PortBindings') == bindings and row.get('NetworkSettings', {}).get('Ports') == bindings, 'Actual devnet memory/CPU/PIDs/loopback differs')
    require(not row.get('Mounts') and not cfg.get('Binds') and not cfg.get('Tmpfs'), 'Unaccounted devnet volume/bind/tmpfs rejected')
    require(type(row.get('SizeRw')) is int and row['SizeRw'] >= 0, 'Actual devnet writable-layer observation missing')
    return row['SizeRw']


def readiness_failure(row, fixture, port, error):
    """Closed observation of the original guard, after inspect authenticated CID."""
    trace = []; current = error.__traceback__
    while current is not None:
        trace.append((current.tb_frame.f_code, current.tb_lineno)); current = current.tb_next
    if type(error) is not ValueError or [code for code, _ in trace] != [_READINESS_INSPECT_CODE, _READINESS_CODE, _READINESS_REQUIRE_CODE] or trace[1][1] != _READINESS_CODE.co_firstlineno + 2 or trace[2][1] != _READINESS_REQUIRE_CODE.co_firstlineno + 1: return None
    if type(port) is not int or port not in PORTS or type(row) is not dict or type(row.get('State', {})) is not dict or type(row.get('Config', {})) is not dict: return None
    state = row.get('State', {}); config = row.get('Config', {})
    result = {'node_index': PORTS.index(port), 'running_matches': state.get('Running') is True, 'image_matches': config.get('Image') == fixture['image_id'], 'command_matches': config.get('Cmd') == COMMAND}
    if all(result[key] for key in ('running_matches', 'image_matches', 'command_matches')): return None
    for key, value, bound in [('exit_code', state.get('ExitCode'), 255), ('restart_count', row.get('RestartCount'), 2 ** 32 - 1)]:
        result[key] = value if type(value) is int and 0 <= value <= bound else None
    result['oom_killed'] = state.get('OOMKilled') if type(state.get('OOMKilled')) is bool else None
    status = state.get('Status'); result['state_status'] = status if type(status) is str and status in ('created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead') else None
    return result


def readiness_observation(records):
    """Revalidate the optional public namespace; never serialize inspect payloads."""
    require(type(records) is dict and 1 <= len(records) <= 2, 'Closed readiness records required')
    nodes = []
    for index, record in sorted(records.items()):
        require(type(index) is int and index in (0, 1) and type(record) is dict and set(record) == {'count', 'first', 'latest'} and type(record['count']) is int and 1 <= record['count'] <= 2 ** 32 - 1, 'Bounded readiness count required')
        for row in (record['first'], record['latest']):
            require(type(row) is dict and set(row) == {'node_index', 'running_matches', 'image_matches', 'command_matches', 'exit_code', 'oom_killed', 'restart_count', 'state_status'} and type(row['node_index']) is int and row['node_index'] == index, 'Closed readiness node required')
            require(all(type(row[key]) is bool for key in ('running_matches', 'image_matches', 'command_matches')) and not all(row[key] for key in ('running_matches', 'image_matches', 'command_matches')), 'Exact failing guard booleans required')
            for key, bound in [('exit_code', 255), ('restart_count', 2 ** 32 - 1)]: require(row[key] is None or type(row[key]) is int and 0 <= row[key] <= bound, 'Bounded lifecycle integer required')
            require(row['oom_killed'] is None or type(row['oom_killed']) is bool, 'Nullable OOM flag required')
            require(row['state_status'] is None or type(row['state_status']) is str and row['state_status'] in ('created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead'), 'Closed state status required')
        nodes.append({'node_index': index, **record})
    wire = json.dumps({'schema': 1, 'nodes': nodes}, separators=(',', ':'), sort_keys=True)
    require(len(wire.encode()) <= 2048, 'Bounded readiness projection required')
    return json.loads(wire)


class Custody:
    def __init__(self, case, pid, start, fixture, output, call):
        self.case, self.pid, self.start, self.fixture, self.output, self.call = case, pid, start, fixture, output, call
        require(isinstance(start, str) and start.startswith('linux-ticks:'), 'Actual helper birth token required')
        require(set(fixture) == {'schema', 'architecture', 'source_image', 'image_id', 'canonical_digest', 'run_token'} and fixture['schema'] == 2 and fixture['source_image'] == 'shardlabs/starknet-devnet-rs:0.4.2' and fixture['architecture'] in ('amd64', 'arm64') and re.fullmatch('sha256:[0-9a-f]{64}', fixture['image_id']) and re.fullmatch('[0-9a-f]{32}', fixture['run_token']), 'Closed approved devnet fixture required')
        self.seen = {}; self.ready = {}; self.maximum_writable_bytes = 0

    def context(self):
        return {'case_root': str(self.case), 'helper_pid': self.pid, 'helper_start': self.start, 'image_id': self.fixture['image_id'], 'run_token': self.fixture['run_token'], 'names': {str(port): expected_name(self.case, self.pid, port) for port in PORTS}}

    def arm(self):
        # Both names absent and durable proof BEFORE caller releases GO.
        for port in PORTS:
            require(self.call(['container', 'inspect', expected_name(self.case, self.pid, port)], missing=True) is None, 'Preserve pre-existing devnet')
        publish_first(self.output / 'starknet-armed.json', self.context())

    def admitted_context(self):
        require(read_record(self.output / 'starknet-armed.json') == self.context(), 'Missing/mismatched pre-GO devnet custody context')

    def planned_shutdown(self, port, cid):
        path = self.case / 'evidence/fixture-container-stop-intents.jsonl'
        if not path.exists(): return False
        require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 1024 * 1024, 'Bounded Source stop-intent evidence required')
        rows = [json.loads(line) for line in path.read_text().splitlines()]
        selected = [row for row in rows if row.get('kind') == 'starknet' and row.get('port') == port]
        if not selected: return False
        require(len(selected) == 1, 'Repeated Source stop intent')
        row = selected[0]
        require(port in self.ready and self.ready[port] == cid and row.get('container_id') == cid and row.get('parent_pid') == self.pid and type(row.get('pid')) is int and row['pid'] > 0 and isinstance(row.get('pre_stop_live_identity'), str) and row['pre_stop_live_identity'] and row.get('acceptance_failed_before_cleanup') is False, 'Unbound/unhealthy Source stop intent')
        return True

    def inspect(self, port, cleaning=False):
        self.admitted_context()
        path = self.output / ('starknet-' + str(port) + '-cid.json')
        previous = None
        if path.exists() or path.is_symlink():
            value = read_record(path)
            require(set(value) == {'container_id'} and isinstance(value['container_id'], str) and re.fullmatch('[0-9a-f]{64}', value['container_id']), 'Malformed devnet first CID')
            previous = value['container_id']
        target = previous or expected_name(self.case, self.pid, port)
        wire = self.call(['container', 'inspect', '--size', target], missing=True, cleaning=cleaning)
        if wire is None:
            if previous is not None and not cleaning: require(self.planned_shutdown(port, previous), 'Devnet disappeared before Source-owned planned teardown')
            return None
        rows = json.loads(wire); require(isinstance(rows, list) and len(rows) == 1, 'One actual devnet inspect required')
        cid = ownership(rows[0], self.case, self.pid, self.fixture, port, previous)
        publish_first(path, {'container_id': cid}); self.seen[port] = cid
        if not cleaning:
            # Retain authenticated identity BEFORE rejecting unhealthy/bad caps.
            if not self.planned_shutdown(port, cid):
                try: readiness(rows[0], self.fixture, port)
                except ValueError as error:
                    try:
                        observation = readiness_failure(rows[0], self.fixture, port, error)
                        if observation is not None:
                            records = getattr(self, '_readiness_failures', {})
                            index = observation['node_index']; previous = records.get(index)
                            records[index] = {'count': min(previous['count'] + 1, 2 ** 32 - 1) if previous is not None else 1, 'first': previous['first'] if previous is not None else observation, 'latest': observation}
                            readiness_observation(records); self._readiness_failures = records
                    except BaseException: pass  # Optional observation cannot replace the original guard.
                    raise
                self.ready[port] = cid
        return rows[0]

    def observe(self):
        total = 0
        for port in PORTS:
            row = self.inspect(port)
            if row is not None:
                require(type(row.get('SizeRw')) is int and row['SizeRw'] >= 0, 'Actual writable-layer size missing')
                total += row['SizeRw']
        self.maximum_writable_bytes = max(total, self.maximum_writable_bytes)
        # Readable by the independent outer resource owner. A crash cannot
        # publish half a resource record, and it never changes a first CID.
        row={**self.context(),'maximum_writable_bytes':self.maximum_writable_bytes}
        path=self.output/'starknet-writable.json';temporary=self.output/'.starknet-writable.pending'
        require(not temporary.exists() and not temporary.is_symlink() and not path.is_symlink(),'Owned resource record replaced')
        with temporary.open('x') as stream:json.dump(row,stream);stream.flush();os.fsync(stream.fileno())
        os.replace(temporary,path)
        return total

    def cleanup(self):
        report = {'passed': False, 'container_absent': False, 'containers': [], 'native_parent_wait_credit': False}
        # Always attempt the other positive identity, even if the first fails.
        for port in PORTS:
            item = {'port': port, 'container_id': None, 'absent': False}
            try:
                row = self.inspect(port, cleaning=True)
                if row is not None:
                    cid = row['Id']; item['container_id'] = cid
                    if row.get('State', {}).get('Running'): self.call(['container', 'stop', '--time', '10', cid], cleaning=True)
                    current = self.inspect(port, cleaning=True)
                    if current is not None: self.call(['container', 'rm', cid], cleaning=True)
                    require(self.inspect(port, cleaning=True) is None, 'Owned devnet remains after cleanup')
                item['absent'] = True
            except BaseException as error: item['error'] = {'type': type(error).__name__, 'message': str(error)}
            report['containers'].append(item)
        report['container_absent'] = all(row['absent'] for row in report['containers'])
        report['passed'] = report['container_absent']
        try:
            records = getattr(self, '_readiness_failures', None)
            if records is not None: report['readiness_failure_observation'] = readiness_observation(records)
        except BaseException: pass  # Preserve original cleanup result if optional projection fails.
        return report


_READINESS_CODE = readiness.__code__
_READINESS_REQUIRE_CODE = require.__code__
_READINESS_INSPECT_CODE = Custody.inspect.__code__
