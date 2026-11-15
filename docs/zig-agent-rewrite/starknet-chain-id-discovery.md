# Starknet chain-ID discovery

Omitted Starknet chain IDs now resolve through the configured native provider before any signing authority or operation context is created. The result is owned by Factory and shared by its backend, authority checks and context hash. Explicit configured text retains its existing byte identity and hard network-mismatch check.

Rust’s actual Starknet scenario omits `chainId`: its connection settings carry RPC URLs and the native token, and `build_single_owner_account` discovers the chain ID from RPC. Zig previously parsed the missing field as empty text, then unconditionally parsed it as a felt in Factory startup. The old-code focused probe reproduced `InvalidStarknetFelt`. Injecting a chain ID into the correctness fixture would have hidden the mismatch.

The [lossless evidence manifest](../../zig/bench/results/final-publication-overlay-20261107/08/canonical.json.gz) and [verification record](../../zig/bench/results/starknet-chain-id-discovery/verification.json) preserve the exact prepatch files, scoped patch, original failure, intermediate diagnostics, final sources, commands, logs, native dependency pins and independent review. No executable, database or WAL is copied into this packet.

| Accepted focused check                                                   |      Safe |      Fast |
| ------------------------------------------------------------------------ | --------: | --------: |
| Starknet startup, authority, recovery-context and native SDK regressions | 40 passed | 40 passed |
| Validator metadata and startup descriptor barriers                       | 23 passed | 23 passed |
| Skips / failures / leaks                                                 |         0 |         0 |

Counts include imported tests and root smokes; they are not summed as unique feature coverage. Eleven new substantive test entrypoints cover the new behavior. All 12 selected source files and nine native dependency artifacts match before and after each accepted run. Independent source and artifact review found no blocker.

## Ownership and control boundaries

Factory validates credential transport ownership first, then performs missing-ID discovery before entering the non-RPC signer scope. The discovered canonical felt text lives in Factory’s arena. Borrowed settings and Resources remain unchanged, including constructor failure and allocation-failure paths. Reopening against the same network preserves context; another network cannot restore the old authority. Existing explicit IDs are not normalized or silently rebound.

The relayer’s startup scope uses its retained worker’s original absolute deadline, bounded by inherited RPC/HTTP deadlines. It preserves cancellation and halt, retains the RPC timeout capability, and restores the exact prior state after success, error or cooperative yield. Repeating a pending startup does not receive another budget.

The validator announcement worker creates separate native resources, so the relayer scope alone was insufficient. The worker now captures one deadline at callback entry, before database, credential and initialization work, and passes it into native construction and the subsequent announcement tick. The supervisor’s cancellation token still enforces its original watchdog. The constructor binds only its newly owned Resources, then restores its transport state. Its retained options clear the transient initialization clock, preventing callback pointers from escaping.

Actual loopback native HTTP tests exercise omitted-ID announcement construction, pre-call and late cancellation/halt, expired and in-flight owner deadlines, physical upstream timeout, cleanup and restored ownership. A live owner with the fixture’s shorter physical transport timeout yields `UpstreamReadTimeout`; an owner-clamped transfer retains `RequestDeadlineExceeded`. These short fixture caps do not change production timeout policy.

## Preserved diagnostics

The initial two-file candidate passed 35 tests in each mode. Its exact sources and packets remain historical after the necessary announcement-owner followthrough.

An initial OOM test helper incorrectly converted allocation failure while reading a fixture path into a skip. It was corrected to skip only a missing environment variable; the final allocation sweep executes and passes. The first announcement fixture link required the existing bzip2 invariant glue already used by native database roots; that failed link is retained.

One metadata command accidentally expanded to 525 imported/unit tests. It recorded 520 passes, two absent HTTP2/gRPC fixture skips and three missing-RSA-fixture errors: libcrypto was enabled, but `HYPERLANE_TEST_RSA_FIXTURE_DIR` was not supplied. The errors were verified at the three explicit fixture reads; no production assertion failure was found. The command stopped before an expanded Fast run. The fresh intended `validator metadata` filter passed 23 tests in each mode. Both the expanded diagnostic and accepted narrow runs remain intact.

This packet establishes the scoped Source behavior and focused correctness controls. It gives no actual devnet deployment, agent-role delivery, cold-build performance or elapsed 600-second credit. The real Starknet family adapter must use the generated configuration unchanged and separately prove native signatures, canonical receipts, durable accounting, checkpoints, SQL and restart behavior.
