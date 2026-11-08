"""Socket/process-free full-case composition controls; no SDK/main invocation."""
import ast
import copy
import gzip
import hashlib
import json
from pathlib import Path
import selectors
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE));sys.path.insert(0,str(HERE.parent/'aleo_linux_sdk'));sys.path.insert(0,str(HERE.parent/'aleo_linux'))
import case_delegate as delegate
import case_supervisor as supervisor
import case_specs as specs
import namespace_policy
import bridge_close
import case_assets
import public_proof
import controller_resources


class Service(unittest.TestCase):
    def setUp(self):
        self.spec={'schema':1,'purpose':'aleo-linux-case-service-v1','root_approved':True,'run_token':'a'*32}
        self.uid=patch.object(delegate.os,'getuid',return_value=1001);self.uid.start()
        self.euid=patch.object(delegate.os,'geteuid',return_value=1001);self.euid.start()
        self.gid=patch.object(delegate.os,'getgid',return_value=117);self.gid.start()
        self.egid=patch.object(delegate.os,'getegid',return_value=117);self.egid.start()
        self.addCleanup(patch.stopall)
        unit=delegate.identity(self.spec)
        self.rows=dict(delegate.PROPERTIES,Id=unit,Description=unit,User='1001',Group='117',ControlGroup='/system.slice/'+unit,InvocationID='b'*32,DelegateControllers='memory pids',ActiveState='active')

    def test_actual_profile_and_service_family(self):
        self.assertEqual(delegate.owned(self.rows,self.spec),'b'*32)
        self.assertEqual(delegate.MEMORY,14*1024**3);self.assertEqual(delegate.TASKS,1024)
        self.assertEqual(supervisor.CAPS['child_memory_bytes'],27*1024**3//2)
        self.assertEqual(supervisor.CAPS['pids'],512)
        self.assertEqual(supervisor.CAPS['combined_memory_bytes'],41*1024**3//2)

    def test_kernel_sdk_profiles_cannot_be_used_as_case(self):
        for family in ('kernel','sdk-packages','sdk-build','docker-probe'):
            value=dict(self.rows,Id='ziggy-aleo-'+family+'-'+'a'*32+'.service')
            with self.assertRaises(ValueError):delegate.owned(value,self.spec)
        for field,value in [('root_approved',False),('purpose','aleo-linux-sdk-service-v1'),('run_token','')]:
            with self.assertRaises(ValueError):delegate.identity(dict(self.spec,**{field:value}))

    def test_actual_caps_timers_and_invocation_required(self):
        for key in delegate.PROPERTIES:
            with self.assertRaises(ValueError,msg=key):delegate.owned(dict(self.rows,**{key:'wrong'}),self.spec)
        with self.assertRaises(ValueError):delegate.owned(self.rows,self.spec,'c'*32)
        with self.assertRaises(ValueError):delegate.owned(dict(self.rows,ControlGroup='/foreign'),self.spec)

    def test_launch_has_only_fixed_case_caps_and_actual_client_wait(self):
        tools={'sudo':'/usr/bin/sudo','systemd-run':'/usr/bin/systemd-run'}
        with patch.object(delegate,'checked',return_value=Path('/usr/bin/python3.12')):
            argv=delegate.launch_argv(dict(self.spec,tools={'python':{}}),tools,{'path':'/tmp/spec','sha256':'c'*64})
        for item in ('--wait','--pipe','--property=MemoryMax='+str(14*1024**3),'--property=MemorySwapMax=0','--property=TasksMax=1024','--property=RuntimeMaxSec=11160','--property=TimeoutStopSec=240','--property=NoNewPrivileges=yes'):self.assertIn(item,argv)
        self.assertNotIn('--privileged',argv);self.assertNotIn('set-property',argv)

    def test_non_EINTR_cancellation_escapes_actual_selector(self):
        selector=selectors.SelectSelector()
        def interrupted(*args):raise delegate.TaskInterrupted('cancel')
        with patch.object(selector,'_select',side_effect=interrupted):
            with self.assertRaises(delegate.TaskInterrupted):selector.select(.01)
        selector.close()

    def test_parent_final_gate_is_conjunctive(self):
        good={'Docker_recovery':{'passed':True,'complete_positive_custody':True,'performed_mutations':False},'payload_passed':True,'source_unchanged':True,'cleanup':{'owned_cgroup_absent':True},'client_wait':{'actual_parent_wait':True,'exit_code':0},'cleanup_errors':[]}
        self.assertTrue(delegate.final_pass(good))
        for changed in ({'Docker_recovery':None},{'Docker_recovery':{'passed':True,'complete_positive_custody':True,'performed_mutations':True}},{'payload_passed':False},{'source_unchanged':False},{'cleanup':None},{'cleanup':{'owned_cgroup_absent':False}},{'client_wait':None},{'client_wait':{'actual_parent_wait':True,'exit_code':False}},{'client_wait':{'actual_parent_wait':False,'exit_code':0}},{'error':'primary'},{'cleanup_errors':['failedwait']}):self.assertFalse(delegate.final_pass(dict(good,**changed)))

    def test_final_public_projection_binds_actual_outer_wait_and_no_raw_props(self):
        result={'Docker_recovery':{'passed':True,'complete_positive_custody':True,'performed_mutations':False},'payload_passed':True,'source_unchanged':True,'cleanup':{'owned_cgroup_absent':True},'client_wait':{'pid':123,'actual_parent_wait':True,'exit_code':0,'waits_for_systemd_client_only':True,'completed_monotonic_ns':999},'cleanup_errors':[],'unit':'public-unit','spec':{'path':'/public/spec'},'property_observations':[{'phase':'inside-before','observed_monotonic_ns':10,'properties':{key:'public-value'for key in delegate.base.QUERY}}],'actual_manager_limits_before':{'limits':{'memory.max':str(512*1024**2),'memory.swap.max':'0','pids.max':'128'}}}
        case={key:{'path':'/public/'+key}for key in ('sdk_owner_receipt','kernel_receipt','kernel_owner_receipt','docker_receipt','docker_owner_receipt')}
        proof={'kind':'public-actual-aleo-proof-v1','source':{}}
        out=delegate.qualify_public(proof,result,case)
        self.assertEqual(out['actual_case_service']['actual_client_wait']['exit_code'],0)
        self.assertFalse(out['actual_case_service']['daemon_container_parent_wait_credit'])
        bad=copy.deepcopy(result);bad['property_observations'][0]['properties']['Environment']='never-publish'
        with self.assertRaises(ValueError):delegate.qualify_public(proof,bad,case)
        with self.assertRaises(ValueError):delegate.qualify_public(proof,dict(result,error='original'),case)


class Namespace(unittest.TestCase):
    def argv(self):return namespace_policy.namespace_argv('/usr/bin/bwrap',['/usr','/opt/public'],{'control':'/tmp/case/control','task':'/tmp/case/data'},'/tmp/case/cap','/usr/bin/python3.12','/opt/public/inner.py','/opt/public/spec.json')

    def test_only_full_python_payload_is_pid1(self):
        argv=self.argv();self.assertEqual(argv.count('--as-pid-1'),1)
        self.assertLess(argv.index('--as-pid-1'),argv.index('--'))
        self.assertEqual(argv[argv.index('--')+1:],['/usr/bin/python3.12','-I','-B','/opt/public/inner.py','--spec','/opt/public/spec.json'])
        for flag in ('--unshare-net','--unshare-pid','--disable-userns','--assert-userns-disabled','--clearenv','--die-with-parent','--new-session'):self.assertIn(flag,argv)
        self.assertNotIn('--unshare-time',argv)

    def test_no_broad_host_mount_or_capability_write(self):
        for root in ('/','/home','/run','/var','/tmp','/proc','/sys'):
            with self.assertRaises(ValueError):namespace_policy.namespace_argv('/usr/bin/bwrap',['/usr',root],{'control':'/tmp/c/control','task':'/tmp/c/data'},'/tmp/c/cap','/usr/bin/python3.12','/opt/inner.py','/opt/spec')
        with self.assertRaises(ValueError):namespace_policy.namespace_argv('/usr/bin/bwrap',['/usr'],{'control':'/tmp/c','task':'/tmp/c/data'},'/tmp/c/cap','/usr/bin/python3.12','/opt/inner.py','/opt/spec')

    def test_resources_count_containers_tmpfs_and_foreign_deletion(self):
        g=1024**3
        good=supervisor.resource_verdict(13*g,g//2,g,0,20*g,20*g,20*g);self.assertTrue(good['passed'])
        for args in [(14*g,g//2,g,0,20*g,20*g,20*g),(g,g//2,5*g,0,20*g,22*g,22*g),(g,g//2,g,0,20*g,5*g,20*g),(g,g//2,g,0,20*g,20*g,5*g)]:self.assertFalse(supervisor.resource_verdict(*args)['passed'])
        self.assertEqual(good['reserved_combined_memory_bytes'],20*g)


class Bridge(unittest.TestCase):
    def bridge(self,started=False,close=lambda:None):
        return types.SimpleNamespace(stopping=threading.Event(),thread=types.SimpleNamespace(ident=1 if started else None,is_alive=lambda:False),server=types.SimpleNamespace(server_close=close),close=close)

    def test_unstarted_bridge_never_calls_shutdown(self):
        calls=[];bridge=self.bridge(close=lambda:calls.append('server-close'))
        bridge.close=lambda:(_ for _ in()).throw(AssertionError('shutdown must not run before start'))
        value=bridge_close.close_bridge_bounded(bridge,time.monotonic_ns()+10**9)
        self.assertEqual(calls,['server-close']);self.assertFalse(value['server_started']);self.assertFalse(value['nonchild_wait_credit'])

    def test_actual_blocked_close_is_bounded_failure_cleanup_continues(self):
        release=threading.Event();finished=threading.Event();calls=[]
        def block():
            try:release.wait(1)
            finally:finished.set()
        bridge=self.bridge(True,block);errors=[];started=time.monotonic()
        try:
            supervisor.cleanup_phase(errors,'bridge',lambda:bridge_close.close_bridge_bounded(bridge,time.monotonic_ns()+20_000_000))
            supervisor.cleanup_phase(errors,'network',lambda:calls.append('owned-network-cleanup'))
            self.assertLess(time.monotonic()-started,.5);self.assertTrue(errors);self.assertEqual(calls,['owned-network-cleanup'])
        finally:release.set();self.assertTrue(finished.wait(1))

    def test_close_exception_retained_without_losing_primary(self):
        errors=[];result={'error':'original case failure'};calls=[]
        bridge=self.bridge(close=lambda:(_ for _ in()).throw(RuntimeError('broken close')))
        supervisor.cleanup_phase(errors,'bridge',lambda:bridge_close.close_bridge_bounded(bridge,time.monotonic_ns()+10**9))
        supervisor.cleanup_phase(errors,'Source',lambda:calls.append('rehash'))
        self.assertEqual(result['error'],'original case failure');self.assertTrue(errors);self.assertEqual(calls,['rehash'])


class Inputs(unittest.TestCase):
    def test_publisher_set_exact_and_no_inclusion(self):
        grant=json.loads(gzip.decompress((HERE/'closed-cache-assets.json.gz').read_bytes()));rows=case_assets.plan(grant)
        self.assertEqual(len(rows),9);self.assertEqual(sum(r['bytes']for r in rows),79506114)
        self.assertTrue(all('inclusion'not in r['url']for r in rows))
        for changed in (grant['assets'][:-1],grant['assets']+[grant['assets'][0]]):
            with self.assertRaises(ValueError):case_assets.plan({'assets':changed})
        altered=copy.deepcopy(grant);altered['assets'][0]['url']='https://unapproved.example/parameter'
        with self.assertRaises(ValueError):case_assets.plan(altered)

    def test_actual_sdk_original_source4_added_without_package_changes(self):
        tree=ast.parse((HERE.parent/'aleo_linux_sdk/sdk_provision.py').read_text())
        fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='source_paths')
        fixed=next(n for n in fn.body if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='fixed'for t in n.targets))
        values=ast.literal_eval(fixed.value)
        for name in ('zig/src/native_rows_interop_fixture.zig','zig/integration/native_rows_interop.py','zig/bench/native_case_tools.py','zig/bench/native_harness_census.py'):self.assertIn(name,values)
        # Ordinary manager argv remains frozen/no lifecycle; no source generator.
        import sdk_provision
        argv=sdk_provision.install_argv(Path('/opt/pnpm'),Path('/tmp/owned'))
        for value in ('--frozen-lockfile','--ignore-scripts','--filter','@hyperlane-xyz/aleo-sdk...','--config.verify-store-integrity=true'):self.assertIn(value,argv)

    def test_hydrated_ten_product_admission_actual_ast(self):
        source=(HERE/'case_cohort.py').read_text();fn=next(n for n in ast.parse(source).body if isinstance(n,ast.FunctionDef)and n.name=='source_cohort')
        start=next(i for i,n in enumerate(fn.body)if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='names'for t in n.targets))
        body=fn.body[start:start+4]
        code=compile(ast.fix_missing_locations(ast.Module(body=body,type_ignores=[])),'actual-cohort-admission','exec')
        names={'relayer':'relayer','validator':'validator','scraper':'scraper','worker':'worker','aleo-crypto':'aleoCrypto','aleo-vm':'aleoVm','starknet':'starknetCrypto','regex':'regex','url':'url'}
        values={name:{'path':name}for name in names};values['init-db']={'path':'init-db'}
        env={'value':{'runtime_artifacts':values,'tools':{'init-db':values['init-db']}},'need':specs.need}
        exec(code,env);self.assertEqual(set(env['products']),set(names.values()))
        for mutate in ('missing-init','extra','crossed-init'):
            changed=copy.deepcopy(env['value'])
            if mutate=='missing-init':del changed['runtime_artifacts']['init-db']
            elif mutate=='extra':changed['runtime_artifacts']['unknown']={}
            else:changed['tools']['init-db']={'path':'different'}
            with self.assertRaises(ValueError):exec(code,dict(env,value=changed))

    def canonical_transport_boundary(self, cohort_source=None, mutate=None):
        # Actual checked-in encoded request -> exact canonical public decoder ->
        # actual producer_receipt request-validation prefix. No Git, HTTP,
        # SDK/library or transport child is executed; downstream IO is excluded.
        repo=HERE.parents[2]
        dispatch_path=repo/'zig/bench/native_case_ci.py'
        spec=__import__('importlib.util',fromlist=['spec_from_file_location']).spec_from_file_location('actual_canonical_dispatch',dispatch_path)
        dispatch=__import__('importlib.util',fromlist=['module_from_spec']).module_from_spec(spec);spec.loader.exec_module(dispatch)
        payload=json.loads((HERE/'transport-ReleaseSafe.PENDING.json').read_text())
        payload['root_approved']=True  # Positive control is independent of live activation.
        self.assertIsInstance(payload['postgres']['image_id'],dict)
        self.assertIsInstance(payload['postgres']['canonical_digest'],dict)
        self.assertIsInstance(next(iter(payload['artifact_pins'].values()))['sha256'],dict)
        if mutate:mutate(payload)
        with tempfile.TemporaryDirectory()as directory:
            path=Path(directory).resolve()/'request.json';path.write_text(json.dumps(payload));wire=path.read_bytes();request_pin=specs.pin(path)
            tree=ast.parse((repo/'zig/integration/native_case_inputs.py').read_text());producer=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='producer_receipt')
            end=next(i for i,n in enumerate(producer.body)if isinstance(n,ast.Expr)and isinstance(n.value,ast.Call)and isinstance(n.value.func,ast.Attribute)and n.value.func.attr=='validate_request')
            # Reuse the real prefix including receipt parsing and actual dispatch
            # validation; only receipt/transport acquisition is mocked here.
            prefix=copy.deepcopy(producer);prefix.body=prefix.body[:end+1]+[ast.Return(value=ast.Name(id='request',ctx=ast.Load()))]
            space={'Path':Path,'checked':specs.checked,'read_json':lambda path:{},'load_module':lambda name,path:dispatch}
            exec(compile(ast.fix_missing_locations(ast.Module(body=[prefix],type_ignores=[])),'actual-producer-request-boundary','exec'),space)
            calls=[]
            def load_module(name,relative):
                calls.append((name,relative));self.assertEqual(relative,'zig/bench/native_case_ci.py');return dispatch
            module=types.SimpleNamespace(load_module=load_module,producer_receipt=space['producer_receipt'])
            source=(HERE/'case_cohort.py').read_text()if cohort_source is None else cohort_source;fn=next(n for n in ast.parse(source).body if isinstance(n,ast.FunctionDef)and n.name=='source_cohort')
            start=next(i for i,n in enumerate(fn.body)if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id in {'dispatch','request'}for t in n.targets));end=next(i for i,n in enumerate(fn.body)if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='producer'for t in n.targets))
            ns={'module':module,'value':{'request':request_pin,'producer_receipt':request_pin},'checked':specs.checked,'load':specs.load,'Path':Path,'execution_commit':'b'*40}
            exec(compile(ast.Module(body=fn.body[start:end+1],type_ignores=[]),'actual-case-cohort-caller','exec'),ns)
            self.assertEqual(path.read_bytes(),wire);self.assertEqual(specs.pin(path),request_pin)
            return ns['producer'],calls

    def test_actual_encoded_transport_uses_canonical_request_reader(self):
        request,calls=self.canonical_transport_boundary()
        self.assertTrue(request['postgres']['image_id'].startswith('sha256:'))
        self.assertTrue(request['postgres']['canonical_digest'].startswith('postgres@sha256:'))
        self.assertTrue(all(isinstance(row['sha256'],str)and len(row['sha256'])==64 for row in request['artifact_pins'].values()))
        self.assertEqual(calls,[('aleo_actual_case_dispatch','zig/bench/native_case_ci.py')])
        # Original plain JSON caller deterministically reproduces actualAleo4's
        # PG-policy failure rather than accidentally accepting encoded objects.
        source=(HERE/'case_cohort.py').read_text();original=source.replace("    dispatch=module.load_module('aleo_actual_case_dispatch','zig/bench/native_case_ci.py')\n    request=dispatch.read_request(checked(value['request']))","    request=load(value['request'])")
        self.assertNotEqual(original,source)
        with self.assertRaisesRegex(ValueError,'Independent PG config ID and RepoDigest required'):self.canonical_transport_boundary(original)

    def test_canonical_transport_decoder_preserves_closed_encoding_refusals(self):
        for mutate in [lambda v:v['postgres']['image_id'].update(prefix='foreign:'),lambda v:v['postgres']['canonical_digest']['sha256_hex_chunks'].append('a'*32),lambda v:next(iter(v['artifact_pins'].values()))['sha256'].update(extra=True)]:
            with self.subTest(mutate=mutate),self.assertRaises(ValueError):self.canonical_transport_boundary(mutate=mutate)

    def test_profile_public_inputs_preserve_full_original_workload(self):
        p=specs.public_profile()
        self.assertEqual(p['consensusHeights'],list(range(17)));self.assertEqual(p['deadlineSeconds'],10800)
        self.assertEqual([d['domain']for d in p['domains']],[3999999998,3999999999])
        self.assertEqual(p['proxyPorts'],[23033,23034]);self.assertTrue(p['postgresImage']['reference'].startswith('postgres@sha256:'))
        self.assertEqual(p['postgresDomainMetadata'],{'nativeToken':'ALEO','chainId':1})

    def test_no_case_service_or_clock_is_run_at_import(self):
        # Entry guards are inert, and no proposed binding or pending output is
        # instantiated by import. Host methods are tested only via pure helpers.
        for name in ('case_delegate.py','case_supervisor.py','case_specs.py','case_assets.py'):
            tree=ast.parse((HERE/name).read_text())
            self.assertTrue(any(isinstance(n,ast.If)and isinstance(n.test,ast.Compare)and isinstance(n.test.left,ast.Name)and n.test.left.id=='__name__'for n in tree.body))
            self.assertFalse(any(isinstance(n,ast.Expr)and isinstance(n.value,ast.Call)and isinstance(n.value.func,ast.Attribute)and n.value.func.attr in {'Popen','run','execve'}for n in tree.body))



