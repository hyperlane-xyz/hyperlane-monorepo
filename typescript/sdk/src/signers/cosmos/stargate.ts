import { DirectSecp256k1Wallet } from '@cosmjs/proto-signing';
import { SigningStargateClient } from '@cosmjs/stargate';

import { Address, ProtocolType, assert } from '@hyperlane-xyz/utils';

import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { CosmJsNativeTransaction } from '../../providers/ProviderType.js';
import { ChainName } from '../../types.js';
import { IMultiProtocolSigner } from '../types.js';

export class CosmosNativeMultiProtocolSignerAdapter
  implements IMultiProtocolSigner<ProtocolType.CosmosNative>
{
  constructor(
    private readonly accountAddress: Address,
    private readonly signer: SigningStargateClient,
  ) {}

  static async init(
    chainName: ChainName,
    privateKey: string,
    multiProtocolProvider: MultiProtocolProvider,
  ): Promise<CosmosNativeMultiProtocolSignerAdapter> {
    const { bech32Prefix, rpcUrls } =
      multiProtocolProvider.getChainMetadata(chainName);

    const [rpc] = rpcUrls;
    assert(bech32Prefix, 'prefix is required for cosmos chains');
    assert(rpc, 'rpc is required for configuring cosmos chains');

    const wallet = await DirectSecp256k1Wallet.fromKey(
      Buffer.from(privateKey, 'hex'),
      bech32Prefix,
    );

    const [account] = await wallet.getAccounts();
    assert(account, 'account not found for cosmos chain');
    const signer = await SigningStargateClient.connectWithSigner(
      rpc.http,
      wallet,
    );

    return new CosmosNativeMultiProtocolSignerAdapter(account.address, signer);
  }

  async address(): Promise<string> {
    return this.accountAddress;
  }

  async sendTransaction(tx: CosmJsNativeTransaction): Promise<string> {
    const estimatedFee = await this.signer.simulate(
      this.accountAddress,
      [tx.transaction],
      undefined,
    );

    const res = await this.signer.signAndBroadcast(
      this.accountAddress,
      [tx.transaction],
      estimatedFee * 1.1,
    );

    if (res.code !== 0) {
      throw new Error('Transaction failed');
    }

    return res.transactionHash;
  }
}
