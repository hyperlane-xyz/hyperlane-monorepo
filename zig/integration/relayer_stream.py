#!/usr/bin/env python3
"""Whole-CLI relayer WSS acceptance on local Anvil/Rust oracles/public key 0x11.

Functional correctness only: real RPC backfill, exact stream handshakes, pause/cutover,
fallback/recovery, multi-origin isolation, proof-bearing delivery, and durable restart.
No production network, credentials, deployment, or benchmark claim.
"""
from __future__ import annotations

import argparse
import base64
import collections
import contextlib
import copy
import hashlib
import http.server
import json
import pathlib
import shutil
import socket
import socketserver
import ssl
import struct
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

import evm
import relayer_process
from zig.integration import validator as validator_fixture
import tls_fixture

ROOT = evm.ROOT
ORIGIN_A, ORIGIN_B, DESTINATION = 9913371, 9913373, 9913372
CHAIN_IDS = {"test1": 31337, "test3": 31338, "test2": 31339}
DOMAINS = {"test1": ORIGIN_A, "test3": ORIGIN_B, "test2": DESTINATION}
DISPATCH_TOPIC = evm.run(["cast", "keccak", "Dispatch(address,uint32,bytes32,bytes)"])
DISPATCH_ID_TOPIC = evm.run(["cast", "keccak", "DispatchId(bytes32)"])
GAS_TOPIC = evm.run(["cast", "keccak", "GasPayment(bytes32,uint32,uint256,uint256)"])
EVENT_KINDS = ("dispatch", "merkle_tree_insertion", "gas_payment")


def chunks(value):
    if isinstance(value, str) and len(value) >= 64 and all(c in "0123456789abcdefABCDEFx" for c in value):
        return [value[index:index + 32] for index in range(0, len(value), 32)]
    if isinstance(value, dict):
        return {key: chunks(item) for key, item in value.items()}
    if isinstance(value, list):
        return [chunks(item) for item in value]
    return value


def sha(path):
    return chunks(hashlib.sha256(path.read_bytes()).hexdigest())


def wait(predicate, process, seconds, label):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if process is not None and process.poll() is not None:
            raise AssertionError(f"agent exited {process.returncode} while waiting for {label}")
        if predicate():
            return
        time.sleep(.05)
    raise AssertionError(f"deadline waiting for {label}")


def delivered(chain, mailbox, identity):
    data = evm.calldata("delivered(bytes32)", identity)
    return int(chain.rpc("eth_call", [{"to": mailbox, "data": data}, "latest"]), 16) == 1


def metrics(metrics_port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{metrics_port}/metrics", timeout=2) as response:
            return response.read().decode()
    except OSError:
        return ""


def stream_metric_lines(body):
    return [line for line in body.splitlines() if not line.startswith("#") and ("websocket" in line or "sync_source_active" in line)]


def websocket_readiness_evidence(body, stream, generation, launch_unix_seconds):
    base = 'agent="relayer",hyperlane_baselib_version="3.0.0"'
    chains = {}
    for chain in ("test1", "test3", "test2"):
        values = {}
        for family in ("active", "authority", "fresh"):
            name = f"hyperlane_relayer_scraper_websocket_{family}"
            values[family] = relayer_process.metric_value(body.encode(), name, f'chain="{chain}",{base}')
            assert values[family] == 1, (chain, family, values[family])
        chains[chain] = values
    assert generation > 0 and len(stream.sessions) > generation
    session = stream.sessions[generation]
    candidates = [item for item in stream.subscriptions if item["session"] == generation]
    assert len(candidates) == 1
    subscription = candidates[0]
    assert subscription["transport_session"] == session["transport_index"]
    assert session["replayed"] and not session["closed"] and subscription["session"] == generation and subscription["mode"] == "restart" and subscription["gas_version"] == 3
    assert all("allowReplay" not in cursor for item in subscription["ack"] for cursor in item.get("cursors", []))
    return {"mode": "current_websocket_authority_fresh_tls_generation", "launch_unix_seconds": launch_unix_seconds, "registry_scope": "current process admin registry", "chains": chains, "tls_session": session["transport_index"], "scenario_index": generation, "subscription": subscription}


def wait_websocket_ready(metrics_port, process, stream, generation):
    launched = getattr(process, "ziggy_launch_unix_seconds", None)
    assert launched is not None
    evidence = None
    def ready():
        nonlocal evidence
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{metrics_port}/list_operations?destination_domain={DESTINATION}", timeout=2) as response:
                operations = json.loads(response.read())
            if not isinstance(operations, list):
                return False
            evidence = websocket_readiness_evidence(metrics(metrics_port), stream, generation, launched)
            return True
        except (OSError, ValueError, AssertionError):
            return False
    wait(ready, process, 45, "current WS authority/fresh TLS generation readiness")
    return evidence


def websocket_readiness_contract_tests():
    base = 'agent="relayer",hyperlane_baselib_version="3.0.0"'
    lines = []
    for chain in ("test1", "test3", "test2"):
        for family in ("active", "authority", "fresh"):
            lines.append(f'hyperlane_relayer_scraper_websocket_{family}{{chain="{chain}",{base}}} 1')
    body = "\n".join(lines)
    class Stream:
        pass
    stream = Stream()
    stream.sessions = [{"replayed": True, "closed": False, "transport_index": 2}, {"replayed": True, "closed": False, "transport_index": 3}]
    stream.subscriptions = [{"session": 0, "transport_session": 2, "mode": "late", "gas_version": 3, "ack": []}, {"session": 1, "transport_session": 3, "mode": "restart", "gas_version": 3, "ack": []}]
    evidence = websocket_readiness_evidence(body, stream, 1, 100.0)
    assert evidence["tls_session"] == 3 and evidence["scenario_index"] == 1
    passed = ["current_ws_authority_fresh_tls_generation_accepted"]
    for label, mutate in [
        ("stale_tls_generation_rejected", lambda: stream.subscriptions.__setitem__(1, dict(stream.subscriptions[1], session=0))),
        ("ws_authority_not_current_rejected", lambda: None),
    ]:
        mutate()
        try:
            if label == "ws_authority_not_current_rejected":
                websocket_readiness_evidence(body.replace("websocket_authority", "websocket_authority_disabled", 1), stream, 1, 100.0)
            else:
                websocket_readiness_evidence(body, stream, 1, 100.0)
        except AssertionError:
            passed.append(label)
        else:
            raise AssertionError(f"WS readiness negative case accepted: {label}")
        stream.subscriptions[1]["session"] = 1
    return passed


class RpcProxy:
    def __init__(self, chain, name):
        self.chain = chain
        self.name = name
        self.methods = collections.Counter()
        self.event_methods = collections.Counter()
        self.forbidden = collections.Counter()
        self.raw_transactions = []
        self.broadcasts = []
        self.estimates = []
        self.rpc_log = []
        self.trace_lock = threading.Lock()
        self.receipt_inclusions = {}
        self.delivered_inclusions = {}
        self.forbid_addresses = set()
        self.forbid_all = False
        self.hold_chain_id = False
        self.chain_id_started = threading.Event()
        self.release_chain_id = threading.Event()
        self.stall_probe = False
        self.probe_stall_started = threading.Event()
        self.release_probe = threading.Event()
        self.stop = threading.Event()
        self.lock = threading.Lock()

    def __enter__(self):
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self):
                request = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
                method = request["method"]
                requested_unix_seconds = time.time()
                requested_monotonic_seconds = time.monotonic()
                params = request.get("params", [])
                address = ""
                if method == "eth_getLogs" and params:
                    address = str(params[0].get("address", "")).lower()
                with owner.lock:
                    owner.methods[method] += 1
                    if method == "eth_getLogs":
                        owner.event_methods[address or "all"] += 1
                    forbidden = method == "eth_getLogs" and (owner.forbid_all or address in owner.forbid_addresses)
                    if forbidden:
                        owner.forbidden[address or "all"] += 1
                if owner.hold_chain_id and method == "eth_chainId" and not owner.release_chain_id.is_set():
                    owner.chain_id_started.set()
                    owner.release_chain_id.wait(45)
                if owner.stall_probe and method in {"eth_blockNumber", "eth_call", "eth_getBlockByNumber"}:
                    owner.probe_stall_started.set()
                    owner.release_probe.wait(45)
                try:
                    if forbidden:
                        body = json.dumps({"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32000, "message": "event indexing forbidden after cutover"}}).encode()
                    else:
                        upstream = urllib.request.Request(owner.chain.url, data=json.dumps(request).encode(), headers={"Content-Type": "application/json"})
                        with urllib.request.urlopen(upstream, timeout=30) as response:
                            body = response.read()
                    with owner.lock:
                        relayer_process.capture_proxy_response(owner, method, request, body, requested_unix_seconds, requested_monotonic_seconds)
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError, urllib.error.URLError):
                    self.close_connection = True

            def log_message(self, *args):
                pass

        class Server(http.server.ThreadingHTTPServer):
            daemon_threads = True

        self.server = Server(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=.01), daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        return self

    def event_count(self, addresses=None):
        with self.lock:
            if addresses is None:
                return sum(self.event_methods.values())
            return sum(self.event_methods[address.lower()] for address in addresses)

    def forbidden_count(self):
        with self.lock:
            return sum(self.forbidden.values())

    def raw_count(self):
        with self.lock:
            return len(self.raw_transactions)

    def raw_since(self, index):
        with self.lock:
            return list(dict.fromkeys(self.raw_transactions[index:]))

    def __exit__(self, *args):
        self.stop.set()
        self.release_chain_id.set()
        self.release_probe.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)


