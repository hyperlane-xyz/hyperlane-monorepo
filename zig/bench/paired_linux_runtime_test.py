"""Pure runtime boundary/bindings; no original benchmark main or real child/SDK."""
from pathlib import Path
import contextlib
import copy
import importlib.util
import ast
import io
import json
import os
import shutil
import sys
import tempfile
import types
import unittest
from unittest import mock

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('runtime_tested',HERE/'paired_linux_runtime.py');api=importlib.util.module_from_spec(spec);spec.loader.exec_module(api)
def audit(name,args):
    if name in {'socket.__new__','subprocess.Popen','os.system','os.fork','os.posix_spawn','ctypes.dlopen'}:raise AssertionError('Unexpected external effect: '+name)
sys.addaudithook(audit)

class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='paired-runtime-pure-');self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name).resolve();self.repo=self.root/'repo';self.repo.mkdir();self.inputs=self.root/'inputs';self.inputs.mkdir();self.counter=0
    def file(self,path,wire=b'public-test-fixture'):
        path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(wire);return api.pin(path)
    def relative(self,name,wire=None):
        row=self.file(self.inputs/name,(name.encode()if wire is None else wire));row['path']=name;return row
    def context(self,index=0):
        role,mode,scenario=api.METHOD_ROWS[index];methods=json.loads((HERE/'paired_linux_methods.json').read_text());art={'rust':{},'zig':{},'tools':{}}
        for r in ['validator','scraper','relayer']:art['rust'][r]=self.relative('rust/'+r)
        for m in api.MODES:
            art['zig'][m]={r:self.relative('zig/'+m+'/'+r)for r in ['validator','scraper','relayer',*api.ENV_KEYS]}
        for name in ['init-db','ziggy-rocks-oracle','ziggy-native-rows','ziggy-rust-reference']:art['tools'][name]=self.relative('tools/'+name)
        art['evm_oracle']=self.relative('oracle');art['tool_manifest']=self.relative('tools/manifest.json',b'{}')
        libs={'libcurl.so.4':self.file(self.root/'libcurl.so.4')};build=self.relative('build-receipt.json',b'{}')
        proofs={m:{name:self.file(self.root/(m+'-'+name+'.json'),b'{}')for name in ['relayer_process','relayer_stream','public_relay_process']}for m in api.MODES}
        return {'method':methods['sequence'][index],'inputs_root':self.inputs,'manifest':{'artifacts':art,'producer_source_commit':'b'*40,'baseline_profile':'actual-profile-fixture','external':{'runtime_libraries':libs},'build_receipt':build,'files':[]},'reuse':{'proofs':proofs},'authority':{'execution_source_commit':'a'*40,'producer_source_commit':'b'*40},'authority_pin':{'path':'/not-executed/authority','bytes':1,'sha256':'cd'*32},'reuse_pin':{'path':'/not-executed/reuse','bytes':1,'sha256':'ef'*32},'source':{}}

