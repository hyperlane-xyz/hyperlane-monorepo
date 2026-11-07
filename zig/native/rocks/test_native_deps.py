#!/usr/bin/env python3
"""Pure bootstrap integrity/selection tests; no native library or network needed."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("native_deps", Path(__file__).resolve().parents[2] / "tools/native_deps.py")
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)

class Integrity(unittest.TestCase):
    def test_lock_and_production_pins(self):
        pins, _ = helper.restore_lock()
        self.assertEqual(pins['librocksdb-sys@0.17.3+10.4.2']['version'], '0.17.3+10.4.2')
        self.assertIn('shlex@1.3.0', pins)
        self.assertIn('shlex@2.0.1', pins)
        self.assertNotIn('default', helper.FEATURES)  # rocksdb0.24 disables sys defaults

    def test_corrupt_chunks_and_schema_are_rejected(self):
        original = json.loads((helper.PROJECT / 'lock.json').read_text())
        for corrupt in [dict(original, utf8_chunks=['altered']), dict(original, schema=999)]:
            with tempfile.TemporaryDirectory() as temporary:
                project = Path(temporary)
                (project / 'lock.json').write_text(json.dumps(corrupt))
                with patch.object(helper, 'PROJECT', project):
                    with self.assertRaises(ValueError):
                        helper.restore_lock()
                self.assertFalse((project / 'Cargo.lock').exists())

    def test_archive_selection_rejects_symlink_and_invalid_magic(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            file = root / 'librocksdb.a'
            file.write_bytes(b'wrong')
            with self.assertRaises(ValueError): helper.find_archive(root, file.name)
            file.unlink()
            actual = root / 'actual.a'
            actual.write_bytes(b'!<arch>\n')
            file.symlink_to(actual)
            with self.assertRaises(ValueError): helper.find_archive(root, file.name)
            file.unlink(); file.write_bytes(b'!<arch>\n')
            self.assertEqual(helper.find_archive(root, file.name), file)

    def test_native_platform_runtime_flags(self):
        with patch.object(helper.platform, 'system', return_value='Linux'):
            flags, libraries = helper.native_flags(None)
            self.assertEqual(flags, [])
            self.assertIn('-lstdc++', libraries)
            self.assertNotIn('-lc++', libraries)
        with patch.object(helper.platform, 'system', return_value='Darwin'):
            flags, libraries = helper.native_flags(Path('/sdk with spaces'))
            self.assertEqual(flags, ['-isysroot', '/sdk with spaces'])
            self.assertIn('-lc++', libraries)

    def test_system_engine_and_flag_overrides_are_removed(self):
        with patch.dict(helper.os.environ, {'ROCKSDB_LIB_DIR':'/wrong', 'ZSTD_SYS_USE_PKG_CONFIG':'1', 'CXXFLAGS':'-DWRONG', 'RUSTFLAGS':'-Ctarget-cpu=native', 'CARGO_PROFILE_RELEASE_OPT_LEVEL':'0'}):
            env = helper.build_environment(None)
        for name in ['ROCKSDB_LIB_DIR','ZSTD_SYS_USE_PKG_CONFIG','CXXFLAGS','RUSTFLAGS','CARGO_PROFILE_RELEASE_OPT_LEVEL']:
            self.assertNotIn(name, env)
        self.assertEqual(env['ROCKSDB_COMPILE'], '1')
        self.assertEqual(env['SOURCE_DATE_EPOCH'], '0')
        self.assertEqual(env['ZERO_AR_DATE'], '1')

    def test_import_requires_matching_cargo_provenance(self):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaises(ValueError): helper.import_target(Path(temporary), {})

    def test_build_timeout_terminates_compiler_process_group(self):
        with tempfile.TemporaryDirectory() as temporary:
            args = SimpleNamespace(toolchain='1.98.0', target_dir=Path(temporary)/'target', jobs=1, offline=True, sdk_root=None, macos_deployment_target='11.0', build_timeout=1)
            timeout = helper.subprocess.TimeoutExpired(['cargo'], 1)
            with patch.object(helper.subprocess, 'Popen') as start, patch.object(helper.os, 'killpg') as kill:
                process = start.return_value
                process.pid = 123456
                process.wait.side_effect = [timeout, 0]
                with self.assertRaises(helper.subprocess.TimeoutExpired):
                    helper.build_native(args,Path(temporary))
                kill.assert_called_once_with(123456, helper.signal.SIGTERM)
                self.assertTrue(start.call_args.kwargs['start_new_session'])

    def test_atomic_copy_publishes_readable_nonexecutable_archives_with_restrictive_umask(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, dest = root / 'source.a', root / 'published.a'
            payload = b'!<arch>\n' + bytes(range(256))
            source.write_bytes(payload)
            source.chmod(0o600)
            previous_umask = helper.os.umask(0o077)
            try:
                helper.atomic_copy(source, dest)
            finally:
                helper.os.umask(previous_umask)
            self.assertEqual(dest.read_bytes(), payload)
            self.assertEqual(dest.stat().st_mode & 0o777, 0o644)
            self.assertEqual(source.stat().st_mode & 0o777, 0o600)
            self.assertEqual(helper.digest(source), helper.digest(dest))
            self.assertFalse(list(root.glob('.native-copy-*')))

    def test_atomic_copy_preserves_existing_on_success(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, dest = root/'source', root/'dest'
            source.write_bytes(b'new');dest.write_bytes(b'old')
            helper.atomic_copy(source,dest)
            self.assertEqual(dest.read_bytes(),b'new')
            self.assertEqual(helper.digest(dest),hashlib.sha256(b'new').hexdigest())
            self.assertFalse(list(root.glob('.native-copy-*')))

if __name__ == '__main__':
    unittest.main()
