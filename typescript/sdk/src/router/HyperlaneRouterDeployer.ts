import { Router } from '@hyperlane-xyz/core';
import { utils } from '@hyperlane-xyz/utils';

import {
  HyperlaneContracts,
  HyperlaneContractsMap,
  HyperlaneFactories,
  ownableContracts,
} from '../contracts';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer';
import { RouterConfig } from '../router/types';
import { ChainMap } from '../types';
import { objMap, promiseObjAll } from '../utils/objects';

export abstract class HyperlaneRouterDeployer<
  Config extends RouterConfig,
  Factories extends HyperlaneFactories,
> extends HyperlaneDeployer<Config, Factories> {
  abstract router(contracts: HyperlaneContracts<Factories>): Router;

  async initConnectionClients(
    contractsMap: HyperlaneContractsMap<Factories>,
    configMap: ChainMap<Config>,
  ): Promise<void> {
    await promiseObjAll(
      objMap(contractsMap, async (local, contracts) =>
        super.initConnectionClient(
          local,
          this.router(contracts),
          configMap[local],
        ),
      ),
    );
  }

  async enrollRemoteRouters(
    contractsMap: HyperlaneContractsMap<Factories>,
    _: ChainMap<Config>,
  ): Promise<void> {
    this.logger(
      `Enrolling deployed routers with each other (if not already)...`,
    );

    // Make all routers aware of each other.
    const deployedChains = Object.keys(contractsMap);
    for (const [chain, contracts] of Object.entries(contractsMap)) {
      // only enroll chains which are deployed
      const deployedRemoteChains = this.multiProvider
        .getRemoteChains(chain)
        .filter((c) => deployedChains.includes(c));

      const enrollEntries = await Promise.all(
        deployedRemoteChains.map(async (remote) => {
          const remoteDomain = this.multiProvider.getDomainId(remote);
          const current = await this.router(contracts).routers(remoteDomain);
          const expected = utils.addressToBytes32(
            this.router(contractsMap[remote]).address,
          );
          return current !== expected ? [remoteDomain, expected] : undefined;
        }),
      );
      const entries = enrollEntries.filter(
        (entry): entry is [number, string] => entry !== undefined,
      );
      const domains = entries.map(([id]) => id);
      const addresses = entries.map(([, address]) => address);

      // skip if no enrollments are needed
      if (domains.length === 0) {
        return;
      }

      await super.runIfOwner(chain, this.router(contracts), async () => {
        const chains = domains.map((id) => this.multiProvider.getChainName(id));
        this.logger(
          `Enrolling remote routers (${chains.join(', ')}) on ${chain}`,
        );
        await this.multiProvider.handleTx(
          chain,
          this.router(contracts).enrollRemoteRouters(
            domains,
            addresses,
            this.multiProvider.getTransactionOverrides(chain),
          ),
        );
      });
    }
  }

  async transferOwnership(
    contractsMap: HyperlaneContractsMap<Factories>,
    configMap: ChainMap<Config>,
  ): Promise<void> {
    this.logger(`Transferring ownership of ownables...`);
    await promiseObjAll(
      objMap(contractsMap, async (chain, contracts) => {
        const owner = configMap[chain].owner;
        const ownables = await ownableContracts(contracts);
        await this.transferOwnershipOfContracts(chain, owner, ownables);
      }),
    );
  }

  async deploy(
    configMap: ChainMap<Config>,
  ): Promise<HyperlaneContractsMap<Factories>> {
    const contractsMap = await super.deploy(configMap);

    await this.enrollRemoteRouters(contractsMap, configMap);
    await this.initConnectionClients(contractsMap, configMap);
    // await this.transferOwnership(contractsMap, configMap);

    return contractsMap;
  }
}
