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
import time
import signal
import importlib.util


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



class CommandInterrupted(RuntimeError):
    pass


def _run_owned_command(command, root, env, timeout_seconds, diagnostic_dir, started, deadline):
    """Keep the original absolute command deadline and wait the complete owned tree.

    Progress contains public PID/start/executable names only, never argv/env.
    Existing qualified owner handles cancellation and retained descendant identity.
    """
    owner_path = root / "zig/bench/cold_matrix_owner.py"
    spec = importlib.util.spec_from_file_location("native_http_owned", owner_path)
    ownership = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ownership)
    # This monitor is a separate process: the HTTP fixture is its sibling.
    ownership.enable_subreaper()
    child = None
    known, groups = {}, {}
    primary = None
    cleanup = None
    next_sample = started
    samples = 0
    def interrupted(signum, frame):
        raise CommandInterrupted(f"native HTTP command interrupted by signal {signum}")
    watched = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)}
    for sig in watched:
        signal.signal(sig, interrupted)
    cleanup_error = None
    try:
        child = subprocess.Popen(command, cwd=root, env=env, start_new_session=True)
        groups[child.pid] = child.pid
        while True:
            now = time.monotonic()
            rows = ownership.processes()
            live = ownership.owned_processes(rows, child.pid, known, groups, True)
            if diagnostic_dir is not None and now >= next_sample:
                row = {"elapsed_seconds": now - started, "processes": list(live.values())}
                text = json.dumps(row) + "\n"
                progress = diagnostic_dir / "progress.jsonl"
                if len(live) > 256 or (progress.stat().st_size if progress.exists() else 0) + len(text.encode()) > 4 * 1024 * 1024:
                    raise RuntimeError("native HTTP process diagnostic bound exceeded")
                with progress.open("a") as out:
                    out.write(text)
                samples += 1
                next_sample = now + 5
            # WNOWAIT reserves the direct PID/group through cleanup escalation.
            event = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            if event is not None:
                if time.monotonic() > deadline:
                    raise subprocess.TimeoutExpired(command, timeout_seconds)
                break
            if time.monotonic() >= deadline:
                raise subprocess.TimeoutExpired(command, timeout_seconds)
            time.sleep(min(0.2, max(0, deadline - time.monotonic())))
    except BaseException as error:
        primary = error
    finally:
        for sig in watched:
            signal.signal(sig, signal.SIG_IGN)
        try:
            if child is not None:
                cleanup = ownership.stop_owned(child, known, groups)
        except BaseException as error:
            cleanup_error = type(error).__name__
            if primary is None:
                primary = error
        finally:
            for sig, handler in watched.items():
                signal.signal(sig, handler)
        if diagnostic_dir is not None:
            record = {"command_deadline_seconds": timeout_seconds, "elapsed_seconds": time.monotonic() - started,
                      "pid": None if child is None else child.pid, "samples": samples,
                      "exit_code": None if child is None else child.returncode,
                      "primary_error": None if primary is None else type(primary).__name__,
                      "cleanup": cleanup, "cleanup_error": cleanup_error, "native_or_timing_acceptance": False}
            (diagnostic_dir / "result.json").write_text(json.dumps(record, indent=2) + "\n")
    if primary is not None:
        raise primary
    if cleanup is None or not cleanup["actual_parent_wait"] or not cleanup["cleanup_confirmed_absent"] or not cleanup["clean"]:
        raise RuntimeError("native HTTP test-command descendants were not all joined/absent")
    if any(row["state"] != "Z" for row in cleanup.get("owned_present_before_stop", [])):
        # An exited wrapper with still-live children is a failed test command.
        raise RuntimeError("native HTTP test-command exited with live descendants")
    return child.returncode



