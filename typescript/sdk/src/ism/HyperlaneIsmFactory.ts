import { debug } from 'debug';
import { ethers } from 'ethers';

import {
  DomainRoutingIsm__factory,
  IAggregationIsm__factory,
  IInterchainSecurityModule__factory,
  IMultisigIsm__factory,
  IRoutingIsm__factory,
  LegacyMultisigIsm__factory,
  StaticAggregationIsm__factory,
  StaticMOfNAddressSetFactory,
} from '@hyperlane-xyz/core';
import { logging, types, utils } from '@hyperlane-xyz/utils';

import { HyperlaneApp } from '../HyperlaneApp';
import {
  HyperlaneEnvironment,
  hyperlaneEnvironments,
} from '../consts/environments';
import {
  HyperlaneAddressesMap,
  HyperlaneContracts,
  appFromAddressesMapHelper,
} from '../contracts';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';

import { IsmFactoryFactories, ismFactoryFactories } from './contracts';
import {
  AggregationIsmConfig,
  DeployedIsm,
  IsmConfig,
  ModuleType,
  MultisigIsmConfig,
  RoutingIsmConfig,
} from './types';

export class HyperlaneIsmFactory extends HyperlaneApp<IsmFactoryFactories> {
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
      ismFactoryFactories,
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
    if (
      config.type === ModuleType.MERKLE_ROOT_MULTISIG ||
      config.type === ModuleType.MESSAGE_ID_MULTISIG ||
      config.type === ModuleType.LEGACY_MULTISIG
    ) {
      this.logger(`Deploying Multisig ISM to ${chain} for verifying ${origin}`);
      return this.deployMultisigIsm(chain, config, origin);
    } else if (config.type === ModuleType.ROUTING) {
      this.logger(
        `Deploying Routing ISM to ${chain} for verifying ${Object.keys(
          config.domains,
        )}`,
      );
      return this.deployRoutingIsm(chain, config);
    } else if (config.type === ModuleType.AGGREGATION) {
      this.logger(`Deploying Aggregation ISM to ${chain}`);
      return this.deployAggregationIsm(chain, config);
    } else {
      throw new Error(`Unsupported ISM type`);
    }
  }

  private async deployMultisigIsm(
    chain: ChainName,
    config: MultisigIsmConfig,
    origin?: ChainName,
  ) {
    const signer = this.multiProvider.getSigner(chain);
    let address: string;
    if (config.type === ModuleType.LEGACY_MULTISIG) {
      if (
        process.env.CI !== 'true' &&
        process.env.ALLOW_LEGACY_MULTISIG_ISM !== 'true'
      ) {
        throw new Error(
          'Legacy multisig ISM is being deprecated, do not deploy',
        );
      }

      const multisig = await new LegacyMultisigIsm__factory()
        .connect(signer)
        .deploy();
      await this.multiProvider.handleTx(chain, multisig.deployTransaction);
      const originDomain = this.multiProvider.getDomainId(origin!);
      await this.multiProvider.handleTx(
        chain,
        multisig.enrollValidators([originDomain], [config.validators]),
      );
      await this.multiProvider.handleTx(
        chain,
        multisig.setThreshold(originDomain, config.threshold),
      );
      address = multisig.address;
    } else {
      const multisigIsmFactory =
        config.type === ModuleType.MERKLE_ROOT_MULTISIG
          ? this.getContracts(chain).merkleRootMultisigIsmFactory
          : this.getContracts(chain).messageIdMultisigIsmFactory;
      address = await this.deployMOfNFactory(
        chain,
        multisigIsmFactory,
        config.validators,
        config.threshold,
      );
    }
    return IMultisigIsm__factory.connect(address, signer);
  }

  private async deployRoutingIsm(chain: ChainName, config: RoutingIsmConfig) {
    const signer = this.multiProvider.getSigner(chain);
    const routingIsmFactory = this.getContracts(chain).routingIsmFactory;
    const isms: ChainMap<types.Address> = {};
    for (const origin of Object.keys(config.domains)) {
      const ism = await this.deploy(chain, config.domains[origin], origin);
      isms[origin] = ism.address;
    }
    const domains = Object.keys(isms).map((chain) =>
      this.multiProvider.getDomainId(chain),
    );
    const submoduleAddresses = Object.values(isms);
    const tx = await routingIsmFactory.deploy(domains, submoduleAddresses);
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
    await this.multiProvider.handleTx(
      chain,
      await routingIsm.transferOwnership(config.owner),
    );
    const address = dispatchLogs[0].args['module'];
    return IRoutingIsm__factory.connect(address, signer);
  }

  private async deployAggregationIsm(
    chain: ChainName,
    config: AggregationIsmConfig,
  ) {
    const signer = this.multiProvider.getSigner(chain);
    const aggregationIsmFactory =
      this.getContracts(chain).aggregationIsmFactory;
    const addresses: types.Address[] = [];
    for (const module of config.modules) {
      addresses.push((await this.deploy(chain, module)).address);
    }
    const address = await this.deployMOfNFactory(
      chain,
      aggregationIsmFactory,
      addresses,
      config.threshold,
    );
    return IAggregationIsm__factory.connect(address, signer);
  }

  private async deployMOfNFactory(
    chain: ChainName,
    factory: StaticMOfNAddressSetFactory,
    values: types.Address[],
    threshold: number,
  ): Promise<types.Address> {
    const sorted = [...values].sort();
    const address = await factory.getAddress(sorted, threshold);
    const provider = this.multiProvider.getProvider(chain);
    const code = await provider.getCode(address);
    if (code === '0x') {
      this.logger(
        `Deploying new ${threshold} of ${values.length} address set to ${chain}`,
      );
      await factory.deploy(sorted, threshold);
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
  moduleAddress: types.Address,
  multiProvider: MultiProvider,
  origin: ChainName,
  destination: ChainName,
): Promise<boolean> {
  const message = utils.formatMessage(
    0,
    0,
    multiProvider.getDomainId(origin),
    ethers.constants.AddressZero,
    multiProvider.getDomainId(destination),
    ethers.constants.AddressZero,
    '0x',
  );
  const provider = multiProvider.getSignerOrProvider(destination);
  const module = IInterchainSecurityModule__factory.connect(
    moduleAddress,
    provider,
  );
  try {
    const moduleType = await module.moduleType();
    if (
      moduleType === ModuleType.MERKLE_ROOT_MULTISIG ||
      moduleType === ModuleType.LEGACY_MULTISIG ||
      moduleType === ModuleType.MESSAGE_ID_MULTISIG
    ) {
      const multisigModule = IMultisigIsm__factory.connect(
        moduleAddress,
        provider,
      );

      const [, threshold] = await multisigModule.validatorsAndThreshold(
        message,
      );
      return threshold > 0;
    } else if (moduleType === ModuleType.ROUTING) {
      const routingIsm = IRoutingIsm__factory.connect(moduleAddress, provider);
      const subModule = await routingIsm.route(message);
      return moduleCanCertainlyVerify(
        subModule,
        multiProvider,
        origin,
        destination,
      );
    } else if (moduleType === ModuleType.AGGREGATION) {
      const aggregationIsm = IAggregationIsm__factory.connect(
        moduleAddress,
        provider,
      );
      const [subModules, threshold] = await aggregationIsm.modulesAndThreshold(
        message,
      );
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
    logging.warn(`Error checking module ${moduleAddress}: ${e}`);
    return false;
  }
}

export async function moduleMatchesConfig(
  chain: ChainName,
  moduleAddress: types.Address,
  config: IsmConfig,
  multiProvider: MultiProvider,
  contracts: HyperlaneContracts<IsmFactoryFactories>,
): Promise<boolean> {
  const provider = multiProvider.getProvider(chain);
  const module = IInterchainSecurityModule__factory.connect(
    moduleAddress,
    provider,
  );
  const actualType = await module.moduleType();
  if (actualType !== config.type) return false;
  let matches = true;
  switch (config.type) {
    case ModuleType.MERKLE_ROOT_MULTISIG:
    case ModuleType.MESSAGE_ID_MULTISIG: {
      // A MultisigIsm matches if validators and threshold match the config
      const expectedAddress =
        await contracts.merkleRootMultisigIsmFactory.getAddress(
          config.validators.sort(),
          config.threshold,
        );
      matches = utils.eqAddress(expectedAddress, module.address);
      break;
    }
    case ModuleType.LEGACY_MULTISIG: {
      const multisigIsm = LegacyMultisigIsm__factory.connect(
        moduleAddress,
        provider,
      );
      const domain = multiProvider.getDomainId(chain);
      const validators = await multisigIsm.validators(domain);
      const threshold = await multisigIsm.threshold(domain);
      matches =
        config.validators.sort() == validators.sort() &&
        config.threshold == threshold;
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
      matches = matches && utils.eqAddress(owner, config.owner);
      // Recursively check that the submodule for each configured
      // domain matches the submodule config.
      for (const chain of Object.keys(config.domains)) {
        const subModule = await routingIsm.modules(
          multiProvider.getDomainId(chain),
        );
        const subModuleMatches = await moduleMatchesConfig(
          chain,
          subModule,
          config.domains[chain],
          multiProvider,
          contracts,
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
  let validators: string[] = [];
  if (
    config.type === ModuleType.MERKLE_ROOT_MULTISIG ||
    config.type === ModuleType.MESSAGE_ID_MULTISIG ||
    config.type === ModuleType.LEGACY_MULTISIG
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
  } else {
    throw new Error('Unsupported ModuleType');
  }

  return new Set(validators);
}
