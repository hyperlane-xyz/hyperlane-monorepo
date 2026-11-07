"""Radix family evidence, never a node/process controller.

Source localnet240 has intent discriminators, not account nonces. SBOR and
signatures are independently checked by the admitted pinned Rust reference.
Import and Adapter construction do no I/O. Pure tests grant no SDK/chain credit.
"""
from __future__ import annotations

import hashlib
import copy
import json
import pathlib
import re

from multivm_evidence import direct_endpoint, hex_bytes, message_wire, require, urls
from multivm_evm import verify_checkpoint_objects, merkle_roots, chunks_hex, sql_message_query, sql_delivery_query, verify_sql_message
from multivm_sql import event_metadata, sql_event_query

NETWORK = 240
DOMAINS = {9913374, 9913375}
CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
MAX_EVENTS = 8192
MAX_PAGES = 128


def integer(value, bits=64):
    require(type(value) is int and 0 <= value < 2 ** bits, "invalid Radix unsigned integer")
    return value


def rawhex(value, size=None):
    require(isinstance(value, str), "Radix hex text missing")
    raw = hex_bytes(value if value.startswith("0x") else "0x" + value)
    require(size is None or len(raw) == size, "Radix native width differs")
    return raw


def polymod(values):
    state = 1
    for value in values:
        top, state = state >> 25, (state & 0x1ffffff) << 5 ^ value
        for index, generator in enumerate((0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3)):
            if top >> index & 1:
                state ^= generator
    return state


def address_bytes(value, kind="component"):
    require(isinstance(value, str) and len(value) <= 160 and value == value.lower(), "Radix address case/size")
    prefix, separator, payload = value.rpartition("1")
    require(separator and prefix == kind + "_loc" and len(payload) >= 6 and all(c in CHARSET for c in payload), "wrong Radix network/address kind")
    values = [CHARSET.index(c) for c in payload]
    expansion = [ord(c) >> 5 for c in prefix] + [0] + [ord(c) & 31 for c in prefix]
    require(polymod(expansion + values) == 0x2bc830a3, "Radix bech32m checksum differs")
    accumulator, bits, out = 0, 0, bytearray()
    for value in values[:-6]:
        accumulator, bits = accumulator << 5 | value, bits + 5
        if bits >= 8:
            bits -= 8
            out.append(accumulator >> bits & 255)
    require(bits < 5 and accumulator & ((1 << bits) - 1) == 0, "noncanonical Radix address padding")
    require(len(out) == (32 if kind in {"txid", "signedintent", "notarizedtransaction"} else 30), "Radix address width")
    return bytes(out)


def address_text(raw, kind="component"):
    require(isinstance(raw, bytes) and len(raw) == (32 if kind in {"txid", "signedintent", "notarizedtransaction"} else 30), "Radix address width")
    prefix = kind + "_loc"
    accumulator, bits, values = 0, 0, []
    for byte in raw:
        accumulator, bits = accumulator << 8 | byte, bits + 8
        while bits >= 5:
            bits -= 5
            values.append(accumulator >> bits & 31)
    if bits:
        values.append(accumulator << (5 - bits) & 31)
    expansion = [ord(c) >> 5 for c in prefix] + [0] + [ord(c) & 31 for c in prefix]
    checksum = polymod(expansion + values + [0] * 6) ^ 0x2bc830a3
    return prefix + "1" + "".join(CHARSET[v] for v in values + [checksum >> 5 * (5 - index) & 31 for index in range(6)])


def full_component(value):
    return "0x0000" + address_bytes(value).hex()


def identity(value):
    return "0x" + address_bytes(value, "txid").hex()


def attos(value):
    require(isinstance(value, str) and re.fullmatch(r"-?[0-9]+(?:\.[0-9]{1,18})?", value) is not None, "invalid Radix Decimal")
    negative = value.startswith("-")
    whole, _, fraction = value.removeprefix("-").partition(".")
    result = int(whole) * 10 ** 18 + int(fraction.ljust(18, "0"))
    result = -result if negative else result
    require(-(2 ** 191) <= result < 2 ** 191, "Radix Decimal overflow")
    return result


