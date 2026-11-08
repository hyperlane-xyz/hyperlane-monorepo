"""Actual adapter methods, fake Engine DTOs; no socket/process/native effects."""
from pathlib import Path
import copy
import ast
import importlib.util
import json
from types import SimpleNamespace
import sys
import tempfile
import unittest
from unittest import mock

spec=importlib.util.spec_from_file_location('paired_pg',Path(__file__).with_name('paired_linux_postgres.py'));api=importlib.util.module_from_spec(spec);spec.loader.exec_module(api)
def audit(name,args):
    if name in {'socket.__new__','subprocess.Popen','os.system','os.fork','os.posix_spawn','ctypes.dlopen'}:raise AssertionError('Unexpected external effect: '+name)
sys.addaudithook(audit)

RealClient=api.Client

class Original:
    def __init__(self,image,migration_bin,output):self.image=image;self.migration_bin=migration_bin;self.output=output;self.started=False
    def prepare(self,database,log_path):return ('unchanged',database,log_path)

class Engine:
    def __init__(self):
        self.receipt={'actual_wait_count':0,'failure_count':0,'chain_sha256':'00'*32,'latest':[]};self.row=None;self.calls=[];self.fail_create=False;self.foreign=False;self.inspect_error=False;self.fail_stop=False;self.server_exit=0;self.fail_wait=False;self.fail_remove=False;self.fail_sql=False;self.cap_change=None;self.map_change=None;self.deadline=None
    def call(self,args,deadline,timeout=180,missing=False,readiness=False):
        self.calls.append(list(args));self.receipt['actual_wait_count']+=1
        if args[:2]==['image','inspect']:return json.dumps([{'Id':api.IMAGE_ID,'Os':'linux','Architecture':'amd64','RepoDigests':[api.IMAGE_REFERENCE],'Config':{'Labels':None}}])
        if args[:2]==['container','create']:
            labels={}
            for i,x in enumerate(args):
                if x=='--label':k,v=args[i+1].split('=',1);labels[k]=v
            self.row={'Id':'ab'*32,'Name':'/'+args[args.index('--name')+1],'Image':api.IMAGE_ID,'Config':{'Labels':labels,'User':'999:999'},'HostConfig':{'Memory':api.GIB,'MemorySwap':api.GIB,'NanoCpus':2_000_000_000,'PidsLimit':128,'NetworkMode':'bridge','Privileged':False,'CapDrop':['ALL'],'CapAdd':None,'SecurityOpt':['no-new-privileges:true'],'RestartPolicy':{'Name':'no'},'Tmpfs':{'/var/lib/postgresql/data':api.TMPFS},'Binds':None,'PortBindings':{'5432/tcp':[{'HostIp':'127.0.0.1','HostPort':''}]}},'State':{'Running':False,'OOMKilled':False},'NetworkSettings':{'Ports':{'5432/tcp':[{'HostIp':'127.0.0.1','HostPort':'45678'}]}}}
            if self.foreign:self.row['Config']['Labels']={}
            if self.cap_change:self.row['HostConfig'].update(self.cap_change)
            if self.map_change is not None:self.row['NetworkSettings']['Ports']=self.map_change
            if self.fail_create:raise TimeoutError('original-create-timeout')
            return self.row['Id']
        if args[:2]==['container','inspect']:
            if self.inspect_error:raise RuntimeError('inspect-unavailable')
            return None if self.row is None else json.dumps([copy.deepcopy(self.row)])
        if args[:2]==['container','start']:self.row['State']['Running']=True;return self.row['Id']
        if args[:2]==['container','exec']:
            if args[3]=='postgres':return 'postgres (PostgreSQL) 16.15 (Debian 16.15-1.pgdg13+2)'
            if args[3]=='psql':
                if self.fail_sql:raise RuntimeError('nonzero-original-sql')
                return '21'
            return 'accepting connections'
        if args[:2]==['container','stop']:
            if self.fail_stop:raise RuntimeError('stop-failed')
            self.row['State']['Running']=False;return self.row['Id']
        if args[:2]==['container','wait']:
            if self.fail_wait:raise RuntimeError('wait-failed')
            return str(self.server_exit)
        if args[:2]==['container','rm']:
            if self.fail_remove:raise RuntimeError('remove-failed')
            cid=self.row['Id'];self.row=None;return cid
        raise AssertionError(args)

