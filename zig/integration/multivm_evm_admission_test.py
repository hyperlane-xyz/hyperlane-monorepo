"""EVM family dispatch/admission controls; no SDK, nodes or daemon processes."""
import copy
import hashlib
import json
import tempfile
import threading
import types
import importlib.util
import pathlib
import unittest
from unittest import mock
import multivm_runtime_test as runtime_controls

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("multivm_evm_admission", HERE / "multivm_process.py")
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


# This existing CI entrypoint discovers only the pure parent-wait class, not
# RuntimeTests or the explicit-loopback transport classes in its module.
class EvmSourceParentWaitTests(runtime_controls.ParentWaitTests):
    pass


class EvmAdmission(unittest.TestCase):
    def test_registry_and_construction_do_not_grant_execution(self):
        self.assertTrue({"cosmosnative", "evm", "cosmwasm"} <= set(api.FAMILY_VERIFIERS))
        self.assertIs(api.FAMILY_VERIFIERS["evm"], api.session_verifier)
        with mock.patch.object(api, "validate_manifest"):
            result = api.construction_plan({"scenario": "evm", "runtime_source_commit": "a" * 40, "mode": "ReleaseSafe", "artifacts": {}, "harness_deadline_seconds": 3600}, "evm")
        self.assertIs(result["family_verifier_implemented"], True)
        self.assertIs(result["execution_authorized_by_preparation"], False)
        self.assertIs(result["passed"], False)
        self.assertEqual((result["actual_production_confirm_seconds"], result["actual_production_finality_grace_seconds"]), (600, 30))

    def test_evm_route_requires_actual_parent_and_strict_verified_boolean(self):
        value = {"scenario": "evm"}
        for reply, expected in [({"verified": True}, True), ({"verified": False}, False), ({"verified": 1}, False), ({"verified": "true"}, False), ({"passed": True}, False)]:
            with self.subTest(reply=reply), mock.patch.object(api, "validate_manifest") as validate, mock.patch.object(api.multivm_evidence, "verify_harness_parent", return_value={"pid": 11}) as parent, mock.patch.object(api, "controller_request", return_value=reply) as controller:
                self.assertIs(api.verify_stage(value, "live", 20), expected)
                validate.assert_called_once_with(value)
                self.assertEqual(parent.call_count, 2)
                controller.assert_called_once_with(value, "verify", {"stage": "live", "expected": 20, "harness_parent": {"pid": 11}})

    def test_wrong_parent_and_missing_approval_fail_before_effects(self):
        value = {"scenario": "evm"}
        with mock.patch.object(api, "validate_manifest"), mock.patch.object(api.multivm_evidence, "verify_harness_parent", side_effect=ValueError("wrong executable")), mock.patch.object(api, "controller_request") as controller:
            with self.assertRaisesRegex(ValueError, "wrong executable"):
                api.verify_stage(value, "preflight", 0)
            controller.assert_not_called()
        with mock.patch.object(api.multivm_evidence, "read_approval", side_effect=ValueError("execution approval missing")), mock.patch.object(api.multivm_session, "Session") as session:
            with self.assertRaisesRegex(ValueError, "approval missing"):
                api.serve(value)
            session.assert_not_called()

    def test_controller_refusal_and_bad_stage_count_remain_hard(self):
        value = {"scenario": "evm"}
        with mock.patch.object(api, "validate_manifest"), mock.patch.object(api.multivm_evidence, "verify_harness_parent"), mock.patch.object(api, "controller_request", side_effect=ValueError("observer refused")):
            with self.assertRaisesRegex(ValueError, "observer refused"):
                api.verify_stage(value, "final", 20)
        for stage, count in [("unreviewed", 20), ("live", True), ("live", -1)]:
            with self.subTest(stage=stage, count=count), mock.patch.object(api, "validate_manifest"), mock.patch.object(api, "controller_request") as controller:
                with self.assertRaises(ValueError):
                    api.verify_stage(value, stage, count)
                controller.assert_not_called()


