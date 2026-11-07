#!/usr/bin/env python3
"""Create an isolated, checksum-pinned HPACK environment for native E2E taps.

No pip, package hooks, agent runtime changes or node execution. The output
descriptor must still be bound by a separately reviewed execution manifest.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import zipfile

VERSION = "4.2.0"
WHEEL_NAME = "hpack-4.2.0-py3-none-any.whl"
WHEEL_SHA256 = "858ac0b02280fa582b5080d68db0899c62" + "a80375e0e5413a74970c5e518b6986"
WHEEL_BYTES = 34246
MINIMUM_FREE = 6 * 1024 ** 3
MAX_ENVIRONMENT = 64 * 1024 ** 2
PACKAGE_FILES = {"__init__.py", "exceptions.py", "hpack.py", "huffman.py", "huffman_constants.py", "huffman_table.py", "py.typed", "struct.py", "table.py"}
METADATA_FILES = {"METADATA", "RECORD", "WHEEL", "licenses/LICENSE", "top_level.txt"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def artifact(path):
    require(path.is_file() and not path.is_symlink(), "expected regular artifact")
    raw = path.read_bytes()
    return {"path": str(path), "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}


def checked_wheel(raw):
    require(len(raw) == WHEEL_BYTES and hashlib.sha256(raw).hexdigest() == WHEEL_SHA256, "HPACK wheel size/checksum mismatch")
    return wheel_members(raw)


def wheel_members(raw):
    """Validate the complete tiny pure-Python distribution before extraction."""
    expected = {"hpack/" + name for name in PACKAGE_FILES} | {"hpack-4.2.0.dist-info/" + name for name in METADATA_FILES}
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        rows = archive.infolist()
        names = [row.filename for row in rows]
        require(len(names) == len(set(names)) and set(names) == expected, "unexpected wheel file closure")
        require(sum(row.file_size for row in rows) <= 1024 * 1024, "wheel expanded size bound")
        output = {}
        for row in rows:
            relative = PurePosixPath(row.filename)
            require(not relative.is_absolute() and ".." not in relative.parts and not stat.S_ISLNK(row.external_attr >> 16) and not row.is_dir(), "unsafe wheel member")
            require(row.file_size <= 256 * 1024 and not row.flag_bits & 1, "oversized/encrypted wheel member")
            output[row.filename] = archive.read(row)
    return output


def download():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def fetch(url, host, limit):
        initial = urllib.parse.urlsplit(url)
        require(initial.scheme == "https" and initial.hostname == host and not initial.username, "unexpected download URL")
        with opener.open(url, timeout=30) as response:
            final = urllib.parse.urlsplit(response.geturl())
            require(final.scheme == "https" and final.hostname == host, "unexpected download redirect")
            raw = response.read(limit + 1)
        require(len(raw) <= limit, "download size limit exceeded")
        return raw

    metadata = fetch(f"https://pypi.org/pypi/hpack/{VERSION}/json", "pypi.org", 1024 * 1024)
    info = json.loads(metadata)
    require(info["info"]["version"] == VERSION and not info.get("vulnerabilities") and not info["info"].get("requires_dist"), "HPACK version/dependency/security metadata changed")
    wheels = [row for row in info["urls"] if row["filename"] == WHEEL_NAME]
    require(len(wheels) == 1, "official pinned wheel missing/ambiguous")
    wheel = wheels[0]
    require(wheel["digests"]["sha256"] == WHEEL_SHA256 and wheel["size"] == WHEEL_BYTES and not wheel["yanked"], "official pinned wheel metadata changed")
    return fetch(wheel["url"], "files.pythonhosted.org", WHEEL_BYTES), metadata


def prepare(destination, raw, metadata=None):
    members = checked_wheel(raw)  # Validate before any filesystem mutation.
    destination = destination.absolute()
    require(not destination.exists() and not destination.is_symlink(), "destination must not exist")
    require(destination.parent.is_dir(), "destination parent must exist")
    destination = destination.parent.resolve() / destination.name
    require(shutil.disk_usage(destination.parent).free >= MINIMUM_FREE, "less than6GiB free")
    destination.mkdir(mode=0o700)
    evidence, environment = destination / "evidence", destination / "python"
    evidence.mkdir(mode=0o700)
    wheel = evidence / WHEEL_NAME
    wheel.write_bytes(raw)
    env = {key: os.environ[key] for key in ("PATH", "HOME", "TMPDIR", "LANG", "SYSTEMROOT") if key in os.environ}
    env["PYTHONNOUSERSITE"] = "1"
    command = [sys.executable, "-I", "-m", "venv", "--copies", "--without-pip", str(environment)]
    started = time.monotonic()
    subprocess.run(command, env=env, check=True, timeout=60)
    python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python3")
    require(python.is_file() and not python.is_symlink(), "venv interpreter must be copied")
    site = Path(subprocess.check_output([python, "-B", "-c", 'import sysconfig;print(sysconfig.get_path("purelib"))'], env=env, text=True, timeout=30).strip())
    require(site.resolve().is_relative_to(environment) and not list(site.iterdir()), "venv package directory must be isolated and empty")
    for name, content in members.items():
        path = site / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    code = 'import hpack,sys,json;print(json.dumps({"version":hpack.__version__,"no_user_site":sys.flags.no_user_site,"prefix":sys.prefix,"module":hpack.__file__}))'
    readback = json.loads(subprocess.check_output([python, "-B", "-c", code], env=env, text=True, timeout=30))
    require(readback["version"] == VERSION and readback["no_user_site"] == 1 and Path(readback["prefix"]) == environment, "HPACK isolated import readback failed")
    allocated = sum(path.stat().st_size for path in destination.rglob("*") if path.is_file())
    require(allocated <= MAX_ENVIRONMENT and shutil.disk_usage(destination).free >= MINIMUM_FREE, "dependency budget exceeded")
    result = {"accepted_test_dependency_setup": True, "scope": "passive HTTP2 correctness observer dependency only; no node/SDK/agent/benchmark acceptance", "interpreter": artifact(python), "version": VERSION, "wheel": artifact(wheel), "package_root": str(site / "hpack"), "site_packages": str(site), "files": [artifact(site / name) for name in sorted(members)], "venv_configuration": artifact(environment / "pyvenv.cfg"), "copied_interpreter": True, "pip_or_global_package_install_used": False, "no_extra_dependencies_or_package_hooks": True, "setup_command": command, "import_readback": readback, "native_agent_runtime_or_chain_actions": False, "environment_file_bytes": allocated, "elapsed_setup_seconds": time.monotonic() - started, "host_free_after": shutil.disk_usage(destination).free, "required_verifier_environment": {"PYTHONNOUSERSITE": "1"}, "forbidden_verifier_environment": ["PYTHONPATH", "PYTHONHOME"]}
    metadata_path = evidence / "source-metadata.json"
    if metadata is None:
        metadata = (json.dumps({"mode": "offline checksum-pinned wheel input", "version": VERSION, "wheel_sha256": WHEEL_SHA256, "official_source": f"https://pypi.org/project/hpack/{VERSION}/", "live_package_index_checked": False}, indent=2) + "\n").encode()
    metadata_path.write_bytes(metadata)
    result["source_metadata"] = artifact(metadata_path)
    descriptor = evidence / "descriptor.json"
    descriptor.write_text(json.dumps(result, indent=2) + "\n")
    return descriptor


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--destination", type=Path, required=True, help="new task-owned directory; existing paths refused")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--wheel", type=Path, help="use an existing pinned wheel, with no network")
    source.add_argument("--download", action="store_true", help="fetch the pinned wheel from official PyPI")
    args = parser.parse_args()
    if args.download:
        raw, metadata = download()
    else:
        require(args.wheel.is_file() and not args.wheel.is_symlink() and args.wheel.stat().st_size == WHEEL_BYTES, "expected regular pinned wheel")
        raw, metadata = args.wheel.read_bytes(), None
    print(prepare(args.destination, raw, metadata))


if __name__ == "__main__":
    main()
