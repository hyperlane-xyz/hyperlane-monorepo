import { expect } from 'chai';

import {
  convertToScaledAmount,
  eqAmountApproximate,
  fromWei,
  fromWeiRounded,
  toWei,
} from './amount.js';

describe('fromWei', () => {
  it('parses and converts correctly', () => {
    expect(fromWei(1, 0)).to.equal('1');
    expect(fromWei('1000000', 6)).to.equal('1');
    expect(fromWei('1000000000000000000')).to.equal('1');
    expect(fromWei('1000000000000000000.1234')).to.equal('1');
  });
});

describe('fromWeiRounded', () => {
  it('parses and converts correctly', () => {
    expect(fromWeiRounded(1, 0)).to.equal('1.0000');
    expect(fromWeiRounded('1000000', 6)).to.equal('1.0000');
    expect(fromWeiRounded('1000000000000000000')).to.equal('1.0000');
    expect(fromWeiRounded('1000000000000000000.1234')).to.equal('1.0000');
  });

  it('rounds correctly', () => {
    expect(fromWeiRounded(1234567890, 6, 2)).to.equal('1234.56');
    expect(fromWeiRounded('1234567890', 6, 4)).to.equal('1234.5678');
    expect(fromWeiRounded('10000000000000000000')).to.equal('10.0000');
    expect(fromWeiRounded('10000000000000000000', 18, 0)).to.equal('10');
  });

  it('can drop decimals for large numbers', () => {
    expect(fromWeiRounded('10001000000000000000000')).to.equal('10001.00');
    expect(fromWeiRounded('10001000000000000000', 15, 4)).to.equal(
      '10001.0000',
    );
  });
});

describe('toWei', () => {
  it('parses and converts correctly', () => {
    expect(toWei(1, 0)).to.equal('1');
    expect(toWei('1', 6)).to.equal('1000000');
    expect(toWei('123.456')).to.equal('123456000000000000000');
    expect(toWei('1.00000000000000000001')).to.equal('1000000000000000000');
    expect(toWei('1.00000000000000000001', 6)).to.equal('1000000');
  });
});

describe('eqAmountApproximate', () => {
  it('compares correctly', () => {
    expect(eqAmountApproximate(1, 1.001, 0.001)).to.be.true;
    expect(eqAmountApproximate(9, 9.001, 0.01)).to.be.true;
    expect(eqAmountApproximate('9876543210', '9876543210', '1')).to.be.true;
    expect(eqAmountApproximate('9876543210', '9876543212', '1')).to.be.false;
  });
});

describe('convertToScaledAmount', () => {
  it('returns the original amount when scales are equal or undefined', () => {
    const amount = 1000n;
    const precisionFactor = 100;
    const expectedAmount = amount * BigInt(Math.floor(precisionFactor));

    expect(
      convertToScaledAmount({ toScale: 6, amount, precisionFactor: 100 }),
    ).to.equal(expectedAmount);
    expect(
      convertToScaledAmount({ fromScale: 6, amount, precisionFactor: 100 }),
    ).to.equal(expectedAmount);
    expect(
      convertToScaledAmount({
        fromScale: 6,
        toScale: 6,
        amount,
        precisionFactor: 100,
      }),
    ).to.equal(expectedAmount);
  });

  it('scales properly when fromScale is higher than toScale', () => {
    expect(
      convertToScaledAmount({
        fromScale: 10,
        toScale: 1,
        amount: 10n,
        precisionFactor: 100_000,
      }),
    ).to.equal(10_000_000n);
    expect(
      convertToScaledAmount({
        fromScale: 8,
        toScale: 2,
        amount: 99n,
        precisionFactor: 100_000,
      }),
    ).to.equal(39_600_000n);
    expect(
      convertToScaledAmount({
        fromScale: 7,
        toScale: 2,
        amount: 1n,
        precisionFactor: 100_000,
      }),
    ).to.equal(350_000n);
    expect(
      convertToScaledAmount({
        fromScale: 5,
        toScale: 3,
        amount: 10n,
        precisionFactor: 1_000,
      }),
    ).to.equal(16_660n);
  });

  it('scales properly when fromScale is lower than toScale', () => {
    expect(
      convertToScaledAmount({
        fromScale: 1,
        toScale: 10,
        amount: 10n,
        precisionFactor: 100_000,
      }),
    ).to.equal(100_000n);
    expect(
      convertToScaledAmount({
        fromScale: 2,
        toScale: 8,
        amount: 99n,
        precisionFactor: 100_000,
      }),
    ).to.equal(2_475_000n);
    expect(
      convertToScaledAmount({
        fromScale: 2,
        toScale: 7,
        amount: 1n,
        precisionFactor: 100_000,
      }),
    ).to.equal(28_571n);
    expect(
      convertToScaledAmount({
        fromScale: 3,
        toScale: 5,
        amount: 10n,
        precisionFactor: 1_000,
      }),
    ).to.equal(6_000n);
  });
});
