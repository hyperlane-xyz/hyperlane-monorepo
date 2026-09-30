import { TokenType as ProviderTokenType } from '@hyperlane-xyz/provider-sdk/warp';

export const TokenType = ProviderTokenType;

export type TokenType = (typeof TokenType)[keyof typeof TokenType];

export type DeployableTokenType = Exclude<TokenType, typeof TokenType.unknown>;

// A token is defined movable collateral if its solidity contract implementation
// is a subclass of MovableCollateralRouter
const isMovableCollateralTokenTypeMap = {
  [TokenType.XERC20]: false,
  [TokenType.XERC20Lockbox]: false,
  [TokenType.collateral]: true,
  [TokenType.collateralCctp]: false,
  [TokenType.collateralFiat]: false,
  [TokenType.collateralUri]: false,
  [TokenType.collateralVault]: false,
  [TokenType.collateralVaultRebase]: false,
  [TokenType.native]: true,
  [TokenType.nativeOpL1]: false,
  [TokenType.nativeOpL2]: false,
  [TokenType.nativeScaled]: true,
  [TokenType.synthetic]: false,
  [TokenType.syntheticRebase]: false,
  [TokenType.syntheticUri]: false,
  [TokenType.ethEverclear]: false,
  [TokenType.collateralEverclear]: false,
  [TokenType.collateralDepositAddress]: false,
  [TokenType.collateralOft]: false,
  // Bare ITokenBridge adapter, not a MovableCollateralRouter subclass
  [TokenType.atomicLocalRebalancing]: false,
  [TokenType.crossCollateral]: true, // CrossCollateralRouter extends HypERC20Collateral
  [TokenType.unknown]: false,
} as const;

export type MovableTokenType = {
  [K in keyof typeof isMovableCollateralTokenTypeMap]: (typeof isMovableCollateralTokenTypeMap)[K] extends true
    ? K
    : never;
}[keyof typeof isMovableCollateralTokenTypeMap];

export type EverclearTokenBridgeTokenType =
  | typeof TokenType.ethEverclear
  | typeof TokenType.collateralEverclear;

export function isMovableCollateralTokenType(type: TokenType): boolean {
  return !!isMovableCollateralTokenTypeMap[type];
}

const syntheticTokenTypes = new Set<TokenType>([
  TokenType.synthetic,
  TokenType.syntheticRebase,
  TokenType.syntheticUri,
]);

export function isSyntheticTokenType(type: TokenType): boolean {
  return syntheticTokenTypes.has(type);
}

export const MAX_GAS_OVERHEAD = 68_000;

export const gasOverhead = (tokenType: TokenType): number => {
  switch (tokenType) {
    case TokenType.synthetic:
      return 64_000;
    case TokenType.native:
    case TokenType.nativeScaled:
      return 44_000;
    default:
      return MAX_GAS_OVERHEAD;
  }
};

export const NON_ZERO_SENDER_ADDRESS =
  '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba';
