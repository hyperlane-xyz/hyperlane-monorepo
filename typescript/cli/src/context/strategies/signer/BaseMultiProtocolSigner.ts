import { Signer, Wallet } from 'ethers';

import { ChainSubmissionStrategy } from '@hyperlane-xyz/sdk';
import { ChainName } from '@hyperlane-xyz/sdk';

export interface SignerConfig {
  privateKey: string;
  address?: string; // For chains like StarkNet that require address
  extraParams?: Record<string, any>; // For any additional chain-specific params
}

export interface IMultiProtocolSigner {
  getSignerConfig(chain: ChainName): Promise<SignerConfig> | SignerConfig;
  getSigner(config: SignerConfig): Signer;
}

export abstract class BaseMultiProtocolSigner implements IMultiProtocolSigner {
  constructor(protected config: ChainSubmissionStrategy) {}

  abstract getSignerConfig(
    chain: ChainName,
  ): Promise<SignerConfig> | SignerConfig;

  getSigner(config: SignerConfig): Signer {
    return new Wallet(config.privateKey);
  }
}
