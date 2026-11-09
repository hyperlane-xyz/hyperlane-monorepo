#!/usr/bin/env python3
"""Cold runner regression controls. No compiler, native node or benchmark runs."""
import hashlib
import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest import mock

# Works as a file or unittest discovery from any cwd. Import the repository's
# actual runner modules; no saved old implementation or private proposal tree.
BENCH = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(BENCH))
import build_matrix as matrix
import cold_matrix_owner as owner

usage=lambda u=1.,s=.25,r=12:types.SimpleNamespace(ru_utime=u,ru_stime=s,ru_maxrss=r)
row=lambda pid=42,start='token',state='Z':dict(pid=pid,start=start,state=state,ppid=os.getpid(),pgid=20,sid=20,rss_bytes=0,observed_as_adopted_child=True)
def fixture():
 r=row();w={};matrix.remember_terminal_children({42:r},20,w,1.)
 receipt=dict(pid=42,start='token',waited_pid=42,status=256,actual_wait4_usage_available=True,rusage=owner.rusage_record(usage()))
 return {42:r},w,dict(clean=True,owned_present_before_stop=[],actual_adopted_child_waits=[receipt])
def account(k,w,c):return matrix.phase_accounting(usage(2.,.5,8),c,k,w,2.)
class CpuConfiguration(unittest.TestCase):
 def test_legacy_choices_explicitly_distinguish_native_from_baseline(self):
  env={'PATH':'/bin','CFLAGS':'legacy'}
  self.assertEqual(matrix.cpu_configuration('native',env,None),(env,['-Dcpu=native']))
  self.assertEqual(matrix.cpu_configuration('production-default',env,None),(env,['-Dcpu=baseline']))
  self.assertEqual(env,{'PATH':'/bin','CFLAGS':'legacy'})
  with self.assertRaises(ValueError):matrix.cpu_configuration('unknown',env,None)
  with self.assertRaises(ValueError):matrix.cpu_configuration('x86_64_v3',env,None)
  with self.assertRaises(ValueError):matrix.cpu_configuration('x86_64_v3_pclmul',env,None)
 def test_portable_selection_uses_shared_real_policy_and_platform_fence(self):
  cpu=matrix.cpu_module();env={'PATH':'/bin','RUSTFLAGS':'-Ctarget-cpu=native','CFLAGS':'-march=native','CXXFLAGS':'-march=native','GH_TOKEN':'not-consumed-by-pure-helper'}
  with mock.patch.object(matrix.platform,'system',return_value='Linux'),mock.patch.object(matrix.platform,'machine',return_value='x86_64'),mock.patch.object(matrix.platform,'libc_ver',return_value=('glibc','2.39')):
   actual,args=matrix.cpu_configuration('x86_64_v3_pclmul_native_abi',env,cpu)
  self.assertEqual(actual,cpu.portable_environment(env,tokio_unstable=True));self.assertEqual(args,cpu.zig_cpu_args('build'))
  self.assertEqual(cpu.PROFILE,'linux-x86_64-v3-pclmul-native-abi-v1');self.assertIn('pclmulqdq',cpu.REQUIRED_FLAGS);self.assertEqual(actual['CFLAGS'],'-march=x86-64-v3 -mtune=generic -mpclmul');self.assertEqual(args,['-Dtarget=native','-Dcpu=x86_64_v3+pclmul'])
  self.assertNotIn('native',actual['RUSTFLAGS']);self.assertNotIn('native',actual['CFLAGS']);self.assertEqual(env['RUSTFLAGS'],'-Ctarget-cpu=native')
  for system,machine in [('Darwin','x86_64'),('Linux','aarch64')]:
   with mock.patch.object(matrix.platform,'system',return_value=system),mock.patch.object(matrix.platform,'machine',return_value=machine),self.assertRaises(ValueError):matrix.cpu_configuration('x86_64_v3_pclmul_native_abi',env,cpu)

 def test_portable_native_ABI_refuses_musl_and_unknown_libc_without_changing_ISA(self):
  cpu=matrix.cpu_module()
  for libc in [('musl','1.2.5'),('','')]:
   with self.subTest(libc=libc),mock.patch.object(matrix.platform,'system',return_value='Linux'),mock.patch.object(matrix.platform,'machine',return_value='x86_64'),mock.patch.object(matrix.platform,'libc_ver',return_value=libc),self.assertRaisesRegex(ValueError,'GNU host'):matrix.cpu_configuration('x86_64_v3_pclmul_native_abi',{'PATH':'/bin'},cpu)

