import {
  DirectSecp256k1HdWallet,
  DirectSecp256k1Wallet,
} from '@cosmjs/proto-signing';
import { GasPrice } from '@cosmjs/stargate';
import { password } from '@inquirer/prompts';
import { Signer, Wallet, ethers } from 'ethers';
import { Account as StarknetAccount, constants } from 'starknet';
import { Wallet as ZKSyncWallet } from 'zksync-ethers';

import { SigningHyperlaneModuleClient } from '@hyperlane-xyz/cosmos-sdk';
import {
  ChainName,
  ChainSubmissionStrategy,
  ChainTechnicalStack,
  MultiProvider,
  TxSubmitterType,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert, ensure0x } from '@hyperlane-xyz/utils';

import { ENV } from '../../../utils/env.js';

import {
  BaseMultiProtocolSigner,
  IMultiProtocolSigner,
  SignerConfig,
} from './BaseMultiProtocolSigner.js';

export class MultiProtocolSignerFactory {
  static getSignerStrategy(
    chain: ChainName,
    strategyConfig: ChainSubmissionStrategy,
    multiProvider: MultiProvider,
  ): IMultiProtocolSigner {
    const { protocol, technicalStack } = multiProvider.getChainMetadata(chain);

    switch (protocol) {
      case ProtocolType.Ethereum:
        if (technicalStack === ChainTechnicalStack.ZkSync)
          return new ZKSyncSignerStrategy(strategyConfig);
        return new EthereumSignerStrategy(strategyConfig);
      case ProtocolType.CosmosNative:
        return new CosmosNativeSignerStrategy(strategyConfig);
      case ProtocolType.Starknet:
        return new StarknetSignerStrategy(strategyConfig);
      default:
        throw new Error(`Unsupported protocol: ${protocol}`);
    }
  }
}

class EthereumSignerStrategy extends BaseMultiProtocolSigner {
  async getSignerConfig(chain: ChainName): Promise<SignerConfig> {
    const submitter = this.config[chain]?.submitter as {
      type: TxSubmitterType.JSON_RPC;
      privateKey?: string;
    };

    const privateKey =
      submitter?.privateKey ??
      (await password({
        message: `Please enter the private key for chain ${chain}`,
      }));

    return { privateKey };
  }

  async getSigner(config: SignerConfig): Promise<Signer> {
    return new Wallet(config.privateKey);
  }
}

// 99% overlap with EthereumSignerStrategy for the sake of keeping MultiProtocolSignerFactory clean
class ZKSyncSignerStrategy extends BaseMultiProtocolSigner {
  async getSignerConfig(chain: ChainName): Promise<SignerConfig> {
    const submitter = this.config[chain]?.submitter as {
      privateKey?: string;
    };

    const privateKey =
      submitter?.privateKey ??
      (await password({
        message: `Please enter the private key for chain ${chain}`,
      }));

    return { privateKey };
  }

  async getSigner(config: SignerConfig): Promise<Signer> {
    return new ZKSyncWallet(config.privateKey);
  }
}

class CosmosNativeSignerStrategy extends BaseMultiProtocolSigner {
  async getSignerConfig(chain: ChainName): Promise<SignerConfig> {
    const submitter = this.config[chain]?.submitter as {
      privateKey?: string;
    };

    const privateKey =
      submitter?.privateKey ??
      (await password({
        message: `Please enter the private key for chain ${chain}`,
      }));

    return {
      privateKey,
    };
  }

  async getSigner({
    privateKey,
    extraParams,
  }: SignerConfig): Promise<SigningHyperlaneModuleClient> {
    assert(
      extraParams?.provider && extraParams?.prefix && extraParams?.gasPrice,
      'Missing Cosmos Signer arguments',
    );

    let wallet;

    if (ethers.utils.isHexString(ensure0x(privateKey))) {
      wallet = await DirectSecp256k1Wallet.fromKey(
        Buffer.from(privateKey, 'hex'),
        extraParams.prefix,
      );
    } else {
      wallet = await DirectSecp256k1HdWallet.fromMnemonic(privateKey, {
        prefix: extraParams.prefix,
      });
    }

    const cometClient = extraParams?.provider.getCometClient();

    // parse gas price so it has the correct format
    const gasPrice = GasPrice.fromString(
      `${extraParams.gasPrice.amount}${extraParams.gasPrice.denom}`,
    );

    return SigningHyperlaneModuleClient.createWithSigner(cometClient, wallet, {
      gasPrice,
    });
  }
}

class StarknetSignerStrategy extends BaseMultiProtocolSigner {
  async getSignerConfig(chain: ChainName): Promise<SignerConfig> {
    const submitter = this.config[chain]?.submitter as {
      privateKey?: string;
      userAddress?: string;
    };

    const privateKey =
      submitter?.privateKey ??
      (await password({
        message: `Please enter the private key for chain ${chain}`,
      }));

    const address =
      submitter?.userAddress ??
      (await password({
        message: `Please enter the signer address for chain ${chain}`,
      }));

    return { privateKey, userAddress: address };
  }

  private getTransactionVersion(
    versionFromEnv?: string,
  ): ConstructorParameters<typeof StarknetAccount>[4] {
    if (versionFromEnv === 'V2') return constants.TRANSACTION_VERSION.V2;
    if (versionFromEnv === 'V3') return constants.TRANSACTION_VERSION.V3;
    return constants.TRANSACTION_VERSION.V3;
  }

  async getSigner({
    privateKey,
    userAddress,
    extraParams,
  }: SignerConfig): Promise<StarknetAccount> {
    assert(
      userAddress && extraParams?.provider,
      'Missing StarknetAccount arguments',
    );

    const transactionVersion = this.getTransactionVersion(
      ENV.STARKNET_TRANSACTION_VERSION,
    );

    return new StarknetAccount(
      extraParams.provider,
      userAddress,
      privateKey,
      undefined,
      transactionVersion,
    );
  }
}
