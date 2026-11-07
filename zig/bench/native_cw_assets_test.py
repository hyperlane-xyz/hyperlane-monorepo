"""Pure static CLI/data admission controls. No CLI, loader, network or node runs."""
import copy
import hashlib
import importlib.util
import io
from pathlib import Path
import struct
import tempfile
import unittest
from unittest import mock
import zipfile

spec=importlib.util.spec_from_file_location('native_cw_assets',Path(__file__).with_name('native_cw_assets.py'))
a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)


def archive(files):
    stream=io.BytesIO()
    with zipfile.ZipFile(stream,'w') as z:
        for name,data in files.items():z.writestr(name,data)
    return stream.getvalue()


def static_elf(path,machine=62,kind=2,extra_tag=None):
    rows=[(1,5,0x1000,0x400000,0,0x400,0x400,0x1000),(0x6474e551,6,0,0,0,0,0,0x10)]
    if extra_tag is not None:rows.append((extra_tag,4,0x300,0,0,16,16,8))
    data=bytearray(0x2000);data[:16]=b'\x7fELF\x02\x01\x01'+b'\0'*9
    struct.pack_into('<HHIQQQIHHHHHH',data,16,kind,machine,1,0x400000,64,0,0,64,56,len(rows),0,0,0)
    for i,row in enumerate(rows):struct.pack_into('<IIQQQQQQ',data,64+i*56,*row)
    path.write_bytes(data);return path


class CwStaticAssetsTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory(prefix='ziggy-cw-static-control-');self.addCleanup(temp.cleanup);self.root=Path(temp.name).resolve()

    def admit_fixture(self,path,architecture='amd64'):
        row={**a.CLI_RELEASE[architecture],'bytes':path.stat().st_size,'sha256':a.pin(path)['sha256']}
        with mock.patch.dict(a.CLI_RELEASE,{architecture:row}):return a.static_cli(path,architecture)

    def wasm(self):
        files={f'public_{i}.wasm':b'\x00asm\x01\x00\x00\x00'+bytes([i]) for i in range(20)}
        files['checksums.txt']=''.join(hashlib.sha256(data).hexdigest()+'  '+name+'\n' for name,data in files.items()).encode()
        raw=archive(files);digest=hashlib.sha256()
        for name,data in sorted(files.items()):digest.update(name.encode()+b'\0'+str(len(data)).encode()+b'\0'+hashlib.sha256(data).hexdigest().encode()+b'\n')
        for name,value in [('WASM_BYTES',len(raw)),('WASM_SHA',hashlib.sha256(raw).hexdigest()),('WASM_MEMBER_SHA',digest.hexdigest())]:
            patch=mock.patch.object(a,name,value);patch.start();self.addCleanup(patch.stop)
        return raw,files

    def policy(self,architecture='amd64'):
        return {'local_checkout_build':True,'hpack':{'version':'4.2.0','wheel_sha256':'858ac0b02280fa582b5080d68db0899c6'+'2a80375e0e5413a74970c5e518b6986','wheel_bytes':34246},'registry_commit':None,'native_cli':{'name':'osmosisd','architecture':architecture,**a.CLI_RELEASE[architecture]},'wasm_bundle':{'schema':1,'source_release':'v0.0.6','source_url':a.WASM_URL,'bytes':a.WASM_BYTES,'sha256':a.WASM_SHA,'member_count':21,'member_digest':a.WASM_MEMBER_SHA,'publisher_checksum':None}}

    def test_static_native_file_is_admitted_as_data_without_executable_mode(self):
        for architecture,machine in [('amd64',62),('arm64',183)]:
            path=static_elf(self.root/architecture,machine);path.chmod(0o600)
            value=self.admit_fixture(path,architecture)
            self.assertEqual(value['ELF']['type'],2);self.assertEqual(value['ELF']['machine'],machine)
            self.assertEqual(value['ELF']['PT_DYNAMIC_count'],0);self.assertEqual(value['ELF']['PT_INTERP_count'],0)
            self.assertFalse(value['native_code_executed']);self.assertFalse(path.stat().st_mode&0o111)

    def test_static_admission_refuses_dynamic_interpreter_pie_and_foreign_machine(self):
        for options in [{'extra_tag':2},{'extra_tag':3},{'kind':3},{'machine':183}]:
            path=static_elf(self.root/'foreign',**options)
            with self.subTest(options=options),self.assertRaises(ValueError):self.admit_fixture(path)

    def test_static_admission_refuses_segments_headers_entry_and_darwin(self):
        original=static_elf(self.root/'valid').read_bytes()
        corruptions=[]
        value=bytearray(original);struct.pack_into('<Q',value,64+8,len(value)+1);corruptions.append(value)
        value=bytearray(original);struct.pack_into('<Q',value,24,0x500000);corruptions.append(value)
        value=bytearray(original);struct.pack_into('<H',value,54,55);corruptions.append(value)
        value=bytearray(original);struct.pack_into('<Q',value,64+40,0);corruptions.append(value)
        corruptions += [original[:90],b'\xcf\xfa\xed\xfe'+original[4:]]
        for index,value in enumerate(corruptions):
            path=self.root/str(index);path.write_bytes(value)
            with self.subTest(index=index),self.assertRaises(ValueError):self.admit_fixture(path)

    def test_unreviewed_hash_or_architecture_never_uses_static_shape_as_approval(self):
        path=static_elf(self.root/'unreviewed')
        with self.assertRaisesRegex(ValueError,'official static CLI bytes'):a.static_cli(path,'amd64')
        with self.assertRaises(ValueError):a.static_cli(path,'Darwin')
        other=self.root/'alias';other.symlink_to(path)
        with self.assertRaises(ValueError):self.admit_fixture(other)

    def test_wasm_relocation_keeps_full_source_bytes_and_closed_tree(self):
        raw,files=self.wasm();bundle=a.materialize_wasm(raw,self.root/'staged');self.assertEqual(a.read_wasm_bundle(bundle),raw)
        relocated=a.materialize_wasm(a.read_wasm_bundle(bundle),self.root/'case');self.assertEqual(a.read_wasm_bundle(relocated),raw)
        self.assertEqual({n:r['sha256'] for n,r in bundle['files'].items()},{n:r['sha256'] for n,r in relocated['files'].items()})
        (Path(relocated['root'])/'extra').write_bytes(b'x')
        with self.assertRaises(ValueError):a.read_wasm_bundle(relocated)

    def test_wasm_archive_member_execute_and_hardlink_mutation_refuse(self):
        raw,files=self.wasm();bundle=a.materialize_wasm(raw,self.root/'staged')
        with self.assertRaises(ValueError):a.wasm_members(raw+b'foreign')
        member=Path(next(iter(bundle['files'].values()))['path']);member.chmod(0o700)
        with self.assertRaises(ValueError):a.read_wasm_bundle(bundle)
        member.chmod(0o600)
        import os
        os.link(member,self.root/'aliased')
        with self.assertRaises(ValueError):a.read_wasm_bundle(bundle)

    def test_archive_traversal_directory_link_duplicate_refuse_before_extract(self):
        for name in ['../escape','/absolute','a/../escape','a\\escape','./alias']:
            with self.subTest(name=name),self.assertRaises(ValueError):a.closed_zip(archive({name:b'x'}),1024,2)
        stream=io.BytesIO()
        with zipfile.ZipFile(stream,'w') as z:
            row=zipfile.ZipInfo('link');row.external_attr=(0o120777<<16);z.writestr(row,b'target')
        with self.assertRaises(ValueError):a.closed_zip(stream.getvalue(),1024,2)
        with self.assertRaises(ValueError):a.closed_zip(archive({'directory/':b''}),1024,2)
        stream=io.BytesIO()
        with self.assertWarns(UserWarning):
            with zipfile.ZipFile(stream,'w') as z:z.writestr('duplicate',b'one');z.writestr('duplicate',b'two')
        with self.assertRaises(ValueError):a.closed_zip(stream.getvalue(),1024,2)

    def test_static_policy_never_claims_external_module_loader_or_registry(self):
        policy=self.policy();a.validate_policy(policy,'amd64')
        for field,value in [('registry_commit','a'*40),('native_cli',{**policy['native_cli'],'name':'hypd'}),('wasm_bundle',{**policy['wasm_bundle'],'publisher_checksum':{'sha256':'a'*64}}),('wasmvm',{'version':'v1.2.3'}),('loader',{})]:
            changed=copy.deepcopy(policy);changed[field]=value
            with self.subTest(field=field),self.assertRaises(ValueError):a.validate_policy(changed,'amd64')
        bad=copy.deepcopy(policy);bad['wasm_bundle']['schema']=True
        with self.assertRaises(ValueError):a.validate_policy(bad,'amd64')
        with self.assertRaises(ValueError):a.validate_policy(policy,'arm64')

    def selector(self,scenario):
        spec=importlib.util.spec_from_file_location('cw_static_request',Path(__file__).with_name('native_case_ci.py'));ci=importlib.util.module_from_spec(spec);spec.loader.exec_module(ci)
        request={'schema':1,'root_approved':True,'scenario':scenario,'mode':'ReleaseSafe','producer_source_commit':'a'*40,'producer_run_id':42,'producer_run_attempt':1,'limits':dict(ci.LIMITS),'artifact_pins':{},'postgres':{'schema':2,'architecture':'amd64','image':'postgres:14','image_id':'sha256:'+'d'*64,'canonical_digest':'postgres@sha256:'+'e'*64},'prerequisites':self.policy()}
        request['artifact_pins']={key:{'id':i,'name':name,'sha256':'b'*64,'size_in_bytes':1024} for i,(key,name) in enumerate(ci.artifact_names(request).items(),1)}
        return ci,request

    def test_request_accepts_only_static_closed_cw_policy_and_both_wasm_fields(self):
        ci,request=self.selector('cosmwasm');ci.validate_request(request)
        for field,value in [('wasmvm',{'version':'v1.2.3'}),('loader',{}),('registry_commit','a'*40)]:
            bad=copy.deepcopy(request);bad['prerequisites'][field]=value
            with self.subTest(field=field),self.assertRaises(ValueError):ci.validate_request(bad)
        bad=copy.deepcopy(request);bad['prerequisites'].pop('wasm_bundle')
        with self.assertRaises(ValueError):ci.validate_request(bad)

    def test_native_cosmos_cannot_acquire_cw_bundle_or_static_release(self):
        ci,request=self.selector('cosmosnative');request['prerequisites'].pop('wasm_bundle')
        request['prerequisites']['native_cli']={'name':'hypd','architecture':'amd64','source_url':'https://github.com/bcp-innovations/hyperlane-cosmos/releases/download/fixture/hypd','bytes':10,'sha256':'f'*64}
        ci.validate_request(request);request['prerequisites']['wasm_bundle']={}
        with self.assertRaises(ValueError):ci.validate_request(request)

    def test_cli_publisher_release_and_platform_are_exact(self):
        row={'name':'osmosisd','architecture':'amd64',**a.CLI_RELEASE['amd64']};a.validate_cli_policy(row,'amd64')
        for field,value in [('sha256','0'*64),('source_url',row['source_url'].replace('v20.5.0','v21.0.0')),('architecture','arm64'),('bytes',1)]:
            with self.subTest(field=field),self.assertRaises(ValueError):a.validate_cli_policy({**row,field:value},'amd64')


if __name__=='__main__':unittest.main()
