# Ethereum typed header recovery

A preferred endpoint could return a valid block number with a malformed hash,
parent hash or timestamp. Pool accepted that result, counted physical success and
cached it. The typed consumer then failed outside fallback. A healthy neighbor
was never tried. The cache expired after 250 ms, but a persistently malformed
preferred endpoint could block indexing indefinitely.

`evm/header.zig` now owns the existing indexer Header parser and shared response
validation. Ethereum `eth_getBlockByNumber` and `eth_getBlockByHash` results pass
this boundary before Pool success, votes or cache insertion. Direct native cache
insertion and direct native/standard/exchange responses use the same parser.
Malformed upstream DTOs return precise retryable `RpcResponseDecode`; arbitrary
ABI, storage and configuration errors keep their existing classifications.

The required fields are number, hash, parentHash and timestamp. Fee quoting also
consumes gasLimit and baseFeePerGas, so present values validate as U256 quantities.
gasLimit is optional at this shared boundary; baseFeePerGas can be absent or null
for legacy blocks. Extra fields and full transaction arrays remain unchanged.
This is a consumed-field check, not a complete Ethereum block schema.

An unknown block's null result remains valid; strict `BlockHeader.parse(null)`
still returns `MissingBlock`. Explicit pending requests permit nullable number
and hash while checking parentHash and timestamp. Numeric block mismatches retain
the existing `WrongBlock` refusal. Valid HTTP 500 JSON-RPC results and structured
CCIP-read errors remain supported; HTTP 429 still aborts after its complete head.
Other protocols, strict response IDs, OOM, cancellation, bounds and deadlines
retain their existing behavior.

Rust's direct typed HTTP/cache path can reject typed deserialization before cache
insertion. Its actual Ethereum fallback requests raw `Value` in
`fallback.rs::provider_request`, then converts the winner into the requested type
after fallback selection. That path can share the original malformed-header
availability gap. This change improves availability at a known boundary; it does
not claim exact Rust fallback parity or full DTO coverage.

Existing native fixtures that deliberately used minimal successful headers now
provide explicit valid number/hash/parentHash/timestamp fields. Negative fixtures
remain malformed. No response auto-fill or weakened production validation was
introduced.

Functional evidence is archived in
`zig/bench/results/rpc-typed-header-recovery/manifest.json.gz`, with exact commands in
`zig/bench/results/rpc-typed-header-recovery/commands.json.gz`, source hashes and
lossless logs. The manifest's recorded `commands_file: commands.json` field resolves
to that canonical gzip member; open it directly or restore the raw JSON with
`python3 zig/tools/fixture_pack.py unpack <artifact.gz>`. Focused cases cover native fallback for dynamic,
numeric and hash selectors; invalid peers cannot form quorum; Pool and direct
native caches reject malformed DTOs, recover immediately and expire at 250 ms;
physical success/cache-hit counts exclude invalid responses; pending and null
responses; standard HTTP 500 recovery; and every direct-boundary allocation
failure. Actual native and standard validator tests exercise all four required
fields, healthy fallback, all-bad 5/10 second backoff, unchanged cursor, real
recovery, startup exhaustion and cancellation. Existing producer, Pool, native
HTTP, standard HTTP and replay aggregates are rerun against the same sources.

| Verification                                          |                     Result |
| ----------------------------------------------------- | -------------------------: |
| Producer aggregate, including new header cases        |                  33 passed |
| Existing native Pool aggregate                        | 85 passed, 1 optional skip |
| Actual validator native/standard fallback and backoff |                  36 passed |
| Focused header cases (also included above)            |                   8 passed |
| Native HTTP transport                                 |                  11 passed |
| Standard HTTP transport                               |                   4 passed |
| HTTP replay identities                                |                   3 passed |

All seven runs exited successfully. The 11 source/test hashes match before and
after the final matrix. The optional Pool skip belongs to the existing opt-in
native cloud transport test; no production credentials were loaded.

These are loopback correctness results. They do not constitute performance,
production-network or final role acceptance.
