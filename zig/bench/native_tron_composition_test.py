"""Actual composition entry boundary, with rejected metadata and no execution."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock
import uuid

HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location('tron_composition_' + name, HERE / (name + '.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


class EntryControls(unittest.TestCase):
    def test_reviewed_Tron_request_reaches_actual_producer_gate_before_any_process(self):
        fixtures = load('native_tron_integration_test')
        request = fixtures.Integration().request()
        module = load('native_case_run')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            repo = root / 'repo'
            repo.mkdir()
            paths = {}
            for key, value in [('request', request), ('producer-receipt', {'passed': False}), ('tools', {})]:
                path = root / (key + '.json')
                path.write_text(json.dumps(value))
                paths[key] = path
            argv = ['native_case_run.py']
            for key, path in paths.items():
                argv += ['--' + key, str(path), '--' + key + '-sha256', hashlib.sha256(path.read_bytes()).hexdigest()]
            argv += ['--repo', str(repo), '--execution-source-commit', 'a' * 40,
                     '--output', str(root / 'composition'), '--case-root', '/tmp/znc-control-' + uuid.uuid4().hex[:12]]
            with mock.patch.object(sys, 'argv', argv), mock.patch.object(module.subprocess, 'Popen', side_effect=AssertionError('No process permitted')):
                with self.assertRaisesRegex(ValueError, 'Actual producer download cohort differs'):
                    module.main()
            self.assertFalse((root / 'composition').exists())


if __name__ == '__main__':
    unittest.main()
