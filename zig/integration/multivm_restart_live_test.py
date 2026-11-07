"""Restart sampler ownership/whole-deadline/schema controls. No native roles."""
import copy
import importlib.util
from pathlib import Path
import threading
import time
import unittest
from unittest import mock
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
import multivm_session as api
import multivm_restart_test as fixtures


class LiveSamplerTests(unittest.TestCase):
    def setUp(self):
        self.fixture=fixtures.ActualSessionBranchTests();self.fixture.setUp();self.addCleanup(self.fixture.doCleanups)
        self.session=self.fixture.session
    def test_successful_full_baseline_is_single_flight_and_cached_while_no_anchor(self):
        entered=threading.Event();release=threading.Event();calls=[];errors=[]
        original=self.session.canonical_snapshot
        def slow(*a,**k):calls.append(1);entered.set();self.assertTrue(release.wait(2));return original(*a,**k)
        self.session.canonical_snapshot=slow
        def invoke():
            try:self.session.verify('after_restart',1)
            except Exception as error:errors.append(error)
        # Install a sampler-specific fake factory rather than intercept callers.
        factory=api.threading.Thread
        def controlled(*a,**kw):
            value=factory(*a,**kw)
            if kw.get('name')=='owned-restart-live-observer':value.start=lambda:None
            return value
        with mock.patch.object(api,'read_approval'),mock.patch.object(api,'process_identity'),mock.patch.object(api.threading,'Thread',side_effect=controlled):
            first=factory(target=invoke);second=factory(target=invoke);first.start();self.assertTrue(entered.wait(1));second.start();release.set();first.join(2);second.join(2)
            self.assertFalse(first.is_alive()or second.is_alive());self.assertEqual(errors,[]);self.assertEqual(len(calls),1)
            self.session.verify('after_restart',1);self.assertEqual(len(calls),1);self.assertEqual(self.session.restart_window.samples,[])
            with self.assertRaises(ValueError):self.session.verify('after_restart',2)
    def test_slow_later_caller_does_not_stop_actual_sampler_progress(self):
        s=self.session;context={'captures':s.captures,'children':[],'capture_clocks':{'validator:test1':100},'epoch':'a'*64}
        s.restart_baseline={'context':context,'completed_monotonic_ns':100,'snapshot':{}}
        s.restart_deadline_ns=time.monotonic_ns()+5_000_000_000;s.restart_window.minimum_ns=30_000_000
        s._restart_context=lambda:context;s._restart_control_artifacts=lambda:None
        def admin(*args):
            now=time.monotonic_ns();s.successful_activity={('validator','test1'):{'request_started_monotonic_ns':now-2,'response_received_monotonic_ns':now-1}};return []
        s._restart_admin=admin;original=s.restart_live_stop.wait
        with mock.patch.object(s.restart_live_stop,'wait',side_effect=lambda _:original(.005)):
            worker=threading.Thread(target=s._restart_sample_loop);worker.start()
            deadline=time.monotonic()+1
            while not s.restart_live_ready and time.monotonic()<deadline:time.sleep(.005)
            s.restart_live_stop.set();worker.join(1)
        self.assertFalse(worker.is_alive());self.assertTrue(s.restart_live_ready);self.assertGreaterEqual(len(s.restart_window.samples),4)
        self.assertGreaterEqual(s.restart_window.evidence()['elapsed_live_ns'],30_000_000)
    def test_background_queued_on_gate_exits_without_io_after_stop(self):
        s=self.session;entered=threading.Event();s._restart_control_artifacts=mock.Mock(side_effect=AssertionError('No I/O after stop'))
        def run():entered.set();s._restart_sample_once(background=True)
        with s.restart_sample_gate:
            worker=threading.Thread(target=run);worker.start();self.assertTrue(entered.wait(1));s.restart_live_stop.set()
        worker.join(1);self.assertFalse(worker.is_alive());s._restart_control_artifacts.assert_not_called()
    def test_capture_race_at_sample_commit_never_credits(self):
        s=self.session;now=time.monotonic_ns();context={'captures':copy.deepcopy(s.captures),'children':[],'capture_clocks':{'validator:test1':1},'epoch':'a'*64};s.restart_baseline={'context':context,'snapshot':{},'completed_monotonic_ns':now-100};s.restart_deadline_ns=now+10**9;s.successful_activity={('validator','test1'):{'request_started_monotonic_ns':now-2,'response_received_monotonic_ns':now-1}}
        def final_context():s.captures.append({'race':True});return context
        s._restart_context=mock.Mock(side_effect=[context,final_context]);s._restart_admin=lambda *a:[]
        # Resolve callable side effect explicitly, keeping the race at the real
        # gap between the second external context and Session.lock commit.
        count=[0]
        def context_call():count[0]+=1;return final_context()if count[0]==2 else context
        s._restart_context=context_call
        with self.assertRaises(ValueError):s._restart_sample_once()
        self.assertEqual(s.restart_window.samples,[])
    def test_full_baseline_cost_never_borrows_live_duration(self):
        s=self.session;original=s.canonical_snapshot
        def slow(*args,**kw):
            api.time.monotonic_ns.return_value=146*10**9
            return original(*args,**kw)
        s.canonical_snapshot=mock.Mock(side_effect=slow)
        self.assertFalse(self.fixture.tick(100*10**9)['verified'])
        self.assertEqual(s.restart_baseline['completed_monotonic_ns'],146*10**9)
        self.assertEqual(s.restart_window.samples,[])
        for second in [147,152,157,162,167,172]:self.assertFalse(self.fixture.tick(second*10**9)['verified'])
        self.assertTrue(self.fixture.tick(177*10**9)['verified'])
        self.assertEqual(s.canonical_snapshot.call_count,1)
        proof=s.after_restart['same_db_restart_observation']
        self.assertEqual(proof['checker_deadline_monotonic_ns'],220*10**9)
        self.assertEqual(proof['samples'][0]['observed_monotonic_ns'],147*10**9)
        self.assertEqual(proof['elapsed_live_ns'],30*10**9)
    def test_after_join_publication_race_is_rejected(self):
        for sec in [100,105,110,115,120,125]:self.fixture.tick(sec*10**9)
        s=self.session;original=s._restart_stop_sampler
        def changed():original();s.broadcasts.append('unexpected')
        s._restart_stop_sampler=changed
        with self.assertRaises(ValueError):self.fixture.tick(130*10**9)
        self.assertTrue(s.restart_window.failed);self.assertFalse(s.restart_published)
    def test_actual_admin_callback_rejects_known_message_under_other_domain(self):
        s=self.session
        raw=bytes([3])+bytes(4)+(1).to_bytes(4,'big')+bytes(32)+(2).to_bytes(4,'big')+bytes(32)
        wire='0x'+raw.hex();identity='0x'+'ab'*32
        s.restart_baseline={'snapshot':{'messages':[{'id':identity,'wire':wire,'destination':2}],'deliverable_messages':[]}}
        context={'restarted':[{'original':{'role':'relayer','metrics_port':12345,'role_chain_names':['wrong'],'chains':{'wrong':{'domainid':3}}}}]}
        with mock.patch.object(api,'collect_admin_sample',return_value=({'wrong':[{'id':identity,'operation':{'type':'PendingMessage','submitted':False,'status':{'Retry':'CouldNotFetchMetadata'},'message':{'version':3,'nonce':0,'origin':1,'sender':'0x'+'00'*32,'destination':2,'recipient':'0x'+'00'*32,'body':[]}}}]},{'wrong':{'request_started_monotonic_ns':1,'response_received_monotonic_ns':2}})),self.assertRaisesRegex(ValueError,'cross-domain'):
            api.Session._restart_admin(s,context,time.monotonic_ns()+10**9)
    def test_blocked_evidence_append_cannot_return_late_positive(self):
        for sec in [100,105,110,115,120,125]:self.fixture.tick(sec*10**9)
        s=self.session
        def late(*args):api.time.monotonic_ns.return_value=221*10**9
        s.append.side_effect=late
        with self.assertRaises(ValueError):self.fixture.tick(130*10**9)
        self.assertTrue(s.restart_window.failed);self.assertFalse(s.restart_published)


