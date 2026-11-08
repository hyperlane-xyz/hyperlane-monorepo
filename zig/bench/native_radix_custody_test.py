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


if __name__=='__main__':unittest.main()
