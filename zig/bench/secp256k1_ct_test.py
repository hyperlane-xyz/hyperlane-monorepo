#!/usr/bin/env python3
"""Constant-time shape check for secp256k1 signing primitives on x86_64-v3.

Compiles zig/src/protocol/secp256k1.zig's secret-handling entry points
(comb k*G, field mul/add/sub/neg/select/inversion, mixed addition, safegcd
nonce inversion) to
assembly with $ZIG (skips if unset) and asserts that every conditional
branch in them and their callees is a backward loop branch on a counter
(flags set by cmp/add/sub/inc/dec against an immediate). Any data-dependent
branch the optimiser introduces fails the test.

  ZIG=/path/to/zig python3 zig/bench/secp256k1_ct_test.py
"""
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ENTRY = r'''
const secp = @import("secp");
const Fe = secp.Fe;
export fn ct_mulbase(k: *const [32]u8, out: *secp.Point) void {
    out.* = secp.mulBaseUnchecked(k.*);
}
export fn ct_invert(a: *const Fe, out: *Fe) void {
    out.* = a.invert();
}
export fn ct_field(a: *const Fe, b: *const Fe, bit: u8, out: *[5]Fe) void {
    out[0] = a.mul(b.*);
    out[1] = a.add(b.*);
    out[2] = a.sub(b.*);
    out[3] = a.neg();
    var c = a.*;
    c.cMov(b.*, @truncate(bit));
    out[4] = c;
}
export fn ct_add_mixed(p: *const secp.Point, q: *const secp.Affine, out: *secp.Point) void {
    out.* = p.addMixed(q.*);
}
export fn ct_affine_x(p: *const secp.Point, out: *[32]u8) void {
    out.* = p.x.mul(p.z.invert()).toBytes();
}
export fn ct_scalar_invert(k: *const u256, out: *u256) void {
    out.* = secp.scalar_inverse(k.*);
}
'''
EXPORTS = ["ct_mulbase", "ct_invert", "ct_field", "ct_add_mixed", "ct_affine_x", "ct_scalar_invert"]
LABEL = re.compile(r'^"?([A-Za-z_.$][^:"]*)"?:\s*(#.*)?$')
COUNTER = re.compile(r'^(cmp|add|sub)\s+\w+,\s*-?\d+$|^(inc|dec)\s+\w+$')


def functions(asm):
    funcs, current, labels = {}, None, {}
    for line in asm.splitlines():
        stripped = line.strip()
        match = LABEL.match(line)
        if match and not line.startswith((" ", "\t")):
            name = match.group(1)
            if name.startswith(".L"):
                if current is not None:
                    labels[(current, name)] = len(funcs[current])
            else:
                current = name
                funcs[current] = []
            continue
        if current is not None and stripped and not stripped.startswith((".", "#")):
            funcs[current].append(stripped.split("#")[0].strip())
    return funcs, labels


def violations(funcs, labels, root):
    seen, bad, stack = set(), [], [root]
    while stack:
        name = stack.pop()
        if name in seen or name not in funcs:
            continue
        seen.add(name)
        body = funcs[name]
        for index, instruction in enumerate(body):
            op = instruction.split()[0]
            if op == "call":
                stack.append(instruction.split(None, 1)[1].strip('"'))
            if op.startswith("j") and op != "jmp":
                target = instruction.split()[-1]
                position = labels.get((name, target))
                flags = next((body[i] for i in range(index - 1, max(index - 4, -1), -1)
                              if body[i].split()[0] in ("cmp", "add", "sub", "inc", "dec", "test", "and", "or", "xor")), "")
                backward = position is not None and position <= index
                if not (backward and COUNTER.match(flags)):
                    bad.append(f"{name}: {instruction} (flags: {flags or '?'})")
    return seen, bad


@unittest.skipUnless(os.environ.get("ZIG"), "set ZIG to the pinned Zig 0.15.2 compiler")
class ConstantTimeShape(unittest.TestCase):
    def test_secret_paths_have_only_counter_loop_branches(self):
        for mode in ("ReleaseSafe", "ReleaseFast"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory(prefix="secp-ct-") as scratch:
                entry = Path(scratch) / "entry.zig"
                entry.write_text(ENTRY)
                asm = Path(scratch) / "out.s"
                module = ["-O", mode, "-target", "x86_64-linux", "-mcpu", "x86_64_v3"]
                subprocess.run([os.environ["ZIG"], "build-obj", *module, "--dep", "secp", f"-Mroot={entry}",
                                *module, f"-Msecp={ROOT / 'zig/src/protocol/secp256k1.zig'}",
                                f"-femit-asm={asm}", "-fno-emit-bin", "--cache-dir", str(Path(scratch) / "cache")],
                               check=True, capture_output=True)
                funcs, labels = functions(asm.read_text())
                for export in EXPORTS:
                    self.assertIn(export, funcs)
                    reached, bad = violations(funcs, labels, export)
                    self.assertEqual(bad, [], f"{mode} {export} reached {sorted(reached)}")


if __name__ == "__main__":
    unittest.main()
