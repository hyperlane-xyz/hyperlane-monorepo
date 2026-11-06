#!/usr/bin/env python3
"""Differential fixture corpus from unchanged production runtime-denylist parser."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import random
import subprocess

ROOT = Path(__file__).resolve().parents[4]
OUTPUT = ROOT / 'zig/src/ops/testing/denylist.json.gz'

def chunks(value):
    return [value[i:i + 32] for i in range(0, len(value), 32)]

def cases():
    out = []
    def add(name, rules, now=0, nanos=0, raw=False, duplicate=False):
        wire = rules if raw else json.dumps({'rules': rules}, separators=(',', ':'), ensure_ascii=False)
        out.append({'name': name, 'text': wire, 'now': now, 'nanos': nanos, 'duplicate': duplicate})
    add('empty', [])
    for value in [1, '1', '+1', '0x1', -1, 4294967295, 4294967296, [], [1, 2], ['+1'], ['0x1'], '*', None]:
        for field in ['originDomain', 'destinationDomain']:
            add(f'{field}/{value}', [{'reason': 'deny', 'addedBy': 'ops', 'match': {field: value}}])
    for value in ['0x' + '12' * 20, '0x' + '34' * 32, '0x' + '00' * 32, '0x1', '*', [], None]:
        for field in ['messageId', 'senderAddress', 'recipientAddress']:
            add(f'{field}/{len(str(value))}/{value}', [{'reason': 'deny', 'addedBy': 'ops', 'match': {field: value}}])
    for pattern in [None, '', '^00[a-f]+$', '.*', '(', '(?i:ab)', r'\p{Greek}+', r'(a)\1']:
        add(f'regex/{pattern}', [{'reason': 'deny', 'addedBy': 'ops', 'match': {'originDomain': 1, 'bodyRegex': pattern}}])
        add(f'only-regex/{pattern}', [{'reason': 'deny', 'addedBy': 'ops', 'match': {'bodyRegex': pattern}}])
    for stamp in ['1970-01-01T00:00:01Z', '1970-01-01t00:00:01z', '1970-01-01 00:00:01Z', '1970-01-01T00:00:01.000000001Z', '1970-01-01T00:00:01.5Z', '1970-01-01T00:00:01.1234567899Z', '1969-12-31T23:59:59Z', '0000-01-01T00:00:00Z', '2000-02-29T23:59:59+01:30', '2001-02-29T00:00:00Z', '1970-01-01T00x00:01Z', '1970-01-01T00:00x01Z', '1970-01-01T00:00:01++1:00', '1970-01-01T00:00:60Z']:
        for now, nanos in [(0, 0), (1, 0), (1, 1), (1, 500000000), (2, 0)]:
            add(f'expiry/{stamp}/{now}/{nanos}', [{'reason': 'deny', 'addedBy': 'ops', 'expiresAt': stamp, 'match': {'originDomain': 1}}], now, nanos)
    for field in ['match', 'address', 'expiresAt']:
        rule = {'reason': 'deny', 'addedBy': 'ops', 'match': {'originDomain': 1}}
        rule[field] = None
        add(f'nullable/{field}', [rule])
    add('nullable-address-with-valid-match', [{'reason': 'deny', 'addedBy': 'ops', 'address': None, 'expiresAt': None, 'match': {'originDomain': 1, 'bodyRegex': None}}])
    add('conflicting-case-alias', [{'reason': 'deny', 'addedBy': 'ops', 'match': {'originDomain': 1, 'ORIGINDOMAIN': 2}}])
    add('equal-case-alias', [{'reason': 'deny', 'addedBy': 'ops', 'match': {'originDomain': 1, 'ORIGINDOMAIN': 1}}])
    add('unknown-outer', {'rules': [], 'extra': 1}, raw=True) if False else None
    add('unknown-outer', '{"rules":[],"extra":1}', raw=True)
    add('duplicate-json-field', '{"rules":[{"reason":"a","reason":"b","addedBy":"ops","match":{"originDomain":1}}]}', raw=True, duplicate=True)
    randomizer = random.Random(71454)
    for i in range(64):
        fields = [('reason', ' denied π '), ('addedBy', ' operator '), ('match', {'recipientAddress': '0x' + '56' * 20, 'originDomain': [1, 2], 'bodyRegex': None})]
        randomizer.shuffle(fields)
        add(f'canonical-order/{i}', [dict(fields)])
    return out

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', type=Path, default=ROOT / 'rust/main/target/release/ziggy-denylist-reference')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    inputs = cases()
    wire = ''.join(json.dumps({k: item[k] for k in ['text', 'now', 'nanos']}, ensure_ascii=False) + '\n' for item in inputs)
    result = subprocess.run([str(args.reference)], input=wire, text=True, capture_output=True, check=True)
    records = []
    responses = result.stdout.splitlines()
    if len(responses) != len(inputs):
        raise ValueError('Oracle result count differs')
    for item, line in zip(inputs, responses):
        expected = json.loads(line)
        expected['fingerprint'] = [chunks(value) for value in expected.get('fingerprint', [])]
        records.append({'name': item['name'], 'wire': chunks(item['text']), 'now': item['now'], 'nanos': item['nanos'], 'intentional_duplicate_rejection': item['duplicate'], 'requires_regex': 'bodyRegex' in item['text'] and '"bodyRegex":null' not in item['text'] and '"bodyRegex": null' not in item['text'], 'expected': expected})
    provenance = []
    for path in ['rust/main/agents/relayer/src/msg/runtime_denylist.rs', 'rust/main/hyperlane-core/src/matching_list.rs', 'rust/main/hyperlane-core/src/utils.rs']:
        provenance.append({'path': path, 'sha256': chunks(hashlib.sha256((ROOT / path).read_bytes()).hexdigest())})
    output = json.dumps({'source': provenance, 'cases': records}, ensure_ascii=False, indent=2) + '\n'
    if args.check:
        with gzip.open(OUTPUT, 'rt', encoding='utf-8') as fixture:
            if fixture.read() != output:
                raise SystemExit('Denylist fixture differs from production parser')
    else:
        OUTPUT.write_bytes(gzip.compress(output.encode(), mtime=0))
    print(json.dumps({'cases': len(records), 'accepted': sum(v['expected']['accepted'] for v in records)}))

if __name__ == '__main__':
    main()