class NamespacePins(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve()
        def file(name,content='public fixture'):
            p=self.root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(content);return specs.pin(p)
        self.file=file
        stage=self.root/'stage';source=file('stage/source.ts');output=file('stage/index.js');dependency=file('stage/dependency.js')
        self.secret=file('checkout/.git/config','secret must not be mounted')
        self.sdk={'spec':file('host-only/sdk.spec',json.dumps({'stage':str(stage)})),'source_files':[source],'outputs':[output],'dependency_payloads':[dependency],'source_origins':[{'origin':self.secret,'staged':source}]}
        shim=self.root/'shim';(shim/'aleo_linux_sdk').mkdir(parents=True);(shim/'aleo_linux').mkdir()
        (shim/'aleo_linux_sdk/docker_gate.py').write_bytes((specs.SDK/'docker_gate.py').read_bytes())
        (shim/'aleo_linux/receipts.py').write_bytes((specs.KERNEL/'receipts.py').read_bytes())
        docker=file('shim/aleo_linux_sdk/docker_cli.py');tool=file('products/tool');parameter=file('params/.aleo/resources/p')
        raw=file('interop/result.json','{}');old=file('interop/old.json');native=file('interop/native.json');database=file('interop/db/CURRENT')
        Path(raw['path']).write_text(json.dumps({'artifacts':{'writer':tool},'fixture_root':str(self.root/'interop'),'database_file_hashes_after_old_oracle':{'CURRENT':{'bytes':database['bytes'],'sha256':database['sha256']}}}));raw=specs.pin(Path(raw['path']))
        summary=file('metadata/summary.json',json.dumps({'modes':{'safe':{'raw_result':raw,'old_canonical_command':old,'native_reader_command':native},'fast':{'raw_result':raw,'old_canonical_command':old,'native_reader_command':native}}}))
        metadata=file('metadata/a.json',json.dumps({'grant':file('metadata/publisher-grant.json','{}')}));manifest={'sourceFiles':[source],'artifacts':{'relayer':tool},'tools':{'docker':docker,'node':tool},'parameterFiles':[parameter],'sourceGates':[metadata],'acceptedBuild':metadata,'sdkBuild':metadata,'nativeRowsAcceptance':summary,'approval':metadata,'parameterHome':str(self.root/'params')}
        self.spec={'manifest':file('metadata/manifest.json',json.dumps(manifest)),'policy_template':metadata,'python':tool,'node':tool,'bwrap':tool,'system_libraries':{'http':tool,'crypto':tool},'storage_interop':summary}

    def test_visible_leaves_exclude_actual_host_only_origins(self):
        rows=specs.namespace_inputs(self.spec,self.sdk);names={row['path']for row in rows}
        self.assertNotIn(self.secret['path'],names);self.assertNotIn(self.sdk['spec']['path'],names)
        self.assertTrue(any(p.endswith('/interop/db/CURRENT')for p in names))
        self.assertEqual(len(rows),len(names))

    def test_mount_derivation_never_mounts_whole_checkout_or_tmp(self):
        roots=specs.namespace_roots(self.spec,self.sdk)
        self.assertIn('/usr',roots);self.assertIn(str(self.root/'stage'),roots)
        for root in ('/',str(self.root),str(self.root/'checkout'),'/tmp','/private/tmp'):
            self.assertNotIn(root,roots)
        self.assertTrue(any(p.endswith('/shim/aleo_linux/receipts.py')for p in roots))

    def test_shim_sibling_changed_fails_before_namespace(self):
        (self.root/'shim/aleo_linux/receipts.py').write_text('different bytes')
        with self.assertRaisesRegex(ValueError,'shim sibling'):specs.namespace_inputs(self.spec,self.sdk)

    def test_changed_stopped_db_does_not_get_new_trusted_pin(self):
        (self.root/'interop/db/CURRENT').write_text('changed stopped database')
        with self.assertRaises(ValueError):specs.namespace_inputs(self.spec,self.sdk)

    def strict_namespace_guard(self,spec):
        # Execute the actual unchanged admission predicate, not a second
        # acceptance implementation. Other native prerequisites are out of scope.
        tree=ast.parse((HERE/'case_specs.py').read_text());fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='admission');node=next(n for n in fn.body if isinstance(n,ast.Expr)and isinstance(n.value,ast.Call)and len(n.value.args)>1 and isinstance(n.value.args[1],ast.Constant)and n.value.args[1].value=='derived closed namespace leaves/mounts differ')
        space={'spec':spec,'sdk':self.sdk,'namespace_inputs':specs.namespace_inputs,'namespace_roots':specs.namespace_roots,'need':specs.need};exec(compile(ast.Module(body=[node],type_ignores=[]),'actual-namespace-admission-predicate','exec'),space)

    def bound_distinct_library_spec(self):
        spec=copy.deepcopy(self.spec);spec['system_libraries']={'http':self.file('libraries/http.so','http fixture'),'crypto':self.file('libraries/crypto.so','crypto fixture')};spec['namespace_pins']=specs.namespace_inputs(spec,self.sdk);spec['readonly_roots']=specs.namespace_roots(spec,self.sdk);return spec

    def test_actual_namespace_bind_atomic_sorted_payload_roundtrip_keeps_exact_derived_guard(self):
        spec=self.bound_distinct_library_spec();self.strict_namespace_guard(spec);self.assertEqual(list(spec['system_libraries']),['http','crypto'])
        payload=dict(spec,delegation_context=self.file('host-only/delegation.json','{}'),controller_receipt=self.file('host-only/controller.json','{}'),service_owner_spec=self.file('host-only/service.json','{}'));path=self.root/'host-only/payload.spec.json'
        delegate.base.atomic(path,payload);loaded=specs.load(specs.pin(path));self.assertEqual(list(loaded['system_libraries']),['crypto','http']);self.strict_namespace_guard(loaded)
        self.assertEqual(loaded['namespace_pins'],specs.namespace_inputs(loaded,self.sdk));self.assertEqual(loaded['readonly_roots'],specs.namespace_roots(loaded,self.sdk));self.assertEqual({r['path']:r for r in loaded['namespace_pins']},{r['path']:r for r in spec['namespace_pins']})
        self.assertNotIn(self.secret['path'],{r['path']for r in loaded['namespace_pins']});self.assertNotIn(payload['controller_receipt']['path'],{r['path']for r in loaded['namespace_pins']})

    def test_extra_missing_or_changed_library_and_extra_expected_pin_still_refuse(self):
        original=self.bound_distinct_library_spec();extra=self.file('libraries/extra.so','extra fixture')
        for mode in ['extra-library','missing-library','extra-expected-pin','changed-library']:
            spec=copy.deepcopy(original)
            if mode=='extra-library':spec['system_libraries']['extra']=extra
            elif mode=='missing-library':spec['system_libraries'].pop('http')
            elif mode=='extra-expected-pin':spec['namespace_pins'].append(extra)
            else:Path(spec['system_libraries']['http']['path']).write_bytes(b'changed')
            with self.subTest(mode=mode),self.assertRaises(ValueError):self.strict_namespace_guard(spec)



