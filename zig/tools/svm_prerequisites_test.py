"""Socket/process/compiler-free controls for the actual prerequisite owner helpers."""
import importlib.util,io,json,pathlib,struct,tarfile,tempfile,unittest,hashlib
from unittest import mock
spec=importlib.util.spec_from_file_location('svm_prerequisites',pathlib.Path(__file__).with_name('svm_prerequisites.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Controls(unittest.TestCase):
 def allocated_fixture(self):
  temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);root=pathlib.Path(temp.name).resolve();gone=root/'rmeta-directory';gone.mkdir();keep=root/'stable-file';keep.write_bytes(b'public resource fixture')
  return root,gone,keep
 def test_allocated_directory_disappears_after_lstat_before_scandir(self):
  root,gone,keep=self.allocated_fixture();expected=(gone.lstat().st_blocks+keep.lstat().st_blocks)*512;original=pathlib.Path.iterdir
  def scan(path):
   if path==root:
    yield gone  # Actual lstat queues a real directory before retirement.
    gone.rmdir()
    yield keep
   else:yield from original(path)
  with mock.patch.object(pathlib.Path,'iterdir',scan):self.assertEqual(m.allocated(root),expected)
  self.assertFalse(gone.exists());self.assertTrue(keep.exists())
 def test_allocated_missing_root_is_not_a_disappearing_compiler_leaf(self):
  root,gone,keep=self.allocated_fixture()
  with self.assertRaises(FileNotFoundError):m.allocated(root/'absent-root')
 def test_allocated_scan_permission_and_wrong_type_still_fail(self):
  for error in (PermissionError('refused'),NotADirectoryError('changed type')):
   root,gone,keep=self.allocated_fixture();original=pathlib.Path.iterdir
   def scan(path):
    if path==gone:raise error
    yield from original(path)
   with self.subTest(error=type(error).__name__),mock.patch.object(pathlib.Path,'iterdir',scan),self.assertRaises(type(error)):m.allocated(root)
 def test_allocated_original_three_second_bound_is_not_renewed(self):
  root,gone,keep=self.allocated_fixture()
  with mock.patch.object(m.time,'monotonic',side_effect=[10,13]),self.assertRaisesRegex(ValueError,'3s/500k'):m.allocated(root)
 def test_system_hardlink_hash_is_distinct_from_asset_requirement(self):
  with tempfile.TemporaryDirectory()as tmp:
   p=pathlib.Path(tmp)/'gcc';p.write_bytes(b'system compiler fixture');linked=p.with_name('gcc-alias');linked.hardlink_to(p)
   self.assertEqual(m.system_pin(p)['sha256'],m.system_pin(linked)['sha256'])
   with self.assertRaises(ValueError):m.pin(p)
 def test_extract_ticks_each_bounded_chunk(self):
  a,d=self.archive([('large','file',b'x'*(2*1024*1024+7))]);ticks=[];m.extract(a,d,lambda:ticks.append(1));self.assertGreaterEqual(len(ticks),4)
 def test_final_acceptance_composes_every_postcondition(self):
  import copy
  good={'passed':True,'error':None,'Source_unchanged':True,'owned_absent':True,'actual_owner_signals':[],'commands':[{'actual_wait_observed':True,'exit_code':0}]};self.assertTrue(m.final_acceptance(good))
  changes=[lambda x:x.update(passed=False),lambda x:x.update(error='failure'),lambda x:x.pop('error'),lambda x:x.update(Source_unchanged=False),lambda x:x.pop('Source_unchanged'),lambda x:x.update(owned_absent=False),lambda x:x.pop('owned_absent'),lambda x:x.update(actual_owner_signals=[{'pid':1,'signal':2}]),lambda x:x.pop('actual_owner_signals'),lambda x:x.update(commands=[]),lambda x:x['commands'][0].update(actual_wait_observed=False),lambda x:x['commands'][0].update(exit_code=1),lambda x:x['commands'][0].update(exit_code=False),lambda x:x['commands'][0].update(exit_code=None)]
  for index,change in enumerate(changes):
   with self.subTest(index=index):value=copy.deepcopy(good);change(value);self.assertFalse(m.final_acceptance(value))
 def test_archive_paths(self):
  for n in ['../escape','/absolute','a/../../b','a\\b','\x00x','']:
   with self.subTest(n=n),self.assertRaises(ValueError):m.safe_name(n)
  self.assertEqual(m.safe_name('./valid/bin'),'valid/bin')
 def test_archive_symlink_targets(self):
  for link in ['../../escape','/absolute','../..','x\\y','']:
   with self.subTest(link=link),self.assertRaises(ValueError):m.safe_link('bin/tool',link)
  self.assertEqual(m.safe_link('lib/x','../bin/tool'),'bin/tool')
 def archive(self,rows):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);base=pathlib.Path(self.tmp.name);a=base/'test.tar'
  with tarfile.open(a,'w')as t:
   for name,kind,data in rows:
    row=tarfile.TarInfo(name);row.mode=0o755
    if kind=='link':row.type=tarfile.SYMTYPE;row.linkname=data;t.addfile(row)
    elif kind=='hard':row.type=tarfile.LNKTYPE;row.linkname=data;t.addfile(row)
    else:row.size=len(data);t.addfile(row,io.BytesIO(data))
  return a,base/'out'
 def test_valid_closed_archive(self):
  a,d=self.archive([('bin/tool','file',b'ELF fixture bytes'),('lib/tool','link','../bin/tool')]);rows=m.extract(a,d,lambda:None)
  self.assertEqual(set(rows),{'bin','bin/tool','lib','lib/tool'});self.assertEqual(rows['lib/tool']['target'],'../bin/tool');self.assertEqual((d/'bin/tool').stat().st_nlink,1)
 def test_duplicate_member(self):
  a,d=self.archive([('x','file',b'a'),('x','file',b'b')])
  with self.assertRaisesRegex(ValueError,'duplicate'):m.extract(a,d,lambda:None)
 def test_hardlink_rejected(self):
  a,d=self.archive([('x','file',b'a'),('y','hard','x')])
  with self.assertRaisesRegex(ValueError,'hardlink'):m.extract(a,d,lambda:None)
 def test_symlink_parent_never_written(self):
  a,d=self.archive([('safe','file',b'a'),('x','link','safe'),('x/y','file',b'bad')])
  with self.assertRaises((ValueError,FileExistsError)):m.extract(a,d,lambda:None)
 def test_symlink_chain_cannot_create_outside_parent(self):
  a,d=self.archive([('sub/parent','link','..'),('sub/link','link','parent/..'),('sub/link/escape/file','file',b'bad')])
  with self.assertRaises(ValueError):m.extract(a,d,lambda:None)
  self.assertFalse((d.parent/'escape').exists())
 def test_dangling_link_rejected(self):
  a,d=self.archive([('x','link','missing')])
  with self.assertRaises(FileNotFoundError):m.extract(a,d,lambda:None)
 def test_special_member(self):
  with tempfile.TemporaryDirectory()as tmp:
   p=pathlib.Path(tmp);a=p/'f.tar'
   with tarfile.open(a,'w')as t:r=tarfile.TarInfo('fifo');r.type=tarfile.FIFOTYPE;t.addfile(r)
   with self.assertRaisesRegex(ValueError,'special'):m.extract(a,p/'out',lambda:None)
 def test_elf_machine_checked(self):
  with tempfile.TemporaryDirectory()as tmp:
   p=pathlib.Path(tmp)/'tool';b=bytearray(64);b[:6]=b'\x7fELF\x02\x01';struct.pack_into('<H',b,18,247);p.write_bytes(b);self.assertEqual(m.elf(p,247)['elf_machine'],247)
   with self.assertRaises(ValueError):m.elf(p,62)
   b[4]=1;p.write_bytes(b)
   with self.assertRaises(ValueError):m.elf(p,247)
 def test_cargo_exact_product(self):
  with tempfile.TemporaryDirectory()as tmp:
   p=pathlib.Path(tmp)/'cargo.jsonl';dest=pathlib.Path(tmp)/'target/debug/cli';row={'reason':'compiler-artifact','target':{'name':'cli','kind':['bin']},'package_id':'path+file:///src#package@0.1.0','executable':str(dest)};p.write_text(json.dumps(row)+'\n');self.assertEqual(m.cargo_binary(p,'package','cli',dest),row)
   p.write_text(json.dumps(row)+'\n'+json.dumps(row)+'\n')
   with self.assertRaises(ValueError):m.cargo_binary(p,'package','cli',dest)
   p.write_text(json.dumps(dict(row,package_id='wrong-package 0.1.0'))+'\n')
   with self.assertRaises(ValueError):m.cargo_binary(p,'package','cli',dest)
 def test_cargo_old_id_supported(self):
  with tempfile.TemporaryDirectory()as tmp:
   p=pathlib.Path(tmp)/'c';dest=pathlib.Path(tmp)/'spl-token';row={'reason':'compiler-artifact','target':{'name':'spl-token','kind':['bin']},'package_id':'spl-token-cli 1.0.0 (path+file:///src)','executable':str(dest)};p.write_text(json.dumps(row)+'\n');m.cargo_binary(p,'spl-token-cli','spl-token',dest)
 def test_offline_mount_policy(self):
  with tempfile.TemporaryDirectory()as tmp:
   root=pathlib.Path(tmp);cmd=m.compile_command('/usr/bin/bwrap',root,pathlib.Path('/checkout'),['cargo','--offline'],root)
   self.assertIn('--unshare-net',cmd);self.assertIn('--ro-bind',cmd);self.assertEqual(cmd[-2:],['cargo','--offline']);self.assertIn(str(root/'assets'),cmd);self.assertIn(str(root/'build-sdk'),cmd)
   network=m.compile_command('bwrap',root,pathlib.Path('/checkout'),['fetch'],root,offline=False);self.assertNotIn('--unshare-net',network);self.assertIn('--ro-bind',network)
 def test_no_foreign_session_capture(self):
  snapshot={2:{'pid':2,'start':20,'ppid':1,'session':99,'group':99},3:{'pid':3,'start':30,'ppid':55,'session':99,'group':99}};known={2:{'start':20}}
  self.assertEqual(m.owned_closure(snapshot,known,88),{2})
 def test_detached_descendant_captured(self):
  snap={2:{'start':20,'ppid':88},3:{'start':30,'ppid':2},4:{'start':40,'ppid':3}};self.assertEqual(m.owned_closure(snap,{},88),{2,3,4})
 def test_pid_reuse_is_not_ownership(self):
  self.assertEqual(m.owned_closure({2:{'start':21,'ppid':1}},{2:{'start':20}},88),set())
 def test_finished_pidfds_closed_without_losing_live_identity(self):
  known={2:{'start':20,'fd':12},3:{'start':30,'fd':13},4:{'start':40,'fd':14}};snapshot={3:{'start':31},4:{'start':40}};closed=[];m.prune_finished(known,snapshot,closed.append)
  self.assertEqual(closed,[12,13]);self.assertEqual(known,{4:{'start':40,'fd':14}})
 def test_subreaper_orphan_owned(self):self.assertEqual(m.owned_closure({7:{'start':70,'ppid':88}},{},88),{7})
 def test_source_symlink_escape_rejected(self):
  with tempfile.TemporaryDirectory()as tmp:
   root=pathlib.Path(tmp)/'repo';root.mkdir();(root/'bad').symlink_to('/usr/bin');
   with self.assertRaises(ValueError):m.source_row(root,'bad')
 def test_unsafe_redirect(self):
  with self.assertRaises(ValueError):m.OfficialRedirect().redirect_request(None,None,302,'',{},'https://evil.invalid/asset')
 def test_fixed_asset_and_source_counts(self):
  self.assertEqual(len(m.PROGRAMS),9);self.assertEqual(len(m.SPL),4);self.assertFalse(m.ASSETS['spl']['publisher_digest']);self.assertEqual(m.ASSETS['platform']['bytes'],542447828)
