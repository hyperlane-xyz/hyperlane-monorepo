"""Starknet native evidence adapter. Import/construction have no I/O effects.

Source fixture: devnet 0.4.2, starkli 0.4.1, contracts 0.3.9, two domains,
ten one-way messages. No IGP support is invented. This module is a verifier,
not a node/process controller and not an execution approval.
"""
from __future__ import annotations

import ctypes
import hashlib
import json
import pathlib
import urllib.parse

from multivm_evidence import checked_artifact, hex_bytes, message_wire, require, urls
from multivm_evm import checkpoint_digest, merkle_roots, recover_signature, sql_delivery_query, sql_message_query, verify_sql_message
from multivm_sql import event_metadata, sql_event_query

PRIME = 2 ** 251 + 17 * 2 ** 192 + 1
MASK250 = 2 ** 250 - 1
ACCOUNT = ("0x064b48806902a367c8598f4f95c305e8c"
           "1a1acba5f082d294a43793113115691")
DOMAINS = {23448593, 23448594}
MAX_FELTS = 32768
MAX_EVENTS = 8192


def felt(value):
    require(isinstance(value, str) and value.startswith("0x") and 0 < len(value[2:]) <= 64 and all(c in "0123456789abcdefABCDEF" for c in value[2:]), "invalid Starknet felt text")
    number = int(value[2:], 16)
    require(number < PRIME, "Starknet felt outside prime field")
    return number


def full(value):
    return "0x" + felt(value).to_bytes(32, "big").hex()


def bounded(value, bits, name):
    require(type(value) is int and 0 <= value < 2 ** bits, "invalid " + name)
    return value


