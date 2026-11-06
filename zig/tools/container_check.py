#!/usr/bin/env python3
"""Verify the alpha Zig-agent image; optional smoke uses disposable local services."""
from __future__ import annotations

import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
ROLES = ("relayer", "validator", "scraper")
POSTGRES_PIN = "postgres:16.15@sha256:" + "933463a6c8eba2b9f5cd414138738cd8" + "d5519cd2c471214c222652f547a66a32"
PROBE = r'''#include <curl/curl.h>
#include <openssl/crypto.h>
#include <openssl/opensslv.h>
#include <libpq-fe.h>
#include <stdio.h>
int main(void) {
  const curl_version_info_data *v = curl_version_info(CURLVERSION_NOW);
  if (!v) return 1;
  printf("{\"curl_version\":\"%s\",\"curl_http2\":%d,\"curl_async_dns\":%d,\"openssl\":\"%s\",\"libpq_version\":%d}\n", v->version,
    !!(v->features & CURL_VERSION_HTTP2), !!(v->features & CURL_VERSION_ASYNCHDNS),
    OpenSSL_version(OPENSSL_VERSION), PQlibVersion());
  return 0;
}
'''


def chunks(value: str) -> list[str]:
    return [value[i:i + 32] for i in range(0, len(value), 32)]


def command(args: list[str], *, env: dict | None = None, timeout: int = 60) -> subprocess.CompletedProcess:
    return subprocess.run([str(arg) for arg in args], cwd=ROOT, env=env, text=True,
                          capture_output=True, timeout=timeout)


def checked(args: list[str], *, env: dict | None = None, timeout: int = 60) -> subprocess.CompletedProcess:
    result = command(args, env=env, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f"command failed ({result.returncode}): {args[0]}")
    return result


