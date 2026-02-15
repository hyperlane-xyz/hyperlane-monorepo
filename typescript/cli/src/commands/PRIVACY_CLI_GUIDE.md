# Privacy Warp Routes CLI Guide

Privacy-enhanced token bridging using Aleo as a middleware layer for sender-recipient unlinkability.

## Commands Overview

### 1. Setup Wizard

```bash
hyperlane warp privacy-setup
```

Interactive setup wizard that:

- Checks Aleo wallet installation
- Verifies Aleo balance
- Checks registration status
- Provides next steps

### 2. User Registration

```bash
hyperlane warp privacy-register --chain <chain>
```

Register your EVM address with your Aleo address for privacy routing.

**Options**:

- `--chain` - EVM chain to register from (required)
- `--key` - Private key for signing (uses HYP_KEY env var by default)
- `--skip-confirmation` / `-y` - Skip confirmation prompts

**Example**:

```bash
hyperlane warp privacy-register --chain ethereum
```

**What it does**:

1. Connects to your Aleo wallet
2. Links your EVM address to your Aleo address
3. Submits registration transaction
4. Waits for confirmation

### 3. Send Private Transfer (Deposit)

```bash
hyperlane warp send-private \
  --origin <chain> \
  --destination <chain> \
  --amount <amount> \
  --recipient <address>
```

Initiate a private token transfer.

**Options**:

- `--origin` - Origin chain (required)
- `--destination` - Destination chain (required)
- `--amount` - Amount to send in token units (required)
- `--recipient` - Recipient address on destination (required)
- `--symbol` - Token symbol (if multiple routes)
- `--warp` - Path to warp config file
- `--output` / `-o` - Output file for commitment data (default: `./commitment.json`)

**Example**:

```bash
hyperlane warp send-private \
  --origin ethereum \
  --destination polygon \
  --amount 100 \
  --recipient 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb
```

**What it does**:

1. Checks you are registered
2. Generates commitment (Keccak256 hash)
3. Saves commitment + nonce to file
4. Submits deposit transaction to origin chain
5. Provides instructions for forwarding

**Output**: Creates `commitment.json` with transfer details

### 4. Forward Transfer on Aleo

```bash
hyperlane warp forward --commitment <file>
```

Forward the transfer from Aleo to destination chain.

**Options**:

- `--commitment` / `-c` - Path to commitment file (required)

**Example**:

```bash
hyperlane warp forward --commitment commitment.json
```

**What it does**:

1. Loads commitment data
2. Connects to Aleo wallet
3. Verifies deposit was received on Aleo
4. Checks expiry (7 days)
5. Submits forward transaction on Aleo
6. Tracks delivery to destination

**Privacy**: Amount hidden on Aleo, no sender-recipient link visible on-chain.

### 5. Refund Expired Transfer

```bash
hyperlane warp refund --commitment <file>
```

Refund an expired transfer (after 7 days).

**Options**:

- `--commitment` / `-c` - Path to commitment file (required)
- `--refund-to` - Custom refund recipient (defaults to original sender)

**Example**:

```bash
hyperlane warp refund --commitment commitment.json
```

**What it does**:

1. Loads commitment data
2. Checks transfer is expired (>7 days)
3. Verifies not already forwarded/refunded
4. Submits refund transaction on Aleo
5. Returns funds to origin chain

## Deployment

### Deploy Privacy Warp Route

```bash
hyperlane warp deploy --config privacy-warp-config.yaml
```

**Privacy token types**:

- `privateNative` - Native blockchain tokens (ETH, MATIC, etc.)
- `privateCollateral` - ERC20 collateral with rebalancing
- `privateSynthetic` - Minted/burned synthetic tokens

**Example config**:

```yaml
ethereum:
  type: privateCollateral
  token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' # USDC
  owner: '0x...'
  mailbox: '0x...'
  isUpgradeable: true
  privacyHubAddress: 'privacy_hub.aleo'

polygon:
  type: privateCollateral
  token: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' # USDC
  owner: '0x...'
  mailbox: '0x...'
  isUpgradeable: true
  privacyHubAddress: 'privacy_hub.aleo'
```

**Notes**:

- Deploys as TransparentUpgradeableProxy
- Requires Aleo privacy hub address
- Higher gas overhead (~150k)
- All chains must use privacy types

## Workflow

### Full Private Transfer Flow

```bash
# 1. One-time setup
hyperlane warp privacy-setup
hyperlane warp privacy-register --chain ethereum

# 2. Send private transfer
hyperlane warp send-private \
  --origin ethereum \
  --destination polygon \
  --amount 1000 \
  --recipient 0xRecipient...

# This creates: commitment.json

# 3. Wait for deposit confirmation (~2-5 min)

# 4. Forward when ready (you control timing)
hyperlane warp forward --commitment commitment.json

# Done! Transfer delivered with privacy preserved
```

### Refund Flow

```bash
# If transfer expires (>7 days)
hyperlane warp refund --commitment commitment.json

# Optionally specify custom refund recipient
hyperlane warp refund \
  --commitment commitment.json \
  --refund-to 0xCustomRecipient...
```

## Privacy Features

### What's Private?

✅ **Amount hidden on Aleo** - Encrypted in private records
✅ **No sender-recipient link** - No deterministic on-chain connection
✅ **Timing privacy** - User controls when to forward

### What's Public?

❌ Sender visible on origin chain
❌ Recipient visible on destination chain
❌ Origin and destination chains are visible

### Security Properties

- **Commitment-based security** - Prevents unauthorized forwarding
- **Nonce-based uniqueness** - Prevents replay attacks
- **7-day expiry** - Allows refunds for stuck transfers
- **Self-custody** - Full user control via Aleo wallet

## Troubleshooting

### "Address not registered"

```bash
hyperlane warp privacy-register --chain <chain>
```

### "Aleo wallet not found"

Install Leo Wallet or Aleo browser extension, then run setup again.

### "Deposit not found on Aleo"

Wait 2-5 minutes for confirmation, then try forwarding again.

### "Transfer has expired"

Use refund command to recover funds:

```bash
hyperlane warp refund --commitment commitment.json
```

### "Low Aleo balance"

Get testnet credits from https://faucet.aleo.org

## Requirements

- Aleo wallet (Leo Wallet or browser extension)
- Aleo credits (for registration, forward, refund)
- EVM wallet (for origin/destination transactions)
- Registered address (one-time setup)

## Gas Costs

- **Registration**: ~50k gas (one-time)
- **Deposit**: ~150k gas (per transfer)
- **Forward**: ~100k Aleo credits
- **Refund**: ~100k Aleo credits

## Best Practices

1. **Keep commitment files safe** - You need them to forward/refund
2. **Register once per address** - Registration is one-time
3. **Check expiry** - Forward within 7 days to avoid refund process
4. **Wait for confirmations** - Allow 2-5 min between steps
5. **Test with small amounts** - Start small on testnet

## Links

- [Hyperlane Docs](https://docs.hyperlane.xyz)
- [Aleo Docs](https://developer.aleo.org)
- [Privacy Implementation Plan](../../../PRIVACY_WARP_ROUTES_IMPLEMENTATION_PLAN.md)
