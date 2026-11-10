"""Public-only diagnostics controls; no native, chain, SDK or process execution."""
from pathlib import Path
import copy
import importlib.util
import json
import hashlib
import base64
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
        self.assertEqual(value['reason_codes'],['IO_FILE_EXISTS','IO_NO_SPACE_LEFT','IO_PERMISSION_DENIED','OWNED_PARENT_NOT_DIRECTORY','OWNED_PATH_SYMLINK']);self.assertEqual(value['reason_source'],{'module':str(helper.relative_to(repo)),'source':api.pin(helper),'owned_path_guard_literals_verified':True,'tempfile_directory_and_file_calls_verified':True});self.assertEqual(len(value['sites']),1);self.assertEqual(value['log_fingerprint'],{'path':str(log),'bytes':log.stat().st_size,'sha256':hashlib.sha256(log.read_bytes()).hexdigest()});self.assertNotIn('PRIVATE',json.dumps(value));self.assertNotIn('https://',json.dumps(value));self.assertEqual(set(value),{'sites','reason_codes','reason_source','log_fingerprint','EVM_child_wait_text'})

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
        bodies=[b'pub struct OwnedChild\nstruct ChildExit\n.join("parent-child-exits.jsonl")\nimpl Drop for TrackedChild',b'format!("{log_prefix}-output.log")\nprintln!("<{prefix}> {line}")\nlog!("Error reading from output for {}: {}", prefix, e)',b'create_owned_path(Path::new("/tmp/test_logs"), "agent-logs")',b'.spawn("RLY", Some(&AGENT_LOGGING_DIR))\n.zip(["SCR1", "SCR2", "SCR3"])\nscraper_env.spawn(scraper_name, None)',b'::std::println!(concat!("<E2E> ", $arg), $($rest)*)']
        self.sources={}
        for name,body in zip(self.names,bodies):
            target=self.repo/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(body);self.sources[name]={'path':str(target),'bytes':len(body),'sha256':hashlib.sha256(body).hexdigest()}
        self.products={role:{'path':str(self.case/role),'bytes':1,'sha256':hashlib.sha256(role.encode()).hexdigest()}for role in ['relayer','validator','scraper']}
        self.manifest={'scenario':'sealevel','artifacts':self.products};self.owned=[];self.exits=[]
        for i,role in enumerate(self.products,10):
            row={'pid':i,'parent_pid':42,'role':role,'executable':self.products[role],'os_start_token':'PRIVATE_START_'+str(i),'scope':'PRIVATE_SCOPE'};self.owned.append(row)
            self.exits.append({**row,'parent_wait_completed':True,'already_exited':role=='relayer','forced_kill':False,'success':False,'exit_code':None,'signal':6 if role=='relayer'else 15,'purpose':'unwind_or_early_drop','planned_exit':False})
        self.zig_sources={};self.log=self.case/'harness.log';self.log.write_bytes(b'<SCR1> error: PrivateFailureName\nDO-NOT-EXPORT-AUTHORIZATION\n')
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
        self.log.write_bytes(b'<RLY> thread 10 panic: integer overflow\n<VL1> thread 11 panic: reached unreachable code\n<VL2> error: PrivateFailureName\n<VL3> panic: attempt to use null value\n<SCR1> error: OtherPrivateFailure\n<SCR2> panic: reached unreachable code\n<SCR3> panic: attempt to use null value\n<OTHER> panic: incorrect alignment\n<RLY-private> panic: index out of bounds\nSECRET_TOKEN_ENV\n')
        value=self.observe();rows={r['fixed_log']:r for r in value['fixed_role_logs']if r['fixed_log'].startswith('harness.log prefix ')}
        self.assertEqual(set(rows),{'harness.log prefix '+p for p in ['RLY','VL1','VL2','VL3','SCR1','SCR2','SCR3']})
        expected={'RLY':['INTEGER_OVERFLOW','PANIC_HEADER_OBSERVED'],'VL1':['PANIC_HEADER_OBSERVED','UNREACHABLE'],'VL2':['ERROR_RETURN_HEADER_OBSERVED'],'VL3':['NULL_UNWRAP','PANIC_HEADER_OBSERVED'],'SCR1':['ERROR_RETURN_HEADER_OBSERVED'],'SCR2':['PANIC_HEADER_OBSERVED','UNREACHABLE'],'SCR3':['NULL_UNWRAP','PANIC_HEADER_OBSERVED']}
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
        self.owned=[r for r in self.owned if r['role']=='relayer'];self.exits=[r for r in self.exits if r['role']=='relayer'];self.save();self.log.write_bytes(b'<SCR1> panic: integer overflow\n<VL1> panic: reached unreachable code\n')
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
        for prefix in ['VL2','VL3','SCR1','SCR2','SCR3']:self.assertEqual(rows['harness.log prefix '+prefix]['finite_observed_flags'],[])
        wire=json.dumps(value)
        for secret in ['SECRET','invalid bytes','SPOOF']:self.assertNotIn(secret,wire)
        path=self.repo/self.names[-1];path.write_bytes(path.read_bytes()+b' changed logging macro')
        with self.assertRaises(ValueError):self.observe()


    def test_actual_role_projection_consumes_catalog_and_retains_only_Source_coordinates(self):
        path=self.repo/'zig/src/role.zig';path.parent.mkdir(parents=True);path.write_bytes(b'pub fn public_role() void {}\n');self.zig_sources={'zig/src/role.zig':api.pin(path)}
        self.log.write_bytes(b'<RLY> /PRIVATE_BUILD/zig/src/role.zig:1:5: 0xPRIVATE in SECRET_FUNCTION\n<VL1> zig/src/role.zig:1:3: PRIVATE_TEXT\n<SCR1> zig/src/role.zig:1:1: PRIVATE_TEXT\n')
        value=self.observe();rows={r['fixed_log']:r for r in value['fixed_role_logs']if r['fixed_log'].startswith('harness.log prefix ')}
        self.assertEqual(rows['harness.log prefix RLY']['Source_frames'],[{'source':'zig/src/role.zig','line':1,'column':5}]);self.assertEqual(rows['harness.log prefix VL1']['Source_frames'],[{'source':'zig/src/role.zig','line':1,'column':3}]);self.assertEqual(rows['harness.log prefix SCR1']['Source_frames'],[]);self.assertFalse(rows['harness.log prefix RLY']['exact_pid_or_epoch_attribution']);self.assertFalse(value['native_or_timing_or_cleanup_authority'])
        wire=json.dumps(value)
        for secret in ['PRIVATE_BUILD','0xPRIVATE','SECRET_FUNCTION','PRIVATE_TEXT']:self.assertNotIn(secret,wire)

    def test_legacy_lookalike_and_nested_scraper_prefixes_never_classify(self):
        self.log.write_bytes(b'<SCR> panic: integer overflow\n<SCR4> panic: integer overflow\n<SCR1-extra> panic: integer overflow\n<RLY> <SCR1> panic: integer overflow\n')
        scrapers=[r for r in self.observe()['fixed_role_logs']if r['role']=='scraper']
        self.assertEqual({r['fixed_log']for r in scrapers},{'harness.log prefix '+p for p in ('SCR1','SCR2','SCR3')})
        self.assertTrue(all(r['finite_observed_flags']==[]for r in scrapers))
        self.assertTrue(all(not r['exact_pid_or_epoch_attribution']for r in scrapers))

    def test_rehashed_changed_scraper_emitter_does_not_authorize_prefixes(self):
        target=self.repo/self.names[3]
        target.write_bytes(target.read_bytes().replace(b'"SCR3"',b'"SCR4"'))
        self.sources[self.names[3]]=api.pin(target)
        with self.assertRaisesRegex(ValueError,'Source role journal/log contract'):self.observe()

