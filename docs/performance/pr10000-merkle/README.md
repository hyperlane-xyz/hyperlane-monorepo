# Batched relayer Merkle replay

The DB loader already publishes at most 32 leaves under one exclusive prover
lock. Previously it recomputed the packed-tree root and independently checked
the incremental-tree root after every leaf. The candidate retains every
completed subtree but computes and checks the two roots once per published
batch. Every intermediate historical proof remains available.

Capacity is checked before either tree changes. A failed root comparison blocks
further ingestion and proof queries until rebuild; the loader advances its DB
cursor only after successful validation.

## Result

On an Apple M3 Pro, macOS arm64, Rust 1.88.0 release build, replaying 100,000
leaves took **1,224.980 ms before and 69.592 ms after: 17.60× faster**.
This measures in-memory Merkle replay, including tree
allocation, and excludes DB retrieval, RPC, and the rest of relayer startup.
It does **not** establish a 17.60× whole-process restart improvement.

The baseline is the actual production source at
`e8689117d985dd27bdf83163d7a2883f88b57579`. The harness compiles it alongside
the candidate with the same real `hyperlane-core` dependency. It changes only
module/import paths and removes baseline tests. Its unused `DbError` stand-in
avoids linking RocksDB; neither hashing nor either Merkle implementation is
reimplemented. The comparison uses the original single-leaf builder API and
the candidate's 32-leaf builder API.

One warmup and five measured runs per implementation alternate execution order.
Input allocation and 100 sampled historical proof comparisons are outside the
timed interval. Counts and proof bytes match on every run. Sorted raw samples,
in microseconds:

```text
original: [1221443, 1224363, 1224980, 1233841, 1264852]
batch32:  [67852, 68688, 69592, 70388, 71060]
```

## Reproduce

Run from the repository root, with the baseline commit available locally:

```sh
git show e8689117d9:rust/main/Cargo.lock > docs/performance/pr10000-merkle/Cargo.lock
cargo +1.88.0 test --manifest-path docs/performance/pr10000-merkle/Cargo.toml --release
MERKLE_BENCH_LEAVES=100000 cargo +1.88.0 test \
  --manifest-path docs/performance/pr10000-merkle/Cargo.toml --release --locked \
  original_vs_batched_replay -- --ignored --nocapture
cargo +1.88.0 clippy --manifest-path docs/performance/pr10000-merkle/Cargo.toml \
  --release --locked --all-targets -- -D warnings
```

The measured standalone lockfile is retained with the local evidence. The
public reproduction starts from the pinned workspace lockfile; Cargo may
reselect some transitive versions for this smaller dependency graph. Both
implementations always use the same dependencies in the same executable.

The focused suite runs the real packed-tree and builder tests, including
independent recursive-tree comparison, historical prefixes, chunk boundaries,
whole-batch capacity rejection, and failure latching. The full relayer/RocksDB
suite was not run locally because this checkout had under 4 GiB free and no
reusable agent build. Run the normal relayer suite in CI before merge; this
harness does not replace it. No agent rollout was performed.
