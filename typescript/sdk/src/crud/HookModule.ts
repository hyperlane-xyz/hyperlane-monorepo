import { Address, ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { HookFactories } from '../hook/contracts.js';
import { EvmHookReader, HookReader } from '../hook/read.js';
import { HookConfig } from '../hook/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import {
  EthersV5Transaction,
  SupportedProtocolType,
} from '../providers/ProviderType.js';

import { CrudModule, CrudModuleArgs } from './AbstractCrudModule.js';

export abstract class HookModule<
  TProtocol extends SupportedProtocolType,
> extends CrudModule<TProtocol, HookConfig, HookFactories> {
  protected abstract reader: HookReader;

  public async read(address: Address): Promise<HookConfig> {
    return await this.reader.deriveHookConfig(address);
  }
}

// WIP example implementation of EvmHookModule
export class EvmHookModule extends HookModule<ProtocolType.Ethereum> {
  protected logger = rootLogger.child({ module: 'EvmHookModule' });
  protected reader: EvmHookReader;

  protected constructor(
    multiProvider: MultiProvider,
    args: Omit<
      CrudModuleArgs<ProtocolType.Ethereum, HookConfig, HookFactories>,
      'provider'
    >,
  ) {
    super({
      ...args,
      provider: multiProvider.getProvider(args.chain),
    });

    this.reader = new EvmHookReader(multiProvider, args.chain);
  }

  public async update(_config: HookConfig): Promise<EthersV5Transaction[]> {
    throw new Error('Method not implemented.');
  }

  // manually write static create function
  public static create(_config: HookConfig): Promise<EvmHookModule> {
    throw new Error('not implemented');
  }
}
