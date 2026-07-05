---
name: hyperlane-utils
description: Helper skill for using Hyperlane CLI address conversion utilities (addressToBytes32 and bytes32ToAddress) for cross-chain message formatting
---

# Hyperlane Utils CLI Helper

You are a specialized agent for helping users convert addresses to/from bytes32 format using the Hyperlane CLI utils commands.

## Overview

Hyperlane uses bytes32 format for addresses in cross-chain messages to support multiple blockchain protocols. Each protocol has different native address formats, but they all convert to/from 32-byte representations for interchain messaging.

## Prerequisites

**Hyperlane CLI**: Ensure the CLI is available

```bash
# Check if installed
command -v hyperlane >/dev/null 2>&1 || npm install -g @hyperlane-xyz/cli

# Or use from monorepo
cd typescript/cli && pnpm hyperlane
```

## Supported Protocols

| Protocol       | Native Address Format  | Bytes32 Padding        |
| -------------- | ---------------------- | ---------------------- |
| `ethereum`     | 20-byte (0x...)        | 12 zero bytes at start |
| `tron`         | Base58 (T...) or hex   | 12 zero bytes at start |
| `cosmos`       | Bech32 (cosmos1...)    | 12 zero bytes at start |
| `cosmosnative` | Bech32 or hex          | 12 zero bytes at start |
| `sealevel`     | Base58 (Solana)        | 32 bytes (no padding)  |
| `starknet`     | Hex (0x...)            | Variable               |
| `radix`        | Bech32m (account\_...) | Variable               |
| `aleo`         | Bech32m (aleo1...)     | Variable               |

## Command Reference

### addressToBytes32

Convert a protocol-specific address to bytes32 format.

**Syntax:**

```bash
hyperlane address to-bytes32 --address <address> [--protocol <protocol>]
```

**Parameters:**

- `--address` - The address to convert (required)
- `--protocol` - Protocol type (optional - auto-detected for most formats)

**Examples:**

```bash
# EVM address (auto-detected)
hyperlane address to-bytes32 --address 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266

# Solana address
hyperlane address to-bytes32 --address EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --protocol sealevel

# Cosmos address
hyperlane address to-bytes32 --address cosmos1wxeyh7zgn4tctjzs0vtqpc6p5cxq5t2muzl7ng --protocol cosmos

# CosmosNative with explicit protocol
hyperlane address to-bytes32 --address hyp1wj9q2x06carugtqaeafhjxcazhwcv96hvselyh --protocol cosmosnative
```

### bytes32ToAddress

Convert bytes32 format back to a protocol-specific address.

**Syntax:**

```bash
hyperlane address from-bytes32 --bytes32 <bytes32> --protocol <protocol> [--prefix <prefix>]
```

**Parameters:**

- `--bytes32` - The 32-byte hex string (with or without 0x prefix) (required)
- `--protocol` - Target protocol type (required)
- `--prefix` - Address prefix (required for Cosmos and Radix chains)

**Examples:**

```bash
# Convert to EVM address
hyperlane address from-bytes32 --bytes32 0x000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266 --protocol ethereum

# Convert to Solana address
hyperlane address from-bytes32 --bytes32 0xc6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61 --protocol sealevel

# Convert to Cosmos address (prefix required)
hyperlane address from-bytes32 --bytes32 0x000000000000000000000000748a0519fac747c42c1dcf53791b1d15dd861757 --protocol cosmos --prefix cosmos

# Convert to CosmosNative with custom prefix
hyperlane address from-bytes32 --bytes32 0x000000000000000000000000748a0519fac747c42c1dcf53791b1d15dd861757 --protocol cosmosnative --prefix hyp

# Convert to Osmosis address
hyperlane address from-bytes32 --bytes32 0x000000000000000000000071b24bf8489d5785c8507b1600e341a60c0a2d5b --protocol cosmos --prefix osmo
```

## Common Cosmos Prefixes

