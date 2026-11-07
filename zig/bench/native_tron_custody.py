"""One approved Tron TRE2.0.0. Caller owns every Docker child/wait.

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
PORTS = (9090,)
LABEL_ROOT = 'io.hyperlane.ziggy.case-root'
LABEL_PID = 'io.hyperlane.ziggy.harness-pid'
LABEL_TOKEN = 'io.hyperlane.ziggy.run-token'
COMMAND = ['./quickstart', 'v2.0.0']


def require(value, message):
    if not value: raise ValueError(message)


def resource_charge(host_ram, case_bytes, initial_free, current_free, writable_bytes=0):
    require(all(type(value) is int and value >= 0 for value in (host_ram, case_bytes, initial_free, current_free, writable_bytes)), 'Actual nonnegative resource observations required')
    # One exact3GiB TRE cap plus exact1GiB PG; never infer guest RSS from
    # host Docker-client processes. The approved daemon shares this filesystem.
    return host_ram + 4 * GIB, max(case_bytes + writable_bytes, max(0, initial_free - current_free)) + 2 * GIB


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
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.tron-', delete=False) as stream:
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
    return 'ziggy-e2e-' + hashlib.sha256(os.fsencode(case)).hexdigest()[:10] + '-' + str(pid) + '-tron-e2e'


def ownership(row, case, pid, fixture, port, previous=None):
    labels = row.get('Config', {}).get('Labels', {}) or {}
    cid = row.get('Id')
    require(isinstance(cid, str) and re.fullmatch('[0-9a-f]{64}', cid) and row.get('Name') == '/' + expected_name(case, pid, port) and row.get('Image') == fixture['image_id'] and labels.get(LABEL_ROOT) == hashlib.sha256(os.fsencode(case)).hexdigest() and labels.get(LABEL_PID) == str(pid) and labels.get(LABEL_TOKEN) == fixture['run_token'] and (previous is None or previous == cid), 'Foreign/replaced devnet; no cleanup authority')
    return cid


def readiness(row, fixture, port):
    cfg = row.get('HostConfig', {}); bindings = {'9090/tcp': [{'HostIp': '127.0.0.1', 'HostPort': str(port)}]}
    require(row.get('State', {}).get('Running') is True and row.get('Config', {}).get('Image') == fixture['image_id'] and row['Config'].get('Cmd') == fixture['command'] and row['Config'].get('Entrypoint') == fixture['entrypoint'], 'Devnet not running/exact Source command')
    require(cfg.get('Memory') == cfg.get('MemorySwap') == 3 * GIB and cfg.get('NanoCpus') == 2_000_000_000 and cfg.get('PidsLimit') == 256 and cfg.get('PortBindings') == bindings and row.get('NetworkSettings', {}).get('Ports') == bindings, 'Actual devnet memory/CPU/PIDs/loopback differs')
    expected=['block=allowTvmCompatibleEvm:1','preapprove=allowTvmCompatibleEvm:1','mnemonic=abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',"hdPath=m/44'/195'/0'/0/",'defaultBalance=1000000']
    environment=row['Config'].get('Env',[]);require(isinstance(environment,list)and all(environment.count(value)==1 and sum(isinstance(entry,str)and entry.split('=',1)[0]==value.split('=',1)[0]for entry in environment)==1 for value in expected),'TRE Source startup environment differs')
    require(not row.get('Mounts') and not cfg.get('Binds') and not cfg.get('Tmpfs'), 'Unaccounted devnet volume/bind/tmpfs rejected')
    require(type(row.get('SizeRw')) is int and row['SizeRw'] >= 0, 'Actual devnet writable-layer observation missing')
    return row['SizeRw']


class Custody:
    def __init__(self, case, pid, start, fixture, output, call):
        self.case, self.pid, self.start, self.fixture, self.output, self.call = case, pid, start, fixture, output, call
        require(isinstance(start, str) and start.startswith('linux-ticks:'), 'Actual helper birth token required')
        require(set(fixture)=={'architecture','source_image','image_id','canonical_digest','run_token','command','entrypoint','cli_directory','cli_entrypoint','pnpm'} and fixture['source_image']==fixture['canonical_digest']=='tronbox/tre@sha256:f4332e11df12a9f360639a4546fd0465' '93909630fda48af00b30410c144342f0' and fixture['architecture']in('amd64','arm64')and re.fullmatch('sha256:[0-9a-f]{64}',fixture['image_id'])and re.fullmatch('[0-9a-f]{32}',fixture['run_token'])and fixture['command']==COMMAND and fixture['entrypoint']is None,'Closed Source TronTreFixture fields required')
        require(fixture['cli_directory']==str(case/'tron-cli')and fixture['cli_entrypoint']['path']==str(case/'tron-cli/dist/cli.js'),'Exact owned Source CLI entrypoint required')
        self.seen = {}; self.ready = {}; self.maximum_writable_bytes = 0

    def context(self):
        return {'case_root': str(self.case), 'helper_pid': self.pid, 'helper_start': self.start, 'image_id': self.fixture['image_id'], 'run_token': self.fixture['run_token'], 'names': {str(port): expected_name(self.case, self.pid, port) for port in PORTS}}

    def arm(self):
        # Both names absent and durable proof BEFORE caller releases GO.
        for port in PORTS:
            require(self.call(['container', 'inspect', expected_name(self.case, self.pid, port)], missing=True) is None, 'Preserve pre-existing devnet')
        publish_first(self.output / 'tron-armed.json', self.context())

    def admitted_context(self):
        require(read_record(self.output / 'tron-armed.json') == self.context(), 'Missing/mismatched pre-GO devnet custody context')

    def planned_shutdown(self, port, cid):
        path = self.case / 'evidence/fixture-container-stop-intents.jsonl'
        if not path.exists(): return False
        require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 1024 * 1024, 'Bounded Source stop-intent evidence required')
        rows = [json.loads(line) for line in path.read_text().splitlines()]
        selected = [row for row in rows if row.get('kind') == 'tron' and row.get('port') == port]
        if not selected: return False
        require(len(selected) == 1, 'Repeated Source stop intent')
        row = selected[0]
        require(port in self.ready and self.ready[port] == cid and row.get('container_id') == cid and row.get('parent_pid') == self.pid and type(row.get('pid')) is int and row['pid'] > 0 and isinstance(row.get('pre_stop_live_identity'), str) and row['pre_stop_live_identity'] and row.get('acceptance_failed_before_cleanup') is False, 'Unbound/unhealthy Source stop intent')
        return True

    def inspect(self, port, cleaning=False):
        self.admitted_context()
        path = self.output / ('tron-' + str(port) + '-cid.json')
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
                readiness(rows[0], self.fixture, port); self.ready[port] = cid
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
        path=self.output/'tron-writable.json';temporary=self.output/'.tron-writable.pending'
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
        return report
