#!/usr/bin/env python3
"""Matched whole-process Rust/Zig scrapers on disposable Anvil/PostgreSQL.

Production daemons and unchanged production migrations only. Fixture transactions
use unlocked local Anvil accounts and bypass the counted daemon RPC proxy. Every
trial checks all four event streams, receipt links, signals and restart replay.
"""
from __future__ import annotations

import argparse
import collections
from datetime import datetime, timezone
import hashlib
import http.server
import json
import gzip
import os
import pathlib
import platform
import re
import shutil
import signal
import socket
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "integration"))
import evm
import inventory

ROOT = evm.ROOT
DOMAIN = 99995
CHAIN_NAME = "scraperprocess"
CONTRACT_NAMES = [
    "Mailbox",
    "MerkleTreeHook",
    "TestIsm",
    "TestRecipient",
    "TestPostDispatchHook",
]


class HarnessInterrupted(Exception):
    pass


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def digest(path):
    value = hashlib.sha256(path.read_bytes()).hexdigest()
    return [value[:32], value[32:]]


def chunks(value):
    text = str(value)
    return [text[i:i + 32] for i in range(0, len(text), 32)] or [""]


def run(args, **kwargs):
    result = subprocess.run(
        [str(arg) for arg in args], cwd=ROOT, text=True,
        capture_output=True, timeout=kwargs.pop("timeout", 180), **kwargs,
    )
    if result.returncode:
        raise RuntimeError(
            f"command failed: {args[0]} exit={result.returncode}\n"
            f"{result.stderr[-5000:]}\n{result.stdout[-2000:]}"
        )
    return result.stdout.strip()


def optional_command(args):
    try:
        return {"passed": True, "output": run(args, timeout=20)}
    except Exception as error:
        return {"passed": False, "error_chunks": chunks(error)}


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def pin_binary(source, output, name):
    before = digest(source)
    destination = output / "pinned" / before[0] / name
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        if digest(destination) != before:
            raise RuntimeError(f"pinned {name} digest mismatch")
    else:
        shutil.copy2(source, destination)
    if digest(destination) != before or digest(source) != before:
        raise RuntimeError(f"{name} changed while pinning; wait for build completion")
    return destination


def source_inventory():
    entries = {}
    excluded = {"target", ".zig-cache", "zig-out", ".git", "node_modules", "__pycache__", ".cache"}
    roots = [
        "zig/src", "rust/main/agents/scraper", "rust/main/hyperlane-base",
        "rust/main/hyperlane-core", "rust/main/.cargo",
    ]
    for root in roots:
        for directory, subdirs, files in os.walk(ROOT / root):
            subdirs[:] = sorted(name for name in subdirs if not inventory.pruned(name))
            for name in sorted(files):
                path = pathlib.Path(directory) / name
                if path.suffix in {".zig", ".rs", ".toml", ".lock", ".json", ".jsonl", ".gz", ".sql", ".py", ".h", ".c"} and not (path.suffix != ".gz" and pathlib.Path(str(path) + ".gz").exists()):
                    entries[str(path.relative_to(ROOT))] = digest(path)
    for name in [
        "zig/build.zig", "zig/build.zig.zon", "rust/main/Cargo.lock",
        "rust/main/Cargo.toml", "zig/bench/scraper.py",
    ]:
        path = ROOT / name
        if path.exists():
            entries[name] = digest(path)
    return entries


class CountingProxy:
    def __init__(self, target, stall_receipts):
        self.target = target
        self.counts = collections.Counter()
        self.errors = collections.Counter()
        self.lock = threading.Lock()
        self.release = threading.Event()
        self.stall_receipts = stall_receipts
        if not stall_receipts:
            self.release.set()
        self.receipt_requests_started = threading.Event()

    def snapshot(self):
        with self.lock:
            return {"methods": dict(self.counts), "errors": dict(self.errors)}

    def total(self):
        with self.lock:
            return sum(self.counts.values())

    def __enter__(self):
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self):
                data = self.rfile.read(int(self.headers.get("content-length", "0")))
                try:
                    decoded = json.loads(data)
                    requests = decoded if isinstance(decoded, list) else [decoded]
                    methods = [request.get("method", "invalid") for request in requests]
                    with owner.lock:
                        owner.counts.update(methods)
                    if any(method in ("eth_getTransactionReceipt", "eth_getTransactionByHash") for method in methods):
                        owner.receipt_requests_started.set()
                        if not owner.release.wait(25):
                            with owner.lock:
                                owner.errors["receipt_gate_timeout"] += 1
                            self.close_connection = True
                            return
                    request = urllib.request.Request(
                        owner.target, data, {"Content-Type": "application/json"}
                    )
                    with urllib.request.urlopen(request, timeout=25) as response:
                        body = response.read()
                        status = response.status
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                except (OSError, ValueError) as error:
                    with owner.lock:
                        owner.errors[type(error).__name__] += 1
                    self.close_connection = True

            def log_message(self, *_):
                pass

        class Server(http.server.ThreadingHTTPServer):
            daemon_threads = True

            def handle_error(self, request, client_address):
                if isinstance(sys.exc_info()[1], (ConnectionResetError, BrokenPipeError)):
                    return
                super().handle_error(request, client_address)

        self.server = Server(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(
            target=lambda: self.server.serve_forever(poll_interval=.01), daemon=True
        )
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        return self

    def __exit__(self, *_):
        self.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)


