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

SNARKVM_REVISION = "6c5b8762d8058287d1d2ca27c391aeb0eccdf9fa"
MAX_FILE_BYTES = 128 * 1024 * 1024


def parameter_catalog(source: Path, network: str, max_degree: int):
    """KZG universal powers are shared mainnet assets; credits are network-specific."""
    if network not in {"mainnet", "testnet", "canary"} or max_degree not in range(15, 21):
        raise ValueError("Invalid parameter network/degree")
    records = []
    for degree in range(15, max_degree + 1):
        for prefix in ["powers-of-beta-", "shifted-powers-of-beta-"]:
            name = f"{prefix}{degree}"
            metadata = source / "mainnet/resources" / (name + ".metadata")
            item = json.loads(metadata.read_text())
            records.append(("mainnet", name, "usrs", item["checksum"], item["size"]))
    for credits in ["credits", "credits_v0"]:
        item = json.loads((source / network / "resources" / credits / "fee_public.metadata").read_text())
        records.append((network, "fee_public", "prover", item["prover_checksum"], item["prover_size"]))
    return records


def cargo_metadata(manifest: Path):
    return json.loads(subprocess.check_output([
        "cargo", "+1.98.0", "metadata", "--locked", "--offline",
        "--format-version=1", "--manifest-path", str(manifest),
    ], text=True))


def provision(home: Path, network: str, records, fetch: bool):
    destination = home.resolve() / ".aleo/resources"
    destination.mkdir(parents=True, exist_ok=True)
    seen = set()
    total = 0
    for source_network, name, kind, digest, size in records:
        if size > MAX_FILE_BYTES:
            raise SystemExit("Parameter file exceeds configured fetch cap")
        filename = f"{name}.{kind}.{digest[:7]}"
        if filename in seen:
            continue
        seen.add(filename)
        path = destination / filename
        if not path.exists() and fetch:
            public_urls = [
                f"https://parameters.provable.com/{source_network}/{filename}",
                f"https://s3.us-west-1.amazonaws.com/{source_network}.parameters/{filename}",
            ]
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
        with path.open("rb") as stream:
            if path.stat().st_size != size or hashlib.file_digest(stream, "sha256").hexdigest() != digest:
                raise SystemExit("Existing parameter checksum or size mismatch")
        total += size
    return {"network": network, "files": len(seen), "bytes": total, "home": str(home.resolve())}


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", type=Path, required=True)
    parser.add_argument("--network", choices=["mainnet", "testnet", "canary"], default="mainnet")
    parser.add_argument("--max-degree", type=int, choices=range(15, 21), default=18)
    parser.add_argument("--fetch", action="store_true")
    args = parser.parse_args(argv)
    base = Path(__file__).resolve().parents[1]
    metadata = cargo_metadata(base / "native-vm/Cargo.toml")
    package = next(p for p in metadata["packages"] if p["name"] == "snarkvm-parameters")
    if SNARKVM_REVISION not in package["source"]:
        raise SystemExit("Unexpected SnarkVM parameter revision")
    source = Path(package["manifest_path"]).parent / "src"
    records = parameter_catalog(source, args.network, args.max_degree)
    print(json.dumps(provision(args.home, args.network, records, args.fetch)))


if __name__ == "__main__":
    main()
