#!/usr/bin/env python3
"""Restore pinned dependency locks and build the regex ABI or Rust test oracle."""
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

def restore(oracle):
    entry = json.loads((BASE / ('tools/denylist-lock.json' if oracle else 'tools/regex-lock.json')).read_text())
    wire = ''.join(entry['utf8_chunks']).encode()
    if hashlib.sha256(wire).hexdigest() != ''.join(entry['sha256_chunks']):
        raise ValueError('Dependency lock digest mismatch')
    project = BASE / ('testing/reference' if oracle else 'regex-native')
    (project / 'Cargo.lock').write_bytes(wire)
    return project

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cpu-recipe-output', type=Path)
    parser.add_argument('--toolchain', default='1.98.0')
    parser.add_argument('--restore-only', action='store_true')
    parser.add_argument('--denylist-reference', action='store_true', help='Build the unchanged Rust runtime-denylist parser oracle')
    args = parser.parse_args()
    cpu_source_before = Path(cpu.__file__).read_bytes()
    if args.cpu_recipe_output and (platform.system() != "Linux" or platform.machine() != "x86_64"):
        raise ValueError("Portable retained CPU recipe requires Linux x86_64")
    project = restore(args.denylist_reference)
    if not args.restore_only:
        root = BASE.parents[2]
        command = ['cargo', f'+{args.toolchain}', 'build', '--locked', '--release', '--manifest-path', str(project / 'Cargo.toml')]
        if args.denylist_reference:
            command += ['--target-dir', str(root / 'rust/main/target')]
        subprocess.run(['python3', 'zig/tools/fixture_pack.py', 'restore-locks'], check=True, cwd=root)
        environment = cpu.portable_environment(os.environ, tokio_unstable=True) if args.cpu_recipe_output else dict(os.environ)
        recipe = cpu.recipe('rust', command, environment, Path(__file__)) if args.cpu_recipe_output else None
        completed = subprocess.run(command, check=True, cwd=root / 'rust/main', env=environment)
        if recipe is not None:
            if Path(cpu.__file__).read_bytes() != cpu_source_before: raise ValueError("CPU compiler procedure changed")
            args.cpu_recipe_output.parent.mkdir(parents=True, exist_ok=True)
            with args.cpu_recipe_output.open('x') as stream: json.dump(cpu.finish_recipe(recipe, {'actual_parent_wait': True, 'exit_code': completed.returncode, 'error': None}), stream)
        name = 'libziggy_regex.dylib' if platform.system() == 'Darwin' else 'libziggy_regex.so'
        print(root / 'rust/main/target/release/ziggy-denylist-reference' if args.denylist_reference else project / 'target/release' / name)
