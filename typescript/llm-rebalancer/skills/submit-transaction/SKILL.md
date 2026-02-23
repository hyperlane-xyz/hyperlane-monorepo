---
name: submit-transaction
description: How to sign and send on-chain transactions via cast
allowed-tools: bash read
---

# Submit Transaction

All on-chain actions use `cast send` from Foundry. This skill covers signing, sending, and parsing receipts.

## Signing

Always use the foundry keystore — **NEVER** use `--private-key`:

```bash
cast send <contract> '<function_sig>' <args...> \
  --account rebalancer --password '' \
  --rpc-url <rpc>
```

The keystore is pre-loaded in the default foundry location (`~/.foundry/keystores/`). You only need `--account rebalancer --password ''`.

## Verifying Wallet Address

```bash
cast wallet address --account rebalancer --password ''
```

Should match `rebalancerAddress` in `./rebalancer-config.json`.

## Parsing Receipts

### Get transaction receipt as JSON

```bash
cast receipt <txHash> --rpc-url <rpc> --json
```

### Extract messageId from DispatchId event

The Mailbox emits a `DispatchId(bytes32 indexed messageId)` event alongside each `Dispatch` event. Use `DispatchId` (topic0 `0x788dbc1b7152732178210e7f4d9d010ef016f9eafbe66786bd7169f56e0c353a`) — the messageId is `topics[1]`:

```bash
cast receipt <txHash> --rpc-url <rpc> --json | jq -r '.logs[] | select(.topics[0] == "0x788dbc1b7152732178210e7f4d9d010ef016f9eafbe66786bd7169f56e0c353a") | .topics[1]'
```

**Do NOT use the `Dispatch` event** for messageId — it contains sender/destination/recipient in topics, not messageId.

## Address to bytes32

Pad an address to 32 bytes (needed for `transferRemote` recipient):

```bash
cast --to-bytes32 <address>
```

## Common Flags

| Flag                   | Purpose                           |
| ---------------------- | --------------------------------- |
| `--rpc-url <url>`      | Target chain RPC                  |
| `--json`               | Output as JSON (for jq parsing)   |
| `--account rebalancer` | Use keystore identity             |
| `--password ''`        | Empty password (unsafe, sim only) |
