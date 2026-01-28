import { BigNumber, providers } from 'ethers';

import { IMessageRecipient } from '@hyperlane-xyz/core';
import { Address } from '@hyperlane-xyz/utils';

export const DEFAULT_CALL_GAS_FALLBACK = BigNumber.from(50_000);

export interface EstimateHandleGasParams {
  origin: number;
  sender: string;
  body: string;
  mailbox: Address;
  recipient: IMessageRecipient;
}

export interface EstimateCallGasParams {
  provider: providers.Provider;
  to: Address;
  data: string;
  value?: BigNumber;
  fallback?: BigNumber;
}

/**
 * Estimates gas for calling handle() on a recipient contract.
 * Returns null if estimation fails (e.g., call would revert).
 */
export async function estimateHandleGasForRecipient(
  params: EstimateHandleGasParams,
): Promise<BigNumber | null> {
  try {
    return await params.recipient.estimateGas.handle(
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
): Promise<BigNumber> {
  const fallback = params.fallback ?? DEFAULT_CALL_GAS_FALLBACK;
  try {
    return await params.provider.estimateGas({
      to: params.to,
      data: params.data,
      value: params.value,
    });
  } catch {
    return fallback;
  }
}
