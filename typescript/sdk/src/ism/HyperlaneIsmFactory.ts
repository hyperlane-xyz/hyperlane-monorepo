import { ethers } from 'ethers';
import { Logger } from 'pino';

import {
  ArbL2ToL1Ism__factory,
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
  OPStackIsm__factory,
  PausableIsm__factory,
  StaticAddressSetFactory,
  StaticThresholdAddressSetFactory,
  StaticWeightedValidatorSetFactory,
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
  DeployedIsm,
  DeployedIsmType,
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
  ): HyperlaneIsmFactory {
    const helper = appFromAddressesMapHelper(
      addressesMap,
      proxyFactoryFactories,
      multiProvider,
    );
    return new HyperlaneIsmFactory(helper.contractsMap, multiProvider);
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
      `Deploying ${ismType} to ${destination} ${
        origin ? `(for verifying ${origin})` : ''
      }`,
    );

    let contract: DeployedIsmType[typeof ismType];
    switch (ismType) {
      case IsmType.MESSAGE_ID_MULTISIG:
      case IsmType.MERKLE_ROOT_MULTISIG:
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

  protected async deployMultisigIsm(
    destination: ChainName,
    config: MultisigIsmConfig,
    logger: Logger,
  ): Promise<IMultisigIsm> {
    const signer = this.multiProvider.getSigner(destination);
    const multisigIsmFactory =
      config.type === IsmType.MERKLE_ROOT_MULTISIG
        ? this.getContracts(destination).staticMerkleRootMultisigIsmFactory
        : this.getContracts(destination).staticMessageIdMultisigIsmFactory;

    const address = await this.deployStaticAddressSet(
      destination,
      multisigIsmFactory,
      config.validators,
      logger,
      config.threshold,
    );

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
    const { destination, config, mailbox, existingIsmAddress, logger } = params;
    const overrides = this.multiProvider.getTransactionOverrides(destination);
    const domainRoutingIsmFactory =
      this.getContracts(destination).domainRoutingIsmFactory;
    let routingIsm: DomainRoutingIsm | DefaultFallbackRoutingIsm;
    // filtering out domains which are not part of the multiprovider
    config.domains = objFilter(
      config.domains,
      (domain, config): config is IsmConfig => {
        const domainId = this.multiProvider.tryGetDomainId(domain);
        if (domainId === null) {
          logger.warn(
            `Domain ${domain} doesn't have chain metadata provided, skipping ...`,
          );
        }
        return domainId !== null;
      },
    );
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
    const staticAggregationIsmFactory =
      this.getContracts(destination).staticAggregationIsmFactory;
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
    const address = await this.deployStaticAddressSet(
      destination,
      staticAggregationIsmFactory,
      addresses,
      params.logger,
      config.threshold,
    );
    return IAggregationIsm__factory.connect(address, signer);
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
