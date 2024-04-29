import { Address, ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { HyperlaneAddresses } from '../contracts/types.js';
import { ProxyFactoryFactories } from '../deploy/contracts.js';
import { EvmIsmReader } from '../ism/read.js';
import { IsmConfig } from '../ism/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { EthersV5Transaction } from '../providers/ProviderType.js';

import { CrudModule, CrudModuleArgs } from './AbstractCrudModule.js';

// WIP example implementation of EvmIsmModule
export class EvmIsmModule extends CrudModule<
  ProtocolType.Ethereum,
  IsmConfig,
  HyperlaneAddresses<ProxyFactoryFactories>
> {
  protected logger = rootLogger.child({ module: 'EvmIsmModule' });
  protected reader: EvmIsmReader;

  protected constructor(
    protected readonly multiProvider: MultiProvider,
    args: Omit<
      CrudModuleArgs<
        ProtocolType.Ethereum,
        IsmConfig,
        HyperlaneAddresses<ProxyFactoryFactories>
      >,
      'provider'
    >,
  ) {
    super({
      ...args,
      provider: multiProvider.getProvider(args.chain),
    });

    this.reader = new EvmIsmReader(multiProvider, args.chain);
  }

  public async read(address: Address): Promise<IsmConfig> {
    return await this.reader.deriveIsmConfig(address);
  }

  public async update(_config: IsmConfig): Promise<EthersV5Transaction[]> {
    throw new Error('Method not implemented.');
  }

  // manually write static create function
  public static create(_config: IsmConfig): Promise<EvmIsmModule> {
    throw new Error('not implemented');
  }
}
