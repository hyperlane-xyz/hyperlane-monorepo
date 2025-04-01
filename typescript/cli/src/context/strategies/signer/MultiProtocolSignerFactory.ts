import { password } from '@inquirer/prompts';
import { Signer, Wallet } from 'ethers';
import { Account as StarknetAccount, constants } from 'starknet';
import { Wallet as ZKSyncWallet } from 'zksync-ethers';

import {
  ChainName,
  ChainSubmissionStrategy,
  ChainTechnicalStack,
  MultiProvider,
  TxSubmitterType,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

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

  getSigner(config: SignerConfig): Signer {
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

  getSigner(config: SignerConfig): Signer {
    return new ZKSyncWallet(config.privateKey);
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
    return undefined;
  }

  getSigner({
    privateKey,
    userAddress,
    extraParams,
  }: SignerConfig): StarknetAccount {
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
