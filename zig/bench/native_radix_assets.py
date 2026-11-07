"""Closed Radix Linux data policies. Imports never start a node or use network."""
import gzip
import hashlib
import json
from pathlib import Path
import re
import stat

GIB = 1024 ** 3
SERVICES = {
    'fullnode': ('radixdlt/babylon-node:v1.3.0.1', 1536, 256),
    'postgres_db': ('postgres:15.2-alpine', 512, 128),
    'database_migrations_image': ('radixdlt/babylon-ng-database-migrations:v1.10.3', 256, 128),
    'data_aggregator_image': ('radixdlt/babylon-ng-data-aggregator:v1.10.3', 1024, 256),
    'gateway_api_image': ('radixdlt/babylon-ng-gateway-api:v1.10.3', 512, 128),
}
RELEASE_URL = 'https://github.com/hyperlane-xyz/hyperlane-radix/releases/tag/v1.0.0'
DOWNLOAD = 'https://github.com/hyperlane-xyz/hyperlane-radix/releases/download/v1.0.0/'


def require(value, message):
    if not value:
        raise ValueError(message)


def pin(path):
    path = Path(path)
    value = path.lstat()
    require(path.is_absolute() and stat.S_ISREG(value.st_mode) and value.st_nlink == 1,
            'Regular unaliased Radix data required')
    with path.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    return {'path': str(path), 'bytes': value.st_size, 'sha256': digest}


def checked(row):
    require(isinstance(row, dict) and set(row) == {'path', 'bytes', 'sha256'},
            'Closed Radix file descriptor required')
    path = Path(row['path'])
    require(path.is_absolute() and '..' not in path.parts and pin(path) == row,
            'Radix data file changed')
    require(not any(p.is_symlink() for p in path.parents), 'Radix parent symlink')
    return path


def unique_json(raw):
    require(type(raw) is bytes and len(raw) <= 1024 ** 2, 'Bounded Radix metadata required')
    def pairs(items):
        out = {}
        for key, value in items:
            require(key not in out, 'Duplicate Radix JSON key')
            out[key] = value
        return out
    return json.loads(raw, object_pairs_hook=pairs)


def release_metadata(raw, files):
    """Actual official response, including optional published asset digests."""
    value = unique_json(raw)
    require(value.get('tag_name') == 'v1.0.0' and value.get('html_url') == RELEASE_URL
            and value.get('draft') is False and value.get('prerelease') is False
            and type(value.get('id')) is int and value['id'] > 0, 'Wrong Radix Source release')
    assets = value.get('assets')
    require(isinstance(assets, list) and len(assets) <= 64 and set(files) == set(CONTRACTS),
            'Exact Radix WASM/RPD release pair required')
    for name, expected in CONTRACTS.items():
        rows = [r for r in assets if isinstance(r, dict) and r.get('name') == name]
        require(len(rows) == 1, 'Missing or duplicated Radix release asset')
        row = rows[0]
        require(type(row.get('id')) is int and row['id'] > 0 and row.get('state') == 'uploaded'
                and row.get('browser_download_url') == DOWNLOAD + name
                and type(row.get('size')) is int and row['size'] == expected['bytes']
                and files[name] == expected, 'Radix release identity or byte pin differs')
        if row.get('digest') is not None:
            require(row['digest'] == 'sha256:' + expected['sha256'], 'Radix publisher digest differs')
    return value


def validate_policy(prerequisites, architecture):
    require(architecture == 'amd64', 'Only the reviewed Linux amd64 Radix cohort is admitted')
    require(prerequisites['radix_images'] == IMAGES, 'Exact five Source image policies required')
    require(prerequisites['radix_contracts'] == {'release': '1.0.0', 'files': CONTRACTS,
            'metadata_bytes': METADATA_BYTES, 'metadata_sha256': METADATA_SHA},
            'Exact public Radix release inputs required')
    return prerequisites


