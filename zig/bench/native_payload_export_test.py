import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

SOURCE = Path(__file__).parent / 'native_payload_export.py'
spec = importlib.util.spec_from_file_location('export_candidate', SOURCE)
export = importlib.util.module_from_spec(spec)
spec.loader.exec_module(export)

class PayloadControls(unittest.TestCase):
    def test_only_nine_successful_same_payload_mode_receipts(self):
        hashes={key:hashlib.sha256(key.encode()).hexdigest() for key in export.FILES}
        native={'passed':True,'exit_code':0,'mode':'ReleaseSafe','artifact_sha256':hashes}
        runtime={'passed':True,'artifact_sha256':dict(hashes)}
        self.assertEqual(export.validate_receipts(native,runtime,'ReleaseSafe'),hashes)
        for field,value in [('passed',False),('exit_code',1),('mode','ReleaseFast')]:
            changed=dict(native);changed[field]=value
            with self.assertRaises(ValueError):export.validate_receipts(changed,runtime,'ReleaseSafe')
        changed=dict(runtime);changed['artifact_sha256']=dict(hashes);changed['artifact_sha256']['relayer']=hashes['validator']
        with self.assertRaises(ValueError):export.validate_receipts(native,changed,'ReleaseSafe')
        for key in ['init-db','unknown']:
            changed=dict(hashes);changed[key]='00'*32
            with self.assertRaises(ValueError):export.validate_receipts(dict(native,artifact_sha256=changed),dict(runtime,artifact_sha256=changed),'ReleaseSafe')
    def test_elf_native_platform_hash_and_regular_file(self):
        with tempfile.TemporaryDirectory()as directory:
            root=Path(directory);path=root/'worker';data=bytearray(20);data[:6]=b'\x7fELF\x02\x01';data[18:20]=(62).to_bytes(2,'little');path.write_bytes(data);sha=hashlib.sha256(data).hexdigest()
            export.validate_payload(path,sha,'amd64')
            with self.assertRaises(ValueError):export.validate_payload(path,sha,'arm64')
            with self.assertRaises(ValueError):export.validate_payload(path,'00'*32,'amd64')
            alias=root/'alias';alias.symlink_to(path)
            with self.assertRaises(ValueError):export.validate_payload(alias,sha,'amd64')
            path.write_bytes(b'MZ'+bytes(data[2:]))
            with self.assertRaises(ValueError):export.validate_payload(path,hashlib.sha256(path.read_bytes()).hexdigest(),'amd64')

