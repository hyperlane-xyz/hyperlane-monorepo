import { ethers } from 'ethers';

// ============================================================================
// Chain Configuration
// ============================================================================

export const CHAIN_ID_TO_EID: Record<number, number> = {
  1: 30101, // Ethereum
  42161: 30110, // Arbitrum
  7758: 30383, // Plasma
  728126428: 30420, // Tron
};

export const EID_TO_CHAIN_ID: Record<number, number> = {
  30101: 1, // Ethereum
  30110: 42161, // Arbitrum
  30383: 7758, // Plasma
  30420: 728126428, // Tron
};

// ============================================================================
// Contract Addresses
// ============================================================================

export const OFT_CONTRACTS: Record<number, Record<number, string>> = {
  1: {
    // Ethereum
    42161: '0x1f748c76de468e9d11bd340fa9d5cbadf315dfb0', // Legacy Mesh (Eth -> Arb)
    7758: '0x1f748c76de468e9d11bd340fa9d5cbadf315dfb0', // Legacy Mesh (Eth -> Plasma)
    728126428: '0x1f748c76de468e9d11bd340fa9d5cbadf315dfb0', // Legacy Mesh (Eth -> Tron)
  },
  42161: {
    // Arbitrum
    1: '0x77652d5aba086137b595875263fc200182919b92', // Legacy Mesh (Arb -> Eth)
    7758: '0x14E4A1B13bf7F943c8ff7C51fb60FA964A298D92', // Native OFT (Arb -> Plasma)
    728126428: '0x77652d5aba086137b595875263fc200182919b92', // Legacy Mesh (Arb -> Tron)
  },
  7758: {
    // Plasma
    1: '0x02ca37966753bDdDf11216B73B16C1dE756A7CF9', // Native OFT (Plasma -> Eth)
    42161: '0x02ca37966753bDdDf11216B73B16C1dE756A7CF9', // Native OFT (Plasma -> Arb)
    728126428: '0x02ca37966753bDdDf11216B73B16C1dE756A7CF9', // Native OFT (Plasma -> Tron)
  },
  728126428: {
    // Tron
    1: '0x3a08f76772e200653bb55c2a92998daca62e0e97', // Tron OFT (Tron -> Eth)
    42161: '0x3a08f76772e200653bb55c2a92998daca62e0e97', // Tron OFT (Tron -> Arb)
    7758: '0x3a08f76772e200653bb55c2a92998daca62e0e97', // Tron OFT (Tron -> Plasma)
  },
};

export const USDT_CONTRACTS: Record<number, string> = {
  1: '0xdAC17F958D2ee523a2206206994597C13D831ec7', // Ethereum USDT
  42161: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', // Arbitrum USDT
  7758: '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb', // Plasma USDT
  728126428: '0xa614f803B6FD780986A42c78Ec9c7f77e6DeD13C', // Tron USDT (hex)
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
  // other fields...
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
 * @param fromChainId Source chain ID
 * @param toChainId Destination chain ID
 * @returns OFT contract address
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
 * @param chainId Chain ID
 * @returns USDT contract address
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
 * @param chainId Chain ID
 * @returns LayerZero EID
 */
export function getEID(chainId: number): number {
  const eid = CHAIN_ID_TO_EID[chainId];
  if (eid === undefined) {
    throw new Error(`No EID configured for chain ${chainId}`);
  }
  return eid;
}

/**
 * Get the chain ID from a LayerZero EID
 * @param eid LayerZero EID
 * @returns Chain ID
 */
export function getChainIdFromEID(eid: number): number {
  const chainId = EID_TO_CHAIN_ID[eid];
  if (chainId === undefined) {
    throw new Error(`No chain ID configured for EID ${eid}`);
  }
  return chainId;
}

/**
 * Check if a route is supported
 * Supported routes (bidirectional):
 * - Tron <-> Arbitrum
 * - Tron <-> Ethereum
 * - Ethereum <-> Arbitrum
 * - Arbitrum <-> Plasma
 * @param fromChainId Source chain ID
 * @param toChainId Destination chain ID
 * @returns true if route is supported
 */
export function isSupportedRoute(
  fromChainId: number,
  toChainId: number,
): boolean {
  const supportedPairs = [
    [728126428, 42161], // Tron <-> Arbitrum
    [42161, 728126428],
    [728126428, 1], // Tron <-> Ethereum
    [1, 728126428],
    [1, 42161], // Ethereum <-> Arbitrum
    [42161, 1],
    [42161, 7758], // Arbitrum <-> Plasma
    [7758, 42161],
  ];

  return supportedPairs.some(
    ([from, to]) => from === fromChainId && to === toChainId,
  );
}

/**
 * Check if a chain is Tron
 * @param chainId Chain ID
 * @returns true if chain is Tron
 */
export function isTronChain(chainId: number): boolean {
  return chainId === 728126428;
}

/**
 * Normalizes a Tron address to TronWeb hex format (41...) for use with addressToBytes32.
 * Accepts both base58 (T...) and hex (41... or 0x...) formats.
 * Note: base58 conversion requires TronWeb at runtime; this function handles hex inputs only.
 * For base58 inputs, callers must pre-convert using tronWeb.address.toHex().
 */
export function normalizeTronAddress(address: string): string {
  if (address.startsWith('T') && address.length === 34) {
    throw new Error(
      `Cannot normalize Tron base58 address without TronWeb: ${address}. Pre-convert using tronWeb.address.toHex()`,
    );
  }
  if (address.startsWith('41') && address.length === 42) return address;
  const normalized = address.replace(/^0x/, '');
  if (normalized.length === 40) return `41${normalized}`;
  throw new Error(`Unrecognized Tron address format: ${address}`);
}

/**
 * Convert an address to bytes32 format for LayerZero
 * For Tron: normalizes to hex format, strips '41' prefix (2 chars), then pads to 32 bytes
 * For other chains: pads address to 32 bytes
 * @param address Address (TronWeb hex format for Tron, standard hex for others)
 * @param isTron Whether the address is from Tron
 * @returns bytes32 hex string
 */
export function addressToBytes32(address: string, isTron: boolean): string {
  if (isTron) {
    const hexAddr = normalizeTronAddress(address);
    const stripped = hexAddr.slice(2); // remove '41' prefix
    return ethers.utils.hexZeroPad('0x' + stripped, 32);
  }
  return ethers.utils.hexZeroPad(address, 32);
}
