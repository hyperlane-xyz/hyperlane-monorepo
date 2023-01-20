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

export class TestQuerySenderDeployer<
  Chain extends ChainName,
> extends HyperlaneDeployer<
  Chain,
  TestQuerySenderConfig,
  Contracts,
  typeof factories
> {
  constructor(
    multiProvider: MultiProvider<Chain>,
    queryRouters: ChainMap<Chain, TestQuerySenderConfig>,
    protected core: HyperlaneCore<Chain>,
  ) {
    super(multiProvider, queryRouters, factories);
  }
  async deployContracts(chain: Chain, config: TestQuerySenderConfig) {
    const initCalldata =
      TestQuerySender__factory.createInterface().encodeFunctionData(
        'initialize',
        [
          config.queryRouterAddress,
          this.core.getContracts(chain).baseInterchainGasPaymaster.address,
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
