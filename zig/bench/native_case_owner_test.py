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
        plan={'schema':1,'root_approved':True,'scenario':'evm','manifestArtifact':api.pin(manifest),'harnessArtifact':api.pin(script),'harness_argv':[str(script)],'harness_cwd':str(self.root),'lsofArtifact':api.pin(script),'required_inputs':[api.pin(script),api.pin(Path(api.__file__).resolve()),api.pin(Path(api.owner.__file__).resolve())],'explicit_environment':{'PATH':'/usr/bin:/bin','DOCKER_HOST':docker['host'],'DOCKER_CONFIG':docker['config_dir'],'NATIVE_TEST_MARKER':str(self.root/'marker.json')},'maximum_owned_RAM_bytes':8*api.GIB,'maximum_case_allocated_bytes':8*api.GIB,'minimum_host_free_bytes':6*api.GIB,'maximum_wall_seconds':3600,'confirm_seconds':600,'grace_seconds':30,'clean_fixture_parent_waits_required':3}
        path=self.root/'plan.json';path.write_text(json.dumps(plan));return path

    def test_closed_plan_requires_approved_bounds_exact_invocation_and_code_pins(self):
        path=self.bootstrap_plan();original=json.loads(path.read_text())
        self.assertEqual(api.load_plan(path,api.pin(path)['sha256'])[0]['scenario'],'evm')
        for mutate in [lambda p:p.update(root_approved=False),lambda p:p.update(maximum_wall_seconds=3601),lambda p:p.update(maximum_case_allocated_bytes=4*api.GIB),lambda p:p.update(maximum_case_allocated_bytes=9*api.GIB),lambda p:p.update(harness_argv=[p['harness_argv'][0],'arbitrary']),lambda p:p['required_inputs'].pop(),lambda p:p['explicit_environment'].update(GH_TOKEN='not-a-real-token')]:
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

    def test_actual_SVM_failure_publisher_calls_closed_projection_and_preserves_primary(self):
        from types import SimpleNamespace
        for fail in [False,True]:
            case=self.root/('role-case-'+str(fail));case.mkdir();out=case/'worker';out.mkdir()
            primary={'type':'RuntimeError','message':'PRIVATE_PRIMARY'}
            result={'error':primary,'direct_waits':[{'role':'harness','pid':42,'actual_parent_wait':True,'exit_code':101,'observed_monotonic_ns':100},{'role':'harness-cleanup','pid':42,'actual_parent_wait':True,'exit_code':101,'observed_monotonic_ns':101}]}
            projected={'schema':1,'roles':[],'native_or_timing_or_cleanup_authority':False}
            module=SimpleNamespace(role_failure_observation=mock.Mock(side_effect=RuntimeError('PRIVATE_DIAGNOSTIC')if fail else None,return_value=projected))
            manifest={'scenario':'sealevel','mode':'ReleaseSafe','runtime_source_commit':'a'*40};plan={'execution_source_commit':'b'*40,'diagnostic_rust_sources':{},'diagnostic_zig_sources':{'zig/src/fake.zig':{'path':'/data-only/fake.zig','bytes':1,'sha256':'d'*64}}}
            with mock.patch.object(api,'snapshot_public_diagnostics',return_value=None),mock.patch.object(api,'diagnostic_module',return_value=module):
                row=api.write_public_failure_diagnostics(plan,manifest,{},case,out,result,90)
            public=json.loads(Path(row['path']).read_bytes());module.role_failure_observation.assert_called_once();self.assertEqual(module.role_failure_observation.call_args.args[2],42);self.assertEqual(module.role_failure_observation.call_args.args[6],plan['diagnostic_zig_sources'])
            self.assertEqual(public['SVM_role_failure'],{'collection_status':'unavailable','native_or_timing_or_cleanup_authority':False}if fail else projected)
            self.assertIs(result['error'],primary);self.assertEqual(result['direct_waits'][0]['exit_code'],101);self.assertNotIn('PRIVATE',json.dumps(public));self.assertFalse(public['native_or_timing_credit'])

    def test_ambiguous_helper_pid_cannot_mint_role_exit_attribution(self):
        from types import SimpleNamespace
        case=self.root/'ambiguous-role-case';case.mkdir();out=case/'worker';out.mkdir();result={'direct_waits':[{'role':'harness','pid':42,'actual_parent_wait':True,'exit_code':101},{'role':'harness-cleanup','pid':43,'actual_parent_wait':True,'exit_code':101}]}
        module=SimpleNamespace(role_failure_observation=mock.Mock(side_effect=AssertionError('Must not infer parent PID')))
        with mock.patch.object(api,'snapshot_public_diagnostics',return_value=None),mock.patch.object(api,'diagnostic_module',return_value=module):
            row=api.write_public_failure_diagnostics({'execution_source_commit':'b'*40,'diagnostic_rust_sources':{}},{'scenario':'sealevel-composite','mode':'ReleaseSafe','runtime_source_commit':'a'*40},{},case,out,result,90)
        module.role_failure_observation.assert_not_called();self.assertEqual(json.loads(Path(row['path']).read_bytes())['SVM_role_failure']['collection_status'],'unavailable')


    def test_actual_fixture_failure_publisher_preserves_primary_and_uses_one_actual_parent(self):
        from types import SimpleNamespace
        for scenario in ['radix','tron']:
            for fail in [False,True]:
                case=self.root/('fixture-case-'+scenario+str(fail));case.mkdir();out=case/'worker';out.mkdir();primary={'type':'RuntimeError','message':'PRIVATE_PRIMARY'}
                result={'error':primary,'direct_waits':[{'role':'harness','pid':42,'actual_parent_wait':True,'exit_code':101},{'role':'harness-cleanup','pid':42,'actual_parent_wait':True,'exit_code':101}]};projected={'schema':1,'panic_observations':[],'native_or_timing_or_cleanup_authority':False};module=SimpleNamespace(fixture_failure_observation=mock.Mock(side_effect=RuntimeError('PRIVATE_DIAGNOSTIC')if fail else None,return_value=projected))
                manifest={'scenario':scenario,'mode':'ReleaseSafe','runtime_source_commit':'a'*40};plan={'execution_source_commit':'b'*40,'diagnostic_rust_sources':{}}
                with mock.patch.object(api,'snapshot_public_diagnostics',return_value=None),mock.patch.object(api,'diagnostic_module',return_value=module):row=api.write_public_failure_diagnostics(plan,manifest,{},case,out,result,90)
                value=json.loads(Path(row['path']).read_bytes());module.fixture_failure_observation.assert_called_once();self.assertEqual(module.fixture_failure_observation.call_args.args[3],42);self.assertEqual(value['fixture_failure'],{'collection_status':'unavailable','native_or_timing_or_cleanup_authority':False}if fail else projected);self.assertIs(result['error'],primary);self.assertEqual(result['direct_waits'][0]['exit_code'],101);self.assertNotIn('PRIVATE',json.dumps(value));self.assertFalse(value['native_or_timing_credit'])

    def test_fixture_failure_publisher_refuses_ambiguous_parent_without_new_authority(self):
        from types import SimpleNamespace
        case=self.root/'ambiguous-fixture';case.mkdir();out=case/'worker';out.mkdir();module=SimpleNamespace(fixture_failure_observation=mock.Mock(side_effect=AssertionError('No helper PID guessing')))
        result={'direct_waits':[{'role':'harness','pid':42,'actual_parent_wait':True,'exit_code':101},{'role':'harness-cleanup','pid':43,'actual_parent_wait':True,'exit_code':101}]}
        with mock.patch.object(api,'snapshot_public_diagnostics',return_value=None),mock.patch.object(api,'diagnostic_module',return_value=module):row=api.write_public_failure_diagnostics({'execution_source_commit':'b'*40,'diagnostic_rust_sources':{}},{'scenario':'radix','mode':'ReleaseSafe','runtime_source_commit':'a'*40},{},case,out,result,90)
        module.fixture_failure_observation.assert_not_called();self.assertEqual(json.loads(Path(row['path']).read_bytes())['fixture_failure']['collection_status'],'unavailable')


    def test_Zig_catalog_requires_exact_rooted_required_pin_and_nonempty_bounded_map(self):
        path=self.root/'zig/src/role.zig';path.parent.mkdir(parents=True);path.write_bytes(b'pub fn role() void {}\n');row=api.pin(path);catalog={'zig/src/role.zig':row};plan={'diagnostic_zig_sources':catalog,'required_inputs':[row]};self.assertEqual(api.admitted_zig_diagnostic_catalog(plan,self.root),catalog)
        variants=[dict(plan,required_inputs=[]),dict(plan,diagnostic_zig_sources={}),dict(plan,diagnostic_zig_sources={'../role.zig':row}),dict(plan,diagnostic_zig_sources={'zig/src/role.zig':dict(row,path='/FOREIGN/role.zig')}),dict(plan,diagnostic_zig_sources={'zig/src/role.zig':dict(row,bytes=True)})]
        for changed in variants:
            with self.assertRaises(ValueError):api.admitted_zig_diagnostic_catalog(changed,self.root)
        import ast
        fn=next(n for n in ast.parse(Path(api.__file__).read_bytes()).body if isinstance(n,ast.FunctionDef)and n.name=='load_plan');calls=[n for n in ast.walk(fn)if isinstance(n,ast.Call)and isinstance(n.func,ast.Name)and n.func.id=='admitted_zig_diagnostic_catalog'];self.assertEqual(len(calls),1);self.assertEqual(ast.unparse(calls[0].args[0]),'plan')

    def test_missing_Zig_catalog_cannot_fall_back_to_unbound_role_Source_frames(self):
        from types import SimpleNamespace
        case=self.root/'missing-catalog-case';case.mkdir();out=case/'worker';out.mkdir();primary={'type':'RuntimeError','message':'PRIVATE_PRIMARY'};result={'error':primary,'direct_waits':[{'role':'harness','pid':42,'actual_parent_wait':True,'exit_code':101}]};module=SimpleNamespace(role_failure_observation=mock.Mock(side_effect=AssertionError('No Source map fallback')))
        with mock.patch.object(api,'snapshot_public_diagnostics',return_value=None),mock.patch.object(api,'diagnostic_module',return_value=module):row=api.write_public_failure_diagnostics({'execution_source_commit':'b'*40,'diagnostic_rust_sources':{}},{'scenario':'sealevel','mode':'ReleaseSafe','runtime_source_commit':'a'*40},{},case,out,result,90)
        module.role_failure_observation.assert_not_called();self.assertEqual(json.loads(Path(row['path']).read_bytes())['SVM_role_failure']['collection_status'],'unavailable');self.assertIs(result['error'],primary)


    def test_EVM825_actual_failure_publisher_retains_separate_text_guard_and_primary(self):
        case,out,approval,module,recorder,token,state=self.public_diagnostic_fixture();recorder.finish(token,{**state,'observed_monotonic_ns':120},'exception',RuntimeError('PRIVATE_OBSERVER'))
        repo=self.root/'evm-repo';sources={}
        for name in ['rust/main/utils/run-locally/src/main.rs','rust/main/utils/run-locally/src/external_agents.rs']:
            p=repo/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes((Path(__file__).resolve().parents[2]/name).read_bytes());sources[name]=api.pin(p)
        (out/'harness.log').write_bytes(b"thread 'PRIVATE_THREAD' (42) panicked at utils/run-locally/src/main.rs:825:48:\ncalled `Result::unwrap()` on an `Err` value: Custom { kind: Other, error: \"fixture descendant executable not approved PRIVATE_KEY /PRIVATE_PATH\" }\n")
        primary=RuntimeError('PRIVATE_PRIMARY');result={'direct_waits':[{'role':'harness','pid':42,'actual_parent_wait':True,'exit_code':101}],'error':primary,'passed':False};manifest={'runtime_source_commit':'a'*40,'scenario':'evm','mode':'ReleaseSafe'};plan={'execution_source_commit':'b'*40,'diagnostic_rust_sources':sources}
        with mock.patch.object(api,'__file__',str(repo/'zig/bench/native_case_owner.py')):row=api.write_public_failure_diagnostics(plan,manifest,approval,case,out,result,90)
        value=json.loads(Path(row['path']).read_bytes());self.assertIn('EVM_child_wait_text',value);observed=value['EVM_child_wait_text'];self.assertIsInstance(observed,dict);self.assertEqual(observed['guard_text_code'],'FIXTURE_EXECUTABLE_UNAPPROVED_TEXT');self.assertTrue(observed['text_only']);self.assertEqual(value['rust_panic_reason_codes'],[]);self.assertIsNone(value['rust_panic_reason_source']);self.assertIn('SVM tempfile',value['rust_reason_scope']);self.assertEqual(value['actual_direct_parent_waits'],result['direct_waits']);self.assertIs(result['error'],primary);self.assertFalse(result['passed']);self.assertFalse(value['native_or_timing_credit']);self.assertNotIn('PRIVATE',json.dumps(value));self.assertLess(row['bytes'],512*1024)
    def test_EVM825_missing_optional_observation_is_None_or_explicit_unavailable(self):
        from types import SimpleNamespace
        states=[({},None),({'EVM_child_wait_text':None},None),({'EVM_child_wait_text':{'collection_status':'unavailable','classification':'UNKNOWN'}},{'collection_status':'unavailable','classification':'UNKNOWN'})]
        for i,(extra,expected)in enumerate(states):
            case=self.root/('evm-missing-'+str(i));case.mkdir();out=case/'worker';out.mkdir();(out/'harness.log').write_bytes(b'PRIVATE_NOT_PUBLISHED');primary=RuntimeError('PRIVATE_PRIMARY');result={'direct_waits':[{'role':'harness','pid':42,'actual_parent_wait':True,'exit_code':101}],'error':primary};rust={'sites':[],'reason_codes':[],'reason_source':None,'log_fingerprint':None,**extra};module=SimpleNamespace(rust_panic_observation=mock.Mock(return_value=rust))
            with mock.patch.object(api,'snapshot_public_diagnostics',return_value=None),mock.patch.object(api,'diagnostic_module',return_value=module):row=api.write_public_failure_diagnostics({'execution_source_commit':'b'*40,'diagnostic_rust_sources':{}},{'scenario':'evm','mode':'ReleaseSafe','runtime_source_commit':'a'*40},{},case,out,result,90)
            value=json.loads(Path(row['path']).read_bytes());self.assertEqual(value['EVM_child_wait_text'],expected);self.assertIs(result['error'],primary);self.assertFalse(value['native_or_timing_credit']);self.assertNotIn('PRIVATE',json.dumps(value))

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

    def test_confirmed_series_presence_separates_empty_from_present_zero_without_raw_metrics(self):
        row=self.observe(b'<E2E> Relayer confirmed series 0 samples, sum 0, expected 10\n');empty=row['events']['confirmed_metric_series_observed']['latest'];self.assertEqual((empty['series_count'],empty['confirmed_count'],empty['expected_count']),(0,0,10))
        row=self.observe(b'<E2E> Relayer confirmed series 2 samples, sum 0, expected 10\n');present=row['events']['confirmed_metric_series_observed']['latest'];self.assertEqual((present['series_count'],present['confirmed_count']),(2,0));self.assertEqual(present['metric_values_status'],'observed_u32');self.assertNotIn('PRIVATE',json.dumps(row))
    def test_confirmed_series_numeric_overflow_suffix_and_wrong_header_do_not_export_values(self):
        row=self.observe(b'PRIVATE <E2E> Relayer confirmed series 1 samples, sum 10, expected 10\n<E2E> Relayer confirmed series 1 samples, sum 10, expected 10 PRIVATE\n');self.assertNotIn('confirmed_metric_series_observed',row['events'])
        value=self.observe(b'<E2E> Relayer confirmed series 4294967296 samples, sum 0, expected 10\n')['events']['confirmed_metric_series_observed']['latest'];self.assertEqual(value['metric_values_status'],'outside_u32');self.assertNotIn('series_count',value)
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




