#!/usr/bin/env python3
"""Public relay HTTP acceptance on disposable Anvil/repository contracts/public key11.

Actual listener, CCTP receipt admission, NullISM delivery, CORS/rate limits,
separate admin telemetry, and stopped-RocksDB evidence. Not a production rollout.
"""
from __future__ import annotations

import argparse
import copy
import re
import hashlib
import http.server
import json
import pathlib
import shutil
import tempfile
import threading
import time
import urllib.error
import urllib.request

import evm
import relayer_process

ROOT = evm.ROOT
ORIGIN, DESTINATION = 9913371, 9913372
TESTNET_TRANSMITTER = "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275"
DISPATCH_TOPIC = evm.run(["cast", "keccak", "Dispatch(address,uint32,bytes32,bytes)"])


def chunks(value):
    return [value[index:index + 32] for index in range(0, len(value), 32)]


def sha(path):
    return chunks(hashlib.sha256(path.read_bytes()).hexdigest())


class PublicAdminReferences:
    """Observe public/canonical references; normalize only exact approved overlap.

    Counters, per-ID600s eligibility and all submission/restart assertions stay
    with the original strict observers. Every raw admin response is retained.
    """
    def __init__(self, messages, admitted_message, evidence_path=None):
        assert messages and len({message['id'].lower() for message in messages}) == len(messages), 'duplicate tracked public ID'
        self.expected = {}
        for message in messages:
            identity = message['id'].lower()
            assert re.fullmatch(r'0x[0-9a-f]{64}', identity), 'malformed tracked public ID'
            wire = bytes.fromhex(message['wire'])
            assert len(wire) >= 77, 'truncated tracked public wire'
            expected = {'version': wire[0], 'nonce': int.from_bytes(wire[1:5], 'big'), 'origin': int.from_bytes(wire[5:9], 'big'), 'sender': '0x'+wire[9:41].hex(), 'destination': int.from_bytes(wire[41:45], 'big'), 'recipient': '0x'+wire[45:77].hex(), 'body': list(wire[77:])}
            assert expected['origin'] == ORIGIN and expected['destination'] == DESTINATION, 'tracked public domain differs'
            self.expected[identity] = expected
        self.admitted_id = None if admitted_message is None else admitted_message['id'].lower()
        assert self.admitted_id is None or self.admitted_id in self.expected, 'untracked public overlap approval'
        self.observations = []
        self.evidence_path = evidence_path
        if evidence_path is not None:
            with evidence_path.open('x'):
                pass

    def normalize(self, operations):
        assert len(self.observations) < 20000, 'public observation bound exceeded'
        before = copy.deepcopy(operations)
        references = {}
        if isinstance(operations, list):
            for row in operations:
                if isinstance(row, dict) and isinstance(row.get('id'), str):
                    identity = row['id'].lower()
                    references[identity] = references.get(identity, 0)+1
        observed = {'observed_monotonic': time.monotonic(), 'raw_row_count': len(before) if isinstance(before, list) else None, 'unique_id_count': len(references), 'id_reference_counts': references, 'raw_operations': before}
        self.observations.append(observed)
        # Persist before validation so a rejected row or a later counter failure
        # cannot erase the original admin response in the retained fixture.
        if self.evidence_path is not None:
            with self.evidence_path.open('a') as stream:
                json.dump(observed, stream, separators=(',', ':'))
                stream.write('\n')
        assert isinstance(operations, list) and len(operations) <= len(self.expected)+int(self.admitted_id is not None), 'unexpected public reference count'
        by_id, counts = {}, {}
        for row in operations:
            assert isinstance(row, dict) and set(row) == {'id', 'operation'}, 'corrupt public admin row'
            identity = row['id']
            assert isinstance(identity, str) and re.fullmatch(r'0x[0-9a-fA-F]{64}', identity), 'malformed public admin ID'
            identity = identity.lower()
            assert identity in self.expected, 'foreign public admin ID'
            operation = row['operation']
            assert isinstance(operation, dict) and set(operation) == {'type', 'message', 'status', 'app_context', 'submitted', 'num_retries'}, 'corrupt public operation schema'
            assert operation['type'] == 'PendingMessage', 'corrupt public operation type'
            message = operation['message']
            expected = self.expected[identity]
            assert isinstance(message, dict) and set(message) == set(expected), 'corrupt public message schema'
            assert all(type(message[key]) is int for key in ['version', 'nonce', 'origin', 'destination']), 'corrupt public numeric field'
            assert isinstance(message['body'], list) and all(type(value) is int and 0 <= value <= 255 for value in message['body']), 'corrupt public body'
            assert message == expected, 'public admin message differs from exact tracked wire'
            assert type(operation['submitted']) is bool and type(operation['num_retries']) is int and operation['num_retries'] >= 0, 'corrupt public operation state'
            assert operation['app_context'] is None or isinstance(operation['app_context'], str), 'corrupt public app context'
            status = operation['status']
            assert (status == {'Confirm': 'SubmittedBySelf'} and operation['submitted']) or (status in ('FirstPrepareAttempt', 'ReadyToSubmit') and not operation['submitted']), 'unexpected public operation status'
            counts[identity] = counts.get(identity, 0)+1
            if identity in by_id:
                assert identity == self.admitted_id and counts[identity] == 2, 'unapproved public duplicate ID'
                assert row == by_id[identity], 'differing public duplicate row'
            else:
                by_id[identity] = row
        return list(by_id.values())


