import {
  DirectSecp256k1HdWallet,
  DirectSecp256k1Wallet,
} from '@cosmjs/proto-signing';
import { GasPrice } from '@cosmjs/stargate';
import { Signer, Wallet, ethers } from 'ethers';
import { Wallet as ZKSyncWallet } from 'zksync-ethers';

import { SigningHyperlaneModuleClient } from '@hyperlane-xyz/cosmos-sdk';
import { ChainTechnicalStack, MultiProtocolProvider } from '@hyperlane-xyz/sdk';
import { ProtocolType, assert, ensure0x } from '@hyperlane-xyz/utils';

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
  async getSigner(config: SignerConfig): Promise<SigningHyperlaneModuleClient> {
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

    let wallet;

    if (ethers.utils.isHexString(ensure0x(privateKey))) {
      wallet = await DirectSecp256k1Wallet.fromKey(
        Buffer.from(privateKey, 'hex'),
        bech32Prefix,
      );
    } else {
      wallet = await DirectSecp256k1HdWallet.fromMnemonic(privateKey, {
        prefix: bech32Prefix,
      });
    }

    const cometClient = provider.getCometClientOrFail();

    // parse gas price so it has the correct format
    const gasPrice = GasPrice.fromString(
      `${nativeTokenConfig.amount}${nativeTokenConfig.denom}`,
    );

    return SigningHyperlaneModuleClient.createWithSigner(cometClient, wallet, {
      gasPrice,
    });
  }
}
