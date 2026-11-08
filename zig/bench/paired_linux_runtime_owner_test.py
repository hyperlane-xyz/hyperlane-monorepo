"""Pure owner composition controls; no child, Docker, compiler or benchmark main."""
from pathlib import Path
import copy
import importlib.util
import json
import os
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('paired_runtime_owner_controls',HERE/'paired_linux_runtime_owner.py');api=importlib.util.module_from_spec(spec);spec.loader.exec_module(api)

class Fixture(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup);self.root=Path(temporary.name).resolve();self.repo=self.root/'repo';self.repo.mkdir();self.inputs=self.root/'inputs';self.inputs.mkdir();self.output=self.root/'owner';self.clock=SimpleNamespace(now=100*api.NS);self.calls=[]
        self.args=SimpleNamespace(runtime_authority=self.root/'authority.json',runtime_authority_sha256='a'*64,reuse=self.root/'reuse.json',reuse_sha256='b'*64,repo=self.repo,output=self.output,index=4)
    def file(self,path,body=b'data'):
        path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(body);return api.pin(path)
    def context(self,role='scraper'):
        return {'authority_pin':{'path':str(self.args.runtime_authority),'bytes':1,'sha256':'a'*64},'reuse_pin':{'path':str(self.args.reuse),'bytes':1,'sha256':'b'*64},'authority':{'execution_source_commit':'c'*40,'producer_source_commit':'d'*40},'inputs_root':self.inputs,'manifest':{'external':{'tools':{'docker':{'path':'/no-execution/docker','bytes':1,'sha256':'e'*64}}}},'method':{'index':4,'role':role,'mode':'ReleaseSafe','scenario':'single'}}
    def resources(self):
        owner={'pid':os.getpid(),'ppid':1,'pgid':os.getpid(),'sid':os.getpid(),'state':'R','start':'linux-ticks:owner','rss_bytes':1024,'comm':'python3'}
        return {os.getpid():owner}
    def clean(self):
        return {'actual_parent_wait':True,'exit_code':0,'clean':True,'cleanup_confirmed_absent':True,'signals':[],'errors':[],'remaining_identities':[],'unanchored_session_members':[],'actual_adopted_child_waits':[{'pid':44,'start':'linux-ticks:44','waited_pid':44,'status':0,'actual_wait4_usage_available':True}]}
    def services(self,role='scraper'):
        context=self.context(role);runtime=SimpleNamespace(source_recheck=lambda *a:self.calls.append('Source'),runtime_paths=lambda c,r,w,i:self.paths(c,r,w,i))
        custody=SimpleNamespace(COMPILERS={'rustc','zig','anvil'},enable_subreaper=lambda:self.calls.append('subreaper'),processes=lambda:self.resources(),owned_processes=lambda current,*args:{k:v for k,v in current.items()if k!=os.getpid()},allocated=lambda p:0)
        def stop(child,known,groups,**windows):
            self.calls.append(('stop',windows));return self.clean()
        custody.stop_owned=stop;return runtime,context,custody,SimpleNamespace(POLICY={})
    def paths(self,context,repo,worker,index):
        token=api.hashlib.sha256((str(worker)+context['authority_pin']['sha256']).encode()).hexdigest()[:32];raw=repo/'zig/bench/results'/('scraper-process-linux-'+token+'-'+str(index))if context['method']['role']=='scraper'else worker/'raw';receipt=worker/'postgres'
        return {'raw_output':raw,'owned_write_roots':[worker,raw,repo/'zig/bench/.cache',repo/'zig/integration/.cache',repo/'zig/integration/.deps'],'postgres':{'docker':context['manifest']['external']['tools']['docker'],'docker_config':receipt/'docker-config','token':token,'receipts':receipt,'journal':receipt/'paired-postgres-owner.json'}if context['method']['role']=='scraper'else None}
    def exercise(self,*,services=None,event=None,stop=None,receipt=None,pg=None,process=None):
        self.args.output=self.output
        services=services or self.services();runtime,context,custody,_=services
        if stop is not None:custody.stop_owned=stop
        process=process or SimpleNamespace(pid=12345,returncode=None)
        def spawned(*args,**kwargs):self.calls.append(('Popen',args[0],kwargs));return process
        def exited(*args):
            self.calls.append('waitid')
            return event()if event else SimpleNamespace(si_pid=12345)
        def pg_cleanup(*args):self.calls.append('PG');return pg()if pg else {'required':True,'passed':True,'daemon_parent_wait_credit':False}
        with mock.patch.object(api,'admission',return_value=services),mock.patch.object(api.sys,'platform','linux'),mock.patch.object(api.signal,'pidfd_send_signal',create=True),mock.patch.object(api.os,'pidfd_open',create=True),mock.patch.object(api.signal,'signal'),mock.patch.object(api.signal,'getsignal',return_value=None),mock.patch.object(api.signal,'pthread_sigmask',return_value=[]),mock.patch.object(api.time,'monotonic_ns',side_effect=lambda:self.clock.now),mock.patch.object(api.time,'sleep',side_effect=lambda n:setattr(self.clock,'now',self.clock.now+int(n*api.NS))),mock.patch.object(api.shutil,'disk_usage',return_value=SimpleNamespace(free=8*api.GIB)),mock.patch.object(api.subprocess,'Popen',side_effect=spawned),mock.patch.object(api.os,'waitid',side_effect=exited),mock.patch.object(api,'completed_worker',side_effect=lambda *a:receipt()if receipt else {'path':'/fixture/result.json','bytes':1,'sha256':'f'*64}),mock.patch.object(api,'cleanup_postgres',side_effect=pg_cleanup):
            return api.owner(self.args)
    def saved(self):return json.loads((self.output/'owner-result.json').read_text())

