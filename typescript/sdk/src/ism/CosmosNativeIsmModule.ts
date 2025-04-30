import { SigningHyperlaneModuleClient } from '@hyperlane-xyz/cosmos-sdk';
import {
  Address,
  ChainId,
  Domain,
  ProtocolType,
  assert,
  deepEquals,
  rootLogger,
} from '@hyperlane-xyz/utils';

import {
  HyperlaneModule,
  HyperlaneModuleParams,
} from '../core/AbstractHyperlaneModule.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedCosmJsNativeTransaction } from '../providers/ProviderType.js';
import { ChainName, ChainNameOrId } from '../types.js';
import { normalizeConfig } from '../utils/ism.js';

import { CosmosNativeIsmReader } from './CosmosNativeIsmReader.js';
import { IsmConfig, IsmConfigSchema, IsmType } from './types.js';

type IsmModuleAddresses = {
  deployedIsm: Address;
  mailbox: Address;
};

export class CosmosNativeIsmModule extends HyperlaneModule<
  ProtocolType.CosmosNative,
  IsmConfig,
  IsmModuleAddresses
> {
  protected readonly logger = rootLogger.child({
    module: 'CosmosNativeIsmModule',
  });
  protected readonly reader: CosmosNativeIsmReader;
  protected readonly mailbox: Address;

  // Adding these to reduce how often we need to grab from MultiProvider.
  public readonly chain: ChainName;
  public readonly chainId: ChainId;
  public readonly domainId: Domain;

  constructor(
    protected readonly multiProvider: MultiProvider,
    params: HyperlaneModuleParams<IsmConfig, IsmModuleAddresses>,
    protected readonly signer: SigningHyperlaneModuleClient,
  ) {
    params.config = IsmConfigSchema.parse(params.config);
    super(params);

    this.mailbox = params.addresses.mailbox;
    this.chain = multiProvider.getChainName(this.args.chain);
    this.chainId = multiProvider.getChainId(this.chain);
    this.domainId = multiProvider.getDomainId(this.chain);

    this.reader = new CosmosNativeIsmReader(signer);
  }

  public async read(): Promise<IsmConfig> {
    return this.reader.deriveIsmConfig(this.args.addresses.deployedIsm);
  }

  // whoever calls update() needs to ensure that targetConfig has a valid owner
  public async update(
    expectedConfig: IsmConfig,
  ): Promise<AnnotatedCosmJsNativeTransaction[]> {
    expectedConfig = IsmConfigSchema.parse(expectedConfig);

    // Do not support updating to a custom ISM address
    if (typeof expectedConfig === 'string') {
      throw new Error(
        'Invalid targetConfig: Updating to a custom ISM address is not supported. Please provide a valid ISM configuration.',
      );
    }

    // save current config for comparison
    // normalize the config to ensure it's in a consistent format for comparison
    const actualConfig = normalizeConfig(await this.read());
    expectedConfig = normalizeConfig(expectedConfig);

    assert(
      typeof expectedConfig === 'object',
      'normalized expectedConfig should be an object',
    );

    // if it's a fallback routing ISM, do a mailbox diff check

    // If configs match, no updates needed
    if (deepEquals(actualConfig, expectedConfig)) {
      return [];
    }

    this.args.addresses.deployedIsm = await this.deploy({
      config: expectedConfig,
    });

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
    signer: SigningHyperlaneModuleClient;
  }): Promise<CosmosNativeIsmModule> {
    const module = new CosmosNativeIsmModule(
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
      case IsmType.MERKLE_ROOT_MULTISIG:
        const { response: merkleRootResponse } =
          await this.signer.createMerkleRootMultisigIsm({
            validators: config.validators,
            threshold: config.threshold,
          });
        return merkleRootResponse.id;

      case IsmType.MESSAGE_ID_MULTISIG:
        const { response: messageIdResponse } =
          await this.signer.createMessageIdMultisigIsm({
            validators: config.validators,
            threshold: config.threshold,
          });
        return messageIdResponse.id;
      case IsmType.TEST_ISM:
        const { response: noopResponse } = await this.signer.createNoopIsm({});
        return noopResponse.id;
      default:
        throw new Error(`ISM type ${ismType} is not supported on Cosmos`);
    }
  }
}
