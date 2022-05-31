import { TestCoreApp } from './TestCoreApp';
import { TestInbox__factory, TestOutbox__factory } from '@abacus-network/core';
import { AbacusCoreDeployer, CoreConfig } from '@abacus-network/deploy';
import {
  MultiProvider,
  TestChainNames,
  chainMetadata,
  coreFactories,
} from '@abacus-network/sdk';
import { utils } from '@abacus-network/utils';
import { ethers } from 'ethers';

// dummy config as TestInbox and TestOutbox do not use deployed ValidatorManager
const testValidatorManagerConfig: CoreConfig = {
  validatorManager: {
    validators: [ethers.constants.AddressZero],
    threshold: 1,
  },
};

const testCoreFactories = {
  ...coreFactories,
  inbox: new TestInbox__factory(),
  outbox: new TestOutbox__factory(),
};
export class TestCoreDeploy extends AbacusCoreDeployer<TestChainNames> {
  constructor(public readonly multiProvider: MultiProvider<TestChainNames>) {
    super(
      multiProvider,
      {
        test1: testValidatorManagerConfig,
        test2: testValidatorManagerConfig,
        test3: testValidatorManagerConfig,
      },
      testCoreFactories,
    );
  }

  async deployContracts<LocalChain extends TestChainNames>(
    local: LocalChain,
    config: CoreConfig,
  ) {
    const contracts = await super.deployContracts(local, config);
    const remote = this.multiProvider.remoteChains(local)[0];

    // dispatch a dummy event to allow a consumer to checkpoint/process a single message
    await contracts.outbox.outbox.dispatch(
      chainMetadata[remote].id,
      utils.addressToBytes32(ethers.constants.AddressZero),
      '0x',
    );

    return contracts;
  }

  async deployCore() {
    const contractsMap = await this.deploy();
    return new TestCoreApp(contractsMap as any);
  }
}
