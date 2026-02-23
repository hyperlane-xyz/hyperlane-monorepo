import {
  Chain,
  Hex,
  PublicClient,
  WalletClient,
  createPublicClient,
  createWalletClient,
  http,
  isHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { Address, ProtocolType, assert } from '@hyperlane-xyz/utils';

import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { EvmTransaction } from '../../providers/ProviderType.js';
import { ChainName } from '../../types.js';
import { IMultiProtocolSigner } from '../types.js';

export class ViemMultiProtocolSignerAdapter implements IMultiProtocolSigner<ProtocolType.Ethereum> {
  private readonly account: ReturnType<typeof privateKeyToAccount>;
  private readonly walletClient: WalletClient;
  private readonly publicClient: PublicClient;

  constructor(
    chainName: ChainName,
    privateKey: string,
    multiProtocolProvider: MultiProtocolProvider,
  ) {
    assert(
      isHex(privateKey),
      `Private key for chain ${chainName} should be a hex string`,
    );

    this.account = privateKeyToAccount(privateKey);

    const chainMetadata = multiProtocolProvider.getChainMetadata(chainName);
    const rpcUrl = chainMetadata.rpcUrls[0]?.http;
    assert(rpcUrl, `Missing RPC URL for chain ${chainName}`);

    const chain: Chain = {
      id: Number(chainMetadata.chainId),
      name: chainMetadata.name,
      nativeCurrency: {
        name: chainMetadata.nativeToken?.name || 'Ether',
        symbol: chainMetadata.nativeToken?.symbol || 'ETH',
        decimals: chainMetadata.nativeToken?.decimals || 18,
      },
      rpcUrls: {
        default: { http: [rpcUrl] },
        public: { http: [rpcUrl] },
      },
    };
    const transport = http(rpcUrl);
    this.walletClient = createWalletClient({
      account: this.account,
      chain,
      transport,
    });
    this.publicClient = createPublicClient({
      chain,
      transport,
    });
  }

  async address(): Promise<Address> {
    return this.account.address;
  }

  async sendAndConfirmTransaction(tx: EvmTransaction): Promise<string> {
    const request = tx.transaction as Record<string, unknown>;
    const hash = await (this.walletClient as any).sendTransaction({
      account: this.account,
      to: request.to as `0x${string}` | undefined,
      data: request.data as Hex | undefined,
      value: toBigInt(request.value),
      nonce: toNumber(request.nonce),
      gas: toBigInt(request.gas ?? request.gasLimit),
      gasPrice: toBigInt(request.gasPrice),
      maxFeePerGas: toBigInt(request.maxFeePerGas),
      maxPriorityFeePerGas: toBigInt(request.maxPriorityFeePerGas),
    });

    await this.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }
}

function toBigInt(value: unknown): bigint | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  if (typeof value === 'string') return BigInt(value);
  if (typeof value === 'object' && 'toString' in value) {
    return BigInt(value.toString());
  }
  return undefined;
}

function toNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number(value);
  if (typeof value === 'object' && 'toString' in value) {
    return Number(value.toString());
  }
  return undefined;
}
