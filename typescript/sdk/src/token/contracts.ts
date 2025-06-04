import {
  HypERC20CollateralMemo__factory,
  HypERC20Collateral__factory,
  HypERC20Memo__factory,
  HypERC20__factory,
  HypERC721Collateral__factory,
  HypERC721URICollateral__factory,
  HypERC721URIStorage__factory,
  HypERC721__factory,
  HypERC4626Collateral__factory,
  HypERC4626OwnerCollateral__factory,
  HypERC4626__factory,
  HypFiatToken__factory,
  HypNativeMemo__factory,
  HypNative__factory,
  HypXERC20Lockbox__factory,
  HypXERC20__factory,
} from '@hyperlane-xyz/core';

import { TokenType } from './config.js';

export const hypERC20contracts = {
  [TokenType.synthetic]: 'HypERC20',
  [TokenType.syntheticMemo]: 'HypERC20Memo',
  [TokenType.syntheticRebase]: 'HypERC4626',
  [TokenType.syntheticUri]: 'HypERC721',
  [TokenType.collateral]: 'HypERC20Collateral',
  [TokenType.collateralMemo]: 'HypERC20CollateralMemo',
  [TokenType.collateralFiat]: 'HypFiatToken',
  [TokenType.collateralUri]: 'HypERC721Collateral',
  [TokenType.XERC20]: 'HypXERC20',
  [TokenType.XERC20Lockbox]: 'HypXERC20Lockbox',
  [TokenType.collateralVault]: 'HypERC4626OwnerCollateral',
  [TokenType.collateralVaultRebase]: 'HypERC4626Collateral',
  [TokenType.native]: 'HypNative',
  [TokenType.nativeMemo]: 'HypNativeMemo',
  // uses same contract as native
  [TokenType.nativeScaled]: 'HypNative',
};
export type HypERC20contracts = typeof hypERC20contracts;

export const hypERC20factories = {
  [TokenType.synthetic]: new HypERC20__factory(),
  [TokenType.syntheticMemo]: new HypERC20Memo__factory(),
  [TokenType.collateral]: new HypERC20Collateral__factory(),
  [TokenType.collateralMemo]: new HypERC20CollateralMemo__factory(),
  [TokenType.collateralVault]: new HypERC4626OwnerCollateral__factory(),
  [TokenType.collateralVaultRebase]: new HypERC4626Collateral__factory(),
  [TokenType.syntheticRebase]: new HypERC4626__factory(),
  [TokenType.collateralFiat]: new HypFiatToken__factory(),
  [TokenType.XERC20]: new HypXERC20__factory(),
  [TokenType.XERC20Lockbox]: new HypXERC20Lockbox__factory(),
  [TokenType.native]: new HypNative__factory(),
  [TokenType.nativeMemo]: new HypNativeMemo__factory(),
  [TokenType.nativeScaled]: new HypNative__factory(),
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
};
export type HypERC721Factories = typeof hypERC721factories;

export type TokenFactories = HypERC20Factories | HypERC721Factories;
