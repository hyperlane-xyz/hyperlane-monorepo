import {
  ChainMap,
  ChainName,
  HyperlaneCore,
  HyperlaneRouterDeployer,
  MultiProvider,
} from '@hyperlane-xyz/sdk';

import {
  HelloWorldContracts,
  HelloWorldFactories,
  helloWorldFactories,
} from '../app/contracts';

import { HelloWorldConfig } from './config';

export class HelloWorldDeployer extends HyperlaneRouterDeployer<
  HelloWorldConfig,
  HelloWorldContracts,
  HelloWorldFactories
> {
  constructor(
    multiProvider: MultiProvider,
    configMap: ChainMap<HelloWorldConfig>,
    protected core: HyperlaneCore,
  ) {
    super(multiProvider, configMap, helloWorldFactories, {});
  }

  // Custom contract deployment logic can go here
  // If no custom logic is needed, call deployContract for the router
  async deployContracts(chain: ChainName, config: HelloWorldConfig) {
    const router = await this.deployContract(chain, 'router', [
      config.mailbox,
      config.interchainGasPaymaster,
    ]);
    return {
      router,
    };
  }
}
