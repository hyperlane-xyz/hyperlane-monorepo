---
name: hyperlane-message-utils
description: Encode and decode raw Hyperlane messages to/from packed hex bytes using the CLI. Use when you need to construct a message for testing, inspect a raw message from logs or a transaction, or decode a warp transfer body.
---

# Hyperlane Message Utils CLI Helper

You are a specialized agent for encoding and decoding raw Hyperlane messages using the `hyperlane message` CLI commands.

## Overview

A Hyperlane message is a packed binary blob with this layout:

```
| Field       | Type    | Bytes |
|-------------|---------|-------|
| version     | uint8   | 1     |
| nonce       | uint32  | 4     |
| origin      | uint32  | 4     |
| sender      | bytes32 | 32    |
| destination | uint32  | 4     |
| recipient   | bytes32 | 32    |
| body        | bytes   | var   |
```

Total fixed header: 77 bytes. Body is variable length.

The message ID is `keccak256` of the packed bytes.

## Prerequisites

```bash
# From monorepo
cd typescript/cli && pnpm hyperlane

# Or if globally installed
hyperlane
```

## Commands

### `hyperlane message decode`

Parse a packed message hex string into its fields.

**Syntax:**

```bash
hyperlane message decode --bytes <hex>
```

**Parameters:**

- `--bytes` / `-b` — packed message hex (with or without `0x`) (required)

**Output:**

- Message ID (keccak256 of the bytes)
- All message fields
- Chain names resolved from domain IDs where known
- Sender/recipient shown as `bytes32 (protocol-address)` when chain is in registry
- If the body is exactly 64 bytes, decoded as a warp transfer (recipient + amount)

**Example:**

```bash
hyperlane message decode --bytes 0x030000000100000001000000000000000000000000cb527f2e62458409a2b6b71fd587fabd01b2077600000038000000000000000000000000cb527f2e62458409a2b6b71fd587fabd01b20776...
```

**Example output:**

```
Message ID:  0x11c59b50...
Version:     3
Nonce:       1
Origin:      1 (ethereum)
Sender:      0x000...cb527f... (0xCB527F2e62458409A2B6B71fD587FABD01b20776)
Destination: 56 (bsc)
Recipient:   0x000...cb527f... (0xCB527F2e62458409A2B6B71fD587FABD01b20776)
Body (warp transfer):
  Recipient: 0x000...cb527f... (0xCB527F2e62458409A2B6B71fD587FABD01b20776)
  Amount:    2000
```

---

### `hyperlane message encode`

Pack message fields into a hex-encoded message and compute its ID.

**Syntax:**

```bash
hyperlane message encode \
  --nonce <n> \
  --origin <chain-or-domain> \
  --sender <address> \
  --destination <chain-or-domain> \
  --recipient <address> \
  [--msg-version <n>] \
  [--body <hex> | --warpRecipient <address> --warpAmount <amount>]
```

**Parameters:**

| Flag                   | Required | Description                                                  |
| ---------------------- | -------- | ------------------------------------------------------------ |
| `--nonce` / `-n`       | yes      | Message nonce (uint32)                                       |
| `--origin` / `-o`      | yes      | Origin chain name (`ethereum`) or domain ID (`1`)            |
| `--sender`             | yes      | Sender address — auto-converted to bytes32                   |
| `--destination` / `-d` | yes      | Destination chain name (`bsc`) or domain ID (`56`)           |
| `--recipient`          | yes      | Recipient address — auto-converted to bytes32                |
| `--msg-version`        | no       | Message version (default: `3`)                               |
| `--body`               | no       | Raw message body as hex (default: `0x`)                      |
| `--warpRecipient`      | no       | Warp transfer recipient — builds body automatically          |
| `--warpAmount`         | no       | Warp transfer token amount (required with `--warpRecipient`) |

`--body` and `--warpRecipient` are mutually exclusive — using `--warpRecipient` overrides the body.

**Output:**

- Packed message bytes
- Message ID
- All fields with resolved chain names

**Example — plain message:**

```bash
hyperlane message encode \
  --nonce 1 \
  --origin ethereum \
  --sender 0xCB527F2e62458409A2B6B71fD587FABD01b20776 \
  --destination bsc \
  --recipient 0xCB527F2e62458409A2B6B71fD587FABD01b20776
```

**Example — warp transfer:**

```bash
hyperlane message encode \
  --nonce 1 \
  --origin ethereum \
  --sender 0xCB527F2e62458409A2B6B71fD587FABD01b20776 \
  --destination bsc \
  --recipient 0xCB527F2e62458409A2B6B71fD587FABD01b20776 \
  --warpRecipient 0xCB527F2e62458409A2B6B71fD587FABD01b20776 \
  --warpAmount 1000000000000000000
```

**Example output:**

```
Bytes:       0x03000000010000000100000000...
Message ID:  0x11c59b50...
Version:     3
Nonce:       1
Origin:      1 (ethereum)
Sender:      0x000000000000000000000000cb527f...
Destination: 56 (bsc)
Recipient:   0x000000000000000000000000cb527f...
Body:        0x000000000000000000000000cb527f...0000000000000000000000000000000000000000000000000de0b6b3a7640000
```

## Warp Transfer Body Format

When `--warpRecipient` is used, the body is constructed as:

```
bytes32 recipient  (32 bytes)
uint256 amount     (32 bytes)
─────────────────────────────
Total: 64 bytes (128 hex chars + 0x prefix)
```

The `decode` command auto-detects this format: if the body is exactly 64 bytes, it decodes and displays the recipient and amount fields.

## Common Use Cases

### 1. Inspect a message from transaction data

Copy the calldata from `Mailbox.process(metadata, message)` and decode the `message` argument:

```bash
hyperlane message decode --bytes 0x<message-hex-from-calldata>
```

### 2. Construct a test message for a script

```bash
MSG=$(hyperlane message encode \
  --nonce 0 \
  --origin ethereum \
  --sender 0xDeadBeef... \
  --destination arbitrum \
  --recipient 0xDeadBeef... \
  --body 0xdeadbeef \
  | grep "^Bytes:" | awk '{print $2}')

echo "Message bytes: $MSG"
```

### 3. Compute a message ID without running a node

```bash
hyperlane message encode \
  --nonce 42 \
  --origin 1 \
  --sender 0x... \
  --destination 42161 \
  --recipient 0x... \
  | grep "Message ID:"
```

### 4. Round-trip verify encode → decode

```bash
BYTES=$(hyperlane message encode \
  --nonce 1 --origin ethereum --sender 0xABC... \
  --destination bsc --recipient 0xDEF... \
  | grep "^Bytes:" | awk '{print $2}')

hyperlane message decode --bytes $BYTES
```

## Your Task

When a user asks to encode or decode a Hyperlane message:

1. **Decode**: Run `hyperlane message decode --bytes <hex>` and interpret the output. If the body looks like a warp transfer, explain the recipient and amount.

2. **Encode**: Collect the required fields (nonce, origin, sender, destination, recipient). Ask if they want a warp transfer body or a custom body. Run the command and return the packed bytes and message ID.

3. **Chain names vs domain IDs**: Both are accepted for `--origin` and `--destination`. Prefer chain names when known (e.g. `ethereum`, `bsc`, `arbitrum`, `optimism`, `polygon`).

4. **Address format**: Sender and recipient are auto-converted to bytes32 — pass the native address directly. No need to pre-convert.