class ActualIdentityFunctionTests(unittest.TestCase):
    def test_actual_harness_identity_keeps_unchanged_default_ps_call(self):
        import tempfile,hashlib
        import multivm_evidence as evidence
        with tempfile.TemporaryDirectory()as temporary:
            path=Path(temporary)/'approved-helper';path.write_bytes(b'public fixture executable, never executed');path.chmod(0o755)
            artifact={'path':str(path),'bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}
            token='123 99 Sat Nov 7 21:12:00 2026 '+str(path)
            row={'pid':123,'os_start_token':token,'executable':artifact}
            with mock.patch.object(evidence,'run_tool',return_value=token)as ps,mock.patch.object(evidence.pathlib.Path,'readlink',return_value=path):
                self.assertEqual(evidence.verified_harness_identity({}, {'harness':artifact}, row),row)
            ps.assert_called_once_with({},'ps',['-ww','-p','123','-o','pid=,ppid=,lstart=,comm='])
    def test_actual_role_identity_uses_only_its_explicit_bounded_timeout(self):
        import tempfile,hashlib
        import multivm_evidence as evidence
        with tempfile.TemporaryDirectory()as temporary:
            path=Path(temporary)/'approved-role';path.write_bytes(b'public fixture role bytes, never executed');path.chmod(0o755)
            artifact={'path':str(path),'bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}
            token='123 99 Sat Nov 7 21:12:00 2026 '+str(path);row={'role':'validator','pid':123,'parent_pid':99,'os_start_token':token,'executable':artifact};manifest={'artifacts':{'validator':artifact}}
            with mock.patch.object(evidence,'run_tool',return_value=token)as ps,mock.patch.object(evidence.pathlib.Path,'readlink',return_value=path):
                self.assertTrue(evidence.process_identity(manifest,row,timeout=.25))
            self.assertEqual(ps.call_args.kwargs,{'timeout':.25})


class MetricsWholeDeadlineTests(unittest.TestCase):
    def blocked(self,stage,cancel=False):
        release=threading.Event();entered=threading.Event();closed=threading.Event();shutdown=[]
        class Sock:
            def shutdown(self,kind):shutdown.append(kind);release.set()
        class Response:
            status=200
            def read(self,limit):
                entered.set();release.wait(2);raise ConnectionResetError('bounded mocked trickle')
        class Connection:
            def __init__(self,*a,**k):self.sock=Sock()
            def connect(self):pass
            def request(self,*a):pass
            def getresponse(self):
                if stage=='headers':entered.set();release.wait(2);raise ConnectionResetError('bounded mocked trickle')
                return Response()
            def close(self):closed.set()
        stopped=threading.Event();timer=threading.Timer(.04,stopped.set)if cancel else None
        if timer:timer.start()
        start=time.monotonic()
        try:
            with mock.patch.object(api.http.client,'HTTPConnection',Connection),self.assertRaises((ValueError,ConnectionResetError)):
                api.restart_metrics_sample(12345,time.monotonic_ns()+100_000_000,stopped.is_set)
        finally:
            if timer:timer.join(1)
        self.assertTrue(entered.is_set());self.assertTrue(closed.is_set());self.assertTrue(shutdown);self.assertLess(time.monotonic()-start,.7)
    def test_header_trickle_is_shutdown_at_original_whole_deadline(self):self.blocked('headers')
    def test_body_trickle_is_shutdown_at_original_whole_deadline(self):self.blocked('body')
    def test_cancellation_shuts_header_and_joins_reader(self):self.blocked('headers',True)


if __name__=='__main__':unittest.main()
