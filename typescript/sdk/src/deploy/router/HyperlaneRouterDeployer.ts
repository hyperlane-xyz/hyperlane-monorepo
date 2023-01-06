import { debug } from 'debug';

import { utils } from '@hyperlane-xyz/utils';

import { chainMetadata } from '../../consts/chainMetadata';
import { DomainIdToChainName } from '../../domains';
import { MultiProvider } from '../../providers/MultiProvider';
import { RouterContracts, RouterFactories } from '../../router';
import { ChainMap, ChainName } from '../../types';
import { DeployerOptions, HyperlaneDeployer } from '../HyperlaneDeployer';

import { RouterConfig } from './types';

export abstract class HyperlaneRouterDeployer<
  Chain extends ChainName,
  Config extends RouterConfig,
  Contracts extends RouterContracts,
  Factories extends RouterFactories,
> extends HyperlaneDeployer<Chain, Config, Contracts, Factories> {
  constructor(
    multiProvider: MultiProvider<Chain>,
    configMap: ChainMap<Chain, Config>,
    factories: Factories,
    options?: DeployerOptions,
  ) {
    super(multiProvider, configMap, factories, {
      logger: debug('hyperlane:RouterDeployer'),
      ...options,
    });
  }

  async enrollRemoteRouters(
    contractsMap: ChainMap<Chain, RouterContracts>,
  ): Promise<void> {
    this.logger(
      `Enrolling deployed routers with each other (if not already)...`,
    );
    // Make all routers aware of each other.
    const deployedChains = Object.keys(contractsMap);
    for (const [chain, contracts] of Object.entries<RouterContracts>(
      contractsMap,
    )) {
      const local = chain as Chain;
      const chainConnection = this.multiProvider.getChainConnection(local);
      // only enroll chains which are deployed
      const deployedRemoteChains = this.multiProvider
        .remoteChains(local)
        .filter((c) => deployedChains.includes(c));

      const enrollEntries = await Promise.all(
        deployedRemoteChains.map(async (remote) => {
          const remoteDomain = chainMetadata[remote].id;
          const current = await contracts.router.routers(remoteDomain);
          const expected = utils.addressToBytes32(
            contractsMap[remote].router.address,
          );
          return current !== expected ? [remoteDomain, expected] : undefined;
        }),
      );
      const entries = enrollEntries.filter(
        (entry): entry is [number, string] => entry !== undefined,
      );
      const domains = entries.map(([id]) => id);
      const addresses = entries.map(([, address]) => address);

      await super.runIfOwner(local, contracts.router, async () => {
        const chains = domains.map((id) => DomainIdToChainName[id]);
        this.logger(`Enroll remote (${chains}) routers on ${local}`);
        await chainConnection.handleTx(
          contracts.router.enrollRemoteRouters(
            domains,
            addresses,
            chainConnection.overrides,
          ),
        );
      });
    }
  }

  async deploy(
    partialDeployment?: Partial<Record<Chain, Contracts>>,
  ): Promise<ChainMap<Chain, Contracts>> {
    const contractsMap = await super.deploy(partialDeployment);

    await this.enrollRemoteRouters(contractsMap);

    return contractsMap;
  }
}
