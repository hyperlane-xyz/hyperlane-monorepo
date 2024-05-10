import { Address, ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts/types.js';
import {
  HyperlaneModule,
  HyperlaneModuleArgs,
} from '../core/AbstractHyperlaneModule.js';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer.js';
import { ProxyFactoryFactories } from '../deploy/contracts.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { EthersV5Transaction } from '../providers/ProviderType.js';
import { ChainNameOrId } from '../types.js';

import { EvmIsmCreator } from './EvmIsmCreator.js';
import { EvmIsmReader } from './EvmIsmReader.js';
import { IsmConfig } from './types.js';

export class EvmIsmModule extends HyperlaneModule<
  ProtocolType.Ethereum,
  IsmConfig,
  HyperlaneContracts<ProxyFactoryFactories> & {
    deployedIsm: Address;
  }
> {
  protected logger = rootLogger.child({ module: 'EvmIsmModule' });
  protected reader: EvmIsmReader;
  protected creator: EvmIsmCreator;

  protected constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly deployer: HyperlaneDeployer<any, any>,
    args: HyperlaneModuleArgs<
      IsmConfig,
      HyperlaneContracts<ProxyFactoryFactories> & {
        deployedIsm: Address;
      }
    >,
  ) {
    super(args);
    this.reader = new EvmIsmReader(multiProvider, args.chain);
    this.creator = new EvmIsmCreator(deployer, multiProvider, args.addresses);
  }

  public async read(): Promise<IsmConfig> {
    return await this.reader.deriveIsmConfig(this.args.addresses.deployedIsm);
  }

  public async update(config: IsmConfig): Promise<EthersV5Transaction[]> {
    throw new Error('Method not implemented.');

    const destination = this.multiProvider.getChainName(this.args.chain);
    await this.creator.update({
      destination,
      config,
      existingIsmAddress: this.args.addresses.deployedIsm,
    });
    return [];
  }

  // manually write static create function
  public static async create({
    chain,
    config,
    deployer,
    factories,
    multiProvider,
  }: {
    chain: ChainNameOrId;
    config: IsmConfig;
    deployer: HyperlaneDeployer<any, any>;
    factories: HyperlaneContracts<ProxyFactoryFactories>;
    multiProvider: MultiProvider;
  }): Promise<EvmIsmModule> {
    const destination = multiProvider.getChainName(chain);
    const ismCreator = new EvmIsmCreator(deployer, multiProvider, factories);
    const deployedIsm = await ismCreator.deploy({
      config,
      destination,
    });
    return new EvmIsmModule(multiProvider, deployer, {
      addresses: {
        ...factories,
        deployedIsm: deployedIsm.address,
      },
      chain,
      config,
    });
  }
}
