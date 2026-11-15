# Combined production correctness

Production commit `f665e447eec043e4af8783c64dba5f56c6eb46a5` passed two role/worker correctness builds and 20 functional gates. The [evidence packet](../../zig/bench/results/combined-production-correctness-f665/README.md) preserves every attempt, exact commands, source snapshots, logs, product pins and final readback.

The production commit contains the optional Sealevel CCS fix, validator startup metadata and required URL library, configured RPC transport, Starknet chain-ID discovery, and Sealevel scraper event positions. The PostgreSQL fixture changes were separate, uncommitted harness bytes during these runs. This is a correctness checkpoint, not completion of the rewrite.

| Check                                           | ReleaseSafe                                        | ReleaseFast                                        |
| ----------------------------------------------- | -------------------------------------------------- | -------------------------------------------------- |
| Validator, relayer, scraper, Aleo worker builds | Four fresh products                                | Four fresh products                                |
| Default aggregate                               | 752 passed, no skips                               | 752 passed, no skips                               |
| Native RocksDB aggregate                        | 1,116 passed, one permitted skip                   | 1,116 passed, one permitted skip                   |
| PostgreSQL aggregate                            | 441 passed; 21 migrations; 11 functional cases     | 441 passed; 21 migrations; 11 functional cases     |
| Actual new scraper process                      | Passed on disposable PostgreSQL and Anvil/Solidity | Passed on disposable PostgreSQL and Anvil/Solidity |
| Role help                                       | All three passed                                   | All three passed                                   |
| RPC producers                                   | 411 passed                                         | 411 passed                                         |
| Operator regex                                  | 56 passed                                          | 56 passed                                          |
| WebSocket/TLS                                   | 22 passed                                          | 22 passed                                          |
| Socket owner                                    | Four passed                                        | Four passed                                        |

These counts include overlapping imports. They must not be summed as unique tests. All 41 required cases covering the five fixes and URL behavior ran successfully in both native aggregates. The sole skip was `opt-in loopback prepares actual repo Solidity without delivery or nonce mutation`, which requires a separate Anvil fixture. No SDK, URL, HTTP/2 or RSA fixture was missing.

## Exact acceptance and preserved failures

The 20 gates are a verified rollup across four immutable attempts, not one uninterrupted run:

- **v1:** Safe default passed. A monitor raced deletion of a temporary RocksDB `IDENTITY` file during native tests. A secondary cleanup `EPERM` masked that primary error in the live manifest. The diagnostic readback preserves both observations; the interrupted native run gets no credit.
- **v2:** Safe native passed. PostgreSQL stopped before migrations or tests because the wrapper expected legacy `--tmpfs` mounts in Docker's `Mounts` array. Ownership-label checks passed and the exact owned container was stopped. This PG attempt gets no credit.
- **v3:** Eight remaining Safe gates and Fast default/native/PG passed. Fast validator help exited zero, then the idle guard observed an unrelated Tollkeeper compiler. That help attempt gets no credit.
- **v4:** The final seven Fast gates passed. The unrelated workspace compiler remained untouched. Its PID, process identity and system-load observations were captured under an explicit correctness-only concurrency qualification.

The fixed monitor ignores only files already removed during sampling. Permission and symlink violations still fail. Cleanup retains the primary failure, binds PID/start/PGID provenance, and checks live owned members before a late signal. All owned processes joined.

The Docker wrapper uses a fresh ownership-token label and verifies CID, label, name and image before operations or cleanup. Sixteen pure mock controls cover foreign-name/label/image conflicts and mount-proof negatives. Both real PG runs retained raw kernel mount evidence proving the exact PGDATA target was tmpfs with a 2 GiB limit. Actual container limits were two CPUs, 1 GiB RAM, 1 GiB combined RAM/swap, and 256 PIDs. Both containers stopped successfully.

## Source and evidence boundary

All four attempts used identical 739-file physical source maps. The 597-file production build closure, including 34 embedded assets, matched f665. An exact byte snapshot was captured before later case-harness edits. The broader map also contains uncommitted fixtures and helper code; it is not all committed production source.

The unused parameter-provisioning Python CLI and its test were explicitly excluded. Nine existing parameter files, all five required Rust DSOs, seven native archives, 64 preserved products and eight new role/worker products were hashed around execution and rechecked at closeout. Each mode used its newly built worker. System curl came from the macOS dyld cache; the records do not invent a regular-file hash for it.

The packet contains source and small evidence files only. Runtime binaries, databases, parameter bundles and caches remain outside it. The build and gate resource observations are operational guards, not performance results. This checkpoint grants no eight-family native-node acceptance, elapsed 600-second proof, image acceptance, cold-build measurement or paired-benchmark result. Earlier build-matrix measurements remain historical. Later timed runs require fresh quiet coordination; the external-compiler qualification does not carry forward.
