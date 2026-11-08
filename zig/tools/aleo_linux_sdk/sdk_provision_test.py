"""Pure/filesystem controls; no package manager/SDK/native/namespace execution."""
import copy
import ast
import json
import os
import selectors
from pathlib import Path
import sys
import tempfile
import re
from types import SimpleNamespace as N
import time
import unittest
import zipfile
from unittest import mock

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
KERNEL=HERE.parent/'aleo_linux'
sys.path.insert(0,str(KERNEL))
import sdk_provision as p
import sdk_specs as specs
import sdk_export
import receipts
import sdk_delegate
import kernel_probe
from supervisor import pin

class Tests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve()
        self.repo=self.root/'repo';self.repo.mkdir()
        system_tools=mock.patch.object(sdk_delegate.base,'tools',return_value={});system_tools.start();self.addCleanup(system_tools.stop)
        for n,data in {'package.json':json.dumps({'packageManager':p.MANAGER}),'pnpm-lock.yaml':'exact frozen fixture','pnpm-workspace.yaml':'packages: [typescript/*]','.nvmrc':'v26.12.1\n','zig/integration/aleo_process.ts':'export const fixture = true;','zig/integration/aleo_process_test.ts':'import test from "node:test";'}.items():self.put(self.repo/n,data)
        for name in ('zig/src/native_rows_interop_fixture.zig','zig/integration/native_rows_interop.py','zig/bench/native_case_tools.py','zig/bench/native_harness_census.py'):self.put(self.repo/name,'public interop Source fixture: '+name)
        for name in p.PACKAGES:
            for file,data in {'package.json':json.dumps({'name':'@hyperlane-xyz/'+name}),'tsconfig.json':'{}'}.items():self.put(self.repo/'typescript'/name/file,data)
            if name!='tsconfig':self.put(self.repo/'typescript'/name/'src/index.ts','export {};')
        self.put(self.repo/'patches/exact.patch','Source patch bytes')
        self.put(self.repo/'typescript/utils/tsconfig.build.json','{}')
        self.tools={key:pin(self.put(self.root/'tools'/key,key))for key in ('node','pnpm','python','bwrap')}
        self.resolvers={name:pin(self.put(self.root/'resolver'/Path(name).name,'public resolver fixture'))for name in ('/etc/resolv.conf','/etc/hosts','/etc/nsswitch.conf')}
    def put(self,path,data):
        path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data.encode()if isinstance(data,str)else data);return path
    def stage(self):
        expected=[pin(x)for x in p.source_paths(self.repo)];return p.stage_sources(self.repo,self.root/'stage',expected)
    def packages(self,stage=None):
        stage=stage if stage is not None else self.root/'packages';alias=stage/'node_modules/.pnpm/wrapper/node_modules/@typescript/typescript6';old=stage/'node_modules/.pnpm/old/node_modules/typescript'
        self.put(alias/'package.json',json.dumps({'name':'@typescript/typescript6','version':'6.0.2','dependencies':{'@typescript/old':'npm:typescript@^6'}}));self.put(alias/'lib/tsc.js','require("@typescript/old/lib/tsc.js");\n');self.put(old/'package.json',json.dumps({'name':'typescript','version':'6.0.3'}));self.put(old/'lib/tsc.js','locked delegated compiler')
        (alias.parent/'old').symlink_to(old,target_is_directory=True);link=stage/'typescript/utils/node_modules/typescript';link.parent.mkdir(parents=True);link.symlink_to(alias,target_is_directory=True)
        return stage,alias,old
    def package_receipt(self):
        root=self.root/'acquisition';root.mkdir();stage=root/'workspace'
        original=[pin(x)for x in p.source_paths(self.repo)];origins=p.stage_sources(self.repo,stage,original);self.packages(stage)
        sdk=stage/'node_modules/.pnpm/sdk/node_modules/@provablehq/sdk';wasm=stage/'node_modules/.pnpm/wasm/node_modules/@provablehq/wasm'
        for package,name in [(sdk,'@provablehq/sdk'),(wasm,'@provablehq/wasm')]:
            self.put(package/'package.json',json.dumps({'name':name,'version':'0.12.0'}))
            for network in ['testnet','mainnet']:self.put(package/'dist'/network/('node-polyfill.js'if package==sdk else'worker.js'),'public Worker Source fixture')
        (sdk.parent/'wasm').symlink_to(wasm,target_is_directory=True)
        link=stage/'typescript/aleo-sdk/node_modules/@provablehq/sdk';link.parent.mkdir(parents=True);link.symlink_to(sdk,target_is_directory=True)
        spec={'schema':1,'root_approved':True,'purpose':'aleo-linux-locked-packages-v1','caps':p.CAPS,'execution_source_commit':'a'*40,'output':str(root),'pins':[pin(HERE/'sdk_provision.py')],'readonly_roots':['/usr',str(self.repo)],'resolver_files':self.resolvers,**self.tools}
        outer={**self.service(),'output':str(root),'tools':self.tools,'pins':[pin(x)for x in specs.runtime_paths()],'delegation_tools':{},'kernel_spec':pin(self.put(root/'kernel-spec','{}')),'kernel_receipt':pin(self.put(root/'kernel-result','{}'))}
        outer_pin=pin(self.put(root/'outer-spec.json',json.dumps(outer)));spec['service_owner_spec']=outer_pin
        spec_path=self.put(root/'spec.json',json.dumps(spec));commands=[]
        for name,command,network,stdout in [('node_version',[self.tools['node']['path'],'--version'],False,b'v26.12.1\n'),('pnpm_version',[self.tools['pnpm']['path'],'--version'],False,b'12.3.0\n'),('locked_install',p.install_argv(Path(self.tools['pnpm']['path']),root),True,b'normal manager fixture')]:
            commands.append({'name':name,'actual_parent_wait':True,'exit_code':0,'argv':p.namespace_argv(spec,root,stage,command,network),'stdout':pin(self.put(root/(name+'.stdout'),stdout)),'stderr':pin(self.put(root/(name+'.stderr'),b''))})
        payloads,links=p.inventory(stage);sources=[x['staged']for x in origins]
        value={'original_started_ns':1,'original_deadline_ns':1+1800*10**9,'final_publication_check_ns':2,'kind':'aleo-linux-locked-packages-v1','schema':1,'platform':'linux-x86_64','passed':True,'source_commit':'a'*40,'spec':pin(spec_path),'tools':self.tools,'source_unchanged':True,'owned_absent':True,'commands':commands,'adopted_waits':[],'signals':[],'stage':str(stage),'source_origins':origins,'source_files':sources,'dependency_payloads':[x for x in payloads if x not in sources],'symlinks':links,**p.compiler(stage)}
        receipt=self.put(root/'result.json',json.dumps(value))
        owner={'kind':'aleo-linux-sdk-service-v1','schema':1,'passed':True,'unit':sdk_delegate.identity(outer),'phase':'packages','spec':outer_pin,'payload_result':pin(receipt),'client_wait':{'actual_parent_wait':True,'exit_code':0,'waits_for_systemd_client_only':True},'cleanup':{'owned_cgroup_absent':True},'cleanup_errors':[]}
        self.package_owner_pin=pin(self.put(root/'owner.json',json.dumps(owner)))
        return receipt,value
    def good(self):return {'original_started_ns':1,'original_deadline_ns':1+1800*10**9,'final_publication_check_ns':2,'source_unchanged':True,'owned_absent':True,'signals':[],'commands':[{'actual_parent_wait':True,'exit_code':0}for _ in range(3)],'adopted_waits':[]}
    def test_copies_exact_original_Source_including_driver_and_tests(self):
        origins=self.stage();self.assertTrue(origins);self.assertEqual(len(origins),len(p.source_paths(self.repo)))
        for row in origins:self.assertEqual(row['origin']['sha256'],row['staged']['sha256']);self.assertEqual(Path(row['staged']['path']).stat().st_nlink,1)
        self.assertTrue((self.root/'stage/zig/integration/aleo_process_test.ts').exists())
        for name in ('zig/src/native_rows_interop_fixture.zig','zig/integration/native_rows_interop.py','zig/bench/native_case_tools.py','zig/bench/native_harness_census.py'):
            self.assertEqual((self.root/'stage'/name).read_bytes(),(self.repo/name).read_bytes())
    def test_changed_source_pin_rejects_before_workspace_write(self):
        rows=[pin(x)for x in p.source_paths(self.repo)];self.put(self.repo/'typescript/utils/src/index.ts','changed')
        with self.assertRaisesRegex(ValueError,'membership'):p.stage_sources(self.repo,self.root/'stage',rows)
        self.assertFalse((self.root/'stage').exists())
    def test_source_symlink_rejects(self):
        leaf=self.repo/'typescript/utils/src/index.ts';leaf.unlink();leaf.symlink_to(self.repo/'package.json')
        with self.assertRaises(ValueError):p.source_paths(self.repo)
    def test_new_source_member_changes_closed_inventory(self):
        rows=[pin(x)for x in p.source_paths(self.repo)];self.put(self.repo/'typescript/utils/src/added.ts','new')
        with self.assertRaises(ValueError):p.stage_sources(self.repo,self.root/'stage',rows)
    def test_source_manager_and_node_are_exact(self):
        self.put(self.repo/'.nvmrc','v24.13.0\n')
        with self.assertRaisesRegex(ValueError,'Node'):self.stage()
        self.put(self.repo/'.nvmrc','v26.12.1\n');self.put(self.repo/'package.json',json.dumps({'packageManager':'pnpm@latest'}))
        with self.assertRaisesRegex(ValueError,'manager'):self.stage()
    def test_command_preserves_filter_lock_scripts_and_registry(self):
        argv=p.install_argv(Path('/pinned/pnpm'),Path('/owned'))
        self.assertEqual(argv[:5],['/pinned/pnpm','--filter','@hyperlane-xyz/aleo-sdk...','install','--frozen-lockfile'])
        for text in ['--ignore-scripts','--config.ignore-pnpmfile=true','--config.verify-store-integrity=true','--config.package-import-method=copy','--config.registry=https://registry.npmjs.org/','--config.fetch-retries=0']:self.assertIn(text,argv)
        self.assertFalse(any(x in argv for x in ['--no-frozen-lockfile','--force','add','update']))
    def test_environment_never_inherits_auth_proxy_or_home(self):
        with mock.patch.dict(os.environ,{'NPM_TOKEN':'private','HTTPS_PROXY':'private','NODE_OPTIONS':'--require private','HOME':'private'}):env=p.environment(Path('/owned'),Path('/node/bin/node'),Path('/pnpm/bin/pnpm'))
        self.assertNotIn('NPM_TOKEN',env);self.assertNotIn('HTTPS_PROXY',env);self.assertEqual(env['HOME'],'/owned/home');self.assertEqual(env['NODE_OPTIONS'],'--max-old-space-size=3072')
    def test_namespace_network_only_for_ordinary_acquisition(self):
        spec={**self.tools,'resolver_files':self.resolvers,'readonly_roots':['/usr',str(self.repo)]};root=self.root/'owned';stage=root/'workspace'
        for allowed in (True,False):
            argv=p.namespace_argv(spec,root,stage,[self.tools['pnpm']['path'],'--version'],allowed)
            self.assertEqual('--unshare-net'not in argv,allowed);self.assertIn('--clearenv',argv);self.assertIn('--cap-drop',argv);self.assertIn('--assert-userns-disabled',argv);self.assertEqual(argv[-3:],['--',self.tools['pnpm']['path'],'--version'])
    def test_namespace_rejects_unpinned_executable_and_root_RO_alias(self):
        spec={**self.tools,'resolver_files':self.resolvers,'readonly_roots':['/usr',str(self.repo)]}
        with self.assertRaises(ValueError):p.namespace_argv(spec,self.root/'owned',self.root/'owned/workspace',['/bin/sh','-c','private'],True)
        with self.assertRaises(ValueError):p.namespace_argv({**spec,'readonly_roots':['/']},self.root/'owned',self.root/'owned/workspace',[self.tools['pnpm']['path']],True)
    def test_live_disk_accounting_handles_pending_pnpm_links_without_following(self):
        root=self.root/'accounting';root.mkdir();self.put(root/'payload',b'x'*8192)
        before=p.allocated(root);(root/'not-yet-complete').symlink_to(root/'future-payload')
        self.assertGreaterEqual(p.allocated(root),before)
        (root/'escape').symlink_to('/etc/passwd')
        with self.assertRaisesRegex(ValueError,'escaped'):p.allocated(root)
    def test_package_links_are_closed_and_not_manually_repaired(self):
        stage,_,_=self.packages();payloads,links=p.inventory(stage);self.assertGreater(len(payloads),3);self.assertEqual(len(links),2)
        self.assertTrue(all(Path(x['resolved']).is_relative_to(stage)for x in links))
    def test_escaped_package_link_rejected(self):
        stage,_,_=self.packages();(stage/'escape').symlink_to(self.repo/'package.json')
        with self.assertRaisesRegex(ValueError,'escaped'):p.inventory(stage)
    def test_wrapper_and_delegated_versions_are_distinct_pinned(self):
        stage,alias,old=self.packages();value=p.compiler(stage)
        self.assertEqual(value['advertised_wrapper_version'],'6.0.2');self.assertEqual(value['executed_compiler_version'],'6.0.3');self.assertEqual(value['compiler_wrapper'],pin(alias/'lib/tsc.js'));self.assertEqual(value['delegated_compiler_manifest'],pin(old/'package.json'))
    def test_changed_delegated_version_and_wrapper_fail(self):
        stage,alias,old=self.packages();self.put(old/'package.json',json.dumps({'name':'typescript','version':'6.0.4'}))
        with self.assertRaisesRegex(ValueError,'delegated'):p.compiler(stage)
        self.put(old/'package.json',json.dumps({'name':'typescript','version':'6.0.3'}));self.put(alias/'lib/tsc.js','custom compiler')
        with self.assertRaisesRegex(ValueError,'wrapper'):p.compiler(stage)
    def test_driver_config_is_strict_both_original_files_no_emit(self):
        stage=Path('/owned/workspace');value=specs.driver_config(stage)
        self.assertIs(value['compilerOptions']['strict'],True);self.assertIs(value['compilerOptions']['noEmit'],True);self.assertEqual(value['files'],[str(stage/'zig/integration'/n)for n in ['aleo_process.ts','aleo_process_test.ts']])
    def test_final_receipt_cannot_pass_failed_wait_or_postcondition(self):
        self.assertTrue(p.final_pass(self.good()))
        for key,value in [('source_unchanged',False),('owned_absent',False),('signals',['kill']),('error','failure'),('commands',[]),('adopted_waits',[{'exit_code':1}])]:self.assertFalse(p.final_pass({**self.good(),key:value}))
        value=self.good();value['commands'][0]['exit_code']=True;self.assertFalse(p.final_pass(value))
    def test_metadata_inert_rejects_unapproved_before_source_work(self):
        binding=self.put(self.root/'binding.json','{}')
        with mock.patch.object(sys,'argv',['sdk_specs.py','--prepare-build','--binding',str(binding),'--binding-sha',pin(binding)['sha256'],'--output-spec',str(self.root/'must-not-exist')]),mock.patch.object(specs,'build_spec',side_effect=AssertionError('must reject first')):
            with self.assertRaisesRegex(ValueError,'Root-filled'):specs.main()
        self.assertFalse((self.root/'must-not-exist').exists())
    def test_provision_default_inert_rejects_before_platform_or_kernel(self):
        spec=self.put(self.root/'unapproved.json','{"root_approved":false}')
        with mock.patch.object(p.platform,'system',side_effect=AssertionError('must reject first')):
            with self.assertRaisesRegex(ValueError,'authorization'):p.execute(pin(spec))
    def test_actual_builder_guard_accepts_delegated_version_not_wrapper_version(self):
        tree=ast.parse((HERE/'sdk_build.py').read_text())
        guard=next(n for n in ast.walk(tree)if isinstance(n,ast.Expr)and isinstance(n.value,ast.Call)and isinstance(n.value.func,ast.Name)and n.value.func.id=='need'and any(isinstance(a,ast.Constant)and a.value=='actual locked delegated compiler version required'for a in n.value.args))
        code=compile(ast.Module(body=[guard],type_ignores=[]),'actual-sdk-version-guard','exec')
        target=self.root/'actual-version';ns={'Path':Path,'need':p.need,'version':{'stdout':{'path':str(target)}},'delegated_manifest':{'version':'6.0.3'}}
        for raw,accepted in [(b'Version 6.0.3\n',True),(b'Version 6.0.2\n',False),(b'Version 6.0.3 extra\n',False)]:
            target.write_bytes(raw)
            if accepted:exec(code,ns)
            else:
                with self.assertRaises(ValueError):exec(code,ns)
    def test_actual_package_receipt_shape_readback_and_replacement_negatives(self):
        receipt,value=self.package_receipt();self.assertEqual(p.admitted(pin(receipt),self.package_owner_pin)['executed_compiler_version'],'6.0.3')
        for mutate in ['argv','wait','version','link','payload']:
            original=copy.deepcopy(value)
            if mutate=='argv':original['commands'][2]['argv'].remove('--frozen-lockfile')
            elif mutate=='wait':original['commands'][0]['exit_code']=True
            elif mutate=='version':original['executed_compiler_version']='6.0.2'
            elif mutate=='link':original['symlinks'][0]['target']='changed'
            else:original['dependency_payloads'][0]['sha256']='0'*64
            receipt.write_text(json.dumps(original))
            owner=receipts.load(self.package_owner_pin);owner['payload_result']=pin(receipt)
            Path(self.package_owner_pin['path']).write_text(json.dumps(owner));self.package_owner_pin=pin(Path(self.package_owner_pin['path']))
            with self.subTest(mutate=mutate),self.assertRaises(ValueError):p.admitted(pin(receipt),self.package_owner_pin)
        receipt.write_text(json.dumps(value))
        owner=receipts.load(self.package_owner_pin);owner['payload_result']=pin(receipt);Path(self.package_owner_pin['path']).write_text(json.dumps(owner));self.package_owner_pin=pin(Path(self.package_owner_pin['path']))
        payload=Path(value['dependency_payloads'][0]['path']);payload.write_bytes(payload.read_bytes()+b'changed')
        with self.assertRaises(ValueError):p.admitted(pin(receipt),self.package_owner_pin)
    def test_delegation_uses_exact_SDK_family_not_kernel_only_grant(self):
        context={'unit':'ziggy-aleo-sdk-packages-'+'a'*32+'.service','invocation':'b'*32,'uid':os.getuid(),'gid':os.getgid(),'root':'/sys/fs/cgroup/system.slice/exact','root_dev':1,'root_ino':2,'manager_dev':1,'manager_ino':3,'boot_id':'actual-boot'}
        path=self.put(self.root/'context',json.dumps(context));spec={'delegation_context':pin(path),'run_token':'a'*32}
        with mock.patch.object(p,'Lease',return_value='checked-lease')as lease:
            self.assertEqual(p.delegated_lease(spec,'packages'),'checked-lease');lease.assert_called_once_with('a'*32,4*p.GIB,128,delegation=context,family='sdk-packages')
        for unit in ['ziggy-aleo-kernel-'+'a'*32+'.service','ziggy-aleo-sdk-build-'+'a'*32+'.service','foreign.service']:
            path.write_text(json.dumps({**context,'unit':unit}));spec['delegation_context']=pin(path)
            with mock.patch.object(p,'Lease',side_effect=AssertionError('no fallback')):
                with self.assertRaises(ValueError):p.delegated_lease(spec,'packages')
    def test_build_spec_refuses_bad_packages_before_any_write(self):
        with mock.patch.object(p,'admitted',side_effect=ValueError('closed package receipt failed')):
            with self.assertRaises(ValueError):specs.build_spec({},self.root/'control',self.root/'build',{}, {},'a'*32,{}, {})
        self.assertFalse((self.root/'control').exists());self.assertFalse((self.root/'build').exists())
    def test_build_spec_uses_real_worker_manifests_before_writes(self):
        value={'stage':str(self.root/'no-packages')}
        kernel_spec=pin(self.put(self.root/'spec','exact kernel spec'))
        check=pin(self.put(self.root/'pin',json.dumps({'kind':'aleo-linux-kernel-prerequisite-v1','passed':True,'spec':kernel_spec})))
        with mock.patch.object(p,'admitted',return_value=value):
            with self.assertRaises(FileNotFoundError):specs.build_spec({},self.root/'control',self.root/'build',kernel_spec,check,'a'*32,check,check)
        self.assertFalse((self.root/'control').exists())
    def test_metadata_bounds_are_explicit_without_global_limit_relaxation(self):
        data=self.put(self.root/'metadata',json.dumps({'long':'x'*100}))
        self.assertEqual(receipts.load(pin(data),200)['long'],'x'*100)
        for limit in [10,True,33*1024**2]:
            with self.assertRaises(ValueError):receipts.load(pin(data),limit)
    def test_export_is_closed_data_only_and_rechecks_bytes(self):
        source=pin(self.put(self.root/'source','actual inspected Source'));entry=pin(self.put(self.root/'index.js','export {};'))
        package=pin(self.put(self.root/'package-result.json','{}'))
        spec={'root_approved':True,'purpose':'aleo-linux-offline-sdk-build-v1','node':source,'sdk_entry_path':entry['path'],'execution_source_commit':'a'*40,'package_receipt':package,'package_owner_receipt':package,'pins':[source]}
        spec_pin=pin(self.put(self.root/'build-spec.json',json.dumps(spec)));result_pin=pin(self.put(self.root/'build-result.json','{}'))
        value={'source_files':[source],'outputs':[entry],'dependency_payloads':[],'package_receipt':package}
        with mock.patch.object(sdk_export,'sdk_receipt',return_value=value),mock.patch.object(sdk_export,'admitted',return_value={'symlinks':[]}),mock.patch.object(sdk_export,'free',return_value=7*1024**3):
            out=self.root/'inspection.zip';receipt=sdk_export.export(spec_pin,result_pin,out,package)
        self.assertFalse(receipt['usable_for_relocated_case_launch'])
        with zipfile.ZipFile(out)as archive:
            manifest=json.loads(archive.read('manifest.json'));self.assertEqual(len(archive.namelist()),receipt['member_count']);self.assertTrue(manifest['symlinks_are_data_only'])
            for row in manifest['files']:self.assertEqual(archive.read(row['member']),Path(row['original']['path']).read_bytes())
    def test_conflicting_export_pin_is_refused_before_archive_write(self):
        source=pin(self.put(self.root/'source','Source'));package=pin(self.put(self.root/'package','{}'))
        spec={'root_approved':True,'purpose':'aleo-linux-offline-sdk-build-v1','node':source,'sdk_entry_path':source['path'],'execution_source_commit':'a'*40,'package_receipt':package,'package_owner_receipt':package,'pins':[{**source,'sha256':'0'*64}]}
        spec_pin=pin(self.put(self.root/'build-spec',json.dumps(spec)));result=pin(self.put(self.root/'result','{}'))
        with mock.patch.object(sdk_export,'sdk_receipt',return_value={'source_files':[source],'outputs':[],'dependency_payloads':[],'package_receipt':package}),mock.patch.object(sdk_export,'admitted',return_value={'symlinks':[]}):
            with self.assertRaisesRegex(ValueError,'conflicting'):sdk_export.export(spec_pin,result,self.root/'never.zip',package)
        self.assertFalse((self.root/'never.zip').exists())
    def service(self,phase='packages'):
        return {'schema':1,'root_approved':True,'purpose':'aleo-linux-sdk-service-v1','phase':phase,'run_token':'a'*32}
    def service_rows(self,spec):
        unit=sdk_delegate.identity(spec)
        return {**sdk_delegate.PROPERTIES,'Id':unit,'Description':unit,'User':str(os.getuid()),'Group':str(os.getgid()),'ControlGroup':'/system.slice/'+unit,'InvocationID':'b'*32,'DelegateControllers':'memory pids','ActiveState':'active'}
    def test_two_exact_SDK_profiles_have_actual_duration_memory_and_uid_guards(self):
        for phase in ['packages','build']:
            spec=self.service(phase);rows=self.service_rows(spec)
            self.assertEqual(sdk_delegate.owned(rows,spec),'b'*32)
            for key,value in [('MemoryMax',str(384*1024**2)),('RuntimeMaxUSec','infinity'),('TimeoutStopUSec','15s'),('User','0'),('DelegateControllers','memory pids cpu'),('ControlGroup','/system.slice/foreign')]:
                with self.subTest(phase=phase,key=key),self.assertRaises(ValueError):sdk_delegate.owned({**rows,key:value},spec)
    def test_SDK_unit_replacement_and_crossed_phase_refuse(self):
        spec=self.service();rows=self.service_rows(spec)
        with self.assertRaises(ValueError):sdk_delegate.owned(rows,self.service('build'))
        with self.assertRaises(ValueError):sdk_delegate.owned(rows,spec,'c'*32)
        with self.assertRaises(ValueError):sdk_delegate.identity(self.service('native-case'))
    def test_SDK_launch_keeps_payload_unprivileged_and_caps_fixed(self):
        spec={**self.service(),'tools':self.tools};tools={'sudo':'/usr/bin/sudo','systemd-run':'/usr/bin/systemd-run','systemctl':'/usr/bin/systemctl'}
        argv=sdk_delegate.launch_argv(spec,tools,{'path':'/exact/spec','sha256':'f'*64})
        self.assertEqual(argv[:3],['/usr/bin/sudo','-n','/usr/bin/systemd-run']);self.assertIn('--uid='+str(os.getuid()),argv);self.assertIn('--property=MemoryMax='+str(9*p.GIB//2),argv);self.assertIn('--property=RuntimeMaxSec=1950',argv);self.assertIn('--property=DelegateSubgroup=manager',argv)
        self.assertNotIn('bash',argv);self.assertIn('--inside',argv)
    def test_SDK_controller_admission_is_exact_closed_runtime_Source(self):
        spec={**self.service(),'tools':self.tools,'pins':[pin(x)for x in specs.runtime_paths()],'delegation_tools':{},'kernel_spec':pin(self.put(self.root/'kernel-spec','{}')),'kernel_receipt':pin(self.put(self.root/'kernel-receipt','{}'))}
        path=self.put(self.root/'service-spec',json.dumps(spec))
        with mock.patch.object(sdk_delegate.base,'tools',return_value={}):self.assertEqual(sdk_delegate.approved(pin(path))['phase'],'packages')
        for mutation in ['missing','changed','injected']:
            value=copy.deepcopy(spec)
            if mutation=='missing':value['pins'].pop()
            elif mutation=='changed':value['pins'][0]['sha256']='0'*64
            else:value['delegation_context']={'unit':'caller-made'}
            path.write_text(json.dumps(value))
            with mock.patch.object(sdk_delegate.base,'tools',return_value={}):
                with self.assertRaises(ValueError):sdk_delegate.approved(pin(path))
    def test_delegated_parent_sdk_family_is_explicit_default_kernel_stays_strict(self):
        token='a'*32;unit='ziggy-aleo-sdk-packages-'+token+'.service';fsroot=self.root/'cgroup';root=fsroot/'system.slice'/unit;manager=root/'manager';manager.mkdir(parents=True)
        self.put(root/'cgroup.procs','');self.put(manager/'cgroup.procs',str(os.getpid()));self.put(root/'cgroup.subtree_control','memory pids')
        context={'unit':unit,'invocation':'b'*32,'uid':os.getuid(),'gid':os.getgid(),'root':str(root),'root_dev':root.stat().st_dev,'root_ino':root.stat().st_ino,'manager_dev':manager.stat().st_dev,'manager_ino':manager.stat().st_ino,'boot_id':'test-boot'}
        read=Path.read_text
        def public_proc(path,*a,**kw):
            if str(path)=='/proc/self/cgroup':return '0::/system.slice/'+unit+'/manager\n'
            if str(path)=='/proc/sys/kernel/random/boot_id':return 'test-boot'
            return read(path,*a,**kw)
        with mock.patch.object(Path,'read_text',public_proc):
            self.assertEqual(kernel_probe.delegated_parent(context,token,fsroot,family='sdk-packages'),root)
            with self.assertRaises(ValueError):kernel_probe.delegated_parent(context,token,fsroot)
            with self.assertRaises(ValueError):kernel_probe.delegated_parent(context,token,fsroot,family='sdk-build')
            with self.assertRaises(ValueError):kernel_probe.delegated_parent({**context,'manager_ino':context['manager_ino']+1},token,fsroot,family='sdk-packages')
    def test_failed_attach_bootstrap_is_pidfd_killed_waited_and_not_accepted(self):
        function=next(n for n in ast.parse((HERE/'sdk_provision.py').read_text()).body if isinstance(n,ast.FunctionDef)and n.name=='execute')
        final=next(n.finalbody for n in function.body if isinstance(n,ast.Try)and n.finalbody)
        child=mock.Mock(pid=100);child.poll.return_value=None;child.wait.return_value=-9
        lease=mock.Mock();lease.populated.return_value=False
        value={'error':'original-attach-failure','signals':[],'commands':[],'source_unchanged':False,'owned_absent':False}
        ns={'lease':lease,'child':child,'pidfd':42,'waits':[],'value':value,'reap_terminal':mock.Mock(),'need':p.need,'signal':p.signal,'os':p.os,'time':time,'spec':{'source_files':[],'pins':[]},'checked':mock.Mock(),'source_copies':mock.Mock(),'final_pass':p.final_pass,'write':mock.Mock(),'root':self.root,'cleanup_owned':p.cleanup_owned,'stage_deadline':p.stage_deadline}
        with mock.patch.object(p.signal,'pidfd_send_signal',create=True)as kill,mock.patch.object(p.os,'close')as close,mock.patch.object(p,'reap_terminal'),mock.patch.object(p,'leaf_caps',return_value={}):
            exec(compile(ast.Module(body=final,type_ignores=[]),'actual-provision-finally','exec'),ns)
        kill.assert_called_once_with(42,p.signal.SIGKILL);close.assert_called_once_with(42);child.wait.assert_called_once_with(timeout=10)
        self.assertFalse(value['passed']);self.assertEqual(value['error'],'original-attach-failure');self.assertEqual(value['last_actual_parent_wait']['exit_code'],-9);ns['write'].assert_called_once()
    def test_SDK_cleanup_requires_positive_invocation_and_never_stops_foreign(self):
        spec=self.service();rows=self.service_rows(spec);tools={'sudo':'/usr/bin/sudo','systemctl':'/usr/bin/systemctl'}
        with mock.patch.object(sdk_delegate.base,'show',return_value=rows),mock.patch.object(sdk_delegate.base,'command')as command,mock.patch.object(Path,'exists',return_value=False):
            for context in [None,{'invocation':'c'*32}]:
                with self.assertRaises(ValueError):sdk_delegate.cleanup(spec,tools,context)
            command.assert_not_called()
        with mock.patch.object(sdk_delegate.base,'show',return_value={**rows,'User':'0'}),mock.patch.object(sdk_delegate.base,'command')as command,mock.patch.object(Path,'exists',return_value=False):
            with self.assertRaises(ValueError):sdk_delegate.cleanup(spec,tools,{'invocation':'b'*32})
            command.assert_not_called()
    def test_SDK_cleanup_stops_only_exact_admitted_unit_and_no_daemon_wait_credit(self):
        spec=self.service();rows=self.service_rows(spec);tools={'sudo':'/usr/bin/sudo','systemctl':'/usr/bin/systemctl'}
        with mock.patch.object(sdk_delegate.base,'show',return_value=rows),mock.patch.object(sdk_delegate.base,'command',return_value=type('Exit',(),{'returncode':0})())as command,mock.patch.object(Path,'exists',return_value=False):
            result=sdk_delegate.cleanup(spec,tools,{'invocation':'b'*32})
        command.assert_called_once_with(['/usr/bin/sudo','-n','/usr/bin/systemctl','stop',sdk_delegate.identity(spec)],timeout=22)
        self.assertTrue(result['owned_cgroup_absent']);self.assertTrue(result['systemd_stop_is_not_parent_wait'])
    def test_complete_build_spec_real_metadata_shape_no_execution(self):
        receipt,value=self.package_receipt();kernel_spec=pin(self.put(self.root/'kernel-spec-realshape','{}'))
        kernel=pin(self.put(self.root/'kernel-actual-realshape',json.dumps({'kind':'aleo-linux-kernel-prerequisite-v1','passed':True,'spec':kernel_spec})));context=pin(self.put(self.root/'context-realshape','{}'))
        built=specs.build_spec(pin(receipt),self.root/'config',self.root/'build',kernel_spec,kernel,'d'*32,context,self.package_owner_pin)
        self.assertIs(built['root_approved'],False);self.assertFalse(built['network_acquisition_allowed']);self.assertFalse(built['lifecycle_scripts_allowed']);self.assertEqual(len(built['configs']),3);self.assertEqual(built['executed_compiler_version'],'6.0.3');self.assertEqual(len(built['SDK_polyfills']),2);self.assertEqual(len(built['WASM_workers']),2);self.assertEqual(built['package_owner_receipt'],self.package_owner_pin)
        config=receipts.load(built['driver_config']);self.assertTrue(config['compilerOptions']['noEmit']);self.assertEqual(set(config['files']),{built['driver']['path'],built['driver_test']['path']})
        self.assertTrue(all(Path(path).is_dir()and not any(Path(path).iterdir())for path in built['output_directories']))
        self.assertEqual(p.admitted(pin(receipt),self.package_owner_pin)['stage'],value['stage'])
    def test_actual_outer_service_wait_and_cleanup_are_required_for_package_reuse(self):
        receipt,value=self.package_receipt();original=receipts.load(self.package_owner_pin);owner_path=Path(self.package_owner_pin['path'])
        for key,new in [('passed',False),('unit','foreign.service'),('payload_result',{}),('cleanup',{'owned_cgroup_absent':False}),('client_wait',{'actual_parent_wait':True,'exit_code':True,'waits_for_systemd_client_only':True}),('error','failure')]:
            owner_path.write_text(json.dumps({**original,key:new}));bad=pin(owner_path)
            with self.subTest(key=key),self.assertRaises(ValueError):p.admitted(pin(receipt),bad)
    def test_actual_sdk_signal_handler_escapes_SelectSelector_and_stops_followthrough(self):
        main=next(n for n in ast.parse((HERE/'sdk_delegate.py').read_text()).body if isinstance(n,ast.FunctionDef)and n.name=='main')
        handler=next(n for n in main.body if isinstance(n,ast.FunctionDef)and n.name=='interrupt')
        ns={'TaskInterrupted':sdk_delegate.TaskInterrupted};exec(compile(ast.Module(body=[handler],type_ignores=[]),'actual-sdk-cancel-handler','exec'),ns)
        reached=[]
        with selectors.SelectSelector()as selected,mock.patch.object(selectors.SelectSelector,'_select',side_effect=lambda *args:ns['interrupt'](15,None)):
            with self.assertRaises(sdk_delegate.TaskInterrupted):
                selected.select(timeout=0);reached.append('must-not-provision')
        self.assertEqual(reached,[]);self.assertFalse(issubclass(sdk_delegate.TaskInterrupted,InterruptedError))
    def test_sdk_cancel_is_primary_and_never_starts_service_after_select_failure(self):
        output=self.root/'cancelled';spec={**self.service(),'output':str(output),'pins':[],'tools':{},'delegation_tools':{}}
        exact=pin(self.put(self.root/'cancel-spec',json.dumps(spec)))
        tools={'systemd-run':'/usr/bin/systemd-run','systemctl':'/usr/bin/systemctl','sudo':'/usr/bin/sudo'}
        version=type('Version',(),{'stdout':b'systemd 255.4\n','returncode':0})()
        with mock.patch.object(sdk_delegate,'approved',return_value=spec),mock.patch.object(sdk_delegate.platform,'system',return_value='Linux'),mock.patch.object(sdk_delegate.platform,'machine',return_value='x86_64'),mock.patch.object(sdk_delegate.base,'tools',return_value=tools),mock.patch.object(sdk_delegate.base,'command',return_value=version),mock.patch.object(sdk_delegate.base,'show',side_effect=sdk_delegate.TaskInterrupted('cancelled')):
            self.assertEqual(sdk_delegate.execute(exact),1)
        record=receipts.load(pin(output.with_suffix('.owner')/'owner.json'))
        self.assertFalse(record['passed']);self.assertTrue(record['error'].startswith('TaskInterrupted:'));self.assertIsNone(record['client_wait']);self.assertFalse(output.exists())
    def test_cleanup_reap_or_inspection_error_cannot_skip_direct_wait_or_fd_close(self):
        child=mock.Mock(pid=123);child.poll.return_value=0;child.wait.return_value=0
        lease=mock.Mock();lease.populated.side_effect=[ValueError('inspection failed'),False]
        with mock.patch.object(p,'reap_terminal',side_effect=ValueError('adoption failed')),mock.patch.object(p,'leaf_caps',return_value={}),mock.patch.object(p.os,'close')as close,mock.patch.object(p.signal,'pidfd_send_signal',create=True)as kill:
            result=p.cleanup_owned(lease,child,42,[],[])
        child.wait.assert_called_once_with(timeout=10);close.assert_called_once_with(42);kill.assert_not_called();lease.remove.assert_called_once()
        self.assertEqual(result['last_actual_parent_wait']['exit_code'],0);self.assertFalse(result['owned_absent']);self.assertEqual({row['stage']for row in result['cleanup_errors']},{'leaf-kill','adopted-waits'})
    def test_actual_service_projection_is_closed_and_leaf_cap_readback_is_literal(self):
        lease=mock.Mock(path=Path('/owned/leaf'),identity=(1,2),line='0::/owned/leaf\n');lease.read.side_effect=lambda name:{'memory.max':str(4*p.GIB),'memory.swap.max':'0','pids.max':'128'}[name]
        row=p.leaf_caps(lease);self.assertEqual(row['memory_max_bytes'],4*p.GIB);self.assertEqual(row['pids_max'],128);self.assertEqual(row['inode'],2)
        lease.read.side_effect=lambda name:{'memory.max':str(4*p.GIB),'memory.swap.max':'max','pids.max':'128'}[name]
        with self.assertRaises(ValueError):p.leaf_caps(lease)
        self.assertNotIn('Environment',sdk_delegate.base.QUERY);self.assertNotIn('ExecStart',sdk_delegate.base.QUERY)
    def routes(self):
        source=ast.parse((KERNEL/'kernel_only_test.py').read_text());functions=[n for n in source.body if isinstance(n,ast.FunctionDef)and n.name in {'conditions','selected'}]
        ns={'re':re,'N':N};exec(compile(ast.Module(body=functions,type_ignores=[]),'actual-route-evaluator','exec'),ns)
        text=(HERE.parents[2]/'.github/workflows/zig-agents.yml').read_text()
        return text,ns['conditions'](text),ns['selected'],ns['conditions']
    def test_actual_sdk_route_isolated_and_both_kernel_requests_fail_closed(self):
        text,rows,selected,_=self.routes();self.assertEqual(len(rows),15)
        for suffix in ['', ' [zig-native-case]', ' [zig-svm-prerequisites-only]', ' [zig-native-http-diagnostic]']:
            self.assertEqual(selected(rows,message='[zig-aleo-sdk-only]'+suffix),{'aleo-linux-sdk-prerequisite'})
        for suffix in ['', ' [zig-native-case] [zig-svm-prerequisites-only]']:
            self.assertEqual(selected(rows,message='[zig-aleo-sdk-only] [zig-aleo-kernel-only]'+suffix),set())
        self.assertIn('default: false',text.split('aleo_linux_sdk_prerequisite:',1)[1].split('aleo_linux_prerequisite:',1)[0])
    def test_actual_Docker_request_conflicts_fail_closed_with_SDK(self):
        _,rows,selected,_=self.routes()
        self.assertEqual(selected(rows,message='[zig-aleo-sdk-only] [zig-aleo-docker-only]'),set())
        self.assertEqual(selected(rows,event='workflow_dispatch',sdk=True,docker=True),set())
    def test_actual_sdk_dispatch_beats_old_inputs_but_not_kernel_conflict(self):
        _,rows,selected,_=self.routes()
        for svm in (False,True):
            for cold in (False,True):
                self.assertEqual(selected(rows,event='workflow_dispatch',sdk=True,svm=svm,cold=cold),{'aleo-linux-sdk-prerequisite'})
                self.assertEqual(selected(rows,event='workflow_dispatch',sdk=True,aleo=True,svm=svm,cold=cold),set())
    def test_actual_sdk_route_has_no_effect_on_unselected_events(self):
        _,rows,selected,_=self.routes()
        for event,ref,message in [('push','refs/heads/feat/zig-agent-rewrite','ordinary'),('pull_request','refs/heads/feat/zig-agent-rewrite','[zig-aleo-sdk-only]'),('push','refs/heads/main','[zig-aleo-sdk-only]'),('workflow_dispatch','refs/heads/feat/zig-agent-rewrite','')]:
            self.assertNotIn('aleo-linux-sdk-prerequisite',selected(rows,event=event,ref=ref,message=message))
        self.assertEqual(selected(rows,message='[zig-aleo-kernel-only]'),{'aleo-linux-prerequisite'})
        self.assertEqual(selected(rows,message='[zig-native-case]'),{'native-case-producer-inputs'})
        self.assertEqual(selected(rows,message='[zig-svm-prerequisites-only]'),{'svm-prerequisites'})
    def test_postprocessing_cannot_borrow_time_after_original1800s(self):
        good=self.good();self.assertTrue(p.final_pass(good))
        self.assertFalse(p.final_pass({**good,'final_publication_check_ns':good['original_deadline_ns']+1}))
        for change in [{'original_started_ns':True},{'original_deadline_ns':good['original_deadline_ns']+1},{'final_publication_check_ns':0}]:self.assertFalse(p.final_pass({**good,**change}))
        # Execute the actual builder's final verdict expression with otherwise
        # successful commands/source/waits: late inventory must invalidate it.
        tree=ast.parse((HERE/'sdk_build.py').read_text());run=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='run')
        final=next(n.finalbody for n in run.body if isinstance(n,ast.Try)and n.finalbody)
        assignment=next(n for n in final if isinstance(n,ast.Assign)and any(isinstance(t,ast.Subscript)and isinstance(t.slice,ast.Constant)and t.slice.value=='passed'for t in n.targets))
        result={**good,'passed':True,'checks':[{'actual_parent_wait':True,'exit_code':0}for _ in range(5)],'final_publication_check_ns':good['original_deadline_ns']+1}
        exec(compile(ast.Module(body=[assignment],type_ignores=[]),'actual-builder-final-deadline','exec'),{'result':result,'stage_deadline':p.stage_deadline,'signals':[],'waits':[]})
        self.assertFalse(result['passed'])

if __name__=='__main__':
    with mock.patch('subprocess.Popen',side_effect=AssertionError('no actual package/compiler/SDK process')):unittest.main()
