# Hyperlane CLI

The Hyperlane CLI is a command-line tool written in Typescript that facilitates common operations on Hyperlane, such as deploying the core contracts and/or warp routes to new chains.

## Hyperlane overview

Hyperlane is an interchain messaging protocol that allows applications to communicate between blockchains.

Developers can use Hyperlane to share state between blockchains, allowing them to build interchain applications that live natively across multiple chains.

To read more about interchain applications, how the protocol works, and how to integrate with Hyperlane, please see the [documentation](https://docs.hyperlane.xyz).

## Setup

Node 18 or newer is required.

**Option 1: Global install:**

```bash
# Install with NPM
npm install -g @hyperlane-xyz/cli
# Or uninstall old versions
npm uninstall -g @hyperlane-xyz/cli
```

**Option 2: Temp install:**

```bash
# Run via NPM's npx command
npx @hyperlane-xyz/cli
# Or via pnpm's dlx command
pnpm dlx @hyperlane-xyz/cli
```

**Option 3: Run from source:**

```bash
git clone https://github.com/hyperlane-xyz/hyperlane-monorepo.git
cd hyperlane-monorepo
pnpm install && pnpm build
cd typescript/cli
pnpm hyperlane
```

## Common commands

View help: `hyperlane --help`

Create a core deployment config: `hyperlane config create`

Run hyperlane core deployments: `hyperlane deploy core`

Run warp route deployments: `hyperlane deploy warp`

View SDK contract addresses: `hyperlane chains addresses`

Send test message: `hyperlane send message`

## Submitter strategies

The CLI accepts per-chain submission strategies with a `submitter` block. There are now three main ways to provide that submitter config:

- Inline submitter metadata: put the full submitter config directly in the strategy file.
- `file` submitter: write transactions to disk instead of sending them. Useful for offline review/signing flows, not for shared credential lookup.
- `submitter_ref`: keep the strategy small and resolve the real submitter config from the registry at runtime.

`submitter_ref` is a registry-backed indirection layer. Instead of embedding a private key or multisig config inline, the strategy points at a top-level registry entry under `submitters/`. The resolved payload can be either a bare submitter object or a `{ submitter: ... }` strategy wrapper.

```yaml
# strategy.yaml
arbitrum:
  submitter:
    type: submitter_ref
    ref: submitters/dev-arbitrum
```

```yaml
# <registry>/submitters/dev-arbitrum.yaml
submitter:
  type: jsonRpc
  chain: arbitrum
  privateKey: ${HYP_KEY}
```

Compared with inline config, `submitter_ref` keeps reusable submitter definitions in one place and lets multiple configs share them. Compared with `file` submitters, `submitter_ref` still resolves to a real on-chain submitter and executes transactions normally.

Resolution is done against the same registries the CLI already loads. Local registries are read from disk. HTTPS-backed registries are fetched over HTTP(S), and when an auth token is configured for registry access the CLI forwards it as `Authorization: Bearer <token>` while resolving submitter refs.

### Address conversion utilities

Convert address to bytes32: `hyperlane address to-bytes32 --address <address> [--protocol <protocol>]`

Convert bytes32 to address: `hyperlane address from-bytes32 --bytes32 <bytes32> --protocol <protocol> [--prefix <prefix> | --chain <chain>]`

## Logging

The logging format can be toggled between human-readable vs JSON-structured logs using the `LOG_FORMAT` environment variable or the `--log <pretty|json>` flag.

Note: If you are unable to see color output after setting `LOG_FORMAT`, you may set the `FORCE_COLOR=true` environment variable as a last resort. See https://force-color.org/ & https://github.com/chalk for more info.

The logging verbosity can be configured using the `LOG_LEVEL` environment variable or the `--verbosity <trace|debug|info|warn|error|off>` flag.

## Address Conversion Utilities

Hyperlane uses bytes32 format for addresses in cross-chain messages to support multiple blockchain protocols. The CLI provides utilities to convert between protocol-specific addresses and bytes32 format.

### to-bytes32

Convert an address to bytes32 format (used in Hyperlane messages).

**Usage:**

```bash
hyperlane address to-bytes32 --address <address> [--protocol <protocol>]
```

**Flags:**

- `--address, -a` - The address to convert (required)
- `--protocol, -p` (optional) - Protocol type: ethereum, sealevel, cosmos, cosmosnative, starknet, radix, aleo, tron. Auto-detected if not specified.

**Examples:**

```bash
# EVM address (auto-detected)
hyperlane address to-bytes32 --address 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266

# Solana address with explicit protocol
hyperlane address to-bytes32 -a EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v -p sealevel

# Cosmos address
hyperlane address to-bytes32 --address cosmos1wxeyh7zgn4tctjzs0vtqpc6p5cxq5t2muzl7ng --protocol cosmos
```

### from-bytes32

Convert bytes32 to an address for a specific protocol.

**Usage:**

```bash
hyperlane address from-bytes32 --bytes32 <bytes32> --protocol <protocol> [--prefix <prefix> | --chain <chain>]
```

**Flags:**

- `--bytes32, -b` - The bytes32 hex string to convert (with or without 0x prefix) (required)
- `--protocol, -p` - Target protocol type (required)
- `--prefix` (optional) - Address prefix for Cosmos chains (e.g., "cosmos", "osmo", "neutron") and Radix chains (e.g., "account_rdx")
- `--chain, -c` (optional) - Chain name to automatically lookup the prefix from registry (e.g., "osmosis", "neutron", "cosmoshub"). Cannot be used with `--prefix`.

**Examples:**

```bash
# Convert to EVM address
hyperlane address from-bytes32 --bytes32 0x000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266 --protocol ethereum

# Convert to Solana address (using aliases)
hyperlane address from-bytes32 -b 0xc6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61 -p sealevel

# Convert to Cosmos address with explicit prefix
hyperlane address from-bytes32 --bytes32 0x00000000000000000000000071b24bf8489d5785c8507b1600e341a60c0a2d5b --protocol cosmos --prefix cosmos

# Convert to Osmosis address using chain lookup
hyperlane address from-bytes32 -b 0x00000000000000000000000071b24bf8489d5785c8507b1600e341a60c0a2d5b -p cosmos --chain osmosis

# Convert to Neutron address using chain name
hyperlane address from-bytes32 -b 0x00000000000000000000000071b24bf8489d5785c8507b1600e341a60c0a2d5b -p cosmos -c neutron
```

**Supported Protocols:**

- `ethereum` - EVM-compatible chains (Ethereum, Polygon, Arbitrum, etc.)
- `sealevel` - Solana and SVM chains
- `cosmos` - Cosmos SDK chains using CosmWasm
- `cosmosnative` - Cosmos SDK chains using native modules
- `starknet` - StarkNet
- `radix` - Radix DLT
- `aleo` - Aleo
- `tron` - Tron