class MeasuredProcess:
    def __init__(self, binary, cwd, env, log_directory, label):
        log_directory.mkdir(parents=True, exist_ok=True)
        self.out = (log_directory / f"{label}.stdout.log").open("w+b")
        self.err = (log_directory / f"{label}.stderr.log").open("w+b")
        self.start_ns = time.perf_counter_ns()
        try:
            self.p = subprocess.Popen(
                [str(binary)], cwd=cwd, env=env, stdout=self.out, stderr=self.err
            )
        except Exception:
            self.out.close()
            self.err.close()
            raise
        self.usage = None
        self.status = None
        self.end_ns = None

    def poll(self):
        if self.usage is None:
            pid, status, usage = os.wait4(self.p.pid, os.WNOHANG)
            if pid:
                self.status = os.waitstatus_to_exitcode(status)
                self.p.returncode = self.status
                self.usage = usage
                self.end_ns = time.perf_counter_ns()
        return self.status

    def logs(self):
        self.out.seek(0)
        self.err.seek(0)
        return (self.out.read() + self.err.read()).decode(errors="replace")[-12000:]

    def stop(self, sig):
        started = time.perf_counter_ns()
        forced_kill = False
        if self.poll() is None:
            self.p.send_signal(sig)
        until = time.monotonic() + 30
        while self.poll() is None and time.monotonic() < until:
            time.sleep(.01)
        if self.poll() is None:
            forced_kill = True
            self.p.kill()
            _, status, self.usage = os.wait4(self.p.pid, 0)
            self.status = os.waitstatus_to_exitcode(status)
            self.p.returncode = self.status
            self.end_ns = time.perf_counter_ns()
        self.out.flush()
        self.err.flush()
        return {
            "signal": signal.Signals(sig).name,
            "exit_code": self.status,
            "graceful_zero_exit": self.status == 0,
            "forced_kill": forced_kill,
            "user_seconds": self.usage.ru_utime,
            "system_seconds": self.usage.ru_stime,
            "voluntary_context_switches": self.usage.ru_nvcsw,
            "involuntary_context_switches": self.usage.ru_nivcsw,
            "max_rss_bytes": self.usage.ru_maxrss if sys.platform == "darwin" else self.usage.ru_maxrss * 1024,
            "process_wall_seconds": (self.end_ns - self.start_ns) / 1e9,
            "shutdown_ms": (self.end_ns - started) / 1e6,
        }

    def close(self):
        self.out.close()
        self.err.close()


class Postgres:
    def __init__(self, image, migration_bin, output):
        self.image = image
        self.migration_bin = migration_bin
        self.output = output
        self.name = f"ziggy-scraper-bench-{os.getpid()}"
        self.started = False

    def __enter__(self):
        run([
            "docker", "run", "--detach", "--rm", "--pull=never", "--name", self.name,
            "-e", "POSTGRES_USER=ziggy", "-e", "POSTGRES_DB=ziggy",
            "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-p", "127.0.0.1::5432", self.image,
        ])
        self.started = True
        port_text = run(["docker", "port", self.name, "5432/tcp"])
        host, port = port_text.rsplit(":", 1)
        if host != "127.0.0.1" or not port.isdecimal():
            raise RuntimeError("PostgreSQL did not publish a dynamic loopback-only port")
        self.port = int(port)
        deadline = time.monotonic() + 30
        while True:
            ready = subprocess.run(
                ["docker", "exec", self.name, "pg_isready", "-U", "ziggy", "-d", "ziggy"],
                capture_output=True,
            )
            if ready.returncode == 0:
                break
            if time.monotonic() >= deadline:
                raise RuntimeError("disposable PostgreSQL readiness deadline")
            time.sleep(.1)
        self.identity = {
            "image": self.image,
            "server": run(["docker", "exec", self.name, "postgres", "--version"]),
            "image_id_chunks": chunks(run([
                "docker", "inspect", "--format", "{{.Image}}", self.name,
            ]).removeprefix("sha256:")),
            "isolation": "task-owned fresh container; dynamic loopback port; fresh database per trial; removed on exit",
        }
        return self

    def __exit__(self, *_):
        if self.started:
            self.started = False
            run(["docker", "stop", "--timeout", "5", self.name])

    def sql(self, database, query):
        return run([
            "docker", "exec", self.name, "psql", "-X", "-U", "ziggy", "-d", database,
            "-At", "-v", "ON_ERROR_STOP=1", "-c", query,
        ])

    def prepare(self, database, log_path):
        if not re.fullmatch(r"bench_\d+_\d+_(rust|zig)", database):
            raise ValueError("guarded benchmark database name required")
        self.sql("ziggy", f"CREATE DATABASE {database}")
        url = f"postgresql://ziggy@127.0.0.1:{self.port}/{database}?sslmode=disable"
        migrated = subprocess.run(
            [str(self.migration_bin)], cwd=ROOT, text=True, capture_output=True,
            env={"PATH": os.environ.get("PATH", ""), "DATABASE_URL": url}, timeout=180,
        )
        log_path.write_text(migrated.stdout + migrated.stderr)
        if migrated.returncode:
            raise RuntimeError(f"init-db failed for {database}: {migrated.stderr[-3000:]}")
        self.sql(database, (
            f"INSERT INTO domain(id,time_created,time_updated,name,native_token,chain_id,is_test_net,is_deprecated) "
            f"VALUES({DOMAIN},now(),now(),'{CHAIN_NAME}','ETH',31337,true,false)"
        ))
        migrations = int(self.sql(database, "SELECT count(*) FROM seaql_migrations"))
        conninfo = (
            f"host=127.0.0.1 port={self.port} dbname={database} user=ziggy "
            "connect_timeout=5 sslmode=disable"
        )
        return {"rust_url": url, "zig_conninfo": conninfo, "migrations": migrations}


