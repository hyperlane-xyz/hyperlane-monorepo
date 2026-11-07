"""Independent Cosmos SDK wire/event evidence for owned native-node scenarios.

Imports have no I/O. All chain operations enter through the approved Session.
The codec accepts the concrete Source single-signer SIGN_MODE_DIRECT shape;
unsupported transaction forms cannot become a passing native proof.
"""
from __future__ import annotations

import base64
import hashlib
import json
import pathlib
import re
import time
from fractions import Fraction

from multivm_evidence import hex_bytes, require
from multivm_evm import SECP_G, SECP_N, SECP_P, point_add, point_multiply
from multivm_sql import event_metadata, sql_event_query


def uint(value, bits=256):
    require(type(value) is int or isinstance(value, str) and re.fullmatch(r"0|[1-9][0-9]*", value), "invalid Cosmos integer")
    number = int(value)
    require(0 <= number < 2 ** bits, "Cosmos integer overflow")
    return number


def varint(number):
    number = uint(number, 64)
    result = bytearray()
    while number >= 128:
        result.append((number & 127) | 128)
        number >>= 7
    result.append(number)
    return bytes(result)


def protobuf(raw):
    require(isinstance(raw, bytes) and len(raw) <= 16 * 1024 * 1024, "Cosmos protobuf bound")
    cursor, fields = 0, {}

    def integer():
        nonlocal cursor
        start, result, shift = cursor, 0, 0
        while cursor < len(raw) and shift <= 63:
            byte = raw[cursor]
            cursor += 1
            result |= (byte & 127) << shift
            if byte < 128:
                require(result < 2 ** 64 and raw[start:cursor] == varint(result), "noncanonical Cosmos varint")
                return result
            shift += 7
        raise ValueError("truncated Cosmos varint")

    while cursor < len(raw):
        tag = integer()
        number, wire = tag >> 3, tag & 7
        require(0 < number < 2 ** 29, "invalid Cosmos protobuf field")
        if wire == 0:
            value = integer()
        elif wire == 2:
            size = integer()
            require(cursor + size <= len(raw), "truncated Cosmos protobuf bytes")
            value = raw[cursor:cursor + size]
            cursor += size
        else:
            raise ValueError("unsupported Cosmos protobuf wire type")
        values = fields.setdefault(number, [])
        require(len(values) < 256 and len(fields) <= 64, "Cosmos repeated field bound")
        values.append((wire, value))
    return fields


def field(fields, number, wire, default=None):
    values = fields.get(number, [])
    require(len(values) <= 1, "duplicate Cosmos scalar")
    if not values:
        require(default is not None, "missing Cosmos protobuf field")
        return default
    require(values[0][0] == wire, "wrong Cosmos protobuf wire type")
    return values[0][1]


def encoded(number, value):
    if isinstance(value, bytes):
        return varint((number << 3) | 2) + varint(len(value)) + value
    return varint(number << 3) + varint(value)


def text(value):
    require(isinstance(value, bytes), "expected Cosmos text bytes")
    return value.decode("utf8", errors="strict")


def strict_json(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "duplicate Cosmos JSON field")
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=unique, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("invalid Cosmos JSON number")))


def bech32(value, prefix):
    require(isinstance(value, str) and 8 <= len(value) <= 90 and value == value.lower(), "invalid Cosmos bech32 case/length")
    position = value.rfind("1")
    require(position > 0 and value[:position] == prefix, "wrong Cosmos bech32 prefix")
    alphabet = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
    require(all(char in alphabet for char in value[position + 1:]), "invalid Cosmos bech32 alphabet")
    symbols = [alphabet.index(char) for char in value[position + 1:]]
    require(len(symbols) >= 6, "missing Cosmos bech32 checksum")
    expanded = [ord(c) >> 5 for c in prefix] + [0] + [ord(c) & 31 for c in prefix]
    check = 1
    for number in expanded + symbols:
        high = check >> 25
        check = ((check & 0x1ffffff) << 5) ^ number
        for index, generator in enumerate((0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3)):
            if high & (1 << index):
                check ^= generator
    require(check == 1, "invalid Cosmos bech32 checksum")
    accumulator, bits, output = 0, 0, bytearray()
    for number in symbols[:-6]:
        accumulator = ((accumulator << 5) | number) & 0xffff
        bits += 5
        while bits >= 8:
            bits -= 8
            output.append((accumulator >> bits) & 255)
    require(bits < 5 and (accumulator & ((1 << bits) - 1)) == 0, "noncanonical Cosmos bech32 padding")
    require(0 < len(output) <= 32, "invalid Cosmos address width")
    return bytes(output)


def address(value, prefix):
    if isinstance(value, str) and re.fullmatch(r"(?:0x)?[0-9a-fA-F]{64}", value):
        return "0x" + value.removeprefix("0x").lower()
    return "0x" + bech32(value, prefix).rjust(32, b"\0").hex()


def encode_address(raw, prefix):
    require(isinstance(raw, bytes) and 0 < len(raw) <= 32 and prefix and all(33 <= ord(c) <= 126 for c in prefix) and prefix == prefix.lower(), "invalid Cosmos address input")
    accumulator, bits, values = 0, 0, []
    for byte in raw:
        accumulator = ((accumulator << 8) | byte) & 0xffff
        bits += 8
        while bits >= 5:
            bits -= 5
            values.append((accumulator >> bits) & 31)
    if bits:
        values.append((accumulator << (5 - bits)) & 31)
    expanded = [ord(c) >> 5 for c in prefix] + [0] + [ord(c) & 31 for c in prefix]
    check = 1
    for number in expanded + values + [0] * 6:
        high = check >> 25
        check = ((check & 0x1ffffff) << 5) ^ number
        for index, generator in enumerate((0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3)):
            if high & (1 << index):
                check ^= generator
    check ^= 1
    values += [(check >> (5 * (5 - index))) & 31 for index in range(6)]
    alphabet = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
    result = prefix + "1" + "".join(alphabet[value] for value in values)
    require(bech32(result, prefix) == raw, "Cosmos address encoding mismatch")
    return result


