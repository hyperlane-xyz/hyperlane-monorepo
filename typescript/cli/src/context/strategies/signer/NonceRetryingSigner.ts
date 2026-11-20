import { errors as EthersError, ethers } from 'ethers';

import { assert, rootLogger, sleep } from '@hyperlane-xyz/utils';

const DEFAULT_RETRY_DELAY_MS = 5_000;

const logger = rootLogger.child({ module: 'NonceRetryingSigner' });

interface TypedDataSigner {
  _signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, Array<ethers.TypedDataField>>,
    value: Record<string, unknown>,
  ): Promise<string>;
}

function supportsTypedDataSigning(
  signer: ethers.Signer,
): signer is ethers.Signer & TypedDataSigner {
  return (
    '_signTypedData' in signer && typeof signer._signTypedData === 'function'
  );
}

function getNestedProperty(
  value: unknown,
  property: string,
): unknown | undefined {
  const pending = [value];
  const visited = new Set<object>();

  while (pending.length > 0) {
    const current = pending.shift();
    if (typeof current !== 'object' || current === null) continue;
    if (visited.has(current)) continue;
    visited.add(current);

    const result = Reflect.get(current, property);
    if (result !== undefined) return result;

    pending.push(Reflect.get(current, 'cause'));
    pending.push(Reflect.get(current, 'error'));
  }

  return undefined;
}

function isNonceExpired(error: unknown): boolean {
  const pending = [error];
  const visited = new Set<object>();

  while (pending.length > 0) {
    const current = pending.shift();
    if (typeof current !== 'object' || current === null) continue;
    if (visited.has(current)) continue;
    visited.add(current);

    if (Reflect.get(current, 'code') === EthersError.NONCE_EXPIRED) return true;

    pending.push(Reflect.get(current, 'cause'));
    pending.push(Reflect.get(current, 'error'));
  }

  return false;
}

function getTransactionHash(error: unknown): string | undefined {
  const hash = getNestedProperty(error, 'transactionHash');
  if (typeof hash === 'string') return hash;

  const transaction = getNestedProperty(error, 'transaction');
  if (typeof transaction !== 'object' || transaction === null) return undefined;
  const transactionHash = Reflect.get(transaction, 'hash');
  return typeof transactionHash === 'string' ? transactionHash : undefined;
}

/**
 * Retries one implicitly nonced transaction after re-populating and re-signing
 * it. The signed transaction itself is never re-broadcast.
 */
export class NonceRetryingSigner extends ethers.Signer {
  declare readonly provider?: ethers.providers.Provider;

  constructor(
    private readonly signer: ethers.Signer,
    private readonly retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  ) {
    super();
    ethers.utils.defineReadOnly(this, 'provider', signer.provider);
  }

  connect(provider: ethers.providers.Provider): NonceRetryingSigner {
    return new NonceRetryingSigner(
      this.signer.connect(provider),
      this.retryDelayMs,
    );
  }

  getAddress(): Promise<string> {
    return this.signer.getAddress();
  }

  signMessage(message: string | ethers.utils.Bytes): Promise<string> {
    return this.signer.signMessage(message);
  }

  signTransaction(
    transaction: ethers.utils.Deferrable<ethers.providers.TransactionRequest>,
  ): Promise<string> {
    return this.signer.signTransaction(transaction);
  }

  _signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, Array<ethers.TypedDataField>>,
    value: Record<string, unknown>,
  ): Promise<string> {
    assert(
      supportsTypedDataSigning(this.signer),
      'Wrapped signer does not support typed data signing',
    );
    return this.signer._signTypedData(domain, types, value);
  }

  override async sendTransaction(
    transaction: ethers.providers.TransactionRequest,
  ): Promise<ethers.providers.TransactionResponse> {
    try {
      return await this.signer.sendTransaction(transaction);
    } catch (error) {
      if (transaction.nonce != null || !isNonceExpired(error)) throw error;

      await sleep(this.retryDelayMs);

      const rejectedHash = getTransactionHash(error);
      if (rejectedHash && this.provider) {
        try {
          const acceptedTransaction =
            await this.provider.getTransaction(rejectedHash);
          if (acceptedTransaction) return acceptedTransaction;
        } catch (lookupError) {
          logger.warn(
            { error: lookupError, transactionHash: rejectedHash },
            'Failed to check nonce-expired transaction hash before retry',
          );
        }
      }

      logger.warn(
        { transactionHash: rejectedHash },
        'Nonce expired; re-populating and re-signing transaction once',
      );
      return this.signer.sendTransaction({ ...transaction, nonce: undefined });
    }
  }
}