def metrics_probe(port, output):
    url = f"http://127.0.0.1:{port}/metrics"
    result = {"url": "loopback ephemeral /metrics"}
    try:
        with urllib.request.urlopen(url, timeout=5) as response:
            body = response.read(8 * 1024 * 1024)
            result["get_status"] = response.status
        output.write_bytes(body)
        result.update({
            "body_bytes": len(body),
            "hyperlane_help_families": body.count(b"# HELP hyperlane_"),
            "agent_scraper_present": b'agent="scraper"' in body,
            "contract_sync_height_present": b"hyperlane_contract_sync_block_height" in body,
        })
        with urllib.request.urlopen(urllib.request.Request(url, method="HEAD"), timeout=5) as response:
            result["head_status"] = response.status
            result["head_body_bytes"] = len(response.read())
            result["head_content_length"] = response.headers.get("content-length")
        result["passed"] = (
            result["get_status"] == 200 and result["head_status"] == 200
            and result["head_body_bytes"] == 0 and result["hyperlane_help_families"] > 0
        )
    except Exception as error:
        result.update({"passed": False, "error_chunks": chunks(error)})
    return result


def summary_stats(values):
    values = list(values)
    if not values:
        return None
    return {"median": statistics.median(values), "min": min(values), "max": max(values)}


def wait_for(predicate, daemon, deadline, description, interval=.01):
    until = time.monotonic() + deadline
    while time.monotonic() < until:
        if daemon.poll() is not None:
            raise RuntimeError(f"daemon exited {daemon.status} during {description}: {daemon.logs()}")
        if predicate():
            return time.perf_counter_ns()
        time.sleep(interval)
    raise RuntimeError(f"deadline during {description}: {daemon.logs()}")


def event_query(event):
    value = event["message_id"].removeprefix("0x")
    index = event["index"]
    body = f"scraper whole process {index}".encode().hex()
    return f"""
SELECT
 (SELECT count(*) FROM message m JOIN raw_message_dispatch r ON r.msg_id=m.msg_id
  JOIN "transaction" t ON t.id=m.origin_tx_id AND t.hash=r.origin_tx_hash
  WHERE m.msg_id=decode('{value}','hex') AND m.nonce={index} AND r.nonce={index}
  AND m.origin={DOMAIN} AND m.destination={DOMAIN} AND r.origin_domain={DOMAIN}
  AND r.destination_domain={DOMAIN} AND m.msg_body=r.msg_body
  AND m.msg_body=decode('{body}','hex')),
 (SELECT count(*) FROM confirmed_delivered_message d JOIN "transaction" t
  ON t.id=d.destination_tx_id AND t.hash=d.transaction_hash WHERE d.msg_id=decode('{value}','hex')),
 (SELECT count(*) FROM confirmed_gas_payment g JOIN "transaction" t
  ON t.id=g.tx_id AND t.hash=g.transaction_hash WHERE g.msg_id=decode('{value}','hex')
  AND g.payment=1000 AND g.gas_amount=100 AND g.origin={DOMAIN} AND g.destination={DOMAIN}),
 (SELECT count(*) FROM confirmed_merkle_tree_insertion i JOIN raw_message_dispatch r
  ON r.msg_id=i.message_id WHERE i.message_id=decode('{value}','hex') AND i.leaf_index={index})
"""


def linked_counts_query():
    return f"""
SELECT
 (SELECT count(*) FROM confirmed_raw_message_dispatch WHERE origin_domain={DOMAIN}),
 (SELECT count(*) FROM message WHERE origin={DOMAIN}),
 (SELECT count(*) FROM confirmed_delivered_message WHERE domain={DOMAIN}),
 (SELECT count(*) FROM confirmed_gas_payment WHERE domain={DOMAIN}),
 (SELECT count(*) FROM confirmed_merkle_tree_insertion WHERE domain={DOMAIN}),
 (SELECT count(*) FROM message m JOIN raw_message_dispatch r ON r.msg_id=m.msg_id
  JOIN "transaction" t ON t.id=m.origin_tx_id AND t.hash=r.origin_tx_hash WHERE m.origin={DOMAIN}),
 (SELECT count(*) FROM confirmed_delivered_message d JOIN "transaction" t
  ON t.id=d.destination_tx_id AND t.hash=d.transaction_hash WHERE d.domain={DOMAIN}),
 (SELECT count(*) FROM confirmed_gas_payment g JOIN "transaction" t
  ON t.id=g.tx_id AND t.hash=g.transaction_hash WHERE g.domain={DOMAIN})
"""


def db_semantics(postgres, database):
    counts = [int(value) for value in postgres.sql(database, linked_counts_query()).split("|")]
    mismatch_text = postgres.sql(database, f"""
SELECT
 (SELECT count(*) FROM message m JOIN raw_message_dispatch r ON r.msg_id=m.msg_id
  LEFT JOIN "transaction" t ON t.id=m.origin_tx_id
  WHERE m.origin={DOMAIN} AND (t.id IS NULL OR t.hash<>r.origin_tx_hash)),
 (SELECT count(*) FROM delivered_message d LEFT JOIN "transaction" t ON t.id=d.destination_tx_id
  WHERE d.domain={DOMAIN} AND (t.id IS NULL OR t.hash<>d.transaction_hash)),
 (SELECT count(*) FROM gas_payment g LEFT JOIN "transaction" t ON t.id=g.tx_id
  WHERE g.domain={DOMAIN} AND (t.id IS NULL OR t.hash<>g.transaction_hash)),
 (SELECT count(*) FROM merkle_tree_insertion i LEFT JOIN raw_message_dispatch r ON r.msg_id=i.message_id
  WHERE i.domain={DOMAIN} AND r.msg_id IS NULL),
 (SELECT count(*)-count(DISTINCT msg_id) FROM raw_message_dispatch WHERE origin_domain={DOMAIN}),
 (SELECT count(*)-count(DISTINCT msg_id) FROM message WHERE origin={DOMAIN}),
 (SELECT count(*)-count(DISTINCT msg_id) FROM delivered_message WHERE domain={DOMAIN}),
 (SELECT count(*)-count(DISTINCT msg_id) FROM gas_payment WHERE domain={DOMAIN}),
 (SELECT count(*)-count(DISTINCT message_id) FROM merkle_tree_insertion WHERE domain={DOMAIN})
""")
    mismatches = [int(value) for value in mismatch_text.split("|")]
    head = postgres.sql(database, (
        "SELECT start_height,indexed_height,head_height,confirmed_height,healthy,halted "
        f"FROM scraper_head WHERE domain={DOMAIN}"
    ))
    return {
        "raw_dispatch": counts[0], "messages": counts[1], "deliveries": counts[2],
        "gas_payments": counts[3], "merkle_insertions": counts[4],
        "linked_messages": counts[5], "linked_deliveries": counts[6], "linked_gas_payments": counts[7],
        "receipt_or_identity_mismatches": sum(mismatches[:4]),
        "duplicate_rows_by_message_identity": sum(mismatches[4:]),
        "duplicate_detail": {
            "raw_dispatch": mismatches[4], "messages": mismatches[5], "deliveries": mismatches[6],
            "gas_payments": mismatches[7], "merkle_insertions": mismatches[8],
        },
        "head": head,
    }


