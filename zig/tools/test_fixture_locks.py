"""Clean-checkout lock closure tests. No Cargo, compiler or network calls."""
import contextlib
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import tempfile
import tomllib
import unittest
from unittest.mock import patch

import fixture_pack

ROOT = Path(__file__).resolve().parents[2]


def custom_pins():
    result = {}
    for base in ("zig/src/starknet", "zig/src/aleo"):
        artifact = ROOT / base / "testing/locks.json"
        for directory, record in json.loads(artifact.read_text()).items():
            result[str(Path(base) / directory / "Cargo.lock")] = (artifact, record)
    for logical, artifact in (
        ("zig/native/rocks/Cargo.lock", "zig/native/rocks/lock.json"),
        ("zig/src/net/testing/endpoint-reference/Cargo.lock", "zig/src/net/testing/endpoint-reference/lock.json"),
        ("zig/src/ops/regex-native/Cargo.lock", "zig/src/ops/tools/regex-lock.json"),
        ("zig/src/ops/testing/reference/Cargo.lock", "zig/src/ops/tools/denylist-lock.json"),
    ):
        source = ROOT / artifact
        result[logical] = (source, json.loads(source.read_text()))
    return result


def canonical_pins():
    output = {}
    for record in json.loads(fixture_pack.LOCK_MANIFEST.read_text())["files"]:
        wire = gzip.decompress((ROOT / record["path"]).read_bytes())
        if len(wire) != record["bytes"] or fixture_pack.checksum(wire) != record["sha256_chunks"]:
            raise ValueError("Canonical lock digest mismatch")
        output[record["restore"]] = wire
    return output


