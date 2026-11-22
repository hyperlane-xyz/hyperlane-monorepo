# Solar execution, block capacity and source-edit recompilation

[Full analysis](https://gist.github.com/paulbalaji/054371c203a43543801e4d9213d3c4b6), [draft PR #9956](https://github.com/hyperlane-xyz/hyperlane-monorepo/pull/9956), [raw samples](solar-execution-2026-11-02.json). Measured on benchmark commit `efb4689a9394f26c9c604127b68c955999fe3a85` in [Linux CI](https://github.com/hyperlane-xyz/hyperlane-monorepo/actions/runs/41526196058).

## Interpreter CPU

These are fixed-prestate Cancun evm2 interpreter measurements of the same second-transfer dispatch and process transactions used in the receipt benchmark. Each role has 100 correctness/warm-up replays, then 15 rounds of 5,000 replays. Fixture order alternates forward/reverse; the Linux thread is pinned to one allowed vCPU. Actual PMU hardware cycles and retired instructions are recorded per thread, excluding kernel/hypervisor activity. Every sample requires counters to run for at least 99% of enabled time; the measured ratio was 100% for every sample. The host exposes eight AMD EPYC 9R45 vCPUs under KVM; the benchmark used CPU 0. This is a CI VM, so host scheduling/frequency effects remain possible.

| Bytecode used                               | Cycles / pair equivalent | Retired CPU instructions / pair equivalent | Thread CPU µs / pair equivalent | Cycle reduction | CPU-time reduction |
| ------------------------------------------- | -----------------------: | -----------------------------------------: | ------------------------------: | --------------: | -----------------: |
| Current solc bytecode                       |                  660,657 |                                  2,259,968 |                         159.362 |           0.00% |              0.00% |
| Solar routers; existing solc core           |                  631,116 |                                  2,213,394 |                         151.939 |           4.47% |              4.66% |
| Solar routers + new Solar ISM factory/clone |                  609,126 |                                  2,162,242 |                         148.651 |           7.80% |              6.72% |
| Solar routers + supporting core/ISM factory |                  514,496 |                                  2,025,210 |                         123.736 |          22.12% |             22.36% |

A pair equivalent sums dispatch and process batch means within each round, then takes the median of those sums. It is not a timed alternating two-chain transfer. Each replay starts from its own original prestate; `discard()` clears transaction scratch and does not commit writes. Calldata, values, targets, messages and outcomes match across variants; each fixture retains its own original nonce, block environment and estimated transaction gas cap. All eight fixtures reproduce Anvil success, return data and exact receipt gas before timing. The timed loop includes transaction validation, interpretation, precompiles and journal cleanup. It excludes RPC/JSON, prestate import, persistent database writes, block production, outer transaction signature recovery, JIT and consensus. EVM ecrecover precompile work remains included.

CPU instructions are host machine instructions; the earlier opcode counts are EVM instructions. The two are different measurements. In the supporting-core case, 55.26% fewer EVM opcodes corresponded to 10.39% fewer retired host instructions, 22.12% fewer cycles and 7.51% less receipt gas. Precompile internals remain part of the CPU measurement.

| Bytecode used                               | Linux cycle min–max / pair | Linux CPU-time min–max, µs / pair | Mac CPU-time median, µs / pair | Mac CPU-time reduction |
| ------------------------------------------- | -------------------------: | --------------------------------: | -----------------------------: | ---------------------: |
| Current solc bytecode                       |            657,720–662,342 |                   149.992–165.730 |                        114.872 |                  0.00% |
| Solar routers; existing solc core           |            630,141–633,010 |                   144.750–161.938 |                        109.577 |                  4.61% |
| Solar routers + new Solar ISM factory/clone |            607,811–610,384 |                   140.773–153.054 |                        106.032 |                  7.70% |
| Solar routers + supporting core/ISM factory |            513,504–516,055 |                   116.848–130.597 |                         89.809 |                 21.82% |

Mac: Apple M3 Pro, 11 rounds × 2,000 replays, thread CPU and wall time only. Hardware cycles were unavailable and are left null rather than replaced with clock ticks. Linux: pinned vCPU, 15 × 5,000. These warmed in-memory replay results do not establish live-chain TPS or universal client gains.

## Execution capacity and local block packing

| Bytecode used                               | Linux serial pair equivalents / CPU-second | Execution-only increase | Local source transfers / full 5M-gas block |
| ------------------------------------------- | -----------------------------------------: | ----------------------: | -----------------------------------------: |
| Current solc bytecode                       |                                      6,275 |                   0.00% |                                         30 |
| Solar routers; existing solc core           |                                      6,582 |                   4.89% |                                         30 |
| Solar routers + new Solar ISM factory/clone |                                      6,727 |                   7.21% |                                         30 |
| Solar routers + supporting core/ISM factory |                                      8,082 |                  28.79% |                                         32 |

Execution-only capacity is `1 second / median summed thread CPU time`; it is derived from the replay timings and is not an independent full-node throughput measurement.

The block-packing experiment prequeues 512 identical successful one-token source transfer transactions per scenario after the first two transfers. It mines actual local Anvil blocks with a fixed 5,000,000-gas budget and a 300,000-gas cap per transaction, verifies all receipts and collateral balances, and reverts the task-owned snapshot afterwards. All transactions are from one sender. Supporting-core changes improve packing from 30 to 32 source transfers/block (+6.67%); routers alone leave it at 30. The final block is conservatively excluded because it may be partial. State/Merkle progression differs from the fixed second-transfer replay.

Packing depends on block gas budget, integer rounding, evolving storage and the transaction gas cap reserved by the builder. The same caps/budget are used in all scenarios. There is no measured block interval, validator network, consensus, disk state, concurrent production workload or live chain here. A faster interpreter cannot by itself increase a chain’s configured gas budget or lower finality.

## Source-edit incremental builds

| Host / invalidation                            | Files recompiled | solc median | Solar median | Speedup |
| ---------------------------------------------- | ---------------: | ----------: | -----------: | ------: |
| Linux CI: `contracts/hooks/MerkleTreeHook.sol` |                4 |      0.418s |       0.126s |   3.31× |
| Linux CI: `contracts/client/Router.sol`        |               52 |      8.733s |       0.389s |  22.47× |
| Mac: `contracts/hooks/MerkleTreeHook.sol`      |                4 |      0.464s |       0.236s |   1.97× |
| Mac: `contracts/client/Router.sol`             |               52 |      7.749s |       0.502s |  15.42× |

Five alternating samples after clean initialization and stabilization. A unique comment is appended to each selected source in a temporary contracts-only project copy; the checkout is untouched. This forces real compiler invalidation without changing contract behavior. The shared Router triggers 43-file and 9-file compiler jobs because of optimizer restrictions; the leaf hook triggers four files. The command is `forge build --skip test --skip script`. No Hardhat/TypeChain/export stages are included. Comment invalidations do not cover every semantic edit or import-graph change. The new Linux incremental run used AMD EPYC 9R45; the earlier 15× clean/no-op measurements used a different, Xeon runner. Actual workflow cache-hit frequency remains unmeasured.

“No-op builds are unchanged” remains supported. “Warm builds are unchanged” is too broad: an edited source still compiles, and speedup depends on how much it invalidates.

## Reproduce

Use the pinned Solar/Foundry setup in the existing [compiler report](solar-2026-11-02.md). The workflow records host metadata, raw per-role samples, exported prestates, receipt traces, compiler results, incremental logs and the exact resolved Cargo.lock in its artifact. A durable copy of the measured Linux lock is attached to the gist as `zz-evm-execution-Cargo.lock`; put that file at `benchmarks/evm-execution/Cargo.lock` before a `--locked` build.

```bash
# From solidity/, with the compiler/Anvil setup already installed:
node scripts/benchmark-solar.mjs --runs 5 --output /tmp/hyperlane-solar-results
node scripts/benchmark-solar-warp.mjs --build-results /tmp/hyperlane-solar-results/results.json --output /tmp/hyperlane-solar-results/warp --execution-fixtures --block-transfers 512
node scripts/benchmark-solar-incremental.mjs --runs 5 --output /tmp/hyperlane-solar-incremental
# Use the exact dependency lock attached to the analysis gist:
curl -fsSL https://gist.githubusercontent.com/paulbalaji/054371c203a43543801e4d9213d3c4b6/raw/zz-evm-execution-Cargo.lock -o benchmarks/evm-execution/Cargo.lock
CARGO_TARGET_DIR=/tmp/hyperlane-execution-target cargo +1.98.0 build --locked --release --manifest-path benchmarks/evm-execution/Cargo.toml
# Linux, when the local environment permits perf_event hardware counters:
sudo -n /tmp/hyperlane-execution-target/release/hyperlane-solar-execution-bench /tmp/hyperlane-solar-results/warp/execution-manifest.json /tmp/hyperlane-execution-results.json 15 5000
```

The engine is [evm2 at 9b037449](https://github.com/alloy-rs/evm2/tree/9b037449c846515624ff6afde739f2b764851446), Rust 1.98.0, release with thin LTO and one codegen unit. Default features are disabled; this fixture enables std, foldhash, assembly Keccak and libsecp256k1. There is no JIT. CPU counters are optional on other machines and explicitly unavailable when access is denied; the CI workflow requires actual cycle/instruction counters and CPU affinity to succeed. No live RPC, keys or funds are used.
