import type { ethers } from 'ethers';
import type { CommandModule } from 'yargs';

import type { IRegistry } from '@hyperlane-xyz/registry';
import type {
  ChainMap,
  ChainMetadata,
  MultiProvider,
  SubmissionStrategy,
} from '@hyperlane-xyz/sdk';

export interface ContextSettings {
  registryUri: string;
  registryOverrideUri: string;
  key?: string;
  fromAddress?: string;
  requiresKey?: boolean;
  skipConfirmation?: boolean;
  submissionStrategy?: SubmissionStrategy;
}

export interface CommandContext {
  registry: IRegistry;
  chainMetadata: ChainMap<ChainMetadata>;
  multiProvider: MultiProvider;
  skipConfirmation: boolean;
  submissionStrategy?: SubmissionStrategy;
  key?: string;
  signer?: ethers.Signer;
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
