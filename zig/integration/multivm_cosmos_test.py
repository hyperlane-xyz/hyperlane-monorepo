"""Pure codec controls; zero node/process/SDK or real-chain acceptance."""
import base64
import copy
import gzip
import hashlib
import json
import pathlib
import random
import unittest

import multivm_cosmos as c

ROOT = pathlib.Path(__file__).resolve().parents[2]


def sdk(name):
    return json.loads(gzip.decompress((ROOT / name).read_bytes()))


def fixture_signature(doc):
    # Public SDK fixture key, test-only nonce. Never a real account or broadcast.
    secret, nonce = int.from_bytes(b"\x11" * 32, "big"), 17
    r = c.point_multiply(nonce, c.SECP_G)[0] % c.SECP_N
    s = (pow(nonce, -1, c.SECP_N) * (int.from_bytes(hashlib.sha256(doc).digest(), "big") + r * secret)) % c.SECP_N
    s = min(s, c.SECP_N - s)
    return r.to_bytes(32, "big") + s.to_bytes(32, "big")


def process_fixture(native=True):
    vectors = sdk("zig/src/cosmos/fixtures/sdk.json.gz")
    oracle = sdk("zig/src/altvm/fixtures/sdk.json.gz")["cosmos"]
    message = bytes.fromhex(vectors["message"])
    if native:
        payload = bytes.fromhex(vectors["native_process"])
        type_url = b"/hyperlane.core.v1.MsgProcessMessage"
    else:
        payload = c.encoded(1, vectors["relayer"].encode()) + c.encoded(2, vectors["address"].encode()) + c.encoded(3, vectors["cw_process_json"].encode())
        type_url = b"/cosmwasm.wasm.v1.MsgExecuteContract"
    any_message = c.encoded(1, type_url) + c.encoded(2, payload)
    body = c.encoded(1, any_message) + c.encoded(3, 200)
    auth = bytes.fromhex(vectors["prepared_auth"])
    doc = c.encoded(1, body) + c.encoded(2, auth) + c.encoded(3, b"cosmoshub-4") + c.encoded(4, 12)
    raw = c.encoded(1, body) + c.encoded(2, auth) + c.encoded(3, fixture_signature(doc))
    options = dict(chain_id="cosmoshub-4", account_number=12, signer=vectors["relayer"], prefix="cosmos", mailbox="0x" + vectors["mailbox_id"], native=native, denom="uatom", gas_price="0.025", keccak=lambda _: "0x" + "ab" * 32)
    return raw, options, vectors, oracle, message


