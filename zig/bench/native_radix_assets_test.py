"""Pure Radix asset controls; never starts a CLI, container or native VM."""
import copy
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('radix_assets_under_test', Path(__file__).with_name('native_radix_assets.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class AssetsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='radix-assets-pure-')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()

    def test_official_bounded_metadata_and_publisher_digests_match_exact_pair(self):
        file = Path(__file__).resolve().parents[1] / 'integration/fixtures/radix-release-v1.0.0.json.gz'
        raw = gzip.decompress(file.read_bytes())
        self.assertEqual(len(raw), m.METADATA_BYTES)
        self.assertEqual(hashlib.sha256(raw).hexdigest(), m.METADATA_SHA)
        value = m.release_metadata(raw, m.CONTRACTS)
        self.assertEqual(value['id'], 243888469)
        for change in ['tag', 'digest', 'url', 'duplicate']:
            changed = copy.deepcopy(value)
            if change == 'tag': changed['tag_name'] = 'latest'
            elif change == 'digest': changed['assets'][0]['digest'] = 'sha256:' + '0' * 64
            elif change == 'url': changed['assets'][0]['browser_download_url'] = 'https://invalid.example/file'
            else: changed['assets'].append(copy.deepcopy(changed['assets'][0]))
            with self.subTest(change=change), self.assertRaises(ValueError):
                m.release_metadata(json.dumps(changed).encode(), m.CONTRACTS)

    def test_closed_amd64_policy_and_two_actual_image_identity_slots(self):
        policy = {'radix_images': copy.deepcopy(m.IMAGES), 'radix_contracts': {
            'release': '1.0.0', 'files': m.CONTRACTS,
            'metadata_bytes': m.METADATA_BYTES, 'metadata_sha256': m.METADATA_SHA}}
        self.assertEqual(m.validate_policy(policy, 'amd64'), policy)
        with self.assertRaises(ValueError): m.validate_policy(policy, 'arm64')
        for name, image in m.IMAGES.items():
            row = {'Id': image['image_id'], 'Os': 'linux', 'Architecture': 'amd64',
                   'RepoDigests': [image['canonical_digest']],
                   'Config': {'Volumes': {'/var/lib/postgresql/data': {}} if name == 'postgres_db' else None}}
            self.assertEqual(m.inspect_image([row, copy.deepcopy(row)], name, image), [row, row])
            for field, value in [('Id', 'sha256:' + '0' * 64), ('Architecture', 'arm64'), ('RepoDigests', [])]:
                wrong = copy.deepcopy(row)
                wrong[field] = value
                with self.subTest(service=name, field=field), self.assertRaises(ValueError):
                    m.inspect_image([row, wrong], name, image)
            with self.assertRaises(ValueError): m.inspect_image([row], name, image)
            wrong = copy.deepcopy(row)
            wrong.pop('Config')
            with self.assertRaises(ValueError): m.inspect_image([row, wrong], name, image)
            wrong = copy.deepcopy(row)
            wrong['Config']['Volumes'] = {'/foreign': {}}
            with self.assertRaises(ValueError): m.inspect_image([row, wrong], name, image)
        policy['radix_images']['fullnode']['source_image'] = 'foreign:latest'
        with self.assertRaises(ValueError): m.validate_policy(policy, 'amd64')

    def fixture(self):
        files = {}
        for name, data in [('hyperlane_radix.wasm', b'\0asm\x01\0\0\0fixture'), ('hyperlane_radix.rpd', b'fixture data')]:
            file = self.root / name
            file.write_bytes(data)
            file.chmod(0o600)
            files[name] = m.pin(file)
        pins = {name: {k: row[k] for k in ('bytes', 'sha256')} for name, row in files.items()}
        value = {'id': 1, 'tag_name': 'v1.0.0', 'html_url': m.RELEASE_URL, 'draft': False, 'prerelease': False,
                 'assets': [{'id': i + 1, 'name': name, 'state': 'uploaded', 'size': row['bytes'],
                             'digest': 'sha256:' + row['sha256'], 'browser_download_url': m.DOWNLOAD + name}
                            for i, (name, row) in enumerate(pins.items())]}
        raw = json.dumps(value).encode()
        packed = self.root / 'metadata.gz'
        packed.write_bytes(gzip.compress(raw, mtime=0))
        return files, pins, raw, m.pin(packed)

    def test_materializes_only_two_nonexecutable_owned_data_files(self):
        files, pins, raw, packed = self.fixture()
        with mock.patch.multiple(m, CONTRACTS=pins, METADATA_BYTES=len(raw), METADATA_SHA=hashlib.sha256(raw).hexdigest()):
            result = m.materialize_contracts(packed, files, self.root / 'owned')
            self.assertEqual(set(Path(result['root']).iterdir()), {Path(v['path']) for v in result['files'].values()})
            self.assertEqual(set(result['files']), set(pins))
            for name, row in result['files'].items():
                self.assertEqual(Path(row['path']).read_bytes(), Path(files[name]['path']).read_bytes())
                self.assertEqual(Path(row['path']).stat().st_mode & 0o777, 0o600)
            with self.assertRaises(ValueError): m.materialize_contracts(packed, files, self.root / 'owned')

    def test_executable_changed_hardlinked_or_escaped_data_never_reaches_copy(self):
        files, pins, raw, packed = self.fixture()
        source = Path(files['hyperlane_radix.rpd']['path'])
        with mock.patch.multiple(m, CONTRACTS=pins, METADATA_BYTES=len(raw), METADATA_SHA=hashlib.sha256(raw).hexdigest()):
            source.chmod(0o700)
            with self.assertRaises(ValueError): m.materialize_contracts(packed, files, self.root / 'mode')
            source.chmod(0o600)
            link = self.root / 'hardlink'
            link.hardlink_to(source)
            with self.assertRaises(ValueError): m.materialize_contracts(packed, files, self.root / 'linked')
            link.unlink()
            source.write_bytes(b'changed')
            with self.assertRaises(ValueError): m.materialize_contracts(packed, files, self.root / 'changed')
            self.assertFalse((self.root / 'changed').exists())
            with self.assertRaises(ValueError): m.materialize_contracts(packed, files, self.root / '..' / 'escaped')

    def test_duplicate_metadata_keys_are_rejected(self):
        with self.assertRaises(ValueError): m.unique_json(b'{"id":1,"id":1}')


if __name__ == '__main__':
    unittest.main()
