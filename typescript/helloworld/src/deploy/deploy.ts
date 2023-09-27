import { ethers } from 'ethers';

import {
  ChainName,
  HyperlaneContracts,
  HyperlaneIsmFactory,
  HyperlaneRouterDeployer,
  MultiProvider,
} from '@hyperlane-xyz/sdk';

import { HelloWorldFactories, helloWorldFactories } from '../app/contracts';
import { HelloWorld } from '../types';

import { HelloWorldConfig } from './config';

export class HelloWorldDeployer extends HyperlaneRouterDeployer<
  HelloWorldConfig,
  HelloWorldFactories
> {
  constructor(
    multiProvider: MultiProvider,
    readonly ismFactory?: HyperlaneIsmFactory,
  ) {
    super(multiProvider, helloWorldFactories, { ismFactory });
  }

  router(contracts: HyperlaneContracts<HelloWorldFactories>): HelloWorld {
    return contracts.router;
  }

  // Custom contract deployment logic can go here
  // If no custom logic is needed, call deployContract for the router
  async deployContracts(chain: ChainName, config: HelloWorldConfig) {
    const router = await this.deployContract(chain, 'router', [
      config.mailbox,
      config.hook ?? ethers.constants.AddressZero,
    ]);
    return {
      router,
    };
  }
}