class FunctionalCensusControls(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='functional-census-control-');self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve()
        self.interop=self.root/'accepted-interop.json'
        self.source=Path(api.__file__).with_name('native_harness_census.py')
        self.accepted={'accepted_component_source_and_actual_Zig_storage_interop':True,'family_chain_SDK_finality_delivery_elapsed600_acceptance':False,'source_sha256':{'zig/bench/native_harness_census.py':api.pin(self.source)['sha256']}}

    def admit(self, value=None):
        self.interop.write_text(json.dumps(self.accepted if value is None else value));descriptor=api.pin(self.interop)
        return {'required_inputs':[descriptor]},{'native_reader_interoperability':descriptor}

    def test_exact_admitted_interop_loads_actual_census_and_records_tiny_tree(self):
        plan,approval=self.admit();module,binding=api.functional_census(plan,approval)
        self.assertEqual(binding,api.pin(self.source));(self.root/'one').write_bytes(b'owned')
        observations={};value=module.functional_allocated(self.root,observations)
        self.assertGreater(value,0);self.assertTrue(observations['last']['complete']);self.assertEqual(observations['last']['maximum_seconds'],15);self.assertEqual(observations['last']['maximum_entries'],250000)
        self.assertEqual(observations['last']['reason'],None);self.assertEqual(observations['calls'],1)

    def test_missing_admitted_descriptor_and_bad_actual_interop_flags_refuse(self):
        plan,approval=self.admit()
        with self.assertRaises(ValueError):api.functional_census({'required_inputs':[]},approval)
        for key,value in [('accepted_component_source_and_actual_Zig_storage_interop',False),('family_chain_SDK_finality_delivery_elapsed600_acceptance',True)]:
            changed=copy.deepcopy(self.accepted);changed[key]=value;plan,approval=self.admit(changed)
            with self.subTest(key=key),self.assertRaises(ValueError):api.functional_census(plan,approval)

    def test_wrong_census_hash_and_metadata_capture_replacement_refuse_before_compile(self):
        changed=copy.deepcopy(self.accepted);changed['source_sha256']['zig/bench/native_harness_census.py']='0'*64;plan,approval=self.admit(changed)
        with mock.patch('builtins.compile',side_effect=AssertionError('must not compile')):
            with self.assertRaises(ValueError):api.functional_census(plan,approval)
        plan,approval=self.admit();original=Path.read_bytes
        def replacement(path):return b'{}' if path==self.interop else original(path)
        with mock.patch.object(Path,'read_bytes',replacement),mock.patch('builtins.compile',side_effect=AssertionError('must not compile')):
            with self.assertRaises(ValueError):api.functional_census(plan,approval)

    def test_actual_function_preserves_time_and_entry_failure_observations(self):
        module,binding=api.functional_census(*self.admit())
        for mode in ['time_limit','entry_limit']:
            observations={}
            with self.subTest(mode=mode):
                if mode=='time_limit':
                    with mock.patch.object(module.time,'monotonic',side_effect=[0,16,16]):
                        with self.assertRaises(module.FunctionalCensusIncomplete):module.functional_allocated(self.root,observations)
                else:
                    (self.root/'one').write_bytes(b'one');(self.root/'two').write_bytes(b'two')
                    with self.assertRaises(module.FunctionalCensusIncomplete):module.functional_allocated(self.root,observations,maximum_entries=1)
                self.assertFalse(observations['last']['complete']);self.assertEqual(observations['last']['reason'],mode);self.assertEqual(observations['calls'],1)

    def test_actual_outer_main_retains_failed_census_observation_and_still_waits(self):
        from types import SimpleNamespace
        module,binding=api.functional_census(*self.admit());output=self.root/'supervision';plan_path=self.root/'plan';plan_path.write_text('{}')
        descriptor=api.pin(plan_path)
        plan={'scenario':'sealevel-composite','required_inputs':[],'maximum_case_allocated_bytes':8*api.GIB}
        manifest={'task_root':str(self.root),'mode':'ReleaseSafe','runtime_source_commit':'a'*40,'artifacts':{},'execution_approval':descriptor,'case_inputs':descriptor}
        failure=module.FunctionalCensusIncomplete({'complete':False,'reason':'entry_limit','files_seen':250001})
        def census(case,observations):
            observations.update(calls=1,last=failure.observation);raise failure
        child=SimpleNamespace(pid=12345,returncode=0)
        cleanup={'clean':True,'actual_parent_wait':True,'exit_code':0,'signals':[]}
        with mock.patch.object(api.sys,'platform','linux'),mock.patch.object(api.sys,'argv',['owner','--plan',str(plan_path),'--plan-sha256',descriptor['sha256'],'--output',str(output)]),mock.patch.object(api,'load_plan',return_value=(plan,manifest,{}, {'python_modules':{}})),mock.patch.object(api,'functional_census',return_value=(SimpleNamespace(functional_allocated=census),binding)),mock.patch.object(api.shutil,'disk_usage',return_value=SimpleNamespace(free=8*api.GIB)),mock.patch.object(api.owner,'enable_subreaper'),mock.patch.object(api.owner,'processes',return_value={}),mock.patch.object(api.owner,'owned_processes',return_value={}),mock.patch.object(api.owner,'stop_owned',return_value=cleanup) as stop,mock.patch.object(api.subprocess,'Popen',return_value=child),mock.patch.object(api.os,'waitid',return_value=None),mock.patch.object(api.signal,'signal'):
            with self.assertRaisesRegex(ValueError,'Owned native case failed'):api.main()
        stop.assert_called_once();record=json.loads((output/'result.json').read_bytes())
        self.assertFalse(record['passed']);self.assertEqual(record['error']['type'],'FunctionalCensusIncomplete');self.assertEqual(record['functional_allocation_census']['last']['reason'],'entry_limit');self.assertEqual(record['cleanup'],cleanup)

    def test_actual_outer_main_rejects_late_completed_census_under_original_deadline(self):
        from types import SimpleNamespace
        module,binding=api.functional_census(*self.admit());output=self.root/'supervision';plan_path=self.root/'plan';plan_path.write_text('{}')
        descriptor=api.pin(plan_path)
        plan={'scenario':'sealevel-composite','required_inputs':[],'maximum_case_allocated_bytes':8*api.GIB}
        manifest={'task_root':str(self.root),'mode':'ReleaseSafe','runtime_source_commit':'a'*40,'artifacts':{},'execution_approval':descriptor,'case_inputs':descriptor}
        clock=[0]
        def census(case,observations):
            observations.update(calls=1,last={'complete':True,'reason':None});clock[0]=3600*10**9+1;return 0
        child=SimpleNamespace(pid=12345,returncode=0)
        cleanup={'clean':True,'actual_parent_wait':True,'exit_code':0,'signals':[]}
        with mock.patch.object(api.sys,'platform','linux'),mock.patch.object(api.sys,'argv',['owner','--plan',str(plan_path),'--plan-sha256',descriptor['sha256'],'--output',str(output)]),mock.patch.object(api,'load_plan',return_value=(plan,manifest,{}, {'python_modules':{}})),mock.patch.object(api,'functional_census',return_value=(SimpleNamespace(functional_allocated=census),binding)),mock.patch.object(api.shutil,'disk_usage',return_value=SimpleNamespace(free=8*api.GIB)),mock.patch.object(api.owner,'enable_subreaper'),mock.patch.object(api.owner,'processes',return_value={}),mock.patch.object(api.owner,'owned_processes',return_value={}),mock.patch.object(api.owner,'stop_owned',return_value=cleanup) as stop,mock.patch.object(api.subprocess,'Popen',return_value=child),mock.patch.object(api.os,'waitid',return_value=None),mock.patch.object(api.signal,'signal'),mock.patch.object(api.time,'monotonic_ns',side_effect=lambda:clock[0]):
            with self.assertRaisesRegex(ValueError,'Owned native case failed'):api.main()
        stop.assert_called_once();record=json.loads((output/'result.json').read_bytes())
        self.assertFalse(record['passed']);self.assertEqual(record['error'],{'type':'ValueError','message':'Original native case deadline/resource guard'});self.assertTrue(record['functional_allocation_census']['last']['complete']);self.assertEqual(record['cleanup'],cleanup)

    def test_actual_outer_caller_uses_functional_census_and_original_pre_post_guards(self):
        import ast
        tree=ast.parse(Path(api.__file__).read_bytes());main=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='main');text=ast.unparse(main)
        self.assertIn('census.functional_allocated(case, census_observations)',text);self.assertNotIn('owner.allocated(',text)
        self.assertLess(text.index('resource guard before census'),text.index('census.functional_allocated'))
        self.assertLess(text.index('census.functional_allocated'),text.index('resource_observed_ns = time.monotonic_ns()'))
        self.assertIn('resource_observed_ns < deadline_ns and ram <= 8 * GIB and (disk <= plan[',text)
        self.assertIn('checked(census_source)',text);self.assertIn("result['functional_allocation_census'] = census_observations",text)
        original=Path(api.owner.__file__).read_text();self.assertIn('deadline=time.monotonic()+1',original.replace(' ',''))




