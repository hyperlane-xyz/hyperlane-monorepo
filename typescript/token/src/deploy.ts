import { providers } from 'ethers';

import {
  ChainMap,
  ChainName,
  GasRouterDeployer,
  HyperlaneContracts,
  MultiProvider,
  objMap,
} from '@hyperlane-xyz/sdk';
import { GasConfig, RouterConfig } from '@hyperlane-xyz/sdk/dist/router/types';

import {
  CollateralConfig,
  ERC20Metadata,
  ERC20RouterConfig,
  ERC721RouterConfig,
  HypERC20CollateralConfig,
  HypERC20Config,
  HypERC721CollateralConfig,
  HypERC721Config,
  HypNativeConfig,
  TokenConfig,
  TokenMetadata,
  isCollateralConfig,
  isErc20Metadata,
  isNativeConfig,
  isSyntheticConfig,
  isTokenMetadata,
  isUriConfig,
} from './config';
import { HypERC20Factories, HypERC721Factories } from './contracts';
import {
  ERC20__factory,
  ERC721EnumerableUpgradeable__factory,
  HypERC20,
  HypERC20Collateral,
  HypERC20Collateral__factory,
  HypERC20__factory,
  HypERC721,
  HypERC721Collateral,
  HypERC721Collateral__factory,
  HypERC721URICollateral__factory,
  HypERC721URIStorage__factory,
  HypERC721__factory,
  HypNative,
  HypNative__factory,
} from './types';

export class HypERC20Deployer extends GasRouterDeployer<
  ERC20RouterConfig,
  HypERC20Factories
