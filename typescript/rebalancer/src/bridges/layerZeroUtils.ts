import { addressToBytes32 as addressToBytes32Util } from '@hyperlane-xyz/utils';

// ============================================================================
// Chain Configuration
// ============================================================================

export const TRON_CHAIN_ID = 728126428;

export const CHAIN_ID_TO_EID: Record<number, number> = {
  1: 30101, // Ethereum
  42161: 30110, // Arbitrum
  9745: 30383, // Plasma
  [TRON_CHAIN_ID]: 30420, // Tron (Legacy Mesh)
};

// ============================================================================
// Chain Network Membership
// ============================================================================

// Chains that support native USDT0 OFT transfers
const NATIVE_CHAINS = new Set([1, 42161, 9745]); // ETH, ARB, Plasma

// Chains that support Legacy Mesh OFT transfers
const LEGACY_CHAINS = new Set([1, 42161, TRON_CHAIN_ID]); // ETH, ARB, Tron

// Arbitrum is the hub for compose (native-only <-> legacy-only) routes
export const ARB_HUB_EID = 30110;
export const ARB_HUB_CHAIN_ID = 42161;
export const MULTIHOP_COMPOSER = '0x759BA420bF1ded1765F18C2DC3Fc57A1964A2Ad1';

// ============================================================================
// Contract Addresses
// ============================================================================

// Contract addresses from https://docs.usdt0.to/technical-documentation/deployments
export const OFT_CONTRACTS: Record<number, Record<number, string>> = {
  1: {
    // Ethereum OFT Adapter: 0x6C96dE32CEa08842dcc4058c14d3aaAD7Fa41dee
    42161: '0x6C96dE32CEa08842dcc4058c14d3aaAD7Fa41dee', // Eth -> Arb
    9745: '0x6C96dE32CEa08842dcc4058c14d3aaAD7Fa41dee', // Eth -> Plasma
  },
  42161: {
    // Arbitrum OFT: 0x14E4A1B13bf7F943c8ff7C51fb60FA964A298D92
    1: '0x14E4A1B13bf7F943c8ff7C51fb60FA964A298D92', // Arb -> Eth
    9745: '0x14E4A1B13bf7F943c8ff7C51fb60FA964A298D92', // Arb -> Plasma
  },
  9745: {
    // Plasma OFT: 0x02ca37966753bDdDf11216B73B16C1dE756A7CF9
    1: '0x02ca37966753bDdDf11216B73B16C1dE756A7CF9', // Plasma -> Eth
    42161: '0x02ca37966753bDdDf11216B73B16C1dE756A7CF9', // Plasma -> Arb
  },
};

// Legacy Mesh OFT contracts for Tron routes (ETH↔Tron, ARB↔Tron)
// TFG4wBaDQ8sHWWP1ACeSGnoNR6RRzevLPt = 0x3a08f76772e200653bb55c2a92998daca62e0e97 in EVM hex
export const LEGACY_MESH_CONTRACTS: Record<number, Record<number, string>> = {
  1: {
    42161: '0x1F748c76dE468e9D11bd340fA9D5CBADf315dFB0',
    [TRON_CHAIN_ID]: '0x1F748c76dE468e9D11bd340fA9D5CBADf315dFB0',
  },
  42161: {
    1: '0x77652D5aba086137b595875263FC200182919B92',
    [TRON_CHAIN_ID]: '0x77652D5aba086137b595875263FC200182919B92',
  },
  [TRON_CHAIN_ID]: {
    1: '0x3a08f76772e200653bb55c2a92998daca62e0e97',
    42161: '0x3a08f76772e200653bb55c2a92998daca62e0e97',
  },
};

export const USDT_CONTRACTS: Record<number, string> = {
  1: '0xdAC17F958D2ee523a2206206994597C13D831ec7', // Ethereum USDT
  42161: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', // Arbitrum USDT
  9745: '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb', // Plasma USDT
  [TRON_CHAIN_ID]: '0xa614f803b6fd780986a42c78ec9c7f77e6ded13c', // Tron USDT
};

// ============================================================================
// ABI Fragments
// ============================================================================

export const OFT_ABI = [
  'function quoteOFT((uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam) view returns ((uint256 minAmountLD, uint256 maxAmountLD) oftLimit, (int256 feeAmountLD, string description)[] oftFeeDetails, (uint256 amountSentLD, uint256 amountReceivedLD) oftReceipt)',
  'function quoteSend((uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam, bool payInLzToken) view returns ((uint256 nativeFee, uint256 lzTokenFee) messagingFee)',
  'function send((uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam, (uint256 nativeFee, uint256 lzTokenFee) fee, address refundAddress) payable returns ((bytes32 guid, uint64 nonce, (uint256 nativeFee, uint256 lzTokenFee) fee) msgReceipt, (uint256 amountSentLD, uint256 amountReceivedLD) oftReceipt)',
];

export const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

// ============================================================================
// TypeScript Types
// ============================================================================

export interface SendParam {
  dstEid: number;
  to: string; // bytes32 as hex string
  amountLD: bigint;
  minAmountLD: bigint;
  extraOptions: string; // '0x'
  composeMsg: string; // '0x'
  oftCmd: string; // '0x'
}

export interface MessagingFee {
  nativeFee: bigint;
  lzTokenFee: bigint;
}

export interface OFTReceipt {
  amountSentLD: bigint;
  amountReceivedLD: bigint;
}

