import { TestRouter__factory } from '@hyperlane-xyz/core';

import { HyperlaneApp } from '../../HyperlaneApp';
import { Chains, TestChains, chainMetadata } from '../../consts';
import { HyperlaneCore } from '../../core';
import { HyperlaneDeployer } from '../../deploy';
import { MultiProvider } from '../../providers';
import {
  HyperlaneRouterChecker,
  HyperlaneRouterDeployer,
  RouterConfig,
  RouterContracts,
  RouterFactories,
} from '../../router';
import { ChainMap, ChainName } from '../../types';
import { objMap, pick, promiseObjAll } from '../../utils';

export const fullTestEnvConfigs = pick(chainMetadata, TestChains);

export const subsetTestConfigs = pick(chainMetadata, [
  Chains.test1,
  Chains.test2,
]);

export const alfajoresChainConfig = pick(chainMetadata, [Chains.alfajores]);

export class EnvSubsetApp extends HyperlaneApp<RouterContracts> {}

export class EnvSubsetChecker extends HyperlaneRouterChecker<
  EnvSubsetApp,
  RouterConfig,
  RouterContracts
> {}

export const envSubsetFactories: RouterFactories = {
  router: new TestRouter__factory(),
};

export class EnvSubsetDeployer extends HyperlaneRouterDeployer<
  RouterConfig,
  RouterContracts,
  RouterFactories
> {
  constructor(
    multiProvider: MultiProvider,
    configMap: ChainMap<RouterConfig>,
    protected core: HyperlaneCore,
  ) {
    super(multiProvider, configMap, envSubsetFactories, {});
  }

  // Consider moving this up to HyperlaneRouterDeployer
  async initRouter(contractsMap: ChainMap<RouterContracts>): Promise<void> {
    this.logger(`Calling initialize on routers...`);
    await promiseObjAll(
      objMap(contractsMap, async (chain, contracts) => {
        const mailbox = this.configMap[chain].mailbox;
        const igp = this.configMap[chain].interchainGasPaymaster;
        const overrides = this.multiProvider.getTransactionOverrides(chain);
        await this.multiProvider.handleTx(
          chain,
          // @ts-ignore TestRouter does implement this, though Router type does not
          contracts.router.initialize(mailbox, igp, overrides),
        );
      }),
    );
  }

  async deploy(): Promise<ChainMap<RouterContracts>> {
    const contractsMap = (await HyperlaneDeployer.prototype.deploy.apply(
      this,
    )) as ChainMap<RouterContracts>;
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
