import { ethers } from 'ethers';

import { GasRouterConfig } from '@hyperlane-xyz/sdk';

export enum TokenType {
  synthetic = 'synthetic',
  syntheticUri = 'syntheticUri',
  collateral = 'collateral',
  collateralUri = 'collateralUri',
  native = 'native',
}

export type TokenMetadata = {
  name: string;
  symbol: string;
  totalSupply: ethers.BigNumberish;
};

export type ERC20Metadata = TokenMetadata & {
  decimals: number;
};

export const isTokenMetadata = (metadata: any): metadata is TokenMetadata =>
  metadata.name && metadata.symbol && metadata.totalSupply !== undefined; // totalSupply can be 0

export const isErc20Metadata = (metadata: any): metadata is ERC20Metadata =>
  metadata.decimals && isTokenMetadata(metadata);

export type SyntheticConfig = TokenMetadata & {
  type: TokenType.synthetic | TokenType.syntheticUri;
};
export type CollateralConfig = {
  type: TokenType.collateral | TokenType.collateralUri;
  token: string;
};
export type NativeConfig = {
  type: TokenType.native;
};

export type TokenConfig = SyntheticConfig | CollateralConfig | NativeConfig;

export const isCollateralConfig = (
  config: TokenConfig,
): config is CollateralConfig =>
  config.type === TokenType.collateral ||
  config.type === TokenType.collateralUri;

export const isSyntheticConfig = (
  config: TokenConfig,
): config is SyntheticConfig =>
  config.type === TokenType.synthetic || config.type === TokenType.syntheticUri;

export const isNativeConfig = (config: TokenConfig): config is NativeConfig =>
  config.type === TokenType.native;

export const isUriConfig = (config: TokenConfig) =>
  config.type === TokenType.syntheticUri ||
  config.type === TokenType.collateralUri;

export type HypERC20Config = GasRouterConfig & SyntheticConfig & ERC20Metadata;
export type HypERC20CollateralConfig = GasRouterConfig & CollateralConfig;
export type HypNativeConfig = GasRouterConfig & NativeConfig;
export type ERC20RouterConfig =
  | HypERC20Config
  | HypERC20CollateralConfig
  | HypNativeConfig;

export type HypERC721Config = GasRouterConfig & SyntheticConfig;
export type HypERC721CollateralConfig = GasRouterConfig & CollateralConfig;
export type ERC721RouterConfig = HypERC721Config | HypERC721CollateralConfig;
