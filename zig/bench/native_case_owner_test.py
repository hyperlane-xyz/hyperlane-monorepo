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

    def tron_planned_stop_rows(self):
        rows=[]
        for pid,kind,port,code in [(70,'tron',9090,143),(71,'postgres',5432,0)]:
            token=str(pid)+' 42 70 70 S Mon Jan 1 00:00:00 2026 docker'
            rows.append({'pid':pid,'role':'fixture-docker','parent_pid':42,'parent_wait_completed':True,'forced_kill':False,'purpose':'fixture_teardown','already_exited':False,'success':True,'exit_code':code,'signal':None,'planned_exit':True,'os_start_token':token,'planned_container_stop':{'kind':kind,'port':port,'cause':'owned_docker_stop','container_id':'c'*64,'pre_stop_live_identity':token,'already_exited_scope':'before_owned_container_stop','completed_before_original_deadline':True,'exact_owned_CID_absent':True,'acceptance_failed_before_cleanup':False}})
        return rows

    def save_tron_waits(self,rows):
        path=self.root/'tron-waits.jsonl';path.write_text(''.join(json.dumps(row)+'\n'for row in rows));return path

    def test_tron_planned143_preserves_raw_status_and_original_zero_pair(self):
        rows=self.tron_planned_stop_rows()
        try:actual=api.fixture_waits(self.save_tron_waits(rows),'tron',42)
        except ValueError:self.fail('Source-owned planned TRE143 was rejected as zero-only')
        self.assertEqual(actual,rows);self.assertEqual(actual[0]['exit_code'],143);self.assertIsNone(actual[0]['signal']);self.assertTrue(actual[0]['success'])
        rows[0]['exit_code']=0;self.assertEqual(api.fixture_waits(self.save_tron_waits(rows),'tron',42),rows)
        # Generic semantics replays this admitted Source slice with only require
        # supplied. Keep the new planned-status check self-contained there.
        import ast
        source=ast.parse(Path(api.__file__).read_text());fn=next(n for n in source.body if isinstance(n,ast.FunctionDef)and n.name=='fixture_waits')
        wrapper=ast.FunctionDef(name='validate',args=ast.arguments(posonlyargs=[],args=[ast.arg(arg=n)for n in ('rows','scenario','parent')],kwonlyargs=[],kw_defaults=[],defaults=[]),body=fn.body[1:],decorator_list=[])
        env={'require':api.require};exec(compile(ast.fix_missing_locations(ast.Module(body=[wrapper],type_ignores=[])),'actual-fixture-source-replay','exec'),env)
        rows[0]['exit_code']=143;self.assertEqual(env['validate'](rows,'tron',42),rows)


    def test_tron_planned143_rejects_each_missing_changed_or_false_owned_stop_guard(self):
        original=self.tron_planned_stop_rows()
        row_poisons=[('parent_wait_completed',False),('forced_kill',True),('already_exited',True),('success',False),('planned_exit',False),('parent_pid',43),('pid',True),('role','fixture-anvil'),('purpose','final'),('signal',15),('os_start_token',''),('os_start_token','PRIVATE'),('os_start_token','x'*4097)]
        planned_poisons=[('cause','other'),('port',9091),('port',True),('already_exited_scope','after_stop'),('completed_before_original_deadline',False),('exact_owned_CID_absent',False),('acceptance_failed_before_cleanup',True),('pre_stop_live_identity','different'),('container_id','C'*64),('container_id','c'*63),('container_id',None),('extra',True)]
        for group,poisons in [('row',row_poisons),('planned',planned_poisons)]:
            for key,value in poisons:
                rows=copy.deepcopy(original);target=rows[0]if group=='row'else rows[0]['planned_container_stop'];target[key]=value
                with self.subTest(group=group,key=key),self.assertRaises(ValueError):api.fixture_waits(self.save_tron_waits(rows),'tron',42)
        for key in original[0]['planned_container_stop']:
            rows=copy.deepcopy(original);del rows[0]['planned_container_stop'][key]
            with self.subTest(missing=key),self.assertRaises((ValueError,KeyError)):api.fixture_waits(self.save_tron_waits(rows),'tron',42)

    def test_tron_planned143_is_not_pg_other_nonzero_or_OS_signal_authority(self):
        original=self.tron_planned_stop_rows()
        for code in [1,2,125,126,127,130,137,139,255,True]:
            rows=copy.deepcopy(original);rows[0]['exit_code']=code
            with self.subTest(code=code),self.assertRaises(ValueError):api.fixture_waits(self.save_tron_waits(rows),'tron',42)
        rows=copy.deepcopy(original);rows[0]['exit_code']=0;rows[1]['exit_code']=143
        with self.assertRaises(ValueError):api.fixture_waits(self.save_tron_waits(rows),'tron',42)
        rows=copy.deepcopy(original);rows[0]['planned_container_stop']['kind']='foreign'
        with self.assertRaises(ValueError):api.fixture_waits(self.save_tron_waits(rows),'tron',42)
        rows=copy.deepcopy(original);rows[0].update(exit_code=None,signal=15)
        with self.assertRaises(ValueError):api.fixture_waits(self.save_tron_waits(rows),'tron',42)

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


    def test_native_listener_census_vanished_reused_valid_and_final_readiness_gate(self):
        import ast
        executable,home,row,manifest=self.listener_fixture()
        rows={42:row,43:dict(row,pid=43,start='linux-ticks:124')};original=Path.read_bytes
        def read(path):
            if str(path)in {'/proc/42/cmdline','/proc/43/cmdline'}:return b'hypd\0start\0--home\0'+os.fsencode(home)+b'\0'
            return original(path)
        def query(command,**kwargs):
            pid=int(command[command.index('-p')+1]);ports=(26659,26660)if pid==42 else(26665,26666)
            return subprocess.CompletedProcess(command,0,('p'+str(pid)+'\n'+''.join('n127.0.0.1:'+str(port)+'\n'for port in ports)).encode(),b'')
        patches=[mock.patch.object(api.owner,'proc_fallback',return_value=rows),mock.patch.object(api.os,'readlink',return_value=str(executable)),mock.patch.object(Path,'read_bytes',read),mock.patch.object(api.subprocess,'run',side_effect=query)]
        from contextlib import ExitStack
        with ExitStack()as stack:
            for item in patches:stack.enter_context(item)
            with mock.patch.object(api.owner,'_linux_row',side_effect=lambda pid:rows[pid]):
                full={};required=api.native_listener_proof('cosmosnative',manifest,{},self.root,self.root/'unused-lsof',full)
            self.assertEqual(required,[{26659,26660},{26665,26666}]);self.assertEqual({v['pid']for v in full.values()},{42,43})
            for prior in [{},copy.deepcopy(full)]:
                with self.subTest(existing=bool(prior)):
                    expected=copy.deepcopy(prior)
                    with mock.patch.object(api.owner,'_linux_row',return_value=None):
                        try:api.native_listener_proof('cosmosnative',manifest,{},self.root,self.root/'unused-lsof',prior)
                        except ValueError:self.fail('A vanished census PID must add no proof, not report PID reuse')
                    self.assertEqual(prior,expected)
            with mock.patch.object(api.owner,'_linux_row',return_value=dict(row,start='linux-ticks:999')),self.assertRaisesRegex(ValueError,'Native PID changed'):
                api.native_listener_proof('cosmosnative',manifest,{},self.root,self.root/'unused-lsof',{})
            bad=subprocess.CompletedProcess([],0,b'p42\nn0.0.0.0:26659\nn0.0.0.0:26660\n',b'')
            with mock.patch.object(api.owner,'_linux_row',return_value=row),mock.patch.object(api.subprocess,'run',return_value=bad),self.assertRaisesRegex(ValueError,'not loopback'):
                api.native_listener_proof('cosmosnative',manifest,{},self.root,self.root/'unused-lsof',{})
        # Exercise the unchanged final production gate: an empty or partial
        # census must never become successful readiness after a vanished PID.
        tree=ast.parse(Path(api.__file__).read_text())
        gate=next(n for n in ast.walk(tree)if isinstance(n,ast.Expr)and isinstance(n.value,ast.Call)and isinstance(n.value.func,ast.Name)and n.value.func.id=='require'and len(n.value.args)==2 and isinstance(n.value.args[1],ast.Constant)and n.value.args[1].value=='Actual native loopback listener proof missing')
        for proofs in [{},dict(list(full.items())[:1]),full]:
            scope={'require':api.require,'node_proofs':proofs,'plan':{'scenario':'cosmosnative'}}
            if proofs==full:exec(compile(ast.Module([gate],type_ignores=[]),'<actual-final-listener-gate>','exec'),scope)
            else:
                with self.assertRaisesRegex(ValueError,'listener proof missing'):exec(compile(ast.Module([gate],type_ignores=[]),'<actual-final-listener-gate>','exec'),scope)

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


    def test_late_invariant_projection_is_failure_only_optional_and_preserves_primary(self):
        from types import SimpleNamespace
        for scenario in ['evm','sealevel','sealevel-composite','tron','radix']:
            for failed in [False,True]:
                case=self.root/('late-'+scenario+str(failed));case.mkdir();out=case/'worker';out.mkdir();primary={'type':'RuntimeError','message':'PRIVATE_PRIMARY'};result={'error':primary,'direct_waits':[{'role':'harness-cleanup','pid':42,'actual_parent_wait':True,'exit_code':-15}]};sources={'fixed-source':'fixed-pin'};projected={'schema':1,'collection_status':'observed','observations':[],'native_or_timing_or_cleanup_authority':False};method=mock.Mock(side_effect=ValueError('PRIVATE_COLLECTOR')if failed else None,return_value=projected);module=SimpleNamespace(late_invariant_observation=method)
                with mock.patch.object(api,'snapshot_public_diagnostics',return_value=None),mock.patch.object(api,'diagnostic_module',return_value=module):descriptor=api.write_public_failure_diagnostics({'execution_source_commit':'b'*40,'diagnostic_rust_sources':sources},{'scenario':scenario,'mode':'ReleaseSafe','runtime_source_commit':'a'*40},{},case,out,result,90)
                value=json.loads(Path(descriptor['path']).read_bytes())
                if scenario=='radix':method.assert_not_called();self.assertNotIn('late_termination_invariants',value)
                else:
                    method.assert_called_once_with(scenario,sources,Path(api.__file__).resolve().parents[2],out/'harness.log');self.assertEqual(value['late_termination_invariants'],{'collection_status':'unavailable','native_or_timing_or_cleanup_authority':False}if failed else projected)
                self.assertIs(result['error'],primary);self.assertEqual(result['direct_waits'][0]['exit_code'],-15);self.assertFalse(value['native_or_timing_credit']);self.assertNotIn('PRIVATE',json.dumps(value));self.assertLess(descriptor['bytes'],512*1024)

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


    def test_EVM828_actual_failure_publisher_retains_separate_text_guard_and_primary(self):
        case,out,approval,module,recorder,token,state=self.public_diagnostic_fixture();recorder.finish(token,{**state,'observed_monotonic_ns':120},'exception',RuntimeError('PRIVATE_OBSERVER'))
        repo=self.root/'evm-repo';sources={}
        for name in ['rust/main/utils/run-locally/src/main.rs','rust/main/utils/run-locally/src/external_agents.rs']:
            p=repo/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes((Path(__file__).resolve().parents[2]/name).read_bytes());sources[name]=api.pin(p)
        (out/'harness.log').write_bytes(b"thread 'PRIVATE_THREAD' (42) panicked at utils/run-locally/src/main.rs:828:48:\ncalled `Result::unwrap()` on an `Err` value: Custom { kind: Other, error: \"fixture descendant executable not approved PRIVATE_KEY /PRIVATE_PATH\" }\n")
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
        repo=Path(api.__file__).resolve().parents[2];here=repo/'zig/integration';self.modules={name:diagnostic.pin(here/name)for name in ['multivm_session.py','multivm_evidence.py']}
        # Synthetic producer/consumer closure; never grants native execution.
        epoch='1'*40;execution='2'*40
        log=self.root/'compiled-source-check.json';log.write_text('{}\n')
        scopes={category:[{'path':path,'producer_tree':None if path=='zig/build.zig.zon'else'3'*40,'current_tree':None if path=='zig/build.zig.zon'else'3'*40,'worktree_unchanged':True}for path in paths]for category,paths in {'runtime':('zig/src','zig/native','zig/build.zig','zig/build.zig.zon'),'helper':('rust/main','rust/sealevel'),'tools':('rust/main','rust/sealevel','zig/reference')}.items()}
        self.closure={'schema':1,'runtime_source_commit':epoch,'helper_source_commit':epoch,'tools_source_commit':epoch,'execution_source_commit':execution,'source_unchanged':True,'native_case_acceptance':False,'scopes':scopes,'checks':[{'exit_code':0,'log':diagnostic.pin(log)}]}
        self.closure_path=self.root/'compiled-input-closure.json';self.closure_path.write_text(json.dumps(self.closure))
        self.approval={'root_approved':True,'scenario':'evm','runtime_source_commit':epoch,'execution_source_commit':execution,'compiled_input_closure':diagnostic.pin(self.closure_path),'python_modules':self.modules,'diagnostic_relayer_sources':{relative:{'path':str(repo/relative),'bytes':size,'sha256':digest}for relative,size,digest in diagnostic.RELAYER_STARTUP_SOURCE}}
        self.approval_path=self.root/'approval.json';self.approval_path.write_text(json.dumps(self.approval))
        self.manifest={'scenario':'evm','runtime_source_commit':epoch,'execution_approval':diagnostic.pin(self.approval_path)}
        self.manifest['artifacts']={'relayer':api.pin(self.product)}
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
        tree=ast.parse(Path(api.__file__).read_text());worker=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='worker');loop=next(n for n in ast.walk(worker)if isinstance(n,ast.While)and ast.unparse(n.test)=='harness.poll() is None');calls=[];code=[None];harness=self.simple(poll=lambda:code[0]);state=self.simple(begin_custody=lambda:calls.append('begin'));radix=self.simple(observe=lambda:calls.append('ordinary_custody'));memory=[]
        def observe_memory(deadline,cancelled):self.assertFalse(cancelled());memory.append(cancelled);calls.append(('memory',deadline))
        radix.observe_memory=observe_memory
        def done(_):code[0]=101
        env={'harness':harness,'controller':self.simple(poll=lambda:None),'require':api.require,'deadline':3,'next_inspect':0,'inspect':lambda:calls.append('PG'),'radix':radix,'radix_publisher':None,'radix_transport':{'state':state},'radix_scraper':None,'observe_radix_scraper':lambda *args:calls.append(('SCR_metrics',args[-1])),'observe_radix_transport':lambda *args:calls.append(('Radix_HTTP',args[-1])),'startup_context':None,'observe_relayer_startup':lambda *args:None,'manifest':self.manifest,'inputs':{},'case':self.root,'helper_row':{},'args':self.simple(original_deadline_ns=3_000_000_000),'time':self.simple(monotonic=lambda:1,monotonic_ns=lambda:1_000_000_000,sleep=done)}
        exec(compile(ast.Module(body=[loop],type_ignores=[]),'<actual-Radix-inspection-loop>','exec'),env);self.assertEqual(calls,['PG','begin','ordinary_custody',('memory',1_500_000_000),('Radix_HTTP',1_500_000_000),('SCR_metrics',1_500_000_000)]);self.assertEqual(env['next_inspect'],2);self.assertEqual(len(memory),1);self.assertTrue(memory[0]())
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
        calls=[];code=[None];harness=types.SimpleNamespace(poll=lambda:code[0]);memory=[]
        def observe_memory(deadline,cancelled):self.assertFalse(cancelled());memory.append(cancelled);calls.append(('memory',deadline))
        publisher=types.SimpleNamespace(check=lambda:calls.append('pump_check'),observe=lambda:calls.append('new_lease'))
        def done(value):self.assertEqual(value,.1);code[0]=0
        env={'harness':harness,'controller':types.SimpleNamespace(poll=lambda:None),'require':api.require,'deadline':3,'next_inspect':0,'inspect':lambda:calls.append('PG'),'radix':types.SimpleNamespace(observe=lambda:calls.append('ordinary_custody'),observe_memory=observe_memory),'radix_publisher':publisher,'radix_transport':None,'radix_scraper':None,'observe_radix_scraper':lambda *args:calls.append(('SCR_metrics',args[-1])),'observe_radix_transport':lambda *args:calls.append(('diagnostic_HTTP',args[-1])),'observe_relayer_startup':lambda *args:None,'startup_context':None,'manifest':{},'inputs':{},'case':None,'helper_row':{},'args':types.SimpleNamespace(original_deadline_ns=3_000_000_000),'time':types.SimpleNamespace(monotonic=lambda:1,monotonic_ns=lambda:1_000_000_000,sleep=done)}
        exec(compile(ast.Module(body=[loop],type_ignores=[]),'<actual-publisher-worker-loop>','exec'),env)
        self.assertEqual(calls,['pump_check','PG','ordinary_custody','new_lease',('memory',1_500_000_000),('diagnostic_HTTP',1_500_000_000),('SCR_metrics',1_500_000_000)]);self.assertEqual(env['next_inspect'],2);self.assertEqual(len(memory),1);self.assertTrue(memory[0]())
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




