import * as ethers from 'ethers';

import { ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { HyperlaneAddresses } from '../contracts/types.js';
import {
  HyperlaneModule,
  HyperlaneModuleParams,
} from '../core/AbstractHyperlaneModule.js';
import { EvmModuleDeployer } from '../deploy/EvmModuleDeployer.js';
import { ContractVerifier } from '../deploy/verify/ContractVerifier.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedEV5Transaction } from '../providers/ProviderType.js';
import { ChainName } from '../types.js';

import {
  CheckpointStorageFactories,
  DeployedCheckpointStorage,
  checkpointStorageFactories,
} from './contracts.js';
import { CheckpointStorageConfigSchema } from './schemas.js';
import { CheckpointStorageConfig } from './types.js';

export type CheckpointModuleAddresses = {
  deployedCheckpoint: string;
  mailbox: string;
  validatorAnnounce: string;
};

export class EvmCheckpointModule extends HyperlaneModule<
  ProtocolType.Ethereum,
  CheckpointStorageConfig,
  HyperlaneAddresses<CheckpointStorageFactories> & CheckpointModuleAddresses
> {
  protected readonly logger = rootLogger.child({
    module: 'EvmCheckpointModule',
  });
  protected readonly deployer: EvmModuleDeployer<CheckpointStorageFactories>;

  // Adding these to reduce how often we need to grab from MultiProvider
  public readonly chain: string;
  public readonly domainId: number;

  protected constructor(
    protected readonly multiProvider: MultiProvider,
    params: HyperlaneModuleParams<
      CheckpointStorageConfig,
      HyperlaneAddresses<CheckpointStorageFactories> & CheckpointModuleAddresses
    >,
    protected readonly contractVerifier?: ContractVerifier,
  ) {
    params.config = CheckpointStorageConfigSchema.parse(params.config);
    super(params);

    this.deployer = new EvmModuleDeployer<CheckpointStorageFactories>(
      multiProvider,
      checkpointStorageFactories,
      this.logger,
      contractVerifier,
    );

    this.chain = this.multiProvider.getChainName(this.args.chain);
    this.domainId = this.multiProvider.getDomainId(this.chain);
  }

  static async create({
    chain,
    config,
    coreAddresses,
    multiProvider,
    contractVerifier,
  }: {
    chain: ChainName;
    config: CheckpointStorageConfig;
    coreAddresses: { mailbox: string; validatorAnnounce: string };
    multiProvider: MultiProvider;
    contractVerifier?: ContractVerifier;
  }): Promise<EvmCheckpointModule> {
    const module = new EvmCheckpointModule(
      multiProvider,
      {
        addresses: {
          ...coreAddresses,
          deployedCheckpoint: ethers.constants.AddressZero,
          checkpointStorage: ethers.constants.AddressZero,
        },
        chain,
        config,
      },
      contractVerifier,
    );

    const deployedCheckpoint = await module.deploy({ config });
    module.args.addresses.deployedCheckpoint = deployedCheckpoint.address;
    module.args.addresses.checkpointStorage = deployedCheckpoint.address;

    return module;
  }

  protected async deploy({
    config,
  }: {
    config: CheckpointStorageConfig;
  }): Promise<DeployedCheckpointStorage> {
    this.logger.debug('Deploying checkpoint storage');

    return this.deployer.deployContract({
      chain: config.chain,
      contractKey: 'checkpointStorage',
      constructorArgs: [this.args.addresses.validatorAnnounce],
    });
  }

  async read(): Promise<CheckpointStorageConfig> {
    throw new Error('Method not implemented.');
  }

  async update(): Promise<AnnotatedEV5Transaction[]> {
    throw new Error('Method not implemented.');
  }
}
