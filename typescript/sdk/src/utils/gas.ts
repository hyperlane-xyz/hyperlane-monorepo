import { Address } from '@hyperlane-xyz/utils';

export const DEFAULT_CALL_GAS_FALLBACK = 50_000n;

type GasValue = bigint | { toString(): string };
type GasEstimatingProvider = {
  estimateGas(tx: {
    to: Address;
    data: string;
    value?: bigint;
  }): Promise<GasValue>;
};

export interface EstimateHandleGasParams {
  origin: number;
  sender: string;
  body: string;
  mailbox: Address;
  recipient: {
    estimateGas: {
      handle: (
        origin: number,
        sender: string,
        body: string,
        overrides?: { from?: Address },
      ) => Promise<GasValue>;
    };
  };
}

export interface EstimateCallGasParams {
  provider: GasEstimatingProvider;
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
    const gasEstimate = await params.recipient.estimateGas.handle(
      params.origin,
      params.sender,
      params.body,
      { from: params.mailbox },
    );
    return BigInt(gasEstimate.toString());
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
    const gasEstimate = await params.provider.estimateGas({
      to: params.to,
      data: params.data,
      value: params.value,
    });
    return BigInt(gasEstimate.toString());
  } catch {
    return fallback;
  }
}
