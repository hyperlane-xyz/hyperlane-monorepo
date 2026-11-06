#!/usr/bin/env python3
"""Real scraper process + production Solidity/Anvil + guarded migrated Docker PG.

Called only by postgres.py before its disposable container cleanup. Never uses
an existing DB, provider, signer, or account: Anvil accounts are public fixtures.
"""
from __future__ import annotations
import argparse
import contextlib
import http.server
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import evm

DOMAIN = 99995

def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]

class ReceiptGate:
    def __init__(self, target, stall_all=False):
        self.target = target
        self.stall_all = stall_all
        self.release = threading.Event()
        self.started = threading.Event()
        self.requests = 0
        self.receipts_active = 0
        self.receipts_peak = 0
        self.held_hash = None
        self.release_held = threading.Event()
        self.lock = threading.Lock()
    def __enter__(self):
        owner = self
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("content-length", "0")))
                request = json.loads(body)
                with owner.lock:
                    owner.requests += 1
                if owner.stall_all:
                    owner.started.set()
                    owner.release.wait(25)
                if request.get("method") in ("eth_getTransactionReceipt", "eth_getTransactionByHash"):
                    transaction = request.get("params", [None])[0]
                    with owner.lock:
                        owner.receipts_active += 1
                        owner.receipts_peak = max(owner.receipts_peak, owner.receipts_active)
                        if owner.held_hash is None:
                            owner.held_hash = transaction
                    try:
                        owner.started.set()
                        owner.release.wait(25)
                        if transaction == owner.held_hash:
                            owner.release_held.wait(25)
                    finally:
                        with owner.lock:
                            owner.receipts_active -= 1
                try:
                    with urllib.request.urlopen(urllib.request.Request(owner.target, body, {"Content-Type": "application/json"}), timeout=5) as response:
                        data = response.read()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(data)))
                    self.send_header("Connection", "close")
                    self.end_headers()
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):
                    pass
            def log_message(self, *_):
                pass
        class Server(http.server.ThreadingHTTPServer):
            daemon_threads = True
        self.server = Server(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=.01), daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        return self
    def __exit__(self, *_):
        self.release.set()
        self.release_held.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True, type=Path)
    parser.add_argument("--container", required=True)
    parser.add_argument("--conninfo", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r"ziggy-pg-fixture-\d+", args.container):
        parser.error("guarded disposable container required")
    expected = f"host=127.0.0.1 port={args.port} dbname=ziggy user=ziggy connect_timeout=5 sslmode=disable"
    if args.conninfo != expected or not args.binary.is_file():
        parser.error("exact disposable connection and existing binary required")
    for command in ("anvil", "cast", "docker"):
        if not shutil.which(command):
            raise RuntimeError(f"missing fixture tool {command}")
    def sql(query):
        return evm.run(["docker", "exec", args.container, "psql", "-U", "ziggy", "-d", "ziggy", "-At", "-c", query])
    sql(f"INSERT INTO domain(id,time_created,time_updated,name,native_token,chain_id,is_test_net,is_deprecated) VALUES({DOMAIN},now(),now(),'scraperprocess','ETH',31337,true,false) ON CONFLICT(id) DO NOTHING")
    # The existing helper compiles these exact production/test contracts against
    # pinned OpenZeppelin4.9.3. Its cache is keyed by all compiler source bytes.
    evm.CONTRACTS["TestInterchainGasPaymaster"] = "solidity/contracts/test/TestInterchainGasPaymaster.sol"
    evm.CACHE.mkdir(parents=True, exist_ok=True)
    contracts = evm.compile_contracts()
    port = free_port()
    chain = evm.Chain(f"http://127.0.0.1:{port}")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="ziggy-scraper-process-") as folder:
        temp = Path(folder)
        with (args.output.parent / "scraper-anvil.log").open("w") as anvil_log:
            anvil = subprocess.Popen(["anvil", "--host", "127.0.0.1", "--port", str(port), "--chain-id", "31337", "--silent"], cwd=evm.ROOT, stdout=anvil_log, stderr=anvil_log)
            daemon = None
            stopped = []
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
                    raise RuntimeError("Anvil startup deadline")
                def deploy(name, signature=None, *values):
                    return chain.send("0x" + contracts[name] + (evm.abi(signature, *values) if signature else ""))["contractAddress"]
                mailbox = deploy("Mailbox", "constructor(uint32)", str(DOMAIN))
                hook = deploy("MerkleTreeHook", "constructor(address)", mailbox)
                required = deploy("TestPostDispatchHook")
                ism = deploy("TestIsm")
                recipient = deploy("TestRecipient")
                igp = deploy("TestInterchainGasPaymaster")
                chain.send(evm.calldata("initialize(address,address,address,address)", chain.account, ism, hook, required), mailbox)
                dispatch_topic = evm.run(["cast", "keccak", "Dispatch(address,uint32,bytes32,bytes)"])
                recipient32 = "0x" + "00" * 12 + recipient[2:]
                messages = []
                def produce(index):
                    receipt = chain.send(evm.calldata("dispatch(uint32,bytes32,bytes)", str(DOMAIN), recipient32, "0x" + f"scraper daemon {index}".encode().hex()), mailbox)
                    event = next(log for log in receipt["logs"] if log["address"].lower() == mailbox.lower() and log["topics"][0] == dispatch_topic)
                    data = bytes.fromhex(event["data"][2:])
                    length = int.from_bytes(data[32:64], "big")
                    message = "0x" + data[64:64 + length].hex()
                    message_id = evm.run(["cast", "keccak", message])
                    messages.append(message_id)
                    chain.send(evm.calldata("process(bytes,bytes)", "0x", message), mailbox)
                    chain.receipt(chain.rpc("eth_sendTransaction", [{"from": chain.account, "to": igp, "gas": "0xe00000", "value": hex(1000), "data": evm.calldata("payForGas(bytes32,uint32,uint256,address)", message_id, str(DOMAIN), "100", chain.account)}]))
                    return int(chain.rpc("eth_blockNumber"), 16)
                # Preserve deployed contracts while allowing a later fork to
                # replace every already-published message block in this fixture.
                branch_snapshot = chain.rpc("evm_snapshot")
                first_height = produce(1)
                with ReceiptGate(chain.url) as proxy:
                    config = temp / "config"
                    config.mkdir()
                    value = {"chainsToScrape": "scraperprocess", "db": args.conninfo, "dbMaxConnections": 3, "dbAcquireTimeoutMillis": 2000, "metricsPort": free_port(), "chains": {"scraperprocess": {"name": "scraperprocess", "domainId": DOMAIN, "chainId": 31337, "protocol": "ethereum", "rpcUrls": [{"http": proxy.url}], "rpcConsensusType": "single", "mailbox": mailbox, "validatorAnnounce": required, "merkleTreeHook": hook, "interchainGasPaymaster": igp, "blocks": {"reorgPeriod": 0}, "index": {"from": 0, "chunk": 50, "interval": 1}}}}
                    (config / "fixture.json").write_text(json.dumps(value))
                    env = {"PATH": os.environ.get("PATH", ""), "HYPERLANE_ZIG_DEFAULTS": str(config), "HYPERLANE_CURL_LIBRARY": "/usr/lib/libcurl.4.dylib" if os.uname().sysname == "Darwin" else "libcurl.so.4"}
                    def launch():
                        return subprocess.Popen([str(args.binary.resolve())], cwd=temp, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                    def wait_for(predicate, timeout=40):
                        until = time.monotonic() + timeout
                        while time.monotonic() < until:
                            if daemon.poll() is not None:
                                raise AssertionError(daemon.communicate())
                            if predicate():
                                return
                            time.sleep(.1)
                        raise AssertionError("scraper process fixture deadline")
                    def confirmed():
                        text = sql(f"SELECT confirmed_height FROM scraper_head WHERE domain={DOMAIN}")
                        return int(text) if text else -1
                    def complete(count):
                        query = f"SELECT (SELECT count(*) FROM message WHERE origin={DOMAIN} AND origin_tx_id IS NOT NULL),(SELECT count(*) FROM delivered_message WHERE domain={DOMAIN} AND destination_tx_id IS NOT NULL),(SELECT count(*) FROM gas_payment WHERE domain={DOMAIN} AND tx_id IS NOT NULL),(SELECT count(*) FROM merkle_tree_insertion WHERE domain={DOMAIN})"
                        return sql(query) == "|".join([str(count)] * 4)
                    def stop(proc, sig):
                        start = time.monotonic()
                        proc.send_signal(sig)
                        try:
                            stdout, stderr = proc.communicate(timeout=10)
                        except subprocess.TimeoutExpired:
                            proc.kill(); proc.communicate()
                            raise AssertionError("scraper did not drain within10s")
                        if proc.returncode != 0:
                            raise AssertionError(stderr)
                        with (args.output.parent / "scraper-daemon.log").open("a") as log:
                            log.write(stdout + stderr)
                        stopped.append({"signal": signal.Signals(sig).name, "drain_ms": round((time.monotonic() - start) * 1000)})
                    daemon = launch()
                    wait_for(lambda: confirmed() >= first_height and proxy.started.is_set())
                    second_height = produce(2)
                    wait_for(lambda: confirmed() >= second_height, timeout=10)
                    assert not proxy.release.is_set()
                    head_progress_while_receipts_stalled = True
                    wait_for(lambda: proxy.receipts_peak >= 4, timeout=10)
                    proxy.release.set()
                    # One hash remains blocked: successful sibling receipts must
                    # persist AND link before the retained page has fully retired.
                    def successful_neighbor_linked():
                        return int(sql(f"SELECT (SELECT count(*) FROM delivered_message WHERE domain={DOMAIN} AND destination_tx_id IS NOT NULL)+(SELECT count(*) FROM gas_payment WHERE domain={DOMAIN} AND tx_id IS NOT NULL)")) > 0
                    wait_for(successful_neighbor_linked, timeout=10)
                    assert not proxy.release_held.is_set()
                    neighbor_linked_while_one_hash_stalled = True
                    proxy.release_held.set()
                    wait_for(lambda: complete(2))
                    metrics_url = f"http://127.0.0.1:{value['metricsPort']}/metrics"
                    with urllib.request.urlopen(metrics_url, timeout=3) as response:
                        metrics_body = response.read()
                        assert response.status == 200
                        assert b'hyperlane_contract_sync_block_height{' in metrics_body
                        assert b'agent="scraper"' in metrics_body
                        assert b'hyperlane_baselib_version="3.0.0"' in metrics_body
                    with urllib.request.urlopen(urllib.request.Request(metrics_url, method="HEAD"), timeout=3) as response:
                        assert response.status == 200 and response.read() == b""
                        assert int(response.headers['content-length']) > 0
                    metrics_readback = {"get_status": 200, "head_status": 200, "body_bytes": len(metrics_body), "source_version": "3.0.0", "observed_chain_height_series": True}
                    stop(daemon, signal.SIGTERM)
                    daemon = None
                    before = sql(f"SELECT (SELECT count(*) FROM raw_message_dispatch WHERE origin_domain={DOMAIN}),(SELECT count(*) FROM message WHERE origin={DOMAIN}),(SELECT count(*) FROM delivered_message WHERE domain={DOMAIN}),(SELECT count(*) FROM gas_payment WHERE domain={DOMAIN}),(SELECT count(*) FROM merkle_tree_insertion WHERE domain={DOMAIN})")
                    # Equivalent to waiting the production writer-lease TTL. The
                    # process has joined before this fixture-only clock expiry.
                    sql(f"UPDATE scraper_head SET writer_lease_until=clock_timestamp()-interval '1 second' WHERE domain={DOMAIN}")
                    third_height = produce(3)
                    daemon = launch()
                    wait_for(lambda: confirmed() >= third_height and complete(3))
                    time.sleep(1)
                    after = sql(f"SELECT (SELECT count(*) FROM raw_message_dispatch WHERE origin_domain={DOMAIN}),(SELECT count(*) FROM message WHERE origin={DOMAIN}),(SELECT count(*) FROM delivered_message WHERE domain={DOMAIN}),(SELECT count(*) FROM gas_payment WHERE domain={DOMAIN}),(SELECT count(*) FROM merkle_tree_insertion WHERE domain={DOMAIN})")
                    assert before == "2|2|2|2|2", before
                    assert after == "3|3|3|3|3", after
                    stop(daemon, signal.SIGINT)
                    daemon = None
                    # Nine real TaskSet chains: first eight head identities
                    # stall, healthy ninth must still publish fresh canonical
                    # events through the same eight Supervisor workers.
                    healthy_domain = DOMAIN + 1
                    stalled_domains = list(range(DOMAIN + 2, DOMAIN + 10))
                    for domain in [healthy_domain] + stalled_domains:
                        sql(f"INSERT INTO domain(id,time_created,time_updated,name,native_token,chain_id,is_test_net,is_deprecated) VALUES({domain},now(),now(),'headproof{domain}','ETH',31337,true,false) ON CONFLICT(id) DO NOTHING")
                    healthy_mailbox = deploy("Mailbox", "constructor(uint32)", str(healthy_domain))
                    healthy_hook = deploy("MerkleTreeHook", "constructor(address)", healthy_mailbox)
                    chain.send(evm.calldata("initialize(address,address,address,address)", chain.account, ism, healthy_hook, required), healthy_mailbox)
                    fresh_receipt = chain.send(evm.calldata("dispatch(uint32,bytes32,bytes)", str(healthy_domain), recipient32, "0x68656164206f776e65722070726f6f66"), healthy_mailbox)
                    fresh_height = int(fresh_receipt["blockNumber"], 16)
                    with ReceiptGate(chain.url, stall_all=True) as stalled_rpc:
                        proof_value = {**value, "metricsPort": free_port(), "chains": {}}
                        names = [f"stalledhead{i}" for i in range(8)] + ["healthyhead9"]
                        for index, name in enumerate(names):
                            domain = stalled_domains[index] if index < 8 else healthy_domain
                            proof_value["chains"][name] = {**value["chains"]["scraperprocess"], "name": name, "domainId": domain, "rpcUrls": [{"http": stalled_rpc.url if index < 8 else chain.url}], "mailbox": healthy_mailbox, "merkleTreeHook": healthy_hook}
                        proof_value["chainsToScrape"] = ",".join(names)
                        (config / "fixture.json").write_text(json.dumps(proof_value))
                        head_start = time.monotonic()
                        daemon = launch()
                        wait_for(lambda: stalled_rpc.requests >= 8 and sql(f"SELECT confirmed_height FROM scraper_head WHERE domain={healthy_domain}") == str(fresh_height), timeout=10)
                        wait_for(lambda: sql(f"SELECT count(*) FROM merkle_tree_insertion WHERE domain={healthy_domain}") == "1", timeout=5)
                        rss_kib = int(evm.run(["ps", "-o", "rss=", "-p", str(daemon.pid)]).strip())
                        thread_count = len(evm.run(["ps", "-M", "-p", str(daemon.pid)]).splitlines()) - 1 if os.uname().sysname == "Darwin" else int(evm.run(["ps", "-o", "nlwp=", "-p", str(daemon.pid)]))
                        head_owner_proof = {"configured_chains": 9, "stalled_heads": 8, "observed_stalled_identity_requests": stalled_rpc.requests, "healthy_chain_position": 9, "fresh_height": fresh_height, "fresh_insertion_count": 1, "healthy_elapsed_ms": round((time.monotonic() - head_start) * 1000), "process_rss_kib": rss_kib, "process_threads_sampled": thread_count, "head_owner_stack_bytes_each": 1024 * 1024, "head_owner_threads_configured": 9, "supervisor_workers": 8}
                        stop(daemon, signal.SIGTERM)
                        daemon = None
                    (config / "fixture.json").write_text(json.dumps(value))
                    # A real canonical fork at/above the published frontier must
                    # halt every lane and exit nonzero, without deleting history.
                    assert chain.rpc("evm_revert", [branch_snapshot]) is True
                    while int(chain.rpc("eth_blockNumber"), 16) <= third_height:
                        chain.rpc("evm_mine")
                    sql(f"UPDATE scraper_head SET writer_lease_until=clock_timestamp()-interval '1 second' WHERE domain={DOMAIN}")
                    fatal_start = time.monotonic()
                    daemon = launch()
                    try:
                        fatal_stdout, fatal_stderr = daemon.communicate(timeout=15)
                    except subprocess.TimeoutExpired:
                        daemon.kill(); daemon.communicate()
                        raise AssertionError("published canonical fork did not terminate the scraper")
                    fatal_exit = daemon.returncode
                    with (args.output.parent / "scraper-daemon.log").open("a") as log:
                        log.write(fatal_stdout + fatal_stderr)
                    assert fatal_exit != 0 and "ScraperPublishedReorg" in fatal_stderr, (fatal_exit, fatal_stderr)
                    assert sql(f"SELECT halted FROM scraper_head WHERE domain={DOMAIN}") == "t"
                    assert sql(f"SELECT confirmed_height FROM scraper_head WHERE domain={DOMAIN}") == str(third_height)
                    assert sql(f"SELECT count(*) FROM raw_message_dispatch WHERE origin_domain={DOMAIN}") == "3"
                    fatal_reorg = {"exit_code": fatal_exit, "error": "ScraperPublishedReorg", "all_lanes_drained": True, "published_rows_preserved": 3, "database_halted": True, "exit_ms": round((time.monotonic() - fatal_start) * 1000)}
                    daemon = None
                    result = {"passed": True, "scope": "actual scraper process / production Solidity / Anvil / migrated PostgreSQL16; correctness, not throughput", "messages": messages, "first_run_counts": before, "restart_counts": after, "head_progress_while_receipts_stalled": head_progress_while_receipts_stalled, "receipt_concurrency_peak": proxy.receipts_peak, "neighbor_receipt_linked_while_one_hash_stalled": neighbor_linked_while_one_hash_stalled, "head_owner_liveness": head_owner_proof, "fixture_expired_stopped_writer_lease": True, "signals": stopped, "metrics": metrics_readback, "fatal_published_reorg": fatal_reorg, "proxy_rpc_requests": proxy.requests, "python_fixture_rpc_requests": chain.counter}
                    args.output.write_text(json.dumps(result, indent=2) + "\n")
                    print(json.dumps(result))
            finally:
                if daemon is not None and daemon.poll() is None:
                    daemon.terminate()
                    try: daemon.communicate(timeout=10)
                    except subprocess.TimeoutExpired: daemon.kill(); daemon.communicate()
                anvil.terminate()
                try: anvil.wait(timeout=5)
                except subprocess.TimeoutExpired: anvil.kill(); anvil.wait(timeout=5)

if __name__ == "__main__":
    main()
