"""Pure Linux Tron assets/closure controls; no SDK/CLI/native/network execution."""
import copy,importlib.util,json,os,pathlib,struct,tempfile,unittest
from unittest import mock
spec=importlib.util.spec_from_file_location('native_tron_assets',pathlib.Path(__file__).with_name('native_tron_assets.py'));a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
class Assets(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=pathlib.Path(self.tmp.name).resolve()
  # Pure small-copy fixtures model ample capacity; production6GiB checks stay real.
  usage=__import__('shutil').disk_usage(self.root);capacity=mock.patch.object(a.shutil,'disk_usage',return_value=type(usage)(usage.total,usage.used,8*a.GIB));capacity.start();self.addCleanup(capacity.stop)
 def policy(self,arch='amd64'):
  return {'tron_cli':dict(a.CLI_POLICY),'tron_tre':{'schema':2,'architecture':arch,'source_image':a.SOURCE_IMAGE,'canonical_digest':a.SOURCE_IMAGE,'image_id':a.IMAGE_IDS[arch],'command':a.COMMAND,'entrypoint':None}}
 def image(self,arch='amd64'):
  return {'Id':a.IMAGE_IDS[arch],'Os':'linux','Architecture':arch,'RepoDigests':[a.SOURCE_IMAGE],'Config':{'Cmd':a.COMMAND,'Entrypoint':None,'Volumes':None}}
 def workspace(self):
  repo=self.root/'workspace';repo.mkdir();(repo/'node_modules').mkdir()
  for name in a.PACKAGE_ROOTS:
   path=repo/name;path.mkdir(parents=True,exist_ok=True);(path/'package.json').write_text(json.dumps({'name':'@fixture/'+path.name}))
  for name,data in [('typescript/cli/dist/cli.js',b'// not executable SDK data'),('solidity/dist/tron/typechain/factories/index.js',b'// actual fixture output'),('solidity/dist/buildArtifact.json',b'{}')]:
   path=repo/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
  cli=repo/'typescript/cli';(cli/'node_modules').mkdir();(cli/'src').mkdir();(cli/'src/version.ts').write_text("export const VERSION = '45.1.0';\n");(cli/'package.json').write_text(json.dumps({'name':'@hyperlane-xyz/cli','version':'45.1.0','scripts':{'hyperlane':'node ./dist/cli.js'}}));(repo/'package.json').write_text(json.dumps({'packageManager':'pnpm@12.3.0'}));(repo/'.nvmrc').write_text('26.12.1\n')
  for i,name in enumerate(['anvil1','anvil2']):
   path=cli/'test-configs/tron/chains'/name;path.mkdir(parents=True);(path/'metadata.yaml').write_text('chainId: 3360022319\ndomainId: '+str(1212538670+i)+'\nprotocol: tron\nrpcUrls:\n  - http: http://127.0.0.1:9090/jsonrpc\n');(path/'addresses.yaml').write_text('original registry')
  for name in a.ROOT_PAYLOADS:
   path=repo/name
   if not path.exists():
    if name in{'vectors','scripts','patches'}:path.mkdir()
    else:path.write_text('fixture root data')
  (repo/'node_modules/internal').symlink_to('../typescript/sdk');return repo
 def graph(self):return a.graph(self.workspace(),list(a.PACKAGE_ROOTS),'amd64')
 def test_exact_official_both_platforms(self):
  for arch in ['amd64','arm64']:self.assertEqual(a.validate_policy(self.policy(arch),arch)['image_id'],a.IMAGE_IDS[arch]);a.image_inspect([self.image(arch),self.image(arch)],self.policy(arch)['tron_tre'])
 def test_crossed_architecture_ID_digest_or_entrypoint_reject(self):
  for field,val in [('architecture','arm64'),('image_id',a.IMAGE_IDS['arm64']),('canonical_digest','tronbox/tre:2.0.0'),('entrypoint',['sh']),('command',['foreign'])]:
   p=self.policy();p['tron_tre'][field]=val
   with self.subTest(field=field),self.assertRaises(ValueError):a.validate_policy(p,'amd64')
 def test_CLI_version_full_build_and_compiler_policy_not_optional(self):
  for key,val in [('version','44.0.0'),('node_version','24.0.0'),('pnpm_version','10.0.0'),('full_original_tsconfig',False),('EVM_solc','0.8.24'),('TVM_solc','0.8.33'),('owned_full_package_graph',False)]:
   p=self.policy();p['tron_cli'][key]=val
   with self.subTest(key=key),self.assertRaises(ValueError):a.validate_policy(p,'amd64')
 def test_real_image_readback_not_manifest_or_Mac_alias(self):
  for key,val in [('Id','sha256:'+'a'*64),('Os','darwin'),('Architecture','arm64'),('RepoDigests',[])]:
   r=self.image();r[key]=val
   with self.subTest(key=key),self.assertRaises(ValueError):a.image_inspect([r,r],self.policy()['tron_tre'])
 def test_image_missing_second_inspect_or_unaccounted_volume_reject(self):
  with self.assertRaises(ValueError):a.image_inspect([self.image()],self.policy()['tron_tre'])
  r=self.image();r['Config']['Volumes']={'/data':{}}
  with self.assertRaises(ValueError):a.image_inspect([r,r],self.policy()['tron_tre'])
 def test_actual_source_CLI_and_two_chain_metadata(self):a.cli_source(self.workspace())
 def test_source_VERSION_never_rewritten(self):
  r=self.workspace();path=r/'typescript/cli/src/version.ts';path.write_text('old Source')
  with self.assertRaises(ValueError):a.cli_source(r)
  self.assertEqual(path.read_text(),'old Source')
 def test_source_wrong_chain_domain_port_rejects(self):
  r=self.workspace();p=r/'typescript/cli/test-configs/tron/chains/anvil2/metadata.yaml';p.write_text(p.read_text().replace('1212538671','9913371'))
  with self.assertRaises(ValueError):a.cli_source(r)
 def test_complete_graph_regular_bytes_and_internal_link(self):
  v=self.graph();self.assertEqual(v['entries']['node_modules/internal']['resolved'],'typescript/sdk');a.verify_graph(v);self.assertFalse(v['native_case_acceptance'])
 def test_partial_or_reordered_package_list_reject(self):
  r=self.workspace()
  for roots in [list(a.PACKAGE_ROOTS[:-1]),list(reversed(a.PACKAGE_ROOTS))]:
   with self.assertRaises(ValueError):a.graph(r,roots,'amd64')
 def test_foreign_borrowed_store_or_absolute_link_reject(self):
  r=self.workspace();p=r/'node_modules/internal';p.unlink();p.symlink_to('/private/tmp')
  with self.assertRaises(ValueError):a.graph(r,list(a.PACKAGE_ROOTS),'amd64')
 def test_dangling_dependency_reject(self):
  r=self.workspace();(r/'node_modules/missing').symlink_to('absent')
  with self.assertRaises((ValueError,FileNotFoundError)):a.graph(r,list(a.PACKAGE_ROOTS),'amd64')
 def test_missing_CLI_EVM_or_TVM_output_reject(self):
  r=self.workspace();(r/'solidity/dist/buildArtifact.json').unlink()
  with self.assertRaises(ValueError):a.graph(r,list(a.PACKAGE_ROOTS),'amd64')
 def test_mutated_installed_package_rejected(self):
  v=self.graph();(pathlib.Path(v['root'])/'typescript/sdk/package.json').write_text('changed')
  with self.assertRaises(ValueError):a.verify_graph(v)
 def test_new_installed_package_rejected(self):
  v=self.graph();(pathlib.Path(v['root'])/'node_modules/injected.js').write_text('changed')
  with self.assertRaises(ValueError):a.verify_graph(v)
 def test_Darwin_payload_cannot_be_Linux_graph(self):
  r=self.workspace();(r/'node_modules/bad.node').write_bytes(b'\xcf\xfa\xed\xfe'+b'\0'*30)
  with self.assertRaises(ValueError):a.graph(r,list(a.PACKAGE_ROOTS),'amd64')
 def test_wrong_Linux_machine_rejects(self):
  r=self.workspace();header=bytearray(24);header[:6]=b'\x7fELF\x02\x01';struct.pack_into('<H',header,18,183);(r/'node_modules/bad.node').write_bytes(header)
  with self.assertRaises(ValueError):a.graph(r,list(a.PACKAGE_ROOTS),'amd64')
 def test_special_payload_rejects(self):
  r=self.workspace();os.mkfifo(r/'node_modules/pipe')
  with self.assertRaises(ValueError):a.graph(r,list(a.PACKAGE_ROOTS),'amd64')
 def test_owned_copy_never_aliases_source_and_only_two_registry_slots_mutate(self):
  v=self.graph();dest=self.root/'case';dest.mkdir();out=a.materialize(v,dest/'tron-cli',0);path=pathlib.Path(out['mutable_registry_slots'][0]);path.write_text('deployed addresses');a.verify_materialized(out);self.assertEqual((pathlib.Path(v['root'])/'typescript/cli'/a.MUTABLE_REGISTRY[0]).read_text(),'original registry');self.assertFalse((dest/'tron-cli/dist').is_symlink())
 def test_copy_collision_preserves_old_bytes(self):
  v=self.graph();d=self.root/'existing';d.mkdir();(d/'marker').write_text('preserve')
  with self.assertRaises(ValueError):a.materialize(v,d,0)
  self.assertEqual((d/'marker').read_text(),'preserve')
 def test_conservative_existing_case_charge_fails_before_copy(self):
  v=self.graph();d=self.root/'oversized'
  with self.assertRaises(ValueError):a.materialize(v,d,4*a.GIB)
  self.assertFalse(d.exists())
 def test_changed_copied_SDK_or_new_root_dist_rejects(self):
  v=self.graph();out=a.materialize(v,self.root/'tron-cli',0);(self.root/'tron-cli/dist/injected.js').write_text('new')
  with self.assertRaises(ValueError):a.verify_materialized(out)
 def actual_SBF(self):
  source=pathlib.Path(__file__).resolve().parents[2]/'typescript/svm-sdk/src/testing/fixtures/spl_token_2022_v10.so';return source.read_bytes()
 def test_exact_tracked_SBF_fixture_remains_data_and_closed_graph_member(self):
  r=self.workspace();relative=next(iter(a.SOURCE_SBF_DATA));p=r/relative;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(self.actual_SBF());p.chmod(0o644);value=a.graph(r,list(a.PACKAGE_ROOTS),'amd64');self.assertTrue(value['entries'][relative]['Source_SBF_data_only']);self.assertEqual(value['entries'][relative]['mode'],0o644);a.verify_graph(value)
 def test_Source_SBF_exception_cannot_authorize_host_otherpath_bytes_or_mode(self):
  raw=self.actual_SBF();r=self.workspace()
  for changed,mode,path in [(raw+b'changed',0o644,next(iter(a.SOURCE_SBF_DATA))),(raw,0o755,next(iter(a.SOURCE_SBF_DATA))),(raw,0o644,'node_modules/foreign.so')]:
   p=r/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(changed);p.chmod(mode)
   with self.subTest(path=path,mode=mode),self.assertRaises(ValueError):a.graph(r,list(a.PACKAGE_ROOTS),'amd64')
   p.unlink()
 def test_source_data_classification_never_waives_exact_header(self):
  relative=next(iter(a.SOURCE_SBF_DATA));policy=a.SOURCE_SBF_DATA[relative];row={'bytes':policy['bytes'],'sha256':policy['sha256']};raw=self.actual_SBF()[:20]
  for offset,value in [(4,1),(5,2),(7,3),(16,2),(18,247)]:
   header=bytearray(raw);header[offset]=value
   with self.subTest(offset=offset),self.assertRaises(ValueError):a.source_SBF_data(relative,row,0o100644,header)
 def test_foreign_payload_diagnostic_retains_exact_public_path_header_and_hash(self):
  r=self.workspace();header=bytearray(24);header[:6]=b'\x7fELF\x02\x01';struct.pack_into('<H',header,18,183);p=r/'node_modules/bad.node';p.write_bytes(header)
  with self.assertRaisesRegex(ValueError,'Foreign native dependency payload')as caught:a.graph(r,list(a.PACKAGE_ROOTS),'amd64')
  value=json.loads(str(caught.exception).split(': ',1)[1]);self.assertEqual(value['path'],'node_modules/bad.node');self.assertEqual(value['ELF_machine'],183);self.assertEqual(value['header20_hex'],header[:20].hex());self.assertEqual(value['sha256'],a.pin(p)['sha256'])
 def prebuild_fixture(self,platform='darwin',payload=b'\xcf\xfa\xed\xfe'+b'0'*20):
  import hashlib
  r=self.workspace();base='node_modules/.pnpm/bufferutil@4.1.0/node_modules/bufferutil';relative=base+'/prebuilds/'+platform+'-x64/fixture.node';p=r/relative;p.parent.mkdir(parents=True);p.write_bytes(payload);p.chmod(0o644);files={}
  for name,body in [('package.json',b'public package fixture'),('index.js',b'public selector fixture')]:
   q=r/base/name;q.write_bytes(body);row=a.pin(q);files[name]={'bytes':row['bytes'],'sha256':row['sha256']}
  row=a.pin(p);policy={'package':'bufferutil@4.1.0','platform':platform,'architectures':['x64'],'bytes':row['bytes'],'sha256':row['sha256'],'header20_hex':payload[:20].hex(),'mode':0o644};loaders={'bufferutil@4.1.0':{'root':base,'files':files}};return r,relative,policy,loaders
 def test_exact_unselected_platform_prebuild_is_pinned_data_not_native_authority(self):
  r,relative,policy,loaders=self.prebuild_fixture()
  with mock.patch.dict(a.NPM_PREBUILD_DATA,{relative:policy},clear=True),mock.patch.dict(a.NPM_PREBUILD_LOADERS,loaders,clear=True):
   value=a.graph(r,list(a.PACKAGE_ROOTS),'amd64');self.assertTrue(value['entries'][relative]['unselected_Source_locked_platform_data']);a.verify_graph(value)
   (r/relative).write_bytes((r/relative).read_bytes()+b'changed')
   with self.assertRaises(ValueError):a.verify_graph(value)
 def test_platform_data_requires_exact_path_payload_mode_and_pinned_selector(self):
  r,relative,policy,loaders=self.prebuild_fixture();p=r/relative
  with mock.patch.dict(a.NPM_PREBUILD_DATA,{relative:policy},clear=True),mock.patch.dict(a.NPM_PREBUILD_LOADERS,loaders,clear=True):
   p.chmod(0o755)
   with self.assertRaises(ValueError):a.graph(r,list(a.PACKAGE_ROOTS),'amd64')
   p.chmod(0o644);selector=r/loaders['bufferutil@4.1.0']['root']/'index.js';selector.write_bytes(b'changed loader')
   with self.assertRaises(ValueError):a.graph(r,list(a.PACKAGE_ROOTS),'amd64')
  moved=p.with_name('unknown.node');p.rename(moved)
  with self.assertRaises(ValueError):a.graph(r,list(a.PACKAGE_ROOTS),'amd64')
 def test_current_host_platform_prebuild_never_bypasses_native_ELF_guard(self):
  header=bytearray(24);header[:6]=b'\x7fELF\x02\x01';struct.pack_into('<H',header,18,183);r,relative,policy,loaders=self.prebuild_fixture('linux',bytes(header))
  with mock.patch.dict(a.NPM_PREBUILD_DATA,{relative:policy},clear=True),mock.patch.dict(a.NPM_PREBUILD_LOADERS,loaders,clear=True),self.assertRaisesRegex(ValueError,'Foreign native'):a.graph(r,list(a.PACKAGE_ROOTS),'amd64')
 def test_current_host_valid_prebuild_is_native_and_never_marked_foreign_data(self):
  header=bytearray(24);header[:6]=b'\x7fELF\x02\x01';struct.pack_into('<H',header,18,62);r,relative,policy,loaders=self.prebuild_fixture('linux',bytes(header))
  with mock.patch.dict(a.NPM_PREBUILD_DATA,{relative:policy},clear=True),mock.patch.dict(a.NPM_PREBUILD_LOADERS,loaders,clear=True):
   value=a.graph(r,list(a.PACKAGE_ROOTS),'amd64');self.assertNotIn('unselected_Source_locked_platform_data',value['entries'][relative]);a.verify_graph(value)
 def test_actual_materializer_still_rejects_below_sixGiB_before_copy(self):
  v=self.graph();destination=self.root/'floor-rejected';usage=__import__('shutil').disk_usage(self.root)
  with mock.patch.object(a.shutil,'disk_usage',return_value=type(usage)(usage.total,usage.used,5*a.GIB)),self.assertRaisesRegex(ValueError,'preserve6GiB'):a.materialize(v,destination,0)
  self.assertFalse(destination.exists())
class Custody(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.case=pathlib.Path(self.tmp.name).resolve();self.out=self.case/'output';self.out.mkdir()
  spec=importlib.util.spec_from_file_location('tron_custody',pathlib.Path(__file__).with_name('native_tron_custody.py'));self.c=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.c)
  self.fixture={'architecture':'amd64','source_image':a.SOURCE_IMAGE,'canonical_digest':a.SOURCE_IMAGE,'image_id':a.IMAGE_IDS['amd64'],'run_token':'b'*32,'command':a.COMMAND,'entrypoint':None,'cli_directory':str(self.case/'tron-cli'),'cli_entrypoint':{'path':str(self.case/'tron-cli/dist/cli.js'),'bytes':1,'sha256':'c'*64},'pnpm':{'path':'/owned/pnpm','bytes':1,'sha256':'c'*64}}
  self.calls=[];self.current=None
  self.custody=self.c.Custody(self.case,42,'linux-ticks:123',self.fixture,self.out,self.call)
 def call(self,args,missing=False,cleaning=False):
  self.calls.append((args,missing,cleaning))
  if args[:2]==['container','inspect']:return None if self.current is None else json.dumps([self.current])
  if args[:2]==['container','stop']:self.current['State']['Running']=False;return ''
  if args[:2]==['container','rm']:self.current=None;return ''
  raise AssertionError(args)
 def row(self):
  return {'Id':'c'*64,'Name':'/'+self.c.expected_name(self.case,42,9090),'Image':self.fixture['image_id'],'Config':{'Image':self.fixture['image_id'],'Labels':{self.c.LABEL_ROOT:__import__('hashlib').sha256(os.fsencode(self.case)).hexdigest(),self.c.LABEL_PID:'42',self.c.LABEL_TOKEN:'b'*32},'Cmd':a.COMMAND,'Entrypoint':None,'Env':['block=allowTvmCompatibleEvm:1','preapprove=allowTvmCompatibleEvm:1','mnemonic=abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',"hdPath=m/44'/195'/0'/0/",'defaultBalance=1000000']},'State':{'Running':True},'HostConfig':{'Memory':3*a.GIB,'MemorySwap':3*a.GIB,'NanoCpus':2_000_000_000,'PidsLimit':256,'PortBindings':{'9090/tcp':[{'HostIp':'127.0.0.1','HostPort':'9090'}]}},'NetworkSettings':{'Ports':{'9090/tcp':[{'HostIp':'127.0.0.1','HostPort':'9090'}]}},'Mounts':[],'SizeRw':100}
 def arm(self):self.custody.arm();self.current=self.row()
 def test_absence_armed_before_creation_and_first_CID_immutable(self):
  self.arm();self.custody.observe();p=self.out/'tron-9090-cid.json';inode=p.stat().st_ino;self.custody.observe();self.assertEqual(inode,p.stat().st_ino);self.assertEqual(self.custody.ready,{9090:'c'*64})
 def test_existing_name_is_never_claimed_or_stopped(self):
  self.current=self.row()
  with self.assertRaises(ValueError):self.custody.arm()
  self.assertTrue(all(c[0][:2]==['container','inspect']for c in self.calls))
 def test_foreign_image_name_label_or_replaced_CID_never_mutated(self):
  self.arm();self.custody.observe()
  for key,value in [('Id','d'*64),('Image','sha256:'+'d'*64),('Name','/foreign')]:
   row=self.row();row[key]=value;self.current=row
   with self.subTest(key=key),self.assertRaises(ValueError):self.custody.inspect(9090,cleaning=True)
  self.current=self.row();self.current['Config']['Labels'][self.c.LABEL_TOKEN]='foreign'
  with self.assertRaises(ValueError):self.custody.inspect(9090,cleaning=True)
  self.assertTrue(all(c[0][:2]==['container','inspect']for c in self.calls))
 def test_bad_caps_retain_CID_and_authorize_cleanup_without_success_credit(self):
  self.arm();self.current['HostConfig']['Memory']=0
  with self.assertRaises(ValueError):self.custody.observe()
  self.assertTrue((self.out/'tron-9090-cid.json').exists());report=self.custody.cleanup();self.assertTrue(report['container_absent']);self.assertEqual(report['containers'][0]['container_id'],'c'*64);self.assertFalse(report['native_parent_wait_credit'])
 def test_unhealthy_config_or_env_never_readiness(self):
  self.arm();self.current['Config']['Env'].append('defaultBalance=1')
  with self.assertRaises(ValueError):self.custody.observe()
  self.assertFalse(self.custody.ready)
 def test_global_or_wrong_port_mapping_rejects(self):
  self.arm();self.current['HostConfig']['PortBindings']['9090/tcp'][0]['HostIp']='0.0.0.0'
  with self.assertRaises(ValueError):self.custody.observe()
 def test_unaccounted_mount_or_missing_writable_size_reject(self):
  self.arm();self.current['Mounts']=[{'Destination':'/data'}]
  with self.assertRaises(ValueError):self.custody.observe()
  self.current=self.row();self.current.pop('SizeRw')
  with self.assertRaises(ValueError):self.custody.observe()
 def test_unplanned_disappearance_is_not_clean_native_stop(self):
  self.arm();self.custody.observe();self.current=None
  with self.assertRaises(ValueError):self.custody.observe()
 def test_exact_planned_Stop_intent_requires_pre_stop_positive_identity(self):
  self.arm();self.custody.observe();path=self.case/'evidence';path.mkdir();intent={'kind':'tron','port':9090,'container_id':'c'*64,'parent_pid':42,'pid':99,'pre_stop_live_identity':'linux-ticks:55','acceptance_failed_before_cleanup':False};(path/'fixture-container-stop-intents.jsonl').write_text(json.dumps(intent)+'\n');self.current=None;self.custody.observe();self.assertTrue(self.custody.cleanup()['container_absent'])
 def test_malformed_first_CID_fails_without_name_mutation(self):
  self.arm();(self.out/'tron-9090-cid.json').write_text('{');report=self.custody.cleanup();self.assertFalse(report['container_absent']);self.assertFalse(any(c[0][:2]in[['container','stop'],['container','rm']]for c in self.calls))
 def test_host_and_container_caps_and_daemon_writable_charge(self):
  self.assertEqual(self.c.resource_charge(2*a.GIB,100,10*a.GIB,10*a.GIB,200),(6*a.GIB,2*a.GIB+300));self.assertEqual(self.c.resource_charge(0,100,10*a.GIB,7*a.GIB,200)[1],5*a.GIB)
 def test_Rust_fixture_schema_has_no_invented_schema_or_Kathy(self):
  changed=dict(self.fixture,schema=2)
  with self.assertRaises(ValueError):self.c.Custody(self.case,42,'linux-ticks:123',changed,self.out,self.call)
  with self.assertRaises(ValueError):self.c.expected_name(self.case,42,8545)

class NativePackage(unittest.TestCase):
 def test_exact_member_bytes_platform_and_archive_no_native_execution(self):
  import hashlib,io,tarfile
  spec=importlib.util.spec_from_file_location('tron_setup',pathlib.Path(__file__).with_name('native_tron_setup.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
  payload=bytearray(24);payload[:6]=b'\x7fELF\x02\x01';struct.pack_into('<H',payload,18,62);payload=bytes(payload);stream=io.BytesIO()
  with tarfile.open(fileobj=stream,mode='w:gz')as archive:
   for name,body in [('package/pnpm',payload),('package/package.json',json.dumps({'name':'@pnpm/exe.linux-x64','version':'12.3.0','os':['linux'],'libc':['glibc']}).encode()),('package/LICENSE',b'fixture'),('package/THIRD-PARTY-NOTICES.md',b'fixture')]:
    row=tarfile.TarInfo(name);row.size=len(body);archive.addfile(row,io.BytesIO(body))
  blob=stream.getvalue();policy={'archive_bytes':len(blob),'archive_sha256':hashlib.sha256(blob).hexdigest(),'member':'package/pnpm','bytes':len(payload),'sha256':hashlib.sha256(payload).hexdigest()}
  with mock.patch.dict(m.PNPM_RELEASE,amd64=policy):
   self.assertEqual(m.pnpm_member(blob,'amd64'),payload)
   with self.assertRaises(ValueError):m.pnpm_member(blob+b'changed','amd64')
   with self.assertRaises(ValueError):m.pnpm_member(blob,'arm64')
if __name__=='__main__':unittest.main(verbosity=2)
