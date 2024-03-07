import {
  HypERC20Collateral__factory,
  HypERC20__factory,
  HypERC721Collateral__factory,
  HypERC721__factory,
  HypNative__factory,
} from '@hyperlane-xyz/core';

import { TokenType } from './config';

export const hypERC20factories = {
  [TokenType.fastCollateral]: new HypERC20Collateral__factory(),
  [TokenType.fastSynthetic]: new HypERC20__factory(),
  [TokenType.synthetic]: new HypERC20__factory(),
  [TokenType.collateral]: new HypERC20Collateral__factory(),
  [TokenType.native]: new HypNative__factory(),
};
export type HypERC20Factories = typeof hypERC20factories;

export const hypERC721factories = {
  [TokenType.collateralUri]: new HypERC721Collateral__factory(),
  [TokenType.collateral]: new HypERC721Collateral__factory(),
  [TokenType.syntheticUri]: new HypERC721__factory(),
  [TokenType.synthetic]: new HypERC721__factory(),
};

export type HypERC721Factories = typeof hypERC721factories;

export type TokenFactories = HypERC20Factories | HypERC721Factories;