def compile_contracts():
    contracts = relayer_process.compile_contracts()
    evm.CONTRACTS.update(
        MockToken="solidity/contracts/mock/MockToken.sol",
        MockCircleMessageTransmitter="solidity/contracts/mock/MockCircleMessageTransmitter.sol",
        PublicRelayCaller="zig/integration/public_contracts/PublicRelayCaller.sol",
    )
    return evm.compile_contracts()


class DispatchFilterProxy(relayer_process.RpcProxy):
    def __enter__(self):
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self):
                request = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
                method = request["method"]
                owner.methods[method] += 1
                topics = request.get("params", [{}])[0].get("topics", []) if method == "eth_getLogs" else []
                drop = getattr(owner, "drop_dispatch", False) and method == "eth_getLogs" and len(topics) > 0 and topics[0].lower() == DISPATCH_TOPIC.lower()
                try:
                    if drop:
                        body = json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": []}).encode()
                    else:
                        upstream = urllib.request.Request(owner.chain.url, data=json.dumps(request).encode(), headers={"Content-Type": "application/json"})
                        with urllib.request.urlopen(upstream, timeout=20) as response:
                            body = response.read()
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


def request(url, method="GET", body=None, origin=None):
    headers = {} if body is None else {"Content-Type": "application/json"}
    if origin:
        headers["Origin"] = origin
    if method == "OPTIONS":
        headers["Access-Control-Request-Method"] = "POST"
        headers["Access-Control-Request-Headers"] = "content-type"
    req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(), headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            return response.status, response.read(), {key.lower(): value for key, value in response.headers.items()}
    except urllib.error.HTTPError as error:
        return error.code, error.read(), {key.lower(): value for key, value in error.headers.items()}
    except urllib.error.URLError:
        return 503, b"", {}


def deploy(chain, contracts, name, signature=None, *values):
    data = "0x" + contracts[name] + (evm.abi(signature, *values) if signature else "")
    return chain.send(data)["contractAddress"]


def delivered(chain, mailbox, identity):
    return int(chain.rpc("eth_call", [{"to": mailbox, "data": evm.calldata("delivered(bytes32)", identity)}, "latest"]), 16) == 1


def verify_sealed_delivery(chain, destination_rpc, mailbox, message, probe, source):
    return relayer_process.verify_sealed_singleton(chain, destination_rpc, mailbox, message, probe, source)


