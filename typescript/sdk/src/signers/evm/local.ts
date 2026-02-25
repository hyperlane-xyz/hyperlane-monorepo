import { Address, Hex, isHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { assert } from '@hyperlane-xyz/utils';
import type {
  EvmBigNumberish,
  EvmGasAmount,
  EvmProviderLike,
  EvmTransactionLike,
  EvmTransactionReceiptLike,
  EvmTransactionResponseLike,
} from '../../providers/evmTypes.js';

import {
  TypedDataDomainLike,
  TypedDataTypesLike,
  TypedDataValueLike,
  getTypedDataPrimaryType,
  ViemProviderLike,
  ViemTransactionRequestLike,
  toBigIntValue,
  toSerializableViemTransaction,
  toSignableMessage,
} from './types.js';

export type LocalViemTransactionRequest = ViemTransactionRequestLike & {
  data?: Hex;
};

type RpcSendable = {
  send(method: string, params: unknown[]): Promise<unknown>;
};

function hasRpcSend(
  provider: ViemProviderLike,
): provider is ViemProviderLike & RpcSendable {
  return typeof provider.send === 'function';
}

type BalanceReadable = {
  getBalance(
    address: Address | string,
    blockTag?: string | number,
  ): Promise<unknown>;
};

function hasBalanceReader(
  provider: ViemProviderLike,
): provider is ViemProviderLike & BalanceReadable {
  return typeof provider.getBalance === 'function';
}

function toChainId(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number(BigInt(value));
  return undefined;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number(BigInt(value));
  if (
    value &&
    typeof value === 'object' &&
    'toString' in value &&
    typeof value.toString === 'function'
  ) {
    return Number(BigInt(value.toString()));
  }
  return undefined;
}

function toLocalViemTransactionRequest(
  tx: EvmTransactionLike,
): LocalViemTransactionRequest {
  const request: LocalViemTransactionRequest = {
    to: tx.to,
    from: tx.from,
    value: tx.value,
    gas: tx.gas,
    gasLimit: tx.gasLimit,
    gasPrice: tx.gasPrice,
    maxFeePerGas: tx.maxFeePerGas,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
    chainId: toChainId(tx.chainId),
    nonce: toNumber(tx.nonce),
    type:
      toNumber(tx.type) ?? (typeof tx.type === 'string' ? tx.type : undefined),
    data: isHex(tx.data) ? tx.data : undefined,
  };
  return request;
}

function toViemProviderLike(
  provider: ViemProviderLike | EvmProviderLike,
): ViemProviderLike {
  const candidate = provider as Record<string, unknown>;
  assert(
    typeof candidate.estimateGas === 'function' &&
      typeof candidate.getFeeData === 'function' &&
      typeof candidate.getNetwork === 'function' &&
      typeof candidate.getTransactionCount === 'function' &&
      typeof candidate.sendTransaction === 'function',
    'Provider does not satisfy LocalAccountViemSigner requirements',
  );
  return provider as ViemProviderLike;
}

function isMissingRpcMethodError(error: unknown, method: string): boolean {
  const methodLower = method.toLowerCase();
  const snippets: string[] = [];

  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const message = record.message;
    const reason = record.reason;
    const nestedError = record.error;
    const cause = record.cause;

    if (typeof message === 'string') snippets.push(message);
    if (typeof reason === 'string') snippets.push(reason);

    if (nestedError && typeof nestedError === 'object') {
      const nestedMessage = (nestedError as Record<string, unknown>).message;
      if (typeof nestedMessage === 'string') snippets.push(nestedMessage);
    }

    if (cause && typeof cause === 'object') {
      const causeMessage = (cause as Record<string, unknown>).message;
      if (typeof causeMessage === 'string') snippets.push(causeMessage);
    }
  }

  const haystack = snippets.join(' ').toLowerCase();
  return (
    haystack.includes(methodLower) &&
    (haystack.includes('does not exist') ||
      haystack.includes('not available') ||
      haystack.includes('method not found'))
  );
}

export class LocalAccountViemSigner {
  public readonly account: ReturnType<typeof privateKeyToAccount>;
  public readonly address: string;
  public readonly provider: ViemProviderLike | undefined;
  private readonly privateKey: Hex;
  private sendQueue: Promise<void> = Promise.resolve();

  constructor(privateKey: string, provider?: ViemProviderLike) {
    assert(
      isHex(privateKey),
      'Private key for LocalAccountViemSigner must be hex',
    );
    this.privateKey = privateKey;
    this.account = privateKeyToAccount(this.privateKey);
    this.address = this.account.address;
    this.provider = provider;
  }

  connect(
    provider: ViemProviderLike | EvmProviderLike,
  ): LocalAccountViemSigner {
    return new LocalAccountViemSigner(
      this.privateKey,
      toViemProviderLike(provider),
    );
  }

  async getAddress(): Promise<string> {
    return this.address;
  }