class Controls(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='paired-pg-pure-');self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve();self.engine=Engine();patch=mock.patch.object(api,'Client',return_value=self.engine);patch.start();self.addCleanup(patch.stop)
        self.kw={'policy':dict(api.POLICY),'docker':{'not-executed':'fake'},'docker_config':self.root/'docker-config','token':'ab'*16,'receipts':self.root,'deadline':100,'cleanup_deadline':160}
        patch=mock.patch.object(api.time,'monotonic',return_value=1);patch.start();self.addCleanup(patch.stop)
        patch=mock.patch.object(api,'boot_id',return_value='00000000-0000-0000-0000-000000000001');patch.start();self.addCleanup(patch.stop)
        self.module=SimpleNamespace(Postgres=Original,chunks=lambda s:[s[:32],s[32:]])
    def make(self):return api.bind_postgres(self.module,**self.kw)('postgres:16.15','init-db',self.root)
    def test_original_constructor_prepare_are_inherited(self):
        cls=api.bind_postgres(self.module,**self.kw);self.assertIs(cls.__init__,Original.__init__);self.assertIs(cls.prepare,Original.prepare)
    def test_actual_scraper_constructor_and_prepare_body_are_unchanged(self):
        source=Path(__file__).with_name('scraper.py');tree=ast.parse(source.read_text());original=next(node for node in tree.body if isinstance(node,ast.ClassDef)and node.name=='Postgres')
        namespace={'os':SimpleNamespace(getpid=lambda:43210)};exec(compile(ast.Module(body=[original],type_ignores=[]),str(source),'exec'),namespace)
        base=namespace['Postgres'];module=SimpleNamespace(Postgres=base,chunks=self.module.chunks);bound=api.bind_postgres(module,**self.kw)
        self.assertIs(bound.__init__,base.__init__);self.assertIs(bound.prepare,base.prepare)
        instance=bound('postgres:16.15','actual-migration-pin',self.root)
        self.assertEqual(instance.name,'ziggy-scraper-bench-43210');self.assertEqual(instance.migration_bin,'actual-migration-pin');self.assertEqual(self.engine.calls,[])

    def test_actual_admission_SQL_and_normal_cleanup_use_immutable_CID(self):
        pg=self.make();self.assertIs(pg.__enter__(),pg);self.assertEqual(pg.port,45678);self.assertEqual(pg.sql('bench_0_0_zig','SELECT21'),'21');self.assertEqual(pg.prepare('db','log'),('unchanged','db','log'));pg.__exit__()
        receipt=json.loads((self.root/'paired-postgres-owner.json').read_text());self.assertTrue(receipt['passed']);self.assertTrue(receipt['container_absent']);self.assertFalse(receipt['daemon_parent_wait_credit']);self.assertEqual([r['operation']for r in receipt['steps']],['stop','wait','remove'])
        create=next(c for c in self.engine.calls if c[:2]==['container','create']);self.assertIn('--pull=never',create);self.assertEqual(create[-1],api.IMAGE_REFERENCE)
        for call in self.engine.calls:
            if call[:2]in [['container','start'],['container','stop'],['container','rm']]:self.assertEqual(call[-1],'ab'*32)
            if call[:2]==['container','exec']:self.assertEqual(call[2],'ab'*32)
        self.assertNotIn('SELECT21',(self.root/'paired-postgres-owner.json').read_text())
    def test_lost_create_timeout_captures_and_cleans_before_original_reraise(self):
        self.engine.fail_create=True
        with self.assertRaisesRegex(TimeoutError,'original-create-timeout'):self.make().__enter__()
        self.assertIsNone(self.engine.row);receipt=json.loads((self.root/'paired-postgres-owner.json').read_text());self.assertEqual(receipt['container_id'],'ab'*32);self.assertTrue(receipt['container_absent'])
    def test_lost_create_foreign_or_unreadable_identity_never_mutated(self):
        for key in ['foreign','inspect_error']:
            with self.subTest(key=key),tempfile.TemporaryDirectory(prefix='paired-pg-reject-')as directory:
                self.root=Path(directory).resolve();self.kw.update(receipts=self.root,docker_config=self.root/'docker-config');self.engine.row=None;self.engine.calls=[];self.engine.fail_create=True;setattr(self.engine,key,True)
                with self.assertRaises(TimeoutError):self.make().__enter__()
                self.assertFalse(any(c[:2]in [['container','stop'],['container','rm']]for c in self.engine.calls));setattr(self.engine,key,False)
    def test_bad_actual_port_and_privileged_caps_cannot_admit(self):
        for setting in ['map_change','cap_change']:
            with self.subTest(setting=setting),tempfile.TemporaryDirectory(prefix='paired-pg-caps-')as directory:
                self.root=Path(directory).resolve();self.kw.update(receipts=self.root,docker_config=self.root/'docker-config');setattr(self.engine,setting,{}if setting=='map_change'else{'Privileged':True})
                with self.assertRaises(RuntimeError):self.make().__enter__()
                self.assertFalse(any(c[:2]==['container','exec']and c[3]=='psql'for c in self.engine.calls));self.assertIsNone(self.engine.row);setattr(self.engine,setting,None)
    def test_stop_failure_still_attempts_remove_but_no_clean_verdict(self):
        pg=self.make().__enter__();self.engine.fail_stop=True
        with self.assertRaisesRegex(RuntimeError,'cleanup failed'):pg.__exit__()
        self.assertIsNone(self.engine.row);receipt=json.loads((self.root/'paired-postgres-owner.json').read_text());self.assertTrue(receipt['container_absent']);self.assertFalse(receipt['passed']);self.assertIn('stop_failed',receipt['cleanup_failures'])
    def test_server_exit_137_is_retained_before_failure_and_does_not_skip_remove(self):
        pg=self.make().__enter__();self.engine.server_exit=137
        with self.assertRaisesRegex(RuntimeError,'cleanup failed'):pg.__exit__()
        receipt=json.loads((self.root/'paired-postgres-owner.json').read_text());self.assertFalse(receipt['passed']);self.assertTrue(receipt['container_absent']);self.assertIn('wait_failed',receipt['cleanup_failures']);self.assertIsNone(self.engine.row)
        wait=next(row for row in receipt['steps']if row['operation']=='wait');self.assertEqual(wait['server_exit_code'],137);self.assertEqual(wait['container_id'],'ab'*32);self.assertFalse(wait['daemon_parent_wait_credit'])

    def test_late_oom_state_cannot_pass_even_with_zero_wait_reply(self):
        pg=self.make().__enter__();self.engine.row['State']['OOMKilled']=True
        with self.assertRaises(RuntimeError):pg.__exit__()
        receipt=json.loads((self.root/'paired-postgres-owner.json').read_text());self.assertTrue(receipt['container_absent']);self.assertFalse(receipt['passed']);self.assertIn('stop_failed',receipt['cleanup_failures'])

    def test_wait_error_does_not_skip_exact_remove_or_absence(self):
        pg=self.make().__enter__();self.engine.fail_wait=True
        with self.assertRaisesRegex(RuntimeError,'cleanup failed'):pg.__exit__()
        receipt=json.loads((self.root/'paired-postgres-owner.json').read_text());self.assertTrue(receipt['container_absent']);self.assertIn('wait_failed',receipt['cleanup_failures']);self.assertIsNone(self.engine.row)
        self.assertTrue(any(row[:2]==['container','rm']and row[-1]=='ab'*32 for row in self.engine.calls))

    def test_failed_cleanup_stays_failed_after_successful_outer_recovery(self):
        pg=self.make().__enter__();self.engine.fail_stop=True;self.engine.fail_remove=True
        with self.assertRaises(RuntimeError):pg.__exit__()
        prior=json.loads((self.root/'paired-postgres-owner.json').read_text())['cleanup_failures'];self.assertIsNotNone(self.engine.row)
        self.engine.fail_stop=False;self.engine.fail_remove=False;kw={k:v for k,v in self.kw.items()if k!='cleanup_deadline'};kw['deadline']=160
        with self.assertRaisesRegex(RuntimeError,'cleanup failed'):api.cleanup_all(**kw)
        receipt=json.loads((self.root/'paired-postgres-owner.json').read_text());self.assertIsNone(self.engine.row);self.assertTrue(receipt['container_absent']);self.assertFalse(receipt['passed']);self.assertEqual(receipt['cleanup_failures'],prior)

    def test_outer_recovery_from_precreate_journal_and_committed_CID(self):
        pg=self.make().__enter__()
        kw={k:v for k,v in self.kw.items()if k!='cleanup_deadline'};kw['deadline']=160;result=api.cleanup_all(**kw);self.assertTrue(result['container_absent']);self.assertIsNone(self.engine.row)
    def test_wrong_policy_token_path_and_foreign_replacement_refused(self):
        bad=dict(self.kw);bad['policy']={**api.POLICY,'requested_image':'postgres:latest'}
        with self.assertRaises(RuntimeError):api.bind_postgres(self.module,**bad)
        pg=self.make().__enter__();self.engine.row['Id']='cd'*32
        with self.assertRaises(RuntimeError):pg.__exit__()
        self.assertFalse(any(c[:2]in [['container','stop'],['container','rm']]for c in self.engine.calls));self.assertIsNotNone(self.engine.row)
    def test_outer_recovery_cannot_extend_journal_cleanup_budget(self):
        self.make().__enter__();count=len(self.engine.calls);kw={k:v for k,v in self.kw.items()if k!='cleanup_deadline'};kw['deadline']=161
        with self.assertRaisesRegex(RuntimeError,'cannot extend'):api.cleanup_all(**kw)
        self.assertEqual(len(self.engine.calls),count)
    def test_other_boot_cannot_recover_old_monotonic_budget(self):
        self.make().__enter__();kw={k:v for k,v in self.kw.items()if k!='cleanup_deadline'};kw['deadline']=160
        with mock.patch.object(api,'boot_id',return_value='00000000-0000-0000-0000-000000000002'),self.assertRaisesRegex(RuntimeError,'Foreign PG journal'):api.cleanup_all(**kw)
    def test_SQL_error_propagates_without_policy_or_query_rewrite(self):
        pg=self.make().__enter__();self.engine.fail_sql=True
        with self.assertRaisesRegex(RuntimeError,'nonzero-original-sql'):pg.sql('bench_0_0_rust','EXACTQUERY')
        self.assertEqual(self.engine.calls[-1],['container','exec','ab'*32,'psql','-X','-U','ziggy','-d','bench_0_0_rust','-At','-v','ON_ERROR_STOP=1','-c','EXACTQUERY'])
    def test_journal_symlink_cannot_be_adopted(self):
        foreign=self.root/'foreign';foreign.write_text('preserve');(self.root/'paired-postgres-owner.json').symlink_to(foreign)
        with self.assertRaises(RuntimeError):self.make().__enter__()
        self.assertEqual(foreign.read_text(),'preserve');self.assertEqual(self.engine.calls,[])