def inspect_image(rows, service, policy):
    require(service in SERVICES and policy == IMAGES[service], 'Unknown Radix image policy')
    require(isinstance(rows, list) and len(rows) == 2, 'Inspect immutable ID and Source tag')
    for row in rows:
        require(isinstance(row, dict) and isinstance(row.get('Config'), dict), 'Actual image config required')
        require(row.get('Id') == policy['image_id'] and row.get('Os') == 'linux'
                and row.get('Architecture') == 'amd64'
                and policy['canonical_digest'] in row.get('RepoDigests', []),
                'Radix Source tag, config, platform or RepoDigest differs')
        volumes = row.get('Config', {}).get('Volumes')
        require(volumes == ({'/var/lib/postgresql/data': {}} if service == 'postgres_db' else None),
                'Radix image acquired an unreviewed volume')
    return rows


def materialize_contracts(metadata_gzip, files, root):
    """Create a fresh data-only pair; never execute WASM or alter accepted inputs."""
    require(set(files) == set(CONTRACTS), 'Exact two Radix data files required')
    packed = checked(metadata_gzip)
    require(packed.stat().st_size <= 1024 ** 2, 'Packed Radix metadata bound')
    import io
    with gzip.GzipFile(fileobj=io.BytesIO(packed.read_bytes())) as stream:
        raw = stream.read(1024 ** 2 + 1)
    require(len(raw) == METADATA_BYTES and hashlib.sha256(raw).hexdigest() == METADATA_SHA,
            'Pinned official release metadata changed')
    release_metadata(raw, CONTRACTS)
    root = Path(root)
    require(root.is_absolute() and '..' not in root.parts and not root.exists()
            and not root.is_symlink() and not any(p.is_symlink() for p in root.parents),
            'Exclusive owned Radix data root required')
    for name, row in files.items():
        source = checked(row)
        require({k: row[k] for k in ('bytes', 'sha256')} == CONTRACTS[name]
                and source.stat().st_mode & 0o111 == 0, 'Radix data bytes or mode differs')
        if name.endswith('.wasm'):
            with source.open('rb') as stream:
                require(stream.read(8) == b'\0asm\x01\0\0\0', 'Radix WASM1 header differs')
    (root / 'contracts').mkdir(mode=0o700, parents=True)
    metadata = root / 'release.json'
    with metadata.open('xb') as stream:
        stream.write(raw)
    metadata.chmod(0o600)
    copied = {}
    for name, row in files.items():
        destination = root / 'contracts' / name
        with destination.open('xb') as stream:
            stream.write(checked(row).read_bytes())
        destination.chmod(0o600)
        copied[name] = pin(destination)
        require({k: copied[name][k] for k in ('bytes', 'sha256')} == CONTRACTS[name],
                'Radix data changed during copy')
    return {'schema': 1, 'scenario': 'radix', 'source_release': '1.0.0',
            'root': str(root / 'contracts'), 'release_metadata': pin(metadata), 'files': copied}


def public_profile(reference):
    require(checked(reference).stat().st_mode & 0o111, 'Admitted Radix reference executable required')
    # The caller independently validates the successful same-cohort reference
    # manifest, CPU, Source and SDK tests, then binds its approval descriptor.
    value = json.loads(json.dumps(PUBLIC_PROFILE))
    value['family_tools'] = {'radix_reference': reference}
    return value


