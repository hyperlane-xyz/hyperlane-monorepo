import { TestCoreApp } from './TestCoreApp';
import { TestNetworks } from './types';
import { TestInbox__factory, TestOutbox__factory } from '@abacus-network/core';
import { AbacusCoreDeployer, CoreConfig } from '@abacus-network/deploy';
import {
  CoreContractAddresses,
  domains,
  MultiProvider,
} from '@abacus-network/sdk';
import { utils } from '@abacus-network/utils';
import { ethers } from 'ethers';

// reverts on 0 validators or threshold > validators.length
const testValidatorManagerConfig: CoreConfig = {
  validatorManager: {
    validators: [ethers.constants.AddressZero],
    threshold: 1,
  },
};

export class TestCoreDeploy extends AbacusCoreDeployer<TestNetworks> {
  constructor(multiProvider: MultiProvider<TestNetworks>) {
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

  async deployContracts<Local extends TestNetworks>(
    network: Local,
    config: CoreConfig,
  ): Promise<CoreContractAddresses<TestNetworks, Local>> {
    const addresses = await super.deployContracts(network, config);

    const signer = this.multiProvider.getChainConnection(network).signer!;
    const outbox = this.outboxFactoryBuilder(signer).attach(
      addresses.outbox.proxy,
    );
    const remote = this.multiProvider.remotes(network)[0];

    // dispatch a dummy event to allow a consumer to checkpoint/process a single message
    await outbox.dispatch(
      domains[remote].id,
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
