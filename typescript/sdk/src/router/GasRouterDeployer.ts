import { GasRouter } from '@hyperlane-xyz/core';

import {
  HyperlaneContracts,
  HyperlaneContractsMap,
  HyperlaneFactories,
} from '../contracts';
import { ChainMap } from '../types';

import { HyperlaneRouterDeployer } from './HyperlaneRouterDeployer';
import { GasRouterConfig } from './types';

export abstract class GasRouterDeployer<
  Config extends GasRouterConfig,
  Factories extends HyperlaneFactories,
> extends HyperlaneRouterDeployer<Config, Factories> {
  abstract router(contracts: HyperlaneContracts<Factories>): GasRouter;

  async enrollRemoteRouters(
    contractsMap: HyperlaneContractsMap<Factories>,
    configMap: ChainMap<Config>,
  ): Promise<void> {
    await super.enrollRemoteRouters(contractsMap, configMap);

    this.logger(`Setting enrolled router destination gas...`);
    for (const [chain, contracts] of Object.entries(contractsMap)) {
      const remoteDomains = await this.router(contracts).domains();
      const remoteChains = remoteDomains.map((domain) =>
        this.multiProvider.getChainName(domain),
      );
      const currentConfigs = await Promise.all(
        remoteDomains.map((domain) =>
          this.router(contracts).destinationGas(domain),
        ),
      );
      const remoteConfigs = remoteDomains
        .map((domain, i) => ({
          domain,
          gas: configMap[remoteChains[i]].gas,
        }))
        .filter(({ gas }, index) => !currentConfigs[index].eq(gas));
      if (remoteConfigs.length == 0) {
        continue;
      }

      this.logger(`Set destination gas on ${chain} for ${remoteChains}`);
      await this.multiProvider.handleTx(
        chain,
        this.router(contracts).setDestinationGas(remoteConfigs),
      );
    }
  }
}
