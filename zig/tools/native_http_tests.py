#!/usr/bin/env python3
"""Run the real native HTTP/gRPC fixtures against loopback services only."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import platform
import selectors
import subprocess
import sys
import tempfile


def startup_error(server: subprocess.Popen[str], message: str) -> RuntimeError:
    # Never block on a live/inherited stderr pipe or retain unbounded output.
    detail = ""
    if server.stderr is not None:
        fd = server.stderr.fileno()
        os.set_blocking(fd, False)
        try:
            detail = os.read(fd, 8192).decode("utf-8", errors="replace").strip()
        except BlockingIOError:
            pass
    return RuntimeError(message + ("\nFixture stderr (at most8192bytes):\n" + detail if detail else ""))


def main():
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--library", default="/usr/lib/libcurl.4.dylib" if platform.system() == "Darwin" else "libcurl.so.4")
    parser.add_argument("--mode", default="ReleaseSafe", choices=["Debug", "ReleaseSafe", "ReleaseFast"])
    parser.add_argument("--libcrypto", default="/opt/homebrew/opt/openssl@3/lib/libcrypto.3.dylib" if platform.system() == "Darwin" else "libcrypto.so.3")
    parser.add_argument("--timeout-seconds", type=int, default=300)
    parser.add_argument("command", nargs=argparse.REMAINDER, help="Optional test command after --; default runs the standard Zig test suite")
    options = parser.parse_args()
    if options.timeout_seconds < 1 or options.timeout_seconds > 7200:
        parser.error("--timeout-seconds must be between1 and7200")
    server = subprocess.Popen(["node", str(root / "zig/src/cosmos/testing/grpc-server.mjs")], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        selector = selectors.DefaultSelector()
        selector.register(server.stdout, selectors.EVENT_READ)
        try:
            if not selector.select(timeout=10):
                raise startup_error(server, "HTTP/2 fixture startup deadline exceeded")
            line = server.stdout.readline()
        finally:
            selector.close()
        if not line:
            raise startup_error(server, "HTTP/2 fixture exited during startup")
        port = int(json.loads(line)["port"])
        if port < 1 or port > 65535:
            raise RuntimeError("invalid fixture port")
        env = os.environ.copy()
        env["HYPERLANE_COSMOS_GRPC_TEST_URL"] = f"http://127.0.0.1:{port}/prefix?fixture=1"
        env["HYPERLANE_CURL_LIBRARY"] = options.library
        env["HYPERLANE_CLOUD_CURL_LIBRARY"] = options.library
        with tempfile.TemporaryDirectory(prefix="ziggy-rsa-fixture-") as fixture:
            subprocess.run(["node", str(root / "zig/src/cloud/testing/generate-rsa.mjs"), fixture], check=True, timeout=30, capture_output=True)
            env["HYPERLANE_TEST_RSA_FIXTURE_DIR"] = fixture
            env["HYPERLANE_LIBCRYPTO_LIBRARY"] = options.libcrypto
            command = options.command[1:] if options.command[:1] == ["--"] else options.command
            if not command:
                command = [sys.executable, str(root / "zig/tools/zig.py"), "build", "test", f"-Doptimize={options.mode}", "--summary", "all"]
            return subprocess.run(command, cwd=root, env=env, timeout=options.timeout_seconds).returncode
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait(timeout=5)
        if server.stdout:
            server.stdout.close()
        if server.stderr:
            server.stderr.close()


if __name__ == "__main__":
    raise SystemExit(main())
