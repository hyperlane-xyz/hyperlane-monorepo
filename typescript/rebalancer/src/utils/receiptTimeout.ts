import type { providers } from 'ethers';

import { assert } from '@hyperlane-xyz/utils';

/** Default deadline for waiting for a single on-chain transaction receipt. */
export const DEFAULT_RECEIPT_TIMEOUT_MS = 5 * 60 * 1000;

export type ReceiptWaitRole = 'primary' | 'approval';

export interface ReceiptWaitTimeoutOptions {
  txHash: string;
  operation: string;
  timeoutMs?: number;
  role?: ReceiptWaitRole;
}

export class ReceiptWaitTimeoutError extends Error {
  readonly txHash: string;
  readonly operation: string;
  readonly timeoutMs: number;
  readonly role: ReceiptWaitRole;

  constructor(options: ReceiptWaitTimeoutOptions) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS;
    const role = options.role ?? 'primary';
    super(
      `${options.operation} receipt wait timed out after ${timeoutMs}ms for tx ${options.txHash}`,
    );
    this.name = 'ReceiptWaitTimeoutError';
    this.txHash = options.txHash;
    this.operation = options.operation;
    this.timeoutMs = timeoutMs;
    this.role = role;
  }
}

export function isReceiptWaitTimeoutError(
  error: unknown,
): error is ReceiptWaitTimeoutError {
  return error instanceof ReceiptWaitTimeoutError;
}

/** Own the provider's bounded waiter so its transaction listener is removed on timeout. */
export async function waitForReceiptWithTimeout(
  waiter:
    | Pick<providers.Provider, 'waitForTransaction'>
    | Pick<providers.TransactionResponse, 'wait'>,
  options: ReceiptWaitTimeoutOptions,
): Promise<providers.TransactionReceipt> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS;
  assert(timeoutMs > 0, 'Receipt timeout must be positive');
  try {
    // ethers v5 implements wait(confirmations, timeout), although its public
    // TransactionResponse type omits timeout. Use that bounded waiter to keep
    // replacement detection. TronTransactionResponse implements the same form.
    const receipt =
      'wait' in waiter
        ? await (
            waiter.wait as (
              confirmations: number,
              timeout: number,
            ) => Promise<providers.TransactionReceipt>
          ).call(waiter, 1, timeoutMs)
        : await waiter.waitForTransaction(options.txHash, 1, timeoutMs);
    assert(
      receipt.status === 1,
      `${options.operation} transaction failed: ${options.txHash}`,
    );
    return receipt;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'TIMEOUT'
    ) {
      throw new ReceiptWaitTimeoutError({ ...options, timeoutMs });
    }
    throw error;
  }
}