class FakeDockerExport(unittest.TestCase):
    def test_real_cli_success_and_failed_create_cleanup(self):
        import subprocess,sys
        for failed_create, bad_cpu, appended_tar in [(False,False,False),(True,False,False),(False,True,False),(False,False,True)]:
            with self.subTest(failed_create=failed_create,bad_cpu=bad_cpu,appended_tar=appended_tar), tempfile.TemporaryDirectory() as directory:
                root=Path(directory);fake=root/'docker';payloads={}
                for key in export.FILES:
                    data=bytearray(20);data[:6]=b'\x7fELF\x02\x01';data[18:20]=(62).to_bytes(2,'little');payloads[key]=bytes(data)+key.encode()
                hashes={key:hashlib.sha256(data).hexdigest()for key,data in payloads.items()}
                native=root/'native.json';runtime=root/'runtime.json'
                native.write_text(json.dumps({'passed':True,'exit_code':0,'mode':'ReleaseSafe','artifact_sha256':hashes}));runtime.write_text(json.dumps({'passed':True,'artifact_sha256':hashes,'image_id_chunks':['12'*16,'12'*16],'architecture':'amd64'}))
                for scope,names in export.build_cpu.SCOPES.items():
                    row={'schema':1,'scope':scope,'mode':'ReleaseFast'if bad_cpu else'ReleaseSafe','source_commit':'ab'*20,'architecture':'amd64','flags':['avx','sse2'],'artifacts':{name:{'bytes':len(payloads[name]),'sha256':hashes[name]}for name in names}}
                    payloads[scope+'.json']=json.dumps(row).encode()
                script = "#!"+sys.executable+"\n"+"import os,sys,json,pathlib,tarfile,io\na=sys.argv[5:];p=pathlib.Path(os.environ['HOME'])/'fake-state.json'\nassert not any(k in os.environ for k in ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_AUTH_CONFIG','HTTP_PROXY'])\n"
                script += "payloads="+repr(payloads)+"\n"
                script += "if a[:2]==['image','inspect']:print(json.dumps([{'Id':'sha256:'+'12'*32,'Os':'linux','Architecture':'amd64'}]))\n"
                script += "elif a[0]=='create':\n labels=dict(a[i+1].split('=',1)for i,x in enumerate(a)if x=='--label');p.write_text(json.dumps({'Id':'34'*32,'Image':a[-1],'Name':'/'+a[a.index('--name')+1],'Config':{'Labels':labels},'State':{'Running':False}}))\n"
                script += (" raise SystemExit(5)\n"if failed_create else" print('34'*32)\n")
                script += "elif a[:2]==['container','inspect']:\n if not p.exists():sys.stderr.write('No such container');raise SystemExit(1)\n print('['+p.read_text()+']')\n"
                script += "elif a[:2]==['container','rm']:p.unlink()\n"
                script += "elif a[0]=='cp':\n key=a[1].rsplit('/',1)[1];data=payloads[key]\n with tarfile.open(fileobj=sys.stdout.buffer,mode='w|')as t:\n  m=tarfile.TarInfo(key);m.size=len(data);t.addfile(m,io.BytesIO(data))\n"
                if appended_tar:script += " with tarfile.open(fileobj=sys.stdout.buffer,mode='w|')as t:\n  m=tarfile.TarInfo('hidden');m.size=1;t.addfile(m,io.BytesIO(b'x'))\n"
                script += "else:raise SystemExit(9)\n"
                fake.write_text(script);fake.chmod(0o700);out=root/'out'
                child=subprocess.run([sys.executable,str(SOURCE),'--image','fixture:full','--mode','ReleaseSafe','--git-sha','ab'*20,'--native',str(native),'--runtime',str(runtime),'--output',str(out),'--docker',str(fake)],env={'PATH':os.defpath,'DOCKER_HOST':'tcp://foreign','DOCKER_CONTEXT':'foreign','DOCKER_AUTH_CONFIG':'synthetic-not-a-credential','HTTP_PROXY':'http://foreign'},capture_output=True,text=True,timeout=12)
                result=json.loads((out/'manifest.json').read_text());self.assertEqual(result['passed'],not(failed_create or bad_cpu or appended_tar),child.stderr);self.assertEqual(child.returncode,1 if(failed_create or bad_cpu or appended_tar)else 0,child.stderr)
                self.assertTrue(result['exact_created_CID_removed']);self.assertFalse((out/'fake-state.json').exists());self.assertFalse(result['image_started_by_exporter']);self.assertTrue(all(row['actual_parent_wait']for row in result['calls']))
                if not(failed_create or bad_cpu or appended_tar):
                    self.assertEqual(set(result['artifacts']),set(export.FILES));self.assertEqual(set(result['build_provenance']),set(export.build_cpu.SCOPES));self.assertEqual(result['required_cpu_flags'],['avx','sse2'])
                    self.assertEqual({name:row['path'] for name,row in result['artifacts'].items()},{name:'payload/'+row[0] for name,row in export.FILES.items()})

class CpuControls(unittest.TestCase):
    def test_compile_union_consumer_intersection_and_superset(self):
        cpu=export.build_cpu
        text='flags : avx sse2\nflags : sse2\n'
        self.assertEqual(cpu.cpu_flags(text),['avx','sse2']);self.assertEqual(cpu.cpu_flags(text,True),['sse2'])
        self.assertFalse(cpu.consumer_covers([{'architecture':'amd64','flags':['avx','sse2']}],'amd64',['sse2']))
        self.assertTrue(cpu.consumer_covers([{'architecture':'amd64','flags':['avx','sse2']}],'amd64',['avx','sse2','avx2']))
        self.assertFalse(cpu.consumer_covers([{'architecture':'arm64','flags':['fp']}],'amd64',['fp']))

