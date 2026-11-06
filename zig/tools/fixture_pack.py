#!/usr/bin/env python3
"""Lossless, deterministic public-fixture packing and Cargo-lock restoration."""
from __future__ import annotations
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MAXIMUM = 128 * 1024 * 1024
ARTIFACT_MANIFEST = ROOT / "zig/bench/results/packed-oracle-artifacts.json"
LOCK_MANIFEST = ROOT / "zig/tools/fixture-locks.json"


def checksum(wire: bytes) -> list[str]:
    text = hashlib.sha256(wire).hexdigest()
    return [text[i:i + 31] for i in range(0, len(text), 31)]


def unpack(path: Path) -> bytes:
    with gzip.open(path, "rb") as stream:
        wire = stream.read(MAXIMUM + 1)
    if len(wire) > MAXIMUM:
        raise ValueError("Fixture exceeds decompression limit")
    return wire


def contained(path: Path) -> Path:
    for candidate in (path, *path.parents):
        if candidate.is_symlink():
            raise ValueError("Symlink fixture or parent rejected")
    resolved = path.resolve()
    if not resolved.is_relative_to(ROOT):
        raise ValueError("Fixture must be inside this checkout")
    return resolved


def require_regular(path: Path) -> Path:
    resolved = contained(path)
    if resolved.is_symlink() or not resolved.is_file():
        raise ValueError("Expected a regular public fixture")
    return resolved


def write_regular(path: Path, wire: bytes) -> None:
    path = contained(path)
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise ValueError("Restore target must be a regular file")
    temporary = path.with_name(path.name + ".fixture-tmp")
    if temporary.is_symlink() or (temporary.exists() and not temporary.is_file()):
        raise ValueError("Temporary restore target must be a regular file")
    try:
        temporary.write_bytes(wire)
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def pack(path: Path) -> dict:
    path = require_regular(path)
    wire = path.read_bytes()
    if len(wire) > MAXIMUM:
        raise ValueError("Fixture exceeds size limit")
    target = path.with_name(path.name + ".gz")
    encoded = gzip.compress(wire, mtime=0)
    if target.is_symlink():
        raise ValueError("Symlink target rejected")
    target.write_bytes(encoded)
    if unpack(target) != wire:
        raise ValueError("Fixture roundtrip differs")
    return {"path": str(target.relative_to(ROOT)), "bytes": len(wire),
            "gzip_bytes": len(encoded), "sha256_chunks": checksum(wire)}


def manifest(paths: list[Path]) -> None:
    records = []
    locks = []
    for path in sorted(paths, key=lambda item: str(item)):
        path = require_regular(path)
        if path.suffix != ".gz":
            raise ValueError("Expected a gzip fixture")
        wire = unpack(path)
        record = {"path": str(path.relative_to(ROOT)), "bytes": len(wire),
                  "gzip_bytes": path.stat().st_size, "sha256_chunks": checksum(wire)}
        records.append(record)
        if path.name == "Cargo.lock.gz":
            target = path.with_suffix("")
            locks.append({"path": record["path"], "restore": str(target.relative_to(ROOT)),
                          "bytes": record["bytes"], "sha256_chunks": record["sha256_chunks"]})
    write_regular(ARTIFACT_MANIFEST, (json.dumps({"encoding": "gzip", "files": records}, indent=2) + "\n").encode())
    write_regular(LOCK_MANIFEST, (json.dumps({"schema": 1, "files": locks}, indent=2) + "\n").encode())
    print(json.dumps({"fixtures": len(records), "locks": len(locks),
                      "artifact_manifest": str(ARTIFACT_MANIFEST.relative_to(ROOT)),
                      "lock_manifest": str(LOCK_MANIFEST.relative_to(ROOT))}, separators=(",", ":")))


def restore_locks() -> None:
    require_regular(LOCK_MANIFEST)
    document = json.loads(LOCK_MANIFEST.read_text())
    if document.get("schema") != 1 or not isinstance(document.get("files"), list):
        raise ValueError("Invalid lock manifest")
    for record in document["files"]:
        source = require_regular(ROOT / record["path"])
        wire = unpack(source)
        if len(wire) != record["bytes"] or checksum(wire) != record["sha256_chunks"]:
            raise ValueError("Lock artifact digest mismatch")
        target = contained(ROOT / record["restore"])
        write_regular(target, wire)
        print(json.dumps({"path": str(target.relative_to(ROOT)), "bytes": len(wire),
                          "sha256_chunks": checksum(wire)}, separators=(",", ":")))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["pack", "unpack", "manifest", "restore-locks"])
    parser.add_argument("paths", nargs="*")
    args = parser.parse_args()
    paths = [Path(p).resolve() for p in args.paths]
    if args.operation == "restore-locks":
        if paths:
            parser.error("restore-locks takes no paths")
        restore_locks()
        return
    if not paths:
        parser.error("No fixtures selected")
    for path in paths:
        path = contained(path)
        if args.operation == "pack":
            print(json.dumps(pack(path), separators=(",", ":")))
        elif args.operation == "manifest":
            continue
        else:
            path = require_regular(path)
            if path.suffix != ".gz":
                raise ValueError("Expected a gzip fixture")
            wire = unpack(path)
            target = path.with_suffix("")
            write_regular(target, wire)
            print(json.dumps({"path": str(target.relative_to(ROOT)),
                              "bytes": len(wire), "sha256_chunks": checksum(wire)}))
    if args.operation == "manifest":
        manifest(paths)


if __name__ == "__main__":
    main()
