# Scraper final functional acceptance

Correctness only. Native PostgreSQL: **361 passed, 10 optional skipped, 0 failed**;
all 21 actual migrations and 11 functional cases on PostgreSQL 16.15. Compressed
SDK fixtures: **62 passed, 2 optional skipped, 0 failed**.

The freshly rebuilt CPU/GUC-fixed scraper passed actual production-Solidity,
Anvil and migrated-PostgreSQL process checks: all five event/link counts advanced
2→3 across restart; four receipts/domain and successful-neighbor persistence
while one hash stalled; healthy ninth chain progressed while eight heads stalled;
metrics GET/HEAD; SIGTERM/SIGINT drain; published-fork halt/exit1 preserving rows.
The local head-liveness fixture observed 242 ms, 22,384 KiB RSS and 66 threads,
including nine lazy 1 MiB head-owner stacks and eight supervisor workers. These
are correctness/liveness observations, not matched throughput or Tokio resource
claims.

`summary.json` is readable, with digest chunks. `manifest.json` lists 29 lossless
compressed original files and their digests. For example:

```sh
python3 -c 'import gzip; print(gzip.open("zig/bench/results/scraper-final-functional/acceptance.json.gz", "rt").read())'
```

Original JSON, exact source fingerprints and logs preserve their original bytes.
The binary remains pinned at `/tmp/ziggy-scraper-final-integration/scraper`; its
size/digest identify what executed. No runtime binary is checked into this folder.
Earlier failed/pre-fix/nonquiet results remain in their original separate folders.

Source coverage is qualified: the 136-file protocol/scraper subset stayed stable,
and the conservative 186-path PG import/embed closure had no observed source
changes. Its 185 recorded baseline hashes matched afterward; the immutable raw
CCIP JSON fixture digest was supplemented post-test, with mtime predating the
baseline. Parent WSS/tools edits occurred outside that PG closure. Only the
unrelated relayer stream store changed during CLI compilation; the scraper files
and service entry point stayed stable. This is not a globally frozen worktree or
a clean-commit build claim.

The process-only run uses a second fresh database, repeats all 21 migrations and
five independent SQL smoke checks; it explicitly does not rerun the native suite.
Ten full-suite skips are explicit optional H2, Aleo and external crypto fixtures,
not silently counted as passed. Source NULL metadata, cooperative indexing and
native healthy-ninth proof artifacts remain preserved separately as well.

`paired-command-plan.json` prepares five alternating Rust/Zig pairs for each
release mode, sequential Safe then Fast, using the final build-matrix binaries
and matched PostgreSQL 16.15. **Not executed.** Refresh resolved paths if the final
matrix changes; require parent confirmation of completed builds/global quiet.
No timers, Cargo builds or benchmark workloads were run while preparing this plan.
