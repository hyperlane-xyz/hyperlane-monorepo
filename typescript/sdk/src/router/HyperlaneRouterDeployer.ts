import {
  IInterchainGasPaymaster__factory,
  Mailbox__factory,
  Router,
} from '@hyperlane-xyz/core';
import { utils } from '@hyperlane-xyz/utils';

import {
  HyperlaneContracts,
  HyperlaneContractsMap,
  HyperlaneFactories,
  filterOwnableContracts,
} from '../contracts';
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
    const chains = Object.keys(configMap);
    for (const [chain, config] of Object.entries(configMap)) {
      const signerOrProvider = this.multiProvider.getSignerOrProvider(chain);
      const igp = IInterchainGasPaymaster__factory.connect(
        config.interchainGasPaymaster,
        signerOrProvider,
      );
      const mailbox = Mailbox__factory.connect(
        config.mailbox,
        signerOrProvider,
      );
      const ism =
        config.interchainSecurityModule ?? (await mailbox.defaultIsm());
      const remotes = chains.filter((c) => c !== chain);
      for (const remote of remotes) {
        // Try to confirm that the IGP supports delivery to all remotes
        try {
          await igp.quoteGasPayment(this.multiProvider.getDomainId(remote), 1);
        } catch (e) {
          throw new Error(
            `The specified or default IGP with address ${igp.address} on ` +
              `${chain} is not configured to deliver messages to ${remote}, ` +
              `did you mean to specify a different one?`,
          );
        }

        // Try to confirm that the specified or default ISM can verify messages to all remotes
        const canVerify = await moduleCanCertainlyVerify(
          ism,
          this.multiProvider,
          chain,
          remote,
        );
        if (!canVerify) {
          throw new Error(
            `The specified or default ISM with address ${ism} on ${chain} ` +
              `cannot verify messages from ${remote}, did you forget to ` +
              `specify an ISM, or mean to specify a different one?`,
          );
        }
      }
    }
  }

  async initConnectionClients(
    contractsMap: HyperlaneContractsMap<Factories>,
    configMap: ChainMap<Config>,
  ): Promise<void> {
    for (const chain of Object.keys(contractsMap)) {
      const contracts = contractsMap[chain];
      const config = configMap[chain];
      await super.initConnectionClient(chain, this.router(contracts), config);
    }
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
    const contractsMap = await super.deploy(configMap);

    await this.enrollRemoteRouters(contractsMap, configMap);
    await this.initConnectionClients(contractsMap, configMap);
    await this.transferOwnership(contractsMap, configMap);

    return contractsMap;
  }
}