class RadixSubmitOwnerControls(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name).resolve();self.repo=Path(api.__file__).resolve().parents[2]
        names=['rust/main/chains/hyperlane-radix/src/error.rs','rust/main/hyperlane-core/src/error.rs','rust/main/hyperlane-core/src/rpc_clients/error.rs'];self.sources={n:{'path':str(self.repo/n),'bytes':1,'sha256':'c'*64}for n in names};self.lock={'path':str(self.repo/'rust/main/Cargo.lock'),'bytes':1,'sha256':'d'*64};self.plan={'execution_source_commit':'b'*40,'diagnostic_rust_sources':self.sources,'diagnostic_radix_client_lock':self.lock,'required_inputs':[*self.sources.values(),self.lock]}
    def test_admission_requires_fixed_paths_required_inputs_and_original_total(self):
        self.assertIs(api.admitted_radix_submit_context(self.plan,self.repo),self.lock)
        for key in ['diagnostic_radix_client_lock','diagnostic_rust_sources']:
            bad=copy.deepcopy(self.plan);bad.pop(key)
            with self.assertRaises(ValueError):api.admitted_radix_submit_context(bad,self.repo)
        bad=copy.deepcopy(self.plan);bad['required_inputs']=list(self.sources.values())
        with self.assertRaisesRegex(ValueError,'exact required input'):api.admitted_radix_submit_context(bad,self.repo)
        bad=copy.deepcopy(self.plan);bad['diagnostic_radix_client_lock']['path']='/PRIVATE_PATH'
        with self.assertRaisesRegex(ValueError,'exact required input'):api.admitted_radix_submit_context(bad,self.repo)
        bad=copy.deepcopy(self.plan);bad['diagnostic_radix_client_lock']['bytes']=1024**2+1
        with self.assertRaises(ValueError):api.admitted_radix_submit_context(bad,self.repo)
    def test_actual_failure_publisher_retains_observation_none_unavailable_and_primary(self):
        from types import SimpleNamespace
        for observed in [None,{'collection_status':'unavailable','reason':'SOURCE_CONTEXT_UNAVAILABLE'},{'collection_status':'observed','envelope':'FALLBACK_PROVIDERS_FAILED','errors':[{'variant':'ResponseError','http_status_text':400,'gateway_error_type_text':'InvalidTransactionError'}]}]:
            log=self.root/'harness.log';log.write_bytes(b'public synthetic capture');result={'error':{'type':'ValueError','message':'PRIVATE_PRIMARY'},'direct_waits':[{'role':'harness','pid':42,'actual_parent_wait':True,'exit_code':101}]};before=copy.deepcopy(result);rust={'sites':[],'reason_codes':[],'reason_source':None,'log_fingerprint':None,'Radix_submit_error_text':observed};method=mock.Mock(return_value=rust);module=SimpleNamespace(rust_panic_observation=method,fixture_failure_observation=mock.Mock(return_value={}))
            with mock.patch.object(api,'snapshot_public_diagnostics',return_value=None),mock.patch.object(api,'diagnostic_module',return_value=module):row=api.write_public_failure_diagnostics(self.plan,{'scenario':'radix','mode':'ReleaseSafe','runtime_source_commit':'a'*40},{},self.root,self.root,result,1)
            value=json.loads(Path(row['path']).read_text());self.assertIn('Radix_submit_error_text',value);self.assertEqual(value['Radix_submit_error_text'],observed);self.assertIn('radix_client_lock',method.call_args.kwargs);self.assertIs(method.call_args.kwargs['radix_client_lock'],self.lock);self.assertEqual(result,before);self.assertNotIn('PRIVATE',json.dumps(value));self.assertFalse(value['native_or_timing_credit']);Path(row['path']).unlink()
    def test_load_plan_calls_admission_only_for_Radix(self):
        import ast
        tree=ast.parse(Path(api.__file__).read_bytes());fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='load_plan');calls=[n for n in ast.walk(fn)if isinstance(n,ast.Call)and isinstance(n.func,ast.Name)and n.func.id=='admitted_radix_submit_context'];self.assertEqual(len(calls),1);branch=next(n for n in ast.walk(fn)if isinstance(n,ast.If)and any(c is calls[0]for c in ast.walk(n)));self.assertEqual(ast.unparse(branch.test),"plan['scenario'] == 'radix'")


