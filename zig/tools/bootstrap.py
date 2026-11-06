#!/usr/bin/env python3
"""Fetch and checksum-verify the pinned official Zig release for this host."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import platform
import tarfile
import tempfile
import urllib.request

VERSION = "0.15.2"


def fetch(url):
    with urllib.request.urlopen(url, timeout=60) as response:
        data = response.read(128 * 1024 * 1024 + 1)
    if len(data) > 128 * 1024 * 1024:
        raise RuntimeError("Zig release exceeds download limit")
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, default=Path(__file__).resolve().parents[1] / ".toolchain")
    options = parser.parse_args()
    architecture = {"arm64": "aarch64", "aarch64": "aarch64", "x86_64": "x86_64", "AMD64": "x86_64"}.get(platform.machine())
    system = {"Darwin": "macos", "Linux": "linux"}.get(platform.system())
    if architecture is None or system is None:
        parser.error("this bootstrap supports aarch64/x86_64 macOS and Linux")
    name = f"zig-{architecture}-{system}-{VERSION}"
    destination = options.cache_dir.resolve() / name
    compiler = destination / "zig"
    if compiler.is_file():
        print(compiler)
        return
    index = json.loads(fetch("https://ziglang.org/download/index.json"))
    release = index[VERSION][f"{architecture}-{system}"]
    expected_url = f"https://ziglang.org/download/{VERSION}/{name}.tar.xz"
    if release["tarball"] != expected_url:
        raise RuntimeError("unexpected official Zig release URL")
    data = fetch(expected_url)
    if len(data) != int(release["size"]) or hashlib.sha256(data).hexdigest() != release["shasum"]:
        raise RuntimeError("official Zig release checksum mismatch")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="zig-release-", dir=destination.parent) as temporary:
        archive = Path(temporary) / "zig.tar.xz"
        archive.write_bytes(data)
        with tarfile.open(archive, "r:xz") as package:
            package.extractall(temporary, filter="data")
        extracted = Path(temporary) / name
        if not (extracted / "zig").is_file():
            raise RuntimeError("Zig archive omitted its compiler")
        try:
            extracted.rename(destination)
        except FileExistsError:
            if not compiler.is_file():
                raise
    print(compiler)


if __name__ == "__main__":
    main()
