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


if __name__=='__main__':unittest.main()
