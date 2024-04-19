import { ethers } from 'ethers';

import { GasRouterConfig } from '../router/types.js';

export enum TokenType {
  synthetic = 'synthetic',
  fastSynthetic = 'fastSynthetic',
  syntheticUri = 'syntheticUri',
  collateral = 'collateral',
  collateralVault = 'collateralVault',
  fastCollateral = 'fastCollateral',
  collateralUri = 'collateralUri',
  native = 'native',
  nativeScaled = 'nativeScaled',
}

export type TokenMetadata = {
  name: string;
  symbol: string;
  totalSupply: ethers.BigNumberish;
};

export type TokenDecimals = {
  decimals: number;
  scale?: number;
};

export type ERC20Metadata = TokenMetadata & TokenDecimals;
export type MinimalTokenMetadata = Omit<ERC20Metadata, 'totalSupply' | 'scale'>;

export const isTokenMetadata = (metadata: any): metadata is TokenMetadata =>
  metadata.name && metadata.symbol && metadata.totalSupply !== undefined; // totalSupply can be 0

export const isErc20Metadata = (metadata: any): metadata is ERC20Metadata =>
  metadata.decimals && isTokenMetadata(metadata);

export type SyntheticConfig = TokenMetadata & {
  type: TokenType.synthetic | TokenType.syntheticUri | TokenType.fastSynthetic;
};
export type CollateralConfig = {
  type:
    | TokenType.collateral
    | TokenType.collateralUri
    | TokenType.fastCollateral
    | TokenType.fastSynthetic
    | TokenType.collateralVault;
  token: string;
} & Partial<ERC20Metadata>;
export type NativeConfig = {
  type: TokenType.native;
} & Partial<TokenDecimals>;

export type TokenConfig = SyntheticConfig | CollateralConfig | NativeConfig;

export const isCollateralConfig = (
  config: TokenConfig,
): config is CollateralConfig =>
  config.type === TokenType.collateral ||
  config.type === TokenType.collateralUri ||
  config.type === TokenType.fastCollateral ||
  config.type == TokenType.collateralVault;

export const isCollateralVaultConfig = (
  config: TokenConfig,
): config is CollateralConfig => config.type === TokenType.collateralVault;

export const isSyntheticConfig = (
  config: TokenConfig,
): config is SyntheticConfig =>
  config.type === TokenType.synthetic ||
  config.type === TokenType.syntheticUri ||
  config.type === TokenType.fastSynthetic;

export const isNativeConfig = (config: TokenConfig): config is NativeConfig =>
  config.type === TokenType.native;

export const isUriConfig = (config: TokenConfig): boolean =>
  config.type === TokenType.syntheticUri ||
  config.type === TokenType.collateralUri;

export const isFastConfig = (config: TokenConfig): boolean =>
  config.type === TokenType.fastSynthetic ||
  config.type === TokenType.fastCollateral;

export type HypERC20Config = GasRouterConfig & SyntheticConfig & ERC20Metadata;
export type HypERC20CollateralConfig = GasRouterConfig &
  CollateralConfig &
  Partial<ERC20Metadata>;
export type HypNativeConfig = GasRouterConfig & NativeConfig;
export type ERC20RouterConfig =
  | HypERC20Config
  | HypERC20CollateralConfig
  | HypNativeConfig;

export type HypERC721Config = GasRouterConfig & SyntheticConfig;
export type HypERC721CollateralConfig = GasRouterConfig & CollateralConfig;
export type ERC721RouterConfig = HypERC721Config | HypERC721CollateralConfig;
