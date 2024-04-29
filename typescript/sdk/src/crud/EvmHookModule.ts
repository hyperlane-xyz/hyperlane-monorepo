import { Address, ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { HyperlaneAddresses } from '../contracts/types.js';
import { HookFactories } from '../hook/contracts.js';
import { EvmHookReader } from '../hook/read.js';
import { HookConfig } from '../hook/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { EthersV5Transaction } from '../providers/ProviderType.js';

import { CrudModule, CrudModuleArgs } from './AbstractCrudModule.js';

// WIP example implementation of EvmHookModule
export class EvmHookModule extends CrudModule<
  ProtocolType.Ethereum,
  HookConfig,
  HyperlaneAddresses<HookFactories>
> {
  protected logger = rootLogger.child({ module: 'EvmHookModule' });
  protected reader: EvmHookReader;

  protected constructor(
    protected readonly multiProvider: MultiProvider,
    args: Omit<
      CrudModuleArgs<
        ProtocolType.Ethereum,
        HookConfig,
        HyperlaneAddresses<HookFactories>
      >,
      'provider'
    >,
  ) {
    super({
      ...args,
      provider: multiProvider.getProvider(args.chain),
    });

    this.reader = new EvmHookReader(multiProvider, args.chain);
  }

  public async read(address: Address): Promise<HookConfig> {
    return await this.reader.deriveHookConfig(address);
  }

  public async update(_config: HookConfig): Promise<EthersV5Transaction[]> {
    throw new Error('Method not implemented.');
  }

  // manually write static create function
  public static create(_config: HookConfig): Promise<EvmHookModule> {
    throw new Error('not implemented');
  }
}
