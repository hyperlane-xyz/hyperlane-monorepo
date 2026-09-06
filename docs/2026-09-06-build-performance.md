# Agent, contract, and CI build performance

## Changes

- Persist Cargo target artifacts alongside sccache in agent Docker builds; emit Cargo timings and cache statistics.
- Persist Turbo task archives and the Tron compiler in monorepo and node-service Docker builds. Match the prefetched EVM compiler to Hardhat 0.8.33.
- Apply Tron source overrides in Hardhat's read-file task, before dependency parsing and content hashing. Preserve the original Solidity source names and compiler settings.
- Run EVM and Tron after shared dependency/version preparation, with disjoint generated-output ownership. Retain Tron compiler state and regenerate bindings from surviving artifacts so deletions cannot leave stale exports.
- Generate Starknet artifacts with at most four workers. Workers read artifacts independently; index generation retains the original sorted order and propagates failures.
- Build Rust e2e harnesses with the same debug profile and test features as their child agents. Production agent and SBF optimization settings remain unchanged.
- Overlap Sealevel agent compilation with tool acquisition/SBF compilation in the other workspace. Cache SBF platform tools.
- Scope Rust EVM/Tron, Solidity fork, environment, and rebalancer test builds to their consumers' dependency graphs. Retain incremental TypeScript outputs in local Rust e2es.
- Cache npm downloads for packaged CLI installation across all CLI e2e shards; still pack and install the current checkout in every job.

## Local evidence

Base: `58e16ce875`. Node 26.6.0, macOS arm64. These are local measurements,
not projected CI savings. Build outputs were empty for the contract pair;
dependencies/compiler downloads were already available. Turbo task caching was
disabled for that comparison.

| Workload                                              |                  Baseline |                             Changed |
| ----------------------------------------------------- | ------------------------: | ----------------------------------: |
| EVM + Tron, fresh compiler outputs                    |                   114.43s |                              68.63s |
| Tron, retained compiler outputs with unchanged source | Always cleaned/recompiled |                               9.34s |
| Starknet fetch + generation                           |                    36.45s | See generator-only comparison below |
| Starknet generation, four workers                     |                         — |                              18.21s |

The paired fresh builds produced identical EVM and Tron artifact trees,
including compiler inputs, ABI, bytecode, metadata and TypeChain sources.
All 97 Starknet artifact pairs and runtime hashes matched the serial generator.
The full changed monorepo build passed all 32 tasks (11 cache hits).

Reproduce in separate worktrees with identical Node/dependency/compiler versions:

```sh
pnpm exec turbo run build build:tron --filter=@hyperlane-xyz/core --cache=local: --summarize
pnpm -C solidity build:tron
pnpm -C starknet generate-artifacts
pnpm exec tsx --test solidity/test/tron/source.test.cts starknet/scripts/generate-artifacts.test.ts
```

Use fresh compiler-output directories for the first command; repeated runs with
retained outputs measure incremental builds, not fresh compilation.

## Validated investigation boundaries

The September 4 agent image run 33885152916 spent 420 seconds in Cargo, including
roughly 281 seconds between starting hyperlane-aleo and its dependent crates.
Other cached runs were substantially faster. The Docker change targets repeated
builds; it does not claim to eliminate cold snarkVM compilation.

The September 5 Sealevel job 101301717985 spent about 10 seconds building its
cached release harness and 602 seconds inside the test, including tools, SBF
builds, deployments and message processing. Profile reuse primarily helps cold
or changed harness builds. Cached Sealevel runtime remains a separate bottleneck.
No message counts, confirmation requirements, invariant checks, or test timeouts
were reduced.

Changing Aleo optimization levels, removing network support/local proving, or
moving version metadata into runtime configuration needs separate compatibility
and runtime benchmarking. Those proposals are not prerequisites for these build
improvements and are not included here.
