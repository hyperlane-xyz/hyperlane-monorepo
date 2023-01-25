import { debug } from 'debug';

import { GasRouter } from '@hyperlane-xyz/core';

import { DomainIdToChainName } from '../../domains';
import { MultiProvider } from '../../providers/MultiProvider';
import { RouterContracts, RouterFactories } from '../../router';
import { ChainMap, ChainName } from '../../types';
import { DeployerOptions } from '../HyperlaneDeployer';

import { HyperlaneRouterDeployer } from './HyperlaneRouterDeployer';
import { GasRouterConfig } from './types';

export abstract class GasRouterDeployer<
  Chain extends ChainName,
  Config extends GasRouterConfig,
  Contracts extends RouterContracts<GasRouter>,
  Factories extends RouterFactories<GasRouter>,
> extends HyperlaneRouterDeployer<Chain, Config, Contracts, Factories> {
  constructor(
    multiProvider: MultiProvider<Chain>,
    configMap: ChainMap<Chain, Config>,
    factories: Factories,
    options?: DeployerOptions,
  ) {
    super(multiProvider, configMap, factories, {
      logger: debug('hyperlane:GasRouterDeployer'),
      ...options,
    });
  }

  async enrollRemoteRouters(
    contractsMap: ChainMap<Chain, Contracts>,
  ): Promise<void> {
    super.enrollRemoteRouters(contractsMap);
    this.logger(`Setting enrolled router handle gas overhead...`);
    for (const [chain, contracts] of Object.entries<Contracts>(contractsMap)) {
      const local = chain as Chain;

      const remoteDomains = await contracts.router.domains();
      const remoteChains = remoteDomains.map(
        (domain) => DomainIdToChainName[domain] as Chain,
      );
      const remoteConfigs = remoteDomains.map((domain, i) => ({
        domain,
        handleGasOverhead: this.configMap[remoteChains[i]].handleGasOverhead,
      }));
      this.logger(
        `Enroll remote (${remoteChains}) handle gas overhead on ${local}`,
      );
      const chainConnection = this.multiProvider.getChainConnection(local);
      await chainConnection.handleTx(
        contracts.router.setGasOverheadConfigs(remoteConfigs),
      );
    }
  }
}