def run_trial(implementation, sample, order, args, pinned, postgres, contracts, fixture_metadata, row):
    trial_dir = args.output / "trials" / f"pair-{sample:03d}" / implementation
    trial_dir.mkdir(parents=True, exist_ok=True)
    database = f"bench_{os.getpid()}_{sample}_{implementation}"
    database = database.replace("-", "_")
    with tempfile.TemporaryDirectory(prefix=f"ziggy-scraper-bench-{implementation}-") as temporary:
        temp = pathlib.Path(temporary)
        port = free_port()
        chain = evm.Chain(f"http://127.0.0.1:{port}")
        with (trial_dir / "anvil.log").open("w") as anvil_log:
            anvil = subprocess.Popen([
                "anvil", "--host", "127.0.0.1", "--port", str(port),
                "--chain-id", "31337", "--silent",
            ], cwd=ROOT, stdout=anvil_log, stderr=anvil_log)
            daemon = None
            try:
                for _ in range(100):
                    if anvil.poll() is not None:
                        raise RuntimeError("Anvil exited during startup")
                    try:
                        chain.account = chain.rpc("eth_accounts")[0]
                        break
                    except (ConnectionError, urllib.error.URLError):
                        time.sleep(.05)
                else:
                    raise RuntimeError("Anvil readiness deadline")

                def deploy(name, signature=None, *values):
                    return chain.send(
                        "0x" + contracts[name] + (evm.abi(signature, *values) if signature else "")
                    )["contractAddress"]

                mailbox = deploy("Mailbox", "constructor(uint32)", str(DOMAIN))
                hook = deploy("MerkleTreeHook", "constructor(address)", mailbox)
                required = deploy("TestPostDispatchHook")
                ism = deploy("TestIsm")
                recipient = deploy("TestRecipient")
                igp = deploy("TestInterchainGasPaymaster")
                chain.send(evm.calldata(
                    "initialize(address,address,address,address)", chain.account, ism, hook, required
                ), mailbox)
                dispatch_topic = evm.run(["cast", "keccak", "Dispatch(address,uint32,bytes32,bytes)"])
                recipient32 = "0x" + "00" * 12 + recipient[2:]
                events = []

                def produce(index):
                    dispatch = chain.send(evm.calldata(
                        "dispatch(uint32,bytes32,bytes)", str(DOMAIN), recipient32,
                        "0x" + f"scraper whole process {index}".encode().hex(),
                    ), mailbox)
                    event = next(
                        log for log in dispatch["logs"]
                        if log["address"].lower() == mailbox.lower() and log["topics"][0] == dispatch_topic
                    )
                    data = bytes.fromhex(event["data"][2:])
                    length = int.from_bytes(data[32:64], "big")
                    message = "0x" + data[64:64 + length].hex()
                    message_id = evm.run(["cast", "keccak", message])
                    process = chain.send(evm.calldata("process(bytes,bytes)", "0x", message), mailbox)
                    gas_hash = chain.rpc("eth_sendTransaction", [{
                        "from": chain.account, "to": igp, "gas": "0xe00000", "value": hex(1000),
                        "data": evm.calldata(
                            "payForGas(bytes32,uint32,uint256,address)", message_id,
                            str(DOMAIN), "100", chain.account,
                        ),
                    }])
                    gas = chain.receipt(gas_hash)
                    emitted_ns = time.perf_counter_ns()
                    value = {
                        "index": index, "message_id": message_id,
                        "dispatch_tx": dispatch["transactionHash"], "delivery_tx": process["transactionHash"],
                        "gas_tx": gas["transactionHash"], "dispatch_block": int(dispatch["blockNumber"], 16),
                        "delivery_block": int(process["blockNumber"], 16), "gas_block": int(gas["blockNumber"], 16),
                        "emitted_ns": emitted_ns,
                    }
                    events.append(value)
                    return value

                for index in range(args.catchup):
                    produce(index)
                backlog_tip = max(event["gas_block"] for event in events)
                db = postgres.prepare(database, trial_dir / "migrations.log")
                expected_migrations = fixture_metadata["production_migrations_applied"]
                if expected_migrations is not None and db["migrations"] != expected_migrations:
                    raise RuntimeError("production migration count changed between trials")
                row.update({
                    "implementation": implementation, "sample": sample, "order": order,
                    "status": "running", "database_name": database,
                    "load_average_start": os.getloadavg(),
                    "fixture": {
                        "mailbox": mailbox, "merkle_tree_hook": hook, "interchain_gas_paymaster": igp,
                        "recipient": recipient, "domain": DOMAIN, "chain_id": 31337,
                        "backlog_tip": backlog_tip, "events": events,
                    },
                    "fixture_rpc_direct": {"before_daemon": chain.counter},
                })
                with CountingProxy(chain.url, args.receipt_stall_check) as proxy:
                    config_dir = temp / "config"
                    config_dir.mkdir()
                    metrics_port = free_port()
                    config = {
                        "chainsToScrape": CHAIN_NAME,
                        "db": db["rust_url"] if implementation == "rust" else db["zig_conninfo"],
                        "dbMaxConnections": 3, "dbAcquireTimeoutMillis": 5000,
                        "metricsPort": metrics_port,
                        "tracing": {"level": "error", "fmt": "json"},
                        "chains": {CHAIN_NAME: {
                            "name": CHAIN_NAME, "domainId": DOMAIN, "chainId": 31337,
                            "protocol": "ethereum", "rpcUrls": [{"http": proxy.url}],
                            "rpcConsensusType": "single", "mailbox": mailbox,
                            "validatorAnnounce": required, "merkleTreeHook": hook,
                            "interchainGasPaymaster": igp,
                            "blocks": {"reorgPeriod": 0, "estimateBlockTime": 1},
                            "index": {"from": 0, "chunk": args.chunk, "interval": args.interval},
                        }},
                    }
                    (config_dir / "fixture.json").write_text(json.dumps(config))
                    env = {
                        "PATH": os.environ.get("PATH", ""),
                        "HYPERLANE_ZIG_DEFAULTS": str(config_dir),
                        "HYPERLANE_CURL_LIBRARY": "/usr/lib/libcurl.4.dylib" if os.uname().sysname == "Darwin" else "libcurl.so.4",
                    }

                    def launch(label):
                        return MeasuredProcess(pinned[implementation], temp, env, trial_dir, label)

                    def complete(expected):
                        text = postgres.sql(database, linked_counts_query())
                        return text == "|".join([str(expected)] * 8)

                    def event_complete(event):
                        return postgres.sql(database, event_query(event)) == "1|1|1|1"

                    daemon = launch("first")
                    startup_ns = wait_for(
                        lambda: int(postgres.sql(database, (
                            f"SELECT count(*) FROM confirmed_raw_message_dispatch WHERE origin_domain={DOMAIN}"
                        ))) > 0,
                        daemon, args.deadline, "first durable dispatch",
                    )
                    startup_ms = (startup_ns - daemon.start_ns) / 1e6
                    stalled_head_ns = None
                    if args.receipt_stall_check:
                        wait_for(
                            lambda: proxy.receipt_requests_started.is_set(), daemon,
                            args.deadline, "first receipt request",
                        )
                        stalled_head_ns = wait_for(
                            lambda: int(postgres.sql(database, (
                                f"SELECT confirmed_height FROM scraper_head WHERE domain={DOMAIN}"
                            )) or -1) >= backlog_tip,
                            daemon, args.deadline, "confirmed head while receipts stalled",
                        )
                        if proxy.release.is_set():
                            raise RuntimeError("receipt gate opened before confirmed-head check")
                        proxy.release.set()
                    caught_ns = wait_for(
                        lambda: complete(args.catchup), daemon, args.deadline, "catchup and enrichment"
                    )
                    catchup_ms = (caught_ns - daemon.start_ns) / 1e6
                    startup_rpc = proxy.snapshot()
                    metrics = metrics_probe(metrics_port, trial_dir / "metrics-first.txt")
                    if not metrics["passed"]:
                        raise RuntimeError(f"metrics readback failed: {metrics}")
                    emitted = [None] * args.fresh
                    observed = [None] * args.fresh
                    production_errors = []

                    def producer():
                        try:
                            for offset in range(args.fresh):
                                due = caught_ns + (offset + 1) * args.fresh_interval_ms * 1_000_000
                                time.sleep(max(0, (due - time.perf_counter_ns()) / 1e9))
                                emitted[offset] = produce(args.catchup + offset)
                        except Exception as error:
                            production_errors.append(error)

                    producer_thread = threading.Thread(target=producer, daemon=True)
                    producer_thread.start()
                    steady_deadline = args.deadline + args.fresh * args.fresh_interval_ms / 1000
                    try:
                        until = time.monotonic() + steady_deadline
                        while any(value is None for value in observed):
                            if daemon.poll() is not None:
                                raise RuntimeError(f"daemon exited during fresh arrivals: {daemon.logs()}")
                            if production_errors:
                                raise production_errors[0]
                            for offset, event in enumerate(emitted):
                                if event is not None and observed[offset] is None and event_complete(event):
                                    observed[offset] = time.perf_counter_ns()
                            if time.monotonic() >= until:
                                raise RuntimeError(f"fresh durable-event deadline: {daemon.logs()}")
                            time.sleep(.01)
                    finally:
                        producer_thread.join(timeout=30)
                    if producer_thread.is_alive():
                        raise RuntimeError("fixture producer did not stop")
                    fresh_latencies = [
                        (finished - event["emitted_ns"]) / 1e6
                        for finished, event in zip(observed, emitted)
                    ]
                    first_finished_ns = time.perf_counter_ns()
                    first_rpc = proxy.snapshot()
                    before_restart = db_semantics(postgres, database)
                    expected_before = args.catchup + args.fresh
                    for key in ["raw_dispatch", "messages", "deliveries", "gas_payments", "merkle_insertions"]:
                        if before_restart[key] != expected_before:
                            raise RuntimeError(f"pre-restart {key}={before_restart[key]} expected {expected_before}")
                    if before_restart["receipt_or_identity_mismatches"] or before_restart["duplicate_rows_by_message_identity"]:
                        raise RuntimeError(f"pre-restart DB semantics failed: {before_restart}")
                    first_measurements = daemon.stop(signal.SIGTERM)
                    if first_measurements["forced_kill"] or first_measurements["exit_code"] not in [0, -signal.SIGTERM]:
                        raise RuntimeError(f"SIGTERM shutdown failed: {daemon.logs()}")
                    daemon.close()
                    daemon = None
                    after_first_stop_rpc = proxy.snapshot()
                    # Fixture-only TTL passage after the writer process has joined.
                    postgres.sql(database, (
                        "UPDATE scraper_head SET writer_lease_until=clock_timestamp()-interval '1 second' "
                        f"WHERE domain={DOMAIN}"
                    ))
                    produce(expected_before)
                    if args.reallocate_restart_metrics_port:
                        metrics_port = free_port()
                        config["metricsPort"] = metrics_port
                        (config_dir / "fixture.json").write_text(json.dumps(config))
                    daemon = launch("restart")
                    restart_start_ns = daemon.start_ns
                    restarted_ns = wait_for(
                        lambda: complete(expected_before + 1), daemon,
                        args.deadline, "restart catchup without duplicates",
                    )
                    restart_metrics = metrics_probe(metrics_port, trial_dir / "metrics-restart.txt")
                    if not restart_metrics["passed"]:
                        raise RuntimeError(f"restart metrics readback failed: {restart_metrics}")
                    time.sleep(max(0, args.interval + .1))
                    after_restart = db_semantics(postgres, database)
                    for event in events:
                        if not event_complete(event):
                            raise RuntimeError(f"restart receipt association failed for {event['message_id']}")
                    expected_after = expected_before + 1
                    for key in ["raw_dispatch", "messages", "deliveries", "gas_payments", "merkle_insertions"]:
                        if after_restart[key] != expected_after:
                            raise RuntimeError(f"post-restart {key}={after_restart[key]} expected {expected_after}")
                    if after_restart["receipt_or_identity_mismatches"] or after_restart["duplicate_rows_by_message_identity"]:
                        raise RuntimeError(f"post-restart DB semantics failed: {after_restart}")
                    restart_measurements = daemon.stop(signal.SIGINT)
                    if restart_measurements["forced_kill"] or restart_measurements["exit_code"] not in [0, -signal.SIGINT]:
                        raise RuntimeError(f"SIGINT shutdown failed: {daemon.logs()}")
                    daemon.close()
                    daemon = None
                    final_rpc = proxy.snapshot()
                    row.update({
                        "status": "passed",
                        "startup_ms": startup_ms,
                        "catchup_ms": catchup_ms,
                        "fresh_event_group_to_durable_ms": fresh_latencies,
                        "fresh_phase_ms": (first_finished_ns - caught_ns) / 1e6,
                        "restart_catchup_ms": (restarted_ns - restart_start_ns) / 1e6,
                        "head_progress_while_receipts_stalled": stalled_head_ns is not None,
                        "head_progress_ms": (stalled_head_ns - startup_ns) / 1e6 if stalled_head_ns else None,
                        "fixture_expired_stopped_writer_lease": True,
                        "first_process": first_measurements, "restart_process": restart_measurements,
                        "rpc_at_catchup": startup_rpc, "rpc_before_first_stop": first_rpc,
                        "rpc_after_first_stop": after_first_stop_rpc, "rpc_total": final_rpc,
                        "rpc_restart_delta": {
                            "methods": {
                                method: final_rpc["methods"].get(method, 0) - after_first_stop_rpc["methods"].get(method, 0)
                                for method in set(final_rpc["methods"]) | set(after_first_stop_rpc["methods"])
                            },
                            "errors": {
                                method: final_rpc["errors"].get(method, 0) - after_first_stop_rpc["errors"].get(method, 0)
                                for method in set(final_rpc["errors"]) | set(after_first_stop_rpc["errors"])
                            },
                        },
                        "metrics": metrics, "metrics_restart": restart_metrics,
                        "restart_metrics_port_reallocated": args.reallocate_restart_metrics_port,
                        "before_restart": before_restart, "after_restart": after_restart,
                        "fixture_rpc_direct": {
                            "total": chain.counter,
                            "note": "direct Anvil deployment/production/verification calls; excluded from daemon proxy counts",
                        },
                        "load_average_end": os.getloadavg(),
                    })
                    return row
            finally:
                if daemon is not None:
                    if daemon.usage is None:
                        daemon.stop(signal.SIGTERM)
                    daemon.close()
                anvil.terminate()
                try:
                    anvil.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    anvil.kill()
                    anvil.wait(timeout=5)


