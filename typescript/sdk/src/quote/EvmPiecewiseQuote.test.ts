import { expect } from 'chai';
import { utils as ethersUtils } from 'ethers';

import {
  type EvmPiecewiseStandingCurve,
  encodeEvmPiecewiseStandingQuoteData,
  validateEvmPiecewiseStandingCurve,
} from './EvmPiecewiseQuote.js';

const VALID_CURVE: EvmPiecewiseStandingCurve = {
  breakpoints: [250_000n, 750_000n],
  marginalBpsX1e4: [40_000, 100_000, 200_000],
  staleAfterSeconds: 60,
  staleMarginalSurchargeBpsX1e4: [10_000, 20_000, 30_000],
};

describe('EvmPiecewiseQuote', () => {
  it('ABI-encodes the exact standing-curve contract layout', () => {
    const encoded = encodeEvmPiecewiseStandingQuoteData(VALID_CURVE);
    const [breakpoints, marginalRates, staleAfter, surcharges] =
      ethersUtils.defaultAbiCoder.decode(
        ['uint128[]', 'uint32[]', 'uint32', 'uint32[]'],
        encoded,
      );

    expect(
      breakpoints.map((value: { toString(): string }) => value.toString()),
    ).to.deep.equal(['250000', '750000']);
    expect(marginalRates).to.deep.equal([40_000, 100_000, 200_000]);
    expect(staleAfter).to.equal(60);
    expect(surcharges).to.deep.equal([10_000, 20_000, 30_000]);
  });

  it('accepts a curve bounded by a deployed maxBands value', () => {
    expect(() => validateEvmPiecewiseStandingCurve(VALID_CURVE, 3)).to.not
      .throw;
  });

  for (const test of [
    {
      name: 'empty bands',
      curve: {
        ...VALID_CURVE,
        breakpoints: [],
        marginalBpsX1e4: [],
        staleMarginalSurchargeBpsX1e4: [],
      },
      error: /at least one band/,
    },
    {
      name: 'too many bands for the deployed contract',
      curve: VALID_CURVE,
      maxBands: 2,
      error: /3 bands but maxBands is 2/,
    },
    {
      name: 'mismatched breakpoints',
      curve: { ...VALID_CURVE, breakpoints: [250_000n] },
      error: /one more value than breakpoints/,
    },
    {
      name: 'non-increasing breakpoints',
      curve: { ...VALID_CURVE, breakpoints: [250_000n, 250_000n] },
      error: /strictly increasing/,
    },
    {
      name: 'non-increasing marginal rates',
      curve: { ...VALID_CURVE, marginalBpsX1e4: [40_000, 30_000, 200_000] },
      error: /marginalBpsX1e4 must be nondecreasing/,
    },
    {
      name: 'mismatched stale surcharges',
      curve: { ...VALID_CURVE, staleMarginalSurchargeBpsX1e4: [10_000] },
      error: /one value per band/,
    },
    {
      name: 'non-increasing stale surcharges',
      curve: {
        ...VALID_CURVE,
        staleMarginalSurchargeBpsX1e4: [10_000, 5_000, 30_000],
      },
      error: /Stale surcharges must be nondecreasing/,
    },
    {
      name: 'stale rate above the contract maximum',
      curve: {
        ...VALID_CURVE,
        marginalBpsX1e4: [99_990_000, 99_990_000, 99_990_000],
        staleMarginalSurchargeBpsX1e4: [20_000, 20_000, 20_000],
      },
      error: /keep every stale rate at or below/,
    },
    {
      name: 'zero stale threshold',
      curve: { ...VALID_CURVE, staleAfterSeconds: 0 },
      error: /greater than zero/,
    },
  ]) {
    it(`rejects ${test.name}`, () => {
      expect(() =>
        validateEvmPiecewiseStandingCurve(test.curve, test.maxBands),
      ).to.throw(test.error);
    });
  }
});
