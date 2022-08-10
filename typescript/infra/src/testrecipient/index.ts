import { TestRecipient, TestRecipient__factory } from '@abacus-network/core';
import { AbacusDeployer, ChainName, MultiProvider } from '@abacus-network/sdk';

const factories = {
  TestRecipient: new TestRecipient__factory(),
};

type Contracts = {
  TestRecipient: TestRecipient;
};

export class TestRecipientDeployer<
  Chain extends ChainName,
> extends AbacusDeployer<Chain, any, Contracts, typeof factories> {
  constructor(multiProvider: MultiProvider<Chain>) {
    super(
      multiProvider,
      multiProvider.map(() => {}),
      factories,
    );
  }
  async deployContracts(chain: Chain, _config: any) {
    const TestRecipient = await this.deployContract(chain, 'TestRecipient', []);
    return {
      TestRecipient,
    };
  }
}
