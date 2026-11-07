"""Starknet metadata/custody controls. No subprocess, network, node or CLI runs."""
import copy
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import struct
import tarfile
import tempfile
import unittest
from unittest import mock


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value


assets = load('native_starknet_assets')
custody = load('native_starknet_custody')


def policy(architecture='amd64'):
    target, size = assets.CLI_RELEASE[architecture]
    return {'native_cli': {'name': 'starkli', 'architecture': architecture, 'source_url': f'https://github.com/xJonathanLEI/starkli/releases/download/v0.4.1/starkli-{target}.tar.gz', 'bytes': assets.CLI_OBSERVED[architecture]['bytes'], 'sha256': assets.CLI_OBSERVED[architecture]['sha256'], 'archive': {'bytes': size, 'sha256': assets.CLI_OBSERVED[architecture]['archive_sha256'], 'publisher_digest': None, 'member': './starkli'}},
            'starknet_devnet': {'schema': 2, 'architecture': architecture, 'source_image': assets.SOURCE_IMAGE, 'image_id': 'sha256:' + 'c' * 64, 'canonical_digest': 'shardlabs/starknet-devnet-rs@sha256:' + assets.IMAGE_DIGESTS[architecture]},
            'starknet_contracts': {'release': '0.3.9', 'source_url': assets.CONTRACT_URL, 'bytes': assets.CONTRACT_BYTES, 'sha256': assets.CONTRACT_SHA, 'publisher_checksum_url': assets.CHECKSUM_URL, 'publisher_checksum_bytes': 96, 'publisher_checksum_sha256': assets.CHECKSUM_SHA, 'member_count': 558, 'member_sha256': assets.MEMBER_SHA}}


def static_elf(machine=62):
    body = bytearray(256); body[:7] = b'\x7fELF\x02\x01\x01'
    struct.pack_into('<HHIQQQIHHHHHH', body, 16, 2, machine, 1, 0x400080, 64, 0, 0, 64, 56, 1, 0, 0, 0)
    struct.pack_into('<IIQQQQQQ', body, 64, 1, 5, 0, 0x400000, 0x400000, len(body), len(body), 4096)
    return bytes(body)


def archive(body, name='./starkli', kind=tarfile.REGTYPE, extra=b''):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w', format=tarfile.USTAR_FORMAT) as source:
        row = tarfile.TarInfo(name); row.size = len(body); row.type = kind
        source.addfile(row, io.BytesIO(body))
    return gzip.compress(stream.getvalue() + extra, mtime=0)


def elf(path,needed=(),soname=None,interpreter=None,rpath=None,runpath=None,machine=62):
    strings=bytearray(b'\0');values=[]
    def add(tag,text):index=len(strings);strings.extend(text.encode()+b'\0');values.append((tag,index))
    for name in needed:add(1,name)
    for tag,value in [(14,soname),(15,rpath),(29,runpath)]:
        if value is not None:add(tag,value)
    values.extend([(5,0x400300),(10,len(strings)),(0,0)])
    count=2+(interpreter is not None);data=bytearray(0x1600)
    data[:16]=b'\x7fELF\x02\x01\x01'+b'\0'*9
    struct.pack_into('<HHIQQQIHHHHHH',data,16,3,machine,1,0x400000 if interpreter else 0,64,0,0,64,56,count,0,0,0)
    struct.pack_into('<IIQQQQQQ',data,64,1,5,0x1000,0x400000,0,0x600,0x600,0x1000)
    struct.pack_into('<IIQQQQQQ',data,120,2,4,0x1100,0x400100,0,len(values)*16,len(values)*16,8)
    if interpreter:
        wire=interpreter.encode()+b'\0';data[0x300:0x300+len(wire)]=wire;struct.pack_into('<IIQQQQQQ',data,176,3,4,0x300,0,0,len(wire),len(wire),1)
    for index,row in enumerate(values):struct.pack_into('<qQ',data,0x1100+index*16,*row)
    data[0x1300:0x1300+len(strings)]=strings;path.write_bytes(data);return path


class StarknetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ziggy-starknet-control-'); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve(); self.fixture = {**policy()['starknet_devnet'], 'run_token': 'd' * 32}
        self.rows = {}; self.calls = []; self.identity = custody.Custody(self.root, 42, 'linux-ticks:7', self.fixture, self.root, self.call)

    def row(self, port):
        bindings = {'5050/tcp': [{'HostIp': '127.0.0.1', 'HostPort': str(port)}]}
        return {'Id': ('e' if port == 5050 else 'f') * 64, 'Name': '/' + custody.expected_name(self.root, 42, port), 'Image': self.fixture['image_id'], 'Config': {'Image': self.fixture['image_id'], 'Cmd': assets.COMMAND, 'Labels': {custody.LABEL_ROOT: hashlib.sha256(bytes(self.root)).hexdigest(), custody.LABEL_PID: '42', custody.LABEL_TOKEN: self.fixture['run_token']}}, 'State': {'Running': True}, 'HostConfig': {'Memory': 2 * custody.GIB, 'MemorySwap': 2 * custody.GIB, 'NanoCpus': 2_000_000_000, 'PidsLimit': 256, 'PortBindings': bindings}, 'NetworkSettings': {'Ports': bindings}, 'Mounts': [], 'SizeRw': 4096}

    def call(self, argv, missing=False, cleaning=False):
        self.calls.append(list(argv)); target = argv[-1]
        values = [row for row in self.rows.values() if target in (row['Id'], row['Name'][1:])]
        if argv[:2] == ['container', 'inspect']:
            if not values:
                if missing: return None
                raise ValueError('missing')
            return json.dumps(values)
        self.assertEqual(len(values), 1); self.assertIn(argv[1], ('stop', 'rm'))
        # Every mutation is exact CID, never a selected name.
        self.assertEqual(target, values[0]['Id'])
        if argv[1] == 'stop': values[0]['State']['Running'] = False
        else:
            for key in list(self.rows):
                if self.rows[key]['Id'] == target: del self.rows[key]
        return ''

    def launch(self):
        self.identity.arm(); self.rows = {port: self.row(port) for port in custody.PORTS}

    def test_closed_platform_policy_preserves_distinct_image_id_and_digest(self):
        for architecture in ('amd64', 'arm64'): assets.validate_policy(policy(architecture), architecture)
        self.assertNotEqual(policy()['starknet_devnet']['image_id'].split(':')[1], assets.IMAGE_DIGESTS['amd64'])

    def test_unreviewed_missing_or_cross_platform_cli_hashes_never_admit(self):
        for change in [lambda p: p['native_cli'].update(sha256=None), lambda p: p['native_cli']['archive'].update(sha256=None), lambda p: p['native_cli'].update(source_url=policy('arm64')['native_cli']['source_url']), lambda p: p['native_cli']['archive'].update(publisher_digest='a'*64), lambda p: p['starknet_devnet'].update(canonical_digest=policy('arm64')['starknet_devnet']['canonical_digest'])]:
            value=policy(); change(value)
            with self.assertRaises((ValueError, TypeError)): assets.validate_policy(value, 'amd64')

    def test_selector_requires_explicit_platform_cli_image_and_closed_contract_policy(self):
        ci=load('native_case_ci')
        request={'schema':1,'root_approved':True,'scenario':'starknet','mode':'ReleaseSafe','producer_source_commit':'a'*40,'producer_run_id':42,'producer_run_attempt':1,'limits':dict(ci.LIMITS),'postgres':{'schema':2,'architecture':'amd64','image':'postgres:14','image_id':'sha256:'+'c'*64,'canonical_digest':'postgres@sha256:'+'d'*64},'prerequisites':{'local_checkout_build':True,'registry_commit':None,'hpack':{'version':'4.2.0','wheel_bytes':34246,'wheel_sha256':'858ac0b02280fa582b5080d68db0899c' '62a80375e0e5413a74970c5e518b6986'},**policy()},'artifact_pins':{}}
        request['artifact_pins']={key:{'id':i,'name':name,'sha256':'b'*64,'size_in_bytes':1024} for i,(key,name) in enumerate(ci.artifact_names(request).items(),1)}
        ci.validate_request(request)
        for change in [lambda r:r.update(root_approved=False),lambda r:r['prerequisites']['native_cli'].update(sha256=None),lambda r:r['prerequisites']['starknet_devnet'].update(image_id=None),lambda r:r['prerequisites'].update(registry_commit='f'*40),lambda r:r['limits'].update(maximum_wall_seconds=3601)]:
            value=copy.deepcopy(request);change(value)
            with self.assertRaises((ValueError,TypeError)):ci.validate_request(value)

    def test_version_parser_accepts_qualified_actual_bare_output(self):
        raw=b'0.4.1 (b4223ee)\n'
        self.assertEqual(len(raw),16)
        self.assertEqual(hashlib.sha256(raw).hexdigest(),'72c2316902c94439b999dd710ad98e9b' '717c3ee65609a67f3dab1b8648e94b3d')
        self.assertEqual(assets.parse_cli_version(raw),{'version':'0.4.1','build_commit':'b4223ee'})

    def test_version_parser_rejects_wrong_version_build_or_format(self):
        for raw in [b'0.4.0 (b4223ee)\n',b'0.4.2 (b4223ee)\n',b'0.4.1 (abcdef0)\n',b'0.4.1 (invalid)\n',b'0.4.1 (b4223ee00)\n',b'0.4.1\n',b'starkli 0.4.1 (b4223ee)\n','0.4.1 (b4223ee)\n']:
            with self.subTest(raw=raw),self.assertRaises(ValueError):assets.parse_cli_version(raw)

    def test_version_parser_rejects_trailing_output_and_whitespace(self):
        for raw in [b'0.4.1 (b4223ee)\nextra\n',b'0.4.1 (b4223ee)\n\n',b'0.4.1 (b4223ee) \n',b' 0.4.1 (b4223ee)\n',b'0.4.1 (b4223ee)',b'0.4.1 (b4223ee)\r\n',b'0.4.1 (b4223ee)\n\x00']:
            with self.subTest(raw=raw),self.assertRaises(ValueError):assets.parse_cli_version(raw)

    def test_pinned_member_hash_stays_required_with_valid_version(self):
        assets.parse_cli_version(b'0.4.1 (b4223ee)\n')
        value=policy();value['native_cli']['sha256']='f'*64
        with self.assertRaises(ValueError):assets.validate_policy(value,'amd64')

    def test_image_source_tag_retag_platform_and_volume_reject(self):
        expected=policy()['starknet_devnet']; row={'Id':expected['image_id'],'Os':'linux','Architecture':'amd64','RepoDigests':[expected['canonical_digest']],'Config':{}}
        assets.image_inspect([row,copy.deepcopy(row)],expected)
        for field,value in [('Id','sha256:'+'a'*64),('Architecture','arm64'),('Os','darwin'),('Config',{'Volumes':{'/unbounded':{}}})]:
            changed=copy.deepcopy(row);changed[field]=value
            with self.assertRaises(ValueError):assets.image_inspect([row,changed],expected)

    def test_cli_tar_exact_member_and_elf(self):
        body=static_elf(); wire=archive(body); p=policy()['native_cli'];p.update(bytes=len(body),sha256=hashlib.sha256(body).hexdigest());p['archive'].update(bytes=len(wire),sha256=hashlib.sha256(wire).hexdigest())
        self.assertEqual(assets.cli_member(wire,p),body)
        changed=wire[:-1]+bytes([wire[-1]^1])
        with self.assertRaises(ValueError):assets.cli_member(changed,p)
        p['architecture']='arm64'
        with self.assertRaises(ValueError):assets.cli_member(wire,p)

    def test_tar_link_traversal_second_archive_and_hidden_padding_reject(self):
        body=static_elf()
        for wire in [archive(body,'../starkli'),archive(body,'./starkli',tarfile.SYMTYPE),archive(body,extra=b'X'*512),archive(body)+archive(body)]:
            p=policy()['native_cli'];p.update(bytes=len(body),sha256=hashlib.sha256(body).hexdigest());p['archive'].update(bytes=len(wire),sha256=hashlib.sha256(wire).hexdigest())
            with self.assertRaises((ValueError,tarfile.TarError,EOFError)):assets.cli_member(wire,p)

    def test_actual_static_header_inspection_never_invents_dynamic_libraries(self):
        path=self.root/'starkli';path.write_bytes(static_elf())
        graph=assets.cli_loader(path,'amd64',lambda *a,**k:self.fail('static ELF must not call dynamic parser'),lambda n:self.fail('no static loader'))
        self.assertIsNone(graph['interpreter']);self.assertEqual(graph['files'],{})
        assets.validate_cli_loader(graph,path,'amd64')
        path.write_bytes(static_elf(183))
        with self.assertRaises(ValueError):assets.validate_cli_loader(graph,path,'amd64')

    def test_dynamic_cli_actual_needed_graph_and_exact_libc_interpreter_context(self):
        interpreter=elf(self.root/'ld-linux-x86-64.so.2')
        libc=elf(self.root/'libc.so.6',needed=[interpreter.name],soname='libc.so.6',interpreter=str(interpreter))
        cli=elf(self.root/'starkli',needed=[libc.name],interpreter=str(interpreter))
        graph=assets.cli_loader(cli,'amd64',assets.elf_dynamic,lambda name:libc)
        self.assertEqual(set(graph['files']),{libc.name,interpreter.name})
        assets.validate_cli_loader(graph,cli,'amd64')
        with self.assertRaises(ValueError):assets.elf_dynamic(libc,62)
        foreign=elf(self.root/'foreign-interpreter')
        with self.assertRaises(ValueError):assets.elf_dynamic(libc,62,system_libc_interpreter=foreign)
        other=elf(self.root/'foreign.so',soname='foreign.so',interpreter=str(interpreter))
        with self.assertRaises(ValueError):assets.elf_dynamic(other,62,system_libc_interpreter=interpreter)

    def test_dynamic_rpath_or_wrong_soname_never_become_pinned_loader(self):
        interpreter=elf(self.root/'ld-linux-x86-64.so.2')
        libc=elf(self.root/'libc.so.6',soname='libc.so.6')
        for key in ('rpath','runpath'):
            cli=elf(self.root/'starkli',needed=['libc.so.6'],interpreter=str(interpreter),**{key:'$ORIGIN/foreign'})
            with self.assertRaises(ValueError):assets.cli_loader(cli,'amd64',assets.elf_dynamic,lambda name:libc)
        cli=elf(self.root/'starkli',needed=['libc.so.6'],interpreter=str(interpreter))
        elf(libc,soname='foreign.so')
        with self.assertRaises(ValueError):assets.cli_loader(cli,'amd64',assets.elf_dynamic,lambda name:libc)

    def test_source_fixture_waits_require_three_clean_actual_parent_waits(self):
        owner=load('native_case_owner');path=self.root/'waits.jsonl'
        rows=[{'pid':pid,'parent_pid':42,'role':'fixture-docker','parent_wait_completed':True,'forced_kill':False,'purpose':'fixture_teardown','already_exited':False,'success':True,'exit_code':0,'signal':None} for pid in (43,44,45)]
        def write(value):path.write_text(''.join(json.dumps(r)+'\n' for r in value))
        write(rows);self.assertEqual(len(owner.fixture_waits(path,'starknet',42)),3)
        for key,value in [('success',False),('exit_code',1),('signal',15),('already_exited',True),('parent_wait_completed',False)]:
            changed=copy.deepcopy(rows);changed[0][key]=value;write(changed)
            with self.assertRaises(ValueError):owner.fixture_waits(path,'starknet',42)

    def test_changed_pre_go_context_blocks_both_name_and_cid_mutation(self):
        self.launch();path=self.root/'starknet-armed.json';value=json.loads(path.read_text());value['run_token']='foreign';path.write_text(json.dumps(value))
        report=self.identity.cleanup();self.assertFalse(report['container_absent']);self.assertEqual(set(self.rows),{5050,5070})
        self.assertFalse(any(call[1] in ('stop','rm') for call in self.calls))

    def test_arm_requires_both_names_absent_before_go(self):
        self.rows[5050]=self.row(5050)
        with self.assertRaises(ValueError):self.identity.arm()
        self.assertFalse((self.root/'starknet-armed.json').exists());self.assertFalse(any(call[1] in ('stop','rm') for call in self.calls))

    def test_two_cids_readiness_and_exact_cleanup(self):
        self.launch();self.assertEqual(self.identity.observe(),8192);self.assertEqual(set(self.identity.ready),{5050,5070})
        report=self.identity.cleanup();self.assertTrue(report['container_absent']);self.assertFalse(report['native_parent_wait_credit']);self.assertFalse(self.rows)

    def test_setup_crash_before_first_poll_still_recovers_positive_labels(self):
        self.launch()
        reopened=custody.Custody(self.root,42,'linux-ticks:7',self.fixture,self.root,self.call)
        result=reopened.cleanup();self.assertTrue(result['container_absent']);self.assertEqual(len([r for r in result['containers'] if r['container_id']]),2)

    def test_source_planned_stop_allows_normal_teardown_without_new_readiness_credit(self):
        self.launch();self.identity.observe();directory=self.root/'evidence';directory.mkdir()
        row={'kind':'starknet','port':5050,'pid':43,'parent_pid':42,'container_id':'e'*64,'pre_stop_live_identity':'actual-child-token','acceptance_failed_before_cleanup':False}
        (directory/'fixture-container-stop-intents.jsonl').write_text(json.dumps(row)+'\n')
        self.rows[5050]['State']['Running']=False;self.rows[5050]['NetworkSettings']['Ports']={}
        self.identity.observe();self.assertEqual(self.identity.ready[5050],'e'*64)
        del self.rows[5050];self.identity.observe()
        self.assertTrue(self.identity.cleanup()['container_absent'])

    def test_unexpected_death_or_unbound_planned_stop_cannot_soften_health(self):
        self.launch();self.identity.observe();del self.rows[5050]
        with self.assertRaises(ValueError):self.identity.observe()
        directory=self.root/'evidence';directory.mkdir()
        row={'kind':'starknet','port':5050,'pid':43,'parent_pid':42,'container_id':'e'*64,'pre_stop_live_identity':'actual-child-token','acceptance_failed_before_cleanup':False}
        for key,value in [('container_id','a'*64),('parent_pid',99),('pre_stop_live_identity',''),('acceptance_failed_before_cleanup',True)]:
            changed=dict(row);changed[key]=value;(directory/'fixture-container-stop-intents.jsonl').write_text(json.dumps(changed)+'\n')
            with self.assertRaises(ValueError):self.identity.observe()

    def test_bad_caps_or_unhealthy_fail_acceptance_but_not_owned_cleanup(self):
        for mutation in ('caps','health'):
            with self.subTest(mutation=mutation):
                # Each branch uses its own first-CID files.
                output=self.root/mutation;output.mkdir();identity=custody.Custody(self.root,42,'linux-ticks:7',self.fixture,output,self.call)
                self.rows={};identity.arm();self.rows={port:self.row(port) for port in custody.PORTS}
                if mutation=='caps':self.rows[5050]['HostConfig']['Memory']=0
                else:self.rows[5050]['State']['Running']=False
                with self.assertRaises(ValueError):identity.observe()
                self.assertTrue((output/'starknet-5050-cid.json').exists());self.assertTrue(identity.cleanup()['container_absent'])

    def test_foreign_identity_is_never_mutated_and_other_owned_node_is_cleaned(self):
        self.launch();self.rows[5050]['Config']['Labels'][custody.LABEL_TOKEN]='foreign'
        report=self.identity.cleanup();self.assertFalse(report['container_absent']);self.assertIn(5050,self.rows);self.assertNotIn(5070,self.rows)
        self.assertFalse(any(call[1] in ('stop','rm') and call[-1]=='e'*64 for call in self.calls))

    def test_changed_cid_image_root_pid_name_or_token_reject(self):
        row=self.row(5050)
        mutations=[lambda r:r.update(Id='b'*64),lambda r:r.update(Image='sha256:'+'b'*64),lambda r:r.update(Name='/foreign')]
        mutations += [lambda r,key=key:r['Config']['Labels'].update({key:'foreign'}) for key in (custody.LABEL_ROOT,custody.LABEL_PID,custody.LABEL_TOKEN)]
        for change in mutations:
            changed=copy.deepcopy(row);change(changed)
            with self.assertRaises(ValueError):custody.ownership(changed,self.root,42,self.fixture,5050,'e'*64)

    def test_first_cid_is_atomic_and_immutable_across_recovery(self):
        path=self.root/'cid.json';value={'container_id':'e'*64}
        with mock.patch.object(custody.os,'link',side_effect=OSError('crash before publish')):
            with self.assertRaises(OSError):custody.publish_first(path,value)
        self.assertFalse(path.exists());custody.publish_first(path,value);inode=path.stat().st_ino
        custody.publish_first(path,value);self.assertEqual(path.stat().st_ino,inode)
        with self.assertRaises(ValueError):custody.publish_first(path,{'container_id':'f'*64})

    def test_malformed_first_cid_refuses_that_mutation_and_attempts_other_node(self):
        self.launch();(self.root/'starknet-5050-cid.json').write_bytes(b'{')
        report=self.identity.cleanup();self.assertFalse(report['container_absent']);self.assertIn(5050,self.rows);self.assertNotIn(5070,self.rows)

    def test_stop_failure_does_not_skip_other_node_cleanup(self):
        self.launch();original=self.identity.call
        def failed(argv,**kwargs):
            if argv[1]=='stop' and argv[-1]=='e'*64:raise ValueError('actual stop failed')
            return original(argv,**kwargs)
        self.identity.call=failed;report=self.identity.cleanup()
        self.assertFalse(report['container_absent']);self.assertIn(5050,self.rows);self.assertNotIn(5070,self.rows)

    def test_mounts_nonloopback_or_unbounded_size_reject_readiness(self):
        for mutate in [lambda r:r.update(Mounts=[{'Source':'/foreign'}]),lambda r:r['HostConfig'].update(Binds=['/foreign:/data']),lambda r:r['NetworkSettings']['Ports']['5050/tcp'][0].update(HostIp='0.0.0.0'),lambda r:r.update(SizeRw=None)]:
            row=copy.deepcopy(self.row(5050));mutate(row)
            with self.assertRaises(ValueError):custody.readiness(row,self.fixture,5050)

    def test_resource_charge_reserves_five_gib_and_conservative_host_drop(self):
        ram,disk=custody.resource_charge(3*custody.GIB,1024,20*custody.GIB,19*custody.GIB)
        self.assertEqual(ram,8*custody.GIB);self.assertEqual(disk,3*custody.GIB)
        self.assertGreater(custody.resource_charge(3*custody.GIB+1,0,20*custody.GIB,20*custody.GIB)[0],8*custody.GIB)
        self.assertGreater(custody.resource_charge(0,0,20*custody.GIB,17*custody.GIB)[1],4*custody.GIB)
        self.assertGreater(custody.resource_charge(0,0,20*custody.GIB,20*custody.GIB,3*custody.GIB)[1],4*custody.GIB)

    def test_profile_uses_source_corpus_loopback_and_no_igp_credit(self):
        spec=importlib.util.spec_from_file_location('starknet_profile',Path(__file__).resolve().parents[1]/'integration/native_case_inputs.py');profile=importlib.util.module_from_spec(spec);spec.loader.exec_module(profile)
        case=profile.public_profile('starknet');self.assertEqual(case['initial_corpus']['dispatches'],10);self.assertEqual(case['initial_corpus']['deliveries'],10);self.assertFalse(case['payments_supported']);self.assertEqual(set(map(int,case['domain_names'])),{23448593,23448594})


if __name__=='__main__':unittest.main()