class SvmEncryptedWindowOwnerControls(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve()
        source=Path(api.__file__).resolve().parents[1]/'integration/multivm_diagnostics.py';spec=importlib.util.spec_from_file_location('svm_window_diag',source);self.module=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.module)
        self.node=self.root/'node';self.node.write_bytes(b'\x7fELF\x02\x01'+b'0'*58);self.node.chmod(0o755);row=api.pin(self.node)
        self.plan={'diagnostic_node':row,'required_inputs':[row]};self.plain=b'PRIVATE\xff\x00';self.selection={'windows':[{'tag':t,'position':position,'bytes':len(self.plain)if i==0 else 0}for i,(t,position)in enumerate([('SOL','first'),('SOL','tail'),('SCR','first'),('SCR','tail')])],'oversized_lines_omitted':0,'scope':'fixed'}
        (self.root/'helper-launch.json').write_text(json.dumps({'helper_pid':42,'helper_start':'linux-ticks:1'}))
        self.result={'direct_waits':[{'role':'harness','pid':42,'actual_parent_wait':True,'exit_code':101},{'role':'observer','pid':43,'actual_parent_wait':True,'exit_code':0}],'_svm_diagnostic_roles':[{'pid':50,'os_start_token_sha256':hashlib.sha256(b'linux-ticks:2').hexdigest()}],'error':{'message':'PRIMARY_PRIVATE'},'passed':False}
        self.original=copy.deepcopy(self.result)
    def run_probe(self,rows=None,**changes):
        module=changes.pop('module',self.module);end=changes.pop('end',time.monotonic_ns()+5_000_000_000)
        with mock.patch.object(api.sys,'platform','linux'),mock.patch.object(api.owner,'proc_fallback',return_value={}if rows is None else rows),mock.patch.object(api.owner,'_linux_row',return_value={'pid':123456789,'sid':123456789,'pgid':123456789,'start':'linux-ticks:900'}):
            return api.svm_encrypt_failure_windows(changes.get('plan',self.plan),module,changes.get('plain',self.plain),changes.get('selection',self.selection),self.root,self.result,end)
    def test_known_descendant_group_birth_and_expired_refuse_before_child(self):
        self.result['_svm_diagnostic_roles'][0]['os_start_token_sha256']=hashlib.sha256(b'50 42 Mon Nov 9 00:00:00 2026 relayer').hexdigest();self.original=copy.deepcopy(self.result)
        known={'pid':50,'sid':999,'pgid':999,'start':'linux-ticks:2'}
        for row in [known,{**known,'pid':51,'sid':42},{**known,'pid':51,'pgid':43}]:
            with mock.patch.object(api.subprocess,'Popen')as popen:
                value=self.run_probe({row['pid']:row});self.assertEqual(value['collection_status'],'unavailable');popen.assert_not_called()
        with mock.patch.object(api.subprocess,'Popen')as popen:
            self.assertEqual(self.run_probe(end=0)['collection_status'],'unavailable');popen.assert_not_called()
        self.assertEqual(self.result,self.original)
    def test_changed_node_missing_descriptor_and_private_metadata_refuse(self):
        for plan in [{'required_inputs':[]},{'diagnostic_node':{**self.plan['diagnostic_node'],'sha256':'a'*64},'required_inputs':[self.plan['diagnostic_node']]}]:
            with mock.patch.object(api.subprocess,'Popen')as popen:self.assertEqual(self.run_probe(plan=plan)['collection_status'],'unavailable');popen.assert_not_called()
        bad=copy.deepcopy(self.selection);bad['windows'][0]['private']='PRIVATE'
        with mock.patch.object(api.subprocess,'Popen')as popen:self.assertEqual(self.run_probe(selection=bad)['collection_status'],'unavailable');popen.assert_not_called()
    def fake_child(self,wire,returncode=0):
        read_in,write_in=os.pipe();read_out,write_out=os.pipe();os.write(write_out,wire);os.close(write_out);self.addCleanup(os.close,read_in)
        child=mock.Mock();child.pid=123456789;child.stdin=os.fdopen(write_in,'wb',buffering=0);child.stdout=os.fdopen(read_out,'rb',buffering=0);child.poll.return_value=returncode;child.wait.return_value=returncode;self.addCleanup(child.stdin.close);self.addCleanup(child.stdout.close);return child
    def test_actual_owned_pipe_protocol_clean_environment_and_primary_preserved(self):
        import base64
        payload={'schema':1,'key_id':self.module.SVM_ENCRYPTION_KEY_ID,'blocks':[base64.b64encode(b'x'*512).decode()],'limits':{name:[None if value==api.resource.RLIM_INFINITY else value for value in api.resource.getrlimit(kind)]for name,kind in [('address_space',api.resource.RLIMIT_AS),('open_files',api.resource.RLIMIT_NOFILE)]}};child=self.fake_child(json.dumps(payload).encode())
        with mock.patch.dict(os.environ,{'FOREIGN_CREDENTIAL_SENTINEL':'PRIVATE'},clear=False),mock.patch.object(api.subprocess,'Popen',return_value=child)as popen:
            value=self.run_probe();self.assertEqual(value['collection_status'],'encrypted');self.assertTrue(value['actual_parent_wait']);self.assertEqual(value['child_exit_code'],0)
            args,kwargs=popen.call_args;self.assertEqual(kwargs['env'],{'PATH':'/usr/bin:/bin','LC_ALL':'C.UTF-8'});self.assertEqual(kwargs['stderr'],subprocess.DEVNULL);self.assertTrue(kwargs['start_new_session']);self.assertNotIn('PRIVATE',str(args));self.assertEqual(args[0][-1],self.module.SVM_ENCRYPTION_SCRIPT)
        self.assertNotIn('PRIVATE',json.dumps(value));self.assertEqual(self.result,self.original)
    def test_nonzero_unknown_output_cancellation_and_trickle_preserve_primary(self):
        for wire,code in [(b'PRIVATE',0),(b'{}',2)]:
            child=self.fake_child(wire,code)
            with mock.patch.object(api.subprocess,'Popen',return_value=child):value=self.run_probe();self.assertEqual(value['collection_status'],'unavailable');self.assertNotIn('PRIVATE',json.dumps(value))
        child=self.fake_child(b'',None);child.wait.return_value=-9
        with mock.patch.object(api.subprocess,'Popen',return_value=child),mock.patch.object(api.select,'select',side_effect=KeyboardInterrupt('PRIVATE')),mock.patch.object(api.os,'killpg')as kill:
            self.assertEqual(self.run_probe()['collection_status'],'unavailable');kill.assert_called_once_with(child.pid,api.signal.SIGKILL);child.wait.assert_called()
        child=self.fake_child(b'',None);child.wait.return_value=-9;clock=[0]
        def now():clock[0]+=10_000_000;return clock[0]
        with mock.patch.object(api.subprocess,'Popen',return_value=child),mock.patch.object(api.select,'select',return_value=([],[],[])),mock.patch.object(api.time,'monotonic_ns',side_effect=now),mock.patch.object(api.os,'killpg')as kill:
            value=self.run_probe(end=3_000_000_000);self.assertEqual(value['collection_status'],'unavailable');kill.assert_called_once();self.assertLess(clock[0],3_100_000_000)
        self.assertEqual(self.result,self.original)
    def test_actual_worker_supplies_original_deadline_to_optional_publisher(self):
        import ast,inspect,textwrap
        tree=ast.parse(textwrap.dedent(inspect.getsource(api.worker)))
        calls=[n for n in ast.walk(tree)if isinstance(n,ast.Call)and isinstance(n.func,ast.Name)and n.func.id=='write_public_failure_diagnostics']
        self.assertEqual(len(calls),1);binding=[k.value for k in calls[0].keywords if k.arg=='original_deadline_ns'];self.assertEqual(len(binding),1);self.assertIsInstance(binding[0],ast.Attribute);self.assertEqual(binding[0].attr,'original_deadline_ns');self.assertIsInstance(binding[0].value,ast.Name);self.assertEqual(binding[0].value.id,'args')
    def test_late_wait_and_kill_failures_never_publish_candidate_ciphertext(self):
        import base64
        wire=json.dumps({'schema':1,'key_id':self.module.SVM_ENCRYPTION_KEY_ID,'blocks':[base64.b64encode(b'x'*512).decode()],'limits':{name:[None if value==api.resource.RLIM_INFINITY else value for value in api.resource.getrlimit(kind)]for name,kind in [('address_space',api.resource.RLIMIT_AS),('open_files',api.resource.RLIMIT_NOFILE)]}}).encode()
        child=self.fake_child(wire);child.wait.side_effect=[0,subprocess.TimeoutExpired('PRIVATE',.1)]
        with mock.patch.object(api.subprocess,'Popen',return_value=child):
            value=self.run_probe();self.assertEqual(value['collection_status'],'unavailable');self.assertTrue(value['owned_cleanup_debt']);self.assertNotIn('blocks',value)
        child=self.fake_child(b'',None)
        with mock.patch.object(api.subprocess,'Popen',return_value=child),mock.patch.object(api.select,'select',side_effect=KeyboardInterrupt('PRIVATE')),mock.patch.object(api.os,'killpg',side_effect=OSError('PRIVATE')):
            value=self.run_probe();self.assertEqual(value['collection_status'],'unavailable');self.assertTrue(value['owned_cleanup_debt']);self.assertFalse(value['actual_parent_wait']);self.assertNotIn('PRIVATE',json.dumps(value))
        self.assertEqual(self.result,self.original)
    def test_actual_publisher_retains_ciphertext_only_and_original_verdict(self):
        case=self.root/'case';case.mkdir();out=self.root/'worker';out.mkdir();(out/'harness.log').write_bytes(b'<SOL> PRIVATE\n')
        module=mock.Mock();module.late_invariant_observation.return_value={'collection_status':'unavailable','native_or_timing_or_cleanup_authority':False};module.rust_panic_observation.return_value={'sites':[],'reason_codes':[],'reason_source':None,'log_fingerprint':None};module.svm_private_windows.return_value=(self.plain,self.selection)
        def observe(*args,**kwargs):kwargs['private_capture'](b'<SOL> PRIVATE\n');return {'roles':self.result['_svm_diagnostic_roles']}
        module.role_failure_observation.side_effect=observe
        proof={'schema':1,'collection_status':'encrypted','blocks':['ciphertext-only'],'native_or_timing_or_cleanup_authority':False}
        plan={**self.plan,'execution_source_commit':'a'*40,'diagnostic_rust_sources':{},'diagnostic_zig_sources':{}};manifest={'scenario':'sealevel','mode':'ReleaseSafe','runtime_source_commit':'b'*40}
        with mock.patch.object(api,'snapshot_public_diagnostics',return_value=None),mock.patch.object(api,'diagnostic_module',return_value=module),mock.patch.object(api,'svm_fixture_wait_observation',return_value={'status':'unavailable'}),mock.patch.object(api,'svm_encrypt_failure_windows',return_value=proof)as encrypt:
            descriptor=api.write_public_failure_diagnostics(plan,manifest,{},case,out,self.result,1,original_deadline_ns=time.monotonic_ns()+9_000_000_000)
            value=json.loads(Path(descriptor['path']).read_bytes());self.assertEqual(value['SVM_encrypted_fixture_windows'],proof);self.assertFalse(value['native_or_timing_credit']);self.assertEqual(value['late_termination_invariants'],{'collection_status':'unavailable','native_or_timing_or_cleanup_authority':False});module.late_invariant_observation.assert_called_once();encrypt.assert_called_once()
        self.assertNotIn('PRIVATE',json.dumps(value));self.assertEqual(self.result,self.original)