def write(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n")


def static_check(output: Path | None) -> dict:
    dockerfile = (ROOT / "zig/Dockerfile").read_text()
    ignored = (ROOT / "zig/Dockerfile.dockerignore").read_text()
    workflow = (ROOT / ".github/workflows/zig-agents.yml").read_text()
    required = {
        "rust_image": "ARG RUST_BUILDER_IMAGE=docker.io/library/rust:1.98.0-bookworm",
        "rust_digest_a": "ARG RUST_BUILDER_DIGEST_A=82150a52ec202c1b14d7817e14516c39",
        "rust_digest_b": "ARG RUST_BUILDER_DIGEST_B=2bb7f5cfebd88f1ed531cb37ebd39922",
        "rust_from": "FROM ${RUST_BUILDER_IMAGE}@sha256:${RUST_BUILDER_DIGEST_A}${RUST_BUILDER_DIGEST_B} AS build-base",
        "debian_image": "ARG DEBIAN_RUNTIME_IMAGE=docker.io/library/debian:bookworm-slim",
        "debian_digest_a": "ARG DEBIAN_RUNTIME_DIGEST_A=734a72b3d6142a71993b4bc580ca01d8",
        "debian_digest_b": "ARG DEBIAN_RUNTIME_DIGEST_B=ca687f77a2c422d96a961d3376b179bc",
        "debian_from": "FROM ${DEBIAN_RUNTIME_IMAGE}@sha256:${DEBIAN_RUNTIME_DIGEST_A}${DEBIAN_RUNTIME_DIGEST_B} AS runtime-base",
        "python_image": "ARG PYTHON_BUILDER_IMAGE=docker.io/library/python:3.12-bookworm",
        "python_digest_a": "ARG PYTHON_BUILDER_DIGEST_A=1bc6cb484acf8d7b0393d547ab55c3f1",
        "python_digest_b": "ARG PYTHON_BUILDER_DIGEST_B=47d641bef8adafbf7dfec5ba4d2d99e0",
        "python_from": "FROM ${PYTHON_BUILDER_IMAGE}@sha256:${PYTHON_BUILDER_DIGEST_A}${PYTHON_BUILDER_DIGEST_B} AS python312",
        "curl_version": "ARG CURL_DEBIAN_VERSION=8.14.1-2+deb13u2~bpo13+1",
        "core_target": "AS runtime-core",
        "default_core": "FROM runtime-core AS runtime",
        "starknet_target": "AS runtime-starknet",
        "aleo_target": "AS runtime-aleo",
        "nonroot": "USER 10001:10001",
        "curl_default": "HYPERLANE_CURL_LIBRARY=libcurl.so.4",
        "crypto_default": "HYPERLANE_LIBCRYPTO_LIBRARY=libcrypto.so.3",
        "regex_default": "HYPERLANE_REGEX_LIBRARY=/opt/hyperlane/lib/libziggy_regex.so",
        "migration_fixture": "FROM runtime-base AS migration-image",
    }
    for name, text in required.items():
        if text not in dockerfile:
            raise AssertionError(f"Dockerfile missing {name}")
    if re.search(r"(?m)^\s*curl\s*$", dockerfile):
        raise AssertionError("deprecated curl CLI must not be installed")
    if "HYPERLANE_ALEO_PARAMETER_HOME=" in dockerfile:
        raise AssertionError("image must not claim an ambient Aleo parameter bundle")
    for required_line in ("!rust/main/Cargo.toml", "!rust/main/Cargo.lock", "**/target/", "**/.env"):
        if required_line not in ignored:
            raise AssertionError(f"Docker ignore missing {required_line}")
    for action in re.findall(r"uses:\s*([^\s]+)", workflow):
        if action.startswith("./"):
            continue
        if not re.search(r"@[0-9a-f]{40}$", action):
            raise AssertionError(f"workflow action is not immutable: {action}")
    for digest_line in ("POSTGRES_DIGEST_A: 933463a6c8eba2b9f5cd414138738cd8", "POSTGRES_DIGEST_B: d5519cd2c471214c222652f547a66a32"):
        if digest_line not in workflow:
            raise AssertionError("workflow PostgreSQL digest chunk missing")
    if "${{ env.POSTGRES_DIGEST_" in workflow:
        raise AssertionError("workflow env context illegally references the same env mapping")
    if 'POSTGRES_IMAGE="postgres:16.15@sha256:${POSTGRES_DIGEST_A}${POSTGRES_DIGEST_B}"' not in workflow:
        raise AssertionError("workflow PostgreSQL pin is not composed in the consuming run step")
    if not re.search(r"name:\s*zig-native-linux\s*\n\s*path:\s*zig\s*(?:\n|$)", workflow):
        raise AssertionError("native artifact must restore its common zig directory prefix")
    if re.search(r"zig\.py test[^\n]*--summary", workflow):
        raise AssertionError("--summary is a build-runner option, not a direct zig test option")
    if "python3 zig/integration/relayer_process.py --compile-only" not in workflow:
        raise AssertionError("Bridge Solidity fixtures must be compiled before execution")
    if 'cd "$GITHUB_WORKSPACE"\n          ./zig/bench/results/native-linux/relayer_bridge_tests' not in workflow:
        raise AssertionError("Bridge executable must run from repository root for contracts.json resolution")
    entrypoint = ROOT / "zig/entrypoint.sh"
    if not os.access(entrypoint, os.X_OK):
        raise AssertionError("entrypoint is not executable")
    checked(["sh", "-n", entrypoint])
    checked(["python3", "-c", "from pathlib import Path; compile(Path('zig/tools/container_check.py').read_text(), 'container_check.py', 'exec')"])
    result = {"passed": True, "scope": "static packaging and immutable action checks",
              "roles": list(ROLES), "runtime_variants": ["core", "starknet", "aleo", "full-sdk"],
              "aleo_parameters_baked": False, "root_dockerignore_changed": False}
    if output:
        write(output, result)
    return result


def image_json(image: str, entrypoint: str, args: list[str] | None = None) -> str:
    return checked(["docker", "run", "--rm", "--entrypoint", entrypoint, image, *(args or [])]).stdout


def runtime_check(image: str, output: Path, smoke: bool, migration_image: str | None,
                  postgres_image: str) -> dict:
    inspect = json.loads(checked(["docker", "image", "inspect", image]).stdout)[0]
    config = inspect["Config"]
    if config.get("User") != "10001:10001":
        raise AssertionError("runtime user is not the pinned nonroot identity")
    help_results = {}
    for role in ROLES:
        result = checked(["docker", "run", "--rm", image, role, "--help"])
        if f"Hyperlane {role} (Zig, experimental)" not in result.stdout:
            raise AssertionError(f"wrong {role} help")
        help_results[role] = True
    default_help = checked(["docker", "run", "--rm", image, "--help"]).stdout
    if "Hyperlane relayer (Zig, experimental)" not in default_help:
        raise AssertionError("default role is not relayer")
    invalid = command(["docker", "run", "--rm", "-e", "HYPERLANE_AGENT_ROLE=not-a-role", image, "--help"])
    if invalid.returncode != 64:
        raise AssertionError("invalid role was not rejected")
    capabilities = json.loads(image_json(image, "/opt/hyperlane/libexec/native-runtime-probe"))
    if not capabilities["curl_http2"] or not capabilities["curl_async_dns"]:
        raise AssertionError("libcurl lacks HTTP/2 or async DNS")
    if tuple(map(int, capabilities["curl_version"].split("."))) < (8, 0, 0):
        raise AssertionError("libcurl predates the HTTP/2 prior-knowledge connection-reuse fix")
    if not capabilities["openssl"].startswith("OpenSSL 3.") or capabilities["libpq_version"] <= 0:
        raise AssertionError("unexpected OpenSSL/libpq runtime")
    manifest = json.loads(image_json(image, "/bin/cat", ["/opt/hyperlane/share/native/manifest.json"]))
    if len(manifest["archives"]) != 7 or manifest["native_runtime_probe"]["rocksdb"] != "10.4.2":
        raise AssertionError("native archive bundle or RocksDB ABI mismatch")
    boundary = manifest["dependency_boundary"]
    if boundary["rust_runtime_linked"] or boundary["rust_agent_logic_linked"]:
        raise AssertionError("Rust agents/runtime leaked into the image")
    libraries = image_json(image, "/sbin/ldconfig", ["-p"])
    for soname in ("libcurl.so.4", "libcrypto.so.3", "libpq.so.5"):
        if soname not in libraries:
            raise AssertionError(f"missing runtime SONAME {soname}")
    executable_paths = [f"/opt/hyperlane/bin/{role}" for role in ROLES]
    environment = dict(item.split("=", 1) for item in config.get("Env", []) if "=" in item)
    if "HYPERLANE_REGEX_LIBRARY" not in environment:
        raise AssertionError("pinned Rust regex engine is not configured")
    for variable in ("HYPERLANE_REGEX_LIBRARY", "HYPERLANE_STARKNET_CRYPTO_LIBRARY", "HYPERLANE_ALEO_CRYPTO_LIBRARY",
                     "HYPERLANE_ALEO_VM_LIBRARY", "HYPERLANE_ALEO_VM_WORKER"):
        if variable in environment:
            executable_paths.append(environment[variable])
    links = {}
    for path in executable_paths:
        linked = image_json(image, "/usr/bin/ldd", [path])
        if "not found" in linked:
            raise AssertionError(f"unresolved ELF dependency: {path}")
        links[path] = True
    if "libpq.so.5" not in image_json(image, "/usr/bin/ldd", ["/opt/hyperlane/bin/scraper"]):
        raise AssertionError("scraper is not linked to libpq")
    image_json(image, "/usr/bin/test", ["!", "-x", "/usr/bin/curl"])
    result = {
        "passed": True, "scope": "actual Linux image help, ELF, native ABI and nonroot checks",
        "image_id_chunks": chunks(inspect["Id"].removeprefix("sha256:")),
        "image_size_bytes": inspect["Size"],
        "architecture": inspect["Architecture"], "user": config["User"], "help": help_results,
        "default_role": "relayer", "invalid_role_exit": invalid.returncode,
        "regex_library": environment["HYPERLANE_REGEX_LIBRARY"],
        "native_capabilities": capabilities, "rocksdb": manifest["native_runtime_probe"],
        "archive_count": len(manifest["archives"]),
        "rust_build_source_package_count": boundary["rust_build_source_package_count"],
        "rust_runtime_linked": boundary["rust_runtime_linked"],
        "rust_agent_logic_linked": boundary["rust_agent_logic_linked"],
        "elf_dependencies_resolved": links, "curl_cli_present": False,
        "aleo_parameter_home_configured": "HYPERLANE_ALEO_PARAMETER_HOME" in environment,
        "smoke": None,
    }
    if smoke:
        if not migration_image:
            raise ValueError("--smoke requires --migration-image")
        try:
            result["smoke"] = smoke_test(image, migration_image, postgres_image, output.parent / "logs")
        except BaseException:
            result["passed"] = False
            write(output, result)
            raise
    write(output, result)
    return result


class RpcFixture(http.server.ThreadingHTTPServer):
    def __init__(self):
        owner = self
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                size = int(self.headers.get("content-length", "0"))
                request = json.loads(self.rfile.read(size))
                body = json.dumps({"jsonrpc": "2.0", "id": request.get("id"),
                    "error": {"code": -32000, "message": "disposable container fixture"}}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            def log_message(self, *_):
                pass
        super().__init__(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=lambda: self.serve_forever(poll_interval=.01), daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server_port}"
    def close(self):
        self.shutdown()
        self.server_close()
        self.thread.join(timeout=3)


def fixture_chain(url: str) -> dict:
    address = "0x" + "00" * 19 + "01"
    return {"name": "containerfixture", "domainId": 3999999999, "chainId": 31337,
        "protocol": "ethereum", "rpcUrls": [{"http": url}], "rpcConsensusType": "single",
        "mailbox": address, "validatorAnnounce": address, "merkleTreeHook": address,
        "interchainGasPaymaster": address, "blocks": {"reorgPeriod": 0},
        "index": {"from": 0, "chunk": 50, "interval": 60}}


def safe_logs(name: str, destination: Path, forbidden: list[str]) -> None:
    result = command(["docker", "logs", name])
    combined = result.stdout + result.stderr
    if any(value in combined for value in forbidden) or "PRIVATE KEY" in combined:
        raise AssertionError("container logs contain fixture URL/credential material")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(combined)


def run_role(image: str, role: str, config: Path, data: Path, log_dir: Path,
             forbidden: list[str], attempt: int) -> dict:
    name = f"ziggy-image-{role}-{os.getpid()}-{attempt}"
    args = ["docker", "run", "--detach", "--name", name, "--network", "host",
        "-e", "HYPERLANE_ZIG_DEFAULTS=/config", "-e", "HYPERLANE_CURL_LIBRARY=libcurl.so.4",
        "-e", "HYPERLANE_LIBCRYPTO_LIBRARY=libcrypto.so.3",
        "--mount", f"type=bind,src={config},dst=/config,readonly",
        "--mount", f"type=bind,src={data},dst=/data", image, role]
    checked(args)
    started = time.monotonic()
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            state = json.loads(checked(["docker", "inspect", name]).stdout)[0]["State"]
            if not state["Running"]:
                raise AssertionError(f"{role} exited before SIGTERM")
            if time.monotonic() - started >= 2:
                break
            time.sleep(.1)
        stop_started = time.monotonic()
        checked(["docker", "stop", "--time", "15", name], timeout=20)
        state = json.loads(checked(["docker", "inspect", name]).stdout)[0]["State"]
        if state["ExitCode"] != 0:
            raise AssertionError(f"{role} SIGTERM exit was {state['ExitCode']}")
        return {"exit_code": 0, "startup_grace_ms": round((stop_started - started) * 1000),
                "drain_ms": round((time.monotonic() - stop_started) * 1000), "reopened": attempt == 1}
    finally:
        try:
            safe_logs(name, log_dir / f"{role}-{attempt}.log", forbidden)
        finally:
            command(["docker", "rm", "--force", "--volumes", name])


def smoke_test(image: str, migration_image: str, postgres_image: str, log_dir: Path, include_roles: bool = True) -> dict:
    rpc = RpcFixture()
    pg_name = f"ziggy-image-pg-{os.getpid()}"
    pg_started = False
    try:
        checked(["docker", "run", "--detach", "--name", pg_name,
            "-e", "POSTGRES_USER=ziggy", "-e", "POSTGRES_DB=ziggy",
            "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-p", "127.0.0.1::5432", postgres_image])
        pg_started = True
        port_text = checked(["docker", "port", pg_name, "5432/tcp"]).stdout.strip()
        host, port = port_text.rsplit(":", 1)
        if host != "127.0.0.1" or not port.isdecimal():
            raise AssertionError("PostgreSQL fixture is not loopback-only")
        deadline = time.monotonic() + 45
        while command(["docker", "exec", pg_name, "pg_isready", "-U", "ziggy", "-d", "ziggy"]).returncode:
            if time.monotonic() >= deadline:
                raise AssertionError("PostgreSQL startup deadline")
            time.sleep(.2)
        database_url = f"postgresql://ziggy@127.0.0.1:{port}/ziggy?sslmode=disable"
        checked(["docker", "run", "--rm", "--network", "host", "--entrypoint", "/opt/hyperlane/libexec/init-db",
            "-e", f"DATABASE_URL={database_url}", migration_image], timeout=120)
        migrations = checked(["docker", "exec", pg_name, "psql", "-U", "ziggy", "-d", "ziggy",
            "-At", "-c", "SELECT count(*) FROM seaql_migrations"]).stdout.strip()
        if migrations != "21":
            raise AssertionError(f"expected 21 production migrations, found {migrations}")
        version = checked(["docker", "exec", pg_name, "postgres", "--version"]).stdout.strip()
        if "16.15" not in version:
            raise AssertionError("wrong PostgreSQL fixture version")
        evidence = {"server": version, "migrations": int(migrations), "roles": {}}
        if not include_roles:
            return evidence
        with tempfile.TemporaryDirectory(prefix="ziggy-container-smoke-") as folder:
            temporary = Path(folder)
            temporary.chmod(0o755)
            for role in ROLES:
                config = temporary / role / "config"
                data = temporary / role / "data"
                config.mkdir(parents=True)
                data.mkdir(mode=0o777)
                data.chmod(0o777)
                chain = fixture_chain(rpc.url)
                if role == "relayer":
                    chain["signer"] = {"type": "hexKey", "key": "0x" + "11" * 32}
                    value = {"relayChains": "containerfixture", "db": "/data/relayer",
                        "allowLocalCheckpointSyncers": True, "gasPaymentEnforcement": [{"type": "none"}],
                        "metricsPort": 0, "chains": {"containerfixture": chain}}
                elif role == "validator":
                    value = {"originChainName": "containerfixture", "db": "/data/validator",
                        "validator": {"key": "0x" + "11" * 32}, "skipAnnounce": True,
                        "checkpointSyncer": {"type": "localStorage", "path": "/data/checkpoints"},
                        "interval": 60, "metricsPort": 0, "chains": {"containerfixture": chain}}
                else:
                    value = {"chainsToScrape": "containerfixture",
                        "db": f"host=127.0.0.1 port={port} dbname=ziggy user=ziggy connect_timeout=5 sslmode=disable",
                        "dbMaxConnections": 1, "dbAcquireTimeoutMillis": 2000,
                        "metricsPort": 0, "chains": {"containerfixture": chain}}
                (config / "fixture.json").write_text(json.dumps(value))
                forbidden = [rpc.url, "postgresql://", "0x" + "11" * 32]
                runs = [run_role(image, role, config, data, log_dir, forbidden, attempt) for attempt in range(2)]
                evidence["roles"][role] = {"runs": runs, "same_db_reopen": True, "logs_checked": True}
        return evidence
    finally:
        rpc.close()
        if pg_started:
            command(["docker", "rm", "--force", "--volumes", pg_name])


def migration_check(migration_image: str, postgres_image: str, output: Path) -> dict:
    result = {"passed": True, "scope": "actual Linux init-db on disposable PostgreSQL16.15"}
    try:
        result["evidence"] = smoke_test("unused", migration_image, postgres_image, output.parent / "logs", False)
    except BaseException:
        result["passed"] = False
        write(output, result)
        raise
    write(output, result)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)
    probe = subcommands.add_parser("write-probe")
    probe.add_argument("--output", type=Path, required=True)
    static = subcommands.add_parser("static")
    static.add_argument("--output", type=Path)
    runtime = subcommands.add_parser("runtime")
    runtime.add_argument("--image", required=True)
    runtime.add_argument("--output", type=Path, required=True)
    runtime.add_argument("--smoke", action="store_true")
    runtime.add_argument("--migration-image")
    runtime.add_argument("--postgres-image", default=POSTGRES_PIN)
    migrations = subcommands.add_parser("migrations")
    migrations.add_argument("--migration-image", required=True)
    migrations.add_argument("--postgres-image", default=POSTGRES_PIN)
    migrations.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "write-probe":
        args.output.write_text(PROBE)
        return 0
    if args.command == "static":
        static_check(args.output)
        return 0
    if args.command == "migrations":
        migration_check(args.migration_image, args.postgres_image, args.output)
        return 0
    runtime_check(args.image, args.output, args.smoke, args.migration_image, args.postgres_image)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
