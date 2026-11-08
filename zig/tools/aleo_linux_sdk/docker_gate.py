"""Fixed Aleo Docker API capability. No server/daemon access at import."""
import hashlib
from contextlib import contextmanager
import http.client
import json
import os
from pathlib import Path
import re
import socket
import socketserver
import stat
import struct
import threading
import time
import urllib.parse

from receipts import checked, decode, need

GIB = 1024**3
LIMIT = 16*1024**2
EXECS = (('df','-Pk','/'), ('pg_isready','-U','ziggy','-d','ziggy'))
# Exact publisher config objects, not a subset-label cleanup waiver.
IMAGE_INHERITED_LABELS={
    'sha256:'+('af2bdda6ccb9461b6ba7f69320f8e355b' '07b0442bb500afc3e7c3a434a233068'):{'org.opencontainers.image.version':'22.04'},
    'sha256:'+('47b95c5ad45838febbc39cae4194b6f9' 'c3f6c3d7409b20043e8cea4a5bd70fec'): {},
}

def inherited_image_labels(image_id):
    need(image_id in IMAGE_INHERITED_LABELS,'Unreviewed immutable image label policy')
    return dict(IMAGE_INHERITED_LABELS[image_id])

def verify_inherited_image_labels(image,selected):
    need(image['Id']==selected['image']and(image['Config'].get('Labels')or{})==inherited_image_labels(selected['image']),'Exact immutable image inherited labels differ')



def proc_identity(pid):
    need(type(pid) is int and pid > 0, 'positive host PID required')
    root=Path('/proc')/str(pid)
    raw=(root/'stat').read_text();end=raw.rfind(')');need(end>0,'actual proc stat required')
    values=raw[end+2:].split()
    status={line.split(':',1)[0]:line.split(':',1)[1].strip()for line in (root/'status').read_text().splitlines()if ':'in line}
    return {'pid':pid,'parent':int(values[1]),'group':int(values[2]),'start':int(values[19]),'state':values[0], 'namespace_pids':[int(x)for x in status['NSpid'].split()], 'uid':int(status['Uid'].split()[0]), 'exe':str((root/'exe').readlink()),'cgroup':(root/'cgroup').read_text(),'argv':(root/'cmdline').read_bytes().split(b'\0')[:-1]}


class NamespacePeer:
    """SO_PEERCRED is a host PID; never signal an SDK namespace PID."""
    def __init__(self, spec):self.spec=spec
    def __call__(self, peer_pid):
        child=proc_identity(peer_pid);parent=proc_identity(child['parent'])
        need(child['state']!='Z' and parent['state']!='Z' and child['uid']==parent['uid']==os.getuid(),'live same-user caller required')
        need(child['exe']==str(checked(self.spec['python'])) and parent['exe']==str(checked(self.spec['node'])),'only real shim child of pinned main Node')
        need(len(child['argv'])>=3 and child['argv'][1]==b'-I'and child['argv'][2]==os.fsencode(checked(self.spec['docker_cli'])),'only exact isolated Source Docker shim')
        need(parent['argv']==[os.fsencode(x)for x in self.spec['exact_node_argv']],'not the admitted main Node')
        need(child['cgroup']==parent['cgroup']==self.spec['actual_case_cgroup_line'],'caller outside actual bounded case cgroup')
        owner=decode(Path(self.spec['task_root'],'owner.json').read_bytes(),4096)
        need(owner=={'marker':'ziggy-aleo-owned-v1','pid':parent['namespace_pids'][-1],'manifest':self.spec['manifest_digest']},'Source owner does not bind actual Node PID/manifest')
        stable=('pid','parent','group','start','namespace_pids','uid','exe','cgroup','argv')
        fresh_child=proc_identity(child['pid']);fresh_parent=proc_identity(parent['pid'])
        need(fresh_child['state'] not in {'Z','X'} and fresh_parent['state'] not in {'Z','X'} and all(fresh_child[k]==child[k] and fresh_parent[k]==parent[k]for k in stable),'caller identity changed during admission')
        return {key:parent[key]for key in ('pid','start','namespace_pids','exe','group')}


