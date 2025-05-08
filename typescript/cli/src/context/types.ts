import type { ethers } from 'ethers';
import type { CommandModule } from 'yargs';

import type { IRegistry } from '@hyperlane-xyz/registry';
import type {
  ChainMap,
  ChainMetadata,
  MultiProtocolProvider,
  MultiProvider,
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
  multiProtocolProvider: MultiProtocolProvider;
  skipConfirmation: boolean;
  key?: string;
  // just for evm chains backward compatibility
  signerAddress?: string;
  strategyPath?: string;
}

export interface WriteCommandContext extends CommandContext {
  key: string;
  signer: ethers.Signer;
  multiProtocolSigner?: MultiProtocolSignerManager;
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
