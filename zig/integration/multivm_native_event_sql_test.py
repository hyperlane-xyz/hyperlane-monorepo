"""Pure canonical-event predicates; SQLite bytea shim, no node/SDK/process."""
import contextlib
import copy
import hashlib
import json
import pathlib
import sqlite3
import unittest
from unittest import mock

import multivm_evm as evm
import multivm_tron as tron
import multivm_sealevel as svm
from multivm_session import Session


def digest(value):
    raw = bytes.fromhex(value[2:]) if value.startswith("0x") else value.encode()
    return "0x" + hashlib.sha256(raw).hexdigest()


def word(number):
    return number.to_bytes(32, "big")


# This is an independent schema fixture for the exact new predicates only.
# Existing aggregate/value predicates are separately covered and return their
# expected aggregate fixture rows below; no PostgreSQL acceptance is claimed.
SPECS = {
    "dispatch": ("confirmed_raw_message_dispatch", "origin_domain", "msg_id", "origin_block_hash", "origin_block_height", "origin_tx_hash", "origin_mailbox"),
    "insertion": ("confirmed_merkle_tree_insertion", "domain", "message_id", "block_hash", "block_number", "transaction_hash", "merkle_tree_hook"),
    "payment": ("confirmed_gas_payment", "domain", "msg_id", "block_hash", "block_number", "transaction_hash", "interchain_gas_paymaster"),
    "delivery": ("confirmed_delivered_message", "domain", "msg_id", "block_hash", "block_number", "transaction_hash", "destination_mailbox"),
}


def database(snapshot):
    db = sqlite3.connect(":memory:")
    db.create_function("decode", 2, lambda value, encoding: bytes.fromhex(value) if encoding == "hex" else None)
    db.execute('CREATE TABLE block(id integer,domain integer,hash blob,height integer)')
    db.execute('CREATE TABLE "transaction"(hash blob,block_id integer)')
    for table, domain, identity, block, height, tx, emitter in SPECS.values():
        db.execute(f'CREATE TABLE {table}({domain} integer,{identity} blob,{block} blob,{height} integer,{tx} blob,transaction_index integer,log_index integer,{emitter} blob)')
    transactions = {}
    for message in snapshot["messages"]:
        for kind, rows in message["event_metadata"].items():
            for row in rows:
                transaction = bytes.fromhex(row["transaction_hash"][2:])
                if len(transaction) == 64 and transaction[:32] == bytes(32): transaction = transaction[32:]
                identity = row["domain"], transaction
                if identity not in transactions:
                    block_id = len(transactions) + 1
                    transactions[identity] = block_id
                    domain = row["domain"] if row["domain"] < 2 ** 31 else row["domain"] - 2 ** 32
                    db.execute('INSERT INTO block VALUES(?,?,?,?)', (block_id, domain, bytes.fromhex(row["block_hash"][2:]), row["block_number"]))
                    db.execute('INSERT INTO "transaction" VALUES(?,?)', (transaction, block_id))
                table = SPECS[kind][0]
                emitter = bytes.fromhex(row["emitter"][2:])
                if emitter[:12] == bytes(12): emitter = emitter[12:]
                db.execute(f'INSERT INTO {table} VALUES(?,?,?,?,?,?,?,?)', (row["domain"], bytes.fromhex(message["id"][2:]), bytes.fromhex(row["block_hash"][2:]), row["block_number"], transaction, row["transaction_index"], row["log_index"], emitter))
    return db


