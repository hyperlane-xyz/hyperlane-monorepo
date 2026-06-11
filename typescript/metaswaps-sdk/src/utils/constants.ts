import { chainMetadata } from '@hyperlane-xyz/registry';
import { ethers } from 'ethers';

// ── API endpoints ────────────────────────────────────────────────────────────

export const DEFAULT_ROUTING_URL = 'https://router.services.hyperlane.xyz';

export const DEFAULT_CCS_URL =
  'https://offchain-lookup.services.hyperlane.xyz/callCommitments';

// Hasura GraphQL endpoint backing the Hyperlane explorer.
export const DEFAULT_EXPLORER_API_URL =
  'https://explorer4.hasura.app/v1/graphql';

// ── Timing / UX ──────────────────────────────────────────────────────────────

export const DEFAULT_POLLING_INTERVAL_MS = 5_000;

// How far ahead (seconds) the UniversalRouter deadline is set from now.
export const DEFAULT_DEADLINE_SECONDS = 300;

// ── On-chain event topics ────────────────────────────────────────────────────

export const BRIDGE_EVENT_TOPIC = ethers.utils.id(
  'UniversalRouterBridge(address,address,address,uint256,uint32)',
);

export const CROSS_CHAIN_SWAP_TOPIC = ethers.utils.id(
  'CrossChainSwap(address,address,uint32,bytes32)',
);

// Emitted by the Hyperlane Mailbox for every dispatched message.
// topics[1] is the bytes32 messageId — the canonical identifier for explorer polling.
export const DISPATCH_ID_TOPIC = ethers.utils.id('DispatchId(bytes32)');

// ── RPC defaults from @hyperlane-xyz/registry ────────────────────────────────

// Build a chainId → first public RPC URL map from the Hyperlane registry.
// Only includes EVM (protocol === 'ethereum') mainnet chains.
// Users can override any entry via MetaswapsSDKConfig.chainRpcUrls.
export const REGISTRY_RPC_URLS: Record<number, string> = Object.fromEntries(
  Object.values(chainMetadata)
    .filter(
      (meta) =>
        meta.protocol === 'ethereum' &&
        !meta.isTestnet &&
        meta.rpcUrls?.[0]?.http,
    )
    // When multiple registry entries share the same chainId (e.g. aliases),
    // keep the one whose name exactly matches its own chain name field —
    // that's always the canonical entry.
    .sort((a, b) => {
      // Prefer entries whose `name` matches a "clean" chain name (no suffix).
      const aCanon = a.name && !a.name.includes('testnet') ? 0 : 1;
      const bCanon = b.name && !b.name.includes('testnet') ? 0 : 1;
      return aCanon - bCanon;
    })
    .map((meta) => [meta.chainId, meta.rpcUrls[0].http] as [number, string]),
);

export function resolveRpcUrl(
  chainId: number,
  overrides?: Record<number, string>,
): string | undefined {
  return overrides?.[chainId] ?? REGISTRY_RPC_URLS[chainId];
}
