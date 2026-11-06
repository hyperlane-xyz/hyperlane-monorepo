# Scraper final validation and measurement plan

[Preserved functional results](../../zig/bench/results/scraper-final-functional/README.md)
contain the consistent full native PG suite: **361 passed, 10 optional skipped,
0 failed**, PostgreSQL 16.15, all 21 production migrations and 11 functional
cases. This suite includes the earlier discovery/retirement failure's replacement,
source NULL-transaction metadata, bounded PG reconnect/cancellation/deadlines,
new-session timeout defaults, receipt quota cleanup, healthy ninth behind stalled
peers and metadata/CCIP retirement. The gzip fixture pass is **62 passed, 2 skipped**.
Optional H2, Aleo and external crypto cases remain skips in this run; their earlier
separate proof artifacts are retained and are not relabeled as executed here.

The rebuilt actual scraper passed production-Solidity/Anvil/PG process acceptance:
all five stored/link counts 2→3 on restart; four receipts/domain, successful
neighbors persisted while one request stalled, eight stalled head owners with a
healthy ninth progressing, metrics GET/HEAD, signal drain and fatal published-fork
halt preserving rows. It uses lazy retained head-owner threads: nine 1 MiB head
stacks plus eight supervisor workers were among 66 observed process threads.
The local fixture observed 22,384 KiB RSS; this is neither matched performance nor
resource equivalence to Tokio.

Source identity is explicit in the compressed acceptance/source manifests and
readable chunked summary. The 136-file protocol/scraper subset and PG import
closure stayed stable. One raw immutable fixture hash was supplemented after the
test. Parent WSS/tools edits outside the PG closure and one unrelated relayer
store edit during CLI compilation are disclosed. The accepted binary's digest
identifies exactly what executed; these results do not assert a globally frozen
or clean committed tree. No production network, database, key or transaction was
used. The second process-only database run has five SQL smoke checks and does not
claim to execute the native tests again.

## Pending matched runs

[Prepared commands](../../zig/bench/results/scraper-final-functional/paired-command-plan.json)
resolve the current matrix's Rust, ReleaseSafe and ReleaseFast scraper binaries.
The matrix must finish successfully first. If its final cache path changes,
refresh these paths against the actual artifact manifests before execution.
Parent coordinates global compiler/profiler/test quiet; Safe and Fast run
sequentially, each with five pairs alternating Rust/Zig then Zig/Rust. Five pairs
imply a disclosed 3/2 first-position split rather than perfectly equal ordering.

Both modes use PostgreSQL `postgres:16.15`, 21 unchanged migrations, 100 catch-up
message groups, ten fresh groups every 250 ms, one restart group, chunk50,
one-second indexing interval, one RPC endpoint, single consensus, zero reorg
period, three DB connections and the same metrics port after restart. Receipt
stall checks stay enabled. Message inputs/IDs, event sequence and arrival policy
match; separately mined wall-clock timestamps/block hashes may differ and are
validated against each actual trial chain. No mode may skip receipt enrichment
or use the provisional metrics-port-reallocation workaround.

The harness pins executed binaries and records source inventories, method-level
daemon RPC counts separately from fixture RPC, CPU user/system, peak RSS,
catch-up/fresh distributions, signal and restart results. Compare the same Rust
binary across both modes and retain every failed trial. Fresh process/database
does not imply cold filesystem/native libraries; build times belong to the
separate cold/no-change matrix. Earlier nonquiet regressions and intrusive SQL/
CPU samples remain visible; the 494→8 timeout-setting SQL reduction is an
attribution observation, not a matched speedup. No final paired run has executed.
