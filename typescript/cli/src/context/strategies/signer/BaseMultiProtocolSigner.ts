import { Signer } from 'ethers';
import { Account as StarknetAccount } from 'starknet';

import { SigningHyperlaneModuleClient } from '@hyperlane-xyz/cosmos-sdk';
import { ChainName, ChainSubmissionStrategy } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

export type TypedSigner =
  | Signer
  | SigningHyperlaneModuleClient
  | StarknetAccount;

export interface SignerConfig {
  privateKey: string;
  userAddress?: Address; // For chains like StarkNet that require address
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
