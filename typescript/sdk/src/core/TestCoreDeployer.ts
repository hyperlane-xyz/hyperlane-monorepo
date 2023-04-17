import {
  TestInterchainGasPaymaster__factory,
  TestIsm__factory,
  TestMailbox__factory,
} from '@hyperlane-xyz/core';

import { TestChains } from '../consts/chains';
import { HyperlaneContracts } from '../contracts';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory';
import { MultiProvider } from '../providers/MultiProvider';
import { testCoreConfig } from '../test/testUtils';
import { ChainMap, ChainName } from '../types';

import { HyperlaneCoreDeployer } from './HyperlaneCoreDeployer';
import { TestCoreApp } from './TestCoreApp';
import { CoreFactories, coreFactories } from './contracts';

const testCoreFactories = {
  ...coreFactories,
  mailbox: new TestMailbox__factory(),
  interchainGasPaymaster: new TestInterchainGasPaymaster__factory(),
  testIsm: new TestIsm__factory(),
};

export class TestCoreDeployer extends HyperlaneCoreDeployer {
  constructor(public readonly multiProvider: MultiProvider) {
    const ismFactory = new HyperlaneIsmFactory({}, multiProvider);
    super(multiProvider, ismFactory);
  }

  // deploy a test ISM instead of a real ISM
  async deployIsm(chain: ChainName): Promise<string> {
    const testIsm = await this.deployContractFromFactory(
      chain,
      testCoreFactories.testIsm,
      'testIsm',
      [],
    );
    await testIsm.setAccept(true);
    return testIsm.address;
  }

  async deploy(): Promise<ChainMap<HyperlaneContracts<CoreFactories>>> {
    return super.deploy(testCoreConfig(TestChains));
  }

  async deployApp(): Promise<TestCoreApp> {
    return new TestCoreApp(await this.deploy(), this.multiProvider);
  }
}