class AuthorityControls(Fixture):
    def test_false_authority_has_no_platform_source_import_tool_or_output(self):
        path=self.root/'authority.json';row=self.file(path,json.dumps({'schema':1,'kind':'paired-linux-runtime-authority-v1','root_approved':False}).encode())
        with mock.patch.object(api,'current_head',side_effect=AssertionError('Git')),mock.patch.object(api,'original_modules',side_effect=AssertionError('import')):
            self.assertIsNone(api.admit(path,row['sha256'],self.root/'nonexistent','ignored',self.repo,0))
        self.assertEqual(sorted(p.name for p in self.root.iterdir()),['authority.json','inputs','repo'])
    def test_nonliteral_approval_or_unknown_index_refuses_before_import(self):
        path=self.root/'authority.json';row=self.file(path,json.dumps({'schema':1,'kind':'paired-linux-runtime-authority-v1','root_approved':1}).encode())
        with self.assertRaises(api.Refused):api.admit(path,row['sha256'],None,None,self.repo,0)
        with self.assertRaises(api.Refused):api.admit(path,row['sha256'],None,None,self.repo,10)
    def enabled_record(self):
        context=self.context();manifest=context['manifest'];manifest.update(kind='paired-linux-inputs-v1',platform='linux-x86_64',passed=True,source_unchanged=True,all_actual_parent_waits=True,owned_absent=True)
        manifest['external'].update(tools={},libraries={})
        manifest['files']=[{**api.pin(path),'path':str(path.relative_to(self.inputs))}for path in sorted(self.inputs.rglob('*'))if path.is_file()]
        manifest_pin=self.file(self.inputs/'input-manifest.json',json.dumps(manifest).encode());accepted=self.file(self.root/'accepted-six.json',b'{}')
        joined={**context['reuse'],'enabled':True,'inputs_root':str(self.inputs),'input_manifest':manifest_pin,'accepted_six':accepted};reuse=self.root/'reuse-context.json';reuse_pin=self.file(reuse,json.dumps(joined).encode())
        source=[]
        for name in sorted(api.SOURCE_REQUIRED):
            wire=(HERE/'paired_linux_runtime.py').read_bytes()if name=='zig/bench/paired_linux_runtime.py'else b'# Source fixture, not executed\n'
            row=self.file(self.repo/name,wire);row['path']=name;source.append(row)
        methods=self.file(self.root/'methods.json',(HERE/'paired_linux_methods.json').read_bytes());gate={'artifact':accepted,'Root_passed':True}
        authority={'schema':1,'kind':'paired-linux-runtime-authority-v1','root_approved':True,'execution_source_commit':'a'*40,'producer_source_commit':'b'*40,'methods':methods,'required_source':source,'accepted_six':gate,'final_native18':gate,'quiet':gate};path=self.root/'authority.json';pinned=self.file(path,json.dumps(authority).encode())
        return path,pinned,reuse,reuse_pin,authority

    def test_actual_enabled_admit_keeps_authority_pin_and_published_manifest_identity(self):
        path,row,reuse,reuse_pin,authority=self.enabled_record()
        with mock.patch.object(api.sys,'platform','linux'),mock.patch.object(api.os,'uname',return_value=types.SimpleNamespace(machine='x86_64')),mock.patch.object(api,'current_head',return_value='a'*40):context=api.admit(path,row['sha256'],reuse,reuse_pin['sha256'],self.repo,0)
        self.assertEqual(context['authority_pin'],row);self.assertEqual(context['manifest_pin']['path'],str(self.inputs/'input-manifest.json'));self.assertEqual(context['reuse']['enabled'],True)

    def test_wrong_HEAD_or_changed_original_method_refuses_before_main(self):
        path,row,reuse,reuse_pin,authority=self.enabled_record()
        with mock.patch.object(api.sys,'platform','linux'),mock.patch.object(api.os,'uname',return_value=types.SimpleNamespace(machine='x86_64')),mock.patch.object(api,'current_head',return_value='c'*40),self.assertRaises(api.Refused):api.admit(path,row['sha256'],reuse,reuse_pin['sha256'],self.repo,0)
        methods=api.read(authority['methods']['path']);methods['sequence'][0]['argv'].extend(['--deadline','999']);method_pin=self.file(Path(authority['methods']['path']),json.dumps(methods).encode());authority['methods']=method_pin;row=self.file(path,json.dumps(authority).encode())
        with mock.patch.object(api.sys,'platform','linux'),mock.patch.object(api.os,'uname',return_value=types.SimpleNamespace(machine='x86_64')),mock.patch.object(api,'current_head',return_value='a'*40),self.assertRaisesRegex(api.Refused,'immutable method'):api.admit(path,row['sha256'],reuse,reuse_pin['sha256'],self.repo,0)

    def test_gate_needs_actual_pinned_bytes_and_explicit_Root_verdict(self):
        row=self.file(self.root/'gate.json',b'{}');self.assertEqual(api.gate({'artifact':row,'Root_passed':True}),row)
        for value in [False,1,None]:
            with self.assertRaises(api.Refused):api.gate({'artifact':row,'Root_passed':value})
        Path(row['path']).write_text('changed')
        with self.assertRaises(api.Refused):api.gate({'artifact':row,'Root_passed':True})

