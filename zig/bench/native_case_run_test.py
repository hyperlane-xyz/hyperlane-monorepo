"""Closed composition controls; imports no SDK and executes no prerequisite."""
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
        self.assertIn('node-version-file:',section);self.assertIn('version: v1.5.0',section)
        self.assertNotIn('docker build',section);self.assertNotIn('cargo build',section)

    def test_public_uploads_exclude_raw_native_logs_databases_configs_and_wires(self):
        workflow=(Path(__file__).resolve().parents[2]/'.github/workflows/zig-agents.yml').read_text()
        public=workflow.split('name: native-case-public-results-',1)[1]
        for forbidden in ['observer.log','harness.log','agent-logs','databases/','capture/','keyring','generated-slots','case-inputs.json','execution-approval.json','controller.json']:
            self.assertNotIn(forbidden,public)
        self.assertIn('/ci-supervision/result.json',public)
        self.assertIn('/actual-interop-ReleaseSafe.json',public)
        self.assertIn('/actual-interop-ReleaseFast.json',public)


if __name__=='__main__':unittest.main()