class OwnedSdkLinkControls(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
  self.root=pathlib.Path(self.tmp.name).resolve();self.sdk=self.root/'build-sdk';(self.sdk/'dependencies').mkdir(parents=True)
  self.platform=self.root/'assets/platform';self.platform.mkdir(parents=True);(self.platform/'compiler').write_bytes(b'compiler fixture')
  self.link=self.sdk/'dependencies/platform-tools';self.link.symlink_to(self.platform)
 def test_default_inventory_still_rejects_absolute_link(self):
  with self.assertRaisesRegex(ValueError,'unsafe symlink'):m.inventory(self.sdk)
 def test_only_exact_owned_sdk_binding_is_admitted_and_recorded(self):
  before=m.inventory(self.sdk,owned_sdk_platform=self.platform)
  self.assertEqual(before['dependencies/platform-tools']['target'],str(self.platform))
  self.assertEqual(before,m.inventory(self.sdk,owned_sdk_platform=self.platform))
  self.assertNotIn('dependencies/platform-tools/compiler',before)
  self.assertIn('platform/compiler',m.inventory(self.root/'assets'))
 def test_changed_binding_rejected(self):
  self.link.unlink();self.link.symlink_to('/usr/bin')
  with self.assertRaisesRegex(ValueError,'link changed'):m.inventory(self.sdk,owned_sdk_platform=self.platform)
 def test_additional_absolute_link_not_admitted(self):
  (self.sdk/'another').symlink_to(self.platform)
  with self.assertRaisesRegex(ValueError,'unsafe symlink'):m.inventory(self.sdk,owned_sdk_platform=self.platform)
 def test_symlink_platform_root_is_not_authority(self):
  real=self.root/'real';self.platform.rename(real);self.platform.symlink_to(real)
  with self.assertRaisesRegex(ValueError,'wrong owned SDK platform'):m.inventory(self.sdk,owned_sdk_platform=self.platform)
 def test_wrong_approved_platform_path_not_admitted(self):
  with self.assertRaisesRegex(ValueError,'wrong owned SDK platform'):m.inventory(self.sdk,owned_sdk_platform=self.root/'assets')
 def test_platform_target_bytes_remain_in_separate_asset_fence(self):
  before=m.inventory(self.root/'assets');(self.platform/'compiler').write_bytes(b'changed compiler')
  self.assertNotEqual(before,m.inventory(self.root/'assets'))

class MatchingCargoControls(unittest.TestCase):
 def test_actual_sbf_provision_and_compile_share_all_authority_except_offline(self):
  base={'CARGO_HOME':'/owned/cargo','RUSTUP_HOME':'/owned/rustup','HOME':'/owned/home','TMPDIR':'/owned/tmp','PATH':'/usr/bin:/bin','CARGO_NET_GIT_FETCH_WITH_CLI':'true'}
  provision,compile=m.sbf_environments(base,pathlib.Path('/owned/assets/platform'),pathlib.Path('/owned/rustup/toolchains/1.86.0/bin/cargo'))
  self.assertEqual({k:v for k,v in compile.items()if k!='CARGO_NET_OFFLINE'},provision)
  self.assertEqual(compile['CARGO_NET_OFFLINE'],'true');self.assertNotIn('CARGO_NET_OFFLINE',provision)
  for name in ['CARGO_HOME','RUSTUP_HOME','HOME','TMPDIR']:self.assertEqual(provision[name],base[name])
  self.assertEqual(provision['RUSTC'],'/owned/assets/platform/rust/bin/rustc');self.assertEqual(provision['RUSTDOC'],'/owned/assets/platform/rust/bin/rustdoc');self.assertEqual(provision['PATH'],'/owned/rustup/toolchains/1.86.0/bin:/usr/bin:/bin');self.assertEqual(provision['CARGO'],'/owned/rustup/toolchains/1.86.0/bin/cargo')
  self.assertNotIn('RUSTUP_TOOLCHAIN',provision)
 def test_matching_prefetch_is_locked_and_precedes_compiler_input_freeze(self):
  import ast
  source=pathlib.Path(m.__file__).read_text();tree=ast.parse(source)
  calls=[n for n in ast.walk(tree)if isinstance(n,ast.Call)and isinstance(n.func,ast.Attribute)and n.func.attr=='run'and n.args and isinstance(n.args[0],ast.Constant)and n.args[0].value=='provision.fetch-sbf']
  self.assertEqual(len(calls),1);call=calls[0];args=call.args[1]
  self.assertIsInstance(args,ast.List);self.assertEqual([n.value for n in args.elts if isinstance(n,ast.Constant)],['fetch','--locked','--manifest-path'])
  self.assertEqual(ast.unparse(args.elts[0]),"tool['1.86.0']")
  self.assertEqual(ast.unparse(call.args[3]),'sbf_provision_env')
  freeze=source.index('compiler_inputs={');self.assertLess(source.index("o.run('provision.fetch-sbf'"),freeze)
  self.assertIn("need([pin(p)for p in locks]==lockpins,'provision changed committed lock')",source)
 def test_host_cargo_never_substitutes_platform_codegen(self):
  host=pathlib.Path('/owned/rustup/toolchains/1.86.0/bin/cargo');platform=pathlib.Path('/owned/assets/platform')
  provision,compile=m.sbf_environments({},platform,host)
  self.assertEqual(pathlib.Path(provision['CARGO']),host)
  self.assertEqual(pathlib.Path(provision['RUSTC']),platform/'rust/bin/rustc')
  self.assertNotEqual(pathlib.Path(provision['RUSTC']).parent,host.parent)
  source=pathlib.Path(m.__file__).read_text();self.assertIn("'--no-rustup-override'",source)
 def test_offline_compile_sandbox_is_unchanged(self):
  provision,compile=m.sbf_environments({'CARGO_HOME':'/owned/cargo'},pathlib.Path('/owned/assets/platform'),pathlib.Path('/owned/rustup/toolchains/1.86.0/bin/cargo'))
  with tempfile.TemporaryDirectory()as tmp:
   root=pathlib.Path(tmp);cache=root/'cargo/git';cache.mkdir(parents=True)
   argv=m.compile_command('/usr/bin/bwrap',root,pathlib.Path('/checkout'),['cargo','--offline'],pathlib.Path('/checkout'))
   self.assertIn('--unshare-net',argv)
   index=argv.index(str(cache));self.assertEqual(argv[index-1:index+2],['--ro-bind',str(cache),str(cache)])
  self.assertEqual(compile['CARGO_NET_OFFLINE'],'true')

class SdkPrerequisiteControls(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=pathlib.Path(self.tmp.name).resolve()
  self.sdk=self.root/'build-sdk';(self.sdk/'dependencies').mkdir(parents=True)
  self.criterion=self.root/'criterion-v2.3.3';(self.criterion/'lib').mkdir(parents=True)
  (self.criterion/'lib/libcriterion.so.3.1.0').write_bytes(b'public library bytes');(self.criterion/'lib/libcriterion.so').symlink_to('libcriterion.so.3.1.0')
 def test_full_criterion_tree_and_source_version_markers_precede_freeze(self):
  result=m.stage_sdk_dependencies(self.sdk,self.criterion)
  self.assertFalse(result['original_sdk_scripts_modified']);self.assertFalse(result['criterion_native_library_executed'])
  target=self.sdk/'dependencies/criterion';self.assertEqual(m.inventory(target),m.inventory(self.criterion))
  for name in ['criterion-v2.3.3.md','platform-tools-v1.51.md']:self.assertEqual((self.sdk/'dependencies'/name).read_bytes(),b'')
 def test_existing_marker_rejects_before_copy(self):
  (self.sdk/'dependencies/platform-tools-v1.51.md').write_bytes(b'existing')
  with self.assertRaisesRegex(ValueError,'unexpected SDK dependency marker'):m.stage_sdk_dependencies(self.sdk,self.criterion)
  self.assertFalse((self.sdk/'dependencies/criterion').exists())
 def test_existing_criterion_never_overwritten(self):
  (self.sdk/'dependencies/criterion').mkdir()
  with self.assertRaisesRegex(ValueError,'unexpected preexisting Criterion'):m.stage_sdk_dependencies(self.sdk,self.criterion)
 def test_numeric_elf_rejection_retains_strict_machine_guard(self):
  p=self.root/'program.so';wire=bytearray(64);wire[:6]=b'\x7fELF\x02\x01';struct.pack_into('<H',wire,18,263);p.write_bytes(wire)
  with self.assertRaisesRegex(ValueError,'class=2 endian=1 machine=263 expected=247'):m.elf(p,247)
  struct.pack_into('<H',wire,18,247);p.write_bytes(wire);self.assertEqual(m.elf(p,247)['elf_machine'],247)
 def test_criterion_exact_asset_pin(self):
  self.assertEqual(m.ASSETS['criterion']['asset_id'],9581569);self.assertEqual(m.ASSETS['criterion']['bytes'],677858)
  self.assertEqual(m.ASSETS['criterion']['url'],'https://api.github.com/repos/Snaipe/Criterion/releases/assets/9581569')
  self.assertFalse(m.ASSETS['criterion']['publisher_digest'])

class TypedSbfElfControls(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.path=pathlib.Path(self.tmp.name)/'program.so'
 def wire(self,machine):
  header=bytearray(64);header[:8]=b'\x7fELF\x02\x01\x01\x00';struct.pack_into('<HHI',header,16,3,machine,1);self.path.write_bytes(header);return header
 def test_bpf_and_sbpf_observed_formats_are_recorded_without_alias(self):
  for machine in [247,263]:
   self.wire(machine);result=m.sbf_elf(self.path);self.assertEqual(result['elf_machine'],machine);self.assertEqual(result['elf_class'],64)
 def test_native_ELF_not_SBF_and_native_CLI_guard_stays_exact62(self):
  self.wire(62)
  with self.assertRaisesRegex(ValueError,'wrong SBF ELF machine'):m.sbf_elf(self.path)
  self.assertEqual(m.elf(self.path,62)['elf_machine'],62)
  self.wire(263)
  with self.assertRaisesRegex(ValueError,'machine=263 expected=62'):m.elf(self.path,62)
 def test_invalid_sbf_class_endian_OSABI_and_type_reject(self):
  for field,value in [(4,1),(5,2),(7,3),(16,2)]:
   with self.subTest(field=field):
    header=self.wire(263);header[field]=value;self.path.write_bytes(header)
    with self.assertRaises(ValueError):m.sbf_elf(self.path)
 def test_short_header_and_unknown_machine_reject(self):
  self.path.write_bytes(b'\x7fELF')
  with self.assertRaises(ValueError):m.sbf_elf(self.path)
  self.wire(264)
  with self.assertRaises(ValueError):m.sbf_elf(self.path)

class PublisherLinkControls(unittest.TestCase):
 archive=Controls.archive
 def extract_publisher(self,a,d,links):
  actual=m.pin(a);asset={**m.ASSETS['platform'],'bytes':actual['bytes'],'sha256':actual['sha256']}
  with mock.patch.dict(m.ASSETS,{'platform':asset}):return m.extract(a,d,lambda:None,platform_asset=asset)
 def publisher_fixture(self,changes=None):
  links=dict(m.PLATFORM_UNUSED_DANGLING_LINKS)
  rows=[('rust/bin/rustc','file',b'compiler unchanged'),('llvm/lib/liblldb.so','file',b'debug library unchanged')]
  rows += [(n,'link',v)for n,v in links.items()]
  return rows,links
 def test_exact_unused_publisher_links_omitted_with_closed_retained_tree(self):
  rows,links=self.publisher_fixture();a,d=self.archive(rows);result=self.extract_publisher(a,d,links)
  self.assertEqual((d/'rust/bin/rustc').read_bytes(),b'compiler unchanged');self.assertTrue(all(n not in result and not(d/n).is_symlink()for n in links));self.assertEqual((d/'llvm/lib/liblldb.so').read_bytes(),b'debug library unchanged')
 def test_same_publisher_links_still_rejected_by_default(self):
  rows,_=self.publisher_fixture();a,d=self.archive(rows)
  with self.assertRaises(FileNotFoundError):m.extract(a,d,lambda:None)
 def test_expected_omission_cannot_be_missing(self):
  rows,links=self.publisher_fixture();a,d=self.archive(rows[:-1])
  with self.assertRaisesRegex(ValueError,'expected omitted'):self.extract_publisher(a,d,links)
 def test_expected_omission_cannot_be_regular_file(self):
  rows,links=self.publisher_fixture();rows[-1]=(rows[-1][0],'file',b'changed');a,d=self.archive(rows)
  with self.assertRaisesRegex(ValueError,'identity differs'):self.extract_publisher(a,d,links)
 def test_expected_omission_cannot_change_link_target(self):
  rows,links=self.publisher_fixture();rows[-1]=(rows[-1][0],'link','../../../../bin/changed');a,d=self.archive(rows)
  with self.assertRaisesRegex(ValueError,'identity differs'):self.extract_publisher(a,d,links)
 def test_unlisted_dangling_link_still_rejected(self):
  rows,links=self.publisher_fixture();rows.append(('other','link','missing'));a,d=self.archive(rows)
  with self.assertRaises(FileNotFoundError):self.extract_publisher(a,d,links)
 def test_wrong_asset_rejected_before_omission(self):
  rows,links=self.publisher_fixture();a,d=self.archive(rows)
  with self.assertRaisesRegex(ValueError,'wrong pinned Linux platform asset'):m.extract(a,d,lambda:None,platform_asset=m.ASSETS['agave'])
 def test_wrong_archive_digest_rejected_before_omission(self):
  rows,links=self.publisher_fixture();a,d=self.archive(rows)
  with self.assertRaisesRegex(ValueError,'bytes/digest'):m.extract(a,d,lambda:None,platform_asset=m.ASSETS['platform'])
 def test_wrong_platform_url_rejected(self):
  rows,links=self.publisher_fixture();a,d=self.archive(rows);asset={**m.ASSETS['platform'],'url':'https://github.com/anza-xyz/platform-tools/releases/download/v1.51/platform-tools-osx-aarch64.tar.bz2'}
  with self.assertRaisesRegex(ValueError,'wrong pinned Linux platform asset'):m.extract(a,d,lambda:None,platform_asset=asset)
 def test_retained_link_to_omitted_link_rejected(self):
  rows,links=self.publisher_fixture();name=next(iter(links));rows.append(('llvm/retained','link',name[len('llvm/'): ]));a,d=self.archive(rows)
  with self.assertRaises(FileNotFoundError):self.extract_publisher(a,d,links)
class FetchMediaControls(unittest.TestCase):
 def fetch(self,accept=None):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);dest=pathlib.Path(self.tmp.name)/'response';seen=[]
  class Response(io.BytesIO):
   url='https://api.github.com/repos/hyperlane-xyz/solana-program-library/commits/e101cca'
   headers={}
  class Opener:
   def open(self,request,timeout):seen.append((request.get_header('Accept'),timeout));return Response(b'{"sha":"public fixture"}')
  o=m.Owner.__new__(m.Owner);o.opener=Opener();o.tick=lambda:None
  kw={}if accept is None else{'accept':accept}
  row=o.fetch(Response.url,dest,1024,**kw)
  return row,seen,dest
 def test_asset_media_default_is_unchanged_binary(self):
  row,seen,dest=self.fetch();self.assertEqual(seen,[('application/octet-stream',30)]);self.assertEqual(row['sha256'],m.pin(dest)['sha256'])
 def test_explicit_json_media_reaches_actual_request(self):
  row,seen,dest=self.fetch('application/vnd.github+json');self.assertEqual(seen,[('application/vnd.github+json',30)]);self.assertEqual(json.loads(dest.read_text()),{'sha':'public fixture'})
 def test_only_custom_spl_metadata_call_changes_media(self):
  source=pathlib.Path(m.__file__).read_text();self.assertEqual(source.count("accept='application/vnd.github+json'"),1);self.assertIn("custom-spl-commit.json',2*1024**2,accept='application/vnd.github+json'",source)
class OfficialAssetTransportControls(unittest.TestCase):
 EXPECTED={
  'agave':('anza-xyz/agave',338693012,214232615,('65614325423316a48f57f1ceeaa91ca7' '8f4516e165e305b38c01873cf8c6b8b4'),True),
  'platform':('anza-xyz/platform-tools',279991627,542447828,('0933e05dd964826e8e2db5c58c34ae25' '5e3baf0ce1711568552dca81b5407a6b'),True),
  'spl':('hyperlane-xyz/solana-program-library',187913462,245817,('5a0862a76357316707a2056d810729ab' '563aded8b6c094a90fa204ef0fa2c415'),False),
  'criterion':('Snaipe/Criterion',9581569,677858,('ee7f92d7268563848aa3ae90bbf5df86' '604b8d0fb0e4942b0ecfbf6201596550'),False)}
 def test_asset_routes_bind_exact_fixed_repository_and_asset_id(self):
  self.assertEqual(set(m.ASSETS),set(self.EXPECTED))
  for name,(repo,asset,size,digest,publisher)in self.EXPECTED.items():
   with self.subTest(asset=name):
    self.assertEqual(m.ASSETS[name]['asset_id'],asset)
    self.assertEqual(m.ASSETS[name]['url'],f'https://api.github.com/repos/{repo}/releases/assets/{asset}')
 def test_published_bytes_hashes_flags_and_policy_keys_unchanged(self):
  for name,(repo,asset,size,digest,publisher)in self.EXPECTED.items():
   with self.subTest(asset=name):
    self.assertEqual(set(m.ASSETS[name]),{'url','asset_id','bytes','sha256','publisher_digest'})
    self.assertEqual((m.ASSETS[name]['bytes'],m.ASSETS[name]['sha256'],m.ASSETS[name]['publisher_digest']),(size,digest,publisher))
 def actual_fetch(self,name,*,wrong_hash=False,wrong_size=False,short_limit=False):
  temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);dest=pathlib.Path(temp.name)/'asset'
  body=b'public transport fixture, not an SDK/archive acceptance';expected={'bytes':len(body)+(1 if wrong_size else 0),'sha256':'0'*64 if wrong_hash else hashlib.sha256(body).hexdigest()}
  repo,asset,_,_,_=self.EXPECTED[name];expected_url=f'https://api.github.com/repos/{repo}/releases/assets/{asset}';seen=[];outer=self;url=m.ASSETS[name]['url'];redirect='https://release-assets.githubusercontent.com/github-production-release-asset/public-fixture'
  class Response(io.BytesIO):
   def __init__(self):super().__init__(body);self.url=redirect;self.headers={'Content-Length':str(len(body))}
  class Opener:
   def open(self,request,timeout):
    outer.assertEqual(request.full_url,expected_url);outer.assertEqual(request.get_method(),'GET');outer.assertEqual(request.get_header('Accept'),'application/octet-stream');outer.assertEqual(timeout,30)
    followed=m.OfficialRedirect().redirect_request(request,None,302,'Found',{},redirect)
    outer.assertEqual(followed.full_url,redirect);outer.assertEqual(followed.get_method(),'GET');seen.append(request.full_url)
    return Response()
  owner=m.Owner.__new__(m.Owner);owner.opener=Opener();ticks=[];owner.tick=lambda:ticks.append(True)
  row=owner.fetch(url,dest,len(body)-(1 if short_limit else 0),expected)
  self.assertEqual(seen,[url]);self.assertTrue(ticks);self.assertEqual(dest.read_bytes(),body)
  self.assertEqual((row['bytes'],row['sha256']),(len(body),hashlib.sha256(body).hexdigest()));self.assertEqual(row['actual_response_url'],redirect)
  return row
 def test_actual_API_request_official_redirect_bytes_and_digest(self):
  for name in self.EXPECTED:
   with self.subTest(asset=name):self.actual_fetch(name)
 def test_actual_API_fetch_refuses_wrong_hash_and_size(self):
  for name in self.EXPECTED:
   for fault in ['wrong_hash','wrong_size']:
    with self.subTest(asset=name,fault=fault),self.assertRaisesRegex(ValueError,'asset size/SHA mismatch'):self.actual_fetch(name,**{fault:True})
 def test_actual_API_fetch_preserves_download_bound(self):
  with self.assertRaisesRegex(ValueError,'download size bound'):self.actual_fetch('agave',short_limit=True)
 def test_API_request_cannot_redirect_to_foreign_host_or_plain_HTTP(self):
  request=m.urllib.request.Request(m.ASSETS['agave']['url'],headers={'Accept':'application/octet-stream'})
  for target in ['https://api.github.com.evil.invalid/asset','https://evil.invalid/asset','http://github.com/asset']:
   with self.subTest(target=target),self.assertRaisesRegex(ValueError,'nonofficial redirect'):m.OfficialRedirect().redirect_request(request,None,302,'Found',{},target)

class PinnedOpenRetries(unittest.TestCase):
 def setup_fetch(self,opens,*,pinned=True,accept='application/octet-stream',limit_delta=0,tick=None):
  from types import SimpleNamespace
  temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup);dest=pathlib.Path(temporary.name)/'asset';body=b'public retry fixture only'
  asset={**m.ASSETS['spl'],'bytes':len(body),'sha256':hashlib.sha256(body).hexdigest()};assets={**m.ASSETS,'spl':asset}
  owner=m.Owner.__new__(m.Owner);owner.opener=SimpleNamespace(open=mock.Mock(side_effect=opens));owner.tick=mock.Mock(side_effect=tick);owner.events=io.StringIO();owner.deadline=123456.0
  expected=asset if pinned else {'bytes':len(body),'sha256':asset['sha256']}
  return owner,dest,body,asset,assets,expected,accept,len(body)+limit_delta
 def response(self,body,read_error=None):
  class Response(io.BytesIO):
   url='https://release-assets.githubusercontent.com/public-fixture'
   headers={}
   def read(self,size=-1):
    if read_error is not None:raise read_error
    return super().read(size)
  return Response(body)
 def error(self,code):
  error=m.urllib.error.HTTPError('https://api.github.com/public',code,'fixture status',{},io.BytesIO(b'public error'))
  self.addCleanup(error.close);return error
 def invoke(self,setup):
  owner,dest,body,asset,assets,expected,accept,limit=setup
  with mock.patch.object(m,'ASSETS',assets),mock.patch.object(m.time,'sleep')as sleep:
   result=owner.fetch(asset['url'],dest,limit,expected,accept=accept)
  return result,sleep
 def test_transient_open_failures_retry_same_pinned_request_only(self):
  for first in (502,503,504):
   errors=[self.error(first),self.error(504)];setup=self.setup_fetch([*errors,self.response(b'public retry fixture only')]);owner,dest,body,asset,*_=setup
   with self.subTest(status=first):

    try:result,sleep=self.invoke(setup)
    except m.urllib.error.HTTPError:self.fail('pinned transient OPEN failure escaped before the allowed attempts')
    self.assertEqual(owner.opener.open.call_count,3);self.assertEqual(sleep.call_args_list,[mock.call(1),mock.call(2)])
    self.assertTrue(all(e.fp.closed for e in errors));self.assertEqual(dest.read_bytes(),body);self.assertEqual(owner.deadline,123456.0)
    self.assertEqual(set(result),{'path','bytes','sha256','actual_response_url','headers'})
    for call in owner.opener.open.call_args_list:self.assertEqual((call.args[0].full_url,call.args[0].get_header('Accept'),call.kwargs['timeout']),(asset['url'],'application/octet-stream',30))
    rows=[json.loads(line)for line in owner.events.getvalue().splitlines()];self.assertEqual([r['failed_attempt']for r in rows],[1,2]);self.assertTrue(all(set(r)=={'kind','asset_id','failed_attempt','maximum_attempts','http_status','backoff_seconds'}for r in rows))
 def test_third_transient_open_failure_propagates_without_destination(self):
  errors=[self.error(504)for _ in range(4)];setup=self.setup_fetch(errors);owner,dest,*_=setup
  with self.assertRaises(m.urllib.error.HTTPError)as caught:self.invoke(setup)
  self.assertIs(caught.exception,errors[2]);self.assertEqual(owner.opener.open.call_count,3);self.assertFalse(dest.exists());self.assertEqual(len(owner.events.getvalue().splitlines()),2)
 def test_nontransient_and_unpinned_requests_never_retry(self):
  for code in (400,401,403,404,408,429,500,501):
   error=self.error(code);setup=self.setup_fetch([error]);owner,dest,*_=setup
   with self.subTest(status=code),self.assertRaises(m.urllib.error.HTTPError)as caught:self.invoke(setup)
   self.assertIs(caught.exception,error);self.assertEqual(owner.opener.open.call_count,1);self.assertFalse(dest.exists());self.assertEqual(owner.events.getvalue(),'')
  for options in ({'pinned':False},{'accept':'application/vnd.github+json'},{'limit_delta':1}):
   error=self.error(504);setup=self.setup_fetch(error,**options);owner,dest,*_=setup
   with self.subTest(options=options),self.assertRaises(m.urllib.error.HTTPError)as caught:self.invoke(setup)
   self.assertIs(caught.exception,error);self.assertEqual(owner.opener.open.call_count,1);self.assertFalse(dest.exists());self.assertEqual(owner.events.getvalue(),'')
 def test_partial_body_and_digest_failures_never_retry(self):
  error=self.error(504);setup=self.setup_fetch([self.response(b'',error)]);owner,dest,*_=setup
  with self.assertRaises(m.urllib.error.HTTPError)as caught:self.invoke(setup)
  self.assertIs(caught.exception,error);self.assertEqual(owner.opener.open.call_count,1);self.assertTrue(dest.exists());self.assertEqual(owner.events.getvalue(),'')
  setup=self.setup_fetch([self.response(b'X'*len(b'public retry fixture only'))]);owner,dest,*_=setup
  with self.assertRaisesRegex(ValueError,'asset size/SHA mismatch'):self.invoke(setup)
  self.assertEqual(owner.opener.open.call_count,1);self.assertTrue(dest.exists());self.assertEqual(owner.events.getvalue(),'')
 def test_original_guard_can_stop_before_backoff_or_second_open(self):
  for ticks in ([None,ValueError('whole180m deadline')],[None,None,ValueError('owned12GiB RSS')]):
   error=self.error(504);setup=self.setup_fetch([error],tick=ticks);owner,dest,*_=setup
   with self.subTest(ticks=len(ticks)),self.assertRaisesRegex(ValueError,'whole180m|owned12GiB'):self.invoke(setup)
   self.assertEqual(owner.opener.open.call_count,1);self.assertFalse(dest.exists());self.assertEqual(owner.deadline,123456.0);self.assertTrue(error.fp.closed)

