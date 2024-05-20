import { z } from 'zod';

import {
  CollateralConfigSchema,
  NativeConfigSchema,
  SyntheticConfigSchema,
  TokenMetadataSchema,
  TokenRouterConfigSchema,
} from './schemas.js';

export enum TokenType {
  synthetic = 'synthetic',
  fastSynthetic = 'fastSynthetic',
  syntheticUri = 'syntheticUri',
  collateral = 'collateral',
  collateralVault = 'collateralVault',
  collateralXERC20 = 'collateralXERC20',
  collateralFiat = 'collateralFiat',
  fastCollateral = 'fastCollateral',
  collateralUri = 'collateralUri',
  native = 'native',
  nativeScaled = 'nativeScaled',
}

export const gasOverhead = (tokenType: TokenType) => {
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

export type TokenRouterConfig = z.infer<typeof TokenRouterConfigSchema>;
export type NativeConfig = z.infer<typeof NativeConfigSchema>;
export type CollateralConfig = z.infer<typeof CollateralConfigSchema>;

function isCompliant<S extends Zod.Schema>(schema: S) {
  return (config: unknown): config is z.infer<S> =>
    schema.safeParse(config).success;
}

export const isSyntheticConfig = isCompliant(SyntheticConfigSchema);
export const isCollateralConfig = isCompliant(CollateralConfigSchema);
export const isNativeConfig = isCompliant(NativeConfigSchema);
export const isTokenMetadata = isCompliant(TokenMetadataSchema);
