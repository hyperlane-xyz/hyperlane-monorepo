export enum TokenType {
  synthetic = 'synthetic',
  syntheticRebase = 'syntheticRebase',
  syntheticUri = 'syntheticUri',
  collateral = 'collateral',
  collateralVault = 'collateralVault',
  collateralVaultRebase = 'collateralVaultRebase',
  XERC20 = 'xERC20',
  XERC20Lockbox = 'xERC20Lockbox',
  collateralFiat = 'collateralFiat',
  collateralUri = 'collateralUri',
  collateralCctp = 'collateralCctp',
  native = 'native',
  nativeOpL2 = 'nativeOpL2',
  nativeOpL1 = 'nativeOpL1',
  // backwards compatible alias to native
  nativeScaled = 'nativeScaled',
}

export const gasOverhead = (tokenType: TokenType): number => {
  switch (tokenType) {
    case TokenType.synthetic:
      return 64_000;
    case TokenType.native:
      return 44_000;
    default:
      return 68_000;
  }
};

export const NON_ZERO_SENDER_ADDRESS =
  '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
