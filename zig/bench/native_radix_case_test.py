"""Pure admission controls. Synthetic receipts never qualify an actual product."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location('radix_control_' + name, HERE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


m = load('native_radix_case')
assets = load('native_radix_assets')


class Controls(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.repo = self.root / 'repo'
        self.artifact = self.root / 'download'
        self.repo.mkdir()
        self.artifact.mkdir()
        self.request = {'scenario': 'radix', 'postgres': {'architecture': 'amd64'}, 'producer_source_commit': 'a' * 40,
                        'prerequisites': {'local_checkout_build': True, 'registry_commit': None, 'hpack': {},
                                         'radix_images': copy.deepcopy(assets.IMAGES),
                                         'radix_contracts': {'release': '1.0.0', 'files': assets.CONTRACTS,
                                                             'metadata_bytes': assets.METADATA_BYTES, 'metadata_sha256': assets.METADATA_SHA},
                                         'radix_reference': {'same_producer_source': True, 'actual_sdk_tests': 5, 'locked_offline': True}}}

    def pin(self, path):
        wire = path.read_bytes()
        return {'path': str(path), 'bytes': len(wire), 'sha256': hashlib.sha256(wire).hexdigest()}

    def fixture(self):
        source = {}
        for name in m.SOURCE_FILES:
            path = self.repo / m.REFERENCE / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('synthetic ' + name)
            source[m.REFERENCE + '/' + name] = {**self.pin(path), 'path': '/producer/different/path/' + name}
        self.manifest = self.artifact / 'manifest.json'
        self.gate = self.artifact / 'source-gate.json'
        self.product = self.artifact / 'reference'
        self.product.write_bytes(b'synthetic-qualified-by-mocked-loader')
        self.product.chmod(0o600)
        self.manifest.write_text(json.dumps({'source_gate': {'relative_path': 'source-gate.json'}}))
        self.gate.write_text(json.dumps({'source_before': source}))
        def member(base, row, relative):
            self.assertEqual(row['relative_path'], relative)
            return base / relative
        reference = SimpleNamespace(load_manifest=mock.Mock(return_value=self.pin(self.product)), member=member)
        api = SimpleNamespace(relative_file=lambda base, name: base / name, checksum=lambda path: self.pin(path)['sha256'],
                              artifact=self.pin, read_json=lambda path: json.loads(path.read_text()))
        receipt = {'artifacts': {'radix_reference': {'directory': str(self.artifact),
                    'files': [{'relative_path': p.name} for p in [self.product, self.manifest, self.gate]]}}}
        real = m.sibling
        siblings = lambda name: reference if name == 'native_radix_reference' else real(name)
        return receipt, api, reference, siblings

    def test_exact_policy_preserves_five_image_and_actual_reference_requirements(self):
        self.assertIs(m.validate_policy(self.request), self.request)
        for field in ['same_producer_source', 'actual_sdk_tests', 'locked_offline']:
            value = copy.deepcopy(self.request)
            value['prerequisites']['radix_reference'][field] = False
            with self.subTest(field=field), self.assertRaises(ValueError):
                m.validate_policy(value)

    def test_unknown_platform_image_and_prerequisite_are_refused(self):
        for kind in ['architecture', 'image', 'extra', 'missing']:
            value = copy.deepcopy(self.request)
            if kind == 'architecture':
                value['postgres']['architecture'] = 'arm64'
            elif kind == 'image':
                value['prerequisites']['radix_images']['fullnode']['source_image'] = 'foreign:tag'
            elif kind == 'extra':
                value['prerequisites']['unreviewed'] = True
            else:
                del value['prerequisites']['radix_reference']
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                m.validate_policy(value)

    def test_producer_and_consumer_absolute_paths_can_differ_when_actual_source_bytes_match(self):
        receipt, api, reference, siblings = self.fixture()
        with mock.patch.object(m, 'sibling', side_effect=siblings):
            value = m.inspect_reference(receipt, self.request, self.repo, 62, ['actual-flag'], api)
        self.assertEqual(set(value['consumed_compiled_source']), {m.REFERENCE + '/' + n for n in m.SOURCE_FILES})
        reference.load_manifest.assert_called_once_with(self.manifest, self.pin(self.manifest)['sha256'], 'a' * 40, 62, ['actual-flag'], transport_data_only=True)
        self.assertFalse(value['native_case_acceptance'])

    def test_changed_consumer_source_is_not_masked_by_producer_recipe(self):
        receipt, api, _, siblings = self.fixture()
        (self.repo / m.REFERENCE / 'src/main.rs').write_text('changed')
        with mock.patch.object(m, 'sibling', side_effect=siblings), self.assertRaisesRegex(ValueError, 'Source changed'):
            m.inspect_reference(receipt, self.request, self.repo, 62, [], api)

    def test_reference_loader_failure_cannot_be_relabelled_as_admission(self):
        receipt, api, reference, siblings = self.fixture()
        reference.load_manifest.side_effect = ValueError('actual SDK/cohort gate failed')
        with mock.patch.object(m, 'sibling', side_effect=siblings), self.assertRaisesRegex(ValueError, 'SDK/cohort'):
            m.inspect_reference(receipt, self.request, self.repo, 62, [], api)
        self.assertFalse((self.root / 'tools').exists())

    def test_missing_extracted_member_cannot_pass_reference_closure(self):
        receipt, api, _, siblings = self.fixture()
        receipt['artifacts']['radix_reference']['files'] = [{'relative_path': 'reference'}]
        with mock.patch.object(m, 'sibling', side_effect=siblings), self.assertRaisesRegex(ValueError, 'extraction closure'):
            m.inspect_reference(receipt, self.request, self.repo, 62, [], api)

    def test_configuration_contains_no_source_seed_and_only_reviewed_images(self):
        value = m.fixture_configuration('1' * 32)
        self.assertEqual(set(value['images']), set(assets.SERVICES))
        self.assertEqual(set(value), {'architecture', 'token', 'images'})
        self.assertNotIn('private_key', json.dumps(value))


class ClientWaitControls(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'waits.jsonl'
        self.api = load('native_radix_custody')
        self.tool = {'path': '/approved/docker', 'bytes': 10, 'sha256': 'c' * 64}
        base = {'schema': 1, 'purpose': 'radix-fixture-docker-client', 'runtime_source_commit': 'a' * 40,
                'mode': 'ReleaseSafe', 'parent_pid': 42, 'pid': 50, 'os': 'linux', 'os_start_token': 'linux-ticks:100',
                'executable': self.tool, 'parent_wait_completed': True, 'exit_code': 0, 'signal': None,
                'forced_cleanup': False, 'elapsed_monotonic_ns': 100, 'output_bytes': 2, 'output_sha256': 'd' * 64,
                'success': True, 'error': None, 'arguments': ['compose', '--project-name', 'owned', 'up', '--detach', '--no-build', '--pull', 'never']}
        self.rows = [base, {**base, 'pid': 51, 'os_start_token': 'linux-ticks:101', 'arguments': ['compose', '--project-name', 'owned', 'down', '--timeout', '15', '--volumes']}]
    def check(self):
        self.path.write_text(''.join(json.dumps(r)+'\n' for r in self.rows))
        return self.api.client_waits(self.path, 42, self.tool, 'a' * 40, 'ReleaseSafe')
    def test_real_client_waits_remain_distinct_from_daemon_container_evidence(self):
        self.assertEqual(len(self.check()), 2)
        self.assertTrue(all(r['parent_wait_completed'] for r in self.rows))
        self.assertNotIn('container_parent_wait', json.dumps(self.rows))
    def test_foreign_parent_source_executable_or_birth_identity_rejects(self):
        for key, value in [('parent_pid', 43), ('runtime_source_commit', 'b'*40), ('executable', {}), ('os_start_token', None), ('os', 'darwin')]:
            old = self.rows[0][key]
            self.rows[0][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError): self.check()
            self.rows[0][key] = old
    def test_failed_forced_unwaited_boolean_exit_or_clockless_client_rejects(self):
        for key, value in [('exit_code', 1), ('exit_code', False), ('forced_cleanup', True), ('parent_wait_completed', False), ('error', 'failure'), ('elapsed_monotonic_ns', None), ('output_sha256', None)]:
            old = self.rows[0][key]
            self.rows[0][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValueError): self.check()
            self.rows[0][key] = old
    def test_repeated_birth_identity_or_absent_compose_down_cannot_qualify(self):
        self.rows[1]['pid'] = self.rows[0]['pid']
        self.rows[1]['os_start_token'] = self.rows[0]['os_start_token']
        with self.assertRaises(ValueError): self.check()
        self.rows = self.rows[:1]
        with self.assertRaisesRegex(ValueError, 'up/down'): self.check()

# Real output-graph construction; ALL upstream products/SDK/build/data admission
# below are synthetic mocks. No product, Docker, library or node is executed.
prep_spec=importlib.util.spec_from_file_location('radix_prepare_fixture',HERE.parent/'integration/native_case_inputs_test.py')
preparation=importlib.util.module_from_spec(prep_spec);prep_spec.loader.exec_module(preparation)


class PreparationGraphControls(unittest.TestCase):
    setUp=preparation.Controls.setUp
    git=preparation.Controls.git
    repository=preparation.Controls.repository
    fixture_stage=preparation.StageControls.fixture_stage

    def build(self,stage_failure=False):
        import shutil
        api=preparation.m
        self.root=self.root.resolve();stage,base,request=self.fixture_stage('cosmosnative')
        stage['scenario']='radix';stage['tools'].pop('native_cli');request['prerequisites'].pop('native_cli')
        request.update(scenario='radix',producer_source_commit=base['execution_source_commit'],limits=api.LIMITS.copy(),postgres={'schema':2,'image':'postgres:14','image_id':'sha256:'+'1'*64,'repo_digest':'postgres@sha256:'+'2'*64,'architecture':'amd64'})
        request['prerequisites'].update(local_checkout_build=True,registry_commit=None,radix_images=copy.deepcopy(assets.IMAGES),radix_contracts={'release':'1.0.0','files':assets.CONTRACTS,'metadata_bytes':assets.METADATA_BYTES,'metadata_sha256':assets.METADATA_SHA},radix_reference={'same_producer_source':True,'actual_sdk_tests':5,'locked_offline':True})
        repo=self.root;case=repo/'case';case.mkdir()
        for name in('evidence','tools','home','tmp','docker-config'):(case/name).mkdir()
        for name in('native_case_owner.py','cold_matrix_owner.py','native_radix_case.py','native_radix_assets.py','native_radix_custody.py','native_radix_volume.py','native_radix_reference.py','native_starknet_custody.py'):
            target=repo/'zig/bench'/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(api.ROOT/'zig/bench'/name,target)
        for source in(api.ROOT/'zig/integration').glob('multivm_*.py'):
            target=repo/'zig/integration'/source.name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target)
        metadata=repo/'zig/integration/fixtures/radix-release-v1.0.0.json.gz';metadata.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(api.ROOT/'zig/integration/fixtures/radix-release-v1.0.0.json.gz',metadata)
        (repo/'rust/main/utils/run-locally').mkdir(parents=True)
        def output(path,value):path.write_text(json.dumps(value));return api.artifact(path)
        request_pin=output(repo/'request.json',request);receipt=output(repo/'receipt.json',{'mock_only':True})
        tools={};template=Path(stage['tools']['docker']['path'])
        for name in('init-db','ziggy-native-rows','ziggy-rocks-oracle','ziggy-rust-reference'):
            path=case/'tools'/name;shutil.copyfile(template,path);path.chmod(0o755);tools[name]=api.artifact(path)
        process=api.load_module('radix_graph_process','zig/integration/multivm_process.py');artifacts={}
        for name in process.ROLES+process.LIBRARIES:
            path=case/('runtime-'+name);shutil.copyfile(template,path);path.chmod(0o755);artifacts[name]=api.artifact(path)
        log=output(case/'evidence/cohort-log.json',{'actual_checked_decoded_locks':[]})
        closure=output(case/'compiled-input-closure.json',{'scopes':{family:[]for family in api.SCOPES},'checks':[{'log':log}]})
        output(case/'tools/source-gate.json',{'source_before':{'fixture':'same'},'source_after':{'fixture':'same'}})
        reference=repo/'reference';reference.mkdir();product=reference/'reference';shutil.copyfile(template,product);product.chmod(0o600)
        sources={}
        for name in m.SOURCE_FILES:
            src=api.ROOT/m.REFERENCE/name;target=repo/m.REFERENCE/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(src,target);sources[m.REFERENCE+'/'+name]=api.artifact(target)
        checks=[];check_files=[]
        for name in('sdk-tests','clippy','build'):
            path=reference/(name+'.log');path.write_text('SYNTHETIC upstream SDK admission; not executed')
            pin=api.artifact(path);checks.append({'name':name,'passed':True,'exit_code':0,'actual_parent_wait':True,'cleanup':{'clean':True},'log':{'relative_path':path.name,'bytes':pin['bytes'],'sha256':pin['sha256']}});check_files.append(pin)
        gate=output(reference/'source-gate.json',{'source_before':sources,'checks':checks})
        manifest=output(reference/'manifest.json',{'source_gate':{'relative_path':'source-gate.json','bytes':gate['bytes'],'sha256':gate['sha256']}})
        reference_value={'schema':1,'producer_source_commit':base['execution_source_commit'],'manifest':manifest,'source_gate':gate,'product':api.artifact(product),'consumed_compiled_source':sources,'producer_recipe_source':sources,'files':[api.artifact(product),manifest,gate,*check_files],'native_case_acceptance':False}
        context={'phase':'HYDRATED_NOT_EXECUTION_APPROVAL','nodes_started':False,'native_case_acceptance':False,'task_root':str(case),'scenario':'radix','mode':'ReleaseSafe','execution_source_commit':base['execution_source_commit'],'runtime_source_commit':base['execution_source_commit'],'request':request_pin,'producer_receipt':receipt,'runtime_artifacts':artifacts,'tools':tools,'writers':{'ReleaseSafe':tools['init-db'],'ReleaseFast':tools['init-db']},'harness':{'normal':tools['init-db'],'construction':tools['init-db']},'tool_manifest':output(case/'tools/manifest.json',{}),'compiled_input_closure':closure,'consumer_cpu':{'architecture':'amd64'},'radix_reference':reference_value}
        self.context_path=case/'hydrated-inputs.json';output(self.context_path,context)
        interop={'accepted_component_source_and_actual_Zig_storage_interop':True,'family_chain_SDK_finality_delivery_elapsed600_acceptance':False,'reader':tools['ziggy-native-rows'],'modes':{n:{'actual_writer_parent_wait_exit':0,'actual_db_files_rehashed':1,'raw_result':{}}for n in('safe','fast')},'source_sha256':{'zig/integration/multivm_process.py':api.checksum(repo/'zig/integration/multivm_process.py')}}
        interop_pin=output(case/'accepted-native-rows-interop.json',interop)
        contract=repo/'synthetic-contract';contract.write_bytes(b'data only; official gate mocked')
        bundle={'schema':1,'scenario':'radix','source_release':'1.0.0','root':str(repo),'release_metadata':api.artifact(metadata),'files':{name:api.artifact(contract)for name in assets.CONTRACTS}}
        images={}
        for name in assets.SERVICES:images[name]=output(repo/('image-'+name+'.json'),{'mock_only':True})
        stage['radix_assets']={'bundle':bundle,'images':images};stage_pin=output(repo/'stage.json',stage)
        actual_load=api.load_module;radix=m.sibling('native_radix_assets');case_module=m.sibling('native_radix_case')
        def fake_materialize(metadata_pin,files,destination):
            destination.mkdir();owned={}
            for name,row in files.items():
                target=destination/name;shutil.copyfile(row['path'],target);target.chmod(0o600);owned[name]=api.artifact(target)
            return dict(bundle,root=str(destination),files=owned)
        def load(name,relative):
            if name=='case_tool_readmission':return SimpleNamespace(load_manifest=lambda *args:tools)
            if relative=='zig/bench/native_radix_assets.py':return radix
            if relative=='zig/bench/native_radix_case.py':return case_module
            return actual_load(name,relative)
        self.case,self.repo,self.request,self.stage_pin=case,repo,request,stage_pin
        official=mock.Mock(side_effect=ValueError('mocked official data admission refused')if stage_failure else None,return_value=('mock-daemon',str(repo),repo.stat().st_dev))
        with mock.patch.object(api.sys,'platform','linux'),mock.patch.object(api.platform,'machine',return_value='x86_64'),mock.patch.object(api,'producer_receipt',return_value={}),mock.patch.object(api,'cohort',return_value=[]),mock.patch.object(api,'decoded_locks',return_value=[]),mock.patch.object(api,'interop_summary',return_value=interop),mock.patch.object(api,'load_module',side_effect=load),mock.patch.object(case_module,'validate_stage',official),mock.patch.object(radix,'materialize_contracts',side_effect=fake_materialize):
            paths=api.prepare(self.context_path,api.checksum(self.context_path),interop_pin,stage_pin,repo)
        self.assertEqual(official.call_count,2)
        spec=importlib.util.spec_from_file_location('actual_prepared_radix_owner',repo/'zig/bench/native_case_owner.py');owner=importlib.util.module_from_spec(spec);spec.loader.exec_module(owner)
        self.owner,self.paths,self.plan,self.manifest,self.inputs,self.approval=owner,paths,*owner.load_plan(paths['launch-plan'],api.checksum(paths['launch-plan']))
        process.validate_manifest(self.manifest)
        verifier=actual_load('radix_graph_evidence','zig/integration/multivm_evidence.py');verifier.verify_family_tools(self.manifest,self.inputs,self.approval)
        return api

    def test_actual_prepare_manifest_owner_and_family_reference_graph_without_native_execution(self):
        self.build()
        self.assertEqual(self.plan['harness_argv'][1:],['--exact','radix::test::test_run','--nocapture','--test-threads=1'])
        self.assertEqual(self.plan['clean_fixture_parent_waits_required'],1)
        self.assertEqual(self.plan['maximum_wall_seconds'],3600)
        self.assertEqual((self.plan['confirm_seconds'],self.plan['grace_seconds']),(600,30))
        self.assertFalse(self.plan['native_case_acceptance']);self.assertFalse(self.approval['native_case_acceptance'])
        self.assertEqual(self.inputs['family_tools'],self.approval['family_tools'])
        reference=self.inputs['family_tools']['radix_reference'];self.assertTrue(Path(reference['path']).is_relative_to(self.case))
        self.assertEqual(Path(reference['path']).stat().st_mode&0o777,0o755)
        self.assertEqual(set(self.inputs['radix_localnet']['images']),set(assets.SERVICES))
        self.assertEqual(self.inputs['radix_daemon']['filesystem_device'],self.case.stat().st_dev)
        required={r['path']for r in self.plan['required_inputs']}
        self.assertIn(reference['path'],required)
        for name in('native_radix_case.py','native_radix_assets.py','native_radix_custody.py','native_radix_volume.py','native_radix_reference.py','native_starknet_custody.py'):
            self.assertIn(str(self.repo/'zig/bench'/name),required)
        acceptance=json.loads(Path(self.approval['family_tool_acceptance']['radix_reference']['path']).read_text())
        self.assertFalse(acceptance['native_case_acceptance']);self.assertFalse(acceptance['timing_acceptance'])
        self.assertFalse(any(k in self.plan['explicit_environment']for k in('GH_TOKEN','GITHUB_TOKEN','PYTHONPATH','DOCKER_CONTEXT')))
    def test_missing_custody_source_required_closure_refused_by_actual_owner(self):
        api=self.build();original=json.loads(self.paths['launch-plan'].read_text())
        for name in ('native_radix_custody.py','native_radix_volume.py'):
            plan=copy.deepcopy(original);plan['required_inputs']=[r for r in plan['required_inputs']if not r['path'].endswith('/'+name)]
            self.paths['launch-plan'].write_text(json.dumps(plan))
            with self.subTest(name=name),self.assertRaisesRegex(ValueError,'Source closure'):self.owner.load_plan(self.paths['launch-plan'],api.checksum(self.paths['launch-plan']))
    def test_missing_family_reference_acceptance_refused_by_actual_verifier(self):
        api=self.build();verifier=api.load_module('radix_graph_refusal','zig/integration/multivm_evidence.py');approval=copy.deepcopy(self.approval);approval['family_tool_acceptance']={}
        with self.assertRaisesRegex(ValueError,'acceptance'):verifier.verify_family_tools(self.manifest,self.inputs,approval)
    def test_changed_owned_reference_refused_without_running_it(self):
        api=self.build();reference=Path(self.inputs['family_tools']['radix_reference']['path']);reference.write_bytes(b'changed')
        with self.assertRaises(ValueError):self.owner.load_plan(self.paths['launch-plan'],api.checksum(self.paths['launch-plan']))
    def test_actual_outer_owner_attempts_radix_and_pg_recovery_after_process_cleanup_exception(self):
        api=self.build();owner=self.owner;output=self.case/'supervision'
        child=SimpleNamespace(pid=12345,returncode=0)
        recovered={'passed':False,'container_absent':False,'recovery_needed':True}
        with mock.patch.object(owner.sys,'platform','linux'),mock.patch.object(owner.sys,'argv',['owner','--plan',str(self.paths['launch-plan']),'--plan-sha256',api.checksum(self.paths['launch-plan']),'--output',str(output)]),mock.patch.object(owner.owner,'enable_subreaper'),mock.patch.object(owner.owner,'stop_owned',side_effect=RuntimeError('injected process cleanup failure')),mock.patch.object(owner.subprocess,'Popen',return_value=child),mock.patch.object(owner.os,'waitid',return_value=SimpleNamespace()),mock.patch.object(owner.signal,'signal'),mock.patch.object(owner,'recover_owned_radix',return_value=recovered)as radix_recovery,mock.patch.object(owner,'recover_owned_pg',return_value={'container_absent':True,'container_id':None})as pg_recovery:
            with self.assertRaisesRegex(ValueError,'Owned native case failed'):owner.main()
        radix_recovery.assert_called_once();pg_recovery.assert_called_once()
        result=json.loads((output/'result.json').read_text())
        self.assertEqual(result['process_cleanup_error']['type'],'RuntimeError')
        self.assertFalse(result['passed']);self.assertFalse(result['native_case_acceptance'])

    def test_official_data_refusal_prevents_manifest_approval_or_owner_plan(self):
        with self.assertRaisesRegex(ValueError,'official data admission refused'):self.build(stage_failure=True)
        self.assertFalse((self.case/'manifest.json').exists());self.assertFalse((self.case/'launch-plan.json').exists());self.assertFalse((self.case/'execution-approval.json').exists())


if __name__ == '__main__':
    unittest.main()
