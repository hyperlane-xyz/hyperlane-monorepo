import { Address, ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { HyperlaneAddresses } from '../contracts/types.js';
import {
  HyperlaneModule,
  HyperlaneModuleArgs,
} from '../core/AbstractHyperlaneModule.js';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer.js';
import { ProxyFactoryFactories } from '../deploy/contracts.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { EthersV5Transaction } from '../providers/ProviderType.js';
import { ChainNameOrId } from '../types.js';

import { DerivedIsmConfigWithAddress, EvmIsmReader } from './EvmIsmReader.js';
import { IsmConfig } from './types.js';

export class EvmIsmModule extends HyperlaneModule<
  ProtocolType.Ethereum,
  IsmConfig,
  HyperlaneAddresses<ProxyFactoryFactories> & {
    deployedIsm: Address;
  }
> {
  protected logger = rootLogger.child({ module: 'EvmIsmModule' });
  protected reader: EvmIsmReader;

  protected constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly deployer: HyperlaneDeployer<any, any>,
    args: HyperlaneModuleArgs<
      IsmConfig,
      HyperlaneAddresses<ProxyFactoryFactories> & {
        deployedIsm: Address;
      }
    >,
  ) {
    super(args);
    this.reader = new EvmIsmReader(multiProvider, args.chain);
  }

  public async read(): Promise<DerivedIsmConfigWithAddress> {
    return await this.reader.deriveIsmConfig(this.args.addresses.deployedIsm);
  }

  public async update(_config: IsmConfig): Promise<EthersV5Transaction[]> {
    throw new Error('Method not implemented.');
  }

  // manually write static create function
  public static async create(_params: {
    chain: ChainNameOrId;
    config: IsmConfig;
    deployer: HyperlaneDeployer<any, any>;
    factories: HyperlaneAddresses<ProxyFactoryFactories>;
    multiProvider: MultiProvider;
  }): Promise<EvmIsmModule> {
    throw new Error('Method not implemented.');
  }
}
