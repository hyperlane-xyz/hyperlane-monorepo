#!/usr/bin/env python3
"""Restore pinned dependency locks and build the regex ABI or Rust test oracle."""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import subprocess

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
    parser.add_argument('--toolchain', default='1.98.0')
    parser.add_argument('--restore-only', action='store_true')
    parser.add_argument('--denylist-reference', action='store_true', help='Build the unchanged Rust runtime-denylist parser oracle')
    args = parser.parse_args()
    project = restore(args.denylist_reference)
    if not args.restore_only:
        root = BASE.parents[2]
        command = ['cargo', f'+{args.toolchain}', 'build', '--locked', '--release', '--manifest-path', str(project / 'Cargo.toml')]
        if args.denylist_reference:
            command += ['--target-dir', str(root / 'rust/main/target')]
        subprocess.run(['python3', 'zig/tools/fixture_pack.py', 'restore-locks'], check=True, cwd=root)
        subprocess.run(command, check=True, cwd=root / 'rust/main')
        name = 'libziggy_regex.dylib' if platform.system() == 'Darwin' else 'libziggy_regex.so'
        print(root / 'rust/main/target/release/ziggy-denylist-reference' if args.denylist_reference else project / 'target/release' / name)