def public_key(raw):
    require(isinstance(raw, bytes) and len(raw) == 33 and raw[0] in (2, 3), "invalid Cosmos public key")
    x = int.from_bytes(raw[1:], "big")
    require(x < SECP_P, "invalid Cosmos public point")
    alpha = (pow(x, 3, SECP_P) + 7) % SECP_P
    y = pow(alpha, (SECP_P + 1) // 4, SECP_P)
    require(y * y % SECP_P == alpha, "Cosmos public point not on curve")
    if (y & 1) != raw[0] - 2:
        y = SECP_P - y
    return x, y


def verify_signature(raw_key, digest, signature):
    require(len(digest) == 32 and len(signature) == 64, "invalid Cosmos signature width")
    r, s = int.from_bytes(signature[:32], "big"), int.from_bytes(signature[32:], "big")
    require(0 < r < SECP_N and 0 < s <= SECP_N // 2, "invalid/high-s Cosmos signature")
    inverse = pow(s, -1, SECP_N)
    point = point_add(point_multiply(int.from_bytes(digest, "big") * inverse % SECP_N, SECP_G), point_multiply(r * inverse % SECP_N, public_key(raw_key)))
    require(point is not None and point[0] % SECP_N == r, "Cosmos SIGN_MODE_DIRECT signature mismatch")


def message(raw, keccak):
    require(isinstance(raw, bytes) and 77 <= len(raw) <= 2 * 1024 * 1024 and raw[0] == 3, "invalid Hyperlane Cosmos message")
    identity = "0x" + hex_bytes(keccak("0x" + raw.hex()), 32).hex()
    return {"id": identity, "wire": "0x" + raw.hex(), "nonce": int.from_bytes(raw[1:5], "big"), "origin": int.from_bytes(raw[5:9], "big"), "sender": "0x" + raw[9:41].hex(), "destination": int.from_bytes(raw[41:45], "big"), "recipient": "0x" + raw[45:77].hex(), "body": "0x" + raw[77:].hex()}


def signed_transaction(raw, *, chain_id, account_number, signer, prefix, mailbox, native, denom, gas_price, keccak):
    """Verify actual TxRaw and SIGN_MODE_DIRECT; return public proof + internal bytes."""
    require(isinstance(chain_id, str) and 0 < len(chain_id) <= 128, "actual Cosmos chain ID missing")
    account_number = uint(account_number, 64)
    outer = protobuf(raw)
    require(set(outer) == {1, 2, 3}, "unexpected Cosmos TxRaw fields")
    body, auth, signature = (field(outer, n, 2) for n in (1, 2, 3))
    body_fields = protobuf(body)
    require(set(body_fields) <= {1, 2, 3}, "unsupported Cosmos TxBody extensions")
    require(field(body_fields, 2, 2, b"") == b"", "unexpected Cosmos memo")
    timeout = uint(field(body_fields, 3, 0, 0), 64)
    require(timeout > 0, "missing Cosmos timeout height")
    any_fields = protobuf(field(body_fields, 1, 2))
    require(set(any_fields) == {1, 2}, "invalid Cosmos process Any")
    type_url = text(field(any_fields, 1, 2))
    process = protobuf(field(any_fields, 2, 2))
    if native:
        require(type_url == "/hyperlane.core.v1.MsgProcessMessage" and set(process) <= {1, 2, 3, 4} and {1, 2, 4} <= process.keys(), "not a native Cosmos process")
        target = address(text(field(process, 1, 2)), prefix)
        sender = text(field(process, 2, 2))
        metadata = bytes.fromhex(text(field(process, 3, 2, b"")).removeprefix("0x"))
        packed = bytes.fromhex(text(field(process, 4, 2)).removeprefix("0x"))
    else:
        require(type_url == "/cosmwasm.wasm.v1.MsgExecuteContract" and set(process) <= {1, 2, 3} and {1, 2, 3} <= process.keys(), "not an unfunded CosmWasm process")
        sender = text(field(process, 1, 2))
        target = address(text(field(process, 2, 2)), prefix)
        content = strict_json(field(process, 3, 2))
        require(isinstance(content, dict) and set(content) == {"process"} and isinstance(content["process"], dict) and set(content["process"]) == {"message", "metadata"}, "not a canonical CosmWasm process payload")
        metadata = bytes.fromhex(content["process"]["metadata"].removeprefix("0x"))
        packed = bytes.fromhex(content["process"]["message"].removeprefix("0x"))
    require(target == address(mailbox, prefix) and address(sender, prefix) == address(signer, prefix), "Cosmos process target/sender authority mismatch")
    parsed_message = message(packed, keccak)
    info = protobuf(auth)
    require(set(info) == {1, 2}, "unsupported Cosmos AuthInfo")
    signer_info = protobuf(field(info, 1, 2))
    require(set(signer_info) <= {1, 2, 3} and {1, 2} <= signer_info.keys(), "invalid Cosmos SignerInfo")
    public_any = protobuf(field(signer_info, 1, 2))
    require(set(public_any) == {1, 2} and text(field(public_any, 1, 2)) == "/cosmos.crypto.secp256k1.PubKey", "unsupported Cosmos signer public key type")
    key_fields = protobuf(field(public_any, 2, 2))
    require(set(key_fields) == {1}, "invalid Cosmos public key schema")
    key = field(key_fields, 1, 2)
    public_key(key)
    derived = hashlib.new("ripemd160", hashlib.sha256(key).digest()).digest()
    require(bech32(signer, prefix) == derived, "Cosmos signer public key/address mismatch")
    mode = protobuf(field(signer_info, 2, 2))
    require(set(mode) == {1}, "Cosmos multisig/unknown signing mode")
    single = protobuf(field(mode, 1, 2))
    require(set(single) == {1} and field(single, 1, 0) == 1, "Cosmos signature is not SIGN_MODE_DIRECT")
    sequence = uint(field(signer_info, 3, 0, 0), 64)
    fee = protobuf(field(info, 2, 2))
    require(set(fee) <= {1, 2, 3, 4} and field(fee, 3, 2, b"") == b"" and field(fee, 4, 2, b"") == b"", "unexpected Cosmos fee payer/granter")
    coin = protobuf(field(fee, 1, 2))
    require(set(coin) == {1, 2} and text(field(coin, 1, 2)) == denom, "wrong Cosmos signed fee denomination")
    gas_limit = uint(field(fee, 2, 0), 64)
    price = Fraction(gas_price)
    require(price >= 0, "negative Cosmos gas price")
    expected_fee = (gas_limit * price.numerator + price.denominator - 1) // price.denominator
    paid = uint(text(field(coin, 2, 2)), 128)
    require(paid == expected_fee, "Cosmos signed fee differs from configured exact ceiling")
    # Proto3 omits a zero scalar; the actual stored sign document must bind the
    # observed chain and independently fetched account, including account zero.
    doc = encoded(1, body) + encoded(2, auth) + encoded(3, chain_id.encode())
    if account_number:
        doc += encoded(4, account_number)
    verify_signature(key, hashlib.sha256(doc).digest(), signature)
    proof = {"identity": "0x" + hashlib.sha256(raw).hexdigest(), "signed": {"bytes": len(raw), "sha256": "0x" + hashlib.sha256(raw).hexdigest()}, "public_key": "0x" + key.hex(), "signer": signer, "mailbox": target, "chain_id": chain_id, "account_number": account_number, "sequence": sequence, "gas_limit": gas_limit, "fee": paid, "denom": denom, "timeout_height": timeout, "message": parsed_message, "metadata_sha256": "0x" + hashlib.sha256(metadata).hexdigest(), "direct_signature_verified": True}
    return proof, {"body": body, "auth": auth, "sign_doc": doc}


def event(value, *, native, compat, prefix, denom, contracts, keccak):
    require(isinstance(value, dict), "invalid Cosmos event")
    kinds = {"hyperlane.core.v1.EventDispatch": "dispatch", "hyperlane.core.v1.EventProcess": "delivery", "hyperlane.core.post_dispatch.v1.EventInsertedIntoTree": "insertion", "hyperlane.core.post_dispatch.v1.EventGasPayment": "payment"} if native else {"wasm-mailbox_dispatch": "dispatch", "wasm-mailbox_process_id": "delivery", "wasm-hpl_hook_merkle::post_dispatch": "insertion", "wasm-igp-core-pay-for-gas": "payment"}
    kind = kinds.get(value.get("type"))
    if kind is None:
        return None
    attrs = value.get("attributes")
    require(isinstance(attrs, list) and len(attrs) <= 256, "invalid Cosmos attributes")
    expected_keys = {"message", "message_id", "index", "payment", "gas_amount", "destination", "dest_domain", "_contract_address", "origin_mailbox_id", "merkle_tree_hook_id", "igp_id"}
    attributes = {}
    for entry in attrs:
        require(isinstance(entry, dict) and isinstance(entry.get("key"), str) and isinstance(entry.get("value"), str), "invalid Cosmos attribute")
        key, value = entry["key"], entry["value"]
        if compat == "0.34" or key not in expected_keys:
            try:
                decoded = base64.b64decode(key, validate=True).decode("utf8")
            except (ValueError, UnicodeError):
                continue
            if decoded not in expected_keys:
                continue
            key, value = decoded, base64.b64decode(value, validate=True).decode("utf8")
        require(key not in attributes, "duplicate Cosmos event authority")
        if native and value.startswith('"'):
            value = strict_json(value)
        require(isinstance(value, str), "invalid Cosmos attribute text")
        attributes[key] = value
    contract_key = "_contract_address" if not native else "origin_mailbox_id" if kind in {"dispatch", "delivery"} else "merkle_tree_hook_id" if kind == "insertion" else "igp_id"
    require(contract_key in attributes, "missing Cosmos event emitter")
    emitter = address(attributes[contract_key], prefix)
    expected = contracts["mailbox" if kind in {"dispatch", "delivery"} else "merkletreehook" if kind == "insertion" else "interchaingaspaymaster"]
    if emitter != address(expected, prefix):
        return None
    result = {"kind": kind, "emitter": emitter}
    if kind == "dispatch":
        result["message"] = message(bytes.fromhex(attributes["message"].removeprefix("0x")), keccak)
    else:
        result["id"] = "0x" + hex_bytes("0x" + attributes["message_id"].removeprefix("0x"), 32).hex()
        if kind == "insertion":
            result["index"] = uint(attributes["index"], 32)
        elif kind == "payment":
            amount = attributes["payment"]
            if native:
                match = re.fullmatch(r"(0|[1-9][0-9]*)([^0-9].*)", amount)
                require(match is not None and match[2] == denom, "wrong Cosmos IGP payment denomination")
                amount = match[1]
            result.update(payment=uint(amount), gas_amount=uint(attributes["gas_amount"]), destination=uint(attributes["destination" if native else "dest_domain"], 32))
    return result


class Adapter:
    payments_supported = True

    def __init__(self, manifest, case):
        self.manifest, self.case = manifest, case
        self.native = manifest["scenario"] == "cosmosnative"
        self.broadcast_wire = {}
        self.last_snapshot = None

    def validate_case(self):
        expected = 8 if self.native else 4
        require(self.manifest["scenario"] in {"cosmosnative", "cosmwasm"} and self.case.get("scenario") == self.manifest["scenario"] and self.case.get("schema") == 1, "wrong Cosmos family case")
        require(isinstance(self.case.get("chain_names"), list) and len(set(self.case["chain_names"])) == 2, "Source Cosmos requires exactly two chains")
        require(set(self.case.get("relayer_addresses", {})) == set(self.case["chain_names"]) and set(self.case.get("validator_addresses", {})) == set(self.case["chain_names"]), "Cosmos expected public signer coverage missing")
        corpus = self.case.get("initial_corpus", {})
        require(corpus == {"dispatches": expected, "deliveries": expected, "failed_body": 0, "zero_insertions": 0, "double_insertions": 0}, "case differs from original Cosmos Source workload")
        require(self.case.get("payments_supported") is True, "Source Cosmos IGP coverage cannot be disabled")

    def transport(self, name):
        require(name in {"rpcurls", "customrpcurls", "grpcurls", "customgrpcurls"}, "unsupported Cosmos transport field")
        return "tcp" if "grpc" in name else "http-json"

    @staticmethod
    def configured_chain(chain):
        # This is an independent view of parser defaults, never a configuration
        # replacement sent to an actual role or node.
        return dict(chain, canonicalasset=chain.get("canonicalasset", "u" + chain["bech32prefix"]))

    def chains(self, session):
        captures = [row["original"] for row in session.captures if row["original"]["role"] == "relayer"]
        require(captures, "actual Cosmos relayer capture missing")
        # Apply documented parser defaults only inside the independent verifier;
        # original/proxied runtime configuration is never changed here.
        chains = {name: self.configured_chain(chain) for name, chain in captures[-1]["chains"].items()}
        require(set(chains) == set(self.case["chain_names"]), "actual Cosmos chain coverage differs")
        domains = {str(uint(chain["domainid"], 32)): name for name, chain in chains.items()}
        require(domains == self.case["domain_names"], "actual Cosmos domains differ from reviewed Source case")
        for name, chain in chains.items():
            require(chain["protocol"] == ("cosmosnative" if self.native else "cosmos") and chain.get("chainid") and chain.get("bech32prefix") and chain.get("canonicalasset"), "missing actual Cosmos identity/fee configuration")
            require(len(bech32(self.case["relayer_addresses"][name], chain["bech32prefix"])) == 20, "Cosmos expected signer width differs")
        return chains

    def events(self, chain, values, session):
        require(isinstance(values, list), "actual Cosmos events missing")
        result = []
        for index, value in enumerate(values):
            parsed = event(value, native=self.native, compat=str(chain.get("compatmode", "0.37")), prefix=chain["bech32prefix"], denom=chain["canonicalasset"], contracts=chain, keccak=session.keccak)
            if parsed is not None:
                result.append(dict(parsed, event_index=index))
        return result

    def delivered_query(self, chain, path, request_bytes, response_bytes):
        """Decode the concrete runtime query; unrelated smart queries earn nothing."""
        if path == "/hyperlane.core.v1.Query/Delivered" and self.native:
            fields = protobuf(request_bytes)
            require(address(text(field(fields, 1, 2)), chain["bech32prefix"]) == address(chain["mailbox"], chain["bech32prefix"]), "native delivered query mailbox differs")
            identity = "0x" + hex_bytes("0x" + text(field(fields, 2, 2)).removeprefix("0x"), 32).hex()
            delivered = field(protobuf(response_bytes), 1, 0, 0)
            require(delivered in (0, 1), "invalid native Cosmos delivered boolean")
            return identity if delivered == 1 else None
        if path == "/cosmwasm.wasm.v1.Query/SmartContractState" and not self.native:
            fields = protobuf(request_bytes)
            content = strict_json(field(fields, 2, 2))
            mailbox_query = content.get("mailbox", {}) if isinstance(content, dict) else {}
            delivered_query = mailbox_query.get("message_delivered") if isinstance(mailbox_query, dict) else None
            if not isinstance(delivered_query, dict) or "id" not in delivered_query:
                return None
            require(address(text(field(fields, 1, 2)), chain["bech32prefix"]) == address(chain["mailbox"], chain["bech32prefix"]), "wasm delivered query mailbox differs")
            identity = "0x" + hex_bytes("0x" + delivered_query["id"].removeprefix("0x"), 32).hex()
            reply = strict_json(field(protobuf(response_bytes), 1, 2))
            require(isinstance(reply, dict) and type(reply.get("delivered")) is bool, "invalid CosmWasm delivered boolean")
            return identity if reply["delivered"] else None
        return None

    def observe_effects(self, session, observed, chain, method, height, effects, transaction=None, **reference):
        if not isinstance(effects, dict) or uint(height, 64) == 0 or uint(effects.get("code", 0), 32) != 0:
            return
        identity = "0x" + hex_bytes("0x" + transaction.removeprefix("0x"), 32).hex() if transaction is not None else "0x" + "00" * 32
        for value in self.events(chain, effects.get("events", []), session):
            if value["kind"] == "delivery":
                session.record_inclusion(observed["chain"], value["id"], identity, observed["received_monotonic_ns"], {"api": method, "height": uint(height, 64), "event_index": value["event_index"], **reference})

    def observe(self, session, observed):
        request, response = observed["request"], observed["response"]
        if not isinstance(request, dict) or not isinstance(response, dict):
            return
        # Validators may query before the relayer is spawned. Capture is bound
        # before any child's first request, so use that actual role's chain.
        chain = self.configured_chain(session.chain_config(observed["chain"]))
        method, params, result = request.get("method"), request.get("params", {}), response.get("result")
        if observed.get("wire_protocol") == "grpc-h2":
            require(observed["status"] == 200 and response.get("trailers", {}).get("grpc-status", response.get("headers", {}).get("grpc-status")) == "0", "unsuccessful observed Cosmos gRPC")
            response_headers = response.get("headers", {})
            trailers = response.get("trailers", {})
            require(not ("x-cosmos-block-height" in response_headers and "x-cosmos-block-height" in trailers), "duplicate observed Cosmos gRPC height")
            height = trailers.get("x-cosmos-block-height", response_headers.get("x-cosmos-block-height"))
            requested_height = request.get("headers", {}).get("x-cosmos-block-height")
            if requested_height is not None:
                require(height is not None and uint(height, 64) == uint(requested_height, 64), "observed Cosmos gRPC height mismatch")
            if height is not None:
                require(uint(height, 64) > 0, "observed Cosmos gRPC height is zero")
            identity = self.delivered_query(chain, method, hex_bytes(request["protobuf"]), hex_bytes(response["protobuf"]))
            if identity is not None:
                session.record_inclusion(observed["chain"], identity, "0x" + "00" * 32, observed["received_monotonic_ns"], {"api": method, "transport": "grpc-h2", "height": uint(height, 64) if height is not None else None, "response_protobuf_sha256": hashlib.sha256(hex_bytes(response["protobuf"])).hexdigest()})
            return
        if method == "broadcast_tx_commit" and observed["role"] == "relayer":
            require(isinstance(params, dict) and isinstance(params.get("tx"), str), "actual Cosmos broadcast wire missing")
            raw = base64.b64decode(params["tx"], validate=True)
            identity = "0x" + hashlib.sha256(raw).hexdigest()
            previous = self.broadcast_wire.setdefault((observed["chain"], identity), raw)
            require(previous == raw, "Cosmos transaction hash collision")
            session.record_broadcast(observed["chain"], identity, hashlib.sha256(raw).hexdigest())
        if not isinstance(result, dict):
            return
        transaction = None
        effects = None
        if method == "broadcast_tx_commit":
            check = result.get("check_tx", {})
            effects = result.get("tx_result", result.get("deliver_tx"))
            if uint(check.get("code", 0), 32) != 0:
                return
            transaction = result.get("hash")
        elif method == "tx":
            effects, transaction = result.get("tx_result"), result.get("hash")
        elif method == "tx_search":
            for row in result.get("txs") or []:
                self.observe_effects(session, observed, chain, method, row.get("height", 0), row.get("tx_result"), row.get("hash"))
            return
        elif method == "block_results":
            for index, effects in enumerate(result.get("txs_results") or []):
                self.observe_effects(session, observed, chain, method, result.get("height", 0), effects, transaction_index=index)
            return
        elif method == "abci_query" and isinstance(params, dict):
            query = result.get("response")
            if not isinstance(query, dict) or uint(query.get("code", 0), 32) != 0:
                return
            path = params.get("path")
            identity = self.delivered_query(chain, path, bytes.fromhex(params.get("data", "").removeprefix("0x")), base64.b64decode(query.get("value", ""), validate=True))
            if identity is not None:
                require(uint(query["height"], 64) > 0, "observed Cosmos ABCI height is zero")
                session.record_inclusion(observed["chain"], identity, "0x" + "00" * 32, observed["received_monotonic_ns"], {"api": path, "height": uint(query["height"], 64)})
            return
        if transaction is not None:
            self.observe_effects(session, observed, chain, method, result.get("height", 0), effects, transaction)

    def canonical_transaction(self, session, name, chain, transaction):
        identity = "0x" + hex_bytes("0x" + transaction["hash"].removeprefix("0x"), 32).hex()
        raw = base64.b64decode(transaction["tx"], validate=True)
        require(hashlib.sha256(raw).hexdigest() == identity[2:], "Cosmos native transaction identity differs")
        height, index = uint(transaction["height"], 64), uint(transaction["index"], 32)
        require(height > 0, "Cosmos receipt is not included")
        block = session.rpc(name, "block", {"height": str(height)})
        header = block["block"]["header"]
        require(header["chain_id"] == str(chain["chainid"]) and uint(header["height"], 64) == height, "Cosmos canonical header chain/height differs")
        transactions = block["block"]["data"]["txs"] or []
        require(index < len(transactions) and base64.b64decode(transactions[index], validate=True) == raw, "Cosmos tx index/bytes not in canonical block")
        block_hash = "0x" + hex_bytes("0x" + block["block_id"]["hash"].removeprefix("0x"), 32).hex()
        results = session.rpc(name, "block_results", {"height": str(height)})
        require(uint(results["height"], 64) == height and isinstance(results.get("txs_results"), list) and len(results["txs_results"]) == len(transactions), "Cosmos block result membership differs")
        actual = results["txs_results"][index]
        reported = transaction["tx_result"]
        require(uint(actual.get("code", 0), 32) == uint(reported.get("code", 0), 32) == 0, "Cosmos transaction failed or receipt result differs")
        require(uint(actual["gas_used"], 64) == uint(reported["gas_used"], 64), "Cosmos canonical gas result differs")
        require(self.events(chain, actual.get("events", []), session) == self.events(chain, reported.get("events", []), session), "Cosmos indexed events differ from canonical block result")
        status = session.rpc(name, "status", {})
        require(status["node_info"]["network"] == str(chain["chainid"]) and status["sync_info"]["catching_up"] is False, "Cosmos node identity/readiness differs")
        confirmations = uint(chain.get("blocks", {}).get("confirmations", 1), 32)
        require(uint(status["sync_info"]["latest_block_height"], 64) >= height + confirmations, "Cosmos transaction not actually finalized")
        again = session.rpc(name, "block", {"height": str(height)})
        require(again["block_id"]["hash"] == block["block_id"]["hash"], "Cosmos canonical block changed during proof")
        return {"identity": identity, "block_hash": block_hash, "height": height, "index": index, "gas_used": uint(actual["gas_used"], 64), "events": self.events(chain, actual.get("events", []), session), "signed": {"bytes": len(raw), "sha256": "0x" + hashlib.sha256(raw).hexdigest()}}, raw

    def collect(self, session, expected, phase):
        self.validate_case()
        require(phase in {"initial", "after_restart", "after_source_reorg", "final"} and expected == self.case["initial_corpus"]["deliveries"], "Cosmos stage/workload differs")
        chains = self.chains(session)
        messages, insertions, payments, deliveries, transaction_proofs, metadata = {}, {}, {}, {}, {}, {}
        for name, chain in chains.items():
            total, seen, page = None, 0, 1
            while total is None or seen < total:
                response = session.rpc(name, "tx_search", {"query": "tx.height > 0", "prove": False, "page": str(page), "per_page": "100", "order_by": "asc"})
                count = uint(response["total_count"], 32)
                require(count <= 10000 and (total is None or total == count), "Cosmos transaction search changed or exceeds fixture bound")
                total = count
                rows = response.get("txs") or []
                require(isinstance(rows, list) and len(rows) <= 100 and (rows or seen == total), "Cosmos transaction page missing")
                for row in rows:
                    values = self.events(chain, row.get("tx_result", {}).get("events", []), session)
                    if not values:
                        continue
                    proof, _ = self.canonical_transaction(session, name, chain, row)
                    transaction_proofs[(name, proof["identity"])] = proof
                    for value in values:
                        message_id = value["message"]["id"] if value["kind"] == "dispatch" else value["id"]
                        metadata.setdefault(message_id, {}).setdefault(value["kind"], []).append(event_metadata(name, chain["domainid"], proof, value))
                        if value["kind"] == "dispatch":
                            msg = value["message"]
                            require(msg["id"] not in messages and msg["origin"] == uint(chain["domainid"], 32), "duplicate/wrong-origin Cosmos dispatch")
                            messages[msg["id"]] = dict(msg, origin_chain=name, dispatch_transaction=proof["identity"], dispatch_block=proof["height"], dispatch_log_index=value["event_index"])
                        elif value["kind"] == "insertion":
                            insertions.setdefault(value["id"], []).append(value["index"])
                        elif value["kind"] == "payment":
                            payments.setdefault(value["id"], []).append({key: value[key] for key in ("gas_amount", "payment", "destination")})
                        else:
                            require(value["id"] not in deliveries, "duplicate Cosmos delivery event")
                            require((name, proof["identity"]) in session.self_transactions and (name, proof["identity"]) in self.broadcast_wire, "Cosmos delivery is not an actual self-submitted transaction")
                            deliveries[value["id"]] = (name, proof["identity"])
                            # A delivered-state query or block_results can be
                            # the first positive. Bind its zero-ID placeholder
                            # to this independently authenticated signed tx;
                            # Lifecycle retains the earlier observer timestamp.
                            session.record_inclusion(name, value["id"], proof["identity"], time.monotonic_ns(), {"api": "canonical_transaction", "height": proof["height"], "block_hash": proof["block_hash"], "transaction_index": proof["index"]})
                seen += len(rows)
                require(seen <= total, "Cosmos duplicate page count")
                page += 1
        require(len(messages) == expected and set(deliveries) == set(messages) and set(insertions) == set(messages) and set(payments) == set(messages), "actual Cosmos dispatch/delivery/insertion/IGP coverage differs")
        domains = {uint(chain["domainid"], 32): name for name, chain in chains.items()}
        for identity, msg in messages.items():
            delivery_chain, transaction = deliveries[identity]
            require(domains[msg["destination"]] == delivery_chain and len(insertions[identity]) == 1 and len(payments[identity]) == 1 and payments[identity][0]["destination"] == msg["destination"] and payments[identity][0]["payment"] > 0, "Cosmos delivery/payment destination or Source multiplicity differs")
            require(self.delivered(session, delivery_chain, chains[delivery_chain], identity), "actual Cosmos native delivered state is false")
            require(set(metadata[identity]) == {"dispatch", "insertion", "payment", "delivery"} and all(len(rows) == 1 for rows in metadata[identity].values()), "Cosmos event metadata multiplicity differs")
            msg.update(insertions=insertions[identity], payments=payments[identity], delivery_chain=delivery_chain, delivery_transaction=transaction, native_event_metadata=metadata[identity])
        for name in chains:
            nonces = sorted(msg["nonce"] for msg in messages.values() if msg["origin_chain"] == name)
            require(nonces == list(range(expected // 2)), "Cosmos canonical dispatch nonce stream differs")
        relevant = []
        for key in sorted(set(deliveries.values())):
            proof = transaction_proofs[key]
            proof["message_ids"] = [value["id"] for value in proof["events"] if value["kind"] == "delivery"]
            require(set(proof["message_ids"]) == {identity for identity, value in deliveries.items() if value == key}, "Cosmos transaction shared member set differs")
            relevant.append({"chain": key[0], "transaction_hash": key[1], "proof": proof})
        self.last_snapshot = {"messages": list(messages.values()), "deliverable_messages": list(messages.values()), "native_delivery_transactions": relevant, "payments_supported": True}
        return self.last_snapshot

    def query(self, session, name, path, request):
        reply = session.rpc(name, "abci_query", {"path": path, "data": request.hex().upper(), "prove": False})["response"]
        require(uint(reply.get("code", 0), 32) == 0 and uint(reply["height"], 64) > 0, "Cosmos ABCI query failed or unbound height")
        return base64.b64decode(reply["value"], validate=True)

    def delivered(self, session, name, chain, identity):
        if self.native:
            request = encoded(1, address(chain["mailbox"], chain["bech32prefix"])[2:].encode()) + encoded(2, hex_bytes(identity, 32).hex().encode())
            result = field(protobuf(self.query(session, name, "/hyperlane.core.v1.Query/Delivered", request)), 1, 0, 0)
            require(result in (0, 1), "invalid Cosmos delivered state")
            return bool(result)
        contract = encode_address(hex_bytes(address(chain["mailbox"], chain["bech32prefix"]), 32)[-uint(chain["contractaddressbytes"], 8):], chain["bech32prefix"])
        query = json.dumps({"mailbox": {"message_delivered": {"id": hex_bytes(identity, 32).hex()}}}, separators=(",", ":")).encode()
        raw = self.query(session, name, "/cosmwasm.wasm.v1.Query/SmartContractState", encoded(1, contract.encode()) + encoded(2, query))
        result = strict_json(field(protobuf(raw), 1, 2))
        require(isinstance(result, dict) and type(result.get("delivered")) is bool, "invalid CosmWasm delivered state")
        return result["delivered"]

    def account(self, session, name, signer):
        raw = self.query(session, name, "/cosmos.auth.v1beta1.Query/Account", encoded(1, signer.encode()))
        any_fields = protobuf(field(protobuf(raw), 1, 2))
        require(text(field(any_fields, 1, 2)) == "/cosmos.auth.v1beta1.BaseAccount", "unexpected Source Cosmos account type")
        value = protobuf(field(any_fields, 2, 2))
        require(text(field(value, 1, 2)) == signer, "actual Cosmos account address differs")
        return uint(field(value, 3, 0, 0), 64)

    def native_rows(self, session, snapshot, rows, baseline):
        chains = self.chains(session)
        by_id = {value["id"]: value for value in snapshot["deliverable_messages"]}
        require(len(rows) == len(by_id) and {row["id"] for row in rows} == set(by_id), "native Cosmos row coverage differs")
        receipts = {(value["chain"], value["transaction_hash"]): value["proof"] for value in snapshot["native_delivery_transactions"]}
        output = []
        for row in rows:
            msg, operation = by_id[row["id"]], row["operation"]
            origin, destination = msg["origin_chain"], msg["delivery_chain"]
            chain, identity = chains[destination], msg["delivery_transaction"]
            raw = self.broadcast_wire[(destination, identity)]
            signer = self.case["relayer_addresses"][destination]
            account_number = self.account(session, destination, signer)
            proof, parts = signed_transaction(raw, chain_id=str(chain["chainid"]), account_number=account_number, signer=signer, prefix=chain["bech32prefix"], mailbox=chain["mailbox"], native=self.native, denom=chain["canonicalasset"], gas_price=chain["gasprice"]["amount"], keccak=session.keccak)
            require(proof["identity"] == identity and proof["message"]["wire"] == msg["wire"] and operation.get("identity") == {"kind": "hash256", "hex": identity} and operation.get("signed") == proof["signed"], "actual Cosmos signed wire differs from retained native operation")
            require(operation.get("nonce") == msg["nonce"] and operation.get("origin") == msg["origin"] and operation.get("destination") == msg["destination"] and uint(operation["generation"], 64) > 0, "Cosmos row message/replay identity differs")
            authority = {"protocol": "cosmosnative" if self.native else "cosmos", "origin": msg["origin"], "destination": msg["destination"], "mailbox": address(chain["mailbox"], chain["bech32prefix"]), "chain_id": str(chain["chainid"]), "origin_hook": address(chains[origin]["merkletreehook"], chains[origin]["bech32prefix"]), "operation_id": msg["id"], "generation": operation["generation"], "kind": "process", "target": None}
            require(operation.get("authority") == authority and operation.get("kind") == "process" and operation.get("target") is None, "actual Cosmos Prepared configuration authority differs")
            limits = self.case.get("native_limits", {}).get(destination)
            require(isinstance(limits, dict) and set(limits) == {"maximum_fee", "maximum_gas"}, "reviewed Source Cosmos cap provenance missing")
            maximum_fee, maximum_gas = uint(limits["maximum_fee"], 128), uint(limits["maximum_gas"], 64)
            require(proof["fee"] <= maximum_fee and proof["gas_limit"] <= maximum_gas, "Cosmos signed fee/gas exceeds actual cap")
            payload = {"body": "0x" + parts["body"].hex(), "auth": "0x" + parts["auth"].hex(), "sign_doc": "0x" + parts["sign_doc"].hex(), "account_number": account_number, "sequence": proof["sequence"], "gas_limit": proof["gas_limit"], "fee": proof["fee"], "public_key": proof["public_key"], "maximum_fee": maximum_fee, "maximum_gas": maximum_gas}
            intent = json.dumps({"version": 1, "authority": authority, "payload": payload}, separators=(",", ":"), ensure_ascii=False).encode()
            require(operation.get("stored_canonical_intent") == {"bytes": len(intent), "sha256": "0x" + hashlib.sha256(intent).hexdigest()}, "Cosmos retained canonical intent differs from independently reconstructed signed/replay/fee fields")
            receipt = receipts[(destination, identity)]
            require(receipt["message_ids"] == [msg["id"]], "Source Cosmos process unexpectedly shares native transaction")
            price = Fraction(chain["gasprice"]["amount"])
            gas = receipt["gas_used"]
            # Rust TxOutcome charges configured price times actual gas. This
            # differs from the signed upfront fee ceiling; preserve both facts.
            tokens = gas * price.numerator // price.denominator
            expenditure = operation.get("expenditure")
            require(isinstance(expenditure, dict) and expenditure.get("present") is True and uint(int(expenditure["gas_used_hex"], 16)) == gas and uint(int(expenditure["tokens_used_hex"], 16)) == tokens, "Cosmos native expenditure differs from canonical actual-gas/configured-price accounting")
            require(operation.get("stage") == "delivered" and operation.get("confirmation_started") is True, "Cosmos operation did not durably finish actual confirmation")
            output.append({"id": msg["id"], "native_identity": identity, "independently_verified_signature": True, "signer": signer, "sequence": proof["sequence"], "account_number": account_number, "configured_price_expenditure": {"gas_used": gas, "tokens_used": tokens}, "signed_upfront_fee": proof["fee"], "retained_intent_fingerprint_verified": True})
        return output

    def sql(self, session, snapshot):
        from multivm_evm import sql_delivery_query, sql_message_query, verify_sql_message
        domains = {uint(chain["domainid"], 32): name for name, chain in self.chains(session).items()}
        output = []
        for msg in snapshot["messages"]:
            verified = verify_sql_message(session.query_sql(msg["origin_chain"], sql_message_query(msg)), session.query_sql(domains[msg["destination"]], sql_delivery_query(msg, msg["delivery_transaction"])), msg, delivered=True)
            metadata = msg["native_event_metadata"]
            require(set(metadata) == {"dispatch", "insertion", "payment", "delivery"} and all(len(rows) == 1 for rows in metadata.values()), "Cosmos exact SQL metadata missing")
            for kind, rows in metadata.items():
                row = rows[0]
                require(session.query_sql(row["chain"], sql_event_query(kind, msg["id"], row)) == "1", "Cosmos SQL native event position/block/emitter differs")
            output.append({"id": msg["id"], "verified": verified, "canonical_event_coordinates": metadata})
        return output

    def checkpoints(self, session, snapshot):
        from multivm_evidence import urls
        from multivm_evm import verify_checkpoint_objects
        result = []
        chains = self.chains(session)
        for capture in session.captures:
            original, proxied = capture["original"], capture["proxied"]
            if original["role"] != "validator":
                continue
            require(len(original["role_chain_names"]) == 1, "Cosmos validator origin differs")
            name = original["role_chain_names"][0]
            syncer = original["checkpoint_syncer"]
            require(syncer.get("type") == "localStorage", "Source Cosmos actual checkpoint storage differs")
            relative = pathlib.Path(syncer["path"]).relative_to(self.manifest["task_root"])
            directory = session.owned_path(relative)
            configured_rpc = []
            for base, custom in (("rpcurls", "customrpcurls"), ("grpcurls", "customgrpcurls")):
                chain = proxied["chains"][name]
                if base in chain or custom in chain:
                    configured_rpc.extend(urls(chain[custom] if custom in chain else chain[base]))
            proof = verify_checkpoint_objects(directory, chains[name], self.case["validator_addresses"][name], [msg for msg in snapshot["messages"] if msg["origin_chain"] == name], session.keccak, git_sha=self.manifest["runtime_source_commit"], configured_rpc_urls=configured_rpc, allows_public_rpcs=original["allows_public_rpcs"], hook_hash=address(chains[name]["merkletreehook"], chains[name]["bech32prefix"]))
            proof["published_bytes"] = [{"path": str(path), "bytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for path in directory.glob("*_with_id.json")]
            result.append(proof)
        require(result, "actual Cosmos validator publications missing")
        return result

    def readiness(self, session, before_captures, after_captures):
        require(before_captures and after_captures, "actual Cosmos restart captures missing")
        chains = self.chains(session)
        heads = {}
        for name, chain in chains.items():
            status = session.rpc(name, "status", {})
            require(status["node_info"]["network"] == str(chain["chainid"]) and status["sync_info"]["catching_up"] is False, "restarted Cosmos role sees wrong/unready native chain")
            heads[name] = uint(status["sync_info"]["latest_block_height"], 64)
            require(heads[name] > 0, "restarted Cosmos node has no canonical height")
        require(self.last_snapshot is not None, "Cosmos initial evidence missing at restart")
        publications = self.checkpoints(session, self.last_snapshot)
        return {"actual_native_heads": heads, "actual_validator_publications": publications, "shared_parent_pid_config_admin_and_no_resubmission_checks_required": True}