class CpuPlans(unittest.TestCase):
 def plan(self,policy):
  with tempfile.TemporaryDirectory()as directory:
   root=pathlib.Path(directory);libraries=root/'libs';libraries.write_text(','.join(str(root/('lib'+str(i)+'.a'))for i in range(7)));pq=root/'libpq.so';pq.write_bytes(b'not executed');output=root/'plan'
   args=['build_matrix.py','--compiler','never-executed-zig','--native-db-libs-file',str(libraries),'--libpq-library',str(pq),'--cpu',policy,'--git-sha','a'*40,'--native-cold','--optional-native-sdks','--output',str(output)]
   with mock.patch.object(sys,'argv',args),mock.patch.object(matrix.platform,'system',return_value='Linux'),mock.patch.object(matrix.platform,'machine',return_value='x86_64'),mock.patch.object(matrix.platform,'libc_ver',return_value=('glibc','2.39')),mock.patch.object(subprocess,'Popen',side_effect=AssertionError('plan executed child')):
    matrix.main()
   return __import__('json').loads((output/'plan.json').read_text())
 def test_actual_portable_plan_covers_both_Zig_modes_Rust_and_native7_without_wait_credit(self):
  plan=self.plan('x86_64_v3_pclmul_native_abi');cpu=matrix.cpu_module();self.assertEqual(plan['cpu_policy'],'x86_64_v3_pclmul_native_abi')
  native=next(p for p in plan['phases']if p['name']=='native-sdk-cold');self.assertEqual(len(native['artifacts']),7);self.assertEqual(native['command'][native['command'].index('--cpu-profile')+1],'x86_64_v3_pclmul_native_abi');self.assertEqual(native['command'][native['command'].index('--git-sha')+1],'a'*40);self.assertTrue(native['CPU_manifest'].endswith('/manifest.json'));self.assertNotIn('CPU_recipe',native)
  zig=[p for p in plan['phases']if p['name'].startswith('zig-')];self.assertEqual(len(zig),4)
  for phase in plan['phases']:
   if phase is native:continue
   self.assertIsNone(phase['CPU_recipe']['actual_parent_wait']);self.assertIsNone(phase['CPU_recipe']['exit_code'])
   if phase in zig:self.assertEqual([v for v in phase['command']if v.startswith(('-Dtarget=','-Dcpu='))],cpu.zig_cpu_args('build'))
   else:self.assertEqual(phase['environment']['RUSTFLAGS'],'--cfg tokio_unstable -Ctarget-cpu=x86-64-v3 -Ctarget-feature=+pclmulqdq')
 def test_actual_production_default_plan_uses_explicit_Zig_baseline(self):
  plan=self.plan('production-default')
  for phase in plan['phases']:
   if phase['name'].startswith('zig-'):self.assertEqual([v for v in phase['command']if v.startswith('-Dcpu=')],['-Dcpu=baseline'])
   self.assertNotIn('CPU_recipe',phase)

