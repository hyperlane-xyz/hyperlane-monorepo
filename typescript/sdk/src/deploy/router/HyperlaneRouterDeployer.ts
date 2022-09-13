import { debug } from 'debug';
import { ethers } from 'ethers';

import { utils } from '@hyperlane-xyz/utils';

import { chainMetadata } from '../../consts/chainMetadata';
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
        // set hyperlane connection manager if not already set
        if (
          // TODO rename ACM methods in router contract
          (await contracts.router.abacusConnectionManager()) ===
          ethers.constants.AddressZero
        ) {
          this.logger(`Set abacus connection manager on ${local}`);
          await chainConnection.handleTx(
            contracts.router.setAbacusConnectionManager(
              this.configMap[local].connectionManager,
            ),
          );
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
    contractsMap: ChainMap<Chain, Contracts>,
  ): Promise<void> {
    this.logger(`Enrolling deployed routers with each other...`);
    // Make all routers aware of each other.
    await promiseObjAll(
      objMap(contractsMap, async (local, contracts) => {
        const chainConnection = this.multiProvider.getChainConnection(local);
        for (const remote of this.multiProvider.remoteChains(local)) {
          const remoteRouterAddress = utils.addressToBytes32(
            contractsMap[remote].router.address,
          );
          const remoteDomainId = chainMetadata[remote].id;

          const enrolledRouterForRemoteDomain = await contracts.router.routers(
            remoteDomainId,
          );

          if (enrolledRouterForRemoteDomain !== remoteRouterAddress) {
            await super.runIfOwner(local, contracts.router, async () => {
              this.logger(`Enroll router for remote ${remote} on ${local}`);
              await chainConnection.handleTx(
                contracts.router.enrollRemoteRouter(
                  remoteDomainId,
                  remoteRouterAddress,
                  chainConnection.overrides,
                ),
              );
            });
          }
        }
      }),
    );
  }

  async transferOwnership(
    contractsMap: ChainMap<Chain, Contracts>,
  ): Promise<void> {
    this.logger(`Transferring ownership of routers...`);
    await promiseObjAll(
      objMap(contractsMap, async (chain, contracts) => {
        const chainConnection = this.multiProvider.getChainConnection(chain);
        const owner = this.configMap[chain].owner;
        this.logger(`Transfer ownership of ${chain}'s router to ${owner}`);
        const currentOwner = await contracts.router.owner();
        if (owner != currentOwner) {
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
