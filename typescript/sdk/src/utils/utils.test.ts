import { expect } from 'chai';
import { BigNumber, FixedNumber } from 'ethers';

import { bigToFixed, fixedToBig, mulBigAndFixed } from './number';

describe('utils', () => {
  describe('bigToFixed', () => {
    it('converts a BigNumber to a FixedNumber', () => {
      const big = BigNumber.from('1234');
      const fixed = bigToFixed(big);

      expect(fixed.toUnsafeFloat()).to.equal(1234);
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
      const big = BigNumber.from('1000');
      const fixed = FixedNumber.from('1.2345');
      const product = mulBigAndFixed(big, fixed);

      expect(product.toNumber()).to.equal(1234);
    });

    it('gets the ceilinged product of a BigNumber and FixedNumber', () => {
      const big = BigNumber.from('1000');
      const fixed = FixedNumber.from('1.2345');
      const product = mulBigAndFixed(big, fixed, true);

      expect(product.toNumber()).to.equal(1235);
    });
  });
});