class CapturedMetadata(Fixture):
    enabled_record=AuthorityControls.enabled_record
    # Inherit the actual active-admission fixture; only new tests are selected
    # below to avoid duplicating the base controls.
    def test_authority_pin_then_reread_race_cannot_change_false_gate(self):
        path=self.root/'authority.json';row=self.file(path,json.dumps({'schema':1,'kind':'paired-linux-runtime-authority-v1','root_approved':False}).encode());original=api.pin
        def raced(target):
            result=original(target)
            if Path(target)==path:path.write_text(json.dumps({'schema':1,'kind':'paired-linux-runtime-authority-v1','root_approved':True}))
            return result
        with mock.patch.object(api,'pin',side_effect=raced),mock.patch.object(api,'current_head',side_effect=AssertionError('raced authority reached Git')):
            self.assertIsNone(api.admit(path,row['sha256'],None,None,self.repo,0))
        self.assertFalse(api.read(path)['root_approved'])
    def test_reuse_pin_then_reread_race_cannot_select_foreign_root(self):
        path,row,reuse,reuse_pin,authority=self.enabled_record();original=api.pin
        def raced(target):
            result=original(target)
            if Path(target)==reuse:reuse.write_text(json.dumps({'enabled':False,'inputs_root':'/foreign'}))
            return result
        with mock.patch.object(api,'pin',side_effect=raced),mock.patch.object(api.sys,'platform','linux'),mock.patch.object(api.os,'uname',return_value=types.SimpleNamespace(machine='x86_64')),mock.patch.object(api,'current_head',return_value='a'*40):context=api.admit(path,row['sha256'],reuse,reuse_pin['sha256'],self.repo,0)
        self.assertEqual(context['inputs_root'],self.inputs);self.assertEqual(context['reuse_pin'],reuse_pin)
    def test_captured_metadata_digest_duplicate_and_size_refuse(self):
        path=self.root/'metadata.json';row=self.file(path,b'{"original":true}')
        self.assertEqual(api.captured_metadata(path,row['sha256']),(row,{'original':True}))
        path.write_bytes(b'{"changed":false}')
        with self.assertRaises(api.Refused):api.captured_metadata(path,row['sha256'])
        row=self.file(path,b'{"x":1,"x":2}')
        with self.assertRaisesRegex(api.Refused,'Duplicate'):api.captured_metadata(path,row['sha256'])
        with path.open('wb')as f:f.truncate(16*1024**2+1)
        with mock.patch.object(Path,'open',side_effect=AssertionError('oversized metadata read')),self.assertRaisesRegex(api.Refused,'size bound'):api.captured_metadata(path,'unused')

class MethodControls(Fixture):
    def test_method_authority_matches_actual_committed_recipe_bytes(self):
        self.assertEqual(api.sha((HERE/'paired_linux_methods.json').read_bytes()),api.METHODS_SHA)
    def test_all_ten_original_methods_keep_workload_flags_and_five_pairs(self):
        for index,(role,mode,scenario)in enumerate(api.METHOD_ROWS):
            context=self.context(index);original=context['method']['argv'];args=api.argv_for(context,self.root,self.root/'raw',self.root/'baseline.json')
            self.assertEqual(args[args.index('--samples')+1],'5');self.assertEqual(args[args.index('--catchup')+1],'100'if role=='scraper'else'32')
            if role=='validator':self.assertEqual(args[args.index('--consensus')+1],scenario);self.assertIn('--message-reference',args);self.assertIn('--evm-oracle',args)
            if role=='scraper':self.assertNotIn('--zig-toolchain',args);self.assertEqual(args[args.index('--fresh-interval-ms')+1],'250');self.assertEqual(args[args.index('--deadline')+1],'120')
            if role=='relayer':self.assertEqual(args[0:2],['paired','--execute']);self.assertEqual(args[args.index('--max-batch-size')+1],'4'if index>=8 else'1');self.assertIn('--tool-manifest',args)
            self.assertEqual(context['method']['pair_orders'],[['rust','zig'],['zig','rust'],['rust','zig'],['zig','rust'],['rust','zig']])
            self.assertNotIn('@',','.join(args));self.assertNotIn('/tmp/ziggy-toolchain',','.join(args))
    def test_unknown_placeholder_never_becomes_command(self):
        context=self.context();context['method']['argv'].append('@foreign')
        with self.assertRaises(api.Refused):api.argv_for(context,self.root,self.root/'raw',self.root/'baseline')

