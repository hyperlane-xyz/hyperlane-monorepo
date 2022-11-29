import { ethers } from 'ethers';

import { RouterConfig } from '@hyperlane-xyz/sdk';

export type SyntheticConfig = {
  type: "SYNTHETIC";
  name: string;
  symbol: string;
  totalSupply: ethers.BigNumberish;
};
export type CollateralConfig = {
  type: "COLLATERAL";
  token: string;
}

export type TokenConfig = SyntheticConfig | CollateralConfig;

export const isCollateralConfig = (config: RouterConfig & TokenConfig): config is RouterConfig & CollateralConfig => {
  return config.type === "COLLATERAL";
}

export type HypERC20Config = RouterConfig & TokenConfig;
export type HypERC20CollateralConfig = RouterConfig & CollateralConfig;

export type HypERC721Config = RouterConfig & TokenConfig;
export type HypERC721CollateralConfig = RouterConfig & CollateralConfig;
