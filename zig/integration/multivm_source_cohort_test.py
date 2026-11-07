"""Producer/runtime identity stays distinct from current execution source."""
import copy
import hashlib
import json
import pathlib
import tempfile
import unittest
import multivm_evidence as evidence


class SourceCohortTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ziggy-source-cohort-')
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.runtime, self.execution = 'a' * 40, 'b' * 40
        self.manifest = {'runtime_source_commit': self.runtime}
        self.log = self.root / 'comparison.log'
        self.log.write_text('public comparison completed\n')
        self.receipt = {'schema': 1, 'runtime_source_commit': self.runtime, 'helper_source_commit': self.runtime, 'tools_source_commit': self.runtime, 'execution_source_commit': self.execution, 'source_unchanged': True, 'native_case_acceptance': False, 'scopes': {key: [{'path': name, 'producer_tree': None if name.endswith('.zon') else 'c' * 40, 'current_tree': None if name.endswith('.zon') else 'c' * 40, 'worktree_unchanged': True} for name in names] for key, names in evidence.COMPILED_INPUT_SCOPES.items()}, 'checks': [{'exit_code': 0, 'log': self.pin(self.log)}]}

    def pin(self, path):
        return {'path': str(path), 'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}

    def check(self, receipt=None, execution=None):
        path = self.root / 'closure.json'
        path.write_text(json.dumps(self.receipt if receipt is None else receipt))
        return evidence.validate_compiled_input_closure(self.manifest, {'execution_source_commit': self.execution if execution is None else execution, 'compiled_input_closure': self.pin(path)})

    def test_changed_execution_same_compiled_inputs_preserves_runtime_identity(self):
        self.assertEqual(self.check(), self.execution)
        self.assertEqual(self.manifest['runtime_source_commit'], self.runtime)

    def test_same_commit_legacy_requires_no_cross_source_receipt(self):
        self.assertEqual(evidence.validate_compiled_input_closure(self.manifest, {}), self.runtime)
        with self.assertRaisesRegex(ValueError, 'requires compiled input closure'):
            evidence.validate_compiled_input_closure(self.manifest, {'execution_source_commit': self.execution})

    def test_all_compiled_categories_and_exact_scopes_required(self):
        for key in evidence.COMPILED_INPUT_SCOPES:
            changed = copy.deepcopy(self.receipt)
            changed['scopes'][key].pop()
            with self.subTest(key=key), self.assertRaises(ValueError): self.check(changed)
        changed = copy.deepcopy(self.receipt)
        changed['scopes']['runtime'].append(copy.deepcopy(changed['scopes']['runtime'][0]))
        with self.assertRaises(ValueError): self.check(changed)

    def test_changed_input_or_dirty_worktree_rejects(self):
        for field, value in [('current_tree', 'd' * 40), ('worktree_unchanged', False), ('producer_tree', None)]:
            changed = copy.deepcopy(self.receipt)
            changed['scopes']['runtime'][0][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError): self.check(changed)

    def test_distinct_or_relabelled_producer_commit_rejects(self):
        for key in ['runtime_source_commit', 'helper_source_commit', 'tools_source_commit', 'execution_source_commit']:
            changed = copy.deepcopy(self.receipt)
            changed[key] = 'd' * 40
            with self.subTest(key=key), self.assertRaises(ValueError): self.check(changed)

    def test_failed_or_changed_comparison_log_rejects(self):
        changed = copy.deepcopy(self.receipt)
        changed['checks'][0]['exit_code'] = 1
        with self.assertRaises(ValueError): self.check(changed)
        changed['checks'][0]['exit_code'] = False
        with self.assertRaises(ValueError): self.check(changed)
        self.log.write_text('changed')
        with self.assertRaises(ValueError): self.check()

    def test_receipt_not_native_acceptance_and_exact_scalar_types(self):
        for key, value in [('source_unchanged', 1), ('native_case_acceptance', True), ('schema', True)]:
            changed = copy.deepcopy(self.receipt); changed[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError): self.check(changed)


if __name__ == '__main__': unittest.main()
