import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import type { ExternalBridgeType } from '../config/types.js';

import {
  PROTOCOL_TO_HYP_NATIVE_STANDARD,
  type Token,
  TokenStandard,
} from '@hyperlane-xyz/sdk';

const REBALANCEABLE_TOKEN_COLLATERALIZED_STANDARDS = new Set<TokenStandard>([
  TokenStandard.EvmHypCollateral,
  TokenStandard.EvmHypNative,
  TokenStandard.SealevelHypCollateral,
  TokenStandard.SealevelHypNative,
]);

// SDK-backed native token standard check scoped to EVM and Sealevel only (2-protocol scope).
// NOTE: We intentionally do NOT use the full PROTOCOL_TO_HYP_NATIVE_STANDARD map (all 7 protocols)
// because the rebalancer only supports EVM and Sealevel native token bridging.
// Expanding this would change gas reservation behavior for other protocols.
const REBALANCER_NATIVE_STANDARDS = new Set([
  PROTOCOL_TO_HYP_NATIVE_STANDARD[ProtocolType.Ethereum],
  PROTOCOL_TO_HYP_NATIVE_STANDARD[ProtocolType.Sealevel],
]);

/**
 * Check if a token's balance is the same as native gas balance.
 * For these tokens, we must reserve funds for IGP when calculating max transferable.
 *
 * @param standard - The token standard to check.
 * @returns `true` if the token is a native token standard, `false` otherwise.
 */
export function isNativeTokenStandard(standard: TokenStandard): boolean {
  return REBALANCER_NATIVE_STANDARDS.has(standard);
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
 * - Native tokens (EvmHypNative, SealevelHypNative): Use the bridge's native token representation
 * - Collateral tokens (EvmHypCollateral, SealevelHypCollateral): Use `collateralAddressOrDenom` (the underlying token)
 * - Synthetic tokens: `collateralAddressOrDenom` is undefined, `addressOrDenom` IS the token
 *
 * @param token - The warp route token to resolve
 * @param externalBridgeType - The type of external bridge (e.g. 'lifi')
 * @param getNativeTokenAddress - Function to get the bridge's native token representation
 * @returns The correct token address for the external bridge
 */
export function getExternalBridgeTokenAddress(
  token: Token,
  externalBridgeType: ExternalBridgeType,
  getNativeTokenAddress: (type: ExternalBridgeType) => string,
): string {
  if (isNativeTokenStandard(token.standard)) {
    return getNativeTokenAddress(externalBridgeType);
  }

  if (token.collateralAddressOrDenom) return token.collateralAddressOrDenom;

  assert(
    !REBALANCEABLE_TOKEN_COLLATERALIZED_STANDARDS.has(token.standard),
    `Missing collateralAddressOrDenom for collateralized token on ${token.chainName} (${token.standard})`,
  );

  return token.addressOrDenom;
}