class LateInvariantObservationControls(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.repo=Path(self.tmp.name).resolve();self.sources={}
        actual=Path(__file__).resolve().parents[2]
        for suffix in ['invariants/termination_invariants.rs','main.rs','logging.rs','sealevel/sealevel_termination_invariants.rs']:
            name='rust/main/utils/run-locally/src/'+suffix;target=self.repo/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes((actual/name).read_bytes());self.sources[name]=api.pin(target)
        self.log=self.repo/'harness.log'
    def observe(self,wire,scenario='tron'):
        self.log.write_bytes(wire);return api.late_invariant_observation(scenario,self.sources,self.repo,self.log)
    def test_exact_Source_counts_numeric_first_latest_and_error_prefix_only(self):
        phrases=[b'Relayer has 2 gas payment events, expected at least 4',b'highest tree index does not match messages sent. got 3 expected 4',b'Expected starting relayer balance to be greater than ending relayer balance, but got 1000000 <= 1000000',b'hyperlane_lander_finalized_transactions is zero, expected at least one',b'hyperlane_lander_building_stage_queue_length 1 count, expected 0',b'hyperlane_lander_inclusion_stage_pool_length 1 count, expected 0',b'hyperlane_lander_finality_stage_pool_length 1 count, expected 0',b'hyperlane_lander_dropped_payloads 4 count, expected less than 4',b'hyperlane_lander_dropped_transactions 3 count, expected less than 0',b'hyperlane_lander_mismatched_nonce 1 count, expected 0',b'hyperlane_lander_transaction_submissions 5 count',b'Scraper has scraped 2 dispatched messages, expected 4',b'Scraper has scraped 2 raw message dispatches, expected 4',b'Scraper has scraped 2 gas payments, expected 4',b'Scraper has scraped 2 delivered messages, expected 4',b'Checking relayer termination invariants',b'Checking scraper termination invariants',b'Error checking e2e invariants: PRIVATE_KEY_URL_ERROR',b'Relayer has 3 gas payment events, expected at least 4']
        value=self.observe(b''.join(b'<E2E> '+line+b'\n'for line in phrases));rows={row['code']:row for row in value['observations']};self.assertEqual(len(rows),18);self.assertEqual(rows['RELAYER_GAS_PAYMENT_COUNT'],{'code':'RELAYER_GAS_PAYMENT_COUNT','count':2,'first':{'log_line':1,'values':[2,4]},'latest':{'log_line':19,'values':[3,4]}});self.assertEqual(rows['RELAYER_BALANCE_NOT_DECREASED']['latest']['values'],[1000000.0,1000000.0]);self.assertEqual(rows['INVARIANT_ERROR_PREFIX_ONLY']['latest']['values'],[]);self.assertNotIn('PRIVATE',json.dumps(value));self.assertFalse(value['native_or_timing_or_cleanup_authority']);self.assertLess(len(json.dumps(value)),16384)
    def test_wrong_prefix_suffix_number_and_oversized_lines_never_export_text(self):
        phrase=b'Relayer has 2 gas payment events, expected at least 4'
        poisoned=[phrase,b'<RLY> <E2E> '+phrase,b' <E2E> '+phrase,b'<E2E> '+phrase+b' PRIVATE_TOKEN',b'<E2E> Relayer has -1 gas payment events, expected at least 4',b'<E2E> Relayer has 4294967296 gas payment events, expected at least 4',b'<E2E> Expected starting relayer balance to be greater than ending relayer balance, but got NaN <= 1',b'<E2E> Expected starting relayer balance to be greater than ending relayer balance, but got 1e999 <= 1',b'<E2E> '+b'PRIVATE_'*10000]
        value=self.observe(b'\n'.join(poisoned)+b'\n');self.assertEqual(value['observations'],[]);self.assertEqual(value['oversized_lines_omitted'],1);self.assertNotIn('PRIVATE',json.dumps(value));self.assertEqual(value['collection_status'],'observed')
        for scenario in ['evm','sealevel','sealevel-composite','tron']:
            value=self.observe(b'\x1b[32m<E2E> '+phrase+b'\x1b[0m\r\n',scenario);self.assertEqual(value['observations'][0]['first']['values'],[2,4])
    def test_Source_pin_and_literal_changes_refuse_without_raw_fallback(self):
        self.log.write_bytes(b'<E2E> Checking relayer termination invariants\n');name='rust/main/utils/run-locally/src/invariants/termination_invariants.rs';path=self.repo/name;old=path.read_bytes();path.write_bytes(old.replace(b'Relayer has {} gas payment events',b'PRIVATE has {} gas payment events'))
        with self.assertRaises(ValueError):api.late_invariant_observation('tron',self.sources,self.repo,self.log)
        self.sources[name]=api.pin(path)
        with self.assertRaises(ValueError):api.late_invariant_observation('tron',self.sources,self.repo,self.log)
        path.write_bytes(old);self.sources[name]=api.pin(path)
        with self.assertRaises(ValueError):api.late_invariant_observation('radix',self.sources,self.repo,self.log)
    def test_existing_capture_bounds_and_symlinks_refuse_before_log_read(self):
        self.log.write_bytes(b'PRIVATE_SECRET');self.log.unlink();self.log.symlink_to(self.repo/'rust/main/utils/run-locally/src/main.rs')
        with self.assertRaises(ValueError):api.late_invariant_observation('tron',self.sources,self.repo,self.log)
        self.log.unlink()
        with self.log.open('wb')as stream:stream.truncate(32*1024**2+1)
        opened=[];real=api.os.open
        def tracked(path,*args,**kwargs):opened.append(str(path));return real(path,*args,**kwargs)
        with mock.patch.object(api.os,'open',side_effect=tracked),self.assertRaises(ValueError):api.late_invariant_observation('tron',self.sources,self.repo,self.log)
        self.assertNotIn(str(self.log),opened)
    def test_provider_numeric_forms_and_SVM_failure_frontiers_are_fixed_not_inferred(self):
        phrases=[b'hyperlane_request_count 2 count, expected 6',b'Provider created count: 2',b'hyperlane_provider_create_count only has 2 count, expected at least 6',b'hyperlane_metadata_build_count only has 3 count, expected at least 6',b'Solana termination invariants not met',b'Provider metrics invariants not met for sealeveltest2',b'Provider metrics invariants not met for sealeveltest3']
        wire=b''.join(b'<E2E> '+line+b'\n'for line in phrases);value=self.observe(wire,'sealevel');rows={row['code']:row for row in value['observations']};self.assertEqual(set(rows),{'PROVIDER_REQUEST_COUNT','PROVIDER_CREATED_COUNT','PROVIDER_CREATED_TOO_LOW','PROVIDER_METADATA_COUNT','SVM_SOLANA_TERMINATION_NOT_MET','SVM_PROVIDER2_NOT_MET','SVM_PROVIDER3_NOT_MET'});self.assertEqual(rows['PROVIDER_CREATED_TOO_LOW']['latest']['values'],[2,6]);self.assertEqual(rows['PROVIDER_CREATED_COUNT']['latest']['values'],[2]);self.assertEqual(rows['SVM_PROVIDER2_NOT_MET']['latest']['values'],[]);self.assertEqual(len(value['writer_sources']),4);self.assertFalse(value['native_or_timing_or_cleanup_authority'])
        for scenario in ['evm','tron','sealevel-composite']:
            value=self.observe(wire,scenario);self.assertEqual(len(value['observations']),4);self.assertEqual(len(value['writer_sources']),3);self.assertTrue(all(not row['code'].startswith('SVM_')for row in value['observations']))
    def test_new_forms_refuse_unknown_chain_suffix_numeric_overflow_and_changed_SVM_Source(self):
        poison=[b'Provider created count: -1',b'Provider created count: 4294967296',b'hyperlane_request_count 1 count, expected 6 PRIVATE_KEY',b'Provider metrics invariants not met for PRIVATE_CHAIN',b'Provider metrics invariants not met for sealeveltest2 PRIVATE',b'<RLY> Provider created count: 2']
        value=self.observe(b''.join(b'<E2E> '+line+b'\n'for line in poison),'sealevel');self.assertEqual(value['observations'],[]);self.assertNotIn('PRIVATE',json.dumps(value))
        name='rust/main/utils/run-locally/src/sealevel/sealevel_termination_invariants.rs';path=self.repo/name;path.write_bytes(path.read_bytes().replace(b'Solana termination invariants not met',b'PRIVATE_SVM_FAILURE'))
        with self.assertRaises(ValueError):self.observe(b'<E2E> Solana termination invariants not met\n','sealevel')
        self.sources[name]=api.pin(path)
        with self.assertRaises(ValueError):self.observe(b'<E2E> Solana termination invariants not met\n','sealevel')


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
        self.manifest['scenario']='radix';self.log.write_text(self.header(self.radix,self.rline)+'actual owned Radix localnet: owned Radix Core/Gateway startup deadline; phase=gateway-read, status=HttpStatus(500)\n');self.save_journal([self.journal()]);value=self.observe();self.assertEqual(value['panic_observations'][0]['category'],'CORE_GATEWAY_STARTUP_DEADLINE');row=value['client_waits']['rows'][0];self.assertEqual(row['category'],'COMPOSE_UP');self.assertEqual(row['exit_code'],17);self.assertEqual(row['elapsed_monotonic_ns'],123);self.assertTrue(row['actual_parent_wait']);self.assertFalse(value['native_or_timing_or_cleanup_authority']);wire=json.dumps(value)
        for secret in ['PRIVATE_ARG','PRIVATE_TOKEN','EXTERNAL_ERROR','linux-ticks:22']:self.assertNotIn(secret,wire)
        self.assertEqual(value['client_waits']['journal']['bytes'],(self.case/'evidence/radix-client-parent-waits.jsonl').stat().st_size)
    def test_Radix_current_deadline_requires_closed_phase_status_and_exact_Source_format(self):
        self.manifest['scenario']='radix'
        prefix='actual owned Radix localnet: owned Radix Core/Gateway startup deadline'
        for suffix in ['', '; phase=PRIVATE, status=HttpStatus(500)', '; phase=gateway-read, status=PRIVATE', '; phase=gateway-read, status=HttpStatus(500) PRIVATE', '; phase={}, status={:?}', '; phase=gateway-read, status=HttpStatus(999)']:
            self.log.write_text(self.header(self.radix,self.rline)+prefix+suffix+'\n');value=self.observe();self.assertEqual(value['panic_observations'],[]);self.assertNotIn('PRIVATE',json.dumps(value))
        for phase in ['startup','core-status','gateway-status','gateway-read']:
            for status in ['Pending','Transport','BodyBound','Schema','Deadline','HttpStatus(201)','HttpStatus(500)']:
                self.log.write_text(self.header(self.radix,self.rline)+prefix+f'; phase={phase}, status={status}\n');self.assertEqual(self.observe()['panic_observations'][0]['category'],'CORE_GATEWAY_STARTUP_DEADLINE')

    def test_Radix_unknown_private_error_cannot_borrow_later_static_guard(self):
        self.manifest['scenario']='radix'
        for text in ['actual owned Radix localnet: PRIVATE owned Radix Core/Gateway startup deadline; phase=gateway-read, status=HttpStatus(500)','actual owned Radix localnet: PRIVATE_ERROR\nstack backtrace:\nowned Radix Core/Gateway startup deadline; phase=gateway-read, status=HttpStatus(500)']:
            self.log.write_text(self.header(self.radix,self.rline)+text+'\n');value=self.observe();self.assertEqual(value['panic_observations'],[]);self.assertNotIn('PRIVATE',json.dumps(value));self.assertEqual(value['client_waits']['status'],'absent')
    def test_Radix_parent_tool_birth_mode_bool_and_duplicate_journals_refuse_observation_only(self):
        self.manifest['scenario']='radix';self.log.write_text(self.header(self.radix,self.rline)+'actual owned Radix localnet: owned Radix Core/Gateway startup deadline; phase=gateway-read, status=HttpStatus(500)\n')
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
            self.log.write_text(header+'actual owned Radix localnet: PRIVATE_UNKNOWN_ERROR\nowned Radix Core/Gateway startup deadline; phase=gateway-read, status=HttpStatus(500)\n')
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
        # Synthetic producer/consumer closure; never grants native execution.
        epoch='1'*40;execution='2'*40
        log=self.root/'compiled-source-check.json';log.write_text('{}\n')
        scopes={category:[{'path':path,'producer_tree':None if path=='zig/build.zig.zon'else'3'*40,'current_tree':None if path=='zig/build.zig.zon'else'3'*40,'worktree_unchanged':True}for path in paths]for category,paths in {'runtime':('zig/src','zig/native','zig/build.zig','zig/build.zig.zon'),'helper':('rust/main','rust/sealevel'),'tools':('rust/main','rust/sealevel','zig/reference')}.items()}
        self.closure={'schema':1,'runtime_source_commit':epoch,'helper_source_commit':epoch,'tools_source_commit':epoch,'execution_source_commit':execution,'source_unchanged':True,'native_case_acceptance':False,'scopes':scopes,'checks':[{'exit_code':0,'log':api.pin(log)}]}
        self.closure_path=self.root/'compiled-input-closure.json';self.closure_path.write_text(json.dumps(self.closure))
        self.approval={'root_approved':True,'scenario':'evm','runtime_source_commit':epoch,'execution_source_commit':execution,'compiled_input_closure':api.pin(self.closure_path),'python_modules':self.modules,'diagnostic_relayer_sources':{relative:{'path':str(self.root/relative),'bytes':size,'sha256':digest}for relative,size,digest in api.RELAYER_STARTUP_SOURCE}}
        self.approval_path=self.root/'approval.json';self.approval_path.write_text(json.dumps(self.approval))
        self.manifest={'scenario':'evm','runtime_source_commit':epoch,'execution_approval':api.pin(self.approval_path)}
    def sample(self,name='hyperlane_chain_init_latency',extra='role="destination",entity="mailbox",',value='0',chain='selected'):
        return f'{name}{{chain="{chain}",{extra}agent="relayer",hyperlane_baselib_version="3.0.0"}} {value}\n'.encode()
    def test_actual_Source13_and_zero_present_distinguish_absent_family(self):
        probe=api.RelayerStartup(self.root,self.manifest,self.modules);record=probe.project(self.sample(),('selected',),405,1,99)
        self.assertTrue(record['admin_extra_handler_observed']);metric=record['metrics'][0]['metrics'];self.assertEqual(metric['destination_mailbox'],{'family_present':True,'selected_present':True,'series_count':1,'finite_values':[0.0]});self.assertFalse(metric['block_height']['family_present']);self.assertFalse(metric['destination_dispatcher']['selected_present'])
    def test_current_epoch_and_pinned_wildcard_bind_Source_contract(self):
        self.assertEqual(api.RelayerStartup(self.root,self.manifest,self.modules).epoch,'1'*40)
        service='zig/src/service_main.zig';path=self.root/service;wire=path.read_bytes();needle=b'Address.parseIp4("0.0.0.0", configured.metrics_port)'
        self.assertIn(needle,wire);changed=wire.replace(needle,b'Address.parseIp4("127.0.0.1", configured.metrics_port)');path.write_bytes(changed)
        altered=tuple((name,len(changed),hashlib.sha256(changed).hexdigest())if name==service else(name,size,digest)for name,size,digest in api.RELAYER_STARTUP_SOURCE)
        with mock.patch.object(api,'RELAYER_STARTUP_SOURCE',altered),self.assertRaisesRegex(ValueError,'wildcard metrics bind'):api.RelayerStartup(self.root,self.manifest,self.modules)
        with self.assertRaises(ValueError):api.RelayerStartup(HERE.parents[1],{**self.manifest,'runtime_source_commit':'06e263fe7950e6051502a771646bbcc6d0453369'},self.modules)
    def test_transitive_catalog_names_are_recovered_only_with_exact_pinned_Source(self):
        probe=api.RelayerStartup(self.root,self.manifest,self.modules)
        self.assertEqual(len(probe.sources),28)
        raw=b'<RLY> warning: task 0 failed: WrongChain\n<RLY> warning: task 3 failed: ReadReplayPassNotActive\n<RLY> warning: task 4 failed: PRIVATE_SENTINEL\n'
        rows=api.startup_header_projection(raw,probe.sources)['observations']
        self.assertEqual([r['Source_error_name']for r in rows],['WrongChain','ReadReplayPassNotActive',None]);self.assertTrue(all(r['lane_attribution']is None for r in rows))
        self.assertNotIn('PRIVATE',json.dumps(rows))
        old={name:body for name,body in probe.sources.items()if name not in {'zig/src/evm/provider.zig','zig/src/net/read_replay.zig'}}
        self.assertIsNone(api.startup_header_projection(raw,old)['observations'][0]['Source_error_name'])
    def test_successor_epoch_requires_actual_admitted_closure_not_an_arbitrary_commit(self):
        original=copy.deepcopy(self.closure)
        mutations=[lambda x:x.update(helper_source_commit='4'*40),lambda x:x.update(runtime_source_commit='4'*40),lambda x:x.update(execution_source_commit='4'*40),lambda x:x.update(source_unchanged=False),lambda x:x.update(native_case_acceptance=True),lambda x:x['scopes']['helper'][0].update(current_tree='4'*40),lambda x:x['scopes']['runtime'][0].update(worktree_unchanged=False),lambda x:x['scopes'].pop('tools'),lambda x:x['scopes']['tools'].pop(),lambda x:x.update(checks=[]),lambda x:x['checks'][0].update(exit_code=1)]
        for mutate in mutations:
            self.closure=copy.deepcopy(original);mutate(self.closure);self.closure_path.write_text(json.dumps(self.closure));self.approval['compiled_input_closure']=api.pin(self.closure_path);self.approval_path.write_text(json.dumps(self.approval));self.manifest['execution_approval']=api.pin(self.approval_path)
            with self.subTest(mutation=repr(mutate)),self.assertRaises(ValueError):api.RelayerStartup(self.root,self.manifest,self.modules)
        self.closure_path.write_text(json.dumps(original));self.approval['compiled_input_closure']=api.pin(self.closure_path)
        for key in ['compiled_input_closure','diagnostic_relayer_sources']:
            modified=copy.deepcopy(self.approval);modified.pop(key);self.approval_path.write_text(json.dumps(modified));self.manifest['execution_approval']=api.pin(self.approval_path)
            with self.subTest(missing=key),self.assertRaises(ValueError):api.RelayerStartup(self.root,self.manifest,self.modules)
    def test_same_epoch_still_requires_closure_and_cross_bound_module_and_Source_admission(self):
        valid=copy.deepcopy(self.approval)
        for change in [lambda x:x.pop('compiled_input_closure'),lambda x:x.update(python_modules={}),lambda x:x.update(runtime_source_commit='4'*40),lambda x:x.update(scenario='starknet'),lambda x:x['diagnostic_relayer_sources'].pop('zig/src/evm/provider.zig'),lambda x:x['diagnostic_relayer_sources']['zig/src/evm/provider.zig'].update(sha256='0'*64)]:
            modified=copy.deepcopy(valid);change(modified)
            if 'compiled_input_closure'not in modified:modified['execution_source_commit']=modified['runtime_source_commit']
            self.approval_path.write_text(json.dumps(modified));self.manifest['execution_approval']=api.pin(self.approval_path)
            with self.subTest(mutation=repr(change)),self.assertRaises(ValueError):api.RelayerStartup(self.root,self.manifest,self.modules)
        self.approval_path.write_text(json.dumps(valid));self.manifest['execution_approval']=api.pin(self.approval_path)
        oversized={'path':str(self.approval_path),'bytes':1024**2+1,'sha256':'0'*64}
        with self.assertRaises(ValueError):api.RelayerStartup(self.root,{**self.manifest,'execution_approval':oversized},self.modules)
    def test_new_catalog_and_approval_closure_identity_are_retained_without_new_authority(self):
        for target in [self.root/'zig/src/evm/provider.zig',self.approval_path,self.closure_path]:
            before=target.read_bytes();probe=api.RelayerStartup(self.root,self.manifest,self.modules);target.write_bytes(before+b'\n')
            with self.subTest(path=target.name),self.assertRaises(ValueError):probe.check_sources()
            target.write_bytes(before)

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
        out=api.startup_header_projection(raw,sources);self.assertEqual(out['counts'],{'supervised_task_failed':1,'health_warning':1,'agent_stopped':1,'native_group_rpc_warning':0,'relayer_telemetry_warning':0,'initialization_metric_warning':0,'critical_metric_warning':0,'origin_range_fetch_warning':0});self.assertEqual(out['observations'][0]['task_index'],2);self.assertEqual(out['observations'][0]['Source_error_name'],'OutOfMemory');self.assertIsNone(out['observations'][1]['Source_error_name']);self.assertNotIn('PRIVATE',json.dumps(out));self.assertNotIn('SECRET',json.dumps(out));self.assertTrue(all(r['lane_attribution']is None for r in out['observations']))
    def test_wholeprobe_limit_and_source_mutation_before_publication_refuse(self):
        probe=api.RelayerStartup(self.root,self.manifest,self.modules)
        for start,end in [(0,1),(2,1),(1,500000002)]:
            with self.assertRaises(ValueError):probe.project(self.sample(),('selected',),405,start,end)
        probe.project(self.sample(),('selected',),405,1,500000001);log=self.root/'harness.log';log.write_bytes(b'<RLY> error: agent stopped: PRIVATE_SENTINEL\n');out=probe.public(log);self.assertNotIn('PRIVATE',json.dumps(out));self.assertFalse(out['native_or_timing_or_cleanup_authority']);target=self.root/api.RELAYER_STARTUP_SOURCE[-1][0];target.write_bytes(target.read_bytes()+b'\n')
        with self.assertRaises(ValueError):probe.public(log)

    def test_four_warning_emitters_actual_Source13_publication_and_finite_counts(self):
        probe=api.RelayerStartup(self.root,self.manifest,self.modules)
        headers=[('native_group_rpc_warning','native submission group RPC'),('relayer_telemetry_warning','relayer telemetry update failed'),('initialization_metric_warning','initialization metric update failed'),('critical_metric_warning','critical metric update failed')]
        wire=b''.join(('<RLY> warning: '+header+': RequestDeadlineExceeded\n<RLY> warn: '+header+': RequestDeadlineExceeded\n').encode()for _,header in headers);log=self.root/'warnings.log';log.write_bytes(wire);value=probe.public(log);out=value['fixed_harness_headers']
        for key,_ in headers:self.assertEqual(out['counts'][key],2)
        self.assertEqual([out['counts'][key]for key in ['supervised_task_failed','health_warning','agent_stopped']],[0,0,0]);self.assertEqual(len(out['observations']),4)
        for row in out['observations']:self.assertEqual(row['Source_error_name'],'RequestDeadlineExceeded');self.assertEqual(row['error_name_status'],'Source_literal');self.assertIsNone(row['task_index']);self.assertIsNone(row['lane_attribution'])
        self.assertFalse(value['native_or_timing_or_cleanup_authority']);self.assertEqual(value['Source_epoch'],self.manifest['runtime_source_commit'])
    def test_four_warning_headers_need_exact_once_emitter_in_correct_Source(self):
        probe=api.RelayerStartup(self.root,self.manifest,self.modules)
        rows=[('native_group_rpc_warning','zig/src/agents/relayer_task.zig',b'native submission group RPC'),('relayer_telemetry_warning','zig/src/agents/relayer_task.zig',b'relayer telemetry update failed'),('initialization_metric_warning','zig/src/ops/init_metrics.zig',b'initialization metric update failed'),('critical_metric_warning','zig/src/ops/critical_metrics.zig',b'critical metric update failed')]
        for key,path,header in rows:
            needle=b'std.log.warn("'+header+b': {s}", .{@errorName(err)})';self.assertEqual(probe.sources[path].count(needle),1);wire=b'<RLY> warning: '+header+b': RequestDeadlineExceeded\n'
            for variant in ['missing','wrong_path','changed','duplicate']:
                sources=dict(probe.sources)
                if variant=='missing':sources.pop(path)
                elif variant=='wrong_path':sources['public-wrong-source.zig']=sources.pop(path)
                elif variant=='changed':sources[path]=sources[path].replace(needle,needle.replace(b'@errorName(err)',b'unknown(err)'))
                else:sources[path]+=b'\n'+needle
                with self.subTest(key=key,variant=variant):self.assertEqual(api.startup_header_projection(wire,sources)['counts'][key],0)
    def test_four_warning_unknown_names_never_export_private_error_or_payload(self):
        probe=api.RelayerStartup(self.root,self.manifest,self.modules);headers=['native submission group RPC','relayer telemetry update failed','initialization metric update failed','critical metric update failed'];wire=b''.join(('<RLY> warning: '+header+': PRIVATE_SENTINEL\n').encode()for header in headers);out=api.startup_header_projection(wire,probe.sources);self.assertEqual(sum(out['counts'].values()),4);self.assertEqual(len(out['observations']),4)
        for row in out['observations']:self.assertIsNone(row['Source_error_name']);self.assertEqual(row['error_name_status'],'unknown');self.assertIsNone(row['task_index']);self.assertIsNone(row['lane_attribution'])
        self.assertNotIn('PRIVATE',json.dumps(out));self.assertNotIn(str(self.root),json.dumps(out))
    def test_four_warning_ANSI_foreign_prefix_malformed_and_line_bounds(self):
        probe=api.RelayerStartup(self.root,self.manifest,self.modules);valid=b'<RLY> warning: native submission group RPC: RequestDeadlineExceeded';ansi=b'\x1b[31m'+valid+b'\x1b[0m\n';out=api.startup_header_projection(ansi,probe.sources);self.assertEqual(out['counts']['native_group_rpc_warning'],1)
        cases=[valid.replace(b'<RLY>',b'<VL1>')+b'\n',valid.replace(b'warning:',b'error:')+b'\n',valid+b'/PRIVATE_PATH\n',valid+b' PRIVATE_TOKEN\n',valid.replace(b'RequestDeadlineExceeded',b'\nPRIVATE_TOKEN')+b'\n',valid.replace(b'RequestDeadlineExceeded',b'x'*65)+b'\n',valid+b' '*(16385-len(valid))+b'\n']
        for wire in cases:
            with self.subTest(bytes=len(wire)):self.assertEqual(sum(api.startup_header_projection(wire,probe.sources)['counts'].values()),0)
        self.assertNotIn('PRIVATE',json.dumps(api.startup_header_projection(b''.join(cases),probe.sources)))
    def test_four_warning_counts_survive_existing16_observation_bound(self):
        probe=api.RelayerStartup(self.root,self.manifest,self.modules);wire=b''.join(('<RLY> warning: task '+str(i)+' failed: RequestDeadlineExceeded\n').encode()for i in range(20));wire+=b''.join(('<RLY> warning: '+header+': RequestDeadlineExceeded\n').encode()for header in ['native submission group RPC','relayer telemetry update failed','initialization metric update failed','critical metric update failed']);out=api.startup_header_projection(wire,probe.sources);self.assertEqual(len(out['observations']),16);self.assertEqual(out['counts']['supervised_task_failed'],20)
        for key in ['native_group_rpc_warning','relayer_telemetry_warning','initialization_metric_warning','critical_metric_warning']:self.assertEqual(out['counts'][key],1)
    def test_four_warning_publication_rejects_changed_actual_emitter_Source(self):
        probe=api.RelayerStartup(self.root,self.manifest,self.modules);log=self.root/'warning.log';log.write_bytes(b'<RLY> warning: native submission group RPC: RequestDeadlineExceeded\n');source=self.root/'zig/src/agents/relayer_task.zig';source.write_bytes(source.read_bytes()+b'\n')
        with self.assertRaisesRegex(ValueError,'Source identity changed'):probe.public(log)



class RelayerPipelineControls(unittest.TestCase):
    def metric(self,name,labels,value=1):
        labels={**labels,'agent':'relayer','hyperlane_baselib_version':'3.0.0'}
        return (name+'{'+','.join(key+'='+json.dumps(value)for key,value in labels.items())+'} '+str(value)+'\n').encode()
    def project(self,raw,chains=('one','two')):return api.startup_metric_projection(raw,chains)
    def test_pinned_actual_schema_and_emitters_match_the_closed_family_shapes(self):
        import re
        source=(HERE.parents[1]/'zig/src/ops/metrics_schema.zig').read_text()
        emitters=b''.join((HERE.parents[1]/path).read_bytes()for path in ['zig/src/ops/indexing_metrics.zig','zig/src/ops/relayer_metrics.zig'])
        for family,labels in api.STARTUP_PIPELINE_LABELS.items():
            line=next(line for line in source.splitlines()if '.name = "'+family+'"'in line)
            self.assertRegex(line,r'\.kind = \.int_(?:counter|gauge),')
            shape=re.search(r'\.labels = &\.\{([^}]+)\}',line)[1]
            self.assertEqual(tuple(re.findall(r'"([A-Za-z_]+)"',shape)),labels)
            self.assertIn(('"'+family+'"').encode(),emitters)
        self.assertIn(b'.set_int = integer(value.delay_ms / 1000)',emitters)
    def test_actual_fixed_targets_emit_only_numeric_ordinals_and_known_group_names(self):
        raw=b''
        for key,(family,identity,required)in api.STARTUP_PIPELINE_TARGETS.items():
            labels={name:('one'if name=='origin'else'two'if name in {'chain','remote'}else'PRIVATE_CONTEXT'if name=='app_context'else'Retry(PRIVATE_STATUS)'if name=='operation_status'else'')for name in api.STARTUP_PIPELINE_LABELS[family]}
            labels.update(required);raw+=self.metric(family,labels,2)
        result=self.project(raw);pipeline=result[1]['pipeline'];self.assertEqual(len(pipeline),21)
        for key in api.STARTUP_PIPELINE_TARGETS:
            self.assertTrue(pipeline[key]['family_present']);self.assertTrue(pipeline[key]['selected_present']);self.assertEqual(pipeline[key]['finite_values'],[2]);self.assertEqual(pipeline[key]['series_count'],1);self.assertEqual(pipeline[key]['aggregation'],'sum')
        public=json.dumps(result)
        for private in ['PRIVATE','"one"','"two"','app_context','operation_status','origin="','remote="']:self.assertNotIn(private,public)
    def test_zero_absent_foreign_chain_and_origin_never_become_invented_counts(self):
        family='hyperlane_contract_sync_stored_events';zero=self.metric(family,{'data_type':'dispatched_messages','chain':'one'},0)
        rows=self.project(zero);self.assertEqual(rows[0]['pipeline']['origin_dispatch_stored']['finite_values'],[0]);self.assertTrue(rows[0]['pipeline']['origin_dispatch_stored']['selected_present'])
        self.assertTrue(rows[1]['pipeline']['origin_dispatch_stored']['family_present']);self.assertFalse(rows[1]['pipeline']['origin_dispatch_stored']['selected_present']);self.assertEqual(rows[1]['pipeline']['origin_dispatch_stored']['finite_values'],[]);self.assertFalse(rows[0]['pipeline']['metadata_success']['family_present'])
        foreign=self.metric('hyperlane_metadata_build_count',{'origin':'PRIVATE_ORIGIN','remote':'one','app_context':'PRIVATE','status':'failure'},9)
        out=self.project(foreign);self.assertTrue(out[0]['pipeline']['metadata_failure']['family_present']);self.assertFalse(out[0]['pipeline']['metadata_failure']['selected_present']);self.assertNotIn('PRIVATE',json.dumps(out))
    def test_actual_queue_and_metadata_groups_sum_contexts_without_exporting_labels(self):
        raw=b''.join(self.metric('hyperlane_submitter_queue_length',{'remote':'two','queue_name':'prepare_queue','operation_status':status,'app_context':context},count)for status,context,count in [('ReadyToSubmit','PRIVATE_A',3),('Retry(PRIVATE_STATUS)','PRIVATE_B',4)])
        raw+=self.metric('hyperlane_metadata_build_count',{'origin':'one','remote':'two','app_context':'PRIVATE_A','status':'failure'},5)+self.metric('hyperlane_metadata_build_count',{'origin':'two','remote':'two','app_context':'PRIVATE_B','status':'failure'},7)
        out=self.project(raw);self.assertEqual(out[1]['pipeline']['queue_prepare']['finite_values'],[7]);self.assertEqual(out[1]['pipeline']['queue_prepare']['series_count'],2);self.assertEqual(out[1]['pipeline']['metadata_failure']['finite_values'],[12]);self.assertEqual(out[1]['pipeline']['metadata_failure']['series_count'],2);self.assertNotIn('PRIVATE',json.dumps(out))
    def test_integer_nonnegative_duplicate_enum_shape_and_aggregate_overflow_refuse(self):
        family='hyperlane_operations_processed_count';labels={'chain':'one','phase':'prepared','app_context':'PRIVATE_A'}
        cases=[self.metric(family,labels,value)for value in [-1,'0.25','NaN','Inf','9007199254740993']]
        row=self.metric(family,labels);cases += [row+row,self.metric(family,{**labels,'phase':'PRIVATE'}),self.metric(family,{**labels,'foreign_label':'PRIVATE'}),self.metric(family,{'chain':'one','phase':'prepared'}),self.metric(family,labels,2**53)+self.metric(family,{**labels,'app_context':'PRIVATE_B'},1)]
        for raw in cases:
            with self.subTest(bytes=len(raw)),self.assertRaises(ValueError):self.project(raw)
    def test_original_per_group16_and_global512_and_body1MiB_bounds_survive(self):
        family='hyperlane_operations_processed_count'
        def row(index,chain='one'):return self.metric(family,{'chain':chain,'phase':'confirmed','app_context':'PRIVATE_'+str(index)},1)
        sixteen=b''.join(row(i)for i in range(16));value=self.project(sixteen)[0]['pipeline']['operations_confirmed'];self.assertEqual(value['series_count'],16);self.assertEqual(value['finite_values'],[16])
        with self.assertRaises(ValueError):self.project(sixteen+row(16))
        foreign=b''.join(row(i,'foreign'+str(i))for i in range(512));out=self.project(foreign);self.assertFalse(out[0]['pipeline']['operations_confirmed']['selected_present'])
        with self.assertRaises(ValueError):self.project(foreign+row(512,'foreign512'))
        with self.assertRaises(ValueError):self.project(b'x'*(1024**2+1))
    def test_source_bound_range_fetch_warning_is_stream_only_not_domain_or_task(self):
        repo=HERE.parents[1];name='zig/src/agents/indexing/source.zig';source=(repo/name).read_bytes();sources={name:source,'errors.zig':b'error.RpcError; error.InvalidCairoBytes'}
        raw=b'<RLY> warning: origin dispatch range fetch failed; retry in 5000ms: RpcError\n<RLY> warn: origin insertion range fetch failed; retry in 300000ms: InvalidCairoBytes\n<RLY> warning: origin gas range fetch failed; retry in 10000ms: PRIVATE_SENTINEL\n'
        out=api.startup_header_projection(raw,sources);self.assertEqual(out['counts']['origin_range_fetch_warning'],3);self.assertEqual(out['counts']['supervised_task_failed'],0);self.assertEqual([v['stream']for v in out['observations']],['dispatch','insertion','gas']);self.assertEqual([v['retry_delay_ms']for v in out['observations']],[5000,300000,10000]);self.assertEqual([v['Source_error_name']for v in out['observations']],['RpcError','InvalidCairoBytes',None])
        for row in out['observations']:self.assertIsNone(row['task_index']);self.assertIsNone(row['lane_attribution']);self.assertNotIn('chain_index',row)
        self.assertNotIn('PRIVATE',json.dumps(out))
    def test_missing_duplicate_changed_emitter_foreign_malformed_and_oversize_refuse_new_header_only(self):
        name='zig/src/agents/indexing/source.zig';source=(HERE.parents[1]/name).read_bytes();valid=b'<RLY> warning: origin dispatch range fetch failed; retry in 5000ms: RpcError\n'
        for body in [b'',source+source,source.replace(b'origin {s} range fetch failed;',b'changed {s} range fetch failed;')]:self.assertEqual(api.startup_header_projection(valid,{name:body})['counts']['origin_range_fetch_warning'],0)
        bad=[valid.replace(b'<RLY>',b'<SCR>'),valid.replace(b'origin dispatch',b'origin PRIVATE'),valid.replace(b'5000ms',b'0ms'),valid.replace(b'5000ms',b'05000ms'),valid.replace(b'5000ms',b'300001ms'),valid.replace(b'RpcError',b'PRIVATE/error'),valid.rstrip()+b' suffix\n',valid.rstrip()+b'x'*16384+b'\n']
        self.assertEqual(api.startup_header_projection(b''.join(bad),{name:source})['counts']['origin_range_fetch_warning'],0)
        ansi=b'\x1b[31m'+valid.rstrip()+b'\x1b[0m\n';self.assertEqual(api.startup_header_projection(ansi,{name:source})['counts']['origin_range_fetch_warning'],1)
    def test_warning_count_survives_original16_rows_without_error_or_stream_label_leak(self):
        name='zig/src/agents/indexing/source.zig';source=(HERE.parents[1]/name).read_bytes();raw=b''.join(('<RLY> warning: origin dispatch range fetch failed; retry in '+str(i)+'ms: PRIVATE_'+str(i)+'\n').encode()for i in range(1,20))
        out=api.startup_header_projection(raw,{name:source});self.assertEqual(out['counts']['origin_range_fetch_warning'],19);self.assertEqual(len(out['observations']),16);self.assertTrue(all(v['Source_error_name']is None for v in out['observations']));self.assertNotIn('PRIVATE',json.dumps(out))


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
        artifact={'path':'/public/relayer','bytes':4,'sha256':'a'*64};manifest={'scenario':'evm','runtime_source_commit':'1'*40,'artifacts':{'relayer':artifact}}
        capture={'role':'relayer','runtime_source_commit':'1'*40,'scenario':'evm','harness_pid':42,'metrics_port':9092,'role_chain_names':['one'],'chains':{'one':{'protocol':'ethereum'}}};child={'role':'relayer','pid':43,'parent_pid':42,'os_start_token':'43 42 Mon Jan 1 00:00:00 2026 /public/relayer','executable':artifact}
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



class TronCLIAdmittedProjectionControls(unittest.TestCase):
    def setUp(self):
        fixture=FixtureFailureDiscriminatorControls();fixture.setUp();self.addCleanup(fixture.doCleanups);self.f=fixture;self.case=fixture.case;self.root=self.case/'tron-cli';self.root.mkdir();(self.root/'dist/src/deploy').mkdir(parents=True)
        self.entry=self.root/'dist/cli.js';self.entry.write_bytes(b"errorRed('Error: ' + error.message); process.exit(1); // Hyperlane\n")
        self.utils=self.root/'dist/src/deploy/utils.js';self.utils.write_bytes(b"throw new Error('Empty chain selection'); throw new Error('signer is invalid'); throw new Error('Deployment cancelled'); log('Running pre-flight checks for chains...');\n")
        self.js=self.root/'dist/src/public-frame.js';self.js.write_text('export const first = 1;\nconst face = "😀x";\n')
        self.tool=self.case/'pnpm-native';self.tool.write_bytes(b'PUBLIC_TOOL_ONLY');receipt=self.case/'tron-cli-materialized.json';receipt.write_bytes(b'{}')
        join_name='rust/main/utils/run-locally/src/utils.rs';self.join=self.f.repo/join_name;self.join.write_bytes((Path(__file__).resolve().parents[2]/join_name).read_bytes());self.f.sources[join_name]=api.pin(self.join)
        tre={'pnpm':api.pin(self.tool),'cli_directory':str(self.root),'cli_entrypoint':api.pin(self.entry)};self.inputs={'tron_tre':tre,'tron_cli':api.pin(receipt)};self.f.approval={'tron_tre':copy.deepcopy(tre),'tron_cli':api.pin(receipt)};self.required=[api.pin(p)for p in [receipt,self.tool,self.entry,self.utils,self.js]]
    def line(self,text,prefix='pnpm-native'):return '<'+prefix+'> '+text+'\n'
    def stack(self,path=None,line=2,column=4):return self.line('    at SECRET_FUNCTION (file://'+str(path or self.js)+':'+str(line)+':'+str(column)+')')
    def panic(self,args=None):return self.f.header(self.f.program,self.f.pline)+self.f.program_body(args or['hyperlane','core','deploy','--key.ethereum','PRIVATE_KEY'],binary=str(self.tool))+'\n'
    def log(self,body='',start=True,panic=True):return ('<E2E> Deploying core contracts to anvil1...\n'if start else'')+body+(self.panic()if panic else'')
    def observe(self,wire):
        self.f.log.write_text(wire);return api.fixture_failure_observation(self.case,self.f.manifest,self.f.approval,42,self.f.sources,self.f.repo,self.f.log,case_inputs=self.inputs,required_inputs=self.required)
    def test_actual_single_scan_Source_gate_prefix_UTF16_and_privacy(self):
        col=len(self.js.read_text().splitlines()[1].encode('utf-16-le'))//2+1
        wire=self.log(self.line('Error: PRIVATE_KEY https://PRIVATE_URL/?token=SECRET')+self.stack(column=col))
        original=api.captured_failure_bytes;reads=[]
        def capture(path,maximum):reads.append(Path(path));return original(path,maximum)
        with mock.patch.object(api,'captured_failure_bytes',side_effect=capture):value=self.observe(wire)
        result=value['CLI_failure'];self.assertEqual(result['collection_status'],'observed');self.assertEqual(reads.count(self.f.log),1);self.assertEqual(result['emitted_JS_coordinates'],[{'source':'dist/src/public-frame.js','line':2,'column':col,'source_bytes':self.js.stat().st_size,'source_sha256':api.pin(self.js)['sha256']}]);self.assertIsNone(result['CLI_numeric_status']);self.assertFalse(result['native_or_timing_or_cleanup_authority']);self.assertFalse(result['error_header_fingerprints'][0]['typed_exception'])
        public=json.dumps(result)
        for secret in ['PRIVATE_KEY','PRIVATE_URL','SECRET_FUNCTION','SECRET',str(self.case),'file://']:self.assertNotIn(secret,public)
        self.assertEqual(value['panic_observations'][0]['category'],'HYPERLANE_CORE_DEPLOY')
    def test_known_complete_emitted_literal_vs_unknown_and_message_only(self):
        value=self.observe(self.log(self.line('Error: Empty chain selection')));result=value['CLI_failure'];self.assertEqual(result['last_seen_header']['enum'],'EMPTY_CHAIN_SELECTION_TEXT');self.assertEqual(result['emitted_JS_coordinates'],[])
        self.utils.write_bytes(b'// literal removed\n');self.required=[api.pin(self.utils)if row['path']==str(self.utils)else row for row in self.required];result=self.observe(self.log(self.line('Error: Empty chain selection')))['CLI_failure'];self.assertIsNone(result['last_seen_header']);self.assertEqual(len(result['error_header_fingerprints']),1)
    def test_wrong_prefix_before_window_after_panic_and_later_guard_never_borrow(self):
        cases=[self.line('Error: Empty chain selection')+self.stack()+self.log(),self.log(self.line('at '+str(self.js)+':2:1',prefix='pnpm')),self.log()+self.stack()+self.line('Error: Empty chain selection')]
        for wire in cases:
            result=self.observe(wire)['CLI_failure'];self.assertEqual(result['emitted_JS_coordinates'],[]);self.assertIsNone(result['last_seen_header'])
        wrong=self.log(self.stack(),panic=False)+self.f.header(self.f.program,self.f.pline)+'PRIVATE_UNKNOWN_FIRST_MESSAGE\n'+self.panic();self.assertEqual(self.observe(wrong)['CLI_failure']['collection_status'],'unavailable')
    def test_returned_stage_duplicate_start_and_wrong_program_unavailable(self):
        for wire in [self.log(self.stack(),panic=False)+'<E2E> Deployed core contracts to anvil1\n'+self.panic(),self.log(self.stack(),panic=False)+'<E2E> Deploying core contracts to anvil1...\n'+self.panic(),self.log(self.stack(),panic=False)+self.panic(['hyperlane','send','message'])]:
            self.assertEqual(self.observe(wire)['CLI_failure']['collection_status'],'unavailable')
    def test_missing_mismatched_symlink_foreign_source_and_sourcemap_omit(self):
        foreign=self.case/'foreign.js';foreign.write_bytes(b'export const x=1;\n');link=self.root/'dist/link.js';link.symlink_to(self.js)
        for path in [foreign,link,self.root/'dist/missing.js',self.root/'dist/file.ts']:
            result=self.observe(self.log(self.stack(path=path,line=1,column=1)))['CLI_failure'];self.assertEqual(result['emitted_JS_coordinates'],[])
        self.js.write_bytes(self.js.read_bytes()+b'// changed\n');result=self.observe(self.log(self.stack()))['CLI_failure'];self.assertEqual(result['emitted_JS_coordinates'],[])
    def test_actual_preadmitted_workspace_JS_descriptor_and_ambiguous_pin(self):
        path=self.root/'.workspace/typescript/sdk/dist/public.js';path.parent.mkdir(parents=True);path.write_bytes(b'export const public_value=1;\n');row=api.pin(path);self.required.append(row)
        result=self.observe(self.log(self.stack(path=path,line=1,column=1)))['CLI_failure'];self.assertEqual(result['emitted_JS_coordinates'][0]['source'],'.workspace/typescript/sdk/dist/public.js')
        self.required.append({**row,'sha256':'0'*64});self.assertEqual(self.observe(self.log(self.stack(path=path,line=1,column=1)))['CLI_failure']['emitted_JS_coordinates'],[])
    def test_UTF16_out_of_line_coordinates_and_duplicate_frames(self):
        col=len(self.js.read_text().splitlines()[1].encode('utf-16-le'))//2+2
        for line,column in [(0,1),(999,1),(2,0),(2,col)]:self.assertEqual(self.observe(self.log(self.stack(line=line,column=column)))['CLI_failure']['emitted_JS_coordinates'],[])
        result=self.observe(self.log(self.stack()*3))['CLI_failure'];self.assertEqual(len(result['emitted_JS_coordinates']),1)
        self.js.write_text('const text = \"a\u0085b\";\n');self.required=[api.pin(self.js)if row['path']==str(self.js)else row for row in self.required];self.assertEqual(self.observe(self.log(self.stack(line=2,column=2)))['CLI_failure']['emitted_JS_coordinates'],[])
    def test_context_receipt_tool_membership_and_entry_contract_fail_closed(self):
        saved=self.required
        for row in saved[:3]:
            self.required=[r for r in saved if r!=row];result=self.observe(self.log(self.stack()));self.assertEqual(result['CLI_failure']['collection_status'],'unavailable');self.assertEqual(result['panic_observations'][0]['category'],'HYPERLANE_CORE_DEPLOY')
        self.required=saved;self.entry.write_bytes(b'// no catch contract\n');self.required=[api.pin(self.entry)if row['path']==str(self.entry)else row for row in saved];self.inputs['tron_tre']['cli_entrypoint']=api.pin(self.entry);self.f.approval['tron_tre']=copy.deepcopy(self.inputs['tron_tre']);self.assertEqual(self.observe(self.log(self.stack()))['CLI_failure']['collection_status'],'unavailable')
    def test_collector_failure_cannot_mask_existing_Rust_observation(self):
        with mock.patch.object(api.TronCLIProjection,'feed',side_effect=ValueError('PRIVATE_REASON')):value=self.observe(self.log(self.stack()))
        self.assertEqual(value['panic_observations'][0]['category'],'HYPERLANE_CORE_DEPLOY');self.assertEqual(value['CLI_failure']['collection_status'],'unavailable');self.assertNotIn('PRIVATE',json.dumps(value))
    def test_Source_mutation_before_publication_unavailable(self):
        original=api.TronCLIProjection.public
        def changed(state):self.js.write_bytes(self.js.read_bytes()+b'\n');return original(state)
        with mock.patch.object(api.TronCLIProjection,'public',changed):result=self.observe(self.log(self.stack()))
        self.assertEqual(result['CLI_failure']['collection_status'],'unavailable');self.assertEqual(result['panic_observations'][0]['category'],'HYPERLANE_CORE_DEPLOY')
    def test_max8frames_1MiBfile_4MiBtotal_and_candidate_count(self):
        p=self.root/'dist/frames.js';p.write_bytes(b'export const x=1;\n'*10);self.required.append(api.pin(p))
        text=''.join(self.stack(path=p,line=i+1,column=1)for i in range(10))
        capped=self.observe(self.log(text))['CLI_failure'];self.assertEqual(len(capped['emitted_JS_coordinates']),8);self.assertTrue(capped['frame_candidates_truncated'])
        huge=self.root/'dist/huge.js'
        with huge.open('wb')as stream:stream.truncate(1024**2+1)
        self.required.append({'path':str(huge),'bytes':huge.stat().st_size,'sha256':'0'*64});self.assertEqual(self.observe(self.log(self.stack(path=huge,line=1,column=1)))['CLI_failure']['emitted_JS_coordinates'],[])
        large=''
        for i in range(4):
            p=self.root/('dist/large'+str(i)+'.js');p.write_bytes(b'//'+b'a'*(1024**2-3)+b'\n');self.required.append(api.pin(p));large+=self.stack(path=p,line=1,column=1)
        self.assertEqual(len(self.observe(self.log(large))['CLI_failure']['emitted_JS_coordinates']),3)
        text=''.join(self.stack(path=self.root/('dist/unknown'+str(i)+'.js'),line=1,column=1)for i in range(40));self.assertTrue(self.observe(self.log(text))['CLI_failure']['frame_candidates_truncated'])
    def test_eight_total_Source_files_includes_entry_and_known_header(self):
        text=self.line('Error: Empty chain selection')
        for i in range(10):
            p=self.root/('dist/file'+str(i)+'.js');p.write_bytes(b'export const x=1;\n');self.required.append(api.pin(p));text+=self.stack(path=p,line=1,column=1)
        result=self.observe(self.log(text))['CLI_failure'];self.assertEqual(len(result['emitted_JS_coordinates']),6);self.assertEqual(result['unadmitted_coordinates_omitted'],4);self.assertEqual(result['last_seen_header']['enum'],'EMPTY_CHAIN_SELECTION_TEXT')

    def test_missing_fixed_header_Source_lookup_is_attempted_once(self):
        self.required=[row for row in self.required if row['path']!=str(self.utils)];calls=[];original=api.TronCLIProjection.capture
        def capture(state,path):calls.append(path);return original(state,path)
        with mock.patch.object(api.TronCLIProjection,'capture',capture):result=self.observe(self.log(self.line('Error: Empty chain selection')*100))['CLI_failure']
        self.assertEqual(calls.count(str(self.utils)),1);self.assertIsNone(result['last_seen_header']);self.assertEqual(len(result['error_header_fingerprints']),1)

    def test_partial_Source_text_never_grants_banner_or_complete_header(self):
        self.assertIsNone(self.observe(self.log(self.line('Hyperlane CLI')))['CLI_failure']['last_seen_header'])
        for body in [b'// Empty chain selection\n',b"throw new Error('prefix Empty chain selection suffix');\n",b"throw new Error('Empty chain selection suffix');\n",b"log('Empty chain selection');\n",b"DifferentError('Empty chain selection');\n"]:
            self.utils.write_bytes(body);self.required=[api.pin(self.utils)if row['path']==str(self.utils)else row for row in self.required]
            self.assertIsNone(self.observe(self.log(self.line('Error: Empty chain selection')))['CLI_failure']['last_seen_header'])
        for quote in ["'",'"','`']:
            self.utils.write_text('throw new Error('+quote+'Empty chain selection'+quote+');\n');self.required=[api.pin(self.utils)if row['path']==str(self.utils)else row for row in self.required]
            self.assertEqual(self.observe(self.log(self.line('Error: Empty chain selection')))['CLI_failure']['last_seen_header']['enum'],'EMPTY_CHAIN_SELECTION_TEXT')

    def test_unique_header_fingerprints_keep_first_line_and_later_distinct(self):
        result=self.observe(self.log(self.line('Error: PRIVATE_FIRST')*100+self.line('Error: PRIVATE_SECOND')))['CLI_failure'];rows=result['error_header_fingerprints'];self.assertEqual(len(rows),2);self.assertEqual(rows[0]['log_line'],2);self.assertNotEqual(rows[0]['sha256'],rows[1]['sha256']);self.assertNotIn('PRIVATE',json.dumps(result))

    def test_CLI_pipe_read_error_flag_has_no_underlying_text(self):
        result=self.observe(self.log('<E2E> Error reading from output for pnpm-native: PRIVATE_UTF8_OR_OTHER\n'))['CLI_failure'];self.assertTrue(result['CLI_pipe_read_error_observed']);self.assertNotIn('PRIVATE',json.dumps(result))

    def cascade(self,inline=False,path='rust/main/utils/run-locally/src/utils.rs',line=82,column=23,message='Task thread panicked!: Any { .. }'):
        return "thread 'PRIVATE_THREAD' (45) panicked at /build/"+path+':'+str(line)+':'+str(column)+':'+(' '+message+'\n'if inline else'\n'+message+'\n')

    def test_exact_Source_known_join_cascade_preserves_only_first_window(self):
        for inline in [False,True]:
            original=self.observe(self.log(self.line('Error: PRIVATE_KEY')+self.stack()))['CLI_failure']
            result=self.observe(self.log(self.line('Error: PRIVATE_KEY')+self.stack())+self.cascade(inline)+self.line('Error: PRIVATE_AFTER')+self.stack(line=1))['CLI_failure']
            self.assertEqual(result['collection_status'],'observed');self.assertEqual(result['known_join_cascade_count'],1);self.assertEqual(result['frontier'],'QUALIFIED_PRIMARY_WITH_JOIN_CASCADE')
            for field in ['window','error_header_fingerprints','emitted_JS_coordinates']:self.assertEqual(result[field],original[field])
            self.assertEqual(result['known_join_Source'],{'module':'rust/main/utils/run-locally/src/utils.rs','line':82,'column':23,'source_bytes':self.join.stat().st_size,'source_sha256':api.pin(self.join)['sha256']})
            for secret in ['PRIVATE_KEY','PRIVATE_THREAD','PRIVATE_AFTER',str(self.case),'/build/','Any {']:self.assertNotIn(secret,json.dumps(result))

    def test_unknown_duplicate_or_inexact_second_panic_remains_unavailable(self):
        for suffix in [self.panic(),self.cascade(path='outside/utils.rs'),self.cascade(line=81),self.cascade(column=24),self.cascade(message='Task thread panicked!: PRIVATE_ERROR'),self.cascade()+self.cascade(),self.cascade()+self.panic(),self.cascade(message='UNKNOWN')]:
            result=self.observe(self.log(self.stack())+suffix)['CLI_failure'];self.assertEqual(result['collection_status'],'unavailable');self.assertIn(result['discard_reason'],{'LATER_PANIC_AMBIGUITY','JOIN_CASCADE_MESSAGE_REJECTED'});self.assertNotIn('PRIVATE',json.dumps(result))
        result=self.observe(self.log(self.stack(),panic=False)+self.f.header(self.f.program,self.f.pline)+'UNKNOWN_PRIMARY\n'+self.cascade())['CLI_failure'];self.assertEqual(result['collection_status'],'unavailable')

    def test_join_cascade_requires_admitted_unchanged_exact_Source(self):
        name='rust/main/utils/run-locally/src/utils.rs';original=self.join.read_bytes();row=self.f.sources[name]
        for mode in ['missing_pin','changed','wrong_statement','wrong_line']:
            self.join.write_bytes(original);self.f.sources[name]=row
            if mode=='missing_pin':self.f.sources.pop(name)
            elif mode=='changed':self.join.write_bytes(original+b'\n')
            elif mode=='wrong_statement':self.join.write_bytes(original.replace(b'Task thread panicked!',b'OTHER SOURCE MESSAGE'));self.f.sources[name]=api.pin(self.join)
            else:self.join.write_bytes(b'\n'+original);self.f.sources[name]=api.pin(self.join)
            result=self.observe(self.log(self.stack())+self.cascade())['CLI_failure'];self.assertEqual(result['collection_status'],'unavailable');self.assertEqual(result['join_source_status'],'UNAVAILABLE');self.assertEqual(result['source_capture_failures'],1)
        self.join.write_bytes(original);self.f.sources[name]=row

    def test_finite_constructor_capture_contract_and_collector_frontiers(self):
        saved=self.required;self.required=[r for r in saved if r!=self.inputs['tron_cli']]
        result=self.observe(self.log())['CLI_failure'];self.assertEqual((result['discard_reason'],result['frontier']),('CONSTRUCTOR_CONTEXT_REJECTED','CONSTRUCTOR'))
        self.required=saved;self.entry.write_bytes(self.entry.read_bytes()+b' changed')
        result=self.observe(self.log())['CLI_failure'];self.assertEqual(result['discard_reason'],'ENTRY_SOURCE_CAPTURE_REJECTED')
        self.entry.write_bytes(b'// missing catch\n');self.required=[api.pin(self.entry)if r['path']==str(self.entry)else r for r in saved];self.inputs['tron_tre']['cli_entrypoint']=api.pin(self.entry);self.f.approval['tron_tre']=copy.deepcopy(self.inputs['tron_tre'])
        self.assertEqual(self.observe(self.log())['CLI_failure']['discard_reason'],'ENTRY_SOURCE_CONTRACT_REJECTED')
        self.entry.write_bytes(b"errorRed('Error: ' + error.message); process.exit(1);\n");self.required=[api.pin(self.entry)if r['path']==str(self.entry)else r for r in saved];self.inputs['tron_tre']['cli_entrypoint']=api.pin(self.entry);self.f.approval['tron_tre']=copy.deepcopy(self.inputs['tron_tre'])
        with mock.patch.object(api.TronCLIProjection,'feed',side_effect=ValueError('PRIVATE_REASON https://PRIVATE_URL')):result=self.observe(self.log())['CLI_failure']
        self.assertEqual((result['discard_reason'],result['frontier']),('COLLECTOR_FAILED','WINDOW_SCAN'));self.assertNotIn('PRIVATE',json.dumps(result))

    def test_unqualified_window_closed_and_duplicate_frontiers(self):
        for wire,reason in [(self.line('Error: PRIVATE'), 'NO_QUALIFIED_WINDOW'),(self.log(panic=False)+'<E2E> Deployed core contracts to anvil1\n'+self.panic(),'DEPLOY_WINDOW_CLOSED'),(self.log(panic=False)+'<E2E> Deploying core contracts to anvil1...\n'+self.panic(),'DUPLICATE_FIRST_DEPLOY'),(self.log(panic=False)+self.f.header(self.f.program,self.f.pline)+'UNKNOWN_PRIMARY\n','PRIMARY_PANIC_UNQUALIFIED')]:
            result=self.observe(wire)['CLI_failure'];self.assertEqual(result['collection_status'],'unavailable');self.assertEqual(result['discard_reason'],reason);self.assertFalse(result['native_or_timing_or_cleanup_authority']);self.assertNotIn('PRIVATE',json.dumps(result))

    def test_pending_cascade_does_not_grant_unfinished_or_blank_unbounded_messages(self):
        header=self.cascade().splitlines()[0]+'\n'
        for tail in ['', '\n\nTask thread panicked!: Any { .. }\n','<pnpm-native> Error: PRIVATE\n']:
            result=self.observe(self.log(self.stack())+header+tail)['CLI_failure'];self.assertEqual(result['collection_status'],'unavailable');self.assertIn(result['discard_reason'],{'JOIN_CASCADE_MESSAGE_UNQUALIFIED','JOIN_CASCADE_MESSAGE_REJECTED'});self.assertNotIn('PRIVATE',json.dumps(result))

    def test_join_Source_rechecked_at_publication_and_single_harness_capture(self):
        original=api.TronCLIProjection.public
        def changed(state):self.join.write_bytes(self.join.read_bytes()+b'\n');return original(state)
        with mock.patch.object(api.TronCLIProjection,'public',changed):result=self.observe(self.log(self.stack())+self.cascade())['CLI_failure']
        self.assertEqual(result['collection_status'],'unavailable');self.assertEqual((result['discard_reason'],result['frontier']),('PUBLIC_SOURCE_RECHECK_FAILED','PUBLICATION'))
        self.f.sources['rust/main/utils/run-locally/src/utils.rs']=api.pin(self.join);original_capture=api.captured_failure_bytes;reads=[]
        def capture(path,maximum):reads.append(Path(path));return original_capture(path,maximum)
        with mock.patch.object(api,'captured_failure_bytes',side_effect=capture):self.observe(self.log(self.stack()))
        self.assertEqual(reads.count(self.f.log),1);self.assertEqual(reads.count(self.join),1)

    def test_unavailable_public_enum_guard_never_copies_exception_attributes(self):
        result=api.tron_cli_unavailable('PRIVATE_REASON https://PRIVATE_URL','PRIVATE_FRONTIER')
        self.assertEqual(result['discard_reason'],'COLLECTOR_FAILED');self.assertEqual(result['frontier'],'WINDOW_SCAN');self.assertNotIn('PRIVATE',json.dumps(result));self.assertFalse(result['native_or_timing_or_cleanup_authority'])


class TronCaughtCauseControls(unittest.TestCase):
    def setUp(self):
        self.f=TronCLIAdmittedProjectionControls();self.f.setUp();self.addCleanup(self.f.doCleanups)
        self.source=self.f.f.repo/'zig/bench/native_tron_assets.py';self.source.parent.mkdir(parents=True);self.source.write_bytes((Path(__file__).resolve().parents[1]/'bench/native_tron_assets.py').read_bytes())
        names={'CLI_CAUSE_INSERT','CLI_CATCH_BODY','CLI_ORIGINAL_OPEN','CLI_ORIGINAL_END','CLI_CATCH_OBSERVER','CLI_CAUSE_KEY_ID'}
        constants={node.targets[0].id:ast.literal_eval(node.value)for node in ast.parse(self.source.read_bytes()).body if isinstance(node,ast.Assign)and len(node.targets)==1 and isinstance(node.targets[0],ast.Name)and node.targets[0].id in names};self.key_id=constants['CLI_CAUSE_KEY_ID']
        self.f.entry.write_bytes(b"import _args from 'yargs';\n"+constants['CLI_CAUSE_INSERT']+constants['CLI_ORIGINAL_OPEN']+b'\n'+constants['CLI_ORIGINAL_END']+b'\n}\ncatch (error) {'+constants['CLI_CATCH_OBSERVER']+b'\n'+constants['CLI_CATCH_BODY']+b'\n}\n');row=api.pin(self.f.entry);self.f.required=[row if r['path']==str(self.f.entry)else r for r in self.f.required]+[api.pin(self.source)];self.f.inputs['tron_tre']['cli_entrypoint']=row;self.f.f.approval['tron_tre']=copy.deepcopy(self.f.inputs['tron_tre'])
    def payload(self,**changes):
        cipher=bytes(range(256))*2;value={'schema':1,'status':'ENCRYPTED_PREFIX','key_id':self.key_id,'prefix_bytes':85,'truncated':False,'ciphertext_base64':base64.b64encode(cipher).decode('ascii'),'ciphertext_sha256':hashlib.sha256(cipher).hexdigest()};value.update(changes);return value
    def record(self,**changes):return self.f.line('HYPERLANE_TRON_ENCRYPTED_V1 '+json.dumps(self.payload(**changes),separators=(',',':')))
    def observe(self,body):return self.f.observe(self.f.log(body))['CLI_failure']
    def test_source_bound_closed_caught_record_preserves_existing_primary(self):
        value=self.observe(self.record()+self.f.line('Error: PRIVATE_MESSAGE https://PRIVATE_URL/?token=PRIVATE_TOKEN'));cause=value['caught_cause'];self.assertEqual(cause['collection_status'],'observed');self.assertEqual(cause['encrypted_prefix'],self.payload());self.assertFalse(cause['typed_exception_or_root_cause_claim']);self.assertEqual(len(value['error_header_fingerprints']),1)
        public=json.dumps(value)
        for secret in ['PRIVATE_MESSAGE','PRIVATE_URL','PRIVATE_TOKEN',str(self.f.case)]:self.assertNotIn(secret,public)
        for key in ['reported_standard_class','own_data_code','role','pid','signal']:self.assertNotIn(key,cause)
    def test_unavailable_zero_maximum_prefix_and_no_invented_type(self):
        value=self.f.line('HYPERLANE_TRON_ENCRYPTED_V1 '+json.dumps({'schema':1,'status':'ENCRYPTION_UNAVAILABLE'}));self.assertEqual(self.observe(value)['caught_cause'],{'collection_status':'unavailable','reason':'ENCRYPTION_UNAVAILABLE'})
        for count in [0,384]:self.assertEqual(self.observe(self.record(prefix_bytes=count,truncated=True))['caught_cause']['encrypted_prefix']['prefix_bytes'],count)
    def test_unknown_payload_types_fields_duplicate_or_oversized_never_publish(self):
        payload=self.payload();alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';wire=payload['ciphertext_base64'];noncanonical=wire[:-2]+alphabet[alphabet.index(wire[-2])+1]+'='
        cases=[self.record(key_id='0'*64),self.record(schema=True),self.record(prefix_bytes=True),self.record(prefix_bytes=-1),self.record(prefix_bytes=385),self.record(truncated=1),self.record(ciphertext_base64='A'*684),self.record(ciphertext_base64=noncanonical),self.record(ciphertext_sha256='0'*64),self.record(extra='PRIVATE_VALUE'),self.record()*2,self.f.line('HYPERLANE_TRON_ENCRYPTED_V1 '+('x'*4097)),self.f.line('HYPERLANE_TRON_ENCRYPTED_V1 {"schema":1,"schema":1}')]
        for wire in cases:
            with self.subTest(size=len(wire)):
                value=self.observe(wire);self.assertEqual(value['caught_cause']['collection_status'],'unavailable');self.assertNotIn('PRIVATE',json.dumps(value))
    def test_marker_requires_original_window_and_admitted_derivative(self):
        value=self.f.observe(self.record()+self.f.log()+self.record())['CLI_failure'];self.assertEqual(value['caught_cause']['reason'],'MARKER_NOT_OBSERVED')
        self.f.entry.write_bytes(b"errorRed('Error: ' + error.message); process.exit(1);");row=api.pin(self.f.entry);self.f.required=[row if r['path']==str(self.f.entry)else r for r in self.f.required];self.f.inputs['tron_tre']['cli_entrypoint']=row;self.f.f.approval['tron_tre']=copy.deepcopy(self.f.inputs['tron_tre']);self.assertEqual(self.observe(self.record())['caught_cause'],{'collection_status':'unavailable','reason':'DIAGNOSTIC_SOURCE_UNAVAILABLE'})
    def test_missing_mismatched_or_changed_source_refuses_without_raw_reason(self):
        original=list(self.f.required);self.f.required=[r for r in original if r['path']!=str(self.source)];self.assertEqual(self.observe(self.record())['caught_cause'],{'collection_status':'unavailable','reason':'DIAGNOSTIC_SOURCE_UNAVAILABLE'})
        self.f.required=original;self.source.write_bytes(self.source.read_bytes()+b'\n');self.assertEqual(self.observe(self.record())['caught_cause'],{'collection_status':'unavailable','reason':'DIAGNOSTIC_SOURCE_UNAVAILABLE'})
    def test_publication_rechecks_captured_source(self):
        original=api.TronCLIProjection.public
        def changed(state):self.source.write_bytes(self.source.read_bytes()+b'\n');return original(state)
        with mock.patch.object(api.TronCLIProjection,'public',changed):value=self.observe(self.record())
        self.assertEqual(value['caught_cause'],{'collection_status':'unavailable','reason':'DIAGNOSTIC_SOURCE_CHANGED'})


class TronPostwaitPrivateErrorControls(unittest.TestCase):
    def setUp(self):
        self.c=TronCaughtCauseControls();self.c.setUp();self.addCleanup(self.c.doCleanups);self.f=self.c.f
    def observe(self,wire,callback=None):
        self.f.f.log.write_text(wire);selected=[]
        def capture(plain,selection):
            selected.append((plain,selection))
            if callback is not None:callback(plain,selection)
        value=api.fixture_failure_observation(self.f.case,self.f.f.manifest,self.f.f.approval,42,self.f.f.sources,self.f.f.repo,self.f.f.log,case_inputs=self.f.inputs,required_inputs=self.f.required,private_capture=capture)
        return value,selected
    def test_plain_ANSI_JSON_actualcollector_firsterror_private_only(self):
        text='Error: PRIVATE_SECRET https://PRIVATE_HOST/?token=PRIVATE_TOKEN'
        for rendered in [text,'\x1b[31m'+text+'\x1b[0m',json.dumps({'msg':text,'level':50})]:
            value,selected=self.observe(self.f.log(self.f.line(rendered)+self.f.line('Error: SECOND_PRIVATE')))
            self.assertEqual(len(selected),1);plain,selection=selected[0];self.assertEqual(plain,text.encode());self.assertEqual(selection['windows'],[{'tag':'PNPM_NATIVE','position':'first_error','bytes':len(plain),'truncated':False}]);self.assertEqual(value['CLI_failure']['caught_cause']['reason'],'MARKER_NOT_OBSERVED')
            for secret in ['PRIVATE_SECRET','PRIVATE_HOST','PRIVATE_TOKEN','SECOND_PRIVATE']:self.assertNotIn(secret,json.dumps(value))
    def test_wrongprefix_outsidewindow_or_unqualifiedpanic_never_captures(self):
        private=self.f.line('Error: PRIVATE')
        cases=[self.f.log(self.f.line('Error: PRIVATE',prefix='fake-native')),private+self.f.log(),self.f.log()+private,self.f.log(private,panic=False),self.f.log(private).replace('"hyperlane", "core", "deploy"','"hyperlane", "registry", "agent-config"'),self.f.log(private)+'<E2E> Deploying core contracts to anvil1...\n']
        for wire in cases:
            with self.subTest(size=len(wire)):self.assertEqual(self.observe(wire)[1],[])
    def test_oversized_prefixed_line_before_firsterror_never_borrows_later_header(self):
        for text in ['Error: '+('x'*16384),'x'*16385,json.dumps({'msg':'Error: PRIVATE_FIRST\nMORE'}),'{malformed']:
            value,selected=self.observe(self.f.log(self.f.line(text)+self.f.line('Error: PRIVATE_LATER')))
            self.assertEqual(selected,[]);self.assertEqual(value['CLI_failure']['collection_status'],'observed');self.assertEqual(len(value['CLI_failure']['error_header_fingerprints']),1)
        value,selected=self.observe(self.f.log(self.f.line('Error: PRIVATE_FIRST')+self.f.line('x'*16385)))
        self.assertEqual(len(selected),1);self.assertEqual(selected[0][0],b'Error: PRIVATE_FIRST')
    def test_joincascade_retains_firstwindow_and_privateprefix_is_hard4096(self):
        text='Error: '+('é'*6000);value,selected=self.observe(self.f.log(self.f.line(text))+self.f.cascade())
        self.assertEqual(len(selected),1);self.assertEqual(selected[0][0],text.encode()[:4096]);self.assertTrue(selected[0][1]['windows'][0]['truncated']);self.assertEqual(value['CLI_failure']['known_join_cascade_count'],1)
    def test_changed_or_missing_diagnosticSource_and_callback_failure_keep_public(self):
        wire=self.f.log(self.f.line('Error: PRIVATE'))
        self.f.f.log.write_text(wire);without=api.fixture_failure_observation(self.f.case,self.f.f.manifest,self.f.f.approval,42,self.f.f.sources,self.f.f.repo,self.f.f.log,case_inputs=self.f.inputs,required_inputs=self.f.required)
        value,selected=self.observe(wire,lambda *args:(_ for _ in()).throw(KeyboardInterrupt('PRIVATE')));self.assertEqual(value,without);self.assertEqual(len(selected),1)
        self.f.required=[r for r in self.f.required if r['path']!=str(self.c.source)];self.assertEqual(self.observe(wire)[1],[])
    def test_private_method_rechecks_Source_identity_and_clears_bytes(self):
        original=api.TronCLIProjection.public
        def changed(state):
            self.c.source.write_bytes(self.c.source.read_bytes()+b'\n');return original(state)
        with mock.patch.object(api.TronCLIProjection,'public',changed):value,selected=self.observe(self.f.log(self.f.line('Error: PRIVATE')))
        self.assertEqual(selected,[]);self.assertEqual(value['CLI_failure']['caught_cause']['reason'],'DIAGNOSTIC_SOURCE_CHANGED')


class EvmChildWaitTextControls(unittest.TestCase):
    CATALOG=(('fixture monitor poisoned','FIXTURE_MONITOR_POISONED_TEXT'),('fixture PID/start/parent changed','FIXTURE_IDENTITY_CHANGED_TEXT'),('fixture descendant executable not approved','FIXTURE_EXECUTABLE_UNAPPROVED_TEXT'),('fixture descendant count exceeds bound','FIXTURE_DESCENDANT_BOUND_TEXT'),('unknown fixture group member has no observed parent lineage','FIXTURE_LINEAGE_UNOBSERVED_TEXT'),('fixture process snapshot timeout','FIXTURE_SNAPSHOT_TIMEOUT_TEXT'),('fixture process snapshot output limit','FIXTURE_SNAPSHOT_OUTPUT_BOUND_TEXT'),('fixture process snapshot failed','FIXTURE_SNAPSHOT_FAILED_TEXT'))
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name).resolve();self.repo=self.root/'repo';self.sources={}
        for name in ['rust/main/utils/run-locally/src/main.rs','rust/main/utils/run-locally/src/external_agents.rs']:
            p=self.repo/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes((HERE.parents[1]/name).read_bytes());self.sources[name]=api.pin(p)
        self.main=self.repo/'rust/main/utils/run-locally/src/main.rs';self.helper=self.repo/'rust/main/utils/run-locally/src/external_agents.rs';self.log=self.root/'harness.log'
    def header(self,site='utils/run-locally/src/main.rs:828:48'):return ("thread 'PRIVATE_THREAD' (42) panicked at "+site+':\n').encode()
    def body(self,phrase):return ('called `Result::unwrap()` on an `Err` value: Custom { kind: Other, error: "'+phrase+' PRIVATE_KEY /PRIVATE_PATH https://PRIVATE_URL/?token=PRIVATE_TOKEN" }\n').encode()
    def observe(self,wire,sources=None):
        self.log.write_bytes(wire);return api.rust_panic_observation(self.log,self.sources if sources is None else sources,self.repo)
    def test_all8_actual_Source_guard_text_only_and_poison_overlap_no_origin_claim(self):
        for phrase,code in self.CATALOG:
            value=self.observe(self.header()+self.body(phrase));row=value['EVM_child_wait_text'];self.assertEqual(row['collection_status'],'observed');self.assertEqual(row['classification'],'FIXTURE_MONITOR_GUARD_TEXT');self.assertEqual(row['guard_text_code'],code);self.assertIsNone(row['reason']);self.assertTrue(row['text_only']);self.assertFalse(row['native_or_timing_or_cleanup_authority']);self.assertEqual((row['caller_line'],row['caller_column']),(828,48))
            for key in ['typed_IO_error_kind','role','pid','primary_signal']:self.assertIsNone(row[key])
            self.assertEqual(value['reason_codes'],[]);self.assertIsNone(value['reason_source']);self.assertEqual(len(value['sites']),1)
            for secret in ['PRIVATE',str(self.root),'https://']:self.assertNotIn(secret,json.dumps(row))
        self.assertGreater(self.helper.read_bytes().count(b'"fixture monitor poisoned"'),1);self.assertEqual(self.helper.read_bytes().count(b'"fixture process snapshot output limit"'),2)
    def test_same_line_next_nonempty_ANSI_and_full_canonical_Source_paths(self):
        phrase=self.CATALOG[0][0]
        for site in ['utils/run-locally/src/main.rs:828:48','rust/main/utils/run-locally/src/main.rs:828:48','/build/rust/main/utils/run-locally/src/main.rs:828:48']:
            for wire in [self.header(site)+b'\n \n'+self.body(phrase),self.header(site).rstrip(b'\n')+b' '+self.body(phrase),b'\x1b[31m'+self.header(site)+b'\x1b[0m'+self.body(phrase)]:
                with self.subTest(site=site):self.assertEqual(self.observe(wire)['EVM_child_wait_text']['guard_text_code'],'FIXTURE_MONITOR_POISONED_TEXT')
    def test_wrong_immediate_site_column_otherframes_and_second_location_never_borrow(self):
        phrase=self.CATALOG[0][0];later=b' utils/run-locally/src/main.rs:828:48: '+self.body(phrase)
        cases=[self.header('utils/run-locally/src/main.rs:825:48')+self.body(phrase),self.header('/build/../rust/main/utils/run-locally/src/main.rs:828:48')+self.body(phrase),self.header('/build//rust/main/utils/run-locally/src/main.rs:828:48')+self.body(phrase),self.header('/build/\\rust/main/utils/run-locally/src/main.rs:828:48')+self.body(phrase),self.header('utils/run-locally/src/main.rs:830:48')+self.body(phrase),self.header('utils/run-locally/src/main.rs:828:47')+self.body(phrase),self.header('/outside/foreign.rs:828:48')+self.body(phrase),self.header('utils/run-locally/src/main.rs:2:1').rstrip(b'\n')+later,self.header('/outside/foreign.rs:2:1').rstrip(b'\n')+later,self.header('/outside/foreign.rs:1:1')+self.body('unknown')+self.header()+self.body(phrase),b'not '+self.header()+self.body(phrase),b'    at utils/run-locally/src/main.rs:828:48\n'+self.body(phrase)]
        for wire in cases:
            with self.subTest(wire_bytes=len(wire)):self.assertIsNone(self.observe(wire)['EVM_child_wait_text']['guard_text_code'])
    def test_window_closes_on_next_panic_header_unrelated_body_teardown_and_eof(self):
        phrase=self.CATALOG[0][0];cases=[self.header(),self.header()+self.header()+self.body(phrase),self.header()+b'<E2E> external fixture stop failed: '+self.body(phrase),self.header()+b'stack backtrace:\n'+self.body(phrase),self.header()+b'external fixture cleanup failed: '+self.body(phrase),self.header()+b'ordinary unrelated body\n'+self.body(phrase)]
        for wire in cases:
            with self.subTest(bytes=len(wire)):self.assertIsNone(self.observe(wire)['EVM_child_wait_text']['guard_text_code'])
        row=self.observe(self.header()+self.body(phrase)+self.header()+self.body(self.CATALOG[1][0]))['EVM_child_wait_text'];self.assertEqual(row['guard_text_code'],'FIXTURE_MONITOR_POISONED_TEXT')
    def test_unknown_standard_IO_multilabel_encoding_and_oversize_stay_unknown(self):
        bodies=[self.body('No child processes (os error 10)'),self.body('Permission denied'),self.body('unknown private reason'),self.body(self.CATALOG[0][0]+'; '+self.CATALOG[1][0]),self.body(self.CATALOG[0][0])+b' '+b'x'*65536]
        for body in bodies[:4]+[self.body(self.CATALOG[0][0]).rstrip(b'\n')+b'x'*65536+b'\n',self.body(self.CATALOG[0][0]).replace(b'Custom',b'Custom\xff')]:
            with self.subTest(bytes=len(body)):
                row=self.observe(self.header()+body)['EVM_child_wait_text'];self.assertEqual(row['classification'],'UNKNOWN');self.assertIsNone(row['guard_text_code']);self.assertIsNone(row['typed_IO_error_kind']);self.assertIsNone(row['primary_signal']);self.assertNotIn('PRIVATE',json.dumps(row))
        self.assertEqual(self.observe(self.header()+self.body(self.CATALOG[0][0]+'; '+self.CATALOG[0][0]))['EVM_child_wait_text']['guard_text_code'],'FIXTURE_MONITOR_POISONED_TEXT')
    def test_missing_unadmitted_changed_wrapper_monitor_and_caller_Source_refuse(self):
        wire=self.header()+self.body(self.CATALOG[0][0])
        for missing in self.sources:
            sources={k:v for k,v in self.sources.items()if k!=missing};self.assertEqual(self.observe(wire,sources)['EVM_child_wait_text']['reason'],'SOURCE_CONTEXT_UNAVAILABLE')
        original=self.helper.read_bytes()
        for token in [b'self.child.try_wait()',b'return Err(std::io::Error::other(error.clone()));',b'initial.failure = Some(format!("{error:#}"));',b'state.failure = Some(format!("{error:#}"));']:
            self.helper.write_bytes(original.replace(token,b'PUBLIC_DIFFERENT_SOURCE',1));sources={**self.sources,str(self.helper.relative_to(self.repo)):api.pin(self.helper)};self.assertEqual(self.observe(wire,sources)['EVM_child_wait_text']['reason'],'SOURCE_CONTEXT_UNAVAILABLE')
        self.helper.write_bytes(original);self.main.write_bytes(self.main.read_bytes().replace(b'child.try_wait().unwrap()',b'child.try_wait().expect("PUBLIC_OTHER")'));sources={**self.sources,str(self.main.relative_to(self.repo)):api.pin(self.main)};self.assertEqual(self.observe(wire,sources)['EVM_child_wait_text']['reason'],'SOURCE_CONTEXT_UNAVAILABLE')
    def test_guard_literal_or_fragment_elsewhere_cannot_replace_actual_guard_context(self):
        original=self.helper.read_bytes();phrase=b'fixture descendant executable not approved';fragment=b'.find(|a| a.path == actual)\n                .ok_or_else(|| eyre::eyre!("fixture descendant executable not approved"))?;'
        self.assertIn(fragment,original);self.helper.write_bytes(original.replace(phrase,b'PUBLIC_DIFFERENT_GUARD')+b'\n// out-of-context data only\n'+fragment+b'\n');sources={**self.sources,str(self.helper.relative_to(self.repo)):api.pin(self.helper)}
        row=self.observe(self.header()+self.body(phrase.decode()),sources)['EVM_child_wait_text'];self.assertEqual(row['reason'],'SOURCE_CONTEXT_UNAVAILABLE');self.assertIsNone(row['guard_text_code'])
    def test_oversized_ANSI_first_foreign_panic_cannot_borrow_later_main828(self):
        foreign=b"\x1b[31mthread 'PRIVATE_FIRST' (43) panicked at /outside/foreign.rs:2:1: "+b'x'*65536+b'\x1b[0m\n'
        for first in [foreign,b'PRIVATE_LONG_UNCLASSIFIABLE_LINE'+b'x'*65536+b'\n']:
            value=self.observe(first+self.header()+self.body(self.CATALOG[0][0]));row=value['EVM_child_wait_text'];self.assertEqual(row['classification'],'UNKNOWN');self.assertEqual(row['collection_status'],'unavailable');self.assertEqual(row['reason'],'LOG_LINE_BOUND');self.assertIsNone(row['guard_text_code']);self.assertIsNone(row['primary_signal']);self.assertNotIn('PRIVATE',json.dumps(row))

    def test_single_verified_log_capture_and_old_SVM_reason_fields_remain_separate(self):
        opened=[];original=api.os.open
        def tracked(path,*args,**kwargs):
            if Path(path)==self.log:opened.append(path)
            return original(path,*args,**kwargs)
        with mock.patch.object(api.os,'open',side_effect=tracked):value=self.observe(self.header()+self.body(self.CATALOG[0][0]))
        self.assertEqual(len(opened),1);self.assertEqual(value['log_fingerprint'],{'path':str(self.log),'bytes':self.log.stat().st_size,'sha256':hashlib.sha256(self.log.read_bytes()).hexdigest()});self.assertEqual(value['reason_codes'],[]);self.assertIsNone(value['reason_source'])

