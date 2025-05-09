import type { ethers } from 'ethers';
import type { CommandModule } from 'yargs';

import type { IRegistry } from '@hyperlane-xyz/registry';
import type {
  ChainMap,
  ChainMetadata,
  MultiProtocolProvider,
  MultiProvider,
  WarpCoreConfig,
  WarpRouteDeployConfigMailboxRequired,
} from '@hyperlane-xyz/sdk';

import { MultiProtocolSignerManager } from './strategies/signer/MultiProtocolSignerManager.js';

export interface ContextSettings {
  registryUris: string[];
  key?: string;
  fromAddress?: string;
  requiresKey?: boolean;
  disableProxy?: boolean;
  skipConfirmation?: boolean;
  strategyPath?: string;
  authToken?: string;
}

export interface CommandContext {
  registry: IRegistry;
  chainMetadata: ChainMap<ChainMetadata>;
  multiProvider: MultiProvider;
  skipConfirmation: boolean;
  key?: string;
  // just for evm chains backward compatibility
  signerAddress?: string;
  strategyPath?: string;
  multiProtocolProvider?: MultiProtocolProvider;
  multiProtocolSigner?: MultiProtocolSignerManager;
}

export interface WriteCommandContext extends CommandContext {
  key: string;
  signer: ethers.Signer;
  isDryRun?: boolean;
  dryRunChain?: string;
  warpDeployConfig?: WarpRouteDeployConfigMailboxRequired;
  warpCoreConfig?: WarpCoreConfig;
  multiProtocolSigner?: MultiProtocolSignerManager;
}

export type CommandModuleWithContext<Args> = CommandModule<
  {},
  Args & { context: CommandContext }
>;

export type CommandModuleWithWriteContext<Args> = CommandModule<
  {},
  Args & { context: WriteCommandContext } & {
    multiProtocolSigner?: MultiProtocolSignerManager;
  }
>;
