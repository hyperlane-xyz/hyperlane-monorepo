import { debug } from 'debug';
import { ethers } from 'ethers';

import {
  DomainRoutingIsm__factory,
  IAggregationIsm__factory,
  IInterchainSecurityModule__factory,
  IMultisigIsm__factory,
  IRoutingIsm__factory,
  StaticAddressSetFactory,
  StaticAggregationIsm__factory,
  StaticThresholdAddressSetFactory,
  TestIsm__factory,
} from '@hyperlane-xyz/core';
import { Address, eqAddress, formatMessage, warn } from '@hyperlane-xyz/utils';

import { HyperlaneApp } from '../app/HyperlaneApp';
import {
  HyperlaneEnvironment,
  hyperlaneEnvironments,
} from '../consts/environments';
import { appFromAddressesMapHelper } from '../contracts/contracts';
import { HyperlaneAddressesMap, HyperlaneContracts } from '../contracts/types';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';

import { FactoryFactories, factoryFactories } from './contracts';
import {
  AggregationIsmConfig,
  DeployedIsm,
  IsmConfig,
  ModuleType,
  MultisigIsmConfig,
  RoutingIsmConfig,
} from './types';

export class HyperlaneIsmFactory extends HyperlaneApp<FactoryFactories> {
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
    return HyperlaneIsmFactory.fromAddressesMap(envAddresses, multiProvider);
  }

  static fromAddressesMap(
    addressesMap: HyperlaneAddressesMap<any>,
    multiProvider: MultiProvider,
  ): HyperlaneIsmFactory {
    const helper = appFromAddressesMapHelper(
      addressesMap,
      factoryFactories,
      multiProvider,
    );
    return new HyperlaneIsmFactory(
      helper.contractsMap,
      helper.multiProvider,
      debug('hyperlane:IsmFactoryApp'),
    );
  }

  async deploy(
    chain: ChainName,
    config: IsmConfig,
    origin?: ChainName,
  ): Promise<DeployedIsm> {
    let contract: DeployedIsm;
    if (typeof config === 'string') {
      // TODO: return the appropriate ISM type
      return IInterchainSecurityModule__factory.connect(
        config,
        this.multiProvider.getSignerOrProvider(chain),
      );
    }

    if (
      config.type === ModuleType.MERKLE_ROOT_MULTISIG ||
      config.type === ModuleType.MESSAGE_ID_MULTISIG
    ) {
      switch (config.type) {
        case ModuleType.MERKLE_ROOT_MULTISIG:
          this.logger(
            `Deploying Merkle Root Multisig ISM to ${chain} for verifying ${origin}`,
          );
          break;
        case ModuleType.MESSAGE_ID_MULTISIG:
          this.logger(
            `Deploying Message ID Multisig ISM to ${chain} for verifying ${origin}`,
          );
          break;
      }
      contract = await this.deployMultisigIsm(chain, config);
    } else if (config.type === ModuleType.ROUTING) {
      this.logger(
        `Deploying Routing ISM to ${chain} for verifying ${Object.keys(
          config.domains,
        )}`,
      );
      contract = await this.deployRoutingIsm(chain, config);
    } else if (config.type === ModuleType.AGGREGATION) {
      this.logger(`Deploying Aggregation ISM to ${chain}`);
      contract = await this.deployAggregationIsm(chain, config, origin);
    } else if (config.type === ModuleType.NULL) {
      this.logger(`Deploying Test ISM to ${chain}`);
      contract = await this.multiProvider.handleDeploy(
        chain,
        new TestIsm__factory(),
        [],
      );
    } else {
      throw new Error(`Unsupported ISM type`);
    }

    const moduleType = ModuleType[config.type];
    if (!this.deployedIsms[chain]) {
      this.deployedIsms[chain] = {};
    }
    if (origin) {
      // if we're deploying network-specific contracts (e.g. ISMs), store them as sub-entry
      // under that network's key (`origin`)
      if (!this.deployedIsms[chain][origin]) {
        this.deployedIsms[chain][origin] = {};
      }
      this.deployedIsms[chain][origin][moduleType] = contract;
    } else {
      // otherwise store the entry directly
      this.deployedIsms[chain][moduleType] = contract;
    }

    return contract;
  }

  private async deployMultisigIsm(chain: ChainName, config: MultisigIsmConfig) {
    const signer = this.multiProvider.getSigner(chain);
    const multisigIsmFactory =
      config.type === ModuleType.MERKLE_ROOT_MULTISIG
        ? this.getContracts(chain).merkleRootMultisigIsmFactory
        : this.getContracts(chain).messageIdMultisigIsmFactory;

    const address = await this.deployStaticAddressSet(
      chain,
      multisigIsmFactory,
      config.validators,
      config.threshold,
    );

    return IMultisigIsm__factory.connect(address, signer);
  }

  private async deployRoutingIsm(chain: ChainName, config: RoutingIsmConfig) {
    const signer = this.multiProvider.getSigner(chain);
    const routingIsmFactory = this.getContracts(chain).routingIsmFactory;
    const isms: ChainMap<Address> = {};
    for (const origin in config.domains) {
      const ism = await this.deploy(chain, config.domains[origin], origin);
      isms[origin] = ism.address;
    }
    const domains = Object.keys(isms).map((chain) =>
      this.multiProvider.getDomainId(chain),
    );
    const submoduleAddresses = Object.values(isms);
    const overrides = this.multiProvider.getTransactionOverrides(chain);
    const tx = await routingIsmFactory.deploy(
      domains,
      submoduleAddresses,
      overrides,
    );
    const receipt = await this.multiProvider.handleTx(chain, tx);
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
    const moduleAddress = dispatchLogs[0].args['module'];
    const routingIsm = DomainRoutingIsm__factory.connect(
      moduleAddress,
      this.multiProvider.getSigner(chain),
    );
    this.logger(`Transferring ownership of routing ISM to ${config.owner}`);
    await this.multiProvider.handleTx(
      chain,
      await routingIsm.transferOwnership(config.owner, overrides),
    );
    const address = dispatchLogs[0].args['module'];
    return IRoutingIsm__factory.connect(address, signer);
  }

  private async deployAggregationIsm(
    chain: ChainName,
    config: AggregationIsmConfig,
    origin?: ChainName,
  ) {
    const signer = this.multiProvider.getSigner(chain);
    const aggregationIsmFactory =
      this.getContracts(chain).aggregationIsmFactory;
    const addresses: Address[] = [];
    for (const module of config.modules) {
      addresses.push((await this.deploy(chain, module, origin)).address);
    }
    const address = await this.deployStaticAddressSet(
      chain,
      aggregationIsmFactory,
      addresses,
      config.threshold,
    );
    return IAggregationIsm__factory.connect(address, signer);
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
  const message = formatMessage(
    0,
    0,
    multiProvider.getDomainId(origin),
    ethers.constants.AddressZero,
    multiProvider.getDomainId(destination),
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
      warn(`Error checking module ${destModule}: ${e}`);
      return false;
    }
  } else {
    // destModule is an IsmConfig
    switch (destModule.type) {
      case ModuleType.MERKLE_ROOT_MULTISIG:
      case ModuleType.MESSAGE_ID_MULTISIG:
        return destModule.threshold > 0;
      case ModuleType.ROUTING:
        return moduleCanCertainlyVerify(
          destModule.domains[destination],
          multiProvider,
          origin,
          destination,
        );
      case ModuleType.AGGREGATION: {
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
      case ModuleType.NULL: {
        return true;
      }
    }
  }
}