class MetadataShape(unittest.TestCase):
    def actual_supervisor_node_guard(self,manifest,node,python='/usr/bin/python3.12'):
        tree=ast.parse((HERE/'case_supervisor.py').read_text())
        run=next(row for row in tree.body if isinstance(row,ast.FunctionDef)and row.name=='run')
        guard=next(row for row in run.body if isinstance(row,ast.Expr)and isinstance(row.value,ast.Call)and any(isinstance(arg,ast.Constant)and arg.value=='exact Ubuntu Python and admitted Node required'for arg in row.value.args))
        exec(compile(ast.Module(body=[guard],type_ignores=[]),'actual-supervisor-node-admission','exec'),{'manifest':manifest,'node':node,'python':python,'need':supervisor.need})

    def test_actual_node_guard_rejects_wrong_python_or_tool_and_no_top_level_fallback(self):
        canonical={'tools':{'node':{'path':'/fixed/node'}}}
        self.actual_supervisor_node_guard(canonical,'/fixed/node')
        with self.assertRaises(ValueError):self.actual_supervisor_node_guard(canonical,'/other/node')
        with self.assertRaises(ValueError):self.actual_supervisor_node_guard(canonical,'/fixed/node','/other/python')
        with self.assertRaises(ValueError):self.actual_supervisor_node_guard({'node':{'path':'/fixed/node'},'tools':{'node':{'path':'/other/node'}}},'/fixed/node')
        with self.assertRaises(KeyError):self.actual_supervisor_node_guard({'node':{'path':'/fixed/node'}},'/fixed/node')

    def test_actual_SDK_spec_stage_and_hydrated_tool_names_flow_to_pending_only(self):
        # Synthetic boundary stubs model only field composition. They grant no
        # SDK/cohort/Docker/kernel acceptance and invoke no main or external tool.
        with tempfile.TemporaryDirectory()as tmp:
            root=Path(tmp).resolve();repo=root/'repo';repo.mkdir()
            def file(name,value='public shape fixture'):
                p=root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(value);return specs.pin(p)
            for name in specs.VERIFIERS:file('repo/'+name)
            stage=root/'stage';driver=file('stage/zig/integration/aleo_process.ts');test=file('stage/zig/integration/aleo_process_test.ts');entry=file('stage/typescript/aleo-sdk/dist/index.js')
            sdk={'spec':file('SDK.spec.json',json.dumps({'stage':str(stage)})),'sdk_entry':entry,'source_files':[driver,test],'worker_policy':{'allowed_worker_files':[],'allowed_eval_sha256':[]}}
            receipt=file('SDK.result.json',json.dumps(sdk));owner=file('SDK.owner.json','{}')
            context={'mode':'ReleaseSafe','tools':{name:file('tools/'+name)for name in ('init-db','ziggy-rocks-oracle','ziggy-native-rows','ziggy-rust-reference')}}
            context_pin=file('context.json',json.dumps(context));closure=file('closure.json',json.dumps({'checks':[{'name':'synthetic composition only','exit_code':0}]}))
            products={name:file('products/'+name)for name in ('relayer','validator','scraper','worker','aleoCrypto','aleoVm','starknetCrypto','regex','url')}
            cohort={'runtime_products':products,'compiled_input_closure':closure,'actual_waited_git_checks':[]}
            profile=specs.public_profile();probe={'images':{'image':profile['image'],'postgresImage':profile['postgresImage']},'daemon_id':'shape-daemon','docker_filesystem':str(root),'docker_socket':'/var/run/docker.sock','docker_api_version':'1.45','public_node_env':[]}
            tools={key:file('system/'+key)for key in ('node','python','bwrap','psql','ps')}
            shim=root/'shim/aleo_linux_sdk/docker_cli.py';shim.parent.mkdir(parents=True);shim.write_bytes((specs.SDK/'docker_cli.py').read_bytes());shim.chmod(0o700);tools['docker']=specs.pin(shim)
            parameter_home=root/'params';parameter_home.mkdir();grant=file('params/publisher-grant.json',gzip.decompress((HERE/'closed-cache-assets.json.gz').read_bytes()).decode())
            parameter=file('params/.aleo/resources/public-fixture')
            other=file('other.json','{}')
            binding={'schema':1,'root_approved':True,'purpose':'aleo-linux-fullcase-metadata-binding-v1','repo':str(repo),'execution_source_commit':'a'*40,'runtime_source_commit':'b'*40,'mode':'ReleaseSafe','run_token':'c'*32,'output':str(root/'case'),'control':str(root/'metadata'),'context':context_pin,'sdk_receipt':receipt,'sdk_owner_receipt':owner,'storage_interop':other,'kernel_receipt':other,'kernel_spec':other,'kernel_owner_receipt':other,'docker_receipt':other,'docker_owner_receipt':other,'assets':[],'parameter_home':str(parameter_home),'tools':tools,'http_library':file('system/libcurl'),'crypto_library':file('system/libcrypto')}
            binding_pin=file('binding.json',json.dumps(binding));actual_checked=specs.checked
            def checked(row):
                value=actual_checked(row)
                if row==tools['python']:return Path('/usr/bin/python3.12')
                if row==tools['ps']:return Path('/usr/bin/ps')
                return value
            with patch.object(specs,'checked',side_effect=checked),patch.object(specs,'sdk_receipt',return_value=sdk),patch.object(specs,'source_cohort',return_value=cohort),patch.object(specs,'storage_interop'),patch.object(specs,'docker_admission',return_value=probe),patch.object(specs,'kernel_pair'),patch.object(specs,'parameters',return_value=[parameter]):
                pending=specs.prepare(binding_pin)
            value=specs.load(pending);manifest=specs.load(specs.pin(root/'metadata/manifest-input.json'))
            self.assertIs(value['root_approved'],False);self.assertIsNone(value['readonly_roots']);self.assertIsNone(value['namespace_pins'])
            self.assertFalse((root/'case').exists());self.assertNotIn('original_deadline_ns',value)
            self.assertEqual(value['driver'],driver);self.assertEqual(value['sdk_entry'],entry)
            self.assertEqual(manifest['tools']['rocksOracle'],context['tools']['ziggy-rocks-oracle']);self.assertEqual(manifest['tools']['nativeRows'],context['tools']['ziggy-native-rows'])
            self.assertEqual(manifest['artifacts'],products);self.assertEqual(manifest['deadlineSeconds'],10800)
            self.assertNotIn('node',manifest);self.assertEqual(manifest['tools']['node'],tools['node'])
            try:self.actual_supervisor_node_guard(manifest,tools['node']['path'])
            except Exception as error:self.fail('Actual producer manifest rejected by actual supervisor: '+type(error).__name__)