class StreamServer:
    def __init__(self):
        self.rows = {domain: {kind: [] for kind in EVENT_KINDS} for domain in (ORIGIN_A, ORIGIN_B, DESTINATION)}
        self.sessions = []
        self.transports = []
        self.subscriptions = []
        self.errors = []
        self.lock = threading.RLock()
        self.stop = threading.Event()
        self.ready_gate = threading.Event()
        self.late_subscribed = threading.Event()
        self.late_replay_gate = threading.Event()
        self.previous_ack = None
        self.scenarios = ["legacy", "failed", "stale_ack", "malformed", "rejected", "freshness", "disconnect", "v3", "late", "restart"]

    def commit_session(self, session):
        # Caller holds self.lock. Transport retries cannot spend a scenario.
        assert session["index"] is None and len(self.sessions) == session["candidate_index"], "stale scenario attempt"
        session["index"] = session["candidate_index"]
        self.sessions.append(session)

    def record_subscription(self, session, message, streams, ack_streams, gas_version):
        # Startup origin readiness may legitimately create partial subscriptions.
        # ACK/replay those on their own transport, but reserve logical scenarios
        # for the exact domain coverage that the fixture is about to exercise.
        assert not session["subscribed"], "duplicate subscription"
        assert session["index"] is None and len(self.sessions) == session["candidate_index"], "stale scenario attempt"
        expected_kinds = EVENT_KINDS[:2] if gas_version == 2 else EVENT_KINDS
        assert [item["eventType"] for item in streams] == list(expected_kinds), "subscription stream coverage"
        required = {ORIGIN_A, DESTINATION} if session["candidate_index"] <= 7 else {ORIGIN_A, ORIGIN_B, DESTINATION}
        coverage = None
        for item in streams:
            domains = item.get("domains")
            cursors = item.get("cursors")
            assert isinstance(domains, list) and isinstance(cursors, list), "subscription domain/cursor lists"
            assert all(type(domain) is int for domain in domains) and len(domains) == len(set(domains)), "duplicate/invalid subscription domain"
            domains = set(domains)
            assert domains <= required, "foreign subscription domain"
            cursor_domains = [cursor["domain"] for cursor in cursors]
            assert all(type(domain) is int for domain in cursor_domains) and len(cursor_domains) == len(set(cursor_domains)), "duplicate/invalid subscription cursor"
            assert set(cursor_domains) == domains, "subscription domain/cursor coverage"
            if coverage is None:
                coverage = domains
            assert domains == coverage, "inconsistent subscription domain coverage"
        complete = coverage == required
        if complete:
            self.commit_session(session)
        subscription = {"session": session["index"], "transport_session": session["transport_index"], "mode": session["mode"], "gas_version": gas_version, "message": copy.deepcopy(message), "ack": copy.deepcopy(ack_streams)}
        session["subscription"] = subscription
        session["subscribed"] = True
        if complete:
            self.subscriptions.append(subscription)
        return complete

    def __enter__(self):
        owner = self

        class Handler(socketserver.BaseRequestHandler):
            def handle(self):
                connection = self.request
                connection.settimeout(.5)
                session = None
                try:
                    header = b""
                    while b"\r\n\r\n" not in header:
                        part = connection.recv(1)
                        if not part:
                            raise ConnectionError("EOF before upgrade")
                        header += part
                    fields = {key.strip().lower(): value.strip() for key, value in (line.split(":", 1) for line in header.decode().split("\r\n")[1:] if ":" in line)}
                    accept = base64.b64encode(hashlib.sha1((fields["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
                    with owner.lock:
                        index = len(owner.sessions)
                        mode = owner.scenarios[index] if index < len(owner.scenarios) else "healthy"
                        # A startup reconnect before subscribe is a transport attempt,
                        # not completion of the mandatory legacy scenario.
                        session = {"index": None, "candidate_index": index, "subscription": None, "transport_index": len(owner.transports), "mode": mode, "connection": connection, "lock": threading.Lock(), "closed": False, "subscribed": False, "replayed": False, "pong": threading.Event(), "sent": {}}
                        owner.transports.append(session)
                    if mode == "legacy":
                        while not owner.ready_gate.wait(.1):
                            if owner.stop.is_set():
                                return
                    if owner.stop.is_set():
                        return
                    connection.sendall(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n").encode())
                    if mode == "failed":
                        # This scenario intentionally fails before subscribe.
                        with owner.lock:
                            owner.commit_session(session)
                        return
                    gas_version = 2 if mode == "legacy" else 3
                    owner.send(session, {"type": "ready", "streamCursorVersions": {"gas_payment": gas_version}})
                    while not owner.stop.is_set():
                        try:
                            opcode, data = owner.receive(connection)
                        except TimeoutError:
                            continue
                        if opcode == 8:
                            return
                        if opcode == 9:
                            owner.frame(session, 10, data)
                            continue
                        if opcode == 10:
                            session["pong"].set()
                            continue
                        if opcode != 1:
                            continue
                        message = json.loads(data)
                        assert message["type"] == "subscribe"
                        streams = copy.deepcopy(message["streams"])
                        ack_streams = copy.deepcopy(streams)
                        for stream in ack_streams:
                            for cursor in stream.get("cursors", []):
                                cursor.pop("allowReplay", None)
                        with owner.lock:
                            committed = owner.record_subscription(session, message, streams, ack_streams, gas_version)
                        if mode == "stale_ack" and committed:
                            assert owner.previous_ack is not None
                            owner.send(session, {"type": "subscribed", "streams": owner.previous_ack})
                            return
                        if mode == "rejected" and committed:
                            wrong = copy.deepcopy(ack_streams)
                            wrong[0]["cursors"][0]["afterSequence"] = "9223372036854775807"
                            owner.send(session, {"type": "subscribed", "streams": wrong})
                            return
                        owner.send(session, {"type": "subscribed", "streams": ack_streams})
                        if committed:
                            with owner.lock:
                                owner.previous_ack = copy.deepcopy(ack_streams)
                        session["ack"] = copy.deepcopy(ack_streams)
                        if mode == "freshness" and committed:
                            domain = streams[0]["cursors"][0]["domain"]
                            address = streams[0]["cursors"][0]["address"]
                            owner.send(session, {"type": "caught_up", "address": address, "domain": domain, "eventType": "dispatch", "sequence": "-1"})
                            return
                        if mode == "late" and committed:
                            owner.late_subscribed.set()
                            while not owner.late_replay_gate.wait(.1):
                                if owner.stop.is_set():
                                    return
                        owner.replay(session)
                        session["replayed"] = True
                        if mode == "malformed" and committed:
                            owner.frame(session, 1, b"{not-json")
                            return
                        if mode == "disconnect" and committed:
                            return
                    return
                except (ConnectionError, OSError, TimeoutError):
                    pass
                except BaseException as error:
                    with owner.lock:
                        owner.errors.append({"session": None if session is None else session["index"], "type": type(error).__name__})
                finally:
                    if session is not None:
                        session["closed"] = True

        class Server(socketserver.ThreadingTCPServer):
            allow_reuse_address = True
            daemon_threads = True

        with contextlib.ExitStack() as resources:
            self.ca_path, key_path = resources.enter_context(tls_fixture.certificate())
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(self.ca_path, key_path)
            self.server = Server(("127.0.0.1", 0), Handler)
            resources.callback(self.server.server_close)
            self.server.socket = context.wrap_socket(self.server.socket, server_side=True)
            self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=.02), daemon=True)
            self.thread.start()
            self.url = f"wss://localhost:{self.server.server_address[1]}/events"
            self.resources = resources.pop_all()
        return self

    @staticmethod
    def exact(connection, count):
        data = b""
        while len(data) < count:
            part = connection.recv(count - len(data))
            if not part:
                raise ConnectionError("EOF")
            data += part
        return data

    @classmethod
    def receive(cls, connection):
        first, second = cls.exact(connection, 2)
        length = second & 127
        if length == 126:
            length = struct.unpack("!H", cls.exact(connection, 2))[0]
        elif length == 127:
            length = struct.unpack("!Q", cls.exact(connection, 8))[0]
        assert length <= 2 * 1024 * 1024
        mask = cls.exact(connection, 4) if second & 128 else None
        data = cls.exact(connection, length)
        if mask:
            data = bytes(value ^ mask[index % 4] for index, value in enumerate(data))
        return first & 15, data

    def frame(self, session, opcode, data):
        header = bytes([128 | opcode])
        length = len(data)
        header += bytes([length]) if length < 126 else b"\x7e" + struct.pack("!H", length) if length < 65536 else b"\x7f" + struct.pack("!Q", length)
        with session["lock"]:
            session["connection"].sendall(header + data)

    def send(self, session, value):
        self.frame(session, 1, json.dumps(value, separators=(",", ":")).encode())

    def add(self, domain, kind, sequence, data, envelope=None):
        row = {"type": "event", "domain": domain, "eventType": kind, "data": data}
        row.update(envelope or ({"sequence": str(sequence)} if kind != "gas_payment" else {}))
        self.rows[domain][kind].append(row)

    def replay(self, session):
        subscription = session["subscription"]
        for stream in subscription["message"]["streams"]:
            kind = stream["eventType"]
            cursor_field = "afterSequence" if kind != "gas_payment" else "afterStreamCursor"
            for cursor in stream.get("cursors", []):
                domain = cursor["domain"]
                key = (domain, kind)
                after = int(cursor[cursor_field]) if cursor_field in cursor else None
                rows = self.rows[domain][kind]
                if after is not None:
                    for row in rows:
                        sequence = int(row["sequence"] if kind != "gas_payment" else row["streamCursor"])
                        if sequence > after:
                            self.send(session, row)
                latest = int(rows[-1]["sequence"] if kind != "gas_payment" else rows[-1]["streamCursor"]) if rows else (0 if kind == "gas_payment" else -1)
                session["sent"][key] = latest
                marker = {"type": "caught_up", "address": cursor["address"], "domain": domain, "eventType": kind}
                if kind == "gas_payment":
                    marker.update(legacyMaxStreamCursor="0", streamCursor=str(latest))
                else:
                    marker["sequence"] = str(latest)
                self.send(session, marker)

    def publish(self, domain):
        with self.lock:
            for session in self.transports:
                if not session["subscribed"] or not session["replayed"] or session["closed"]:
                    continue
                subscription = session["subscription"]
                for stream in subscription["message"]["streams"]:
                    kind = stream["eventType"]
                    if not any(cursor["domain"] == domain for cursor in stream.get("cursors", [])):
                        continue
                    key = (domain, kind)
                    after = session["sent"].get(key, -1)
                    for row in self.rows[domain][kind]:
                        sequence = int(row["sequence"] if kind != "gas_payment" else row["streamCursor"])
                        if sequence > after:
                            try:
                                self.send(session, row)
                                session["sent"][key] = sequence
                            except OSError:
                                session["closed"] = True

    def close_session(self, index):
        with self.lock:
            session = self.sessions[index]
        try:
            session["connection"].shutdown(socket.SHUT_RDWR)
        except OSError:
            pass

    def ping(self, index):
        session = self.sessions[index]
        session["pong"].clear()
        self.frame(session, 9, b"fixture-health")
        return session["pong"].wait(3)

    def session_closed(self, index):
        with self.lock:
            return len(self.sessions) > index and self.sessions[index]["closed"]

    def __exit__(self, *args):
        self.stop.set()
        self.ready_gate.set()
        self.late_replay_gate.set()
        with self.lock:
            sessions = list(self.transports)
        for session in sessions:
            try:
                session["connection"].shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)
        self.resources.close()


class Anvil:
    def __init__(self, name, log):
        self.name = name
        self.chain = evm.Chain(f"http://127.0.0.1:{relayer_process.port()}")
        self.process = relayer_process.subprocess.Popen(["anvil", "--host", "127.0.0.1", "--port", self.chain.url.rsplit(":", 1)[1], "--chain-id", str(CHAIN_IDS[name]), "--silent"], cwd=ROOT, stdout=log, stderr=log)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise AssertionError(f"Anvil {name} exited during startup")
            try:
                self.chain.account = self.chain.rpc("eth_accounts")[0]
                break
            except (ConnectionError, urllib.error.URLError):
                time.sleep(.05)
        else:
            raise AssertionError(f"Anvil {name} readiness deadline")

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
        try:
            self.process.wait(timeout=5)
        except relayer_process.subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()


def deploy(chain, contracts, name, signature=None, *values):
    return chain.send("0x" + contracts[name] + (evm.abi(signature, *values) if signature else ""))["contractAddress"]


def chain_settings(name, contracts):
    chain = contracts["anvils"][name].chain
    mailbox = deploy(chain, contracts["bytecode"], "Mailbox", "constructor(uint32)", str(DOMAINS[name]))
    hook = deploy(chain, contracts["bytecode"], "MerkleTreeHook", "constructor(address)", mailbox)
    announce = deploy(chain, contracts["bytecode"], "ValidatorAnnounce", "constructor(address)", mailbox)
    igp = deploy(chain, contracts["bytecode"], "InterchainGasPaymaster")
    chain.send(evm.calldata("initialize(address,address)", chain.account, chain.account), igp)
    null = deploy(chain, contracts["bytecode"], "TestIsm")
    required = deploy(chain, contracts["bytecode"], "TestPostDispatchHook")
    chain.send(evm.calldata("initialize(address,address,address,address)", chain.account, null, hook, required), mailbox)
    oracle = deploy(chain, contracts["bytecode"], "StorageGasOracle")
    chain.send(evm.calldata("setRemoteGasData((uint32,uint128,uint128))", f"({DESTINATION},10000000000,1)"), oracle)
    chain.send(evm.calldata("setDestinationGasConfigs((uint32,(address,uint96))[])", f"[({DESTINATION},({oracle},0))]"), igp)
    chain.rpc("anvil_setBalance", [evm.TEST_SIGNER, hex(100 * 10**18)])
    return {"name": name, "domainId": DOMAINS[name], "chainId": CHAIN_IDS[name], "protocol": "ethereum", "rpcUrls": [{"http": chain.url}], "mailbox": mailbox, "merkleTreeHook": hook, "validatorAnnounce": announce, "interchainGasPaymaster": igp, "blocks": {"reorgPeriod": 0, "confirmations": 0, "estimateBlockTime": 1}, "index": {"from": 0, "interval": 1}, "signer": {"type": "hexKey", "key": "0x" + "11" * 32}}


def validator_config(binary, name, settings, temporary, logs, agents, url_library):
    directory = temporary / f"validator-{name}-config"
    directory.mkdir()
    checkpoints = temporary / f"validator-{name}-checkpoints"
    value = {"originChainName": name, "db": str(temporary / f"validator-{name}-db"), "validator": {"key": "0x" + "11" * 32}, "checkpointSyncer": {"type": "localStorage", "path": str(checkpoints)}, "interval": 1, "metricsPort": relayer_process.port(), "chains": {name: settings}}
    (directory / "public.json").write_text(json.dumps(value))
    log = (temporary / f"validator-{name}.log").open("w")
    logs.append(log)
    process = relayer_process.launch(binary, directory, log, {"HYPERLANE_URL_LIBRARY": url_library["pinned_path"]})
    agents.append(process)
    return process, checkpoints


def rust_vectors(reference, messages):
    result = relayer_process.subprocess.run([str(reference), "vectors"], input="".join(message["wire"] + "\n" for message in messages), cwd=ROOT, env={}, text=True, capture_output=True, timeout=30)
    if result.returncode:
        raise AssertionError("Rust vector oracle failed")
    rows = [json.loads(line) for line in result.stdout.splitlines()]
    assert len(rows) == len(messages) and all("error" not in row for row in rows)
    return rows


def probe(oracle, database, origin_name, count):
    domain = DOMAINS[origin_name]
    result = relayer_process.subprocess.run([str(oracle), "relayer-probe", str(database), str(domain), origin_name, str(DESTINATION), "test2", str(count)], cwd=ROOT, env={}, capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise AssertionError("stopped Rust RocksDB readback failed")
    return json.loads(result.stdout)


def wait_quiet(proxy, addresses, process, label, stable=2.5, timeout=45):
    began = time.monotonic()
    previous = proxy.event_count(addresses)
    changed = time.monotonic()
    while time.monotonic() - began < timeout:
        if process.poll() is not None:
            raise AssertionError(f"agent exited while waiting for {label}")
        current = proxy.event_count(addresses)
        if current != previous:
            previous = current
            changed = time.monotonic()
        if time.monotonic() - changed >= stable:
            return current
        time.sleep(.05)
    raise AssertionError(f"deadline waiting for {label}")


def event_addresses(settings, name):
    chain = settings[name]
    return [chain["mailbox"].lower(), chain["merkleTreeHook"].lower(), chain["interchainGasPaymaster"].lower()]


def run_acceptance(binary, validator_binary, oracle, reference, contracts, temporary, output, url_library):
    anvils = {}
    agents = []
    logs = []
    messages = {"test1": [], "test3": []}
    try:
        for name in ("test1", "test3", "test2"):
            log = (temporary / f"anvil-{name}.log").open("w")
            logs.append(log)
            anvils[name] = Anvil(name, log)
        fixture = {"anvils": anvils, "bytecode": contracts}
        settings = {name: chain_settings(name, fixture) for name in ("test1", "test3", "test2")}
        destination = anvils["test2"].chain
        merkle_ism = deploy(destination, contracts, "StorageMerkleRootMultisigIsm", "constructor(address[],uint8)", f"[{evm.TEST_SIGNER}]", "1")
        recipient = deploy(destination, contracts, "TestRecipient")
        destination.send(evm.calldata("setInterchainSecurityModule(address)", merkle_ism), recipient)
        recipient32 = "0x" + "00" * 12 + recipient[2:]

        with StreamServer() as stream:
            def produce(name, label, publish=True):
                chain = anvils[name].chain
                chain_settings_value = settings[name]
                receipt = chain.send(evm.calldata("dispatch(uint32,bytes32,bytes)", str(DESTINATION), recipient32, "0x" + label.encode().hex()), chain_settings_value["mailbox"])
                dispatch_event = next(value for value in receipt["logs"] if value["address"].lower() == chain_settings_value["mailbox"].lower() and value["topics"][0].lower() == DISPATCH_TOPIC.lower())
                identity_event = next(value for value in receipt["logs"] if value["address"].lower() == chain_settings_value["mailbox"].lower() and value["topics"][0].lower() == DISPATCH_ID_TOPIC.lower())
                identity = identity_event["topics"][1]
                raw = bytes.fromhex(dispatch_event["data"][2:])
                wire = raw[64:64 + int.from_bytes(raw[32:64], "big")]
                nonce = int.from_bytes(wire[1:5], "big")
                origin = int.from_bytes(wire[5:9], "big")
                sender = "0x" + wire[9:41].hex()
                target = int.from_bytes(wire[41:45], "big")
                target_recipient = "0x" + wire[45:77].hex()
                body = "0x" + wire[77:].hex()
                assert nonce == len(messages[name]) and origin == DOMAINS[name] and target == DESTINATION
                quote_data = evm.calldata("quoteGasPayment(uint32,uint256)", str(DESTINATION), "500000")
                quote = int(chain.rpc("eth_call", [{"to": chain_settings_value["interchainGasPaymaster"], "data": quote_data}, "latest"]), 16)
                payment_receipt = chain.receipt(chain.rpc("eth_sendTransaction", [{"from": chain.account, "to": chain_settings_value["interchainGasPaymaster"], "data": evm.calldata("payForGas(bytes32,uint32,uint256,address)", identity, str(DESTINATION), "500000", chain.account), "value": hex(quote), "gas": "0xe00000"}]))
                gas_event = next(value for value in payment_receipt["logs"] if value["address"].lower() == chain_settings_value["interchainGasPaymaster"].lower() and value["topics"][0].lower() == GAS_TOPIC.lower())
                assert gas_event["topics"][1].lower() == identity.lower()
                gas_data = bytes.fromhex(gas_event["data"][2:])
                gas_amount = int.from_bytes(gas_data[:32], "big")
                payment = int.from_bytes(gas_data[32:64], "big")
                gas_sequence = len(stream.rows[DOMAINS[name]]["gas_payment"]) + 1
                stream.add(DOMAINS[name], "dispatch", nonce, {"destination_domain": target, "id": str(nonce + 1), "msg_body": body, "msg_id": identity, "nonce": str(nonce), "origin_block_hash": receipt["blockHash"], "origin_block_height": str(int(receipt["blockNumber"], 16)), "origin_domain": origin, "origin_mailbox": chain_settings_value["mailbox"], "origin_tx_hash": receipt["transactionHash"], "recipient": target_recipient, "sender": sender, "time_created": "2026-01-01T00:00:00Z"})
                stream.add(DOMAINS[name], "merkle_tree_insertion", nonce, {"block_number": str(int(receipt["blockNumber"], 16)), "domain": origin, "leaf_index": str(nonce), "merkle_tree_hook": chain_settings_value["merkleTreeHook"], "message_id": identity})
                stream.add(DOMAINS[name], "gas_payment", gas_sequence, {"destination": target, "domain": origin, "gas_amount": str(gas_amount), "id": str(gas_sequence), "interchain_gas_paymaster": chain_settings_value["interchainGasPaymaster"], "log_index": str(int(gas_event["logIndex"], 16)), "msg_id": identity, "origin": origin, "origin_block_hash": payment_receipt["blockHash"], "origin_block_height": str(int(payment_receipt["blockNumber"], 16)), "origin_tx_hash": payment_receipt["transactionHash"], "payment": str(payment), "sequence": str(nonce), "time_created": "2026-01-01T00:00:00Z", "tx_id": None}, {"legacyMaxStreamCursor": "0", "rowId": str(gas_sequence), "streamCursor": str(gas_sequence)})
                record = {"nonce": nonce, "id": identity, "wire": wire.hex(), "label": label, "dispatch_block": int(receipt["blockNumber"], 16), "gas_block": int(payment_receipt["blockNumber"], 16), "publish": publish}
                messages[name].append(record)
                if publish:
                    stream.publish(DOMAINS[name])
                return record

            produce("test1", "rpc-backfill-a0")
            produce("test3", "rpc-backfill-b0")
            validators = {}
            for name in ("test1", "test3"):
                process, checkpoints = validator_config(validator_binary, name, settings[name], temporary, logs, agents, url_library)
                validators[name] = {"process": process, "checkpoints": checkpoints}
                wait(lambda: (checkpoints / "0_with_id.json").exists(), process, 45, f"{name} initial validator checkpoint")

            with RpcProxy(anvils["test1"].chain, "test1") as rpc_a, RpcProxy(anvils["test3"].chain, "test3") as rpc_b, RpcProxy(destination, "test2") as rpc_destination:
                configured = copy.deepcopy(settings)
                configured["test1"]["rpcUrls"] = [{"http": rpc_a.url}]
                configured["test3"]["rpcUrls"] = [{"http": rpc_b.url}]
                configured["test2"]["rpcUrls"] = [{"http": rpc_destination.url}]
                rpc_b.hold_chain_id = True
                config_dir = temporary / "relayer-config"
                config_dir.mkdir()
                database = temporary / "relayer-db"
                metrics_port = relayer_process.port()
                relayer_settings = {"relayChains": "test1,test3,test2", "db": str(database), "allowLocalCheckpointSyncers": True, "gasPaymentEnforcement": [{"type": "none"}], "metricsPort": metrics_port, "websocketUrl": stream.url, "websocketAuthorityEnabled": True, "chains": configured}
                (config_dir / "public.json").write_text(json.dumps(relayer_settings))
                def observe(record, process, label):
                    relayer_process.observe_inclusions(lambda identity: delivered(destination, settings["test2"]["mailbox"], identity), [record], process, label, rpc_destination, destination, settings["test2"]["mailbox"])
                log = (temporary / "relayer-first.log").open("w")
                logs.append(log)
                running = relayer_process.launch(binary, config_dir, log, {"SSL_CERT_FILE": str(stream.ca_path)})
                agents.append(running)
                observe(messages["test1"][0], running, "initial RPC dispatch/proof delivery")
                assert rpc_a.event_count() > 0 and rpc_b.chain_id_started.is_set()
                initial_rpc = dict(rpc_a.methods)
                assert not delivered(destination, settings["test2"]["mailbox"], messages["test3"][0]["id"])
                stream.ready_gate.set()

                a_addresses = event_addresses(settings, "test1")
                b_addresses = event_addresses(settings, "test3")
                d_addresses = event_addresses(settings, "test2")
                wait(lambda: stream.session_closed(0) is False and len(stream.subscriptions) >= 1 and stream.sessions[0]["replayed"], running, 30, "legacy v2 replay")
                legacy_subscription = stream.subscriptions[0]
                assert legacy_subscription["gas_version"] == 2 and [item["eventType"] for item in legacy_subscription["message"]["streams"]] == ["dispatch", "merkle_tree_insertion"]
                assert all({cursor["domain"] for cursor in item["cursors"]} == {ORIGIN_A, DESTINATION} for item in legacy_subscription["message"]["streams"])
                assert all("afterSequence" not in cursor for item in legacy_subscription["message"]["streams"] for cursor in item["cursors"])
                assert all("allowReplay" not in cursor for item in legacy_subscription["ack"] for cursor in item.get("cursors", []))
                legacy_a_baseline = wait_quiet(rpc_a, a_addresses[:2], running, "legacy pause ACK/cutover")
                legacy_d_baseline = wait_quiet(rpc_destination, d_addresses[:2], running, "legacy destination-origin cutover")
                rpc_a.forbid_addresses = set(a_addresses[:2])
                rpc_destination.forbid_addresses = set(d_addresses[:2])
                produce("test1", "legacy-live-a1")
                wait(lambda: delivered(destination, settings["test2"]["mailbox"], messages["test1"][1]["id"]), running, 60, "legacy v2 live delivery")
                time.sleep(2)
                assert rpc_a.event_count(a_addresses[:2]) == legacy_a_baseline and rpc_a.forbidden_count() == 0
                assert rpc_destination.event_count(d_addresses[:2]) == legacy_d_baseline and rpc_destination.forbidden_count() == 0
                rpc_a.forbid_addresses = set()
                rpc_destination.forbid_addresses = set()

                fault_cases = []
                stream.close_session(0)
                for index, label in [(1, "failed-rpc-a2"), (2, "stale-ack-rpc-a3"), (3, "malformed-rpc-a4"), (4, "rejected-rpc-a5"), (5, "freshness-rpc-a6"), (6, "disconnect-rpc-a7")]:
                    wait(lambda: stream.session_closed(index), running, 45, f"fault session {index} completed")
                    before = rpc_a.event_count()
                    produce("test1", label)
                    expected = len(messages["test1"]) - 1
                    wait(lambda: delivered(destination, settings["test2"]["mailbox"], messages["test1"][expected]["id"]), running, 75, f"RPC fallback after {stream.scenarios[index]}")
                    assert rpc_a.event_count() > before, (stream.scenarios[index], dict(rpc_a.methods))
                    fault_cases.append({"session": index, "mode": stream.scenarios[index], "rpc_fallback_delivery": expected, "event_calls_before": before, "event_calls_after": rpc_a.event_count()})

                wait(lambda: len(stream.sessions) > 7 and stream.sessions[7]["replayed"], running, 45, "v3 replay after disconnect")
                v3_subscription = stream.subscriptions[-1]
                assert v3_subscription["gas_version"] == 3 and [item["eventType"] for item in v3_subscription["message"]["streams"]] == list(EVENT_KINDS)
                v3_a_baseline = wait_quiet(rpc_a, a_addresses, running, "v3 all-stream pause ACK/cutover")
                v3_d_baseline = wait_quiet(rpc_destination, d_addresses, running, "v3 destination-origin pause ACK/cutover")
                rpc_a.forbid_all = True
                rpc_destination.forbid_all = True
                v3_record = produce("test1", "v3-live-a8")
                wait(lambda: delivered(destination, settings["test2"]["mailbox"], v3_record["id"]), running, 60, "v3 dispatch/insertion/gas live delivery")
                time.sleep(2)
                assert rpc_a.event_count() == v3_a_baseline and rpc_a.forbidden_count() == 0
                assert rpc_destination.event_count() == v3_d_baseline and rpc_destination.forbidden_count() == 0
                healthy_v3 = {"session": 7, "origin_a_event_calls_at_cutover": v3_a_baseline, "destination_event_calls_at_cutover": v3_d_baseline, "origin_a_event_calls_after_live_delivery": rpc_a.event_count(), "destination_event_calls_after_live_delivery": rpc_destination.event_count(), "forbidden_calls": rpc_a.forbidden_count() + rpc_destination.forbidden_count(), "live_nonce": v3_record["nonce"]}
                rpc_a.forbid_all = False
                rpc_destination.forbid_all = False

                rpc_b.release_chain_id.set()
                wait(lambda: stream.late_subscribed.is_set(), running, 45, "late origin expanded resubscription")
                wait(lambda: delivered(destination, settings["test2"]["mailbox"], messages["test3"][0]["id"]), running, 75, "late origin initial RPC delivery")
                expanded = stream.subscriptions[-1]["message"]["streams"]
                assert all({cursor["domain"] for cursor in item["cursors"]} == {ORIGIN_A, ORIGIN_B, DESTINATION} for item in expanded)
                rpc_b.stall_probe = True
                stream.late_replay_gate.set()
                wait(lambda: rpc_b.probe_stall_started.is_set(), running, 30, "independent stalled canonical probe")
                wait_quiet(rpc_a, a_addresses, running, "healthy neighbor cutover during stalled peer")
                wait_quiet(rpc_destination, d_addresses, running, "healthy destination-origin cutover during stalled peer")
                rpc_a.forbid_all = True
                rpc_destination.forbid_all = True
                neighbor_record = produce("test1", "healthy-neighbor-during-probe-stall-a9")
                wait(lambda: delivered(destination, settings["test2"]["mailbox"], neighbor_record["id"]), running, 60, "healthy origin progress during peer probe stall")
                assert stream.ping(8), "socket HTTP/WebSocket handling blocked by canonical probe"
                hidden = produce("test1", "withheld-until-restart-a10", publish=False)
                time.sleep(2)
                assert not delivered(destination, settings["test2"]["mailbox"], hidden["id"])
                assert rpc_a.forbidden_count() == 0 and rpc_destination.forbidden_count() == 0
                first_stop = relayer_process.stop(running)
                assert first_stop["exit"] == 0 and first_stop["milliseconds"] < 3000, first_stop
                rpc_b.stall_probe = False
                rpc_b.release_probe.set()
                rpc_a.forbid_all = False
                rpc_destination.forbid_all = False

                first_a = probe(oracle, database, "test1", len(messages["test1"]))
                first_b = probe(oracle, database, "test3", len(messages["test3"]))
                relayer_process.persist_progress(output, "stream-first-stopped-readback", {"destination":rpc_destination}, stopped_rust_readback={"test1":first_a,"test3":first_b}, first_stop=first_stop)
                assert all(row["present"] and row["insertion_id_chunks"] and row["payment"] and row["payloads"] for row in first_a["messages"][:-1])
                assert not first_a["messages"][-1]["present"]
                assert first_b["messages"][0]["present"] and first_b["messages"][0]["insertion_id_chunks"] and first_b["messages"][0]["payment"] and first_b["messages"][0]["payloads"]
                nonce_before_restart = int(destination.rpc("eth_getTransactionCount", [evm.TEST_SIGNER, "latest"]), 16)
                balance_before_restart = int(destination.rpc("eth_getBalance", [evm.TEST_SIGNER, "latest"]), 16)
                raw_before_restart = rpc_destination.raw_count()

                log = (temporary / "relayer-restart.log").open("w")
                logs.append(log)
                restarted = relayer_process.launch(binary, config_dir, log, {"SSL_CERT_FILE": str(stream.ca_path)})
                agents.append(restarted)
                observe(hidden, restarted, "restart replay/proof delivery")
                assert int(destination.rpc("eth_getTransactionCount", [evm.TEST_SIGNER, "latest"]), 16) == nonce_before_restart + 1
                wait(lambda: len(stream.sessions) > 9 and stream.sessions[9]["replayed"], restarted, 30, "restart subscriptions")
                restart_subscription = stream.subscriptions[-1]["message"]["streams"]
                readiness = wait_websocket_ready(metrics_port, restarted, stream, 9)
                for stream_value in restart_subscription:
                    cursors = {cursor["domain"]: cursor for cursor in stream_value["cursors"]}
                    if stream_value["eventType"] == "gas_payment":
                        assert cursors[ORIGIN_A]["afterStreamCursor"] == str(hidden["nonce"])
                        assert cursors[ORIGIN_B]["afterStreamCursor"] == "1"
                        assert cursors[DESTINATION]["afterStreamCursor"] == "0"
                    else:
                        assert cursors[ORIGIN_A]["afterSequence"] == str(hidden["nonce"] - 2)
                        assert cursors[ORIGIN_B]["afterSequence"] == "-1"
                        assert "afterSequence" not in cursors[DESTINATION]
                wait_quiet(rpc_a, a_addresses, restarted, "restart origin A cutover")
                wait_quiet(rpc_b, b_addresses, restarted, "restart origin B cutover")
                wait_quiet(rpc_destination, d_addresses, restarted, "restart destination-origin cutover")
                rpc_a.forbid_all = True
                rpc_b.forbid_all = True
                rpc_destination.forbid_all = True
                before_a = rpc_a.event_count()
                before_b = rpc_b.event_count()
                before_d = rpc_destination.event_count()
                latest_b = produce("test3", "post-restart-live-b1")
                observe(latest_b, restarted, "post-restart live second-origin delivery")
                early_included = {
                    "test1": relayer_process.early_included_guard(metrics_port, "test1", hidden["nonce"], [hidden], aggregate=False),
                    "test3": relayer_process.early_included_guard(metrics_port, "test3", latest_b["nonce"], [latest_b], aggregate=False),
                }
                historical_confirmed_offset = sum(not row.get("processed", False) for row in first_a["messages"][:-1]) + sum(not row.get("processed", False) for row in first_b["messages"])
                settlement = relayer_process.wait_for_retirement(metrics_port, restarted, [hidden, latest_b], historical_confirmed_offset=historical_confirmed_offset, historical_offset_reason="pending older canonical IDs in first stopped Rust readback; completed IDs skipped on replay")
                relayer_process.persist_progress(output, "stream-retired", {"destination": rpc_destination}, settlement=settlement, early_included=early_included)
                time.sleep(2)
                assert rpc_a.event_count() == before_a and rpc_b.event_count() == before_b and rpc_destination.event_count() == before_d
                assert rpc_a.forbidden_count() == 0 and rpc_b.forbidden_count() == 0 and rpc_destination.forbidden_count() == 0
                final_metrics = metrics(metrics_port)
                assert 'agent="relayer"' in final_metrics
                final_stop = relayer_process.stop(restarted)
                assert final_stop["exit"] == 0, final_stop

                final_a = probe(oracle, database, "test1", len(messages["test1"]))
                final_b = probe(oracle, database, "test3", len(messages["test3"]))
                relayer_process.persist_progress(output, "stream-stopped-readback", {"destination": rpc_destination}, settlement=settlement, stopped_rust_readback={"test1":final_a,"test3":final_b}, final_stop=final_stop)
                for snapshot in (final_a, final_b):
                    assert all(row["present"] and row["processed"] and row["payment"] and row["insertion_id_chunks"] and row["payloads"] for row in snapshot["messages"]), snapshot
                    assert all(int(row["spent"]["gas_used"]) > 0 and int(row["spent"]["tokens_used"]) > 0 for row in snapshot["messages"]), snapshot
                    assert all(payload["present"] for row in snapshot["messages"] for payload in row["payloads"])
                receipt_proofs = {
                    "test1": [relayer_process.verify_sealed_singleton(destination, rpc_destination, settings["test2"]["mailbox"], message, final_a, "canonical") for message in messages["test1"]],
                    "test3": [relayer_process.verify_sealed_singleton(destination, rpc_destination, settings["test2"]["mailbox"], message, final_b, "canonical") for message in messages["test3"]],
                }
                def canonical_identity(row):
                    return {"id_chunks": row["id_chunks"], "insertion_id_chunks": row["insertion_id_chunks"], "payment": row["payment"], "payload_uuids": sorted(payload["uuid"] for payload in row["payloads"])}
                assert [canonical_identity(row) for row in first_a["messages"][:-1]] == [canonical_identity(row) for row in final_a["messages"][:-1]]
                assert [canonical_identity(row) for row in first_b["messages"]] == [canonical_identity(row) for row in final_b["messages"][:1]]
                nonce_after = int(destination.rpc("eth_getTransactionCount", [evm.TEST_SIGNER, "latest"]), 16)
                balance_after = int(destination.rpc("eth_getBalance", [evm.TEST_SIGNER, "latest"]), 16)
                assert nonce_after == nonce_before_restart + 2
                new_transactions = rpc_destination.raw_since(raw_before_restart)
                assert len(new_transactions) == 2, new_transactions
                expenditure = 0
                transaction_evidence = []
                for transaction_hash in new_transactions:
                    transaction = destination.rpc("eth_getTransactionByHash", [transaction_hash])
                    receipt, header = relayer_process.canonical_receipt(destination, transaction)
                    assert receipt["from"].lower() == evm.TEST_SIGNER.lower() and receipt["to"].lower() == settings["test2"]["mailbox"].lower()
                    cost = int(receipt["gasUsed"], 16) * int(receipt["effectiveGasPrice"], 16)
                    expenditure += cost
                    transaction_evidence.append({"canonical_transaction_hash_chunks": chunks(transaction_hash), "canonical_block_hash_chunks": chunks(header["hash"]), "canonical_block_number": int(header["number"], 16), "gas_used": int(receipt["gasUsed"], 16), "effective_gas_price": int(receipt["effectiveGasPrice"], 16), "cost": cost})
                assert balance_before_restart - balance_after == expenditure, (balance_before_restart, balance_after, expenditure)

                rust_roots = {}
                for name, snapshot in (("test1", final_a), ("test3", final_b)):
                    vectors = rust_vectors(reference, messages[name])
                    for index, vector in enumerate(vectors):
                        assert vector["id"] == messages[name][index]["id"].removeprefix("0x")
                        assert "".join(snapshot["messages"][index]["id_chunks"]) == vector["id"]
                        assert "".join(snapshot["messages"][index]["insertion_id_chunks"]) == vector["id"]
                    onchain_root = anvils[name].chain.rpc("eth_call", [{"to": settings[name]["merkleTreeHook"], "data": evm.calldata("root()")}, "latest"])
                    assert onchain_root.removeprefix("0x") == vectors[-1]["root"]
                    latest_checkpoint = validators[name]["checkpoints"] / f"{len(messages[name]) - 1}_with_id.json"
                    assert latest_checkpoint.exists()
                    checkpoint = json.loads(latest_checkpoint.read_text())
                    assert checkpoint["value"]["checkpoint"]["root"].removeprefix("0x") == vectors[-1]["root"]
                    rust_roots[name] = {"messages": len(vectors), "final_root_chunks": chunks(vectors[-1]["root"]), "ids_and_insertions_match": True, "validator_checkpoint_matches": True}

                assert not stream.errors, stream.errors
                return {
                    "passed": True,
                    "initial_rpc_backfill": {"methods": initial_rpc, "message": 0, "late_origin_chain_id_held": True},
                    "legacy_v2": {"subscription": legacy_subscription, "origin_a_event_calls_at_cutover": legacy_a_baseline, "destination_event_calls_at_cutover": legacy_d_baseline, "live_delivery": 1},
                    "transport_attempts": [{key: session[key] for key in ("transport_index", "index", "mode", "closed", "subscribed", "replayed")} for session in stream.transports],
                    "faults": fault_cases,
                    "healthy_v3": healthy_v3,
                    "late_and_stalled_origin": {"expanded_subscription": stream.subscriptions[-2], "stalled_probe_observed": True, "healthy_neighbor_live_nonce": neighbor_record["nonce"], "socket_pong": True, "withheld_nonce_undelivered_before_restart": hidden["nonce"], "sigterm": first_stop},
                    "restart": {"subscription": stream.subscriptions[-1], "readiness": readiness, "replayed_nonce": hidden["nonce"], "new_live_origin_b_nonce": 1, "nonce_increase": 2, "existing_rust_rows_unchanged": True, "early_included": early_included, "settlement": settlement, "sigterm": final_stop},
                    "rpc_methods": {"origin_a": dict(rpc_a.methods), "origin_b": dict(rpc_b.methods), "destination": dict(rpc_destination.methods)},
                    "rpc_event_methods": {"origin_a": dict(rpc_a.event_methods), "origin_b": dict(rpc_b.event_methods), "destination": dict(rpc_destination.event_methods)},
                    "forbidden_event_calls": {"origin_a": rpc_a.forbidden_count(), "origin_b": rpc_b.forbidden_count(), "destination": rpc_destination.forbidden_count()},
                    "signing_and_expenditure": {"nonce_before_restart": nonce_before_restart, "nonce_after": nonce_after, "balance_delta": balance_before_restart - balance_after, "receipt_expenditure": expenditure, "transactions": transaction_evidence, "per_id_receipt_proofs": receipt_proofs, "raw_send_calls": rpc_destination.methods["eth_sendRawTransaction"]},
                    "first_stopped_rust_readback": {"origin_a": first_a, "origin_b": first_b},
                    "final_stopped_rust_readback": {"origin_a": final_a, "origin_b": final_b},
                    "rust_message_and_root_oracle": rust_roots,
                    "metrics": {"stream_lines": stream_metric_lines(final_metrics), "body_sha256_chunks": chunks(hashlib.sha256(final_metrics.encode()).hexdigest())},
                    "messages": {name: [{"nonce": row["nonce"], "id_chunks": chunks(row["id"]), "label": row["label"], "dispatch_block": row["dispatch_block"], "gas_block": row["gas_block"], "published_before_restart": row["publish"]} for row in rows] for name, rows in messages.items()},
                    "contracts": {name: {"mailbox": settings[name]["mailbox"], "hook": settings[name]["merkleTreeHook"], "paymaster": settings[name]["interchainGasPaymaster"]} for name in settings},
                    "recipient": recipient,
                    "merkle_ism": merkle_ism,
                    "tls": {"wss": True, "ca_hostname_verification": True, "certificate": "repository localhost fixture", "native_curl": "/usr/lib/libcurl.4.dylib"},
                    "errors": [],
                }
    finally:
        failure = sys.exc_info()[0]
        failure_error = sys.exc_info()[1]
        for process in agents:
            if process.poll() is None:
                relayer_process.stop(process)
        for anvil in anvils.values():
            anvil.stop()
        for log in logs:
            log.close()
        if failure is not None:
            preserve = output.parent / f"{output.stem}-failed-latest"
            preserve.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(temporary, preserve, dirs_exist_ok=True)
            partial = relayer_process.persist_failure(output,failure_error,preserve)
            (preserve / "partial-result.json").write_text(json.dumps(partial, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=pathlib.Path, default=ROOT / "zig/zig-out/bin/relayer")
    parser.add_argument("--url-library", type=pathlib.Path)
    parser.add_argument("--validator-binary", type=pathlib.Path, default=ROOT / "zig/zig-out/bin/validator")
    parser.add_argument("--oracle", type=pathlib.Path, default=relayer_process.IMMUTABLE_ORACLE)
    parser.add_argument("--reference", type=pathlib.Path, default=ROOT / "zig/reference/target/release/ziggy-rust-reference")
    parser.add_argument("--output", type=pathlib.Path, default=ROOT / "zig/bench/results/relayer-stream-process.json")
    parser.add_argument("--compile-only", action="store_true")
    args = parser.parse_args()
    contracts = relayer_process.compile_contracts()
    if args.compile_only:
        print(json.dumps({"compiled": list(contracts)}))
        return
    url_library = validator_fixture.url_dependency(args.url_library)
    binary = relayer_process.pin(args.binary, "relayer")
    validator_binary = relayer_process.pin(args.validator_binary, "validator")
    oracle = relayer_process.verified_oracle(args.oracle)
    reference = args.reference.resolve()
    inventory = ["zig/integration/relayer_stream.py", "zig/src/agents/relayer_task.zig", "zig/src/agents/origin_tasks.zig", "zig/src/agents/evm_origin.zig", "zig/src/agents/stream/relayer_bridge.zig", "zig/src/agents/stream/relayer.zig", "zig/src/agents/stream/protocol.zig", "zig/src/agents/stream/socket_owner.zig", "zig/src/agents/stream/relayer_store.zig", "zig/src/ops/metrics_schema.zig"]
    result = {"passed": False, "scope": __doc__, "validator_url_library": url_library, "functional_not_benchmark": True, "executables": {"relayer_sha256_chunks": sha(binary), "validator_sha256_chunks": sha(validator_binary), "rocks_oracle_sha256_chunks": sha(oracle), "rust_reference_sha256_chunks": sha(reference)}, "source_inventory_sha256_chunks": {path: sha(ROOT / path) for path in inventory}, "errors": []}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    try:
        with tempfile.TemporaryDirectory(prefix="ziggy-relayer-stream-") as directory:
            result["case"] = run_acceptance(binary, validator_binary, oracle, reference, contracts, pathlib.Path(directory), args.output, url_library)
        result["passed"] = True
    except Exception as error:
        result["failed_fixture"] = str(args.output.parent / f"{args.output.stem}-failed-latest")
        result["errors"].append({"type": type(error).__name__, "detail": "acceptance assertion failed; see latest preserved stopped DB/logs/config"})
        relayer_process.persist_failure(args.output,error,result["failed_fixture"])
        relayer_process.finish_result(args.output,chunks(result))
        raise
    relayer_process.finish_result(args.output,chunks(result))
    print(json.dumps({"passed": True, "legacy_v2": True, "v3": True, "multi_origin": True, "restart": True}))


if __name__ == "__main__":
    main()
