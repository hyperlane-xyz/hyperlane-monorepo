import { Create2Factory, Create2Factory__factory } from '@hyperlane-xyz/core';
import {
  ChainName,
  HyperlaneDeployer,
  MultiProvider,
} from '@hyperlane-xyz/sdk';

export const factories = {
  Create2Factory: new Create2Factory__factory(),
};

type Contracts = {
  Create2Factory: Create2Factory;
};

export class Create2FactoryDeployer<
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
    const Create2Factory = await this.deployContract(
      chain,
      'Create2Factory',
      [],
    );
    return {
      Create2Factory,
    };
  }
}
