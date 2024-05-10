import { Signer, ethers } from 'ethers';
import { Logger } from 'pino';

import {
  DefaultFallbackRoutingIsm__factory,
  DomainRoutingIsm,
  DomainRoutingIsmFactory__factory,
  DomainRoutingIsm__factory,
  IAggregationIsm,
  IAggregationIsm__factory,
  IMultisigIsm,
  IMultisigIsm__factory,
  IRoutingIsm,
  OPStackIsm__factory,
  PausableIsm__factory,
  StaticAddressSetFactory,
  StaticAggregationHookFactory__factory,
  StaticAggregationIsmFactory__factory,
  StaticMerkleRootMultisigIsmFactory__factory,
  StaticMessageIdMultisigIsmFactory__factory,
  StaticThresholdAddressSetFactory,
  StaticThresholdAddressSetFactory__factory,
  TestIsm__factory,
  TrustedRelayerIsm__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  Domain,
  ProtocolType,
  assert,
  eqAddress,
  objFilter,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { HyperlaneAddresses, HyperlaneContracts } from '../contracts/types.js';
import {
  HyperlaneModule,
  HyperlaneModuleArgs,
} from '../core/AbstractHyperlaneModule.js';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer.js';
import { ProxyFactoryFactories } from '../deploy/contracts.js';
import { resolveOrDeployAccountOwner } from '../index.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { EthersV5Transaction } from '../providers/ProviderType.js';
import { ChainMap, ChainName, ChainNameOrId } from '../types.js';

import { EvmIsmReader } from './EvmIsmReader.js';
import {
  AggregationIsmConfig,
  DeployedIsm,
  DeployedIsmType,
  IsmConfig,
  IsmType,
  MultisigIsmConfig,
  RoutingIsmConfig,
  RoutingIsmDelta,
} from './types.js';
import { routingModuleDelta } from './utils.js';

export class EvmIsmModule extends HyperlaneModule<
  ProtocolType.Ethereum,
  IsmConfig,
  HyperlaneAddresses<ProxyFactoryFactories> & {
    deployedIsm: Address;
  }
> {
  protected logger = rootLogger.child({ module: 'EvmIsmModule' });
  protected reader: EvmIsmReader;
  protected factories: HyperlaneContracts<ProxyFactoryFactories>;

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

    const signer = this.multiProvider.getSigner(args.chain);
    this.factories = {
      staticMerkleRootMultisigIsmFactory:
        StaticMerkleRootMultisigIsmFactory__factory.connect(
          args.addresses.staticMerkleRootMultisigIsmFactory,
          signer,
        ),
      staticMessageIdMultisigIsmFactory:
        StaticMessageIdMultisigIsmFactory__factory.connect(
          args.addresses.staticMessageIdMultisigIsmFactory,
          signer,
        ),
      staticAggregationIsmFactory: StaticAggregationIsmFactory__factory.connect(
        args.addresses.staticAggregationIsmFactory,
        signer,
      ),
      staticAggregationHookFactory:
        StaticAggregationHookFactory__factory.connect(
          args.addresses.staticAggregationHookFactory,
          signer,
        ),
      domainRoutingIsmFactory: DomainRoutingIsmFactory__factory.connect(
        args.addresses.domainRoutingIsmFactory,
        signer,
      ),
    };
  }

  public async read(): Promise<IsmConfig> {
    return this.reader.deriveIsmConfig(this.args.addresses.deployedIsm);
  }

  public async update(config: IsmConfig): Promise<EthersV5Transaction[]> {
    const destination = this.multiProvider.getChainName(this.args.chain);

    if (typeof config === 'string') {
      this.logger.debug('Skipping update for config of type Address.');
      return [];
    }

    const ismType = config.type;
    const logger = this.logger.child({ destination, ismType });

    logger.debug(
      `Updating ${ismType} on ${destination} ${
        origin ? `(for verifying ${origin})` : ''
      }`,
    );

    let contract: DeployedIsm;
    if (ismType === IsmType.ROUTING || ismType === IsmType.FALLBACK_ROUTING) {
      // The current logic performs does some checks to see if the current signer is the owner.
      // If not owner, it will under the hood create new ISMs if necessary. In the future, we can optimise
      // this so that it returns a minimum set of transactions to update the ISM in-place.
      contract = await this.updateRoutingIsm({
        destination,
        config,
        origin,
        existingIsmAddress: this.args.addresses.deployedIsm,
        logger,
      });
    } else {
      contract = await EvmIsmModule.deploy({
        destination,
        config,
        multiProvider: this.multiProvider,
        factories: this.args.addresses,
        deployer: this.deployer,
      });
    }

    // if update was in-place, there's no change in address
    this.args.addresses.deployedIsm = contract.address;
    this.args.config = config;
    return [];
  }

  // manually write static create function
  public static async create(params: {
    chain: ChainNameOrId;
    config: IsmConfig;
    deployer: HyperlaneDeployer<any, any>;
    factories: HyperlaneAddresses<ProxyFactoryFactories>;
    multiProvider: MultiProvider;
  }): Promise<EvmIsmModule> {
    const { chain, config, deployer, factories, multiProvider } = params;
    const destination = multiProvider.getChainName(chain);
    const deployedIsm = await EvmIsmModule.deploy({
      config,
      destination,
      multiProvider,
      factories,
      deployer,
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

  protected async updateRoutingIsm(params: {
    destination: ChainName;
    config: RoutingIsmConfig;
    origin?: ChainName;
    mailbox?: Address;
    existingIsmAddress: Address;
    logger: Logger;
  }): Promise<IRoutingIsm> {
    const { destination, config, mailbox, existingIsmAddress, logger } = params;

    // 1. Filter for known domains
    const { domains, safeConfigDomains } = EvmIsmModule.filterRoutingIsmDomains(
      { config, multiProvider: this.multiProvider },
    );
    config.domains = domains;

    // 2. Compute the delta
    const delta: RoutingIsmDelta = await routingModuleDelta(
      destination,
      existingIsmAddress,
      config,
      this.multiProvider,
      this.factories,
      mailbox,
    );

    // Step 3: Get owner and signer
    const signer = this.multiProvider.getSigner(destination);
    const provider = this.multiProvider.getProvider(destination);
    const owner = await DomainRoutingIsm__factory.connect(
      existingIsmAddress,
      provider,
    ).owner();
    const isOwner = eqAddress(await signer.getAddress(), owner);

    if (existingIsmAddress && isOwner && !delta.mailbox) {
      // 4. If possible, reconfigure existing ISM
      return await this.reconfigureExistingRoutingIsm({
        destination,
        delta,
        existingIsmAddress,
        config,
        mailbox,
        logger,
      });
    } else {
      // 5. Else, deploy a new set of routing ISM submodules
      const submoduleAddresses = await this.deployRoutingIsmSubmodules({
        destination,
        config,
        mailbox,
      });

      const owner = await resolveOrDeployAccountOwner(
        this.multiProvider,
        destination,
        config.owner,
      );

      if (config.type === IsmType.FALLBACK_ROUTING) {
        if (!mailbox) {
          throw new Error(
            'Mailbox address is required for deploying fallback routing ISM',
          );
        }

        // 6. If fallback routing ISM, reinitialise in-place with new submodules
        return await this.initializeFallbackRoutingIsm({
          destination,
          owner,
          safeConfigDomains,
          submoduleAddresses,
          existingIsmAddress,
          signer,
          logger,
        });
      } else {
        // 7. Else, deploy a new domain routing ISM
        return await EvmIsmModule.deployDomainRoutingIsm({
          destination,
          owner,
          safeConfigDomains,
          submoduleAddresses,
          overrides: this.multiProvider.getTransactionOverrides(destination),
          multiProvider: this.multiProvider,
          factories: this.args.addresses,
        });
      }
    }
  }

  protected async reconfigureExistingRoutingIsm(params: {
    destination: ChainName;
    delta: RoutingIsmDelta;
    existingIsmAddress: Address;
    config: RoutingIsmConfig;
    mailbox?: Address;
    logger: Logger;
  }): Promise<IRoutingIsm> {
    const { destination, delta, existingIsmAddress, config, mailbox, logger } =
      params;
    const overrides = this.multiProvider.getTransactionOverrides(destination);

    const routingIsm = DomainRoutingIsm__factory.connect(
      existingIsmAddress,
      this.multiProvider.getSigner(destination),
    );

    // Enroll domains
    for (const originDomain of delta.domainsToEnroll) {
      const origin = this.multiProvider.getChainName(originDomain);
      logger.debug(
        `Reconfiguring preexisting routing ISM for origin ${origin}...`,
      );
      const ism = await EvmIsmModule.deploy({
        destination,
        config: config.domains[origin],
        origin,
        mailbox,
        multiProvider: this.multiProvider,
        factories: this.args.addresses,
        deployer: this.deployer,
      });
      const tx = await routingIsm.set(originDomain, ism.address, overrides);
      await this.multiProvider.handleTx(destination, tx);
    }

    // Unenroll domains
    for (const originDomain of delta.domainsToUnenroll) {
      logger.debug(
        `Unenrolling originDomain ${originDomain} from preexisting routing ISM at ${existingIsmAddress}...`,
      );
      const tx = await routingIsm.remove(originDomain, overrides);
      await this.multiProvider.handleTx(destination, tx);
    }

    // Transfer ownership if needed
    if (delta.owner) {
      logger.debug(`Transferring ownership of routing ISM...`);
      const tx = await routingIsm.transferOwnership(delta.owner, overrides);
      await this.multiProvider.handleTx(destination, tx);
    }

    return routingIsm;
  }

  protected async initializeFallbackRoutingIsm(params: {
    destination: ChainName;
    owner: Address;
    safeConfigDomains: Domain[];
    submoduleAddresses: Address[];
    existingIsmAddress: Address;
    signer: Signer;
    logger: Logger;
  }): Promise<IRoutingIsm> {
    const {
      destination,
      owner,
      safeConfigDomains,
      submoduleAddresses,
      existingIsmAddress,
      signer,
      logger,
    } = params;
    const routingIsm = DefaultFallbackRoutingIsm__factory.connect(
      existingIsmAddress,
      signer,
    );

    logger.debug('Initializing fallback routing ISM ...');
    await this.multiProvider.handleTx(
      destination,
      routingIsm['initialize(address,uint32[],address[])'](
        owner,
        safeConfigDomains,
        submoduleAddresses,
        this.multiProvider.getTransactionOverrides(destination),
      ),
    );

    return routingIsm;
  }

  protected async deployRoutingIsmSubmodules(params: {
    destination: ChainName;
    config: RoutingIsmConfig;
    mailbox?: Address;
  }): Promise<Address[]> {
    const { destination, config, mailbox } = params;
    const isms: ChainMap<Address> = {};

    for (const origin of Object.keys(config.domains)) {
      const ism = await EvmIsmModule.deploy({
        destination,
        config: config.domains[origin],
        origin,
        mailbox,
        multiProvider: this.multiProvider,
        factories: this.args.addresses,
        deployer: this.deployer,
      });
      isms[origin] = ism.address;
    }

    return Object.values(isms);
  }

  protected static async deploy<C extends IsmConfig>(params: {
    destination: ChainName;
    config: C;
    origin?: ChainName;
    mailbox?: Address;
    multiProvider: MultiProvider;
    factories: HyperlaneAddresses<ProxyFactoryFactories>;
    deployer: HyperlaneDeployer<any, any>;
  }): Promise<DeployedIsm> {
    const {
      destination,
      config,
      origin,
      mailbox,
      multiProvider,
      factories,
      deployer,
    } = params;
    if (typeof config === 'string') {
      // @ts-ignore
      return IInterchainSecurityModule__factory.connect(
        config,
        multiProvider.getSignerOrProvider(destination),
      );
    }

    const ismType = config.type;
    const logger = rootLogger.child({ destination, ismType });

    logger.debug(
      `Deploying ${ismType} to ${destination} ${
        origin ? `(for verifying ${origin})` : ''
      }`,
    );

    let contract: DeployedIsmType[typeof ismType];
    switch (ismType) {
      case IsmType.MESSAGE_ID_MULTISIG:
      case IsmType.MERKLE_ROOT_MULTISIG:
        contract = await EvmIsmModule.deployMultisigIsm({
          destination,
          config,
          logger,
          multiProvider,
          factories,
        });
        break;
      case IsmType.ROUTING:
      case IsmType.FALLBACK_ROUTING:
        contract = await EvmIsmModule.deployRoutingIsm({
          destination,
          config,
          origin,
          mailbox,
          logger,
          multiProvider,
          factories,
          deployer,
        });
        break;
      case IsmType.AGGREGATION:
        contract = await EvmIsmModule.deployAggregationIsm({
          destination,
          config,
          origin,
          mailbox,
          logger,
          multiProvider,
          factories,
          deployer,
        });
        break;
      case IsmType.OP_STACK:
        contract = await deployer.deployContractFromFactory(
          destination,
          new OPStackIsm__factory(),
          IsmType.OP_STACK,
          [config.nativeBridge],
        );
        break;
      case IsmType.PAUSABLE:
        contract = await deployer.deployContractFromFactory(
          destination,
          new PausableIsm__factory(),
          IsmType.PAUSABLE,
          [
            await resolveOrDeployAccountOwner(
              multiProvider,
              destination,
              config.owner,
            ),
          ],
        );
        await deployer.transferOwnershipOfContracts(destination, config, {
          [IsmType.PAUSABLE]: contract,
        });
        break;
      case IsmType.TRUSTED_RELAYER:
        assert(mailbox, `Mailbox address is required for deploying ${ismType}`);
        contract = await deployer.deployContractFromFactory(
          destination,
          new TrustedRelayerIsm__factory(),
          IsmType.TRUSTED_RELAYER,
          [mailbox, config.relayer],
        );
        break;
      case IsmType.TEST_ISM:
        contract = await deployer.deployContractFromFactory(
          destination,
          new TestIsm__factory(),
          IsmType.TEST_ISM,
          [],
        );
        break;
      default:
        throw new Error(`Unsupported ISM type ${ismType}`);
    }

    return contract;
  }

  protected static async deployMultisigIsm(params: {
    destination: ChainName;
    config: MultisigIsmConfig;
    logger: Logger;
    multiProvider: MultiProvider;
    factories: HyperlaneAddresses<ProxyFactoryFactories>;
  }): Promise<IMultisigIsm> {
    const { destination, config, logger, multiProvider, factories } = params;

    const signer = multiProvider.getSigner(destination);
    const multisigIsmFactory =
      config.type === IsmType.MERKLE_ROOT_MULTISIG
        ? factories.staticMerkleRootMultisigIsmFactory
        : factories.staticMessageIdMultisigIsmFactory;
    const factory: StaticThresholdAddressSetFactory =
      StaticThresholdAddressSetFactory__factory.connect(
        multisigIsmFactory,
        signer,
      );

    const address = await EvmIsmModule.deployStaticAddressSet({
      chain: destination,
      factory,
      values: config.validators,
      logger,
      threshold: config.threshold,
      multiProvider,
    });

    return IMultisigIsm__factory.connect(address, signer);
  }

  protected static async deployRoutingIsm(params: {
    destination: ChainName;
    config: RoutingIsmConfig;
    origin?: ChainName;
    mailbox?: Address;
    logger: Logger;
    multiProvider: MultiProvider;
    factories: HyperlaneAddresses<ProxyFactoryFactories>;
    deployer: HyperlaneDeployer<any, any>;
  }): Promise<IRoutingIsm> {
    const {
      destination,
      config,
      mailbox,
      logger,
      multiProvider,
      factories,
      deployer,
    } = params;
    const overrides = multiProvider.getTransactionOverrides(destination);

    const { domains, safeConfigDomains } = EvmIsmModule.filterRoutingIsmDomains(
      { config, multiProvider },
    );
    config.domains = domains;

    const isms: ChainMap<Address> = {};
    const owner = await resolveOrDeployAccountOwner(
      multiProvider,
      destination,
      config.owner,
    );

    for (const origin of Object.keys(config.domains)) {
      const ism = await EvmIsmModule.deploy({
        destination,
        config: config.domains[origin],
        origin,
        mailbox,
        multiProvider,
        factories,
        deployer,
      });
      isms[origin] = ism.address;
    }

    const submoduleAddresses = Object.values(isms);

    if (config.type === IsmType.FALLBACK_ROUTING) {
      // deploying new fallback routing ISM
      if (!mailbox) {
        throw new Error(
          'Mailbox address is required for deploying fallback routing ISM',
        );
      }

      logger.debug('Deploying fallback routing ISM ...');
      return await multiProvider.handleDeploy(
        destination,
        new DefaultFallbackRoutingIsm__factory(),
        [mailbox],
      );
    }

    logger.debug('Deploying domain routing ISM ...');
    return await EvmIsmModule.deployDomainRoutingIsm({
      destination,
      owner,
      safeConfigDomains,
      submoduleAddresses,
      overrides,
      multiProvider,
      factories,
    });
  }

  protected static async deployDomainRoutingIsm(params: {
    destination: ChainName;
    owner: string;
    safeConfigDomains: number[];
    submoduleAddresses: string[];
    multiProvider: MultiProvider;
    factories: HyperlaneAddresses<ProxyFactoryFactories>;
    overrides?: ethers.Overrides;
  }): Promise<DomainRoutingIsm> {
    const {
      destination,
      owner,
      safeConfigDomains,
      submoduleAddresses,
      multiProvider,
      factories,
      overrides = multiProvider.getTransactionOverrides(destination),
    } = params;

    const signer = multiProvider.getSigner(destination);
    const domainRoutingIsmFactory = DomainRoutingIsmFactory__factory.connect(
      factories.domainRoutingIsmFactory,
      signer,
    );

    // deploying new domain routing ISM
    const tx = await domainRoutingIsmFactory.deploy(
      owner,
      safeConfigDomains,
      submoduleAddresses,
      overrides,
    );

    const receipt = await multiProvider.handleTx(destination, tx);

    const dispatchLogs = receipt.logs
      .map((log) => {
        try {
          return domainRoutingIsmFactory.interface.parseLog(log);
        } catch (e) {
          return undefined;
        }
      })
      .filter(
        (log): log is ethers.utils.LogDescription =>
          !!log && log.name === 'ModuleDeployed',
      );

    if (dispatchLogs.length === 0) {
      throw new Error('No ModuleDeployed event found');
    }

    const moduleAddress = dispatchLogs[0].args['module'];
    return DomainRoutingIsm__factory.connect(moduleAddress, signer);
  }

  protected static async deployAggregationIsm(params: {
    destination: ChainName;
    config: AggregationIsmConfig;
    origin?: ChainName;
    mailbox?: Address;
    logger: Logger;
    multiProvider: MultiProvider;
    factories: HyperlaneAddresses<ProxyFactoryFactories>;
    deployer: HyperlaneDeployer<any, any>;
  }): Promise<IAggregationIsm> {
    const {
      destination,
      config,
      origin,
      mailbox,
      logger,
      multiProvider,
      factories,
      deployer,
    } = params;

    const signer = multiProvider.getSigner(destination);

    const addresses: Address[] = [];
    for (const module of config.modules) {
      const submodule = await EvmIsmModule.deploy({
        destination,
        config: module,
        origin,
        mailbox,
        multiProvider,
        factories,
        deployer,
      });
      addresses.push(submodule.address);
    }

    const factory = StaticAggregationIsmFactory__factory.connect(
      factories.staticAggregationIsmFactory,
      signer,
    );

    const address = await EvmIsmModule.deployStaticAddressSet({
      chain: destination,
      factory,
      values: addresses,
      logger: logger,
      threshold: config.threshold,
      multiProvider,
    });
    return IAggregationIsm__factory.connect(address, signer);
  }

  protected static async deployStaticAddressSet(params: {
    chain: ChainName;
    factory: StaticThresholdAddressSetFactory | StaticAddressSetFactory;
    values: Address[];
    logger: Logger;
    threshold?: number;
    multiProvider: MultiProvider;
  }): Promise<Address> {
    const {
      chain,
      factory,
      values,
      logger,
      threshold = values.length,
      multiProvider,
    } = params;
    const sorted = [...values].sort();

    const address = await factory['getAddress(address[],uint8)'](
      sorted,
      threshold,
    );
    const code = await multiProvider.getProvider(chain).getCode(address);
    if (code === '0x') {
      logger.debug(
        `Deploying new ${threshold} of ${values.length} address set to ${chain}`,
      );
      const overrides = multiProvider.getTransactionOverrides(chain);
      const hash = await factory['deploy(address[],uint8)'](
        sorted,
        threshold,
        overrides,
      );
      await multiProvider.handleTx(chain, hash);
      // TODO: add proxy verification artifact?
    } else {
      logger.debug(
        `Recovered ${threshold} of ${values.length} address set on ${chain}: ${address}`,
      );
    }
    return address;
  }

  // filtering out domains which are not part of the multiprovider
  private static filterRoutingIsmDomains(params: {
    config: RoutingIsmConfig;
    multiProvider: MultiProvider;
  }) {
    const { config, multiProvider } = params;

    const domains = objFilter(config.domains, (domain, _): _ is IsmConfig =>
      multiProvider.hasChain(domain),
    );

    const safeConfigDomains = Object.keys(config.domains).map((domain) =>
      multiProvider.getDomainId(domain),
    );

    return { domains, safeConfigDomains };
  }
}
