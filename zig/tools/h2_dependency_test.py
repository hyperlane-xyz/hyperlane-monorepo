"""Pure archive/boundary controls. No downloads, interpreter builds or nodes."""
import io
import pathlib
import tempfile
import unittest
from unittest import mock
import zipfile

import h2_dependency as setup


def archive(mutate=None):
    members = {"hpack/" + name: b"public fixture" for name in setup.PACKAGE_FILES}
    members.update({"hpack-4.2.0.dist-info/" + name: b"public fixture" for name in setup.METADATA_FILES})
    if mutate:
        mutate(members)
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as wheel:
        for name, raw in members.items():
            wheel.writestr(name, raw)
    return out.getvalue()


class Dependency(unittest.TestCase):
    def test_exact_file_closure_and_extraction_without_execution(self):
        with mock.patch("subprocess.Popen", side_effect=AssertionError("no subprocess")):
            members = setup.wheel_members(archive())
        self.assertEqual(len(members), 14)
        self.assertIn("hpack-4.2.0.dist-info/licenses/LICENSE", members)

    def test_missing_extra_traversal_hooks_and_size_fail(self):
        mutations = [lambda m: m.pop("hpack/__init__.py"), lambda m: m.update({"../outside": b"x"}), lambda m: m.update({"hpack/extra.py": b"x"}), lambda m: m.update({"hook.pth": b"import evil"}), lambda m: m.update({"hpack/huffman_table.py": b"x" * (256 * 1024 + 1)})]
        for mutate in mutations:
            with self.assertRaises(ValueError): setup.wheel_members(archive(mutate))

    def test_bad_wheel_never_creates_destination_or_spawns(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch("subprocess.Popen", side_effect=AssertionError("no subprocess")):
            destination = pathlib.Path(directory) / "new"
            with self.assertRaisesRegex(ValueError, "checksum"):
                setup.prepare(destination, archive())
            self.assertFalse(destination.exists())

    def test_existing_or_symlink_destinations_and_capacity_refuse_before_spawn(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(setup, "checked_wheel", return_value={}), mock.patch("subprocess.Popen", side_effect=AssertionError("no subprocess")):
            root = pathlib.Path(directory)
            with self.assertRaisesRegex(ValueError, "must not exist"): setup.prepare(root, b"")
            link = root / "symlink"; link.symlink_to(root / "absent")
            with self.assertRaisesRegex(ValueError, "must not exist"): setup.prepare(link, b"")
            with mock.patch("shutil.disk_usage", return_value=type("Disk", (), {"free": 0})()):
                with self.assertRaisesRegex(ValueError, "6GiB"): setup.prepare(root / "new", b"")
            self.assertFalse((root / "new").exists())


if __name__ == "__main__":
    unittest.main()
