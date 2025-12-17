import { ethers } from 'ethers';

import {
  type ChainName,
  type ContractVerifier,
  type HyperlaneContracts,
  type HyperlaneIsmFactory,
  HyperlaneRouterDeployer,
  type MultiProvider,
} from '@hyperlane-xyz/sdk';

import {
  type HelloWorldFactories,
  helloWorldFactories,
} from '../app/contracts.js';
import { type HelloWorld } from '../types/index.js';

import { type HelloWorldConfig } from './config.js';

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
      ethers.constants.AddressZero,
    ]);
    await super.configureClient(chain, router, config);
    return {
      router,
    };
  }
}
