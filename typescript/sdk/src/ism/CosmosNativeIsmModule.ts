import { Logger } from 'pino';

import {
  COSMOS_MODULE_MESSAGE_REGISTRY as R,
  SigningHyperlaneModuleClient,
} from '@hyperlane-xyz/cosmos-sdk';
import {
  Address,
  ChainId,
  Domain,
  ProtocolType,
  assert,
  deepEquals,
  intersection,
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
import {
  DomainRoutingIsmConfig,
  IsmConfig,
  IsmConfigSchema,
  IsmType,
  MultisigIsmConfig,
  STATIC_ISM_TYPES,
} from './types.js';
import { calculateDomainRoutingDelta } from './utils.js';

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

    this.reader = new CosmosNativeIsmReader(this.multiProvider, this.signer);
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

    // Update the config
    this.args.config = expectedConfig;

    // If configs match, no updates needed
    if (deepEquals(actualConfig, expectedConfig)) {
      return [];
    }

    // if the ISM is a static ISM we can not update it, instead
    // it needs to be recreated with the expected config
    if (STATIC_ISM_TYPES.includes(expectedConfig.type)) {
      this.args.addresses.deployedIsm = await this.deploy({
        config: expectedConfig,
      });

      return [];
    }

    let updateTxs: AnnotatedCosmJsNativeTransaction[] = [];
    if (expectedConfig.type === IsmType.ROUTING) {
      const logger = this.logger.child({
        destination: this.chain,
        ismType: expectedConfig.type,
      });
      logger.debug(`Updating ${expectedConfig.type} on ${this.chain}`);

      updateTxs = await this.updateRoutingIsm({
        actual: actualConfig,
        expected: expectedConfig,
        logger,
      });
    }

    return updateTxs;
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
      case IsmType.MERKLE_ROOT_MULTISIG: {
        return this.deployMerkleRootMultisigIsm(config);
      }
      case IsmType.MESSAGE_ID_MULTISIG: {
        return this.deployMessageIdMultisigIsm(config);
      }
      case IsmType.ROUTING: {
        return this.deployRoutingIsm(config);
      }
      case IsmType.TEST_ISM: {
        return this.deployNoopIsm();
      }
      default:
        throw new Error(
          `ISM type ${ismType} is not supported on Cosmos Native`,
        );
    }
  }

  protected async deployMerkleRootMultisigIsm(
    config: MultisigIsmConfig,
  ): Promise<Address> {
    assert(
      config.threshold <= config.validators.length,
      `threshold (${config.threshold}) for merkle root multisig ISM is greater than number of validators (${config.validators.length})`,
    );
    const { response } = await this.signer.createMerkleRootMultisigIsm({
      validators: config.validators,
      threshold: config.threshold,
    });
    return response.id;
  }

  protected async deployMessageIdMultisigIsm(
    config: MultisigIsmConfig,
  ): Promise<Address> {
    assert(
      config.threshold <= config.validators.length,
      `threshold (${config.threshold}) for message id multisig ISM is greater than number of validators (${config.validators.length})`,
    );
    const { response } = await this.signer.createMessageIdMultisigIsm({
      validators: config.validators,
      threshold: config.threshold,
    });
    return response.id;
  }

  protected async deployRoutingIsm(
    config: DomainRoutingIsmConfig,
  ): Promise<Address> {
    const routes = [];

    // deploy ISMs for each domain
    for (const chainName of Object.keys(config.domains)) {
      const domainId = this.multiProvider.tryGetDomainId(chainName);
      if (!domainId) {
        this.logger.warn(
          `Unknown chain ${chainName}, skipping ISM configuration`,
        );
        continue;
      }

      const address = await this.deploy({ config: config.domains[chainName] });
      routes.push({
        ism: address,
        domain: domainId,
      });
    }

    const { response } = await this.signer.createRoutingIsm({
      routes,
    });
    return response.id;
  }

  protected async updateRoutingIsm({
    actual,
    expected,
    logger,
  }: {
    actual: DomainRoutingIsmConfig;
    expected: DomainRoutingIsmConfig;
    logger: Logger;
  }): Promise<AnnotatedCosmJsNativeTransaction[]> {
    const updateTxs: AnnotatedCosmJsNativeTransaction[] = [];

    const knownChains = new Set(this.multiProvider.getKnownChainNames());

    const { domainsToEnroll, domainsToUnenroll } = calculateDomainRoutingDelta(
      actual,
      expected,
    );

    const knownEnrolls = intersection(knownChains, new Set(domainsToEnroll));

    // Enroll domains
    for (const origin of knownEnrolls) {
      logger.debug(
        `Reconfiguring preexisting routing ISM for origin ${origin}...`,
      );
      const ism = await this.deploy({
        config: expected.domains[origin],
      });

      const domain = this.multiProvider.getDomainId(origin);
      updateTxs.push({
        annotation: `Setting new ISM for origin ${origin}...`,
        typeUrl: R.MsgSetRoutingIsmDomain.proto.type,
        value: R.MsgSetRoutingIsmDomain.proto.converter.create({
          owner: actual.owner,
          ism_id: this.args.addresses.deployedIsm,
          route: {
            ism,
            domain,
          },
        }),
      });
    }

    const knownUnenrolls = intersection(
      knownChains,
      new Set(domainsToUnenroll),
    );

    // Unenroll domains
    for (const origin of knownUnenrolls) {
      const domain = this.multiProvider.getDomainId(origin);
      updateTxs.push({
        annotation: `Unenrolling originDomain ${domain} from preexisting routing ISM at ${this.args.addresses.deployedIsm}...`,
        typeUrl: R.MsgRemoveRoutingIsmDomain.proto.type,
        value: R.MsgRemoveRoutingIsmDomain.proto.converter.create({
          owner: actual.owner,
          ism_id: this.args.addresses.deployedIsm,
          domain,
        }),
      });
    }

    // Update ownership
    if (actual.owner !== expected.owner) {
      updateTxs.push({
        annotation: `Transferring ownership of ISM from ${
          actual.owner
        } to ${expected.owner}`,
        typeUrl: R.MsgUpdateRoutingIsmOwner.proto.type,
        value: R.MsgUpdateRoutingIsmOwner.proto.converter.create({
          owner: actual.owner,
          ism_id: this.args.addresses.deployedIsm,
          new_owner: expected.owner,
          // if the new owner is empty we renounce the ownership
          renounce_ownership: !expected.owner,
        }),
      });
    }

    return updateTxs;
  }

  protected async deployNoopIsm(): Promise<Address> {
    const { response } = await this.signer.createNoopIsm({});
    return response.id;
  }
}
