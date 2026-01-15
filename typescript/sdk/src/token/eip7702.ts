import type { Address } from '@hyperlane-xyz/utils';

/**
 * Standard Multicall3 address deployed on most EVM chains.
 * This is the same contract used by the Hyperlane Lander agent for transaction batching.
 * @see https://www.multicall3.com/
 */
export const MULTICALL3_ADDRESS: Address =
  '0xcA11bde05977b3631167028862bE2a173976CA11';

/**
 * Call structure for Multicall3.aggregate3Value
 * Represents a single call in a batch with value transfer support
 */
export interface Call3Value {
  /** Target contract address */
  target: Address;
  /** Whether the call is allowed to fail without reverting the batch */
  allowFailure: boolean;
  /** ETH value to send with the call */
  value: bigint;
  /** Encoded function call data */
  callData: string;
}

/**
 * Result structure from Multicall3.aggregate3Value
 */
export interface Multicall3Result {
  /** Whether the call succeeded */
  success: boolean;
  /** Return data from the call */
  returnData: string;
}

/**
 * Minimal ABI for Multicall3.aggregate3Value function
 * This function allows batching multiple calls with different ETH values
 */
export const MULTICALL3_AGGREGATE3VALUE_ABI = [
  {
    name: 'aggregate3Value',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'allowFailure', type: 'bool' },
          { name: 'value', type: 'uint256' },
          { name: 'callData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      {
        name: 'returnData',
        type: 'tuple[]',
        components: [
          { name: 'success', type: 'bool' },
          { name: 'returnData', type: 'bytes' },
        ],
      },
    ],
  },
] as const;

/**
 * Minimal ABI for ERC20.approve function
 */
export const ERC20_APPROVE_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

/**
 * Chains known to support EIP-7702 (Pectra upgrade).
 * This list will expand as more chains adopt Pectra.
 */
export const EIP7702_SUPPORTED_CHAINS = [
  'ethereum',
  'sepolia',
  'holesky',
] as const;

export type EIP7702SupportedChain = (typeof EIP7702_SUPPORTED_CHAINS)[number];

/**
 * Check if a chain name is known to support EIP-7702
 * @param chainName - The chain name to check
 * @returns true if the chain supports EIP-7702
 */
export function isEIP7702SupportedChain(chainName: string): boolean {
  return EIP7702_SUPPORTED_CHAINS.includes(chainName as EIP7702SupportedChain);
}

/**
 * Parameters for building EIP-7702 batch transfer calls
 */
export interface EIP7702BatchTransferParams {
  /** Address of the ERC20 token to approve */
  tokenAddress: Address;
  /** Address of the warp route (spender) */
  warpRouteAddress: Address;
  /** Exact amount to approve (not uint256.max) */
  approvalAmount: bigint;
  /** Encoded transferRemote call data */
  transferRemoteCallData: string;
  /** ETH value for interchain gas payment */
  interchainFeeValue: bigint;
}
