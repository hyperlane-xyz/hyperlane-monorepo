# General fallback owner recovery — final Source release

Normal EVM/SVM fallback now reaches a healthy second peer after a physical timeout while its owner still has budget, including sequential methods on a configured hedged Pool.

Recorded write scope: evm/pool.zig and provider.zig; sealevel/provider.zig; relayer/evm_source.zig; agents/origin_signer_source.zig; agents/scraper/receipts_{evm,cosmos,sealevel}.zig; agents/relayer/{rpc_budget,public_relay}.zig; NEW rpc_fallback_owner_{testing,tests}.zig. Ten production files plus two new test files. Parent owns chain_source integration and permanent imports; protocol owns the separate HTTP/signing correction. net/read_replay production is unchanged.

Rust Ethereum fallback tries the next provider after a retryable physical timeout; its HTTP client bound is 60s. Sealevel uses the generic fallback with a 30s per-provider bound. The native physical 20s knob differs; this correction restores remaining-peer budget rather than claiming matching timeout values or performance. Exact Rust/native paths are retained in the [initial Source audit](../../zig/bench/results/rpc-fallback-owner-recovery/initial-source-audit.md.gz).

## Result

Normal Resources fallback now gives each request-level sequential endpoint its configured physical limit (default 20s) while the logical operation/retained replay owner supplies the aggregate budget (default 120s). Explicit hedge delay and hedgeable-request attempt limits retain authority: configured 30s is not min-clamped to ordinary 20s. Non-hedgeable methods on that same Pool use sequential 20s. No hedge is enabled by this correction.

[Provider.Options](../../zig/src/evm/provider.zig).owner_deadline_ns is optional, value-owned, absolute monotonic, and DIRECT-exchange-only. Parent's direct fallback exchange intersects it with Resources.rpc_deadline_ns, HTTP owner and the bounded per-call ceiling; controls are checked before/after and late returned bytes are freed on failure. Actual shorter client-only scopes publish their fixed deadlines and restore saved state. Cooperative ReadReplay retains its existing absolute started/max_attempt/cancel lifetime, rather than using transient direct callback metadata. EVM metadata read forks select owner-budget replay for capped fallback Pools and clear inherited direct-only deadline metadata.

Raw Pool null-cap defaults, single/quorum policy, direct-native chain votes, parser/revert/method classification and raw request identity remain unchanged. No new production allocations, worker or Pool.

## Actual timeout-writer audit

| Actual scope                    | Existing clock                               | New binding                                                                                               |
| ------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| SVM Client.call                 | Client.deadline_ns                           | Earliest inherited/current Options owner deadline, saved Options restored                                 |
| EVM/Cosmos/SVM receipt helpers  | Supplied absolute receipt deadline           | Options earliest deadline; existing timeout clamps/restores retained                                      |
| EVM/Cosmos origin signer lookup | Existing UTC-budget→monotonic conversion     | Options earliest actual fetch deadline; SVM uses Client.call                                              |
| Protected estimate              | Existing relative Scope timer                | Fixed absolute deadline sampled before timer start; per-call bounded Options; original transport restored |
| Public relay extraction         | Existing timer started before admission lock | Fixed absolute deadline includes lock wait; caller Options restored                                       |
| EVM metadata child              | Fresh retained read owner                    | Capped-fallback owner mode selected; direct-only parent deadline cleared                                  |

All production RpcClient.Options.timeout_ms writers found by rg are deadline clamps covered above. Provider native-cache remaining-budget calculations and validator test timeout overrides use direct-native paths, outside the normal Resources Pool opt-in. No additional actual physical-only override path was found that would be silently ignored by the immutable producer cap. HTTP, worker/prover and cloud timeout fields are different boundaries and were not changed here.

## Recorded tests

