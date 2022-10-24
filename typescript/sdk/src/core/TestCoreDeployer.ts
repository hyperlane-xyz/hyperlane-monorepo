import { ethers } from 'ethers';

import { TestMailbox, TestMailbox__factory } from '@hyperlane-xyz/core';

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
const testMultisigModuleConfig: CoreConfig = {
  defaultModule: {
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
> extends HyperlaneCoreDeployer<TestChain> {
  constructor(
    public readonly multiProvider: MultiProvider<TestChain>,
    configMap?: ChainMap<TestChain, CoreConfig>,
  ) {
    const configs =
      configMap ??
      ({
        test1: testMultisigModuleConfig,
        test2: testMultisigModuleConfig,
        test3: testMultisigModuleConfig,
      } as ChainMap<TestChain, CoreConfig>); // cast so param can be optional

    super(multiProvider, configs, testCoreFactories);
  }

  // skip proxying
  async deployMailbox<LocalChain extends TestChain>(
    chain: LocalChain,
  ): Promise<ProxiedContract<TestMailbox, BeaconProxyAddresses>> {
    const localDomain = chainMetadata[chain].id;
    // TODO: Configure multisigzone
    const mailbox = await this.deployContract(chain, 'mailbox', [
      localDomain,
      this.version,
    ]);
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
