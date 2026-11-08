"""Radix Compose custody. Caller owns bounded Docker clients and their waits.

Daemon objects never receive direct-parent-wait credit. Imports perform no I/O.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re

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

    def observe(self):
        self.admitted_context()
        found, total = {}, 0
        for cid in self.ids('container'):
            row = self.inspect_container(cid)
            require(row is not None, 'Radix object vanished during inspection')
            service = row['Config']['Labels'][SERVICE_LABEL]
            require(service not in found, 'Duplicate Radix Compose service')
            found[service] = cid
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
        self.inspect_network()
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
