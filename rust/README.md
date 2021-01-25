## Optics Rust implementations

### Setup

- install `rustup`
  - [link here](https://rustup.rs/)

### Useful cargo commands

- `cargo doc --open`
  - generate documentation and open it in a web browser
- `cargo build`
  - compile the project
- `cargo run`
  - run the default executable for the current project
- `cargo test`
  - run the tests

### Architecture

The on-chain portions of optics are written in Solidity. The rust portions are
exclusively off-chain. Later, there may be on-chain rust for Near/Solana/
Polkadot.

Optics will be managed by a number of small off-chain programs ("agents"). Each
of these will have a specific role. We want these roles to be simple, and
easily described. Each of these agents will connect to a home chain and any
number of replicas. They need to be configured with chain connection details
and have access to a reliable node for each chain.

Some agent sketches:

- `updater`
  - Needs only a connection to the home chain
  - Signs upate attestations and submits them to the home chain
- `watcher`
  - Observe the home chain
  - Observe as many replicas as possible
  - Cache updates
  - Check for fraud
  - Submit fraud to the home chain
  - if configured, issue emergency stop transactions
- `relayer`
  - Relays signed updates from the home to the replica
  - Ensures updates are confirmed in a timely manner on the replica

For Ethereum and Celo connections we use
[ethers-rs](https://github.com/gakonst/ethers-rs). Please see the docs
[here](https://docs.rs/ethers/0.2.0/ethers/).

We use the tokio async runtime environment. Please see the docs
[here](https://docs.rs/tokio/1.1.0/tokio/).

### Repo layout

- `optics-core`
  - contains implementations of core primitives
  - this includes
    - traits (interfaces) for the on-chain contracts
    - model implementations of the contracts in rust
    - merkle tree implementations (for provers)
- `optics-base`
  - contains shared utilities for building off-chain agents
  - this includes
    - trait implementations for different chains
    - shared configuration file formats
    - basic setup for an off-chain agent
- TODO: other agents :)
