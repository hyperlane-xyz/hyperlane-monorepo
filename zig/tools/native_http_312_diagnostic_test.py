"""Socket/process-free diagnostic custody and route controls; no Zig compilation."""
import importlib.util
import ast
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('native312', Path(__file__).with_name('native_http_312_diagnostic.py'))
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


class CustodyControls(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.repo = self.root / 'repo'
        self.target = self.repo / api.TARGET
        self.target.parent.mkdir(parents=True)
        self.target.write_bytes(b'original')
        self.target.chmod(0o640)
        self.output = self.root / 'output'
        self.output.mkdir(mode=0o700)
        self.before = api.digest(b'original')
        self.after = b'instrumented'
        self.patch = mock.patch.multiple(api, BEFORE_SHA=self.before, AFTER_SHA=api.digest(self.after))
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def receipts(self, absent=True):
        output = self.output / 'outer-owner'
        output.mkdir()
        cleanup = {'actual_parent_wait': True, 'cleanup_confirmed_absent': absent, 'clean': absent}
        (output / 'result.json').write_text(json.dumps({'cleanup': cleanup}))
        (output / 'monitor-parent.json').write_text(json.dumps({'cleanup': cleanup}))

    def test_snapshot_exists_before_execute_and_normal_return_restores_exact_mode(self):
        def execute():
            self.assertEqual(self.target.read_bytes(), self.after)
            self.assertEqual((self.output / 'source.before').read_bytes(), b'original')
            self.assertEqual((self.output / 'source.before').stat().st_mode & 0o777, 0o600)
            self.receipts()
            return 0
        result = api.diagnostic(self.repo, self.output, self.after, execute)
        self.assertTrue(result['source_restored'])
        self.assertEqual(self.target.read_bytes(), b'original')
        self.assertEqual(self.target.stat().st_mode & 0o777, 0o640)
        self.assertFalse(result['native_acceptance'])
        self.assertIn('cause unknown', result['interpretation'])

    def test_wrong_before_hash_refuses_before_snapshot_or_execute(self):
        self.target.write_bytes(b'unreviewed')
        with self.assertRaisesRegex(ValueError, 'Original Source hash'):
            api.diagnostic(self.repo, self.output, self.after, lambda: self.fail('executed'))
        self.assertEqual(self.target.read_bytes(), b'unreviewed')
        self.assertFalse((self.output / 'source.before').exists())

    def test_execution_failure_after_actual_cleanup_restores_and_preserves_failure(self):
        def execute():
            self.receipts()
            raise RuntimeError('fake owned timeout after actual cleanup')
        result = api.diagnostic(self.repo, self.output, self.after, execute)
        self.assertTrue(result['source_restored'])
        self.assertTrue(result['owned_consumers_absent'])
        self.assertIn('fake owned timeout', result['diagnostic_error']['message'])
        self.assertIsNone(result['command_exit_code'])
        self.assertEqual(self.target.read_bytes(), b'original')

    def test_unproven_cleanup_preserves_snapshot_and_defers_restore(self):
        def execute():
            self.receipts(False)
            raise RuntimeError('unproven child')
        result = api.diagnostic(self.repo, self.output, self.after, execute)
        self.assertFalse(result['source_restored'])
        self.assertFalse(result['owned_consumers_absent'])
        self.assertEqual(self.target.read_bytes(), self.after)
        self.assertEqual((self.output / 'source.before').read_bytes(), b'original')

    def test_null_wrongshape_or_malformed_cleanup_keeps_backup_and_writes_summary(self):
        good = {'cleanup': {'actual_parent_wait': True, 'cleanup_confirmed_absent': True, 'clean': True}}
        bad = [None, [], {'cleanup': None}, {'cleanup': []}, {'cleanup': 'true'}, {'cleanup': True}, {}, '{malformed']
        for side in ['command', 'monitor']:
            for index, value in enumerate(bad):
                with self.subTest(side=side, value=value):
                    self.target.write_bytes(b'original')
                    output = self.root / (side+'-'+str(index))
                    output.mkdir()
                    def execute():
                        receipts = output / 'outer-owner'
                        receipts.mkdir()
                        rows = [value, good] if side == 'command' else [good, value]
                        for name, row in zip(['result.json', 'monitor-parent.json'], rows):
                            (receipts / name).write_text(row if row == '{malformed' else json.dumps(row))
                        return 0
                    result = api.diagnostic(self.repo, output, self.after, execute)
                    self.assertFalse(result['owned_consumers_absent'])
                    self.assertFalse(result['source_restored'])
                    self.assertFalse(result['native_acceptance'])
                    self.assertIn('cleanup_ambiguity', result)
                    self.assertEqual((output / 'source.before').read_bytes(), b'original')
                    self.assertEqual(self.target.read_bytes(), self.after)
                    self.assertEqual(json.loads((output / 'summary.json').read_text()), result)

    def test_unknown_mutation_never_clobbered_by_restore(self):
        def execute():
            self.receipts()
            self.target.write_bytes(b'foreign')
            return 1
        result = api.diagnostic(self.repo, self.output, self.after, execute)
        self.assertFalse(result['source_restored'])
        self.assertEqual(self.target.read_bytes(), b'foreign')
        self.assertEqual((self.output / 'source.before').read_bytes(), b'original')

    def test_changed_snapshot_refuses_restore(self):
        def execute():
            self.receipts()
            (self.output / 'source.before').write_bytes(b'foreign')
            return 1
        result = api.diagnostic(self.repo, self.output, self.after, execute)
        self.assertFalse(result['source_restored'])
        self.assertEqual(self.target.read_bytes(), self.after)

    def test_nonzero_test_exit_stays_nonzero_diagnostic_with_restored_source(self):
        def execute():
            self.receipts()
            return 7
        result = api.diagnostic(self.repo, self.output, self.after, execute)
        self.assertEqual(result['command_exit_code'], 7)
        self.assertTrue(result['source_restored'])
        self.assertFalse(result['native_acceptance'])

    def test_independent_inventory_detects_nonoverlay_input_change(self):
        extra = self.repo / 'zig/src/extra.zig'
        extra.write_bytes(b'original-extra')
        def inventory():
            return {api.TARGET: {'sha256': api.digest(self.target.read_bytes())}, 'zig/src/extra.zig': {'sha256': api.digest(extra.read_bytes())}}
        def execute():
            self.receipts()
            extra.write_bytes(b'changed')
            return 0
        result = api.diagnostic(self.repo, self.output, self.after, execute, inventory)
        self.assertFalse(result['source_restored'])
        self.assertEqual(self.target.read_bytes(), b'original')
        self.assertIn('Original compiled inputs changed', result['source_readback_error']['message'])


class RouteControls(unittest.TestCase):
    def test_log_cap_retains_bounded_bytes_and_requests_only_own_cancellation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'diagnostic.log'
            with mock.patch.object(api, 'LOG_LIMIT', 16), mock.patch.object(api.os, 'kill') as cancel:
                with self.assertRaisesRegex(ValueError, 'log exceeded'):
                    with api.BoundedLog(path):
                        os.write(1, b'0123456789'*4)
            self.assertEqual(path.stat().st_size, 16)
            cancel.assert_called_once_with(os.getpid(), api.signal.SIGTERM)

    def test_adjacent_sha_literals_retain_exact_whole_ast_values(self):
        tree = ast.parse(Path(api.__file__).read_text())
        values = {node.targets[0].id: node.value.value for node in tree.body
                  if isinstance(node, ast.Assign) and len(node.targets) == 1
                  and isinstance(node.targets[0], ast.Name) and isinstance(node.value, ast.Constant)}
        expected = {
            'BEFORE_SHA': ('a2ba8412a9b0e961b76d8054764503c7' 'fa181f7c9ffb4d780d20e15aa8767cb2'),
            'AFTER_SHA': ('79f43abc40fba7df4f829eeabf156027' '8f8a18dab61b356b527243888ed4e139'),
            'PAYLOAD_SHA': ('43d695278d7a0e8f8008cdfc13f0af6f' '99b8374337bf0530ccd0d5b9352d7b73'),
        }
        self.assertEqual({name: values[name] for name in expected}, expected)

    def test_feature_push_marker_only_and_cross_context_refusal(self):
        for name, ref, message, expected in [
            ('push', api.REF, 'chore: diagnostic '+api.MARKER, True),
            ('push', api.REF, 'ordinary', False),
            ('pull_request', api.REF, api.MARKER, False),
            ('workflow_dispatch', api.REF, api.MARKER, False),
            ('push', 'refs/heads/main', api.MARKER, False),
            ('push', api.REF, api.MARKER+' [zig-native-case]', False),
            ('push', api.REF, api.MARKER+' [zig-svm-prerequisites-only]', False),
            ('push', api.REF, '[zig-native-http-diagnosticX]', False),
            ('push', api.REF, api.ONLY_MARKER+' [zig-paired-linux]', True),
            ('push', api.REF, api.ONLY_MARKER, False),
            ('workflow_dispatch', api.REF, api.ONLY_MARKER+' [zig-paired-linux]', False),
            ('push', 'refs/heads/main', api.ONLY_MARKER+' [zig-paired-linux]', False),
            ('push', api.REF, api.ONLY_MARKER+' [zig-paired-linux] [zig-native-case]', False),
        ]:
            with self.subTest(name=name, ref=ref, message=message):
                self.assertIs(api.authorized(name, ref, {'head_commit': {'message': message}}), expected)

    def test_workflow_ordinary_suite_stays_exact_and_only_diagnostic_route_can_skip_it(self):
        repo = Path(__file__).resolve().parents[2]
        workflow = (repo / '.github/workflows/zig-agents.yml').read_text()
        # Find the precise next job independently of its name.
        lines = workflow.splitlines()
        begin = lines.index('  native-http:')
        end = next((i for i in range(begin+1, len(lines)) if lines[i].startswith('  ') and not lines[i].startswith('   ') and lines[i].endswith(':')), len(lines))
        native = '\n'.join(lines[begin:end])
        original = 'run: python3 zig/tools/native_http_tests.py --timeout-seconds 1200 --diagnostic-dir "$RUNNER_TEMP/native-http-diagnostics" -- python3 zig/tools/zig.py test src/root.zig -j"${BUILD_JOBS}" -OReleaseSafe -lc'
        self.assertEqual(native.count(original), 1)
        only = "(github.event_name == 'push' && github.ref == 'refs/heads/feat/zig-agent-rewrite' && contains(github.event.head_commit.message, '[zig-native-http-diagnostic-only]') && contains(github.event.head_commit.message, '[zig-paired-linux]') && !contains(github.event.head_commit.message, '[zig-native-case]') && !contains(github.event.head_commit.message, '[zig-svm-prerequisites-only]'))"
        self.assertIn('      - name: Exercise actual native HTTP/2 and cancellation\n        if: ${{ !'+only+' }}',native)
        self.assertIn('timeout-minutes: 40', native)
        self.assertLess(native.index(original), native.index('- name: Diagnose native HTTP test312'))
        diagnostic = native.split('- name: Diagnose native HTTP test312', 1)[1].split('- uses:', 1)[0]
        self.assertIn("always() && github.event_name == 'push' && github.ref == 'refs/heads/feat/zig-agent-rewrite'", diagnostic)
        self.assertIn("contains(github.event.head_commit.message, '[zig-native-http-diagnostic]')", diagnostic)
        self.assertIn('continue-on-error: true', diagnostic)
        self.assertIn('timeout-minutes: ${{ ', diagnostic)
        self.assertIn('&& 23 || 7 }}', diagnostic)
        self.assertIn("contains(github.event.head_commit.message, '[zig-native-http-full-suite]')", diagnostic)
        self.assertIn('python3 -I -B zig/tools/native_http_312_diagnostic_test.py', diagnostic)
        self.assertIn('python3 -I -B zig/tools/native_http_312_diagnostic.py', diagnostic)
        self.assertNotIn('inputs.', diagnostic)
        self.assertNotIn('source.before', native)
        self.assertNotIn('continue-on-error', native.split('- name: Diagnose native HTTP test312',1)[0])

    def test_payload_exact_decode_and_original_strict_policy_literals(self):
        repo = Path(__file__).resolve().parents[2]
        overlay = api.payload(repo).decode()
        for text in ['.threshold = 8, .max_attempts = 1, .retry_delay_ms = 1', '.max_sessions = 4', '.max_concurrent = 128', '.timeout_ms = 20000', '.connect_timeout_ms = 20000', 'if (path_index < 8)', 'for (8..16) |index| try std.testing.expect(server.pathHits(index) >= 8);']:
            self.assertIn(text, overlay)
        self.assertEqual(overlay.count('started: [128]u64'), 1)
        self.assertEqual(overlay.count('rows: [64]NativeDiagnosticChild'), 1)
        self.assertIn('else self.started_overflow = true;',overlay)
        self.assertEqual(api.LOG_LIMIT, 8*1024*1024)


class DecisiveSourceAndRouteControls(unittest.TestCase):
    def test_payload_header_mutation_wrong_decoded_Source_and_oversize_refuse(self):
        import gzip
        repo=Path(__file__).resolve().parents[2];original=(repo/api.PAYLOAD).read_bytes()
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);target=root/api.PAYLOAD;target.parent.mkdir(parents=True)
            changed=bytearray(original);changed[4]^=1;target.write_bytes(changed)
            with self.assertRaisesRegex(ValueError,'payload changed'):api.payload(root)
            for body in [b'foreign Source',b'x'*131073]:
                wire=gzip.compress(body,mtime=0);target.write_bytes(wire)
                with self.subTest(bytes=len(body)),mock.patch.object(api,'PAYLOAD_SHA',api.digest(wire)),self.assertRaisesRegex(ValueError,'Source changed/oversized'):api.payload(root)

    def source(self):
        repo=Path(__file__).resolve().parents[2]
        return repo,api.payload(repo).decode()

    def test_actual_payload_wraps_original_Source_exchange_and_preserves_capabilities(self):
        _,source=self.source()
        self.assertIn('const NativeDiagnosticInner = evm_source.Source(evm_source.LocalOrigin);',source)
        for text in ['const actual = try self.inner.fork(allocator, cancel);','original.fetch_fn(original.context, allocator, body, options)','self.inner.client.options.exchange = self.original_exchange;','self.inner.deinitFork();','self.save(failure, false);','self.inner.endPass(failure);','self.save(err, true);','@hasDecl(NativeDiagnosticSource, name) != @hasDecl(NativeDiagnosticInner, name)','pub const parallel_quorum = NativeDiagnosticInner.parallel_quorum;','pub const parallel_latest = NativeDiagnosticInner.parallel_latest;']:
            self.assertIn(text,source)
        self.assertNotIn('pub fn verifyCandidate(',source.split('const NativeDiagnosticSource = struct {',1)[1].split('comptime {',1)[0])
        self.assertLess(source.index('self.save(failure, false);'),source.index('self.inner.endPass(failure);'))
        self.assertIn('rows: [64]NativeDiagnosticChild',source)
        self.assertIn('var children: [64]Child',source)
        self.assertIn('diagnostic sixty-four full records fit and remain closed',source)
        self.assertIn('row.replay_state_known = false;',source)

    def test_pool_observation_and_privacy_boundaries_stay_read_only(self):
        _,source=self.source();snapshot=source.split('fn nativeDiagnosticPool(runtime: *Pool)',1)[1].split('const NativeDiagnosticProbe = struct',1)[0]
        self.assertIn('if (!runtime.mutex.tryLock()) return result;',snapshot)
        for text in ['runtime.sessions','session.id','session.closed.load(.acquire)','session.taken.load(.acquire)']:self.assertIn(text,snapshot)
        for text in ['.peers','.native_id','.finished','session.mutex','runtime.mutex.lock()']:self.assertNotIn(text,snapshot)
        for text in ['if (count == 4096)','count_including_probe_directory','if (wire.len > 32768)','if (err == error.PendingReadIo)','OtherCompiledError','self.probe.mutex.lock();']:self.assertIn(text,source)
        actual=source.split('test "native Pool yields eight stalled peers and verifies healthy EVM children three times" {',1)[1].split('fn repeatedLeafReplayScenario',1)[0]
        self.assertLess(actual.index('var probe:'),actual.index('Pool.start('));self.assertIn('.diagnostic = &probe',actual)
        self.assertNotIn('observer.diagnostic =',actual)
        self.assertIn('probe.before_pool = nativeDiagnosticPool(runtime);',actual)
        self.assertIn('probe.before_fds = nativeDiagnosticFds();',actual)
        self.assertLess(actual.index('probe.dump();'),actual.index('try server.check();'))
        self.assertLess(actual.index('probe.dump();'),actual.index('return err;'))

    def workflow_api(self):
        import re
        from types import SimpleNamespace as N
        repo=Path(__file__).resolve().parents[2]
        tree=ast.parse((repo/'zig/tools/aleo_linux/kernel_only_test.py').read_bytes())
        ns={'re':re};exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='conditions'],type_ignores=[]),'actual-condition-reader','exec'),ns)
        paired=ast.parse((repo/'zig/bench/paired_linux_test.py').read_bytes());method=next(n for cls in paired.body if isinstance(cls,ast.ClassDef)and cls.name=='Workflow'for n in cls.body if isinstance(n,ast.FunctionDef)and n.name=='evaluate')
        scope={'re':re,'N':N,'hashlib':hashlib};exec(compile(ast.Module(body=[method],type_ignores=[]),'actual-condition-evaluator','exec'),scope)
        inverse=next(n for n in paired.body if isinstance(n,ast.FunctionDef)and n.name=='ordinary_native_http_workflow');exec(compile(ast.Module(body=[inverse],type_ignores=[]),'exact-reviewed-workflow-inverse','exec'),scope)
        text=(repo/'.github/workflows/zig-agents.yml').read_text()
        return text,ns['conditions'],lambda rows,**kw:scope['evaluate'](None,rows,**kw),scope['ordinary_native_http_workflow']

    def test_actual_isolated_workflow_routes_skip_all_heavy_jobs_and_preserve_old_routes(self):
        import itertools
        text,conditions,evaluate,inverse=self.workflow_api();rows=conditions(text)
        only='[zig-paired-linux] [zig-native-http-diagnostic-only]'
        self.assertEqual(evaluate(rows,message=only),{'native-http','paired-linux-inputs'})
        self.assertEqual(evaluate(rows,message=only+' [zig-native-case]'),{'paired-linux-inputs'})
        old=conditions(inverse(text))
        for message in ['',api.MARKER,'[zig-native-case]','[zig-paired-linux]','[zig-aleo-fullcase-only]','[zig-svm-prerequisites-only]']:
            with self.subTest(message=message):self.assertEqual(evaluate(rows,message=message),evaluate(old,message=message))
        for values in itertools.product([False,True],repeat=6):
            flags=dict(zip(['paired','svm','cold','full','sdk','docker'],values))
            with self.subTest(flags=flags):self.assertEqual(evaluate(rows,event='workflow_dispatch',**flags),evaluate(old,event='workflow_dispatch',**flags))
        native=text.split('      - name: Exercise actual native HTTP/2 and cancellation\n',1)[1]
        suite=next(line.strip().removeprefix('if: ')for line in native.splitlines()if line.strip().startswith('if: '))
        self.assertEqual(evaluate({'suite':suite},message=only),set())
        self.assertEqual(evaluate({'suite':suite},message='ordinary'),{'suite'})
        self.assertEqual(evaluate({'suite':suite},message=api.ONLY_MARKER),{'suite'})