  async getBalance(): Promise<EvmBigNumberish> {
    if (!this.provider) throw new Error('Provider required to get balance');
    if (hasBalanceReader(this.provider)) {
      const balance = await this.provider.getBalance(this.address);
      if (
        typeof balance === 'string' ||
        typeof balance === 'number' ||
        typeof balance === 'bigint'
      ) {
        return balance;
      }
      if (
        balance &&
        typeof (balance as { toString?: unknown }).toString === 'function'
      ) {
        return balance as { toString(): string };
      }
      throw new Error('Unable to convert balance');
    }
    if (hasRpcSend(this.provider)) {
      const balance = await this.provider.send('eth_getBalance', [
        this.address,
        'latest',
      ]);
      if (
        typeof balance === 'string' ||
        typeof balance === 'number' ||
        typeof balance === 'bigint'
      ) {
        return balance;
      }
      if (
        balance &&
        typeof (balance as { toString?: unknown }).toString === 'function'
      ) {
        return balance as { toString(): string };
      }
      throw new Error('Unable to convert balance');
    }
    throw new Error('Provider does not support getBalance');
  }

  async estimateGas(tx: EvmTransactionLike): Promise<EvmGasAmount> {
    if (!this.provider) throw new Error('Provider required to estimate gas');
    const request = toLocalViemTransactionRequest(tx);
    const estimated = await this.provider.estimateGas({
      ...request,
      from: request.from || this.address,
    });
    const asBigInt = toBigIntValue(estimated);
    if (asBigInt !== undefined) return asBigInt;
    if (
      estimated &&
      typeof (estimated as { toString?: unknown }).toString === 'function'
    ) {
      return estimated as { toString(): string };
    }
    throw new Error('Unable to convert estimated gas');
  }

  async signMessage(message: string | Uint8Array): Promise<Hex> {
    return this.account.signMessage({ message: toSignableMessage(message) });
  }

  async signTypedData(
    domain: TypedDataDomainLike,
    types: TypedDataTypesLike,
    value: TypedDataValueLike,
  ): Promise<Hex> {
    const primaryType = getTypedDataPrimaryType(types);
    const signRequest: Parameters<typeof this.account.signTypedData>[0] = {
      domain: domain as Parameters<
        typeof this.account.signTypedData
      >[0]['domain'],
      types: types as Parameters<typeof this.account.signTypedData>[0]['types'],
      primaryType: primaryType as Parameters<
        typeof this.account.signTypedData
      >[0]['primaryType'],
      message: value as Parameters<
        typeof this.account.signTypedData
      >[0]['message'],
    };
    return this.account.signTypedData(signRequest);
  }

  async _signTypedData(
    domain: TypedDataDomainLike,
    types: TypedDataTypesLike,
    value: TypedDataValueLike,
  ): Promise<Hex> {
    return this.signTypedData(domain, types, value);
  }

  async signTransaction(tx: LocalViemTransactionRequest): Promise<Hex> {
    const populated = await this.populateTransaction(tx);
    return this.account.signTransaction(
      toSerializableViemTransaction(populated),
    );
  }

  async sendTransaction(
    tx: EvmTransactionLike,
  ): Promise<EvmTransactionResponseLike> {
    if (!this.provider)
      throw new Error('Provider required to send transaction');
    return this.withSendLock(async () => {
      const signedTransaction = await this.signTransaction(
        toLocalViemTransactionRequest(tx),
      );
      const response = await this.provider!.sendTransaction(signedTransaction);
      return {
        ...response,
        hash: response.hash,
        wait: async (confirmations?: number) =>
          (await response.wait(
            confirmations,
          )) as EvmTransactionReceiptLike | null,
      };
    });
  }

  private async withSendLock<T>(runner: () => Promise<T>): Promise<T> {
    const previous = this.sendQueue;
    let release: (() => void) | undefined;
    this.sendQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await runner();
    } finally {
      release?.();
    }
  }

  async populateTransaction(
    transaction: LocalViemTransactionRequest,
  ): Promise<LocalViemTransactionRequest> {
    if (!this.provider)
      throw new Error('Provider required to populate transaction');

    const tx = { ...transaction };
    tx.from ||= this.address;

    if (tx.nonce == null) {
      try {
        tx.nonce = await this.provider.getTransactionCount(
          this.address,
          'pending',
        );
      } catch (error) {
        // Tron JSON-RPC does not expose eth_getTransactionCount; treat nonce as 0.
        if (isMissingRpcMethodError(error, 'eth_getTransactionCount')) {
          tx.nonce = 0;
        } else {
          throw error;
        }
      }
    }

    if (tx.chainId == null) {
      tx.chainId = await this.resolveChainId();
    }

    if (tx.gasPrice == null && tx.maxFeePerGas == null) {
      const feeData = await this.provider.getFeeData();
      if (feeData.maxFeePerGas) {
        tx.maxFeePerGas = toBigIntValue(feeData.maxFeePerGas);
        tx.maxPriorityFeePerGas =
          toBigIntValue(feeData.maxPriorityFeePerGas) || undefined;
      } else {
        tx.gasPrice = toBigIntValue(feeData.gasPrice) || undefined;
      }
    }

    if (tx.gas == null && tx.gasLimit == null) {
      tx.gas = toBigIntValue(await this.provider.estimateGas(tx));
    } else if (tx.gas == null && tx.gasLimit != null) {
      tx.gas = toBigIntValue(tx.gasLimit);
    }

    delete tx.gasLimit;
    return tx;
  }

  private async resolveChainId(): Promise<number> {
    if (!this.provider) throw new Error('Provider required to resolve chainId');

    if (hasRpcSend(this.provider)) {
      const rpcChainId = await this.provider.send('eth_chainId', []);
      const chainId = toChainId(rpcChainId);
      if (chainId !== undefined) return chainId;
    }

    const network = await this.provider.getNetwork();
    return network.chainId;
  }
}
