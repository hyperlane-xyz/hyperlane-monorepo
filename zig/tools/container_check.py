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
import stat
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
        "url_default": "HYPERLANE_URL_LIBRARY=/opt/hyperlane/lib/libziggy_url.so",
        "url_bundle": "COPY --from=native-url /work/zig/src/net/native-url/target/release/libziggy_url.so /opt/hyperlane/lib/libziggy_url.so",
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
                  postgres_image: str, expected_git_sha: str | None = None) -> dict:
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
    if environment.get("HYPERLANE_URL_LIBRARY") != "/opt/hyperlane/lib/libziggy_url.so":
        raise AssertionError("required Rust URL normalizer is not configured")
    for variable in ("HYPERLANE_URL_LIBRARY", "HYPERLANE_REGEX_LIBRARY", "HYPERLANE_STARKNET_CRYPTO_LIBRARY", "HYPERLANE_ALEO_CRYPTO_LIBRARY",
                     "HYPERLANE_ALEO_VM_LIBRARY", "HYPERLANE_ALEO_VM_WORKER"):
        if variable in environment:
            executable_paths.append(environment[variable])
    links = {}
    artifact_sha256 = {}
    for path in executable_paths:
        linked = image_json(image, "/usr/bin/ldd", [path])
        if "not found" in linked:
            raise AssertionError(f"unresolved ELF dependency: {path}")
        links[path] = True
        digest = image_json(image, "/usr/bin/sha256sum", [path]).split()[0]
        if not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise AssertionError("invalid image artifact digest")
        artifact_sha256[Path(path).name] = digest
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
        "url_library": environment["HYPERLANE_URL_LIBRARY"],
        "native_capabilities": capabilities, "rocksdb": manifest["native_runtime_probe"],
        "archive_count": len(manifest["archives"]),
        "rust_build_source_package_count": boundary["rust_build_source_package_count"],
        "rust_runtime_linked": boundary["rust_runtime_linked"],
        "rust_agent_logic_linked": boundary["rust_agent_logic_linked"],
        "artifact_sha256": artifact_sha256,
        "elf_dependencies_resolved": links, "curl_cli_present": False,
        "aleo_parameter_home_configured": "HYPERLANE_ALEO_PARAMETER_HOME" in environment,
        "smoke": None,
    }
    if smoke:
        if not migration_image:
            raise ValueError("--smoke requires --migration-image")
        try:
            result["smoke"] = smoke_test(image, migration_image, postgres_image, output.parent / "logs", expected_git_sha=expected_git_sha)
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


def validate_git_sha(value: str | None) -> str:
    if value is None or (value != "VERGEN_IDEMPOTENT_OUTPUT" and re.fullmatch(r"[0-9a-fA-F]{40}", value) is None):
        raise ValueError("expected Git SHA must be the compiled40hex or explicit Git-less sentinel")
    return value


class MetadataPublicationReplaced(AssertionError):
    """A regular atomic publication replaced the previous inode during copy."""
    def __init__(self, before, after):
        def identity(value):
            return {"device": value.st_dev, "inode": value.st_ino,
                    "bytes": value.st_size, "mtime_ns": value.st_mtime_ns,
                    "nlink": value.st_nlink, "regular": stat.S_ISREG(value.st_mode)}
        self.observation = {"before": identity(before), "after": identity(after)}
        super().__init__("validator metadata atomically replaced during read: " +
                         json.dumps(self.observation, sort_keys=True))


