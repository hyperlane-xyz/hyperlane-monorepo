# Native operation row reader

The standalone Rust reader and actual Zig storage interoperability checks passed. This validates a stopped public fixture’s storage format and read-only behavior. It gives no chain, SDK signature, finality, delivery, or elapsed 600-second acceptance credit.

The exact evidence is in [the archive manifest](../../zig/bench/results/final-publication-overlay-20261107/06/canonical.json.gz), with [decoded-byte verification](../../zig/bench/results/native-row-reader/verification.json). The archive contains source snapshots, commands, logs, dependency normalization, failed attempts, final results, and the independent review. Executables, database files, WALs, and build caches are not copied into this packet.

| Check                                        | Result                      | Scope                                                                                                                               |
| -------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Build-helper pure controls                   | 5 passed                    | Bounded lock restore, pinned versions, offline plan and privacy constraints                                                         |
| Rust tests                                   | 9 passed                    | 8 substantive cases plus the subprocess helper; actual RocksDB writer lock refusal and stopped read-only byte invariance            |
| Offline release build                        | Passed                      | Exact normalized lock; existing RocksDB/Snappy archives reused                                                                      |
| Package Clippy                               | Passed                      | All targets, no dependencies, warnings denied                                                                                       |
| Actual Zig writer → independent Rust readers | Safe and Fast passed        | Production `Store`/`Operation` persistence; both complete identity widths, large u256 amounts, current-identity expenditure markers |
| Actual Zig read-only reopen                  | Both modes passed           | Same row, context, generation, authority, intent and signed bytes; no broadcast                                                     |
| Database byte preservation                   | 10 files per mode unchanged | After the old oracle, across the new reader, negative controls, Zig read-only reopen and repeat read                                |
| Independent review                           | No component blocker        | Reader, writer, orchestration, current source hashes, products and database readback                                                |

The nine Rust harness cases are not nine independent feature counts: one case is the child-process entrypoint used by the live-writer test. Correctness build durations in the raw records are not cold-build benchmarks.

## Reader contract

[`ziggy-native-rows`](../../zig/reference/native-rows/README.md) takes a strict JSON request, with explicit origin namespace, domains, operation IDs, nonces, kinds, targets and nullable expected contexts. It rejects duplicate JSON keys, unknown fields, malformed paired signed fields, invalid identity lengths, and row/intent authority mismatches. Bounds are 256 operations, 1 MiB request, 64 MiB per row, 2 MiB intent, 16 MiB authorization/signed fields, and 256 MiB total rows.

The output retains the full 32-byte hash or 64-byte signature identity and safe authority fields. It reports length and SHA-256 of the actual row, stored canonical intent and signed bytes. It never emits private authorization, intent payload or signed bytes. An absent expenditure remains unknown; a present zero marker is distinct. Expenditure decoding checks the identity and little-endian u256 values.

A null requested context produces `expected_context_checked: false`. This is an observed, length-validated context, not independent verification of the configuration hash. A family verifier must bind protocol, mailbox, chain ID, origin hook, signer authority and actual chain evidence independently, then pin context, generation, identity and stored-byte digests across restart. The reader does not recanonicalize arbitrary intent payloads or validate SDK signatures.

The reader acquires a POSIX shared lock on the existing RocksDB `LOCK` before opening the database read-only. The actual Zig writer test proves refusal while the writer owns the database. Family verification must additionally wait for and reap every role process; a successful lock is not a replacement for the stopped-parent receipt. Run the immutable old canonical oracle first, wait for it, then the new reader sequentially. The old oracle opens RocksDB for writing and cannot share the lock with this reader.

## Actual interoperability

The fixture writes two canonical public messages through production APIs. It persists real `Prepared` authority, a dummy private authorization, signed tuples of both widths, and idempotent large-u256 payment/expenditure records. The signature fixture has different 32-byte halves, detecting truncation. It uses the unchanged 600,000 ms policy with a synthetic confirmation clock; zero elapsed hold is credited.

The Python driver first requests the reader while Zig holds the database, requires lock refusal, then explicitly releases and reaps Zig. It runs the existing canonical Rust oracle and immutable Rust message vectors before the native reader. Wrong context and nonce fail closed; a missing ID stays absent and incomplete. An actual read-only Zig `Operation` reopen must preserve the signed bytes and all public readback fields. Plaintext and hex forms of the private fixture sentinels are forbidden in every runtime report.

The reader executable is 6,804,512 bytes, SHA-256 `0ca2617d7841edb7cabb714a0bf1f501e461da584f62c1778d0418659b578b91`. The old canonical oracle remains `8e295002b44b4248d00d6627aaa47a212315f6f837f3a2d652f2e7f6ada69fd9`; Rust message vectors remain `de1a7ce2afa16e1c527fe875082bff280868bfadaaa5c3088aeef277e5b5c52e`. Exact local artifact paths and both writer hashes are retained in the final result.

## Dependency and diagnostic provenance

The standalone crate uses cached versions from the existing Rust lock: RocksDB 0.24.0, serde 1.0.228, serde_json 1.0.151, sha2 0.10.8 and libc 0.2.189. Offline Cargo metadata pruned the provisional 87-package graph to 65 packages, including the new root. Every selected registry version and checksum matches the baseline. No Hyperlane production crate or old oracle source changed. The compile plan reused the approved RocksDB/Snappy archives, rebuilt matching codec dependencies, and enforced a dedicated target, two jobs, 2 GiB target cap and 6 GiB free-space floor.

The initial tests and release build passed. Initial package Clippy found two local style issues; both were corrected without lint allowances, and tests, release and Clippy passed again. The first actual interoperability attempt correctly refused the live writer but the old oracle rejected fixture namespace `nativeorigin`. The fixture was changed to its existing recognized `test1`/`test2` namespaces; neither oracle changed. Both failed packets remain intact.

The README was updated after acceptance to replace its stale source-only status. Its before/after hashes and docs-only qualification are preserved. Compiled reader code, lock and helper remained unchanged. The independent review rehashed all 12 current component and dependency paths after that documentation update.

These are component checks. Actual family adapters still need independent signer/authority, broadcast-wire, canonical receipt, checkpoint, SQL, restart and elapsed-confirmation evidence before end-to-end acceptance.
