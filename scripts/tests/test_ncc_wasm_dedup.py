"""Exercise the actual Docker asset-deduplication shell against local fixtures."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

DOCKERFILE = Path(__file__).resolve().parents[2] / "typescript/Dockerfile"
SERVICES = (
    "rebalancer", "warp-monitor", "ccip-server", "keyfunder", "relayer",
    "fee-quoting", "scraper-proxy",
)


def deduplicate(services_dir, dockerfile=DOCKERFILE):
    source = dockerfile.read_text()
    # Run the production loop itself, excluding bundle copying and image setup.
    script = source.split("    CANONICAL=rebalancer &&", 1)[1]
    script = script.split("# Production stage", 1)[0].strip()
    script = 'SERVICES_DIR="$1"\nCANONICAL=rebalancer &&' + script
    subprocess.run(
        ["sh", "-c", script.replace("\\\n", "\n"), "dedup", str(services_dir)],
        check=True,
    )


class WasmDedupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for service in SERVICES:
            (self.root / service).mkdir()

    def write(self, service, name, contents):
        path = self.root / service / name
        path.write_bytes(contents)
        return path

    def test_missing_wasm_globs(self):
        self.write("keyfunder", "index.js", b"entry")
        deduplicate(self.root)
        self.assertEqual((self.root / "keyfunder/index.js").read_bytes(), b"entry")
        self.write("rebalancer", "only.wasm", b"canonical only")
        deduplicate(self.root)
        self.assertFalse((self.root / "keyfunder/only.wasm").exists())

    def test_different_bytes_remain_regular_files(self):
        self.write("rebalancer", "module.wasm", b"canonical")
        target = self.write("keyfunder", "module1.wasm", b"different")
        deduplicate(self.root)
        self.assertFalse(target.is_symlink())
        self.assertEqual(target.read_bytes(), b"different")

    def test_same_filename_and_already_deduplicated(self):
        self.write("rebalancer", "module.wasm", b"same")
        target = self.write("keyfunder", "module.wasm", b"same")
        for _ in range(2):
            deduplicate(self.root)
            self.assertTrue(target.is_symlink())
            self.assertEqual(os.readlink(target), "../rebalancer/module.wasm")
            self.assertEqual(target.read_bytes(), b"same")

    def test_failed_renamed_symlink_aborts_packaging(self):
        self.write("rebalancer", "module.wasm", b"same")
        self.write("keyfunder", "module1.wasm", b"same")
        tools = self.root / "tools"
        tools.mkdir()
        failing_ln = tools / "ln"
        failing_ln.write_text("#!/bin/sh\nexit 17\n")
        failing_ln.chmod(0o755)
        with patch.dict(os.environ, {"PATH": str(tools) + os.pathsep + os.environ["PATH"]}):
            with self.assertRaises(subprocess.CalledProcessError) as failure:
                deduplicate(self.root)
        self.assertEqual(failure.exception.returncode, 1)

    def test_renamed_twins_preserve_names_and_bytes_without_cross_name_js_links(self):
        self.write("rebalancer", "aleo.wasm", b"first")
        self.write("rebalancer", "aleo1.wasm", b"second")
        first = self.write("keyfunder", "aleo.wasm", b"second")
        second = self.write("keyfunder", "aleo1.wasm", b"first")
        self.write("rebalancer", "worker.js", b"worker")
        worker = self.write("keyfunder", "worker1.js", b"worker")
        self.write("rebalancer", "addon.node", b"addon")
        addon = self.write("keyfunder", "addon1.node", b"addon")
        for _ in range(2):
            deduplicate(self.root)
            self.assertEqual(os.readlink(first), "../rebalancer/aleo1.wasm")
            self.assertEqual(os.readlink(second), "../rebalancer/aleo.wasm")
            self.assertEqual(first.read_bytes(), b"second")
            self.assertEqual(second.read_bytes(), b"first")
            self.assertFalse(worker.is_symlink())
            self.assertFalse(addon.is_symlink())


if __name__ == "__main__":
    unittest.main()
