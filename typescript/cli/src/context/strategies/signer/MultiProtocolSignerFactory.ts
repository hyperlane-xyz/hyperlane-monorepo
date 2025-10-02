import { Signer, Wallet } from 'ethers';
import { Wallet as ZKSyncWallet } from 'zksync-ethers';

import { CosmosNativeSigner } from '@hyperlane-xyz/cosmos-sdk';
import { ChainTechnicalStack, MultiProtocolProvider } from '@hyperlane-xyz/sdk';
import { MultiVM, ProtocolType, assert } from '@hyperlane-xyz/utils';

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
      case ProtocolType.CosmosNative:
        return new CosmosNativeSignerStrategy(multiProtocolProvider);
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

class CosmosNativeSignerStrategy extends BaseMultiProtocolSigner {
  async getSigner(config: SignerConfig): Promise<MultiVM.ISigner> {
    const { privateKey } = await this.getPrivateKey(config);

    const provider = await this.multiProtocolProvider.getCosmJsNativeProvider(
      config.chain,
    );
    const { bech32Prefix, gasPrice: nativeTokenConfig } =
      this.multiProtocolProvider.getChainMetadata(config.chain);

    assert(
      bech32Prefix && nativeTokenConfig,
      'Missing Cosmos Signer arguments',
    );

    // parse gas price so it has the correct format
    const gasPrice = `${nativeTokenConfig.amount}${nativeTokenConfig.denom}`;

    return CosmosNativeSigner.connectWithSigner(
      provider.getRpcUrl(),
      privateKey,
      {
        bech32Prefix,
        gasPrice,
      },
    );
  }
}
