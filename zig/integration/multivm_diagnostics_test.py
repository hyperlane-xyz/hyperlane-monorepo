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
    def test_capture_entry_records_inflight_and_preserves_exact_success_reply(self):
        s=self.session();request=object();reply={'schema':1,'environment':{'private':'PRIVATE-REPLY'}};path=self.root/'evidence/public-observer-diagnostics.json'
        def callback(actual):
            self.assertIs(actual,request);value=json.loads(path.read_text());self.assertEqual(value['stages']['capture']['latest']['status'],'inflight');return reply
        s._capture=callback;self.assertIs(s.capture(request),reply);value=json.loads(path.read_text());self.assertEqual(value['stages']['capture']['latest']['status'],'completed');self.assertNotIn('PRIVATE',json.dumps(value));api.validate_record(value,self.modules)
    def test_capture_original_approval_failure_has_exact_source_frame_no_request_or_message(self):
        s=self.session();request={'private':'PRIVATE-REQUEST'};error=ValueError('PRIVATE-CONFIG-ARGV-KEY')
        with mock.patch.object(sessions,'read_approval',side_effect=error),self.assertRaises(ValueError)as caught:s.capture(request)
        self.assertIs(caught.exception,error);value=json.loads((self.root/'evidence/public-observer-diagnostics.json').read_text());row=value['stages']['capture']['latest'];self.assertEqual(row['exception_type'],'ValueError');self.assertEqual(row['status'],'exception');self.assertTrue(any(v['function']=='_capture' and v['source']==self.modules['multivm_session.py']for v in row['frames']));self.assertNotIn('PRIVATE',json.dumps(value));api.validate_record(value,self.modules)
    def test_capture_exception_identity_preserved_when_diagnostic_entry_or_finish_fails(self):
        for method in ['enter','finish']:
            with self.subTest(method=method):
                s=self.session();error=ValueError('PRIVATE-PRIMARY')
                def callback(request):raise error
                s._capture=callback
                with mock.patch.object(api.Recorder,method,side_effect=OSError('PRIVATE-DIAGNOSTIC')),self.assertRaises(ValueError)as caught:s.capture(object())
                self.assertIs(caught.exception,error);self.assertTrue(s.public_diagnostic_write_failed)
                # Separate owned output for each independent case.
                import shutil
                shutil.rmtree(self.root/'evidence')
    def test_capture_success_not_replaced_when_diagnostic_finish_fails(self):
        s=self.session();reply=object();s._capture=lambda request:reply
        with mock.patch.object(api.Recorder,'finish',side_effect=OSError('PRIVATE-DIAGNOSTIC')):self.assertIs(s.capture(object()),reply)
        self.assertTrue(s.public_diagnostic_write_failed)
    def test_shutdown_retains_current_captured_role_RPC_clocks_without_forcing_any_probe(self):
        s=self.session();s.successful_activity={('validator','public1'):{'request_started_monotonic_ns':30,'response_received_monotonic_ns':40}};s.diagnostic_first_activity={('validator','public1'):{'capture_monotonic_ns':10,'request_started_monotonic_ns':20,'response_received_monotonic_ns':25}};reply=object();called=[];s._close=lambda:called.append('original-close')or reply
        with mock.patch.object(sessions.time,'monotonic_ns',side_effect=[50,60]):self.assertIs(s.close(),reply)
        value=json.loads((self.root/'evidence/public-observer-diagnostics.json').read_text());row=value['stages']['shutdown']['latest'];self.assertEqual(called,['original-close']);self.assertEqual(row['status'],'completed');self.assertEqual(row['state']['role_activity'][0]['latest_successful_exchange'],{'request_started_monotonic_ns':30,'response_received_monotonic_ns':40,'request_age_ns':30,'response_age_ns':20});api.validate_record(value,self.modules)
    def test_shutdown_preserves_original_exception_and_only_approved_Source_frames(self):
        s=self.session();s.stop=threading.Event();s.sampler=mock.Mock();s.sampler.is_alive.return_value=True;s.proxies=[]
        with self.assertRaises(ValueError):s.close()
        value=json.loads((self.root/'evidence/public-observer-diagnostics.json').read_text());row=value['stages']['shutdown']['latest'];self.assertEqual(row['status'],'exception');self.assertTrue(any(frame['function']=='_close'for frame in row['frames']));self.assertNotIn('PRIVATE',json.dumps(value));api.validate_record(value,self.modules)
    def test_shutdown_observation_failure_cannot_replace_original_close_result_or_exception(self):
        s=self.session();reply=object();s._close=lambda:reply
        with mock.patch.object(api.Recorder,'finish',side_effect=OSError('PRIVATE-DIAGNOSTIC')):self.assertIs(s.close(),reply)
        self.assertTrue(s.public_diagnostic_write_failed);error=ValueError('PRIVATE-PRIMARY')
        def fail():raise error
        s._close=fail
        with mock.patch.object(api.Recorder,'enter',side_effect=OSError('PRIVATE-DIAGNOSTIC')),self.assertRaises(ValueError)as caught:s.close()
        self.assertIs(caught.exception,error)
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
        result=api.rust_panic_observation(log,sources,repo)['sites'];self.assertEqual(len(result),1);self.assertEqual(result[0]['line'],2);self.assertNotIn('PRIVATE',json.dumps(result));self.assertNotIn('9455',json.dumps(result))
        for header in ("thread 'name' (PRIVATE)","thread 'name' (-1)","thread 'name' ("+'1'*21+")","prefix thread 'name' (9455)"):
            log.write_text(header+' panicked at utils/run-locally/src/utils.rs:2:3:\n');self.assertEqual(api.rust_panic_observation(log,sources,repo)['sites'],[])
        log.write_text("thread 'name' (9455) panicked at utils/run-locally/src/utils.rs:999:3:\n");self.assertEqual(api.rust_panic_observation(log,sources,repo)['sites'],[])
        log.write_text("thread 'name' (9455) panicked at utils/run-locally/src/utils.rs:2:3:\n");path.write_text('changed');self.assertEqual(api.rust_panic_observation(log,sources,repo)['sites'],[])

    def test_Rust_panic_location_requires_canonical_header_exact_pinned_file_and_line(self):
        repo=self.root/'repo';path=repo/'rust/main/utils/run-locally/src/main.rs';path.parent.mkdir(parents=True);path.write_text('line1\nline2\nline3\n');sources={str(path.relative_to(repo)):api.pin(path)};log=self.root/'harness.log';log.write_text("thread 'main' panicked at utils/run-locally/src/main.rs:2:3:\nPRIVATE-MESSAGE\nnot-a-header panicked at rust/main/utils/run-locally/src/main.rs:1:1:\nthread 'other' panicked at rust/main/utils/run-locally/src/foreign.rs:2:3:\n")
        result=api.rust_panic_observation(log,sources,repo)['sites'];self.assertEqual(len(result),1);self.assertEqual(result[0]['line'],2);self.assertNotIn('PRIVATE',json.dumps(result));path.write_text('changed');self.assertEqual(api.rust_panic_observation(log,sources,repo)['sites'],[])

    def reason_fixture(self):
        repo=self.root/'reason-repo';helper=repo/'rust/main/utils/run-locally/src/external_agents.rs';helper.parent.mkdir(parents=True)
        helper.write_text('pub fn svm_tempfile() -> Result<tempfile::NamedTempFile> {\ncreate_owned_directory(&manifest.task_root, Path::new("tmp"))?;\ntempfile::NamedTempFile::new_in(root)?;\n"symlink in owned writable path: {}"\n"owned parent is not a directory"\n}\n')
        caller=repo/'rust/main/utils/run-locally/src/sealevel/warp_route_composite_ism.rs';caller.parent.mkdir();caller.write_text('line1\ncrate::external_agents::svm_tempfile().expect("Failed to create temp ISM config");\nline3\n')
        sources={str(p.relative_to(repo)):api.pin(p)for p in [helper,caller]};log=self.root/'harness.log';header="thread 'PRIVATE-THREAD' (9455) panicked at utils/run-locally/src/sealevel/warp_route_composite_ism.rs:2:3:\n";return repo,helper,caller,sources,log,header

    def test_panic_reason_codes_require_source_bound_SVM_message_and_never_export_body(self):
        repo,helper,caller,sources,log,header=self.reason_fixture();message='Failed to create temp ISM config: symlink in owned writable path: PRIVATE-PATH; owned parent is not a directory; No space left on device; Permission denied; File exists; https://user:PRIVATE-TOKEN@invalid; PRIVATE-KEY-ARGV-ENV'
        log.write_text(header+message+'\n');value=api.rust_panic_observation(log,sources,repo)
        self.assertEqual(value['reason_codes'],['IO_FILE_EXISTS','IO_NO_SPACE_LEFT','IO_PERMISSION_DENIED','OWNED_PARENT_NOT_DIRECTORY','OWNED_PATH_SYMLINK']);self.assertEqual(value['reason_source'],{'module':str(helper.relative_to(repo)),'source':api.pin(helper),'owned_path_guard_literals_verified':True,'tempfile_directory_and_file_calls_verified':True});self.assertEqual(len(value['sites']),1);self.assertEqual(value['log_fingerprint'],{'path':str(log),'bytes':log.stat().st_size,'sha256':hashlib.sha256(log.read_bytes()).hexdigest()});self.assertNotIn('PRIVATE',json.dumps(value));self.assertNotIn('https://',json.dumps(value));self.assertEqual(set(value),{'sites','reason_codes','reason_source','log_fingerprint'})

    def test_actual_new_Source_tempfile_allocator_has_sites_without_old_chain_reason_authority(self):
        repo=Path(__file__).resolve().parents[2];helper=repo/'rust/main/utils/run-locally/src/external_agents.rs';caller=repo/'rust/main/utils/run-locally/src/sealevel/warp_route_composite_ism.rs';sources={str(p.relative_to(repo)):api.pin(p)for p in [helper,caller]}
        line=next(i for i,text in enumerate(caller.read_text().splitlines(),1)if 'svm_tempfile().expect("Failed to create temp ISM config")'in text);log=self.root/'actual-source-harness.log'
        log.write_text("thread 'PRIVATE' (42) panicked at utils/run-locally/src/sealevel/warp_route_composite_ism.rs:"+str(line)+":1:\nFailed to create temp ISM config: symlink in owned writable path: PRIVATE; owned parent is not a directory; No space left on device; Permission denied; File exists\n")
        self.assertIn('fn svm_temporary_parent(',helper.read_text());self.assertNotIn('create_owned_directory(&manifest.task_root, Path::new("tmp"))?;',helper.read_text());value=api.rust_panic_observation(log,sources,repo);self.assertEqual(value['reason_codes'],[]);self.assertIsNone(value['reason_source']);self.assertEqual(value['sites'][0]['source'],api.pin(caller));self.assertEqual(value['sites'][0]['line'],line);self.assertNotIn('PRIVATE',json.dumps(value))

    def test_missing_changed_or_literal_incomplete_helper_refuses_all_reason_authority(self):
        repo,helper,caller,sources,log,header=self.reason_fixture();log.write_text(header+'Failed to create temp ISM config: Permission denied\n')
        absent={k:v for k,v in sources.items()if not k.endswith('/external_agents.rs')};self.assertEqual(api.rust_panic_observation(log,absent,repo)['reason_codes'],[])
        helper.write_text(helper.read_text().replace('"symlink in owned writable path: {}"','"different guard"'));self.assertEqual(api.rust_panic_observation(log,sources,repo)['reason_codes'],[])
        changed={**sources,str(helper.relative_to(repo)):api.pin(helper)};self.assertEqual(api.rust_panic_observation(log,changed,repo)['reason_codes'],[])

    def test_reason_tokens_outside_exact_panic_message_window_never_classified(self):
        repo,helper,caller,sources,log,header=self.reason_fixture()
        for body in ['Permission denied\n'+header+'ordinary panic\nFailed to create temp ISM config: No space left on device\n',header+'wrong-prefix Permission denied\n',header.replace(':2:3:',':3:3:')+'Failed to create temp ISM config: Permission denied\n',header+'Failed to create temp ISM config: unknown error\nPermission denied\n']:
            log.write_text(body);self.assertEqual(api.rust_panic_observation(log,sources,repo)['reason_codes'],[])
        caller.write_text('line1\nnot_the_admitted_tempfile_call();\nline3\n');sources[str(caller.relative_to(repo))]=api.pin(caller);log.write_text(header+'Failed to create temp ISM config: Permission denied\n');self.assertEqual(api.rust_panic_observation(log,sources,repo)['reason_codes'],[])

    def test_later_approved_token_cannot_replace_actual_header_location_for_reason_authority(self):
        repo,helper,caller,sources,log,header=self.reason_fixture();other=repo/'rust/main/utils/run-locally/src/main.rs';other.write_text('line1\nline2\n');sources[str(other.relative_to(repo))]=api.pin(other)
        later=' utils/run-locally/src/sealevel/warp_route_composite_ism.rs:2:3: Failed to create temp ISM config: Permission denied\n'
        for actual in ['utils/run-locally/src/main.rs:2:1:','/outside/foreign.rs:2:1:']:
            log.write_text("thread 'PRIVATE' (42) panicked at "+actual+later);value=api.rust_panic_observation(log,sources,repo);self.assertEqual(value['reason_codes'],[]);self.assertIsNone(value['reason_source']);self.assertNotIn('PRIVATE',json.dumps(value))
        # The qualified actual Source site still admits the exact next message.
        log.write_text(header+'Failed to create temp ISM config: Permission denied\n');self.assertEqual(api.rust_panic_observation(log,sources,repo)['reason_codes'],['IO_PERMISSION_DENIED'])

    def test_single_log_capture_uses_its_hash_and_refuses_changed_or_oversize_data(self):
        repo,helper,caller,sources,log,header=self.reason_fixture();log.write_text(header+'Failed to create temp ISM config: No space left on device\n');original_open=api.os.open;opens=[]
        def opened(path,*args,**kwargs):
            if Path(path)==log:opens.append(path)
            return original_open(path,*args,**kwargs)
        with mock.patch.object(api.os,'open',side_effect=opened):value=api.rust_panic_observation(log,sources,repo)
        self.assertEqual(len(opens),1);self.assertEqual(value['reason_codes'],['IO_NO_SPACE_LEFT'])
        with log.open('wb')as stream:stream.truncate(32*1024**2+1)
        with mock.patch.object(api.os,'open',side_effect=AssertionError('oversize may not open')),self.assertRaisesRegex(ValueError,'Bounded'):api.rust_panic_observation(log,sources,repo)
        log.unlink();target=self.root/'real-private-log';target.write_text(header+'Failed to create temp ISM config: File exists\n');log.symlink_to(target)
        with mock.patch.object(api.os,'open',side_effect=AssertionError('symlink may not open')),self.assertRaisesRegex(ValueError,'Bounded'):api.rust_panic_observation(log,sources,repo)
        log.unlink();log.write_text(header+'Failed to create temp ISM config: File exists\n');original_fdopen=api.os.fdopen
        def fdopen(fd,*args,**kwargs):
            result=original_fdopen(fd,*args,**kwargs);log.write_bytes(log.read_bytes()+b'PRIVATE-APPEND');return result
        with mock.patch.object(api.os,'fdopen',side_effect=fdopen),self.assertRaisesRegex(ValueError,'changed'):api.rust_panic_observation(log,sources,repo)

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


