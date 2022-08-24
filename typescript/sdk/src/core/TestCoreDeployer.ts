import { ethers } from 'ethers';

import { TestInbox__factory, TestOutbox__factory } from '@abacus-network/core';

import { chainMetadata } from '../consts/chainMetadata';
import { AbacusCoreDeployer } from '../deploy/core/AbacusCoreDeployer';
import { CoreConfig, ValidatorManagerConfig } from '../deploy/core/types';
import { MultiProvider } from '../providers/MultiProvider';
import { ProxiedContract } from '../proxy';
import { Remotes, TestChainNames } from '../types';

import {
  TestCoreApp,
  TestInboxContracts,
  TestOutboxContracts,
} from './TestCoreApp';
import { coreFactories } from './contracts';

const nonZeroAddress = ethers.constants.AddressZero.replace('00', '01');

// dummy config as TestInbox and TestOutbox do not use deployed ValidatorManager
const testValidatorManagerConfig: CoreConfig = {
  validatorManager: {
    validators: [nonZeroAddress],
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

export class TestCoreDeployer extends AbacusCoreDeployer<TestChainNames> {
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

  // skip proxying
  async deployOutbox<LocalChain extends TestChainNames>(
    chain: LocalChain,
    config: ValidatorManagerConfig,
  ): Promise<TestOutboxContracts> {
    const localDomain = chainMetadata[chain].id;
    const outboxContract = await this.deployContract(chain, 'outbox', [
      localDomain,
    ]);
    const outboxValidatorManager = await this.deployContract(
      chain,
      'outboxValidatorManager',
      [localDomain, config.validators, config.threshold],
    );
    // validator manager must be contract
    await outboxContract.initialize(outboxValidatorManager.address);
    return {
      outbox: mockProxy(outboxContract),
      outboxValidatorManager,
    } as TestOutboxContracts;
  }

  // skip proxying
  async deployInbox<LocalChain extends TestChainNames>(
    local: LocalChain,
    remote: Remotes<TestChainNames, LocalChain>,
    config: ValidatorManagerConfig,
  ): Promise<TestInboxContracts> {
    const localDomain = chainMetadata[local].id;
    const remoteDomain = chainMetadata[remote].id;
    const inboxContract = await this.deployContract(local, 'inbox', [
      localDomain,
    ]);
    const inboxValidatorManager = await this.deployContract(
      local,
      'inboxValidatorManager',
      [remoteDomain, config.validators, config.threshold],
    );
    await inboxContract.initialize(remoteDomain, inboxValidatorManager.address);
    return {
      inbox: mockProxy(inboxContract),
      inboxValidatorManager,
    } as TestInboxContracts;
  }

  async deployApp(): Promise<TestCoreApp> {
    return new TestCoreApp(await this.deploy(), this.multiProvider);
  }
}