class TronPostwaitEncryptionOwnerControls(unittest.TestCase):
    def setUp(self):
        self.f=SvmEncryptedWindowOwnerControls();self.f.setUp();self.addCleanup(self.f.doCleanups);self.root=self.f.root;self.module=self.f.module;self.node=self.f.plan['diagnostic_node']
        self.version=self.root/'node-version.log';self.version.write_bytes(b'v26.12.1\n');self.stagepath=self.root/'local-stage.json'
        self.stage={'schema':1,'passed':True,'scenario':'tron','execution_source_commit':'b'*40,'tools':{'node':self.node},'checks':[{'name':'node-version','log':api.pin(self.version)}]}
        self.plan={'scenario':'tron','execution_source_commit':'b'*40,'diagnostic_rust_sources':{},'required_inputs':[self.node,api.pin(self.version)]};self.approval={};self.stage_update()
        self.plain=b'Error: PRIVATE_TRON_SECRET';self.selection={'windows':[{'tag':'PNPM_NATIVE','position':'first_error','bytes':len(self.plain),'truncated':False}],'oversized_lines_omitted':0,'scope':'fixed'}
    def stage_update(self):
        self.stagepath.write_text(json.dumps(self.stage));row=api.pin(self.stagepath);self.plan['required_inputs']=[v for v in self.plan['required_inputs']if v.get('path')!=str(self.stagepath)]+[row];self.approval['local_stage']=row
    def test_only_existing_required_stage_Node_and_version_descriptor_admitted(self):
        self.assertEqual(api.admitted_tron_failure_node(self.plan,self.approval,self.module,time.monotonic_ns()+5_000_000_000),self.node)
        original=copy.deepcopy(self.stage)
        for field,value in [('passed',False),('scenario','evm'),('execution_source_commit','c'*40),('schema',True)]:
            self.stage=copy.deepcopy(original);self.stage[field]=value;self.stage_update()
            with self.subTest(field=field),self.assertRaises(ValueError):api.admitted_tron_failure_node(self.plan,self.approval,self.module,time.monotonic_ns()+5_000_000_000)
        self.stage=original;self.stage_update();bad=copy.deepcopy(self.plan);bad['required_inputs'].remove(self.node)
        with self.assertRaisesRegex(ValueError,'admitted stage Node'):api.admitted_tron_failure_node(bad,self.approval,self.module,time.monotonic_ns()+5_000_000_000)
        self.version.write_bytes(b'v26.12.2\n');self.plan['required_inputs']=[self.node,api.pin(self.version)];self.stage['checks'][0]['log']=api.pin(self.version);self.stage_update()
        with self.assertRaisesRegex(ValueError,'Actual Node version'):api.admitted_tron_failure_node(self.plan,self.approval,self.module,time.monotonic_ns()+5_000_000_000)
    def test_expired_or_wrongscenario_refuses_before_stage_IO(self):
        for plan,end in [(self.plan,0),({**self.plan,'scenario':'evm'},time.monotonic_ns()+5_000_000_000)]:
            with mock.patch.object(self.module,'captured_failure_bytes',side_effect=AssertionError('no IO'))as read:
                with self.assertRaises(ValueError):api.admitted_tron_failure_node(plan,self.approval,self.module,end)
                read.assert_not_called()
    def probe(self,selection=None):
        with mock.patch.object(api.sys,'platform','linux'),mock.patch.object(api.owner,'proc_fallback',return_value={}),mock.patch.object(api.owner,'_linux_row',return_value={'pid':123456789,'sid':123456789,'pgid':123456789,'start':'linux-ticks:900'}):return api.svm_encrypt_failure_windows({**self.plan,'diagnostic_node':self.node},self.module,self.plain,self.selection if selection is None else selection,self.root,self.f.result,time.monotonic_ns()+5_000_000_000,window_mode='tron')
    def test_owned_Tron_pipe_protocol_uses_same_script_limits_wait_and_no_plain_export(self):
        import base64
        wire=json.dumps({'schema':1,'key_id':self.module.SVM_ENCRYPTION_KEY_ID,'blocks':[base64.b64encode(b'x'*512).decode()],'limits':{name:[None if v==api.resource.RLIM_INFINITY else v for v in api.resource.getrlimit(kind)]for name,kind in [('address_space',api.resource.RLIMIT_AS),('open_files',api.resource.RLIMIT_NOFILE)]}}).encode();child=self.f.fake_child(wire)
        with mock.patch.object(api.subprocess,'Popen',return_value=child)as popen:
            before=copy.deepcopy(self.f.result);value=self.probe();self.assertEqual(value['collection_status'],'encrypted');self.assertEqual(value['windows'],self.selection['windows']);self.assertTrue(value['actual_parent_wait']);self.assertTrue(value['owned_group_absent_after_wait']);self.assertEqual(value['child_exit_code'],0);self.assertEqual(self.f.result,before)
            self.assertEqual(popen.call_args.args[0][-1],self.module.SVM_ENCRYPTION_SCRIPT);self.assertEqual(popen.call_args.kwargs['env'],{'PATH':'/usr/bin:/bin','LC_ALL':'C.UTF-8'});self.assertNotIn('PRIVATE_TRON_SECRET',json.dumps(value));self.assertIn('original CLI PID/epoch/typed cause unknown',value['scope'])
    def test_wrongtag_extra_frame_or_malformed_metadata_refuses_before_child(self):
        for change in ('tag','count','extra','truncated'):
            selection=copy.deepcopy(self.selection)
            if change=='tag':selection['windows'][0]['tag']='SOL'
            elif change=='count':selection['windows']*=2
            elif change=='extra':selection['windows'][0]['private']='PRIVATE'
            else:selection['windows'][0]['truncated']=1
            with self.subTest(change=change),mock.patch.object(api.subprocess,'Popen')as child:self.assertEqual(self.probe(selection)['collection_status'],'unavailable');child.assert_not_called()
    def test_actual_failure_publisher_callback_same_deadline_primary_and_closed_capsule(self):
        from types import SimpleNamespace
        out=self.root/'publication';out.mkdir();(out/'harness.log').write_bytes(b'SYNTHETIC bounded pipe');result=copy.deepcopy(self.f.result);before=copy.deepcopy(result)
        def fixture(*args,**kwargs):kwargs['private_capture'](self.plain,self.selection);return {'CLI_failure':{'collection_status':'observed'}}
        module=SimpleNamespace(rust_panic_observation=lambda *a,**k:{'sites':[],'reason_codes':[],'reason_source':None,'log_fingerprint':None},fixture_failure_observation=fixture)
        capsule={'schema':1,'collection_status':'encrypted','blocks':['OPAQUE_CIPHER'],'native_or_timing_or_cleanup_authority':False};deadline=time.monotonic_ns()+9_000_000_000
        with mock.patch.object(api,'snapshot_public_diagnostics',return_value=None),mock.patch.object(api,'diagnostic_module',return_value=module),mock.patch.object(api,'admitted_tron_failure_node',return_value=self.node)as admit,mock.patch.object(api,'svm_encrypt_failure_windows',return_value=capsule)as encrypt:
            descriptor=api.write_public_failure_diagnostics(self.plan,{'scenario':'tron','mode':'ReleaseSafe','runtime_source_commit':'a'*40},self.approval,self.root,out,result,1,case_inputs={},original_deadline_ns=deadline)
        value=json.loads(Path(descriptor['path']).read_bytes());self.assertEqual(value['Tron_encrypted_deploy_error'],capsule);self.assertEqual(result,before);self.assertNotIn('PRIVATE',json.dumps(value));encrypt.assert_called_once();self.assertEqual(encrypt.call_args.kwargs,{'window_mode':'tron'});self.assertEqual(admit.call_args.args[-1],encrypt.call_args.args[-1]);self.assertLessEqual(encrypt.call_args.args[-1],deadline)
    def test_admission_exception_or_no_capture_preserves_primary_unavailable_without_child(self):
        from types import SimpleNamespace
        for capture in (False,True):
            out=self.root/('unavailable-'+str(capture));out.mkdir();(out/'harness.log').write_bytes(b'SYNTHETIC');result=copy.deepcopy(self.f.result);before=copy.deepcopy(result)
            def fixture(*args,**kwargs):
                if capture:kwargs['private_capture'](self.plain,self.selection)
                return {'CLI_failure':{'collection_status':'observed'}}
            module=SimpleNamespace(rust_panic_observation=lambda *a,**k:{'sites':[],'reason_codes':[],'reason_source':None,'log_fingerprint':None},fixture_failure_observation=fixture)
            with mock.patch.object(api,'snapshot_public_diagnostics',return_value=None),mock.patch.object(api,'diagnostic_module',return_value=module),mock.patch.object(api,'admitted_tron_failure_node',side_effect=KeyboardInterrupt('PRIVATE')),mock.patch.object(api,'svm_encrypt_failure_windows')as encrypt:
                descriptor=api.write_public_failure_diagnostics(self.plan,{'scenario':'tron','mode':'ReleaseSafe','runtime_source_commit':'a'*40},self.approval,self.root,out,result,1,case_inputs={},original_deadline_ns=time.monotonic_ns()+5_000_000_000)
            self.assertEqual(json.loads(Path(descriptor['path']).read_bytes())['Tron_encrypted_deploy_error']['collection_status'],'unavailable');self.assertEqual(result,before);encrypt.assert_not_called()