class Admission(Fixture):
    def test_false_authority_inert_before_modules_platform_or_output(self):
        row=self.file(self.args.runtime_authority,json.dumps({'schema':1,'kind':'paired-linux-runtime-authority-v1','root_approved':False}).encode());self.args.runtime_authority_sha256=row['sha256']
        with mock.patch.object(api,'captured_module',side_effect=AssertionError('No import')),mock.patch.object(api.shutil,'disk_usage',side_effect=AssertionError('No resources')),mock.patch.object(api.subprocess,'Popen',side_effect=AssertionError('No child')):
            self.assertEqual(api.owner(self.args),{'enabled':False,'passed':False,'native_or_timing_acceptance':False})
        self.assertFalse(self.output.exists())
    def test_nonliteral_gate_or_wrong_pin_refused_before_loader(self):
        for value in [1,'true',None]:
            row=self.file(self.args.runtime_authority,json.dumps({'schema':1,'kind':'paired-linux-runtime-authority-v1','root_approved':value}).encode());self.args.runtime_authority_sha256=row['sha256']
            with mock.patch.object(api,'captured_module',side_effect=AssertionError('No import')),self.assertRaises(api.Refused):api.admission(self.args)
        self.args.runtime_authority_sha256='0'*64
        with self.assertRaises(api.Refused):api.admission(self.args)
    def test_enabled_missing_owner_custody_PG_source_refuses_before_import(self):
        row=self.file(self.args.runtime_authority,json.dumps({'schema':1,'kind':'paired-linux-runtime-authority-v1','root_approved':True,'required_source':[]}).encode());self.args.runtime_authority_sha256=row['sha256']
        with mock.patch.object(api,'captured_module',side_effect=AssertionError('No import')),self.assertRaisesRegex(api.Refused,'Source closure'):api.admission(self.args)
    def test_captured_source_bytes_ignore_adjacent_cache_and_reject_changed_hash(self):
        path=self.repo/'Source.py';row=self.file(path,b'def actual():return 17\n');cache=path.parent/'__pycache__';cache.mkdir();(cache/'Source.pyc').write_bytes(b'not executed')
        self.assertEqual(api.captured_module(row,'fixture_source').actual(),17)
        path.write_text('def actual():return 99\n')
        with self.assertRaises(api.Refused):api.captured_module(row,'fixture_changed')

