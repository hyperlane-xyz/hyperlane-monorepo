import { BigNumber } from 'bignumber.js';
import { expect } from 'chai';
import { FixedNumber } from 'ethers';

import {
  BigNumberMax,
  BigNumberMin,
  bigToFixed,
  fixedToBig,
  isBigNumberish,
  isZeroish,
  mulBigAndFixed,
} from './big-numbers.js';

describe('isBigNumberish', () => {
  const testCases = [
    { expect: false, context: 'invalid number', case: 'invalidNumber' },
    { expect: false, context: 'NaN', case: NaN },
    { expect: false, context: 'undefined', case: undefined },
    { expect: false, context: 'null', case: null },
    { expect: true, context: 'decimal', case: 123.123 },
    { expect: true, context: 'integer', case: 300_000 },
    { expect: true, context: 'hex 0', case: 0x00 },
    { expect: true, context: 'hex 0', case: 0x000 },
    {
      expect: true,
      context: 'address 0',
      case: 0x0000000000000000000000000000000000000000,
    },
  ];
  testCases.forEach((tc) => {
    it(`returns ${tc.expect} for ${tc.case}`, () => {
      expect(isBigNumberish(tc.case!)).to.equal(tc.expect);
    });
  });
});

describe('isZeroish', () => {
  const testCases = [
    { expect: false, context: 'invalid number', case: 'invalidNumber' },
    { expect: false, context: 'NaN', case: NaN },
    { expect: false, context: 'undefined', case: undefined },
    { expect: false, context: 'null', case: null },
    { expect: false, context: 'non 0 decimal', case: 123.123 },
    { expect: false, context: 'non 0 integer', case: 123 },
    { expect: true, context: 'hex 0', case: 0x00 },
    { expect: true, context: 'hex 0', case: 0x000 },
    {
      expect: true,
      context: 'address 0',
      case: 0x0000000000000000000000000000000000000000,
    },
  ];
  testCases.forEach((tc) => {
    it(`returns ${tc.expect} for ${tc.case}`, () => {
      expect(isZeroish(tc.case!)).to.equal(tc.expect);
    });
  });
});

describe('bigToFixed', () => {
  it('converts a BigNumber to a FixedNumber', () => {
    const big = BigNumber('7.5e-10');
    const fixed = bigToFixed(big);

    expect(fixed.toUnsafeFloat()).to.equal(7.5e-10);
  });
});

describe('fixedToBig', () => {
  it('converts a FixedNumber to a floored BigNumber', () => {
    const fixed = FixedNumber.from('12.34');
    const big = fixedToBig(fixed);

    expect(big.toNumber()).to.equal(12);
  });

  it('converts a FixedNumber to a ceilinged BigNumber', () => {
    const fixed = FixedNumber.from('12.34');
    const big = fixedToBig(fixed, true);

    expect(big.toNumber()).to.equal(13);
  });
});

describe('mulBigAndFixed', () => {
  it('gets the floored product of a BigNumber and FixedNumber', () => {
    const big = BigNumber('1000');
    const fixed = FixedNumber.from('1.2345');
    const product = mulBigAndFixed(big, fixed);

    expect(product).to.equal((1234).toString());
  });

  it('gets the ceilinged product of a BigNumber and FixedNumber', () => {
    const big = BigNumber('1000');
    const fixed = FixedNumber.from('1.2345');
    const product = mulBigAndFixed(big, fixed, true);

    expect(product).to.equal((1235).toString());
  });
});

describe('BigNumberMin', () => {
  it('gets the min between the two BigNumber', () => {
    const big = BigNumber('1000');
    const bigger = BigNumber('10000');
    expect(BigNumberMin(big, bigger)).to.equal(big.toString());
  });
});

describe('BigNumberMax', () => {
  it('gets the max between the two BigNumber', () => {
    const big = BigNumber('1000');
    const bigger = BigNumber('10000');
    expect(BigNumberMax(big, bigger)).to.equal(bigger.toString());
  });
});
