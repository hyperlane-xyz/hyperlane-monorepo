#!/usr/bin/env python3
"""Regenerate public transaction/signature fixtures using the production ethers fork."""
import argparse
import gzip
import json
from pathlib import Path
import random
import subprocess

ROOT = Path(__file__).resolve().parents[3]
ORDER = (0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFE << 128) | 0xBAAEDCE6AF48A03BBFD25E8CD0364141
REV = "66bd6198d8952adfd9395e3f3727682443a031c7"


def chunks(data):
    text = data.hex() if isinstance(data, bytes) else data
    return [text[i:i+32] for i in range(0, len(text), 32)] or [""]


def quantity(number):
    text = hex(number)
    return text if len(text) < 64 else chunks(text)


def unhex(chunks_or_string):
    return bytes.fromhex("".join(chunks_or_string) if isinstance(chunks_or_string, list) else chunks_or_string)


def inputs():
    base = dict(type="legacy", name="legacy_transfer", chain_id="0x1", nonce="0x0", gas_price="0x4a817c800",
                gas_limit="0x5208", to=chunks(bytes([0x22]) * 20), value="0x1", data=[""],
                secret_key=chunks(bytes([0x11]) * 32))
    cases = [base, dict(base, name="legacy_unprotected", chain_id=None),
             dict(base, name="legacy_zero", chain_id="0x0", gas_price="0x0", gas_limit="0x0", value="0x0"),
             dict(base, name="legacy_create", nonce="0x1", to=None, data=chunks(bytes.fromhex("6000600055")))]
    for size in [1, 55, 56, 127, 128, 255, 256, 1024]:
        cases.append(dict(base, name=f"legacy_data_{size}", data=chunks(bytes(i % 256 for i in range(size))), nonce=quantity(size)))
    cases.append(dict(base, name="legacy_u256_limits", nonce=quantity(2**256-1), gas_price=quantity(2**256-1),
                      gas_limit=quantity(2**256-1), value=quantity(2**256-1), chain_id="0x100000000"))
    typed = {key:value for key,value in base.items() if key != "gas_price"}
    typed.update(type="eip1559", name="eip1559_transfer", max_priority_fee_per_gas="0x3b9aca00",
                 max_fee_per_gas="0x77359400", access_list=[])
    cases += [typed, dict(typed, name="eip1559_create", to=None, data=chunks(bytes.fromhex("6000600055"))),
              dict(typed, name="eip1559_empty_fees", chain_id="0x0", max_priority_fee_per_gas="0x0", max_fee_per_gas="0x0"),
              dict(typed, name="eip1559_access_empty_keys", access_list=[dict(address=chunks(bytes([0x33])*20),storage_keys=[])]),
              dict(typed, name="eip1559_access_keys", data=chunks(bytes(range(128))),
                   access_list=[dict(address=chunks(bytes([0x33])*20),storage_keys=[chunks(bytes(32)),chunks(bytes([255])*32)]),
                                dict(address=chunks(bytes([0x44])*20),storage_keys=[chunks(bytes(range(32)))])]),
              dict(typed, name="eip1559_u256_limits", nonce=quantity(2**256-1), value=quantity(2**256-1),
                   max_priority_fee_per_gas=quantity(2**256-1), max_fee_per_gas=quantity(2**256-1), gas_limit=quantity(2**256-1))]
    rng = random.Random(0x45564D)
    for index in range(32):
        source = base if index % 2 == 0 else typed
        cases.append(dict(source, name=f"seeded_{index}", chain_id=quantity(rng.randrange(1,2**32)),
                          nonce=quantity(rng.randrange(2**64)), value=quantity(rng.randrange(2**256)),
                          gas_limit=quantity(rng.randrange(21000,30000000)), to=chunks(rng.randbytes(20)),
                          data=chunks(rng.randbytes(rng.randrange(257)))))
    return cases


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rust-toolchain", default="1.98.0")
    parser.add_argument("--skip-build", action="store_true")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--oracle", type=Path, default=ROOT / "rust/main/target/release/ziggy-evm-oracle")
    args = parser.parse_args()
    folder = ROOT / "zig/reference/evm"
    if not args.skip_build:
        subprocess.run(["python3", "zig/tools/fixture_pack.py", "restore-locks"], check=True, cwd=ROOT)
        command = ["cargo", f"+{args.rust_toolchain}", "build", "--locked", "--manifest-path", str(folder / "Cargo.toml"), "--release", "--target-dir", str(ROOT / "rust/main/target"), "-j", "2"]
        subprocess.run(command, check=True, cwd=ROOT / "rust/main")
    binary = args.oracle.resolve()
    def save(output, content):
        wire=content.encode();compressed=output.with_name(output.name+".gz")
        if args.check:
            if gzip.decompress(compressed.read_bytes())!=wire:raise SystemExit(f"Production fixture differs: {output}")
            if output.exists()and output.read_bytes()!=wire:raise SystemExit(f"Local raw fixture differs: {output}")
        else:
            output.write_bytes(wire);compressed.write_bytes(gzip.compress(wire,mtime=0))
    def oracle(cases):
        result = subprocess.run([str(binary)], input="\n".join(json.dumps(case) for case in cases) + "\n",
                                check=True, text=True, capture_output=True, cwd=ROOT)
        return [json.loads(line) for line in result.stdout.splitlines()]
    txs = oracle(inputs())
    output = ROOT / "zig/src/evm/fixtures/transactions.jsonl"
    output.parent.mkdir(parents=True, exist_ok=True)
    save(output, "\n".join(json.dumps(tx,separators=(",",":")) for tx in txs) + "\n")
    signature = unhex(txs[0]["expected"]["signature"])
    digest = txs[0]["expected"]["signing_hash"]
    r = signature[:32]
    s = signature[32:64]
    recid = signature[64] - 27
    recovery = []
    for v in [0,1,2,3,26,27,28,29,34,35,36,37,38,255,256,2**64-1]:
        recovery.append(dict(operation="recover", name=f"v_{v}",digest=digest,r=chunks(r),s=chunks(s),v=quantity(v)))
    for label,r_value,s_value in [("high_s",r,(ORDER-int.from_bytes(s,"big")).to_bytes(32,"big")),
                                 ("r_zero",bytes(32),s),("s_zero",r,bytes(32)),
                                 ("r_order",ORDER.to_bytes(32,"big"),s),
                                 ("s_order",r,ORDER.to_bytes(32,"big"))]:
        recovery.append(dict(operation="recover", name=label,digest=digest,r=chunks(r_value),s=chunks(s_value),
                             v=quantity(27+(1-recid if label=="high_s" else recid))))
    recovered = oracle(recovery)
    recovery_output = ROOT / "zig/src/protocol/fixtures/ethers-recovery.json"
    recovery_output.parent.mkdir(parents=True, exist_ok=True)
    save(recovery_output, json.dumps({"source":"hyperlane-xyz/ethers-rs ethers-core Signature::recover", "revision":REV,
                                          "cases":recovered},indent=2)+"\n")
    print(f"{'Checked' if args.check else 'Generated'} {len(txs)} transaction fixtures and {len(recovered)} signature-recovery fixtures")
    for item in recovered:
        print(item["input"]["name"],item["expected"]["signer"])


if __name__ == "__main__":
    main()