class Accounting(unittest.TestCase):
 def test_terminal_before_parent_and_actual_reap_accepted(self):
  k,w,c=fixture();a=account(k,w,c);self.assertTrue(a['phase_owned_quiescent']);self.assertTrue(a['phase_rusage_complete']);self.assertEqual((a['cpu_user_seconds'],a['cpu_system_seconds']),(3.,.75));self.assertEqual(a['maximum_child_RSS_bytes'],owner.rusage_record(usage())['maximum_child_RSS_bytes'])
 def test_nonzero_terminal_child_is_not_a_failed_cargo_parent(self):
  k,w,c=fixture();self.assertEqual(c['actual_adopted_child_waits'][0]['status'],256);self.assertTrue(account(k,w,c)['phase_rusage_complete'])
 def test_live_at_parent_exit_then_cleanup_z_cannot_mint_witness(self):
  k,w,c=fixture();w.clear();matrix.remember_terminal_children({42:row(state='S')},20,w,1.);k[42]['state']='Z';a=account(k,w,c);self.assertFalse(a['phase_owned_quiescent']);self.assertIsNone(a['cpu_user_seconds'])
 def test_first_seen_z_only_after_parent_rejected(self):
  k,w,c=fixture();w.clear();self.assertFalse(account(k,w,c)['phase_owned_quiescent'])
 def test_pid_reuse_not_identity(self):
  k,w,c=fixture();w[(42,'token')]['start']='different';w[(42,'different')]=w.pop((42,'token'));self.assertFalse(account(k,w,c)['phase_owned_quiescent'])
 def test_missing_actual_wait_rejected(self):
  k,w,c=fixture();c['actual_adopted_child_waits']=[];self.assertFalse(account(k,w,c)['phase_owned_quiescent'])
 def test_unknown_extra_reap_rejected(self):
  k,w,c=fixture();c['actual_adopted_child_waits'][0]['pid']=43;self.assertFalse(account(k,w,c)['phase_owned_quiescent'])
 def test_duplicate_reap_cannot_doublecount(self):
  k,w,c=fixture();c['actual_adopted_child_waits']*=2;self.assertFalse(account(k,w,c)['phase_rusage_complete'])
 def test_bad_status_identity_and_unavailable_usage_rejected(self):
  for key,value in [('status',(signal.SIGSTOP<<8)|0x7f),('status',True),('waited_pid',43),('actual_wait4_usage_available',False)]:
   with self.subTest(key=key):
    k,w,c=fixture();c['actual_adopted_child_waits'][0][key]=value;self.assertFalse(account(k,w,c)['phase_rusage_complete'])
 def test_raw_usage_must_bind_normalized_totals(self):
  for field,value in [('cpu_user_seconds',9.),('maximum_child_RSS_bytes',999999)]:
   k,w,c=fixture();c['actual_adopted_child_waits'][0]['rusage'][field]=value;self.assertFalse(account(k,w,c)['phase_rusage_complete'])
 def test_invalid_raw_usage_rejected(self):
  for v in [-1.,float('inf'),float('nan'),True,None]:
   k,w,c=fixture();c['actual_adopted_child_waits'][0]['rusage']['raw']['ru_utime']=v;self.assertFalse(account(k,w,c)['phase_rusage_complete'])
 def test_late_witness_and_missing_parent_probe_rejected(self):
  for field,value in [('observed_elapsed_seconds',3.),('parent_running_probe','cleanup')]:
   k,w,c=fixture();w[(42,'token')][field]=value;self.assertFalse(account(k,w,c)['phase_owned_quiescent'])
 def test_owned_live_or_failed_cleanup_rejected(self):
  for key,value in [('owned_present_before_stop',[row(state='S')]),('clean',False)]:
   k,w,c=fixture();c[key]=value;self.assertFalse(account(k,w,c)['phase_owned_quiescent'])
 def test_direct_only_no_doublecount(self):
  a=matrix.phase_accounting(usage(),dict(clean=True,owned_present_before_stop=[],actual_adopted_child_waits=[]),{}, {},2.);self.assertEqual(a['cpu_user_seconds'],1.);self.assertEqual(a['adopted_wait4_rusage'],[])
 def test_missing_direct_usage_never_complete(self):
  k,w,c=fixture();self.assertFalse(matrix.phase_accounting(None,c,k,w,2.)['phase_rusage_complete'])
 def test_actual_wait4_usage_serialized_without_synthetic_values(self):
  p=subprocess.Popen([sys.executable,'-c','sum(range(200000))']);waited,status,r=os.wait4(p.pid,0);p.returncode=os.waitstatus_to_exitcode(status);self.assertEqual(waited,p.pid);record=owner.rusage_record(r);self.assertEqual(record['raw']['ru_utime'],r.ru_utime);self.assertEqual(record['raw']['ru_maxrss'],r.ru_maxrss)
 def test_invalid_adopted_wait_status_is_cleanup_error(self):
  fake=types.SimpleNamespace(pid=20,returncode=0,poll=lambda:0,wait=lambda timeout:0)
  child=row();snapshots=iter([{42:child},{},{},{},{},{}])
  with mock.patch.object(owner,'_SUBREAPER_ENABLED',True),mock.patch.object(owner,'cleanup_snapshot',side_effect=lambda *_:next(snapshots,{})),mock.patch.object(owner.os,'wait4',return_value=(42,(signal.SIGSTOP<<8)|0x7f,usage())),mock.patch.object(owner,'signal_known',return_value=([],[])):
   report=owner.stop_owned(fake,{}, {},grace_seconds=0,kill_seconds=0)
  self.assertFalse(report['clean']);self.assertEqual(report['errors'][0]['stage'],'adopted_wait4_usage')
 def test_adopted_wait4_failure_is_not_swallowed(self):
  fake=types.SimpleNamespace(pid=20,returncode=0,poll=lambda:0,wait=lambda timeout:0)
  with mock.patch.object(owner,'_SUBREAPER_ENABLED',True),mock.patch.object(owner,'cleanup_snapshot',return_value={42:row()}),mock.patch.object(owner.os,'wait4',side_effect=ChildProcessError('fixture')),mock.patch.object(owner,'signal_known',return_value=([],[])):
   report=owner.stop_owned(fake,{}, {},grace_seconds=0,kill_seconds=0)
  self.assertFalse(report['clean']);self.assertTrue(any(r['stage']=='adopted_wait4'for r in report['errors']))
