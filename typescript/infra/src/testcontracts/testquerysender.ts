import { TestQuerySender__factory } from '@hyperlane-xyz/core';
import {
  ChainMap,
  ChainName,
  HyperlaneDeployer,
  HyperlaneIgp,
  MultiProvider,
} from '@hyperlane-xyz/sdk';

export const factories = {
  TestQuerySender: new TestQuerySender__factory(),
};

type TestQuerySenderConfig = { queryRouterAddress: string };

export class TestQuerySenderDeployer extends HyperlaneDeployer<
  TestQuerySenderConfig,
  typeof factories
> {
  constructor(
    multiProvider: MultiProvider,
    queryRouters: ChainMap<TestQuerySenderConfig>,
    protected igp: HyperlaneIgp,
  ) {
    super(multiProvider, queryRouters, factories);
  }
  async deployContracts(chain: ChainName, config: TestQuerySenderConfig) {
    const TestQuerySender = await this.deployContract(
      chain,
      'TestQuerySender',
      [],
      [
        config.queryRouterAddress,
        this.igp.getContracts(chain).interchainGasPaymaster.address,
      ],
    );
    return {
      TestQuerySender,
    };
  }
}
