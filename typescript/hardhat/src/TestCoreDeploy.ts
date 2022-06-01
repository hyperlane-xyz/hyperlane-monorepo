import {
  TestCoreApp,
  TestInboxContracts,
  TestOutboxContracts,
} from './TestCoreApp';
import { TestInbox__factory, TestOutbox__factory } from '@abacus-network/core';
import { AbacusCoreDeployer, CoreConfig } from '@abacus-network/deploy';
import {
  MultiProvider,
  ProxiedContract,
  Remotes,
  TestChainNames,
  chainMetadata,
  coreFactories,
} from '@abacus-network/sdk';
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

function mockProxy(contract: ethers.Contract) {
  return new ProxiedContract(contract, {
    kind: 'MOCK',
    proxy: contract.address,
    implementation: contract.address,
  });
}

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

  // skip proxying and deploying validator managers
  async deployOutbox<LocalChain extends TestChainNames>(
    chain: LocalChain,
  ): Promise<TestOutboxContracts> {
    const contract = await this.deployContract(chain, 'outbox', [
      chainMetadata[chain].id,
    ]);
    // validator manager must be contract
    await contract.initialize(contract.address);
    return { outbox: mockProxy(contract) } as TestOutboxContracts;
  }

  // skip proxying and deploying validator managers
  async deployInbox<LocalChain extends TestChainNames>(
    local: LocalChain,
    remote: Remotes<TestChainNames, LocalChain>,
  ): Promise<TestInboxContracts> {
    const contract = await this.deployContract(local, 'inbox', [
      chainMetadata[local].id,
    ]);
    // validator manager must be contract
    await contract.initialize(chainMetadata[remote].id, contract.address);
    return { inbox: mockProxy(contract) } as TestInboxContracts;
  }

  async deployCore() {
    return new TestCoreApp(await this.deploy());
  }
}
