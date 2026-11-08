"""Closed composition controls; imports no SDK and executes no prerequisite."""
import ast
import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('native_case_run',Path(__file__).with_name('native_case_run.py'))
api=importlib.util.module_from_spec(spec);spec.loader.exec_module(api)


class CompositionTests(unittest.TestCase):
    def setUp(self):
        self.context={'runtime_source_commit':'a'*40,'writers':{mode:{'path':'/public/'+mode,'sha256':('b' if mode=='ReleaseSafe' else 'c')*64} for mode in ['ReleaseSafe','ReleaseFast']},'tools':{'ziggy-native-rows':{'path':'/public/reader','sha256':'d'*64}},'tool_manifest':{'path':'/public/tool-manifest.json','sha256':'e'*64}}

    def test_both_mode_commands_bind_actual_writer_reader_and_independent_tool_source(self):
        for mode in ['ReleaseSafe','ReleaseFast']:
            argv=api.interop_command(Path('/checkout'),self.context,mode,Path('/owned/'+mode+'.json'))
            values={argv[index]:argv[index+1] for index in range(4,len(argv),2)}
            self.assertEqual(values['--writer'],self.context['writers'][mode]['path'])
            self.assertEqual(values['--writer-sha256'],self.context['writers'][mode]['sha256'])
            self.assertEqual(values['--reader-sha256'],'d'*64)
            self.assertEqual(values['--tool-source-commit'],'a'*40)
            self.assertEqual(values['--tool-manifest-sha256'],'e'*64)
            self.assertNotIn('--old-oracle',argv)
            self.assertNotIn('--message-reference',argv)

    def test_unknown_or_mislabelled_writer_mode_rejects(self):
        with self.assertRaises(ValueError):api.interop_command(Path('/checkout'),self.context,'ReleaseSmall',Path('/owned/result'))

    def test_workflow_is_case_only_explicitly_approved_and_has_real_phase_budgets(self):
        workflow=(Path(__file__).resolve().parents[2]/'.github/workflows/zig-agents.yml').read_text()
        section=workflow.split('  native-case-producer-inputs:',1)[1]
        self.assertIn("contains(github.event.head_commit.message, '[zig-native-case]')",section)
        self.assertIn('timeout-minutes: 190',section);self.assertIn('timeout-minutes: 142',section)
        self.assertIn("if: steps.request.outputs.enabled == 'true'",section)
        self.assertIn('zig/bench/native_case_run.py --execute',section)
        self.assertIn('node-version-file:',section)
        job = section.split('  aleo-linux-sdk-prerequisite:', 1)[0]
        start = '      - name: Install verified official Foundry v1.5.0'
        end = '      - name: Install explicit native-case host prerequisites'
        self.assertIn(start, job); self.assertIn(end, job)
        installer = job.split(start, 1)[1].split(end, 1)[0]
        self.assertIn("if: steps.request.outputs.enabled == 'true'", installer)
        self.assertIn('FOUNDRY_GITHUB_TOKEN: ${{ github.token }}', installer)
        self.assertIn('python3 -I -B -W error zig/tools/foundry_official_test.py -v', installer)
        self.assertIn('python3 -I -B zig/tools/foundry_official.py', installer)
        self.assertIn('--runner-temp "$RUNNER_TEMP"', installer)
        self.assertIn('--gh "$(readlink -f "$(command -v gh)")"', installer)
        self.assertIn('cat -- "$RUNNER_TEMP/ziggy-foundry-v1.5.0/result.json"', installer)
        self.assertIn('echo "$RUNNER_TEMP/ziggy-foundry-v1.5.0/bin" >> "$GITHUB_PATH"', installer)
        source = Path(__file__).resolve().parents[2] / 'zig/tools/foundry_official.py'
        tree = ast.parse(source.read_bytes())
        versions = [node.value for node in tree.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'VERSION' for target in node.targets)]
        self.assertEqual(len(versions), 1); self.assertEqual(ast.literal_eval(versions[0]), 'v1.5.0')
        self.assertNotIn('docker build',section);self.assertNotIn('cargo build',section)

    def test_public_uploads_exclude_raw_native_logs_databases_configs_and_wires(self):
        workflow=(Path(__file__).resolve().parents[2]/'.github/workflows/zig-agents.yml').read_text()
        public=workflow.split('name: native-case-public-results-',1)[1]
        for forbidden in ['observer.log','harness.log','agent-logs','databases/','capture/','keyring','generated-slots','case-inputs.json','execution-approval.json','controller.json']:
            self.assertNotIn(forbidden,public)
        self.assertIn('/ci-supervision/result.json',public)
        self.assertIn('/actual-interop-ReleaseSafe.json',public)
        self.assertIn('/actual-interop-ReleaseFast.json',public)



