# Ethereum response-decode recovery

Component regression fix, 2026-11-06. This is correctness evidence, not final
rewrite acceptance or performance measurement. Raw logs, commands and source
hashes are in `zig/bench/results/rpc-response-recovery/manifest.json`.

The preserved native validator regression exposed a transport classification
hole after status-aware HTTP decoding was enabled. Its endpoint returns HTTP
503 with plaintext `fixture unavailable`. Direct native/standard Ethereum clients
leaked the JSON parser's `SyntaxError`; indexing correctly treats arbitrary
parser errors as fatal, so the validator skipped healthy peers and its fetch
backoff. HTTP 200 malformed/truncated bodies had the same hole. The original
503 fixture and its assertions remain in the native aggregate.

Rust evidence is `chains/hyperlane-ethereum/src/rpc_clients/http.rs:103–126` and
`rpc_clients/mod.rs:50–66`: the transport converts malformed JSON/envelopes into
`HttpClientError::SerdeJson`; provider categorization treats that as retryable
regardless of HTTP status. Rate-limit errors have their own retry category.

The native fix introduces `RpcResponseDecode` only at Ethereum upstream-response
JSON/envelope decode boundaries. Pool and direct native/standard clients share
the classification. Indexing admits that precise error and `RpcRateLimited` to
its existing fallback/backoff path. The latter preserves recovery for direct
HTTP 429 after early-head rejection acquired its own typed error. Raw
`SyntaxError` from configuration, storage or business parsing remains fatal;
there is no blanket parser-error retry rule or fake HTTP-status error for 200.

Valid HTTP 500 results remain accepted and cacheable when eligible. Structured
RPC errors and complete OffchainLookup revert data remain available. Strict ID
mismatch, allocation failure, control flow, body/header/JSON depth limits and
absolute deadlines retain their errors. Pool cooldowns, complete-head 429 abort,
Retry-After, request budgets, retry rounds and quorum denominators are unchanged.
No new transport, worker or Pool was added.

| Verification                                                 |                                Result | Evidence                          |
| ------------------------------------------------------------ | ------------------------------------: | --------------------------------- |
| Provider producers and added recovery/cache/allocation cases |                  26 passed, 0 skipped | `producer-final.log.gz`           |
| Dedicated Pool regression                                    |            85 passed, 1 optional skip | `pool-final.log.gz`               |
| Native HTTP bounds, ownership, headers and cancellation      |                             11 passed | `native-http.log.gz`              |
| Standard HTTP typed/envelope loopbacks                       |                              4 passed | `std-http.log.gz`                 |
| HTTP replay identity/route boundary                          |                              3 passed | `http-replay.log.gz`              |
| Preserved original validator native aggregate after fix      |                             26 passed | `validator-original-final.log.gz` |
| Expanded actual validator Role native/std aggregate          |                             28 passed | `validator-variants-final.log.gz` |
| Original native aggregate before fix                         | Failed `SyntaxError`; diagnostic only | `validator-before-fix.log.gz`     |

The expanded validator aggregate has five test declarations covering ten actual
scenarios plus import roots. It retains both generic scenarios and the original
native HTTP 503 scenario, then adds native HTTP 200 plaintext, 200 truncated JSON
and 429, plus standard HTTP 503 plaintext, 200 plaintext, 200 truncated JSON and 429. Every variant uses real sockets, the actual validator Role/Indexer and
native RocksDB. It verifies healthy-peer fallback; one logical 5-second then
10-second range backoff; no early requests or forward-cursor movement on repeated
failed fetches; ten bounded startup attempts; and
clearing range-retry state only after an overlapping successful fetch. Startup
critical reasons retain their existing latch semantics. The original native
curl timeout/cancellation checks remain. Standard variants omit only the
native-curl-specific code-28 subcase.

Provider tests separately exercise HTTP 200/503 plaintext, truncation and missing
result/error envelopes over real native/standard HTTP, then require a real
successful response before a cache hit. Pool tests prove healthy fallback and
that a malformed endpoint cannot consume another endpoint's cached answer or
populate its own entry. An allocation-failure sweep verifies response error
classification never swallows `OutOfMemory`. Existing full HTTP 500/CCIP and
stalled HTTP 429 tests pass unchanged.

These checks use public loopback fixtures and temporary native databases. They
read no production credentials and make no production requests. Final role
compilation, whole-root checks and benchmark freeze remain separate gates.
