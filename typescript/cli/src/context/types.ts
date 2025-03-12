import type { ethers } from 'ethers';
import type { CommandModule } from 'yargs';

import type { IRegistry } from '@hyperlane-xyz/registry';
import type {
  ChainMap,
  ChainMetadata,
  MultiProvider,
  WarpCoreConfig,
} from '@hyperlane-xyz/sdk';

export interface ContextSettings {
  registryUris: string[];
  key?: string;
  fromAddress?: string;
  requiresKey?: boolean;
  disableProxy?: boolean;
  skipConfirmation?: boolean;
  strategyPath?: string;
}

export interface CommandContext {
  registry: IRegistry;
  chainMetadata: ChainMap<ChainMetadata>;
  multiProvider: MultiProvider;
  skipConfirmation: boolean;
  key?: string;
  // just for evm chains backward compatibility
  signerAddress?: string;
  warpCoreConfig?: WarpCoreConfig;
  strategyPath?: string;
}

export interface WriteCommandContext extends CommandContext {
  key: string;
  signer: ethers.Signer;
  isDryRun?: boolean;
  dryRunChain?: string;
}

export type CommandModuleWithContext<Args> = CommandModule<
  {},
  Args & { context: CommandContext }
>;

export type CommandModuleWithWriteContext<Args> = CommandModule<
  {},
  Args & { context: WriteCommandContext }
>;
