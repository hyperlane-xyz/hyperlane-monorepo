/**
 * Meson Finance bridge utilities.
 * Chain/token mapping and API type definitions for MesonBridge implementation.
 * API docs: https://meson.dev/getting-started/api-integration
 */

// ============================================================================
// Chain Mappings
// ============================================================================

const EVM_TO_MESON_CHAIN: Record<number, string> = {
  1: 'eth',
  56: 'bnb',
  42161: 'arb',
  728126428: 'tron',
  9745: 'plasma',
};

const MESON_TO_EVM_CHAIN: Record<string, number> = {
  eth: 1,
  bnb: 56,
  arb: 42161,
  tron: 728126428,
  plasma: 9745,
};

// ============================================================================
// API Base URLs
// ============================================================================

export const MESON_API_BASE = 'https://relayer.meson.fi/api/v1';
export const MESON_TESTNET_API_BASE = 'https://testnet-relayer.meson.fi/api/v1';

// ============================================================================
// Chain/Token Conversion Functions
// ============================================================================

/**
 * Convert EVM chain ID to Meson chain identifier.
 * @param chainId - EVM numeric chain ID
 * @returns Meson chain string (e.g., 'eth', 'tron')
 * @throws Error if chain ID is not supported
 */
export function evmChainIdToMesonChain(chainId: number): string {
  const mesonChain = EVM_TO_MESON_CHAIN[chainId];
  if (!mesonChain) {
    const supported = Object.keys(EVM_TO_MESON_CHAIN).join(', ');
    throw new Error(
      `Unsupported chain ID for Meson: ${chainId}. Supported: ${supported}`,
    );
  }
  return mesonChain;
}

/**
 * Convert Meson chain identifier to EVM chain ID.
 * @param mesonChain - Meson chain string (e.g., 'eth', 'tron')
 * @returns EVM numeric chain ID
 * @throws Error if Meson chain is not supported
 */
export function mesonChainToEvmChainId(mesonChain: string): number {
  const chainId = MESON_TO_EVM_CHAIN[mesonChain];
  if (chainId === undefined) {
    const supported = Object.keys(MESON_TO_EVM_CHAIN).join(', ');
    throw new Error(
      `Unsupported Meson chain: ${mesonChain}. Supported: ${supported}`,
    );
  }
  return chainId;
}

/**
 * Convert Meson chain and token symbol to Meson token ID.
 * @param mesonChain - Meson chain identifier (e.g., 'tron')
 * @param tokenSymbol - Token symbol (e.g., 'USDT')
 * @returns Meson token ID (e.g., 'tron:usdt')
 */
export function toMesonTokenId(
  mesonChain: string,
  tokenSymbol: string,
): string {
  return `${mesonChain}:${tokenSymbol.toLowerCase()}`;
}

/**
 * Parse Meson token ID into chain and token components.
 * @param mesonTokenId - Meson token ID (e.g., 'tron:usdt')
 * @returns Object with chain and token properties
 * @throws Error if format is invalid
 */
export function fromMesonTokenId(mesonTokenId: string): {
  chain: string;
  token: string;
} {
  const parts = mesonTokenId.split(':');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Invalid Meson token ID format: ${mesonTokenId}. Expected format: chain:token`,
    );
  }
  return {
    chain: parts[0],
    token: parts[1],
  };
}

// ============================================================================
// API Type Interfaces
// ============================================================================

/**
 * Response from Meson /price endpoint.
 * Used to get quote and encoded swap data for signing.
 */
export interface MesonPriceResponse {
  result?: {
    serviceFee: string;
    lpFee: string;
    totalFee: string;
    converted?: unknown;
  };
  error?: {
    code: number;
    message: string;
  };
}

export interface MesonEncodeResponse {
  result?: {
    encoded: string;
    fromAddress: string;
    recipient: string;
    initiator: string;
    fee: {
      serviceFee: string;
      lpFee: string;
      totalFee: string;
    };
    signingRequest: {
      message: string;
      hash: string;
    };
    tx?: {
      to: string;
      value: string;
      data: string;
    };
  };
  error?: {
    code: number;
    message: string;
  };
}

/**
 * Response from Meson /swap endpoint.
 * Returned after submitting a signed swap.
 */
export interface MesonSwapResponse {
  result?: {
    swapId: string;
  };
  error?: {
    code: number;
    message: string;
  };
}

/**
 * Response from Meson /swap?hash= endpoint.
 * Used to check status of a submitted swap.
 */
export interface MesonStatusResponse {
  result?: {
    _id?: string;
    encoded?: string;
    status?: string; // e.g. 'BONDED', 'RELEASED', 'CANCELLED' or numeric
    fromAddress?: string;
    recipient?: string;
    expireTs?: number;
    fromChain?: string;
    toChain?: string;
    inChain?: string;
    outChain?: string;
    hash?: string; // origin tx hash
    outHash?: string; // destination tx hash
    amount?: string; // received amount
  };
  error?: {
    code: number;
    message: string;
  };
}

/**
 * Token information from Meson /limits endpoint.
 */
export interface MesonLimitsToken {
  id: string;
  symbol: string;
  name: string;
  decimals: number;
  addr?: string;
  min: string;
  max: string;
}

/**
 * Chain information from Meson /limits endpoint.
 */
export interface MesonLimitsChain {
  id: string;
  name: string;
  chainId: string;
  address: string;
  tokens: MesonLimitsToken[];
}
