import {
  ChainMap,
  ChainName,
  GasRouterConfig,
  GasRouterDeployer,
  MultiProvider,
  objMap
} from '@hyperlane-xyz/sdk';
import { DeployerOptions } from '@hyperlane-xyz/sdk/dist/deploy/HyperlaneDeployer';

import {
  HypERC20Config,
  HypERC721Config,
  isCollateralConfig,
  isNativeConfig,
  isSyntheticConfig,
  isUriConfig,
  TokenConfig,
} from './config';
import { HypERC20Contracts, HypERC721Contracts } from './contracts';
import {
  HypERC20Collateral__factory,
  HypERC20__factory,
  HypERC721Collateral__factory,
  HypERC721URICollateral__factory,
  HypERC721URIStorage__factory,
  HypERC721__factory,
  HypNative__factory,
} from './types';

enum TokenType {
  erc20 = 'erc20',
  erc721 = 'erc721',
}

const gasDefaults = (config: TokenConfig, tokenType: TokenType) => {
  switch (tokenType) {
    case TokenType.erc721:
      switch (config.type) {
        case 'synthetic':
          return 160_000;
        case 'syntheticUri':
          return 163_000;
        case 'collateral':
        case 'collateralUri':
        default:
          return 80_000;
      }
    default:
    case TokenType.erc20: 
      switch (config.type) {
        case 'synthetic':
          return 64_000;
        case 'native':
          return 44_000;
        case 'collateral':
        default:
          return 68_000;
      }
  }
}

export class HypERC20Deployer<
  Chain extends ChainName // inferred from configured chains passed to constructor
> extends GasRouterDeployer<
  Chain,
  HypERC20Config & GasRouterConfig,
  HypERC20Contracts,
  any // RouterFactories doesn't work well when router has multiple types
> {
  constructor(multiProvider: MultiProvider<Chain>, configMap: ChainMap<Chain, HypERC20Config>, factories: any, options?: DeployerOptions) {
    super(multiProvider, objMap(configMap, (_, config): HypERC20Config & GasRouterConfig => ({
      ...config,
      gas: config.gas ?? gasDefaults(config, TokenType.erc20)
    } as HypERC20Config & GasRouterConfig)), factories, options);
  }

  async deployContracts(
    chain: Chain,
    config: HypERC20Config,
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
        router.initialize(config.mailbox, config.interchainGasPaymaster),
      );
      return { router };
    } else if (isSyntheticConfig(config)) {
      const router = await this.deployContractFromFactory(
        chain,
        new HypERC20__factory(),
        'HypERC20',
        [],
      );
      
      await connection.handleTx(
        router.initialize(
          config.mailbox,
          config.interchainGasPaymaster,
          config.totalSupply,
          config.name,
          config.symbol,
        ),
      );
      return { router };
    } else if (isNativeConfig(config)) {
      const router = await this.deployContractFromFactory(
        chain,
        new HypNative__factory(),
        'HypNative',
        [],
      );
      await connection.handleTx(
        router.initialize(config.mailbox, config.interchainGasPaymaster),
      );
      return { router };
    }
    throw new Error('Invalid config');
  }
}

// TODO: dedupe?
export class HypERC721Deployer<
  Chain extends ChainName
> extends GasRouterDeployer<
  Chain,
  HypERC721Config & GasRouterConfig,
  HypERC721Contracts,
  any
> {
  constructor(multiProvider: MultiProvider<Chain>, configMap: ChainMap<Chain, HypERC721Config>, factories: any, options?: DeployerOptions) {
    super(multiProvider, objMap(configMap, (_, config): HypERC721Config & GasRouterConfig => ({
      ...config,
      gas: config.gas ?? gasDefaults(config, TokenType.erc721)
    } as HypERC721Config & GasRouterConfig)), factories, options);
  }

  async deployContracts(
    chain: Chain,
    config: HypERC721Config,
  ) {
    const connection = this.multiProvider.getChainConnection(chain);
    if (isCollateralConfig(config)) {
      const router = await this.deployContractFromFactory(
        chain,
        isUriConfig(config)
          ? new HypERC721URICollateral__factory()
          : new HypERC721Collateral__factory(),
        `HypERC721${isUriConfig(config) ? 'URI' : ''}Collateral`,
        [config.token],
      );
      await connection.handleTx(
        router.initialize(config.mailbox, config.interchainGasPaymaster),
      );
      return { router };
    } else if (isSyntheticConfig(config)) {
      const router = await this.deployContractFromFactory(
        chain,
        isUriConfig(config)
          ? new HypERC721URIStorage__factory()
          : new HypERC721__factory(),
        `HypERC721${isUriConfig(config) ? 'URIStorage' : ''}`,
        [],
      );
      await connection.handleTx(
        router.initialize(
          config.mailbox,
          config.interchainGasPaymaster,
          config.totalSupply,
          config.name,
          config.symbol,
        ),
      );
      return { router };
    }
    throw new Error('Invalid config');
  }
}
