import { type Token, TokenStandard } from '@hyperlane-xyz/sdk';

const REBALANCEABLE_TOKEN_COLLATERALIZED_STANDARDS = new Set<TokenStandard>([
  TokenStandard.EvmHypCollateral,
  TokenStandard.EvmHypNative,
]);

/**
 * Check if a token's balance is the same as native gas balance.
 * For these tokens, we must reserve funds for IGP when calculating max transferable.
 *
 * @param standard - The token standard to check.
 * @returns `true` if the token is a native token standard, `false` otherwise.
 */
export function isNativeTokenStandard(standard: TokenStandard): boolean {
  // EvmHypNative covers all native token types including scaled variants
  return standard === TokenStandard.EvmHypNative;
}

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
    REBALANCEABLE_TOKEN_COLLATERALIZED_STANDARDS.has(token.standard)
  );
}
