import { Token, TokenStandard } from '@hyperlane-xyz/sdk';

const REBALANCEABLE_TOKEN_COLLATERALIZED_STANDARDS = [
  TokenStandard.EvmHypCollateral,
  TokenStandard.EvmHypNative,
];

export function isCollateralizedTokenEligibleForRebalancing(
  token: Token,
): boolean {
  return REBALANCEABLE_TOKEN_COLLATERALIZED_STANDARDS.includes(token.standard);
}
