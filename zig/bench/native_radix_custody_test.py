"""Pure adversarial Compose custody controls; no Docker/socket/native execution."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


def load(name):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


m=load('native_radix_custody')
assets=load('native_radix_assets')


class Docker:
    """Stateful inspect/stop/remove responses with real Docker DTO shapes."""
    def __init__(self):
        self.containers={};self.networks={};self.volumes={};self.calls=[];self.deny_rm=set()
    def __call__(self,args,missing=False,cleaning=False):
        self.calls.append({'args':list(args),'cleaning':cleaning})
        kind,verb=args[:2]
        table={'container':self.containers,'network':self.networks,'volume':self.volumes}[kind]
        if verb=='ls':
            rows=list(table)
            if '--filter'in args:
                label=args[args.index('--filter')+1].removeprefix('label=');key,value=label.split('=',1)
                def labels(row):return(row.get('Config',{}).get('Labels')if kind=='container'else row.get('Labels'))or{}
                rows=[key_id for key_id in rows if labels(table[key_id]).get(key)==value]
            return '\n'.join(rows)
        target=args[-1]
        if kind=='network'and target not in table:
            target=next((key for key,row in table.items()if row['Name']==target),target)
        if verb=='inspect':
            if target not in table:
                if missing:return None
                raise ValueError('mock exact object absent')
            row=copy.deepcopy(table[target])
            if kind=='network':
                row['Containers']={cid:{'Name':cid}for cid,c in self.containers.items()if row['Name']in c['NetworkSettings']['Networks']}
            return json.dumps([row])
        if verb=='stop':
            assert kind=='container'and cleaning
            table[target]['State'].update(Status='exited',Running=False,ExitCode=0)
            return target
        if verb=='rm':
            assert cleaning
            if target in self.deny_rm:raise ValueError('injected owned remove failure')
            del table[target]
            return target
        raise AssertionError(('unreviewed mock command',args))
    def mutations(self):return[c['args']for c in self.calls if c['args'][1]in{'stop','rm'}]


class Controls(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='radix-custody-pure-');self.addCleanup(self.temp.cleanup)
        self.case=Path(self.temp.name).resolve();self.output=self.case/'owner';self.output.mkdir()
        self.fixture={'architecture':'amd64','token':'ab'*16,'images':{name:{'source':row['source_image'],'id':row['image_id']}for name,row in assets.IMAGES.items()}}
        self.docker=Docker();self.volume_size=12345;self.volume_calls=[];self.custody=self.new();self.custody.arm()
    def sample_volume(self,name):
        self.volume_calls.append(name);return {'name':name,'size_bytes':self.volume_size}
    def new(self):return m.Custody(self.case,24680,'linux-ticks:123',copy.deepcopy(self.fixture),self.output,self.docker,volume_sample=self.sample_volume)
    def launch(self,services=None):
        for index,service in enumerate(m.SERVICES,1):
            if services is not None and service not in services:continue
            cid=hashlib.sha256(('container-'+service).encode()).hexdigest();memory,pids,ports=m.SERVICES[service]
            bindings={p:[{'HostIp':'127.0.0.1','HostPort':str(n)}]for p,n in ports.items()}
            migration=service=='database_migrations_image'
            row={'Id':cid,'Name':'/'+self.custody.project+'-'+service+'-1','Image':self.fixture['images'][service]['id'],
                 'Config':{'Image':self.fixture['images'][service]['id'],'Labels':{m.PROJECT_LABEL:self.custody.project,m.SERVICE_LABEL:service,m.TOKEN_LABEL:self.fixture['token']}},
                 'HostConfig':{'Memory':memory*m.MIB,'MemorySwap':memory*m.MIB,'NanoCpus':2_000_000_000,'PidsLimit':pids,'Init':True,'RestartPolicy':{'Name':'no'},'SecurityOpt':['no-new-privileges:true'],'Privileged':False,'PortBindings':bindings,'Binds':None,'Tmpfs':None},
                 'NetworkSettings':{'Networks':{self.custody.network:{}},'Ports':copy.deepcopy(bindings)},'Mounts':[],'SizeRw':index*1024,
                 'State':{'Status':'exited'if migration else'running','Running':not migration,'ExitCode':0,'OOMKilled':False}}
            if service=='postgres_db':
                volume=hashlib.sha256(b'anonymous-pg15').hexdigest();row['Mounts']=[{'Type':'volume','Name':volume,'Destination':m.PGDATA,'RW':True,'Driver':'local'}]
                self.docker.volumes[volume]={'Name':volume,'Driver':'local','Labels':None,'Options':None}
            self.docker.containers[cid]=row
        nid=hashlib.sha256(b'owned-network').hexdigest();self.docker.networks[nid]={'Id':nid,'Name':self.custody.network,'Labels':{m.PROJECT_LABEL:self.custody.project},'Internal':True,'Containers':{}}
    def row(self,service):return next(row for row in self.docker.containers.values()if row['Config']['Labels'][m.SERVICE_LABEL]==service)
    def stop_marker(self):
        directory=self.case/'radix-localnet';directory.mkdir(exist_ok=True)
        (directory/'stopping.json').write_text(json.dumps({'project':self.custody.project,'parent_pid':24680,'containers':self.custody.seen}))
    def cleanup_failure(self,controller=None):
        try:result=(controller or self.custody).cleanup()
        except ValueError:return None
        self.assertIs(result['passed'],False);self.assertIs(result['container_absent'],False);self.assertTrue(result['errors'])
        return result
    def log_capture(self, chunks=None, eof=True, returncode=0, spawn_error=False, kill_error=False, wait_timeout=False, deadline=100):
        import os
        import subprocess
        import types
        from unittest import mock
        state={'now':1.0,'reads':[],'requested':[],'kills':0,'waits':0,'closed':False,'selector_closed':False}
        chunks=list(chunks or [])
        class Pipe:
            def fileno(self):return 12345
            def close(self):state['closed']=True
        class Child:
            pid=54321
            stdout=Pipe()
            returncode=None
            def poll(self):return self.returncode
            def kill(self):
                state['kills']+=1
                if kill_error:raise OSError('PRIVATE_SENTINEL')
                self.returncode=-9
            def wait(self,timeout):
                state['waits']+=1
                if wait_timeout and state['waits']==1:raise subprocess.TimeoutExpired(['mock'],timeout)
                if self.returncode is None:self.returncode=returncode
                return self.returncode
        child=Child()
        class Selector:
            def register(self,*args):pass
            def select(self,timeout):state['now']+=timeout;return [(object(),1)]
            def close(self):state['selector_closed']=True
        def read(fd,n):
            state['requested'].append(n)
            if chunks:
                value=chunks[0][:n];chunks[0]=chunks[0][n:]
                if not chunks[0]:chunks.pop(0)
            else:value=b''if eof else b'x'
            state['reads'].append(len(value));return value
        def popen(argv,**kwargs):
            state['argv']=argv;state['environment']=kwargs['env']
            if spawn_error:raise OSError('PRIVATE_SENTINEL')
            return child
        fake_process=types.SimpleNamespace(Popen=popen,DEVNULL=subprocess.DEVNULL,PIPE=subprocess.PIPE,STDOUT=subprocess.STDOUT,TimeoutExpired=subprocess.TimeoutExpired)
        fake_time=types.SimpleNamespace(monotonic=lambda:state['now'],monotonic_ns=lambda:int(state['now']*10**9))
        fake_select=types.SimpleNamespace(DefaultSelector=Selector,EVENT_READ=1)
        target={'service':'fullnode','container_id':'ab'*32,'image_id':'sha256:'+'cd'*32,'project':'ziggy-e2e-0123456789-24680-radix'}
        output=self.case/'radix-fullnode-failure.log'
        with mock.patch.object(m,'subprocess',fake_process),mock.patch.object(m,'time',fake_time),mock.patch.object(m,'selectors',fake_select),mock.patch.object(m.os,'read',read),mock.patch.object(m.os,'set_blocking',lambda *args:None):
            row=m.capture_fullnode_log(target,['/usr/bin/docker','--host','unix:///var/run/docker.sock','--config',str(self.case/'docker-config')],{'PRIVATE_SENTINEL':'not exported'},output,deadline)
        self.assertNotIn('PRIVATE_SENTINEL',json.dumps(row));return row,state,output
    def test_exact_owned_failed_fullnode_log_target_requires_failed_authenticated_observation(self):
        self.launch(['fullnode']);self.custody.observe();self.assertIsNone(self.custody.failed_fullnode_log_target())
        self.row('fullnode')['State'].update(Status='exited',Running=False,ExitCode=255)
        with self.assertRaisesRegex(ValueError,'service failed or stopped'):self.custody.observe()
        target=self.custody.failed_fullnode_log_target();self.assertEqual(target['container_id'],self.row('fullnode')['Id'])
        self.assertEqual(target['image_id'],self.fixture['images']['fullnode']['id']);self.assertEqual(target['project'],self.custody.project)
        self.custody.seen['fullnode']='ef'*32;self.assertIsNone(self.custody.failed_fullnode_log_target())
    def test_changed_image_or_unavailable_state_cannot_authorize_logs(self):
        self.launch(['fullnode']);self.row('fullnode')['State'].update(Status='exited',Running=False,ExitCode=255)
        with self.assertRaises(ValueError):self.custody.observe()
        row=self.custody.service_states['fullnode'];row['image_id']='sha256:'+'ef'*32
        self.assertIsNone(self.custody.failed_fullnode_log_target())
        row['image_id']=self.fixture['images']['fullnode']['id'];self.custody.service_observation_unavailable=True
        self.assertIsNone(self.custody.failed_fullnode_log_target())
    def test_wrong_service_log_target_is_rejected_before_spawn_or_file_creation(self):
        from unittest import mock
        target={'service':'postgres_db','container_id':'ab'*32,'image_id':'sha256:'+'cd'*32,'project':'project'}
        out=self.case/'radix-fullnode-failure.log'
        with mock.patch.object(m.subprocess,'Popen')as popen,self.assertRaisesRegex(ValueError,'Exact failed fullnode'):
            m.capture_fullnode_log(target,['/usr/bin/docker','--host','unix:///var/run/docker.sock','--config',str(self.case)],{},out,10**12)
        popen.assert_not_called();self.assertFalse(out.exists())
    def test_foreign_fullnode_never_gets_log_authority(self):
        self.launch(['fullnode']);self.row('fullnode')['State'].update(Status='exited',Running=False,ExitCode=255);self.row('fullnode')['Config']['Labels'][m.TOKEN_LABEL]='cd'*16
        with self.assertRaisesRegex(ValueError,'Foreign'):self.custody.observe()
        self.assertIsNone(self.custody.failed_fullnode_log_target())
    def test_log_retains_exact_public_bytes_fingerprint_and_actual_client_wait_only(self):
        raw=b'fixture startup diagnostic\n';row,state,out=self.log_capture([raw])
        self.assertEqual(row['capture_status'],'complete');self.assertTrue(row['actual_parent_wait']);self.assertEqual(row['exit_code'],0)
        self.assertEqual(out.read_bytes(),raw);self.assertEqual(out.stat().st_mode&0o777,0o600)
        self.assertEqual(row['log'],{'path':str(out),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()})
        self.assertEqual(state['argv'][-6:],['container','logs','--tail','80','--timestamps','ab'*32]);self.assertEqual(state['kills'],0);self.assertEqual(state['waits'],1)
        self.assertTrue(state['closed']and state['selector_closed'])
    def test_log_byte_cap_stops_at16KiB_kills_and_waits_owned_client(self):
        row,state,out=self.log_capture([b'x'*50000])
        self.assertEqual(row['capture_status'],'byte_limit');self.assertEqual(len(out.read_bytes()),16384);self.assertEqual(sum(state['reads']),16384)
        self.assertEqual(state['kills'],1);self.assertTrue(row['actual_parent_wait']);self.assertEqual(row['exit_code'],-9)
    def test_log_trickle_uses_one_original_clamped_deadline_and_does_not_reset(self):
        row,state,out=self.log_capture(eof=False,deadline=1.2)
        self.assertEqual(row['read_deadline_seconds'],1.2);self.assertEqual(row['capture_status'],'deadline');self.assertLessEqual(state['now'],1.200001)
        self.assertLess(len(out.read_bytes()),16384);self.assertEqual(state['kills'],1);self.assertTrue(row['actual_parent_wait'])
    def test_log_spawn_error_has_no_fictional_wait_or_exception_text(self):
        row,state,out=self.log_capture(spawn_error=True)
        self.assertEqual(row['capture_status'],'unavailable');self.assertIsNone(row['pid']);self.assertFalse(row['actual_parent_wait']);self.assertEqual(out.read_bytes(),b'')
    def test_log_kill_error_does_not_skip_independent_wait_and_descriptor_closes(self):
        row,state,out=self.log_capture([b'x'*50000],kill_error=True)
        self.assertEqual(row['capture_status'],'unavailable');self.assertEqual(row['cleanup_failures'],['client-kill'])
        self.assertTrue(row['actual_parent_wait']);self.assertEqual(state['waits'],1);self.assertTrue(state['closed']and state['selector_closed'])
    def test_log_eof_client_wait_timeout_kills_then_actually_reaps(self):
        row,state,out=self.log_capture([b'fixture'],wait_timeout=True)
        self.assertEqual(row['capture_status'],'client_error');self.assertEqual(state['waits'],2);self.assertEqual(state['kills'],1);self.assertTrue(row['actual_parent_wait'])
    def test_log_nonzero_client_is_not_complete_or_native_acceptance(self):
        row,state,out=self.log_capture([b'fixed fixture diagnostic'],returncode=1)
        self.assertEqual(row['capture_status'],'client_error');self.assertEqual(row['exit_code'],1);self.assertTrue(row['actual_parent_wait']);self.assertNotIn('native_case_acceptance',row)
    def test_actual_owner_log_exception_does_not_skip_next_child_cleanup(self):
        import ast
        import types
        source=ast.parse(Path(__file__).with_name('native_case_owner.py').read_bytes());worker=next(n for n in source.body if isinstance(n,ast.FunctionDef)and n.name=='worker');primary=next(n for n in worker.body if isinstance(n,ast.Try)and n.finalbody);cleanup=next(n for n in primary.finalbody if isinstance(n,ast.Try))
        diagnostic=next(n for n in cleanup.body if isinstance(n,ast.If)and ast.unparse(n.test)=='radix is not None');stop=next(n for n in cleanup.body if isinstance(n,ast.Expr)and isinstance(n.value,ast.Call)and isinstance(n.value.func,ast.Name)and n.value.func.id=='stop_direct')
        events=[]
        class Radix:
            def public_observation(self):return {'schema':1,'collection_status':'available'}
            def failed_fullnode_log_target(self):return {'service':'fullnode'}
        def failed(*args):events.append('log-diagnostic');raise RuntimeError('PRIVATE_SENTINEL')
        result={'passed':False};context={'radix':Radix(),'result':result,'harness':object(),'stop_direct':lambda *args:events.append('child-stop'),'radix_custody':lambda:types.SimpleNamespace(capture_fullnode_log=failed),'docker':'/usr/bin/docker','inputs':{'local_docker':{'host':'unix:///var/run/docker.sock','config_dir':str(self.case/'docker-config')}},'docker_env':{},'out':self.case,'deadline':1}
        exec(compile(ast.Module(body=[diagnostic,stop],type_ignores=[]),'actual-owner-log-finally-fragment','exec'),context)
        self.assertEqual(events,['log-diagnostic','child-stop']);self.assertFalse(result['passed']);self.assertEqual(result['radix_fullnode_failure_log'],{'schema':1,'capture_status':'unavailable'})
        self.assertNotIn('PRIVATE_SENTINEL',json.dumps(result))
    def test_projection_exception_disables_bookkeeping_but_preserves_readiness_and_cleanup(self):
        self.launch(['fullnode']);old=m.public_service_state;calls=[]
        def unavailable(*args):calls.append(True);raise RuntimeError('PRIVATE_SENTINEL')
        m.public_service_state=unavailable
        try:
            self.custody.observe();self.custody.observe()
            self.assertEqual(calls,[True]);self.assertIn('fullnode',self.custody.ready)
            report=self.custody.public_observation();self.assertEqual(report['collection_status'],'unavailable')
            self.assertNotIn('PRIVATE_SENTINEL',json.dumps(report))
            self.row('fullnode')['State'].update(Status='exited',Running=False,ExitCode=23)
            with self.assertRaisesRegex(ValueError,'service failed or stopped'):self.custody.observe()
            self.assertTrue(self.custody.cleanup()['passed']);self.assertFalse(self.docker.containers)
        finally:m.public_service_state=old
    def test_worker_actual_finally_projection_failure_continues_to_next_child_stop(self):
        import ast
        source=ast.parse(Path(__file__).with_name('native_case_owner.py').read_bytes())
        worker=next(n for n in source.body if isinstance(n,ast.FunctionDef)and n.name=='worker')
        primary=next(n for n in worker.body if isinstance(n,ast.Try)and n.finalbody)
        cleanup=next(n for n in primary.finalbody if isinstance(n,ast.Try))
        observation=next(n for n in cleanup.body if isinstance(n,ast.If)and ast.unparse(n.test)=='radix is not None')
        stop=next(n for n in cleanup.body if isinstance(n,ast.Expr)and isinstance(n.value,ast.Call)and isinstance(n.value.func,ast.Name)and n.value.func.id=='stop_direct')
        self.assertLess(cleanup.body.index(observation),cleanup.body.index(stop))
        events=[]
        class Projection:
            def public_observation(self):events.append('projection');raise RuntimeError('PRIVATE_SENTINEL')
        result={'passed':False};context={'radix':Projection(),'result':result,'harness':object(),'stop_direct':lambda *args:events.append('child-stop')}
        exec(compile(ast.Module(body=[observation,stop],type_ignores=[]),'actual-worker-finally-fragment','exec'),context)
        self.assertEqual(events,['projection','child-stop']);self.assertIs(result['passed'],False)
        self.assertEqual(result['radix_service_observation'],{'schema':1,'collection_status':'unavailable'})
        self.assertNotIn('PRIVATE_SENTINEL',json.dumps(result))
    def test_failed_fullnode_state_is_retained_before_original_readiness_error(self):
        self.launch();row=self.row('fullnode');row['State'].update(Status='exited',Running=False,ExitCode=23,OOMKilled=False,Pid=0,Dead=False)
        with self.assertRaisesRegex(ValueError,'service failed or stopped'):self.custody.observe()
        report=self.custody.public_observation();self.assertEqual(report['last_inspected_service'],'fullnode')
        found=next(v for v in report['services']if v['service']=='fullnode')
        self.assertEqual(found['container_id'],row['Id']);self.assertEqual(found['state']['ExitCode'],23)
        self.assertEqual(found['state']['Status'],'exited');self.assertGreater(found['observed_monotonic_ns'],0)
        self.assertNotIn('fullnode',report['readiness_passed_services'])
        before=copy.deepcopy(report);self.custody.cleanup();self.assertEqual(self.custody.public_observation(),before)
    def test_running_oom_retains_actual_state_without_changing_failure(self):
        self.launch(['fullnode']);self.row('fullnode')['State']['OOMKilled']=True
        with self.assertRaisesRegex(ValueError,'service failed or stopped'):self.custody.observe()
        self.assertIs(self.custody.public_observation()['services'][0]['state']['OOMKilled'],True)
    def test_foreign_inspect_gets_no_diagnostic_cid_authority(self):
        self.launch(['fullnode']);self.row('fullnode')['Config']['Labels'][m.TOKEN_LABEL]='cd'*16
        with self.assertRaisesRegex(ValueError,'Foreign'):self.custody.observe()
        self.assertEqual(self.custody.public_observation()['services'],[])
        self.assertIsNone(self.custody.public_observation()['last_inspected_service'])
    def test_public_state_drops_raw_nested_values_and_unknown_fields(self):
        self.launch(['fullnode']);row=copy.deepcopy(self.row('fullnode'))
        row['Config']['Env']=['PRIVATE_SENTINEL'];row['State'].update(Error='PRIVATE_SENTINEL',Health={'Log':['PRIVATE_SENTINEL']},Status={'private':'PRIVATE_SENTINEL'},Pid=True,ExitCode={'private':'PRIVATE_SENTINEL'},StartedAt={'private':'PRIVATE_SENTINEL'},FinishedAt='2026-11-08T00:00:00.123456789Z')
        found=m.public_service_state(row,'fullnode',123)
        self.assertNotIn('PRIVATE_SENTINEL',json.dumps(found));self.assertEqual(found['state']['FinishedAt'],'2026-11-08T00:00:00.123456789Z')
        self.assertEqual(set(found['invalid_fields']),{'Status','Pid','ExitCode','StartedAt'})
        row['State']=[];self.assertEqual(m.public_service_state(row,'fullnode',123)['invalid_fields'],['State'])
    def test_actual_null_ports_remain_distinct_from_requested_bindings(self):
        self.launch(['fullnode']);row=self.row('fullnode');row['NetworkSettings']['Ports']=None
        self.custody.observe();report=self.custody.public_observation()
        self.assertEqual(report['services'][0]['network_ports'],{'status':'null','known_ports':{},'other_port_key_count':0})
        self.assertEqual(report['readiness_passed_services'],['fullnode'])
        self.assertEqual(row['HostConfig']['PortBindings']['3333/tcp'][0]['HostIp'],'127.0.0.1')

    def test_ports_projection_categorizes_actual_bindings_without_raw_addresses(self):
        self.launch(['fullnode']);row=self.row('fullnode');original=copy.deepcopy(row)
        row['NetworkSettings']['Ports']={'3333/tcp':[{'HostIp':'127.0.0.1','HostPort':'3333'},{'HostIp':'0.0.0.0','HostPort':'3334'},{'HostIp':'::','HostPort':'3335'},{'HostIp':'192.0.2.9','HostPort':'3336'}],'PRIVATE_UNKNOWN_PORT':[{'HostIp':'PRIVATE','HostPort':'PRIVATE'}]}
        expected=[{'host_ip_category':category,'host_port':3333+index}for index,category in enumerate(['loopback','wildcard','wildcard','other'])]
        out=m.public_network_ports(row,'fullnode');self.assertEqual(out['known_ports'],{'3333/tcp':{'status':'bindings','bindings':expected}});self.assertEqual(out['other_port_key_count'],1)
        text=json.dumps(out);self.assertNotIn('127.0.0.1',text);self.assertNotIn('192.0.2.9',text);self.assertNotIn('PRIVATE',text)
        self.assertEqual(row['HostConfig'],original['HostConfig'])

    def test_missing_null_and_empty_known_ports_are_distinct(self):
        for value,expected in [({},'missing'),({'3333/tcp':None},'null'),({'3333/tcp':[]},'bindings')]:
            out=m.public_network_ports({'NetworkSettings':{'Ports':value}},'fullnode')
            self.assertEqual(out['known_ports']['3333/tcp'],{'status':expected,'bindings':[]})
        for value in [False,[]]:
            out=m.public_network_ports({'NetworkSettings':value},'fullnode');self.assertEqual(out['status'],'invalid')
        self.assertEqual(m.public_network_ports({'NetworkSettings':{'PRIVATE':'PRIVATE'}},'fullnode')['status'],'missing')

    def test_malformed_or_excess_bindings_never_escape_closed_projection(self):
        for value in [False,'PRIVATE',[{'HostIp':'PRIVATE','HostPort':'PRIVATE'}],[{'HostIp':'127.0.0.1','HostPort':True}],[{'HostIp':'127.0.0.1','HostPort':'65536'}],[{'HostIp':'127.0.0.1','HostPort':'000000'}],[{'HostIp':'127.0.0.1','HostPort':3333}]*5]:
            out=m.public_network_ports({'NetworkSettings':{'Ports':{'3333/tcp':value}}},'fullnode')
            self.assertEqual(out['known_ports']['3333/tcp'],{'status':'invalid','bindings':[]})
            self.assertNotIn('PRIVATE',json.dumps(out))

    def test_service_port_allowlists_do_not_expand_from_inspected_keys(self):
        out=m.public_network_ports({'NetworkSettings':{'Ports':{'3333/tcp':None,'PRIVATE':None}}},'database_migrations_image')
        self.assertEqual(out,{'status':'map','known_ports':{},'other_port_key_count':2})
        out=m.public_network_ports({'NetworkSettings':{'Ports':{'8080/tcp':None}}},'gateway_api_image')
        self.assertEqual(set(out['known_ports']),{'8080/tcp','1235/tcp'})

    def test_ports_diagnostic_is_authenticated_immutable_and_deep_copied(self):
        self.launch(['fullnode']);row=self.row('fullnode');before=copy.deepcopy(row)
        self.custody.observe();self.assertEqual(row,before)
        report=self.custody.public_observation();report['services'][0]['network_ports']['known_ports']['3333/tcp']['bindings'][0]['host_port']=9
        self.assertEqual(self.custody.public_observation()['services'][0]['network_ports']['known_ports']['3333/tcp']['bindings'][0]['host_port'],3333)
        row['Config']['Labels'][m.TOKEN_LABEL]='foreign'
        self.custody.service_states={}
        with self.assertRaisesRegex(ValueError,'Foreign'):self.custody.observe()
        self.assertEqual(self.custody.public_observation()['services'],[])

    def test_observation_returns_independent_closed_copy(self):
        self.launch(['fullnode']);self.custody.observe();a=self.custody.public_observation()
        a['services'][0]['state']['Status']='foreign';a['services'][0]['invalid_fields'].append('foreign');a['readiness_passed_services'].clear()
        b=self.custody.public_observation();self.assertEqual(b['services'][0]['state']['Status'],'running');self.assertEqual(b['services'][0]['invalid_fields'],[]);self.assertEqual(b['readiness_passed_services'],['fullnode'])
    def test_realistic_five_services_exit0_migration_network_and_anonymous_pg15_cleanup(self):
        self.launch();self.assertGreater(self.custody.observe(),0)
        self.assertEqual(set(self.custody.ready),set(m.SERVICES))
        self.assertEqual(self.row('database_migrations_image')['State']['Status'],'exited')
        self.docker.calls.clear();report=self.custody.cleanup();self.assertIs(report['passed'],True)
        self.assertTrue(all(call['cleaning']for call in self.docker.calls))
        self.assertIs(report['native_parent_wait_credit'],False)
        self.assertEqual(self.docker.containers,{});self.assertEqual(self.docker.networks,{});self.assertEqual(self.docker.volumes,{})
        self.assertEqual(len(report['containers']),5)
        self.assertTrue(all(len(args[-1])==64 for args in self.docker.mutations()))
    def test_first_authenticated_cid_is_durable_before_bad_caps_and_cleanup_still_works(self):
        self.launch(['fullnode']);row=self.row('fullnode');row['HostConfig']['Memory']-=1
        with self.assertRaisesRegex(ValueError,'resource'):self.custody.observe()
        receipt=self.output/'radix-fullnode-cid.json';self.assertEqual(json.loads(receipt.read_text()),{'container_id':row['Id']})
        inode=receipt.stat().st_ino;self.assertNotIn('fullnode',self.custody.ready)
        self.assertIs(self.new().cleanup()['passed'],True);self.assertEqual(receipt.stat().st_ino,inode)
    def test_polls_never_replace_first_identity_inode_or_bytes(self):
        self.launch();self.custody.observe();p=self.output/'radix-fullnode-cid.json';before=(p.stat().st_ino,p.read_bytes())
        self.custody.observe();self.assertEqual((p.stat().st_ino,p.read_bytes()),before)
    def test_nonzero_or_oom_migration_never_becomes_ready(self):
        for change in({'ExitCode':7},{'OOMKilled':True}):
            with self.subTest(change=change):
                self.docker.containers.clear();self.launch(['database_migrations_image']);self.row('database_migrations_image')['State'].update(change)
                with self.assertRaisesRegex(ValueError,'migration'):self.custody.observe()
                self.assertNotIn('database_migrations_image',self.custody.ready)
    def test_running_migration_is_pending_until_actual_successful_exit(self):
        self.launch(['database_migrations_image'])
        self.row('database_migrations_image')['State'].update(Status='running',Running=True)
        self.custody.observe()
        self.assertNotIn('database_migrations_image',self.custody.ready)
    def test_created_service_is_pending_not_ready(self):
        self.launch(['fullnode']);self.row('fullnode')['State'].update(Status='created',Running=False)
        self.custody.observe();self.assertEqual(self.custody.ready,{})
    def test_public_port_binding_refused_after_identity_capture(self):
        self.launch(['fullnode']);self.row('fullnode')['HostConfig']['PortBindings']['3333/tcp'][0]['HostIp']='0.0.0.0'
        with self.assertRaisesRegex(ValueError,'ports'):self.custody.observe()
        self.assertTrue((self.output/'radix-fullnode-cid.json').is_file())
    def test_foreign_token_never_grants_mutation_authority(self):
        self.launch(['fullnode']);self.row('fullnode')['Config']['Labels'][m.TOKEN_LABEL]='cd'*16
        with self.assertRaisesRegex(ValueError,'Foreign'):self.custody.observe()
        self.cleanup_failure();self.assertEqual(self.docker.mutations(),[])
    def test_replaced_service_is_preserved_even_in_fresh_recovery(self):
        self.launch(['fullnode']);self.custody.observe();row=self.row('fullnode');old=row['Id'];del self.docker.containers[old]
        row['Id']=hashlib.sha256(b'replacement').hexdigest();self.docker.containers[row['Id']]=row
        self.cleanup_failure(self.new());self.assertEqual(self.docker.mutations(),[])
        self.assertIn(row['Id'],self.docker.containers)
    def test_partial_creation_cleanup_does_not_require_all_five_services(self):
        self.launch(['fullnode','postgres_db']);report=self.new().cleanup()
        self.assertIs(report['passed'],True);self.assertEqual(len(report['containers']),2)
        self.assertEqual(self.docker.containers,{});self.assertEqual(self.docker.volumes,{})
    def test_recovery_loads_prior_pg_cid_and_removes_captured_volume_after_pg_vanishes(self):
        self.launch();self.custody.observe();cid=self.row('postgres_db')['Id'];del self.docker.containers[cid]
        report=self.new().cleanup();self.assertIs(report['passed'],True);self.assertEqual(self.docker.volumes,{})
    def test_foreign_service_does_not_prevent_cleanup_of_other_positive_identities(self):
        self.launch();self.custody.observe();foreign=self.row('fullnode');foreign['Config']['Labels'][m.TOKEN_LABEL]='cd'*16
        self.cleanup_failure();self.assertEqual(set(self.docker.containers),{foreign['Id']})
        self.assertFalse(any(args[-1]==foreign['Id']for args in self.docker.mutations()))
    def test_one_failed_owned_removal_still_attempts_other_owned_services(self):
        self.launch();self.custody.observe();failed=self.row('fullnode')['Id'];self.docker.deny_rm.add(failed)
        self.cleanup_failure();self.assertEqual(set(self.docker.containers),{failed})
    def test_unknown_network_member_is_preserved_but_positive_services_cleanup(self):
        self.launch();self.custody.observe();foreign=copy.deepcopy(self.row('fullnode'));foreign['Id']=hashlib.sha256(b'foreign-project').hexdigest();foreign['Config']['Labels'][m.PROJECT_LABEL]='other';self.docker.containers[foreign['Id']]=foreign
        self.cleanup_failure();self.assertEqual(set(self.docker.containers),{foreign['Id']});self.assertTrue(self.docker.networks)
        self.assertFalse(any(args[0]=='network'and args[1]=='rm'for args in self.docker.mutations()))
    def test_preexisting_anonymous_volume_name_is_never_adopted_or_removed(self):
        # New pre-GO baseline explicitly contains the would-be PG volume.
        old=hashlib.sha256(b'anonymous-pg15').hexdigest();self.docker.volumes[old]={'Name':old,'Driver':'local','Labels':None,'Options':None}
        (self.output/'radix-armed.json').unlink();self.custody.arm();self.launch(['postgres_db'])
        with self.assertRaisesRegex(ValueError,'pre-existing'):self.custody.observe()
        self.cleanup_failure();self.assertIn(old,self.docker.volumes)
        self.assertFalse(any(args[:2]==['volume','rm']for args in self.docker.mutations()))
    def test_engine_anonymous_marker_keeps_exact_captured_volume_custody(self):
        self.launch();name=self.row('postgres_db')['Mounts'][0]['Name']
        self.docker.volumes[name]['Labels']={'com.docker.volume.anonymous':''}
        self.custody.observe();record=json.loads((self.output/'radix-volume.json').read_text())
        self.assertEqual(record['name'],name);self.assertEqual(record['container_id'],self.row('postgres_db')['Id'])
        result=self.custody.cleanup();self.assertTrue(result['passed']);self.assertFalse(self.docker.volumes)
    def test_wrong_or_extra_anonymous_labels_never_authorize_volume_cleanup(self):
        self.launch();name=self.row('postgres_db')['Mounts'][0]['Name']
        for labels in [{'com.docker.volume.anonymous':'true'},{'com.docker.volume.anonymous':'','foreign':'extra'},{m.PROJECT_LABEL:'foreign'}]:
            self.docker.volumes[name]['Labels']=labels
            with self.subTest(labels=labels),self.assertRaisesRegex(ValueError,'foreign labels'):self.custody.observe()
        self.cleanup_failure();self.assertIn(name,self.docker.volumes)
        self.assertFalse(any(args[:2]==['volume','rm']for args in self.docker.mutations()))
    def test_engine_anonymous_marker_cannot_adopt_preexisting_volume(self):
        name=hashlib.sha256(b'anonymous-pg15').hexdigest()
        self.docker.volumes[name]={'Name':name,'Driver':'local','Labels':{'com.docker.volume.anonymous':''},'Options':None}
        (self.output/'radix-armed.json').unlink();self.custody.arm();self.launch(['postgres_db'])
        with self.assertRaisesRegex(ValueError,'pre-existing'):self.custody.observe()
        self.cleanup_failure();self.assertIn(name,self.docker.volumes)

    def test_failed_pg_removal_preserves_its_volume_but_cleans_other_services(self):
        self.launch();self.custody.observe();pg=self.row('postgres_db')['Id'];self.docker.deny_rm.add(pg)
        self.cleanup_failure();self.assertEqual(set(self.docker.containers),{pg})
        self.assertTrue(self.docker.volumes)
        self.assertFalse(any(args[:2]==['volume','rm']for args in self.docker.mutations()))
    def test_replaced_network_id_is_never_removed(self):
        self.launch();self.custody.observe();old=next(iter(self.docker.networks));row=self.docker.networks.pop(old)
        row['Id']=hashlib.sha256(b'replaced-network').hexdigest();self.docker.networks[row['Id']]=row
        self.cleanup_failure();self.assertEqual(self.docker.containers,{})
        self.assertTrue(self.docker.networks)
        self.assertFalse(any(args[:2]==['network','rm']for args in self.docker.mutations()))
    def test_changed_volume_binding_cannot_authorize_other_volume_removal(self):
        self.launch();self.custody.observe();record=self.output/'radix-volume.json';value=json.loads(record.read_text())
        value['container_id']=hashlib.sha256(b'foreign-pg').hexdigest();record.write_text(json.dumps(value))
        self.cleanup_failure();self.assertTrue(self.docker.volumes)
        self.assertFalse(any(args[:2]==['volume','rm']for args in self.docker.mutations()))
    def test_constructor_rejects_unapproved_source_or_native_image_even_with_valid_sha_shape(self):
        for field in('source','id'):
            fixture=copy.deepcopy(self.fixture);fixture['images']['fullnode'][field]='foreign:latest'if field=='source'else'sha256:'+('ef'*32)
            with self.subTest(field=field),self.assertRaisesRegex(ValueError,'five Radix images'):
                m.Custody(self.case,24680,'linux-ticks:123',fixture,self.output,self.docker)
    def test_readonly_mount_or_extra_mount_never_passes_readiness(self):
        self.launch(['postgres_db']);self.row('postgres_db')['Mounts'][0]['RW']=False
        with self.assertRaisesRegex(ValueError,'volume'):self.custody.observe()
    def test_disappearance_requires_exact_source_marker(self):
        self.launch();self.custody.observe();del self.docker.containers[self.row('fullnode')['Id']]
        with self.assertRaisesRegex(ValueError,'disappeared'):self.custody.observe()
        self.stop_marker();self.custody.observe()
    def test_foreign_stop_marker_cannot_hide_service_disappearance(self):
        self.launch();self.custody.observe();self.stop_marker();p=self.case/'radix-localnet/stopping.json';value=json.loads(p.read_text());value['parent_pid']+=1;p.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError,'stop intent'):self.custody.observe()
    def test_captured_volume_bytes_survive_later_shrink_or_unrelated_deletions(self):
        self.launch();self.volume_size=900000;self.custody.observe()
        name=self.row('postgres_db')['Mounts'][0]['Name'];self.assertEqual(self.volume_calls,[name])
        self.volume_size=10;self.custody.observe()
        record=json.loads((self.output/'radix-writable.json').read_text())
        self.assertEqual(record['maximum_volume_bytes'],900000);self.assertEqual(record['latest_volume_observation']['size_bytes'],10)
        self.assertEqual(m.resource_charge(0,100,10*m.GIB,11*m.GIB,200,900000)[1],900300+2*m.GIB)
    def test_unavailable_volume_observation_cannot_be_credited_as_zero(self):
        self.launch();self.custody.volume_sample=lambda name:(_ for _ in ()).throw(ValueError('unavailable actual size'))
        with self.assertRaisesRegex(ValueError,'unavailable actual size'):self.custody.observe()
        self.assertFalse((self.output/'radix-writable.json').exists())
    def test_ram_caps_and_real_volume_filesystem_decline_are_charged_without_wait_credit(self):
        self.assertEqual(m.resource_charge(123,1000,10*m.GIB,10*m.GIB,2000),(123+4864*m.MIB,3000+2*m.GIB))
        self.assertEqual(m.resource_charge(123,1000,10*m.GIB,7*m.GIB,2000),(123+4864*m.MIB,5*m.GIB))
        for values in((True,1,1,1,1),(1,-1,1,1,1)):
            with self.assertRaises(ValueError):m.resource_charge(*values)



    def vanish_on_inspect(self, service='data_aggregator_image'):
        self.launch();self.custody.observe();target=self.custody.seen[service];original=self.custody.call
        def call(arguments,*args,**kwargs):
            if arguments[:3]==['container','inspect','--size'] and arguments[-1]==target:
                self.docker.containers.pop(target,None);return None
            return original(arguments,*args,**kwargs)
        self.custody.call=call
        return target

    def test_list_inspect_race_retains_exact_target_all_seen_ready_and_absent_intent(self):
        target=self.vanish_on_inspect()
        with self.assertRaisesRegex(ValueError,'Radix object vanished during inspection'):self.custody.observe()
        report=self.custody.public_observation()['missing_inspection']
        self.assertEqual(report['listed_container_id'],target);self.assertEqual(report['previously_captured_services'],['data_aggregator_image'])
        self.assertEqual(report['captured_CIDs'],self.custody.seen);self.assertEqual(set(report['readiness_passed_services']),set(m.SERVICES))
        self.assertEqual(report['Source_stop_intent'],{'status':'absent','binding_matches':False});self.assertFalse(report['native_or_cleanup_authority'])
        self.assertGreaterEqual(report['completed_monotonic_ns'],report['observed_monotonic_ns'])
        report['captured_CIDs'].clear();self.assertEqual(len(self.custody.public_observation()['missing_inspection']['captured_CIDs']),5)

    def test_authenticated_list_inspect_disappearance_with_fresh_exact_stop_intent_completes_observation_only(self):
        self.vanish_on_inspect();self.stop_marker();maximum=self.custody.maximum_writable_bytes
        self.custody.observe()
        report=self.custody.public_observation()['missing_inspection']
        self.assertEqual(report['Source_stop_intent'],{'status':'present_and_exactly_bound','binding_matches':True});self.assertFalse(report['native_or_cleanup_authority'])
        self.assertEqual(self.custody.maximum_writable_bytes,maximum);self.assertEqual(set(self.custody.ready),set(m.SERVICES));self.assertFalse(self.docker.mutations())

    def test_unbound_or_private_stop_record_never_exports_body_or_masks_missing_guard(self):
        self.vanish_on_inspect('fullnode');self.stop_marker();path=self.case/'radix-localnet/stopping.json';value=json.loads(path.read_bytes());value['PRIVATE_SENTINEL']='authorization secret';path.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError,'Radix object vanished during inspection'):self.custody.observe()
        report=self.custody.public_observation()['missing_inspection'];self.assertEqual(report['Source_stop_intent'],{'status':'invalid_or_unavailable','binding_matches':False,'error_class':'ValueError'})
        self.assertNotIn('PRIVATE_SENTINEL',json.dumps(report));self.assertNotIn('authorization',json.dumps(report))

    def test_diagnostic_exception_preserves_original_missing_inspection_failure(self):
        self.vanish_on_inspect()
        from unittest import mock
        with mock.patch.object(self.custody,'missing_inspection',side_effect=RuntimeError('PRIVATE_SENTINEL')):
            with self.assertRaisesRegex(ValueError,'Radix object vanished during inspection'):self.custody.observe()
        report=self.custody.public_observation()['missing_inspection'];self.assertEqual(report['collection_status'],'unavailable');self.assertNotIn('PRIVATE_SENTINEL',json.dumps(report))

    def test_unseen_list_target_is_not_misattributed_to_last_successful_service(self):
        self.launch(['fullnode']);self.custody.observe();unknown='f'*64;old_ids=self.custody.ids;old_inspect=self.custody.inspect_container
        self.custody.ids=lambda kind,*a,**k:[unknown] if kind=='container' else old_ids(kind,*a,**k)
        self.custody.inspect_container=lambda cid,*a,**k:None if cid==unknown else old_inspect(cid,*a,**k)
        with self.assertRaisesRegex(ValueError,'Radix object vanished during inspection'):self.custody.observe()
        report=self.custody.public_observation()['missing_inspection'];self.assertEqual(report['listed_container_id'],unknown);self.assertEqual(report['previously_captured_services'],[]);self.assertEqual(self.custody.public_observation()['last_inspected_service'],'fullnode')


    def test_unknown_listed_CID_remains_refused_even_with_exact_bound_stop_marker(self):
        self.launch(['fullnode']);self.custody.observe();self.stop_marker();unknown='f'*64
        self.custody.ids=lambda kind,*a,**k:[unknown]if kind=='container'else[]
        self.custody.inspect_container=lambda *a,**k:None
        with self.assertRaisesRegex(ValueError,'Radix object vanished during inspection'):self.custody.observe()
        report=self.custody.public_observation()['missing_inspection'];self.assertEqual(report['Source_stop_intent']['binding_matches'],True);self.assertEqual(report['previously_captured_services'],[]);self.assertFalse(self.docker.mutations())

    def test_missing_inspect_requires_fresh_marker_not_the_diagnostic_cached_true(self):
        self.vanish_on_inspect('fullnode')
        from unittest import mock
        with mock.patch.object(self.custody,'stopping',side_effect=[True]+[False]*8)as stopping:
            with self.assertRaisesRegex(ValueError,'Radix object vanished during inspection'):self.custody.observe()
            self.assertEqual(stopping.call_count,2)
        self.assertTrue(self.custody.public_observation()['missing_inspection']['Source_stop_intent']['binding_matches'])

    def test_fresh_stop_validation_error_preserves_missing_guard_and_never_acts_on_Docker(self):
        self.vanish_on_inspect('fullnode')
        from unittest import mock
        with mock.patch.object(self.custody,'stopping',side_effect=[True,ValueError('PRIVATE_MARKER_REPLACED')]):
            with self.assertRaisesRegex(ValueError,'Radix object vanished during inspection'):self.custody.observe()
        self.assertFalse(self.docker.mutations());self.assertNotIn('PRIVATE_MARKER_REPLACED',json.dumps(self.custody.public_observation()))

    def test_allowed_inspect_disappearance_still_executes_existing_network_guard(self):
        self.vanish_on_inspect();self.stop_marker();next(iter(self.docker.networks.values()))['Internal']=False
        with self.assertRaisesRegex(ValueError,'Foreign or external Radix network'):self.custody.observe()
        self.assertFalse(self.docker.mutations())

    def test_actual_pinned_Rust_stop_intent_is_published_before_compose_teardown(self):
        source=Path(__file__).resolve().parents[2]/'rust/main/utils/run-locally/src/external_agents/radix_fixture.rs';body=source.read_text();stop=body[body.index('    pub fn stop(&mut self) -> Result<()> {'):body.index('impl Drop for Localnet')]
        self.assertIn('"project":self.project,"parent_pid":std::process::id(),"containers":before',stop)
        self.assertLess(stop.index('publish_stop_intent(&intent_path, &intent)?'),stop.index('self.compose(&["down", "--timeout", "15", "--volumes"], 60)?'))
        self.assertLess(stop.index('self.compose(&["down"'),stop.index('self.require_no_networks_or_volumes()?'))


class ResourceFailureDiagnostics(unittest.TestCase):
    def failure(self, **changed):
        values={'host_ram':123,'case_bytes':5*m.GIB,'initial_free':100*m.GIB,'current_free':99*m.GIB,'writable_bytes':600000000,'volume_bytes':1100000000,'observed_ns':100,'deadline_ns':200}
        values.update(changed);values['charged_ram'],values['charged_disk']=m.resource_charge(*[values[k]for k in ['host_ram','case_bytes','initial_free','current_free','writable_bytes','volume_bytes']]);return values
    def test_actual_formula_components_and_four_independent_failed_conjuncts(self):
        for changes,key in [({},'disk_within_limit'),({'case_bytes':0,'writable_bytes':0,'volume_bytes':0,'host_ram':4*m.GIB},'RAM_within_limit'),({'case_bytes':0,'writable_bytes':0,'volume_bytes':0,'observed_ns':200},'before_original_deadline'),({'case_bytes':0,'writable_bytes':0,'volume_bytes':0,'initial_free':5*m.GIB,'current_free':5*m.GIB},'host_free_above_floor')]:
            values=self.failure(**changes);row=m.public_resource_failure(**values);self.assertFalse(row['conjuncts'][key]);self.assertEqual(row['charged_disk_bytes'],max(values['case_bytes']+values['writable_bytes']+values['volume_bytes'],max(0,values['initial_free']-values['current_free']))+2*m.GIB);self.assertEqual(row['charged_RAM_bytes'],values['host_ram']+sum(v[0]for v in m.SERVICES.values())*m.MIB+m.GIB);self.assertEqual(row['agent_PG_tmpfs_reservation_bytes'],2*m.GIB)
    def test_mismatched_negative_boolean_unbounded_and_successful_values_refuse(self):
        values=self.failure()
        for key,value in [('charged_disk',values['charged_disk']+1),('case_bytes',-1),('volume_bytes',True),('initial_free',2**63)]:
            changed=dict(values);changed[key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):m.public_resource_failure(**changed)
        with self.assertRaisesRegex(ValueError,'actual failing conjunction'):m.public_resource_failure(**self.failure(case_bytes=0,writable_bytes=0,volume_bytes=0))
    def guard(self,values,diagnostic=None):
        import ast
        from types import SimpleNamespace as N
        owner=Path(__file__).with_name('native_case_owner.py');tree=ast.parse(owner.read_text());fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='main');loop=next(n for n in ast.walk(fn)if isinstance(n,ast.While));start=next(i for i,n in enumerate(loop.body)if isinstance(n,ast.Assign)and any(isinstance(v,ast.Name)and v.id=='resource_observed_ns'for v in n.targets));nodes=loop.body[start:start+4];self.assertEqual(len(nodes),4)
        ns={'time':N(monotonic_ns=lambda:values['observed_ns']),'deadline_ns':values['deadline_ns'],'plan':{'maximum_case_allocated_bytes':8*m.GIB},'ram':values['charged_ram'],'disk':values['charged_disk'],'free':values['current_free'],'GIB':m.GIB,'rx_resources':N(public_resource_failure=diagnostic or m.public_resource_failure),'owned':{1:{'rss_bytes':values['host_ram']}},'radix_case_allocated':values['case_bytes'],'initial_free':values['initial_free'],'writable':values['writable_bytes'],'volume_bytes':values['volume_bytes'],'result':{},'require':m.require}
        return ns,compile(ast.Module(body=nodes,type_ignores=[]),str(owner),'exec')
    def test_actual_owner_retains_failing_iteration_before_raise_not_last_success(self):
        values=self.failure();ns,code=self.guard(values)
        with self.assertRaisesRegex(ValueError,'Original native case deadline/resource guard'):exec(code,ns)
        self.assertIn('radix_resource_limit_failure',ns['result']);row=ns['result']['radix_resource_limit_failure'];self.assertEqual(row['charged_disk_bytes'],values['charged_disk']);self.assertFalse(row['conjuncts']['disk_within_limit']);self.assertEqual(row['observed_monotonic_ns'],100)
        # Simulated previous successful sample is deliberately different and
        # never substituted for values computed by this failing iteration.
        self.assertNotEqual(row['charged_disk_bytes'],4*m.GIB-3126128)
    def test_success_guard_and_diagnostic_failure_preserve_original_decision(self):
        good=self.failure(case_bytes=0,writable_bytes=0,volume_bytes=0);ns,code=self.guard(good,lambda *args:(_ for _ in()).throw(AssertionError('Success may not call diagnostic')));exec(code,ns);self.assertEqual(ns['result'],{})
        ns,code=self.guard(self.failure(),lambda *args:(_ for _ in()).throw(RuntimeError('private sentinel not copied')))
        with self.assertRaisesRegex(ValueError,'Original native case deadline/resource guard'):exec(code,ns)
        self.assertEqual(ns['result'],{'radix_resource_diagnostic_error':{'type':'RuntimeError'}})
    def test_native8_disk_boundary_retains_RAM_free_and_original_deadline(self):
        good=self.failure(case_bytes=6*m.GIB,writable_bytes=0,volume_bytes=0)
        ns,code=self.guard(good);exec(code,ns);self.assertEqual(ns['result'],{})
        for changes,key in [({'case_bytes':6*m.GIB+1},'disk_within_limit'),({'host_ram':8*m.GIB},'RAM_within_limit'),({'current_free':6*m.GIB-1,'initial_free':6*m.GIB-1},'host_free_above_floor'),({'observed_ns':200},'before_original_deadline')]:
            values=self.failure(case_bytes=6*m.GIB,writable_bytes=0,volume_bytes=0,**changes) if 'case_bytes' not in changes else self.failure(writable_bytes=0,volume_bytes=0,**changes)
            ns,code=self.guard(values)
            with self.subTest(key=key),self.assertRaisesRegex(ValueError,'Original native'):exec(code,ns)
            self.assertFalse(ns['result']['radix_resource_limit_failure']['conjuncts'][key]);self.assertEqual(ns['result']['radix_resource_limit_failure']['limits']['disk_bytes'],8*m.GIB)

    def test_closed_public_values_privacy_and_record_bound(self):
        row=m.public_resource_failure(**self.failure());wire=json.dumps(row);self.assertLessEqual(len(wire.encode()),4096)
        def walk(value):
            if type(value)is dict:
                for k,v in value.items():self.assertFalse(any(secret in k.lower()for secret in ['path','argv','environment','config','inspect','address','token','key']));walk(v)
            elif type(value)is str:self.assertEqual(value,'public-radix-resource-limit-failure')
            else:self.assertIn(type(value),[int,bool])
        walk(row);self.assertFalse(row['native_or_timing_credit'])



class PublisherControls(unittest.TestCase):
    # Reuse only fixture setup, never duplicate inherited test execution.
    setUp = Controls.setUp
    new = Controls.new
    sample_volume = Controls.sample_volume
    launch = Controls.launch
    stop_marker = Controls.stop_marker
    def ready_snapshot(self):
        self.launch();self.custody.observe()
        network=self.custody.publisher_network;network['Driver']='bridge';network['Containers']={}
        self.processes={24680:{'pid':24680,'start':'linux-ticks:123','state':'S'}}
        for index,service in enumerate(m.PUBLISH_ROUTES,1):
            row=self.custody.publisher_rows[service];pid=700+index
            row['State']['Pid']=pid;self.processes[pid]={'pid':pid,'start':'linux-ticks:'+str(900+index),'state':'S'}
            address='172.18.0.'+str(index+1);endpoint=hashlib.sha256(service.encode()).hexdigest()
            row['NetworkSettings']['Networks'][self.custody.network]={'NetworkID':network['Id'],'EndpointID':endpoint,'IPAddress':address}
            network['Containers'][row['Id']]={'EndpointID':endpoint,'IPv4Address':address+'/16'}
        return self.custody.publisher_targets(self.processes.get)

    def publisher(self):
        from unittest import mock
        self.ready_snapshot()
        with mock.patch.object(m.time,'monotonic_ns',return_value=10):
            publisher=m.LoopbackPublisher(self.custody,self.processes.get,lambda:False,1000)
        publisher.targets=self.custody.publisher_targets(self.processes.get)
        return publisher

    def socket(self, incoming=(), sent_limit=65536):
        class Stream:
            def __init__(self):self.incoming=list(incoming);self.sent=bytearray();self.shutdowns=[];self.closed=False;self.options=[];self.accepted=[]
            def setblocking(self,value):self.blocking=value
            def setsockopt(self,*value):self.options.append(value)
            def bind(self,value):self.bound=value
            def listen(self,value):self.backlog=value
            def close(self):self.closed=True
            def connect_ex(self,value):self.target=value;return 0
            def getsockopt(self,*args):return 0
            def accept(self):return self.accepted.pop(0)
            def send(self,value):n=min(sent_limit,len(value));self.sent.extend(value[:n]);return n
            def recv(self,n):
                if not self.incoming:raise BlockingIOError()
                value=self.incoming[0][:n];self.incoming[0]=self.incoming[0][n:]
                if not self.incoming[0]:self.incoming.pop(0)
                return value
            def shutdown(self,kind):self.shutdowns.append(kind)
        return Stream()

    def step(self,publisher,readable=(),writable=()):
        from unittest import mock
        with mock.patch.object(m.time,'monotonic_ns',return_value=10),mock.patch.object(m.select,'select',return_value=(list(readable),list(writable),[])):
            publisher._step()

    def connection(self,left,right,**changes):
        return {'sockets':(left,right),'connecting':False,'buffers':[b'',b''],'eof':[False,False],'shutdown':[False,False],**changes}

    def test_publisher_requires_current_full_custody_before_any_bind(self):
        from unittest import mock
        with mock.patch.object(m.time,'monotonic_ns',return_value=10):p=m.LoopbackPublisher(self.custody,lambda pid:None,lambda:False,1000)
        with mock.patch.object(m.socket,'socket') as factory:p.observe();factory.assert_not_called()
        self.assertIsNone(p.targets)
        targets=self.ready_snapshot();self.assertEqual(set(targets),set(m.PUBLISH_ROUTES))
        self.assertEqual({(v[0],v[1])for v in targets.values()},{(self.custody.seen[n],self.fixture['images'][n]['id'])for n in m.PUBLISH_ROUTES})

    def test_publisher_rejects_foreign_network_endpoint_pid_caps_or_image_without_io(self):
        from unittest import mock
        self.ready_snapshot()
        mutations=[lambda:setattr(self.custody,'publisher_network',{**self.custody.publisher_network,'Internal':False}),lambda:self.custody.publisher_network['Containers'].update({'f'*64:{}}),lambda:self.custody.publisher_rows['fullnode']['NetworkSettings']['Networks'][self.custody.network].update(EndpointID='f'*64),lambda:self.custody.publisher_rows['fullnode']['State'].update(Pid=True),lambda:self.custody.publisher_rows['fullnode']['Image'].replace('a','b'),lambda:self.custody.publisher_rows['fullnode']['HostConfig'].update(Privileged=True)]
        # The image mutation is explicit below; each iteration starts from an
        # independent snapshot, not from the prior negative's changed context.
        rows=copy.deepcopy(self.custody.publisher_rows);network=copy.deepcopy(self.custody.publisher_network)
        for index,mutate in enumerate(mutations):
            self.custody.publisher_rows=copy.deepcopy(rows);self.custody.publisher_network=copy.deepcopy(network)
            if index==4:self.custody.publisher_rows['fullnode']['Image']='sha256:'+'f'*64
            else:mutate()
            with self.subTest(index=index),mock.patch.object(m.socket,'socket') as factory,self.assertRaises((ValueError,KeyError)):
                self.custody.publisher_targets(self.processes.get)
            factory.assert_not_called()

    def test_publisher_binds_only_two_exclusive_fixed_routes_and_cleans_partial_bind(self):
        from unittest import mock
        import types
        self.ready_snapshot();streams=[self.socket(),self.socket()];thread=types.SimpleNamespace(start=mock.Mock(),join=mock.Mock(),is_alive=lambda:False)
        with mock.patch.object(m.time,'monotonic_ns',return_value=10):p=m.LoopbackPublisher(self.custody,self.processes.get,lambda:False,1000)
        with mock.patch.object(m.socket,'socket',side_effect=streams),mock.patch.object(m.threading,'Thread',return_value=thread),mock.patch.object(m.time,'monotonic_ns',return_value=10):p.observe()
        self.assertEqual([s.bound for s in streams],[('127.0.0.1',3333),('127.0.0.1',5308)]);self.assertTrue(all(s.options==[]for s in streams));thread.start.assert_called_once()
        p.stop_event.set();p._run();receipt=p.close(2**63/1e9);self.assertTrue(receipt['all_owned_sockets_closed']);self.assertTrue(all(s.closed for s in streams));thread.join.assert_called_once()
        self.assertNotIn('172.18',json.dumps(receipt));self.assertIs(receipt['native_or_parent_wait_credit'],False)
        self.custody.publisher_rows=copy.deepcopy(self.custody.publisher_rows)
        first,second=self.socket(),self.socket();second.bind=mock.Mock(side_effect=OSError('PRIVATE_BIND_SENTINEL'))
        with mock.patch.object(m.time,'monotonic_ns',return_value=10):failed=m.LoopbackPublisher(self.custody,self.processes.get,lambda:False,1000)
        with mock.patch.object(m.socket,'socket',side_effect=[first,second]),mock.patch.object(m.time,'monotonic_ns',return_value=10),self.assertRaises(OSError):failed.observe()
        self.assertTrue(first.closed and second.closed);self.assertFalse(failed.listeners)

    def test_publisher_transparent_partial_write_and_half_close_preserves_original_bytes(self):
        p=self.publisher();left=self.socket([b'POST /private HTTP/1.1\r\n\r\n{}',b''],2);right=self.socket([b'HTTP/1.1 200 OK\r\n\r\nPRIVATE_BODY',b''],3)
        row=self.connection(left,right);p.connections=[row]
        self.step(p,[left,right]);self.assertEqual(row['buffers'],[b'HTTP/1.1 200 OK\r\n\r\nPRIVATE_BODY',b'POST /private HTTP/1.1\r\n\r\n{}'])
        for _ in range(30):
            if not p.connections:break
            self.step(p,[left,right],[left,right])
        self.assertEqual(bytes(left.sent),b'HTTP/1.1 200 OK\r\n\r\nPRIVATE_BODY');self.assertEqual(bytes(right.sent),b'POST /private HTTP/1.1\r\n\r\n{}')
        self.assertEqual(left.shutdowns,[m.socket.SHUT_WR]);self.assertEqual(right.shutdowns,[m.socket.SHUT_WR]);self.assertTrue(left.closed and right.closed);self.assertFalse(p.connections)

    def test_publisher_buffer_and_connection_limits_refuse_without_reply_or_arbitrary_route(self):
        from unittest import mock
        p=self.publisher();left=self.socket([b'x'*70000]);right=self.socket();row=self.connection(left,right);p.connections=[row]
        self.step(p,[left]);self.assertEqual(len(row['buffers'][1]),65536)
        def selected(reads,writes,*rest):self.assertNotIn(left,reads);return [],[],[]
        with mock.patch.object(m.select,'select',side_effect=selected),mock.patch.object(m.time,'monotonic_ns',return_value=10):p._step()
        p.connections=[self.connection(self.socket(),self.socket())for _ in range(32)]
        listener=self.socket();rejected=self.socket();listener.accepted=[(rejected,('127.0.0.1',123))];p.listeners={listener:'fullnode'}
        with mock.patch.object(m.socket,'socket') as factory:self.step(p,[listener]);factory.assert_not_called()
        self.assertTrue(rejected.closed);self.assertEqual(rejected.sent,b'');self.assertEqual(p.refused,1)
        p._close_sockets();self.assertFalse(p.listeners or p.connections)

    def test_publisher_connect_is_exact_leased_target_and_birth_rechecked_after_connect(self):
        from unittest import mock
        p=self.publisher();listener=self.socket();left=self.socket();right=self.socket();listener.accepted=[(left,('127.0.0.1',42))];p.listeners={listener:'gateway_api_image'}
        with mock.patch.object(m.socket,'socket',return_value=right):self.step(p,[listener])
        self.assertEqual(right.target,('172.18.0.3',8080));self.assertEqual(p.maximum_active,1);p._close_sockets()
        p=self.publisher();listener=self.socket();left=self.socket();right=self.socket();listener.accepted=[(left,('127.0.0.1',42))];p.listeners={listener:'fullnode'}
        def replaced(target):self.processes[701]['start']='linux-ticks:999';return 0
        right.connect_ex=replaced
        with mock.patch.object(m.socket,'socket',return_value=right),self.assertRaisesRegex(ValueError,'birth changed'):self.step(p,[listener])
        self.assertTrue(left.closed and right.closed);self.assertEqual(left.sent+right.sent,b'');p._close_sockets()

    def test_publisher_backend_refusal_is_real_closed_connection_not_readiness(self):
        from unittest import mock
        p=self.publisher();listener=self.socket();left=self.socket();right=self.socket();listener.accepted=[(left,('127.0.0.1',42))];p.listeners={listener:'fullnode'}
        right.connect_ex=lambda target:m.errno.ECONNREFUSED
        with mock.patch.object(m.socket,'socket',return_value=right):self.step(p,[listener])
        self.assertTrue(left.closed and right.closed);self.assertFalse(p.connections);self.assertEqual(left.sent+right.sent,b'');self.assertIsNone(p.error);p._close_sockets()

    def test_publisher_deadline_cancel_stopping_and_recycled_birth_stop_before_io(self):
        from unittest import mock
        for kind in ['deadline','cancel','stopping','birth']:
            p=self.publisher();stream=self.socket();p.listeners={stream:'fullnode'}
            if kind=='cancel':p.cancelled=lambda:True
            if kind=='stopping':self.stop_marker()
            if kind=='birth':self.processes[701]['start']='linux-ticks:999'
            now=1000 if kind=='deadline'else 10
            with self.subTest(kind=kind),mock.patch.object(m.select,'select') as select,mock.patch.object(m.time,'monotonic_ns',return_value=now):p._run();select.assert_not_called()
            self.assertTrue(stream.closed);self.assertFalse(p.connections or p.listeners);self.assertTrue(p.finished)
            self.assertEqual(p.error is not None,kind in {'deadline','birth'})
            if kind=='stopping':(self.case/'radix-localnet/stopping.json').unlink()

    def test_failed_custody_refresh_revokes_live_old_endpoint_before_any_more_io(self):
        from unittest import mock
        for failure in ['changed','missing','inspect_error']:
            p=self.publisher();left=self.socket([b'PRIVATE_OLD_TARGET_BYTES']);right=self.socket();p.connections=[self.connection(left,right)]
            original=ValueError('PRIVATE_CUSTODY_REPLACEMENT')
            changed=dict(p.targets)
            changed['fullnode']=(('f'*64),*changed['fullnode'][1:])
            with mock.patch.object(self.custody,'publisher_targets',side_effect=original if failure=='inspect_error'else None,return_value=None if failure=='missing'else changed),self.assertRaises(ValueError)as caught:p.observe()
            if failure=='inspect_error':self.assertIs(caught.exception,original)
            self.assertTrue(p.stop_event.is_set());self.assertEqual(p.error,'ValueError')
            # Old process births still match. Revocation, not PID disappearance,
            # must stop an already-entered pump batch before select or send.
            with mock.patch.object(m.select,'select',return_value=([],[],[]))as select,mock.patch.object(m.time,'monotonic_ns',return_value=10),self.assertRaises(m.PublisherStopped):p._step()
            select.assert_not_called();self.assertEqual(left.sent+right.sent,b'');p._run();self.assertTrue(left.closed and right.closed)

    def test_actual_worker_exception_revoke_stops_live_old_pump_even_if_event_reporting_fails(self):
        import ast
        from unittest import mock
        p=self.publisher();left=self.socket([b'PRIVATE_OLD_TARGET']);right=self.socket();p.connections=[self.connection(left,right)]
        owner_path=Path(m.__file__).with_name('native_case_owner.py');tree=ast.parse(owner_path.read_text());worker=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='worker')
        handler=next(n for n in ast.walk(worker)if isinstance(n,ast.ExceptHandler)and n.name=='failure'and any(isinstance(n,ast.Assign)and any(ast.unparse(t)=="result['error']"for t in n.targets)for n in n.body))
        original=ValueError('PRIVATE_CUSTODY_PRIMARY');result={}
        with mock.patch.object(p.stop_event,'set',side_effect=RuntimeError('PRIVATE_EVENT_REPORT')):
            env={'radix_publisher':p,'failure':original,'result':result};exec(compile(ast.Module(body=handler.body,type_ignores=[]),'<actual-owner-custody-failure>','exec'),env)
        self.assertTrue(p.revoked);self.assertIs(env['error'],original);self.assertEqual(result['error']['message'],'PRIVATE_CUSTODY_PRIMARY')
        with mock.patch.object(m.select,'select',return_value=([],[],[]))as select,mock.patch.object(m.time,'monotonic_ns',return_value=10),self.assertRaises(m.PublisherStopped):p._step()
        select.assert_not_called();self.assertEqual(left.sent+right.sent,b'');p._run();self.assertTrue(left.closed and right.closed)

    def test_publisher_close_error_still_closes_other_owned_sockets_and_cannot_claim_absence(self):
        from unittest import mock
        p=self.publisher();left=self.socket();right=self.socket();listener=self.socket()
        left.close=mock.Mock(side_effect=OSError('PRIVATE_CLOSE_REASON'));p.listeners={listener:'fullnode'};p.connections=[self.connection(left,right)]
        p.stop_event.set();p._run();receipt=p.close(1)
        self.assertTrue(listener.closed and right.closed);self.assertIs(receipt['all_owned_sockets_closed'],False);self.assertEqual(receipt['error_class'],'OSError');self.assertNotIn('PRIVATE',json.dumps(receipt))
        with self.assertRaisesRegex(ValueError,'publisher failed'):p.check()

    def test_publisher_pending_connect_status_is_checked_before_any_application_forward(self):
        p=self.publisher();left=self.socket([b'PRIVATE_REQUEST']);right=self.socket();row=self.connection(left,right,connecting=True);p.connections=[row]
        self.step(p,[left]);self.assertTrue(row['connecting']);self.assertEqual(left.sent+right.sent,b'')
        right.getsockopt=lambda *args:m.errno.ECONNREFUSED
        self.step(p,[],[right]);self.assertFalse(p.connections);self.assertTrue(left.closed and right.closed);self.assertEqual(left.sent+right.sent,b'')

    def test_publisher_changed_lease_is_hard_refusal_and_primary_error_cleanup_still_closes(self):
        from unittest import mock
        p=self.publisher();p.targets['fullnode']=('f'*64,*p.targets['fullnode'][1:])
        with self.assertRaisesRegex(ValueError,'endpoint changed'):p.observe()
        p=self.publisher();stream=self.socket();p.listeners={stream:'fullnode'};p._step=mock.Mock(side_effect=OSError('PRIVATE_URL_TOKEN_BODY'))
        p._run();receipt=p.close(1);self.assertTrue(stream.closed);self.assertEqual(receipt['error_class'],'OSError');self.assertNotIn('PRIVATE',json.dumps(receipt))
        with self.assertRaisesRegex(ValueError,'publisher failed'):p.check()


if __name__=='__main__':unittest.main()