def container_templates(spec, node_namespace_pid):
    need(type(node_namespace_pid)is int and node_namespace_pid>0,'actual main namespace PID required')
    manifest=spec['manifest'];domains=manifest['domains']
    need(len(domains)==2 and [v['port']for v in domains]==[23030,23031] and len({v['name']for v in domains})==2 and all(re.fullmatch('[a-z][a-z0-9_]{0,31}',v['name'])for v in domains),'exact two Source node endpoints required')
    need(re.fullmatch('[0-9a-f]{64}',spec['internal_network']) and re.fullmatch('[0-9a-f]{32}',spec['run_token']),'actual owned internal network/token required')
    prefix='ziggy-aleo-'+hashlib.sha256(os.fsencode(manifest['taskRoot'])).hexdigest()[:12]+'-'+str(node_namespace_pid)
    result=[]
    for index in range(3):
        pg=index==2;kind='postgres'if pg else ('aleo_a'if index==0 else'aleo_b')
        selected=manifest['postgresImage'if pg else'image'];name=prefix+'-'+('postgres'if pg else domains[index]['name'])
        need(re.fullmatch('sha256:[0-9a-f]{64}',selected['id']) and '@sha256:'in selected['reference'],'actual immutable image required')
        internal='5432/tcp'if pg else'3030/tcp';port=25432 if pg else domains[index]['port']
        memory=GIB//2 if pg else 3*GIB
        labels={**inherited_image_labels(selected['id']),'ziggy.aleo.owner':prefix,'ziggy.aleo.run-token':spec['run_token']}
        config={'Memory':memory,'MemorySwap':memory,'NanoCpus':10**9 if pg else 2*10**9,'PidsLimit':128 if pg else 256,'CapDrop':['ALL'],'SecurityOpt':['no-new-privileges:true'],'NetworkMode':spec['internal_network'],'PortBindings':{internal:[{'HostIp':'127.0.0.1','HostPort':str(port)}]},'Binds':[]}
        if pg:config['Tmpfs']={'/var/lib/postgresql/data':'rw,noexec,nosuid,size=2147483648,uid=999,gid=999'}
        need(spec['postgres_command']==['postgres'],'admitted Source PG default command required')
        body={'Image':selected['reference'],'Cmd':spec['postgres_command']if pg else['leo','devnode','start','--socket-addr','0.0.0.0:3030'],'Env':['POSTGRES_USER=ziggy','POSTGRES_DB=ziggy','POSTGRES_HOST_AUTH_METHOD=trust']if pg else spec['public_node_env'],'Labels':labels,'ExposedPorts':{internal:{}},'HostConfig':config}
        if pg:body['User']='999:999'
        result.append({'name':name,'kind':kind,'image':selected['id'],'reference':selected['reference'],'labels':labels,'create_body':body})
    return result


def request_frame(raw):
    need(isinstance(raw, bytes) and len(raw) <= 16384 and raw.endswith(b'\r\n\r\n'), 'bounded complete Docker header required')
    lines = raw[:-4].decode('ascii').split('\r\n')
    first = lines.pop(0).split(' ')
    need(len(first) == 3 and first[0] in {'GET','POST','DELETE'} and first[2] == 'HTTP/1.1', 'fixed HTTP request required')
    need(first[1].startswith('/') and not first[1].startswith('//') and '%' not in first[1] and '\\' not in first[1] and '#' not in first[1], 'API path escape')
    headers = {}
    for line in lines:
        need(':' in line and not line[0].isspace(), 'invalid HTTP header')
        key, value = line.split(':',1); key = key.lower()
        need(key not in headers and key in {'host','connection','content-type','content-length'}, 'unapproved/duplicate Docker header')
        headers[key] = value.strip()
    need(headers.get('host') == 'localhost' and headers.get('connection') == 'close', 'fixed API authority/connection required')
    length = headers.get('content-length','0')
    need(re.fullmatch('0|[1-9][0-9]{0,5}',length) and int(length) <= 65536, 'bounded body required')
    need(not int(length) or headers.get('content-type') == 'application/json', 'JSON only Docker body')
    return first[0], first[1], int(length)


