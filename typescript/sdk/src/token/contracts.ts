import {
  FastHypERC20Collateral__factory,
  FastHypERC20__factory,
  HypERC20CollateralVaultDeposit__factory,
  HypERC20Collateral__factory,
  HypERC20__factory,
  HypERC721Collateral__factory,
  HypERC721URICollateral__factory,
  HypERC721URIStorage__factory,
  HypERC721__factory,
  HypNativeScaled__factory,
  HypNative__factory,
} from '@hyperlane-xyz/core';

import { TokenType } from './config';

export const hypERC20contracts = {
  [TokenType.fastCollateral]: 'FastHypERC20Collateral',
  [TokenType.fastSynthetic]: 'FastHypERC20',
  [TokenType.synthetic]: 'HypERC20',
  [TokenType.collateral]: 'HypERC20Collateral',
  [TokenType.collateralVault]: 'HypERC20CollateralVaultDeposit',
  [TokenType.native]: 'HypNative',
  [TokenType.nativeScaled]: 'HypNativeScaled',
} as const;

export const hypERC20factories = {
  FastHypERC20Collateral: new FastHypERC20Collateral__factory(),
  FastHypERC20: new FastHypERC20__factory(),
  HypERC20: new HypERC20__factory(),
  HypERC20Collateral: new HypERC20Collateral__factory(),
  HypERC20CollateralVaultDeposit: new HypERC20CollateralVaultDeposit__factory(),
  HypNative: new HypNative__factory(),
  HypNativeScaled: new HypNativeScaled__factory(),
};
export type HypERC20Factories = typeof hypERC20factories;

export const hypERC721contracts = {
  [TokenType.collateralUri]: 'HypERC721URICollateral',
  [TokenType.collateral]: 'HypERC721Collateral',
  [TokenType.syntheticUri]: 'HypERC721URIStorage',
  [TokenType.synthetic]: 'HypERC721',
} as const;

export const hypERC721factories = {
  HypERC721URICollateral: new HypERC721URICollateral__factory(),
  HypERC721Collateral: new HypERC721Collateral__factory(),
  HypERC721URIStorage: new HypERC721URIStorage__factory(),
  HypERC721: new HypERC721__factory(),
};
export type HypERC721Factories = typeof hypERC721factories;

export type TokenFactories = HypERC20Factories | HypERC721Factories;
