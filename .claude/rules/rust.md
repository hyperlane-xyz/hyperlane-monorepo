---
paths: rust/**/*.rs
---

# Rust Development Rules

## Agents Overview

- `relayer` - Indexes messages, delivers to destinations
- `validator` - Signs checkpoints for message verification
- `scraper` - Indexes chain data for analytics

## Chain Crates (`rust/main/chains/`)

- `hyperlane-ethereum` - EVM chains
- `hyperlane-cosmos` - Cosmos chains
- `hyperlane-sealevel` - Solana/SVM
- `hyperlane-fuel` - Fuel
- `hyperlane-aleo` - Aleo
- `hyperlane-radix` - Radix
- `hyperlane-starknet` - Starknet

## Core Crates

- `hyperlane-core` - Traits and message types
- `hyperlane-base` - Shared agent utilities

## Testing

- Run `cargo test` from `rust/main/`
- Use `cargo test <test_name>` for single test
- E2E: `cargo run --release --bin run-locally`
- VM-specific e2e:
  - `cargo test --release --package run-locally --features cosmos -- cosmos::test --nocapture`
  - `cargo test --release --package run-locally --features sealevel -- sealevel::test --nocapture`

## Before Committing

- Run `cargo clippy` for linting
- Run `cargo fmt` for formatting

## Security Considerations

- Secure key management in agent code
- Validate checkpoint signing logic
- Ensure message validation is correct
