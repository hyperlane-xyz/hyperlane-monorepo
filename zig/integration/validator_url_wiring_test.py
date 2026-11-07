#!/usr/bin/env python3
"""Pure validator launcher controls. No roles, nodes, compilers or fixture mains."""
import argparse,ast,copy,hashlib,importlib,importlib.util,json,pathlib,platform,re,shutil,subprocess,sys,tempfile,types,unittest
from unittest import mock
ROOT=pathlib.Path(__file__).resolve().parents[2]

def selected(path,names,namespace):
 tree=ast.parse((ROOT/path).read_text());nodes=[node for node in tree.body if isinstance(node,(ast.FunctionDef,ast.ClassDef))and node.name in names]
 assert len(nodes)==len(names),(path,names)
 exec(compile(ast.fix_missing_locations(ast.Module(body=nodes,type_ignores=[])),str(path),'exec'),namespace)
 return namespace

def helper(namespace=None):
 ns={'pathlib':pathlib,'platform':platform,'hashlib':hashlib,'shutil':shutil,'ROOT':ROOT}
 ns.update(namespace or {})
 return selected('zig/integration/validator.py',{'url_dependency'},ns)['url_dependency']

def native_header():
 data=bytearray(128);arm=platform.machine().lower()in('arm64','aarch64')
 if platform.system()=='Darwin':data[:4]=bytes.fromhex('cffaedfe');data[4:8]=(0x100000c if arm else 0x1000007).to_bytes(4,'little');data[12:16]=(6).to_bytes(4,'little')
 elif platform.system()=='Linux':data[:6]=b'\x7fELF\x02\x01';data[16:18]=(3).to_bytes(2,'little');data[18:20]=(183 if arm else 62).to_bytes(2,'little')
 else:raise unittest.SkipTest('Mach-O/ELF fixture hosts only')
 return bytes(data)

