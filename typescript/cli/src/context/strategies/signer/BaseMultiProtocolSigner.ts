import { Signer } from 'ethers';

import { SigningHyperlaneModuleClient } from '@hyperlane-xyz/cosmos-sdk';
import { ChainName, ChainSubmissionStrategy } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

export type TypedSigner = Signer | SigningHyperlaneModuleClient;

export interface SignerConfig {
  privateKey: string;
  address?: Address; // For chains like StarkNet that require address
  extraParams?: Record<string, any>; // For any additional chain-specific params
}

export interface IMultiProtocolSigner {
  getSignerConfig(chain: ChainName): Promise<SignerConfig> | SignerConfig;
  getSigner(config: SignerConfig): Promise<TypedSigner>;
}

export abstract class BaseMultiProtocolSigner implements IMultiProtocolSigner {
  constructor(protected config: ChainSubmissionStrategy) {}

  abstract getSignerConfig(chain: ChainName): Promise<SignerConfig>;
  abstract getSigner(config: SignerConfig): Promise<TypedSigner>;
}
