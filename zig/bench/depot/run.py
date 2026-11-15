#!/usr/bin/env python3
"""Trigger the Depot paired bench from local working-tree state, wait, fetch results.

  zig/bench/depot/run.sh                      # all 10 workloads, 5 pairs
  zig/bench/depot/run.sh scraper-safe -n 2    # one workload, 2 pairs
  zig/bench/depot/run.sh validator-fast relayer-single
  zig/bench/depot/run.sh --fetch <run-id>     # only download/print an existing run
  zig/bench/depot/run.sh --build-only         # build/warm caches only

Selection travels to Depot inside the patch via zig/bench/depot/selection.json.
`depot ci run` uploads tracked changes only; this script builds the patch from a
temporary git index that marks the bench files intent-to-add, so new untracked
bench files are included without touching the real index.
Results: zig/bench/results/depot/<UTC timestamp>-<run id>/ (summary.md printed).
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from datetime import datetime, timezone

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[2]
WORKFLOW = ".depot/workflows/zig-bench.yml"
INCLUDE = ["zig/bench/depot", WORKFLOW]
sys.path.insert(0, str(HERE))
import workloads as catalogue  # noqa: E402


def git(*args, env=None, check=True):
    return subprocess.run(["git", *args], cwd=ROOT, env=env, check=check, capture_output=True, text=True).stdout


def trigger(jobs: list[str]) -> str:
    with tempfile.TemporaryDirectory(prefix="zb-index-") as tmp:
        index = pathlib.Path(tmp) / "index"
        real_index = pathlib.Path(git("rev-parse", "--git-path", "index").strip())
        if not real_index.is_absolute():
            real_index = ROOT / real_index
        shutil.copy2(real_index, index)
        env = {**os.environ, "GIT_INDEX_FILE": str(index)}
        untracked = git("ls-files", "--others", "--exclude-standard", "--", *INCLUDE, env=env).split()
        if untracked:
            git("add", "--intent-to-add", "--", *untracked, env=env)
        argv = ["depot", "ci", "run", "--workflow", WORKFLOW]
        for job in jobs:
            argv += ["--job", job]
        proc = subprocess.run(argv, cwd=ROOT, env=env, capture_output=True, text=True)
    sys.stderr.write(proc.stdout + proc.stderr)
    match = re.search(r"^Run: (\S+)", proc.stdout + proc.stderr, re.M)
    if proc.returncode or not match:
        raise SystemExit("depot ci run failed")
    return match.group(1)


def status(run_id: str) -> dict:
    out = subprocess.run(["depot", "ci", "status", run_id, "-o", "json"], capture_output=True, text=True)
    return json.loads(out.stdout) if out.returncode == 0 and out.stdout.strip() else {}


def wait(run_id: str, poll: float) -> dict:
    last = None
    while True:
        st = status(run_id)
        jobs = [(j["job_key"].split(":")[-1], j["status"]) for w in st.get("workflows", []) for j in w.get("jobs", [])]
        line = f"{st.get('status')}: " + ", ".join(f"{k}={v}" for k, v in jobs)
        if line != last:
            print(f"[{datetime.now().strftime('%H:%M:%S')}] {line}", flush=True)
            last = line
        if st.get("status") and st["status"] not in ("queued", "running", "pending", "in_progress"):
            return st
        time.sleep(poll)


def fetch(run_id: str, dest: pathlib.Path) -> None:
    listed = subprocess.run(["depot", "ci", "artifacts", "list", run_id, "-o", "json"], capture_output=True, text=True)
    if listed.returncode:
        raise SystemExit(listed.stderr)
    data = json.loads(listed.stdout)
    artifacts = data if isinstance(data, list) else data.get("artifacts", [])
    dest.mkdir(parents=True, exist_ok=True)
    for art in artifacts:
        name = art.get("name") or art.get("artifact_name")
        ident = art.get("artifact_id") or art.get("id")
        if not name or not ident or name == "zig-bench-bins":
            continue
        target = dest / f"{name}.zip"
        subprocess.run(["depot", "ci", "artifacts", "download", ident, "--output-file", str(target)], check=True,
                       capture_output=True)
        unpack = dest / ("summary" if name == "zig-bench-summary" else name.removeprefix("zig-bench-result-"))
        try:
            with zipfile.ZipFile(target) as archive:
                archive.extractall(unpack)
            target.unlink()
        except zipfile.BadZipFile:
            pass  # keep the raw download
    (dest / "run.json").write_text(json.dumps({"run_id": run_id, "status": status(run_id)}, indent=2) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("workloads", nargs="*", help="selectors (default all): " + ", ".join(catalogue.WORKLOADS))
    parser.add_argument("-n", "--pairs", type=int, default=5)
    parser.add_argument("--fetch", metavar="RUN_ID", help="skip triggering; download an existing run")
    parser.add_argument("--no-wait", action="store_true")
    parser.add_argument("--build-only", action="store_true", help="run only the build job (warms caches), no bench")
    parser.add_argument("--poll", type=float, default=30)
    args = parser.parse_args()
    if args.fetch:
        run_id = args.fetch
    else:
        names = catalogue.select(args.workloads or ["all"])
        (HERE / "selection.json").write_text(json.dumps({"workloads": names, "pairs": args.pairs}) + "\n")
        print(f"workloads={names} pairs={args.pairs}", flush=True)
        run_id = trigger(["build"] if args.build_only else [])
        print(f"run {run_id}: https://depot.dev/orgs/ptcjppsfhw/workflows (depot ci status {run_id})", flush=True)
        if args.no_wait:
            return 0
    final = wait(run_id, args.poll)
    if args.build_only:
        return 0 if final.get("status") == "finished" else 1
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    dest = ROOT / "zig/bench/results/depot" / f"{stamp}-{run_id}"
    fetch(run_id, dest)
    summary = dest / "summary" / "summary.md"
    print(f"\nresults: {dest}")
    if summary.is_file():
        print(summary.read_text())
    else:
        print("no summary artifact; see `depot ci status", run_id, "` and per-workload dirs")
    return 0 if final.get("status") in ("finished", "success", "succeeded", "completed") else 1


if __name__ == "__main__":
    sys.exit(main())
