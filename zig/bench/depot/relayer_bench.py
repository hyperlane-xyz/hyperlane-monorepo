#!/usr/bin/env python3
"""Lean paired Rust/Zig relayer benchmark on disposable Anvil chains.

Fixture setup is the same as zig/bench/relayer.py (three domains on two Anvil
chains, Mailbox/IGP/ValidatorAnnounce, TestIsm + message-id + merkle-root
multisig recipients, optional Multicall3 batching, a shared Rust validator as
checkpoint producer, a 3 s destination receipt stall during the fresh phase),
and it reuses that module's proxy/process/proof helpers.

Dropped versus relayer.py: provenance/proof-file gates, quiet-host gate, the
600 s confirmation-hold settlement wait, restart replay and the Rocks DB oracle.
Kept correctness: every message delivered on-chain exactly once (Mailbox
ProcessId coverage, unambiguous), every relayer broadcast mined with matching
signer nonces, batch membership proof when maxBatchSize > 1, clean exit.

Measured per run: launch->metrics ready, launch->backlog delivered (catchup),
deliveries/s, dispatch->delivered latency for fresh messages, CPU, peak RSS,
RPC counts by method/phase, shutdown time, transactions.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))  # zig/bench
import relayer as rb  # noqa: E402  (also puts zig/integration on sys.path)
import evm  # noqa: E402
import relayer_process  # noqa: E402
import validator  # noqa: E402

ROOT = rb.ROOT
ORIGIN, DESTINATION, DESTINATION_ALT = rb.ORIGIN, rb.DESTINATION, rb.DESTINATION_ALT


class ShapeProxy:
    """Optional pass-through between a CountingProxy and Anvil that counts JSON-RPC
    request *shapes* (method + coarse params), e.g. eth_getBlockByNumber by block tag
    and full-tx flag, to attribute repeated reads to their callers. Diagnostic passes only."""

    def __init__(self, target):
        import collections
        self.target = target
        self.shapes = collections.Counter()
        self.lock = threading.Lock()

    @staticmethod
    def shape(request):
        method = request.get("method", "invalid")
        params = request.get("params") or []
        if method in ("eth_getBlockByNumber", "eth_getBlockByHash") and params:
            tag = params[0] if isinstance(params[0], str) else "?"
            tag = tag if tag in ("latest", "pending", "finalized", "safe", "earliest") else "number"
            return f"{method}({tag},full={bool(params[1]) if len(params) > 1 else None})"
        if method == "eth_call" and params and isinstance(params[0], dict):
            data = params[0].get("data") or params[0].get("input") or ""
            return f"eth_call(selector={data[:10]},block={params[1] if len(params) > 1 and isinstance(params[1], str) and not params[1].startswith('0x') else 'number'})"
        if method == "eth_getLogs" and params and isinstance(params[0], dict):
            return f"eth_getLogs(topics={len(params[0].get('topics') or [])})"
        return method

    def __enter__(self):
        import http.server
        import urllib.request
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self):
                data = self.rfile.read(int(self.headers.get("content-length", "0")))
                try:
                    decoded = json.loads(data)
                    with owner.lock:
                        for request in decoded if isinstance(decoded, list) else [decoded]:
                            owner.shapes[owner.shape(request)] += 1
                    with urllib.request.urlopen(urllib.request.Request(owner.target, data, {"Content-Type": "application/json"}), timeout=20) as response:
                        body, status = response.read(), response.status
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                except (OSError, ValueError):
                    self.close_connection = True

            def log_message(self, *args):
                pass

        class Server(http.server.ThreadingHTTPServer):
            daemon_threads = True

        self.server = Server(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=0.01), daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        return self

    def __exit__(self, *args):
        self.server.shutdown()
        self.server.server_close()

    def snapshot(self):
        with self.lock:
            return dict(self.shapes.most_common())


def proc_snapshot(pid: int) -> dict:
    """Process counters right after readiness (Linux /proc; cheap reads, no tracer).

    minflt/majflt/utime/stime cover the whole thread group; ctx switches are summed over live threads."""
    try:
        fields = pathlib.Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    except OSError:
        return {}
    tick = os.sysconf("SC_CLK_TCK")
    snapshot = {"minflt": int(fields[7]), "majflt": int(fields[9]), "utime_ms": int(fields[11]) * 1000 / tick,
                "stime_ms": int(fields[12]) * 1000 / tick, "threads": int(fields[17]), "ctx_voluntary": 0, "ctx_involuntary": 0}
    for status in pathlib.Path(f"/proc/{pid}/task").glob("*/status"):
        try:
            for line in status.read_text().splitlines():
                if line.startswith("voluntary_ctxt_switches:"):
                    snapshot["ctx_voluntary"] += int(line.split()[1])
                elif line.startswith("nonvoluntary_ctxt_switches:"):
                    snapshot["ctx_involuntary"] += int(line.split()[1])
        except OSError:
            continue  # thread exited between listing and read
    return snapshot


def finish_sampler(sampler: subprocess.Popen, path: pathlib.Path, launch_ns: int) -> dict:
    """Wait for startup_sampler.py, rebase its times to ms since launch, rewrite the file, return a summary.

    The metrics server thread is taken to be the first thread spawned after main (lowest tid > pid):
    the HTTP server starts right after `listening`, before the task set (seen in the 4c81a59284 trace)."""
    out = sampler.stdout.read()  # stdin was closed after handing over the pid
    sampler.wait(timeout=60)
    data = json.loads(out)
    pid = data["pid"]
    threads = {}
    for tid, rows in data["threads"].items():
        threads[tid] = [[round((row[0] - launch_ns) / 1e6, 3), *row[1:]] for row in rows]
    spawned = sorted(int(tid) for tid in threads if int(tid) != pid)
    server = str(spawned[0]) if spawned else None
    data.update(threads=threads, server_tid=server, start_ms=round((data.pop("start_ns") - launch_ns) / 1e6, 3))
    path.write_text(json.dumps(data))
    return {"samples": data["samples"], "server_tid": server, "stack_readable": data["stack_readable"],
            "server": threads.get(server, []), "main": threads.get(str(pid), [])}


def parse_startup_trace(log: bytes, launch_ns: int) -> list:
    """`startup-trace <CLOCK_MONOTONIC ns> <kind> <value> t<tid>` lines (bench-only diag builds) as ms since launch."""
    events = []
    for line in log.decode(errors="replace").splitlines():
        at = line.find("startup-trace ")
        if at < 0:
            continue
        parts = line[at:].split()
        if len(parts) >= 5 and parts[1].isdigit():
            events.append([round((int(parts[1]) - launch_ns) / 1e6, 3), parts[2], parts[3], parts[4]])
    return events


def start_anvil(log):
    port = rb.free_port()
    proc = subprocess.Popen(["anvil", "--host", "127.0.0.1", "--port", str(port), "--chain-id", "31337", "--silent"],
                            cwd=ROOT, stdout=log, stderr=log)
    chain = evm.Chain(f"http://127.0.0.1:{port}")
    for _ in range(200):
        if proc.poll() is not None:
            raise RuntimeError(f"Anvil exited {proc.returncode}")
        try:
            chain.account = chain.rpc("eth_accounts")[0]
            return proc, chain
        except (ConnectionError, OSError, urllib.error.URLError):
            time.sleep(0.05)
    raise RuntimeError("Anvil readiness deadline")


def stop_anvil(proc):
    if proc is None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()


def deploy_fixture(chain, chain_alt, max_batch_size):
    contracts = relayer_process.compile_contracts()

    def deploy(contract, signature=None, *values, target=None):
        target = target or chain
        return target.send("0x" + contracts[contract] + (evm.abi(signature, *values) if signature else ""))["contractAddress"]

    domains = {}
    for chain_name, domain in [("test1", ORIGIN), ("test2", DESTINATION), ("test3", DESTINATION_ALT)]:
        target = chain if domain != DESTINATION_ALT else chain_alt
        null_ism = deploy("TestIsm", target=target)
        required = deploy("TestPostDispatchHook", target=target)
        mailbox = deploy("Mailbox", "constructor(uint32)", str(domain), target=target)
        hook = deploy("MerkleTreeHook", "constructor(address)", mailbox, target=target)
        announce = deploy("ValidatorAnnounce", "constructor(address)", mailbox, target=target)
        igp = deploy("InterchainGasPaymaster", target=target)
        target.send(evm.calldata("initialize(address,address)", target.account, target.account), igp)
        target.send(evm.calldata("initialize(address,address,address,address)", target.account, null_ism, hook, required), mailbox)
        domains[chain_name] = {
            "name": chain_name, "domainId": domain, "chainId": 31337, "protocol": "ethereum",
            "rpcUrls": [{"http": target.url}], "mailbox": mailbox, "merkleTreeHook": hook,
            "validatorAnnounce": announce, "interchainGasPaymaster": igp,
            "blocks": {"reorgPeriod": 0, "confirmations": 0, "estimateBlockTime": 1},
            "index": {"from": 0, "interval": 1}, "maxBatchSize": max_batch_size,
            "signer": {"type": "hexKey", "key": rb.PUBLIC_KEY},
        }
    batch_contracts = rb.setup_batch_contracts(max_batch_size, [("anvil-1", chain, "test2"), ("anvil-2", chain_alt, "test3")], domains)
    gas_oracle = deploy("StorageGasOracle")
    for destination in [DESTINATION, DESTINATION_ALT]:
        chain.send(evm.calldata("setRemoteGasData((uint32,uint128,uint128))", f"({destination},10000000000,1)"), gas_oracle)
    chain.send(evm.calldata("setDestinationGasConfigs((uint32,(address,uint96))[])",
                            f"[({DESTINATION},({gas_oracle},0)),({DESTINATION_ALT},({gas_oracle},0))]"),
               domains["test1"]["interchainGasPaymaster"])
    recipients = {DESTINATION: [], DESTINATION_ALT: []}
    for destination in recipients:
        target = chain if destination != DESTINATION_ALT else chain_alt
        isms = [
            deploy("TestIsm", target=target),
            deploy("StorageMessageIdMultisigIsm", "constructor(address[],uint8)", f"[{evm.TEST_SIGNER}]", "1", target=target),
            deploy("StorageMerkleRootMultisigIsm", "constructor(address[],uint8)", f"[{evm.TEST_SIGNER}]", "1", target=target),
        ]
        for ism in isms:
            recipient = deploy("TestRecipient", target=target)
            target.send(evm.calldata("setInterchainSecurityModule(address)", ism), recipient)
            recipients[destination].append(recipient)
    for target in [chain, chain_alt]:
        target.rpc("anvil_setBalance", [evm.TEST_SIGNER, hex(100 * 10**18)])
    return contracts, domains, batch_contracts, recipients


def run_attempt(name, sample, order, args, output):
    raw_dir = output / "raw" / f"sample-{sample}-{name}"
    raw_dir.mkdir(parents=True, exist_ok=True)
    anvil = anvil_alt = validating = running = None
    proxies = []
    with tempfile.TemporaryDirectory(prefix=f"zb-relayer-{name}-") as directory, \
            (raw_dir / "anvil.log").open("wb") as anvil_log, (raw_dir / "anvil-2.log").open("wb") as anvil_alt_log:
        temporary = pathlib.Path(directory)
        (temporary / "config").mkdir()  # Rust settings loader requires ./config to exist in cwd
        try:
            anvil, chain = start_anvil(anvil_log)
            anvil_alt, chain_alt = start_anvil(anvil_alt_log)
            contracts, domains, batch_contracts, recipients = deploy_fixture(chain, chain_alt, args.max_batch_size)
            dispatch_topic = evm.run(["cast", "keccak", "Dispatch(address,uint32,bytes32,bytes)"])
            messages = []

            def dispatch(index, destination=DESTINATION):
                recipient = recipients[destination][index % len(recipients[destination])]
                receipt = chain.send(evm.calldata("dispatch(uint32,bytes32,bytes)", str(destination), "0x" + "00" * 12 + recipient[2:],
                                                  "0x" + f"whole-relayer-{index}-{destination}".encode().hex()), domains["test1"]["mailbox"])
                event = next(v for v in receipt["logs"] if v["address"].lower() == domains["test1"]["mailbox"].lower() and v["topics"][0] == dispatch_topic)
                raw = bytes.fromhex(event["data"][2:])
                wire = raw[64:64 + int.from_bytes(raw[32:64], "big")]
                identity = evm.run(["cast", "keccak", "0x" + wire.hex()])
                chain.receipt(chain.rpc("eth_sendTransaction", [{
                    "from": chain.account, "to": domains["test1"]["interchainGasPaymaster"],
                    "data": evm.calldata("payForGas(bytes32,uint32,uint256,address)", identity, str(destination), "1000000", chain.account),
                    "value": hex(1_000_000), "gas": "0xe00000",
                }]))
                sent = time.perf_counter_ns()
                messages.append({"id": identity, "wire": wire.hex(), "dispatch_ns": sent, "destination": destination})
                return sent

            for index in range(args.catchup):
                dispatch(index)

            # Shared checkpoint producer: real Rust validator on the fixture CPUs; excluded from relayer metrics.
            checkpoints = temporary / "checkpoints"
            validator_config = temporary / "validator-config"
            validator_config.mkdir()
            validator_file = validator_config / "public.json"
            validator_file.write_text(json.dumps({
                "originChainName": "test1", "db": str(temporary / "validator-db"), "validator": {"key": rb.PUBLIC_KEY},
                "checkpointSyncer": {"type": "localStorage", "path": str(checkpoints)}, "interval": 1,
                "metricsPort": rb.free_port(), "chains": {"test1": domains["test1"]},
                "log": {"level": "error", "format": "json"},
            }))
            validating = rb.MeasuredProcess(args.checkpoint_validator, temporary, rb.environment("rust", validator_file, validator_config))
            rb.wait_for(validating, lambda: validator.checkpoint_objects(checkpoints, args.catchup) is not None, args.deadline, "validator backlog")

            shape_proxies = {}
            if args.rpc_shapes:
                for label, url in (("origin", chain.url), ("destination-1", chain.url), ("destination-2", chain_alt.url)):
                    shape_proxies[label] = ShapeProxy(url).__enter__(); proxies.append(shape_proxies[label])
            upstream = {label: (shape_proxies[label].url if label in shape_proxies else url)
                        for label, url in (("origin", chain.url), ("destination-1", chain.url), ("destination-2", chain_alt.url))}
            origin_rpc = rb.CountingProxy(upstream["origin"], "anvil-1").__enter__(); proxies.append(origin_rpc)
            destination_rpc = rb.CountingProxy(upstream["destination-1"], "anvil-1").__enter__(); proxies.append(destination_rpc)
            destination_alt_rpc = rb.CountingProxy(upstream["destination-2"], "anvil-2").__enter__(); proxies.append(destination_alt_rpc)

            def rpc_snapshot():
                return [p.snapshot() for p in (origin_rpc, destination_rpc, destination_alt_rpc)]

            configured = json.loads(json.dumps(domains))
            configured["test1"]["rpcUrls"] = [{"http": origin_rpc.url}]
            configured["test2"]["rpcUrls"] = [{"http": destination_rpc.url}]
            configured["test3"]["rpcUrls"] = [{"http": destination_alt_rpc.url}]
            relayer_config = temporary / "relayer-config"
            relayer_config.mkdir()
            database = temporary / "relayer-db"
            metrics_port = rb.free_port()
            relayer_file = relayer_config / "public.json"
            relayer_file.write_text(json.dumps({
                "relayChains": "test1,test2,test3", "db": str(database), "allowLocalCheckpointSyncers": True,
                "gasPaymentEnforcement": [{"type": "none"}], "tracing": {"level": args.log_level, "fmt": "json"},
                "metricsPort": metrics_port, "chains": configured,
            }))

            def delivered(message):
                target = chain if message["destination"] != DESTINATION_ALT else chain_alt
                mailbox = domains[f"test{message['destination'] - ORIGIN + 1}"]["mailbox"]
                return int(target.rpc("eth_call", [{"to": mailbox, "data": evm.calldata("delivered(bytes32)", message["id"])}, "latest"]), 16) == 1

            backlog = rb.pending_backlog_count(messages, args.catchup, delivered)
            nonce_before = {"anvil-1": int(chain.rpc("eth_getTransactionCount", [evm.TEST_SIGNER, "latest"]), 16),
                            "anvil-2": int(chain_alt.rpc("eth_getTransactionCount", [evm.TEST_SIGNER, "latest"]), 16)}

            sampler = None
            sampler_ms = os.environ.get("BENCH_STARTUP_SAMPLER")  # diagnostic: per-thread /proc sampler, Zig only
            if sampler_ms and name == "zig":
                # started first and handed the pid on stdin: Python startup (~20 ms) would miss the window
                # root (if passwordless sudo) can read /proc/*/syscall and /proc/*/stack of a non-descendant
                sudo = ["sudo", "-n"] if os.geteuid() != 0 and shutil.which("sudo") and \
                    subprocess.run(["sudo", "-n", "true"], capture_output=True).returncode == 0 else []
                sampler = subprocess.Popen([*sudo, sys.executable, str(HERE / "startup_sampler.py"), "-", sampler_ms],
                                           stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
                time.sleep(0.2)
            running = rb.launch(name, args.binaries[name], temporary, relayer_file, relayer_config)
            launch_ns = running.start_ns
            if sampler:
                sampler.stdin.write(f"{running.p.pid}\n")
                sampler.stdin.close()
            launch_unix = time.time() - (time.perf_counter_ns() - launch_ns) / 1e9
            agent_pid = running.p.pid
            probes = []  # harness-side readiness probe log: (ms since launch, outcome, probe duration ms); no agent perturbation

            def ready_probe():
                started = time.perf_counter_ns()
                try:
                    rb.metrics_probe(metrics_port)
                    outcome = "ready"
                except (ConnectionRefusedError, urllib.error.URLError, OSError, RuntimeError) as error:
                    reason = getattr(error, "reason", error)
                    outcome = type(reason).__name__ + ":" + str(reason)[:60]
                probes.append((round((started - launch_ns) / 1e6, 2), outcome, round((time.perf_counter_ns() - started) / 1e6, 2)))
                return outcome == "ready"

            ready_ns = rb.wait_for(running, ready_probe, args.deadline, "relayer readiness")
            ready_unix = time.time()
            startup_proc = proc_snapshot(agent_pid)
            startup_proc["at_ms"] = round((time.perf_counter_ns() - launch_ns) / 1e6, 2)
            startup_rpc = rpc_snapshot()
            pending = list(messages)

            def all_backlog_delivered():
                pending[:] = [m for m in pending if not delivered(m)]
                return not pending

            caught_ns = rb.wait_for(running, all_backlog_delivered, args.deadline, "backlog delivery")
            catchup_rpc = rpc_snapshot()
            threads_catchup = running.thread_snapshot()

            emitted = [None] * args.steady
            observed = [None] * args.steady
            errors = []

            def produce():
                try:
                    for offset in range(args.steady):
                        due = caught_ns + (offset + 1) * args.steady_interval_ms * 1_000_000
                        time.sleep(max(0, (due - time.perf_counter_ns()) / 1e9))
                        emitted[offset] = dispatch(args.catchup + offset, DESTINATION_ALT if offset >= 2 else DESTINATION)
                except Exception as error:  # surfaced in the polling loop
                    errors.append(error)

            if args.stall:
                destination_rpc.start_fault()
            producer = threading.Thread(target=produce)
            producer.start()
            try:
                deadline = time.monotonic() + args.deadline + args.steady * args.steady_interval_ms / 1000
                while any(v is None for v in observed):
                    if running.poll() is not None:
                        raise RuntimeError(f"relayer exited during fresh delivery: {running.logs()}")
                    if errors:
                        raise errors[0]
                    for offset in range(args.steady):
                        if emitted[offset] is not None and observed[offset] is None and delivered(messages[args.catchup + offset]):
                            observed[offset] = time.perf_counter_ns()
                    if time.monotonic() > deadline:
                        raise RuntimeError(f"fresh delivery deadline: {running.logs()}")
                    time.sleep(0.005)
            finally:
                producer.join(timeout=30)
            fresh_done_ns = time.perf_counter_ns()
            fresh_rpc = rpc_snapshot()
            threads_steady = running.thread_snapshot()
            metrics = rb.metrics_probe(metrics_port)
            try:  # full exposition at end of the fresh phase, for series/label diffs between arms
                with urllib.request.urlopen(f"http://127.0.0.1:{metrics_port}/metrics", timeout=4) as response:
                    (raw_dir / "metrics.txt").write_bytes(response.read(16 * 1024 * 1024))
            except (OSError, urllib.error.URLError) as error:
                (raw_dir / "metrics.txt").write_text(f"# metrics dump failed: {error}\n")
            stop = running.stop_with_signal(signal.SIGTERM)
            stop["minor_page_faults"] = running.usage.ru_minflt
            stop["major_page_faults"] = running.usage.ru_majflt
            agent_log = running.full_log()
            (raw_dir / "relayer.log").write_bytes(agent_log)
            startup_trace = parse_startup_trace(agent_log, launch_ns)
            # after the timed phases: collecting earlier would stall the harness's catchup polling
            startup_threads = finish_sampler(sampler, raw_dir / "startup-sampler.json", launch_ns) if sampler else None
            running.close()
            running = None
            if stop["exit_code"] not in [0, -signal.SIGTERM]:
                raise RuntimeError(f"relayer shutdown failed: exit {stop['exit_code']}")
            total_rpc = rpc_snapshot()

            # ---- correctness, outside all timers
            nonce_after = {"anvil-1": int(chain.rpc("eth_getTransactionCount", [evm.TEST_SIGNER, "latest"]), 16),
                           "anvil-2": int(chain_alt.rpc("eth_getTransactionCount", [evm.TEST_SIGNER, "latest"]), 16)}
            if not all(delivered(m) for m in messages):
                raise RuntimeError("message not delivered at end of run")
            mailboxes = {DESTINATION: domains["test2"]["mailbox"], DESTINATION_ALT: domains["test3"]["mailbox"]}
            signed = [(chain, raw, mailboxes[DESTINATION], "anvil-1") for raw in origin_rpc.signed_transactions() + destination_rpc.signed_transactions()] + \
                     [(chain_alt, raw, mailboxes[DESTINATION_ALT], "anvil-2") for raw in destination_alt_rpc.signed_transactions()]
            unique = list(dict.fromkeys(signed))
            receipts, unmined = [], []
            for target, raw, mailbox, namespace in unique:
                tx_hash = evm.run(["cast", "keccak", raw])
                receipt = target.rpc("eth_getTransactionReceipt", [tx_hash])
                if receipt:
                    receipt["chain_namespace"] = namespace
                    receipt["_mailbox"] = mailbox
                    receipt["time_ns"] = 0
                    receipts.append(receipt)
                else:
                    unmined.append(tx_hash)
            # Unambiguous ProcessId coverage for every message (raises on missing/double inclusion).
            observations = [{"chain_namespace": r["chain_namespace"], "hash": r["transactionHash"], "time_ns": 0,
                             "status": r.get("status"), "logs": r.get("logs", [])} for r in receipts]
            rb.inclusion_lower_bound(messages, observations, mailboxes)
            nonces = {(r["chain_namespace"], rb.receipt_nonce(chain if r["chain_namespace"] == "anvil-1" else chain_alt, r)) for r in receipts}
            for ns in ("anvil-1", "anvil-2"):
                if nonce_after[ns] - nonce_before[ns] != sum(1 for n, _ in nonces if n == ns):
                    raise RuntimeError(f"signer nonce delta differs from mined relayer transactions on {ns}")
            if args.max_batch_size == 1 and len(nonces) != len(messages):
                raise RuntimeError("single-submission transaction count differs from message count")
            batch = None
            if args.max_batch_size > 1:
                try:
                    batch = rb.batch_membership_proof(messages, receipts, {"anvil-1": chain, "anvil-2": chain_alt}, mailboxes, batch_contracts, args.max_batch_size)
                    batch.pop("groups", None)
                except RuntimeError as error:
                    batch = {"verified": False, "error": str(error)}

            fresh = [max(0, (done - sent) / 1e6) for done, sent in zip(observed, emitted)]
            db_bytes = sum(p.stat().st_blocks * 512 for p in database.rglob("*") if p.is_file()) if database.exists() else None
            validator_stop = validating.stop()
            validating.close()
            validating = None
            return {
                "implementation": name, "sample": sample, "order": order,
                "launch_to_ready_ms": (ready_ns - launch_ns) / 1e6,
                "launch_unix": launch_unix, "ready_unix": ready_unix, "agent_pid": agent_pid,
                "readiness_probes": probes[-40:],
                "startup_proc": startup_proc,
                **({"startup_threads": startup_threads} if startup_threads else {}),
                **({"startup_trace": startup_trace} if startup_trace else {}),
                **rb.catchup_measurements(backlog, launch_ns, ready_ns, caught_ns),
                "freshness_ms": fresh,
                "freshness_percentiles_ms": {q: rb.percentile(fresh, v) for q, v in [("p50", .5), ("p95", .95), ("p99", .99)]},
                "fresh_phase_ms": (fresh_done_ns - caught_ns) / 1e6,
                "stop": stop,
                "validator_stop_exit": validator_stop["exit_code"],
                "thread_snapshots": {"after_catchup": threads_catchup, "after_steady": threads_steady},
                "rpc": {"startup": [{k: s[k] for k in ("http_requests", "json_rpc_subrequests", "methods", "broadcast_attempts")} for s in startup_rpc],
                        "catchup": [{k: s[k] for k in ("http_requests", "json_rpc_subrequests", "methods", "broadcast_attempts")} for s in catchup_rpc],
                        "fresh_phase": [rb.rpc_delta(a, b) for a, b in zip(fresh_rpc, catchup_rpc)],
                        "total": [{k: s[k] for k in ("http_requests", "json_rpc_subrequests", "methods", "broadcast_attempts", "receipt_stalls")} for s in total_rpc]},
                "metrics_probe": metrics,
                "db_allocated_bytes": db_bytes,
                "proof": {"message_count": len(messages), "physical_broadcast_attempts": len(signed),
                          "unique_transaction_count": len(unique), "unmined_attempts": unmined,
                          "mined_unique_nonces": len(nonces), "nonce_delta": {k: nonce_after[k] - nonce_before[k] for k in nonce_after},
                          "batch_membership": batch},
                "rpc_shapes": {label: proxy.snapshot() for label, proxy in shape_proxies.items()} or None,
                "load_average": os.getloadavg(),
            }
        finally:
            if running is not None:
                if running.usage is None:
                    running.stop_with_signal(signal.SIGTERM)
                (raw_dir / "relayer-failure.log").write_bytes(running.full_log())
                running.close()
            if validating is not None:
                if validating.usage is None:
                    validating.stop()
                (raw_dir / "validator-failure.log").write_bytes(validating.full_log())
                validating.close()
            for proxy in proxies:
                proxy.__exit__(None, None, None)
            stop_anvil(anvil)
            stop_anvil(anvil_alt)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--rust", type=pathlib.Path, required=True)
    parser.add_argument("--zig", type=pathlib.Path, required=True)
    parser.add_argument("--checkpoint-validator", type=pathlib.Path, required=True, help="Rust validator used as shared checkpoint producer")
    parser.add_argument("--samples", type=int, default=5)
    parser.add_argument("--catchup", type=int, default=32)
    parser.add_argument("--steady", type=int, default=8)
    parser.add_argument("--steady-interval-ms", type=int, default=500)
    parser.add_argument("--max-batch-size", type=int, default=1)
    parser.add_argument("--deadline", type=float, default=120)
    parser.add_argument("--stall", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--rpc-shapes", action="store_true", help="count JSON-RPC request shapes per endpoint (extra proxy hop; diagnostic passes only)")
    parser.add_argument("--log-level", default="error", help="`tracing.level` in the shared config (Zig); Rust level comes from HYP_LOG_LEVEL set by bench.py")
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    if args.stall and args.steady < 3:
        raise SystemExit("--stall needs --steady >= 3")
    args.output = args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=True)
    args.binaries = {"rust": args.rust.resolve(), "zig": args.zig.resolve()}
    args.checkpoint_validator = args.checkpoint_validator.resolve()
    manifest = {
        "configuration": {k: str(v) if isinstance(v, pathlib.Path) else v for k, v in vars(args).items() if k != "binaries"},
        "binaries": {k: str(v) for k, v in args.binaries.items()},
        "load_average_before": os.getloadavg(),
        "raw_samples": [], "failures": [],
    }
    path = args.output / "relayer.json"

    def persist():
        path.write_text(json.dumps(manifest, indent=2, default=str) + "\n")

    persist()
    order = 0
    failed = False
    for sample in range(args.samples):
        for name in (["rust", "zig"] if sample % 2 == 0 else ["zig", "rust"]):
            try:
                row = run_attempt(name, sample, order, args, args.output)
                manifest["raw_samples"].append(row)
                print(name, sample, f"catchup={row['launch_to_caught_up_ms']:.1f}ms",
                      f"fresh_p50={row['freshness_percentiles_ms']['p50']:.1f}ms",
                      f"cpu={row['stop']['user_seconds'] + row['stop']['system_seconds']:.2f}s", flush=True)
            except Exception as error:
                failed = True
                manifest["failures"].append({"implementation": name, "sample": sample, "error": str(error)[-6000:]})
                print(f"FAILED {name} sample {sample}: {str(error)[-3000:]}", flush=True)
            order += 1
            persist()
    manifest["load_average_after"] = os.getloadavg()
    persist()
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
