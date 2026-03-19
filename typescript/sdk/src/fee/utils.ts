export const MAX_BPS = 10_000n; // 100% in bps

/**
 * Maximum decimal places supported for fractional bps values.
 * The precision scaling in convertToBps/convertFromBps uses 10^MAX_BPS_DECIMALS
 * as a multiplier. Values with more decimal places will be rejected to prevent
 * silent precision loss during bigint arithmetic.
 */
export const MAX_BPS_DECIMALS = 4;

/**
 * Validates that a bps value does not exceed MAX_BPS_DECIMALS decimal places.
 * @throws Error if bps has too many decimal places
 */
export function assertBpsPrecision(bps: number): void {
  const factor = 10 ** MAX_BPS_DECIMALS;
  if (Math.round(bps * factor) !== bps * factor) {
    throw new Error(
      `bps must have at most ${MAX_BPS_DECIMALS} decimal places, got ${bps}`,
    );
  }
}

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
 * @returns Fee in basis points (up to MAX_BPS_DECIMALS decimal places)
 * @throws Error if halfAmount is zero to prevent division by zero
 */
export function convertToBps(maxFee: bigint, halfAmount: bigint): number {
  if (halfAmount === 0n) {
    throw new Error('halfAmount must be > 0 to prevent division by zero');
  }

  // Use precision scaling to preserve fractional bps (e.g., 1.5)
  // Multiply by PRECISION before bigint division, then divide back in Number space
  const PRECISION = BigInt(10 ** MAX_BPS_DECIMALS);
  const scaledBps = (maxFee * MAX_BPS * PRECISION) / (halfAmount * 2n);
  // Round to MAX_BPS_DECIMALS decimal places to prevent floating point drift
  const factor = 10 ** MAX_BPS_DECIMALS;
  return Math.round((Number(scaledBps) / Number(PRECISION)) * factor) / factor;
}
