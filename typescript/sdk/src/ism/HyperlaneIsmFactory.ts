import { debug } from 'debug';
import { ethers } from 'ethers';

import {
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
  IRoutingIsm__factory,
  MailboxClient__factory,
  OPStackIsm,
  OPStackIsm__factory,
  PausableIsm__factory,
  StaticAddressSetFactory,
  StaticAggregationIsm__factory,
  StaticThresholdAddressSetFactory,
  TestIsm__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  Domain,
  eqAddress,
  formatMessage,
  normalizeAddress,
  objFilter,
  objMap,
  warn,
} from '@hyperlane-xyz/utils';

import { HyperlaneApp } from '../app/HyperlaneApp';
import {
  HyperlaneEnvironment,
  hyperlaneEnvironments,
} from '../consts/environments';
import { appFromAddressesMapHelper } from '../contracts/contracts';
import { HyperlaneAddressesMap, HyperlaneContracts } from '../contracts/types';
import {
  ProxyFactoryFactories,
  proxyFactoryFactories,
} from '../deploy/contracts';
import { logger } from '../logger';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';

import {
  AggregationIsmConfig,
  DeployedIsm,
  DeployedIsmType,
  IsmConfig,
  IsmType,
  ModuleType,
  MultisigIsmConfig,
  OpStackIsmConfig,
  RoutingIsmConfig,
  RoutingIsmDelta,
  ismTypeToModuleType,
} from './types';

export class HyperlaneIsmFactory extends HyperlaneApp<ProxyFactoryFactories> {
  // The shape of this object is `ChainMap<Address | ChainMap<Address>`,
  // although `any` is use here because that type breaks a lot of signatures.
  // TODO: fix this in the next refactoring
  public deployedIsms: ChainMap<any> = {};

