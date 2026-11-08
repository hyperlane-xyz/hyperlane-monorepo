"""Pure native ELF selection controls. No loader, CLI or process execution."""
import importlib.util
from pathlib import Path
import struct,tempfile,unittest
P=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('stark_dso_selection',P/'native_starknet_assets.py');api=importlib.util.module_from_spec(spec);spec.loader.exec_module(api)
class Controls(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve()
 def elf(self,name,machine=62,kind=3,elfclass=2):
  raw=bytearray(64);raw[:7]=b'\x7fELF'+bytes([elfclass,1,1]);struct.pack_into('<HH',raw,16,kind,machine);p=self.root/name;p.write_bytes(raw);return p
 def test_native_plus_multilib_candidates_selects_only_native(self):
  native=self.elf('libc64.so');foreign=self.elf('libc32.so',3,elfclass=1);self.assertEqual(api.resolve_system_dso({native,foreign},'libc.so.6','amd64'),native)
  arm=self.elf('libcarm.so',183);self.assertEqual(api.resolve_system_dso({native,foreign,arm},'libc.so.6','arm64'),arm)
 def test_aliases_are_one_but_distinct_native_duplicates_refuse(self):
  native=self.elf('native.so');alias=self.root/'alias.so';alias.symlink_to(native);self.assertEqual(api.resolve_system_dso({native,alias},'libc.so.6','amd64'),native)
  with self.assertRaisesRegex(ValueError,'Ambiguous'):api.resolve_system_dso({native,self.elf('second.so')},'libc.so.6','amd64')
 def test_missing_foreign_malformed_executable_and_excess_refuse(self):
  native=self.elf('native.so');bad=self.root/'bad';bad.write_bytes(b'x'*64)
  for candidates in (set(),{self.elf('foreign',183)},{bad},{self.elf('executable',kind=2)},[native]*17):
   with self.subTest(candidates=candidates),self.assertRaises(ValueError):api.resolve_system_dso(candidates,'libc.so.6','amd64')
 def test_header_selection_does_not_change_mode_or_admit_loader(self):
  native=self.elf('header-only');native.chmod(0o600);self.assertEqual(api.resolve_system_dso({native},'libc.so.6','amd64'),native);self.assertEqual(native.stat().st_mode&0o777,0o600)
  with self.assertRaises(ValueError):api.elf_dynamic(native,62)
if __name__=='__main__':unittest.main()
