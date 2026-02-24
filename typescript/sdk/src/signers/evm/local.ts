import { Hex, isHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { assert } from '@hyperlane-xyz/utils';

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

function toChainId(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number(BigInt(value));
  return undefined;
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

  connect(provider: ViemProviderLike): LocalAccountViemSigner {
    return new LocalAccountViemSigner(this.privateKey, provider);
  }

  async getAddress(): Promise<string> {
    return this.address;
  }

  async estimateGas(tx: LocalViemTransactionRequest): Promise<unknown> {
    if (!this.provider) throw new Error('Provider required to estimate gas');
    return this.provider.estimateGas({
      ...tx,
      from: tx.from || this.address,
    });
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
    return this.account.signTypedData({
      domain: domain as any,
      types: types as any,
      primaryType: primaryType as any,
      message: value as any,
    });
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
    tx: LocalViemTransactionRequest,
  ): Promise<{ hash: string; wait(confirmations?: number): Promise<unknown> }> {
    if (!this.provider)
      throw new Error('Provider required to send transaction');
    return this.withSendLock(async () => {
      const signedTransaction = await this.signTransaction(tx);
      return this.provider!.sendTransaction(signedTransaction);
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
      tx.nonce = await this.provider.getTransactionCount(
        this.address,
        'pending',
      );
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
