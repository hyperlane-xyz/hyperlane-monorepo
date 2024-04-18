import { Address, ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { ProxyFactoryFactories } from '../deploy/contracts.js';
import { EvmIsmReader, IsmReader } from '../ism/read.js';
import { IsmConfig } from '../ism/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import {
  EthersV5Transaction,
  SupportedProtocolType,
} from '../providers/ProviderType.js';

import { CrudModule, CrudModuleArgs } from './AbstractCrudModule.js';

export abstract class IsmModule<
  TProtocol extends SupportedProtocolType,
> extends CrudModule<TProtocol, IsmConfig, ProxyFactoryFactories> {
  protected abstract reader: IsmReader;

  public async read(address: Address): Promise<IsmConfig> {
    return await this.reader.deriveIsmConfig(address);
  }
}

// WIP example implementation of EvmIsmModule
export class EvmIsmModule extends IsmModule<ProtocolType.Ethereum> {
  protected logger = rootLogger.child({ module: 'EvmIsmModule' });
  protected reader: EvmIsmReader;

  protected constructor(
    multiProvider: MultiProvider,
    args: Omit<
      CrudModuleArgs<ProtocolType.Ethereum, IsmConfig, ProxyFactoryFactories>,
      'provider'
    >,
  ) {
    super({
      ...args,
      provider: multiProvider.getProvider(args.chain),
    });

    this.reader = new EvmIsmReader(multiProvider, args.chain);
  }

  public async update(_config: IsmConfig): Promise<EthersV5Transaction[]> {
    throw new Error('Method not implemented.');
  }

  // manually write static create function
  public static create(_config: IsmConfig): Promise<EvmIsmModule> {
    throw new Error('not implemented');
  }
}
