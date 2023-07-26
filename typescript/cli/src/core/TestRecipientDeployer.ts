import debug from 'debug';

import { TestRecipient, TestRecipient__factory } from '@hyperlane-xyz/core';
import {
  ChainName,
  HyperlaneDeployer,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import { types, utils } from '@hyperlane-xyz/utils';

// Maps chain name to ISM address
export type TestRecipientConfig = {
  interchainSecurityModule: types.Address;
};

export type TestRecipientContracts = {
  testRecipient: TestRecipient;
};

export type TestRecipientAddresses = {
  testRecipient: types.Address;
};

export const testRecipientFactories = {
  testRecipient: new TestRecipient__factory(),
};

export class HyperlaneTestRecipientDeployer extends HyperlaneDeployer<
  TestRecipientConfig,
  typeof testRecipientFactories
> {
  constructor(multiProvider: MultiProvider) {
    super(multiProvider, testRecipientFactories, {
      logger: debug('hyperlane:TestRecipientDeployer'),
    });
  }

  async deployContracts(
    chain: ChainName,
    config: TestRecipientConfig,
  ): Promise<TestRecipientContracts> {
    const testRecipient = await this.deployContract(chain, 'testRecipient', []);
    const ism = await testRecipient.interchainSecurityModule();
    if (!utils.eqAddress(ism, config.interchainSecurityModule)) {
      const tx = testRecipient.setInterchainSecurityModule(
        config.interchainSecurityModule,
      );
      await this.multiProvider.handleTx(chain, tx);
    }
    return {
      testRecipient,
    };
  }
}