class RoleFailureProjectionControls(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.case=Path(self.temp.name).resolve();(self.case/'evidence').mkdir();(self.case/'agent-logs').mkdir();self.repo=self.case/'repo';self.repo.mkdir()
        self.names=['rust/main/utils/run-locally/src/'+n for n in ['external_agents.rs','program.rs','main.rs','sealevel/mod.rs','logging.rs']]
        bodies=[b'pub struct OwnedChild\nstruct ChildExit\n.join("parent-child-exits.jsonl")\nimpl Drop for TrackedChild',b'format!("{log_prefix}-output.log")\nprintln!("<{prefix}> {line}")\nlog!("Error reading from output for {}: {}", prefix, e)',b'create_owned_path(Path::new("/tmp/test_logs"), "agent-logs")',b'.spawn("RLY", Some(&AGENT_LOGGING_DIR))',b'::std::println!(concat!("<E2E> ", $arg), $($rest)*)']
        self.sources={}
        for name,body in zip(self.names,bodies):
            target=self.repo/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(body);self.sources[name]={'path':str(target),'bytes':len(body),'sha256':hashlib.sha256(body).hexdigest()}
        self.products={role:{'path':str(self.case/role),'bytes':1,'sha256':hashlib.sha256(role.encode()).hexdigest()}for role in ['relayer','validator','scraper']}
        self.manifest={'scenario':'sealevel','artifacts':self.products};self.owned=[];self.exits=[]
        for i,role in enumerate(self.products,10):
            row={'pid':i,'parent_pid':42,'role':role,'executable':self.products[role],'os_start_token':'PRIVATE_START_'+str(i),'scope':'PRIVATE_SCOPE'};self.owned.append(row)
            self.exits.append({**row,'parent_wait_completed':True,'already_exited':role=='relayer','forced_kill':False,'success':False,'exit_code':None,'signal':6 if role=='relayer'else 15,'purpose':'unwind_or_early_drop','planned_exit':False})
        self.zig_sources={};self.log=self.case/'harness.log';self.log.write_bytes(b'<SCR> error: PrivateFailureName\nDO-NOT-EXPORT-AUTHORIZATION\n')
        (self.case/'agent-logs/RLY-output.log').write_bytes(b'thread 100 panic: integer overflow\nPRIVATE_KEYS_AND_CONFIG\n')
        self.save()

    def save(self):
        for name,rows in [('owned-children.jsonl',self.owned),('parent-child-exits.jsonl',self.exits)]:
            (self.case/'evidence'/name).write_text(''.join(json.dumps(row)+'\n'for row in rows))

    def observe(self):return api.role_failure_observation(self.case,self.manifest,42,self.sources,self.repo,self.log,self.zig_sources)

    def test_actual_signal_parent_receipt_join_and_finite_panic_flags_never_publish_private_fields(self):
        value=self.observe();relayer=next(r for r in value['roles']if r['role']=='relayer')
        self.assertTrue(relayer['actual_parent_wait']['already_exited']);self.assertEqual(relayer['actual_parent_wait']['signal'],6);self.assertEqual(relayer['executable'],self.products['relayer'])
        flags=next(r for r in value['fixed_role_logs']if r['role']=='relayer')['finite_observed_flags'];self.assertEqual(flags,['INTEGER_OVERFLOW','PANIC_HEADER_OBSERVED'])
        self.assertEqual(next(r for r in value['fixed_role_logs']if r['role']=='scraper')['finite_observed_flags'],['ERROR_RETURN_HEADER_OBSERVED'])
        wire=json.dumps(value)
        for secret in ['PRIVATE_START','PRIVATE_SCOPE','PRIVATE_KEYS','PrivateFailureName','AUTHORIZATION']:self.assertNotIn(secret,wire)
        self.assertFalse(value['native_or_timing_or_cleanup_authority']);self.assertFalse(next(r for r in value['fixed_role_logs']if r['role']=='relayer')['exact_pid_or_epoch_attribution'])

    def test_actual_current_helper_Source_matches_fixed_journal_and_log_contract(self):
        repo=Path(__file__).resolve().parents[2]
        sources={}
        for name in self.names:
            source=repo/name;raw=source.read_bytes();sources[name]={'path':str(source),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
        self.repo,self.sources=repo,sources
        value=self.observe();self.assertEqual(set(value['writer_sources']),set(self.names));self.assertEqual(len(value['roles']),3)

    def test_composite_projection_does_not_invent_scraper_or_extra_validator_logs(self):
        name='rust/main/utils/run-locally/src/sealevel/warp_route_composite_ism.rs';target=self.repo/name;target.write_bytes(b'.spawn("RLY", Some(&AGENT_LOGGING_DIR))');raw=target.read_bytes();self.sources[name]={'path':str(target),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
        self.manifest['scenario']='sealevel-composite';self.owned=[r for r in self.owned if r['role']!='scraper'];self.exits=[r for r in self.exits if r['role']!='scraper'];self.save()
        value=self.observe();self.assertEqual({r['role']for r in value['roles']},{'relayer','validator'});self.assertEqual([r['fixed_log']for r in value['fixed_role_logs']],['agent-logs/RLY-output.log','agent-logs/VL1-output.log','harness.log prefix RLY','harness.log prefix VL1'])

    def test_unmatched_epoch_product_parent_and_bool_status_refuse(self):
        original=copy.deepcopy(self.exits)
        for key,value in [('pid',99),('parent_pid',43),('os_start_token','foreign'),('executable',self.products['validator']),('exit_code',True),('signal',True),('parent_wait_completed',False)]:
            self.exits=copy.deepcopy(original);self.exits[0][key]=value;self.save()
            with self.subTest(key=key),self.assertRaises(ValueError):self.observe()
        self.exits=original+[copy.deepcopy(original[0])];self.save()
        with self.assertRaises(ValueError):self.observe()

    def test_missing_exit_does_not_invent_child_status_and_false_panic_substring_is_not_classified(self):
        self.exits=[];self.save();(self.case/'agent-logs/RLY-output.log').write_bytes(b'PRIVATE panic: integer overflow\nthread 1 panic: SECRET integer overflow\n')
        value=self.observe();self.assertTrue(all(r['status']=='parent_wait_not_recorded'and 'actual_parent_wait'not in r for r in value['roles']))
        self.assertEqual(next(r for r in value['fixed_role_logs']if r['role']=='relayer')['finite_observed_flags'],['PANIC_HEADER_OBSERVED'])

    def test_changed_source_linked_or_oversized_journal_refuses_without_reading_raw_body(self):
        target=self.repo/self.names[0];original=target.read_bytes();target.write_bytes(original+b' source changed without removing contract markers')
        with self.assertRaises(ValueError):self.observe()
        target.write_bytes(original);journal=self.case/'evidence/parent-child-exits.jsonl';journal.unlink();journal.symlink_to(self.log)
        with self.assertRaises(ValueError):self.observe()
        journal.unlink()
        with journal.open('wb')as stream:stream.truncate(1024**2+1)
        with mock.patch.object(api.os,'open',side_effect=AssertionError('must refuse before open')):
            with self.assertRaises(ValueError):api.captured_failure_bytes(journal,1024**2)

    def test_missing_or_linked_role_log_is_unavailable_not_foreign_file_read(self):
        target=self.case/'agent-logs/RLY-output.log';target.unlink();target.symlink_to(self.log)
        with self.assertRaises(ValueError):self.observe()
        target.unlink();value=self.observe();self.assertEqual(next(r for r in value['fixed_role_logs']if r['role']=='relayer')['status'],'absent')


    def test_all_actual_SVM_harness_prefixes_capture_stderr_flags_when_stdout_is_empty(self):
        (self.case/'agent-logs/RLY-output.log').write_bytes(b'')
        self.log.write_bytes(b'<RLY> thread 10 panic: integer overflow\n<VL1> thread 11 panic: reached unreachable code\n<VL2> error: PrivateFailureName\n<VL3> panic: attempt to use null value\n<SCR> error: OtherPrivateFailure\n<OTHER> panic: incorrect alignment\n<RLY-private> panic: index out of bounds\nSECRET_TOKEN_ENV\n')
        value=self.observe();rows={r['fixed_log']:r for r in value['fixed_role_logs']if r['fixed_log'].startswith('harness.log prefix ')}
        self.assertEqual(set(rows),{'harness.log prefix '+p for p in ['RLY','VL1','VL2','VL3','SCR']})
        expected={'RLY':['INTEGER_OVERFLOW','PANIC_HEADER_OBSERVED'],'VL1':['PANIC_HEADER_OBSERVED','UNREACHABLE'],'VL2':['ERROR_RETURN_HEADER_OBSERVED'],'VL3':['NULL_UNWRAP','PANIC_HEADER_OBSERVED'],'SCR':['ERROR_RETURN_HEADER_OBSERVED']}
        for prefix,flags in expected.items():
            row=rows['harness.log prefix '+prefix];self.assertEqual(row['finite_observed_flags'],flags);self.assertEqual(row['stream_scope'],'merged_prefixed_stdout_and_stderr');self.assertFalse(row['exact_pid_or_epoch_attribution'])
        self.assertEqual(next(r for r in value['fixed_role_logs']if r['fixed_log']=='agent-logs/RLY-output.log')['finite_observed_flags'],[])
        wire=json.dumps(value)
        for private in ['PrivateFailureName','OtherPrivateFailure','SECRET_TOKEN_ENV','RLY-private','OTHER']:self.assertNotIn(private,wire)

    def test_harness_capture_is_once_bounded_and_unavailable_never_masks_parent_waits(self):
        real=api.captured_failure_bytes;calls=[]
        def capture(path,maximum):
            if Path(path)==self.log:calls.append(maximum)
            return real(path,maximum)
        with mock.patch.object(api,'captured_failure_bytes',side_effect=capture):value=self.observe()
        self.assertEqual(calls,[32*1024**2]);self.assertEqual(len(value['roles']),3)
        with self.log.open('wb')as stream:stream.truncate(32*1024**2+1)
        with mock.patch.object(api.os,'open',wraps=api.os.open)as opened:value=self.observe()
        self.assertNotIn(str(self.log),[str(c.args[0])for c in opened.call_args_list]);self.assertTrue(all(r['status']=='unavailable'for r in value['fixed_role_logs']if r['fixed_log'].startswith('harness.log prefix ')));self.assertEqual(len(value['roles']),3)
        self.log.unlink();self.log.symlink_to(self.case/'agent-logs/RLY-output.log')
        value=self.observe();self.assertTrue(all(r['status']=='unavailable'for r in value['fixed_role_logs']if r['fixed_log'].startswith('harness.log prefix ')))

    def test_unowned_SVM_role_prefixes_do_not_grant_log_rows(self):
        self.owned=[r for r in self.owned if r['role']=='relayer'];self.exits=[r for r in self.exits if r['role']=='relayer'];self.save();self.log.write_bytes(b'<SCR> panic: integer overflow\n<VL1> panic: reached unreachable code\n')
        rows=self.observe()['fixed_role_logs'];self.assertEqual([r['fixed_log']for r in rows],['agent-logs/RLY-output.log','harness.log prefix RLY']);self.assertEqual(rows[-1]['finite_observed_flags'],[])


    def test_canonical_fatal_flags_are_finite_and_addresses_codes_never_export(self):
        self.log.write_bytes(b'<RLY> Segmentation fault at address 0xdeadbeef\n<RLY> Bus error at address 0x12345678\n<RLY> Illegal instruction at address 0xfedcba98\n<RLY> Arithmetic exception at address 0x98765432\n<RLY> General protection exception (no address available)\n<RLY> bzip2 internal invariant failure: -2147483648\n')
        value=self.observe();row=next(r for r in value['fixed_role_logs']if r['fixed_log']=='harness.log prefix RLY')
        self.assertEqual(row['finite_observed_flags'],['ARITHMETIC_EXCEPTION','BUS_ERROR','BZIP2_INTERNAL_INVARIANT_FAILURE','GENERAL_PROTECTION_EXCEPTION','ILLEGAL_INSTRUCTION','SEGMENTATION_FAULT']);self.assertFalse(row['exact_pid_or_epoch_attribution']);self.assertFalse(value['native_or_timing_or_cleanup_authority'])
        wire=json.dumps(value)
        for private in ['deadbeef','12345678','fedcba98','98765432','-2147483648']:self.assertNotIn(private,wire)
        (self.case/'agent-logs/RLY-output.log').write_bytes(b'bzip2 internal invariant failure: 2147483647\n');value=self.observe();row=next(r for r in value['fixed_role_logs']if r['fixed_log']=='agent-logs/RLY-output.log');self.assertEqual(row['finite_observed_flags'],['BZIP2_INTERNAL_INVARIANT_FAILURE'])

    def test_fatal_substrings_invalid_addresses_and_out_of_range_codes_do_not_classify(self):
        bodies=[b'PRIVATE Segmentation fault at address 0x1234',b'Segmentation fault at address 0x1234 SECRET',b'Segmentation fault at address 0x10000000000000000',b'Segmentation fault at address 0xSECRET',b'Bus error',b'Illegal instruction at address 0xABCD',b'bzip2 internal invariant failure: 2147483648',b'bzip2 internal invariant failure: -2147483649',b'bzip2 internal invariant failure: 2 SECRET',b'PRIVATE General protection exception (no address available)']
        self.log.write_bytes(b''.join(b'<RLY> '+body+b'\n'for body in bodies));value=self.observe();row=next(r for r in value['fixed_role_logs']if r['fixed_log']=='harness.log prefix RLY');self.assertEqual(row['finite_observed_flags'],[])
        wire=json.dumps(value)
        for private in ['PRIVATE','SECRET','2147483648','2147483649','0x1234']:self.assertNotIn(private,wire)


    def test_exact_Source_role_pipe_error_marker_is_closed_and_not_a_UTF8_cause(self):
        self.log.write_bytes(b'<E2E> Error reading from output for RLY: SECRET_BODY invalid bytes\n<E2E> Error reading from output for VL1: SECRET_OTHER\n<RLY> <E2E> Error reading from output for VL2: SPOOF\n<E2E> Error reading from output for VL3: \n<E2E> Error reading from output for OTHER: SECRET\n')
        value=self.observe();rows={r['fixed_log']:r for r in value['fixed_role_logs']if r['fixed_log'].startswith('harness.log prefix ')}
        for prefix in ['RLY','VL1']:self.assertEqual(rows['harness.log prefix '+prefix]['finite_observed_flags'],['ROLE_PIPE_READ_ERROR_OBSERVED'])
        for prefix in ['VL2','VL3','SCR']:self.assertEqual(rows['harness.log prefix '+prefix]['finite_observed_flags'],[])
        wire=json.dumps(value)
        for secret in ['SECRET','invalid bytes','SPOOF']:self.assertNotIn(secret,wire)
        path=self.repo/self.names[-1];path.write_bytes(path.read_bytes()+b' changed logging macro')
        with self.assertRaises(ValueError):self.observe()


    def test_actual_role_projection_consumes_catalog_and_retains_only_Source_coordinates(self):
        path=self.repo/'zig/src/role.zig';path.parent.mkdir(parents=True);path.write_bytes(b'pub fn public_role() void {}\n');self.zig_sources={'zig/src/role.zig':api.pin(path)}
        self.log.write_bytes(b'<RLY> /PRIVATE_BUILD/zig/src/role.zig:1:5: 0xPRIVATE in SECRET_FUNCTION\n<VL1> zig/src/role.zig:1:3: PRIVATE_TEXT\n<SCR> zig/src/role.zig:1:1: PRIVATE_TEXT\n')
        value=self.observe();rows={r['fixed_log']:r for r in value['fixed_role_logs']if r['fixed_log'].startswith('harness.log prefix ')}
        self.assertEqual(rows['harness.log prefix RLY']['Source_frames'],[{'source':'zig/src/role.zig','line':1,'column':5}]);self.assertEqual(rows['harness.log prefix VL1']['Source_frames'],[{'source':'zig/src/role.zig','line':1,'column':3}]);self.assertEqual(rows['harness.log prefix SCR']['Source_frames'],[]);self.assertFalse(rows['harness.log prefix RLY']['exact_pid_or_epoch_attribution']);self.assertFalse(value['native_or_timing_or_cleanup_authority'])
        wire=json.dumps(value)
        for secret in ['PRIVATE_BUILD','0xPRIVATE','SECRET_FUNCTION','PRIVATE_TEXT']:self.assertNotIn(secret,wire)

class FixtureFailureDiscriminatorControls(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.case=Path(self.temp.name).resolve();(self.case/'evidence').mkdir();self.repo=self.case/'repo';self.repo.mkdir();self.sources={}
        actual=Path(__file__).resolve().parents[2];root='rust/main/utils/run-locally/src/'
        for suffix in ['program.rs','logging.rs','tron/mod.rs','main.rs','external_agents.rs','radix/mod.rs','external_agents/radix_fixture.rs']:
            name=root+suffix;p=self.repo/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes((actual/name).read_bytes());self.sources[name]=api.pin(p)
        self.manifest={'scenario':'tron','runtime_source_commit':'a'*40,'mode':'ReleaseSafe','verifier_tools':{'docker':{'path':'/approved/docker','bytes':1,'sha256':'b'*64}}};self.approval={'tron_tre':{'pnpm':{'path':'/approved/pnpm','bytes':1,'sha256':'c'*64}}};self.log=self.case/'harness.log'
        self.program='rust/main/utils/run-locally/src/program.rs';self.radix='rust/main/utils/run-locally/src/radix/mod.rs'
        lines=(self.repo/self.program).read_text().splitlines();self.pline=next(i+1 for i,l in enumerate(lines)if l.strip()=='assert!('and any('Command returned non-zero'in t for t in lines[i:i+5]));self.rline=next(i+1 for i,l in enumerate((self.repo/self.radix).read_text().splitlines())if 'panic!("actual owned Radix localnet: {error:#}")'in l)
    def observe(self):return api.fixture_failure_observation(self.case,self.manifest,self.approval,42,self.sources,self.repo,self.log)
    def header(self,name,line):return "thread 'PRIVATE_THREAD' (44) panicked at /build/"+name+':'+str(line)+':9:\n'
    def program_body(self,arguments,binary='/approved/pnpm'):
        return 'Command returned non-zero exit code: Program { bin: Some('+json.dumps(binary)+'), args: '+json.dumps(arguments)+', env: {"PRIVATE_TOKEN": "SECRET"}, working_dir: Some("/PRIVATE_PATH"), log_filter: false }\n'
    def journal(self,**extra):
        return {'schema':1,'purpose':'radix-fixture-docker-client','runtime_source_commit':'a'*40,'mode':'ReleaseSafe','pid':81,'parent_pid':42,'os':'linux','os_start_token':'linux-ticks:22','executable':self.manifest['verifier_tools']['docker'],'arguments':['compose','PRIVATE_ARG','up','--detach','--no-build','--pull','never'],'parent_wait_completed':True,'exit_code':17,'signal':None,'forced_cleanup':False,'elapsed_monotonic_ns':123,'output_bytes':512,'success':False,'error':'PRIVATE_TOKEN_EXTERNAL_ERROR',**extra}
    def save_journal(self,rows):
        (self.case/'evidence/radix-client-parent-waits.jsonl').write_text(''.join(json.dumps(r)+'\n'for r in rows))
    def test_actual_Tron_Program_and_static_stage_categories_never_export_Debug_values(self):
        for args,category in [(['hyperlane','core','deploy','--key','PRIVATE_TOKEN'],'HYPERLANE_CORE_DEPLOY'),(['hyperlane','registry','agent-config'],'HYPERLANE_REGISTRY_AGENT_CONFIG'),(['hyperlane','send','message'],'HYPERLANE_SEND_MESSAGE')]:
            self.log.write_text('<E2E> Deploying core contracts to anvil1...\n'+self.header(self.program,self.pline)+self.program_body(args));value=self.observe();self.assertEqual(value['last_seen_stage']['category'],'CORE_DEPLOY_FIRST_ENTERED');self.assertTrue(value['last_seen_stage']['observed_only']);self.assertEqual(value['panic_observations'][0]['category'],category);self.assertIsNone(value['panic_observations'][0]['program_exit_code']);self.assertIsNone(value['panic_observations'][0]['program_signal'])
            wire=json.dumps(value)
            for secret in ['PRIVATE_TOKEN','SECRET','PRIVATE_PATH','PRIVATE_THREAD','--key']:self.assertNotIn(secret,wire)
        self.log.write_text(self.header(self.program,self.pline)+self.program_body([], '../../target/debug/init-db'));self.assertEqual(self.observe()['panic_observations'][0]['category'],'INIT_DB')
    def test_unknown_program_or_subcommand_is_only_closed_nonzero_observation(self):
        for args,binary in [(['hyperlane','core','deploy'],'/FOREIGN/pnpm'),(['hyperlane','core','deploySECRET'],'/approved/pnpm'),(['PRIVATE_SUBCOMMAND'],'/approved/pnpm')]:
            self.log.write_text(self.header(self.program,self.pline)+self.program_body(args,binary));value=self.observe();self.assertEqual(value['panic_observations'][0]['category'],'OTHER_PROGRAM_NONZERO');self.assertNotIn('FOREIGN',json.dumps(value));self.assertNotIn('PRIVATE_SUBCOMMAND',json.dumps(value))
    def test_panic_requires_immediate_actual_Source_location_and_exact_assertion_line(self):
        body=self.program_body(['hyperlane','core','deploy'])
        for text in [body,self.header(self.program,self.pline-1)+body,"thread 'private' (4) panicked at foreign.rs:2:3: "+self.program+':'+str(self.pline)+':9:\n'+body,self.header(self.program,self.pline)+'\n'*18+body]:
            self.log.write_text(text);self.assertEqual(self.observe()['panic_observations'],[])
        self.log.write_text(self.header(self.program,self.pline)+body);source=self.repo/self.program;source.write_bytes(source.read_bytes()+b'// changed Source')
        with self.assertRaises(ValueError):self.observe()
    def test_Radix_exact_panic_guard_and_parent_client_status_are_independent_observations(self):
        self.manifest['scenario']='radix';self.log.write_text(self.header(self.radix,self.rline)+'actual owned Radix localnet: owned Radix Core/Gateway startup deadline\n');self.save_journal([self.journal()]);value=self.observe();self.assertEqual(value['panic_observations'][0]['category'],'CORE_GATEWAY_STARTUP_DEADLINE');row=value['client_waits']['rows'][0];self.assertEqual(row['category'],'COMPOSE_UP');self.assertEqual(row['exit_code'],17);self.assertEqual(row['elapsed_monotonic_ns'],123);self.assertTrue(row['actual_parent_wait']);self.assertFalse(value['native_or_timing_or_cleanup_authority']);wire=json.dumps(value)
        for secret in ['PRIVATE_ARG','PRIVATE_TOKEN','EXTERNAL_ERROR','linux-ticks:22']:self.assertNotIn(secret,wire)
        self.assertEqual(value['client_waits']['journal']['bytes'],(self.case/'evidence/radix-client-parent-waits.jsonl').stat().st_size)
    def test_Radix_unknown_private_error_cannot_borrow_later_static_guard(self):
        self.manifest['scenario']='radix'
        for text in ['actual owned Radix localnet: PRIVATE owned Radix Core/Gateway startup deadline','actual owned Radix localnet: PRIVATE_ERROR\nstack backtrace:\nowned Radix Core/Gateway startup deadline']:
            self.log.write_text(self.header(self.radix,self.rline)+text+'\n');value=self.observe();self.assertEqual(value['panic_observations'],[]);self.assertNotIn('PRIVATE',json.dumps(value));self.assertEqual(value['client_waits']['status'],'absent')
    def test_Radix_parent_tool_birth_mode_bool_and_duplicate_journals_refuse_observation_only(self):
        self.manifest['scenario']='radix';self.log.write_text(self.header(self.radix,self.rline)+'actual owned Radix localnet: owned Radix Core/Gateway startup deadline\n')
        for extra in [{'parent_pid':43},{'pid':True},{'os_start_token':None},{'mode':'ReleaseFast'},{'executable':{}},{'parent_wait_completed':False},{'exit_code':True},{'signal':9},{'success':0},{'success':True}]:
            self.save_journal([self.journal(**extra)]);value=self.observe();self.assertEqual(value['client_waits'],{'status':'unavailable'});self.assertEqual(value['panic_observations'][0]['category'],'CORE_GATEWAY_STARTUP_DEADLINE')
        row=self.journal();self.save_journal([row,row]);self.assertEqual(self.observe()['client_waits'],{'status':'unavailable'})
    def test_Radix_signal_rows_and_fixed_verb_catalog_do_not_invent_native_credit(self):
        self.manifest['scenario']='radix';self.log.write_bytes(b'')
        cases=[(['image','inspect','PRIVATE'],'IMAGE_INSPECT'),(['network','inspect','PRIVATE'],'NETWORK_INSPECT'),(['inspect','PRIVATE'],'CONTAINER_INSPECT'),(['ps','--all','PRIVATE'],'PROJECT_CONTAINER_LIST'),(['compose','PRIVATE','down','--timeout','15','--volumes'],'COMPOSE_DOWN'),(['volume','ls','PRIVATE'],'PROJECT_NETWORK_OR_VOLUME_LIST'),(['PRIVATE'],'OTHER_DOCKER_CLIENT')]
        rows=[self.journal(pid=90+i,arguments=args,exit_code=None,signal=9,forced_cleanup=True)for i,(args,_)in enumerate(cases)];self.save_journal(rows);value=self.observe();self.assertEqual([r['category']for r in value['client_waits']['rows']],[name for _,name in cases]);self.assertTrue(all(r['signal']==9 and r['exit_code']is None and r['forced_cleanup']is True for r in value['client_waits']['rows']));self.assertNotIn('PRIVATE',json.dumps(value))
    def test_captured_files_bounds_and_evidence_links_never_read_foreign_journal(self):
        self.manifest['scenario']='radix';self.log.write_bytes(b'');journal=self.case/'evidence/radix-client-parent-waits.jsonl'
        with journal.open('wb')as stream:stream.truncate(1024**2+1)
        real=api.os.open;opened=[]
        def tracked(path,*args,**kwargs):opened.append(str(path));return real(path,*args,**kwargs)
        with mock.patch.object(api.os,'open',side_effect=tracked):value=self.observe()
        self.assertEqual(value['client_waits'],{'status':'unavailable'});self.assertNotIn(str(journal),opened)
        journal.unlink();journal.symlink_to(self.log);self.assertEqual(self.observe()['client_waits'],{'status':'unavailable'})


    def test_unknown_first_panic_message_cannot_borrow_later_unnumbered_guard(self):
        self.manifest['scenario']='radix'
        for inline in [False,True]:
            header=self.header(self.radix,self.rline).rstrip('\n')if inline else self.header(self.radix,self.rline)
            self.log.write_text(header+'actual owned Radix localnet: PRIVATE_UNKNOWN_ERROR\nowned Radix Core/Gateway startup deadline\n')
            value=self.observe();self.assertEqual(value['panic_observations'],[]);self.assertNotIn('PRIVATE_UNKNOWN_ERROR',json.dumps(value))
        self.manifest['scenario']='tron';self.log.write_text(self.header(self.program,self.pline)+'PRIVATE_UNKNOWN_ERROR\n'+self.program_body(['hyperlane','core','deploy']));self.assertEqual(self.observe()['panic_observations'],[])


class ZigRoleSourceFrameControls(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.repo=Path(self.tmp.name).resolve();self.name='zig/src/agents/public.zig';self.path=self.repo/self.name;self.path.parent.mkdir(parents=True);self.path.write_bytes(b'pub fn first() void {}\npub fn second() void {}\n'+b'const public_a = 1;\n'*20);self.catalog={self.name:api.pin(self.path)}
    def frames(self,raw,prefixes=None,catalog=None):return api.zig_role_source_frames(raw,{'RLY':'relayer','VL1':'validator'}if prefixes is None else prefixes,self.catalog if catalog is None else catalog,self.repo)
    def test_real_relative_and_absolute_prefixed_frames_export_only_three_coordinate_fields(self):
        raw=b'<RLY> /PRIVATE_BUILD/zig/src/agents/public.zig:1:5: 0xSECRET in PRIVATE_FUNCTION (PRIVATE_BINARY)\n<VL1> zig/src/agents/public.zig:2:3: PRIVATE_CONTENT\n<RLY> src/agents/public.zig:2:7: PRIVATE_CWD_FUNCTION\n';value=self.frames(raw)
        self.assertEqual(value,{'RLY':[{'source':self.name,'line':1,'column':5},{'source':self.name,'line':2,'column':7}],'VL1':[{'source':self.name,'line':2,'column':3}]});self.assertNotIn('PRIVATE',json.dumps(value));self.assertNotIn('SECRET',json.dumps(value));self.assertTrue(all(set(row)=={'source','line','column'}for rows in value.values()for row in rows))
    def test_unknown_std_foreign_unowned_scraper_later_path_and_bad_coordinates_omit(self):
        raw=b'<RLY> /lib/std/debug.zig:1:1: PRIVATE\n<RLY> /FOREIGN/src/agents/public.zig:1:1: PRIVATE\n<RLY> zig/src/unadmitted.zig:1:1: PRIVATE\n<UNKNOWN> zig/src/agents/public.zig:1:1: PRIVATE\n<SCR> zig/src/agents/public.zig:1:1: PRIVATE\n<RLY> PRIVATE zig/src/agents/public.zig:1:1\n<RLY> zig/src/agents/public.zig:999:1\n<RLY> zig/src/agents/public.zig:1:0\n<RLY> zig/src/agents/public.zig:1:9999\n'
        self.assertEqual(self.frames(raw),{'RLY':[],'VL1':[]})
    def test_changed_same_size_Source_and_linked_leaf_never_grant_frames(self):
        raw=b'<RLY> zig/src/agents/public.zig:1:1: PRIVATE\n';original=self.path.read_bytes();self.path.write_bytes(original.replace(b'first',b'other'));self.assertEqual(self.frames(raw)['RLY'],[])
        self.path.unlink();foreign=self.repo/'PRIVATE';foreign.write_bytes(original);self.path.symlink_to(foreign)
        with mock.patch.object(api.os,'open',side_effect=AssertionError('linked Source must not open')):self.assertEqual(self.frames(raw)['RLY'],[])
    def test_total_eight_deduplicated_frames_across_all_admitted_prefixes(self):
        raw=b''.join(b'<'+prefix+b'> zig/src/agents/public.zig:'+str(i).encode()+b':1: PRIVATE\n'for i in range(1,11)for prefix in [b'RLY',b'VL1']);value=self.frames(raw);self.assertEqual(sum(map(len,value.values())),8);self.assertEqual(value['RLY'][0],{'source':self.name,'line':1,'column':1});self.assertNotIn('PRIVATE',json.dumps(value))
        duplicate=b'<RLY> zig/src/agents/public.zig:1:1\n'*20;self.assertEqual(len(self.frames(duplicate)['RLY']),1)
    def test_descriptor_path_bytes_count_and_catalog_total_are_closed_before_read(self):
        raw=b'<RLY> zig/src/agents/public.zig:1:1\n'
        for key,value in [('path','/FOREIGN/file'),('bytes',True),('bytes',1024**2+1),('sha256','not-a-hash')]:
            catalog={self.name:dict(self.catalog[self.name],**{key:value})}
            with self.subTest(key=key,value=value),mock.patch.object(api.os,'open',side_effect=AssertionError('bad descriptor must not open')),self.assertRaises(ValueError):self.frames(raw,catalog=catalog)
        catalog={'zig/src/f'+str(i)+'.zig':{'path':str(self.repo/('zig/src/f'+str(i)+'.zig')),'bytes':1024**2,'sha256':'a'*64}for i in range(17)}
        with mock.patch.object(api.os,'open',side_effect=AssertionError('over total must not open')),self.assertRaises(ValueError):self.frames(raw,catalog=catalog)
        with self.assertRaises(ValueError):self.frames(raw,catalog={str(i):{}for i in range(769)})



class RelayerStartupNumericControls(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name).resolve()
        self.modules={name:api.pin(HERE/name)for name in ['multivm_session.py','multivm_evidence.py']}
        repo=HERE.parents[1]
        for relative,_,_ in api.RELAYER_STARTUP_SOURCE:
            target=self.root/relative;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes((repo/relative).read_bytes())
        self.manifest={'scenario':'evm','runtime_source_commit':api.RELAYER_STARTUP_EPOCH}
    def sample(self,name='hyperlane_chain_init_latency',extra='role="destination",entity="mailbox",',value='0',chain='selected'):
        return f'{name}{{chain="{chain}",{extra}agent="relayer",hyperlane_baselib_version="3.0.0"}} {value}\n'.encode()
    def test_actual_Source13_and_zero_present_distinguish_absent_family(self):
        probe=api.RelayerStartup(self.root,self.manifest,self.modules);record=probe.project(self.sample(),('selected',),405,1,99)
        self.assertTrue(record['admin_extra_handler_observed']);metric=record['metrics'][0]['metrics'];self.assertEqual(metric['destination_mailbox'],{'family_present':True,'selected_present':True,'series_count':1,'finite_values':[0.0]});self.assertFalse(metric['block_height']['family_present']);self.assertFalse(metric['destination_dispatcher']['selected_present'])
    def test_current_epoch_and_pinned_wildcard_bind_Source_contract(self):
        self.assertEqual(api.RELAYER_STARTUP_EPOCH,'843bf642a630591f10e927fd5e535aad715a0394')
        service='zig/src/service_main.zig';path=self.root/service;wire=path.read_bytes();needle=b'Address.parseIp4("0.0.0.0", configured.metrics_port)'
        self.assertIn(needle,wire);changed=wire.replace(needle,b'Address.parseIp4("127.0.0.1", configured.metrics_port)');path.write_bytes(changed)
        altered=tuple((name,len(changed),hashlib.sha256(changed).hexdigest())if name==service else(name,size,digest)for name,size,digest in api.RELAYER_STARTUP_SOURCE)
        with mock.patch.object(api,'RELAYER_STARTUP_SOURCE',altered),self.assertRaisesRegex(ValueError,'wildcard metrics bind'):api.RelayerStartup(self.root,self.manifest,self.modules)
        with self.assertRaises(ValueError):api.RelayerStartup(HERE.parents[1],{**self.manifest,'runtime_source_commit':'06e263fe7950e6051502a771646bbcc6d0453369'},self.modules)
    def test_actual_missing_selected_chain_is_not_invented_zero_or_405(self):
        probe=api.RelayerStartup(self.root,self.manifest,self.modules);record=probe.project(self.sample(chain='other'),('selected',),404,1,99)
        metric=record['metrics'][0]['metrics']['destination_mailbox'];self.assertTrue(metric['family_present']);self.assertFalse(metric['selected_present']);self.assertEqual(metric['series_count'],0);self.assertEqual(metric['finite_values'],[]);self.assertFalse(record['admin_extra_handler_observed'])
    def test_all_five_groups_are_fixed_finite_scalars_without_labels_or_wallet(self):
        raw=self.sample()+self.sample(extra='role="destination",entity="dispatcher_and_entrypoint",',value='4')+self.sample('hyperlane_block_height',extra='',value='42')+self.sample('hyperlane_wallet_balance',extra='wallet_address="PRIVATE_SENTINEL",wallet_name="relayer",',value='3.5')+self.sample('hyperlane_critical_error',extra='',value='0')
        rows=api.startup_metric_projection(raw,('selected',));self.assertEqual([v['series_count']for v in rows[0]['metrics'].values()],[1]*5);self.assertNotIn('PRIVATE',json.dumps(rows));self.assertNotIn('selected',json.dumps(rows).replace('selected_present',''));self.assertEqual(rows[0]['metrics']['critical_error']['finite_values'],[0.0])
    def test_malformed_duplicate_nonfinite_oversize_and_foreign_base_refuse(self):
        cases=[self.sample()*2,self.sample(value='NaN'),self.sample(value='Inf'),self.sample(value='9007199254740993'),b'x'*(1024**2+1),self.sample().replace(b'agent="relayer"',b'agent="PRIVATE"'),self.sample().replace(b'chain="selected"',b'chain="selected",chain="selected"'),self.sample().replace(b'} 0',b',} 0')]
        for raw in cases:
            with self.subTest(size=len(raw)),self.assertRaises((ValueError,UnicodeError)):api.startup_metric_projection(raw,('selected',))
    def test_wrong_epoch_Source_change_and_existing_writer_change_refuse(self):
        for manifest in [{**self.manifest,'runtime_source_commit':'a'*40},{**self.manifest,'scenario':'tron'}]:
            with self.assertRaises(ValueError):api.RelayerStartup(self.root,manifest,self.modules)
        probe=api.RelayerStartup(self.root,self.manifest,self.modules);target=self.root/api.RELAYER_STARTUP_SOURCE[0][0];target.write_bytes(target.read_bytes()+b'\n')
        with self.assertRaises(ValueError):probe.project(self.sample(),('selected',),405,1,99)
        with self.assertRaises(ValueError):api.RelayerStartup(self.root,self.manifest,self.modules)
        bad=copy.deepcopy(self.modules);bad['multivm_session.py']['sha256']='0'*64
        with self.assertRaises(ValueError):api.RelayerStartup(HERE.parents[1],self.manifest,bad)
    def test_exact_header_known_literal_unknown_and_foreign_prefix_do_not_leak(self):
        sources={'public.zig':b'error.OutOfMemory; error.RpcFailed'};raw=b'<RLY> warning: task 2 failed: OutOfMemory\n<RLY> warn: Common health metric update failed: PRIVATE_SENTINEL\n<RLY> error: agent stopped: RpcFailed\n<VL1> warning: task 3 failed: RpcFailed\n<RLY> warning: task 256 failed: RpcFailed\n<RLY> warning: task 1 failed: SECRET/full/path\n'
        out=api.startup_header_projection(raw,sources);self.assertEqual(out['counts'],{'supervised_task_failed':1,'health_warning':1,'agent_stopped':1});self.assertEqual(out['observations'][0]['task_index'],2);self.assertEqual(out['observations'][0]['Source_error_name'],'OutOfMemory');self.assertIsNone(out['observations'][1]['Source_error_name']);self.assertNotIn('PRIVATE',json.dumps(out));self.assertNotIn('SECRET',json.dumps(out));self.assertTrue(all(r['lane_attribution']is None for r in out['observations']))
    def test_wholeprobe_limit_and_source_mutation_before_publication_refuse(self):
        probe=api.RelayerStartup(self.root,self.manifest,self.modules)
        for start,end in [(0,1),(2,1),(1,500000002)]:
            with self.assertRaises(ValueError):probe.project(self.sample(),('selected',),405,start,end)
        probe.project(self.sample(),('selected',),405,1,500000001);log=self.root/'harness.log';log.write_bytes(b'<RLY> error: agent stopped: PRIVATE_SENTINEL\n');out=probe.public(log);self.assertNotIn('PRIVATE',json.dumps(out));self.assertFalse(out['native_or_timing_or_cleanup_authority']);target=self.root/api.RELAYER_STARTUP_SOURCE[-1][0];target.write_bytes(target.read_bytes()+b'\n')
        with self.assertRaises(ValueError):probe.public(log)



class RelayerStartupHTTPControls(unittest.TestCase):
    class Wire:
        def __init__(self,chunks):self.chunks=list(chunks);self.sent=b'';self.closed=False;self.blocking=None;self.target=None
        def setblocking(self,value):self.blocking=value
        def connect_ex(self,target):self.target=target;return 0
        def send(self,wire):self.sent+=wire;return len(wire)
        def recv(self,limit):
            if not self.chunks:return b''
            wire=self.chunks.pop(0);assert len(wire)<=limit;return wire
        def close(self):self.closed=True
    def run_http(self,chunks,method='GET',deadline=500000001,tick=1000000,cancelled=lambda:False):
        import socket,select
        stream=self.Wire(chunks);now=[1];calls=[]
        def ready(read,write,errors,seconds):
            self.assertLessEqual(seconds,.025);now[0]+=min(tick,max(0,int(seconds*10**9)));calls.append((bool(read),bool(write)));return read,write,[]
        with mock.patch.object(socket,'socket',return_value=stream),mock.patch.object(select,'select',side_effect=ready):
            try:return api.startup_http(9092,method,deadline,cancelled,lambda:now[0]),stream,now,calls
            finally:self.assertTrue(stream.closed);self.assertFalse(stream.blocking)
    def test_actual_nonblocking_fixed_requests_strict_body_and_no_redirect(self):
        result,stream,now,_=self.run_http([b'HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\n',b'abc']);self.assertEqual(result,(200,b'abc'));self.assertEqual(stream.target,('127.0.0.1',9092));self.assertIn(b'GET /metrics HTTP/1.1',stream.sent);self.assertNotIn(b'Authorization',stream.sent);self.assertLess(now[0],500000001)
        result,stream,_,_=self.run_http([b'HTTP/1.1 405 PRIVATE_SENTINEL\r\nContent-Length: 9999999\r\n\r\n'],method='HEAD');self.assertEqual(result,(405,b''));self.assertIn(b'HEAD /messages HTTP/1.1',stream.sent);self.assertNotIn('PRIVATE',str(result))
        with self.assertRaises(ValueError):self.run_http([b'HTTP/1.1 302 Found\r\nLocation: https://PRIVATE\r\nContent-Length: 0\r\n\r\n'])
    def test_trickle_body_cannot_restart_absolute_clock(self):
        chunks=[b'HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n']+[b'x']*100
        with self.assertRaises(TimeoutError):self.run_http(chunks,tick=25000000)
        with self.assertRaises(TimeoutError):self.run_http(chunks,deadline=60000001,tick=25000000)
    def test_deadline_and_cancel_refuse_before_socket_or_after_first_io(self):
        import socket
        for deadline,cancel in [(1,False),(500000001,True)]:
            with self.subTest(deadline=deadline,cancel=cancel),mock.patch.object(socket,'socket')as create,self.assertRaises(TimeoutError):api.startup_http(9093,'GET',deadline,lambda:cancel,lambda:1)
            create.assert_not_called()
        calls=[0]
        def cancelled():calls[0]+=1;return calls[0]>6
        with self.assertRaises(TimeoutError):self.run_http([b'HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\n',b'abc'],cancelled=cancelled)
    def test_header_length_encoding_duplicates_incomplete_and_body_bounds_refuse(self):
        cases=[[b'HTTP/1.1 200 OK\r\nContent-Length: 1048577\r\n\r\n'],[b'HTTP/1.1 200 OK\r\nContent-Length: 0\r\ncontent-length: 0\r\n\r\n'],[b'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n'],[b'HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 0\r\n\r\n'],[b'HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\nxx'],[b'HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nx'],[b'HTTP/1.1 200 OK\r\n'+b'X: '+b'a'*16000,b'a'*16000,b'a'*1000]]
        for chunks in cases:
            with self.subTest(firstlen=len(chunks[0])),self.assertRaises(ValueError):self.run_http(chunks)
    def test_arbitrary_ports_methods_and_query_routes_are_impossible(self):
        import socket
        for port,method in [(80,'GET'),(9092,'POST'),(9093,'GET /private')]:
            with mock.patch.object(socket,'socket')as create,self.assertRaises(ValueError):api.startup_http(port,method,500000001,lambda:False,lambda:1)
            create.assert_not_called()



class RelayerStartupProcControls(unittest.TestCase):
    def setUp(self):
        self.row={'pid':43,'ppid':42,'start':'linux-ticks:55','state':'S'}
        self.table=b'  sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n0: 00000000:2384 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 1234\n'
    def observe(self,table=None,links=None,rows=None,cancel=lambda:False):
        from types import SimpleNamespace
        iterator=mock.MagicMock();iterator.__enter__.return_value=iter([SimpleNamespace(name=str(i))for i in range(len(links or ['socket:[1234]']))]);links=links or['socket:[1234]']
        with mock.patch.object(api.os,'scandir',return_value=iterator),mock.patch.object(api.os,'readlink',side_effect=links),mock.patch.object(api,'startup_proc_read',return_value=self.table if table is None else table)as read:
            result=api.startup_owned_listener(43,9092,self.row,500000001,cancel,lambda:1,mock.Mock(side_effect=rows or[self.row,self.row]));read.assert_called_once();self.assertEqual(read.call_args.args[0],Path('/proc/43/net/tcp'));self.assertEqual(read.call_args.args[1],1024**2);return result
    def test_actual_inode_join_requires_Source_wildcard_owned_LISTEN(self):
        try:observed=self.observe()
        except ValueError:observed=None
        self.assertEqual(observed,'1234')
        for wire in [self.table.replace(b'00000000:2384',b'0100007F:2384'),self.table.replace(b'2384',b'2385'),self.table.replace(b'0A',b'01'),self.table.replace(b'1234',b'9876')]:
            with self.subTest(wire=wire[-20:]),self.assertRaises(ValueError):self.observe(table=wire)
        with self.assertRaises(ValueError):self.observe(links=['socket:[9999]'])
    def test_kernel_epoch_replacement_cancel_and_oversized_FD_set_refuse(self):
        with self.assertRaises(ValueError):self.observe(rows=[self.row,{**self.row,'start':'linux-ticks:56'}])
        with self.assertRaises(TimeoutError):self.observe(cancel=lambda:True)
        with self.assertRaises(ValueError):self.observe(links=['socket:[1234]']*1025)
    def journal(self,originals=None,owned=None,live=None):
        from types import SimpleNamespace
        artifact={'path':'/public/relayer','bytes':4,'sha256':'a'*64};manifest={'scenario':'evm','runtime_source_commit':api.RELAYER_STARTUP_EPOCH,'artifacts':{'relayer':artifact}}
        capture={'role':'relayer','runtime_source_commit':api.RELAYER_STARTUP_EPOCH,'scenario':'evm','harness_pid':42,'metrics_port':9092,'role_chain_names':['one'],'chains':{'one':{'protocol':'ethereum'}}};child={'role':'relayer','pid':43,'parent_pid':42,'os_start_token':'43 42 Mon Jan 1 00:00:00 2026 /public/relayer','executable':artifact}
        rows={'effective-role-configs.jsonl':[{'original':x}for x in(originals if originals is not None else[capture])],'owned-children.jsonl':owned if owned is not None else[child]}
        def read(path,maximum):self.assertEqual(maximum,1024**2);return ('\n'.join(json.dumps(x)for x in rows[path.name]).encode(),{})
        return api.startup_selected_role(Path('/public/case'),manifest,{'chain_names':['one']},42,read,lambda _:self.row if live is None else live,lambda _:'/public/relayer',lambda:None),capture,child
    def test_actual_journal_capture_binding_has_no_ordinal_or_PS_tick_guess(self):
        (row,chains,port),capture,child=self.journal();self.assertEqual(row,self.row);self.assertEqual(chains,('one',));self.assertEqual(port,9092)
        self.assertEqual(self.journal(originals=[capture,copy.deepcopy(capture)])[0][1],('one',))
        for changed in [{**capture,'metrics_port':9093},{**capture,'harness_pid':99},{**capture,'role_chain_names':['foreign']},{**capture,'runtime_source_commit':'b'*40}]:
            with self.assertRaises(ValueError):self.journal(originals=[changed])
        with self.assertRaises(ValueError):self.journal(owned=[{**child,'parent_pid':99}])
        with self.assertRaises(ValueError):self.journal(owned=[child,copy.deepcopy(child)])
        with self.assertRaises(ValueError):self.journal(live={**self.row,'ppid':99})
        with self.assertRaises(ValueError):self.journal(originals=[])



class RadixTransportControls(unittest.TestCase):
    def setUp(self):
        from types import SimpleNamespace
        self.simple=SimpleNamespace;self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name).resolve();self.now=1_000_000_000;self.stop=False;self.cancel=False;self.calls=[]
        repo=HERE.parents[1];names=['rust/main/utils/run-locally/src/external_agents/radix_fixture.rs','zig/bench/native_radix_custody.py'];pins=[]
        for name in names:
            p=self.root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes((repo/name).read_bytes());pins.append(api.pin(p))
        self.fixture={'architecture':'amd64','token':'a'*32,'images':{s:{'id':'sha256:'+'b'*64,'source':'fixed'}for s in api.RADIX_TRANSPORT_SERVICES}}
        self.state=api.RadixTransport(self.fixture,pins[0],pins[1],self.root)
        seen={s:str(i+1)*64 for i,s in enumerate(api.RADIX_TRANSPORT_SERVICES)}
        self.custody=self.simple(case=self.root,pid=42,start='linux-ticks:9',fixture=self.fixture,seen=seen,ready=dict(seen),network='project_default',project='project',stopping=lambda:self.stop)
        self.containers={};self.net={'Id':'c'*64,'Name':'project_default','Internal':True,'Driver':'bridge','Labels':{'com.docker.compose.project':'project'},'Containers':{}}
        for i,s in enumerate(api.RADIX_TRANSPORT_SERVICES):
            cid=seen[s];ip='172.25.0.'+str(i+2);endpoint=str(i+1)*64
            self.containers[s]={'Id':cid,'Image':self.fixture['images'][s]['id'],'Config':{'Labels':{'com.docker.compose.project':'project','com.docker.compose.service':s,'io.hyperlane.ziggy.radix-token':'a'*32},'Env':['SECRET_RAW_CONFIG']},'State':{'Running':s!='database_migrations_image','OOMKilled':False,'Pid':0 if s=='database_migrations_image'else 100+i,'Status':'exited'if s=='database_migrations_image'else'running','ExitCode':0},'NetworkSettings':{'Networks':{'project_default':{'NetworkID':'c'*64,'EndpointID':endpoint,'IPAddress':ip}}}}
            self.net['Containers'][cid]={'EndpointID':endpoint,'IPv4Address':ip+'/16'}
    def capture(self):
        self.state.begin_custody()
        for service,row in self.containers.items():self.state.capture(['container','inspect','--size',self.custody.seen[service]],json.dumps([row]))
        self.state.capture(['network','inspect','project_default'],json.dumps([self.net]))
    def kernel(self,pid):return {'pid':pid,'ppid':1,'start':'linux-ticks:17','state':'S'}
    def check(self):
        if self.cancel or self.now>=self.deadline:raise TimeoutError('PRIVATE_REASON')
    def http(self,service,route,target,end,cancelled,clock):
        self.calls.append((service,route,target,end));self.now+=10_000_000
        return 200,b'{"network":"localnet","network_id":240,"network_hrp_suffix":"loc"}'if service=='fullnode'else b'{"ledger_state":{"network":"localnet","state_version":1}}'
    def observe(self,http=None,kernel=None,deadline=10_000_000_000):
        self.deadline=deadline;self.state.observe(self.custody,kernel or self.kernel,self.check,lambda:self.now,lambda:self.cancel,deadline,http or self.http)
    def test_actual_capture_pending_and_next_cadence_crossbinding(self):
        self.capture();self.observe();self.assertEqual(len(self.calls),4);a=self.state.public();row=a['samples'][0];self.assertFalse(row['crossbinding_verified']);self.assertEqual(row['crossbinding_status'],'PENDING_FRESH_CUSTODY');self.assertTrue(all(x['Source_predicate']=='SOURCE_READY'for x in row['observations']));self.assertEqual({x[-1]for x in self.calls},{1_500_000_000});self.assertNotIn('SECRET',json.dumps(a));self.assertNotIn('172.25.',json.dumps(a));self.assertNotIn('IPAddress',json.dumps(a));self.assertTrue(a['ordinary_custody_outside_HTTP_budget']);self.assertFalse(a['Rust120s_clock_observed'])
        self.now+=1_000_000_000;self.capture();self.observe();a=self.state.public();self.assertEqual(len(self.calls),4);self.assertTrue(a['samples'][0]['crossbinding_verified']);self.assertEqual(a['samples'][0]['crossbinding_status'],'FRESH_CUSTODY_MATCHED')
    def test_all5_positive_required_no_IO_before_ready(self):
        for change in ['notready','unknownCID','internal','foreignEndpoint','image','label','peerIP','missingPID','stickyOldReady','wrongEndpointID','wrongNetworkID']:
            with self.subTest(change=change):
                self.setUp()
                if change=='notready':self.custody.ready.pop('postgres_db')
                elif change=='unknownCID':self.containers['fullnode']['Id']='f'*64
                elif change=='internal':self.net['Internal']=False
                elif change=='foreignEndpoint':self.net['Containers']['f'*64]={}
                elif change=='image':self.containers['fullnode']['Image']='sha256:'+'d'*64
                elif change=='label':self.containers['fullnode']['Config']['Labels']['io.hyperlane.ziggy.radix-token']='d'*32
                elif change=='peerIP':self.net['Containers'][self.custody.seen['fullnode']]['IPv4Address']='172.25.9.9/16'
                elif change=='missingPID':self.containers['fullnode']['State']['Pid']=0
                elif change=='stickyOldReady':self.containers['postgres_db']['State']['Running']=False
                elif change=='wrongEndpointID':self.containers['fullnode']['NetworkSettings']['Networks']['project_default']['EndpointID']='d'*64
                else:self.containers['fullnode']['NetworkSettings']['Networks']['project_default']['NetworkID']='d'*64
                self.capture();self.observe();self.assertEqual(self.calls,[]);self.assertEqual(self.state.samples,[])
    def test_cancel_stop_original_deadline_no_HTTP(self):
        for change in ['cancel','stop','deadline']:
            self.setUp();self.capture();self.cancel=change=='cancel';self.stop=change=='stop';self.observe(deadline=self.now if change=='deadline'else 10_000_000_000);self.assertEqual(self.calls,[])
    def test_missing_or_changed_postcheck_never_promotes(self):
        for change in ['no_after','pid','birth','network','stop']:
            self.setUp();self.capture();self.observe();self.now+=1_000_000_000
            if change=='no_after':pass
            elif change=='pid':self.containers['fullnode']['State']['Pid']+=10;self.capture();self.observe()
            elif change=='birth':self.capture();self.observe(kernel=lambda pid:{'pid':pid,'start':'linux-ticks:18','state':'S'})
            elif change=='network':self.net['Id']='d'*64;self.capture();self.observe()
            else:self.stop=True;self.capture();self.observe()
            self.assertFalse(self.state.public()['samples'][0]['crossbinding_verified'])
    def test_late_positive_and_parser_work_cannot_survive_HTTP_fence(self):
        self.capture()
        def late(*args):value=self.http(*args);self.now+=600_000_000;return value
        self.observe(http=late);sample=self.state.public()['samples'][0];self.assertTrue(all(r['http_status']is None and r['Source_predicate']=='UNAVAILABLE'for r in sample['observations']));self.assertEqual(len(self.calls),1)
    def test_true_target_refusal_pending_then_post_and_untyped_refusal_unavailable(self):
        self.capture();self.observe(http=mock.Mock(side_effect=api.RadixTargetConnectRefused));sample=self.state.public()['samples'][0];self.assertTrue(all(r['outcome']=='TARGET_CONNECT_REFUSED'for r in sample['observations']));self.assertFalse(sample['crossbinding_verified']);self.now+=1;self.capture();self.observe();self.assertTrue(self.state.public()['samples'][0]['crossbinding_verified'])
        self.setUp();self.capture();self.observe(http=mock.Mock(side_effect=ConnectionRefusedError('SECRET_API')));self.assertTrue(all(r['outcome']=='UNAVAILABLE'for r in self.state.public()['samples'][0]['observations']));self.assertNotIn('SECRET',json.dumps(self.state.public()))
    def test_two_samples_only_no_clock_reset_or_unbounded_growth(self):
        self.capture();self.observe();self.now+=91_000_000_000;self.capture();self.observe(deadline=500_000_000_000);self.now+=91_000_000_000;self.capture();self.observe(deadline=500_000_000_000);self.assertEqual(len(self.calls),8);self.assertEqual(len(self.state.samples),2)
    def test_HTTP_deadline_clamped_to_original_case_and_midread_stop_cancels(self):
        self.capture();self.observe(deadline=1_200_000_000);self.assertEqual({row[-1]for row in self.calls},{1_200_000_000})
        self.setUp();self.capture()
        def stopping(*args):value=self.http(*args);self.stop=True;return value
        self.observe(http=stopping);self.assertEqual(len(self.calls),1);sample=self.state.public()['samples'][0];self.assertTrue(all(row['Source_predicate']=='UNAVAILABLE'for row in sample['observations']));self.assertFalse(sample['crossbinding_verified'])
    def test_source_changes_and_capture_errors_unavailable(self):
        self.capture();source=self.root/'zig/bench/native_radix_custody.py';source.write_bytes(source.read_bytes()+b'\n');self.observe();self.assertEqual(self.calls,[])
        self.setUp();self.capture();self.state.capture(['network','inspect','project_default'],'SECRET_INVALID_JSON');self.observe();self.assertEqual(self.calls,[])
    def test_predicate_wrong_network_bool_nonfinite_duplicates_bounded(self):
        self.assertEqual(api.radix_readiness_predicate('fullnode',b'{"network":"mainnet","network_id":240,"network_hrp_suffix":"loc"}'),'WRONG_SOURCE_NETWORK')
        self.assertEqual(api.radix_readiness_predicate('gateway_api_image',b'{"ledger_state":{"network":"localnet","state_version":true}}'),'NO_SOURCE_COMMITTED_LEDGER')
        self.capture();self.observe(http=lambda *args:(True,b'{}'));self.assertTrue(all(row['http_status']is None and row['outcome']=='UNAVAILABLE'for row in self.state.public()['samples'][0]['observations']))
        for raw in [b'{"x":1e999}',b'{"network":1,"network":2}']:
            with self.assertRaises(ValueError):api.radix_readiness_predicate('fullnode',raw)


class RadixTransportHTTPControls(unittest.TestCase):
    Wire=RelayerStartupHTTPControls.Wire
    def run_http(self,chunks,service='fullnode',route='host_loopback',target=('127.0.0.1',3333),tick=1000000,deadline=500000001,cancelled=lambda:False):
        import socket,select
        stream=self.Wire(chunks);now=[1]
        def ready(read,write,errors,seconds):now[0]+=min(tick,max(0,int(seconds*10**9)));self.assertLessEqual(seconds,.025);return read,write,[]
        with mock.patch.object(socket,'socket',return_value=stream),mock.patch.object(select,'select',side_effect=ready):
            try:return api.radix_transport_http(service,route,target,deadline,cancelled,lambda:now[0]),stream
            finally:self.assertTrue(stream.closed)
    def test_actual_POST_body_routes_and_length_chunked_EOF(self):
        for chunks in [[b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}'],[b'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\n{\r\n1\r\n}\r\n0\r\n\r\n'],[b'HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{}']]:
            result,stream=self.run_http(chunks);self.assertEqual(result,(200,b'{}'));self.assertEqual(stream.target,('127.0.0.1',3333));self.assertTrue(stream.sent.startswith(b'POST /core/status/network-configuration HTTP/1.1'));self.assertTrue(stream.sent.endswith(b'\r\n\r\n{}'));self.assertIn(b'Content-Length: 2',stream.sent);self.assertNotIn(b'Authorization',stream.sent)
        result,stream=self.run_http([b'HTTP/1.1 503 Error\r\nContent-Length: 0\r\n\r\n'],service='gateway_api_image',route='owned_private_endpoint',target=('172.25.0.4',8080));self.assertEqual(result,(503,b''));self.assertIn(b'POST /status/gateway-status ',stream.sent)
    def test_absolute_trickle_cancel_and_invalid_targets_before_socket(self):
        import socket
        with self.assertRaises(TimeoutError):self.run_http([b'HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n']+[b'x']*100,tick=25000000)
        for target in [('remote.example',3333),('8.8.8.8',3333),('127.0.0.1',5308)]:
            with mock.patch.object(socket,'socket')as create,self.assertRaises(ValueError):api.radix_transport_http('fullnode','host_loopback',target,500000001,lambda:False,lambda:1)
            create.assert_not_called()
        with mock.patch.object(socket,'socket')as create,self.assertRaises(TimeoutError):api.radix_transport_http('fullnode','host_loopback',('127.0.0.1',3333),500000001,lambda:True,lambda:1)
        create.assert_not_called()
    def test_ambiguous_duplicate_encoding_oversize_malformed_refuse(self):
        cases=[b'Content-Length: 2\r\nTransfer-Encoding: chunked',b'Content-Length: 2\r\ncontent-length: 2',b'Content-Encoding: gzip\r\nContent-Length: 2',b'Content-Length: 2097153',b'Transfer-Encoding: deflate',b'Transfer-Encoding: chunked\r\n\r\nZZ\r\n']
        for headers in cases:
            with self.subTest(headers=headers),self.assertRaises(ValueError):self.run_http([b'HTTP/1.1 200 OK\r\n'+headers+b'\r\n\r\n{}'])
    def test_chunk_count_extensions_trailers_decoded_encoded_bounds(self):
        self.assertEqual(api.radix_response_body(b'2;public=yes\r\n{}\r\n0\r\nX-Public: yes\r\n\r\n',None,True,False),b'{}')
        for raw in [b'1\r\nx\r\n'*4097+b'0\r\n\r\n',b'0\r\n'+b'x'*8193,b'0\r\nContent-Length: 2\r\n\r\n',b'200001\r\n']:
            with self.assertRaises(ValueError):api.radix_response_body(raw,None,True,True)
        with self.assertRaises(ValueError):api.radix_response_body(b'x'*(2*1024**2+1),None,False,True)
    def test_encoded_header_extension_bounds_and_actual_IO_cancellation(self):
        with self.assertRaises(ValueError):self.run_http([b'HTTP/1.1 200 OK\r\nX: '+b'a'*16000,b'a'*16000,b'a'*1000])
        with self.assertRaises(ValueError):api.radix_response_body(b'x'*(2*1024**2+32769),None,False,True)
        with self.assertRaises(ValueError):api.radix_response_body(b'1;'+b'a'*200+b'\r\nx\r\n0\r\n\r\n',None,True,True)
        count=[0]
        def cancelled():count[0]+=1;return count[0]>6
        with self.assertRaises(TimeoutError):self.run_http([b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}'],cancelled=cancelled)
    def test_only_actual_connect_refusal_has_typed_result(self):
        import socket,errno
        stream=self.Wire([]);stream.connect_ex=lambda _:errno.ECONNREFUSED
        with mock.patch.object(socket,'socket',return_value=stream),self.assertRaises(api.RadixTargetConnectRefused):api.radix_transport_http('fullnode','host_loopback',('127.0.0.1',3333),500000001,lambda:False,lambda:1)
        self.assertTrue(stream.closed)

if __name__=='__main__':unittest.main()
