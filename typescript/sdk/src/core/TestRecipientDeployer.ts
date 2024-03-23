import { TestRecipient, TestRecipient__factory } from '@hyperlane-xyz/core';
import { Address, eqAddress, rootLogger } from '@hyperlane-xyz/utils';

import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer';
import { ContractVerifier } from '../deploy/verify/ContractVerifier';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainName } from '../types';

export type TestRecipientConfig = {
  interchainSecurityModule: Address;
};

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
  ) {
    super(multiProvider, testRecipientFactories, {
      logger: rootLogger.child({ module: 'TestRecipientDeployer' }),
      contractVerifier,
    });
  }

  async deployContracts(
    chain: ChainName,
    config: TestRecipientConfig,
  ): Promise<TestRecipientContracts> {
    const predeployed = this.readCache(
      chain,
      this.factories['testRecipient'],
      'testRecipient',
    );
    let usePreviousDeployment = false;
    if (
      predeployed &&
      eqAddress(
        await predeployed.owner(),
        await this.multiProvider.getSignerAddress(chain),
      )
    ) {
      usePreviousDeployment = true;
    }
    const testRecipient = await this.deployContract(
      chain,
      'testRecipient',
      [],
      undefined,
      usePreviousDeployment,
    );
    try {
      this.logger.debug(`Checking ISM ${chain}`);
      const ism = await testRecipient.interchainSecurityModule();
      this.logger.debug(`Found ISM for on ${chain}: ${ism}`);
      if (!eqAddress(ism, config.interchainSecurityModule)) {
        this.logger.debug(
          `Current ISM does not match config. Updating to ${config.interchainSecurityModule}`,
        );
        const tx = testRecipient.setInterchainSecurityModule(
          config.interchainSecurityModule,
        );
        await this.runIfOwner(
          chain,
          testRecipient,
          async () => await this.multiProvider.handleTx(chain, tx),
        );
      }
    } catch (error) {
      this.logger.error(`Failed to check/update ISM for ${chain}: ${error}`);
      this.logger.info('Leaving ISM as is and continuing.');
    }
    return {
      testRecipient,
    };
  }
}
