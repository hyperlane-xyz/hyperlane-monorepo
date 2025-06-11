import { Ownable, Router } from '@hyperlane-xyz/core';
import {
  Address,
  addBufferToGasLimit,
  addressToBytes32,
  concurrentMap,
  objFilter,
  objMap,
  objMerge,
} from '@hyperlane-xyz/utils';

import { filterOwnableContracts } from '../contracts/contracts.js';
import {
  HyperlaneContracts,
  HyperlaneContractsMap,
  HyperlaneFactories,
} from '../contracts/types.js';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer.js';
import { RouterConfig } from '../router/types.js';
import { ChainMap } from '../types.js';

const BATCH_SIZE = 50;
const CONCURRENCY = 50;

export abstract class HyperlaneRouterDeployer<
  Config extends RouterConfig,
  Factories extends HyperlaneFactories,
> extends HyperlaneDeployer<Config, Factories> {
  abstract router(contracts: HyperlaneContracts<Factories>): Router;

  async configureClients(
    contractsMap: HyperlaneContractsMap<Factories>,
    configMap: ChainMap<Config>,
  ): Promise<void> {
    for (const chain of Object.keys(contractsMap)) {
      const contracts = contractsMap[chain];
      const config = configMap[chain];
      await super.configureClient(chain, this.router(contracts), config);
    }
  }

  async enrollRemoteRouters(
    deployedContractsMap: HyperlaneContractsMap<Factories>,
    _: ChainMap<Config>,
    foreignRouters: ChainMap<Address> = {},
  ): Promise<void> {
    this.logger.debug(
      `Enrolling deployed routers with each other (if not already)...`,
    );

    // Make all routers aware of each other.

    // Routers that were deployed.
    const deployedRouters: ChainMap<Address> = objMap(
      deployedContractsMap,
      (_, contracts) => this.router(contracts).address,
    );
    // All routers, including those that were deployed and those with existing deployments.
    const allRouters = objMerge(deployedRouters, foreignRouters);

    const allChains = Object.keys(allRouters);
    const chainEntries = Object.entries(deployedContractsMap);

    // Process chains in batches of 30
    for (let i = 0; i < chainEntries.length; i += BATCH_SIZE) {
      const batch = chainEntries.slice(i, i + BATCH_SIZE);
      const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(chainEntries.length / BATCH_SIZE);

      this.logger.info(
        `Processing batch ${batchNumber}/${totalBatches} (${batch.length} chains)`,
      );

      await Promise.all(
        batch.map(async ([chain, contracts]) => {
          const allRemoteChains = this.multiProvider
            .getRemoteChains(chain)
            .filter((c) => allChains.includes(c));

          const enrollEntries = await concurrentMap(
            CONCURRENCY,
            allRemoteChains,
            async (remote) => {
              const remoteDomain = this.multiProvider.getDomainId(remote);
              const current =
                await this.router(contracts).routers(remoteDomain);
              const expected = addressToBytes32(allRouters[remote]);
              return current !== expected
                ? [remoteDomain, expected]
                : undefined;
            },
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
            const router = this.router(contracts);
            const enrollBatchSize =
              chain === 'unitzero' || chain === 'rootstockmainnet'
                ? Math.ceil(BATCH_SIZE / 4)
                : BATCH_SIZE;
            for (let i = 0; i < domains.length; i += enrollBatchSize) {
              const batchDomains = domains.slice(i, i + enrollBatchSize);
              const batchAddresses = addresses.slice(i, i + enrollBatchSize);

              const chains = batchDomains.map((id) =>
                this.multiProvider.getChainName(id),
              );
              this.logger.info(
                `Enrolling remote routers (${chains.join(', ')}) on ${chain}`,
              );

              const estimatedGas = await router.estimateGas.enrollRemoteRouters(
                batchDomains,
                batchAddresses,
              );
              const enrollTx = await router.enrollRemoteRouters(
                batchDomains,
                batchAddresses,
                {
                  gasLimit: addBufferToGasLimit(estimatedGas),
                  ...this.multiProvider.getTransactionOverrides(chain),
                },
              );
              await this.multiProvider.handleTx(chain, enrollTx);
            }
          });
        }),
      );

      this.logger.info(`Completed batch ${batchNumber}/${totalBatches}`);
    }
  }

  async transferOwnership(
    contractsMap: HyperlaneContractsMap<Factories>,
    configMap: ChainMap<Config>,
  ): Promise<void> {
    this.logger.debug(`Transferring ownership of ownables...`);
    for (const chain of Object.keys(contractsMap)) {
      const contracts = contractsMap[chain];
      const ownables = (await filterOwnableContracts(contracts)) as Partial<
        Record<keyof Factories, Ownable>
      >;
      await this.transferOwnershipOfContracts(
        chain,
        configMap[chain],
        ownables,
      );
    }
  }

  async deploy(
    configMap: ChainMap<Config>,
  ): Promise<HyperlaneContractsMap<Factories>> {
    // Only deploy on chains that don't have foreign deployments.
    const configMapToDeploy = objFilter(
      configMap,
      (_chainName, config): config is Config => !config.foreignDeployment,
    );

    // Create a map of chains that have foreign deployments.
    const foreignDeployments: ChainMap<Address> = objFilter(
      objMap(configMap, (_, config) => config.foreignDeployment),
      (_chainName, foreignDeployment): foreignDeployment is string =>
        foreignDeployment !== undefined,
    );

    const deployedContractsMap = await super.deploy(configMapToDeploy);

    await this.enrollRemoteRouters(
      deployedContractsMap,
      configMap,
      foreignDeployments,
    );
    await this.configureClients(deployedContractsMap, configMap);
    await this.transferOwnership(deployedContractsMap, configMap);
    this.logger.debug(`Finished deploying router contracts for all chains.`);

    return deployedContractsMap;
  }
}
