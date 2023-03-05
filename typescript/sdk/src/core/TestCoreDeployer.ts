import { ethers } from 'ethers';

import {
  MultisigIsm,
  TestInterchainGasPaymaster__factory,
  TestIsm__factory,
  TestMailbox__factory,
} from '@hyperlane-xyz/core';

import { HyperlaneCoreDeployer } from '../deploy/core/HyperlaneCoreDeployer';
import { CoreConfig, GasOracleContractType } from '../deploy/core/types';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';

import { TestCoreApp } from './TestCoreApp';
import { coreFactories } from './contracts';

const nonZeroAddress = ethers.constants.AddressZero.replace('00', '01');

// dummy config as TestInbox and TestOutbox do not use deployed ISM
const testConfig: CoreConfig = {
  owner: nonZeroAddress,
  multisigIsm: {
    validators: [nonZeroAddress],
    threshold: 1,
  },
  igp: {
    beneficiary: nonZeroAddress,
    gasOracles: {
      test1: GasOracleContractType.StorageGasOracle,
      test2: GasOracleContractType.StorageGasOracle,
      test3: GasOracleContractType.StorageGasOracle,
    },
  },
};

const testCoreFactories = {
  ...coreFactories,
  mailbox: new TestMailbox__factory(),
  testIsm: new TestIsm__factory(),
  interchainGasPaymaster: new TestInterchainGasPaymaster__factory(),
};

export class TestCoreDeployer extends HyperlaneCoreDeployer {
  constructor(
    public readonly multiProvider: MultiProvider,
    configMap?: ChainMap<CoreConfig>,
  ) {
    // Note that the multisig module configs are unused.
    const configs = configMap ?? {
      test1: testConfig,
      test2: testConfig,
      test3: testConfig,
    };

    super(multiProvider, configs, testCoreFactories);
  }

  // deploy a test ISM in place of a multisig ISM
  async deployMultisigIsm(chain: ChainName): Promise<MultisigIsm> {
    const testIsm = await this.deployContractFromFactory(
      chain,
      testCoreFactories.testIsm,
      'testIsm',
      [],
    );
    await testIsm.setAccept(true);
    return testIsm as unknown as MultisigIsm;
  }

  // TestIsm is not ownable, so we skip ownership transfer
  async transferOwnershipOfContracts(): Promise<ethers.ContractReceipt[]> {
    return [];
  }

  async deployApp(): Promise<TestCoreApp> {
    return new TestCoreApp(await this.deploy(), this.multiProvider);
  }
}
