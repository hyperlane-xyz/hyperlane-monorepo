# Validator URL dependency wiring

Validator startup now requires the pinned Rust URL library. Existing process fixtures deliberately clear child environments, so service and image wiring alone did not reach those validators. The launchers now accept `--url-library` and pass its pinned path explicitly. Direct task fixtures carry the path in their input instead of inheriting an environment.

Before any measured process clock, the shared helper validates the native 64-bit Mach-O/ELF library type and architecture, copies all bytes into a hash-addressed task pin, and checks both source and destination again. Result JSON records the actual library path, SHA256, byte length and dependency scope. The read-only real-library check pinned 516,736 bytes without loading the library or invoking constructors.

Only Zig validator children receive the added URL environment variable. The benchmark’s Rust environment remains exactly its previous two-key dictionary. Driver-only EVM/generic fixtures require no URL argument when they do not start a task or daemon. Relayer acceptance supplies the dependency only to its validator children; the shared relayer launcher is unchanged.

The legacy direct validator builder now generates and pins per-build options containing the actual checkout Git SHA, a validated explicit commit, or the honest Gitless sentinel. It rejects symlinked or conflicting option files. Its plan-only mode invokes no compiler. Runtime environment cannot replace the compiled identity.

The initial plain Python import collided with the benchmark module named `validator`. It was corrected to `zig.integration.validator`. Both import orders are now tested with process execution forbidden and exact module paths checked.

| Pure control root                    | Passed |
| ------------------------------------ | -----: |
| New dependency/build/import controls |     16 |
| Early retirement guard               |     10 |
| Estimate/progress proof              |     10 |
| Four-member preparation barrier      |     16 |
| Existing benchmark controls          |     28 |
| Canonical batch controls             |     18 |

Counts overlap; they are not a unique-test total. All eleven source hashes stayed stable. AST comparisons preserve existing helper bodies, and the benchmark sampling, pacing and timing tail remains byte-identical. Root and independent peer reviews found no scoped blocker.

The [37-member packet](../../zig/bench/results/validator-url-dependency-wiring/manifest.json) retains source, original Git blobs, patch, commands, logs, the initial import failure, byte-pin result and reviews. [Verification](../../zig/bench/results/validator-url-dependency-wiring/verification.json) checks decoded hashes, sizes and deterministic gzip timestamps. The earlier [producer packet](validator-startup-metadata.md) remains unchanged.

No role, node, compiler, image or benchmark was executed for this follow-through. New runtime acceptance and performance results remain separate gates.
