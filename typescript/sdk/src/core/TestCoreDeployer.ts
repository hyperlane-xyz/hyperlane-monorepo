import {
  InterchainGasPaymaster,
  TestInterchainGasPaymaster__factory,
  TestIsm__factory,
  TestMailbox__factory,
} from '@hyperlane-xyz/core';
import { types } from '@hyperlane-xyz/utils';

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
};

export class TestCoreDeployer extends HyperlaneCoreDeployer {
  constructor(public readonly multiProvider: MultiProvider) {
    const ismFactory = new HyperlaneIsmFactory({}, multiProvider);
    super(multiProvider, ismFactory, testCoreFactories);
  }

  // deploy a test ISM instead of a real ISM
  async deployIsm(chain: ChainName): Promise<types.Address> {
    const testIsm = await this.multiProvider.handleDeploy(
      chain,
      new TestIsm__factory(),
      [],
    );
    return testIsm.address;
  }

  async deployIgpHook(chain: string): Promise<InterchainGasPaymaster> {
    return this.multiProvider.handleDeploy(
      chain,
      new TestInterchainGasPaymaster__factory(),
      [],
    );
  }

  async deploy(): Promise<ChainMap<HyperlaneContracts<CoreFactories>>> {
    return super.deploy(testCoreConfig(TestChains));
  }

  async deployApp(): Promise<TestCoreApp> {
    return new TestCoreApp(await this.deploy(), this.multiProvider);
  }
}
