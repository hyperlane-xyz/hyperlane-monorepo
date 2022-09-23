import { ethers } from 'ethers';

import { RouterConfig } from '@hyperlane-xyz/sdk';

export type Erc20TokenConfig = {
  name: string;
  symbol: string;
  totalSupply: ethers.BigNumberish;
};

export type HypERC20Config = RouterConfig & Erc20TokenConfig;

export type Erc721TokenConfig = {
  name: string;
  symbol: string;
  mintAmount: ethers.BigNumberish;
};

export type HypERC721Config = RouterConfig & Erc721TokenConfig;
