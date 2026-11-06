#!/usr/bin/env python3
"""Provision explicit public proving parameters, verified against pinned metadata."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import urllib.request
import urllib.error

parser = argparse.ArgumentParser()
parser.add_argument("--home", type=Path, required=True)
parser.add_argument("--network", choices=["mainnet", "testnet", "canary"], default="mainnet")
parser.add_argument("--max-degree", type=int, choices=range(15, 21), default=18)
parser.add_argument("--fetch", action="store_true")
args = parser.parse_args()
base = Path(__file__).resolve().parents[1]
metadata = json.loads(subprocess.check_output(["cargo", "+1.98.0", "metadata", "--locked", "--format-version=1", "--manifest-path", str(base / "native-vm/Cargo.toml")], text=True))
package = next(p for p in metadata["packages"] if p["name"] == "snarkvm-parameters")
if "6c5b8762d8058287d1d2ca27c391aeb0eccdf9fa" not in package["source"]:
    raise SystemExit("Unexpected SnarkVM parameter revision")
source = Path(package["manifest_path"]).parent / "src" / args.network / "resources"
records = []
for degree in range(15, args.max_degree + 1):
    for prefix in ["powers-of-beta-", "shifted-powers-of-beta-"]:
        name = f"{prefix}{degree}"
        item = json.loads((source / (name + ".metadata")).read_text())
        records.append((name, "usrs", item["checksum"], item["size"]))
for credits in ["credits", "credits_v0"]:
    item = json.loads((source / credits / "fee_public.metadata").read_text())
    records.append(("fee_public", "prover", item["prover_checksum"], item["prover_size"]))
destination = args.home.resolve() / ".aleo/resources"
destination.mkdir(parents=True, exist_ok=True)
seen = set()
total = 0
for name, kind, digest, size in records:
    if size > 128 * 1024 * 1024:
        raise SystemExit("Parameter file exceeds configured fetch cap")
    filename = f"{name}.{kind}.{digest[:7]}"
    if filename in seen:
        continue
    seen.add(filename)
    path = destination / filename
    if not path.exists() and args.fetch:
        public_urls = [f"https://parameters.provable.com/{args.network}/{filename}", f"https://s3.us-west-1.amazonaws.com/{args.network}.parameters/{filename}"]
        response = None
        for public_url in public_urls:
            request = urllib.request.Request(public_url)
            try:
                response = urllib.request.urlopen(request, timeout=30)
                break
            except urllib.error.HTTPError as error:
                if error.code not in {403, 404, 429, 500, 502, 503, 504}:
                    raise
        if response is None:
            raise SystemExit("Pinned public parameter mirrors unavailable")
        # Explicit public artifact download only; no credentials or HOME lookup.
        with response:
            if response.geturl() != request.full_url:
                raise SystemExit("Unexpected parameter redirect")
            with tempfile.NamedTemporaryFile(dir=destination, delete=False) as output:
                temporary = Path(output.name)
                try:
                    measured = 0
                    checksum = hashlib.sha256()
                    while chunk := response.read(1024 * 1024):
                        measured += len(chunk)
                        if measured > size:
                            raise SystemExit("Oversized public parameter file")
                        checksum.update(chunk)
                        output.write(chunk)
                    if measured != size or checksum.hexdigest() != digest:
                        raise SystemExit("Parameter checksum or size mismatch")
                    output.flush()
                    output.close()
                    temporary.replace(path)
                finally:
                    temporary.unlink(missing_ok=True)
    if not path.exists():
        raise SystemExit(f"Missing explicit public parameter {filename}; use --fetch")
    if path.stat().st_size != size or hashlib.file_digest(path.open("rb"), "sha256").hexdigest() != digest:
        raise SystemExit("Existing parameter checksum or size mismatch")
    total += size
print(json.dumps({"network": args.network, "files": len(seen), "bytes": total, "home": str(args.home.resolve())}))
