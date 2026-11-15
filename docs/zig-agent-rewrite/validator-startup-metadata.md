# Validator startup metadata

The validator had storage methods for metadata but never called them. A stopped old Zig run had three checkpoint objects and no `metadata_latest.json`. The external startup invariant exposed the missing producer; the invariant was retained.

The producer now writes Rust’s full `ValidatorMetadata`: `git_sha`, ordered `rpcs` URL/host hashes, and `allows_public_rpcs`. It uses the original role RPC list, including duplicates and unused protocol-specific URLs. Raw URLs, userinfo, headers, paths and query tokens are absent from the published JSON.

Host hashing uses the separately pinned Rust `url` parser, matching IDNA, legacy numeric IPv4, IPv6 and hostless URL behavior. This adds a required fifth Rust library boundary. It is packaged with licenses in the core image, independently of optional SDK selection. The [URL component packet](../../zig/bench/results/native-url-host/README.md) records that boundary separately. Transport endpoint policy is unchanged. Earlier four-library dependency costs and binaries remain historical measurements.

Both checkpoint and independent announcement workers wait for a successful metadata write. Cancellation after a successful write leaves the barrier closed until retry. Existing backend reorg and local durability guards remain active; announcement mailbox records are retained. Ordinary storage failures use bounded supervisor retries, an availability difference from Rust’s fatal startup failure. They cannot enable signing or announcement work.

The Git identity comes from build inputs: checkout HEAD, an explicit validated commit, or the established Gitless sentinel. Runtime environment cannot replace it. CI passes its actual source commit into Gitless image builds.

| Focused check            | ReleaseSafe | ReleaseFast |
| ------------------------ | ----------: | ----------: |
| Serializer root          |    6 passed |    6 passed |
| Native task/backend root |   23 passed |   23 passed |

These are discovered test counts, including import smokes and overlap. The serializer root contains five substantive cases; the native root includes those plus three task/backend cases. Every run had zero skips, failures or leaks. The matrix held 17 input hashes stable. A subsequent Cargo license-only change rebuilt a byte-identical URL library; the original matrix maps remain preserved.

Two short startups of the immutable Rust validator produced independent goldens: both public-RPC flags, twelve ordered entries each, including unused IDNA and numeric IPv4 URLs. The binary hash stayed unchanged and all owned processes joined. Dummy contracts make these metadata-producer checks, not checkpoint or delivery acceptance.

Native checks exercise actual local storage and RocksDB, EVM/Tron task initialization, authenticated S3/GCS fixture transports, failure/retry, cancellation, reorg, missing-library failure, and teardown/reopen. GCS’s existing legacy key naming is preserved. The first candidate’s public-RPC fixture rejection is retained; its missing opt-in was fixed without weakening the assertion.

The [sealed packet](../../zig/bench/results/validator-startup-metadata/manifest.json) contains 60 lossless gzip members: frozen source, original Git blobs and patch, actual Rust fixtures, commands, logs, initial diagnostics and independent reviews. [Verification](../../zig/bench/results/validator-startup-metadata/verification.json) checks every decoded member, hash and zero gzip timestamp. No binaries, caches, databases or ambient environment are copied.

Fresh role/image checks, real-node end-to-end acceptance, and new cold/paired benchmarks remain separate gates. Focused task tests inject the build identity; they do not establish the final service binary’s Git stamp or all-protocol acceptance.
