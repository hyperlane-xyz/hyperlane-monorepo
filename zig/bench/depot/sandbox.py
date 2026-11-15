#!/usr/bin/env python3
"""Long-lived warm Depot build/bench box, driven from this Mac.

A Depot sandbox is the compute behind a CI job, so `start` launches the
zig-bench workflow's `sandbox` job (16 vCPU, toolchains installed, Cargo/Zig
caches restored, idles until stopped) and records its sandbox/session ids.
`depot sandbox exec` then runs commands in it.

  sandbox.py start [--hours 4]      # launch, wait until ready (~2-3 min)
  sandbox.py exec -- CMD...         # run in repo checkout with toolchain env
  sandbox.py exec -C /path -- CMD   # run in another directory
  sandbox.py push REV NAME          # ship local commit REV as worktree ~/zb/NAME (no push to origin)
  sandbox.py pull REMOTE LOCAL      # copy a remote file/dir back (tar)
  sandbox.py put [-C DIR] PATH...   # copy local repo paths (incl. uncommitted) into $REPO or DIR
  sandbox.py status | stop

In remote shells, /tmp/sandbox-env.sh exports PATH, ZIG, REPO and the bench build flags.
State: ~/.cache/zig-bench-sandbox.json.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import shlex
import subprocess
import sys
import time

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[2]
STATE = pathlib.Path.home() / ".cache/zig-bench-sandbox.json"
sys.path.insert(0, str(HERE))
sys.dont_write_bytecode = True


def load() -> dict:
    if not STATE.is_file():
        raise SystemExit("no sandbox recorded; run `sandbox.py start`")
    return json.loads(STATE.read_text())


def ids(state: dict) -> list[str]:
    return ["--sandbox-id", state["sandbox_id"], "--session-id", state["session_id"]]


def remote(state: dict, script: str, stdin=None, check=True, capture=False, timeout_ms=6 * 3600 * 1000):
    argv = ["depot", "sandbox", "exec-pipe" if stdin is not None else "exec", *ids(state),
            "--timeout", str(timeout_ms), "--", "/bin/bash", "-lc", script]
    proc = subprocess.run(argv, stdin=stdin, capture_output=capture, text=capture)
    if check and proc.returncode:
        raise SystemExit(f"remote command failed ({proc.returncode})")
    return proc


def job_attempt(run_id: str):
    out = subprocess.run(["depot", "ci", "status", run_id, "-o", "json"], capture_output=True, text=True)
    if out.returncode or not out.stdout.strip():
        return None, None
    data = json.loads(out.stdout)
    for workflow in data.get("workflows", []):
        for job in workflow.get("jobs", []):
            if job["job_key"].endswith(":sandbox") and job.get("attempts"):
                return job, job["attempts"][-1]
    return None, None


def start(args) -> None:
    import run as driver  # noqa: E402  (zig/bench/depot/run.py)

    run_id, _ = driver.trigger([], None, {"mode": "sandbox", "sandbox_hours": args.hours, "workloads": ["all"], "pairs": 1})
    print(f"run {run_id}; waiting for sandbox job", flush=True)
    while True:
        job, attempt = job_attempt(run_id)
        if attempt and attempt.get("sandbox_id") and attempt.get("session_id") and job["status"] == "running":
            break
        if job and job["status"] in ("failed", "finished", "cancelled"):
            raise SystemExit(f"sandbox job ended: {job['status']}")
        time.sleep(5)
    state = {"run_id": run_id, "sandbox_id": attempt["sandbox_id"], "session_id": attempt["session_id"],
             "attempt_id": attempt["attempt_id"], "started": time.time(), "hours": args.hours}
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(state, indent=2) + "\n")
    print(f"sandbox {state['sandbox_id']} session {state['session_id']}; waiting for setup", flush=True)
    while remote(state, "test -e /tmp/sandbox-ready", check=False, capture=True).returncode:
        time.sleep(10)
    print("ready", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("start")
    p.add_argument("--hours", type=float, default=4)
    p = sub.add_parser("exec")
    p.add_argument("-C", "--cwd")
    p.add_argument("argv", nargs=argparse.REMAINDER)
    p = sub.add_parser("push")
    p.add_argument("rev")
    p.add_argument("name")
    p = sub.add_parser("pull")
    p.add_argument("remote_path")
    p.add_argument("local_path", type=pathlib.Path)
    p = sub.add_parser("put")
    p.add_argument("-C", "--dest", default="$REPO")
    p.add_argument("paths", nargs="+")
    sub.add_parser("status")
    sub.add_parser("stop")
    args = parser.parse_args()

    if args.command == "start":
        start(args)
        return 0
    state = load()
    if args.command == "status":
        job, attempt = job_attempt(state["run_id"])
        print(json.dumps({**state, "job_status": job and job["status"]}, indent=2))
        return 0
    if args.command == "stop":
        remote(state, "touch /tmp/sandbox-stop", check=False)
        STATE.unlink()
        print("stop requested; job exits within 10 s")
        return 0
    if args.command == "exec":
        argv = args.argv[1:] if args.argv[:1] == ["--"] else args.argv
        cd = f"cd {shlex.quote(args.cwd)} && " if args.cwd else ""
        return remote(state, f"source /tmp/sandbox-env.sh && {cd}{' '.join(argv)}", check=False).returncode
    if args.command == "push":
        sha = subprocess.run(["git", "rev-parse", "--verify", f"{args.rev}^{{commit}}"], cwd=ROOT, check=True,
                             capture_output=True, text=True).stdout.strip()
        ref = f"refs/zb-bench/{args.name}"
        # Bundles need a ref name; a private namespace ref is created and removed (no branch/index change).
        subprocess.run(["git", "update-ref", ref, sha], cwd=ROOT, check=True)
        try:
            bundle = subprocess.Popen(["git", "bundle", "create", "-", f"origin/feat/zig-agent-rewrite..{ref}"],
                                      cwd=ROOT, stdout=subprocess.PIPE)
            dest = f"$HOME/zb/{args.name}"
            remote(state, f"source /tmp/sandbox-env.sh && cat > /tmp/{args.name}.bundle && "
                          f"git fetch -q /tmp/{args.name}.bundle {ref}:{ref} && mkdir -p $HOME/zb && "
                          f"(git worktree remove --force {dest} 2>/dev/null; true) && git worktree add -q --detach {dest} {sha} && "
                          f"echo {dest} at $(git -C {dest} rev-parse --short HEAD)", stdin=bundle.stdout)
            bundle.wait()
        finally:
            subprocess.run(["git", "update-ref", "-d", ref], cwd=ROOT, check=True)
        return 0
    if args.command == "put":
        # exec-pipe can drop stdin sent before the remote command starts, so ship base64 chunks as arguments.
        import base64
        tar = subprocess.run(["tar", "czf", "-", "--exclude", "__pycache__", "--exclude", "provenance.json", *args.paths],
                             cwd=ROOT, check=True, capture_output=True).stdout
        text = base64.b64encode(tar).decode()
        remote(state, "rm -f /tmp/put.b64")
        for i in range(0, len(text), 60000):
            remote(state, f"printf %s {text[i:i + 60000]} >> /tmp/put.b64")
        remote(state, f"source /tmp/sandbox-env.sh && mkdir -p {args.dest} && base64 -d /tmp/put.b64 | tar xzf - -C {args.dest} && echo put {len(tar)} bytes into {args.dest}")
        return 0
    if args.command == "pull":
        args.local_path.mkdir(parents=True, exist_ok=True)
        path = shlex.quote(args.remote_path)
        argv = ["depot", "sandbox", "exec", *ids(state), "--", "/bin/bash", "-lc",
                f"tar czf - -C $(dirname {path}) $(basename {path})"]
        with subprocess.Popen(argv, stdout=subprocess.PIPE) as proc:
            subprocess.run(["tar", "xzf", "-", "-C", str(args.local_path)], stdin=proc.stdout, check=True)
        return proc.returncode
    return 1


if __name__ == "__main__":
    sys.exit(main())