class RelayerStartupOwnerControls(unittest.TestCase):
    def setUp(self):
        diagnostic_spec=importlib.util.spec_from_file_location('startup_diagnostics_fixture',Path(api.__file__).resolve().parents[1]/'integration/multivm_diagnostics.py')
        diagnostic=importlib.util.module_from_spec(diagnostic_spec);diagnostic_spec.loader.exec_module(diagnostic)
        from types import SimpleNamespace
        self.diagnostic=diagnostic;self.simple=SimpleNamespace;self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name).resolve();self.product=self.root/'relayer';self.product.write_bytes(b'public-fixture-only')
        repo=Path(api.__file__).resolve().parents[2];here=repo/'zig/integration';self.modules={name:diagnostic.pin(here/name)for name in ['multivm_session.py','multivm_evidence.py']};self.manifest={'scenario':'evm','runtime_source_commit':diagnostic.RELAYER_STARTUP_EPOCH,'artifacts':{'relayer':api.pin(self.product)}}
        state=diagnostic.RelayerStartup(repo,self.manifest,self.modules);self.context={'module':diagnostic,'state':state,'product':self.product,'product_identity':state.identity(self.product),'latest_probe':{'collection_status':'not_attempted'}}
        self.helper={'pid':42,'ppid':1,'start':'linux-ticks:123','state':'S'};self.role={'pid':43,'ppid':42,'start':'linux-ticks:456','state':'S'};self.code=None;self.harness=self.simple(pid=42,poll=lambda:self.code);self.controller=self.simple(poll=lambda:None);self.now=1000000000;self.calls=[]
        self.body=b'hyperlane_block_height{chain="one",agent="relayer",hyperlane_baselib_version="3.0.0"} 0\n'
    def patches(self):
        from contextlib import ExitStack
        stack=ExitStack();stack.enter_context(mock.patch.object(api.time,'monotonic_ns',side_effect=lambda:self.now));stack.enter_context(mock.patch.object(api.owner,'_linux_row',side_effect=lambda pid:self.helper if pid==42 else self.role));stack.enter_context(mock.patch.object(api.os,'readlink',return_value=str(self.product)));self.selected=stack.enter_context(mock.patch.object(self.diagnostic,'startup_selected_role',return_value=(self.role,('one',),9092)));self.listener=stack.enter_context(mock.patch.object(self.diagnostic,'startup_owned_listener',return_value='1234'))
        def http(port,method,deadline,cancel,clock):
            self.calls.append((port,method,deadline));return (200,self.body)if method=='GET'else(405,b'')
        self.http=stack.enter_context(mock.patch.object(self.diagnostic,'startup_http',side_effect=http));return stack
    def observe(self,deadline=3000000000):api.observe_relayer_startup(self.context,self.manifest,{'chain_names':['one']},self.root,self.harness,self.controller,self.helper,deadline)
    def test_actual_arm_requires_Source_epoch_writer_and_admitted_product(self):
        repo=Path(api.__file__).resolve().parents[2];name='rust/main/utils/run-locally/src/external_agents.rs';source=repo/name;self.product.chmod(0o700);manifest={**self.manifest,'artifacts':{'relayer':api.pin(self.product)}};plan={'scenario':'evm','diagnostic_rust_sources':{name:api.pin(source)}};approval={'python_modules':self.modules}
        with mock.patch.object(api,'diagnostic_module',return_value=self.diagnostic),mock.patch.object(api.time,'monotonic_ns',return_value=1):
            self.assertIsNotNone(api.arm_relayer_startup(plan,manifest,approval,repo,1000))
            bad=copy.deepcopy(plan);bad['diagnostic_rust_sources'][name]['sha256']='0'*64;self.assertIsNone(api.arm_relayer_startup(bad,manifest,approval,repo,1000));self.assertIsNone(api.arm_relayer_startup(plan,{**manifest,'runtime_source_commit':'a'*40},approval,repo,1000));self.assertIsNone(api.arm_relayer_startup(plan,manifest,approval,repo,1))
    def test_epoch_change_between_GET_and_HEAD_and_late_projection_cannot_publish_new_data(self):
        prior={'prior':'closed-observation'};self.context['state'].last=prior
        with self.patches():
            def changed(*args):self.role={**self.role,'start':'linux-ticks:789'};return 200,self.body
            self.http.side_effect=changed;self.observe();self.assertEqual(self.http.call_count,1);self.assertIs(self.context['state'].last,prior)
        self.role={**self.role,'start':'linux-ticks:456'};original=self.context['state'].project
        def late(*args):value=original(*args);self.now+=600000000;return value
        with self.patches(),mock.patch.object(self.context['state'],'project',side_effect=late):self.observe()
        self.assertIs(self.context['state'].last,prior);self.assertEqual(self.context['latest_probe']['collection_status'],'unavailable')
    def test_actual_owner_helper_preserves_same_absolute_budget_and_public_projection(self):
        with self.patches():self.observe()
        self.assertEqual(self.calls,[(9092,'GET',1500000000),(9092,'HEAD',1500000000)]);self.assertEqual(self.listener.call_count,3);value=self.context['state'].last;self.assertEqual(value['metrics'][0]['metrics']['block_height']['finite_values'],[0.0]);self.assertFalse(value['current_role_identity']['historical_journal_PS_epoch_compared']);self.assertEqual(self.context['latest_probe']['collection_status'],'observed')
    def test_actual_owner_expired_cancelled_changed_product_or_uncertain_capture_no_HTTP(self):
        for kind in ['expired','cancel','product','capture','helper']:
            with self.subTest(kind=kind),self.patches():
                if kind=='cancel':self.code=101
                if kind=='product':self.context['product_identity']=()
                if kind=='capture':self.selected.side_effect=ValueError('PRIVATE_TOKEN')
                if kind=='helper':api.owner._linux_row.side_effect=lambda _:None
                self.observe(deadline=1 if kind=='expired'else 3000000000);self.http.assert_not_called();self.assertEqual(self.context['latest_probe']['collection_status'],'unavailable');self.assertNotIn('PRIVATE',json.dumps(self.context['latest_probe']));self.code=None;self.context['product_identity']=self.context['state'].identity(self.product)
    def test_actual_owner_late_IO_discards_new_observation_without_replacing_old(self):
        prior={'prior':'closed-observation'};self.context['state'].last=prior
        with self.patches():
            def late(*args):self.now+=600000000;return 200,self.body
            self.http.side_effect=late;self.observe();self.assertEqual(self.http.call_count,1)
        self.assertIs(self.context['state'].last,prior);self.assertEqual(self.context['latest_probe']['collection_status'],'unavailable')
    def test_actual_worker_inspection_loop_calls_observer_after_original_checks_and_keeps_cadence(self):
        import ast
        tree=ast.parse(Path(api.__file__).read_bytes());worker=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='worker');loop=next(n for n in ast.walk(worker)if isinstance(n,ast.While)and ast.unparse(n.test)=='harness.poll() is None')
        inspector=mock.Mock(side_effect=lambda:self.calls.append('inspect'));native=mock.Mock(side_effect=lambda *a:self.calls.append('native'));self.calls=[]
        def done(*args):self.code=101
        env={'harness':self.harness,'controller':self.controller,'require':api.require,'deadline':3,'next_inspect':0,'inspect':inspector,'radix':None,'radix_publisher':None,'devnets':None,'native_listener_proof':native,'plan':{'scenario':'evm','lsofArtifact':{}},'manifest':self.manifest,'inputs':{'chain_names':['one']},'case':self.root,'checked':lambda *args:Path('/public/lsof'),'node_proofs':{},'startup_context':self.context,'helper_row':self.helper,'args':self.simple(original_deadline_ns=3000000000),'observe_relayer_startup':api.observe_relayer_startup,'time':self.simple(monotonic=lambda:1,monotonic_ns=lambda:self.now,sleep=done)}
        with self.patches():exec(compile(ast.Module(body=[loop],type_ignores=[]),'<actual-worker-inspection-loop>','exec'),env)
        self.assertEqual(self.calls[:2],['inspect','native']);self.assertEqual(self.calls[2:],[ (9092,'GET',1500000000),(9092,'HEAD',1500000000)]);self.assertEqual(env['next_inspect'],2);self.assertEqual(self.context['latest_probe']['collection_status'],'observed')
    def test_actual_failure_publisher_keeps_primary_and_fixed_JSON_bound(self):
        with self.patches():self.observe()
        (self.root/'harness.log').write_bytes(b'<RLY> error: agent stopped: PRIVATE_SENTINEL\n');result={'direct_waits':[],'error':{'type':'ValueError','message':'PRIMARY_PRIVATE'}};original=copy.deepcopy(result)
        manifest={**self.manifest,'mode':'ReleaseSafe'};plan={'execution_source_commit':'b'*40,'diagnostic_rust_sources':{}}
        with mock.patch.object(api,'snapshot_public_diagnostics',return_value=None),mock.patch.object(api,'diagnostic_module',return_value=self.diagnostic):row=api.write_public_failure_diagnostics(plan,manifest,{},self.root,self.root,result,1,self.context)
        wire=Path(row['path']).read_text();self.assertNotIn('PRIVATE',wire);self.assertEqual(result,original);self.assertLess(row['bytes'],512*1024);self.assertFalse(json.loads(wire)['EVM_Stark_startup']['native_or_timing_or_cleanup_authority'])



