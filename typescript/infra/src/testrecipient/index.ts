import { TestRecipient, TestRecipient__factory } from '@hyperlane-xyz/core';
import {
  ChainName,
  HyperlaneDeployer,
  MultiProvider,
} from '@hyperlane-xyz/sdk';

export const factories = {
  TestRecipient: new TestRecipient__factory(),
};

type Contracts = {
  TestRecipient: TestRecipient;
};

export class TestRecipientDeployer<
  Chain extends ChainName,
> extends HyperlaneDeployer<Chain, any, Contracts, typeof factories> {
  constructor(multiProvider: MultiProvider<Chain>) {
    super(
      multiProvider,
      multiProvider.map(() => ({})),
      factories,
    );
  }
  async deployContracts(chain: Chain) {
    const TestRecipient = await this.deployContract(
      chain,
      'TestRecipient',
      [],
      { create2Salt: 'testtest32' },
    );
    return {
      TestRecipient,
    };
  }
}