class NativePsql16RuntimeControls(Fixture):
    enabled_record=AuthorityControls.enabled_record
    def native_fixture(self):
        import struct
        path,row,reuse,reuse_pin,authority=self.enabled_record();wire=bytearray(1024);wire[:8]=b'\x7fELF\x02\x01\x01\x00';struct.pack_into('<HHIQQ',wire,16,3,62,1,0x400100,64);struct.pack_into('<HHH',wire,52,64,56,2);struct.pack_into('<IIQQQQQQ',wire,64,1,5,0,0x400000,0,len(wire),len(wire),4096);loader=b'/lib64/ld-linux-x86-64.so.2\0';struct.pack_into('<IIQQQQQQ',wire,120,3,4,512,0,0,len(loader),len(loader),1);wire[512:512+len(loader)]=loader
        native=self.root/'usr/lib/postgresql/16/bin/psql';native_pin=self.file(native,wire);native.chmod(0o755);wrapper=self.root/'usr/share/postgresql-common/pg_wrapper';self.file(wrapper,b'#!/usr/bin/perl\n# public fixture, never executed\n');bare=self.root/'usr/bin/psql';bare.parent.mkdir(parents=True);bare.symlink_to(wrapper);cast=self.root/'cast';cast_pin=self.file(cast,b'public cast fixture, never executed')
        joined=api.read(reuse);manifest=api.read(joined['input_manifest']['path']);manifest['external']['tools']={'psql':native_pin,'cast':cast_pin,'python3':api.pin(Path(sys.executable).resolve(strict=True))};joined['input_manifest']=self.file(self.inputs/'input-manifest.json',json.dumps(manifest).encode());reuse_pin=self.file(reuse,json.dumps(joined).encode());return path,row,reuse,reuse_pin,native,cast,bare
    def admit_native_fixture(self,fixture,cast_override=None):
        path,row,reuse,reuse_pin,native,cast,bare=fixture;lookups=[]
        def which(name):lookups.append(name);return str(bare if name=='psql'else cast_override or cast)
        def actual_path(value):return native if str(value)=='/usr/lib/postgresql/16/bin/psql'else Path(value)
        with mock.patch.object(api,'Path',side_effect=actual_path),mock.patch.object(api.shutil,'which',side_effect=which),mock.patch.object(api.sys,'platform','linux'),mock.patch.object(api.os,'uname',return_value=types.SimpleNamespace(machine='x86_64')),mock.patch.object(api,'current_head',return_value='a'*40):context=api.admit(path,row['sha256'],reuse,reuse_pin['sha256'],self.repo,0)
        return context,lookups
    def test_actual_admit_uses_fixed_native16_while_PATH_wrapper_is_different(self):
        fixture=self.native_fixture()
        try:context,lookups=self.admit_native_fixture(fixture)
        except (api.Refused,FileNotFoundError)as error:self.fail('Actual native16 consumer admission refused: '+type(error).__name__)
        self.assertEqual(context['manifest']['external']['tools']['psql'],api.pin(fixture[4]));self.assertEqual(lookups,['cast']);self.assertNotEqual(api.pin(fixture[6].resolve(strict=True)),api.pin(fixture[4]))
    def test_missing_or_changed_native16_refuses_without_wrapper_fallback(self):
        fixture=self.native_fixture();native=fixture[4];original=native.read_bytes();native.unlink()
        with self.assertRaises(FileNotFoundError):self.admit_native_fixture(fixture)
        native.write_bytes(b'#!/usr/bin/perl\n# changed native-path content, never executed\n')
        with self.assertRaisesRegex(api.Refused,'Runtime system tool differs from admitted input: psql'):self.admit_native_fixture(fixture)
        native.write_bytes(original);self.assertEqual(self.admit_native_fixture(fixture)[1],['cast'])
    def test_foreign_native_major_symlink_does_not_borrow_original_native16_pin(self):
        fixture=self.native_fixture();native=fixture[4];foreign=self.root/'usr/lib/postgresql/17/bin/psql';self.file(foreign,native.read_bytes());native.unlink();native.symlink_to(foreign)
        with self.assertRaisesRegex(api.Refused,'Runtime system tool differs from admitted input: psql'):self.admit_native_fixture(fixture)
    def test_producer_and_consumer_fixed_native16_paths_agree(self):
        producer=ast.parse((HERE/'paired_linux_inputs.py').read_text());function=next(n for n in producer.body if isinstance(n,ast.FunctionDef)and n.name=='native_psql16');paths=[n.args[0].value for n in ast.walk(function)if isinstance(n,ast.Call)and isinstance(n.func,ast.Name)and n.func.id=='Path'and n.args and isinstance(n.args[0],ast.Constant)]
        consumer=ast.parse((HERE/'paired_linux_runtime.py').read_text());function=next(n for n in consumer.body if isinstance(n,ast.FunctionDef)and n.name=='admit');selected=[n.args[0].value for n in ast.walk(function)if isinstance(n,ast.Call)and isinstance(n.func,ast.Name)and n.func.id=='Path'and n.args and isinstance(n.args[0],ast.Constant)and str(n.args[0].value).startswith('/usr/lib/postgresql/')];self.assertEqual(paths,selected);self.assertEqual(selected,['/usr/lib/postgresql/16/bin/psql'])
    def test_all_other_bare_tool_and_python_rules_remain_strict(self):
        fixture=self.native_fixture();context,lookups=self.admit_native_fixture(fixture);self.assertEqual(lookups,['cast']);self.assertEqual(context['manifest']['external']['tools']['python3'],api.pin(Path(sys.executable).resolve(strict=True)));foreign=self.root/'foreign-cast';self.file(foreign,fixture[5].read_bytes())
        with self.assertRaisesRegex(api.Refused,'Runtime system tool differs from admitted input: cast'):self.admit_native_fixture(fixture,foreign)

