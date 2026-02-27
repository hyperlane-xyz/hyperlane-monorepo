import type { Provider } from 'ethers';

import { IMessageRecipient } from '@hyperlane-xyz/core';
import { Address } from '@hyperlane-xyz/utils';

export const DEFAULT_CALL_GAS_FALLBACK = 50_000n;

export interface EstimateHandleGasParams {
  origin: number;
  sender: string;
  body: string;
  mailbox: Address;
  recipient: IMessageRecipient;
}

export interface EstimateCallGasParams {
  provider: Provider;
  to: Address;
  data: string;
  value?: bigint;
  fallback?: bigint;
}

/**
 * Estimates gas for calling handle() on a recipient contract.
 * Returns null if estimation fails (e.g., call would revert).
 */
export async function estimateHandleGasForRecipient(
  params: EstimateHandleGasParams,
): Promise<bigint | null> {
  try {
    // await required for catch to handle promise rejection
    return await params.recipient.handle.estimateGas(
      params.origin,
      params.sender,
      params.body,
      { from: params.mailbox },
    );
  } catch {
    return null;
  }
}

/**
 * Estimates gas for a single contract call.
 * Returns fallback value (default 50k) if estimation fails.
 */
export async function estimateCallGas(
  params: EstimateCallGasParams,
): Promise<bigint> {
  const fallback = params.fallback ?? DEFAULT_CALL_GAS_FALLBACK;
  try {
    // await required for catch to handle promise rejection
    return await params.provider.estimateGas({
      to: params.to,
      data: params.data,
      value: params.value,
    });
  } catch {
    return fallback;
  }
}
