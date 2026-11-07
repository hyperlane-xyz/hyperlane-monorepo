"""Pure independent native-wire/account/canonical-boundary controls; no nodes."""
import base64
import copy
import hashlib
import json
import pathlib
import unittest

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


if __name__ == "__main__":
    unittest.main()
