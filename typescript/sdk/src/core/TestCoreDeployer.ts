import {
  TestInterchainGasPaymaster__factory,
  TestIsm__factory,
  TestMailbox__factory,
} from '@hyperlane-xyz/core';

import { TestChains } from '../consts/chains';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory';
import { MultiProvider } from '../providers/MultiProvider';
import { testCoreConfig } from '../test/testUtils';
import { ChainMap, ChainName } from '../types';

import { HyperlaneCoreDeployer } from './HyperlaneCoreDeployer';
import { TestCoreApp } from './TestCoreApp';
import { coreFactories } from './contracts';
import { CoreConfig } from './types';

const testCoreFactories = {
  ...coreFactories,
  mailbox: new TestMailbox__factory(),
  interchainGasPaymaster: new TestInterchainGasPaymaster__factory(),
  testIsm: new TestIsm__factory(),
};

export class TestCoreDeployer extends HyperlaneCoreDeployer {
  constructor(
    public readonly multiProvider: MultiProvider,
    configMap?: ChainMap<CoreConfig>,
  ) {
    // Note that the multisig module configs are unused.
    const configs = configMap ?? testCoreConfig(TestChains);
    // The IsmFactory is unused
    const ismFactory = new HyperlaneIsmFactory({}, multiProvider);

    super(multiProvider, configs, ismFactory, testCoreFactories);
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

  async deployApp(): Promise<TestCoreApp> {
    return new TestCoreApp(await this.deploy(), this.multiProvider);
  }
}
