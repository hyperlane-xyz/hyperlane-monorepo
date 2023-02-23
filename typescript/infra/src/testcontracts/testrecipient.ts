import {
  TestRecipient,
  TestRecipient__factory,
  TestTokenRecipient,
  TestTokenRecipient__factory,
} from '@hyperlane-xyz/core';
import {
  ChainName,
  HyperlaneDeployer,
  MultiProvider,
} from '@hyperlane-xyz/sdk';

export const factories = {
  TestRecipient: new TestRecipient__factory(),
  TestTokenRecipient: new TestTokenRecipient__factory(),
};

type Contracts = {
  TestRecipient: TestRecipient;
  TestTokenRecipient: TestTokenRecipient;
};

export class TestRecipientDeployer extends HyperlaneDeployer<
  any,
  Contracts,
  typeof factories
> {
  constructor(multiProvider: MultiProvider) {
    super(
      multiProvider,
      multiProvider.mapKnownChains(() => ({})),
      factories,
    );
  }
  async deployContracts(chain: ChainName) {
    const TestRecipient = await this.deployContract(
      chain,
      'TestRecipient',
      [],
      { create2Salt: 'testtest32' },
    );
    const TestTokenRecipient = await this.deployContract(
      chain,
      'TestTokenRecipient',
      [],
      { create2Salt: 'TestTokenRecipient' },
    );
    return {
      TestRecipient,
      TestTokenRecipient,
    };
  }
}