class Factories(Fixture):
    def test_Rust_environment_exact_and_Zig_SDK_only_constructor_injection(self):
        context=self.context();launch=api.Launches(context);records=[]
        def original(binary,cwd,env):records.append(env);return types.SimpleNamespace()
        factory=launch.factory(original);rust={'CONFIG_FILES':'public-config','UNCHANGED':'yes'};zig={'HYPERLANE_ZIG_DEFAULTS':'public-config'}
        factory(api.product(context,'rust','validator'),self.root,rust);factory(api.product(context,'zig','validator','ReleaseSafe'),self.root,zig)
        self.assertIs(records[0],rust);self.assertEqual(rust,{'CONFIG_FILES':'public-config','UNCHANGED':'yes'});self.assertEqual(zig,{'HYPERLANE_ZIG_DEFAULTS':'public-config'});self.assertTrue(set(api.ENV_KEYS.values())<=set(records[1]));self.assertNotIn('HYPERLANE_URL_LIBRARY',rust)
    def test_copied_identical_daemon_is_admitted_foreign_binary_rejected(self):
        context=self.context();launch=api.Launches(context);source=api.product(context,'zig','validator','ReleaseSafe');alias=self.root/'alias';shutil.copyfile(source,alias)
        factory=launch.factory(lambda *args:types.SimpleNamespace());factory(alias,self.root,{})
        alias.write_bytes(b'foreign')
        with self.assertRaises(api.Refused):factory(alias,self.root,{})
    def test_wait4_metrics_come_only_from_existing_usage_and_Rust_signal_is_retained(self):
        context=self.context();launch=api.Launches(context);binary=api.pin(api.product(context,'rust','validator'));usage=types.SimpleNamespace(ru_utime=1.5,ru_stime=.25,ru_maxrss=123,ru_nvcsw=17,ru_nivcsw=4);instance=types.SimpleNamespace(usage=usage,end_ns=20,start_ns=10,status=-15,p=types.SimpleNamespace(returncode=-15,pid=42));launch.instances=[(instance,'rust','validator',binary)]
        rows=launch.actual_waits();self.assertEqual(rows[0]['exit_code'],-15);self.assertEqual(rows[0]['max_child_RSS_bytes'],123*1024);self.assertEqual(rows[0]['voluntary_context_switches'],17);self.assertEqual(rows[0]['involuntary_context_switches'],4)
        instance.usage=None
        with self.assertRaises(api.Refused):launch.actual_waits()

