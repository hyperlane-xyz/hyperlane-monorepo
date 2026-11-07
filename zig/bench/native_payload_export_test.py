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
        self.assertIn('build-exe',argv);self.assertIn('src/native_rows_interop_fixture.zig',argv);self.assertIn('-j2',argv);self.assertIn('ReleaseFast',argv);self.assertNotIn('run',argv);self.assertFalse(any('bootstrap' in word for word in argv))
        with self.assertRaises(ValueError):writer.compile_plan(root,Path('/compiler'),'ReleaseFast',2,libs[:-1],Path('/output/writer'))
        with self.assertRaises(ValueError):writer.compile_plan(root,Path('/compiler'),'ReleaseSafe',8,libs,Path('/output/writer'))

if __name__=='__main__':unittest.main()