class RadixTransportOwnerControls(unittest.TestCase):
    def setUp(self):
        from types import SimpleNamespace
        self.simple=SimpleNamespace;self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name).resolve();self.repo=Path(api.__file__).resolve().parents[2]
        spec=importlib.util.spec_from_file_location('radix_transport_diagnostics_fixture',self.repo/'zig/integration/multivm_diagnostics.py');self.diag=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.diag)
        self.fixture={'architecture':'amd64','token':'a'*32,'images':{s:{'id':'sha256:'+'b'*64,'source':'fixed'}for s in self.diag.RADIX_TRANSPORT_SERVICES}}
        rust='rust/main/utils/run-locally/src/external_agents/radix_fixture.rs';source=api.pin(self.repo/rust);custody=api.pin(self.repo/'zig/bench/native_radix_custody.py');self.plan={'execution_source_commit':'5'*40,'scenario':'radix','required_inputs':[source,custody],'diagnostic_rust_sources':{rust:source}};self.manifest={'scenario':'radix','task_root':str(self.root),'runtime_source_commit':'4'*40,'mode':'ReleaseSafe'}
    def arm(self,plan=None):
        with mock.patch.object(api,'diagnostic_module',return_value=self.diag),mock.patch.object(api.time,'monotonic_ns',return_value=1):return api.arm_radix_transport(plan or self.plan,self.manifest,{},self.repo,self.fixture,{'ServerVersion':'28.0.4'},1000)
    def test_actual_arm_requires_existing_Source_descriptors_and_exact_fixture(self):
        context=self.arm();self.assertIsNotNone(context);self.assertEqual(context['state'].engine_version,'28.0.4');self.assertEqual(context['case'],self.root)
        bad=copy.deepcopy(self.plan);bad['required_inputs']=[];self.assertIsNone(self.arm(bad))
        bad=copy.deepcopy(self.plan);bad['diagnostic_rust_sources'][next(iter(bad['diagnostic_rust_sources']))]['sha256']='0'*64;self.assertIsNone(self.arm(bad))
        bad=copy.deepcopy(self.plan);bad['required_inputs'][1]['sha256']='0'*64;self.assertIsNone(self.arm(bad))
        with mock.patch.object(api,'diagnostic_module',return_value=self.diag),mock.patch.object(api.time,'monotonic_ns',return_value=1):self.assertIsNone(api.arm_radix_transport(self.plan,self.manifest,{},self.repo,self.fixture,{},1))
    def test_actual_tap_is_inert_without_context_and_cannot_mask_failure(self):
        api.tap_radix_transport(None,[],None);failure=ValueError('PRIVATE_CAPTURE');state=self.simple(capture=mock.Mock(side_effect=failure),capture_invalid=False);api.tap_radix_transport({'state':state},['network','inspect','fixed'],'fixed');self.assertTrue(state.capture_invalid)
    def test_actual_docker_call_keeps_original4_plus3_and_returns_originalwire(self):
        import ast
        tree=ast.parse(Path(api.__file__).read_text());worker=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='worker');node=next(n for n in worker.body if isinstance(n,ast.FunctionDef)and n.name=='docker_call')
        calls=[];captured=[]
        class Child:
            pid=123;returncode=0
            def wait(self,timeout):calls.append(timeout);return 0
        def popen(arguments,**kwargs):kwargs['stdout'].write(b'RAW_ORIGINAL_WIRE');return Child()
        env={'require':api.require,'pg':{},'deadline':10,'cleanup_deadline':20,'time':self.simple(monotonic=lambda:1),'tempfile_files':api.tempfile_files,'out':self.root,'subprocess':self.simple(Popen=popen,DEVNULL=-1),'docker':Path('/public/docker'),'inputs':{'local_docker':{'host':'unix:///var/run/docker.sock','config_dir':str(self.root)}},'docker_env':{},'result':{'docker_calls':[]},'os':os,'plan':{'scenario':'radix'},'missing_container':api.missing_container,'radix_custody':api.radix_custody,'radix_transport':{'state':None},'tap_radix_transport':lambda context,args,wire:captured.append((args,wire))}
        exec(compile(ast.Module(body=[node],type_ignores=[]),'<actual-Docker-call>','exec'),env);self.assertEqual(env['docker_call'](['info']),'RAW_ORIGINAL_WIRE');self.assertEqual(calls,[4,3]);self.assertEqual(captured,[(['info'],'RAW_ORIGINAL_WIRE')]);captured.clear();env['docker_call'](['info'],cleaning=True);self.assertEqual(calls[-2:],[12,3]);self.assertEqual(captured,[])
    def test_actual_owner_observe_checks_bound_helper_and_catches_diagnostic_exceptions(self):
        context=self.arm();state=context['state'];custody=self.simple(case=self.root,pid=42,start='linux-ticks:9');helper={'pid':42,'start':'linux-ticks:9','state':'S'};harness=self.simple(pid=42,poll=lambda:None);controller=self.simple(poll=lambda:None);observed=[]
        def observe(custody,kernel,check,clock,cancelled,deadline,http):check();observed.append((deadline,cancelled(),http))
        with mock.patch.object(state,'observe',side_effect=observe),mock.patch.object(api.time,'monotonic_ns',return_value=1),mock.patch.object(api.owner,'_linux_row',return_value=helper):api.observe_radix_transport(context,custody,harness,controller,helper,1000)
        self.assertEqual(observed,[(1000,False,self.diag.radix_transport_http)])
        with mock.patch.object(state,'observe',side_effect=ValueError('PRIVATE_DIAGNOSTIC')):api.observe_radix_transport(context,custody,harness,controller,helper,1000)
        with mock.patch.object(state,'observe',side_effect=observe),mock.patch.object(api.time,'monotonic_ns',return_value=1),mock.patch.object(api.owner,'_linux_row',return_value={**helper,'start':'linux-ticks:10'}):api.observe_radix_transport(context,custody,harness,controller,helper,1000)
        self.assertEqual(len(observed),1)
    def test_actual_worker_cadence_begin_capture_observe_then_HTTP_no_newclient(self):
        import ast
        tree=ast.parse(Path(api.__file__).read_text());worker=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='worker');loop=next(n for n in ast.walk(worker)if isinstance(n,ast.While)and ast.unparse(n.test)=='harness.poll() is None');calls=[];code=[None];harness=self.simple(poll=lambda:code[0]);state=self.simple(begin_custody=lambda:calls.append('begin'));radix=self.simple(observe=lambda:calls.append('ordinary_custody'))
        def done(_):code[0]=101
        env={'harness':harness,'controller':self.simple(poll=lambda:None),'require':api.require,'deadline':3,'next_inspect':0,'inspect':lambda:calls.append('PG'),'radix':radix,'radix_publisher':None,'radix_transport':{'state':state},'observe_radix_transport':lambda *args:calls.append('Radix_HTTP'),'startup_context':None,'observe_relayer_startup':lambda *args:None,'manifest':self.manifest,'inputs':{},'case':self.root,'helper_row':{},'args':self.simple(original_deadline_ns=3_000_000_000),'time':self.simple(monotonic=lambda:1,sleep=done)}
        exec(compile(ast.Module(body=[loop],type_ignores=[]),'<actual-Radix-inspection-loop>','exec'),env);self.assertEqual(calls,['PG','begin','ordinary_custody','Radix_HTTP']);self.assertEqual(env['next_inspect'],2)
    def test_actual_failure_publisher_preserves_primary_and_finite_only(self):
        context=self.arm();(self.root/'harness.log').write_bytes(b'');result={'direct_waits':[],'error':{'type':'ValueError','message':'PRIMARY_PRIVATE'}};original=copy.deepcopy(result)
        with mock.patch.object(api,'snapshot_public_diagnostics',return_value=None),mock.patch.object(api,'diagnostic_module',return_value=self.diag):row=api.write_public_failure_diagnostics(self.plan,self.manifest,{},self.root,self.root,result,1,None,context)
        wire=Path(row['path']).read_text();self.assertEqual(result,original);self.assertNotIn('PRIVATE',wire);self.assertFalse(json.loads(wire)['Radix_transport']['native_or_timing_or_cleanup_authority']);self.assertLess(row['bytes'],512*1024)