class Resources(Fixture):
    def sample(self,custody,baseline=None):
        self.output.mkdir(exist_ok=True);paths=[self.output,self.repo/'zig/integration/.deps'];base=baseline or {str(p):0 for p in paths};record={'sampled_RSS_peak_bytes':0,'new_disk_peak_bytes':0,'minimum_free_bytes':10*api.GIB,'resource_samples':0}
        with mock.patch.object(api.shutil,'disk_usage',return_value=SimpleNamespace(free=8*api.GIB)):
            row=api.resources(custody,paths,base,self.output,None,{}, {},False,'fixture',record)
        return row,record
    def test_foreign_compiler_refuses_without_signal_authority(self):
        _,_,custody,_=self.services();rows=self.resources();rows[77]={'pid':77,'start':'linux-ticks:77','state':'S','comm':'rustc','rss_bytes':1};custody.processes=lambda:rows;custody.owned_processes=lambda *a:{}
        with self.assertRaisesRegex(api.Refused,'Foreign compiler'):self.sample(custody)
        self.assertFalse(any(isinstance(c,tuple)and c[0]=='stop'for c in self.calls))
    def test_own_native_not_foreign_and_zombie_foreign_not_running(self):
        _,_,custody,_=self.services();rows=self.resources();rows[77]={'pid':77,'start':'linux-ticks:77','state':'S','comm':'anvil','rss_bytes':1};rows[88]={'pid':88,'start':'linux-ticks:88','state':'Z','comm':'zig','rss_bytes':0};custody.processes=lambda:rows;custody.owned_processes=lambda *a:{77:rows[77]}
        row,_=self.sample(custody);self.assertEqual(row['foreign_compilers'],[]);self.assertEqual(row['sampled_manager_and_owned_tree_RSS_bytes'],1025)
    def test_cross_root_deletion_cannot_offset_new_disk_growth(self):
        _,_,custody,_=self.services();deps=self.repo/'zig/integration/.deps';deps.mkdir(parents=True);custody.allocated=lambda p:5*api.GIB if p==self.output else 0
        baseline={str(self.output):0,str(deps):8*api.GIB}
        with self.assertRaisesRegex(api.Refused,'RSS/disk/free'):self.sample(custody,baseline)
    def test_manager_RSS_and_real_floor_are_mandatory(self):
        _,_,custody,_=self.services();rows=self.resources();rows[os.getpid()]['rss_bytes']=8*api.GIB+1;custody.processes=lambda:rows
        with self.assertRaisesRegex(api.Refused,'RSS/disk/free'):self.sample(custody)
        self.output.mkdir(exist_ok=True);paths=[self.output];record={'sampled_RSS_peak_bytes':0,'new_disk_peak_bytes':0,'minimum_free_bytes':10*api.GIB,'resource_samples':0};custody.processes=lambda:self.resources()
        with mock.patch.object(api.shutil,'disk_usage',return_value=SimpleNamespace(free=6*api.GIB-1)),self.assertRaisesRegex(api.Refused,'RSS/disk/free'):api.resources(custody,paths,{str(self.output):0},self.output,None,{}, {},False,'floor',record)
    def test_exact_scraper_root_and_non_scraper_no_PG_authority(self):
        runtime,context,_,_=self.services();worker,raw,roots,pg=api.planned_paths(runtime,context,self.repo,self.output,4)
        self.assertEqual(pg['receipts'],worker/'postgres');self.assertEqual(len(roots),5);self.assertEqual(raw.parent,self.repo/'zig/bench/results')
        context['method']['role']='relayer';_,_,roots,pg=api.planned_paths(runtime,context,self.repo,self.output,4);self.assertEqual(len(roots),4);self.assertIsNone(pg)
        runtime.runtime_paths=lambda *a:{'raw_output':self.repo/'foreign','owned_write_roots':[],'postgres':None}
        with self.assertRaises(api.Refused):api.planned_paths(runtime,context,self.repo,self.output,4)