export async function moduleMatchesConfig(
  chain: ChainName,
  moduleAddress: Address,
  config: IsmConfig,
  multiProvider: MultiProvider,
  contracts: HyperlaneContracts<FactoryFactories>,
  _origin?: ChainName,
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
  if (actualType !== config.type) return false;
  let matches = true;
  switch (config.type) {
    case ModuleType.MERKLE_ROOT_MULTISIG: {
      // A MerkleRootMultisigIsm matches if validators and threshold match the config
      const expectedAddress =
        await contracts.merkleRootMultisigIsmFactory.getAddress(
          config.validators.sort(),
          config.threshold,
        );
      matches = eqAddress(expectedAddress, module.address);
      break;
    }
    case ModuleType.MESSAGE_ID_MULTISIG: {
      // A MessageIdMultisigIsm matches if validators and threshold match the config
      const expectedAddress =
        await contracts.messageIdMultisigIsmFactory.getAddress(
          config.validators.sort(),
          config.threshold,
        );
      matches = eqAddress(expectedAddress, module.address);
      break;
    }
    case ModuleType.ROUTING: {
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
      matches = matches && eqAddress(owner, config.owner);
      // Recursively check that the submodule for each configured
      // domain matches the submodule config.
      for (const [origin, subConfig] of Object.entries(config.domains)) {
        const subModule = await routingIsm.module(
          multiProvider.getDomainId(origin),
        );
        const subModuleMatches = await moduleMatchesConfig(
          chain,
          subModule,
          subConfig,
          multiProvider,
          contracts,
          origin,
        );
        matches = matches && subModuleMatches;
      }
      break;
    }
    case ModuleType.AGGREGATION: {
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
      matches = matches && threshold === config.threshold;
      matches = matches && subModules.length === config.modules.length;

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
        matches = matches && count === 1;

        // That entry in the config should not have been matched already.
        subModuleMatchesConfig.forEach((matched, index) => {
          if (matched) {
            matches = matches && !configIndexMatched.has(index);
            configIndexMatched.set(index, true);
          }
        });
      }
      break;
    }
    case ModuleType.NULL: {
      // This is just a TestISM
      matches = true;
      break;
    }
    default: {
      throw new Error('Unsupported ModuleType');
    }
  }

  return matches;
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
    config.type === ModuleType.MERKLE_ROOT_MULTISIG ||
    config.type === ModuleType.MESSAGE_ID_MULTISIG
  ) {
    validators = config.validators;
  } else if (config.type === ModuleType.ROUTING) {
    if (Object.keys(config.domains).includes(origin)) {
      const domainValidators = collectValidators(
        origin,
        config.domains[origin],
      );
      validators = [...domainValidators];
    }
  } else if (config.type === ModuleType.AGGREGATION) {
    const aggregatedValidators = config.modules.map((c) =>
      collectValidators(origin, c),
    );
    aggregatedValidators.forEach((set) => {
      validators = validators.concat([...set]);
    });
  } else if (config.type === ModuleType.NULL) {
    // This is just a TestISM
    return new Set([]);
  } else {
    throw new Error('Unsupported ModuleType');
  }

  return new Set(validators);
}
