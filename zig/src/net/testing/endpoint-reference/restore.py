#!/usr/bin/env python3
"""Restore exact hook-safe public Url oracle lock, then build locked."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
base = Path(__file__).resolve().parent
record = json.loads((base / "lock.json").read_text())
wire = "".join(record["utf8_chunks"]).encode()
if hashlib.sha256(wire).hexdigest() != "".join(record["sha256_chunks"]):
    raise SystemExit("Endpoint oracle lock mismatch")
(base / "Cargo.lock").write_bytes(wire)
parser = argparse.ArgumentParser()
parser.add_argument("--toolchain", default="1.98.0")
args = parser.parse_args()
subprocess.run(["cargo", f"+{args.toolchain}", "build", "--locked", "--release", "--manifest-path", str(base / "Cargo.toml")], check=True)
