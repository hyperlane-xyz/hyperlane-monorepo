import { debug } from 'debug';

import { Router } from '@hyperlane-xyz/core';
import { utils } from '@hyperlane-xyz/utils';

import { HyperlaneContracts, HyperlaneFactories } from '../contracts';
import {
  DeployerOptions,
  HyperlaneDeployer,
} from '../deploy/HyperlaneDeployer';
import { MultiProvider } from '../providers/MultiProvider';
import { RouterConfig } from '../router/types';
import { ChainMap } from '../types';
import { objMap, promiseObjAll } from '../utils/objects';

export abstract class HyperlaneRouterDeployer<
  Config extends RouterConfig,
  Contracts extends HyperlaneContracts,
  Factories extends HyperlaneFactories,
> extends HyperlaneDeployer<Config, Contracts, Factories> {
  constructor(
    multiProvider: MultiProvider,
    configMap: ChainMap<Config>,
    factories: Factories,
    options?: DeployerOptions,
  ) {
    super(multiProvider, configMap, factories, {
      logger: debug('hyperlane:RouterDeployer'),
      ...options,
    });
  }

  abstract router(contracts: Contracts): Router;

  async initConnectionClients(
    contractsMap: ChainMap<Contracts>,
  ): Promise<void> {
    await promiseObjAll(
      objMap(contractsMap, async (local, contracts) =>
        super.initConnectionClient(
          local,
          this.router(contracts),
          this.configMap[local],
        ),
      ),
    );
  }

  async enrollRemoteRouters(contractsMap: ChainMap<Contracts>): Promise<void> {
    this.logger(
      `Enrolling deployed routers with each other (if not already)...`,
    );
    // Make all routers aware of each other.
    const deployedChains = Object.keys(contractsMap);
    for (const [chain, contracts] of Object.entries<Contracts>(contractsMap)) {
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

  async transferOwnership(contractsMap: ChainMap<Contracts>): Promise<void> {
    this.logger(`Transferring ownership of routers...`);
    await promiseObjAll(
      objMap(contractsMap, async (chain, contracts) => {
        const owner = this.configMap[chain].owner;
        const currentOwner = await this.router(contracts).owner();
        if (owner != currentOwner) {
          this.logger(`Transfer ownership of ${chain}'s router to ${owner}`);
          await super.runIfOwner(chain, this.router(contracts), async () => {
            await this.multiProvider.handleTx(
              chain,
              this.router(contracts).transferOwnership(
                owner,
                this.multiProvider.getTransactionOverrides(chain),
              ),
            );
          });
        }
      }),
    );
  }

  async deploy(
    partialDeployment?: ChainMap<Contracts>,
  ): Promise<ChainMap<Contracts>> {
    const contractsMap = await super.deploy(partialDeployment);

    await this.enrollRemoteRouters(contractsMap);
    await this.initConnectionClients(contractsMap);
    await this.transferOwnership(contractsMap);

    return contractsMap;
  }
}
