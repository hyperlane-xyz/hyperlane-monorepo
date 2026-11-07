"""Pure SQL predicate controls, zero PostgreSQL/native-node credit."""
import contextlib
import sqlite3
import unittest

import multivm_sql as sql


class Coordinates(unittest.TestCase):
    def test_actual_sql_predicates_reject_right_message_at_wrong_native_coordinates(self):
        # Execute the actual generated predicates with SQLite's relational
        # engine and a bytea decode shim. This is a pure verifier control;
        # PostgreSQL/native fixture execution remains a separate gate.
        identity = "0x" + "44" * 32
        proof = {"identity": "0x" + "55" * 32, "block_hash": "0x" + "66" * 32, "height": 10, "index": 2}
        meta = sql.event_metadata("first", 75898670, proof, {"event_index": 7, "emitter": "0x" + "00" * 12 + "11" * 20})
        specs = [
            ("dispatch", "confirmed_raw_message_dispatch", "origin_domain", "msg_id", "origin_block_hash", "origin_block_height", "origin_tx_hash", "origin_mailbox"),
            ("insertion", "confirmed_merkle_tree_insertion", "domain", "message_id", "block_hash", "block_number", "transaction_hash", "merkle_tree_hook"),
            ("payment", "confirmed_gas_payment", "domain", "msg_id", "block_hash", "block_number", "transaction_hash", "interchain_gas_paymaster"),
            ("delivery", "confirmed_delivered_message", "domain", "msg_id", "block_hash", "block_number", "transaction_hash", "destination_mailbox"),
        ]
        with contextlib.closing(sqlite3.connect(":memory:")) as db:
            db.create_function("decode", 2, lambda value, encoding: bytes.fromhex(value) if encoding == "hex" else None)
            db.execute('CREATE TABLE block(id integer,domain integer,hash blob,height integer)')
            db.execute('CREATE TABLE "transaction"(hash blob,block_id integer)')
            db.execute('INSERT INTO block VALUES(1,?,?,10)', (meta["domain"], bytes.fromhex(proof["block_hash"][2:])))
            db.execute('INSERT INTO "transaction" VALUES(?,1)', (bytes.fromhex(proof["identity"][2:]),))
            for kind, table, domain, id_col, block, height, tx, emitter in specs:
                db.execute(f'CREATE TABLE {table}({domain} integer,{id_col} blob,{block} blob,{height} integer,{tx} blob,transaction_index integer,log_index integer,{emitter} blob)')
                db.execute(f'INSERT INTO {table} VALUES(?,?,?,?,?,?,?,?)', (meta["domain"], bytes.fromhex(identity[2:]), bytes.fromhex(proof["block_hash"][2:]), 10, bytes.fromhex(proof["identity"][2:]), 2, 7, b"\x11" * 20))
                query = sql.sql_event_query(kind, identity, meta)
                self.assertEqual(db.execute(query).fetchone(), (1,))
                for column, wrong in [("transaction_index", 3), ("log_index", 8), (height, 11), (block, b"wrong"), (tx, b"wrong"), (emitter, b"wrong"), (domain, 1)]:
                    db.execute("SAVEPOINT mutation")
                    db.execute(f'UPDATE {table} SET {column}=?', (wrong,))
                    self.assertEqual(db.execute(query).fetchone(), (0,), (kind, column))
                    db.execute("ROLLBACK TO mutation"); db.execute("RELEASE mutation")
                db.execute("SAVEPOINT bad_block")
                db.execute('UPDATE block SET hash=?', (b"wrong",))
                self.assertEqual(db.execute(query).fetchone(), (0,))
                db.execute("ROLLBACK TO bad_block"); db.execute("RELEASE bad_block")
        for field, value in [("transaction_index", -1), ("log_index", "7;DELETE"), ("block_hash", "0x12"), ("domain", True)]:
            with self.assertRaises(ValueError): sql.sql_event_query("dispatch", identity, dict(meta, **{field: value}))


    def test_actual_storage_transaction_width_and_signed_domain_codecs(self):
        proof = {"identity": "0x" + "55" * 32, "block_hash": "0x" + "66" * 32, "height": 10, "index": 2}
        meta = sql.event_metadata("first", 3999999998, proof, {"event_index": 7, "emitter": "0x" + "11" * 32})
        identity = "0x" + "44" * 32
        for raw, stored in [("55" * 32, "55" * 32), ("00" * 32 + "55" * 32, "55" * 32), ("aa" * 32 + "bb" * 32, "aa" * 32 + "bb" * 32)]:
            query = sql.sql_event_query("delivery", identity, dict(meta, transaction_hash="0x" + raw))
            self.assertIn("decode('" + stored + "','hex')", query)
            self.assertIn('e.domain=-294967298', query)
        for raw in ["0x", "0x12", "0x" + "aa" * 63, "0x" + "aa" * 65, "0x';DELETE"]:
            with self.assertRaises(ValueError): sql.sql_event_query("delivery", identity, dict(meta, transaction_hash=raw))
        for value in [True, -1, 2 ** 32, "01", "1;DELETE"]:
            with self.assertRaises(ValueError): sql.event_metadata("first", value, proof, {"event_index": 7, "emitter": "0x" + "11" * 32})
        # Radix uses its absolute u64 state version as transaction_index.
        # Other native collectors independently bind indices within their block.
        large = sql.event_metadata("first", 1, dict(proof, index=2 ** 32 + 7), {"event_index": 7, "emitter": "0x" + "11" * 32})
        self.assertIn('e.transaction_index=4294967303', sql.sql_event_query("delivery", identity, large))
        with self.assertRaises(ValueError): sql.sql_event_query("delivery", identity, dict(large, transaction_index=2 ** 64))


if __name__ == "__main__":
    unittest.main()
