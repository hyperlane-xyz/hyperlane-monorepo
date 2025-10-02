import { Logger } from 'pino';

import {
  Address,
  AltVM,
  ChainId,
  Domain,
  assert,
  deepEquals,
  intersection,
  rootLogger,
} from '@hyperlane-xyz/utils';

import {
  HyperlaneModule,
  HyperlaneModuleParams,
} from '../core/AbstractHyperlaneModule.js';
import { ChainMetadataManager } from '../metadata/ChainMetadataManager.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedAltVmTransaction } from '../providers/ProviderType.js';
import { ChainName, ChainNameOrId } from '../types.js';
import { normalizeConfig } from '../utils/ism.js';

import { AltVmIsmReader } from './AltVmIsmReader.js';
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

export class AltVmIsmModule extends HyperlaneModule<
  any,
  IsmConfig,
  IsmModuleAddresses
> {
  protected readonly logger = rootLogger.child({
    module: 'AltVmIsmModule',
  });
  protected readonly reader: AltVmIsmReader;
  protected readonly mailbox: Address;

  // Adding these to reduce how often we need to grab from MetadataManager.
  public readonly chain: ChainName;
  public readonly chainId: ChainId;
  public readonly domainId: Domain;

  constructor(
    protected readonly metadataManager: ChainMetadataManager,
    params: HyperlaneModuleParams<IsmConfig, IsmModuleAddresses>,
    protected readonly signer: AltVM.ISigner,
  ) {
    params.config = IsmConfigSchema.parse(params.config);
    super(params);

    this.mailbox = params.addresses.mailbox;
    this.chain = metadataManager.getChainName(this.args.chain);
    this.chainId = metadataManager.getChainId(this.chain);
    this.domainId = metadataManager.getDomainId(this.chain);

    this.reader = new AltVmIsmReader(this.metadataManager, this.signer);
  }

  public async read(): Promise<IsmConfig> {
    return this.reader.deriveIsmConfig(this.args.addresses.deployedIsm);
  }

  // whoever calls update() needs to ensure that targetConfig has a valid owner
  public async update(
    expectedConfig: IsmConfig,
  ): Promise<AnnotatedAltVmTransaction[]> {
    expectedConfig = IsmConfigSchema.parse(expectedConfig);

    // Do not support updating to a custom ISM address
    if (typeof expectedConfig === 'string') {
      throw new Error(
        'Invalid targetConfig: Updating to a custom ISM address is not supported. Please provide a valid ISM configuration.',
      );
    }

    // if there is no ism deployed yet we deploy one
    if (!this.args.addresses.deployedIsm) {
      this.args.addresses.deployedIsm = await this.deploy({
        config: expectedConfig,
      });

      return [];
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

    let updateTxs: AnnotatedAltVmTransaction[] = [];
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
    addresses: {
      mailbox: string;
    };
    multiProvider: MultiProvider;
    signer: AltVM.ISigner;
  }): Promise<AltVmIsmModule> {
    const module = new AltVmIsmModule(
      multiProvider,
      {
        addresses: {
          ...addresses,
          deployedIsm: '',
        },
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
        throw new Error(`ISM type ${ismType} is not supported on AltVM`);
    }
  }

  protected async deployMerkleRootMultisigIsm(
    config: MultisigIsmConfig,
  ): Promise<Address> {
    assert(
      config.threshold <= config.validators.length,
      `threshold (${config.threshold}) for merkle root multisig ISM is greater than number of validators (${config.validators.length})`,
    );
    const { ism_id } = await this.signer.createMerkleRootMultisigIsm({
      validators: config.validators,
      threshold: config.threshold,
    });
    return ism_id;
  }

  protected async deployMessageIdMultisigIsm(
    config: MultisigIsmConfig,
  ): Promise<Address> {
    assert(
      config.threshold <= config.validators.length,
      `threshold (${config.threshold}) for message id multisig ISM is greater than number of validators (${config.validators.length})`,
    );
    const { ism_id } = await this.signer.createMessageIdMultisigIsm({
      validators: config.validators,
      threshold: config.threshold,
    });
    return ism_id;
  }

  protected async deployRoutingIsm(
    config: DomainRoutingIsmConfig,
  ): Promise<Address> {
    const routes = [];

    // deploy ISMs for each domain
    for (const chainName of Object.keys(config.domains)) {
      const domainId = this.metadataManager.tryGetDomainId(chainName);
      if (!domainId) {
        this.logger.warn(
          `Unknown chain ${chainName}, skipping ISM configuration`,
        );
        continue;
      }

      const address = await this.deploy({ config: config.domains[chainName] });
      routes.push({
        ism: address,
        domain_id: domainId,
      });
    }

    const { ism_id } = await this.signer.createRoutingIsm({
      routes,
    });
    return ism_id;
  }

  protected async updateRoutingIsm({
    actual,
    expected,
    logger,
  }: {
    actual: DomainRoutingIsmConfig;
    expected: DomainRoutingIsmConfig;
    logger: Logger;
  }): Promise<AnnotatedAltVmTransaction[]> {
    const updateTxs: AnnotatedAltVmTransaction[] = [];

    const knownChains = new Set(this.metadataManager.getKnownChainNames());

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
      const ism_id = await this.deploy({
        config: expected.domains[origin],
      });

      const domain_id = this.metadataManager.getDomainId(origin);
      updateTxs.push({
        annotation: `Setting new ISM for origin ${origin}...`,
        transaction: await this.signer.populateSetRoutingIsmRoute({
          signer: this.signer.getSignerAddress(),
          ism_id: this.args.addresses.deployedIsm,
          route: {
            ism_id,
            domain_id,
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
      const domain_id = this.metadataManager.getDomainId(origin);
      updateTxs.push({
        annotation: `Unenrolling originDomain ${domain_id} from preexisting routing ISM at ${this.args.addresses.deployedIsm}...`,
        transaction: await this.signer.populateRemoveRoutingIsmRoute({
          signer: this.signer.getSignerAddress(),
          ism_id: this.args.addresses.deployedIsm,
          domain_id,
        }),
      });
    }

    // Update ownership
    if (actual.owner !== expected.owner) {
      updateTxs.push({
        annotation: `Transferring ownership of ISM from ${
          actual.owner
        } to ${expected.owner}`,
        transaction: await this.signer.populateSetRoutingIsmOwner({
          signer: this.signer.getSignerAddress(),
          ism_id: this.args.addresses.deployedIsm,
          new_owner: expected.owner,
        }),
      });
    }

    return updateTxs;
  }

  protected async deployNoopIsm(): Promise<Address> {
    const { ism_id } = await this.signer.createNoopIsm({});
    return ism_id;
  }
}
