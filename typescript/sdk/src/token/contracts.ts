import {
  HypERC20Collateral__factory,
  HypERC20__factory,
  HypERC721Collateral__factory,
  HypERC721__factory,
  HypNative__factory,
} from '@hyperlane-xyz/core';

import { TokenStandard, TokenType, getTokenType } from './config';

export const hypERC20factories = {
  [getTokenType(TokenType.fastCollateral, TokenStandard.ERC20)]:
    new HypERC20Collateral__factory(),
  [getTokenType(TokenType.fastSynthetic, TokenStandard.ERC20)]:
    new HypERC20__factory(),
  [getTokenType(TokenType.synthetic, TokenStandard.ERC20)]:
    new HypERC20__factory(),
  [getTokenType(TokenType.collateral, TokenStandard.ERC20)]:
    new HypERC20Collateral__factory(),
  [getTokenType(TokenType.native, TokenStandard.ERC20)]:
    new HypNative__factory(),
};
export type HypERC20Factories = typeof hypERC20factories;

export const hypERC721factories = {
  [getTokenType(TokenType.collateralUri, TokenStandard.ERC721)]:
    new HypERC721Collateral__factory(),
  [getTokenType(TokenType.collateral, TokenStandard.ERC721)]:
    new HypERC721Collateral__factory(),
  [getTokenType(TokenType.syntheticUri, TokenStandard.ERC721)]:
    new HypERC721__factory(),
  [getTokenType(TokenType.synthetic, TokenStandard.ERC721)]:
    new HypERC721__factory(),
};

export type HypERC721Factories = typeof hypERC721factories;

export type TokenFactories = HypERC20Factories | HypERC721Factories;