class ResourceWitnessControls(unittest.TestCase):
    def invoke_actual_run(self, allocated=5*api.GIB, free=8*api.GIB, decline=0, rss=0, now=1, post=2, output_root=False, skip_live=False, scenario='cosmosnative'):
        import tempfile
        from types import SimpleNamespace
        from unittest import mock
        root=Path(tempfile.mkdtemp(prefix='composition-resource-control-')).resolve();self.addCleanup(lambda:__import__('shutil').rmtree(root))
        output=root/'composition';output.mkdir();(output/'logs').mkdir();case=root/'case';case.mkdir()
        child=SimpleNamespace(pid=42,returncode=0);cleanup={'clean':True,'actual_parent_wait':True,'exit_code':0,'signals':[]}
        process_owner=SimpleNamespace(processes=mock.Mock(return_value={}),owned_processes=mock.Mock(return_value={42:{'rss_bytes':rss}}),stop_owned=mock.Mock(return_value=cleanup))
        census=SimpleNamespace(functional_allocated=mock.Mock(return_value=allocated));checks=[]
        clock=mock.Mock(side_effect=[0,post]if skip_live else[0,now,post]);environment={'args':SimpleNamespace(output=output,case_root=case,repo=Path('/not-executed')),'time':SimpleNamespace(monotonic=clock,sleep=lambda _:None),'subprocess':SimpleNamespace(Popen=mock.Mock(return_value=child),DEVNULL=-3,STDOUT=-2),'os':SimpleNamespace(waitid=mock.Mock(side_effect=[object()]if skip_live else[None,object()]),P_PID=1,WEXITED=1,WNOHANG=2,WNOWAIT=4),'shutil':SimpleNamespace(disk_usage=lambda _:SimpleNamespace(free=free)),'owner':process_owner,'census':census,'checks':checks,'initial_free':free+decline,'env':{},'GIB':api.GIB,'require':api.require,'pin':api.pin,'phase_resource_failure':api.phase_resource_failure,'request':{'scenario':scenario,'limits':{'maximum_case_allocated_bytes':8*api.GIB}},'signal':SimpleNamespace(SIGTERM=15,SIGINT=2,SIGHUP=1,SIG_IGN=1,signal=lambda *a:None)}
        tree=ast.parse(Path(api.__file__).read_bytes());main=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='main');run=next(n for n in main.body if isinstance(n,ast.FunctionDef)and n.name=='run');exec(compile(ast.Module(body=[run],type_ignores=[]),str(api.__file__),'exec'),environment)
        error=None
        try:environment['run']('owned-native-case',['PRIVATE_ARG_NOT_EXECUTED'],10,output if output_root else case)
        except Exception as caught:error=caught
        return checks,process_owner,census,error

    def test_actual_case_and_output_allocation_checks_accept4to8_and_refuse_over8_live_and_postflight(self):
        for output in [False,True]:
            for postflight in [False,True]:
                for amount in [5*api.GIB,8*api.GIB,8*api.GIB+1]:
                    with self.subTest(output_root=output,postflight=postflight,bytes=amount):
                        checks,owner,census,error=self.invoke_actual_run(allocated=amount,output_root=output,skip_live=postflight)
                        owner.stop_owned.assert_called_once()
                        if amount<=8*api.GIB:self.assertIsNone(error);self.assertNotIn('resource_guard_failure',checks[0])
                        else:self.assertIsInstance(error,ValueError);self.assertIn('allocation cap',str(error))
                        self.assertTrue(checks[0]['actual_parent_wait'])

    def test_each_original_live_conjunct_is_retained_before_refusal_and_cleanup_still_runs(self):
        cases=[({'now':10},'before_original_phase_deadline'),({'rss':8*api.GIB+1},'owned_RSS_at_most8GiB'),({'free':6*api.GIB-1},'host_free_at_least6GiB'),({'decline':12*api.GIB+1},'whole_composition_decline_at_most12GiB')]
        for changes,failed in cases:
            with self.subTest(failed=failed):
                checks,owner,census,error=self.invoke_actual_run(**changes);self.assertIsInstance(error,ValueError);self.assertEqual(str(error),'Composition phase deadline/RSS/total-growth/free guard');owner.stop_owned.assert_called_once();census.functional_allocated.assert_not_called()
                witness=checks[0]['resource_guard_failure'];self.assertEqual(witness['failed_conjuncts'],[failed]);self.assertFalse(witness['conjuncts'][failed]);self.assertEqual(witness['sample_scope'],'live');self.assertFalse(witness['native_or_timing_or_cleanup_authority']);self.assertNotIn('PRIVATE',str(witness))
                self.assertEqual(witness['limits'],{'owned_RSS_bytes':8*api.GIB,'minimum_host_free_bytes':6*api.GIB,'maximum_whole_composition_host_free_decline_bytes':12*api.GIB})

    def test_original_exact_boundaries_and_late_postflight_failure_are_not_reset(self):
        self.assertIsNone(api.phase_resource_failure('owned-native-case','live',9,10,8*api.GIB,6*api.GIB,18*api.GIB,scenario='cosmosnative'))
        checks,owner,census,error=self.invoke_actual_run(post=10);self.assertEqual(str(error),'Phase postflight original deadline/growth/free guard')
        witness=checks[0]['resource_guard_failure'];self.assertEqual(witness['failed_conjuncts'],['before_original_phase_deadline']);self.assertEqual(witness['original_phase_deadline_monotonic_seconds'],10);self.assertEqual(witness['sample_scope'],'postflight');self.assertIsNone(witness['owned_RSS_bytes']);self.assertNotIn('owned_RSS_at_most8GiB',witness['conjuncts'])
        owner.stop_owned.assert_called_once();self.assertEqual(census.functional_allocated.call_count,2)

