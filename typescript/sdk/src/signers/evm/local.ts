import { Hex, isHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { assert } from '@hyperlane-xyz/utils';

import { ViemProviderLike, ViemTransactionRequestLike } from './types.js';

export type LocalViemTransactionRequest = ViemTransactionRequestLike & {
  data?: Hex;
};

const toBigIntValue = (value: unknown): bigint | undefined =>
  value === null || value === undefined ? undefined : BigInt(value.toString());

export class LocalAccountEvmSigner {
  public readonly account: ReturnType<typeof privateKeyToAccount>;
  public readonly address: string;
  public readonly provider: ViemProviderLike | undefined;

  constructor(
    private readonly privateKey: Hex,
    provider?: ViemProviderLike,
  ) {
    assert(
      isHex(privateKey),
      'Private key for LocalAccountEvmSigner must be hex',
    );
    this.account = privateKeyToAccount(privateKey);
    this.address = this.account.address;
    this.provider = provider;
  }

  connect(provider: ViemProviderLike): LocalAccountEvmSigner {
    return new LocalAccountEvmSigner(this.privateKey, provider);
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
    return this.account.signMessage({ message: message as any });
  }

  async signTransaction(tx: LocalViemTransactionRequest): Promise<Hex> {
    const populated = await this.populateTransaction(tx);
    return this.account.signTransaction(populated as any);
  }

  async sendTransaction(
    tx: LocalViemTransactionRequest,
  ): Promise<{ hash: string; wait(confirmations?: number): Promise<unknown> }> {
    if (!this.provider)
      throw new Error('Provider required to send transaction');
    const signedTransaction = await this.signTransaction(tx);
    return this.provider.sendTransaction(signedTransaction);
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
      const network = await this.provider.getNetwork();
      tx.chainId = network.chainId;
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
}
