import { ethers } from 'ethers';

import { IRegistry } from '@hyperlane-xyz/registry';
import { ChainMap, ChainMetadata, MultiProvider } from '@hyperlane-xyz/sdk';

export interface ContextSettings {
  commandName: string;
  registryUri: string;
  configOverrideUri: string;
  key?: string;
  skipConfirmation?: boolean;
}

export interface CommandContext {
  registry: IRegistry;
  chainMetadata: ChainMap<ChainMetadata>;
  multiProvider: MultiProvider;
  skipConfirmation: boolean;
  signer: ethers.Signer;
}