def run_case(binary, oracle, contracts, filtered, temporary, output, mode):
    chain = evm.Chain(f"http://127.0.0.1:{relayer_process.port()}")
    anvil_log = (temporary / "anvil.log").open("w")
    anvil = relayer_process.subprocess.Popen(
        ["anvil", "--host", "127.0.0.1", "--port", chain.url.rsplit(":", 1)[1], "--chain-id", "31337", "--silent"],
        cwd=ROOT,
        stdout=anvil_log,
        stderr=anvil_log,
    )
    agents = []
    try:
        for _ in range(100):
            if anvil.poll() is not None:
                raise AssertionError("Anvil exited during startup")
            try:
                chain.account = chain.rpc("eth_accounts")[0]
                break
            except (ConnectionError, urllib.error.URLError):
                time.sleep(.05)
        else:
            raise AssertionError("Anvil readiness deadline")

        null = deploy(chain, contracts, "TestIsm")
        required = deploy(chain, contracts, "TestPostDispatchHook")
        domains = {}
        for name, domain in [("test1", ORIGIN), ("test2", DESTINATION)]:
            mailbox = deploy(chain, contracts, "Mailbox", "constructor(uint32)", str(domain))
            hook = deploy(chain, contracts, "MerkleTreeHook", "constructor(address)", mailbox)
            announce = deploy(chain, contracts, "ValidatorAnnounce", "constructor(address)", mailbox)
            igp = deploy(chain, contracts, "InterchainGasPaymaster")
            chain.send(evm.calldata("initialize(address,address)", chain.account, chain.account), igp)
            chain.send(evm.calldata("initialize(address,address,address,address)", chain.account, null, hook, required), mailbox)
            domains[name] = {
                "name": name,
                "domainId": domain,
                "chainId": 31337,
                "protocol": "ethereum",
                "rpcUrls": [{"http": chain.url}],
                "mailbox": mailbox,
                "merkleTreeHook": hook,
                "validatorAnnounce": announce,
                "interchainGasPaymaster": igp,
                "blocks": {"reorgPeriod": 0, "confirmations": 0, "estimateBlockTime": 1},
                "index": {"from": 0, "interval": 1},
                "signer": {"type": "hexKey", "key": "0x" + "11" * 32},
            }

        token = deploy(chain, contracts, "MockToken")
        transmitter = deploy(chain, contracts, "MockCircleMessageTransmitter", "constructor(address)", token)
        chain.send(evm.calldata("setVersion(uint32)", "2"), transmitter)
        runtime = chain.rpc("eth_getCode", [transmitter, "latest"])
        chain.rpc("anvil_setCode", [TESTNET_TRANSMITTER, runtime])
        caller = deploy(chain, contracts, "PublicRelayCaller")
        recipient = deploy(chain, contracts, "TestRecipient")
        recipient32 = "0x" + "00" * 12 + recipient[2:]
        chain.rpc("anvil_setBalance", [evm.TEST_SIGNER, hex(100 * 10**18)])

        def send(label):
            data = evm.calldata(
                "sendAndDispatch(address,address,uint32,bytes32,bytes)",
                TESTNET_TRANSMITTER,
                domains["test1"]["mailbox"],
                str(DESTINATION),
                recipient32,
                "0x" + label.encode().hex(),
            )
            receipt = chain.send(data, caller)
            event = next(
                value for value in receipt["logs"]
                if value["address"].lower() == domains["test1"]["mailbox"].lower() and value["topics"][0].lower() == DISPATCH_TOPIC.lower()
            )
            raw = bytes.fromhex(event["data"][2:])
            wire = raw[64:64 + int.from_bytes(raw[32:64], "big")]
            return {
                "id": evm.run(["cast", "keccak", "0x" + wire.hex()]),
                "wire": wire.hex(),
                "tx": receipt["transactionHash"],
                "label": label,
                "dispatch_block": int(receipt["blockNumber"], 16),
            }

        config_dir = temporary / "config"
        config_dir.mkdir()
        database = temporary / "db"
        admin_port = relayer_process.port()
        public_port = relayer_process.port()
        while public_port == admin_port:
            public_port = relayer_process.port()

        bootstrap = send("origin-handle-bootstrap") if filtered else None
        messages = [] if filtered else [send("public-first"), send("public-rate-limit")]
        proxy_type = DispatchFilterProxy if filtered else relayer_process.RpcProxy
        with proxy_type(chain) as origin_rpc, relayer_process.RpcProxy(chain) as destination_rpc:
            configured = json.loads(json.dumps(domains))
            configured["test1"]["rpcUrls"] = [{"http": origin_rpc.url}]
            configured["test2"]["rpcUrls"] = [{"http": destination_rpc.url}]
            settings = {
                "relayChains": "test1,test2",
                "db": str(database),
                "allowLocalCheckpointSyncers": True,
                "gasPaymentEnforcement": [{"type": "none"}],
                "metricsPort": admin_port,
                "relayApiEnabled": True,
                "relayApiPort": public_port,
                "relayApiRateLimitMaxRequests": 2,
                "relayApiRateLimitWindowSecs": 60,
                "relayApiCorsOrigins": "https://public.example",
                "chains": configured,
            }
            (config_dir / "public.json").write_text(json.dumps(settings))
            base_url = f"http://127.0.0.1:{public_port}/relay"
            log_path = temporary / "relayer.log"
            with log_path.open("w") as log:
                running = relayer_process.launch(binary, config_dir, log)
                agents.append(running)
                if filtered:
                    relayer_process.wait(lambda: delivered(chain, domains["test2"]["mailbox"], bootstrap["id"]), running, 60, "in-process origin handle bootstrap")
                    origin_rpc.drop_dispatch = True
                    messages = [send("public-first"), send("public-rate-limit")]
                relayer_process.wait(lambda: request(base_url)[0] == 200, running, 30, "public listener readiness")

                status, health, health_headers = request(base_url, origin="https://public.example")
                assert status == 200 and health == b"up" and health_headers.get("access-control-allow-origin") == "https://public.example"
                options_status, _, options_headers = request(base_url, "OPTIONS", origin="https://public.example")
                assert options_status == 204 and options_headers.get("access-control-allow-headers") == "content-type"

                status, admitted, admission_headers = request(base_url, "POST", {"origin_chain": "test1", "tx_hash": messages[0]["tx"]}, "https://public.example")
                assert status == 200 and admission_headers.get("content-type", "").startswith("application/json"), (status, admission_headers, admitted)
                admission = json.loads(admitted)
                assert admission["messages"][0]["message_id"].lower() == messages[0]["id"].lower().removeprefix("0x"), (admission, messages[0]["id"])

                duplicate_status, duplicate, _ = request(base_url, "POST", {"origin_chain": "test1", "tx_hash": messages[0]["tx"]}, "https://public.example")
                assert duplicate_status == 429 and duplicate == b"Transaction already submitted recently"
                limited_status, limited, _ = request(base_url, "POST", {"origin_chain": "test1", "tx_hash": messages[1]["tx"]}, "https://public.example")
                assert limited_status == 429 and limited == b"Rate limit exceeded"

                included = [bootstrap, messages[0]] if filtered else messages
                relayer_process.observe_inclusions(lambda identity: delivered(chain, domains["test2"]["mailbox"], identity), included, running, "all admitted and canonical public deliveries", destination_rpc, chain, domains["test2"]["mailbox"])
                assert destination_rpc.methods["eth_sendRawTransaction"] > 0, dict(destination_rpc.methods)
                if filtered:
                    assert not delivered(chain, domains["test2"]["mailbox"], messages[1]["id"])
                references = PublicAdminReferences(included, None if filtered else messages[0], temporary / "public-admin-references.jsonl")
                early_included = relayer_process.early_included_guard(admin_port, "test1", 0 if filtered else len(messages) - 1, included, initial=True, operation_normalizer=references.normalize)
                settlement = relayer_process.wait_for_retirement(admin_port, running, included, historical_confirmed_offset=0, historical_offset_reason="all current-process canonical and admitted public IDs tracked", operation_normalizer=references.normalize)
                settlement["public_admin_reference_observations"] = references.observations
                relayer_process.persist_progress(output, "public-"+mode+"-retired", {"destination":destination_rpc}, settlement=settlement, early_included=early_included)
                metrics_status, metrics_body, _ = request(f"http://127.0.0.1:{admin_port}/metrics")
                assert metrics_status == 200 and admin_port != public_port
                assert b"hyperlane_relay_api_requests_total" in metrics_body
                assert b"hyperlane_relay_api_processor_admission_duration_seconds" in metrics_body
                assert b"hyperlane_relay_api_requests_total{status=\"success\",error_type=\"\"} 1" in metrics_body
                assert b"hyperlane_relay_api_requests_total{status=\"failure\",error_type=\"duplicate_tx\"} 1" in metrics_body
                assert b"hyperlane_relay_api_requests_total{status=\"failure\",error_type=\"rate_limited\"} 1" in metrics_body
                nonce_before_restart = int(chain.rpc("eth_getTransactionCount", [evm.TEST_SIGNER, "latest"]), 16)
                raw_before_restart = len(destination_rpc.raw_transactions)
                shutdown = relayer_process.stop(running)
            assert shutdown["exit"] == 0, shutdown

            probe_count = len(messages) + (2 if filtered else 0)
            probe = relayer_process.rust_probe(oracle, database, probe_count)
            relayer_process.persist_progress(output, "public-"+mode+"-stopped-readback", {"destination":destination_rpc}, settlement=settlement, stopped_rust_readback=probe)
            assert len(probe["messages"]) == probe_count
            if filtered:
                assert probe["messages"][0]["present"] and probe["messages"][0]["processed"]
                for row in probe["messages"][1:]:
                    assert not row["present"] and not row.get("processed", False), row
                assert delivered(chain, domains["test2"]["mailbox"], messages[0]["id"])
                assert not delivered(chain, domains["test2"]["mailbox"], messages[1]["id"])
                sealed = [
                    verify_sealed_delivery(chain, destination_rpc, domains["test2"]["mailbox"], bootstrap, probe, "canonical"),
                    verify_sealed_delivery(chain, destination_rpc, domains["test2"]["mailbox"], messages[0], probe, "public_receipt_sidecar"),
                ]
                assert all("".join(link["message_id_chunks"]).lower() != messages[1]["id"].removeprefix("0x").lower() for link in probe["sealed_payload_links"])
            else:
                assert all(row["present"] and row["processed"] for row in probe["messages"]), probe
                sealed = [verify_sealed_delivery(chain, destination_rpc, domains["test2"]["mailbox"], message, probe, "canonical") for message in messages]

            with (temporary / "relayer-reindex.log").open("w") as reindex_log:
                reindexing = relayer_process.launch(binary, config_dir, reindex_log)
                agents.append(reindexing)
                readiness = relayer_process.wait_role_ready(admin_port, reindexing, data_type="merkle_tree_hook" if filtered else "dispatched_messages")
                reindex_stop = relayer_process.stop(reindexing)
            assert reindex_stop["exit"] == 0, reindex_stop
            restarted_probe = relayer_process.rust_probe(oracle, database, probe_count)
            assert restarted_probe == probe, (restarted_probe, probe)
            assert int(chain.rpc("eth_getTransactionCount", [evm.TEST_SIGNER, "latest"]), 16) == nonce_before_restart
            assert len(destination_rpc.raw_transactions) == raw_before_restart
            if filtered:
                assert not delivered(chain, domains["test2"]["mailbox"], messages[1]["id"])

            return {
                "passed": True,
                "mode": "sole_sidecar_dispatch_filtered" if filtered else "normal_indexed",
                "settings": settings,
                "contracts": {name: domains[name]["mailbox"] for name in domains},
                "testnet_transmitter": TESTNET_TRANSMITTER,
                "caller": caller,
                "recipient": recipient,
                "messages": [{"id_chunks": chunks(value["id"]), "label": value["label"], "dispatch_block": value["dispatch_block"], "delivered": delivered(chain, domains["test2"]["mailbox"], value["id"])} for value in messages],
                "admission": admission,
                "cors": {
                    "get_up": health.decode(),
                    "allow_origin": health_headers.get("access-control-allow-origin"),
                    "preflight_status": options_status,
                    "allow_headers": options_headers.get("access-control-allow-headers"),
                    "content_type": admission_headers.get("content-type"),
                },
                "duplicate": {"status": duplicate_status, "body": duplicate.decode()},
                "rate_limit": {"status": limited_status, "body": limited.decode()},
                "admin_metrics_separate_port": True,
                "rpc_methods": {"origin": dict(origin_rpc.methods), "destination": dict(destination_rpc.methods)},
                "early_included": early_included,
                "settlement": settlement,
                "sealed_delivery": sealed,
                "shutdown": shutdown,
                "restart_shutdown": reindex_stop,
                "restart_readiness": readiness,
                "restart_nonce_unchanged": True,
                "restart_broadcasts_unchanged": True,
                "stopped_rust_readback": probe,
                "restarted_stopped_rust_readback": restarted_probe,
                "canonical_nonce_absent": filtered,
                "nonce_processed_absent": filtered,
                "errors": [],
            }
    finally:
        for agent in agents:
            if agent.poll() is None:
                relayer_process.stop(agent)
        anvil.terminate()
        try:
            anvil.wait(timeout=5)
        except relayer_process.subprocess.TimeoutExpired:
            anvil.kill()
            anvil.wait()


