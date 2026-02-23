import type { Logger } from 'pino';

import type { ExternalBridgeType } from '../config/types.js';

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

/**
 * Resolves the correct token address for external bridges (e.g. LiFi).
 *
 * For warp route tokens, `addressOrDenom` is the warp router contract address,
 * NOT the underlying token. External bridges need the actual token address:
 * - Native tokens (EvmHypNative): Use the bridge's native token representation
 * - Collateral tokens (EvmHypCollateral): Use `collateralAddressOrDenom` (the underlying ERC20)
 * - Synthetic tokens: `collateralAddressOrDenom` is undefined, `addressOrDenom` IS the token
 *
 * @param token - The warp route token to resolve
 * @param externalBridgeType - The type of external bridge (e.g. 'lifi')
 * @param getNativeTokenAddress - Function to get the bridge's native token representation
 * @param logger - Optional logger for warnings
 * @returns The correct token address for the external bridge
 */
export function getLiFiTokenAddress(
  token: Token,
  externalBridgeType: ExternalBridgeType,
  getNativeTokenAddress: (type: ExternalBridgeType) => string,
  logger?: Logger,
): string {
  if (isNativeTokenStandard(token.standard)) {
    return getNativeTokenAddress(externalBridgeType);
  }

  if (token.collateralAddressOrDenom) {
    return token.collateralAddressOrDenom;
  }

  if (REBALANCEABLE_TOKEN_COLLATERALIZED_STANDARDS.has(token.standard)) {
    logger?.warn(
      {
        chain: token.chainName,
        standard: token.standard,
        addressOrDenom: token.addressOrDenom,
      },
      'collateralAddressOrDenom is undefined for collateralized token, falling back to addressOrDenom',
    );
  }

  return token.addressOrDenom;
}
