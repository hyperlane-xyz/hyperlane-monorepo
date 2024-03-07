/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import debug from 'debug';
import { providers } from 'ethers';

import {
  ERC20__factory,
  ERC721EnumerableUpgradeable__factory,
  HypERC20,
  HypERC20Collateral,
  HypERC721,
  HypERC721Collateral,
  HypNative,
} from '@hyperlane-xyz/core';
import { objMap } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts/types';
import { ContractVerifier } from '../deploy/verify/ContractVerifier';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory';
import { MultiProvider } from '../providers/MultiProvider';
import { GasRouterDeployer } from '../router/GasRouterDeployer';
import { GasConfig, RouterConfig } from '../router/types';
import { ChainMap, ChainName } from '../types';

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
  TokenStandard,
  getTokenType,
  isCollateralConfig,
  isErc20Metadata,
  isNativeConfig,
  isSyntheticConfig,
  isTokenMetadata,
} from './config';
import {
  HypERC20Factories,
  HypERC721Factories,
  hypERC20factories,
  hypERC721factories,
} from './contracts';

export class HypERC20Deployer extends GasRouterDeployer<
  ERC20RouterConfig,
  HypERC20Factories
> {
  constructor(
    multiProvider: MultiProvider,
    ismFactory?: HyperlaneIsmFactory,
    contractVerifier?: ContractVerifier,
  ) {
    super(multiProvider, hypERC20factories, {
      logger: debug('hyperlane:HypERC20Deployer'),
      ismFactory,
      contractVerifier,
    }); // factories not used in deploy
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
      case 'fastSynthetic':
        return 64_000;
      case 'synthetic':
        return 64_000;
      case 'native':
        return 44_000;
      case 'collateral':
      case 'fastCollateral':
      default:
        return 68_000;
    }
  }

  // Gets the metadata for a collateral token, favoring the config
  // and getting any on-chain metadata that is missing.
  async getCollateralMetadata(
    chain: ChainName,
    config: CollateralConfig,
  ): Promise<ERC20Metadata> {
    const metadata = {
      name: config.name,
      symbol: config.symbol,
      decimals: config.decimals,
      totalSupply: 0,
    };

    if (
      metadata.name &&
      metadata.symbol &&
      metadata.decimals !== undefined &&
      metadata.decimals !== null
    ) {
      return metadata as ERC20Metadata;
    }
    const fetchedMetadata = await HypERC20Deployer.fetchMetadata(
      this.multiProvider.getProvider(chain),
      config,
    );
    // Filter out undefined values
    const definedConfigMetadata = Object.fromEntries(
      Object.entries(metadata).filter(([k, v]) => !!k && !!v),
    );
    return {
      ...fetchedMetadata,
      ...definedConfigMetadata,
    } as ERC20Metadata;
  }

  protected async deployCollateral(
    chain: ChainName,
    config: HypERC20CollateralConfig,
  ): Promise<HypERC20Collateral> {
    return (await this.deployContract(
      chain,
      getTokenType(config.type, TokenStandard.ERC20),
      [config.token, config.mailbox],
    )) as HypERC20Collateral;
  }

  protected async deployNative(
    chain: ChainName,
    config: HypNativeConfig,
  ): Promise<HypNative> {
    let router: HypNative;
    if (config.scale) {
      router = (await this.deployContract(chain, 'nativescaledERC20', [
        config.scale,
        config.mailbox,
      ])) as HypNative;
    } else {
      router = (await this.deployContract(
        chain,
        getTokenType(config.type, TokenStandard.ERC20),
        [config.mailbox],
      )) as HypNative;
    }
    return router;
  }

  protected async deploySynthetic(
    chain: ChainName,
    config: HypERC20Config,
  ): Promise<HypERC20> {
    const router = (await this.deployContract(
      chain,
      getTokenType(config.type, TokenStandard.ERC20),
      [config.decimals, config.mailbox],
    )) as HypERC20;

    try {
      await this.multiProvider.handleTx(
        chain,
        router.initialize(config.totalSupply, config.name, config.symbol),
      );
    } catch (e: any) {
      if (!e.message.includes('already initialized')) {
        throw e;
      }
      this.logger(
        `${getTokenType(config.type, TokenStandard.ERC20)} already initialized`,
      );
    }
    return router;
  }

  router(contracts: HyperlaneContracts<HypERC20Factories>) {
    for (const key of Object.keys(hypERC20factories)) {
      if (contracts[key as keyof typeof contracts]) {
        return contracts[key as keyof typeof contracts];
      }
    }
    throw new Error('No matching contract found');
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
    await this.configureClient(chain, router, config);
    return { [getTokenType(config.type, TokenStandard.ERC20)]: router } as any;
  }

  async buildTokenMetadata(
    configMap: ChainMap<TokenConfig>,
  ): Promise<ChainMap<ERC20Metadata>> {
    let tokenMetadata: ERC20Metadata | undefined;

    for (const [chain, config] of Object.entries(configMap)) {
      if (isCollateralConfig(config)) {
        const collateralMetadata = await this.getCollateralMetadata(
          chain,
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
  constructor(
    multiProvider: MultiProvider,
    contractVerifier?: ContractVerifier,
  ) {
    super(multiProvider, hypERC721factories, {
      logger: debug('hyperlane:HypERC721Deployer'),
      contractVerifier,
    });
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
    return (await this.deployContract(
      chain,
      getTokenType(config.type, TokenStandard.ERC721),
      [config.token, config.mailbox],
    )) as HypERC721Collateral;
  }

  protected async deploySynthetic(
    chain: ChainName,
    config: HypERC721Config,
  ): Promise<HypERC721> {
    return (await this.deployContract(
      chain,
      getTokenType(config.type, TokenStandard.ERC721),
      [config.mailbox],
    )) as HypERC721;
  }

  router(contracts: HyperlaneContracts<HypERC721Factories>) {
    for (const key of Object.keys(hypERC721factories)) {
      if (contracts[key as keyof typeof contracts]) {
        return contracts[key as keyof typeof contracts];
      }
    }
    throw new Error('No matching contract found');
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
    return { [getTokenType(config.type, TokenStandard.ERC721)]: router } as any;
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
