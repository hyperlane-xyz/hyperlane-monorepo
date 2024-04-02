/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { constants, providers } from 'ethers';

import {
  ERC20__factory,
  ERC721EnumerableUpgradeable__factory,
  GasRouter,
  MailboxClient,
} from '@hyperlane-xyz/core';
import { objKeys, objMap, rootLogger } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts/types.js';
import { ContractVerifier } from '../deploy/verify/ContractVerifier.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { GasRouterDeployer } from '../router/GasRouterDeployer.js';
import { GasConfig, RouterConfig } from '../router/types.js';
import { ChainMap, ChainName } from '../types.js';

import {
  CollateralConfig,
  ERC20Metadata,
  ERC20RouterConfig,
  ERC721RouterConfig,
  HypERC20Config,
  HypERC721Config,
  TokenConfig,
  TokenMetadata,
  TokenType,
  isCollateralConfig,
  isCollateralVaultConfig,
  isErc20Metadata,
  isFastConfig,
  isNativeConfig,
  isSyntheticConfig,
  isTokenMetadata,
  isUriConfig,
} from './config.js';
import {
  HypERC20Factories,
  HypERC721Factories,
  HypERC721contracts,
  hypERC20contracts,
  hypERC20factories,
  hypERC721contracts,
  hypERC721factories,
} from './contracts.js';

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
      logger: rootLogger.child({ module: 'HypERC20Deployer' }),
      ismFactory,
      contractVerifier,
    }); // factories not used in deploy
  }

  routerContractName(config: ERC20RouterConfig): string {
    return hypERC20contracts[this.routerContractKey(config)];
  }

  routerContractKey(config: ERC20RouterConfig) {
    if (isCollateralConfig(config)) {
      if (isFastConfig(config)) {
        return TokenType.fastCollateral;
      } else if (isCollateralVaultConfig(config)) {
        return TokenType.collateralVault;
      } else {
        return TokenType.collateral;
      }
    } else if (isNativeConfig(config)) {
      return config.scale ? TokenType.nativeScaled : TokenType.native;
    } else if (isSyntheticConfig(config)) {
      return isFastConfig(config)
        ? TokenType.fastSynthetic
        : TokenType.synthetic;
    } else {
      throw new Error('Unknown collateral type when constructing router name');
    }
  }

  async constructorArgs<K extends keyof HypERC20Factories>(
    _: ChainName,
    config: ERC20RouterConfig,
  ): Promise<Parameters<HypERC20Factories[K]['deploy']>> {
    if (isCollateralConfig(config)) {
      return [config.token, config.mailbox] as any;
    } else if (isNativeConfig(config)) {
      return config.scale
        ? [config.scale, config.mailbox]
        : ([config.mailbox] as any);
    } else if (isSyntheticConfig(config)) {
      return [config.decimals, config.mailbox] as any;
    } else {
      throw new Error('Unknown collateral type when constructing arguments');
    }
  }

  async initializeArgs(_: ChainName, config: HypERC20Config): Promise<any> {
    // ISM config can be an object, but is not supported right now
    if (typeof config.interchainSecurityModule === 'object') {
      throw new Error('Token deployer does not support ISM objects currently');
    }
    const defaultArgs = [
      config.hook ?? constants.AddressZero,
      config.interchainSecurityModule ?? constants.AddressZero,
      config.owner,
    ];
    if (isCollateralConfig(config)) {
      return defaultArgs as any;
    } else if (isNativeConfig(config)) {
      return defaultArgs as any;
    } else if (isSyntheticConfig(config)) {
      return [
        config.totalSupply,
        config.name,
        config.symbol,
        ...defaultArgs,
      ] as any;
    } else {
      throw new Error('Unknown collateral type when initializing arguments');
    }
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

  router(contracts: HyperlaneContracts<HypERC20Factories>) {
    for (const key of objKeys(hypERC20factories)) {
      if (contracts[key]) {
        return contracts[key] as GasRouter;
      }
    }
    throw new Error('No matching contract found');
  }

  async deployContracts(chain: ChainName, config: HypERC20Config) {
    const { [this.routerContractKey(config)]: router } =
      await super.deployContracts(chain, config);

    await this.configureClient(chain, router as MailboxClient, config);
    return { [config.type]: router } as any;
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
      logger: rootLogger.child({ module: 'HypERC721Deployer' }),
      contractVerifier,
    });
  }
  routerContractName(config: ERC721RouterConfig): string {
    return hypERC721contracts[this.routerContractKey(config)];
  }

  routerContractKey<K extends keyof HypERC721contracts>(
    config: ERC721RouterConfig,
  ): K {
    if (isCollateralConfig(config)) {
      return (
        isUriConfig(config) ? TokenType.collateralUri : TokenType.collateral
      ) as K;
    } else {
      // if isSyntheticConfig
      return (
        isUriConfig(config) ? TokenType.syntheticUri : TokenType.synthetic
      ) as K;
    }
  }

  async constructorArgs(
    _: ChainName,
    config: ERC721RouterConfig,
  ): Promise<any> {
    if (isCollateralConfig(config)) {
      return [config.token, config.mailbox];
    } else if (isSyntheticConfig(config)) {
      return [config.mailbox];
    } else {
      throw new Error('Unknown collateral type when constructing arguments');
    }
  }

  async initializeArgs(_: ChainName, config: ERC721RouterConfig): Promise<any> {
    const defaultArgs = [
      config.hook ?? constants.AddressZero,
      config.interchainSecurityModule ?? constants.AddressZero,
      config.owner,
    ];
    if (isCollateralConfig(config)) {
      return defaultArgs;
    } else if (isSyntheticConfig(config)) {
      return [config.totalSupply, config.name, config.symbol, ...defaultArgs];
    } else {
      throw new Error('Unknown collateral type when initializing arguments');
    }
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

  router(contracts: HyperlaneContracts<HypERC721Factories>) {
    for (const key of objKeys(hypERC721factories)) {
      if (contracts[key]) {
        return contracts[key] as GasRouter;
      }
    }
    throw new Error('No matching contract found');
  }

  async deployContracts(chain: ChainName, config: HypERC721Config) {
    const { [this.routerContractKey(config)]: router } =
      await super.deployContracts(chain, config);

    await this.configureClient(chain, router as MailboxClient, config);
    return { [config.type]: router } as any;
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
