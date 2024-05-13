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
  HypFiatTokenCollateral__factory,
  HypNativeScaled__factory,
  HypNative__factory,
  HypXERC20Collateral__factory,
} from '@hyperlane-xyz/core';

import { proxiedFactories } from '../router/types.js';

import { TokenType } from './config.js';

export const hypERC20contracts = {
  [TokenType.fastCollateral]: 'FastHypERC20Collateral',
  [TokenType.fastSynthetic]: 'FastHypERC20',
  [TokenType.synthetic]: 'HypERC20',
  [TokenType.collateral]: 'HypERC20Collateral',
  [TokenType.collateralFiat]: 'HypFiatTokenCollateral',
  [TokenType.collateralXERC20]: 'HypXERC20Collateral',
  [TokenType.collateralVault]: 'HypERC20CollateralVaultDeposit',
  [TokenType.native]: 'HypNative',
  [TokenType.nativeScaled]: 'HypNativeScaled',
};
export type HypERC20contracts = typeof hypERC20contracts;

export const hypERC20Tokenfactories = {
  [TokenType.fastCollateral]: new FastHypERC20Collateral__factory(),
  [TokenType.fastSynthetic]: new FastHypERC20__factory(),
  [TokenType.synthetic]: new HypERC20__factory(),
  [TokenType.collateral]: new HypERC20Collateral__factory(),
  [TokenType.collateralVault]: new HypERC20CollateralVaultDeposit__factory(),
  [TokenType.collateralFiat]: new HypFiatTokenCollateral__factory(),
  [TokenType.collateralXERC20]: new HypXERC20Collateral__factory(),
  [TokenType.native]: new HypNative__factory(),
  [TokenType.nativeScaled]: new HypNativeScaled__factory(),
};

export const hypERC20factories = {
  ...hypERC20Tokenfactories,
  ...proxiedFactories,
};
export type HypERC20Factories = typeof hypERC20factories;

export const hypERC721contracts = {
  [TokenType.collateralUri]: 'HypERC721URICollateral',
  [TokenType.collateral]: 'HypERC721Collateral',
  [TokenType.syntheticUri]: 'HypERC721URIStorage',
  [TokenType.synthetic]: 'HypERC721',
};

export type HypERC721contracts = typeof hypERC721contracts;

export const hypERC721factories = {
  [TokenType.collateralUri]: new HypERC721URICollateral__factory(),
  [TokenType.collateral]: new HypERC721Collateral__factory(),
  [TokenType.syntheticUri]: new HypERC721URIStorage__factory(),
  [TokenType.synthetic]: new HypERC721__factory(),
  ...proxiedFactories,
};
export type HypERC721Factories = typeof hypERC721factories;

export type TokenFactories = HypERC20Factories | HypERC721Factories;
