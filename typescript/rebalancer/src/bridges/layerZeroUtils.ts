import { addressToBytes32 as addressToBytes32Util } from '@hyperlane-xyz/utils';

// ============================================================================
// Chain Configuration
// ============================================================================

export const CHAIN_ID_TO_EID: Record<number, number> = {
  1: 30101, // Ethereum
  42161: 30110, // Arbitrum
  9745: 30383, // Plasma
};

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

export const USDT_CONTRACTS: Record<number, string> = {
  1: '0xdAC17F958D2ee523a2206206994597C13D831ec7', // Ethereum USDT
  42161: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', // Arbitrum USDT
  9745: '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb', // Plasma USDT
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

export interface LayerZeroBridgeRoute {
  sendParam: SendParam;
  messagingFee: MessagingFee;
  oftContract: string;
  usdtContract: string;
  fromChainId: number;
  toChainId: number;
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

/**
 * Get the OFT contract address for a given route
 */
export function getOFTContract(fromChainId: number, toChainId: number): string {
  const contracts = OFT_CONTRACTS[fromChainId];
  if (!contracts) {
    throw new Error(`No OFT contracts configured for chain ${fromChainId}`);
  }
  const contract = contracts[toChainId];
  if (!contract) {
    throw new Error(
      `No OFT contract configured for route ${fromChainId} -> ${toChainId}`,
    );
  }
  return contract;
}

/**
 * Get the USDT contract address for a given chain
 */
export function getUSDTAddress(chainId: number): string {
  const address = USDT_CONTRACTS[chainId];
  if (!address) {
    throw new Error(`No USDT contract configured for chain ${chainId}`);
  }
  return address;
}

/**
 * Get the LayerZero EID for a given chain ID
 */
export function getEID(chainId: number): number {
  const eid = CHAIN_ID_TO_EID[chainId];
  if (eid === undefined) {
    throw new Error(`No EID configured for chain ${chainId}`);
  }
  return eid;
}

/**
 * Check if a route is supported.
 * Derived from OFT_CONTRACTS - a route is supported if an OFT contract exists for it.
 */
export function isSupportedRoute(
  fromChainId: number,
  toChainId: number,
): boolean {
  return OFT_CONTRACTS[fromChainId]?.[toChainId] !== undefined;
}

/**
 * Convert an address to bytes32 format for LayerZero.
 * Delegates to @hyperlane-xyz/utils addressToBytes32.
 */
export function addressToBytes32(address: string): string {
  return addressToBytes32Util(address);
}