class ClientControls(unittest.TestCase):
    def exercise(self,code=0,late=False,readiness=False,read_error=False,kill_error=False):
        state={'now':0.0,'killed':0,'waits':0,'closed':set(),'parts':{999:[b'PRIVATE_OUTPUT',b''],1000:[b'PRIVATE_STDERR',b'']}}
        class Pipe:
            def __init__(self,fd):self.fd=fd
            def fileno(self):return self.fd
            def close(self):state['closed'].add(self.fd)
        class Child:
            pid=12345;stdout=Pipe(999);stderr=Pipe(1000);returncode=None
            def wait(self,timeout):
                state['waits']+=1;self.returncode=code
                if late:state['now']=11
                return code
            def kill(self):
                state['killed']+=1
                if kill_error:raise OSError('kill-injected')
        child=Child()
        class Selector:
            def __init__(self):self.active={}
            def register(self,pipe,event,name):self.active[pipe.fileno()]=SimpleNamespace(fd=pipe.fileno(),fileobj=pipe,data=name)
            def get_map(self):return self.active
            def select(self,timeout):return[(next(iter(self.active.values())),1)]
            def unregister(self,pipe):del self.active[pipe.fileno()]
            def close(self):pass
        client=RealClient.__new__(RealClient);client.prefix=['/fixed/docker'];client.environment={};client.receipt={'actual_wait_count':0,'failure_count':0,'chain_sha256':'00'*32,'latest':[]}
        args=['container','exec','ab'*32,'pg_isready','-U','ziggy','-d','ziggy']if readiness else['container','inspect','ab'*32]
        with mock.patch.object(api.subprocess,'Popen',return_value=child),mock.patch.object(api.os,'set_blocking'),mock.patch.object(api.os,'read',side_effect=(RuntimeError('original-read-failed')if read_error else lambda fd,*_:state['parts'][fd].pop(0))),mock.patch.object(api.selectors,'DefaultSelector',Selector),mock.patch.object(api.time,'monotonic',side_effect=lambda:state['now']):
            if read_error or late or(code!=0 and not readiness):
                with self.assertRaises(RuntimeError):client.call(args,10,10,readiness=readiness)
                result=None
            else:result=client.call(args,10,10,readiness=readiness)
        self.assertEqual(state['waits'],1);self.assertEqual(state['closed'],{999,1000});self.assertEqual(client.receipt['actual_wait_count'],1);self.assertNotIn('PRIVATE',json.dumps(client.receipt));return result,client.receipt
    def test_actual_client_records_real_wait_without_exporting_output(self):
        result,receipt=self.exercise();self.assertEqual(result,'PRIVATE_OUTPUT');self.assertEqual(receipt['latest'][0]['exit_code'],0);self.assertEqual(receipt['latest'][0]['stderr_bytes'],len(b'PRIVATE_STDERR'))
    def test_late_zero_wait_is_retained_but_not_success(self):
        _,receipt=self.exercise(late=True);self.assertEqual(receipt['latest'][0]['exit_code'],0);self.assertEqual(receipt['failure_count'],1)
    def test_kill_failure_does_not_skip_actual_wait_or_pipe_close(self):
        _,receipt=self.exercise(read_error=True,kill_error=True)
        self.assertTrue(receipt['latest'][0]['actual_parent_wait']);self.assertEqual(receipt['latest'][0]['cleanup_failures'],['client_kill_failed'])
    def test_only_explicit_readiness_nonzero_is_pending(self):
        _,receipt=self.exercise(code=7);self.assertEqual(receipt['failure_count'],1)
        result,receipt=self.exercise(code=2,readiness=True);self.assertIsNone(result);self.assertEqual(receipt['failure_count'],0)

if __name__=='__main__':unittest.main()
