import debug from 'debug';
import { ethers } from 'ethers';

import { TestRecipient, TestRecipient__factory } from '@hyperlane-xyz/core';
import { Address } from '@hyperlane-xyz/utils';

import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer';
import { ContractVerifier } from '../deploy/verify/ContractVerifier';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory';
import { MultiProvider } from '../providers/MultiProvider';
import { MailboxClientConfig } from '../router/types';
import { ChainName } from '../types';

export type TestRecipientConfig = Pick<
  MailboxClientConfig,
  'interchainSecurityModule'
>;

export type TestRecipientContracts = {
  testRecipient: TestRecipient;
};

export type TestRecipientAddresses = {
  testRecipient: Address;
};

export const testRecipientFactories = {
  testRecipient: new TestRecipient__factory(),
};

// TODO move this and related configs to the SDK
export class TestRecipientDeployer extends HyperlaneDeployer<
  TestRecipientConfig,
  typeof testRecipientFactories
> {
  constructor(
    multiProvider: MultiProvider,
    contractVerifier?: ContractVerifier,
    ismFactory?: HyperlaneIsmFactory,
  ) {
    super(multiProvider, testRecipientFactories, {
      logger: debug('hyperlane:TestRecipientDeployer'),
      contractVerifier,
      ismFactory,
    });
  }

  async deployContracts(
    chain: ChainName,
    config: TestRecipientConfig,
  ): Promise<TestRecipientContracts> {
    const testRecipient = await this.deployContract(chain, 'testRecipient', []);
    await this.configureIsm(
      chain,
      testRecipient,
      config.interchainSecurityModule ?? ethers.constants.AddressZero,
      (tr) => tr.interchainSecurityModule(),
      (tr, ism) => tr.populateTransaction.setInterchainSecurityModule(ism),
    );
    return {
      testRecipient,
    };
  }
}
