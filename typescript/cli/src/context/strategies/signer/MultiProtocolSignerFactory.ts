import { password } from '@inquirer/prompts';
import { ApiKeyStamper } from '@turnkey/api-key-stamper';
import { TurnkeySigner } from '@turnkey/ethers';
import { TurnkeyClient } from '@turnkey/http';
import { Signer } from 'ethers';
import { Wallet as ZKSyncWallet } from 'zksync-ethers';

import {
  ChainName,
  ChainSubmissionStrategy,
  ChainTechnicalStack,
  MultiProvider,
  TxSubmitterType,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

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
      default:
        throw new Error(`Unsupported protocol: ${protocol}`);
    }
  }
}

const apiPublicKey = process.env.API_PUBLIC_KEY!;
const apiPrivateKey = process.env.API_PRIVATE_KEY!;
const organizationId = process.env.ORGANIZATION_ID!;
const signWith = process.env.SIGN_WITH!;

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

  getSigner(): Signer {
    const client = new TurnkeyClient(
      { baseUrl: 'https://api.turnkey.com' },
      new ApiKeyStamper({
        apiPublicKey,
        apiPrivateKey,
      }),
    );

    const turnkeySigner = new TurnkeySigner({
      client,
      organizationId,
      signWith,
    });

    return turnkeySigner;
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