def build_summary(metadata):
    summary = {}
    completed = [row for row in metadata["raw_samples"] if row.get("status") == "passed"]
    for name in ["rust", "zig"]:
        rows = [row for row in completed if row["implementation"] == name]
        fresh = [value for row in rows for value in row["fresh_event_group_to_durable_ms"]]
        rpc_totals = [sum(row["rpc_total"]["methods"].values()) for row in rows]
        summary[name] = {
            "completed_trials": len(rows),
            "startup_ms": summary_stats(row["startup_ms"] for row in rows),
            "catchup_ms": summary_stats(row["catchup_ms"] for row in rows),
            "fresh_event_group_to_durable_ms": summary_stats(fresh),
            "restart_catchup_ms": summary_stats(row["restart_catchup_ms"] for row in rows),
            "first_user_seconds": summary_stats(row["first_process"]["user_seconds"] for row in rows),
            "first_system_seconds": summary_stats(row["first_process"]["system_seconds"] for row in rows),
            "first_cpu_seconds": summary_stats(
                row["first_process"]["user_seconds"] + row["first_process"]["system_seconds"] for row in rows
            ),
            "first_max_rss_bytes": summary_stats(row["first_process"]["max_rss_bytes"] for row in rows),
            "first_sigterm_shutdown_ms": summary_stats(row["first_process"]["shutdown_ms"] for row in rows),
            "restart_user_seconds": summary_stats(row["restart_process"]["user_seconds"] for row in rows),
            "restart_system_seconds": summary_stats(row["restart_process"]["system_seconds"] for row in rows),
            "restart_max_rss_bytes": summary_stats(row["restart_process"]["max_rss_bytes"] for row in rows),
            "restart_sigint_shutdown_ms": summary_stats(row["restart_process"]["shutdown_ms"] for row in rows),
            "daemon_rpc_requests": summary_stats(rpc_totals),
            "fixture_direct_rpc_requests": summary_stats(row["fixture_rpc_direct"]["total"] for row in rows),
            "process_wall_seconds": summary_stats(row["first_process"]["process_wall_seconds"] for row in rows),
        }
    pairs = []
    for sample in range(metadata["configuration"]["samples"]):
        rust = next((row for row in completed if row["implementation"] == "rust" and row["sample"] == sample), None)
        zig = next((row for row in completed if row["implementation"] == "zig" and row["sample"] == sample), None)
        if rust and zig:
            pairs.append({
                "sample": sample,
                "zig_minus_rust_catchup_ms": zig["catchup_ms"] - rust["catchup_ms"],
                "zig_minus_rust_median_fresh_ms": statistics.median(zig["fresh_event_group_to_durable_ms"]) - statistics.median(rust["fresh_event_group_to_durable_ms"]),
                "zig_minus_rust_first_cpu_seconds": (
                    zig["first_process"]["user_seconds"] + zig["first_process"]["system_seconds"]
                    - rust["first_process"]["user_seconds"] - rust["first_process"]["system_seconds"]
                ),
            })
    return {"by_implementation": summary, "paired_deltas": pairs}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rust", type=pathlib.Path, default=ROOT / "rust/main/target/release/scraper")
    parser.add_argument("--zig", type=pathlib.Path, default=ROOT / "zig/zig-out/bin/scraper")
    parser.add_argument("--migration-bin", type=pathlib.Path, default=ROOT / "rust/main/target/release/init-db")
    parser.add_argument("--image", default="postgres:16.15")
    parser.add_argument("--zig-toolchain", type=pathlib.Path, default=shutil.which("zig"), help="Zig executable used only for recorded toolchain readback")
    parser.add_argument("--samples", type=int, default=5)
    parser.add_argument("--catchup", type=int, default=24)
    parser.add_argument("--fresh", type=int, default=8)
    parser.add_argument("--fresh-interval-ms", type=int, default=1000)
    parser.add_argument("--chunk", type=int, default=50)
    parser.add_argument("--interval", type=int, default=1)
    parser.add_argument("--deadline", type=float, default=120)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--quiet-host", action="store_true", help="assert coordinated team compiler-idle window; unrelated user workloads may remain; never stops processes")
    parser.add_argument("--no-receipt-stall-check", dest="receipt_stall_check", action="store_false")
    parser.add_argument(
        "--reallocate-restart-metrics-port", action="store_true",
        help="provisional workaround for Zig same-port restart; recorded and excluded from final same-config claims",
    )
    parser.set_defaults(receipt_stall_check=True)
    args = parser.parse_args()

    def interrupted(signum, _frame):
        raise HarnessInterrupted(f"interrupted by {signal.Signals(signum).name}")

    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, interrupted)
    args.rust = args.rust.resolve()
    args.zig = args.zig.resolve()
    args.migration_bin = args.migration_bin.resolve()
    if args.zig_toolchain is not None:
        args.zig_toolchain = args.zig_toolchain.resolve()
        if not args.zig_toolchain.is_file():
            parser.error(f"missing Zig toolchain {args.zig_toolchain}")
    args.output = args.output.resolve()
    results_root = (ROOT / "zig/bench/results").resolve()
    if args.output.parent != results_root or not args.output.name.startswith("scraper-process-"):
        parser.error("output must be a direct zig/bench/results/scraper-process-* directory")
    if args.samples < 1 or args.catchup < 2 or args.fresh < 1 or args.fresh_interval_ms < 1:
        parser.error("positive samples/fresh counts and catchup>=2 required")
    for binary in [args.rust, args.zig, args.migration_bin]:
        if not binary.is_file():
            parser.error(f"missing production binary {binary}")
    for command in ["anvil", "cast", "docker", "pnpm"]:
        if not shutil.which(command):
            parser.error(f"missing fixture tool {command}")
    args.output.mkdir(parents=True, exist_ok=False)
    pinned = {
        name: pin_binary(source, args.output, name)
        for name, source in [("rust", args.rust), ("zig", args.zig), ("init-db", args.migration_bin)]
    }
    evm.CACHE = args.output / "fixture-cache"
    evm.CACHE.mkdir(parents=True)
    evm.CONTRACTS = {name: evm.CONTRACTS[name] for name in CONTRACT_NAMES}
    evm.CONTRACTS["TestInterchainGasPaymaster"] = "solidity/contracts/test/TestInterchainGasPaymaster.sol"
    contracts = evm.compile_contracts()
    fixture_manifest = json.loads((evm.CACHE / "contracts.json").read_text())
    first_migrations = 21
    metadata = {
        "schema_version": 1,
        "started_at_utc": utc_now(),
        "status": "running",
        "host_class": "TEAM_COMPILER_IDLE_CALLER_ASSERTED" if args.quiet_host else "NONQUIET",
        "shared_host_note": "No exclusive-host claim. The optional quiet-host flag asserts team compilers idle only; unrelated user workloads may remain. No processes are stopped or isolated by this harness; load and process inventory are recorded.",
        "scope": "Actual production Rust/Zig scraper processes, real local Solidity/Anvil and migrated disposable PostgreSQL; whole-process only, not microbenchmark/build/empty-daemon comparison.",
        "host": platform.platform(),
        "load_average_start": os.getloadavg(),
        "active_compilers_before": run(["ps", "-axo", "pid,etime,pcpu,comm"]),
        "git_head_at_harness_start": run(["git", "rev-parse", "HEAD"]),
        "rust_source_reference_commit": "c5202242cc6569da4a858ed7ddbb34170ab696aa",
        "rust_source_worktree_status": run(["git", "status", "--short", "--", "rust/main", "rust/sealevel"]),
        "rust_source_reference_qualification": "Historical production source reference, not an assertion that the executed binary was built at a clean commit. Binary digest, current source inventory and separately recorded build-matrix commands/input snapshots identify each final build.",
        "configuration": {
            "samples": args.samples, "catchup_event_groups": args.catchup,
            "fresh_event_groups": args.fresh, "restart_event_groups": 1,
            "transactions_per_event_group": 3,
            "fresh_interval_ms": args.fresh_interval_ms, "index_from": 0,
            "index_chunk": args.chunk, "index_interval_seconds": args.interval,
            "reorg_period_blocks": 0, "rpc_endpoints_per_daemon": 1,
            "rpc_consensus": "single", "db_max_connections": 3,
            "receipt_stall_check": args.receipt_stall_check,
            "restart_metrics_port_reallocated": args.reallocate_restart_metrics_port,
            "ordering": "alternating rust/zig then zig/rust by pair",
            "fresh_latency_definition": "last receipt of dispatch+process+gas fixture group to all four confirmed streams durable with correct receipt links",
            "catchup_definition": "process spawn to all backlog groups confirmed and enriched",
            "startup_definition": "process spawn to first confirmed raw dispatch",
        },
        "database_requirement": {
            "requested_image": args.image,
            "unchanged_production_migration_files": 21,
            "server_version_policy": "Matched server image per snapshot; the 21 requirement counts production migrations, not a PostgreSQL server major",
        },
        "binaries": {},
        "toolchains": {
            "rustc": optional_command(["rustc", "--version"]),
            "cargo": optional_command(["cargo", "--version"]),
            "rustup_toolchains": optional_command(["rustup", "toolchain", "list"]),
            "zig": optional_command([args.zig_toolchain, "version"]) if args.zig_toolchain else {"passed": False, "error_chunks": ["No --zig-toolchain provided"]},
            "anvil": optional_command(["anvil", "--version"]),
            "cast": optional_command(["cast", "--version"]),
            "python": optional_command([sys.executable, "--version"]),
            "solc": optional_command(["pnpm", "dlx", "solc@0.8.33", "--version"]),
        },
        "fixture": {
            "compiler": "solc 0.8.33 via repository evm.py standard-json, optimizer runs10000, cancun",
            "compiler_input_sha256_chunks": chunks(fixture_manifest["input_digest"]),
            "contracts": evm.CONTRACTS,
            "contract_source_sha256_chunks": {
                path: digest(ROOT / path) for path in sorted(set(evm.CONTRACTS.values()))
            },
            "production_migrations_applied": 21,
        },
        "feature_and_measurement_qualifications": [
            "Rust default signal handling may terminate by signal; Zig normally drains and exits0. Shutdown duration and exit status are separate metrics.",
            "Both use the same migrated schema and correctness checks; internal durability implementations and telemetry families may differ.",
            "Fresh latency includes finality-independent polling and all four streams plus receipt enrichment, not merely log ingestion.",
            "DB connection spelling differs only by client API: Rust URL versus Zig libpq conninfo on the same fresh endpoint/schema.",
            "Source inventory includes concurrent edits; pinned binary hashes identify exactly what executed.",
        ],
        "source_inventory_sha256_chunks": source_inventory(),
        "raw_samples": [], "failures": [],
    }
    for name, binary in pinned.items():
        metadata["binaries"][name] = {
            "bytes": binary.stat().st_size, "sha256_chunks": digest(binary),
            "pinned_under_output": str(binary.relative_to(args.output)),
        }

    def persist():
        wire = (json.dumps(metadata, indent=2) + "\n").encode()
        (args.output / "scraper-process.json").write_bytes(wire)
        (args.output / "scraper-process.json.gz").write_bytes(gzip.compress(wire, mtime=0))

    persist()
    postgres = Postgres(args.image, pinned["init-db"], args.output)
    try:
        try:
            with postgres:
                metadata["database"] = postgres.identity
                for sample in range(args.samples):
                    implementations = ["rust", "zig"] if sample % 2 == 0 else ["zig", "rust"]
                    for order, implementation in enumerate(implementations):
                        row = {}
                        metadata["raw_samples"].append(row)
                        try:
                            fixture_migrations = {"production_migrations_applied": first_migrations}
                            run_trial(
                                implementation, sample, order, args, pinned, postgres,
                                contracts, fixture_migrations, row,
                            )
                            persist()
                            print(
                                implementation, sample, f"catchup={row['catchup_ms']:.1f}ms",
                                f"fresh_median={statistics.median(row['fresh_event_group_to_durable_ms']):.1f}ms",
                                flush=True,
                            )
                        except Exception as error:
                            row["status"] = "failed"
                            row["error_chunks"] = chunks(error)
                            metadata["failures"].append({
                                "sample": sample, "implementation": implementation,
                                "error_chunks": chunks(error), "at_utc": utc_now(),
                            })
                            persist()
                            raise
            metadata["status"] = "passed"
        finally:
            postgres.__exit__()
    except Exception as error:
        metadata["status"] = "failed"
        metadata["fatal_error_chunks"] = chunks(error)
        raise
    finally:
        metadata["finished_at_utc"] = utc_now()
        metadata["load_average_end"] = os.getloadavg()
        metadata["active_compilers_after"] = optional_command(["ps", "-axo", "pid,etime,pcpu,comm"])
        metadata["summary"] = build_summary(metadata)
        persist()


if __name__ == "__main__":
    main()