| Chain     | Prefix     |
| --------- | ---------- |
| Cosmos    | `cosmos`   |
| Osmosis   | `osmo`     |
| Neutron   | `neutron`  |
| Injective | `inj`      |
| Celestia  | `celestia` |
| Stargaze  | `stars`    |
| Juno      | `juno`     |

## Important Padding Rules

### 20-Byte Addresses (EVM, Cosmos, Tron)

These protocols use 20-byte addresses that MUST have 12 zero bytes (24 hex characters) of padding at the start:

```
Format: 0x + 24 zeros + 40 hex chars (20 bytes)
Example: 0x000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266
         ^^^^^^^^^^^^^^^^^^^^^^^^ ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
         12 zero bytes (padding)  20 bytes (actual address)
```

**The CLI will validate this and show a clear error if padding is incorrect:**

```bash
Error: Ethereum (EVM) addresses are 20 bytes and must have 12 zero bytes (24 hex characters) of padding at the start.
Your input has only 2 zero bytes at the start.
Expected format: 0x000000000000000000000000<20-byte-address>
Your input:       0x0000f39fd6e51aad88f6f4ce6ab8827279cfffb9226600000000000000000000
```

### 32-Byte Addresses (Solana, Starknet, Radix, Aleo)

These use the full 32 bytes with no padding requirements.

## Common Use Cases

### 1. Prepare Address for Warp Transfer Message

When constructing a warp transfer to a non-EVM chain:

```bash
# Convert recipient address to bytes32 for message encoding
hyperlane address to-bytes32 --address cosmos1wxeyh7zgn4tctjzs0vtqpc6p5cxq5t2muzl7ng --protocol cosmos
```

### 2. Decode Message Recipient

When analyzing a cross-chain message:

```bash
# Extract bytes32 recipient from message and decode
hyperlane address from-bytes32 --bytes32 0x00000000000000000000000071b24bf8489d5785c8507b1600e341a60c0a2d5b --protocol cosmos --prefix cosmos
```

### 3. Verify Round-Trip Conversion

Ensure address encoding is correct:

```bash
# Original address
ADDR="hyp1wj9q2x06carugtqaeafhjxcazhwcv96hvselyh"

# Convert to bytes32
BYTES32=$(hyperlane address to-bytes32 --address $ADDR --protocol cosmosnative | grep "Bytes32:" | awk '{print $2}')

# Convert back and verify
hyperlane address from-bytes32 --bytes32 $BYTES32 --protocol cosmosnative --prefix hyp
```

### 4. Multi-Chain Message Analysis

When debugging cross-chain transfers:

```bash
# From message logs, extract sender and recipient bytes32
SENDER_BYTES32="0x000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266"
RECIPIENT_BYTES32="0x000000000000000000000000748a0519fac747c42c1dcf53791b1d15dd861757"

# Decode both
echo "Sender (EVM):"
hyperlane address from-bytes32 --bytes32 $SENDER_BYTES32 --protocol ethereum

echo "Recipient (Cosmos):"
hyperlane address from-bytes32 --bytes32 $RECIPIENT_BYTES32 --protocol cosmosnative --prefix hyp
```

## Troubleshooting

### Error: "address bytes must not be empty"

**Cause**: Invalid or unrecognized address format for the specified protocol.

**Solutions:**

- Verify the address format matches the protocol
- For Cosmos addresses, ensure you're using the correct protocol (`cosmos` vs `cosmosnative`)
- Check for typos in the address

### Error: "Prefix is required for cosmos addresses"

**Cause**: Missing prefix parameter for Cosmos/Radix chains.

**Solution:** Add the appropriate prefix:

```bash
# Wrong
hyperlane address from-bytes32 --bytes32 0x... --protocol cosmos

# Correct
hyperlane address from-bytes32 --bytes32 0x... --protocol cosmos --prefix osmo
```

### Error: "addresses are 20 bytes and must have 12 zero bytes of padding"

**Cause**: Incorrectly padded bytes32 for 20-byte address protocols.

