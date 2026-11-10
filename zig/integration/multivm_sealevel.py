"""Actual finalized Sealevel account/wire evidence. Importing performs no I/O.

These public codecs are independent of the production Zig implementation. Real
scenario admission still requires the shared reviewed build/capacity/session.
"""
from __future__ import annotations

import base64
import hashlib
import json
import pathlib

import multivm_diagnostics

from multivm_evidence import hex_bytes, require, urls
from multivm_evm import sql_delivery_query, verify_checkpoint_objects
from multivm_sql import event_metadata, sql_event_query

ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
P = 2 ** 255 - 19
L = 2 ** 252 + 27742317777372353535851937790883648493
D = -121665 * pow(121666, -1, P) % P
IDENTITY = (0, 1, 1, 0)


def b58encode(raw):
    number, output = int.from_bytes(raw, "big"), ""
    while number:
        number, digit = divmod(number, 58)
        output = ALPHABET[digit] + output
    return "1" * (len(raw) - len(raw.lstrip(b"\0"))) + output


def b58decode(text, size=None):
    require(isinstance(text, str) and (size is None or text) and len(text) <= 1700 and all(c in ALPHABET for c in text), "invalid native base58")
    number = 0
    for char in text:
        number = number * 58 + ALPHABET.index(char)
    raw = bytes(len(text) - len(text.lstrip("1"))) + number.to_bytes((number.bit_length() + 7) // 8, "big")
    require(b58encode(raw) == text and (size is None or len(raw) == size), "noncanonical/wrong-width native base58")
    return raw


def key(value):
    return hex_bytes(value, 32) if value.startswith("0x") else b58decode(value, 32)


def h(raw):
    return "0x" + raw.hex()


def sequence_metadata(chain, domain, identity, proof, sequence, emitter):
    # Source advanced LogMeta uses account stream sequence, never instruction
    # offsets; native instruction relevance authenticates the transaction only.
    return event_metadata(chain, domain, {"identity": identity, "block_hash": proof["block_hash"], "height": proof["slot"], "index": proof["transaction_index"]}, {"event_index": sequence, "emitter": h(emitter)})


def _point(raw):
    require(len(raw) == 32, "invalid Ed25519 point width")
    packed = int.from_bytes(raw, "little")
    y, sign = packed & (2 ** 255 - 1), packed >> 255
    require(y < P, "noncanonical Ed25519 point")
    square = (y * y - 1) * pow(D * y * y + 1, -1, P) % P
    x = pow(square, (P + 3) // 8, P)
    if x * x % P != square:
        x = x * pow(2, (P - 1) // 4, P) % P
    require(x * x % P == square and not (x == 0 and sign), "invalid Ed25519 point")
    if x & 1 != sign:
        x = P - x
    return x, y, 1, x * y % P


def _add(a, b):
    x, y, z, t = a
    u, v, w, s = b
    aa, bb, cc, dd = (y - x) * (v - u) % P, (y + x) * (v + u) % P, 2 * D * t * s % P, 2 * z * w % P
    ee, ff, gg, hh = bb - aa, dd - cc, dd + cc, bb + aa
    return ee * ff % P, gg * hh % P, ff * gg % P, ee * hh % P


def _mul(n, point):
    result = IDENTITY
    while n:
        if n & 1:
            result = _add(result, point)
        point = _add(point, point)
        n >>= 1
    return result


def _equal(a, b):
    return (a[0] * b[2] - b[0] * a[2]) % P == 0 and (a[1] * b[2] - b[1] * a[2]) % P == 0


BASE = _point(bytes.fromhex("58" + "66" * 31))


def verify_ed25519(public, message, signature):
    require(len(public) == 32 and len(signature) == 64, "Ed25519 key/signature width differs")
    a, r = _point(public), _point(signature[:32])
    scalar = int.from_bytes(signature[32:], "little")
    require(scalar < L and not _equal(a, IDENTITY) and not _equal(r, IDENTITY) and _equal(_mul(L, a), IDENTITY) and _equal(_mul(L, r), IDENTITY), "noncanonical/weak Ed25519 signature")
    challenge = int.from_bytes(hashlib.sha512(signature[:32] + public + message).digest(), "little") % L
    require(_equal(_mul(scalar, BASE), _add(r, _mul(challenge, a))), "actual native Ed25519 signature invalid")


def pda(program, seeds):
    require(len(program) == 32 and len(seeds) < 16 and all(len(seed) <= 32 for seed in seeds), "invalid native PDA seeds")
    for bump in range(255, -1, -1):
        digest = hashlib.sha256(b"".join(seeds) + bytes([bump]) + program + b"ProgramDerivedAddress").digest()
        try:
            _point(digest)
        except ValueError:
            return digest, bump
    raise ValueError("native PDA bump unavailable")


class Reader:
    def __init__(self, raw):
        self.raw, self.position = raw, 0

    def take(self, size):
        require(type(size) is int and 0 <= size <= len(self.raw) - self.position, "truncated native account/wire")
        result = self.raw[self.position:self.position + size]
        self.position += size
        return result

    def uint(self, size):
        return int.from_bytes(self.take(size), "little")

    def vec(self):
        return self.take(self.uint(4))

    def compact(self):
        value = 0
        for index in range(3):
            byte = self.uint(1)
            value |= (byte & 127) << (7 * index)
            require(value <= 65535, "native shortvec overflow")
            if byte < 128:
                require(index == 0 or byte != 0, "noncanonical native shortvec")
                return value
        raise ValueError("native shortvec overflow")

    def end(self):
        require(self.position == len(self.raw), "trailing native wire bytes")


def decode_wire(raw):
    require(0 < len(raw) <= 1232, "invalid native packet size")
    reader = Reader(raw)
    count = reader.compact()
    require(0 < count <= 127, "invalid native signer count")
    signatures = [reader.take(64) for _ in range(count)]
    message = raw[reader.position:]
    require(message, "native compiled message missing")
    version = 0 if message[0] == 128 else "legacy"
    require(message[0] < 128 or message[0] == 128, "unsupported native message version")
    if version == 0:
        reader.take(1)
    required, readonly_signed, readonly_unsigned = reader.take(3)
    n = reader.compact()
    require(required == count and 0 <= readonly_signed < required <= n <= 256 and readonly_unsigned <= n - required, "invalid native message header")
    keys = [reader.take(32) for _ in range(n)]
    require(len(set(keys)) == n, "duplicate static native account key")
    blockhash = reader.take(32)
    instructions = []
    for _ in range(reader.compact()):
        program = reader.uint(1)
        accounts = list(reader.take(reader.compact()))
        data = reader.take(reader.compact())
        require(program < n, "native instruction program is not static")
        instructions.append({"program": keys[program], "accounts": accounts, "data": data})
    lookups, loaded = [], 0
    if version == 0:
        for _ in range(reader.compact()):
            table = reader.take(32)
            writable = list(reader.take(reader.compact()))
            readonly = list(reader.take(reader.compact()))
            require(len(set(writable + readonly)) == len(writable + readonly), "duplicate native ALT index")
            lookups.append({"table": table, "writable": writable, "readonly": readonly})
            loaded += len(writable) + len(readonly)
    reader.end()
    require(n + loaded <= 256 and len({row["table"] for row in lookups}) == len(lookups) and all(index < n + loaded for item in instructions for index in item["accounts"]), "native instruction/ALT index overflow")
    for index, signature in enumerate(signatures):
        verify_ed25519(keys[index], message, signature)
    return {"identity": h(signatures[0]), "signatures": signatures, "message": message, "payer": keys[0], "keys": keys, "blockhash": blockhash, "version": version, "instructions": instructions, "lookups": lookups}


def decode_message(raw, keccak):
    require(len(raw) >= 77 and raw[0] == 3, "invalid native Hyperlane message")
    return {"id": keccak(h(raw)), "wire": h(raw), "version": 3, "nonce": int.from_bytes(raw[1:5], "big"), "origin": int.from_bytes(raw[5:9], "big"), "sender": h(raw[9:41]), "destination": int.from_bytes(raw[41:45], "big"), "recipient": h(raw[45:77]), "body": h(raw[77:])}


def process_messages(decoded, mailbox, keccak):
    output = []
    for instruction in decoded["instructions"]:
        if instruction["program"] != mailbox or instruction["data"][:1] != b"\x01":
            continue
        reader = Reader(instruction["data"])
        reader.take(1)
        metadata = reader.vec()
        message = decode_message(reader.vec(), keccak)
        reader.end()
        require(len(instruction["accounts"]) >= 5, "native process account list truncated")
        output.append(dict(message, metadata_sha256=hashlib.sha256(metadata).hexdigest(), instruction=instruction))
    require(len({row["id"] for row in output}) == len(output), "duplicate native process message")
    return output


def account_data(row, owner, *, address=None, expected=None):
    require(isinstance(row, dict) and row.get("executable") is False and key(row["owner"]) == owner, "native account owner/executable differs")
    if address is not None:
        require(address == expected, "native account PDA differs")
    encoded = row.get("data")
    require(isinstance(encoded, list) and len(encoded) == 2 and encoded[1] == "base64", "raw base64 native account required")
    raw = base64.b64decode(encoded[0], validate=True)
    require(raw[:1] == b"\x01", "uninitialized native account")
    return raw


def decode_account(raw, kind):
    reader = Reader(raw)
    require(reader.uint(1) == 1, "uninitialized native account")
    require(reader.take(8) == {"dispatch": b"DISPATCH", "delivery": b"PROCESSD", "gas": b"GASPAYMT"}[kind], "native account discriminator differs")
    if kind == "dispatch":
        nonce, slot, unique = reader.uint(4), reader.uint(8), reader.take(32)
        wire = reader.take(len(raw) - reader.position)
        require(len(wire) >= 77 and wire[0] == 3 and int.from_bytes(wire[1:5], "big") == nonce, "native dispatch nonce/message differs")
        return {"nonce": nonce, "slot": slot, "unique": unique, "wire": wire}
    sequence = reader.uint(8)
    if kind == "delivery":
        return {"sequence": sequence, "message_id": h(reader.take(32)), "slot": reader.uint(8)}
    return {"sequence": sequence, "igp": reader.take(32), "destination": reader.uint(4), "message_id": h(reader.take(32)), "gas_amount": reader.uint(8), "payment": reader.uint(8), "unique": reader.take(32), "slot": reader.uint(8)}


def verify_composite_storage(raw, bump, mailbox, recipient, fallback):
    """Exact live-shaped Source tree; mutable rate-bucket state stays mutable."""
    reader = Reader(raw)
    require(reader.uint(1) == 1 and reader.uint(1) == bump, "native composite storage initialization/PDA bump differs")
    owner = reader.uint(1)
    require(owner in (0, 1), "invalid native composite owner option")
    if owner:
        reader.take(32)
    require(reader.uint(1) == 1 and reader.uint(1) == 2 and reader.uint(1) == 3 and reader.uint(4) == 3, "Source composite root is not exact3-of3 aggregation")
    require(reader.uint(1) == 4 and reader.uint(1) == 0, "Source composite pausable branch differs")
    require(reader.uint(1) == 6 and reader.uint(8) == 100_000_000_000 and reader.uint(1) == 1 and reader.take(32) == recipient, "Source composite rate-limit configuration differs")
    require(reader.uint(8) <= 100_000_000_000, "native composite mutable capacity invalid")
    updated = reader.uint(8)
    require(updated < 2 ** 63 and reader.take(32) == mailbox, "Source composite rate-limit mailbox/time differs")
    require(reader.uint(1) == 8 and reader.take(32) == fallback, "Source composite fallback routing differs")
    # AccountData may retain allocated zero padding after a config update.
    require(not any(reader.take(len(raw) - reader.position)), "native composite unexpected trailing configuration")
    return {"aggregation_threshold": 3, "branches": ["unpaused", "rateLimited", "fallbackRouting"], "rate_limit_capacity": 100_000_000_000, "fallback": h(fallback)}


class Adapter:
    def __init__(self, manifest, case):
        self.manifest, self.case = manifest, case
        self.submitted = {}
        self.blockhashes, self.fees = {}, {}

    def validate_case(self):
        composite = self.manifest["scenario"] == "sealevel-composite"
        names = ["sealeveltest1", "sealeveltest2"] + ([] if composite else ["sealeveltest3"])
        require(self.case.get("schema") == 1 and self.case.get("scenario") == self.manifest["scenario"] and self.case.get("chain_names") == names, "Source Sealevel scenario/chain set differs")
        require(self.case.get("domain_names") == {str(13375 + i): name for i, name in enumerate(names)} and self.case.get("payments_supported") is True, "Source Sealevel domains/IGP differ")
        require(self.case.get("initial_corpus") == {"dispatches": 2 if composite else 13, "deliveries": 2 if composite else 12, "unpaid": 0 if composite else 1}, "Source Sealevel workload differs")
        require(set(self.case.get("relayer_addresses", {})) == set(names) and set(self.case.get("native_limits", {})) == set(names), "public Sealevel payer/fee bounds missing")
        for name in names:
            key(self.case["relayer_addresses"][name])
            require(type(self.case["native_limits"][name].get("maximum_fee")) is int and self.case["native_limits"][name]["maximum_fee"] > 0, "Source Sealevel fee cap missing")
        require(set(self.case.get("validator_addresses", {})) == {"sealeveltest1"}, "actual Source Sealevel validator set differs")
        hex_bytes(self.case["validator_addresses"]["sealeveltest1"], 20)

    def transport(self, field):
        require(field in {"rpcurls", "customrpcurls"}, "unexpected native Sealevel endpoint")
        return "http-json"

    def observe(self, session, event):
        if event["status"] != 200:
            return
        requests = event["request"] if isinstance(event["request"], list) else [event["request"]]
        responses = event["response"] if isinstance(event["response"], list) else [event["response"]]
        by_id = {row["id"]: row for row in responses}
        require(len(by_id) == len(responses) == len(requests), "native response batch identity differs")
        chain, ns = event["chain"], event["received_monotonic_ns"]
        mailbox = key(session.chain_config(chain)["mailbox"])
        for request in requests:
            require(request.get("id") in by_id, "native response ID missing")
            response = by_id[request["id"]]
            if "error" in response:
                continue
            result, method, params = response.get("result"), request["method"], request.get("params", [])
            if method == "getLatestBlockhash" and result:
                value = result["value"]
                self.blockhashes.setdefault((chain, key(value["blockhash"])), []).append((result["context"]["slot"], value["lastValidBlockHeight"]))
            if method == "getFeeForMessage" and result and type(result.get("value")) is int:
                self.fees[(chain, base64.b64decode(params[0], validate=True))] = result["value"]
            if method == "sendTransaction" and event["role"] == "relayer" and isinstance(result, str):
                require(len(params) >= 2 and params[1].get("encoding") == "base64", "native submission encoding differs")
                wire = base64.b64decode(params[0], validate=True)
                decoded = decode_wire(wire)
                require(b58decode(result, 64) == hex_bytes(decoded["identity"], 64), "native broadcast acknowledgement differs")
                messages = process_messages(decoded, mailbox, session.keccak)
                self.submitted[(chain, decoded["identity"])] = messages
                session.record_broadcast(chain, decoded["identity"], hashlib.sha256(wire).hexdigest(), [row["id"] for row in messages])
            if method == "getTransaction" and result and len(params) >= 2 and params[1].get("commitment") == "finalized" and result.get("meta", {}).get("err") is None:
                identity = h(b58decode(params[0], 64))
                for message in self.submitted.get((chain, identity), []):
                    session.record_inclusion(chain, message["id"], identity, ns, {"method": method, "slot": result["slot"], "finalized_request": True})
            if method == "getSignatureStatuses" and result:
                require(len(params[0]) == len(result["value"]), "native signature status count differs")
                for signature, status in zip(params[0], result["value"]):
                    if status is not None and status.get("err") is None and status.get("confirmationStatus") == "finalized":
                        identity = h(b58decode(signature, 64))
                        for message in self.submitted.get((chain, identity), []):
                            session.record_inclusion(chain, message["id"], identity, ns, {"method": method, "slot": status["slot"], "finalized_status": True})
            if method in {"getAccountInfo", "getProgramAccounts", "getMultipleAccounts"} and len(params) >= 2 and params[1].get("commitment") == "finalized" and result:
                if method == "getAccountInfo":
                    entries = [(params[0], result["value"])]
                elif method == "getMultipleAccounts":
                    require(len(params[0]) == len(result["value"]), "native multiple account coverage differs")
                    entries = list(zip(params[0], result["value"]))
                else:
                    require(isinstance(result, dict) and "context" in result, "native account observation needs finalized context")
                    entries = [(row["pubkey"], row["account"]) for row in result["value"]]
                for address, account in entries:
                    if account is None or key(account["owner"]) != mailbox:
                        continue
                    raw = account_data(account, mailbox)
                    if raw[1:9] != b"PROCESSD":
                        continue
                    processed = decode_account(raw, "delivery")
                    require(key(address) == pda(mailbox, [b"hyperlane", b"-", b"processed_message", b"-", hex_bytes(processed["message_id"], 32)])[0] and processed["slot"] <= result["context"]["slot"], "native observed delivery PDA/context differs")
                    for (known_chain, identity), messages in self.submitted.items():
                        if chain == known_chain and any(row["id"] == processed["message_id"] for row in messages):
                            session.record_inclusion(chain, processed["message_id"], identity, ns, {"method": method, "slot": processed["slot"], "processed_pda": address})

    def _account(self, session, chain, address, owner):
        result = session.rpc(chain, "getAccountInfo", [b58encode(address), {"encoding": "base64", "commitment": "finalized"}])
        if result["value"] is None:
            return None
        return account_data(result["value"], owner), result["context"]["slot"]

    def _program_accounts(self, session, chain, program, kind):
        discriminator = {"dispatch": b"DISPATCH", "gas": b"GASPAYMT"}[kind]
        result = session.rpc(chain, "getProgramAccounts", [b58encode(program), {"encoding": "base64", "commitment": "finalized", "withContext": True, "filters": [{"memcmp": {"offset": 1, "bytes": b58encode(discriminator)}}]}])
        output = []
        for row in result["value"]:
            raw = account_data(row["account"], program)
            decoded = decode_account(raw, kind)
            seeds = [b"hyperlane" if kind == "dispatch" else b"hyperlane_igp", b"-", b"dispatched_message" if kind == "dispatch" else b"gas_payment", b"-", decoded["unique"]]
            require(key(row["pubkey"]) == pda(program, seeds)[0] and decoded["slot"] <= result["context"]["slot"], "native event PDA/finalized context differs")
            output.append((row["pubkey"], decoded))
        return output

    def _transaction(self, session, chain, signature):
        options = {"encoding": "json", "commitment": "finalized", "maxSupportedTransactionVersion": 0}
        value = session.rpc(chain, "getTransaction", [signature, options])
        require(isinstance(value, dict) and value.get("meta", {}).get("err") is None and value["transaction"]["signatures"][0] == signature, "actual finalized native receipt missing/failed/foreign")
        slot = value["slot"]
        block_options = {"transactionDetails": "signatures", "rewards": False, "commitment": "finalized", "maxSupportedTransactionVersion": 0}
        first = session.rpc(chain, "getBlock", [slot, block_options])
        require(first["signatures"].count(signature) == 1, "native receipt absent/duplicate in canonical slot")
        statuses = session.rpc(chain, "getSignatureStatuses", [[signature], {"searchTransactionHistory": True}])
        status = statuses["value"][0]
        require(status is not None and statuses["context"]["slot"] >= slot and status["slot"] == slot and status.get("err") is None and status["confirmationStatus"] == "finalized", "native configured finality/status differs")
        encoded = session.rpc(chain, "getTransaction", [signature, dict(options, encoding="base64")])
        require(encoded["slot"] == slot and encoded["meta"] == value["meta"] and encoded["transaction"][1] == "base64", "native JSON/binary receipt differs")
        wire = base64.b64decode(encoded["transaction"][0], validate=True)
        decoded = decode_wire(wire)
        require(decoded["identity"] == h(b58decode(signature, 64)), "actual native signed wire identity differs")
        second = session.rpc(chain, "getBlock", [slot, block_options])
        require(second["blockhash"] == first["blockhash"] and second["previousBlockhash"] == first["previousBlockhash"] and second["signatures"].count(signature) == 1, "native canonical slot fence changed")
        fee, units = value["meta"].get("fee"), value["meta"].get("computeUnitsConsumed")
        require(type(fee) is int and fee > 0 and type(units) is int and units > 0, "actual native receipt fee/units unavailable")
        loaded = value["meta"].get("loadedAddresses", {"writable": [], "readonly": []})
        all_keys = decoded["keys"] + [key(item) for part in ("writable", "readonly") for item in loaded[part]]
        require(len(all_keys) <= 256 and len(all_keys) == len(decoded["keys"]) + sum(len(row["writable"]) + len(row["readonly"]) for row in decoded["lookups"]), "actual native ALT loaded keys differ")
        expected_loaded = {"writable": [], "readonly": []}
        table_addresses = {}
        for lookup in decoded["lookups"]:
            table = self._account(session, chain, lookup["table"], b58decode("AddressLookupTab1e1111111111111111111111111", 32))
            require(table is not None, "actual native ALT account missing")
            data, context = table
            # ALT uses bincode ProgramState, not initialized AccountData/Borsh.
            require(len(data) >= 56 and (len(data) - 56) % 32 == 0 and int.from_bytes(data[:4], "little") == 1 and int.from_bytes(data[4:12], "little") == 2 ** 64 - 1, "actual native ALT state/activation differs")
            extended = int.from_bytes(data[12:20], "little")
            require(extended <= slot <= context, "actual native ALT snapshot cannot establish receipt bank")
            available = data[20] if extended == slot else (len(data) - 56) // 32
            table_addresses[h(lookup["table"])] = [data[i:i + 32] for i in range(56, len(data), 32)]
            for part in ("writable", "readonly"):
                for index in lookup[part]:
                    require(index < available, "native ALT index not active in receipt bank")
                    expected_loaded[part].append(data[56 + index * 32:88 + index * 32])
        require(all([key(item) for item in loaded[part]] == expected_loaded[part] for part in expected_loaded), "actual native ALT account contents differ from canonical loaded keys")
        native_message = value["transaction"]["message"]
        require([key(item) for item in native_message["accountKeys"]] == decoded["keys"] and key(native_message["recentBlockhash"]) == decoded["blockhash"], "native JSON account/blockhash differs from signed message")
        require(len(native_message["instructions"]) == len(decoded["instructions"]), "native JSON instruction coverage differs")
        for item, signed in zip(native_message["instructions"], decoded["instructions"]):
            require(decoded["keys"][item["programIdIndex"]] == signed["program"] and item["accounts"] == signed["accounts"] and b58decode(item["data"]) == signed["data"], "native JSON instruction differs from signed bytes")
        return {"slot": slot, "block_hash": h(key(first["blockhash"])), "transaction_index": first["signatures"].index(signature), "fee": fee, "units": units, "wire_sha256": hashlib.sha256(wire).hexdigest(), "wire_bytes": len(wire), "decoded": decoded, "keys": all_keys, "lookup_addresses": table_addresses, "native_json": value}

    @staticmethod
    def _event_instructions(value, keys, program, address, kind):
        candidates = list(value["transaction"]["message"]["instructions"])
        for group in value["meta"].get("innerInstructions") or []:
            candidates.extend(group["instructions"])
        examined = 0
        for instruction in candidates:
            if "programIdIndex" not in instruction:
                continue
            index, accounts = instruction["programIdIndex"], instruction["accounts"]
            require(type(index) is int and 0 <= index < len(keys) and isinstance(accounts, list) and all(type(i) is int and 0 <= i < len(keys) for i in accounts), "native event instruction index differs")
            if keys[index] != program or address not in [keys[i] for i in accounts]:
                continue
            examined += 1
            data = b58decode(instruction["data"])
            reader = Reader(data)
            if kind == "dispatch" and data[:1] == b"\x04":
                reader.take(69)
                reader.vec()
            elif kind == "gas" and data[:1] == b"\x03":
                reader.take(45)
            elif kind == "delivery" and data[:1] == b"\x01":
                reader.take(1)
                reader.vec()
                reader.vec()
            else:
                continue
            reader.end()
            return examined, True
        return examined, False

    def _event_transaction(self, session, chain, program, address, kind, slot):
        # All three immutable event accounts store Clock::get()?.slot at their
        # creation. Discover in that exact canonical bank, not a secondary
        # address-signature index which may be unavailable independently.
        options = {"encoding": "json", "transactionDetails": "full", "rewards": False, "commitment": "finalized", "maxSupportedTransactionVersion": 0}
        block = session.rpc(chain, "getBlock", [slot, options])
        require(isinstance(block, dict), "native event canonical account slot unavailable")
        rows = block.get("transactions")
        # This is a fixture resource bound, not a Solana protocol limit. Never
        # truncate: the complete list is needed to exclude a second match.
        require(isinstance(rows, list) and len(rows) <= 100, "native event canonical block census exceeds fixture bound")
        signatures = [row["transaction"]["signatures"][0] for row in rows]
        require(len(set(signatures)) == len(signatures) and all(len(b58decode(s, 64)) == 64 for s in signatures), "native event canonical block signature census differs")
        # Reconstruct the exact-slot address-containing candidate census from
        # the COMPLETE canonical block. Unrelated rows receive no proof credit.
        candidates = []
        for row, signature in zip(rows, signatures):
            loaded = row["meta"].get("loadedAddresses", {"writable": [], "readonly": []})
            keys = [key(item) for item in row["transaction"]["message"]["accountKeys"]] + [key(item) for part in ("writable", "readonly") for item in loaded[part]]
            require(len(keys) <= 256, "native event canonical block key census exceeds bound")
            if key(address) in keys:
                candidates.append((row, signature, keys))
        found = []
        error_rows = canonical_transactions = program_address_instructions = 0
        for row, signature, keys in candidates:
            if row["meta"].get("err") is not None:
                error_rows += 1
                continue
            proof = self._transaction(session, chain, signature)
            require(proof["slot"] == slot and proof["block_hash"] == h(key(block["blockhash"])) and proof["keys"] == keys, "native event account slot/discovery block fence differs")
            examined, matched = self._event_instructions(proof["native_json"], proof["keys"], program, key(address), kind)
            canonical_transactions += 1
            program_address_instructions += examined
            if matched:
                found.append((h(b58decode(signature, 64)), proof))
        if len(found) != 1:
            try:
                multivm_diagnostics.note_svm_event_failure(session, chain, kind, slot, {
                    "signature_rows": len(candidates), "error_rows": error_rows,
                    "other_slot_rows": 0, "canonical_transactions": canonical_transactions,
                    "program_address_instructions": program_address_instructions,
                    "matched_transactions": len(found),
                })
            except BaseException:
                pass  # Optional observation cannot replace the original relevance failure.
        require(len(found) == 1, "native event canonical transaction relevance ambiguous/missing")
        return found[0]

    def collect(self, session, expected, phase):
        messages, deliveries, transactions = [], [], {}
        chains = {name: session.chain_config(name) for name in self.case["chain_names"]}
        names = {int(row["domainid"]): name for name, row in chains.items()}
        for name, chain in chains.items():
            mailbox, igp = key(chain["mailbox"]), key(chain["interchaingaspaymaster"])
            outbox = self._account(session, name, pda(mailbox, [b"hyperlane", b"-", b"outbox"])[0], mailbox)
            require(outbox is not None, "actual native outbox missing")
            reader = Reader(outbox[0])
            reader.take(1)
            require(reader.uint(4) == int(chain["domainid"]) and reader.uint(1) == pda(mailbox, [b"hyperlane", b"-", b"outbox"])[1], "actual native outbox domain/PDA bump differs")
            owner = reader.uint(1)
            require(owner in (0, 1), "invalid native outbox owner option")
            if owner:
                reader.take(32)
            reader.take(32 * 32)
            count = reader.uint(8)
            dispatched_accounts = self._program_accounts(session, name, mailbox, "dispatch")
            require(count == len(dispatched_accounts) and sorted(row["nonce"] for _, row in dispatched_accounts) == list(range(count)), "actual native outbox/dispatch sequence has gaps")
            igp_state = session.rpc(name, "getAccountInfo", [b58encode(igp), {"encoding": "base64", "commitment": "finalized"}])
            require(igp_state["value"] is not None and igp_state["value"].get("executable") is False, "actual native configured IGP missing")
            igp_program = key(igp_state["value"]["owner"])
            payments = self._program_accounts(session, name, igp_program, "gas")
            for address, account in dispatched_accounts:
                message = decode_message(account["wire"], session.keccak)
                require(message["origin"] == int(chain["domainid"]) and message["destination"] in names, "native dispatched domain differs")
                identity, dispatch = self._event_transaction(session, name, mailbox, address, "dispatch", account["slot"])
                paid, gas_metadata = [], []
                for gas_address, payment in payments:
                    if payment["message_id"] != message["id"]:
                        continue
                    require(payment["destination"] == message["destination"], "native payment destination differs")
                    gas_tx, gas_proof = self._event_transaction(session, name, igp_program, gas_address, "gas", payment["slot"])
                    gas_metadata.append(sequence_metadata(name, int(chain["domainid"]), gas_tx, gas_proof, payment["sequence"], igp))
                    paid.append({"gas_amount": payment["gas_amount"], "payment": payment["payment"] if payment["igp"] == igp else 0, "transaction_hash": gas_tx, "native_igp": h(payment["igp"]), "slot": gas_proof["slot"]})
                metadata = {"dispatch": [sequence_metadata(name, int(chain["domainid"]), identity, dispatch, message["nonce"], mailbox)], "insertion": [sequence_metadata(name, int(chain["domainid"]), identity, dispatch, message["nonce"], key(chain["merkletreehook"]))], "payment": gas_metadata, "delivery": []}
                message.update(origin_chain=name, dispatch_transaction=identity, dispatch_block=dispatch["slot"], dispatch_log_index=message["nonce"], dispatch_transaction_index=dispatch["transaction_index"], event_metadata=metadata, insertions=[message["nonce"]], payments=paid)
                messages.append(message)
                destination = names[message["destination"]]
                target = key(chains[destination]["mailbox"])
                processed_address = pda(target, [b"hyperlane", b"-", b"processed_message", b"-", hex_bytes(message["id"], 32)])[0]
                processed = self._account(session, destination, processed_address, target)
                payable = sum(row["payment"] for row in paid) > 0
                if not payable:
                    require(processed is None, "Source nonmatching-IGP message unexpectedly delivered")
                    continue
                require(processed is not None, "actual payable native delivery missing")
                delivery = decode_account(processed[0], "delivery")
                require(delivery["message_id"] == message["id"] and delivery["slot"] <= processed[1], "native processed account identity/finality differs")
                transaction, proof = self._event_transaction(session, destination, target, b58encode(processed_address), "delivery", delivery["slot"])
                if (destination, transaction) not in transactions:
                    actual = process_messages(proof["decoded"], target, session.keccak)
                    require(actual, "actual native process instruction missing")
                    require(proof["decoded"]["version"] == (0 if destination == "sealeveltest2" else "legacy"), "Source native ALT/legacy destination coverage differs")
                    transactions[(destination, transaction)] = {"chain": destination, "transaction_hash": transaction, "proof": {key_: value for key_, value in proof.items() if key_ not in {"decoded", "keys", "lookup_addresses", "native_json"}} | {"message_ids": [row["id"] for row in actual]}}
                metadata["delivery"] = [sequence_metadata(destination, int(chains[destination]["domainid"]), transaction, proof, delivery["sequence"], target)]
                message.update(delivery_chain=destination, delivery_transaction=transaction)
                deliveries.append(message)
        messages.sort(key=lambda row: (row["origin"], row["nonce"]))
        require(len(messages) == self.case["initial_corpus"]["dispatches"] and len(deliveries) == expected == self.case["initial_corpus"]["deliveries"], "actual Source native dispatch/delivery corpus differs")
        require(sum(sum(p["payment"] for p in m["payments"]) == 0 for m in messages) == self.case["initial_corpus"]["unpaid"], "actual Source nonmatching IGP corpus differs")
        for name, chain in chains.items():
            mailbox = key(chain["mailbox"])
            inbox = self._account(session, name, pda(mailbox, [b"hyperlane", b"-", b"inbox"])[0], mailbox)
            require(inbox is not None, "actual native inbox missing")
            reader = Reader(inbox[0])
            reader.take(1)
            require(reader.uint(4) == int(chain["domainid"]) and reader.uint(1) == pda(mailbox, [b"hyperlane", b"-", b"inbox"])[1], "actual native inbox domain/PDA bump differs")
            reader.take(32)
            require(reader.uint(8) == sum(m["delivery_chain"] == name for m in deliveries), "actual native inbox canonical delivery count differs")
        return {"messages": messages, "deliverable_messages": deliveries, "native_delivery_transactions": list(transactions.values())}

    def checkpoints(self, session, snapshot):
        results = []
        for capture in session.captures:
            original = capture["original"]
            if original["role"] != "validator":
                continue
            require(original["role_chain_names"] == ["sealeveltest1"], "actual native validator origin differs")
            chain = original["chains"]["sealeveltest1"]
            checkpoint = original["checkpoint_syncer"]
            require(checkpoint["type"] == "localStorage", "actual local native checkpoint path required")
            path = session.owned_path(pathlib.Path(checkpoint["path"]).relative_to(self.manifest["task_root"]))
            selected = capture["proxied"]["chains"]["sealeveltest1"]
            configured = urls(selected.get("customrpcurls", selected["rpcurls"]))
            proof = verify_checkpoint_objects(path, chain, self.case["validator_addresses"]["sealeveltest1"], [m for m in snapshot["messages"] if m["origin_chain"] == "sealeveltest1"], session.keccak, git_sha=self.manifest["runtime_source_commit"], configured_rpc_urls=configured, allows_public_rpcs=original["allows_public_rpcs"], hook_hash=h(key(chain["merkletreehook"])))
            proof["published_bytes"] = [{"path": str(item), "bytes": item.stat().st_size, "sha256": hashlib.sha256(item.read_bytes()).hexdigest()} for item in path.glob("*_with_id.json")]
            results.append(proof)
        require(results, "actual native validator checkpoint proof missing")
        return results

    def sql(self, session, snapshot):
        if self.manifest["scenario"] == "sealevel-composite":
            require(not any(row["original"]["role"] == "scraper" for row in session.captures), "Source composite unexpectedly configures scraper")
            return [{"scraper_configured_by_Source": False, "qualification": "Composite Source runs relayer+validator only; standard Sealevel case covers scraper."}]
        results = []
        for message in snapshot["messages"]:
            identity, wire = hex_bytes(message["id"], 32).hex(), hex_bytes(message["body"]).hex()
            origin, destination, nonce = message["origin"], message["destination"], message["nonce"]
            dispatch = hex_bytes(message["dispatch_transaction"], 64).hex()
            actual = session.query_sql(message["origin_chain"], f"SELECT count(*) FROM message m JOIN raw_message_dispatch r ON r.msg_id=m.msg_id JOIN \"transaction\" t ON t.id=m.origin_tx_id AND t.hash=r.origin_tx_hash WHERE m.msg_id=decode('{identity}','hex') AND m.origin={origin} AND m.destination={destination} AND m.nonce={nonce} AND m.msg_body=r.msg_body AND m.msg_body=decode('{wire}','hex') AND t.hash=decode('{dispatch}','hex')")
            require(actual.strip() == "1", "native PostgreSQL dispatch identity differs")
            for payment in message["payments"]:
                transaction = hex_bytes(payment["transaction_hash"], 64).hex()
                actual = session.query_sql(message["origin_chain"], f"SELECT count(*) FROM confirmed_gas_payment g JOIN \"transaction\" t ON t.id=g.tx_id AND t.hash=g.transaction_hash WHERE g.msg_id=decode('{identity}','hex') AND g.origin={origin} AND g.destination={destination} AND t.hash=decode('{transaction}','hex') AND g.gas_amount={payment['gas_amount']} AND g.payment={payment['payment']}")
                require(actual.strip() == "1", "native PostgreSQL separate-payment transaction/amount differs")
            insertion = session.query_sql(message["origin_chain"], f"SELECT string_agg(leaf_index::text,',' ORDER BY leaf_index) FROM confirmed_merkle_tree_insertion WHERE message_id=decode('{identity}','hex') AND domain={origin}")
            require(insertion.strip() == str(nonce), "native PostgreSQL derived insertion differs")
            delivered = message in snapshot["deliverable_messages"]
            destination_name = self.case["domain_names"][str(destination)]
            count = session.query_sql(destination_name, sql_delivery_query(message, message.get("delivery_transaction")))
            require(count.strip() == str(int(delivered)), "native PostgreSQL full64 delivery identity differs")
            metadata = message["event_metadata"]
            require(set(metadata) == {"dispatch", "insertion", "payment", "delivery"} and len(metadata["dispatch"]) == 1 and len(metadata["insertion"]) == len(message["insertions"]) and len(metadata["payment"]) == len(message["payments"]) and len(metadata["delivery"]) == int(delivered), "native sequence event coordinate coverage differs")
            for kind, events in metadata.items():
                for event in events:
                    require(session.query_sql(event["chain"], sql_event_query(kind, message["id"], event)).strip() == "1", "native SQL canonical sequence event coordinates differ")
            results.append({"id": message["id"], "canonical_event_coordinates": metadata, "dispatch_rows": 1, "separate_payment_rows": len(message["payments"]), "delivery_rows": int(delivered)})
        return results

    def native_rows(self, session, snapshot, rows, baseline):
        messages = {row["id"]: row for row in snapshot["deliverable_messages"]}
        relayers = [row["original"] for row in session.captures if row["original"]["role"] == "relayer"]
        require(relayers, "actual native relayer configuration capture missing")
        chains = relayers[-1]["chains"]
        results = []
        for row in rows:
            message, operation = messages[row["id"]], row["operation"]
            origin, destination = chains[message["origin_chain"]], chains[message["delivery_chain"]]
            authority = operation["authority"]
            expected = {"protocol": "sealevel", "origin": message["origin"], "destination": message["destination"], "mailbox": h(key(destination["mailbox"])), "chain_id": str(destination["chainid"]), "origin_hook": h(key(origin["merkletreehook"])), "operation_id": message["id"], "generation": operation["generation"], "kind": "process", "target": None}
            require(authority == expected and operation["nonce"] == message["nonce"] and operation["stage"] == "delivered" and operation["identity"] == {"kind": "signature512", "hex": message["delivery_transaction"]}, "actual native operation authority/identity differs")
            proof = self._transaction(session, message["delivery_chain"], b58encode(hex_bytes(message["delivery_transaction"], 64)))
            decoded = proof["decoded"]
            require(decoded["payer"] == key(self.case["relayer_addresses"][message["delivery_chain"]]) and len(decoded["signatures"]) == 1, "actual native payer/signer set differs from Source signer")
            configured_alts = destination.get("mailboxprocessalts", destination.get("mailboxprocessalt", []))
            if isinstance(configured_alts, str):
                configured_alts = json.loads(configured_alts) if configured_alts.startswith("[") else [configured_alts]
            configured_alts = [key(item) for item in configured_alts]
            require(all(lookup["table"] in configured_alts for lookup in decoded["lookups"]), "actual native signed ALT not configured by Source")
            composite_proof = None
            if self.manifest["scenario"] == "sealevel-composite":
                require(len(configured_alts) == 2 and len(decoded["lookups"]) == 2, "Source oversized composite path must use both configured ALTs")
                recipient = key("3MzUPjP5LEkiHH82nEAe28Xtz9ztuMqWc8UmuKxrpVQH")
                fallback = key("4RSV6iyqW9X66Xq3RDCVsKJ7hMba5uv6XP8ttgxjVUB1")
                tables = [addresses for addresses in proof["lookup_addresses"].values() if len(addresses) == 11 and addresses[0] == recipient and addresses[8] == fallback]
                require(len(tables) == 1 and hex_bytes(message["recipient"], 32) == recipient, "actual Source composite route ALT/recipient differs")
                composite = tables[0][4]
                storage, bump = pda(composite, [b"hyperlane_ism", b"-", b"verify", b"-", b"account_metas"])
                account = self._account(session, message["delivery_chain"], storage, composite)
                require(account is not None, "actual Source composite configuration PDA missing")
                composite_proof = verify_composite_storage(account[0], bump, key(destination["mailbox"]), recipient, fallback)
                verify_discriminator = hashlib.sha256(b"hyperlane-interchain-security-module:verify").digest()[:8]
                called = set()
                for group in proof["native_json"]["meta"].get("innerInstructions") or []:
                    for instruction in group["instructions"]:
                        if b58decode(instruction["data"])[:8] == verify_discriminator:
                            called.add(proof["keys"][instruction["programIdIndex"]])
                require({composite, fallback} <= called, "actual successful native receipt did not execute composite+fallback Verify CPIs")
            processes = process_messages(decoded, key(destination["mailbox"]), session.keccak)
            require([item["wire"] for item in processes] == [message["wire"]], "actual native process message/target differs")
            instruction = processes[0]["instruction"]
            actual_keys = [proof["keys"][index] for index in instruction["accounts"]]
            require(actual_keys[0] == decoded["payer"] and actual_keys[2] == pda(key(destination["mailbox"]), [b"hyperlane", b"-", b"inbox"])[0] and actual_keys[4] == pda(key(destination["mailbox"]), [b"hyperlane", b"-", b"processed_message", b"-", hex_bytes(message["id"], 32)])[0], "actual native process payer/inbox/processed PDA differs")
            require(operation["signed"] == {"bytes": proof["wire_bytes"], "sha256": "0x" + proof["wire_sha256"]}, "actual native signed bytes differ from stopped row")
            expenditure = operation["expenditure"]
            require(expenditure["present"] is True and int(expenditure["gas_used_hex"], 16) == proof["units"] and int(expenditure["tokens_used_hex"], 16) == proof["fee"], "actual native fee/units differ from expenditure marker")
            budget = [instruction["data"] for instruction in decoded["instructions"] if instruction["program"] == b58decode("ComputeBudget111111111111111111111111111111", 32)]
            limits = [int.from_bytes(data[1:], "little") for data in budget if data[:1] == b"\x02" and len(data) == 5]
            require(len(limits) == 1 and limits[0] >= proof["units"], "actual native compute budget missing/exceeded")
            fee = self.fees.get((message["delivery_chain"], decoded["message"]))
            require(fee is not None and fee == proof["fee"], "actual prepared native fee quote missing/differs")
            candidates = []
            for slot, expiration in self.blockhashes.get((message["delivery_chain"], decoded["blockhash"]), []):
                body = {"message": h(decoded["message"]), "payer": h(decoded["payer"]), "blockhash": h(decoded["blockhash"]), "last_valid_block_height": expiration, "context_slot": slot, "gas_limit": limits[0], "fee": fee, "tip_lamports": 0, "maximum_fee": self.case["native_limits"][message["delivery_chain"]]["maximum_fee"], "submitter": "rpc"}
                raw = json.dumps({"version": 1, "authority": expected, "payload": body}, separators=(",", ":")).encode()
                candidates.append({"bytes": len(raw), "sha256": "0x" + hashlib.sha256(raw).hexdigest()})
            require(operation["stored_canonical_intent"] in candidates, "actual native public prepare quote/intent digest differs")
            results.append({"id": message["id"], "identity": operation["identity"], "canonical_slot": proof["slot"], "fee": proof["fee"], "compute_units": proof["units"], "independent_Ed25519_verified": True, "actual_composite": composite_proof, "initial_context": "observed; pinned across restart"})
        require(len(results) == len(messages), "actual native signed row coverage differs")
        return results

    def readiness(self, session, before_captures, after_captures):
        self.validate_case()
        require(before_captures and len(before_captures) == len(after_captures), "native all-role restart capture coverage differs")
        results = []
        for name in self.case["chain_names"]:
            slot = session.rpc(name, "getSlot", [{"commitment": "finalized"}])
            require(type(slot) is int and slot > 0, "actual native restarted finalized RPC unavailable")
            results.append({"chain": name, "finalized_slot": slot})
        return {"actual_native_readiness": results, "same_db_and_signed_identity": "checked by shared stopped readers and parent-owned restart"}