class CustodyAndClock(Fixture):
    def test_normal_completion_retains_original_deadlines_and_waits(self):
        result=self.exercise();self.assertTrue(result['passed']);self.assertEqual(result['original_execution_deadline_ns'],100*api.NS+18000*api.NS);self.assertEqual(result['original_work_deadline_ns'],result['original_execution_deadline_ns']-40*api.NS);self.assertEqual(result['original_PG_cleanup_deadline_ns'],result['original_execution_deadline_ns']+60*api.NS)
        stop=next(c for c in self.calls if isinstance(c,tuple)and c[0]=='stop');self.assertEqual(stop[1],{'grace_seconds':30,'kill_seconds':10});self.assertLess(self.calls.index(stop),self.calls.index('PG'));self.assertEqual(result['cleanup']['actual_adopted_child_waits'][0]['waited_pid'],44)
        launch=next(c for c in self.calls if isinstance(c,tuple)and c[0]=='Popen');self.assertEqual(launch[1][:3],[sys.executable,'-I','-B']);self.assertIn('--work-deadline-ns',launch[1]);self.assertNotIn('GH_TOKEN',launch[2]['env']);self.assertIs(result['Root_final_timing_acceptance'],False)
    def test_late_zero_worker_never_accepts_and_still_cleans_PG(self):
        def late():self.clock.now=100*api.NS+(18000-40)*api.NS;return SimpleNamespace(si_pid=12345)
        with self.assertRaises(api.Refused):self.exercise(event=late)
        self.assertFalse(self.saved()['passed']);self.assertIn('PG',self.calls);self.assertIsNone(self.saved()['worker_receipt'])
    def test_forced_signal_nonzero_missing_wait_and_leftovers_each_refuse(self):
        for key,value in [('signals',[{'pid':12345,'signal':15}]),('exit_code',1),('actual_parent_wait',False),('remaining_identities',[{'pid':55,'start':'linux-ticks:55'}]),('clean',False)]:
            with self.subTest(key=key):
                self.output=self.root/('owner-'+key);self.calls=[]
                def stop(*a,**kw):self.calls.append('stop');return dict(self.clean(),**{key:value})
                with self.assertRaises(api.Refused):self.exercise(stop=stop)
                self.assertFalse(self.saved()['passed']);self.assertIn('PG',self.calls)
    def test_stop_failure_preserves_failure_but_does_not_skip_PG(self):
        def stop(*a,**kw):self.calls.append('stop');raise RuntimeError('typed fixture')
        with self.assertRaises(api.Refused):self.exercise(stop=stop)
        self.assertIn('PG',self.calls);self.assertLess(self.calls.index('stop'),self.calls.index('PG'));self.assertEqual(self.saved()['errors'][0],{'stage':'worker_stop','type':'RuntimeError'})
    def test_late_stop_never_gets_new_execution_clock(self):
        def stop(*a,**kw):self.calls.append('stop');self.clock.now=100*api.NS+18000*api.NS+1;return self.clean()
        with self.assertRaises(api.Refused):self.exercise(stop=stop)
        self.assertIn('PG',self.calls);self.assertFalse(self.saved()['passed'])
    def test_postspawn_cancellation_always_reaches_owned_stop_and_PG(self):
        services=self.services();custody=services[2];original=custody.processes;calls=[0]
        def snapshot():
            calls[0]+=1
            if calls[0]==2:raise api.TaskInterrupted('fixture cancellation')
            return original()
        custody.processes=snapshot
        with self.assertRaises(api.Refused):self.exercise(services=services)
        self.assertTrue(any(isinstance(c,tuple)and c[0]=='stop'for c in self.calls));self.assertIn('PG',self.calls);self.assertEqual(self.saved()['errors'][0]['type'],'TaskInterrupted')
    def test_pg_cleanup_failure_cannot_be_repaired_by_worker_success(self):
        def failed():raise RuntimeError('fixed cleanup failure')
        with self.assertRaises(api.Refused):self.exercise(pg=failed)
        self.assertFalse(self.saved()['passed']);self.assertEqual(self.saved()['errors'][0]['stage'],'postgres_cleanup')
    def test_worker_receipt_failure_remains_failed_after_clean_teardown(self):
        def invalid():raise api.Refused('actual receipt invalid')
        with self.assertRaises(api.Refused):self.exercise(receipt=invalid)
        self.assertFalse(self.saved()['passed']);self.assertTrue(self.saved()['cleanup']['actual_parent_wait'])