class TronCLIContextOwnerControls(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name).resolve()
    def test_actual_failure_publisher_passes_existing_readonly_context_and_preserves_primary(self):
        from types import SimpleNamespace
        required=[{'path':'/approved/file.js','bytes':1,'sha256':'c'*64}];inputs={'tron_cli':{'path':'/approved/receipt','bytes':1,'sha256':'d'*64},'tron_tre':{'pnpm':{'path':'/approved/pnpm-native'}}};approval={};result={'error':{'type':'RuntimeError','message':'PRIVATE_PRIMARY'},'direct_waits':[{'role':'harness','pid':42,'actual_parent_wait':True,'exit_code':101}]};before=copy.deepcopy(result);plan={'execution_source_commit':'b'*40,'diagnostic_rust_sources':{},'required_inputs':required};manifest={'scenario':'tron','mode':'ReleaseSafe','runtime_source_commit':'a'*40}
        method=mock.Mock(return_value={'schema':1,'native_or_timing_or_cleanup_authority':False});module=SimpleNamespace(fixture_failure_observation=method)
        with mock.patch.object(api,'snapshot_public_diagnostics',return_value=None),mock.patch.object(api,'diagnostic_module',return_value=module):row=api.write_public_failure_diagnostics(plan,manifest,approval,self.root,self.root,result,1,None,None,inputs)
        self.assertIs(method.call_args.kwargs['case_inputs'],inputs);self.assertIs(method.call_args.kwargs['required_inputs'],required);self.assertIs(method.call_args.args[2],approval);self.assertEqual(result,before);self.assertNotIn('PRIVATE',Path(row['path']).read_text())
    def test_actual_worker_failure_call_passes_loaded_inputs_no_new_dataset(self):
        import ast
        tree=ast.parse(Path(api.__file__).read_text());worker=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='worker');calls=[n for n in ast.walk(worker)if isinstance(n,ast.Call)and isinstance(n.func,ast.Name)and n.func.id=='write_public_failure_diagnostics'];self.assertEqual(len(calls),1);self.assertIsInstance(calls[0].args[-1],ast.Name);self.assertEqual(calls[0].args[-1].id,'inputs')
        # This existing materialized graph admission remains BEFORE harness I/O;
        # the failure collector never repeats it or changes successful behavior.
        self.assertIn("read_materialized(inputs['tron_cli'])",ast.unparse(worker))
    def test_actual_failure_callback_throw_remains_unavailable_and_primary_exact(self):
        from types import SimpleNamespace
        primary={'type':'ValueError','message':'PRIVATE_SOURCE'};result={'error':primary,'direct_waits':[{'role':'harness','pid':42,'actual_parent_wait':True,'exit_code':101}]};module=SimpleNamespace(fixture_failure_observation=mock.Mock(side_effect=ValueError('PRIVATE_COLLECTOR')))
        with mock.patch.object(api,'snapshot_public_diagnostics',return_value=None),mock.patch.object(api,'diagnostic_module',return_value=module):row=api.write_public_failure_diagnostics({'execution_source_commit':'b'*40,'diagnostic_rust_sources':{}},{'scenario':'tron','mode':'ReleaseSafe','runtime_source_commit':'a'*40},{},self.root,self.root,result,1,None,None,{})
        value=json.loads(Path(row['path']).read_text());self.assertIs(result['error'],primary);self.assertEqual(value['fixture_failure']['collection_status'],'unavailable');self.assertNotIn('PRIVATE',json.dumps(value))



