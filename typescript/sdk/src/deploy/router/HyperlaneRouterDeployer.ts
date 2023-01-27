import { debug } from 'debug';
import { ethers } from 'ethers';

import { utils } from '@hyperlane-xyz/utils';

import { DomainIdToChainName } from '../../domains';
import { MultiProvider } from '../../providers/MultiProvider';
import { RouterContracts, RouterFactories } from '../../router';
import { ChainMap, ChainName } from '../../types';
import { objMap, promiseObjAll } from '../../utils/objects';
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

  async initConnectionClient(
    contractsMap: ChainMap<Chain, Contracts>,
  ): Promise<void> {
    this.logger(`Initializing connection clients (if not already)...`);
    await promiseObjAll(
      objMap(contractsMap, async (local, contracts) => {
        const chainConnection = this.multiProvider.getChainConnection(local);
        // set mailbox if not already set (and configured)
        const mailbox = this.configMap[local].mailbox;
        if (
          mailbox &&
          (await contracts.router.mailbox()) === ethers.constants.AddressZero
        ) {
          this.logger(`Set mailbox on ${local}`);
          await chainConnection.handleTx(contracts.router.setMailbox(mailbox));
        }

        // set interchain gas paymaster if not already set (and configured)
        const interchainGasPaymaster =
          this.configMap[local].interchainGasPaymaster;
        if (
          interchainGasPaymaster &&
          (await contracts.router.interchainGasPaymaster()) ===
            ethers.constants.AddressZero
        ) {
          this.logger(`Set interchain gas paymaster on ${local}`);
          await chainConnection.handleTx(
            contracts.router.setInterchainGasPaymaster(interchainGasPaymaster),
          );
        }
      }),
    );
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
          const remoteDomain = this.multiProvider.getChainId(remote);
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

      await super.runIfOwner(local, contracts.router, async () => {
        const chains = domains.map((id) => DomainIdToChainName[id] || id);
        this.logger(
          `Enrolling remote routers (${chains.join(', ')}) on ${local}`,
        );
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

  async transferOwnership(
    contractsMap: ChainMap<Chain, Contracts>,
  ): Promise<void> {
    this.logger(`Transferring ownership of routers...`);
    await promiseObjAll(
      objMap(contractsMap, async (chain, contracts) => {
        const chainConnection = this.multiProvider.getChainConnection(chain);
        const owner = this.configMap[chain].owner;
        const currentOwner = await contracts.router.owner();
        if (owner != currentOwner) {
          this.logger(`Transfer ownership of ${chain}'s router to ${owner}`);
          await super.runIfOwner(chain, contracts.router, async () => {
            await chainConnection.handleTx(
              contracts.router.transferOwnership(
                owner,
                chainConnection.overrides,
              ),
            );
          });
        }
      }),
    );
  }

  async deploy(
    partialDeployment?: Partial<Record<Chain, Contracts>>,
  ): Promise<ChainMap<Chain, Contracts>> {
    const contractsMap = await super.deploy(partialDeployment);

    await this.enrollRemoteRouters(contractsMap);
    await this.initConnectionClient(contractsMap);
    await this.transferOwnership(contractsMap);

    return contractsMap;
  }
}
