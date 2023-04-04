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
    super(multiProvider, factories);
  }

  async deployContracts(chain: ChainName) {
    const deployer = await this.multiProvider.getSignerAddress(chain);
    const TestRecipient = await this.deployContract(
      chain,
      'TestRecipient',
      [],
      {
        create2Salt: 'TestRecipient-March-17-2023',
        initCalldata: new TestRecipient__factory().interface.encodeFunctionData(
          'transferOwnership',
          [deployer],
        ),
      },
    );
    const TestTokenRecipient = await this.deployContract(
      chain,
      'TestTokenRecipient',
      [],
      { create2Salt: 'TestRecipient-March-17-2023' },
    );
    return {
      TestRecipient,
      TestTokenRecipient,
    };
  }
}
