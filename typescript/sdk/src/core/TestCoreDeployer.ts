import { TestChains } from '../consts/chains.js';
import { HyperlaneContracts } from '../contracts/types.js';
import { testCoreConfig } from '../test/testUtils.js';
import { ChainMap } from '../types.js';

import { HyperlaneCoreDeployer } from './HyperlaneCoreDeployer.js';
import { TestCoreApp } from './TestCoreApp.js';
import { CoreFactories } from './contracts.js';

export class TestCoreDeployer extends HyperlaneCoreDeployer {
  async deploy(): Promise<ChainMap<HyperlaneContracts<CoreFactories>>> {
    return super.deploy(testCoreConfig(TestChains));
  }

  async deployApp(): Promise<TestCoreApp> {
    return new TestCoreApp(await this.deploy(), this.multiProvider);
  }
}
