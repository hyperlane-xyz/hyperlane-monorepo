# Hyperlane Sealevel (Solana VM) Integration

## Build

Contracts:

```bash
pushd programs
cargo build-sbf --arch bpf
popd
```

Test client:

```bash
pushd client
cargo build
popd
```

## Deploy and Test with Local Validator

```bash
solana-test-validator --reset
```

In a separate shell:

```bash
solana -u l program deploy target/deploy/hyperlane_sealevel_mailbox.so
solana -u l program deploy target/deploy/hyperlane_sealevel_ism_rubber_stamp.so
solana -u l program deploy target/deploy/hyperlane_sealevel_recipient_echo.so
```

```bash
RUST_LOG=debug cargo run create-accounts
RUST_LOG=debug cargo run send -m 100
RUST_LOG=debug cargo run receive
```
