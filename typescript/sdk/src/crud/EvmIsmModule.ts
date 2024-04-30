import { Address, ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts/types.js';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer.js';
import { ProxyFactoryFactories } from '../deploy/contracts.js';
import { EvmIsmCreator } from '../ism/EvmIsmCreator.js';
import { EvmIsmReader } from '../ism/read.js';
import { IsmConfig } from '../ism/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { EthersV5Transaction } from '../providers/ProviderType.js';
import { ChainNameOrId } from '../types.js';

import { CrudModule, CrudModuleArgs } from './AbstractCrudModule.js';

// WIP example implementation of EvmIsmModule
export class EvmIsmModule extends CrudModule<
  ProtocolType.Ethereum,
  IsmConfig,
  HyperlaneContracts<ProxyFactoryFactories> & {
    deployedIsm: Address;
  }
> {
  protected logger = rootLogger.child({ module: 'EvmIsmModule' });
  protected reader: EvmIsmReader;

  protected constructor(
    protected readonly multiProvider: MultiProvider,
    args: CrudModuleArgs<
      IsmConfig,
      HyperlaneContracts<ProxyFactoryFactories> & {
        deployedIsm: Address;
      }
    >,
  ) {
    super(args);

    this.reader = new EvmIsmReader(multiProvider, args.chain);
  }

  public async read(): Promise<IsmConfig> {
    return await this.reader.deriveIsmConfig(this.args.addresses.deployedIsm);
  }

  public async update(_config: IsmConfig): Promise<EthersV5Transaction[]> {
    throw new Error('Method not implemented.');
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
    return new EvmIsmModule(multiProvider, {
      addresses: {
        ...factories,
        deployedIsm: deployedIsm.address,
      },
      chain,
      config,
    });
  }
}
