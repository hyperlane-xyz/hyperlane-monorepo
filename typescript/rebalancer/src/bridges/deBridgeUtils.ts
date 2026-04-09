import { bytesToAddressTron } from '@hyperlane-xyz/utils';

// ============================================================================
// API Constants
// ============================================================================

export const DEBRIDGE_API_BASE = 'https://dln.debridge.finance/v1.0';
export const DEBRIDGE_STATUS_API = 'https://api.dln.trade/v1.0';
export const DEBRIDGE_TOOL = 'debridge';

// ============================================================================
// Chain Configuration
// ============================================================================

export const HYPERLANE_TO_DEBRIDGE_CHAIN_ID: Record<number, number> = {
  1: 1, // Ethereum
  56: 56, // BSC
  42161: 42161, // Arbitrum
  9745: 100000028, // Plasma
  728126428: 100000026, // Tron
  1399811149: 7565164, // Solana
};

export const DEBRIDGE_TRON_CHAIN_ID = 100000026;
export const DEBRIDGE_SOLANA_CHAIN_ID = 7565164;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Convert a Hyperlane chain ID to a deBridge chain ID
 * @param chainId Hyperlane chain ID
 * @returns deBridge chain ID
 */
export function hyperlaneChainIdToDebridge(chainId: number): number {
  const debridgeChainId = HYPERLANE_TO_DEBRIDGE_CHAIN_ID[chainId];
  if (debridgeChainId === undefined) {
    throw new Error(
      `Chain ${chainId} is not supported by deBridge integration`,
    );
  }
  return debridgeChainId;
}

/**
 * Check if a deBridge chain ID corresponds to Tron
 * @param debridgeChainId deBridge chain ID
 * @returns true if the chain is Tron
 */
export function isDebridgeTronChain(debridgeChainId: number): boolean {
  return debridgeChainId === DEBRIDGE_TRON_CHAIN_ID;
}

/**
 * Check if a deBridge chain ID corresponds to Solana
 * @param debridgeChainId deBridge chain ID
 * @returns true if the chain is Solana
 */
export function isDebridgeSolanaChain(debridgeChainId: number): boolean {
  return debridgeChainId === DEBRIDGE_SOLANA_CHAIN_ID;
}

/**
 * Format an address for deBridge API calls.
 * For Tron: converts hex addresses to base58check format.
 * For Solana: returns base58 address as-is.
 * For EVM chains: returns address as-is.
 */
export function formatAddressForDebridge(
  address: string,
  debridgeChainId: number,
): string {
  if (debridgeChainId === DEBRIDGE_TRON_CHAIN_ID) {
    // Already base58 Tron address
    if (address.startsWith('T') && address.length === 34) {
      return address;
    }
    // Hex address — convert to Tron base58 using @hyperlane-xyz/utils
    if (address.startsWith('0x') || address.startsWith('41')) {
      const hex = address.replace(/^0x/, '').replace(/^41/, '');
      return bytesToAddressTron(Buffer.from(hex, 'hex'));
    }
  }
  // Solana addresses are base58, pass through unchanged
  return address;
}

// ============================================================================
// TypeScript Types
// ============================================================================

/** @see https://dln.debridge.finance/v1.0/dln/order/quote */
export interface DeBridgeTokenEstimation {
  chainId: number;
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  amount: string;
  approximateUsdValue?: number;
}

/** @see https://dln.debridge.finance/v1.0/dln/order/quote */
export interface DeBridgeQuoteResponse {
  estimation?: {
    srcChainTokenIn: DeBridgeTokenEstimation;
    dstChainTokenOut: DeBridgeTokenEstimation;
  };
  orderId?: string;
  fixFee?: string;
  protocolFee?: string;
  errorCode?: number;
  errorId?: string;
  errorMessage?: string;
}

/** @see https://dln.debridge.finance/v1.0/dln/order/create-tx */
export interface DeBridgeCreateTxResponse extends DeBridgeQuoteResponse {
  tx?: {
    /** EVM: contract address. Absent for Solana source. */
    to?: string;
    /** EVM: ABI calldata. Solana: hex-encoded serialized VersionedTransaction. */
    data: string;
    /** EVM: native currency value. Absent for Solana source. */
    value?: string;
  };
}

/** @see https://api.dln.trade/v1.0/dln/order/{orderId}/status */
export interface DeBridgeOrderStatusResponse {
  status?:
    | 'Created'
    | 'Fulfilled'
    | 'SentUnlock'
    | 'ClaimedUnlock'
    | 'Cancelled'
    | string;
  fulfilledDstEventMetadata?: {
    transactionHash?: { stringValue?: string };
    receivedAmount?: { bigIntegerValue?: string };
  };
  errorCode?: number;
  errorMessage?: string;
}
