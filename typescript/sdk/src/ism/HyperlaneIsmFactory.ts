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
    if (typeof config === 'string') {
      // TODO: return the appropriate ISM type
      return IInterchainSecurityModule__factory.connect(
        config,
        this.multiProvider.getSignerOrProvider(chain),
      );
    }

    if (
      config.type === ModuleType.MERKLE_ROOT_MULTISIG ||
      config.type === ModuleType.MESSAGE_ID_MULTISIG ||
      config.type === ModuleType.LEGACY_MULTISIG
    ) {
      switch (config.type) {
        case ModuleType.LEGACY_MULTISIG:
          this.logger(
            `Deploying Legacy Multisig ISM to ${chain} for verifying ${origin}`,
          );
          break;
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
      const multisig = await new LegacyMultisigIsm__factory()
        .connect(signer)
        .deploy();
      await this.multiProvider.handleTx(chain, multisig.deployTransaction);
      const originDomain = this.multiProvider.getDomainId(origin!);
      this.logger(`Enrolling validators for ${originDomain}`);
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
    const isms: ChainMap<Address> = {};
    for (const origin of Object.keys(config.domains)) {
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
  ) {
    const signer = this.multiProvider.getSigner(chain);
    const aggregationIsmFactory =
      this.getContracts(chain).aggregationIsmFactory;
    const addresses: Address[] = [];
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
    values: Address[],
    threshold: number,
  ): Promise<Address> {
    const sorted = [...values].sort();
    const address = await factory.getAddress(sorted, threshold);
    const provider = this.multiProvider.getProvider(chain);
    const code = await provider.getCode(address);

    if (code === '0x') {
      this.logger(
        `Deploying new ${threshold} of ${values.length} address set to ${chain}`,
      );
      const overrides = this.multiProvider.getTransactionOverrides(chain);
      const hash = await factory.deploy(sorted, threshold, overrides);
      await this.multiProvider.handleTx(chain, hash);
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
        moduleType === ModuleType.LEGACY_MULTISIG ||
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
      case ModuleType.LEGACY_MULTISIG:
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
    }
  }
}

export async function moduleMatchesConfig(
  chain: ChainName,
  moduleAddress: Address,
  config: IsmConfig,
  multiProvider: MultiProvider,
  contracts: HyperlaneContracts<IsmFactoryFactories>,
  origin?: ChainName,
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
    case ModuleType.LEGACY_MULTISIG: {
      const multisigIsm = LegacyMultisigIsm__factory.connect(
        moduleAddress,
        provider,
      );
      if (!origin) {
        throw new Error("Can't check legacy multisig without origin");
      }
      const originDomain = multiProvider.getDomainId(origin);
      const validators = await multisigIsm.validators(originDomain);
      const threshold = await multisigIsm.threshold(originDomain);
      matches =
        JSON.stringify(config.validators.map((s) => s.toLowerCase()).sort()) ===
          JSON.stringify(validators.map((s) => s.toLowerCase()).sort()) &&
        config.threshold === threshold;
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
        const subModule = await routingIsm.modules(
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
