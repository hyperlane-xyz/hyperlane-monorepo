# Configured native RPC HTTP

The old Zig transport rejected configured HTTP RPC URLs for Radix, Tron,
Starknet and Aleo. Rust accepts these URLs, including the real local-node
fixtures. The first actual default-Tron request failed with `InsecureCloudUrl`
before reaching the owned native server.

`HttpTransport.configuredRpcInterface()` now grants configured RPC access through
a distinct function pointer. The ordinary cloud interface remains strict. Chain
Resources and Helius receive the RPC capability; credentials, signing, delegated
proving and CCS retain their existing cloud capability. No mutable owner-wide
policy flag enables HTTP.

Deadline transports retain the exact verified delegate. Verification clears any
previous delegate first and publishes the new one only after owner, function and
native-transport checks. An RPC read scope cannot upgrade a strict credential
handle. Existing cancellation, halt, minimum deadline, response bounds, redirects
and physical-timeout classification remain enforced.

| Actual correctness check                     | Before                         | ReleaseSafe   | ReleaseFast   |
| -------------------------------------------- | ------------------------------ | ------------- | ------------- |
| Default Tron native HTTP request             | `InsecureCloudUrl`; no request | Passed        | Passed        |
| Transport boundary root                      | Historical failure preserved   | 19 passed     | 19 passed     |
| Substantive boundary cases                   | —                              | 8 passed      | 8 passed      |
| Production chain/task producer root          | —                              | 30 passed     | 30 passed     |
| Substantive producer cases                   | —                              | 10 passed     | 10 passed     |
| CCS and shared signer root                   | Earlier source packet          | 44 passed     | 44 passed     |
| Metadata serializer / native roots           | Earlier source packet          | 6 / 23 passed | 6 / 23 passed |
| RPC physical deadline root                   | Earlier source packet          | 18 passed     | 18 passed     |
| Origin signer and shared gRPC ownership root | Earlier source packet          | 20 passed     | 20 passed     |
| Receipt jobs root                            | Earlier source packet          | 382 passed    | 382 passed    |
| Destination owner scope root                 | Earlier source packet          | 12 passed     | 12 passed     |
| Cosmos RPC owner root                        | Earlier source packet          | 19 passed     | 19 passed     |

Counts include imported tests and overlap between roots. They are not unique-test
totals or benchmark samples. All accepted runs had zero skips, failures or leaks.
The 16 selected related roots contributed 524 passing checks per mode against the
same 688-input source map. Both mode-specific workers and five native libraries
were explicitly pinned; the existing SDKs and static archives were reused.

The final boundary test uses an actual credential Manager and lease: the lease
retains the strict function and owner; arbitrary HTTP is rejected by both the
lease and metadata owner. Substituting the same owner's RPC handle is rejected by
the public destination Factory before signer construction. Independent review
closed this boundary and the five production-file changes.

Production fixtures exercised all four native chain defaults, the Helius Factory,
Tron receipts/origin signer, actual relayer and validator tasks, scraper Worker
and Aleo authorization scope. The scraper used component memory storage; Aleo
stopped at a malformed upstream edition before proving. These limits remain
explicit in the [producer packet](../../zig/bench/results/configured-rpc-producers/README.md).

Historical fixture errors are retained. An expanded boundary test initially sent
GET to a POST-only server. The first related origin run lacked its required
gRPC fixture; the next shared a stateful server between executables and failed
its request-count assertion. Fresh owned HTTP2/RSA fixtures per executable
resolved isolation. Production code and test assertions were unchanged for these
fixture corrections.

[The archive](../../zig/bench/results/configured-rpc-http/README.md) binds exact
before/after sources, commands, environment, native artifact pins, logs, reviews,
all failed attempts and the accepted combined results. This epoch precedes the
separate Starknet omitted-chain-ID correction. It grants component correctness
only; real VM scenarios, fresh complete binaries/images, production-duration
confirmation/restart proofs and performance measurements remain open.
