"""Real EVM receipt/dispatch evidence; no network or tool execution on import."""
from __future__ import annotations

from multivm_evidence import hex_bytes, message_wire, require, rpc, run_tool
from multivm_sql import event_metadata


def quantity(value):
    require(isinstance(value, str) and value.startswith("0x") and len(value) > 2, "native quantity missing")
    result = int(value, 16)
    require(result >= 0, "negative native quantity")
    return result


def address(value):
    raw = hex_bytes(value)
    if len(raw) == 32:
        require(raw[:12] == bytes(12), "non-EVM high address bytes")
        raw = raw[12:]
    require(len(raw) == 20, "EVM address width differs")
    return "0x" + raw.hex()


def log_metadata(chain, domain, log):
    return event_metadata(chain, domain, {"identity": "0x" + hex_bytes(log["transactionHash"], 32).hex(), "block_hash": "0x" + hex_bytes(log["blockHash"], 32).hex(), "height": quantity(log["blockNumber"]), "index": quantity(log["transactionIndex"])}, {"event_index": quantity(log["logIndex"]), "emitter": "0x" + (bytes(12) + hex_bytes(address(log["address"]), 20)).hex()})


def decode_dispatch(log, keccak):
    """Decode the exact indexed IMailbox.Dispatch ABI, with no guessed offsets."""
    topics = log["topics"]
    require(len(topics) == 4, "Dispatch indexed topics differ")
    data = hex_bytes(log["data"])
    require(len(data) >= 64 and int.from_bytes(data[:32], "big") == 32, "Dispatch dynamic offset differs")
    size = int.from_bytes(data[32:64], "big")
    require(len(data) == 64 + ((size + 31) // 32) * 32 and not any(data[64 + size:]), "Dispatch ABI length/padding differs")
    wire = message_wire("0x" + data[64:64 + size].hex(), keccak)
    require(hex_bytes(topics[1], 32) == hex_bytes(wire["sender"], 32), "Dispatch sender differs from wire")
    require(int.from_bytes(hex_bytes(topics[2], 32), "big") == wire["destination"], "Dispatch destination differs from wire")
    require(hex_bytes(topics[3], 32) == hex_bytes(wire["recipient"], 32), "Dispatch recipient differs from wire")
    return wire


class EvmEvidence:
    def __init__(self, manifest, endpoint, *, call=None, command=None, reorg_depth=0):
        require(type(reorg_depth) is int and reorg_depth >= 0, "invalid configured EVM finality depth")
        self.reorg_depth = reorg_depth
        self.manifest = manifest
        self.endpoint = endpoint
        self.call = call or (lambda method, params: rpc(endpoint, method, params))
        self.command = command or (lambda *args: run_tool(manifest, "cast", args))
        self.topics = {}

    def keccak(self, value):
        result = self.command("keccak", value).lower()
        hex_bytes(result, 32)
        return result

    def topic(self, signature):
        if signature not in self.topics:
            self.topics[signature] = self.keccak(signature)
        return self.topics[signature]

    def canonical_receipt(self, transaction_hash, *, mailbox=None, expected_ids=None):
        tx_hash = "0x" + hex_bytes(transaction_hash, 32).hex()
        receipt = self.call("eth_getTransactionReceipt", [tx_hash])
        require(isinstance(receipt, dict) and receipt.get("transactionHash", "").lower() == tx_hash, "actual native receipt absent/different")
        require(quantity(receipt.get("status")) == 1, "native transaction reverted")
        number = quantity(receipt["blockNumber"])
        if self.reorg_depth is not None:
            tip = quantity(self.call("eth_blockNumber", []))
            require(number <= max(0, tip - self.reorg_depth), "EVM receipt not at configured finality depth")
        block = self.call("eth_getBlockByNumber", [hex(number), False])
        require(isinstance(block, dict) and quantity(block["number"]) == number and block["hash"].lower() == receipt["blockHash"].lower(), "receipt is not canonical by NUMBER")
        index = quantity(receipt["transactionIndex"])
        require(index < len(block["transactions"]) and block["transactions"][index].lower() == tx_hash, "canonical transaction membership differs")
        transaction = self.call("eth_getTransactionByHash", [tx_hash])
        require(isinstance(transaction, dict) and transaction["hash"].lower() == tx_hash and transaction["blockHash"].lower() == block["hash"].lower() and quantity(transaction["blockNumber"]) == number and quantity(transaction["transactionIndex"]) == index, "native transaction provenance differs")
        logs = receipt.get("logs")
        require(isinstance(logs, list), "native receipt logs absent")
        positions = set()
        for log in logs:
            position = quantity(log["logIndex"])
            require(position not in positions, "duplicate receipt log position")
            positions.add(position)
            require(log.get("removed", False) is False and log["transactionHash"].lower() == tx_hash and quantity(log["transactionIndex"]) == index and quantity(log["blockNumber"]) == number and log["blockHash"].lower() == block["hash"].lower(), "receipt log provenance differs")
        ids = []
        if mailbox is not None:
            mailbox = address(mailbox)
            process = self.topic("ProcessId(bytes32)")
            ids = ["0x" + hex_bytes(log["topics"][1], 32).hex() for log in logs if address(log["address"]) == mailbox and len(log["topics"]) == 2 and log["topics"][0].lower() == process]
            require(len(ids) == len(set(ids)), "duplicate native ProcessId")
            if expected_ids is not None:
                require(set(ids) == set(expected_ids), "native ProcessId membership differs")
        gas = quantity(receipt["gasUsed"])
        price = quantity(receipt["effectiveGasPrice"])
        require(gas > 0 and price > 0, "actual positive native fee unavailable")
        after = self.call("eth_getBlockByNumber", [hex(number), False])
        require(isinstance(after, dict) and quantity(after["number"]) == number and after["hash"].lower() == block["hash"].lower() and after["transactions"] == block["transactions"], "EVM canonical header changed during receipt verification")
        return {"receipt": receipt, "block": block, "transaction": transaction, "message_ids": ids, "gas_used": gas, "gas_price": price, "tokens_used": gas * price}

    def dispatches(self, chain):
        mailbox = address(chain["mailbox"])
        domain = int(chain["domainid"])
        signature = self.topic("Dispatch(address,uint32,bytes32,bytes)")
        rows = self.call("eth_getLogs", [{"address": mailbox, "fromBlock": hex(int(chain.get("index", {}).get("from", 0))), "toBlock": "latest", "topics": [signature]}])
        require(isinstance(rows, list), "actual dispatch range result missing")
        result, seen = [], set()
        receipts = {}
        for log in rows:
            require(address(log["address"]) == mailbox and log["topics"][0].lower() == signature, "dispatch range emitter differs")
            message = decode_dispatch(log, self.keccak)
            require(message["origin"] == domain and message["id"] not in seen, "duplicate/wrong-origin actual dispatch")
            seen.add(message["id"])
            tx_hash = log["transactionHash"].lower()
            if tx_hash not in receipts:
                receipts[tx_hash] = self.canonical_receipt(tx_hash)
            native = receipts[tx_hash]
            matches = [item for item in native["receipt"]["logs"] if quantity(item["logIndex"]) == quantity(log["logIndex"])]
            require(len(matches) == 1 and matches[0] == log, "dispatch range row differs from actual canonical receipt")
            dispatch_id = self.topic("DispatchId(bytes32)")
            require(any(address(item["address"]) == mailbox and [topic.lower() for topic in item["topics"]] == [dispatch_id, message["id"]] for item in native["receipt"]["logs"]), "canonical DispatchId missing")
            insertion_topic = self.topic("InsertedIntoTree(bytes32,uint32)")
            gas_topic = self.topic("GasPayment(bytes32,uint32,uint256,uint256)")
            insertions, payments = [], []
            metadata = {"dispatch": [log_metadata(chain["name"], domain, log)], "insertion": [], "payment": [], "delivery": []}
            for item in native["receipt"]["logs"]:
                if address(item["address"]) == address(chain["merkletreehook"]) and item["topics"] and item["topics"][0].lower() == insertion_topic:
                    data = hex_bytes(item["data"], 64)
                    if data[:32] == hex_bytes(message["id"], 32):
                        insertions.append(int.from_bytes(data[32:], "big"))
                        metadata["insertion"].append(log_metadata(chain["name"], domain, item))
                if address(item["address"]) == address(chain["interchaingaspaymaster"]) and len(item["topics"]) == 3 and item["topics"][0].lower() == gas_topic and item["topics"][1].lower() == message["id"]:
                    data = hex_bytes(item["data"], 64)
                    require(int.from_bytes(hex_bytes(item["topics"][2], 32), "big") == message["destination"], "canonical gas payment destination differs")
                    payments.append({"gas_amount": int.from_bytes(data[:32], "big"), "payment": int.from_bytes(data[32:], "big")})
                    metadata["payment"].append(log_metadata(chain["name"], domain, item))
            message.update({"origin_chain": chain["name"], "dispatch_transaction": tx_hash, "dispatch_block": quantity(log["blockNumber"]), "dispatch_log_index": quantity(log["logIndex"]), "event_metadata": metadata, "insertions": insertions, "payments": payments})
            result.append(message)
        return sorted(result, key=lambda row: row["nonce"])

    def delivered(self, mailbox, message_id):
        selector = self.keccak("delivered(bytes32)")[:10]
        value = self.call("eth_call", [{"to": address(mailbox), "data": selector + hex_bytes(message_id, 32).hex()}, "latest"])
        raw = hex_bytes(value, 32)
        require(int.from_bytes(raw, "big") in (0, 1), "noncanonical delivered boolean")
        return raw[-1] == 1


SECP_P = int("ffffffffffffffffffffffffffffffff" + "fffffffffffffffffffffffefffffc2f", 16)
SECP_N = int("fffffffffffffffffffffffffffffffe" + "baaedce6af48a03bbfd25e8cd0364141", 16)
SECP_G = (int("79be667ef9dcbbac55a06295ce870b070" + "29bfcdb2dce28d959f2815b16f81798", 16), int("483ada7726a3c4655da4fbfc0e1108a8f" + "d17b448a68554199c47d08ffb10d4b8", 16))


def point_add(first, second):
    if first is None:
        return second
    if second is None:
        return first
    x, y = first
    u, v = second
    if x == u and (y + v) % SECP_P == 0:
        return None
    slope = ((3 * x * x) * pow(2 * y, -1, SECP_P) if first == second else (v - y) * pow(u - x, -1, SECP_P)) % SECP_P
    result_x = (slope * slope - x - u) % SECP_P
    return result_x, (slope * (x - result_x) - y) % SECP_P


def point_multiply(scalar, point):
    require(scalar >= 0, "negative curve scalar")
    result = None
    while scalar:
        if scalar & 1:
            result = point_add(result, point)
        point = point_add(point, point)
        scalar >>= 1
    return result


def recover_signature(digest, signature, keccak):
    """Independent ECDSA recovery against actual object bytes; no signer calls."""
    def integer(value):
        require(type(value) is int or isinstance(value, str), "invalid signature scalar")
        return int(value, 0) if isinstance(value, str) else value
    r, s, v = (integer(signature[key]) for key in ("r", "s", "v"))
    require(0 < r < SECP_N and 0 < s < SECP_N and v in (0, 1, 27, 28), "invalid checkpoint ECDSA scalar/recovery id")
    parity = v - 27 if v >= 27 else v
    alpha = (r * r * r + 7) % SECP_P
    y = pow(alpha, (SECP_P + 1) // 4, SECP_P)
    require(y * y % SECP_P == alpha, "signature recovery point is not on curve")
    if y & 1 != parity:
        y = SECP_P - y
    recovery = (r, y)
    require(point_multiply(SECP_N, recovery) is None, "signature recovery point order differs")
    z = int.from_bytes(hex_bytes(digest, 32), "big")
    public = point_multiply(pow(r, -1, SECP_N), point_add(point_multiply(s, recovery), point_multiply((-z) % SECP_N, SECP_G)))
    require(public is not None, "checkpoint recovery produced infinity")
    encoded = "0x" + public[0].to_bytes(32, "big").hex() + public[1].to_bytes(32, "big").hex()
    return "0x" + hex_bytes(keccak(encoded), 32)[12:].hex()


def checkpoint_digest(checkpoint, message_id, keccak):
    hook = hex_bytes(checkpoint["merkle_tree_hook_address"], 32)
    domain, index = checkpoint["mailbox_domain"], checkpoint["index"]
    require(type(domain) is int and 0 <= domain < 2 ** 32 and type(index) is int and 0 <= index < 2 ** 32, "checkpoint domain/index differs")
    domain_hash = keccak("0x" + (domain.to_bytes(4, "big") + hook + b"HYPERLANE").hex())
    signing = keccak("0x" + (hex_bytes(domain_hash, 32) + hex_bytes(checkpoint["root"], 32) + index.to_bytes(4, "big") + hex_bytes(message_id, 32)).hex())
    return keccak("0x" + (b"\x19Ethereum Signed Message:\n32" + hex_bytes(signing, 32)).hex())


def merkle_roots(messages, keccak):
    """Independent depth32 frontier over exact canonical InsertedIntoTree order."""
    zero = [bytes(32)]
    for _ in range(32):
        zero.append(hex_bytes(keccak("0x" + (zero[-1] * 2).hex()), 32))
    leaves = []
    for message in messages:
        leaves.extend((index, message["id"]) for index in message["insertions"])
    leaves.sort()
    require([index for index, _ in leaves] == list(range(len(leaves))), "canonical insertion stream has gap/duplicate")
    frontier, roots = [bytes(32)] * 32, []
    for index, message_id in leaves:
        node = hex_bytes(message_id, 32)
        size = index
        for level in range(32):
            if size & 1:
                node = hex_bytes(keccak("0x" + (frontier[level] + node).hex()), 32)
            else:
                frontier[level] = node
                node = hex_bytes(keccak("0x" + (node + zero[level]).hex()), 32)
            size >>= 1
        roots.append({"index": index, "message_id": message_id, "root": "0x" + node.hex()})
    return roots


def verify_checkpoint_objects(directory, chain, validator_address, messages, keccak, *, git_sha, configured_rpc_urls, allows_public_rpcs, hook_hash=None):
    """Read real published objects and independently authenticate every leaf."""
    import json
    import pathlib
    root = pathlib.Path(directory)
    require(root.is_dir() and not root.is_symlink(), "actual checkpoint directory missing")
    metadata_path = root / "metadata_latest.json"
    require(metadata_path.is_file() and not metadata_path.is_symlink(), "actual validator metadata missing")
    metadata = json.loads(metadata_path.read_text())
    import urllib.parse
    expected_rpcs = [{"url_hash": keccak(url), "host_hash": keccak(urllib.parse.urlsplit(url).hostname)} for url in configured_rpc_urls]
    require(metadata == {"git_sha": git_sha, "rpcs": expected_rpcs, "allows_public_rpcs": allows_public_rpcs}, "actual ValidatorMetadata producer differs")
    expected = merkle_roots(messages, keccak)
    require(expected, "actual merkle stream empty")
    verified = []
    raw_hook = hex_bytes(hook_hash if hook_hash is not None else chain["merkletreehook"])
    if len(raw_hook) == 20:
        raw_hook = bytes(12) + raw_hook
    require(len(raw_hook) == 32, "canonical native hook must be32 bytes (or original EVM20)")
    hook = "0x" + raw_hook.hex()
    # Source starts additional validators after dispatches. Their bootstrap may
    # begin at a later index: authenticate every actual published object and
    # require the actual final checkpoint, without inventing earlier signatures.
    paths = list(root.glob("*_with_id.json"))
    require(paths and (root / f'{expected[-1]["index"]}_with_id.json').is_file(), "actual final checkpoint missing")
    for path in paths:
        require(path.is_file() and not path.is_symlink(), "actual checkpoint object missing")
        index_text = path.name.removesuffix("_with_id.json")
        require(index_text.isdigit() and str(int(index_text)) == index_text, "unexpected checkpoint filename")
        index = int(index_text)
        require(index < len(expected), "checkpoint beyond actual native insertion stream")
        row = expected[index]
        obj = json.loads(path.read_text())
        value = obj["value"]
        checkpoint = value["checkpoint"]
        require(checkpoint == {"merkle_tree_hook_address": hook, "mailbox_domain": int(chain["domainid"]), "root": row["root"], "index": row["index"]} and value["message_id"].lower() == row["message_id"], "published checkpoint differs from native canonical leaves")
        recovered = recover_signature(checkpoint_digest(checkpoint, value["message_id"], keccak), obj["signature"], keccak)
        require(recovered == address(validator_address), "published checkpoint signer differs")
        verified.append({"path": str(path), "index": row["index"], "root": row["root"], "message_id": row["message_id"], "signer": recovered})
    return {"metadata": metadata, "verified_checkpoint_objects": verified}


def chunks_hex(value, count):
    require(isinstance(value, list) and all(isinstance(part, str) for part in value), "Rust reader byte chunks missing")
    text = "".join(value)
    return "0x" + hex_bytes("0x" + text.removeprefix("0x"), count).hex()


def process_wire(calldata, selector):
    raw = hex_bytes(calldata) if isinstance(calldata, str) else calldata
    require(raw[:4] == hex_bytes(selector, 4) and len(raw) >= 68, "actual EVM call is not Mailbox.process")
    data = raw[4:]
    values, cursor = [], 64
    for head in (0, 32):
        offset = int.from_bytes(data[head:head + 32], "big")
        require(offset == cursor and offset + 32 <= len(data), "actual EVM process offsets overlap/gap")
        size = int.from_bytes(data[offset:offset + 32], "big")
        cursor = offset + 32 + ((size + 31) // 32) * 32
        require(cursor <= len(data) and not any(data[offset + 32 + size:cursor]), "actual EVM process bounds/padding differ")
        values.append(data[offset + 32:offset + 32 + size])
    require(cursor == len(data), "actual EVM process trailing bytes")
    return values[1]


def aggregate_calls(calldata):
    raw = hex_bytes(calldata)
    require(raw[:4] == bytes.fromhex("82ad56cb"), "actual EVM batch is not aggregate3")
    data = raw[4:]
    require(len(data) >= 64 and int.from_bytes(data[:32], "big") == 32, "actual EVM aggregate array offset differs")
    count = int.from_bytes(data[32:64], "big")
    require(1 <= count <= 1000 and 64 + count * 32 <= len(data), "actual EVM aggregate call count invalid")
    cursor, result = count * 32, []
    for index in range(count):
        require(int.from_bytes(data[64 + index * 32:96 + index * 32], "big") == cursor, "actual EVM aggregate tuple offsets overlap/gap")
        start = 64 + cursor
        require(start + 128 <= len(data) and data[start:start + 12] == bytes(12) and int.from_bytes(data[start + 32:start + 64], "big") == 1 and int.from_bytes(data[start + 64:start + 96], "big") == 96, "actual EVM aggregate tuple authority/allowFailure differs")
        size = int.from_bytes(data[start + 96:start + 128], "big")
        end = start + 128 + ((size + 31) // 32) * 32
        require(end <= len(data) and not any(data[start + 128 + size:end]), "actual EVM aggregate calldata bounds/padding differ")
        result.append({"to": "0x" + data[start + 12:start + 32].hex(), "data": "0x" + data[start + 128:start + 128 + size].hex()})
        cursor = end - 64
    require(cursor + 64 == len(data), "actual EVM aggregate trailing bytes")
    return result


def verify_evm_accounting(snapshot, probes, estimates, broadcasts, chains, keccak, expected_payers):
    """Bind stopped canonical spend to actual prebroadcast prepare and receipt.

    Source EVM runs quorum peers, so identical successful physical prepare reads
    may repeat. Every eligible matching read must agree with the sealed weight;
    Lander's five-field estimate and postbroadcast reads never select a weight.
    """
    messages = {row["id"]: row for row in snapshot["deliverable_messages"]}
    rows, links = {}, {}
    for probe in probes:
        for row in probe["messages"]:
            identity = chunks_hex(row["id_chunks"], 32)
            require(identity not in rows, "duplicate actual canonical accounting message")
            rows[identity] = row
        for row in probe["sealed_payload_links"]:
            identity = chunks_hex(row["message_id_chunks"], 32)
            require(identity not in links, "duplicate actual sealed original estimate")
            links[identity] = row
    selector, output = keccak("process(bytes,bytes)")[:10], []
    for transaction in snapshot["native_delivery_transactions"]:
        chain, identity, proof = transaction["chain"], transaction["transaction_hash"], transaction["proof"]
        native = proof["transaction"]
        expected_payer = address(expected_payers[chain])
        require(address(native["from"]) == expected_payer, "actual EVM transaction payer differs from reviewed Source signer")
        mailbox = address(chains[chain]["mailbox"])
        if address(native["to"]) == mailbox:
            calls = [{"to": mailbox, "data": native["input"]}]
        else:
            require(address(native["to"]) == address(chains[chain]["batchcontractaddress"]), "actual EVM batch contract differs from configured Source")
            calls = aggregate_calls(native["input"])
            require(len(calls) <= int(chains[chain].get("maxbatchsize", 1)), "actual EVM configured batch limit exceeded")
        matching_sends = [row for row in broadcasts if row["chain"] == chain and row["transaction_hash"] == identity]
        require(matching_sends, "actual EVM broadcast request evidence missing")
        first_send = min(row["requested_monotonic_ns"] for row in matching_sends)
        require(type(first_send) is int and first_send > 0, "actual EVM broadcast request clock missing")
        members = []
        for call in calls:
            require(address(call["to"]) == mailbox, "actual EVM batch contains foreign target")
            wire = process_wire(call["data"], selector)
            message_id = keccak("0x" + wire.hex())
            require(message_id in messages and messages[message_id]["wire"] == "0x" + wire.hex() and messages[message_id]["delivery_chain"] == chain and messages[message_id]["delivery_transaction"] == identity, "actual EVM call/member differs from known native delivery")
            require(message_id in rows and message_id in links, "actual stopped EVM sealed/canonical accounting row missing")
            row, link = rows[message_id], links[message_id]
            require(link["message_source"] == "canonical" and link["canonical_nonce_message_present"] is True and link["canonical_nonce_matches_message"] is True and link["private_operation_stage"] == "delivered" and link["destination_payload_present"] is True and link["gas_expenditure_record_present"] is True, "actual EVM sealed/durable delivery provenance differs")
            weight_text = link.get("estimated_gas")
            require(type(weight_text) is str and 0 < len(weight_text) <= 78 and weight_text.isascii() and weight_text.isdecimal(), "actual sealed EVM original estimate must be an exact decimal string")
            weight = int(weight_text)
            require(str(weight) == weight_text and 0 < weight < 2 ** 256, "actual sealed EVM original estimate unavailable")
            candidates = []
            for estimate in estimates:
                params = estimate["params"]
                if estimate["chain"] != chain or len(params) != 1 or not isinstance(params[0], dict) or set(params[0]) != {"from", "to", "data"}:
                    continue
                request = params[0]
                if address(request["to"]) != mailbox or hex_bytes(request["data"]) != hex_bytes(call["data"]):
                    continue
                require(address(request["from"]) == expected_payer, "actual EVM prepare payer differs from reviewed Source signer")
                require(type(estimate["requested_monotonic_ns"]) is int and type(estimate["received_monotonic_ns"]) is int and estimate["requested_monotonic_ns"] <= estimate["received_monotonic_ns"], "actual EVM prepare estimate clock differs")
                if estimate["received_monotonic_ns"] < first_send:
                    require(quantity(estimate["result"]) == weight, "actual original prepare estimate differs from sealed weight")
                    candidates.append(estimate)
            require(candidates, "actual prebroadcast three-field prepare estimate missing")
            require(row["gas_expenditure_record_present"] is True and row["spent"] == link["spent"], "actual canonical/sealed EVM expenditure differs")
            members.append({"id": message_id, "weight": weight, "spent": row["spent"], "original_prepare_reads": candidates})
        require(len(members) == len({row["id"] for row in members}) and {row["id"] for row in members} == set(proof["message_ids"]), "actual EVM signed batch/receipt exact membership differs")
        total = sum(row["weight"] for row in members)
        require(total < 2 ** 256 and proof["gas_used"] * max(row["weight"] for row in members) < 2 ** 256, "fixture EVM allocation exceeds exact nonsaturating comparison scope")
        allocated = 0
        for row in members:
            gas = proof["gas_used"] * row["weight"] // total
            require(int(row["spent"]["gas_used"]) == gas and int(row["spent"]["tokens_used"]) == gas * proof["gas_price"], "actual EVM weighted receipt expenditure differs")
            allocated += gas
        dust = proof["gas_used"] - allocated
        require(0 <= dust < len(members), "actual EVM allocation dust differs")
        output.append({"chain": chain, "transaction_hash": identity, "members": members, "receipt_gas_used": proof["gas_used"], "effective_gas_price": proof["gas_price"], "unallocated_floor_dust": dust})
    require(sum(len(row["members"]) for row in output) == len(messages), "actual EVM accounting coverage differs")
    return output


def validate_expenditure_expectations(expectations, delivered_ids):
    require(isinstance(expectations, dict) and set(expectations) == set(delivered_ids), "Radix canonical expenditure expectations missing/foreign IDs")
    for expected in expectations.values():
        if expected is None:
            continue
        require(isinstance(expected, dict) and set(expected) == {"gas_used", "tokens_used"} and all(type(value) is int and 0 <= value < 2 ** 256 for value in expected.values()), "Radix canonical expenditure expectation is not exact uint256 values")


def verify_canonical_rocks(probe, chain, messages, delivered_ids, expenditure_expectations=None):
    """Validate the actual existing production Rust decoder's stopped DB scan."""
    require(probe.get("reader") == "actual production HyperlaneRocksDB + FullPayload decoder", "wrong canonical Rust reader")
    require(probe.get("origin_namespace") == chain["name"] and probe.get("origin_domain") == int(chain["domainid"]), "Rust origin namespace/domain differs")
    known = {message["nonce"]: message for message in messages}
    if expenditure_expectations is not None:
        require(chain.get("protocol") == "radix", "canonical expenditure override is Radix-only")
        validate_expenditure_expectations(expenditure_expectations, {message["id"] for message in messages if message["id"] in delivered_ids})
    require(len(known) == len(messages) and sorted(known) == list(range(len(messages))), "actual native dispatch nonce stream has gaps")
    require(probe.get("origin_nonce_count") == len(messages) and isinstance(probe.get("messages"), list) and len(probe["messages"]) == len(messages), "Rust canonical nonce coverage differs")
    # Insertion leaf index can differ from message nonce for zero/double hooks.
    leaves = {index: message["id"] for message in messages for index in message["insertions"]}
    seen, result = set(), []
    for row in probe["messages"]:
        nonce = row.get("nonce")
        require(type(nonce) is int and nonce in known and nonce not in seen, "duplicate/foreign Rust canonical nonce")
        seen.add(nonce)
        message = known[nonce]
        require(row.get("present") is True and chunks_hex(row.get("id_chunks"), 32) == message["id"], "Rust canonical message ID differs from native dispatch")
        require(row.get("origin") == message["origin"] and row.get("destination") == message["destination"], "Rust canonical message domains differ")
        expected_leaf = leaves.get(nonce)
        require((chunks_hex(row["insertion_id_chunks"], 32) if row.get("insertion_id_chunks") is not None else None) == expected_leaf, "Rust leaf-index read differs from actual canonical insertion stream")
        paid = message["payments"]
        payment = row.get("payment")
        if paid:
            require(isinstance(payment, dict) and int(payment["payment"]) == sum(item["payment"] for item in paid) and int(payment["gas_amount"]) == sum(item["gas_amount"] for item in paid), "Rust canonical IGP aggregate differs from actual receipt rows")
        else:
            require(payment is None, "Rust invented gas payment")
        delivered = message["id"] in delivered_ids
        processed = row.get("processed")
        require("processed" in row and (processed is None or type(processed) is bool), "Rust processed marker must be an explicit optional bool")
        require(processed is True if delivered else processed is None or processed is False, "Rust processed marker differs from actual native delivery")
        spent = row.get("spent")
        require(isinstance(spent, dict) and int(spent["gas_used"]) >= 0 and int(spent["tokens_used"]) >= 0, "Rust expenditure value missing")
        if delivered:
            if expenditure_expectations is None:
                require(row.get("gas_expenditure_record_present") is True and int(spent["gas_used"]) > 0 and int(spent["tokens_used"]) > 0, "actual self-delivery expenditure marker/value missing")
            else:
                expected = expenditure_expectations[message["id"]]
                if expected is None:
                    require(row.get("gas_expenditure_record_present") is False and int(spent["gas_used"]) == 0 and int(spent["tokens_used"]) == 0, "unknown actual Radix fee has fabricated canonical expenditure")
                else:
                    require(row.get("gas_expenditure_record_present") is True and all(int(spent[field]) == expected[field] for field in ("gas_used", "tokens_used")), "known actual Radix fee differs from canonical expenditure")
        result.append({"nonce": nonce, "id": message["id"], "processed": delivered, "payment": payment, "spent": spent, "gas_expenditure_record_present": row.get("gas_expenditure_record_present")})
    require(seen == set(known), "Rust nonce scan incomplete")
    return result


def sql_message_query(message):
    """Queries exact native identities and linked transaction rows, not totals."""
    identity = hex_bytes(message["id"], 32).hex()
    raw_origin_tx = hex_bytes(message["dispatch_transaction"])
    require(len(raw_origin_tx) in (32, 64), "full native dispatch transaction identity required")
    origin_tx = raw_origin_tx.hex()
    origin, destination, nonce = (message[key] for key in ("origin", "destination", "nonce"))
    require(all(type(value) is int and 0 <= value < 2 ** 32 for value in (origin, destination, nonce)), "unsafe SQL domain/nonce")
    body = hex_bytes(message["body"]).hex()
    return f'''SELECT
 (SELECT count(*) FROM message m JOIN raw_message_dispatch r ON r.msg_id=m.msg_id JOIN "transaction" t ON t.id=m.origin_tx_id AND t.hash=r.origin_tx_hash WHERE m.msg_id=decode('{identity}','hex') AND m.origin={origin} AND m.destination={destination} AND m.nonce={nonce} AND r.nonce={nonce} AND r.origin_domain={origin} AND r.destination_domain={destination} AND m.msg_body=r.msg_body AND m.msg_body=decode('{body}','hex') AND t.hash=decode('{origin_tx}','hex')),
 (SELECT count(*) FROM confirmed_gas_payment g JOIN "transaction" t ON t.id=g.tx_id AND t.hash=g.transaction_hash WHERE g.msg_id=decode('{identity}','hex') AND g.origin={origin} AND g.destination={destination} AND t.hash=decode('{origin_tx}','hex')),
 (SELECT coalesce(sum(g.payment),0) FROM confirmed_gas_payment g WHERE g.msg_id=decode('{identity}','hex') AND g.origin={origin} AND g.destination={destination}),
 (SELECT coalesce(sum(g.gas_amount),0) FROM confirmed_gas_payment g WHERE g.msg_id=decode('{identity}','hex') AND g.origin={origin} AND g.destination={destination}),
 (SELECT coalesce(string_agg(i.leaf_index::text,',' ORDER BY i.leaf_index),'') FROM confirmed_merkle_tree_insertion i WHERE i.message_id=decode('{identity}','hex') AND i.domain={origin})'''


def sql_delivery_query(message, delivery_transaction):
    identity = hex_bytes(message["id"], 32).hex()
    destination = message["destination"]
    require(type(destination) is int and 0 <= destination < 2 ** 32, "unsafe SQL destination")
    transaction_guard = ""
    if delivery_transaction is not None:
        raw_transaction = hex_bytes(delivery_transaction)
        require(len(raw_transaction) in (32, 64), "full native delivery transaction identity required")
        transaction = raw_transaction.hex()
        transaction_guard = f" AND t.hash=decode('{transaction}','hex')"
    return f'''SELECT count(*) FROM confirmed_delivered_message d JOIN "transaction" t ON t.id=d.destination_tx_id AND t.hash=d.transaction_hash WHERE d.msg_id=decode('{identity}','hex') AND d.domain={destination}{transaction_guard}'''


def verify_sql_message(output, delivery_output, message, *, delivered):
    fields = output.strip().split("|")
    require(len(fields) == 5, "actual psql linked-row shape differs")
    expected = [1, len(message["payments"]), sum(p["payment"] for p in message["payments"]), sum(p["gas_amount"] for p in message["payments"])]
    require([int(field) for field in fields[:4]] == expected and delivery_output == str(int(delivered)), "actual PostgreSQL dispatch/delivery/payment identity or values differ")
    require(fields[4] == ",".join(str(index) for index in sorted(message["insertions"])), "actual PostgreSQL insertion positions differ")
    return {"canonical_dispatch_rows": 1, "canonical_delivery_rows": int(delivered), "payment_rows": expected[1], "payment": expected[2], "gas_amount": expected[3], "leaf_indices": message["insertions"]}
