import { ethers } from 'ethers';

import {
  LegacyMultisigIsm,
  TestInterchainGasPaymaster__factory,
  TestIsm__factory,
  TestMailbox__factory,
} from '@hyperlane-xyz/core';

import { TestChains } from '../consts/chains';
import { HyperlaneContracts } from '../contracts';
import { testCoreConfig } from '../test/testUtils';
import { ChainMap, ChainName } from '../types';

import { HyperlaneCoreDeployer } from './HyperlaneCoreDeployer';
import { TestCoreApp } from './TestCoreApp';
import { CoreFactories, coreFactories } from './contracts';
import { MultisigIsmConfig } from './types';

const testCoreFactories = {
  ...coreFactories,
  mailbox: new TestMailbox__factory(),
  testIsm: new TestIsm__factory(),
  interchainGasPaymaster: new TestInterchainGasPaymaster__factory(),
};

export class TestCoreDeployer extends HyperlaneCoreDeployer {
  factories = testCoreFactories;

  // deploy a test ISM in place of a multisig ISM
  async deployLegacyMultisigIsm(
    chain: ChainName,
    _: ChainMap<MultisigIsmConfig>,
  ): Promise<LegacyMultisigIsm> {
    const testIsm = await this.deployContractFromFactory(
      chain,
      testCoreFactories.testIsm,
      'testIsm',
      [],
    );
    await testIsm.setAccept(true);
    return testIsm as unknown as LegacyMultisigIsm;
  }

  // TestIsm is not ownable, so we skip ownership transfer
  async transferOwnershipOfContracts(): Promise<ethers.ContractReceipt[]> {
    return [];
  }

  async deploy(): Promise<ChainMap<HyperlaneContracts<CoreFactories>>> {
    return super.deploy(testCoreConfig(TestChains));
  }

  async deployApp(): Promise<TestCoreApp> {
    return new TestCoreApp(await this.deploy(), this.multiProvider);
  }
}
