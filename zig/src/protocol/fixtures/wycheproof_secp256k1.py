#!/usr/bin/env python3
"""Flatten Wycheproof ecdsa_secp256k1_sha256{,_bitcoin}_test.json for signature.zig.

Usage (inputs from https://github.com/C2SP/wycheproof testvectors_v1/):
  python3 -I wycheproof_secp256k1.py ecdsa_secp256k1_sha256_test.json \
      ecdsa_secp256k1_sha256_bitcoin_test.json | gzip -9n > wycheproof-secp256k1.json.gz

Each case keeps Wycheproof's result. The digest is SHA-256(msg). Signatures
that are not strict DER become der_valid=false (Ethereum signatures are not
DER, so the Zig side rejects them unconditionally). DER integers in [0, 2^256)
are emitted as decimal strings; anything else (negative, wider) becomes
"out_of_range", which no 32-byte Ethereum signature field can encode.
"""
import hashlib
import json
import sys


def der_ints(sig):
    """Strict DER SEQUENCE{INTEGER r, INTEGER s}; None if not canonical DER."""
    def length(buf, i):
        if i >= len(buf):
            return None, i
        first = buf[i]
        i += 1
        if first < 0x80:
            return first, i
        count = first & 0x7F
        if count == 0 or count > 2 or i + count > len(buf):
            return None, i
        value = int.from_bytes(buf[i:i + count], "big")
        if value < 0x80 or (count == 2 and value < 0x100) or buf[i] == 0:
            return None, i
        return value, i + count

    def integer(buf, i):
        if i >= len(buf) or buf[i] != 0x02:
            return None, i
        n, i = length(buf, i + 1)
        if n is None or n == 0 or i + n > len(buf):
            return None, i
        body = buf[i:i + n]
        # Minimal encoding: no redundant leading 0x00 / 0xff.
        if n > 1 and ((body[0] == 0 and body[1] < 0x80) or (body[0] == 0xFF and body[1] >= 0x80)):
            return None, i
        return int.from_bytes(body, "big", signed=True), i + n

    if len(sig) < 2 or sig[0] != 0x30:
        return None
    total, i = length(sig, 1)
    if total is None or i + total != len(sig):
        return None
    r, i = integer(sig, i)
    if r is None:
        return None
    s, i = integer(sig, i)
    if s is None or i != len(sig):
        return None
    return r, s


def field(v):
    return str(v) if 0 <= v < 2**256 else "out_of_range"


cases = []
for path in sys.argv[1:]:
    data = json.load(open(path))
    bitcoin = "bitcoin" in data.get("schema", "") or "bitcoin" in path
    for group in data["testGroups"]:
        key = bytes.fromhex(group["publicKey"]["uncompressed"])
        assert len(key) == 65 and key[0] == 4
        for test in group["tests"]:
            parsed = der_ints(bytes.fromhex(test["sig"]))
            cases.append({
                "id": test["tcId"],
                "low_s_required": bitcoin,
                "x": key[1:33].hex(),
                "y": key[33:].hex(),
                "digest": hashlib.sha256(bytes.fromhex(test["msg"])).hexdigest(),
                "der_valid": parsed is not None,
                "r": field(parsed[0]) if parsed else "0",
                "s": field(parsed[1]) if parsed else "0",
                "result": test["result"],
            })
json.dump({"source": "C2SP/wycheproof testvectors_v1", "files": [p.rsplit("/", 1)[-1] for p in sys.argv[1:]], "cases": cases},
          sys.stdout, separators=(",", ":"))
