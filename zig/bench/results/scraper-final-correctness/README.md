# Final protocol/scraper integration acceptance

Correctness validation; no matched timing benchmark, production reads, keys or broadcasts.

- Full native PG suite: **361 passed,10 optional skipped,0 failed** (371 total), PostgreSQL16.15,21 actual Rust migrations,11 functional cases. Includes source NULL-transaction metadata, client deadlines/cancellation, session-timeout initialization/reconnect, healthy ninth behind eight stalled RPCs, receipt quota cleanup and the replacement for the earlier metadata fixture retirement failure.
- Compressed SDK fixtures: **62 passed,2 optional skipped,0 failed**. Fixtures preserve exact SDK bytes and parser number/string ownership behavior.
- Fresh ReleaseSafe scraper process: five event/link counts2→3 across restart; four concurrent receipt jobs/domain; successful neighbor linked while one hash stalls; eight stalled head owners leave healthy ninth progressing; metrics GET/HEAD200; SIGTERM/SIGINT drain; published reorg halts all lanes with exit1 and preserves all3 published rows.
- Process-only runner creates its own second disposable database, reapplies21 migrations and runs5 SQL smoke cases. It intentionally does not claim to execute the native suite again.

The head-owner fixture observed242ms for the healthy ninth,22384KiB process RSS and66 threads, including9 lazy1MiB head-owner stacks and8 supervisor workers. Signal drains were9/12/29ms; fatal-fork exit314ms. These are local correctness/liveness observations, not throughput or Tokio resource-equivalence claims.

## Reproduce

```sh
HYPERLANE_CURL_LIBRARY=/usr/lib/libcurl.4.dylib python3 zig/integration/postgres.py \
  --compiler /tmp/ziggy-toolchain/zig-aarch64-macos-0.15.2/zig \
  --sdk-root /Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk \
  --output /tmp/NEW-native-pg

/tmp/ziggy-toolchain/zig-aarch64-macos-0.15.2/zig test zig/src/root.zig -lc \
  --sysroot /Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk -L/usr/lib \
  --test-filter fixture

python3 zig/integration/postgres.py --process-only \
  --scraper-binary /tmp/ziggy-scraper-final-integration/scraper \
  --output /tmp/NEW-scraper-process
```

All databases are fresh, guarded, task-owned Docker containers on dynamic loopback ports and removed afterward. Native migration executable was preserved during authorized checkout cache cleanup; no Cargo/SDK rebuild was run.

## Provenance

`acceptance.json` identifies Git HEAD, compiler0.15.2/SDK15.4, libpq and migration executable, exact scraper binary SHA256, complete file hashes, and source snapshots. All136 protocol/scraper ownership files and the186-file conservative PG import/embed closure were stable across validation. Raw immutable CCIP JSON fixture hash was supplemented after the test; its modification time predates the baseline snapshot.

The shared checkout was not globally frozen: parent WSS/tools files changed outside the PG closure. Only the unrelated relayer stream store changed during the fresh CLI compile; scraper ownership and service entry point remained unchanged. The binary digest identifies the exact executable accepted here. Global before/after source hashes and these qualifications are retained, rather than claiming a clean committed snapshot.

`postgres/` contains the consistent full native suite; `process/` contains the fresh-binary process run. Earlier failed or pre-fix artifacts remain separately preserved.
