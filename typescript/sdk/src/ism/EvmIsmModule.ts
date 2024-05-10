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

import { EvmIsmDeployer } from './EvmIsmDeployer.js';
import { EvmIsmReader } from './EvmIsmReader.js';
import { DeployedIsmType, IsmConfig, IsmType } from './types.js';

export class EvmIsmModule extends HyperlaneModule<
  ProtocolType.Ethereum,
  IsmConfig,
  HyperlaneContracts<ProxyFactoryFactories> & {
    deployedIsm: Address;
  }
> {
  protected logger = rootLogger.child({ module: 'EvmIsmModule' });
  protected ismReader: EvmIsmReader;
  protected ismDeployer: EvmIsmDeployer;

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
    this.ismReader = new EvmIsmReader(multiProvider, args.chain);
    this.ismDeployer = new EvmIsmDeployer(
      deployer,
      multiProvider,
      args.addresses,
    );
  }

  public async read(): Promise<IsmConfig> {
    return await this.ismReader.deriveIsmConfig(
      this.args.addresses.deployedIsm,
    );
  }

  public async update(config: IsmConfig): Promise<EthersV5Transaction[]> {
    const destination = this.multiProvider.getChainName(this.args.chain);

    if (typeof config === 'string') {
      this.logger.debug('Skipping update for config of type Address.');
      return [];
    }

    const ismType = config.type;
    this.logger.debug(
      `Updating ${ismType} on ${destination} ${
        origin ? `(for verifying ${origin})` : ''
      }`,
    );

    let contract: DeployedIsmType[typeof ismType];
    if (ismType === IsmType.ROUTING || ismType === IsmType.FALLBACK_ROUTING) {
      contract = await this.ismDeployer.updateRoutingIsm({
        destination,
        config,
        origin,
        existingIsmAddress: this.args.addresses.deployedIsm,
        logger: this.logger,
      });
    } else {
      contract = await this.ismDeployer.deploy({
        destination,
        config,
      });
    }

    // if update was in-place, there's no change in address
    this.args.addresses.deployedIsm = contract.address;
    this.args.config = config;
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
    const ismDeployer = new EvmIsmDeployer(deployer, multiProvider, factories);
    const deployedIsm = await ismDeployer.deploy({
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
