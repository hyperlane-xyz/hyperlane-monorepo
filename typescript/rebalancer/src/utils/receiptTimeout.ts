import { timeout } from '@hyperlane-xyz/utils';

/** Default deadline for waiting for a single on-chain receipt. */
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

export function throwReceiptWaitTimeout(
  options: ReceiptWaitTimeoutOptions,
): never {
  throw new ReceiptWaitTimeoutError(options);
}

export function isEthersTimeoutError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'TIMEOUT'
  );
}

export async function waitForReceiptWithTimeout<T>(
  receiptPromise: Promise<T>,
  options: ReceiptWaitTimeoutOptions,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS;
  const sentinel = [
    '__receipt_wait_timeout__',
    options.role ?? 'primary',
    options.operation,
    options.txHash,
    timeoutMs,
  ].join(':');

  try {
    return await timeout(receiptPromise, timeoutMs, sentinel);
  } catch (error) {
    if (error instanceof Error && error.message === sentinel) {
      throw new ReceiptWaitTimeoutError({ ...options, timeoutMs });
    }
    throw error;
  }
}

export async function adaptNativeReceiptTimeout<T>(
  receiptPromise: Promise<T>,
  options: ReceiptWaitTimeoutOptions,
): Promise<NonNullable<T>> {
  let receipt: T;
  try {
    receipt = await receiptPromise;
  } catch (error) {
    if (isEthersTimeoutError(error)) {
      throw new ReceiptWaitTimeoutError(options);
    }
    throw error;
  }

  if (receipt == null) {
    throwReceiptWaitTimeout(options);
  }
  return receipt;
}
