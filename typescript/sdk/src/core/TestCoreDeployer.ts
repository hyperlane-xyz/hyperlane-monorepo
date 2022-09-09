import { ethers } from 'ethers';

import { TestMailbox, TestMailbox__factory } from '@abacus-network/core';

import { chainMetadata } from '../consts/chainMetadata';
import { AbacusCoreDeployer } from '../deploy/core/AbacusCoreDeployer';
import { CoreConfig } from '../deploy/core/types';
import { MultiProvider } from '../providers/MultiProvider';
import { BeaconProxyAddresses, ProxiedContract, ProxyKind } from '../proxy';
import { ChainMap, TestChainNames } from '../types';

import { TestCoreApp } from './TestCoreApp';
import { coreFactories } from './contracts';

const nonZeroAddress = ethers.constants.AddressZero.replace('00', '01');

// dummy config as TestInbox and TestOutbox do not use deployed ValidatorManager
const testMultisigZoneConfig: CoreConfig = {
  validatorManager: {
    validators: [nonZeroAddress],
    threshold: 1,
  },
};

const testCoreFactories = {
  ...coreFactories,
  mailbox: new TestMailbox__factory(),
};

export class TestCoreDeployer<
  TestChain extends TestChainNames = TestChainNames,
> extends AbacusCoreDeployer<TestChain> {
  constructor(
    public readonly multiProvider: MultiProvider<TestChain>,
    configMap?: ChainMap<TestChain, CoreConfig>,
  ) {
    const configs =
      configMap ??
      ({
        test1: testMultisigZoneConfig,
        test2: testMultisigZoneConfig,
        test3: testMultisigZoneConfig,
      } as ChainMap<TestChain, CoreConfig>); // cast so param can be optional

    super(multiProvider, configs, testCoreFactories);
  }

  // skip proxying
  async deployMailbox<LocalChain extends TestChain>(
    chain: LocalChain,
  ): Promise<ProxiedContract<TestMailbox, BeaconProxyAddresses>> {
    const localDomain = chainMetadata[chain].id;
    const mailbox = await this.deployContract(chain, 'mailbox', [localDomain]);
    // await outboxContract.initialize(outboxValidatorManager.address);
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
