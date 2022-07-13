import { TestRouter__factory } from '@abacus-network/app';
import { utils } from '@abacus-network/utils';

import { AbacusApp } from '../../AbacusApp';
import { chainConnectionConfigs } from '../../consts/chainConnectionConfigs';
import { chainMetadata } from '../../consts/chainMetadata';
import { AbacusCore } from '../../core/AbacusCore';
import { AbacusDeployer } from '../../deploy/AbacusDeployer';
import { AbacusRouterChecker } from '../../deploy/router/AbacusRouterChecker';
import { RouterConfig } from '../../deploy/router/types';
import { MultiProvider } from '../../providers/MultiProvider';
import { RouterContracts, RouterFactories } from '../../router';
import { ChainMap, ChainName } from '../../types';
import { objMap, promiseObjAll } from '../../utils';

export const fullEnvTestConfigs = {
  test1: chainConnectionConfigs.test1,
  test2: chainConnectionConfigs.test2,
  test3: chainConnectionConfigs.test3,
};

export const subsetTestConfigs = {
  test1: chainConnectionConfigs.test1,
  test2: chainConnectionConfigs.test2,
};

export type SubsetChains = keyof typeof subsetTestConfigs;

export const singleChainConfig = {
  alfajores: chainConnectionConfigs.alfajores,
};

export type SingleChain = keyof typeof subsetTestConfigs;

export class EnvSubsetApp<
  Chain extends ChainName = ChainName,
> extends AbacusApp<RouterContracts, Chain> {}

export class EnvSubsetChecker<
  Chain extends ChainName,
> extends AbacusRouterChecker<
  Chain,
  EnvSubsetApp<Chain>,
  RouterConfig,
  RouterContracts
> {}

export const envSubsetFactories: RouterFactories = {
  router: new TestRouter__factory(),
};

export class EnvSubsetDeployer<Chain extends ChainName> extends AbacusDeployer<
  Chain,
  RouterConfig,
  RouterContracts,
  RouterFactories
> {
  constructor(
    multiProvider: MultiProvider<Chain>,
    configMap: ChainMap<Chain, RouterConfig>,
    protected core: AbacusCore<Chain>,
  ) {
    super(multiProvider, configMap, envSubsetFactories, {});
  }

  // TODO move to AbacusRouterDeployer?
  async initRouter(
    contractsMap: ChainMap<Chain, RouterContracts>,
  ): Promise<void> {
    this.logger(`Calling initialize on routers...`);
    await promiseObjAll(
      objMap(contractsMap, async (chain, contracts) => {
        const chainConnection = this.multiProvider.getChainConnection(chain);
        const acm = this.configMap[chain].abacusConnectionManager;
        await chainConnection.handleTx(
          // @ts-ignore
          contracts.router.initialize(acm, chainConnection.overrides),
        );
      }),
    );
  }

  // TODO de-dupe with AbacusRouterDeployer
  async enrollRemoteRouters(
    contractsMap: ChainMap<Chain, RouterContracts>,
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

  async deploy(
    partialDeployment?: Partial<Record<Chain, RouterContracts>>,
  ): Promise<ChainMap<Chain, RouterContracts>> {
    const contractsMap = await super.deploy(partialDeployment);
    await this.initRouter(contractsMap);
    await this.enrollRemoteRouters(contractsMap);
    return contractsMap;
  }

  async deployContracts(chain: Chain) {
    const router = await this.deployContract(chain, 'router', []);
    return {
      router,
    };
  }
}
