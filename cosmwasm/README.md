# Hyperlane CosmWasm Telepathy Interchain Security Module (ISM)

This workspace contains CosmWasm smart contracts and Rust libraries implementing a Zero-Knowledge TelepathyX Interchain Security Module (ISM) for Hyperlane.

## Crates & Packages

- **`packages/mpt-verify`**: Pure-Rust Ethereum Merkle Patricia Trie (MPT) and RLP proof verification library.
- **`contracts/telepathy-light-client`**: Succinct Telepathy light client tracking verified Ethereum state roots.
- **`contracts/ism-telepathy`**: Hyperlane CosmWasm ISM implementing CCIP-read offchain query specs and cryptographic MPT state proof verification.

## Running Tests

```bash
cargo test --manifest-path cosmwasm/Cargo.toml
```

## Documentation

See [docs/deployments/telepathy-cosmwasm-ism.md](../docs/deployments/telepathy-cosmwasm-ism.md) for full deployment instructions and offchain CCIP-read service configuration.
