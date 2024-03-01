import debug from 'debug';
import { ethers } from 'ethers';

import {
  ChainName,
  DeployerOptions,
  HyperlaneContracts,
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
  constructor(multiProvider: MultiProvider, options?: DeployerOptions) {
    super(multiProvider, helloWorldFactories, {
      logger: debug('hyperlane:HelloWorldDeployer'),
      ...options,
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
      config.hook ?? ethers.constants.AddressZero,
    ]);
    return {
      router,
    };
  }
}
