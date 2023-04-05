import {
  TestRecipient__factory,
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

export class TestRecipientDeployer extends HyperlaneDeployer<
  any,
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
    const TestRecipient = await this.deployContract(chain, 'TestRecipient', []);
    const TestTokenRecipient = await this.deployContract(
      chain,
      'TestTokenRecipient',
      [],
    );
    return {
      TestRecipient,
      TestTokenRecipient,
    };
  }
}
