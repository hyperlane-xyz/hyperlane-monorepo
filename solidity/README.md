# Hyperlane Core

Hyperlane Core contains the contracts and typechain artifacts for the Hyperlane implementation for EVM.

## Install

```bash
# Install with NPM
npm install @hyperlane-xyz/core

# Or with pnpm
pnpm add @hyperlane-xyz/core
```

Note, this package uses [ESM Modules](https://gist.github.com/sindresorhus/a39789f98801d908bbc7ff3ecc99d99c#pure-esm-package)

## Build

```bash
pnpm build
```

## Test

```bash
pnpm test
```

### Solar (experimental)

Solar v0.3 generates EVM bytecode. Use it for local Foundry builds and tests:

```bash
foundryup --install "$(cat .foundryrc-solar)"
rustup toolchain install 1.98.0 --profile minimal
cargo +1.98.0 install --locked --git https://github.com/paradigmxyz/solar --rev e7a91fc70f29dc8d0c236d56a2aa7706dc2555cf solar-compiler
# Ensure ~/.cargo/bin takes precedence over Foundry's bundled Solar on PATH.
solar --version
forge soldeer install
pnpm build:solar
pnpm test:solar
```

The `solar` profile keeps Cancun, the 10,000 optimizer runs and the
CrossCollateralRouter size restriction. Its artifacts and cache live in
`out-solar/` and `forge-cache-solar/`. Hardhat, published artifacts, ZKsync and
Tron still use their existing compilers. Solar's first codegen release is
[experimental](https://github.com/paradigmxyz/solar/blob/v0.3.0/CHANGELOG.md);
this profile is for development, not production deployment.

Tests explicitly keep `isolate = false`, matching the pinned Foundry v1.5
runner. Newer Foundry defaults to isolation, which clears transient fee quotes
between calls within a test. Time-warp tests must use `vm.getBlockTimestamp()`
when advancing time repeatedly; optimizers can reuse `block.timestamp`.

Run the compiler comparison under the repository's Node version:

```bash
nvm use
pnpm benchmark:solar --runs 5 --output /tmp/hyperlane-solar-results
```

The benchmark alternates clean contracts-only builds, measures cached builds,
compares contract ABIs and compiler-reported storage layouts, then runs the existing offline Forge
suite under both compilers with fuzz seed `0`. It preserves the existing
Everclear, Tron and fork exclusions. Each invocation uses fresh temporary build
directories; logs and `results.json` go to the output directory. Test gas includes
the test harness. It is not a measurement of isolated user transactions.
The separate IGP gas report uses the fixed `testPayForGas()` inputs and reports
contract calls and deployment gas. Fuzz gas is retained as raw evidence; a fixed
seed alone does not fix the compiler-dependent fuzz dictionary.

The build comparison uses native compilers under Forge. It does not time
`pnpm build`, which also runs Hardhat, TypeChain, TypeScript and artifact exports.
The cached row is a no-op Forge invocation with compilation skipped.

Any test failure, missing test, changed result, ABI difference or storage-layout
difference returns a nonzero exit code. Matching failures are still failures.
The `Solidity Solar` workflow uploads the same evidence on contract PRs.

[Local benchmark results and method](benchmarks/solar-2026-11-02.md).
[Warp deployment, transfer receipts and opcode counts](benchmarks/solar-warp-2026-11-02.md).

### Fixtures

Some forge tests may generate fixtures. This allows the [SDK](https://github.com/hyperlane-xyz/hyperlane-monorepo/tree/main/typescript/sdk) tests to leverage forge fuzzing. These are git ignored and should not be committed.

## Contributing

When modifying Solidity contracts, CI checks will validate that appropriate changesets are included based on the type of change:

| Analysis      | Change Type                              | Required Changeset |
| ------------- | ---------------------------------------- | ------------------ |
| **Bytecode**  | Any change                               | `patch` or higher  |
| **Interface** | Addition (new functions, events, errors) | `minor` or higher  |
| **Interface** | Removal or modification                  | `major`            |
| **Storage**   | Addition (new storage slots)             | `minor` or higher  |
| **Storage**   | Removal                                  | `major`            |

To add a changeset, run:

```bash
pnpm changeset
```

Select `@hyperlane-xyz/core` and choose the appropriate bump level based on your changes.

## License

Apache 2.0
