#!/usr/bin/env python3
"""Exercise Zig metadata/signing/recovery against repository Solidity on Anvil.

Uses disposable local contracts, unlocked Anvil deployment accounts, and a public
test key embedded in the Zig fixture. Never reads user credentials or RPC URLs.
This is a correctness integration test, not a Rust-vs-Zig throughput benchmark.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import posixpath
import re
import socket
import subprocess
import tarfile
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
DEPENDENCIES = {
    "contracts": "He3LieZ1pP2TNt5JbkPA4PNT9WC3gOTOlDcFGJW4Le4QKqwmiNJCRt44APfxMxvq7OugU/cqYuPcSBzOw38DAg==",
    "contracts-upgradeable": "jjaHAVRMrE4UuZNfDwjlLGDxTHWIOwTJS2ldnc278a0gevfXfPr8hxKEVBGFBE96kl2G3VHDZhUimw/+G3TG2A==",
}
CONTRACTS = {
    "Mailbox": "solidity/contracts/Mailbox.sol",
    "MerkleTreeHook": "solidity/contracts/hooks/MerkleTreeHook.sol",
    "TestIsm": "solidity/contracts/test/TestIsm.sol",
    "TestRecipient": "solidity/contracts/test/TestRecipient.sol",
    "TestPostDispatchHook": "solidity/contracts/test/TestPostDispatchHook.sol",
    "StorageMessageIdMultisigIsm": "solidity/contracts/isms/multisig/StorageMultisigIsm.sol",
    "StorageMerkleRootMultisigIsm": "solidity/contracts/isms/multisig/StorageMultisigIsm.sol",
    "StorageAggregationIsm": "solidity/contracts/isms/aggregation/StorageAggregationIsm.sol",
    "DomainRoutingIsm": "solidity/contracts/isms/routing/DomainRoutingIsm.sol",
    "TestCcipReadIsm": "solidity/contracts/test/TestCcipReadIsm.sol",
}
TEST_SIGNER = "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a"


def run(args, **kwargs):
    result = subprocess.run([str(arg) for arg in args], cwd=ROOT, text=True, capture_output=True, timeout=180, **kwargs)
    if result.returncode:
        raise RuntimeError(f"command failed: {args[0]}\n{result.stderr[-5000:]}\n{result.stdout[-2000:]}")
    return result.stdout.strip()


def compiler_inputs():
    for package, integrity in DEPENDENCIES.items():
        destination = HERE / ".deps" / package
        if not destination.is_dir():
            url = f"https://registry.npmjs.org/@openzeppelin/{package}/-/{package}-4.9.3.tgz"
            with urllib.request.urlopen(url, timeout=30) as response:
                data = response.read()
            assert base64.b64encode(hashlib.sha512(data).digest()).decode() == integrity
            destination.mkdir(parents=True)
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
                # npm tarballs have one package/ prefix. Preserve only data.
                archive.extractall(destination, filter="data")
    sources = {}

    def read(path):
        if path in sources:
            return
        if path.startswith("@openzeppelin/"):
            package, relative = path[len("@openzeppelin/"):].split("/", 1)
            source_path = HERE / ".deps" / package / "package" / relative
        else:
            source_path = ROOT / path
        text = source_path.read_text()
        sources[path] = {"content": text}
        for imported in re.findall(r"import\s+(?:[^;]*?from\s+)?[\"']([^\"']+)[\"']\s*;", text):
            child = posixpath.normpath(posixpath.join(posixpath.dirname(path), imported)) if imported.startswith(".") else imported
            read(child)

    for path in CONTRACTS.values():
        read(path)
    return {"language": "Solidity", "sources": sources, "settings": {"optimizer": {"enabled": True, "runs": 10000}, "evmVersion": "cancun", "outputSelection": {"*": {"*": ["abi", "evm.bytecode.object"]}}}}


def compile_contracts():
    inputs = compiler_inputs()
    encoded = json.dumps(inputs, sort_keys=True).encode()
    digest = hashlib.sha256(encoded).hexdigest()
    manifest = CACHE / "contracts.json"
    if manifest.exists():
        cached = json.loads(manifest.read_text())
        if cached["input_digest"] == digest:
            return cached["contracts"]
    request = CACHE / "solc-input.json"
    response = CACHE / "solc-output.json"
    request.write_bytes(encoded)
    with request.open() as stdin, response.open("w") as stdout:
        result = subprocess.run(["pnpm", "dlx", "solc@0.8.33", "--standard-json"], cwd=ROOT, stdin=stdin, stdout=stdout, stderr=subprocess.PIPE, text=True, timeout=180)
    if result.returncode:
        raise RuntimeError(result.stderr)
    text = response.read_text()
    output = json.loads(text[text.index("{"):])
    errors = [error for error in output.get("errors", []) if error["severity"] == "error"]
    if errors:
        raise RuntimeError("\n".join(error["formattedMessage"] for error in errors))
    contracts = {name: output["contracts"][path][name]["evm"]["bytecode"]["object"] for name, path in CONTRACTS.items()}
    manifest.write_text(json.dumps({"input_digest": digest, "contracts": contracts}))
    return contracts


class Chain:
    def __init__(self, url):
        self.url = url
        self.counter = 0

    def rpc(self, method, params=()):
        self.counter += 1
        request = urllib.request.Request(self.url, data=json.dumps({"jsonrpc": "2.0", "id": self.counter, "method": method, "params": list(params)}).encode(), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=20) as response:
            result = json.load(response)
        if "error" in result:
            raise RuntimeError(f"{method}: RPC error {result['error']['code']}: {result['error']['message']}")
        return result["result"]

    def receipt(self, transaction):
        for _ in range(100):
            receipt = self.rpc("eth_getTransactionReceipt", [transaction])
            if receipt:
                assert receipt["status"] == "0x1", receipt
                return receipt
            time.sleep(0.02)
        raise RuntimeError("local transaction was not mined")

    def send(self, data, to=None):
        transaction = {"from": self.account, "data": data, "gas": "0xe00000"}
        if to:
            transaction["to"] = to
        return self.receipt(self.rpc("eth_sendTransaction", [transaction]))


def abi(signature, *args):
    return run(["cast", "abi-encode", signature, *args])[2:]


def calldata(signature, *args):
    return run(["cast", "calldata", signature, *args])


def exercise(chain, contracts, driver, temporary, origin_driver=None, curl_library=None):
    deployed = {}

    def deploy(name, signature=None, *args):
        data = "0x" + contracts[name] + (abi(signature, *args) if signature else "")
        receipt = chain.send(data)
        deployed[name] = receipt["contractAddress"]
        return receipt["contractAddress"]

    origin = deploy("Mailbox", "constructor(uint32)", "1000")
    destination = deploy("Mailbox", "constructor(uint32)", "2000")
    origin_hook = deploy("MerkleTreeHook", "constructor(address)", origin)
    destination_hook = deploy("MerkleTreeHook", "constructor(address)", destination)
    required = deploy("TestPostDispatchHook")
    null_ism = deploy("TestIsm")
    recipient = deploy("TestRecipient")
    ccip_ism = deploy("TestCcipReadIsm", "constructor(string[])", '["https://ccs.example/{sender}/{data}"]')
    for mailbox, hook in [(origin, origin_hook), (destination, destination_hook)]:
        chain.send(calldata("initialize(address,address,address,address)", chain.account, null_ism, hook, required), mailbox)
    message_id_ism = deploy("StorageMessageIdMultisigIsm", "constructor(address[],uint8)", f"[{TEST_SIGNER}]", "1")
    merkle_root_ism = deploy("StorageMerkleRootMultisigIsm", "constructor(address[],uint8)", f"[{TEST_SIGNER}]", "1")
    aggregation = deploy("StorageAggregationIsm", "constructor(address[],uint8)", f"[{message_id_ism},{null_ism}]", "2")
    routing = deploy("DomainRoutingIsm")
    chain.send(calldata("initialize(address)", chain.account), routing)
    chain.send(calldata("set(uint32,address)", "1000", aggregation), routing)
    chain.rpc("anvil_setBalance", [TEST_SIGNER, hex(100 * 10**18)])
    dispatch_topic = run(["cast", "keccak", "Dispatch(address,uint32,bytes32,bytes)"])
    recipient32 = "0x" + "00" * 12 + recipient[2:]
    messages = []
    for body in [b"zig message-ID multisig", b"zig Merkle-root multisig", b"zig routing + aggregation"]:
        receipt = chain.send(calldata("dispatch(uint32,bytes32,bytes)", "2000", recipient32, "0x" + body.hex()), origin)
        log = next(log for log in receipt["logs"] if log["address"].lower() == origin.lower() and log["topics"][0] == dispatch_topic)
        data = bytes.fromhex(log["data"][2:])
        length = int.from_bytes(data[32:64], "big")
        messages.append("0x" + data[64:64 + length].hex())
    config = {"rpc_url": chain.url, "origin_domain": 1000, "destination_domain": 2000, "origin_hook": origin_hook, "origin_mailbox": origin, "destination_mailbox": destination, "state_dir": str(temporary), "messages": messages, "message_index": 0}
    config["ccip_ism"] = ccip_ism
    native_origin = None
    if origin_driver:
        if not curl_library:
            raise ValueError("--origin-driver requires --curl-library")
        origin_fixture = temporary / "origin-fixture.json"
        origin_fixture.write_text(json.dumps(dict(config, curl_library=curl_library)))
        native_origin = json.loads(run([origin_driver, origin_fixture]))
        assert native_origin["passed"] and native_origin["native_rocksdb"]
        assert native_origin["messages"] == len(messages)
    results = []
    for index, module in enumerate([message_id_ism, merkle_root_ism, routing]):
        chain.send(calldata("setInterchainSecurityModule(address)", module), recipient)
        config["message_index"] = index
        path = temporary / "fixture.json"
        if index == 0:
            config["reserve_only"] = True
            path.write_text(json.dumps(config))
            reserved = json.loads(run([driver, path]))
            assert reserved["stage"] == "reserved"
            before = chain.rpc("eth_getTransactionCount", [TEST_SIGNER, "pending"])
            assert before == "0x0", before
        config["reserve_only"] = False
        path.write_text(json.dumps(config))
        delivered = json.loads(run([driver, path]))
        assert delivered["stage"] == "delivered", delivered
        if index == 0:
            assert delivered["transaction"] == reserved["transaction"]
        nonce_before = chain.rpc("eth_getTransactionCount", [TEST_SIGNER, "pending"])
        replay = json.loads(run([driver, path]))
        assert replay["stage"] == "already_delivered"
        assert chain.rpc("eth_getTransactionCount", [TEST_SIGNER, "pending"]) == nonce_before
        results.append({"case": ["message_id_multisig_crash_recovery", "merkle_root_multisig", "routing_aggregation"][index], "delivered": True, "idempotent_replay": True, "canonical_origin_indexing": True, "ccip_revert_and_get_request": True})
    return {"scope": "local EVM correctness; not whole-agent performance", "contracts": CONTRACTS, "compiler": "solc 0.8.33", "cases": results, "native_origin_service": native_origin, "rpc_calls_python_driver": chain.counter, "passed": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--driver", type=Path, default=ROOT / "zig/zig-out/bin/zig-evm-integration")
    parser.add_argument("--output", type=Path, default=ROOT / "zig/bench/results/evm-integration.json")
    parser.add_argument("--origin-driver", type=Path)
    parser.add_argument("--curl-library")
    args = parser.parse_args()
    CACHE.mkdir(parents=True, exist_ok=True)
    contracts = compile_contracts()
    with socket.socket() as reserve:
        reserve.bind(("127.0.0.1", 0))
        port = reserve.getsockname()[1]
    chain = Chain(f"http://127.0.0.1:{port}")
    with (CACHE / "anvil.log").open("w") as log, tempfile.TemporaryDirectory(prefix="ziggy-evm-") as temporary:
        process = subprocess.Popen(["anvil", "--host", "127.0.0.1", "--port", str(port), "--chain-id", "31337", "--silent"], cwd=ROOT, stdout=log, stderr=log)
        try:
            for _ in range(100):
                if process.poll() is not None:
                    raise RuntimeError("Anvil exited during startup")
                try:
                    chain.account = chain.rpc("eth_accounts")[0]
                    break
                except (ConnectionError, urllib.error.URLError):
                    time.sleep(0.05)
            else:
                raise RuntimeError("Anvil startup deadline exceeded")
            result = exercise(chain, contracts, args.driver.resolve(), Path(temporary), args.origin_driver.resolve() if args.origin_driver else None, args.curl_library)
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(result, indent=2) + "\n")
            print(json.dumps(result))
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


if __name__ == "__main__":
    main()