class ControllerRSS(unittest.TestCase):
    def values(self):
        identity={'pid':10,'start':100,'group':1,'cgroup':'owned-host-line','exe':'/usr/bin/python3.12'}
        rows={10:{'pid':10,'parent':1,'group':1,'start':100,'state':'S','rss_bytes':100,'cgroup':'owned-host-line'},11:{'pid':11,'parent':10,'group':11,'start':101,'state':'S','rss_bytes':200,'cgroup':'owned-host-line'}}
        class FakePath:
            def __init__(self,*parts):self.parts=parts
            def __truediv__(self,value):return FakePath(*self.parts,value)
            def readlink(self):return '/usr/bin/python3.12'
            def read_text(self):return '11'if self.parts[1]=='10'else ''
        return identity,rows,FakePath

    def test_actual_rooted_tree_RSS_includes_setsid_client_without_signal_authority(self):
        identity,rows,paths=self.values()
        with patch.object(controller_resources,'row',side_effect=lambda pid:dict(rows[pid])),patch.object(controller_resources,'Path',paths):value=controller_resources.tree(identity)
        self.assertEqual(value['rss_bytes'],300);self.assertEqual([r['group']for r in value['processes']],[1,11]);self.assertFalse(value['actual_parent_wait_or_signal_credit'])

    def test_reused_original_controller_is_not_live_proof(self):
        identity,rows,paths=self.values();rows[10]['start']=999
        with patch.object(controller_resources,'row',side_effect=lambda pid:dict(rows[pid])),patch.object(controller_resources,'Path',paths):
            with self.assertRaises(ValueError):controller_resources.tree(identity)

    def test_foreign_parent_or_moved_cgroup_rejected_before_RSS_credit(self):
        for changed in ({'parent':9},{'cgroup':'foreign'}):
            identity,rows,paths=self.values();rows[11].update(changed)
            with patch.object(controller_resources,'row',side_effect=lambda pid:dict(rows[pid])),patch.object(controller_resources,'Path',paths):
                with self.assertRaises(ValueError):controller_resources.tree(identity)

    def test_external_controller_reserve_does_not_raise_original_owner_budget(self):
        g=1024**3;row=supervisor.resource_verdict(27*g//2,g//2+1,0,0,20*g,20*g,20*g)
        self.assertFalse(row['passed']);self.assertEqual(supervisor.CAPS['owner_memory_bytes'],g//2)


class DockerReceiptShape(unittest.TestCase):
    def value(self):
        result={'schema':1,'kind':'aleo-linux-native-docker-probe-v1','passed':True,'source_unchanged':True,'signals':[],'native_case_acceptance':False,'SDK_or_proof_or_agent_execution':False,'spec':{'path':'spec'},'phases':[],'network_cleanup':{'owned_internal_network_removed_and_absent':True}}
        for index,name in enumerate(('postgres','leo','committed_create_lost_reply')):
            cid=str(index+1)*64;result['phases'].append({'phase':name,'controlled_fault':index==2,'passed':True,'direct_wait':{'actual_parent_wait':True,'exit_code':0},'container_cleanup':{'passed':True,'rows':[{'cid':cid,'stopped_removed_absent':True}]},'actual_NamespacePeer_Node':{'pid':123},'actual_kernel':[]if index==2 else[{'actual':True}],'committed_create':{'cid':cid,'name':'owned-controlled'}if index==2 else None})
        owner={'kind':'aleo-linux-docker-probe-delegation-v1','passed':True,'docker_probe_result':{'path':'result'},'client_actual_wait':{'actual_parent_wait':True,'exit_code':0},'cleanup':{'owned_cgroup_absent':True},'original_spec':{'path':'original'}}
        spec={'node':{'path':'node'},'kernel_receipt':{'path':'kernel'},'pins':[]};values={'result':result,'owner':owner,'spec':spec,'kernel':{'passed':True,'boot_id':'boot'}}
        return values

    def admit(self,values):
        with patch.object(specs,'load',side_effect=lambda pin:values[pin['path']]),patch.object(specs,'checked'),patch.object(specs,'Path',return_value=types.SimpleNamespace(read_text=lambda:'boot')):
            return specs.docker_admission({'path':'result'},{'path':'owner'},{'path':'node'})

    def test_unstarted_controlled_lost_reply_has_no_fabricated_kernel_start(self):
        values=self.value();self.assertEqual(self.admit(values),values['spec'])
        self.assertEqual(values['result']['phases'][2]['actual_kernel'],[])

    def test_positive_started_phases_cannot_borrow_controlled_phase(self):
        values=self.value();values['result']['phases'][0]['actual_kernel']=[]
        with self.assertRaises(ValueError):self.admit(values)
        values=self.value();values['result']['phases'][2]['committed_create']['cid']='9'*64
        with self.assertRaises(ValueError):self.admit(values)


class BootstrapPinBound(unittest.TestCase):
    def test_actual_C24_Node_fits_only_its_explicit_narrow_bound(self):
        source=(HERE/'bootstrap.mjs').read_text()
        self.assertIn('function verify(pin, maximum = 128 * 1024 ** 2)',source)
        self.assertIn('verify(policy.node, 160 * 1024 ** 2); verify(policy.diagnostic_ps);',source)
        actual_C24_Node_bytes=150319168
        self.assertGreater(actual_C24_Node_bytes,128*1024**2)
        self.assertLessEqual(actual_C24_Node_bytes,160*1024**2)
        self.assertIn('st.size === pin.bytes && st.size <= maximum',source)
        self.assertIn("fs.realpathSync(process.execPath) === policy.node.path",source)
        self.assertEqual(source.count('verify(policy.node,'),1)


class LiteralDictionaryControls(unittest.TestCase):
    def test_no_duplicate_literal_keys_can_mask_final_verdict(self):
        for path in HERE.glob('*.py'):
            for node in ast.walk(ast.parse(path.read_text())):
                if isinstance(node,ast.Dict):
                    keys=[key.value for key in node.keys if isinstance(key,ast.Constant)and type(key.value)is str]
                    self.assertEqual(len(keys),len(set(keys)),str(path)+':'+str(node.lineno))


class PublicProjection(unittest.TestCase):
    def public_fixture(self):
        evidence={'all-gates-complete':{'actualNativeProofsAccepted':True,'sameDBRestartNoExtraTransaction':True,'sourceUnchanged':True,'messageCount':4},'dispatches':[],'actual-600-retirement':{'perID':[]},'restart-observation-intervals':{'startedMonotonicMs':700000,'completedMonotonicMs':730000,'domainLastReceived':{'1':730000,'2':730000}},'native-proofs-and-receipts':{'receipts':{}},'actual-linked-sql':[],'restarted-linked-sql':[],'authenticated-checkpoints':[]}
        secret='private-raw-wire-signature-env-never-publish'
        for index in range(4):
            identifier='0x'+format(index+1,'064x')
            message={'id':identifier,'nonce':index,'origin':1 if index%2 else 2,'destination':2 if index%2 else 1,'sender':'public sender','recipient':'public recipient','dispatchTransaction':'at1public','payment':'1','gasAmount':'2','insertion':index,'wire':secret,'body':secret}
            evidence['dispatches'].append(message)
            evidence['actual-600-retirement']['perID'].append(dict(zip(public_proof.LIFECYCLE,[identifier,100,101,600101,600000,600000,600100,600101,1,100,90,101,102,600101])))
            evidence['receipt-'+identifier]={'canonical':{'transactionId':'at1public','blockHash':'ab1public','height':index+1,'executionProof':secret,'feeProof':secret},'rawSignature':secret}
            evidence['native-proofs-and-receipts']['receipts'][identifier]={'hex':identifier,'sha256':'a'*64,'bytes':123,'fee':'1','rawNative':secret}
            evidence['actual-linked-sql'].append('1|1|1|2|1|1');evidence['restarted-linked-sql'].append('1|1|1|2|1|1')
            evidence['authenticated-checkpoints'].append({'metadata':secret,'signed':[{'name':'public','index':index,'root':'b'*64,'id':identifier,'signer':'public validator','signature':secret}]})
        waits=[{'pid':i+1,'processGroup':i+1,'executable':'/public/role','spawned':True,'waitReturned':True,'code':0,'signal':None}for i in range(4)]
        evidence['parent-stopped-first']=waits;evidence['parent-stopped-restart']=copy.deepcopy(waits)
        actual={'passed':True,'errors':[],'evidence':evidence,'rawConfig':secret}
        owner={'passed':True,'source_unchanged':True,'owned_absent':True,'signals':[],'direct_waits':[]}
        spec={'runtime_source_commit':'runtime','execution_source_commit':'execution','manifest':{'path':'/private/manifest'},'sdk_receipt':{'path':'/private/sdk'},'storage_interop':{'path':'/private/storage'}}
        return actual,owner,{'path':'/private/raw'},spec,secret

    def test_public_aleo_projection_uses_own_schema_and_drops_raw_material(self):
        actual,owner,raw,spec,secret=self.public_fixture();out=public_proof.project(actual,owner,raw,spec)
        self.assertNotIn(secret,json.dumps(out));self.assertEqual(out['kind'],'public-actual-aleo-proof-v1');self.assertFalse(out['generic_Python_NativeSession_acceptance'])
        self.assertEqual(out['restart']['actual_duration_ms'],30000);self.assertEqual(len(out['per_ID_monotonic_ms']),4)

    def test_public_aleo_projection_rejects_early_retirement_and_short_restart(self):
        actual,owner,raw,spec,_=self.public_fixture();bad=copy.deepcopy(actual);bad['evidence']['actual-600-retirement']['perID'][0]['firstRetirement']=599999
        with self.assertRaises(ValueError):public_proof.project(bad,owner,raw,spec)
        bad=copy.deepcopy(actual);bad['evidence']['restart-observation-intervals']['completedMonotonicMs']=729999
        with self.assertRaises(ValueError):public_proof.project(bad,owner,raw,spec)

    def test_public_aleo_projection_cannot_hide_bad_actual_wait_or_sql(self):
        actual,owner,raw,spec,_=self.public_fixture();bad=copy.deepcopy(actual);bad['evidence']['parent-stopped-restart'][0]['code']=1
        with self.assertRaises(ValueError):public_proof.project(bad,owner,raw,spec)
        bad=copy.deepcopy(actual);bad['evidence']['restarted-linked-sql'][0]='0|1|1|2|1|1'
        with self.assertRaises(ValueError):public_proof.project(bad,owner,raw,spec)
        with self.assertRaises(ValueError):public_proof.project(actual,dict(owner,owned_absent=False),raw,spec)

    def test_public_aleo_projection_rejects_nested_scalar_leakage(self):
        actual,owner,raw,spec,secret=self.public_fixture();actual['evidence']['dispatches'][0]['sender']={'authorization':secret}
        with self.assertRaises(ValueError):public_proof.project(actual,owner,raw,spec)


class StartupDiagnostics(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup);self.root=Path(temporary.name).resolve();self.spec={'pins':[delegate.kernel_probe.pin(Path(delegate.__file__).resolve())]};self.private='PRIVATE_AUTHORIZATION_BODY_https://example.invalid/key'
    def marker(self,stage='authority'):
        return {'schema':1,'kind':'aleo-case-service-startup-failure-v1','stage':stage,'error_class':'PermissionError','errno':13,'observed_monotonic_ns':time.monotonic_ns(),'frames':[{'source':'case_delegate.py','line':1,**{k:self.spec['pins'][0][k]for k in ['bytes','sha256']}}]}
    def logs(self,value):
        (self.root/'stdout.log').write_bytes(self.private.encode());(self.root/'stderr.log').write_text(delegate.STARTUP_PREFIX+json.dumps(value)+'\n')
    def test_actual_inside_authority_exception_marker_rethrows_same_primary_without_message(self):
        import io
        primary=PermissionError(13,self.private);stream=io.StringIO()
        with patch.object(delegate,'approved',side_effect=primary),patch.object(delegate.sys,'stderr',stream):
            with self.assertRaises(PermissionError)as caught:delegate.inside({'untrusted-output':self.private})
        self.assertIs(caught.exception,primary);self.assertNotIn(self.private,stream.getvalue());self.assertTrue(stream.getvalue().startswith(delegate.STARTUP_PREFIX));value=json.loads(stream.getvalue().removeprefix(delegate.STARTUP_PREFIX));checked=delegate.checked_startup_marker(value,self.spec);self.assertEqual(checked['stage'],'authority');self.assertEqual(checked['errno'],13);self.assertTrue(any(r['source']=='case_delegate.py'for r in checked['frames']))
    def test_failed_emitter_cannot_mask_actual_inside_exception(self):
        primary=ValueError(self.private)
        with patch.object(delegate,'approved',side_effect=primary),patch.object(delegate,'emit_startup_failure',side_effect=OSError('secondary')):
            with self.assertRaises(BaseException)as caught:delegate.inside({})
        self.assertIs(caught.exception,primary)
    def test_fixed_logs_closed_marker_rehashed_no_raw_body_or_paths(self):
        self.logs(self.marker('controller-resources'));value=delegate.service_failure_diagnostics(self.root,self.spec);self.assertEqual(value['startup']['status'],'available');self.assertEqual(value['files']['stdout']['sha256'],hashlib.sha256(self.private.encode()).hexdigest());self.assertNotIn(self.private,json.dumps(value));self.assertNotIn(str(self.root),json.dumps(value));self.assertEqual(value['startup']['record']['stage'],'controller-resources')
    def test_nested_fields_false_errno_unknown_stage_source_and_wrong_hash_refuse(self):
        import shutil
        for change in ['nested','errno','stage','source','hash']:
            value=self.marker()
            if change=='nested':value['authorization']={'value':self.private}
            if change=='errno':value['errno']=True
            if change=='stage':value['stage']=self.private
            if change=='source':value['frames'][0]['source']=self.private
            if change=='hash':value['frames'][0]['sha256']='a'*64
            self.logs(value);result=delegate.service_failure_diagnostics(self.root,self.spec);self.assertEqual(result['startup']['status'],'refused',change);self.assertNotIn(self.private,json.dumps(result))
    def test_duplicate_marker_and_duplicate_JSON_key_refuse(self):
        self.logs(self.marker());path=self.root/'stderr.log';line=path.read_text();path.write_text(line+line);self.assertEqual(delegate.service_failure_diagnostics(self.root,self.spec)['startup']['status'],'refused')
        path.write_text(line.replace('"stage": "authority"','"stage": "authority", "stage": "authority"'));self.assertEqual(delegate.service_failure_diagnostics(self.root,self.spec)['startup']['status'],'refused')
    def test_unsafe_symlink_hardlink_and_sparse_oversize_never_opened(self):
        import os
        foreign=self.root/'foreign';foreign.write_text(self.private);stdout=self.root/'stdout.log';(self.root/'stderr.log').write_bytes(b'')
        original=delegate.os.open
        for kind in ['symlink','hardlink','oversized']:
            if stdout.exists()or stdout.is_symlink():stdout.unlink()
            if kind=='symlink':stdout.symlink_to(foreign)
            elif kind=='hardlink':os.link(foreign,stdout)
            else:
                with stdout.open('wb')as f:f.truncate(16*1024**2+1)
            def opened(path,*args,**kw):
                self.assertNotEqual(Path(path),stdout,'unsafe bytes opened');return original(path,*args,**kw)
            with patch.object(delegate.os,'open',side_effect=opened):result=delegate.service_failure_diagnostics(self.root,self.spec)
            self.assertEqual(result['files']['stdout']['status'],'oversized'if kind=='oversized'else'unsafe');self.assertNotIn(self.private,json.dumps(result))
    def test_changed_log_metadata_refuses_after_read(self):
        self.logs(self.marker());read=delegate.os.read;changed=False
        def altered(fd,n):
            nonlocal changed
            block=read(fd,n)
            if block and not changed:changed=True;(self.root/'stdout.log').write_bytes(b'replaced')
            return block
        with patch.object(delegate.os,'read',side_effect=altered):result=delegate.service_failure_diagnostics(self.root,self.spec)
        self.assertEqual(result['files']['stdout']['status'],'unavailable')
    def test_pre_inside_trace_is_explicitly_weaker_pinned_Source_only(self):
        (self.root/'stdout.log').write_bytes(b'');(self.root/'stderr.log').write_text('Traceback (most recent call last):\n  File "'+str(Path(delegate.__file__).resolve())+'", line 1, in <module>\nPermissionError: '+self.private+'\n')
        result=delegate.service_failure_diagnostics(self.root,self.spec);self.assertEqual(result['startup']['status'],'source-trace-only');self.assertEqual(result['startup']['record']['stage'],'unobserved');self.assertEqual(result['startup']['record']['error_class'],'PermissionError');self.assertNotIn(self.private,json.dumps(result));self.assertNotIn(str(self.root),json.dumps(result))
    def test_actual_failed_parent_caller_wait_cleanup_and_primary_survive_diagnostic_error(self):
        from types import SimpleNamespace as N
        spec={'output':str(self.root/'case'),'run_token':'a'*32,'pins':[],'tools':{},'delegation_tools':{},'case_spec':{}};records=[];waits=[]
        class Child:
            def poll(self):return 1
            def wait(self,**kw):waits.append(kw);return 1
            pid=123
        def atomic(path,value):records.append((Path(path).name,copy.deepcopy(value)))
        with patch.object(delegate,'approved',return_value=spec),patch.object(delegate,'identity',return_value='fixed-owned-unit'),patch.object(delegate.platform,'system',return_value='Linux'),patch.object(delegate.platform,'machine',return_value='x86_64'),patch.object(delegate.base,'tools',return_value={'systemd-run':'/not-executed','systemctl':'/not-executed'}),patch.object(delegate.base,'command',return_value=N(returncode=0,stdout=b'systemd 255\n')),patch.object(delegate.base,'show',return_value=None),patch.object(delegate.base,'atomic',side_effect=atomic),patch.object(delegate.controller_resources,'capture',return_value={}),patch.object(delegate,'launch_argv',return_value=['not-executed']),patch.object(delegate.subprocess,'Popen',return_value=Child()),patch.object(delegate,'cleanup',return_value={'owned_cgroup_absent':True}),patch.object(delegate,'checked'),patch.object(delegate,'service_failure_diagnostics',side_effect=OSError('secondary private '+self.private)):
            self.assertEqual(delegate.execute({}),1)
        value=next(v for name,v in records if name=='owner.json');self.assertEqual(value['error'],'ValueError:actual case service failed');self.assertEqual(value['client_wait']['exit_code'],1);self.assertTrue(value['client_wait']['actual_parent_wait']);self.assertTrue(value['cleanup']['owned_cgroup_absent']);self.assertFalse(value['passed']);self.assertEqual(len(waits),2);self.assertEqual(waits[1],{'timeout':243});self.assertEqual(value['service_failure_diagnostics']['status'],'unavailable');self.assertNotIn(self.private,json.dumps(value))

    def test_actual_inside_properties_stage_is_recorded_before_failing_owned_API(self):
        import io
        primary=TimeoutError(self.private);stream=io.StringIO()
        with patch.object(delegate,'approved',return_value={}),patch.object(delegate,'identity',return_value='owned-unit'),patch.object(delegate.base,'tools',return_value={'systemctl':'not-executed'}),patch.object(delegate.base,'show',side_effect=primary),patch.object(delegate.sys,'stderr',stream):
            with self.assertRaises(TimeoutError)as caught:delegate.inside({})
        self.assertIs(caught.exception,primary);value=json.loads(stream.getvalue().removeprefix(delegate.STARTUP_PREFIX));self.assertEqual(value['stage'],'properties');self.assertEqual(value['error_class'],'TimeoutError');self.assertNotIn(self.private,json.dumps(value))
    def test_actual_failed_parent_log_reader_and_existing_public_caller_compose(self):
        import importlib.util
        from types import SimpleNamespace as N
        case=self.root/'case';spec={'output':str(case),'run_token':'a'*32,'pins':self.spec['pins'],'tools':{},'delegation_tools':{},'case_spec':{}};records=[];marker=self.marker('properties')
        class Child:
            def poll(self):return 1
            def wait(self,**kw):return 1
            pid=123
        def atomic(path,value):records.append((Path(path),copy.deepcopy(value)))
        def popen(*args,**kw):kw['stderr'].write((delegate.STARTUP_PREFIX+json.dumps(marker)+'\n').encode());kw['stderr'].flush();return Child()
        with patch.object(delegate,'approved',return_value=spec),patch.object(delegate,'identity',return_value='fixed-owned-unit'),patch.object(delegate.platform,'system',return_value='Linux'),patch.object(delegate.platform,'machine',return_value='x86_64'),patch.object(delegate.base,'tools',return_value={'systemd-run':'/not-executed','systemctl':'/not-executed'}),patch.object(delegate.base,'command',return_value=N(returncode=0,stdout=b'systemd 255\n')),patch.object(delegate.base,'show',return_value=None),patch.object(delegate.base,'atomic',side_effect=atomic),patch.object(delegate.controller_resources,'capture',return_value={}),patch.object(delegate,'launch_argv',return_value=['not-executed']),patch.object(delegate.subprocess,'Popen',side_effect=popen),patch.object(delegate,'cleanup',return_value={'owned_cgroup_absent':True}),patch.object(delegate,'checked'):
            self.assertEqual(delegate.execute({}),1)
        path,value=next((p,v)for p,v in records if p.name=='owner.json');path.write_text(json.dumps(value));self.assertIn('service_failure_diagnostics',value);self.assertEqual(value['service_failure_diagnostics']['startup']['record']['stage'],'properties');self.assertEqual(value['error'],'ValueError:actual case service failed')
        load=importlib.util.spec_from_file_location('closed_startup_public_control',HERE/'ci_fullcase.py');ci=importlib.util.module_from_spec(load);load.loader.exec_module(ci);public=ci.case_failure_diagnostics(case,HERE.parents[2]);record=public['records']['service'];self.assertEqual(record['service_failure_diagnostics']['startup']['record']['stage'],'properties');self.assertEqual(record['error']['fixed_Source_guard']['guard'],'actual case service failed');self.assertNotIn(self.private,json.dumps(public));self.assertFalse(public['native_or_performance_credit'])

if __name__=='__main__':unittest.main()