def _command_worker(arguments):
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--diagnostic-dir", type=Path, required=True)
    parser.add_argument("--started", type=float, required=True)
    parser.add_argument("--deadline", type=float, required=True)
    parser.add_argument("--timeout", type=float, required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    options = parser.parse_args(arguments)
    command = options.command[1:]
    try:
        return _run_owned_command(command, options.root, os.environ.copy(), options.timeout,
                                  options.diagnostic_dir, options.started, options.deadline)
    except (subprocess.TimeoutExpired, CommandInterrupted):
        return 124
    except BaseException:
        raise


def run_command(command, root, env, timeout_seconds, diagnostic_dir=None):
    # Python children share this monotonic clock epoch. Startup consumes the
    # original budget; cleanup has a separate bounded grace, never test credit.
    started = time.monotonic()
    deadline = started + timeout_seconds
    temporary = None
    if diagnostic_dir is None:
        temporary = tempfile.TemporaryDirectory(prefix="ziggy-native-command-")
        diagnostic_dir = Path(temporary.name) / "evidence"
    diagnostic_dir.mkdir(parents=True, exist_ok=False)
    spec = importlib.util.spec_from_file_location("native_http_monitor_parent", root / "zig/bench/cold_matrix_owner.py")
    ownership = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ownership)
    argv = [sys.executable, str(Path(__file__).resolve()), "--owned-command-worker",
            "--root", str(root), "--diagnostic-dir", str(diagnostic_dir),
            "--started", str(started), "--deadline", str(deadline), "--timeout", str(timeout_seconds), "--", *command]
    child = None
    known, groups = {}, {}
    primary = None
    cleanup = None
    watched = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)}
    def interrupted(signum, frame):
        raise CommandInterrupted(f"native HTTP monitor interrupted by signal {signum}")
    for sig in watched:
        signal.signal(sig, interrupted)
    try:
        child = subprocess.Popen(argv, cwd=root, env=env, start_new_session=True)
        groups[child.pid] = child.pid
        while True:
            rows = ownership.processes()
            ownership.owned_processes(rows, child.pid, known, groups, True)
            event = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            if event is not None:
                break
            if time.monotonic() >= deadline + 18:
                raise RuntimeError("native HTTP monitor exceeded test deadline plus cleanup grace")
            time.sleep(.05)
    except BaseException as error:
        primary = error
        if child is not None:
            # Child PID remains unreaped, so this positive direct identity is reserved.
            try:
                os.kill(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                event = None
                end = time.monotonic() + 16
                while event is None and time.monotonic() < end:
                    rows = ownership.processes()
                    ownership.owned_processes(rows, child.pid, known, groups, True)
                    event = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                    if event is None:
                        time.sleep(.05)
            except BaseException:
                pass  # Fenced parent cleanup below still runs; primary remains authoritative.
    finally:
        for sig in watched:
            signal.signal(sig, signal.SIG_IGN)
        try:
            if child is not None:
                cleanup = ownership.stop_owned(child, known, groups, grace_seconds=1, kill_seconds=2)
            (diagnostic_dir / "monitor-parent.json").write_text(json.dumps({"primary_error":None if primary is None else type(primary).__name__, "cleanup":cleanup},indent=2)+"\n")
        finally:
            for sig, handler in watched.items():
                signal.signal(sig, handler)
    try:
        if primary is not None:
            raise primary
        if not cleanup or not cleanup["clean"] or not cleanup["cleanup_confirmed_absent"]:
            raise RuntimeError("native HTTP monitor tree did not join/stop cleanly")
        result = json.loads((diagnostic_dir / "result.json").read_text())
        expected_exit = 124 if result["primary_error"] in {"TimeoutExpired", "CommandInterrupted"} else result["exit_code"]
        if child.returncode != expected_exit:
            raise RuntimeError("native HTTP monitor wait status differs from its result")
        if not result["cleanup"]["actual_parent_wait"] or not result["cleanup"]["cleanup_confirmed_absent"] or not result["cleanup"]["clean"]:
            raise RuntimeError("native HTTP command descendants were not waited/absent")
        if result["primary_error"] == "TimeoutExpired":
            raise subprocess.TimeoutExpired(command, timeout_seconds)
        if result["primary_error"] is not None:
            raise RuntimeError("native HTTP command failed: " + result["primary_error"])
        return result["exit_code"]
    finally:
        if temporary is not None:
            temporary.cleanup()


def main():
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--library", default="/usr/lib/libcurl.4.dylib" if platform.system() == "Darwin" else "libcurl.so.4")
    parser.add_argument("--mode", default="ReleaseSafe", choices=["Debug", "ReleaseSafe", "ReleaseFast"])
    parser.add_argument("--libcrypto", default="/opt/homebrew/opt/openssl@3/lib/libcrypto.3.dylib" if platform.system() == "Darwin" else "libcrypto.so.3")
    parser.add_argument("--timeout-seconds", type=int, default=300)
    parser.add_argument("--diagnostic-dir", type=Path, help="Exclusive public process/progress evidence directory")
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
            return run_command(command, root, env, options.timeout_seconds, options.diagnostic_dir)
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
    raise SystemExit(_command_worker(sys.argv[2:]) if sys.argv[1:2] == ["--owned-command-worker"] else main())
