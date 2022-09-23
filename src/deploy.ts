import {
  ChainMap,
  ChainName,
  HyperlaneCore,
  HyperlaneRouterDeployer,
  MultiProvider,
} from '@hyperlane-xyz/sdk';

import { HypERC20Config, HypERC721Config } from './config';
import {
  HypERC20Contracts,
  HypERC20Factories,
  HypERC721Contracts,
  HypERC721Factories,
  hypERC20Factories,
  hypERC721Factories,
} from './contracts';

export class HypERC20Deployer<
  Chain extends ChainName,
> extends HyperlaneRouterDeployer<
  Chain,
  HypERC20Config,
  HypERC20Contracts,
  HypERC20Factories
> {
  constructor(
    multiProvider: MultiProvider<Chain>,
    configMap: ChainMap<Chain, HypERC20Config>,
    protected core: HyperlaneCore<Chain>,
  ) {
    super(multiProvider, configMap, hypERC20Factories);
  }

  async deployContracts(chain: Chain, config: HypERC20Config) {
    const router = await this.deployContract(chain, 'router', []);
    await router.initialize(
      config.connectionManager,
      config.interchainGasPaymaster,
      config.totalSupply,
      config.name,
      config.symbol,
    );
    return {
      router,
    };
  }
}

export class HypERC721Deployer<
  Chain extends ChainName,
> extends HyperlaneRouterDeployer<
  Chain,
  HypERC721Config,
  HypERC721Contracts,
  HypERC721Factories
> {
  constructor(
    multiProvider: MultiProvider<Chain>,
    configMap: ChainMap<Chain, HypERC721Config>,
    protected core: HyperlaneCore<Chain>,
  ) {
    super(multiProvider, configMap, hypERC721Factories);
  }

  async deployContracts(chain: Chain, config: HypERC721Config) {
    const router = await this.deployContract(chain, 'router', []);
    await router.initialize(
      config.connectionManager,
      config.interchainGasPaymaster,
      config.mintAmount,
      config.name,
      config.symbol,
    );
    return {
      router,
    };
  }
}
