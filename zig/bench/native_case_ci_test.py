"""No GitHub/network/build/native execution: request/provenance/ZIP controls."""
import copy
import importlib.util
import json
from pathlib import Path
import stat
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('native_case_ci', Path(__file__).with_name('native_case_ci.py'))
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)


class DispatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ziggy-native-dispatch-control-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.request = {'schema': 1, 'root_approved': True, 'scenario': 'evm', 'mode': 'ReleaseSafe', 'producer_source_commit': 'a' * 40, 'producer_run_id': 42, 'producer_run_attempt': 1, 'limits': dict(ci.LIMITS), 'artifact_pins': {}}
        self.request['postgres'] = {'schema': 2, 'architecture': 'amd64', 'image': 'postgres:14', 'image_id': 'sha256:' + 'd' * 64, 'canonical_digest': 'postgres@sha256:' + 'e' * 64}
        self.request['prerequisites'] = {'local_checkout_build': True, 'registry_commit': 'f' * 40, 'hpack': {'version': '4.2.0', 'wheel_sha256': '858ac0b02280fa582b5080d68db0899c6' + '2a80375e0e5413a74970c5e518b6986', 'wheel_bytes': 34246}}
        self.request['artifact_pins'] = {key: {'id': index, 'name': name, 'sha256': 'b' * 64, 'size_in_bytes': 1024} for index, (key, name) in enumerate(ci.artifact_names(self.request).items(), 1)}
        self.run = {'id': 42, 'run_attempt': 1, 'head_sha': 'a' * 40, 'repository': {'full_name': ci.REPOSITORY}, 'head_repository': {'full_name': ci.REPOSITORY}, 'head_branch': ci.BRANCH, 'event': 'push', 'path': '.github/workflows/zig-agents.yml', 'status': 'completed', 'conclusion': 'failure'}
        self.jobs = [{'id': index, 'name': name, 'run_id': 42, 'status': 'completed', 'conclusion': 'success'} for index, name in enumerate(['full-sdk-native (ReleaseSafe)', 'full-sdk-native (ReleaseFast)', 'native-harness-controls'])]
        self.artifacts = [dict(row, expired=False, digest='sha256:' + row['sha256'], workflow_run={'id': 42, 'head_sha': 'a' * 40, 'head_branch': ci.BRANCH}) for row in self.request['artifact_pins'].values()]

    def test_explicit_request_and_actual_completed_producer_jobs(self):
        ci.validate_request(self.request)
        selected = ci.validate_remote(self.request, self.run, self.jobs, self.artifacts)
        self.assertEqual(set(selected['artifacts']), set(self.request['artifact_pins']))
        self.assertEqual(selected['unrelated_workflow_conclusion'], 'failure')
        running = dict(self.run, status='in_progress', conclusion=None)
        self.assertEqual(len(ci.validate_remote(self.request, running, self.jobs, self.artifacts)['required_jobs']), 3)

    def test_false_approval_unknown_fields_and_increased_caps_reject(self):
        for key, value in [('root_approved', False), ('scenario', 'foreign'), ('mode', 'ReleaseSmall'), ('producer_run_id', True), ('execution_source_commit', 'c' * 40)]:
            changed = copy.deepcopy(self.request); changed[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError): ci.validate_request(changed)
        changed = copy.deepcopy(self.request); changed['limits']['maximum_wall_seconds'] += 1
        with self.assertRaises(ValueError): ci.validate_request(changed)

    def test_cross_mode_and_missing_or_repeated_artifact_reject(self):
        for change in [lambda row: row['artifact_pins'].pop('writer_fast'), lambda row: row['artifact_pins']['sdk'].update(name='zig-native-runtime-payload-ReleaseFast'), lambda row: row['artifact_pins']['sdk'].update(id=row['artifact_pins']['helper']['id'])]:
            changed = copy.deepcopy(self.request); change(changed)
            with self.assertRaises(ValueError): ci.validate_request(changed)

    def test_foreign_source_run_attempt_repo_branch_or_event_reject(self):
        for key, value in [('head_sha', 'd' * 40), ('run_attempt', 2), ('status', 'queued'), ('head_repository', {'full_name': 'foreign/repo'}), ('head_branch', 'main'), ('event', 'pull_request')]:
            changed = copy.deepcopy(self.run); changed[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError): ci.validate_remote(self.request, changed, self.jobs, self.artifacts)

    def test_missing_duplicate_failed_or_wrong_mode_job_reject(self):
        for jobs in [self.jobs[:2], self.jobs + [self.jobs[0]], [dict(self.jobs[0], conclusion='failure'), *self.jobs[1:]], [self.jobs[0], dict(self.jobs[1], conclusion='failure'), self.jobs[2]], [self.jobs[0], self.jobs[2]], [self.jobs[0], self.jobs[1], self.jobs[1], self.jobs[2]], [dict(self.jobs[0], name='full-sdk-native (ReleaseSmall)'), *self.jobs[1:]]]:
            with self.assertRaises(ValueError): ci.validate_remote(self.request, self.run, jobs, self.artifacts)

    def test_expired_retagged_digest_or_artifact_run_reject(self):
        for key, value in [('expired', True), ('digest', 'sha256:' + 'e' * 64), ('name', 'other'), ('workflow_run', {'id': 43, 'head_sha': 'a' * 40, 'head_branch': ci.BRANCH})]:
            changed = copy.deepcopy(self.artifacts); changed[0][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError): ci.validate_remote(self.request, self.run, self.jobs, changed)

    def zip(self, rows):
        path = self.root / 'input.zip'
        with zipfile.ZipFile(path, 'w') as archive:
            for name, data, mode in rows:
                info = zipfile.ZipInfo(name); info.external_attr = mode << 16
                archive.writestr(info, data)
        return path

    def test_safe_extraction_never_grants_executable_mode(self):
        archive = self.zip([('bin/tool', b'public fixture', stat.S_IFREG | 0o755)])
        out = self.root / 'out'; rows = ci.extract_closed(archive, out)
        self.assertEqual(rows[0]['relative_path'], 'bin/tool')
        self.assertEqual((out / 'bin/tool').read_bytes(), b'public fixture')
        self.assertFalse((out / 'bin/tool').stat().st_mode & 0o111)

    def test_zip_traversal_symlink_and_file_parent_fail_before_creation(self):
        for rows in [[('../escape', b'x', stat.S_IFREG)], [('/escape', b'x', stat.S_IFREG)], [('link', b'/tmp/foreign', stat.S_IFLNK | 0o777)], [('parent', b'x', stat.S_IFREG), ('parent/child', b'x', stat.S_IFREG)]]:
            archive = self.zip(rows); out = self.root / 'out'
            with self.subTest(rows=rows), self.assertRaises(ValueError): ci.extract_closed(archive, out)
            self.assertFalse(out.exists())

    def test_case_marker_skips_every_regular_sdk_svm_helper_and_cold_job(self):
        workflow = Path(__file__).resolve().parents[2] / '.github/workflows/zig-agents.yml'
        conditions, current, in_jobs = {}, None, False
        for line in workflow.read_text().splitlines():
            if line == 'jobs:': in_jobs = True
            if not in_jobs: continue
            if line.startswith('  ') and not line.startswith('   ') and line.endswith(':'): current = line.strip()[:-1]
            if line.startswith('    if: '): conditions[current] = line[8:]
        ordinary = {'svm-prerequisites', 'unit', 'evm', 'native-http', 'native-linux', 'container', 'vm-images', 'full-sdk-native', 'cold-full-feature', 'native-harness-controls'}
        self.assertEqual(set(conditions), ordinary | {'native-case-producer-inputs', 'aleo-linux-prerequisite'})
        kernel = "!((github.event_name == 'push' && github.ref == 'refs/heads/feat/zig-agent-rewrite' && contains(github.event.head_commit.message, '[zig-aleo-kernel-only]')) || (github.event_name == 'workflow_dispatch' && inputs.aleo_linux_prerequisite))"
        for name, condition in conditions.items():
            if name != 'aleo-linux-prerequisite':
                self.assertTrue(condition.startswith('${{ ' + kernel + ' && ('), name)
        conditions = {name: '${{ ' + condition.removeprefix('${{ ' + kernel + ' && (').removesuffix(') }}') + ' }}' for name, condition in conditions.items() if name != 'aleo-linux-prerequisite'}
        guard = "!(github.event_name == 'push' && github.ref == 'refs/heads/feat/zig-agent-rewrite' && contains(github.event.head_commit.message, '[zig-native-case]'))"
        for name in ordinary:
            self.assertTrue(conditions[name].startswith('${{ ' + guard + ' && ('), name)
        self.assertIn("contains(github.event.head_commit.message, '[zig-native-case]')", conditions['native-case-producer-inputs'])
        self.assertNotIn('!(', conditions['native-case-producer-inputs'])

    def test_svm_only_marker_routes_only_prerequisites(self):
        conditions = self.workflow_conditions()
        actual = {name for name, condition in conditions.items() if self.condition(condition, 'push', '[zig-svm-prerequisites-only]')}
        self.assertEqual(actual, {'svm-prerequisites'})

    def test_svm_only_marker_preserves_case_precedence_and_regular_runs(self):
        conditions = self.workflow_conditions()
        actual = {name for name, condition in conditions.items() if self.condition(condition, 'push', '[zig-native-case] [zig-svm-prerequisites-only]')}
        self.assertEqual(actual, {'native-case-producer-inputs'})
        actual = {name for name, condition in conditions.items() if self.condition(condition, 'push', '[zig-svm-prerequisites]')}
        self.assertIn('svm-prerequisites', actual)
        self.assertIn('full-sdk-native', actual)
        self.assertIn('native-harness-controls', actual)
        self.assertNotIn('native-case-producer-inputs', actual)
        self.assertNotIn('cold-full-feature', actual)

    def test_svm_only_marker_preserves_explicit_dispatch(self):
        conditions = self.workflow_conditions()
        actual = {name for name, condition in conditions.items() if self.condition(condition, 'workflow_dispatch', '', svm=True)}
        self.assertEqual(actual, {'svm-prerequisites'})
        self.assertTrue(self.condition(conditions['cold-full-feature'], 'workflow_dispatch', '', cold=True))
        self.assertFalse(self.condition(conditions['svm-prerequisites'], 'pull_request', '[zig-svm-prerequisites-only]'))
        self.assertTrue(self.condition(conditions['unit'], 'pull_request', '[zig-svm-prerequisites-only]'))

    @staticmethod
    def workflow_conditions():
        path = Path(__file__).resolve().parents[2] / '.github/workflows/zig-agents.yml'
        values, current, in_jobs = {}, None, False
        for line in path.read_text().splitlines():
            if line == 'jobs:': in_jobs = True
            if not in_jobs: continue
            if line.startswith('  ') and not line.startswith('   ') and line.endswith(':'): current = line.strip()[:-1]
            if line.startswith('    if: '): values[current] = line[8:]
        return values

    @staticmethod
    def condition(value, event, message, svm=False, cold=False, aleo=False):
        import re
        from types import SimpleNamespace as N
        code = value.removeprefix('${{ ').removesuffix(' }}')
        code = re.sub(r'!(?!=)', ' not ', code).replace('&&', ' and ').replace('||', ' or ').strip()
        context = {'github': N(event_name=event, ref='refs/heads/feat/zig-agent-rewrite', event=N(head_commit=N(message=message))), 'inputs': N(svm_prerequisites=svm, cold_full_feature=cold, aleo_linux_prerequisite=aleo), 'contains': lambda text, needle: needle in text}
        return bool(eval(compile(code, '<actual-workflow-condition>', 'eval'), {'__builtins__': {}}, context))

    def test_zip_expansion_bound_is_preflight(self):
        archive = self.zip([('large', b'12345', stat.S_IFREG)])
        out = self.root / 'out'
        with self.assertRaises(ValueError): ci.extract_closed(archive, out, maximum_bytes=4)
        self.assertFalse(out.exists())