class FullSuiteModeControls(unittest.TestCase):
    def event(self,message):return {'head_commit':{'message':message}}
    def full(self):return api.ONLY_MARKER+' [zig-paired-linux] '+api.FULL_MARKER

    def test_actual_closed_profiles_preserve_filtered_and_use_ordinary_full_bound(self):
        self.assertEqual(api.selected_profile('push',api.REF,self.event(api.MARKER)),'filtered')
        self.assertEqual(api.selected_profile('push',api.REF,self.event(api.ONLY_MARKER+' [zig-paired-linux]')),'filtered')
        self.assertEqual(api.selected_profile('push',api.REF,self.event(self.full())),'ordered-full-suite')
        self.assertEqual(api.selected_profile('push',api.REF,self.event(self.full()+' '+api.MARKER)),'ordered-full-suite')
        self.assertEqual(api.profile_limits('filtered'),{'inner':300,'outer':340})
        self.assertEqual(api.profile_limits('ordered-full-suite'),{'inner':1200,'outer':1240})
        changed=api.profile_limits('filtered');changed['inner']=1
        self.assertEqual(api.profile_limits('filtered')['inner'],300)
        for value in ['arbitrary',None,True,{},[]]:
            with self.subTest(value=value),self.assertRaises(ValueError):api.profile_limits(value)

    def test_malformed_full_including_old_marker_never_falls_back_or_enters_effects(self):
        messages=[api.FULL_MARKER,api.MARKER+' '+api.FULL_MARKER,api.FULL_MARKER+' [zig-paired-linux]',api.ONLY_MARKER+' '+api.FULL_MARKER,self.full()+' [zig-native-case]',self.full()+' [zig-svm-prerequisites-only]']
        contexts=[('push',api.REF,message)for message in messages]+[('workflow_dispatch',api.REF,self.full()),('pull_request',api.REF,self.full()),('push','refs/heads/main',self.full())]
        with mock.patch.object(api,'payload',side_effect=AssertionError('payload entered'))as payload,mock.patch.object(api,'public_context',side_effect=AssertionError('native entered'))as native,mock.patch.object(api.Path,'mkdir',side_effect=AssertionError('output entered'))as mkdir:
            for name,ref,message in contexts:
                with self.subTest(name=name,ref=ref,message=message):
                    self.assertFalse(api.authorized(name,ref,self.event(message)))
                    with self.assertRaisesRegex(ValueError,'Explicit feature push'):api.selected_profile(name,ref,self.event(message))
            payload.assert_not_called();native.assert_not_called();mkdir.assert_not_called()

    def test_actual_command_changes_only_fixed_inner_bound_and_filter_tokens(self):
        repo=Path('/actual/source');output=Path('/actual/output')
        filtered=api.profile_command(repo,output,'filtered');full=api.profile_command(repo,output,'ordered-full-suite')
        expected=[api.sys.executable,str(repo/'zig/tools/native_http_tests.py'),'--timeout-seconds','300','--diagnostic-dir',str(output/'inner-owner'),'--',api.sys.executable,str(repo/'zig/tools/zig.py'),'test','src/root.zig','--test-filter',api.FILTER,'-j2','-OReleaseSafe','-lc']
        self.assertEqual(filtered,expected);expected[3]='1200';del expected[11:13]
        self.assertEqual(full,expected);self.assertNotIn('--test-filter',full);self.assertEqual(full[-3:],['-j2','-OReleaseSafe','-lc'])
        with self.assertRaises(ValueError):api.profile_command(repo,output,'custom')

    def test_actual_context_reports_profile_and_clean_environment_nonequivalence(self):
        from types import SimpleNamespace as N
        expected=['PATH','HOME','RUNNER_TEMP','ZIG','LC_ALL','HYPERLANE_ZIG_SDKROOT'];self.assertEqual(list(api.CHILD_ENV_KEYS),expected)
        with tempfile.TemporaryDirectory()as directory:
            root=Path(directory).resolve();compiler=root/'zig';compiler.write_bytes(b'public fake compiler bytes')
            library=N(curl_version=mock.Mock(return_value=b'public curl component fixture'))
            with mock.patch.dict(api.os.environ,ZIG=str(compiler)),mock.patch.object(api.subprocess,'run',return_value=N(stdout=b'0.15.2\n',stderr=b''))as version,mock.patch.object(api.ctypes,'CDLL',return_value=library)as load,mock.patch.object(api.os,'sched_getaffinity',return_value={1,2},create=True):
                for profile in ['filtered','ordered-full-suite']:
                    value=api.public_context(root,profile)
                    self.assertEqual(value['execution_profile'],profile);self.assertEqual(value['command_timeouts_seconds'],api.profile_limits(profile))
                    self.assertEqual(value['child_environment_policy'],{'kind':'explicit-allowlist','allowed_keys':expected,'ambient_equivalence_to_ordinary_suite':False})
                self.assertEqual(version.call_count,2);self.assertEqual(load.call_count,2)
                for call in version.call_args_list:self.assertEqual(call.args[0],[str(compiler),'version']);self.assertEqual(call.kwargs['timeout'],5);self.assertEqual(call.kwargs['env'],{'PATH':'/usr/bin:/bin'})
        tree=ast.parse(Path(api.__file__).read_bytes());main=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='main')
        env=next(n.value for n in ast.walk(main)if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='env'for t in n.targets))
        values={name:'public-'+name for name in expected};values.update(GH_TOKEN='PRIVATE_TOKEN',AWS_SECRET_ACCESS_KEY='PRIVATE_AWS')
        self.assertEqual(ast.unparse(env),'child_environment(profile, os.environ)')
        scope={'os':N(environ=values),'child_environment':api.child_environment,'profile':'ordered-full-suite'}
        captured=eval(compile(ast.Expression(env),'actual-clean-child-env','eval'),scope)
        self.assertEqual(set(captured),set(expected));self.assertNotIn('PRIVATE',json.dumps(captured))

    def test_main_admits_profile_before_overlay_and_uses_same_fixed_owner_clock(self):
        tree=ast.parse(Path(api.__file__).read_bytes());main=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='main')
        calls=[n for n in ast.walk(main)if isinstance(n,ast.Call)]
        selected=next(n for n in calls if isinstance(n.func,ast.Name)and n.func.id=='selected_profile')
        later=[n for n in calls if (isinstance(n.func,ast.Name)and n.func.id in {'payload','public_context','diagnostic'})or(isinstance(n.func,ast.Attribute)and n.func.attr=='mkdir')]
        self.assertTrue(later);self.assertTrue(all(selected.lineno<n.lineno for n in later))
        owner=next(n for n in calls if isinstance(n.func,ast.Attribute)and n.func.attr=='run_command')
        self.assertEqual(ast.unparse(owner.args[3]),"limits['outer']")
        self.assertIn("restoration and ownership require their separate qualified fields",Path(api.__file__).read_text())
        self.assertIn("'full_suite_or_fix_acceptance': False",Path(api.__file__).read_text())
        parser=next(n for n in ast.walk(main)if isinstance(n,ast.Call)and isinstance(n.func,ast.Attribute)and n.func.attr=='add_argument')
        self.assertEqual(ast.literal_eval(parser.args[0]),'--output')
        self.assertEqual(sum(isinstance(n.func,ast.Attribute)and n.func.attr=='add_argument'for n in calls),1)

    def test_actual_fourth_timeout_hunk_and_ordinary_routes_have_exact_modes(self):
        import re
        from types import SimpleNamespace as N
        text,conditions,evaluate,inverse=DecisiveSourceAndRouteControls.workflow_api(self)
        body=text.split('      - name: Diagnose native HTTP test312\n',1)[1].split('      - uses:',1)[0]
        value=next(line.strip().split(': ',1)[1]for line in body.splitlines()if line.strip().startswith('timeout-minutes:'))
        code=value.removeprefix('${{ ').removesuffix(' }}');code=re.sub(r'!(?!=)',' not ',code).replace('&&',' and ').replace('||',' or ').strip()
        def actual(name,ref,message):
            scope={'github':N(event_name=name,ref=ref,event=N(head_commit=N(message=message))),'contains':lambda text,needle:needle in text}
            return eval(compile(code,'actual-nativeHTTP-step-timeout','eval'),{'__builtins__':{}},scope)
        self.assertEqual(actual('push',api.REF,self.full()),23)
        for name,ref,message in [('push',api.REF,api.MARKER),('push',api.REF,api.ONLY_MARKER+' [zig-paired-linux]'),('push',api.REF,api.MARKER+' '+api.FULL_MARKER),('push',api.REF,api.ONLY_MARKER+' '+api.FULL_MARKER),('push','refs/heads/main',self.full()),('workflow_dispatch',api.REF,self.full()),('push',api.REF,self.full()+' [zig-native-case]')]:
            with self.subTest(name=name,ref=ref,message=message):self.assertEqual(actual(name,ref,message),7)
        self.assertEqual(evaluate(conditions(text),message=self.full()),{'native-http','paired-linux-inputs'})
        self.assertNotIn('[zig-native-http-full-suite]',inverse(text))
        self.assertIn('timeout-minutes: 40',text.split('\n  native-http:',1)[1].split('\n  native-linux:',1)[0])


