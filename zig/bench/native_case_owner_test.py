"""Pure ownership/cleanup/restore controls; no native chain or Docker calls."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import os
import subprocess
import sys
import time
import unittest
from unittest import mock

spec=importlib.util.spec_from_file_location('native_case_owner',Path(__file__).with_name('native_case_owner.py'))
api=importlib.util.module_from_spec(spec);spec.loader.exec_module(api)


class CaseOwnerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='znc-control-',dir=Path('/tmp').resolve());self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve();self.pg={'image_id':'sha256:'+'a'*64,'run_token':'b'*32}
        self.name='ziggy-e2e-control-42-scraper-testnet-postgres'
        self.row={'Id':'c'*64,'Name':'/'+self.name,'Image':self.pg['image_id'],'Config':{'Labels':{api.LABEL_ROOT:hashlib.sha256(bytes(self.root)).hexdigest(),api.LABEL_PID:'42',api.LABEL_TOKEN:self.pg['run_token']}},'HostConfig':{'Memory':api.GIB,'MemorySwap':api.GIB,'NanoCpus':2_000_000_000,'PidsLimit':256,'PortBindings':{'5432/tcp':[{'HostIp':'127.0.0.1','HostPort':'5432'}]},'Tmpfs':{'/var/lib/postgresql/data':'rw,nosuid,size=2147483648'}}}

    def test_exact_owned_cid_and_caps(self):
        self.assertEqual(api.pg_owned(self.row,self.root,42,self.pg,self.name),'c'*64);api.pg_caps(self.row)

    def test_bad_caps_fail_acceptance_without_losing_cleanup_authority(self):
        changed=copy.deepcopy(self.row);changed['HostConfig']['Memory']=0
        with self.assertRaises(ValueError):api.pg_caps(changed)
        self.assertEqual(api.pg_owned(changed,self.root,42,self.pg,self.name),'c'*64)

    def test_foreign_token_image_name_pid_or_replaced_cid_rejects_cleanup(self):
        for key,value in [('Image','sha256:'+'d'*64),('Name','/foreign'),('Id','e'*64)]:
            changed=copy.deepcopy(self.row);changed[key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):api.pg_owned(changed,self.root,42,self.pg,self.name,'c'*64)
        for key in [api.LABEL_ROOT,api.LABEL_PID,api.LABEL_TOKEN]:
            changed=copy.deepcopy(self.row);changed['Config']['Labels'][key]='foreign'
            with self.subTest(key=key),self.assertRaises(ValueError):api.pg_owned(changed,self.root,42,self.pg,self.name)

    def test_missing_container_is_exact_target_and_not_transport_error(self):
        for message in ['Error: No such object: '+self.name,'Error response from daemon: No such container: '+self.name]:
            self.assertTrue(api.missing_container(1,message.encode(),self.name))
        for message in ['Error: No such object: foreign','dial unix: no such file or directory','permission denied; No such object: '+self.name]:
            self.assertFalse(api.missing_container(1,message.encode(),self.name))
        self.assertFalse(api.missing_container(0,('Error: No such object: '+self.name).encode(),self.name))

    def test_cid_first_publication_is_atomic_and_never_rewritten(self):
        api.persist_owned_cid(self.root,'c'*64);path=self.root/'owned-pg.json';before=api.pin(path);inode=path.stat().st_ino
        api.persist_owned_cid(self.root,'c'*64)
        self.assertEqual(api.pin(path),before);self.assertEqual(path.stat().st_ino,inode)
        with self.assertRaises(ValueError):api.persist_owned_cid(self.root,'d'*64)
        self.assertEqual(api.pin(path),before)

    def test_crash_before_cid_publication_never_exposes_partial_final_record(self):
        (self.root/'.owned-pg-crashed.pending').write_bytes(b'{')
        failure=OSError('injected pre-publication failure')
        with mock.patch.object(api.os,'link',side_effect=failure):
            with self.assertRaises(OSError) as caught:api.persist_owned_cid(self.root,'c'*64)
        self.assertIs(caught.exception,failure);self.assertFalse((self.root/'owned-pg.json').exists())
        api.persist_owned_cid(self.root,'c'*64);self.assertEqual(api.read_owned_cid(self.root/'owned-pg.json'),'c'*64)
        self.assertEqual((self.root/'.owned-pg-crashed.pending').read_bytes(),b'{')

    def test_malformed_cid_record_still_emits_failed_recovery_receipt_without_mutation(self):
        worker=self.root/'worker';worker.mkdir();output=self.root/'output';output.mkdir()
        (worker/'helper-launch.json').write_text(json.dumps({'helper_pid':42,'helper_start':'linux-ticks:123'}))
        (worker/'owned-pg.json').write_bytes(b'{')
        receipt=api.recover_owned_pg(self.root,{}, {'postgres':self.pg},worker,output)
        self.assertIs(receipt['container_absent'],False);self.assertIn('error',receipt);self.assertEqual(receipt['calls'],[])
        self.assertEqual(json.loads((output/'PG-recovery.json').read_text()),receipt)
        self.assertEqual((worker/'owned-pg.json').read_bytes(),b'{')

    def test_actual_kernel_target_filesystem_and_bound(self):
        good='42 33 0:42 / /var/lib/postgresql/data rw,nosuid - tmpfs tmpfs rw,size=2097152k\n'
        api.kernel_tmpfs(good)
        for text in [good.replace('tmpfs tmpfs','ext4 ext4'),good.replace('/var/lib/postgresql/data','/foreign'),good.replace('2097152k','4194304k'),good+good]:
            with self.assertRaises(ValueError):api.kernel_tmpfs(text)

    def test_all_six_generated_slots_restore_bytes_mode_and_prior_absence(self):
        repo=self.root/'repo';repo.mkdir();original=repo/api.GENERATED[4];original.parent.mkdir(parents=True);original.write_bytes(b'original');original.chmod(0o640)
        transaction=api.GeneratedSlots(repo,self.root/'backup',True)
        for name in api.GENERATED:
            p=repo/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b'generated')
        transaction.restore()
        self.assertEqual(original.read_bytes(),b'original');self.assertEqual(original.stat().st_mode&0o777,0o640)
        self.assertTrue(all(not (repo/name).exists() for name in api.GENERATED if name!=api.GENERATED[4]))
        self.assertEqual((self.root/'backup/4.generated').read_bytes(),b'generated')

    def test_second_restore_after_postflight_failure_preserves_real_generated_snapshot(self):
        repo=self.root/'repo';repo.mkdir();original=repo/api.GENERATED[4];original.parent.mkdir(parents=True);original.write_bytes(b'original')
        transaction=api.GeneratedSlots(repo,self.root/'backup',True)
        original.write_bytes(b'actual generated state')
        transaction.restore()
        snapshot=self.root/'backup/4.generated';before=api.pin(snapshot)
        # Outer retry reconstructs from original pre-run metadata, not mutated
        # in-memory rows, matching a worker failure after its first restore.
        retry=api.GeneratedSlots.__new__(api.GeneratedSlots);retry.repo=repo;retry.evidence=self.root/'backup';retry.rows=json.loads((retry.evidence/'before.json').read_text())
        retry.restore()
        self.assertEqual(api.pin(snapshot),before);self.assertEqual(snapshot.read_bytes(),b'actual generated state');self.assertEqual(original.read_bytes(),b'original')

    def test_changed_backup_or_symlink_parent_is_never_restored_over_foreign(self):
        repo=self.root/'repo';repo.mkdir();original=repo/api.GENERATED[0];original.parent.mkdir(parents=True);original.write_bytes(b'original')
        transaction=api.GeneratedSlots(repo,self.root/'backup',True)
        (self.root/'backup/0.before').write_bytes(b'changed')
        with self.assertRaises(ValueError):transaction.restore()
        (self.root/'backup/0.before').write_bytes(b'original')
        original.unlink();parent=original.parent;parent.rmdir();foreign=self.root/'foreign';foreign.mkdir();marker=foreign/'addresses.json';marker.write_bytes(b'foreign')
        parent.symlink_to(foreign,target_is_directory=True)
        with self.assertRaises(ValueError):transaction.restore()
        self.assertEqual(marker.read_bytes(),b'foreign')

    def test_fixture_parent_waits_require_each_actual_child_and_no_forced_shutdown(self):
        rows=[{'pid':i+1,'role':role,'parent_pid':42,'parent_wait_completed':True,'forced_kill':False,'purpose':'fixture_teardown','already_exited':False} for i,role in enumerate(['fixture-docker','fixture-hypd','fixture-hypd'])]
        path=self.root/'waits.jsonl'
        def save(values):path.write_text(''.join(json.dumps(row)+'\n' for row in values))
        save(rows);self.assertEqual(len(api.fixture_waits(path,'cosmosnative',42)),3)
        for field,value in [('parent_pid',43),('forced_kill',True),('parent_wait_completed',False),('already_exited',True),('role','foreign')]:
            changed=copy.deepcopy(rows);changed[0][field]=value;save(changed)
            with self.subTest(field=field),self.assertRaises(ValueError):api.fixture_waits(path,'cosmosnative',42)

    def bootstrap_plan(self):
        script=self.root/'fake-helper.py'
        script.write_text('#!'+sys.executable+'\nimport json,os\nfrom pathlib import Path\nPath(os.environ["NATIVE_TEST_MARKER"]).write_text(json.dumps({"pid":os.getpid()}))\n')
        script.chmod(0o700)
        docker={'host':'unix:///public-fixture/unused.sock','config_dir':str(self.root/'docker-config')}
        approval=self.root/'approval.json';approval.write_text(json.dumps({'root_approved':True,'scenario':'evm','runtime_source_commit':'a'*40,'harness':api.pin(script),'python_modules':{},'local_docker':docker}))
        inputs=self.root/'inputs.json';inputs.write_text(json.dumps({'local_docker':docker}))
        manifest=self.root/'manifest.json';manifest.write_text(json.dumps({'scenario':'evm','implementation':'zig','runtime_source_commit':'a'*40,'task_root':str(self.root),'execution_approval':api.pin(approval),'case_inputs':api.pin(inputs)}))
        plan={'schema':1,'root_approved':True,'scenario':'evm','manifestArtifact':api.pin(manifest),'harnessArtifact':api.pin(script),'harness_argv':[str(script)],'harness_cwd':str(self.root),'lsofArtifact':api.pin(script),'required_inputs':[api.pin(script),api.pin(Path(api.__file__).resolve()),api.pin(Path(api.owner.__file__).resolve())],'explicit_environment':{'PATH':'/usr/bin:/bin','DOCKER_HOST':docker['host'],'DOCKER_CONFIG':docker['config_dir'],'NATIVE_TEST_MARKER':str(self.root/'marker.json')},'maximum_owned_RAM_bytes':8*api.GIB,'maximum_case_allocated_bytes':4*api.GIB,'minimum_host_free_bytes':6*api.GIB,'maximum_wall_seconds':3600,'confirm_seconds':600,'grace_seconds':30,'clean_fixture_parent_waits_required':3}
        path=self.root/'plan.json';path.write_text(json.dumps(plan));return path

    def test_closed_plan_requires_approved_bounds_exact_invocation_and_code_pins(self):
        path=self.bootstrap_plan();original=json.loads(path.read_text())
        self.assertEqual(api.load_plan(path,api.pin(path)['sha256'])[0]['scenario'],'evm')
        for mutate in [lambda p:p.update(root_approved=False),lambda p:p.update(maximum_wall_seconds=3601),lambda p:p.update(harness_argv=[p['harness_argv'][0],'arbitrary']),lambda p:p['required_inputs'].pop(),lambda p:p['explicit_environment'].update(GH_TOKEN='not-a-real-token')]:
            changed=copy.deepcopy(original);mutate(changed);path.write_text(json.dumps(changed))
            with self.assertRaises(ValueError):api.load_plan(path,api.pin(path)['sha256'])

    @unittest.skipUnless(sys.platform=='linux','Actual Linux PID/start/bootstrap control; no Darwin emulation')
    def test_linux_bootstrap_requires_go_and_exec_retains_actual_pid_start(self):
        path=self.bootstrap_plan();marker=self.root/'marker.json'
        with (self.root/'bootstrap.log').open('wb') as log:
            child=subprocess.Popen([sys.executable,'-I','-B',str(Path(api.__file__)), '--helper-bootstrap','--plan',str(path),'--plan-sha256',api.pin(path)['sha256'],'--output',str(self.root/'unused')],stdin=subprocess.PIPE,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
            try:
                start=api.owner._linux_row(child.pid);self.assertIsNotNone(start)
                time.sleep(.1);self.assertFalse(marker.exists());self.assertIsNone(child.poll())
                child.stdin.write(b'GO\n');child.stdin.flush();child.stdin.close()
                self.assertEqual(child.wait(timeout=3),0)
                self.assertEqual(json.loads(marker.read_text())['pid'],child.pid)
                self.assertIsNone(api.owner._linux_row(child.pid))
                print('actual_bootstrap_parent_wait pid='+str(child.pid)+' start='+start['start']+' exit=0')
            finally:
                if child.poll() is None:child.kill();child.wait(timeout=3)
                if child.stdin is not None and not child.stdin.closed:child.stdin.close()

    @unittest.skipUnless(sys.platform=='linux','Actual Linux bootstrap EOF control')
    def test_linux_bootstrap_eof_never_executes_helper(self):
        path=self.bootstrap_plan()
        with (self.root/'bootstrap-eof.log').open('wb') as log:
            child=subprocess.Popen([sys.executable,'-I','-B',str(Path(api.__file__)), '--helper-bootstrap','--plan',str(path),'--plan-sha256',api.pin(path)['sha256'],'--output',str(self.root/'unused')],stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
            try:self.assertNotEqual(child.wait(timeout=3),0);self.assertFalse((self.root/'marker.json').exists())
            finally:
                if child.poll() is None:child.kill();child.wait(timeout=3)

    def test_nonchild_receipt_never_counts_as_actual_wait(self):
        path=self.root/'waits.jsonl';path.write_text(json.dumps({'pid':7,'parent_wait_completed':False})+'\n')
        with self.assertRaises((ValueError,KeyError)):api.fixture_waits(path,'evm',42)


    def listener_fixture(self):
        executable=self.root/'hypd';executable.write_bytes(b'not-executed');executable.chmod(0o755)
        home=self.root/'hypd-home';home.mkdir()
        row={'pid':42,'ppid':7,'pgid':42,'sid':42,'state':'S','start':'linux-ticks:123','rss_bytes':1,'comm':'fixture'}
        manifest={'tool_overrides':{'E2E_HYPD_PATH':api.pin(executable)}}
        return executable,home,row,manifest

    def test_unrelated_protected_executable_is_not_a_node_failure_or_proof(self):
        executable,home,row,manifest=self.listener_fixture();observed={}
        original=Path.read_bytes
        def read(path):
            return b'hypd\0start\0--home\0'+os.fsencode(home)+b'\0' if str(path)=='/proc/42/cmdline' else original(path)
        def link(path):
            if path=='/proc/1/exe':raise PermissionError(13,'Permission denied',path)
            return str(executable)
        query=subprocess.CompletedProcess([],0,b'p42\nn127.0.0.1:26659\nn127.0.0.1:26660\n',b'')
        with mock.patch.object(api.owner,'proc_fallback',return_value={1:{'state':'S'},42:row}), mock.patch.object(api.os,'readlink',side_effect=link), mock.patch.object(Path,'read_bytes',read), mock.patch.object(api.owner,'_linux_row',return_value=row), mock.patch.object(api.subprocess,'run',return_value=query) as run:
            expected=api.native_listener_proof('cosmosnative',manifest,{},self.root,self.root/'unused-lsof',observed)
        self.assertEqual(expected,[{26659,26660},{26665,26666}])
        self.assertEqual(observed['26659,26660']['pid'],42)
        self.assertEqual(run.call_count,1) # PID1 never receives listener credit or I/O.

    def test_protected_executables_alone_produce_no_readiness_credit(self):
        _,_,_,manifest=self.listener_fixture();observed={}
        with mock.patch.object(api.owner,'proc_fallback',return_value={1:{'state':'S'}}), mock.patch.object(api.os,'readlink',side_effect=PermissionError(13,'Permission denied')), mock.patch.object(api.subprocess,'run') as run:
            expected=api.native_listener_proof('cosmosnative',manifest,{},self.root,self.root/'unused-lsof',observed)
        self.assertEqual(observed,{})
        self.assertEqual(len(expected),2)
        run.assert_not_called()

    def test_actual_matching_node_cmdline_permission_still_fails(self):
        executable,_,row,manifest=self.listener_fixture();observed={}
        failure=PermissionError(13,'Actual matched node cmdline denied')
        with mock.patch.object(api.owner,'proc_fallback',return_value={42:row}), mock.patch.object(api.os,'readlink',return_value=str(executable)), mock.patch.object(Path,'read_bytes',side_effect=failure):
            with self.assertRaises(PermissionError) as caught:api.native_listener_proof('cosmosnative',manifest,{},self.root,self.root/'unused-lsof',observed)
        self.assertIs(caught.exception,failure)
        self.assertEqual(observed,{})


    def test_actual_matching_node_listener_permission_still_fails(self):
        executable,home,row,manifest=self.listener_fixture();observed={}
        original=Path.read_bytes
        def read(path):
            return b'hypd\0start\0--home\0'+os.fsencode(home)+b'\0' if str(path)=='/proc/42/cmdline' else original(path)
        failure=PermissionError(13,'Actual matched node listener denied')
        with mock.patch.object(api.owner,'proc_fallback',return_value={42:row}), mock.patch.object(api.os,'readlink',return_value=str(executable)), mock.patch.object(Path,'read_bytes',read), mock.patch.object(api.subprocess,'run',side_effect=failure):
            with self.assertRaises(PermissionError) as caught:api.native_listener_proof('cosmosnative',manifest,{},self.root,self.root/'unused-lsof',observed)
        self.assertIs(caught.exception,failure)
        self.assertEqual(observed,{})


    def public_snapshot_fixture(self):
        identity='0x'+'11'*32;tx='0x'+'22'*32;first=1_000_000_000_000
        life={'id':identity,'chain':'test2','transaction_hash':tx,'first_positive_monotonic_ns':first,
              'early_active_samples':1200,'confirm_by_self_samples':1100,'retired_monotonic_ns':first+601*10**9,
              'observed_message_sha256':'33'*32,'last_present_request_started_ns':first+599*10**9-1,
              'last_present_response_received_ns':first+599*10**9,'maximum_observed_sample_gap_ns':2*10**9,
              'first_absent_request_started_ns':first+601*10**9-1,'first_absent_response_received_ns':first+601*10**9}
        message={'id':identity,'nonce':0,'origin':1,'destination':2,'origin_chain':'test1','delivery_chain':'test2','delivery_transaction':tx,'insertions':[0],
                 'wire':'DO-NOT-EXPORT-SIGNED-OR-MESSAGE-WIRE','body':'DO-NOT-EXPORT-PRIVATE','signature':'DO-NOT-EXPORT-SIGNATURE'}
        signed={'bytes':100,'sha256':'0x'+'44'*32}
        operation={'context':'0x'+'55'*32,'generation':1,'identity':{'kind':'hash256','hex':tx},'stored_canonical_intent':signed,'signed':signed,
                   'row':signed,'nonce':0,'origin':1,'destination':2,'kind':'process','stage':'delivered','retries':0,'confirmation_started':True,
                   'deadline':{'unix_ms':1,'delay_ms':600000},'authorization':'DO-NOT-EXPORT-AUTHORIZATION','signed_hex':'DO-NOT-EXPORT-SIGNED-WIRE'}
        start=2_000_000_000_000
        restart={'schema':1,'minimum_live_ns':30*10**9,'epoch_sha256':'66'*32,'maximum_successful_sample_gap_ns':10*10**9,
                 'elapsed_live_ns':30*10**9,'new_capture_last_monotonic_ns':start-100,'new_capture_monotonic_ns_by_role_chain':{'relayer:test2':start-100,'validator:test1':start-100},'before_effective_config_sha256':'ab'*32,'after_effective_config_sha256':'ab'*32,
                 'samples':[{'observed_monotonic_ns':start+i*5*10**9,'role_rpc_activity':{'relayer:test2':start+i*5*10**9-1,'validator:test1':start+i*5*10**9-2},'role_rpc_request_started_ns':{'relayer:test2':start+i*5*10**9-10,'validator:test1':start+i*5*10**9-20}}for i in range(7)],
                 'new_child_identities':[{'role':'relayer','pid':99,'parent_pid':98,'os_start_token':'linux-ticks:123','executable':{'path':'/public-role','bytes':1,'sha256':'77'*32}}],
                 'private_env':'DO-NOT-EXPORT-ENVIRONMENT'}
        snapshot={'runtime_source_commit':'a'*40,'scenario':'cosmosnative','capture_count':6,'relayer_capture_ordinal':4,'verified':True,
                  'messages':[message],'deliverable_messages':[message],'per_id_lifecycle':[life],
                  'native_delivery_transactions':[{'chain':'test2','transaction_hash':tx,'proof':{'message_ids':[identity],'height':7,'signed':signed,'raw':'DO-NOT-EXPORT-RAW'}}],
                  'broadcasts':[{'chain':'test2','transaction_hash':tx,'monotonic_ns':first-1,'raw_transaction_sha256':'88'*32,'wire':'DO-NOT-EXPORT-BROADCAST'}],
                  'native_operations':[{'id':identity,'operation':operation}],
                  'stopped_canonical_Rust_readback':[{'origin':'test1','actual_Rust_output':{'reader':'actual production','origin_domain':1,'origin_nonce_count':1,'private':'DO-NOT-EXPORT-RAW-ORACLE'},
                    'verified_canonical_messages':[{'id':identity,'nonce':0,'processed':True,'payment':{'payment':'2','gas_amount':'3'},'spent':{'gas_used':'1','tokens_used':'2'},'gas_expenditure_record_present':True}]}],
                  'postgres':[{'id':identity,'verified':{'canonical_dispatch_rows':1,'canonical_delivery_rows':1,'payment_rows':1,'payment':2,'gas_amount':3,'leaf_indices':[0]},'raw_sql':'DO-NOT-EXPORT-SQL'}],
                  'family_native_row_proofs':[{'id':identity,'native_identity':tx,'independently_verified_signature':True,'retained_intent_fingerprint_verified':True,'signature':'DO-NOT-EXPORT-SIGNATURE'}],
                  'checkpoint_proofs':[{'metadata':{'git_sha':'a'*40,'allows_public_rpcs':False,'key':'DO-NOT-EXPORT-CHECKPOINT-KEY'},'verified_checkpoint_objects':[{'index':0,'root':'0x'+'99'*32,'message_id':identity,'signer':'0x'+'aa'*20,'signature':'DO-NOT-EXPORT-CHECKPOINT-SIGNATURE'}],'published_bytes':[]}],
                  'parent_wait_receipts':[{'role':'relayer','pid':99,'parent_pid':98,'os_start_token':'linux-ticks:123','purpose':'final','parent_wait_completed':True,'already_exited':False,'forced_kill':False,'success':True,'exit_code':0,'signal':None,'planned_exit':False,'executable':{'path':'/public-role','bytes':1,'sha256':'77'*32,'env':'DO-NOT-EXPORT-CHILD-ENV'},'env':'DO-NOT-EXPORT-PARENT-ENV'}],
                  'observer_policy':{'maximum_successful_domain_sample_gap_ns':10*10**9,'private_env':'DO-NOT-EXPORT-POLICY-ENV'},
                  'same_db_restart_observation':restart}
        restart.update(schema=2,clock_scope=api.RESTART_CLOCK_SCOPE,checker_deadline_scope=api.RESTART_DEADLINE_SCOPE,full_baseline_completed_monotonic_ns=start-50,checker_first_entry_monotonic_ns=start-10**9,checker_deadline_monotonic_ns=start+119*10**9,checker_result_monotonic_ns=start+30*10**9+10,full_baseline_phases={name:{'started_monotonic_ns':start-100+i*10,'finished_monotonic_ns':start-95+i*10}for i,name in enumerate(['restart_approval','restart_canonical','restart_identity','restart_checkpoints'])},readiness_targets=[{'role':'relayer','port':10001,'chains':['test2']},{'role':'validator','port':10002,'chains':['test1']}])
        for sample in restart['samples']:
            ns=sample['observed_monotonic_ns'];sample['actual_admin_readiness']=[{'role':'relayer','chain':'test2','port':10001,'request_started_monotonic_ns':ns-30,'response_received_monotonic_ns':ns-1,'operation_count':0},{'role':'validator','chain':None,'port':10002,'request_started_monotonic_ns':ns-30,'response_received_monotonic_ns':ns-1,'response_bytes':10,'response_sha256':'ac'*32}]
        restart['publication_live_check']={'observed_monotonic_ns':start+30*10**9,'epoch_sha256':restart['epoch_sha256'],'actual_admin_readiness':restart['samples'][-1]['actual_admin_readiness'],'role_rpc_activity':restart['samples'][-1]['role_rpc_activity'],'role_rpc_request_started_ns':restart['samples'][-1]['role_rpc_request_started_ns']}
        snapshot['full_final_proof_completed_monotonic_ns']=start+31*10**9;snapshot['full_final_proof_scope']=api.RESTART_FINAL_SCOPE
        return snapshot

    def public_record_files(self):
        case=self.root/'public-case';(case/'evidence').mkdir(parents=True);snapshot=self.public_snapshot_fixture()
        for name in ['initial','before-restart','after-restart','final-native']:
            # Native verifier's actual file naming has initial-native too.
            file={'initial':'verified-initial-native.jsonl','before-restart':'verified-before-restart.jsonl','after-restart':'verified-after-restart.jsonl','final-native':'verified-final-native.jsonl'}[name]
            (case/'evidence'/file).write_text(json.dumps(snapshot)+'\n')
        manifest={'runtime_source_commit':'a'*40,'scenario':'cosmosnative','mode':'ReleaseSafe','artifacts':{'relayer':{'path':'/public','bytes':1,'sha256':'bb'*32}}}
        plan={'execution_source_commit':'c'*40,'manifestArtifact':{'path':'/manifest-public','bytes':1,'sha256':'dd'*32},'harnessArtifact':{'path':'/helper-public','bytes':1,'sha256':'ee'*32}}
        return case,manifest,plan

    def test_public_projection_preserves_actual_clocks_and_excludes_private_fields(self):
        raw=self.public_snapshot_fixture();value=api.public_native_snapshot(raw);wire=json.dumps(value)
        self.assertNotIn('DO-NOT-EXPORT',wire)
        self.assertEqual(value['per_id_lifecycle'],raw['per_id_lifecycle'])
        self.assertEqual(value['family_native_row_proofs'][0]['independently_verified_signature'],True)
        self.assertEqual(value['postgres'][0]['verified']['canonical_delivery_rows'],1)
        self.assertEqual(value['checkpoint_proofs'][0]['verified_checkpoint_objects'][0]['signer'],'0x'+'aa'*20)
        self.assertEqual(value['same_db_restart_observation']['elapsed_live_ns'],30*10**9)
        expected={k:v for k,v in raw['parent_wait_receipts'][0].items()if k not in {'env','executable'}}
        expected['executable']={k:raw['parent_wait_receipts'][0]['executable'][k]for k in ('path','bytes','sha256')}
        self.assertEqual(value['parent_wait_receipts'],[expected])

    def test_public_parent_wait_projection_rejects_nested_or_unbounded_values(self):
        for key,value in [('role',{'raw':'PRIVATE'}),('pid',True),('parent_pid',0),('os_start_token',{'env':'PRIVATE'}),('os_start_token','x'*4097),('purpose',['PRIVATE']),('success',{'raw':'PRIVATE'}),('exit_code',{'env':'PRIVATE'}),('signal',True),('planned_exit',{'wire':'PRIVATE'}),('executable',{'path':{'env':'PRIVATE'},'bytes':1,'sha256':'ab'*32})]:
            raw=self.public_snapshot_fixture();raw['parent_wait_receipts'][0][key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):api.public_native_snapshot(raw)

    def test_public_acceptor_rejects_missing_bad_or_crossed_actual_role_waits(self):
        for change in ['missing','forced','not_waited','failed','foreign_child','duplicate']:
            case,manifest,plan=self.public_record_files();path=case/'evidence/verified-final-native.jsonl';raw=json.loads(path.read_text());wait=raw['parent_wait_receipts'][0]
            if change=='missing':raw.pop('parent_wait_receipts')
            elif change=='forced':wait['forced_kill']=True
            elif change=='not_waited':wait['parent_wait_completed']=False
            elif change=='failed':wait.update(success=False,exit_code=1)
            elif change=='foreign_child':wait['pid']=100
            else:raw['parent_wait_receipts'].append(copy.deepcopy(wait))
            path.write_text(json.dumps(raw)+'\n')
            with self.subTest(change=change),self.assertRaises(ValueError):api.write_public_native_proof(plan,manifest,case,self.root/(change+'.json'),api.pin(path))
            import shutil
            shutil.rmtree(case)

    def test_hash_matched_public_proof_is_deterministic_and_no_implicit_acceptance(self):
        case,manifest,plan=self.public_record_files();final=api.pin(case/'evidence/verified-final-native.jsonl')
        a=api.write_public_native_proof(plan,manifest,case,self.root/'public-a.json',final)
        b=api.write_public_native_proof(plan,manifest,case,self.root/'public-b.json',final)
        self.assertEqual(a['sha256'],b['sha256']);value=json.loads(Path(a['path']).read_text())
        self.assertEqual(value['raw_records']['final'],final)
        self.assertEqual(value['actual_timed_restart_ns'],30*10**9)
        self.assertFalse(value['native_or_performance_credit_from_projection_alone'])
        self.assertNotIn('DO-NOT-EXPORT',Path(a['path']).read_text())
        with self.assertRaises(ValueError):api.write_public_native_proof(plan,manifest,case,self.root/'public-a.json',final)

    def test_public_proof_rejects_early_retirement_stale_restart_or_changed_signed_identity(self):
        for change in ['retirement','stale','signed','legacy']:
            case,manifest,plan=self.public_record_files();path=case/'evidence/verified-final-native.jsonl';value=json.loads(path.read_text())
            if change=='retirement':value['per_id_lifecycle'][0]['retired_monotonic_ns']=value['per_id_lifecycle'][0]['first_positive_monotonic_ns']+599*10**9
            if change=='signed':value['native_operations'][0]['operation']['signed']['sha256']='0x'+'ff'*32
            path.write_text(json.dumps(value)+'\n')
            if change in ['stale','legacy']:
                target=case/'evidence/verified-after-restart.jsonl';after=json.loads(target.read_text())
                if change=='legacy':after.pop('same_db_restart_observation')
                else:after['same_db_restart_observation']['samples'][1]['role_rpc_activity']=after['same_db_restart_observation']['samples'][0]['role_rpc_activity']
                target.write_text(json.dumps(after)+'\n')
            with self.subTest(change=change),self.assertRaises(ValueError):api.write_public_native_proof(plan,manifest,case,self.root/(change+'.json'),api.pin(path))
            import shutil
            shutil.rmtree(case)

    def test_public_proof_rejects_changed_raw_final_hash(self):
        case,manifest,plan=self.public_record_files();path=case/'evidence/verified-final-native.jsonl';expected=api.pin(path);path.write_text(path.read_text()+'\n')
        with self.assertRaises(ValueError):api.write_public_native_proof(plan,manifest,case,self.root/'no.json',expected)

    def test_stark_public_fingerprints_do_not_publish_invoke_signature_or_calldata(self):
        raw=self.public_snapshot_fixture();raw['scenario']='starknet'
        raw['family_native_row_proofs']=[{'id':raw['messages'][0]['id'],'identity':raw['messages'][0]['delivery_transaction'],
            'account':'0x1','public_key':'0x2','account_nonce':'0x3','allocated_fee':7,'whole_fee':9,'rounding_dust':2,
            'context':'0x'+'ab'*32,'expected_context_checked':True,'configuration_authority_verified':False,
            'native_signed_wire':{'bytes':150,'sha256':'0x'+'ac'*32},'signature':['DO-NOT-EXPORT-SIGNATURE'],'calldata':['DO-NOT-EXPORT-CALLDATA']}]
        value=api.public_native_snapshot(raw);wire=json.dumps(value)
        self.assertNotIn('DO-NOT-EXPORT',wire)
        row=value['family_native_row_proofs'][0]
        self.assertFalse(row['configuration_authority_verified'])
        self.assertEqual(row['native_signed_wire_fingerprint']['bytes'],150)
        self.assertEqual(row['allocated_fee'],7)


    def test_actual_evm_cosmos_and_stark_SQL_DTO_shapes_preserve_verdicts_and_coordinates(self):
        metadata={'chain':'test1','domain':1,'transaction_hash':'0x'+'22'*32,'block_hash':'0x'+'33'*32,'block_number':7,'transaction_index':0,'log_index':1,'emitter':'0x'+'44'*32,'private':'DO-NOT-EXPORT-EVENT'}
        counts={'canonical_dispatch_rows':1,'canonical_delivery_rows':1,'payment_rows':0,'payment':0,'gas_amount':0,'leaf_indices':[0]}
        for family in ['evm','cosmosnative','cosmwasm','starknet']:
            raw=self.public_snapshot_fixture();raw['scenario']=family;identity=raw['messages'][0]['id']
            if family=='evm':row={'id':identity,'verified':dict(counts,canonical_event_coordinates=[{'kind':'dispatch','metadata':metadata}])}
            elif family=='starknet':row={'id':identity,'proof':counts,'canonical_event_rows':[{'kind':'dispatch','metadata':metadata,'exact_rows':1}],'payments_supported':False}
            else:row={'id':identity,'verified':counts,'canonical_event_coordinates':{'dispatch':[metadata]}}
            raw['postgres']=[row];projected=api.public_native_snapshot(raw)['postgres'][0]
            self.assertEqual(projected['proof'if family=='starknet'else'verified'],counts)
            self.assertEqual(projected['canonical_event_rows'][0]['metadata']['block_number'],7)
            self.assertNotIn('DO-NOT-EXPORT',json.dumps(projected))
            if family=='starknet':self.assertEqual(projected['canonical_event_rows'][0]['exact_rows'],1);self.assertFalse(projected['payments_supported'])

    def test_actual_native_family_readiness_public_fields_are_retained(self):
        for family in ['cosmosnative','starknet']:
            raw=self.public_snapshot_fixture();raw['scenario']=family
            if family=='starknet':readiness={'actual_native_dispatches':10,'actual_native_deliveries':10,'actual_publications':raw['checkpoint_proofs'],'production600_policy_unchanged':True}
            else:readiness={'actual_native_heads':{'test1':9,'test2':10},'actual_validator_publications':raw['checkpoint_proofs']}
            readiness['config']={'private_key':'DO-NOT-EXPORT-READINESS'};raw['same_db_restart_readiness']=readiness
            value=api.public_native_snapshot(raw)['same_db_restart_readiness'];self.assertNotIn('DO-NOT-EXPORT',json.dumps(value))
            if family=='starknet':self.assertEqual(value['actual_native_deliveries'],10);self.assertEqual(value['actual_publications'][0]['verified_checkpoint_objects'][0]['index'],0)
            else:self.assertEqual(value['actual_native_heads'],{'test1':9,'test2':10});self.assertEqual(len(value['actual_validator_publications']),1)


    def test_public_proof_rejects_old_response_even_after_new_capture(self):
        case,manifest,plan=self.public_record_files()
        for name in ['verified-after-restart.jsonl','verified-final-native.jsonl']:
            path=case/'evidence'/name;raw=json.loads(path.read_text());restart=raw['same_db_restart_observation'];first=restart['samples'][0];now=first['observed_monotonic_ns']
            restart['new_capture_last_monotonic_ns']=now-20*10**9;restart['new_capture_monotonic_ns_by_role_chain']={k:now-20*10**9 for k in first['role_rpc_activity']}
            first['role_rpc_activity']={k:now-11*10**9 for k in first['role_rpc_activity']};first['role_rpc_request_started_ns']={k:now-11*10**9-1 for k in first['role_rpc_activity']};path.write_text(json.dumps(raw)+'\n')
        with self.assertRaisesRegex(ValueError,'Invalid actual restarted'):api.write_public_native_proof(plan,manifest,case,case/'public.json',api.pin(case/'evidence/verified-final-native.jsonl'))
        self.assertFalse((case/'public.json').exists())

    def test_schema2_public_scope_boundaries_and_each_actual_role_are_mandatory(self):
        changes=['legacy','dropped_role','old_publication_request','publication_gap','baseline_after_anchor','wrong_admin_target','private_admin','phase_after_baseline','missing_final_proof']
        for change in changes:
            case,manifest,plan=self.public_record_files()
            for name in ['verified-after-restart.jsonl','verified-final-native.jsonl']:
                path=case/'evidence'/name;raw=json.loads(path.read_text());proof=raw['same_db_restart_observation']
                if change=='legacy':proof['schema']=1
                elif change=='dropped_role':
                    for row in proof['samples']:
                        row['role_rpc_activity'].pop('validator:test1');row['role_rpc_request_started_ns'].pop('validator:test1')
                elif change=='old_publication_request':proof['publication_live_check']['role_rpc_request_started_ns']['validator:test1']=1
                elif change=='publication_gap':
                    now=proof['samples'][-1]['observed_monotonic_ns']+11*10**9;check=proof['publication_live_check'];check['observed_monotonic_ns']=now;proof['checker_result_monotonic_ns']=now+1
                    check['role_rpc_activity']={k:now-1 for k in check['role_rpc_activity']};check['role_rpc_request_started_ns']={k:now-2 for k in check['role_rpc_request_started_ns']}
                    for row in check['actual_admin_readiness']:row.update(request_started_monotonic_ns=now-2,response_received_monotonic_ns=now-1)
                    raw['full_final_proof_completed_monotonic_ns']=now+2
                elif change=='baseline_after_anchor':proof['full_baseline_completed_monotonic_ns']=proof['samples'][0]['observed_monotonic_ns']+1
                elif change=='wrong_admin_target':proof['samples'][0]['actual_admin_readiness'][0]['port']=1
                elif change=='private_admin':proof['samples'][0]['actual_admin_readiness'][0]['raw_config']='DO-NOT-EXPORT'
                elif change=='phase_after_baseline':proof['full_baseline_phases']['restart_canonical']['finished_monotonic_ns']=proof['full_baseline_completed_monotonic_ns']+1
                elif change=='missing_final_proof':raw.pop('full_final_proof_completed_monotonic_ns')
                path.write_text(json.dumps(raw)+'\n')
            target=self.root/(change+'-rejected.json')
            with self.subTest(change=change),self.assertRaises(ValueError):api.write_public_native_proof(plan,manifest,case,target,api.pin(case/'evidence/verified-final-native.jsonl'))
            self.assertFalse(target.exists())
            import shutil
            shutil.rmtree(case)

    def test_initial_phase_cannot_smuggle_nested_final_clock_or_scope(self):
        for key in ['full_final_proof_completed_monotonic_ns','full_final_proof_scope']:
            case,manifest,plan=self.public_record_files();path=case/'evidence/verified-initial-native.jsonl';raw=json.loads(path.read_text());raw[key]={'raw_signed_wire':'DO-NOT-EXPORT-PRIVATE'};path.write_text(json.dumps(raw)+'\n');output=self.root/(key+'-rejected.json')
            with self.subTest(key=key),self.assertRaises(ValueError):api.write_public_native_proof(plan,manifest,case,output,api.pin(case/'evidence/verified-final-native.jsonl'))
            self.assertFalse(output.exists())
            import shutil
            shutil.rmtree(case)

    def test_initial_schema2_nested_subphase_or_publication_clocks_never_export(self):
        for kind in ['subphase','publication_clock','publication_epoch','publication_rpc','sample_request']:
            case,manifest,plan=self.public_record_files();path=case/'evidence/verified-initial-native.jsonl';raw=json.loads(path.read_text());proof=raw['same_db_restart_observation'];private={'raw_signed_wire':'DO-NOT-EXPORT-PRIVATE'}
            if kind=='subphase':proof['full_baseline_phases']['restart_canonical']['started_monotonic_ns']=private
            elif kind=='publication_clock':proof['publication_live_check']['observed_monotonic_ns']=private
            elif kind=='publication_epoch':proof['publication_live_check']['epoch_sha256']=private
            elif kind=='publication_rpc':proof['publication_live_check']['role_rpc_activity']['validator:test1']=private
            elif kind=='sample_request':proof['samples'][0]['role_rpc_request_started_ns']['validator:test1']=private
            path.write_text(json.dumps(raw)+'\n');output=self.root/(kind+'-rejected.json')
            with self.subTest(kind=kind),self.assertRaises(ValueError):api.write_public_native_proof(plan,manifest,case,output,api.pin(case/'evidence/verified-final-native.jsonl'))
            self.assertFalse(output.exists())
            import shutil
            shutil.rmtree(case)

    def test_initial_observed_clock_never_exports_nested_values_in_any_schema(self):
        for schema in [1,2]:
            case,manifest,plan=self.public_record_files();path=case/'evidence/verified-initial-native.jsonl';raw=json.loads(path.read_text());raw['same_db_restart_observation']['schema']=schema;raw['same_db_restart_observation']['samples'][0]['observed_monotonic_ns']={'raw_signed_wire':'DO-NOT-EXPORT-PRIVATE'};path.write_text(json.dumps(raw)+'\n');output=self.root/('observed-'+str(schema)+'-rejected.json')
            with self.subTest(schema=schema),self.assertRaisesRegex(ValueError,'observed clock'):api.write_public_native_proof(plan,manifest,case,output,api.pin(case/'evidence/verified-final-native.jsonl'))
            self.assertFalse(output.exists())
            import shutil
            shutil.rmtree(case)

    def public_diagnostic_fixture(self):
        spec=importlib.util.spec_from_file_location('public_diag_fixture',Path(__file__).resolve().parents[1]/'integration/multivm_diagnostics.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        case=self.root/'diagnostic-case';(case/'evidence').mkdir(parents=True);out=self.root/'diagnostic-output';out.mkdir();source=Path(module.__file__);approval={'python_modules':{'multivm_diagnostics.py':api.pin(source)}}
        recorder=module.Recorder(case/'evidence/public-observer-diagnostics.json',approval['python_modules'],source.parent)
        state={'observed_monotonic_ns':100,'restart_sample_count':0,'restart_failed':False,'restart_first_observed_ns':None,'restart_last_observed_ns':None,'role_activity':[],'observer_failure_count':0,'lifecycle_error_count':0}
        token=recorder.enter('after_restart',state)
        return case,out,approval,module,recorder,token,state
    def test_public_inflight_snapshot_retains_no_raw_message_and_final_state_separately(self):
        case,out,approval,module,recorder,token,state=self.public_diagnostic_fixture();before=api.snapshot_public_diagnostics(case,approval,out,'before.json');self.assertEqual(json.loads(Path(before['artifact']['path']).read_text())['last_stage']['status'],'inflight')
        recorder.finish(token,dict(state,observed_monotonic_ns=120),'exception',ValueError('DO-NOT-EXPORT-RAW-WIRE'))
        after=api.snapshot_public_diagnostics(case,approval,out,'after.json');self.assertEqual(json.loads(Path(after['artifact']['path']).read_text())['last_stage']['status'],'exception');self.assertNotIn('DO-NOT-EXPORT',Path(after['artifact']['path']).read_text());self.assertEqual(json.loads(Path(before['artifact']['path']).read_text())['last_stage']['status'],'inflight')
    def test_unknown_or_duplicate_public_diagnostic_fields_never_copied(self):
        case,out,approval,*_=self.public_diagnostic_fixture();path=case/'evidence/public-observer-diagnostics.json';wire=path.read_text();path.write_text('{"scope":"PRIVATE-EARLIER-VALUE",'+wire[1:])
        with self.assertRaisesRegex(ValueError,'Duplicate'):api.snapshot_public_diagnostics(case,approval,out,'duplicate.json')
        self.assertFalse((out/'duplicate.json').exists());value=json.loads(wire);value['private_wire']='PRIVATE';path.write_text(json.dumps(value))
        with self.assertRaises(ValueError):api.snapshot_public_diagnostics(case,approval,out,'unknown.json')
        self.assertFalse((out/'unknown.json').exists())
    def test_public_failure_retention_has_only_phase_pins_waits_and_no_credit(self):
        case,out,approval,module,recorder,token,state=self.public_diagnostic_fixture();(out/'harness.log').write_text('PRIVATE-HARNESS-BODY\n');result={'direct_waits':[{'role':'harness','pid':10,'actual_parent_wait':True,'exit_code':101,'observed_monotonic_ns':150,'raw':'PRIVATE'}]};manifest={'runtime_source_commit':'a'*40,'scenario':'cosmosnative','mode':'ReleaseSafe'};plan={'execution_source_commit':'b'*40,'diagnostic_rust_sources':{}}
        observed=api.write_public_failure_diagnostics(plan,manifest,approval,case,out,result,90);value=json.loads(Path(observed['path']).read_text());self.assertFalse(value['native_or_timing_credit']);self.assertEqual(value['actual_direct_parent_waits'][0]['exit_code'],101);self.assertEqual(value['worker_started_monotonic_ns'],90);self.assertEqual(value['rust_panic_source_locations'],[]);self.assertNotIn('PRIVATE',json.dumps(value));self.assertTrue((out/'public-observer-diagnostics.json').is_file())

    def test_observer_transport_failure_cannot_hide_actual_pinned_Rust_panic_site(self):
        case,out,approval,module,recorder,token,state=self.public_diagnostic_fixture()
        recorder.finish(token,{**state,'observed_monotonic_ns':120},'exception',ConnectionRefusedError('DO-NOT-EXPORT-UPSTREAM-ENDPOINT'))
        repo=self.root/'panic-repo';relative='rust/main/utils/run-locally/src/main.rs';source=repo/relative;source.parent.mkdir(parents=True);source.write_text('line1\nline2\nline3\n')
        (out/'harness.log').write_text("thread 'DO-NOT-EXPORT-THREAD' (42) panicked at /build/"+relative+":2:1:\nDO-NOT-EXPORT-PANIC-KEY-ARGV-ENV\n")
        manifest={'runtime_source_commit':'a'*40,'scenario':'evm','mode':'ReleaseSafe'};plan={'execution_source_commit':'b'*40,'diagnostic_rust_sources':{relative:api.pin(source)}};result={'direct_waits':[{'role':'harness','pid':42,'actual_parent_wait':True,'exit_code':101}]}
        with mock.patch.object(api,'__file__',str(repo/'zig/bench/native_case_owner.py')):
            record=api.write_public_failure_diagnostics(plan,manifest,approval,case,out,result,90)
        value=json.loads(Path(record['path']).read_text());sites=value['rust_panic_source_locations'];self.assertEqual(len(sites),1);self.assertEqual(sites[0],{'module':relative,'source':api.pin(source),'line':2,'column':1});observer=json.loads(Path(value['observer_after_stop']['artifact']['path']).read_text());self.assertTrue(observer['failures']);self.assertFalse(value['native_or_timing_credit']);self.assertNotIn('DO-NOT-EXPORT',json.dumps(value));self.assertNotIn('DO-NOT-EXPORT',json.dumps(observer));self.assertEqual(value['actual_direct_parent_waits'],result['direct_waits']);self.assertEqual(set(sites[0]),{'module','source','line','column'})

    def test_failed_case_projects_only_source_bound_reason_enums_and_same_captured_log_hash(self):
        case,out,approval,module,recorder,token,state=self.public_diagnostic_fixture();recorder.finish(token,{**state,'observed_monotonic_ns':120},'exception',ConnectionRefusedError('DO-NOT-EXPORT-OBSERVER'))
        repo=self.root/'reason-repo';helper=repo/'rust/main/utils/run-locally/src/external_agents.rs';helper.parent.mkdir(parents=True)
        helper.write_text('pub fn svm_tempfile() -> Result<tempfile::NamedTempFile> {\ncreate_owned_directory(&manifest.task_root, Path::new("tmp"))?;\ntempfile::NamedTempFile::new_in(root)?;\n"symlink in owned writable path: {}"\n"owned parent is not a directory"\n}\n')
        caller=repo/'rust/main/utils/run-locally/src/sealevel/warp_route_composite_ism.rs';caller.parent.mkdir();caller.write_text('line1\ncrate::external_agents::svm_tempfile().expect("Failed to create temp ISM config");\n')
        log=out/'harness.log';log.write_text("thread 'DO-NOT-EXPORT-THREAD' (42) panicked at utils/run-locally/src/sealevel/warp_route_composite_ism.rs:2:1:\nFailed to create temp ISM config: Permission denied: DO-NOT-EXPORT-KEY-ARGV-ENV\n")
        manifest={'runtime_source_commit':'a'*40,'scenario':'sealevel-composite','mode':'ReleaseSafe'};plan={'execution_source_commit':'b'*40,'diagnostic_rust_sources':{str(p.relative_to(repo)):api.pin(p)for p in [helper,caller]}};result={'direct_waits':[{'role':'harness','pid':42,'actual_parent_wait':True,'exit_code':101}]}
        with mock.patch.object(api,'__file__',str(repo/'zig/bench/native_case_owner.py')):
            record=api.write_public_failure_diagnostics(plan,manifest,approval,case,out,result,90)
        value=json.loads(Path(record['path']).read_text());self.assertEqual(value['rust_panic_reason_codes'],['IO_PERMISSION_DENIED']);self.assertEqual(value['rust_panic_reason_source'],{'module':str(helper.relative_to(repo)),'source':api.pin(helper),'owned_path_guard_literals_verified':True,'tempfile_directory_and_file_calls_verified':True});self.assertEqual(value['harness_log_fingerprint'],api.pin(log));self.assertEqual(value['rust_panic_source_locations'][0]['source'],api.pin(caller));self.assertTrue(json.loads(Path(value['observer_after_stop']['artifact']['path']).read_text())['failures']);self.assertNotIn('DO-NOT-EXPORT',json.dumps(value));self.assertFalse(value['native_or_timing_credit'])

    def test_coexisting_observer_error_cannot_authorize_changed_or_foreign_Rust_Source(self):
        case,out,approval,module,recorder,token,state=self.public_diagnostic_fixture();recorder.finish(token,{**state,'observed_monotonic_ns':120},'exception',RuntimeError('DO-NOT-EXPORT-OBSERVER'))
        repo=self.root/'panic-repo';relative='rust/main/utils/run-locally/src/main.rs';source=repo/relative;source.parent.mkdir(parents=True);source.write_text('line1\nline2\n');expected=api.pin(source);source.write_text('changed1\nchanged2\n')
        (out/'harness.log').write_text("thread 'DO-NOT-EXPORT-THREAD' panicked at /build/"+relative+":2:1:\nDO-NOT-EXPORT-KEY\nthread 'other' panicked at /outside/foreign.rs:1:1:\n")
        manifest={'runtime_source_commit':'a'*40,'scenario':'evm','mode':'ReleaseFast'};plan={'execution_source_commit':'b'*40,'diagnostic_rust_sources':{relative:expected}};result={'direct_waits':[{'role':'harness','pid':42,'actual_parent_wait':True,'exit_code':101}]}
        with mock.patch.object(api,'__file__',str(repo/'zig/bench/native_case_owner.py')):
            record=api.write_public_failure_diagnostics(plan,manifest,approval,case,out,result,90)
        value=json.loads(Path(record['path']).read_text());self.assertEqual(value['rust_panic_source_locations'],[]);self.assertTrue(json.loads(Path(value['observer_after_stop']['artifact']['path']).read_text())['failures']);self.assertNotIn('DO-NOT-EXPORT',json.dumps(value));self.assertNotIn('/outside/',json.dumps(value));self.assertFalse(value['native_or_timing_credit'])

    def test_actual_failure_writer_retains_startup_frames_after_wait_without_harness(self):
        case=self.root/'startup-case';case.mkdir();out=self.root/'startup-out';out.mkdir();directory=self.root/'integration';directory.mkdir();entry=directory/'multivm_process.py';entry.write_text('line1\nline2\n');source=directory/'multivm_startup_control.py';source.write_text('line1\nline2\n');diag=Path(__file__).resolve().parents[1]/'integration/multivm_diagnostics.py';approval={'python_modules':{'multivm_diagnostics.py':api.pin(diag),source.name:api.pin(source)}}
        (out/'observer.log').write_text('Traceback (most recent call last):\n  File "'+str(source)+'", line 2, in startup\n    PRIVATE-CODE\nValueError: PRIVATE-WIRE-ENV\n');(out/'harness.log').write_bytes(b'')
        manifest={'runtime_source_commit':'a'*40,'scenario':'starknet','mode':'ReleaseSafe','verifier':{'script':api.pin(entry)}};plan={'execution_source_commit':'b'*40};result={'direct_waits':[{'role':'observer','pid':42,'actual_parent_wait':True,'exit_code':1}]}
        row=api.write_public_failure_diagnostics(plan,manifest,approval,case,out,result,90);value=json.loads(Path(row['path']).read_text());startup=value['observer_startup_source_traceback'];self.assertEqual(startup['frames'][0]['module'],source.name);self.assertEqual(startup['frames'][0]['line'],2);self.assertFalse(startup['native_or_timing_credit']);self.assertNotIn('PRIVATE',json.dumps(value));self.assertEqual(value['actual_direct_parent_waits'],result['direct_waits']);self.assertEqual(value['harness_log_fingerprint']['bytes'],0)
    def test_startup_projection_requires_actual_failed_observer_wait_and_no_harness(self):
        case=self.root/'startup-case';case.mkdir();approval={};manifest={'runtime_source_commit':'a'*40,'scenario':'starknet','mode':'ReleaseSafe'};plan={'execution_source_commit':'b'*40}
        for number,waits in enumerate(([{'role':'observer','actual_parent_wait':True,'exit_code':0}],[{'role':'observer','actual_parent_wait':False,'exit_code':1}],[{'role':'observer','actual_parent_wait':True,'exit_code':True}],[{'role':'observer','actual_parent_wait':True,'exit_code':1},{'role':'harness','actual_parent_wait':True,'exit_code':101}])):
            out=self.root/('negative-startup-'+str(number));out.mkdir();(out/'observer.log').write_text('PRIVATE')
            with mock.patch.object(api,'diagnostic_module',side_effect=AssertionError('No startup authority')):
                row=api.write_public_failure_diagnostics(plan,manifest,approval,case,out,{'direct_waits':waits},90)
            self.assertIsNone(json.loads(Path(row['path']).read_text())['observer_startup_source_traceback'])

class StarknetProgressTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='stark-progress-pure-')
        self.addCleanup(self.temp.cleanup); self.root = Path(self.temp.name)
        self.plan = {'diagnostic_rust_sources': {}, 'execution_source_commit': 'a'*40}
        for suffix, needles in api.StarknetProgress.SOURCE_NEEDLES.items():
            name = api.StarknetProgress.ROOT + suffix
            path = self.root/name; path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('\n'.join(needles)); self.plan['diagnostic_rust_sources'][name] = api.pin(path)
        self.cli = self.root/'fixture-tools/starkli'; self.cli.parent.mkdir(); self.cli.write_bytes(b'public-fake-not-executed'); self.cli.chmod(0o700)
        self.manifest = {'tool_overrides': {'E2E_STARKLI_CLI_PATH': api.pin(self.cli)}, 'runtime_source_commit': 'b'*40, 'mode': 'ReleaseSafe'}
        self.progress = api.StarknetProgress(self.plan, self.manifest, self.root)
        self.log = self.root/'harness.log'; self.output = self.root/'public.json'
        self.owned = {42: {'pid': 42, 'ppid': 30, 'start': 'linux-ticks:999', 'state': 'S', 'comm': 'starkli', 'argv': 'PRIVATE-KEY', 'env': {'PRIVATE': 'SECRET'}}}
        self.now = 100

    def observe(self, wire=None):
        if wire is not None:
            with self.log.open('ab') as stream: stream.write(wire)
        self.now += 10
        return self.progress.observe(self.log, self.now, self.owned, self.output)

    def test_source_and_tool_pins_are_checked_not_merely_claimed(self):
        self.cli.write_bytes(b'changed')
        with self.assertRaises(ValueError): api.StarknetProgress(self.plan, self.manifest, self.root)

    def test_source_marker_policy_refuses_changed_current_source(self):
        path=self.root/api.StarknetProgress.ROOT/'logging.rs'; path.write_text('wrong source')
        self.plan['diagnostic_rust_sources'][api.StarknetProgress.ROOT+'logging.rs']=api.pin(path)
        with self.assertRaisesRegex(ValueError,'marker changed'): api.StarknetProgress(self.plan,self.manifest,self.root)

    def test_wrong_source_path_is_rejected_even_when_same_bytes(self):
        name=next(iter(self.plan['diagnostic_rust_sources'])); duplicate=self.root/'wrong.rs';duplicate.write_bytes(Path(self.plan['diagnostic_rust_sources'][name]['path']).read_bytes());self.plan['diagnostic_rust_sources'][name]=api.pin(duplicate)
        with self.assertRaisesRegex(ValueError,'path differs'):api.StarknetProgress(self.plan,self.manifest,self.root)

    def test_attempt_and_return_are_separate_and_do_not_publish_arguments(self):
        wire=self.progress.attempt_prefix+b'0xabc dispatch PRIVATE-BODY --private-key PRIVATE-KEY\n'
        row=self.observe(wire)
        self.assertEqual(row['dispatch_attempt_marker_count'],1);self.assertEqual(row['dispatch_return_marker_count'],0)
        row=self.observe(b'send-tx result: ["PRIVATE-TX-HASH", "ERROR: SECRET"]\n')
        self.assertEqual(row['dispatch_return_marker_count'],1)
        self.assertNotIn('PRIVATE',self.output.read_text());self.assertNotIn('SECRET',self.output.read_text());self.assertNotIn('exit_code',row['events']['dispatch_command_returned'])

    def test_wrong_tool_function_cwd_and_child_prefixed_marker_reject(self):
        prefix=self.progress.attempt_prefix
        for wire in [prefix.replace(b'(../../)',b'(/foreign)')+b'0xabc dispatch x\n',prefix.replace(bytes(self.cli),b'/foreign/starkli')+b'0xabc dispatch x\n',prefix+b'0xabc other x\n',b'<starkli> send-tx result: []\n',b'<relayer> <E2E> E2E tests passed\n',b' x<E2E> Init postgres db...\n']:
            row=self.observe(wire);self.assertEqual(row['events'],{})

    def test_dispatch_batch_is_exact_fixed_source_direction(self):
        self.assertEqual(self.observe(b'DISPATCHING MAILBOX: 23448594 -> [23448593]\n')['events'],{})
        row=self.observe(b'DISPATCHING MAILBOX: 23448593 -> [23448594]\n')
        self.assertEqual(row['events']['dispatch_batch_entered']['count'],1)

    def test_chunk_boundaries_and_offsets_never_double_count(self):
        first=b'<E2E> Init postgres db...\n';self.progress.READ_BYTES=5
        self.log.write_bytes(first)
        for _ in range(20):row=self.observe()
        self.assertEqual(row['events']['postgres_init_requested']['count'],1)
        self.assertEqual(row['events']['postgres_init_requested']['latest']['line_start_offset'],0)
        self.assertEqual(row['events']['postgres_init_requested']['latest']['line_end_offset'],len(first))
        self.assertEqual(row['scanned_prefix_sha256'],hashlib.sha256(first).hexdigest())

    def test_incomplete_line_is_pending_not_observed_until_newline(self):
        row=self.observe(b'<E2E> Init postgres db...');self.assertEqual(row['events'],{})
        row=self.observe(b'\n');self.assertEqual(row['events']['postgres_init_requested']['count'],1)

    def test_overlong_line_cannot_forge_its_suffix_as_new_marker(self):
        self.progress.LINE_BYTES=32
        row=self.observe(b'x'*33+b'<E2E> Init postgres db...\n<E2E> Init postgres db...\n')
        self.assertEqual(row['overlong_lines_discarded'],1);self.assertEqual(row['events']['postgres_init_requested']['count'],1)

    def test_scanning_has_per_read_and_whole_lifetime_caps(self):
        self.progress.READ_BYTES=8;self.progress.MAX_SCAN=16
        self.log.write_bytes(b'x'*100)
        row=self.observe();self.assertEqual(row['scanned_bytes'],8);self.assertEqual(row['scan_status'],'backlog')
        row=self.observe();self.assertEqual(row['scanned_bytes'],16);self.assertEqual(row['scan_status'],'scan_cap_reached')
        row=self.observe();self.assertEqual(row['scanned_bytes'],16)

    def test_old_log_cannot_be_replaced_truncated_or_symlinked(self):
        self.observe(b'<E2E> Init postgres db...\n');self.log.rename(self.root/'old-inode');self.log.write_bytes(b'x'*50)
        with self.assertRaisesRegex(ValueError,'replaced'):self.observe()

    def test_truncated_log_refuses_without_resetting_counts(self):
        self.observe(b'<E2E> Init postgres db...\n');self.log.write_bytes(b'')
        with self.assertRaisesRegex(ValueError,'truncated'):self.observe()
        self.assertEqual(self.progress.events['postgres_init_requested']['count'],1)

    def test_symlink_is_never_followed(self):
        other=self.root/'raw';other.write_bytes(b'PRIVATE');self.log.symlink_to(other)
        with self.assertRaises(OSError):self.observe()
        self.assertFalse(self.output.exists())

    def test_initial_missing_log_and_monotonic_observation_clock(self):
        row=self.observe();self.assertEqual(row['scan_status'],'log_not_created')
        with self.assertRaisesRegex(ValueError,'clock'):self.progress.observe(self.log,self.now-1,self.owned,self.output)

    def test_public_owned_census_is_typed_bounded_and_never_claims_authority(self):
        self.owned={k:{**self.owned[42],'pid':k,'comm':'PRIVATE_EXECUTABLE'}for k in range(1,71)}
        row=self.observe();self.assertEqual(len(row['owned_census']),64);self.assertEqual(row['owned_census_total'],70);self.assertTrue(row['owned_census_truncated'])
        self.assertTrue(all(r['executable_kind']=='other'for r in row['owned_census']));self.assertNotIn('PRIVATE',self.output.read_text());self.assertNotIn('env',row['owned_census'][0])

    def test_diagnostic_error_is_closed_and_cannot_change_business_verdict(self):
        result={'passed':False,'native_case_acceptance':False}
        with mock.patch.object(self.progress,'observe',side_effect=ValueError('PRIVATE-WIRE')):
            api.observe_stark_progress(self.progress,self.log,self.owned,self.output,result)
        self.assertTrue(self.progress.disabled);self.assertFalse(result['passed']);self.assertNotIn('PRIVATE',json.dumps(result))
        with mock.patch.object(self.progress,'observe',side_effect=AssertionError('must stay disabled')):
            api.observe_stark_progress(self.progress,self.log,self.owned,self.output,result)

    def test_stage_markers_and_metrics_are_not_inferred_from_child_census(self):
        row=self.observe(b'<E2E> Relayer confirmed 0 submitted messages, expected 10\n<E2E> Scraper has scraped 9 dispatched messages, expected 10\n<E2E> Scraper has scraped 0 delivered messages, expected 10\n')
        self.assertEqual(set(row['events']),{'confirmed_metric_observed','dispatch_metric_observed','delivery_metric_observed'})
        self.assertNotIn('dispatch_command_returned',row['events']);self.assertNotIn('passed',row)

    def test_confirmed_metric_values_are_actual_bounded_integers(self):
        row=self.observe(b'<E2E> Relayer confirmed 0 submitted messages, expected 10\n')
        first=row['events']['confirmed_metric_observed']['first']
        self.assertEqual((first['confirmed_count'],first['expected_count'],first['metric_values_status']),(0,10,'observed_u32'))
        row=self.observe(b'<E2E> Relayer confirmed 9 submitted messages, expected 11\n')
        event=row['events']['confirmed_metric_observed']
        self.assertEqual(event['first'],first)
        self.assertEqual((event['latest']['confirmed_count'],event['latest']['expected_count']),(9,11))
        self.assertNotIn('passed',row)

    def test_out_of_range_metric_is_observed_without_exporting_raw_values(self):
        for observed,expected in [(b'4294967296',b'10'),(b'1',b'9'*100),(b'9'*100,b'10')]:
            row=self.observe(b'<E2E> Relayer confirmed '+observed+b' submitted messages, expected '+expected+b'\n')
            latest=row['events']['confirmed_metric_observed']['latest']
            self.assertEqual(latest['metric_values_status'],'outside_u32')
            self.assertNotIn('confirmed_count',latest);self.assertNotIn('expected_count',latest)
        row=self.observe(b'<E2E> Relayer confirmed 4294967295 submitted messages, expected 4294967295\n')
        self.assertEqual(row['events']['confirmed_metric_observed']['latest']['confirmed_count'],4294967295)

    def test_first_latest_observations_offsets_are_not_invented_emission_times(self):
        wire=b'<E2E> Init postgres db...\n';first=self.observe(wire);start=first['events']['postgres_init_requested']['first'].copy();row=self.observe(wire)
        event=row['events']['postgres_init_requested'];self.assertEqual(event['count'],2);self.assertEqual(event['first'],start);self.assertGreater(event['latest']['observed_monotonic_ns'],start['observed_monotonic_ns']);self.assertEqual(event['latest']['line_start_offset'],len(wire))


if __name__=='__main__':unittest.main()
