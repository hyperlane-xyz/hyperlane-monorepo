import { debug } from 'debug';

import { HyperlaneFactories } from '../contracts';
import { DeployerOptions } from '../deploy/HyperlaneDeployer';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap } from '../types';

import { HyperlaneRouterDeployer } from './HyperlaneRouterDeployer';
import { GasRouterContracts } from './RouterApps';
import { GasRouterConfig } from './types';

export abstract class GasRouterDeployer<
  Config extends GasRouterConfig,
  Contracts extends GasRouterContracts,
> extends HyperlaneRouterDeployer<Config, Contracts, HyperlaneFactories> {
  constructor(
    multiProvider: MultiProvider,
    configMap: ChainMap<Config>,
    factories: HyperlaneFactories,
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