def evm_messages(native=False):
    """Actual ABI-shaped zero/double/failed-body receipt streams."""
    chain = {"name": "first", "domainid": 1, "mailbox": "0x" + "11" * 20, "merkletreehook": "0x" + "22" * 20, "interchaingaspaymaster": "0x" + "33" * 20, "validatorannounce": "0x" + "44" * 20}
    receipts, blocks, transactions, dispatches = {}, {}, {}, []
    def log(tx, block, height, position, emitter, topics, data):
        return {"address": emitter, "topics": topics, "data": "0x" + data.hex(), "transactionHash": tx, "transactionIndex": "0x0", "logIndex": hex(position), "blockNumber": hex(height), "blockHash": block, "removed": False}
    for nonce, leaves, body in [(0, [], b"zero"), (1, [0, 1], b"double"), (2, [2], b"failMessageBody")]:
        wire = b"\x03" + nonce.to_bytes(4, "big") + (1).to_bytes(4, "big") + bytes(32) + (2).to_bytes(4, "big") + bytes(32) + body
        identity = digest("0x" + wire.hex())
        tx, block = "0x" + bytes([nonce + 1] * 32).hex(), "0x" + bytes([nonce + 11] * 32).hex()
        height = 10 + nonce
        dispatch = log(tx, block, height, 3, chain["mailbox"], [digest("Dispatch(address,uint32,bytes32,bytes)"), "0x" + "00" * 32, "0x" + word(2).hex(), "0x" + "00" * 32], word(32) + word(len(wire)) + wire + bytes((-len(wire)) % 32))
        dispatches.append(dispatch)
        logs = [dispatch, log(tx, block, height, 4, chain["mailbox"], [digest("DispatchId(bytes32)"), identity], b"")]
        for index, leaf in enumerate(leaves): logs.append(log(tx, block, height, index + 5, chain["merkletreehook"], [digest("InsertedIntoTree(bytes32,uint32)")], bytes.fromhex(identity[2:]) + word(leaf)))
        logs.append(log(tx, block, height, 9, chain["interchaingaspaymaster"], [digest("GasPayment(bytes32,uint32,uint256,uint256)"), identity, "0x" + word(2).hex()], word(100) + word(50)))
        receipts[tx] = {"transactionHash": tx, "status": "0x1", "blockNumber": hex(height), "blockHash": block, "transactionIndex": "0x0", "logs": logs, "gasUsed": "0x10", "effectiveGasPrice": "0x2"}
        blocks[height] = {"number": hex(height), "hash": block, "transactions": [tx]}
        transactions[tx] = {"hash": tx, "blockHash": block, "blockNumber": hex(height), "transactionIndex": "0x0"}
    def call(method, params):
        if method == "eth_getLogs": return copy.deepcopy(dispatches)
        if method == "eth_getTransactionReceipt": return copy.deepcopy(receipts[params[0]])
        if method == "eth_getTransactionByHash": return copy.deepcopy(transactions[params[0]])
        if method == "eth_getBlockByNumber": return copy.deepcopy(blocks[int(params[0], 16)])
        if method == "eth_blockNumber": return "0x100"
        raise AssertionError(method)
    def wallet(endpoint, method, params):
        if method == "gettransactioninfobyid":
            receipt = receipts["0x" + params["value"]]
            return {"id": params["value"], "blockNumber": int(receipt["blockNumber"], 16), "receipt": {"result": "SUCCESS"}, "fee": 12}
        if method == "getblockbynum":
            block = blocks[params["num"]]
            return {"block_header": {"raw_data": {"number": params["num"]}}, "blockID": block["hash"][2:], "transactions": [{"txID": tx[2:], "ret": [{"contractRet": "SUCCESS"}]} for tx in block["transactions"]]}
        raise AssertionError(method)
    adapter = tron.TronEvidence({}, "unused", "unused-wallet", "unused-solidity", call=call, command=lambda _, value: digest(value), native=wallet) if native else evm.EvmEvidence({}, "unused", call=call, command=lambda _, value: digest(value), reorg_depth=2)
    messages = adapter.dispatches(chain)
    delivered = messages[1]
    delivery_log = log("0x" + "77" * 32, "0x" + "88" * 32, 20, 12, "0x" + "55" * 20, [digest("ProcessId(bytes32)"), delivered["id"]], b"")
    delivered.update(delivery_chain="second", delivery_transaction=delivery_log["transactionHash"])
    delivered["event_metadata"]["delivery"] = [evm.log_metadata("second", 2, delivery_log)]
    return {"messages": messages, "deliverable_messages": [delivered]}, chain


