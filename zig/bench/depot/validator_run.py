#!/usr/bin/env python3
"""Run zig/bench/validator.py with one predicate change and failure diagnostics.

Predicate: a checkpoint counts as published when every `{i}_with_id.json` exists
and index.json has reached it. The harness additionally waits for
merkle_snapshot.json to reach the index; Rust only advances that snapshot from
its consensus (majority/quorum) worker - with classic `fallback` it is written
once at backfill end (rust/main/agents/validator/src/submit.rs), so every Rust
fallback run hit the steady deadline although all checkpoints were signed.
The snapshot is internal restart state, not checkpoint publication, so it is
dropped for every consensus mode. Root/id/signature verification is unchanged.

Diagnostics: on failure, why the last probe failed and the directory listing
are stored as `diagnostic` in validator.json and printed to stderr.
"""
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import validator as harness  # noqa: E402  zig/bench/validator.py

last = {}


def published(directory, count):
    try:
        objects = [json.loads((directory / f"{i}_with_id.json").read_text()) for i in range(count)]
        if int((directory / "index.json").read_text()) < count - 1:
            return None
        return objects
    except (OSError, ValueError, KeyError):
        return None


def probed(directory, count):
    result = published(directory, count)
    if result is None:
        reason = {"count": count}
        try:
            missing = [i for i in range(count) if not (directory / f"{i}_with_id.json").exists()]
            reason["missing_objects"] = missing[:20]
            reason["index_json"] = (directory / "index.json").read_text() if (directory / "index.json").exists() else None
            snap = directory / "merkle_snapshot.json"
            reason["merkle_snapshot_index"] = json.loads(snap.read_text()).get("index") if snap.exists() else None
            reason["files"] = sorted(p.name for p in directory.iterdir())[-12:] if directory.exists() else None
        except (OSError, ValueError) as error:
            reason["probe_error"] = str(error)
        last.clear()
        last.update(reason)
    return result


harness.checkpoint_objects = probed


def main():
    output = pathlib.Path(sys.argv[sys.argv.index("--output") + 1])
    try:
        harness.main()
    except BaseException:
        if last:
            print("checkpoint diagnostic:", json.dumps(last), file=sys.stderr)
            path = output / "validator.json"
            if path.is_file():
                data = json.loads(path.read_text())
                data["diagnostic"] = dict(last)
                path.write_text(json.dumps(data, indent=2) + "\n")
        raise


if __name__ == "__main__":
    main()
