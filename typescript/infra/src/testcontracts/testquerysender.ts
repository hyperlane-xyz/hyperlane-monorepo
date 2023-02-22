import { TestQuerySender, TestQuerySender__factory } from '@hyperlane-xyz/core';
import {
  ChainMap,
  ChainName,
  HyperlaneCore,
  HyperlaneDeployer,
  MultiProvider,
} from '@hyperlane-xyz/sdk';

export const factories = {
  TestQuerySender: new TestQuerySender__factory(),
};

type TestQuerySenderConfig = { queryRouterAddress: string };

type Contracts = {
  TestQuerySender: TestQuerySender;
};

export class TestQuerySenderDeployer extends HyperlaneDeployer<
  TestQuerySenderConfig,
  Contracts,
  typeof factories
> {
  constructor(
    multiProvider: MultiProvider,
    queryRouters: ChainMap<TestQuerySenderConfig>,
    protected core: HyperlaneCore,
  ) {
    super(multiProvider, queryRouters, factories);
  }
  async deployContracts(chain: ChainName, config: TestQuerySenderConfig) {
    const initCalldata =
      TestQuerySender__factory.createInterface().encodeFunctionData(
        'initialize',
        [
          config.queryRouterAddress,
          this.core.getContracts(chain).interchainGasPaymaster.address,
        ],
      );
    const TestQuerySender = await this.deployContract(
      chain,
      'TestQuerySender',
      [],
      { create2Salt: 'testtest32ss', initCalldata },
    );
    return {
      TestQuerySender,
    };
  }
}
