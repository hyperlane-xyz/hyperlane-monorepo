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
 * EIP-7702 delegation indicator prefix.
 * When this prefix + an address is set as an EOA's code, calls to the EOA
 * execute the code at the specified address.
 */
export const EIP7702_MAGIC_PREFIX = '0xef0100';

/**
 * Probe request for detecting EIP-7702 support via eth_estimateGas.
 * Uses state override with EIP-7702 delegation code to test if the RPC understands it.
 * @see https://medium.com/@Jingkangchua/how-to-quickly-verify-eip-7702-support-on-any-evm-chain-39975a08dcd4
 */
export const EIP7702_DETECTION_REQUEST = {
  jsonrpc: '2.0',
  method: 'eth_estimateGas',
  params: [
    {
      from: '0xdeadbeef00000000000000000000000000000000',
      to: '0xdeadbeef00000000000000000000000000000000',
      // ecrecover precompile call data (r, s, v parameters)
      data: '0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
      value: '0x0',
    },
    'latest',
    {
      // State override: set EOA code to EIP-7702 delegation to ecrecover precompile
      '0xdeadbeef00000000000000000000000000000000': {
        code: '0xef01000000000000000000000000000000000000000001',
      },
    },
  ],
  id: 1,
} as const;

/**
 * Dynamically check if an RPC endpoint supports EIP-7702.
 * Uses eth_estimateGas with a state override containing EIP-7702 delegation code.
 * @param rpcUrl - The RPC endpoint URL to check
 * @returns true if the RPC supports EIP-7702
 */
export async function checkEIP7702Support(rpcUrl: string): Promise<boolean> {
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(EIP7702_DETECTION_REQUEST),
    });

    const result = await response.json();

    // If we get a result (gas estimate), the RPC supports EIP-7702
    // If we get an error, it doesn't understand the EIP-7702 code format
    return result.result !== undefined && !result.error;
  } catch {
    return false;
  }
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