class Codec(unittest.TestCase):
    def test_existing_independent_sdk_signature_and_address_oracle(self):
        vector = sdk("zig/src/altvm/fixtures/sdk.json.gz")["cosmos"]
        key = bytes.fromhex(vector["public_key"])
        c.verify_signature(key, bytes.fromhex(vector["digest"]), bytes.fromhex(vector["signature"]))
        self.assertEqual(c.bech32(vector["bech32"], "cosmos").hex(), vector["address"])
        self.assertEqual(hashlib.new("ripemd160", hashlib.sha256(key).digest()).hexdigest(), vector["address"])
        self.assertEqual(hashlib.sha256(bytes.fromhex(vector["sign_doc"])).hexdigest(), vector["digest"])

    def test_signature_rejects_wrong_digest_key_high_s_and_width(self):
        vector = sdk("zig/src/altvm/fixtures/sdk.json.gz")["cosmos"]
        key, digest, signature = (bytes.fromhex(vector[k]) for k in ("public_key", "digest", "signature"))
        mutations = [(key, b"\x00" * 32, signature), (bytes([key[0] ^ 1]) + key[1:], digest, signature), (key, digest, signature[:-1]), (key, digest, signature[:32] + (c.SECP_N - int.from_bytes(signature[32:], "big")).to_bytes(32, "big"))]
        for args in mutations:
            with self.subTest(kind=[len(value) for value in args]), self.assertRaises(ValueError):
                c.verify_signature(*args)

    def test_varint_generated_roundtrip_and_noncanonical_boundaries(self):
        values = [0, 1, 127, 128, 255, 16383, 16384, 2 ** 32 - 1, 2 ** 64 - 1]
        randomizer = random.Random(98273)
        values.extend(randomizer.randrange(2 ** 64) for _ in range(1024))
        for value in values:
            self.assertEqual(c.field(c.protobuf(c.encoded(31, value)), 31, 0), value)
        for bad in [b"\x08\x80\x00", b"\x08\x80", b"\x08" + b"\xff" * 10 + b"\x01", b"\x00", b"\x0a\x05x", b"\x0dxxxx"]:
            with self.subTest(raw=bad), self.assertRaises(ValueError):
                c.protobuf(bad)

    def test_repeated_fields_require_explicit_scalar_uniqueness(self):
        data = c.protobuf(c.encoded(1, b"a") + c.encoded(1, b"b"))
        self.assertEqual(len(data[1]), 2)
        with self.assertRaises(ValueError):
            c.field(data, 1, 2)
        with self.assertRaises(ValueError):
            c.strict_json('{"process":{"message":"a","message":"b"}}')

    def test_real_sdk_native_and_cosmwasm_process_shapes_and_fees(self):
        for native in (False, True):
            raw, options, vectors, _, packed = process_fixture(native)
            proof, private = c.signed_transaction(raw, **options)
            self.assertTrue(proof["direct_signature_verified"])
            self.assertEqual(proof["message"]["wire"], "0x" + packed.hex())
            self.assertEqual(proof["identity"], "0x" + hashlib.sha256(raw).hexdigest())
            self.assertEqual(proof["gas_limit"], 200000)
            self.assertEqual(proof["fee"], 5000)
            self.assertEqual(proof["sequence"], 7)
            self.assertEqual(proof["account_number"], 12)
            self.assertEqual(proof["mailbox"], "0x" + vectors["mailbox_id"])
            self.assertEqual(hashlib.sha256(private["sign_doc"]).digest(), hashlib.sha256(c.encoded(1, private["body"]) + c.encoded(2, private["auth"]) + c.encoded(3, b"cosmoshub-4") + c.encoded(4, 12)).digest())

    def test_replay_sender_target_and_price_mutations_fail(self):
        raw, options, _, _, _ = process_fixture()
        for key, changed in [("chain_id", "other-chain"), ("account_number", 13), ("mailbox", "0x" + "77" * 32), ("gas_price", "0.026"), ("denom", "other")]:
            with self.subTest(field=key), self.assertRaises(ValueError):
                c.signed_transaction(raw, **dict(options, **{key: changed}))
        tampered = raw[:-1] + bytes([raw[-1] ^ 1])
        with self.assertRaises(ValueError):
            c.signed_transaction(tampered, **options)

    def test_bech32_checksum_case_prefix_and_payload_width(self):
        vector = sdk("zig/src/cosmos/fixtures/sdk.json.gz")
        self.assertEqual(c.address(vector["address"], "cosmos"), "0x" + vector["mailbox_id"])
        for bad, prefix in [(vector["address"].upper(), "cosmos"), (vector["address"][:-1] + "q", "cosmos"), (vector["address"], "osmo")]:
            with self.assertRaises(ValueError):
                c.bech32(bad, prefix)

    def test_address_encoder_sdk_oracle_and_generated_inverse(self):
        vector = sdk("zig/src/cosmos/fixtures/sdk.json.gz")
        self.assertEqual(c.encode_address(bytes.fromhex(vector["mailbox_id"]), "cosmos"), vector["address"])
        randomizer = random.Random(2919283)
        for _ in range(512):
            raw = randomizer.randbytes(randomizer.randrange(1, 33))
            prefix = randomizer.choice(("cosmos", "osmo", "hyp"))
            self.assertEqual(c.bech32(c.encode_address(raw, prefix), prefix), raw)
        for raw, prefix in [(b"", "cosmos"), (b"x" * 33, "cosmos"), (b"x", "COSMOS"), (b"x", "")]:
            with self.assertRaises(ValueError):
                c.encode_address(raw, prefix)

    def test_native_payment_quotes_denoms_and_event_emitter(self):
        contracts = {name: "0x" + "11" * 32 for name in ("mailbox", "merkletreehook", "interchaingaspaymaster")}
        attrs = {"igp_id": json.dumps(contracts["interchaingaspaymaster"]), "message_id": json.dumps("0x" + "22" * 32), "gas_amount": "1000", "payment": json.dumps(str(2 ** 240 + 17) + "uhyp"), "destination": "2000"}
        value = {"type": "hyperlane.core.post_dispatch.v1.EventGasPayment", "attributes": [{"key": k, "value": v} for k, v in attrs.items()]}
        options = dict(native=True, compat="0.38", prefix="hyp", denom="uhyp", contracts=contracts, keccak=None)
        result = c.event(value, **options)
        self.assertEqual(result["payment"], 2 ** 240 + 17)
        self.assertEqual(result["destination"], 2000)
        with self.assertRaises(ValueError):
            c.event(value, **dict(options, denom="other"))
        duplicate = copy.deepcopy(value)
        duplicate["attributes"].append(duplicate["attributes"][0])
        with self.assertRaises(ValueError):
            c.event(duplicate, **options)
        self.assertIsNone(c.event(value, **dict(options, contracts=dict(contracts, interchaingaspaymaster="0x" + "33" * 32))))

    def test_wasm_plain_and_base64_attributes_use_actual_sdk_message(self):
        vector = sdk("zig/src/cosmos/fixtures/sdk.json.gz")
        contracts = {name: vector["address"] for name in ("mailbox", "merkletreehook", "interchaingaspaymaster")}
        for compat in ("0.34", "0.37", "0.38"):
            attrs = {"_contract_address": vector["address"], "message": vector["message"]}
            if compat != "0.38":
                attrs = {base64.b64encode(k.encode()).decode(): base64.b64encode(v.encode()).decode() for k, v in attrs.items()}
            value = {"type": "wasm-mailbox_dispatch", "attributes": [{"key": k, "value": v} for k, v in attrs.items()]}
            result = c.event(value, native=False, compat=compat, prefix="cosmos", denom="uatom", contracts=contracts, keccak=lambda _: "0x" + "ab" * 32)
            self.assertEqual(result["message"]["nonce"], 4)
            self.assertEqual(result["message"]["body"], "0x" + b"payload".hex())

    def test_adapter_import_constructor_transport_and_source_case_are_effect_free(self):
        from unittest.mock import patch
        manifest = {"scenario": "cosmosnative"}
        case = {"schema": 1, "scenario": "cosmosnative", "chain_names": ["first", "second"], "relayer_addresses": {"first": "public", "second": "public"}, "validator_addresses": {"first": "public", "second": "public"}, "payments_supported": True, "initial_corpus": {"dispatches": 8, "deliveries": 8, "failed_body": 0, "zero_insertions": 0, "double_insertions": 0}}
        with patch("subprocess.Popen", side_effect=AssertionError("process forbidden")), patch("socket.create_connection", side_effect=AssertionError("network forbidden")), patch("threading.Thread.start", side_effect=AssertionError("thread forbidden")):
            adapter = c.Adapter(manifest, case)
            adapter.validate_case()
            self.assertEqual(adapter.transport("grpcurls"), "tcp")
            self.assertEqual(adapter.transport("customrpcurls"), "http-json")
            with self.assertRaises(ValueError):
                adapter.transport("websocketurls")
            bad = copy.deepcopy(case)
            bad["payments_supported"] = False
            with self.assertRaises(ValueError):
                c.Adapter(manifest, bad).validate_case()

    def test_canonical_receipt_checks_exact_block_index_result_gas_and_finality(self):
        raw, _, _, _, _ = process_fixture()
        identity = hashlib.sha256(raw).hexdigest().upper()
        actual_result = {"code": 0, "gas_used": "123", "events": []}
        transaction = {"hash": identity, "tx": base64.b64encode(raw).decode(), "height": "10", "index": 0, "tx_result": actual_result}
        chain = {"chainid": "cosmoshub-4", "bech32prefix": "cosmos", "canonicalasset": "uatom"}
        good = {"block": {"block_id": {"hash": "11" * 32}, "block": {"header": {"height": "10", "chain_id": "cosmoshub-4"}, "data": {"txs": [transaction["tx"]]}}}, "block_results": {"height": "10", "txs_results": [actual_result]}, "status": {"node_info": {"network": "cosmoshub-4"}, "sync_info": {"catching_up": False, "latest_block_height": "11"}}}

        class Session:
            keccak = None
            def __init__(self, responses):
                self.responses = responses
            def rpc(self, name, method, params):
                return self.responses[method]

        adapter = c.Adapter({"scenario": "cosmosnative"}, {})
        proof, recovered = adapter.canonical_transaction(Session(good), "first", chain, transaction)
        self.assertEqual(recovered, raw)
        self.assertEqual(proof["gas_used"], 123)
        self.assertEqual(proof["identity"], "0x" + identity.lower())
        mutations = []
        bad = copy.deepcopy(good)
        bad["block"]["block"]["data"]["txs"] = [base64.b64encode(raw[:-1]).decode()]
        mutations.append(bad)
        bad = copy.deepcopy(good)
        bad["block_results"]["txs_results"][0]["gas_used"] = "124"
        mutations.append(bad)
        bad = copy.deepcopy(good)
        bad["status"]["sync_info"]["latest_block_height"] = "10"
        mutations.append(bad)
        bad = copy.deepcopy(good)
        bad["status"]["node_info"]["network"] = "other"
        mutations.append(bad)
        for responses in mutations:
            with self.assertRaises(ValueError):
                adapter.canonical_transaction(Session(responses), "first", chain, transaction)

    def test_observation_accepts_validator_capture_before_relayer_and_binds_emitter(self):
        chain = {"bech32prefix": "hyp", "mailbox": "0x" + "11" * 32, "merkletreehook": "0x" + "22" * 32, "interchaingaspaymaster": "0x" + "33" * 32}
        message_id = "0x" + "44" * 32
        transaction_hash = "55" * 32
        emitted = {"type": "hyperlane.core.v1.EventProcess", "attributes": [{"key": "origin_mailbox_id", "value": json.dumps(chain["mailbox"])}, {"key": "message_id", "value": json.dumps(message_id)}]}
        observed = {"chain": "first", "role": "validator", "received_monotonic_ns": 19, "request": {"method": "tx", "params": {}}, "response": {"result": {"hash": transaction_hash, "height": "10", "tx_result": {"code": 0, "events": [emitted]}}}}

        class Session:
            def __init__(self):
                self.proofs = []
            def chain_config(self, name):
                return chain
            def record_inclusion(self, *proof):
                self.proofs.append(proof)
            def keccak(self, value):
                raise AssertionError("delivery parsing must not hash a dispatch")

        session = Session()
        adapter = c.Adapter({"scenario": "cosmosnative"}, {})
        adapter.observe(session, observed)
        self.assertEqual(session.proofs[0][:4], ("first", message_id, "0x" + transaction_hash, 19))
        observed["response"]["result"]["tx_result"]["code"] = 1
        adapter.observe(session, observed)
        self.assertEqual(len(session.proofs), 1)

    def test_grpc_first_positive_precedes_unknown_broadcast_receipt_without_resetting_hold(self):
        from multivm_session import Lifecycle
        chain = {"bech32prefix": "hyp", "mailbox": "0x" + "11" * 32, "merkletreehook": "0x" + "22" * 32, "interchaingaspaymaster": "0x" + "33" * 32}
        message_id, transaction = "0x" + "44" * 32, "0x" + "55" * 32
        lifecycle = Lifecycle()

        class Session:
            keccak = None
            def chain_config(self, _): return chain
            def record_inclusion(self, name, identity, tx, ns, reference): lifecycle.included(identity, tx, name, ns)

        adapter = c.Adapter({"scenario": "cosmosnative"}, {})
        request = c.encoded(1, chain["mailbox"].encode()) + c.encoded(2, message_id.encode())
        observed = {"chain": "first", "role": "relayer", "status": 200, "wire_protocol": "grpc-h2", "received_monotonic_ns": 100, "request": {"method": "/hyperlane.core.v1.Query/Delivered", "protobuf": "0x" + request.hex(), "headers": {}}, "response": {"protobuf": "0x" + c.encoded(1, 1).hex(), "headers": {"x-cosmos-block-height": "10"}, "trailers": {"grpc-status": "0"}}}
        adapter.observe(Session(), observed)
        self.assertEqual(lifecycle.first[("first", message_id)]["first_positive_monotonic_ns"], 100)
        self.assertEqual(lifecycle.first[("first", message_id)]["transaction_hash"], "0x" + "00" * 32)
        emitted = {"type": "hyperlane.core.v1.EventProcess", "attributes": [{"key": "origin_mailbox_id", "value": json.dumps(chain["mailbox"])}, {"key": "message_id", "value": json.dumps(message_id)}]}
        later = {"chain": "first", "role": "relayer", "received_monotonic_ns": 100 + 5_000_000_000, "request": {"method": "tx", "params": {}}, "response": {"result": {"hash": transaction, "height": "10", "tx_result": {"code": 0, "events": [emitted]}}}}
        adapter.observe(Session(), later)
        self.assertEqual(lifecycle.first[("first", message_id)]["transaction_hash"], transaction)
        self.assertEqual(lifecycle.first[("first", message_id)]["first_positive_monotonic_ns"], 100)
        active = {"id": message_id, "operation": {"type": "PendingMessage", "message": {"version": 3, "nonce": 0, "origin": 1, "destination": 2, "sender": "0x" + "11" * 32, "recipient": "0x" + "22" * 32, "body": []}, "status": {"Confirm": "SubmittedBySelf"}, "submitted": True}}
        for second in range(600): lifecycle.sample({"first": [active]}, 100 + second * 1_000_000_000)
        lifecycle.sample({"first": []}, 100 + 600_000_000_000)
        proof = lifecycle.complete([("first", message_id)])[0]
        self.assertEqual(proof["retired_monotonic_ns"] - proof["first_positive_monotonic_ns"], 600_000_000_000)
        self.assertGreater(proof["early_active_samples"], 0)

    def test_grpc_delivered_shapes_false_unrelated_and_authority_height_negatives(self):
        vector = sdk("zig/src/cosmos/fixtures/sdk.json.gz")
        identity = "0x" + "44" * 32
        chain = {"bech32prefix": "cosmos", "mailbox": "0x" + vector["mailbox_id"]}
        native_request = c.encoded(1, chain["mailbox"].encode()) + c.encoded(2, identity.encode())
        wasm_request = c.encoded(1, vector["address"].encode()) + c.encoded(2, json.dumps({"mailbox": {"message_delivered": {"id": identity[2:]}}}).encode())

        class Session:
            keccak = None
            def __init__(self): self.proofs = []
            def chain_config(self, _): return chain
            def record_inclusion(self, *proof): self.proofs.append(proof)

        for native, path, request, positive, negative in [
            (True, "/hyperlane.core.v1.Query/Delivered", native_request, c.encoded(1, 1), b""),
            (False, "/cosmwasm.wasm.v1.Query/SmartContractState", wasm_request, c.encoded(1, b'{"delivered":true}'), c.encoded(1, b'{"delivered":false}')),
        ]:
            adapter, session = c.Adapter({"scenario": "cosmosnative" if native else "cosmwasm"}, {}), Session()
            event = {"chain": "first", "role": "relayer", "status": 200, "wire_protocol": "grpc-h2", "received_monotonic_ns": 1, "request": {"method": path, "protobuf": "0x" + request.hex(), "headers": {"x-cosmos-block-height": "10"}}, "response": {"protobuf": "0x" + positive.hex(), "headers": {"x-cosmos-block-height": "10"}, "trailers": {"grpc-status": "0"}}}
            adapter.observe(session, event)
            self.assertEqual(session.proofs[0][1], identity)
            false = copy.deepcopy(event); false["response"]["protobuf"] = "0x" + negative.hex()
            adapter.observe(session, false); self.assertEqual(len(session.proofs), 1)
            mutations = []
            bad = copy.deepcopy(event); bad["response"]["headers"]["x-cosmos-block-height"] = "11"; mutations.append(bad)
            bad = copy.deepcopy(event); bad["response"]["trailers"]["grpc-status"] = "13"; mutations.append(bad)
            bad = copy.deepcopy(event); bad["response"]["trailers"]["x-cosmos-block-height"] = "10"; mutations.append(bad)
            bad = copy.deepcopy(event); bad["response"]["protobuf"] = "0x" + (c.encoded(1, 2) if native else c.encoded(1, b'{"delivered":1}')).hex(); mutations.append(bad)
            wrong_request = c.encoded(1, ("0x" + "77" * 32 if native else c.encode_address(b"w" * 32, "cosmos")).encode()) + c.encoded(2, identity.encode() if native else json.dumps({"mailbox": {"message_delivered": {"id": identity}}}).encode())
            bad = copy.deepcopy(event); bad["request"]["protobuf"] = "0x" + wrong_request.hex(); mutations.append(bad)
            for bad in mutations:
                with self.assertRaises(ValueError): adapter.observe(session, bad)
            self.assertEqual(len(session.proofs), 1)
        wasm = c.Adapter({"scenario": "cosmwasm"}, {})
        self.assertIsNone(wasm.delivered_query(chain, "/cosmwasm.wasm.v1.Query/SmartContractState", c.encoded(1, vector["address"].encode()) + c.encoded(2, b'{"mailbox":{"nonce":{}}}'), b"not a delivered response"))

    def test_block_results_and_tx_search_positive_observation_keeps_transaction_local_positions(self):
        chain = {"bech32prefix": "hyp", "mailbox": "0x" + "11" * 32, "merkletreehook": "0x" + "22" * 32, "interchaingaspaymaster": "0x" + "33" * 32}
        identity = "0x" + "44" * 32
        emitted = {"type": "hyperlane.core.v1.EventProcess", "attributes": [{"key": "origin_mailbox_id", "value": json.dumps(chain["mailbox"])}, {"key": "message_id", "value": json.dumps(identity)}]}
        effects = {"code": 0, "events": [{"type": "unrelated"}, emitted]}
        class Session:
            keccak = None
            def __init__(self): self.proofs = []
            def chain_config(self, _): return chain
            def record_inclusion(self, *proof): self.proofs.append(proof)
        adapter, session = c.Adapter({"scenario": "cosmosnative"}, {}), Session()
        event = {"chain": "first", "role": "scraper", "received_monotonic_ns": 1, "request": {"method": "block_results"}, "response": {"result": {"height": "10", "txs_results": [{"code": 1}, effects]}}}
        adapter.observe(session, event)
        self.assertEqual(session.proofs[0][1:3], (identity, "0x" + "00" * 32))
        self.assertEqual(session.proofs[0][-1], {"api": "block_results", "height": 10, "transaction_index": 1, "event_index": 1})
        event["request"]["method"] = "tx_search"
        event["response"]["result"] = {"txs": [{"hash": "55" * 32, "height": "10", "tx_result": effects}]}
        adapter.observe(session, event)
        self.assertEqual(session.proofs[1][2], "0x" + "55" * 32)



if __name__ == "__main__":
    unittest.main()