class WholeSocket:
    """Absolute budget: timer shuts the exact socket even during trickle I/O."""
    def __init__(self, deadline_ns, connection=None):
        need(type(deadline_ns) is int and deadline_ns > time.monotonic_ns(), 'whole socket deadline expired')
        self.deadline_ns = deadline_ns
        self.socket = connection if connection is not None else socket.socket(socket.AF_UNIX)
        self.expired = threading.Event()
        self.timer = threading.Timer(max(0, (deadline_ns-time.monotonic_ns())/10**9), self.expire)
        self.timer.daemon = True

    def expire(self):
        self.expired.set()
        self.close_socket()

    def close_socket(self):
        try:self.socket.shutdown(socket.SHUT_RDWR)
        except OSError:pass
        self.socket.close()

    def __enter__(self):
        self.socket.settimeout(max(.001, (self.deadline_ns-time.monotonic_ns())/10**9))
        self.timer.start()
        return self

    def check(self):
        need(not self.expired.is_set() and time.monotonic_ns() < self.deadline_ns, 'whole socket deadline expired')

    def __exit__(self, kind, value, traceback):
        self.timer.cancel()
        self.close_socket()
        self.timer.join(1)
        if kind is None:
            need(not self.timer.is_alive(), 'whole socket timer remains')
            self.check()


def operation_deadline(original_deadline_ns):
    need(type(original_deadline_ns) is int, 'original deadline required')
    return min(original_deadline_ns, time.monotonic_ns()+10*10**9)


class Daemon:
    def __init__(self, path, identity, api, deadline_ns):
        self.path, self.identity, self.api = path, identity, api
        self.deadline_ns = deadline_ns
        self.local = threading.local()

    @contextmanager
    def operation(self, deadline_ns):
        previous = getattr(self.local, 'deadline_ns', None)
        self.local.deadline_ns = min(deadline_ns, previous) if previous is not None else deadline_ns
        try:yield
        finally:self.local.deadline_ns = previous

    def call(self, method, path, body=None, maximum=LIMIT):
        deadline = operation_deadline(self.deadline_ns)
        if getattr(self.local, 'deadline_ns', None) is not None:
            deadline = min(deadline, self.local.deadline_ns)
        info = os.stat(self.path, follow_symlinks=False)
        need(stat.S_ISSOCK(info.st_mode) and [info.st_dev, info.st_ino] == self.identity, 'raw daemon socket replaced')
        with WholeSocket(deadline) as budget:
            daemon = self
            class Connection(http.client.HTTPConnection):
                def connect(self):
                    budget.check()
                    self.sock = budget.socket
                    self.sock.connect(daemon.path)
            conn = Connection('localhost', timeout=max(.001,(deadline-time.monotonic_ns())/10**9))
            reply = None
            try:
                wire = None if body is None else json.dumps(body,sort_keys=True,separators=(',',':')).encode()
                conn.request(method, '/v'+self.api+path, wire, {'Content-Type':'application/json','Connection':'close'})
                reply = conn.getresponse(); raw = reply.read(maximum+1)
                need(len(raw) <= maximum, 'bounded Docker reply exceeded')
                budget.check()
                return reply.status, raw
            finally:
                if reply is not None:reply.close()
                conn.close()


class NetworkLease:
    """Host-only native Docker API lease; never exposed to the SDK namespace."""
    def __init__(self, daemon, name, labels):
        need(re.fullmatch('ziggy-aleo-net-[0-9a-f]{32}',name),'fresh exact network name required')
        self.daemon,self.name,self.labels=daemon,name,labels;self.cid=None;self.attempted=False

    def inspect(self):
        need(self.cid is not None,'network custody absent')
        status,raw=self.daemon.call('GET','/networks/'+self.cid)
        need(status==200,'owned network inspect failed');value=decode(raw,LIMIT)
        need(value['Id']==self.cid and value['Name']==self.name and value['Labels']==self.labels,'owned network identity changed')
        return value

    def create(self):
        status,_=self.daemon.call('GET','/networks/'+self.name);need(status==404,'network name preexisted')
        body={'Name':self.name,'CheckDuplicate':True,'Driver':'bridge','Internal':True,'Attachable':False,'EnableIPv6':False,'Labels':self.labels}
        self.attempted=True
        status,raw=self.daemon.call('POST','/networks/create',body);need(status==201,'owned network create failed')
        value=decode(raw,LIMIT);need(re.fullmatch('[0-9a-f]{64}',value['Id']),'full new network ID required');self.cid=value['Id']
        row=self.inspect();need(row['Internal']is True and row['Driver']=='bridge'and row['Attachable']is False and not row.get('Containers'),'not a fresh internal network')
        return self.cid

    def close(self):
        if self.cid is None and self.attempted:
            status,raw=self.daemon.call('GET','/networks/'+self.name)
            if status==404:return {'network_absent_after_failed_create':True}
            need(status==200,'lost network create recovery failed');row=decode(raw,LIMIT)
            need(row['Name']==self.name and row['Labels']==self.labels and re.fullmatch('[0-9a-f]{64}',row['Id']),'unowned network after lost reply')
            self.cid=row['Id']
        if self.cid is None:return {'network_never_created':True}
        row=self.inspect();need(not row.get('Containers'),'unknown/live member prevents owned network removal')
        status,_=self.daemon.call('DELETE','/networks/'+self.cid);need(status==204,'owned network removal failed')
        status,_=self.daemon.call('GET','/networks/'+self.cid);need(status==404,'owned network remains')
        return {'cid':self.cid,'owned_internal_network_removed_and_absent':True,'nonchild_wait_credit':False}


