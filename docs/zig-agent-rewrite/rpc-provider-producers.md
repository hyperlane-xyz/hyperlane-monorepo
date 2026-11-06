# RPC provider producers and indexer tip cache

Component verification, 2026-11-06. This is not final rewrite acceptance or a
performance benchmark. Raw evidence and source hashes are in
`zig/bench/results/rpc-provider-producers/manifest.json`.

The native provider now produces the Source-active endpoint lifecycle, fallback
hedge and indexer request-cache metrics. Source references are
`rust/main/ethers-prometheus/src/json_rpc_client.rs` and
`rust/main/chains/hyperlane-ethereum/src/rpc_clients/fallback.rs`; concrete
indexer builders opt into caching while ordinary providers default off.

| Area                      | Native behavior                                                                                                         | Boundary                                                                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider create/drop      | Balanced events for successfully constructed owned endpoint wrappers, dropped after worker/native drain                 | Rust clones can count additional objects; borrowed native pointers do not fabricate owners. No Source Radix lifecycle producer was found.                  |
| Hedge events              | Eligible configured immutable reads emit start, timeout, cancellation, primary/hedge winner and one terminal duration   | Primary attempts can be canceled too. Caller cancellation has no completed hedge duration. `eth_call`, tip reads and multicast stay outside this producer. |
| Dynamic indexer tip cache | Per concrete endpoint, successful insertion TTL of 250 ms; bounded entries/bytes/followers; one shared role-owned cache | Explicit per-request opt-in. Fresh checkpoint/quorum votes, health, metadata and pinned reads bypass it. No process-global cache.                          |
| Singleflight              | Concurrent endpoint reads share a successful leader; caller IDs are rebuilt independently                               | Leader failure/cancellation releases followers to retry independently. No I/O under cache mutex.                                                           |
| Physical request metrics  | Count actual HTTP completions                                                                                           | Cache hits and cooperative pending-I/O resumes add no physical completions.                                                                                |

`eth_blockNumber` keys ignore serialized params as Source does.
`eth_getBlockByNumber` caches only `latest`, `safe` and `finalized`, with the
complete serialized params in its key. Endpoint identity includes sensitive URL
and headers internally; metric labels expose only host labels. Nullable blocks
are successful cacheable results. HTTP 429 is rejected before body decoding,
including for aging probes. A rejected probe retains the old block height, resets
its failed count/block-age clock and demotes the endpoint, matching Source's
failed-probe branch. Physical observation is failure and the response is uncached;
the local `probe_succeeded` event denotes completion of the non-timeout probe
path, not transport success.

Ethereum transport follows Source's status-aware JSON-RPC policy. HTTP 429 is
rejected after the complete response head, before reading its body; other HTTP
statuses still decode valid results and structured JSON-RPC errors. This applies
to Pool requests, aging probes and direct native/standard Ethereum clients. A
valid HTTP 500 tip result is a semantic physical success and can populate the
indexer cache. HTTP 500 revert data remains available to EIP-3668 OffchainLookup
consumers; remote errors count as physical failures and stay uncached. HTML,
malformed JSON-RPC and invalid quantities remain failures on every HTTP status.

Native curl uses an Ethereum-only, default-off complete-head stop capability.
It retains final headers, including Retry-After, and exposes a synthetic empty
429 response only for the confirmed intentional callback abort. Intermediate
100/CONNECT heads reset correctly; other statuses do not activate the stop.
Cancellation, timeout, body/header limits, allocation failure and unrelated
write failures retain their original errors. Multi's response reservation is
released normally. The standard Ethereum path rejects after `receiveHead` and
before streaming the body. Shared HTTP replay identities distinguish this
capability. Other VM and credential/auth transport policies are unchanged.

Malformed upstream Ethereum JSON/envelopes now use a precise retryable
`RpcResponseDecode` boundary error on every HTTP status, and typed rate limits
retain their retry category. Arbitrary business/configuration parser errors
remain fatal. See [response recovery](rpc-response-recovery.md) for the preserved
validator regression, real native/standard Role backoff coverage and current
component matrix. Earlier component logs below remain historical snapshots.

An earlier iteration rejected all non-2xx Pool responses and described HTTP 500
rejection as hardening. That was incompatible with Source-supported provider
responses and CCIP-read revert data. It has been replaced by the Source policy;
its raw logs/manifests remain historical evidence, not current acceptance.

Ethereum header responses now validate the four fields consumed by indexers
before Pool success, votes and cache insertion. Present fee-quote fields also
validate. A persistent malformed preferred endpoint falls back to a healthy
neighbor; cache expiry alone previously left that endpoint blocking progress.
Direct native, standard and exchange clients use the same validation boundary.
See [typed header recovery](rpc-typed-header-recovery.md) for pending/null behavior,
tests and the Rust raw-Value fallback qualification. This improves availability;
it does not establish full typed-deserialization parity for every RPC DTO.

| Verification                                                   |                                                                   Result | Evidence                                  |
| -------------------------------------------------------------- | -----------------------------------------------------------------------: | ----------------------------------------- |
| Actual native provider integration after Source HTTP alignment |            23 passed, 0 skipped (19 substantive cases plus import roots) | `native-integration-source-status.log.gz` |
| Dedicated Pool regression after alignment                      |                                               85 passed, 1 optional skip | `pool-regression-source-status.log.gz`    |
| Native HTTP transport, bounds and allocation checks            |                                                                11 passed | `native-http-source-status.log.gz`        |
| Standard HTTP typed/envelope loopbacks                         |                                                                 4 passed | `std-http-source-status.log.gz`           |
| HTTP replay policy identities and route boundary               |                                                                 3 passed | `http-replay-source-status.log.gz`        |
| Prior isolated cache root                                      |                                                 6 passed, 2 native skips | `cache-unit.log.gz`                       |
| Broad transitive root                                          | Earlier interrupted metadata fixture run; no current complete-root claim | `transitive-interrupted-fixture.log.gz`   |

The integration cases cover eight callers across two Pools, exact IDs, expiry,
health/fresh bypass, direct native clients, null blocks and complete params,
leader/follower cancellation, follower deadline, HTTP status failure, invalid-node
fallback and fixed quorum denominator, hedge outcomes/nanosecond duration,
cooperative read resumption, aging probes and constructor failure. The probe
regression first accepts an HTTP 500 height 100, then receives a complete HTTP 429
head with a configured height 101 body that stalls after the head. It
asserts old-height retention, demotion, a failed physical observation, no cache
hit and no failed-response insertion. Additional cases preserve a full independent
Foundry OffchainLookup revert through Pool/native/standard HTTP 500, reject
malformed 500 and positive 429 bodies, verify valid 500 results/cache hits and
physical counts (including failed malformed/version/id envelopes), enforce other VM
status policies, and exercise stalled 429
bodies with 1 GiB advertised length and retained Retry-After headers. An immediate round first tries the newly
preferred endpoint, then falls back to the original without another probe,
proving the Source block-age clock reset. A separate shared-cache caller must
perform a fresh upstream read. The metadata
fixture subsequently received unique-child accounting and unconditional
cancel/join cleanup; a subsequent broad-root pass remains a shared integration
gate. The manifest preserves the interrupted run rather than replacing it with
a passing claim.

Reproduce the focused test using the manifest command/environment. Raw logs are
losslessly gzipped with deterministic metadata; each manifest entry includes the
uncompressed SHA-256 as two consecutive 32-character chunks. No timing numbers
from these concurrent component checks belong in the before/after benchmark.
