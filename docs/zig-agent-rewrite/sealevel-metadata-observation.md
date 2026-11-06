# Sealevel composite metadata observations

Component verification, 2026-11-06. This does not close the global native test,
role compilation, source freeze or benchmark gates. Reproduction commands,
compressed logs and source hashes are in
`zig/bench/results/sealevel-metadata-observation/manifest.json`.

Rust `agents/relayer/src/msg/metadata/sealevel_composite.rs` builds inline
message-ID multisig leaves through `build_from_known_validators` in
`multisig/base.rs`. That path preserves the root application context and updates
ISM build metrics; the message-ID builder concurrently fetches a quorum and
observes latest indices for the complete configured validator set. The native
composite path previously created a standalone leaf builder without those
production observation/executor bindings.

Sealevel's inline interpreter now delegates each known-validator leaf to the
actual forkable native source and common metadata builder. The delegate carries
the global executor, production observation binding and already resolved root
application context. Module type and members come from the decoded inline leaf;
no additional ISM simulation or contract address conversion is fabricated.
Persistent leaf jobs retain their own read continuations across pending I/O.
Normal builder visit memoization records one latest job and one terminal ISM
result for each logical leaf, including when quorum reads resume repeatedly.

Native source forks own copied inline validator arrays. They also retain the
active business operation's cancellation ancestry and release it during fork
teardown. Scoped adapters borrow only during their call; persistent jobs never
retain a pointer to the scoped adapter or decoded spec arena. Latest observation
jobs own their configured validators/context and a separate read fork. They
explicitly drop business ancestry and use the executor lifetime stop token, so a
completed or canceled metadata operation cannot poison a later observation.
Global shutdown cancels these jobs before releasing borrowed history,
transports or metric owners. No new worker, Pool or transport runtime was added.

Native cached-source selectors also obtain a fresh post-fetch default-ISM cache
clock from the source. It uses the same raw monotonic Instant epoch as
Factory.active_cache_ms, preserving the complete TTL after a successful fetch
without retaining a caller clock pointer or performing additional I/O.

The active-cancellation regression exposed a shared nested-assist defect:
a waiting caller could execute the outer composite job and stop polling its
original cancellation flag while an inner builder waited. Retained cancellation
links now let descendant operations poll their ancestors, while stopping the
ancestor detaches its borrowed caller flag under a lock. The old regression
failed its two-second cancellation bound; the corrected native path passes.
That failed log is retained as diagnostic evidence, not a timing benchmark.

| Verification                                                                   |                                                                        Result | Evidence                                       |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------: | ---------------------------------------------- |
| SVM native-enabled metadata/provider/parser suite                              | 22 passed, 0 skipped (14 substantive cases, including 4 new native scenarios) | `svm-focused-final.log.gz`                     |
| Nonnull-link allocation-failure sweep, per-invocation balance and root release |                                                           7 passed, 0 skipped | `fork-link-oom-final.log.gz`                   |
| Earlier native subset, before final allocation-refcount assertion              |                                                          11 passed, 0 skipped | `native-subset-before-final-ref-assert.log.gz` |
| Initial active-cancellation regression                                         |                              Failed before retained ancestry; diagnostic only | `active-cancel-before-link.log.gz`             |

The production fixture returns a real nested MetadataSpec over loopback SVM
`simulateTransaction`, then executes the actual native source and production
Registry. Two identical configured multisig leaves are separate logical leaves.
After twenty pending quorum reads, each records exactly one successful ISM
build. Each detached latest job receives all three configured validators and
writes indices 7, 9 and -1 under `root-classified-app`, excluding a deliberately
incorrect stack fallback context. The test holds latest reads pending until
metadata has returned and its caller is canceled, then proves publication and
retirement still complete.

Additional cases shut down while latest jobs remain pending; cancel nested
metadata while quorum jobs are suspended; assert no fabricated completion
metrics on cancellation; check empty retained-output/shared-read budgets; and
exercise every allocation failure during a native inline source fork, including
retained ancestry reference balance after every failure/success and the final
root release to zero. The
broader suite retains non-Null selection priority, late reorg refusal, parser
bounds, existing inline continuation behavior and provider schema checks.

Only public local fixture keys and loopback responses were used. Origin storage
is an injected public checkpoint/latest-index fixture; this suite does not claim
a new production object-store or mainnet run. The global origin-engine tests
cover its shared remote storage implementation separately.