class PostgresAndPublication(Fixture):
    def test_PG_original_clocks_passed_to_real_cleanup_interface(self):
        deadline=200*api.NS;root=self.root/'postgres';root.mkdir();journal=root/'paired-postgres-owner.json';self.file(journal,json.dumps({'context':{'execution_deadline':200.0,'cleanup_deadline':260.0}}).encode());calls=[]
        pg=SimpleNamespace(POLICY={'schema':1},cleanup_all=lambda **kw:calls.append(kw)or {'passed':True,'container_absent':True,'cleanup_failures':[],'daemon_parent_wait_credit':False})
        handoff={'journal':journal,'docker':{'pinned':'fixture'},'docker_config':root/'docker-config','token':'a'*32,'receipts':root}
        with mock.patch.object(api.time,'monotonic_ns',return_value=250*api.NS):result=api.cleanup_postgres(pg,handoff,deadline)
        self.assertTrue(result['passed']);self.assertEqual(calls[0]['deadline'],260.0);self.assertEqual(calls[0]['token'],'a'*32)
    def test_wrong_journal_clock_still_calls_cleanup_but_refuses_acceptance(self):
        root=self.root/'postgres';root.mkdir();journal=root/'paired-postgres-owner.json';self.file(journal,json.dumps({'context':{'execution_deadline':999.0,'cleanup_deadline':1000.0}}).encode());pg=SimpleNamespace(POLICY={},cleanup_all=mock.Mock(return_value={'passed':True,'container_absent':True,'cleanup_failures':[],'daemon_parent_wait_credit':False}));handoff={'journal':journal,'docker':{},'docker_config':root/'docker-config','token':'a'*32,'receipts':root}
        with self.assertRaisesRegex(api.Refused,'Original PG'):api.cleanup_postgres(pg,handoff,200*api.NS)
        pg.cleanup_all.assert_called_once();self.assertEqual(pg.cleanup_all.call_args.kwargs['deadline'],260.0)
    def test_late_publication_revokes_pass_in_durable_result(self):
        self.output.mkdir();result={'passed':True,'errors':[]}
        with mock.patch.object(api.time,'monotonic_ns',return_value=201),mock.patch.object(api.shutil,'disk_usage',return_value=SimpleNamespace(free=8*api.GIB)):
            api.publish(self.output,result,200)
        self.assertFalse(self.saved()['passed']);self.assertEqual(self.saved()['errors'][0]['stage'],'publication')

