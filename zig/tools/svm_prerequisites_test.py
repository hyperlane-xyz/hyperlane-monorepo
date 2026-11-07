"""Socket/process/compiler-free controls for the actual prerequisite owner helpers."""
import importlib.util,io,json,pathlib,struct,tarfile,tempfile,unittest
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
if __name__=='__main__':unittest.main()
