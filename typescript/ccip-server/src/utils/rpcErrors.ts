import { ethers } from 'ethers';

import { BlockchainError } from '@hyperlane-xyz/sdk/providers/SmartProvider/SmartProvider';
import { isMissingSelectorCallException } from '@hyperlane-xyz/sdk/utils/contract';

/** No RPC provider answered an onchain read. */
export class RpcUnavailableError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'RpcUnavailableError';
  }
}

/**
 * True when the chain answered the call: SmartProvider throws `BlockchainError`
 * for errors it deems permanent, an empty result or a revert without data reads
 * as a missing selector, and ethers throws a top-level CALL_EXCEPTION when it
 * cannot decode returned data or revert data. SmartProvider reports transport
 * failures and timeouts as the cause of a plain error instead.
 */
function isChainAnswer(error: unknown): boolean {
  return (
    error instanceof BlockchainError ||
    isMissingSelectorCallException(error) ||
    (error instanceof Error &&
      'code' in error &&
      error.code === ethers.errors.CALL_EXCEPTION)
  );
}

/**
 * Runs onchain reads, rethrowing a failure that no RPC provider answered as
 * `RpcUnavailableError` and anything the chain answered unchanged.
 */
export async function readOnchain<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (isChainAnswer(error)) throw error;
    throw new RpcUnavailableError(error);
  }
}