class RadixSubmitTextControls(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name).resolve();self.repo=self.root/'repo';self.sources={}
        for name in api.RADIX_SUBMIT_SOURCE_SHA:
            path=self.repo/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes((HERE.parents[1]/name).read_bytes())
            if name!=api.RADIX_SUBMIT_LOCK:self.sources[name]=api.pin(path)
        self.lock=api.pin(self.repo/api.RADIX_SUBMIT_LOCK);self.log=self.root/'harness.log'
    def quote(self,text):return json.dumps(text,ensure_ascii=False)
    def header(self,site='utils/run-locally/src/radix/cli.rs:143:14'):return("thread 'PRIVATE_THREAD' (42) panicked at "+site+':\n').encode()
    def response(self,kind='InvalidTransactionError',status=400,details=None,entity=None):
        if details is None:details='Some('+kind+'(Object {"PRIVATE_TOKEN": String("PRIVATE_DATA")}))'
        if entity is None:entity='Some(Status4XX(ErrorResponse { code: Some(400), details: '+details+', message: '+self.quote('PRIVATE_MESSAGE https://PRIVATE_URL/?token=PRIVATE')+', trace_id: Some("PRIVATE_TRACE") }))'
        body='ResponseContent { status: '+str(status)+', content: '+self.quote('PRIVATE_CONTENT status: 599, entity: Some(Status4XX(PRIVATE_SPOOF))')+', entity: '+entity+' }'
        return 'Other(ResponseError('+self.quote(body)+'))'
    def body(self,leaf):return('Failed to submit transaction: '+leaf+'\n').encode()
    def observe(self,wire,sources=None,lock=None):
        self.log.write_bytes(wire);return api.rust_panic_observation(self.log,self.sources if sources is None else sources,self.repo,radix_client_lock=self.lock if lock is None else lock)
    def test_direct_all8_details_status_and_private_data_never_published(self):
        for kind in api.RADIX_GATEWAY_ERRORS:
            value=self.observe(self.header()+self.body(self.response(kind)));row=value['Radix_submit_error_text'];self.assertEqual(row['collection_status'],'observed');self.assertEqual(row['envelope'],'DIRECT');self.assertEqual(row['leaf_count'],1);leaf=row['errors'][0];self.assertEqual(leaf['http_status_text'],400);self.assertEqual(leaf['gateway_error_type_text'],kind);self.assertEqual(leaf['entity_kind'],'STATUS4XX');self.assertEqual(leaf['details_shape'],'UNTYPED_JSON'if kind=='InvalidTransactionError'else'TYPED');self.assertNotIn('PRIVATE',json.dumps(row));self.assertTrue(row['text_only']);self.assertFalse(row['native_or_timing_or_cleanup_authority']);self.assertEqual(value['reason_codes'],[]);self.assertIsNone(value['reason_source'])
            for key in ['typed_IO_error_kind','role','pid','primary_signal']:self.assertIsNone(row[key])
    def test_real_fallback_envelope_mixed_leaf_variants_and_unknown(self):
        leaves=[self.response(),'Other(ReqwestError(reqwest::Error { kind: Request, source: Some("PRIVATE") }))','Other(Serde(Error("PRIVATE", line: 1, column: 2)))','Other(Io(Custom { kind: Other, error: "PRIVATE" }))','Other(StringError("PRIVATE"))']
        value=self.observe(self.header()+self.body('RpcClientError(FallbackProvidersFailed(['+', '.join(leaves)+']))'))['Radix_submit_error_text'];self.assertEqual(value['collection_status'],'observed');self.assertEqual(value['envelope'],'FALLBACK_PROVIDERS_FAILED');self.assertEqual([x['variant']for x in value['errors']],['ResponseError','ReqwestError','Serde','Io','UNKNOWN']);self.assertNotIn('PRIVATE',json.dumps(value))
    def test_entity_none_unknownvalue_and_details_absent_or_foreign_are_closed(self):
        for entity,expected in [('None','NONE'),('Some(UnknownValue(Object {"PRIVATE": String("InvalidRequestError")}))','UNKNOWN_VALUE')]:
            value=self.observe(self.header()+self.body(self.response(entity=entity)))['Radix_submit_error_text']['errors'][0];self.assertEqual(value['entity_kind'],expected);self.assertIsNone(value['gateway_error_type_text'])
        for details in ['None','Some(PRIVATE_FOREIGN(String("InternalServerError")))']:
            row=self.observe(self.header()+self.body(self.response(details=details)))['Radix_submit_error_text']['errors'][0];self.assertIsNone(row['gateway_error_type_text']);self.assertNotIn('PRIVATE',json.dumps(row))
    def test_source_lock_absent_changed_and_honestly_rebound_poison_refuse(self):
        wire=self.header()+self.body(self.response())
        for name in self.sources:
            sources={k:v for k,v in self.sources.items()if k!=name};self.assertEqual(self.observe(wire,sources)['Radix_submit_error_text']['reason'],'SOURCE_CONTEXT_UNAVAILABLE')
            p=self.repo/name;old=p.read_bytes();p.write_bytes(old+b'\n');sources={**self.sources,name:api.pin(p)};self.assertEqual(self.observe(wire,sources)['Radix_submit_error_text']['reason'],'SOURCE_CONTEXT_UNAVAILABLE');p.write_bytes(old)
        p=self.repo/api.RADIX_SUBMIT_LOCK;old=p.read_bytes();p.write_bytes(old+b'\n');self.assertEqual(self.observe(wire,lock=api.pin(p))['Radix_submit_error_text']['reason'],'SOURCE_CONTEXT_UNAVAILABLE');p.write_bytes(old)
        self.assertEqual(self.observe(wire,lock={**self.lock,'sha256':'f'*64})['Radix_submit_error_text']['reason'],'SOURCE_CONTEXT_UNAVAILABLE')
    def test_first_canonical_boundary_oversize_ANSI_and_wrong_path_never_borrow(self):
        good=self.header()+self.body(self.response())
        for site in ['utils/run-locally/src/main.rs:825:48','utils/run-locally/src/radix/cli.rs:143:15','/outside/../utils/run-locally/src/radix/cli.rs:143:14','/outside//utils/run-locally/src/radix/cli.rs:143:14','/outside\\utils/run-locally/src/radix/cli.rs:143:14']:
            row=self.observe(self.header(site)+good)['Radix_submit_error_text'];self.assertEqual(row['collection_status'],'unavailable');self.assertEqual(row['reason'],'FIRST_PANIC_SITE_UNKNOWN')
        for first in [("thread '"+'x'*129+"' panicked at utils/run-locally/src/main.rs:1:1:\n").encode(),b"thread '' panicked at utils/run-locally/src/main.rs:1:1:\n"]:
            self.assertEqual(self.observe(first+good)['Radix_submit_error_text']['reason'],'FIRST_PANIC_SITE_UNKNOWN')
        for first in [b'x'*65537+b'\n',b'\x1b[31m'+self.header('utils/run-locally/src/main.rs:1:1').rstrip()+b'x'*65537+b'\n']:
            self.assertEqual(self.observe(first+good)['Radix_submit_error_text']['reason'],'LOG_LINE_BOUND')
        self.assertEqual(self.observe(self.header()+self.header()+self.body(self.response()))['Radix_submit_error_text']['reason'],'EXPECT_BODY_UNAVAILABLE')
        row=self.observe(b'\x1b[31m'+self.header()+b'\x1b[0m'+self.body(self.response()))['Radix_submit_error_text'];self.assertEqual(row['collection_status'],'observed')
    def test_structural_spoof_duplicates_status_bounds_and_bad_escapes_fail_closed(self):
        for status in [399,600,-1,True]:
            row=self.observe(self.header()+self.body(self.response(status=status)))['Radix_submit_error_text'];self.assertEqual(row['collection_status'],'unavailable');self.assertEqual(row['reason'],'DEBUG_GRAMMAR_UNAVAILABLE')
        inner='ResponseContent { status: 400, content: "PRIVATE", entity: None, status: 599 }'
        for leaf in ['Other(ResponseError('+self.quote(inner)+'))','Other(ResponseError("PRIVATE\\q"))','Other(ResponseError("PRIVATE\\u{d800}"))']:
            self.assertEqual(self.observe(self.header()+self.body(leaf))['Radix_submit_error_text']['collection_status'],'unavailable')
        entity='Some(UnknownValue(Object {"details": String("Some(InternalServerError(PRIVATE))")}))'
        row=self.observe(self.header()+self.body(self.response(entity=entity)))['Radix_submit_error_text']['errors'][0];self.assertEqual(row['entity_kind'],'UNKNOWN_VALUE');self.assertIsNone(row['gateway_error_type_text'])
    def test_fixed_vector_depth_and_harness_single_capture(self):
        leaf=self.response()
        for count in [0,9]:
            row=self.observe(self.header()+self.body('RpcClientError(FallbackProvidersFailed(['+', '.join([leaf]*count)+']))'))['Radix_submit_error_text'];self.assertEqual(row['reason'],'LEAF_BOUND')
        row=self.observe(self.header()+self.body('RpcClientError(FallbackProvidersFailed(['+', '.join([leaf]*8)+']))'))['Radix_submit_error_text'];self.assertEqual(row['leaf_count'],8)
        deep='Other(ReqwestError('+('Some('*33)+'"PRIVATE"'+(')'*33)+'))';self.assertEqual(self.observe(self.header()+self.body(deep))['Radix_submit_error_text']['collection_status'],'unavailable')
        opened=[];original=api.os.open
        def tracked(path,*args,**kwargs):
            if Path(path)==self.log:opened.append(path)
            return original(path,*args,**kwargs)
        with mock.patch.object(api.os,'open',side_effect=tracked):self.observe(self.header()+self.body(leaf))
        self.assertEqual(len(opened),1)
    def test_Rust_string_supported_escapes_and_optional_nonRadix_context(self):
        self.assertEqual(api.radix_debug_string('"a\\n\\r\\t\\0\\\\\\\"\\x41\\u{1f600}"'),'a\n\r\t\0\\"A😀')
        self.log.write_bytes(self.header()+self.body(self.response()));value=api.rust_panic_observation(self.log,self.sources,self.repo);self.assertNotIn('Radix_submit_error_text',value);self.assertEqual(value['reason_codes'],[])


