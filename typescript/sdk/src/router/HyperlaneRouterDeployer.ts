import {
  IPostDispatchHook__factory,
  Mailbox__factory,
  Router,
} from '@hyperlane-xyz/core';
import {
  Address,
  addressToBytes32,
  formatMessage,
  objFilter,
  objMap,
  objMerge,
} from '@hyperlane-xyz/utils';

import { filterOwnableContracts } from '../contracts/contracts';
import {
  HyperlaneContracts,
  HyperlaneContractsMap,
  HyperlaneFactories,
} from '../contracts/types';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer';
import { moduleCanCertainlyVerify } from '../ism/HyperlaneIsmFactory';
import { RouterConfig } from '../router/types';
import { ChainMap } from '../types';

export abstract class HyperlaneRouterDeployer<
  Config extends RouterConfig,
  Factories extends HyperlaneFactories,
> extends HyperlaneDeployer<Config, Factories> {
  abstract router(contracts: HyperlaneContracts<Factories>): Router;

  // The ISM check does not appropriately handle ISMs that have sender,
  // recipient, or body-specific logic. Folks that wish to deploy using
  // such ISMs *may* need to override checkConfig to disable this check.
  async checkConfig(configMap: ChainMap<Config>): Promise<void> {
    for (const [local, config] of Object.entries(configMap)) {
      this.logger(`Checking config for ${local}...`);
      const signerOrProvider = this.multiProvider.getSignerOrProvider(local);
      const localMailbox = Mailbox__factory.connect(
        config.mailbox,
        signerOrProvider,
      );

      const localHook = IPostDispatchHook__factory.connect(
        config.hook ?? (await localMailbox.defaultHook()),
        signerOrProvider,
      );

      const deployer = await this.multiProvider.getSignerAddress(local);

      const remotes = Object.keys(configMap).filter((c) => c !== local);
      for (const remote of remotes) {
        const origin = this.multiProvider.getDomainId(local);
        const destination = this.multiProvider.getDomainId(remote);
        const message = formatMessage(
          0,
          0,
          origin,
          deployer,
          destination,
          deployer,
          '',
        );

        // Try to confirm that the hook supports delivery to all remotes
        this.logger(`Checking ${local} => ${remote} hook...`);
        try {
          await localHook.quoteDispatch('', message);
        } catch (e) {
          throw new Error(
            `The specified or default hook with address ${localHook.address} on ` +
              `${local} is not configured to deliver messages to ${remote}, ` +
              `did you mean to specify a different one?`,
          );
        }

        const localIsm =
          config.interchainSecurityModule ?? (await localMailbox.defaultIsm());

        // Try to confirm that the specified or default ISM can verify messages to all remotes
        const canVerify = await moduleCanCertainlyVerify(
          localIsm,
          this.multiProvider,
          remote,
          local,
        );
        if (!canVerify) {
          const ismString = JSON.stringify(localIsm);
          throw new Error(
            `The specified or default ISM ${ismString} on ${local} ` +
              `cannot verify messages from ${remote}, did you forget to ` +
              `specify an ISM, or mean to specify a different one?`,
          );
        }
      }
    }
  }

  async initMailboxClients(
    contractsMap: HyperlaneContractsMap<Factories>,
    configMap: ChainMap<Config>,
  ): Promise<void> {
    for (const chain of Object.keys(contractsMap)) {
      const contracts = contractsMap[chain];
      const config = configMap[chain];
      await super.initMailboxClient(chain, this.router(contracts), config);
    }
  }

  async enrollRemoteRouters(
    deployedContractsMap: HyperlaneContractsMap<Factories>,
    _: ChainMap<Config>,
    foreignRouters: ChainMap<Address> = {},
  ): Promise<void> {
    this.logger(
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
    for (const chain of Object.keys(contractsMap)) {
      const contracts = contractsMap[chain];
      const owner = configMap[chain].owner;
      const ownables = await filterOwnableContracts(contracts);
      await this.transferOwnershipOfContracts(chain, owner, ownables);
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
    await this.initMailboxClients(deployedContractsMap, configMap);
    await this.transferOwnership(deployedContractsMap, configMap);
    this.logger(`Finished deploying router contracts for all chains.`);

    return deployedContractsMap;
  }
}