class EvmConfiguredDepth(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="ziggy-evm-depth-pure-")
        self.addCleanup(directory.cleanup)
        self.root = pathlib.Path(directory.name).resolve()
        (self.root / "config").mkdir()
        self.chain = {"name": "test1", "protocol": "ethereum", "domainId": 9913371, "mailbox": "0x" + "11" * 20, "merkleTreeHook": "0x" + "22" * 20, "interchainGasPaymaster": "0x" + "33" * 20, "rpcUrls": [{"http": "http://127.0.0.1:8545"}]}
        (self.root / "config/test.json").write_text(json.dumps({"chains": {"test1": self.chain}}))
        case = self.root / "case.json"
        case.write_text(json.dumps({"schema": 1, "scenario": "evm", "chain_names": ["test1"]}))
        self.manifest = {"scenario": "evm", "runtime_source_commit": "a" * 40, "task_root": str(self.root), "case_inputs": {"path": str(case), "bytes": case.stat().st_size, "sha256": hashlib.sha256(case.read_bytes()).hexdigest()}}
        cast = self.root / "synthetic-cast"
        cast.write_bytes(b"public synthetic verifier fixture; never executed")
        cast.chmod(0o700)
        self.manifest["verifier_tools"] = {"cast": {"path": str(cast), "bytes": cast.stat().st_size, "sha256": hashlib.sha256(cast.read_bytes()).hexdigest()}}
        checkpoints = self.root / "checkpoints"
        checkpoints.mkdir()
        self.request = {"schema": 1, "scenario": "evm", "runtime_source_commit": "a" * 40, "role": "validator", "harness_pid": 42, "cwd": str(self.root), "environment": {"HYP_ORIGINCHAINNAME": "test1", "HYP_CHAINS_TEST1_BLOCKS_REORGPERIOD": "0", "HYP_CHECKPOINTSYNCER_TYPE": "localStorage", "HYP_CHECKPOINTSYNCER_PATH": str(checkpoints)}, "arguments": [], "selected_chain_names": ["test1"]}
        self.session = api.multivm_session.Session.__new__(api.multivm_session.Session)
        self.session.manifest = self.manifest
        self.session.family = None
        self.session.case = {"validator_addresses": {"test1": "0x" + "44" * 20}}
        self.session._owned_path = api.checked_owned_path

    def test_actual_validator_env_decimal_string_reaches_checkpoint_adapter_without_mutating_capture(self):
        captured = api.multivm_evidence.effective_config(self.request, self.manifest)
        self.assertEqual(captured["chains"]["test1"]["blocks"]["reorgperiod"], "0")
        original = copy.deepcopy(captured)
        self.session.captures = [{"original": captured, "proxied": copy.deepcopy(captured)}]
        adapters = []
        actual_adapter = self.session.adapter
        def constructed_adapter(chain):
            adapter = actual_adapter(chain)
            adapter.command = mock.Mock(return_value="0x" + "ab" * 32)
            adapters.append(adapter)
            return adapter
        def checkpoint_boundary(*args, **kwargs):
            keccak = args[4]
            self.assertEqual(keccak("0x01"), "0x" + "ab" * 32)
            self.assertEqual(keccak("0x01"), "0x" + "ab" * 32)
            return {"fixture_checkpoint_crypto_boundary": True}
        with mock.patch.object(self.session, "adapter", side_effect=constructed_adapter), mock.patch.object(api.multivm_session, "verify_checkpoint_objects", side_effect=checkpoint_boundary) as verify:
            self.session.checkpoint_proofs({"messages": []})
        verify.assert_called_once()
        self.assertEqual([adapter.reorg_depth for adapter in adapters], [0])
        adapters[0].command.assert_called_once_with("keccak", "0x01")
        self.assertEqual(captured, original)

    def test_configured_numeric_string_depth_preserves_exact_receipt_finality_fence(self):
        tx, block_hash = "0x" + "aa" * 32, "0x" + "bb" * 32
        receipt = {"transactionHash": tx, "status": "0x1", "blockNumber": "0x5", "blockHash": block_hash, "transactionIndex": "0x0", "logs": [], "gasUsed": "0x10", "effectiveGasPrice": "0x2"}
        block = {"number": "0x5", "hash": block_hash, "transactions": [tx]}
        transaction = {"hash": tx, "blockHash": block_hash, "blockNumber": "0x5", "transactionIndex": "0x0"}
        for depth in (2, "2", "0002"):
            chain = dict(self.chain, rpcurls=self.chain["rpcUrls"], blocks={"reorgperiod": depth})
            adapter = self.session.adapter(chain)
            self.assertEqual(adapter.reorg_depth, 2)
            values = {"eth_getTransactionReceipt": receipt, "eth_getBlockByNumber": block, "eth_getTransactionByHash": transaction, "eth_blockNumber": "0x6"}
            adapter.call = lambda method, params: copy.deepcopy(values[method])
            with self.assertRaisesRegex(ValueError, "configured finality"):
                adapter.canonical_receipt(tx)
            values["eth_blockNumber"] = "0x7"
            self.assertEqual(adapter.canonical_receipt(tx)["tokens_used"], 32)

    def test_config_boundary_refuses_invalid_depth_and_keeps_typed_adapter_strict(self):
        for depth in (True, False, None, -1, 1.0, float("inf"), float("nan"), 2**32, str(2**32), "9" * 100, "-1", "+1", " 1", "1 ", "0x1", "1_0", "1.0", "latest", "safe", "finalized", "earliest", "pending", "", "١", [], {}):
            with self.subTest(depth=depth), self.assertRaisesRegex(ValueError, "finality depth"):
                self.session.adapter(dict(self.chain, rpcurls=self.chain["rpcUrls"], blocks={"reorgperiod": depth}))
        for depth in (0, 2**32 - 1, "0", str(2**32 - 1)):
            self.assertEqual(self.session.adapter(dict(self.chain, rpcurls=self.chain["rpcUrls"], blocks={"reorgperiod": depth})).reorg_depth, int(depth))
        with self.assertRaisesRegex(ValueError, "finality depth"):
            api.multivm_session.EvmEvidence({}, "unused", reorg_depth="1")


