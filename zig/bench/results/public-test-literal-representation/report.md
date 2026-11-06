Public fixture hashes now use Zig compile-time string concatenation with at most 32 consecutive hexadecimal characters per chunk. All 31 runs in the five owned test files retain exactly the same runtime bytes, including nested escaped JSON. Production code and hooks are unchanged.

Each archived before-source file, transformed only by these literal splits and `zig fmt`, exactly reproduces its archived after-source file. The independent Zig equality probe passes all 18 changed string expressions. `source-changes.json` records both source hashes in concatenable chunks; compressed source bytes preserve both snapshots.

| Check | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Exact string-byte equality | 18 | 0 | 0 |
| Starknet batch root | 44 | 0 | 0 |
| Typed headers and RPC producers | 33 | 0 | 0 |
| Delegated RPC Pool root | 86 | 0 | 0 |
| Cosmos transaction companion filter | 9 | 0 | 0 |

These are separate focused roots with overlapping imported smoke tests. They are not a unique project-wide total or performance measurements. Existing SDK libraries were reused; the Starknet library matches the previously accepted pin. No Rust/C, SDK, daemon, container, or benchmark run occurred. The initial equality-probe invocation omitted explicit libc/sysroot and failed to link; its raw diagnostic is retained alongside the corrected passing invocation.

Historical accepted proof manifests and source hashes remain unchanged. Final global acceptance must bind the five new test-source hashes. The compressed archives have both stored-byte and uncompressed-byte hashes in `manifest.json`; raw command and equivalence JSON can be formatted normally without altering those archives.