  static fromEnvironment<Env extends HyperlaneEnvironment>(
    env: Env,
    multiProvider: MultiProvider,
  ): HyperlaneIsmFactory {
    const envAddresses = hyperlaneEnvironments[env];
    if (!envAddresses) {
      throw new Error(`No addresses found for ${env}`);
    }
    /// @ts-ignore
    return HyperlaneIsmFactory.fromAddressesMap(envAddresses, multiProvider);
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
    return new HyperlaneIsmFactory(
      helper.contractsMap,
      multiProvider,
      debug('hyperlane:IsmFactoryApp'),
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
    this.logger(
      `Deploying ${ismType} to ${destination} ${
        origin ? `(for verifying ${origin})` : ''
      }`,
    );

    let contract: DeployedIsmType[typeof ismType];
    switch (ismType) {
      case IsmType.MESSAGE_ID_MULTISIG:
      case IsmType.MERKLE_ROOT_MULTISIG:
        contract = await this.deployMultisigIsm(destination, config);
        break;
      case IsmType.ROUTING:
      case IsmType.FALLBACK_ROUTING:
        contract = await this.deployRoutingIsm({
          destination,
          config,
          origin,
          mailbox,
          existingIsmAddress,
        });
        break;
      case IsmType.AGGREGATION:
        contract = await this.deployAggregationIsm({
          destination,
          config,
          origin,
          mailbox,
        });
        break;
      case IsmType.OP_STACK:
        contract = await this.deployOpStackIsm(destination, config);
        break;
      case IsmType.PAUSABLE:
        contract = await this.multiProvider.handleDeploy(
          destination,
          new PausableIsm__factory(),
          [config.owner],
        );
        break;
      case IsmType.TEST_ISM:
        contract = await this.multiProvider.handleDeploy(
          destination,
          new TestIsm__factory(),
          [],
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
  ): Promise<IMultisigIsm> {
    const signer = this.multiProvider.getSigner(destination);
    const multisigIsmFactory =
      config.type === IsmType.MERKLE_ROOT_MULTISIG
        ? this.getContracts(destination).merkleRootMultisigIsmFactory
        : this.getContracts(destination).messageIdMultisigIsmFactory;

    const address = await this.deployStaticAddressSet(
      destination,
      multisigIsmFactory,
      config.validators,
      config.threshold,
    );

    return IMultisigIsm__factory.connect(address, signer);
  }

  protected async deployRoutingIsm(params: {
    destination: ChainName;
    config: RoutingIsmConfig;
    origin?: ChainName;
    mailbox?: Address;
    existingIsmAddress?: Address;
  }): Promise<IRoutingIsm> {
    const { destination, config, mailbox, existingIsmAddress } = params;
    const overrides = this.multiProvider.getTransactionOverrides(destination);
    const routingIsmFactory = this.getContracts(destination).routingIsmFactory;
    let routingIsm: DomainRoutingIsm | DefaultFallbackRoutingIsm;
    // filtering out domains which are not part of the multiprovider
    config.domains = objFilter(
      config.domains,
      (domain, config): config is IsmConfig => {
        const domainId = this.multiProvider.tryGetDomainId(domain);
        if (domainId === null) {
          warn(
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
        logger(
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
        logger(
          `Unenrolling originDomain ${originDomain} from preexisting routing ISM at ${existingIsmAddress}...`,
        );
        const tx = await routingIsm.remove(originDomain, overrides);
        await this.multiProvider.handleTx(destination, tx);
      }
      // transfer ownership if needed
      if (delta.owner) {
        logger(`Transferring ownership of routing ISM...`);
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
        logger('Deploying fallback routing ISM ...');
        routingIsm = await this.multiProvider.handleDeploy(
          destination,
          new DefaultFallbackRoutingIsm__factory(),
          [mailbox],
        );
        logger('Initialising fallback routing ISM ...');
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
        const tx = await routingIsmFactory.deploy(
          config.owner,
          safeConfigDomains,
          submoduleAddresses,
          overrides,
        );
        receipt = await this.multiProvider.handleTx(destination, tx);

        // TODO: Break this out into a generalized function
        const dispatchLogs = receipt.logs
          .map((log) => {
            try {
              return routingIsmFactory.interface.parseLog(log);
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
  }): Promise<IAggregationIsm> {
    const { destination, config, origin, mailbox } = params;
    const signer = this.multiProvider.getSigner(destination);
    const aggregationIsmFactory =
      this.getContracts(destination).aggregationIsmFactory;
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
      aggregationIsmFactory,
      addresses,
      config.threshold,
    );
    return IAggregationIsm__factory.connect(address, signer);
  }

  protected async deployOpStackIsm(
    chain: ChainName,
    config: OpStackIsmConfig,
  ): Promise<OPStackIsm> {
    return await this.multiProvider.handleDeploy(
      chain,
      new OPStackIsm__factory(),
      [config.nativeBridge],
    );
  }

  async deployStaticAddressSet(
    chain: ChainName,
    factory: StaticThresholdAddressSetFactory | StaticAddressSetFactory,
    values: Address[],
    threshold = values.length,
  ): Promise<Address> {
    const sorted = [...values].sort();

    const address = await factory['getAddress(address[],uint8)'](
      sorted,
      threshold,
    );
    const code = await this.multiProvider.getProvider(chain).getCode(address);
    if (code === '0x') {
      this.logger(
        `Deploying new ${threshold} of ${values.length} address set to ${chain}`,
      );
      const overrides = this.multiProvider.getTransactionOverrides(chain);
      const hash = await factory['deploy(address[],uint8)'](
        sorted,
        threshold,
        overrides,
      );
      await this.multiProvider.handleTx(chain, hash);
      // TODO: add proxy verification artifact?
    } else {
      this.logger(
        `Recovered ${threshold} of ${values.length} address set on ${chain}`,
      );
    }
    return address;
  }
}

// Note that this function may return false negatives, but should
// not return false positives.
// This can happen if, for example, the module has sender, recipient, or
// body specific logic, as the sample message used when querying the ISM
// sets all of these to zero.
export async function moduleCanCertainlyVerify(
  destModule: Address | IsmConfig,
  multiProvider: MultiProvider,
  origin: ChainName,
  destination: ChainName,
): Promise<boolean> {
  const originDomainId = multiProvider.tryGetDomainId(origin);
  const destinationDomainId = multiProvider.tryGetDomainId(destination);
  if (!originDomainId || !destinationDomainId) {
    return false;
  }
  const message = formatMessage(
    0,
    0,
    originDomainId,
    ethers.constants.AddressZero,
    destinationDomainId,
    ethers.constants.AddressZero,
    '0x',
  );
  const provider = multiProvider.getSignerOrProvider(destination);

  if (typeof destModule === 'string') {
    const module = IInterchainSecurityModule__factory.connect(
      destModule,
      provider,
    );

    try {
      const moduleType = await module.moduleType();
      if (
        moduleType === ModuleType.MERKLE_ROOT_MULTISIG ||
        moduleType === ModuleType.MESSAGE_ID_MULTISIG
      ) {
        const multisigModule = IMultisigIsm__factory.connect(
          destModule,
          provider,
        );

        const [, threshold] = await multisigModule.validatorsAndThreshold(
          message,
        );
        return threshold > 0;
      } else if (moduleType === ModuleType.ROUTING) {
        const routingIsm = IRoutingIsm__factory.connect(destModule, provider);
        const subModule = await routingIsm.route(message);
        return moduleCanCertainlyVerify(
          subModule,
          multiProvider,
          origin,
          destination,
        );
      } else if (moduleType === ModuleType.AGGREGATION) {
        const aggregationIsm = IAggregationIsm__factory.connect(
          destModule,
          provider,
        );
        const [subModules, threshold] =
          await aggregationIsm.modulesAndThreshold(message);
        let verified = 0;
        for (const subModule of subModules) {
          const canVerify = await moduleCanCertainlyVerify(
            subModule,
            multiProvider,
            origin,
            destination,
          );
          if (canVerify) {
            verified += 1;
          }
        }
        return verified >= threshold;
      } else {
        throw new Error(`Unsupported module type: ${moduleType}`);
      }
    } catch (e) {
      logger(`Error checking module ${destModule}: ${e}`);
      return false;
    }
  } else {
    // destModule is an IsmConfig
    switch (destModule.type) {
      case IsmType.MERKLE_ROOT_MULTISIG:
      case IsmType.MESSAGE_ID_MULTISIG:
        return destModule.threshold > 0;
      case IsmType.ROUTING: {
        const checking = moduleCanCertainlyVerify(
          destModule.domains[destination],
          multiProvider,
          origin,
          destination,
        );
        return checking;
      }
      case IsmType.AGGREGATION: {
        let verified = 0;
        for (const subModule of destModule.modules) {
          const canVerify = await moduleCanCertainlyVerify(
            subModule,
            multiProvider,
            origin,
            destination,
          );
          if (canVerify) {
            verified += 1;
          }
        }
        return verified >= destModule.threshold;
      }
      case IsmType.OP_STACK:
        return destModule.nativeBridge !== ethers.constants.AddressZero;
      case IsmType.TEST_ISM: {
        return true;
      }
      default:
        throw new Error(`Unsupported module type: ${(destModule as any).type}`);
    }
  }
}

export async function moduleMatchesConfig(
  chain: ChainName,
  moduleAddress: Address,
  config: IsmConfig,
  multiProvider: MultiProvider,
  contracts: HyperlaneContracts<ProxyFactoryFactories>,
  mailbox?: Address,
): Promise<boolean> {
  if (typeof config === 'string') {
    return eqAddress(moduleAddress, config);
  }

  // If the module address is zero, it can't match any object-based config.
  // The subsequent check of what moduleType it is will throw, so we fail here.
  if (eqAddress(moduleAddress, ethers.constants.AddressZero)) {
    return false;
  }

  const provider = multiProvider.getProvider(chain);
  const module = IInterchainSecurityModule__factory.connect(
    moduleAddress,
    provider,
  );
  const actualType = await module.moduleType();
  if (actualType !== ismTypeToModuleType(config.type)) return false;
  let matches = true;
  switch (config.type) {
    case IsmType.MERKLE_ROOT_MULTISIG: {
      // A MerkleRootMultisigIsm matches if validators and threshold match the config
      const expectedAddress =
        await contracts.merkleRootMultisigIsmFactory.getAddress(
          config.validators.sort(),
          config.threshold,
        );
      matches = eqAddress(expectedAddress, module.address);
      break;
    }
    case IsmType.MESSAGE_ID_MULTISIG: {
      // A MessageIdMultisigIsm matches if validators and threshold match the config
      const expectedAddress =
        await contracts.messageIdMultisigIsmFactory.getAddress(
          config.validators.sort(),
          config.threshold,
        );
      matches = eqAddress(expectedAddress, module.address);
      break;
    }
    case IsmType.FALLBACK_ROUTING:
    case IsmType.ROUTING: {
      // A RoutingIsm matches if:
      //   1. The set of domains in the config equals those on-chain
      //   2. The modules for each domain match the config
      // TODO: Check (1)
      const routingIsm = DomainRoutingIsm__factory.connect(
        moduleAddress,
        provider,
      );
      // Check that the RoutingISM owner matches the config
      const owner = await routingIsm.owner();
      matches &&= eqAddress(owner, config.owner);
      // check if the mailbox matches the config for fallback routing
      if (config.type === IsmType.FALLBACK_ROUTING) {
        const client = MailboxClient__factory.connect(moduleAddress, provider);
        const mailboxAddress = await client.mailbox();
        matches =
          matches &&
          mailbox !== undefined &&
          eqAddress(mailboxAddress, mailbox);
      }
      const delta = await routingModuleDelta(
        chain,
        moduleAddress,
        config,
        multiProvider,
        contracts,
        mailbox,
      );
      matches =
        matches &&
        delta.domainsToEnroll.length === 0 &&
        delta.domainsToUnenroll.length === 0 &&
        !delta.mailbox &&
        !delta.owner;
      break;
    }
    case IsmType.AGGREGATION: {
      // An AggregationIsm matches if:
      //   1. The threshold matches the config
      //   2. There is a bijection between on and off-chain configured modules
      const aggregationIsm = StaticAggregationIsm__factory.connect(
        moduleAddress,
        provider,
      );
      const [subModules, threshold] = await aggregationIsm.modulesAndThreshold(
        '0x',
      );
      matches &&= threshold === config.threshold;
      matches &&= subModules.length === config.modules.length;

      const configIndexMatched = new Map();
      for (const subModule of subModules) {
        const subModuleMatchesConfig = await Promise.all(
          config.modules.map((c) =>
            moduleMatchesConfig(chain, subModule, c, multiProvider, contracts),
          ),
        );
        // The submodule returned by the ISM must match exactly one
        // entry in the config.
        const count = subModuleMatchesConfig.filter(Boolean).length;
        matches &&= count === 1;

        // That entry in the config should not have been matched already.
        subModuleMatchesConfig.forEach((matched, index) => {
          if (matched) {
            matches &&= !configIndexMatched.has(index);
            configIndexMatched.set(index, true);
          }
        });
      }
      break;
    }
    case IsmType.OP_STACK: {
      const opStackIsm = OPStackIsm__factory.connect(moduleAddress, provider);
      const type = await opStackIsm.moduleType();
      matches &&= type === ModuleType.NULL;
      break;
    }
    case IsmType.TEST_ISM: {
      // This is just a TestISM
      matches = true;
      break;
    }
    case IsmType.PAUSABLE: {
      const pausableIsm = PausableIsm__factory.connect(moduleAddress, provider);
      const owner = await pausableIsm.owner();
      matches &&= eqAddress(owner, config.owner);

      if (config.paused) {
        const isPaused = await pausableIsm.paused();
        matches &&= config.paused === isPaused;
      }
      break;
    }
    default: {
      throw new Error('Unsupported ModuleType');
    }
  }

  return matches;
}

export async function routingModuleDelta(
  destination: ChainName,
  moduleAddress: Address,
  config: RoutingIsmConfig,
  multiProvider: MultiProvider,
  contracts: HyperlaneContracts<ProxyFactoryFactories>,
  mailbox?: Address,
): Promise<RoutingIsmDelta> {
  const provider = multiProvider.getProvider(destination);
  const routingIsm = DomainRoutingIsm__factory.connect(moduleAddress, provider);
  const owner = await routingIsm.owner();
  const deployedDomains = (await routingIsm.domains()).map((domain) =>
    domain.toNumber(),
  );
  // config.domains is already filtered to only include domains in the multiprovider
  const safeConfigDomains = objMap(config.domains, (domain) =>
    multiProvider.getDomainId(domain),
  );

  const delta: RoutingIsmDelta = {
    domainsToUnenroll: [],
    domainsToEnroll: [],
  };

  // if owners don't match, we need to transfer ownership
  if (!eqAddress(owner, normalizeAddress(config.owner)))
    delta.owner = config.owner;
  if (config.type === IsmType.FALLBACK_ROUTING) {
    const client = MailboxClient__factory.connect(moduleAddress, provider);
    const mailboxAddress = await client.mailbox();
    if (mailbox && !eqAddress(mailboxAddress, mailbox)) delta.mailbox = mailbox;
  }
  // check for exclusion of domains in the config
  delta.domainsToUnenroll = deployedDomains.filter(
    (domain) => !Object.values(safeConfigDomains).includes(domain),
  );
  // check for inclusion of domains in the config
  for (const [origin, subConfig] of Object.entries(config.domains)) {
    const originDomain = safeConfigDomains[origin];
    if (!deployedDomains.includes(originDomain)) {
      delta.domainsToEnroll.push(originDomain);
    } else {
      const subModule = await routingIsm.module(originDomain);
      // Recursively check that the submodule for each configured
      // domain matches the submodule config.
      const subModuleMatches = await moduleMatchesConfig(
        destination,
        subModule,
        subConfig,
        multiProvider,
        contracts,
        mailbox,
      );
      if (!subModuleMatches) delta.domainsToEnroll.push(originDomain);
    }
  }
  return delta;
}

export function collectValidators(
  origin: ChainName,
  config: IsmConfig,
): Set<string> {
  // TODO: support address configurations in collectValidators
  if (typeof config === 'string') {
    debug('hyperlane:IsmFactory')(
      'Address config unimplemented in collectValidators',
    );
    return new Set([]);
  }

  let validators: string[] = [];
  if (
    config.type === IsmType.MERKLE_ROOT_MULTISIG ||
    config.type === IsmType.MESSAGE_ID_MULTISIG
  ) {
    validators = config.validators;
  } else if (config.type === IsmType.ROUTING) {
    if (Object.keys(config.domains).includes(origin)) {
      const domainValidators = collectValidators(
        origin,
        config.domains[origin],
      );
      validators = [...domainValidators];
    }
  } else if (config.type === IsmType.AGGREGATION) {
    const aggregatedValidators = config.modules.map((c) =>
      collectValidators(origin, c),
    );
    aggregatedValidators.forEach((set) => {
      validators = validators.concat([...set]);
    });
  } else if (
    config.type === IsmType.TEST_ISM ||
    config.type === IsmType.PAUSABLE
  ) {
    return new Set([]);
  } else {
    throw new Error('Unsupported ModuleType');
  }

  return new Set(validators);
}
