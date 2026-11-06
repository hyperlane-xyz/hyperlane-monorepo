#!/usr/bin/env python3
"""Generate EIP-3668 fixtures with the independent Foundry ABI encoder."""
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[1]


def cast(*args):
    return subprocess.check_output(["cast", *args], text=True).strip()


def main():
    signature = "OffchainLookup(address,string[],bytes,bytes4,bytes)"
    args = ["0x" + "03" * 20, '["https://ccs.example/{sender}/{data}","https://ccs.example/lookup"]', "0x0011ff", "0x12345678", "0xaabb"]
    selector = cast("sig", signature)
    payload = selector + cast("abi-encode", signature, *args)[2:]
    result = {"encoder": cast("--version"), "signature": signature, "arguments": args, "chunks": [payload[i:i + 48] for i in range(0, len(payload), 48)]}
    output = ROOT / "src/relayer/testing/ccip-lookup.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
