import { ethers } from 'ethers';

import {
  ChainName,
  ContractVerifier,
  HyperlaneContracts,
  HyperlaneIsmFactory,
  HyperlaneRouterDeployer,
  MultiProvider,
} from '@hyperlane-xyz/sdk';

import { HelloWorldFactories, helloWorldFactories } from '../app/contracts.js';
import { HelloWorld } from '../types/index.js';

import { HelloWorldConfig } from './config.js';

export class HelloWorldDeployer extends HyperlaneRouterDeployer<
  HelloWorldConfig,
  HelloWorldFactories
> {
  constructor(
    multiProvider: MultiProvider,
    readonly ismFactory?: HyperlaneIsmFactory,
    readonly contractVerifier?: ContractVerifier,
    concurrentDeploy = false,
  ) {
    super(multiProvider, helloWorldFactories, {
      ismFactory,
      contractVerifier,
      concurrentDeploy,
    });
  }

  router(contracts: HyperlaneContracts<HelloWorldFactories>): HelloWorld {
    return contracts.router;
  }

  // Custom contract deployment logic can go here
  // If no custom logic is needed, call deployContract for the router
  async deployContracts(chain: ChainName, config: HelloWorldConfig) {
    const router = await this.deployContract(chain, 'router', [
      config.mailbox,
      ethers.ZeroAddress,
    ]);
    await super.configureClient(chain, router, config);
    return {
      router,
    };
  }
}
