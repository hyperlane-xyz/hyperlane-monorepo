import { debug } from 'debug';

import { GasRouter } from '@hyperlane-xyz/core';

import { DeployerOptions } from '../deploy/HyperlaneDeployer';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap } from '../types';

import { HyperlaneRouterDeployer } from './HyperlaneRouterDeployer';
import { GasRouterConfig, RouterContracts, RouterFactories } from './types';

export abstract class GasRouterDeployer<
  Config extends GasRouterConfig,
  Contracts extends RouterContracts<GasRouter>,
  Factories extends RouterFactories<GasRouter>,
> extends HyperlaneRouterDeployer<Config, Contracts, Factories> {
  constructor(
    multiProvider: MultiProvider,
    configMap: ChainMap<Config>,
    factories: Factories,
    options?: DeployerOptions,
  ) {
    super(multiProvider, configMap, factories, {
      logger: debug('hyperlane:GasRouterDeployer'),
      ...options,
    });
  }

  async enrollRemoteRouters(contractsMap: ChainMap<Contracts>): Promise<void> {
    await super.enrollRemoteRouters(contractsMap);

    this.logger(`Setting enrolled router destination gas...`);
    for (const [chain, contracts] of Object.entries<Contracts>(contractsMap)) {
      const remoteDomains = await contracts.router.domains();
      const remoteChains = remoteDomains.map((domain) =>
        this.multiProvider.getChainName(domain),
      );
      const currentConfigs = await Promise.all(
        remoteDomains.map((domain) => contracts.router.destinationGas(domain)),
      );
      const remoteConfigs = remoteDomains
        .map((domain, i) => ({
          domain,
          gas: this.configMap[remoteChains[i]].gas,
        }))
        .filter(({ gas }, index) => !currentConfigs[index].eq(gas));
      if (remoteConfigs.length == 0) {
        continue;
      }

      this.logger(`Set destination gas on ${chain} for ${remoteChains}`);
      await this.multiProvider.handleTx(
        chain,
        contracts.router.setDestinationGas(remoteConfigs),
      );
    }
  }
}
