import { debug } from 'debug';

import { utils } from '@hyperlane-xyz/utils';

import { DeployerOptions, HyperlaneDeployer } from '../deploy';
import { MultiProvider } from '../providers';
import { RouterConfig, RouterContracts, RouterFactories } from '../router';
import { ChainMap } from '../types';
import { objMap, promiseObjAll } from '../utils';

export abstract class HyperlaneRouterDeployer<
  Config extends RouterConfig,
  Contracts extends RouterContracts,
  Factories extends RouterFactories,
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

  async initConnectionClient(contractsMap: ChainMap<Contracts>): Promise<void> {
    this.logger(`Initializing connection clients (if not already)...`);
    await promiseObjAll(
      objMap(contractsMap, async (local, contracts) => {
        // set mailbox if not already set (and configured)
        const mailbox = this.configMap[local].mailbox;
        if (mailbox !== (await contracts.router.mailbox())) {
          this.logger(`Set mailbox on ${local}`);
          await this.multiProvider.handleTx(
            local,
            contracts.router.setMailbox(mailbox),
          );
        }

        // set interchain gas paymaster if not already set (and configured)
        const igp = this.configMap[local].interchainGasPaymaster;
        if (igp !== (await contracts.router.interchainGasPaymaster())) {
          this.logger(`Set interchain gas paymaster on ${local}`);
          await this.multiProvider.handleTx(
            local,
            contracts.router.setInterchainGasPaymaster(igp),
          );
        }

        const ism = this.configMap[local].interchainSecurityModule;
        if (
          ism &&
          ism !== (await contracts.router.interchainSecurityModule())
        ) {
          this.logger(`Set interchain security module on ${local}`);
          await this.multiProvider.handleTx(
            local,
            contracts.router.setInterchainSecurityModule(ism),
          );
        }
      }),
    );
  }

  async enrollRemoteRouters(
    contractsMap: ChainMap<RouterContracts>,
  ): Promise<void> {
    this.logger(
      `Enrolling deployed routers with each other (if not already)...`,
    );
    // Make all routers aware of each other.
    const deployedChains = Object.keys(contractsMap);
    for (const [chain, contracts] of Object.entries<RouterContracts>(
      contractsMap,
    )) {
      // only enroll chains which are deployed
      const deployedRemoteChains = this.multiProvider
        .getRemoteChains(chain)
        .filter((c) => deployedChains.includes(c));

      const enrollEntries = await Promise.all(
        deployedRemoteChains.map(async (remote) => {
          const remoteDomain = this.multiProvider.getDomainId(remote);
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

      // skip if no enrollments are needed
      if (domains.length === 0) {
        return;
      }

      await super.runIfOwner(chain, contracts.router, async () => {
        const chains = domains.map((id) => this.multiProvider.getChainName(id));
        this.logger(
          `Enrolling remote routers (${chains.join(', ')}) on ${chain}`,
        );
        await this.multiProvider.handleTx(
          chain,
          contracts.router.enrollRemoteRouters(
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
        const currentOwner = await contracts.router.owner();
        if (owner != currentOwner) {
          this.logger(`Transfer ownership of ${chain}'s router to ${owner}`);
          await super.runIfOwner(chain, contracts.router, async () => {
            await this.multiProvider.handleTx(
              chain,
              contracts.router.transferOwnership(
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
    await this.initConnectionClient(contractsMap);
    await this.transferOwnership(contractsMap);

    return contractsMap;
  }
}
