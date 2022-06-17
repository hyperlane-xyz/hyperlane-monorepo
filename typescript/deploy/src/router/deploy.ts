import { debug } from 'debug';

import {
  ChainMap,
  ChainName,
  MultiProvider,
  Router,
  RouterContracts,
  RouterFactories,
  chainMetadata,
  objMap,
  promiseObjAll,
} from '@abacus-network/sdk';
import { utils } from '@abacus-network/utils';

import { AbacusDeployer, DeployerOptions } from '../deploy';

import { RouterConfig } from './types';

export abstract class AbacusRouterDeployer<
  Chain extends ChainName,
  Contracts extends RouterContracts,
  Factories extends RouterFactories,
  Config extends RouterConfig,
> extends AbacusDeployer<Chain, Config, Factories, Contracts> {
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

  // for use in implementations of deployContracts
  async deployRouter<RouterContract extends Router>(
    chain: Chain,
    deployParams: Parameters<Factories['router']['deploy']>,
    initParams: Parameters<RouterContract['initialize']>,
  ): Promise<Contracts['router']> {
    const router = await this.deployContract(chain, 'router', deployParams);
    this.logger(`Initializing ${chain}'s router with ${initParams}`);
    const response = await router.initialize(
      // @ts-ignore spread operator
      ...initParams,
      chainConnection.overrides,
    );
    this.logger(`Pending init ${chainConnection.getTxUrl(response)}`);
    await response.wait(chainConnection.confirmations);
    return router;
  }

  async enrollRemoteRouters(contractsMap: ChainMap<Chain, Contracts>) {
    this.logger(`Enrolling deployed routers with each other...`);
    // Make all routers aware of eachother.
    await promiseObjAll(
      objMap(contractsMap, async (local, contracts) => {
        const chainConnection = this.multiProvider.getChainConnection(local);
        for (const remote of this.multiProvider.remoteChains(local)) {
          this.logger(`Enroll ${remote}'s router on ${local}`);
          await contracts.router.enrollRemoteRouter(
            chainMetadata[remote].id,
            utils.addressToBytes32(contractsMap[remote].router.address),
          );
          this.logger(`Pending enroll ${chainConnection.getTxUrl(response)}`);
          await response.wait(chainConnection.confirmations);
        }
      }),
    );
  }

  async transferOwnership(contractsMap: ChainMap<Chain, Contracts>) {
    // TODO: check for initialization before transferring ownership
    this.logger(`Transferring ownership of routers...`);
    await promiseObjAll(
      objMap(contractsMap, async (chain, contracts) => {
        const owner = this.configMap[chain].owner;
        this.logger(`Transfer ownership of ${chain}'s router to ${owner}`);
        await contracts.router.transferOwnership(owner);
      }),
    );
  }

  async deploy(
    partialDeployment: Partial<Record<Chain, Contracts>> = this
      .deployedContracts,
  ) {
    const contractsMap = await super.deploy(partialDeployment);

    await this.enrollRemoteRouters(contractsMap);
    await this.transferOwnership(contractsMap);

    return contractsMap;
  }
}
