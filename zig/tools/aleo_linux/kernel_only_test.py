"""Kernel-only pure controls. No real socket, subprocess, namespace or cgroup."""
import ast
import ctypes
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace as N
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
sys.path.insert(0, str(HERE))
# Guard the actual imports rather than importing the rest of the Aleo proposal.
with patch.object(socket, 'socket', side_effect=AssertionError('socket during import')), patch.object(subprocess, 'Popen', side_effect=AssertionError('child during import')), patch.object(ctypes, 'CDLL', side_effect=AssertionError('native library during import')):
    import kernel_probe as probe
    import receipts
    import loopback_bridge as bridge


def conditions(text):
    out, name, started = {}, None, False
    for line in text.splitlines():
        if line == 'jobs:': started = True
        if not started: continue
        if line.startswith('  ') and not line.startswith('   ') and line.endswith(':'): name = line.strip()[:-1]
        if line.startswith('    if: '): out[name] = line[8:]
    return out


def selected(rows, event='push', message='', ref='refs/heads/feat/zig-agent-rewrite', **inputs):
    scope = {'github': N(event_name=event, ref=ref, event=N(head_commit=N(message=message))), 'inputs': N(svm_prerequisites=inputs.get('svm', False), cold_full_feature=inputs.get('cold', False), aleo_linux_prerequisite=inputs.get('aleo', False), aleo_linux_sdk_prerequisite=inputs.get('sdk', False)), 'contains': lambda text, needle: needle in text}
    def evaluate(value):
        value = value.removeprefix('${{ ').removesuffix(' }}')
        value = re.sub(r'!(?!=)', ' not ', value).replace('&&', ' and ').replace('||', ' or ').strip()
        return bool(eval(compile(value, '<actual-workflow-if>', 'eval'), {'__builtins__': {}}, scope))
    return {name for name, value in rows.items() if evaluate(value)}