class RawStopBinding(Fixture):
    def records(self,role):
        keys={'validator':['measurements'],'scraper':['first_process','restart_process'],'relayer':['first_stop','restart_stop']}[role];waits=[];samples=[]
        for name in api.ORDER:
            sample={'implementation':name}
            for key in keys:
                metrics={'exit_code':-15 if name=='rust'else 0,'user_seconds':1,'system_seconds':2,'max_rss_bytes':4096,'voluntary_context_switches':7,'involuntary_context_switches':8};sample[key]=metrics
                waits.append({'role':role,'implementation':name,'exit_code':metrics['exit_code'],'user_seconds':1,'system_seconds':2,'max_child_RSS_bytes':4096,'voluntary_context_switches':7,'involuntary_context_switches':8})
            samples.append(sample)
        return waits,samples
    def test_actual_first_restart_fields_are_crossbound_for_all_three_roles(self):
        for role in ['validator','scraper','relayer']:
            waits,samples=self.records(role);api.bind_actual_samples(waits,samples,role)
            self.assertEqual(waits[0]['process_phase'],'initial')
            if role!='validator':self.assertEqual(waits[1]['process_phase'],'same_db_restart')
            self.assertEqual(waits[-1]['sample'],4)
    def test_changed_restart_CPU_or_missing_wait_cannot_gain_credit(self):
        waits,samples=self.records('scraper');samples[0]['restart_process']['user_seconds']=999
        with self.assertRaises(api.Refused):api.bind_actual_samples(waits,samples,'scraper')
        waits,samples=self.records('relayer');waits.pop()
        with self.assertRaises(api.Refused):api.bind_actual_samples(waits,samples,'relayer')

class CacheControls(Fixture):
    def setup_cache(self,label='scraper'):
        context=self.context();context['manifest']['repository_fixture_files']=[];wire={'language':'Solidity','sources':{'fixture':{'content':'public'}},'settings':{}};digest=api.sha(json.dumps(wire,sort_keys=True).encode());path=self.inputs/'fixture-provenance/scraper.contracts.json';self.file(path,json.dumps({'input_digest':digest,'contracts':{'actual-published':'bytecode'}}).encode());cache=self.root/'runtime-cache';cache.mkdir();calls=[]
        def original():calls.append('original');return api.read(cache/'contracts.json')['contracts']
        module=types.SimpleNamespace(DEPENDENCIES={},HERE=self.repo/'zig/integration',CACHE=cache,compiler_inputs=lambda:wire,compile_contracts=original,run=lambda args,**kw:calls.append(list(args)),subprocess=types.SimpleNamespace(run=lambda *a,**k:calls.append('forbidden-child'),Popen=None,PIPE=-1,TimeoutExpired=RuntimeError))
        return context,module,path,calls
    def test_verified_cache_calls_original_compiler_method_without_child(self):
        context,module,path,calls=self.setup_cache();observed=api.bind_cache(module,context,'scraper',self.repo);self.assertEqual(module.compile_contracts(),{'actual-published':'bytecode'});self.assertEqual(calls,['original']);self.assertTrue(observed[0]['actual_original_compiler_cache_hit'])
    def test_cache_digest_miss_refuses_before_original_or_compiler(self):
        context,module,path,calls=self.setup_cache();api.bind_cache(module,context,'scraper',self.repo);module.compiler_inputs=lambda:{'changed':True}
        with self.assertRaises(api.Refused):module.compile_contracts()
        self.assertEqual(calls,[])
        with self.assertRaises(api.Refused):module.run(['pnpm','dlx','solc'])
    def test_actual_npm_package_prefix_layout_is_accepted_without_acquisition(self):
        context,module,path,calls=self.setup_cache();module.DEPENDENCIES={'contracts':'not-executed'};nested=module.HERE/'.deps/contracts/package/package.json';self.file(nested,b'{}');api.bind_cache(module,context,'scraper',self.repo)
        self.assertEqual(module.compile_contracts(),{'actual-published':'bytecode'});self.assertEqual(calls,['original'])
    def test_actual_original_compiler_cache_miss_cannot_fork(self):
        context,module,path,calls=self.setup_cache()
        source=HERE.parent/'integration/evm.py';tree=ast.parse(source.read_text());function=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='compile_contracts')
        namespace={'ROOT':self.repo,'CACHE':module.CACHE,'compiler_inputs':module.compiler_inputs,'hashlib':api.hashlib,'json':json,'subprocess':module.subprocess}
        exec(compile(ast.Module(body=[function],type_ignores=[]),str(source),'exec'),namespace)
        module.compile_contracts=namespace['compile_contracts'];api.bind_cache(module,context,'scraper',self.repo)
        # The actual original helper sees a changed second digest and reaches its
        # direct subprocess.run branch; the scoped boundary must refuse BEFORE IO.
        namespace['subprocess']=module.subprocess;namespace['compiler_inputs']=lambda:{'changed-after-outer-check':True}
        with self.assertRaisesRegex(api.Refused,'before fork'):module.compile_contracts()
        self.assertNotIn('forbidden-child',calls)

    def test_dependency_absence_refuses_before_any_download(self):
        context,module,path,calls=self.setup_cache();module.DEPENDENCIES={'contracts':'not-executed'};api.bind_cache(module,context,'scraper',self.repo)
        with self.assertRaisesRegex(api.Refused,'no acquisition'):module.compile_contracts()
        self.assertEqual(calls,[])
    def test_symlink_data_target_is_never_overwritten(self):
        source=self.root/'data';source.write_text('public');foreign=self.root/'foreign';foreign.mkdir();target=self.root/'target';target.symlink_to(foreign,target_is_directory=True)
        with self.assertRaises(api.Refused):api.copy_identical(source,target/'data')
        self.assertFalse((foreign/'data').exists())