class Metadata(Fixture):
    def version(self,wire,*,fresh=None,executable='rustc'):
        import io
        path=self.root/executable;path.write_bytes(b'no executable invocation');row={'pid':77,'start':'linux-ticks:77','state':'S','comm':'rustc'}
        custody=SimpleNamespace(_linux_row=lambda pid:fresh or row,same_process=lambda a,b:(a['pid'],a['start'])==(b['pid'],b['start']))
        original_open=Path.open;original_resolve=Path.resolve
        def opened(p,*a,**kw):return io.BytesIO(wire)if str(p)=='/proc/77/cmdline'else original_open(p,*a,**kw)
        def resolved(p,*a,**kw):return path if str(p)=='/proc/77/exe'else original_resolve(p,*a,**kw)
        with mock.patch.object(Path,'open',opened),mock.patch.object(Path,'resolve',resolved),mock.patch.object(api.time,'monotonic_ns',return_value=500):return api.owned_version(custody,row)
    def test_exact_owned_version_form_is_closed_no_argv(self):
        row=self.version(b'/host/bin/rustc\0--version\0');self.assertEqual(row['command'],'rustc-version');self.assertEqual(row['observed_monotonic_ns'],500);self.assertNotIn('argv',row);self.assertEqual(set(row),{'pid','start','command','executable','observed_monotonic_ns'})
    def test_nonversion_extra_arguments_or_wrong_executable_refuse(self):
        for wire in [b'cargo\0build\0',b'rustc\0--version\0private-token\0',b'zig\0build\0',b'clang\0--version\0',b'rustc\0--version']:
            with self.subTest(wire_hash=api.hashlib.sha256(wire).hexdigest()),self.assertRaises(api.Refused):self.version(wire)
        with self.assertRaisesRegex(api.Refused,'executable name'):self.version(b'rustc\0--version\0',executable='unrelated')
    def test_PID_epoch_change_rejects_and_terminal_empty_cmdline_is_not_admission(self):
        with self.assertRaisesRegex(api.Refused,'birth changed'):self.version(b'rustc\0--version\0',fresh={'pid':77,'start':'linux-ticks:DIFFERENT','state':'S'})
        self.assertIsNone(self.version(b'',fresh={'pid':77,'start':'linux-ticks:77','state':'Z'}))
    def test_version_samples_must_precede_actual_original_wait4_start(self):
        waits=[{'original_start_ns':100},{'original_start_ns':200}]
        api.metadata_before_measurement([{'observed_monotonic_ns':99}],waits)
        for stamp in [100,101,300]:
            with self.subTest(stamp=stamp),self.assertRaisesRegex(api.Refused,'overlapped'):api.metadata_before_measurement([{'observed_monotonic_ns':stamp}],waits)
        with mock.patch.object(api.time,'get_clock_info',side_effect=[SimpleNamespace(monotonic=True,implementation='one'),SimpleNamespace(monotonic=True,implementation='two')]),self.assertRaisesRegex(api.Refused,'backends'):api.metadata_before_measurement([{'observed_monotonic_ns':99}],waits)
    def test_owned_version_observation_cannot_live_beyond_original20s(self):
        _,_,custody,_=self.services();rows=self.resources();rows[77]={'pid':77,'start':'linux-ticks:77','state':'S','comm':'rustc','rss_bytes':1};custody.processes=lambda:rows;custody.owned_processes=lambda *a:{77:rows[77]};self.output.mkdir();record={'sampled_RSS_peak_bytes':0,'new_disk_peak_bytes':0,'minimum_free_bytes':8*api.GIB,'resource_samples':0};paths=[self.output];observation={'pid':77,'start':'linux-ticks:77','command':'rustc-version','executable':{'path':'/fixture/rustc','bytes':1,'sha256':'a'*64},'observed_monotonic_ns':1}
        with mock.patch.object(api.shutil,'disk_usage',return_value=SimpleNamespace(free=8*api.GIB)),mock.patch.object(api,'owned_version',return_value=observation):api.resources(custody,paths,{str(self.output):0},self.output,None,{}, {},False,'prework',record)
        with mock.patch.object(api.shutil,'disk_usage',return_value=SimpleNamespace(free=8*api.GIB)),mock.patch.object(api,'owned_version',return_value=dict(observation,observed_monotonic_ns=20*api.NS+2)),self.assertRaisesRegex(api.Refused,'original20s'):api.resources(custody,paths,{str(self.output):0},self.output,None,{}, {},False,'prework',record)

