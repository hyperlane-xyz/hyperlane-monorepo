# Privacy Warp Routes - Quickstart Guide

Privacy-enhanced cross-chain token transfers using Aleo as a privacy middleware.

## What You Get

- 🔒 **Sender-recipient unlinkability** - No on-chain link between sender and receiver
- 🎭 **Amount privacy on Aleo** - Transfer amounts hidden in encrypted records
- 🔐 **Commitment-based security** - Cryptographic proofs prevent unauthorized access
- 🌐 **Multi-chain support** - Works across all Hyperlane-supported chains

## Prerequisites

1. **EVM Wallet** (MetaMask, etc.)
2. **Aleo Wallet** (Leo Wallet or Puzzle)
3. **~0.1 Aleo credits** (~$0.01 for transaction fees)
4. **Tokens to bridge** (ETH, USDC, etc.)

## Quick Start

### 1. One-Time Setup

```bash
# Install CLI
npm install -g @hyperlane-xyz/cli

# Run setup wizard
hyperlane privacy setup
```

The wizard will guide you through:

- ✓ Checking Aleo wallet installation
- ✓ Checking Aleo balance
- ✓ Registering your Aleo address

### 2. Make a Private Transfer

```bash
# Deposit tokens on origin chain
hyperlane warp send-private \
  --origin ethereum \
  --destination polygon \
  --recipient 0xRecipientAddress \
  --amount 1000 \
  --token USDC

# Wait ~30 seconds for relayer

# Forward from Aleo privacy hub
hyperlane warp forward \
  --commitment-file ~/.hyperlane/commitments/<hash>.json \
  --aleo-wallet leo

# Wait ~30 seconds for relayer

# Done! Recipient receives tokens on destination
```

## Cost Breakdown

| Origin Chain      | Total Cost |
| ----------------- | ---------- |
| Ethereum L1       | ~$30-80    |
| Arbitrum/Optimism | ~$10-12    |
| Polygon           | ~$10-12    |
| Base              | ~$10-12    |

**Privacy Premium:** ~$4-5 (second relayer hop)

## How It Works

```
Origin Chain          Aleo Privacy Hub        Destination Chain
(Public)              (Amount Hidden)         (Public)

1. Lock tokens        2. Private record       3. Release tokens
   Amount: visible       Amount: encrypted       Amount: visible
   Sender: visible       Sender: hidden          Sender: aleo_hub
   Recipient: hidden     Recipient: hidden       Recipient: visible

No on-chain link between origin sender and destination recipient!
```

## Privacy Level

**Volume-Dependent:**

- 1-2 concurrent transfers: WEAK privacy
- 3-5 concurrent transfers: MODERATE privacy
- 5+ concurrent transfers: GOOD privacy
- 10+ concurrent transfers: STRONG privacy

Check current volume: `hyperlane privacy status`

## Security Notes

- ✅ Full self-custody (your keys, your funds)
- ✅ Commitment file contains secret - keep it secure
- ✅ 30-day expiry - refund available after expiry
- ⚠️ Privacy requires volume - early adoption may have limited privacy
- ⚠️ Must maintain Aleo wallet access for 30+ days

## Next Steps

- 📖 [Full Documentation](./docs/privacy-warp-routes.md)
- 🔐 [Security Best Practices](./docs/privacy-security.md)
- 💻 [Developer Guide](./docs/privacy-developer-guide.md)
- ❓ [FAQ](./docs/privacy-faq.md)

## Example Configurations

See `./configs/examples/` for:

- Private ETH route (Ethereum ↔ Polygon)
- Private USDC route (multi-chain)
- Private synthetic token route

## Support

- GitHub Issues: https://github.com/hyperlane-xyz/hyperlane-monorepo/issues
- Discord: https://discord.gg/hyperlane
- Docs: https://docs.hyperlane.xyz
