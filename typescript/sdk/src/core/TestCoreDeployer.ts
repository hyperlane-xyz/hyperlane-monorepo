import { ethers } from 'ethers';

import {
  MultisigIsm,
  TestIsm__factory,
  TestMailbox,
  TestMailbox__factory,
} from '@hyperlane-xyz/core';
import { types } from '@hyperlane-xyz/utils';

import { chainMetadata } from '../consts/chainMetadata';
import { HyperlaneCoreDeployer } from '../deploy/core/HyperlaneCoreDeployer';
import { CoreConfig } from '../deploy/core/types';
import { MultiProvider } from '../providers/MultiProvider';
import { BeaconProxyAddresses, ProxiedContract, ProxyKind } from '../proxy';
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

  // skip proxying
  async deployMailbox<LocalChain extends TestChain>(
    chain: LocalChain,
    defaultIsmAddress: types.Address,
  ): Promise<ProxiedContract<TestMailbox, BeaconProxyAddresses>> {
    const localDomain = chainMetadata[chain].id;

    const mailbox = await this.deployContract(chain, 'mailbox', [localDomain]);
    await mailbox.initialize(defaultIsmAddress);
    return new ProxiedContract(mailbox, {
      kind: ProxyKind.UpgradeBeacon,
      proxy: mailbox.address,
      implementation: mailbox.address,
      beacon: mailbox.address,
    }) as ProxiedContract<TestMailbox, BeaconProxyAddresses>;
  }

  async deployApp(): Promise<TestCoreApp<TestChain>> {
    return new TestCoreApp(await this.deploy(), this.multiProvider);
  }
}
