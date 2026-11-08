"""Pure platform/API/ELF controls; no fixture import, process, SDK or CLI run."""
import argparse,ast,copy,hashlib,importlib.util,json,os,pathlib,platform,shutil,sys,tempfile,types,unittest
from unittest import mock
HERE=pathlib.Path(__file__).resolve().parent
REPO=pathlib.Path(os.environ.get('PAIRED_PLATFORM_CONTROL_REPO',str(HERE.parents[1]))).resolve()
CANDIDATE=HERE.parents[1]
def functions(relative,names,extra=None):
 path=CANDIDATE/relative;tree=ast.parse(path.read_text());nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name in names];assert{n.name for n in nodes}==set(names)
 ns={'ROOT':REPO,'pathlib':pathlib,'Path':pathlib.Path,'hashlib':hashlib,'json':json,'sys':sys,'os':os,'platform':platform,'argparse':argparse,'shutil':shutil,**(extra or{})};exec(compile(ast.Module(body=nodes,type_ignores=[]),str(path),'exec'),ns);return ns

def parse_prefix(relative,argv):
 path=CANDIDATE/relative;tree=ast.parse(path.read_text());main=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='main');end=next(i for i,n in enumerate(main.body)if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='args'for t in n.targets))
 ns={'argparse':argparse,'pathlib':pathlib,'ROOT':REPO,'IMMUTABLE_ORACLE':REPO/'old-oracle','relayer_process':types.SimpleNamespace(IMMUTABLE_ORACLE=REPO/'old-oracle')}
 with mock.patch.object(sys,'argv',[str(path),*argv]):exec(compile(ast.Module(body=main.body[:end+1],type_ignores=[]),str(path),'exec'),ns)
 return ns['args']
