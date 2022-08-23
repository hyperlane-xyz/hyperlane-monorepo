import { debug } from 'debug';
import { ethers } from 'ethers';

import { utils } from '@abacus-network/utils';

import { chainMetadata } from '../../consts/chainMetadata';
import { MultiProvider } from '../../providers/MultiProvider';
import { RouterContracts, RouterFactories } from '../../router';
import { ChainMap, ChainName } from '../../types';
import { objMap, promiseObjAll } from '../../utils/objects';
import { AbacusDeployer, DeployerOptions } from '../AbacusDeployer';

import { RouterConfig } from './types';

export abstract class AbacusRouterDeployer<
  Chain extends ChainName,
  Config extends RouterConfig,
  Contracts extends RouterContracts,
  Factories extends RouterFactories,
> extends AbacusDeployer<Chain, Config, Contracts, Factories> {
  constructor(
    multiProvider: MultiProvider<Chain>,
    configMap: ChainMap<Chain, Config>,
    factories: Factories,
    options?: DeployerOptions,
  ) {
    super(multiProvider, configMap, factories, {
      logger: debug('abacus:RouterDeployer'),
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
        // set abacus connection manager if not already set
        if (
          (await contracts.router.abacusConnectionManager()) ===
          ethers.constants.AddressZero
        ) {
          this.logger(`Set abacus connection manager on ${local}`);
          await chainConnection.handleTx(
            contracts.router.setAbacusConnectionManager(
              this.configMap[local].abacusConnectionManager,
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
          this.logger(`Enroll ${remote}'s router on ${local}`);
          await chainConnection.handleTx(
            contracts.router.enrollRemoteRouter(
              chainMetadata[remote].id,
              utils.addressToBytes32(contractsMap[remote].router.address),
              chainConnection.overrides,
            ),
          );
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
        await chainConnection.handleTx(
          contracts.router.transferOwnership(owner, chainConnection.overrides),
        );
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