class Receipt(Fixture):
    def result_fixture(self):
        context=self.context();worker=self.root/'worker';raw=worker/'raw';raw.mkdir(parents=True);self.file(raw/'actual.json',b'{}');rust=self.file(self.inputs/'rust/scraper',b'actual Rust fixture bytes');zig=self.file(self.inputs/'zig/scraper',b'actual Zig fixture bytes');context['manifest']['artifacts']={'rust':{'scraper':dict(rust,path='rust/scraper')},'zig':{'ReleaseSafe':{'scraper':dict(zig,path='zig/scraper')}}}
        waits=[]
        for i in range(20):
            implementation='rust'if i<10 else'zig';waits.append({'launch_ordinal':i,'implementation':implementation,'role':'scraper','binary':rust if implementation=='rust'else zig,'pid':100+i,'actual_original_wait4':True,'exit_code':0,'original_start_ns':10+i,'original_end_ns':40+i,'user_seconds':.1,'system_seconds':.01,'max_child_RSS_bytes':100,'voluntary_context_switches':1,'involuntary_context_switches':0})
        primary=api.pin(raw/'actual.json');result={'schema':1,'kind':'paired-linux-original-runtime-workload','index':4,'mode':'ReleaseSafe','role':'scraper','scenario':'single','original_main_completed':True,'actual_pairs':5,'pair_order':['rust','zig','zig','rust','rust','zig','zig','rust','rust','zig'],'execution_source_commit':context['authority']['execution_source_commit'],'producer_source_commit':context['authority']['producer_source_commit'],'runtime_authority':context['authority_pin'],'reuse':context['reuse_pin'],'raw_result':primary,'raw_outputs':{'root':str(raw),'files':[primary],'bytes':primary['bytes']},'actual_original_wait4_rows':waits,'Root_final_timing_acceptance':False};self.file(worker/'result.json',json.dumps(result).encode())
        runtime=SimpleNamespace(checked=lambda row,root:api.checked(dict(row,path=str(root/row['path']))),pin=api.pin,source_recheck=lambda *args:self.calls.append('Source'))
        return runtime,context,worker,raw,result
    def test_actual_result_catalog_binary_wait4_and_clock_validation(self):
        runtime,context,worker,raw,result=self.result_fixture();self.assertEqual(api.completed_worker(runtime,context,self.repo,worker,raw,4,1000,[]),api.pin(worker/'result.json'));self.assertIn('Source',self.calls)
    def test_nonactual_wait_wrong_binary_or_late_measured_clock_refuse(self):
        runtime,context,worker,raw,result=self.result_fixture()
        for field,value in [('actual_original_wait4',False),('original_end_ns',1000),('binary',{'path':'/foreign','bytes':1,'sha256':'f'*64}),('user_seconds',True),('exit_code',True)]:
            bad=copy.deepcopy(result);bad['actual_original_wait4_rows'][0][field]=value;self.file(worker/'result.json',json.dumps(bad).encode())
            with self.subTest(field=field),self.assertRaises(api.Refused):api.completed_worker(runtime,context,self.repo,worker,raw,4,1000,[])
    def test_extra_raw_file_or_wrong_Source_and_metadata_overlap_refuse(self):
        runtime,context,worker,raw,result=self.result_fixture();self.file(raw/'injected.json',b'{}')
        with self.assertRaisesRegex(api.Refused,'membership'):api.completed_worker(runtime,context,self.repo,worker,raw,4,1000,[])
        (raw/'injected.json').unlink();result['execution_source_commit']='f'*40;self.file(worker/'result.json',json.dumps(result).encode())
        with self.assertRaisesRegex(api.Refused,'Source'):api.completed_worker(runtime,context,self.repo,worker,raw,4,1000,[])
        result['execution_source_commit']=context['authority']['execution_source_commit'];self.file(worker/'result.json',json.dumps(result).encode())
        with self.assertRaisesRegex(api.Refused,'overlapped'):api.completed_worker(runtime,context,self.repo,worker,raw,4,1000,[{'observed_monotonic_ns':10}])
    def test_outside_raw_descriptor_rejects_before_hashing_foreign_file(self):
        runtime,context,worker,raw,result=self.result_fixture();result['raw_result']={'path':'/do-not-open/private','bytes':1,'sha256':'f'*64};self.file(worker/'result.json',json.dumps(result).encode())
        with mock.patch.object(api,'checked',side_effect=AssertionError('Must not read foreign file'))as checked,self.assertRaisesRegex(api.Refused,'outside selected root'):api.completed_worker(runtime,context,self.repo,worker,raw,4,1000,[])
        checked.assert_not_called()
    def test_final_disk_or_Source_postcondition_revokes_published_pass(self):
        self.output.mkdir();value={'passed':True,'errors':[]};calls=[]
        def guard():calls.append('guard');raise api.Refused('postcondition fixture')
        with mock.patch.object(api.time,'monotonic_ns',return_value=1),mock.patch.object(api.shutil,'disk_usage',return_value=SimpleNamespace(free=8*api.GIB)):api.publish(self.output,value,100,guard)
        self.assertFalse(self.saved()['passed']);self.assertEqual(calls,['guard']);self.assertEqual(self.saved()['errors'][0],{'stage':'publication','type':'Refused'})