class WriterPlanControls(unittest.TestCase):
    def test_matching_mode_seven_archives_no_execution_or_bootstrap(self):
        import native_interop_writer_export as writer
        root=Path('/work');libs=[Path('/opt/hyperlane-native')/name for name in sorted(writer.ARCHIVES)]
        argv=writer.compile_plan(root,Path('/compiler'),'ReleaseFast',2,libs,Path('/output/writer'))
        self.assertIn('build-exe',argv);self.assertEqual(argv[argv.index('-target')+1],'native');self.assertEqual([v for v in argv if v.startswith('-mcpu=')],['-mcpu=x86_64_v3+pclmul']);self.assertIn('src/native_rows_interop_fixture.zig',argv);self.assertIn('-j2',argv);self.assertIn('ReleaseFast',argv);self.assertNotIn('run',argv);self.assertFalse(any('bootstrap' in word for word in argv))
        with self.assertRaises(ValueError):writer.compile_plan(root,Path('/compiler'),'ReleaseFast',2,libs[:-1],Path('/output/writer'))
        with self.assertRaises(ValueError):writer.compile_plan(root,Path('/compiler'),'ReleaseSafe',8,libs,Path('/output/writer'))

class PortableCpuControls(unittest.TestCase):
    def setUp(self):
        self.cpu=export.build_cpu
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve()
        self.source=self.root/'zig/bench/native_harness_controls.py'
        self.source.parent.mkdir(parents=True);self.source.write_text('# actual test compiler caller\n')
        self.env=self.cpu.portable_environment({'PATH':'/usr/bin:/bin'})

    def recipe(self, kind='rust', command=None, source=None):
        command=command or ['cargo','build','--locked','--package','fixture']
        pending=self.cpu.recipe(kind,command,self.env,source or self.source,repo=self.root)
        return self.cpu.finish_recipe(pending,{'actual_parent_wait':True,'exit_code':0},repo=self.root)

    def row(self):
        recipes=[self.recipe(command=['cargo',command,'--locked'])for command in ('build','test')]
        return self.cpu.make_record('helper','shared','ab'*20,'amd64',['amd_only','sse2'],
             {name:{'bytes':17,'sha256':hashlib.sha256(name.encode()).hexdigest()}for name in ('normal','construction')},recipes)

    def test_explicit_profile_uses_ISA_not_observed_host_and_real_model_aliases(self):
        # Pinned Zig0.15.2 x86_64_v3 model plus explicit pclmul: hardware features, excluding
        # 64bit (architecture guard) and explicitly named scheduling features.
        model=['avx2','bmi','bmi2','cmov','cx16','f16c','fma','fxsr','lzcnt',
               'mmx','movbe','nopl','popcnt','sahf','x87','xsave','pclmul']
        aliases={'bmi':'bmi1','lzcnt':'abm','sahf':'lahf_lm','x87':'fpu','pclmul':'pclmulqdq'}
        self.assertLessEqual({aliases.get(v,v)for v in model},set(self.cpu.REQUIRED_FLAGS))
        # Rust target model ISA plus the explicit +pclmulqdq feature (Root metadata probe required).
        rust=['avx','avx2','bmi1','bmi2','cmpxchg16b','f16c','fma','fxsr','lzcnt',
              'movbe','popcnt','sse','sse2','sse3','sse4.1','sse4.2','ssse3','xsave','pclmulqdq']
        aliases.update(cmpxchg16b='cx16',sse3='pni',**{'sse4.1':'sse4_1','sse4.2':'sse4_2'})
        self.assertLessEqual({aliases.get(v,v)for v in rust},set(self.cpu.REQUIRED_FLAGS))
        row=self.row();self.assertNotIn('amd_only',self.cpu.required_flags(row))
        self.assertEqual(row['flags'],['amd_only','sse2'])
        self.assertTrue(self.cpu.consumer_covers([row],'amd64',list(self.cpu.REQUIRED_FLAGS)))
        self.assertFalse(self.cpu.consumer_covers([row],'amd64',[v for v in self.cpu.REQUIRED_FLAGS if v!='nopl']))
        self.assertFalse(self.cpu.consumer_covers([row],'arm64',list(self.cpu.REQUIRED_FLAGS)))

    def test_sanitize_overrides_and_reject_direct_argv_escape(self):
        dirty={'CC':'cc -march=native','CXX_x86_64_unknown_linux_gnu':'c++ -march=native',
               'HOST_CFLAGS':'-march=native','CARGO_ENCODED_RUSTFLAGS':'',
               'CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS':'-Ctarget-cpu=native',
               'CARGO_BUILD_TARGET':'aarch64-unknown-linux-gnu','RUSTC_WRAPPER':'foreign',
               'CARGO_PROFILE_DEV_DEBUG':'0','PATH':'/usr/bin:/bin'}
        clean=self.cpu.portable_environment(dirty,tokio_unstable=True)
        for key in set(dirty)-{'CARGO_PROFILE_DEV_DEBUG','PATH','RUSTC_WRAPPER'}:self.assertNotIn(key,clean)
        self.assertEqual(clean['RUSTC_WRAPPER'],'')
        self.assertEqual(clean['CARGO_PROFILE_DEV_DEBUG'],'0')
        self.assertEqual(clean['RUSTFLAGS'],'--cfg tokio_unstable '+self.cpu.RUST_CPU)
        for argv in (['cargo','rustc','--','-Ctarget-cpu=native'],['cargo','build','--config','build.rustflags=[]'],['cargo','build','--target=aarch64-unknown-linux-gnu']):
            with self.assertRaises(ValueError):self.recipe(command=argv)
        for key,value in [('CARGO_ENCODED_RUSTFLAGS',''),('CC','cc -march=native'),('CFLAGS_x86_64_unknown_linux_gnu','-march=native')]:
            env=dict(self.env);env[key]=value
            with self.assertRaises(ValueError):self.cpu.recipe('rust',['cargo','build'],env,self.source,repo=self.root)
        with self.assertRaises(ValueError):self.recipe('zig-direct',['zig','test','-target','x86_64-linux-gnu','-mcpu=native'])
        with self.assertRaises(ValueError):self.recipe('cc',['c++','-march=x86-64-v3','-mtune=generic','-march=native'])

    def test_completed_actual_wait_source_and_complete_scope_coverage(self):
        import copy
        row=self.row();self.cpu.validate_recipe_sources(row,lambda path:self.source.read_bytes())
        with self.assertRaises(ValueError):self.cpu.validate_recipe_sources(row,lambda path:b'foreign caller')
        for edit in ('missing','duplicate','wrongkind','foreignsource','failedwait','badartifact','wrongprofile'):
            changed=copy.deepcopy(row)
            if edit=='missing':changed['recipes'].pop()
            if edit=='duplicate':changed['recipes'][1]=changed['recipes'][0]
            if edit=='wrongkind':changed['recipes'][1]['kind']='cc'
            if edit=='foreignsource':changed['recipes'][1]['source']['path']='zig/unreviewed.py'
            if edit=='failedwait':changed['recipes'][1]['actual_parent_wait']=False
            if edit=='badartifact':changed['artifacts']['normal']['bytes']=0
            if edit=='wrongprofile':changed['target']['zig_cpu']='native'
            with self.subTest(edit=edit),self.assertRaises(ValueError):self.cpu.required_flags(changed)
        pending=self.cpu.recipe('rust',['cargo','build'],self.env,self.source,repo=self.root)
        for wait in ({'actual_parent_wait':False,'exit_code':0},{'actual_parent_wait':True,'exit_code':1},{'actual_parent_wait':True,'exit_code':False}):
            with self.assertRaises(ValueError):self.cpu.finish_recipe(pending,wait,repo=self.root)
        self.source.write_text('changed')
        with self.assertRaises(ValueError):self.cpu.finish_recipe(pending,{'actual_parent_wait':True,'exit_code':0},repo=self.root)

    def test_explicit_pclmul_is_required_across_Rust_Zig_C_and_consumer_flags(self):
        import copy
        self.assertEqual(self.cpu.PROFILE,'linux-x86_64-v3-pclmul-native-abi-v1')
        self.assertEqual(len(self.cpu.REQUIRED_FLAGS),25);self.assertIn('pclmulqdq',self.cpu.REQUIRED_FLAGS)
        self.assertEqual(self.env['RUSTFLAGS'],'-Ctarget-cpu=x86-64-v3 -Ctarget-feature=+pclmulqdq')
        self.assertEqual(self.env['CFLAGS'],'-march=x86-64-v3 -mtune=generic -mpclmul')
        self.assertEqual(self.cpu.zig_cpu_args('direct'),['-target','native','-mcpu=x86_64_v3+pclmul'])
        self.assertEqual(self.cpu.zig_cpu_args('build'),['-Dtarget=native','-Dcpu=x86_64_v3+pclmul'])
        self.assertFalse(self.cpu.consumer_covers([self.row()],'amd64',[v for v in self.cpu.REQUIRED_FLAGS if v!='pclmulqdq']))
        # Failed H V3-only records and recipes remain historical, never relabelled.
        row=self.row();row['target']['profile']='linux-x86_64-v3-v1'
        with self.assertRaises(ValueError):self.cpu.required_flags(row)
        oldenv=dict(self.env);oldenv['RUSTFLAGS']='-Ctarget-cpu=x86-64-v3'
        with self.assertRaises(ValueError):self.cpu.recipe('rust',['cargo','build'],oldenv,self.source,repo=self.root)
        with self.assertRaises(ValueError):self.recipe('zig-direct',['zig','test','-target','x86_64-linux-gnu','-mcpu=x86_64_v3'])
        with self.assertRaises(ValueError):self.recipe('zig-build',['zig','build','-Dtarget=x86_64-linux-gnu','-Dcpu=x86_64_v3'])
        with self.assertRaises(ValueError):self.recipe('cc',['c++','-march=x86-64-v3','-mtune=generic','-c','fixture.cc'])
        with self.assertRaises(ValueError):self.recipe('cc',['c++',*self.cpu.C_FLAGS.split(),'-mno-pclmul','-c','fixture.cc'])
        self.recipe('cc',['c++',*self.cpu.C_FLAGS.split(),'-c','fixture.cc'])

    def test_producer_profile_is_exact_closed_bounded_AST_and_never_legacy_relabel(self):
        self.assertIsNone(self.cpu.profile_from_source(b'# historical schema1 procedure'))
        self.assertEqual(self.cpu.profile_from_source(('PROFILE = '+repr(self.cpu.PROFILE)).encode()),self.cpu.PROFILE)
        for wire in (b'PROFILE="native"',b'PROFILE: str="foreign"',b'from foreign import PROFILE',b'PROFILE="foreign"\nPROFILE="another"',b'x'* (1024**2+1)):
            with self.subTest(prefix=wire[:32]),self.assertRaises(ValueError):self.cpu.profile_from_source(wire)

    def test_portable_family_refuses_missing_mixed_and_legacy_under_new_profile(self):
        row=self.row();legacy={'schema':1,'flags':['sse2']}
        self.assertEqual(self.cpu.require_same_profile([row,row],True),self.cpu.PROFILE)
        self.assertIsNone(self.cpu.require_same_profile([legacy,legacy]))
        for rows in ([row,legacy],[row,None],[],[legacy]):
            with self.assertRaises(ValueError):self.cpu.require_same_profile(rows,True)

    def test_actual_cli_wrapper_records_success_wait_and_preserves_failure(self):
        from unittest.mock import patch
        import sys,types
        output=self.root/'recipe.json'
        argv=['build_cpu.py','run','--kind','rust','--repo',str(self.root),'--recipe-source',str(self.source),
              '--recipe-output',str(output),'--','cargo','build','--locked']
        with patch.object(self.cpu.platform,'system',return_value='Linux'),patch.object(self.cpu.platform,'machine',return_value='x86_64'),patch.object(self.cpu.platform,'libc_ver',return_value=('glibc','2.39')),patch.object(sys,'argv',argv),patch.object(self.cpu.subprocess,'run',return_value=types.SimpleNamespace(returncode=0))as run:
            self.cpu.run_main()
        actual=run.call_args;self.assertEqual(actual.args[0],['cargo','build','--locked'])
        self.assertEqual(actual.kwargs['env']['RUSTFLAGS'],self.cpu.RUST_CPU)
        self.assertNotIn('start_new_session',actual.kwargs)
        self.assertEqual(json.loads(output.read_text())['actual_parent_wait'],True)
        failed=self.root/'failed.json';argv[argv.index(str(output))]=str(failed)
        with patch.object(self.cpu.platform,'system',return_value='Linux'),patch.object(self.cpu.platform,'machine',return_value='x86_64'),patch.object(self.cpu.platform,'libc_ver',return_value=('glibc','2.39')),patch.object(sys,'argv',argv),patch.object(self.cpu.subprocess,'run',return_value=types.SimpleNamespace(returncode=7)),self.assertRaises(SystemExit)as raised:
            self.cpu.run_main()
        self.assertEqual(raised.exception.code,7);self.assertFalse(failed.exists())

    def test_native_ABI_is_explicit_fixed_CPU_and_failed_I_target_cannot_be_relabelled(self):
        self.assertEqual(self.cpu.TARGET['abi_policy'],'publisher-native-linux-gnu')
        self.assertEqual(self.cpu.TARGET['zig_target'],'native')
        for kind,old,new in [('zig-build',['zig','build','-Dtarget=x86_64-linux-gnu','-Dcpu=x86_64_v3+pclmul'],['zig','build',*self.cpu.zig_cpu_args('build')]),('zig-direct',['zig','test','-target','x86_64-linux-gnu','-mcpu=x86_64_v3+pclmul'],['zig','test',*self.cpu.zig_cpu_args('direct')])]:
            with self.subTest(kind=kind),self.assertRaises(ValueError):self.recipe(kind,old)
            self.recipe(kind,new)
            native_cpu=[('-Dcpu=native'if word.startswith('-Dcpu=')else'-mcpu=native'if word.startswith('-mcpu=')else word)for word in new]
            with self.subTest(kind=kind,CPU='native'),self.assertRaises(ValueError):self.recipe(kind,native_cpu)
        row=self.row();row['target']['profile']='linux-x86_64-v3-pclmul-v1'
        with self.assertRaises(ValueError):self.cpu.required_flags(row)
        for key,value in [('zig_target','x86_64-linux-gnu'),('abi_policy','universal-glibc-2.17')]:
            row=self.row();row['target'][key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):self.cpu.required_flags(row)

    def test_actual_native_ABI_wrapper_refuses_foreign_host_before_compiler_or_output(self):
        from unittest.mock import patch
        import sys
        output=self.root/'never.json'
        argv=['build_cpu.py','run','--kind','zig-direct','--repo',str(self.root),'--recipe-source',str(self.source),'--recipe-output',str(output),'--','zig','test',*self.cpu.zig_cpu_args('direct')]
        for system,machine,libc in [('Darwin','x86_64',''),('Linux','aarch64','glibc'),('Linux','x86_64','musl')]:
            with self.subTest(system=system,machine=machine,libc=libc),patch.object(self.cpu.platform,'system',return_value=system),patch.object(self.cpu.platform,'machine',return_value=machine),patch.object(self.cpu.platform,'libc_ver',return_value=(libc,'')),patch.object(sys,'argv',argv),patch.object(self.cpu.subprocess,'run')as run,self.assertRaisesRegex(ValueError,'native ABI compiler'):
                self.cpu.run_main()
            run.assert_not_called();self.assertFalse(output.exists())

if __name__=='__main__':unittest.main()
