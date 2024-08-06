import { expect } from 'chai';

import {
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
