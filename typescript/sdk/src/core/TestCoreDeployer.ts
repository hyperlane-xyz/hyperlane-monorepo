import { testChains } from '../consts/testChains.js';
import { type HyperlaneContracts } from '../contracts/types.js';
import { testCoreConfig } from '../test/testUtils.js';
import { type ChainMap } from '../types.js';

import { HyperlaneCoreDeployer } from './HyperlaneCoreDeployer.js';
import { TestCoreApp } from './TestCoreApp.js';
import { type CoreFactories } from './contracts.js';

export class TestCoreDeployer extends HyperlaneCoreDeployer {
  async deploy(): Promise<ChainMap<HyperlaneContracts<CoreFactories>>> {
    return super.deploy(testCoreConfig(testChains));
  }

  async deployApp(): Promise<TestCoreApp> {
    return new TestCoreApp(await this.deploy(), this.multiProvider);
  }
}