class Cairo:
    def __init__(self, values):
        require(isinstance(values, list) and len(values) <= MAX_FELTS, "Cairo felt bound")
        self.values = [felt(value) for value in values]
        self.position = 0

    def integer(self, bits=252):
        require(self.position < len(self.values), "truncated Cairo value")
        value = self.values[self.position]
        self.position += 1
        return bounded(value, bits, "Cairo integer")

    def hash(self):
        low, high = self.integer(128), self.integer(128)
        return "0x" + (low + (high << 128)).to_bytes(32, "big").hex()

    def bytes(self):
        size, count = self.integer(32), self.integer(32)
        require(size <= 1024 * 1024 and count == (size + 15) // 16 and count <= len(self.values) - self.position, "invalid Hyperlane Cairo Bytes length")
        raw = b"".join(self.integer(128).to_bytes(16, "big") for _ in range(count))
        require(not any(raw[size:]), "nonzero Cairo Bytes padding")
        return raw[:size]

    def message(self, keccak):
        version, nonce, origin = self.integer(8), self.integer(32), self.integer(32)
        sender = self.hash()
        destination, recipient = self.integer(32), self.hash()
        body = self.bytes()
        require(version == 3, "non-V3 native Hyperlane message")
        wire = bytes([version]) + nonce.to_bytes(4, "big") + origin.to_bytes(4, "big") + hex_bytes(sender, 32) + destination.to_bytes(4, "big") + hex_bytes(recipient, 32) + body
        return message_wire("0x" + wire.hex(), keccak)

    def finish(self):
        require(self.position == len(self.values), "trailing Cairo values")


def calls(encoded, encoding="modern"):
    decoder = Cairo(encoded)
    count = decoder.integer(32)
    require(0 < count <= 256, "invalid Starknet account call count")
    result = []
    if encoding == "modern":
        for _ in range(count):
            target, selector, size = decoder.integer(), decoder.integer(), decoder.integer(32)
            require(size <= len(decoder.values) - decoder.position, "truncated account calldata")
            result.append({"target": full(hex(target)), "selector": selector, "calldata": [hex(v) for v in decoder.values[decoder.position:decoder.position + size]]})
            decoder.position += size
        decoder.finish()
    else:
        require(encoding == "legacy", "unknown account encoding")
        headers = [(decoder.integer(), decoder.integer(), decoder.integer(32), decoder.integer(32)) for _ in range(count)]
        total = decoder.integer(32)
        require(total == len(decoder.values) - decoder.position, "legacy calldata total differs")
        offset = 0
        for target, selector, start, size in headers:
            require(start == offset and size <= total - offset, "legacy account offsets overlap/gap")
            result.append({"target": full(hex(target)), "selector": selector, "calldata": [hex(v) for v in decoder.values[decoder.position + start:decoder.position + start + size]]})
            offset += size
        require(offset == total, "legacy calldata trailing values")
    return result


def process(call, mailbox, selector, keccak):
    require(call["target"] == full(mailbox) and call["selector"] == selector, "Invoke contains foreign/non-process call")
    decoder = Cairo(call["calldata"])
    metadata = decoder.bytes()
    message = decoder.message(keccak)
    decoder.finish()
    return message, metadata


def signed_wire(transaction):
    """Reproduce the frozen Request serialization, never the RPC envelope."""
    require(isinstance(transaction, dict), "Invoke transaction missing")
    require(transaction.get("type") == "INVOKE" and felt(transaction.get("version")) == 3, "executable InvokeV3 required")
    result = {}
    for name in ("type", "version", "sender_address", "calldata", "signature", "nonce", "resource_bounds", "tip", "paymaster_data", "account_deployment_data", "nonce_data_availability_mode", "fee_data_availability_mode"):
        require(name in transaction, "Invoke field missing: " + name)
        value = transaction[name]
        if name == "type":
            result[name] = value
        elif name in {"nonce_data_availability_mode", "fee_data_availability_mode"}:
            require(value == "L1", "unsupported data availability mode")
            result[name] = value
        elif name in {"calldata", "signature", "paymaster_data", "account_deployment_data"}:
            require(isinstance(value, list) and len(value) <= MAX_FELTS, "Invoke array bound")
            if name == "signature":
                require(len(value) == 2, "Stark ECDSA signature tuple differs")
            if name in {"paymaster_data", "account_deployment_data"}:
                require(value == [], "unsupported sponsored/deploy Invoke")
            result[name] = [hex(felt(item)) for item in value]
        elif name == "resource_bounds":
            require(isinstance(value, dict) and set(value) == {"l1_gas", "l2_gas", "l1_data_gas"}, "resource dimensions differ")
            bounds = {}
            for resource in ("l1_gas", "l2_gas", "l1_data_gas"):
                item = value[resource]
                require(isinstance(item, dict) and set(item) == {"max_amount", "max_price_per_unit"}, "resource fields differ")
                amount, price = felt(item["max_amount"]), felt(item["max_price_per_unit"])
                bounded(amount, 64, "resource amount")
                bounded(price, 128, "resource price")
                bounds[resource] = {"max_amount": hex(amount), "max_price_per_unit": hex(price)}
            result[name] = bounds
        else:
            result[name] = hex(felt(value))
    bounded(felt(result["tip"]), 64, "Invoke tip")
    return json.dumps(result, separators=(",", ":"), ensure_ascii=True).encode()


def decimal_u256(value):
    require(isinstance(value, str) and value and value.isascii() and value.isdigit() and (value == "0" or not value.startswith("0")), "exact decimal u256 text required")
    require(len(value) <= 78 and int(value) < 2 ** 256, "decimal u256 overflow")
    return int(value)


def public_quote(operation, member_count):
    quote = operation.get("starknet")
    require(isinstance(quote, dict) and set(quote) == {"gas_limit", "estimated_cost", "batch"}, "frozen public Starknet quote missing/fields differ")
    bounded(quote["gas_limit"], 64, "frozen scalar gas weight")
    decimal_u256(quote["estimated_cost"])
    batch = quote["batch"]
    if member_count == 1:
        require(batch is None, "scalar operation carries batch manifest")
        return quote
    require(isinstance(batch, dict) and set(batch) == {"version", "members"} and type(batch["version"]) is int and batch["version"] == 1, "frozen batch version/fields differ")
    members = batch["members"]
    require(isinstance(members, list) and len(members) == member_count and 2 <= len(members) <= 256, "frozen batch count differs")
    ids = set()
    for member in members:
        require(isinstance(member, dict) and set(member) == {"operation_id", "origin", "origin_hook", "generation", "source_intent_digest", "gas_limit", "estimated_cost"}, "frozen member fields differ")
        for key in ("operation_id", "source_intent_digest"):
            require(member[key] == "0x" + hex_bytes(member[key], 32).hex(), "noncanonical frozen member ID/digest")
        require(member["operation_id"] not in ids, "duplicate frozen member ID")
        ids.add(member["operation_id"])
        if member["origin_hook"] is not None:
            require(member["origin_hook"] == "0x" + hex_bytes(member["origin_hook"], 32).hex(), "noncanonical frozen origin hook")
        bounded(member["origin"], 32, "frozen origin")
        bounded(member["generation"], 64, "frozen generation")
        bounded(member["gas_limit"], 64, "frozen gas weight")
        decimal_u256(member["estimated_cost"])
    return quote


def allocated_fees(fee, weights):
    bounded(fee, 256, "actual native fee")
    require(isinstance(weights, list) and 1 <= len(weights) <= 256, "fee member bound")
    total = sum(bounded(weight, 64, "member gas weight") for weight in weights)
    require(total > 0, "zero-total batch is ineligible")
    shares = [fee * weight // total for weight in weights]
    dust = fee - sum(shares)
    require(0 <= dust < len(weights), "native floor allocation does not conserve fee plus dust")
    return shares, dust


class NativeCrypto:
    """Pinned SDK primitives only. No key signing or custom curve arithmetic."""
    def __init__(self, descriptor):
        path = checked_artifact(descriptor)
        self.library = ctypes.CDLL(str(path))
        self.library.ziggy_starknet_crypto_abi_version.restype = ctypes.c_uint32
        require(self.library.ziggy_starknet_crypto_abi_version() == 1, "native Starknet ABI differs")
        pointer = ctypes.POINTER(ctypes.c_ubyte)
        self.library.ziggy_starknet_poseidon.argtypes = [pointer, ctypes.c_size_t, pointer]
        self.library.ziggy_starknet_poseidon.restype = ctypes.c_int32
        self.library.ziggy_starknet_verify.argtypes = [pointer, pointer, pointer, pointer]
        self.library.ziggy_starknet_verify.restype = ctypes.c_int32
        self.descriptor = descriptor

    def poseidon(self, values):
        require(len(values) <= MAX_FELTS, "Poseidon input bound")
        raw = b"".join(bounded(item, 252, "Poseidon element").to_bytes(32, "big") for item in values)
        require(all(item < PRIME for item in values), "Poseidon element not felt")
        data = (ctypes.c_ubyte * max(1, len(raw)))()
        if raw:
            ctypes.memmove(data, raw, len(raw))
        out = (ctypes.c_ubyte * 32)()
        require(self.library.ziggy_starknet_poseidon(data, len(values), out) == 0, "native Poseidon failed")
        return felt("0x" + bytes(out).hex())

    def verify(self, public, digest, signature):
        arrays = [(ctypes.c_ubyte * len(raw)).from_buffer_copy(raw) for raw in (public.to_bytes(32, "big"), digest.to_bytes(32, "big"), b"".join(part.to_bytes(32, "big") for part in signature))]
        valid = ctypes.c_ubyte(0)
        require(self.library.ziggy_starknet_verify(*arrays, ctypes.byref(valid)) == 0 and valid.value == 1, "native Stark signature invalid")
        checked_artifact(self.descriptor)


def invoke_hash(transaction, chain_id, native):
    # SDK InvokeV3 domain-separated Poseidon construction, independently applied
    # to the actual node transaction and pinned chain ID, never a runtime digest.
    signed_wire(transaction)
    bound = transaction["resource_bounds"]
    resources = []
    for key, tag in (("l1_gas", b"L1_GAS"), ("l2_gas", b"L2_GAS"), ("l1_data_gas", b"L1_DATA")):
        item = bound[key]
        resources.append((int.from_bytes(tag, "big") << 192) | (felt(item["max_amount"]) << 128) | felt(item["max_price_per_unit"]))
    empty = native.poseidon([])
    fee = native.poseidon([felt(transaction["tip"])] + resources)
    return native.poseidon([int.from_bytes(b"invoke", "big"), 3, felt(transaction["sender_address"]), fee, empty, chain_id, felt(transaction["nonce"]), 0, empty, native.poseidon([felt(v) for v in transaction["calldata"]])])


class Adapter:
    payments_supported = False

    def __init__(self, manifest, case):
        self.manifest, self.case = manifest, case
        self.native = None
        self.network_ids = {}
        self.receipt_members = {}
        self.provisional = {}

    def validate_case(self):
        require(self.manifest.get("scenario") == "starknet", "wrong Starknet scenario")
        require(len(self.case["chain_names"]) == 2 and len(set(self.case["chain_names"])) == 2, "Source two-node scenario required")
        require(set(self.case["domain_names"].values()) == set(self.case["chain_names"]) and {int(v) for v in self.case["domain_names"]} == DOMAINS, "Source Starknet domain set differs")
        require(self.case["initial_corpus"] == {"dispatches": 10, "deliveries": 10, "failed_body": 0, "zero_insertions": 0, "double_insertions": 0}, "Source Starknet workload differs")
        require(self.case.get("additional_refused_dispatches", 0) == 0, "Source Starknet has no extra reorg dispatch corpus")
        require(set(self.case["relayer_addresses"]) == set(self.case["chain_names"]) and all(full(v) == full(ACCOUNT) for v in self.case["relayer_addresses"].values()), "Source actual public Stark account differs")
        require(set(self.case["validator_addresses"]) == set(self.case["chain_names"]), "expected checkpoint validators missing")
        for value in self.case["validator_addresses"].values():
            hex_bytes(value, 20)

    def transport(self, field):
        require(field in {"rpcurls", "customrpcurls"}, "unsupported Starknet endpoint field")
        return "http-json"

    def _chains(self, session):
        relayers = [row["original"] for row in session.captures if row["original"]["role"] == "relayer"]
        require(relayers, "actual relayer config missing")
        chains = relayers[-1]["chains"]
        require(set(chains) == set(self.case["chain_names"]), "actual Starknet chains differ")
        for name, chain in chains.items():
            require(chain["protocol"] == "starknet" and int(chain["domainid"]) in DOMAINS and self.case["domain_names"][str(chain["domainid"])] == name, "actual Starknet protocol/domain differs")
            require(felt(chain["mailbox"]) > 0 and felt(chain["merkletreehook"]) > 0 and felt(chain["interchaingaspaymaster"]) == 0, "actual deployed contracts/unsupported IGP differ")
            require(chain["maxbatchsize"] == 10, "Source max batch differs")
        return chains

    def _selector(self, session, name):
        return int(session.keccak(name), 16) & MASK250

    def _process_ids(self, session, transaction, chain):
        decoded = [process(call, chain["mailbox"], self._selector(session, "process"), session.keccak)[0] for call in calls(transaction["calldata"])]
        ids = [message["id"] for message in decoded]
        require(len(ids) == len(set(ids)) and all(message["destination"] == int(chain["domainid"]) for message in decoded), "Invoke member IDs/domain differ")
        return ids

    def _receipt_ids(self, session, receipt, chain):
        selector = self._selector(session, "ProcessId")
        ids = []
        for event in receipt.get("events", []):
            if full(event["from_address"]) == full(chain["mailbox"]) and [felt(v) for v in event["keys"]] == [selector]:
                decoder = Cairo(event["data"])
                ids.append(decoder.hash())
                decoder.finish()
        require(len(ids) == len(set(ids)), "duplicate canonical ProcessId")
        return ids

    def observe(self, session, event):
        if event["status"] != 200 or event["endpoint_field"] not in {"rpcurls", "customrpcurls"}:
            return
        requests = event["request"] if isinstance(event["request"], list) else [event["request"]]
        responses = event["response"] if isinstance(event["response"], list) else [event["response"]]
        require(len(requests) == len(responses), "Starknet response count differs")
        answers = {row["id"]: row for row in responses}
        require(len(answers) == len(responses), "duplicate Starknet response IDs")
        matching = [row["original"]["chains"][event["chain"]] for row in session.captures if event["chain"] in row["original"]["chains"]]
        require(matching, "observed chain was not captured")
        chain = matching[-1]
        for request in requests:
            require(request["id"] in answers, "Starknet response ID missing")
            answer = answers[request["id"]]
            if "error" in answer:
                continue
            method, params, value = request["method"], request.get("params", {}), answer.get("result")
            if method == "starknet_addInvokeTransaction" and event["role"] == "relayer":
                require(isinstance(params, dict) and set(params) == {"invoke_transaction"}, "actual Invoke RPC parameters differ")
                tx = params["invoke_transaction"]
                identity = full(value["transaction_hash"])
                ids = self._process_ids(session, tx, chain)
                digest = hashlib.sha256(signed_wire(tx)).hexdigest()
                session.record_broadcast(event["chain"], identity, digest, message_ids=ids)
            elif method == "starknet_getTransactionReceipt" and isinstance(value, dict):
                if value.get("finality_status") not in {"ACCEPTED_ON_L1", "ACCEPTED_ON_L2"} or value.get("execution_status") != "SUCCEEDED":
                    continue
                identity = full(value["transaction_hash"])
                require(isinstance(params, dict) and full(params["transaction_hash"]) == identity, "observed receipt hash differs")
                ids = self._receipt_ids(session, value, chain)
                # Source ReceiptBlock::PreConfirmed has a number but no hash.
                # It is activity, never a mined inclusion/canonical member proof.
                height = bounded(value.get("block_number"), 64, "observed receipt height")
                if value.get("block_hash") is None:
                    require(isinstance(value.get("events"), list) and len(value["events"]) <= MAX_EVENTS, "observed preconfirmed receipt events differ")
                    continue
                block_hash = full(value["block_hash"])
                self.receipt_members[(event["chain"], identity)] = ids
                if (event["chain"], identity) in session.self_transactions:
                    for message_id in ids:
                        session.record_inclusion(event["chain"], message_id, identity, event["received_monotonic_ns"], {"block_number": height, "block_hash": block_hash, "kind": "observed_native_receipt"})
            elif method == "starknet_call" and isinstance(value, list) and len(value) == 1 and felt(value[0]) == 1:
                require(isinstance(params, dict), "native call parameters differ")
                call = params.get("request", {})
                if full(call.get("contract_address", "0x0")) != full(chain["mailbox"]) or felt(call.get("entry_point_selector", "0x0")) != self._selector(session, "delivered"):
                    continue
                decoder = Cairo(call["calldata"])
                message_id = decoder.hash()
                decoder.finish()
                now = event["received_monotonic_ns"]
                self.provisional.setdefault((event["chain"], message_id), now)
                # A delivered call can be earlier than receipt observation. It
                # never invents a self-submitted transaction identity.
                identity = next((tx for (name, tx), ids in self.receipt_members.items() if name == event["chain"] and message_id in ids and (name, tx) in session.self_transactions), "0x" + "00" * 32)
                session.record_inclusion(event["chain"], message_id, identity, now, {"kind": "observed_native_delivered"})

    def _height(self, session, name, chain):
        tip = session.rpc(name, "starknet_blockNumber", {})
        bounded(tip, 64, "native block height")
        depth = chain.get("blocks", {}).get("reorgperiod", 1)
        bounded(depth, 64, "Source block finality depth")
        return max(0, tip - depth)

    def _receipt(self, session, name, identity, final_height):
        identity = full(identity)
        receipt = session.rpc(name, "starknet_getTransactionReceipt", {"transaction_hash": hex(felt(identity))})
        require(receipt.get("finality_status") in {"ACCEPTED_ON_L1", "ACCEPTED_ON_L2"} and receipt.get("execution_status") == "SUCCEEDED", "native receipt pending/reverted")
        require(full(receipt["transaction_hash"]) == identity, "native receipt hash differs")
        height = bounded(receipt["block_number"], 64, "receipt height")
        require(height <= final_height, "receipt not at Source finality depth")
        block_id = {"block_number": height}
        block = session.rpc(name, "starknet_getBlockWithTxHashes", {"block_id": block_id})
        require(block.get("status") in {"ACCEPTED_ON_L1", "ACCEPTED_ON_L2"} and block["block_number"] == height and full(block["block_hash"]) == full(receipt["block_hash"]), "native receipt not canonical by number")
        hashes = [full(v) for v in block["transactions"]]
        require(len(hashes) == len(set(hashes)) and hashes.count(identity) == 1, "native canonical transaction membership differs")
        transaction = session.rpc(name, "starknet_getTransactionByHash", {"transaction_hash": hex(felt(identity))})
        require(full(transaction["transaction_hash"]) == identity, "native transaction identity differs")
        require(isinstance(receipt.get("events"), list) and len(receipt["events"]) <= MAX_EVENTS, "receipt event bound")
        fee = receipt.get("actual_fee")
        require(isinstance(fee, dict) and fee.get("unit") in {"FRI", "WEI"}, "native actual fee missing")
        amount = felt(fee["amount"])
        require(amount > 0, "native actual positive fee missing")
        after = session.rpc(name, "starknet_getBlockWithTxHashes", {"block_id": block_id})
        require(after == block, "native canonical header changed during verification")
        return {"receipt": receipt, "block": block, "transaction": transaction, "transaction_index": hashes.index(identity), "actual_fee": amount, "fee_unit": fee["unit"]}

    def _event_metadata(self, name, chain, proof, index, event):
        # Positions come from the authenticated receipt array and canonical
        # block transaction list, never the RPC page order.
        return event_metadata(name, int(chain["domainid"]), {"identity": full(proof["receipt"]["transaction_hash"]), "block_hash": full(proof["receipt"]["block_hash"]), "height": proof["receipt"]["block_number"], "index": proof["transaction_index"]}, {"event_index": index, "emitter": full(event["from_address"])})

    def _events(self, session, name, address, selector, height):
        result, seen = [], set()
        token = None
        for _ in range(128):
            request = {"from_block": {"block_number": 0}, "to_block": {"block_number": height}, "address": hex(felt(address)), "keys": [[hex(selector)]], "chunk_size": 50}
            if token is not None:
                request["continuation_token"] = token
            page = session.rpc(name, "starknet_getEvents", {"filter": request})
            require(isinstance(page.get("events"), list) and len(page["events"]) <= 50, "native event page shape differs")
            for event in page["events"]:
                require(full(event["from_address"]) == full(address) and [felt(v) for v in event["keys"]] == [selector] and type(event["block_number"]) is int and 0 <= event["block_number"] <= height, "native event outside requested filter")
            result.extend(page["events"])
            require(len(result) <= MAX_EVENTS, "native event bound")
            token = page.get("continuation_token")
            if token in (None, ""):
                return result
            require(isinstance(token, str) and len(token) <= 4096 and token not in seen, "native event token repeated/oversize")
            seen.add(token)
        raise ValueError("native event page limit")

    def collect(self, session, expected, phase):
        self.validate_case()
        require(phase in {"initial", "after_restart", "after_source_reorg", "final"} and expected == 10, "Source Starknet collection scope differs")
        chains = self._chains(session)
        dispatch_selector, process_selector = self._selector(session, "Dispatch"), self._selector(session, "ProcessId")
        proofs, messages = {}, []
        for name, chain in chains.items():
            network = felt(session.rpc(name, "starknet_chainId", {}))
            if chain.get("chainid", ""):
                require(felt(chain["chainid"]) == network, "configured/actual native chain ID mismatch")
            require(name not in self.network_ids or self.network_ids[name] == network, "native network identity changed across restart")
            self.network_ids[name] = network
            height = self._height(session, name, chain)
            for event in self._events(session, name, chain["mailbox"], dispatch_selector, height):
                identity = full(event["transaction_hash"])
                proof = proofs.setdefault((name, identity), None)
                if proof is None:
                    proof = self._receipt(session, name, identity, height)
                    proofs[(name, identity)] = proof
                matched = [(index, row) for index, row in enumerate(proof["receipt"]["events"]) if row == {key: event[key] for key in ("from_address", "keys", "data")}]
                require(len(matched) == 1 and full(event["block_hash"]) == full(proof["receipt"]["block_hash"]) and event["block_number"] == proof["receipt"]["block_number"], "dispatch page is not exact unique receipt event")
                decoder = Cairo(event["data"])
                sender, destination, recipient = decoder.hash(), decoder.integer(32), decoder.hash()
                message = decoder.message(session.keccak)
                decoder.finish()
                require((sender, destination, recipient) == (message["sender"], message["destination"], message["recipient"]) and message["origin"] == int(chain["domainid"]), "native Dispatch fields disagree with packed message")
                require(hex_bytes(message["body"]) == b"hello world", "Source Starknet dispatch body differs")
                insertions, insertion_metadata, dispatch_ids = [], [], []
                for event_index, row in enumerate(proof["receipt"]["events"]):
                    keys = [felt(v) for v in row["keys"]]
                    if full(row["from_address"]) == full(chain["mailbox"]) and keys == [self._selector(session, "DispatchId")]:
                        data = Cairo(row["data"])
                        dispatch_ids.append(data.hash())
                        data.finish()
                    if full(row["from_address"]) == full(chain["merkletreehook"]) and keys == [self._selector(session, "InsertedIntoTree")]:
                        data = Cairo(row["data"])
                        leaf, index = data.hash(), data.integer(32)
                        data.finish()
                        if leaf == message["id"]:
                            insertions.append(index)
                            insertion_metadata.append(self._event_metadata(name, chain, proof, event_index, row))
                require(dispatch_ids.count(message["id"]) == 1 and len(insertions) == 1, "canonical DispatchId/insertion missing or repeated")
                message.update(origin_chain=name, dispatch_transaction=identity, dispatch_block=event["block_number"], dispatch_log_index=matched[0][0], dispatch_metadata=self._event_metadata(name, chain, proof, matched[0][0], proof["receipt"]["events"][matched[0][0]]), insertions=insertions, insertion_metadata=insertion_metadata, payments=[], payment_metadata=[])
                messages.append(message)
        require(len(messages) == 10 and len({row["id"] for row in messages}) == 10 and all(row["origin"] == min(DOMAINS) and row["destination"] == max(DOMAINS) for row in messages), "Source one-way dispatch corpus differs")
        require(sorted(row["nonce"] for row in messages) == list(range(10)) and sorted(index for row in messages for index in row["insertions"]) == list(range(10)), "Source dispatch/insertion stream differs")
        delivered_by_id, transactions = {}, []
        for name, chain in chains.items():
            height = self._height(session, name, chain)
            hashes = {full(event["transaction_hash"]) for event in self._events(session, name, chain["mailbox"], process_selector, height)}
            for identity in sorted(hashes):
                proof = self._receipt(session, name, identity, height)
                ids = self._receipt_ids(session, proof["receipt"], chain)
                require(ids and set(ids) <= {row["id"] for row in messages} and (name, identity) in session.self_transactions, "delivery is foreign/not actual self-broadcast")
                require(self._process_ids(session, proof["transaction"], chain) == ids, "signed call order and ProcessId order differ")
                proof["message_ids"] = ids
                proof["chain_id"] = hex(self.network_ids[name])
                for message_id in ids:
                    require(message_id not in delivered_by_id, "message delivered by multiple canonical transactions")
                    positions = [(index, event) for index, event in enumerate(proof["receipt"]["events"]) if full(event["from_address"]) == full(chain["mailbox"]) and [felt(value) for value in event["keys"]] == [process_selector] and self._receipt_ids(session, {"events": [event]}, chain) == [message_id]]
                    require(len(positions) == 1, "canonical delivery event coordinates missing/ambiguous")
                    position, event = positions[0]
                    delivered_by_id[message_id] = (name, identity, self._event_metadata(name, chain, proof, position, event))
                transactions.append({"chain": name, "transaction_hash": identity, "proof": proof})
        require(set(delivered_by_id) == {row["id"] for row in messages}, "actual canonical delivery coverage differs")
        for message in messages:
            name, identity, metadata = delivered_by_id[message["id"]]
            chain = chains[name]
            require(int(chain["domainid"]) == message["destination"], "delivery domain differs")
            low, high = int(message["id"], 16) & (2 ** 128 - 1), int(message["id"], 16) >> 128
            result = session.rpc(name, "starknet_call", {"request": {"contract_address": hex(felt(chain["mailbox"])), "entry_point_selector": hex(self._selector(session, "delivered")), "calldata": [hex(low), hex(high)]}, "block_id": {"block_number": self._height(session, name, chain)}})
            require(isinstance(result, list) and len(result) == 1 and felt(result[0]) == 1, "native canonical delivered flag absent")
            message.update(delivery_chain=name, delivery_transaction=identity, delivery_metadata=metadata)
        return {"messages": sorted(messages, key=lambda row: row["nonce"]), "deliverable_messages": messages, "native_delivery_transactions": transactions, "payments_supported": False, "actual_chain_ids": {name: hex(value) for name, value in self.network_ids.items()}}

    def checkpoints(self, session, snapshot):
        result = []
        for capture in session.captures:
            original, proxied = capture["original"], capture["proxied"]
            if original["role"] != "validator":
                continue
            require(len(original["role_chain_names"]) == 1, "validator origin scope differs")
            name = original["role_chain_names"][0]
            chain = original["chains"][name]
            syncer = original["checkpoint_syncer"]
            require(syncer["type"] == "localStorage", "actual local publication required")
            directory = pathlib.Path(syncer["path"])
            directory = session.owned_path(directory.relative_to(self.manifest["task_root"]))
            metadata_path = directory / "metadata_latest.json"
            require(metadata_path.is_file() and not metadata_path.is_symlink(), "actual validator metadata missing")
            selected = proxied["chains"][name]
            rpc_urls = urls(selected.get("customrpcurls", selected["rpcurls"]))
            expected_metadata = {"git_sha": self.manifest["runtime_source_commit"], "rpcs": [{"url_hash": session.keccak(url), "host_hash": session.keccak(urllib.parse.urlsplit(url).hostname)} for url in rpc_urls], "allows_public_rpcs": original["allows_public_rpcs"]}
            require(json.loads(metadata_path.read_text()) == expected_metadata, "actual metadata identity/privacy differs")
            leaves = merkle_roots([row for row in snapshot["messages"] if row["origin_chain"] == name], session.keccak)
            objects = []
            paths = list(directory.glob("*_with_id.json"))
            require(bool(paths) == bool(leaves), "native empty/nonempty checkpoint stream differs")
            if leaves:
                require((directory / f'{leaves[-1]["index"]}_with_id.json').is_file(), "actual final checkpoint missing")
            for path in paths:
                require(path.is_file() and not path.is_symlink(), "checkpoint object unsafe")
                index_text = path.name.removesuffix("_with_id.json")
                require(index_text.isdigit() and str(int(index_text)) == index_text, "checkpoint filename invalid")
                index = int(index_text)
                require(index < len(leaves), "checkpoint beyond native leaves")
                leaf = leaves[index]
                obj = json.loads(path.read_text())
                value = obj["value"]
                checkpoint = value["checkpoint"]
                require(checkpoint == {"merkle_tree_hook_address": full(chain["merkletreehook"]), "mailbox_domain": int(chain["domainid"]), "root": leaf["root"], "index": leaf["index"]} and value["message_id"].lower() == leaf["message_id"], "native checkpoint fields differ")
                signer = recover_signature(checkpoint_digest(checkpoint, value["message_id"], session.keccak), obj["signature"], session.keccak)
                require(signer == self.case["validator_addresses"][name].lower(), "actual checkpoint signer differs")
                objects.append({"path": str(path), "bytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "index": index, "signer": signer})
            result.append({"chain": name, "metadata": expected_metadata, "verified_checkpoint_objects": objects, "published_bytes": [{key: obj[key] for key in ("path", "bytes", "sha256")} for obj in objects], "zero_leaf_origin_no_signature_credit": not leaves})
        require({row["chain"] for row in result} == set(self.case["chain_names"]), "validator publication coverage differs")
        return result

    def sql(self, session, snapshot):
        names = {int(chain["domainid"]): name for name, chain in self._chains(session).items()}
        result = []
        for message in snapshot["messages"]:
            require(message["payments"] == [], "unsupported Starknet IGP invented")
            origin = session.query_sql(message["origin_chain"], sql_message_query(message))
            destination = session.query_sql(names[message["destination"]], sql_delivery_query(message, message["delivery_transaction"]))
            exact_events = [("dispatch", message["dispatch_metadata"]), ("delivery", message["delivery_metadata"])]
            require(len(message["insertion_metadata"]) == len(message["insertions"]) and message["payment_metadata"] == [], "canonical native event coordinate coverage differs")
            exact_events.extend(("insertion", metadata) for metadata in message["insertion_metadata"])
            metadata_proofs = []
            for kind, metadata in exact_events:
                require(session.query_sql(metadata["chain"], sql_event_query(kind, message["id"], metadata)) == "1", "persisted native canonical event coordinates differ")
                metadata_proofs.append({"kind": kind, "metadata": metadata, "exact_rows": 1})
            result.append({"id": message["id"], "proof": verify_sql_message(origin, destination, message, delivered=True), "canonical_event_rows": metadata_proofs, "payments_supported": False})
        return result

    def native_rows(self, session, snapshot, rows, baseline):
        chains = self._chains(session)
        by_id = {row["id"]: row["operation"] for row in rows if row.get("present", True) is True}
        messages = {row["id"]: row for row in snapshot["deliverable_messages"]}
        require(len(by_id) == len(rows) and set(by_id) == set(messages), "stopped native operation coverage differs")
        if self.native is None:
            self.native = NativeCrypto(self.manifest["artifacts"]["starknet"])
        result = []
        for entry in snapshot["native_delivery_transactions"]:
            name, identity, proof = entry["chain"], entry["transaction_hash"], entry["proof"]
            chain, tx = chains[name], proof["transaction"]
            account = full(self.case["relayer_addresses"][name])
            require(full(tx["sender_address"]) == account and proof["chain_id"] == hex(self.network_ids[name]), "actual network/account differs")
            height = proof["receipt"]["block_number"]
            canonical_before = session.rpc(name, "starknet_getBlockWithTxHashes", {"block_id": {"block_number": height}})
            require(canonical_before["block_number"] == height and full(canonical_before["block_hash"]) == full(proof["receipt"]["block_hash"]), "native row proof block is no longer canonical")
            public_values = session.rpc(name, "starknet_call", {"request": {"contract_address": hex(felt(account)), "entry_point_selector": hex(self._selector(session, "get_public_key")), "calldata": []}, "block_id": {"block_number": height}})
            require(isinstance(public_values, list) and len(public_values) == 1, "actual account public key missing")
            public = felt(public_values[0])
            digest = invoke_hash(tx, self.network_ids[name], self.native)
            require(full(hex(digest)) == identity, "actual InvokeV3 hash differs")
            self.native.verify(public, digest, [felt(v) for v in tx["signature"]])
            before_nonce = felt(session.rpc(name, "starknet_getNonce", {"block_id": {"block_number": max(0, height - 1)}, "contract_address": hex(felt(account))}))
            after_nonce = felt(session.rpc(name, "starknet_getNonce", {"block_id": {"block_number": height}, "contract_address": hex(felt(account))}))
            require(before_nonce <= felt(tx["nonce"]) < after_nonce, "native account nonce consumption not canonical")
            canonical_after = session.rpc(name, "starknet_getBlockWithTxHashes", {"block_id": {"block_number": height}})
            require(canonical_after == canonical_before, "native authority/nonce block changed during verification")
            raw = signed_wire(tx)
            signed = {"bytes": len(raw), "sha256": "0x" + hashlib.sha256(raw).hexdigest()}
            ids = proof["message_ids"]
            require(self._process_ids(session, tx, chain) == ids, "Invoke group membership changed")
            siblings = [by_id[message_id] for message_id in ids]
            quotes = [public_quote(operation, len(ids)) for operation in siblings]
            broadcasts = [row for row in session.broadcasts if row["chain"] == name and row["transaction_hash"] == identity]
            require(broadcasts and all(row["raw_transaction_sha256"].removeprefix("0x") == signed["sha256"][2:] and row.get("message_ids") == ids for row in broadcasts), "actual intercepted Invoke signed bytes/members differ")
            fees = []
            if len(ids) > 1:
                # This safe public extension is required; accepted reader v1
                # intentionally has no quote/manifest, so cannot prove batches.
                manifests = [quote["batch"] for quote in quotes]
                require(all(isinstance(item, dict) and item.get("version") == 1 for item in manifests) and all(item == manifests[0] for item in manifests), "frozen public batch manifest missing/different")
                manifest = manifests[0]["members"]
                require([item["operation_id"] for item in manifest] == ids, "frozen manifest/call order differs")
                weights = [bounded(item["gas_limit"], 64, "frozen member gas weight") for item in manifest]
                fees, _ = allocated_fees(proof["actual_fee"], weights)
                for member, operation, message_id in zip(manifest, siblings, ids):
                    message = messages[message_id]
                    require(member["origin"] == message["origin"] and member["generation"] == operation["generation"] and member["origin_hook"] == full(chains[message["origin_chain"]]["merkletreehook"]), "frozen member authority differs")
                    hex_bytes(member["source_intent_digest"], 32)
                    require(operation["starknet"]["gas_limit"] == member["gas_limit"] and operation["starknet"]["estimated_cost"] == member["estimated_cost"], "member original quote differs")
            else:
                fees = [proof["actual_fee"]]
            for message_id, operation, fee in zip(ids, siblings, fees):
                message = messages[message_id]
                require(operation["stage"] == "delivered" and operation["confirmation_started"] is True and operation["kind"] == "process" and operation["target"] is None, "native operation not self-delivered")
                expected = {"protocol": "starknet", "origin": message["origin"], "destination": message["destination"], "mailbox": full(chain["mailbox"]), "chain_id": operation["authority"]["chain_id"], "origin_hook": full(chains[message["origin_chain"]]["merkletreehook"]), "operation_id": message_id, "generation": operation["generation"], "kind": "process", "target": None}
                require(operation["authority"] == expected and felt(expected["chain_id"]) == self.network_ids[name], "native Prepared authority differs")
                require(operation["nonce"] == message["nonce"] and operation["origin"] == message["origin"] and operation["destination"] == message["destination"] and operation["identity"] == {"kind": "hash256", "hex": identity} and operation["signed"] == signed, "stopped native signed identity/wire differs")
                expenditure = operation.get("expenditure")
                require(isinstance(expenditure, dict) and expenditure.get("present") is True and int.from_bytes(hex_bytes(expenditure["gas_used_hex"], 32), "big") == fee and int.from_bytes(hex_bytes(expenditure["tokens_used_hex"], 32), "big") == fee, "actual per-member fee allocation differs")
                result.append({"id": message_id, "identity": identity, "account": account, "public_key": hex(public), "native_signed_wire": signed, "account_nonce": tx["nonce"], "allocated_fee": fee, "whole_fee": proof["actual_fee"], "rounding_dust": proof["actual_fee"] - sum(fees), "context": operation["context"], "expected_context_checked": operation["expected_context_checked"], "configuration_authority_verified": False, "allocation_evidence": "Stored frozen weights plus independently verified canonical actual fee; no original scalar RPC estimate provenance."})
        require(len(result) == len(messages), "native signature/cost coverage incomplete")
        return result

    def readiness(self, session, before_captures, after_captures):
        # Session supplies two separate epochs, not a cumulative after list.
        from collections import Counter
        require(len(before_captures) == len(after_captures) == 4, "actual restarted capture count differs")
        names = set(self.case["chain_names"])
        for captures in (before_captures, after_captures):
            require(Counter(row["original"]["role"] for row in captures) == {"relayer": 1, "validator": 2, "scraper": 1}, "actual Source role multiplicity differs")
            require({row["original"]["role_chain_names"][0] for row in captures if row["original"]["role"] == "validator" and len(row["original"]["role_chain_names"]) == 1} == names, "actual Source validator origin coverage differs")
            require(all(set(row["original"]["role_chain_names"]) == names and len(row["original"]["role_chain_names"]) == 2 for row in captures if row["original"]["role"] != "validator"), "actual Source relayer/scraper chain coverage differs")
            require(all(row["original"]["chains"][name]["protocol"] == "starknet" for row in captures for name in row["original"]["role_chain_names"]), "restart native family differs")
            require(all(type(row.get("capture_ordinal")) is int and row["capture_ordinal"] >= 0 and type(row.get("captured_monotonic_ns")) is int and row["captured_monotonic_ns"] > 0 for row in captures), "actual capture epoch missing")
            require(len({row["capture_ordinal"] for row in captures}) == 4, "duplicate actual capture epoch")
        require(min(row["capture_ordinal"] for row in after_captures) > max(row["capture_ordinal"] for row in before_captures) and min(row["captured_monotonic_ns"] for row in after_captures) > max(row["captured_monotonic_ns"] for row in before_captures), "old captures reused as restarted epoch")
        snapshot = self.collect(session, 10, "after_restart")
        publications = self.checkpoints(session, snapshot)
        return {"actual_native_dispatches": len(snapshot["messages"]), "actual_native_deliveries": len(snapshot["deliverable_messages"]), "actual_publications": publications, "production600_policy_unchanged": True, "shared_restart_PID_and_no_resubmission_checks_required": True}