class PublicDigestRequestTests(unittest.TestCase):
    def read(self, value=None, raw=None):
        with tempfile.TemporaryDirectory(prefix='ziggy-public-digest-control-') as directory:
            path = Path(directory) / 'request.json'
            path.write_text(json.dumps(value) if raw is None else raw)
            return ci.read_request(path)

    def test_literal_policy_preserved(self):
        value = {'schema': 1, 'root_approved': False, 'artifact_pins': None}
        self.assertEqual(self.read(value), value)

    def test_nested_public_hash_and_image_identity_decode_exactly(self):
        for prefix in ('', 'sha256:', 'postgres@sha256:', 'ghcr.io/owner/image@sha256:'):
            wire = {'sha256_hex_chunks': ['a' * 32, 'b' * 32], 'prefix': prefix}
            self.assertEqual(self.read({'list': [wire]})['list'][0], prefix + 'a' * 32 + 'b' * 32)

    def test_wrong_count_type_length_case_or_character_rejected(self):
        for parts in ([], ['a' * 32], ['a' * 32] * 3, 'a' * 32, [True, 'a' * 32], ['a' * 31, 'b' * 32], ['A' * 32, 'b' * 32], ['g' * 32, 'b' * 32]):
            with self.subTest(parts=parts), self.assertRaises(ValueError):
                self.read({'sha256_hex_chunks': parts})

    def test_extra_fields_and_wrong_prefix_rejected(self):
        wire = {'sha256_hex_chunks': ['a' * 32, 'b' * 32]}
        for delta in ({'extra': True}, {'prefix': True}, {'prefix': 'https://foreign/'}, {'prefix': 'postgres@sha1:'}):
            with self.subTest(delta=delta), self.assertRaises(ValueError):
                self.read({**wire, **delta})

    def test_duplicate_policy_keys_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Duplicate request key'):
            self.read(raw='{"root_approved": false, "root_approved": true}')

    def test_policy_depth_and_node_bounds_rejected(self):
        value = None
        for _ in range(18): value = [value]
        with self.assertRaisesRegex(ValueError, 'structure bound'): self.read(value)
        with self.assertRaisesRegex(ValueError, 'structure bound'): self.read([None] * 4096)

    def test_selector_still_needs_original_closed_schema_and_approval(self):
        decoded = self.read({'root_approved': True, 'artifact_pins': {'sha256': {'sha256_hex_chunks': ['a' * 32, 'b' * 32]}}})
        with self.assertRaises(ValueError): ci.validate_request(decoded)


if __name__ == '__main__': unittest.main()
