import { Wallet } from 'ethers';

import { Address, ProtocolType } from '@hyperlane-xyz/utils';

import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { EthersV5Transaction } from '../../providers/ProviderType.js';
import { ChainName } from '../../types.js';
import { IMultiProtocolSigner } from '../types.js';

export class EvmMultiProtocolSignerAdapter
  implements IMultiProtocolSigner<ProtocolType.Ethereum>
{
  private readonly multiProvider: MultiProvider;

  constructor(
    private readonly chainName: ChainName,
    privateKey: string,
    multiProtocolProvider: MultiProtocolProvider,
  ) {
    const multiProvider = multiProtocolProvider.toMultiProvider();

    multiProvider.setSigner(this.chainName, new Wallet(privateKey));
    this.multiProvider = multiProvider;
  }

  async address(): Promise<Address> {
    return this.multiProvider.getSignerAddress(this.chainName);
  }

  async sendTransaction(tx: EthersV5Transaction): Promise<string> {
    const res = await this.multiProvider.sendTransaction(
      this.chainName,
      tx.transaction,
    );

    return res.transactionHash;
  }
}