class NativeProviderLifecycle(unittest.TestCase):
    def setUp(self):
        # Reuse actual layered-config fixture; no nodes, sockets or agents.
        self.fixture = EvmConfiguredDepth()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.session = self.fixture.session
        self.session.approval = {"harness": {"fixture": True}}
        self.session.lock = threading.RLock()
        self.session.failures = []
        self.session.proxy_cache = {}
        self.next_proxy_port = 20000
        self.identity = {"pid": 42}
        self.request = dict(self.fixture.request, role="relayer", environment={"HYP_RELAYCHAINS": "test1", "HYP_METRICSPORT": "9092", "HYP_CHAINS_TEST1_CUSTOMRPCURLS": "http://127.0.0.1:8545,http://127.0.0.1:8545,http://127.0.0.1:8546"})
        self.capture()

    def capture(self):
        original = api.multivm_evidence.effective_config(self.request, self.fixture.manifest)
        self.install(original)

    def install(self, original):
        replacements = {}
        for name, chain in original["chains"].items():
            for field in api.multivm_evidence.ENDPOINT_FIELDS & chain.keys():
                replacements[name, field] = []
                for source in api.multivm_evidence.urls(chain[field]):
                    key = ("relayer", name, field, source)
                    if key not in self.session.proxy_cache:
                        endpoint = "http://127.0.0.1:" + str(self.next_proxy_port)
                        self.next_proxy_port += 1
                        self.session.proxy_cache[key] = types.SimpleNamespace(endpoint=endpoint)
                    replacements[name, field].append(self.session.proxy_cache[key].endpoint)
        _, proxied = api.multivm_evidence.endpoint_replacements(original, replacements)
        self.row = {"original": original, "proxied": proxied}
        self.session.captures = [self.row]

    def observe(self, created=4, dropped=0, **changes):
        payload = dict(chain="test1", metrics_port=9092, created=created, dropped=dropped, harness_parent=self.identity)
        payload.update(changes)
        with mock.patch.object(api.multivm_session, "read_approval") as approval, mock.patch.object(api.multivm_session, "verified_harness_identity", return_value=self.identity) as identity:
            result = self.session.provider_metrics(payload)
        approval.assert_called_once_with(self.session.manifest)
        identity.assert_called_once_with(self.session.manifest, self.session.approval, self.identity)
        return result

    def test_actual_config_custom_override_pool_dedup_and_active_lifecycle(self):
        before = copy.deepcopy(self.row)
        # Default RPC field is present but overridden, and duplicate custom
        # URLs resolve to one actual proxy/Pool identity, not extra providers.
        self.assertEqual(self.observe()["minimum_active"], 2)
        self.assertTrue(self.observe(created=4, dropped=2)["verified"])
        self.assertFalse(self.observe(created=4, dropped=3)["verified"])
        self.assertFalse(self.observe(created=0)["verified"])
        underflow = self.observe(created=1, dropped=2)
        self.assertIsNone(underflow["active"])
        self.assertFalse(underflow["verified"])
        self.assertEqual(self.row, before)

    def test_single_fallback_quorum_and_distinct_endpoint_identity(self):
        for strategy, floor in [("single", 1), ("fallback", 2), ("quorum", 2)]:
            with self.subTest(strategy=strategy):
                self.request["environment"]["HYP_CHAINS_TEST1_RPCCONSENSUSTYPE"] = strategy
                self.capture()
                self.assertEqual(self.observe()["minimum_active"], floor)
        self.row["proxied"]["chains"]["test1"]["customrpcurls"] += ",http://127.0.0.1:39999"
        with self.assertRaises(ValueError):
            self.observe()

    def test_only_latest_actual_relayer_chain_port_and_harness_are_counted(self):
        for change in [{"chain": "unrelated"}, {"metrics_port": 9093}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.observe(**change)
        original = self.row["original"]
        for key, value in [("harness_pid", 99), ("role_chain_names", ["other"])]:
            old = original[key]
            original[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.observe()
            original[key] = old
        unrelated = copy.deepcopy(self.row)
        unrelated["original"]["role"] = "scraper"
        unrelated["proxied"]["chains"]["test1"]["customrpcurls"] = "http://127.0.0.1:39999"
        self.session.captures.append(unrelated)
        self.assertEqual(self.observe()["minimum_active"], 2)
        newer = copy.deepcopy(self.row)
        newer["original"]["metrics_port"] = 9093
        self.session.captures.append(newer)
        with self.assertRaisesRegex(ValueError, "ownership"):
            self.observe()
        self.session.captures = [unrelated]
        with self.assertRaisesRegex(ValueError, "capture missing"):
            self.observe()

    def test_unowned_proxy_and_unknown_strategy_cannot_supply_floor(self):
        key = next(key for key in self.session.proxy_cache if key[2] == "customrpcurls")
        del self.session.proxy_cache[key]
        with self.assertRaisesRegex(ValueError, "owned proxy"):
            self.observe()
        self.capture()
        self.row["proxied"]["chains"]["test1"]["rpcconsensustype"] = "unknown"
        with self.assertRaisesRegex(ValueError, "strategy"):
            self.observe()
        self.session.failures.append("synthetic prior failure")
        with self.assertRaisesRegex(ValueError, "observer failed"):
            self.observe()

    def test_svm_pool_and_cosmos_grpc_wrapper_counts_remain_distinct(self):
        for protocol, floor in [("sealevel", 2), ("cosmos", 5), ("cosmosnative", 5)]:
            original = copy.deepcopy(self.row["original"])
            chain = original["chains"]["test1"]
            chain["protocol"] = protocol
            if protocol.startswith("cosmos"):
                chain["grpcurls"] = [{"http": "http://127.0.0.1:30001"}]
                chain["customgrpcurls"] = "http://127.0.0.1:30002,http://127.0.0.1:30002,http://127.0.0.1:30003"
            self.install(original)
            with self.subTest(protocol=protocol):
                self.assertEqual(self.observe(created=10)["minimum_active"], floor)

    def test_invalid_counter_types_and_ranges_do_not_gain_credit(self):
        for value in [True, False, -1, 2**32, 1.0, "4", None]:
            for field in ["created", "dropped"]:
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                    self.observe(**{field: value})
        for value in [True, 0, 65536, "9092"]:
            with self.subTest(port=value), self.assertRaises(ValueError):
                self.observe(metrics_port=value)

    def test_controller_action_authenticates_parent_and_passes_only_actual_operands(self):
        value = {"scenario": "evm"}
        with mock.patch.object(api, "validate_manifest") as validate, mock.patch.object(api.multivm_evidence, "verify_harness_parent", return_value=self.identity) as parent, mock.patch.object(api, "controller_request", return_value={"verified": True}) as request:
            self.assertTrue(api.provider_metrics_stage(value, "test1", 9092, 4, 1))
            validate.assert_called_once_with(value)
            parent.assert_called_once_with(value)
            request.assert_called_once_with(value, "provider-metrics", {"chain": "test1", "metrics_port": 9092, "created": 4, "dropped": 1, "harness_parent": self.identity})
        for reply in [{"verified": 1}, {"verified": "true"}, {"verified": False}]:
            with mock.patch.object(api, "validate_manifest"), mock.patch.object(api.multivm_evidence, "verify_harness_parent", return_value=self.identity), mock.patch.object(api, "controller_request", return_value=reply):
                self.assertFalse(api.provider_metrics_stage(value, "test1", 9092, 4, 1))
        with mock.patch.object(api, "validate_manifest"), mock.patch.object(api.multivm_evidence, "verify_harness_parent", side_effect=ValueError("wrong parent")), mock.patch.object(api, "controller_request") as request:
            with self.assertRaisesRegex(ValueError, "wrong parent"):
                api.provider_metrics_stage(value, "test1", 9092, 4, 1)
            request.assert_not_called()


class RetiredEvmCheckpointTests(unittest.TestCase):
    hashed = staticmethod(runtime_controls.CheckpointObservationHashControls.hashed)

    def fixture(self, leaves=2):
        temporary = tempfile.TemporaryDirectory(prefix='retired-checkpoint-pure-')
        self.addCleanup(temporary.cleanup)
        root = pathlib.Path(temporary.name).resolve()
        session = runtime_controls.Session.__new__(runtime_controls.Session)
        session.family = None
        session.evidence_relative = pathlib.Path('evidence')
        (root / 'evidence').mkdir()
        tool = root / 'cast-public-fixture'
        tool.write_bytes(b'synthetic never-executed verifier')
        tool.chmod(0o700)
        artifact = {'path': str(tool), 'bytes': tool.stat().st_size, 'sha256': hashlib.sha256(tool.read_bytes()).hexdigest()}
        session.manifest = {'scenario': 'evm', 'task_root': str(root), 'runtime_source_commit': 'a' * 40,
            'verifier_tools': {'cast': artifact}, 'artifacts': dict.fromkeys(['validator', 'relayer', 'scraper'], artifact)}
        session._owned_path = api.checked_owned_path
        session.adapter = lambda chain: type('PureHash', (), {'keccak': staticmethod(self.hashed)})()
        names = ['test1', 'test2', 'test3']
        session.case = {'reorg_origin_chain': 'test1', 'domain_names': {str(9913371 + i): n for i, n in enumerate(names)}, 'validator_addresses': {}}
        captures, messages, directories, chains, secrets = [], [], {}, {}, {}
        for i, name in enumerate(names):
            secret = i + 1  # Explicit public synthetic scalars, never a production key.
            point = runtime_controls.evm.point_multiply(secret, runtime_controls.evm.SECP_G)
            public = '0x' + point[0].to_bytes(32, 'big').hex() + point[1].to_bytes(32, 'big').hex()
            signer = '0x' + bytes.fromhex(self.hashed(public)[2:])[12:].hex()
            session.case['validator_addresses'][name] = signer
            directory = root / name
            directory.mkdir()
            directories[name], secrets[name] = directory, secret
            chain = {'name': name, 'domainid': 9913371 + i, 'merkletreehook': '0x' + format(0x12 + i, '02x') * 20}
            chains[name] = chain
            selected = [{'id': '0x' + format((i + 1) * 100 + k, '064x'), 'origin_chain': name, 'insertions': [k]} for k in range(leaves)]
            messages.extend(selected)
            metadata = {'git_sha': 'a' * 40, 'rpcs': [{'url_hash': self.hashed('http://127.0.0.1:1'), 'host_hash': self.hashed('127.0.0.1')}], 'allows_public_rpcs': False}
            (directory / 'metadata_latest.json').write_text(json.dumps(metadata))
            for checkpoint in runtime_controls.evm.merkle_roots(selected, self.hashed):
                self.publish(directory, chain, checkpoint, secret)
            original = {'role': 'validator', 'role_chain_names': [name], 'checkpoint_syncer': {'type': 'localStorage', 'path': str(directory)}, 'chains': {name: chain}, 'allows_public_rpcs': False}
            captures.append({'original': original, 'proxied': {'chains': {name: {'rpcurls': 'http://127.0.0.1:1'}}}})
        captures.extend([{'original': {'role': 'relayer'}, 'proxied': {}}, {'original': {'role': 'scraper'}, 'proxied': {}}])
        session.captures = captures
        initial = session.checkpoint_proofs({'messages': messages})
        session.initial = {'capture_count': 5, 'checkpoint_proofs': initial}
        session.after_restart, session.restart = {}, {}
        session.captures = captures + copy.deepcopy(captures) + [{'original': {'role': 'relayer'}, 'proxied': {}}]
        launches, exits = [], []
        for i, capture in enumerate(session.captures):
            role = capture['original']['role']
            row = {'pid': i + 100, 'parent_pid': 90, 'role': role, 'executable': artifact, 'os_start_token': 'synthetic-start-' + str(i)}
            purpose = 'same_db_restart' if i < 5 else 'intentional_reorg' if i == 5 else 'intentional_restart' if i == 8 else 'final'
            planned = purpose.startswith('intentional_')
            launches.append(row)
            exits.append(dict(row, purpose=purpose, parent_wait_completed=True, already_exited=False, forced_kill=False, success=not planned, exit_code=None if planned else 0, signal=9 if planned else None, planned_exit=planned))
        runtime_controls.ParentWaitTests.write(session, launches, exits)
        flag = directories['test1'] / 'reorg_flag.json'
        flag.write_text(json.dumps({'local_merkle_root': '0x' + '00' * 32, 'canonical_merkle_root': '0x' + '00' * 32, 'checkpoint_index': 0, 'unix_timestamp': 0, 'reorg_period': 0}, separators=(',', ':')))
        extra = {'id': '0x' + format(999, '064x'), 'origin_chain': 'test1', 'insertions': [leaves]}
        snapshot = {'messages': [*messages, extra], 'parent_wait_receipts': copy.deepcopy(exits)}
        return session, snapshot, directories, chains, secrets, launches, exits

    @classmethod
    def publish(cls, directory, chain, row, secret):
        checkpoint = {'merkle_tree_hook_address': '0x' + '00' * 12 + chain['merkletreehook'][2:], 'mailbox_domain': chain['domainid'], 'root': row['root'], 'index': row['index']}
        digest = runtime_controls.evm.checkpoint_digest(checkpoint, row['message_id'], cls.hashed)
        point = runtime_controls.evm.point_multiply(2, runtime_controls.evm.SECP_G)
        r = point[0] % runtime_controls.evm.SECP_N
        signature = {'r': hex(r), 's': hex((int(digest, 16) + r * secret) * pow(2, -1, runtime_controls.evm.SECP_N) % runtime_controls.evm.SECP_N), 'v': 27 + (point[1] & 1)}
        (directory / (str(row['index']) + '_with_id.json')).write_text(json.dumps({'value': {'checkpoint': checkpoint, 'message_id': row['message_id']}, 'signature': signature}))

    def test_signed_stopped_prefix_passes_full_canonical_final_without_new_signature(self):
        session, snapshot, dirs, _, _, _, _ = self.fixture()
        before = {str(p): p.read_bytes() for p in dirs['test1'].glob('*_with_id.json')}
        result = session.checkpoint_proofs(snapshot, _final=True)
        self.assertEqual(sum(len(p['verified_checkpoint_objects']) for p in result), 12)
        self.assertEqual(before, {str(p): p.read_bytes() for p in dirs['test1'].glob('*_with_id.json')})
        self.assertFalse((dirs['test1'] / '2_with_id.json').exists())
        with self.assertRaisesRegex(ValueError, 'actual final checkpoint missing'):
            session.checkpoint_proofs(snapshot)

    def test_zero_initial_frontier_is_not_replaced_by_final_index(self):
        session, snapshot, _, _, _, _, _ = self.fixture(leaves=1)
        self.assertEqual(session.retired_evm_checkpoint_requirement(snapshot)[1], 0)
        self.assertEqual(sum(len(p['verified_checkpoint_objects']) for p in session.checkpoint_proofs(snapshot, _final=True)), 6)

    def test_active_latest_requirement_and_every_extra_actual_object_remain_strict(self):
        session, snapshot, dirs, chains, secrets, _, _ = self.fixture()
        active = dirs['test2'] / '1_with_id.json'
        saved = active.read_bytes()
        active.unlink()
        with self.assertRaisesRegex(ValueError, 'actual final checkpoint missing'):
            session.checkpoint_proofs(snapshot, _final=True)
        active.write_bytes(saved)
        rows = [r for r in snapshot['messages'] if r['origin_chain'] == 'test1']
        final = runtime_controls.evm.merkle_roots(rows, self.hashed)[-1]
        self.publish(dirs['test1'], chains['test1'], final, secrets['test1'])
        self.assertEqual(sum(len(p['verified_checkpoint_objects']) for p in session.checkpoint_proofs(snapshot, _final=True)), 14)
        extra = dirs['test1'] / '2_with_id.json'
        wire = extra.read_bytes()
        for field, value in [('root', '0x' + '00' * 32), ('mailbox_domain', 9913372)]:
            bad = json.loads(wire)
            bad['value']['checkpoint'][field] = value
            extra.write_text(json.dumps(bad))
            with self.assertRaisesRegex(ValueError, 'published checkpoint differs'):
                session.checkpoint_proofs(snapshot, _final=True)
        bad = json.loads(wire)
        bad['signature']['r'] = '0x0'
        extra.write_text(json.dumps(bad))
        with self.assertRaisesRegex(ValueError, 'invalid checkpoint ECDSA'):
            session.checkpoint_proofs(snapshot, _final=True)
        extra.write_bytes(wire)
        (dirs['test1'] / '3_with_id.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'checkpoint beyond actual native insertion stream'):
            session.checkpoint_proofs(snapshot, _final=True)

    def test_missing_or_changed_prior_signed_bytes_and_frontier_authority_refuse(self):
        for poison in ['missing', 'changed', 'signer', 'index-bool', 'path', 'duplicate-proof', 'no-proof']:
            with self.subTest(poison=poison):
                session, snapshot, dirs, _, _, _, _ = self.fixture()
                proof = session.initial['checkpoint_proofs'][0]
                if poison == 'missing': (dirs['test1'] / '1_with_id.json').unlink()
                elif poison == 'changed': (dirs['test1'] / '1_with_id.json').write_text('{}')
                elif poison == 'signer': proof['verified_checkpoint_objects'][0]['signer'] = session.case['validator_addresses']['test2']
                elif poison == 'index-bool': proof['verified_checkpoint_objects'][0]['index'] = False
                elif poison == 'path': proof['verified_checkpoint_objects'][0]['path'] = str(dirs['test2'] / '0_with_id.json')
                elif poison == 'duplicate-proof': session.initial['checkpoint_proofs'].append(copy.deepcopy(proof))
                else: session.initial['checkpoint_proofs'] = []
                with self.assertRaises((ValueError, OSError)):
                    session.checkpoint_proofs(snapshot, _final=True)

    def test_flag_wire_ownership_scope_and_ambiguity_refuse(self):
        for poison in ['missing', 'bool-zero', 'float-zero', 'duplicate-key', 'extra-key', 'newline', 'wrong-origin', 'ambiguous', 'symlink', 'hardlink', 'wrong-hook']:
            with self.subTest(poison=poison):
                session, snapshot, dirs, _, _, _, _ = self.fixture()
                flag = dirs['test1'] / 'reorg_flag.json'
                wire = flag.read_bytes()
                if poison == 'missing': flag.unlink()
                elif poison in {'bool-zero', 'float-zero'}:
                    value = json.loads(wire)
                    value['checkpoint_index'] = False if poison == 'bool-zero' else 0.0
                    flag.write_text(json.dumps(value, separators=(',', ':')))
                elif poison == 'duplicate-key': flag.write_bytes(wire[:-1] + b',"checkpoint_index":0}')
                elif poison == 'extra-key': flag.write_bytes(wire[:-1] + b',"foreign":0}')
                elif poison == 'newline': flag.write_bytes(wire + b'\n')
                elif poison == 'wrong-origin': flag.unlink(); (dirs['test2'] / 'reorg_flag.json').write_bytes(wire)
                elif poison == 'ambiguous': (dirs['test2'] / 'reorg_flag.json').write_bytes(wire)
                elif poison == 'symlink': flag.unlink(); flag.symlink_to(dirs['test2'] / 'metadata_latest.json')
                elif poison == 'hardlink': (dirs['test1'] / 'alias').hardlink_to(flag)
                else: session.captures[5]['original']['chains']['test1']['merkletreehook'] = '0x' + 'ff' * 20
                with self.assertRaises((ValueError, OSError)):
                    session.checkpoint_proofs(snapshot, _final=True)

    def test_retirement_receipts_snapshot_and_phase_scope_fail_closed(self):
        for poison in ['missing-retirement', 'duplicate', 'unplanned', 'wrong-role', 'wrong-epoch', 'snapshot-waits', 'foreign-origin', 'foreign-family', 'no-initial', 'no-restart', 'nonliteral-final']:
            with self.subTest(poison=poison):
                session, snapshot, _, _, _, launches, exits = self.fixture()
                retired = exits[5]
                if poison == 'missing-retirement': retired.update(purpose='final', success=True, exit_code=0, signal=None)
                elif poison == 'duplicate': exits.append(copy.deepcopy(retired))
                elif poison == 'unplanned': retired['planned_exit'] = False
                elif poison == 'wrong-role': retired['role'] = 'relayer'
                elif poison == 'wrong-epoch': retired['os_start_token'] = 'foreign'
                elif poison == 'snapshot-waits': snapshot['parent_wait_receipts'] = []
                elif poison == 'foreign-origin': session.case['reorg_origin_chain'] = 'test2'
                elif poison == 'foreign-family': session.manifest['scenario'] = 'tron'
                elif poison == 'no-initial': session.initial = None
                elif poison == 'no-restart': session.restart = None
                runtime_controls.ParentWaitTests.write(session, launches, exits)
                with self.assertRaises(ValueError):
                    session.checkpoint_proofs(snapshot, _final=1 if poison == 'nonliteral-final' else True)

    def test_verifier_bound_types_and_metadata_do_not_weaken_authentication(self):
        session, snapshot, dirs, chains, _, _, _ = self.fixture()
        chain = chains['test1']
        messages = [r for r in snapshot['messages'] if r['origin_chain'] == 'test1']
        kwargs = {'git_sha': 'a' * 40, 'configured_rpc_urls': ['http://127.0.0.1:1'], 'allows_public_rpcs': False}
        for value in [True, False, 0.0, -1, 3, '0']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                runtime_controls.evm.verify_checkpoint_objects(dirs['test1'], chain, session.case['validator_addresses']['test1'], messages, self.hashed, _required_checkpoint_index=value, **kwargs)
        metadata = dirs['test1'] / 'metadata_latest.json'
        original = metadata.read_bytes()
        value = json.loads(original)
        value['git_sha'] = 'b' * 40
        metadata.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError, 'ValidatorMetadata producer differs'):
            session.checkpoint_proofs(snapshot, _final=True)
        metadata.write_bytes(original)

    def test_only_final_verify_branch_supplies_retired_authorization(self):
        import ast
        tree = ast.parse(pathlib.Path(runtime_controls.session_module.__file__).read_text())
        session = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'Session')
        calls = [(n.name, c) for n in session.body if isinstance(n, ast.FunctionDef) for c in ast.walk(n) if isinstance(c, ast.Call) and isinstance(c.func, ast.Attribute) and c.func.attr == 'checkpoint_proofs' and any(k.arg == '_final' for k in c.keywords)]
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][0], '_verify')
        self.assertIn('stage == "final"', pathlib.Path(runtime_controls.session_module.__file__).read_text())

if __name__ == "__main__":
    unittest.main()