class RadixPublisherOwnerControls(unittest.TestCase):
    def worker(self):
        import ast
        tree=ast.parse(Path(api.__file__).read_text())
        return ast,next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='worker')

    def test_actual_worker_initializes_only_radix_and_uses_original_deadline(self):
        ast,worker=self.worker();nodes=[n for n in ast.walk(worker)if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='radix_publisher'for t in n.targets)]
        self.assertEqual(len(nodes),2);self.assertIsNone(ast.literal_eval(nodes[0].value))
        call=nodes[1].value;self.assertEqual(ast.unparse(call.func),'radix_custody().LoopbackPublisher');self.assertEqual([ast.unparse(a)for a in call.args],['radix','owner._linux_row','lambda: harness.poll() is not None or controller.poll() is not None','args.original_deadline_ns'])
        guards=[n for n in ast.walk(worker)if isinstance(n,ast.If)and ast.unparse(n.test)=="plan['scenario'] == 'radix'"and nodes[1]in n.body];self.assertEqual(len(guards),1)
        self.assertIn('radix.arm()',ast.unparse(guards[0]));self.assertLess(ast.unparse(guards[0]).index('radix.arm()'),ast.unparse(guards[0]).index('LoopbackPublisher'))

    def test_actual_loop_checks_pump_before_custody_then_updates_after_custody(self):
        import types
        ast,worker=self.worker();loop=next(n for n in ast.walk(worker)if isinstance(n,ast.While)and ast.unparse(n.test)=='harness.poll() is None')
        calls=[];code=[None];harness=types.SimpleNamespace(poll=lambda:code[0])
        publisher=types.SimpleNamespace(check=lambda:calls.append('pump_check'),observe=lambda:calls.append('new_lease'))
        def done(value):self.assertEqual(value,.1);code[0]=0
        env={'harness':harness,'controller':types.SimpleNamespace(poll=lambda:None),'require':api.require,'deadline':3,'next_inspect':0,'inspect':lambda:calls.append('PG'),'radix':types.SimpleNamespace(observe=lambda:calls.append('ordinary_custody')),'radix_publisher':publisher,'radix_transport':None,'observe_radix_transport':lambda *args:calls.append('diagnostic_HTTP'),'observe_relayer_startup':lambda *args:None,'startup_context':None,'manifest':{},'inputs':{},'case':None,'helper_row':{},'args':types.SimpleNamespace(original_deadline_ns=3_000_000_000),'time':types.SimpleNamespace(monotonic=lambda:1,sleep=done)}
        exec(compile(ast.Module(body=[loop],type_ignores=[]),'<actual-publisher-worker-loop>','exec'),env)
        self.assertEqual(calls,['pump_check','PG','ordinary_custody','new_lease','diagnostic_HTTP']);self.assertEqual(env['next_inspect'],2)
        publisher.check=mock.Mock(side_effect=ValueError('closed-publisher-failed'));code[0]=None;calls.clear()
        with self.assertRaisesRegex(ValueError,'publisher-failed'):exec(compile(ast.Module(body=[loop],type_ignores=[]),'<actual-publisher-loop-failure>','exec'),env)
        self.assertEqual(calls,[])

    def test_actual_worker_primary_exception_revokes_before_error_recording_or_diagnostics(self):
        import types
        ast,worker=self.worker();handlers=[node for node in ast.walk(worker)if isinstance(node,ast.ExceptHandler)and node.name=='failure'and any(isinstance(n,ast.Assign)and any(ast.unparse(target)=="result['error']"for target in n.targets)for n in node.body)]
        self.assertEqual(len(handlers),1);handler=handlers[0];calls=[];primary=ValueError('PRIVATE_ORIGINAL_PRIMARY')
        class Result(dict):
            def __setitem__(self,key,value):calls.append('record_'+key);super().__setitem__(key,value)
        def revoke(error):self.assertIs(error,primary);calls.append('revoke')
        env={'radix_publisher':types.SimpleNamespace(revoke=revoke),'failure':primary,'result':Result()}
        exec(compile(ast.Module(body=handler.body,type_ignores=[]),'<actual-worker-first-except-action>','exec'),env)
        self.assertEqual(calls,['revoke','record_error']);self.assertIs(env['error'],primary);self.assertEqual(env['result']['error']['message'],'PRIVATE_ORIGINAL_PRIMARY')
        self.assertEqual(ast.unparse(handler.body[0].test),'radix_publisher is not None')
        # The same except catches every failure in the surrounding original try,
        # including PG inspect and ordinary radix.observe before publisher.observe.
        outer=next(n for n in ast.walk(worker)if isinstance(n,ast.Try)and handler in n.handlers)
        self.assertIn('radix.observe()',ast.unparse(outer));self.assertIn('inspect()',ast.unparse(outer))

    def test_actual_cleanup_closes_pump_after_harness_stop_before_docker_even_on_failure(self):
        import types
        ast,worker=self.worker();body=next(n for n in worker.body if isinstance(n,ast.Try)).finalbody
        cleanup=next(n for n in body if isinstance(n,ast.Try)).body
        start=next(i for i,n in enumerate(cleanup)if isinstance(n,ast.Expr)and isinstance(n.value,ast.Call)and ast.unparse(n.value.func)=='stop_direct')
        fragment=cleanup[start:start+4]
        self.assertEqual([ast.unparse(n.test)for n in fragment[2:]],['radix_publisher is not None','radix is not None'])
        for error in [None,ValueError('PRIVATE_STOP_FAILURE')]:
            calls=[];primary={'type':'PrimaryError','message':'KEEP_PRIMARY'};result={'passed':False,'native_case_acceptance':False,'error':dict(primary)}
            def close(deadline):
                self.assertEqual(deadline,180);calls.append('pump_close')
                if error is not None:raise error
                return {'error_class':None,'all_owned_sockets_closed':True}
            env={'harness':object(),'controller':object(),'stop_direct':lambda process,role,seconds:calls.append(role),'radix_publisher':types.SimpleNamespace(close=close),'radix':types.SimpleNamespace(cleanup=lambda:(calls.append('Docker_cleanup')or{'passed':True,'recovery_needed':False})),'cleanup_deadline':180,'require':api.require,'result':result}
            exec(compile(ast.Module(body=fragment,type_ignores=[]),'<actual-publisher-cleanup>','exec'),env)
            self.assertEqual(calls,['harness-cleanup','observer','pump_close','Docker_cleanup']);self.assertEqual(result['error'],primary);self.assertFalse(result['native_case_acceptance'])
            self.assertNotIn('PRIVATE',json.dumps({k:v for k,v in result.items()if k!='error'}))