class FixtureLocks(unittest.TestCase):
    def test_all_canonical_locks_restore_with_no_raw_lock_files(self):
        document = json.loads(fixture_pack.LOCK_MANIFEST.read_text())
        with tempfile.TemporaryDirectory(prefix="ziggy-lock-restore-") as folder:
            root = Path(folder).resolve()
            manifest = root / "zig/tools/fixture-locks.json"
            manifest.parent.mkdir(parents=True)
            manifest.write_text(json.dumps(document))
            for record in document["files"]:
                target = root / record["path"]
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / record["path"], target)
                self.assertFalse((root / record["restore"]).exists())
            with patch.object(fixture_pack, "ROOT", root), patch.object(fixture_pack, "LOCK_MANIFEST", manifest), contextlib.redirect_stdout(io.StringIO()):
                fixture_pack.restore_locks()
            for record in document["files"]:
                wire = (root / record["restore"]).read_bytes()
                self.assertEqual(wire, gzip.decompress((root / record["path"]).read_bytes()))
                self.assertTrue(tomllib.loads(wire.decode())["package"])

    def test_every_standalone_manifest_has_a_reviewable_exact_lock(self):
        pins = canonical_pins()
        for logical, (_, record) in custom_pins().items():
            wire = "".join(record["utf8_chunks"]).encode()
            self.assertEqual(hashlib.sha256(wire).hexdigest(), "".join(record["sha256_chunks"]))
            if logical in pins:
                self.assertEqual(pins[logical], wire)
            pins[logical] = wire
        manifests = []
        for directory, children, files in os.walk(ROOT / "zig"):
            children[:] = [name for name in children if name not in {"target", ".cache", ".zig-cache", "zig-out", "__pycache__"}]
            if "Cargo.toml" in files:
                manifests.append(Path(directory) / "Cargo.toml")
        standalone = {}
        for manifest in manifests:
            data = tomllib.loads(manifest.read_text())
            logical = str(manifest.with_name("Cargo.lock").relative_to(ROOT))
            if "workspace" not in data and logical not in pins:
                continue
            self.assertIn(logical, pins, f"Unpinned standalone helper: {manifest}")
            packages = tomllib.loads(pins[logical].decode())["package"]
            self.assertTrue(any(p["name"] == data["package"]["name"] and p["version"] == data["package"]["version"] for p in packages), str(manifest))
            for package in packages:
                source = package.get("source", "")
                if source.startswith("git+"):
                    revision = source.rsplit("#", 1)[-1]
                    self.assertEqual(len(revision), 40)
                    self.assertTrue(all(c in "0123456789abcdef" for c in revision))
                if source.startswith("registry+"):
                    self.assertEqual(len(package["checksum"]), 64)
            standalone[manifest.parent] = packages
        # Vendored path dependencies inherit their actual parent workspace pin;
        # they must not accidentally be counted as independent Cargo projects.
        for manifest in manifests:
            data = tomllib.loads(manifest.read_text())
            if manifest.parent in standalone:
                continue
            owner = next((parent for parent in manifest.parents if parent in standalone), None)
            self.assertIsNotNone(owner, f"Unclassified Cargo manifest: {manifest}")
            self.assertTrue(any(p["name"] == data["package"]["name"] and p["version"] == data["package"]["version"] for p in standalone[owner]))

    def test_recovered_lander_external_identities_match_production(self):
        production = tomllib.loads((ROOT / "rust/main/Cargo.lock").read_text())["package"]
        identity = lambda p: (p["name"], p["version"], p.get("source"), p.get("checksum"))
        known = {identity(package) for package in production}
        wire = canonical_pins()["zig/src/lander/testing/reference/Cargo.lock"]
        for package in tomllib.loads(wire.decode())["package"]:
            if "source" in package:
                self.assertIn(identity(package), known)
        manifest = tomllib.loads((ROOT / "zig/src/lander/testing/reference/Cargo.toml").read_text())
        self.assertEqual(manifest["dependencies"]["ethers-core"]["rev"], "66bd6198d8952adfd9395e3f3727682443a031c7")
        for name in ("primitive-types", "rlp"):
            other = tomllib.loads((ROOT / "zig/reference/evm/Cargo.toml").read_text())
            self.assertEqual(manifest["patch"]["crates-io"][name], other["patch"]["crates-io"][name])

    def test_tampered_packed_lock_cannot_restore(self):
        record = json.loads(fixture_pack.LOCK_MANIFEST.read_text())["files"][0]
        with tempfile.TemporaryDirectory(prefix="ziggy-lock-tamper-") as folder:
            root = Path(folder).resolve()
            source = root / record["path"]
            source.parent.mkdir(parents=True)
            source.write_bytes(gzip.compress(b"changed", mtime=0))
            manifest = root / "locks.json"
            manifest.write_text(json.dumps({"schema": 1, "files": [record]}))
            with patch.object(fixture_pack, "ROOT", root), patch.object(fixture_pack, "LOCK_MANIFEST", manifest):
                with self.assertRaisesRegex(ValueError, "digest mismatch"):
                    fixture_pack.restore_locks()
            self.assertFalse((root / record["restore"]).exists())

    def test_lander_source_paths_and_golden_output_are_checkout_independent(self):
        helper = ROOT / "zig/src/lander/testing/reference"
        source = (helper / "src/main.rs").read_text()
        build = (helper / "build.rs").read_text()
        self.assertNotIn("/Users/", source)
        self.assertNotIn("/Users/", build)
        self.assertEqual(source.count('include!(concat!(env!("OUT_DIR")'), 4)
        self.assertIn("ZIGGY_LANDER_FIXTURE_OUTPUT", source)
        self.assertNotIn("read_to_string", build)
        self.assertIn("cargo:rerun-if-changed", build)
        for relative in (
            "rust/main/lander/src/payload/types.rs",
            "rust/main/lander/src/transaction/types.rs",
            "rust/main/lander/src/adapter/chains/ethereum/precursor.rs",
            "rust/main/lander/src/adapter/chains/ethereum/adapter/gas_price/escalator.rs",
        ):
            self.assertIn(relative, build)
            self.assertTrue((helper.parents[4] / relative).is_file())


if __name__ == "__main__":
    unittest.main()