class SourceControls(Fixture):
    def test_exact_checked_module_exec_and_foreign_preloaded_module_refusal(self):
        source=self.file(self.repo/'toy.py',b'x=42\n');name='paired_toy_original'
        with mock.patch.object(api,'LOADS',((name,'toy.py'),)):
            with api.original_modules(self.repo,{'toy.py':source})as modules:self.assertEqual(modules[name].x,42)
            self.assertNotIn(name,sys.modules)
            sys.modules[name]=types.ModuleType(name)
            try:
                with self.assertRaises(api.Refused):
                    with api.original_modules(self.repo,{'toy.py':source}):pass
            finally:sys.modules.pop(name)
    def test_source_bytecode_tree_refused_without_executing_it(self):
        path=self.repo/'zig/bench/__pycache__';path.mkdir(parents=True);(path/'fake.pyc').write_bytes(b'never-executed')
        with self.assertRaises(api.Refused):api.no_bytecode(self.repo)
    def test_raw_catalog_refuses_links_and_retains_exact_bytes(self):
        raw=self.root/'raw';raw.mkdir();(raw/'data').write_bytes(b'public');catalog=api.raw_catalog(raw);self.assertEqual(catalog['bytes'],6);self.assertEqual(catalog['files'][0]['sha256'],api.sha(b'public'));(raw/'link').symlink_to(raw/'data')
        with self.assertRaises(api.Refused):api.raw_catalog(raw)

class MigrationAuthority(Fixture):
    def test_actual_scraper_literal21_reaches_guard_before_daemon_constructor(self):
        tree=ast.parse((HERE/'scraper.py').read_text());main=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='main');trial=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='run_trial')
        initial=[n for n in ast.walk(main)if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='first_migrations'for t in n.targets)];self.assertEqual(len(initial),1);self.assertEqual(ast.literal_eval(initial[0].value),21)
        fixture=next(n for n in ast.walk(main)if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='fixture_migrations'for t in n.targets));self.assertEqual(ast.unparse(fixture.value),"{'production_migrations_applied': first_migrations}")
        call=next(n for n in ast.walk(main)if isinstance(n,ast.Call)and isinstance(n.func,ast.Name)and n.func.id=='run_trial');self.assertEqual(ast.unparse(call.args[7]),'fixture_migrations')
        guard=next(n for n in ast.walk(trial)if isinstance(n,ast.If)and 'db[\'migrations\'] != expected_migrations'in ast.unparse(n.test));self.assertTrue(any(isinstance(n,ast.Raise)for n in ast.walk(guard)))
        expected=next(n for n in ast.walk(trial)if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='expected_migrations'for t in n.targets));self.assertEqual(ast.unparse(expected.value),"fixture_metadata['production_migrations_applied']")
        daemon=next(n for n in ast.walk(trial)if isinstance(n,ast.Call)and isinstance(n.func,ast.Name)and n.func.id=='MeasuredProcess');self.assertLess(guard.lineno,daemon.lineno)

class OptionalMetadata(Fixture):
    def test_only_exact_approved_solc_version_argv_is_refused(self):
        tree=ast.parse((HERE/'paired_linux_runtime.py').read_text());worker=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='worker');function=next(n for n in ast.walk(worker)if isinstance(n,ast.FunctionDef)and n.name=='runtime_run');calls=[];optional=[]
        namespace={'original_run':lambda args,**kw:calls.append(list(args)),'optional':optional,'Refused':api.Refused};exec(compile(ast.Module(body=[function],type_ignores=[]),'actual-runtime-optional-boundary','exec'),namespace)
        with self.assertRaises(api.Refused):namespace['runtime_run'](['pnpm','dlx','solc@0.8.33','--version'])
        self.assertEqual(calls,[]);self.assertEqual(len(optional),1);self.assertFalse(optional[0]['executed'])
        for args in [['cast','--version'],['pnpm','dlx','solc@0.8.34','--version'],['pnpm','dlx','solc@0.8.33','--version','extra']]:namespace['runtime_run'](args)
        self.assertEqual(len(calls),3)

