#!/usr/bin/env python3
"""Restore exact hook-safe public Cargo locks; explicitly build retained crypto/VM."""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import subprocess
from storage_dependency import prepare

BASE = Path(__file__).resolve().parents[1]
def restore():
    prepare()
    for directory, record in json.loads((BASE / "testing/locks.json").read_text()).items():
        if directory not in {"native-crypto", "native-vm"}:
            raise ValueError("Unexpected Aleo lock directory")
        wire = "".join(record["utf8_chunks"]).encode()
        if hashlib.sha256(wire).hexdigest() != "".join(record["sha256_chunks"]):
            raise ValueError("Aleo lock digest mismatch")
        (BASE / directory / "Cargo.lock").write_bytes(wire)
if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--toolchain", default="1.98.0")
    parser.add_argument("--restore-only", action="store_true")
    parser.add_argument("--crypto-only", action="store_true")
    args = parser.parse_args()
    restore()
    if not args.restore_only:
        for directory in (["native-crypto"] if args.crypto_only else ["native-crypto", "native-vm"]):
            subprocess.run(["cargo", f"+{args.toolchain}", "build", "--locked", "--release", "--manifest-path", str(BASE / directory / "Cargo.toml")], check=True)
            suffix = ".dylib" if platform.system() == "Darwin" else ".so"
            name = "libziggy_aleo_crypto" if directory == "native-crypto" else "libziggy_aleo_vm"
            print(BASE / directory / "target/release" / (name + suffix))
