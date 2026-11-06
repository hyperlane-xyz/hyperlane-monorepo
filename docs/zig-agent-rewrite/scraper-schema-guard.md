# Scraper startup catalog guard

Scraper startup now refuses incomplete or mismatched frontier indexes before creating any chain lane. This closes the implemented Rust startup contract identified in the [initial completeness audit](../../zig/bench/results/scraper-schema-guard/initial-missing-guard-audit.md.gz).

Rust calls `verify_frontier_indexes` before building scrapers. The native [verifier](../../zig/src/db/scraper_schema.zig) preserves its exact checks: the canonical gas-payment identity index, three valid/ready frontier indexes with their expected definitions, and absence of the obsolete transaction-scoped gas index. The [authoritative Rust implementation](../../zig/bench/results/scraper-schema-guard/rust-source/indexes.rs.gz) is retained. Production verification uses only `SELECT`; index repair remains an explicit `init-db` operation.

[TaskSet.open](../../zig/src/agents/scraper/task.zig) acquires one real DB lease after its resolver is stable and verifies the catalog before constructing lanes. One absolute deadline covers acquisition, connection/session setup and all five queries. [The process entrypoint](../../zig/src/service_main.zig) supplies startup signal cancellation. The constructor checks it before initialization and before returning, clears the borrowed pointer from retained options, and releases the lease before lane construction. Constructor failure stops and joins constructed owners before destroying their borrowed state.

## Accepted checks

| Check                            | Passed | Skipped | Failed | Evidence                                                                                                                                                                                                                                          |
| -------------------------------- | -----: | ------: | -----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focused guard root               |     14 |       0 |      0 | [Log](../../zig/bench/results/scraper-schema-guard/focused-canonical/tests.log.gz), [commands and selected hashes](../../zig/bench/results/scraper-schema-guard/focused-canonical/result.json.gz)                                                 |
| Current PostgreSQL aggregate     |    437 |       0 |      0 | [Log](../../zig/bench/results/scraper-schema-guard/aggregate-accepted/postgres/postgres-integration.log.gz), [command, explicit environment overrides and hashes](../../zig/bench/results/scraper-schema-guard/aggregate-accepted/result.json.gz) |
| Production migration application |     21 |       — |      0 | [Integration result](../../zig/bench/results/scraper-schema-guard/aggregate-accepted/postgres/postgres-integration.json.gz)                                                                                                                       |
| Persistence functional cases     |     11 |       — |      0 | Same integration result                                                                                                                                                                                                                           |

The focused root contains ten substantive declarations and four import roots. Its actual PostgreSQL cases cover all four missing indexes, eleven mismatched definitions, eight invalid/not-ready states and obsolete-index presence. Fixture-only catalog mutations are rolled back in the disposable database. The valid catalog also passes inside a read-only transaction without changing definitions or scraper-head rows.

Actual constructor tests cover valid startup, committed missing/obsolete-index rejection, pre-cancellation, cancellation and expiry while a separate connection holds the catalog lock, and cancellation after successful verification but before returning. They assert no late RPC or lane DB effects. Successful startup retains no startup token, holds no lease and leaves chain resources lazy. The older lazy-DB fixture now uses the actual isolated DB and expects the single startup connection; its independent lane and pre-cancellation assertions remain.

Both accepted roots exited zero. The final aggregate kept fourteen selected source inputs unchanged, including both fixture generators, metadata tests and runner helpers. Fourteen matching current source captures are archived. The focused proof predates the separately owned metadata assertion correction; the fresh aggregate covers that correction. Roots overlap and must not be summed as unique project coverage.

## Retained diagnostic stages

| Stage                                       |  Passed | Failed | Qualification                                                                                                      |
| ------------------------------------------- | ------: | -----: | ------------------------------------------------------------------------------------------------------------------ |
| First focused run                           |   10/14 |      4 | Test helper supplied JSON instead of the CSV custom-RPC override string.                                           |
| Second focused run                          |   13/14 |      1 | Expected four lanes; the committed Ethereum fixture also enables CCR.                                              |
| Earlier focused pass                        |   14/14 |      0 | Passing guard snapshot before the existing fixtures were updated.                                                  |
| Initial PostgreSQL aggregate                | 433/435 |      2 | Old fixture expected no startup DB connection; metadata fixture rejected an accepted socket closed before headers. |
| PostgreSQL before metadata count correction | 437/437 |      0 | Passing snapshot before the independent physical-read-count assertion correction.                                  |

These stages remain lossless in the [archive manifest](../../zig/bench/results/scraper-schema-guard/manifest.json). The old metadata test bytes match their recorded hash and remain under `source-after`; current accepted inputs are under `source-accepted`. Four pre-guard existing files were reconstructed by reversing only this change and matched exactly to the recorded 09:33 Safe hashes. This proves those file bytes, not an unrecorded full-tree snapshot.

The later metadata fixture correction and its four-mode proof are owned by the [separate metadata review](../../zig/bench/results/metadata-fixture-preheader/). No metadata production behavior changed for this guard.

All SQL tests used fresh, task-owned PostgreSQL 16.15 instances on dynamic loopback ports, initialized by the existing Rust migration binary and removed afterward. Existing native libraries were used. No Rust/C/SDK rebuild, agent role, image build, production RPC or benchmark was run. Final whole-source, emitted-artifact and cross-platform acceptance remain separate.
