import { RadixSigningSDK } from '@hyperlane-xyz/radix-sdk';
import {
  Address,
  ChainId,
  Domain,
  ProtocolType,
  assert,
  rootLogger,
} from '@hyperlane-xyz/utils';

import {
  HyperlaneModule,
  HyperlaneModuleParams,
} from '../core/AbstractHyperlaneModule.js';
import { ChainMetadataManager } from '../metadata/ChainMetadataManager.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainName, ChainNameOrId } from '../types.js';

import { RadixIsmReader } from './RadixIsmReader.js';
import {
  IsmConfig,
  IsmConfigSchema,
  IsmType,
  MultisigIsmConfig,
} from './types.js';

type IsmModuleAddresses = {
  deployedIsm: Address;
  mailbox: Address;
};

export class RadixIsmModule extends HyperlaneModule<
  ProtocolType.Radix,
  IsmConfig,
  IsmModuleAddresses
> {
  protected readonly logger = rootLogger.child({
    module: 'RadixIsmModule',
  });
  protected readonly reader: RadixIsmReader;
  protected readonly mailbox: Address;

  // Adding these to reduce how often we need to grab from MetadataManager.
  public readonly chain: ChainName;
  public readonly chainId: ChainId;
  public readonly domainId: Domain;

  constructor(
    protected readonly metadataManager: ChainMetadataManager,
    params: HyperlaneModuleParams<IsmConfig, IsmModuleAddresses>,
    protected readonly signer: RadixSigningSDK,
  ) {
    params.config = IsmConfigSchema.parse(params.config);
    super(params);

    this.mailbox = params.addresses.mailbox;
    this.chain = metadataManager.getChainName(this.args.chain);
    this.chainId = metadataManager.getChainId(this.chain);
    this.domainId = metadataManager.getDomainId(this.chain);

    this.reader = new RadixIsmReader(this.metadataManager, this.signer);
  }

  public async read(): Promise<IsmConfig> {
    return this.reader.deriveIsmConfig(this.args.addresses.deployedIsm);
  }

  // whoever calls update() needs to ensure that targetConfig has a valid owner
  public async update(_expectedConfig: IsmConfig): Promise<string[]> {
    return [];
  }

  // manually write static create function
  public static async create({
    chain,
    config,
    addresses,
    multiProvider,
    signer,
  }: {
    chain: ChainNameOrId;
    config: IsmConfig;
    addresses: IsmModuleAddresses;
    multiProvider: MultiProvider;
    signer: RadixSigningSDK;
  }): Promise<RadixIsmModule> {
    const module = new RadixIsmModule(
      multiProvider,
      {
        addresses,
        chain,
        config,
      },
      signer,
    );

    module.args.addresses.deployedIsm = await module.deploy({ config });
    return module;
  }

  protected async deploy({ config }: { config: IsmConfig }): Promise<Address> {
    if (typeof config === 'string') {
      return config;
    }
    const ismType = config.type;
    this.logger.info(`Deploying ${ismType} to ${this.chain}`);

    switch (ismType) {
      case IsmType.MERKLE_ROOT_MULTISIG: {
        return this.deployMerkleRootMultisigIsm(config);
      }
      case IsmType.MESSAGE_ID_MULTISIG: {
        return this.deployMessageIdMultisigIsm(config);
      }
      case IsmType.TEST_ISM: {
        return this.deployNoopIsm();
      }
      default:
        throw new Error(`ISM type ${ismType} is not supported on Radix`);
    }
  }

  protected async deployMerkleRootMultisigIsm(
    config: MultisigIsmConfig,
  ): Promise<Address> {
    assert(
      config.threshold <= config.validators.length,
      `threshold (${config.threshold}) for merkle root multisig ISM is greater than number of validators (${config.validators.length})`,
    );
    return this.signer.createMerkleRootMultisigIsm(
      config.validators,
      config.threshold,
    );
  }

  protected async deployMessageIdMultisigIsm(
    config: MultisigIsmConfig,
  ): Promise<Address> {
    assert(
      config.threshold <= config.validators.length,
      `threshold (${config.threshold}) for message id multisig ISM is greater than number of validators (${config.validators.length})`,
    );
    return this.signer.createMessageIdMultisig(
      config.validators,
      config.threshold,
    );
  }

  protected async deployNoopIsm(): Promise<Address> {
    return this.signer.createNoopIsm();
  }
}