> {
  constructor(multiProvider: MultiProvider) {
    super(multiProvider, {} as HypERC20Factories); // factories not used in deploy
  }

  static async fetchMetadata(
    provider: providers.Provider,
    config: CollateralConfig,
  ): Promise<ERC20Metadata> {
    const erc20 = ERC20__factory.connect(config.token, provider);

    const [name, symbol, totalSupply, decimals] = await Promise.all([
      erc20.name(),
      erc20.symbol(),
      erc20.totalSupply(),
      erc20.decimals(),
    ]);

    return { name, symbol, totalSupply, decimals };
  }

  static gasOverheadDefault(config: TokenConfig): number {
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

  protected async deployCollateral(
    chain: ChainName,
    config: HypERC20CollateralConfig,
  ): Promise<HypERC20Collateral> {
    const router = await this.deployContractFromFactory(
      chain,
      new HypERC20Collateral__factory(),
      'HypERC20Collateral',
      [config.token],
    );
    await this.multiProvider.handleTx(
      chain,
      router.initialize(config.mailbox, config.interchainGasPaymaster),
    );
    return router;
  }

  protected async deployNative(
    chain: ChainName,
    config: HypNativeConfig,
  ): Promise<HypNative> {
    const router = await this.deployContractFromFactory(
      chain,
      new HypNative__factory(),
      'HypNative',
      [],
    );
    await this.multiProvider.handleTx(
      chain,
      router.initialize(config.mailbox, config.interchainGasPaymaster),
    );
    return router;
  }

  protected async deploySynthetic(
    chain: ChainName,
    config: HypERC20Config,
  ): Promise<HypERC20> {
    const router = await this.deployContractFromFactory(
      chain,
      new HypERC20__factory(),
      'HypERC20',
      [config.decimals],
    );
    await this.multiProvider.handleTx(
      chain,
      router.initialize(
        config.mailbox,
        config.interchainGasPaymaster,
        config.totalSupply,
        config.name,
        config.symbol,
      ),
    );
    return router;
  }

  router(contracts: HyperlaneContracts<HypERC20Factories>) {
    return contracts.router;
  }

  async deployContracts(chain: ChainName, config: HypERC20Config) {
    let router: HypERC20 | HypERC20Collateral | HypNative;
    if (isCollateralConfig(config)) {
      router = await this.deployCollateral(chain, config);
    } else if (isNativeConfig(config)) {
      router = await this.deployNative(chain, config);
    } else if (isSyntheticConfig(config)) {
      router = await this.deploySynthetic(chain, config);
    } else {
      throw new Error('Invalid ERC20 token router config');
    }
    return { router };
  }

  async buildTokenMetadata(
    configMap: ChainMap<TokenConfig>,
  ): Promise<ChainMap<ERC20Metadata>> {
    let tokenMetadata: ERC20Metadata | undefined;

    for (const [chain, config] of Object.entries(configMap)) {
      if (isCollateralConfig(config)) {
        const collateralMetadata = await HypERC20Deployer.fetchMetadata(
          this.multiProvider.getProvider(chain),
          config,
        );
        tokenMetadata = {
          ...collateralMetadata,
          totalSupply: 0,
        };
      } else if (isNativeConfig(config)) {
        const chainMetadata = this.multiProvider.getChainMetadata(chain);
        if (chainMetadata.nativeToken) {
          tokenMetadata = {
            ...chainMetadata.nativeToken,
            totalSupply: 0,
          };
        } else {
          throw new Error(
            `Warp route config specifies native token but chain metadata for ${chain} does not provide native token details`,
          );
        }
      } else if (isErc20Metadata(config)) {
        tokenMetadata = config;
      }
    }

    if (!isErc20Metadata(tokenMetadata)) {
      throw new Error('Invalid ERC20 token metadata');
    }

    return objMap(configMap, () => tokenMetadata!);
  }

  buildGasOverhead(configMap: ChainMap<TokenConfig>): ChainMap<GasConfig> {
    return objMap(configMap, (_, config) => ({
      gas: HypERC20Deployer.gasOverheadDefault(config),
    }));
  }

  async deploy(configMap: ChainMap<TokenConfig & RouterConfig>) {
    const tokenMetadata = await this.buildTokenMetadata(configMap);
    const gasOverhead = this.buildGasOverhead(configMap);
    const mergedConfig = objMap(configMap, (chain, config) => {
      return {
        ...tokenMetadata[chain],
        ...gasOverhead[chain],
        ...config,
      };
    }) as ChainMap<ERC20RouterConfig>;

    return super.deploy(mergedConfig);
  }
}

export class HypERC721Deployer extends GasRouterDeployer<
  ERC721RouterConfig,
  HypERC721Factories
> {
  constructor(multiProvider: MultiProvider) {
    super(multiProvider, {} as HypERC721Factories); // factories not used in deploy
  }

  static async fetchMetadata(
    provider: providers.Provider,
    config: CollateralConfig,
  ): Promise<TokenMetadata> {
    const erc721 = ERC721EnumerableUpgradeable__factory.connect(
      config.token,
      provider,
    );
    const [name, symbol, totalSupply] = await Promise.all([
      erc721.name(),
      erc721.symbol(),
      erc721.totalSupply(),
    ]);

    return { name, symbol, totalSupply };
  }

  static gasOverheadDefault(config: TokenConfig): number {
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
  }

  protected async deployCollateral(
    chain: ChainName,
    config: HypERC721CollateralConfig,
  ): Promise<HypERC721Collateral> {
    let router: HypERC721Collateral;
    if (isUriConfig(config)) {
      router = await this.deployContractFromFactory(
        chain,
        new HypERC721URICollateral__factory(),
        'HypERC721URICollateral',
        [config.token],
      );
    } else {
      router = await this.deployContractFromFactory(
        chain,
        new HypERC721Collateral__factory(),
        'HypERC721Collateral',
        [config.token],
      );
    }
    await this.multiProvider.handleTx(
      chain,
      router.initialize(config.mailbox, config.interchainGasPaymaster),
    );
    return router;
  }

  protected async deploySynthetic(
    chain: ChainName,
    config: HypERC721Config,
  ): Promise<HypERC721> {
    let router: HypERC721;
    if (isUriConfig(config)) {
      router = await this.deployContractFromFactory(
        chain,
        new HypERC721URIStorage__factory(),
        'HypERC721URIStorage',
        [],
      );
    } else {
      router = await this.deployContractFromFactory(
        chain,
        new HypERC721__factory(),
        'HypERC721',
        [],
      );
    }
    await this.multiProvider.handleTx(
      chain,
      router.initialize(
        config.mailbox,
        config.interchainGasPaymaster,
        config.totalSupply,
        config.name,
        config.symbol,
      ),
    );
    return router;
  }

  router(contracts: HyperlaneContracts<HypERC721Factories>) {
    return contracts.router;
  }

  async deployContracts(chain: ChainName, config: HypERC721Config) {
    let router: HypERC721 | HypERC721Collateral;
    if (isCollateralConfig(config)) {
      router = await this.deployCollateral(chain, config);
    } else if (isSyntheticConfig(config)) {
      router = await this.deploySynthetic(chain, config);
    } else {
      throw new Error('Invalid ERC721 token router config');
    }
    return { router };
  }

  async buildTokenMetadata(
    configMap: ChainMap<TokenConfig>,
  ): Promise<ChainMap<TokenMetadata>> {
    let tokenMetadata: TokenMetadata | undefined;

    for (const [chain, config] of Object.entries(configMap)) {
      if (isCollateralConfig(config)) {
        const collateralMetadata = await HypERC721Deployer.fetchMetadata(
          this.multiProvider.getProvider(chain),
          config,
        );
        tokenMetadata = {
          ...collateralMetadata,
          totalSupply: 0,
        };
      } else if (isTokenMetadata(config)) {
        tokenMetadata = config;
      }
    }

    if (!isTokenMetadata(tokenMetadata)) {
      throw new Error('Invalid ERC721 token metadata');
    }

    return objMap(configMap, () => tokenMetadata!);
  }

  buildGasOverhead(configMap: ChainMap<TokenConfig>): ChainMap<GasConfig> {
    return objMap(configMap, (_, config) => ({
      gas: HypERC721Deployer.gasOverheadDefault(config),
    }));
  }

  async deploy(configMap: ChainMap<TokenConfig & RouterConfig>) {
    const tokenMetadata = await this.buildTokenMetadata(configMap);
    const gasOverhead = this.buildGasOverhead(configMap);
    const mergedConfig = objMap(configMap, (chain, config) => {
      return {
        ...tokenMetadata[chain],
        ...gasOverhead[chain],
        ...config,
      };
    }) as ChainMap<ERC721RouterConfig>;

    return super.deploy(mergedConfig);
  }
}
