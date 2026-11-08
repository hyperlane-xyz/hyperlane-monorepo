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
  for name,data in [('typescript/cli/dist/cli.js',b"try { publicFixture(); }\ncatch (error) {\n    errorRed('Error: ' + error.message);\n    process.exit(1);\n}\n"),('solidity/dist/tron/typechain/factories/index.js',b'// actual fixture output'),('solidity/dist/buildArtifact.json',b'{}')]:
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
 def EDR_fixture(self):
  repo=self.workspace();relative='node_modules/locked-edr/guest.node';payload=b'\xcf\xfa\xed\xfe'+b'\0'*16;path=repo/relative;path.parent.mkdir();path.write_bytes(payload)
  loader={'root':'node_modules/locked-loader','files':{}}
  for name,data in [('index.js',b'platform then architecture then libc selector'),('package.json',b'locked root manifest')]:
   file=repo/loader['root']/name;file.parent.mkdir(exist_ok=True);file.write_bytes(data);loader['files'][name]={key:a.pin(file)[key]for key in ['bytes','sha256']}
  manifest=path.parent/'package.json';manifest.write_bytes(b'locked platform manifest')
  policy={relative:{'platform':'darwin','architecture':'arm64','bytes':len(payload),'sha256':a.pin(path)['sha256'],'header20_hex':payload.hex(),'package_manifest':str(manifest.relative_to(repo)),'package_manifest_pin':{key:a.pin(manifest)[key]for key in ['bytes','sha256']}}}
  return repo,relative,path,payload,loader,policy
 def test_Source_EDR_policy_is_exact_seven_platform_members_and_host_Linux_not_data(self):
  self.assertEqual(len(a.NPM_EDR_DATA),7)
  for relative,policy in a.NPM_EDR_DATA.items():
   self.assertIn('@0.12.0-next.23/node_modules/@nomicfoundation/edr-',relative);self.assertEqual(len(policy['sha256']),64)
   if policy['platform']=='linux':
    self.assertFalse(a.unselected_EDR_data(pathlib.Path('/ABSENT'),relative,{},0,b'',policy['architecture']))
 def test_exact_dormant_EDR_graph_retains_data_and_rechecks_every_byte(self):
  repo,relative,path,payload,loader,policy=self.EDR_fixture()
  with mock.patch.object(a,'NPM_EDR_DATA',policy),mock.patch.object(a,'NPM_EDR_LOADER',loader):
   graph=a.graph(repo,list(a.PACKAGE_ROOTS),'amd64');self.assertTrue(graph['entries'][relative]['unselected_Source_locked_platform_data']);self.assertEqual(graph['entries'][relative]['sha256'],a.pin(path)['sha256']);a.verify_graph(graph)
   path.write_bytes(payload+b'changed')
   with self.assertRaises(ValueError):a.verify_graph(graph)
 def test_dormant_EDR_rejects_loader_package_mode_hash_header_or_unknown_path(self):
  repo,relative,path,payload,loader,policy=self.EDR_fixture()
  with mock.patch.object(a,'NPM_EDR_DATA',policy),mock.patch.object(a,'NPM_EDR_LOADER',loader):
   self.assertTrue(a.unselected_EDR_data(repo,relative,a.pin(path),path.stat().st_mode,payload,'amd64'))
   for mode,header,row in [(0o755,payload,a.pin(path)),(0o644,b'foreign-header',a.pin(path)),(0o644,payload,{**a.pin(path),'sha256':'a'*64})]:
    with self.assertRaises(ValueError):a.unselected_EDR_data(repo,relative,row,mode,header,'amd64')
   self.assertFalse(a.unselected_EDR_data(repo,relative+'foreign',a.pin(path),0o644,payload,'amd64'))
   for target in [repo/loader['root']/'index.js',repo/policy[relative]['package_manifest']]:
    original=target.read_bytes();target.write_bytes(b'changed')
    with self.assertRaises(ValueError):a.unselected_EDR_data(repo,relative,a.pin(path),0o644,payload,'amd64')
    target.write_bytes(original)
 def test_EDR_host_branch_cannot_use_dormant_MachO_exemption(self):
  repo,relative,path,payload,loader,policy=self.EDR_fixture();policy[relative]['platform']='linux';policy[relative]['architecture']='amd64'
  with mock.patch.object(a,'NPM_EDR_DATA',policy),mock.patch.object(a,'NPM_EDR_LOADER',loader):
   with self.assertRaisesRegex(ValueError,'Mac executable'):a.graph(repo,list(a.PACKAGE_ROOTS),'amd64')
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
  v=self.graph();dest=self.root/'case';dest.mkdir();out=a.materialize(v,dest/'tron-cli',0,8*a.GIB);path=pathlib.Path(out['mutable_registry_slots'][0]);path.write_text('deployed addresses');a.verify_materialized(out);self.assertEqual((pathlib.Path(v['root'])/'typescript/cli'/a.MUTABLE_REGISTRY[0]).read_text(),'original registry');self.assertFalse((dest/'tron-cli/dist').is_symlink())
 def test_copy_collision_preserves_old_bytes(self):
  v=self.graph();d=self.root/'existing';d.mkdir();(d/'marker').write_text('preserve')
  with self.assertRaises(ValueError):a.materialize(v,d,0,8*a.GIB)
  self.assertEqual((d/'marker').read_text(),'preserve')
 def test_copy_charge_formula_unchanged_and_public_breakdown_scalar_only(self):
  value=self.graph()
  for fragment in [1,4096,65536]:
   charge=a.copy_charge(value,fragment);note=a.copy_allocation_note(value,fragment,123,charge,8*a.GIB,8*a.GIB);self.assertTrue(note.startswith('PUBLIC_TRON_COPY_ALLOCATION '));self.assertLessEqual(len(note.encode()),4096);self.assertNotIn(str(self.root),note)
   d=json.loads(note.split(' ',1)[1]);self.assertTrue(all(type(v)is int for v in d.values()));self.assertEqual(d['graph_payload_charge_bytes']+d['duplicate_entrypoint_charge_bytes']+d['root_directory_charge_bytes']+d['metadata_reserve_bytes']+d['diagnostic_entry_growth_charge_bytes'],charge);self.assertEqual(d['root_directory_charge_bytes'],32*fragment);self.assertEqual(d['metadata_reserve_bytes'],256*1024**2);self.assertEqual(d['PG_reservation_bytes'],2*a.GIB);self.assertEqual(d['final_required_bytes'],123+charge+2*a.GIB);self.assertEqual(d['original_case_cap_bytes'],8*a.GIB)
 def test_actual_precopy_guard_preserves_message_and_adds_existing_numeric_note(self):
  value=self.graph();destination=self.root/'oversized-numeric';fragment=os.statvfs(self.root).f_frsize;charge=a.copy_charge(value,fragment)
  with self.assertRaises(ValueError)as caught:a.materialize(value,destination,8*a.GIB,8*a.GIB)
  self.assertEqual(str(caught.exception),'Existing case/CLI allocation/metadata plus2GiB PG tmpfs exceeds reviewed native case cap');self.assertFalse(destination.exists());self.assertEqual(len(caught.exception.__notes__),1)
  d=json.loads(caught.exception.__notes__[0].split(' ',1)[1]);self.assertEqual(d['filesystem_fragment_bytes'],fragment);self.assertEqual(d['existing_case_allocated_bytes'],8*a.GIB);self.assertEqual(d['copy_charge_bytes'],charge);self.assertEqual(d['observed_host_free_bytes'],8*a.GIB)
 def test_copy_note_failure_cannot_replace_or_heal_original_guard(self):
  value=self.graph();destination=self.root/'note-failure'
  with mock.patch.object(a,'copy_allocation_note',side_effect=RuntimeError('synthetic-diagnostic-failure')),self.assertRaises(ValueError)as caught:a.materialize(value,destination,8*a.GIB,8*a.GIB)
  self.assertEqual(str(caught.exception),'Existing case/CLI allocation/metadata plus2GiB PG tmpfs exceeds reviewed native case cap');self.assertFalse(hasattr(caught.exception,'__notes__'));self.assertFalse(destination.exists())
 def test_actual_success_has_no_note_or_extra_filesystem_observation(self):
  value=self.graph();destination=self.root/'successful-copy';statvfs=os.statvfs;observed=[]
  def counted(path):observed.append(path);return statvfs(path)
  with mock.patch.object(a,'copy_allocation_note',side_effect=AssertionError('success diagnostics reached')),mock.patch.object(a.os,'statvfs',side_effect=counted),mock.patch.object(a.shutil,'disk_usage',return_value=type('Usage',(),{'free':8*a.GIB})())as usage:a.materialize(value,destination,0,8*a.GIB)
  self.assertEqual(observed,[destination.parent]);usage.assert_called_once_with(destination.parent)
 def test_floor_refusal_note_uses_same_single_observed_capacity(self):
  value=self.graph();destination=self.root/'low-free';usage=type('Usage',(),{'free':5*a.GIB})()
  with mock.patch.object(a.shutil,'disk_usage',return_value=usage)as observed,self.assertRaises(ValueError)as caught:a.materialize(value,destination,0,8*a.GIB)
  self.assertEqual(str(caught.exception),'Full owned CLI copies must preserve6GiB floor');d=json.loads(caught.exception.__notes__[0].split(' ',1)[1]);self.assertEqual(d['observed_host_free_bytes'],5*a.GIB);self.assertEqual(d['host_free_floor_bytes'],6*a.GIB);self.assertFalse(destination.exists());observed.assert_called_once_with(destination.parent)
 def test_conservative_existing_case_charge_fails_before_copy(self):
  v=self.graph();d=self.root/'oversized'
  with self.assertRaises(ValueError):a.materialize(v,d,8*a.GIB,8*a.GIB)
  self.assertFalse(d.exists())
 def test_explicit_native_case8_allows_complete_small_graph_above_old4(self):
  value=self.graph();destination=self.root/'above-old-cap';existing=4*a.GIB
  charge=a.copy_charge(value,os.statvfs(self.root).f_frsize);self.assertGreater(existing+charge+2*a.GIB,4*a.GIB);self.assertLess(existing+charge+2*a.GIB,8*a.GIB)
  copied=a.materialize(value,destination,existing,8*a.GIB);a.verify_materialized(copied);self.assertEqual(a.MAX_BYTES,4*a.GIB)
 def test_exact_native_cap_boundary_and_unknown_policy_fail_closed(self):
  value=self.graph();charge=a.copy_charge(value,os.statvfs(self.root).f_frsize)
  a.materialize(value,self.root/'exact-cap',8*a.GIB-2*a.GIB-charge,8*a.GIB)
  with self.assertRaisesRegex(ValueError,'exceeds reviewed'):a.materialize(value,self.root/'cap-plus1',8*a.GIB-2*a.GIB-charge+1,8*a.GIB)
  for cap in [4*a.GIB,9*a.GIB,True,float(8*a.GIB)]:
   with mock.patch.object(a,'verify_graph',side_effect=AssertionError('invalid policy reached graph')),self.assertRaisesRegex(ValueError,'Exact reviewed8GiB'):a.materialize(value,self.root/'unknown-cap',0,cap)

 def test_changed_copied_SDK_or_new_root_dist_rejects(self):
  v=self.graph();out=a.materialize(v,self.root/'tron-cli',0,8*a.GIB);(self.root/'tron-cli/dist/injected.js').write_text('new')
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
  report=json.loads(str(caught.exception).split(': ',1)[1]);self.assertTrue(report['complete']);self.assertFalse(report['admission']);self.assertEqual(report['count'],1);value=report['entries'][0];self.assertEqual(value['path'],'node_modules/bad.node');self.assertEqual(value['ELF_machine'],183);self.assertEqual(value['header20_hex'],header[:20].hex());self.assertEqual(value['sha256'],a.pin(p)['sha256'])
 def unsupported(self,repo):
  with self.assertRaisesRegex(ValueError,'Unsupported native dependency payload inventory: ')as caught:a.graph(repo,list(a.PACKAGE_ROOTS),'amd64')
  return json.loads(str(caught.exception).split(': ',1)[1])
 def test_inventory_reports_all_unknown_members_before_refusing(self):
  repo=self.workspace();arm=bytearray(24);arm[:6]=b'\x7fELF\x01\x01';struct.pack_into('<H',arm,18,40)
  samples={'a-android.bare':bytes(arm),'b-macos.bare':b'\xcf\xfa\xed\xfe'+b'not exported body','c-invalid.node':b'MZ'+b'not exported body','d-arm64.node':b'\x7fELF\x02\x01'+b'\0'*12+b'\xb7\0'+b'\0'*4}
  for name,raw in samples.items():(repo/'node_modules'/name).write_bytes(raw)
  report=self.unsupported(repo);self.assertEqual(report['count'],4);self.assertTrue(report['complete']);self.assertFalse(report['native_case_acceptance']);self.assertEqual([r['path']for r in report['entries']],['node_modules/'+n for n in sorted(samples)])
  for row in report['entries']:
   self.assertEqual(set(row),{'path','bytes','sha256','header20_hex','ELF_class','ELF_endian','ELF_machine','mode','reasons'});path=repo/row['path'];self.assertEqual(row['sha256'],a.pin(path)['sha256']);self.assertEqual(row['bytes'],path.stat().st_size)
  self.assertNotIn('not exported body',json.dumps(report))
 def test_inventory_does_not_waive_materialization_or_admission(self):
  repo=self.workspace();(repo/'node_modules/guest.node').write_bytes(b'MZ'+b'\0'*30);dest=self.root/'must-not-materialize'
  with self.assertRaises(ValueError):a.materialize(a.graph(repo,list(a.PACKAGE_ROOTS),'amd64'),dest,0,8*a.GIB)
  self.assertFalse(dest.exists())
 def test_inventory_preserves_unsafe_link_immediate_failure(self):
  repo=self.workspace();(repo/'node_modules/a.node').write_bytes(b'not ELF');(repo/'node_modules/z-link').symlink_to('/foreign')
  with self.assertRaisesRegex(ValueError,'External/absolute/dangling')as caught:a.graph(repo,list(a.PACKAGE_ROOTS),'amd64')
  self.assertNotIn('complete=true',str(caught.exception))
 def test_inventory_bound_refuses_incomplete_diagnostic_never_graph(self):
  repo=self.workspace()
  for name in ['a.node','b.node','c.node']:(repo/'node_modules'/name).write_bytes(b'not ELF')
  with mock.patch.object(a,'MAX_UNSUPPORTED_ROWS',2),self.assertRaisesRegex(ValueError,'complete=false; admission=false'):a.graph(repo,list(a.PACKAGE_ROOTS),'amd64')
 def test_inventory_empty_keeps_valid_host_ELF_in_normal_graph(self):
  repo=self.workspace();raw=bytearray(24);raw[:6]=b'\x7fELF\x02\x01';struct.pack_into('<H',raw,18,62);path=repo/'node_modules/host.node';path.write_bytes(raw)
  graph=a.graph(repo,list(a.PACKAGE_ROOTS),'amd64');self.assertFalse(graph['native_case_acceptance']);self.assertEqual(graph['entries']['node_modules/host.node']['sha256'],a.pin(path)['sha256']);self.assertNotIn('unsupported',graph);a.verify_graph(graph)
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
  with mock.patch.object(a.shutil,'disk_usage',return_value=type(usage)(usage.total,usage.used,5*a.GIB)),self.assertRaisesRegex(ValueError,'preserve6GiB'):a.materialize(v,destination,0,8*a.GIB)
  self.assertFalse(destination.exists())
 def bigint_rows(self):
  return {name:row for name,row in a.NPM_PREBUILD_DATA.items()if row['package']=='@trufflesuite/bigint-buffer@1.1.9'}
 def bigint_loader_pins(self):
  repo=pathlib.Path('/OWNED/closed-workspace');loader=a.NPM_PREBUILD_LOADERS['@trufflesuite/bigint-buffer@1.1.9'];pins={repo/loader['root']/name:dict(row)for name,row in loader['files'].items()}
  return repo,pins
 def test_bigint_all_published_prebuilds_have_finite_platform_selection(self):
  rows=self.bigint_rows();self.assertEqual(len(rows),3);self.assertEqual({p.split('/prebuilds/')[1]for p in rows},{'darwin-x64/node.napi.node','linux-x64/node.napi.node','win32-x64/node.napi.node'})
  self.assertEqual({row['platform']for row in rows.values()},{'darwin','linux','win32'})
  self.assertTrue(all(row['architectures']==['x64']and row['mode']==0o644 for row in rows.values()))
 def test_bigint_exact_rows_bind_actual_both_package_and_selector_sources(self):
  repo,pins=self.bigint_loader_pins();self.assertEqual(len(pins),4)
  self.assertTrue(any('@trufflesuite+bigint-buffer@1.1.9/node_modules/node-gyp-build' in str(p)and p.name=='index.js'for p in pins));self.assertTrue(any(p.name=='node.js'for p in pins))
  for relative,policy in self.bigint_rows().items():
   with self.subTest(platform=policy['platform']),mock.patch.object(a,'pin',side_effect=lambda p:dict(pins[p]))as check:
    self.assertEqual(a.unselected_prebuild_data(repo,relative,policy,0o100644,bytes.fromhex(policy['header20_hex']),'amd64'),policy['platform']!='linux');self.assertEqual({call.args[0]for call in check.call_args_list},set(pins))
 def test_bigint_linux_x64_is_data_only_on_other_architecture(self):
  repo,pins=self.bigint_loader_pins();relative,policy=next((p,r)for p,r in self.bigint_rows().items()if r['platform']=='linux')
  with mock.patch.object(a,'pin',side_effect=lambda p:dict(pins[p])):
   self.assertFalse(a.unselected_prebuild_data(repo,relative,policy,0o644,bytes.fromhex(policy['header20_hex']),'amd64'))
   self.assertTrue(a.unselected_prebuild_data(repo,relative,policy,0o644,bytes.fromhex(policy['header20_hex']),'arm64'))
 def test_bigint_every_payload_pin_mode_and_header_is_mandatory(self):
  repo,pins=self.bigint_loader_pins()
  for relative,policy in self.bigint_rows().items():
   header=bytes.fromhex(policy['header20_hex'])
   for row,mode,raw in [(dict(policy,bytes=policy['bytes']+1),0o644,header),(dict(policy,sha256='0'*64),0o644,header),(policy,0o664,header),(policy,0o755,header),(policy,0o644,bytes([header[0]^1])+header[1:])]:
    with self.subTest(platform=policy['platform'],mode=mode),mock.patch.object(a,'pin',side_effect=lambda p:dict(pins[p])),self.assertRaisesRegex(ValueError,'Exact Source-locked prebuild'):a.unselected_prebuild_data(repo,relative,row,mode,raw,'amd64')
 def test_bigint_each_of_four_loader_source_pins_is_mandatory(self):
  repo,pins=self.bigint_loader_pins();relative,policy=next((p,r)for p,r in self.bigint_rows().items()if r['platform']=='darwin')
  for target in pins:
   for field,value in [('bytes',pins[target]['bytes']+1),('sha256','0'*64)]:
    changed=copy.deepcopy(pins);changed[target][field]=value
    with self.subTest(target=str(target),field=field),mock.patch.object(a,'pin',side_effect=lambda p:dict(changed[p])),self.assertRaisesRegex(ValueError,'platform-selecting package loader changed'):a.unselected_prebuild_data(repo,relative,policy,0o644,bytes.fromhex(policy['header20_hex']),'amd64')
 def test_bigint_unknown_path_has_no_data_authority(self):
  repo,pins=self.bigint_loader_pins();relative,policy=next(iter(self.bigint_rows().items()))
  for name in [relative+'extra',relative.replace('@1.1.9/','@1.1.10/'),relative.replace('darwin-x64','darwin-arm64')]:
   with mock.patch.object(a,'pin',side_effect=AssertionError('Unknown path must not inspect borrowed loaders')):self.assertFalse(a.unselected_prebuild_data(repo,name,policy,0o644,bytes.fromhex(policy['header20_hex']),'amd64'))
 def test_catch_derivative_is_unique_fullfile_inverse_and_original_graph_unchanged(self):
  value=self.graph();source=pathlib.Path(value['root'])/'typescript/cli/dist/cli.js';original=source.read_bytes();derived=a.cli_derivative_entry(value)
  self.assertEqual(derived.replace(a.CLI_CAUSE_INSERT,b'',1),original);self.assertEqual(derived.count(a.CLI_CAUSE_INSERT),1);self.assertIn(a.CLI_CAUSE_INSERT+a.CLI_CATCH_BODY,derived)
  out=a.materialize(value,self.root/'derivative',0,8*a.GIB);self.assertEqual(pathlib.Path(out['entrypoint']['path']).read_bytes(),derived);self.assertEqual(source.read_bytes(),original);self.assertEqual((pathlib.Path(out['workspace']['root'])/'typescript/cli/dist/cli.js').read_bytes(),original);a.verify_materialized(out);receipt=self.root/'materialized.json';receipt.write_text(json.dumps(out));a.read_materialized(a.pin(receipt))
 def test_catch_missing_duplicate_changed_or_already_instrumented_refused(self):
  original=b"try { publicFixture(); }\ncatch (error) {\n"+a.CLI_CATCH_BODY+b"\n}\n"
  for bad in [b'no catch',original+original,original.replace(b'error.message',b'error.reason'),a.cli_failure_derivative(original),original.replace(b'catch (error)',b'catch (other)')]:
   with self.subTest(size=len(bad)),self.assertRaises(ValueError):a.cli_failure_derivative(bad)
  with self.assertRaises(ValueError):a.cli_failure_derivative(original+b'x'*1024**2)
 def test_rehashed_entry_or_receipt_cannot_admit_noninverse_derivative(self):
  value=self.graph();out=a.materialize(value,self.root/'noninverse',0,8*a.GIB);entry=pathlib.Path(out['entrypoint']['path']);entry.write_bytes(entry.read_bytes()+b'// foreign change');row=a.pin(entry);out['entrypoint']=row;out['immutable_files']=[row if r['path']==str(entry)else r for r in out['immutable_files']]
  with self.assertRaisesRegex(ValueError,'Only exact original-graph'):a.verify_materialized(out)
 def test_derivative_receipt_and_original_entry_must_remain_exact(self):
  value=self.graph();out=a.materialize(value,self.root/'bad-receipt',0,8*a.GIB);out['diagnostic_derivative']['original_message_and_exit_flow_preserved']=False
  with self.assertRaisesRegex(ValueError,'Exact derivative provenance'):a.verify_materialized(out)
 def test_diagnostic_entry_growth_is_charged_before_copy_without_reserve_increase(self):
  value=self.graph();original=value['entries']['typescript/cli/dist/cli.js']['bytes'];derived=len(a.cli_derivative_entry(value))
  for fragment in [1,4096,65536]:
   charge=lambda n:max(fragment,((n+fragment-1)//fragment)*fragment)
   self.assertEqual(a.cli_derivative_growth(value,fragment),charge(derived)-charge(original));self.assertGreaterEqual(a.cli_derivative_growth(value,fragment),0)
  fragment=os.statvfs(self.root).f_frsize;copy=a.copy_charge(value,fragment);cap=8*a.GIB;existing=cap-2*a.GIB-copy+1
  with self.assertRaises(ValueError):a.materialize(value,self.root/'one-byte-over',existing,cap)
  self.assertFalse((self.root/'one-byte-over').exists())

class LockedPackageBatch(unittest.TestCase):
 # Published archives are exhaustively audited outside this test. These tests
 # exercise the actual admission function without loading any addon/SDK/CLI.
 COUNTS={'bare-fs@4.8.1':13,'bare-path@3.1.1':13,'bare-url@2.5.2':13,'bufferutil@4.0.5':4,'fb-dotslash@0.5.8':5,'ganache@7.4.3':36,'hermes-compiler@250829098.0.17':12,'keccak@3.0.1':4,'keccak@3.0.4':4,'node-hid@2.1.1':1,'secp256k1@4.0.5':4,'secp256k1@5.0.2':4,'term-size@2.2.1':2,'usb@1.9.2':11,'utf-8-validate@5.0.7':4}
 def rows(self):return {p:r for p,r in a.NPM_PREBUILD_DATA.items()if r['package']in self.COUNTS}
 def pins(self,package):
  repo=pathlib.Path('/OWNED/locked-workspace');loader=a.NPM_PREBUILD_LOADERS[package]
  return repo,{repo/loader['root']/p:dict(r)for p,r in loader['files'].items()}
 def test_all_fifteen_locked_archives_native_members_are_finite(self):
  rows=self.rows();self.assertEqual(len(rows),130)
  self.assertEqual({pkg:sum(r['package']==pkg for r in rows.values())for pkg in self.COUNTS},self.COUNTS)
  for path,row in rows.items():
   with self.subTest(path=path):
    self.assertTrue(path.startswith('node_modules/.pnpm/'+row['package']+'/node_modules/'))
    self.assertEqual(set(row),{'package','platform','architectures','bytes','sha256','header20_hex','mode'})
    self.assertEqual(len(row['sha256']),64);self.assertEqual(len(row['header20_hex']),40);self.assertIn(row['mode'],{0o644,0o755})
    if row['platform']=='linux':self.assertTrue(row['architectures'],'Unknown Linux architecture must not receive foreign data authority')
 def test_exact_platform_and_architecture_precede_data_for_every_member(self):
  for relative,row in self.rows().items():
   repo,pins=self.pins(row['package'])
   for arch,host in [('amd64','x64'),('arm64','arm64')]:
    with self.subTest(path=relative,arch=arch),mock.patch.object(a,'pin',side_effect=lambda p:dict(pins[p]))as check:
     actual=a.unselected_prebuild_data(repo,relative,row,row['mode'],bytes.fromhex(row['header20_hex']),arch)
     self.assertEqual(actual,row['platform']!='linux'or host not in row['architectures'])
     self.assertEqual({c.args[0]for c in check.call_args_list},set(pins))
 def test_every_native_member_hash_size_mode_and_header_remain_mandatory(self):
  for relative,row in self.rows().items():
   repo,pins=self.pins(row['package']);header=bytes.fromhex(row['header20_hex'])
   for supplied,mode,raw in [(dict(row,bytes=row['bytes']+1),row['mode'],header),(dict(row,sha256='0'*64),row['mode'],header),(row,row['mode']^0o100,header),(row,row['mode'],bytes([header[0]^1])+header[1:])]:
    with self.subTest(path=relative),mock.patch.object(a,'pin',side_effect=lambda p:dict(pins[p])),self.assertRaisesRegex(ValueError,'Exact Source-locked prebuild'):
     a.unselected_prebuild_data(repo,relative,supplied,mode,raw,'amd64')
 def test_every_package_selector_source_pin_is_mandatory(self):
  for package in self.COUNTS:
   relative,row=next((p,r)for p,r in self.rows().items()if r['package']==package and r['platform']!='linux');repo,pins=self.pins(package)
   for target in pins:
    for field,value in [('bytes',pins[target]['bytes']+1),('sha256','0'*64)]:
     changed=copy.deepcopy(pins);changed[target][field]=value
     with self.subTest(package=package,path=str(target),field=field),mock.patch.object(a,'pin',side_effect=lambda p:dict(changed[p])),self.assertRaisesRegex(ValueError,'platform-selecting package loader changed'):
      a.unselected_prebuild_data(repo,relative,row,row['mode'],bytes.fromhex(row['header20_hex']),'amd64')
 def test_unknown_version_path_or_filename_has_no_data_authority(self):
  for path,row in self.rows().items():
   for bad in [path+'extra',path.replace('/node_modules/','/unknown/',1),path.replace(row['package'],row['package']+'-unpublished',1)]:
    with self.subTest(path=bad),mock.patch.object(a,'pin',side_effect=AssertionError('Unknown payload must not borrow a loader')):
     self.assertFalse(a.unselected_prebuild_data(pathlib.Path('/ABSENT'),bad,row,row['mode'],bytes.fromhex(row['header20_hex']),'amd64'))
 def test_ganache_host_abi_nodes_and_bundled_loaders_remain_separate(self):
  rows={path.rsplit('/',1)[-1]:r for path,r in self.rows().items()if r['package']=='ganache@7.4.3'and '/dist/node/'in path}
  self.assertEqual(len(rows),15)
  for name in ['222l8vHq.node','3V6RmN_1.node','tiTj4M0Y.node']:
   self.assertEqual((rows[name]['platform'],rows[name]['architectures']),('linux',['x64']))
  files=a.NPM_PREBUILD_LOADERS['ganache@7.4.3']['files']
  for suffix in ['dist/node/0.js','dist/node/1.js','node_modules/node-gyp-build/index.js','node_modules/@trufflesuite/bigint-buffer/node_modules/node-gyp-build/index.js']:
   self.assertTrue(any(p.endswith('/'+suffix)for p in files))
  self.assertNotEqual(next(r['sha256']for p,r in files.items()if p.endswith('/node_modules/node-gyp-build/index.js')and '/bigint-buffer/'not in p),next(r['sha256']for p,r in files.items()if p.endswith('/bigint-buffer/node_modules/node-gyp-build/index.js')))
 def test_linux_hermes_and_dotslash_cannot_be_dormant_host_payloads(self):
  for package,suffix in [('hermes-compiler@250829098.0.17','/linux64-bin/hermesc'),('fb-dotslash@0.5.8','/linux-musl.x86_64/dotslash')]:
   relative,row=next((p,r)for p,r in self.rows().items()if r['package']==package and p.endswith(suffix));repo,pins=self.pins(package)
   with mock.patch.object(a,'pin',side_effect=lambda p:dict(pins[p])):
    self.assertFalse(a.unselected_prebuild_data(repo,relative,row,row['mode'],bytes.fromhex(row['header20_hex']),'amd64'))
 def test_source_specific_nonstandard_selectors_are_pinned(self):
  required={'bare-fs@4.8.1':['binding.js','index.js'],'bare-path@3.1.1':['binding.js','index.js'],'bare-url@2.5.2':['binding.js','index.js'],'fb-dotslash@0.5.8':['platforms.js','bin/dotslash'],'node-hid@2.1.1':['nodehid.js','bindings@1.5.0/node_modules/bindings/bindings.js'],'term-size@2.2.1':['index.js'],'hermes-compiler@250829098.0.17':['package.json','index.js']}
  for package,suffixes in required.items():
   for suffix in suffixes:self.assertTrue(any(p.endswith('/'+suffix)or p==suffix for p in a.NPM_PREBUILD_LOADERS[package]['files']))

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
