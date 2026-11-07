"""Actual pinned source-only dependency loader controls. No node/SDK/build."""
import copy
import hashlib
import json
import os
import pathlib
import sys
import tempfile
import types
import unittest
from unittest import mock

import multivm_evidence as evidence
from multivm_h2 import VerifiedSourceLoader


class Loader(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = pathlib.Path(os.environ["ZIGGY_H2_DEPENDENCY_DESCRIPTOR"])
        raw = path.read_bytes()
        cls.descriptor = json.loads(raw)
        cls.artifact = {"path": str(path), "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}
        cls.manifest = {"scenario": "cosmosnative", "verifier": {"python": cls.descriptor["interpreter"]}}

    def check(self, descriptor):
        with tempfile.TemporaryDirectory(prefix="ziggy-hpack-loader-pure-") as directory:
            path = pathlib.Path(directory) / "descriptor.json"
            raw = json.dumps(descriptor).encode()
            path.write_bytes(raw)
            approval = {"python_dependencies": {"hpack": {"path": str(path), "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}}}
            evidence.verify_python_dependencies(self.manifest, approval)

    def test_01_ambient_preloaded_hpack_rejected_before_import(self):
        self.assertNotIn("hpack", sys.modules)
        with mock.patch.dict(sys.modules, {"hpack": types.ModuleType("hpack")}):
            with self.assertRaisesRegex(ValueError, "ambient/unpinned"):
                self.check(self.descriptor)
        self.assertNotIn("hpack", sys.modules)

    def test_02_all_actual_dependency_modules_load_from_pinned_source_without_pyc(self):
        self.check(self.descriptor)
        import hpack
        self.assertEqual(hpack.__version__, "4.2.0")
        self.assertTrue(sys.flags.no_user_site)
        for name, module in list(sys.modules.items()):
            if name == "hpack" or name.startswith("hpack."):
                self.assertIsInstance(module.__loader__, VerifiedSourceLoader)
                self.assertEqual(pathlib.Path(module.__file__).suffix, ".py")
                self.assertTrue(pathlib.Path(module.__file__).is_relative_to(self.descriptor["package_root"]))
        encoder, decoder = hpack.Encoder(), hpack.Decoder()
        headers = [(":status", "200"), ("content-type", "application/grpc")]
        self.assertEqual(decoder.decode(encoder.encode(headers)), headers)
        # Repeated approval uses the exact same verified in-memory modules.
        self.check(self.descriptor)

    def test_03_version_wheel_interpreter_file_closure_and_environment_fail_closed(self):
        mutations = [
            lambda d: d.__setitem__("version", "4.1.0"),
            lambda d: d["wheel"].__setitem__("sha256", "0" * 64),
            lambda d: d["interpreter"].__setitem__("path", "/wrong/python"),
            lambda d: d["files"].pop(),
            lambda d: d["files"][0].__setitem__("sha256", "0" * 64),
            lambda d: d.__setitem__("package_root", "/outside/hpack"),
            lambda d: d.__setitem__("copied_interpreter", False),
        ]
        for mutation in mutations:
            descriptor = copy.deepcopy(self.descriptor)
            mutation(descriptor)
            with self.subTest(mutation=mutation), self.assertRaises((ValueError, FileNotFoundError)):
                self.check(descriptor)
        for key in ("PYTHONPATH", "PYTHONHOME"):
            with mock.patch.dict(os.environ, {key: "/ambient"}), self.assertRaisesRegex(ValueError, "ambient Python"):
                self.check(self.descriptor)


if __name__ == "__main__":
    unittest.main()
