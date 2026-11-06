#!/usr/bin/env python3
"""Validate Zig-produced signatures with the actual pinned production Radix SDK."""
import argparse
import gzip
import json
import pathlib
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("--zig-executable", required=True)
parser.add_argument("--rust-executable", default=str(pathlib.Path(__file__).parent / "target/debug/ziggy-radix-reference"))
parser.add_argument("--report", required=True)
args = parser.parse_args()
fixture = json.loads(gzip.decompress((pathlib.Path(__file__).parent.parent / "fixtures/sdk.json.gz").read_bytes()))
requests = []
for case in fixture["crypto_cases"]:
    for kind in ("ed", "secp"):
        produced = json.loads(subprocess.check_output([args.zig_executable, kind, case["seed"], case["digest"]], text=True))
        request = dict(produced, kind=kind, digest=case["digest"])
        requests.append((request, True))
        for field in ("digest", "signature"):
            corrupted = bytes.fromhex(request[field])
            corrupted = corrupted[:-1] + bytes([corrupted[-1] ^ 1])
            requests.append((dict(request, **{field: corrupted.hex()}), False))
result = subprocess.run([args.rust_executable, "verify"], input="".join(json.dumps(r) + "\n" for r, _ in requests), text=True, capture_output=True, check=True)
outputs = [json.loads(line)["valid"] for line in result.stdout.splitlines()]
assert outputs == [expected for _, expected in requests], "SDK signature verification mismatch"
report = {"source": fixture["source"], "cases": len(fixture["crypto_cases"]), "zig_signatures_verified_by_radix_sdk": sum(outputs), "altered_digest_or_signature_rejected": len(outputs) - sum(outputs), "success": True}
pathlib.Path(args.report).write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report))
