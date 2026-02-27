import {
  ChainTechnicalStack,
  LocalAccountViemSigner,
  type MultiProtocolProvider,
} from '@hyperlane-xyz/sdk';
import { TronWallet } from '@hyperlane-xyz/tron-sdk';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';
import type { BigNumberish, providers } from 'ethers';

import {
  BaseMultiProtocolSigner,
  type IMultiProtocolSigner,
  type SignerConfig,
  type TypedSigner,
} from './BaseMultiProtocolSigner.js';

export class MultiProtocolSignerFactory {
  static getSignerStrategy(
    protocol: ProtocolType,
    multiProtocolProvider: MultiProtocolProvider,
  ): IMultiProtocolSigner {
    switch (protocol) {
      case ProtocolType.Ethereum:
        return new EvmSignerStrategy(multiProtocolProvider);
      default:
        throw new Error(`Unsupported protocol: ${protocol}`);
    }
  }
}

type SignerTransactionRequest = Parameters<TypedSigner['sendTransaction']>[0];
type SignerTransactionResponse = Awaited<
  ReturnType<TypedSigner['sendTransaction']>
>;
type SignerGasAmount = Awaited<ReturnType<TypedSigner['estimateGas']>>;
type SignerBalance = Awaited<ReturnType<TypedSigner['getBalance']>>;
type SignerBigNumberish = string | number | bigint | { toString(): string };

function toEthersBigNumberish(
  value: SignerBigNumberish | undefined,
): BigNumberish | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint'
  ) {
    return value;
  }
  return value.toString();
}

function toNumber(value: SignerBigNumberish | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return Number(BigInt(value.toString()));
}

function toTronTransactionRequest(
  tx: SignerTransactionRequest,
): providers.TransactionRequest {
  return {
    to: tx.to,
    from: tx.from,
    data: tx.data,
    value: toEthersBigNumberish(tx.value),
    gasLimit: toEthersBigNumberish(tx.gasLimit ?? tx.gas),
    gasPrice: toEthersBigNumberish(tx.gasPrice),
    maxFeePerGas: toEthersBigNumberish(tx.maxFeePerGas),
    maxPriorityFeePerGas: toEthersBigNumberish(tx.maxPriorityFeePerGas),
    nonce: toNumber(tx.nonce),
    chainId: toNumber(tx.chainId),
    type: toNumber(tx.type),
  };
}

class TronSignerAdapter {
  public readonly provider: unknown;

  constructor(private readonly wallet: TronWallet) {
    this.provider = wallet.provider;
  }

  connect(_provider: unknown): TypedSigner {
    return new TronSignerAdapter(this.wallet);
  }

  async getAddress(): Promise<string> {
    return this.wallet.getAddress();
  }

  async estimateGas(
    transaction: SignerTransactionRequest,
  ): Promise<SignerGasAmount> {
    return this.wallet.estimateGas(toTronTransactionRequest(transaction));
  }

  async sendTransaction(
    transaction: SignerTransactionRequest,
  ): Promise<SignerTransactionResponse> {
    return this.wallet.sendTransaction(toTronTransactionRequest(transaction));
  }

  async getBalance(): Promise<SignerBalance> {
    return this.wallet.getBalance();
  }
}

class EvmSignerStrategy extends BaseMultiProtocolSigner {
  async getSigner(config: SignerConfig): Promise<TypedSigner> {
    const { privateKey } = await this.getPrivateKey(config);
    const chainMetadata = this.multiProtocolProvider.getChainMetadata(
      config.chain,
    );
    if (chainMetadata.technicalStack === ChainTechnicalStack.Tron) {
      const rpcUrl = chainMetadata.rpcUrls[0]?.http;
      assert(rpcUrl, `Missing RPC URL for chain ${config.chain}`);
      const tronBaseUrl = rpcUrl.endsWith('/jsonrpc')
        ? rpcUrl.slice(0, -'/jsonrpc'.length)
        : rpcUrl;
      return new TronSignerAdapter(new TronWallet(privateKey, tronBaseUrl));
    }
    return new LocalAccountViemSigner(privateKey);
  }
}
