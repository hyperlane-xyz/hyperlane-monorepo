"""Data-only SVM composition controls. No product, Docker or native execution."""
from pathlib import Path
import copy
import importlib.util
import json
import shutil
import tempfile
import unittest
from unittest import mock
HERE=Path(__file__).resolve().parent

def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
api=load('svm_case_controls',HERE/'native_svm_case.py');ci=load('svm_dispatch_controls',HERE/'native_case_ci.py')

class Controls(unittest.TestCase):
    def request(self):
        value={'schema':1,'root_approved':True,'scenario':'sealevel','mode':'ReleaseSafe','producer_source_commit':'a'*40,'producer_run_id':42,'producer_run_attempt':1,'limits':dict(ci.LIMITS),'artifact_pins':{},'postgres':{'schema':2,'architecture':'amd64','image':'postgres:14','image_id':'sha256:'+'d'*64,'canonical_digest':'postgres@sha256:'+'e'*64},'prerequisites':{'local_checkout_build':True,'registry_commit':None,'hpack':{'version':'4.2.0','wheel_sha256':'858ac0b02280fa582b5080d68db0899c6'+'2a80375e0e5413a74970c5e518b6986','wheel_bytes':34246},'svm_offline':{'schema':2,'platform':'linux-x86_64','agave_version':'3.0.14','platform_tools_version':'v1.51','spl_release':'2024-08-23','spl_token_revision':'e101cca','programs':13,'agave_files':85,'source_environment_files':25,'require_same_producer_source':True}}}
        value['artifact_pins']={key:{'id':i,'name':name,'sha256':'b'*64,'size_in_bytes':1024}for i,(key,name)in enumerate(ci.artifact_names(value).items(),1)}
        return value
    def remote(self):
        request=self.request();run={'id':42,'run_attempt':1,'head_sha':'a'*40,'repository':{'full_name':ci.REPOSITORY},'head_repository':{'full_name':ci.REPOSITORY},'head_branch':ci.BRANCH,'event':'push','path':'.github/workflows/zig-agents.yml','status':'completed','conclusion':'failure'}
        jobs=[{'id':i,'name':name,'run_id':42,'status':'completed','conclusion':'success'}for i,name in enumerate(['full-sdk-native (ReleaseSafe)','full-sdk-native (ReleaseFast)','native-harness-controls','svm-prerequisites'])]
        artifacts=[dict(v,expired=False,digest='sha256:'+v['sha256'],workflow_run={'id':42,'head_sha':'a'*40,'head_branch':ci.BRANCH})for v in request['artifact_pins'].values()]
        return request,run,jobs,artifacts
    def test_exact_six_artifacts_and_four_actual_green_jobs(self):
        request,run,jobs,artifacts=self.remote();ci.validate_request(request);self.assertEqual(len(ci.validate_remote(request,run,jobs,artifacts)['required_jobs']),4);self.assertEqual(len(ci.artifact_names(request)),6)
    def test_failed_or_missing_SVM_job_rejects_despite_green_SDKs(self):
        for change in ['failed','missing']:
            request,run,jobs,artifacts=self.remote()
            if change=='failed':jobs[-1]['conclusion']='failure'
            else:jobs.pop()
            with self.assertRaises(ValueError):ci.validate_remote(request,run,jobs,artifacts)
    def test_historical_C13_asset_cannot_join_new_helper_cohort(self):
        request,run,jobs,artifacts=self.remote();artifacts[-1]['workflow_run']['head_sha']='e'*40
        with self.assertRaisesRegex(ValueError,'provenance'):ci.validate_remote(request,run,jobs,artifacts)
    def test_missing_hidden_closure_policy_wrong_arch_and_modes_reject(self):
        for kind in ['count','arch','schema','same_source','integer_true','native_cli','mode']:
            request=self.request()
            if kind=='count':request['prerequisites']['svm_offline']['agave_files']=82
            if kind=='arch':request['postgres']['architecture']='arm64'
            if kind=='schema':request['prerequisites']['svm_offline']['schema']=1
            if kind=='same_source':request['prerequisites']['svm_offline']['require_same_producer_source']=False
            if kind=='integer_true':request['prerequisites']['svm_offline']['require_same_producer_source']=1
            if kind=='native_cli':request['prerequisites']['native_cli']={}
            if kind=='mode':request['mode']='Debug'
            with self.subTest(kind=kind),self.assertRaises(ValueError):ci.validate_request(request)
    def test_no_default_Darwin_or_foreign_admission(self):
        for scenario in ['foreign-sealevel','darwin-sealevel']:
            value=self.request();value['scenario']=scenario
            with self.assertRaises(ValueError):ci.validate_request(value)
    def test_duplicate_or_cross_run_artifact_rejected(self):
        request,run,jobs,artifacts=self.remote();request['artifact_pins']['svm']['id']=request['artifact_pins']['helper']['id']
        with self.assertRaises(ValueError):ci.validate_request(request)
        request,run,jobs,artifacts=self.remote();artifacts[-1]['workflow_run']['id']=43
        with self.assertRaises(ValueError):ci.validate_remote(request,run,jobs,artifacts)
    def test_source_exact_basic_profile(self):
        p=api.profile();self.assertEqual(p['initial_corpus'],{'dispatches':13,'deliveries':12,'unpaid':1});self.assertEqual(p['chain_names'],['sealeveltest1','sealeveltest2','sealeveltest3']);self.assertEqual(set(p['validator_addresses']),{'sealeveltest1'});self.assertEqual(p['relayer_addresses'],dict.fromkeys(p['chain_names'],api.PAYER));self.assertNotIn('root_approved',p)
    def test_mutated_inspection_rejected_before_any_copy(self):
        request=self.request();value={'source_commit':'e'*40,'same_source_cohort_required':True,'native_case_acceptance':False}
        with mock.patch.object(api,'assets')as assets,self.assertRaisesRegex(ValueError,'cohort'):api.check_inspection(value,request,Path('/unused'))
        assets.assert_called_once()
    def test_component_gate_has_no_VM_or_performance_credit(self):
        # Scope controls are supplementary; actual byte-copy validation lives in
        # the existing17 closed-data tests and the real CI gate remains required.
        source=Path(api.__file__).read_text();self.assertIn("'native_VM_acceptance':False",source);self.assertIn("'performance_credit':False",source);self.assertIn("'spl_publisher_digest':None",source)

    def test_component_materialization_rejects_false_request_before_writes(self):
        value=self.request();value['root_approved']=False
        with mock.patch.object(api,'check_inspection')as check,self.assertRaisesRegex(ValueError,'Reviewed'):api.materialize({},value,Path('/unused'),Path('/unused'),{}, {})
        check.assert_not_called()
    def test_actual_copy_and_gate_bind_exact_assets_and_public_provenance(self):
        # A tiny byte fixture exercises the real copier/gate, not an ELF or VM.
        with tempfile.TemporaryDirectory()as tmp:
            root=Path(tmp).resolve();source=root/'source';source.mkdir();case=root/'case';case.mkdir();(case/'evidence').mkdir()
            data=api.assets();data.AGAVE={'version.yml':(1,'2d711642b726b04401627ca9fbac32f5c'+'8530fb1903cc4db02258717921a4881',0o644)};data.PROGRAMS={'test.so':(1,'a'*64,263)};data.ENVIRONMENT=('public.json',)
            files={};body=b'x'
            for name in ['agave/version.yml','programs/test.so','client/hyperlane-sealevel-client','home/.cargo/bin/spl-token']:
                p=source/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(body);files[name]=data.pin(p)
            product=source/'products.json';product.write_text(json.dumps({'programs':{'test.so':files['programs/test.so']},'client':files['client/hyperlane-sealevel-client'],'spl':files['home/.cargo/bin/spl-token']}))
            env=source/'public.json';env.write_text('{}');inspected={'platform':data.PLATFORM,'source_commit':'a'*40,'native_case_acceptance':False,'files':files,'product_manifest':data.pin(product),'producer_result':data.pin(product)}
            value={'inspected':inspected,'environment':{'public.json':data.pin(env)},'source_before':data.pin(product)}
            with mock.patch.object(api,'assets',return_value=data),mock.patch.object(api,'check_inspection',return_value=value):
                # This four-byte copy is a unit fixture; actual case free-space admission stays real.
                for available in (6*1024**3-1,6*1024**3):
                    with mock.patch.object(shutil,'disk_usage',return_value=mock.Mock(free=available)),self.assertRaisesRegex(ValueError,'preserve6GiB floor'):
                        api.materialize(value,self.request(),source,case,{'selector':'actual-pin'},{'producer':'actual-pin'})
                    self.assertFalse((case/'tools').exists())
                with mock.patch.object(shutil,'disk_usage',return_value=mock.Mock(free=8*1024**3)):
                    bundle,pins=api.materialize(value,self.request(),source,case,{'selector':'actual-pin'},{'producer':'actual-pin'})
            gate=json.loads(Path(bundle['component_gate']['path']).read_text());self.assertEqual(gate['accepted_assets'],{k:v for k,v in bundle.items()if k!='component_gate'});self.assertTrue(gate['root_approved']);self.assertFalse(gate['native_VM_acceptance']);self.assertIsNone(gate['spl_publisher_digest']);self.assertEqual(gate['reviewed_policy'],{'selector':'actual-pin'});self.assertTrue((case/'svm-workspace').is_dir());self.assertEqual((case/'tools/svm/programs/test.so').read_bytes(),body)

    def test_actual_stage_validator_accepts_no_CosmosCLI_and_rejects_dataset_swap(self):
        base=load('svm_input_fixture',HERE.parent/'integration/native_case_inputs_test.py');state=base.StageControls('test_native_cosmos_empty_contract_map_is_honest');state.setUp();self.addCleanup(state.doCleanups)
        stage,context,request=state.fixture_stage('cosmosnative');stage['scenario']='sealevel';context['scenario']='sealevel';stage['tools'].pop('native_cli');stage['svm_assets']={'actual':'dataset-A'};context['svm_prerequisites']=stage['svm_assets'];original=base.m.load_module
        def module(name,relative):
            if name=='validate_svm_case':
                from types import SimpleNamespace
                return SimpleNamespace(check_inspection=lambda *a:None)
            return original(name,relative)
        with mock.patch.object(base.m,'load_module',side_effect=module),mock.patch.object(base.m.platform,'machine',return_value='x86_64'):
            self.assertTrue(base.m.validate_stage(stage,context,request));bad=copy.deepcopy(stage);bad['svm_assets']={'actual':'dataset-B'}
            with self.assertRaisesRegex(ValueError,'dataset differs'):base.m.validate_stage(bad,context,request)
        self.assertEqual(stage['contract_artifacts'],{});self.assertEqual(stage['registry'],{'path':None,'commit':None});self.assertNotIn('native_cli',stage['tools'])
    def test_actual_two_child_wait_contract_excludes_foreign_or_extra(self):
        owner=load('svm_owner_fixture',HERE/'native_case_owner.py')
        with tempfile.TemporaryDirectory()as tmp:
            path=Path(tmp)/'waits.jsonl';rows=[{'pid':i,'role':role,'parent_pid':42,'parent_wait_completed':True,'forced_kill':False,'purpose':'fixture_teardown','already_exited':False}for i,role in enumerate(['fixture-svm-SOL','fixture-docker'],1)]
            path.write_text(''.join(json.dumps(v)+'\n'for v in rows));self.assertEqual(len(owner.fixture_waits(path,'sealevel',42)),2)
            for mutation in ['extra','parent','early']:
                bad=copy.deepcopy(rows)
                if mutation=='extra':bad.append(dict(bad[0],pid=3))
                if mutation=='parent':bad[0]['parent_pid']=41
                if mutation=='early':bad[0]['already_exited']=True
                path.write_text(''.join(json.dumps(v)+'\n'for v in bad))
                with self.assertRaises(ValueError):owner.fixture_waits(path,'sealevel',42)
    def test_actual_SVM_PID_argv_TCP_UDP_and_permission_boundary(self):
        import os,subprocess
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory()as tmp:
            root=Path(tmp).resolve();node=root/'solana-test-validator';node.write_bytes(b'not executable in controls');node.chmod(0o755);ledger=root/'ledger';ledger.mkdir()
            argv=[str(node),'--bind-address','127.0.0.1','--rpc-port','8899','--faucet-port','9900','--gossip-port','8001','--dynamic-port-range','8002-8033','--faucet-per-time-sol-cap','0','--faucet-per-request-sol-cap','0','--ledger',str(ledger)]
            row={'state':'S','start':'linux-ticks:123'};owner=SimpleNamespace(proc_fallback=lambda:{1:{'state':'S'},42:row},_linux_row=lambda pid:row,same_process=lambda a,b:a==b)
            inputs={'svm_assets':{'agave_files':{'bin/solana-test-validator':api.assets().pin(node)}}};observed={};original=Path.read_bytes
            def read(p):return b'\0'.join(os.fsencode(v)for v in argv)+b'\0'if str(p)=='/proc/42/cmdline'else original(p)
            def link(p):
                if p=='/proc/1/exe':raise PermissionError('protected unrelated')
                return str(node)
            tcp=b'p42\nf1\nn*:8899\nf2\nn0.0.0.0:8900\nf3\nn*:9900\n';udp=b'p42\nf4\nn127.0.0.1:8001\n'
            def run(command,**kwargs):return subprocess.CompletedProcess(command,0,udp if '-iUDP'in command else tcp,b'')
            full_tcp,full_udp=tcp,udp
            for tcp,udp in [(b'',b''),(b'p42\nf1\nn*:8899\n',full_udp),(full_tcp,b'')]:
                pending={}
                with mock.patch.object(Path,'read_bytes',read),mock.patch.object(api.os,'readlink',side_effect=link),mock.patch.object(subprocess,'run',side_effect=run):
                    expected=api.listener_proof({},inputs,root,root/'unused-lsof',pending,owner,subprocess)
                self.assertEqual(expected,[{8899,8900}]);self.assertEqual(pending,{})
            tcp,udp=full_tcp,full_udp
            with mock.patch.object(Path,'read_bytes',read),mock.patch.object(api.os,'readlink',side_effect=link),mock.patch.object(subprocess,'run',side_effect=run):
                expected=api.listener_proof({},inputs,root,root/'unused-lsof',observed,owner,subprocess)
            self.assertEqual(expected,[{8899,8900}]);self.assertEqual(observed['8899,8900']['pid'],42);self.assertEqual(observed['8899,8900']['ledger'],str(ledger))
            proof=observed['8899,8900']
            self.assertEqual(proof['source_tcp_wildcard_ports'],[8899,8900,9900])
            self.assertEqual(proof['source_tcp_wildcard_roles'],{'rpc':8899,'pubsub':8900,'faucet':9900})
            self.assertEqual(proof['owned_loopback_tcp_ports'],[])
            self.assertEqual(proof['client_endpoint_scope'],'localhost')
            self.assertNotIn('owned_loopback_ports',proof)
            for original_tcp in [tcp]:
                for port in (8899,8900,9900):
                    for replacement in (b'',f'n127.0.0.1:{port}\n'.encode()):
                        # Remove a complete field pair; substitute loopback on the same fd.
                        import re
                        tcp=re.sub(rb'f[123]\nn(?:\*|0\.0\.0\.0):'+str(port).encode()+rb'\n',
                                   b'f8\n'+replacement if replacement else b'',original_tcp)
                        failed={'8899,8900':dict(proof)}
                        with mock.patch.object(Path,'read_bytes',read),mock.patch.object(api.os,'readlink',side_effect=link),mock.patch.object(subprocess,'run',side_effect=run),self.assertRaisesRegex(ValueError,'Source wildcard'):
                            api.listener_proof({},inputs,root,root/'unused-lsof',failed,owner,subprocess)
                        self.assertEqual(failed,{'8899,8900':proof})
            tcp=b'p42\nf1\nn127.0.0.1:8899\n'
            with mock.patch.object(Path,'read_bytes',read),mock.patch.object(api.os,'readlink',side_effect=link),mock.patch.object(subprocess,'run',side_effect=run),self.assertRaisesRegex(ValueError,'Source wildcard'):
                api.listener_proof({},inputs,root,root/'unused-lsof',{},owner,subprocess)
            tcp=b'p42\nf1\nn*:8898\n'
            with mock.patch.object(Path,'read_bytes',read),mock.patch.object(api.os,'readlink',side_effect=link),mock.patch.object(subprocess,'run',side_effect=run),self.assertRaisesRegex(ValueError,'escaped fixed local authority'):
                api.listener_proof({},inputs,root,root/'unused-lsof',{},owner,subprocess)
            tcp=b''
            bad_argv=argv[:];bad_argv[bad_argv.index('--bind-address')+1]='0.0.0.0'
            good_argv=argv;argv=bad_argv
            with mock.patch.object(Path,'read_bytes',read),mock.patch.object(api.os,'readlink',side_effect=link),mock.patch.object(subprocess,'run',side_effect=run),self.assertRaisesRegex(ValueError,'argument differs'):
                api.listener_proof({},inputs,root,root/'unused-lsof',{},owner,subprocess)
            argv=good_argv
            with mock.patch.object(Path,'read_bytes',read),mock.patch.object(api.os,'readlink',side_effect=link),mock.patch.object(subprocess,'run',side_effect=run),mock.patch.object(owner,'_linux_row',return_value={'state':'S','start':'linux-ticks:124'}),self.assertRaisesRegex(ValueError,'PID changed'):
                api.listener_proof({},inputs,root,root/'unused-lsof',{},owner,subprocess)
            tcp=original_tcp
            with mock.patch.object(Path,'read_bytes',side_effect=PermissionError('matched node denied')),mock.patch.object(api.os,'readlink',side_effect=link),self.assertRaises(PermissionError):api.listener_proof({},inputs,root,root/'unused-lsof',{},owner,subprocess)

    def exercise_prepare(self,scenario='sealevel'):
        # Admission/copy inputs are synthetic and mocked. Actual prepare output
        # construction and existing manifest/owner schema validators remain real.
        import shutil,sys
        from types import SimpleNamespace
        base=load('svm_prepare_fixture',HERE.parent/'integration/native_case_inputs_test.py');m=base.m
        state=base.PreparationControls('test_actual_prepare_outputs_match_manifest_and_owner_schemas_without_executing');state.setUp();self.addCleanup(state.doCleanups);state.root=state.root.resolve()
        stage,initial,request=state.fixture_stage('cosmosnative');repo=state.root;case=repo/'case';case.mkdir()
        for name in ['evidence','tools','home','tmp','docker-config']:(case/name).mkdir()
        for rel in ['zig/bench/native_case_owner.py','zig/bench/cold_matrix_owner.py','zig/bench/native_svm_case.py','zig/bench/native_svm_assets.py']:
            dest=repo/rel;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(m.ROOT/rel,dest)
        for source in (m.ROOT/'zig/integration').glob('multivm_*.py'):
            dest=repo/'zig/integration'/source.name;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,dest)
        (repo/'rust/main/utils/run-locally').mkdir(parents=True)
        request['limits']=m.LIMITS.copy();request['postgres']={'schema':2,'image':'postgres:14','image_id':'sha256:'+'1'*64,'canonical_digest':'postgres@sha256:'+'2'*64,'architecture':'amd64'}
        def output(path,value):path.write_text(json.dumps(value));return m.artifact(path)
        if scenario=='sealevel-composite':request['postgres']=None
        request_pin=output(repo/'request.json',request);receipt=output(repo/'receipt.json',{});template=Path(stage['tools'].pop('native_cli')['path']);tools={}
        for name in ['init-db','ziggy-native-rows','ziggy-rocks-oracle','ziggy-rust-reference']:
            path=case/'tools'/name;shutil.copyfile(template,path);path.chmod(0o755);tools[name]=m.artifact(path)
        process=m.load_module('svm_process_fixture','zig/integration/multivm_process.py');artifacts={}
        for name in process.ROLES+process.LIBRARIES:
            path=case/('runtime-'+name);shutil.copyfile(template,path);path.chmod(0o755);artifacts[name]=m.artifact(path)
        log=output(case/'evidence/cohort-log.json',{'actual_checked_decoded_locks':[]});closure=output(case/'compiled-input-closure.json',{'scopes':{f:[]for f in m.SCOPES},'checks':[{'log':log}]})
        output(case/'tools/source-gate.json',{'source_before':{'fixture':'same'},'source_after':{'fixture':'same'}})
        context={'phase':'HYDRATED_NOT_EXECUTION_APPROVAL','nodes_started':False,'native_case_acceptance':False,'task_root':str(case),'scenario':scenario,'mode':'ReleaseSafe','execution_source_commit':initial['execution_source_commit'],'runtime_source_commit':initial['execution_source_commit'],'request':request_pin,'producer_receipt':receipt,'runtime_artifacts':artifacts,'tools':tools,'writers':{'ReleaseSafe':tools['init-db'],'ReleaseFast':tools['init-db']},'harness':{'normal':tools['init-db'],'construction':tools['init-db']},'tool_manifest':output(case/'tools/manifest.json',{}),'compiled_input_closure':closure,'consumer_cpu':{'architecture':'amd64'},'svm_prerequisites':{'actual':'dataset-A'}}
        stage.update(scenario=scenario,svm_assets=context['svm_prerequisites']);cp=case/'hydrated-inputs.json';output(cp,context)
        interop={'accepted_component_source_and_actual_Zig_storage_interop':True,'family_chain_SDK_finality_delivery_elapsed600_acceptance':False,'reader':tools['ziggy-native-rows'],'modes':{n:{'actual_writer_parent_wait_exit':0,'actual_db_files_rehashed':1,'raw_result':{}}for n in ['safe','fast']},'source_sha256':{'zig/integration/multivm_process.py':m.checksum(repo/'zig/integration/multivm_process.py')}}
        interop_pin=output(case/'accepted-native-rows-interop.json',interop);stage_pin=output(repo/'stage.json',stage);actual_load=m.load_module
        def module(name,relative):
            if name=='case_tool_readmission':return SimpleNamespace(load_manifest=lambda *a:tools)
            if name in {'validate_svm_case','prepare_svm_case'}:return SimpleNamespace(check_inspection=lambda *a:None,materialize=lambda *a:({'schema':2,'fixture':'SYNTHETIC_NOT_NATIVE'},[]))
            return actual_load(name,relative)
        with mock.patch.object(m.sys,'platform','linux'),mock.patch.object(m.platform,'machine',return_value='x86_64'),mock.patch.object(m,'producer_receipt',return_value={}),mock.patch.object(m,'cohort',return_value=[]),mock.patch.object(m,'decoded_locks',return_value=[]),mock.patch.object(m,'interop_summary',return_value=interop),mock.patch.object(m,'load_module',side_effect=module):paths=m.prepare(cp,m.checksum(cp),interop_pin,stage_pin,repo)
        manifest=json.loads(paths['manifest'].read_text());process.validate_manifest(manifest);owner=load('svm_prepared_owner',repo/'zig/bench/native_case_owner.py');plan,_,inputs,approval=owner.load_plan(paths['launch-plan'],m.checksum(paths['launch-plan']))
        self.assertEqual(plan['harness_argv'][1:],owner.FILTERS[scenario]);self.assertEqual(plan['clean_fixture_parent_waits_required'],1 if scenario=='sealevel-composite'else 2);self.assertEqual(manifest['tool_overrides'],{});self.assertEqual(approval['svm_assets'],inputs['svm_assets']);self.assertEqual(inputs['initial_corpus'],{'dispatches':2,'deliveries':2,'unpaid':0}if scenario=='sealevel-composite'else{'dispatches':13,'deliveries':12,'unpaid':1});self.assertEqual(plan['confirm_seconds'],600);self.assertEqual(plan['grace_seconds'],30);self.assertFalse(plan['native_case_acceptance'])
        if scenario=='sealevel-composite':
            self.assertTrue(all(key not in inputs and key not in approval for key in ['postgres','local_docker']));self.assertNotIn('DOCKER_HOST',plan['explicit_environment']);self.assertNotIn('DOCKER_CONFIG',plan['explicit_environment'])

    def test_actual_basic_prepare_outputs_pass_existing_manifest_and_owner_gates(self):self.exercise_prepare()
    def test_actual_composite_prepare_outputs_have_noPG_Docker_or_scraper(self):self.exercise_prepare('sealevel-composite')

    def test_exact_composite_policy_requires_nullPG_and_actual_six_artifacts(self):
        request=self.request();request.update(scenario='sealevel-composite',postgres=None);self.assertIs(ci.validate_request(request),request);self.assertEqual(len(ci.artifact_names(request)),6)
        for policy in [{},self.request()['postgres']]:
            bad=copy.deepcopy(request);bad['postgres']=policy
            with self.assertRaisesRegex(ValueError,'no PG'):ci.validate_request(bad)
    def test_source_composite_profile_and_one_exact_child_wait(self):
        p=api.profile('sealevel-composite');self.assertEqual(p['initial_corpus'],{'dispatches':2,'deliveries':2,'unpaid':0});self.assertEqual(p['chain_names'],['sealeveltest1','sealeveltest2']);self.assertNotIn('postgres',p);self.assertNotIn('local_docker',p)
        owner=load('composite_wait_owner',HERE/'native_case_owner.py')
        with tempfile.TemporaryDirectory()as tmp:
            path=Path(tmp)/'waits.jsonl';row={'pid':12,'role':'fixture-svm-SOL','parent_pid':42,'parent_wait_completed':True,'forced_kill':False,'purpose':'fixture_teardown','already_exited':False};path.write_text(json.dumps(row)+'\n');self.assertEqual(len(owner.fixture_waits(path,'sealevel-composite',42)),1)
            path.write_text(json.dumps(row)+'\n'+json.dumps(dict(row,pid=13,role='fixture-docker'))+'\n')
            with self.assertRaises(ValueError):owner.fixture_waits(path,'sealevel-composite',42)
    def test_composite_no_container_is_NA_never_fake_absence_or_Docker_credit(self):
        owner=load('composite_resource_owner',HERE/'native_case_owner.py');self.assertEqual(owner.container_reservation('sealevel-composite'),(0,0));self.assertEqual(owner.container_reservation('sealevel'),(owner.GIB,2*owner.GIB));self.assertEqual(owner.container_reservation('starknet'),(5*owner.GIB,2*owner.GIB))
        result={'owned_container_absent':None,'container_fixture_configured':False,'docker_calls':[]};self.assertTrue(owner.container_observation_ok('sealevel-composite',result))
        for key,value in [('owned_container_absent',True),('container_fixture_configured',True),('docker_calls',[{'called':'Docker'}])]:
            bad=dict(result);bad[key]=value;self.assertFalse(owner.container_observation_ok('sealevel-composite',bad))
    def test_composite_public_projection_keeps_only_safe_actual_ISM_verdict(self):
        tests=load('composite_public_fixture',HERE/'native_case_owner_test.py');state=next(v for v in vars(tests).values()if isinstance(v,type)and hasattr(v,'public_snapshot_fixture'))();raw=state.public_snapshot_fixture();raw['scenario']='sealevel-composite';raw['postgres']=[{'scraper_configured_by_Source':False}]
        raw['family_native_row_proofs'][0]['actual_composite']={'aggregation_threshold':3,'branches':['unpaused','rateLimited','fallbackRouting'],'rate_limit_capacity':100000000000,'fallback':'0x'+'ab'*32,'private':'DO-NOT-EXPORT-COMPOSITE'}
        out=tests.api.public_native_snapshot(raw);self.assertEqual(out['family_native_row_proofs'][0]['actual_composite']['aggregation_threshold'],3);self.assertNotIn('DO-NOT-EXPORT',json.dumps(out));self.assertEqual(out['postgres'],[{'scraper_configured_by_Source':False}])

if __name__=='__main__':unittest.main()
