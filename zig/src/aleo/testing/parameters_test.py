#!/usr/bin/env python3
"""Offline provisioning-selection controls; no Cargo or HTTP calls are executed."""
import contextlib
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import parameters


def sha(data):
    return hashlib.sha256(data).hexdigest()


class ParametersTests(unittest.TestCase):
    def fixture(self, root):
        source = root / 'sdk/src'
        payloads = {}
        for degree in range(15, 19):
            for prefix in ['powers-of-beta-', 'shifted-powers-of-beta-']:
                name = prefix + str(degree)
                payload = name.encode()
                path = source / 'mainnet/resources' / (name + '.metadata')
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps({'checksum': sha(payload), 'size': len(payload)}))
                payloads[sha(payload)] = payload
        for network in ['mainnet', 'testnet', 'canary']:
            payload = (network + '-fee').encode()
            payloads[sha(payload)] = payload
            for credit in ['credits', 'credits_v0']:
                path = source / network / 'resources' / credit / 'fee_public.metadata'
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps({'prover_checksum': sha(payload), 'prover_size': len(payload)}))
        return source, payloads

    def test_testnet_uses_shared_mainnet_powers_and_own_fee(self):
        with tempfile.TemporaryDirectory() as directory:
            source, payloads = self.fixture(Path(directory))
            rows = parameters.parameter_catalog(source, 'testnet', 18)
            self.assertEqual(len(rows), 10)  # Two legacy/current fee references dedupe later.
            self.assertTrue(all(row[0] == 'mainnet' for row in rows[:8]))
            self.assertTrue(all(row[0] == 'testnet' and row[3] == sha(b'testnet-fee') for row in rows[8:]))
            self.assertFalse((source / 'testnet/resources/powers-of-beta-15.metadata').exists())
            self.assertEqual(len(payloads), 11)

    def test_mainnet_default_catalog_preserves_original_selection(self):
        with tempfile.TemporaryDirectory() as directory:
            source, _ = self.fixture(Path(directory))
            rows = parameters.parameter_catalog(source, 'mainnet', 18)
            self.assertEqual(len(rows), 10)
            self.assertTrue(all(row[0] == 'mainnet' for row in rows))
            self.assertEqual([row[1] for row in rows[:8]], [prefix + str(degree) for degree in range(15, 19) for prefix in ['powers-of-beta-', 'shifted-powers-of-beta-']])

    def test_canary_uses_shared_powers_and_distinct_credits(self):
        with tempfile.TemporaryDirectory() as directory:
            source, _ = self.fixture(Path(directory))
            rows = parameters.parameter_catalog(source, 'canary', 15)
            self.assertEqual([row[0] for row in rows], ['mainnet', 'mainnet', 'canary', 'canary'])
            self.assertEqual(rows[2][3], sha(b'canary-fee'))

    def test_cargo_metadata_is_locked_offline_without_execution(self):
        with patch.object(parameters.subprocess, 'check_output', return_value='{"packages":[]}') as command:
            self.assertEqual(parameters.cargo_metadata(Path('/fixture/Cargo.toml')), {'packages': []})
            self.assertEqual(command.call_args.args[0], ['cargo', '+1.98.0', 'metadata', '--locked', '--offline', '--format-version=1', '--manifest-path', '/fixture/Cargo.toml'])

    def test_cli_defaults_and_cached_file_verification_no_fetch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, payloads = self.fixture(root)
            home = root / 'home'
            dest = home / '.aleo/resources'
            dest.mkdir(parents=True)
            for _, name, kind, digest, _ in parameters.parameter_catalog(source, 'mainnet', 18):
                (dest / f'{name}.{kind}.{digest[:7]}').write_bytes(payloads[digest])
            metadata = {'packages': [{'name': 'snarkvm-parameters', 'source': 'git#' + parameters.SNARKVM_REVISION, 'manifest_path': str(source.parent / 'Cargo.toml')}]}
            output = io.StringIO()
            with patch.object(parameters, 'cargo_metadata', return_value=metadata), patch.object(parameters.urllib.request, 'urlopen', side_effect=AssertionError('no HTTP allowed')), contextlib.redirect_stdout(output):
                parameters.main(['--home', str(home)])
            result = json.loads(output.getvalue())
            self.assertEqual(result['network'], 'mainnet')
            self.assertEqual(result['files'], 9)
            self.assertEqual(result['bytes'], sum(len(payloads[digest]) for digest in {row[3] for row in parameters.parameter_catalog(source, 'mainnet', 18)}))

    def test_no_fetch_is_default_and_existing_corruption_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            row = ('testnet', 'fee_public', 'prover', sha(b'key'), 3)
            with patch.object(parameters.urllib.request, 'urlopen', side_effect=AssertionError('no HTTP')):
                with self.assertRaisesRegex(SystemExit, 'Missing explicit'):
                    parameters.provision(home, 'testnet', [row], False)
                path = home / '.aleo/resources' / f'fee_public.prover.{row[3][:7]}'
                path.write_bytes(b'bad')
                with self.assertRaisesRegex(SystemExit, 'checksum or size'):
                    parameters.provision(home, 'testnet', [row], True)
                self.assertEqual(path.read_bytes(), b'bad')

    def test_mock_fetch_uses_each_assets_source_network_and_exact_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            source, payloads = self.fixture(Path(directory))
            rows = parameters.parameter_catalog(source, 'testnet', 15)
            requested = []
            class Response(io.BytesIO):
                def __init__(self, url, data):
                    super().__init__(data)
                    self.url = url
                def geturl(self):
                    return self.url
            def fetch(request, timeout):
                self.assertEqual(timeout, 30)
                requested.append(request.full_url)
                filename = request.full_url.rsplit('/', 1)[1]
                row = next(row for row in rows if filename == f'{row[1]}.{row[2]}.{row[3][:7]}')
                return Response(request.full_url, payloads[row[3]])
            with patch.object(parameters.urllib.request, 'urlopen', side_effect=fetch):
                result = parameters.provision(Path(directory) / 'home', 'testnet', rows, True)
            self.assertEqual(result['files'], 3)
            self.assertTrue(requested[0].startswith('https://parameters.provable.com/mainnet/'))
            self.assertTrue(requested[1].startswith('https://parameters.provable.com/mainnet/'))
            self.assertTrue(requested[2].startswith('https://parameters.provable.com/testnet/'))

    def test_mock_redirect_oversize_and_checksum_reject_without_partial_final(self):
        for body, redirected, error in [(b'too-long', False, 'Oversized'), (b'bad', False, 'checksum'), (b'key', True, 'redirect')]:
            with self.subTest(error=error), tempfile.TemporaryDirectory() as directory:
                class Response(io.BytesIO):
                    def geturl(self):
                        return 'https://unapproved.invalid/other' if redirected else url
                row = ('testnet', 'fee_public', 'prover', sha(b'key'), 3)
                url = f'https://parameters.provable.com/testnet/fee_public.prover.{row[3][:7]}'
                with patch.object(parameters.urllib.request, 'urlopen', return_value=Response(body)):
                    with self.assertRaisesRegex(SystemExit, error):
                        parameters.provision(Path(directory), 'testnet', [row], True)
                self.assertEqual(list((Path(directory) / '.aleo/resources').iterdir()), [])

    def test_caps_and_invalid_network_before_any_http(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(parameters.urllib.request, 'urlopen', side_effect=AssertionError('no HTTP')):
            with self.assertRaisesRegex(SystemExit, 'fetch cap'):
                parameters.provision(Path(directory), 'testnet', [('testnet', 'fee_public', 'prover', sha(b'key'), parameters.MAX_FILE_BYTES + 1)], True)
            with self.assertRaises(ValueError):
                parameters.parameter_catalog(Path(directory), 'invalid', 18)
            with self.assertRaises(ValueError):
                parameters.parameter_catalog(Path(directory), 'testnet', 21)


if __name__ == '__main__':
    unittest.main()
