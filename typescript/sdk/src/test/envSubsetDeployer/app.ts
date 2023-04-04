import { TestRouter, TestRouter__factory } from '@hyperlane-xyz/core';

import { chainMetadata } from '../../consts/chainMetadata';
import { Chains } from '../../consts/chains';
import { HyperlaneCore } from '../../core/HyperlaneCore';
import { HyperlaneDeployer } from '../../deploy/HyperlaneDeployer';
import { MultiProvider } from '../../providers/MultiProvider';
import { HyperlaneRouterChecker } from '../../router/HyperlaneRouterChecker';
import { HyperlaneRouterDeployer } from '../../router/HyperlaneRouterDeployer';
import { RouterApp } from '../../router/RouterApps';
import { RouterConfig } from '../../router/types';
import { ChainMap, ChainName } from '../../types';
import { objMap, pick, promiseObjAll } from '../../utils/objects';

export const alfajoresChainConfig = pick(chainMetadata, [Chains.alfajores]);

export type TestRouterContracts = {
  router: TestRouter;
};

export type TestRouterFactories = {
  router: TestRouter__factory;
};

export const testRouterFactories: TestRouterFactories = {
  router: new TestRouter__factory(),
};

export class EnvSubsetApp extends RouterApp<typeof testRouterFactories> {
  router(contracts: TestRouterContracts) {
    return contracts.router;
  }
}

export class EnvSubsetChecker extends HyperlaneRouterChecker<
  typeof testRouterFactories,
  EnvSubsetApp,
  RouterConfig
> {}

export class EnvSubsetDeployer extends HyperlaneRouterDeployer<
  RouterConfig,
  TestRouterFactories
> {
  constructor(
    multiProvider: MultiProvider,
    configMap: ChainMap<RouterConfig>,
    protected core: HyperlaneCore,
  ) {
    super(multiProvider, configMap, testRouterFactories, {});
  }

  router(contracts: TestRouterContracts): TestRouter {
    return contracts.router;
  }

  // Consider moving this up to HyperlaneRouterDeployer
  async initRouter(contractsMap: ChainMap<TestRouterContracts>): Promise<void> {
    this.logger(`Calling initialize on routers...`);
    await promiseObjAll(
      objMap(contractsMap, async (chain, contracts) => {
        const mailbox = this.configMap[chain].mailbox;
        const igp = this.configMap[chain].interchainGasPaymaster;
        const overrides = this.multiProvider.getTransactionOverrides(chain);
        await this.multiProvider.handleTx(
          chain,
          this.router(contracts).initialize(mailbox, igp, overrides),
        );
      }),
    );
  }

  async deploy(): Promise<ChainMap<TestRouterContracts>> {
    const contractsMap = (await HyperlaneDeployer.prototype.deploy.apply(
      this,
    )) as ChainMap<TestRouterContracts>;
    await this.initRouter(contractsMap);
    await this.enrollRemoteRouters(contractsMap);
    return contractsMap;
  }

  async deployContracts(chain: ChainName) {
    const router = await this.deployContract(chain, 'router', []);
    return {
      router,
    };
  }
}
