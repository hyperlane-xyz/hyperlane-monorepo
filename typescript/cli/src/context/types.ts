import type { ethers } from 'ethers';
import type { CommandModule } from 'yargs';

import type { IRegistry } from '@hyperlane-xyz/registry';
import type {
  ChainMap,
  ChainMetadata,
  MultiProtocolProvider,
  MultiProvider,
  ProtocolMap,
  WarpCoreConfig,
  WarpRouteDeployConfigMailboxRequired,
} from '@hyperlane-xyz/sdk';

import { MultiProtocolSignerManager } from './strategies/signer/MultiProtocolSignerManager.js';

export type SignerKeyProtocolMap = Partial<ProtocolMap<string>>;

interface BaseContext {
  key?: string | SignerKeyProtocolMap;
  requiresKey?: boolean;
  skipConfirmation?: boolean;
  strategyPath?: string;
}

export interface ContextSettings extends BaseContext {
  registryUris: string[];
  disableProxy?: boolean;
  authToken?: string;
}

export interface CommandContext
  extends Omit<BaseContext, 'key' | 'skipConfirmation'> {
  key?: SignerKeyProtocolMap;
  registry: IRegistry;
  chainMetadata: ChainMap<ChainMetadata>;
  multiProvider: MultiProvider;
  multiProtocolProvider: MultiProtocolProvider;
  skipConfirmation: boolean;
  // just for evm chains backward compatibility
  signerAddress?: string;
}

export interface WriteCommandContext extends Omit<CommandContext, 'key'> {
  key: SignerKeyProtocolMap;
  signer: ethers.Signer;
  multiProtocolSigner?: MultiProtocolSignerManager;
  apiKeys?: ChainMap<string>;
}

export interface WarpDeployCommandContext extends WriteCommandContext {
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired;
}
export interface WarpApplyCommandContext extends WriteCommandContext {
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired;
  warpCoreConfig: WarpCoreConfig;
}

export type CommandModuleWithContext<Args> = CommandModule<
  {},
  Args & { context: CommandContext }
>;

export type CommandModuleWithWriteContext<Args> = CommandModule<
  {},
  Args & { context: WriteCommandContext }
>;

export type CommandModuleWithWarpApplyContext<Args> = CommandModule<
  {},
  Args & { context: WarpApplyCommandContext }
>;

export type CommandModuleWithWarpDeployContext<Args> = CommandModule<
  {},
  Args & { context: WarpDeployCommandContext }
>;