class SvmPrivateWindowControls(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.repo=Path(self.temp.name);self.sources={}
        bodies={'program.rs':b'let mut reader = BufReader::new(output).lines();\nprintln!("<{prefix}> {line}");','sealevel/solana.rs':b'args.spawn("SOL", None)','sealevel/mod.rs':b'.zip(["SCR1", "SCR2", "SCR3"])\nscraper_env.spawn(scraper_name, None)'}
        for suffix,body in bodies.items():
            name='rust/main/utils/run-locally/src/'+suffix;path=self.repo/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(body);self.sources[name]=api.pin(path)
    def select(self,raw,scenario='sealevel'):return api.svm_private_windows(raw,self.sources,self.repo,scenario)
    def test_fixed_physical_tags_deduplicated_overlap_and_private_bytes(self):
        raw=b'<SOL> \x1b[31mPRIVATE\xff\x00\n<SCR1> private-key-text\n';plain,meta=self.select(raw)
        self.assertEqual(plain,raw);self.assertEqual([r['bytes']for r in meta['windows']],[len(raw.splitlines(True)[0]),0,len(raw.splitlines(True)[1]),0]);self.assertNotIn('PRIVATE',json.dumps(meta));self.assertNotIn('sha256',json.dumps(meta))
        plain,meta=self.select(raw,'sealevel-composite');self.assertEqual(plain,raw.splitlines(True)[0]);self.assertEqual([r['bytes']for r in meta['windows']][2:],[0,0])
    def test_global_window_bound_43_not44_and_exact_tail(self):
        sol=b''.join(b'<SOL> '+bytes([65+i%26])*80+b'\n'for i in range(200));scr=sol.replace(b'<SOL>',b'<SCR1>')
        plain,meta=self.select(sol+scr);self.assertEqual(len(plain),16384);self.assertEqual((len(plain)+383)//384,43);self.assertEqual([r['bytes']for r in meta['windows']],[4096]*4);self.assertEqual(plain,sol[:4096]+sol[-4096:]+scr[:4096]+scr[-4096:])
    def test_lookalikes_oversize_source_poison_and_absolute_check(self):
        raw=b'<SCR> foreign\n<SCR4> foreign\n<SCR1-extra> foreign\n<RLY> <SCR2> foreign\n <SOL> foreign\n\x1b[31m<SOL> foreign\n<RLY> <SOL> foreign\n<SOLX> foreign\n<SOL> '+b'x'*65536+b'\n'
        plain,meta=self.select(raw);self.assertEqual(plain,b'');self.assertEqual(meta['oversized_lines_omitted'],1)
        next(iter(self.sources.values()))['sha256']='f'*64
        with self.assertRaises(ValueError):self.select(b'<SOL> PRIVATE\n')
        calls=[]
        def expired():calls.append(1);raise TimeoutError('PRIVATE')
        with self.assertRaises(TimeoutError):api.svm_private_windows(b'<SOL> x\n',self.sources,self.repo,'sealevel',expired)
        self.assertEqual(len(calls),1)
    def test_strict_cipher_protocol_rejects_unknown_plaintext_and_count(self):
        block=base64.b64encode(b'x'*512).decode();good={'schema':1,'key_id':api.SVM_ENCRYPTION_KEY_ID,'blocks':[block]*43,'limits':None};wire=json.dumps(good).encode();self.assertEqual(api.svm_encrypted_blocks(wire,16384),good)
        for bad in [{**good,'plaintext':'PRIVATE'},{**good,'blocks':[block]*44},{**good,'key_id':'f'*64},{**good,'schema':True},{**good,'blocks':['PRIVATE']*43}]:
            with self.assertRaises((ValueError,TypeError)):api.svm_encrypted_blocks(json.dumps(bad).encode(),16384)
        with self.assertRaises(ValueError):api.svm_encrypted_blocks(b'{"schema":1,"schema":1}',1)
    def test_actual_role_capture_callback_reuses_same_harness_read(self):
        fixture=RoleFailureProjectionControls('test_actual_signal_parent_receipt_join_and_finite_panic_flags_never_publish_private_fields')
        fixture.setUp();self.addCleanup(fixture.doCleanups);seen=[];original=api.captured_failure_bytes;reads=[]
        def read(path,maximum):
            if Path(path)==fixture.log:reads.append(maximum)
            return original(path,maximum)
        with mock.patch.object(api,'captured_failure_bytes',side_effect=read):value=api.role_failure_observation(fixture.case,fixture.manifest,42,fixture.sources,fixture.repo,fixture.log,fixture.zig_sources,private_capture=seen.append)
        self.assertEqual(reads,[32*1024**2]);self.assertEqual(seen,[fixture.log.read_bytes()]);self.assertNotIn('DO-NOT-EXPORT',json.dumps(value))
        def broken(raw):raise ValueError('PRIVATE')
        again=api.role_failure_observation(fixture.case,fixture.manifest,42,fixture.sources,fixture.repo,fixture.log,fixture.zig_sources,private_capture=broken);self.assertEqual(value,again)




    def test_all_three_scraper_prefixes_share_one_fixed_window_pair(self):
        scr=b'<SCR1> first\n<SCR2> second\n<SCR3> third\n'
        plain,meta=self.select(scr)
        self.assertEqual(plain,scr)
        self.assertEqual(meta['windows'],[{'tag':'SOL','position':'first','bytes':0},{'tag':'SOL','position':'tail','bytes':0},{'tag':'SCR','position':'first','bytes':len(scr)},{'tag':'SCR','position':'tail','bytes':0}])
        self.assertNotIn('SCR1',json.dumps(meta));self.assertNotIn('second',json.dumps(meta))
        long=b''.join((b'<SCR1> ',b'<SCR2> ',b'<SCR3> ')[i%3]+bytes([65+i%26])*80+b'\n'for i in range(300))
        plain,meta=self.select(long)
        self.assertEqual(plain,long[:4096]+long[-4096:]);self.assertEqual([r['bytes']for r in meta['windows']],[0,0,4096,4096])
        plain,meta=self.select(scr,'sealevel-composite');self.assertEqual(plain,b'');self.assertTrue(all(r['bytes']==0 for r in meta['windows']))

    def test_rehashed_legacy_or_changed_scraper_source_refuses(self):
        name='rust/main/utils/run-locally/src/sealevel/mod.rs';target=self.repo/name
        for body in [b'scraper_env.spawn("SCR", None)',b'.zip(["SCR1", "SCR2", "SCR4"])\nscraper_env.spawn(scraper_name, None)',target.read_bytes()+b'\n.zip(["SCR1", "SCR2", "SCR3"])']:
            target.write_bytes(body);self.sources[name]=api.pin(target)
            with self.assertRaisesRegex(ValueError,'SVM prefix Source'):self.select(b'<SCR1> PRIVATE\n')


def radix_test_admission(root,repo,modules,manifest,approval=None):
    """Synthetic closure only; no Git/native acceptance or persisted real pins."""
    approval={}if approval is None else approval
    epoch=manifest['runtime_source_commit'];execution='b'*40
    log=root/'compiled-source-check.json';log.write_text('{}\n')
    paths={'runtime':('zig/src','zig/native','zig/build.zig','zig/build.zig.zon'),'helper':('rust/main','rust/sealevel'),'tools':('rust/main','rust/sealevel','zig/reference')}
    scopes={category:[{'path':path,'producer_tree':None if path=='zig/build.zig.zon'else'3'*40,'current_tree':None if path=='zig/build.zig.zon'else'3'*40,'worktree_unchanged':True}for path in rows]for category,rows in paths.items()}
    closure={'schema':1,'runtime_source_commit':epoch,'helper_source_commit':epoch,'tools_source_commit':epoch,'execution_source_commit':execution,'source_unchanged':True,'native_case_acceptance':False,'scopes':scopes,'checks':[{'exit_code':0,'log':api.pin(log)}]}
    closure_path=root/'compiled-input-closure.json';closure_path.write_text(json.dumps(closure))
    approval.update(root_approved=True,scenario='radix',runtime_source_commit=epoch,execution_source_commit=execution,python_modules=modules,compiled_input_closure=api.pin(closure_path),diagnostic_radix_scraper_sources={name:{'path':str(repo/name),'bytes':size,'sha256':digest}for name,size,digest in api.RADIX_SCRAPER_SOURCE})
    path=root/'approval.json';path.write_text(json.dumps(approval));manifest['execution_approval']=api.pin(path)
    return approval

class RadixScraperCutoverControls(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name).resolve()
    def state(self):
        import shutil
        repo=Path(__file__).resolve().parents[2]
        for name,_,_ in api.RADIX_SCRAPER_SOURCE:
            target=self.root/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(repo/name,target)
        self.modules={name:api.pin(HERE/name)for name in ['multivm_session.py','multivm_evidence.py']}
        self.manifest={'scenario':'radix','runtime_source_commit':'1'*40};self.approval=radix_test_admission(self.root,self.root,self.modules,self.manifest)
        return api.RadixScraper(self.root,self.manifest,self.modules)
    def test_successor_requires_exact_admitted_runtime_helper_closure_and_all14_sources(self):
        state=self.state();self.assertEqual(state.epoch,'1'*40);self.assertEqual(state.public(None)['Source_epoch'],'1'*40)
        valid=copy.deepcopy(self.approval);path=self.root/'approval.json'
        mutations=[lambda a:a.pop('compiled_input_closure'),lambda a:a.update(root_approved=False),lambda a:a.update(scenario='evm'),lambda a:a.update(runtime_source_commit='4'*40),lambda a:a.update(python_modules={}),lambda a:a.pop('diagnostic_radix_scraper_sources'),lambda a:a['diagnostic_radix_scraper_sources'].pop('rust/main/utils/run-locally/src/external_agents.rs'),lambda a:a['diagnostic_radix_scraper_sources']['zig/src/radix/provider.zig'].update(sha256='0'*64)]
        for mutate in mutations:
            modified=copy.deepcopy(valid);mutate(modified);path.write_text(json.dumps(modified));self.manifest['execution_approval']=api.pin(path)
            with self.subTest(mutation=repr(mutate)),self.assertRaises(ValueError):api.RadixScraper(self.root,self.manifest,self.modules)
        closure_path=Path(valid['compiled_input_closure']['path']);original=json.loads(closure_path.read_text())
        mutations=[lambda c:c.update(helper_source_commit='4'*40),lambda c:c.update(runtime_source_commit='4'*40),lambda c:c.update(tools_source_commit='4'*40),lambda c:c['scopes']['helper'][0].update(current_tree='4'*40),lambda c:c['scopes']['runtime'][0].update(worktree_unchanged=False),lambda c:c['scopes'].pop('tools'),lambda c:c.update(checks=[]),lambda c:c['checks'][0].update(exit_code=1)]
        for mutate in mutations:
            modified=copy.deepcopy(original);mutate(modified);closure_path.write_text(json.dumps(modified));approval=copy.deepcopy(valid);approval['compiled_input_closure']=api.pin(closure_path);path.write_text(json.dumps(approval));self.manifest['execution_approval']=api.pin(path)
            with self.subTest(mutation=repr(mutate)),self.assertRaises(ValueError):api.RadixScraper(self.root,self.manifest,self.modules)
    def test_admission_identity_is_rechecked_and_historical_epoch_never_bypasses(self):
        state=self.state();path=self.root/'approval.json';wire=path.read_bytes();path.write_bytes(wire+b' ')
        with self.assertRaises(ValueError):state.public(None)
        for epoch in ['f453948ae31c1fadb35e10c87577e73a39350103','1'*40]:
            with self.assertRaises(ValueError):api.RadixScraper(self.root,{'scenario':'radix','runtime_source_commit':epoch},self.modules)
    def sample(self,chain='a',value='0'):
        return ('hyperlane_critical_error{chain="'+chain+'",agent="scraper",hyperlane_baselib_version="3.0.0"} '+value+'\n').encode()
    def test_absence_zero_nonzero_and_exact_Rust_count_operands_are_separate(self):
        project=lambda raw:api.radix_scraper_metrics(raw,('a','b'))
        absent=project(b'# HELP hyperlane_critical_error private\n');self.assertFalse(absent['family_present']);self.assertEqual(absent['series_count'],0)
        one=project(self.sample());self.assertTrue(one['family_present']);self.assertEqual(one['chains'][0]['finite_values'],[0]);self.assertFalse(one['chains'][1]['selected_present']);self.assertFalse(one['exact_cutover_operands_observed'])
        ready=project(self.sample()+self.sample('b'));self.assertTrue(ready['exact_cutover_operands_observed']);self.assertFalse(ready['native_or_readiness_credit'])
        failed=project(self.sample()+self.sample('b','1'));self.assertEqual(failed['chains'][1]['finite_values'],[1]);self.assertFalse(failed['exact_cutover_operands_observed'])
        self.assertNotIn('"a"',json.dumps(ready));self.assertNotIn('"b"',json.dumps(ready))
    def test_malformed_nonfinite_duplicate_private_foreign_and_oversize_are_not_public(self):
        variants=[self.sample(value=x)for x in ['NaN','Inf','-1','2','0.0','1e0','PRIVATE_KEY']]+[self.sample()+self.sample(),self.sample('PRIVATE_CHAIN'),self.sample().replace(b'agent="scraper"',b'agent="relayer"'),self.sample().replace(b'chain="a"',b'chain="a",chain="b"'),b'hyperlane_critical_error_private 0\n',b'x'*(1024**2+1),b'hyperlane_critical_error{'+b'x'*16385+b'} 0\n',b'\xff']
        for raw in variants:
            with self.subTest(size=len(raw)),self.assertRaises(ValueError):api.radix_scraper_metrics(raw,('a','b'))
    def test_actual_Source_arms_headers_and_rejects_poison_or_identity_change(self):
        state=self.state();self.assertEqual(len(state.sources),14)
        raw=(b'<SCR> \x1b[33mwarning: scraper chain=PRIVATE_CHAIN lane=head failed=WrongRadixNetwork\x1b[0m\n<SCR> warning: task 7 failed: PRIVATE_TOKEN\n<SCR> error: agent stopped: WrongRadixNetwork\n<SCR> warning: critical metric update failed: WrongRadixNetwork\n')
        value=state.headers(raw);self.assertEqual(value['counts'],{'lane_failure':1,'supervised_task_failed':1,'agent_stopped':1,'critical_metric_warning':1});self.assertEqual(value['observations'][0]['Source_error_name'],'WrongRadixNetwork');self.assertEqual(value['observations'][0]['Source_lane_name'],'head');self.assertIsNone(value['observations'][1]['Source_error_name']);self.assertIsNone(value['observations'][1]['PID_or_chain_attribution']);self.assertNotIn('PRIVATE',json.dumps(value))
        sources=dict(state.sources);sources['zig/src/agents/scraper/task.zig']=sources['zig/src/agents/scraper/task.zig'].replace(b'scraper chain=',b'other chain=')
        with self.assertRaises(ValueError):api.radix_scraper_headers(raw,sources)
        path=self.root/'zig/src/agents/scraper/task.zig';path.write_bytes(path.read_bytes()+b'\n')
        with self.assertRaises(ValueError):state.headers(raw)
        with self.assertRaises(ValueError):api.RadixScraper(self.root,{'scenario':'radix','runtime_source_commit':'1'*40},self.modules)
    def test_wrong_epoch_unknown_headers_linebounds_and_foreign_prefix_refuse(self):
        state=self.state()
        with self.assertRaises(ValueError):api.RadixScraper(self.root,{'scenario':'radix','runtime_source_commit':'a'*40},self.modules)
        raw=b'\x1b[33m<SCR> warning: scraper chain=a lane=head failed=WrongRadixNetwork\n <SCR> warning: scraper chain=a lane=head failed=WrongRadixNetwork\n<RLY> warning: scraper chain=a lane=head failed=WrongRadixNetwork\n<SCR> warning: scraper chain=a lane=PRIVATE failed=WrongRadixNetwork\n'+b'<SCR> warning: scraper chain='+b'x'*17000+b' lane=head failed=WrongRadixNetwork\n'
        value=state.headers(raw);self.assertTrue(all(v==0 for v in value['counts'].values()));self.assertEqual(value['observations'],[])
    def test_first_latest_bounded_rows_and_same_single_harness_capture(self):
        state=self.state();state.project(self.sample(),('a','b'),1,10);state.project(self.sample()+self.sample('b'),('a','b'),11,20)
        self.assertEqual(state.first['operands']['series_count'],1);self.assertEqual(state.last['operands']['series_count'],2)
        with self.assertRaises(ValueError):state.project(self.sample(),('a','b'),1,500000002)
        log=self.root/'harness.log';log.write_bytes(b'<SCR> warning: scraper chain=a lane=head failed=WrongRadixNetwork\n');reads=[];original=api.os.open
        def opened(path,*args,**kwargs):
            if Path(path)==log:reads.append(path)
            return original(path,*args,**kwargs)
        with mock.patch.object(api.os,'open',side_effect=opened):value=api.rust_panic_observation(log,{},self.root,radix_scraper=state)
        self.assertEqual(len(reads),1);self.assertEqual(value['Radix_scraper_headers']['counts']['lane_failure'],1)
    def selected(self,rows=None,live=None):
        product={'path':'/owned/scraper','bytes':1,'sha256':'a'*64};manifest={'scenario':'radix','runtime_source_commit':'1'*40,'artifacts':{'scraper':product}}
        capture={'original':{'role':'scraper','role_chain_names':['a','b'],'runtime_source_commit':'1'*40,'scenario':'radix','harness_pid':42,'metrics_port':9093,'chains':{'a':{'protocol':'radix'},'b':{'protocol':'radix'}}}}
        child={'role':'scraper','pid':43,'parent_pid':42,'os_start_token':'43 42 Wed Nov 9 00:00:00 2026 scraper','executable':product}
        records={'effective-role-configs.jsonl':[capture],'owned-children.jsonl':[child]}
        if rows is not None:rows(records)
        def read(path,maximum):return b'\n'.join(json.dumps(x).encode()for x in records[Path(path).name]),{}
        row={'pid':43,'ppid':42,'start':'linux-ticks:10','state':'S'}if live is None else live
        return api.radix_selected_scraper(self.root,manifest,{'chain_names':['a','b']},42,read,lambda pid:row,lambda pid:'/owned/scraper',lambda:None)
    def test_actual_capture_selection_never_equates_PS_token_with_linux_ticks(self):
        row,chains,port=self.selected();self.assertEqual((row['pid'],chains,port),(43,('a','b'),9093))
        variants=[lambda r:r['effective-role-configs.jsonl'][0]['original'].__setitem__('metrics_port',9092),lambda r:r['effective-role-configs.jsonl'][0]['original']['chains']['a'].__setitem__('protocol','ethereum'),lambda r:r['owned-children.jsonl'].append(copy.deepcopy(r['owned-children.jsonl'][0])),lambda r:r['owned-children.jsonl'][0].__setitem__('parent_pid',999),lambda r:r['effective-role-configs.jsonl'][0]['original'].__setitem__('role_chain_names',['a'])]
        for mutate in variants:
            with self.assertRaises(ValueError):self.selected(mutate)
        with self.assertRaises(ValueError):self.selected(live={'pid':43,'ppid':42,'start':'linux-ticks:10','state':'Z'})



class RadixRpcJournalControls(unittest.TestCase):
    def setUp(self):
        import shutil
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name).resolve();self.repo=self.root/'repo';self.case=self.root/'case';(self.case/'evidence').mkdir(parents=True);actual=Path(__file__).resolve().parents[2]
        for name,_,_ in api.RADIX_SCRAPER_SOURCE:
            target=self.repo/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(actual/name,target)
        self.modules={}
        for name in ['multivm_session.py','multivm_evidence.py']:
            target=self.repo/'zig/integration'/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(actual/'zig/integration'/name,target);self.modules[name]=api.pin(target)
        lock=self.repo/api.RADIX_SUBMIT_LOCK;lock.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(actual/api.RADIX_SUBMIT_LOCK,lock)
        self.inputs={'chain_names':['a','b']};self.inputpath=self.case/'case-inputs.json';self.inputpath.write_text(json.dumps(self.inputs));self.approvalpath=self.case/'approval.json';self.manifestpath=self.case/'manifest.json'
        self.approval={'root_approved':True,'scenario':'radix','runtime_source_commit':'1'*40,'execution_source_commit':'b'*40,'python_modules':self.modules};self.manifest={'scenario':'radix','implementation':'zig','task_root':str(self.case),'runtime_source_commit':'1'*40,'case_inputs':api.pin(self.inputpath)};self.plan={'root_approved':True,'scenario':'radix','execution_source_commit':'b'*40,'diagnostic_radix_client_lock':api.pin(lock),'required_inputs':list(self.modules.values())+[api.pin(lock)]};radix_test_admission(self.case,self.repo,self.modules,self.manifest,self.approval);self.rebind()
        self.state=api.RadixScraper(self.repo,self.manifest,self.modules);self.capture={'original':{'role':'scraper','scenario':'radix','runtime_source_commit':'1'*40,'harness_pid':42,'metrics_port':9093,'role_chain_names':['a','b'],'chains':{name:{'protocol':'radix','rpcurls':'http://localhost:3333/core','gatewayurls':[{'http':'http://localhost:5308/'}]}for name in ['a','b']}}};self.captures=self.case/'evidence/effective-role-configs.jsonl';self.captures.write_text(json.dumps(self.capture)+'\n');self.journal=self.case/'evidence/native-rpc-observations.jsonl';self.write([])
    def rebind(self):
        self.approvalpath.write_text(json.dumps(self.approval));self.manifest['execution_approval']=api.pin(self.approvalpath);self.manifestpath.write_text(json.dumps(self.manifest));self.plan['manifestArtifact']=api.pin(self.manifestpath)
    def row(self,route='CORE_CALL_PREVIEW',status=200,request=None,response=None):
        core=route.startswith('CORE');paths={'CORE_CALL_PREVIEW':'/core/transaction/call-preview','CORE_NETWORK_STATUS':'/core/status/network-status','GATEWAY_STATUS':'/status/gateway-status','GATEWAY_STREAM':'/stream/transactions'}
        return {'chain':'a','role':'scraper','endpoint_field':'rpcurls'if core else'gatewayurls','upstream':'http://localhost:3333/core'if core else'http://localhost:5308/','status':status,'requested_monotonic_ns':10,'received_monotonic_ns':20,'request_wire_sha256':'a'*64,'response_wire_sha256':'c'*64,'path':paths[route],'request':{}if request is None else request,'response':{}if response is None else response}
    def write(self,rows):self.journal.write_bytes(b''.join(json.dumps(r).encode()+b'\n'for r in rows))
    def observe(self,clock=lambda:1,end=1000):return api.radix_rpc_failure_observation(self.case,self.manifest,self.approval,self.plan,self.inputs,42,self.state,end,clock)
    def test_actual_writer_context_routes_status_Source_method_and_SV_first_latest_error(self):
        request={'target':{'type':'Method','method_name':'nonce','component_address':'PRIVATE_ADDRESS'},'at_ledger_state':{'type':'ByStateVersion','state_version':200}}
        rows=[self.row(response={'at_ledger_state':{'state_version':210}},request=request),self.row(status=400,response={'error_type':'Basic','message':'PRIVATE_CORE_ERROR'},request=request),self.row(response={'at_ledger_state':{'state_version':211}}),self.row('GATEWAY_STREAM',400,{'at_ledger_state':{'state_version':211}},{'details':{'type':'InvalidRequestError'},'message':'PRIVATE_URL_TOKEN'}),self.row('CORE_NETWORK_STATUS',200,response={'current_state_identifier':{'state_version':212}}),self.row('GATEWAY_STATUS',200,response={'ledger_state':{'state_version':190}})]
        self.write(rows);value=self.observe();core=value['routes']['CORE_CALL_PREVIEW'];self.assertEqual((core['matched_count'],core['error_count']),(3,1));self.assertEqual(core['first']['requested_state_version'],200);self.assertEqual(core['first']['returned_state_version'],210);self.assertEqual(core['latest']['returned_state_version'],211);self.assertEqual(core['latest_error']['HTTP_status'],400);self.assertEqual(core['latest_error']['official_error_type'],'Basic');self.assertEqual(core['first']['Source_counter_method'],'nonce');self.assertIsNone(core['first']['observed_method']);self.assertEqual(core['first']['Source_method'],'POST');self.assertEqual(value['routes']['GATEWAY_STREAM']['latest_error']['official_error_type'],'InvalidRequestError');self.assertEqual(value['routes']['GATEWAY_STREAM']['latest_error']['requested_state_version'],211);self.assertEqual(value['routes']['GATEWAY_STATUS']['first']['returned_state_version'],190)
        public=json.dumps(value)
        for private in ['PRIVATE','localhost','component_address','chain','http://']:
            if private=='chain':self.assertNotIn('"chain"',public)
            else:self.assertNotIn(private,public)
        self.assertFalse(value['native_or_timing_or_cleanup_authority']);self.assertNotIn('a'*64,public);self.assertIn('Persisted append order',value['ordering_basis'])
    def test_unknown_errors_methods_numeric_shapes_and_unselected_paths_never_echo(self):
        rows=[self.row(status=500,request={'target':{'type':'Method','method_name':'PRIVATE_METHOD'},'at_ledger_state':{'type':'Other','state_version':3}},response={'error_type':'PRIVATE_SECRET','message':'PRIVATE_BODY'}),self.row('GATEWAY_STREAM',500,response={'details':{'type':['PRIVATE']},'message':'PRIVATE_MESSAGE'}),self.row('CORE_NETWORK_STATUS',response={'current_state_identifier':{'state_version':True}}),self.row('GATEWAY_STATUS',response={'ledger_state':{'state_version':2**64}})]
        extra=self.row();extra['path']='/core/PRIVATE_ROUTE';rows.append(extra);other=self.row();other['role']='relayer';rows.append(other);self.write(rows);value=self.observe();self.assertEqual(value['unselected_scraper_records'],1);self.assertEqual(value['records_scanned'],6);self.assertIsNone(value['routes']['CORE_CALL_PREVIEW']['first']['official_error_type']);self.assertIsNone(value['routes']['CORE_CALL_PREVIEW']['first']['Source_counter_method']);self.assertIsNone(value['routes']['CORE_CALL_PREVIEW']['first']['requested_state_version']);self.assertIsNone(value['routes']['CORE_NETWORK_STATUS']['first']['returned_state_version']);self.assertIsNone(value['routes']['GATEWAY_STATUS']['first']['returned_state_version']);self.assertNotIn('PRIVATE',json.dumps(value))
    def test_strict_case_manifest_approval_capture_and_endpoint_crossbinding_refuse(self):
        self.write([self.row()]);variants=[lambda:self.plan.__setitem__('root_approved',False),lambda:self.manifest.__setitem__('task_root',str(self.root)),lambda:self.approval.__setitem__('runtime_source_commit','d'*40)]
        for change in variants:
            before=(copy.deepcopy(self.plan),copy.deepcopy(self.manifest),copy.deepcopy(self.approval));change()
            with self.assertRaises(ValueError):self.observe()
            self.plan,self.manifest,self.approval=before
        original=copy.deepcopy(self.capture)
        for change in [lambda c:c['original'].__setitem__('harness_pid',99),lambda c:c['original'].__setitem__('role_chain_names',['a','a']),lambda c:c['original']['chains']['a'].__setitem__('rpcurls','http://PRIVATE:3333/core'),lambda c:c['original'].__setitem__('runtime_source_commit','d'*40)]:
            value=copy.deepcopy(original);change(value);self.captures.write_text(json.dumps(value)+'\n')
            with self.assertRaises(ValueError):self.observe()
        self.captures.write_text(json.dumps(original)+'\n');row=self.row();row['upstream']='http://localhost:5308/';self.write([row])
        with self.assertRaises(ValueError):self.observe()
    def test_changed_Source_lock_writer_and_duplicate_JSON_refuse(self):
        self.write([self.row()]);original=self.plan['diagnostic_radix_client_lock'];path=Path(original['path']);saved=path.read_bytes();path.write_bytes(saved+b'\n');self.plan['diagnostic_radix_client_lock']=api.pin(path);self.plan['required_inputs'][-1]=api.pin(path)
        with self.assertRaises(ValueError):self.observe()
        path.write_bytes(saved);self.plan['diagnostic_radix_client_lock']=original;self.plan['required_inputs'][-1]=original
        writer=Path(self.modules['multivm_session.py']['path']);writer.write_bytes(writer.read_bytes().replace(b'self.append("native-rpc-observations.jsonl", record)',b'self.append("other.jsonl", record)'));old=self.modules['multivm_session.py'];self.modules['multivm_session.py']=api.pin(writer);self.plan['required_inputs']=[self.modules['multivm_session.py']if v==old else v for v in self.plan['required_inputs']];self.rebind();self.state=api.RadixScraper(self.repo,self.manifest,self.modules)
        with self.assertRaises(ValueError):self.observe()
    def test_byte_line_record_depth_and_SYMLINK_bounds_no_debt_or_public_data(self):
        variants=[b'x'*(8*1024**2+1),b'x'*(1024**2+1),b'{}\n'*4097,b'{"role":"scraper","role":"validator"}\n']
        row=self.row();nested={};v=nested
        for _ in range(34):v['private']={};v=v['private']
        row['response']=nested;variants.append(json.dumps(row).encode())
        for raw in variants:
            self.journal.write_bytes(raw)
            with self.subTest(size=len(raw)),self.assertRaises(ValueError):self.observe()
        self.journal.unlink();target=self.root/'outside';target.write_bytes(b'');self.journal.symlink_to(target)
        with self.assertRaises(ValueError):self.observe()
    def test_deadline_refuses_IO_and_midread_closes_actual_owned_FD(self):
        with mock.patch.object(api.os,'open',side_effect=AssertionError('Expired must not open'))as opened:
            with self.assertRaises(TimeoutError):self.observe(clock=lambda:1000)
            opened.assert_not_called()
        self.write([self.row()]);clock=[1];actual_open=api.os.open;actual_read=api.os.read;actual_close=api.os.close;target=[];closed=[]
        def opened(path,*args):
            fd=actual_open(path,*args)
            if Path(path)==self.journal:target.append(fd)
            return fd
        def read(fd,*args):
            result=actual_read(fd,*args)
            if fd in target:clock[0]=1000
            return result
        def close(fd):closed.append(fd);return actual_close(fd)
        with mock.patch.object(api.os,'open',side_effect=opened),mock.patch.object(api.os,'read',side_effect=read),mock.patch.object(api.os,'close',side_effect=close),self.assertRaises(TimeoutError):self.observe(clock=lambda:clock[0])
        self.assertEqual(len(target),1);self.assertIn(target[0],closed)
    def test_actual_postcapture_change_or_publication_Source_change_cannot_escape(self):
        self.write([self.row()]);original=self.state.check_sources;calls=[]
        def check():
            calls.append(1)
            if len(calls)==2:self.journal.write_bytes(self.journal.read_bytes()+b'\n')
            return original()
        with mock.patch.object(self.state,'check_sources',side_effect=check),self.assertRaises(ValueError):self.observe()

class StarkAdminSamplingControls(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name).resolve();self.case=self.root/'case';self.evidence=self.case/'evidence';self.evidence.mkdir(parents=True)
        self.source=self.root/'multivm_session.py';self.original=(HERE/'multivm_session.py').read_bytes();self.source.write_bytes(self.original);self.modules={'multivm_session.py':api.pin(self.source)}
        self.inputs={'scenario':'starknet','chain_names':['starknettest23448593','starknettest23448594'],'domain_names':{'23448593':'starknettest23448593','23448594':'starknettest23448594'}};self.manifest={'scenario':'starknet'};self.journal=self.evidence/'admin-sampling-diagnostics.jsonl'
    def row(self,**changes):
        row={'chain':'starknettest23448593','domain':23448593,'port':9093,'attempt':1,'request_started_monotonic_ns':100,'whole_sample_deadline_ns':110,'response_received_monotonic_ns':105,'outcome':'success','operation_count':10};row.update(changes);return row
    def write(self,rows):self.journal.write_bytes(b''.join(json.dumps(row,separators=(',',':')).encode()+b'\n'for row in rows))
    def observe(self,observer=None):return api.starknet_admin_sampling_observation(self.case,self.manifest,self.modules,self.inputs,observer)
    def test_actual_Source_contract_terminal_rows_keep_late_numeric_evidence_no_private_values(self):
        timeout=self.row(outcome='transport_timeout',response_received_monotonic_ns=115);timeout.pop('operation_count')
        error=self.row(outcome='hard_error',error_type='PRIVATE_CUSTOM_ERROR');error.pop('operation_count')
        self.write([self.row(),timeout,error]);value=self.observe();self.assertEqual(value['collection_status'],'observed');self.assertEqual(value['complete_line_count'],3);self.assertEqual(value['rows'][1]['response_after_deadline_ns'],5);self.assertEqual(value['rows'][2]['error_type'],'OtherError');self.assertFalse(value['native_or_timing_or_cleanup_authority']);self.assertNotIn('PRIVATE',json.dumps(value));self.assertEqual(value['source_contract']['sha256'],api.pin(self.source)['sha256'])
    def test_tail_preserves_journal_order_and_declares_unparsed_prefix(self):
        self.write([self.row(request_started_monotonic_ns=i,response_received_monotonic_ns=i+1)for i in range(80)])
        value=self.observe();self.assertEqual(value['collection_status'],'observed');self.assertEqual(value['selected_tail_line_count'],48);self.assertEqual(value['prefix_lines_not_parsed'],32);self.assertEqual([r['journal_line']for r in value['rows']],list(range(33,81)));self.assertLessEqual(len(json.dumps(value,separators=(',',':')).encode()),24*1024)
    def test_earliest_sampler_exception_time_is_not_request_start_or_round_duration(self):
        self.write([self.row()]);state={'observed_monotonic_ns':1000,'restart_sample_count':0,'restart_failed':False,'restart_first_observed_ns':None,'restart_last_observed_ns':None,'role_activity':[],'observer_failure_count':0,'lifecycle_error_count':0};rec=api.Recorder(self.root/'observer.json',self.modules,self.root)
        token=rec.enter('sampler',state);state['observed_monotonic_ns']=1500;rec.finish(token,state,'exception',ValueError('PRIVATE'))
        token=rec.enter('sampler',state);state['observed_monotonic_ns']=2000;rec.finish(token,state,'exception',ValueError('PRIVATE'))
        value=self.observe(rec.value);self.assertEqual(value['sampler_exception_observed_monotonic_ns'],1500);self.assertIn('pre-request deadline failure can leave no row',value['scope']);self.assertNotIn('round_duration_ns',value);self.assertNotIn('PRIVATE',json.dumps(value))
    def test_unknown_schema_chain_domain_bool_counter_and_raw_fields_refuse_without_export(self):
        for changes in [{'chain':'PRIVATE_CHAIN'},{'domain':23448594},{'attempt':True},{'port':0},{'request_started_monotonic_ns':1.0},{'operation_count':-1},{'raw_url':'http://PRIVATE/'},{'outcome':'PRIVATE'}]:
            self.write([self.row(**changes)]);value=self.observe()
            with self.subTest(changes=changes):self.assertEqual(value['collection_status'],'unavailable');self.assertNotIn('PRIVATE',json.dumps(value))
        self.journal.write_bytes(b'{"chain":"PRIVATE","chain":"starknettest23448593"}\n');self.assertEqual(self.observe()['collection_status'],'unavailable')
    def test_absent_partial_oversize_symlink_hardlink_and_fifo_are_optional_unavailable(self):
        import os
        self.assertEqual(self.observe()['collection_status'],'unavailable');self.journal.write_bytes(json.dumps(self.row()).encode());self.assertEqual(self.observe()['collection_status'],'unavailable');self.journal.unlink()
        with self.journal.open('wb')as stream:stream.truncate(32*1024**2+1)
        self.assertEqual(self.observe()['collection_status'],'unavailable');self.journal.unlink();target=self.root/'target';target.write_bytes(json.dumps(self.row()).encode()+b'\n')
        self.journal.symlink_to(target);self.assertEqual(self.observe()['collection_status'],'unavailable');self.journal.unlink();os.link(target,self.journal);self.assertEqual(self.observe()['collection_status'],'unavailable');self.journal.unlink();os.mkfifo(self.journal);self.assertEqual(self.observe()['collection_status'],'unavailable')
    def test_Source_hash_policy_shape_or_return_after_latch_change_refuses(self):
        self.write([self.row()])
        for old,new in [(b'"maximum_GET_attempts_per_domain": 8',b'"maximum_GET_attempts_per_domain": 9'),(b'outcome="success"',b'outcome="PRIVATE"'),(b'return # A hard coverage/schema failure is latched; no later re-credit.',b'continue # Changed sampler no longer terminates.')]:
            changed=self.original.replace(old,new,1);self.assertNotEqual(changed,self.original);self.source.write_bytes(changed);self.modules['multivm_session.py']=api.pin(self.source)
            with self.subTest(old=old):self.assertEqual(self.observe()['collection_status'],'unavailable')
        self.source.write_bytes(self.original);self.modules['multivm_session.py']=api.pin(self.source);self.source.write_bytes(self.original+b'\n');self.assertEqual(self.observe()['collection_status'],'unavailable')



class RestartAdminFailureProjectionTests(unittest.TestCase):
    def session(self):
        return SimpleNamespace(manifest={'scenario':'evm'},lock=threading.RLock())
    def note(self,s,operation,**changes):
        values={'chain':'test2','domain':9913372,'ordinal':0,'nonce':5,'observation':{'request_started_monotonic_ns':100,'response_received_monotonic_ns':105},'deadline':200,'observed':110};values.update(changes)
        api.note_restart_admin_failure(s,operation,**values)
    def test_all_closed_native_Source_enum_tags_are_exact(self):
        import re
        source=(HERE.parent/'src/db/json.zig').read_text()
        block=source.split('pub const ReprepareReason = union(enum) {',1)[1].split('    pub fn jsonStringify',1)[0]
        tags=set(re.findall(r'^    ([A-Za-z][A-Za-z0-9]*)(?:: ApplicationReport)?,',block,re.M))
        self.assertEqual(tags,api.RESTART_ADMIN_RETRY_TAGS|{'ApplicationReport'})
        for kind,names in [('ConfirmReason',api.RESTART_ADMIN_CONFIRM_TAGS),('ApplicationReport',api.RESTART_ADMIN_REPORT_TAGS)]:
            values=source.split('pub const '+kind+' = enum {',1)[1].split('}',1)[0]
            self.assertEqual({v.strip()for v in values.split(',')if v.strip()},names)
        for reason in api.RESTART_ADMIN_RETRY_TAGS:self.assertEqual(api.restart_admin_status({'Retry':reason}),{'kind':'Retry','reason':reason,'application_report':None})
        for reason in api.RESTART_ADMIN_CONFIRM_TAGS:self.assertEqual(api.restart_admin_status({'Confirm':reason})['reason'],reason)
        for reason in api.RESTART_ADMIN_REPORT_TAGS:self.assertEqual(api.restart_admin_status({'Retry':{'ApplicationReport':reason}})['application_report'],reason)
    def test_unknown_raw_status_payload_never_copied(self):
        for value in ['PRIVATE_MESSAGE',{'Retry':'PRIVATE_URL'},{'Confirm':'PRIVATE_KEY'},{'Retry':{'ApplicationReport':'PRIVATE'}},{'Retry':'Manual','message':'PRIVATE'},{'Retry':['PRIVATE']},None,True]:
            projected=api.restart_admin_status(value);self.assertEqual(projected,{'kind':'unknown','reason':None,'application_report':None});self.assertNotIn('PRIVATE',json.dumps(projected))
    def test_exact_submitted_classes_and_first_failure_latched(self):
        for operation,expected in [({},'missing'),({'submitted':None},'null'),({'submitted':True},'true'),({'submitted':False},'false'),({'submitted':0},'wrong_type'),({'submitted':'PRIVATE'},'wrong_type')]:
            s=self.session();operation.update(status={'Retry':'AwaitingValidatorSignatures'});self.note(s,operation);row=s.diagnostic_restart_admin_failure;self.assertEqual(row['submitted_classification'],expected);self.assertEqual(row['status']['reason'],'AwaitingValidatorSignatures');first=copy.deepcopy(row)
            self.note(s,{'submitted':True,'status':{'Confirm':'SubmittedBySelf'}},observed=120);self.assertEqual(s.diagnostic_restart_admin_failure,first);self.assertNotIn('PRIVATE',json.dumps(first))
    def test_invalid_fixture_position_and_clocks_do_not_publish(self):
        for poison in [{'chain':'PRIVATE_URL'},{'domain':9913373},{'ordinal':256},{'ordinal':True},{'nonce':2**32},{'nonce':-1},{'observation':{'request_started_monotonic_ns':106,'response_received_monotonic_ns':105}},{'observed':104},{'deadline':False}]:
            s=self.session();self.note(s,{'submitted':False,'status':'PRIVATE'},**poison);self.assertFalse(hasattr(s,'diagnostic_restart_admin_failure'))
        s=self.session();s.manifest['scenario']='starknet';self.note(s,{'submitted':False,'status':'PRIVATE'});self.assertFalse(hasattr(s,'diagnostic_restart_admin_failure'))
    def test_existing_record_path_keeps_optional_closed_failure_bounded(self):
        s=self.session();before=api.snapshot(s,109);self.assertNotIn('restart_admin_failure',before)
        self.note(s,{'submitted':False,'status':{'Retry':'AwaitingValidatorSignatures'},'message':{'PRIVATE':'RAW'},'id':'PRIVATE_ID'})
        state=api.snapshot(s,111);row=state['restart_admin_failure'];self.assertEqual((row['chain'],row['domain'],row['corpus_ordinal'],row['corpus_nonce']),('test2',9913372,0,5));self.assertLessEqual(len(json.dumps(row)),1024)
        with tempfile.TemporaryDirectory()as tmp:
            root=Path(tmp).resolve();modules={n:api.pin(HERE/n)for n in ['multivm_session.py','multivm_diagnostics.py']};r=api.Recorder(root/'observer.json',modules,root);token=r.enter('restart_continuous',before);r.finish(token,state,'exception',ValueError('PRIVATE_ERROR'));value=json.loads((root/'observer.json').read_text());api.validate_record(value,modules);self.assertNotIn('PRIVATE',json.dumps(value));self.assertFalse(value['native_or_timing_credit']);self.assertLessEqual((root/'observer.json').stat().st_size,api.LIMIT)
        bad=copy.deepcopy(row);bad['status']['reason']='PRIVATE'
        with self.assertRaises(ValueError):api.checked_restart_admin_failure(bad)
        bad=copy.deepcopy(row);bad['status']['kind']=[]
        with self.assertRaises(ValueError):api.checked_restart_admin_failure(bad)
        bad=copy.deepcopy(value);bad['last_stage']['state']['observed_monotonic_ns']='PRIVATE'
        with self.assertRaises(ValueError):api.validate_record(bad,modules)




class SvmEventFailureProjectionTests(unittest.TestCase):
    def session(self, scenario='sealevel'):
        return SimpleNamespace(manifest={'scenario': scenario}, lock=threading.RLock())
    def counts(self):
        return {'signature_rows': 3, 'error_rows': 1, 'other_slot_rows': 1, 'canonical_transactions': 1, 'program_address_instructions': 0, 'matched_transactions': 0}
    def note(self, session, **change):
        values={'chain':'sealeveltest1','kind':'dispatch','slot':20,'counts':self.counts()};values.update(change)
        api.note_svm_event_failure(session, **values)
    def test_exact_roles_kinds_zero_and_multiple_first_row_copy(self):
        for chain in api.SVM_EVENT_CHAINS:
            for kind in ['dispatch','gas','delivery']:
                session=self.session();self.note(session,chain=chain,kind=kind)
                row=session.diagnostic_svm_event_failure
                self.assertEqual((row['chain'],row['kind'],row['reason']),(chain,kind,'missing'))
                counts={'signature_rows':2,'error_rows':0,'other_slot_rows':0,'canonical_transactions':2,'program_address_instructions':2,'matched_transactions':2}
                self.note(session,counts=counts);self.assertEqual(session.diagnostic_svm_event_failure,row)
                second=self.session();self.note(second,counts=counts);counts['signature_rows']=999
                self.assertEqual(second.diagnostic_svm_event_failure['reason'],'ambiguous')
                self.assertEqual(second.diagnostic_svm_event_failure['counts']['signature_rows'],2)
        empty=self.session();self.note(empty,counts={key:0 for key in api.SVM_EVENT_COUNTS});self.assertEqual(empty.diagnostic_svm_event_failure['counts']['signature_rows'],0)
    def test_exact_types_bounds_partitions_and_scenarios_quarantine(self):
        poisons=[{'chain':'PRIVATE-address'},{'kind':'PRIVATE-rpc'},{'slot':True},{'slot':-1},{'slot':2**64}]
        for key in api.SVM_EVENT_COUNTS:
            for value in [True,-1,2**32,'PRIVATE']:
                counts=self.counts();counts[key]=value;poisons.append({'counts':counts})
        for counts in [dict(self.counts(), signature_rows=4),dict(self.counts(), matched_transactions=1),dict(self.counts(), matched_transactions=2),dict(self.counts(), raw='PRIVATE')]:poisons.append({'counts':counts})
        for poison in poisons:
            session=self.session();self.note(session,**poison);self.assertFalse(hasattr(session,'diagnostic_svm_event_failure'))
        for scenario, chain in [('evm','sealeveltest1'),('sealevel-composite','sealeveltest3')]:
            session=self.session(scenario);self.note(session,chain=chain);self.assertFalse(hasattr(session,'diagnostic_svm_event_failure'))
    def test_snapshot_recorder_wire_closed_projection_and_old_success_state(self):
        session=self.session();before=api.snapshot(session,100)
        self.assertNotIn('svm_event_failure',before);self.note(session);state=api.snapshot(session,100)
        self.assertEqual({k:v for k,v in state.items()if k!='svm_event_failure'},before)
        with tempfile.TemporaryDirectory()as directory:
            recorder=api.Recorder(Path(directory)/'record.json',{},HERE)
            token=recorder.enter('before_restart',before);recorder.finish(token,state,'exception',ValueError('PRIVATE-id-address-signature-rpc'))
            value=json.loads(recorder.path.read_text());api.validate_record(value,{})
            wire=json.dumps(value);self.assertNotIn('PRIVATE',wire);self.assertLess(len(wire),8192)
            for poison in [{'raw':'PRIVATE'},{'reason':'other'},{'native_or_timing_credit':True}]:
                altered=copy.deepcopy(value)
                altered['last_stage']['state']['svm_event_failure'].update(poison)
                with self.assertRaises(ValueError):api.validate_record(altered,{})


class TronStopFailureProjectionTests(unittest.TestCase):
    def setUp(self):
        self.fixture=FixtureFailureDiscriminatorControls();self.fixture.setUp();self.addCleanup(self.fixture.doCleanups)
        self.f=self.fixture;self.f.log.write_bytes(b'');self.source=self.f.sources['rust/main/utils/run-locally/src/external_agents.rs'];self.producer=Path(self.source['path']).read_bytes()
        self.path=self.f.case/'evidence/fixture-container-stop-failures.jsonl'
    def row(self,**change):
        token='81 42 S PRIVATE_START TIME FIELDS /approved/docker PRIVATE-COMMAND'
        return {'pid':81,'role':'fixture-docker','executable':self.f.manifest['verifier_tools']['docker'],'parent_pid':42,'os_start_token':token,'parent_wait_completed':True,'already_exited':False,'forced_kill':False,'success':False,'exit_code':137,'signal':None,'purpose':'fixture_teardown','planned_exit':True,'planned_container_stop':{'cause':'owned_docker_stop','container_id':'a'*64,'kind':'tron','port':9090,'pre_stop_live_identity':token,'already_exited_scope':'before_owned_container_stop','completed_before_original_deadline':True,'exact_owned_CID_absent':True,'acceptance_failed_before_cleanup':False},**change}
    def save(self,rows):self.path.write_text(''.join(json.dumps(row)+'\n'for row in rows))
    def observe(self):return api.tron_stop_failure_observation(self.f.case,self.f.manifest,42,self.producer)
    def test_synthetic_child_code_signal_and_primary_flags_never_become_Docker_command_or_cause_claims(self):
        first=self.row();second=self.row(pid=82,exit_code=None,signal=9);second['os_start_token']=second['os_start_token'].replace('81 42','82 42');second['planned_container_stop'].update(pre_stop_live_identity=second['os_start_token'],container_id='b'*64,kind='postgres',port=5432,acceptance_failed_before_cleanup=True)
        self.save([first,second]);result=self.observe();self.assertEqual(result['collection_status'],'observed');self.assertEqual(result['complete_row_count'],2)
        rows=result['rows'];self.assertEqual(rows[0]['original_foreground_child_exit_code'],137);self.assertIsNone(rows[0]['original_foreground_child_signal']);self.assertEqual(rows[1]['fixture'],'POSTGRES');self.assertEqual(rows[1]['original_foreground_child_signal'],9)
        self.assertTrue(rows[1]['producer_primary_error_present_at_receipt']);self.assertFalse(result['native_or_timing_or_cleanup_authority'])
        self.assertIn('not separate Docker stop/inspect client',result['scope']);wire=json.dumps(result)
        for value in ['PRIVATE','/approved/docker','container_id','os_start_token','pre_stop_live_identity','parent_pid','"pid"','a'*64,'b'*64]:self.assertNotIn(value,wire)
    def test_first_eight_selection_validates_every_later_row_and_absence_is_honest(self):
        self.assertEqual(self.observe()['collection_status'],'absent');rows=[]
        for i in range(10):
            row=self.row(pid=81+i);row['os_start_token']=row['os_start_token'].replace('81 42',str(81+i)+' 42');row['planned_container_stop'].update(pre_stop_live_identity=row['os_start_token'],container_id=format(i+1,'064x'));rows.append(row)
        self.save(rows);result=self.observe();self.assertEqual((result['complete_row_count'],result['selected_first_row_count'],result['later_rows_not_projected']),(10,8,2));self.assertEqual([r['journal_line']for r in result['rows']],list(range(1,9)));self.assertLess(len(json.dumps(result)),8192)
        rows[-1]['exit_code']=True;self.save(rows);self.assertEqual(self.observe()['collection_status'],'unavailable')
    def test_exact_parent_tool_types_lifecycle_schema_and_internal_consistency_refuse(self):
        poisons=[{'parent_pid':43},{'parent_pid':True},{'pid':True},{'executable':{}},{'success':True},{'parent_wait_completed':False},{'planned_exit':False},{'role':'other'},{'purpose':'other'},{'exit_code':True},{'signal':9},{'exit_code':-1},{'exit_code':256},{'os_start_token':'PRIVATE'},{'raw':'PRIVATE'},{'exit_code':0}]
        for change in poisons:
            self.save([self.row(**change)]);self.assertEqual(self.observe()['collection_status'],'unavailable',change)
        for key,value in [('kind','PRIVATE'),('port',True),('port',9091),('container_id','PRIVATE'),('pre_stop_live_identity','PRIVATE'),('cause','other'),('completed_before_original_deadline',1),('exact_owned_CID_absent',None),('acceptance_failed_before_cleanup','PRIVATE')]:
            row=self.row();row['planned_container_stop'][key]=value;self.save([row]);self.assertEqual(self.observe()['collection_status'],'unavailable',(key,value))
        row=self.row();self.save([row,row]);self.assertEqual(self.observe()['collection_status'],'unavailable')
        row=self.row(exit_code=0);row['planned_container_stop']['acceptance_failed_before_cleanup']=True;self.save([row]);self.assertEqual(self.observe()['collection_status'],'observed')
    def test_source_and_bounded_regular_stable_input_guards_fail_closed(self):
        self.save([self.row()]);original=self.producer;self.producer=original.replace(b'"fixture-container-stop-failures.jsonl"',b'"OTHER-JOURNAL"')
        with mock.patch.object(api,'captured_failure_bytes',side_effect=AssertionError('must not read'))as read:self.assertEqual(self.observe()['collection_status'],'unavailable');read.assert_not_called()
        self.producer=original;self.path.unlink();self.path.symlink_to(self.f.log);self.assertEqual(self.observe()['collection_status'],'unavailable');self.path.unlink()
        with self.path.open('wb')as stream:stream.truncate(1024**2+1)
        with mock.patch.object(api.os,'open',side_effect=AssertionError('must refuse before open'))as opened:self.assertEqual(self.observe()['collection_status'],'unavailable');opened.assert_not_called()
        self.save([self.row()]);wire=self.path.read_bytes();self.path.write_bytes(wire[:-1]);self.assertEqual(self.observe()['collection_status'],'unavailable')
        self.path.write_bytes(b'{"pid":1,"pid":1}\n');self.assertEqual(self.observe()['collection_status'],'unavailable')
        self.save([self.row()]*65);self.assertEqual(self.observe()['collection_status'],'unavailable')
    def test_actual_failure_result_joins_admitted_source_and_optional_baseexception_preserves_old_result(self):
        self.save([self.row()]);result=self.f.observe();self.assertEqual(result['fixture_stop_failures']['collection_status'],'observed')
        with mock.patch.object(api,'tron_stop_failure_observation',side_effect=KeyboardInterrupt):quarantined=self.f.observe()
        self.assertEqual(quarantined['fixture_stop_failures']['collection_status'],'unavailable');self.assertEqual({k:v for k,v in result.items()if k!='fixture_stop_failures'},{k:v for k,v in quarantined.items()if k!='fixture_stop_failures'})
        self.f.manifest['scenario']='radix';result=self.f.observe();self.assertNotIn('fixture_stop_failures',result)


class CanonicalDeliveryMismatchControls(unittest.TestCase):
    MESSAGE = 'actual native delivered state differs from eligible corpus'
    ATTRIBUTE = '_canonical_delivery_mismatch'

    def setUp(self):
        self.modules={name:api.pin(HERE/name)for name in ['multivm_session.py','multivm_evidence.py','multivm_diagnostics.py']}

    def fixture(self,kind='normal',*,phase='after_source_reorg',scenario='evm',observed=None):
        domains={'test1':9913371,'test2':9913372,'test3':9913373}
        chains={name:{'name':name,'domainid':str(domain),'mailbox':'0x'+'1'*40}for name,domain in domains.items()}
        rows=[]
        for ordinal,label in enumerate(['normal','failedbody','zero','double','newrefused']):
            body=b'failMessageBody'if label=='failedbody'else b'PRIVATE_SENTINEL'
            rows.append({'id':'0x'+format(ordinal+1,'064x'),'wire':'0x'+'00'*77+body.hex(),'body':'0x'+body.hex(),'origin':domains['test1'],'origin_chain':'test1','destination':domains['test2'],'nonce':ordinal,'insertions':[]if label=='zero'else[0,1]if label=='double'else[0]})
        target=next(row for row in rows if row['nonce']==['normal','failedbody','zero','double','newrefused'].index(kind));rows=[target]+[row for row in rows if row is not target]
        s=sessions.Session.__new__(sessions.Session);s.family=None;s.failures=[];s.lock=threading.RLock();s.manifest={'scenario':scenario,'runtime_source_commit':'a'*40}
        s.case={'chain_names':list(chains),'domain_names':{str(v):k for k,v in domains.items()},'initial_corpus':{'dispatches':4,'deliveries':2,'failed_body':1,'zero_insertions':1,'double_insertions':1},'additional_refused_dispatches':1,'reorg_origin_chain':'test1'}
        s.captures=[{'capture_ordinal':2,'original':{'role':'relayer','chains':chains}}]
        s.initial={'messages':[row for row in rows if row['nonce']<4],'deliverable_messages':[row for row in rows if row['nonce']in[0,3]]}
        expected=kind in {'normal','double'};actual=(not expected)if observed is None else observed
        s.adapter=lambda chain:SimpleNamespace(dispatches=lambda configured:rows if configured['name']=='test1'else[],delivered=lambda mailbox,message_id:actual)
        return s,phase,expected,actual

    def error(self,kind='normal',**kwargs):
        s,phase,expected,actual=self.fixture(kind,**kwargs)
        try:s.canonical_snapshot(2,initial=False,phase=phase)
        except ValueError as error:
            self.assertIs(type(error),ValueError);self.assertEqual(error.args,(self.MESSAGE,));self.assertEqual(s.failures,[]);return error,expected,actual
        self.fail('original canonical mismatch guard did not fail')

    def projected(self,error,modules=None):
        return api.public_frames(error,self.modules if modules is None else modules,HERE)

    def test_actual_guard_projects_both_boolean_directions_and_all_source_kinds(self):
        for kind in ['normal','failedbody','zero','double','newrefused']:
            with self.subTest(kind=kind):
                error,expected,actual=self.error(kind);value=self.projected(error);self.assertIn('canonical_delivery_mismatch',value);row=value['canonical_delivery_mismatch']
                self.assertEqual(row,{'phase':'after_source_reorg','corpus_ordinal':0,'origin_chain':'test1','origin_domain':9913371,'destination_chain':'test2','destination_domain':9913372,'nonce':['normal','failedbody','zero','double','newrefused'].index(kind),'kind':kind,'expected_eligible':expected,'observed_delivered':actual,'native_or_timing_credit':False})
                self.assertEqual(set(error.__dict__),{self.ATTRIBUTE});self.assertNotIn('PRIVATE_SENTINEL',json.dumps(value));self.assertNotIn('0x'+'0'*63+'1',json.dumps(value))

    def test_unknown_phase_cross_family_nonbool_and_optional_failure_preserve_original(self):
        for kwargs in [{'phase':'PRIVATE_PHASE'},{'phase':False},{'phase':[]},{'scenario':'tron'},{'observed':1}]:
            error,_,_=self.error(**kwargs);self.assertNotIn(self.ATTRIBUTE,error.__dict__);self.assertNotIn('canonical_delivery_mismatch',self.projected(error))
        original=sessions.require;seen=[]
        def require(ok,message):
            try:original(ok,message)
            except ValueError as error:seen.append(error);raise
        for optional in [KeyboardInterrupt('PRIVATE_SENTINEL'),ValueError('PRIVATE_SENTINEL')]:
            with mock.patch.object(sessions,'require',side_effect=require),mock.patch.object(api,'bind_canonical_delivery_mismatch',side_effect=optional):
                error,_,_=self.error();self.assertIs(error,seen[-1]);self.assertNotIn(self.ATTRIBUTE,error.__dict__)

    def test_same_method_other_require_forged_source_and_nonadjacent_guard_refuse(self):
        real,_,_=self.error();s,phase,_,_=self.fixture();original_adapter=s.adapter
        def adapter(chain):
            value=original_adapter(chain);dispatch=value.dispatches
            return SimpleNamespace(dispatches=lambda configured:(lambda rows:rows+[rows[0]]if rows else rows)(dispatch(configured)),delivered=value.delivered)
        s.adapter=adapter
        try:s.canonical_snapshot(2,initial=False,phase=phase)
        except ValueError as error:
            self.assertEqual(error.args,('duplicate actual native message ID',));error.__dict__[self.ATTRIBUTE]=real.__dict__[self.ATTRIBUTE];self.assertNotIn('canonical_delivery_mismatch',self.projected(error))
        forged=ValueError(self.MESSAGE);forged.__dict__[self.ATTRIBUTE]=real.__dict__[self.ATTRIBUTE]
        try:raise forged
        except ValueError as error:self.assertNotIn('canonical_delivery_mismatch',self.projected(error))
        wrong=copy.deepcopy(self.modules);wrong['multivm_session.py']['sha256']='0'*64;self.assertNotIn('canonical_delivery_mismatch',self.projected(real,wrong))
        import types
        clone=types.ModuleType('multivm_session');clone.__dict__.update(sessions.__dict__)
        with mock.patch.dict(sys.modules,{'multivm_session':clone}):self.assertNotIn('canonical_delivery_mismatch',self.projected(real))
        with mock.patch.object(sessions,'_CANONICAL_DELIVERY_CODE',sessions.Session._verify.__code__):self.assertNotIn('canonical_delivery_mismatch',self.projected(real))
        original=sessions.require
        def wrapper(*args):return original(*args)
        with mock.patch.object(sessions,'require',side_effect=wrapper):
            error,_,_=self.error();self.assertNotIn('canonical_delivery_mismatch',self.projected(error))

    def test_closed_attribute_type_bounds_extra_fields_and_code_identity_poisons(self):
        error,_,_=self.error();origin,guard,row=error.__dict__[self.ATTRIBUTE]
        edits=[('phase','unknown'),('phase','x'*2048),('corpus_ordinal',True),('corpus_ordinal',256),('corpus_ordinal',-1),('origin_chain','other'),('origin_domain',True),('origin_domain',9913372),('destination_chain','other'),('destination_domain',1),('nonce',True),('nonce',2**32),('nonce',-1),('kind','other'),('expected_eligible',1),('observed_delivered',None),('observed_delivered',row['expected_eligible']),('native_or_timing_credit',True),('PRIVATE_EXTRA','PRIVATE_SENTINEL')]
        for field,value in edits:
            bad=dict(row);bad[field]=value
            with self.subTest(field=field,value=value):
                error.__dict__[self.ATTRIBUTE]=(origin,guard,bad);self.assertNotIn('canonical_delivery_mismatch',self.projected(error))
                with self.assertRaises(ValueError):api.checked_canonical_delivery_mismatch(bad)
        for bad in [None,[],(origin,guard),(origin,guard,[]),('canonical_snapshot',guard,row),(origin,lambda:None,row)]:
            error.__dict__[self.ATTRIBUTE]=bad;self.assertNotIn('canonical_delivery_mismatch',self.projected(error))
        valid=dict(row,corpus_ordinal=255,nonce=2**32-1);self.assertEqual(api.checked_canonical_delivery_mismatch(valid),valid)

    def record(self,error=None,limit=None):
        state={'observed_monotonic_ns':1,'restart_sample_count':0,'restart_failed':False,'restart_first_observed_ns':None,'restart_last_observed_ns':None,'role_activity':[],'observer_failure_count':0,'lifecycle_error_count':0}
        with tempfile.TemporaryDirectory()as directory:
            recorder=api.Recorder(Path(directory)/'observer.json',self.modules,HERE);token=recorder.enter('restart',state)
            if limit is None:recorder.finish(token,dict(state,observed_monotonic_ns=2),'exception'if error else'completed',error)
            else:
                with mock.patch.object(api,'LIMIT',limit):recorder.finish(token,dict(state,observed_monotonic_ns=2),'exception',error)
            result=json.loads(recorder.path.read_bytes())
        return result

    def test_existing_recorder_counts_schema_privacy_cap_and_optional_omission(self):
        error,_,_=self.error();value=self.record(error);self.assertEqual(api.validate_record(value,self.modules),value);self.assertEqual(next(iter(value['failures'].values()))['count'],1);self.assertEqual(value['last_stage']['canonical_delivery_mismatch']['kind'],'normal');self.assertNotIn('PRIVATE_SENTINEL',json.dumps(value))
        old=copy.deepcopy(value)
        for entry in [old['last_stage'],*[r[k]for group in ['stages','failures']for r in old[group].values()for k in ['first','latest']]]:
            if entry:entry.pop('canonical_delivery_mismatch',None)
        bound=len(json.dumps(old,sort_keys=True,separators=(',',':')).encode())+1
        omitted=self.record(error,bound);self.assertEqual(omitted,old);self.assertEqual(api.validate_record(omitted,self.modules),omitted)
        with self.assertRaisesRegex(ValueError,'Diagnostic output bound'):self.record(error,bound-1)
        success=self.record();self.assertEqual(success['failures'],{});self.assertNotIn('canonical_delivery_mismatch',success['last_stage']);api.validate_record(success,self.modules)
        for edit in [lambda r:r['last_stage']['canonical_delivery_mismatch'].update(nonce=True),lambda r:r['last_stage'].update(exception_type='RuntimeError'),lambda r:r['last_stage'].update(status='completed'),lambda r:r['last_stage'].update(frames=[])]:
            bad=copy.deepcopy(value);edit(bad)
            with self.assertRaises(ValueError):api.validate_record(bad,self.modules)
        self.assertEqual(api.LIMIT,256*1024)

    def test_real_success_path_has_no_attribute_or_optional_binding_call(self):
        s,_,_,_=self.fixture();rows=[s.initial['messages'][i]for i in range(len(s.initial['messages']))if s.initial['messages'][i]['nonce']in[1,2]]
        s.case['initial_corpus']={'dispatches':2,'deliveries':0,'failed_body':1,'zero_insertions':1,'double_insertions':0};s.lifecycle=SimpleNamespace(complete=lambda rows:[]);s.broadcasts=[]
        s.adapter=lambda chain:SimpleNamespace(dispatches=lambda configured:rows if configured['name']=='test1'else[],delivered=lambda mailbox,message_id:False)
        with mock.patch.object(api,'bind_canonical_delivery_mismatch',side_effect=AssertionError('not called'))as bind:
            value=s.canonical_snapshot(0,initial=True);self.assertEqual(value['deliverable_messages'],[]);self.assertEqual(value['native_delivery_transactions'],[]);bind.assert_not_called();self.assertEqual(s.failures,[])


class AdminHttpFailureControls(unittest.TestCase):
    MESSAGE='actual native admin sample failed'
    def setUp(self):
        self.modules={name:api.pin(HERE/name)for name in ['multivm_session.py','multivm_evidence.py','multivm_diagnostics.py']}
    def invoke(self,status=503,data=b'PRIVATE_BODY',domain=9913372,hook=None):
        response=mock.Mock(status=status);response.read.return_value=data
        connection=mock.Mock();connection.getresponse.return_value=response
        with mock.patch.object(sessions.http.client,'HTTPConnection',return_value=connection):
            try:result=sessions.admin_operations(12345,domain,connection_hook=hook)
            except ValueError as error:result=error
        response.read.assert_called_once_with(8*1024*1024+1)
        connection.request.assert_called_once_with('GET',f'/list_operations?destination_domain={domain}')
        connection.close.assert_called_once_with()
        return result
    def projected(self,error,modules=None):
        return api.public_frames(error,self.modules if modules is None else modules,HERE)
    def test_actual_status_oversize_and_both_only_export_three_integers(self):
        for status,data in [(503,b'PRIVATE_BODY'),(200,b'x'*(8*1024*1024+1)),(503,b'x'*(8*1024*1024+1)),(999,b'')]:
            with self.subTest(status=status,bytes=len(data)):
                error=self.invoke(status,data);self.assertIs(type(error),ValueError);self.assertEqual(error.args,(self.MESSAGE,))
                row=self.projected(error);self.assertEqual(row['admin_http_failure'],{'domain':9913372,'http_status':status,'body_bytes':len(data)})
                self.assertEqual(set(error.__dict__),{'_admin_http_failure'});self.assertNotIn('PRIVATE',json.dumps(row));self.assertNotIn('body',set(row['admin_http_failure']))
    def test_success_and_other_original_guards_have_no_new_annotation(self):
        events=[];self.assertEqual(self.invoke(200,b'[]',hook=lambda c,live:events.append(live)),[]);self.assertEqual(events,[True,True,False])
        error=self.invoke(200,b'{}');self.assertEqual(error.args,('native admin response is not operation list',));self.assertNotIn('_admin_http_failure',error.__dict__)
        self.assertNotIn('admin_http_failure',self.projected(error))
    def test_optional_baseexception_preserves_original_exception_identity_and_cleanup(self):
        original=sessions.require;seen=[]
        def require(ok,message):
            try:original(ok,message)
            except ValueError as error:seen.append(error);raise
        for failure in [KeyboardInterrupt('PRIVATE'),SystemExit('PRIVATE'),RuntimeError('PRIVATE')]:
            with mock.patch.object(sessions,'require',side_effect=require),mock.patch.object(api,'bind_admin_http_failure',side_effect=failure):error=self.invoke()
            self.assertIs(error,seen[-1]);self.assertEqual(error.args,(self.MESSAGE,));self.assertNotIn('_admin_http_failure',error.__dict__)
    def test_closed_types_ranges_and_success_pair_poison_refused(self):
        good={'domain':9913372,'http_status':503,'body_bytes':12}
        for key,values in {'domain':[True,-1,2**32,'PRIVATE',[]],'http_status':[True,99,1000,'PRIVATE',[]],'body_bytes':[True,-1,8*1024*1024+2,'PRIVATE',[]]}.items():
            for value in values:
                bad=dict(good);bad[key]=value
                with self.assertRaises(ValueError):api.checked_admin_http_failure(bad)
        for bad in [dict(good,body='PRIVATE'),dict(good,http_status=200),{}]:
            with self.assertRaises(ValueError):api.checked_admin_http_failure(bad)
    def test_source_pin_code_pair_globals_nonadjacent_and_other_guard_poison(self):
        error=self.invoke();bound=error.__dict__['_admin_http_failure'];tb=error.__traceback__
        while tb is not None and tb.tb_frame.f_code is not sessions.admin_operations.__code__:tb=tb.tb_next
        self.assertIsNotNone(tb)
        modules=copy.deepcopy(self.modules);modules['multivm_session.py']['bytes']+=1
        self.assertNotIn('admin_http_failure',self.projected(error,modules))
        for bad in [None,(bound[0],bound[1]),(bound[1],bound[0],bound[2]),(bound[0],bound[1],dict(bound[2],http_status=True))]:
            error.__dict__['_admin_http_failure']=bad;self.assertNotIn('admin_http_failure',self.projected(error))
        error.__dict__['_admin_http_failure']=bound
        with mock.patch.object(sessions,'_ADMIN_HTTP_CODE',sessions.collect_admin_sample.__code__):self.assertNotIn('admin_http_failure',self.projected(error))
        with mock.patch.dict(sys.modules,{'multivm_session':SimpleNamespace()}):self.assertNotIn('admin_http_failure',self.projected(error))
        import types
        missing_next=types.TracebackType(None,tb.tb_frame,tb.tb_lasti,tb.tb_lineno)
        self.assertIsNone(api.admin_http_failure(error,missing_next,'multivm_session.py'))
        other=self.invoke(200,b'{}');other.__dict__['_admin_http_failure']=bound;self.assertNotIn('admin_http_failure',self.projected(other))
        self.assertIsNone(api.admin_http_failure(RuntimeError(),tb,'multivm_session.py'))
    def test_response_secret_headers_body_and_error_message_never_projected(self):
        error=self.invoke(503,b'PRIVATE_BODY_URL_HEADER_WINDOW');error.args=('PRIVATE_MESSAGE',)
        value=self.projected(error);self.assertNotIn('PRIVATE',json.dumps(value));self.assertEqual(value['admin_http_failure']['body_bytes'],len(b'PRIVATE_BODY_URL_HEADER_WINDOW'))
        # The private tuple contains only exact code identities and the finite copy.
        self.assertEqual(set(error.__dict__['_admin_http_failure'][2]),{'domain','http_status','body_bytes'})
    def test_recorder_roundtrip_and_schema_poison(self):
        error=self.invoke();state={'observed_monotonic_ns':1,'restart_sample_count':0,'restart_failed':False,'restart_first_observed_ns':None,'restart_last_observed_ns':None,'role_activity':[],'observer_failure_count':0,'lifecycle_error_count':0}
        with tempfile.TemporaryDirectory()as directory:
            recorder=api.Recorder(Path(directory)/'result.json',self.modules,HERE);token=recorder.enter('restart',state)
            recorder.finish(token,dict(state,observed_monotonic_ns=2),'exception',error)
            value=json.loads(recorder.path.read_text());api.validate_record(value,self.modules)
            self.assertEqual(value['last_stage']['admin_http_failure'],{'domain':9913372,'http_status':503,'body_bytes':12})
            for key,bad in [('http_status',True),('body_bytes',-1),('domain',2**32)]:
                poisoned=copy.deepcopy(value);poisoned['last_stage']['admin_http_failure'][key]=bad
                with self.assertRaises(ValueError):api.validate_record(poisoned,self.modules)
            self.assertNotIn('PRIVATE',json.dumps(value))
    def test_new_optional_cap_drop_does_not_change_old_bound_refusal(self):
        row={'admin_http_failure':{'domain':1,'http_status':503,'body_bytes':12}}
        value={'last_stage':row,'stages':{},'failures':{},'padding':'x'*(api.LIMIT-110)}
        original=copy.deepcopy(value);original['last_stage'].pop('admin_http_failure')
        self.assertLessEqual(len(json.dumps(original,sort_keys=True,separators=(',',':')).encode())+1,api.LIMIT)
        self.assertGreater(len(json.dumps(value,sort_keys=True,separators=(',',':')).encode())+1,api.LIMIT)
        api.trim_optional_admin_http_failure(value);self.assertEqual(value,original)
        with tempfile.TemporaryDirectory()as directory:
            recorder=api.Recorder(Path(directory)/'result.json',self.modules,HERE);recorder.value={'last_stage':row,'stages':{},'failures':{},'padding':'x'*api.LIMIT}
            api.trim_optional_admin_http_failure(recorder.value)
            with self.assertRaisesRegex(ValueError,'Diagnostic output bound'):recorder.save()


class StarknetPeerRecoveryControls(unittest.TestCase):
    MESSAGE='Source Starknet unavailable peer has no fresh actual healthy fallback'
    def setUp(self):
        self.modules={name:api.pin(HERE/name)for name in ['multivm_session.py','multivm_evidence.py','multivm_diagnostics.py']}
    def context(self,index=0,role='relayer'):
        return dict(sessions.starknet_unavailable_peers()[index],scenario='starknet',role=role,case_inputs_sha256='a'*64)
    def invoke(self,received=None,index=0,role='relayer',captured=100,notice=110,context=None):
        row=self.context(index,role)if context is None else context
        value=sessions.Session.__new__(sessions.Session);value.lock=threading.RLock()
        value.captures=[{'captured_monotonic_ns':captured,'original':{'role':row['role'],'role_chain_names':[row['chain']],'chains':{row['chain']:{}}}}]
        value.starknet_unavailable_notices=[{'context':row,'monotonic_ns':notice}]
        value.starknet_healthy_rpc_fallbacks={(row['role'],row['chain'],row['field'],row['healthy_fallback']):received}
        try:value.require_starknet_peer_recovery()
        except ValueError as error:return error
        return None
    def projected(self,error,modules=None):
        return api.public_frames(error,self.modules if modules is None else modules,HERE)
    def test_actual_original_guard_missing_stale_and_noninteger(self):
        for received,classification,observed in [(None,'missing',None),(109,'stale',109),(False,'noninteger',None),('PRIVATE_RECEIVE','noninteger',None),(1.0,'noninteger',None)]:
            with self.subTest(classification=classification):
                error=self.invoke(received);self.assertIs(type(error),ValueError);self.assertEqual(error.args,(self.MESSAGE,));value=self.projected(error)
                self.assertIn('starknet_peer_recovery',value)
                self.assertEqual(value['starknet_peer_recovery'],{'role':'relayer','definition_index':0,'latest_capture_ns':100,'notice_ns':110,'received_ns':observed,'classification':classification})
        self.assertIsNone(self.invoke(110));self.assertIsNone(self.invoke(120,captured=120));self.assertEqual(self.projected(self.invoke(115,captured=120))['starknet_peer_recovery']['classification'],'stale')
    def test_all_six_Source_definitions_and_three_roles_are_closed_identifiers(self):
        self.assertEqual(len(sessions.starknet_unavailable_peers()),6)
        for role in ['validator','relayer','scraper']:
            for index in range(6):
                row=self.projected(self.invoke(index=index,role=role))['starknet_peer_recovery'];self.assertEqual((row['role'],row['definition_index']),(role,index));self.assertEqual(set(row),{'role','definition_index','latest_capture_ns','notice_ns','received_ns','classification'})
    def test_optional_binder_BaseException_keeps_original_ValueError_identity(self):
        original=sessions.require;seen=[]
        def require(ok,message):
            try:original(ok,message)
            except ValueError as error:seen.append(error);raise
        for failure in [KeyboardInterrupt('PRIVATE'),SystemExit('PRIVATE'),RuntimeError('PRIVATE')]:
            with mock.patch.object(sessions,'require',side_effect=require),mock.patch.object(api,'bind_starknet_peer_recovery',side_effect=failure):error=self.invoke()
            self.assertIs(error,seen[-1]);self.assertEqual(error.args,(self.MESSAGE,));self.assertNotIn('_starknet_peer_recovery',error.__dict__)
        with mock.patch.object(api,'bind_starknet_peer_recovery')as binder:
            self.assertIsNone(self.invoke(110));binder.assert_not_called()
    def test_secret_context_other_guards_and_unrepresentable_clocks_never_export(self):
        error=self.invoke('PRIVATE_URL_PAYLOAD_WINDOW');error.args=('PRIVATE_MESSAGE',);value=self.projected(error)
        self.assertNotIn('PRIVATE',json.dumps(value));self.assertEqual(set(error.__dict__),{'_starknet_peer_recovery'});self.assertEqual(set(error.__dict__['_starknet_peer_recovery'][2]),{'role','definition_index','latest_capture_ns','notice_ns','received_ns','classification'})
        for key,bad in [('role','PRIVATE_ROLE'),('field','PRIVATE_FIELD'),('upstream','https://PRIVATE'),('case_inputs_sha256','PRIVATE')]:
            context=self.context();context[key]=bad;error=self.invoke(context=context);self.assertIs(type(error),ValueError);self.assertEqual(error.args,(self.MESSAGE,));self.assertNotIn('starknet_peer_recovery',self.projected(error))
        self.assertIsNone(self.invoke(2**63)) # Preserve original predicate; no diagnostic on success.
        for captured,notice,received in [(100,110,-1),(2**63,110,None),(100,2**63,None)]:
            error=self.invoke(received,captured=captured,notice=notice);self.assertEqual(error.args,(self.MESSAGE,));self.assertNotIn('starknet_peer_recovery',self.projected(error))
        error=self.invoke(captured=0);self.assertEqual(error.args,('actual Starknet consumer capture clock required',));self.assertNotIn('_starknet_peer_recovery',error.__dict__)
    def test_closed_field_type_range_consistency_and_extra_data_poisons(self):
        good={'role':'relayer','definition_index':0,'latest_capture_ns':100,'notice_ns':110,'received_ns':109,'classification':'stale'}
        for key,values in {'role':[True,'PRIVATE',[]],'definition_index':[True,-1,6,'PRIVATE'],'latest_capture_ns':[True,0,-1,2**63],'notice_ns':[True,0,-1,2**63],'received_ns':[True,None,-1,110,2**63,'PRIVATE'],'classification':[True,'PRIVATE','missing','noninteger']}.items():
            for value in values:
                bad=dict(good);bad[key]=value
                with self.assertRaises(ValueError):api.checked_starknet_peer_recovery(bad)
        for bad in [dict(good,context='PRIVATE'),{},dict(good,received_ns=None)]:
            with self.assertRaises(ValueError):api.checked_starknet_peer_recovery(bad)
    def test_Source_pin_code_pair_adjacency_and_other_guard_cannot_spoof(self):
        error=self.invoke();bound=error.__dict__['_starknet_peer_recovery'];tb=error.__traceback__
        while tb is not None and tb.tb_frame.f_code is not sessions.Session.require_starknet_peer_recovery.__code__:tb=tb.tb_next
        self.assertIsNotNone(tb)
        modules=copy.deepcopy(self.modules);modules['multivm_session.py']['bytes']+=1;self.assertNotIn('starknet_peer_recovery',self.projected(error,modules))
        for key in ['_STARKNET_PEER_RECOVERY_CODE','_STARKNET_PEER_RECOVERY_REQUIRE_CODE']:
            with mock.patch.object(sessions,key,None):self.assertIsNone(api.starknet_peer_recovery(error,tb,'multivm_session.py'))
        self.assertIsNone(api.starknet_peer_recovery(error,tb,'multivm_evidence.py'));self.assertIsNone(api.starknet_peer_recovery(RuntimeError(),tb,'multivm_session.py'))
        for value in [(bound[1],bound[0],bound[2]),(None,bound[1],bound[2]),'PRIVATE']:
            error.__dict__['_starknet_peer_recovery']=value;self.assertIsNone(api.starknet_peer_recovery(error,tb,'multivm_session.py'))
        other=self.invoke(captured=0);other.__dict__['_starknet_peer_recovery']=bound;self.assertNotIn('starknet_peer_recovery',self.projected(other))
        error.__dict__['_starknet_peer_recovery']=bound
        fake=SimpleNamespace(tb_frame=tb.tb_frame,tb_next=None,tb_lineno=tb.tb_lineno);self.assertIsNone(api.starknet_peer_recovery(error,fake,'multivm_session.py'))
        with mock.patch.object(sessions.Session,'require_starknet_peer_recovery',lambda self:None):self.assertIsNone(api.starknet_peer_recovery(error,tb,'multivm_session.py'))
    def test_optional_projection_error_quarantined_without_changing_frames(self):
        error=self.invoke();baseline=self.projected(error);baseline.pop('starknet_peer_recovery')
        for raised in [KeyboardInterrupt('PRIVATE'),SystemExit('PRIVATE'),RuntimeError('PRIVATE')]:
            with mock.patch.object(api,'starknet_peer_recovery',side_effect=raised):self.assertEqual(self.projected(error),baseline)
    def test_recorder_roundtrip_schema_requires_correct_exception_and_frame(self):
        state={'observed_monotonic_ns':120,'restart_sample_count':0,'restart_failed':False,'restart_first_observed_ns':None,'restart_last_observed_ns':None,'role_activity':[],'observer_failure_count':0,'lifecycle_error_count':0}
        with tempfile.TemporaryDirectory()as directory:
            recorder=api.Recorder(Path(directory)/'result.json',self.modules,HERE);token=recorder.enter('before_restart',state);recorder.finish(token,dict(state,observed_monotonic_ns=130),'exception',self.invoke())
            value=json.loads(recorder.path.read_text());api.validate_record(value,self.modules);self.assertEqual(value['last_stage']['starknet_peer_recovery']['classification'],'missing');self.assertNotIn('PRIVATE',json.dumps(value))
            for key,bad in [('definition_index',True),('role','PRIVATE'),('notice_ns',-1)]:
                invalid=copy.deepcopy(value);invalid['last_stage']['starknet_peer_recovery'][key]=bad
                with self.assertRaises(ValueError):api.validate_record(invalid,self.modules)
            for key,bad in [('exception_type','RuntimeError'),('frames',[])]:
                invalid=copy.deepcopy(value);invalid['last_stage'][key]=bad
                with self.assertRaises(ValueError):api.validate_record(invalid,self.modules)
    def test_optional_cap_drop_preserves_HTTP_and_old_oversize_refusal(self):
        finite=self.projected(self.invoke())['starknet_peer_recovery'];base={'last_stage':{'admin_http_failure':{'domain':1,'http_status':503,'body_bytes':12}},'stages':{},'failures':{},'padding':''}
        base['padding']='x'*(api.LIMIT-len(json.dumps(base,sort_keys=True,separators=(',',':')).encode())-1)
        self.assertEqual(len(json.dumps(base,sort_keys=True,separators=(',',':')).encode())+1,api.LIMIT);value=copy.deepcopy(base);value['last_stage']['starknet_peer_recovery']=finite
        api.trim_optional_starknet_peer_recovery(value);self.assertEqual(value,base)
        with mock.patch.object(api.json,'dumps',side_effect=KeyboardInterrupt('PRIVATE')):
            value=copy.deepcopy(base);value['last_stage']['starknet_peer_recovery']=finite;api.trim_optional_starknet_peer_recovery(value)
        self.assertEqual(value,base)
        with tempfile.TemporaryDirectory()as directory:
            recorder=api.Recorder(Path(directory)/'result.json',self.modules,HERE);recorder.value={'last_stage':{'starknet_peer_recovery':finite},'stages':{},'failures':{},'padding':'x'*api.LIMIT};api.trim_optional_starknet_peer_recovery(recorder.value)
            with self.assertRaisesRegex(ValueError,'Diagnostic output bound'):recorder.save()


class AdminQueueRenderFailureControls(unittest.TestCase):
    def setUp(self):
        self.source=(HERE.parents[1]/'zig/src/ops/admin/api.zig').read_bytes()
        self.sources={'zig/src/ops/admin/api.zig':self.source}
    def line(self,code='QUEUE_VIEW_UNAVAILABLE',domain='9913371',pid='321',clock='123456789'):
        return f'<RLY> warning: admin queue render failure code={code} domain={domain} pid={pid} observed_monotonic_ns={clock}\n'.encode()
    def test_all_five_enums_first_latest_and_numeric_process_fields(self):
        codes=sorted(api.ADMIN_QUEUE_RENDER_CODES);raw=b''.join(self.line(c,clock=str(i+1))for i,c in enumerate(codes));x=api.admin_queue_render_failure_projection(raw,self.sources)
        self.assertEqual(x['count'],5);self.assertEqual(x['first'],{'code':codes[0],'domain':9913371,'pid':321,'observed_monotonic_ns':1});self.assertEqual(x['latest']['code'],codes[-1]);self.assertEqual(x['latest']['observed_monotonic_ns'],5);self.assertIs(x['text_only'],True);self.assertIs(x['native_or_timing_or_identity_authority'],False)
    def test_source_spoof_enum_bounds_suffix_and_private_poisons(self):
        for sources in [{},{'zig/src/ops/admin/api.zig':self.source+b'\n'},{'zig/src/ops/admin/api.zig':self.source.replace(b'queueRenderFailureCode',b'queueRenderFailureFake')}]:self.assertIsNone(api.admin_queue_render_failure_projection(self.line(),sources))
        for raw in [self.line('PRIVATE_SENTINEL'),self.line(domain=str(2**32)),self.line(pid='0'),self.line(pid=str(2**31)),self.line(clock='0'),self.line(clock=str(2**64)),self.line(domain='01'),self.line(pid='0321'),self.line(clock='-1'),self.line().replace(b'\n',b' PRIVATE_SENTINEL\n'),self.line().replace(b'<RLY>',b'<OTHER>'),b'\x1b[31m'+self.line(),b'x'*16385+self.line(),b'x'*(32*1024**2+1)]:
            self.assertIsNone(api.admin_queue_render_failure_projection(raw,self.sources))
        x=api.admin_queue_render_failure_projection(b'PRIVATE_BODY_URL_HEADER_WINDOW\n'+self.line('OTHER'),self.sources);self.assertNotIn('PRIVATE',json.dumps(x));self.assertEqual(x['first']['code'],'OTHER')
    def test_old_header_rows_counts_are_byte_model_exact_even_at_capacity(self):
        # Self-contained historical fixed-header fixture; no packet/before files.
        expected={'counts':{'supervised_task_failed':16,'health_warning':0,'agent_stopped':0,'native_group_rpc_warning':0,'relayer_telemetry_warning':0,'initialization_metric_warning':0,'critical_metric_warning':0,'origin_range_fetch_warning':0},
                  'observations':[{'header':'supervised_task_failed','task_index':i,'Source_error_name':'OutOfMemory','error_name_status':'Source_literal','lane_attribution':None}for i in range(16)],
                  'scope':'Fixed RLY-prefixed text only; no typed exception, task-to-lane, unique PID/epoch or readiness claim.'}
        raw=b''.join(f'<RLY> warning: task {i} failed: OutOfMemory\n'.encode()for i in range(16))
        actual=api.startup_header_projection(raw+self.line(),self.sources);extra=actual.pop('admin_queue_render_failure');self.assertEqual(extra['count'],1);self.assertEqual(actual,expected);self.assertEqual(len(actual['observations']),16)
        with mock.patch.object(api,'admin_queue_render_failure_projection',side_effect=KeyboardInterrupt('PRIVATE')):self.assertEqual(api.startup_header_projection(raw,self.sources),expected)
    def test_optional_trim_keeps_all_old_fields_and_original_oversize(self):
        extra=api.admin_queue_render_failure_projection(self.line(),self.sources);record={'EVM_Stark_startup':{'fixed_harness_headers':{'counts':{},'observations':[], 'admin_queue_render_failure':extra}},'old':'x'*(512*1024-140)};before=copy.deepcopy(record);before['EVM_Stark_startup']['fixed_harness_headers'].pop('admin_queue_render_failure');self.assertLessEqual(len(json.dumps(before,sort_keys=True,separators=(',',':')).encode())+1,512*1024);api.trim_optional_admin_queue_render_failure(record);self.assertEqual(record,before)
        small={'EVM_Stark_startup':{'fixed_harness_headers':{'admin_queue_render_failure':extra}}};same=copy.deepcopy(small);api.trim_optional_admin_queue_render_failure(small);self.assertEqual(small,same)
        record['old']='x'*(512*1024);api.trim_optional_admin_queue_render_failure(record);self.assertGreater(len(json.dumps(record).encode()),512*1024)
    def owner_writer(self,extra,padding,root,trim=None,scenario='evm',sample_calls=None):
        import types
        source=HERE.parents[1]/'zig/bench/native_case_owner.py';tree=ast.parse(source.read_text());fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='write_public_failure_diagnostics')
        startup={'fixed_harness_headers':{'counts':{},'observations':[],'scope':'old'},'padding':padding}
        if extra is not None:startup['fixed_harness_headers']['admin_queue_render_failure']=extra
        namespace={'snapshot_public_diagnostics':lambda *a:None,'time':SimpleNamespace(monotonic_ns=lambda:100),'json':json,'Path':Path,'__file__':str(source),'diagnostic_module':lambda *a:SimpleNamespace(late_invariant_observation=lambda *a:{},starknet_admin_sampling_observation=lambda *a:(sample_calls.append('called')if sample_calls is not None else None)or{'schema':1,'collection_status':'unavailable','native_or_timing_or_cleanup_authority':False},trim_optional_admin_queue_render_failure=api.trim_optional_admin_queue_render_failure if trim is None else trim),'pin':api.pin,'os':__import__('os'),'require':sessions.require}
        exec(compile(ast.Module([fn],type_ignores=[]),str(source),'exec'),namespace)
        out=Path(root);context={'state':SimpleNamespace(public=lambda *a:copy.deepcopy(startup)),'latest_probe':None}
        return namespace['write_public_failure_diagnostics']({'execution_source_commit':'a'*40},{'runtime_source_commit':'b'*40,'scenario':scenario,'mode':'ReleaseSafe'},{'python_modules':{}},out,out,{'direct_waits':[]},1,startup_context=context)
    def test_real_owner_aggregate_exact_cap_fallback_and_old_refusal(self):
        extra=api.admin_queue_render_failure_projection(self.line(),self.sources)
        with tempfile.TemporaryDirectory()as t:
            base=Path(t);initial=base/'initial';initial.mkdir();row=self.owner_writer(None,'',initial);value=json.loads(Path(row['path']).read_text());wire=len(json.dumps(value,sort_keys=True,separators=(',',':')).encode())+1;pad='x'*(512*1024-wire)
            exact=base/'exact';exact.mkdir();row=self.owner_writer(extra,pad,exact);result=json.loads(Path(row['path']).read_text());self.assertEqual(Path(row['path']).stat().st_size,512*1024);self.assertNotIn('admin_queue_render_failure',result['EVM_Stark_startup']['fixed_harness_headers']);self.assertEqual(result,{**value,'EVM_Stark_startup':{**value['EVM_Stark_startup'],'padding':pad}})
            failed=base/'failed';failed.mkdir()
            with self.assertRaisesRegex(ValueError,'Public failure record bound'):self.owner_writer(extra,pad+'x',failed)
            fallback=base/'fallback';fallback.mkdir()
            def broken(record):raise SystemExit('PRIVATE_SECONDARY')
            row=self.owner_writer(extra,'',fallback,broken);self.assertEqual(json.loads(Path(row['path']).read_text()),value)


    def test_existing_Stark_reserve_decision_and_old_fields_survive_new_namespace(self):
        extra=api.admin_queue_render_failure_projection(self.line(),self.sources)
        with tempfile.TemporaryDirectory()as t:
            base=Path(t);initial=base/'initial';initial.mkdir();calls=[]
            row=self.owner_writer(None,'',initial,scenario='starknet',sample_calls=calls);self.assertEqual(calls,['called']);value=json.loads(Path(row['path']).read_text())
            presize=len(json.dumps(value,sort_keys=True,separators=(',',':')).encode());pad='x'*(512*1024-24*1024-presize)
            expected={**value,'EVM_Stark_startup':{**value['EVM_Stark_startup'],'padding':pad}}
            for name,optional in [('baseline',None),('new',extra)]:
                out=base/name;out.mkdir();seen=[];row=self.owner_writer(optional,pad,out,scenario='starknet',sample_calls=seen);actual=json.loads(Path(row['path']).read_text());self.assertEqual(seen,['called']);self.assertEqual(actual,expected)
            # One byte over the OLD reserve still refuses its old sampling path.
            for name,optional in [('old-over',None),('new-over',extra)]:
                out=base/name;out.mkdir();seen=[];row=self.owner_writer(optional,pad+'x',out,scenario='starknet',sample_calls=seen);self.assertEqual(seen,[]);actual=json.loads(Path(row['path']).read_text());self.assertNotIn('admin_queue_render_failure',actual['EVM_Stark_startup']['fixed_harness_headers']);self.assertEqual(actual,{**expected,'EVM_Stark_startup':{**expected['EVM_Stark_startup'],'padding':pad+'x'}})



if __name__=='__main__':unittest.main()