def run_case_with_artifacts(binary, oracle, contracts, filtered, prefix, output, mode):
    with tempfile.TemporaryDirectory(prefix=prefix) as directory:
        try:
            return run_case(binary, oracle, contracts, filtered, pathlib.Path(directory), output, mode)
        except Exception as error:
            preserve = output.parent / f"{output.stem}-fixtures" / mode
            preserve.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(directory, preserve, dirs_exist_ok=True)
            partial = relayer_process.persist_failure(output,error,preserve)
            (preserve / "partial-result.json").write_text(json.dumps(partial, indent=2) + "\n")
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=pathlib.Path, default=ROOT / "zig/zig-out/bin/relayer")
    parser.add_argument("--oracle", type=pathlib.Path, default=relayer_process.IMMUTABLE_ORACLE)
    parser.add_argument("--tool-manifest", type=pathlib.Path)
    parser.add_argument("--tool-manifest-sha256")
    parser.add_argument("--tool-source-commit")
    parser.add_argument("--output", type=pathlib.Path, default=ROOT / "zig/bench/results/public-relay-process.json")
    parser.add_argument("--compile-only", action="store_true")
    args = parser.parse_args()
    contracts = compile_contracts()
    if args.compile_only:
        print(json.dumps({"compiled": list(contracts)}))
        return
    binary = relayer_process.pin(args.binary, "relayer")
    oracle = relayer_process.verified_oracle(args.oracle,args.tool_manifest,args.tool_manifest_sha256,args.tool_source_commit)
    result = {
        "passed": False,
        "scope": __doc__,
        "binary_sha256_chunks": sha(binary),
        "rust_oracle_sha256_chunks": sha(oracle),
        "fixture_sha256_chunks": {
            "caller": sha(ROOT / "zig/integration/public_contracts/PublicRelayCaller.sol"),
            "transmitter": sha(ROOT / "solidity/contracts/mock/MockCircleMessageTransmitter.sol"),
        },
        "errors": [],
    }
    try:
        result["normal_indexed"] = run_case_with_artifacts(binary, oracle, contracts, False, "ziggy-public-relay-normal-", args.output, "normal_indexed")
        result["sole_sidecar"] = run_case_with_artifacts(binary, oracle, contracts, True, "ziggy-public-relay-sidecar-", args.output, "sole_sidecar")
        result["passed"] = True
    except Exception as error:
        result["errors"].append({"type": type(error).__name__, "detail": "acceptance assertion failed; see local test output"})
        args.output.parent.mkdir(parents=True, exist_ok=True)
        relayer_process.persist_failure(args.output,error)
        relayer_process.finish_result(args.output,result)
        raise
    args.output.parent.mkdir(parents=True, exist_ok=True)
    relayer_process.finish_result(args.output,result)
    print(json.dumps({"passed": True, "normal_indexed": True, "sole_sidecar": True}))


if __name__ == "__main__":
    main()
