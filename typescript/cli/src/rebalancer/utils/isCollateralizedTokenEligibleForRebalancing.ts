import { Token, TokenStandard } from '@hyperlane-xyz/sdk';

const REBALANCEABLE_TOKEN_COLLATERALIZED_STANDARDS = [
  TokenStandard.EvmHypCollateral,
  TokenStandard.EvmHypNative,
];

/**
 * @dev This function exists because the rebalancer currently only supports a subset of collateralized token standards
 *   (see `REBALANCEABLE_TOKEN_COLLATERALIZED_STANDARDS` vs. all possible `TOKEN_COLLATERALIZED_STANDARDS`).
 *
 * @deprecated This function is conditionally deprecated. It is intended for removal once the rebalancer
 *   achieves full support for all collateralized token standards.
 *   After this condition is met and this function is removed, please use `token.isCollateralized()` as the alternative.
 *
 * @param token - The token to be checked for rebalancing eligibility.
 * @returns `true` if the token is of a collateralized standard currently supported by the rebalancer, `false` otherwise.
 */
export function isCollateralizedTokenEligibleForRebalancing(
  token: Token,
): boolean {
  return (
    token.isCollateralized() &&
    REBALANCEABLE_TOKEN_COLLATERALIZED_STANDARDS.includes(token.standard)
  );
}