class Platform(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=pathlib.Path(self.temp.name).resolve()
 def tools(self):
  # Existing independent synthetic ELF/Source-gate fixture, with the real
  # current load_manifest validator. These bytes are never executed.
  path=REPO/'zig/bench/native_case_tools_test.py';spec=importlib.util.spec_from_file_location('platform_tool_controls',path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);control=m.Controls('runTest');control.root=self.root;control.commit='a'*40;gate,manifest=control.fixture();manifest_path=control.save(gate,manifest)
  return self.root/'bin/ziggy-rocks-oracle',manifest_path,m.m.sha(manifest_path),control.commit,m
 def oracle(self):return functions('zig/integration/relayer_process.py',{'verified_oracle'},{'IMMUTABLE_ORACLE_SHA256':'8e295002b44b4248d00d6627aaa47a21'+'2315f6f837f3a2d652f2e7f6ada69fd9'})['verified_oracle']
 def test_actual_tool_manifest_and_ELF_admit_exact_Linux_oracle_only(self):
  oracle,manifest,digest,commit,m=self.tools();fn=self.oracle()
  with mock.patch.object(sys,'platform','linux'),mock.patch.object(platform,'machine',return_value='x86_64'):
   self.assertEqual(fn(oracle,manifest,digest,commit),oracle)
   copied=self.root/'foreign-same-bytes';copied.write_bytes(oracle.read_bytes())
   with self.assertRaisesRegex(ValueError,'exact Source-qualified tool member'):fn(copied,manifest,digest,commit)
   for changes in [(manifest,'f'*64,commit),(manifest,digest,'b'*40)]:
    with self.assertRaises(ValueError):fn(oracle,*changes)
   oracle.write_bytes(b'\xcf\xfa\xed\xfe'+bytes(1020))
   with self.assertRaises(ValueError):fn(oracle,manifest,digest,commit)
 def test_all_partial_Linux_trios_and_Mac_manifest_overrides_refuse(self):
  fn=self.oracle();path=self.root/'unread';trio=[path,'a'*64,'b'*40]
  with mock.patch.object(sys,'platform','linux'):
   for bits in range(7):
    with self.subTest(bits=bits),self.assertRaisesRegex(ValueError,'complete tool manifest'):fn(path,*[v if bits&(1<<i)else None for i,v in enumerate(trio)])
  with mock.patch.object(sys,'platform','darwin'):
   for bits in range(1,8):
    with self.subTest(bits=bits),self.assertRaisesRegex(ValueError,'cannot override'):fn(path,*[v if bits&(1<<i)else None for i,v in enumerate(trio)])
 def test_Mac_hash_constant_and_default_logic_unchanged(self):
  source=(CANDIDATE/'zig/integration/relayer_process.py').read_text();tree=ast.parse(source);value=next(n.value for n in tree.body if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='IMMUTABLE_ORACLE_SHA256'for t in n.targets));self.assertEqual(eval(compile(ast.Expression(value),'literal-Mac-digest','eval')),'8e295002b44b4248d00d6627aaa47a21'+'2315f6f837f3a2d652f2e7f6ada69fd9')
  path=self.root/'bad-Mac-oracle';path.write_bytes(b'wrong')
  with mock.patch.object(sys,'platform','darwin'),self.assertRaisesRegex(AssertionError,'immutable'):self.oracle()(path)
 def test_three_actual_functional_parsers_accept_same_trio_and_no_missing_attributes(self):
  for name in ['relayer_process','relayer_stream','public_relay_process']:
   args=parse_prefix('zig/integration/'+name+'.py',['--tool-manifest',str(self.root/'manifest.json'),'--tool-manifest-sha256','a'*64,'--tool-source-commit','b'*40]);self.assertEqual(args.tool_manifest,self.root/'manifest.json');self.assertEqual(args.tool_manifest_sha256,'a'*64);self.assertEqual(args.tool_source_commit,'b'*40)
   tree=ast.parse((CANDIDATE/'zig/integration'/(name+'.py')).read_text());calls=[n for n in ast.walk(tree)if isinstance(n,ast.Call)and ((isinstance(n.func,ast.Name)and n.func.id=='verified_oracle')or(isinstance(n.func,ast.Attribute)and n.func.attr=='verified_oracle'))];self.assertEqual(len(calls),1);self.assertEqual(len(calls[0].args),4)
 def test_benchmark_parser_trio_and_validator_reference_flags(self):
  args=parse_prefix('zig/bench/validator.py',['--url-library',str(self.root/'url.so'),'--message-reference',str(self.root/'ref'),'--evm-oracle',str(self.root/'evm')]);self.assertEqual(args.message_reference,self.root/'ref');self.assertEqual(args.evm_oracle,self.root/'evm')
  fn=functions('zig/bench/relayer.py',{'parse_args'})['parse_args']
  with mock.patch.object(sys,'argv',['relayer.py','paired','--tool-manifest',str(self.root/'manifest.json'),'--tool-manifest-sha256','a'*64,'--tool-source-commit','b'*40]):args=fn()
  self.assertEqual(args.tool_manifest,self.root/'manifest.json');self.assertEqual(args.samples,5);self.assertEqual(args.steady_interval_ms,500);self.assertEqual(args.settlement_deadline,660)
 def test_validator_references_use_real_ELF_validator_outside_agent_timers(self):
  oracle,manifest,digest,commit,m=self.tools();fn=functions('zig/bench/validator.py',{'validation_references','digest'})['validation_references'];reference=self.root/'bin/ziggy-rust-reference'
  with mock.patch.object(sys,'platform','linux'),mock.patch.object(platform,'machine',return_value='x86_64'):
   first,second,pins=fn(reference,oracle);self.assertEqual((first,second),(reference,oracle));self.assertEqual(set(pins),{'message_reference','evm_oracle'});self.assertEqual(pins['message_reference']['elf']['machine'],62)
   for a,b in [(None,oracle),(reference,None),(None,None)]:
    with self.assertRaisesRegex(ValueError,'requires message-reference'):fn(a,b)
   reference.write_bytes(m.elf(183))
   with self.assertRaises(ValueError):fn(reference,oracle)
  with mock.patch.object(sys,'platform','darwin'):
   first,second,pins=fn(None,None);self.assertEqual(first,REPO/'zig/reference/target/release/ziggy-rust-reference');self.assertIsNone(pins)
   with self.assertRaises(ValueError):fn(reference,oracle)
 def test_curl_and_Rust_environment_keysets_preserve_original_profile(self):
  curl=functions('zig/integration/relayer_process.py',{'curl_library'})['curl_library']
  with mock.patch.object(sys,'platform','darwin'),mock.patch.dict(os.environ,{'HYPERLANE_CURL_LIBRARY':'private-sentinel'}):self.assertEqual(curl(False),'/usr/lib/libcurl.4.dylib');self.assertEqual(curl(True),'private-sentinel')
  v=functions('zig/bench/validator.py',{'daemon_environment'},{'CURL_LIBRARY':'/verified/libcurl.so.4'})['daemon_environment'];args=(self.root/'config',{'pinned_path':'/verified/url.so'});self.assertEqual(v('rust',*args),{'HYPERLANE_ZIG_DEFAULTS':str(args[0]),'HYPERLANE_CURL_LIBRARY':'/verified/libcurl.so.4'});self.assertEqual(set(v('zig',*args)),{'HYPERLANE_ZIG_DEFAULTS','HYPERLANE_CURL_LIBRARY','HYPERLANE_URL_LIBRARY'})
  r=functions('zig/bench/relayer.py',{'environment'},{'CURL_LIBRARY':'/verified/libcurl.so.4'})['environment'];self.assertEqual(r('rust',self.root/'config.json',self.root/'config'),{'CONFIG_FILES':str(self.root/'config.json')})
 def test_curl_Linux_aliases_must_resolve_unique_fixed_system_identity(self):
  for relative,names in [('zig/integration/relayer_process.py',{'curl_library'}),('zig/bench/validator.py',{'curl_library'})]:
   fn=functions(relative,names)['curl_library'];first=self.root/'libcurl-a';second=self.root/'libcurl-b';paths={'/usr/lib/x86_64-linux-gnu/libcurl.so.4','/lib/x86_64-linux-gnu/libcurl.so.4'}
   with mock.patch.object(sys,'platform','linux'),mock.patch.object(platform,'machine',return_value='x86_64'),mock.patch.object(pathlib.Path,'is_file',lambda p:str(p)in paths):
    with mock.patch.object(pathlib.Path,'resolve',lambda p,**kw:first):self.assertEqual(fn(False)if relative.endswith('relayer_process.py')else fn(),str(first))
    with mock.patch.object(pathlib.Path,'resolve',lambda p,**kw:first if str(p).startswith('/usr')else second),self.assertRaisesRegex(ValueError,'ambiguous'):fn(False)if relative.endswith('relayer_process.py')else fn()
 def test_Linux_relayer_provenance_uses_actual_manifest_not_Mac_hash(self):
  oracle,manifest,digest,commit,m=self.tools();binaries={};value={'baseline':'c520224','oracle_sha256':hashlib.sha256(oracle.read_bytes()).hexdigest()}
  for i,name in enumerate(['rust','zig','rust_validator','zig_validator']):
   path=self.root/name;path.write_bytes(('public fixture'+str(i)).encode());binaries[name]=path;value[name+'_sha256']=hashlib.sha256(path.read_bytes()).hexdigest()
  path=self.root/'provenance.json';path.write_text(json.dumps(value));fn=functions('zig/bench/relayer.py',{'load_provenance','digest','chunks'},{'relayer_process':types.SimpleNamespace(verified_oracle=self.oracle()),'ACCEPTED_ORACLE_SHA256':'8e295002b44b4248d00d6627aaa47a21'+'2315f6f837f3a2d652f2e7f6ada69fd9'})['load_provenance']
  with mock.patch.object(sys,'platform','linux'),mock.patch.object(platform,'machine',return_value='x86_64'):
   self.assertEqual(fn(path,binaries,oracle,manifest,digest,commit),value)
   with self.assertRaisesRegex(ValueError,'complete tool manifest'):fn(path,binaries,oracle)
   value['oracle_sha256']='f'*64;path.write_text(json.dumps(value))
   with self.assertRaisesRegex(RuntimeError,'actual accepted Linux provenance'):fn(path,binaries,oracle,manifest,digest,commit)
 def test_all_measured_process_class_AST_unchanged(self):
  for path in ['zig/bench/validator.py','zig/bench/relayer.py']:
   current=ast.parse((REPO/path).read_text());candidate=ast.parse((CANDIDATE/path).read_text());before=next(n for n in current.body if isinstance(n,ast.ClassDef)and n.name=='MeasuredProcess');after=next(n for n in candidate.body if isinstance(n,ast.ClassDef)and n.name=='MeasuredProcess');self.assertEqual(ast.dump(before),ast.dump(after))
 def test_crash_C_bytes_equal_prior_component_evidence(self):
  expected={'seal_crash.c':'19746ba835ba4f64be1dfa1dafd4a12a3'+'4675dc8df3619054eb21d5f133c0abd','seal_crash_test.c':'932a27beb5817820b0bd6ed0c42051fd'+'b49a305b3b1badf967cf9b05f7aa9bb8'}
  for name,digest in expected.items():self.assertEqual(hashlib.sha256((CANDIDATE/'zig/integration/faults'/name).read_bytes()).hexdigest(),digest)
def audit(event,args):
 if event.startswith('socket.')or event in {'subprocess.Popen','os.fork','os.exec','ctypes.dlopen'}:raise RuntimeError('pure platform control refused '+event)
if __name__=='__main__':sys.addaudithook(audit);unittest.main()
