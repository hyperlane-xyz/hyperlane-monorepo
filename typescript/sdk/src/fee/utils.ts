export {
  MAX_BPS,
  MAX_BPS_DECIMALS,
  BPS_PRECISION,
  isBpsPrecisionValid,
  assertBpsPrecision,
  computeBps as convertToBps,
} from '@hyperlane-xyz/provider-sdk/fee';

/**
 * Assumed maximum transfer amount for zero-supply tokens.
 * 10^36 is astronomically large (10^18 tokens with 18 decimals).
 * This ensures maxFee * amount won't overflow for any realistic transfer
 * in the LinearFee contract's _quoteTransfer calculation.
 */
export const ASSUMED_MAX_AMOUNT_FOR_ZERO_SUPPLY = 10n ** 36n;
