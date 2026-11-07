"""No Cargo/network/native execution. Pin/transaction controls for one SPL source."""
import gzip,hashlib,importlib.util,pathlib,re,tempfile,tomllib,unittest
from unittest import mock
spec=importlib.util.spec_from_file_location('svm_overlay',pathlib.Path(__file__).with_name('svm_prerequisites.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Controls(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=pathlib.Path(self.tmp.name);self.fork=self.root/'fork';(self.fork/'token/cli').mkdir(parents=True)
  self.asset=pathlib.Path(m.__file__).parent/'fixtures/spl-token-e101cca.Cargo.lock.gz';self.wire=gzip.decompress(self.asset.read_bytes())
  self.old=re.sub(rb'\[\[package\]\]\nname = "(?:litemap|zerofrom)"\n.*?(?=\[\[package\]\]|\Z)',b'',self.wire,flags=re.S).replace(b' "litemap",\n',b'').replace(b' "zerofrom",\n',b'')
  self.assertEqual(hashlib.sha256(self.old).hexdigest(),m.SPL_UPSTREAM_LOCK_SHA256)
  (self.fork/'Cargo.lock').write_bytes(self.old);self.cli=self.fork/'token/cli/Cargo.toml';self.cli.write_bytes(b'# public test CLI identity; actual upstream tuple separately replayed\nzerofrom="=0.1.5"\nlitemap="=0.7.4"\n');self.cli_sha=hashlib.sha256(self.cli.read_bytes()).hexdigest();self.output=self.root/'original.gz'
 def apply(self,**kw):
  with mock.patch.object(m,'SPL_CLI_SHA256',self.cli_sha):return m.apply_spl_lock_overlay(self.fork,kw.get('asset',self.asset),kw.get('commit',m.SPL_COMMIT),kw.get('tree',m.SPL_TREE),self.output)
 def test_actual_canonical_asset_has_only_two_missing_source_dependencies(self):
  before=tomllib.loads(self.old.decode())['package'];after=tomllib.loads(self.wire.decode())['package'];key=lambda p:(p['name'],p['version'],p.get('source'))
  a={key(p):p for p in before};b={key(p):p for p in after};self.assertEqual(len(a),803);self.assertEqual(len(b),805);self.assertEqual({(x[0],x[1])for x in b.keys()-a.keys()},{('litemap','0.7.4'),('zerofrom','0.1.5')})
  changed=[x for x in a if a[x]!=b[x]];self.assertEqual(changed,[('spl-token-cli','4.0.1',None)])
  for x in a:
   observed=dict(b[x]);original=dict(a[x])
   if x[0]=='spl-token-cli':observed['dependencies']=[d for d in observed['dependencies']if d not in ['litemap','zerofrom']]
   self.assertEqual(original,observed)
 def test_overlay_keeps_lossless_original_and_explicit_nonidentical_source_receipt(self):
  result=self.apply();self.assertEqual((self.fork/'Cargo.lock').read_bytes(),self.wire);self.assertEqual(gzip.decompress(self.output.read_bytes()),self.old);self.assertEqual(result['working_tree_diff'],['Cargo.lock']);self.assertFalse(result['publisher_source_byte_identical']);self.assertFalse(result['lock_resolved_during_CI']);self.assertFalse(result['native_profile_admitted'])
 def test_wrong_source_commit_and_tree_reject_before_output(self):
  for kw in [{'commit':'0'*40},{'tree':'0'*40}]:
   with self.subTest(kw=kw),self.assertRaisesRegex(ValueError,'exact approved source'):self.apply(**kw)
  self.assertFalse(self.output.exists());self.assertEqual((self.fork/'Cargo.lock').read_bytes(),self.old)
 def test_wrong_original_lock_rejects(self):
  (self.fork/'Cargo.lock').write_bytes(b'unapproved')
  with self.assertRaisesRegex(ValueError,'source pair differs'):self.apply()
  self.assertFalse(self.output.exists())
 def test_changed_cli_identity_rejects(self):
  self.cli.write_bytes(b'changed manifest')
  with self.assertRaisesRegex(ValueError,'source pair differs'):self.apply()
  self.assertFalse(self.output.exists())
 def test_changed_canonical_bytes_reject_before_lock_mutation(self):
  bad=self.root/'bad.gz';bad.write_bytes(gzip.compress(self.wire+b'changed',mtime=0))
  with self.assertRaisesRegex(ValueError,'canonical lock asset differs'):self.apply(asset=bad)
  self.assertFalse(self.output.exists());self.assertEqual((self.fork/'Cargo.lock').read_bytes(),self.old)
 def test_linked_canonical_asset_reject_before_lock_mutation(self):
  link=self.root/'link.gz';link.symlink_to(self.asset)
  with self.assertRaises(ValueError):self.apply(asset=link)
  self.assertFalse(self.output.exists());self.assertEqual((self.fork/'Cargo.lock').read_bytes(),self.old)
 def test_existing_original_evidence_never_overwritten(self):
  self.output.write_bytes(b'preserve')
  with self.assertRaises(FileExistsError):self.apply()
  self.assertEqual(self.output.read_bytes(),b'preserve');self.assertEqual((self.fork/'Cargo.lock').read_bytes(),self.old)
 def test_second_overlay_is_not_generic_unlock(self):
  self.apply()
  with self.assertRaisesRegex(ValueError,'source pair differs'):self.apply()
 def test_ci_retains_frozen_locked_fetch_and_build(self):
  source=pathlib.Path(m.__file__).read_text();self.assertIn("'fetch','--locked','--manifest-path'",source);self.assertIn("'build','--frozen','--offline'",source);self.assertNotIn("'generate-lockfile'",source)
if __name__=='__main__':unittest.main(verbosity=2)
