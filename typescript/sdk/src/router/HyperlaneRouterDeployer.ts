import { Ownable, Router } from '@hyperlane-xyz/core';
import {
  Address,
  addressToBytes32,
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
    this.logger.info(
      `Enrolling deployed routers with each other (if not already)...`,
    );

    // Routers that were deployed.
    const deployedRouters: ChainMap<Address> = objMap(
      deployedContractsMap,
      (_, contracts) => this.router(contracts).address,
    );
    // All routers, including those that were deployed and those with existing deployments.
    const allRouters = objMerge(deployedRouters, foreignRouters);

    const allChains = Object.keys(allRouters);
    for (const [chain, contracts] of Object.entries(deployedContractsMap)) {
      const allRemoteChains = this.multiProvider
        .getRemoteChains(chain)
        .filter((c) => allChains.includes(c));
      const enrollEntries = await Promise.all(
        allRemoteChains.map(async (remote) => {
          const remoteDomain = this.multiProvider.getDomainId(remote);
          const current = await this.router(contracts).routers(remoteDomain);
          const expected = addressToBytes32(allRouters[remote]);
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
        continue;
      }

      await super.runIfOwner(chain, this.router(contracts), async () => {
        const chains = domains.map((id) => this.multiProvider.getChainName(id));
        this.logger.info(
          `Enrolling remote routers (${chains.join(', ')}) on ${chain}`,
        );
        const router = this.router(contracts);

        // deploy with 10% buffer on gas limit
        const enrollTx = await router.enrollRemoteRouters(domains, addresses, {
          gasLimit: 150_000_000,
          ...this.multiProvider.getTransactionOverrides(chain),
        });

        // const prov = new Provider('http://127.0.0.1:8011', 260);

        // const signer = new Wallet(
        //   '0x3d3cbc973389cb26f657686445bcc75662b415b656078503592ac8c1abb8810e',
        //   prov,
        // );

        // const nonce = await signer.getTransactionCount();
        // console.log({ nonce });
        // const rec = await signer.sendTransaction({
        //   to: enrollTx.to,
        //   from: enrollTx.from,

        //   gasLimit: enrollTx.gasLimit,

        //   data: enrollTx.data,
        //   value: enrollTx.value,
        // });
        // const tx = await rec.wait();
        // console.log({ tx });

        await this.multiProvider.handleTx(260, { ...enrollTx });
      });
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
    console.log('af deployedContractsMap');

    await this.enrollRemoteRouters(
      deployedContractsMap,
      configMap,
      foreignDeployments,
    );
    console.log('af enrollRemoteRouters');

    await this.configureClients(deployedContractsMap, configMap);
    await this.transferOwnership(deployedContractsMap, configMap);
    this.logger.debug(`Finished deploying router contracts for all chains.`);

    return deployedContractsMap;
  }
}
