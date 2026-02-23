---
name: wallet-setup
description: Explains the foundry keystore setup for signing transactions
allowed-tools: bash read
---

# Wallet Setup

The rebalancer private key is stored in a **foundry keystore** at `./keystore/rebalancer`. All `cast send` commands should use `--account rebalancer --keystore-dir ./keystore --password ''` instead of `--private-key`.

## How to Sign Transactions

Always use:

```bash
cast send <contract> '<sig>' <args...> --account rebalancer --keystore-dir ./keystore --password '' --rpc-url <rpc>
```

**NEVER** use `--private-key` directly. The key is in the keystore — you do not need to find or reference it.

## Verifying the Wallet

To check which address the keystore resolves to:

```bash
cast wallet address --account rebalancer --keystore-dir ./keystore --password ''
```

This should match the `rebalancerAddress` in `./rebalancer-config.json`.