class FixedMetadataRetries(unittest.TestCase):
 URL='https://api.github.com/repos/hyperlane-xyz/solana-program-library/commits/e101cca'
 def setup_metadata(self,opens):
  from types import SimpleNamespace
  temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup);dest=pathlib.Path(temporary.name)/'metadata.json';owner=m.Owner.__new__(m.Owner);owner.opener=SimpleNamespace(open=mock.Mock(side_effect=opens));owner.tick=mock.Mock();owner.events=io.StringIO();owner.deadline=123456.0
  return owner,dest
 def error(self,code):
  error=m.urllib.error.HTTPError(self.URL,code,'public status',{},io.BytesIO());self.addCleanup(error.close);return error
 def test_exact_metadata_open_can_recover_without_changing_receipt_or_deadline(self):
  body=b'{"sha":"public metadata fixture"}'
  class Response(io.BytesIO):url=self.URL;headers={}
  errors=[self.error(503),self.error(504)];owner,dest=self.setup_metadata([*errors,Response(body)])
  with mock.patch.object(m.time,'sleep')as sleep:row=owner.fetch(self.URL,dest,2*1024**2,accept='application/vnd.github+json')
  self.assertEqual(owner.opener.open.call_count,3);self.assertEqual(sleep.call_args_list,[mock.call(1),mock.call(2)]);self.assertEqual(dest.read_bytes(),body);self.assertEqual(owner.deadline,123456.0);self.assertEqual(set(row),{'path','bytes','sha256','actual_response_url','headers'})
  for call in owner.opener.open.call_args_list:self.assertEqual((call.args[0].full_url,call.args[0].get_header('Accept'),call.args[0].get_header('Authorization'),call.kwargs['timeout']),(self.URL,'application/vnd.github+json',None,30))
  rows=[json.loads(s)for s in owner.events.getvalue().splitlines()];self.assertEqual(len(rows),2)
  for row in rows:self.assertEqual(row['kind'],'fixed_spl_metadata_open_retry');self.assertEqual(row['metadata_kind'],'custom_spl_commit');self.assertNotIn('asset_id',row);self.assertEqual(set(row),{'kind','metadata_kind','failed_attempt','maximum_attempts','http_status','backoff_seconds'})
 def test_metadata_exhaustion_still_propagates_third_error_before_file(self):
  errors=[self.error(503)for _ in range(4)];owner,dest=self.setup_metadata(errors)
  with mock.patch.object(m.time,'sleep'),self.assertRaises(m.urllib.error.HTTPError)as caught:owner.fetch(self.URL,dest,2*1024**2,accept='application/vnd.github+json')
  self.assertIs(caught.exception,errors[2]);self.assertEqual(owner.opener.open.call_count,3);self.assertFalse(dest.exists());self.assertEqual(owner.deadline,123456.0)
 def test_metadata_whitelist_and_nontransient_refusals_remain_single_attempt(self):
  good={'url':self.URL,'limit':2*1024**2,'expected':None,'accept':'application/vnd.github+json'}
  cases=[{**good,'url':self.URL+'?unreviewed=1'},{**good,'url':self.URL.replace('e101cca','main')},{**good,'url':'https://api.github.com/repos/other/project/commits/e101cca'},{**good,'limit':2*1024**2+1},{**good,'expected':{}},{**good,'accept':'application/octet-stream'}]
  cases +=[{**good,'_status':code}for code in (401,403,404,429,500)]
  for case in cases:
   case=dict(case);error=self.error(case.pop('_status',503));owner,dest=self.setup_metadata(error)
   with self.subTest(case=case,status=error.code),mock.patch.object(m.time,'sleep')as sleep,self.assertRaises(m.urllib.error.HTTPError)as caught:owner.fetch(dest=dest,**case)
   self.assertIs(caught.exception,error);self.assertEqual(owner.opener.open.call_count,1);self.assertFalse(dest.exists());self.assertEqual(owner.events.getvalue(),'');sleep.assert_not_called()

if __name__=='__main__':unittest.main()