def fee(transaction):
    if "fee_paid" not in transaction:
        return None
    summary = transaction.get("receipt", {}).get("fee_summary")
    require(isinstance(summary, dict), "present Radix fee has no actual receipt summary")
    units = integer(integer(summary["execution_cost_units_consumed"]) + integer(summary["finalization_cost_units_consumed"]))
    paid = attos(transaction["fee_paid"])
    require(paid >= 0, "negative actual Radix fee")
    return {"gas_used": units, "fee_paid_attos": paid, "tokens_used": paid // units * units if units else 0}


def gateway_ledger(response):
    ledger = response.get("ledger_state")
    require(isinstance(ledger, dict) and ledger.get("network") == "localnet", "Radix Gateway ledger network/shape differs")
    return {"network": "localnet", "state_version": integer(ledger.get("state_version")), "epoch": integer(ledger.get("epoch"))}


def accepted_call_state(request, response):
    state = integer(response.get("at_ledger_state", {}).get("state_version"))
    selector = request.get("at_ledger_state")
    if selector is not None:
        require(isinstance(selector, dict) and selector.get("type") == "ByStateVersion" and integer(selector.get("state_version")) == state, "Radix call rejected requested/actual state mismatch")
    return state


def canonical_event(name, chain, proof, position, event):
    # Radix Source absolute transaction index IS its state version; neither a
    # filtered event ordinal nor an invented EVM-style transaction slot zero.
    return event_metadata(name, int(chain["domainid"]), {"identity": identity(proof["transaction"]["intent_hash"]), "block_hash": proof["source_state_version_hash"], "height": proof["state_version"], "index": proof["state_version"]}, {"event_index": position, "emitter": full_component(event["emitter"]["entity"]["entity_address"])})


def process_sequence(rows, processed):
    ordered = sorted(rows, key=lambda row: (row["metadata"]["block_number"], row["metadata"]["log_index"]))
    require(len({row["id"] for row in ordered}) == len(ordered) and [row["sequence"] for row in ordered] == list(range(len(ordered))) and integer(processed, 32) == len(ordered), "Radix destination process sequence/count differs")
    return ordered


def event_value(event, contract, keccak):
    """Source programmatic SBOR event schema, including actual emitter."""
    name = event.get("name")
    schemas = {"DispatchEvent": [("U32", "destination"), ("Bytes", "recipient"), ("Bytes", "message"), ("U32", "sequence")], "ProcessIdEvent": [("Bytes", "message_id"), ("U32", "sequence")], "InsertedIntoTreeEvent": [("Bytes", "id"), ("U32", "index")], "GasPayment": [("Bytes", "message_id"), ("U32", "destination_domain"), ("Decimal", "gas_amount"), ("Decimal", "payment"), ("String", "resource_address"), ("U32", "sequence")]}
    if name not in schemas:
        return None
    emitter = event.get("emitter", {})
    if emitter.get("type") != "Method" or emitter.get("entity", {}).get("entity_address") != contract:
        return None
    address_bytes(contract)
    data = event["data"]
    require(data.get("kind") == "Tuple" and data.get("type_name") in (None, name), "Radix event tuple/schema differs")
    values = data.get("fields")
    require(isinstance(values, list) and len(values) == len(schemas[name]), "Radix event field count differs")
    result = []
    for field, (kind, label) in zip(values, schemas[name]):
        require(field.get("kind") == kind and field.get("field_name") in (None, label), "Radix event field kind/name differs")
        if kind == "Bytes":
            value = rawhex(field["hex"])
        elif kind == "U32":
            require(isinstance(field["value"], (str, int)) and not isinstance(field["value"], bool), "noncanonical event u32")
            value = integer(int(field["value"]), 32)
            require(str(value) == str(field["value"]), "noncanonical event u32")
        elif kind == "Decimal":
            value = attos(field["value"])
        else:
            value = field["value"]
            require(isinstance(value, str) and len(value) <= 160, "Radix resource bound")
        result.append(value)
    if name == "DispatchEvent":
        message = message_wire("0x" + result[2].hex(), keccak)
        require(len(result[1]) == 32 and (message["destination"], rawhex(message["recipient"], 32), message["nonce"]) == (result[0], result[1], result[3]), "Radix dispatch/wire inconsistency")
        return {"kind": "dispatch", "message": message}
    require(len(result[0]) == 32, "Radix event message ID width")
    output = {"kind": {"ProcessIdEvent": "delivery", "InsertedIntoTreeEvent": "insertion", "GasPayment": "payment"}[name], "id": "0x" + result[0].hex()}
    if name == "ProcessIdEvent":
        output["sequence"] = result[1]
    elif name == "InsertedIntoTreeEvent":
        output["index"] = result[1]
    else:
        output.update(destination=result[1], gas_amount=max(0, result[2]) // 10 ** 18, payment=max(0, result[3]), resource=result[4], sequence=result[5])
    return output


def receipt(response, expected_identity, final_state):
    ledger = gateway_ledger(response)
    tx = response["transaction"]
    require(identity(tx["intent_hash"]) == expected_identity and tx.get("transaction_status") == "CommittedSuccess", "Radix receipt pending/failed/wrong identity")
    state = integer(tx["state_version"])
    require(0 < state <= final_state and ledger["state_version"] >= state, "Radix receipt outside canonical finalized state")
    require(tx.get("receipt", {}).get("status") == "CommittedSuccess", "actual Radix execution receipt not successful")
    events = tx.get("receipt", {}).get("events")
    require(isinstance(events, list) and len(events) <= MAX_EVENTS, "Radix receipt event bound")
    return {"transaction": tx, "state_version": state, "source_state_version_hash": "0x" + state.to_bytes(32, "big").hex(), "ledger_state": ledger, "final_state": final_state, "events": events, "fee": fee(tx)}


def verify_signed_canonical(transaction, signed):
    raw = rawhex(transaction["raw_hex"])
    require(len(raw) == signed["wire"]["bytes"] and hashlib.sha256(raw).hexdigest() == signed["wire"]["sha256"][2:], "canonical Radix notarized wire differs from self submission")
    require(address_bytes(transaction["payload_hash"], "notarizedtransaction") == rawhex(signed["sdk"]["notarized_hash"], 32), "canonical Radix payload hash differs from SDK notarized hash")
    epoch = integer(transaction["epoch"])
    require(integer(signed["sdk"]["start_epoch_inclusive"]) <= epoch < integer(signed["sdk"]["end_epoch_exclusive"]), "Radix commit outside signed epoch range")


def tree_root(tree, keccak):
    count = integer(tree["count"], 32)
    require(isinstance(tree["frontier"], list) and len(tree["frontier"]) == 32, "Radix tree frontier width")
    node, zero = bytes(32), bytes(32)
    for value in tree["frontier"]:
        branch = rawhex(value, 32)
        node = rawhex(keccak("0x" + ((branch + node) if count & 1 else (node + zero)).hex()), 32)
        zero = rawhex(keccak("0x" + (zero * 2).hex()), 32)
        count >>= 1
    return "0x" + node.hex()


class Adapter:
    payments_supported = True

    def __init__(self, manifest, case):
        self.manifest, self.case = manifest, case
        self.signed = {}
        self.canonical = {}
        self.pending_positive = {}
        self.baseline_deliveries = None

    def validate_case(self):
        require(self.manifest.get("scenario") == "radix", "wrong Radix scenario")
        names = self.case["chain_names"]
        require(len(names) == 2 and len(set(names)) == 2 and set(self.case["domain_names"].values()) == set(names) and {int(v) for v in self.case["domain_names"]} == DOMAINS, "Source Radix domain scope differs")
        corpus = self.case["initial_corpus"]
        require(set(corpus) == {"dispatches", "deliveries", "zero_insertions", "failed_body", "double_insertions"} and type(corpus["dispatches"]) is int and corpus["dispatches"] == 4 and corpus["deliveries"] == corpus["dispatches"] and all(corpus[key] == 0 for key in ("zero_insertions", "failed_body", "double_insertions")), "Source Radix corpus differs")
        require(self.case.get("additional_refused_dispatches", 0) == 0, "unsupported Source Radix reorg corpus")
        require(set(self.case["validator_addresses"]) == set(names) and set(self.case["relayer_public_keys"]) == set(names) and set(self.case["relayer_accounts"]) == set(names), "Radix public authorities missing")
        for name in names:
            rawhex(self.case["validator_addresses"][name], 20)
            rawhex(self.case["relayer_public_keys"][name], 32)
            address_bytes(self.case["relayer_accounts"][name], "account")
        address_bytes(self.case["payment_resource"], "resource")
        require(set(self.case.get("family_tools", {})) == {"radix_reference"}, "admitted independent Radix reference required")

    def transport(self, field):
        require(field in {"rpcurls", "customrpcurls", "gatewayurls", "customgatewayurls"}, "unsupported Radix transport field")
        return "http-json"

    def _chains(self, session):
        chains = {name: session.chain_config(name) for name in self.case["chain_names"]}
        for name, chain in chains.items():
            require(chain["protocol"] == "radix" and int(chain["chainid"]) == NETWORK and chain["networkname"] == "localnet" and self.case["domain_names"][str(chain["domainid"])] == name, "actual Radix network/domain differs")
            for field in ("mailbox", "merkletreehook", "interchaingaspaymaster", "validatorannounce"):
                address_bytes(chain[field])
        return chains

    def _oracle(self, session, op, **values):
        request = {"schema": 1, "op": op, **values}
        response = json.loads(session.family_tool("radix_reference", ["evidence"], stdin=json.dumps(request, separators=(",", ":"), sort_keys=True), timeout=30))
        require(isinstance(response, dict) and response.get("schema") == 1 and response.get("op") == op, "independent Radix reference response differs")
        return response

    def _http(self, session, chain, path, payload):
        core = path in {"/status/network-status", "/transaction/call-preview"}
        endpoints = urls(chain.get("customrpcurls", chain["rpcurls"])) if core else urls(chain.get("customgatewayurls", chain["gatewayurls"]))
        require(endpoints, "actual Radix endpoint missing")
        parsed = direct_endpoint(endpoints[0])
        return session.native_http(endpoints[0], parsed.path.rstrip("/") + path, payload)

    def _final_state(self, session, chain):
        response = self._http(session, chain, "/status/network-status", {"network": "localnet"})
        state = integer(response["current_state_identifier"]["state_version"])
        depth = integer(chain.get("blocks", {}).get("confirmations", 1), 32)
        return max(0, state - depth)

    def _call(self, session, chain, component, method, arguments, state, kind):
        result = self._http(session, chain, "/transaction/call-preview", {"network": "localnet", "target": {"type": "Method", "component_address": component, "method_name": method}, "arguments": arguments, "at_ledger_state": {"type": "ByStateVersion", "state_version": state}})
        require(result.get("status") == "Succeeded" and accepted_call_state({"at_ledger_state": {"type": "ByStateVersion", "state_version": state}}, result) == state, "Radix call not successful at exact requested state")
        return self._oracle(session, "call_output", kind=kind, hex=result["output"]["hex"])["value"]

    def _submission(self, session, name, chain, request):
        require(isinstance(request, dict) and set(request) == {"notarized_transaction_hex"}, "Radix submission body differs")
        raw = rawhex(request["notarized_transaction_hex"])
        require(0 < len(raw) <= 1024 * 1024, "native Radix signed wire bound")
        proof = self._oracle(session, "notarized", network=NETWORK, public_key=self.case["relayer_public_keys"][name].removeprefix("0x"), account=address_bytes(self.case["relayer_accounts"][name], "account").hex(), mailbox=address_bytes(chain["mailbox"]).hex(), hex=raw.hex())
        require(proof["network"] == NETWORK and rawhex(proof["account"], 30) == address_bytes(self.case["relayer_accounts"][name], "account") and rawhex(proof["mailbox"], 30) == address_bytes(chain["mailbox"]) and rawhex(proof["public_key"], 32) == rawhex(self.case["relayer_public_keys"][name], 32), "SDK transaction authority differs")
        message = message_wire("0x" + rawhex(proof["message"]).hex(), session.keccak)
        require(message["destination"] == int(chain["domainid"]), "submitted process destination differs")
        txid = "0x" + rawhex(proof["intent_hash"], 32).hex()
        for field in ("signed_intent_hash", "notarized_hash"):
            rawhex(proof[field], 32)
        require(integer(proof["start_epoch_inclusive"]) < integer(proof["end_epoch_exclusive"]) and attos(proof["locked_fee"]) > 0, "SDK signed epoch range/locked fee differs")
        integer(proof["intent_discriminator"])
        wire = {"bytes": len(raw), "sha256": "0x" + hashlib.sha256(raw).hexdigest()}
        entry = {"sdk": proof, "message": message, "wire": wire}
        key = (name, txid)
        require(key not in self.signed or self.signed[key] == entry, "same Radix intent has changed signed bytes/authority")
        self.signed[key] = entry
        session.record_broadcast(name, txid, wire["sha256"].removeprefix("0x"), message_ids=[message["id"]])
        if key in self.pending_positive:
            timestamp, reference = self.pending_positive[key]
            session.record_inclusion(name, message["id"], txid, timestamp, reference)
        return txid

    def observe(self, session, event):
        if event["status"] != 200:
            return
        chain = self._chains(session)[event["chain"]]
        request, response = event["request"], event["response"]
        path = event["path"].split("?", 1)[0].rstrip("/")
        if path.endswith("/transaction/submit") and event["role"] == "relayer":
            require(type(response.get("duplicate")) is bool, "Radix submit response invalid")
            self._submission(session, event["chain"], chain, request)
        elif path.endswith("/transaction/status") and response.get("status") == "CommittedSuccess":
            gateway_ledger(response)
            txid = identity(request["intent_hash"])
            state = integer(response["committed_state_version"])
            require(state > 0, "observed Radix commit state missing")
            self._positive(session, event, txid, {"kind": "observed_native_status", "state_version": state})
        elif path.endswith("/transaction/committed-details"):
            tx = response.get("transaction", {})
            if tx.get("transaction_status") != "CommittedSuccess":
                return
            txid = identity(request["intent_hash"])
            proof = receipt(response, txid, integer(response["ledger_state"]["state_version"]))
            members = [parsed["id"] for row in proof["events"] if (parsed := event_value(row, chain["mailbox"], session.keccak)) is not None and parsed["kind"] == "delivery"]
            if (event["chain"], txid) in self.signed:
                require(members == [self.signed[(event["chain"], txid)]["message"]["id"]], "observed process receipt membership differs")
                self._positive(session, event, txid, {"kind": "observed_native_receipt", "state_version": proof["state_version"]})
        elif path.endswith("/stream/transactions"):
            ledger = gateway_ledger(response)
            selector = request.get("at_ledger_state")
            if selector is not None:
                require(isinstance(selector, dict) and integer(selector.get("state_version")) == ledger["state_version"], "Radix stream rejected requested/actual state mismatch")
            transactions = response.get("items")
            require(isinstance(transactions, list) and len(transactions) <= MAX_EVENTS, "observed Radix stream bound")
            for transaction in transactions:
                if transaction.get("transaction_status") != "CommittedSuccess" or transaction.get("receipt", {}).get("status") != "CommittedSuccess":
                    continue
                txid = identity(transaction["intent_hash"])
                reference = {"kind": "observed_native_stream_process", "state_version": integer(transaction["state_version"])}
                events = transaction.get("receipt", {}).get("events", [])
                require(isinstance(events, list) and len(events) <= MAX_EVENTS, "observed Radix stream events bound")
                for row in events:
                    parsed = event_value(row, chain["mailbox"], session.keccak)
                    if parsed is not None and parsed["kind"] == "delivery":
                        session.record_inclusion(event["chain"], parsed["id"], txid, event["received_monotonic_ns"], reference)
        elif path.endswith("/transaction/call-preview"):
            target = request.get("target", {})
            if target != {"type": "Method", "component_address": chain["mailbox"], "method_name": "delivered"} or response.get("status") != "Succeeded":
                return
            state = accepted_call_state(request, response)
            arguments = request.get("arguments")
            require(isinstance(arguments, list) and len(arguments) == 1, "Radix delivered argument count differs")
            if self._oracle(session, "call_output", kind="bool", hex=response["output"]["hex"])["value"] is not True:
                return
            message_id = "0x" + rawhex(self._oracle(session, "byte_argument", kind="decode_bytes", hex=arguments[0])["hex"], 32).hex()
            txid = next((txid for (name, txid), proof in list(self.signed.items()) if name == event["chain"] and proof["message"]["id"] == message_id), "0x" + "00" * 32)
            session.record_inclusion(event["chain"], message_id, txid, event["received_monotonic_ns"], {"kind": "observed_native_delivered", "state_version": state})

    def _positive(self, session, event, txid, reference):
        key = (event["chain"], txid)
        self.pending_positive.setdefault(key, (event["received_monotonic_ns"], reference))
        if key in self.signed:
            session.record_inclusion(event["chain"], self.signed[key]["message"]["id"], txid, event["received_monotonic_ns"], reference)

    def _receipt(self, session, chain, txid, final_state):
        request = {"intent_hash": address_text(rawhex(txid, 32), "txid")}
        before = self._http(session, chain, "/transaction/status", request)
        gateway_ledger(before)
        require(before.get("status") == "CommittedSuccess", "actual Radix transaction not committed success")
        result = self._http(session, chain, "/transaction/committed-details", {**request, "opt_ins": {"receipt_events": True, "receipt_fee_summary": True, "manifest_instructions": True, "raw_hex": True}})
        proof = receipt(result, txid, final_state)
        require(before.get("committed_state_version") == proof["state_version"], "Radix status/details state mismatch")
        after = self._http(session, chain, "/transaction/status", request)
        gateway_ledger(after)
        require(after.get("status") == before["status"] and after.get("committed_state_version") == before["committed_state_version"], "Radix canonical commit changed during verification")
        return proof

    def _stream(self, session, chain, contract, final_state):
        start = integer(chain.get("index", {}).get("from", 0))
        token, seen_tokens, rows, seen_states, last = None, set(), [], set(), start - 1
        for _ in range(MAX_PAGES):
            payload = {"from_ledger_state": {"state_version": start}, "event_global_emitters_filter": [contract], "order": "Asc", "opt_ins": {"receipt_events": True}}
            if token is not None:
                payload["cursor"] = token
            page = self._http(session, chain, "/stream/transactions", payload)
            require(gateway_ledger(page)["state_version"] >= final_state, "Radix Gateway behind canonical Core")
            items = page.get("items")
            require(isinstance(items, list) and len(items) <= MAX_EVENTS, "Radix stream page bound")
            for tx in items:
                state = integer(tx["state_version"])
                require(state >= start and state > last and state not in seen_states, "Radix stream repeats/reorders state")
                last = state
                seen_states.add(state)
                if state <= final_state and tx.get("transaction_status") == "CommittedSuccess":
                    rows.append(tx)
            require(len(rows) <= MAX_EVENTS, "Radix stream total bound")
            token = page.get("next_cursor")
            if token in (None, ""):
                return rows
            require(isinstance(token, str) and len(token) <= 4096 and token not in seen_tokens and items, "Radix cursor repeated/empty/nonprogress")
            seen_tokens.add(token)
        raise ValueError("Radix stream page limit")

    def collect(self, session, expected, phase):
        self.validate_case()
        require(phase in {"initial", "after_restart", "after_source_reorg", "final"} and expected == self.case["initial_corpus"]["dispatches"], "Radix collection scope differs")
        chains = self._chains(session)
        messages, deliveries, proofs = [], {}, {}
        for name, chain in chains.items():
            height = self._final_state(session, chain)
            destination_events = []
            for tx in self._stream(session, chain, chain["mailbox"], height):
                txid = identity(tx["intent_hash"])
                proof = self._receipt(session, chain, txid, height)
                require(proof["state_version"] == tx["state_version"] and tx.get("receipt", {}).get("events") == proof["events"], "Radix stream not exact canonical receipt")
                for position, row in enumerate(proof["events"]):
                    parsed = event_value(row, chain["mailbox"], session.keccak)
                    if parsed is not None and parsed["kind"] == "delivery":
                        destination_events.append({"id": parsed["id"], "sequence": parsed["sequence"], "metadata": canonical_event(name, chain, proof, position, row)})
                    if parsed is None or parsed["kind"] != "dispatch":
                        continue
                    message = parsed["message"]
                    require(message["origin"] == int(chain["domainid"]) and message["destination"] in DOMAINS and message["destination"] != message["origin"], "Radix dispatch origin/destination differs")
                    insertions, payments = [], []
                    coordinates = {"dispatch": [canonical_event(name, chain, proof, position, row)], "insertion": [], "payment": []}
                    for event_position, event in enumerate(proof["events"]):
                        inserted = event_value(event, chain["merkletreehook"], session.keccak)
                        if inserted is not None and inserted["kind"] == "insertion" and inserted["id"] == message["id"]:
                            insertions.append(inserted["index"])
                            coordinates["insertion"].append(canonical_event(name, chain, proof, event_position, event))
                        payment = event_value(event, chain["interchaingaspaymaster"], session.keccak)
                        if payment is not None and payment["kind"] == "payment" and payment["id"] == message["id"]:
                            require(payment["destination"] == message["destination"] and payment["sequence"] == message["nonce"] and payment["gas_amount"] > 0 and payment["payment"] > 0 and payment["resource"] == self.case["payment_resource"], "actual Radix IGP payment differs")
                            payments.append({"gas_amount": payment["gas_amount"], "payment": payment["payment"]})
                            coordinates["payment"].append(canonical_event(name, chain, proof, event_position, event))
                    require(len(insertions) == 1 and payments, "actual Radix insertion/payment missing or duplicate")
                    messages.append({**message, "origin_chain": name, "dispatch_transaction": txid, "dispatch_block": proof["state_version"], "dispatch_log_index": position, "insertions": insertions, "payments": payments, "event_metadata": coordinates})
            processed = self._call(session, chain, chain["mailbox"], "processed", [], height, "u32")
            ordered_deliveries = process_sequence(destination_events, processed)
            stream_by_id = {row["id"]: row for row in ordered_deliveries}
            for (submitted_name, txid), signed in list(self.signed.items()):
                if submitted_name != name:
                    continue
                proof = self._receipt(session, chain, txid, height)
                verify_signed_canonical(proof["transaction"], signed)
                # Retain the actual authenticated response privately so the
                # later pure cost contract cannot accept a supplied None flag.
                canonical = copy.deepcopy(proof)
                # Raw signed SBOR stays in the private wire capture. Public
                # evidence carries the independently bound SHA/length only.
                del proof["transaction"]["raw_hex"]
                ids, delivery_events = [], []
                for position, event in enumerate(proof["events"]):
                    parsed = event_value(event, chain["mailbox"], session.keccak)
                    if parsed is not None and parsed["kind"] == "delivery":
                        ids.append(parsed["id"])
                        delivery_events.append({"id": parsed["id"], "sequence": parsed["sequence"], "metadata": canonical_event(name, chain, proof, position, event)})
                require(ids == [signed["message"]["id"]], "Radix canonical process membership differs")
                require(stream_by_id.get(ids[0]) == delivery_events[0], "Radix delivery receipt/processed stream coordinates differ")
                self.canonical[(name, txid)] = {"proof": canonical, "sdk": copy.deepcopy(signed["sdk"]), "wire": dict(signed["wire"]), "message_id": ids[0], "mailbox": chain["mailbox"]}
                proof.update(message_ids=ids, sdk=signed["sdk"], signed_wire=signed["wire"], delivery_events=delivery_events)
                argument = self._oracle(session, "byte_argument", kind="bytes", hex=ids[0][2:])["hex"]
                require(self._call(session, chain, chain["mailbox"], "delivered", [argument], proof["state_version"], "bool") is True, "Radix delivered getter false at receipt state")
                require(ids[0] not in deliveries, "Radix message delivered by multiple self transactions")
                deliveries[ids[0]] = {"delivery_chain": name, "delivery_transaction": txid, "delivery_sequence": delivery_events[0]["sequence"], "delivery_event_metadata": delivery_events[0]["metadata"]}
                proofs[(name, txid)] = proof
            require(set(stream_by_id) == {message_id for message_id, row in deliveries.items() if row["delivery_chain"] == name}, "Radix destination stream includes unbound/foreign delivery")
        require(len(messages) == expected and len({row["id"] for row in messages}) == expected and set(deliveries) == {row["id"] for row in messages}, "actual Radix corpus/delivery coverage differs")
        output = []
        for message in messages:
            delivery = deliveries[message["id"]]
            signed = self.signed[(delivery["delivery_chain"], delivery["delivery_transaction"])]
            require(signed["message"]["wire"] == message["wire"], "SDK process message differs from canonical origin wire")
            chain = chains[delivery["delivery_chain"]]
            state = proofs[(delivery["delivery_chain"], delivery["delivery_transaction"])]["state_version"]
            routing = self._call(session, chain, chain["mailbox"], "default_ism", [], state, "optional_component")
            require(routing is not None, "Source Radix mailbox default ISM absent")
            argument = self._oracle(session, "byte_argument", kind="bytes", hex=message["wire"][2:])["hex"]
            module = self._call(session, chain, address_text(rawhex(routing, 30)), "route", [argument], state, "component")
            validators = self._call(session, chain, address_text(rawhex(module, 30)), "validators_and_threshold", [argument], state, "multisig")
            require(validators == {"validators": [self.case["validator_addresses"][message["origin_chain"]].removeprefix("0x").lower()], "threshold": 1}, "Source Radix actual validator set/threshold differs")
            output.append({**message, **delivery, "onchain_multisig": validators})
        result = {"messages": output, "deliverable_messages": output, "native_delivery_transactions": [{"chain": name, "transaction_hash": txid, "proof": proof} for (name, txid), proof in sorted(proofs.items())]}
        current = {(name, txid): {"signed_wire": proof["signed_wire"], "sdk": proof["sdk"], "fee": proof["fee"]} for (name, txid), proof in proofs.items()}
        require(self.baseline_deliveries is None or current == self.baseline_deliveries, "Radix restart changed identity/discriminator/wire/fee")
        self.baseline_deliveries = current
        return result

    def checkpoints(self, session, snapshot):
        result = []
        for capture in session.captures:
            original = capture["original"]
            if original["role"] != "validator":
                continue
            require(len(original["role_chain_names"]) == 1, "Radix validator origin scope")
            name = original["role_chain_names"][0]
            syncer = original["checkpoint_syncer"]
            require(syncer["type"] == "localStorage", "Radix actual local publication required")
            root = pathlib.Path(syncer["path"])
            root = session.owned_path(root.relative_to(self.manifest["task_root"]))
            chain = original["chains"][name]
            configured = capture["proxied"]["chains"][name]
            messages = [row for row in snapshot["messages"] if row["origin_chain"] == name]
            proof = verify_checkpoint_objects(root, chain, self.case["validator_addresses"][name], messages, session.keccak, git_sha=self.manifest["runtime_source_commit"], configured_rpc_urls=urls(configured.get("customrpcurls", configured["rpcurls"])), allows_public_rpcs=original["allows_public_rpcs"], hook_hash=full_component(chain["merkletreehook"]))
            state = self._final_state(session, chain)
            tree = self._call(session, chain, chain["merkletreehook"], "tree", [], state, "merkle")
            leaves = merkle_roots(messages, session.keccak)
            require(tree["count"] == len(leaves) and tree_root(tree, session.keccak) == leaves[-1]["root"], "Radix canonical hook tree differs from exact dispatch leaves")
            validator_arg = self._oracle(session, "byte_argument", kind="validators", hex=[self.case["validator_addresses"][name].removeprefix("0x")])["hex"]
            locations = self._call(session, chain, chain["validatorannounce"], "get_announced_storage_locations", [validator_arg], state, "locations")
            require(isinstance(locations, list) and len(locations) == 1 and "file://" + syncer["path"] in locations[0], "Radix actual validator announcement does not bind configured published storage")
            paths = [pathlib.Path(row["path"]) for row in proof["verified_checkpoint_objects"]]
            result.append({"chain": name, **proof, "canonical_tree": tree, "announced_locations": locations, "published_bytes": [{"path": str(path), "bytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for path in paths]})
        require({row["chain"] for row in result} == set(self.case["chain_names"]), "Radix validator publication coverage differs")
        return result

    def sql(self, session, snapshot):
        result = []
        for message in snapshot["messages"]:
            origin = session.query_sql(message["origin_chain"], sql_message_query(message))
            destination = session.query_sql(message["delivery_chain"], sql_delivery_query(message, message["delivery_transaction"]))
            proof = verify_sql_message(origin, destination, message, delivered=True)
            coordinates = message["event_metadata"]
            require(set(coordinates) == {"dispatch", "insertion", "payment"} and len(coordinates["dispatch"]) == 1 and len(coordinates["insertion"]) == len(message["insertions"]) and len(coordinates["payment"]) == len(message["payments"]), "Radix SQL event coordinate coverage differs")
            verified = []
            for kind, events in coordinates.items():
                for metadata in events:
                    require(metadata["chain"] == message["origin_chain"] and metadata["domain"] == message["origin"] and metadata["transaction_hash"] == message["dispatch_transaction"], "Radix SQL origin event binding differs")
                    require(session.query_sql(message["origin_chain"], sql_event_query(kind, message["id"], metadata)) == "1", "Radix SQL canonical event coordinate mismatch/duplicate")
                    verified.append({"kind": kind, "metadata": metadata})
            metadata = message["delivery_event_metadata"]
            require(metadata["chain"] == message["delivery_chain"] and metadata["domain"] == message["destination"] and metadata["transaction_hash"] == message["delivery_transaction"], "Radix SQL delivery binding differs")
            require(session.query_sql(message["delivery_chain"], sql_event_query("delivery", message["id"], metadata)) == "1", "Radix SQL canonical delivery coordinates mismatch/duplicate")
            result.append({"id": message["id"], "proof": proof, "event_coordinates": verified + [{"kind": "delivery", "metadata": metadata}]})
        return result

    def canonical_expenditure(self, snapshot):
        messages = snapshot["deliverable_messages"]
        require(isinstance(messages, list) and len(messages) == self.case["initial_corpus"]["deliveries"], "Radix canonical cost corpus coverage differs")
        by_id = {message["id"]: message for message in messages}
        require(len(by_id) == len(messages), "duplicate Radix canonical cost member")
        costs = {}
        for transaction in snapshot["native_delivery_transactions"]:
            name, txid, proof = transaction["chain"], transaction["transaction_hash"], transaction["proof"]
            private = self.canonical.get((name, txid))
            require(private is not None and proof["message_ids"] == [private["message_id"]], "Radix cost lacks actual canonical selftransaction/member binding")
            message_id = private["message_id"]
            require(message_id in by_id and message_id not in costs, "Radix cost duplicate/foreign message")
            message = by_id[message_id]
            signed = self.signed[(name, txid)]
            require(message_id == signed["message"]["id"] and message["delivery_chain"] == name and message["delivery_transaction"] == txid and self.case["domain_names"][str(message["destination"])] == name and message["wire"] == signed["message"]["wire"] and signed["sdk"] == private["sdk"] == proof["sdk"] and signed["wire"] == private["wire"] == proof["signed_wire"] and "0x" + rawhex(private["sdk"]["intent_hash"], 32).hex() == txid and rawhex(private["sdk"]["mailbox"], 30) == address_bytes(private["mailbox"]) and private["sdk"]["network"] == NETWORK and rawhex(private["sdk"]["public_key"], 32) == rawhex(self.case["relayer_public_keys"][name], 32) and rawhex(private["sdk"]["account"], 30) == address_bytes(self.case["relayer_accounts"][name], "account"), "Radix cost intent/account/SDK/native wire authority differs")
            actual = private["proof"]
            verify_signed_canonical(actual["transaction"], signed)
            public_transaction = {key: value for key, value in actual["transaction"].items() if key != "raw_hex"}
            require(proof["transaction"] == public_transaction and all(proof[field] == actual[field] for field in ("state_version", "source_state_version_hash", "ledger_state", "final_state", "events")), "Radix cost canonical receipt/state changed")
            checked = receipt({"transaction": public_transaction, "ledger_state": actual["ledger_state"]}, txid, actual["final_state"])
            members = [parsed["id"] for event in actual["events"] if event.get("name") == "ProcessIdEvent" and (parsed := event_value(event, private["mailbox"], None)) is not None]
            require(members == [message_id], "Radix cost actual canonical process event membership differs")
            expected = fee(actual["transaction"])
            require(checked["fee"] == expected == proof["fee"], "Radix cost flag differs from actual canonical fee")
            costs[message_id] = None if expected is None else {"gas_used": integer(expected["gas_used"], 256), "tokens_used": integer(expected["tokens_used"], 256)}
        require(set(costs) == set(by_id), "Radix canonical cost member coverage incomplete")
        return costs

    def native_rows(self, session, snapshot, rows, baseline):
        chains = self._chains(session)
        require(len(rows) == len(snapshot["deliverable_messages"]), "Radix stopped row coverage differs")
        by_id = {row["id"]: row["operation"] for row in rows if row.get("present", True) is True}
        require(len(by_id) == len(rows), "Radix duplicate/missing stopped operation")
        result = []
        for entry in snapshot["native_delivery_transactions"]:
            name, txid, proof = entry["chain"], entry["transaction_hash"], entry["proof"]
            require(len(proof["message_ids"]) == 1, "Radix unsupported process grouping")
            message_id = proof["message_ids"][0]
            message = next(row for row in snapshot["messages"] if row["id"] == message_id)
            operation = by_id[message_id]
            expected = {"protocol": "radix", "origin": message["origin"], "destination": message["destination"], "mailbox": full_component(chains[name]["mailbox"]), "chain_id": "240", "origin_hook": full_component(chains[message["origin_chain"]]["merkletreehook"]), "operation_id": message_id, "generation": operation["generation"], "kind": "process", "target": None}
            require(operation["stage"] == "delivered" and operation["confirmation_started"] is True and operation["kind"] == "process" and operation["target"] is None and operation["authority"] == expected, "Radix stopped process authority/lifecycle differs")
            require(operation["nonce"] == message["nonce"] and operation["origin"] == message["origin"] and operation["destination"] == message["destination"] and operation["identity"] == {"kind": "hash256", "hex": txid} and operation["signed"] == proof["signed_wire"], "Radix native signed identity/wire differs")
            broadcasts = [row for row in session.broadcasts if row["chain"] == name and row["transaction_hash"] == txid]
            require(broadcasts and all(rawhex(row["raw_transaction_sha256"], 32) == rawhex(proof["signed_wire"]["sha256"], 32) and row["message_ids"] == [message_id] for row in broadcasts), "Radix native-row wire not actual self submission")
            expenditure = operation.get("expenditure")
            actual = proof["fee"]
            if actual is None:
                require(expenditure is None or expenditure.get("present") is False, "unknown actual Radix fee fabricated")
            else:
                require(isinstance(expenditure, dict) and expenditure.get("present") is True and int.from_bytes(rawhex(expenditure["gas_used_hex"], 32), "big") == actual["gas_used"] and int.from_bytes(rawhex(expenditure["tokens_used_hex"], 32), "big") == actual["tokens_used"], "Radix actual fee floor differs")
            canonical = [row for origin in snapshot["stopped_canonical_Rust_readback"] for row in origin["actual_Rust_output"]["messages"] if chunks_hex(row["id_chunks"], 32) == message_id]
            require(len(canonical) == 1 and canonical[0].get("processed") is True, "Radix independent canonical processed row missing/ambiguous")
            if actual is None:
                spent = canonical[0]["spent"]
                require(canonical[0].get("gas_expenditure_record_present") is False and spent == {"gas_used": "0", "tokens_used": "0"}, "unknown Radix fee has fabricated canonical gas marker/value")
            else:
                spent = canonical[0]["spent"]
                require(canonical[0].get("gas_expenditure_record_present") is True and all(isinstance(spent.get(field), str) and spent[field].isdigit() and int(spent[field]) == actual[field] for field in ("gas_used", "tokens_used")), "Radix old canonical Rust expenditure differs from exact receipt floor")
            rawhex(operation["context"], 32)
            result.append({"id": message_id, "identity": txid, "signed_wire": proof["signed_wire"], "intent_discriminator": integer(proof["sdk"]["intent_discriminator"]), "epoch_range": [proof["sdk"]["start_epoch_inclusive"], proof["sdk"]["end_epoch_exclusive"]], "actual_fee": actual, "context": operation["context"], "expected_context_checked": operation["expected_context_checked"], "configuration_authority_verified": False})
        require(len(result) == len(rows), "Radix stopped signed/cost evidence incomplete")
        return result

    def readiness(self, session, before_captures, after_captures):
        from collections import Counter
        require(len(before_captures) == len(after_captures) == 4, "Radix actual split restart capture count differs")
        names = set(self.case["chain_names"])
        for captures in (before_captures, after_captures):
            require(Counter(row["original"]["role"] for row in captures) == {"relayer": 1, "validator": 2, "scraper": 1}, "Radix restarted role multiplicity differs")
            require({row["original"]["role_chain_names"][0] for row in captures if row["original"]["role"] == "validator" and len(row["original"]["role_chain_names"]) == 1} == names, "Radix restarted validator origin coverage differs")
            require(all(set(row["original"]["role_chain_names"]) == names and len(row["original"]["role_chain_names"]) == 2 for row in captures if row["original"]["role"] != "validator"), "Radix restarted relayer/scraper chain coverage differs")
            require(all(row["original"]["chains"][name]["protocol"] == "radix" for row in captures for name in row["original"]["role_chain_names"]), "Radix restarted native protocol differs")
            require(all(type(row.get("capture_ordinal")) is int and row["capture_ordinal"] >= 0 and type(row.get("captured_monotonic_ns")) is int and row["captured_monotonic_ns"] > 0 for row in captures) and len({row["capture_ordinal"] for row in captures}) == 4, "Radix actual capture epoch missing/duplicate")
        require(min(row["capture_ordinal"] for row in after_captures) > max(row["capture_ordinal"] for row in before_captures) and min(row["captured_monotonic_ns"] for row in after_captures) > max(row["captured_monotonic_ns"] for row in before_captures), "Radix old captures reused as restart")
        snapshot = self.collect(session, self.case["initial_corpus"]["dispatches"], "after_restart")
        return {"actual_native_dispatches": len(snapshot["messages"]), "actual_native_deliveries": len(snapshot["deliverable_messages"]), "actual_publications": self.checkpoints(session, snapshot), "no_account_nonce_claim": True, "shared_parentwait_and_600_policy_required": True}
