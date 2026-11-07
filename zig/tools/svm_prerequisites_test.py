"""Socket/process/compiler-free controls for the actual prerequisite owner helpers."""
import importlib.util,io,json,pathlib,struct,tarfile,tempfile,unittest,hashlib
from unittest import mock
spec=importlib.util.spec_from_file_location('svm_prerequisites',pathlib.Path(__file__).with_name('svm_prerequisites.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Controls(unittest.TestCase):
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
  self.assertEqual(m.ASSETS['criterion']['url'],'https://github.com/Snaipe/Criterion/releases/download/v2.3.3/criterion-v2.3.3-linux-x86_64.tar.bz2')
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
if __name__=='__main__':unittest.main()
