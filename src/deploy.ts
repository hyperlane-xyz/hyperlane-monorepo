import {
  ChainMap,
  ChainName,
  GasRouterDeployer,
  MultiProvider,
  objMap
} from '@hyperlane-xyz/sdk';
import { DeployerOptions } from '@hyperlane-xyz/sdk/dist/deploy/HyperlaneDeployer';

import {
  HypERC20CollateralConfig,
  HypERC20Config,
  HypERC721Config,
  isCollateralConfig,
  HypERC721CollateralConfig,
  isUriConfig,
  TokenConfig,
} from './config';
import {
  HypERC20Contracts,
  HypERC721Contracts,
} from './contracts';
import { HypERC20Collateral__factory, HypERC20__factory, HypERC721Collateral__factory, HypERC721URICollateral__factory, HypERC721URIStorage__factory, HypERC721__factory } from './types';

enum TokenType {
  erc20 = 'erc20',
  erc721 = 'erc721',
}

const gasDefaults = (config: TokenConfig, tokenType: TokenType) => {
  switch (tokenType) {
    case TokenType.erc721:
      switch (config.type) {
        case 'synthetic':
          return 156000;
        case 'syntheticUri':
          return 160000;
        case 'collateral':
        case 'collateralUri':
        default:
          return 77000;
      }
    default:
    case TokenType.erc20: 
      switch (config.type) {
        case 'synthetic':
          return 64000;
        case 'collateral':
        default:
          return 68000;
      }
  }
}

type Optional<T, K extends keyof T> = Pick<Partial<T>, K> & Omit<T, K>;

export class HypERC20Deployer<
  Chain extends ChainName // inferred from configured chains passed to constructor
> extends GasRouterDeployer<
  Chain,
  HypERC20Config | HypERC20CollateralConfig,
  HypERC20Contracts,
  any // RouterFactories doesn't work well when router has multiple types
> {
  constructor(multiProvider: MultiProvider<Chain>, configMap: ChainMap<Chain, Optional<HypERC20Config | HypERC20CollateralConfig, 'gas'>>, factories: any, options?: DeployerOptions) {
    super(multiProvider, objMap(configMap, (_, config): HypERC20Config | HypERC20CollateralConfig => ({
      ...config,
      gas: config.gas ?? gasDefaults(config as any, TokenType.erc20)
    } as HypERC20Config | HypERC20CollateralConfig)), factories, options);
  }

  async deployContracts(
    chain: Chain,
    config: HypERC20Config | HypERC20CollateralConfig,
  ) {
    const connection = this.multiProvider.getChainConnection(chain);
    if (isCollateralConfig(config)) {
      const router = await this.deployContractFromFactory(
        chain,
        new HypERC20Collateral__factory(),
        'HypERC20Collateral',
        [config.token],
      );
      await connection.handleTx(
        router.initialize(
          config.mailbox,
          config.interchainGasPaymaster,
        ),
      );
      return { router };
    } else {
      const router = await this.deployContractFromFactory(
        chain,
        new HypERC20__factory(),
        'HypERC20',
        [],
      );
      await connection.handleTx(router.initialize(
        config.mailbox,
        config.interchainGasPaymaster,
        config.totalSupply,
        config.name,
        config.symbol,
      ));
      return { router };
    }
  }
}

// TODO: dedupe?
export class HypERC721Deployer<
  Chain extends ChainName
> extends GasRouterDeployer<
  Chain,
  HypERC721Config | HypERC721CollateralConfig,
  HypERC721Contracts,
  any
> {
  constructor(multiProvider: MultiProvider<Chain>, configMap: ChainMap<Chain, Optional<HypERC721Config | HypERC721CollateralConfig, 'gas'>>, factories: any, options?: DeployerOptions) {
    super(multiProvider, objMap(configMap, (_, config): HypERC721Config | HypERC721CollateralConfig => ({
      ...config,
      gas: config.gas ?? gasDefaults(config as any, TokenType.erc721)
    } as HypERC721Config | HypERC721CollateralConfig)), factories, options);
  }

  async deployContracts(
    chain: Chain,
    config: HypERC721Config | HypERC721CollateralConfig,
  ) {
    const connection = this.multiProvider.getChainConnection(chain);
    if (isCollateralConfig(config)) {
      const router = await this.deployContractFromFactory(
        chain,
        isUriConfig(config) ? new HypERC721URICollateral__factory() : new HypERC721Collateral__factory(),
        `HypERC721${isUriConfig(config) ? 'URI' : ''}Collateral`,
        [config.token],
      );
      await connection.handleTx(
        router.initialize(
          config.mailbox,
          config.interchainGasPaymaster,
        ),
      );
      return { router };
    } else {
      const router = await this.deployContractFromFactory(
        chain,
        isUriConfig(config) ? new HypERC721URIStorage__factory() : new HypERC721__factory(),
        `HypERC721${isUriConfig(config) ? 'URIStorage' : ''}`,
        [],
      );
      await connection.handleTx(router.initialize(
        config.mailbox,
        config.interchainGasPaymaster,
        config.totalSupply,
        config.name,
        config.symbol,
      ));
      return { router };
    }
  }
}
