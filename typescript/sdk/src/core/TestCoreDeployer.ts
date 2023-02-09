import { ethers } from 'ethers';

import {
  InterchainGasPaymaster,
  MultisigIsm,
  ProxyAdmin,
  TestInterchainGasPaymaster__factory,
  TestIsm__factory,
  TestMailbox__factory,
} from '@hyperlane-xyz/core';
import { types } from '@hyperlane-xyz/utils';

import { DeployOptions } from '../deploy/HyperlaneDeployer';
import { HyperlaneCoreDeployer } from '../deploy/core/HyperlaneCoreDeployer';
import { CoreConfig, GasOracleContractType } from '../deploy/core/types';
import { MultiProvider } from '../providers/MultiProvider';
import { ProxiedContract, TransparentProxyAddresses } from '../proxy';
import { ChainMap, TestChainNames } from '../types';

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
  testInterchainGasPaymaster: new TestInterchainGasPaymaster__factory(),
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
        test1: testConfig,
        test2: testConfig,
        test3: testConfig,
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

  // deploy a test IGP instead
  async deployInterchainGasPaymaster<LocalChain extends TestChain>(
    chain: LocalChain,
    proxyAdmin: ProxyAdmin,
    _storageGasOracleAddress: types.Address,
    deployOpts?: DeployOptions,
  ): Promise<
    ProxiedContract<InterchainGasPaymaster, TransparentProxyAddresses>
  > {
    const implementation = await this.deployContractFromFactory(
      chain,
      testCoreFactories.testInterchainGasPaymaster,
      'testInterchainGasPaymaster',
      [],
      deployOpts,
    );

    const contract = await this.deployProxy(
      chain,
      implementation,
      proxyAdmin,
      [],
      deployOpts,
    );
    return contract as ProxiedContract<
      InterchainGasPaymaster,
      TransparentProxyAddresses
    >;
  }

  // TestIsm is not ownable, so we skip ownership transfer
  async transferOwnershipOfContracts(): Promise<ethers.ContractReceipt[]> {
    return [];
  }

  async deployApp(): Promise<TestCoreApp<TestChain>> {
    return new TestCoreApp(await this.deploy(), this.multiProvider);
  }
}