class Unwind(Fixture):
    def test_captured_postPopen_bookkeeping_cancellation_still_stops_and_waits(self):
        class Child:
            reads=0;returncode=None
            @property
            def pid(self):
                self.reads+=1
                if self.reads==1:raise api.TaskInterrupted('postspawn fixture')
                return 12345
        with self.assertRaises(api.Refused):self.exercise(process=Child())
        self.assertTrue(any(isinstance(c,tuple)and c[0]=='stop'for c in self.calls));self.assertIn('PG',self.calls);self.assertEqual(self.saved()['errors'][0]['type'],'TaskInterrupted')
    def test_stdlib_selector_cannot_swallow_RuntimeError_cancellation(self):
        import selectors
        selector=selectors.SelectSelector()
        try:
            with mock.patch.object(selector,'_select',side_effect=api.TaskInterrupted('fixed fixture')),self.assertRaises(api.TaskInterrupted):selector.select(0)
        finally:selector.close()
        self.assertTrue(issubclass(api.TaskInterrupted,RuntimeError));self.assertFalse(issubclass(api.TaskInterrupted,InterruptedError))
    def test_shortened_remaining_stop_budget_uses_no_new_clock(self):
        def late():self.clock.now=(100+18000-20)*api.NS;return SimpleNamespace(si_pid=12345)
        with self.assertRaises(api.Refused):self.exercise(event=late)
        row=next(c for c in self.calls if isinstance(c,tuple)and c[0]=='stop');self.assertEqual(row[1],{'grace_seconds':10,'kill_seconds':10});self.assertFalse(self.saved()['passed'])
    def test_foreign_compiler_before_or_after_work_refuses_without_foreign_signal(self):
        for phase in ['before','after']:
            with self.subTest(phase=phase):
                self.output=self.root/('owner-'+phase);self.calls=[];services=self.services();custody=services[2];calls=[0]
                def snapshot():
                    calls[0]+=1;rows=self.resources()
                    if phase=='before'or calls[0]>=3:rows[88]={'pid':88,'start':'linux-ticks:88','state':'S','comm':'rustc','rss_bytes':1}
                    return rows
                custody.processes=snapshot;custody.owned_processes=lambda *a:{}
                with self.assertRaises(api.Refused):self.exercise(services=services)
                self.assertFalse(self.saved()['passed'])
                if phase=='before':self.assertFalse(any(isinstance(c,tuple)and c[0]=='Popen'for c in self.calls))
                self.assertFalse(self.saved()['cleanup']and self.saved()['cleanup']['signals'])

class AuthorityCapture(Fixture):
    def test_replaced_second_read_cannot_select_executable_Source(self):
        import io
        original={'schema':1,'kind':'paired-linux-runtime-authority-v1','root_approved':False};row=self.file(self.args.runtime_authority,json.dumps(original).encode());self.args.runtime_authority_sha256=row['sha256'];source=[]
        for relative in api.SOURCE.values():
            body=Path(api.__file__).read_bytes()if relative==api.SOURCE['owner']else b'# harmless Source fixture never executed\n'
            item=self.file(self.repo/relative,body);source.append(dict(item,path=relative))
        changed=json.dumps({'schema':1,'kind':'paired-linux-runtime-authority-v1','root_approved':True,'required_source':source}).encode();original_open=Path.open;reads=[]
        def opened(path,*args,**kwargs):
            if path==self.args.runtime_authority and args and args[0]=='rb':
                reads.append('authority')
                if len(reads)==2:
                    class Capture(io.BytesIO):
                        def read(inner,n=-1):
                            self.assertEqual(n,16*1024**2+1);return super().read(n)
                    return Capture(changed)
            return original_open(path,*args,**kwargs)
        with mock.patch.object(Path,'open',opened),mock.patch.object(api,'__file__',str(self.repo/api.SOURCE['owner'])),mock.patch.object(api,'captured_module',side_effect=api.Refused('controlled runtime loader sink'))as loader:
            with self.assertRaisesRegex(api.Refused,'Captured Root authority differs'):api.admission(self.args)
            loader.assert_not_called()
        self.assertEqual(len(reads),2);self.assertFalse(self.output.exists())
    def test_captured_decoder_rejects_duplicate_nonfinite_and_boolean_schema(self):
        for body in [b'{"a":1,"a":2}',b'{"clock":1e999}']:
            with self.subTest(body=body),self.assertRaises(api.Refused):api.decode(body)
        row=self.file(self.args.runtime_authority,b'{"schema":true,"kind":"paired-linux-runtime-authority-v1","root_approved":false}');self.args.runtime_authority_sha256=row['sha256']
        with self.assertRaisesRegex(api.Refused,'schema'):api.admission(self.args)

if __name__=='__main__':unittest.main(verbosity=2)