class Gate:
    """Serialized tiny allowlist; immutable custody survives health/cap failure."""
    def __init__(self, spec, daemon, peer):
        self.spec, self.daemon, self.peer = spec, daemon, peer
        self.lock = threading.RLock(); self.failed = None
        self.containers = {}; self.execs = {}; self.calls = []; self.total_reply = 0
        self.node_identity = None
        self.attempted = {}
        self.cleaning = False

    def json_call(self, method, path, body=None, expected=(200,)):
        status, raw = self.bounded_call(method,path,body)
        need(status in expected, 'Docker status '+str(status)+' for fixed operation')
        return decode(raw,LIMIT) if raw else None

    def bounded_call(self, method, path, body=None, maximum=LIMIT):
        status, raw = self.daemon.call(method,path,body,maximum=maximum)
        self.total_reply += len(raw)
        need(self.cleaning or self.total_reply <= 128*1024**2, 'whole Docker reply byte cap')
        return status,raw

    def owned(self, cid):
        need(re.fullmatch('[0-9a-f]{64}',cid) and cid in self.containers, 'unowned CID')
        saved = self.containers[cid]
        row = self.json_call('GET','/containers/'+cid+'/json')
        need(row['Id'] == cid and row['Name'] == '/'+saved['name'] and row['Image'] == saved['image'] and row['Config']['Labels'] == saved['labels'], 'replaced/foreign container; no cleanup authority')
        return row

    def expected_create(self, name):
        matches = [value for value in self.spec['containers'] if value['name'] == name]
        need(len(matches) == 1, 'unadmitted container name')
        return matches[0]

    @contextmanager
    def locked(self, deadline_ns):
        remaining=(deadline_ns-time.monotonic_ns())/10**9
        need(remaining>0 and self.lock.acquire(timeout=remaining), 'gate lock deadline expired')
        try:
            need(time.monotonic_ns()<deadline_ns, 'gate lock deadline expired')
            yield
        finally:self.lock.release()

    def dispatch(self, method, path, raw, peer_pid, deadline_ns=None):
        deadline_ns=min(operation_deadline(self.spec['original_deadline_ns']), deadline_ns) if deadline_ns is not None else operation_deadline(self.spec['original_deadline_ns'])
        with self.locked(deadline_ns), self.daemon.operation(deadline_ns):
            return self._dispatch(method,path,raw,peer_pid)

    def _dispatch(self, method, path, raw, peer_pid):
        with self.lock:
            try:
                need(self.failed is None and time.monotonic_ns() < self.spec['original_deadline_ns'], 'gate failed/deadline expired')
                need(len(self.calls) < 8192, 'Docker request count exceeded')
                peer = self.peer(peer_pid)
                if self.node_identity is None:
                    self.node_identity = peer
                    self.spec['containers'] = container_templates(self.spec,peer['namespace_pids'][-1])
                need(peer == self.node_identity,'main Node identity changed')
                body = decode(raw,65536) if raw else None
                need(method != 'GET' or body is None,'GET body forbidden')
                self.calls.append({'method':method,'path':path,'request_sha256':hashlib.sha256(raw).hexdigest()})
                if method == 'GET' and path == '/info':
                    value = self.json_call(method,path)
                    need(value['ID'] == self.spec['daemon_id'], 'daemon identity changed')
                    return 200,json.dumps({'ID':value['ID']}).encode()
                if method == 'GET' and path.startswith('/images/') and path.endswith('/json'):
                    reference = path[len('/images/'):-len('/json')]
                    matches = [v for v in self.spec['containers'] if v['reference'] == reference]
                    need(matches, 'foreign image inspection')
                    value = self.json_call(method,path)
                    need(value['Id'] == matches[0]['image'] and reference in value['RepoDigests']and value['Os']=='linux'and value['Architecture']=='amd64', 'admitted native image changed')
                    return 200,json.dumps([value]).encode()
                if method == 'POST' and path.startswith('/containers/create?name='):
                    name = path[len('/containers/create?name='):]
                    selected = self.expected_create(name)
                    need(body == selected['create_body'], 'uncapped/foreign create body')
                    # Exact-name absence before create, never adopt an old CID.
                    status, _ = self.daemon.call('GET','/containers/'+name+'/json')
                    need(status == 404, 'container name existed before creation')
                    image = self.json_call('GET','/images/'+selected['reference']+'/json')
                    need(image['Id'] == selected['image'] and selected['reference'] in image['RepoDigests']and image['Os']=='linux'and image['Architecture']=='amd64', 'native image changed before create')
                    verify_inherited_image_labels(image,selected)
                    if selected['kind']=='postgres':
                        need(image['Config']['Cmd']==self.spec['postgres_command']and image['Config'].get('Volumes')=={'/var/lib/postgresql/data':{}},'PG default command/data-volume closure changed')
                    else:need(not image['Config'].get('Volumes'),'unknown node image volumes escape disk accounting')
                    self.attempted[name] = selected
                    value = self.json_call(method,path,body,expected=(201,))
                    cid = value['Id']; need(re.fullmatch('[0-9a-f]{64}',cid) and cid not in self.containers, 'full unique new CID required')
                    self.containers[cid] = selected
                    # Retain custody BEFORE any post-create cap/readback failure.
                    row = self.owned(cid)
                    self.caps(row, selected)
                    return 201,json.dumps({'Id':cid}).encode()
                match = re.fullmatch(r'/containers/([0-9a-f]{64})/(json|start|stop\?t=10|logs\?stdout=1&stderr=1&tail=10000|exec|stats\?stream=false)',path)
                if match:
                    cid, operation = match.groups(); row = self.owned(cid)
                    if operation == 'json' and method == 'GET': return 200,json.dumps(row).encode()
                    if operation == 'start' and method == 'POST':
                        need(body is None, 'start body forbidden'); self.caps(row,self.containers[cid]); self.json_call(method,path,expected=(204,))
                        self.kernel_caps(cid);return 204,b''
                    if operation == 'stop?t=10' and method == 'POST':
                        need(body is None, 'stop body forbidden'); self.json_call(method,path,expected=(204,304)); need(self.owned(cid)['State']['Running'] is False,'container did not stop'); return 204,b''
                    if operation.startswith('logs?') and method == 'GET': return self.bounded_call(method,path,maximum=4*1024**2)
                    if operation.startswith('stats?') and method == 'GET': return 200,json.dumps(self.json_call(method,path)).encode()
                    if operation == 'exec' and method == 'POST':
                        need(isinstance(body,dict) and set(body) == {'AttachStdout','AttachStderr','Tty','Cmd'} and body['AttachStdout'] is True and body['AttachStderr'] is True and body['Tty'] is False and tuple(body['Cmd']) in EXECS, 'foreign exec forbidden')
                        need(tuple(body['Cmd']) == EXECS[0] or self.containers[cid]['kind'] == 'postgres','pg readiness on non-PG forbidden')
                        value = self.json_call(method,path,body,expected=(201,)); eid=value['Id']; need(re.fullmatch('[0-9a-f]{64}',eid),'full exec ID required'); self.execs[eid]=cid; return 201,json.dumps(value).encode()
                    raise ValueError('unapproved container operation')
                match = re.fullmatch('/exec/([0-9a-f]{64})/(start|json)',path)
                if match:
                    eid, op = match.groups(); need(eid in self.execs,'unowned exec'); self.owned(self.execs[eid])
                    if op == 'json' and method == 'GET': return 200,json.dumps(self.json_call(method,path)).encode()
                    need(op == 'start' and method == 'POST' and body == {'Detach':False,'Tty':False},'exec start differs')
                    return self.bounded_call(method,path,body,maximum=65536)
                raise ValueError('unapproved Docker API route')
            except Exception as error:
                self.failed = type(error).__name__+':'+str(error)
                raise

    def caps(self, row, selected):
        if selected['kind']=='postgres':need(row['Config'].get('User')=='999:999','actual fixed rootless PG User required')
        actual = row['HostConfig']; expected = selected['create_body']['HostConfig']
        for key in ('Memory','MemorySwap','NanoCpus','PidsLimit','NetworkMode','PortBindings','Tmpfs'):
            if key == 'Tmpfs' and key not in expected:
                need(actual.get(key) in (None,{}),'unapproved tmpfs')
            else:
                need(actual.get(key) == expected.get(key),'container cap/network/mount mismatch')
        need(actual.get('Binds') in (None,[]) and not actual.get('Privileged') and 'ALL' in actual.get('CapDrop',[]) and 'no-new-privileges:true' in actual.get('SecurityOpt',[]),'unsafe container privilege/bind')

    def kernel_caps(self,cid):
        """Real native-host PID/cgroup limits, not only Engine config claims."""
        row=self.owned(cid);need(row['State']['Running']is True and type(row['State']['Pid'])is int and row['State']['Pid']>0,'actual running container PID required')
        pid=row['State']['Pid'];base=Path('/proc')/str(pid);before=(base/'stat').read_text();values=before[before.rfind(')')+2:].split();start=values[19]
        line=(base/'cgroup').read_text().strip();need(line.startswith('0::/')and cid in line,'daemon is not the admitted native-host cgroup')
        directory=Path('/sys/fs/cgroup')/line[4:];need(directory.resolve()==directory,'container cgroup alias forbidden')
        expected=self.containers[cid]['create_body']['HostConfig']
        need((directory/'memory.max').read_text().strip()==str(expected['Memory'])and(directory/'memory.swap.max').read_text().strip()=='0'and(directory/'pids.max').read_text().strip()==str(expected['PidsLimit']),'actual container kernel memory/swap/pid caps differ')
        quota,period=(directory/'cpu.max').read_text().split();need(quota!='max'and int(quota)*10**9==expected['NanoCpus']*int(period),'actual container CPU quota differs')
        if self.containers[cid]['kind']=='postgres':
            mounts=[line.split()for line in(base/'mountinfo').read_text().splitlines()]
            matches=[row for row in mounts if len(row)>6 and row[4]=='/var/lib/postgresql/data']
            need(len(matches)==1,'actual PG data mount missing/ambiguous')
            row=matches[0];separator=row.index('-');need(row[separator+1]=='tmpfs','actual PG data is not bounded tmpfs')
            options=set(row[5].split(','))|set(row[separator+3].split(','))
            sizes=[value[5:]for value in options if value.startswith('size=')]
            need(len(sizes)==1 and sizes[0]in {'2147483648','2097152k','2g'}and {'nosuid','noexec'}<=options,'actual PG tmpfs bound/flags differ')
            need({'uid=999','gid=999'}<=options,'actual PG tmpfs ownership differs')
            status={line.split(':',1)[0]:line.split(':',1)[1].strip()for line in(base/'status').read_text().splitlines()if ':'in line}
            need([int(x)for x in status['Uid'].split()]==[999]*4 and [int(x)for x in status['Gid'].split()]==[999]*4,'actual rootless PG UID/GID differ')
        fresh=(base/'stat').read_text();need(fresh[fresh.rfind(')')+2:].split()[19]==start and self.owned(cid)['State']['Pid']==pid,'container PID changed during cap readback')
        return {'cid':cid,'pid':pid,'start':start,'actual_kernel_caps_checked':True}

    def cleanup(self):
        """Exact created IDs only; allowed after a latched protocol/health failure."""
        rows=[]
        with self.locked(self.daemon.deadline_ns):
            self.cleaning=True
            # A create reply can be lost after the daemon commits it. Recover
            # only a pre-armed exact fresh name + random token + image; never
            # adopt a preexisting name or grant a missing command wait.
            for name, selected in self.attempted.items():
                if selected in self.containers.values():continue
                try:
                    status, raw=self.daemon.call('GET','/containers/'+name+'/json')
                    if status==404:continue
                    need(status==200,'owned create recovery transport error');row=decode(raw,LIMIT)
                    need(row['Name']=='/'+name and row['Image']==selected['image'] and row['Config']['Labels']==selected['labels'] and re.fullmatch('[0-9a-f]{64}',row['Id']),'lost create reply cannot identify owned resource')
                    self.containers[row['Id']]=selected
                except Exception as error:rows.append({'name':name,'recovery_error':str(error),'stopped_removed_absent':False})
            for cid in reversed(list(self.containers)):
                try:
                    row=self.owned(cid)
                    if row['State']['Running']:self.json_call('POST','/containers/'+cid+'/stop?t=10',expected=(204,304))
                    self.json_call('DELETE','/containers/'+cid+'?v=1',expected=(204,))
                    status,_=self.daemon.call('GET','/containers/'+cid+'/json');need(status==404,'owned CID remains')
                    rows.append({'cid':cid,'stopped_removed_absent':True,'nonchild_wait_credit':False})
                except Exception as error:rows.append({'cid':cid,'cleanup_error':str(error),'stopped_removed_absent':False})
            self.cleaning=False
        return {'passed':all(row['stopped_removed_absent']for row in rows),'rows':rows,'actual_native_acceptance':False}


