import { TestRouter__factory } from '@abacus-network/app';

import { AbacusApp } from '../../AbacusApp';
import { chainConnectionConfigs } from '../../consts/chainConnectionConfigs';
import { AbacusCore } from '../../core/AbacusCore';
import { AbacusDeployer } from '../../deploy/AbacusDeployer';
import { AbacusRouterChecker } from '../../deploy/router/AbacusRouterChecker';
import { AbacusRouterDeployer } from '../../deploy/router/AbacusRouterDeployer';
import { RouterConfig } from '../../deploy/router/types';
import { MultiProvider } from '../../providers/MultiProvider';
import { RouterContracts, RouterFactories } from '../../router';
import { ChainMap, ChainName } from '../../types';
import { objMap, promiseObjAll } from '../../utils/objects';

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

export const alfajoresChainConfig = {
  alfajores: chainConnectionConfigs.alfajores,
};

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

export class EnvSubsetDeployer<
  Chain extends ChainName,
> extends AbacusRouterDeployer<
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

  // Consider moving this up to AbacusRouterDeployer
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

  async deploy(): Promise<ChainMap<Chain, RouterContracts>> {
    const contractsMap = (await AbacusDeployer.prototype.deploy.apply(
      this,
    )) as Record<Chain, RouterContracts>;
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
