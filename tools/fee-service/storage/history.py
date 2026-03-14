"""SQLite storage for historical data and snapshots."""

import json
import os
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path


DB_PATH = Path(__file__).parent.parent / "data" / "history.sqlite"


def get_db(db_path: str = None) -> sqlite3.Connection:
    """Get a database connection, creating tables if needed."""
    path = db_path or str(DB_PATH)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    _init_tables(conn)
    return conn


def _init_tables(conn: sqlite3.Connection):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp REAL NOT NULL,
            snapshot_type TEXT NOT NULL,
            data_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_snapshots_type_ts
            ON snapshots(snapshot_type, timestamp);

        CREATE TABLE IF NOT EXISTS gas_prices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp REAL NOT NULL,
            chain TEXT NOT NULL,
            gas_price_gwei REAL,
            gas_price_wei INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_gas_chain_ts
            ON gas_prices(chain, timestamp);

        CREATE TABLE IF NOT EXISTS token_prices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp REAL NOT NULL,
            token TEXT NOT NULL,
            price_usd REAL NOT NULL,
            source TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_token_ts
            ON token_prices(token, timestamp);

        CREATE TABLE IF NOT EXISTS competitor_quotes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp REAL NOT NULL,
            route_key TEXT NOT NULL,
            competitor TEXT NOT NULL,
            amount_usd REAL NOT NULL,
            fee_usd REAL,
            fee_bps REAL
        );
        CREATE INDEX IF NOT EXISTS idx_comp_route_ts
            ON competitor_quotes(route_key, timestamp);

        CREATE TABLE IF NOT EXISTS recommendations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp REAL NOT NULL,
            rec_type TEXT NOT NULL,
            route_key TEXT NOT NULL,
            recommended_value REAL,
            rationale TEXT,
            applied INTEGER DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_rec_type_ts
            ON recommendations(rec_type, timestamp);
    """)
    conn.commit()


def save_snapshot(snapshot_type: str, data: dict, db_path: str = None):
    """Save a full data snapshot."""
    conn = get_db(db_path)
    conn.execute(
        "INSERT INTO snapshots (timestamp, snapshot_type, data_json) VALUES (?, ?, ?)",
        (time.time(), snapshot_type, json.dumps(data)),
    )
    conn.commit()
    conn.close()


def save_gas_prices(gas_data: dict, db_path: str = None):
    """Save gas price readings."""
    conn = get_db(db_path)
    now = time.time()
    for chain, data in gas_data.items():
        if not isinstance(data, dict):
            continue
        conn.execute(
            "INSERT INTO gas_prices (timestamp, chain, gas_price_gwei, gas_price_wei) "
            "VALUES (?, ?, ?, ?)",
            (now, chain, data.get("gas_price_gwei"), data.get("gas_price_wei")),
        )
    conn.commit()
    conn.close()


def save_token_prices(token_prices: dict, db_path: str = None):
    """Save token price readings."""
    conn = get_db(db_path)
    now = time.time()
    for token, data in token_prices.items():
        if not isinstance(data, dict):
            continue
        conn.execute(
            "INSERT INTO token_prices (timestamp, token, price_usd, source) "
            "VALUES (?, ?, ?, ?)",
            (now, token, data.get("usd", 0), data.get("source", "")),
        )
    conn.commit()
    conn.close()


def save_competitor_quotes(quotes: dict, db_path: str = None):
    """Save competitor quote data."""
    conn = get_db(db_path)
    now = time.time()
    for route_key, competitors in quotes.items():
        for competitor, amounts in competitors.items():
            if not isinstance(amounts, dict):
                continue
            for amount_usd, quote in amounts.items():
                if not isinstance(quote, dict):
                    continue
                conn.execute(
                    "INSERT INTO competitor_quotes "
                    "(timestamp, route_key, competitor, amount_usd, fee_usd, fee_bps) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (now, route_key, competitor, amount_usd,
                     quote.get("fee_usd"), quote.get("fee_bps")),
                )
    conn.commit()
    conn.close()


def save_recommendations(recs: dict, rec_type: str, db_path: str = None):
    """Save fee recommendations."""
    conn = get_db(db_path)
    now = time.time()
    for route_key, rec in recs.items():
        if rec.get("error"):
            continue
        value = rec.get("recommended_bps") or rec.get("gas_price")
        conn.execute(
            "INSERT INTO recommendations "
            "(timestamp, rec_type, route_key, recommended_value, rationale) "
            "VALUES (?, ?, ?, ?, ?)",
            (now, rec_type, route_key, value, rec.get("rationale", "")),
        )
    conn.commit()
    conn.close()


def get_gas_history(chain: str, hours: int = 24, db_path: str = None) -> list:
    """Get gas price history for a chain."""
    conn = get_db(db_path)
    cutoff = time.time() - (hours * 3600)
    rows = conn.execute(
        "SELECT timestamp, gas_price_gwei FROM gas_prices "
        "WHERE chain = ? AND timestamp > ? ORDER BY timestamp",
        (chain, cutoff),
    ).fetchall()
    conn.close()
    return [{"timestamp": r["timestamp"], "gas_price_gwei": r["gas_price_gwei"]}
            for r in rows]


def get_token_history(token: str, hours: int = 24, db_path: str = None) -> list:
    """Get token price history."""
    conn = get_db(db_path)
    cutoff = time.time() - (hours * 3600)
    rows = conn.execute(
        "SELECT timestamp, price_usd FROM token_prices "
        "WHERE token = ? AND timestamp > ? ORDER BY timestamp",
        (token, cutoff),
    ).fetchall()
    conn.close()
    return [{"timestamp": r["timestamp"], "price_usd": r["price_usd"]}
            for r in rows]


def save_scan_snapshot(scan_data: dict, output_dir: str = None):
    """Save a full scan snapshot as JSON file."""
    if output_dir is None:
        output_dir = str(Path(__file__).parent.parent / "data" / "snapshots")
    os.makedirs(output_dir, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    path = os.path.join(output_dir, f"scan_{ts}.json")
    with open(path, "w") as f:
        json.dump(scan_data, f, indent=2, default=str)
    return path
