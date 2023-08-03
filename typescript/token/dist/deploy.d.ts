import { providers } from 'ethers';

import {
  ChainMap,
  ChainName,
  GasConfig,
  GasRouterDeployer,
  HyperlaneContracts,
  MultiProvider,
  RouterConfig,
} from '@hyperlane-xyz/sdk';

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
} from './config';
import { HypERC20Factories, HypERC721Factories } from './contracts';
import {
  HypERC20,
  HypERC20Collateral,
  HypERC721,
  HypERC721Collateral,
  HypNative,
} from './types';

export declare class HypERC20Deployer extends GasRouterDeployer<
  ERC20RouterConfig,
  HypERC20Factories
> {
  constructor(multiProvider: MultiProvider);
  static fetchMetadata(
    provider: providers.Provider,
    config: CollateralConfig,
  ): Promise<ERC20Metadata>;
  static gasOverheadDefault(config: TokenConfig): number;
  getCollateralMetadata(
    chain: ChainName,
    config: CollateralConfig,
  ): Promise<ERC20Metadata>;
  protected deployCollateral(
    chain: ChainName,
    config: HypERC20CollateralConfig,
  ): Promise<HypERC20Collateral>;
  protected deployNative(
    chain: ChainName,
    config: HypNativeConfig,
  ): Promise<HypNative>;
  protected deploySynthetic(
    chain: ChainName,
    config: HypERC20Config,
  ): Promise<HypERC20>;
  router(
    contracts: HyperlaneContracts<HypERC20Factories>,
  ): HypERC20 | HypERC20Collateral | HypNative;
  deployContracts(
    chain: ChainName,
    config: HypERC20Config,
  ): Promise<{
    router: HypERC20 | HypERC20Collateral | HypNative;
  }>;
  buildTokenMetadata(
    configMap: ChainMap<TokenConfig>,
  ): Promise<ChainMap<ERC20Metadata>>;
  buildGasOverhead(configMap: ChainMap<TokenConfig>): ChainMap<GasConfig>;
  deploy(
    configMap: ChainMap<TokenConfig & RouterConfig>,
  ): Promise<
    import('@hyperlane-xyz/sdk').HyperlaneContractsMap<HypERC20Factories>
  >;
}
export declare class HypERC721Deployer extends GasRouterDeployer<
  ERC721RouterConfig,
  HypERC721Factories
> {
  constructor(multiProvider: MultiProvider);
  static fetchMetadata(
    provider: providers.Provider,
    config: CollateralConfig,
  ): Promise<TokenMetadata>;
  static gasOverheadDefault(config: TokenConfig): number;
  protected deployCollateral(
    chain: ChainName,
    config: HypERC721CollateralConfig,
  ): Promise<HypERC721Collateral>;
  protected deploySynthetic(
    chain: ChainName,
    config: HypERC721Config,
  ): Promise<HypERC721>;
  router(
    contracts: HyperlaneContracts<HypERC721Factories>,
  ): import('./types').HypERC721URICollateral | HypERC721 | HypERC721Collateral;
  deployContracts(
    chain: ChainName,
    config: HypERC721Config,
  ): Promise<{
    router: HypERC721 | HypERC721Collateral;
  }>;
  buildTokenMetadata(
    configMap: ChainMap<TokenConfig>,
  ): Promise<ChainMap<TokenMetadata>>;
  buildGasOverhead(configMap: ChainMap<TokenConfig>): ChainMap<GasConfig>;
  deploy(
    configMap: ChainMap<TokenConfig & RouterConfig>,
  ): Promise<
    import('@hyperlane-xyz/sdk').HyperlaneContractsMap<HypERC721Factories>
  >;
}
//# sourceMappingURL=deploy.d.ts.map