export interface OFTFeeDetail {
  feeAmountLD: bigint;
  description: string;
}

export interface OFTLimit {
  minAmountLD: bigint;
  maxAmountLD: bigint;
}

export type RouteNetwork = 'native' | 'legacy' | 'compose';

export interface LayerZeroBridgeRoute {
  sendParam: SendParam;
  messagingFee: MessagingFee;
  oftContract: string;
  usdtContract: string;
  fromChainId: number;
  toChainId: number;
  network: RouteNetwork;
  // Compose-specific fields (only set when network === 'compose')
  composeSendParam?: SendParam; // The SendParam for the second hop
  composeMessagingFee?: MessagingFee; // Fee quoted for the second hop
}

export interface LayerZeroScanMessage {
  status: string; // 'INFLIGHT' | 'DELIVERED' | 'FAILED' | 'BLOCKED'
  dstTxHash?: string;
}

export interface LayerZeroScanResponse {
  messages: LayerZeroScanMessage[];
}

// ============================================================================
// API Constants
// ============================================================================

export const LAYERZERO_SCAN_API_URL =
  'https://scan.layerzero-api.com/v1/messages/tx/';

// ============================================================================
// Helper Functions
// ============================================================================

export function getRouteNetwork(
  fromChainId: number,
  toChainId: number,
): RouteNetwork | null {
  // Both in native → native (prefer native over legacy for 0% fee)
  if (OFT_CONTRACTS[fromChainId]?.[toChainId] !== undefined) return 'native';
  // Both in legacy → legacy
  if (LEGACY_MESH_CONTRACTS[fromChainId]?.[toChainId] !== undefined)
    return 'legacy';
  // One native-only, other legacy-only → compose via Arbitrum hub
  const fromNativeOnly =
    NATIVE_CHAINS.has(fromChainId) && !LEGACY_CHAINS.has(fromChainId);
  const fromLegacyOnly =
    LEGACY_CHAINS.has(fromChainId) && !NATIVE_CHAINS.has(fromChainId);
  const toNativeOnly =
    NATIVE_CHAINS.has(toChainId) && !LEGACY_CHAINS.has(toChainId);
  const toLegacyOnly =
    LEGACY_CHAINS.has(toChainId) && !NATIVE_CHAINS.has(toChainId);
  if ((fromNativeOnly && toLegacyOnly) || (fromLegacyOnly && toNativeOnly)) {
    return 'compose';
  }
  return null;
}

/**
 * For compose routes, returns the OFT contracts for each hop:
 *   Hop 1: source chain → Arbitrum hub (via source chain's OFT network)
 *   Hop 2: Arbitrum hub → destination (via destination chain's OFT network)
 */
export function getComposeHopContracts(
  fromChainId: number,
  toChainId: number,
): { firstHopOFT: string; secondHopOFT: string } {
  // First hop: source → Arbitrum. Use the source chain's network to reach Arb.
  const firstHopOFT = NATIVE_CHAINS.has(fromChainId)
    ? OFT_CONTRACTS[fromChainId]?.[ARB_HUB_CHAIN_ID]
    : LEGACY_MESH_CONTRACTS[fromChainId]?.[ARB_HUB_CHAIN_ID];

  // Second hop: Arbitrum → destination. Use the destination chain's network from Arb.
  const secondHopOFT = NATIVE_CHAINS.has(toChainId)
    ? OFT_CONTRACTS[ARB_HUB_CHAIN_ID]?.[toChainId]
    : LEGACY_MESH_CONTRACTS[ARB_HUB_CHAIN_ID]?.[toChainId];

  if (!firstHopOFT) {
    throw new Error(
      `No compose first hop OFT for chain ${fromChainId} -> Arbitrum`,
    );
  }
  if (!secondHopOFT) {
    throw new Error(
      `No compose second hop OFT for Arbitrum -> chain ${toChainId}`,
    );
  }
  return { firstHopOFT, secondHopOFT };
}

export function getOFTContractForRoute(
  fromChainId: number,
  toChainId: number,
): { address: string; network: RouteNetwork } {
  const network = getRouteNetwork(fromChainId, toChainId);
  if (!network) {
    throw new Error(
      `No OFT contract configured for route ${fromChainId} -> ${toChainId}`,
    );
  }
  if (network === 'compose') {
    // For compose, the firstHopOFT is what the source chain calls
    const { firstHopOFT } = getComposeHopContracts(fromChainId, toChainId);
    return { address: firstHopOFT, network };
  }
  const contracts =
    network === 'native' ? OFT_CONTRACTS : LEGACY_MESH_CONTRACTS;
  return { address: contracts[fromChainId][toChainId], network };
}

export function getOFTContract(fromChainId: number, toChainId: number): string {
  return getOFTContractForRoute(fromChainId, toChainId).address;
}

export function getUSDTAddress(chainId: number): string {
  const address = USDT_CONTRACTS[chainId];
  if (!address) {
    throw new Error(`No USDT contract configured for chain ${chainId}`);
  }
  return address;
}

export function getEID(chainId: number): number {
  const eid = CHAIN_ID_TO_EID[chainId];
  if (eid === undefined) {
    throw new Error(`No EID configured for chain ${chainId}`);
  }
  return eid;
}

export function isSupportedRoute(
  fromChainId: number,
  toChainId: number,
): boolean {
  return getRouteNetwork(fromChainId, toChainId) !== null;
}

export function addressToBytes32(address: string): string {
  return addressToBytes32Util(address);
}