| Root                           | Passed | Failed | Skipped |
| ------------------------------ | -----: | -----: | ------: |
| New fallback owner root        |     15 |      0 |       0 |
| Existing native Pool           |     86 |      0 |       0 |
| Producer/header/replay focused |     37 |      0 |       0 |
| Receipt aggregate              |    367 |      0 |       9 |
| Origin HTTP/native             |     19 |      0 |       1 |
| Public relay aggregate         |    428 |      0 |      10 |
| Protected RPC budget root      |     55 |      0 |       0 |

The new root has nine substantive declarations and six import/root smoke declarations. Its live matrix uses actual Resources.open and production RPC clients: direct/cooperative default EVM, SVM and non-hedgeable eth_call under configured hedging. Each first endpoint accepts the request and stalls for the full configured 20s before healthy B answers. The immutable hedge case configures 30s and delays B's reply 21s, proving that generic 20s did not replace 30s. Exact underlying A/B request bodies/IDs are checked.

Actual direct Options-only Clock and retained replay clamp/expiry, precancel and accepted-request cancellation cases keep sequential B uncalled. Cooperative cases deliberately carry expired DIRECT-only metadata and still retain their own valid owner. Additional cases cover metadata-fork configuration/lifetime, real short protected estimate Clock and restoration, structured nonretryable eth_call envelope/bytes without B, and unchanged single/quorum/independent-native vote construction.

All seven commands exit 0. Fourteen selected Sources match before/after all seven runs and the archived captures. These are separate roots sharing imports, not a unique project-wide total. Origin's one optional HTTP2 fixture skip and receipt/public optional environment-dependent skips remain explicit; their optional coverage is not inferred. Existing allocator/identity/cancellation regressions pass. Native sessions, bytes and existing child/Pool lifetimes remain owned by their original mechanisms.

## Evidence and limits

[Exact commands/environment](../../zig/bench/results/rpc-fallback-owner-recovery/commands.json.gz), [results and before/after selected hashes](../../zig/bench/results/rpc-fallback-owner-recovery/result.json.gz), [archive manifest](../../zig/bench/results/rpc-fallback-owner-recovery/manifest.json) and [selected source captures](../../zig/bench/results/rpc-fallback-owner-recovery/source-status.json) preserve the proof. Historical 9/14 stages remain separate. Current bytes were archived only after matching all 14 recorded hashes.

| Raw root log              | Artifact                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| New fallback owner 15     | [focused.log.gz](../../zig/bench/results/rpc-fallback-owner-recovery/focused.log.gz)           |
| Pool 86                   | [pool.log.gz](../../zig/bench/results/rpc-fallback-owner-recovery/pool.log.gz)                 |
| Producer/header/replay 37 | [producers.log.gz](../../zig/bench/results/rpc-fallback-owner-recovery/producers.log.gz)       |
| Receipts 367/9            | [receipts.log.gz](../../zig/bench/results/rpc-fallback-owner-recovery/receipts.log.gz)         |
| Origin 19/1               | [origin.log.gz](../../zig/bench/results/rpc-fallback-owner-recovery/origin.log.gz)             |
| Public relay 428/10       | [public-relay.log.gz](../../zig/bench/results/rpc-fallback-owner-recovery/public-relay.log.gz) |
| Protected 55              | [protected.log.gz](../../zig/bench/results/rpc-fallback-owner-recovery/protected.log.gz)       |

Canonical gzip preserves exact original bytes. Exact-path ignores cover only the two raw command/result convenience mirrors inside this artifact directory. Normal hooks and global ignore/provenance files are unchanged.

[Independent read-only review](../../zig/bench/results/rpc-fallback-independent-review/README.md). Reviewer recalculated all 14 current/before/after hashes, inspected actual Source paths and seven accepted logs, found no unresolved scoped blocker, and ran no builds/tests/Source edits.

No SDK/Rust/C rebuild, role, Docker image, production endpoint or benchmark run. Full native/SDK/global Safe/Fast and final emitted artifact acceptance belongs to Parent and remains separate. Actual 20/30-second cases are functional liveness proofs, not CPU/RSS/throughput measurements. No performance ratios or whole-agent speedup claim follows from them.
