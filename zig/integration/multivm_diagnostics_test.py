"""Public-only diagnostics controls; no native, chain, SDK or process execution."""
from pathlib import Path
import copy
import importlib.util
import json
import hashlib
import ast
import sys
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest import mock
HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
import multivm_diagnostics as api
import multivm_session as sessions


class Controls(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name).resolve()
        self.modules={name:api.pin(HERE/name)for name in ['multivm_session.py','multivm_diagnostics.py']}
    def session(self):
        s=sessions.Session.__new__(sessions.Session);s.manifest={};s.lock=threading.RLock();s.diagnostic_lock=threading.Lock();s.public_diagnostic_recorder=None;s.approval={'python_modules':self.modules};s.evidence_relative=Path('evidence');s.owned_path=lambda path:self.root/path;(self.root/'evidence').mkdir();s.captures=[{'captured_monotonic_ns':10,'original':{'role':'validator','role_chain_names':['public1']}}];s.successful_activity={};s.diagnostic_first_activity={};s.failures=[];s.restart_window=sessions.RestartWindow();s._init_restart_sampler();s.case={'initial_corpus':{'deliveries':8}};s.before_restart={};s.lifecycle=SimpleNamespace(errors=[]);return s
    def state(self,now=100):
        return {'observed_monotonic_ns':now,'restart_sample_count':0,'restart_failed':False,'restart_first_observed_ns':None,'restart_last_observed_ns':None,'role_activity':[],'observer_failure_count':0,'lifecycle_error_count':0}
    def test_inflight_entry_is_durable_before_callback_and_pending_keeps_return(self):
        s=self.session();path=self.root/'evidence/public-observer-diagnostics.json'
        def callback(*args):
            value=json.loads(path.read_text());self.assertEqual(value['last_stage']['status'],'inflight');self.assertIsNone(value['last_stage']['finished_monotonic_ns']);return {'verified':False,'stage':'after_restart'}
        s._verify=callback;result=s.verify('after_restart',8);self.assertFalse(result['verified']);value=json.loads(path.read_text());self.assertEqual(value['last_stage']['status'],'pending');self.assertFalse(value['native_or_timing_credit']);api.validate_record(value,self.modules)
    def test_actual_wrapper_preserves_exception_identity_and_redacts_message(self):
        s=self.session();error=ValueError('DO-NOT-EXPORT-PRIVATE-WIRE-OR-CONFIG')
        def callback(*args):raise error
        s._verify=callback
        with self.assertRaises(ValueError)as caught:s.verify('live',8)
        self.assertIs(caught.exception,error);wire=(self.root/'evidence/public-observer-diagnostics.json').read_text();self.assertNotIn('DO-NOT-EXPORT',wire);value=json.loads(wire);self.assertEqual(value['last_stage']['exception_type'],'ValueError');self.assertEqual(value['last_stage']['status'],'exception');self.assertNotIn('"locals":',wire);api.validate_record(value,self.modules)
    def test_approval_error_is_inside_actual_diagnostic_boundary_and_still_sticky(self):
        s=self.session();s.restart_window.observe(100,'a'*64,{'v':99},{'v':98});error=ValueError('PRIVATE-APPROVAL-PAYLOAD')
        with mock.patch.object(sessions,'read_approval',side_effect=error),self.assertRaises(ValueError)as caught:s.verify('after_restart',8)
        self.assertIs(caught.exception,error);self.assertTrue(s.restart_window.failed);value=json.loads((self.root/'evidence/public-observer-diagnostics.json').read_text());self.assertEqual(value['stages']['after_restart']['latest']['stage'],'after_restart');self.assertTrue(value['stages']['after_restart']['latest']['state']['restart_failed']);self.assertTrue(any(v['function']=='_verify'for v in value['stages']['after_restart']['latest']['frames']));self.assertNotIn('PRIVATE-APPROVAL',json.dumps(value))
    def test_diagnostic_write_failure_never_replaces_original_verifier_failure(self):
        s=self.session();error=ValueError('business')
        def callback(*args):raise error
        s._verify=callback
        with mock.patch.object(api.Recorder,'enter',side_effect=OSError('diagnostic')),self.assertRaises(ValueError)as caught:s.verify('live',8)
        self.assertIs(caught.exception,error);self.assertTrue(s.public_diagnostic_write_failed)
    def test_first_new_capture_and_latest_real_request_response_clocks_only(self):
        s=self.session();api.note_success(s,'validator','public1',11,12);api.note_success(s,'validator','public1',14,15);s.successful_activity[('validator','public1')]={'request_started_monotonic_ns':14,'response_received_monotonic_ns':15};value=api.snapshot(s,20);row=value['role_activity'][0];self.assertEqual(row['first_successful_new_capture_exchange']['request_started_monotonic_ns'],11);self.assertEqual(row['latest_successful_exchange']['response_age_ns'],5)
        s.captures.append({'captured_monotonic_ns':30,'original':{'role':'validator','role_chain_names':['public1']}});api.note_success(s,'validator','public1',21,35);self.assertIsNone(api.snapshot(s,36)['role_activity'][0]['first_successful_new_capture_exchange']);api.note_success(s,'validator','public1',31,34);self.assertEqual(api.snapshot(s,36)['role_activity'][0]['first_successful_new_capture_exchange']['response_age_ns'],2)
    def test_unapproved_or_changed_source_frames_are_never_published(self):
        directory=self.root/'source';directory.mkdir();source=directory/'multivm_control.py';source.write_text("def fail():\n    raise ValueError('PRIVATE')\n");env={};exec(compile(source.read_text(),str(source),'exec'),env);modules={source.name:api.pin(source)}
        try:env['fail']()
        except ValueError as error:
            value=api.public_frames(error,modules,directory);self.assertEqual(value['frames'][0]['function'],'fail');self.assertEqual(value['frames'][0]['line'],2);self.assertNotIn('PRIVATE',json.dumps(value));source.write_text('changed source');self.assertEqual(api.public_frames(error,modules,directory)['frames'],[])
    def test_error_dedup_keeps_first_latest_and_counts_without_messages(self):
        recorder=api.Recorder(self.root/'record.json',self.modules,HERE)
        for i in range(12):
            token=recorder.enter('live',self.state(i*2+1));recorder.finish(token,self.state(i*2+2),'exception',ValueError('PRIVATE-'+str(i)))
        value=json.loads((self.root/'record.json').read_text());self.assertEqual(len(value['failures']),1);row=next(iter(value['failures'].values()));self.assertEqual(row['count'],12);self.assertEqual(row['first']['attempt'],1);self.assertEqual(row['latest']['attempt'],12);self.assertNotIn('PRIVATE',json.dumps(value));api.validate_record(value,self.modules)
    def test_signature_count_and_output_bytes_are_bounded(self):
        recorder=api.Recorder(self.root/'record.json',self.modules,HERE)
        for i in range(12):
            token=recorder.enter('live',self.state(i*2+1));recorder.finish(token,self.state(i*2+2),'exception',type('E_'+str(i),(ValueError,),{})())
        value=json.loads((self.root/'record.json').read_text());self.assertEqual(len(value['failures']),8);self.assertEqual(value['dropped_new_failure_signatures'],4);self.assertLess((self.root/'record.json').stat().st_size,api.LIMIT)
    def test_unknown_nested_fields_or_source_pins_rejected_before_publication(self):
        recorder=api.Recorder(self.root/'record.json',self.modules,HERE);recorder.enter('live',self.state());value=json.loads((self.root/'record.json').read_text())
        for where in ['root','state']:
            bad=copy.deepcopy(value)
            if where=='root':bad['private_env']='PRIVATE'
            else:bad['last_stage']['state']['private_wire']='PRIVATE'
            with self.assertRaises(ValueError):api.validate_record(bad,self.modules)
    def startup_fixture(self):
        entry=self.root/'multivm_process.py';entry.write_text('entry line1\nentry line2\nentry line3\n');source=self.root/'multivm_startup_control.py';source.write_text('module line1\nmodule line2\nmodule line3\n');log=self.root/'observer.log';modules={source.name:api.pin(source)}
        return entry,source,log,modules
    def test_startup_real_checkout_entry_matches_actual_manifest_construction(self):
        # Evaluate ONLY the actual Source manifest's entry descriptor expression;
        # never import its builder or invoke main/native work.
        source=HERE/'native_case_inputs.py';tree=ast.parse(source.read_text());candidates=[]
        for node in ast.walk(tree):
            if isinstance(node,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='manifest'for t in node.targets)and isinstance(node.value,ast.Dict):
                for key,value in zip(node.value.keys,node.value.values):
                    if isinstance(key,ast.Constant)and key.value=='verifier':candidates.append(value)
        self.assertEqual(len(candidates),1)
        verifier=candidates[0];expression=next(value for key,value in zip(verifier.keys,verifier.values)if isinstance(key,ast.Constant)and key.value=='script')
        entry=eval(compile(ast.Expression(body=expression),str(source),'eval'),{'repo':HERE.parents[1],'artifact':api.pin})
        self.assertEqual(Path(entry['path']),HERE/'multivm_process.py');self.assertFalse((HERE/'multivm.py').exists())
        log=self.root/'actual-entry.log';log.write_text('Traceback (most recent call last):\n  File "'+entry['path']+'", line 2, in <module>\nValueError: PRIVATE\n')
        result=api.observer_startup_sites(log,{},HERE,entry);self.assertEqual(result['frames'][0]['module'],'multivm_process.py');self.assertEqual(result['frames'][0]['source'],entry);self.assertNotIn('PRIVATE',json.dumps(result))
        wrong=dict(entry,path=str(HERE/'multivm.py'))
        with self.assertRaises(ValueError):api.observer_startup_sites(log,{},HERE,wrong)
    def test_startup_traceback_only_pinned_frames_and_entry_never_body_env(self):
        entry,source,log,modules=self.startup_fixture()
        log.write_text('Traceback (most recent call last):\n  File "'+str(entry)+'", line 2, in <module>\n    PRIVATE-SOURCE-LINE\n  File "'+str(source)+'", line 3, in load_module\n    PRIVATE-PAYLOAD\n  File "/unapproved/site.py", line 1, in private_function\nValueError: PRIVATE-ERROR-ENV-KEY-WIRE\n')
        result=api.observer_startup_sites(log,modules,self.root,api.pin(entry));self.assertEqual([v['module']for v in result['frames']],['multivm_process.py',source.name]);self.assertEqual(result['unapproved_frames_omitted'],1);self.assertEqual(result['recognized_tracebacks'],1);self.assertNotIn('PRIVATE',json.dumps(result));self.assertFalse(result['native_or_timing_credit']);self.assertEqual(result['log']['sha256'],hashlib.sha256(log.read_bytes()).hexdigest())
    def test_startup_unanchored_malformed_outofrange_and_source_drift_refuse(self):
        entry,source,log,modules=self.startup_fixture();line='  File "'+str(source)+'", line 2, in startup\n'
        for raw in (line,'Traceback (most recent call last):\n'+line.replace('line 2','line 999'),'Traceback (most recent call last):\n'+line.replace('in startup','in PRIVATE-UNSAFE-FUNCTION')):
            log.write_text(raw);self.assertEqual(api.observer_startup_sites(log,modules,self.root,api.pin(entry))['frames'],[])
        log.write_text('Traceback (most recent call last):\n'+line);source.write_text('changed\n');self.assertEqual(api.observer_startup_sites(log,modules,self.root,api.pin(entry))['frames'],[])
    def test_printed_function_names_never_become_public_payload(self):
        entry,source,log,modules=self.startup_fixture()
        log.write_text('Traceback (most recent call last):\n  File "'+str(source)+'", line 2, in PRIVATE_PAYLOAD_TOKEN\n')
        result=api.observer_startup_sites(log,modules,self.root,api.pin(entry));self.assertEqual(len(result['frames']),1);self.assertNotIn('PRIVATE',json.dumps(result));self.assertEqual(set(result['frames'][0]),{'module','source','line'})
    def test_startup_log_bound_symlink_and_snapshot_mutation_refuse(self):
        entry,source,log,modules=self.startup_fixture();log.symlink_to(source)
        with self.assertRaises(ValueError):api.observer_startup_sites(log,modules,self.root,api.pin(entry))
        log.unlink();log.write_text('Traceback (most recent call last):\n');original=Path.read_bytes
        def read(path):
            raw=original(path)
            if path==log:log.write_bytes(raw+b'PRIVATE-APPEND')
            return raw
        with mock.patch.object(Path,'read_bytes',read),self.assertRaisesRegex(ValueError,'changed'):api.observer_startup_sites(log,modules,self.root,api.pin(entry))
        with log.open('wb')as stream:stream.truncate(32*1024**2+1)
        with self.assertRaisesRegex(ValueError,'Bounded'):api.observer_startup_sites(log,modules,self.root,api.pin(entry))

    def test_Rust198_numeric_thread_header_projects_only_pinned_source_location(self):
        repo=self.root/'repo';path=repo/'rust/main/utils/run-locally/src/utils.rs';path.parent.mkdir(parents=True);path.write_text('line1\nline2\nline3\n');sources={str(path.relative_to(repo)):api.pin(path)};log=self.root/'harness.log'
        # Exact std1.98 default_hook: thread name, numeric OS tid, then location.
        log.write_text("thread 'PRIVATE-THREAD' (9455) panicked at utils/run-locally/src/utils.rs:2:3:\nPRIVATE-PAYLOAD\n")
        result=api.rust_panic_sites(log,sources,repo);self.assertEqual(len(result),1);self.assertEqual(result[0]['line'],2);self.assertNotIn('PRIVATE',json.dumps(result));self.assertNotIn('9455',json.dumps(result))
        for header in ("thread 'name' (PRIVATE)","thread 'name' (-1)","thread 'name' ("+'1'*21+")","prefix thread 'name' (9455)"):
            log.write_text(header+' panicked at utils/run-locally/src/utils.rs:2:3:\n');self.assertEqual(api.rust_panic_sites(log,sources,repo),[])
        log.write_text("thread 'name' (9455) panicked at utils/run-locally/src/utils.rs:999:3:\n");self.assertEqual(api.rust_panic_sites(log,sources,repo),[])
        log.write_text("thread 'name' (9455) panicked at utils/run-locally/src/utils.rs:2:3:\n");path.write_text('changed');self.assertEqual(api.rust_panic_sites(log,sources,repo),[])

    def test_Rust_panic_location_requires_canonical_header_exact_pinned_file_and_line(self):
        repo=self.root/'repo';path=repo/'rust/main/utils/run-locally/src/main.rs';path.parent.mkdir(parents=True);path.write_text('line1\nline2\nline3\n');sources={str(path.relative_to(repo)):api.pin(path)};log=self.root/'harness.log';log.write_text("thread 'main' panicked at utils/run-locally/src/main.rs:2:3:\nPRIVATE-MESSAGE\nnot-a-header panicked at rust/main/utils/run-locally/src/main.rs:1:1:\nthread 'other' panicked at rust/main/utils/run-locally/src/foreign.rs:2:3:\n")
        result=api.rust_panic_sites(log,sources,repo);self.assertEqual(len(result),1);self.assertEqual(result[0]['line'],2);self.assertNotIn('PRIVATE',json.dumps(result));path.write_text('changed');self.assertEqual(api.rust_panic_sites(log,sources,repo),[])

    def test_blocked_callback_retains_inflight_state_without_inventing_completion(self):
        s=self.session();entered=threading.Event();release=threading.Event();result=[]
        def callback(*args):
            entered.set();release.wait(2);return {'verified':False}
        s._verify=callback
        thread=threading.Thread(target=lambda:result.append(s.verify('after_restart',8)));thread.start()
        try:
            self.assertTrue(entered.wait(1));value=json.loads((self.root/'evidence/public-observer-diagnostics.json').read_text());self.assertEqual(value['last_stage']['status'],'inflight');self.assertIsNone(value['last_stage']['finished_monotonic_ns']);self.assertFalse(result)
        finally:release.set();thread.join(2)
        self.assertFalse(thread.is_alive());self.assertEqual(result,[{'verified':False}]);self.assertEqual(json.loads((self.root/'evidence/public-observer-diagnostics.json').read_text())['last_stage']['status'],'pending')

if __name__=='__main__':unittest.main()
