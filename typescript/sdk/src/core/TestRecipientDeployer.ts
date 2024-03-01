import debug from 'debug';

import { TestRecipient__factory } from '@hyperlane-xyz/core';

import { HyperlaneContracts } from '../contracts/types';
import {
  DeployerOptions,
  HyperlaneDeployer,
} from '../deploy/HyperlaneDeployer';
import { MultiProvider } from '../providers/MultiProvider';
import { MailboxClientConfig } from '../router/types';
import { ChainName } from '../types';

export type TestRecipientConfig = Pick<
  MailboxClientConfig,
  'interchainSecurityModule'
>;

export const testRecipientFactories = {
  testRecipient: new TestRecipient__factory(),
};

type TestRecipientFactories = typeof testRecipientFactories;

type TestRecipientContracts = HyperlaneContracts<TestRecipientFactories>;

export class TestRecipientDeployer extends HyperlaneDeployer<
  TestRecipientConfig,
  TestRecipientFactories
> {
  constructor(multiProvider: MultiProvider, options?: DeployerOptions) {
    super(multiProvider, testRecipientFactories, {
      logger: debug('hyperlane:TestRecipientDeployer'),
      ...options,
    });
  }

  async deployContracts(
    chain: ChainName,
    config: TestRecipientConfig,
  ): Promise<TestRecipientContracts> {
    const testRecipient = await this.deployContract(chain, 'testRecipient', []);
    if (config.interchainSecurityModule) {
      await this.configureIsm(
        chain,
        testRecipient,
        config.interchainSecurityModule,
        (tr) => tr.interchainSecurityModule(),
        (tr, ism) => tr.populateTransaction.setInterchainSecurityModule(ism),
      );
    }
    return {
      testRecipient,
    };
  }
}
