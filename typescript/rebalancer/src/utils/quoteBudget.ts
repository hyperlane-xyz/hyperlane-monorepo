import { assert } from '@hyperlane-xyz/utils';

/** Smallest destination amount satisfying the fixed input's quote-loss budget. */
export function minimumOutputForLoss(
  input: bigint,
  sourceDecimals: number,
  destinationDecimals: number,
  lossBps: number,
): bigint {
  assert(input > 0n, 'Quote input must be positive');
  assert(
    [sourceDecimals, destinationDecimals].every(
      (decimals) =>
        Number.isInteger(decimals) && decimals >= 0 && decimals <= 255,
    ),
    'Quote decimals must be integers between 0 and 255',
  );
  assert(
    Number.isInteger(lossBps) && lossBps >= 0 && lossBps <= 10_000,
    'Quote loss must be an integer between 0 and 10000 bps',
  );
  const numerator =
    input * 10n ** BigInt(destinationDecimals) * (10_000n - BigInt(lossBps));
  const denominator = 10n ** BigInt(sourceDecimals) * 10_000n;
  return (numerator + denominator - 1n) / denominator;
}
