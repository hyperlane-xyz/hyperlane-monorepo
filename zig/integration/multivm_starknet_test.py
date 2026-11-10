"""Pure Starknet adapter controls. No SDK loading, network, nodes or processes."""
from __future__ import annotations
import copy
import contextlib
import hashlib
import importlib.util
import json
import pathlib
import random
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).parent
sys.path.insert(0, str(HERE))
import multivm_starknet as api


def keccak_stub(value):
    # Injected deterministic ID oracle for parser tests, NOT Keccak/chain credit.
    raw = bytes.fromhex(value[2:]) if value.startswith("0x") else value.encode()
    return "0x" + hashlib.sha256(raw).hexdigest()


def words(value):
    return [hex(value & (2 ** 128 - 1)), hex(value >> 128)]


def byte_words(value):
    return [hex(len(value)), hex((len(value) + 15) // 16)] + [hex(int.from_bytes(value[i:i + 16].ljust(16, b"\0"), "big")) for i in range(0, len(value), 16)]


def message(nonce=0, body=b"hello world"):
    return ["0x3", hex(nonce), hex(23448593)] + words(int(api.ACCOUNT, 16)) + [hex(23448594)] + words(9) + byte_words(body)


def transaction(calldata=None):
    return {"type": "INVOKE", "version": "0x3", "sender_address": api.ACCOUNT, "calldata": calldata or ["0x1", "0x2", "0x3", "0x0"], "signature": ["0x4", "0x5"], "nonce": "0x6", "resource_bounds": {key: {"max_amount": "0x2", "max_price_per_unit": "0x3"} for key in ("l1_gas", "l2_gas", "l1_data_gas")}, "tip": "0x1", "paymaster_data": [], "account_deployment_data": [], "nonce_data_availability_mode": "L1", "fee_data_availability_mode": "L1"}


def case():
    names = ["starknettest23448593", "starknettest23448594"]
    return {"chain_names": names, "domain_names": {str(23448593 + i): name for i, name in enumerate(names)}, "relayer_addresses": {name: api.ACCOUNT for name in names}, "validator_addresses": {name: "0x" + "11" * 20 for name in names}, "initial_corpus": {"dispatches": 10, "deliveries": 10, "failed_body": 0, "zero_insertions": 0, "double_insertions": 10}, "additional_refused_dispatches": 0}


def quote(weights):
    members = [{"operation_id": "0x" + bytes([i + 1] * 32).hex(), "origin": 23448593, "origin_hook": "0x" + "22" * 32, "generation": 1, "source_intent_digest": "0x" + bytes([i + 9] * 32).hex(), "gas_limit": weight, "estimated_cost": str(2 ** 240 + i + 1)} for i, weight in enumerate(weights)]
    return {"starknet": {"gas_limit": weights[0], "estimated_cost": members[0]["estimated_cost"], "batch": {"version": 1, "members": members} if len(weights) > 1 else None}}


class MemorySession:
    """In-memory independent envelope fixture; no chain/SDK evidence credit."""
    def __init__(self):
        self.case = case()
        self.names = self.case["chain_names"]
        self.chains = {name: {"protocol": "starknet", "domainid": 23448593 + i, "mailbox": hex(2 + i), "merkletreehook": hex(4 + i), "interchaingaspaymaster": "0x0", "maxbatchsize": 10, "blocks": {"reorgperiod": 1}} for i, name in enumerate(self.names)}
        self.captures = [{"original": {"role": "relayer", "chains": self.chains}, "proxied": {"role": "relayer", "chains": self.chains}}]
        self.self_transactions, self.broadcasts, self.inclusions = set(), [], []
        self.receipts, self.transactions, self.events = {}, {}, {name: [] for name in self.names}
        self.requests = []
        self.messages = []
        for nonce in range(10):
            decoder = api.Cairo(message(nonce))
            parsed = decoder.message(self.keccak)
            decoder.finish()
            self.messages.append(parsed)
            dispatch = self.event(self.names[0], "Dispatch", words(int(api.ACCOUNT, 16)) + [hex(23448594)] + words(9) + message(nonce))
            others = [self.event(self.names[0], "DispatchId", words(int(parsed["id"], 16))), self.event(self.names[0], "InsertedIntoTree", words(int(parsed["id"], 16)) + [hex(2 * nonce)], hook=True), self.event(self.names[0], "InsertedIntoTree", words(int(parsed["id"], 16)) + [hex(2 * nonce + 1)], hook=True)]
            tx = transaction();tx["transaction_hash"] = hex(1000 + nonce)
            self.add_transaction(self.names[0], tx, [dispatch] + others, 2)
        for ordinal, subset in enumerate([self.messages[:4], self.messages[4:]]):
            encoded = [hex(len(subset))]
            for parsed in subset:
                raw = byte_words(b"public metadata") + message(parsed["nonce"])
                encoded.extend([self.chains[self.names[1]]["mailbox"], hex(self.selector("process")), hex(len(raw))] + raw)
            tx = transaction(encoded)
            tx.update(transaction_hash=hex(2000 + ordinal), nonce=hex(ordinal))
            events = [self.event(self.names[1], "ProcessId", words(int(parsed["id"], 16))) for parsed in subset]
            self.add_transaction(self.names[1], tx, events, 3)
            self.record_broadcast(self.names[1], api.full(tx["transaction_hash"]), hashlib.sha256(api.signed_wire(tx)).hexdigest(), [item["id"] for item in subset])

    def selector(self, name): return int(self.keccak(name), 16) & api.MASK250
    def keccak(self, value): return keccak_stub(value)
    def block(self, name, height):
        txs = [identity for (chain, identity), receipt in self.receipts.items() if chain == name and receipt["block_number"] == height]
        return {"status": "ACCEPTED_ON_L2", "block_number": height, "block_hash": hex(500 + height + self.names.index(name) * 100), "transactions": txs}
    def event(self, name, selector, data, hook=False):
        chain = self.chains[name]
        return {"from_address": chain["merkletreehook" if hook else "mailbox"], "keys": [hex(self.selector(selector))], "data": data}
    def add_transaction(self, name, tx, events, height):
        identity = api.full(tx["transaction_hash"])
        self.transactions[name, identity] = tx
        receipt = {"transaction_hash": identity, "finality_status": "ACCEPTED_ON_L2", "execution_status": "SUCCEEDED", "block_number": height, "block_hash": self.block(name, height)["block_hash"], "events": events, "actual_fee": {"amount": "0x65", "unit": "FRI"}}
        self.receipts[name, identity] = receipt
        for event in events:
            self.events[name].append(dict(event, transaction_hash=identity, block_number=height, block_hash=receipt["block_hash"]))
    def rpc(self, name, method, params):
        self.requests.append((name, method, copy.deepcopy(params)))
        if method == "starknet_chainId": return hex(100 + self.names.index(name))
        if method == "starknet_blockNumber": return 8
        if method == "starknet_getBlockWithTxHashes": return copy.deepcopy(self.block(name, params["block_id"]["block_number"]))
        if method == "starknet_getTransactionReceipt": return copy.deepcopy(self.receipts[name, api.full(params["transaction_hash"])])
        if method == "starknet_getTransactionByHash": return copy.deepcopy(self.transactions[name, api.full(params["transaction_hash"])])
        if method == "starknet_getEvents":
            request = params["filter"]
            events = [row for row in self.events[name] if api.full(row["from_address"]) == api.full(request["address"]) and [api.felt(v) for v in row["keys"]] == [api.felt(request["keys"][0][0])]]
            return {"events": copy.deepcopy(events), "continuation_token": ""}
        if method == "starknet_call":
            return ["0x9"] if api.felt(params["request"]["entry_point_selector"]) == self.selector("get_public_key") else ["0x1"]
        if method == "starknet_getNonce": return "0x0" if params["block_id"]["block_number"] < 3 else "0x2"
        raise AssertionError((method, params))
    def record_broadcast(self, chain, identity, digest, message_ids=None):
        self.self_transactions.add((chain, identity))
        self.broadcasts.append({"chain": chain, "transaction_hash": identity, "raw_transaction_sha256": digest, "message_ids": message_ids})
    def record_inclusion(self, chain, message_id, identity, ns, reference):
        self.inclusions.append((chain, message_id, identity, ns, reference))
    def rows(self, snapshot):
        result = []
        for entry in snapshot["native_delivery_transactions"]:
            ids = entry["proof"]["message_ids"]
            weights = list(range(1, len(ids) + 1))
            fees, _ = api.allocated_fees(entry["proof"]["actual_fee"], weights)
            members = [{"operation_id": identity, "origin": 23448593, "origin_hook": api.full("0x4"), "generation": 1, "source_intent_digest": "0x" + bytes([index + 1] * 32).hex(), "gas_limit": weight, "estimated_cost": str(2 ** 240 + index)} for index, (identity, weight) in enumerate(zip(ids, weights))]
            raw = api.signed_wire(entry["proof"]["transaction"])
            for identity, member, fee in zip(ids, members, fees):
                message = next(row for row in snapshot["messages"] if row["id"] == identity)
                operation = {"stage": "delivered", "confirmation_started": True, "kind": "process", "target": None, "generation": 1, "nonce": message["nonce"], "origin": 23448593, "destination": 23448594, "identity": {"kind": "hash256", "hex": entry["transaction_hash"]}, "signed": {"bytes": len(raw), "sha256": "0x" + hashlib.sha256(raw).hexdigest()}, "context": "0x" + "33" * 32, "expected_context_checked": False,
                    "authority": {"protocol": "starknet", "origin": 23448593, "destination": 23448594, "mailbox": api.full("0x3"), "chain_id": "0x65", "origin_hook": api.full("0x4"), "operation_id": identity, "generation": 1, "kind": "process", "target": None},
                    "starknet": {"gas_limit": member["gas_limit"], "estimated_cost": member["estimated_cost"], "batch": {"version": 1, "members": copy.deepcopy(members)}}, "expenditure": {"present": True, "gas_used_hex": "0x" + fee.to_bytes(32, "big").hex(), "tokens_used_hex": "0x" + fee.to_bytes(32, "big").hex()}}
                result.append({"id": identity, "present": True, "operation": operation})
        return result


class SignatureSpy:
    def __init__(self): self.calls = []
    def verify(self, public, digest, signature): self.calls.append((public, digest, signature))


class PureTests(unittest.TestCase):
    def test_import_and_constructor_cannot_start_external_effects(self):
        with mock.patch("socket.socket", side_effect=AssertionError("network")), mock.patch("subprocess.Popen", side_effect=AssertionError("process")), mock.patch("ctypes.CDLL", side_effect=AssertionError("SDK")), mock.patch("threading.Thread", side_effect=AssertionError("thread")):
            spec = importlib.util.spec_from_file_location("starknet_adapter_no_effects", HERE / "multivm_starknet.py")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            module.Adapter({"scenario": "starknet"}, case()).validate_case()

    def test_felt_bounds_canonical_fullwidth_and_invalid_syntax(self):
        self.assertEqual(api.full(hex(api.PRIME - 1)), "0x" + (api.PRIME - 1).to_bytes(32, "big").hex())
        self.assertEqual(api.full("0x000A"), api.full("0xa"))
        for value in [hex(api.PRIME), "0x", "-1", "0X1", "0x-1", "0x1g", True, 1]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                api.felt(value)

    def test_cairo_message_pinned_wire_and_domain_layout(self):
        raw = message(7)
        decoder = api.Cairo(raw)
        parsed = decoder.message(keccak_stub)
        decoder.finish()
        wire = bytes([3]) + (7).to_bytes(4, "big") + (23448593).to_bytes(4, "big") + bytes.fromhex(api.full(api.ACCOUNT)[2:]) + (23448594).to_bytes(4, "big") + (9).to_bytes(32, "big") + b"hello world"
        self.assertEqual(parsed["wire"], "0x" + wire.hex())
        self.assertEqual(parsed["id"], keccak_stub("0x" + wire.hex()))
        self.assertEqual((parsed["nonce"], parsed["origin"], parsed["destination"]), (7, 23448593, 23448594))

    def test_seeded_cairo_byte_inverse_and_every_truncation(self):
        rng = random.Random(0x434149524f)
        for size in [0, 1, 15, 16, 17, 31, 32, 33] + [rng.randrange(0, 400) for _ in range(100)]:
            raw = rng.randbytes(size)
            encoded = byte_words(raw)
            decoder = api.Cairo(encoded)
            self.assertEqual(decoder.bytes(), raw)
            decoder.finish()
            for cut in range(len(encoded)):
                with self.assertRaises(ValueError):
                    api.Cairo(encoded[:cut]).bytes()
        for encoded in [["0x1", "0x1", "0x1"], ["0x0", "0x1", "0x0"], ["0x10", "0x2", "0x0", "0x0"]]:
            with self.assertRaises(ValueError):
                api.Cairo(encoded).bytes()

    def test_modern_legacy_call_encoding_and_trailing_offset_rejections(self):
        modern = ["0x2", "0x2", "0x3", "0x2", "0x4", "0x5", "0x6", "0x7", "0x1", "0x8"]
        legacy = ["0x2", "0x2", "0x3", "0x0", "0x2", "0x6", "0x7", "0x2", "0x1", "0x3", "0x4", "0x5", "0x8"]
        self.assertEqual(api.calls(modern), api.calls(legacy, "legacy"))
        for encoded, mode in [(modern + ["0x0"], "modern"), (legacy + ["0x0"], "legacy"), (modern[:-1], "modern"), (legacy[:7] + ["0x0"] + legacy[8:], "legacy")]:
            with self.assertRaises(ValueError):
                api.calls(encoded, mode)

    def test_exact_process_target_selector_wire_and_no_trailing_felts(self):
        call = {"target": api.full("0x2"), "selector": 3, "calldata": byte_words(b"metadata") + message()}
        parsed, metadata = api.process(call, "0x2", 3, keccak_stub)
        self.assertEqual(metadata, b"metadata")
        self.assertEqual(parsed["nonce"], 0)
        for field, value in [("target", api.full("0x4")), ("selector", 5), ("calldata", call["calldata"] + ["0x0"])]:
            bad = dict(call, **{field: value})
            with self.assertRaises(ValueError):
                api.process(bad, "0x2", 3, keccak_stub)

    def test_source_signed_json_order_and_query_sponsor_signature_rejection(self):
        tx = transaction()
        raw = api.signed_wire(tx)
        self.assertEqual(list(json.loads(raw)), ["type", "version", "sender_address", "calldata", "signature", "nonce", "resource_bounds", "tip", "paymaster_data", "account_deployment_data", "nonce_data_availability_mode", "fee_data_availability_mode"])
        self.assertEqual(raw, api.signed_wire(dict(reversed(list(tx.items())))))
        for field, value in [("version", hex(3 + 2 ** 128)), ("signature", ["0x1"]), ("paymaster_data", ["0x1"]), ("nonce_data_availability_mode", "L2"), ("tip", hex(2 ** 64))]:
            bad = copy.deepcopy(tx)
            bad[field] = value
            with self.assertRaises(ValueError):
                api.signed_wire(bad)
        bad = copy.deepcopy(tx)
        bad["resource_bounds"]["l1_data_gas"]["max_price_per_unit"] = hex(2 ** 128)
        with self.assertRaises(ValueError):
            api.signed_wire(bad)

    def test_invoke_hash_domain_resource_dimensions_and_query_exclusion(self):
        class Primitive:
            def __init__(self): self.inputs = []
            def poseidon(self, values):
                self.inputs.append(values)
                return len(self.inputs)
        native = Primitive()
        self.assertEqual(api.invoke_hash(transaction(), 99, native), 4)
        self.assertEqual(native.inputs[0], [])
        self.assertEqual(native.inputs[1], [1] + [(int.from_bytes(tag, "big") << 192) | (2 << 128) | 3 for tag in (b"L1_GAS", b"L2_GAS", b"L1_DATA")])
        self.assertEqual(native.inputs[2], [1, 2, 3, 0])
        self.assertEqual(native.inputs[3], [int.from_bytes(b"invoke", "big"), 3, int(api.ACCOUNT, 16), 2, 1, 99, 6, 0, 1, 3])

    def test_safe_public_quote_has_exact_large_decimal_and_strict_member_binding(self):
        q = quote([1, 3, 0])
        self.assertEqual(api.public_quote(q, 3), q["starknet"])
        self.assertEqual(api.decimal_u256(q["starknet"]["estimated_cost"]), 2 ** 240 + 1)
        self.assertIsNone(api.public_quote(quote([1]), 1)["batch"])
        for value in [1.25, 1, "01", "-1", "1e4", "1.0", str(2 ** 256), "١"]:
            with self.subTest(value=value), self.assertRaises(ValueError): api.decimal_u256(value)
        mutations = [lambda x: x["starknet"].pop("estimated_cost"), lambda x: x["starknet"]["batch"]["members"].pop(), lambda x: x["starknet"]["batch"]["members"][1].__setitem__("operation_id", x["starknet"]["batch"]["members"][0]["operation_id"]), lambda x: x["starknet"]["batch"]["members"][0].__setitem__("gas_limit", -1), lambda x: x["starknet"]["batch"]["members"][0].__setitem__("authorization", "forbidden")]
        for mutate in mutations:
            bad = copy.deepcopy(q)
            mutate(bad)
            with self.assertRaises(ValueError): api.public_quote(bad, 3)
        with self.assertRaises(ValueError): api.public_quote({}, 3)
        with self.assertRaises(ValueError): api.public_quote(q, 1)

    def test_fee_floor_conservation_scale_and_permutation_properties(self):
        self.assertEqual(api.allocated_fees(101, [1, 3, 0]), ([25, 75, 0], 1))
        self.assertEqual(api.allocated_fees(2 ** 256 - 1, [1]), ([2 ** 256 - 1], 0))
        rng = random.Random(0x464545)
        for _ in range(500):
            fee = rng.randrange(0, 2 ** 256)
            weights = [rng.randrange(0, 2 ** 40) for _ in range(rng.randrange(1, 25))]
            weights[rng.randrange(len(weights))] += 1
            shares, dust = api.allocated_fees(fee, weights)
            self.assertEqual(sum(shares) + dust, fee)
            self.assertTrue(0 <= dust < len(weights))
            self.assertEqual(api.allocated_fees(fee, [w * 3 for w in weights]), (shares, dust))
            order = list(range(len(weights)))
            rng.shuffle(order)
            permuted, other_dust = api.allocated_fees(fee, [weights[i] for i in order])
            self.assertEqual(permuted, [shares[i] for i in order])
            self.assertEqual(other_dust, dust)
        for weights in [[], [0], [0, 0], [-1, 1], [2 ** 64]]:
            with self.assertRaises(ValueError): api.allocated_fees(1, weights)

    def test_source_case_and_endpoint_capability_fail_closed(self):
        adapter = api.Adapter({"scenario": "starknet"}, case())
        adapter.validate_case()
        self.assertFalse(adapter.payments_supported)
        self.assertEqual(adapter.transport("customrpcurls"), "http-json")
        for field in ["grpcurls", "walleturls", "ws", "unknown"]:
            with self.assertRaises(ValueError): adapter.transport(field)
        for key, value in [("additional_refused_dispatches", 1), ("initial_corpus", {})]:
            bad = case();bad[key] = value
            with self.assertRaises(ValueError): api.Adapter({"scenario": "starknet"}, bad).validate_case()


    def test_complete_collection_uses_exact_canonical_receipts_and_shared_members(self):
        session = MemorySession();adapter = api.Adapter({"scenario": "starknet"}, case())
        result = adapter.collect(session, 10, "initial")
        self.assertEqual(len(result["messages"]), 10)
        self.assertEqual([len(row["proof"]["message_ids"]) for row in result["native_delivery_transactions"]], [4, 6])
        self.assertTrue(all(row["dispatch_log_index"] == 0 and row["insertions"] == [2 * row["nonce"], 2 * row["nonce"] + 1] and not row["payments"] for row in result["messages"]))
        self.assertEqual(result["actual_chain_ids"], dict(zip(session.names, ["0x64", "0x65"])))
        self.assertEqual(adapter.collect(session, 10, "after_restart"), result)
        self.assertTrue(any(method == "starknet_call" and "block_number" in params["block_id"] for _, method, params in session.requests))

    def test_source_double_hook_requires_exact_two_distinct_canonical_insertions_per_message(self):
        session=MemorySession();adapter=api.Adapter({"scenario":"starknet"},case());snapshot=adapter.collect(session,10,"initial")
        self.assertEqual(sorted(index for row in snapshot["messages"] for index in row["insertions"]),list(range(20)))
        self.assertTrue(all(len(row["insertion_metadata"])==2 for row in snapshot["messages"]))
        for count in (0,1,3):
            bad=case();bad["initial_corpus"]["double_insertions"]=count
            with self.assertRaises(ValueError):api.Adapter({"scenario":"starknet"},bad).validate_case()

    def test_double_hook_missing_extra_duplicate_index_wrong_emitter_and_DispatchId_refuse(self):
        changes={
            "missing insertion":lambda rows:rows.pop(3),
            "third insertion":lambda rows:rows.append(copy.deepcopy(rows[2])),
            "repeated index":lambda rows:rows[3].update(data=copy.deepcopy(rows[2]["data"])),
            "wrong emitter":lambda rows:rows[3].update(from_address="0x999"),
            "wrong message":lambda rows:rows[3].update(data=words(99)+["0x1"]),
            "missing DispatchId":lambda rows:rows.pop(1),
            "repeated DispatchId":lambda rows:rows.append(copy.deepcopy(rows[1])),
            "global sequence gap":lambda rows:rows[3].update(data=rows[3]["data"][:2]+["0x14"]),
        }
        for name,change in changes.items():
            session=MemorySession();first=next(iter(session.receipts.values()));change(first["events"])
            with self.subTest(name=name),self.assertRaises(ValueError):api.Adapter({"scenario":"starknet"},case()).collect(session,10,"initial")

    def test_collection_rejects_noncanonical_receipts_repeated_ids_and_foreign_calls(self):
        def bad_receipt(s): next(iter(s.receipts.values()))["block_hash"] = "0x999"
        def duplicate_event(s): s.events[s.names[0]].append(copy.deepcopy(s.events[s.names[0]][0]))
        def wrong_call(s): s.transactions[s.names[1], api.full("0x7d0")]["calldata"][1] = "0x99"
        def foreign_self(s): s.self_transactions.clear()
        def bad_network(s): s.chains[s.names[0]]["chainid"] = "0x999"
        def reverted(s): next(iter(s.receipts.values()))["execution_status"] = "REVERTED"
        for mutate in [bad_receipt, duplicate_event, wrong_call, foreign_self, bad_network, reverted]:
            session=MemorySession();mutate(session)
            with self.subTest(mutation=mutate.__name__), self.assertRaises(ValueError):
                api.Adapter({"scenario":"starknet"},case()).collect(session,10,"initial")

    def test_receipt_fence_and_pagination_reject_reorg_or_token_cycle(self):
        session=MemorySession();original=session.rpc;calls=0
        def moving(name,method,params):
            nonlocal calls
            value=original(name,method,params)
            if method=="starknet_getBlockWithTxHashes":
                calls+=1
                if calls==2:value["block_hash"]="0x999"
            return value
        session.rpc=moving
        with self.assertRaises(ValueError): api.Adapter({"scenario":"starknet"},case())._receipt(session,session.names[0],"0x3e8",7)
        session.rpc=lambda *args:{"events":[],"continuation_token":"same-token"}
        with self.assertRaises(ValueError): api.Adapter({"scenario":"starknet"},case())._events(session,session.names[0],"0x2",3,7)

    def test_stopped_rows_bind_all_siblings_exact_wire_and_floor_dust(self):
        session=MemorySession();adapter=api.Adapter({"scenario":"starknet"},case());snapshot=adapter.collect(session,10,"initial")
        spy=SignatureSpy();adapter.native=spy
        with mock.patch.object(api,"invoke_hash",side_effect=lambda tx,*_:api.felt(tx["transaction_hash"])):
            proofs=adapter.native_rows(session,snapshot,session.rows(snapshot),None)
        self.assertEqual(len(proofs),10)
        self.assertEqual(len(spy.calls),2)
        for entry in snapshot["native_delivery_transactions"]:
            siblings=[row for row in proofs if row["identity"]==entry["transaction_hash"]]
            self.assertEqual(sum(row["allocated_fee"] for row in siblings)+siblings[0]["rounding_dust"],101)
        self.assertTrue(all(row["configuration_authority_verified"] is False and "no original scalar RPC" in row["allocation_evidence"] for row in proofs))

    def test_stopped_rows_fail_closed_on_manifest_authority_fee_wire_and_missing_sibling(self):
        def bad_wire(rows):rows[0]["operation"]["signed"]["sha256"]="0x"+"00"*32
        def bad_fee(rows):rows[0]["operation"]["expenditure"]["tokens_used_hex"]="0x"+"00"*32
        def bad_origin(rows):rows[0]["operation"]["authority"]["origin"]=1
        def bad_member(rows):rows[0]["operation"]["starknet"]["batch"]["members"].reverse()
        def bad_quote(rows):rows[0]["operation"]["starknet"]["estimated_cost"]="1"
        def missing(rows):rows.pop()
        for mutate in [bad_wire,bad_fee,bad_origin,bad_member,bad_quote,missing]:
            session=MemorySession();adapter=api.Adapter({"scenario":"starknet"},case());snapshot=adapter.collect(session,10,"initial");adapter.native=SignatureSpy();rows=session.rows(snapshot);mutate(rows)
            with self.subTest(mutation=mutate.__name__),mock.patch.object(api,"invoke_hash",side_effect=lambda tx,*_:api.felt(tx["transaction_hash"])),self.assertRaises(ValueError):
                adapter.native_rows(session,snapshot,rows,None)

    def test_observed_native_receipt_and_earlier_delivered_keep_exact_self_identity(self):
        session=MemorySession();adapter=api.Adapter({"scenario":"starknet"},case());chain=session.names[1];identity=api.full("0x7d0");tx=session.transactions[chain,identity];ids=session.broadcasts[0]["message_ids"]
        def event(method,params,value,time):return {"status":200,"endpoint_field":"rpcurls","chain":chain,"role":"relayer","received_monotonic_ns":time,"request":{"id":1,"method":method,"params":params},"response":{"id":1,"result":value}}
        delivered={"request":{"contract_address":"0x3","entry_point_selector":hex(session.selector("delivered")),"calldata":words(int(ids[0],16))},"block_id":"latest"}
        adapter.observe(session,event("starknet_call",delivered,["0x1"],100))
        self.assertEqual(session.inclusions[-1][2],"0x"+"00"*32)
        adapter.observe(session,event("starknet_getTransactionReceipt",{"transaction_hash":identity},session.receipts[chain,identity],200))
        self.assertEqual({row[1] for row in session.inclusions[1:]},set(ids))
        self.assertTrue(all(row[2]==identity for row in session.inclusions[1:]))
        adapter.observe(session,event("starknet_addInvokeTransaction",{"invoke_transaction":tx},{"transaction_hash":identity},300))
        self.assertEqual(session.broadcasts[-1]["message_ids"],ids)


    def test_publications_bind_all_metadata_native_hook_roots_signer_and_bytes(self):
        with tempfile.TemporaryDirectory(prefix="ziggy-starknet-pure-publications-") as root:
            session=MemorySession();manifest={"scenario":"starknet","task_root":root,"runtime_source_commit":"a"*40};adapter=api.Adapter(manifest,case());snapshot=adapter.collect(session,10,"initial")
            session.owned_path=lambda relative:pathlib.Path(root)/relative
            for name in session.names:
                directory=pathlib.Path(root)/name;directory.mkdir()
                chain=dict(session.chains[name],rpcurls=[{"http":"http://127.0.0.1:5050"}])
                original={"role":"validator","role_chain_names":[name],"chains":{name:chain},"checkpoint_syncer":{"type":"localStorage","path":str(directory)},"allows_public_rpcs":True}
                session.captures.append({"original":original,"proxied":copy.deepcopy(original)})
                metadata={"git_sha":"a"*40,"rpcs":[{"url_hash":session.keccak("http://127.0.0.1:5050"),"host_hash":session.keccak("127.0.0.1")}],"allows_public_rpcs":True}
                (directory/"metadata_latest.json").write_text(json.dumps(metadata))
                leaves=api.merkle_roots([row for row in snapshot["messages"] if row["origin_chain"]==name],session.keccak)
                if leaves:
                    leaf=leaves[-1];checkpoint={"merkle_tree_hook_address":api.full(chain["merkletreehook"]),"mailbox_domain":chain["domainid"],"root":leaf["root"],"index":leaf["index"]}
                    (directory/f'{leaf["index"]}_with_id.json').write_text(json.dumps({"value":{"checkpoint":checkpoint,"message_id":leaf["message_id"]},"signature":{"r":1,"s":2,"v":27}}))
            with mock.patch.object(api,"recover_signature",return_value="0x"+"11"*20) as recover:
                result=adapter.checkpoints(session,snapshot)
            self.assertEqual(len(result),2);self.assertEqual(recover.call_count,1)
            self.assertEqual([len(row["published_bytes"]) for row in result],[1,0])
            for row in result:
                for obj in row["published_bytes"]:
                    raw=pathlib.Path(obj["path"]).read_bytes();self.assertEqual(obj["bytes"],len(raw));self.assertEqual(obj["sha256"],hashlib.sha256(raw).hexdigest())
            path=pathlib.Path(root)/session.names[0]/"19_with_id.json";original=path.read_text();bad=json.loads(original);bad["value"]["checkpoint"]["merkle_tree_hook_address"]=api.full("0x99");path.write_text(json.dumps(bad))
            with mock.patch.object(api,"recover_signature",return_value="0x"+"11"*20),self.assertRaises(ValueError):adapter.checkpoints(session,snapshot)
            path.write_text(original)
            with mock.patch.object(api,"recover_signature",return_value="0x"+"22"*20),self.assertRaises(ValueError):adapter.checkpoints(session,snapshot)
            (pathlib.Path(root)/session.names[1]/"0_with_id.json").write_text(original)
            with mock.patch.object(api,"recover_signature",return_value="0x"+"11"*20),self.assertRaises(ValueError):adapter.checkpoints(session,snapshot)

    def test_sql_requires_linked_origin_destination_rows_and_no_invented_IGP(self):
        session=MemorySession();adapter=api.Adapter({"scenario":"starknet"},case());snapshot=adapter.collect(session,10,"initial");queries=[]
        def query(name,sql):
            queries.append((name,sql))
            if "FROM message m" in sql:
                message=next(row for row in snapshot["messages"] if row["id"][2:] in sql)
                return f'1|0|0|0|{2 * message["nonce"]},{2 * message["nonce"] + 1}'
            return "1"
        session.query_sql=query
        result=adapter.sql(session,snapshot)
        self.assertEqual(len(result),10);self.assertEqual(len(queries),60)
        self.assertEqual({name for name,_ in queries},set(session.names))
        self.assertTrue(all('JOIN "transaction"' in sql and "decode(" in sql for _,sql in queries))
        session.query_sql=lambda name,sql:query(name,sql) if "FROM message m" in sql else "0"
        with self.assertRaises(ValueError):adapter.sql(session,snapshot)
        snapshot["messages"][0]["payments"]=[{"gas_amount":1,"payment":1}]
        with self.assertRaises(ValueError):adapter.sql(session,snapshot)

    def test_readiness_requires_new_all_role_captures_and_rechecks_native_publications(self):
        session=MemorySession();adapter=api.Adapter({"scenario":"starknet"},case())
        def epoch(first):
            roles=[("relayer",session.names),("validator",[session.names[0]]),("validator",[session.names[1]]),("scraper",session.names)]
            return [{"capture_ordinal":first+i,"captured_monotonic_ns":(first+i+1)*1000,"original":{"role":role,"role_chain_names":names,"chains":session.chains}} for i,(role,names) in enumerate(roles)]
        before,after=epoch(0),epoch(4)
        # Exactly the Session.after_restart split: four old, four new.
        self.assertEqual(len(before),len(after))
        with mock.patch.object(adapter,"collect",return_value={"messages":[{}]*10,"deliverable_messages":[{}]*10}) as collect,mock.patch.object(adapter,"checkpoints",return_value=[{"publications":"explicit-test-stub"}]) as checkpoints:
            result=adapter.readiness(session,before,after)
            self.assertEqual(result["actual_native_deliveries"],10);collect.assert_called_once_with(session,10,"after_restart");checkpoints.assert_called_once()
        wrongrole=copy.deepcopy(after);wrongrole[-1]["original"]["role"]="validator"
        wrongorigin=copy.deepcopy(after);wrongorigin[2]["original"]["role_chain_names"]=[session.names[0]]
        wrongcoverage=copy.deepcopy(after);wrongcoverage[0]["original"]["role_chain_names"]=[session.names[0]]
        for invalid in [[],before,after[:-1],before+after,wrongrole,wrongorigin,wrongcoverage]:
            with self.subTest(captures=invalid),self.assertRaises(ValueError):adapter.readiness(session,before,invalid)

    def test_authenticated_event_coordinates_ignore_page_order(self):
        session=MemorySession()
        session.events[session.names[0]].reverse()
        adapter=api.Adapter({"scenario":"starknet"},case());snapshot=adapter.collect(session,10,"initial")
        for message in snapshot["messages"]:
            nonce=message["nonce"];dispatch=message["dispatch_metadata"];insertion=message["insertion_metadata"][0];delivery=message["delivery_metadata"]
            self.assertEqual((dispatch["block_number"],dispatch["transaction_index"],dispatch["log_index"],dispatch["emitter"]),(2,nonce,0,api.full("0x2")))
            self.assertEqual((insertion["block_hash"],insertion["transaction_hash"],insertion["log_index"],insertion["emitter"]),(dispatch["block_hash"],dispatch["transaction_hash"],2,api.full("0x4")))
            self.assertEqual((delivery["block_number"],delivery["transaction_index"],delivery["log_index"],delivery["emitter"]),(3,int(nonce>=4),nonce if nonce<4 else nonce-4,api.full("0x3")))
            self.assertEqual(delivery["transaction_hash"],message["delivery_transaction"])
            self.assertEqual(message["payment_metadata"],[])

    def test_actual_adapter_queries_reject_right_ids_at_wrong_stored_coordinates(self):
        session=MemorySession();adapter=api.Adapter({"scenario":"starknet"},case());snapshot=adapter.collect(session,10,"initial")
        specs=[("dispatch","confirmed_raw_message_dispatch","origin_domain","msg_id","origin_block_hash","origin_block_height","origin_tx_hash","origin_mailbox"),("insertion","confirmed_merkle_tree_insertion","domain","message_id","block_hash","block_number","transaction_hash","merkle_tree_hook"),("delivery","confirmed_delivered_message","domain","msg_id","block_hash","block_number","transaction_hash","destination_mailbox")]
        with contextlib.closing(sqlite3.connect(":memory:")) as database:
            database.create_function("decode",2,lambda value,encoding:bytes.fromhex(value) if encoding=="hex" else None)
            database.execute('CREATE TABLE block(id integer,domain integer,hash blob,height integer)')
            database.execute('CREATE TABLE "transaction"(hash blob,block_id integer)')
            for ordinal,name,height in [(1,session.names[0],2),(2,session.names[1],3)]:
                block=session.block(name,height);database.execute('INSERT INTO block VALUES(?,?,?,?)',(ordinal,session.chains[name]["domainid"],bytes.fromhex(api.full(block["block_hash"])[2:]),height))
                for identity in block["transactions"]:database.execute('INSERT INTO "transaction" VALUES(?,?)',(bytes.fromhex(identity[2:]),ordinal))
            for kind,table,domain,idcol,block,height,tx,emitter in specs:
                database.execute(f'CREATE TABLE {table}({domain} integer,{idcol} blob,{block} blob,{height} integer,{tx} blob,transaction_index integer,log_index integer,{emitter} blob)')
                # Build persisted coordinates independently from the fixture's
                # raw receipt/block sequence, not the adapter metadata fields.
                for message in session.messages:
                    nonce=message["nonce"];is_delivery=kind=="delivery";name=session.names[int(is_delivery)];block_height=3 if is_delivery else 2
                    tx_index=int(nonce>=4) if is_delivery else nonce;identity=api.full(hex(2000+tx_index if is_delivery else 1000+nonce));event_index=(nonce if nonce<4 else nonce-4) if is_delivery else (2 if kind=="insertion" else 0)
                    address="0x4" if kind=="insertion" else ("0x3" if is_delivery else "0x2")
                    for exact_index in ([2,3] if kind=="insertion" else [event_index]):
                        database.execute(f'INSERT INTO {table} VALUES(?,?,?,?,?,?,?,?)',(session.chains[name]["domainid"],bytes.fromhex(message["id"][2:]),bytes.fromhex(api.full(session.block(name,block_height)["block_hash"])[2:]),block_height,bytes.fromhex(identity[2:]),tx_index,exact_index,bytes.fromhex(api.full(address)[26:])))
            def query(name,text):
                if " e JOIN " in text:return str(database.execute(text).fetchone()[0])
                if "FROM message m" in text:
                    message=next(row for row in session.messages if row["id"][2:] in text)
                    return f'1|0|0|0|{2 * message["nonce"]},{2 * message["nonce"] + 1}'
                return "1"
            session.query_sql=query
            self.assertEqual(len(adapter.sql(session,snapshot)),10)
            for kind,table,domain,idcol,block,height,tx,emitter in specs:
                for column,wrong in [("transaction_index",99),("log_index",99),(height,99),(block,b"wrong"),(tx,b"wrong"),(emitter,b"wrong"),(domain,1)]:
                    database.execute("SAVEPOINT wrong_coordinate");database.execute(f'UPDATE {table} SET {column}=?',(wrong,))
                    with self.subTest(kind=kind,column=column),self.assertRaises(ValueError):adapter.sql(session,snapshot)
                    database.execute("ROLLBACK TO wrong_coordinate");database.execute("RELEASE wrong_coordinate")


class PreconfirmedObserverControls(unittest.TestCase):
    def setUp(self):
        # Actual Session callback/recording methods, with only I/O replaced by RAM.
        import threading
        import multivm_session as sessions
        self.sessions = sessions
        self.memory = MemorySession()
        self.session = sessions.Session.__new__(sessions.Session)
        self.session.lock = threading.RLock()
        self.session.manifest = {"scenario": "starknet"}
        self.session.family = api.Adapter(self.session.manifest, case())
        self.session.captures = copy.deepcopy(self.memory.captures)
        self.session.captures[0]["captured_monotonic_ns"] = 1
        self.session.captures[0]["original"]["role_chain_names"] = self.memory.names
        self.session.keccak = self.memory.keccak
        self.session.self_transactions = set(self.memory.self_transactions)
        self.session.broadcasts = list(self.memory.broadcasts)
        self.session.activity = {}
        self.session.failures = []
        self.session.hard_failure_latched = threading.Event()
        self.session.lifecycle = sessions.Lifecycle()
        self.records = []
        self.session.append = lambda name, row: self.records.append((name, row))
        self.session.diagnostic = lambda *args: None
        self.name = self.memory.names[1]
        self.identities = sorted(identity for name, identity in self.memory.self_transactions if name == self.name)
        for target in ["socket.socket", "subprocess.Popen", "ctypes.CDLL", "threading.Thread.start"]:
            patcher = mock.patch(target, side_effect=AssertionError("external effect"))
            patcher.start()
            self.addCleanup(patcher.stop)

    def receipt(self, index=0):
        return dict(copy.deepcopy(self.memory.receipts[self.name, self.identities[index]]), type="INVOKE")

    def observe(self, receipts, now=100):
        requests = [{"jsonrpc": "2.0", "id": index, "method": "starknet_getTransactionReceipt", "params": {"transaction_hash": row["transaction_hash"]}} for index, row in enumerate(receipts)]
        responses = [{"jsonrpc": "2.0", "id": index, "result": row} for index, row in enumerate(receipts)]
        request = {"requested_monotonic_ns": now - 1, "wire": json.dumps(requests).encode(), "json": requests, "start": "POST / HTTP/1.1"}
        response = {"wire": json.dumps(responses).encode()}
        # Same failure boundary as TransparentProxy._connection: observer errors
        # are retained independently while the original response still passes.
        try:
            self.session.observe(self.name, "relayer", "rpcurls", "https://fixture", request, responses, 200, now, response)
        except Exception as error:
            self.session.failure(type(error).__name__ + ": " + str(error))

    def test_actual_session_pending_then_mined_receipt_does_not_poison_observer_or_start_600_early(self):
        for missing_hash in [True, False]:
            with self.subTest(missing_hash=missing_hash):
                pending = self.receipt()
                pending["type"] = "DECLARE" if missing_hash else "INVOKE"
                if missing_hash: pending.pop("block_hash")
                else: pending["block_hash"] = None
                self.observe([pending], 100)
                self.assertEqual(self.session.failures, [])
                self.assertEqual(self.session.lifecycle.first, {})
                self.assertEqual(self.session.family.receipt_members, {})
        mined = self.receipt()
        self.observe([mined], 200)
        self.assertEqual(self.session.failures, [])
        ids = self.session.family._receipt_ids(self.session, mined, self.memory.chains[self.name])
        self.assertEqual(set(self.session.lifecycle.first), {(self.name, item) for item in ids})
        self.assertTrue(all(row["first_positive_monotonic_ns"] == 200 for row in self.session.lifecycle.first.values()))
        self.assertEqual(self.session.family.receipt_members[self.name, self.identities[0]], ids)
        self.assertEqual(self.sessions.OBSERVER_POLICY["retirement_observed_age_seconds"], [600, 630])
        self.observe([pending], 250)
        self.assertTrue(all(row["first_positive_monotonic_ns"] == 200 for row in self.session.lifecycle.first.values()))

    def test_actual_session_batch_defers_only_pending_sibling_and_canonical_proof_stays_required(self):
        pending, mined = self.receipt(0), self.receipt(1)
        pending.pop("block_hash")
        self.observe([pending, mined])
        self.assertEqual(self.session.failures, [])
        self.assertNotIn((self.name, self.identities[0]), self.session.family.receipt_members)
        self.assertIn((self.name, self.identities[1]), self.session.family.receipt_members)
        self.assertTrue(all(row["transaction_hash"] == self.identities[1] for row in self.session.lifecycle.first.values()))
        # The independent canonical receipt verifier never accepts a hashless row.
        self.memory.receipts[self.name, self.identities[0]] = pending
        with self.assertRaises((KeyError, ValueError)):
            self.session.family._receipt(self.memory, self.name, self.identities[0], 8)

    def test_pending_deferral_rejects_malformed_block_metadata_instead_of_swallowing_errors(self):
        mutations = [lambda row: (row.pop("block_number"), row.__setitem__("block_hash", "0x123")), lambda row: row.__setitem__("block_number", True), lambda row: row.__setitem__("block_number", -1), lambda row: row.__setitem__("block_number", 2 ** 64), lambda row: row.__setitem__("block_hash", "bad"), lambda row: row.__setitem__("block_hash", 0), lambda row: row.__setitem__("events", None)]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                bad = self.receipt()
                bad.pop("block_hash")
                mutate(bad)
                self.session.failures.clear()
                self.observe([bad])
                self.assertTrue(self.session.failures)
                self.assertEqual(self.session.lifecycle.first, {})
                self.assertEqual(self.session.family.receipt_members, {})


    def test_actual_session_legacy_pending_batch_defers_until_complete_without_poison_or_early_clock(self):
        pending, mined = self.receipt(0), self.receipt(1)
        pending.pop("block_number")
        pending.pop("block_hash")
        pending["type"] = "DECLARE"
        self.observe([pending, mined], 100)
        self.assertEqual(self.session.failures, [])
        self.assertNotIn((self.name, self.identities[0]), self.session.family.receipt_members)
        self.assertIn((self.name, self.identities[1]), self.session.family.receipt_members)
        self.assertTrue(all(row["transaction_hash"] == self.identities[1] for row in self.session.lifecycle.first.values()))
        complete = self.receipt(0)
        self.observe([complete], 200)
        self.assertEqual(self.session.failures, [])
        self.assertIn((self.name, self.identities[0]), self.session.family.receipt_members)
        ids = self.session.family._receipt_ids(self.session, complete, self.memory.chains[self.name])
        self.assertTrue(all(self.session.lifecycle.first[self.name, item]["first_positive_monotonic_ns"] == 200 for item in ids))
        self.assertEqual(self.sessions.OBSERVER_POLICY["retirement_observed_age_seconds"], [600, 630])
        # Canonical independent collection still rejects a pending receipt.
        self.memory.receipts[self.name, self.identities[0]] = pending
        with self.assertRaises((KeyError, ValueError)):
            self.session.family._receipt(self.memory, self.name, self.identities[0], 8)

    def test_legacy_pending_deferral_keeps_present_partial_null_invalid_and_foreign_receipts_strict(self):
        for defect in ["number_null", "number_bool", "number_hex", "number_negative", "number_overflow", "hash_null", "hash_only", "events_null", "events_large", "foreign_hash"]:
            with self.subTest(defect=defect):
                bad = self.receipt()
                bad.pop("block_number")
                bad.pop("block_hash")
                if defect == "number_null": bad["block_number"] = None
                elif defect == "number_bool": bad["block_number"] = True
                elif defect == "number_hex": bad["block_number"] = "0x1"
                elif defect == "number_negative": bad["block_number"] = -1
                elif defect == "number_overflow": bad["block_number"] = 2 ** 64
                elif defect == "hash_null": bad["block_hash"] = None
                elif defect == "hash_only": bad["block_hash"] = "0x123"
                elif defect == "events_null": bad["events"] = None
                elif defect == "events_large": bad["events"] = bad["events"] * (api.MAX_EVENTS + 1)
                else: bad["transaction_hash"] = "bad"
                self.session.failures.clear()
                self.observe([bad])
                self.assertTrue(self.session.failures)
                self.assertEqual(self.session.lifecycle.first, {})
                self.assertEqual(self.session.family.receipt_members, {})


if __name__ == "__main__":
    unittest.main()
