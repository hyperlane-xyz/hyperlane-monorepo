import { zeroAddress } from 'viem';

import type { Router } from '@hyperlane-xyz/core';
import {
  ChainName,
  ContractVerifier,
  HyperlaneContracts,
  HyperlaneIsmFactory,
  HyperlaneRouterDeployer,
  MultiProvider,
} from '@hyperlane-xyz/sdk';

import { HelloWorldFactories, helloWorldFactories } from '../app/contracts.js';

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

  router(contracts: HyperlaneContracts<HelloWorldFactories>): Router {
    return contracts.router as unknown as Router;
  }

  // Custom contract deployment logic can go here
  // If no custom logic is needed, call deployContract for the router
  async deployContracts(chain: ChainName, config: HelloWorldConfig) {
    const router = await this.deployContract(chain, 'router', [
      config.mailbox,
      zeroAddress,
    ]);
    await super.configureClient(chain, router as Router, config);
    return {
      router,
    };
  }
}
