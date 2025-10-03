import { password } from '@inquirer/prompts';
import { Signer } from 'ethers';

import { MultiProtocolProvider, TxSubmitterType } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { ExtendedChainSubmissionStrategy } from '../../../submitters/types.js';

export type TypedSigner = Signer;

export type SignerConfig = Omit<
  Extract<
    ExtendedChainSubmissionStrategy[string]['submitter'],
    { type: TxSubmitterType.JSON_RPC }
  >,
  'type'
>;

export interface IMultiProtocolSigner {
  getSigner(config: SignerConfig): Promise<TypedSigner>;
}

export abstract class BaseMultiProtocolSigner implements IMultiProtocolSigner {
  protected defaultProtocolConfig?: SignerConfig;

  constructor(
    protected readonly multiProtocolProvider: MultiProtocolProvider,
  ) {}

  abstract getSigner(config: SignerConfig): Promise<TypedSigner>;

  protected async getPrivateKey(
    config: SignerConfig,
  ): Promise<{ privateKey: string; address?: Address }> {
    let privateKey: string;
    let address: Address | undefined;
    if (config.privateKey) {
      privateKey = config.privateKey;
      address = config.userAddress;
    } else if (this.defaultProtocolConfig?.privateKey) {
      privateKey = this.defaultProtocolConfig.privateKey;
      address = this.defaultProtocolConfig.userAddress;
    } else {
      privateKey = await password({
        message: `Please enter the private key for chain ${config.chain} (will be re-used for other chains with the same protocol type)`,
      });

      this.defaultProtocolConfig = {
        chain: config.chain,
        privateKey,
      };
    }

    return { privateKey, address };
  }
}
