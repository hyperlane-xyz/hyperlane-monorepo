import type { ethers } from 'ethers';
import type { CommandModule } from 'yargs';

import type { IRegistry } from '@hyperlane-xyz/registry';
import type {
  ChainMap,
  ChainMetadata,
  MultiProvider,
} from '@hyperlane-xyz/sdk';

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

export type CommandModuleWithContext<Args> = CommandModule<
  {},
  Args & { context: CommandContext }
>;
