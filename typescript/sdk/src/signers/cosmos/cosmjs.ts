import { DirectSecp256k1Wallet } from '@cosmjs/proto-signing';
import { GasPrice, SigningStargateClient } from '@cosmjs/stargate';

import { Address, ProtocolType, assert, strip0x } from '@hyperlane-xyz/utils';

import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { CosmJsNativeTransaction } from '../../providers/ProviderType.js';
import { ChainName } from '../../types.js';
import { IMultiProtocolSigner } from '../types.js';

export class CosmosNativeMultiProtocolSignerAdapter implements IMultiProtocolSigner<ProtocolType.CosmosNative> {
  constructor(
    private readonly chainName: ChainName,
    private readonly accountAddress: Address,
    private readonly signer: SigningStargateClient,
  ) {}

  static async init(
    chainName: ChainName,
    privateKey: string,
    multiProtocolProvider: MultiProtocolProvider,
  ): Promise<CosmosNativeMultiProtocolSignerAdapter> {
    const { bech32Prefix, rpcUrls, gasPrice } =
      multiProtocolProvider.getChainMetadata(chainName);

    const [rpc] = rpcUrls;
    assert(bech32Prefix, 'prefix is required for cosmos chains');
    assert(rpc, 'rpc is required for configuring cosmos chains');
    assert(gasPrice, 'gas price is required for cosmos chains');

    const wallet = await DirectSecp256k1Wallet.fromKey(
      Buffer.from(strip0x(privateKey), 'hex'),
      bech32Prefix,
    );

    const [account] = await wallet.getAccounts();
    assert(account, 'account not found for cosmos chain');
    const signer = await SigningStargateClient.connectWithSigner(
      rpc.http,
      wallet,
      {
        gasPrice: GasPrice.fromString(`${gasPrice.amount}${gasPrice.denom}`),
      },
    );

    return new CosmosNativeMultiProtocolSignerAdapter(
      chainName,
      account.address,
      signer,
    );
  }

  async address(): Promise<string> {
    return this.accountAddress;
  }

  async sendAndConfirmTransaction(
    tx: CosmJsNativeTransaction,
  ): Promise<string> {
    await this.signer.simulate(
      this.accountAddress,
      [tx.transaction],
      undefined,
    );

    const res = await this.signer.signAndBroadcast(
      this.accountAddress,
      [tx.transaction],
      'auto',
    );

    if (res.code !== 0) {
      throw new Error(
        `Transaction ${res.transactionHash} failed on chain ${this.chainName}`,
      );
    }

    return res.transactionHash;
  }
}