class SvmFixtureJournalControls(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='svm-fixture-journal-');self.addCleanup(self.temp.cleanup);self.case=Path(self.temp.name).resolve();(self.case/'evidence').mkdir();self.out=self.case/'worker';self.out.mkdir()
        self.repo=Path(api.__file__).resolve().parents[2]
        spec=importlib.util.spec_from_file_location('svm_fixture_journal_diagnostics',self.repo/'zig/integration/multivm_diagnostics.py');self.module=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.module)
        self.source_name='rust/main/utils/run-locally/src/external_agents.rs';self.source=api.pin(self.repo/self.source_name)
        self.sol={'path':'/admitted/SOL','bytes':123,'sha256':'a'*64};self.docker={'path':'/admitted/docker','bytes':456,'sha256':'b'*64}
        self.inputs={'svm_assets':{'agave_files':{'bin/solana-test-validator':self.sol}}};self.manifest={'scenario':'sealevel-composite','mode':'ReleaseSafe','runtime_source_commit':'c'*40,'verifier_tools':{'docker':self.docker}}
        self.plan={'execution_source_commit':'d'*40,'required_inputs':[self.source,self.sol,self.docker],'diagnostic_rust_sources':{self.source_name:self.source}}
        self.path=self.case/'evidence/fixture-parent-waits.jsonl'
        self.row={'pid':77,'role':'fixture-svm-SOL','executable':self.sol,'parent_pid':42,'os_start_token':'77 42 PRIVATE_NODE_START_AND_PATH','parent_wait_completed':True,'already_exited':True,'forced_kill':False,'success':False,'exit_code':0,'signal':None,'purpose':'fixture_teardown','planned_exit':False}

    def write(self, rows=None):
        self.path.write_text(''.join(json.dumps(row)+'\n'for row in (rows if rows is not None else [self.row])))

    def observe(self):
        with mock.patch.object(api,'diagnostic_module',return_value=self.module):return api.svm_fixture_wait_observation(self.case,self.manifest,self.plan,self.inputs,42,{})

    def publish(self, result=None):
        if result is None:result={'error':{'type':'ValueError','message':'PRIMARY_PRIVATE'},'direct_waits':[{'role':'harness','pid':42,'actual_parent_wait':True,'exit_code':101},{'role':'harness-cleanup','pid':42,'actual_parent_wait':True,'exit_code':101}]}
        original=copy.deepcopy(result)
        with mock.patch.object(api,'snapshot_public_diagnostics',return_value=None),mock.patch.object(api,'diagnostic_module',return_value=self.module):descriptor=api.write_public_failure_diagnostics(self.plan,self.manifest,{},self.case,self.out,result,1,case_inputs=self.inputs)
        self.assertEqual(result,original)
        value=json.loads(Path(descriptor['path']).read_bytes());self.assertNotIn('PRIVATE',json.dumps(value));self.assertIs(value['native_or_timing_credit'],False)
        return value

    def test_actual_failed_harness_publication_retains_preexisting_fixture_status_without_acceptance(self):
        self.write();value=self.publish();observed=value['SVM_fixture_parent_waits'];self.assertEqual(observed['collection_status'],'observed')
        row=observed['rows'][0];self.assertEqual(row['role'],'fixture-svm-SOL');self.assertEqual(row['exit_code'],0);self.assertIs(row['already_exited'],True);self.assertIs(row['success'],False);self.assertIs(row['forced_kill'],False)
        self.assertEqual(row['parent_pid'],42);self.assertEqual(row['executable_sha256'],self.sol['sha256']);self.assertNotIn('executable',row);self.assertNotIn('os_start_token',row);self.assertIs(observed['native_or_timing_or_cleanup_authority'],False)
        self.assertEqual(observed['journal'],{'bytes':self.path.stat().st_size,'sha256':hashlib.sha256(self.path.read_bytes()).hexdigest()})
        self.assertEqual([r['exit_code']for r in value['actual_direct_parent_waits']],[101,101]);self.assertNotIn('/admitted',json.dumps(observed))

    def test_signal_forced_and_standalone_pg_rows_remain_typed_observations(self):
        self.manifest['scenario']='sealevel';self.row.update(exit_code=None,signal=9,forced_kill=True)
        pg={**self.row,'pid':78,'role':'fixture-docker','executable':self.docker,'os_start_token':'78 42 PRIVATE_PG_TOKEN','exit_code':0,'signal':None,'forced_kill':False,'already_exited':False,'success':True,'planned_exit':True,'planned_container_stop':{'kind':'postgres','private_payload':'PRIVATE_NEVER_EXPORT'}}
        self.write([self.row,pg]);value=self.observe();self.assertEqual(len(value['rows']),2);self.assertEqual(value['rows'][0]['signal'],9);self.assertIs(value['rows'][0]['forced_kill'],True);self.assertIs(value['rows'][1]['success'],True);self.assertNotIn('PRIVATE',json.dumps(value));self.assertNotIn('planned_container_stop',json.dumps(value))

    def test_uncertain_parent_wrong_role_executable_unbound_source_or_tool_refuses(self):
        original=copy.deepcopy(self.row)
        for field,value in [('parent_pid',43),('parent_pid',True),('pid',True),('role','relayer'),('role','fixture-docker'),('executable',{**self.sol,'sha256':'f'*64}),('parent_wait_completed',False),('purpose','final'),('signal',True),('exit_code',True),('forced_kill',0),('os_start_token','')]:
            self.row=copy.deepcopy(original);self.row[field]=value;self.write()
            with self.subTest(field=field,value=value),self.assertRaises(ValueError):self.observe()
        self.row=original;self.write()
        for missing in [self.source,self.sol]:
            self.plan['required_inputs']=[p for p in [self.source,self.sol,self.docker]if p!=missing]
            with self.subTest(missing=missing['bytes']),self.assertRaises(ValueError):self.observe()
        self.plan['required_inputs']=[self.source,self.sol,self.docker];self.plan['diagnostic_rust_sources'][self.source_name]={**self.source,'sha256':'f'*64};self.plan['required_inputs'].append(self.plan['diagnostic_rust_sources'][self.source_name])
        with self.assertRaisesRegex(ValueError,'Source changed'):self.observe()

    def test_duplicate_nonfinite_ambiguous_status_or_repeated_identity_refuses_without_raw_output(self):
        self.write();wire=self.path.read_text()
        for malformed in [wire.replace('"pid": 77','"pid": 77, "pid": 78'),wire.replace('"exit_code": 0','"exit_code": NaN'),wire+wire,wire.replace('"signal": null','"signal": 6'),wire.replace('"exit_code": 0','"exit_code": null'),wire.replace('"success": false','"success": true')]:
            self.path.write_text(malformed)
            with self.subTest(size=len(malformed)),self.assertRaises(ValueError):self.observe()
        self.path.write_text('PRIVATE_INVALID_BODY\n');observed=self.publish()['SVM_fixture_parent_waits'];self.assertEqual(observed,{'collection_status':'unavailable','native_or_timing_or_cleanup_authority':False})

    def test_journal_row_and_line_bounds_are_independent_of_valid_typed_content(self):
        rows=[{**self.row,'pid':1000+index,'os_start_token':'unique-token-'+str(index)}for index in range(257)];self.write(rows)
        self.assertLess(self.path.stat().st_size,1024**2)
        with self.assertRaisesRegex(ValueError,'Bounded nonempty'):self.observe()
        self.row['planned_container_stop']={'unexported':'PRIVATE_'+('x'*16384)};self.write()
        with self.assertRaisesRegex(ValueError,'Bounded nonempty'):self.observe()

    def test_missing_oversized_link_or_parent_symlink_fails_before_unbounded_capture(self):
        with self.assertRaises(FileNotFoundError):self.observe()
        with self.path.open('wb')as stream:stream.truncate(1024**2+1)
        with mock.patch.object(self.module.os,'open',wraps=self.module.os.open)as opened:
            with self.assertRaises(ValueError):self.observe()
            self.assertFalse(any(str(call.args[0])==str(self.path)for call in opened.call_args_list))
        self.path.unlink();self.write();link=self.case/'other-link';os.link(self.path,link)
        with self.assertRaises(ValueError):self.observe()
        link.unlink();self.path.unlink();target=self.case/'private-target';target.write_text('PRIVATE_TARGET');self.path.symlink_to(target)
        with self.assertRaises(ValueError):self.observe()
        self.path.unlink();(self.case/'evidence').rmdir();(self.case/'evidence').symlink_to(self.out,target_is_directory=True)
        with self.assertRaises(ValueError):self.observe()

    def test_unavailable_journal_cannot_mask_primary_and_ambiguous_parent_does_not_read_it(self):
        result={'error':{'type':'Primary','message':'PRIVATE_PRIMARY'},'direct_waits':[{'role':'harness','pid':42,'actual_parent_wait':True,'exit_code':101},{'role':'harness-cleanup','pid':43,'actual_parent_wait':True,'exit_code':101}]}
        self.write()
        with mock.patch.object(api,'svm_fixture_wait_observation',side_effect=AssertionError('Must not guess parent'))as projected:value=self.publish(result);projected.assert_not_called()
        self.assertEqual(value['SVM_fixture_parent_waits']['collection_status'],'unavailable')

    def test_actual_success_barriers_remain_before_fixture_wait_acceptance(self):
        import ast
        tree=ast.parse(Path(api.__file__).read_text());worker=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='worker')
        calls=[n for n in ast.walk(worker)if isinstance(n,ast.Call)and ast.unparse(n.func)=='fixture_waits'];self.assertEqual(len(calls),1)
        checks=[n for n in ast.walk(worker)if isinstance(n,ast.Call)and ast.unparse(n.func)=='require'and any(isinstance(arg,ast.Constant)and arg.value=='Actual native Rust/verifier failed'for arg in n.args)];self.assertEqual(len(checks),1);self.assertLess(checks[0].lineno,calls[0].lineno)
        self.assertEqual(ast.unparse(checks[0].args[0]),'code == 0')




if __name__=='__main__':unittest.main()
