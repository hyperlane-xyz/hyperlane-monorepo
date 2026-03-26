import { createHash } from 'crypto';

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
};

export const DEBRIDGE_TRON_CHAIN_ID = 100000026;

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
 * Base58 encode a buffer using the Bitcoin alphabet
 */
function base58Encode(buf: Buffer): string {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt('0x' + buf.toString('hex'));
  let s = '';
  while (n > 0n) {
    s = ALPHABET[Number(n % 58n)] + s;
    n = n / 58n;
  }
  // Preserve leading zero bytes as '1' characters
  for (const b of buf) {
    if (b !== 0) break;
    s = '1' + s;
  }
  return s;
}

/**
 * Convert a hex address to Tron base58check format
 * Strips 0x prefix, adds 0x41 Tron mainnet prefix, computes double-SHA256 checksum
 */
function hexToTronBase58(hexAddress: string): string {
  const TRON_PREFIX = '41';
  const addr = hexAddress.replace(/^0x/, '').replace(/^41/, '');
  const withPrefix = Buffer.from(TRON_PREFIX + addr, 'hex');
  const hash1 = createHash('sha256').update(withPrefix).digest();
  const hash2 = createHash('sha256').update(hash1).digest();
  const checksum = hash2.slice(0, 4);
  const full = Buffer.concat([withPrefix, checksum]);
  return base58Encode(full);
}

/**
 * Format an address for deBridge API calls
 * For Tron: converts hex addresses to base58check format
 * For EVM chains: returns address as-is
 * @param address The address to format
 * @param debridgeChainId The deBridge chain ID
 * @returns Formatted address
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
    // Hex address — convert to Tron base58
    if (address.startsWith('0x') || address.startsWith('41')) {
      return hexToTronBase58(address);
    }
  }
  return address;
}

// ============================================================================
// TypeScript Types
// ============================================================================

export interface DeBridgeTokenEstimation {
  chainId: number;
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  amount: string;
  approximateUsdValue?: number;
}

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

export interface DeBridgeCreateTxResponse extends DeBridgeQuoteResponse {
  tx?: {
    to: string;
    data: string;
    value: string;
  };
}

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
