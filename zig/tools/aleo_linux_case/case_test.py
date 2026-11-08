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


class MetadataShape(unittest.TestCase):
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

if __name__=='__main__':unittest.main()
