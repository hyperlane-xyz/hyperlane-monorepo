#!/usr/bin/env python3
"""Pure data/copy controls. Never execute an Agave/SBF/native product."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import struct
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('svm_assets', Path(__file__).with_name('native_svm_assets.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def header(machine=263, kind=3):
    value = bytearray(64)
    value[:8] = b'\x7fELF\x02\x01\x01\x00'
    struct.pack_into('<HH', value, 16, kind, machine)
    return value


class Controls(unittest.TestCase):
    def test_linux_mapping_is_exact_85_and_bytes(self):
        self.assertEqual(len(m.AGAVE), 85)
        self.assertEqual(sum(row[0] for row in m.AGAVE.values()), 417020742)
        self.assertIn('bin/perf-libs/libsigning.so', m.AGAVE)
        self.assertIn('bin/perf-libs/cuda-10.2/libcuda-crypt.so', m.AGAVE)
        self.assertEqual(len(m.ENVIRONMENT), 25)
        self.assertEqual(len(m.PROGRAMS), 13)
        self.assertEqual(sum(row[2] == 263 for row in m.PROGRAMS.values()), 9)
        self.assertEqual(sum(row[2] == 247 for row in m.PROGRAMS.values()), 4)

    def test_sbf_both_agave_loader_formats(self):
        for machine in [247, 263]:
            self.assertEqual(m.elf_header(header(machine), True), machine)
            with self.assertRaises(ValueError): m.elf_header(header(machine), False)

    def test_native_only_machine_62_exec_or_dyn(self):
        for kind in [2, 3]:
            self.assertEqual(m.elf_header(header(62, kind), False), 62)
            with self.assertRaises(ValueError): m.elf_header(header(62, kind), True)

    def test_rejected_class_endian_version_osabi_type_machine(self):
        for offset, value in [(0, 0), (4, 1), (5, 2), (6, 0), (7, 3), (16, 2), (18, 62)]:
            wrong = header(); wrong[offset] = value
            with self.assertRaises(ValueError): m.elf_header(wrong, True)
        for machine in [0, 183, 248]:
            with self.assertRaises(ValueError): m.elf_header(header(machine), True)
        with self.assertRaises(ValueError): m.elf_header(header()[:63], True)

    def test_actual_publisher_GNU_native_ABI_does_not_relax_SBF(self):
        native=header(62);native[7]=3
        self.assertEqual(m.elf_header(native,False),62)
        sbf=header(263);sbf[7]=3
        with self.assertRaises(ValueError):m.elf_header(sbf,True)
        native[7]=255
        with self.assertRaises(ValueError):m.elf_header(native,False)

    def test_closed_members_missing_extra_and_directory_escape(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve(); (root / 'file').write_bytes(b'x')
            m.closed_members(root, {'file'})
            for expected in [set(), {'file', 'absent'}]:
                with self.assertRaises(ValueError): m.closed_members(root, expected)
            (root / 'link').symlink_to(root / 'file')
            with self.assertRaises(ValueError): m.closed_members(root, {'file', 'link'})

    def test_member_rejects_traversal_absolute_and_symlink_parent(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve(); (root / 'file').write_bytes(b'x')
            for name in ['../file', '/file', 'a/../file', 'a\\file', 'file/']:
                with self.assertRaises(ValueError): m.member(root, name)
            (root / 'link').symlink_to(root, target_is_directory=True)
            with self.assertRaises(ValueError): m.member(root, 'link/file')

    def test_hardlinks_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve(); (root / 'file').write_bytes(b'x')
            os.link(root / 'file', root / 'alias')
            with self.assertRaises(ValueError): m.pin(root / 'file')
            with self.assertRaises(ValueError): m.closed_members(root, {'file', 'alias'})

    def test_exclusive_copy_bytes_modes_and_source_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve(); source = root / 'source'; source.write_bytes(header())
            before = m.pin(source); destination = root / 'owned/nested/program'
            result = m.copy_owned(source, before, destination, 0o644)
            self.assertEqual((result['bytes'], result['sha256']), (before['bytes'], before['sha256']))
            self.assertEqual(destination.stat().st_mode & 0o777, 0o644)
            self.assertEqual(m.pin(source), before)
            self.assertNotEqual(source.stat().st_ino, destination.stat().st_ino)
            with self.assertRaises(ValueError): m.copy_owned(source, before, destination, 0o644)

    def test_copy_rejects_changed_source_and_link_parent(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve(); source = root / 'source'; source.write_bytes(b'x')
            before = m.pin(source); source.write_bytes(b'y')
            with self.assertRaises(ValueError): m.copy_owned(source, before, root / 'dest', 0o644)
            before = m.pin(source); (root / 'link').symlink_to(root, target_is_directory=True)
            with self.assertRaises(ValueError): m.copy_owned(source, before, root / 'link/dest', 0o644)
            self.assertFalse((root / 'dest').exists())

    def test_changed_descriptor_cannot_be_staged_as_validated(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            data = {'platform':m.PLATFORM, 'source_commit':m.SOURCE_COMMIT,
                    'native_case_acceptance':False, 'files':{}}
            for name, row in m.AGAVE.items(): data['files']['agave/'+name] = {'bytes':row[0], 'sha256':row[1]}
            for name, row in m.PROGRAMS.items(): data['files']['programs/'+name] = {'bytes':row[0], 'sha256':row[1]}
            for name, row in [('client/hyperlane-sealevel-client',m.CLIENT),('home/.cargo/bin/spl-token',m.SPL)]:
                data['files'][name] = {'bytes':row[0], 'sha256':row[1]}
            manifest=root/'products.json'
            manifest.write_text(json.dumps({'programs':{n:{'bytes':r[0],'sha256':r[1]} for n,r in m.PROGRAMS.items()},
                                           'client':{'bytes':m.CLIENT[0],'sha256':m.CLIENT[1]},
                                           'spl':{'bytes':m.SPL[0],'sha256':m.SPL[1]}}))
            data['product_manifest']=m.pin(manifest)
            data['files']['agave/bin/solana']['bytes'] += 1
            with self.assertRaisesRegex(ValueError, 'actual pinned dataset'): m.stage_files(data, root)
            self.assertFalse((root / 'tools').exists())
            data['files'].pop('programs/spl_noop.so')
            with self.assertRaises(ValueError): m.stage_files(data, root)

    def test_exact_public_basic_and_composite_profiles(self):
        payer = 'E9VrvAdGRvCguN2XgXsgu9PNmMM3vZsU8LSUrM68j8ty'
        basic = m.public_profile('sealevel', payer)
        composite = m.public_profile('sealevel-composite', payer)
        self.assertEqual(basic['initial_corpus'], {'dispatches':13,'deliveries':12,'unpaid':1})
        self.assertEqual(composite['initial_corpus'], {'dispatches':2,'deliveries':2,'unpaid':0})
        self.assertEqual(len(basic['chain_names']),3)
        self.assertEqual(len(composite['chain_names']),2)
        self.assertEqual(set(basic['validator_addresses']),{'sealeveltest1'})
        self.assertEqual(basic['native_limits']['sealeveltest1']['maximum_fee'],2**64-1)
        self.assertNotIn('postgres', composite)
        self.assertNotIn('local_docker', composite)
        with self.assertRaises(ValueError): m.public_profile('evm', payer)
        with self.assertRaises(ValueError): m.public_profile('sealevel', 'foreign')

    def test_environment_requires_closed_public_source_set_and_hashes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve(); source = root/'repo';source.mkdir();records={}
            for name in m.ENVIRONMENT:
                path=source/'rust/sealevel/environments/local-e2e'/name
                path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b'public-shape-only')
                records[path.relative_to(source).as_posix()]=m.pin(path)
            verified=m.source_environment(source,records)
            self.assertEqual(set(verified),set(m.ENVIRONMENT))
            case=root/'case';case.mkdir();copies=m.stage_environment(verified,case)
            self.assertEqual(len(copies),25)
            self.assertTrue(all(Path(r['path']).stat().st_mode&0o777==0o600 for r in copies.values()))
            with self.assertRaises(ValueError):m.stage_environment(verified,case)
            name=m.ENVIRONMENT[0];Path(verified[name]['path']).write_bytes(b'changed')
            with self.assertRaises(ValueError):m.source_environment(source,records)
            with self.assertRaises(ValueError):m.stage_environment({},root/'other')

    def test_actual_source_fixture_graphs_are_two_and_one(self):
        self.assertEqual(m.fixture_roles('sealevel'),['fixture-svm-SOL','fixture-docker'])
        self.assertEqual(m.fixture_roles('sealevel-composite'),['fixture-svm-SOL'])
        with self.assertRaises(ValueError):m.fixture_roles('evm')

    def test_node_arguments_and_owned_ledger_preserve_faucet_caps(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp).resolve();ledger=root/'ledger';ledger.mkdir()
            argv=['agave','--ledger',str(ledger),'--bind-address','127.0.0.1','--rpc-port','8899',
                  '--faucet-port','9900','--gossip-port','8001','--dynamic-port-range','8002-8033',
                  '--faucet-per-time-sol-cap','0','--faucet-per-request-sol-cap','0']
            self.assertEqual(m.node_arguments(argv,root),str(ledger))
            for flag in ['--bind-address','--rpc-port','--faucet-per-request-sol-cap']:
                bad=argv[:];bad[bad.index(flag)+1]='1'
                with self.assertRaises(ValueError):m.node_arguments(bad,root)
            with self.assertRaises(ValueError):m.node_arguments(argv+['--rpc-port','8899'],root)
            bad=argv[:];bad[2]='/tmp'
            with self.assertRaises(ValueError):m.node_arguments(bad,root)

    def test_tcp_svm_loopback_and_explicit_faucet_only(self):
        rows=m.listener_rows(42,'p42\nf1\nn127.0.0.1:8899\nf2\nn127.0.0.1:8900\nf3\nn*:9900\n')
        self.assertEqual(rows,[('127.0.0.1',8899),('127.0.0.1',8900),('0.0.0.0',9900)])
        self.assertEqual(m.listener_rows(42,''),[])  # No socket is not readiness proof.
        self.assertEqual(m.listener_rows(42,'p42\nf4\nn127.0.0.1:1234\n'),[('127.0.0.1',1234)])
        for raw in ['p41\nf1\nn127.0.0.1:8899\n','p42\nn127.0.0.1:8899\n',
                    'p42\nf1\nn*:8899\n','p42\nf1\nn192.0.2.1:8899\n',
                    'p42\nf1\nn*:1234\n','p42\nf1\nf2\nn127.0.0.1:8899\n',
                    'p42\nf1\nn127.0.0.1:8899->127.0.0.1:8899\n']:
            with self.subTest(raw=raw),self.assertRaises(ValueError):m.listener_rows(42,raw)

    def test_udp_svm_gossip_range_and_remote_loopback(self):
        self.assertEqual(m.listener_rows(42,'p42\nf3\nn127.0.0.1:8001\n',True),[('127.0.0.1',8001)])
        self.assertEqual(m.listener_rows(42,'p42\nf3\nn127.0.0.1:8002->127.0.0.1:8003\n',True),[('127.0.0.1',8002)])
        for raw in ['p42\nf3\nn0.0.0.0:8001\n','p42\nf3\nn127.0.0.1:8034\n',
                    'p42\nf3\nn127.0.0.1:8001->192.0.2.1:8001\n']:
            with self.subTest(raw=raw),self.assertRaises(ValueError):m.listener_rows(42,raw,True)

    def test_listener_refusal_exports_only_typed_scope_protocol_and_ports(self):
        for raw,udp,expected in [('p42\nf3\nn*:8034\n',True,{'udp':True,'local_scope':'wildcard','local_port':8034,'connected':False,'peer_scope':None,'peer_port':None}),('p42\nf3\nn192.0.2.200:8034->192.0.2.201:8001\n',True,{'udp':True,'local_scope':'other','local_port':8034,'connected':True,'peer_scope':'other','peer_port':8001})]:
            with self.subTest(udp=udp),self.assertRaisesRegex(ValueError,'Native SVM listener escaped') as caught:m.listener_rows(42,raw,udp)
            text=str(caught.exception);self.assertEqual(json.loads(text.split(': ',1)[1]),expected)
            self.assertNotIn('192.0.2.',text);self.assertNotIn(raw,text)


if __name__ == '__main__': unittest.main()