class Server(socketserver.UnixStreamServer):
    """At most sixteen tracked clients; closing never joins without a deadline."""
    request_queue_size = 16
    timeout = .2

    def __init__(self, path, gate):
        self.gate=gate; self.slots=threading.BoundedSemaphore(16)
        self.stopping=threading.Event();self.clients_lock=threading.Lock();self.clients={}
        super().__init__(path, Handler)
        os.chmod(path,0o600)

    def serve_forever(self):
        while not self.stopping.is_set():self.handle_request()

    def process_request(self, request, address):
        with self.clients_lock:
            if self.stopping.is_set():self.shutdown_request(request);return
            if not self.slots.acquire(blocking=False):
                self.gate.failed='Docker concurrent request cap'
                self.shutdown_request(request);return
            def finish():
                try:self.finish_request(request,address)
                finally:
                    self.shutdown_request(request)
                    with self.clients_lock:self.clients.pop(request,None)
                    self.slots.release()
            thread=threading.Thread(target=finish,daemon=True)
            self.clients[request]=thread
            try:thread.start()
            except BaseException:
                self.clients.pop(request,None);self.slots.release();self.shutdown_request(request);raise

    def close_bounded(self, serve_thread, deadline_ns):
        self.stopping.set()
        with self.clients_lock:clients=list(self.clients.items())
        for connection,_ in clients:
            try:connection.shutdown(socket.SHUT_RDWR)
            except OSError:pass
            connection.close()
        self.server_close()
        for thread in [serve_thread,*[thread for _,thread in clients]]:
            thread.join(max(0,(deadline_ns-time.monotonic_ns())/10**9))
        need(not serve_thread.is_alive() and all(not thread.is_alive()for _,thread in clients), 'API server/client thread remains')
        with self.clients_lock:need(not self.clients, 'API clients remain')
        return {'serve_thread_joined':True,'client_threads_joined':True,'captured_clients':len(clients)}


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        deadline=operation_deadline(self.server.gate.spec['original_deadline_ns'])
        try:
            with WholeSocket(deadline,self.request) as budget:
                pid,_,_=struct.unpack('3i',self.request.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
                stream=self.request.makefile('rb')
                try:
                    header=b''
                    while not header.endswith(b'\r\n\r\n'):
                        byte=stream.read(1);need(byte and len(header)<16384,'incomplete/oversized Docker header');header+=byte
                    method,path,length=request_frame(header);body=stream.read(length);need(len(body)==length,'truncated body')
                    status,raw=self.server.gate.dispatch(method,path,body,pid,deadline)
                    budget.check()
                    self.request.sendall(('HTTP/1.1 '+str(status)+' Reply\r\nConnection: close\r\nContent-Length: '+str(len(raw))+'\r\n\r\n').encode()+raw)
                finally:stream.close()
        except Exception as error:
            self.server.gate.failed=self.server.gate.failed or type(error).__name__+':'+str(error)