class Wiring(unittest.TestCase):
 def setUp(self):self.tmp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.tmp.name);self.lib=self.root/'input';self.lib.write_bytes(native_header());self.pin=self.root/'pins'
 def tearDown(self):self.tmp.cleanup()
 def test_library_pin_records_all_bytes_and_remains_independent_of_source(self):
  record=helper()(self.lib,self.pin);self.assertEqual(record['bytes'],128);self.assertEqual(''.join(record['sha256_chunks']),hashlib.sha256(self.lib.read_bytes()).hexdigest());self.assertEqual(pathlib.Path(record['pinned_path']).read_bytes(),self.lib.read_bytes())
  self.lib.write_bytes(native_header()+b'changed');self.assertEqual(pathlib.Path(record['pinned_path']).read_bytes(),native_header())
 def test_missing_none_nonlibrary_wrong_type_and_wrong_arch_fail_before_pin(self):
  for wire in [b'',b'not a library'*20,native_header()[:32]]:
   self.lib.write_bytes(wire)
   with self.assertRaises(ValueError):helper()(self.lib,self.pin)
  data=bytearray(native_header());offset,width=(4,4)if platform.system()=='Darwin'else(18,2);data[offset:offset+width]=b'\0'*width;self.lib.write_bytes(data)
  with self.assertRaises(ValueError):helper()(self.lib,self.pin)
  self.assertFalse(self.pin.exists())
  with self.assertRaises(ValueError):helper()(None,self.pin)
  with self.assertRaises(FileNotFoundError):helper()(self.root/'absent',self.pin)
 def test_existing_pin_mismatch_rejected_without_overwrite(self):
  record=helper()(self.lib,self.pin);target=pathlib.Path(record['pinned_path']);target.write_bytes(b'foreign')
  with self.assertRaises(ValueError):helper()(self.lib,self.pin)
  self.assertEqual(target.read_bytes(),b'foreign')
 def test_pin_symlink_rejected(self):
  record=helper()(self.lib,self.pin);target=pathlib.Path(record['pinned_path']);target.unlink();target.symlink_to(self.lib)
  with self.assertRaises(ValueError):helper()(self.lib,self.pin)
 def test_copy_race_detected(self):
  def copy_and_mutate(source,target):shutil.copy2(source,target);source.write_bytes(native_header()+b'changed')
  with self.assertRaises(ValueError):helper({'shutil':types.SimpleNamespace(copy2=copy_and_mutate)})(self.lib,self.pin)
 def test_benchmark_rust_environment_exact_and_zig_only_adds_url(self):
  ns=selected('zig/bench/validator.py',{'daemon_environment'},{});record=helper()(self.lib,self.pin);old={'HYPERLANE_ZIG_DEFAULTS':'config','HYPERLANE_CURL_LIBRARY':'/usr/lib/libcurl.4.dylib'}
  self.assertEqual(ns['daemon_environment']('rust','config',record),old);self.assertEqual(ns['daemon_environment']('zig','config',record),{**old,'HYPERLANE_URL_LIBRARY':record['pinned_path']})
 def test_measured_constructor_receives_validated_pin_after_helper_before_clock(self):
  events=[];record=helper()(self.lib,self.pin);events.append('validated')
  def clock():self.assertEqual(events[0],'validated');events.append('clock');return 1
  def popen(command,**kwargs):self.assertEqual(kwargs['env']['HYPERLANE_URL_LIBRARY'],record['pinned_path']);self.assertEqual(events,['validated','clock']);return object()
  ns={'tempfile':tempfile,'time':types.SimpleNamespace(perf_counter_ns=clock),'subprocess':types.SimpleNamespace(Popen=popen)};selected('zig/bench/validator.py',{'MeasuredProcess','daemon_environment'},ns)
  process=ns['MeasuredProcess'](pathlib.Path('validator'),self.root,ns['daemon_environment']('zig','config',record));process.close()
  tree=ast.parse((ROOT/'zig/bench/validator.py').read_text());main=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='main');pin_line=next(n.lineno for n in ast.walk(main)if isinstance(n,ast.Call)and isinstance(n.func,ast.Attribute)and n.func.attr=='url_dependency');launch=next(n.lineno for n in ast.walk(main)if isinstance(n,ast.Call)and isinstance(n.func,ast.Name)and n.func.id=='MeasuredProcess');self.assertLess(pin_line,launch)
 def test_stream_fake_popen_receives_explicit_url_and_ca_on_every_start(self):
  calls=[];record=helper()(self.lib,self.pin);ns={'subprocess':types.SimpleNamespace(Popen=lambda *a,**kw:calls.append(kw)or object())};selected('zig/integration/validator_stream.py',{'Daemon'},ns);daemon=ns['Daemon'](pathlib.Path('validator'),self.root,self.root,pathlib.Path('public-ca'),self.root/'log',record)
  daemon.start();daemon.file.close();daemon.start();daemon.file.close();self.assertEqual(len(calls),2)
  for call in calls:self.assertEqual(set(call['env']),{'HYPERLANE_ZIG_DEFAULTS','HYPERLANE_CURL_LIBRARY','HYPERLANE_URL_LIBRARY','SSL_CERT_FILE'});self.assertEqual(call['env']['HYPERLANE_URL_LIBRARY'],record['pinned_path'])
 def test_driver_only_modes_do_not_require_url_library(self):
  for path,field in [('zig/integration/validator.py','daemon'),('zig/integration/generic_validator.py','task_driver')]:
   tree=ast.parse((ROOT/path).read_text());main=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='main');body=[]
   for node in main.body:
    body.append(copy.deepcopy(node))
    if isinstance(node,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='url_library'for t in node.targets):break
   main.body=body+[ast.Return(value=ast.Name(id='url_library',ctx=ast.Load()))];ns={'argparse':argparse,'pathlib':pathlib,'ROOT':ROOT,'url_dependency':helper(),'validator':types.SimpleNamespace(url_dependency=helper())};exec(compile(ast.fix_missing_locations(ast.Module(body=[main],type_ignores=[])),path,'exec'),ns)
   with mock.patch.object(argparse.ArgumentParser,'parse_args',return_value=types.SimpleNamespace(**{field:None,'url_library':None})):self.assertIsNone(ns['main']())
 def test_actual_relayer_validator_calls_supply_url_without_changing_shared_launch(self):
  tree=ast.parse((ROOT/'zig/integration/relayer_process.py').read_text());calls=[n for n in ast.walk(tree)if isinstance(n,ast.Call)and isinstance(n.func,ast.Name)and n.func.id=='launch'and n.args and isinstance(n.args[0],ast.Name)and n.args[0].id=='validator_binary'];self.assertEqual(len(calls),2)
  for call in calls:self.assertEqual(len(call.args),4);self.assertIn('HYPERLANE_URL_LIBRARY',ast.unparse(call.args[3]))
  launch=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='launch');self.assertNotIn('HYPERLANE_URL_LIBRARY',ast.unparse(launch))
 def test_direct_task_fixture_explicit_path_not_environment(self):
  wire=(ROOT/'zig/src/validator_task_integration.zig').read_text();self.assertIn('url_library: []const u8',wire);self.assertIn('.url_library = fixture.url_library',wire)
  wire=(ROOT/'zig/integration/generic_validator.py').read_text();self.assertIn("'url_library':url_library['pinned_path']",wire);self.assertIn('env={}',wire)
 def test_compiled_git_identity_validates_explicit_and_generated_options(self):
  ns=selected('zig/bench/build_validator.py',{'compiled_git_sha','service_options','build_command'},{'ROOT':ROOT,'subprocess':subprocess,'re':re});sha='a'*40
  self.assertEqual(ns['compiled_git_sha'](sha),sha)
  for bad in ['', 'bad','g'*40,sha+'\n','";secret']: 
   with self.assertRaises(ValueError):ns['compiled_git_sha'](bad)
  with mock.patch.object(subprocess,'check_output',return_value=sha+'\n'):self.assertEqual(ns['compiled_git_sha'](None),sha)
  with mock.patch.object(subprocess,'check_output',side_effect=OSError):self.assertEqual(ns['compiled_git_sha'](None),'VERGEN_IDEMPOTENT_OUTPUT')
  options=ns['service_options'](self.root,sha);self.assertIn('pub const git_sha = "'+sha+'";',options.read_text());self.assertEqual(options,ns['service_options'](self.root,sha));options.write_text('foreign')
  with self.assertRaises(ValueError):ns['service_options'](self.root,sha)
  command=ns['build_command'](types.SimpleNamespace(zig='zig',sdk_root=None),['archive'],'ReleaseSafe',options,self.root/'binary');self.assertIn('-Mservice_options='+str(options),command);self.assertNotIn('-Mservice_options=zig/bench/service_options.zig',command)
 def test_actual_import_both_orders_use_unique_integration_namespace_without_processes(self):
  def load(name,path):
   spec=importlib.util.spec_from_file_location(name,ROOT/path);module=importlib.util.module_from_spec(spec);sys.modules[name]=module;spec.loader.exec_module(module);return module
  with mock.patch.object(subprocess,'Popen',side_effect=AssertionError('process on import')),mock.patch.object(subprocess,'run',side_effect=AssertionError('process on import')),mock.patch.object(subprocess,'check_output',side_effect=AssertionError('process on import')):
   for helper_first in [False,True]:
    with mock.patch.dict(sys.modules),mock.patch.object(sys,'path',[str(ROOT/'zig/bench'),str(ROOT/'zig/integration'),str(ROOT),*sys.path]):
     sys.modules.pop('validator',None);sys.modules.pop('zig.integration.validator',None)
     if helper_first:integration=importlib.import_module('zig.integration.validator')
     bench=load('validator','zig/bench/validator.py')
     integration=importlib.import_module('zig.integration.validator')
     builder=load('validator_builder_review','zig/bench/build_validator.py')
     self.assertEqual(pathlib.Path(bench.__file__).resolve(),ROOT/'zig/bench/validator.py');self.assertEqual(pathlib.Path(integration.__file__).resolve(),ROOT/'zig/integration/validator.py')
     self.assertIs(bench.validator_fixture,integration);self.assertIs(builder.validator_fixture,integration);self.assertTrue(hasattr(bench,'MeasuredProcess'));self.assertIs(sys.modules['validator'],bench)
 def test_generated_options_reject_symlink_without_mutating_target(self):
  ns=selected('zig/bench/build_validator.py',{'service_options'},{});target=self.root/'foreign';target.write_bytes(b'preserve');path=self.root/('service_options-'+'a'*40+'.zig');path.symlink_to(target)
  with self.assertRaises(ValueError):ns['service_options'](self.root,'a'*40)
  self.assertEqual(target.read_bytes(),b'preserve')
 def test_legacy_builder_plan_only_generates_pinned_actual_options_without_compiler(self):
  output=self.root/'output';libraries=self.root/'libraries';libraries.write_text('\n'.join(str(self.root/str(i))for i in range(7)))
  args=types.SimpleNamespace(zig='compiler-must-not-run',sdk_root=None,git_sha='b'*40,url_library=self.lib,plan_only=True,native_db_libs_file=libraries,mode='both',output=output)
  ns={'ROOT':self.root,'argparse':argparse,'pathlib':pathlib,'hashlib':hashlib,'json':json,'re':re,'subprocess':subprocess,'validator_fixture':types.SimpleNamespace(url_dependency=helper())}
  selected('zig/bench/build_validator.py',{'main','compiled_git_sha','service_options','build_command','digest'},ns)
  with mock.patch.object(argparse.ArgumentParser,'parse_args',return_value=args),mock.patch.object(subprocess,'run',side_effect=AssertionError('compiler invoked')),mock.patch.object(subprocess,'check_output',side_effect=AssertionError('compiler version invoked')):ns['main']()
  plan=json.loads((output/'plan.json').read_text());self.assertFalse(plan['executed']);self.assertEqual(plan['compiled_git_sha'],'b'*40);self.assertEqual(len(plan['builds']),2)
  options=pathlib.Path(plan['service_options']['path']);self.assertEqual(''.join(plan['service_options']['sha256_chunks']),hashlib.sha256(options.read_bytes()).hexdigest());self.assertEqual(plan['url_library']['bytes'],128)
  for row in plan['builds']:self.assertFalse(row['executed']);self.assertIn('-Mservice_options='+str(options),row['command'])
 def test_no_clock_pacing_or_retirement_policy_delta_in_fixture_followthrough(self):
  # Source input wiring only: no changed runtime policy or weaker receipt checks.
  for path in ['zig/integration/relayer_process.py','zig/integration/relayer_stream.py']:
   self.assertIn('wait_for_retirement',(ROOT/path).read_text())
  self.assertIn('steady_interval_ms*1_000_000',(ROOT/'zig/bench/validator.py').read_text())

if __name__=='__main__':unittest.main()
