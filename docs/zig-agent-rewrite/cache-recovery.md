# Cache recovery before the final build matrix

The final matrix launched on commit `516bdf4290` with **40.8308 GiB free**. The
cache recovery completed before timing started, after the team’s compiler and test
jobs had joined. All 11 matrix phases subsequently exited successfully.

The removal used a fixed whitelist of historical outputs created for this rewrite:

| Removed                                      | Count |
| -------------------------------------------- | ----: |
| Old test-output directories                  | 1,264 |
| Test executables and paired compiler objects | 2,528 |
| Source-bound cache manifests                 |   557 |

Each directory contained exactly `test` and `test_zcu.o`. Files had matching
reviewed hashes, post-task birth times, the exact checkout source path, verified
Mach-O executable/object headers, one link and no open handles. The reviewed CLI
invalidated the 557 manifests first, then removed only those two named children
and their empty directories. No recursive purge was used.

The isolated Zig 0.15.2 canary explained the manifest ordering: removing a cached
executable, or its output directory, left reruns failing with `FileNotFound`.
Invalidating the exact source-bound manifest allowed the same command to rebuild
and pass. A dry run also found four new, unselected manifests. A pinned
preservation-only sidecar added them to the keep checks; the removal whitelist and
recovery snapshot stayed unchanged.

The operation preserved **551 other manifests and 21 runtime artifacts**, with
hashes checked before and after. Source, SDKs, parameters, runtime pins, evidence
and unrelated cache entries remained in place. This was an exact task-output
exception inside the user-global cache, not permission for general cache cleanup.

| Observed storage           | Free GiB |
| -------------------------- | -------: |
| Before the guarded removal |  24.3019 |
| After removal              |  40.8318 |
| At matrix launch           |  40.8308 |

These are filesystem readbacks, not sums of estimated reclaimable bytes.

The retained recovery archive is **4,609,851,939 bytes**, stored locally at
`/tmp/ziggy-task-test-cache-recovery-20261106T113521Z/approved-cache-recovery.tar.zst`.
All 3,085 members were decoded and checked for content hash, header, count, mode,
owner and modification time. Recompression preserved the complete TAR byte
stream. The superseded private gzip and stopped level-9 partial were removed only
after that verification; their cleanup receipts remain. No restore was performed.
The repository contains small provenance files and scripts, not the compiled
backup. Recovery still depends on retaining that local archive.

The [provenance manifest](../../zig/bench/results/task-cache-recovery-20261106/manifest.json)
binds the reviewed CLI (`e9e15befa87f`), snapshot (`0532c3920f93`), archive
(`c5df8d22721a`), canary, reviews, dry-run and execution receipts, private-copy
cleanup, launch record and load snapshot. Each gzip has deterministic headers and
both raw and compressed SHA256 chunk pairs.

Build timings remain shared-host observations. The retained 12:25 CPU snapshot
included `system_profiler` at 94.8%, Warp at 36.3% and WindowServer at 31.7%. The
launch record establishes the storage floor and joined task jobs; it does not
establish an otherwise idle host throughout the matrix.
