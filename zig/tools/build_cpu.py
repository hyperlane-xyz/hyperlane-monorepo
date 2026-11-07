#!/usr/bin/env python3
"""Record compile-host features and postcompile bytes; does not change CPU flags."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re

SCOPES = {
    'native-db': {'relayer', 'validator', 'scraper'},
    'url': {'libziggy_url.so'},
    'regex': {'libziggy_regex.so'},
    'starknet': {'libziggy_starknet_crypto.so'},
    'aleo': {'libziggy_aleo_crypto.so', 'libziggy_aleo_vm.so', 'hyperlane-aleo-vm-worker'},
}


def cpu_flags(text, intersection=False):
    rows = [set(line.split(':', 1)[1].strip().split()) for line in text.splitlines()
            if line.split(':', 1)[0].strip().lower() in {'flags', 'features'}]
    if not rows or any(not row for row in rows):
        raise ValueError('CPU feature evidence unavailable')
    return sorted(set.intersection(*rows) if intersection else set.union(*rows))


def validate(row, scope, mode, commit, expected):
    if set(row) != {'schema', 'scope', 'mode', 'source_commit', 'architecture', 'flags', 'artifacts'} or row['schema'] != 1 or type(row['schema']) is not int:
        raise ValueError('compile provenance schema differs')
    if row['scope'] != scope or row['mode'] != mode or row['source_commit'] != commit or row['architecture'] not in {'amd64', 'arm64'}:
        raise ValueError('compile provenance scope/mode/source/platform differs')
    if not isinstance(row['flags'], list) or not row['flags'] or row['flags'] != sorted(set(row['flags'])) or any(re.fullmatch('[A-Za-z0-9_.+-]+', value) is None for value in row['flags']):
        raise ValueError('invalid observed compile CPU flags')
    if set(row['artifacts']) != SCOPES[scope]:
        raise ValueError('compile provenance artifact set differs')
    for name, value in row['artifacts'].items():
        if set(value) != {'bytes', 'sha256'} or type(value['bytes']) is not int or value['bytes'] <= 0 or value['sha256'] != expected[name]:
            raise ValueError('compiled artifact identity differs from tested bytes')
    return row


def consumer_covers(rows, architecture, available_flags):
    return bool(rows) and all(row['architecture'] == architecture and set(row['flags']) <= set(available_flags) for row in rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--scope', required=True, choices=sorted(SCOPES))
    parser.add_argument('--mode', required=True, choices=['ReleaseSafe', 'ReleaseFast'])
    parser.add_argument('--git-sha', required=True)
    parser.add_argument('--artifact', action='append', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if platform.system() != 'Linux' or not (re.fullmatch('[0-9a-f]{40}', args.git_sha) or args.git_sha == 'VERGEN_IDEMPOTENT_OUTPUT'):
        raise ValueError('Linux and compiled source identity required')
    architecture = {'x86_64': 'amd64', 'aarch64': 'arm64'}.get(platform.machine())
    if architecture is None:
        raise ValueError('unsupported compiler architecture')
    artifacts = {}
    for value in args.artifact:
        name, path = value.split('=', 1)
        path = Path(path)
        if name in artifacts or path.is_symlink() or not path.is_file():
            raise ValueError('duplicate or nonregular compiled artifact')
        with path.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        artifacts[name] = {'bytes': path.stat().st_size, 'sha256': digest}
    row = {'schema': 1, 'scope': args.scope, 'mode': args.mode, 'source_commit': args.git_sha,
           'architecture': architecture, 'flags': cpu_flags(Path('/proc/cpuinfo').read_text()), 'artifacts': artifacts}
    validate(row, args.scope, args.mode, args.git_sha, {name: value['sha256'] for name, value in artifacts.items()})
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('x') as stream:
        stream.write(json.dumps(row, indent=2) + '\n')


if __name__ == '__main__':
    main()
