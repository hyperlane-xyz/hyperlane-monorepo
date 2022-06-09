import { AbacusRouterDeployer } from '@abacus-network/deploy';
import {
  AbacusCore,
  ChainMap,
  ChainName,
  MultiProvider,
} from '@abacus-network/sdk';
import {
  HelloWorldContracts,
  helloWorldFactories,
  HelloWorldFactories,
} from '../sdk/contracts';
import { HelloWorldConfig } from './config';

export class HelloWorldDeployer<
  Chain extends ChainName,
> extends AbacusRouterDeployer<
  Chain,
  HelloWorldContracts,
  HelloWorldFactories,
  HelloWorldConfig
> {
  constructor(
    multiProvider: MultiProvider<Chain>,
    configMap: ChainMap<Chain, HelloWorldConfig>,
    protected core: AbacusCore<Chain>,
  ) {
    super(multiProvider, configMap, helloWorldFactories, {});
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async deployContracts(chain: Chain, config: HelloWorldConfig) {
    const acm = this.core.getContracts(chain).abacusConnectionManager.address;
    const router = await this.deployRouter(chain, [], [acm]);
    return {
      router,
    };
  }
}
