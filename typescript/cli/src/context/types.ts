import type { ethers } from 'ethers';
import type { CommandModule } from 'yargs';
import { z } from 'zod';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import type { IRegistry } from '@hyperlane-xyz/registry';
import type {
  ChainMap,
  ChainMetadata,
  MultiProtocolProvider,
  MultiProvider,
  WarpCoreConfig,
  WarpRouteDeployConfigMailboxRequired,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

export const SignerKeyProtocolMapSchema = z
  .record(z.nativeEnum(ProtocolType), z.string().nonempty(), {
    errorMap: (_issue, _ctx) => ({
      message: `Key inputs not valid, make sure to use --key.{protocol} or the legacy flag --key but not both at the same time or avoid defining multiple --key or --key.{protocol} flags for the same protocol.`,
    }),
  })
  .or(z.string().nonempty())
  .transform((value) =>
    typeof value === 'string' ? { [ProtocolType.Ethereum]: value } : value,
  );

export type SignerKeyProtocolMap = z.infer<typeof SignerKeyProtocolMapSchema>;

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
  altVmProviders: ChainMap<AltVM.IProvider>;
  supportedProtocols: ProtocolType[];
  skipConfirmation: boolean;
  // just for evm chains backward compatibility
  signerAddress?: string;
}

export interface WriteCommandContext extends Omit<CommandContext, 'key'> {
  key: SignerKeyProtocolMap;
  signer: ethers.Signer;
  altVmSigners: ChainMap<AltVM.ISigner<AnnotatedTx, TxReceipt>>;
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
