import { type Signer, Wallet } from 'ethers';
import { Wallet as ZKSyncWallet } from 'zksync-ethers';

import {
  ChainTechnicalStack,
  type MultiProtocolProvider,
} from '@hyperlane-xyz/sdk';
import { TronWallet } from '@hyperlane-xyz/tron-sdk';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import {
  BaseMultiProtocolSigner,
  type IMultiProtocolSigner,
  type SignerConfig,
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

class EvmSignerStrategy extends BaseMultiProtocolSigner {
  async getSigner(config: SignerConfig): Promise<Signer> {
    const { privateKey } = await this.getPrivateKey(config);

    const { technicalStack, rpcUrls } =
      this.multiProtocolProvider.getChainMetadata(config.chain);

    if (technicalStack === ChainTechnicalStack.ZkSync) {
      return new ZKSyncWallet(privateKey) as unknown as Signer;
    }

    if (technicalStack === ChainTechnicalStack.Tron) {
      assert(rpcUrls.length > 0, `No RPC URLs for Tron chain ${config.chain}`);
      return new TronWallet(privateKey, rpcUrls[0].http) as unknown as Signer;
    }

    return new Wallet(privateKey) as unknown as Signer;
  }
}
