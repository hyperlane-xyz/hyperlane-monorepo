# @hyperlane-xyz/metaswaps-sdk

TypeScript SDK for **Hyperlane Metaswaps** — cross-chain token swaps powered by the Universal Router.

A metaswap routes a token transfer through up to three legs:

1. **Origin swap** — swap input token to a bridge asset on the source chain
2. **Bridge** — transfer the asset cross-chain via a Hyperlane warp route
3. **Destination swap** — swap the bridge asset to the desired output token on the destination chain

---

## Installation

```bash
# npm
npm install @hyperlane-xyz/metaswaps-sdk

# yarn
yarn add @hyperlane-xyz/metaswaps-sdk

# pnpm
pnpm add @hyperlane-xyz/metaswaps-sdk
```

### Optional: viem / wagmi (frontend wallets)

If you intend to use a wagmi `WalletClient` for signing, install `viem` as a peer dependency:

```bash
npm install viem
```

---

## Quick start

### Get a quote (no wallet needed)

```ts
import { MetaswapsSDK } from '@hyperlane-xyz/metaswaps-sdk';

const sdk = new MetaswapsSDK();

const quote = await sdk.quote({
  srcChain: 1, // Ethereum (EVM chain ID)
  dstChain: 8453, // Base
  srcToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC on Ethereum
  dstToken: '0x4200000000000000000000000000000000000006', // WETH on Base
  amount: '1000000000', // 1000 USDC (6 decimals)
  sender: '0xYourAddress',
  slippageBps: 50, // 0.5%
});

const best = quote.routes[0];
console.log('Output:', best.output, 'Min output:', best.outputMin);
console.log('Steps:', best.steps.map((s) => s.type).join(' → '));
```

### Execute a swap — frontend (wagmi / viem)

```ts
import { MetaswapsSDK } from '@hyperlane-xyz/metaswaps-sdk';
import { useWalletClient, useAccount } from 'wagmi';

const sdk = new MetaswapsSDK();

// Inside a React component or hook:
const { data: walletClient } = useWalletClient();
const { address } = useAccount();

const quote = await sdk.quote({ ... });

const handle = await sdk.swap(quote, {
  type: 'viemWalletClient',
  client: walletClient,
  account: address,
});

console.log('Origin tx:', handle.originTxHash);

// Wait until delivered on the destination chain
const result = await handle.delivered;
console.log('Delivered! Status:', result.status);
```

### Execute a swap — backend (private key)

```ts
import { MetaswapsSDK } from '@hyperlane-xyz/metaswaps-sdk';

const sdk = new MetaswapsSDK();

const quote = await sdk.quote({ ... });

const handle = await sdk.swap(quote, {
  type: 'privateKey',
  key: process.env.PRIVATE_KEY!,
  chainId: 1, // source chain
});

console.log('Origin tx:', handle.originTxHash);
await handle.delivered;
console.log('Done.');
```

### Execute a swap — ethers.js signer

```ts
import { MetaswapsSDK } from '@hyperlane-xyz/metaswaps-sdk';
import { ethers } from 'ethers';

const provider = new ethers.providers.JsonRpcProvider('https://...');
const signer = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

const sdk = new MetaswapsSDK();
const quote = await sdk.quote({ ... });

const handle = await sdk.swap(quote, {
  type: 'ethersSigner',
  signer,
});
```

---

## Tracking swap status

### Await individual milestones

```ts
const handle = await sdk.swap(quote, wallet);

// Resolves once the origin tx is confirmed on-chain
await handle.originConfirmed;
console.log('Origin confirmed.');

// Resolves once tokens arrive on the destination chain
const result = await handle.delivered;
console.log('Delivered:', result.status, result.destinationTxHash);
```

### Stream status updates

```ts
for await (const update of handle.watch()) {
  console.log(update.status, new Date(update.timestamp).toISOString());

  // update.status is one of:
  //   Pending → OriginConfirmed → Bridging → DestinationConfirmed
  //   or DestSwapExecuted / DestSwapFailed (for routes with a dest swap)
}
```

### Poll on a custom interval

```ts
for await (const update of handle.watch(2_000)) {
  // poll every 2 s
  updateProgressBar(update.status);
}
```

### Status values

