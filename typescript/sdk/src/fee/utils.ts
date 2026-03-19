export const MAX_BPS = 10_000n; // 100% in bps

/**
 * Assumed maximum transfer amount for zero-supply tokens.
 * 10^36 is astronomically large (10^18 tokens with 18 decimals).
 * This ensures maxFee * amount won't overflow for any realistic transfer
 * in the LinearFee contract's _quoteTransfer calculation.
 */
export const ASSUMED_MAX_AMOUNT_FOR_ZERO_SUPPLY = 10n ** 36n;

/**
 * Converts fee parameters to basis points (BPS)
 * @param maxFee - Maximum fee amount
 * @param halfAmount - Half of the amount at which maxFee is applied
 * @returns Fee in basis points
 * @throws Error if halfAmount is zero to prevent division by zero
 */
export function convertToBps(maxFee: bigint, halfAmount: bigint): number {
  if (halfAmount === 0n) {
    throw new Error('halfAmount must be > 0 to prevent division by zero');
  }

  // Use precision scaling to preserve fractional bps (e.g., 1.5)
  // Multiply by PRECISION before bigint division, then divide back in Number space
  const PRECISION = 10_000n;
  const scaledBps = (maxFee * MAX_BPS * PRECISION) / (halfAmount * 2n);
  // Round to 4 decimal places to prevent floating point drift in equality checks
  return Math.round((Number(scaledBps) / Number(PRECISION)) * 10000) / 10000;
}
