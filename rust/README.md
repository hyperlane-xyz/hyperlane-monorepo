## Hyperlane Rust implementations

### Setup

- install `rustup`
  - [link here](https://rustup.rs/)

Note: You should be running >= version `1.72.1` of the rustc compiler, you can see that version with this command and
should see similar output:

```
$ rustup --version
rustup 1.26.0 (5af9b9484 2023-04-05)
info: This is the version for the rustup toolchain manager, not the rustc compiler.
info: The currently active `rustc` version is `rustc 1.72.1 (d5c2e9c34 2023-09-13)`
```

### Overview of Rust Workspaces

There are two Rust workspaces in this directory:

- [main](https://github.com/hyperlane-xyz/hyperlane-monorepo/tree/main/rust/main): The offchain agents workspace, most notably comprised of the relayer, validator, scraper and the Rust end-to-end tests (in `utils/run-locally`)
- [sealevel](https://github.com/hyperlane-xyz/hyperlane-monorepo/tree/main/rust/sealevel): Hyperlane smart contracts and tooling for the SVM, implemented in native Rust.

You can only run `cargo build` after `cd`-ing into one of these workspaces.

#### Apple Silicon

If your device has an Apple Silicon processor, you may need to install Rosetta 2:

```bash
softwareupdate --install-rosetta --agree-to-license
```

### Running Agents Locally

Make sure you're in the `main` workspace.

To run the validator, run:

```bash
cargo run --release --bin validator
```

Or build and then run the binary directly:

```bash
cargo build --release --bin validator
./target/release/validator
```

To run the relayer, run:

```bash
cargo run --release --bin relayer
```

Or build and then run the binary directly:

```bash
cargo build --release --bin relayer
./target/release/relayer
```

### Running local binary against cloud resources (AWS KMS, S3, Postgresql, Google Cloud Storage, etc)

Building the docker image and upgrading the pod is a **slow** process. To speed up the development cycle, you can run a local binary against cloud resources.
This workflow is useful for testing local changes against cloud resources. It is also useful for debugging issues in production.

Example of fetching env from pod:

```bash
kubectl exec fuji-hyperlane-agent-validator-0 --namespace testnet3 -c agent -- printenv > ./config/validator.fuji.env
```

Copy directory (rocks DB) from pod to local:

```bash
kubectl cp testnet3/fuji-hyperlane-agent-validator-0:/usr/share/hyperlane /tmp/fuji-validator-db
```

Configure additional env variables appropriately:

```bash
HYP_DB=/tmp/fuji-validator-db
CONFIG_FILES=./config/testnet_config.json
HYP_TRACING_FMT=pretty
GCS_USER_SECRET=./path/to/file
# or if service account used
GCS_SERVICE_ACCOUNT_KEY=./path/to/file
DATABASE_URL=<READ_REPLICA_POSTGRES_URL> # for scraper
```

Run binary with env copied from pod:

```bash
env $(cat ./config/validator.fuji.env | grep -v "#" | xargs) ./target/debug/validator
```

#### Automated E2E Test

Clone `hyperlane-registry` repo next to `hyperlane-monorepo` repo.

To perform an automated e2e test of the agents locally, from within the `hyperlane-monorepo/rust/main` directory, run:

```bash
cargo run --release --bin run-locally
```

This will automatically build the agents, start a local node, build and deploy the contracts, and run a relayer and
validator. By default, this test will run indefinitely, but can be stopped with `ctrl-c`.

To run the tests for a specific VM, use the `--features` flag.

##### Cosmos E2E Test

```bash
cargo test --release --package run-locally --bin run-locally --features cosmos -- cosmos::test --nocapture
```

##### Sealevel E2E Test

```bash
cargo test --release --package run-locally --bin run-locally --features sealevel -- sealevel::test --nocapture
```

### Building Agent Docker Images

There exists a docker build for the agent binaries. These docker images are used for deploying the agents in a
production environment. You should run this at the top level of the repo.

```bash
./rust/build.sh <image_tag>
```

### Deploy Procedure

The contract addresses of each deploy can be found in `rust/main/config`. The agents will
automatically pull in all configs in this directory.

When agents are deployed to point at a new environment, they cease to point at
the old ones. We **do not** continue to operate off-chain agents on old contract
deploys. Contracts not supported by the agents will cease to function (i.e.
messages will not be relayed between chains).

Off-chain agents are **not** automatically re-deployed when new contract deploys
are merged. Auto-redeploys will be implemented at some future date.

### Useful cargo commands

- `cargo doc --open`
  - generate documentation and open it in a web browser
- `cargo build`
  - compile the project
- `cargo run --example example`
  - run the default executable for the current project
- `cargo test`
  - run the tests

### Useful cargo extensions

- tree
  - show the dependency tree. Allows searching for specific packages
  - install: `cargo install cargo-tree`
  - invoke: `cargo tree`
- clippy
  - search the codebase for a large number of lints and bad patterns
  - install: `rustup component add clippy`
  - invoke: `cargo clippy`
- expand
  - expand macros and procedural macros. Show the code generated by the preprocessor
  - useful for debugging `#[macros]` and `macros!()`
  - install: `cargo install cargo-expand`
  - invoke `cargo expand path::to::module`

### Architecture

The on-chain portions of Hyperlane are written in Solidity. The rust portions are
exclusively off-chain. Later, there may be on-chain rust for Near/Solana/
Polkadot.

Hyperlane will be managed by a number of small off-chain programs ("agents"). Each
of these will have a specific role. We want these roles to be simple, and
easily described. Each of these agents will connect to a home chain and any
number of replicas. They need to be configured with chain connection details
and have access to a reliable node for each chain.

For Ethereum and Celo connections we use
[ethers-rs](https://github.com/gakonst/ethers-rs). Please see the docs
[here](https://docs.rs/ethers/0.2.0/ethers/).

We use the tokio async runtime environment. Please see the docs
[here](https://docs.rs/tokio/1.1.0/tokio/).

### `main` workspace layout

- `hyperlane-base`
  - lowest dependency hyperlane utilities
  - contains shared utilities for building off-chain agents
  - this includes
    - trait implementations for different chains
    - shared configuration file formats
    - basic setup for an off-chain agent
- `hyperlane-core`
  - depends on hyperlane-base
  - contains implementations of core primitives
  - this includes
    - traits (interfaces) for the on-chain contracts
    - model implementations of the contracts in rust
    - merkle tree implementations (for provers)
- `chains/hyperlane-*`
  - VM-specific integration of the agents
  - depends on hyperlane-core (and transitively hyperlane-base)
  - interfaces with the contracts of that VM (e.g `ethereum`, `sealevel`, `cosmos`, `fuel`, etc)
- `agents`
  - each of the off-chain agents implemented thus far