class KernelControls(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ziggy-kernel-pure-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()

    def test_actual_imports_and_default_entry_remain_inert(self):
        self.assertNotIn('worker_catalog', sys.modules)
        self.assertNotIn('supervisor', sys.modules)
        with patch.object(sys, 'argv', ['kernel_probe.py']), patch.object(probe, 'probe', side_effect=AssertionError('probe entered')):
            with self.assertRaisesRegex(ValueError, 'inert: explicit'): probe.main()

    def test_unapproved_spec_refuses_before_platform_or_kernel(self):
        path = self.root / 'spec.json'; path.write_text(json.dumps({'schema': 1, 'root_approved': False, 'purpose': 'aleo-linux-kernel-probe-v1'}))
        with patch.object(probe.platform, 'system', side_effect=AssertionError('past authorization')):
            with self.assertRaisesRegex(ValueError, 'authorization'): probe.probe(probe.pin(path))

    def test_changed_spec_hash_refuses_before_probe(self):
        path = self.root / 'spec.json'; path.write_bytes(b'{}')
        with patch.object(sys, 'argv', ['kernel_probe.py', '--execute-probe', '--spec', str(path), '--spec-sha', '0' * 64]), patch.object(probe, 'probe', side_effect=AssertionError('probe entered')):
            with self.assertRaisesRegex(ValueError, 'spec changed'): probe.main()

    def test_pin_accepts_exact_bytes_and_rejects_replacement(self):
        path = self.root / 'payload'; path.write_bytes(b'exact')
        pin = probe.pin(path); self.assertEqual(receipts.checked(pin), path)
        path.write_bytes(b'other')
        with self.assertRaisesRegex(ValueError, 'hash changed'): receipts.checked(pin)

    def test_pin_rejects_symlink_and_boolean_size(self):
        path = self.root / 'payload'; path.write_bytes(b'x')
        alias = self.root / 'alias'; alias.symlink_to(path)
        with self.assertRaises(ValueError): receipts.checked(dict(probe.pin(path), path=str(alias)))
        with self.assertRaisesRegex(ValueError, 'bounded pin'): receipts.checked(dict(probe.pin(path), bytes=True))

    def test_duplicate_or_oversized_json_refused(self):
        with self.assertRaisesRegex(ValueError, 'duplicate JSON'): receipts.decode(b'{"a":1,"a":2}')
        with self.assertRaisesRegex(ValueError, 'bounded JSON'): receipts.decode(b'{}', limit=1)

    def lease(self):
        path = self.root / 'owned-leaf'; path.mkdir()
        lease = probe.Lease.__new__(probe.Lease); lease.path = path
        lease.identity = (path.stat().st_dev, path.stat().st_ino); lease.line = '0::/owned-leaf\n'
        return lease

    def test_cgroup_identity_replacement_refuses_before_kill(self):
        lease = self.lease(); old = self.root / 'old'; lease.path.rename(old); lease.path.mkdir()
        with self.assertRaisesRegex(ValueError, 'lease replaced'): lease.kill_owned()
        self.assertFalse((lease.path / 'cgroup.kill').exists())
        self.assertFalse((old / 'cgroup.kill').exists())

    def test_kill_targets_only_exact_owned_leaf(self):
        lease = self.lease(); lease.kill_owned()
        self.assertEqual((lease.path / 'cgroup.kill').read_text(), '1')
        self.assertFalse((self.root / 'cgroup.kill').exists())

    def test_populated_leaf_preserved(self):
        lease = self.lease(); (lease.path / 'cgroup.events').write_text('populated 1\nfrozen 0\n')
        with self.assertRaisesRegex(ValueError, 'live cgroup'): lease.remove()
        self.assertTrue(lease.path.is_dir())

    def test_bootstrap_eof_never_loads_library_or_executes(self):
        with patch.object(sys, 'stdin', N(buffer=io.BytesIO(b''))), patch.object(ctypes, 'CDLL', side_effect=AssertionError('library')), patch.object(os, 'execve', side_effect=AssertionError('exec')):
            with self.assertRaisesRegex(ValueError, 'GO barrier'): probe.bootstrap(['/not-executed'])

    def test_terminal_reaping_requires_owned_kernel_child(self):
        records = []; lease = N(line='0::/owned\n')
        rows = {31: {'state': 'S'}, 32: {'state': 'Z', 'cgroup': lease.line, 'start': 123, 'group': 32}}
        with patch.object(Path, 'read_text', return_value='31 32'), patch.object(probe, 'process', side_effect=lambda pid: rows[pid]), patch.object(os, 'wait4', create=True, return_value=(32, 0, None)) as waited:
            probe.reap_terminal(lease, records)
        waited.assert_called_once_with(32, os.WNOHANG)
        self.assertEqual(records[0]['start'], 123)
        self.assertTrue(records[0]['actual_wait4']); self.assertTrue(records[0]['not_performance_credit'])

    def test_foreign_terminal_child_never_waited(self):
        with patch.object(Path, 'read_text', return_value='32'), patch.object(probe, 'process', return_value={'state': 'Z', 'cgroup': '0::/foreign\n'}), patch.object(os, 'wait4', create=True) as waited:
            with self.assertRaisesRegex(ValueError, 'escaped'): probe.reap_terminal(N(line='0::/owned\n'), [])
        waited.assert_not_called()

    def test_closed_fixed_routes(self):
        for port in (23030, 23031, 25432):
            self.assertEqual(bridge.route(self.root, port), (str(self.root / (str(port) + '.sock')), ('127.0.0.1', port)))
        for port in (True, '23030', 9090):
            with self.assertRaisesRegex(ValueError, 'unknown bridge'): bridge.route(self.root, port)
        with self.assertRaises(ValueError): bridge.route('relative', 23030)

    def test_halfclose_and_partial_send_preserve_both_directions(self):
        class Peer:
            def __init__(self, chunks): self.chunks = iter(chunks); self.sent = bytearray(); self.shutdowns = []
            def recv(self, count): return next(self.chunks, b'')
            def send(self, value): self.sent.extend(value[:2]); return min(2, len(value))
            def settimeout(self, value): pass
            def shutdown(self, value): self.shutdowns.append(value)
        left, right = Peer([b'request', b'']), Peer([b'response', b''])
        result = bridge.relay(left, right, time.monotonic_ns() + 10**9, threading.Event())
        self.assertEqual(bytes(left.sent), b'response'); self.assertEqual(bytes(right.sent), b'request')
        self.assertIn(socket.SHUT_WR, left.shutdowns); self.assertIn(socket.SHUT_WR, right.shutdowns)
        self.assertEqual(result, {'bytes_to_fixed_target': 7, 'bytes_from_fixed_target': 8, 'both_pump_threads_joined': True, 'reply_or_parent_wait_credit': False})

    def test_expired_bridge_refuses_without_socket_io(self):
        peer = N(settimeout=lambda value: None, recv=lambda count: self.fail('expired recv'), send=lambda data: self.fail('expired send'), shutdown=lambda value: None)
        with self.assertRaisesRegex(ValueError, 'original deadline'): bridge.relay(peer, peer, 0, threading.Event())


class NestedNamespaceDiagnostics(unittest.TestCase):
    def invoke(self,result,number):
        calls=[];observations=io.StringIO()
        libc=N(unshare=lambda flags:(calls.append(flags),result)[1])
        with patch.object(probe.ctypes,'get_errno',return_value=number)as error_read,patch.object(sys,'stderr',observations):
            error=None
            try:probe.check_nested_userns(libc)
            except ValueError as failure:error=str(failure)
        self.assertEqual(calls,[0x10000000]);error_read.assert_called_once_with()
        lines=observations.getvalue().splitlines();self.assertEqual(len(lines),1)
        row=json.loads(lines[0])
        self.assertEqual(row,{'schema':1,'kind':'aleo-linux-nested-userns-diagnostic-v1','unshare_return':result,'errno':number})
        self.assertIs(type(row['unshare_return']),int);self.assertIs(type(row['errno']),int)
        return error

    def test_successful_unshare_refused_regardless_of_stale_errno(self):
        for number in (0,probe.errno.EPERM,probe.errno.EINVAL,probe.errno.ENOSPC):
            with self.subTest(number=number):self.assertEqual(self.invoke(0,number),'nested user namespace usable')

    def test_unexpected_denial_exposed_then_still_refused(self):
        for number in (probe.errno.EACCES,0):
            with self.subTest(number=number):self.assertEqual(self.invoke(-1,number),'nested user namespace usable')

    def test_expected_denials_unchanged(self):
        for number in (probe.errno.EPERM,probe.errno.EINVAL,probe.errno.ENOSPC):
            with self.subTest(number=number):self.assertIsNone(self.invoke(-1,number))

    def test_only_explicit_refusal_errnos_are_accepted(self):
        allowed={probe.errno.EPERM,probe.errno.EINVAL,probe.errno.ENOSPC}
        for number in range(256):
            with self.subTest(number=number):
                self.assertEqual(self.invoke(-1,number),None if number in allowed else 'nested user namespace usable')

    def test_only_observed_negative_enospc_return_is_accepted(self):
        for result in (-2,0,1,2):
            with self.subTest(result=result):self.assertEqual(self.invoke(result,probe.errno.ENOSPC),'nested user namespace usable')
        self.assertIsNone(self.invoke(-1,probe.errno.ENOSPC))

    def test_actual_argv_gives_python_explicit_pid1_contract(self):
        function=next(node for node in ast.parse((HERE/'kernel_probe.py').read_text()).body if isinstance(node,ast.FunctionDef)and node.name=='probe')
        assignment=next(node for node in function.body if isinstance(node,ast.Assign)and any(isinstance(target,ast.Name)and target.id=='argv'for target in node.targets))
        scope={'bwrap':'/pinned/bwrap','python':'/pinned/python','HERE':HERE,'code':HERE/'kernel_probe.py','sentinel':Path('/owned/sentinel'),'caps':Path('/owned/caps'),'control':Path('/owned/control'),'hidden':Path('/owned/hidden'),'original_deadline':123,'str':str,'os':N(readlink=lambda path:'owned-namespace')}
        argv=eval(compile(ast.Expression(assignment.value),'<actual-kernel-argv>','eval'),{'__builtins__':{}},scope)
        self.assertEqual(argv.count('--as-pid-1'),1);self.assertEqual(argv[argv.index('--unshare-pid')+1],'--as-pid-1')
        for flag in ('--unshare-user','--unshare-net','--disable-userns','--assert-userns-disabled','--die-with-parent','--cap-drop','--remount-ro'):self.assertIn(flag,argv)
        self.assertEqual(argv[-2:],['--deadline-python-ns','123'])

    def test_errno_saved_once_before_stderr_side_effects(self):
        events=[]
        libc=N(unshare=lambda flags:(events.append('unshare'),-1)[1])
        def get_errno():events.append('errno');return probe.errno.EPERM
        class Sink(io.StringIO):
            def write(self,value):events.append('stderr');return super().write(value)
        sink=Sink()
        with patch.object(probe.ctypes,'get_errno',side_effect=get_errno)as read,patch.object(sys,'stderr',sink):probe.check_nested_userns(libc)
        self.assertEqual(events[:2],['unshare','errno']);self.assertTrue(all(event=='stderr'for event in events[2:]));read.assert_called_once_with()
        self.assertEqual(json.loads(sink.getvalue())['errno'],probe.errno.EPERM)


class WorkflowControls(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = (REPO / '.github/workflows/zig-agents.yml').read_text(); cls.rows = conditions(cls.text)

    def test_exact_kernel_marker_excludes_all_other_jobs(self):
        for suffix in ('', ' [zig-native-case]', ' [zig-svm-prerequisites-only]', ' [zig-native-case] [zig-svm-prerequisites-only] [zig-native-http-diagnostic]'):
            self.assertEqual(selected(self.rows, message='[zig-aleo-kernel-only]' + suffix), {'aleo-linux-prerequisite'})

    def test_explicit_dispatch_kernel_wins_over_other_inputs(self):
        for svm in (False, True):
            for cold in (False, True):
                self.assertEqual(selected(self.rows, event='workflow_dispatch', aleo=True, svm=svm, cold=cold), {'aleo-linux-prerequisite'})

    def test_marker_has_no_effect_outside_exact_push_context(self):
        for event, ref in [('pull_request', 'refs/heads/feat/zig-agent-rewrite'), ('push', 'refs/heads/main'), ('push', 'refs/heads/other'), ('workflow_dispatch', 'refs/heads/feat/zig-agent-rewrite')]:
            self.assertEqual(selected(self.rows, event=event, ref=ref, message='[zig-aleo-kernel-only]'), selected(self.rows, event=event, ref=ref))
        self.assertNotIn('aleo-linux-prerequisite', selected(self.rows, message='[zig-aleo-kernel]'))

    def test_default_dispatch_and_existing_routes_remain(self):
        self.assertNotIn('aleo-linux-prerequisite', selected(self.rows, event='workflow_dispatch'))
        self.assertEqual(selected(self.rows, event='workflow_dispatch', svm=True), {'svm-prerequisites'})
        self.assertEqual(selected(self.rows, message='[zig-native-case]'), {'native-case-producer-inputs'})
        self.assertEqual(selected(self.rows, message='[zig-svm-prerequisites-only]'), {'svm-prerequisites'})
        self.assertRegex(self.text, r'aleo_linux_prerequisite:\n(?:[^\n]*\n){2}        default: false')

    def builder(self, extras=(), symlink=False):
        temp = tempfile.TemporaryDirectory(prefix='ziggy-kernel-builder-pure-'); self.addCleanup(temp.cleanup)
        root = Path(temp.name).resolve(); code = root / 'repo/zig/tools/aleo_linux'; code.mkdir(parents=True)
        for name in ('kernel_probe.py', 'loopback_bridge.py', 'receipts.py', 'kernel_only_test.py', 'kernel_delegate.py', 'kernel_delegate_test.py', *extras): (code / name).write_text('# controlled fixture\n')
        if symlink:
            (code / 'receipts.py').unlink(); (code / 'receipts.py').symlink_to(code / 'kernel_probe.py')
        job = self.text.split('  aleo-linux-prerequisite:', 1)[1]
        script = job.split("python3 -I -B - <<'PY'\n", 1)[1].split('\n          PY', 1)[0]
        script = '\n'.join(line[10:] for line in script.splitlines())
        tree = ast.parse(script)
        # Only external executable byte reads are stubbed; actual closure/paths/schema/write execute.
        tree.body = [node for node in tree.body if not isinstance(node, ast.FunctionDef)]
        fake_pin = lambda path: {'path': str(path), 'bytes': 1, 'sha256': 'a' * 64}
        with patch.dict(os.environ, {'GITHUB_WORKSPACE': str(root / 'repo'), 'RUNNER_TEMP': str(root), 'GITHUB_RUN_ID': '1', 'GITHUB_RUN_ATTEMPT': '2'}):
            exec(compile(tree, '<actual-kernel-CI-spec-builder>', 'exec'), {'pin': fake_pin})
        return json.loads((root / 'aleo-kernel-1-2.spec.json').read_text())

    def test_actual_spec_builder_pins_only_reviewed_runtime_modules(self):
        spec = self.builder()
        self.assertEqual({Path(row['path']).name for row in spec['pins']}, {'kernel_probe.py', 'loopback_bridge.py', 'receipts.py', 'kernel_delegate.py'})
        self.assertEqual(spec['purpose'], 'aleo-linux-kernel-probe-v1'); self.assertIs(spec['root_approved'], True)
        self.assertEqual(len(spec['run_token']), 32)

    def test_actual_spec_builder_refuses_extra_module_before_spec(self):
        with self.assertRaisesRegex(AssertionError, 'unexpected Aleo code closure'): self.builder(('supervisor.py',))

    def test_actual_spec_builder_refuses_symlink(self):
        with self.assertRaisesRegex(AssertionError, 'regular code closure'): self.builder(symlink=True)

    def test_job_has_no_sdk_build_or_privileged_fallback(self):
        job = self.text.split('  aleo-linux-prerequisite:', 1)[1]
        for forbidden in ('docker ', 'cargo ', 'pnpm ', 'sysctl ', 'apparmor', '--privileged', 'pure_test.py', 'submodules:'):
            self.assertNotIn(forbidden, job)
        self.assertIn('timeout-minutes: 15', job); self.assertIn('timeout-minutes: 4', job)
        self.assertIn('persist-credentials: false', job); self.assertNotIn('continue-on-error', job)
        self.assertIn('negative-stderr.log', job)


if __name__ == '__main__':
    def no_effects(event, args):
        if event.startswith('socket.') or event in {'subprocess.Popen', 'os.fork', 'os.exec', 'ctypes.dlopen'}:
            raise AssertionError('pure control effect forbidden: ' + event)
    sys.addaudithook(no_effects)
    unittest.main()
