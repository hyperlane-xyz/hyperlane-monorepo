#!/usr/bin/env python3
"""Pure inventory classification controls; never scan source or produce counts."""
from pathlib import Path
import importlib.util
import sys
import unittest


def deny_effect(event, args):
    if event in {'subprocess.Popen', 'socket.__new__', 'socket.connect', 'socket.bind',
                 'os.system', 'os.fork', 'os.posix_spawn'}:
        raise AssertionError('Unexpected classification-test effect: ' + event)


sys.addaudithook(deny_effect)
spec = importlib.util.spec_from_file_location('tested_inventory', Path(__file__).with_name('inventory.py'))
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


class CategoryControls(unittest.TestCase):
    def categories(self, paths, expected):
        for path in paths:
            with self.subTest(path=path):
                self.assertEqual(api.category(Path(path)), expected)

    def test_bare_zig_test_filenames_are_test_source(self):
        self.categories([prefix + name for prefix in ('', 'zig/src/lander/', 'zig/src/net/deep/')
                         for name in ('test.zig', 'tests.zig', 'testing.zig')],
                        'test_benchmark_or_integration_source')

    def test_existing_test_paths_and_suffixes_stay_test_source(self):
        self.categories(['zig/src/' + folder + '/helper.zig'
                         for folder in ('tests', 'testing', 'test', 'benches', 'bench', 'integration', 'examples')]
                        + ['zig/src/ops/codec' + suffix
                           for suffix in ('_test.zig', '_tests.zig', '_integration.zig', '_bench.zig')],
                        'test_benchmark_or_integration_source')

    def test_fixture_data_and_source_precedence_is_preserved(self):
        self.categories(['zig/src/fixtures/tests.zig', 'zig/src/net/rpc_fixtures/testing.zig'],
                        'test_benchmark_or_integration_source')
        self.categories(['zig/src/fixtures/case.json', 'zig/src/net/rpc_fixtures/case.txt',
                         'zig/src/ops/data.jsonl', 'zig/src/ops/data.jsonl.gz',
                         'zig/src/ops/data.bin', 'zig/src/ops/data.hex', 'zig/src/ops/data.pem'],
                        'fixture_data')

    def test_reference_precedence_over_test_and_native_names_is_preserved(self):
        self.categories(['zig/reference/tests.zig', 'zig/src/net/testing/reference/tests.zig',
                         'zig/src/net/endpoint-reference/testing.zig',
                         'zig/src/aleo/native-crypto/reference/test.zig'],
                        'independent_reference_harness')

    def test_native_helper_and_vendor_precedence_is_preserved(self):
        self.categories(['zig/native/rocks/tests.zig', 'zig/src/aleo/native-crypto/testing.zig',
                         'zig/src/aleo/native-vm/test.zig', 'zig/src/ops/regex-native/tests.zig',
                         'zig/src/net/native-url/tests.zig'], 'native_helper_source')
        self.categories(['zig/native/rocks/vendor/tests.zig',
                         'zig/src/aleo/native-crypto/vendor/testing.zig'], 'native_vendored_source')

    def test_build_operational_and_configuration_precedence_is_preserved(self):
        self.categories(['zig/tools/helper.py', 'zig/deploy/launch.sh',
                         'zig/bench/Dockerfile'], 'build_or_operational_tool_source')
        self.categories(['zig/src/tests/config.json', 'zig/src/tests/config.toml',
                         'zig/src/ops/notes.txt'], 'configuration_or_data')
        self.categories(['zig/tools/config_tests.zig'], 'test_benchmark_or_integration_source')

    def test_nearby_implementation_names_do_not_become_tests(self):
        self.categories(['zig/src/ops/' + name for name in
                         ('contest.zig', 'latest.zig', 'testing_helpers.zig', 'tests_helper.zig',
                          'test.rs', 'tests.rs', 'testing.py', 'test.zig.rs')], 'implementation_source')


if __name__ == '__main__':
    unittest.main()
