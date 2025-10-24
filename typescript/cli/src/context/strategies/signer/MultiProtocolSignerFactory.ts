import { Signer, Wallet } from 'ethers';
import { Wallet as ZKSyncWallet } from 'zksync-ethers';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { ChainTechnicalStack, MultiProtocolProvider } from '@hyperlane-xyz/sdk';

import {
  BaseMultiProtocolSigner,
  IMultiProtocolSigner,
  SignerConfig,
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

    const { technicalStack } = this.multiProtocolProvider.getChainMetadata(
      config.chain,
    );
    if (technicalStack === ChainTechnicalStack.ZkSync) {
      return new ZKSyncWallet(privateKey);
    }

    return new Wallet(privateKey);
  }
}
