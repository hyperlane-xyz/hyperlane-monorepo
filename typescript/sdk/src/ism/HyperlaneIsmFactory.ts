import { ethers } from 'ethers';
import { Logger } from 'pino';

import {
  AmountRoutingIsm__factory,
  ArbL2ToL1Ism__factory,
  CCIPIsm,
  CCIPIsm__factory,
  DefaultFallbackRoutingIsm,
  DefaultFallbackRoutingIsm__factory,
  DomainRoutingIsm,
  DomainRoutingIsm__factory,
  IAggregationIsm,
  IAggregationIsm__factory,
  IInterchainSecurityModule__factory,
  IMultisigIsm,
  IMultisigIsm__factory,
  IRoutingIsm,
  IStaticWeightedMultisigIsm,
  InterchainAccountIsm__factory,
  OPStackIsm__factory,
  PausableIsm__factory,
  StaticAddressSetFactory,
  StaticThresholdAddressSetFactory,
  StaticWeightedValidatorSetFactory,
  StorageAggregationIsm__factory,
  StorageMerkleRootMultisigIsm__factory,
  StorageMessageIdMultisigIsm__factory,
  TestIsm__factory,
  TrustedRelayerIsm__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  Domain,
  addBufferToGasLimit,
  assert,
  eqAddress,
  objFilter,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { HyperlaneApp } from '../app/HyperlaneApp.js';
import { CCIPContractCache } from '../ccip/utils.js';
import { appFromAddressesMapHelper } from '../contracts/contracts.js';
import {
  HyperlaneAddressesMap,
  HyperlaneContractsMap,
} from '../contracts/types.js';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer.js';
import {
  ProxyFactoryFactories,
  proxyFactoryFactories,
} from '../deploy/contracts.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainMap, ChainName } from '../types.js';

import {
  AggregationIsmConfig,
  AmountRoutingIsmConfig,
  CCIPIsmConfig,
  DeployedIsm,
  DeployedIsmType,
  DomainRoutingIsmConfig,
  IsmConfig,
  IsmType,
  MultisigIsmConfig,
  RoutingIsmConfig,
  RoutingIsmDelta,
  WeightedMultisigIsmConfig,
} from './types.js';
import { routingModuleDelta } from './utils.js';

const ismFactories = {
  [IsmType.PAUSABLE]: new PausableIsm__factory(),
  [IsmType.TRUSTED_RELAYER]: new TrustedRelayerIsm__factory(),
  [IsmType.TEST_ISM]: new TestIsm__factory(),
  [IsmType.OP_STACK]: new OPStackIsm__factory(),
  [IsmType.ARB_L2_TO_L1]: new ArbL2ToL1Ism__factory(),
  [IsmType.CCIP]: new CCIPIsm__factory(),
};

class IsmDeployer extends HyperlaneDeployer<{}, typeof ismFactories> {
  protected readonly cachingEnabled = false;

  deployContracts(_chain: ChainName, _config: any): Promise<any> {
    throw new Error('Method not implemented.');
  }
}

export class HyperlaneIsmFactory extends HyperlaneApp<ProxyFactoryFactories> {
  // The shape of this object is `ChainMap<Address | ChainMap<Address>`,
  // although `any` is use here because that type breaks a lot of signatures.
  // TODO: fix this in the next refactoring
  public deployedIsms: ChainMap<any> = {};
  protected readonly deployer: IsmDeployer;

  constructor(
    contractsMap: HyperlaneContractsMap<ProxyFactoryFactories>,
    public readonly multiProvider: MultiProvider,
    public readonly ccipContractCache: CCIPContractCache = new CCIPContractCache(),
  ) {
    super(
      contractsMap,
      multiProvider,
      rootLogger.child({ module: 'ismFactoryApp' }),
    );
    this.deployer = new IsmDeployer(multiProvider, ismFactories);
  }

  static fromAddressesMap(
    addressesMap: HyperlaneAddressesMap<any>,
    multiProvider: MultiProvider,
    ccipContractCache?: CCIPContractCache,
  ): HyperlaneIsmFactory {
    const helper = appFromAddressesMapHelper(
      addressesMap,
      proxyFactoryFactories,
      multiProvider,
    );
    return new HyperlaneIsmFactory(
      helper.contractsMap,
      multiProvider,
      ccipContractCache,
    );
  }

  async deploy<C extends IsmConfig>(params: {
    destination: ChainName;
    config: C;
    origin?: ChainName;
    mailbox?: Address;
    existingIsmAddress?: Address;
  }): Promise<DeployedIsm> {
    const { destination, config, origin, mailbox, existingIsmAddress } = params;
    if (typeof config === 'string') {
      // @ts-ignore
      return IInterchainSecurityModule__factory.connect(
        config,
        this.multiProvider.getSignerOrProvider(destination),
      );
    }

    const ismType = config.type;
    const logger = this.logger.child({ destination, ismType });

    logger.debug(
      `Deploying ISM of type ${ismType} to ${destination} ${
        origin ? `(for verifying ${origin})` : ''
      }`,
    );

    let contract: DeployedIsmType[typeof ismType];
    switch (ismType) {
      case IsmType.MESSAGE_ID_MULTISIG:
      case IsmType.MERKLE_ROOT_MULTISIG:
      case IsmType.STORAGE_MESSAGE_ID_MULTISIG:
      case IsmType.STORAGE_MERKLE_ROOT_MULTISIG:
        contract = await this.deployMultisigIsm(destination, config, logger);
        break;
      case IsmType.WEIGHTED_MESSAGE_ID_MULTISIG:
      case IsmType.WEIGHTED_MERKLE_ROOT_MULTISIG:
        contract = await this.deployWeightedMultisigIsm(
          destination,
          config,
          logger,
        );
        break;
      case IsmType.ROUTING:
      case IsmType.FALLBACK_ROUTING:
      case IsmType.ICA_ROUTING:
      case IsmType.AMOUNT_ROUTING:
        contract = await this.deployRoutingIsm({
          destination,
          config,
          origin,
          mailbox,
          existingIsmAddress,
          logger,
        });
        break;
      case IsmType.AGGREGATION:
      case IsmType.STORAGE_AGGREGATION:
        contract = await this.deployAggregationIsm({
          destination,
          config,
          origin,
          mailbox,
          logger,
        });
        break;
      case IsmType.OP_STACK:
        contract = await this.deployer.deployContract(destination, ismType, [
          config.nativeBridge,
        ]);
        break;
      case IsmType.PAUSABLE:
        contract = await this.deployer.deployContract(
          destination,
          IsmType.PAUSABLE,
          [config.owner],
        );
        break;
      case IsmType.TRUSTED_RELAYER:
        assert(mailbox, `Mailbox address is required for deploying ${ismType}`);
        contract = await this.deployer.deployContract(
          destination,
          IsmType.TRUSTED_RELAYER,
          [mailbox, config.relayer],
        );
        break;
      case IsmType.TEST_ISM:
        contract = await this.deployer.deployContract(
          destination,
          IsmType.TEST_ISM,
          [],
        );
        break;
      case IsmType.ARB_L2_TO_L1:
        contract = await this.deployer.deployContract(
          destination,
          IsmType.ARB_L2_TO_L1,
          [config.bridge],
        );
        break;
      case IsmType.CCIP:
        contract = await this.deployCCIPIsm(destination, config);
        break;
      default:
        throw new Error(`Unsupported ISM type ${ismType}`);
    }

    if (!this.deployedIsms[destination]) {
      this.deployedIsms[destination] = {};
    }
    if (origin) {
      // if we're deploying network-specific contracts (e.g. ISMs), store them as sub-entry
      // under that network's key (`origin`)
      if (!this.deployedIsms[destination][origin]) {
        this.deployedIsms[destination][origin] = {};
      }
      this.deployedIsms[destination][origin][ismType] = contract;
    } else {
      // otherwise store the entry directly
      this.deployedIsms[destination][ismType] = contract;
    }

    return contract;
  }

  protected async deployCCIPIsm(
    destination: ChainName,
    config: CCIPIsmConfig,
  ): Promise<CCIPIsm> {
    const ism = this.ccipContractCache.getIsm(config.originChain, destination);
    if (!ism) {
      this.logger.error(
        `CCIP ISM not found for ${config.originChain} -> ${destination}`,
      );
      throw new Error(
        `CCIP ISM not found for ${config.originChain} -> ${destination}`,
      );
    }
    return CCIPIsm__factory.connect(
      ism,
      this.multiProvider.getSigner(destination),
    );
  }

  protected async deployMultisigIsm(
    destination: ChainName,
    config: MultisigIsmConfig,
    logger: Logger,
  ): Promise<IMultisigIsm> {
    const signer = this.multiProvider.getSigner(destination);

    const deployStatic = (factory: StaticThresholdAddressSetFactory) =>
      this.deployStaticAddressSet(
        destination,
        factory,
        config.validators,
        logger,
        config.threshold,
      );

    const deployStorage = async (
      factory:
        | StorageMerkleRootMultisigIsm__factory
        | StorageMessageIdMultisigIsm__factory,
    ) => {
      const contract = await this.multiProvider.handleDeploy(
        destination,
        factory,
        [config.validators, config.threshold],
      );
      return contract.address;
    };

    let address: string;
    switch (config.type) {
      case IsmType.MERKLE_ROOT_MULTISIG:
        address = await deployStatic(
          this.getContracts(destination).staticMerkleRootMultisigIsmFactory,
        );
        break;
      case IsmType.MESSAGE_ID_MULTISIG:
        address = await deployStatic(
          this.getContracts(destination).staticMessageIdMultisigIsmFactory,
        );
        break;
      // TODO: support using minimal proxy factories for storage multisig ISMs too
      case IsmType.STORAGE_MERKLE_ROOT_MULTISIG:
        address = await deployStorage(
          new StorageMerkleRootMultisigIsm__factory(),
        );
        break;
      case IsmType.STORAGE_MESSAGE_ID_MULTISIG:
        address = await deployStorage(
          new StorageMessageIdMultisigIsm__factory(),
        );
        break;
      default:
        throw new Error(`Unsupported multisig ISM type ${config.type}`);
    }

    return IMultisigIsm__factory.connect(address, signer);
  }

  protected async deployWeightedMultisigIsm(
    destination: ChainName,
    config: WeightedMultisigIsmConfig,
    logger: Logger,
  ): Promise<IMultisigIsm> {
    const signer = this.multiProvider.getSigner(destination);
    const weightedmultisigIsmFactory =
      config.type === IsmType.WEIGHTED_MERKLE_ROOT_MULTISIG
        ? this.getContracts(destination)
            .staticMerkleRootWeightedMultisigIsmFactory
        : this.getContracts(destination)
            .staticMessageIdWeightedMultisigIsmFactory;

    const address = await this.deployStaticWeightedValidatorSet(
      destination,
      weightedmultisigIsmFactory,
      config.validators,
      config.thresholdWeight,
      logger,
    );

    return IMultisigIsm__factory.connect(address, signer);
  }

  protected async deployRoutingIsm(params: {
    destination: ChainName;
    config: RoutingIsmConfig;
    origin?: ChainName;
    mailbox?: Address;
    existingIsmAddress?: Address;
    logger: Logger;
  }): Promise<IRoutingIsm> {
    const { config } = params;

    if (config.type === IsmType.ICA_ROUTING) {
      return this.deployIcaIsm(params);
    }

    if (config.type === IsmType.AMOUNT_ROUTING) {
      return this.deployAmountRoutingIsm({
        config: config,
        destination: params.destination,
        origin: params.origin,
        mailbox: params.mailbox,
      });
    }

    return this.deployOwnableRoutingIsm({
      ...params,
      // Can't pass params directly because ts will complain that the types do not match
      config,
    });
  }

  private async deployIcaIsm(params: {
    destination: ChainName;
    config: RoutingIsmConfig;
    mailbox?: Address;
  }): Promise<IRoutingIsm> {
    if (!params.mailbox) {
      throw new Error('Mailbox address is required for deploying ICA ISM');
    }

    return this.multiProvider.handleDeploy(
      params.destination,
      new InterchainAccountIsm__factory(),
      [params.mailbox],
    );
  }

  private async deployAmountRoutingIsm(params: {
    destination: ChainName;
    config: AmountRoutingIsmConfig;
    origin?: ChainName;
    mailbox?: Address;
  }): Promise<IRoutingIsm> {
    const { threshold, lowerIsm, upperIsm } = params.config;

    const addresses: Address[] = [];
    for (const module of [lowerIsm, upperIsm]) {
      const submodule = await this.deploy({
        destination: params.destination,
        config: module,
        origin: params.origin,
        mailbox: params.mailbox,
      });
      addresses.push(submodule.address);
    }

    const [lowerIsmAddress, upperIsmAddress] = addresses;

    return this.multiProvider.handleDeploy(
      params.destination,
      new AmountRoutingIsm__factory(),
      [lowerIsmAddress, upperIsmAddress, threshold],
    );
  }

  private async deployOwnableRoutingIsm(params: {
    destination: ChainName;
    config: DomainRoutingIsmConfig;
    origin?: ChainName;
    mailbox?: Address;
    existingIsmAddress?: Address;
    logger: Logger;
  }): Promise<IRoutingIsm> {
    const { destination, config, mailbox, existingIsmAddress, logger } = params;
    const overrides = this.multiProvider.getTransactionOverrides(destination);
    const domainRoutingIsmFactory =
      this.getContracts(destination).domainRoutingIsmFactory;
    let routingIsm: DomainRoutingIsm | DefaultFallbackRoutingIsm;
    // filtering out domains which are not part of the multiprovider
    config.domains = objFilter(config.domains, (domain, _): _ is IsmConfig => {
      const domainId = this.multiProvider.tryGetDomainId(domain);
      if (domainId === null) {
        logger.warn(
          `Domain ${domain} doesn't have chain metadata provided, skipping ...`,
        );
      }
      return domainId !== null;
    });
    const safeConfigDomains = Object.keys(config.domains).map((domain) =>
      this.multiProvider.getDomainId(domain),
    );
    const delta: RoutingIsmDelta = existingIsmAddress
      ? await routingModuleDelta(
          destination,
          existingIsmAddress,
          config,
          this.multiProvider,
          this.getContracts(destination),
          mailbox,
        )
      : {
          domainsToUnenroll: [],
          domainsToEnroll: safeConfigDomains,
        };

    const signer = this.multiProvider.getSigner(destination);
    const provider = this.multiProvider.getProvider(destination);
    let isOwner = false;
    if (existingIsmAddress) {
      const owner = await DomainRoutingIsm__factory.connect(
        existingIsmAddress,
        provider,
      ).owner();
      isOwner = eqAddress(await signer.getAddress(), owner);
    }

    // reconfiguring existing routing ISM
    if (existingIsmAddress && isOwner && !delta.mailbox) {
      const isms: Record<Domain, Address> = {};
      routingIsm = DomainRoutingIsm__factory.connect(
        existingIsmAddress,
        this.multiProvider.getSigner(destination),
      );
      // deploying all the ISMs which have to be updated
      for (const originDomain of delta.domainsToEnroll) {
        const origin = this.multiProvider.getChainName(originDomain); // already filtered to only include domains in the multiprovider
        logger.debug(
          `Reconfiguring preexisting routing ISM at for origin ${origin}...`,
        );
        const ism = await this.deploy({
          destination,
          config: config.domains[origin],
          origin,
          mailbox,
        });
        isms[originDomain] = ism.address;
        const tx = await routingIsm.set(
          originDomain,
          isms[originDomain],
          overrides,
        );
        await this.multiProvider.handleTx(destination, tx);
      }
      // unenrolling domains if needed
      for (const originDomain of delta.domainsToUnenroll) {
        logger.debug(
          `Unenrolling originDomain ${originDomain} from preexisting routing ISM at ${existingIsmAddress}...`,
        );
        const tx = await routingIsm.remove(originDomain, overrides);
        await this.multiProvider.handleTx(destination, tx);
      }
      // transfer ownership if needed
      if (delta.owner) {
        logger.debug(`Transferring ownership of routing ISM...`);
        const tx = await routingIsm.transferOwnership(delta.owner, overrides);
        await this.multiProvider.handleTx(destination, tx);
      }
    } else {
      const isms: ChainMap<Address> = {};
      for (const origin of Object.keys(config.domains)) {
        const ism = await this.deploy({
          destination,
          config: config.domains[origin],
          origin,
          mailbox,
        });
        isms[origin] = ism.address;
      }
      const submoduleAddresses = Object.values(isms);
      let receipt: ethers.providers.TransactionReceipt;
      if (config.type === IsmType.FALLBACK_ROUTING) {
        // deploying new fallback routing ISM
        if (!mailbox) {
          throw new Error(
            'Mailbox address is required for deploying fallback routing ISM',
          );
        }
        logger.debug('Deploying fallback routing ISM ...');
        routingIsm = await this.multiProvider.handleDeploy(
          destination,
          new DefaultFallbackRoutingIsm__factory(),
          [mailbox],
        );
        // TODO: Should verify contract here
        logger.debug('Initialising fallback routing ISM ...');
        receipt = await this.multiProvider.handleTx(
          destination,
          routingIsm['initialize(address,uint32[],address[])'](
            config.owner,
            safeConfigDomains,
            submoduleAddresses,
            overrides,
          ),
        );
      } else {
        // deploying new domain routing ISM
        const owner = config.owner;
        // estimate gas
        const estimatedGas = await domainRoutingIsmFactory.estimateGas.deploy(
          owner,
          safeConfigDomains,
          submoduleAddresses,
          overrides,
        );
        // add gas buffer
        const tx = await domainRoutingIsmFactory.deploy(
          owner,
          safeConfigDomains,
          submoduleAddresses,
          {
            gasLimit: addBufferToGasLimit(estimatedGas),
            ...overrides,
          },
        );
        // TODO: Should verify contract here
        receipt = await this.multiProvider.handleTx(destination, tx);

        // TODO: Break this out into a generalized function
        const dispatchLogs = receipt.logs
          .map((log) => {
            try {
              return domainRoutingIsmFactory.interface.parseLog(log);
            } catch {
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
        routingIsm = DomainRoutingIsm__factory.connect(
          moduleAddress,
          this.multiProvider.getSigner(destination),
        );
      }
    }
    return routingIsm;
  }

  protected async deployAggregationIsm(params: {
    destination: ChainName;
    config: AggregationIsmConfig;
    origin?: ChainName;
    mailbox?: Address;
    logger: Logger;
  }): Promise<IAggregationIsm> {
    const { destination, config, origin, mailbox } = params;
    const signer = this.multiProvider.getSigner(destination);

    const addresses: Address[] = [];
    for (const module of config.modules) {
      const submodule = await this.deploy({
        destination,
        config: module,
        origin,
        mailbox,
      });
      addresses.push(submodule.address);
    }

    let ismAddress: string;
    if (config.type === IsmType.STORAGE_AGGREGATION) {
      // TODO: support using minimal proxy factories for storage aggregation ISMs too
      const factory = new StorageAggregationIsm__factory().connect(signer);
      const ism = await this.multiProvider.handleDeploy(destination, factory, [
        addresses,
        config.threshold,
      ]);
      ismAddress = ism.address;
    } else {
      const staticAggregationIsmFactory =
        this.getContracts(destination).staticAggregationIsmFactory;

      ismAddress = await this.deployStaticAddressSet(
        destination,
        staticAggregationIsmFactory,
        addresses,
        params.logger,
        config.threshold,
      );
    }

    return IAggregationIsm__factory.connect(ismAddress, signer);
  }

  async deployStaticAddressSet(
    chain: ChainName,
    factory: StaticThresholdAddressSetFactory | StaticAddressSetFactory,
    values: Address[],
    logger: Logger,
    threshold = values.length,
  ): Promise<Address> {
    const sorted = [...values].sort();

    const address = await factory['getAddress(address[],uint8)'](
      sorted,
      threshold,
    );
    const code = await this.multiProvider.getProvider(chain).getCode(address);
    if (code === '0x') {
      logger.debug(
        `Deploying new ${threshold} of ${values.length} address set to ${chain}`,
      );
      const overrides = this.multiProvider.getTransactionOverrides(chain);

      // estimate gas
      const estimatedGas = await factory.estimateGas['deploy(address[],uint8)'](
        sorted,
        threshold,
        overrides,
      );
      // add gas buffer
      const hash = await factory['deploy(address[],uint8)'](sorted, threshold, {
        gasLimit: addBufferToGasLimit(estimatedGas),
        ...overrides,
      });

      await this.multiProvider.handleTx(chain, hash);
      // TODO: add proxy verification artifact?
    } else {
      logger.debug(
        `Recovered ${threshold} of ${values.length} address set on ${chain}: ${address}`,
      );
    }
    return address;
  }

  async deployStaticWeightedValidatorSet(
    chain: ChainName,
    factory: StaticWeightedValidatorSetFactory,
    values: IStaticWeightedMultisigIsm.ValidatorInfoStruct[],
    thresholdWeight = 66e8,
    logger: Logger,
  ): Promise<Address> {
    const sorted = [...values].sort();

    const address = await factory['getAddress((address,uint96)[],uint96)'](
      sorted,
      thresholdWeight,
    );
    const code = await this.multiProvider.getProvider(chain).getCode(address);
    if (code === '0x') {
      logger.debug(
        `Deploying new weighted set of ${values.length} validators with a threshold weight ${thresholdWeight} on ${chain} `,
      );
      const overrides = this.multiProvider.getTransactionOverrides(chain);

      // estimate gas
      const estimatedGas = await factory.estimateGas[
        'deploy((address,uint96)[],uint96)'
      ](sorted, thresholdWeight, overrides);
      // add gas buffer
      const hash = await factory['deploy((address,uint96)[],uint96)'](
        sorted,
        thresholdWeight,
        {
          gasLimit: addBufferToGasLimit(estimatedGas),
          ...overrides,
        },
      );

      await this.multiProvider.handleTx(chain, hash);
      // TODO: add proxy verification artifact?
    } else {
      logger.debug(
        `Recovered weighted set of ${values.length} validators on ${chain} with a threshold weight ${thresholdWeight}: ${address}`,
      );
    }
    return address;
  }
}
