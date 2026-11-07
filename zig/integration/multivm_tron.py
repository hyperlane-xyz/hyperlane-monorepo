"""Native TRE wallet/solidity corroboration, separate from EVM JSONRPC logs."""
from __future__ import annotations
import hashlib

from multivm_evidence import direct_request, hex_bytes, require
from multivm_evm import EvmEvidence, address, quantity, recover_signature


def varint(value):
    require(type(value) is int and value >= 0, "negative protobuf integer")
    result = bytearray()
    while value >= 128:
        result.append((value & 127) | 128)
        value >>= 7
    result.append(value)
    return bytes(result)


def protobuf(value):
    cursor, fields = 0, {}
    def integer():
        nonlocal cursor
        start, number, shift = cursor, 0, 0
        while cursor < len(value) and shift <= 63:
            byte = value[cursor]
            cursor += 1
            number |= (byte & 127) << shift
            if byte < 128:
                require(number < 2 ** 64 and value[start:cursor] == varint(number), "noncanonical protobuf varint")
                return number
            shift += 7
        raise ValueError("truncated protobuf varint")
    while cursor < len(value):
        tag = integer()
        field, wire = tag >> 3, tag & 7
        require(field > 0 and field not in fields and len(fields) <= 64, "duplicate/invalid protobuf field")
        if wire == 0:
            data = integer()
        elif wire == 2:
            size = integer()
            require(cursor + size <= len(value), "truncated protobuf bytes")
            data = value[cursor:cursor + size]
            cursor += size
        else:
            raise ValueError("unsupported native protobuf wire type")
        fields[field] = (wire, data)
    return fields


def native_trigger(raw):
    fields = protobuf(raw)
    require(set(fields) <= {1, 3, 4, 8, 11, 14, 18} and {1, 4, 11} <= fields.keys(), "unexpected native raw_data fields")
    require(fields[11][0] == 2, "native contract wire type differs")
    contract = protobuf(fields[11][1])
    require(set(contract) == {1, 2} and contract[1] == (0, 31) and contract[2][0] == 2, "native transaction is not TriggerSmartContract")
    parameter = protobuf(contract[2][1])
    require(set(parameter) == {1, 2} and parameter[1] == (2, b"/protocol.TriggerSmartContract") and parameter[2][0] == 2, "native contract Any authority differs")
    trigger = protobuf(parameter[2][1])
    require({1, 2} <= trigger.keys() and set(trigger) <= {1, 2, 3, 4, 5, 6}, "unexpected native trigger fields")
    for field in (1, 2):
        require(trigger[field][0] == 2 and len(trigger[field][1]) == 21 and trigger[field][1][0] == 0x41, "native trigger address differs")
    for field in (3, 5, 6):
        require(field not in trigger or trigger[field] == (0, 0), "unexpected native process value/token transfer")
    require(4 in trigger and trigger[4][0] == 2, "native process calldata missing")
    return {"owner": "0x" + trigger[1][1][1:].hex(), "target": "0x" + trigger[2][1][1:].hex(), "calldata": trigger[4][1]}


