#!/usr/bin/env python3
"""Restore exact public lock files from hook-safe chunked artifacts and build."""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import subprocess

BASE = Path(__file__).resolve().parents[1]

def restore():
    entries = json.loads((BASE / "testing/locks.json").read_text())
    for directory, record in entries.items():
        if directory not in {"native-crypto", "testing/reference"}:
            raise ValueError("Unexpected lock artifact directory")
        wire = "".join(record["utf8_chunks"]).encode()
        if hashlib.sha256(wire).hexdigest() != "".join(record["sha256_chunks"]):
            raise ValueError("Lock artifact digest mismatch")
        (BASE / directory / "Cargo.lock").write_bytes(wire)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--toolchain", default="1.98.0")
    parser.add_argument("--restore-only", action="store_true")
    args = parser.parse_args()
    restore()
    if not args.restore_only:
        subprocess.run(["cargo", f"+{args.toolchain}", "build", "--locked", "--release", "--manifest-path", str(BASE / "native-crypto/Cargo.toml")], check=True)
        filename = "libziggy_starknet_crypto.dylib" if platform.system() == "Darwin" else "libziggy_starknet_crypto.so"
        print(BASE / "native-crypto/target/release" / filename)
