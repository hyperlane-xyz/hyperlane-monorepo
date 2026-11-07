"""Fake-clock controls only; no node, process role or native acceptance."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest import mock

HERE=Path(__file__).resolve().parent
# Private overlay in development; CI uses the actual repository sibling modules.
sys.path.insert(0,str(HERE))
from multivm_session import RestartWindow,Session
import multivm_session as api


def credit(window,now,epoch,activity):
    return window.observe(now,epoch,activity,{k:v-1 for k,v in activity.items()})


class RestartWindowTests(unittest.TestCase):
    def activity(self,now):return {'relayer:test1':now-1,'validator:test1':now-2,'scraper:test1':now-3}
    def test_29_999_is_incomplete_30_is_complete(self):
        window=RestartWindow();start=1_000_000_000_000;epoch='a'*64
        for seconds in [0,5,10,15,20,25]:self.assertFalse(credit(window,start+seconds*10**9,epoch,self.activity(start+seconds*10**9)))
        now=start+29_999_000_000;self.assertFalse(credit(window,now,epoch,self.activity(now)))
        now=start+30_000_000_000;self.assertTrue(credit(window,now,epoch,self.activity(now)))
        value=window.evidence();self.assertEqual(value['elapsed_live_ns'],30*10**9);self.assertEqual(len(value['samples']),8)
    def test_startup_pending_then_valid_anchor_has_no_borrowed_time(self):
        window=RestartWindow();window.invalidate();self.assertFalse(window.failed)
        start=100*10**9;self.assertFalse(credit(window,start,'a'*64,self.activity(start)))
        self.assertEqual(window.samples[0]['observed_monotonic_ns'],start)
    def test_midwindow_error_and_epoch_churn_never_reset(self):
        for failure in ['invalidate','churn']:
            window=RestartWindow();start=100*10**9;credit(window,start,'a'*64,self.activity(start))
            if failure=='invalidate':window.invalidate()
            else:
                with self.assertRaises(ValueError):credit(window,start+5*10**9,'b'*64,self.activity(start+5*10**9))
            with self.assertRaises(ValueError):credit(window,start+30*10**9,'a'*64,self.activity(start+30*10**9))
            self.assertEqual(window.samples[0]['observed_monotonic_ns'],start)
    def test_canonical_activity_cannot_make_stale_role_fresh(self):
        window=RestartWindow();start=100*10**9;old=self.activity(start);credit(window,start,'a'*64,old)
        changed=dict(old);changed['relayer:test1']+=5*10**9
        self.assertFalse(credit(window,start+5*10**9,'a'*64,changed));self.assertEqual(len(window.samples),1)
        with self.assertRaises(ValueError):credit(window,start+10*10**9+1,'a'*64,changed)
        self.assertTrue(window.failed)
    def test_clock_rollback_future_activity_or_role_change_poison(self):
        for change in ['clock','future','roles']:
            window=RestartWindow();start=100*10**9;credit(window,start,'a'*64,self.activity(start));now=start+5*10**9;activity=self.activity(now)
            if change=='clock':now=start-1
            if change=='future':activity['validator:test1']=now+1
            if change=='roles':activity.pop('scraper:test1')
            with self.assertRaises(ValueError):credit(window,now,'a'*64,activity)
            self.assertTrue(window.failed)


class ActualSessionBranchTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
        session=Session.__new__(Session);self.session=session;session.lock=threading.RLock();session.failures=[];session.before_restart={};session.after_restart=None;session.restart_window=RestartWindow()
        session.manifest={'scenario':'cosmosnative','artifacts':{role:{'path':'/not-executed/'+role,'bytes':1,'sha256':'0'*64} for role in ['relayer','validator','scraper']}}
        session.case={'initial_corpus':{'deliveries':1}};session.evidence_relative=Path('evidence');session.initial={'capture_count':3,'broadcasts':[]};session.broadcasts=[]
        captures=[];launches=[]
        for epoch in range(2):
            for i,role in enumerate(['relayer','validator','scraper']):
                original={'role':role,'role_chain_names':['test1'],'config':{'private_key':'never-output'}}
                captures.append({'original':original,'proxied':copy.deepcopy(original),'captured_monotonic_ns':100+epoch})
                launches.append({'role':role,'pid':10+epoch*3+i,'parent_pid':9,'os_start_token':'linux-ticks:'+str(epoch*3+i),'executable':session.manifest['artifacts'][role]})
        session.captures=captures;session.activity={(role,'test1'):1000 for role in ['relayer','validator','scraper']};session.successful_activity={(role,'test1'):{'request_started_monotonic_ns':999,'response_received_monotonic_ns':1000} for role in ['relayer','validator','scraper']};(self.root/'evidence').mkdir();(self.root/'evidence/owned-children.jsonl').write_text(''.join(json.dumps(v)+'\n'for v in launches))
        session.owned_path=lambda relative:self.root/relative
        def snapshot(*a,**kw):
            self.assertFalse(session.lock._is_owned());return {'broadcasts':[],'capture_count':6}
        session.canonical_snapshot=snapshot
        session.checkpoint_proofs=lambda value:[];session.checkpoint_publications=lambda value,proofs:proofs;session.append=mock.Mock()
        class Family:
            def readiness(family,*args):
                self.assertFalse(session.lock._is_owned());return {'actual_native_heads':{'test1':7}}
        session.family=Family()
    def tick(self,ns,fresh=True,approval_error=None):
        if fresh:
            self.session.activity={(role,'test1'):ns-i-1 for i,role in enumerate(['relayer','validator','scraper'])}
            self.session.successful_activity={(role,'test1'):{'request_started_monotonic_ns':ns-i-100,'response_received_monotonic_ns':ns-i-1} for i,role in enumerate(['relayer','validator','scraper'])}
        with mock.patch.object(api,'read_approval',side_effect=approval_error),mock.patch.object(api,'process_identity'),mock.patch.object(api.time,'monotonic_ns',return_value=ns),mock.patch.object(api.time,'sleep',side_effect=AssertionError('No in-verifier sleeping')):
            return self.session.verify('after_restart',1)
    def test_actual_branch_pending_startup_then_30s_new_epoch(self):
        old=self.session.family.readiness;self.session.family.readiness=mock.Mock(side_effect=ValueError('startup pending'))
        with self.assertRaises(ValueError):self.tick(100*10**9)
        self.assertFalse(self.session.restart_window.failed);self.session.family.readiness=old
        for second in [0,5,10,15,20,25]:self.assertFalse(self.tick((101+second)*10**9)['verified'])
        self.assertTrue(self.tick(131*10**9)['verified']);proof=self.session.after_restart['same_db_restart_observation']
        self.assertEqual(proof['elapsed_live_ns'],30*10**9);self.assertEqual(len(proof['new_child_identities']),3)
        self.assertEqual(self.session.append.call_args[0][0],'verified-after-restart.jsonl')
    def test_actual_branch_midwindow_callback_error_latches(self):
        self.tick(100*10**9);self.session.family.readiness=mock.Mock(side_effect=ValueError('actual check failed'))
        with self.assertRaises(ValueError):self.tick(105*10**9)
        self.assertTrue(self.session.restart_window.failed)
        self.session.family.readiness=lambda *args:{}
        with self.assertRaises(ValueError):self.tick(135*10**9)
    def test_actual_branch_fresh_canonical_queries_do_not_advance_stale_roles(self):
        self.tick(100*10**9);self.assertFalse(self.tick(105*10**9,fresh=False)['verified'])
        self.assertEqual(len(self.session.restart_window.samples),1)
        with self.assertRaises(ValueError):self.tick(110*10**9+1,fresh=False)
    def test_actual_branch_child_or_config_churn_is_permanent(self):
        self.tick(100*10**9);self.session.captures[-1]['proxied']['config']['new']='churn'
        with self.assertRaises(ValueError):self.tick(105*10**9)
        self.assertTrue(self.session.restart_window.failed)


    def test_actual_branch_approval_error_after_anchor_cannot_resume(self):
        self.tick(100*10**9)
        with self.assertRaises(ValueError):self.tick(105*10**9,approval_error=ValueError('approval changed'))
        self.assertTrue(self.session.restart_window.failed)
        with self.assertRaises(ValueError):self.tick(110*10**9)

    def test_late_old_epoch_response_is_not_new_capture_credit(self):
        # Received time is newer, but the request predates restarted capture101.
        self.session.activity={(role,'test1'):100*10**9 for role in ['relayer','validator','scraper']}
        self.session.successful_activity={(role,'test1'):{'request_started_monotonic_ns':100,'response_received_monotonic_ns':100*10**9}for role in ['relayer','validator','scraper']}
        with self.assertRaises(ValueError):self.tick(100*10**9,fresh=False)
        self.assertEqual(self.session.restart_window.samples,[])
        self.assertFalse(self.session.restart_window.failed)
        self.assertFalse(self.tick(101*10**9)['verified'])
        self.assertEqual(self.session.restart_window.samples[0]['observed_monotonic_ns'],101*10**9)


class MatchedActivityTests(unittest.TestCase):
    def request(self,identity=1):return {'jsonrpc':'2.0','method':'eth_chainId','id':identity}
    def result(self,identity=1):return {'jsonrpc':'2.0','id':identity,'result':'0x1'}
    def error(self,identity=1):return {'jsonrpc':'2.0','id':identity,'error':{'code':-1,'message':'fixture error'}}
    def test_exact_scalar_and_mixed_matched_batch_success(self):
        self.assertTrue(api.successful_json_rpc_exchange(self.request(),self.result()))
        self.assertTrue(api.successful_json_rpc_exchange([self.request(1),self.request(2)],[self.error(2),self.result(1)]))
        self.assertFalse(api.successful_json_rpc_exchange([self.request(1),self.request(2)],[self.error(2),self.error(1)]))
        self.assertFalse(api.successful_json_rpc_exchange(self.request(),self.error()))
    def test_foreign_missing_duplicate_or_malformed_ids_never_count(self):
        requests=[self.request(1),self.request(2)]
        for responses in [[self.result(1),self.result(3)],[self.result(1)],[self.result(1),self.result(1)],[],{},[{'result':1},self.result(2)],[self.result(1),{'jsonrpc':'2.0','id':2}], [self.result(1),{'jsonrpc':'2.0','id':2,'result':1,'error':{}}]]:
            with self.subTest(responses=responses):self.assertFalse(api.successful_json_rpc_exchange(requests,responses))
        self.assertFalse(api.successful_json_rpc_exchange(self.request(True),self.result(1)))
        self.assertFalse(api.successful_json_rpc_exchange(self.request(1),self.result('1')))
        self.assertFalse(api.successful_json_rpc_exchange([self.request(1),self.request(1)],[self.result(1),self.result(1)]))
    def test_actual_observe_all_error_batch_has_no_clock_credit(self):
        from types import SimpleNamespace
        session=Session.__new__(Session);session.manifest={'scenario':'evm'};session.lock=threading.RLock();session.activity={};session.successful_activity={};session.append=lambda *a:None;session.family=SimpleNamespace(observe=lambda *a:None)
        request={'start':'POST / HTTP/1.1','wire':b'public-fixture','json':[self.request(1),self.request(2)],'requested_monotonic_ns':10}
        session.observe('test1','validator','rpcurls','http://127.0.0.1',request,[self.error(1),self.error(2)],200,20,{'wire':b'public-fixture'})
        self.assertEqual(session.activity,{})
        session.observe('test1','validator','rpcurls','http://127.0.0.1',request,[self.error(2),self.result(1)],200,20,{'wire':b'public-fixture'})
        self.assertEqual(session.successful_activity[('validator','test1')],{'request_started_monotonic_ns':10,'response_received_monotonic_ns':20})
    def test_old_inflight_request_does_not_extend_started_window(self):
        window=RestartWindow();now=100*10**9;activity={'validator:test1':now-1};window.observe(now,'a'*64,activity,{'validator:test1':now-2})
        self.assertFalse(window.observe(now+5*10**9,'a'*64,{'validator:test1':now+5*10**9-1},{'validator:test1':now-2}))
        self.assertEqual(len(window.samples),1)


class ResponseAgeTests(unittest.TestCase):
    def test_old_postcapture_response_never_anchors_or_sets_epoch(self):
        window=RestartWindow();now=1000*10**9
        self.assertFalse(window.observe(now,'a'*64,{'validator:test1':now-100*10**9},{'validator:test1':now-100*10**9-1}))
        self.assertEqual(window.samples,[]);self.assertIsNone(window.epoch);self.assertFalse(window.failed)
    def test_stale_startup_then_fresh_window_borrows_no_elapsed(self):
        window=RestartWindow();now=1000*10**9
        self.assertFalse(window.observe(now,'a'*64,{'validator:test1':now-100*10**9},{'validator:test1':now-100*10**9-1}))
        start=now+20*10**9
        for seconds in range(0,30,5):
            stamp=start+seconds*10**9
            self.assertFalse(window.observe(stamp,'b'*64,{'validator:test1':stamp-1},{'validator:test1':stamp-2}))
        stamp=start+30*10**9;self.assertTrue(window.observe(stamp,'b'*64,{'validator:test1':stamp-1},{'validator:test1':stamp-2}));self.assertEqual(window.evidence()['elapsed_live_ns'],30*10**9);self.assertEqual(window.samples[0]['observed_monotonic_ns'],start)
    def test_progressing_but_old_responses_poison_anchored_window(self):
        window=RestartWindow();now=1000*10**9;received=now-9*10**9
        self.assertFalse(window.observe(now,'a'*64,{'validator:test1':received},{'validator:test1':received-1}))
        with self.assertRaisesRegex(ValueError,'older than10s'):window.observe(now+5*10**9,'a'*64,{'validator:test1':received+2},{'validator:test1':received+1})
        self.assertTrue(window.failed)
        with self.assertRaises(ValueError):window.observe(now+6*10**9,'a'*64,{'validator:test1':now+6*10**9-1},{'validator:test1':now+6*10**9-2})
    def test_exact10s_age_allowed_but_one_ns_older_stays_pending(self):
        now=1000*10**9
        for excess in [0,1]:
            window=RestartWindow();received=now-10*10**9-excess
            self.assertFalse(window.observe(now,'a'*64,{'validator:test1':received},{'validator:test1':received-1}))
            self.assertEqual(len(window.samples),0 if excess else 1)

if __name__=='__main__':unittest.main()
