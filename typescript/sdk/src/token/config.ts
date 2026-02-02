export const TokenType = {
  synthetic: 'synthetic',
  syntheticRebase: 'syntheticRebase',
  syntheticUri: 'syntheticUri',
  syntheticTip20: 'syntheticTip20',
  collateral: 'collateral',
  collateralVault: 'collateralVault',
  collateralVaultRebase: 'collateralVaultRebase',
  XERC20: 'xERC20',
  XERC20Lockbox: 'xERC20Lockbox',
  collateralFiat: 'collateralFiat',
  collateralUri: 'collateralUri',
  collateralCctp: 'collateralCctp',
  collateralEverclear: 'collateralEverclear',
  collateralTip20: 'collateralTip20',
  native: 'native',
  nativeOpL2: 'nativeOpL2',
  nativeOpL1: 'nativeOpL1',
  ethEverclear: 'ethEverclear',
  // backwards compatible alias to native
  nativeScaled: 'nativeScaled',
} as const;

export type TokenType = (typeof TokenType)[keyof typeof TokenType];

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
  [TokenType.collateralTip20]: false,
  [TokenType.native]: true,
  [TokenType.nativeOpL1]: false,
  [TokenType.nativeOpL2]: false,
  [TokenType.nativeScaled]: true,
  [TokenType.synthetic]: false,
  [TokenType.syntheticRebase]: false,
  [TokenType.syntheticUri]: false,
  [TokenType.syntheticTip20]: false,
  [TokenType.ethEverclear]: false,
  [TokenType.collateralEverclear]: false,
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

export const gasOverhead = (tokenType: TokenType): number => {
  switch (tokenType) {
    case TokenType.synthetic:
      return 64_000;
    case TokenType.native:
    case TokenType.nativeScaled:
      return 44_000;
    default:
      return 68_000;
  }
};

export const NON_ZERO_SENDER_ADDRESS =
  '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba';
