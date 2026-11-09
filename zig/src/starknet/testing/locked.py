#!/usr/bin/env python3
"""Restore exact public lock files from hook-safe chunked artifacts and build."""
import argparse
import importlib.util
import os
import hashlib
import json
from pathlib import Path
import platform
import subprocess

_CPU_SPEC = importlib.util.spec_from_file_location("retained_cpu", Path(__file__).resolve().parents[3] / "tools/build_cpu.py")
cpu = importlib.util.module_from_spec(_CPU_SPEC)
_CPU_SPEC.loader.exec_module(cpu)

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
    parser.add_argument("--cpu-recipe-output", type=Path)
    parser.add_argument("--toolchain", default="1.98.0")
    parser.add_argument("--restore-only", action="store_true")
    args = parser.parse_args()
    cpu_source_before = Path(cpu.__file__).read_bytes()
    if args.cpu_recipe_output and (platform.system() != "Linux" or platform.machine() != "x86_64"):
        raise ValueError("Portable retained CPU recipe requires Linux x86_64")
    restore()
    if not args.restore_only:
        command = ["cargo", f"+{args.toolchain}", "build", "--locked", "--release", "--manifest-path", str(BASE / "native-crypto/Cargo.toml")]
        environment = cpu.portable_environment(os.environ) if args.cpu_recipe_output else dict(os.environ)
        recipe = cpu.recipe("rust", command, environment, Path(__file__)) if args.cpu_recipe_output else None
        completed = subprocess.run(command, check=True, env=environment)
        if recipe is not None:
            if Path(cpu.__file__).read_bytes() != cpu_source_before: raise ValueError("CPU compiler procedure changed")
            args.cpu_recipe_output.parent.mkdir(parents=True, exist_ok=True)
            with args.cpu_recipe_output.open("x") as stream: json.dump(cpu.finish_recipe(recipe, {"actual_parent_wait": True, "exit_code": completed.returncode, "error": None}), stream)
        filename = "libziggy_starknet_crypto.dylib" if platform.system() == "Darwin" else "libziggy_starknet_crypto.so"
        print(BASE / "native-crypto/target/release" / filename)