def process_message(calldata, selector):
    require(calldata[:4] == hex_bytes(selector, 4) and len(calldata) >= 68, "native transaction is not Mailbox.process")
    data = calldata[4:]
    values, intervals = [], []
    for word in (0, 32):
        offset = int.from_bytes(data[word:word + 32], "big")
        require(offset >= 64 and offset % 32 == 0 and offset + 32 <= len(data), "native process ABI offset differs")
        size = int.from_bytes(data[offset:offset + 32], "big")
        end = offset + 32 + ((size + 31) // 32) * 32
        require(end <= len(data) and not any(data[offset + 32 + size:end]), "native process ABI bounds/padding differ")
        values.append(data[offset + 32:offset + 32 + size])
        intervals.append((offset, end))
    require(intervals[0][0] == 64 and intervals[0][1] == intervals[1][0] and intervals[1][1] == len(data), "native process ABI overlaps/trailing bytes")
    return values[1]


def tron_address(value):
    require(isinstance(value, str), "invalid Tron address")
    if value.startswith("0x"):
        return address(value)
    if len(value) == 40:
        return address("0x" + value)
    if len(value) == 42 and value.startswith("41"):
        return address("0x" + value[2:])
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    require(isinstance(value, str) and len(value) == 34 and all(c in alphabet for c in value), "invalid Tron address")
    number = 0
    for character in value:
        number = number * 58 + alphabet.index(character)
    raw = number.to_bytes((number.bit_length() + 7) // 8, "big")
    require(len(raw) == 25 and raw[0] == 0x41 and hashlib.sha256(hashlib.sha256(raw[:21]).digest()).digest()[:4] == raw[21:], "invalid Tron address checksum/network")
    return address("0x" + raw[1:21].hex())


class TronEvidence(EvmEvidence):
    def __init__(self, manifest, endpoint, wallet, solidity, *, call=None, command=None, native=None):
        super().__init__(manifest, endpoint, call=call, command=command)
        # TRE canonicality is the independently corroborated Solidity block,
        # not a new Ethereum confirmation-depth assumption.
        self.reorg_depth = None
        self.wallet = wallet.rstrip("/")
        self.solidity = solidity.rstrip("/")
        self.native = native or (lambda endpoint, method, params: direct_request(endpoint + "/" + method, params))

    def canonical_receipt(self, transaction_hash, *, mailbox=None, expected_ids=None):
        result = super().canonical_receipt(transaction_hash, mailbox=tron_address(mailbox) if mailbox is not None else None, expected_ids=expected_ids)
        identifier = hex_bytes(transaction_hash, 32).hex()
        live = self.native(self.wallet, "gettransactioninfobyid", {"value": identifier})
        solid = self.native(self.solidity, "gettransactioninfobyid", {"value": identifier})
        require(isinstance(live, dict) and isinstance(solid, dict) and live and solid, "native TRE wallet/solidity receipt absent")
        require(live.get("id", "").lower() == identifier and solid.get("id", "").lower() == identifier, "native TRE transaction identity differs")
        require(live.get("blockNumber") == solid.get("blockNumber") == quantity(result["receipt"]["blockNumber"]), "native TRE confirmed height differs")
        for info in (live, solid):
            receipt = info.get("receipt")
            require(isinstance(receipt, dict) and receipt.get("result", "SUCCESS") == "SUCCESS" and info.get("result", "SUCESS") == "SUCESS", "native TRE receipt failed")
            require(type(info.get("fee")) is int and info["fee"] > 0, "native TRE actual positive fee missing")
        require(live["fee"] == solid["fee"], "native TRE wallet/solidity fees differ")
        block_number = solid["blockNumber"]
        block = self.native(self.solidity, "getblockbynum", {"num": block_number})
        require(isinstance(block, dict) and block.get("block_header", {}).get("raw_data", {}).get("number") == block_number, "native TRE canonical solidity block missing")
        require(block.get("blockID", "").lower() == result["receipt"]["blockHash"].removeprefix("0x").lower(), "TRE JSONRPC/solidity canonical block differs")
        transactions = block.get("transactions")
        require(isinstance(transactions, list) and sum(tx.get("txID", "").lower() == identifier for tx in transactions) == 1, "native TRE canonical transaction membership differs")
        require(all(tx.get("ret", [{}])[0].get("contractRet") == "SUCCESS" for tx in transactions if tx.get("txID", "").lower() == identifier), "native TRE execution failed")
        result.update({"native_wallet_receipt": live, "native_solidity_receipt": solid, "native_solidity_block": block, "native_fee_sun": solid["fee"]})
        return result

    def dispatches(self, chain):
        normalized = dict(chain)
        for key in ("mailbox", "merkletreehook", "interchaingaspaymaster", "validatorannounce"):
            normalized[key] = tron_address(chain[key])
        return super().dispatches(normalized)

    def delivered(self, mailbox, message_id):
        return super().delivered(tron_address(mailbox), message_id)

    def verify_signed_operation(self, operation, message, origin_chain, destination_chain, expected_sender, canonical_proof):
        identity = message["delivery_transaction"]
        require(operation.get("kind") == "process" and operation.get("target") is None and operation.get("stage") == "delivered" and operation.get("confirmation_started") is True, "native operation not durably self-delivered")
        require(operation.get("origin") == message["origin"] and operation.get("destination") == message["destination"] and operation.get("nonce") == message["nonce"], "native operation message authority differs")
        require(operation.get("identity") == {"kind": "hash256", "hex": identity}, "full native transaction identity differs")
        authority = operation.get("authority")
        padded = lambda value: "0x" + (bytes(12) + hex_bytes(tron_address(value), 20)).hex()
        require(isinstance(authority, dict) and authority == {"protocol": "tron", "origin": message["origin"], "destination": message["destination"], "mailbox": padded(destination_chain["mailbox"]), "chain_id": str(destination_chain["chainid"]), "origin_hook": padded(origin_chain["merkletreehook"]), "operation_id": message["id"], "generation": operation["generation"], "kind": "process", "target": None}, "native prepared authority differs from actual deployed case")
        transaction = self.native(self.solidity, "gettransactionbyid", {"value": identity[2:]})
        require(isinstance(transaction, dict) and transaction.get("txID", "").lower() == identity[2:], "actual native signed transaction absent")
        raw = hex_bytes("0x" + transaction["raw_data_hex"].removeprefix("0x"))
        require(hashlib.sha256(raw).hexdigest() == identity[2:], "actual native raw_data hash differs")
        signatures = transaction.get("signature")
        require(isinstance(signatures, list) and len(signatures) == 1, "actual native signature tuple differs")
        signature = hex_bytes("0x" + signatures[0].removeprefix("0x"), 65)
        signer = recover_signature(identity, {"r": "0x" + signature[:32].hex(), "s": "0x" + signature[32:64].hex(), "v": signature[64]}, self.keccak)
        trigger = native_trigger(raw)
        require(signer == trigger["owner"] == tron_address(expected_sender), "actual native SDK signature/owner differs from configured public signer")
        require(trigger["target"] == tron_address(destination_chain["mailbox"]), "actual native signed process target differs")
        compat = canonical_proof["transaction"]
        require(tron_address(compat["to"]) == trigger["target"] and tron_address(compat["from"]) == signer and hex_bytes(compat["input"]) == trigger["calldata"], "native JSONRPC/wallet signed transaction authority differs")
        wire = process_message(trigger["calldata"], self.keccak("process(bytes,bytes)")[:10])
        require(wire == hex_bytes(message["wire"]) and self.keccak("0x" + wire.hex()) == message["id"], "actual native signed process message differs")
        signed = b"\x0a" + varint(len(raw)) + raw + b"\x12\x41" + signature
        require(operation.get("signed") == {"bytes": len(signed), "sha256": "0x" + hashlib.sha256(signed).hexdigest()}, "actual native signed wire differs from stopped signed journal bytes")
        expenditure = operation.get("expenditure")
        require(isinstance(expenditure, dict) and expenditure.get("present") is True, "actual native expenditure marker absent")
        gas = int.from_bytes(hex_bytes(expenditure["gas_used_hex"], 32), "big")
        tokens = int.from_bytes(hex_bytes(expenditure["tokens_used_hex"], 32), "big")
        require(gas > 0 and tokens > 0 and canonical_proof["native_fee_sun"] > 0, "actual native fee/recorded expenditure unavailable")
        require(gas == canonical_proof["gas_used"] and tokens == canonical_proof["tokens_used"], "actual native Source energy/price expenditure differs from canonical receipt")
        return {"identity": identity, "signer": signer, "target": trigger["target"], "actual_sdk_signed_wire": operation["signed"], "actual_native_fee_sun": canonical_proof["native_fee_sun"], "recorded_gas_used": gas, "recorded_tokens_used": tokens, "accounting_scope": "Source records JSONRPC energy_used*effectiveGasPrice; wallet/solidity total network fee is corroborated separately, without conflating bandwidth/resource fees.", "context": operation["context"], "expected_context_checked": operation["expected_context_checked"], "configuration_context_qualification": "First observed context, not independent recomputation; public authority and actual native signed transaction verified separately."}
