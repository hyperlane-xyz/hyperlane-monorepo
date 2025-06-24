import {
  HypERC20Collateral__factory,
  HypERC20__factory,
  HypERC721Collateral__factory,
  HypERC721URICollateral__factory,
  HypERC721URIStorage__factory,
  HypERC721__factory,
  HypERC4626Collateral__factory,
  HypERC4626OwnerCollateral__factory,
  HypERC4626__factory,
  HypFiatToken__factory,
  HypNative__factory,
  HypXERC20Lockbox__factory,
  HypXERC20__factory,
  LinearFee__factory,
  OpL1V1NativeTokenBridge__factory,
  OpL2NativeTokenBridge__factory,
  ProgressiveFee__factory,
  RegressiveFee__factory,
  TokenBridgeCctp__factory,
} from '@hyperlane-xyz/core';

import { TokenType } from './config.js';
import { FeeCurve } from './types.js';

export const hypERC20contracts = {
  [TokenType.synthetic]: 'HypERC20',
  [TokenType.syntheticRebase]: 'HypERC4626',
  [TokenType.syntheticUri]: 'HypERC721',
  [TokenType.collateral]: 'HypERC20Collateral',
  [TokenType.collateralFiat]: 'HypFiatToken',
  [TokenType.collateralUri]: 'HypERC721Collateral',
  [TokenType.XERC20]: 'HypXERC20',
  [TokenType.XERC20Lockbox]: 'HypXERC20Lockbox',
  [TokenType.collateralVault]: 'HypERC4626OwnerCollateral',
  [TokenType.collateralVaultRebase]: 'HypERC4626Collateral',
  [TokenType.collateralCctp]: 'TokenBridgeCctp',
  [TokenType.native]: 'HypNative',
  [TokenType.nativeOpL2]: 'OPL2TokenBridgeNative',
  [TokenType.nativeOpL1]: 'OpL1TokenBridgeNative',
  // uses same contract as native
  [TokenType.nativeScaled]: 'HypNative',
} as const;
export type HypERC20contracts = typeof hypERC20contracts;

export const hypERC20factories = {
  [TokenType.synthetic]: new HypERC20__factory(),
  [TokenType.collateral]: new HypERC20Collateral__factory(),
  [TokenType.collateralCctp]: new TokenBridgeCctp__factory(),
  [TokenType.collateralVault]: new HypERC4626OwnerCollateral__factory(),
  [TokenType.collateralVaultRebase]: new HypERC4626Collateral__factory(),
  [TokenType.syntheticRebase]: new HypERC4626__factory(),
  [TokenType.collateralFiat]: new HypFiatToken__factory(),
  [TokenType.XERC20]: new HypXERC20__factory(),
  [TokenType.XERC20Lockbox]: new HypXERC20Lockbox__factory(),
  [TokenType.native]: new HypNative__factory(),
  [TokenType.nativeOpL2]: new OpL2NativeTokenBridge__factory(),
  // assume V1 for now
  [TokenType.nativeOpL1]: new OpL1V1NativeTokenBridge__factory(),
  [TokenType.nativeScaled]: new HypNative__factory(),
} as const;
export type HypERC20Factories = typeof hypERC20factories;

export const feeFactories = {
  [FeeCurve.LINEAR]: new LinearFee__factory(),
  [FeeCurve.REGRESSIVE]: new RegressiveFee__factory(),
  [FeeCurve.PROGRESSIVE]: new ProgressiveFee__factory(),
} as const;
export type FeeFactories = typeof feeFactories;

export const hypERC721contracts = {
  [TokenType.collateralUri]: 'HypERC721URICollateral',
  [TokenType.collateral]: 'HypERC721Collateral',
  [TokenType.syntheticUri]: 'HypERC721URIStorage',
  [TokenType.synthetic]: 'HypERC721',
} as const;

export type HypERC721contracts = typeof hypERC721contracts;

export const hypERC721factories = {
  [TokenType.collateralUri]: new HypERC721URICollateral__factory(),
  [TokenType.collateral]: new HypERC721Collateral__factory(),
  [TokenType.syntheticUri]: new HypERC721URIStorage__factory(),
  [TokenType.synthetic]: new HypERC721__factory(),
} as const;
export type HypERC721Factories = typeof hypERC721factories;

export type TokenFactories = HypERC20Factories | HypERC721Factories;