@unittest.skipUnless(sys.platform=='linux','actual Linux subreaper semantics required')
class LinuxActual(unittest.TestCase):
 def test_cancellation_escapes_subprocess_retry_and_waits_owned_child(self):
  with tempfile.TemporaryDirectory()as directory:
   ready=pathlib.Path(directory)/'collector-ready'
   original=owner.processes
   first=True
   def collector():
    nonlocal first
    if first:
     first=False
     code='import pathlib,time;pathlib.Path('+repr(str(ready))+').touch();time.sleep(2)'
     subprocess.run([sys.executable,'-c',code],check=True)
    return original()
   def cancel_when_collecting():
    end=time.monotonic()+3
    while not ready.exists()and time.monotonic()<end:time.sleep(.01)
    if ready.exists():os.kill(os.getpid(),signal.SIGTERM)
   sender=threading.Thread(target=cancel_when_collecting)
   phase=dict(name='cancellation-control',command=[sys.executable,'-c','import time;time.sleep(20)'],cwd=directory,environment={},artifacts=[])
   sender.start()
   try:
    with mock.patch.object(matrix,'identity',return_value=['same']),mock.patch.object(matrix,'generated_binding_identity',return_value=['outputs']),mock.patch.object(owner,'processes',side_effect=collector):
     result=matrix.run_phase(phase,dict(os.environ),pathlib.Path(directory),['same'],0,phase_timeout_seconds=5)
   finally:sender.join(timeout=4)
   self.assertFalse(sender.is_alive())
   self.assertIsNotNone(result['phase_error'])
   self.assertEqual(result['phase_error']['type'],'TaskInterrupted')
   self.assertTrue(result['phase_cleanup']['actual_parent_wait'])
   self.assertTrue(result['phase_cleanup']['cleanup_confirmed_absent'])
   self.assertTrue(result['phase_cleanup']['clean'])
 def run_case(self,terminal):
  # Parent retains its own unreaped terminal child for >sampling interval, then
  # exits. Only terminal=True is eligible; live child is actually killed/reaped.
  code="import os,time\np=os.fork()\nif p==0:\n os.setsid()\n "+("sum(range(1000000)); os._exit(7)"if terminal else"time.sleep(20); os._exit(0)")+"\ntime.sleep(1.0); os._exit(0)\n"
  with tempfile.TemporaryDirectory()as d:
   phase=dict(name='micro-control',command=[sys.executable,'-c',code],cwd=d,environment={},cache_state='functional-test-only',artifacts=[])
   with mock.patch.object(matrix,'identity',return_value=['same']),mock.patch.object(matrix,'generated_binding_identity',return_value=['outputs']):
    result=matrix.run_phase(phase,dict(os.environ),pathlib.Path(d),['same'],0,phase_timeout_seconds=10)
  return result
 def test_actual_terminal_orphan_wait4_accepts_and_records_usage(self):
  r=self.run_case(True);self.assertEqual(r['exit_code'],0);self.assertTrue(r['phase_owned_quiescent'],r);self.assertTrue(r['phase_rusage_complete']);self.assertEqual(len(r['adopted_wait4_rusage']),1);self.assertEqual(r['adopted_wait4_rusage'][0]['status'],7<<8);self.assertEqual(r['cpu_user_seconds'],r['direct_wait4_rusage']['cpu_user_seconds']+r['adopted_wait4_rusage'][0]['rusage']['cpu_user_seconds']);self.assertEqual(r['phase_cleanup']['remaining_identities'],[])
 def test_actual_first_seen_terminal_only_in_cleanup_is_rejected(self):
  original_processes=owner.processes;original_stop=owner.stop_owned;inside_cleanup=False
  def snapshot():
   rows=original_processes()
   return rows if inside_cleanup else {pid:row for pid,row in rows.items()if row['ppid']==os.getpid()}
  def stop(*args,**kwargs):
   nonlocal inside_cleanup
   inside_cleanup=True
   return original_stop(*args,**kwargs)
  # The terminal grandchild remains under its still-live direct parent, so the
  # injected incomplete measured snapshots conceal it; cleanup sees/adopts it.
  with mock.patch.object(owner,'processes',side_effect=snapshot),mock.patch.object(owner,'stop_owned',side_effect=stop):r=self.run_case(True)
  self.assertFalse(r['phase_owned_quiescent']);self.assertEqual(r['terminal_descendants_before_parent_completion'],[]);self.assertTrue(r['phase_cleanup']['actual_adopted_child_waits']);self.assertFalse(r['phase_rusage_complete'])
 def test_actual_elapsed_excludes_delayed_cleanup(self):
  original=owner.stop_owned
  def delayed(*args,**kwargs):
   time.sleep(.25)
   return original(*args,**kwargs)
  start=time.monotonic()
  with mock.patch.object(owner,'stop_owned',side_effect=delayed):r=self.run_case(True)
  self.assertTrue(r['phase_rusage_complete']);self.assertGreaterEqual(time.monotonic()-start-r['wall_seconds'],.25)
 def test_actual_live_at_exit_is_failed_even_after_cleanup_reaps(self):
  r=self.run_case(False);self.assertEqual(r['exit_code'],0);self.assertFalse(r['phase_owned_quiescent']);self.assertFalse(r['phase_rusage_complete']);self.assertIsNone(r['cpu_user_seconds']);self.assertTrue(r['phase_cleanup']['actual_adopted_child_waits']);self.assertEqual(r['phase_cleanup']['remaining_identities'],[])
