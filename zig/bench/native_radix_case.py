"""Radix-only data admission and owned reference copy; never starts a node."""
import importlib.util
import json
from pathlib import Path

REFERENCE = 'zig/src/radix/reference'
SOURCE_FILES = ('Cargo.toml', 'Cargo.lock.gz', 'src/main.rs', 'crypto_differential.py')


def require(ok, message):
    if not ok:
        raise ValueError(message)


def sibling(name):
    spec = importlib.util.spec_from_file_location('radix_case_' + name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_policy(request):
    require(request['scenario'] == 'radix' and request['postgres']['architecture'] == 'amd64', 'Reviewed Linux amd64 Radix case required')
    keys = {'local_checkout_build', 'hpack', 'registry_commit', 'radix_images', 'radix_contracts', 'radix_reference'}
    value = request['prerequisites']
    require(set(value) == keys and value['local_checkout_build'] is True and value['registry_commit'] is None, 'Exact Radix prerequisite fields required')
    require(value['radix_reference'] == {'same_producer_source': True, 'actual_sdk_tests': 5, 'locked_offline': True}, 'Actual same-cohort reference build/test policy required')
    reference = value['radix_reference']
    require(reference['same_producer_source'] is True and reference['locked_offline'] is True and type(reference['actual_sdk_tests']) is int, 'Literal Radix reference policy types required')
    sibling('native_radix_assets').validate_policy(value, 'amd64')
    return request


def inspect_reference(receipt, request, repo, machine, flags, api):
    """Retain the producer recipe separately from consumed compiled Source.

    The strict reference loader checks the producer's original full Source map,
    actual SDK tests/build/Clippy/lock restoration/CPU/ELF and process waits.
    Consumer Python/workflow updates do not pretend to be that original recipe.
    """
    validate_policy(request)
    producer = request['producer_source_commit']
    remote = receipt['artifacts']['radix_reference']
    base = Path(remote['directory'])
    manifest = api.relative_file(base, 'manifest.json')
    reference = sibling('native_radix_reference')
    product = reference.load_manifest(manifest, api.checksum(manifest), producer, machine, flags, transport_data_only=True)
    value = api.read_json(manifest)
    gate_path = reference.member(base, value['source_gate'], 'source-gate.json')
    gate = api.read_json(gate_path)
    expected = {REFERENCE + '/' + name for name in SOURCE_FILES}
    actual_names = {name for name in gate['source_before'] if name.startswith(REFERENCE + '/')}
    require(actual_names == expected, 'Exact compiled Radix reference Source set required')
    current = {}
    for name in sorted(expected):
        row = api.artifact(api.relative_file(repo, name))
        require(all(row[k] == gate['source_before'][name][k] for k in ('bytes', 'sha256')), 'Consumed Radix SDK reference Source changed')
        current[name] = row
    files = [api.artifact(api.relative_file(base, row['relative_path'])) for row in remote['files']]
    require(product in files and api.artifact(manifest) in files and api.artifact(gate_path) in files, 'Reference artifact extraction closure differs')
    return {'schema': 1, 'producer_source_commit': producer, 'manifest': api.artifact(manifest), 'source_gate': api.artifact(gate_path), 'product': product, 'consumed_compiled_source': current, 'producer_recipe_source': gate['source_before'], 'files': files, 'native_case_acceptance': False}


def materialize_reference(value, root, api):
    # Downloads are deliberately mode0600 until ELF/digest admission above.
    source = api.checked(value['product'])
    copied = api.copy_verified(source, value['product'], root / 'tools/ziggy-radix-reference', 0o755)
    required = [*value['files'], *value['consumed_compiled_source'].values(), copied]
    gate = api.read_json(api.checked(value['source_gate']))
    reference = sibling('native_radix_reference')
    checks = []
    for row in gate['checks']:
        log = reference.member(Path(value['manifest']['path']).parent, row['log'], row['name'] + '.log')
        require(row['passed'] is True and row['exit_code'] == 0 and row['actual_parent_wait'] is True and row['cleanup']['clean'], 'Actual reference command no longer qualified')
        checks.append({'name': row['name'], 'exit_code': row['exit_code'], 'log': api.artifact(log)})
    accepted = {'schema': 1, 'root_approved': True, 'accepted_reference_component': True,
                'tool': copied, 'source_sha256': {name: row['sha256'] for name, row in value['consumed_compiled_source'].items()},
                'checks': checks, 'actual_source_coherent_reference': value,
                'scope': 'Actual same-cohort SDK reference build/tests/Clippy/CPU/ELF admitted; original producer recipe retained separately.',
                'native_case_acceptance': False, 'timing_acceptance': False}
    output = root / 'evidence/accepted-radix-reference.json'
    require(not output.exists() and not output.is_symlink(), 'Preserve existing reference admission')
    with output.open('x') as stream:
        json.dump(accepted, stream, sort_keys=True)
        stream.write('\n')
    acceptance = api.artifact(output)
    return copied, acceptance, [*required, acceptance]


def fixture_configuration(token):
    assets = sibling('native_radix_assets')
    return {'architecture': 'amd64', 'token': token,
            'images': {name: {'source': row['source_image'], 'id': row['image_id']} for name, row in assets.IMAGES.items()}}


def validate_stage(value, request, api):
    assets = sibling('native_radix_assets')
    require(set(value) == {'bundle', 'images'} and set(value['images']) == set(assets.SERVICES), 'Exact Radix five-image and contract outputs required')
    bundle = value['bundle']
    require(set(bundle) == {'schema', 'scenario', 'source_release', 'root', 'release_metadata', 'files'} and type(bundle['schema']) is int and bundle['schema'] == 1 and bundle['scenario'] == 'radix' and bundle['source_release'] == '1.0.0' and set(bundle['files']) == set(assets.CONTRACTS), 'Radix data bundle differs')
    metadata = api.checked(bundle['release_metadata'])
    require(bundle['release_metadata']['bytes'] == assets.METADATA_BYTES and bundle['release_metadata']['sha256'] == assets.METADATA_SHA, 'Actual pinned Radix release metadata differs')
    assets.release_metadata(metadata.read_bytes(), assets.CONTRACTS)
    for name, row in bundle['files'].items():
        path = api.checked(row)
        require({k: row[k] for k in ('bytes', 'sha256')} == assets.CONTRACTS[name] and path == Path(bundle['root']) / name and path.stat().st_mode & 0o111 == 0, 'Radix contract file differs')
    daemons = set()
    for name, descriptor in value['images'].items():
        record = api.read_json(api.checked(descriptor))
        require(record['passed'] is True and record['native_case_acceptance'] is False and record['no_container_or_node_started'] is True and record['same_host_filesystem'] is True and record['all_actual_parent_waits'] is True and record['calls'] and all(c['actual_parent_wait'] is True and (c['exit_code'] == 0 or c['exit_code'] == 1 and c['arguments'][:2] == ['image', 'inspect']) for c in record['calls']), 'Actual Radix image setup failed')
        require(record['image_policy'] == {**request['prerequisites']['radix_images'][name], 'architecture': 'amd64'}, 'Radix image setup policy differs')
        assets.inspect_image(record['actual_image_rows'], name, request['prerequisites']['radix_images'][name])
        daemon = record['daemon']
        directory = Path(daemon['DockerRootDir']).resolve(strict=True)
        require(directory.is_dir() and directory.stat().st_dev == daemon['filesystem_device'], 'Radix daemon filesystem changed')
        daemons.add((daemon['ID'], str(directory), daemon['filesystem_device']))
    require(len(daemons) == 1, 'Radix image setup used different daemons')
    return next(iter(daemons))
