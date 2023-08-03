import { ethers } from 'ethers';

import { GasRouterConfig } from '@hyperlane-xyz/sdk';

export declare enum TokenType {
  synthetic = 'synthetic',
  syntheticUri = 'syntheticUri',
  collateral = 'collateral',
  collateralUri = 'collateralUri',
  native = 'native',
}
export declare type TokenMetadata = {
  name: string;
  symbol: string;
  totalSupply: ethers.BigNumberish;
};
export declare type ERC20Metadata = TokenMetadata & {
  decimals: number;
};
export declare const isTokenMetadata: (
  metadata: any,
) => metadata is TokenMetadata;
export declare const isErc20Metadata: (
  metadata: any,
) => metadata is ERC20Metadata;
export declare type SyntheticConfig = TokenMetadata & {
  type: TokenType.synthetic | TokenType.syntheticUri;
};
export declare type CollateralConfig = {
  type: TokenType.collateral | TokenType.collateralUri;
  token: string;
} & Partial<ERC20Metadata>;
export declare type NativeConfig = {
  type: TokenType.native;
};
export declare type TokenConfig =
  | SyntheticConfig
  | CollateralConfig
  | NativeConfig;
export declare const isCollateralConfig: (
  config: TokenConfig,
) => config is CollateralConfig;
export declare const isSyntheticConfig: (
  config: TokenConfig,
) => config is SyntheticConfig;
export declare const isNativeConfig: (
  config: TokenConfig,
) => config is NativeConfig;
export declare const isUriConfig: (config: TokenConfig) => boolean;
export declare type HypERC20Config = GasRouterConfig &
  SyntheticConfig &
  ERC20Metadata;
export declare type HypERC20CollateralConfig = GasRouterConfig &
  CollateralConfig;
export declare type HypNativeConfig = GasRouterConfig & NativeConfig;
export declare type ERC20RouterConfig =
  | HypERC20Config
  | HypERC20CollateralConfig
  | HypNativeConfig;
export declare type HypERC721Config = GasRouterConfig & SyntheticConfig;
export declare type HypERC721CollateralConfig = GasRouterConfig &
  CollateralConfig;
export declare type ERC721RouterConfig =
  | HypERC721Config
  | HypERC721CollateralConfig;
//# sourceMappingURL=config.d.ts.map