def legacy_rust_source_hash(root):
    # Independent reproduction of the old policy's defect: every Rust source
    # file, including ignored generated bindings, was treated as an input.
    digest = hashlib.sha256()
    for path in sorted((root / 'rust/main').rglob('*.rs')):
        digest.update(str(path.relative_to(root)).encode() + b'\0' + path.read_bytes())
    return digest.hexdigest()


class GeneratedBindings(unittest.TestCase):
    TRACKED_MODULE = 'rust/main/chains/hyperlane-starknet/src/contracts/mod.rs'

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='ziggy-binding-regression-')
        self.addCleanup(self.directory.cleanup)
        self.root = pathlib.Path(self.directory.name)
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        for directory in matrix.BINDING_OUTPUT_DIRS:
            base = pathlib.Path(directory).parent.parent
            relative = str(pathlib.Path(directory).relative_to(base))
            self.write(str(base / 'build.rs'), 'fn main() { /* actual generator input */ }\n')
            self.write(str(base / 'abis/Example.abi.json'), '[]\n')
            self.write(str(base / '.gitignore'), relative + '/\n')
        self.write(self.TRACKED_MODULE, 'pub(crate) mod example;\n')
        self.write('rust/main/utils/abigen/src/lib.rs', 'pub fn generate_bindings_for_dir() {}\n')
        self.write('rust/main/src/ordinary.rs', 'fn ordinary() {}\n')
        self.write('rust/main/Cargo.lock', 'version = 4\n')
        subprocess.run(['git', '-C', str(self.root), 'add', '-A'], check=True)
        subprocess.run(['git', '-C', str(self.root), 'add', '-f', self.TRACKED_MODULE], check=True)
        self.patch = mock.patch.object(matrix, 'ROOT', self.root)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def generate(self):
        for directory in matrix.BINDING_OUTPUT_DIRS:
            self.write(directory + '/example.rs', '// generated\npub struct Example;\n')
            if directory + '/mod.rs' != self.TRACKED_MODULE:
                self.write(directory + '/mod.rs', 'pub(crate) mod example;\n')

    def test_clean_checkout_generates_all_four_only_without_input_drift(self):
        before = matrix.identity()
        outputs = matrix.generated_binding_identity()
        legacy = legacy_rust_source_hash(self.root)
        self.generate()
        self.assertNotEqual(legacy_rust_source_hash(self.root), legacy)
        self.assertEqual(matrix.identity(), before)
        self.assertNotEqual(matrix.generated_binding_identity(), outputs)
        wanted = {d + '/example.rs' for d in matrix.BINDING_OUTPUT_DIRS}
        self.assertTrue(wanted <= matrix.generated_binding_paths())
        self.assertNotIn(self.TRACKED_MODULE, matrix.generated_binding_paths())

    def test_actual_generator_abi_scripts_lock_and_tracked_module_remain_inputs(self):
        self.generate()
        before = matrix.identity()
        inputs = [self.TRACKED_MODULE, 'rust/main/utils/abigen/src/lib.rs',
                  'rust/main/src/ordinary.rs', 'rust/main/Cargo.lock']
        inputs += [str(pathlib.Path(d).parent.parent / name)
                   for d in matrix.BINDING_OUTPUT_DIRS for name in ['build.rs', 'abis/Example.abi.json']]
        for name in inputs:
            with self.subTest(name=name):
                path = self.root / name
                original = path.read_bytes()
                path.write_bytes(original + b'\nchanged input\n')
                self.assertNotEqual(matrix.identity(), before)
                path.write_bytes(original)
                self.assertEqual(matrix.identity(), before)

    def test_ordinary_nested_and_non_rust_new_files_are_not_exempt(self):
        before = matrix.identity()
        for name in ['rust/main/src/new.rs', matrix.BINDING_OUTPUT_DIRS[0] + '/nested/new.rs',
                     matrix.BINDING_OUTPUT_DIRS[0] + '/new.json']:
            with self.subTest(name=name):
                path = self.write(name, 'new guarded source\n')
                self.assertNotIn(name, matrix.generated_binding_paths())
                self.assertNotEqual(matrix.identity(), before)
                path.unlink()
                self.assertEqual(matrix.identity(), before)

    def test_direct_untracked_but_not_ignored_binding_is_still_input(self):
        directory = matrix.BINDING_OUTPUT_DIRS[0]
        base = pathlib.Path(directory).parent.parent
        relative = str(pathlib.Path(directory).relative_to(base))
        self.write(str(base / '.gitignore'), relative + '/*.rs\n!' + relative + '/unignored.rs\n')
        before = matrix.identity()
        self.write(directory + '/unignored.rs', '// deliberately not ignored\n')
        self.assertNotIn(directory + '/unignored.rs', matrix.generated_binding_paths())
        self.assertNotEqual(matrix.identity(), before)

    def test_even_ignored_rust_outside_exact_roots_remains_input(self):
        self.write('.gitignore', '/rust/main/src/ignored.rs\n')
        before = matrix.identity()
        self.write('rust/main/src/ignored.rs', '// ignored but not generated binding\n')
        self.assertNotIn('rust/main/src/ignored.rs', matrix.generated_binding_paths())
        self.assertNotEqual(matrix.identity(), before)

    def test_generated_mutation_has_separate_digest_and_no_change_fence(self):
        self.generate()
        before = matrix.identity()
        outputs = matrix.generated_binding_identity()
        path = self.root / matrix.BINDING_OUTPUT_DIRS[0] / 'example.rs'
        path.write_text('// modified generated output\n')
        self.assertEqual(matrix.identity(), before)
        self.assertNotEqual(matrix.generated_binding_identity(), outputs)
        row = dict(exit_code=0, phase_error=None, phase_owned_quiescent=True,
                   phase_rusage_complete=True, source_unchanged=True,
                   source_after_sha256_chunks=before, generated_bindings_unchanged=False,
                   disk_guard_triggered=False, artifacts=[])
        for name in ['rust-three-agent-no-change', 'zig-ReleaseSafe-three-agent-cold',
                     'zig-ReleaseFast-three-agent-no-change', 'native-sdk-cold']:
            with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, 'Generated bindings changed'):
                matrix.validate_phase(row, dict(name=name, artifacts=[]), before)
        matrix.validate_phase(row, dict(name='rust-three-agent-cold', artifacts=[]), before)

    def test_generated_deletion_is_recorded_separately(self):
        self.generate()
        before = matrix.identity()
        outputs = matrix.generated_binding_identity()
        (self.root / matrix.BINDING_OUTPUT_DIRS[0] / 'example.rs').unlink()
        self.assertEqual(matrix.identity(), before)
        self.assertNotEqual(matrix.generated_binding_identity(), outputs)

    @unittest.skipUnless(os.name == 'posix', 'symlink policy applies on Unix runners')
    def test_binding_leaf_symlink_is_refused(self):
        self.generate()
        path = self.root / matrix.BINDING_OUTPUT_DIRS[0] / 'example.rs'
        path.unlink()
        path.symlink_to(self.root / 'rust/main/src/ordinary.rs')
        with self.assertRaisesRegex(RuntimeError, 'Generated binding file is a symlink'):
            matrix.identity()

    @unittest.skipUnless(os.name == 'posix', 'symlink policy applies on Unix runners')
    def test_binding_directory_symlink_is_refused(self):
        path = self.root / matrix.BINDING_OUTPUT_DIRS[0]
        path.parent.mkdir(parents=True, exist_ok=True)
        path.symlink_to(self.root / 'rust/main/src', target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, 'Generated binding directory is a symlink'):
            matrix.identity()


if __name__=='__main__':unittest.main(verbosity=2)