def metadata_snapshot(path: Path, expected_git_sha: str, read_bytes=None) -> dict:
    validate_git_sha(expected_git_sha)
    before = path.lstat()  # Only absence is retryable at the bounded startup caller.
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > 65536:
        raise AssertionError("validator metadata is not a bounded regular publication")
    raw = path.read_bytes() if read_bytes is None else read_bytes()
    if not isinstance(raw, bytes) or len(raw) > 65536:
        raise AssertionError("validator metadata copy exceeds publication bound")
    after = path.lstat()
    if not stat.S_ISREG(after.st_mode) or after.st_nlink != 1 or after.st_size > 65536:
        raise AssertionError("validator metadata is not a bounded regular publication")
    if before.st_dev != after.st_dev:
        raise AssertionError("validator metadata device changed during read")
    if before.st_ino != after.st_ino:
        raise MetadataPublicationReplaced(before, after)
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise AssertionError("validator metadata changed during read")
    def unique_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise AssertionError("duplicate validator metadata field")
            result[key] = value
        return result
    value = json.loads(raw, object_pairs_hook=unique_pairs)
    if not isinstance(value, dict) or set(value) != {"git_sha", "rpcs", "allows_public_rpcs"}:
        raise AssertionError("validator metadata schema differs")
    if value["git_sha"] != expected_git_sha or value["allows_public_rpcs"] is not False:
        raise AssertionError("validator metadata identity/public-RPC flag differs")
    rows = value["rpcs"]
    if not isinstance(rows, list) or len(rows) != 1:
        raise AssertionError("validator metadata must describe the one actual fixture RPC")
    for row in rows:
        if not isinstance(row, dict) or set(row) != {"url_hash", "host_hash"} or any(
            not isinstance(row[key], str) or re.fullmatch(r"0x[0-9a-f]{64}", row[key]) is None
            for key in ("url_hash", "host_hash")
        ):
            raise AssertionError("validator metadata contains malformed/nonhashed RPC identity")
    return {"bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(), "metadata": value}


def copied_metadata_bytes(container: str) -> bytes:
    # Docker copies as the invoking host user. Keep the runtime publication0600
    # and runtime UID10001; do not weaken permissions for a host-side test reader.
    with tempfile.TemporaryDirectory(prefix="ziggy-container-metadata-") as folder:
        target = Path(folder) / "metadata.json"
        checked(["docker", "cp", f"{container}:/data/checkpoints/metadata_latest.json", str(target)], timeout=3)
        value = target.lstat()
        if not stat.S_ISREG(value.st_mode) or value.st_nlink != 1 or value.st_size > 65536:
            raise AssertionError("Docker metadata copy is not a bounded regular file")
        return target.read_bytes()


def remove_fixture_data(image: str, data: Path) -> None:
    # The same runtime identity owns private DB directories. Remove only the
    # three fixed disposable fixture outputs, after both same-DB attempts.
    if data.is_symlink() or not data.is_dir():
        raise AssertionError("fixture data must be a regular owned directory")
    name = f"ziggy-image-cleanup-{os.getpid()}-{time.monotonic_ns()}"
    failure = None
    try:
        checked(["docker", "run", "--name", name, "--network", "none", "--read-only",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--user", "10001:10001", "--mount", f"type=bind,src={data},dst=/fixture",
            "--entrypoint", "/bin/rm", image, "-rf", "--",
            "/fixture/relayer", "/fixture/validator", "/fixture/checkpoints"], timeout=15)
    except BaseException as error:
        failure = error
        raise
    finally:
        try:
            # A timed-out foreground Docker client does not stop its daemon task.
            # Keep the helper named until this targeted removal actually returns.
            checked(["docker", "rm", "--force", "--volumes", name], timeout=10)
        except BaseException as error:
            if failure is None:
                raise
            failure.add_note(f"fixture helper removal failed for {name}: {type(error).__name__}")



def run_role(image: str, role: str, config: Path, data: Path, log_dir: Path,
             forbidden: list[str], attempt: int, expected_git_sha: str | None = None, launch=None) -> dict:
    if role == "validator":
        validate_git_sha(expected_git_sha)
    name = f"ziggy-image-{role}-{os.getpid()}-{attempt}"
    args = ["docker", "run", "--detach", "--name", name, "--network", "host",
        "-e", "HYPERLANE_ZIG_DEFAULTS=/config", "-e", "HYPERLANE_CURL_LIBRARY=libcurl.so.4",
        "-e", "HYPERLANE_LIBCRYPTO_LIBRARY=libcrypto.so.3",
        "--mount", f"type=bind,src={config},dst=/config,readonly",
        "--mount", f"type=bind,src={data},dst=/data", image, role]
    if launch is not None:
        args = launch.docker_args(image, name, config, data)
    if launch is None:
        checked(args)
    started = time.monotonic()
    metadata = None
    replacement_count = 0
    latest_replacement = None
    operation_target = name
    try:
        if launch is not None:
            launch.create(args, name)
            operation_target = launch.active["container_id"]
            launch.start()
        deadline = started + 10
        if launch is not None:
            launch.started(name)
        while time.monotonic() < deadline:
            state = json.loads(checked(["docker", "inspect", operation_target]).stdout)[0]["State"]
            if not state["Running"]:
                raise AssertionError(f"{role} exited before SIGTERM")
            if role == "validator":
                metadata = None
                try:
                    metadata = metadata_snapshot(data / "checkpoints/metadata_latest.json", expected_git_sha,
                        lambda: copied_metadata_bytes(operation_target))
                except MetadataPublicationReplaced as error:
                    # A restart republishes atomically. Retry only this startup
                    # sample, under the original deadline; stopped reads stay hard.
                    replacement_count += 1
                    latest_replacement = error.observation
                except FileNotFoundError:
                    pass
            if time.monotonic() - started >= 2 and (role != "validator" or metadata is not None):
                break
            time.sleep(.1)
        if role == "validator" and metadata is None:
            raise AssertionError("validator metadata startup deadline")
        if time.monotonic() >= deadline:
            raise AssertionError("role startup completed beyond original deadline")
        stop_started = time.monotonic()
        stopped = checked(["docker", "stop", "--time", str(15 if launch is None else launch.grace_seconds), operation_target], timeout=20)
        if launch is not None:
            launch.stopped(stopped.returncode)
        state = json.loads(checked(["docker", "inspect", operation_target]).stdout)[0]["State"]
        if state["ExitCode"] != 0:
            raise AssertionError(f"{role} SIGTERM exit was {state['ExitCode']}")
        if role == "validator":
            stopped_metadata = metadata_snapshot(data / "checkpoints/metadata_latest.json", expected_git_sha,
                lambda: copied_metadata_bytes(operation_target))
            if stopped_metadata["sha256"] != metadata["sha256"]:
                raise AssertionError("validator metadata changed during clean drain")
        return {"exit_code": 0, "startup_grace_ms": round((stop_started - started) * 1000),
                "drain_ms": round((time.monotonic() - stop_started) * 1000), "reopened": attempt == 1,
                "validator_metadata": metadata,
                "metadata_replacement_count": replacement_count,
                "latest_metadata_replacement": latest_replacement}
    except BaseException as error:
        if launch is not None:
            launch.primary_error = error
        raise
    finally:
        try:
            if launch is None:
                safe_logs(name, log_dir / f"{role}-{attempt}.log", forbidden)
            elif launch.active is not None:
                safe_logs(launch.active["container_id"], log_dir / f"{role}-{attempt}.log", forbidden)
        finally:
            if launch is None:
                command(["docker", "rm", "--force", "--volumes", name])
            else:
                launch.finish(name)


def smoke_test(image: str, migration_image: str, postgres_image: str, log_dir: Path, include_roles: bool = True,
               expected_git_sha: str | None = None, role_launch=None) -> dict:
    if include_roles:
        validate_git_sha(expected_git_sha)
    rpc = RpcFixture()
    pg_name = f"ziggy-image-pg-{os.getpid()}"
    pg_started = False
    try:
        pg_args = ["docker", "run", "--detach", "--name", pg_name,
            "-e", "POSTGRES_USER=ziggy", "-e", "POSTGRES_DB=ziggy",
            "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-p", "127.0.0.1::5432", postgres_image]
        if role_launch is None:
            checked(pg_args)
        else:
            role_launch.start_postgres(pg_args, pg_name)
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
                launch = None
                try:
                    launch = role_launch(role, config, data, value) if role_launch is not None else None
                    if launch is None:
                        runs = [run_role(image, role, config, data, log_dir, forbidden, attempt, expected_git_sha) for attempt in range(2)]
                    else:
                        runs = [run_role(image, role, config, data, log_dir, forbidden, attempt, expected_git_sha, launch=launch) for attempt in range(2)]
                    if role == "validator" and runs[0]["validator_metadata"]["sha256"] != runs[1]["validator_metadata"]["sha256"]:
                        raise AssertionError("same-DB validator metadata bytes changed after restart")
                    evidence["roles"][role] = {"runs": runs, "same_db_reopen": True, "logs_checked": True}
                finally:
                    try:
                        if role_launch is None:
                            remove_fixture_data(image, data)
                        else:
                            role_launch.clean_data(role, data, launch)
                    finally:
                        if launch is not None:
                            launch.retire()
        return evidence
    finally:
        if role_launch is None:
            rpc.close()
            if pg_started:
                command(["docker", "rm", "--force", "--volumes", pg_name])
        else:
            try:
                rpc.close()
            finally:
                if pg_started:
                    role_launch.finish_postgres(pg_name)


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


NATIVE_SKIP_REASONS = {
    "lander.anvil_tests.test.local Anvil Multicall3 returns positional allowFailure results": "Anvil is not installed in this fixture image; separate pinned Anvil gate required",
    "evm_prepare_delegated_tests.test.opt-in loopback prepares actual repo Solidity without delivery or nonce mutation": "Separate explicit Solidity/Anvil preparation fixture",
    "agents.indexing.tx_id_native_test.test.transaction-ID restart rescans durable canonical dispatch and immutable Source Rust oracle decodes repaired rows": "Existing test pins a macOS oracle executable hash; portable Source-bound oracle control still required",
}
NATIVE_REQUIRED = (
    'committed configs select Ethereum relayer without reading process environment',
    'all committed chain settings and validator scraper roles parse with explicit sources',
    '15 production Rust config source differential fixtures',
    'role selection deduplicates and numeric parser rejects Rust-invalid underscore and hex strings',
    '62 actual production Rust role parser differential fixtures',
    "malformed older receipt cannot win included replacement",
    "malformed older receipt cannot win finalized replacement",
    "paged malformed older receipt cannot win included replacement after restart",
    "paged malformed older receipt cannot win finalized replacement after restart",
    "optional CCS actual Factory every allocation failure propagates and cleans optional identity",
    "validator metadata full pretty schema matches actual immutable Rust producer including private RPC identities",
    "configured RPC production-default Tron HTTP reaches native transport while cloud remains strict",
    "Starknet missing chain ID uses configured fallback and keeps discovery controls",
    "scraper Sealevel advanced metadata retains authenticated nonzero event sequences at the resolved transaction",
    "configured Cosmos transaction absence reaches typed client through real Resources Pool",
    "configured SVM unavailable slot permits actual sparse scraper range progress after retries",
    "announcement replay one Registry serializes concurrent ensure callbacks through actual Factory Resources",
    "fresh gas subscription explicitly replays zero before nonzero history and durable resume",
    "fresh gas bootstrap keeps skipped history and unsupported v2 fail closed",
    "Aleo actual isolated native worker authorizes fees and exports source proving wire through pipes",
    "Aleo actual isolated local proof is bound to exact authorized execution and fee",
    "Aleo actual proof worker OS sandbox forbids loopback network connections",
)


def native_test_results(text: str) -> dict:
    rows = []
    pending = None
    for line in text.splitlines():
        match = re.match(r"^(\d+)/(\d+) (.*?)\.\.\.(.*)$", line)
        if match:
            if pending is not None:
                raise AssertionError("native test missing final status")
            pending = {"ordinal": int(match[1]), "total": int(match[2]), "name": match[3]}
            tail = match[4]
        else:
            tail = line
        if pending is not None:
            status = next((item for item in ("OK", "SKIP", "FAIL")
                           if re.search(r"(?:^|\s)" + item + r"(?:\b|$)", tail)), None)
            if status is not None:
                pending["status"] = status
                rows.append(pending)
                pending = None
    if pending is not None or not rows:
        raise AssertionError("native test output incomplete")
    total = rows[-1]["total"]
    if len(rows) != total or [row["ordinal"] for row in rows] != list(range(1, total + 1)) or any(row["total"] != total for row in rows):
        raise AssertionError("native test ordinals/count changed or incomplete")
    if any(row["status"] == "FAIL" for row in rows):
        raise AssertionError("native test failed")
    skipped = [row["name"] for row in rows if row["status"] == "SKIP"]
    if any(name not in NATIVE_SKIP_REASONS for name in skipped):
        raise AssertionError("unreviewed native fixture/library skip")
    for name in NATIVE_REQUIRED:
        if not any(row["name"].endswith(name) and row["status"] == "OK" for row in rows):
            raise AssertionError("required SDK/production regression absent: " + name)
    return {"per_test": rows, "total": total,
            "skipped": {name: NATIVE_SKIP_REASONS[name] for name in skipped}}


def native_suite_command(mode: str, jobs: int, libraries: list[str], root: Path, machine: str) -> list[str]:
    """Use the compiler already verified/installed while building this fixture."""
    if mode not in ("ReleaseSafe", "ReleaseFast") or jobs not in range(1, 5) or machine not in {"x86_64", "aarch64"}:
        raise ValueError("invalid native fixture mode/jobs/platform")
    compiler = root / "zig/.toolchain" / ("zig-" + machine + "-linux-0.15.2") / "zig"
    if compiler.is_symlink() or not compiler.is_file() or not os.access(compiler, os.X_OK):
        raise ValueError("existing pinned fixture compiler required; no bootstrap/download")
    return ["python3", "zig/tools/native_http_tests.py", "--timeout-seconds", "7200", "--",
            "python3", "zig/tools/zig.py", "--compiler", str(compiler), "test", "src/db_tests.zig", "-O", mode,
            "-j" + str(jobs), "-lc", "-lstdc++", *libraries]


def native_suite(mode: str, jobs: int, output: Path) -> None:
    if mode not in ("ReleaseSafe", "ReleaseFast") or jobs not in range(1, 5):
        raise ValueError("invalid native fixture mode/jobs")
    if os.environ.get("ZIG_NATIVE_TEST_MODE") != mode:
        raise AssertionError("test mode differs from actual worker/roles build mode")
    variables = ("HYPERLANE_URL_LIBRARY", "HYPERLANE_REGEX_LIBRARY", "HYPERLANE_STARKNET_CRYPTO_LIBRARY",
                 "HYPERLANE_ALEO_CRYPTO_LIBRARY", "HYPERLANE_ALEO_VM_LIBRARY", "HYPERLANE_ALEO_VM_WORKER")
    artifacts = {}
    for name in variables:
        value = os.environ.get(name)
        if not value:
            raise AssertionError("required SDK/worker is not selected: " + name)
        path = Path(value)
        with path.open("rb") as stream:
            if stream.read(4) != b"\x7fELF":
                raise AssertionError("required SDK/worker is not a Linux ELF")
            stream.seek(0)
            artifacts[path.name] = hashlib.file_digest(stream, "sha256").hexdigest()
    for role in ROLES:
        path = ROOT / "zig/zig-out/bin" / role
        with path.open("rb") as stream:
            artifacts[path.name] = hashlib.file_digest(stream, "sha256").hexdigest()
    parameters = Path("/opt/hyperlane-fixture/parameters")
    catalog = checked(["python3", "zig/src/aleo/testing/parameters.py", "--home", parameters,
                       "--network", "mainnet", "--max-degree", "18"], timeout=120)
    parameter_receipt = json.loads(catalog.stdout)  # verifies all actual files, no --fetch
    if parameter_receipt["network"] != "mainnet" or parameter_receipt["home"] != str(parameters):
        raise AssertionError("wrong native proof parameter scope")
    manifest = json.loads(Path("/opt/hyperlane-native/manifest.json").read_text())
    if len(manifest["archives"]) != 7:
        raise AssertionError("wrong native archive count")
    unwind = checked(["c++", "-print-file-name=libgcc_s.so.1"]).stdout.strip()
    libraries = manifest["native_db_libs"].split(",") + [str(Path(unwind).resolve(strict=True))]
    env = dict(os.environ)
    env["HYPERLANE_ALEO_PARAMETER_HOME"] = str(parameters)
    env["HYPERLANE_CURL_LIBRARY"] = "libcurl.so.4"
    env["HYPERLANE_LIBCRYPTO_LIBRARY"] = "libcrypto.so.3"
    env["ZIGGY_REGEX_LIBRARY"] = env["HYPERLANE_REGEX_LIBRARY"]
    argv = native_suite_command(mode, jobs, libraries, ROOT, os.uname().machine)
    result = command(argv, env=env, timeout=7250)
    output.parent.mkdir(parents=True, exist_ok=True)
    log = output.with_suffix(".log")
    log.write_text(result.stdout + result.stderr)
    receipt = {"passed": False, "mode": mode, "argv": argv, "exit_code": result.returncode,
               "artifact_sha256": artifacts, "parameters": parameter_receipt,
               "log_sha256": hashlib.sha256(log.read_bytes()).hexdigest(),
               "scope": "Full-SDK Linux native unit suite with explicit named fixture exclusions; not full native-chain/standalone600 acceptance"}
    try:
        if result.returncode != 0:
            raise AssertionError("actual full-SDK native suite exited nonzero")
        receipt["tests"] = native_test_results(log.read_text())
        receipt["passed"] = True
    finally:
        write(output, receipt)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)
    native = subcommands.add_parser("native-suite")
    native.add_argument("--mode", choices=["ReleaseSafe", "ReleaseFast"], required=True)
    native.add_argument("--jobs", type=int, default=2)
    native.add_argument("--output", type=Path, required=True)
    probe = subcommands.add_parser("write-probe")
    probe.add_argument("--output", type=Path, required=True)
    static = subcommands.add_parser("static")
    static.add_argument("--output", type=Path)
    runtime = subcommands.add_parser("runtime")
    runtime.add_argument("--image", required=True)
    runtime.add_argument("--output", type=Path, required=True)
    runtime.add_argument("--smoke", action="store_true")
    runtime.add_argument("--migration-image")
    runtime.add_argument("--expected-git-sha")
    runtime.add_argument("--postgres-image", default=POSTGRES_PIN)
    migrations = subcommands.add_parser("migrations")
    migrations.add_argument("--migration-image", required=True)
    migrations.add_argument("--postgres-image", default=POSTGRES_PIN)
    migrations.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "native-suite":
        native_suite(args.mode, args.jobs, args.output)
        return 0
    if args.command == "write-probe":
        args.output.write_text(PROBE)
        return 0
    if args.command == "static":
        static_check(args.output)
        return 0
    if args.command == "migrations":
        migration_check(args.migration_image, args.postgres_image, args.output)
        return 0
    runtime_check(args.image, args.output, args.smoke, args.migration_image, args.postgres_image, args.expected_git_sha)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
