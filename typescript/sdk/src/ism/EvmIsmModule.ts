import { ethers } from 'ethers';
import { Logger } from 'pino';

import {
  ArbL2ToL1Ism__factory,
  DefaultFallbackRoutingIsm__factory,
  DomainRoutingIsm,
  DomainRoutingIsmFactory__factory,
  DomainRoutingIsm__factory,
  IAggregationIsm,
  IAggregationIsm__factory,
  IInterchainSecurityModule__factory,
  IMultisigIsm,
  IMultisigIsm__factory,
  IRoutingIsm,
  OPStackIsm__factory,
  Ownable__factory,
  PausableIsm__factory,
  TestIsm__factory,
  TrustedRelayerIsm__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  Domain,
  ProtocolType,
  assert,
  deepEquals,
  eqAddress,
  normalizeConfig,
  objFilter,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { attachAndConnectContracts } from '../contracts/contracts.js';
import { HyperlaneAddresses, HyperlaneContracts } from '../contracts/types.js';
import {
  HyperlaneModule,
  HyperlaneModuleParams,
} from '../core/AbstractHyperlaneModule.js';
import { EvmModuleDeployer } from '../deploy/EvmModuleDeployer.js';
import {
  ProxyFactoryFactories,
  proxyFactoryFactories,
} from '../deploy/contracts.js';
import { ContractVerifier } from '../deploy/verify/ContractVerifier.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedEV5Transaction } from '../providers/ProviderType.js';
import { ChainName, ChainNameOrId } from '../types.js';
import { findMatchingLogEvents } from '../utils/logUtils.js';

import { EvmIsmReader } from './EvmIsmReader.js';
import { IsmConfigSchema } from './schemas.js';
import {
  AggregationIsmConfig,
  DeployedIsm,
  IsmConfig,
  IsmType,
  MUTABLE_ISM_TYPE,
  MultisigIsmConfig,
  RoutingIsmConfig,
} from './types.js';
import { calculateDomainRoutingDelta } from './utils.js';

type IsmModuleAddresses = {
  deployedIsm: Address;
  mailbox: Address;
};

export class EvmIsmModule extends HyperlaneModule<
  ProtocolType.Ethereum,
  IsmConfig,
  HyperlaneAddresses<ProxyFactoryFactories> & IsmModuleAddresses
> {
  protected readonly logger = rootLogger.child({ module: 'EvmIsmModule' });
  protected readonly reader: EvmIsmReader;
  protected readonly deployer: EvmModuleDeployer<any>;
  protected readonly factories: HyperlaneContracts<ProxyFactoryFactories>;

  // Adding these to reduce how often we need to grab from MultiProvider.
  public readonly chain: ChainName;
  // We use domainId here because MultiProvider.getDomainId() will always
  // return a number, and EVM the domainId and chainId are the same.
  public readonly domainId: Domain;

  constructor(
    protected readonly multiProvider: MultiProvider,
    params: HyperlaneModuleParams<
      IsmConfig,
      HyperlaneAddresses<ProxyFactoryFactories> & IsmModuleAddresses
    >,
    protected readonly contractVerifier?: ContractVerifier,
  ) {
    params.config = IsmConfigSchema.parse(params.config);
    super(params);

    this.reader = new EvmIsmReader(multiProvider, params.chain);
    this.deployer = new EvmModuleDeployer(
      this.multiProvider,
      {},
      this.logger,
      contractVerifier,
    );

    this.factories = attachAndConnectContracts(
      {
        staticMerkleRootMultisigIsmFactory:
          params.addresses.staticMerkleRootMultisigIsmFactory,
        staticMessageIdMultisigIsmFactory:
          params.addresses.staticMessageIdMultisigIsmFactory,
        staticAggregationIsmFactory:
          params.addresses.staticAggregationIsmFactory,
        staticAggregationHookFactory:
          params.addresses.staticAggregationHookFactory,
        domainRoutingIsmFactory: params.addresses.domainRoutingIsmFactory,
      },
      proxyFactoryFactories,
      multiProvider.getSigner(params.chain),
    );

    this.chain = this.multiProvider.getChainName(this.args.chain);
    this.domainId = this.multiProvider.getDomainId(this.chain);
  }

  public async read(): Promise<IsmConfig> {
    return typeof this.args.config === 'string'
      ? this.args.addresses.deployedIsm
      : this.reader.deriveIsmConfig(this.args.addresses.deployedIsm);
  }

  // whoever calls update() needs to ensure that targetConfig has a valid owner
  public async update(
    targetConfig: IsmConfig,
  ): Promise<AnnotatedEV5Transaction[]> {
    targetConfig = IsmConfigSchema.parse(targetConfig);

    // Do not support updating to a custom ISM address
    if (typeof targetConfig === 'string') {
      throw new Error(
        'Invalid targetConfig: Updating to a custom ISM address is not supported. Please provide a valid ISM configuration.',
      );
    }

    // save current config for comparison
    // normalize the config to ensure it's in a consistent format for comparison
    const currentConfig = normalizeConfig(await this.read());
    // Update the config
    this.args.config = targetConfig;
    targetConfig = normalizeConfig(targetConfig);

    assert(
      typeof targetConfig === 'object',
      'normalized targetConfig should be an object',
    );

    // if it's a fallback routing ISM, do a mailbox diff check

    // If configs match, no updates needed
    if (deepEquals(currentConfig, targetConfig)) {
      return [];
    }

    // Else, we have to figure out what an update for this ISM entails
    // Check if we need to deploy a new ISM
    if (
      // if updating from an address/custom config to a proper ISM config, do a new deploy
      typeof currentConfig === 'string' ||
      // if updating a proper ISM config whose types are different, do a new deploy
      currentConfig.type !== targetConfig.type ||
      // if it is not a mutable ISM, do a new deploy
      !MUTABLE_ISM_TYPE.includes(targetConfig.type)
    ) {
      const contract = await this.deploy({
        config: targetConfig,
      });

      this.args.addresses.deployedIsm = contract.address;
      return [];
    }

    // At this point, only the 3 ownable/mutable ISM types should remain: PAUSABLE, ROUTING, FALLBACK_ROUTING
    if (
      targetConfig.type !== IsmType.PAUSABLE &&
      targetConfig.type !== IsmType.ROUTING &&
      targetConfig.type !== IsmType.FALLBACK_ROUTING
    ) {
      throw new Error(`Unsupported ISM type ${targetConfig.type}`);
    }

    const logger = this.logger.child({
      destination: this.chain,
      ismType: targetConfig.type,
    });
    logger.debug(`Updating ${targetConfig.type} on ${this.chain}`);

    // if it's either of the routing ISMs, update their submodules
    let updateTxs: AnnotatedEV5Transaction[] = [];
    if (
      targetConfig.type === IsmType.ROUTING ||
      targetConfig.type === IsmType.FALLBACK_ROUTING
    ) {
      updateTxs = await this.updateRoutingIsm({
        current: currentConfig as RoutingIsmConfig,
        target: targetConfig,
        logger,
      });
    }

    // Lastly, check if the resolved owner is different from the current owner
    const provider = this.multiProvider.getProvider(this.chain);
    const owner = await Ownable__factory.connect(
      this.args.addresses.deployedIsm,
      provider,
    ).owner();

    // Return an ownership transfer transaction if required
    if (!eqAddress(targetConfig.owner, owner)) {
      updateTxs.push({
        annotation: 'Transferring ownership of ownable ISM...',
        chainId: this.domainId,
        to: this.args.addresses.deployedIsm,
        data: Ownable__factory.createInterface().encodeFunctionData(
          'transferOwnership(address)',
          [targetConfig.owner],
        ),
      });
    }

    return updateTxs;
  }

  // manually write static create function
  public static async create({
    chain,
    config,
    proxyFactoryFactories,
    mailbox,
    multiProvider,
    contractVerifier,
  }: {
    chain: ChainNameOrId;
    config: IsmConfig;
    proxyFactoryFactories: HyperlaneAddresses<ProxyFactoryFactories>;
    mailbox: Address;
    multiProvider: MultiProvider;
    contractVerifier?: ContractVerifier;
  }): Promise<EvmIsmModule> {
    const module = new EvmIsmModule(
      multiProvider,
      {
        addresses: {
          ...proxyFactoryFactories,
          mailbox,
          deployedIsm: ethers.constants.AddressZero,
        },
        chain,
        config,
      },
      contractVerifier,
    );

    const deployedIsm = await module.deploy({ config });
    module.args.addresses.deployedIsm = deployedIsm.address;

    return module;
  }

  protected async updateRoutingIsm({
    current,
    target,
    logger,
  }: {
    current: RoutingIsmConfig;
    target: RoutingIsmConfig;
    logger: Logger;
  }): Promise<AnnotatedEV5Transaction[]> {
    const routingIsmInterface = DomainRoutingIsm__factory.createInterface();
    const updateTxs = [];

    // filter out domains which are not part of the multiprovider
    current = {
      ...current,
      domains: this.filterRoutingIsmDomains({
        config: current,
      }).availableDomains,
    };
    target = {
      ...target,
      domains: this.filterRoutingIsmDomains({
        config: target,
      }).availableDomains,
    };

    const { domainsToEnroll, domainsToUnenroll } = calculateDomainRoutingDelta(
      current,
      target,
    );

    // Enroll domains
    for (const origin of domainsToEnroll) {
      logger.debug(
        `Reconfiguring preexisting routing ISM for origin ${origin}...`,
      );
      const ism = await this.deploy({
        config: target.domains[origin],
      });

      const domainId = this.multiProvider.getDomainId(origin);
      updateTxs.push({
        annotation: `Setting new ISM for origin ${origin}...`,
        chainId: this.domainId,
        to: this.args.addresses.deployedIsm,
        data: routingIsmInterface.encodeFunctionData('set(uint32,address)', [
          domainId,
          ism.address,
        ]),
      });
    }

    // Unenroll domains
    for (const origin of domainsToUnenroll) {
      const domainId = this.multiProvider.getDomainId(origin);
      updateTxs.push({
        annotation: `Unenrolling originDomain ${domainId} from preexisting routing ISM at ${this.args.addresses.deployedIsm}...`,
        chainId: this.domainId,
        to: this.args.addresses.deployedIsm,
        data: routingIsmInterface.encodeFunctionData('remove(uint32)', [
          domainId,
        ]),
      });
    }

    return updateTxs;
  }

  protected async deploy({
    config,
  }: {
    config: IsmConfig;
  }): Promise<DeployedIsm> {
    config = IsmConfigSchema.parse(config);

    // If it's an address ISM, just return a base ISM
    if (typeof config === 'string') {
      // TODO: https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/3773
      // we can remove the ts-ignore once we have a proper type for address ISMs
      // @ts-ignore
      return IInterchainSecurityModule__factory.connect(
        config,
        this.multiProvider.getSignerOrProvider(this.args.chain),
      );
    }

    const ismType = config.type;
    const logger = rootLogger.child({ chainName: this.chain, ismType });

    logger.debug(`Deploying ${ismType} to ${this.args.chain}`);

    switch (ismType) {
      case IsmType.MESSAGE_ID_MULTISIG:
      case IsmType.MERKLE_ROOT_MULTISIG:
        return this.deployMultisigIsm({
          config,
          logger,
        });

      case IsmType.ROUTING:
      case IsmType.FALLBACK_ROUTING:
        return this.deployRoutingIsm({
          config,
          logger,
        });

      case IsmType.AGGREGATION:
        return this.deployAggregationIsm({
          config,
          logger,
        });

      case IsmType.OP_STACK:
        return this.deployer.deployContractFromFactory({
          chain: this.chain,
          factory: new OPStackIsm__factory(),
          contractName: IsmType.OP_STACK,
          constructorArgs: [config.nativeBridge],
        });

      case IsmType.ARB_L2_TO_L1:
        return this.deployer.deployContractFromFactory({
          chain: this.chain,
          factory: new ArbL2ToL1Ism__factory(),
          contractName: IsmType.ARB_L2_TO_L1,
          constructorArgs: [config.bridge],
        });

      case IsmType.PAUSABLE:
        return this.deployer.deployContractFromFactory({
          chain: this.chain,
          factory: new PausableIsm__factory(),
          contractName: IsmType.PAUSABLE,
          constructorArgs: [config.owner],
        });

      case IsmType.TRUSTED_RELAYER:
        assert(
          this.args.addresses.mailbox,
          `Mailbox address is required for deploying ${ismType}`,
        );
        return this.deployer.deployContractFromFactory({
          chain: this.chain,
          factory: new TrustedRelayerIsm__factory(),
          contractName: IsmType.TRUSTED_RELAYER,
          constructorArgs: [this.args.addresses.mailbox, config.relayer],
        });

      case IsmType.TEST_ISM:
        return this.deployer.deployContractFromFactory({
          chain: this.chain,
          factory: new TestIsm__factory(),
          contractName: IsmType.TEST_ISM,
          constructorArgs: [],
        });

      default:
        throw new Error(`Unsupported ISM type ${ismType}`);
    }
  }

  protected async deployMultisigIsm({
    config,
    logger,
  }: {
    config: MultisigIsmConfig;
    logger: Logger;
  }): Promise<IMultisigIsm> {
    const signer = this.multiProvider.getSigner(this.chain);
    const factoryName =
      config.type === IsmType.MERKLE_ROOT_MULTISIG
        ? 'staticMerkleRootMultisigIsmFactory'
        : 'staticMessageIdMultisigIsmFactory';

    const address = await EvmModuleDeployer.deployStaticAddressSet({
      chain: this.chain,
      factory: this.factories[factoryName],
      values: config.validators,
      logger,
      threshold: config.threshold,
      multiProvider: this.multiProvider,
    });

    return IMultisigIsm__factory.connect(address, signer);
  }

  protected async deployRoutingIsm({
    config,
    logger,
  }: {
    config: RoutingIsmConfig;
    logger: Logger;
  }): Promise<IRoutingIsm> {
    // filter out domains which are not part of the multiprovider
    const { availableDomains, availableDomainIds } =
      this.filterRoutingIsmDomains({
        config,
      });
    config = {
      ...config,
      domains: availableDomains,
    };

    // deploy the submodules first
    const submoduleAddresses: Address[] = [];
    for (const origin of Object.keys(config.domains)) {
      const { address } = await this.deploy({
        config: config.domains[origin],
      });
      submoduleAddresses.push(address);
    }

    if (config.type === IsmType.FALLBACK_ROUTING) {
      // deploy the fallback routing ISM
      logger.debug('Deploying fallback routing ISM ...');
      const ism = await this.multiProvider.handleDeploy(
        this.chain,
        new DefaultFallbackRoutingIsm__factory(),
        [this.args.addresses.mailbox],
      );

      // initialize the fallback routing ISM
      logger.debug('Initializing fallback routing ISM ...');
      const tx = await ism['initialize(address,uint32[],address[])'](
        config.owner,
        availableDomainIds,
        submoduleAddresses,
      );

      await this.multiProvider.handleTx(this.chain, tx);
      // return the fallback routing ISM
      return ism;
    }

    // then deploy the domain routing ISM
    logger.debug('Deploying domain routing ISM ...');
    return this.deployDomainRoutingIsm({
      owner: config.owner,
      domainIds: availableDomainIds,
      submoduleAddresses,
    });
  }

  protected async deployDomainRoutingIsm({
    owner,
    domainIds,
    submoduleAddresses,
  }: {
    owner: string;
    domainIds: number[];
    submoduleAddresses: string[];
  }): Promise<DomainRoutingIsm> {
    const overrides = this.multiProvider.getTransactionOverrides(
      this.args.chain,
    );

    const signer = this.multiProvider.getSigner(this.args.chain);
    const domainRoutingIsmFactory = DomainRoutingIsmFactory__factory.connect(
      this.args.addresses.domainRoutingIsmFactory,
      signer,
    );

    // estimate gas
    const estimatedGas = await domainRoutingIsmFactory.estimateGas.deploy(
      owner,
      domainIds,
      submoduleAddresses,
      overrides,
    );

    // deploying new domain routing ISM, add 10% buffer
    const tx = await domainRoutingIsmFactory.deploy(
      owner,
      domainIds,
      submoduleAddresses,
      {
        ...overrides,
        gasLimit: estimatedGas.add(estimatedGas.div(10)), // 10% buffer
      },
    );

    const receipt = await this.multiProvider.handleTx(this.args.chain, tx);
    const dispatchLogs = findMatchingLogEvents(
      receipt.logs,
      domainRoutingIsmFactory.interface,
      'ModuleDeployed',
    );

    if (dispatchLogs.length === 0) {
      throw new Error('No ModuleDeployed event found');
    }

    const moduleAddress = dispatchLogs[0].args['module'];
    return DomainRoutingIsm__factory.connect(moduleAddress, signer);
  }

  protected async deployAggregationIsm({
    config,
    logger,
  }: {
    config: AggregationIsmConfig;
    logger: Logger;
  }): Promise<IAggregationIsm> {
    const addresses: Address[] = [];
    // Needs to be deployed sequentially because Ethers will throw `Error: replacement fee too low`
    for (const module of config.modules) {
      const submodule = await this.deploy({ config: module });
      addresses.push(submodule.address);
    }

    const factoryName = 'staticAggregationIsmFactory';
    const address = await EvmModuleDeployer.deployStaticAddressSet({
      chain: this.chain,
      factory: this.factories[factoryName],
      values: addresses,
      logger: logger,
      threshold: config.threshold,
      multiProvider: this.multiProvider,
    });

    const signer = this.multiProvider.getSigner(this.args.chain);
    return IAggregationIsm__factory.connect(address, signer);
  }

  // filtering out domains which are not part of the multiprovider
  private filterRoutingIsmDomains({ config }: { config: RoutingIsmConfig }) {
    const availableDomainIds: number[] = [];
    const availableDomains = objFilter(
      config.domains,
      (domain, _): _ is IsmConfig => {
        const domainId = this.multiProvider.tryGetDomainId(domain);
        if (domainId === null) {
          this.logger.warn(
            `Domain ${domain} doesn't have chain metadata provided, skipping ...`,
          );
          return false;
        }

        availableDomainIds.push(domainId);
        return true;
      },
    );

    return { availableDomains, availableDomainIds };
  }
}