# Actual official metadata/payload readbacks, 2026-11-07; publisher checksums verified.
METADATA_BYTES = 7865
METADATA_SHA = ('a90945c1008b267040c4d6eb17c32a9e' '2da0dd414804ca963dfb9bf7d270d7b2')
IMAGES = {'data_aggregator_image': {'canonical_digest': ('radixdlt/babylon-ng-data-aggregator@sha256:de7f1efe19f219530da50b9cd6478f78' '2858affd76a6b520b79eba2e1649b05d'),
                           'image_id': ('sha256:eb23d60cb95fa1400f4b9aa430de39b9' 'babdc41c3119fd7f4293a354c7f69de2'),
                           'source_image': 'radixdlt/babylon-ng-data-aggregator:v1.10.3'},
 'database_migrations_image': {'canonical_digest': ('radixdlt/babylon-ng-database-migrations@sha256:f0bc2f9fbf8ca59a5c221128d3e0c879' '714957a3753fb0ab21e393562196da1c'),
                               'image_id': ('sha256:4ec55f7eb0680512f65d3c6844dae05c' 'bf5972d8171e0e0944302d60fa2ab50f'),
                               'source_image': 'radixdlt/babylon-ng-database-migrations:v1.10.3'},
 'fullnode': {'canonical_digest': ('radixdlt/babylon-node@sha256:4acd3afcb28376c560409fca46b36397' '054b151b62aa2a38cb91fbd48ffbb602'),
              'image_id': ('sha256:f04273c2411d89b502aed11552fe83d0' 'cb5660d1996ee196adfc7c7a7805955f'),
              'source_image': 'radixdlt/babylon-node:v1.3.0.1'},
 'gateway_api_image': {'canonical_digest': ('radixdlt/babylon-ng-gateway-api@sha256:ef7aa39651897ebfbb6b39bbfea2a75c' 'a4e04d5ff802a62b8ee4247ca1638676'),
                       'image_id': ('sha256:8053a0fa3c5b1c42be1cb3f837b6a55c' '8e92d0618d406bd64b26b8a0365ece65'),
                       'source_image': 'radixdlt/babylon-ng-gateway-api:v1.10.3'},
 'postgres_db': {'canonical_digest': ('postgres@sha256:07ec36ad2d5ab9250f38c8ef749239b6' '62cf15d03c9ddb7167422edbbdf71156'),
                 'image_id': ('sha256:ddc12ac7fa27279bfcc41deaccd13682' '91ab7d71ca7cee0420b41f9974e9a468'),
                 'source_image': 'postgres:15.2-alpine'}}
CONTRACTS = {'hyperlane_radix.rpd': {'bytes': 19071,
                         'sha256': ('274871ffb45c9db2d78fd0fc5bff7ec8' '9a21907870118303fe35a65bbce5be88')},
 'hyperlane_radix.wasm': {'bytes': 438167,
                          'sha256': ('f3dd959d32a2a123dda7744ca9963fd6' '42376e4d60128d24d458474183309336')}}
PUBLIC_PROFILE = {'additional_refused_dispatches': 0,
 'chain_names': ['radixtest0', 'radixtest1'],
 'domain_names': {'9913374': 'radixtest0', '9913375': 'radixtest1'},
 'initial_corpus': {'deliveries': 4,
                    'dispatches': 4,
                    'double_insertions': 0,
                    'failed_body': 0,
                    'zero_insertions': 0},
 'payment_resource': 'resource_loc1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxvq32hv',
 'payments_supported': True,
 'relayer_accounts': {'radixtest0': 'account_loc12ytsy99ajzkwy7ce0444fs8avat7jy3fkj5mk64yz2z3yml6s7y7x3',
                      'radixtest1': 'account_loc12ytsy99ajzkwy7ce0444fs8avat7jy3fkj5mk64yz2z3yml6s7y7x3'},
 'relayer_public_keys': {'radixtest0': ('0xec7653181ac9c56eb7afa4f4c29549fc' 'b40b11278bd7c5c558bf4351e6bad260'),
                         'radixtest1': ('0xec7653181ac9c56eb7afa4f4c29549fc' 'b40b11278bd7c5c558bf4351e6bad260')},
 'scenario': 'radix',
 'schema': 1,
 'validator_addresses': {'radixtest0': '0xdd1fe72baace37f21ddbe1c2558b9b4f9748fc6a',
                         'radixtest1': '0xdd1fe72baace37f21ddbe1c2558b9b4f9748fc6a'}}
