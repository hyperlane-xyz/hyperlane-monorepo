import { ethers } from 'ethers';

import {
  MultisigIsm,
  TestIsm__factory,
  TestMailbox__factory,
} from '@hyperlane-xyz/core';

import { HyperlaneCoreDeployer } from '../deploy/core/HyperlaneCoreDeployer';
import { CoreConfig } from '../deploy/core/types';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, TestChainNames } from '../types';

import { TestCoreApp } from './TestCoreApp';
import { coreFactories } from './contracts';

const nonZeroAddress = ethers.constants.AddressZero.replace('00', '01');

// dummy config as TestInbox and TestOutbox do not use deployed ValidatorManager
const testMultisigIsmConfig: CoreConfig = {
  multisigIsm: {
    validators: [nonZeroAddress],
    threshold: 1,
  },
};

const testCoreFactories = {
  ...coreFactories,
  mailbox: new TestMailbox__factory(),
  testIsm: new TestIsm__factory(),
};

export class TestCoreDeployer<
  TestChain extends TestChainNames = TestChainNames,
> extends HyperlaneCoreDeployer<TestChain> {
  constructor(
    public readonly multiProvider: MultiProvider<TestChain>,
    configMap?: ChainMap<TestChain, CoreConfig>,
  ) {
    // Note that the multisig module configs are unused.
    const configs =
      configMap ??
      ({
        test1: testMultisigIsmConfig,
        test2: testMultisigIsmConfig,
        test3: testMultisigIsmConfig,
      } as ChainMap<TestChain, CoreConfig>); // cast so param can be optional

    super(multiProvider, configs, testCoreFactories);
  }

  // deploy a test ISM in place of a multisig ISM
  async deployMultisigIsm<LocalChain extends TestChain>(
    chain: LocalChain,
  ): Promise<MultisigIsm> {
    const testIsm = await this.deployContractFromFactory(
      chain,
      testCoreFactories.testIsm,
      'testIsm',
      [],
    );
    await testIsm.setAccept(true);
    return testIsm as unknown as MultisigIsm;
  }

  async deployApp(): Promise<TestCoreApp<TestChain>> {
    return new TestCoreApp(await this.deploy(), this.multiProvider);
  }
}
