# Current full-feature cold trials

This is a data-only launch record for the existing `cold-full-feature` job.
No trial has been launched or accepted by this file.

- Compiled Source baseline: `06e263fe7950e6051502a771646bbcc6d0453369`.
- Launch commit/run/attempt/job/artifact identities: pending, currently null.
- Native selector: explicitly inactive; no native case is authorized here.
- Trigger: normal push on `feat/zig-agent-rewrite` with both
  `[zig-native-case] [zig-cold-full-feature]` markers.
- Expected job instances: three serial cold trials plus inactive
  `native-case-producer-inputs`; no duplicate general correctness jobs.

All three trials must use the same launch commit. Its tree must differ from
baseline only by this plan; runtime, Rust/chart, Zig, workflow and runner Source
stay exact. Each owner receives the actual launch `GITHUB_SHA`; binaries and
receipts are not relabeled as baseline or borrowed from an older cohort.

1. Trial 1: `rust-safe-fast`.
2. Trial 2: `safe-fast-rust`.
3. Trial 3: `fast-rust-safe`.

Each fresh Depot Ubuntu 24.04 eight-core VM runs all twelve existing phases:
six fixed prerequisites (Rocks/compression/ABI, URL, regex, Starknet crypto,
Aleo crypto and Aleo VM), then adjacent cold/no-change pairs for Rust three
roles, Zig Safe three roles plus worker, and Zig Fast three roles plus worker.
Only compiler-pair positions rotate; prerequisites stay first.

Existing limits remain: serial matrix, jobs two, native CPU, Rust 1.98.0 and
Zig 0.15.2, full Aleo features, locked/offline measured builds. Setup is outside
phase timers and requires 40 GiB after staging. Owner wall limit is 14,400s,
phase limit 7,200s, owned RSS 16 GiB, allocated growth 64 GiB and ongoing free
floor 6 GiB; setup/timed-step/job limits remain 50/245/300 minutes. No cap,
cache, clock, cleanup or measurement method changes are authorized.

Retain every failed or successful trial. Readback must bind exact head,
run/attempt/job, artifact digest, all twelve phase rows, Source and generated
binding fences, direct/adopted waits, CPU/RSS scope, resource/quiescence guards,
actual products, owned absence and final clean collection. Existing
`read-v2.py` cold verifier is a starting point, with actual future identities;
older hardcoded runs and qualified receipts are historical only.

Actual three-trial acceptance: null. Native18, paired runtime and final timing
acceptance: null. This compile-only collection grants none of those gates.
