#!/usr/bin/env python3
"""Trigger the Depot paired bench from local working-tree state, wait, fetch results.

  zig/bench/depot/run.sh                      # all 10 workloads, 5 pairs
  zig/bench/depot/run.sh scraper-safe -n 2    # one workload, 2 pairs
  zig/bench/depot/run.sh validator-fast relayer-single
  zig/bench/depot/run.sh --fetch <run-id>     # only download/print an existing run
  zig/bench/depot/run.sh --build-only         # build/warm caches only

  zig/bench/depot/run.sh --ref af9a613702 all  # bench another commit (temp worktree, current harness overlaid)
  zig/bench/depot/run.sh scraper --profile    # + one perf-record and one strace pair per workload

Selection travels to Depot inside the patch via zig/bench/depot/selection.json.
`depot ci run` uploads tracked changes only; this script builds the patch from a
temporary git index that marks the bench files intent-to-add, so new untracked
bench files are included without touching the real index.
--ref: a temporary worktree on a temporary branch (upstream = this branch's
upstream, so Depot's merge base and patch model stay the same) at that commit,
with the current bench harness files copied over it so A/B runs share a harness.
Provenance (local HEAD, merge base, source tree id, effective patch hash and
diffstat; verified on the runner) is stored in run.json and the summary header.
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


# Harness files overlaid onto --ref worktrees so both arms of an A/B share them.
OVERLAY = INCLUDE + ["zig/bench/validator.py", "zig/bench/scraper.py", "zig/bench/relayer.py",
                     "zig/integration/evm.py", "zig/integration/relayer_process.py", "zig/integration/validator.py"]
import provenance as prov  # noqa: E402


def git(*args, env=None, check=True, repo=ROOT):
    return subprocess.run(["git", *args], cwd=repo, env=env, check=check, capture_output=True, text=True).stdout


class Tree:
    """The checkout Depot uploads from: ROOT, or a temporary worktree at --ref."""

    def __init__(self, ref: str | None):
        self.ref = ref
        self.path = ROOT
        self.branch = None
        if ref:
            sha = git("rev-parse", "--verify", f"{ref}^{{commit}}").strip()
            self.branch = f"zb-ref-{sha[:12]}-{os.getpid()}"
            self.path = pathlib.Path(tempfile.mkdtemp(prefix="zb-ref-")) / "repo"
            upstream = prov.upstream(str(ROOT))
            git("worktree", "add", "-q", "-b", self.branch, str(self.path), sha)
            git("branch", "-q", "-u", upstream, self.branch)
            for rel in OVERLAY:
                src, dst = ROOT / rel, self.path / rel
                if src.is_dir():
                    shutil.copytree(src, dst, dirs_exist_ok=True, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "provenance.json"))
                elif src.is_file():
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(src, dst)
            print(f"ref {ref} -> {sha} in temporary worktree {self.path} (harness overlaid)", flush=True)

    def close(self):
        if self.ref:
            git("worktree", "remove", "--force", str(self.path), check=False)
            git("branch", "-q", "-D", self.branch, check=False)
            shutil.rmtree(self.path.parent, ignore_errors=True)


def trigger(jobs: list[str], tree: Tree | None = None, selection: dict | None = None) -> tuple[str, dict]:
    tree = tree or Tree(None)
    repo = tree.path
    sel_path = repo / "zig/bench/depot/selection.json"
    prov_path = repo / "zig/bench/depot/provenance.json"
    original = sel_path.read_text() if sel_path.is_file() else None
    try:
        if selection is not None:
            sel_path.write_text(json.dumps(selection) + "\n")
        provenance = prov.local(str(repo), OVERLAY)
        provenance["ref_requested"] = tree.ref
        prov_path.write_text(json.dumps(provenance, indent=2) + "\n")
        with tempfile.TemporaryDirectory(prefix="zb-index-") as tmp:
            env = prov.index_env(str(repo), tmp)
            untracked = git("ls-files", "--others", "--exclude-standard", "--", *OVERLAY, env=env, repo=repo).split()
            if untracked:
                git("add", "--intent-to-add", "--", *untracked, env=env, repo=repo)
            argv = ["depot", "ci", "run", "--workflow", WORKFLOW]
            for job in jobs:
                argv += ["--job", job]
            proc = subprocess.run(argv, cwd=repo, env=env, capture_output=True, text=True)
    finally:
        if original is not None:
            sel_path.write_text(original)
        prov_path.unlink(missing_ok=True)
    text = proc.stdout + proc.stderr
    sys.stderr.write(text)
    match = re.search(r"^Run: (\S+)", text, re.M)
    if proc.returncode or not match:
        raise SystemExit("depot ci run failed")
    provenance["depot"] = {k: m.group(1) for k, rx in [("base", r"^Base: (.+)$"), ("merge_base", r"^Merge base: (\S+)"),
                                                     ("patch_bytes", r"^Patch size: (\d+)"), ("patch_cache_key", r"^Cache key: (\S+)"),
                                                     ("head", r"^HEAD: (\S+)")] if (m := re.search(rx, text, re.M))}
    return match.group(1), provenance


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


def fetch(run_id: str, dest: pathlib.Path, provenance: dict | None = None) -> None:
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
        for attempt in range(4):  # downloads occasionally fail transiently
            got = subprocess.run(["depot", "ci", "artifacts", "download", ident, "--output-file", str(target)],
                                 capture_output=True, text=True)
            if got.returncode == 0:
                break
            time.sleep(5 * (attempt + 1))
        else:
            print(f"artifact {name} download failed: {got.stderr[-500:]}", file=sys.stderr)
            continue
        unpack = dest / ("summary" if name == "zig-bench-summary" else name.removeprefix("zig-bench-result-"))
        try:
            with zipfile.ZipFile(target) as archive:
                archive.extractall(unpack)
            target.unlink()
        except zipfile.BadZipFile:
            pass  # keep the raw download
    record = {"run_id": run_id, "provenance": provenance, "status": status(run_id)}
    runner = dest / "summary" / "provenance.json"
    if runner.is_file():
        record["runner_provenance"] = json.loads(runner.read_text())
    (dest / "run.json").write_text(json.dumps(record, indent=2) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("workloads", nargs="*", help="selectors (default all): " + ", ".join(catalogue.WORKLOADS))
    parser.add_argument("-n", "--pairs", type=int, default=5)
    parser.add_argument("--fetch", metavar="RUN_ID", help="skip triggering; download an existing run")
    parser.add_argument("--no-wait", action="store_true")
    parser.add_argument("--build-only", action="store_true", help="run only the build job (warms caches), no bench")
    parser.add_argument("--poll", type=float, default=30)
    parser.add_argument("--ref", help="bench this commit instead of the working tree (current harness overlaid)")
    parser.add_argument("--profile", action="store_true", help="add one perf-record pair and one strace pair per workload (excluded from stats)")
    args = parser.parse_args()
    provenance = None
    if args.fetch:
        run_id = args.fetch
    else:
        names = catalogue.select(args.workloads or ["all"])
        print(f"workloads={names} pairs={args.pairs} ref={args.ref or 'working tree'} profile={args.profile}", flush=True)
        tree = Tree(args.ref)
        try:
            run_id, provenance = trigger(["build"] if args.build_only else [], tree,
                                         {"workloads": names, "pairs": args.pairs, "profile": args.profile})
        finally:
            tree.close()
        print(f"run {run_id}: source tree {provenance['source_tree'][:12]} (HEAD {provenance['local_head'][:10]}, "
              f"{len(provenance['paths_differing_from_head'])} paths differ), depot ci status {run_id}", flush=True)
        if args.no_wait:
            return 0
    final = wait(run_id, args.poll)
    if args.build_only:
        return 0 if final.get("status") == "finished" else 1
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    label = f"-{args.ref}" if args.ref else ""
    dest = ROOT / "zig/bench/results/depot" / f"{stamp}-{run_id}{label}"
    fetch(run_id, dest, provenance)
    summary = dest / "summary" / "summary.md"
    print(f"\nresults: {dest}")
    if summary.is_file():
        print(summary.read_text())
    else:
        print("no summary artifact; see `depot ci status", run_id, "` and per-workload dirs")
    return 0 if final.get("status") in ("finished", "success", "succeeded", "completed") else 1


if __name__ == "__main__":
    sys.exit(main())
