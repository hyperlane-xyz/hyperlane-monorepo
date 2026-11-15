# Sealevel scraper log positions

Independent native-verifier review found a production metadata mismatch: Rust
advanced dispatch/delivery LogMeta uses the authenticated message nonce or
processed sequence as log_index. Zig resolved the canonical transaction and
block but retained the basic fallback's zero index. Derived insertion rows
inherited that incorrect position.

The resolver now assigns that sequence only after finding the actual matching
transaction. Basic unavailable/unresolved fallback remains unchanged, and gas
payment indexing retains its existing sequence. No schema or authority changed.

An actual pre-fix regression failed `expected7, found0`. The final focused suite
passed5 checks in each mode (3 substantive,2 imports), covering production Rust
transaction-relevance fixtures, nonzero dispatch/delivery positions, prior-slot
resolution and pruned fallback. Independent review checked both modes' logs,
allthree Source files and the Rust/generic insertion semantics.

[Exact Source, failures, commands, outputs and review](../../zig/bench/results/svm-scraper-log-index/README.md).
Fresh combined roles, actual native-node SQL coverage, production-duration
proofs and matched runtime benchmarks remain open.
