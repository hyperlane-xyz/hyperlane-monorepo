import { TestCoreApp } from './TestCoreApp';
import { TestInbox__factory, TestOutbox__factory } from '@abacus-network/core';
import { AbacusCoreDeployer, CoreConfig } from '@abacus-network/deploy';
import {
  chainMetadata,
  CoreContractAddresses,
  MultiProvider,
  TestChainNames,
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

export class TestCoreDeploy extends AbacusCoreDeployer<TestChainNames> {
  constructor(multiProvider: MultiProvider<TestChainNames>) {
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

  async deployContracts<LocalChain extends TestChainNames>(
    local: LocalChain,
    config: CoreConfig,
  ): Promise<CoreContractAddresses<TestChainNames, LocalChain>> {
    const addresses = await super.deployContracts(local, config);

    const signer = this.multiProvider.getChainConnection(local).signer!;
    const outbox = this.outboxFactoryBuilder(signer).attach(
      addresses.outbox.proxy,
    );
    const remote = this.multiProvider.remoteChains(local)[0];

    // dispatch a dummy event to allow a consumer to checkpoint/process a single message
    await outbox.dispatch(
      chainMetadata[remote].id,
      utils.addressToBytes32(ethers.constants.AddressZero),
      '0x',
    );

    return addresses;
  }

  async deployCore() {
    const result = await super.deploy();
    return new TestCoreApp(result, this.multiProvider);
  }
}
