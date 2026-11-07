#!/usr/bin/env python3
"""Pure archive/command guards; never invokes Cargo, compilers or a database."""
import ast,gzip,hashlib,json,pathlib,platform,tempfile,types,unittest
BASE=pathlib.Path(__file__).resolve().parent

def functions():
 tree=ast.parse((BASE/'locked.py').read_text());body=[n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name in ['restore','plan']]
 ns={'pathlib':pathlib,'gzip':gzip,'hashlib':hashlib,'json':json,'platform':platform,'FLOOR':6*1024**3,'BASE':BASE}
 exec(compile(ast.fix_missing_locations(ast.Module(body=body,type_ignores=[])),'locked.py','exec'),ns);return ns
class Controls(unittest.TestCase):
 def test_packed_lock_uses_exact_original_registry_versions_and_checksums(self):
  import tomllib
  root=BASE.parents[2];baseline=tomllib.loads((root/'rust/main/Cargo.lock').read_text())['package'];known={(p['name'],p['version'],p.get('source')):p for p in baseline};wire=gzip.decompress((BASE/'Cargo.lock.gz').read_bytes());value=tomllib.loads(wire.decode())['package'];self.assertEqual(len(value),65)
  for package in value:
   if package['name']=='ziggy-native-rows':continue
   original=known[(package['name'],package['version'],package.get('source'))];self.assertEqual(package['checksum'],original['checksum'])
 def test_restore_requires_exact_bytes_and_rejects_existing_symlink(self):
  with tempfile.TemporaryDirectory()as temporary:
   root=pathlib.Path(temporary);wire=b'public-fixture-lock';(root/'Cargo.lock.gz').write_bytes(gzip.compress(wire,mtime=0));ns=functions();ns.update(BASE=root,LOCK_SHA256=hashlib.sha256(wire).hexdigest());path=ns['restore']();self.assertEqual(path.read_bytes(),wire)
   path.write_bytes(b'foreign')
   with self.assertRaises(ValueError):ns['restore']()
   path.unlink();other=root/'other';other.write_bytes(b'preserve');path.symlink_to(other)
   with self.assertRaises(ValueError):ns['restore']()
   self.assertEqual(other.read_bytes(),b'preserve')
 def test_restore_rejects_large_decoded_lock_at_bounded_read(self):
  with tempfile.TemporaryDirectory()as temporary:
   root=pathlib.Path(temporary);wire=b'x'*(1024*1024+4);(root/'Cargo.lock.gz').write_bytes(gzip.compress(wire,mtime=0));ns=functions();ns.update(BASE=root,LOCK_SHA256=hashlib.sha256(wire).hexdigest())
   with self.assertRaises(ValueError):ns['restore']()
   self.assertFalse((root/'Cargo.lock').exists())
 def test_plan_is_offline_locked_task_target_and_no_execution(self):
  args=types.SimpleNamespace(target_dir=pathlib.Path('/tmp/ziggy-native-row-reader-target-pure-plan'),jobs=2,rocksdb_lib_dir=None,rocksdb_include_dir=None,sdk_root=pathlib.Path('/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk')if platform.system()=='Darwin'else None,toolchain='1.98.0',test=True,execute=False)
  value=functions()['plan'](args);self.assertFalse(value['execute']);self.assertIn('--offline',value['command']);self.assertIn('--locked',value['command']);self.assertEqual(value['minimum_free_bytes'],6*1024**3);self.assertEqual(value['explicit_environment']['CARGO_INCREMENTAL'],'0')
  args.target_dir=pathlib.Path.home()/'.cargo';
  with self.assertRaises(ValueError):functions()['plan'](args)
 def test_production_main_has_no_writer_open_or_raw_sensitive_output(self):
  source=(BASE/'src/main.rs').read_text().split('#[cfg(test)]\nmod tests')[0];self.assertNotIn('open_default',source);self.assertIn('open_for_read_only',source);self.assertIn('libc::F_SETLK',source);self.assertIn('libc::F_RDLCK',source);self.assertIn('libc::O_NOFOLLOW',source);self.assertNotIn('"authorization":',source);self.assertNotIn('"payload":',source)
 def test_public_quote_raw_value_feature_no_float_conversion_and_same_lock_graph(self):
  import tomllib
  value=tomllib.loads((BASE/'Cargo.toml').read_text());self.assertEqual(value['dependencies']['serde_json']['version'],'=1.0.151');self.assertIn('raw_value',value['dependencies']['serde_json']['features'])
  source=(BASE/'src/main.rs').read_text().split('#[cfg(test)]\nmod tests')[0];self.assertIn('Box<serde_json::value::RawValue>',source);self.assertNotIn('.as_f64(',source);self.assertNotIn('parse::<f64>',source);self.assertIn('prepared_target_matches',source)
 def verifier(self):
  source=BASE.parents[1]/'integration/native_rows_interop.py';tree=ast.parse(source.read_text());body=[node for node in tree.body if isinstance(node,ast.FunctionDef)and node.name=='verify_native'];ns={'COUNT':5,'hashlib':hashlib};exec(compile(ast.fix_missing_locations(ast.Module(body=body,type_ignores=[])),str(source),'exec'),ns);return ns['verify_native']
 def sample(self):
  import copy
  expected={'rows':[]};value={'complete':True,'readonly':True,'configuration_authority_verified':False,'rows':[]}
  ids=['0x'+bytes([i+1]).hex()*32 for i in range(5)]
  members=[{'operation_id':ids[i],'origin':9913371,'origin_hook':'0x'+'00'*31+'55','generation':1,'source_intent_digest':'0x'+bytes([i+7]).hex()*32,'gas_limit':1 if i==2 else 3,'estimated_cost':str((1<<240)+17+i)}for i in(2,3)]
  for i in range(5):
   gas=((1<<200)+101)*(1 if i==2 else 3)//4 if i in(2,3)else(1<<200)+123+i;tokens=((1<<240)+17)*(1 if i==2 else 3)//4 if i in(2,3)else(1<<240)+456+i
   identity={'kind':'signature512'if i==1 else'hash256','hex':'0x'+('ab'*32+'cd'*32 if i==1 else '00'*31+('44'if i==0 else'77'if i==4 else'66'))}
   marker=bytes([1 if i==1 else 0])+bytes.fromhex(identity['hex'][2:])+tokens.to_bytes(32,'little')+gas.to_bytes(32,'little')
   authority={'protocol':'sealevel'if i==1 else'aleo'if i==4 else'starknet','origin':9913371,'destination':9913372,'mailbox':'0x'+('33'*32 if i==1 else'00'*31+'33'),'chain_id':'public-native-storage-fixture'if i==1 else'testnet'if i==4 else'0x534e5f5345504f4c4941','origin_hook':'0x'+('55'*32 if i==1 else'00'*31+'55'),'operation_id':ids[i],'generation':1,'kind':'process','target':'0x'+'00'*31+'77'if i==4 else None}
   quote={'gas_limit':1 if i==2 else 3 if i==3 else 100,'estimated_cost':str((1<<240)+17+i),'batch':{'version':1,'members':copy.deepcopy(members)}if i in(2,3)else None}if i in(0,2,3)else None
   written={'id':ids[i],'nonce':i,'context':'0x'+bytes([9 if i==3 else 7+i]).hex()*32,'generation':1,'stage':'submitting','confirmation_started':True,'deadline':{'unix_ms':1800000600000,'delay_ms':600000},'identity':identity,'row':{'bytes':1,'sha256':'0x'+'11'*32},'stored_canonical_intent':{'bytes':2,'sha256':'0x'+'22'*32},'signed':{'bytes':3,'sha256':'0x'+'33'*32},'authority':authority,'gas_used_hex':'0x'+gas.to_bytes(32,'big').hex(),'tokens_used_hex':'0x'+tokens.to_bytes(32,'big').hex(),'payment_hex':'0x'+((1<<192)+789+i).to_bytes(32,'big').hex(),'payment_gas_hex':'0x'+((1<<160)+101112+i).to_bytes(32,'big').hex(),'starknet':quote}
   op=copy.deepcopy(written);op.update(retries=0,expected_context_checked=True,origin=9913371,destination=9913372,kind='process',target=None,expenditure={'present':True,'marker':{'bytes':len(marker),'sha256':'0x'+hashlib.sha256(marker).hexdigest()},'gas_used_hex':written['gas_used_hex'],'tokens_used_hex':written['tokens_used_hex']});op.pop('id')
   expected['rows'].append(written);value['rows'].append({'id':ids[i],'present':True,'operation':op})
  return expected,value
 def test_interop_family_guard_accepts_exact_public_structural_sample(self):
  self.verifier()(*self.sample())
 def test_interop_family_guard_rejects_same_writer_reader_wrong_resolved_aleo_program(self):
  expected,value=self.sample();expected['rows'][4]['authority']['target']='0x'+'00'*31+'78';value['rows'][4]['operation']['authority']['target']=expected['rows'][4]['authority']['target']
  with self.assertRaises(AssertionError):self.verifier()(expected,value)
 def test_interop_family_guard_rejects_float_or_truncated_large_cost_even_when_both_agree(self):
  for wrong in [float((1<<240)+17),str((1<<240)+16),None]:
   expected,value=self.sample();expected['rows'][0]['starknet']['estimated_cost']=wrong;value['rows'][0]['operation']['starknet']['estimated_cost']=wrong
   with self.assertRaises(AssertionError):self.verifier()(expected,value)
 def test_interop_family_guard_rejects_same_swapped_group_manifest_order(self):
  expected,value=self.sample()
  for i in(2,3):
   expected['rows'][i]['starknet']['batch']['members'].reverse();value['rows'][i]['operation']['starknet']['batch']['members'].reverse()
  with self.assertRaises(AssertionError):self.verifier()(expected,value)
 def test_interop_family_guard_rejects_missing_quote_and_shortened_identity(self):
  expected,value=self.sample();expected['rows'][2]['starknet']=None;value['rows'][2]['operation']['starknet']=None
  with self.assertRaises(AssertionError):self.verifier()(expected,value)
  expected,value=self.sample();expected['rows'][1]['identity']['hex']=expected['rows'][1]['identity']['hex'][:66];value['rows'][1]['operation']['identity']['hex']=expected['rows'][1]['identity']['hex']
  with self.assertRaises(AssertionError):self.verifier()(expected,value)
 def test_interop_uses_actual_group_barriers_and_reader_pin_not_raw_row_writer(self):
  source=(BASE.parents[1]/'src/native_rows_interop_fixture.zig').read_text();self.assertIn('groups.Journal.create',source);self.assertIn('.signed = &signed',source);self.assertIn('.confirming =',source);self.assertNotIn('identity_hex',source)
  source=(BASE.parents[1]/'integration/native_rows_interop.py').read_text();self.assertIn("parser.add_argument('--reader-sha256',required=True)",source);self.assertIn('args.reader_sha256',source);self.assertIn('actual-zig-readonly-reopen',source)
if __name__=='__main__':unittest.main()
