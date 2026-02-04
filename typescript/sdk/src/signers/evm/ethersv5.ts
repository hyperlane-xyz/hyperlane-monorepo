import { Wallet, ethers } from 'ethers';
import { Wallet as ZkSyncWallet } from 'zksync-ethers';

import { TronJsonRpcProvider, TronWallet } from '@hyperlane-xyz/tron-sdk';
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
    const { technicalStack, rpcUrls } =
      multiProvider.getChainMetadata(chainName);

    assert(
      ethers.utils.isHexString(privateKey),
      `Private key for chain ${chainName} should be a hex string`,
    );

    let wallet: Wallet;
    if (technicalStack === ChainTechnicalStack.ZkSync) {
      wallet = new ZkSyncWallet(privateKey);
    } else if (technicalStack === ChainTechnicalStack.Tron) {
      assert(
        rpcUrls.length > 0,
        `No RPC URLs configured for Tron chain ${chainName}`,
      );
      const rpcUrl = rpcUrls[0].http;
      const provider = new TronJsonRpcProvider(rpcUrl);
      // TronWeb needs the HTTP API URL, not JSON-RPC
      // Use second RPC URL if available, otherwise strip /jsonrpc from first URL
      const tronGridUrl =
        rpcUrls.length > 1 ? rpcUrls[1].http : rpcUrl.replace(/\/jsonrpc$/, '');
      wallet = new TronWallet(privateKey, provider, tronGridUrl);
    } else {
      wallet = new Wallet(privateKey);
    }

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
