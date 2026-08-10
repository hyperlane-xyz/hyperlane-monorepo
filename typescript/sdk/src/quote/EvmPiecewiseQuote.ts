import { utils as ethersUtils } from 'ethers';

import { type WarpQuoteScope } from '@hyperlane-xyz/provider-sdk/quote';
import { assert } from '@hyperlane-xyz/utils';

const UINT32_MAX = 0xff_ff_ff_ff;
const UINT128_MAX = (1n << 128n) - 1n;
const MAX_SUPPORTED_BANDS = 256;
const MAX_MARGINAL_BPS_X1E4 = 100_000_000;

/** Raw standing-curve units expected by OffchainQuotedPiecewiseLinearFee. */
export interface EvmPiecewiseStandingCurve {
  breakpoints: bigint[];
  marginalBpsX1e4: number[];
  staleAfterSeconds: number;
  staleMarginalSurchargeBpsX1e4: number[];
}

/** Raw stored standing-curve state returned by the EVM fee contract. */
export interface EvmPiecewiseStoredStandingCurve extends EvmPiecewiseStandingCurve {
  exists: boolean;
  issuedAt: number;
  expiry: number;
}

/** EVM-only request for a persistent piecewise warp-fee quote. */
export interface CreateEvmPiecewiseWarpQuoteRequest {
  scope: WarpQuoteScope;
  curve: EvmPiecewiseStandingCurve;
  issuedAt: number;
  expiry: number;
}

function assertUint32(value: number, label: string): void {
  assert(
    Number.isInteger(value) && value >= 0 && value <= UINT32_MAX,
    `${label} must be a uint32.`,
  );
}

/**
 * Validates the exact invariants enforced by the piecewise fee contract.
 * `maxBands` may be narrowed to the deployed contract's immutable limit.
 */
export function validateEvmPiecewiseStandingCurve(
  curve: EvmPiecewiseStandingCurve,
  maxBands: number = MAX_SUPPORTED_BANDS,
): void {
  assert(
    Number.isInteger(maxBands) &&
      maxBands > 0 &&
      maxBands <= MAX_SUPPORTED_BANDS,
    `maxBands must be between 1 and ${MAX_SUPPORTED_BANDS}.`,
  );

  const bandCount = curve.marginalBpsX1e4.length;
  assert(bandCount > 0, 'A piecewise curve must contain at least one band.');
  assert(
    bandCount <= maxBands,
    `Piecewise curve has ${bandCount} bands but maxBands is ${maxBands}.`,
  );
  assert(
    curve.breakpoints.length + 1 === bandCount,
    'marginalBpsX1e4 must contain exactly one more value than breakpoints.',
  );
  assert(
    curve.staleMarginalSurchargeBpsX1e4.length === bandCount,
    'staleMarginalSurchargeBpsX1e4 must contain one value per band.',
  );

  let previousBreakpoint = 0n;
  for (const breakpoint of curve.breakpoints) {
    assert(
      typeof breakpoint === 'bigint' &&
        breakpoint > previousBreakpoint &&
        breakpoint <= UINT128_MAX,
      'breakpoints must be strictly increasing positive uint128 values.',
    );
    previousBreakpoint = breakpoint;
  }

  let previousRate = 0;
  let previousSurcharge = 0;
  for (let i = 0; i < bandCount; i += 1) {
    const rate = curve.marginalBpsX1e4[i];
    const surcharge = curve.staleMarginalSurchargeBpsX1e4[i];
    assertUint32(rate, `marginalBpsX1e4[${i}]`);
    assert(
      rate <= MAX_MARGINAL_BPS_X1E4 && rate >= previousRate,
      'marginalBpsX1e4 must be nondecreasing and no greater than 10000 bps.',
    );
    assertUint32(surcharge, `staleMarginalSurchargeBpsX1e4[${i}]`);
    assert(
      surcharge >= previousSurcharge &&
        rate + surcharge <= MAX_MARGINAL_BPS_X1E4,
      'Stale surcharges must be nondecreasing and keep every stale rate at or below 10000 bps.',
    );
    previousRate = rate;
    previousSurcharge = surcharge;
  }

  assertUint32(curve.staleAfterSeconds, 'staleAfterSeconds');
  assert(
    curve.staleAfterSeconds > 0,
    'staleAfterSeconds must be greater than zero.',
  );
}

/** ABI-encodes the standing quote data consumed by the EVM piecewise fee. */
export function encodeEvmPiecewiseStandingQuoteData(
  curve: EvmPiecewiseStandingCurve,
): string {
  validateEvmPiecewiseStandingCurve(curve);
  return ethersUtils.defaultAbiCoder.encode(
    ['uint128[]', 'uint32[]', 'uint32', 'uint32[]'],
    [
      curve.breakpoints,
      curve.marginalBpsX1e4,
      curve.staleAfterSeconds,
      curve.staleMarginalSurchargeBpsX1e4,
    ],
  );
}
