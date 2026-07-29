/**
 * Offchain quote pricing policy — shared by every protocol implementation.
 * The byte-level encoding differs per VM (EVM `encodePacked` vs SVM Borsh),
 * but the semantic params themselves are protocol-agnostic.
 *
 * The shipped defaults are "permissive placeholder": every quote produces
 * fee=0 on-chain, matching v1's framework behavior. Real custom pricing
 * (surge, per-route overrides, dynamic gas) is a deployment-level policy
 * that overrides these constants.
 */

/**
 * Linear-curve params that produce fee=0 for any amount. `halfAmount=1`
 * avoids the divide-by-zero edge in the on-chain Linear formula
 * `fee = min(maxFee, amount * maxFee / (2 * halfAmount))` — both EVM and SVM
 * use the same formula.
 */
export const PLACEHOLDER_WARP_FEE_PARAMS = {
  maxFee: 0n,
  halfAmount: 1n,
} as const;

/**
 * IGP pricing that produces fee=0 — `gasPrice=0` short-circuits the
 * on-chain IGP gas-fee math regardless of exchange rate or decimals.
 * `tokenDecimals` is SVM-only on the wire (EVM IGP `data` is just the two
 * u128s); the unused field is harmless on EVM consumers.
 */
export const PLACEHOLDER_IGP_PRICING = {
  tokenExchangeRate: 0n,
  gasPrice: 0n,
  tokenDecimals: 0,
} as const;
