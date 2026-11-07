"""Exact canonical event coordinates in the existing scraper SQL schema.

Pure query construction; no database/network/process effects. Storage address,
transaction identity and signed-int4 codecs follow scraper_store.zig.
"""
import re

from multivm_evidence import hex_bytes, require


def uint(value, bits):
    require(type(value) is int or isinstance(value, str) and re.fullmatch(r"0|[1-9][0-9]*", value), "invalid native SQL integer")
    number = int(value)
    require(0 <= number < 2 ** bits, "native SQL integer overflow")
    return number


def event_metadata(chain, domain, proof, value):
    return {"chain": chain, "domain": uint(domain, 32), "transaction_hash": proof["identity"], "block_hash": proof["block_hash"], "block_number": uint(proof["height"], 64), "transaction_index": uint(proof["index"], 64), "log_index": uint(value["event_index"], 64), "emitter": value["emitter"]}


def sql_event_query(kind, identity, metadata):
    """Exact Source event coordinates, including its linked canonical block."""
    specs = {
        "dispatch": ("confirmed_raw_message_dispatch", "origin_domain", "msg_id", "origin_block_hash", "origin_block_height", "origin_tx_hash", "origin_mailbox"),
        "insertion": ("confirmed_merkle_tree_insertion", "domain", "message_id", "block_hash", "block_number", "transaction_hash", "merkle_tree_hook"),
        "payment": ("confirmed_gas_payment", "domain", "msg_id", "block_hash", "block_number", "transaction_hash", "interchain_gas_paymaster"),
        "delivery": ("confirmed_delivered_message", "domain", "msg_id", "block_hash", "block_number", "transaction_hash", "destination_mailbox"),
    }
    require(kind in specs, "unknown native SQL event kind")
    table, domain_column, id_column, block_column, height_column, tx_column, emitter_column = specs[kind]
    domain = uint(metadata["domain"], 32)
    signed_domain = domain if domain < 2 ** 31 else domain - 2 ** 32
    block = hex_bytes(metadata["block_hash"], 32).hex()
    raw_transaction = hex_bytes(metadata["transaction_hash"])
    require(len(raw_transaction) in (32, 64), "native SQL transaction identity width differs")
    # H256-in-H512 shrinks; a genuine nonzero-prefix native64 stays full width.
    if len(raw_transaction) == 64 and raw_transaction[:32] == b"\0" * 32:
        raw_transaction = raw_transaction[32:]
    transaction = raw_transaction.hex()
    identity = hex_bytes(identity, 32).hex()
    emitter = hex_bytes(metadata["emitter"], 32)
    # This matches the actual scraper addressBytes codec, not text/bech32 SQL.
    emitter = emitter[12:] if emitter[:12] == b"\0" * 12 else emitter
    height = uint(metadata["block_number"], 64)
    tx_index, log_index = uint(metadata["transaction_index"], 64), uint(metadata["log_index"], 64)
    return f'''SELECT count(*) FROM {table} e JOIN "transaction" t ON t.hash=e.{tx_column} JOIN block b ON b.id=t.block_id
 WHERE e.{domain_column}={signed_domain} AND e.{id_column}=decode('{identity}','hex')
 AND e.{block_column}=decode('{block}','hex') AND e.{height_column}={height}
 AND e.{tx_column}=decode('{transaction}','hex') AND e.transaction_index={tx_index} AND e.log_index={log_index}
 AND e.{emitter_column}=decode('{emitter.hex()}','hex') AND b.domain={signed_domain} AND b.hash=e.{block_column} AND b.height={height}'''

