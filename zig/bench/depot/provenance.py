#!/usr/bin/env python3
"""Source provenance for Depot bench runs.

`depot ci run` checks out the remote merge base and applies a patch of all
tracked changes (plus intent-to-add files). The measured source is therefore
identified by a git *tree* id:

  local:  temp index = real index + `add -u` + bench files -> write-tree
  runner: temp index = HEAD + `add -A` after the patch      -> write-tree

Equal tree ids prove the runner measured exactly the local state. Recorded
alongside: local HEAD, merge base, sha256 of the merge-base..tree diff (the
effective patch) and its diffstat, and the paths that differ from local HEAD.

  provenance.py local  [--repo DIR] [--include PATH...]   # JSON to stdout
  provenance.py runner [--github-output]                  # on the runner, compares with provenance.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
SELF = "zig/bench/depot/provenance.json"


def git(repo, *args, env=None, binary=False):
    out = subprocess.run(["git", *args], cwd=repo, env=env, check=True, capture_output=True)
    return out.stdout if binary else out.stdout.decode().strip()


def index_env(repo, tmp):
    real = pathlib.Path(git(repo, "rev-parse", "--git-path", "index"))
    real = real if real.is_absolute() else pathlib.Path(repo) / real
    index = pathlib.Path(tmp) / "index"
    if real.exists():
        shutil.copy2(real, index)
    return {**os.environ, "GIT_INDEX_FILE": str(index)}


def upstream(repo):
    try:
        return git(repo, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")
    except subprocess.CalledProcessError:
        return "origin/feat/zig-agent-rewrite"


def local(repo, include):
    repo = str(pathlib.Path(repo).resolve())
    head = git(repo, "rev-parse", "HEAD")
    up = upstream(repo)
    base = git(repo, "merge-base", "HEAD", up)
    with tempfile.TemporaryDirectory(prefix="zb-prov-") as tmp:
        env = index_env(repo, tmp)
        git(repo, "add", "-u", env=env)
        untracked = git(repo, "ls-files", "--others", "--exclude-standard", "--", *include, env=env).split()
        untracked = [p for p in untracked if p != SELF]
        if untracked:
            git(repo, "add", "--", *untracked, env=env)
        git(repo, "rm", "-q", "--cached", "--ignore-unmatch", "--", SELF, env=env)
        tree = git(repo, "write-tree", env=env)
    patch = git(repo, "diff", "--binary", base, tree, binary=True)
    return {
        "local_head": head,
        "local_head_subject": git(repo, "log", "-1", "--format=%s", head),
        "upstream": up,
        "merge_base": base,
        "source_tree": tree,
        "head_tree": git(repo, "rev-parse", f"{head}^{{tree}}"),
        "clean_head": tree == git(repo, "rev-parse", f"{head}^{{tree}}"),
        "paths_differing_from_head": git(repo, "diff", "--name-only", head, tree).split(),
        "effective_patch_sha256": hashlib.sha256(patch).hexdigest(),
        "effective_patch_bytes": len(patch),
        "effective_patch_shortstat": git(repo, "diff", "--shortstat", base, tree),
    }


def runner():
    repo = git(".", "rev-parse", "--show-toplevel")
    file = pathlib.Path(repo) / SELF
    claimed = json.loads(file.read_text()) if file.is_file() else {}
    with tempfile.TemporaryDirectory(prefix="zb-prov-") as tmp:
        env = {**os.environ, "GIT_INDEX_FILE": str(pathlib.Path(tmp) / "index")}
        git(repo, "read-tree", "HEAD", env=env)
        git(repo, "add", "-A", "--", ".", f":!{SELF}", env=env)
        tree = git(repo, "write-tree", env=env)
    result = {**claimed, "runner_head": git(repo, "rev-parse", "HEAD"), "runner_tree": tree,
              "runner_patch_shortstat": git(repo, "diff", "--shortstat", "HEAD", tree)}
    if claimed:
        result["tree_match"] = tree == claimed.get("source_tree")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("local")
    p.add_argument("--repo", default=str(HERE.parents[2]))
    p.add_argument("--include", nargs="*", default=[])
    p = sub.add_parser("runner")
    p.add_argument("--github-output", action="store_true")
    args = parser.parse_args()
    if args.command == "local":
        print(json.dumps(local(args.repo, args.include), indent=2))
        return
    result = runner()
    text = json.dumps(result, sort_keys=True)
    print(json.dumps(result, indent=2))
    if args.github_output:
        with open(os.environ["GITHUB_OUTPUT"], "a") as out:
            out.write(f"provenance={text}\n")


if __name__ == "__main__":
    sys.exit(main())
