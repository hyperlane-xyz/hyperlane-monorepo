#!/usr/bin/env python3
"""Regenerate public Tron fixtures using the pinned production-type oracle."""
import argparse
import json
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("--check", action="store_true")
parser.add_argument("--toolchain", default="1.98.0")
args = parser.parse_args()
root = Path(__file__).resolve().parents[4]
subprocess.run(["python3", str(root / "zig/tools/fixture_pack.py"), "restore-locks"], cwd=root, check=True)
result = subprocess.check_output([
    "cargo", f"+{args.toolchain}", "run", "--locked", "--release", "--manifest-path",
    str(root / "zig/reference/tron/Cargo.toml"),
], cwd=root, text=True)
files = {"transactions.jsonl": [], "transactions-agent.jsonl": [], "http.jsonl": []}
for line in result.splitlines():
    item = json.loads(line)
    name = {"transaction": "transactions.jsonl", "transaction_agent": "transactions-agent.jsonl"}.get(item["kind"], "http.jsonl")
    files[name].append(line)
assert [len(files[name]) for name in files] == [16, 16, 11]
for name, lines in files.items():
    path = root / "zig/src/tron/fixtures" / name
    content = "\n".join(lines) + "\n"
    if args.check:
        if path.read_text() != content:
            raise SystemExit(f"fixture mismatch: {name}")
    else:
        path.write_text(content)
print("Tron fixtures verified" if args.check else "Tron fixtures regenerated")
