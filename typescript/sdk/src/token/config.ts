export enum TokenType {
  synthetic = 'synthetic',
  syntheticRebase = 'syntheticRebase',
  fastSynthetic = 'fastSynthetic',
  syntheticUri = 'syntheticUri',
  collateral = 'collateral',
  collateralVault = 'collateralVault',
  collateralVaultRebase = 'collateralVaultRebase',
  XERC20 = 'xERC20',
  XERC20Lockbox = 'xERC20Lockbox',
  collateralFiat = 'collateralFiat',
  fastCollateral = 'fastCollateral',
  collateralUri = 'collateralUri',
  native = 'native',
  nativeScaled = 'nativeScaled',
}

export const gasOverhead = (tokenType: TokenType): number => {
  switch (tokenType) {
    case TokenType.fastSynthetic:
    case TokenType.synthetic:
      return 64_000;
    case TokenType.native:
      return 44_000;
    default:
      return 68_000;
  }
};