class WorkerBoundary(Fixture):
    def test_one_fake_main_then_actual_wait_serialization_no_original_main_execution(self):
        context=self.context(0);context['manifest']['required_cpu_flags']=['sse2'];calls=[];made=[];module=types.SimpleNamespace()
        class Original:
            def __init__(self,binary,cwd,env):
                self.start_ns=1;self.end_ns=2;self.status=-15 if str(binary).endswith('/rust/validator')else 0;self.p=types.SimpleNamespace(pid=100+len(made),returncode=self.status);self.usage=types.SimpleNamespace(ru_utime=.1,ru_stime=.2,ru_maxrss=32,ru_nvcsw=3,ru_nivcsw=4);made.append(self)
        module.MeasuredProcess=Original
        def fake_main():
            calls.append('fake-fixture-main-only');args=list(sys.argv);raw=Path(args[args.index('--output')+1]);raw.mkdir();samples=[]
            for ordinal,name in enumerate(api.ORDER):
                path=api.product(context,name,'validator','ReleaseSafe'if name=='zig'else None);instance=module.MeasuredProcess(path,self.root,{'ORIGINAL':name});samples.append({'implementation':name,'sample':ordinal//2,'measurements':{'exit_code':instance.status,'user_seconds':.1,'system_seconds':.2,'max_rss_bytes':32*1024,'voluntary_context_switches':3,'involuntary_context_switches':4}})
            api.write(raw/'validator.json',{'raw_samples':samples})
        module.main=fake_main
        modules={'validator':module,'relayer':types.SimpleNamespace(MeasuredProcess=Original),'scraper':types.SimpleNamespace(MeasuredProcess=Original),'evm':types.SimpleNamespace(),'paired_runtime_cpu':types.SimpleNamespace(cpu_flags=lambda *a,**k:{'sse2'})}
        @contextlib.contextmanager
        def fake_modules(*args):yield modules
        original_open=Path.open
        def opened(path,*args,**kwargs):return io.StringIO('flags : sse2\n')if str(path)=='/proc/cpuinfo'else original_open(path,*args,**kwargs)
        with mock.patch.object(api,'original_modules',fake_modules),mock.patch.object(api,'source_recheck',side_effect=lambda *args:calls.append('recheck')),mock.patch.object(api,'bind_cache',return_value=[]),mock.patch.object(api.time,'monotonic',return_value=1),mock.patch.object(Path,'open',opened):
            value=api.worker(context,self.repo,self.root/'out',0,100,160)
        self.assertEqual(calls.count('fake-fixture-main-only'),1);self.assertEqual(value['actual_pairs'],5);self.assertEqual(len(value['actual_original_wait4_rows']),10);self.assertEqual([r['exit_code']for r in value['actual_original_wait4_rows']if r['implementation']=='rust'],[-15]*5);self.assertFalse(value['Root_final_timing_acceptance']);self.assertEqual(api.read(self.root/'out/result.json')['index'],0)

    def test_runtime_paths_are_closed_and_scraper_only_has_PG_authority(self):
        for index in range(10):
            context=self.context(index);context['manifest']['external']['tools']={'docker':{'fixture':'not-executed'}};output=self.root/('out'+str(index));paths=api.runtime_paths(context,self.repo,output,index)
            if index in(4,5):
                self.assertEqual(paths['raw_output'].parent,self.repo/'zig/bench/results');self.assertTrue(paths['raw_output'].name.startswith('scraper-process-'));self.assertEqual(paths['postgres']['receipts'],output/'postgres');self.assertEqual(paths['postgres']['token'],api.sha((str(output)+context['authority_pin']['sha256']).encode())[:32])
            else:self.assertIsNone(paths['postgres']);self.assertEqual(paths['raw_output'],output/'raw')

if __name__=='__main__':unittest.main()