class InheritedEnvironmentControls(unittest.TestCase):
    def full(self):return api.ONLY_MARKER+' [zig-paired-linux] '+api.FULL_MARKER+' '+api.ENV_MARKER
    def event(self,message):return {'head_commit':{'message':message}}

    def test_exact_four_markers_required_before_legacy_fallback_or_effects(self):
        message=self.full()
        self.assertEqual(api.selected_profile('push',api.REF,self.event(message)),'ordered-full-suite-inherited-env')
        self.assertEqual(api.selected_profile('push',api.REF,self.event(message+' '+api.MARKER)),'ordered-full-suite-inherited-env')
        invalid=[message.replace(token,'')for token in [api.ONLY_MARKER,'[zig-paired-linux]',api.FULL_MARKER]]
        invalid += [api.ENV_MARKER,api.ENV_MARKER+' '+api.MARKER,message+' [zig-native-case]',message+' [zig-svm-prerequisites-only]']
        contexts=[('push',api.REF,text)for text in invalid+ [text+' '+api.MARKER for text in invalid]]
        contexts += [('workflow_dispatch',api.REF,message),('pull_request',api.REF,message),('push','refs/heads/main',message)]
        with mock.patch.object(api,'payload',side_effect=AssertionError('payload effect'))as payload,mock.patch.object(api,'public_context',side_effect=AssertionError('native effect'))as native,mock.patch.object(api.Path,'mkdir',side_effect=AssertionError('output effect'))as mkdir:
            for name,ref,text in contexts:
                with self.subTest(name=name,ref=ref,message=text):
                    self.assertFalse(api.authorized(name,ref,self.event(text)))
                    with self.assertRaisesRegex(ValueError,'Explicit feature push'):api.selected_profile(name,ref,self.event(text))
            payload.assert_not_called();native.assert_not_called();mkdir.assert_not_called()

    def test_inherited_copy_matches_actual_ordinary_wrapper_policy_and_is_private(self):
        values={'PATH':'public path','PRIVATE_ENV_NAME':'PRIVATE_ENV_VALUE','GH_TOKEN':'PRIVATE_TOKEN_VALUE'}
        inherited=api.child_environment('ordered-full-suite-inherited-env',values)
        self.assertEqual(inherited,values);self.assertIsNot(inherited,values)
        inherited['PATH']='changed';self.assertEqual(values['PATH'],'public path')
        for profile in ['filtered','ordered-full-suite']:
            self.assertEqual(api.child_environment(profile,values),{'PATH':'public path'})
        for profile in ['custom',None,True]:
            with self.assertRaises(ValueError):api.child_environment(profile,values)
            with self.assertRaises(ValueError):api.environment_policy(profile)
        repo=Path(__file__).resolve().parents[2];tree=ast.parse((repo/'zig/tools/native_http_tests.py').read_bytes())
        main=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='main')
        env=next(n.value for n in ast.walk(main)if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='env'for t in n.targets))
        self.assertEqual(ast.unparse(env),'os.environ.copy()')
        fields=[n.targets[0].slice.value for n in ast.walk(main)if isinstance(n,ast.Assign)and isinstance(n.targets[0],ast.Subscript)and isinstance(n.targets[0].value,ast.Name)and n.targets[0].value.id=='env']
        self.assertEqual(fields,['HYPERLANE_COSMOS_GRPC_TEST_URL','HYPERLANE_CURL_LIBRARY','HYPERLANE_CLOUD_CURL_LIBRARY','HYPERLANE_TEST_RSA_FIXTURE_DIR','HYPERLANE_LIBCRYPTO_LIBRARY'])
        policy=api.environment_policy('ordered-full-suite-inherited-env')
        self.assertEqual(policy,{'kind':'inherited-copy','ordinary_wrapper_policy_match':True,'actual_cross_run_environment_equivalence':False})
        with mock.patch.dict(api.os.environ,values,clear=True):
            wire=json.dumps(api.environment_policy('ordered-full-suite-inherited-env'),sort_keys=True)
        for secret in ['PRIVATE_ENV_NAME','PRIVATE_ENV_VALUE','GH_TOKEN','PRIVATE_TOKEN_VALUE']:self.assertNotIn(secret,wire)
        self.assertNotIn('allowed_keys',policy);self.assertNotIn('count',policy)

    def test_actual_public_context_for_inherited_profile_never_lists_ambient_keys(self):
        from types import SimpleNamespace as N
        with tempfile.TemporaryDirectory()as directory:
            root=Path(directory).resolve();compiler=root/'zig';compiler.write_bytes(b'public fake compiler bytes')
            library=N(curl_version=mock.Mock(return_value=b'public curl component fixture'))
            with mock.patch.dict(api.os.environ,{'ZIG':str(compiler),'PRIVATE_ENV_NAME':'PRIVATE_ENV_VALUE','GH_TOKEN':'PRIVATE_TOKEN_VALUE'},clear=True),mock.patch.object(api.subprocess,'run',return_value=N(stdout=b'0.15.2\n',stderr=b'')),mock.patch.object(api.ctypes,'CDLL',return_value=library),mock.patch.object(api.os,'sched_getaffinity',return_value={1,2},create=True):
                value=api.public_context(root,'ordered-full-suite-inherited-env')
            self.assertEqual(value['child_environment_policy'],{'kind':'inherited-copy','ordinary_wrapper_policy_match':True,'actual_cross_run_environment_equivalence':False})
            self.assertEqual(value['command_timeouts_seconds'],{'inner':1200,'outer':1240})
            wire=json.dumps(value,sort_keys=True)
            for secret in ['PRIVATE_ENV_NAME','PRIVATE_ENV_VALUE','GH_TOKEN','PRIVATE_TOKEN_VALUE']:self.assertNotIn(secret,wire)

    def test_inherited_profile_has_same_exact_full_command_and_closed_clocks(self):
        repo=Path('/actual/source');output=Path('/actual/output')
        self.assertEqual(api.profile_command(repo,output,'ordered-full-suite-inherited-env'),api.profile_command(repo,output,'ordered-full-suite'))
        self.assertEqual(api.profile_limits('ordered-full-suite-inherited-env'),{'inner':1200,'outer':1240})
        self.assertEqual(api.profile_limits('filtered'),{'inner':300,'outer':340})
        self.assertNotIn('--test-filter',api.profile_command(repo,output,'ordered-full-suite-inherited-env'))
        text,conditions,evaluate,_=DecisiveSourceAndRouteControls.workflow_api(self)
        self.assertEqual(evaluate(conditions(text),message=self.full()),{'native-http','paired-linux-inputs'})
        self.assertNotIn(api.ENV_MARKER,text)
        self.assertIn("&& 23 || 7 }}",text)

    def test_main_passes_exact_private_copy_to_existing_owner_and_publishes_only_policy(self):
        from types import SimpleNamespace as N
        import contextlib,io
        with tempfile.TemporaryDirectory()as directory:
            root=Path(directory).resolve();event=root/'event.json';output=root/'result';head='a'*40
            event.write_text(json.dumps({'after':head,'head_commit':{'id':head,'message':self.full()}}))
            values={'PATH':'public path','GITHUB_EVENT_PATH':str(event),'GITHUB_EVENT_NAME':'push','GITHUB_REF':api.REF,'GITHUB_SHA':head,'RUNNER_TEMP':str(root),'PRIVATE_ENV_NAME':'PRIVATE_ENV_VALUE','GH_TOKEN':'PRIVATE_TOKEN_VALUE'}
            actual=[]
            def run(command,repo,env,seconds,owner):
                self.assertEqual(env,values);self.assertIsNot(env,api.os.environ)
                self.assertEqual(command,api.profile_command(repo,output,'ordered-full-suite-inherited-env'))
                self.assertEqual(seconds,1240);self.assertEqual(owner,output/'outer-owner');actual.append(True);return 0
            owned=N(run_command=run);loader=N(exec_module=lambda module:None)
            class Log:
                retained=0;overflow=False;failure=None
                def __init__(self,path):pass
                def __enter__(self):return self
                def __exit__(self,*args):pass
            def diagnose(repo,destination,replacement,execute,inventory):
                self.assertEqual(replacement,b'public synthetic Source');self.assertEqual(execute(),0)
                return {'diagnostic_only':True,'command_exit_code':0,'source_restored':True,'owned_consumers_absent':True,'runtime_acceptance':False}
            captured=io.StringIO()
            with mock.patch.dict(api.os.environ,values,clear=True),mock.patch.object(api.sys,'argv',['runner','--output',str(output)]),mock.patch.object(api.sys,'platform','linux'),mock.patch.object(api.platform,'machine',return_value='x86_64'),mock.patch.object(api.subprocess,'run',return_value=N(stdout=(head+'\n').encode())),mock.patch.object(api,'payload',return_value=b'public synthetic Source'),mock.patch.object(api.importlib.util,'spec_from_file_location',return_value=N(loader=loader)),mock.patch.object(api.importlib.util,'module_from_spec',return_value=owned),mock.patch.object(api,'public_context',side_effect=lambda repo,profile:{'execution_profile':profile,'child_environment_policy':api.environment_policy(profile)}),mock.patch.object(api,'BoundedLog',Log),mock.patch.object(api,'diagnostic',side_effect=diagnose),mock.patch.object(api.signal,'signal'),contextlib.redirect_stdout(captured):
                self.assertEqual(api.main(),0)
            self.assertEqual(actual,[True])
            public=captured.getvalue()+''.join(path.read_text()for path in output.iterdir())
            for secret in ['PRIVATE_ENV_NAME','PRIVATE_ENV_VALUE','GH_TOKEN','PRIVATE_TOKEN_VALUE']:self.assertNotIn(secret,public)
            summary=json.loads((output/'summary.json').read_text())
            self.assertEqual(summary['execution_profile'],'ordered-full-suite-inherited-env');self.assertIsNone(summary['target_filter'])
            self.assertEqual(summary['child_environment_policy'],api.environment_policy('ordered-full-suite-inherited-env'))
            self.assertFalse(summary['full_suite_or_fix_acceptance']);self.assertFalse(summary['runtime_acceptance'])
            self.assertIn('cause remains unknown',summary['interpretation']);self.assertIn('restoration and ownership require their separate qualified fields',summary['interpretation'])


if __name__ == '__main__':
    unittest.main()