class EventSqlTests(unittest.TestCase):
    def test_actual_evm_and_tre_receipt_metadata_preserves_zero_double_and_failed_body_kinds(self):
        for native in (False, True):
            snapshot, _ = evm_messages(native)
            zero, double, failed = snapshot["messages"]
            self.assertEqual([len(row["event_metadata"]["insertion"]) for row in snapshot["messages"]], [0, 2, 1])
            self.assertEqual([row["log_index"] for row in double["event_metadata"]["insertion"]], [5, 6])
            self.assertEqual(failed["body"], "0x" + b"failMessageBody".hex())
            self.assertEqual(len(zero["event_metadata"]["payment"]), 1)
            self.assertEqual([len(row["event_metadata"]["delivery"]) for row in snapshot["messages"]], [0, 1, 0])

    def evm_sql(self, snapshot, db, native=False):
        session = Session.__new__(Session)
        session.manifest = {"scenario": "tron" if native else "evm"}
        session.family = None
        session.case = {"chain_names": ["first", "second"]}
        chains = {"first": {"domainid": 1}, "second": {"domainid": 2}}
        session.captures = [{"original": {"role": "scraper", "role_chain_names": list(chains), "db": "postgresql://public@127.0.0.1:5432/public"}}, {"original": {"role": "relayer", "chains": chains}}]
        def tool(manifest, name, args):
            self.assertEqual(name, "psql")
            query = args[-1]
            if "FROM message m" in query:
                message = next(row for row in snapshot["messages"] if row["id"][2:] in query)
                return f'1|{len(message["payments"])}|{sum(p["payment"] for p in message["payments"])}|{sum(p["gas_amount"] for p in message["payments"])}|'+','.join(str(i) for i in message["insertions"])
            if "FROM confirmed_delivered_message d " in query:
                return str(int(any(row["id"][2:] in query for row in snapshot["deliverable_messages"])))
            return str(db.execute(query).fetchone()[0])
        with mock.patch("multivm_session.run_tool", side_effect=tool): return session.postgres_proofs(snapshot)

    def test_evm_tre_actual_emitted_predicates_reject_wrong_positions_emitter_hash_and_height(self):
        for native in (False, True):
            snapshot, _ = evm_messages(native)
            with contextlib.closing(database(snapshot)) as db:
                self.assertEqual(len(self.evm_sql(snapshot, db, native)), 3)
                for kind, (table, domain, _, block, height, tx, emitter) in SPECS.items():
                    for column, wrong in [(domain, 999), (block, b"wrong"), (height, 999), (tx, b"wrong"), ("transaction_index", 999), ("log_index", 999), (emitter, b"wrong")]:
                        db.execute("SAVEPOINT mutation")
                        db.execute(f'UPDATE {table} SET {column}=?', (wrong,))
                        with self.subTest(native=native, kind=kind, column=column), self.assertRaisesRegex(ValueError, "canonical event coordinates"):
                            self.evm_sql(snapshot, db, native)
                        db.execute("ROLLBACK TO mutation");db.execute("RELEASE mutation")

    def test_svm_source_sequence_metadata_is_not_instruction_position_and_keeps_separate_payment_signature(self):
        fixture = json.loads((pathlib.Path(__file__).resolve().parents[1] / "src/altvm/fixtures/sdk.json").read_text())["sealevel"]
        gas = svm.decode_account(bytes.fromhex(fixture["gas_payment"]), "gas")
        delivery = svm.decode_account(bytes.fromhex(fixture["processed"]), "delivery")
        proof = {"block_hash": "0x" + "11" * 32, "slot": 10, "transaction_index": 3}
        gas_id, delivery_id = "0x" + "aa" * 64, "0x" + "bb" * 64
        gas_meta = svm.sequence_metadata("first", 13375, gas_id, proof, gas["sequence"], b"\x22" * 32)
        delivered_meta = svm.sequence_metadata("second", 13376, delivery_id, proof, delivery["sequence"], b"\x33" * 32)
        self.assertEqual(gas_meta["log_index"], gas["sequence"])
        self.assertEqual(delivered_meta["log_index"], delivery["sequence"])
        self.assertEqual(gas_meta["transaction_hash"], gas_id)
        self.assertEqual(delivered_meta["transaction_hash"], delivery_id)

    def test_svm_sql_uses_exact_sequence_positions_for_all_kinds_and_normalized_wrong_igp_payment(self):
        proof = {"block_hash": "0x" + "11" * 32, "slot": 10, "transaction_index": 3}
        identity = "0x" + "44" * 32
        for delivered in (False, True):
            message = {"id": identity, "nonce": 4, "body": "0x", "origin_chain": "first", "origin": 13375, "destination": 13376, "dispatch_transaction": "0x" + "aa" * 64, "insertions": [4], "payments": [{"gas_amount": 100, "payment": int(delivered), "transaction_hash": "0x" + "bb" * 64}]}
            metadata = {"dispatch": [svm.sequence_metadata("first", 13375, message["dispatch_transaction"], proof, 4, b"\x22" * 32)], "insertion": [svm.sequence_metadata("first", 13375, message["dispatch_transaction"], proof, 4, b"\x33" * 32)], "payment": [svm.sequence_metadata("first", 13375, message["payments"][0]["transaction_hash"], proof, 55, b"\x55" * 32)], "delivery": []}
            message["event_metadata"] = metadata
            if delivered:
                message["delivery_transaction"] = "0x" + "cc" * 64
                metadata["delivery"] = [svm.sequence_metadata("second", 13376, message["delivery_transaction"], proof, 11, b"\x66" * 32)]
            snapshot = {"messages": [message], "deliverable_messages": [message] if delivered else []}
            adapter = svm.Adapter({"scenario": "sealevel"}, {"domain_names": {"13375": "first", "13376": "second"}})
            with contextlib.closing(database(snapshot)) as db:
                class SessionFixture:
                    def query_sql(self, name, query):
                        if "FROM message m" in query: return "1"
                        if "FROM confirmed_gas_payment g " in query:
                            assert "g.payment=" + str(int(delivered)) in query
                            return "1"
                        if "SELECT string_agg" in query: return "4"
                        if "FROM confirmed_delivered_message d " in query: return str(int(delivered))
                        return str(db.execute(query).fetchone()[0])
                self.assertEqual(adapter.sql(SessionFixture(), snapshot)[0]["separate_payment_rows"], 1)
                for kind in ("dispatch", "insertion", "payment", "delivery"):
                    if not metadata[kind]: continue
                    table, domain, _, block, height, tx, emitter = SPECS[kind]
                    for column, wrong in [(domain, 1), (block, b"wrong"), (height, 20), (tx, b"wrong"), ("transaction_index", 0), ("log_index", 0), (emitter, b"wrong")]:
                        db.execute("SAVEPOINT mutation")
                        db.execute(f'UPDATE {table} SET {column}=?', (wrong,))
                        with self.subTest(delivered=delivered, kind=kind, column=column), self.assertRaisesRegex(ValueError, "canonical sequence event coordinates"):
                            adapter.sql(SessionFixture(), snapshot)
                        db.execute("ROLLBACK TO mutation");db.execute("RELEASE mutation")


if __name__ == "__main__":
    unittest.main()
