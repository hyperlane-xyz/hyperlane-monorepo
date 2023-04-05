import { ethers } from 'ethers';

import {
  DomainRoutingIsm__factory,
  IInterchainSecurityModule__factory,
  StaticAggregationIsm__factory,
  StaticMOfNAddressSetFactory,
} from '@hyperlane-xyz/core';
import { types } from '@hyperlane-xyz/utils';
import { eqAddress } from '@hyperlane-xyz/utils/dist/src/utils';

import { HyperlaneApp } from '../HyperlaneApp';
import {
  HyperlaneEnvironment,
  hyperlaneEnvironments,
} from '../consts/environments';
import { HyperlaneContracts } from '../contracts';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';

import { IsmFactoryFactories, ismFactoryFactories } from './contracts';
import { DeployedIsm, IsmConfig, ModuleType } from './types';

export class HyperlaneIsmFactory extends HyperlaneApp<IsmFactoryFactories> {
  static fromEnvironment<Env extends HyperlaneEnvironment>(
    env: Env,
    multiProvider: MultiProvider,
  ): HyperlaneIsmFactory {
    const envAddresses = hyperlaneEnvironments[env];
    if (!envAddresses) {
      throw new Error(`No addresses found for ${env}`);
    }
    const fromAddressesMap = HyperlaneApp.fromAddressesMap(
      envAddresses,
      ismFactoryFactories,
      multiProvider,
    );
    return new HyperlaneIsmFactory(
      fromAddressesMap.contractsMap,
      fromAddressesMap.multiProvider,
    );
  }

  async deploy(chain: ChainName, config: IsmConfig): Promise<DeployedIsm> {
    const signer = this.multiProvider.getSigner(chain);
    switch (config.type) {
      case ModuleType.MULTISIG: {
        const multisigIsmFactory = this.getContracts(chain).multisigIsmFactory;
        const address = await this.deployMOfNFactory(
          chain,
          multisigIsmFactory,
          config.validators,
          config.threshold,
        );
        return StaticAggregationIsm__factory.connect(address, signer);
      }
      case ModuleType.ROUTING: {
        const routingIsmFactory = this.getContracts(chain).routingIsmFactory;
        const isms: ChainMap<types.Address> = {};
        for (const origin of Object.keys(config.domains)) {
          const ism = await this.deploy(chain, config.domains[origin]);
          isms[origin] = ism.address;
        }
        const domains = Object.keys(isms).map((chain) =>
          this.multiProvider.getDomainId(chain),
        );
        const modules = Object.values(isms);
        const tx = await routingIsmFactory.deploy(domains, modules);
        const receipt = await this.multiProvider.handleTx(chain, tx);
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
        await routingIsm.transferOwnership(config.owner);
        const address = dispatchLogs[0].args['module'];
        return DomainRoutingIsm__factory.connect(address, signer);
      }
      case ModuleType.AGGREGATION: {
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
        return StaticAggregationIsm__factory.connect(address, signer);
      }
      default: {
        throw new Error('Unknown ModuleType');
      }
    }
  }

  private async deployMOfNFactory(
    chain: ChainName,
    factory: StaticMOfNAddressSetFactory,
    values: types.Address[],
    threshold: number,
  ): Promise<types.Address> {
    const address = await factory.getAddress(values.sort(), threshold);
    const provider = this.multiProvider.getProvider(chain);
    const code = await provider.getCode(address);
    if (code === '0x') {
      await factory.deploy(values.sort(), threshold);
    }
    return address;
  }
}

export async function moduleMatches(
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
    case ModuleType.MULTISIG: {
      // A MultisigIsm matches if validators and threshold match the config
      const expectedAdddress = await contracts.multisigIsmFactory.getAddress(
        config.validators.sort(),
        config.threshold,
      );
      matches = eqAddress(expectedAdddress, module.address);
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
      const owner = await routingIsm.owner();
      matches = matches && eqAddress(owner, config.owner);
      for (const chain of Object.keys(config.domains)) {
        const subModule = await routingIsm.modules(
          multiProvider.getDomainId(chain),
        );
        const subModuleMatches = await moduleMatches(
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
      const [modules, threshold] = await aggregationIsm.modulesAndThreshold(
        '0x',
      );
      matches = matches && threshold === config.threshold;
      matches = matches && modules.length === config.modules.length;
      const matched = config.modules.map(() => false);
      for (const subModule of modules) {
        const matching = await Promise.all(
          config.modules.map((c) =>
            moduleMatches(chain, subModule, c, multiProvider, contracts),
          ),
        );
        const count = matching.filter((x) => x).length;
        matches = matches && count === 1;
        matched[matching.indexOf(true)] = true;
      }
      matches = matches && matched.every(Boolean);
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
  const validators = new Set<string>();

  switch (config.type) {
    case ModuleType.MULTISIG: {
      config.validators.map((v) => validators.add(v));
      break;
    }
    case ModuleType.ROUTING: {
      if (Object.keys(config.domains).includes(origin)) {
        const domainValidators = collectValidators(
          origin,
          config.domains[origin],
        );
        [...domainValidators].map((v) => validators.add(v));
      }
      break;
    }
    case ModuleType.AGGREGATION: {
      const aggregatedValidators = config.modules.map((c) =>
        collectValidators(origin, c),
      );
      aggregatedValidators.map((set) => {
        [...set].map((v) => validators.add(v));
      });
      break;
    }
    default: {
      throw new Error('Unsupported ModuleType');
    }
  }

  return validators;
}
