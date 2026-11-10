"""Pure independent native-wire/account/canonical-boundary controls; no nodes."""
import base64
import copy
import hashlib
import json
import pathlib
import unittest
import threading
from types import SimpleNamespace
from unittest import mock

import multivm_sealevel as svm

FIXTURES = pathlib.Path(__file__).resolve().parents[1] / "src/altvm/fixtures"


class Codecs(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sdk = json.loads((FIXTURES / "sdk.json").read_text())
        cls.wires = json.loads((FIXTURES / "svm-destination.json").read_text())["cases"]

    def test_actual_independent_sdk_legacy_v0_jito_signatures_match_all_eight_wires(self):
        for row in self.wires:
            with self.subTest(jito=row["jito"], versioned=row["versioned"], units=row["units"]):
                decoded = svm.decode_wire(bytes.fromhex(row["wire"]))
                self.assertEqual(decoded["message"].hex(), row["message"])
                self.assertEqual(decoded["version"], 0 if row["versioned"] else "legacy")
                self.assertEqual(len(svm.hex_bytes(decoded["identity"])), 64)
                self.assertEqual(decoded["payer"], decoded["keys"][0])
                self.assertEqual(bool(decoded["lookups"]), row["versioned"])

    def test_native_ed25519_rejects_changed_message_identity_and_scalar_malleability(self):
        for row in self.wires:
            raw = bytes.fromhex(row["wire"])
            for offset in [1, 32, 64, len(raw) - 1]:
                altered = bytearray(raw)
                altered[offset] ^= 1
                with self.subTest(offset=offset), self.assertRaises(ValueError):
                    svm.decode_wire(bytes(altered))
            # S+L represents the same group element but is not a canonical SDK
            # signature; valid arithmetic alone must not authorize these bytes.
            altered = bytearray(raw)
            scalar = int.from_bytes(altered[33:65], "little")
            altered[33:65] = (scalar + svm.L).to_bytes(32, "little")
            with self.assertRaisesRegex(ValueError, "noncanonical/weak"):
                svm.decode_wire(bytes(altered))

    def test_packet_every_truncation_noncanonical_count_and_trailing_bytes_rejected(self):
        for row in self.wires:
            raw = bytes.fromhex(row["wire"])
            for end in range(len(raw)):
                with self.subTest(end=end), self.assertRaises(ValueError):
                    svm.decode_wire(raw[:end])
            for altered in [raw + b"\0", b"\x81\0" + raw[1:], b"\0" + raw[1:]]:
                with self.assertRaises(ValueError):
                    svm.decode_wire(altered)

    def test_production_rust_sdk_pdas_exact_and_seed_bounds_enforced(self):
        for row in self.sdk["solana"]["pdas"]:
            address, bump = svm.pda(bytes([17]) * 32, [bytes.fromhex(seed) for seed in row["seeds"]])
            self.assertEqual((address.hex(), bump), (row["key"], row["bump"]))
        for seeds in [[b"x" * 33], [b""] * 16]:
            with self.assertRaises(ValueError):
                svm.pda(bytes(32), seeds)

    def test_actual_borsh_dispatch_payment_processed_layouts_and_wrong_discriminators(self):
        fixture = self.sdk["sealevel"]
        dispatch = svm.decode_account(bytes.fromhex(fixture["dispatched"]), "dispatch")
        self.assertEqual((dispatch["nonce"], dispatch["slot"]), (4, 20))
        processed = svm.decode_account(bytes.fromhex(fixture["processed"]), "delivery")
        self.assertEqual((processed["message_id"], processed["slot"], processed["sequence"]), ("0x" + fixture["message_id"], 21, 7))
        payment = svm.decode_account(bytes.fromhex(fixture["gas_payment"]), "gas")
        self.assertEqual((payment["message_id"], payment["destination"], payment["slot"]), (processed["message_id"], 2000, 22))
        data = bytes.fromhex(fixture["process_data"])
        decoded = {"instructions": [{"program": bytes([9]) * 32, "accounts": [0, 1, 2, 3, 4], "data": data}]}
        messages = svm.process_messages(decoded, bytes([9]) * 32, lambda _: "0x" + fixture["message_id"])
        self.assertEqual(messages[0]["wire"], svm.h(dispatch["wire"]))
        self.assertEqual(messages[0]["metadata_sha256"], hashlib.sha256(bytes([1, 2, 3])).hexdigest())
        for kind, field in [("dispatch", "dispatched"), ("delivery", "processed"), ("gas", "gas_payment")]:
            raw = bytes.fromhex(fixture[field])
            for end in range(len(raw)):
                # Hyperlane bodies have no separate length field. Once77 bytes
                # of message exist, body truncation must be caught by its actual
                # canonical ID/receipt comparison, not a fabricated length.
                if kind == "dispatch" and end >= 53 + 77:
                    continue
                with self.assertRaises(ValueError):
                    svm.decode_account(raw[:end], kind)
            changed = bytearray(raw)
            changed[1] ^= 1
            with self.assertRaises(ValueError):
                svm.decode_account(bytes(changed), kind)

    def test_base58_roundtrip_including_full_signature_and_leading_zeros(self):
        for raw in [bytes(32), bytes(range(32)), bytes(range(64)), bytes([0, 0, 8])]:
            self.assertEqual(svm.b58decode(svm.b58encode(raw), len(raw)), raw)
        for text in ["O", "0", "I", "l", " ", "1" * 100]:
            with self.assertRaises(ValueError):
                svm.b58decode(text, 32)

    def test_source_scenarios_have_different_exact_workloads_and_no_import_effects(self):
        for scenario, n, dispatched, delivered, unpaid in [("sealevel", 3, 13, 12, 1), ("sealevel-composite", 2, 2, 2, 0)]:
            names = ["sealeveltest" + str(i + 1) for i in range(n)]
            case = {"schema": 1, "scenario": scenario, "chain_names": names, "domain_names": {str(13375 + i): name for i, name in enumerate(names)}, "payments_supported": True, "initial_corpus": {"dispatches": dispatched, "deliveries": delivered, "unpaid": unpaid}, "relayer_addresses": {name: "1" * 32 for name in names}, "validator_addresses": {names[0]: "0x" + "22" * 20}, "native_limits": {name: {"maximum_fee": 10000} for name in names}}
            adapter = svm.Adapter({"scenario": scenario}, case)
            adapter.validate_case()
            self.assertEqual(adapter.submitted, {})
            self.assertEqual(adapter.transport("customrpcurls"), "http-json")
            with self.assertRaises(ValueError):
                adapter.transport("grpcurls")
            case["initial_corpus"]["deliveries"] += 1
            with self.assertRaises(ValueError):
                adapter.validate_case()

    def test_source_live_shaped_composite_storage_rejects_wrong_threshold_recipient_and_mailbox(self):
        mailbox, recipient, fallback = bytes([9]) * 32, bytes([8]) * 32, bytes([7]) * 32
        raw = b"\x01\xff\0\x01\x02\x03" + (3).to_bytes(4, "little") + b"\x04\0\x06" + (100_000_000_000).to_bytes(8, "little") + b"\x01" + recipient + (90_000_000_000).to_bytes(8, "little") + (123).to_bytes(8, "little") + mailbox + b"\x08" + fallback
        proof = svm.verify_composite_storage(raw, 255, mailbox, recipient, fallback)
        self.assertEqual(proof["aggregation_threshold"], 3)
        for offset in [1, 4, 5, 6, 10, 11, 12, 20, 21, 70, len(raw) - 1]:
            changed = bytearray(raw)
            changed[offset] ^= 1
            with self.subTest(offset=offset), self.assertRaises(ValueError):
                svm.verify_composite_storage(bytes(changed), 255, mailbox, recipient, fallback)
        # Bucket refill/debit is mutable Source state, not immutable config.
        mutable = bytearray(raw)
        mutable[54:62] = (100).to_bytes(8, "little")
        mutable[62:70] = (456).to_bytes(8, "little")
        svm.verify_composite_storage(bytes(mutable), 255, mailbox, recipient, fallback)

    def test_before_forward_finalized_pda_status_and_receipt_witnesses_keep_full_signature(self):
        fixture = self.sdk["sealevel"]
        processed = bytes.fromhex(fixture["processed"])
        mailbox = bytes([17]) * 32
        identity = "0x" + "aa" * 64
        message_id = "0x" + fixture["message_id"]
        processed_pda = svm.pda(mailbox, [b"hyperlane", b"-", b"processed_message", b"-", bytes.fromhex(fixture["message_id"])])[0]
        class Session:
            def __init__(self):
                self.inclusions = []
            def chain_config(self, chain):
                return {"mailbox": svm.b58encode(mailbox)}
            def record_inclusion(self, *args):
                self.inclusions.append(args)
        adapter = svm.Adapter({}, {})
        adapter.submitted[("sealeveltest2", identity)] = [{"id": message_id}]
        session = Session()
        result = {"context": {"slot": 40}, "value": {"owner": svm.b58encode(mailbox), "executable": False, "data": [base64.b64encode(processed).decode(), "base64"]}}
        event = {"status": 200, "chain": "sealeveltest2", "received_monotonic_ns": 123, "role": "relayer", "request": {"id": 1, "method": "getAccountInfo", "params": [svm.b58encode(processed_pda), {"commitment": "finalized"}]}, "response": {"id": 1, "result": result}}
        adapter.observe(session, event)
        self.assertEqual(session.inclusions[0][:4], ("sealeveltest2", message_id, identity, 123))
        self.assertEqual(len(svm.hex_bytes(session.inclusions[0][2])), 64)
        event["request"] = {"id": 1, "method": "getSignatureStatuses", "params": [[svm.b58encode(svm.hex_bytes(identity))]]}
        event["response"] = {"id": 1, "result": {"context": {"slot": 40}, "value": [{"slot": 21, "err": None, "confirmationStatus": "confirmed"}]}}
        adapter.observe(session, event)
        self.assertEqual(len(session.inclusions), 1)
        event["response"]["result"]["value"][0]["confirmationStatus"] = "finalized"
        event["received_monotonic_ns"] = 124
        adapter.observe(session, event)
        self.assertEqual(session.inclusions[1][3], 124)
        event["request"] = {"id": 1, "method": "getTransaction", "params": [svm.b58encode(svm.hex_bytes(identity)), {"commitment": "finalized"}]}
        event["response"] = {"id": 1, "result": {"slot": 21, "meta": {"err": None}}}
        event["received_monotonic_ns"] = 125
        adapter.observe(session, event)
        self.assertEqual(session.inclusions[2][3], 125)
        # A read for a different native PDA cannot supply the earlier witness.
        event["request"] = {"id": 1, "method": "getAccountInfo", "params": [svm.b58encode(bytes(32)), {"commitment": "finalized"}]}
        event["response"] = {"id": 1, "result": result}
        with self.assertRaisesRegex(ValueError, "PDA/context"):
            adapter.observe(session, event)


class CanonicalBoundary(unittest.TestCase):
    def fixture(self, versioned=False):
        rows = json.loads((FIXTURES / "svm-destination.json").read_text())["cases"]
        row = next(row for row in rows if row["versioned"] == versioned and not row["jito"])
        raw = bytes.fromhex(row["wire"])
        decoded = svm.decode_wire(raw)
        signature = svm.b58encode(decoded["signatures"][0])
        loaded = {"writable": [svm.b58encode(bytes([1]) * 32)] if versioned else [], "readonly": []}
        native = {"slot": 21, "meta": {"err": None, "fee": 5000, "computeUnitsConsumed": 100000, "loadedAddresses": loaded, "innerInstructions": []}, "transaction": {"signatures": [signature], "message": {"accountKeys": [svm.b58encode(key) for key in decoded["keys"]], "recentBlockhash": svm.b58encode(decoded["blockhash"]), "instructions": [{"programIdIndex": decoded["keys"].index(i["program"]), "accounts": i["accounts"], "data": svm.b58encode(i["data"])} for i in decoded["instructions"]]}}}
        status = {"context": {"slot": 40}, "value": [{"slot": 21, "err": None, "confirmationStatus": "finalized"}]}
        header = {"blockhash": svm.b58encode(bytes([3]) * 32), "previousBlockhash": svm.b58encode(bytes([2]) * 32), "signatures": [signature]}
        table = bytes.fromhex(json.loads((FIXTURES / "sdk.json").read_text())["solana"]["lookup_table"])
        # SDK fixture has addresses[4,1], while the transaction fixture indexes0
        # from its single [1] table. Keep real bincode metadata, actual table map.
        table = table[:56] + bytes([1]) * 32
        class Session:
            changes = {}
            blocks = 0
            def rpc(self, chain, method, params):
                if method == "getBlock":
                    self.blocks += 1
                    result = copy.deepcopy(header)
                    if self.blocks == 2 and self.changes.get("reorg"):
                        result["blockhash"] = svm.b58encode(bytes([8]) * 32)
                    return result
                if method == "getSignatureStatuses":
                    return self.changes.get("status", status)
                if method == "getAccountInfo":
                    data = self.changes.get("table", table)
                    return {"context": {"slot": 100}, "value": {"owner": self.changes.get("table_owner", "AddressLookupTab1e1111111111111111111111111"), "executable": False, "data": [base64.b64encode(data).decode(), "base64"]}}
                if method == "getTransaction":
                    result = copy.deepcopy(self.changes.get("native", native))
                    if params[1]["encoding"] == "base64":
                        result["transaction"] = [base64.b64encode(self.changes.get("raw", raw)).decode(), "base64"]
                    return result
                raise AssertionError(method)
        return svm.Adapter({}, {}), Session(), signature, native, status, table

    def test_actual_sdk_wire_and_canonical_by_slot_status_fence_accept_legacy_and_alt(self):
        for versioned in [False, True]:
            adapter, session, signature, *_ = self.fixture(versioned)
            proof = adapter._transaction(session, "fixture", signature)
            self.assertEqual((proof["slot"], proof["fee"], proof["units"]), (21, 5000, 100000))
            self.assertEqual(proof["decoded"]["version"], 0 if versioned else "legacy")
            self.assertEqual(session.blocks, 2)

    def test_wrong_slot_status_reorg_fee_json_wire_and_alt_authority_fail(self):
        for name in ["status", "reorg", "failed", "fee", "json_wire", "table_owner", "table_contents", "table_future", "table_deactivated"]:
            with self.subTest(name=name):
                adapter, session, signature, native, status, table = self.fixture(True)
                session.changes = {}
                if name == "status":
                    changed = copy.deepcopy(status)
                    changed["value"][0]["slot"] = 20
                    session.changes["status"] = changed
                elif name == "reorg":
                    session.changes["reorg"] = True
                elif name == "table_owner":
                    session.changes["table_owner"] = "1" * 32
                elif name.startswith("table_"):
                    changed = bytearray(table)
                    if name == "table_contents":
                        changed[56] ^= 1
                    elif name == "table_future":
                        changed[12:20] = (22).to_bytes(8, "little")
                    else:
                        changed[4:12] = (20).to_bytes(8, "little")
                    session.changes["table"] = bytes(changed)
                else:
                    changed = copy.deepcopy(native)
                    if name == "failed":
                        changed["meta"]["err"] = {"InstructionError": [0, "Custom"]}
                    elif name == "fee":
                        changed["meta"]["fee"] = None
                    else:
                        changed["transaction"]["message"]["instructions"][0]["data"] = svm.b58encode(b"different")
                    session.changes["native"] = changed
                with self.assertRaises(ValueError):
                    adapter._transaction(session, "fixture", signature)



class RelayerConfigurationBoundary(unittest.TestCase):
    """Configuration/ALT boundary only; transaction verification is stubbed.

    A sentinel at the next account read proves strict ALT checks completed.
    These fixtures supply no native signature or full-composite acceptance.
    """
    class AccountBoundaryReached(Exception):
        pass

    def fixture(self):
        origin_name, destination_name = "sealeveltest1", "sealeveltest2"
        mailbox, hook, payer = bytes([34]) * 32, bytes([17]) * 32, bytes([85]) * 32
        table, route_table, rogue = bytes([102]) * 32, bytes([119]) * 32, bytes([153]) * 32
        origin = {"merkletreehook": svm.b58encode(hook)}
        destination = {"mailbox": svm.b58encode(mailbox), "chainid": "13376", "mailboxprocessalts": json.dumps([svm.b58encode(table), svm.b58encode(route_table)])}
        chains = {origin_name: origin, destination_name: destination}
        relayer = {"original": {"role": "relayer", "chains": chains}}
        validator_chains = copy.deepcopy(chains)
        # A later validator neither knows nor authorizes the relayer's ALTs.
        validator_chains[destination_name]["mailboxprocessalts"] = [svm.b58encode(rogue), svm.b58encode(route_table)]
        validator = {"original": {"role": "validator", "chains": validator_chains}}
        class Session:
            captures = []
            def chain_config(self, name):
                return [row["original"]["chains"][name] for row in self.captures][-1]
        session = Session()
        recipient = svm.key("3MzUPjP5LEkiHH82nEAe28Xtz9ztuMqWc8UmuKxrpVQH")
        fallback = svm.key("4RSV6iyqW9X66Xq3RDCVsKJ7hMba5uv6XP8ttgxjVUB1")
        addresses = [bytes([170]) * 32 for _ in range(11)]
        addresses[0], addresses[4], addresses[8] = recipient, bytes([136]) * 32, fallback
        message = {"id": "0x" + "33" * 32, "nonce": 0, "origin": 13375, "destination": 13376, "origin_chain": origin_name, "delivery_chain": destination_name, "delivery_transaction": "0x" + "44" * 64, "recipient": svm.h(recipient)}
        authority = {"protocol": "sealevel", "origin": 13375, "destination": 13376, "mailbox": svm.h(mailbox), "chain_id": "13376", "origin_hook": svm.h(hook), "operation_id": message["id"], "generation": 7, "kind": "process", "target": None}
        operation = {"authority": authority, "nonce": 0, "stage": "delivered", "identity": {"kind": "signature512", "hex": message["delivery_transaction"]}, "generation": 7}
        decoded = {"payer": payer, "signatures": [bytes(64)], "lookups": [{"table": table}, {"table": route_table}]}
        proof = {"decoded": decoded, "lookup_addresses": {svm.h(route_table): addresses}}
        adapter = svm.Adapter({"scenario": "sealevel-composite"}, {"relayer_addresses": {destination_name: svm.b58encode(payer)}})
        adapter._transaction = lambda *_: proof
        def account_boundary(*_):
            raise self.AccountBoundaryReached("strict relayer ALT checks completed")
        adapter._account = account_boundary
        snapshot = {"deliverable_messages": [message]}
        return adapter, session, snapshot, [{"id": message["id"], "operation": operation}], relayer, validator, proof, rogue

    def test_native_composite_ALTs_follow_latest_relayer_for_both_role_orders(self):
        for validator_last in (False, True):
            adapter, session, snapshot, rows, relayer, validator, _, _ = self.fixture()
            stale_relayer = copy.deepcopy(relayer)
            stale_relayer["original"]["chains"]["sealeveltest2"]["mailboxprocessalts"] = []
            session.captures = [stale_relayer] + ([relayer, validator] if validator_last else [validator, relayer])
            with self.subTest(validator_last=validator_last), self.assertRaisesRegex(self.AccountBoundaryReached, "strict relayer ALT"):
                adapter.native_rows(session, snapshot, rows, None)

    def test_validator_ALT_cannot_authorize_rogue_relayer_transaction_lookup(self):
        adapter, session, snapshot, rows, relayer, validator, proof, rogue = self.fixture()
        session.captures = [relayer, validator]
        proof["decoded"]["lookups"][0]["table"] = rogue
        with self.assertRaisesRegex(ValueError, "signed ALT not configured"):
            adapter.native_rows(session, snapshot, rows, None)

    def test_native_rows_require_explicit_relayer_capture(self):
        adapter, session, snapshot, rows, _, validator, _, _ = self.fixture()
        session.captures = [validator]
        with self.assertRaisesRegex(ValueError, "relayer configuration capture missing"):
            adapter.native_rows(session, snapshot, rows, None)



class EventRelevanceDiagnostics(unittest.TestCase):
    """Actual relevance loop/guard; canonical proof itself is an explicit stub."""
    def fixture(self, rows, mode='dispatch'):
        program, address = bytes([17]) * 32, bytes([18]) * 32
        calls = []
        session = SimpleNamespace(manifest={'scenario': 'sealevel'}, lock=threading.RLock())
        def rpc(chain, method, params):
            calls.append((chain, method, params))
            return rows
        session.rpc = rpc
        adapter = svm.Adapter({}, {})
        proofs = {}
        def transaction(_session, _chain, signature):
            calls.append(('canonical', signature))
            return proofs[signature]
        adapter._transaction = transaction
        def add(index, kind=mode, err=None, slot=20, wrong=None):
            signature = svm.b58encode(bytes([index]) * 64)
            rows.append({'signature': signature, 'slot': slot, 'err': err})
            data = {'dispatch': b'\x04' + bytes(68) + bytes(4), 'gas': b'\x03' + bytes(44), 'delivery': b'\x01' + bytes(8)}[kind]
            instruction = {'programIdIndex': 0 if wrong != 'program' else 1, 'accounts': [0] if wrong == 'address' else [0, 1], 'data': svm.b58encode(data)}
            proofs[signature] = {'keys': [program, address], 'native_json': {'transaction': {'message': {'instructions': [instruction]}}, 'meta': {'innerInstructions': []}}}
        def run():
            return adapter._event_transaction(session, 'sealeveltest1', program, svm.b58encode(address), mode, 20)
        return session, adapter, calls, add, run

    def test_actual_missing_filters_and_ambiguous_counts_are_exact_and_private(self):
        session, _, calls, add, run = self.fixture([])
        add(1, err={'PRIVATE-error': 'PRIVATE'});add(2, slot=18)
        add(3, wrong='program');add(4, wrong='address');add(5, kind='gas')
        with self.assertRaisesRegex(ValueError, 'relevance ambiguous/missing'):run()
        row = getattr(session, 'diagnostic_svm_event_failure', None)
        self.assertIsNotNone(row)
        self.assertEqual(row['counts'], {'signature_rows': 5, 'error_rows': 1, 'other_slot_rows': 1, 'canonical_transactions': 3, 'program_address_instructions': 1, 'matched_transactions': 0})
        self.assertEqual(row['reason'], 'missing');self.assertNotIn('PRIVATE', json.dumps(row))
        self.assertEqual(len(calls), 4)
        session, _, _, add, run = self.fixture([]);add(1);add(2)
        with self.assertRaisesRegex(ValueError, 'relevance ambiguous/missing'):run()
        self.assertEqual(session.diagnostic_svm_event_failure['reason'], 'ambiguous')
        self.assertEqual(session.diagnostic_svm_event_failure['counts']['matched_transactions'], 2)

    def test_success_each_kind_and_previous_slot_retains_exact_result_without_state(self):
        for kind in ['dispatch', 'gas', 'delivery']:
            session, _, calls, add, run = self.fixture([], kind);add(1, slot=19)
            result = run()
            self.assertEqual(result[0], svm.h(bytes([1]) * 64))
            self.assertFalse(hasattr(session, 'diagnostic_svm_event_failure'))
            self.assertEqual(len(calls), 2)

    def test_optional_baseexception_does_not_replace_guard_or_canonical_error(self):
        session, adapter, _, add, run = self.fixture([])
        error = ValueError('original relevance')
        original_require = svm.require
        def require(ok, message):
            if message == 'native event canonical transaction relevance ambiguous/missing' and not ok:raise error
            return original_require(ok, message)
        with mock.patch.object(svm.multivm_diagnostics, 'note_svm_event_failure', side_effect=KeyboardInterrupt), mock.patch.object(svm, 'require', side_effect=require), self.assertRaises(ValueError) as caught:run()
        self.assertIs(caught.exception, error)
        add(1)
        def canonical(*_):raise error
        adapter._transaction = canonical
        with mock.patch.object(svm.multivm_diagnostics, 'note_svm_event_failure') as note, self.assertRaises(ValueError) as caught:run()
        self.assertIs(caught.exception, error);note.assert_not_called()


if __name__ == "__main__":
    unittest.main()
