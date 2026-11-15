#!/usr/bin/env python3
"""Run zig/bench/validator.py unchanged, adding failure diagnostics.

On a checkpoint deadline the harness only reports daemon log tails. This wrapper
records why the last checkpoint_objects() probe failed (missing objects, stale
index.json) plus the directory listing, as `diagnostic` in validator.json and
on stderr. (The harness no longer waits for merkle_snapshot.json: Rust classic
fallback only writes it at backfill end, see rust/main/agents/validator/src/submit.rs.)
"""
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import validator as harness  # noqa: E402  zig/bench/validator.py

original = harness.checkpoint_objects
last = {}


def probed(directory, count):
    result = original(directory, count)
    if result is None:
        reason = {"count": count}
        try:
            reason["missing_objects"] = [i for i in range(count) if not (directory / f"{i}_with_id.json").exists()][:20]
            index = directory / "index.json"
            reason["index_json"] = index.read_text() if index.exists() else None
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