class TronStorageProfileControls(unittest.TestCase):
    invoke_actual_run=ResourceWitnessControls.invoke_actual_run
    # Reuse actual nested run, including its live/postflight checks and cleanup.
    def test_tron13to16GiB_decline_uses_one_original_baseline_and_over16_refuses(self):
        for postflight in [False,True]:
            for decline in [13*api.GIB,16*api.GIB,16*api.GIB+1]:
                with self.subTest(postflight=postflight,decline=decline):
                    checks,owner,census,error=self.invoke_actual_run(scenario='tron',decline=decline,skip_live=postflight)
                    owner.stop_owned.assert_called_once()
                    self.assertTrue(checks[0]['actual_parent_wait'])
                    if decline<=16*api.GIB:
                        self.assertIsNone(error);self.assertNotIn('resource_guard_failure',checks[0])
                    else:
                        self.assertIsInstance(error,ValueError);witness=checks[0]['resource_guard_failure']
                        self.assertEqual(witness['composition_storage_profile'],'TRON_16GiB')
                        self.assertEqual(witness['whole_composition_host_free_decline_bytes'],decline)
                        self.assertEqual(witness['composition_initial_free_bytes'],8*api.GIB+decline)
                        self.assertEqual(witness['limits']['maximum_whole_composition_host_free_decline_bytes'],16*api.GIB)
                        self.assertEqual(witness['failed_conjuncts'],['whole_composition_decline_at_most16GiB'])
                        self.assertEqual(witness['sample_scope'],'postflight'if postflight else'live')
                        self.assertFalse(witness['native_or_timing_or_cleanup_authority'])

    def test_all_other_families_keep12GiB_and_tron_keeps_RSS_free_deadline_allocation(self):
        for family in ['evm','cosmosnative','cosmwasm','starknet','sealevel','sealevel-composite','radix']:
            for postflight in [False,True]:
                for decline in [12*api.GIB,12*api.GIB+1]:
                    with self.subTest(family=family,postflight=postflight,decline=decline):
                        checks,owner,census,error=self.invoke_actual_run(scenario=family,decline=decline,skip_live=postflight)
                        owner.stop_owned.assert_called_once()
                        if decline==12*api.GIB:self.assertIsNone(error)
                        else:
                            self.assertIsInstance(error,ValueError);witness=checks[0]['resource_guard_failure']
                            self.assertEqual(witness['composition_storage_profile'],'DEFAULT_12GiB')
                            self.assertEqual(witness['limits']['maximum_whole_composition_host_free_decline_bytes'],12*api.GIB)
                            self.assertEqual(witness['failed_conjuncts'],['whole_composition_decline_at_most12GiB'])
        for changes in [dict(rss=8*api.GIB+1),dict(free=6*api.GIB-1),dict(now=10),dict(post=10),dict(allocated=8*api.GIB+1)]:
            with self.subTest(unchanged_guard=changes):
                checks,owner,census,error=self.invoke_actual_run(scenario='tron',decline=13*api.GIB,**changes)
                self.assertIsInstance(error,ValueError);owner.stop_owned.assert_called_once()
        tree=ast.parse(Path(api.__file__).read_bytes());main=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='main')
        calls=[n for n in ast.walk(main)if isinstance(n,ast.Call)and isinstance(n.func,ast.Name)and n.func.id=='phase_resource_failure']
        self.assertEqual(len(calls),2)
        for call in calls:self.assertEqual(ast.dump(call.keywords[0].value),ast.dump(ast.parse("request['scenario']",mode='eval').body))
        source=Path(api.__file__).read_text()
        self.assertEqual(source.count('initial_free=shutil.disk_usage(args.output).free'),1)
        self.assertIn('free>=24*GIB',source)
        self.assertIn('maximum_case_allocated_bytes',source)
        self.assertNotIn('--maximum-decline',source)

if __name__=='__main__':unittest.main()