| Status                 | Meaning                                                              |
| ---------------------- | -------------------------------------------------------------------- |
| `Pending`              | Origin transaction is in the mempool                                 |
| `OriginConfirmed`      | Origin transaction confirmed on-chain                                |
| `Bridging`             | Waiting for Hyperlane to deliver the cross-chain message             |
| `DestinationConfirmed` | Tokens arrived on destination (bridge-only route)                    |
| `DestSwapExecuted`     | Destination swap executed successfully by the ICA                    |
| `DestSwapFailed`       | Destination swap failed; recipient received the bridge asset instead |
| `Failed`               | Unrecoverable error (origin revert, etc.)                            |

---

## Configuration

```ts
const sdk = new MetaswapsSDK({
  // Routing engine base URL
  // Default: 'https://router.services.hyperlane.xyz'
  routingUrl: 'https://router.services.hyperlane.xyz',

  // Call Commitment Service URL (used for routes with a destination swap)
  // Default: 'https://offchain-lookup.services.hyperlane.xyz/callCommitments'
  ccsUrl: 'https://offchain-lookup.services.hyperlane.xyz/callCommitments',

  // Hyperlane Explorer API base URL (used for message status polling)
  // Default: 'https://explorer.hyperlane.xyz/api'
  explorerApiUrl: 'https://explorer.hyperlane.xyz/api',

  // Status polling interval in milliseconds
  // Default: 5000
  pollingInterval: 5_000,

  // Per-chain RPC URL overrides (keyed by EVM chain ID)
  chainRpcUrls: {
    1: 'https://your-eth-rpc-provider.example.com',
    8453: 'https://your-base-rpc-provider.example.com',
  },

  // How far in the future to set the UniversalRouter deadline (seconds)
  // Default: 300
  deadlineSeconds: 300,
});
```

---

## Standalone `RoutingClient`

Use `RoutingClient` directly when you only need read-only access (e.g. displaying token lists or prices in a UI):

```ts
import { RoutingClient } from '@hyperlane-xyz/metaswaps-sdk';

const client = new RoutingClient(); // uses default routing URL

// Check engine health
const healthy = await client.health();

// List supported chains
const { chains } = await client.chains();

// List tokens on Ethereum (chain ID 1)
const { tokens } = await client.tokens({ chain: 1 });

// Search for a token across all chains
const results = await client.tokens({ search: 'USDC' });

// Look up specific tokens by ID (format: "chainName-symbol")
const specific = await client.tokens({ ids: ['ethereum-USDC', 'base-WETH'] });

// Get a quote
const quote = await client.quote({
  srcChain: 1,
  dstChain: 8453,
  srcToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  dstToken: '0x4200000000000000000000000000000000000006',
  amount: '1000000000',
  sender: '0xYourAddress',
});
```

---

## Zod schemas

All API response shapes are exported as Zod schemas, useful for runtime validation or building on top of the SDK:

```ts
import {
  QuoteResponseSchema,
  ChainDiscoverySchema,
  TokenDiscoverySchema,
  RouteResponseSchema,
} from '@hyperlane-xyz/metaswaps-sdk';

// Validate an arbitrary API response
const quote = QuoteResponseSchema.parse(rawJson);
```

TypeScript types are inferred directly from the schemas:

```ts
import type {
  QuoteResponse,
  RouteResponse,
  QuoteStep,
  QuoteSwapStep,
  QuoteBridgeStep,
  ChainDiscovery,
  TokenDiscovery,
  CallCommitment,
  WalletConfig,
  SwapHandle,
  MetaswapsSDKConfig,
} from '@hyperlane-xyz/metaswaps-sdk';
```

---

## Warp UI integration

If you're using [`hyperlane-warp-ui-template`](https://github.com/hyperlane-xyz/hyperlane-warp-ui-template), replace the local `src/features/api/RouterClient.ts` and `src/features/api/types.ts` with imports from this package:

```ts
// Before (local copies)
import { RouterClient } from '../api/RouterClient';
import type { QuoteResponse } from '../api/types';

// After
import { RoutingClient as RouterClient } from '@hyperlane-xyz/metaswaps-sdk';
import type { QuoteResponse } from '@hyperlane-xyz/metaswaps-sdk';
```

---

## Requirements

- Node.js ≥ 18
- `viem` ≥ 2.x (optional peer dependency, only needed for `viemWalletClient` wallet type)
