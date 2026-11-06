#!/usr/bin/env python3
"""Safety, phase-order and actual dynamic-loader regressions for cache reclamation."""
import ctypes
import json
import os
from pathlib import Path
import platform
import subprocess
import tempfile
import unittest
import cache_reclaim as cache
import build_matrix

class ReclamationTests(unittest.TestCase):
    def test_preserves_actual_loader_dependency_install_id_runtime_assets_and_pins(self):
        with tempfile.TemporaryDirectory(prefix='ziggy-cache-reclaim-test-') as temp:
            root = Path(temp) / 'owned'
            cache.mark(root)
            target = root / 'sdk'
            release = target / 'release'
            deps = release / 'deps'
            build = release / 'build'
            deps.mkdir(parents=True)
            build.mkdir()
            (release / 'incremental').mkdir()
            (release / '.fingerprint').mkdir()
            source = root / 'provider.c'
            source.write_text('int value(void) { return 7; }\n')
            consumer_source = root / 'consumer.c'
            consumer_source.write_text('extern int value(void); int consume(void) { return value(); }\n')
            suffix = '.dylib' if platform.system() == 'Darwin' else '.so'
            provider = deps / ('libfixture_provider' + suffix)
            library = deps / ('libfixture_consumer' + suffix)
            installed = release / library.name
            compiler = ['cc']
            if platform.system() == 'Darwin':
                compiler = ['/usr/bin/clang', '-dynamiclib']
                sdk = Path('/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk')
                if sdk.exists():
                    compiler += ['-isysroot', str(sdk)]
                subprocess.run([*compiler, str(source), '-Wl,-install_name,' + str(provider), '-o', str(provider)], check=True, capture_output=True)
                subprocess.run([*compiler, str(consumer_source), str(provider), '-Wl,-install_name,' + str(library), '-o', str(library)], check=True, capture_output=True)
            else:
                subprocess.run([*compiler, '-shared', '-fPIC', str(source), '-Wl,-soname,' + str(provider), '-o', str(provider)], check=True, capture_output=True)
                subprocess.run([*compiler, '-shared', '-fPIC', str(consumer_source), str(provider), '-Wl,-rpath,' + str(deps), '-o', str(library)], check=True, capture_output=True)
            os.link(library, installed)
            junk = deps / 'compiler-only.o'
            junk.write_bytes(b'x' * 8192)
            (build / 'compiler-object.o').write_bytes(b'not runtime')
            parameters = build / 'public.params'
            parameters.write_bytes(b'public proving parameters')
            license_ = build / 'LICENSE-SDK'
            license_.write_text('public SDK license')
            before = cache.digest(installed)
            result = cache.reclaim(root, target, [installed])
            self.assertFalse(junk.exists())
            self.assertFalse((build / 'compiler-object.o').exists())
            self.assertFalse((release / 'incremental').exists())
            self.assertTrue(provider.exists())
            self.assertTrue(library.exists())
            self.assertTrue(parameters.exists())
            self.assertTrue(license_.exists())
            self.assertEqual(cache.digest(installed), before)
            self.assertEqual(ctypes.CDLL(str(installed)).consume(), 7)
            self.assertTrue(result['all_preserved_hashes_identical'])
            self.assertTrue(result['dylibs_loaded_after'])
            self.assertTrue(all(Path(row['pin']).exists() for row in result['preserved_artifacts']))

    def test_unmarked_or_symlinked_compiler_tree_cannot_delete_foreign_files(self):
        with tempfile.TemporaryDirectory(prefix='ziggy-cache-reclaim-safety-') as temp:
            root = Path(temp) / 'owned'
            foreign = Path(temp) / 'foreign'
            foreign.mkdir()
            sentinel = foreign / 'keep'
            sentinel.write_text('untouched')
            with self.assertRaises(ValueError):
                cache.reclaim(root, foreign)
            cache.mark(root)
            release = root / 'sdk/release'
            release.mkdir(parents=True)
            (release / 'deps').symlink_to(foreign, target_is_directory=True)
            with self.assertRaises(ValueError):
                cache.reclaim(root, release.parent)
            self.assertEqual(sentinel.read_text(), 'untouched')

    def test_rust_and_zig_caches_are_retained_until_their_no_change_pair_finishes(self):
        phases = [{'name': name} for name in ['native-sdk-cold', 'optional-regex-cold', 'optional-starknet-cold', 'optional-aleo-crypto-cold', 'optional-aleo-vm-cold', 'rust-three-agent-cold', 'rust-three-agent-no-change', 'zig-ReleaseSafe-three-agent-cold', 'zig-ReleaseSafe-three-agent-no-change', 'zig-ReleaseFast-three-agent-cold', 'zig-ReleaseFast-three-agent-no-change']]
        bounded = build_matrix.disk_model(phases, True)
        unbounded = build_matrix.disk_model(phases, False)
        self.assertFalse(bounded['phases'][5]['reclaim_after_phase'])
        self.assertTrue(bounded['phases'][6]['reclaim_after_phase'])
        self.assertFalse(bounded['phases'][7]['reclaim_after_phase'])
        self.assertTrue(bounded['phases'][8]['reclaim_after_phase'])
        self.assertGreater(unbounded['estimated_maximum_retained_GiB'], bounded['estimated_maximum_retained_GiB'])
        self.assertGreaterEqual(max(40, bounded['required_estimated_GiB']), 40)

    def test_phase_scheduler_keeps_compiler_files_then_reclaims_after_no_change(self):
        with tempfile.TemporaryDirectory(prefix='ziggy-cache-reclaim-pair-') as temp:
            root = Path(temp) / 'owned'
            cache.mark(root)
            release = root / 'rust-target/release'
            deps = release / 'deps'
            deps.mkdir(parents=True)
            junk = deps / 'cached.rlib'
            junk.write_bytes(b'compiled dependency')
            binary = release / 'validator'
            binary.write_bytes(b'immutable agent fixture')
            phases = [{'name': 'rust-three-agent-cold', 'artifacts': [str(binary)]}, {'name': 'rust-three-agent-no-change', 'artifacts': [str(binary)]}]
            self.assertIsNone(build_matrix.reclaim_phase(root, phases[0], phases, 0))
            self.assertTrue(junk.exists())
            event = build_matrix.reclaim_phase(root, phases[1], phases, 1)
            self.assertTrue(binary.exists())
            self.assertFalse(junk.exists())
            self.assertTrue(Path(event['preservation_plan']).exists())
            self.assertEqual(event['preserved_artifacts'][0]['sha256_chunks'], cache.digest(binary))

    def test_empty_rust_wrapper_environment_overrides_configured_caches_in_real_cargo(self):
        with tempfile.TemporaryDirectory(prefix='ziggy-wrapper-control-') as temp:
            root = Path(temp)
            (root / 'src').mkdir()
            (root / '.cargo').mkdir()
            (root / 'Cargo.toml').write_text('[package]\nname="ziggy-wrapper-control"\nversion="0.1.0"\nedition="2021"\n')
            (root / 'src/lib.rs').write_text('pub fn public_fixture() -> u8 { 7 }\n')
            marker_file = root / 'wrapper-was-called'
            wrapper = root / 'wrapper.py'
            wrapper.write_text('#!/usr/bin/env python3\nimport os,pathlib,sys\npathlib.Path(' + repr(str(marker_file)) + ').write_text("called")\nos.execv(sys.argv[1],sys.argv[1:])\n')
            wrapper.chmod(0o755)
            (root / '.cargo/config.toml').write_text('[build]\nrustc-wrapper=' + json.dumps(str(wrapper)) + '\nrustc-workspace-wrapper=' + json.dumps(str(wrapper)) + '\n')
            environment = dict(os.environ)
            environment.update(RUSTC_WRAPPER='', RUSTC_WORKSPACE_WRAPPER='', CARGO_BUILD_RUSTC_WRAPPER='', CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER='', CCACHE_DISABLE='1', SCCACHE_DISABLE='1')
            result = subprocess.run(['cargo', '+1.98.0', 'check', '--offline', '--target-dir', str(root / 'target')], cwd=root, env=environment, capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(marker_file.exists())

    def test_native_output_keeps_all_seven_archives_licenses_and_manifest(self):
        with tempfile.TemporaryDirectory(prefix='ziggy-cache-reclaim-native-') as temp:
            root = Path(temp) / 'owned'
            cache.mark(root)
            target = root / 'native-target/release/deps'
            target.mkdir(parents=True)
            (target / 'compiler.rlib').write_bytes(b'compiler cache')
            output = root / 'native-sdk'
            output.mkdir()
            files = [output / name for name in ['libziggy_rocks_abi.a', 'librocksdb.a', 'libsnappy.a', 'liblz4.a', 'libzstd.a', 'libz.a', 'libbz2.a', 'manifest.json', 'LICENSE-SDK']]
            for path in files:
                path.write_bytes(path.name.encode())
            hashes = {path: cache.digest(path) for path in files}
            phase = {'name': 'native-sdk-cold', 'artifacts': [str(files[0]), str(files[1])]}
            event = build_matrix.reclaim_phase(root, phase, [phase], 0)
            self.assertFalse(target.exists())
            self.assertEqual(len(event['preserved_artifacts']), len(files))
            for path, checksum in hashes.items():
                self.assertEqual(cache.digest(path), checksum)

    def test_zig_cache_reclamation_preserves_prefix_binaries_and_ignores_global_cache(self):
        with tempfile.TemporaryDirectory(prefix='ziggy-cache-reclaim-zig-') as temp:
            root = Path(temp) / 'owned'
            cache.mark(root)
            local = root / 'zig-local-ReleaseSafe'
            global_ = root / 'zig-global-ReleaseSafe'
            binary = root / 'zig-out-ReleaseSafe/bin/validator'
            binary.parent.mkdir(parents=True)
            binary.write_bytes(b'public fixture artifact')
            for path in [local, global_]:
                path.mkdir()
                (path / 'compiler-output').write_bytes(b'cache')
            foreign = Path(temp) / 'global-cache'
            foreign.mkdir()
            (foreign / 'keep').write_text('user cache')
            result = cache.reclaim_zig(root, [local, global_], [binary])
            self.assertTrue(binary.exists())
            self.assertFalse(local.exists())
            self.assertFalse(global_.exists())
            self.assertTrue((foreign / 'keep').exists())
            self.assertTrue(result['all_preserved_hashes_identical'])
            with self.assertRaises(ValueError):
                cache.reclaim_zig(root, [foreign], [binary])

if __name__ == '__main__':
    unittest.main()
