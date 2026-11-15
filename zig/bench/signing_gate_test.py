#!/usr/bin/env python3
"""Unverified (no fault self-check) signing is unreachable outside benchmark roots.

protocol.signature.benchmark.signWithoutFaultCheck exists only when the
executable root declares `kernel_bench_unverified_signing`. This compiles:
  1. a production-like root (no declaration) that references it: must fail;
  2. a production-like root that signs through SigningKey: must build, and
     its object must not contain a signWithoutFaultCheck symbol;
  3. a benchmark-like root with the declaration: must build.
Skips unless $ZIG is set:  ZIG=/path/to/zig python3 zig/bench/signing_gate_test.py
"""
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
AGENTS = ROOT / "zig/src/root.zig"

PRODUCTION_REACH = r'''
const signature = @import("agents").protocol.signature;
export fn bad(out: *[65]u8) void {
    out.* = signature.benchmark.signWithoutFaultCheck(.{0x11} ** 32, .{0x22} ** 32, null) catch unreachable;
}
'''
PRODUCTION_SIGN = r'''
const signature = @import("agents").protocol.signature;
export fn good(out: *[65]u8) void {
    var key = signature.SigningKey.init(.{0x11} ** 32) catch unreachable;
    defer key.deinit();
    out.* = key.sign(.{0x22} ** 32, null) catch unreachable;
}
'''
BENCH_REACH = r'''
const signature = @import("agents").protocol.signature;
pub const kernel_bench_unverified_signing = true;
export fn attribution(out: *[65]u8) void {
    out.* = signature.benchmark.signWithoutFaultCheck(.{0x11} ** 32, .{0x22} ** 32, null) catch unreachable;
}
'''


def build(scratch, source, emit):
    root = Path(scratch) / "root.zig"
    root.write_text(source)
    module = ["-O", "ReleaseSafe"]
    return subprocess.run([os.environ["ZIG"], "build-obj", *module, "--dep", "agents", f"-Mroot={root}",
                           *module, f"-Magents={AGENTS}", "-lc", emit, "--cache-dir", str(Path(scratch) / "cache")],
                          capture_output=True, text=True)


@unittest.skipUnless(os.environ.get("ZIG"), "set ZIG to the pinned Zig 0.15.2 compiler")
class UnverifiedSigningGate(unittest.TestCase):
    def test_production_root_cannot_reference_unverified_signing(self):
        with tempfile.TemporaryDirectory(prefix="sign-gate-") as scratch:
            result = build(scratch, PRODUCTION_REACH, f"-femit-bin={Path(scratch) / 'out.o'}")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("signWithoutFaultCheck", result.stderr)

    def test_production_signing_object_has_no_unverified_entry_point(self):
        with tempfile.TemporaryDirectory(prefix="sign-gate-") as scratch:
            asm = Path(scratch) / "out.s"
            result = build(scratch, PRODUCTION_SIGN, f"-femit-asm={asm}")
            self.assertEqual(result.returncode, 0, result.stderr)
            text = asm.read_text()
            self.assertIn("verifyBeforeRelease", text)
            self.assertNotIn("signWithoutFaultCheck", text)

    def test_benchmark_root_opts_in(self):
        with tempfile.TemporaryDirectory(prefix="sign-gate-") as scratch:
            asm = Path(scratch) / "out.s"
            result = build(scratch, BENCH_REACH, f"-femit-asm={asm}")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("signWithoutFaultCheck", asm.read_text())


if __name__ == "__main__":
    unittest.main()
