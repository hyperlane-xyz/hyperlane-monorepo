#!/usr/bin/env python3
"""Regenerate/check public fixtures with actual pinned SDK/production ABI types."""
import argparse
from collections import Counter
import json
from pathlib import Path
import subprocess
from locked import restore

parser = argparse.ArgumentParser()
parser.add_argument("--check", action="store_true")
parser.add_argument("--toolchain", default="1.98.0")
args = parser.parse_args()
restore()
root = Path(__file__).resolve().parents[4]
wire = subprocess.check_output([
    "cargo", f"+{args.toolchain}", "run", "--locked", "--release", "--manifest-path",
    str(root / "zig/src/starknet/testing/reference/Cargo.toml"),
], cwd=root, text=True)
records = [json.loads(line) for line in wire.splitlines()]
kinds = Counter(record["kind"] for record in records)
assert len(records) == 34 and kinds["message"] == 13 and kinds["invoke"] == 14
path = root / "zig/src/starknet/fixtures/sdk.jsonl"
if args.check:
    if path.read_text() != wire:
        raise SystemExit("Starknet fixture mismatch")
else:
    path.write_text(wire)
print("Starknet fixtures verified" if args.check else "Starknet fixtures regenerated")
