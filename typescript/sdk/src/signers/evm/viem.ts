import {
  Chain,
  Hex,
  PublicClient,
  WalletClient,
  createPublicClient,
  createWalletClient,
  http,
  isHex,
  isAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { Address, ProtocolType, assert } from '@hyperlane-xyz/utils';

import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { EvmTransaction } from '../../providers/ProviderType.js';
import { ChainName } from '../../types.js';
import { IMultiProtocolSigner } from '../types.js';

import { toBigIntValue } from './types.js';

export class ViemMultiProtocolSignerAdapter implements IMultiProtocolSigner<ProtocolType.Ethereum> {
  private readonly account: ReturnType<typeof privateKeyToAccount>;
  private readonly walletClient: WalletClient<
    ReturnType<typeof http>,
    Chain,
    ReturnType<typeof privateKeyToAccount>
  >;
  private readonly publicClient: PublicClient<ReturnType<typeof http>, Chain>;

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
    const request = tx.transaction;
    const to = toAddress(request.to);
    const data = toHex(request.data);
    const sharedRequest = {
      account: this.account,
      to,
      data,
      value: toBigIntValue(request.value),
      nonce: toNumber(request.nonce),
      gas: toBigIntValue(request.gas ?? request.gasLimit),
    };
    const maxFeePerGas = toBigIntValue(request.maxFeePerGas);
    const maxPriorityFeePerGas = toBigIntValue(request.maxPriorityFeePerGas);
    const gasPrice = toBigIntValue(request.gasPrice);
    const hash =
      maxFeePerGas !== undefined || maxPriorityFeePerGas !== undefined
        ? await this.walletClient.sendTransaction({
            ...sharedRequest,
            type: 'eip1559',
            maxFeePerGas,
            maxPriorityFeePerGas,
          })
        : await this.walletClient.sendTransaction({
            ...sharedRequest,
            gasPrice,
          });

    await this.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }
}

function toAddress(value: unknown): `0x${string}` | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Invalid EVM address: ${String(value)}`);
  }
  assert(isAddress(value), `Invalid EVM address: ${value}`);
  return value;
}

function toHex(value: unknown): Hex | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Invalid hex value: ${String(value)}`);
  }
  assert(isHex(value), `Invalid hex value: ${value}`);
  return value;
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