@unittest.skipUnless(sys.platform=='linux','Requires actual Linux /proc and CI-pinned Node26; no Mac ownership claim')
class SvmEncryptedLinuxComponentControls(unittest.TestCase):
    def test_actual_node26_owned_pipes_limits_wait_absence_small_max_exit_and_deadline(self):
        import shutil
        import types
        with tempfile.TemporaryDirectory(prefix='synthetic-svm-cipher-component-')as directory:
            root=Path(directory).resolve();repo=Path(api.__file__).resolve().parents[2]
            spec=importlib.util.spec_from_file_location('linux_svm_component_diagnostics',repo/'zig/integration/multivm_diagnostics.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
            # Test-only local admission; never a case/tool-stage/native acceptance receipt.
            node=Path(shutil.which('node')or'/absent').resolve(strict=True);descriptor=api.pin(node)
            elf_spec=importlib.util.spec_from_file_location('linux_svm_component_elf',repo/'zig/bench/native_case_tools.py');elf=importlib.util.module_from_spec(elf_spec);elf_spec.loader.exec_module(elf)
            elf.validate_elf(node,{'x86_64':62,'aarch64':183}[os.uname().machine])
            helper=subprocess.Popen([sys.executable,'-I','-B','-c','pass'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
            try:
                birth=api.owner._linux_row(helper.pid);self.assertIsNotNone(birth);status=helper.wait(timeout=2);self.assertEqual(status,0)
            finally:
                if helper.poll()is None:helper.kill();helper.wait(timeout=1)
            (root/'helper-launch.json').write_text(json.dumps({'helper_pid':helper.pid,'helper_start':birth['start']}))
            plan={'diagnostic_node':descriptor,'required_inputs':[descriptor]};result={'direct_waits':[{'role':'harness','pid':helper.pid,'actual_parent_wait':True,'exit_code':status}],'_svm_diagnostic_roles':[],'passed':False,'error':{'message':'SYNTHETIC_COMPONENT_PRIMARY'}}
            original=copy.deepcopy(result);limits_before={name:api.resource.getrlimit(kind)for name,kind in [('address_space',api.resource.RLIMIT_AS),('open_files',api.resource.RLIMIT_NOFILE)]};rows=[]
            def selection(data):return {'windows':[{'tag':tag,'position':position,'bytes':min(4096,max(0,len(data)-4096*i))}for i,(tag,position)in enumerate([('SOL','first'),('SOL','tail'),('SCR','first'),('SCR','tail')])],'oversized_lines_omitted':0,'scope':'SYNTHETIC component bytes only'}
            for length in (17,16384):
                data=bytes((i*127+255)%256 for i in range(length));started=time.monotonic_ns();end=started+5_000_000_000
                value=api.svm_encrypt_failure_windows(plan,module,data,selection(data),root,result,end)
                self.assertEqual(value['collection_status'],'encrypted');self.assertEqual(len(value['blocks']),(length+383)//384);self.assertTrue(value['actual_parent_wait']);self.assertEqual(value['child_exit_code'],0);self.assertTrue(value['owned_group_absent_after_wait']);self.assertLess(value['finished_monotonic_ns'],end);self.assertEqual(value['actual_child_resource_limits']['address_space'],value['parent_resource_limits_at_launch']['address_space'])
                rows.append({k:v for k,v in value.items()if k not in {'blocks','windows','scope'}})
            # Same actual owner, Node executable and unchanged limits; only fixed test script differs.
            for script,seconds in [('process.exit(2)',3),('process.stdin.resume();setInterval(()=>{},1000)',2.5)]:
                test_module=types.SimpleNamespace(SVM_ENCRYPTION_SCRIPT=script,svm_encrypted_blocks=module.svm_encrypted_blocks,captured_failure_bytes=module.captured_failure_bytes)
                start=time.monotonic_ns();value=api.svm_encrypt_failure_windows(plan,test_module,b'SYNTHETIC',selection(b'SYNTHETIC'),root,result,start+int(seconds*1e9))
                self.assertEqual(value['collection_status'],'unavailable');self.assertTrue(value['actual_parent_wait']);self.assertFalse(value['owned_cleanup_debt']);self.assertLess(time.monotonic_ns()-start,int(seconds*1e9));rows.append(value)
            expired=api.svm_encrypt_failure_windows(plan,module,b'SYNTHETIC',selection(b'SYNTHETIC'),root,result,0);self.assertEqual(expired['collection_status'],'unavailable');self.assertIsNone(expired['actual_parent_wait'])
            self.assertEqual(result,original);self.assertEqual({name:api.resource.getrlimit(kind)for name,kind in [('address_space',api.resource.RLIMIT_AS),('open_files',api.resource.RLIMIT_NOFILE)]},limits_before)
            print(json.dumps({'kind':'SYNTHETIC-Linux-Node26-owned-encryption-component','native_or_case_or_timing_authority':False,'node_sha256':descriptor['sha256'],'node_bytes':descriptor['bytes'],'child_observations':rows,'no_parent_limits_changed':True,'root_private_key_read':False},sort_keys=True))



class RadixScraperOwnerControls(unittest.TestCase):
    def fixture(self):
        from types import SimpleNamespace
        module=SimpleNamespace(RelayerStartup=SimpleNamespace(identity=lambda path:('stable',)),captured_failure_bytes=lambda path,maximum:(b'journal',{}),radix_selected_scraper=mock.Mock(return_value=({'pid':43,'ppid':42,'start':'linux-ticks:2','state':'S'},('a','b'),9093)),startup_owned_listener=mock.Mock(return_value='123'),startup_http=mock.Mock(return_value=(200,b'metrics')))
        state=SimpleNamespace(first=None,last=None,latest_probe={},check_sources=mock.Mock(),public=mock.Mock(return_value={'collection_status':'observed','operand_marker':7}))
        def project(raw,chains,started,finished):state.first={'first':1};state.last={'last':2}
        state.project=mock.Mock(side_effect=project);context={'module':module,'state':state,'product':Path('/owned/scraper'),'product_identity':('stable',)}
        harness=SimpleNamespace(pid=42,poll=mock.Mock(return_value=None));controller=SimpleNamespace(poll=mock.Mock(return_value=None));helper={'pid':42,'ppid':40,'start':'linux-ticks:1','state':'S'}
        return context,module,state,harness,controller,helper
    def run_probe(self,fixture,*,now=1,kernel=None):
        context,module,state,harness,controller,helper=fixture
        kernel=kernel or(lambda pid:helper if pid==42 else{'pid':43,'ppid':42,'start':'linux-ticks:2','state':'S'})
        with mock.patch.object(api.time,'monotonic_ns',return_value=now),mock.patch.object(api.owner,'_linux_row',side_effect=kernel),mock.patch.object(api.os,'readlink',return_value='/owned/scraper'):
            api.observe_radix_scraper(context,{'scenario':'radix'}, {},Path('/owned'),harness,controller,helper,500000001)
    def test_actual_observer_wiring_before_after_ownership_and_fixed_GET(self):
        fixture=self.fixture();context,module,state,*_=fixture;self.run_probe(fixture)
        module.startup_http.assert_called_once();self.assertEqual(module.startup_http.call_args.args[:2],(9093,'GET'));self.assertEqual(module.startup_http.call_args.args[2],500000001);self.assertEqual(module.startup_owned_listener.call_count,2);state.project.assert_called_once();self.assertEqual(state.last,{'last':2})
    def test_expired_cancelled_missing_or_changed_owner_cannot_HTTP(self):
        for variant in ['expired','cancelled','helper','role']:
            fixture=self.fixture();context,module,state,harness,*_=fixture
            if variant=='cancelled':harness.poll.return_value=101
            kernel=(lambda pid:None)if variant=='helper'else(lambda pid:fixture[-1]if pid==42 else{'pid':43,'ppid':999,'start':'linux-ticks:2','state':'S'})if variant=='role'else None
            self.run_probe(fixture,now=500000001 if variant=='expired'else 1,kernel=kernel);module.startup_http.assert_not_called();self.assertIsNone(state.last);self.assertEqual(state.latest_probe['collection_status'],'unavailable')
    def test_request_parse_and_postread_ownership_errors_are_finite_and_preserve_previous(self):
        for variant in ['request','parse','listener']:
            fixture=self.fixture();context,module,state,*_=fixture;previous={'approved_previous':7};state.first=previous;state.last=previous
            if variant=='request':module.startup_http.side_effect=OSError('PRIVATE_URL_TOKEN')
            elif variant=='parse':state.project.side_effect=ValueError('PRIVATE_METRIC_LABEL')
            else:module.startup_owned_listener.side_effect=['123','changed']
            self.run_probe(fixture);self.assertIs(state.first,previous);self.assertIs(state.last,previous);self.assertEqual(state.latest_probe['reason'],{'request':'REQUEST_ERROR','parse':'METRICS_PARSE_ERROR','listener':'OWNERSHIP_UNAVAILABLE'}[variant]);self.assertNotIn('PRIVATE',json.dumps(state.latest_probe))
    def test_deadline_after_project_rolls_back_unpublished_candidate(self):
        fixture=self.fixture();context,module,state,*_=fixture;clock=[1]
        def project(*args):state.first={'late':1};state.last={'late':1};clock[0]=500000001
        state.project.side_effect=project
        with mock.patch.object(api.time,'monotonic_ns',side_effect=lambda:clock[0]),mock.patch.object(api.owner,'_linux_row',side_effect=lambda pid:fixture[-1]if pid==42 else{'pid':43,'ppid':42,'start':'linux-ticks:2','state':'S'}),mock.patch.object(api.os,'readlink',return_value='/owned/scraper'):
            api.observe_radix_scraper(context,{}, {},Path('/owned'),fixture[3],fixture[4],fixture[-1],500000001)
        self.assertIsNone(state.first);self.assertIsNone(state.last);self.assertEqual(state.latest_probe['reason'],'DEADLINE_OR_CANCEL')
    def test_actual_worker_AST_shares_transport_budget_and_arms_SCR_before_GO(self):
        import ast
        source=Path(api.__file__).read_text();tree=ast.parse(source);worker=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='worker');branch=next(n for n in ast.walk(worker)if isinstance(n,ast.If)and ast.unparse(n.test)=='radix is not None'and any(isinstance(x,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='diagnostic_end'for t in x.targets)for x in n.body))
        calls=[];memory=[];code=[None]
        def observe_memory(deadline,cancelled):self.assertFalse(cancelled());memory.append(cancelled);calls.append(('memory',deadline))
        from types import SimpleNamespace
        context={'time':SimpleNamespace(monotonic_ns=lambda:10),'args':SimpleNamespace(original_deadline_ns=300),'radix_transport':{'state':SimpleNamespace(begin_custody=lambda:calls.append('begin'))},'radix':SimpleNamespace(observe=lambda:calls.append('custody'),observe_memory=observe_memory),'radix_publisher':SimpleNamespace(observe=lambda:calls.append('publisher')),'radix_scraper':object(),'manifest':{},'inputs':{},'case':object(),'harness':SimpleNamespace(poll=lambda:code[0]),'controller':SimpleNamespace(poll=lambda:None),'helper_row':{},'observe_radix_transport':lambda *args:calls.append(('transport',args[-1])),'observe_radix_scraper':lambda *args:calls.append(('scraper',args[-1]))}
        exec(compile(ast.Module(body=branch.body,type_ignores=[]),'actual-worker-cadence','exec'),context)
        self.assertEqual(calls,['begin','custody','publisher',('memory',300),('transport',300),('scraper',300)]);self.assertEqual(len(memory),1);code[0]=101;self.assertTrue(memory[0]())
        self.assertEqual(source.count('radix_scraper=arm_radix_scraper('),1);self.assertIn('radix_scraper=radix_scraper',source)
    def test_actual_failure_writer_keeps_optional_field_without_primary_or_wait_changes(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory()as tmp:
            case=Path(tmp);out=case/'worker';out.mkdir();log=out/'harness.log';log.write_bytes(b'captured');primary=ValueError('PRIVATE_PRIMARY');result={'error':primary,'direct_waits':[{'role':'harness','pid':42,'actual_parent_wait':True,'exit_code':101}]}
            state=SimpleNamespace(public=mock.Mock(return_value={'collection_status':'observed','operand_marker':7}));module=SimpleNamespace(rust_panic_observation=mock.Mock(return_value={'sites':[],'reason_codes':[],'reason_source':None,'log_fingerprint':{},'Radix_scraper_headers':{'counts':{'lane_failure':1}}}),fixture_failure_observation=mock.Mock(return_value={}))
            with mock.patch.object(api,'snapshot_public_diagnostics',return_value=None),mock.patch.object(api,'diagnostic_module',return_value=module):row=api.write_public_failure_diagnostics({'execution_source_commit':'b'*40,'diagnostic_rust_sources':{}},{'runtime_source_commit':'a'*40,'scenario':'radix','mode':'ReleaseSafe'}, {},case,out,result,1,radix_scraper={'state':state})
            public=json.loads(Path(row['path']).read_bytes());self.assertEqual(public['Radix_scraper_cutover'],{'collection_status':'observed','operand_marker':7});state.public.assert_called_once_with({'counts':{'lane_failure':1}});self.assertIs(module.rust_panic_observation.call_args.kwargs['radix_scraper'],state);self.assertIs(result['error'],primary);self.assertEqual(result['direct_waits'][0]['exit_code'],101);self.assertNotIn('PRIVATE',json.dumps(public))



class RadixRpcPublicationControls(unittest.TestCase):
    def test_actual_failure_publisher_retains_RPC_field_under_same_private_deadline_and_primary(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory()as tmp:
            case=Path(tmp);out=case/'worker';out.mkdir();primary=ValueError('PRIVATE_PRIMARY');result={'error':primary,'direct_waits':[{'role':'harness','pid':42,'actual_parent_wait':True,'exit_code':101}]};state=SimpleNamespace(public=lambda raw:{'collection_status':'observed'});observed={'collection_status':'observed','routes':{'CORE_CALL_PREVIEW':{'error_count':1}}};module=SimpleNamespace(fixture_failure_observation=mock.Mock(return_value={}),radix_rpc_failure_observation=mock.Mock(return_value=observed));deadline=time.monotonic_ns()+9_000_000_000
            with mock.patch.object(api,'snapshot_public_diagnostics',return_value=None),mock.patch.object(api,'diagnostic_module',return_value=module):row=api.write_public_failure_diagnostics({'execution_source_commit':'b'*40,'diagnostic_rust_sources':{}},{'runtime_source_commit':'a'*40,'scenario':'radix','mode':'ReleaseSafe'}, {},case,out,result,1,case_inputs={'owned':True},original_deadline_ns=deadline,radix_scraper={'state':state})
            value=json.loads(Path(row['path']).read_bytes());self.assertEqual(value['Radix_RPC_failures'],observed);call=module.radix_rpc_failure_observation.call_args;self.assertEqual(call.args[5],42);self.assertIs(call.args[6],state);self.assertLessEqual(call.args[7],deadline);self.assertIs(call.args[8],time.monotonic_ns);self.assertIs(result['error'],primary);self.assertEqual(result['direct_waits'][0]['exit_code'],101);self.assertNotIn('PRIVATE',json.dumps(value))
    def test_diagnostic_refusal_or_ambiguous_parent_keeps_original_error_wait_and_unavailable(self):
        from types import SimpleNamespace
        for ambiguous in [False,True]:
            with tempfile.TemporaryDirectory()as tmp:
                case=Path(tmp);out=case/'worker';out.mkdir();primary=ValueError('PRIVATE_PRIMARY');waits=[{'role':'harness','pid':42,'actual_parent_wait':True,'exit_code':101}]+([{'role':'harness-cleanup','pid':43,'actual_parent_wait':True,'exit_code':101}]if ambiguous else[]);result={'error':primary,'direct_waits':waits};state=SimpleNamespace(public=lambda raw:{});module=SimpleNamespace(fixture_failure_observation=mock.Mock(return_value={}),radix_rpc_failure_observation=mock.Mock(side_effect=ValueError('PRIVATE_DIAGNOSTIC')))
                with mock.patch.object(api,'snapshot_public_diagnostics',return_value=None),mock.patch.object(api,'diagnostic_module',return_value=module):row=api.write_public_failure_diagnostics({'execution_source_commit':'b'*40,'diagnostic_rust_sources':{}},{'runtime_source_commit':'a'*40,'scenario':'radix','mode':'ReleaseSafe'}, {},case,out,result,1,case_inputs={},original_deadline_ns=time.monotonic_ns()+5_000_000_000,radix_scraper={'state':state})
                value=json.loads(Path(row['path']).read_bytes());self.assertEqual(value['Radix_RPC_failures'],{'schema':1,'collection_status':'unavailable','native_or_timing_or_cleanup_authority':False});self.assertIs(result['error'],primary);self.assertEqual(result['direct_waits'],waits);self.assertNotIn('PRIVATE',json.dumps(value));self.assertEqual(module.radix_rpc_failure_observation.call_count,0 if ambiguous else 1)

class StarkAdminFailureProjectionControls(unittest.TestCase):
    def test_existing_failure_artifact_optional_projection_preserves_primary_even_on_interrupt(self):
        from types import SimpleNamespace
        for failure in [None,ValueError('PRIVATE_DIAGNOSTIC'),KeyboardInterrupt('PRIVATE_INTERRUPT')]:
            with tempfile.TemporaryDirectory()as temp:
                root=Path(temp).resolve();case=root/'case';out=root/'out';case.mkdir();out.mkdir();primary={'type':'ValueError','message':'PRIVATE_PRIMARY'};result={'direct_waits':[],'error':primary};before=copy.deepcopy(result);projected={'schema':1,'collection_status':'observed','rows':[],'native_or_timing_or_cleanup_authority':False};module=SimpleNamespace(starknet_admin_sampling_observation=mock.Mock(side_effect=failure,return_value=projected))
                with mock.patch.object(api,'snapshot_public_diagnostics',return_value=None),mock.patch.object(api,'diagnostic_module',return_value=module):
                    row=api.write_public_failure_diagnostics({'execution_source_commit':'b'*40,'diagnostic_rust_sources':{}},{'scenario':'starknet','mode':'ReleaseSafe','runtime_source_commit':'a'*40},{'python_modules':{}},case,out,result,90,case_inputs={'scenario':'starknet'})
                value=json.loads(Path(row['path']).read_bytes());self.assertEqual(result,before);self.assertIs(result['error'],primary);self.assertFalse(value['native_or_timing_credit']);self.assertNotIn('PRIVATE',json.dumps(value));self.assertEqual(value['Stark_admin_sampling']['collection_status'],'observed'if failure is None else'unavailable');module.starknet_admin_sampling_observation.assert_called_once()
    def test_exact24KiB_projection_and512KiB_final_newline_reserve_boundary(self):
        from types import SimpleNamespace
        placeholder={'schema':1,'collection_status':'unavailable','native_or_timing_or_cleanup_authority':False}
        projection={'schema':1,'collection_status':'observed','native_or_timing_or_cleanup_authority':False,'synthetic_bound':''}
        compact=lambda value:json.dumps(value,sort_keys=True,separators=(',',':')).encode()
        projection['synthetic_bound']='x'*(24*1024-len(compact(projection)));self.assertEqual(len(compact(projection)),24*1024)
        with tempfile.TemporaryDirectory()as temp:
            root=Path(temp).resolve();case=root/'case';case.mkdir()
            def run(filler,name):
                out=root/name;out.mkdir();module=SimpleNamespace(starknet_admin_sampling_observation=mock.Mock(return_value=projection));startup={'state':SimpleNamespace(public=lambda log:{'synthetic_bound':'x'*filler}),'latest_probe':None}
                with mock.patch.object(api,'snapshot_public_diagnostics',return_value=None),mock.patch.object(api,'diagnostic_module',return_value=module),mock.patch.object(api.time,'monotonic_ns',return_value=100):
                    row=api.write_public_failure_diagnostics({'execution_source_commit':'b'*40,'diagnostic_rust_sources':{}},{'scenario':'starknet','mode':'ReleaseSafe','runtime_source_commit':'a'*40},{'python_modules':{}},case,out,{'direct_waits':[]},90,startup_context=startup)
                raw=Path(row['path']).read_bytes();return json.loads(raw),len(raw),module
            base,_,_=run(0,'base');base['Stark_admin_sampling']=placeholder;original=len(compact(base));filler=512*1024-24*1024-original;self.assertGreater(filler,0)
            value,size,module=run(filler,'boundary');self.assertEqual(value['Stark_admin_sampling']['collection_status'],'observed');self.assertEqual(size,512*1024-len(compact(placeholder))+1);self.assertLessEqual(size,512*1024);module.starknet_admin_sampling_observation.assert_called_once()
            value,size,module=run(filler+1,'over_reserve');self.assertEqual(value['Stark_admin_sampling'],placeholder);self.assertLessEqual(size,512*1024);module.starknet_admin_sampling_observation.assert_not_called()
    def test_non_Stark_failure_does_not_read_or_project_admin_timeline(self):
        from types import SimpleNamespace
        module=SimpleNamespace(late_invariant_observation=mock.Mock(return_value={'collection_status':'unavailable'}),starknet_admin_sampling_observation=mock.Mock(side_effect=AssertionError('no new admin diagnostic IO')))
        with tempfile.TemporaryDirectory()as temp:
            root=Path(temp).resolve();case=root/'case';out=root/'out';case.mkdir();out.mkdir()
            with mock.patch.object(api,'snapshot_public_diagnostics',return_value=None),mock.patch.object(api,'diagnostic_module',return_value=module):
                row=api.write_public_failure_diagnostics({'execution_source_commit':'b'*40,'diagnostic_rust_sources':{}},{'scenario':'evm','mode':'ReleaseSafe','runtime_source_commit':'a'*40},{},case,out,{'direct_waits':[]},90)
            self.assertNotIn('Stark_admin_sampling',json.loads(Path(row['path']).read_bytes()));module.starknet_admin_sampling_observation.assert_not_called()


if __name__=='__main__':unittest.main()
