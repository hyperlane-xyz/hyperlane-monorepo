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
        bodies={'program.rs':b'let mut reader = BufReader::new(output).lines();\nprintln!("<{prefix}> {line}");','sealevel/solana.rs':b'args.spawn("SOL", None)','sealevel/mod.rs':b'scraper_env.spawn("SCR", None)'}
        for suffix,body in bodies.items():
            name='rust/main/utils/run-locally/src/'+suffix;path=self.repo/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(body);self.sources[name]=api.pin(path)
    def select(self,raw,scenario='sealevel'):return api.svm_private_windows(raw,self.sources,self.repo,scenario)
    def test_fixed_physical_tags_deduplicated_overlap_and_private_bytes(self):
        raw=b'<SOL> \x1b[31mPRIVATE\xff\x00\n<SCR> private-key-text\n';plain,meta=self.select(raw)
        self.assertEqual(plain,raw);self.assertEqual([r['bytes']for r in meta['windows']],[len(raw.splitlines(True)[0]),0,len(raw.splitlines(True)[1]),0]);self.assertNotIn('PRIVATE',json.dumps(meta));self.assertNotIn('sha256',json.dumps(meta))
        plain,meta=self.select(raw,'sealevel-composite');self.assertEqual(plain,raw.splitlines(True)[0]);self.assertEqual([r['bytes']for r in meta['windows']][2:],[0,0])
    def test_global_window_bound_43_not44_and_exact_tail(self):
        sol=b''.join(b'<SOL> '+bytes([65+i%26])*80+b'\n'for i in range(200));scr=sol.replace(b'<SOL>',b'<SCR>')
        plain,meta=self.select(sol+scr);self.assertEqual(len(plain),16384);self.assertEqual((len(plain)+383)//384,43);self.assertEqual([r['bytes']for r in meta['windows']],[4096]*4);self.assertEqual(plain,sol[:4096]+sol[-4096:]+scr[:4096]+scr[-4096:])
    def test_lookalikes_oversize_source_poison_and_absolute_check(self):
        raw=b' <SOL> foreign\n\x1b[31m<SOL> foreign\n<RLY> <SOL> foreign\n<SOLX> foreign\n<SOL> '+b'x'*65536+b'\n'
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


if __name__=='__main__':unittest.main()
