import { Wallet, ethers } from 'ethers';
import { Wallet as ZkSyncWallet } from 'zksync-ethers';

import { Address, ProtocolType, assert } from '@hyperlane-xyz/utils';

import { ChainTechnicalStack } from '../../index.js';
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
    const { technicalStack } = multiProvider.getChainMetadata(chainName);

    assert(
      ethers.utils.isHexString(privateKey),
      `Private key for chain ${chainName} should be a hex string`,
    );

    const wallet =
      technicalStack === ChainTechnicalStack.ZkSync
        ? new ZkSyncWallet(privateKey)
        : new Wallet(privateKey);
    multiProvider.setSigner(this.chainName, wallet);
    this.multiProvider = multiProvider;
  }

  async address(): Promise<Address> {
    return this.multiProvider.getSignerAddress(this.chainName);
  }

  async sendAndConfirmTransaction(tx: EthersV5Transaction): Promise<string> {
    const res = await this.multiProvider.sendTransaction(
      this.chainName,
      tx.transaction,
    );

    return res.transactionHash;
  }
}
