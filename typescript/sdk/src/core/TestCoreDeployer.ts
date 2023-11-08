import { TestChains } from '../consts/chains';
import { HyperlaneContracts } from '../contracts/types';
import { testCoreConfig } from '../test/testUtils';
import { ChainMap } from '../types';

import { HyperlaneCoreDeployer } from './HyperlaneCoreDeployer';
import { TestCoreApp } from './TestCoreApp';
import { CoreFactories } from './contracts';

export class TestCoreDeployer extends HyperlaneCoreDeployer {
  async deploy(): Promise<ChainMap<HyperlaneContracts<CoreFactories>>> {
    return super.deploy(testCoreConfig(TestChains));
  }

  async deployApp(): Promise<TestCoreApp> {
    return new TestCoreApp(await this.deploy(), this.multiProvider);
  }
}