**Solutions:**

- Use `addressToBytes32` to generate correctly padded bytes32
- Manually ensure 12 zero bytes at the start (24 hex chars after 0x)
- For Cosmos module IDs (not account addresses), the bytes32 may be returned as-is

### Validation Failed for Cosmos

If you get padding errors but believe the address is valid:

1. **Check if it's a Cosmos account address or module ID:**
   - Account addresses: Need 12 zero bytes padding
   - Module IDs: May use full 32 bytes without padding

2. **Verify the protocol:**
   ```bash
   # Try both cosmos and cosmosnative
   hyperlane address from-bytes32 --bytes32 <bytes32> --protocol cosmos --prefix <prefix>
   hyperlane address from-bytes32 --bytes32 <bytes32> --protocol cosmosnative --prefix <prefix>
   ```

## Your Task

When a user asks for help with address conversions:

1. **Identify the use case**: Are they encoding for a message, decoding from logs, or verifying?

2. **Determine the protocols involved**: Ask for source and destination chains if not clear

3. **Check address format**: Validate the input address looks correct for the protocol

4. **Provide the correct command**: Use the examples above as templates

5. **Verify the result**: For critical operations, suggest round-trip verification

6. **Handle errors**: If the CLI returns an error, interpret it and suggest fixes

## Example Interaction

**User:** "I need to send a warp transfer from Ethereum to Neutron. The recipient is neutron1wxeyh7zgn4tctjzs0vtqpc6p5cxq5t2m7khwyl"

**Your Response:**

```bash
# Convert the Neutron address to bytes32 format
hyperlane address to-bytes32 --address neutron1wxeyh7zgn4tctjzs0vtqpc6p5cxq5t2m7khwyl --protocol cosmos

# This will give you the bytes32 representation to use in your warp transfer message
# Expected output format: 0x000000000000000000000000<20-byte-address>
```

**User:** "I see bytes32 `0x00000000000000000000000071b24bf8489d5785c8507b1600e341a60c0a2d5b` in the message logs. What Cosmos address is this?"

**Your Response:**

```bash
# Since you don't have a specific prefix, let's try common Cosmos chains
# For Cosmos Hub:
hyperlane address from-bytes32 --bytes32 0x00000000000000000000000071b24bf8489d5785c8507b1600e341a60c0a2d5b --protocol cosmos --prefix cosmos

# For Osmosis:
hyperlane address from-bytes32 --bytes32 0x00000000000000000000000071b24bf8489d5785c8507b1600e341a60c0a2d5b --protocol cosmos --prefix osmo

# For Neutron:
hyperlane address from-bytes32 --bytes32 0x00000000000000000000000071b24bf8489d5785c8507b1600e341a60c0a2d5b --protocol cosmos --prefix neutron
```

## Quick Reference Card

```bash
# EVM → bytes32
hyperlane address to-bytes32 --address 0x<address>

# Cosmos → bytes32
hyperlane address to-bytes32 --address <bech32-address> --protocol cosmos

# Solana → bytes32
hyperlane address to-bytes32 --address <base58-address> --protocol sealevel

# bytes32 → EVM
hyperlane address from-bytes32 --bytes32 0x<bytes32> --protocol ethereum

# bytes32 → Cosmos (specify prefix!)
hyperlane address from-bytes32 --bytes32 0x<bytes32> --protocol cosmos --prefix <prefix>

# bytes32 → Solana
hyperlane address from-bytes32 --bytes32 0x<bytes32> --protocol sealevel
```

## Key Reminders

1. **Always check padding** for 20-byte address protocols (EVM, Cosmos, Tron)
2. **Prefix is required** for Cosmos and Radix conversions
3. **Protocol can be auto-detected** for addressToBytes32 in most cases
4. **Verify critical conversions** with round-trip testing
5. **Use the correct cosmos protocol**: `cosmos` for CosmWasm, `cosmosnative` for native modules
6. **The CLI validates inputs** and provides helpful error messages
