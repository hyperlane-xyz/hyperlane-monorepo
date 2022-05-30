import { TestCoreApp } from './TestCoreApp';
import { TestInbox__factory, TestOutbox__factory } from '@abacus-network/core';
import { AbacusCoreDeployer, CoreConfig } from '@abacus-network/deploy';
import { MultiProvider, TestChainNames } from '@abacus-network/sdk';
import { ethers } from 'ethers';

// dummy config as TestInbox and TestOutbox do not use deployed ValidatorManager
const testValidatorManagerConfig: CoreConfig = {
  validatorManager: {
    validators: [ethers.constants.AddressZero],
    threshold: 1,
  },
};

export class TestCoreDeploy extends AbacusCoreDeployer<TestChainNames> {
  constructor(public readonly multiProvider: MultiProvider<TestChainNames>) {
    super(multiProvider, {
      test1: testValidatorManagerConfig,
      test2: testValidatorManagerConfig,
      test3: testValidatorManagerConfig,
    });
  }

  inboxFactoryBuilder = (signer: ethers.Signer) =>
    new TestInbox__factory(signer);
  outboxFactoryBuilder = (signer: ethers.Signer) =>
    new TestOutbox__factory(signer);

  async deployCore() {
    const result = await super.deploy();
    return new TestCoreApp(result, this.multiProvider);
  }
}
